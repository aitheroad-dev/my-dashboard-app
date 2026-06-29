import type { AppEnv } from "../lib/env";

/**
 * Native tools service (ISC-54.x rebuild, 2026-06-29).
 *
 * The tools run INSIDE this fork's own Worker — image / speech-to-text / OCR on
 * the fork's `env.AI` (Workers AI) binding, text-to-speech via OpenAI when a key
 * is present (multilingual incl. Hebrew) else Workers AI MeloTTS (English). No
 * pai-tools, no pt_ key, no worker→worker subrequest (kills CF error 1042). The
 * gate is the dashboard's own CF Access — the caller is already signed in. Each
 * fork bills its OWN account; generated media lives in this fork's own KV
 * (physically isolated, L2). Response shapes mirror the old proxy so the panels
 * are unchanged.
 *
 * Model gotchas (ported from the proven pai-tools build — never trust the catalog):
 *  - flux-1-schnell / lucid-origin return JPEG bytes (base64), not PNG.
 *  - whisper-large-v3-turbo takes audio as a base64 STRING + optional language hint.
 *  - llava-1.5-7b-hf takes the image as a byte ARRAY (number[]), output in `response`.
 *  - gpt-4o-mini-tts is OpenAI (not Workers AI) — the only tool needing a key.
 */

const IMG_INDEX = "tools:gallery:img";
const VOICE_INDEX = "tools:gallery:voice";
const IMG_PREFIX = "tools:img:";
const AUDIO_PREFIX = "tools:audio:";
const VOICE_TTL = 60 * 60 * 24 * 14; // saved voice clips auto-expire after 14 days
const GALLERY_CAP = 100;
const MAX_TTS_CHARS = 4000;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // whisper/ocr input ceiling

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"];

// ids are crypto.randomUUID() v4 — match exactly (no path/KV-key chars possible).
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isMediaId(id: string): boolean {
  return ID_RE.test(id);
}

const AI_TIMEOUT_MS = 60_000;

/** Carries an HTTP status so the route can return 400 (bad input) vs 5xx (failure). */
export class ToolError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Run a Workers-AI model with a hard timeout — a stalled model otherwise hangs
 * the request until the platform kills it. Times out → ToolError(504). */
async function runAI(env: AppEnv, model: string, input: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(504, "The model took too long to respond.")), AI_TIMEOUT_MS);
  });
  try {
    return await Promise.race([env.AI.run(model as never, input as never), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function decodeB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
/** Decode CLIENT-supplied base64 — invalid input is a 400, not an internal 500. */
function decodeB64Input(b64: string): Uint8Array {
  try {
    return decodeB64(b64);
  } catch {
    throw new ToolError(400, "Invalid base64 data.");
  }
}
function approxBytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
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

export function toolsStatus(env: AppEnv, openaiKey: string | null, canUse: boolean) {
  const ttsMultilingual = Boolean(openaiKey || env.OPENAI_API_KEY);
  return {
    // `ready` reflects whether THIS viewer can actually run the tools (every tool
    // route is owner-gated). An open-dev / non-owner viewer gets ready:false so the
    // page shows an honest "sign in" state instead of a green banner over 403s.
    ready: canUse,
    tts_multilingual: ttsMultilingual,
    tools: [
      { name: "image", description: "Generate an image from a text prompt." },
      { name: "speak-to-text", description: "Transcribe speech (multilingual)." },
      { name: "text-to-speech", description: ttsMultilingual
        ? "Read text aloud (multilingual, incl. Hebrew)."
        : "Read text aloud (English; add an OpenAI key for other languages)." },
      { name: "read-text", description: "Extract text from a photo or screenshot." },
    ],
  };
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
  return {
    text: result.text.trim(),
    word_count: result.word_count,
    language: result.transcription_info?.language,
  };
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

  const bytes = decodeB64Input(b64);
  // llava-1.5-7b is the available vision model on this account (llama-3.2-vision
  // needs a Meta model agreement). EU forks may need Mistral Small 3.1 instead.
  const result = (await runAI(env, "@cf/llava-hf/llava-1.5-7b-hf", {
    image: Array.from(bytes),
    prompt,
    max_tokens: 1024,
  })) as { response?: string; description?: string };

  const text = result?.response ?? result?.description;
  if (typeof text !== "string") throw new ToolError(502, "No text could be extracted.");
  return { text: text.trim() };
}

// ---- Text → Speech (OpenAI gpt-4o-mini-tts, else Workers AI MeloTTS) ----

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

  if (key) {
    const reqVoice = typeof input.voice === "string" ? input.voice.toLowerCase() : "";
    const voice = OPENAI_VOICES.includes(reqVoice) ? reqVoice : "alloy";
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", input: text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new ToolError(502, `Text-to-speech failed (HTTP ${r.status}): ${t.slice(0, 160)}`);
    }
    bytes = new Uint8Array(await r.arrayBuffer());
    contentType = "audio/mpeg";
    engine = "openai:gpt-4o-mini-tts";
  } else {
    // No OpenAI key → Workers AI MeloTTS (English only; returns WAV despite docs).
    const result = (await runAI(env, "@cf/myshell-ai/melotts", {
      prompt: text,
      lang: "en",
    })) as { audio?: string };
    if (!result?.audio) throw new ToolError(502, "No audio was returned.");
    bytes = decodeB64(result.audio);
    contentType = "audio/wav";
    engine = "melotts";
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
