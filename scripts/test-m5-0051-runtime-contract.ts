#!/usr/bin/env tsx
/**
 * M5 — real, reproducible Postgres runtime contract test for D-021
 * (migration 0051: worker resumption without double admission,
 * fingerprinted operator idempotence, separated provider/analysis
 * retries, atomic replay-safe probe_run, ambiguity -> needs_review,
 * internal monitoring).
 *
 * This is NOT a static text check (see scripts/test-m5-0051-schema-
 * contract.ts for that). This test creates a genuinely disposable
 * local Supabase/Postgres stack under a fresh mktemp directory, applies
 * 0001-0051 byte-identically, and exercises D-021's guarantees via real
 * RPC calls over real psql connections/processes — exactly the class of
 * defect static text review cannot catch (the AS core(...) bug in an
 * earlier M5 phase was invisible to grep and only surfaced on real
 * execution; the same is true of the array_agg(composite) construct in
 * get_protocol_execution_job_context, flagged as unexecuted in the
 * prior read-only pass).
 *
 * Safety (same discipline as scripts/test-m5-0050-runtime-contract.ts):
 *   - opt-in only: does nothing unless ZYPACT_M5_0051_RUNTIME_TEST=1.
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
 *   - confirms, before applying anything, that no 0052 migration
 *     exists in this repository (the cutover migration is deliberately
 *     not yet created per D-021).
 *
 * Optional environment variables:
 *   ZYPACT_M5_0051_RUNTIME_TEST=1   required opt-in to run anything at all
 *   ZYPACT_DOCKER_BIN_DIR=<path>    prepended to PATH, matching this
 *                                   repo's own local Docker Desktop setup
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

/** Spawns a child process asynchronously (for genuine concurrency: two of these launched together race at the OS process level, not merely sequentially in one script). */
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

