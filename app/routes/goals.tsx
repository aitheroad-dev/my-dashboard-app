import { Target } from "lucide-react";
import type { Route } from "./+types/goals";
import { useGoals, useRequireEnabled } from "../lib/api";
import {
  PageHeader,
  Card,
  StatusBadge,
  EmptyState,
  Loading,
  ErrorState,
} from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Goals — My Dashboard" }];
}

export default function Goals() {
  useRequireEnabled("goals");
  const { data, isLoading, error } = useGoals();

  return (
    <div>
      <PageHeader title="Goals" subtitle="What you’re aiming at, by project." />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          message="Goals you set will appear here, linked to their project."
        />
      ) : (
        <div className="space-y-2">
          {data.map((g) => (
            <Card key={g.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="font-medium text-slate-900">{g.title}</h3>
                {g.description && (
                  <p className="mt-0.5 text-sm text-slate-500">{g.description}</p>
                )}
                {g.project_name && (
                  <p className="mt-1 text-xs text-slate-400">
                    Project: {g.project_name}
                  </p>
                )}
              </div>
              <StatusBadge status={g.status} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
