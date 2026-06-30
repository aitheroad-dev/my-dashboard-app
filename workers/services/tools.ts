import type { AppEnv } from "../lib/env";
import { synthesizeHebrew } from "./edge-tts";
import { ToolError } from "./tool-error";
export { ToolError } from "./tool-error";

/**
 * Native tools service (ISC-54.x rebuild, 2026-06-29).
 *
 * The tools run INSIDE this fork's own Worker — image / speech-to-text / OCR on
 * the fork's `env.AI` (Workers AI) binding, text-to-speech via keyless Deepgram
 * Aura-1 for English and keyless Microsoft Edge neural TTS for Hebrew. OpenAI's
 * speech branch remains in place for future use, but Hebrew never routes there. No
 * pai-tools, no pt_ key, no worker→worker subrequest (kills CF error 1042). The
 * gate is the dashboard's own CF Access — the caller is already signed in. Each
 * fork bills its OWN account; generated media lives in this fork's own KV
 * (physically isolated, L2). Response shapes mirror the old proxy so the panels
 * are unchanged.
 *
 * Model gotchas (ported from the proven pai-tools build — never trust the catalog):
 *  - flux-1-schnell / lucid-origin return JPEG bytes (base64), not PNG.
 *  - whisper-large-v3-turbo takes audio as a base64 STRING + optional language hint.
 *  - Mistral Small 3.1 vision takes an image data URL in messages content and
 *    returns OCR text in `response`.
 *  - gpt-4o-mini-tts is OpenAI (not Workers AI) — dormant unless a future UI
 *    explicitly asks for one of its voices.
 */

const IMG_INDEX = "tools:gallery:img";
const VOICE_INDEX = "tools:gallery:voice";
const TEXT_INDEX = "tools:gallery:text"; // saved speak→text transcripts
const IMG_PREFIX = "tools:img:";
const AUDIO_PREFIX = "tools:audio:";
const VOICE_TTL = 60 * 60 * 24 * 14; // saved voice clips auto-expire after 14 days
const GALLERY_CAP = 100;
const MAX_TTS_CHARS = 4000;
const MAX_TRANSCRIPT_STORE = 8000; // cap the transcript text kept in the gallery index
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // whisper/ocr input ceiling

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"];
// Deepgram Aura-1 (Workers AI, English) — the no-key engine. 12 confirmed speakers.
const AURA1_VOICES = ["asteria", "luna", "stella", "athena", "hera", "orion", "arcas", "perseus", "angus", "orpheus", "helios", "zeus"];
const HEBREW_EDGE_VOICES = ["he-IL-AvriNeural", "he-IL-HilaNeural"];

// ids are crypto.randomUUID() v4 — match exactly (no path/KV-key chars possible).
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isMediaId(id: string): boolean {
  return ID_RE.test(id);
}

const AI_TIMEOUT_MS = 60_000;

/** Run a Workers-AI model with a hard timeout — a stalled model otherwise hangs
 * the request until the platform kills it. Times out → ToolError(504). `options`
 * is the binding's 3rd arg (e.g. `{returnRawResponse:true}` for Aura audio). */
