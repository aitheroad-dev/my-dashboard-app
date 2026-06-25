import {
  Home,
  FolderKanban,
  Target,
  LineChart,
  Wrench,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import type { PageKey } from "./api";

/**
 * Page manifest (ISC-34). Keyed by PageKey — the sidebar + route gating read the
 * ORDERED, ENABLED subset the server resolves from per-fork config (`/api/settings`
 * → `pages`). Adding a page = add a key here + its route in `routes.ts` + a server
 * PAGE_KEY entry (keep in sync, like the source repo's page-keys/pages pair).
 */
export interface PageMeta {
  key: PageKey;
  label: string;
  path: string;
  icon: LucideIcon;
}

export const PAGE_META: Record<PageKey, PageMeta> = {
  home: { key: "home", label: "Home", path: "/", icon: Home },
  projects: { key: "projects", label: "Projects", path: "/projects", icon: FolderKanban },
  goals: { key: "goals", label: "Goals", path: "/goals", icon: Target },
  portfolio: { key: "portfolio", label: "Portfolio", path: "/portfolio", icon: LineChart },
  tools: { key: "tools", label: "Tools", path: "/tools", icon: Wrench },
  kb: { key: "kb", label: "Knowledge Base", path: "/kb", icon: BookOpen },
};

/** Ordered nav entries from the server-resolved enabled page list. */
export function navFromPages(pages: PageKey[] | undefined): PageMeta[] {
  return (pages ?? []).map((k) => PAGE_META[k]).filter(Boolean);
}
