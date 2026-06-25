import { Link } from "react-router";
import { FolderKanban, Target, LineChart, Sparkles } from "lucide-react";
import type { Route } from "./+types/home";
import {
  useMe,
  useProjects,
  useGoals,
  useSettings,
} from "../lib/api";
import { PageHeader, StatCard, Card, StatusBadge, Loading } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Home — My Dashboard" },
    { name: "description", content: "Your personal dashboard overview." },
  ];
}

export default function Home() {
  const me = useMe();
  const settings = useSettings();
  const projects = useProjects();
  const goals = useGoals();

  const name = settings.data?.display_name ?? "My Dashboard";
  const activeProjects =
    projects.data?.filter((p) => p.status === "active").length ?? 0;
  const activeGoals = goals.data?.filter((g) => g.status === "active").length ?? 0;
  const recentProjects = projects.data?.slice(0, 4) ?? [];

  return (
    <div>
      <PageHeader
        title={name}
        subtitle={
          me.data
            ? `Signed in as ${me.data.email}${me.data.mode === "open-dev" ? " (open dev mode)" : ""}`
            : "Your personal dashboard"
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Active projects" value={activeProjects} icon={FolderKanban} />
        <StatCard label="Active goals" value={activeGoals} icon={Target} />
        <StatCard label="Portfolio" value="—" icon={LineChart} />
      </div>

      <Card className="mb-6 flex items-start gap-4 border-slate-900/10 bg-slate-900 text-white">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" />
        <div>
          <h3 className="font-medium">Welcome to your dashboard</h3>
          <p className="mt-1 text-sm text-slate-300">
            This fork is yours — its own database, files, and settings, isolated
            from everyone else’s. Everything below starts with example content
            you can edit or delete.
          </p>
        </div>
      </Card>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Recent projects
      </h2>
      {projects.isLoading ? (
        <Loading />
      ) : recentProjects.length === 0 ? (
        <Card className="text-sm text-slate-500">
          No projects yet.{" "}
          <Link to="/projects" className="font-medium text-slate-900 underline">
            Go to Projects
          </Link>
          .
        </Card>
      ) : (
        <div className="space-y-2">
          {recentProjects.map((p) => (
            <Link
              key={p.id}
              to="/projects"
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">{p.name}</div>
                {p.mission && (
                  <div className="truncate text-slate-500">{p.mission}</div>
                )}
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-3">
                <span className="text-xs text-slate-400">
                  {p.goal_count} goal{p.goal_count === 1 ? "" : "s"}
                </span>
                <StatusBadge status={p.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
