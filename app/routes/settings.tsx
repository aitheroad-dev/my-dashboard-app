import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ArrowDown,
  Download,
  Upload,
  Save,
  Settings as SettingsIcon,
  Copy,
  RefreshCw,
  Radio,
} from "lucide-react";
import type { Route } from "./+types/settings";
import {
  useMe,
  useSettings,
  useUpdateSettings,
  useStreams,
  useSpecEntities,
  useCreateStream,
  useRotateStream,
  useSetStreamEnabled,
  useDeadLetters,
  type Config,
  type PageKey,
  type Theme,
} from "../lib/api";
import { BUILT_PAGES, ALWAYS_ON, PAGE_META } from "../lib/pages";
import {
  PageHeader,
  Card,
  Button,
  Toggle,
  Loading,
  ErrorState,
  EmptyState,
} from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Settings — My Dashboard" }];
}

const THEMES: Theme[] = ["light", "dark", "system"];

/** Built pages in the fork's configured order (built pages missing from the
 * stored order are appended so a freshly-added page still shows up). */
function builtInOrder(order: PageKey[]): PageKey[] {
  const seen = order.filter((k) => BUILT_PAGES.includes(k));
  const missing = BUILT_PAGES.filter((k) => !seen.includes(k));
  return [...seen, ...missing];
}

