import { useEffect, useRef, useState } from "react";
import { Table, X } from "lucide-react";
import type { SpecEntity, SpecField, SpecRecord, SpecView } from "../../lib/spec-api";
import { FieldDisplay, FieldEditor } from "../fields";
import { Button, Card, EmptyState } from "../ui";

function defaultValueFor(fieldType: string): unknown {
  return fieldType === "checkbox" ? false : "";
}

function fieldsForView(entity: SpecEntity, view: SpecView) {
  const byKey = new Map(entity.fields.map((field) => [field.key, field]));
  return view.visible_fields
    .map((key) => byKey.get(key))
    .filter((field): field is SpecField => Boolean(field));
}

export function ListView({
  entity,
  view,
  records,
  onOpen,
}: {
  entity: SpecEntity;
  view: SpecView;
  records: SpecRecord[];
  onOpen: (record: SpecRecord) => void;
}) {
  const fields = fieldsForView(entity, view);

  if (records.length === 0) {
    return (
      <EmptyState
        icon={Table}
        title="No records yet"
        message={`Add your first ${entity.singular.toLowerCase()} to start using this page.`}
      />
    );
  }

  if (fields.length === 0) {
    return <Card className="text-sm text-slate-500">This view has no visible fields.</Card>;
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {fields.map((field) => (
                <th
                  key={field.key}
                  scope="col"
                  className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {records.map((record) => (
              <tr
                key={record.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(record)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(record);
                  }
                }}
                className="cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
              >
                {fields.map((field) => (
                  <td key={field.key} className="max-w-xs px-4 py-3 text-start text-slate-700">
                    <FieldDisplay field={field} value={record.data[field.key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function DetailView({
  entity,
  record,
  onSave,
  onDelete,
  onClose,
}: {
  entity: SpecEntity;
  record: SpecRecord | null;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of entity.fields) {
      initial[field.key] = record?.data[field.key] ?? defaultValueFor(field.type);
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropDown = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function updateField(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(values);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord() {
    if (!onDelete || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center"
      onMouseDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropDown.current) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={record ? `${entity.singular} details` : `Add ${entity.singular}`}
        className="my-8 w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-500">
            {record ? `${entity.singular} details` : `Add ${entity.singular}`}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          {entity.fields.map((field) => (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                {field.label}
                {field.required && <span className="text-red-500"> *</span>}
              </label>
              <FieldEditor
                field={field}
                value={values[field.key]}
                onChange={(value) => updateField(field.key, value)}
              />
            </div>
          ))}
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2 border-t border-slate-100 pt-4">
          {record && onDelete && (
            <button
              type="button"
              onClick={deleteRecord}
              disabled={busy}
              className="mr-auto rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function renderView({
  entity,
  view,
  records,
  onOpen,
}: {
  entity: SpecEntity;
  view: SpecView;
  records: SpecRecord[];
  onOpen: (record: SpecRecord) => void;
}) {
  switch (view.kind) {
    case "list":
      return <ListView entity={entity} view={view} records={records} onOpen={onOpen} />;
    case "detail":
      return <ListView entity={entity} view={view} records={records} onOpen={onOpen} />;
    default:
      return <ListView entity={entity} view={view} records={records} onOpen={onOpen} />;
  }
}
