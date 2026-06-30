import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon,
  Mic,
  Square,
  Volume2,
  ScanText,
  Images,
  Download,
  Copy,
  Check,
  Upload,
  Loader2,
  Sparkles,
  Trash2,
  ChevronRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button, Card } from "./ui";
import {
  callTool,
  useToolGallery,
  useVoiceGallery,
  useTranscriptGallery,
  useDeleteGalleryItem,
  useToolsStatus,
  type FluxResult,
  type TtsResult,
  type OcrResult,
  type WhisperResult,
} from "../lib/api";

/**
 * Tools workspace (ISC-54.x / ISC-62) — the functional home where the fork's
 * tools are actually USED, not just listed. Each panel POSTs to the native
 * `/api/tools/:tool` routes, which run the model on this fork's own `env.AI`
 * (TTS optionally via a server-side OpenAI key) — no proxy, no key in the browser.
 *
 * Design (FirstPrinciples): zero setup + sensible defaults, one calm sectioned
 * surface, input → visible output in place (never raw base64/JSON), honest
 * waiting + honest upstream errors, and a gallery so it feels inhabited.
 */

const MAX_RECORD_MS = 120_000; // cap a recording at 2 min (memory + upload size)
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // whisper's limit
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ---- browser helpers (only ever run inside event handlers / async paths) ----

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

/** Decode any recorded blob → 16-bit PCM mono WAV → base64 (whisper accepts WAV reliably). */
function encodeWavMono(buf: AudioBuffer): ArrayBuffer {
  const len = buf.length;
  const mono = new Float32Array(len);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += data[i] / buf.numberOfChannels;
  }
  const sampleRate = buf.sampleRate; // header rate == decoded data rate by construction
  const dataSize = len * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return out;
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  // OfflineAudioContext for decode-only — no concurrent live-context cap (L3).
  const OAC: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, 44100);
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  return bytesToBase64(new Uint8Array(encodeWavMono(audioBuf)));
}

/**
 * Mic recorder with full lifecycle hygiene (H2): the stream is held in a ref and
 * released on stop, on the 2-min cap, AND on unmount — so switching workspace
 * tabs mid-recording can never orphan a live mic. Delivers the encoded clip via
 * `onResult` (also fired when the cap auto-stops), never after unmount.
 */
function useRecorder(onResult: (b64: string | null) => void) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const releaseStream = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
      } catch {
        /* recorder already gone */
      }
      releaseStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    const mr = recorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop(); // onstop does the encode + deliver
    if (mountedRef.current) setRecording(false);
  };

  const start = async () => {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (mountedRef.current) setError("Microphone access was denied or is unavailable.");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      releaseStream();
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];
      let out: string | null = null;
      try {
        out = await blobToWavBase64(blob);
      } catch {
        if (mountedRef.current) setError("Couldn't process that recording. Try again.");
      }
      if (mountedRef.current) onResultRef.current(out); // never deliver after unmount
    };
    recorderRef.current = mr;
    mr.start();
    if (mountedRef.current) setRecording(true);
    timerRef.current = setTimeout(() => stop(), MAX_RECORD_MS);
  };

  return { recording, error, start, stop };
}

// ---- shared field primitives ----

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

// ---- Image (flux) ----

