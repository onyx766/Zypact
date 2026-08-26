#!/usr/bin/env tsx
/**
 * M5 — real, reproducible Postgres runtime contract test for the D-020
 * completion gate (migration 0050).
 *
 * This is NOT a static text check (see scripts/test-m5-0050-schema-
 * contract.ts for that). This test creates a genuinely disposable local
 * Supabase/Postgres stack under /tmp, applies 0001-0050 byte-identically,
 * and exercises the completion gate, the current_attempt_id pointer, and
 * the two previously-fixed runtime bugs via real RPC calls over a real
 * psql connection — exactly the class of defect that static text review
 * cannot catch (the "AS core(...)" bug was invisible to grep and only
 * surfaced on real execution).
 *
 * Safety:
 *   - opt-in only: does nothing unless ZYPACT_M5_RUNTIME_TEST=1 is set.
 *   - no remote credential of any kind is read, stored, or required —
 *     the only connection is to a disposable local Postgres instance
 *     this same run creates, using the fixed local demo credentials the
 *     Supabase CLI itself generates for every local project.
 *   - never touches staging or Production; never touches any
 *     pre-existing container (in particular, never stops, restarts,
 *     inspects-for-mutation, or removes a container named
 *     "zypact-postgres" or any container this run did not itself
 *     create); never runs `docker ... prune`.
 *   - the disposable project_id/workdir is unique per run (mktemp);
 *     cleanup is scoped exclusively to that exact workdir/project_id
 *     and only runs after full success. On any failure, the stack is
 *     left running and its exact workdir/project_id is printed so it
 *     can be inspected.
 *   - if Docker, the Supabase CLI, or psql is not available, the test
 *     prints an explicit SKIP and exits 0 — it never prints a passing
 *     result it did not actually verify.
 *
 * Optional environment variables:
 *   ZYPACT_M5_RUNTIME_TEST=1        required opt-in to run anything at all
 *   ZYPACT_DOCKER_BIN_DIR=<path>    prepended to PATH before invoking
 *                                   `docker`/`supabase`, for environments
 *                                   where Docker Desktop's CLI is not
 *                                   already on PATH (matches this repo's
 *                                   own local dev setup)
 */

import { execFileSync } from "node:child_process";
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

function run(cmd: string, args: string[], opts: { input?: string } = {}): string {
  return execFileSync(cmd, args, {
    env: RUN_ENV,
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryRun(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = run(cmd, args);
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? String((err as { stdout?: string }).stdout ?? err.message) : String(err) };
  }
}

// ------------------------------------------------------------------
// Migration selection: this harness applies EXACTLY migrations
// 0001-0050 -- explicitly selected by number, never "every .sql file
// present" (the prior form here, `readdirSync(...).filter((f) =>
// f.endsWith(".sql"))`, would silently pick up 0051 and any later
// migration, including a future 0054, and run its SQL against this
// harness's own disposable stack -- exactly the coupling this fix
// closes, mirroring the `<= 51` / `<= 52` / `<= 53` pattern already
// established by the 0051/0052/0053 runtime harnesses).
// ------------------------------------------------------------------
const MAX_MIGRATION_VERSION = 50;
const NUMBERED_MIGRATION_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

type MigrationSelectionResult = { ok: true; files: string[] } | { ok: false; reason: string };

/**
 * Parses every `.sql` entry against the strict `NNNN_name.sql` shape,
 * selects only those with version <= maxVersion, and fails closed
 * (never a silent partial result) on any invalid numbered name, any
 * duplicate version, or any gap in 1..maxVersion. Sorted numerically
 * (falling back to filename) rather than relying on `readdirSync`'s
 * unspecified ordering.
 */
function selectNumberedMigrations(entries: string[], maxVersion: number): MigrationSelectionResult {
  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));
  const parsed: { file: string; version: number }[] = [];
  for (const f of sqlFiles) {
    const m = NUMBERED_MIGRATION_RE.exec(f);
    if (!m) return { ok: false, reason: `invalid numbered migration name: ${f}` };
    parsed.push({ file: f, version: Number(m[1]) });
  }

  const seen = new Set<number>();
  for (const { version, file } of parsed) {
    if (seen.has(version)) {
      return { ok: false, reason: `duplicate migration version ${String(version).padStart(4, "0")} (${file})` };
    }
    seen.add(version);
  }
  for (let v = 1; v <= maxVersion; v++) {
    if (!seen.has(v)) return { ok: false, reason: `missing migration version ${String(v).padStart(4, "0")}` };
  }

  const files = parsed
    .filter((p) => p.version <= maxVersion)
    .sort((a, b) => a.version - b.version || a.file.localeCompare(b.file))
    .map((p) => p.file);

  return { ok: true, files };
}

/**
 * Static preflight (no Docker, no network, no filesystem writes): proves
 * the selection logic above on the real migrations directory (positive)
 * and on synthetic, in-memory lists (negative) -- never counted among
 * this harness's runtime assertions/counters. Runs unconditionally, even
 * without ZYPACT_M5_RUNTIME_TEST=1 set, since it is pure and harmless;
 * placed before the opt-in gate so its result is visible on every
 * invocation, including a plain SKIP.
 */
