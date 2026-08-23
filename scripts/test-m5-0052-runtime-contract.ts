#!/usr/bin/env tsx
/**
 * M5 — real, reproducible Postgres runtime contract test for D-026
 * (migration 0052: durable call payloads — provider_call_receipts.
 * raw_response_body, analysis_call_receipts.raw_content — real
 * pairing/success/hash-match CHECK constraints verified by Postgres
 * itself (verified server-side by the CHECK constraints, which call
 * public._sha256_hex from inside their own expression -- this harness
 * never calls that function directly, since it has no grant to any role,
 * not even service_role; see the ACL section), probe_results real
 * UNIQUE(probe_run_id),
 * and the two receipt RPCs + get_protocol_execution_job_context
 * redefined to carry and expose them).
 *
 * This is NOT a static text check (see scripts/test-m5-0052-schema-
 * contract.ts for that). This test creates a genuinely disposable
 * local Supabase/Postgres stack under a fresh mktemp directory, applies
 * EXACTLY migrations 0001-0052 byte-identically (explicitly selected by
 * number — never "every migration file present"), and exercises D-026's
 * guarantees via real RPC calls over real psql connections — in
 * particular that a mismatched or missing content/hash pair is rejected
 * by a real Postgres CHECK constraint, not merely by application-layer
 * discipline, which static text review cannot prove.
 *
 * NOT YET RUN. Prepared per explicit instruction; execution requires a
 * separate, later authorization (ZYPACT_M5_0052_RUNTIME_TEST=1 and a
 * real disposable Docker/Supabase/psql stack).
 *
 * Safety (same discipline as scripts/test-m5-0051-runtime-contract.ts):
 *   - opt-in only: does nothing unless ZYPACT_M5_0052_RUNTIME_TEST=1.
 *   - no remote credential of any kind; the only connection is to a
 *     disposable local Postgres instance this same run creates.
 *   - never touches staging or Production; never touches any
 *     pre-existing container (in particular, never stops, restarts,
 *     inspects-for-mutation, or removes "zypact-postgres" or any
 *     container this run did not itself create); never runs
 *     `docker ... prune`.
 *   - the disposable project_id/workdir is unique per run (mktemp);
 *     cleanup is scoped exclusively to that exact workdir/project_id
 *     and only runs after full success. On any failure, the stack is
 *     left running and its exact workdir/project_id is printed.
 *   - if Docker, the Supabase CLI, or psql is not available, or if the
 *     local Supabase ports are already occupied, the test prints an
 *     explicit SKIP and exits 0 — it never prints a passing result it
 *     did not actually verify.
 *   - no provider/LLM call of any kind, anywhere in this file.
 *   - selects and applies exactly migrations 0001-0052 by number,
 *     ignoring any 0053+ migration present in the repository — a fixed
 *     historical snapshot, never a guard against 0053 existing (D-027
 *     legitimately creates it; see scripts/test-m5-0053-runtime-contract.ts
 *     for its own dedicated harness).
 *
 * Optional environment variables:
 *   ZYPACT_M5_0052_RUNTIME_TEST=1   required opt-in to run anything at all
 *   ZYPACT_DOCKER_BIN_DIR=<path>    prepended to PATH, matching this
 *                                   repo's own local Docker Desktop setup
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "@/lib/evidence/hash";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(reason: string): never {
  console.log(`\nSKIP: ${reason}`);
  console.log(
    "This is not a failure and not a pass — the runtime contract test\n" +
      "requires explicit opt-in and a local Docker/Supabase/psql stack.\n" +
      "No database was touched, no stack was created."
  );
  process.exit(0);
}

const REPO_ROOT = process.cwd();
const DOCKER_BIN_DIR = process.env.ZYPACT_DOCKER_BIN_DIR ?? "";
const RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: DOCKER_BIN_DIR ? `${DOCKER_BIN_DIR}:${process.env.PATH ?? ""}` : process.env.PATH,
};

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { env: RUN_ENV, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function tryRun(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: run(cmd, args) };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? String((err as { stdout?: string }).stdout ?? err.message) : String(err) };
  }
}

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: RUN_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * D-026 correction: pg_temp is session-local -- a helper defined in one
 * psql connection's temp schema is invisible to every other connection,
 * and even within the SAME connection, an unqualified reference to a
 * pg_temp function can fail to resolve (confirmed empirically in the
 * fourth real run: qualified references worked, unqualified ones did
 * not). This preflight runs BEFORE any Docker/Supabase/psql command --
 * pure static self-inspection of this script's own source text -- and
 * fails closed if any callable (non-comment) occurrence of one of the
 * four pg_temp helper names appears without an explicit `pg_temp.`
 * prefix, or if any helper is missing its own qualified definition or
 * at least one qualified call.
 */
function runHelperQualificationPreflight(): void {
  const selfPath = path.join(REPO_ROOT, "scripts", "test-m5-0052-runtime-contract.ts");
  const source = readFileSync(selfPath, "utf8");
  const helperNames = [
    "_m5_runtime_test_helper_capture_provider_receipt_violation",
    "_m5_runtime_test_helper_capture_analysis_receipt_violation",
    "_m5_runtime_test_helper_capture_probe_result_violation",
    "_m5_runtime_test_helper_unique_violation_probe",
  ] as const;

  console.log("\n=== Preflight: pg_temp helper qualification (static self-inspection, before any Docker command) ===");

  const lines = source.split("\n");
  let failed = false;
  const definitionFound = new Map<string, boolean>(helperNames.map((n) => [n, false]));
  const callFound = new Map<string, boolean>(helperNames.map((n) => [n, false]));

  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    const commentIdx = rawLine.indexOf("--");
    for (const name of helperNames) {
      let from = 0;
      for (;;) {
        const at = rawLine.indexOf(name, from);
        if (at === -1) break;
        from = at + name.length;

        const insideComment = commentIdx !== -1 && commentIdx < at;
        if (insideComment) continue; // a documentation mention, never executable SQL

        // Skip this preflight function's own `helperNames` array literal
        // (a plain TypeScript string, e.g. "..._violation",) -- never SQL
        // text, and the one unavoidable place this script must spell each
        // bare name out itself in order to search for it.
        const charBeforeMatch = at > 0 ? rawLine[at - 1] : "";
        if (charBeforeMatch === '"' || charBeforeMatch === "'") continue;

        const precedingSlice = rawLine.slice(Math.max(0, at - 8), at);
        const isQualified = precedingSlice === "pg_temp.";
        if (!isQualified) {
          failed = true;
          console.log(`  ✗ UNQUALIFIED callable occurrence at line ${lineNumber}: ${rawLine.trim()}`);
          continue;
        }

        const beforeQualifier = rawLine.slice(0, at - 8);
        if (/create function\s*$/.test(beforeQualifier)) definitionFound.set(name, true);
        if (/\bfrom\s*$/.test(beforeQualifier)) callFound.set(name, true);
      }
    }
  });

  for (const name of helperNames) {
    if (!definitionFound.get(name)) {
      failed = true;
      console.log(`  ✗ MISSING: no qualified "create function pg_temp.${name}(" definition found`);
    }
    if (!callFound.get(name)) {
      failed = true;
      console.log(`  ✗ MISSING: no qualified call ("... from pg_temp.${name}(") found`);
    }
  }

  if (failed) {
    console.log("\n✗ FATAL: helper-qualification preflight failed -- see occurrences above. No Docker command will run.");
    process.exit(1);
  }
  console.log(
    `✓ All four pg_temp helpers: every callable occurrence across ${lines.length} lines is schema-qualified; each has a qualified definition and at least one qualified call.\n`
  );
}

