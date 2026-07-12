import { getDb } from "../lib/db";
import type { AppEnv } from "../lib/env";
import type {
  EntitySpec,
  FieldSpec,
  FilterSpec,
  PageSpec,
  SortSpec,
  ViewSpec,
} from "../lib/spec/schema";
import { clampLimit } from "./store";

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_FIELD_STRING_LENGTH = 16 * 1024;

export type EntityRow = {
  id: string;
  key: string;
  singular: string;
  plural: string;
  icon: string | null;
  spec_version: number;
  position: number;
  created_at: string;
  updated_at: string;
};

export type FieldRow = {
  id: string;
  entity_id: string;
  key: string;
  label: string;
  type: string;
  config: string;
  required: number;
  position: number;
  created_at: string;
};

export type RecordRow = {
  id: string;
  entity_id: string;
  data: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
};

export type RecordListQuery = { sort?: SortSpec; filter?: FilterSpec; limit?: number };
export type PageSummary = { key: string; title: string; icon: string | null; entity_key: string };
export type PageDetail = {
  page: { key: string; title: string; icon: string | null };
  entity: {
    key: string;
    singular: string;
    plural: string;
    fields: Array<{ key: string; label: string; type: string; required: boolean; unique: boolean; options?: string[] }>;
  };
  view: { kind: string; name: string; visible_fields: string[]; sort?: SortSpec };
  records: Array<{ id: string; data: Record<string, unknown>; created_at: string; updated_at: string }>;
};

type StoredFieldConfig = {
  options?: string[];
  unique?: boolean;
};

type PageRow = {
  key: string;
  title: string;
  icon: string | null;
  body: string;
};

type ViewRow = {
  kind: string;
  name: string;
  config: string;
};

type PageViewRef = {
  entity_key: string;
  view_key: string;
};

type StoredViewConfig = {
  visible_fields: string[];
  sort?: SortSpec;
  filter?: FilterSpec;
};

type ProjectedValue = {
  valueText: string | null;
  valueNum: number | null;
};

type RawRecordRow = Omit<RecordRow, "data"> & { data: string };

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function fieldConfig(field: FieldSpec): string {
  const config: StoredFieldConfig = {};
  if (field.type === "single_select") {
    const options = field.config && "options" in field.config ? field.config.options : [];
    config.options = options;
  }
  if (field.unique) config.unique = true;
  return JSON.stringify(config);
}

function parseFieldConfig(field: FieldRow): StoredFieldConfig {
  try {
    const parsed = JSON.parse(field.config) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const config = parsed as StoredFieldConfig;
    return {
      options: Array.isArray(config.options) ? config.options.filter((v) => typeof v === "string") : undefined,
      unique: config.unique === true,
    };
  } catch {
    return {};
  }
}

function parsePageRefs(body: string): PageViewRef[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((ref) => {
        if (!ref || typeof ref !== "object") return null;
        const candidate = ref as { entity_key?: unknown; view_key?: unknown };
        return typeof candidate.entity_key === "string" && typeof candidate.view_key === "string"
          ? { entity_key: candidate.entity_key, view_key: candidate.view_key }
          : null;
      })
      .filter((ref): ref is PageViewRef => ref !== null);
  } catch {
    return [];
  }
}

function parseViewConfig(config: string): StoredViewConfig {
  try {
    const parsed = JSON.parse(config) as unknown;
    if (!parsed || typeof parsed !== "object") return { visible_fields: [] };
    const raw = parsed as { visible_fields?: unknown; sort?: unknown; filter?: unknown };
    return {
      visible_fields: Array.isArray(raw.visible_fields)
        ? raw.visible_fields.filter((field) => typeof field === "string")
        : [],
      sort: raw.sort && typeof raw.sort === "object" ? (raw.sort as SortSpec) : undefined,
      filter: raw.filter && typeof raw.filter === "object" ? (raw.filter as FilterSpec) : undefined,
    };
  } catch {
    return { visible_fields: [] };
  }
}

function assertStringBounds(value: string, key: string): void {
  if (value.length > MAX_FIELD_STRING_LENGTH) {
    throw new Error(`field ${key} is too long`);
  }
}