function runMigrationSelectionPreflight(): void {
  console.log("\n=== Preflight: migration selection (static, before opt-in gate, no Docker) ===");
  let failed = false;

  // Positive: the real migrations directory selects exactly 0001-0050.
  const realDir = path.join(REPO_ROOT, "supabase", "migrations");
  const realEntries = readdirSync(realDir);
  const realResult = selectNumberedMigrations(realEntries, MAX_MIGRATION_VERSION);
  if (!realResult.ok) {
    failed = true;
    console.log(`  ✗ POSITIVE self-test failed on the real migrations directory: ${realResult.reason}`);
  } else {
    const versions = realResult.files.map((f) => Number(NUMBERED_MIGRATION_RE.exec(f)![1]));
    const isExactRange =
      realResult.files.length === MAX_MIGRATION_VERSION &&
      versions.every((v, i) => v === i + 1);
    if (!isExactRange) {
      failed = true;
      console.log(`  ✗ POSITIVE self-test: selection is not exactly 0001-${String(MAX_MIGRATION_VERSION).padStart(4, "0")} (got ${realResult.files.length} files)`);
    } else {
      console.log(`  ✓ POSITIVE: real directory selects exactly 0001-0050 (${realResult.files.length} files), 0051 and later excluded`);
    }
  }

  const fixtureRange = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, "0")}_fixture.sql`);

  // Negative: a synthetic list containing 0051 and 0054 must exclude both.
  const syntheticWithFuture = [...fixtureRange(50), "0051_fixture.sql", "0054_fixture.sql"];
  const futureResult = selectNumberedMigrations(syntheticWithFuture, MAX_MIGRATION_VERSION);
  if (!futureResult.ok || futureResult.files.some((f) => f.startsWith("0051_") || f.startsWith("0054_"))) {
    failed = true;
    console.log("  ✗ NEGATIVE self-test failed: 0051/0054 were not excluded from a synthetic list");
  } else {
    console.log("  ✓ NEGATIVE: synthetic list containing 0051 and 0054 confirms both excluded from the <=50 selection");
  }

  // Negative: a synthetic list missing 0025 (gap) must be detected.
  const syntheticGap = fixtureRange(50).filter((f) => !f.startsWith("0025_"));
  const gapResult = selectNumberedMigrations(syntheticGap, MAX_MIGRATION_VERSION);
  if (gapResult.ok) {
    failed = true;
    console.log("  ✗ NEGATIVE self-test failed: a missing migration (0025) in 0001-0050 was not detected");
  } else {
    console.log(`  ✓ NEGATIVE: a missing migration (0025) in 0001-0050 is detected — ${gapResult.reason}`);
  }

  // Negative: a synthetic list with a duplicate version must be detected.
  const syntheticDup = [...fixtureRange(50), "0010_duplicate_fixture.sql"];
  const dupResult = selectNumberedMigrations(syntheticDup, MAX_MIGRATION_VERSION);
  if (dupResult.ok) {
    failed = true;
    console.log("  ✗ NEGATIVE self-test failed: a duplicate migration version (0010) was not detected");
  } else {
    console.log(`  ✓ NEGATIVE: a duplicate migration version (0010) is detected — ${dupResult.reason}`);
  }

  // Negative: an invalid numbered name must be detected.
  const syntheticInvalid = [...fixtureRange(50), "051_bad_name.sql"];
  const invalidResult = selectNumberedMigrations(syntheticInvalid, MAX_MIGRATION_VERSION);
  if (invalidResult.ok) {
    failed = true;
    console.log("  ✗ NEGATIVE self-test failed: an invalid numbered migration name (051_bad_name.sql) was not detected");
  } else {
    console.log(`  ✓ NEGATIVE: an invalid numbered migration name is detected — ${invalidResult.reason}`);
  }

  if (failed) {
    console.log("\n✗ FATAL: migration-selection preflight failed. No Docker command will run.");
    process.exit(1);
  }
  console.log("✓ Migration-selection preflight passed: real directory + all self-tests behave exactly as required.\n");
}

function main(): void {
  console.log("=== M5 0050 — real runtime contract test for the D-020 completion gate ===\n");

  runMigrationSelectionPreflight();

  // ------------------------------------------------------------------
  // 0. Opt-in gate — do nothing at all unless explicitly requested.
  // ------------------------------------------------------------------
  if (process.env.ZYPACT_M5_RUNTIME_TEST !== "1") {
    skip(
      "ZYPACT_M5_RUNTIME_TEST is not set to \"1\". Set it explicitly to run this test " +
        "(e.g. ZYPACT_M5_RUNTIME_TEST=1 npx tsx scripts/test-m5-0050-runtime-contract.ts). " +
        "Optionally set ZYPACT_DOCKER_BIN_DIR if Docker's CLI is not already on PATH."
    );
  }

  // ------------------------------------------------------------------
  // 1. Detect Docker / Supabase CLI / psql before any action.
  // ------------------------------------------------------------------
  const dockerVersion = tryRun("docker", ["version"]);
  if (!dockerVersion.ok) {
    skip("Docker is not available (`docker version` failed). No stack created, no database touched.");
  }
  const supabaseVersion = tryRun("supabase", ["--version"]);
  if (!supabaseVersion.ok) {
    skip("The Supabase CLI is not available (`supabase --version` failed). No stack created.");
  }
  const psqlVersion = tryRun("psql", ["--version"]);
  if (!psqlVersion.ok) {
    skip("psql is not available (`psql --version` failed). No stack created.");
  }
  console.log("Docker, Supabase CLI, and psql all detected — proceeding.\n");

  // ------------------------------------------------------------------
  // 2. Record every pre-existing container so this run can prove, at
  //    the end, that it touched none of them.
  // ------------------------------------------------------------------
  const preexistingContainers = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Pre-existing containers recorded (${preexistingContainers.length}): will not be touched.`);

  let zypactPostgresBaseline: string | null = null;
  if (preexistingContainers.includes("zypact-postgres")) {
    zypactPostgresBaseline = run("docker", [
      "inspect",
      "zypact-postgres",
      "--format",
      "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}",
    ]).trim();
    console.log(`zypact-postgres baseline captured: ${zypactPostgresBaseline}`);
  } else {
    console.log("zypact-postgres is not present in this environment — that specific check will be skipped, not faked.");
  }

  // ------------------------------------------------------------------
  // 3. Disposable stack: unique mktemp workdir, unique project_id/ports
  //    (the Supabase CLI derives project_id and default ports from the
  //    workdir name; a fresh mktemp guarantees both are unique).
  // ------------------------------------------------------------------
  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0050-runtime-"));
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
    const migrationSelection = selectNumberedMigrations(readdirSync(sourceMigrationsDir), MAX_MIGRATION_VERSION);
    if (!migrationSelection.ok) {
      throw new Error(`migration selection failed inside main(): ${migrationSelection.reason}`);
    }
    const migrationFiles = migrationSelection.files;
    for (const f of migrationFiles) {
      copyFileSync(path.join(sourceMigrationsDir, f), path.join(destMigrationsDir, f));
    }
    const byteIdentical = migrationFiles.every(
      (f) => readFileSync(path.join(sourceMigrationsDir, f)).equals(readFileSync(path.join(destMigrationsDir, f)))
    );
    check(
      `all ${migrationFiles.length} migrations (0001-0050) copied byte-identically`,
      byteIdentical && migrationFiles.some((f) => f.includes("0050_m5"))
    );

    console.log("\nStarting the disposable Supabase stack (first run may pull Docker images)...");
    run("supabase", ["start", "--workdir", workdir]);
    stackStarted = true;
    console.log("Stack started.\n");

    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

    // ------------------------------------------------------------------
    // 4. Real scenarios, via one psql session per SQL script.
    // ------------------------------------------------------------------
    runScenarios(dbUrl, workdir);

    succeededFully = failures === 0;
  } catch (err) {
    failures += 1;
    console.log(`\n✗ unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ------------------------------------------------------------------
  // 5. Cleanup — targeted, only after full success. On any failure,
  //    the stack is preserved and its exact location is printed.
  // ------------------------------------------------------------------
  if (succeededFully) {
    console.log("\nAll scenarios passed — cleaning up the disposable stack.");
    if (stackStarted) {
      tryRun("supabase", ["stop", "--workdir", workdir, "--no-backup"]);
    }
    if (workdir.startsWith(path.join(tmpdir(), "zypact-m5-0050-runtime-"))) {
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
  // 6. Prove no pre-existing container, especially zypact-postgres, was
  //    ever touched.
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
    const after = run("docker", [
      "inspect",
      "zypact-postgres",
      "--format",
      "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}",
    ]).trim();
    check("zypact-postgres identity (ID/StartedAt/RestartCount/health) unchanged", after === zypactPostgresBaseline);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0050 runtime contract PASSED." : "M5 0050 runtime contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);

  function runScenarios(dbUrl: string, workdirForScript: string): void {
    runScenariosImpl(dbUrl, workdirForScript);
  }
}

// ----------------------------------------------------------------------
// Scenario execution: one big SQL script per logical group, run via a
// single psql session each (so BEGIN/SAVEPOINT semantics are real), with
// `\echo '##R## <label> <value>'` markers this file parses back out.
// ----------------------------------------------------------------------

function runScenariosImpl(dbUrl: string, workdir: string): void {
  const scratchDir = path.join(workdir, "runtime-scripts");
  mkdirSync(scratchDir, { recursive: true });

  const HELPER_SQL = `
create or replace function public._m5_runtime_test_helper_make_fixture(
  p_label text,
  p_run_cap integer default 20,
  p_spend_cap numeric default 5.00,
  p_retry_cap integer default 5,
  p_max_attempts integer default 3
) returns table (project_id uuid, protocol_id uuid) language plpgsql as $f$
declare
  v_project_id uuid;
  v_bq_id uuid;
  v_bqv_id uuid;
  v_protocol_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
begin
  insert into projects (domain, company_name) values ('m5-runtime-' || p_label || '.test', 'M5 Runtime ' || p_label)
    returning id into v_project_id;
  insert into buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label, 'hash-m5-runtime-' || p_label,
    'shortlist', 4, 3, 10, 'm5 runtime contract fixture', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from approve_buyer_question_version(v_bqv_id, v_project_id, v_actor);
  insert into protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    1, 0, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', p_run_cap, p_spend_cap, 3600,
    1000, 50, p_retry_cap
  ) returning id into v_protocol_id;
  perform status from approve_protocol(v_protocol_id, v_project_id, v_actor);
  return query select v_project_id, v_protocol_id;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_make_fixture(text, integer, numeric, integer, integer) to service_role;

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

-- Full-ledger fingerprint: job (status/claim_token/lease_expires_at/
-- current_attempt_id/updated_at) + current attempt (status/actual_cost_usd/
-- terminalized_at/termination_reason) + every external_call of that attempt
-- (status/terminalized_at/actual_cost_usd, in deterministic call_kind,
-- generation order) + receipt counts for the given perplexity/analysis
-- external_call ids. Used to prove "no mutation" before/after a refused
-- complete_protocol_execution_job call by comparing this single string
-- byte-for-byte. p_attempt_id/p_pcall_id/p_acall_id may be null when no
-- attempt exists yet.
create or replace function public._m5_runtime_test_helper_fingerprint(
  p_job_id uuid,
  p_attempt_id uuid default null,
  p_pcall_id uuid default null,
  p_acall_id uuid default null
) returns text language plpgsql as $f$
declare
  v_job_fp text;
  v_attempt_fp text;
  v_calls_fp text;
  v_receipts_fp text;
begin
  select coalesce(status, '') || '|' || coalesce(claim_token::text, '') || '|' ||
         coalesce(lease_expires_at::text, '') || '|' || coalesce(current_attempt_id::text, '') || '|' ||
         coalesce(updated_at::text, '')
    into v_job_fp
    from protocol_execution_jobs where id = p_job_id;

  if p_attempt_id is null then
    v_attempt_fp := '<NONE>';
    v_calls_fp := '<NONE>';
  else
    select coalesce(status, '') || '|' || coalesce(actual_cost_usd::text, '') || '|' ||
           coalesce(terminalized_at::text, '') || '|' || coalesce(termination_reason, '')
      into v_attempt_fp
      from protocol_attempts where id = p_attempt_id;

    select coalesce(string_agg(
             coalesce(status, '') || ':' || coalesce(terminalized_at::text, '') || ':' || coalesce(actual_cost_usd::text, ''),
             ',' order by call_kind, generation
           ), '<NONE>')
      into v_calls_fp
      from protocol_external_calls where protocol_attempt_id = p_attempt_id;
  end if;

  select
    (select count(*) from provider_call_receipts where external_call_id = p_pcall_id)::text || '/' ||
    (select count(*) from analysis_call_receipts where external_call_id = p_acall_id)::text
    into v_receipts_fp;

  return coalesce(v_job_fp, '<NOJOB>') || ' ## ' || v_attempt_fp || ' ## ' || v_calls_fp || ' ## ' || v_receipts_fp;
end;
$f$;
grant execute on function public._m5_runtime_test_helper_fingerprint(uuid, uuid, uuid, uuid) to service_role;

\\echo '##R## helper_installed ok'
`;

  const SCENARIOS_SQL = buildScenariosSql();

  writeFileSync(path.join(scratchDir, "00-helper.sql"), HELPER_SQL);
  writeFileSync(path.join(scratchDir, "01-scenarios.sql"), SCENARIOS_SQL);

  run("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", path.join(scratchDir, "00-helper.sql")]);

  const output = run("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", path.join(scratchDir, "01-scenarios.sql")]);
  writeFileSync(path.join(scratchDir, "01-scenarios.out.log"), output);

  const results = new Map<string, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^##R##\s+(\S+)\s+(.*)$/);
    if (m) results.set(m[1]!, m[2]!.trim());
  }

  function r(label: string): string {
    return results.get(label) ?? "<MISSING>";
  }

  // 1. current_attempt_id NULL before admission.
  check("1. current_attempt_id is NULL before any admission", r("s1_current_attempt_before_admit") === "NULL");

  // 2. admission -> pointer initial correct.
  check(
    "2. admission sets current_attempt_id to the exact new attempt id",
    r("s2_current_attempt_after_admit") === r("s2_attempt_id") && r("s2_admit_status") === "RESERVED"
  );

  // 3. retry_analysis_only -> pointer inchangé.
  check(
    "3. retry_analysis_only leaves current_attempt_id unchanged",
    r("s3_pointer_before") === r("s3_pointer_after") && r("s3_op_status") === "APPROVED"
  );

  // 4. retry_full_attempt -> nouveau pointeur exact, ancien attempt conservé.
  check(
    "4. retry_full_attempt replaces current_attempt_id with the new attempt id and preserves the old attempt row",
    r("s4_pointer_after") === r("s4_new_attempt_id") &&
      r("s4_pointer_after") !== r("s4_old_attempt_id") &&
      r("s4_old_attempt_still_exists") === "1"
  );

  // 5-10: refusals, with exact statuses and full-ledger fingerprints
  // proving zero mutation across the refused complete() call.
  check(
    "5. no receipt at all -> ATTEMPT_NOT_RECONCILED, zero mutation (full job+attempt+calls+receipts fingerprint unchanged)",
    r("s5_complete_status") === "ATTEMPT_NOT_RECONCILED" && r("s5_fp_before") === r("s5_fp_after")
  );
  check(
    "6. provider receipt only -> ATTEMPT_NOT_RECONCILED, zero mutation of the job during complete",
    r("s6_complete_status") === "ATTEMPT_NOT_RECONCILED" && r("s6_fp_before") === r("s6_fp_after")
  );
  check(
    "7. analysis receipt only -> ATTEMPT_NOT_RECONCILED, zero mutation of the job during complete",
    r("s7_complete_status") === "ATTEMPT_NOT_RECONCILED" && r("s7_fp_before") === r("s7_fp_after")
  );
  // Refused is all the plan requires here -- in practice this attempt is
  // also unreconciled (reconcile_attempt_for_job itself refuses while any
  // call is open), so ATTEMPT_NOT_RECONCILED fires first in the approved
  // check order; EXTERNAL_CALLS_NOT_TERMINAL is a defensive check for a
  // state reconcile_attempt_for_job's own precondition already prevents.
  check("8. an active (in_progress) external_call -> completion refused", r("s8_complete_status") !== "SUCCEEDED");
  check("9. an unreconciled attempt -> completion refused", r("s9_complete_status") === "ATTEMPT_NOT_RECONCILED");
  check(
    "10. a reconciled-but-not-completed attempt -> completion refused",
    r("s10_complete_status") === "ATTEMPT_NOT_COMPLETED"
  );

  // 11. old analysis failed + latest completed with receipt -> success.
  check(
    "11. an older failed analysis generation plus a newest completed-with-receipt generation -> SUCCEEDED",
    r("s11_complete_status") === "SUCCEEDED"
  );

  // 12a. old analysis completed + newest still active (reserved) -> refused.
  check(
    "12a. an older completed analysis generation cannot substitute for a still-active (reserved) newest one -> ATTEMPT_NOT_RECONCILED, zero mutation",
    r("s12a_complete_status") === "ATTEMPT_NOT_RECONCILED" && r("s12a_fp_before") === r("s12a_fp_after")
  );

  // 12b. old analysis completed + newest terminal failed, attempt
  // reconciled to 'completed' regardless -> exactly ANALYSIS_NOT_COMPLETED.
  check(
    "12b. an older completed analysis generation cannot substitute for a failed newest one -> exactly ANALYSIS_NOT_COMPLETED, zero mutation",
    r("s12b_complete_status") === "ANALYSIS_NOT_COMPLETED" && r("s12b_fp_before") === r("s12b_fp_after")
  );

  // 13. unknown cost reconciled -> allowed.
  check(
    "13. an honestly reconciled unknown cost (actual_cost_usd NULL) does not block completion",
    r("s13_reconciled_actual_cost") === "NULL" && r("s13_complete_status") === "SUCCEEDED"
  );

  // 14. wrong token -> JOB_NOT_OWNED, full ledger (job+attempt+both
  // external calls+both receipts) fingerprint unchanged.
  check(
    "14. wrong claim_token -> JOB_NOT_OWNED, full ledger fingerprint unchanged",
    r("s14_complete_status") === "JOB_NOT_OWNED" && r("s14_fp_before") === r("s14_fp_after")
  );

  // 15. wrong project -> JOB_NOT_FOUND, full ledger fingerprint unchanged.
  check(
    "15. wrong project_id -> JOB_NOT_FOUND, full ledger fingerprint unchanged",
    r("s15_complete_status") === "JOB_NOT_FOUND" && r("s15_fp_before") === r("s15_fp_after")
  );

  // 16. two valid receipts + current completed/reconciled -> SUCCEEDED,
  // job genuinely succeeded, current_attempt_id unchanged (still the
  // exact attempt id, both before and after), both receipts still
  // exactly one row each (never re-inserted, never removed).
  check(
    "16. two valid receipts, current attempt completed/reconciled -> SUCCEEDED, job genuinely succeeded, current_attempt_id unchanged, both receipts exactly preserved",
    r("s16_complete_status") === "SUCCEEDED" &&
      r("s16_job_status_after") === "succeeded" &&
      r("s16_current_attempt_before") === r("s16_attempt") &&
      r("s16_current_attempt_after") === r("s16_attempt") &&
      r("s16_receipts_before") === "1/1" &&
      r("s16_receipts_after") === "1/1"
  );

  // 17. second complete -> ALREADY_SUCCEEDED, fingerprint unchanged.
  check(
    "17. a second complete call returns ALREADY_SUCCEEDED with an unchanged fingerprint",
    r("s17_second_status") === "ALREADY_SUCCEEDED" && r("s17_fingerprint_before") === r("s17_fingerprint_after")
  );

  // 18. complete after failed/needs_review/abandoned_exhausted -> CONFLICT.
  check("18a. complete after failed -> CONFLICT", r("s18a_status") === "CONFLICT");
  check("18b. complete after needs_review -> CONFLICT", r("s18b_status") === "CONFLICT");
  check(
    "18c. complete after abandoned_exhausted -> CONFLICT",
    r("s18c_job_status") === "abandoned_exhausted" && r("s18c_status") === "CONFLICT"
  );

  // 19. receipt/completion race serialized correctly.
  check(
    "19. a receipt attempted after premature completion is refused (job no longer claimed/running) -- no orphaned partial state",
    r("s19_late_receipt_status") === "JOB_NOT_OWNED"
  );

  // 20. fault injection -> atomic rollback.
  check(
    "20. fault injection after the first internal write rolls back the ENTIRE admission atomically (0 attempts, 0 external_calls, job fingerprint unchanged)",
    r("s20_attempts_before") === r("s20_attempts_after") &&
      r("s20_calls_before") === r("s20_calls_after") &&
      r("s20_job_updated_before") === r("s20_job_updated_after")
  );
  check("20b. the RPC works normally again once the fault injection is removed", r("s20_normal_status") === "RESERVED");

  // 21. the two previously-fixed runtime bugs, reconfirmed for real.
  check(
    "21a. reserve_additional_analysis_generation_for_job no longer raises the Postgres 'column definition list is redundant' error (the AS core(...) fix)",
    r("s21a_gen2_status") === "RESERVED"
  );
  check(
    "21b. a job crashed right after claim (stuck in 'claimed', never admitted) is reclaimed after its lease expires -- the claimed/exhaustion fix",
    r("s21b_reclaim_status") === "CLAIMED" && r("s21b_token_a") !== r("s21b_token_b")
  );
  check(
    "21c. once attempt_count reaches max_attempts, the same crash pattern abandons the job instead of leaving it stuck",
    r("s21c_status") === "abandoned_exhausted"
  );

  // A/B: defensive-guard scenarios. Both fixtures manufacture, directly
  // as postgres, a state no fenced RPC in 0050 can ever produce (a
  // 'completed' external_call with no matching receipt row), to prove
  // the PERPLEXITY_NOT_COMPLETED / ANALYSIS_NOT_COMPLETED guards do not
  // trust the status column alone. Both fixtures run inside their own
  // BEGIN/ROLLBACK -- the inconsistent row is never committed, so it
  // never survives past its own block, even within this disposable
  // database. The outer (pre-BEGIN / post-ROLLBACK) fingerprint proves
  // the real, non-fixture ledger the job started with is byte-identical
  // afterward too.
  check(
    "A. Perplexity completed with no provider_call_receipts row (fixture-only, rolled back) -> exactly PERPLEXITY_NOT_COMPLETED, outer ledger unchanged",
    r("sda_complete_status") === "PERPLEXITY_NOT_COMPLETED" && r("sda_fp_outer_before") === r("sda_fp_outer_after")
  );
  check(
    "B. newest analysis completed with no analysis_call_receipts row (fixture-only, rolled back) -> exactly ANALYSIS_NOT_COMPLETED, outer ledger unchanged",
    r("sdb_complete_status") === "ANALYSIS_NOT_COMPLETED" && r("sdb_fp_outer_before") === r("sdb_fp_outer_after")
  );
}

function buildScenariosSql(): string {
  return `
\\pset pager off
\\set ON_ERROR_STOP off
SET ROLE service_role;

-- ============================================================
-- Scenario 1-2: current_attempt_id NULL before admission, then
-- correct after admission.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s2_proj, protocol_id as s2_proto
  from _m5_runtime_test_helper_make_fixture('s2') \\gset
select (job).id as s2_job from enqueue_protocol_execution_job(:'s2_proto', :'s2_proj', 3) \\gset
select coalesce(current_attempt_id::text, 'NULL') as s1_current_attempt_before_admit from protocol_execution_jobs where id = :'s2_job' \\gset
\\echo '##R## s1_current_attempt_before_admit' :s1_current_attempt_before_admit

select claim_token as s2_token from claim_protocol_execution_job('worker-s2', 300) \\gset
select status as s2_admit_status, (attempt).id as s2_attempt_id
  from admit_and_reserve_attempt_for_job(:'s2_job', :'s2_token', :'s2_proj', 'baseline', 's2-idem-1', 0.01, 0.01) \\gset
select current_attempt_id as s2_current_attempt_after_admit from protocol_execution_jobs where id = :'s2_job' \\gset
\\echo '##R## s2_admit_status' :s2_admit_status
\\echo '##R## s2_attempt_id' :s2_attempt_id
\\echo '##R## s2_current_attempt_after_admit' :s2_current_attempt_after_admit

-- ============================================================
-- Scenario 3: retry_analysis_only leaves the pointer unchanged.
-- Needs a needs_review job (perplexity provider_outcome_unknown).
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s3_proj, protocol_id as s3_proto
  from _m5_runtime_test_helper_make_fixture('s3', 20, 5.00, 5) \\gset
select (job).id as s3_job from enqueue_protocol_execution_job(:'s3_proto', :'s3_proj', 3) \\gset
select claim_token as s3_token from claim_protocol_execution_job('worker-s3', 300) \\gset
select (attempt).id as s3_attempt, (perplexity_call).id as s3_pcall
  from admit_and_reserve_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', 'baseline', 's3-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s3_proj', 's3') as s3_probe_run \\gset
select status from start_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_attempt', :'s3_probe_run');
select status from mark_external_call_sent_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_pcall', :'s3_probe_run');
select status from record_provider_call_receipt_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_pcall', :'s3_probe_run', 'provider_outcome_unknown');
select current_attempt_id as s3_pointer_before from protocol_execution_jobs where id = :'s3_job' \\gset
\\echo '##R## s3_pointer_before' :s3_pointer_before

select status as s3_op_status
  from authorize_operator_retry(:'s3_job', :'s3_proj', 'qa', 'retry analysis only, pointer must stay', 'retry_analysis_only', :'s3_attempt', 0.02) \\gset
select current_attempt_id as s3_pointer_after from protocol_execution_jobs where id = :'s3_job' \\gset
\\echo '##R## s3_op_status' :s3_op_status
\\echo '##R## s3_pointer_after' :s3_pointer_after

-- ============================================================
-- Scenario 4: retry_full_attempt replaces the pointer; the old
-- attempt row is preserved (never deleted).
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s4_proj, protocol_id as s4_proto
  from _m5_runtime_test_helper_make_fixture('s4', 20, 5.00, 5) \\gset
select (job).id as s4_job from enqueue_protocol_execution_job(:'s4_proto', :'s4_proj', 3) \\gset
select claim_token as s4_token from claim_protocol_execution_job('worker-s4', 300) \\gset
select (attempt).id as s4_old_attempt_id, (perplexity_call).id as s4_pcall
  from admit_and_reserve_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', 'baseline', 's4-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s4_proj', 's4') as s4_probe_run \\gset
select status from start_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_old_attempt_id', :'s4_probe_run');
select status from mark_external_call_sent_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_pcall', :'s4_probe_run');
select status from record_provider_call_receipt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_pcall', :'s4_probe_run', 'provider_outcome_unknown');

select status as s4_op_status, (new_attempt).id as s4_new_attempt_id
  from authorize_operator_retry(:'s4_job', :'s4_proj', 'qa', 'retry full attempt, pointer must move', 'retry_full_attempt', :'s4_old_attempt_id', 0.02, 0.03) \\gset
select current_attempt_id as s4_pointer_after from protocol_execution_jobs where id = :'s4_job' \\gset
select count(*)::text as s4_old_attempt_still_exists from protocol_attempts where id = :'s4_old_attempt_id' \\gset
\\echo '##R## s4_pointer_after' :s4_pointer_after
\\echo '##R## s4_new_attempt_id' :s4_new_attempt_id
\\echo '##R## s4_old_attempt_id' :s4_old_attempt_id
\\echo '##R## s4_old_attempt_still_exists' :s4_old_attempt_still_exists

-- ============================================================
-- Scenarios 5-10: completion refusals, one dedicated fixture each,
-- always through the SAME current attempt the job already has.
-- ============================================================

-- 5: no receipt at all.
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s5_proj, protocol_id as s5_proto from _m5_runtime_test_helper_make_fixture('s5') \\gset
select (job).id as s5_job from enqueue_protocol_execution_job(:'s5_proto', :'s5_proj', 3) \\gset
select claim_token as s5_token from claim_protocol_execution_job('worker-s5', 300) \\gset
select (attempt).id as s5_attempt, (perplexity_call).id as s5_pcall, (analysis_call).id as s5_acall
  from admit_and_reserve_attempt_for_job(:'s5_job', :'s5_token', :'s5_proj', 'baseline', 's5-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_fingerprint(:'s5_job', :'s5_attempt', :'s5_pcall', :'s5_acall') as s5_fp_before \\gset
select status as s5_complete_status from complete_protocol_execution_job(:'s5_job', :'s5_token', :'s5_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s5_job', :'s5_attempt', :'s5_pcall', :'s5_acall') as s5_fp_after \\gset
\\echo '##R## s5_complete_status' :s5_complete_status
\\echo '##R## s5_fp_before' :s5_fp_before
\\echo '##R## s5_fp_after' :s5_fp_after

-- 6: provider receipt only (analysis call left reserved).
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s6_proj, protocol_id as s6_proto from _m5_runtime_test_helper_make_fixture('s6') \\gset
select (job).id as s6_job from enqueue_protocol_execution_job(:'s6_proto', :'s6_proj', 3) \\gset
select claim_token as s6_token from claim_protocol_execution_job('worker-s6', 300) \\gset
select (attempt).id as s6_attempt, (perplexity_call).id as s6_pcall, (analysis_call).id as s6_acall
  from admit_and_reserve_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', 'baseline', 's6-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s6_proj', 's6') as s6_probe_run \\gset
select status from start_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_attempt', :'s6_probe_run');
select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall', :'s6_probe_run');
select status from record_provider_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall', :'s6_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'s6_job', :'s6_attempt', :'s6_pcall', :'s6_acall') as s6_fp_before \\gset
select status as s6_complete_status from complete_protocol_execution_job(:'s6_job', :'s6_token', :'s6_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s6_job', :'s6_attempt', :'s6_pcall', :'s6_acall') as s6_fp_after \\gset
\\echo '##R## s6_complete_status' :s6_complete_status
\\echo '##R## s6_fp_before' :s6_fp_before
\\echo '##R## s6_fp_after' :s6_fp_after

-- 7: analysis receipt only (perplexity call left reserved).
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s7_proj, protocol_id as s7_proto from _m5_runtime_test_helper_make_fixture('s7') \\gset
select (job).id as s7_job from enqueue_protocol_execution_job(:'s7_proto', :'s7_proj', 3) \\gset
select claim_token as s7_token from claim_protocol_execution_job('worker-s7', 300) \\gset
select (attempt).id as s7_attempt, (perplexity_call).id as s7_pcall, (analysis_call).id as s7_acall
  from admit_and_reserve_attempt_for_job(:'s7_job', :'s7_token', :'s7_proj', 'baseline', 's7-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s7_proj', 's7') as s7_probe_run \\gset
select status from mark_external_call_sent_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_acall', :'s7_probe_run');
select status from record_analysis_call_receipt_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_acall', :'s7_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'s7_job', :'s7_attempt', :'s7_pcall', :'s7_acall') as s7_fp_before \\gset
select status as s7_complete_status from complete_protocol_execution_job(:'s7_job', :'s7_token', :'s7_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s7_job', :'s7_attempt', :'s7_pcall', :'s7_acall') as s7_fp_after \\gset
\\echo '##R## s7_complete_status' :s7_complete_status
\\echo '##R## s7_fp_before' :s7_fp_before
\\echo '##R## s7_fp_after' :s7_fp_after