async function runAI(env: AppEnv, model: string, input: unknown, options?: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(504, "The model took too long to respond.")), AI_TIMEOUT_MS);
  });
  try {
    return await Promise.race([env.AI.run(model as never, input as never, options as never), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function approxBytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}
function sniffImageMime(b64: string): string {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

async function pushIndex(
  env: AppEnv,
  indexKey: string,
  entry: Record<string, unknown>,
  opts?: { ttl?: number; blobPrefix?: string },
): Promise<void> {
  let list: Array<Record<string, unknown>> = [];
  const raw = await env.KV.get(indexKey);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    } catch {
      list = [];
    }
  }
  list.unshift(entry);
  if (list.length > GALLERY_CAP) {
    const evicted = list.slice(GALLERY_CAP);
    list = list.slice(0, GALLERY_CAP);
    // Delete the evicted entries' blobs so capping the index can't orphan KV
    // objects (images carry no TTL). Best-effort — index write is the priority.
    if (opts?.blobPrefix) {
      await Promise.allSettled(
        evicted
          .map((e) => (typeof e.id === "string" ? e.id : ""))
          .filter((id) => id && isMediaId(id))
          .map((id) => env.KV.delete(`${opts.blobPrefix}${id}`)),
      );
    }
  }
  await env.KV.put(indexKey, JSON.stringify(list), opts?.ttl ? { expirationTtl: opts.ttl } : undefined);
}

// ---- Capability report (no external probe — purely local) ----

export function toolsStatus(canUse: boolean) {
  return {
    // `ready` reflects whether THIS viewer can actually run the tools (every tool
    // route is owner-gated). An open-dev / non-owner viewer gets ready:false so the
    // page shows an honest "sign in" state instead of a green banner over 403s.
    ready: canUse,
    tts_languages: [
      {
        code: "en",
        label: "English",
        engine: "deepgram:aura-1",
        voices: AURA1_VOICES.map((id) => ({ id, label: capitalize(id) })),
      },
      {
        code: "he",
        label: "עברית",
        engine: "microsoft-edge",
        voices: [
          { id: "he-IL-AvriNeural", label: "Avri (male)" },
          { id: "he-IL-HilaNeural", label: "Hila (female)" },
        ],
      },
    ],
    tools: [
      { name: "image", description: "Generate an image from a text prompt." },
      { name: "speak-to-text", description: "Transcribe speech (multilingual)." },
      { name: "text-to-speech", description: "Read English via Deepgram Aura and Hebrew via Microsoft Edge, no key needed." },
      { name: "read-text", description: "Extract text from a photo or screenshot." },
    ],
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---- Image (flux) ----

export async function generateImage(
  env: AppEnv,
  input: { prompt?: unknown; quality?: unknown },
): Promise<Record<string, unknown>> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new ToolError(400, "A prompt is required.");
  const quality = input.quality === "fast" ? "fast" : "high";
  const model = quality === "fast" ? "@cf/black-forest-labs/flux-1-schnell" : "@cf/leonardo/lucid-origin";
  const aiInput = quality === "fast" ? { prompt, steps: 4 } : { prompt };

  const result = (await runAI(env, model, aiInput)) as { image?: string };
  if (!result?.image) throw new ToolError(502, "No image was returned by the model.");

  const id = crypto.randomUUID();
  await env.KV.put(`${IMG_PREFIX}${id}`, decodeB64(result.image), {
    metadata: { contentType: "image/jpeg" },
  });
  await pushIndex(env, IMG_INDEX, { id, prompt, quality, ts: Date.now() }, { blobPrefix: IMG_PREFIX });

  return {
    image_url: `/api/tools/media/img/${id}`,
    image_base64: result.image,
    prompt,
    quality,
  };
}

// ---- Speak → Text (whisper) ----

export async function transcribe(
  env: AppEnv,
  input: { audio_base64?: unknown; language?: unknown },
): Promise<Record<string, unknown>> {
  const b64 = typeof input.audio_base64 === "string" ? input.audio_base64 : "";
  if (!b64) throw new ToolError(400, "Audio is required.");
  if (approxBytes(b64) > MAX_MEDIA_BYTES) throw new ToolError(400, "Audio exceeds the 25 MB limit.");

  const aiInput: Record<string, unknown> = { audio: b64 };
  const language = typeof input.language === "string" && input.language ? input.language : "";
  if (language) aiInput.language = language;

  const result = (await runAI(env, "@cf/openai/whisper-large-v3-turbo", aiInput)) as {
    text?: string;
    word_count?: number;
    transcription_info?: { language?: string };
  };
  if (typeof result?.text !== "string") throw new ToolError(502, "No transcription was returned.");
  const text = result.text.trim();
  const detectedLang = result.transcription_info?.language ?? "";

  // Auto-save the transcript to this fork's own gallery (text kept inline in the
  // index — no separate blob — so it's directly copyable later). Skip empties.
  if (text) {
    await pushIndex(env, TEXT_INDEX, {
      id: crypto.randomUUID(),
      text: text.slice(0, MAX_TRANSCRIPT_STORE),
      language: detectedLang,
      ts: Date.now(),
    });
  }

  return { text, word_count: result.word_count, language: detectedLang };
}

// ---- Read Text (OCR) ----

export async function ocr(
  env: AppEnv,
  input: { image_base64?: unknown; prompt?: unknown },
): Promise<Record<string, unknown>> {
  const b64 = typeof input.image_base64 === "string" ? input.image_base64 : "";
  if (!b64) throw new ToolError(400, "An image is required.");
  if (approxBytes(b64) > MAX_MEDIA_BYTES) throw new ToolError(400, "Image exceeds the 25 MB limit.");
  const prompt =
    typeof input.prompt === "string" && input.prompt
      ? input.prompt
      : "Extract all text from this image, preserving structure and line breaks. Output only the text you see.";

  const mime = sniffImageMime(b64);
  // Mistral Small 3.1 is the chosen vision model: EU-safe, with verified-live OCR fidelity.
  const result = (await runAI(env, "@cf/mistralai/mistral-small-3.1-24b-instruct", {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    max_tokens: 1024,
  })) as { response?: string };

  const text = result?.response;
  if (typeof text !== "string") throw new ToolError(502, "No text could be extracted.");
  return { text: text.trim() };
}

// ---- Text → Speech (Hebrew Edge, else Deepgram Aura/OpenAI) ----

export async function synthesize(
  env: AppEnv,
  openaiKey: string | null,
  input: { text?: unknown; voice?: unknown },
): Promise<Record<string, unknown>> {
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) throw new ToolError(400, "Text is required.");
  if (text.length > MAX_TTS_CHARS) throw new ToolError(400, `Text exceeds the ${MAX_TTS_CHARS}-character limit.`);

  const key = openaiKey || env.OPENAI_API_KEY || "";
  let bytes: Uint8Array;
  let contentType: string;
  let engine: string;

  if (typeof input.voice === "string" && HEBREW_EDGE_VOICES.includes(input.voice)) {
    const voice = input.voice;
    bytes = await synthesizeHebrew(text, voice);
    contentType = "audio/mpeg";
    engine = `microsoft-edge:${voice}`;
  } else {
    const reqVoice = typeof input.voice === "string" ? input.voice.toLowerCase() : "";
    if (key && OPENAI_VOICES.includes(reqVoice)) {
      const voice = reqVoice;
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", input: text, voice, response_format: "mp3" }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) {
        // Don't pass the upstream provider's error body to the client (info hygiene);
        // the status code is enough for the user, the rest is for server logs.
        throw new ToolError(502, `Text-to-speech failed (HTTP ${r.status}). Please try again.`);
      }
      bytes = new Uint8Array(await r.arrayBuffer());
      contentType = "audio/mpeg";
      engine = "openai:gpt-4o-mini-tts";
    } else {
      // Deepgram Aura-1 on Workers AI (English, 12 voices, mp3).
      const speaker = AURA1_VOICES.includes(reqVoice) ? reqVoice : AURA1_VOICES[0];
      // Aura streams audio bytes; `returnRawResponse` yields a Response/stream we read.
      const aiResp = await runAI(
        env,
        "@cf/deepgram/aura-1",
        { text, speaker, encoding: "mp3" },
        { returnRawResponse: true },
      );
      const ab =
        aiResp instanceof Response
          ? await aiResp.arrayBuffer()
          : await new Response(aiResp as ReadableStream).arrayBuffer();
      bytes = new Uint8Array(ab);
      if (bytes.byteLength === 0) throw new ToolError(502, "No audio was returned.");
      contentType = "audio/mpeg";
      engine = "deepgram:aura-1";
    }
  }

  const id = crypto.randomUUID();
  await env.KV.put(`${AUDIO_PREFIX}${id}`, bytes, {
    expirationTtl: VOICE_TTL,
    metadata: { contentType },
  });
  await pushIndex(env, VOICE_INDEX, { id, text: text.slice(0, 120), engine, ts: Date.now() }, {
    ttl: VOICE_TTL,
    blobPrefix: AUDIO_PREFIX,
  });

  const url = `/api/tools/media/audio/${id}`;
  return { play_url: url, audio_file: url, engine, chars: text.length };
}