async function main(): Promise<void> {
  console.log("=== M5 0051 — real runtime contract test for D-021 (worker resumption, retry safety, monitoring) ===\n");

  // ------------------------------------------------------------------
  // 0. Repo/branch/HEAD confirmation + opt-in gate.
  // ------------------------------------------------------------------
  console.log(`Repo:   ${REPO_ROOT}`);
  try {
    console.log(`Branch: ${run("git", ["branch", "--show-current"]).trim()}`);
    console.log(`HEAD:   ${run("git", ["rev-parse", "HEAD"]).trim()}`);
  } catch {
    console.log("(git branch/HEAD unavailable — continuing; this does not affect stack safety)");
  }

  if (process.env.ZYPACT_M5_0051_RUNTIME_TEST !== "1") {
    skip(
      "ZYPACT_M5_0051_RUNTIME_TEST is not set to \"1\". Set it explicitly to run this test " +
        "(e.g. ZYPACT_M5_0051_RUNTIME_TEST=1 npx tsx scripts/test-m5-0051-runtime-contract.ts). " +
        "Optionally set ZYPACT_DOCKER_BIN_DIR if Docker's CLI is not already on PATH."
    );
  }

  // ------------------------------------------------------------------
  // 1. No 0052 migration exists — the cutover migration is deliberately
  //    not yet created.
  // ------------------------------------------------------------------
  const migrationsDirCheck = path.join(REPO_ROOT, "supabase", "migrations");
  if (readdirSync(migrationsDirCheck).some((f) => f.startsWith("0052"))) {
    console.log("\n✗ FATAL: a migration matching 0052* exists — this run refuses to proceed.");
    process.exit(1);
  }
  console.log("Confirmed: no 0052* migration exists in this repository.\n");

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
  // 3. Local Supabase ports must be free before starting — refuse to
  //    proceed (never force) if something already occupies them.
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
  //    full identity (ID/StartedAt/RestartCount/health/ports/network/
  //    mounts) before touching anything.
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
    console.log(`zypact-postgres baseline captured (ID/StartedAt/RestartCount/health/ports/network/mounts).`);
  } else {
    console.log("zypact-postgres is not present in this environment — that specific check will be skipped, not faked.");
  }

  // ------------------------------------------------------------------
  // 5. Disposable stack: unique mktemp workdir/project_id.
  // ------------------------------------------------------------------
  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0051-runtime-"));
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
    const migrationFiles = readdirSync(sourceMigrationsDir).filter((f) => f.endsWith(".sql"));
    check("no 0052* migration file exists among the files about to be copied", !migrationFiles.some((f) => f.startsWith("0052")));
    for (const f of migrationFiles) {
      copyFileSync(path.join(sourceMigrationsDir, f), path.join(destMigrationsDir, f));
    }
    const byteIdentical = migrationFiles.every(
      (f) => readFileSync(path.join(sourceMigrationsDir, f)).equals(readFileSync(path.join(destMigrationsDir, f)))
    );
    check(
      `all ${migrationFiles.length} migrations (0001-0051) copied byte-identically`,
      byteIdentical && migrationFiles.some((f) => f.includes("0050_m5")) && migrationFiles.some((f) => f.includes("0051_m5"))
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
    if (workdir.startsWith(path.join(tmpdir(), "zypact-m5-0051-runtime-"))) {
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
      (failures === 0 ? "M5 0051 runtime contract PASSED." : "M5 0051 runtime contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);

  async function runScenarios(dbUrl: string, workdirForScript: string): Promise<void> {
    await runScenariosImpl(dbUrl, workdirForScript, check, spawnAsync, RUN_ENV);
  }
}

// ----------------------------------------------------------------------
// Scenario execution.
// ----------------------------------------------------------------------

type CheckFn = (name: string, cond: boolean, detail?: string) => void;
type SpawnAsyncFn = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

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
  insert into projects (domain, company_name) values ('m5-0051-runtime-' || p_label || '.test', 'M5 0051 Runtime ' || p_label)
    returning id into v_project_id;
  insert into buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label, 'hash-m5-0051-runtime-' || p_label,
    'shortlist', 4, 3, 10, 'm5 0051 runtime contract fixture', 'founder_supplied'
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
  -- D-025: planned_baseline_runs = 0 is a real, callable fixture shape
  -- (used to prove NO_BASELINE_RUNS_PLANNED) -- approve_protocol itself
  -- has no opinion on this value, only enqueue_protocol_execution_job
  -- does.
  perform status from approve_protocol(v_protocol_id, v_project_id, v_actor);
  return query select v_project_id, v_protocol_id;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_make_fixture(text, integer, numeric, integer, integer, integer, integer) to service_role;

create or replace function public._m5_runtime_test_helper_probe_run(p_project_id uuid, p_label text)
returns uuid language plpgsql as $f$
declare
  v_dataset uuid;
  v_probe_run uuid;
begin
  insert into dataset_batches (project_id, dataset_source_type) values (p_project_id, 'manual_scan') returning id into v_dataset;
  insert into probe_runs (project_id, platform, status, probe_mode, dataset_id, dataset_source_type)
    values (p_project_id, 'perplexity', 'succeeded', 'simulated', v_dataset, 'manual_scan')
    returning id into v_probe_run;
  return v_probe_run;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_probe_run(uuid, text) to service_role;

create or replace function public._m5_runtime_test_helper_dataset(p_project_id uuid)
returns uuid language plpgsql as $f$
declare
  v_dataset uuid;
begin
  insert into dataset_batches (project_id, dataset_source_type) values (p_project_id, 'manual_scan') returning id into v_dataset;
  return v_dataset;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_dataset(uuid) to service_role;

\\echo '##R## helper_installed ok'
`;

async function runScenariosImpl(dbUrl: string, workdir: string, check: CheckFn, spawnAsync: SpawnAsyncFn, runEnv: NodeJS.ProcessEnv): Promise<void> {
  const scratchDir = path.join(workdir, "runtime-scripts");
  mkdirSync(scratchDir, { recursive: true });

  function runPsql(scriptPath: string, onError: "stop" | "continue"): string {
    return execFileSync(
      "psql",
      [dbUrl, "-X", "-q", "-v", `ON_ERROR_STOP=${onError === "stop" ? 1 : 0}`, "-f", scriptPath],
      { env: runEnv, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
    );
  }

  writeFileSync(path.join(scratchDir, "00-helper.sql"), HELPER_SQL);
  runPsql(path.join(scratchDir, "00-helper.sql"), "stop");

  // ======================================================================
  // Part A — catalog/contract checks. No fixtures needed: pure system
  // catalog queries proving the real, applied database state.
  // ======================================================================
  const CONTRACT_SQL = `
\\pset pager off
SET ROLE service_role;

-- All booleans in this block are rendered through the same explicit
-- 't'/'f' text mapping (never a bare ::text cast on a boolean, which
-- yields 'true'/'false' and does not match psql's native boolean
-- stringification) so every \\gset capture below is guaranteed to be
-- exactly 't' or 'f', uniformly, regardless of whether the source
-- expression is a plain boolean or a bool_and(...) aggregate.

-- Old dangerous signatures must be genuinely absent from the catalog.
select case when to_regprocedure('public._reserve_additional_analysis_generation_core(uuid,uuid,numeric)') is null then 't' else 'f' end as old_core_absent \\gset
select case when to_regprocedure('public.authorize_operator_retry(uuid,uuid,text,text,text,uuid,numeric,numeric)') is null then 't' else 'f' end as old_authorize_absent \\gset
\\echo '##R## old_core_absent' :old_core_absent
\\echo '##R## old_authorize_absent' :old_authorize_absent

-- New signatures must exist.
select case when to_regprocedure('public._reserve_additional_analysis_generation_core(uuid,uuid,numeric,uuid)') is not null then 't' else 'f' end as new_core_present \\gset
select case when to_regprocedure('public.authorize_operator_retry(uuid,uuid,text,text,text,uuid,numeric,text,uuid,numeric)') is not null then 't' else 'f' end as new_authorize_present \\gset
select case when to_regprocedure('public.retry_full_attempt_for_job(uuid,uuid,uuid,uuid,numeric,numeric)') is not null then 't' else 'f' end as retry_full_present \\gset
select case when to_regprocedure('public.retry_analysis_generation_for_job(uuid,uuid,uuid,uuid,numeric)') is not null then 't' else 'f' end as retry_analysis_present \\gset
select case when to_regprocedure('public.create_probe_run_and_start_attempt_for_job(uuid,uuid,uuid,uuid,text,text,uuid,text)') is not null then 't' else 'f' end as probe_run_rpc_present \\gset
select case when to_regprocedure('public.get_protocol_execution_job_context(uuid,uuid,uuid)') is not null then 't' else 'f' end as context_rpc_present \\gset
select case when to_regprocedure('public.mark_protocol_execution_job_needs_review_for_ambiguity(uuid,uuid,uuid)') is not null then 't' else 'f' end as needs_review_rpc_present \\gset
select case when to_regprocedure('public._sha256_hex(text)') is not null then 't' else 'f' end as sha256_helper_present \\gset
\\echo '##R## new_core_present' :new_core_present
\\echo '##R## new_authorize_present' :new_authorize_present
\\echo '##R## retry_full_present' :retry_full_present
\\echo '##R## retry_analysis_present' :retry_analysis_present
\\echo '##R## probe_run_rpc_present' :probe_run_rpc_present
\\echo '##R## context_rpc_present' :context_rpc_present
\\echo '##R## needs_review_rpc_present' :needs_review_rpc_present
\\echo '##R## sha256_helper_present' :sha256_helper_present

-- Tables/columns/constraints/indexes/view.
select case when count(*) = 1 then 't' else 'f' end as needs_review_check_present from pg_constraint where conname = 'protocol_execution_jobs_needs_review_reason_pair_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as retry_attempt_unique_idx_present from pg_indexes where indexname = 'protocol_attempts_retry_of_attempt_id_key' \\gset
select case when count(*) = 1 then 't' else 'f' end as retry_call_unique_idx_present from pg_indexes where indexname = 'protocol_external_calls_retry_of_external_call_id_key' \\gset
select case when count(*) = 1 then 't' else 'f' end as probe_run_fk_present from pg_constraint where conname = 'protocol_attempts_probe_run_project_fk' \\gset
select case when count(*) = 1 then 't' else 'f' end as operator_actions_unique_present from pg_constraint where conname = 'protocol_operator_actions_project_job_key_key' \\gset
select case when count(*) = 1 then 't' else 'f' end as fingerprint_check_present from pg_constraint where conname = 'protocol_operator_actions_fingerprint_format_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as monitoring_view_present from pg_views where viewname = 'protocol_execution_job_monitoring_v1' \\gset
\\echo '##R## needs_review_check_present' :needs_review_check_present
\\echo '##R## retry_attempt_unique_idx_present' :retry_attempt_unique_idx_present
\\echo '##R## retry_call_unique_idx_present' :retry_call_unique_idx_present
\\echo '##R## probe_run_fk_present' :probe_run_fk_present
\\echo '##R## operator_actions_unique_present' :operator_actions_unique_present
\\echo '##R## fingerprint_check_present' :fingerprint_check_present
\\echo '##R## monitoring_view_present' :monitoring_view_present

-- SECURITY DEFINER + search_path, on the new functions.
select case when bool_and(p.prosecdef) then 't' else 'f' end as new_fns_secdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('retry_full_attempt_for_job','retry_analysis_generation_for_job',
                      'create_probe_run_and_start_attempt_for_job','mark_protocol_execution_job_needs_review_for_ambiguity',
                      'authorize_operator_retry') \\gset
select case when bool_and(p.proconfig::text like '%search_path=public, pg_temp%') then 't' else 'f' end as new_fns_search_path
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('retry_full_attempt_for_job','retry_analysis_generation_for_job',
                      'create_probe_run_and_start_attempt_for_job','mark_protocol_execution_job_needs_review_for_ambiguity',
                      'authorize_operator_retry') \\gset
\\echo '##R## new_fns_secdef' :new_fns_secdef
\\echo '##R## new_fns_search_path' :new_fns_search_path

-- ACL: M4 raw RPCs still EXECUTE-able by service_role (temporary, pre-cutover).
select case when has_function_privilege('service_role', 'public.admit_and_reserve_attempt(uuid,uuid,text,text,numeric,uuid)', 'EXECUTE') then 't' else 'f' end as m4_admit_still_granted \\gset
select case when has_function_privilege('service_role', 'public.start_attempt(uuid,uuid,uuid)', 'EXECUTE') then 't' else 'f' end as m4_start_still_granted \\gset
select case when has_function_privilege('service_role', 'public.reconcile_attempt(uuid,uuid,text,numeric,uuid,text)', 'EXECUTE') then 't' else 'f' end as m4_reconcile_still_granted \\gset
\\echo '##R## m4_admit_still_granted' :m4_admit_still_granted
\\echo '##R## m4_start_still_granted' :m4_start_still_granted
\\echo '##R## m4_reconcile_still_granted' :m4_reconcile_still_granted

-- ACL: the orphaned reserve_additional_analysis_generation_for_job must
-- no longer be executable by service_role.
select case when has_function_privilege('service_role', 'public.reserve_additional_analysis_generation_for_job(uuid,uuid,uuid,uuid,numeric)', 'EXECUTE') then 't' else 'f' end as old_reserve_rpc_still_granted \\gset
\\echo '##R## old_reserve_rpc_still_granted' :old_reserve_rpc_still_granted

-- ACL: monitoring view, service_role only.
select case when has_table_privilege('service_role', 'public.protocol_execution_job_monitoring_v1', 'SELECT') then 't' else 'f' end as monitoring_service_role_can_select \\gset
select case when has_table_privilege('anon', 'public.protocol_execution_job_monitoring_v1', 'SELECT') then 't' else 'f' end as monitoring_anon_can_select \\gset
select case when has_table_privilege('authenticated', 'public.protocol_execution_job_monitoring_v1', 'SELECT') then 't' else 'f' end as monitoring_authenticated_can_select \\gset
\\echo '##R## monitoring_service_role_can_select' :monitoring_service_role_can_select
\\echo '##R## monitoring_anon_can_select' :monitoring_anon_can_select
\\echo '##R## monitoring_authenticated_can_select' :monitoring_authenticated_can_select

-- M4 non-regression forensic follow-up (D-025 Stage A.2): the real
-- pg_proc catalog, not just migration text, must show exactly one
-- _admit_and_reserve_attempt_core overload, at the new 8-arg signature,
-- with the pre-D-025 7-arg signature genuinely gone and EXECUTE denied
-- to every role including service_role (internal-only, function-to-
-- function under SECURITY DEFINER -- never a directly callable RPC).
select count(*)::text as core_overload_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = '_admit_and_reserve_attempt_core' \\gset
select case when to_regprocedure('public._admit_and_reserve_attempt_core(uuid,uuid,text,text,numeric,uuid,uuid,integer)') is not null then 't' else 'f' end as core_8arg_present \\gset
select case when to_regprocedure('public._admit_and_reserve_attempt_core(uuid,uuid,text,text,numeric,uuid,uuid)') is null then 't' else 'f' end as core_7arg_absent \\gset
select case when has_function_privilege('service_role', 'public._admit_and_reserve_attempt_core(uuid,uuid,text,text,numeric,uuid,uuid,integer)', 'EXECUTE') then 't' else 'f' end as core_service_role_can_execute \\gset
select case when has_function_privilege('anon', 'public._admit_and_reserve_attempt_core(uuid,uuid,text,text,numeric,uuid,uuid,integer)', 'EXECUTE') then 't' else 'f' end as core_anon_can_execute \\gset
select case when has_function_privilege('authenticated', 'public._admit_and_reserve_attempt_core(uuid,uuid,text,text,numeric,uuid,uuid,integer)', 'EXECUTE') then 't' else 'f' end as core_authenticated_can_execute \\gset
select case when exists (
  select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where n.nspname = 'public'
     and p.proname = '_admit_and_reserve_attempt_core'
     and p.pronargs = 8
     and a.grantee = 0
     and a.privilege_type = 'EXECUTE'
) then 't' else 'f' end as core_public_has_execute \\gset
\\echo '##R## core_overload_count' :core_overload_count
\\echo '##R## core_8arg_present' :core_8arg_present
\\echo '##R## core_7arg_absent' :core_7arg_absent
\\echo '##R## core_service_role_can_execute' :core_service_role_can_execute
\\echo '##R## core_anon_can_execute' :core_anon_can_execute
\\echo '##R## core_authenticated_can_execute' :core_authenticated_can_execute
\\echo '##R## core_public_has_execute' :core_public_has_execute
`;

  writeFileSync(path.join(scratchDir, "01-contract.sql"), CONTRACT_SQL);
  const contractOutput = runPsql(path.join(scratchDir, "01-contract.sql"), "stop");
  const contractResults = parseMarkers(contractOutput);
  const c = (label: string) => contractResults.get(label) ?? "<MISSING>";

  check("old 3-arg _reserve_additional_analysis_generation_core is genuinely absent from the catalog", c("old_core_absent") === "t");
  check("old 8-arg authorize_operator_retry is genuinely absent from the catalog", c("old_authorize_absent") === "t");
  check("new 4-arg _reserve_additional_analysis_generation_core exists", c("new_core_present") === "t");
  check("new 10-arg authorize_operator_retry exists", c("new_authorize_present") === "t");
  check("retry_full_attempt_for_job exists", c("retry_full_present") === "t");
  check("retry_analysis_generation_for_job exists", c("retry_analysis_present") === "t");
  check("create_probe_run_and_start_attempt_for_job exists", c("probe_run_rpc_present") === "t");
  check("get_protocol_execution_job_context exists", c("context_rpc_present") === "t");
  check("mark_protocol_execution_job_needs_review_for_ambiguity exists", c("needs_review_rpc_present") === "t");
  check("_sha256_hex helper exists (pgcrypto-backed)", c("sha256_helper_present") === "t");
  check("protocol_execution_jobs_needs_review_reason_pair_check exists", c("needs_review_check_present") === "t");
  check("protocol_attempts_retry_of_attempt_id_key unique index exists", c("retry_attempt_unique_idx_present") === "t");
  check("protocol_external_calls_retry_of_external_call_id_key unique index exists", c("retry_call_unique_idx_present") === "t");
  check("protocol_attempts_probe_run_project_fk exists", c("probe_run_fk_present") === "t");
  check("protocol_operator_actions_project_job_key_key exists", c("operator_actions_unique_present") === "t");
  check("protocol_operator_actions_fingerprint_format_check exists", c("fingerprint_check_present") === "t");
  check("protocol_execution_job_monitoring_v1 view exists", c("monitoring_view_present") === "t");
  check("all new/modified D-021 functions are SECURITY DEFINER", c("new_fns_secdef") === "t");
  check("all new/modified D-021 functions pin search_path = public, pg_temp", c("new_fns_search_path") === "t");
  check("M4 raw RPCs (admit_and_reserve_attempt/start_attempt/reconcile_attempt) remain EXECUTE-able by service_role before cutover", c("m4_admit_still_granted") === "t" && c("m4_start_still_granted") === "t" && c("m4_reconcile_still_granted") === "t");
  check("reserve_additional_analysis_generation_for_job is NOT executable by service_role (revoked, orphaned bypass closed)", c("old_reserve_rpc_still_granted") === "f");
  check("protocol_execution_job_monitoring_v1 is selectable by service_role, denied to anon and authenticated", c("monitoring_service_role_can_select") === "t" && c("monitoring_anon_can_select") === "f" && c("monitoring_authenticated_can_select") === "f");
  check("_admit_and_reserve_attempt_core: exactly one overload exists in the real pg_proc catalog", c("core_overload_count") === "1");
  check("_admit_and_reserve_attempt_core: the final signature is the 8-arg one (p_baseline_ordinal added by D-025)", c("core_8arg_present") === "t");
  check("_admit_and_reserve_attempt_core: the pre-D-025 7-arg signature is genuinely absent from the catalog, not merely shadowed", c("core_7arg_absent") === "t");
  check("_admit_and_reserve_attempt_core: EXECUTE is denied to service_role, anon, authenticated, and PUBLIC alike -- internal-only, function-to-function, never a directly callable RPC", c("core_service_role_can_execute") === "f" && c("core_anon_can_execute") === "f" && c("core_authenticated_can_execute") === "f" && c("core_public_has_execute") === "f");

  // ======================================================================
  // Part B — business scenarios. Each wrapped in its own BEGIN/ROLLBACK
  // (per instruction) except where a scenario deliberately needs a
  // committed fixture visible to a separate, later concurrent process
  // (flagged explicitly at that scenario).
  // ======================================================================
  const BUSINESS_SQL = `
\\pset pager off
\\set ON_ERROR_STOP off
SET ROLE service_role;

-- ============================================================
-- s1: initial admission creates exactly one attempt; a second call
-- with a DIFFERENT idempotency key, once current_attempt_id is set,
-- creates nothing and returns RESUME_CURRENT_ATTEMPT.
-- ============================================================
BEGIN;
select project_id as s1_proj, protocol_id as s1_proto from _m5_runtime_test_helper_make_fixture('s1') \\gset
select (job).id as s1_job from enqueue_protocol_execution_job(:'s1_proto', :'s1_proj', 3) \\gset
select claim_token as s1_token from claim_protocol_execution_job('worker-s1', 300) \\gset
select count(*)::text as s1_attempts_before from protocol_attempts where protocol_id = :'s1_proto' \\gset
select status as s1_admit_status, coalesce((attempt).id::text, 'NULL') as s1_attempt_id
  from admit_and_reserve_attempt_for_job(:'s1_job', :'s1_token', :'s1_proj', 'baseline', (:'s1_job' || ':baseline:1'), 0.01, 0.01) \\gset
select count(*)::text as s1_attempts_after from protocol_attempts where protocol_id = :'s1_proto' \\gset
select status as s1_resume_status, coalesce((attempt).id::text, 'NULL') as s1_resume_attempt_id
  from admit_and_reserve_attempt_for_job(:'s1_job', :'s1_token', :'s1_proj', 'baseline', 's1:a-completely-different-fresh-key', 0.01, 0.01) \\gset
select count(*)::text as s1_attempts_after_resume from protocol_attempts where protocol_id = :'s1_proto' \\gset
\\echo '##R## s1_admit_status' :s1_admit_status
\\echo '##R## s1_attempts_before' :s1_attempts_before
\\echo '##R## s1_attempts_after' :s1_attempts_after
\\echo '##R## s1_resume_status' :s1_resume_status
\\echo '##R## s1_attempt_id' :s1_attempt_id
\\echo '##R## s1_resume_attempt_id' :s1_resume_attempt_id
\\echo '##R## s1_attempts_after_resume' :s1_attempts_after_resume
ROLLBACK;

-- ============================================================
-- s2: a reclaim (lease expired, new claim_token) does not create a
-- second attempt either -- RESUME_CURRENT_ATTEMPT again.
-- ============================================================
BEGIN;
select project_id as s2_proj, protocol_id as s2_proto from _m5_runtime_test_helper_make_fixture('s2') \\gset
select (job).id as s2_job from enqueue_protocol_execution_job(:'s2_proto', :'s2_proj', 3) \\gset
select claim_token as s2_token_a from claim_protocol_execution_job('worker-s2-a', 60) \\gset
select status as s2_admit_status, coalesce((attempt).id::text, 'NULL') as s2_attempt_id
  from admit_and_reserve_attempt_for_job(:'s2_job', :'s2_token_a', :'s2_proj', 'baseline', (:'s2_job' || ':baseline:1'), 0.01, 0.01) \\gset
RESET ROLE;
update protocol_execution_jobs set lease_expires_at = now() - interval '1 minute' where id = :'s2_job';
SET ROLE service_role;
select claim_token as s2_token_b from claim_protocol_execution_job('worker-s2-b', 300) \\gset
select count(*)::text as s2_attempts_before_reclaim from protocol_attempts where protocol_id = :'s2_proto' \\gset
select status as s2_reclaim_status, coalesce((attempt).id::text, 'NULL') as s2_reclaim_attempt_id
  from admit_and_reserve_attempt_for_job(:'s2_job', :'s2_token_b', :'s2_proj', 'baseline', (:'s2_job' || ':baseline:1'), 0.01, 0.01) \\gset
select count(*)::text as s2_attempts_after_reclaim from protocol_attempts where protocol_id = :'s2_proto' \\gset
\\echo '##R## s2_admit_status' :s2_admit_status
\\echo '##R## s2_reclaim_status' :s2_reclaim_status
\\echo '##R## s2_attempt_id' :s2_attempt_id
\\echo '##R## s2_reclaim_attempt_id' :s2_reclaim_attempt_id
\\echo '##R## s2_attempts_before_reclaim' :s2_attempts_before_reclaim
\\echo '##R## s2_attempts_after_reclaim' :s2_attempts_after_reclaim
ROLLBACK;

-- ============================================================
-- s3 (defensive): manufacture an otherwise-impossible state -- drop
-- the current_attempt_id FK, point it at a non-existent attempt,
-- exercise CURRENT_ATTEMPT_NOT_FOUND, then roll back everything
-- (including the DROP CONSTRAINT itself -- the FK is never actually
-- left absent).
-- ============================================================
BEGIN;
select project_id as s3_proj, protocol_id as s3_proto from _m5_runtime_test_helper_make_fixture('s3') \\gset
select (job).id as s3_job from enqueue_protocol_execution_job(:'s3_proto', :'s3_proj', 3) \\gset
select claim_token as s3_token from claim_protocol_execution_job('worker-s3', 300) \\gset
select status as s3_admit_status, (attempt).id as s3_attempt_id
  from admit_and_reserve_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', 'baseline', (:'s3_job' || ':baseline:1'), 0.01, 0.01) \\gset
RESET ROLE;
alter table protocol_execution_jobs drop constraint protocol_execution_jobs_current_attempt_fk;
update protocol_execution_jobs set current_attempt_id = gen_random_uuid() where id = :'s3_job';
SET ROLE service_role;
select status as s3_defensive_status
  from admit_and_reserve_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', 'baseline', 's3:another-key', 0.01, 0.01) \\gset
\\echo '##R## s3_defensive_status' :s3_defensive_status
ROLLBACK;

-- ============================================================
-- s4/s5/s6: probe_run atomic creation, replay, wrong project/token.
-- ============================================================
BEGIN;
select project_id as s4_proj, protocol_id as s4_proto from _m5_runtime_test_helper_make_fixture('s4') \\gset
select (job).id as s4_job from enqueue_protocol_execution_job(:'s4_proto', :'s4_proj', 3) \\gset
select claim_token as s4_token from claim_protocol_execution_job('worker-s4', 300) \\gset
select (attempt).id as s4_attempt from admit_and_reserve_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', 'baseline', (:'s4_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_dataset(:'s4_proj') as s4_dataset \\gset
select count(*)::text as s4_runs_before from probe_runs where project_id = :'s4_proj' \\gset
select status as s4_start_status, coalesce((probe_run).id::text, 'NULL') as s4_probe_run
  from create_probe_run_and_start_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_attempt', 'perplexity', 'live_perplexity', :'s4_dataset', 'manual_scan') \\gset
select count(*)::text as s4_runs_after from probe_runs where project_id = :'s4_proj' \\gset
select status as s4_replay_status, coalesce((probe_run).id::text, 'NULL') as s4_replay_probe_run
  from create_probe_run_and_start_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_attempt', 'perplexity', 'live_perplexity', :'s4_dataset', 'manual_scan') \\gset
select count(*)::text as s4_runs_after_replay from probe_runs where project_id = :'s4_proj' \\gset
select status as s4_wrong_token_status
  from create_probe_run_and_start_attempt_for_job(:'s4_job', gen_random_uuid(), :'s4_proj', :'s4_attempt', 'perplexity', 'live_perplexity', :'s4_dataset', 'manual_scan') \\gset
select count(*)::text as s4_runs_after_wrong_token from probe_runs where project_id = :'s4_proj' \\gset
\\echo '##R## s4_start_status' :s4_start_status
\\echo '##R## s4_probe_run' :s4_probe_run
\\echo '##R## s4_runs_before' :s4_runs_before
\\echo '##R## s4_runs_after' :s4_runs_after
\\echo '##R## s4_replay_status' :s4_replay_status
\\echo '##R## s4_replay_probe_run' :s4_replay_probe_run
\\echo '##R## s4_runs_after_replay' :s4_runs_after_replay
\\echo '##R## s4_wrong_token_status' :s4_wrong_token_status
\\echo '##R## s4_runs_after_wrong_token' :s4_runs_after_wrong_token

-- s7 (same fixture, still inside this transaction): a full attempt
-- with both receipts, then a REAL execution of
-- get_protocol_execution_job_context, checking the array_agg(composite)
-- construction actually works (flagged as unexecuted in the prior
-- read-only pass).
select status from mark_external_call_sent_for_job(:'s4_job', :'s4_token', :'s4_proj',
  (select id from protocol_external_calls where protocol_attempt_id = :'s4_attempt' and call_kind = 'perplexity'), :'s4_probe_run');
select status from record_provider_call_receipt_for_job(:'s4_job', :'s4_token', :'s4_proj',
  (select id from protocol_external_calls where protocol_attempt_id = :'s4_attempt' and call_kind = 'perplexity'),
  :'s4_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s4_job', :'s4_token', :'s4_proj',
  (select id from protocol_external_calls where protocol_attempt_id = :'s4_attempt' and call_kind = 'analysis'), :'s4_probe_run');
select status from record_analysis_call_receipt_for_job(:'s4_job', :'s4_token', :'s4_proj',
  (select id from protocol_external_calls where protocol_attempt_id = :'s4_attempt' and call_kind = 'analysis'),
  :'s4_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status as s7_context_status,
       coalesce((job).id::text, 'NULL') as s7_ctx_job,
       coalesce((current_attempt).id::text, 'NULL') as s7_ctx_attempt,
       coalesce(array_length(external_calls, 1)::text, 'NULL') as s7_ctx_calls_len,
       coalesce(array_length(provider_receipts, 1)::text, 'NULL') as s7_ctx_provider_receipts_len,
       coalesce(array_length(analysis_receipts, 1)::text, 'NULL') as s7_ctx_analysis_receipts_len,
       coalesce((probe_run).id::text, 'NULL') as s7_ctx_probe_run
  from get_protocol_execution_job_context(:'s4_job', :'s4_token', :'s4_proj') \\gset
\\echo '##R## s7_context_status' :s7_context_status
\\echo '##R## s7_ctx_job' :s7_ctx_job
\\echo '##R## s7_ctx_attempt' :s7_ctx_attempt
\\echo '##R## s7_ctx_calls_len' :s7_ctx_calls_len
\\echo '##R## s7_ctx_provider_receipts_len' :s7_ctx_provider_receipts_len
\\echo '##R## s7_ctx_analysis_receipts_len' :s7_ctx_analysis_receipts_len
\\echo '##R## s7_ctx_probe_run' :s7_ctx_probe_run
ROLLBACK;

-- ============================================================
-- s8: operator idempotency. Build a needs_review job (Perplexity
-- provider_outcome_unknown), then exercise authorize_operator_retry's
-- fingerprinted idempotence: first call approved; same key + same
-- intent replays the exact result (no new action row); same key +
-- different intent -> IDEMPOTENCY_KEY_CONFLICT, zero mutation; a
-- denied action (spend cap exceeded) replayed returns the same denial
-- even after the cap is loosened (proving no cap re-evaluation); the
-- stored fingerprint is a real, reproducible SHA-256 hex of the exact
-- canonical JSONB.
-- ============================================================
BEGIN;
select project_id as s8_proj, protocol_id as s8_proto from _m5_runtime_test_helper_make_fixture('s8', 20, 1.00, 5) \\gset
select (job).id as s8_job from enqueue_protocol_execution_job(:'s8_proto', :'s8_proj', 3) \\gset
select claim_token as s8_token from claim_protocol_execution_job('worker-s8', 300) \\gset
select (attempt).id as s8_attempt, (perplexity_call).id as s8_pcall
  from admit_and_reserve_attempt_for_job(:'s8_job', :'s8_token', :'s8_proj', 'baseline', (:'s8_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s8_proj', 's8') as s8_probe_run \\gset
select status from start_attempt_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_attempt', :'s8_probe_run');
select status from mark_external_call_sent_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_pcall', :'s8_probe_run');
select status as s8_receipt_status from record_provider_call_receipt_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_pcall', :'s8_probe_run', 'provider_outcome_unknown') \\gset
select status as s8_job_status, needs_review_reason as s8_reason from protocol_execution_jobs where id = :'s8_job' \\gset

select count(*)::text as s8_actions_before from protocol_operator_actions where job_id = :'s8_job' \\gset
-- Deliberately over-priced so the FIRST authorize call is denied
-- (spend_cap_usd = 1.00 on this fixture).
select status as s8_denied_status, outcome as s8_denied_outcome, denial_code as s8_denial_code
  from authorize_operator_retry(:'s8_job', :'s8_proj', 'qa', 'first denied attempt', 'retry_full_attempt', :'s8_attempt', 50.00, 's8:decision-1', null, 50.00) \\gset
select count(*)::text as s8_actions_after_denied from protocol_operator_actions where job_id = :'s8_job' \\gset

-- Loosen the cap, then replay the SAME key: must return the SAME
-- denial, never re-evaluate against the now-loosened cap.
RESET ROLE;
update protocols set spend_cap_usd = 1000.00 where id = :'s8_proto';
SET ROLE service_role;
select status as s8_denied_replay_status, outcome as s8_denied_replay_outcome, denial_code as s8_denied_replay_denial_code
  from authorize_operator_retry(:'s8_job', :'s8_proj', 'qa', 'replaying the same denied decision', 'retry_full_attempt', :'s8_attempt', 50.00, 's8:decision-1', null, 50.00) \\gset
select count(*)::text as s8_actions_after_denied_replay from protocol_operator_actions where job_id = :'s8_job' \\gset

-- Now a genuinely NEW key, small enough to be approved.
select status as s8_approved_status, outcome as s8_approved_outcome, coalesce((new_attempt).id::text, 'NULL') as s8_new_attempt
  from authorize_operator_retry(:'s8_job', :'s8_proj', 'qa', 'a real approved retry', 'retry_full_attempt', :'s8_attempt', 0.02, 's8:decision-2', null, 0.02) \\gset
select count(*)::text as s8_actions_after_approved from protocol_operator_actions where job_id = :'s8_job' \\gset

-- Same key ('decision-2') + same intent -> replays the exact result.
select status as s8_same_intent_status, outcome as s8_same_intent_outcome, coalesce((new_attempt).id::text, 'NULL') as s8_same_intent_attempt
  from authorize_operator_retry(:'s8_job', :'s8_proj', 'qa', 'irrelevant reason text, replay must still match', 'retry_full_attempt', :'s8_attempt', 0.02, 's8:decision-2', null, 0.02) \\gset
select count(*)::text as s8_actions_after_same_intent from protocol_operator_actions where job_id = :'s8_job' \\gset

-- Same key ('decision-2') + DIFFERENT intent (different cost) -> conflict.
select status as s8_conflict_status
  from authorize_operator_retry(:'s8_job', :'s8_proj', 'qa', 'same key, different cost -- must conflict', 'retry_full_attempt', :'s8_attempt', 0.03, 's8:decision-2', null, 0.03) \\gset
select count(*)::text as s8_actions_after_conflict from protocol_operator_actions where job_id = :'s8_job' \\gset

-- Fingerprint must be a real, reproducible SHA-256 hex of the exact
-- canonical JSONB this decision used.
select request_fingerprint as s8_stored_fingerprint from protocol_operator_actions
 where job_id = :'s8_job' and idempotency_key = 's8:decision-2' \\gset
select case when (encode(digest(convert_to(
    jsonb_build_object(
      'job_id', :'s8_job', 'project_id', :'s8_proj', 'action', 'retry_full_attempt',
      'source_attempt_id', :'s8_attempt', 'source_external_call_id', null,
      'reserved_cost_usd', 0.02, 'perplexity_reserved_cost_usd', 0.02
    )::text, 'UTF8'), 'sha256'), 'hex') = :'s8_stored_fingerprint') then 't' else 'f' end as s8_fingerprint_reproducible \\gset
\\echo '##R## s8_job_status' :s8_job_status
\\echo '##R## s8_reason' :s8_reason
\\echo '##R## s8_actions_before' :s8_actions_before
\\echo '##R## s8_denied_status' :s8_denied_status
\\echo '##R## s8_denied_outcome' :s8_denied_outcome
\\echo '##R## s8_denial_code' :s8_denial_code
\\echo '##R## s8_actions_after_denied' :s8_actions_after_denied
\\echo '##R## s8_denied_replay_status' :s8_denied_replay_status
\\echo '##R## s8_denied_replay_outcome' :s8_denied_replay_outcome
\\echo '##R## s8_denied_replay_denial_code' :s8_denied_replay_denial_code
\\echo '##R## s8_actions_after_denied_replay' :s8_actions_after_denied_replay
\\echo '##R## s8_approved_status' :s8_approved_status
\\echo '##R## s8_actions_after_approved' :s8_actions_after_approved
\\echo '##R## s8_same_intent_status' :s8_same_intent_status
\\echo '##R## s8_same_intent_attempt' :s8_same_intent_attempt
\\echo '##R## s8_new_attempt' :s8_new_attempt
\\echo '##R## s8_actions_after_same_intent' :s8_actions_after_same_intent
\\echo '##R## s8_conflict_status' :s8_conflict_status
\\echo '##R## s8_actions_after_conflict' :s8_actions_after_conflict
\\echo '##R## s8_fingerprint_reproducible' :s8_fingerprint_reproducible
ROLLBACK;

-- ============================================================
-- s9: full-attempt retry. Perplexity failed+receipted, analysis also
-- terminal, attempt reconciled 'failed' -> exactly one automatic
-- retry; replay -> ALREADY_RETRIED same attempt; different intent on
-- the same source -> SOURCE_ALREADY_RETRIED, no second child; cross-
-- job source -> refused, zero mutation.
-- ============================================================
BEGIN;
select project_id as s9_proj, protocol_id as s9_proto from _m5_runtime_test_helper_make_fixture('s9', 20, 100.00, 5) \\gset
select (job).id as s9_job from enqueue_protocol_execution_job(:'s9_proto', :'s9_proj', 3) \\gset
select claim_token as s9_token from claim_protocol_execution_job('worker-s9', 300) \\gset
select (attempt).id as s9_attempt, (perplexity_call).id as s9_pcall, (analysis_call).id as s9_acall
  from admit_and_reserve_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', 'baseline', (:'s9_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s9_proj', 's9') as s9_probe_run \\gset
select status from start_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', :'s9_probe_run');
select status from mark_external_call_sent_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_pcall', :'s9_probe_run');
select status from record_provider_call_receipt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_pcall', :'s9_probe_run', 'provider_error', 500, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_acall', :'s9_probe_run');
select status from record_analysis_call_receipt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_acall', :'s9_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', 'failed', 'both legs failed');
select count(*)::text as s9_attempts_before from protocol_attempts where protocol_id = :'s9_proto' \\gset
select status as s9_retry_status, coalesce((attempt).id::text, 'NULL') as s9_new_attempt
  from retry_full_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', 0.02, 0.02) \\gset
select count(*)::text as s9_attempts_after from protocol_attempts where protocol_id = :'s9_proto' \\gset
select status as s9_replay_status, coalesce((attempt).id::text, 'NULL') as s9_replay_attempt
  from retry_full_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', 0.02, 0.02) \\gset
select count(*)::text as s9_attempts_after_replay from protocol_attempts where protocol_id = :'s9_proto' \\gset
select status as s9_conflict_status
  from retry_full_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', 0.99, 0.99) \\gset
select count(*)::text as s9_attempts_after_conflict from protocol_attempts where protocol_id = :'s9_proto' \\gset

-- Cross-job source: a second, unrelated job/attempt cannot be
-- "retried" through job A's fencing.
select project_id as s9x_proj, protocol_id as s9x_proto from _m5_runtime_test_helper_make_fixture('s9x') \\gset
select (job).id as s9x_job from enqueue_protocol_execution_job(:'s9x_proto', :'s9x_proj', 3) \\gset
select claim_token as s9x_token from claim_protocol_execution_job('worker-s9x', 300) \\gset
select (attempt).id as s9x_attempt from admit_and_reserve_attempt_for_job(:'s9x_job', :'s9x_token', :'s9x_proj', 'baseline', (:'s9x_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status as s9_cross_job_status
  from retry_full_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9x_attempt', 0.02, 0.02) \\gset
\\echo '##R## s9_retry_status' :s9_retry_status
\\echo '##R## s9_attempts_before' :s9_attempts_before
\\echo '##R## s9_attempts_after' :s9_attempts_after
\\echo '##R## s9_replay_status' :s9_replay_status
\\echo '##R## s9_new_attempt' :s9_new_attempt
\\echo '##R## s9_replay_attempt' :s9_replay_attempt
\\echo '##R## s9_attempts_after_replay' :s9_attempts_after_replay
\\echo '##R## s9_conflict_status' :s9_conflict_status
\\echo '##R## s9_attempts_after_conflict' :s9_attempts_after_conflict
\\echo '##R## s9_cross_job_status' :s9_cross_job_status
ROLLBACK;

-- ============================================================
-- s10: analysis-only retry. Perplexity completed+receipted, analysis
-- gen1 failed+receipted, attempt left 'in_progress' (this is a
-- requirement of _reserve_additional_analysis_generation_core, which
-- only ever reserves a new generation under an attempt still
-- in_progress -- an analysis-only retry must happen BEFORE the attempt
-- is reconciled, never after) -> exactly one new analysis generation,
-- ZERO new Perplexity calls. Replay -> ALREADY_RETRIED same generation.
-- Different intent -> SOURCE_ALREADY_RETRIED. Non-authoritative
-- (older) generation as source -> refused. retry_cap enforced on
-- first creation.
-- ============================================================
BEGIN;
select project_id as s10_proj, protocol_id as s10_proto from _m5_runtime_test_helper_make_fixture('s10', 20, 100.00, 2) \\gset
select (job).id as s10_job from enqueue_protocol_execution_job(:'s10_proto', :'s10_proj', 3) \\gset
select claim_token as s10_token from claim_protocol_execution_job('worker-s10', 300) \\gset
select (attempt).id as s10_attempt, (perplexity_call).id as s10_pcall, (analysis_call).id as s10_acall1
  from admit_and_reserve_attempt_for_job(:'s10_job', :'s10_token', :'s10_proj', 'baseline', (:'s10_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s10_proj', 's10') as s10_probe_run \\gset
select status from start_attempt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_attempt', :'s10_probe_run');
select status from mark_external_call_sent_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_pcall', :'s10_probe_run');
select status from record_provider_call_receipt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_pcall', :'s10_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', :'s10_probe_run');
select status from record_analysis_call_receipt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', :'s10_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select count(*)::text as s10_pcalls_before from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'perplexity' \\gset
select count(*)::text as s10_acalls_before from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'analysis' \\gset
select status as s10_retry_status, coalesce((external_call).id::text, 'NULL') as s10_new_call, (external_call).generation as s10_new_generation
  from retry_analysis_generation_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', 0.02) \\gset
select count(*)::text as s10_pcalls_after from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'perplexity' \\gset
select count(*)::text as s10_acalls_after from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'analysis' \\gset
select status as s10_replay_status, coalesce((external_call).id::text, 'NULL') as s10_replay_call
  from retry_analysis_generation_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', 0.02) \\gset
select count(*)::text as s10_acalls_after_replay from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'analysis' \\gset
select status as s10_conflict_status
  from retry_analysis_generation_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', 0.99) \\gset
-- D-021/D-022 arbitration: retry_analysis_generation_for_job's
-- existing-child lookup (by retry_of_external_call_id, which never
-- changes) is checked BEFORE the authoritative-generation check, by
-- design, never to be reordered -- acall1 already has a child (gen2,
-- created above) so a THIRD call replaying acall1 with the SAME
-- reserved cost must still resolve to ALREADY_RETRIED, referencing the
-- exact same child, creating no new row and mutating nothing. This is
-- not the non-authoritative-generation scenario (see the dedicated s10c
-- fixture below for that, which requires a source with no existing
-- child at all).
select status as s10_replay2_status, coalesce((external_call).id::text, 'NULL') as s10_replay2_call
  from retry_analysis_generation_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall1', 0.02) \\gset
select count(*)::text as s10_acalls_after_replay2 from protocol_external_calls where protocol_attempt_id = :'s10_attempt' and call_kind = 'analysis' \\gset
\\echo '##R## s10_pcalls_before' :s10_pcalls_before
\\echo '##R## s10_pcalls_after' :s10_pcalls_after
\\echo '##R## s10_acalls_before' :s10_acalls_before
\\echo '##R## s10_acalls_after' :s10_acalls_after
\\echo '##R## s10_retry_status' :s10_retry_status
\\echo '##R## s10_new_generation' :s10_new_generation
\\echo '##R## s10_replay_status' :s10_replay_status
\\echo '##R## s10_new_call' :s10_new_call
\\echo '##R## s10_replay_call' :s10_replay_call
\\echo '##R## s10_acalls_after_replay' :s10_acalls_after_replay
\\echo '##R## s10_conflict_status' :s10_conflict_status
\\echo '##R## s10_replay2_status' :s10_replay2_status
\\echo '##R## s10_replay2_call' :s10_replay2_call
\\echo '##R## s10_acalls_after_replay2' :s10_acalls_after_replay2
ROLLBACK;

-- ============================================================
-- s10c (defensive): SOURCE_NOT_AUTHORITATIVE_GENERATION genuinely
-- fires for a pre-D-021-style historical state that D-021's own
-- structural guarantees (the retry_of_external_call_id composite FK
-- and partial unique index) cannot rule out on their own: an older
-- analysis generation that has NEVER been retried (no row anywhere
-- carries retry_of_external_call_id = its id) while a strictly newer
-- generation already exists for the same attempt. This cannot arise
-- through retry_analysis_generation_for_job itself (every generation
-- it creates is linked to its source), so it is built here directly,
-- as the fixture owner (RESET ROLE), by inserting the newer generation
-- without a retry_of_external_call_id link -- exactly the shape actual
-- pre-D-021 rows have, since the column did not exist before this
-- migration. Every column/constraint on protocol_external_calls is
-- honored (no constraint is disabled or bypassed): call_kind/
-- generation/status/terminal_pair/cost_basis_pair/probe_run_lifecycle
-- all hold on the inserted row exactly as they would for any organic
-- row of that shape.
-- ============================================================
BEGIN;
select project_id as s10c_proj, protocol_id as s10c_proto from _m5_runtime_test_helper_make_fixture('s10c', 20, 100.00, 5) \\gset
select (job).id as s10c_job from enqueue_protocol_execution_job(:'s10c_proto', :'s10c_proj', 3) \\gset
select claim_token as s10c_token from claim_protocol_execution_job('worker-s10c', 300) \\gset
select (attempt).id as s10c_attempt, (perplexity_call).id as s10c_pcall, (analysis_call).id as s10c_acall1
  from admit_and_reserve_attempt_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', 'baseline', (:'s10c_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s10c_proj', 's10c') as s10c_probe_run \\gset
select status from start_attempt_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_attempt', :'s10c_probe_run');
select status from mark_external_call_sent_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_pcall', :'s10c_probe_run');
select status from record_provider_call_receipt_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_pcall', :'s10c_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_acall1', :'s10c_probe_run');
select status from record_analysis_call_receipt_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_acall1', :'s10c_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select count(*)::text as s10c_acalls_before from protocol_external_calls where protocol_attempt_id = :'s10c_attempt' and call_kind = 'analysis' \\gset

-- Fixture-owner-only: insert a strictly newer, valid, fully
-- constraint-satisfying analysis generation with NO
-- retry_of_external_call_id link -- simulating genuine pre-D-021
-- historical data, never something D-021's own RPCs would produce.
RESET ROLE;
insert into protocol_external_calls (
  project_id, protocol_attempt_id, call_kind, generation, status,
  reserved_cost_usd, actual_cost_usd, cost_basis, terminalized_at, retry_of_external_call_id
) values (
  :'s10c_proj', :'s10c_attempt', 'analysis', 2, 'completed',
  0.02, 0.02, 'measured', now(), null
);
SET ROLE service_role;

select count(*)::text as s10c_acalls_after_insert from protocol_external_calls where protocol_attempt_id = :'s10c_attempt' and call_kind = 'analysis' \\gset
select count(*)::text as s10c_children_of_acall1 from protocol_external_calls where retry_of_external_call_id = :'s10c_acall1' \\gset

-- The old (non-authoritative, never-retried) generation is refused.
select status as s10c_nonauthoritative_status
  from retry_analysis_generation_for_job(:'s10c_job', :'s10c_token', :'s10c_proj', :'s10c_acall1', 0.02) \\gset
select count(*)::text as s10c_acalls_after_call from protocol_external_calls where protocol_attempt_id = :'s10c_attempt' and call_kind = 'analysis' \\gset
\\echo '##R## s10c_acalls_before' :s10c_acalls_before
\\echo '##R## s10c_acalls_after_insert' :s10c_acalls_after_insert
\\echo '##R## s10c_children_of_acall1' :s10c_children_of_acall1
\\echo '##R## s10c_nonauthoritative_status' :s10c_nonauthoritative_status
\\echo '##R## s10c_acalls_after_call' :s10c_acalls_after_call
ROLLBACK;

-- ============================================================
-- s10b: retry_cap enforcement on first creation (retry_cap=1 on this
-- fixture -> max allowed generation is retry_cap+1=2; a third
-- generation must be refused RETRY_CAP_EXCEEDED).
-- ============================================================
BEGIN;
select project_id as s10b_proj, protocol_id as s10b_proto from _m5_runtime_test_helper_make_fixture('s10b', 20, 100.00, 1) \\gset
select (job).id as s10b_job from enqueue_protocol_execution_job(:'s10b_proto', :'s10b_proj', 3) \\gset
select claim_token as s10b_token from claim_protocol_execution_job('worker-s10b', 300) \\gset
select (attempt).id as s10b_attempt, (perplexity_call).id as s10b_pcall, (analysis_call).id as s10b_acall1
  from admit_and_reserve_attempt_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', 'baseline', (:'s10b_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s10b_proj', 's10b') as s10b_probe_run \\gset
select status from start_attempt_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_attempt', :'s10b_probe_run');
select status from mark_external_call_sent_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_pcall', :'s10b_probe_run');
select status from record_provider_call_receipt_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_pcall', :'s10b_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall1', :'s10b_probe_run');
select status from record_analysis_call_receipt_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall1', :'s10b_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
-- Attempt is deliberately left 'in_progress' here (never reconciled) --
-- _reserve_additional_analysis_generation_core requires in_progress,
-- so the retry_cap enforcement below must be exercised before any
-- reconciliation, exactly like s10.
select status as s10b_gen2_status, coalesce((external_call).id::text, 'NULL') as s10b_acall2
  from retry_analysis_generation_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall1', 0.02) \\gset
select status from mark_external_call_sent_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall2', :'s10b_probe_run');
select status from record_analysis_call_receipt_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall2', :'s10b_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select count(*)::text as s10b_acalls_before_cap from protocol_external_calls where protocol_attempt_id = :'s10b_attempt' and call_kind = 'analysis' \\gset
select status as s10b_gen3_capped_status
  from retry_analysis_generation_for_job(:'s10b_job', :'s10b_token', :'s10b_proj', :'s10b_acall2', 0.02) \\gset
select count(*)::text as s10b_acalls_after_cap from protocol_external_calls where protocol_attempt_id = :'s10b_attempt' and call_kind = 'analysis' \\gset
\\echo '##R## s10b_gen2_status' :s10b_gen2_status
\\echo '##R## s10b_gen3_capped_status' :s10b_gen3_capped_status
\\echo '##R## s10b_acalls_before_cap' :s10b_acalls_before_cap
\\echo '##R## s10b_acalls_after_cap' :s10b_acalls_after_cap
ROLLBACK;

-- ============================================================
-- s11: ambiguity -> needs_review. request_sent_at with no receipt ->
-- NEEDS_REVIEW with the exact reason; replay -> ALREADY_NEEDS_REVIEW;
-- a healthy job with no ambiguous call -> NO_AMBIGUOUS_CALL, zero
-- mutation; no automatic retry is reachable from needs_review; the
-- needs_review_reason/status CHECK is genuinely enforced.
-- ============================================================
BEGIN;
select project_id as s11_proj, protocol_id as s11_proto from _m5_runtime_test_helper_make_fixture('s11') \\gset
select (job).id as s11_job from enqueue_protocol_execution_job(:'s11_proto', :'s11_proj', 3) \\gset
select claim_token as s11_token from claim_protocol_execution_job('worker-s11', 300) \\gset
select (attempt).id as s11_attempt, (perplexity_call).id as s11_pcall
  from admit_and_reserve_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', 'baseline', (:'s11_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s11_proj', 's11') as s11_probe_run \\gset
select status from start_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_attempt', :'s11_probe_run');
select status from mark_external_call_sent_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_pcall', :'s11_probe_run');
select status as s11_ambiguous_status, (job).needs_review_reason as s11_reason
  from mark_protocol_execution_job_needs_review_for_ambiguity(:'s11_job', :'s11_token', :'s11_proj') \\gset
select status as s11_replay_status
  from mark_protocol_execution_job_needs_review_for_ambiguity(:'s11_job', :'s11_token', :'s11_proj') \\gset
-- No automatic retry is reachable from needs_review (fencing requires claimed/running).
select status as s11_no_auto_retry_status
  from retry_full_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_attempt', 0.02, 0.02) \\gset
\\echo '##R## s11_ambiguous_status' :s11_ambiguous_status
\\echo '##R## s11_reason' :s11_reason
\\echo '##R## s11_replay_status' :s11_replay_status
\\echo '##R## s11_no_auto_retry_status' :s11_no_auto_retry_status
ROLLBACK;

-- s11b: a healthy job (nothing ambiguous) -> NO_AMBIGUOUS_CALL, zero mutation.
BEGIN;
select project_id as s11b_proj, protocol_id as s11b_proto from _m5_runtime_test_helper_make_fixture('s11b') \\gset
select (job).id as s11b_job from enqueue_protocol_execution_job(:'s11b_proto', :'s11b_proj', 3) \\gset
select claim_token as s11b_token from claim_protocol_execution_job('worker-s11b', 300) \\gset
select (attempt).id as s11b_attempt from admit_and_reserve_attempt_for_job(:'s11b_job', :'s11b_token', :'s11b_proj', 'baseline', (:'s11b_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status as s11b_job_status_before from protocol_execution_jobs where id = :'s11b_job' \\gset
select status as s11b_no_ambiguity_status
  from mark_protocol_execution_job_needs_review_for_ambiguity(:'s11b_job', :'s11b_token', :'s11b_proj') \\gset
select status as s11b_job_status_after from protocol_execution_jobs where id = :'s11b_job' \\gset
\\echo '##R## s11b_no_ambiguity_status' :s11b_no_ambiguity_status
\\echo '##R## s11b_job_status_before' :s11b_job_status_before
\\echo '##R## s11b_job_status_after' :s11b_job_status_after
ROLLBACK;

-- s11c (defensive): the needs_review_reason/status CHECK constraint is
-- genuinely enforced by Postgres, not merely by application discipline.
-- The probe is a parameterized pg_temp function -- never a DO block
-- referencing a psql client variable, since psql's ':'name'
-- substitution does not occur inside a dollar-quoted function/DO body;
-- passing the job id as a real function parameter, then calling that
-- function from a plain (non-dollar-quoted) statement where
-- substitution does apply, avoids that class of bug entirely. Its own
-- EXCEPTION handler (an implicit inner savepoint) catches the expected
-- check_violation without aborting the outer transaction, and records
-- a definitive, positively-observed outcome in a temp table -- never
-- relying on transaction-abort side effects to infer what happened.
-- Everything still rolls back at the end; nothing is ever actually
-- left in a violating state.
BEGIN;
select project_id as s11c_proj, protocol_id as s11c_proto from _m5_runtime_test_helper_make_fixture('s11c') \\gset
select (job).id as s11c_job from enqueue_protocol_execution_job(:'s11c_proto', :'s11c_proj', 3) \\gset
RESET ROLE;
create temporary table s11c_probe (result text);
create or replace function pg_temp._m5_0051_s11c_probe_violation(p_job_id uuid) returns void language plpgsql as $s11cfn$
begin
  begin
    update protocol_execution_jobs set status = 'needs_review', needs_review_reason = null where id = p_job_id;
  exception when check_violation then
    insert into s11c_probe values ('CHECK_VIOLATION_CORRECTLY_REJECTED');
  end;
end;
$s11cfn$;
select pg_temp._m5_0051_s11c_probe_violation(:'s11c_job');
select coalesce((select result from s11c_probe limit 1), 'CONSTRAINT_DID_NOT_FIRE_BUG') as s11c_violation_result \\gset
SET ROLE service_role;
\\echo '##R## s11c_violation_result' :s11c_violation_result
ROLLBACK;

-- ============================================================
-- s12 (atomicity): a controlled, reversible fault trigger on
-- probe_runs forces create_probe_run_and_start_attempt_for_job's
-- SECOND internal write (the protocol_attempts UPDATE) to fail after
-- its FIRST write (the probe_runs INSERT) already succeeded within the
-- same statement -- proving the whole RPC call rolls back atomically:
-- zero probe_runs rows, attempt still exactly 'reserved'. Never
-- touches 0050/0051 files themselves.
-- ============================================================
BEGIN;
select project_id as s12_proj, protocol_id as s12_proto from _m5_runtime_test_helper_make_fixture('s12') \\gset
select (job).id as s12_job from enqueue_protocol_execution_job(:'s12_proto', :'s12_proj', 3) \\gset
select claim_token as s12_token from claim_protocol_execution_job('worker-s12', 300) \\gset
select (attempt).id as s12_attempt from admit_and_reserve_attempt_for_job(:'s12_job', :'s12_token', :'s12_proj', 'baseline', (:'s12_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_dataset(:'s12_proj') as s12_dataset \\gset

RESET ROLE;
create or replace function public._m5_0051_fault_injection_trigger() returns trigger language plpgsql as $f$
begin
  raise exception using errcode = 'P0001', message = 'm5_0051_runtime_fault_injection: simulated failure after the probe_runs insert';
end;
$f$;
create trigger _m5_0051_fault_injection_trg
  after update on protocol_attempts
  for each row
  when (NEW.id = OLD.id and NEW.status = 'in_progress' and OLD.status = 'reserved')
  execute function public._m5_0051_fault_injection_trigger();
SET ROLE service_role;

select count(*)::text as s12_runs_before from probe_runs where project_id = :'s12_proj' \\gset
select count(*)::text as s12_attempt_reserved_before from protocol_attempts where id = :'s12_attempt' and status = 'reserved' \\gset

SAVEPOINT s12_fault;
select status from create_probe_run_and_start_attempt_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_attempt', 'perplexity', 'live_perplexity', :'s12_dataset', 'manual_scan');
ROLLBACK TO SAVEPOINT s12_fault;

select count(*)::text as s12_runs_after from probe_runs where project_id = :'s12_proj' \\gset
select count(*)::text as s12_attempt_reserved_after from protocol_attempts where id = :'s12_attempt' and status = 'reserved' \\gset

RESET ROLE;
drop trigger _m5_0051_fault_injection_trg on protocol_attempts;
drop function public._m5_0051_fault_injection_trigger();
SET ROLE service_role;

-- Prove the RPC works normally again once the fault is removed.
select status as s12_normal_status
  from create_probe_run_and_start_attempt_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_attempt', 'perplexity', 'live_perplexity', :'s12_dataset', 'manual_scan') \\gset

\\echo '##R## s12_runs_before' :s12_runs_before
\\echo '##R## s12_runs_after' :s12_runs_after
\\echo '##R## s12_attempt_reserved_before' :s12_attempt_reserved_before
\\echo '##R## s12_attempt_reserved_after' :s12_attempt_reserved_after
\\echo '##R## s12_normal_status' :s12_normal_status
ROLLBACK;

-- ============================================================
-- s13: monitoring view, real query against known fixture counts.
-- ============================================================
BEGIN;
select project_id as s13_proj, protocol_id as s13_proto from _m5_runtime_test_helper_make_fixture('s13') \\gset
select (job).id as s13_job from enqueue_protocol_execution_job(:'s13_proto', :'s13_proj', 3) \\gset
select claim_token as s13_token from claim_protocol_execution_job('worker-s13', 300) \\gset
select (attempt).id as s13_attempt, (perplexity_call).id as s13_pcall, (analysis_call).id as s13_acall
  from admit_and_reserve_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', 'baseline', (:'s13_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s13_proj', 's13') as s13_probe_run \\gset
select status from start_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_attempt', :'s13_probe_run');
-- Leave the perplexity call sent-but-unreceipted -- exactly the
-- sent-without-receipt condition the monitoring view must count.
select status from mark_external_call_sent_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_pcall', :'s13_probe_run');

select jobs_claimed_or_running::text as s13_jobs_claimed_or_running,
       external_calls_sent_without_receipt::text as s13_sent_without_receipt
  from protocol_execution_job_monitoring_v1 \\gset
-- Confirm anon is genuinely denied a real SELECT, not merely by ACL
-- metadata inspection. The probe table is created as postgres, before
-- switching role, so anon only ever needs INSERT/SELECT on it (an
-- ordinary temp table its own session created), never CREATE.
RESET ROLE;
create temporary table s13_anon_probe (result text);
grant all on s13_anon_probe to anon;
SET ROLE anon;
do $do13$
begin
  begin
    perform * from protocol_execution_job_monitoring_v1;
    insert into s13_anon_probe values ('ANON_COULD_SELECT_BUG');
  exception when insufficient_privilege then
    insert into s13_anon_probe values ('ANON_CORRECTLY_DENIED');
  end;
end;
$do13$;
RESET ROLE;
select coalesce((select result from s13_anon_probe limit 1), 'UNKNOWN') as s13_anon_result \\gset
SET ROLE service_role;

\\echo '##R## s13_jobs_claimed_or_running' :s13_jobs_claimed_or_running
\\echo '##R## s13_sent_without_receipt' :s13_sent_without_receipt
\\echo '##R## s13_anon_result' :s13_anon_result
ROLLBACK;

-- ============================================================
-- s14 (D-024): reactivate_abandoned_job is fingerprinted and
-- replay-safe. s14a: first reactivation, then replay after the job's
-- own status has since changed again -- same decision, zero new
-- mutation. s14b: the same idempotency key already used by a
-- DIFFERENT operator action type on the same job (the unique
-- constraint has no action column) -> IDEMPOTENCY_KEY_CONFLICT. s14c:
-- a non-abandoned job is refused, and that refusal is itself
-- idempotent. s14d: wrong project scope -> JOB_NOT_FOUND, zero
-- mutation. s14e: a raw duplicate INSERT bypassing the RPC entirely
-- proves the unique constraint itself is a real, enforced backstop,
-- never silently absorbed.
-- ============================================================
BEGIN;
select project_id as s14_proj, protocol_id as s14_proto from _m5_runtime_test_helper_make_fixture('s14', 20, 100.00, 1) \\gset
select (job).id as s14_job from enqueue_protocol_execution_job(:'s14_proto', :'s14_proj', 1) \\gset
select claim_token as s14_token from claim_protocol_execution_job('worker-s14', 300) \\gset
-- Force this job into abandoned_exhausted: backdate its lease directly
-- (fixture owner only) and let claim_protocol_execution_job's own sweep
-- step make the transition -- never write abandoned_exhausted directly.
RESET ROLE;
update protocol_execution_jobs set lease_expires_at = now() - interval '1 minute' where id = :'s14_job';
SET ROLE service_role;
select status from claim_protocol_execution_job('worker-s14-sweep', 300);
select status as s14_status_before_reactivate from protocol_execution_jobs where id = :'s14_job' \\gset
select count(*)::text as s14_actions_before from protocol_operator_actions where job_id = :'s14_job' \\gset

select status as s14_reactivate_status, (job).attempt_count::text as s14_attempt_count_after
  from reactivate_abandoned_job(:'s14_job', :'s14_proj', 'qa', 'recovering an abandoned job', 's14:decision-1') \\gset
select count(*)::text as s14_actions_after_reactivate from protocol_operator_actions where job_id = :'s14_job' \\gset

-- Change the job's status again before replaying the SAME key -- the
-- replay must resolve identically regardless of the job's status now.
RESET ROLE;
update protocol_execution_jobs set status = 'failed' where id = :'s14_job';
SET ROLE service_role;
select status as s14_replay_status
  from reactivate_abandoned_job(:'s14_job', :'s14_proj', 'qa', 'replaying, irrelevant text', 's14:decision-1') \\gset
select count(*)::text as s14_actions_after_replay from protocol_operator_actions where job_id = :'s14_job' \\gset

\\echo '##R## s14_status_before_reactivate' :s14_status_before_reactivate
\\echo '##R## s14_actions_before' :s14_actions_before
\\echo '##R## s14_reactivate_status' :s14_reactivate_status
\\echo '##R## s14_attempt_count_after' :s14_attempt_count_after
\\echo '##R## s14_actions_after_reactivate' :s14_actions_after_reactivate
\\echo '##R## s14_replay_status' :s14_replay_status
\\echo '##R## s14_actions_after_replay' :s14_actions_after_replay
ROLLBACK;

-- s14b: same key already used by a different operator action type on
-- the same job -> IDEMPOTENCY_KEY_CONFLICT (the unique constraint is
-- (project_id, job_id, idempotency_key), deliberately without action).
BEGIN;
select project_id as s14b_proj, protocol_id as s14b_proto from _m5_runtime_test_helper_make_fixture('s14b') \\gset
select (job).id as s14b_job from enqueue_protocol_execution_job(:'s14b_proto', :'s14b_proj', 3) \\gset
RESET ROLE;
insert into protocol_operator_actions (
  project_id, job_id, actor, reason, action, outcome, denial_code,
  idempotency_key, request_fingerprint
) values (
  :'s14b_proj', :'s14b_job', 'qa', 'an unrelated earlier decision', 'retry_full_attempt', 'denied', 'SPEND_CAP_EXCEEDED',
  's14b:shared-key', repeat('0', 64)
);
SET ROLE service_role;
select count(*)::text as s14b_actions_before from protocol_operator_actions where job_id = :'s14b_job' \\gset
select status as s14b_conflict_status
  from reactivate_abandoned_job(:'s14b_job', :'s14b_proj', 'qa', 'same key already used by a different action', 's14b:shared-key') \\gset
select count(*)::text as s14b_actions_after from protocol_operator_actions where job_id = :'s14b_job' \\gset

\\echo '##R## s14b_actions_before' :s14b_actions_before
\\echo '##R## s14b_conflict_status' :s14b_conflict_status
\\echo '##R## s14b_actions_after' :s14b_actions_after
ROLLBACK;

-- s14c: a non-abandoned job is refused, and the refusal is itself
-- idempotent (a replay of the exact same denial, no new action row).
BEGIN;
select project_id as s14c_proj, protocol_id as s14c_proto from _m5_runtime_test_helper_make_fixture('s14c') \\gset
select (job).id as s14c_job from enqueue_protocol_execution_job(:'s14c_proto', :'s14c_proj', 3) \\gset
select claim_token as s14c_token from claim_protocol_execution_job('worker-s14c', 300) \\gset
select count(*)::text as s14c_actions_before from protocol_operator_actions where job_id = :'s14c_job' \\gset
select status as s14c_denied_status
  from reactivate_abandoned_job(:'s14c_job', :'s14c_proj', 'qa', 'attempting to reactivate a healthy job', 's14c:decision-1') \\gset
select count(*)::text as s14c_actions_after_denied from protocol_operator_actions where job_id = :'s14c_job' \\gset
select status as s14c_job_status_after_denied from protocol_execution_jobs where id = :'s14c_job' \\gset

select status as s14c_denied_replay_status
  from reactivate_abandoned_job(:'s14c_job', :'s14c_proj', 'qa', 'replaying the same denial', 's14c:decision-1') \\gset
select count(*)::text as s14c_actions_after_replay from protocol_operator_actions where job_id = :'s14c_job' \\gset

\\echo '##R## s14c_actions_before' :s14c_actions_before
\\echo '##R## s14c_denied_status' :s14c_denied_status
\\echo '##R## s14c_actions_after_denied' :s14c_actions_after_denied
\\echo '##R## s14c_job_status_after_denied' :s14c_job_status_after_denied
\\echo '##R## s14c_denied_replay_status' :s14c_denied_replay_status
\\echo '##R## s14c_actions_after_replay' :s14c_actions_after_replay
ROLLBACK;

-- s14d: wrong project scope -> JOB_NOT_FOUND, zero mutation.
BEGIN;
select project_id as s14d_proj, protocol_id as s14d_proto from _m5_runtime_test_helper_make_fixture('s14d') \\gset
select (job).id as s14d_job from enqueue_protocol_execution_job(:'s14d_proto', :'s14d_proj', 3) \\gset
select project_id as s14d_other_proj from _m5_runtime_test_helper_make_fixture('s14d-other') \\gset
select status as s14d_wrong_project_status
  from reactivate_abandoned_job(:'s14d_job', :'s14d_other_proj', 'qa', 'wrong project scope', 's14d:decision-1') \\gset
select count(*)::text as s14d_actions_after from protocol_operator_actions where job_id = :'s14d_job' \\gset

\\echo '##R## s14d_wrong_project_status' :s14d_wrong_project_status
\\echo '##R## s14d_actions_after' :s14d_actions_after
ROLLBACK;

-- s14e: a raw duplicate INSERT bypassing the RPC entirely proves the
-- unique constraint is a real, enforced backstop -- never silently
-- absorbed, never merely assumed. Probe is a parameterized pg_temp
-- function (never a DO block referencing a psql client variable inside
-- its dollar-quoted body), same discipline as s11c.
BEGIN;
select project_id as s14e_proj, protocol_id as s14e_proto from _m5_runtime_test_helper_make_fixture('s14e', 20, 100.00, 1) \\gset
select (job).id as s14e_job from enqueue_protocol_execution_job(:'s14e_proto', :'s14e_proj', 1) \\gset
select claim_token as s14e_token from claim_protocol_execution_job('worker-s14e', 300) \\gset
RESET ROLE;
update protocol_execution_jobs set lease_expires_at = now() - interval '1 minute' where id = :'s14e_job';
SET ROLE service_role;
select status from claim_protocol_execution_job('worker-s14e-sweep', 300);
select status as s14e_reactivate_status
  from reactivate_abandoned_job(:'s14e_job', :'s14e_proj', 'qa', 'first reactivation', 's14e:decision-1') \\gset
select count(*)::text as s14e_actions_before_dupe from protocol_operator_actions where job_id = :'s14e_job' \\gset

RESET ROLE;
create temporary table s14e_probe (result text);
create or replace function pg_temp._m5_0051_s14e_probe_duplicate(p_project_id uuid, p_job_id uuid) returns void language plpgsql as $s14efn$
begin
  begin
    insert into protocol_operator_actions (
      project_id, job_id, actor, reason, action, outcome, denial_code,
      idempotency_key, request_fingerprint
    ) values (
      p_project_id, p_job_id, 'qa', 'a raw duplicate insert bypassing the RPC entirely', 'reactivate_abandoned_job', 'approved', null,
      's14e:decision-1', repeat('1', 64)
    );
    insert into s14e_probe values ('DUPLICATE_INSERT_SUCCEEDED_BUG');
  exception when unique_violation then
    insert into s14e_probe values ('UNIQUE_VIOLATION_CORRECTLY_REJECTED');
  end;
end;
$s14efn$;
select pg_temp._m5_0051_s14e_probe_duplicate(:'s14e_proj', :'s14e_job');
select coalesce((select result from s14e_probe limit 1), 'CONSTRAINT_DID_NOT_FIRE_BUG') as s14e_duplicate_result \\gset
SET ROLE service_role;
select count(*)::text as s14e_actions_after_dupe from protocol_operator_actions where job_id = :'s14e_job' \\gset

\\echo '##R## s14e_reactivate_status' :s14e_reactivate_status
\\echo '##R## s14e_actions_before_dupe' :s14e_actions_before_dupe
\\echo '##R## s14e_duplicate_result' :s14e_duplicate_result
\\echo '##R## s14e_actions_after_dupe' :s14e_actions_after_dupe
ROLLBACK;

-- ============================================================
-- s15 (D-025): planned_baseline_runs = 2, planned_retest_runs = 1 --
-- the exact smoke4 shape. A wrong-ordinal key is refused before any
-- real admission (test 8). Slot 1 admits, runs to completion, and
-- complete_protocol_execution_job reports NEXT_BASELINE_REQUIRED --
-- never SUCCEEDED -- clearing current_attempt_id and advancing
-- next_baseline_ordinal to 2 while the job stays running with its same
-- claim/lease (test 2). A replay of that same completion call, before
-- the next admission, is idempotent (zero further mutation). A lease
-- loss and reclaim between the advancement and the next admission
-- resumes cleanly, never creating a duplicate root (test 3). Slot 2
-- admits exactly once, runs to completion, and only then does the job
-- reach SUCCEEDED (test 2/9). planned_retest_runs = 1 is never touched
-- by any of this -- M5 has no automatic retest path; a second enqueue
-- for the same protocol still always returns ALREADY_EXISTS.
-- ============================================================
BEGIN;
select project_id as s15_proj, protocol_id as s15_proto from _m5_runtime_test_helper_make_fixture('s15', 20, 100.00, 5, 3, 2, 1) \\gset
select (job).id as s15_job from enqueue_protocol_execution_job(:'s15_proto', :'s15_proj', 3) \\gset
select claim_token as s15_token_a from claim_protocol_execution_job('worker-s15-a', 300) \\gset

select count(*)::text as s15_attempts_before_badkey from protocol_attempts where protocol_id = :'s15_proto' \\gset
select status as s15_badkey_status, coalesce((attempt).id::text, 'NULL') as s15_badkey_attempt
  from admit_and_reserve_attempt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', 'baseline', (:'s15_job' || ':baseline:2'), 0.01, 0.01) \\gset
select count(*)::text as s15_attempts_after_badkey from protocol_attempts where protocol_id = :'s15_proto' \\gset

select status as s15_admit1_status, (attempt).id as s15_attempt1, (attempt).baseline_ordinal as s15_attempt1_ordinal,
       (perplexity_call).id as s15_pcall1, (analysis_call).id as s15_acall1
  from admit_and_reserve_attempt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', 'baseline', (:'s15_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s15_proj', 's15-slot1') as s15_probe_run1 \\gset
select status from start_attempt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_attempt1', :'s15_probe_run1');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_pcall1', :'s15_probe_run1');
select status from record_provider_call_receipt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_pcall1', :'s15_probe_run1', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_acall1', :'s15_probe_run1');
select status from record_analysis_call_receipt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_acall1', :'s15_probe_run1', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s15_job', :'s15_token_a', :'s15_proj', :'s15_attempt1', 'completed', 'slot 1 of 2 succeeded');

select status as s15_complete1_status, coalesce((job).current_attempt_id::text, 'NULL') as s15_complete1_current_attempt,
       (job).next_baseline_ordinal as s15_complete1_next_ordinal, (job).status as s15_complete1_job_status,
       coalesce((job).claim_token::text, 'NULL') as s15_complete1_claim_token
  from complete_protocol_execution_job(:'s15_job', :'s15_token_a', :'s15_proj') \\gset
select status as s15_complete1_replay_status, (job).next_baseline_ordinal as s15_complete1_replay_next_ordinal
  from complete_protocol_execution_job(:'s15_job', :'s15_token_a', :'s15_proj') \\gset

-- Test 3: crash/reclaim between the advancement and the next admission.
RESET ROLE;
update protocol_execution_jobs set lease_expires_at = now() - interval '1 minute' where id = :'s15_job';
SET ROLE service_role;
select claim_token as s15_token_b from claim_protocol_execution_job('worker-s15-b', 300) \\gset
select count(*)::text as s15_attempts_before_slot2 from protocol_attempts where protocol_id = :'s15_proto' \\gset

select status as s15_admit2_status, (attempt).id as s15_attempt2, (attempt).baseline_ordinal as s15_attempt2_ordinal,
       (perplexity_call).id as s15_pcall2, (analysis_call).id as s15_acall2
  from admit_and_reserve_attempt_for_job(:'s15_job', :'s15_token_b', :'s15_proj', 'baseline', (:'s15_job' || ':baseline:2'), 0.01, 0.01) \\gset
select count(*)::text as s15_attempts_after_slot2 from protocol_attempts where protocol_id = :'s15_proto' \\gset
select _m5_runtime_test_helper_probe_run(:'s15_proj', 's15-slot2') as s15_probe_run2 \\gset
select status from start_attempt_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_attempt2', :'s15_probe_run2');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_pcall2', :'s15_probe_run2');
select status from record_provider_call_receipt_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_pcall2', :'s15_probe_run2', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_acall2', :'s15_probe_run2');
select status from record_analysis_call_receipt_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_acall2', :'s15_probe_run2', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s15_job', :'s15_token_b', :'s15_proj', :'s15_attempt2', 'completed', 'slot 2 of 2 succeeded');

-- Test 10: read while still running/owned, BEFORE the final completion
-- call terminalizes the job (get_protocol_execution_job_context requires
-- claimed/running fencing).
select completed_baseline_slots as s15_context_completed_slots
  from get_protocol_execution_job_context(:'s15_job', :'s15_token_b', :'s15_proj') \\gset

select status as s15_complete2_status, (job).status as s15_complete2_job_status
  from complete_protocol_execution_job(:'s15_job', :'s15_token_b', :'s15_proj') \\gset

select status as s15_enqueue_again_status
  from enqueue_protocol_execution_job(:'s15_proto', :'s15_proj', 3) \\gset

\\echo '##R## s15_badkey_status' :s15_badkey_status
\\echo '##R## s15_badkey_attempt' :s15_badkey_attempt
\\echo '##R## s15_attempts_before_badkey' :s15_attempts_before_badkey
\\echo '##R## s15_attempts_after_badkey' :s15_attempts_after_badkey
\\echo '##R## s15_admit1_status' :s15_admit1_status
\\echo '##R## s15_attempt1_ordinal' :s15_attempt1_ordinal
\\echo '##R## s15_complete1_status' :s15_complete1_status
\\echo '##R## s15_complete1_current_attempt' :s15_complete1_current_attempt
\\echo '##R## s15_complete1_next_ordinal' :s15_complete1_next_ordinal
\\echo '##R## s15_complete1_job_status' :s15_complete1_job_status
\\echo '##R## s15_complete1_claim_token' :s15_complete1_claim_token
\\echo '##R## s15_token_a' :s15_token_a
\\echo '##R## s15_complete1_replay_status' :s15_complete1_replay_status
\\echo '##R## s15_complete1_replay_next_ordinal' :s15_complete1_replay_next_ordinal
\\echo '##R## s15_attempts_before_slot2' :s15_attempts_before_slot2
\\echo '##R## s15_admit2_status' :s15_admit2_status
\\echo '##R## s15_attempt2_ordinal' :s15_attempt2_ordinal
\\echo '##R## s15_attempt1' :s15_attempt1
\\echo '##R## s15_attempt2' :s15_attempt2
\\echo '##R## s15_attempts_after_slot2' :s15_attempts_after_slot2
\\echo '##R## s15_context_completed_slots' :s15_context_completed_slots
\\echo '##R## s15_complete2_status' :s15_complete2_status
\\echo '##R## s15_complete2_job_status' :s15_complete2_job_status
\\echo '##R## s15_enqueue_again_status' :s15_enqueue_again_status
ROLLBACK;

-- ============================================================
-- s16 (D-025 test 5): a failed slot 1 root, recovered by a full retry,
-- still consumes exactly one baseline slot -- never two -- despite
-- three total attempts existing across the job's lifetime for its two
-- planned slots (failed root + retried child for slot 1, plus a third,
-- direct-success root for slot 2). Counters/monitoring must track
-- distinct completed slots, never raw protocol_attempts rows.
-- ============================================================
BEGIN;
select project_id as s16_proj, protocol_id as s16_proto from _m5_runtime_test_helper_make_fixture('s16', 20, 100.00, 5, 3, 2, 0) \\gset
select (job).id as s16_job from enqueue_protocol_execution_job(:'s16_proto', :'s16_proj', 3) \\gset
select claim_token as s16_token from claim_protocol_execution_job('worker-s16', 300) \\gset

select (attempt).id as s16_root1, (perplexity_call).id as s16_root1_pcall, (analysis_call).id as s16_root1_acall
  from admit_and_reserve_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', 'baseline', (:'s16_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s16_proj', 's16-root1') as s16_probe_run_root1 \\gset
select status from start_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1', :'s16_probe_run_root1');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1_pcall', :'s16_probe_run_root1');
select status from record_provider_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1_pcall', :'s16_probe_run_root1', 'provider_error', 500, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1_acall', :'s16_probe_run_root1');
select status from record_analysis_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1_acall', :'s16_probe_run_root1', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1', 'failed', 'slot 1 root failed both legs');

select status as s16_retry_status, (attempt).id as s16_child1, (attempt).baseline_ordinal as s16_child1_ordinal,
       (perplexity_call).id as s16_child1_pcall, (analysis_call).id as s16_child1_acall
  from retry_full_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root1', 0.02, 0.02) \\gset
select _m5_runtime_test_helper_probe_run(:'s16_proj', 's16-child1') as s16_probe_run_child1 \\gset
select status from start_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1', :'s16_probe_run_child1');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1_pcall', :'s16_probe_run_child1');
select status from record_provider_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1_pcall', :'s16_probe_run_child1', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1_acall', :'s16_probe_run_child1');
select status from record_analysis_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1_acall', :'s16_probe_run_child1', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_child1', 'completed', 'slot 1 recovered by its retry');