-- 8: an active (in_progress) external_call.
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s8_proj, protocol_id as s8_proto from _m5_runtime_test_helper_make_fixture('s8') \\gset
select (job).id as s8_job from enqueue_protocol_execution_job(:'s8_proto', :'s8_proj', 3) \\gset
select claim_token as s8_token from claim_protocol_execution_job('worker-s8', 300) \\gset
select (attempt).id as s8_attempt, (perplexity_call).id as s8_pcall
  from admit_and_reserve_attempt_for_job(:'s8_job', :'s8_token', :'s8_proj', 'baseline', 's8-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s8_proj', 's8') as s8_probe_run \\gset
select status from mark_external_call_sent_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_pcall', :'s8_probe_run');
select status as s8_complete_status from complete_protocol_execution_job(:'s8_job', :'s8_token', :'s8_proj') \\gset
\\echo '##R## s8_complete_status' :s8_complete_status

-- 9: an unreconciled attempt (both calls completed, but reconcile_attempt_for_job never called).
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s9_proj, protocol_id as s9_proto from _m5_runtime_test_helper_make_fixture('s9') \\gset
select (job).id as s9_job from enqueue_protocol_execution_job(:'s9_proto', :'s9_proj', 3) \\gset
select claim_token as s9_token from claim_protocol_execution_job('worker-s9', 300) \\gset
select (attempt).id as s9_attempt, (perplexity_call).id as s9_pcall, (analysis_call).id as s9_acall
  from admit_and_reserve_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', 'baseline', 's9-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s9_proj', 's9') as s9_probe_run \\gset