// ---- Galleries (this fork's own media) ----

export async function listImages(env: AppEnv): Promise<{ items: Array<Record<string, unknown>> }> {
  const raw = await env.KV.get(IMG_INDEX);
  let list: Array<{ id?: string; prompt?: string; quality?: string; ts?: number }> = [];
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    } catch {
      list = [];
    }
  }
  const items = list
    .filter((it) => typeof it.id === "string" && isMediaId(it.id))
    .map((it) => ({
      id: it.id as string,
      prompt: it.prompt ?? "",
      quality: it.quality ?? "",
      ts: it.ts ?? 0,
      img_url: `/api/tools/media/img/${encodeURIComponent(it.id as string)}`,
    }));
  return { items };
}

export async function listVoice(env: AppEnv): Promise<{ items: Array<Record<string, unknown>>; ttl_days: number }> {
  const raw = await env.KV.get(VOICE_INDEX);
  let list: Array<{ id?: string; text?: string; engine?: string; ts?: number }> = [];
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    } catch {
      list = [];
    }
  }
  const cutoff = Date.now() - VOICE_TTL * 1000;
  const items = list
    .filter((it) => typeof it.id === "string" && isMediaId(it.id) && (it.ts ?? 0) > cutoff)
    .map((it) => ({
      id: it.id as string,
      text: it.text ?? "",
      engine: it.engine ?? "",
      ts: it.ts ?? 0,
      audio_url: `/api/tools/media/audio/${encodeURIComponent(it.id as string)}`,
    }));
  return { items, ttl_days: 14 };
}