select status as s16_complete1_status, (job).next_baseline_ordinal as s16_complete1_next_ordinal
  from complete_protocol_execution_job(:'s16_job', :'s16_token', :'s16_proj') \\gset
select completed_baseline_slots as s16_context_after_slot1_slots
  from get_protocol_execution_job_context(:'s16_job', :'s16_token', :'s16_proj') \\gset
select count(*)::text as s16_total_attempts_after_slot1 from protocol_attempts where job_id = :'s16_job' \\gset

select (attempt).id as s16_root2, (attempt).baseline_ordinal as s16_root2_ordinal,
       (perplexity_call).id as s16_root2_pcall, (analysis_call).id as s16_root2_acall
  from admit_and_reserve_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', 'baseline', (:'s16_job' || ':baseline:2'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s16_proj', 's16-root2') as s16_probe_run_root2 \\gset
select status from start_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2', :'s16_probe_run_root2');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2_pcall', :'s16_probe_run_root2');
select status from record_provider_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2_pcall', :'s16_probe_run_root2', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2_acall', :'s16_probe_run_root2');
select status from record_analysis_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2_acall', :'s16_probe_run_root2', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_root2', 'completed', 'slot 2 succeeded directly, no retry needed');

select completed_baseline_slots as s16_context_after_slot2_slots
  from get_protocol_execution_job_context(:'s16_job', :'s16_token', :'s16_proj') \\gset
