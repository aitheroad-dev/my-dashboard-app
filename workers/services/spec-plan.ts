import type { AppEnv } from "../lib/env";
import { MAX_PLAN_ACTIONS, type Plan, validateSpec } from "../lib/spec/schema";
import {
  entityInsertPlan,
  fieldInsertStatement,
  getEntityByKey,
  listEntities,
  pageInsertStatement,
  viewInsertStatement,
} from "./spec-store";

const VALIDATOR_VERSION = 1;
const PLAN_TTL_MS = 30 * 60 * 1000;

export type PlanImpact = {
  entities: number;
  fields: number;
  views: number;
  pages: number;
};

export type ApplyResult = {
  plan_id: string;
  status: "applied";
  impact: PlanImpact;
  applied_at: string;
};

type PendingPlanRow = {
  id: string;
  plan_json: string;
  schema_hash: string;
  impact_json: string;
  actor: string;
  status: string;
  expires_at: string;
  applied_at: string | null;
};

function nowIso(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function impactFor(plan: Plan): PlanImpact {
  return plan.actions.reduce<PlanImpact>(
    (impact, action) => {
      if (action.type === "add_entity") {
        impact.entities += 1;
        impact.fields += action.entity.fields.length;
      } else if (action.type === "add_field") {
        impact.fields += 1;
      } else if (action.type === "add_view") {
        impact.views += 1;
      } else if (action.type === "add_page") {
        impact.pages += 1;
      }
      return impact;
    },
    { entities: 0, fields: 0, views: 0, pages: 0 },
  );
}

function touchedEntityKeys(plan: Plan): string[] {
  const keys = new Set<string>();
  for (const action of plan.actions) {
    if (action.type === "add_entity") keys.add(action.entity.key);
    if (action.type === "add_field" || action.type === "add_view") keys.add(action.entity_key);
    if (action.type === "add_page") {
      for (const view of action.page.views) keys.add(view.entity_key);
    }
  }
  return [...keys].sort();
}

async function schemaHash(env: AppEnv, plan: Plan): Promise<string> {
  const entities = await listEntities(env);
  const readSet = [];
  for (const key of touchedEntityKeys(plan)) {
    const existing = await getEntityByKey(env, key);
    readSet.push({
      key,
      entity: existing?.entity ?? null,
      fields: existing?.fields ?? [],
    });
  }
  return sha256Hex(
    stableStringify({
      validator: VALIDATOR_VERSION,
      touched: readSet,
      uniqueness_namespace: entities.map((entity) => entity.key).sort(),
      actions: plan.actions.map((action) => action.type),
    }),
  );
}

function parsePlan(planJson: string): Plan {
  const parsed = JSON.parse(planJson) as unknown;
  const v = validateSpec(parsed);
  if (!v.ok) throw new Error("invalid plan: " + v.errors.join("; "));
  if (v.value.actions.length > MAX_PLAN_ACTIONS) throw new Error("too many plan actions");
  return v.value;
}

export async function proposePlan(
  env: AppEnv,
  planInput: unknown,
  actor: string,
): Promise<{ plan_id: string; schema_hash: string; impact: PlanImpact }> {
  const v = validateSpec(planInput);
  if (!v.ok) throw new Error("invalid plan: " + v.errors.join("; "));
  if (v.value.actions.length > MAX_PLAN_ACTIONS) throw new Error("too many plan actions");

  // Cap unexpired pending plans (GPT audit MED): proposals are non-destructive and
  // TTL'd, but without a ceiling a prompt-injected assistant turn could spam rows.
  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sd_pending_plans WHERE status = 'pending' AND expires_at > ?",
  ).bind(nowIso()).first<{ n: number }>();
  if ((pendingCount?.n ?? 0) >= 10) {
    throw new Error("too many pending proposals — approve or reject some first");
  }

  const planId = crypto.randomUUID();
  const planJson = JSON.stringify(v.value);
  const hash = await schemaHash(env, v.value);
  const impact = impactFor(v.value);
  const createdAt = nowIso();
  const expiresAt = nowIso(new Date(Date.now() + PLAN_TTL_MS));

  // Pending-plan insert + its audit row commit atomically (GPT audit MED: the propose
  // step previously left no mcp_activity trace).
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sd_pending_plans (id, plan_json, schema_hash, impact_json, actor, status, idempotency_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(planId, planJson, hash, JSON.stringify(impact), actor, "pending", crypto.randomUUID(), createdAt, expiresAt),
    env.DB.prepare("INSERT INTO mcp_activity (ts, tool, target, actor, summary) VALUES (?, ?, ?, ?, ?)").bind(
      createdAt,
      "spec.plan.propose",
      planId,
      actor,
      `propose plan (${v.value.actions.length} action${v.value.actions.length === 1 ? "" : "s"})`,
    ),
  ]);

  return { plan_id: planId, schema_hash: hash, impact };
}

