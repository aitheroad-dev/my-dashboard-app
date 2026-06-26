import {
  Home,
  FolderKanban,
  Target,
  LineChart,
  Wrench,
  BookOpen,
  Sparkles,
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
  assistant: { key: "assistant", label: "Assistant", path: "/assistant", icon: Sparkles },
};

/**
 * Pages that actually have a wired route. Settings only offers toggles/reorder for
 * these — so enabling a page can never link the sidebar to a 404. Grows per phase:
 * P1 = home/projects/goals/portfolio; P2 adds tools/kb.
 */
export const BUILT_PAGES: PageKey[] = [
  "home",
  "projects",
  "goals",
  "portfolio",
  "tools",
  "kb",
  "assistant",
];

/** Pages that can never be turned off (the dashboard always needs a landing). */
export const ALWAYS_ON: PageKey[] = ["home"];

/** Ordered nav entries from the server-resolved enabled page list. Restricted to
 * BUILT_PAGES so an enabled-but-not-yet-routed page (e.g. tools/kb before P2, or a
 * page enabled via an imported config) can never render a sidebar link that 404s. */
export function navFromPages(pages: PageKey[] | undefined): PageMeta[] {
  return (pages ?? [])
    .filter((k) => BUILT_PAGES.includes(k))
    .map((k) => PAGE_META[k])
    .filter(Boolean);
}
