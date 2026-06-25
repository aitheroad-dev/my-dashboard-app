import { NavLink, Outlet } from "react-router";
import { LayoutDashboard, Settings as SettingsIcon } from "lucide-react";
import { useMe, useSettings, type PageKey } from "../lib/api";
import { navFromPages } from "../lib/pages";
import { cn } from "../lib/utils";

// Shown instantly while /api/settings loads (avoids an empty-sidebar flash on
// first paint / SSR). Matches the server's DEFAULT_ENABLED.
const FALLBACK_PAGES: PageKey[] = ["home", "projects", "goals", "portfolio", "tools", "kb"];

/**
 * App shell (ISC-34): a left sidebar whose entries are the ENABLED pages in the
 * per-fork config order, plus the page outlet. The nav is config-driven — toggle
 * a page off in settings and it disappears here on next load.
 */
export default function Shell() {
  const { data: settings } = useSettings();
  const { data: me } = useMe();
  const pages = settings?.pages ?? FALLBACK_PAGES;
  const nav = navFromPages(pages);
  const title = settings?.display_name ?? "My Dashboard";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
            <LayoutDashboard className="h-4 w-4" />
          </div>
          <span className="truncate text-sm font-semibold">{title}</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {nav.map((p) => (
            <NavLink
              key={p.key}
              to={p.path}
              end={p.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )
              }
            >
              <p.icon className="h-4 w-4 shrink-0" />
              {p.label}
            </NavLink>
          ))}
        </nav>
        {me?.isOwner && (
          <div className="border-t border-slate-200 p-3">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )
              }
            >
              <SettingsIcon className="h-4 w-4 shrink-0" />
              Settings
            </NavLink>
          </div>
        )}
      </aside>

      {/* Mobile top nav */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white md:hidden">
        <div className="flex h-14 items-center gap-2 px-4">
          <LayoutDashboard className="h-5 w-5" />
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
          {nav.map((p) => (
            <NavLink
              key={p.key}
              to={p.path}
              end={p.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
                  isActive
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600",
                )
              }
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </NavLink>
          ))}
          {me?.isOwner && (
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
                  isActive
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600",
                )
              }
            >
              <SettingsIcon className="h-3.5 w-3.5" />
              Settings
            </NavLink>
          )}
        </nav>
      </header>

      <main className="px-5 py-8 md:ml-60 md:px-10">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
