import { FolderKanban } from "lucide-react";
import type { Route } from "./+types/projects";
import { useProjects, useRequireEnabled } from "../lib/api";
import {
  PageHeader,
  Card,
  StatusBadge,
  EmptyState,
  Loading,
  ErrorState,
} from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Projects — My Dashboard" }];
}

export default function Projects() {
  useRequireEnabled("projects");
  const { data, isLoading, error } = useProjects();

  return (
    <div>
      <PageHeader title="Projects" subtitle="The things you’re actively building." />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          message="Projects you add will show up here, each with its goals."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((p) => (
            <Card key={p.id} className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium text-slate-900">{p.name}</h3>
                <StatusBadge status={p.status} />
              </div>
              {p.mission && (
                <p className="text-sm text-slate-500">{p.mission}</p>
              )}
              <div className="mt-auto pt-2 text-xs text-slate-400">
                {p.goal_count} goal{p.goal_count === 1 ? "" : "s"}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
