import { useEffect } from "react";
import { useNavigate } from "react-router";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

/**
 * Client data layer (ISC-23): a thin typed fetch wrapper over the Hono `/api/*`
 * routes + TanStack Query hooks. Every page reads through this one seam.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPut = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) => request<T>(path, { method: "DELETE" });

// ---- Shared types (mirror the server shapes) ----

export type Theme = "light" | "dark" | "system";
export type PageKey = "home" | "projects" | "goals" | "portfolio" | "tools" | "kb" | "assistant";

export interface Config {
  schemaVersion: number;
  display_name: string;
  theme: Theme;
  enabled_pages: PageKey[];
  page_order: PageKey[];
  openai_key: string | null; // optional, server-side only — for multilingual TTS
  prefs: Record<string, unknown>;
}

export interface Settings {
  display_name: string;
  config: Config; // openai_key is always null here — server-redacted (ISC-39)
  pages: PageKey[];
  openai_configured: boolean; // an OpenAI key is set → multilingual TTS available
}

export interface KbIndexItem {
  slug: string;
  title: string;
  updated_at: string;
}

export interface KbDoc {
  slug: string;
  title: string;
  blocks: { blocks: unknown[] };
  updated_at: string;
}

export interface TtsVoice {
  id: string; // engine-specific voice id sent to callTool("tts", { voice })
  label: string; // friendly display name (e.g. "Avri (male)", "Asteria")
}
export interface TtsLanguage {
  code: string; // short language code: "en" | "he"
  label: string; // language selector display name (e.g. "English", "עברית")
  engine: string; // engine backing this language (deepgram:aura-1 | microsoft-edge)
  voices: TtsVoice[]; // voices this language offers, in display order
}
export interface ToolsStatus {
  ready: boolean; // this viewer can run the tools (CF-Access owner; routes are owner-gated)
  tts_languages: TtsLanguage[]; // language-grouped TTS: English keyless Aura + Hebrew keyless Edge
  tools: { name: string; description: string }[];
}

// ---- Tool result shapes (returned by the native `/api/tools/:tool` routes) ----

export interface FluxResult {
  image_url: string;
  image_base64: string;
  prompt: string;
  quality: string;
}
export interface TtsResult {
  play_url: string;
  audio_file: string;
  engine: string;
  chars: number;
}
export interface OcrResult {
  text: string;
}
export interface WhisperResult {
  text: string;
  word_count?: number;
  language?: string;
}
export interface GalleryImage {
  id: string;
  prompt: string;
  quality: string;
  ts: number;
  img_url: string;
}
export interface VoiceClip {
  id: string;
  text: string;
  engine: string;
  ts: number;
  audio_url: string;
}
export interface TranscriptClip {
  id: string;
  text: string;
  language: string;
  ts: number;
}

export interface Me {
  email: string;
  isOwner: boolean;
  mode: "access" | "open-dev";
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  mission: string | null;
  status: string;
  goal_count: number;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  slug: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PortfolioSnapshot {
  base: string;
  as_of: string | null;
  total_base: number;
  total_usd: number;
  positions: number;
  holdings: unknown[];
  by_currency: unknown[];
  by_cluster: unknown[];
  configured: boolean;
}

// ---- Query hooks ----

export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: () => apiGet<Me>("/api/me") });

export const useSettings = () =>
  useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<Settings>("/api/settings"),
  });

export const useProjects = () =>
  useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<Project[]>("/api/projects"),
  });

export const useGoals = () =>
  useQuery({ queryKey: ["goals"], queryFn: () => apiGet<Goal[]>("/api/goals") });

export const usePortfolio = () =>
  useQuery({
    queryKey: ["portfolio"],
    queryFn: () => apiGet<PortfolioSnapshot>("/api/portfolio"),
  });

export const useKbIndex = () =>
  useQuery({
    queryKey: ["kb"],
    queryFn: () => apiGet<KbIndexItem[]>("/api/kb"),
  });

export const useKbDoc = (slug: string | undefined) =>
  useQuery({
    queryKey: ["kb", slug],
    queryFn: () => apiGet<KbDoc>(`/api/kb/${slug}`),
    enabled: Boolean(slug),
  });

export const useToolsStatus = () =>
  useQuery({
    queryKey: ["tools-status"],
    queryFn: () => apiGet<ToolsStatus>("/api/tools/status"),
  });

/**
 * Invoke a tool natively (ISC-62). The Worker runs the model on THIS fork's own
 * `env.AI` binding (TTS optionally via a server-side OpenAI key) — no proxy, no
 * key in the browser, gated by the dashboard's own CF Access. Returns the tool's
 * result object; a non-2xx surfaces its `{error}` via ApiError.
 */
export const callTool = <T>(tool: string, body: unknown) =>
  apiPost<T>(`/api/tools/${tool}`, body);

export const useToolGallery = () =>
  useQuery({
    queryKey: ["tools-gallery"],
    queryFn: () => apiGet<{ items: GalleryImage[] }>("/api/tools/media/list"),
  });

export const useVoiceGallery = () =>
  useQuery({
    queryKey: ["tools-voice"],
    queryFn: () =>
      apiGet<{ items: VoiceClip[]; ttl_days: number }>("/api/tools/voice/list"),
  });

export const useTranscriptGallery = () =>
  useQuery({
    queryKey: ["tools-text"],
    queryFn: () => apiGet<{ items: TranscriptClip[] }>("/api/tools/text/list"),
  });

/** Delete one gallery item, then refresh the matching gallery list. `kind` is
 * "img"/"audio" (media blobs) or "text" (saved transcripts). */
export const useDeleteGalleryItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: "img" | "audio" | "text"; id: string }) =>
      kind === "text"
        ? apiDelete<{ deleted: boolean }>(`/api/tools/text/${id}`)
        : apiDelete<{ deleted: boolean }>(`/api/tools/media/${kind}/${id}`),
    onSuccess: (_data, { kind }) => {
      const key = kind === "img" ? "tools-gallery" : kind === "audio" ? "tools-voice" : "tools-text";
      qc.invalidateQueries({ queryKey: [key] });
    },
  });
};

export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Config>) =>
      apiPut<Settings>("/api/settings", patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
};

/**
 * Route-level page gating (ISC-34). If a page is toggled off in Settings, its
 * route redirects home on next load. The sidebar already hides the link; this
 * stops a bookmarked/typed URL from reaching a disabled page. Waits for settings
 * to resolve so we never bounce a page that is actually enabled.
 */
export function useRequireEnabled(key: PageKey) {
  const { data: settings, isLoading, isError } = useSettings();
  const navigate = useNavigate();
  useEffect(() => {
    if (isLoading || isError || !settings) return;
    if (!settings.pages.includes(key)) {
      navigate("/", { replace: true });
    }
  }, [settings, isLoading, isError, key, navigate]);
}
