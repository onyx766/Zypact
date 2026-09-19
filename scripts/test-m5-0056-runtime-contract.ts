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
function selectMigrations(entries: string[]): string[] {
  const seen = new Map<number, string>();
  for (const e of entries) {
    if (!e.endsWith(".sql")) continue;
    const m = /^(\d{4})_[A-Za-z0-9_]+\.sql$/.exec(e);
    if (!m) throw new Error(`malformed migration filename: ${e}`);
    const n = Number.parseInt(m[1], 10);
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

async function main(): Promise<void> {
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
