import { Info, Lightbulb, CheckCircle2, AlertTriangle, ImageIcon } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Generic Knowledge-Base block renderer (ISC-40). A KB doc stores
 * `{ blocks: Block[] }` JSON; each block has a `type` mapped to a renderer below.
 * 13 generic section types — documentation primitives, not app-specific. All text
 * is rendered as plain React children (no dangerouslySetInnerHTML), so authored
 * content can never inject markup. Unknown types render nothing.
 */

type Block = Record<string, unknown> & { type?: string };

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Records-only view of an items array (drops null/non-object entries → no crash). */
function records(v: unknown): Record<string, unknown>[] {
  return arr(v).filter(isRecord) as Record<string, unknown>[];
}
/** Allow only safe URL schemes for author-controlled hrefs/srcs — blocks
 * javascript:/data: (XSS) on any content authored into kb_docs. Returns null if unsafe. */
function safeUrl(raw: unknown, opts?: { mailto?: boolean }): string | null {
  const s = str(raw).trim();
  if (!s) return null;
  if (s.startsWith("/") || s.startsWith("#")) return s; // relative / anchor
  if (/^https?:\/\//i.test(s)) return s;
  if (opts?.mailto && /^mailto:/i.test(s)) return s;
  return null;
}

const CALLOUT_STYLES: Record<
  string,
  { box: string; icon: typeof Info }
> = {
  info: { box: "border-sky-200 bg-sky-50 text-sky-900", icon: Info },
  tip: { box: "border-violet-200 bg-violet-50 text-violet-900", icon: Lightbulb },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: CheckCircle2 },
  warn: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: AlertTriangle },
};

function Section({ block }: { block: Block }) {
  switch (block.type) {
    case "hero":
      return (
        <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-700 p-6 text-white">
          <h1 className="text-2xl font-semibold tracking-tight">{str(block.title)}</h1>
          {str(block.subtitle) && (
            <p className="mt-1 text-sm text-slate-200">{str(block.subtitle)}</p>
          )}
        </div>
      );

    case "heading": {
      const level = block.level === 3 ? 3 : 2;
      const Tag = level === 3 ? "h3" : "h2";
      return (
        <Tag
          className={cn(
            "font-semibold tracking-tight text-slate-900",
            level === 3 ? "text-base" : "text-xl",
          )}
        >
          {str(block.text)}
        </Tag>
      );
    }

    case "paragraph":
      return <p className="text-sm leading-relaxed text-slate-700">{str(block.text)}</p>;

    case "list": {
      const items = arr(block.items).map((x) => str(x));
      const ordered = block.ordered === true;
      const ListTag = ordered ? "ol" : "ul";
      return (
        <ListTag
          className={cn(
            "space-y-1 pl-5 text-sm text-slate-700",
            ordered ? "list-decimal" : "list-disc",
          )}
        >
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ListTag>
      );
    }

    case "callout": {
      const variant = str(block.variant, "info");
      const s = CALLOUT_STYLES[variant] ?? CALLOUT_STYLES.info;
      const Icon = s.icon;
      return (
        <div className={cn("flex gap-3 rounded-lg border p-4 text-sm", s.box)}>
          <Icon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {str(block.title) && <div className="font-medium">{str(block.title)}</div>}
            <div className={str(block.title) ? "mt-0.5" : ""}>{str(block.text)}</div>
          </div>
        </div>
      );
    }

    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
          <code>{str(block.code)}</code>
        </pre>
      );

    case "quote":
      return (
        <blockquote className="border-l-4 border-slate-300 pl-4 text-sm italic text-slate-600">
          {str(block.text)}
          {str(block.cite) && (
            <footer className="mt-1 text-xs not-italic text-slate-400">
              — {str(block.cite)}
            </footer>
          )}
        </blockquote>
      );

    case "divider":
      return <hr className="border-slate-200" />;

    case "image": {
      const src = safeUrl(block.src);
      return (
        <figure className="space-y-2">
          {src ? (
            <img
              src={src}
              alt={str(block.alt)}
              className="rounded-lg border border-slate-200"
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-400">
              <ImageIcon className="h-6 w-6" />
            </div>
          )}
          {str(block.caption) && (
            <figcaption className="text-xs text-slate-500">{str(block.caption)}</figcaption>
          )}
        </figure>
      );
    }

    case "table": {
      const headers = arr(block.headers).map((x) => str(x));
      const rows = arr(block.rows).map((r) => arr(r).map((x) => str(x)));
      return (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            {headers.length > 0 && (
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 text-slate-700">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "steps": {
      const items = records(block.items);
      return (
        <ol className="space-y-3">
          {items.map((it, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-medium text-white">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-slate-900">{str(it.title)}</div>
                {str(it.text) && (
                  <div className="text-sm text-slate-600">{str(it.text)}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
    }

    case "keyvalue": {
      const items = records(block.items);
      return (
        <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {items.map((it, i) => (
            <div key={i} className="flex justify-between gap-4 px-4 py-2 text-sm">
              <dt className="font-medium text-slate-600">{str(it.key)}</dt>
              <dd className="text-right text-slate-800">{str(it.value)}</dd>
            </div>
          ))}
        </dl>
      );
    }

    case "links": {
      const items = records(block.items);
      return (
        <ul className="space-y-1 text-sm">
          {items.map((it, i) => {
            const href = safeUrl(it.url, { mailto: true });
            const label = str(it.label, str(it.url));
            return (
              <li key={i}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                  >
                    {label}
                  </a>
                ) : (
                  // Unsafe scheme (javascript:, data:, …) → render as inert text.
                  <span className="text-slate-700">{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      );
    }

    default:
      return null;
  }
}

export function BlockRenderer({ blocks }: { blocks: unknown }) {
  // Coerce defensively: a stored `{"blocks": {}}` (valid JSON, non-array) must not
  // crash .map — it renders as empty. Fixes the crash for every caller at once.
  const list = arr(blocks);
  return (
    <div className="space-y-5">
      {list.map((b, i) => (
        <Section key={i} block={isRecord(b) ? (b as Block) : {}} />
      ))}
    </div>
  );
}