function coerceFieldValue(field: FieldRow, value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    if (field.required) throw new Error(`field ${field.key} is required`);
    return null;
  }

  switch (field.type) {
    case "text":
    case "long_text": {
      if (typeof value !== "string") throw new Error(`field ${field.key} must be text`);
      assertStringBounds(value, field.key);
      return value;
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (!Number.isFinite(n)) throw new Error(`field ${field.key} must be a number`);
      return n;
    }
    case "date": {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`field ${field.key} must be a date`);
      }
      const millis = Date.parse(String(value));
      if (!Number.isFinite(millis)) throw new Error(`field ${field.key} must be a valid date`);
      return String(value);
    }
    case "checkbox": {
      if (typeof value !== "boolean") throw new Error(`field ${field.key} must be a checkbox`);
      return value;
    }
    case "single_select": {
      if (typeof value !== "string") throw new Error(`field ${field.key} must be an option`);
      assertStringBounds(value, field.key);
      const options = parseFieldConfig(field).options ?? [];
      if (!options.includes(value)) throw new Error(`field ${field.key} must be one of its options`);
      return value;
    }
    default:
      throw new Error(`field ${field.key} has unsupported type`);
  }
}

function projectValue(field: FieldRow, value: unknown): ProjectedValue {
  if (value === null || value === undefined) return { valueText: null, valueNum: null };

  switch (field.type) {
    case "number":
      return { valueText: null, valueNum: Number(value) };
    case "checkbox":
      return { valueText: null, valueNum: value === true ? 1 : 0 };
    case "date": {
      const millis = Date.parse(String(value));
      return { valueText: null, valueNum: millis };
    }
    case "text":
    case "long_text":
    case "single_select":
      return { valueText: String(value), valueNum: null };
    default:
      return { valueText: null, valueNum: null };
  }
}

function canonicalData(fields: FieldRow[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = new Set(fields.map((field) => field.key));

  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`unknown field ${key}`);
  }

  for (const field of fields) {
    const value = coerceFieldValue(field, input[field.key]);
    if (value !== null) out[field.key] = value;
  }

  const json = JSON.stringify(out);
  if (new TextEncoder().encode(json).byteLength > MAX_RECORD_BYTES) {
    throw new Error("record is too large");
  }
  return out;
}

