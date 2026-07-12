// Guard: replicate the WORKER boot-guard's naive statement splitter
// (workers/lib/migrate.ts splitStatements — line-comment aware, NOT literal-aware)
// over every migration file and assert each resulting fragment starts with a SQL
// keyword. Catches the exact failure class that took staging down on 2026-07-12:
// a `;` inside a string literal splits an INSERT into invalid fragments, the
// boot-guard batch throws, and EVERY DB route 500s. The local `bun run migrate`
// can NOT catch this — it shells to wrangler's real SQL parser.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const KEYWORD = /^(CREATE|INSERT|ALTER|DROP|UPDATE|DELETE|PRAGMA|REPLACE)\b/i;

// Must match workers/lib/migrate.ts splitStatements exactly.
function splitStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

let bad = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const statements = splitStatements(readFileSync(join(dir, file), "utf8"));
  statements.forEach((stmt, i) => {
    if (!KEYWORD.test(stmt)) {
      bad++;
      console.error(
        `✗ ${file} — fragment ${i + 1} does not start with a SQL keyword (likely a ';' inside a string literal):\n  ${stmt.slice(0, 120).replace(/\n/g, " ")}…`,
      );
    }
  });
}

if (bad > 0) {
  console.error(`\n${bad} bad fragment(s). Remove semicolons from string literals (use — or .) before deploying.`);
  process.exit(1);
}
console.log("✓ Migrations split cleanly under the worker's boot-guard splitter.");
