import type { AppEnv } from "../lib/env";
import { getDb } from "../lib/db";
import { getEntityByKey, ingestRecordPlan } from "./spec-store";

/**
 * W3 ingest spine — the machine-write path into a fork (convergence plan §2/§3-v2).
 *
 * Design invariants:
 *  - A stream is DECLARED data (ingest_streams row) bound to a spec ENTITY — the spec
 *    engine is the schema registry; payload validation = the exact same canonicalData
 *    path the owner UI and Assistant writes use. No second schema system.
 *  - Auth is LAYERED: the edge CF Access service token (W2) gets a machine to the
 *    worker; the per-stream key (X-Ingest-Key, SHA-256 hash at rest, constant-time
 *    compare) authorizes THIS stream only. Key shown once at mint/rotate.
 *  - Idempotency: caller-supplied event_uid; (stream_key, event_uid) is the PK of
 *    ingest_events, and the event row + record row + projected values commit in ONE
 *    D1 batch — a replay either pre-checks as duplicate or aborts the whole batch on
 *    the PK, so a record can never exist without its event row (per-event audit).
 *  - Bad payloads land in ingest_dead_letters (visible, bounded, 30-day retention),
 *    never silently dropped.
 */

const STREAM_KEY_RE = /^[a-z][a-z0-9_-]{1,62}$/;
const RESERVED_STREAM_KEYS = new Set(["streams"]);
const MAX_EVENTS_PER_CALL = 100;
const MAX_EVENT_UID_LEN = 200;
const MAX_DLQ_PAYLOAD_CHARS = 8192;
const DLQ_RETENTION_DAYS = 30;

export type StreamRow = {
  key: string;
  entity_key: string;
  enabled: number;
  created_at: string;
  last_event_at: string | null;
};

export type StreamSummary = StreamRow & { events: number; dead_letters: number };

export type IngestEventInput = { event_uid: string; data: Record<string, unknown> };
export type IngestEventResult =
  | { event_uid: string; status: "accepted"; record_id: string }
  | { event_uid: string; status: "duplicate" }
  | { event_uid: string; status: "dead_lettered"; error: string };
export type IngestResult = {
  stream: string;
  accepted: number;
  duplicates: number;
  dead_lettered: number;
  results: IngestEventResult[];
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality over equal-length hex strings (both are local digests). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mintStreamKeySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `ik_${b64}`;
}

function auditStatement(env: AppEnv, tool: string, target: string, actor: string, summary: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO mcp_activity (ts, tool, target, actor, summary) VALUES (?, ?, ?, ?, ?)",
  ).bind(nowIso(), tool, target, actor, summary);
}

export async function createStream(
  env: AppEnv,
  input: { key: string; entity_key: string },
  actor: string,
): Promise<{ key: string; entity_key: string; secret: string }> {
  const key = String(input.key ?? "").trim().toLowerCase();
  if (!STREAM_KEY_RE.test(key)) throw new Error("stream key must be lowercase letters/digits/_- (2-63 chars, letter first)");
  if (RESERVED_STREAM_KEYS.has(key)) throw new Error(`stream key "${key}" is reserved`);
  const entityKey = String(input.entity_key ?? "").trim();
  const entity = await getEntityByKey(env, entityKey);
  if (!entity) throw new Error(`no entity ${entityKey} — create the page first`);

  const existing = await env.DB.prepare("SELECT key FROM ingest_streams WHERE key = ?").bind(key).first();
  if (existing) throw new Error(`stream "${key}" already exists`);

  const secret = mintStreamKeySecret();
  const hash = await sha256Hex(secret);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ingest_streams (key, entity_key, secret_hash, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
    ).bind(key, entityKey, hash, nowIso()),
    auditStatement(env, "ingest.stream.create", key, actor, `create ingest stream ${key} -> ${entityKey}`),
  ]);
  return { key, entity_key: entityKey, secret };
}

export async function rotateStreamKey(env: AppEnv, key: string, actor: string): Promise<{ key: string; secret: string }> {
  const row = await env.DB.prepare("SELECT key FROM ingest_streams WHERE key = ?").bind(key).first();
  if (!row) throw new Error(`no stream ${key}`);
  const secret = mintStreamKeySecret();
  const hash = await sha256Hex(secret);
  await env.DB.batch([
    env.DB.prepare("UPDATE ingest_streams SET secret_hash = ? WHERE key = ?").bind(hash, key),
    auditStatement(env, "ingest.stream.rotate", key, actor, `rotate key for ingest stream ${key}`),
  ]);
  return { key, secret };
}

export async function setStreamEnabled(env: AppEnv, key: string, enabled: boolean, actor: string): Promise<void> {
  const row = await env.DB.prepare("SELECT key FROM ingest_streams WHERE key = ?").bind(key).first();
  if (!row) throw new Error(`no stream ${key}`);
  await env.DB.batch([
    env.DB.prepare("UPDATE ingest_streams SET enabled = ? WHERE key = ?").bind(enabled ? 1 : 0, key),
    auditStatement(env, "ingest.stream.enable", key, actor, `${enabled ? "enable" : "disable"} ingest stream ${key}`),
  ]);
}

export async function listStreams(env: AppEnv): Promise<StreamSummary[]> {
  const sql = getDb(env);
  return sql<StreamSummary>`
    SELECT s.key, s.entity_key, s.enabled, s.created_at, s.last_event_at,
      (SELECT COUNT(*) FROM ingest_events e WHERE e.stream_key = s.key) AS events,
      (SELECT COUNT(*) FROM ingest_dead_letters d WHERE d.stream_key = s.key) AS dead_letters
    FROM ingest_streams s ORDER BY s.created_at ASC
  `;
}