function parseRecord(row: RawRecordRow): RecordRow {
  return {
    ...row,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

function auditStatement(env: AppEnv, tool: string, target: string, actor: string, summary: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO mcp_activity (ts, tool, target, actor, summary) VALUES (?, ?, ?, ?, ?)",
  ).bind(nowIso(), tool, target, actor, summary);
}

function recordValueStatements(
  env: AppEnv,
  entityId: string,
  recordId: string,
  fields: FieldRow[],
  data: Record<string, unknown>,
): D1PreparedStatement[] {
  return fields
    .filter((field) => data[field.key] !== undefined)
    .map((field) => {
      const projected = projectValue(field, data[field.key]);
      return env.DB.prepare(
        "INSERT INTO sd_record_values (entity_id, field_id, record_id, value_text, value_num, type) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(entityId, field.id, recordId, projected.valueText, projected.valueNum, field.type);
    });
}

async function assertUniqueValues(
  env: AppEnv,
  entityId: string,
  fields: FieldRow[],
  data: Record<string, unknown>,
  excludeRecordId?: string,
): Promise<void> {
  for (const field of fields) {
    if (!parseFieldConfig(field).unique || data[field.key] === undefined) continue;
    const projected = projectValue(field, data[field.key]);
    if (projected.valueText === null && projected.valueNum === null) continue;

    const sql =
      projected.valueText !== null
        ? "SELECT record_id FROM sd_record_values WHERE entity_id = ? AND field_id = ? AND value_text = ? LIMIT 1"
        : "SELECT record_id FROM sd_record_values WHERE entity_id = ? AND field_id = ? AND value_num = ? LIMIT 1";
    const value = projected.valueText !== null ? projected.valueText : projected.valueNum;
    const found = await env.DB.prepare(sql).bind(entityId, field.id, value).first<{ record_id: string }>();
    if (found && found.record_id !== excludeRecordId) {
      throw new Error(`field ${field.key} must be unique`);
    }
  }
}

export async function listEntities(env: AppEnv): Promise<EntityRow[]> {
  const sql = getDb(env);
  return sql<EntityRow>`SELECT id, key, singular, plural, icon, spec_version, position, created_at, updated_at
    FROM sd_entities ORDER BY position, created_at`;
}

export async function getEntityByKey(
  env: AppEnv,
  key: string,
): Promise<{ entity: EntityRow; fields: FieldRow[] } | null> {
  const sql = getDb(env);
  const entities = await sql<EntityRow>`SELECT id, key, singular, plural, icon, spec_version, position, created_at, updated_at
    FROM sd_entities WHERE key = ${key} LIMIT 1`;
  const entity = entities[0];
  if (!entity) return null;
  const fields = await sql<FieldRow>`SELECT id, entity_id, key, label, type, config, required, position, created_at
    FROM sd_fields WHERE entity_id = ${entity.id} ORDER BY position, created_at`;
  return { entity, fields };
}

export async function listPageSummaries(env: AppEnv): Promise<PageSummary[]> {
  const sql = getDb(env);
  const rows = await sql<PageRow>`SELECT key, title, icon, body FROM sd_pages ORDER BY position, created_at`;
  return rows.map((row) => {
    const first = parsePageRefs(row.body)[0];
    return { key: row.key, title: row.title, icon: row.icon, entity_key: first?.entity_key ?? "" };
  });
}

export async function getPageDetail(env: AppEnv, key: string): Promise<PageDetail | null> {
  const sql = getDb(env);
  const pages = await sql<PageRow>`SELECT key, title, icon, body FROM sd_pages WHERE key = ${key} LIMIT 1`;
  const page = pages[0];
  if (!page) return null;

  const first = parsePageRefs(page.body)[0];
  if (!first) return null;

  const resolved = await getEntityByKey(env, first.entity_key);
  if (!resolved) return null;

  const views = await sql<ViewRow>`SELECT kind, name, config FROM sd_views
    WHERE entity_id = ${resolved.entity.id} AND key = ${first.view_key} LIMIT 1`;
  const view = views[0];
  if (!view) return null;

  const config = parseViewConfig(view.config);
  const records = await listRecords(env, first.entity_key, { sort: config.sort, filter: config.filter });
  return {
    page: { key: page.key, title: page.title, icon: page.icon },
    entity: {
      key: resolved.entity.key,
      singular: resolved.entity.singular,
      plural: resolved.entity.plural,
      fields: resolved.fields.map((field) => {
        const fieldConfig = parseFieldConfig(field);
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required === 1,
          unique: fieldConfig.unique === true,
          ...(fieldConfig.options ? { options: fieldConfig.options } : {}),
        };
      }),
    },
    view: { kind: view.kind, name: view.name, visible_fields: config.visible_fields, ...(config.sort ? { sort: config.sort } : {}) },
    records: records.map((record) => ({
      id: record.id,
      data: record.data,
      created_at: record.created_at,
      updated_at: record.updated_at,
    })),
  };
}

export function fieldInsertStatement(
  env: AppEnv,
  entityId: string,
  field: FieldSpec,
  position: number,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO sd_fields (id, entity_id, key, label, type, config, required, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    entityId,
    field.key,
    field.label,
    field.type,
    fieldConfig(field),
    field.required ? 1 : 0,
    position,
    nowIso(),
  );
}

export function viewInsertStatement(
  env: AppEnv,
  entityId: string,
  view: ViewSpec,
  position: number,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO sd_views (id, entity_id, key, kind, name, config, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), entityId, view.key, view.kind, view.name, JSON.stringify(view.config), position);
}

export function pageInsertStatement(env: AppEnv, page: PageSpec, position: number): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO sd_pages (id, key, title, icon, body, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), page.key, page.title, page.icon ?? null, JSON.stringify(page.views), position, nowIso());
}

export function entityInsertPlan(env: AppEnv, entity: EntitySpec): { id: string; statements: D1PreparedStatement[] } {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const statements = [
    env.DB.prepare(
      "INSERT INTO sd_entities (id, key, singular, plural, icon, spec_version, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      entity.key,
      entity.singular,
      entity.plural,
      entity.icon ?? null,
      entity.specVersion,
      Date.now(),
      createdAt,
      createdAt,
    ),
  ];

  entity.fields.forEach((field, index) => {
    statements.push(fieldInsertStatement(env, id, field, index));
  });

  return { id, statements };
}