select status as s16_complete2_status
  from complete_protocol_execution_job(:'s16_job', :'s16_token', :'s16_proj') \\gset
select count(*)::text as s16_total_attempts_final from protocol_attempts where job_id = :'s16_job' \\gset

\\echo '##R## s16_retry_status' :s16_retry_status
\\echo '##R## s16_child1_ordinal' :s16_child1_ordinal
\\echo '##R## s16_complete1_status' :s16_complete1_status
\\echo '##R## s16_complete1_next_ordinal' :s16_complete1_next_ordinal
\\echo '##R## s16_context_after_slot1_slots' :s16_context_after_slot1_slots
\\echo '##R## s16_total_attempts_after_slot1' :s16_total_attempts_after_slot1
\\echo '##R## s16_root2_ordinal' :s16_root2_ordinal
\\echo '##R## s16_context_after_slot2_slots' :s16_context_after_slot2_slots
\\echo '##R## s16_complete2_status' :s16_complete2_status
\\echo '##R## s16_total_attempts_final' :s16_total_attempts_final
ROLLBACK;

-- ============================================================
-- s17 (D-025 test 7): planned_baseline_runs = 0 -- enqueue is refused
-- with NO_BASELINE_RUNS_PLANNED, creating no job row at all.
-- ============================================================
BEGIN;
select project_id as s17_proj, protocol_id as s17_proto from _m5_runtime_test_helper_make_fixture('s17', 20, 100.00, 5, 3, 0, 0) \\gset
select status as s17_enqueue_status, coalesce((job).id::text, 'NULL') as s17_job_id
  from enqueue_protocol_execution_job(:'s17_proto', :'s17_proj', 3) \\gset