select status from start_attempt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_attempt', :'s9_probe_run');
select status from mark_external_call_sent_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_pcall', :'s9_probe_run');
select status from record_provider_call_receipt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_pcall', :'s9_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_acall', :'s9_probe_run');
select status from record_analysis_call_receipt_for_job(:'s9_job', :'s9_token', :'s9_proj', :'s9_acall', :'s9_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status as s9_complete_status from complete_protocol_execution_job(:'s9_job', :'s9_token', :'s9_proj') \\gset
\\echo '##R## s9_complete_status' :s9_complete_status

-- 10: reconciled but not completed (reconciled to 'failed').
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s10_proj, protocol_id as s10_proto from _m5_runtime_test_helper_make_fixture('s10') \\gset
select (job).id as s10_job from enqueue_protocol_execution_job(:'s10_proto', :'s10_proj', 3) \\gset
select claim_token as s10_token from claim_protocol_execution_job('worker-s10', 300) \\gset
select (attempt).id as s10_attempt, (perplexity_call).id as s10_pcall, (analysis_call).id as s10_acall
  from admit_and_reserve_attempt_for_job(:'s10_job', :'s10_token', :'s10_proj', 'baseline', 's10-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s10_proj', 's10') as s10_probe_run \\gset
select status from start_attempt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_attempt', :'s10_probe_run');
select status from mark_external_call_sent_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_pcall', :'s10_probe_run');
select status from record_provider_call_receipt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_pcall', :'s10_probe_run', 'provider_error', 500, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall', :'s10_probe_run');
select status from record_analysis_call_receipt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_acall', :'s10_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s10_job', :'s10_token', :'s10_proj', :'s10_attempt', 'failed', 'both calls failed');
select status as s10_complete_status from complete_protocol_execution_job(:'s10_job', :'s10_token', :'s10_proj') \\gset
\\echo '##R## s10_complete_status' :s10_complete_status