export default function Settings() {
  const me = useMe();
  const { data: settings, isLoading, error } = useSettings();
  const save = useUpdateSettings();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [openaiKey, setOpenaiKey] = useState("");

  // Editable local state, seeded once from the loaded config.
  const [name, setName] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [order, setOrder] = useState<PageKey[]>([]);
  const [enabled, setEnabled] = useState<Set<PageKey>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (seeded || !settings) return;
    const c = settings.config;
    setName(c.display_name);
    setTheme(c.theme);
    setOrder(builtInOrder(c.page_order));
    setEnabled(new Set(c.enabled_pages.filter((k) => BUILT_PAGES.includes(k))));
    setSeeded(true);
  }, [settings, seeded]);

  // Error first, then wait for BOTH me + settings to resolve (so a non-owner never
  // flashes the owner form while /api/me is still loading), then owner-gate.
  if (error) return <ErrorState message={(error as Error).message} />;
  if (isLoading || me.isLoading || !settings || !me.data)
    return <Loading label="Loading settings…" />;
  if (!me.data.isOwner) {
    return (
      <div>
        <PageHeader title="Settings" />
        <EmptyState
          icon={SettingsIcon}
          title="Owner only"
          message="Only the dashboard owner can change settings."
        />
      </div>
    );
  }

  function move(i: number, dir: -1 | 1) {
    setOrder((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function toggle(key: PageKey, on: boolean) {
    if (ALWAYS_ON.includes(key)) return; // home can't be turned off
    setEnabled((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** Build the config patch, preserving any non-built page settings (e.g. tools/kb
   * before they ship) so editing here never clobbers them. */
  function buildPatch(): Partial<Config> {
    const base = settings!.config;
    const enabledBuilt = order.filter((k) => enabled.has(k) || ALWAYS_ON.includes(k));
    const enabledOther = base.enabled_pages.filter((k) => !BUILT_PAGES.includes(k));
    const orderOther = base.page_order.filter((k) => !BUILT_PAGES.includes(k));
    return {
      display_name: name.trim() || "My Dashboard",
      theme,
      enabled_pages: [...enabledBuilt, ...enabledOther],
      page_order: [...order, ...orderOther],
    };
  }

  function onSave() {
    setNotice(null);
    save.mutate(buildPatch(), {
      onSuccess: () => setNotice("Saved."),
      onError: (e) => setNotice(`Save failed: ${(e as Error).message}`),
    });
  }

  function onSaveOpenAI() {
    const k = openaiKey.trim();
    if (!k) return;
    setNotice(null);
    save.mutate(
      { openai_key: k },
      {
        onSuccess: () => {
          setOpenaiKey("");
          setNotice("OpenAI key saved — multilingual text-to-speech is on.");
          qc.invalidateQueries({ queryKey: ["tools-status"] });
        },
        onError: (e) => setNotice(`Failed: ${(e as Error).message}`),
      },
    );
  }

  function onRemoveOpenAI() {
    setNotice(null);
    save.mutate(
      { openai_key: null },
      {
        onSuccess: () => {
          setNotice("OpenAI key removed — text-to-speech is now English-only.");
          qc.invalidateQueries({ queryKey: ["tools-status"] });
        },
        onError: (e) => setNotice(`Failed: ${(e as Error).message}`),
      },
    );
  }

  function onExport() {
    const blob = new Blob([JSON.stringify(settings!.config, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-dashboard-config.json";
    a.click();
    URL.revokeObjectURL(url);
    setNotice("Exported current config.");
  }

  function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      setNotice("Import failed: config file is too large (max 256 KB).");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setNotice(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setNotice("Import failed: file is not valid JSON.");
        return;
      }
      // Server mergeConfig validates + migrates (old/garbage schemas fall back to
      // defaults field-by-field). Send the imported blob as the patch.
      save.mutate(parsed as Partial<Config>, {
        onSuccess: (data) => {
          // Re-seed local state from the validated/migrated result.
          setName(data.config.display_name);
          setTheme(data.config.theme);
          setOrder(builtInOrder(data.config.page_order));
          setEnabled(
            new Set(data.config.enabled_pages.filter((k) => BUILT_PAGES.includes(k))),
          );
          setNotice("Imported + migrated config.");
        },
        onError: (err) => setNotice(`Import failed: ${(err as Error).message}`),
      });
    };
    reader.readAsText(file);
    e.target.value = ""; // allow re-importing the same file
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Make this dashboard yours — name, theme, and which pages show."
        action={
          <Button onClick={onSave} disabled={save.isPending}>
            <Save className="h-4 w-4" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
          {notice}
        </div>
      )}

      <div className="space-y-6">
        <Card>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
            General
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Display name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Dashboard"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Theme
              </span>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
              >
                {THEMES.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Pages
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            Toggle pages on or off and reorder them. The sidebar updates on the
            next load.
          </p>
          <ul className="divide-y divide-slate-100">
            {order.map((key, i) => {
              const meta = PAGE_META[key];
              const locked = ALWAYS_ON.includes(key);
              const isOn = locked || enabled.has(key);
              return (
                <li key={key} className="flex items-center gap-3 py-2.5">
                  <div className="flex flex-col">
                    <Button
                      variant="ghost"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="h-5 px-1 py-0"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => move(i, 1)}
                      disabled={i === order.length - 1}
                      className="h-5 px-1 py-0"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <meta.icon className="h-4 w-4 text-slate-500" />
                  <span className="flex-1 text-sm font-medium text-slate-800">
                    {meta.label}
                    {locked && (
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        (always on)
                      </span>
                    )}
                  </span>
                  <Toggle
                    checked={isOn}
                    disabled={locked}
                    onChange={(v) => toggle(key, v)}
                    label={`Toggle ${meta.label}`}
                  />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Text-to-speech language (optional)
          </h2>
          <p className="mb-3 text-sm text-slate-500">
            Image, speech-to-text and read-text run in your dashboard automatically — no
            setup. Text-to-speech reads English out of the box; add an OpenAI key for
            Hebrew and other languages. The key is stored on the server and never sent to
            the browser.
          </p>
          <div className="mb-3 text-sm">
            Status:{" "}
            {settings.openai_configured ? (
              <span className="font-medium text-emerald-600">Multilingual (OpenAI key set)</span>
            ) : (
              <span className="text-slate-500">English only</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
            <Button
              variant="secondary"
              onClick={onSaveOpenAI}
              disabled={save.isPending || !openaiKey.trim()}
            >
              {settings.openai_configured ? "Update key" : "Save key"}
            </Button>
            {settings.openai_configured && (
              <Button variant="ghost" onClick={onRemoveOpenAI} disabled={save.isPending}>
                Remove
              </Button>
            )}
          </div>
        </Card>

        <StreamsCard />

        <Card>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Backup &amp; transfer
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            Export your configuration to a file, or import one to carry your setup
            to a fresh fork. Imports are validated and migrated automatically.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={onExport}>
              <Download className="h-4 w-4" />
              Export config
            </Button>
            <Button
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={save.isPending}
            >
              <Upload className="h-4 w-4" />
              Import config
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={onImportFile}
              className="hidden"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Data streams (W3, recipient doctrine R2): every owner can SEE their machine
 * connections — key status, last event, dead-letter count — without a terminal.
 * The stream secret is shown exactly once, at mint/rotate.
 */
function StreamsCard() {
  const { data, isLoading, error } = useStreams();
  const entities = useSpecEntities();
  const create = useCreateStream();
  const rotate = useRotateStream();
  const setEnabled = useSetStreamEnabled();
  const [newKey, setNewKey] = useState("");
  const [newEntity, setNewEntity] = useState("");
  const [minted, setMinted] = useState<{ key: string; secret: string } | null>(null);
  const [dlqFor, setDlqFor] = useState<string | null>(null);
  const dlq = useDeadLetters(dlqFor);
  const [note, setNote] = useState<string | null>(null);

  const streams = data?.streams ?? [];
  const entityList = entities.data ?? [];

  function onCreate() {
    setNote(null);
    create.mutate(
      { key: newKey.trim(), entity_key: newEntity },
      {
        onSuccess: (s) => {
          setMinted({ key: s.key, secret: s.secret });
          setNewKey("");
        },
        onError: (e) => setNote((e as Error).message),
      },
    );
  }

  function onRotate(key: string) {
    setNote(null);
    rotate.mutate(key, {
      onSuccess: (s) => setMinted({ key: s.key, secret: s.secret }),
      onError: (e) => setNote((e as Error).message),
    });
  }

  async function copySecret() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.secret);
      setNote("Key copied.");
    } catch {
      setNote("Copy failed — select the key text manually.");
    }
  }

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Data streams
      </h2>
      <p className="mb-4 text-sm text-slate-500">
        Let your own automations push records into your pages. Each stream targets one
        page&apos;s data type and has its own key (sent as the <code>X-Ingest-Key</code>{" "}
        header to <code>/api/ingest/&lt;stream&gt;</code>). Failed payloads land in the
        stream&apos;s dead-letter list — nothing is silently dropped.
      </p>

      {note && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {note}
        </div>
      )}

      {minted && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <div className="mb-1 font-medium text-amber-900">
            Key for “{minted.key}” — shown once, copy it now:
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 text-xs">{minted.secret}</code>
            <Button variant="secondary" onClick={copySecret} className="shrink-0">
              <Copy className="h-4 w-4" /> Copy
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Loading label="Loading streams…" />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : streams.length === 0 ? (
        <p className="mb-4 text-sm text-slate-400">No streams yet.</p>
      ) : (
        <ul className="mb-4 divide-y divide-slate-100">
          {streams.map((s) => (
            <li key={s.key} className="py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <Radio className={`h-4 w-4 ${s.enabled ? "text-emerald-500" : "text-slate-300"}`} />
                <span className="text-sm font-medium text-slate-800">{s.key}</span>
                <span className="text-xs text-slate-400">→ {s.entity_key}</span>
                <span className="flex-1" />
                <span className="text-xs text-slate-500">
                  {s.events} event{s.events === 1 ? "" : "s"} · last:{" "}
                  {s.last_event_at ? s.last_event_at.slice(0, 16).replace("T", " ") : "never"}
                </span>
                <button
                  type="button"
                  onClick={() => setDlqFor(dlqFor === s.key ? null : s.key)}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    s.dead_letters > 0 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {s.dead_letters} failed
                </button>
                <Button variant="ghost" onClick={() => onRotate(s.key)} disabled={rotate.isPending}>
                  <RefreshCw className="h-3.5 w-3.5" /> Rotate
                </Button>
                <Toggle
                  checked={s.enabled === 1}
                  onChange={(v) => setEnabled.mutate({ key: s.key, enabled: v })}
                  label={`Toggle stream ${s.key}`}
                />
              </div>
              {dlqFor === s.key && (
                <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs">
                  {dlq.isLoading ? (
                    "Loading…"
                  ) : (dlq.data?.dead_letters ?? []).length === 0 ? (
                    "No failed payloads."
                  ) : (
                    <ul className="space-y-1">
                      {(dlq.data?.dead_letters ?? []).map((d) => (
                        <li key={d.id} className="overflow-x-auto">
                          <span className="font-medium text-red-700">{d.error}</span>{" "}
                          <span className="text-slate-400">
                            {d.event_uid ?? "-"} · {d.received_at}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Stream name</span>
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="e.g. journal-feed"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">Target page data</span>
          <select
            value={newEntity}
            onChange={(e) => setNewEntity(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
          >
            <option value="">Choose…</option>
            {entityList.map((en) => (
              <option key={en.key} value={en.key}>
                {en.plural} ({en.key})
              </option>
            ))}
          </select>
        </label>
        <Button onClick={onCreate} disabled={create.isPending || !newKey.trim() || !newEntity}>
          {create.isPending ? "Creating…" : "Create stream"}
        </Button>
      </div>
    </Card>
  );
}