select count(*)::text as s17_jobs_created from protocol_execution_jobs where protocol_id = :'s17_proto' \\gset
\\echo '##R## s17_enqueue_status' :s17_enqueue_status
\\echo '##R## s17_job_id' :s17_job_id
\\echo '##R## s17_jobs_created' :s17_jobs_created
ROLLBACK;

-- ============================================================
-- s18 (M4 non-regression, forensic follow-up requested after D-025
-- Stage A.2): admit_and_reserve_attempt(uuid,uuid,text,text,numeric,uuid)
-- -- the real, currently-active M4 raw RPC (six declared parameters,
-- the last with its own default; unchanged text since 0047/0050) -- is
-- called directly. It must still delegate cleanly to the now-8-arg
-- _admit_and_reserve_attempt_core purely via that core's own
-- p_baseline_ordinal default, with zero function-resolution ambiguity:
-- RESERVED, job_id IS NULL, baseline_ordinal IS NULL, zero
-- protocol_execution_jobs row ever created, a replay under the same key
-- resolves to the SAME attempt with zero duplicate, and project/
-- protocol scoping still refuses a real protocol_id under the wrong
-- project.
-- ============================================================
BEGIN;
select project_id as s18_proj, protocol_id as s18_proto from _m5_runtime_test_helper_make_fixture('s18') \\gset
select project_id as s18_other_proj from _m5_runtime_test_helper_make_fixture('s18-other') \\gset