-- ============================================================
-- Scenario 11: older analysis generation failed, newest completed
-- with a receipt -> success.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s11_proj, protocol_id as s11_proto from _m5_runtime_test_helper_make_fixture('s11', 20, 5.00, 5) \\gset
select (job).id as s11_job from enqueue_protocol_execution_job(:'s11_proto', :'s11_proj', 3) \\gset
select claim_token as s11_token from claim_protocol_execution_job('worker-s11', 300) \\gset
select (attempt).id as s11_attempt, (perplexity_call).id as s11_pcall, (analysis_call).id as s11_acall1
  from admit_and_reserve_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', 'baseline', 's11-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s11_proj', 's11') as s11_probe_run \\gset
select status from start_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_attempt', :'s11_probe_run');
select status from mark_external_call_sent_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_pcall', :'s11_probe_run');
select status from record_provider_call_receipt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_pcall', :'s11_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_acall1', :'s11_probe_run');
select status from record_analysis_call_receipt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_acall1', :'s11_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select (external_call).id as s11_acall2 from reserve_additional_analysis_generation_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_attempt', 0.01) \\gset
select status from mark_external_call_sent_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_acall2', :'s11_probe_run');
select status from record_analysis_call_receipt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_acall2', :'s11_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s11_job', :'s11_token', :'s11_proj', :'s11_attempt', 'completed', 'gen2 succeeded after gen1 failed');
select status as s11_complete_status from complete_protocol_execution_job(:'s11_job', :'s11_token', :'s11_proj') \\gset
\\echo '##R## s11_complete_status' :s11_complete_status

-- ============================================================
-- Scenario 12a: older analysis generation (gen1) completed with a
-- receipt, newest generation (gen2) reserved -- still active, never
-- terminalized. Per the current gate order the attempt was never
-- reconciled (reconcile_attempt_for_job itself refuses while any
-- external call remains open), so an old success cannot substitute
-- for a still-active newest generation: complete() refuses at
-- ATTEMPT_NOT_RECONCILED, the same guard that fires for scenarios 5-7.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s12a_proj, protocol_id as s12a_proto from _m5_runtime_test_helper_make_fixture('s12a', 20, 5.00, 5) \\gset
select (job).id as s12a_job from enqueue_protocol_execution_job(:'s12a_proto', :'s12a_proj', 3) \\gset
select claim_token as s12a_token from claim_protocol_execution_job('worker-s12a', 300) \\gset
select (attempt).id as s12a_attempt, (perplexity_call).id as s12a_pcall, (analysis_call).id as s12a_acall1
  from admit_and_reserve_attempt_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', 'baseline', 's12a-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s12a_proj', 's12a') as s12a_probe_run \\gset
select status from start_attempt_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_attempt', :'s12a_probe_run');
select status from mark_external_call_sent_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_pcall', :'s12a_probe_run');
select status from record_provider_call_receipt_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_pcall', :'s12a_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_acall1', :'s12a_probe_run');
select status from record_analysis_call_receipt_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_acall1', :'s12a_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select (external_call).id as s12a_acall2 from reserve_additional_analysis_generation_for_job(:'s12a_job', :'s12a_token', :'s12a_proj', :'s12a_attempt', 0.01) \\gset
select _m5_runtime_test_helper_fingerprint(:'s12a_job', :'s12a_attempt', :'s12a_pcall', :'s12a_acall2') as s12a_fp_before \\gset
select status as s12a_complete_status from complete_protocol_execution_job(:'s12a_job', :'s12a_token', :'s12a_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s12a_job', :'s12a_attempt', :'s12a_pcall', :'s12a_acall2') as s12a_fp_after \\gset
\\echo '##R## s12a_complete_status' :s12a_complete_status
\\echo '##R## s12a_fp_before' :s12a_fp_before
\\echo '##R## s12a_fp_after' :s12a_fp_after

