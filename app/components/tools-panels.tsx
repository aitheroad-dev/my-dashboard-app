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
import { useRecorder } from "../lib/useRecorder";

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

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // whisper's limit
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ---- browser helpers (only ever run inside event handlers / async paths) ----

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

// Recorder + WAV encoding now live in ../lib/useRecorder (shared with the Assistant page).

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
  const [refImage, setRefImage] = useState<string | null>(null); // base64 (no data: prefix) of the uploaded reference
  const [strength, setStrength] = useState(0.6);
  // Synchronous re-entrancy guard: `disabled`/`isPending` only update on the next
  // render, so two clicks fired before that re-render both pass — a ref blocks the
  // second one instantly (this is what caused the duplicate image on the first test).
  const submitting = useRef(false);
  const m = useMutation({
    mutationFn: () =>
      callTool<FluxResult>("flux", refImage ? { prompt, image: refImage, strength } : { prompt, quality }),
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
  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      setRefImage(res.includes(",") ? res.slice(res.indexOf(",") + 1) : res);
    };
    reader.readAsDataURL(file);
  };
  const ct = m.data?.content_type || "image/jpeg";
  const ext = ct === "image/png" ? "png" : "jpg";

  return (
    <div className="space-y-4">
      <Field label={refImage ? "How should I transform it?" : "Describe the image"}>
        <textarea
          className={cn(inputClass, "min-h-24 resize-y")}
          placeholder={
            refImage
              ? "Turn this into a watercolor painting · a cyberpunk city · an oil portrait…"
              : "A calm Japanese garden at dawn, soft mist, watercolor style…"
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>

      <Field label="Reference image (optional)">
        {refImage ? (
          <div className="flex items-start gap-3">
            <img
              src={`data:image/*;base64,${refImage}`}
              alt="reference"
              className="h-24 w-24 rounded-lg border border-slate-200 object-cover"
            />
            <div className="flex-1 space-y-2">
              <button
                type="button"
                onClick={() => setRefImage(null)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                Remove
              </button>
              <div>
                <label className="block text-xs text-slate-500">
                  Strength {strength.toFixed(2)} —{" "}
                  {strength <= 0.4 ? "stays close to your image" : strength >= 0.75 ? "loose / creative" : "balanced"}
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.05}
                  value={strength}
                  onChange={(e) => setStrength(Number(e.target.value))}
                  className="w-full max-w-xs"
                />
              </div>
            </div>
          </div>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <ImageIcon className="h-4 w-4" />
            Upload an image to transform it
          </label>
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={!prompt.trim() || m.isPending}>
          {m.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {refImage ? "Transform image" : "Generate image"}
        </Button>
        {!refImage && (
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
        )}
      </div>
      {m.isPending && <Working label={refImage ? "Transforming your image…" : "Painting your image…"} />}
      {m.isError && <ErrorLine message={errMsg(m.error)} />}
      {m.data && (
        <div className="space-y-3">
          <img
            src={`data:${ct};base64,${m.data.image_base64}`}
            alt={m.data.prompt}
            className="w-full rounded-xl border border-slate-200"
          />
          <a
            href={`data:${ct};base64,${m.data.image_base64}`}
            download={`image-${Date.now()}.${ext}`}
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