export async function applyPlan(env: AppEnv, planId: string, actor: string): Promise<ApplyResult> {
  const row = await env.DB.prepare(
    "SELECT id, plan_json, schema_hash, impact_json, actor, status, expires_at, applied_at FROM sd_pending_plans WHERE id = ? LIMIT 1",
  )
    .bind(planId)
    .first<PendingPlanRow>();
  if (!row) throw new Error(`no plan ${planId}`);

  const storedImpact = JSON.parse(row.impact_json) as PlanImpact;
  if (row.status === "applied") {
    return { plan_id: planId, status: "applied", impact: storedImpact, applied_at: row.applied_at ?? "" };
  }
  if (row.status === "rejected") throw new Error("plan was rejected");
  if (row.status === "expired" || Date.now() > Date.parse(row.expires_at)) {
    if (row.status === "pending") {
      await env.DB.prepare("UPDATE sd_pending_plans SET status = ? WHERE id = ?").bind("expired", planId).run();
    }
    throw new Error("plan expired");
  }

  const plan = parsePlan(row.plan_json);
  const hash = await schemaHash(env, plan);
  if (hash !== row.schema_hash) throw new Error("plan_drifted");

  const statements: D1PreparedStatement[] = [];
  // Entities created within THIS plan: key -> {id, fieldCount}. add_field/add_view
  // referencing a same-plan entity resolve here first (the entity's INSERT is queued
  // in this batch and not yet in the DB), then fall back to already-persisted entities.
  const inPlanEntities = new Map<string, { id: string; fieldCount: number }>();

  async function resolveEntity(key: string): Promise<{ id: string; fieldCount: number }> {
    const local = inPlanEntities.get(key);
    if (local) return local;
    const persisted = await getEntityByKey(env, key);
    if (!persisted) throw new Error(`no entity ${key}`);
    return { id: persisted.entity.id, fieldCount: persisted.fields.length };
  }

  for (const action of plan.actions) {
    if (action.type === "add_entity") {
      const built = entityInsertPlan(env, action.entity);
      statements.push(...built.statements);
      inPlanEntities.set(action.entity.key, { id: built.id, fieldCount: action.entity.fields.length });
    } else if (action.type === "add_field") {
      const target = await resolveEntity(action.entity_key);
      statements.push(fieldInsertStatement(env, target.id, action.field, target.fieldCount));
      target.fieldCount += 1;
      inPlanEntities.set(action.entity_key, target);
    } else if (action.type === "add_view") {
      const target = await resolveEntity(action.entity_key);
      statements.push(viewInsertStatement(env, target.id, action.view, Date.now()));
    } else if (action.type === "add_page") {
      statements.push(pageInsertStatement(env, action.page, Date.now()));
    }
  }

  const appliedAt = nowIso();
  const impact = impactFor(plan);
  statements.push(env.DB.prepare("UPDATE sd_pending_plans SET status = ?, applied_at = ? WHERE id = ?").bind("applied", appliedAt, planId));
  statements.push(
    env.DB.prepare("INSERT INTO mcp_activity (ts, tool, target, actor, summary) VALUES (?, ?, ?, ?, ?)").bind(
      appliedAt,
      "spec.plan.apply",
      `plan:${planId}:${row.plan_json}`,
      actor,
      `applied plan ${planId}: ${row.plan_json}`,
    ),
  );

  await env.DB.batch(statements);
  return { plan_id: planId, status: "applied", impact, applied_at: appliedAt };
}

export async function rejectPlan(
  env: AppEnv,
  planId: string,
  actor: string,
): Promise<{ plan_id: string; status: "rejected" }> {
  const row = await env.DB.prepare("SELECT id, status FROM sd_pending_plans WHERE id = ? LIMIT 1")
    .bind(planId)
    .first<{ id: string; status: string }>();
  if (!row) throw new Error(`no plan ${planId}`);
  if (row.status === "applied") throw new Error("plan already applied");

  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE sd_pending_plans SET status = ? WHERE id = ?").bind("rejected", planId),
    env.DB.prepare("INSERT INTO mcp_activity (ts, tool, target, actor, summary) VALUES (?, ?, ?, ?, ?)").bind(
      ts,
      "spec.plan.reject",
      `plan:${planId}`,
      actor,
      `rejected plan ${planId}`,
    ),
  ]);
  return { plan_id: planId, status: "rejected" };
}