select count(*)::text as s18_jobs_before from protocol_execution_jobs where protocol_id = :'s18_proto' \\gset

select status as s18_admit_status, (attempt).id as s18_attempt,
       coalesce((attempt).job_id::text, 'NULL') as s18_attempt_job_id,
       coalesce((attempt).baseline_ordinal::text, 'NULL') as s18_attempt_ordinal
  from admit_and_reserve_attempt(:'s18_proto', :'s18_proj', 'baseline', 's18:m4-raw-key', 0.01, null) \\gset

select count(*)::text as s18_jobs_after from protocol_execution_jobs where protocol_id = :'s18_proto' \\gset

select status as s18_replay_status, coalesce((attempt).id::text, 'NULL') as s18_replay_attempt
  from admit_and_reserve_attempt(:'s18_proto', :'s18_proj', 'baseline', 's18:m4-raw-key', 0.01, null) \\gset

select count(*)::text as s18_attempts_total from protocol_attempts where protocol_id = :'s18_proto' \\gset

select status as s18_wrong_project_status
  from admit_and_reserve_attempt(:'s18_proto', :'s18_other_proj', 'baseline', 's18:wrong-project-key', 0.01, null) \\gset

\\echo '##R## s18_jobs_before' :s18_jobs_before
\\echo '##R## s18_admit_status' :s18_admit_status
\\echo '##R## s18_attempt_job_id' :s18_attempt_job_id
\\echo '##R## s18_attempt_ordinal' :s18_attempt_ordinal
\\echo '##R## s18_jobs_after' :s18_jobs_after
\\echo '##R## s18_replay_status' :s18_replay_status
\\echo '##R## s18_attempt' :s18_attempt
\\echo '##R## s18_replay_attempt' :s18_replay_attempt
\\echo '##R## s18_attempts_total' :s18_attempts_total
\\echo '##R## s18_wrong_project_status' :s18_wrong_project_status
ROLLBACK;
`;

  writeFileSync(path.join(scratchDir, "02-business.sql"), BUSINESS_SQL);
  const businessOutput = runPsql(path.join(scratchDir, "02-business.sql"), "continue");
  writeFileSync(path.join(scratchDir, "02-business.out.log"), businessOutput);
  const r = (label: string) => parseMarkers(businessOutput).get(label) ?? "<MISSING>";

  check("s1: initial admission creates exactly one attempt (RESERVED, 0 -> 1)", r("s1_admit_status") === "RESERVED" && r("s1_attempts_before") === "0" && r("s1_attempts_after") === "1");
  check("s1: a second call with a DIFFERENT idempotency key, once current_attempt_id is set, creates nothing and returns RESUME_CURRENT_ATTEMPT with the same attempt id", r("s1_resume_status") === "RESUME_CURRENT_ATTEMPT" && r("s1_resume_attempt_id") === r("s1_attempt_id") && r("s1_attempts_after_resume") === "1");
  check("s2: a reclaim (new claim_token after lease expiry) still resumes the same attempt, creates nothing", r("s2_admit_status") === "RESERVED" && r("s2_reclaim_status") === "RESUME_CURRENT_ATTEMPT" && r("s2_reclaim_attempt_id") === r("s2_attempt_id") && r("s2_attempts_before_reclaim") === "1" && r("s2_attempts_after_reclaim") === "1");
  check("s3 (defensive): a manufactured current_attempt_id pointing nowhere returns CURRENT_ATTEMPT_NOT_FOUND, never a crash or a silent success", r("s3_defensive_status") === "CURRENT_ATTEMPT_NOT_FOUND");
  check("s4: probe_run creation + attempt start are atomic (STARTED), exactly one probe_runs row created", r("s4_start_status") === "STARTED" && r("s4_runs_before") === "0" && r("s4_runs_after") === "1");
  check("s4: replay after success returns ALREADY_STARTED with the SAME probe_run, creating zero new rows", r("s4_replay_status") === "ALREADY_STARTED" && r("s4_replay_probe_run") === r("s4_probe_run") && r("s4_runs_after_replay") === "1");
  check("s4: wrong claim_token -> JOB_NOT_OWNED, zero mutation (run count unchanged)", r("s4_wrong_token_status") === "JOB_NOT_OWNED" && r("s4_runs_after_wrong_token") === "1");
  check("s7: get_protocol_execution_job_context really executes -- the array_agg(composite) construction works, returning the correct job/attempt/2 external calls/1 provider receipt/1 analysis receipt/probe_run", r("s7_context_status") === "OK" && r("s7_ctx_job") !== "<MISSING>" && r("s7_ctx_attempt") !== "<MISSING>" && r("s7_ctx_calls_len") === "2" && r("s7_ctx_provider_receipts_len") === "1" && r("s7_ctx_analysis_receipts_len") === "1" && r("s7_ctx_probe_run") !== "");
  check("s8: a job with a provider_outcome_unknown receipt genuinely reaches needs_review", r("s8_job_status") === "needs_review" && r("s8_reason") === "perplexity_outcome_unknown");
  check("s8: a first authorize_operator_retry call that exceeds the spend cap is DENIED, with exactly one action row recorded", r("s8_denied_status") === "DENIED" && r("s8_denied_outcome") === "denied" && r("s8_actions_before") === "0" && r("s8_actions_after_denied") === "1");
  check("s8: replaying the SAME denied key after loosening the cap returns the EXACT SAME denial -- never re-evaluated -- with no new action row", r("s8_denied_replay_status") === "DENIED" && r("s8_denied_replay_denial_code") === r("s8_denial_code") && r("s8_actions_after_denied_replay") === "1");
  check("s8: a genuinely new key, small enough, is APPROVED with exactly one new action row", r("s8_approved_status") === "APPROVED" && r("s8_actions_after_approved") === "2");
  check("s8: same key + same intent replays the exact same result/attempt id, no new action row", r("s8_same_intent_status") === "APPROVED" && r("s8_same_intent_attempt") === r("s8_new_attempt") && r("s8_actions_after_same_intent") === "2");
  check("s8: same key + DIFFERENT intent (different cost) -> IDEMPOTENCY_KEY_CONFLICT, zero mutation", r("s8_conflict_status") === "IDEMPOTENCY_KEY_CONFLICT" && r("s8_actions_after_conflict") === "2");
  check("s8: the stored request_fingerprint is a real, reproducible SHA-256 hex of the exact canonical JSONB this decision used", r("s8_fingerprint_reproducible") === "t");
  check("s9: a Perplexity-failed, receipted, reconciled-failed attempt gets exactly one automatic full retry", r("s9_retry_status") === "RESERVED" && r("s9_attempts_before") === "1" && r("s9_attempts_after") === "2");
  check("s9: replay -> ALREADY_RETRIED, same new attempt, no third attempt created", r("s9_replay_status") === "ALREADY_RETRIED" && r("s9_replay_attempt") === r("s9_new_attempt") && r("s9_attempts_after_replay") === "2");
  check("s9: a different intent (different costs) on the same already-retried source -> SOURCE_ALREADY_RETRIED, no additional attempt", r("s9_conflict_status") === "SOURCE_ALREADY_RETRIED" && r("s9_attempts_after_conflict") === "2");
  check("s9: a cross-job source attempt is refused, never silently retried under the wrong job's fencing", r("s9_cross_job_status") !== "RESERVED" && r("s9_cross_job_status") !== "ALREADY_RETRIED");
  check("s10: Perplexity completed+receipted, analysis gen1 failed+receipted, attempt still in_progress -> exactly one new analysis generation, ZERO new Perplexity calls", r("s10_retry_status") === "RESERVED" && r("s10_new_generation") === "2" && r("s10_pcalls_before") === "1" && r("s10_pcalls_after") === "1" && r("s10_acalls_before") === "1" && r("s10_acalls_after") === "2");
  check("s10: replay -> ALREADY_RETRIED, same generation/call, no third generation", r("s10_replay_status") === "ALREADY_RETRIED" && r("s10_replay_call") === r("s10_new_call") && r("s10_acalls_after_replay") === "2");
  check("s10: different intent on the same already-retried source -> SOURCE_ALREADY_RETRIED", r("s10_conflict_status") === "SOURCE_ALREADY_RETRIED");
  check("s10: a third call replaying acall1 (which already has a child) with the same reserved cost still resolves to ALREADY_RETRIED, the exact same child, zero new row, zero mutation -- the existing-child check is never bypassed by the authoritative-generation check, per the D-021/D-022 arbitration", r("s10_replay2_status") === "ALREADY_RETRIED" && r("s10_replay2_call") === r("s10_new_call") && r("s10_acalls_after_replay2") === r("s10_acalls_after_replay"));
  check("s10c (defensive, pre-D-021-style historical data): an older analysis generation with NO retry_of_external_call_id link, while a strictly newer generation already exists, is refused SOURCE_NOT_AUTHORITATIVE_GENERATION, with zero mutation and zero new generation", r("s10c_children_of_acall1") === "0" && r("s10c_nonauthoritative_status") === "SOURCE_NOT_AUTHORITATIVE_GENERATION" && r("s10c_acalls_after_call") === r("s10c_acalls_after_insert") && r("s10c_acalls_after_insert") !== r("s10c_acalls_before"));
  check("s10b: retry_cap is still enforced on first creation of a new analysis generation (retry_cap=1 -> gen2 RESERVED, gen3 RETRY_CAP_EXCEEDED, no third row created)", r("s10b_gen2_status") === "RESERVED" && r("s10b_gen3_capped_status") === "RETRY_CAP_EXCEEDED" && r("s10b_acalls_before_cap") === r("s10b_acalls_after_cap"));
  check("s11: request_sent_at with no receipt -> NEEDS_REVIEW with the exact recorded reason", r("s11_ambiguous_status") === "NEEDS_REVIEW" && r("s11_reason") === "ambiguous_external_call_sent_without_receipt");
  check("s11: replay -> ALREADY_NEEDS_REVIEW", r("s11_replay_status") === "ALREADY_NEEDS_REVIEW");
  check("s11: no automatic retry is reachable from needs_review (fencing refuses)", r("s11_no_auto_retry_status") === "JOB_NOT_OWNED");
  check("s11b: a healthy job with no ambiguous call -> NO_AMBIGUOUS_CALL, zero mutation of job status", r("s11b_no_ambiguity_status") === "NO_AMBIGUOUS_CALL" && r("s11b_job_status_after") === r("s11b_job_status_before"));
  check("s11c: the needs_review_reason/status CHECK constraint is genuinely enforced by Postgres, not merely by application discipline", r("s11c_violation_result") === "CHECK_VIOLATION_CORRECTLY_REJECTED");
  check("s12: a fault injected after the probe_runs INSERT but during create_probe_run_and_start_attempt_for_job's SAME call rolls back the ENTIRE RPC atomically -- zero probe_runs rows, attempt still exactly reserved", r("s12_runs_before") === "0" && r("s12_runs_after") === "0" && r("s12_attempt_reserved_before") === "1" && r("s12_attempt_reserved_after") === "1");
  check("s12: the RPC works normally again once the fault is removed", r("s12_normal_status") === "STARTED");
  check("s13: the monitoring view reflects the real fixture (one claimed/running job)", r("s13_jobs_claimed_or_running") === "1");
  check("s13: sent-without-receipt is counted correctly (exactly the one Perplexity call marked sent with no receipt)", r("s13_sent_without_receipt") === "1");
  check("s13: anon is genuinely denied a real SELECT against the monitoring view (not merely absent from ACL metadata)", r("s13_anon_result") === "ANON_CORRECTLY_DENIED");

  // D-024: reactivate_abandoned_job is fingerprinted and replay-safe.
  check(
    "s14: the fixture job genuinely reaches abandoned_exhausted via the real claim sweep before reactivation is attempted",
    r("s14_status_before_reactivate") === "abandoned_exhausted" && r("s14_actions_before") === "0"
  );
  check(
    "s14: first reactivation of a genuinely abandoned job -> REACTIVATED, attempt_count reset to 0, exactly one operator action logged",
    r("s14_reactivate_status") === "REACTIVATED" &&
      r("s14_attempt_count_after") === "0" &&
      r("s14_actions_after_reactivate") === "1"
  );
  check(
    "s14: replay of the same key + same fingerprint -> the exact same REACTIVATED decision, even after the job's own status has since changed again, and still exactly one operator action (no new row)",
    r("s14_replay_status") === "REACTIVATED" && r("s14_actions_after_replay") === "1"
  );
  check(
    "s14b: the same idempotency key already used by a different operator action type on the SAME job -> IDEMPOTENCY_KEY_CONFLICT, zero new action row",
    r("s14b_actions_before") === "1" &&
      r("s14b_conflict_status") === "IDEMPOTENCY_KEY_CONFLICT" &&
      r("s14b_actions_after") === "1"
  );
  check(
    "s14c: a non-abandoned job is refused -> JOB_NOT_ABANDONED, and that refusal is itself journaled as exactly one denied operator action",
    r("s14c_actions_before") === "0" &&
      r("s14c_denied_status") === "JOB_NOT_ABANDONED" &&
      r("s14c_actions_after_denied") === "1" &&
      r("s14c_job_status_after_denied") === "claimed"
  );
  check(
    "s14c: replay of the same denial key -> the exact same JOB_NOT_ABANDONED denial, no new action row",
    r("s14c_denied_replay_status") === "JOB_NOT_ABANDONED" && r("s14c_actions_after_replay") === "1"
  );
  check(
    "s14d: a real job under the wrong project -> JOB_NOT_FOUND, zero mutation, zero action logged",
    r("s14d_wrong_project_status") === "JOB_NOT_FOUND" && r("s14d_actions_after") === "0"
  );
  check(
    "s14e: a raw INSERT duplicating (project_id, job_id, idempotency_key) outside the RPC entirely is genuinely rejected by the real unique constraint, never silently absorbed, and the original action row is left exactly as it was",
    r("s14e_reactivate_status") === "REACTIVATED" &&
      r("s14e_actions_before_dupe") === "1" &&
      r("s14e_duplicate_result") === "UNIQUE_VIOLATION_CORRECTLY_REJECTED" &&
      r("s14e_actions_after_dupe") === "1"
  );

  // ----------------------------------------------------------------
  // D-025 — one execution job advances through every planned baseline
  // slot sequentially (s15/s16/s17).
  // ----------------------------------------------------------------
  check(
    "D-025 test 8: a wrong-ordinal idempotency key (naming slot 2 while next_baseline_ordinal is still 1) is refused with INVALID_IDEMPOTENCY_KEY, zero mutation",
    r("s15_badkey_status") === "INVALID_IDEMPOTENCY_KEY" &&
      r("s15_badkey_attempt") === "NULL" &&
      r("s15_attempts_before_badkey") === r("s15_attempts_after_badkey")
  );
  check(
    "D-025 test 2: slot 1 of 2 admits RESERVED with baseline_ordinal = 1",
    r("s15_admit1_status") === "RESERVED" && r("s15_attempt1_ordinal") === "1"
  );
  check(
    "D-025 test 2: completing slot 1 of 2 returns NEXT_BASELINE_REQUIRED (never SUCCEEDED), clears current_attempt_id, advances next_baseline_ordinal to 2, and leaves the job running with its same claim_token",
    r("s15_complete1_status") === "NEXT_BASELINE_REQUIRED" &&
      r("s15_complete1_current_attempt") === "NULL" &&
      r("s15_complete1_next_ordinal") === "2" &&
      r("s15_complete1_job_status") === "running" &&
      r("s15_complete1_claim_token") === r("s15_token_a")
  );
  check(
    "D-025: a replay of complete_protocol_execution_job after the advancement but before the next admission returns NEXT_BASELINE_REQUIRED idempotently, next_baseline_ordinal unchanged",
    r("s15_complete1_replay_status") === "NEXT_BASELINE_REQUIRED" && r("s15_complete1_replay_next_ordinal") === "2"
  );
  check(
    "D-025 test 3: a lease loss and reclaim between the advancement and the next admission does not itself create any attempt (still zero for the protocol beyond slot 1's own row)",
    r("s15_attempts_before_slot2") === "1"
  );
  check(
    "D-025 test 2/3/9: slot 2 admits exactly once (RESERVED) after the reclaim, with baseline_ordinal = 2, a genuinely different attempt from slot 1, and no second root is created",
    r("s15_admit2_status") === "RESERVED" &&
      r("s15_attempt2_ordinal") === "2" &&
      r("s15_attempt2") !== r("s15_attempt1") &&
      r("s15_attempts_after_slot2") === "2"
  );
  check(
    "D-025 test 10: after both planned baseline slots are completed, get_protocol_execution_job_context reports completed_baseline_slots = 2, read while the job is still running (before the terminal completion call)",
    r("s15_context_completed_slots") === "2"
  );
  check(
    "D-025 test 2/9: completing slot 2 of 2 (the last planned ordinal) returns SUCCEEDED",
    r("s15_complete2_status") === "SUCCEEDED" && r("s15_complete2_job_status") === "succeeded"
  );
  check(
    "D-025 (smoke4 shape): a second enqueue for the same protocol (planned_retest_runs = 1, never auto-run by M5) still always returns ALREADY_EXISTS -- no recycling, no second job",
    r("s15_enqueue_again_status") === "ALREADY_EXISTS"
  );

  check(
    "D-025 test 5: a full retry of a failed slot 1 root inherits baseline_ordinal 1 from its source, never a new ordinal",
    r("s16_retry_status") === "RESERVED" && r("s16_child1_ordinal") === "1"
  );
  check(
    "D-025 test 5: completing the retried child (slot 1) with 2 planned baseline runs returns NEXT_BASELINE_REQUIRED -- a retry never consumes a new slot",
    r("s16_complete1_status") === "NEXT_BASELINE_REQUIRED" && r("s16_complete1_next_ordinal") === "2"
  );
  check(
    "D-025 test 5/10: after slot 1 (root failed + retried child = 2 rows), completed_baseline_slots is exactly 1 -- distinct ordinals, never raw protocol_attempts rows",
    r("s16_context_after_slot1_slots") === "1" && r("s16_total_attempts_after_slot1") === "2"
  );
  check(
    "D-025 test 5: slot 2's root succeeds directly with baseline_ordinal 2, no retry needed",
    r("s16_root2_ordinal") === "2"
  );
  check(
    "D-025 test 5/10: three total attempts exist for this job (failed root + retried child for slot 1, plus slot 2's direct root) but exactly two baseline slots are completed -- counters track slots, never retry rows",
    r("s16_total_attempts_final") === "3" && r("s16_context_after_slot2_slots") === "2"
  );
  check(
    "D-025 test 5: completing slot 2 (the last of 2 planned ordinals) returns SUCCEEDED",
    r("s16_complete2_status") === "SUCCEEDED"
  );

  check(
    "D-025 test 7: planned_baseline_runs = 0 refuses enqueue with NO_BASELINE_RUNS_PLANNED, creating no job row at all",
    r("s17_enqueue_status") === "NO_BASELINE_RUNS_PLANNED" && r("s17_job_id") === "NULL" && r("s17_jobs_created") === "0"
  );

  // ----------------------------------------------------------------
  // s18 — M4 non-regression (forensic follow-up after D-025 Stage A.2).
  // ----------------------------------------------------------------
  check(
    "s18: the real M4 raw RPC call resolves with zero function ambiguity and returns RESERVED -- delegating to the 8-arg core purely via its own p_baseline_ordinal default",
    r("s18_jobs_before") === "0" && r("s18_admit_status") === "RESERVED"
  );
  check(
    "s18: the M4-admitted attempt carries job_id IS NULL and baseline_ordinal IS NULL, and creates zero protocol_execution_jobs rows -- the M4 raw path remains structurally job-less after D-025",
    r("s18_attempt_job_id") === "NULL" && r("s18_attempt_ordinal") === "NULL" && r("s18_jobs_after") === "0"
  );
  check(
    "s18: a replay under the same idempotency key resolves ALREADY_RESERVED to the SAME attempt, zero duplicate row",
    r("s18_replay_status") === "ALREADY_RESERVED" &&
      r("s18_replay_attempt") === r("s18_attempt") &&
      r("s18_attempts_total") === "1"
  );
  check(
    "s18: the same protocol_id under a different project is NOT_FOUND -- project/protocol scoping intact on the M4 raw path",
    r("s18_wrong_project_status") === "NOT_FOUND"
  );

  // ======================================================================
  // Part C — genuine concurrency: two real, separate psql processes
  // launched together (Promise.all, OS-level parallelism), racing
  // against the SAME committed row. Fixtures here are committed (real
  // COMMIT, not ROLLBACK) since two separate sessions must see them.
  // ======================================================================
  const CONCURRENCY_SETUP_SQL = `
