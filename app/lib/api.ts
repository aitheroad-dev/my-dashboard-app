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

// ---- Shared types (mirror the server shapes) ----

export type Theme = "light" | "dark" | "system";
export type PageKey = "home" | "projects" | "goals" | "portfolio" | "tools" | "kb";

export interface Config {
  schemaVersion: number;
  display_name: string;
  theme: Theme;
  enabled_pages: PageKey[];
  page_order: PageKey[];
  tools_key: string | null;
  prefs: Record<string, unknown>;
}

export interface Settings {
  display_name: string;
  config: Config; // tools_key is always null here — the server redacts it (ISC-39)
  pages: PageKey[];
  tools_configured: boolean;
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

export interface ToolsStatus {
  configured: boolean;
  valid?: boolean;
  tools?: { name: string; description: string }[];
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
