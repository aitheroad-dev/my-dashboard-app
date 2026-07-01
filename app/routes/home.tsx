import { Link } from "react-router";
import { ListTodo, CircleDashed, CheckCircle2, LineChart, Sparkles } from "lucide-react";
import type { Route } from "./+types/home";
import { useMe, useCards, useSettings } from "../lib/api";
import { PageHeader, StatCard, Card, Loading } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Home — My Dashboard" },
    { name: "description", content: "Your personal dashboard overview." },
  ];
}

export default function Home() {
  const me = useMe();
  const settings = useSettings();
  const cards = useCards();

  const name = settings.data?.display_name ?? "My Dashboard";
  const all = cards.data ?? [];
  const todo = all.filter((c) => c.status === "todo");
  const inProgress = all.filter((c) => c.status === "in_progress");
  const done = all.filter((c) => c.status === "done");
  const upNext = [...inProgress, ...todo].slice(0, 5);

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

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="To do" value={todo.length} icon={ListTodo} />
        <StatCard label="In progress" value={inProgress.length} icon={CircleDashed} />
        <StatCard label="Done" value={done.length} icon={CheckCircle2} />
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

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Up next
        </h2>
        <Link to="/board" className="text-sm font-medium text-slate-900 underline">
          Open the board
        </Link>
      </div>
      {cards.isLoading ? (
        <Loading />
      ) : upNext.length === 0 ? (
        <Card className="text-sm text-slate-500">
          Nothing on your board yet.{" "}
          <Link to="/board" className="font-medium text-slate-900 underline">
            Add your first task
          </Link>
          .
        </Card>
      ) : (
        <div className="space-y-2">
          {upNext.map((c) => (
            <Link
              key={c.id}
              to="/board"
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">{c.title}</div>
                {c.notes && <div className="truncate text-slate-500">{c.notes}</div>}
              </div>
              <span className="ml-3 shrink-0 text-xs text-slate-400">
                {c.status === "in_progress" ? "In progress" : "To do"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
