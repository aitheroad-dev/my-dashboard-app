import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type TargetFlag = "--local" | "--remote";

type MigrationFile = {
  name: string;
  path: string;
  sql: string;
};

type WranglerResult = {
  stdout: string;
};

const databaseName = "my-dashboard-db";
const createMigrationsTableSql =
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)";

function main(): void {
  const target = parseTarget(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const migrationsDir = join(repoRoot, "db", "migrations");
  const wranglerPath = join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

  if (!existsSync(wranglerPath)) {
    throw new Error(`Expected local wrangler binary at ${wranglerPath}`);
  }

  const migrations = readMigrationFiles(migrationsDir);

  runWrangler(wranglerPath, repoRoot, target, ["--command", createMigrationsTableSql]);
  const appliedBeforeRun = readAppliedMigrationNames(wranglerPath, repoRoot, target);
  const pendingBeforeRun = migrations.filter((migration: MigrationFile): boolean => {
    return !appliedBeforeRun.has(migration.name);
  });
  const appliedThisRun: string[] = [];

  for (const migration of pendingBeforeRun) {
    runWrangler(wranglerPath, repoRoot, target, [`--file=${migration.path}`]);
    runWrangler(wranglerPath, repoRoot, target, [
      "--command",
      `INSERT OR IGNORE INTO _migrations(name, applied_at) VALUES('${escapeSqlString(
        migration.name,
      )}', '${escapeSqlString(new Date().toISOString())}')`,
    ]);
    appliedThisRun.push(migration.name);
  }

  const appliedAfterRun = readAppliedMigrationNames(wranglerPath, repoRoot, target);
  const pendingAfterRun = migrations.filter((migration: MigrationFile): boolean => {
    return !appliedAfterRun.has(migration.name);
  }).length;

  console.log(`Target: ${target === "--remote" ? "remote" : "local"}`);
  console.log(`Applied this run: ${appliedThisRun.length > 0 ? appliedThisRun.join(", ") : "none"}`);
  console.log(`${pendingAfterRun} pending`);
}

function parseTarget(args: string[]): TargetFlag {
  let target: TargetFlag = "--local";
  let sawLocal = false;
  let sawRemote = false;

  for (const arg of args) {
    if (arg === "--remote") {
      sawRemote = true;
      target = "--remote";
    } else if (arg === "--local") {
      sawLocal = true;
      target = "--local";
    } else {
      throw new Error(`Unknown flag ${arg}. Usage: bun scripts/migrate.ts [--remote]`);
    }
  }

  if (sawLocal && sawRemote) {
    throw new Error("Choose only one target: --local or --remote");
  }

  return target;
}

function resolveRepoRoot(): string {
  const scriptPath = fileURLToPath(import.meta.url);
  return dirname(dirname(scriptPath));
}

function readMigrationFiles(migrationsDir: string): readonly MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((entryName: string): boolean => {
      return entryName.endsWith(".sql");
    })
    .sort((left: string, right: string): number => {
      return left.localeCompare(right);
    })
    .map((entryName: string): MigrationFile => {
      const path = join(migrationsDir, entryName);
      const sql = readFileSync(path, "utf8");

      if (sql.trim().length === 0) {
        throw new Error(`Migration ${entryName} is empty`);
      }

      return {
        name: entryName,
        path,
        sql,
      };
    });
}

function readAppliedMigrationNames(
  wranglerPath: string,
  repoRoot: string,
  target: TargetFlag,
): Set<string> {
  const result = runWrangler(wranglerPath, repoRoot, target, [
    "--json",
    "--command",
    "SELECT name FROM _migrations",
  ]);
  const payload = extractJsonPayload(result.stdout);

  if (!Array.isArray(payload)) {
    throw new Error("Wrangler JSON output was not an array");
  }

  const names = new Set<string>();

  for (const resultObject of payload) {
    if (!isRecord(resultObject)) {
      throw new Error("Wrangler result entry was not an object");
    }

    if ("success" in resultObject && resultObject.success !== true) {
      throw new Error("Wrangler result entry reported success=false");
    }

    if (!Array.isArray(resultObject.results)) {
      throw new Error("Wrangler result entry did not include a results array");
    }

    for (const row of resultObject.results) {
      if (!isRecord(row) || typeof row.name !== "string") {
        throw new Error("Wrangler row did not match { name: string }");
      }

      names.add(row.name);
    }
  }

  return names;
}

function runWrangler(
  wranglerPath: string,
  repoRoot: string,
  target: TargetFlag,
  extraArgs: readonly string[],
): WranglerResult {
  const args = [wranglerPath, "d1", "execute", databaseName, target, ...extraArgs];

  // spawnSync waits synchronously for the child process. If wrangler itself
  // hangs, that wait is owned by the child; d1 execute is known-safe via node
  // on this machine.
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    // Inherit CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for --remote when
    // they are present, along with the rest of the current environment.
    env: { ...process.env },
  });

  if (result.error instanceof Error) {
    throw new Error(`Failed to start wrangler: ${result.error.message}`);
  }

  if (typeof result.status !== "number") {
    throw new Error(`Wrangler exited without a numeric status. stderr: ${result.stderr}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `Wrangler failed with exit ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return {
    stdout: result.stdout,
  };
}

function extractJsonPayload(stdout: string): unknown {
  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index];

    if (char !== "[" && char !== "{") {
      continue;
    }

    const endIndex = findJsonEnd(stdout, index);

    if (endIndex === -1) {
      continue;
    }

    const candidate = stdout.slice(index, endIndex + 1);

    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  throw new Error(`Could not find JSON payload in wrangler stdout: ${stdout}`);
}

function findJsonEnd(text: string, startIndex: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[" || char === "{") {
      stack.push(char === "[" ? "]" : "}");
      continue;
    }

    if (char === "]" || char === "}") {
      const expected = stack.pop();

      if (expected !== char) {
        return -1;
      }

      if (stack.length === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
