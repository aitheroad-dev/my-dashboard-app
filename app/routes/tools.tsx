import { Link } from "react-router";
import { Wrench, CheckCircle2, AlertTriangle } from "lucide-react";
import type { Route } from "./+types/tools";
import { useToolsStatus, useRequireEnabled } from "../lib/api";
import { PageHeader, Card, EmptyState, Loading, ErrorState } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tools — My Dashboard" }];
}

export default function Tools() {
  useRequireEnabled("tools");
  const { data, isLoading, error } = useToolsStatus();

  if (isLoading) return <Loading label="Checking tools…" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  // Not configured → never blank; guide the owner to Settings.
  if (!data || !data.configured) {
    return (
      <div>
        <PageHeader title="Tools" subtitle="Image, speech-to-text, text-to-speech, and OCR." />
        <EmptyState
          icon={Wrench}
          title="Tools not configured"
          message="Add your pai-tools key in Settings to connect image generation, speech-to-text, text-to-speech, and OCR. Your key stays on the server and is never exposed to the browser."
          action={
            <Link
              to="/settings"
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Open Settings
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Tools"
        subtitle="Connected through your server-side key — calls proxy through this dashboard."
      />

      <Card
        className={
          data.valid
            ? "mb-6 flex items-center gap-3 border-emerald-200 bg-emerald-50 text-emerald-800"
            : "mb-6 flex items-center gap-3 border-amber-200 bg-amber-50 text-amber-800"
        }
      >
        {data.valid ? (
          <CheckCircle2 className="h-5 w-5 shrink-0" />
        ) : (
          <AlertTriangle className="h-5 w-5 shrink-0" />
        )}
        <div className="text-sm">
          {data.valid
            ? "Connected to pai-tools. Your key is valid."
            : "A key is set, but pai-tools rejected it. Update it in Settings."}
        </div>
      </Card>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Available tools
      </h2>
      {!data.tools || data.tools.length === 0 ? (
        <Card className="text-sm text-slate-500">No tools reported by the service.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.tools.map((t) => (
            <Card key={t.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Wrench className="h-4 w-4 text-slate-400" />
                <h3 className="font-medium capitalize text-slate-900">{t.name}</h3>
              </div>
              <p className="text-sm text-slate-500">{t.description}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
