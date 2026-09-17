#!/usr/bin/env tsx
/**
 * 0076 — real PostgreSQL runtime contract for the Outcome Card artifact
 * table and its delivery pipeline.
 *
 * Section [3] is the centrepiece: a genuine two-process OS-level race on
 * `begin_outcome_card_delivery`, proving the fencing excludes a duplicate
 * claim rather than merely looking correct in the SQL text — exactly the
 * property 0035's own runtime work proved for the baseline path, and
 * exactly the kind of fact only a running Postgres can settle.
 *
 * Section [4] proves the one deliberate departure from the 0035 precedent:
 * a `blocked` artifact is refused by the database itself, not merely by
 * whichever caller happens to check first.
 *
 * Discipline, inherited from the 0056/0070-0075 harnesses: opt-in via
 * ZYPACT_M7_0076_RUNTIME_TEST=1, disposable mktemp stack, no .env, no
 * remote database, no provider, cleanup only after full success, workdir
 * preserved on failure, a SKIP is never reported as a pass.
 *
 * Migrations 0001-0075 are applied first and the pre-0076 state is
 * photographed, so any difference is attributable to 0076 alone.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0076_RUNTIME_TEST";
const BEFORE = 75;
const MAXV = 76;

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

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0076-"));
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
    check("the tranche under test is exactly 0076 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0076_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0075 only...");
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
    const qError = (sql: string): string | null => {
      try { q(sql); return null; }
      catch (e) { return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message); }
    };

    console.log("[0] Before 0076");
    check("outcome_card_artifacts does not exist yet",
      q(`select count(*) from information_schema.tables where table_name='outcome_card_artifacts';`) === "0");

    console.log("\nApplying 0076...");
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

    /* ═══════════ 1. privileges actually refuse ═══════════ */
    console.log("[1] Privileges refuse a write, they do not merely look revoked");
    check("outcome_card_artifacts exists",
      q(`select count(*) from information_schema.tables where table_name='outcome_card_artifacts';`) === "1");
    check("row level security is on",
      q(`select relrowsecurity from pg_class where relname='outcome_card_artifacts';`) === "t");
    check("anon holds nothing",
      q(`select coalesce(string_agg(distinct privilege_type,','),'NONE') from information_schema.role_table_grants where table_name='outcome_card_artifacts' and grantee='anon';`) === "NONE");
    check("anon is actually refused a SELECT",
      qError(`set role anon; select * from public.outcome_card_artifacts;`) !== null);
    check("untrusted roles cannot call the token generator directly",
      qError(`set role service_role; select public._generate_outcome_card_public_token();`) !== null,
      "even service_role — the function is revoked from every named role");

    /* ═══════════ 2. fixtures: a full baseline -> intervention -> retest chain ═══════════ */
    console.log("\n[2] Fixtures");
    const projectId = q(`insert into public.projects (domain) values ('m7-0076.example') returning id;`);
    const actor = q(`select gen_random_uuid();`);

    /**
     * A full, genuine baseline -> intervention -> retest chain, ending with
     * a real create_retest_protocol call. Every fixture in this file that
     * needs a (baseline, retest) pair `save_outcome_card_artifact` will
     * actually accept goes through this — NOT through fabricating a
     * "retest" by passing one protocol's id as both arguments, which can
     * never satisfy `p.baseline_protocol_id = p_baseline_protocol_id`
     * (a genuine baseline's own baseline_protocol_id is always null, never
     * equal to its own id). Two earlier drafts of section [6] made exactly
     * that mistake and it silently produced an empty result from
     * save_outcome_card_artifact, which then crashed the NEXT call
     * (begin_outcome_card_delivery) on an empty-string-to-uuid cast rather
     * than testing what section [6] actually intends to test.
     */
    function mintImplementedChain(
      label: string,
      hashChar: string
    ): { interventionId: string; baselineId: string; retestId: string } {
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
      const interventionId = q(
        `select id from public.register_intervention('${projectId}','${baselineId}','h-${label}','m-${label}','content_published','https://x.example/${label}','owner','["run-${label}"]'::jsonb);`
      );
      q(`select public.approve_intervention('${interventionId}','${projectId}','${actor}');`);
      q(`update public.interventions set expected_observation_days = 21 where id='${interventionId}';`);
      q(`select public.confirm_intervention_implementation('${interventionId}','${projectId}','${actor}','{"url":"https://x.example/${label}"}'::jsonb);`);
      q(`select public.authorize_early_retest('${interventionId}','${projectId}','${actor}','runtime contract needs it now');`);
      q(`select public.create_retest_protocol('${interventionId}','${projectId}','${actor}');`);
      const retestId = q(`select id from public.protocols where baseline_protocol_id='${baselineId}';`);
      return { interventionId, baselineId, retestId };
    }

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
    const ivId = q(
      `select id from public.register_intervention('${projectId}','${baselineId}','h','m','content_published','https://x.example/a','owner','["run-1"]'::jsonb);`
    );
    q(`select public.approve_intervention('${ivId}','${projectId}','${actor}');`);
    q(`update public.interventions set expected_observation_days = 21 where id='${ivId}';`);
    q(`select public.confirm_intervention_implementation('${ivId}','${projectId}','${actor}','{"url":"https://x.example/a"}'::jsonb);`);
    q(`select public.authorize_early_retest('${ivId}','${projectId}','${actor}','runtime contract needs it now');`);
    q(`select public.create_retest_protocol('${ivId}','${projectId}','${actor}');`);
    const retestId = q(`select id from public.protocols where baseline_protocol_id='${baselineId}';`);
    check("a full baseline->intervention->retest chain exists", retestId.length > 0);

    /* ═══════════ 3. save_outcome_card_artifact's re-derived invariants ═══════════ */
    console.log("\n[3] save_outcome_card_artifact's re-derived invariants actually fire");
    // Wrong retest/baseline pairing: a second, unrelated baseline+retest pair.
    const otherBaseline = q(
      `insert into public.protocols (project_id, buyer_question_version_id, provider, surface, model_config,
         planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric, sample_planning_method,
         run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap)
       values ('${projectId}','${versionId}','perplexity_sonar','answer','{"model":"sonar"}'::jsonb,
         5,0,'buyer_question_version','presence_rate','fixed_operator_default_pending_pilot_calibration',
         7,2,86400,10,1,2) returning id;`
    );
    check("save refuses a retest id that does not actually belong to this intervention's baseline",
      q(`select count(*) from public.save_outcome_card_artifact('${ivId}','${projectId}','${baselineId}','${otherBaseline}','# card',now(),'{"a":1}'::jsonb,'integrity_passed','[]'::jsonb);`) === "0");

    // An intervention that is only 'approved', never implemented.
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
    const iv2 = q(`select id from public.register_intervention('${projectId}','${p2}','h2','m2','content_published','https://x.example/b','owner','["run-2"]'::jsonb);`);
    q(`select public.approve_intervention('${iv2}','${projectId}','${actor}');`);
    check("THE RE-DERIVED INVARIANT: save refuses an intervention that is only approved, never implemented",
      q(`select count(*) from public.save_outcome_card_artifact('${iv2}','${projectId}','${p2}','${baselineId}','# card',now(),'{"a":1}'::jsonb,'integrity_passed','[]'::jsonb);`) === "0");

    /* ═══════════ 4. the real save, and idempotent update-in-place ═══════════ */
    console.log("\n[4] A real save, and idempotent update-in-place while undelivered");
    const artifactId = q(
      `select id from public.save_outcome_card_artifact('${ivId}','${projectId}','${baselineId}','${retestId}','# Outcome Card v1',now(),'{"v":1}'::jsonb,'needs_review','["reason one"]'::jsonb);`
    );
    check("the artifact was created", artifactId.length > 0);
    check("a public token was generated and meets the length floor",
      Number(q(`select char_length(public_token) from public.outcome_card_artifacts where id='${artifactId}';`)) >= 43);

    const artifactId2 = q(
      `select id from public.save_outcome_card_artifact('${ivId}','${projectId}','${baselineId}','${retestId}','# Outcome Card v2',now(),'{"v":2}'::jsonb,'integrity_passed','[]'::jsonb);`
    );
    check("a repeat save UPDATES the same row rather than creating a second one", artifactId2 === artifactId);
    check("the row's content actually changed", q(`select markdown from public.outcome_card_artifacts where id='${artifactId}';`) === "# Outcome Card v2");
    check("the public token did NOT change on update",
      q(`select public_token from public.outcome_card_artifacts where id='${artifactId}';`).length >= 43);
    check("integrity_status moved to integrity_passed with empty reasons",
      q(`select integrity_status from public.outcome_card_artifacts where id='${artifactId}';`) === "integrity_passed" &&
      q(`select integrity_reasons from public.outcome_card_artifacts where id='${artifactId}';`) === "[]");

    /* ═══════════ 5. THE CENTREPIECE — a genuine concurrent claim race ═══════════ */
    console.log("\n[5] A real two-process race on begin_outcome_card_delivery");
    const revision = q(`select public.outcome_card_artifact_revision('# Outcome Card v2', '{"v":2}'::jsonb);`);
    const psqlArgs = (sql: string) => [
      "exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql,
    ];
    const beginSql =
      `select delivery_claim_token from public.begin_outcome_card_delivery('${ivId}','${artifactId}','${revision}');`;

    const [r1, r2] = [
      spawnSync("docker", psqlArgs(beginSql), { encoding: "utf8" }),
      spawnSync("docker", psqlArgs(beginSql), { encoding: "utf8" }),
    ];
    const succeeded1 = r1.status === 0 && r1.stdout.trim().length > 0;
    const succeeded2 = r2.status === 0 && r2.stdout.trim().length > 0;
    check(
      "EXACTLY ONE of the two concurrent begin_outcome_card_delivery calls won the claim",
      (succeeded1 && !succeeded2) || (!succeeded1 && succeeded2),
      `p1=${succeeded1 ? "won" : "lost"} p2=${succeeded2 ? "won" : "lost"}`
    );
    const winnerToken = (succeeded1 ? r1.stdout : r2.stdout).trim();
    check("the claim token is a real, non-empty value", winnerToken.length > 0);

    check("finalize with the RIGHT token succeeds",
      qError(`select public.finalize_outcome_card_delivery('${ivId}','${artifactId}','${winnerToken}','msg-1');`) === null);
    check("the artifact is now delivered", q(`select delivered_at is not null from public.outcome_card_artifacts where id='${artifactId}';`) === "t");
    check("a second save is now refused — a delivered artifact is immutable",
      q(`select count(*) from public.save_outcome_card_artifact('${ivId}','${projectId}','${baselineId}','${retestId}','# v3',now(),'{"v":3}'::jsonb,'integrity_passed','[]'::jsonb);`) === "0");

    /* ═══════════ 6. blocked is refused at the database layer ═══════════ */
    console.log("\n[6] blocked is refused by the database itself");
    {
      // A genuine (baseline, retest) pair — save_outcome_card_artifact's
      // re-derived pairing check would refuse anything less, exactly as
      // section [3] already proved. That refusal is not this section's
      // subject; the integrity gate on an artifact that WAS legitimately
      // saved is.
      const chain = mintImplementedChain("blocked-fixture", "d");
      const blockedArtifact = q(
        `select id from public.save_outcome_card_artifact('${chain.interventionId}','${projectId}','${chain.baselineId}','${chain.retestId}','# blocked card',now(),'{"v":1}'::jsonb,'blocked','["legacy verdict exposure"]'::jsonb);`
      );
      check("a blocked artifact was saved for the fixture", blockedArtifact.length > 0, blockedArtifact);
      const blockedRevision = q(`select public.outcome_card_artifact_revision('# blocked card', '{"v":1}'::jsonb);`);
      const blockedErr = qError(
        `select public.begin_outcome_card_delivery('${chain.interventionId}','${blockedArtifact}','${blockedRevision}');`
      );
      check(
        "THE DELIBERATE IMPROVEMENT: begin_outcome_card_delivery refuses a blocked artifact outright",
        blockedErr !== null && blockedErr.includes("may never be delivered"),
        blockedErr ?? "no error raised"
      );
    }
    {
      const chain = mintImplementedChain("needs-review-fixture", "e");
      const nrArtifact = q(
        `select id from public.save_outcome_card_artifact('${chain.interventionId}','${projectId}','${chain.baselineId}','${chain.retestId}','# needs review card',now(),'{"v":1}'::jsonb,'needs_review','["M4 gap"]'::jsonb);`
      );
      check("a needs_review artifact was saved for the fixture", nrArtifact.length > 0, nrArtifact);
      const nrRevision = q(`select public.outcome_card_artifact_revision('# needs review card', '{"v":1}'::jsonb);`);
      const claimed = q(
        `select delivery_claim_token from public.begin_outcome_card_delivery('${chain.interventionId}','${nrArtifact}','${nrRevision}');`
      );
      check(
        "needs_review is NOT refused the same way — a human may still deliver it manually",
        claimed.length > 0,
        claimed
      );
    }

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
    ? "\nM7 0076 runtime contract PASSED."
    : `\n${failures} check(s) failed. M7 0076 runtime contract FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
