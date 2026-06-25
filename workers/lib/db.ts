import type { AppEnv } from "./env";

/**
 * D1-backed tagged-template SQL — a proven single-tenant data layer reused
 * UNCHANGED so handler call sites keep their `sql`...`` shape.
 *
 *   const sql = getDb(env);
 *   const rows = await sql`SELECT * FROM projects ORDER BY created_at DESC`;
 *   const [row] = await sql`INSERT ... RETURNING id`;
 *
 * Contract:
 *   - `await sql`...`` resolves to the rows array (D1 `.all().results`).
 *   - Every `${value}` interpolation becomes a bound `?` parameter — NEVER a
 *     SQL fragment.
 *   - Values normalized for SQLite: undefined→null, boolean→0/1, Date→ISO,
 *     bigint→Number, object/array→JSON string.
 *
 * SQLite/D1 notes:
 *   - JSON columns are TEXT; pass `JSON.stringify(x)`; `JSON.parse` on read.
 *   - No `now()` — rely on the schema DEFAULT or bind an ISO string.
 *   - `ON CONFLICT ... DO UPDATE/NOTHING` and `RETURNING` are supported by D1.
 */
type D1Bind = string | number | null | ArrayBuffer;

export interface D1Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
}

function normalizeBind(v: unknown): D1Bind {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") return JSON.stringify(v);
  return v as D1Bind;
}

export function getDb(env: AppEnv): D1Sql {
  if (!env.DB) {
    throw new Error(
      "DB binding (Cloudflare D1) is not configured — check wrangler.jsonc d1_databases",
    );
  }
  const sql = async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let query = strings[0];
    const binds: D1Bind[] = [];
    for (let i = 0; i < values.length; i++) {
      query += "?" + strings[i + 1];
      binds.push(normalizeBind(values[i]));
    }
    const stmt =
      binds.length > 0
        ? env.DB.prepare(query).bind(...binds)
        : env.DB.prepare(query);
    const { results } = await stmt.all<T>();
    return results ?? [];
  };
  return sql as D1Sql;
}
