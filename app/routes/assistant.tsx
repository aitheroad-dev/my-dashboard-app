import { useState } from "react";
import { Sparkles, Send } from "lucide-react";
import type { Route } from "./+types/assistant";
import { useRequireEnabled, apiPost } from "../lib/api";
import { PageHeader, Card, Button } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Assistant — My Dashboard" }];
}

type Turn = { role: "you" | "assistant"; text: string; meta?: string };

export default function Assistant() {
  useRequireEnabled("assistant");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setError(null);
    setBusy(true);
    setTurns((t) => [...t, { role: "you", text: q }]);
    setQuestion("");
    try {
      const res = await apiPost<{ answer: string; model: string; source: string }>("/api/assistant", {
        question: q,
      });
      setTurns((t) => [...t, { role: "assistant", text: res.answer, meta: `${res.source} · ${res.model}` }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Assistant" subtitle="Ask about your dashboard. Runs on Cloudflare Workers AI by default." />

      <Card className="mb-4 min-h-[140px] space-y-4">
        {turns.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Sparkles className="h-4 w-4 shrink-0" />
            Ask something like &ldquo;What projects do I have?&rdquo; or &ldquo;Summarize my goals.&rdquo;
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
