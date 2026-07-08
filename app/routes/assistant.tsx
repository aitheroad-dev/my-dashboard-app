import { useState, useEffect } from "react";
import { Sparkles, Send, Check, X, Zap, Brain, Mic, Square, Loader2, Plus } from "lucide-react";
import type { Route } from "./+types/assistant";
import { useRequireEnabled, apiGet, apiPost, callTool, type WhisperResult } from "../lib/api";
import { useRecorder } from "../lib/useRecorder";
import { cn } from "../lib/utils";
import type { PendingPlan } from "../lib/spec-api";
import { SpecPreview } from "../components/SpecPreview";
import { PageHeader, Card, Button } from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Assistant — My Dashboard" }];
}

type Turn = { role: "you" | "assistant"; text: string; meta?: string };
type Mode = "fast" | "reasoning";
type Pending = { tool: string; args: Record<string, unknown>; summary: string; detail: string };
type AssistantRes = {
  answer: string;
  model: string;
  source: string;
  mode?: string;
  pending?: Pending | null;
  pendingPlan?: PendingPlan | null;
  committed?: { tool: string; summary: string } | null;
  conversation_id?: string;
};

export default function Assistant() {
  useRequireEnabled("assistant");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("fast");
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [conversationId, setConversationId] = useState<string>("");

  // The conversation the model sees — mapped from displayed turns.
  const historyFrom = (ts: Turn[]) =>
    ts.map((t) => ({ role: t.role === "you" ? ("user" as const) : ("assistant" as const), content: t.text }));

  // Restore the last conversation on open so it survives a tab close. Client-only
  // (avoids an SSR/hydration mismatch); falls back to a fresh conversation id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{
          conversation_id: string | null;
          turns: { role: "user" | "assistant"; content: string }[];
        }>("/api/assistant/history");
        if (cancelled) return;
        if (res.conversation_id) {
          setConversationId(res.conversation_id);
          setTurns(res.turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "you", text: t.content })));
        } else {
          setConversationId(crypto.randomUUID());
        }
      } catch {
        if (!cancelled) setConversationId((id) => id || crypto.randomUUID());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Start a fresh thread (non-destructive — prior conversations stay in the DB).
  function newChat() {
    if (busy) return;
    setConversationId(crypto.randomUUID());
    setTurns([]);
    setPending(null);
    setPendingPlan(null);
    setError(null);
    setQuestion("");
  }

  // Core send — shared by the text form and the voice (push-to-talk) path, so the
  // transcript can be dispatched directly without waiting on `question` state.
  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setPending(null);
    setPendingPlan(null);
    setBusy(true);
    const nextTurns: Turn[] = [...turns, { role: "you", text: q }];
    setTurns(nextTurns);
    setQuestion("");
    try {
      const res = await apiPost<AssistantRes>("/api/assistant", {
        messages: historyFrom(nextTurns),
        mode,
        conversation_id: conversationId,
      });
      if (res.conversation_id) setConversationId(res.conversation_id);
      setTurns((t) => [...t, { role: "assistant", text: res.answer, meta: `${res.source} · ${res.model}` }]);
      if (res.pending) setPending(res.pending);
      if (res.pendingPlan) setPendingPlan(res.pendingPlan);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function ask(e: React.FormEvent) {
    e.preventDefault();
    void send(question);
  }

  // Push-to-talk: tap the mic to record, tap again to stop. On stop the clip is
  // transcribed on this fork's own `whisper` tool and the text is sent to the
  // assistant automatically — no keyboard needed (works great on a phone).
  const recorder = useRecorder(async (b64) => {
    if (!b64) return; // the recorder already surfaced any mic/encode error
    setError(null);
    setTranscribing(true);
    try {
      const res = await callTool<WhisperResult>("whisper", { audio_base64: b64 });
      const text = (res.text || "").trim();
      if (text) await send(text);
      else setError("I didn't catch any speech — tap the mic and try again.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTranscribing(false);
    }
  });

  async function confirmWrite() {
    if (!pending || busy) return;
    const p = pending;
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      const res = await apiPost<AssistantRes>("/api/assistant", {
        confirm: { tool: p.tool, args: p.args },
        mode,
        conversation_id: conversationId,
      });
      if (res.conversation_id) setConversationId(res.conversation_id);
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
      <PageHeader title="Assistant" subtitle="Ask about your dashboard — or tap the mic and just talk." />

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
        <button
          type="button"
          onClick={newChat}
          disabled={busy || turns.length === 0}
          title="Start a new conversation"
          className="ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1 text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          <Plus className="h-3 w-3" /> New chat
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
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">
              Confirm this exact change
            </div>
            <div className="mb-3 font-medium text-amber-900">{pending.detail || pending.summary}</div>
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

        {pendingPlan && (
          <SpecPreview pendingPlan={pendingPlan} onResolved={() => setPendingPlan(null)} />
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
          placeholder="Ask your dashboard… or tap the mic"
          className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2 text-sm focus:border-slate-500 focus:outline-none"
          aria-label="Ask the assistant"
        />
        <button
          type="button"
          onClick={recorder.recording ? recorder.stop : recorder.start}
          disabled={busy || transcribing}
          aria-label={recorder.recording ? "Stop recording and send" : "Record a voice message"}
          title={recorder.recording ? "Stop & send" : "Speak"}
          className={cn(
            "inline-flex items-center justify-center rounded-lg px-3.5 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            recorder.recording
              ? "bg-red-600 text-white hover:bg-red-500"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          {transcribing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : recorder.recording ? (
            <Square className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </button>
        <Button type="submit" disabled={busy || transcribing || !question.trim()}>
          <Send className="h-4 w-4" />
          Ask
        </Button>
      </form>

      {(recorder.recording || transcribing || recorder.error) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {recorder.recording && (
            <span className="flex items-center gap-1.5 text-red-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
              Listening… tap the square to stop &amp; send (auto-stops at 5 min).
            </span>
          )}
          {transcribing && <span className="text-slate-500">Transcribing…</span>}
          {!recorder.recording && !transcribing && recorder.error && (
            <span className="text-red-600">{recorder.error}</span>
          )}
        </div>
      )}
    </div>
  );
}