\\pset pager off
SET ROLE service_role;
select project_id as conc1_proj, protocol_id as conc1_proto from _m5_runtime_test_helper_make_fixture('conc1', 20, 100.00, 5) \\gset
select (job).id as conc1_job from enqueue_protocol_execution_job(:'conc1_proto', :'conc1_proj', 3) \\gset
select claim_token as conc1_token from claim_protocol_execution_job('worker-conc1', 300) \\gset
select (attempt).id as conc1_attempt, (perplexity_call).id as conc1_pcall
  from admit_and_reserve_attempt_for_job(:'conc1_job', :'conc1_token', :'conc1_proj', 'baseline', (:'conc1_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'conc1_proj', 'conc1') as conc1_probe_run \\gset
select status from start_attempt_for_job(:'conc1_job', :'conc1_token', :'conc1_proj', :'conc1_attempt', :'conc1_probe_run');
select status from mark_external_call_sent_for_job(:'conc1_job', :'conc1_token', :'conc1_proj', :'conc1_pcall', :'conc1_probe_run');
select status from record_provider_call_receipt_for_job(:'conc1_job', :'conc1_token', :'conc1_proj', :'conc1_pcall', :'conc1_probe_run', 'provider_outcome_unknown');

select project_id as conc2_proj, protocol_id as conc2_proto from _m5_runtime_test_helper_make_fixture('conc2', 20, 100.00, 5) \\gset
select (job).id as conc2_job from enqueue_protocol_execution_job(:'conc2_proto', :'conc2_proj', 3) \\gset
select claim_token as conc2_token from claim_protocol_execution_job('worker-conc2', 300) \\gset
select (attempt).id as conc2_attempt, (perplexity_call).id as conc2_pcall, (analysis_call).id as conc2_acall
  from admit_and_reserve_attempt_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', 'baseline', (:'conc2_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'conc2_proj', 'conc2') as conc2_probe_run \\gset
select status from start_attempt_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_attempt', :'conc2_probe_run');
select status from mark_external_call_sent_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_pcall', :'conc2_probe_run');
select status from record_provider_call_receipt_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_pcall', :'conc2_probe_run', 'provider_error', 500, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_acall', :'conc2_probe_run');
select status from record_analysis_call_receipt_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_acall', :'conc2_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'conc2_job', :'conc2_token', :'conc2_proj', :'conc2_attempt', 'failed', 'both legs failed, for concurrent full-retry race');