async function main(): Promise<void> {
  console.log("=== M5 0052 — real runtime contract test for D-026 (durable call payloads, probe_result replay) ===\n");

  console.log(`Repo:   ${REPO_ROOT}`);
  try {
    console.log(`Branch: ${run("git", ["branch", "--show-current"]).trim()}`);
    console.log(`HEAD:   ${run("git", ["rev-parse", "HEAD"]).trim()}`);
  } catch {
    console.log("(git branch/HEAD unavailable — continuing; this does not affect stack safety)");
  }

  if (process.env.ZYPACT_M5_0052_RUNTIME_TEST !== "1") {
    skip(
      "ZYPACT_M5_0052_RUNTIME_TEST is not set to \"1\". Set it explicitly to run this test " +
        "(e.g. ZYPACT_M5_0052_RUNTIME_TEST=1 npx tsx scripts/test-m5-0052-runtime-contract.ts). " +
        "Optionally set ZYPACT_DOCKER_BIN_DIR if Docker's CLI is not already on PATH."
    );
  }

  // ------------------------------------------------------------------
  // 1. Fixed historical snapshot: this harness applies EXACTLY
  //    migrations 0001 through 0052, explicitly selected by number
  //    below (never "everything in the directory"), regardless of how
  //    many later migrations exist in the repository. This is D-026's
  //    own reproducible contract test, frozen at 0052 — it is not a
  //    guard against 0053 existing. 0053 is expected to exist starting
  //    with D-027 (B0.2A-2) and has its own dedicated harness,
  //    scripts/test-m5-0053-runtime-contract.ts, which applies through
  //    0053 and refuses only if 0054 appears — the same ratchet
  //    scripts/test-m5-0051-runtime-contract.ts already applied for
  //    0052.
  // ------------------------------------------------------------------
  const migrationsDirCheck = path.join(REPO_ROOT, "supabase", "migrations");
  console.log(
    `Confirmed: this harness selects migrations 0001-0052 explicitly by number from ${migrationsDirCheck} (0053+ present or not, ignored either way).\n`
  );

  // ------------------------------------------------------------------
  // 1.5. pg_temp helper-qualification preflight -- pure static
  //      self-inspection, no Docker/Supabase/psql command has run yet.
  // ------------------------------------------------------------------
  runHelperQualificationPreflight();

  // ------------------------------------------------------------------
  // 2. Detect Docker / Supabase CLI / psql before any action.
  // ------------------------------------------------------------------
  const dockerVersion = tryRun("docker", ["version"]);
  if (!dockerVersion.ok) skip("Docker is not available (`docker version` failed). No stack created, no database touched.");
  const supabaseVersion = tryRun("supabase", ["--version"]);
  if (!supabaseVersion.ok) skip("The Supabase CLI is not available (`supabase --version` failed). No stack created.");
  const psqlVersion = tryRun("psql", ["--version"]);
  if (!psqlVersion.ok) skip("psql is not available (`psql --version` failed). No stack created.");
  console.log("Docker, Supabase CLI, and psql all detected — proceeding.\n");

  // ------------------------------------------------------------------
  // 3. Local Supabase ports must be free before starting.
  // ------------------------------------------------------------------
  const requiredPorts = [54321, 54322, 54323, 54324];
  for (const port of requiredPorts) {
    const probe = tryRun("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"]);
    if (probe.ok && probe.output.trim().length > 0) {
      console.log(`\n✗ FATAL: local port ${port} is already occupied — refusing to start a disposable stack that could collide.`);
      console.log(probe.output);
      process.exit(1);
    }
  }
  console.log("Confirmed: local Supabase ports (54321-54324) are free.\n");

  // ------------------------------------------------------------------
  // 4. Record every pre-existing container and capture zypact-postgres'
  //    full identity before touching anything.
  // ------------------------------------------------------------------
  const preexistingContainers = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Pre-existing containers recorded (${preexistingContainers.length}): will not be touched.`);

  function captureZypactPostgresIdentity(): string | null {
    if (!preexistingContainers.includes("zypact-postgres")) return null;
    const core = run("docker", [
      "inspect",
      "zypact-postgres",
      "--format",
      "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}",
    ]).trim();
    const ports = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .NetworkSettings.Ports}}"]).trim();
    const networks = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .NetworkSettings.Networks}}"]).trim();
    const mounts = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .Mounts}}"]).trim();
    return `${core}|${ports}|${networks}|${mounts}`;
  }

  const zypactPostgresBaseline = captureZypactPostgresIdentity();
  if (zypactPostgresBaseline !== null) {
    console.log("zypact-postgres baseline captured (ID/StartedAt/RestartCount/health/ports/network/mounts).");
  } else {
    console.log("zypact-postgres is not present in this environment — that specific check will be skipped, not faked.");
  }

  // ------------------------------------------------------------------
  // 5. Disposable stack: unique mktemp workdir/project_id.
  // ------------------------------------------------------------------
  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0052-runtime-"));
  const projectId = path.basename(workdir);
  console.log(`Disposable workdir: ${workdir}`);
  console.log(`Disposable project_id: ${projectId}`);

  let stackStarted = false;
  let succeededFully = false;

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);

    const configPath = path.join(workdir, "supabase", "config.toml");
    const config = readFileSync(configPath, "utf8").replace(
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = true",
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = false"
    );
    writeFileSync(configPath, config);
    check("seed is disabled in the disposable project's config.toml", config.includes("enabled = false"));

    const linkedProjectPath = path.join(workdir, "supabase", ".temp", "linked-project.json");
    check("no linked-project.json exists in the disposable project (never linked, never staging)", !existsSync(linkedProjectPath));

    const sourceMigrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
    const destMigrationsDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(destMigrationsDir, { recursive: true });
    const migrationFiles = readdirSync(sourceMigrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const m = /^(\d{4})_/.exec(f);
        return m !== null && Number(m[1]) <= 52;
      });
    check(
      "exactly migrations numbered 0001-0052 are selected -- 0053 and any later migration are excluded by explicit number",
      migrationFiles.every((f) => {
        const m = /^(\d{4})_/.exec(f);
        return m !== null && Number(m[1]) <= 52;
      })
    );
    for (const f of migrationFiles) {
      copyFileSync(path.join(sourceMigrationsDir, f), path.join(destMigrationsDir, f));
    }
    const byteIdentical = migrationFiles.every(
      (f) => readFileSync(path.join(sourceMigrationsDir, f)).equals(readFileSync(path.join(destMigrationsDir, f)))
    );
    check(
      `all ${migrationFiles.length} migrations (0001-0052) copied byte-identically`,
      byteIdentical &&
        migrationFiles.some((f) => f.includes("0050_m5")) &&
        migrationFiles.some((f) => f.includes("0051_m5")) &&
        migrationFiles.some((f) => f.includes("0052_m5"))
    );

    console.log("\nStarting the disposable Supabase stack (first run may pull Docker images)...");
    run("supabase", ["start", "--workdir", workdir]);
    stackStarted = true;
    console.log("Stack started.\n");

    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

    await runScenarios(dbUrl, workdir);

    succeededFully = failures === 0;
  } catch (err) {
    failures += 1;
    console.log(`\n✗ unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ------------------------------------------------------------------
  // 6. Cleanup — targeted, only after full success.
  // ------------------------------------------------------------------
  if (succeededFully) {
    console.log("\nAll scenarios passed — cleaning up the disposable stack.");
    if (stackStarted) tryRun("supabase", ["stop", "--workdir", workdir, "--no-backup"]);
    if (workdir.startsWith(path.join(tmpdir(), "zypact-m5-0052-runtime-"))) {
      rmSync(workdir, { recursive: true, force: true });
      console.log(`Removed disposable workdir: ${workdir}`);
    }
  } else {
    console.log(
      `\n✗ FAILURE — the disposable stack is PRESERVED for inspection, not cleaned up.\n` +
        `  workdir:     ${workdir}\n` +
        `  project_id:  ${projectId}\n` +
        `  To inspect:  docker ps -a --filter label=com.supabase.cli.project=${projectId}\n` +
        `  To stop it:  supabase stop --workdir ${workdir} --no-backup\n`
    );
  }

  // ------------------------------------------------------------------
  // 7. Prove no pre-existing container, especially zypact-postgres,
  //    was ever touched.
  // ------------------------------------------------------------------
  const stillPresent = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    "every pre-existing container is still present, untouched, by name",
    preexistingContainers.every((name) => stillPresent.includes(name))
  );
  if (zypactPostgresBaseline !== null) {
    const after = captureZypactPostgresIdentity();
    check(
      "zypact-postgres identity (ID/StartedAt/RestartCount/health/ports/network/mounts) unchanged",
      after === zypactPostgresBaseline
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0052 runtime contract PASSED." : "M5 0052 runtime contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);

  async function runScenarios(dbUrl: string, workdirForScript: string): Promise<void> {
    await runScenariosImpl(dbUrl, workdirForScript, check, RUN_ENV);
  }
}

// ----------------------------------------------------------------------
// Scenario execution.
// ----------------------------------------------------------------------

type CheckFn = (name: string, cond: boolean, detail?: string) => void;

function parseMarkers(output: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^##R##\s+(\S+)\s+(.*)$/);
    if (m) results.set(m[1]!, m[2]!.trim());
  }
  return results;
}

const HELPER_SQL = `
create or replace function public._m5_runtime_test_helper_make_fixture(
  p_label text,
  p_run_cap integer default 20,
  p_spend_cap numeric default 100.00,
  p_retry_cap integer default 5,
  p_max_attempts integer default 3,
  p_planned_baseline_runs integer default 1,
  p_planned_retest_runs integer default 0
) returns table (project_id uuid, protocol_id uuid) language plpgsql as $f$
declare
  v_project_id uuid;
  v_bq_id uuid;
  v_bqv_id uuid;
  v_protocol_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
begin
  insert into projects (domain, company_name) values ('m5-0052-runtime-' || p_label || '.test', 'M5 0052 Runtime ' || p_label)
    returning id into v_project_id;
  insert into buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label, 'hash-m5-0052-runtime-' || p_label,
    'shortlist', 4, 3, 10, 'm5 0052 runtime contract fixture', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from approve_buyer_question_version(v_bqv_id, v_project_id, v_actor);
  insert into protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    p_planned_baseline_runs, p_planned_retest_runs, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', p_run_cap, p_spend_cap, 3600,
    1000, 50, p_retry_cap
  ) returning id into v_protocol_id;
  perform status from approve_protocol(v_protocol_id, v_project_id, v_actor);
  return query select v_project_id, v_protocol_id;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_make_fixture(text, integer, numeric, integer, integer, integer, integer) to service_role;

\\echo '##R## helper_installed ok'
`;

