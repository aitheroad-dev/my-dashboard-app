import { Lock } from "lucide-react";
import type { Route } from "./+types/tools";
import { useToolsStatus, useRequireEnabled } from "../lib/api";
import { PageHeader, Card, Loading, ErrorState } from "../components/ui";
import { ToolsWorkspace } from "../components/tools-panels";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tools — My Dashboard" }];
}

export default function Tools() {
  useRequireEnabled("tools");
  const { data, isLoading, error } = useToolsStatus();

  if (isLoading) return <Loading label="Loading tools…" />;
  if (error) return <ErrorState message={(error as Error).message} />;

  const ready = data?.ready ?? false;

  // ready:false means this viewer can't run the tools (every tool route is
  // owner-gated). On the real product every recipient fork is CF-Access-gated and
  // the owner is signed in, so this only shows on a bare/open-dev or non-owner view.
  if (!ready) {
    return (
      <div>
        <PageHeader
          title="Tools"
          subtitle="Create images, transcribe speech, generate speech, and read text from photos — all in one place."
        />
        <Card className="flex items-center gap-3 border-amber-200 bg-amber-50 text-amber-800">
          <Lock className="h-5 w-5 shrink-0" />
          <div className="text-sm">
            Sign in to this dashboard (Cloudflare Access) as its owner to use the tools — they run on
            this dashboard&rsquo;s own account.
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Tools"
        subtitle="Create images, transcribe speech, generate speech, and read text from photos — all in one place."
      />

      <ToolsWorkspace />
    </div>
  );
}
