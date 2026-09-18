#!/usr/bin/env tsx
/**
 * 0077 — real PostgreSQL runtime contract for intervention rejection and
 * abandonment.
 *
 * The centrepiece is section [5]: the abandonment rule is a methodology
 * decision expressed as a constraint, and the only way to know it actually
 * holds is to start a retest, land an attempt, and watch the database refuse.
 * SQL text review cannot establish that — a predicate that reads correctly
 * can still be evaluated against the wrong row, at the wrong time, or under a
 * lock that does not hold.
 *
 * Section [4] proves the cheaper half: while nothing has been observed,
 * abandonment works, takes the live retest protocol down with it, cancels the
 * queued job so the worker stops buying runs, and releases the partial unique
 * indexes so a replacement intervention can be registered.
 *
 * Section [7] proves the cancellation is real rather than cosmetic, by
 * calling the actual claim function and confirming a cancelled job is never
 * handed to a worker.
 *
 * Discipline, inherited from the 0056/0070-0076 harnesses: opt-in via
 * ZYPACT_M7_0077_RUNTIME_TEST=1, disposable mktemp stack, no .env, no remote
 * database, no provider, cleanup only after full success, workdir preserved
 * on failure, a SKIP is never reported as a pass.
 *
 * Migrations 0001-0076 are applied first and the pre-0077 state is
 * photographed, so any difference is attributable to 0077 alone.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0077_RUNTIME_TEST";
const BEFORE = 76;
const MAXV = 77;

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
function selectMigrations(entries: string[], upTo: number): string[] {
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
  for (let n = 1; n <= upTo; n += 1) {
    const f = seen.get(n);
    if (!f) throw new Error(`missing migration ${n}`);
    files.push(f);
  }
  return files;
}

async function main(): Promise<void> {
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

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0077-"));
  console.log(`Disposable workdir: ${workdir}`);
  let started = false;
  let succeeded = false;

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);
    const cfg = path.join(workdir, "supabase", "config.toml");
    // Postgres only, via `docker exec ... psql`. See the 0076 harness for why
    // every other service is disabled rather than merely unused.
    let cfgText = readFileSync(cfg, "utf8");
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
      const edited = setTomlScalar(cfgText, section, key, value);
      if (edited.replacements !== 1) throw new Error(`config replacements for [${section}].${key}=${edited.replacements}`);
      cfgText = edited.text;
    }
    writeFileSync(cfg, cfgText);

    const srcDir = path.join(REPO, "supabase", "migrations");
    const dstDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(dstDir, { recursive: true });
    const all = selectMigrations(readdirSync(srcDir), MAXV);
    const before = all.slice(0, BEFORE);
    const tranche = all.slice(BEFORE);
    check("the tranche under test is exactly 0077 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0077_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0076 only...");
    run("supabase", ["start", "--workdir", workdir]);
    started = true;
    console.log("Stack started.\n");

    const container = run("docker", ["ps", "--format", "{{.Names}}"])
      .split("\n").find((n) => n.startsWith("supabase_db_"));
    if (!container) throw new Error("no supabase_db container");

    // `-t` suppresses headers/footers, but psql still appends its own
    // command-completion tag ("INSERT 0 1", "UPDATE 1", …) on the next line
    // for INSERT/UPDATE/DELETE — including with RETURNING. Keep only the
    // scalar's own line.
    const q = (sql: string): string =>
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
        { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n", 1)[0];
    const qError = (sql: string): string | null => {
      try { q(sql); return null; }
      catch (e) { return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message); }
    };

    /* ═══════════ 0. the pre-0077 photograph ═══════════ */
    console.log("[0] Before 0077 — both states are unreachable");
    check("reject_intervention does not exist yet",
      q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reject_intervention';`) === "0");
    check("abandon_intervention does not exist yet",
      q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='abandon_intervention';`) === "0");
    check("service_role has no UPDATE on interventions, so no other write path exists",
      q(`select count(*) from information_schema.role_table_grants where table_name='interventions' and grantee='service_role' and privilege_type='UPDATE';`) === "0");
    check("a job cannot be 'cancelled' before 0077",
      qError(`insert into public.protocol_execution_jobs (project_id, protocol_id, status, max_attempts)
              values (gen_random_uuid(), gen_random_uuid(), 'cancelled', 3);`) !== null);

    console.log("\nApplying 0077...");
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

    /* ═══════════ 1. ACL ═══════════ */
    console.log("[1] Privileges refuse, they do not merely look revoked");
    for (const fn of ["reject_intervention", "abandon_intervention"]) {
      check(`${fn} is granted to service_role only`,
        q(`select coalesce(string_agg(distinct grantee,','),'NONE') from information_schema.role_routine_grants where routine_name='${fn}';`) === "service_role");
      check(`anon is actually refused ${fn}`,
        qError(`set role anon; select public.${fn}(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x');`) !== null);
    }
    check("service_role still has no UPDATE on interventions after 0077",
      q(`select count(*) from information_schema.role_table_grants where table_name='interventions' and grantee='service_role' and privilege_type='UPDATE';`) === "0",
      "the RPCs remain the only write path");

    /* ═══════════ 2. fixtures ═══════════ */
    console.log("\n[2] Fixtures");
    const projectId = q(`insert into public.projects (domain) values ('m7-0077.example') returning id;`);
    const actor = q(`select gen_random_uuid();`);

    let seq = 0;
    /** A baseline with an approved question, ready for an intervention. */
    function mintBaseline(label: string): string {
      seq += 1;
      const hashChar = seq.toString(16).padStart(1, "0");
      const questionId = q(`insert into public.buyer_questions (project_id) values ('${projectId}') returning id;`);
      const versionId = q(
        `insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance)
         values ('${questionId}','${projectId}',1,'${label}?','${hashChar.repeat(64)}','shortlist',3,3,13,'fixture','customer_supplied') returning id;`
      );
      q(`select public.approve_buyer_question_version('${versionId}','${projectId}','${actor}');`);
      const baselineId = q(
        `insert into public.protocols (project_id, buyer_question_version_id, provider, surface, model_config,
           planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric, sample_planning_method,
           run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap)
         values ('${projectId}','${versionId}','perplexity_sonar','answer','{"model":"sonar"}'::jsonb,
           5,0,'buyer_question_version','presence_rate','fixed_operator_default_pending_pilot_calibration',
           7,2,86400,10,1,2) returning id;`
      );
      q(`select public.approve_protocol('${baselineId}','${projectId}','${actor}');`);
      return baselineId;
    }

    function registerOn(baselineId: string, label: string): string {
      return q(
        `select id from public.register_intervention('${projectId}','${baselineId}','h-${label}','m-${label}','content_published','https://x.example/${label}','owner','["run-${label}"]'::jsonb);`
      );
    }

    /** Carries an intervention all the way to a created retest protocol. */
    function mintRetest(baselineId: string, interventionId: string): string {
      q(`select public.approve_intervention('${interventionId}','${projectId}','${actor}');`);
      q(`update public.interventions set expected_observation_days = 21 where id='${interventionId}';`);
      q(`select public.confirm_intervention_implementation('${interventionId}','${projectId}','${actor}','{"url":"https://x.example/i"}'::jsonb);`);
      q(`select public.authorize_early_retest('${interventionId}','${projectId}','${actor}','runtime contract needs it now');`);
      q(`select public.create_retest_protocol('${interventionId}','${projectId}','${actor}');`);
      return q(`select id from public.protocols where baseline_protocol_id='${baselineId}' and status in ('approved','active');`);
    }

    const b1 = mintBaseline("reject-path");
    check("a baseline fixture exists", b1.length > 0);

    /* ═══════════ 3. reject_intervention ═══════════ */
    console.log("\n[3] reject_intervention");
    const iv1 = registerOn(b1, "r1");
    check("reject refuses an empty reason",
      qError(`select public.reject_intervention('${iv1}','${projectId}','${actor}','   ');`) !== null);
    check("the intervention is still proposed after the refused call",
      q(`select status from public.interventions where id='${iv1}';`) === "proposed");

    q(`select public.reject_intervention('${iv1}','${projectId}','${actor}','not enough supporting evidence');`);
    check("reject moves a proposal to rejected",
      q(`select status from public.interventions where id='${iv1}';`) === "rejected");
    check("the reason is stored",
      q(`select rejected_reason from public.interventions where id='${iv1}';`) === "not enough supporting evidence");
    check("the rejecting identity and instant are stored together",
      q(`select (rejected_by is not null and rejected_at is not null) from public.interventions where id='${iv1}';`) === "t");
    check("approval fields stay null on a rejected row",
      q(`select (approved_by is null and approved_at is null) from public.interventions where id='${iv1}';`) === "t",
      "interventions_approval_pair_check forbids otherwise");

    const firstRejectedAt = q(`select rejected_at from public.interventions where id='${iv1}';`);
    q(`select public.reject_intervention('${iv1}','${projectId}','${actor}','a different reason entirely');`);
    check("a replayed rejection does not re-stamp the instant",
      q(`select rejected_at from public.interventions where id='${iv1}';`) === firstRejectedAt);
    check("a replayed rejection does not overwrite the reason",
      q(`select rejected_reason from public.interventions where id='${iv1}';`) === "not enough supporting evidence");

    check("rejecting releases the one-live-intervention slot",
      q(`select count(*) from public.register_intervention('${projectId}','${b1}','h2','m2','page_created','https://x.example/r2','owner','["run-2"]'::jsonb);`) === "1");

    const ivApproved = q(`select id from public.interventions where protocol_id='${b1}' and status='proposed';`);
    q(`select public.approve_intervention('${ivApproved}','${projectId}','${actor}');`);
    q(`select public.reject_intervention('${ivApproved}','${projectId}','${actor}','too late');`);
    check("an approved intervention cannot be rejected",
      q(`select status from public.interventions where id='${ivApproved}';`) === "approved",
      "the registered claim is frozen; the honest exit is abandonment");

    /* ═══════════ 4. abandonment while nothing has been observed ═══════════ */
    console.log("\n[4] Abandonment is allowed while nothing has been observed");

    check("abandon refuses an empty reason",
      qError(`select public.abandon_intervention('${ivApproved}','${projectId}','${actor}','');`) !== null);

    q(`select public.abandon_intervention('${ivApproved}','${projectId}','${actor}','client reversed the change');`);
    check("an approved intervention can be abandoned",
      q(`select status from public.interventions where id='${ivApproved}';`) === "abandoned");
    check("the abandonment carries identity, instant and reason",
      q(`select (abandoned_by is not null and abandoned_at is not null and btrim(abandoned_reason) <> '') from public.interventions where id='${ivApproved}';`) === "t");

    // The full case: implemented, retest protocol created, job queued, but
    // not one attempt has landed.
    const b2 = mintBaseline("abandon-with-retest");
    const iv2 = registerOn(b2, "a1");
    const retest2 = mintRetest(b2, iv2);
    check("a retest protocol exists before abandonment", retest2.length > 0);

    q(`select public.enqueue_protocol_execution_job('${retest2}','${projectId}',3);`);
    check("its execution job is queued",
      q(`select status from public.protocol_execution_jobs where protocol_id='${retest2}';`) === "queued");
    check("no attempt has landed yet",
      q(`select count(*) from public.protocol_attempts where protocol_id='${retest2}';`) === "0");

    q(`select public.abandon_intervention('${iv2}','${projectId}','${actor}','intervention was rolled back by the client');`);
    check("the intervention is abandoned",
      q(`select status from public.interventions where id='${iv2}';`) === "abandoned");
    check("the live retest protocol is taken down with it",
      q(`select status from public.protocols where id='${retest2}';`) === "abandoned");
    check("the queued job is cancelled, so the worker stops buying runs",
      q(`select status from public.protocol_execution_jobs where protocol_id='${retest2}';`) === "cancelled");
    check("the cancellation records why",
      q(`select failure_reason from public.protocol_execution_jobs where protocol_id='${retest2}';`) === "intervention_abandoned");
    check("no attempt was invented or destroyed",
      q(`select count(*) from public.protocol_attempts where protocol_id='${retest2}';`) === "0");

    const iv2b = registerOn(b2, "a2");
    check("abandoning releases the one-live-intervention slot", iv2b.length > 0);
    const retest2b = mintRetest(b2, iv2b);
    check("and releases protocols_one_live_retest_per_baseline, so a fresh retest is possible",
      retest2b.length > 0 && retest2b !== retest2);

    /* ═══════════ 5. abandonment once the retest has started ═══════════ */
    console.log("\n[5] Abandonment is refused once the retest has started measuring");

    // A real attempt through the real admission path, not a hand-inserted
    // row. `retest` is also what 0074's phase trigger requires on a retest
    // protocol, so a wrong kind here would be refused rather than silently
    // creating an attempt of the wrong phase.
    const admitted = q(
      `select status from public.admit_and_reserve_attempt('${retest2b}','${projectId}','retest','0077-attempt-1',0.01);`
    );
    check("an attempt was admitted through the real reservation path",
      admitted === "RESERVED", admitted);
    check("the retest now has exactly one attempt",
      q(`select count(*) from public.protocol_attempts where protocol_id='${retest2b}';`) === "1");

    const refused = qError(`select public.abandon_intervention('${iv2b}','${projectId}','${actor}','results look bad');`);
    check("abandonment is refused once an attempt exists",
      refused !== null && refused.includes("retest_already_started"),
      refused ? refused.split("\n")[0] : "no error raised");
    check("the intervention is untouched by the refused call",
      q(`select status from public.interventions where id='${iv2b}';`) === "implemented");
    check("the retest protocol is untouched by the refused call",
      q(`select status from public.protocols where id='${retest2b}';`) !== "abandoned");

    // A claimed job with no attempt yet is refused for the same reason: an
    // attempt may be landing at this very instant.
    const b3 = mintBaseline("abandon-claimed");
    const iv3 = registerOn(b3, "c1");
    const retest3 = mintRetest(b3, iv3);
    q(`select public.enqueue_protocol_execution_job('${retest3}','${projectId}',3);`);
    const claimStatus = q(`select status from public.claim_protocol_execution_job('worker-0077', 60);`);
    check("a worker claimed the retest job", claimStatus === "CLAIMED", claimStatus);
    check("the job is claimed with no attempt yet",
      q(`select count(*) from public.protocol_attempts where protocol_id='${retest3}';`) === "0");

    const refusedClaimed = qError(`select public.abandon_intervention('${iv3}','${projectId}','${actor}','stop it now');`);
    check("abandonment is refused while a job is claimed or running",
      refusedClaimed !== null && refusedClaimed.includes("retest_already_started"),
      refusedClaimed ? refusedClaimed.split("\n")[0] : "no error raised");
    check("the claimed job is not cancelled out from under its worker",
      q(`select status from public.protocol_execution_jobs where protocol_id='${retest3}';`) !== "cancelled");

    /* ═══════════ 6. the abandonment record is permanent ═══════════ */
    console.log("\n[6] The abandonment record cannot be rewritten or reversed");
    check("the reason cannot be edited",
      qError(`update public.interventions set abandoned_reason='a nicer reason' where id='${iv2}';`) !== null);
    check("the instant cannot be moved",
      qError(`update public.interventions set abandoned_at = now() where id='${iv2}';`) !== null);
    check("the status cannot be moved back to implemented",
      qError(`update public.interventions set status='implemented' where id='${iv2}';`) !== null,
      "otherwise an intervention could be parked while its retest is inconvenient");
    check("the row is still abandoned after every refused edit",
      q(`select status from public.interventions where id='${iv2}';`) === "abandoned");

    /* ═══════════ 7. a cancelled job is never handed to a worker ═══════════ */
    console.log("\n[7] Cancellation is real, not cosmetic");
    // retest2's job is cancelled. Drain everything else so that if the claim
    // function were willing to hand out a cancelled job, it would have no
    // other candidate to hide behind.
    q(`update public.protocol_execution_jobs set status='succeeded' where status in ('queued','claimed','running') and protocol_id <> '${retest2}';`);
    check("the only remaining non-terminal job is the cancelled one",
      q(`select count(*) from public.protocol_execution_jobs where status in ('queued','claimed','running');`) === "0");
    const drained = q(`select status from public.claim_protocol_execution_job('worker-0077-b', 60);`);
    check("the claim function refuses to hand out a cancelled job",
      drained === "NO_JOB_AVAILABLE", drained);

    console.log(
      `\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}`
    );
    if (failures === 0) succeeded = true;
  } finally {
    if (started && succeeded) {
      console.log("\nStopping and deleting the disposable stack...");
      try { run("supabase", ["stop", "--workdir", workdir, "--no-backup"]); } catch { /* best effort */ }
      try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else if (started) {
      console.log(`\nStack left running for inspection: ${workdir}`);
      console.log(`Stop it with: supabase stop --workdir ${workdir} --no-backup`);
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
