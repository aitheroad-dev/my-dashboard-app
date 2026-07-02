import { Check, X } from "lucide-react";
import type { SpecField } from "../../lib/spec-api";
import { StatusBadge } from "../ui";

const INPUT_CLASS =
  "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

function textValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value);
}

function dateInputValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.slice(0, 10);
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return textValue(value);
  const dateOnly = value.slice(0, 10);
  const [y, m, d] = dateOnly.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function FieldDisplay({ field, value }: { field: SpecField; value: unknown }) {
  switch (field.type) {
    case "text":
      return <span>{textValue(value)}</span>;
    case "long_text":
      return <span className="whitespace-pre-wrap">{textValue(value)}</span>;
    case "number":
      return <span>{typeof value === "number" ? value : textValue(value)}</span>;
    case "date":
      return <span>{formatDate(value)}</span>;
    case "checkbox":
      return value === true ? (
        <Check className="h-4 w-4 text-emerald-600" aria-label="Checked" />
      ) : (
        <X className="h-4 w-4 text-slate-400" aria-label="Not checked" />
      );
    case "single_select":
      return textValue(value) ? <StatusBadge status={textValue(value)} /> : <span />;
    default:
      return <span>{textValue(value)}</span>;
  }
}

export function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: SpecField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case "text":
      return (
        <input
          type="text"
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      );
    case "long_text":
      return (
        <textarea
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={`${INPUT_CLASS} resize-none`}
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={typeof value === "number" ? String(value) : textValue(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          className={INPUT_CLASS}
        />
      );
    case "date":
      return (
        <input
          type="date"
          value={dateInputValue(value)}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      );
    case "checkbox":
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
      );
    case "single_select":
      return (
        <select
          value={textValue(value)}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        >
          {!field.required && <option value="" />}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    default:
      return (
        <input
          type="text"
          value={textValue(value)}
          disabled
          className={`${INPUT_CLASS} bg-slate-50 text-slate-500 disabled:cursor-not-allowed`}
        />
      );
  }
}
