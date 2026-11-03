#!/usr/bin/env tsx
/**
 * M7 (0070-0074) — real PostgreSQL runtime contract.
 *
 * Why this exists, concretely. The 0073 schema contract passed 67 checks
 * against a migration that created a retest protocol which could never be
 * executed: the run count sat in `planned_retest_runs`, and
 * `enqueue_protocol_execution_job` refuses `planned_baseline_runs = 0`. Text
 * review cannot see that. Neither can it see whether a trigger actually
 * fires, whether an index actually builds, or whether a revoked privilege
 * actually refuses a write. Those are properties of a running PostgreSQL, or
 * they are nothing.
 *
 * The centrepiece is section [6]: the full lifecycle, ending in a real
 * `enqueue_protocol_execution_job` call on the retest protocol. That single
 * assertion is the one that would have caught the 0073 bug.
 *
 * Discipline, inherited from the 0056 harness:
 *   - opt-in only: does nothing without ZYPACT_M7_RUNTIME_TEST=1;
 *   - a disposable stack in a fresh mktemp directory, outside the repository;
 *   - no .env is read, no remote database, no provider, no network beyond the
 *     local Docker socket;
 *   - it never targets a container it did not create, and never prunes;
 *   - cleanup only after complete success; on failure the stack is left up
 *     and its workdir printed for diagnosis;
 *   - a SKIP is never reported as a pass.
 *
 * Ordering is part of the proof: migrations 0001-0069 are applied first and
 * the pre-existing state is photographed, then 0070-0074 are applied. Any
 * difference is attributable to this tranche and nothing else.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowlistDrift, FOUR_DIGIT_ALLOWLIST, migrationVersion } from "./lib/migration-names";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_RUNTIME_TEST";
const BEFORE = 69; // last migration applied in the "before" phase
const MAXV = 74;

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
function selectMigrations(entries: string[], upTo: number, allowlist?: ReadonlySet<string>): string[] {
  const seen = new Map<number, string>();
  for (const e of entries) {
    if (!e.endsWith(".sql")) continue;
    const n = migrationVersion(e, allowlist);
    if (seen.has(n)) throw new Error(`duplicate migration ${n}`);
    seen.set(n, e);
  }
  const files: string[] = [];
  for (let n = 1; n <= upTo; n += 1) {
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
    try { return selectMigrations(entries, MAXV, allow); } catch { return null; }
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
  if (process.env[OPT_IN] !== "1") {
    console.log(
      `SKIP — this harness creates a disposable local Supabase stack and is opt-in.\n` +
      `      Run it with ${OPT_IN}=1 and a working Docker + Supabase CLI.\n` +
      `      Nothing was verified; nothing is claimed.`
    );
    process.exit(0);
  }
  for (const cmd of ["docker", "supabase"]) {
    if (!available(cmd)) {
      console.log(`SKIP — \`${cmd}\` is not available. Nothing was verified.`);
      process.exit(0);
    }
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-"));
  console.log(`Disposable workdir: ${workdir}`);
  let started = false;
  let succeeded = false;

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);
    const cfg = path.join(workdir, "supabase", "config.toml");
    // This harness talks to Postgres only, via `docker exec ... psql` — never
    // PostgREST, Auth, Storage, Realtime, Studio, or an edge function. Every
    // one of those is `enabled = true` by default in a fresh `supabase init`,
    // so leaving them on starts the full stack for a test that needs one
    // container. On a memory-constrained host that starves the BEAM-based
    // Realtime service, which fails with an ERL_CRASH_DUMP rather than a
    // clean error. Disabling the unused services is both a real memory
    // saving and a faithful description of what this test exercises.
    let text = readFileSync(cfg, "utf8");
    for (const [section, key, value] of [
      ["db.seed", "enabled", "false"],
      ["api", "enabled", "false"],
      ["realtime", "enabled", "false"],
      ["studio", "enabled", "false"],
      ["storage", "enabled", "false"],
      ["auth", "enabled", "false"],
      ["edge_runtime", "enabled", "false"],
      ["analytics", "enabled", "false"],
      ["local_smtp", "enabled", "false"],
    ] as const) {
      const edited = setTomlScalar(text, section, key, value);
      if (edited.replacements !== 1) throw new Error(`config replacements for [${section}].${key}=${edited.replacements}`);
      text = edited.text;
    }
    writeFileSync(cfg, text);

    const srcDir = path.join(REPO, "supabase", "migrations");
    const dstDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(dstDir, { recursive: true });
    const all = selectMigrations(readdirSync(srcDir), MAXV);
    const before = all.slice(0, BEFORE);
    const tranche = all.slice(BEFORE);

    check(`the tranche under test is 0070-0074 (${tranche.length} files)`,
      tranche.length === 5 && tranche[0].startsWith("0070_") && tranche[4].startsWith("0074_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0069 only...");
    run("supabase", ["start", "--workdir", workdir]);
    started = true;
    console.log("Stack started.\n");

    const container = run("docker", ["ps", "--format", "{{.Names}}"])
      .split("\n").find((n) => n.startsWith("supabase_db_"));
    if (!container) throw new Error("no supabase_db container");

    // `-t` suppresses headers/footers of the result set, but psql still
    // appends its own command-completion tag ("INSERT 0 1", "UPDATE 1", …)
    // on the next line for INSERT/UPDATE/DELETE — including when RETURNING
    // is used, unlike a plain SELECT. Keep only the scalar's own line.
    const q = (sql: string): string =>
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
        { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n", 1)[0];
    /** Runs sql and returns the error text, or null if it unexpectedly succeeded. */
    const qError = (sql: string): string | null => {
      try { q(sql); return null; }
      catch (e) { return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message); }
    };
    const raises = (sql: string, message: string): boolean => {
      const err = qError(sql);
      return err !== null && err.includes(message);
    };

    /* ═══════════ 0. the pre-tranche state, photographed ═══════════ */
    console.log("[0] Before 0070-0074");
    const oldIndexBefore = q(`select count(*) from pg_class where relname='protocols_one_active_per_version';`);
    check("0047's index is present before the tranche", oldIndexBefore === "1");
    check("interventions does not exist yet",
      q(`select count(*) from information_schema.tables where table_name='interventions';`) === "0");

    /* ═══════════ apply the tranche ═══════════ */
    console.log("\nApplying 0070-0074...");
    // ON_ERROR_STOP=1 makes a failed statement a non-zero exit, so "applied
    // cleanly" is the process's verdict rather than this file's opinion.
    for (const f of tranche) {
      copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
      const sqlPath = `/tmp/${f}`;
      execFileSync("docker", ["cp", path.join(dstDir, f), `${container}:${sqlPath}`], { stdio: "ignore" });
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-f", sqlPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
      check(`${f} applied cleanly`, true);
    }
    console.log("");

    /* ═══════════ 1. 0073's index swap really happened ═══════════ */
    console.log("[1] 0073 — the liveness rule was swapped, not lost");
    check("0047's index is gone",
      q(`select count(*) from pg_class where relname='protocols_one_active_per_version';`) === "0");
    check("the baseline-scoped index exists and is unique",
      q(`select indisunique from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='protocols_one_live_baseline_per_version';`) === "t");
    check("the retest-scoped index exists and is unique",
      q(`select indisunique from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='protocols_one_live_retest_per_baseline';`) === "t");

    /* ═══════════ 2. privileges actually refuse ═══════════ */
    console.log("\n[2] 0071 — privileges refuse a write, they do not merely look revoked");
    check("interventions exists",
      q(`select count(*) from information_schema.tables where table_name='interventions';`) === "1");
    check("service_role holds SELECT and nothing else",
      q(`select coalesce(string_agg(distinct privilege_type,','),'NONE') from information_schema.role_table_grants where table_name='interventions' and grantee='service_role';`) === "SELECT");
    check("row level security is on",
      q(`select relrowsecurity from pg_class where relname='interventions';`) === "t");
    check("anon holds nothing",
      q(`select coalesce(string_agg(distinct privilege_type,','),'NONE') from information_schema.role_table_grants where table_name='interventions' and grantee='anon';`) === "NONE");
    check("service_role is actually refused an INSERT",
      raises(`set role service_role; insert into public.interventions (project_id, protocol_id, buyer_question_version_id, hypothesis, expected_mechanism, action_type, action_target, owner) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'h', 'm', 'other', 't', 'o');`,
        "permission denied"));

    /* ═══════════ 3. fixtures ═══════════ */
    console.log("\n[3] Fixtures");
    const projectId = q(`insert into public.projects (domain) values ('m7.example') returning id;`);
    const actor = q(`select gen_random_uuid();`);
    const questionId = q(`insert into public.buyer_questions (project_id) values ('${projectId}') returning id;`);
    const versionId = q(
      `insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance)
       values ('${questionId}','${projectId}',1,'Which SOC 2 tool?','${"a".repeat(64)}','shortlist',3,3,13,'fixture','customer_supplied') returning id;`
    );
    q(`select public.approve_buyer_question_version('${versionId}','${projectId}','${actor}');`);
    const baselineId = q(
      `insert into public.protocols (project_id, buyer_question_version_id, provider, surface, model_config,
         planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric, sample_planning_method,
         run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, paraphrase_plan)
       values ('${projectId}','${versionId}','perplexity_sonar','answer','{"model":"sonar"}'::jsonb,
         5,0,'buyer_question_version','presence_rate','fixed_operator_default_pending_pilot_calibration',
         7,2,86400,10,1,2,'[{"text":"Which SOC 2 tool?","hash":"${"a".repeat(64)}"}]'::jsonb) returning id;`
    );
    q(`select public.approve_protocol('${baselineId}','${projectId}','${actor}');`);
    check("a baseline protocol exists and is approved",
      q(`select status from public.protocols where id='${baselineId}';`) === "approved");

    /* ═══════════ 4. 0071's registration freeze actually fires ═══════════ */
    console.log("\n[4] 0071 — the immutability trigger fires");
    const ivId = q(
      `select id from public.register_intervention('${projectId}','${baselineId}','hypothesis one','mechanism','content_published','https://x.example/a','owner','["run-1"]'::jsonb);`
    );
    check("register_intervention created a proposed intervention",
      q(`select status from public.interventions where id='${ivId}';`) === "proposed");
    check("an unapproved intervention is still editable",
      qError(`update public.interventions set hypothesis='edited while proposed' where id='${ivId}';`) === null);

    // D-009 needs its own baseline: the partial unique index permits only one
    // live intervention per protocol, so an empty-evidence case cannot share
    // this one. A second question version gives it a protocol of its own.
    {
      const q2 = q(`insert into public.buyer_questions (project_id) values ('${projectId}') returning id;`);
      const v2 = q(
        `insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance)
         values ('${q2}','${projectId}',1,'Second question?','${"b".repeat(64)}','shortlist',3,3,13,'fixture','customer_supplied') returning id;`
      );
      q(`select public.approve_buyer_question_version('${v2}','${projectId}','${actor}');`);
      const p2 = q(
        `insert into public.protocols (project_id, buyer_question_version_id, provider, surface, model_config,
           planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric, sample_planning_method,
           run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap)
         values ('${projectId}','${v2}','perplexity_sonar','answer','{"model":"sonar"}'::jsonb,
           5,0,'buyer_question_version','presence_rate','fixed_operator_default_pending_pilot_calibration',
           7,2,86400,10,1,2) returning id;`
      );
      q(`select public.approve_protocol('${p2}','${projectId}','${actor}');`);
      const bare = q(`select id from public.register_intervention('${projectId}','${p2}','h2','m','other','t','o','[]'::jsonb);`);
      check("an intervention with no supporting evidence can be registered",
        q(`select status from public.interventions where id='${bare}';`) === "proposed");
      check("but D-009 refuses to APPROVE it — evidence-backed means evidence",
        raises(`select public.approve_intervention('${bare}','${projectId}','${actor}');`,
          "intervention_needs_evidence"));
      check("and it stays proposed, which is the honest state",
        q(`select status from public.interventions where id='${bare}';`) === "proposed");
    }

    q(`select public.approve_intervention('${ivId}','${projectId}','${actor}');`);
    check("the intervention is approved",
      q(`select status from public.interventions where id='${ivId}';`) === "approved");
    check("THE REGISTERED CLAIM IS NOW IMMUTABLE — editing the hypothesis raises",
      raises(`update public.interventions set hypothesis='rewritten after the fact' where id='${ivId}';`,
        "intervention_registration_is_immutable"));
    check("the supporting evidence is frozen too",
      raises(`update public.interventions set supporting_evidence='["run-9"]'::jsonb where id='${ivId}';`,
        "intervention_registration_is_immutable"));
    check("the decision threshold is frozen too",
      raises(`update public.interventions set decision_threshold_note='moved goalposts' where id='${ivId}';`,
        "intervention_registration_is_immutable"));
    check("only one live intervention per baseline is permitted",
      raises(`select public.register_intervention('${projectId}','${baselineId}','h3','m','other','t','o','["run-2"]'::jsonb);`,
        "interventions_one_live_per_protocol"));

    /* ═══════════ 5. 0072's window and gate ═══════════ */
    console.log("\n[5] 0072 — the window opens on implementation and cannot be moved");
    check("eligibility refuses an unimplemented intervention",
      q(`select reason from public.retest_eligibility('${ivId}','${projectId}');`) === "INTERVENTION_NOT_IMPLEMENTED");
    check("implementation is refused when no window length was declared",
      raises(`select public.confirm_intervention_implementation('${ivId}','${projectId}','${actor}','{"url":"https://x.example/a"}'::jsonb);`,
        "observation_window_not_declared"));

    q(`update public.interventions set expected_observation_days = 21 where id='${ivId}';`);
    q(`select public.confirm_intervention_implementation('${ivId}','${projectId}','${actor}','{"url":"https://x.example/a"}'::jsonb);`);
    check("the intervention is implemented",
      q(`select status from public.interventions where id='${ivId}';`) === "implemented");
    check("the window opened and closes 21 days later",
      q(`select (observation_window_closes_at - observation_window_opens_at = interval '21 days') from public.interventions where id='${ivId}';`) === "t");
    check("THE WINDOW IS IMMUTABLE — moving its close raises",
      raises(`update public.interventions set observation_window_closes_at = now() where id='${ivId}';`,
        "observation_window_is_immutable"));
    check("shortening expected_observation_days no longer moves eligibility", (() => {
      q(`update public.interventions set expected_observation_days = 1 where id='${ivId}';`);
      return q(`select reason from public.retest_eligibility('${ivId}','${projectId}');`) === "OBSERVATION_WINDOW_OPEN";
    })());
    check("an open window makes the retest ineligible",
      q(`select eligible from public.retest_eligibility('${ivId}','${projectId}');`) === "f");
    check("create_retest_protocol refuses while the window is open",
      q(`select status_code from public.create_retest_protocol('${ivId}','${projectId}','${actor}');`) === "OBSERVATION_WINDOW_OPEN");

    q(`select public.authorize_early_retest('${ivId}','${projectId}','${actor}','pilot deadline; deviation accepted');`);
    check("an authorised deviation makes it eligible",
      q(`select reason from public.retest_eligibility('${ivId}','${projectId}');`) === "AUTHORIZED_DEVIATION");
    check("THE DEVIATION IS PERMANENT — erasing it raises",
      raises(`update public.interventions set early_retest_reason='' where id='${ivId}';`,
        "early_retest_authorization_is_immutable"));

    /* ═══════════ 6. the lifecycle, ending in a real enqueue ═══════════ */
    console.log("\n[6] 0073 — the retest protocol is created AND can actually execute");
    const created = q(`select status_code from public.create_retest_protocol('${ivId}','${projectId}','${actor}');`);
    check("create_retest_protocol reports CREATED", created === "CREATED");
    const retestId = q(`select id from public.protocols where baseline_protocol_id='${baselineId}';`);
    check("the retest is approved", q(`select status from public.protocols where id='${retestId}';`) === "approved");
    check("it reuses the baseline's question version ROW",
      q(`select buyer_question_version_id from public.protocols where id='${retestId}';`) === versionId);
    // Scoped to the retested question, not the project: section 4's D-009
    // fixture deliberately adds a second, unrelated buyer_question (with its
    // own version) to the same project, so a project-wide count is 2 by
    // design and would fail this check regardless of create_retest_protocol's
    // correctness.
    check("no new question version was minted for the retested question",
      q(`select count(*) from public.buyer_question_versions where buyer_question_id='${questionId}';`) === "1");
    check("the run count landed in planned_baseline_runs",
      q(`select planned_baseline_runs from public.protocols where id='${retestId}';`) === "5");
    check("minimum_useful_change was stamped at 0.60",
      q(`select minimum_useful_change->>'value' from public.protocols where id='${retestId}';`) === "0.60");
    check("a repeated call returns the existing retest",
      q(`select status_code from public.create_retest_protocol('${ivId}','${projectId}','${actor}');`) === "RETEST_ALREADY_EXISTS");

    // The assertion that would have caught the 0073 bug.
    check("THE RETEST JOB ACTUALLY ENQUEUES — the retest can be executed",
      q(`select status from public.enqueue_protocol_execution_job('${retestId}','${projectId}');`) === "QUEUED");

    /* ═══════════ 7. 0074's phase trigger ═══════════ */
    console.log("\n[7] 0074 — attempt_kind cannot contradict its protocol");
    check("protocol_execution_phase reports baseline for the baseline",
      q(`select phase from public.protocol_execution_phase('${baselineId}','${projectId}');`) === "baseline");
    check("protocol_execution_phase reports retest for the retest",
      q(`select attempt_kind from public.protocol_execution_phase('${retestId}','${projectId}');`) === "retest");

    const mkAttempt = (protocol: string, kind: string, key: string) =>
      `insert into public.protocol_attempts (project_id, protocol_id, buyer_question_version_id, attempt_kind, status, idempotency_key, reserved_cost_usd)
       values ('${projectId}','${protocol}','${versionId}','${kind}','reserved','${key}',0.02);`;

    check("A MISLABELLED RETEST IS REFUSED — 'baseline' on a retest protocol raises",
      raises(mkAttempt(retestId, "baseline", "k1"), "attempt_kind_must_be_retest_on_a_retest_protocol"));
    check("'retest' on a baseline protocol raises",
      raises(mkAttempt(baselineId, "retest", "k2"), "attempt_kind_retest_requires_a_retest_protocol"));
    check("a correctly labelled retest attempt is accepted",
      qError(mkAttempt(retestId, "retest", "k3")) === null);
    check("a correctly labelled baseline attempt is accepted",
      qError(mkAttempt(baselineId, "baseline", "k4")) === null);
    check("control stays legal on a baseline protocol",
      qError(mkAttempt(baselineId, "control", "k5")) === null);

    /* ═══════════ 8. 0070's job scoping ═══════════ */
    console.log("\n[8] 0070 — a review resolves only its own job's attempts");
    // protocol_execution_jobs.protocol_id is a TOTAL unique constraint (0050:
    // "un job baseline par protocole") — a protocol can never carry two job
    // rows, so "two jobs on the same protocol" cannot be built as two rows in
    // this table. jobOther is the retest's own real job (already created by
    // section 6's enqueue call, on its own protocol). To exercise the actual
    // defect 0070 fixes — the old query scoped by protocol_id, not by job_id
    // — attB below borrows jobOther's real id as a FOREIGN job_id on an
    // attempt whose protocol_id is the baseline's. That is precisely the
    // shape the old code would have wrongly swept in and the new code must
    // not: protocol_attempts.job_id has no compound FK tying it back to the
    // referenced job's own protocol_id, so this is schema-legal without ever
    // creating a second job row for the baseline.
    const datasetBatchId = q(`insert into public.dataset_batches (project_id, dataset_source_type)
       values ('${projectId}','manual_scan') returning id;`);
    const jobBaseline = q(`insert into public.protocol_execution_jobs (project_id, protocol_id, status, max_attempts, needs_review_reason, dataset_batch_id)
       values ('${projectId}','${baselineId}','needs_review',3,'ambiguous','${datasetBatchId}') returning id;`);
    const jobOther = q(`select id from public.protocol_execution_jobs where protocol_id='${retestId}';`);
    // protocol_attempts_job_baseline_ordinal_check (0051) requires
    // baseline_ordinal whenever job_id is set, enforced at INSERT time with
    // no grace for a later UPDATE. The partial unique index on
    // (job_id, baseline_ordinal) is scoped per job_id, so attA and attB both
    // using ordinal 1 under their own, different jobs cannot collide.
    const attA = q(`insert into public.protocol_attempts (project_id, protocol_id, buyer_question_version_id, attempt_kind, status, idempotency_key, reserved_cost_usd, job_id, baseline_ordinal)
       values ('${projectId}','${baselineId}','${versionId}','baseline','in_progress','s1',0.02,'${jobBaseline}',1) returning id;`);
    const attB = q(`insert into public.protocol_attempts (project_id, protocol_id, buyer_question_version_id, attempt_kind, status, idempotency_key, reserved_cost_usd, job_id, baseline_ordinal)
       values ('${projectId}','${baselineId}','${versionId}','baseline','in_progress','s2',0.02,'${jobOther}',1) returning id;`);
    const orphan = q(`insert into public.protocol_attempts (project_id, protocol_id, buyer_question_version_id, attempt_kind, status, idempotency_key, reserved_cost_usd)
       values ('${projectId}','${baselineId}','${versionId}','baseline','reserved','s3',0.02) returning id;`);

    q(`select public.resolve_protocol_job_review('${jobBaseline}','${projectId}','${actor}','excluded_and_completed','reviewed');`);
    check("the resolved job's own attempt is excluded",
      q(`select status from public.protocol_attempts where id='${attA}';`) === "excluded");
    check("THE OTHER JOB'S ATTEMPT IS UNTOUCHED — the retest denominator is safe",
      q(`select status from public.protocol_attempts where id='${attB}';`) === "in_progress");
    check("a job-less attempt on the same protocol is still covered",
      q(`select status from public.protocol_attempts where id='${orphan}';`) === "excluded");
    check("the review reason was preserved, not discarded",
      q(`select prior_needs_review_reason from public.protocol_execution_jobs where id='${jobBaseline}';`) === "ambiguous");

    console.log(`\n${checks - failures}/${checks} checks passed.`);
    if (failures === 0) succeeded = true;
  } finally {
    if (started && succeeded) {
      console.log("\nStopping the disposable stack...");
      try { run("supabase", ["stop", "--workdir", workdir, "--no-backup"]); } catch { /* reported below */ }
      try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
    } else if (started) {
      console.log(`\nLEFT RUNNING for diagnosis. Workdir: ${workdir}`);
      console.log(`Stop it with: supabase stop --workdir ${workdir} --no-backup`);
    }
  }

  console.log(failures === 0
    ? "\nM7 0070-0074 runtime contract PASSED."
    : `\n${failures} check(s) failed. M7 0070-0074 runtime contract FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
