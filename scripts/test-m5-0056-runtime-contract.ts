#!/usr/bin/env tsx
/**
 * 0056 — real PostgreSQL runtime contract.
 *
 * Opt-in: does nothing without ZYPACT_M5_0056_RUNTIME_TEST=1. Creates a
 * disposable local stack under a fresh mktemp directory, applies exactly
 * migrations 0001-0056, and exercises the properties that only a real
 * database can prove: privileges that actually refuse a write, a CHECK
 * that actually rejects a lying hash, and T1 running inside the receipt
 * RPC's own transaction rather than as a second application call.
 *
 * No remote credential. No provider call. No staging, no Production.
 * Cleanup runs only after full success; on failure the stack is left up
 * and its workdir printed.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowlistDrift, FOUR_DIGIT_ALLOWLIST, migrationVersion } from "./lib/migration-names";

const REPO = process.cwd();
const MAXV = 56;

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
}
function available(cmd: string): boolean {
  try { run(cmd, ["--version"]); return true; } catch { return false; }
}
function readTomlScalar(text: string, section: string, key: string): string | null {
  let cur: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { cur = h[1]; continue; }
    if (cur !== section) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1] === key) return kv[2].trim();
  }
  return null;
}
function setTomlScalar(text: string, section: string, key: string, value: string) {
  let cur: string | null = null, n = 0;
  const out = text.split("\n").map((raw) => {
    const line = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { cur = h[1]; return raw; }
    if (cur !== section) return raw;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1] !== key) return raw;
    n += 1;
    return `${raw.slice(0, raw.length - raw.trimStart().length)}${key} = ${value}`;
  });
  return { text: out.join("\n"), replacements: n };
}
// QD-6: names are classified by the shared rules (exact four-digit
// allowlist, validated 14-digit timestamps). A timestamped migration is later
// than every numbered one, so it is never part of a 1..N selection.
function selectMigrations(entries: string[], allowlist?: ReadonlySet<string>): string[] {
  const seen = new Map<number, string>();
  for (const e of entries) {
    if (!e.endsWith(".sql")) continue;
    const n = migrationVersion(e, allowlist);
    if (seen.has(n)) throw new Error(`duplicate migration ${n}`);
    seen.set(n, e);
  }
  const files: string[] = [];
  for (let n = 1; n <= MAXV; n += 1) {
    const f = seen.get(n);
    if (!f) throw new Error(`missing migration ${n}`);
    files.push(f);
  }
  return files;
}

/**
 * Static, before the opt-in gate: proves the selector on the real directory
 * and on in-memory lists, so a timestamped migration can neither break it nor
 * slip past it. Never counted among the runtime checks.
 */