export function entityInsertStatements(env: AppEnv, entity: EntitySpec): D1PreparedStatement[] {
  return entityInsertPlan(env, entity).statements;
}

export async function insertEntitySpec(
  env: AppEnv,
  entity: EntitySpec,
  actor: string,
  batch = true,
): Promise<void | D1PreparedStatement[]> {
  const statements = [
    ...entityInsertStatements(env, entity),
    auditStatement(env, "spec.entity", entity.key, actor, `insert entity ${entity.key}`),
  ];
  if (!batch) return statements;
  await env.DB.batch(statements);
}

export async function addRecord(
  env: AppEnv,
  entityKey: string,
  data: Record<string, unknown>,
  actor: string,
): Promise<RecordRow> {
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);
  const canonical = canonicalData(resolved.fields, data);
  await assertUniqueValues(env, resolved.entity.id, resolved.fields, canonical);

  const id = crypto.randomUUID();
  const ts = nowIso();
  const json = JSON.stringify(canonical);
  const position = Date.now();
  const statements = [
    env.DB.prepare(
      "INSERT INTO sd_records (id, entity_id, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, resolved.entity.id, json, position, ts, ts),
    ...recordValueStatements(env, resolved.entity.id, id, resolved.fields, canonical),
    auditStatement(env, "spec.record.add", `${entityKey}:${id}`, actor, `add record ${entityKey}:${id}`),
  ];
  await env.DB.batch(statements);
  return { id, entity_id: resolved.entity.id, data: canonical, position, created_at: ts, updated_at: ts };
}

export async function editRecord(
  env: AppEnv,
  entityKey: string,
  id: string,
  data: Record<string, unknown>,
  actor: string,
): Promise<RecordRow> {
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);
  const current = await env.DB.prepare(
    "SELECT id, entity_id, data, position, created_at, updated_at FROM sd_records WHERE id = ? AND entity_id = ? LIMIT 1",
  ).bind(id, resolved.entity.id).first<RawRecordRow>();
  if (!current) throw new Error(`no record ${id}`);

  const canonical = canonicalData(resolved.fields, data);
  await assertUniqueValues(env, resolved.entity.id, resolved.fields, canonical, id);

  const ts = nowIso();
  const json = JSON.stringify(canonical);
  const statements = [
    env.DB.prepare("UPDATE sd_records SET data = ?, updated_at = ? WHERE id = ? AND entity_id = ?").bind(
      json,
      ts,
      id,
      resolved.entity.id,
    ),
    env.DB.prepare("DELETE FROM sd_record_values WHERE record_id = ?").bind(id),
    ...recordValueStatements(env, resolved.entity.id, id, resolved.fields, canonical),
    auditStatement(env, "spec.record.edit", `${entityKey}:${id}`, actor, `edit record ${entityKey}:${id}`),
  ];
  await env.DB.batch(statements);
  return { ...parseRecord(current), data: canonical, updated_at: ts };
}

export type EntityWithFields = {
  key: string;
  singular: string;
  plural: string;
  fields: Array<{ key: string; label: string; type: string; required: boolean; unique: boolean; options?: string[] }>;
};

/** All declared entities WITH their field schemas — the Assistant's grounding read so the
 * model targets real entity keys + field keys instead of hallucinating them (W1, ISC-131). */
export async function listEntitiesWithFields(env: AppEnv): Promise<EntityWithFields[]> {
  const [entities, fields] = await Promise.all([
    listEntities(env),
    getDb(env)<FieldRow>`
      SELECT id, entity_id, key, label, type, config, required, position, created_at
      FROM sd_fields ORDER BY position ASC
    `,
  ]);
  return entities.map((entity) => ({
    key: entity.key,
    singular: entity.singular,
    plural: entity.plural,
    fields: fields
      .filter((field) => field.entity_id === entity.id)
      .map((field) => {
        const config = parseFieldConfig(field);
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required === 1,
          unique: config.unique === true,
          ...(config.options?.length ? { options: config.options } : {}),
        };
      }),
  }));
}

/** Canonicalize a proposed record WITHOUT writing — powers the Confirm card so the owner
 * sees the EXACT values that will persist (same no-gap rule as card enrichment). */