export async function listTranscripts(env: AppEnv): Promise<{ items: Array<Record<string, unknown>> }> {
  const raw = await env.KV.get(TEXT_INDEX);
  let list: Array<{ id?: string; text?: string; language?: string; ts?: number }> = [];
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    } catch {
      list = [];
    }
  }
  const items = list
    .filter((it) => typeof it.id === "string" && isMediaId(it.id))
    .map((it) => ({
      id: it.id as string,
      text: it.text ?? "",
      language: it.language ?? "",
      ts: it.ts ?? 0,
    }));
  return { items };
}

// ---- Delete (owner prunes their own gallery) ----

/** Drop one entry (by id) from a gallery index, preserving the index's own TTL. */
async function removeFromIndex(env: AppEnv, indexKey: string, id: string, ttl?: number): Promise<void> {
  const raw = await env.KV.get(indexKey);
  if (!raw) return;
  let list: Array<Record<string, unknown>> = [];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) list = p;
  } catch {
    return;
  }
  const next = list.filter((it) => it.id !== id);
  await env.KV.put(indexKey, JSON.stringify(next), ttl ? { expirationTtl: ttl } : undefined);
}

/** Delete a generated image / audio clip: remove its KV blob AND its index entry. */
export async function deleteMedia(env: AppEnv, kind: "img" | "audio", id: string): Promise<boolean> {
  if (!isMediaId(id)) return false;
  const prefix = kind === "img" ? IMG_PREFIX : AUDIO_PREFIX;
  const indexKey = kind === "img" ? IMG_INDEX : VOICE_INDEX;
  await env.KV.delete(`${prefix}${id}`);
  await removeFromIndex(env, indexKey, id, kind === "audio" ? VOICE_TTL : undefined);
  return true;
}

/** Delete a saved transcript (text lives inline in the index — no blob). */
export async function deleteTranscript(env: AppEnv, id: string): Promise<boolean> {
  if (!isMediaId(id)) return false;
  await removeFromIndex(env, TEXT_INDEX, id);
  return true;
}

// ---- Media serve (owner reads their own bytes from this fork's KV) ----

export async function getMedia(
  env: AppEnv,
  kind: "img" | "audio",
  id: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (!isMediaId(id)) return null;
  const prefix = kind === "img" ? IMG_PREFIX : AUDIO_PREFIX;
  const { value, metadata } = await env.KV.getWithMetadata<{ contentType?: string }>(
    `${prefix}${id}`,
    "arrayBuffer",
  );
  if (!value) return null;
  const fallback = kind === "img" ? "image/jpeg" : "audio/mpeg";
  return { body: value, contentType: metadata?.contentType ?? fallback };
}