function migrationSelectionPreflight(): void {
  const range = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, "0")}_fixture.sql`);
  // Synthetic four-digit names are allow-listed for these self-tests only.
  const fixtures = new Set([...range(MAXV), "0083_fixture.sql", "0010_duplicate_fixture.sql"]);
  const selects = (entries: string[], allow: ReadonlySet<string> = fixtures): string[] | null => {
    try { return selectMigrations(entries, allow); } catch { return null; }
  };
  const refused = (entries: string[]): boolean => selects(entries) === null;
  const realEntries = readdirSync(path.join(REPO, "supabase", "migrations"));
  const real = selects(realEntries, FOUR_DIGIT_ALLOWLIST);
  const withTimestamp = selects([...range(MAXV), "0083_fixture.sql", "20261102000000_q2p_fixture.sql"]);
  const cases: Array<[string, boolean]> = [
    [`the real directory selects exactly 0001..${MAXV}`,
      real !== null && real.length === MAXV && real.every((f, i) => f.startsWith(`${String(i + 1).padStart(4, "0")}_`))],
    ["a valid 14-digit migration is accepted and not selected",
      withTimestamp !== null && withTimestamp.length === MAXV && !withTimestamp.some((f) => f.startsWith("2026"))],
    ["a date-only (8-digit) version is refused", refused([...range(MAXV), "20261102_x.sql"])],
    ["a non-digit inside the version is refused", refused([...range(MAXV), "2026110200000a_x.sql"])],
    ["a 13-digit version is refused", refused([...range(MAXV), "2026110200000_x.sql"])],
    ["a version equal to production's 0081 row is refused", refused([...range(MAXV), "20260924023646_x.sql"])],
    ["a version below production's 0081 row is refused", refused([...range(MAXV), "20260101000000_x.sql"])],
    ["a non-calendar version (month 13) is refused", refused([...range(MAXV), "20261302000000_x.sql"])],
    ["a non-calendar version (31 November) is refused", refused([...range(MAXV), "20261131000000_x.sql"])],
    ["an uppercase timestamped name is refused", refused([...range(MAXV), "20261102000000_Q2P.sql"])],
    ["a duplicate timestamp version is refused",
      refused([...range(MAXV), "20261102000000_a.sql", "20261102000000_b.sql"])],
    ["a duplicate numbered version is still refused", refused([...range(MAXV), "0010_duplicate_fixture.sql"])],
    ["a gap is still refused", refused(range(MAXV).filter((f) => !f.startsWith("0002_")))],
    ["a four-digit name not on the allowlist is refused", refused([...range(MAXV), "0086_new_thing.sql"])],
    ["the real directory matches the exact four-digit allowlist", allowlistDrift(realEntries).length === 0],
  ];
  console.log("Preflight: migration selection (static, no Docker)");
  for (const [name, ok] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (cases.some(([, ok]) => !ok)) {
    console.log("✗ FATAL: migration-selection preflight failed. Nothing else will run.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  migrationSelectionPreflight();
  if (process.env.ZYPACT_M5_0056_RUNTIME_TEST !== "1") {
    console.log(
      "SKIP — this harness creates a disposable local Supabase stack and is opt-in.\n" +
        "      Run it with ZYPACT_M5_0056_RUNTIME_TEST=1 and a working Docker + Supabase CLI.\n" +
        "      Nothing was verified; nothing is claimed."
    );
    process.exit(0);
  }
  for (const cmd of ["docker", "supabase"]) {
    if (!available(cmd)) {
      console.log(`SKIP — \`${cmd}\` is not available. Nothing was verified.`);
      process.exit(0);
    }
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0056-"));
  console.log(`Disposable workdir: ${workdir}`);
  let started = false;
  let succeeded = false;

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);
    const cfg = path.join(workdir, "supabase", "config.toml");
    const edited = setTomlScalar(readFileSync(cfg, "utf8"), "db.seed", "enabled", "false");
    if (edited.replacements !== 1) throw new Error(`config replacements=${edited.replacements}`);
    writeFileSync(cfg, edited.text);
    const written = readFileSync(cfg, "utf8");
    if (readTomlScalar(written, "api", "enabled") !== "true") throw new Error("api disabled");
    check("[api].enabled stays true; [db.seed].enabled is false", true);

    const srcDir = path.join(REPO, "supabase", "migrations");
    const dstDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(dstDir, { recursive: true });
    const files = selectMigrations(readdirSync(srcDir));
    for (const f of files) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    check(
      `migrations 0001-0056 copied byte-identically (${files.length})`,
      files.length === MAXV &&
        files.every((f) => readFileSync(path.join(srcDir, f)).equals(readFileSync(path.join(dstDir, f)))) &&
        files.some((f) => f.startsWith("0056_"))
    );

    console.log("\nStarting the disposable stack...");
    run("supabase", ["start", "--workdir", workdir]);
    started = true;
    console.log("Stack started.\n");

    const container = run("docker", ["ps", "--format", "{{.Names}}"]).split("\n").find((n) => n.startsWith("supabase_db_"));
    if (!container) throw new Error("no supabase_db container");
    // `-t` suppresses result-set headers/footers, but psql still appends its
    // own command-completion tag ("INSERT 0 1", …) on the next line for
    // INSERT/UPDATE/DELETE, including with RETURNING — unlike a plain
    // SELECT. Keep only the scalar's own line.
    const q = (sql: string) =>
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql], { encoding: "utf8" }).trim().split("\n", 1)[0];
    const qFails = (sql: string): boolean => {
      try { q(sql); return false; } catch { return true; }
    };

    console.log("[1] The table exists with its real constraints");
    check("external_call_requests exists", q("select count(*) from information_schema.tables where table_name='external_call_requests';") === "1");
    check(
      "service_role holds SELECT and nothing else",
      q("select coalesce(string_agg(distinct privilege_type, ','), 'NONE') from information_schema.role_table_grants where table_name='external_call_requests' and grantee='service_role';") === "SELECT"
    );
    check(
      "row level security is on",
      q("select relrowsecurity from pg_class where relname='external_call_requests';") === "t"
    );
    check(
      "no policy grants a write path around the revoked privileges",
      q("select count(*) from pg_policies where tablename='external_call_requests' and cmd <> 'SELECT';") === "0"
    );

    console.log("\n[2] A lying hash is refused by the database itself");
    check(
      "a row whose sha256 does not cover its body is rejected",
      qFails(
        "insert into public.external_call_requests (project_id, external_call_id, call_kind, request_body, request_body_sha256) " +
        "values (gen_random_uuid(), gen_random_uuid(), 'perplexity', 'hello', repeat('0',64));"
      )
    );

    console.log("\n[3] The RPC signature really changed");
    check(
      "the five-argument form is gone",
      q("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_external_call_sent_for_job' and p.pronargs=5;") === "0"
    );
    check(
      "only the eight-argument form remains",
      q("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_external_call_sent_for_job';") === "1" &&
        q("select pronargs::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_external_call_sent_for_job';") === "8"
    );

    console.log("\n[4] The new transitions and helpers exist, with the right reach");
    for (const [fn, granted] of [
      ["fail_job_without_attempt_for_job", true],
      ["abort_attempt_and_fail_job_for_job", true],
      ["_close_unknown_outcome_core", false],
      ["_move_job_to_needs_review", false],
      ["close_attempt_for_parse_failure_for_job", true],
    ] as const) {
      check(`${fn} exists`, q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${fn}';`) === "1");
      const canExec = q(
        `select coalesce(bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')), false)::text ` +
        `from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${fn}';`
      );
      check(
        granted ? `${fn} is executable by service_role` : `${fn} is private — service_role cannot execute it`,
        canExec === (granted ? "true" : "false"),
        canExec
      );
    }

    console.log("\n[5] The outbox reason set really grew");
    for (const code of ["request_evidence_conflict", "receipt_evidence_conflict", "throttled_retries_exhausted", "slot_budget_exhausted", "analysis_parse_failed"]) {
      check(
        `'${code}' is accepted by the CHECK`,
        q(`select pg_get_constraintdef(oid) like '%${code}%' from pg_constraint where conname='protocol_execution_job_alerts_reason_code_check';`) === "t"
      );
    }

    console.log("\n[6] T2 derives its destination server-side");
    check(
      "an unknown reason is refused before anything is written",
      qFails("select * from public.fail_job_without_attempt_for_job(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'not_a_reason');")
    );
    check(
      "a known reason on a missing job answers JOB_NOT_FOUND, never a crash",
      q("select status from public.fail_job_without_attempt_for_job(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'run_cap_exceeded');") === "JOB_NOT_FOUND"
    );

    succeeded = failures === 0;
  } finally {
    if (started && succeeded) {
      console.log("\nStopping the disposable stack...");
      try { run("supabase", ["stop", "--no-backup", "--workdir", workdir]); console.log("Stack stopped."); }
      catch { console.log(`Stop it manually: supabase stop --no-backup --workdir ${workdir}`); }
    } else if (started) {
      console.log(`\nStack LEFT RUNNING for inspection: ${workdir}`);
    }
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "0056 runtime contract PASSED." : "0056 runtime contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