export async function canonicalizeForEntity(
  env: AppEnv,
  entityKey: string,
  data: Record<string, unknown>,
): Promise<{ singular: string; plural: string; canonical: Record<string, unknown> }> {
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);
  return {
    singular: resolved.entity.singular,
    plural: resolved.entity.plural,
    canonical: canonicalData(resolved.fields, data),
  };
}

const IMPORT_MAX_ROWS = 100;
const IMPORT_CHUNK = 20;

/**
 * Bulk import (W1). Validates EVERY row up front (canonicalize + DB uniqueness + intra-batch
 * uniqueness, with 1-based row numbers in errors) so the only mid-write failure left is infra;
 * then inserts in bounded D1 batches. Exactly ONE audit row for the whole import, riding the
 * final chunk. Position preserves input order.
 */
export async function importRecords(
  env: AppEnv,
  entityKey: string,
  rows: unknown[],
  actor: string,
): Promise<{ imported: number }> {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("records must be a non-empty array");
  if (rows.length > IMPORT_MAX_ROWS) throw new Error(`too many records (max ${IMPORT_MAX_ROWS} per import)`);
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);

  const canonicals = rows.map((row, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`record ${i + 1} must be an object`);
    try {
      return canonicalData(resolved.fields, row as Record<string, unknown>);
    } catch (e) {
      throw new Error(`record ${i + 1}: ${(e as Error).message}`);
    }
  });

  const seenUnique = new Map<string, Set<string>>();
  for (let i = 0; i < canonicals.length; i++) {
    await assertUniqueValues(env, resolved.entity.id, resolved.fields, canonicals[i]);
    for (const field of resolved.fields) {
      if (!parseFieldConfig(field).unique || canonicals[i][field.key] === undefined) continue;
      // Key the intra-import dedup on the PROJECTED value — the same representation the
      // DB uniqueness check uses — so coercion-divergent inputs (e.g. two date spellings
      // of the same day) can't slip past as "different strings" (Forge LOW).
      const projected = projectValue(field, canonicals[i][field.key]);
      const value = projected.valueText !== null ? `t:${projected.valueText}` : `n:${projected.valueNum}`;
      const set = seenUnique.get(field.key) ?? new Set<string>();
      if (set.has(value)) throw new Error(`record ${i + 1}: field ${field.key} duplicated within the import`);
      set.add(value);
      seenUnique.set(field.key, set);
    }
  }

  const ts = nowIso();
  const basePosition = Date.now();
  const totalChunks = Math.ceil(canonicals.length / IMPORT_CHUNK);
  let written = 0;
  for (let start = 0; start < canonicals.length; start += IMPORT_CHUNK) {
    const chunk = canonicals.slice(start, start + IMPORT_CHUNK);
    const statements: D1PreparedStatement[] = [];
    chunk.forEach((canonical, j) => {
      const id = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          "INSERT INTO sd_records (id, entity_id, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(id, resolved.entity.id, JSON.stringify(canonical), basePosition + start + j, ts, ts),
      );
      statements.push(...recordValueStatements(env, resolved.entity.id, id, resolved.fields, canonical));
    });
    // EVERY chunk carries its own audit row, atomic with that chunk's data (Forge HIGH:
    // a mid-import infra failure must never leave committed rows unaudited). Single-chunk
    // imports keep the simple one-line summary; multi-chunk summaries are numbered.
    const chunkNo = Math.floor(start / IMPORT_CHUNK) + 1;
    const summary =
      totalChunks === 1
        ? `import ${canonicals.length} records into ${entityKey}`
        : `import chunk ${chunkNo}/${totalChunks} (${chunk.length} records) into ${entityKey}`;
    statements.push(auditStatement(env, "spec.record.import", entityKey, actor, summary));
    await env.DB.batch(statements);
    written += chunk.length;
  }
  return { imported: written };
}