function ImagePanel() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"high" | "fast">("high");
  // Synchronous re-entrancy guard: `disabled`/`isPending` only update on the next
  // render, so two clicks fired before that re-render both pass — a ref blocks the
  // second one instantly (this is what caused the duplicate image on the first test).
  const submitting = useRef(false);
  const m = useMutation({
    mutationFn: () => callTool<FluxResult>("flux", { prompt, quality }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tools-gallery"] }),
    onSettled: () => {
      submitting.current = false;
    },
  });
  const generate = () => {
    if (submitting.current || !prompt.trim()) return;
    submitting.current = true;
    m.mutate();
  };

  return (
    <div className="space-y-4">
      <Field label="Describe the image">
        <textarea
          className={cn(inputClass, "min-h-24 resize-y")}
          placeholder="A calm Japanese garden at dawn, soft mist, watercolor style…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={!prompt.trim() || m.isPending}>
          {m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate image
        </Button>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-sm">
          {(["high", "fast"] as const).map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuality(q)}
              className={cn(
                "px-3 py-2 transition-colors",
                quality === q ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {q === "high" ? "High quality" : "Fast"}
            </button>
          ))}
        </div>
      </div>
      {m.isPending && <Working label="Painting your image…" />}
      {m.isError && <ErrorLine message={errMsg(m.error)} />}
      {m.data && (
        <div className="space-y-3">
          <img
            src={`data:image/jpeg;base64,${m.data.image_base64}`}
            alt={m.data.prompt}
            className="w-full rounded-xl border border-slate-200"
          />
          <a
            href={`data:image/jpeg;base64,${m.data.image_base64}`}
            download={`image-${Date.now()}.jpg`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </div>
      )}
    </div>
  );
}

// ---- Text → Speech (tts) ----

function TextToSpeechPanel() {
  const qc = useQueryClient();
  const status = useToolsStatus();
  const languages = status.data?.tts_languages ?? []; // [{ code, label, engine, voices }] — English (Aura) + Hebrew (Edge)
  const [text, setText] = useState("");
  const [langCode, setLangCode] = useState("en");
  const [voice, setVoice] = useState("");
  // The selected language (fall back to the first available so the panel is never blank).
  const selectedLang = languages.find((l) => l.code === langCode) ?? languages[0];
  const voices = selectedLang?.voices ?? [];
  // Keep the language selection valid as the status loads (default English / first language).
  useEffect(() => {
    if (languages.length && !languages.some((l) => l.code === langCode)) setLangCode(languages[0].code);
  }, [languages, langCode]);
  // Keep a valid voice selected as the chosen language's voice list loads / changes.
  useEffect(() => {
    if (voices.length && !voices.some((v) => v.id === voice)) setVoice(voices[0].id);
  }, [voices, voice]);
  const m = useMutation({
    mutationFn: () => callTool<TtsResult>("tts", { text, voice }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tools-voice"] }),
  });

  return (
    <div className="space-y-4">
      <Field label="Text to speak">
        <textarea
          className={cn(inputClass, "min-h-28 resize-y")}
          placeholder="Type anything — it'll be read aloud."
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => m.mutate()} disabled={!text.trim() || m.isPending}>
          {m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
          Speak
        </Button>
        {languages.length > 1 && (
          <select
            value={langCode}
            onChange={(e) => setLangCode(e.target.value)}
            className={cn(inputClass, "w-auto")}
            aria-label="Language"
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        )}
        {voices.length > 0 && (
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className={cn(inputClass, "w-auto")}
            aria-label="Voice"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <span className="text-xs text-slate-400">{text.length}/4000</span>
      </div>
      <p className="text-xs text-slate-500">English (Deepgram) + Hebrew (Microsoft Edge) — no key needed.</p>
      {m.isPending && <Working label="Generating speech…" />}
      {m.isError && <ErrorLine message={errMsg(m.error)} />}
      {m.data && (
        <div className="space-y-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={m.data.audio_file} controls autoPlay className="w-full" />
          <a
            href={m.data.audio_file}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900"
          >
            <Download className="h-4 w-4" />
            Open / download audio
          </a>
        </div>
      )}
    </div>
  );
}

// ---- Speak → Text (whisper) ----

function SpeakToTextPanel() {
  const qc = useQueryClient();
  const [language, setLanguage] = useState("");
  const [fileErr, setFileErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (audio_base64: string) =>
      callTool<WhisperResult>("whisper", language ? { audio_base64, language } : { audio_base64 }),
    // the transcript auto-saves server-side → refresh the gallery's Transcripts list
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tools-text"] }),
  });
  const recorder = useRecorder((b64) => {
    if (b64) m.mutate(b64);
  });

  // Uploaded files are sent raw (whisper accepts mp3/wav/m4a/ogg/flac/webm per its
  // contract) — no client decode, avoiding decode-failure + memory cost.
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileErr(null);
    if (file.size > MAX_AUDIO_BYTES) {
      setFileErr("That file is over 25 MB — please use a shorter clip.");
      return;
    }
    try {
      m.mutate(await fileToBase64(file));
    } catch {
      setFileErr("Couldn't read that audio file.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {recorder.recording ? (
          <Button onClick={recorder.stop} className="bg-red-600 hover:bg-red-500">
            <Square className="h-4 w-4" />
            Stop & transcribe
          </Button>
        ) : (
          <Button onClick={recorder.start} disabled={m.isPending}>
            <Mic className="h-4 w-4" />
            Record
          </Button>
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <Upload className="h-4 w-4" />
          Upload audio
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </label>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className={cn(inputClass, "w-auto")}
          aria-label="Language hint"
        >
          <option value="">Auto-detect language</option>
          <option value="en">English</option>
          <option value="he">Hebrew</option>
          <option value="nl">Dutch</option>
        </select>
      </div>
      {recorder.recording && (
        <div className="flex items-center gap-2 text-sm text-red-600">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
          Recording… speak now, then stop (auto-stops at 2 min).
        </div>
      )}
      {recorder.error && <ErrorLine message={recorder.error} />}
      {fileErr && <ErrorLine message={fileErr} />}
      {m.isPending && <Working label="Transcribing…" />}
      {m.isError && <ErrorLine message={errMsg(m.error)} />}
      {m.data && (
        <div className="space-y-2">
          <Card>
            <p className="whitespace-pre-wrap text-sm text-slate-800">
              {m.data.text || "(no speech detected)"}
            </p>
          </Card>
          <div className="flex items-center gap-3">
            <CopyButton text={m.data.text} />
            {m.data.language && (
              <span className="text-xs text-slate-400">
                Detected: {m.data.language}
                {typeof m.data.word_count === "number" ? ` · ${m.data.word_count} words` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Read Text (ocr) ----

function ReadTextPanel() {
  const [preview, setPreview] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (image_base64: string) => callTool<OcrResult>("ocr", { image_base64 }),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileErr(null);
    if (file.size > MAX_IMAGE_BYTES) {
      setFileErr("That image is over 10 MB — please use a smaller one.");
      return;
    }
    try {
      const b64 = await fileToBase64(file);
      setPreview(`data:${file.type || "image/jpeg"};base64,${b64}`);
      m.mutate(b64);
    } catch {
      setFileErr("Couldn't read that image.");
    }
  };

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center hover:border-slate-400">
        <ScanText className="h-7 w-7 text-slate-400" />
        <span className="text-sm font-medium text-slate-700">Choose a photo or screenshot</span>
        <span className="text-xs text-slate-400">A letter, receipt, label, or any image with text</span>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>
      {fileErr && <ErrorLine message={fileErr} />}
      {preview && (
        <img src={preview} alt="Selected" className="max-h-64 rounded-xl border border-slate-200" />
      )}
      {m.isPending && <Working label="Reading the text…" />}
      {m.isError && <ErrorLine message={errMsg(m.error)} />}
      {m.data && (
        <div className="space-y-2">
          <Card>
            <p className="whitespace-pre-wrap text-sm text-slate-800">
              {m.data.text || "(no text found)"}
            </p>
          </Card>
          <CopyButton text={m.data.text} />
        </div>
      )}
    </div>
  );
}

// ---- Gallery (history) ----

/** Small destructive icon button used across gallery items. */
function DeleteButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Delete"
      title="Delete"
      className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white/90 p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}

/**
 * A foldable gallery section. Sections start collapsed (the count badge stays
 * visible) and remember each open/closed choice per section in localStorage, so
 * expanding a section sticks across reloads and a long list (e.g. many voice
 * clips) never buries the sections below it.
 * Mounts client-side (gallery data loads via TanStack Query), so reading
 * localStorage in the initializer is hydration-safe.
 */
function CollapsibleSection({
  id,
  title,
  count,
  meta,
  children,
}: {
  id: string;
  title: string;
  count: number;
  meta?: string;
  children: React.ReactNode;
}) {
  const storageKey = `mdash.gallery.section.${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore storage failures (private mode, quota) */
      }
      return next;
    });

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group mb-3 flex w-full select-none items-center gap-2 text-left"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:text-slate-600",
            open && "rotate-90",
          )}
        />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 group-hover:text-slate-700">
          {title}
        </h3>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-500">
          {count}
        </span>
        {meta && <span className="text-xs text-slate-400">{meta}</span>}
      </button>
      {open && children}
    </section>
  );
}

function GalleryPanel() {
  const images = useToolGallery();
  const clips = useVoiceGallery();
  const transcripts = useTranscriptGallery();
  const del = useDeleteGalleryItem();
  const imgItems = images.data?.items ?? [];
  const clipItems = clips.data?.items ?? [];
  const textItems = transcripts.data?.items ?? [];
  const pendingId = del.isPending ? del.variables?.id : undefined;

  if (images.isLoading || clips.isLoading || transcripts.isLoading)
    return <Working label="Loading your gallery…" />;
  if (images.isError || clips.isError || transcripts.isError)
    return <ErrorLine message="Couldn't load your gallery. Check the connection above and try again." />;

  if (imgItems.length === 0 && clipItems.length === 0 && textItems.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <Images className="h-7 w-7 text-slate-400" />
        <p className="text-sm font-medium text-slate-700">Nothing here yet</p>
        <p className="max-w-xs text-sm text-slate-500">
          Images you generate, voice clips, and transcripts you create will be saved here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {imgItems.length > 0 && (
        <CollapsibleSection id="images" title="Images" count={imgItems.length}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {imgItems.map((it) => (
              <div key={it.id} className="group relative overflow-hidden rounded-lg border border-slate-200">
                <a href={it.img_url} target="_blank" rel="noreferrer" className="block" title={it.prompt}>
                  <img
                    src={it.img_url}
                    alt={it.prompt}
                    loading="lazy"
                    className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
                  />
                </a>
                <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <DeleteButton
                    busy={pendingId === it.id}
                    onClick={() => del.mutate({ kind: "img", id: it.id })}
                  />
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {clipItems.length > 0 && (
        <CollapsibleSection
          id="clips"
          title="Voice clips"
          count={clipItems.length}
          meta={clips.data?.ttl_days ? `kept ${clips.data.ttl_days} days` : undefined}
        >
          <div className="space-y-3">
            {clipItems.map((it) => (
              <Card key={it.id} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <p className="truncate text-sm text-slate-700">{it.text || "(clip)"}</p>
                  <DeleteButton
                    busy={pendingId === it.id}
                    onClick={() => del.mutate({ kind: "audio", id: it.id })}
                  />
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={it.audio_url} controls className="w-full" />
              </Card>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {textItems.length > 0 && (
        <CollapsibleSection id="transcripts" title="Transcripts" count={textItems.length}>
          <div className="space-y-3">
            {textItems.map((it) => (
              <Card key={it.id} className="flex flex-col gap-2">
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-slate-800">
                  {it.text || "(empty)"}
                </p>
                <div className="flex items-center gap-2">
                  <CopyButton text={it.text} />
                  <DeleteButton
                    busy={pendingId === it.id}
                    onClick={() => del.mutate({ kind: "text", id: it.id })}
                  />
                  {it.language && <span className="text-xs text-slate-400">{it.language}</span>}
                </div>
              </Card>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ---- Workspace shell (section switcher) ----

const SECTIONS = [
  { key: "image", label: "Image", icon: ImageIcon, render: () => <ImagePanel /> },
  { key: "speak", label: "Speak → Text", icon: Mic, render: () => <SpeakToTextPanel /> },
  { key: "tts", label: "Text → Speech", icon: Volume2, render: () => <TextToSpeechPanel /> },
  { key: "ocr", label: "Read Text", icon: ScanText, render: () => <ReadTextPanel /> },
  { key: "gallery", label: "Gallery", icon: Images, render: () => <GalleryPanel /> },
] as const;

export function ToolsWorkspace() {
  const [active, setActive] = useState<(typeof SECTIONS)[number]["key"]>("image");
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActive(key)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors",
              active === key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <Card>{section.render()}</Card>
    </div>
  );
}
