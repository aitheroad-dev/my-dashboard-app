import { useState } from "react";
import { Sparkles, Send, Check, X, Zap, Brain } from "lucide-react";
import type { Route } from "./+types/assistant";
import { useRequireEnabled, apiPost } from "../lib/api";
import { PageHeader, Card, Button } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Assistant — My Dashboard" }];
}

type Turn = { role: "you" | "assistant"; text: string; meta?: string };
type Mode = "fast" | "reasoning";
type Pending = { tool: string; args: Record<string, unknown>; summary: string };
type AssistantRes = {
  answer: string;
  model: string;
  source: string;
  mode?: string;
  pending?: Pending | null;
  committed?: { tool: string; summary: string } | null;
};

export default function Assistant() {
  useRequireEnabled("assistant");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("fast");
  const [pending, setPending] = useState<Pending | null>(null);

  // The conversation the model sees — mapped from displayed turns.
  const historyFrom = (ts: Turn[]) =>
    ts.map((t) => ({ role: t.role === "you" ? ("user" as const) : ("assistant" as const), content: t.text }));

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setError(null);
    setPending(null);
    setBusy(true);
    const nextTurns: Turn[] = [...turns, { role: "you", text: q }];
    setTurns(nextTurns);
    setQuestion("");
    try {
      const res = await apiPost<AssistantRes>("/api/assistant", { messages: historyFrom(nextTurns), mode });
      setTurns((t) => [...t, { role: "assistant", text: res.answer, meta: `${res.source} · ${res.model}` }]);
      if (res.pending) setPending(res.pending);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmWrite() {
    if (!pending || busy) return;
    const p = pending;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const res = await apiPost<AssistantRes>("/api/assistant", { confirm: { tool: p.tool, args: p.args }, mode });
      setTurns((t) => [...t, { role: "assistant", text: res.answer, meta: `${res.source} · ${res.model}` }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancelWrite() {
    setPending(null);
    setTurns((t) => [...t, { role: "assistant", text: "Okay — cancelled. Nothing was changed." }]);
  }

  return (
    <div>
      <PageHeader title="Assistant" subtitle="Ask about your dashboard — or ask it to add and move board cards for you." />

      <div className="mb-3 flex items-center gap-1 text-xs">
        <span className="mr-1 text-slate-500">Mode:</span>
        <button
          type="button"
          onClick={() => setMode("fast")}
          className={
            "inline-flex items-center gap-1 rounded-full px-3 py-1 " +
            (mode === "fast" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")
          }
        >
          <Zap className="h-3 w-3" /> Fast
        </button>
        <button
          type="button"
          onClick={() => setMode("reasoning")}
          className={
            "inline-flex items-center gap-1 rounded-full px-3 py-1 " +
            (mode === "reasoning" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")
          }
        >
          <Brain className="h-3 w-3" /> Deep reasoning
        </button>
      </div>

      <Card className="mb-4 min-h-[140px] space-y-4">
        {turns.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Sparkles className="h-4 w-4 shrink-0" />
            Try &ldquo;What&rsquo;s on my board?&rdquo; or &ldquo;Add a card called Buy milk to To Do.&rdquo;
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={t.role === "you" ? "text-right" : "text-left"}>
              <div
                className={
                  "inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm " +
                  (t.role === "you" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800")
                }
              >
                {t.text}
              </div>
              {t.meta && <div className="mt-1 text-xs text-slate-400">{t.meta}</div>}
            </div>
          ))
        )}

        {pending && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
            <div className="mb-2 font-medium text-amber-900">Confirm this change</div>
            <div className="mb-3 text-amber-800">{pending.summary}</div>
            <div className="flex gap-2">
              <Button type="button" onClick={confirmWrite} disabled={busy}>
                <Check className="h-4 w-4" /> Confirm
              </Button>
              <button
                type="button"
                onClick={cancelWrite}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
            </div>
          </div>
        )}

        {busy && <div className="text-sm text-slate-400">Thinking…</div>}
      </Card>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={ask} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask your dashboard…"
          className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-slate-500 focus:outline-none"
          aria-label="Ask the assistant"
        />
        <Button type="submit" disabled={busy || !question.trim()}>
          <Send className="h-4 w-4" />
          Ask
        </Button>
      </form>
    </div>
  );
}