export async function deleteRecord(env: AppEnv, entityKey: string, id: string, actor: string): Promise<{ id: string }> {
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);
  const current = await env.DB.prepare("SELECT id FROM sd_records WHERE id = ? AND entity_id = ? LIMIT 1")
    .bind(id, resolved.entity.id)
    .first<{ id: string }>();
  if (!current) throw new Error(`no record ${id}`);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sd_record_values WHERE record_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sd_records WHERE id = ? AND entity_id = ?").bind(id, resolved.entity.id),
    auditStatement(env, "spec.record.delete", `${entityKey}:${id}`, actor, `delete record ${entityKey}:${id}`),
  ]);
  return { id };
}

function filterPredicate(filter: FilterSpec, field: FieldRow): { sql: string; params: unknown[] } {
  const projected = projectValue(field, coerceFieldValue(field, filter.value));
  const column = projected.valueText !== null ? "value_text" : "value_num";
  const value = projected.valueText !== null ? projected.valueText : projected.valueNum;

  switch (filter.op) {
    case "eq":
      return { sql: `rv.${column} = ?`, params: [value] };
    case "neq":
      return { sql: `rv.${column} != ?`, params: [value] };
    case "gt":
      return { sql: `rv.${column} > ?`, params: [value] };
    case "gte":
      return { sql: `rv.${column} >= ?`, params: [value] };
    case "lt":
      return { sql: `rv.${column} < ?`, params: [value] };
    case "lte":
      return { sql: `rv.${column} <= ?`, params: [value] };
    case "contains":
      if (column !== "value_text") throw new Error("contains requires text");
      return { sql: "rv.value_text LIKE ?", params: [`%${String(value)}%`] };
    default:
      throw new Error("unsupported filter op");
  }
}

export async function listRecords(env: AppEnv, entityKey: string, query: RecordListQuery): Promise<RecordRow[]> {
  const resolved = await getEntityByKey(env, entityKey);
  if (!resolved) throw new Error(`no entity ${entityKey}`);
  const limit = clampLimit(query.limit == null ? null : String(query.limit), 500);

  if (!query.filter && !query.sort) {
    const rows = await env.DB.prepare(
      "SELECT id, entity_id, data, position, created_at, updated_at FROM sd_records WHERE entity_id = ? ORDER BY position, created_at LIMIT ?",
    ).bind(resolved.entity.id, limit).all<RawRecordRow>();
    return rows.results.map(parseRecord);
  }

  const sortField = query.sort ? resolved.fields.find((field) => field.key === query.sort?.field) : undefined;
  const filterField = query.filter ? resolved.fields.find((field) => field.key === query.filter?.field) : undefined;
  if (query.sort && !sortField) throw new Error(`no field ${query.sort.field}`);
  if (query.filter && !filterField) throw new Error(`no field ${query.filter.field}`);

  // Params MUST bind in SQL placeholder order: JOIN field_ids first (they appear in the
  // FROM clause), then WHERE params, then LIMIT. The previous version pushed entity.id
  // first → the JOIN's field_id consumed it → WHERE r.entity_id = <field uuid> matched
  // nothing, so every sorted/filtered list silently returned []. (Found live 2026-07-12
  // when the first template with a default sort shipped.)
  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const where: string[] = ["r.entity_id = ?"];
  const whereParams: unknown[] = [resolved.entity.id];
  if (filterField && query.filter) {
    joins.push("JOIN sd_record_values rv ON rv.record_id = r.id AND rv.field_id = ?");
    joinParams.push(filterField.id);
    const predicate = filterPredicate(query.filter, filterField);
    where.push(predicate.sql);
    whereParams.push(...predicate.params);
  }
  if (sortField) {
    joins.push("LEFT JOIN sd_record_values sv ON sv.record_id = r.id AND sv.field_id = ?");
    joinParams.push(sortField.id);
  }
  const params: unknown[] = [...joinParams, ...whereParams, limit];

  const order =
    sortField && query.sort
      ? `ORDER BY ${["number", "checkbox", "date"].includes(sortField.type) ? "sv.value_num" : "sv.value_text"} ${
          query.sort.direction === "desc" ? "DESC" : "ASC"
        }, r.position, r.created_at`
      : "ORDER BY r.position, r.created_at";
  const sql = `SELECT r.id, r.entity_id, r.data, r.position, r.created_at, r.updated_at
    FROM sd_records r ${joins.join(" ")}
    WHERE ${where.join(" AND ")}
    ${order}
    LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(...params).all<RawRecordRow>();
  return rows.results.map(parseRecord);
}
