import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { Route } from "./+types/kb-doc";
import { useKbDoc, useRequireEnabled } from "../lib/api";
import { Loading, ErrorState, Card } from "../components/ui";
import { BlockRenderer } from "../components/BlockRenderer";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Doc — My Dashboard" }];
}

export default function KbDoc() {
  useRequireEnabled("kb");
  const { slug } = useParams();
  const { data, isLoading, error } = useKbDoc(slug);

  return (
    <div>
      <Link
        to="/kb"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Knowledge Base
      </Link>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data ? (
        <Card className="text-sm text-slate-500">Document not found.</Card>
      ) : (
        <article>
          <BlockRenderer blocks={data.blocks?.blocks ?? []} />
        </article>
      )}
    </div>
  );
}
