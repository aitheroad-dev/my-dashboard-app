#!/usr/bin/env node
/**
 * Fleet deploy for My Dashboard forks.
 *
 * The React Router/Vite build bakes the root wrangler.jsonc into
 * build/server/wrangler.json, and that baked file is what wrangler deploy
 * ships. Passing a different --config to deploy re-bundles workers/app.ts and
 * fails on virtual:react-router/server-build, so this script places each fork's
 * generated config at the repo root before building.
 *
 * Fork deploys deliberately avoid bun run deploy because its check:clean guard
 * rejects real resource IDs in root wrangler.jsonc. The exact fork flow is:
 * bun run build, then node ./node_modules/wrangler/bin/wrangler.js deploy
 * wrapped by script(1) for a PTY because wrangler uploads hang under bun.
 *
 * Generated fork configs force workers_dev and preview_urls off so a plain
 * wrangler deploy cannot re-enable public workers.dev or preview URLs.
 *
 * D1 migrations are not run here. They self-apply through the app boot guard on
 * the first authenticated request, and this script cannot pass Cloudflare
 * Access.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const rootConfigPath = join(repoRoot, "wrangler.jsonc");
const backupConfigPath = join(repoRoot, "wrangler.jsonc.fleetbak");
const manifestPath = join(repoRoot, "recipients.json");
const nodeBin = process.execPath;
const wranglerBin = "./node_modules/wrangler/bin/wrangler.js";
const smokeTimeoutMs = 10_000;

let backupCreated = false;
let rootConfigRestored = false;

function usage() {
  return [
    "Usage: node scripts/deploy-fleet.mjs [--only <key[,key,...]>] [--all] [--dry-run] [--sync-secrets] [--yes]",
    "",
    "Flags:",
    "  --only <keys>     Restrict to comma-separated fork keys.",
    "  --all             Include staging forks.",
    "  --dry-run         Build, safety-check, and smoke-check without deploys or secret writes.",
    "  --sync-secrets    Reconcile Assistant model secrets for non-null manifest values.",
    "  --yes             Skip the interactive confirmation prompt.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    onlyKeys: null,
    all: false,
    dryRun: false,
    syncSecrets: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--only") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--only requires a comma-separated key list.\n\n" + usage());
      }
      options.onlyKeys = parseOnlyList(value);
      i += 1;
    } else if (arg.startsWith("--only=")) {
      options.onlyKeys = parseOnlyList(arg.slice("--only=".length));
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--sync-secrets") {
      options.syncSecrets = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown flag: ${arg}\n\n${usage()}`);
    }
  }

  return options;
}

function parseOnlyList(value) {
  return value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function selectForks(manifest, options) {
  const forks = Array.isArray(manifest.forks) ? manifest.forks : [];
  const validKeys = forks.map((fork) => fork.key);
  const validKeySet = new Set(validKeys);
  const onlyKeySet = options.onlyKeys ? new Set(options.onlyKeys) : null;

  if (onlyKeySet) {
    const unknown = [...onlyKeySet].filter((key) => !validKeySet.has(key));
    if (unknown.length > 0) {
      throw new Error(
        [
          `Unknown --only key(s): ${unknown.join(", ")}`,
          `Valid keys: ${validKeys.join(", ") || "(none)"}`,
        ].join("\n"),
      );
    }
  }

  const candidates = onlyKeySet ? forks.filter((fork) => onlyKeySet.has(fork.key)) : forks;
  return candidates.filter(
    (fork) => fork.role !== "staging" || options.all || (onlyKeySet && onlyKeySet.has(fork.key)),
  );
}

function printPlan(selectedForks, options) {
  console.log("Fleet deploy plan");
  console.log("=================");
  console.log(`Forks: ${selectedForks.map((fork) => fork.key).join(", ")}`);
  console.log(`Dry run: ${options.dryRun ? "yes" : "no"}`);
  console.log(`Sync secrets: ${options.syncSecrets ? "yes" : "no"}`);
  console.log(`Include staging: ${options.all ? "yes" : "no"}`);
  console.log("D1 migrations: not run; the app boot guard self-applies them after authenticated access.");
  console.log("");
}

function askQuestion(readline, prompt) {
  return new Promise((resolve) => {
    readline.question(prompt, resolve);
  });
}

async function confirmIfNeeded(selectedForks, options) {
  if (options.dryRun || options.yes) return;

  if (!process.stdin.isTTY) {
    throw new Error("Confirmation is required, but stdin is not a TTY. Re-run with --yes to proceed.");
  }

  let readline;
  try {
    readline = createInterface({ input: process.stdin, output: process.stdout });
    const expected = `deploy ${selectedForks.length}`;
    const answer = (await askQuestion(
      readline,
      `Type "${expected}" to deploy ${selectedForks.length} fork(s): `,
    )).trim();

    if (answer !== expected) {
      throw new Error("Confirmation did not match. Aborting before deploy or secret writes.");
    }
  } finally {
    if (readline) readline.close();
  }
}

function abortIfStaleBackupExists() {
  if (!existsSync(backupConfigPath)) return;

  throw new Error(
    [
      "Refusing to start because wrangler.jsonc.fleetbak already exists.",
      "A previous fleet run may have crashed before cleanup, so wrangler.jsonc may still contain a fork config.",
      "Restore wrangler.jsonc from wrangler.jsonc.fleetbak, or run `git checkout -- wrangler.jsonc`,",
      "then delete wrangler.jsonc.fleetbak and re-run this command.",
    ].join("\n"),
  );
}

function backupRootConfig() {
  copyFileSync(rootConfigPath, backupConfigPath);
  backupCreated = true;
}

function restoreRootConfig() {
  if (!backupCreated || rootConfigRestored) return;
  rootConfigRestored = true;

  if (existsSync(backupConfigPath)) {
    copyFileSync(backupConfigPath, rootConfigPath);
    unlinkSync(backupConfigPath);
  }
}

function installSignalHandlers() {
  const handleSignal = (signal) => {
    try {
      restoreRootConfig();
    } catch (error) {
      console.error(`Failed to restore wrangler.jsonc after ${signal}: ${formatError(error)}`);
      process.exit(1);
    }

    console.error(`\nReceived ${signal}; restored wrangler.jsonc and stopped.`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

function generateWranglerConfig(fork) {
  return {
    "$schema": "node_modules/wrangler/config-schema.json",
    name: fork.workerName,
    compatibility_date: "2025-10-08",
    compatibility_flags: ["nodejs_compat"],
    main: "./workers/app.ts",
    observability: { enabled: true },
    upload_source_maps: true,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: fork.d1.name,
        database_id: fork.d1.id,
      },
    ],
    r2_buckets: [
      {
        binding: "BUCKET",
        bucket_name: fork.r2.bucket,
      },
    ],
    kv_namespaces: [
      {
        binding: "KV",
        id: fork.kv.id,
      },
    ],
    ai: {
      binding: "AI",
    },
  };
}

function writeForkConfig(fork) {
  const config = generateWranglerConfig(fork);
  writeFileSync(rootConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function runCommand(label, command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    return {
      ok: false,
      label,
      message: `${label} failed to start: ${result.error.message}`,
      result,
    };
  }

  if (result.status === null) {
    return {
      ok: false,
      label,
      message: `${label} was terminated before an exit status was available${result.signal ? ` by ${result.signal}` : ""}.`,
      result,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      label,
      message: `${label} exited with status ${result.status}.`,
      result,
    };
  }

  return { ok: true, label, result };
}

function runBuild() {
  return runCommand("build", "bun", ["run", "build"], { stdio: ["inherit", "inherit", "inherit"] });
}

function runDeploy() {
  return runCommand(
    "wrangler deploy",
    "script",
    ["-q", "/dev/null", nodeBin, wranglerBin, "deploy"],
    { stdio: ["inherit", "pipe", "pipe"] },
  );
}

function runSecretPut(workerName, secretName, secretValue) {
  // NOTE: unlike `wrangler deploy`, `secret put` is a small API call that reads
  // its value from stdin — so it must NOT be wrapped in the `script(1)` PTY.
  // A PTY hijacks stdin (tcgetattr on a socket → EIO), which breaks the pipe.
  // Running wrangler directly under node (not bun) is fine here (no upload hang).
  return runCommand(
    `secret put ${secretName}`,
    nodeBin,
    [wranglerBin, "secret", "put", secretName, "--name", workerName],
    {
      input: secretValue,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function parseVersionId(output) {
  const match = /Current Version ID:\s*([0-9a-fA-F-]+)/i.exec(output || "");
  return match ? match[1] : "";
}

function runSafetyGate(fork) {
  const bakedPath = join(repoRoot, "build", "server", "wrangler.json");
  const baked = JSON.parse(readFileSync(bakedPath, "utf8"));
  const mismatches = [];

  if (baked.name !== fork.workerName) {
    mismatches.push(`name expected ${fork.workerName}, got ${stringifyValue(baked.name)}`);
  }

  const bakedD1Id = baked.d1_databases?.[0]?.database_id;
  if (bakedD1Id !== fork.d1.id) {
    mismatches.push(`d1_databases[0].database_id expected ${fork.d1.id}, got ${stringifyValue(bakedD1Id)}`);
  }

  const bakedKvId = baked.kv_namespaces?.[0]?.id;
  if (bakedKvId !== fork.kv.id) {
    mismatches.push(`kv_namespaces[0].id expected ${fork.kv.id}, got ${stringifyValue(bakedKvId)}`);
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      message: "Safety gate failed:\n" + mismatches.map((mismatch) => `  - ${mismatch}`).join("\n"),
    };
  }

  return { ok: true, message: "Safety gate passed." };
}

async function smokeCheck(fork) {
  const url = `https://${fork.customDomain}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), smokeTimeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });
    const location = response.headers.get("location") || "";
    const ok = response.status === 302 && location.includes("cloudflareaccess.com");

    return {
      ok,
      result: ok ? `OK ${response.status}` : `FAIL ${response.status} location=${location || "(none)"}`,
      status: response.status,
      location,
    };
  } catch (error) {
    return {
      ok: false,
      result: `ERROR ${formatError(error)}`,
      error,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deployFork(fork, options) {
  const summary = {
    key: fork.key,
    worker: fork.workerName,
    version: options.dryRun ? "DRY-RUN" : "",
    secrets: options.syncSecrets ? "PENDING" : "SKIPPED",
    smoke: "SKIPPED",
    failed: false,
    errors: [],
  };

  console.log("");
  console.log(`==== ${fork.key} (${fork.workerName}) ====`);
  console.log(`Domain: ${fork.customDomain}`);
  console.log("Writing generated root wrangler.jsonc...");
  writeForkConfig(fork);

  console.log("Building...");
  const build = runBuild();
  if (!build.ok) {
    console.error(build.message);
    summary.failed = true;
    summary.errors.push(build.message);
    return summary;
  }

  console.log("Running safety gate...");
  let gate;
  try {
    gate = runSafetyGate(fork);
  } catch (error) {
    gate = { ok: false, message: `Safety gate errored: ${formatError(error)}` };
  }

  if (!gate.ok) {
    console.error(gate.message);
    summary.failed = true;
    summary.errors.push(gate.message);
    return summary;
  }
  console.log(gate.message);

  if (options.dryRun) {
    console.log("Dry run: skipping wrangler deploy and secret writes.");
    summary.version = "DRY-RUN";
    summary.secrets = options.syncSecrets ? "DRY-RUN" : "SKIPPED";
  } else {
    console.log("Deploying...");
    const deploy = runDeploy();
    if (!deploy.ok) {
      console.error(deploy.message);
      summary.failed = true;
      summary.errors.push(deploy.message);
      summary.version = "FAILED";
    } else {
      const combinedOutput = `${deploy.result.stdout || ""}\n${deploy.result.stderr || ""}`;
      summary.version = parseVersionId(combinedOutput) || "DEPLOYED";
      console.log(`Deploy recorded version: ${summary.version}`);
    }

    if (options.syncSecrets) {
      summary.secrets = syncSecrets(fork, summary);
    }
  }

  console.log("Smoke check...");
  const smoke = await smokeCheck(fork);
  summary.smoke = smoke.result;
  console.log(`Smoke: ${smoke.result}`);
  if (!smoke.ok) {
    summary.failed = true;
    summary.errors.push(`Smoke check failed: ${smoke.result}`);
  }

  return summary;
}

function syncSecrets(fork, summary) {
  const secrets = [
    ["ASSISTANT_MODEL_FAST", fork.assistant?.fast],
    ["ASSISTANT_MODEL_REASONING", fork.assistant?.reasoning],
  ];
  const outcomes = [];

  for (const [secretName, secretValue] of secrets) {
    if (secretValue === null || secretValue === undefined) {
      outcomes.push(`${secretName}: skipped`);
      continue;
    }

    console.log(`Syncing ${secretName}...`);
    const result = runSecretPut(fork.workerName, secretName, secretValue);
    if (!result.ok) {
      console.error(result.message);
      summary.failed = true;
      summary.errors.push(result.message);
      outcomes.push(`${secretName}: failed`);
    } else {
      outcomes.push(`${secretName}: ok`);
    }
  }

  return outcomes.join("; ");
}

function printSummary(summaries) {
  console.log("");
  console.log("SUMMARY");
  console.log("=======");
  console.log("D1 migrations: not run; they self-apply through the app boot guard after authenticated access.");
  console.log("");

  const rows = summaries.map((summary) => ({
    key: summary.key,
    worker: summary.worker,
    version: summary.version || "SKIPPED",
    secrets: summary.secrets || "SKIPPED",
    smoke: summary.smoke || "SKIPPED",
  }));

  printTable(["key", "worker", "version", "secrets", "smoke"], rows);

  const failed = summaries.filter((summary) => summary.failed);
  if (failed.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const summary of failed) {
      console.log(`- ${summary.key}: ${summary.errors.join(" | ")}`);
    }
  }
}

function printTable(columns, rows) {
  const widths = columns.map((column) => {
    const values = rows.map((row) => String(row[column] || ""));
    return Math.max(column.length, ...values.map((value) => value.length));
  });
  const formatRow = (row) => columns.map((column, index) => String(row[column] || "").padEnd(widths[index])).join("  ");
  const header = formatRow(Object.fromEntries(columns.map((column) => [column, column])));
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function stringifyValue(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function formatError(error) {
  if (error && typeof error === "object" && "message" in error) {
    return error.message;
  }
  return String(error);
}

async function main() {
  let summaries = [];

  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return 0;
    }

    abortIfStaleBackupExists();

    const manifest = readManifest();
    const selectedForks = selectForks(manifest, options);

    if (selectedForks.length === 0) {
      console.log("No forks selected. Nothing to do.");
      return 0;
    }

    printPlan(selectedForks, options);
    await confirmIfNeeded(selectedForks, options);

    installSignalHandlers();
    backupRootConfig();

    for (const fork of selectedForks) {
      const summary = await deployFork(fork, options);
      summaries.push(summary);
    }
  } finally {
    restoreRootConfig();
  }

  printSummary(summaries);
  return summaries.some((summary) => summary.failed) ? 1 : 0;
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    try {
      restoreRootConfig();
    } catch (restoreError) {
      console.error(`Failed to restore wrangler.jsonc: ${formatError(restoreError)}`);
    }
    console.error(formatError(error));
    process.exit(1);
  });
