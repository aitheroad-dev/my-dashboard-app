import { Link } from "react-router";
import { Wrench, CheckCircle2, AlertTriangle } from "lucide-react";
import type { Route } from "./+types/tools";
import { useToolsStatus, useRequireEnabled } from "../lib/api";
import { PageHeader, Card, EmptyState, Loading, ErrorState } from "../components/ui";
import { ToolsWorkspace } from "../components/tools-panels";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tools — My Dashboard" }];
}

export default function Tools() {
  useRequireEnabled("tools");
  const { data, isLoading, error } = useToolsStatus();

  if (isLoading) return <Loading label="Checking tools…" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  // Not configured → never blank; guide the owner to Settings (graceful gate).
  if (!data || !data.configured) {
    return (
      <div>
        <PageHeader title="Tools" subtitle="Image, speech-to-text, text-to-speech, and OCR." />
        <EmptyState
          icon={Wrench}
          title="Tools not configured"
          message="Add your pai-tools key in Settings to turn on image generation, speech-to-text, text-to-speech, and OCR. Your key stays on the server and is never exposed to the browser."
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
        subtitle="Create images, transcribe speech, generate speech, and read text from photos — all in one place."
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
            ? "Connected. Everything runs through your server-side key — you never have to touch it."
            : "A key is set, but pai-tools rejected it. Update it in Settings — tools below won't work until it's valid."}
        </div>
      </Card>

      <ToolsWorkspace />
    </div>
  );
}
