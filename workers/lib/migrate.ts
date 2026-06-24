import type { AppEnv } from "./env";

/**
 * Idempotent, concurrency-safe D1 migration runner (edge / Worker path).
 *
 * COMPLETION BARRIER (the correctness core): each migration's DDL statements and
 * the `INSERT INTO _migrations(name, ...)` completion row are committed in a
 * SINGLE atomic `env.DB.batch([...])` (D1 wraps a batch in one transaction —
 * all-or-nothing). Therefore a name's PRESENCE in `_migrations` means the
 * migration FULLY applied, never merely "claimed".
 *
 * Under concurrent cold isolates, SQLite serializes the batches: the first
 * commits (DDL + row); the second's batch hits the PRIMARY KEY conflict on the
 * completion row and rolls back ENTIRELY (no partial schema), after which the
 * loser re-reads, sees the name present (the winner has committed), and safely
 * proceeds. No TOCTOU window, no half-migrated reads, no permanently-wedged fork.
 *
 * Migration convention: statements are `;`-terminated; do NOT place a `;` inside
 * a string literal (the splitter is line-comment aware but not literal-aware).
 * Every statement must be individually idempotent (`IF NOT EXISTS`) so a rolled-
 * back-then-retried batch is always safe.
 */
type Migration = {
  name: string;
  sql: string;
};

const ensureMigrationsTableSql =
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)";

const rawMigrationModules = import.meta.glob("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, unknown>;

const migrations: readonly Migration[] = loadMigrations(rawMigrationModules);

export async function runMigrations(
  env: AppEnv,
): Promise<{ applied: string[]; pending: number }> {
  const applied: string[] = [];

  await ensureMigrationsTable(env);
  let completed = await readCompletedMigrationNames(env);

  for (const migration of migrations) {
    if (completed.has(migration.name)) continue;

    const statements = splitStatements(migration.sql).map((stmt) =>
      env.DB.prepare(stmt),
    );
    const markComplete = env.DB
      .prepare("INSERT INTO _migrations(name, applied_at) VALUES(?, ?)")
      .bind(migration.name, new Date().toISOString());

    try {
      // Atomic: DDL + completion row commit together, or not at all.
      await env.DB.batch([...statements, markComplete]);
      applied.push(migration.name);
    } catch (error: unknown) {
      // A concurrent winner most likely committed this migration (PK conflict on
      // the completion row). Re-read: if the name is now present, the migration
      // is fully applied by the other isolate — safe to continue. Otherwise this
      // is a genuine failure and must surface.
      completed = await readCompletedMigrationNames(env);
      if (!completed.has(migration.name)) {
        throw new Error(
          `Migration ${migration.name} failed to apply: ${describeError(error)}`,
        );
      }
    }
  }

  completed = await readCompletedMigrationNames(env);
  const pending = migrations.filter(
    (migration) => !completed.has(migration.name),
  ).length;

  return { applied, pending };
}

function loadMigrations(modules: Record<string, unknown>): readonly Migration[] {
  return Object.entries(modules)
    .map(([modulePath, sql]: [string, unknown]): Migration => {
      if (typeof sql !== "string") {
        throw new Error(`Migration ${modulePath} did not load as raw SQL text`);
      }
      return { name: basename(modulePath), sql };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function basename(modulePath: string): string {
  const parts = modulePath.split("/");
  const name = parts[parts.length - 1];
  if (typeof name === "string" && name.length > 0) return name;
  throw new Error(`Could not derive migration filename from ${modulePath}`);
}

/** Split a migration file into individual statements (line-comment aware). */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function ensureMigrationsTable(env: AppEnv): Promise<void> {
  const result: unknown = await env.DB.prepare(ensureMigrationsTableSql).run();
  if (!isRecord(result)) {
    throw new Error("D1 response for ensure _migrations was not an object");
  }
  if ("success" in result && result.success !== true) {
    throw new Error("D1 response for ensure _migrations reported success=false");
  }
}

/** Names present in `_migrations` — by construction, only fully-applied migrations. */
async function readCompletedMigrationNames(env: AppEnv): Promise<Set<string>> {
  const result: unknown = await env.DB.prepare(
    "SELECT name FROM _migrations",
  ).all();
  const rows = readD1Results(result, "SELECT name FROM _migrations");
  const names = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== "string") {
      throw new Error(
        "D1 returned an invalid _migrations row; expected { name: string }",
      );
    }
    names.add(row.name);
  }
  return names;
}

function readD1Results(result: unknown, context: string): readonly unknown[] {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    throw new Error(`D1 response for ${context} did not include a results array`);
  }
  return result.results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