export type DeadLetterRow = { id: number; event_uid: string | null; payload: string; error: string; received_at: string };

export async function listDeadLetters(env: AppEnv, streamKey: string, limit = 50): Promise<DeadLetterRow[]> {
  const sql = getDb(env);
  const capped = Math.max(1, Math.min(200, limit));
  return sql<DeadLetterRow>`
    SELECT id, event_uid, payload, error, received_at FROM ingest_dead_letters
    WHERE stream_key = ${streamKey} ORDER BY id DESC LIMIT ${capped}
  `;
}

function normalizeEvents(body: unknown): IngestEventInput[] {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const list = Array.isArray(raw.events) ? raw.events : raw.event_uid !== undefined ? [raw] : [];
  if (!list.length) throw new Error("body must be {event_uid, data} or {events: [...]}");
  if (list.length > MAX_EVENTS_PER_CALL) throw new Error(`too many events (max ${MAX_EVENTS_PER_CALL} per call)`);
  return list.map((entry, i) => {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const uid = String(e.event_uid ?? "").trim();
    if (!uid || uid.length > MAX_EVENT_UID_LEN) throw new Error(`event ${i + 1}: event_uid required (<=${MAX_EVENT_UID_LEN} chars)`);
    const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null;
    if (!data) throw new Error(`event ${i + 1}: data must be an object`);
    return { event_uid: uid, data };
  });
}

/** 401/403/404 outcomes carry a status; thrown Errors from normalizeEvents map to 400. */
export class IngestAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function ingestEvents(
  env: AppEnv,
  streamKey: string,
  providedKey: string | null,
  body: unknown,
): Promise<IngestResult> {
  const stream = await env.DB.prepare(
    "SELECT key, entity_key, secret_hash, enabled FROM ingest_streams WHERE key = ?",
  ).bind(streamKey).first<{ key: string; entity_key: string; secret_hash: string; enabled: number }>();
  if (!stream) throw new IngestAuthError(404, "no such stream");
  if (!providedKey) throw new IngestAuthError(401, "missing X-Ingest-Key");
  const providedHash = await sha256Hex(providedKey);
  if (!timingSafeEqualHex(providedHash, stream.secret_hash)) throw new IngestAuthError(401, "bad ingest key");
  if (stream.enabled !== 1) throw new IngestAuthError(403, "stream disabled");

  const events = normalizeEvents(body);
  const ts = nowIso();
  const results: IngestEventResult[] = [];
  let accepted = 0;
  let duplicates = 0;
  let deadLettered = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    try {
      const dup = await env.DB.prepare(
        "SELECT 1 FROM ingest_events WHERE stream_key = ? AND event_uid = ? LIMIT 1",
      ).bind(stream.key, event.event_uid).first();
      if (dup) {
        duplicates++;
        results.push({ event_uid: event.event_uid, status: "duplicate" });
        continue;
      }
      const plan = await ingestRecordPlan(env, stream.entity_key, event.data, Date.now() + i);
      // Event row + record + values + mcp_activity row in ONE batch (GPT audit HIGH:
      // the unified audit stream must never miss a committed ingest write).
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO ingest_events (stream_key, event_uid, record_id, received_at) VALUES (?, ?, ?, ?)",
        ).bind(stream.key, event.event_uid, plan.id, ts),
        ...plan.statements,
        auditStatement(
          env,
          "ingest.event",
          `${stream.key}:${event.event_uid}`,
          `ingest:${stream.key}`,
          `ingest event ${event.event_uid} -> ${stream.entity_key} record ${plan.id}`,
        ),
      ]);
      accepted++;
      results.push({ event_uid: event.event_uid, status: "accepted", record_id: plan.id });
    } catch (e) {
      const message = (e as Error).message ?? "unknown error";
      // A racing replay hits the ingest_events PK → whole batch rolled back → duplicate.
      if (/UNIQUE constraint failed: ingest_events/i.test(message)) {
        duplicates++;
        results.push({ event_uid: event.event_uid, status: "duplicate" });
        continue;
      }
      deadLettered++;
      results.push({ event_uid: event.event_uid, status: "dead_lettered", error: message });
      try {
        await env.DB.prepare(
          "INSERT INTO ingest_dead_letters (stream_key, event_uid, payload, error, received_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(stream.key, event.event_uid, JSON.stringify(event.data).slice(0, MAX_DLQ_PAYLOAD_CHARS), message, ts).run();
      } catch {
        // DLQ write is best-effort; the per-event result still reports the failure.
      }
    }
  }

  // Housekeeping — best-effort ONLY for non-audit state (per-event audit rows commit
  // atomically above; GPT audit HIGH fold): freshness stamp + DLQ retention.
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM ingest_dead_letters WHERE received_at < datetime('now', ?)").bind(
        `-${DLQ_RETENTION_DAYS} days`,
      ),
    ];
    if (accepted > 0) {
      statements.push(env.DB.prepare("UPDATE ingest_streams SET last_event_at = ? WHERE key = ?").bind(ts, stream.key));
    }
    await env.DB.batch(statements);
  } catch {
    // Housekeeping failure must not fail an ingest that already committed events.
  }

  return { stream: stream.key, accepted, duplicates, dead_lettered: deadLettered, results };
}
