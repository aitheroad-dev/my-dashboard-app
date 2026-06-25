import { Link } from "react-router";
import { BookOpen } from "lucide-react";
import type { Route } from "./+types/kb";
import { useKbIndex, useRequireEnabled } from "../lib/api";
import { PageHeader, Card, EmptyState, Loading, ErrorState } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Knowledge Base — My Dashboard" }];
}

export default function Kb() {
  useRequireEnabled("kb");
  const { data, isLoading, error } = useKbIndex();

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        subtitle="Notes, guides, and reference docs for your dashboard."
      />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No docs yet"
          message="Knowledge base documents will appear here."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((doc) => (
            <Link key={doc.slug} to={`/kb-doc/${doc.slug}`}>
              <Card className="h-full transition-colors hover:border-slate-300 hover:bg-slate-50">
                <div className="flex items-start gap-3">
                  <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div>
                    <h3 className="font-medium text-slate-900">{doc.title}</h3>
                    <p className="mt-0.5 text-xs text-slate-400">{doc.slug}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