-- ============================================================
-- Scenario 12b: older analysis generation (gen1) completed with a
-- receipt, newest generation (gen2) terminal FAILED, attempt
-- reconciled to 'completed' -- an operator/worker decision independent
-- of the per-generation outcome, since reconcile_attempt_for_job only
-- requires every external call to be terminal, never that they all
-- succeeded. This exercises the ANALYSIS_NOT_COMPLETED branch
-- specifically (not ATTEMPT_NOT_COMPLETED, which scenario 10 already
-- covers): an old success cannot substitute for a failed newest one.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s12b_proj, protocol_id as s12b_proto from _m5_runtime_test_helper_make_fixture('s12b', 20, 5.00, 5) \\gset
select (job).id as s12b_job from enqueue_protocol_execution_job(:'s12b_proto', :'s12b_proj', 3) \\gset
select claim_token as s12b_token from claim_protocol_execution_job('worker-s12b', 300) \\gset
select (attempt).id as s12b_attempt, (perplexity_call).id as s12b_pcall, (analysis_call).id as s12b_acall1
  from admit_and_reserve_attempt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', 'baseline', 's12b-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s12b_proj', 's12b') as s12b_probe_run \\gset
select status from start_attempt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_attempt', :'s12b_probe_run');
select status from mark_external_call_sent_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_pcall', :'s12b_probe_run');
select status from record_provider_call_receipt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_pcall', :'s12b_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_acall1', :'s12b_probe_run');
select status from record_analysis_call_receipt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_acall1', :'s12b_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select (external_call).id as s12b_acall2 from reserve_additional_analysis_generation_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_attempt', 0.01) \\gset
select status from mark_external_call_sent_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_acall2', :'s12b_probe_run');
select status from record_analysis_call_receipt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_acall2', :'s12b_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s12b_job', :'s12b_token', :'s12b_proj', :'s12b_attempt', 'completed', 'gen2 failed but attempt reconciled completed -- exercises ANALYSIS_NOT_COMPLETED specifically');
select _m5_runtime_test_helper_fingerprint(:'s12b_job', :'s12b_attempt', :'s12b_pcall', :'s12b_acall2') as s12b_fp_before \\gset
select status as s12b_complete_status from complete_protocol_execution_job(:'s12b_job', :'s12b_token', :'s12b_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s12b_job', :'s12b_attempt', :'s12b_pcall', :'s12b_acall2') as s12b_fp_after \\gset
\\echo '##R## s12b_complete_status' :s12b_complete_status
\\echo '##R## s12b_fp_before' :s12b_fp_before
\\echo '##R## s12b_fp_after' :s12b_fp_after

-- ============================================================
-- Scenario 13: unknown cost honestly reconciled -> allowed.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s13_proj, protocol_id as s13_proto from _m5_runtime_test_helper_make_fixture('s13') \\gset
select (job).id as s13_job from enqueue_protocol_execution_job(:'s13_proto', :'s13_proj', 3) \\gset
select claim_token as s13_token from claim_protocol_execution_job('worker-s13', 300) \\gset
select (attempt).id as s13_attempt, (perplexity_call).id as s13_pcall, (analysis_call).id as s13_acall
  from admit_and_reserve_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', 'baseline', 's13-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s13_proj', 's13') as s13_probe_run \\gset
select status from start_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_attempt', :'s13_probe_run');
select status from mark_external_call_sent_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_pcall', :'s13_probe_run');
-- Perplexity succeeds with a KNOWN cost; analysis succeeds but its cost
-- is UNKNOWN (actual_cost_usd/cost_basis both left NULL) -- honest,
-- structurally-permitted unknown cost.
select status from record_provider_call_receipt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_pcall', :'s13_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_acall', :'s13_probe_run');
select status from record_analysis_call_receipt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_acall', :'s13_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100);
select status from reconcile_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_attempt', 'completed', 'analysis cost unknown, honestly reconciled');
select coalesce(actual_cost_usd::text, 'NULL') as s13_reconciled_actual_cost from protocol_attempts where id = :'s13_attempt' \\gset
select status as s13_complete_status from complete_protocol_execution_job(:'s13_job', :'s13_token', :'s13_proj') \\gset
\\echo '##R## s13_reconciled_actual_cost' :s13_reconciled_actual_cost
\\echo '##R## s13_complete_status' :s13_complete_status

-- ============================================================
-- Scenario 14: wrong token -> JOB_NOT_OWNED. A real current attempt
-- with both receipts already recorded is admitted first, so the
-- fingerprint proves the ENTIRE ledger (job + attempt + both external
-- calls + both receipts), not just an empty job row, is untouched by
-- the refused call.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s14_proj, protocol_id as s14_proto from _m5_runtime_test_helper_make_fixture('s14') \\gset
select (job).id as s14_job from enqueue_protocol_execution_job(:'s14_proto', :'s14_proj', 3) \\gset
select claim_token as s14_token from claim_protocol_execution_job('worker-s14', 300) \\gset
select (attempt).id as s14_attempt, (perplexity_call).id as s14_pcall, (analysis_call).id as s14_acall
  from admit_and_reserve_attempt_for_job(:'s14_job', :'s14_token', :'s14_proj', 'baseline', 's14-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s14_proj', 's14') as s14_probe_run \\gset
