import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router";
import { apiGet } from "../lib/api";
import {
  applyPlan,
  rejectPlan,
  type PendingPlan,
  type SpecEntity,
  type SpecField,
  type SpecPageSummary,
  type SpecRecord,
  type SpecView,
} from "../lib/spec-api";
import { ListView } from "./views";
import { Button } from "./ui";

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function sampleValue(field: SpecField): unknown {
  switch (field.type) {
    case "text":
      return "Example";
    case "long_text":
      return "Example text";
    case "number":
      return 42;
    case "date":
      return todayStr();
    case "checkbox":
      return true;
    case "single_select":
      return field.options?.[0] ?? "Option";
    default:
      return "Example";
  }
}

function plural(count: number, singular: string, pluralLabel: string): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function previewEntity(plan: PendingPlan): SpecEntity {
  return {
    key: "preview",
    singular: plan.preview.entity.singular,
    plural: plan.preview.entity.plural,
    fields: plan.preview.entity.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: false,
      unique: false,
    })),
  };
}

function previewView(plan: PendingPlan, entity: SpecEntity): SpecView {
  const visibleFields =
    plan.preview.view.visible_fields.length > 0
      ? plan.preview.view.visible_fields
      : entity.fields.map((field) => field.key);
  return {
    kind: plan.preview.view.kind,
    name: plan.preview.view.name,
    visible_fields: visibleFields,
  };
}

function previewRecords(fields: SpecField[]): SpecRecord[] {
  const data = Object.fromEntries(fields.map((field) => [field.key, sampleValue(field)]));
  return [
    {
      id: "preview-1",
      data,
      created_at: "",
      updated_at: "",
    },
    {
      id: "preview-2",
      data,
      created_at: "",
      updated_at: "",
    },
  ];
}

export function SpecPreview({
  pendingPlan,
  onResolved,
}: {
  pendingPlan: PendingPlan;
  onResolved: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entity = previewEntity(pendingPlan);
  const view = previewView(pendingPlan, entity);
  const records = previewRecords(entity.fields);
  const impact = [
    plural(pendingPlan.impact.entities, "data type", "data types"),
    plural(pendingPlan.impact.fields, "field", "fields"),
    plural(pendingPlan.impact.views, "view", "views"),
    plural(pendingPlan.impact.pages, "page", "pages"),
  ].join(", ");

  async function approve() {
    if (busy) return;
    setBusy("approve");
    setError(null);
    try {
      await applyPlan(pendingPlan.plan_id);
      await qc.invalidateQueries({ queryKey: ["sd", "pages"] });
      const pages = await apiGet<SpecPageSummary[]>("/api/sd/pages");
      const found =
        pages.find((page) => page.title === pendingPlan.preview.pageTitle) ?? pages.at(-1) ?? null;
      navigate(found ? `/p/${found.key}` : "/");
      onResolved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  async function reject() {
    if (busy) return;
    setBusy("reject");
    setError(null);
    try {
      await rejectPlan(pendingPlan.plan_id);
      onResolved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <div className="font-semibold text-slate-900">{pendingPlan.title}</div>
          <div className="text-xs text-slate-500">Preview: {pendingPlan.preview.pageTitle}</div>
        </div>
      </div>

      <div className="mb-4">
        <ListView entity={entity} view={view} records={records} onOpen={() => undefined} />
      </div>

      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Changes
          </div>
          <ul className="space-y-1 text-slate-700">
            {pendingPlan.actions.map((action) => (
              <li key={action} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Adds {impact}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button type="button" onClick={approve} disabled={Boolean(busy)}>
          <Check className="h-4 w-4" />
          Approve
        </Button>
        <Button type="button" variant="secondary" onClick={reject} disabled={Boolean(busy)}>
          <X className="h-4 w-4" />
          Reject
        </Button>
      </div>
    </div>
  );
}