async function runScenariosImpl(dbUrl: string, workdir: string, check: CheckFn, runEnv: NodeJS.ProcessEnv): Promise<void> {
  const scratchDir = path.join(workdir, "runtime-scripts");
  mkdirSync(scratchDir, { recursive: true });

  function runPsql(scriptPath: string, onError: "stop" | "continue"): string {
    return execFileSync(
      "psql",
      [dbUrl, "-X", "-q", "-v", `ON_ERROR_STOP=${onError === "stop" ? 1 : 0}`, "-f", scriptPath],
      { env: runEnv, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
    );
  }

  // D-026 correction (observability): execFileSync's return value carries
  // ONLY stdout on success, and stderr is available on the thrown error
  // only on failure -- neither path reliably gives both streams every
  // time. spawnAsync (already used by the real-concurrency scenario)
  // resolves with {code, stdout, stderr} unconditionally, so this variant
  // ALWAYS persists both streams to disk under scratchDir/<outBaseName>
  // .out/.err -- success or failure -- and never throws, so a script-
  // level error can never prevent evaluating (and reporting on) whatever
  // WAS captured. Callers decide for themselves what a non-zero exit
  // means for their own scenario.
  async function runPsqlCapturedAsync(
    scriptPath: string,
    outBaseName: string
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const result = await spawnAsync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath]);
    writeFileSync(path.join(scratchDir, `${outBaseName}.out`), result.stdout);
    writeFileSync(path.join(scratchDir, `${outBaseName}.err`), result.stderr);
    if (result.code !== 0) {
      console.log(
        `  (note: ${outBaseName} exited with code ${result.code} -- full stdout/stderr saved to ${outBaseName}.out/.err; evaluation continues with whatever markers were captured)`
      );
    }
    return result;
  }

  writeFileSync(path.join(scratchDir, "00-helper.sql"), HELPER_SQL);
  runPsql(path.join(scratchDir, "00-helper.sql"), "stop");

  // ======================================================================
  // Part A — catalog/contract checks. Pure system catalog queries proving
  // the real, applied database state matches D-026's redefined signatures
  // and constraints.
  // ======================================================================
  const CONTRACT_SQL = `
\\pset pager off
SET ROLE service_role;

select case when to_regprocedure('public.record_provider_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,integer,numeric,text)') is null then 't' else 'f' end as old_provider_receipt_absent \\gset
select case when to_regprocedure('public.record_provider_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,integer,numeric,text,text)') is not null then 't' else 'f' end as new_provider_receipt_present \\gset
select case when to_regprocedure('public.record_analysis_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,integer,numeric,text)') is null then 't' else 'f' end as old_analysis_receipt_absent \\gset
select case when to_regprocedure('public.record_analysis_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,integer,numeric,text,text)') is not null then 't' else 'f' end as new_analysis_receipt_present \\gset
\\echo '##R## old_provider_receipt_absent' :old_provider_receipt_absent
\\echo '##R## new_provider_receipt_present' :new_provider_receipt_present
\\echo '##R## old_analysis_receipt_absent' :old_analysis_receipt_absent
\\echo '##R## new_analysis_receipt_present' :new_analysis_receipt_present

select case when count(*) = 1 then 't' else 'f' end as provider_pairing_check_present from pg_constraint where conname = 'provider_call_receipts_content_hash_pairing_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as provider_success_check_present from pg_constraint where conname = 'provider_call_receipts_success_requires_content_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as provider_hash_match_check_present from pg_constraint where conname = 'provider_call_receipts_content_hash_match_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as analysis_pairing_check_present from pg_constraint where conname = 'analysis_call_receipts_content_hash_pairing_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as analysis_success_check_present from pg_constraint where conname = 'analysis_call_receipts_success_requires_content_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as analysis_hash_match_check_present from pg_constraint where conname = 'analysis_call_receipts_content_hash_match_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as probe_result_unique_present from pg_constraint where conname = 'probe_results_probe_run_id_key' \\gset
\\echo '##R## provider_pairing_check_present' :provider_pairing_check_present
\\echo '##R## provider_success_check_present' :provider_success_check_present
\\echo '##R## provider_hash_match_check_present' :provider_hash_match_check_present
\\echo '##R## analysis_pairing_check_present' :analysis_pairing_check_present
\\echo '##R## analysis_success_check_present' :analysis_success_check_present
\\echo '##R## analysis_hash_match_check_present' :analysis_hash_match_check_present
\\echo '##R## probe_result_unique_present' :probe_result_unique_present

-- D-026 (correction): dataset_batch_id durable on protocol_execution_jobs.
select case when to_regprocedure('public.create_probe_run_and_start_attempt_for_job(uuid,uuid,uuid,uuid,text,text,uuid,text)') is null then 't' else 'f' end as old_start_attempt_absent \\gset
select case when to_regprocedure('public.create_probe_run_and_start_attempt_for_job(uuid,uuid,uuid,uuid,text,text)') is not null then 't' else 'f' end as new_start_attempt_present \\gset
select case when attnotnull then 't' else 'f' end as dataset_batch_id_not_null from pg_attribute
  where attrelid = 'public.protocol_execution_jobs'::regclass and attname = 'dataset_batch_id' \\gset
select case when count(*) = 1 then 't' else 'f' end as dataset_batch_project_fk_present from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_project_fk' \\gset
select case when count(*) = 1 then 't' else 'f' end as dataset_batch_unique_present from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_id_key' \\gset
\\echo '##R## old_start_attempt_absent' :old_start_attempt_absent
\\echo '##R## new_start_attempt_present' :new_start_attempt_present
\\echo '##R## dataset_batch_id_not_null' :dataset_batch_id_not_null
\\echo '##R## dataset_batch_project_fk_present' :dataset_batch_project_fk_present
\\echo '##R## dataset_batch_unique_present' :dataset_batch_unique_present
`;

  writeFileSync(path.join(scratchDir, "01-contract.sql"), CONTRACT_SQL);
  const contractOutput = runPsql(path.join(scratchDir, "01-contract.sql"), "stop");
  const contractResults = parseMarkers(contractOutput);
  const c = (label: string) => contractResults.get(label) ?? "<MISSING>";

  check("old 12-arg record_provider_call_receipt_for_job is genuinely absent from the catalog", c("old_provider_receipt_absent") === "t");
  check("new 13-arg record_provider_call_receipt_for_job exists", c("new_provider_receipt_present") === "t");
  check("old 14-arg record_analysis_call_receipt_for_job is genuinely absent from the catalog", c("old_analysis_receipt_absent") === "t");
  check("new 15-arg record_analysis_call_receipt_for_job exists", c("new_analysis_receipt_present") === "t");
  check("provider_call_receipts_content_hash_pairing_check exists", c("provider_pairing_check_present") === "t");
  check("provider_call_receipts_success_requires_content_check exists", c("provider_success_check_present") === "t");
  check("provider_call_receipts_content_hash_match_check exists", c("provider_hash_match_check_present") === "t");
  check("analysis_call_receipts_content_hash_pairing_check exists", c("analysis_pairing_check_present") === "t");
  check("analysis_call_receipts_success_requires_content_check exists", c("analysis_success_check_present") === "t");
  check("analysis_call_receipts_content_hash_match_check exists", c("analysis_hash_match_check_present") === "t");
  check("probe_results_probe_run_id_key (real UNIQUE(probe_run_id)) exists", c("probe_result_unique_present") === "t");
  check("old 8-arg create_probe_run_and_start_attempt_for_job (with caller-supplied dataset args) is genuinely absent from the catalog", c("old_start_attempt_absent") === "t");
  check("new 6-arg create_probe_run_and_start_attempt_for_job exists", c("new_start_attempt_present") === "t");
  check("protocol_execution_jobs.dataset_batch_id is a real NOT NULL column", c("dataset_batch_id_not_null") === "t");
  check("protocol_execution_jobs_dataset_batch_project_fk (composite, project-scoped) exists", c("dataset_batch_project_fk_present") === "t");
  check("protocol_execution_jobs_dataset_batch_id_key (real UNIQUE(dataset_batch_id)) exists", c("dataset_batch_unique_present") === "t");

  // ======================================================================
  // Part B — business scenarios. Each in its own BEGIN/ROLLBACK.
  // Constraint-violation attempts use SAVEPOINT/ROLLBACK TO SAVEPOINT
  // around the single violating statement, exactly like s12's fault
  // injection in scripts/test-m5-0051-runtime-contract.ts, so a real
  // Postgres error does not abort the whole enclosing scenario.
  // ======================================================================
  const BUSINESS_SQL = `
\\pset pager off
\\set ON_ERROR_STOP off

-- ======================================================================
-- Constraint-violation capture helpers (D-026 correction, exhaustive
-- review). Created in pg_temp -- session-scoped, never a permanent
-- public-schema object -- while the CURRENT role is still postgres (this
-- connection's own login/superuser role), so each is OWNED by postgres:
-- SECURITY DEFINER therefore elevates to postgres's privileges
-- regardless of the caller's own grants, exactly like every real
-- application RPC already does. Each wraps exactly one real mutation in
-- its own BEGIN/EXCEPTION block and reports back the SQLSTATE and
-- constraint name via GET STACKED DIAGNOSTICS -- never inferred from "an
-- error occurred" or from row counts alone, and no other exception is
-- ever mistaken for success (v_sqlstate stays the real, captured
-- SQLSTATE for any exception, 'NONE' only when nothing was raised at
-- all). REVOKE ALL from public/anon/authenticated, then GRANT EXECUTE to
-- service_role only -- the same explicit, per-role ACL pattern the real
-- RPCs already use, proven below by three genuine SET ROLE probes per
-- helper (anon, authenticated, service_role), not merely asserted.
--
-- Each provider/analysis helper's p_outcome is caller-supplied,
-- specifically so the pairing violation can be isolated from
-- success_requires_content: passing outcome='provider_error' makes
-- success_requires_content_check's own left-hand clause (outcome <>
-- 'success') true regardless of content, so it can never fire; pairing
-- with a hash but no body then leaves content_hash_match_check
-- satisfied too (body IS NULL short-circuits it) -- only
-- content_hash_pairing_check is left able to fail. This removes any
-- dependency on constraint evaluation order or OID -- the pairing test
-- can violate exactly one constraint by construction, not by observed
-- ordering.
-- ======================================================================
create function pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(
  p_job_id uuid,
  p_claim_token uuid,
  p_project_id uuid,
  p_external_call_id uuid,
  p_probe_run_id uuid,
  p_outcome text,
  p_http_status integer,
  p_provider_request_id text,
  p_raw_response_sha256 text,
  p_latency_ms integer,
  p_raw_response_body text
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_sqlstate text;
  v_constraint text;
begin
  begin
    perform status from record_provider_call_receipt_for_job(
      p_job_id, p_claim_token, p_project_id, p_external_call_id, p_probe_run_id,
      p_outcome, p_http_status, p_provider_request_id, p_raw_response_sha256,
      p_latency_ms, null, null, p_raw_response_body
    );
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;
  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, text) from public;
revoke all on function pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, text) from anon;
revoke all on function pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, text) from authenticated;
grant execute on function pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, text) to service_role;

create function pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(
  p_job_id uuid,
  p_claim_token uuid,
  p_project_id uuid,
  p_external_call_id uuid,
  p_probe_run_id uuid,
  p_outcome text,
  p_response_sha256 text,
  p_raw_content text
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_sqlstate text;
  v_constraint text;
begin
  begin
    perform status from record_analysis_call_receipt_for_job(
      p_job_id, p_claim_token, p_project_id, p_external_call_id, p_probe_run_id,
      p_outcome, 'openai', 'gpt-4o-mini', false, null, p_response_sha256,
      200, null, null, p_raw_content
    );
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;
  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, text, text) from public;
revoke all on function pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, text, text) from anon;
revoke all on function pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, text, text) from authenticated;
grant execute on function pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(uuid, uuid, uuid, uuid, uuid, text, text, text) to service_role;

create function pg_temp._m5_runtime_test_helper_capture_probe_result_violation(
  p_project_id uuid,
  p_probe_run_id uuid
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_sqlstate text;
  v_constraint text;
begin
  begin
    insert into probe_results (
      probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
      competitors_mentioned, sources_cited, verdict, dataset_id, dataset_source_type
    )
    select p_probe_run_id, p_project_id, 'a second, duplicate attempt', 'perplexity', 'should never be allowed', false, 'absent',
      '[]'::jsonb, '[]'::jsonb, 'lost', pr.dataset_id, pr.dataset_source_type
      from probe_runs pr where pr.id = p_probe_run_id;
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;
  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_runtime_test_helper_capture_probe_result_violation(uuid, uuid) from public;
revoke all on function pg_temp._m5_runtime_test_helper_capture_probe_result_violation(uuid, uuid) from anon;
revoke all on function pg_temp._m5_runtime_test_helper_capture_probe_result_violation(uuid, uuid) from authenticated;
grant execute on function pg_temp._m5_runtime_test_helper_capture_probe_result_violation(uuid, uuid) to service_role;

-- Preflight: each helper must resolve via its EXACT, schema-qualified
-- signature in THIS session's pg_temp before any scenario below is
-- allowed to depend on it -- to_regprocedure returns NULL for a
-- signature that does not exist (it never raises), so this is a clean,
-- assertable precondition rather than a try/catch.
select to_regprocedure('pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,integer,text)') is not null as preflight_provider_helper \\gset
select to_regprocedure('pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(uuid,uuid,uuid,uuid,uuid,text,text,text)') is not null as preflight_analysis_helper \\gset
select to_regprocedure('pg_temp._m5_runtime_test_helper_capture_probe_result_violation(uuid,uuid)') is not null as preflight_probe_result_helper \\gset
\\echo '##R## preflight_provider_helper' :preflight_provider_helper
\\echo '##R## preflight_analysis_helper' :preflight_analysis_helper
\\echo '##R## preflight_probe_result_helper' :preflight_probe_result_helper

-- ACL proof: a shared, PUBLIC-usable temp table so the DO blocks below
-- can record their result regardless of which role is active when they
-- run (GRANT ALL is scoped to this session's temp table alone, never a
-- permanent object). Each DO block below runs AFTER its own SET ROLE, so
-- it genuinely exercises that role's own EXECUTE privilege on the
-- pg_temp helper -- not a separate connection (which could never see
-- this session's pg_temp schema at all, since temp schemas are
-- session-local). SQLSTATE 42501 is insufficient_privilege -- the same
-- class Postgres raises whether the denial is at the function level or
-- the schema level, so this assertion is robust to either specific
-- wording.
create temp table _m5_acl_probe (label text primary key, sqlstate_captured text);
grant all on _m5_acl_probe to public;

create function pg_temp._m5_acl_probe_run(p_label_prefix text) returns void
language plpgsql
as $f$
begin
  begin
    perform sqlstate_captured from pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', 'provider_error', null, null, null, null, null
    );
    insert into _m5_acl_probe values (p_label_prefix || '_provider', 'NONE');
  exception when others then
    insert into _m5_acl_probe values (p_label_prefix || '_provider', sqlstate);
  end;
  begin
    perform sqlstate_captured from pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', 'provider_error', null, null
    );
    insert into _m5_acl_probe values (p_label_prefix || '_analysis', 'NONE');
  exception when others then
    insert into _m5_acl_probe values (p_label_prefix || '_analysis', sqlstate);
  end;
  begin
    perform sqlstate_captured from pg_temp._m5_runtime_test_helper_capture_probe_result_violation(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000'
    );
    insert into _m5_acl_probe values (p_label_prefix || '_probe_result', 'NONE');
  exception when others then
    insert into _m5_acl_probe values (p_label_prefix || '_probe_result', sqlstate);
  end;
end;
$f$;
-- _m5_acl_probe_run itself needs no ACL restriction of its own: it is
-- plain SECURITY INVOKER, so each call below still genuinely exercises
-- the CALLING role's own privilege on the three target helpers -- this
-- wrapper only avoids repeating the same three-probe body three times.
grant execute on function pg_temp._m5_acl_probe_run(text) to public;

SET ROLE anon;
select pg_temp._m5_acl_probe_run('anon');
RESET ROLE;

SET ROLE authenticated;
select pg_temp._m5_acl_probe_run('authenticated');
RESET ROLE;

SET ROLE service_role;
select pg_temp._m5_acl_probe_run('service_role');

select sqlstate_captured as acl_anon_provider from _m5_acl_probe where label = 'anon_provider' \\gset
select sqlstate_captured as acl_anon_analysis from _m5_acl_probe where label = 'anon_analysis' \\gset
select sqlstate_captured as acl_anon_probe_result from _m5_acl_probe where label = 'anon_probe_result' \\gset
select sqlstate_captured as acl_authenticated_provider from _m5_acl_probe where label = 'authenticated_provider' \\gset
select sqlstate_captured as acl_authenticated_analysis from _m5_acl_probe where label = 'authenticated_analysis' \\gset
select sqlstate_captured as acl_authenticated_probe_result from _m5_acl_probe where label = 'authenticated_probe_result' \\gset
select sqlstate_captured as acl_service_role_provider from _m5_acl_probe where label = 'service_role_provider' \\gset
select sqlstate_captured as acl_service_role_analysis from _m5_acl_probe where label = 'service_role_analysis' \\gset
select sqlstate_captured as acl_service_role_probe_result from _m5_acl_probe where label = 'service_role_probe_result' \\gset
\\echo '##R## acl_anon_provider' :acl_anon_provider
\\echo '##R## acl_anon_analysis' :acl_anon_analysis
\\echo '##R## acl_anon_probe_result' :acl_anon_probe_result
\\echo '##R## acl_authenticated_provider' :acl_authenticated_provider
\\echo '##R## acl_authenticated_analysis' :acl_authenticated_analysis
\\echo '##R## acl_authenticated_probe_result' :acl_authenticated_probe_result
\\echo '##R## acl_service_role_provider' :acl_service_role_provider
\\echo '##R## acl_service_role_analysis' :acl_service_role_analysis
\\echo '##R## acl_service_role_probe_result' :acl_service_role_probe_result

-- ============================================================
-- s0 (D-026 correction): planned_baseline_runs = 0 -> NO_BASELINE_RUNS_
-- PLANNED, creating neither a job nor a dataset_batches row -- checked
-- against real, project-scoped row counts, not just the RPC's own
-- reported outcome.
-- ============================================================
BEGIN;
select project_id as s0_proj, protocol_id as s0_proto
  from _m5_runtime_test_helper_make_fixture('s0', 20, 100.00, 5, 3, 0, 0) \\gset
select status as s0_status, (job) is null as s0_job_is_null
  from enqueue_protocol_execution_job(:'s0_proto', :'s0_proj', 3) \\gset
select count(*)::text as s0_job_count from protocol_execution_jobs where project_id = :'s0_proj' \\gset
select count(*)::text as s0_batch_count from dataset_batches where project_id = :'s0_proj' \\gset
\\echo '##R## s0_status' :s0_status
\\echo '##R## s0_job_is_null' :s0_job_is_null
\\echo '##R## s0_job_count' :s0_job_count
\\echo '##R## s0_batch_count' :s0_batch_count
ROLLBACK;

-- ============================================================
-- s1: a real, matching content/hash pair on both legs succeeds and is
-- stored verbatim. The expected hash is computed client-side, in
-- TypeScript, on the exact UTF-8 bytes (sha256Hex, the same helper the
-- adapter tests already use) -- never by calling public._sha256_hex
-- directly from this script under service_role, since that function has
-- no grant to any role at all (see the ACL section's assertion). The
-- real server-side verification is the CHECK constraint itself, which
-- calls _sha256_hex from inside its own expression and therefore is not
-- subject to the caller's EXECUTE privilege.
-- Also proves: a replay enqueue for the same protocol returns
-- ALREADY_EXISTS with the identical job/dataset (never a second batch),
-- and that the stored content is recoverable through
-- get_protocol_execution_job_context's own receipt arrays, not merely
-- by querying provider_call_receipts/analysis_call_receipts directly.
-- ============================================================
BEGIN;
select project_id as s1_proj, protocol_id as s1_proto from _m5_runtime_test_helper_make_fixture('s1') \\gset
select (job).id as s1_job, (job).dataset_batch_id as s1_dataset from enqueue_protocol_execution_job(:'s1_proto', :'s1_proj', 3) \\gset

select status as s1_replay_status, (job).id as s1_replay_job, (job).dataset_batch_id as s1_replay_dataset
  from enqueue_protocol_execution_job(:'s1_proto', :'s1_proj', 3) \\gset
select count(*)::text as s1_batch_count_after_replay from dataset_batches where project_id = :'s1_proj' \\gset

select claim_token as s1_token from claim_protocol_execution_job('worker-s1', 300) \\gset
select (attempt).id as s1_attempt, (perplexity_call).id as s1_pcall, (analysis_call).id as s1_acall
  from admit_and_reserve_attempt_for_job(:'s1_job', :'s1_token', :'s1_proj', 'baseline', (:'s1_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s1_job', :'s1_token', :'s1_proj', :'s1_attempt', 'perplexity', 'simulated');
select probe_run_id as s1_probe_run from protocol_attempts where id = :'s1_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s1_job', :'s1_token', :'s1_proj', :'s1_pcall', :'s1_probe_run');
select status as s1_receipt_status, (receipt).raw_response_body as s1_receipt_body, (receipt).raw_response_sha256 as s1_receipt_hash
  from record_provider_call_receipt_for_job(:'s1_job', :'s1_token', :'s1_proj', :'s1_pcall', :'s1_probe_run', 'success', 200, 'req-1', '${sha256Hex("the real perplexity answer")}', 400, null, null, 'the real perplexity answer') \\gset
select status from mark_external_call_sent_for_job(:'s1_job', :'s1_token', :'s1_proj', :'s1_acall', :'s1_probe_run');
select status as s1_analysis_status, (receipt).raw_content as s1_analysis_content
  from record_analysis_call_receipt_for_job(:'s1_job', :'s1_token', :'s1_proj', :'s1_acall', :'s1_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, '${sha256Hex("the real analysis output")}', 200, null, null, 'the real analysis output') \\gset

select
  (select r.raw_response_body from unnest(provider_receipts) r where r.external_call_id = :'s1_pcall') as s1_ctx_provider_body,
  (select r.raw_content from unnest(analysis_receipts) r where r.external_call_id = :'s1_acall') as s1_ctx_analysis_content
  from get_protocol_execution_job_context(:'s1_job', :'s1_token', :'s1_proj') \\gset

\\echo '##R## s1_receipt_status' :s1_receipt_status
\\echo '##R## s1_receipt_body' :s1_receipt_body
\\echo '##R## s1_analysis_status' :s1_analysis_status
\\echo '##R## s1_analysis_content' :s1_analysis_content
\\echo '##R## s1_replay_status' :s1_replay_status
\\echo '##R## s1_replay_job' :s1_replay_job
\\echo '##R## s1_job' :s1_job
\\echo '##R## s1_replay_dataset' :s1_replay_dataset
\\echo '##R## s1_dataset' :s1_dataset
\\echo '##R## s1_batch_count_after_replay' :s1_batch_count_after_replay
\\echo '##R## s1_ctx_provider_body' :s1_ctx_provider_body
\\echo '##R## s1_ctx_analysis_content' :s1_ctx_analysis_content
ROLLBACK;

-- ============================================================
-- s2 (D-026, corrected): the three real CHECK constraints on the
-- Perplexity leg, each proven by its own EXACT constraint name and
-- SQLSTATE, captured via GET STACKED DIAGNOSTICS inside
-- pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation --
-- always schema-qualified (pg_temp is session-local; see the preflight
-- and to_regprocedure checks below) -- never inferred from "an error
-- occurred" or from row counts alone. The same
-- external call is reused for all three attempts since the helper's own
-- exception handling means none of them ever mutates it.
-- ============================================================
BEGIN;
select project_id as s2_proj, protocol_id as s2_proto from _m5_runtime_test_helper_make_fixture('s2') \\gset
select (job).id as s2_job, (job).dataset_batch_id as s2_dataset from enqueue_protocol_execution_job(:'s2_proto', :'s2_proj', 3) \\gset
select claim_token as s2_token from claim_protocol_execution_job('worker-s2', 300) \\gset
select (attempt).id as s2_attempt, (perplexity_call).id as s2_pcall
  from admit_and_reserve_attempt_for_job(:'s2_job', :'s2_token', :'s2_proj', 'baseline', (:'s2_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s2_job', :'s2_token', :'s2_proj', :'s2_attempt', 'perplexity', 'simulated');
select probe_run_id as s2_probe_run from protocol_attempts where id = :'s2_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s2_job', :'s2_token', :'s2_proj', :'s2_pcall', :'s2_probe_run');
select count(*)::text as s2_receipts_before from provider_call_receipts where external_call_id = :'s2_pcall' \\gset

-- Pairing, isolated: outcome='provider_error' (never 'success'), so
-- success_requires_content_check's own left-hand clause is already true
-- regardless of content -- it cannot fire. A hash with no body then
-- leaves content_hash_match_check satisfied too (body IS NULL
-- short-circuits it) -- only content_hash_pairing_check can fail. No
-- dependency on constraint evaluation order or OID.
select sqlstate_captured as s2_pairing_sqlstate, constraint_captured as s2_pairing_constraint
  from pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(
    :'s2_job', :'s2_token', :'s2_proj', :'s2_pcall', :'s2_probe_run',
    'provider_error', 200, 'req-2', '${sha256Hex("anything")}', 400, null
  ) \\gset

-- Success-requires-content: outcome success, neither body nor hash --
-- pairing is satisfied (both null), hash-match short-circuits (body
-- null) -- only this constraint can fail.
select sqlstate_captured as s2_success_sqlstate, constraint_captured as s2_success_constraint
  from pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(
    :'s2_job', :'s2_token', :'s2_proj', :'s2_pcall', :'s2_probe_run',
    'success', 200, 'req-2', null, 400, null
  ) \\gset

-- Hash mismatch: outcome success, a real body, a deliberately wrong
-- hash -- pairing and success-requires-content are both satisfied
-- (body present) -- only this constraint can fail.
select sqlstate_captured as s2_hashmismatch_sqlstate, constraint_captured as s2_hashmismatch_constraint
  from pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation(
    :'s2_job', :'s2_token', :'s2_proj', :'s2_pcall', :'s2_probe_run',
    'success', 200, 'req-2', repeat('0', 64), 400, 'the real answer text'
  ) \\gset

select count(*)::text as s2_receipts_after from provider_call_receipts where external_call_id = :'s2_pcall' \\gset
select status as s2_status from protocol_external_calls where id = :'s2_pcall' \\gset
\\echo '##R## s2_receipts_before' :s2_receipts_before
\\echo '##R## s2_receipts_after' :s2_receipts_after
\\echo '##R## s2_status' :s2_status
\\echo '##R## s2_pairing_sqlstate' :s2_pairing_sqlstate
\\echo '##R## s2_pairing_constraint' :s2_pairing_constraint
\\echo '##R## s2_success_sqlstate' :s2_success_sqlstate
\\echo '##R## s2_success_constraint' :s2_success_constraint
\\echo '##R## s2_hashmismatch_sqlstate' :s2_hashmismatch_sqlstate
\\echo '##R## s2_hashmismatch_constraint' :s2_hashmismatch_constraint
ROLLBACK;

-- ============================================================
-- s3 (D-026, corrected): the same three constraints on the analysis
-- leg, each proven by its own EXACT constraint name and SQLSTATE via
-- pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation.
-- ============================================================
BEGIN;
select project_id as s3_proj, protocol_id as s3_proto from _m5_runtime_test_helper_make_fixture('s3') \\gset
select (job).id as s3_job, (job).dataset_batch_id as s3_dataset from enqueue_protocol_execution_job(:'s3_proto', :'s3_proj', 3) \\gset
select claim_token as s3_token from claim_protocol_execution_job('worker-s3', 300) \\gset
select (attempt).id as s3_attempt, (analysis_call).id as s3_acall
  from admit_and_reserve_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', 'baseline', (:'s3_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_attempt', 'perplexity', 'simulated');
select probe_run_id as s3_probe_run from protocol_attempts where id = :'s3_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run');
select count(*)::text as s3_receipts_before from analysis_call_receipts where external_call_id = :'s3_acall' \\gset

-- Pairing, isolated: outcome='provider_error', a hash with no content --
-- same isolation argument as s2's pairing test, applied to the analysis
-- leg. Only content_hash_pairing_check can fail.
select sqlstate_captured as s3_pairing_sqlstate, constraint_captured as s3_pairing_constraint
  from pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run',
    'provider_error', '${sha256Hex("anything")}', null
  ) \\gset

-- Success-requires-content: outcome success, neither content nor hash.
select sqlstate_captured as s3_success_sqlstate, constraint_captured as s3_success_constraint
  from pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run',
    'success', null, null
  ) \\gset

-- Hash mismatch: outcome success, real content, a deliberately wrong hash.
select sqlstate_captured as s3_hashmismatch_sqlstate, constraint_captured as s3_hashmismatch_constraint
  from pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run',
    'success', repeat('0', 64), 'the real analysis output'
  ) \\gset

select count(*)::text as s3_receipts_after from analysis_call_receipts where external_call_id = :'s3_acall' \\gset
select status as s3_status from protocol_external_calls where id = :'s3_acall' \\gset
\\echo '##R## s3_receipts_before' :s3_receipts_before
\\echo '##R## s3_receipts_after' :s3_receipts_after
\\echo '##R## s3_status' :s3_status
\\echo '##R## s3_pairing_sqlstate' :s3_pairing_sqlstate
\\echo '##R## s3_pairing_constraint' :s3_pairing_constraint
\\echo '##R## s3_success_sqlstate' :s3_success_sqlstate
\\echo '##R## s3_success_constraint' :s3_success_constraint
\\echo '##R## s3_hashmismatch_sqlstate' :s3_hashmismatch_sqlstate
\\echo '##R## s3_hashmismatch_constraint' :s3_hashmismatch_constraint
ROLLBACK;

-- ============================================================
-- s4 (D-026, corrected): probe_results_probe_run_id_key -- a real
-- UNIQUE violation, its EXACT constraint name and SQLSTATE captured via
-- pg_temp._m5_runtime_test_helper_capture_probe_result_violation, not
-- merely a MemoryAdapter-only mirror and not merely inferred from row counts.
-- ============================================================
BEGIN;
select project_id as s4_proj from _m5_runtime_test_helper_make_fixture('s4') \\gset
insert into dataset_batches (project_id, dataset_source_type) values (:'s4_proj', 'manual_scan') returning id as s4_dataset \\gset
insert into probe_runs (project_id, platform, status, probe_mode, dataset_id, dataset_source_type)
  values (:'s4_proj', 'perplexity', 'succeeded', 'simulated', :'s4_dataset', 'manual_scan')
  returning id as s4_probe_run \\gset
-- dataset_id/dataset_source_type are real, NOT NULL columns on
-- probe_results (migration 0040) -- derived here from the real
-- probe_runs row via INSERT ... SELECT, never a literal/omitted value.
insert into probe_results (
  probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
  competitors_mentioned, sources_cited, verdict, dataset_id, dataset_source_type
)
select :'s4_probe_run', :'s4_proj', 'fixture prompt', 'perplexity', 'first result', true, 'primary',
  '[]'::jsonb, '[]'::jsonb, 'won', pr.dataset_id, pr.dataset_source_type
  from probe_runs pr where pr.id = :'s4_probe_run';
select count(*)::text as s4_results_before from probe_results where probe_run_id = :'s4_probe_run' \\gset

select sqlstate_captured as s4_dupe_sqlstate, constraint_captured as s4_dupe_constraint
  from pg_temp._m5_runtime_test_helper_capture_probe_result_violation(:'s4_proj', :'s4_probe_run') \\gset

select count(*)::text as s4_results_after from probe_results where probe_run_id = :'s4_probe_run' \\gset
\\echo '##R## s4_results_before' :s4_results_before
\\echo '##R## s4_results_after' :s4_results_after
\\echo '##R## s4_dupe_sqlstate' :s4_dupe_sqlstate
\\echo '##R## s4_dupe_constraint' :s4_dupe_constraint
ROLLBACK;

-- ============================================================
-- s5 (D-026): get_protocol_execution_job_context surfaces probe_result
-- -- null before it exists, populated once saved, under the same fenced
-- snapshot as everything else the RPC already returns.
-- ============================================================
BEGIN;
select project_id as s5_proj, protocol_id as s5_proto from _m5_runtime_test_helper_make_fixture('s5') \\gset
select (job).id as s5_job, (job).dataset_batch_id as s5_dataset from enqueue_protocol_execution_job(:'s5_proto', :'s5_proj', 3) \\gset
select claim_token as s5_token from claim_protocol_execution_job('worker-s5', 300) \\gset
select (attempt).id as s5_attempt from admit_and_reserve_attempt_for_job(:'s5_job', :'s5_token', :'s5_proj', 'baseline', (:'s5_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_attempt', 'perplexity', 'simulated');
select probe_run_id as s5_probe_run from protocol_attempts where id = :'s5_attempt' \\gset

select coalesce((probe_result).id::text, 'NULL') as s5_probe_result_before
  from get_protocol_execution_job_context(:'s5_job', :'s5_token', :'s5_proj') \\gset

-- dataset_id/dataset_source_type derived from the real probe_runs row,
-- same discipline as s4.
insert into probe_results (
  probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
  competitors_mentioned, sources_cited, verdict, dataset_id, dataset_source_type
)
select :'s5_probe_run', :'s5_proj', 'fixture prompt', 'perplexity', 'fixture raw response', true, 'primary',
  '[]'::jsonb, '[]'::jsonb, 'won', pr.dataset_id, pr.dataset_source_type
  from probe_runs pr where pr.id = :'s5_probe_run'
  returning id as s5_saved_result \\gset

select coalesce((probe_result).id::text, 'NULL') as s5_probe_result_after,
       coalesce((probe_result).probe_run_id::text, 'NULL') as s5_probe_result_run
  from get_protocol_execution_job_context(:'s5_job', :'s5_token', :'s5_proj') \\gset
\\echo '##R## s5_probe_result_before' :s5_probe_result_before
\\echo '##R## s5_probe_result_after' :s5_probe_result_after
\\echo '##R## s5_saved_result' :s5_saved_result
\\echo '##R## s5_probe_result_run' :s5_probe_result_run
\\echo '##R## s5_probe_run' :s5_probe_run
ROLLBACK;

`;

  writeFileSync(path.join(scratchDir, "02-business.sql"), BUSINESS_SQL);
  const businessOutput = runPsql(path.join(scratchDir, "02-business.sql"), "continue");
  writeFileSync(path.join(scratchDir, "02-business.out.log"), businessOutput);
  const r = (label: string) => parseMarkers(businessOutput).get(label) ?? "<MISSING>";

  check(
    "preflight: pg_temp._m5_runtime_test_helper_capture_provider_receipt_violation resolves via to_regprocedure with its exact 11-arg signature, in this same session, before any scenario depends on it",
    r("preflight_provider_helper") === "t"
  );
  check(
    "preflight: pg_temp._m5_runtime_test_helper_capture_analysis_receipt_violation resolves via to_regprocedure with its exact 8-arg signature",
    r("preflight_analysis_helper") === "t"
  );
  check(
    "preflight: pg_temp._m5_runtime_test_helper_capture_probe_result_violation resolves via to_regprocedure with its exact 2-arg signature",
    r("preflight_probe_result_helper") === "t"
  );
  check(
    "ACL (pg_temp helpers): anon cannot execute the provider-receipt violation helper -- SQLSTATE 42501 (insufficient_privilege), proven by a genuine SET ROLE within this same session, not merely asserted",
    r("acl_anon_provider") === "42501"
  );
  check(
    "ACL (pg_temp helpers): anon cannot execute the analysis-receipt violation helper -- SQLSTATE 42501",
    r("acl_anon_analysis") === "42501"
  );
  check(
    "ACL (pg_temp helpers): anon cannot execute the probe_results violation helper -- SQLSTATE 42501",
    r("acl_anon_probe_result") === "42501"
  );
  check(
    "ACL (pg_temp helpers): authenticated cannot execute the provider-receipt violation helper -- SQLSTATE 42501",
    r("acl_authenticated_provider") === "42501"
  );
  check(
    "ACL (pg_temp helpers): authenticated cannot execute the analysis-receipt violation helper -- SQLSTATE 42501",
    r("acl_authenticated_analysis") === "42501"
  );
  check(
    "ACL (pg_temp helpers): authenticated cannot execute the probe_results violation helper -- SQLSTATE 42501",
    r("acl_authenticated_probe_result") === "42501"
  );
  check(
    "ACL (pg_temp helpers): service_role CAN execute the provider-receipt violation helper -- reaches the function body (JOB_NOT_FOUND on dummy args, no exception), never a permission error",
    r("acl_service_role_provider") === "NONE"
  );
  check(
    "ACL (pg_temp helpers): service_role CAN execute the analysis-receipt violation helper",
    r("acl_service_role_analysis") === "NONE"
  );
  check(
    "ACL (pg_temp helpers): service_role CAN execute the probe_results violation helper",
    r("acl_service_role_probe_result") === "NONE"
  );
  check(
    "s1: a matching content/hash pair on both legs succeeds; the receipt stores the content verbatim",
    r("s1_receipt_status") === "RECEIPTED" &&
      r("s1_receipt_body") === "the real perplexity answer" &&
      r("s1_analysis_status") === "RECEIPTED" &&
      r("s1_analysis_content") === "the real analysis output"
  );
  check(
    "s2: all three Perplexity-leg content/hash violations produce zero receipts and leave the external call exactly in_progress",
    r("s2_receipts_before") === "0" && r("s2_receipts_after") === "0" && r("s2_status") === "in_progress"
  );
  check(
    "s2 pairing: isolated via outcome='provider_error' (success_requires_content_check cannot fire) with a hash and no body (hash_match_check short-circuits on body IS NULL) -- rejected by EXACTLY provider_call_receipts_content_hash_pairing_check, SQLSTATE 23514, never dependent on constraint evaluation order",
    r("s2_pairing_sqlstate") === "23514" && r("s2_pairing_constraint") === "provider_call_receipts_content_hash_pairing_check"
  );
  check(
    "s2 success-requires-content: rejected by EXACTLY provider_call_receipts_success_requires_content_check, SQLSTATE 23514",
    r("s2_success_sqlstate") === "23514" && r("s2_success_constraint") === "provider_call_receipts_success_requires_content_check"
  );
  check(
    "s2 hash-mismatch: rejected by EXACTLY provider_call_receipts_content_hash_match_check, SQLSTATE 23514",
    r("s2_hashmismatch_sqlstate") === "23514" && r("s2_hashmismatch_constraint") === "provider_call_receipts_content_hash_match_check"
  );
  check(
    "s3: all three analysis-leg content/hash violations produce zero receipts and leave the external call exactly in_progress",
    r("s3_receipts_before") === "0" && r("s3_receipts_after") === "0" && r("s3_status") === "in_progress"
  );
  check(
    "s3 pairing: isolated via outcome='provider_error' with a hash and no content -- rejected by EXACTLY analysis_call_receipts_content_hash_pairing_check, SQLSTATE 23514, never dependent on constraint evaluation order",
    r("s3_pairing_sqlstate") === "23514" && r("s3_pairing_constraint") === "analysis_call_receipts_content_hash_pairing_check"
  );
  check(
    "s3 success-requires-content: rejected by EXACTLY analysis_call_receipts_success_requires_content_check, SQLSTATE 23514",
    r("s3_success_sqlstate") === "23514" && r("s3_success_constraint") === "analysis_call_receipts_success_requires_content_check"
  );
  check(
    "s3 hash-mismatch: rejected by EXACTLY analysis_call_receipts_content_hash_match_check, SQLSTATE 23514",
    r("s3_hashmismatch_sqlstate") === "23514" && r("s3_hashmismatch_constraint") === "analysis_call_receipts_content_hash_match_check"
  );
  check(
    "s4: a second probe_results row for the same probe_run_id leaves the table unchanged (before=after=1)",
    r("s4_results_before") === "1" && r("s4_results_after") === "1"
  );
  check(
    "s4: rejected by EXACTLY probe_results_probe_run_id_key, SQLSTATE 23505 -- captured via GET STACKED DIAGNOSTICS, not a MemoryAdapter-only mirror and not inferred from row counts alone",
    r("s4_dupe_sqlstate") === "23505" && r("s4_dupe_constraint") === "probe_results_probe_run_id_key"
  );
  check(
    "s5: get_protocol_execution_job_context reports probe_result NULL before any row is saved, then the exact saved row afterward, under the current attempt's own probe_run",
    r("s5_probe_result_before") === "NULL" &&
      r("s5_probe_result_after") === r("s5_saved_result") &&
      r("s5_probe_result_run") === r("s5_probe_run")
  );
  // ======================================================================
  // s6 (D-026 correction), corrected: the lease-expiry UPDATE and the
  // unique-violation INSERT into protocol_execution_jobs are ADMINISTRATIVE
  // FIXTURE PREPARATION, not application traffic -- protocol_execution_jobs
  // carries only a SELECT grant for service_role (0050); every real write
  // to it goes exclusively through the SECURITY DEFINER RPCs, which run as
  // the function owner regardless of the caller's own grants. Simulating
  // "the lease already expired" or "a second job already exists" by
  // mutating the table directly is therefore never something the
  // application's own service_role connection could do -- it must run as
  // the table owner (postgres, the login role for this disposable
  // database), in its own genuinely committed transaction, with an
  // explicit current_user check on both sides of the transition so there
  // is no ambiguity about which role is in effect. Every other statement
  // in this scenario -- every RPC call -- still runs as service_role,
  // restored explicitly immediately after each administrative step.
  //
  // This also means s6 can no longer be a single ROLLBACK-based
  // transaction: the lease-expiry UPDATE must be visible to a genuinely
  // separate connection (claim_protocol_execution_job, called later,
  // under service_role again) to prove a real reclaim, which requires a
  // real COMMIT. s6 is therefore its own sequence of separate psql
  // invocations. Its cleanup DELETE is issued only after every s6
  // assertion below has been evaluated, and only if all of them passed
  // (see s6CleanupIfAllPassed at the end of this block) -- a single
  // failing s6 assertion leaves the project, its fixtures, and the whole
  // disposable stack intact for diagnosis, exactly like the harness's own
  // overall failure path already does.
  // ======================================================================

  // D-026 correction (observability): every s6 assertion gets a unique
  // name, its source script, and its expected/actual values recorded
  // explicitly -- never inferred from a compound `&&` of several facts,
  // which is exactly what made runtime 5's two failures unidentifiable
  // after the fact. S6_ASSERTION_NAMES is the complete, fixed roster,
  // checked for internal duplicates immediately (a real preflight, not
  // merely a runtime guard) before any s6 script runs; checkS6() then
  // verifies every name it is given is a MEMBER of this roster (catches
  // typos) and has not already been used (catches accidental double
  // registration); a final completeness check after all of s6 confirms
  // every name in the roster was actually used exactly once.
  const S6_ASSERTION_NAMES = [
    "preflight_helper_resolves",
    "lease_owner_role",
    "lease_expired_confirmed",
    "role_reestablished_service_role",
    "acl_anon_denied",
    "acl_authenticated_denied",
    "slot1_dataset_matches_job",
    "full_retry_status",
    "full_retry_dataset_matches_job",
    "complete_slot1_status",
    "current_attempt_null_between_slots",
    "dataset_between_slots_matches_job",
    "reclaim_current_attempt_null",
    "reclaim_dataset_matches_job",
    "slot2_dataset_matches_job",
    "unique_violation_sqlstate",
    "unique_violation_constraint",
    "dataset_job_count_after_violation",
    "analysis_retry_status",
    "analysis_retry_dataset_matches_slot2",
    "analysis_retry_dataset_matches_job",
  ] as const;
  type S6AssertionName = (typeof S6_ASSERTION_NAMES)[number];
  type S6Source = "s6a" | "s6b" | "s6c" | "helper";

  {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const n of S6_ASSERTION_NAMES) {
      if (seen.has(n)) duplicates.push(n);
      seen.add(n);
    }
    check(
      "preflight: S6_ASSERTION_NAMES itself contains no duplicate names -- a real precondition, not a runtime guard alone",
      duplicates.length === 0,
      duplicates.length > 0 ? `duplicates=${JSON.stringify(duplicates)}` : ""
    );
  }

  const s6AssertionsUsed = new Set<S6AssertionName>();
  const s6Results: { name: S6AssertionName; source: S6Source; expected: string; actual: string; pass: boolean }[] = [];

  function checkS6(name: S6AssertionName, source: S6Source, expected: string, actual: string): void {
    if (!S6_ASSERTION_NAMES.includes(name)) {
      throw new Error(`checkS6: "${name}" is not a member of S6_ASSERTION_NAMES -- add it to the roster first`);
    }
    if (s6AssertionsUsed.has(name)) {
      throw new Error(`checkS6: "${name}" was already used -- every s6 assertion name must be used exactly once`);
    }
    s6AssertionsUsed.add(name);
    const pass = actual === expected;
    s6Results.push({ name, source, expected, actual, pass });
    check(`s6.${name} [source=${source}]`, pass, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
  const s6aSql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s6_proj, protocol_id as s6_proto
  from _m5_runtime_test_helper_make_fixture('s6', 20, 100.00, 5, 3, 2, 0) \\gset
select (job).id as s6_job, (job).dataset_batch_id as s6_dataset
  from enqueue_protocol_execution_job(:'s6_proto', :'s6_proj', 3) \\gset
select claim_token as s6_token from claim_protocol_execution_job('worker-s6-1', 300) \\gset

select (attempt).id as s6_attempt1, (perplexity_call).id as s6_pcall1, (analysis_call).id as s6_acall1
  from admit_and_reserve_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', 'baseline', (:'s6_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_attempt1', 'perplexity', 'simulated');
select probe_run_id as s6_probe_run1 from protocol_attempts where id = :'s6_attempt1' \\gset
select dataset_id::text as s6_slot1_dataset from probe_runs where id = :'s6_probe_run1' \\gset

select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall1', :'s6_probe_run1');
select status from record_provider_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall1', :'s6_probe_run1', 'provider_error');
select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall1', :'s6_probe_run1');
select status from record_analysis_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall1', :'s6_probe_run1', 'provider_error');
select status from reconcile_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_attempt1', 'failed');

select status as s6_retry_status, (attempt).id as s6_child1, (perplexity_call).id as s6_pcall1b, (analysis_call).id as s6_acall1b
  from retry_full_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_attempt1', 0.02, 0.02) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_child1', 'perplexity', 'simulated');
select probe_run_id as s6_probe_run1b from protocol_attempts where id = :'s6_child1' \\gset
select dataset_id::text as s6_retry_dataset from probe_runs where id = :'s6_probe_run1b' \\gset

select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall1b', :'s6_probe_run1b');
select status from record_provider_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall1b', :'s6_probe_run1b', 'success', 200, 'req-s6', '${sha256Hex("s6-answer")}', 400, null, null, 's6-answer');
select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall1b', :'s6_probe_run1b');
select status from record_analysis_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall1b', :'s6_probe_run1b', 'success', 'openai', 'gpt-4o-mini', false, null, '${sha256Hex("s6-output")}', 200, null, null, 's6-output');
select status from reconcile_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_child1', 'completed');
select status as s6_complete1_status from complete_protocol_execution_job(:'s6_job', :'s6_token', :'s6_proj') \\gset

select coalesce((job).current_attempt_id::text, 'NULL') as s6_current_attempt_between_slots,
       (job).dataset_batch_id::text as s6_dataset_between_slots
  from get_protocol_execution_job_context(:'s6_job', :'s6_token', :'s6_proj') \\gset

\\echo '##R## s6_proj' :s6_proj
\\echo '##R## s6_proto' :s6_proto
\\echo '##R## s6_job' :s6_job
\\echo '##R## s6_dataset' :s6_dataset
\\echo '##R## s6_slot1_dataset' :s6_slot1_dataset
\\echo '##R## s6_retry_status' :s6_retry_status
\\echo '##R## s6_retry_dataset' :s6_retry_dataset
\\echo '##R## s6_complete1_status' :s6_complete1_status
\\echo '##R## s6_current_attempt_between_slots' :s6_current_attempt_between_slots
\\echo '##R## s6_dataset_between_slots' :s6_dataset_between_slots
COMMIT;
`;
  writeFileSync(path.join(scratchDir, "07-s6a.sql"), s6aSql);
  const s6aRun = await runPsqlCapturedAsync(path.join(scratchDir, "07-s6a.sql"), "s6a");
  const s6aOutput = s6aRun.stdout;
  const s6a = parseMarkers(s6aOutput);
  const s6a_ = (label: string) => s6a.get(label) ?? "<MISSING>";

  const s6Job = s6a_("s6_job");
  const s6Proj = s6a_("s6_proj");
  const s6Dataset = s6a_("s6_dataset");

  // Administrative fixture prep: the lease-expiry UPDATE runs as the
  // table owner (postgres, this connection's own login role -- no SET
  // ROLE at all), in its own genuinely committed transaction, with an
  // explicit current_user check proving which role is actually in
  // effect.
  const s6bSql = `
\\pset pager off
select current_user as s6_owner_role_before_update \\gset
\\echo '##R## s6_owner_role_before_update' :s6_owner_role_before_update
BEGIN;
update protocol_execution_jobs set lease_expires_at = now() - interval '1 hour' where id = '${s6Job}';
COMMIT;
select case when lease_expires_at < now() then 't' else 'f' end as s6_lease_expired_confirmed from protocol_execution_jobs where id = '${s6Job}' \\gset
\\echo '##R## s6_lease_expired_confirmed' :s6_lease_expired_confirmed
`;
  writeFileSync(path.join(scratchDir, "08-s6b-lease-expiry.sql"), s6bSql);
  const s6bRun = await runPsqlCapturedAsync(path.join(scratchDir, "08-s6b-lease-expiry.sql"), "s6b");
  const s6bOutput = s6bRun.stdout;
  const s6b = parseMarkers(s6bOutput);
  const s6b_ = (label: string) => s6b.get(label) ?? "<MISSING>";

  // Back to application traffic: SET ROLE service_role is re-established
  // explicitly, with its own current_user check, before any further RPC
  // call -- the genuine reclaim, slot 2, and the analysis-only retry.
  const s6cSql = `
\\pset pager off

-- s6's dataset_batch_id_key proof, in pg_temp (session-scoped, never a
-- permanent public-schema object), created while the CURRENT role is
-- still postgres (this connection's own login/superuser role) so
-- SECURITY DEFINER elevates to postgres's privileges for the
-- protocol_execution_jobs INSERT specifically -- service_role holds no
-- INSERT grant on that table at all (only SELECT, 0050). Builds a
-- genuinely SECOND, valid chain in the SAME project -- its own
-- buyer_question, its own buyer_question_version (never protocols_
-- one_active_per_version's buyer_question_version_id, since this
-- version was never used by any other protocol), its own approved
-- protocol -- then attempts a job for that new protocol reusing the
-- ALREADY-OWNED dataset_batch_id. Every other constraint this INSERT
-- could hit (protocol_id uniqueness, the composite project FKs, NOT
-- NULL, status/max_attempts checks) is satisfied by construction; only
-- dataset_batch_id_key is left to fire. REVOKE ALL from public/anon/
-- authenticated, GRANT EXECUTE to service_role only -- proven below by
-- genuine SET ROLE probes, not merely asserted.
create function pg_temp._m5_runtime_test_helper_unique_violation_probe(
  p_project_id uuid,
  p_dataset_batch_id uuid
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_bq_id uuid;
  v_bqv_id uuid;
  v_protocol_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
  v_sqlstate text;
  v_constraint text;
begin
  insert into buyer_questions (project_id) values (p_project_id) returning id into v_bq_id;
  insert into buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, p_project_id, 1, 'fixture prompt for s6 second chain', 'hash-m5-0052-runtime-s6-second-chain',
    'shortlist', 4, 3, 10, 'm5 0052 runtime contract fixture (second chain)', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from approve_buyer_question_version(v_bqv_id, p_project_id, v_actor);

  insert into protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    p_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    1, 0, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', 20, 100.00, 3600,
    1000, 50, 5
  ) returning id into v_protocol_id;
  perform status from approve_protocol(v_protocol_id, p_project_id, v_actor);

  begin
    insert into protocol_execution_jobs (project_id, protocol_id, status, max_attempts, dataset_batch_id)
    values (p_project_id, v_protocol_id, 'queued', 3, p_dataset_batch_id);
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;

  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_runtime_test_helper_unique_violation_probe(uuid, uuid) from public;
revoke all on function pg_temp._m5_runtime_test_helper_unique_violation_probe(uuid, uuid) from anon;
revoke all on function pg_temp._m5_runtime_test_helper_unique_violation_probe(uuid, uuid) from authenticated;
grant execute on function pg_temp._m5_runtime_test_helper_unique_violation_probe(uuid, uuid) to service_role;

-- Preflight: this helper must resolve via its EXACT, schema-qualified
-- signature in THIS session's pg_temp before the ACL proof or the real
-- functional call below is allowed to depend on it.
select to_regprocedure('pg_temp._m5_runtime_test_helper_unique_violation_probe(uuid,uuid)') is not null as preflight_unique_violation_helper \\gset
\\echo '##R## preflight_unique_violation_helper' :preflight_unique_violation_helper

-- ACL proof: anon/authenticated attempts use dummy, non-existent IDs and
-- are expected to be denied AT THE PERMISSION GATE, before the function
-- body ever runs (so the dummy IDs' own FK violations never come into
-- play for them). service_role's ability to execute this helper is
-- already conclusively proven by the real, functional call below (it
-- reaches the real dataset_batch_id_key violation, which is only
-- possible once the function body actually ran) -- no separate dummy-arg
-- positive control is needed here.
create temp table _m5_acl_probe_s6 (label text primary key, sqlstate_captured text);
grant all on _m5_acl_probe_s6 to public;

create function pg_temp._m5_acl_probe_s6_run(p_label text) returns void
language plpgsql
as $f$
begin
  begin
    perform sqlstate_captured from pg_temp._m5_runtime_test_helper_unique_violation_probe(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000'
    );
    insert into _m5_acl_probe_s6 values (p_label, 'NONE');
  exception when others then
    insert into _m5_acl_probe_s6 values (p_label, sqlstate);
  end;
end;
$f$;
grant execute on function pg_temp._m5_acl_probe_s6_run(text) to public;

SET ROLE anon;
select pg_temp._m5_acl_probe_s6_run('anon');
RESET ROLE;

SET ROLE authenticated;
select pg_temp._m5_acl_probe_s6_run('authenticated');
RESET ROLE;

select sqlstate_captured as s6_acl_anon from _m5_acl_probe_s6 where label = 'anon' \\gset
select sqlstate_captured as s6_acl_authenticated from _m5_acl_probe_s6 where label = 'authenticated' \\gset
\\echo '##R## s6_acl_anon' :s6_acl_anon
\\echo '##R## s6_acl_authenticated' :s6_acl_authenticated

SET ROLE service_role;
select current_user as s6_role_after_reset \\gset
\\echo '##R## s6_role_after_reset' :s6_role_after_reset

BEGIN;
select claim_token as s6_token2 from claim_protocol_execution_job('worker-s6-2', 300) \\gset
select coalesce((job).current_attempt_id::text, 'NULL') as s6_current_attempt_after_reclaim,
       (job).dataset_batch_id::text as s6_dataset_after_reclaim
  from get_protocol_execution_job_context('${s6Job}', :'s6_token2', '${s6Proj}') \\gset

select (attempt).id as s6_attempt2, (perplexity_call).id as s6_pcall2, (analysis_call).id as s6_acall2
  from admit_and_reserve_attempt_for_job('${s6Job}', :'s6_token2', '${s6Proj}', 'baseline', ('${s6Job}' || ':baseline:2'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_attempt2', 'perplexity', 'simulated');
select probe_run_id as s6_probe_run2 from protocol_attempts where id = :'s6_attempt2' \\gset
select dataset_id::text as s6_slot2_dataset from probe_runs where id = :'s6_probe_run2' \\gset

select status from mark_external_call_sent_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_pcall2', :'s6_probe_run2');
select status from record_provider_call_receipt_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_pcall2', :'s6_probe_run2', 'success', 200, 'req-s6b', '${sha256Hex("s6-slot2-answer")}', 400, null, null, 's6-slot2-answer');
select status from mark_external_call_sent_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_acall2', :'s6_probe_run2');
select status from record_analysis_call_receipt_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_acall2', :'s6_probe_run2', 'provider_error');
select status as s6_analysis_retry_status
  from retry_analysis_generation_for_job('${s6Job}', :'s6_token2', '${s6Proj}', :'s6_acall2', 0.02) \\gset
select dataset_id::text as s6_analysis_retry_dataset from probe_runs where id = :'s6_probe_run2' \\gset

-- protocol_execution_jobs_dataset_batch_id_key proof: a genuinely
-- second, valid buyer_question -> buyer_question_version -> approved
-- protocol chain, in the SAME project, with a version never referenced
-- by protocols_one_active_per_version (a fresh buyer_question_version_id
-- can never collide with it) -- then a job for that new protocol reusing
-- s6's already-owned dataset_batch_id. The helper is SECURITY DEFINER
-- (owned by postgres), so the INSERT into protocol_execution_jobs runs
-- with the table owner's privilege regardless of the caller (service_
-- role) -- no manual role switch needed here, unlike the lease-expiry
-- step, since GET STACKED DIAGNOSTICS is captured from inside the
-- function itself. SQLSTATE and constraint name captured explicitly --
-- the assertion below passes only if the exact constraint fired is
-- protocol_execution_jobs_dataset_batch_id_key, never merely "an error
-- occurred".
select sqlstate_captured as s6_unique_sqlstate, constraint_captured as s6_unique_constraint
  from pg_temp._m5_runtime_test_helper_unique_violation_probe('${s6Proj}', '${s6Dataset}') \\gset
select count(*)::text as s6_dataset_job_count from protocol_execution_jobs where dataset_batch_id = '${s6Dataset}' \\gset
COMMIT;

\\echo '##R## s6_current_attempt_after_reclaim' :s6_current_attempt_after_reclaim
\\echo '##R## s6_dataset_after_reclaim' :s6_dataset_after_reclaim
\\echo '##R## s6_slot2_dataset' :s6_slot2_dataset
\\echo '##R## s6_analysis_retry_status' :s6_analysis_retry_status
\\echo '##R## s6_analysis_retry_dataset' :s6_analysis_retry_dataset
\\echo '##R## s6_unique_sqlstate' :s6_unique_sqlstate
\\echo '##R## s6_unique_constraint' :s6_unique_constraint
\\echo '##R## s6_dataset_job_count' :s6_dataset_job_count
`;
  writeFileSync(path.join(scratchDir, "09-s6c-reclaim.sql"), s6cSql);
  const s6cRun = await runPsqlCapturedAsync(path.join(scratchDir, "09-s6c-reclaim.sql"), "s6c");
  const s6cOutput = s6cRun.stdout;
  const s6c = parseMarkers(s6cOutput);
  const s6c_ = (label: string) => s6c.get(label) ?? "<MISSING>";

  checkS6("preflight_helper_resolves", "s6c", "t", s6c_("preflight_unique_violation_helper"));
  checkS6("lease_owner_role", "s6b", "postgres", s6b_("s6_owner_role_before_update"));
  checkS6("lease_expired_confirmed", "s6b", "t", s6b_("s6_lease_expired_confirmed"));
  checkS6("role_reestablished_service_role", "s6c", "service_role", s6c_("s6_role_after_reset"));
  checkS6("acl_anon_denied", "s6c", "42501", s6c_("s6_acl_anon"));
  checkS6("acl_authenticated_denied", "s6c", "42501", s6c_("s6_acl_authenticated"));
  checkS6("slot1_dataset_matches_job", "s6a", s6Dataset, s6a_("s6_slot1_dataset"));
  checkS6("full_retry_status", "s6a", "RESERVED", s6a_("s6_retry_status"));
  checkS6("full_retry_dataset_matches_job", "s6a", s6Dataset, s6a_("s6_retry_dataset"));
  checkS6("complete_slot1_status", "s6a", "NEXT_BASELINE_REQUIRED", s6a_("s6_complete1_status"));
  checkS6("current_attempt_null_between_slots", "s6a", "NULL", s6a_("s6_current_attempt_between_slots"));
  checkS6("dataset_between_slots_matches_job", "s6a", s6Dataset, s6a_("s6_dataset_between_slots"));
  checkS6("reclaim_current_attempt_null", "s6c", "NULL", s6c_("s6_current_attempt_after_reclaim"));
  checkS6("reclaim_dataset_matches_job", "s6c", s6Dataset, s6c_("s6_dataset_after_reclaim"));
  checkS6("slot2_dataset_matches_job", "s6c", s6Dataset, s6c_("s6_slot2_dataset"));
  checkS6("unique_violation_sqlstate", "helper", "23505", s6c_("s6_unique_sqlstate"));
  checkS6("unique_violation_constraint", "helper", "protocol_execution_jobs_dataset_batch_id_key", s6c_("s6_unique_constraint"));
  checkS6("dataset_job_count_after_violation", "s6c", "1", s6c_("s6_dataset_job_count"));
  checkS6("analysis_retry_status", "s6c", "RESERVED", s6c_("s6_analysis_retry_status"));
  checkS6("analysis_retry_dataset_matches_slot2", "s6c", s6c_("s6_slot2_dataset"), s6c_("s6_analysis_retry_dataset"));
  checkS6("analysis_retry_dataset_matches_job", "s6c", s6Dataset, s6c_("s6_analysis_retry_dataset"));

  // Completeness preflight: every declared s6 assertion name must have
  // been used exactly once -- catches a forgotten checkS6() call for a
  // roster entry just as surely as the roster-membership check inside
  // checkS6() itself catches an unplanned one.
  {
    const unused = S6_ASSERTION_NAMES.filter((n) => !s6AssertionsUsed.has(n));
    check(
      "preflight: every name in S6_ASSERTION_NAMES was used by exactly one checkS6() call -- none left unregistered",
      unused.length === 0,
      unused.length > 0 ? `unused=${JSON.stringify(unused)}` : ""
    );
  }

  // D-026 correction: cleanup is gated on s6's OWN assertions, evaluated
  // above -- never on the harness's overall outcome. A single failing s6
  // assertion leaves this project, every fixture it created (including
  // the second buyer_question/buyer_question_version/protocol chain from
  // the unique-violation probe), and the whole disposable stack
  // untouched for diagnosis. Only when every s6 assertion passed does the
  // DELETE (cascading via ON DELETE CASCADE from projects) run at all.
  const s6AllPassed = s6Results.every((r) => r.pass);
  if (s6AllPassed) {
    const s6CleanupSql = `\\pset pager off\nSET ROLE service_role;\ndelete from projects where id = '${s6Proj}';\n`;
    writeFileSync(path.join(scratchDir, "10-s6-cleanup.sql"), s6CleanupSql);
    await runPsqlCapturedAsync(path.join(scratchDir, "10-s6-cleanup.sql"), "s6-cleanup");
    console.log("s6: all assertions passed -- fixtures cleaned up (project deleted, cascading).");
  } else {
    const failedNames = s6Results.filter((r) => !r.pass).map((r) => r.name);
    console.log(
      `s6: ${failedNames.length} assertion(s) failed (${JSON.stringify(failedNames)}) -- fixtures and project ${s6Proj} left INTACT for diagnosis, no cleanup DELETE issued.`
    );
  }

  check(
    "s0: NO_BASELINE_RUNS_PLANNED returns a null job and creates zero protocol_execution_jobs and zero dataset_batches rows for this project -- real row counts, not just the RPC's own reported outcome",
    r("s0_status") === "NO_BASELINE_RUNS_PLANNED" &&
      r("s0_job_is_null") === "t" &&
      r("s0_job_count") === "0" &&
      r("s0_batch_count") === "0"
  );
  check(
    "s1: a replay enqueue for the same protocol returns ALREADY_EXISTS with the identical job id and datasetBatchId, and creates no second dataset_batches row",
    r("s1_replay_status") === "ALREADY_EXISTS" &&
      r("s1_replay_job") === r("s1_job") &&
      r("s1_replay_dataset") === r("s1_dataset") &&
      r("s1_batch_count_after_replay") === "1"
  );
  check(
    "s1: the stored raw content is recoverable through get_protocol_execution_job_context's own provider_receipts/analysis_receipts arrays, not only by querying the receipt tables directly",
    r("s1_ctx_provider_body") === "the real perplexity answer" &&
      r("s1_ctx_analysis_content") === "the real analysis output"
  );

  // ======================================================================
  // Part B.5 — real concurrency: two genuinely separate, concurrent
  // Postgres sessions (two OS processes, two connections) call
  // enqueue_protocol_execution_job for the SAME protocol at the same
  // time. Session A holds its transaction open (pg_sleep(2), still
  // inside the FOR UPDATE lock enqueue_protocol_execution_job takes on
  // the protocols row) so Session B -- launched ~500ms later -- is
  // forced to genuinely block on that lock, not merely interleave in a
  // single process's event loop the way MemoryAdapter's Promise.all
  // approximation does. This is the one property only a real Postgres
  // instance can prove.
  // ======================================================================
  const raceSetupSql = `
\\pset pager off
SET ROLE service_role;
select project_id as race_proj, protocol_id as race_proto from _m5_runtime_test_helper_make_fixture('race-real') \\gset
\\echo '##R## race_proj' :race_proj
\\echo '##R## race_proto' :race_proto
`;
  writeFileSync(path.join(scratchDir, "03-race-setup.sql"), raceSetupSql);
  const raceSetupOutput = runPsql(path.join(scratchDir, "03-race-setup.sql"), "stop");
  const raceSetup = parseMarkers(raceSetupOutput);
  const raceProjectId = raceSetup.get("race_proj") ?? "";
  const raceProtocolId = raceSetup.get("race_proto") ?? "";

  function raceSessionSql(varPrefix: string): string {
    return `
\\pset pager off
SET ROLE service_role;
BEGIN;
select status as ${varPrefix}_status, (job).id as ${varPrefix}_job, (job).dataset_batch_id as ${varPrefix}_dataset
  from enqueue_protocol_execution_job('${raceProtocolId}', '${raceProjectId}', 3) \\gset
select pg_sleep(2);
COMMIT;
\\echo '##R## ${varPrefix}_status' :${varPrefix}_status
\\echo '##R## ${varPrefix}_job' :${varPrefix}_job
\\echo '##R## ${varPrefix}_dataset' :${varPrefix}_dataset
`;
  }
  const raceAPath = path.join(scratchDir, "04-race-a.sql");
  const raceBPath = path.join(scratchDir, "04-race-b.sql");
  writeFileSync(raceAPath, raceSessionSql("racea"));
  writeFileSync(raceBPath, raceSessionSql("raceb"));

  const raceAPromise = spawnAsync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", raceAPath]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const raceBPromise = spawnAsync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", raceBPath]);
  const [raceAResult, raceBResult] = await Promise.all([raceAPromise, raceBPromise]);

  check(
    "real concurrency: both concurrent psql sessions completed without error (exit code 0)",
    raceAResult.code === 0 && raceBResult.code === 0
  );
  const raceAMarkers = parseMarkers(raceAResult.stdout);
  const raceBMarkers = parseMarkers(raceBResult.stdout);
  const raceOutcomes = [raceAMarkers.get("racea_status"), raceBMarkers.get("raceb_status")];
  check(
    "real concurrency: exactly one of the two genuinely concurrent enqueue calls returned QUEUED and the other ALREADY_EXISTS -- the FOR UPDATE lock on protocols genuinely serialized them, never two independent QUEUEDs",
    (raceOutcomes[0] === "QUEUED" && raceOutcomes[1] === "ALREADY_EXISTS") ||
      (raceOutcomes[0] === "ALREADY_EXISTS" && raceOutcomes[1] === "QUEUED")
  );
  check(
    "real concurrency: both sessions agree on the exact same job id and dataset_batch_id",
    raceAMarkers.get("racea_job") === raceBMarkers.get("raceb_job") &&
      raceAMarkers.get("racea_dataset") === raceBMarkers.get("raceb_dataset") &&
      !!raceAMarkers.get("racea_job") &&
      !!raceAMarkers.get("racea_dataset")
  );

  const raceVerifySql = `
\\pset pager off
SET ROLE service_role;
select count(*)::text as race_job_count from protocol_execution_jobs where protocol_id = '${raceProtocolId}' and project_id = '${raceProjectId}' \\gset
select count(*)::text as race_batch_count from dataset_batches where project_id = '${raceProjectId}' \\gset
\\echo '##R## race_job_count' :race_job_count
\\echo '##R## race_batch_count' :race_batch_count
`;
  writeFileSync(path.join(scratchDir, "05-race-verify.sql"), raceVerifySql);
  const raceVerifyOutput = runPsql(path.join(scratchDir, "05-race-verify.sql"), "stop");
  const raceVerify = parseMarkers(raceVerifyOutput);
  check(
    "real concurrency: after both genuinely concurrent calls settle, exactly one protocol_execution_jobs row and exactly one dataset_batches row exist for this protocol/project -- no orphan",
    raceVerify.get("race_job_count") === "1" && raceVerify.get("race_batch_count") === "1"
  );

  // This one scenario necessarily COMMITs on both sides (proving real
  // cross-process lock contention requires an actual commit, not a
  // ROLLBACK) -- explicitly clean up its project (cascades to protocols/
  // protocol_execution_jobs/dataset_batches) so the disposable database
  // is left exactly as every other, ROLLBACK-based scenario leaves it:
  // with nothing of this test's own making still present.
  const raceCleanupSql = `
\\pset pager off
SET ROLE service_role;
delete from projects where id = '${raceProjectId}';
`;
  writeFileSync(path.join(scratchDir, "06-race-cleanup.sql"), raceCleanupSql);
  runPsql(path.join(scratchDir, "06-race-cleanup.sql"), "stop");

  // ======================================================================
  // Part C — ACL/RLS: anon and authenticated can neither SELECT the
  // underlying tables nor EXECUTE the RPCs this migration adds/redefines;
  // only service_role can. Each attempt runs as its own, separate psql
  // invocation with ON_ERROR_STOP=1, so a permission-denied error is
  // detected as a non-zero exit rather than needing SAVEPOINT gymnastics
  // inside a shared session -- and each uses harmless placeholder
  // arguments, since GRANT/REVOKE is checked before the function body
  // (or the row scan) ever runs.
  // ======================================================================
  function attemptAsRole(role: "anon" | "authenticated" | "service_role", sql: string): { ok: boolean; error: string } {
    const scriptPath = path.join(scratchDir, `acl-${role}-${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(scriptPath, `\\pset pager off\nSET ROLE ${role};\n${sql}\n`);
    try {
      execFileSync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], {
        env: runEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      return { ok: true, error: "" };
    } catch (err) {
      const stderr = err instanceof Error ? String((err as { stderr?: string }).stderr ?? err.message) : String(err);
      return { ok: false, error: stderr };
    }
  }

  const dummyUuid = "00000000-0000-4000-8000-000000000000";
  const aclEnqueueSql = `select * from enqueue_protocol_execution_job('${dummyUuid}', '${dummyUuid}', 3);`;
  const aclStartAttemptSql = `select * from create_probe_run_and_start_attempt_for_job('${dummyUuid}', '${dummyUuid}', '${dummyUuid}', '${dummyUuid}', 'perplexity', 'simulated');`;
  const aclReceiptSql = `select * from record_provider_call_receipt_for_job('${dummyUuid}', '${dummyUuid}', '${dummyUuid}', '${dummyUuid}', '${dummyUuid}', 'success');`;
  const aclContextSql = `select * from get_protocol_execution_job_context('${dummyUuid}', '${dummyUuid}', '${dummyUuid}');`;
  const aclSelectJobsSql = `select 1 from protocol_execution_jobs limit 1;`;

  const anonSelect = attemptAsRole("anon", aclSelectJobsSql);
  check(
    "ACL: anon cannot SELECT protocol_execution_jobs -- permission denied",
    !anonSelect.ok && /permission denied/i.test(anonSelect.error)
  );
  const anonEnqueue = attemptAsRole("anon", aclEnqueueSql);
  check(
    "ACL: anon cannot EXECUTE enqueue_protocol_execution_job (0052's atomic dataset+job redefinition) -- permission denied",
    !anonEnqueue.ok && /permission denied/i.test(anonEnqueue.error)
  );
  const anonStartAttempt = attemptAsRole("anon", aclStartAttemptSql);
  check(
    "ACL: anon cannot EXECUTE the new 6-arg create_probe_run_and_start_attempt_for_job -- permission denied",
    !anonStartAttempt.ok && /permission denied/i.test(anonStartAttempt.error)
  );
  const anonReceipt = attemptAsRole("anon", aclReceiptSql);
  check(
    "ACL: anon cannot EXECUTE the new 13-arg record_provider_call_receipt_for_job -- permission denied",
    !anonReceipt.ok && /permission denied/i.test(anonReceipt.error)
  );
  const anonContext = attemptAsRole("anon", aclContextSql);
  check(
    "ACL: anon cannot EXECUTE get_protocol_execution_job_context (0052's probe_result-carrying redefinition) -- permission denied",
    !anonContext.ok && /permission denied/i.test(anonContext.error)
  );
  const authenticatedEnqueue = attemptAsRole("authenticated", aclEnqueueSql);
  check(
    "ACL: authenticated cannot EXECUTE enqueue_protocol_execution_job either -- permission denied",
    !authenticatedEnqueue.ok && /permission denied/i.test(authenticatedEnqueue.error)
  );
  const serviceRoleSelect = attemptAsRole("service_role", aclSelectJobsSql);
  check(
    "ACL positive control: service_role CAN select protocol_execution_jobs -- the denials above are real ACL enforcement, not a broken connection or role",
    serviceRoleSelect.ok
  );

  // D-026 correction: public._sha256_hex has zero EXECUTE grants to any
  // role, not even service_role (0051: revoke all ... from public, anon,
  // authenticated, service_role) -- it exists solely for CHECK
  // constraints and SECURITY DEFINER function bodies to call internally,
  // which run as the owning role and so bypass this check entirely. This
  // harness computes every expected hash client-side (sha256Hex, above)
  // specifically because of this; this assertion proves that boundary is
  // still real and has not quietly been widened.
  const serviceRoleSha256Hex = attemptAsRole("service_role", `select public._sha256_hex('x');`);
  check(
    "ACL: _sha256_hex remains inaccessible directly to service_role -- permission denied, confirming this harness's own client-side hash computation is not merely a workaround for a since-fixed grant",
    !serviceRoleSha256Hex.ok && /permission denied for function _sha256_hex/i.test(serviceRoleSha256Hex.error)
  );

  // D-026 correction, negative controls for s6's administrative fixture
  // prep: protocol_execution_jobs carries only a SELECT grant for
  // service_role (0050) -- the same direct DML s6's lease-expiry
  // simulation and unique-violation setup must run as the table owner
  // (postgres), never service_role, is confirmed refused here, kept
  // separately from s6 itself so this boundary is asserted even if s6's
  // own structure changes later.
  const aclUpdateJobsSql = `update protocol_execution_jobs set lease_expires_at = now() where id = '${dummyUuid}';`;
  const serviceRoleUpdateJobs = attemptAsRole("service_role", aclUpdateJobsSql);
  check(
    "ACL: service_role cannot UPDATE protocol_execution_jobs directly -- permission denied, confirming s6's lease-expiry fixture prep must run as the table owner, never service_role",
    !serviceRoleUpdateJobs.ok && /permission denied for table protocol_execution_jobs/i.test(serviceRoleUpdateJobs.error)
  );
  const aclInsertJobsSql = `insert into protocol_execution_jobs (project_id, protocol_id, status, max_attempts, dataset_batch_id) values ('${dummyUuid}', '${dummyUuid}', 'queued', 3, '${dummyUuid}');`;
  const serviceRoleInsertJobs = attemptAsRole("service_role", aclInsertJobsSql);
  check(
    "ACL: service_role cannot INSERT into protocol_execution_jobs directly either -- permission denied, confirming s6's unique-violation fixture prep must also run as the table owner",
    !serviceRoleInsertJobs.ok && /permission denied for table protocol_execution_jobs/i.test(serviceRoleInsertJobs.error)
  );
}

main();