-- D-025 race 3 fixture: planned_baseline_runs = 2, slot 1 admitted and
-- run to completion, then complete_protocol_execution_job called once
-- (sequentially, here in setup) so next_baseline_ordinal = 2 and
-- current_attempt_id is null before the two racing processes below both
-- try to admit slot 2 with the identical, correct ordinal-2 key.
select project_id as conc3_proj, protocol_id as conc3_proto from _m5_runtime_test_helper_make_fixture('conc3', 20, 100.00, 5, 3, 2, 0) \\gset
select (job).id as conc3_job from enqueue_protocol_execution_job(:'conc3_proto', :'conc3_proj', 3) \\gset
select claim_token as conc3_token from claim_protocol_execution_job('worker-conc3', 300) \\gset
select (attempt).id as conc3_attempt1, (perplexity_call).id as conc3_pcall1, (analysis_call).id as conc3_acall1
  from admit_and_reserve_attempt_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', 'baseline', (:'conc3_job' || ':baseline:1'), 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'conc3_proj', 'conc3-slot1') as conc3_probe_run1 \\gset
select status from start_attempt_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_attempt1', :'conc3_probe_run1');
select status from mark_external_call_sent_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_pcall1', :'conc3_probe_run1');
select status from record_provider_call_receipt_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_pcall1', :'conc3_probe_run1', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_acall1', :'conc3_probe_run1');
select status from record_analysis_call_receipt_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_acall1', :'conc3_probe_run1', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'conc3_job', :'conc3_token', :'conc3_proj', :'conc3_attempt1', 'completed', 'slot 1 succeeded, advancing to slot 2 before the race');
select status from complete_protocol_execution_job(:'conc3_job', :'conc3_token', :'conc3_proj');

\\echo '##R## conc1_job' :conc1_job
\\echo '##R## conc1_proj' :conc1_proj
\\echo '##R## conc1_attempt' :conc1_attempt
\\echo '##R## conc2_job' :conc2_job
\\echo '##R## conc2_token' :conc2_token
\\echo '##R## conc2_proj' :conc2_proj
\\echo '##R## conc2_attempt' :conc2_attempt
\\echo '##R## conc3_job' :conc3_job
\\echo '##R## conc3_token' :conc3_token
\\echo '##R## conc3_proj' :conc3_proj
`;

  writeFileSync(path.join(scratchDir, "03-concurrency-setup.sql"), CONCURRENCY_SETUP_SQL);
  const setupOutput = runPsql(path.join(scratchDir, "03-concurrency-setup.sql"), "stop");
  const setup = parseMarkers(setupOutput);
  const s = (label: string) => setup.get(label) ?? "<MISSING>";

  const conc1Sql = `SET ROLE service_role; select status, outcome, denial_code, (new_attempt).id from authorize_operator_retry('${s("conc1_job")}', '${s("conc1_proj")}', 'qa', 'racer', 'retry_full_attempt', '${s("conc1_attempt")}', 0.02, 'conc1:race-key', null, 0.02);`;
  const conc2Sql = `SET ROLE service_role; select status, (attempt).id from retry_full_attempt_for_job('${s("conc2_job")}', '${s("conc2_token")}', '${s("conc2_proj")}', '${s("conc2_attempt")}', 0.02, 0.02);`;
  const conc3Sql = `SET ROLE service_role; select status, (attempt).id from admit_and_reserve_attempt_for_job('${s("conc3_job")}', '${s("conc3_token")}', '${s("conc3_proj")}', 'baseline', '${s("conc3_job")}:baseline:2', 0.01, 0.01);`;

  await runConcurrencyRaces();

  async function runConcurrencyRaces(): Promise<void> {
    // Race 1: two concurrent authorize_operator_retry calls, identical
    // key and identical intent, against the SAME needs_review job.
    const [race1a, race1b] = await Promise.all([
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc1Sql]),
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc1Sql]),
    ]);
    const race1aLine = race1a.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const race1bLine = race1b.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    check(
      "concurrency race 1: two truly concurrent authorize_operator_retry calls, same key + same intent, both processes exit cleanly",
      race1a.code === 0 && race1b.code === 0
    );
    check(
      "concurrency race 1: both concurrent callers observe the EXACT SAME result (status|outcome|denial_code|attempt_id) -- one effect, not two",
      race1aLine.length > 0 && race1aLine === race1bLine
    );
    const verifyRace1Sql = `SET ROLE service_role; select count(*) from protocol_operator_actions where job_id = '${s("conc1_job")}' and idempotency_key = 'conc1:race-key'; select count(*) from protocol_attempts where retry_of_attempt_id = '${s("conc1_attempt")}';`;
    const verify1 = run("psql", [dbUrl, "-X", "-q", "-t", "-A", "-c", verifyRace1Sql]).trim().split("\n").filter(Boolean);
    check("concurrency race 1: exactly one protocol_operator_actions row and at most one retry child were created despite the race", verify1[0] === "1" && Number(verify1[1] ?? "0") <= 1);

    // Race 2: two concurrent retry_full_attempt_for_job calls, same
    // source attempt, identical costs.
    const [race2a, race2b] = await Promise.all([
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc2Sql]),
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc2Sql]),
    ]);
    const race2aLine = race2a.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const race2bLine = race2b.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    check(
      "concurrency race 2: two truly concurrent retry_full_attempt_for_job calls, same source, both processes exit cleanly (no uncaught, unabsorbed error escaping either side)",
      race2a.code === 0 && race2b.code === 0
    );
    // Race 2 differs from race 1: retry_full_attempt_for_job locks the
    // job row, so the two callers are strictly serialized -- the winner
    // necessarily observes RESERVED (it creates the child) and the
    // loser, unblocked only after the winner's commit, necessarily
    // observes ALREADY_RETRIED (the existing-child lookup, keyed on
    // retry_of_attempt_id, finds the child the winner just created --
    // this is the D-022 ordering fix under real concurrency, not merely
    // sequential replay). A byte-identical status string for both is
    // neither the guarantee this RPC makes nor achievable under a real
    // row lock; the actual guarantee -- exactly one retry child, and
    // the loser's replay resolving to that SAME child -- is what is
    // checked here.
    const race2aParts = race2aLine.split("|");
    const race2bParts = race2bLine.split("|");
    const race2Statuses = [race2aParts[0], race2bParts[0]].sort();
    check(
      "concurrency race 2: exactly one caller observes RESERVED (creates the child) and the other observes ALREADY_RETRIED (replays it) -- never two RESERVED, never two errors",
      race2aParts.length === 2 &&
        race2bParts.length === 2 &&
        race2Statuses[0] === "ALREADY_RETRIED" &&
        race2Statuses[1] === "RESERVED"
    );
    check(
      "concurrency race 2: both callers' attempt id refers to the SAME single retry child",
      race2aParts[1] !== undefined && race2aParts[1].length > 0 && race2aParts[1] === race2bParts[1]
    );
    const verifyRace2Sql = `SET ROLE service_role; select count(*) from protocol_attempts where retry_of_attempt_id = '${s("conc2_attempt")}';`;
    const verify2 = run("psql", [dbUrl, "-X", "-q", "-t", "-A", "-c", verifyRace2Sql]).trim();
    check("concurrency race 2: exactly one retry child attempt exists despite the race, never two", verify2 === "1");

    // Race 3 (D-025 test 4): two truly concurrent admit_and_reserve_
    // attempt_for_job calls, identical correct ordinal-2 key, against the
    // SAME job -- current_attempt_id is null and next_baseline_ordinal is
    // 2 (slot 1 already completed and advanced in setup, above). The
    // job's own row lock (SELECT ... FOR UPDATE, taken before either
    // caller's current_attempt_id check) is what actually guarantees a
    // single winner here, exactly as it already does for a fresh job's
    // very first admission -- this proves that guarantee still holds for
    // a SECOND slot's admission after D-025, not only the first.
    const [race3a, race3b] = await Promise.all([
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc3Sql]),
      spawnAsync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-F", "|", "-c", conc3Sql]),
    ]);
    const race3aLine = race3a.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const race3bLine = race3b.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    check(
      "concurrency race 3: two truly concurrent admit_and_reserve_attempt_for_job calls for slot 2, same correct key, both processes exit cleanly",
      race3a.code === 0 && race3b.code === 0
    );
    const race3aParts = race3aLine.split("|");
    const race3bParts = race3bLine.split("|");
    const race3Statuses = [race3aParts[0], race3bParts[0]].sort();
    check(
      "concurrency race 3: exactly one caller observes RESERVED (creates slot 2's root attempt) and the other observes RESUME_CURRENT_ATTEMPT (the job row lock already serialized them) -- never two RESERVED",
      race3aParts.length === 2 &&
        race3bParts.length === 2 &&
        race3Statuses[0] === "RESERVED" &&
        race3Statuses[1] === "RESUME_CURRENT_ATTEMPT"
    );
    check(
      "concurrency race 3: both callers' attempt id refers to the SAME single slot-2 root attempt",
      race3aParts[1] !== undefined && race3aParts[1].length > 0 && race3aParts[1] === race3bParts[1]
    );
    const verifyRace3Sql = `SET ROLE service_role; select count(*) from protocol_attempts where job_id = '${s("conc3_job")}' and baseline_ordinal = 2 and retry_of_attempt_id is null;`;
    const verify3 = run("psql", [dbUrl, "-X", "-q", "-t", "-A", "-c", verifyRace3Sql]).trim();
    check("concurrency race 3: exactly one root attempt exists for slot 2 despite the race, never two", verify3 === "1");

    // Clean up the three committed concurrency fixtures explicitly (this
    // part of the test cannot use ROLLBACK, since the whole point was
    // cross-session visibility) -- the disposable database itself is
    // destroyed at the end of this run regardless.
    const cleanupSql = `RESET ROLE; delete from projects where id in ('${s("conc1_proj")}', '${s("conc2_proj")}', '${s("conc3_proj")}');`;
    tryRun("psql", [dbUrl, "-X", "-q", "-c", cleanupSql]);
  }
}

main();