select status from start_attempt_for_job(:'s14_job', :'s14_token', :'s14_proj', :'s14_attempt', :'s14_probe_run');
select status from mark_external_call_sent_for_job(:'s14_job', :'s14_token', :'s14_proj', :'s14_pcall', :'s14_probe_run');
select status from record_provider_call_receipt_for_job(:'s14_job', :'s14_token', :'s14_proj', :'s14_pcall', :'s14_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s14_job', :'s14_token', :'s14_proj', :'s14_acall', :'s14_probe_run');
select status from record_analysis_call_receipt_for_job(:'s14_job', :'s14_token', :'s14_proj', :'s14_acall', :'s14_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'s14_job', :'s14_attempt', :'s14_pcall', :'s14_acall') as s14_fp_before \\gset
select status as s14_complete_status from complete_protocol_execution_job(:'s14_job', gen_random_uuid(), :'s14_proj') \\gset
select _m5_runtime_test_helper_fingerprint(:'s14_job', :'s14_attempt', :'s14_pcall', :'s14_acall') as s14_fp_after \\gset
\\echo '##R## s14_complete_status' :s14_complete_status
\\echo '##R## s14_fp_before' :s14_fp_before
\\echo '##R## s14_fp_after' :s14_fp_after

-- ============================================================
-- Scenario 15: wrong project -> JOB_NOT_FOUND. Same full-ledger setup
-- and fingerprint proof as scenario 14.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s15_proj, protocol_id as s15_proto from _m5_runtime_test_helper_make_fixture('s15') \\gset
select (job).id as s15_job from enqueue_protocol_execution_job(:'s15_proto', :'s15_proj', 3) \\gset
select claim_token as s15_token from claim_protocol_execution_job('worker-s15', 300) \\gset
select (attempt).id as s15_attempt, (perplexity_call).id as s15_pcall, (analysis_call).id as s15_acall
  from admit_and_reserve_attempt_for_job(:'s15_job', :'s15_token', :'s15_proj', 'baseline', 's15-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s15_proj', 's15') as s15_probe_run \\gset
select status from start_attempt_for_job(:'s15_job', :'s15_token', :'s15_proj', :'s15_attempt', :'s15_probe_run');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token', :'s15_proj', :'s15_pcall', :'s15_probe_run');
select status from record_provider_call_receipt_for_job(:'s15_job', :'s15_token', :'s15_proj', :'s15_pcall', :'s15_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s15_job', :'s15_token', :'s15_proj', :'s15_acall', :'s15_probe_run');
select status from record_analysis_call_receipt_for_job(:'s15_job', :'s15_token', :'s15_proj', :'s15_acall', :'s15_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'s15_job', :'s15_attempt', :'s15_pcall', :'s15_acall') as s15_fp_before \\gset
select status as s15_complete_status from complete_protocol_execution_job(:'s15_job', :'s15_token', gen_random_uuid()) \\gset
select _m5_runtime_test_helper_fingerprint(:'s15_job', :'s15_attempt', :'s15_pcall', :'s15_acall') as s15_fp_after \\gset
\\echo '##R## s15_complete_status' :s15_complete_status
\\echo '##R## s15_fp_before' :s15_fp_before
\\echo '##R## s15_fp_after' :s15_fp_after

-- ============================================================
-- Scenario 16: two valid receipts, current attempt completed and
-- reconciled -> SUCCEEDED. Also used as the base for 17-19.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s16_proj, protocol_id as s16_proto from _m5_runtime_test_helper_make_fixture('s16') \\gset
select (job).id as s16_job from enqueue_protocol_execution_job(:'s16_proto', :'s16_proj', 3) \\gset
select claim_token as s16_token from claim_protocol_execution_job('worker-s16', 300) \\gset
select (attempt).id as s16_attempt, (perplexity_call).id as s16_pcall, (analysis_call).id as s16_acall
  from admit_and_reserve_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', 'baseline', 's16-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s16_proj', 's16') as s16_probe_run \\gset
select status from start_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_attempt', :'s16_probe_run');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_pcall', :'s16_probe_run');
select status from record_provider_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_pcall', :'s16_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select status from mark_external_call_sent_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_acall', :'s16_probe_run');
select status from record_analysis_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_acall', :'s16_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select status from reconcile_attempt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_attempt', 'completed', 'both calls succeeded');
select coalesce(current_attempt_id::text, 'NULL') as s16_current_attempt_before from protocol_execution_jobs where id = :'s16_job' \\gset
select (
  (select count(*) from provider_call_receipts where external_call_id = :'s16_pcall')::text || '/' ||
  (select count(*) from analysis_call_receipts where external_call_id = :'s16_acall')::text
) as s16_receipts_before \\gset
select status as s16_complete_status from complete_protocol_execution_job(:'s16_job', :'s16_token', :'s16_proj') \\gset
select coalesce(current_attempt_id::text, 'NULL') as s16_current_attempt_after from protocol_execution_jobs where id = :'s16_job' \\gset
select status as s16_job_status_after from protocol_execution_jobs where id = :'s16_job' \\gset
select (
  (select count(*) from provider_call_receipts where external_call_id = :'s16_pcall')::text || '/' ||
  (select count(*) from analysis_call_receipts where external_call_id = :'s16_acall')::text
) as s16_receipts_after \\gset
\\echo '##R## s16_complete_status' :s16_complete_status
\\echo '##R## s16_job_status_after' :s16_job_status_after
\\echo '##R## s16_current_attempt_before' :s16_current_attempt_before
\\echo '##R## s16_current_attempt_after' :s16_current_attempt_after
\\echo '##R## s16_attempt' :s16_attempt
\\echo '##R## s16_receipts_before' :s16_receipts_before
\\echo '##R## s16_receipts_after' :s16_receipts_after

-- Scenario 17: repeat completion -> ALREADY_SUCCEEDED, fingerprint unchanged.
select status, worker_id, claim_token, updated_at from protocol_execution_jobs where id = :'s16_job' \\gset s17_fp_before_
select (:'s17_fp_before_status' || '|' || :'s17_fp_before_worker_id' || '|' || :'s17_fp_before_claim_token' || '|' || :'s17_fp_before_updated_at') as s17_fingerprint_before \\gset
select status as s17_second_status from complete_protocol_execution_job(:'s16_job', :'s16_token', :'s16_proj') \\gset
select status, worker_id, claim_token, updated_at from protocol_execution_jobs where id = :'s16_job' \\gset s17_fp_after_
select (:'s17_fp_after_status' || '|' || :'s17_fp_after_worker_id' || '|' || :'s17_fp_after_claim_token' || '|' || :'s17_fp_after_updated_at') as s17_fingerprint_after \\gset
\\echo '##R## s17_second_status' :s17_second_status
\\echo '##R## s17_fingerprint_before' :s17_fingerprint_before
\\echo '##R## s17_fingerprint_after' :s17_fingerprint_after

-- Scenario 18: complete after failed / needs_review / abandoned_exhausted -> CONFLICT.
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s18a_proj, protocol_id as s18a_proto from _m5_runtime_test_helper_make_fixture('s18a') \\gset
select (job).id as s18a_job from enqueue_protocol_execution_job(:'s18a_proto', :'s18a_proj', 3) \\gset
select claim_token as s18a_token from claim_protocol_execution_job('worker-s18a', 300) \\gset
select status from fail_protocol_execution_job(:'s18a_job', :'s18a_token', :'s18a_proj', 'deliberate test failure');
select status as s18a_status from complete_protocol_execution_job(:'s18a_job', :'s18a_token', :'s18a_proj') \\gset
\\echo '##R## s18a_status' :s18a_status

RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s18b_proj, protocol_id as s18b_proto from _m5_runtime_test_helper_make_fixture('s18b') \\gset
select (job).id as s18b_job from enqueue_protocol_execution_job(:'s18b_proto', :'s18b_proj', 3) \\gset
select claim_token as s18b_token from claim_protocol_execution_job('worker-s18b', 300) \\gset
select (attempt).id as s18b_attempt, (perplexity_call).id as s18b_pcall
  from admit_and_reserve_attempt_for_job(:'s18b_job', :'s18b_token', :'s18b_proj', 'baseline', 's18b-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s18b_proj', 's18b') as s18b_probe_run \\gset
select status from start_attempt_for_job(:'s18b_job', :'s18b_token', :'s18b_proj', :'s18b_attempt', :'s18b_probe_run');
select status from mark_external_call_sent_for_job(:'s18b_job', :'s18b_token', :'s18b_proj', :'s18b_pcall', :'s18b_probe_run');
select status from record_provider_call_receipt_for_job(:'s18b_job', :'s18b_token', :'s18b_proj', :'s18b_pcall', :'s18b_probe_run', 'provider_outcome_unknown');
select status as s18b_status from complete_protocol_execution_job(:'s18b_job', :'s18b_token', :'s18b_proj') \\gset
\\echo '##R## s18b_status' :s18b_status

RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s18c_proj, protocol_id as s18c_proto from _m5_runtime_test_helper_make_fixture('s18c', 20, 5.00, 5, 1) \\gset
select (job).id as s18c_job from enqueue_protocol_execution_job(:'s18c_proto', :'s18c_proj', 1) \\gset
select status from claim_protocol_execution_job('worker-s18c-1', 60);
RESET ROLE;
UPDATE protocol_execution_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = :'s18c_job';
SET ROLE service_role;
select status from claim_protocol_execution_job('worker-s18c-2', 60);
select status as s18c_job_status from protocol_execution_jobs where id = :'s18c_job' \\gset
select status as s18c_status from complete_protocol_execution_job(:'s18c_job', gen_random_uuid(), :'s18c_proj') \\gset
\\echo '##R## s18c_job_status' :s18c_job_status
\\echo '##R## s18c_status' :s18c_status

-- ============================================================
-- Scenario 19: a receipt attempted right after premature (or any)
-- completion must be refused -- the job no longer being
-- claimed/running is the structural guard, proving no receipt can
-- land on a completed job (no orphaned partial write, no reopening).
-- Reuses s16's already-succeeded job and its already-terminal calls.
-- ============================================================
select status as s19_late_receipt_status
  from record_provider_call_receipt_for_job(:'s16_job', :'s16_token', :'s16_proj', :'s16_pcall', :'s16_probe_run', 'success') \\gset
\\echo '##R## s19_late_receipt_status' :s19_late_receipt_status

-- ============================================================
-- Scenario 20: controlled, reversible fault injection -- proves the
-- ENTIRE admission (attempt + both external_calls) rolls back
-- atomically if the second internal write fails. Never touches 0050.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s20_proj, protocol_id as s20_proto from _m5_runtime_test_helper_make_fixture('s20') \\gset
select (job).id as s20_job from enqueue_protocol_execution_job(:'s20_proto', :'s20_proj', 3) \\gset
select claim_token as s20_token from claim_protocol_execution_job('worker-s20', 300) \\gset

RESET ROLE;
create or replace function public._m5_runtime_fault_injection_trigger() returns trigger language plpgsql as $f$
begin
  raise exception using errcode = 'P0001', message = 'm5_runtime_fault_injection: simulated failure on the second internal write';
end;
$f$;
create trigger _m5_runtime_fault_injection_trg
  after insert on protocol_external_calls
  for each row
  when (NEW.call_kind = 'analysis' and NEW.project_id = :'s20_proj'::uuid)
  execute function public._m5_runtime_fault_injection_trigger();
SET ROLE service_role;

select count(*)::text as s20_attempts_before from protocol_attempts where protocol_id = :'s20_proto' \\gset
select count(*)::text as s20_calls_before from protocol_external_calls ec join protocol_attempts a on a.id = ec.protocol_attempt_id where a.protocol_id = :'s20_proto' \\gset
select updated_at::text as s20_job_updated_before from protocol_execution_jobs where id = :'s20_job' \\gset

BEGIN;
SAVEPOINT s20_fault;
select * from admit_and_reserve_attempt_for_job(:'s20_job', :'s20_token', :'s20_proj', 'baseline', 's20-idem-1', 0.01, 0.01);
ROLLBACK TO SAVEPOINT s20_fault;
COMMIT;

select count(*)::text as s20_attempts_after from protocol_attempts where protocol_id = :'s20_proto' \\gset
select count(*)::text as s20_calls_after from protocol_external_calls ec join protocol_attempts a on a.id = ec.protocol_attempt_id where a.protocol_id = :'s20_proto' \\gset
select updated_at::text as s20_job_updated_after from protocol_execution_jobs where id = :'s20_job' \\gset
\\echo '##R## s20_attempts_before' :s20_attempts_before
\\echo '##R## s20_attempts_after' :s20_attempts_after
\\echo '##R## s20_calls_before' :s20_calls_before
\\echo '##R## s20_calls_after' :s20_calls_after
\\echo '##R## s20_job_updated_before' :s20_job_updated_before
\\echo '##R## s20_job_updated_after' :s20_job_updated_after

RESET ROLE;
drop trigger _m5_runtime_fault_injection_trg on protocol_external_calls;
drop function public._m5_runtime_fault_injection_trigger();
SET ROLE service_role;

select status as s20_normal_status from admit_and_reserve_attempt_for_job(:'s20_job', :'s20_token', :'s20_proj', 'baseline', 's20-idem-2', 0.01, 0.01) \\gset
\\echo '##R## s20_normal_status' :s20_normal_status

-- ============================================================
-- Scenario 21: the two previously-fixed runtime bugs, reconfirmed
-- for real against the corrected 0050.
-- ============================================================

-- 21a: reserve_additional_analysis_generation_for_job must not raise
-- the Postgres "column definition list is redundant" error.
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as s21_proj, protocol_id as s21_proto from _m5_runtime_test_helper_make_fixture('s21', 20, 100.00, 5) \\gset
select (job).id as s21_job from enqueue_protocol_execution_job(:'s21_proto', :'s21_proj', 3) \\gset
select claim_token as s21_token from claim_protocol_execution_job('worker-s21', 300) \\gset
select (attempt).id as s21_attempt from admit_and_reserve_attempt_for_job(:'s21_job', :'s21_token', :'s21_proj', 'baseline', 's21-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'s21_proj', 's21') as s21_probe_run \\gset
select status from start_attempt_for_job(:'s21_job', :'s21_token', :'s21_proj', :'s21_attempt', :'s21_probe_run');
select status as s21a_gen2_status from reserve_additional_analysis_generation_for_job(:'s21_job', :'s21_token', :'s21_proj', :'s21_attempt', 0.01) \\gset
\\echo '##R## s21a_gen2_status' :s21a_gen2_status

-- 21b/21c: a job crashed right after claim (stuck 'claimed', never
-- admitted) is reclaimed after lease expiry, and abandoned once
-- attempt_count reaches max_attempts.
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
-- max_attempts=2: the first claim leaves attempt_count=1 (< max), so the
-- next expiry is a genuine RECLAIM, not an immediate exhaustion; the
-- exhaustion path (21c) is reached on the SAME job's second expiry, once
-- attempt_count reaches 2 (== max).
select project_id as s21b_proj, protocol_id as s21b_proto from _m5_runtime_test_helper_make_fixture('s21b', 20, 5.00, 5, 2) \\gset
select (job).id as s21b_job from enqueue_protocol_execution_job(:'s21b_proto', :'s21b_proj', 2) \\gset
select claim_token as s21b_token_a from claim_protocol_execution_job('worker-s21b-a', 60) \\gset
RESET ROLE;
UPDATE protocol_execution_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = :'s21b_job';
SET ROLE service_role;
select status as s21b_reclaim_status, claim_token as s21b_token_b from claim_protocol_execution_job('worker-s21b-b', 60) \\gset
\\echo '##R## s21b_reclaim_status' :s21b_reclaim_status
\\echo '##R## s21b_token_a' :s21b_token_a
\\echo '##R## s21b_token_b' :s21b_token_b

RESET ROLE;
UPDATE protocol_execution_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = :'s21b_job';
SET ROLE service_role;
select status from claim_protocol_execution_job('worker-s21c', 60);
select status as s21c_status from protocol_execution_jobs where id = :'s21b_job' \\gset
\\echo '##R## s21c_status' :s21c_status

-- ============================================================
-- Scenario A (defensive): Perplexity generation 1 is 'completed' with
-- NO provider_call_receipts row. No fenced RPC in 0050 can produce
-- this state -- record_provider_call_receipt_for_job always creates
-- the receipt in the same statement as the status transition -- so it
-- is manufactured directly as postgres (never as service_role, which
-- holds only SELECT on these tables) to exercise the PERPLEXITY_NOT_
-- COMPLETED defensive guard specifically. Wrapped in BEGIN/ROLLBACK:
-- this inconsistent row is never committed and never survives past
-- this block, even within the disposable database.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as sda_proj, protocol_id as sda_proto from _m5_runtime_test_helper_make_fixture('sda') \\gset
select (job).id as sda_job from enqueue_protocol_execution_job(:'sda_proto', :'sda_proj', 3) \\gset
select claim_token as sda_token from claim_protocol_execution_job('worker-sda', 300) \\gset
select (attempt).id as sda_attempt, (perplexity_call).id as sda_pcall, (analysis_call).id as sda_acall
  from admit_and_reserve_attempt_for_job(:'sda_job', :'sda_token', :'sda_proj', 'baseline', 'sda-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'sda_proj', 'sda') as sda_probe_run \\gset
select status from start_attempt_for_job(:'sda_job', :'sda_token', :'sda_proj', :'sda_attempt', :'sda_probe_run');
select status from mark_external_call_sent_for_job(:'sda_job', :'sda_token', :'sda_proj', :'sda_acall', :'sda_probe_run');
select status from record_analysis_call_receipt_for_job(:'sda_job', :'sda_token', :'sda_proj', :'sda_acall', :'sda_probe_run', 'success', 'openai', 'gpt-4o-mini', false, null, null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'sda_job', :'sda_attempt', :'sda_pcall', :'sda_acall') as sda_fp_outer_before \\gset

BEGIN;
RESET ROLE;
update protocol_external_calls
   set status = 'completed', terminalized_at = now(), actual_cost_usd = 0.01, cost_basis = 'measured'
 where id = :'sda_pcall';
SET ROLE service_role;
select status from reconcile_attempt_for_job(:'sda_job', :'sda_token', :'sda_proj', :'sda_attempt', 'completed', 'fixture: perplexity forced completed without a receipt');
select status as sda_complete_status from complete_protocol_execution_job(:'sda_job', :'sda_token', :'sda_proj') \\gset
ROLLBACK;

select _m5_runtime_test_helper_fingerprint(:'sda_job', :'sda_attempt', :'sda_pcall', :'sda_acall') as sda_fp_outer_after \\gset
\\echo '##R## sda_complete_status' :sda_complete_status
\\echo '##R## sda_fp_outer_before' :sda_fp_outer_before
\\echo '##R## sda_fp_outer_after' :sda_fp_outer_after

-- ============================================================
-- Scenario B (defensive): the newest (only) analysis generation is
-- 'completed' with NO analysis_call_receipts row -- the symmetric
-- fixture-only inconsistency for ANALYSIS_NOT_COMPLETED. Same
-- BEGIN/ROLLBACK discipline: never committed, never survives.
-- ============================================================
RESET ROLE;
update protocol_execution_jobs set status='abandoned_exhausted', updated_at=now()
 where status not in ('succeeded','failed','abandoned_exhausted','needs_review');
SET ROLE service_role;
select project_id as sdb_proj, protocol_id as sdb_proto from _m5_runtime_test_helper_make_fixture('sdb') \\gset
select (job).id as sdb_job from enqueue_protocol_execution_job(:'sdb_proto', :'sdb_proj', 3) \\gset
select claim_token as sdb_token from claim_protocol_execution_job('worker-sdb', 300) \\gset
select (attempt).id as sdb_attempt, (perplexity_call).id as sdb_pcall, (analysis_call).id as sdb_acall
  from admit_and_reserve_attempt_for_job(:'sdb_job', :'sdb_token', :'sdb_proj', 'baseline', 'sdb-idem-1', 0.01, 0.01) \\gset
select _m5_runtime_test_helper_probe_run(:'sdb_proj', 'sdb') as sdb_probe_run \\gset
select status from start_attempt_for_job(:'sdb_job', :'sdb_token', :'sdb_proj', :'sdb_attempt', :'sdb_probe_run');
select status from mark_external_call_sent_for_job(:'sdb_job', :'sdb_token', :'sdb_proj', :'sdb_pcall', :'sdb_probe_run');
select status from record_provider_call_receipt_for_job(:'sdb_job', :'sdb_token', :'sdb_proj', :'sdb_pcall', :'sdb_probe_run', 'success', 200, 'r', null, 100, 0.01, 'measured');
select _m5_runtime_test_helper_fingerprint(:'sdb_job', :'sdb_attempt', :'sdb_pcall', :'sdb_acall') as sdb_fp_outer_before \\gset

BEGIN;
RESET ROLE;
update protocol_external_calls
   set status = 'completed', terminalized_at = now(), actual_cost_usd = 0.01, cost_basis = 'measured'
 where id = :'sdb_acall';
SET ROLE service_role;
select status from reconcile_attempt_for_job(:'sdb_job', :'sdb_token', :'sdb_proj', :'sdb_attempt', 'completed', 'fixture: analysis forced completed without a receipt');
select status as sdb_complete_status from complete_protocol_execution_job(:'sdb_job', :'sdb_token', :'sdb_proj') \\gset
ROLLBACK;

select _m5_runtime_test_helper_fingerprint(:'sdb_job', :'sdb_attempt', :'sdb_pcall', :'sdb_acall') as sdb_fp_outer_after \\gset
\\echo '##R## sdb_complete_status' :sdb_complete_status
\\echo '##R## sdb_fp_outer_before' :sdb_fp_outer_before
\\echo '##R## sdb_fp_outer_after' :sdb_fp_outer_after
`;
}

main();
