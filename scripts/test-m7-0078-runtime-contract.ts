#!/usr/bin/env tsx
/**
 * 0078 — real PostgreSQL runtime contract: interventions register against
 * baselines only.
 *
 * Photographs the gap first (0071 accepts a retest protocol as a
 * registration target), then proves the precondition block refuses to apply
 * 0078 over a chained row that already exists — so the block is shown to
 * work, not assumed to — then applies it and proves a retest is refused in
 * both approved and completed states while a baseline still registers.
 *
 * Discipline inherited from the 0056/0070-0077 harnesses: opt-in via
 * ZYPACT_M7_0078_RUNTIME_TEST=1, disposable mktemp stack, no .env, no remote
 * database, no provider, cleanup only after full success, workdir preserved
 * on failure, a SKIP is never reported as a pass.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0078_RUNTIME_TEST";
const BEFORE = 77;
const MAXV = 78;

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

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0078-"));
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
    check("the tranche under test is exactly 0078 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0078_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0077 only...");
    run("supabase", ["start", "--workdir", workdir]);
    started = true;
    console.log("Stack started.\n");

    const container = run("docker", ["ps", "--format", "{{.Names}}"])
      .split("\n").find((n) => n.startsWith("supabase_db_"));
    if (!container) throw new Error("no supabase_db container");

    // `-t` suppresses headers/footers, but psql still appends its own
    // command-completion tag ("INSERT 0 1", …) on the next line for writes,
    // including with RETURNING. Keep only the scalar's own line.
    const q = (sql: string): string =>
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
        { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n", 1)[0];
    const qError = (sql: string): string | null => {
      try { q(sql); return null; }
      catch (e) { return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message); }
    };

    /* ═══════════ fixtures, built on 0071's register_intervention ═══════════ */
    const projectId = q(`insert into public.projects (domain) values ('m7-0078.example') returning id;`);
    const actor = q(`select gen_random_uuid();`);

    let seq = 0;
    function mintBaseline(label: string): string {
      seq += 1;
      const hashChar = seq.toString(16);
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

    // Passes expected_observation_days at registration, as the Phase 2 route
    // does, rather than patching it in afterwards.
    const registerSql = (protocolId: string, label: string): string =>
      `select id from public.register_intervention('${projectId}','${protocolId}','h-${label}','m-${label}','content_published','https://x.example/${label}','owner','["run-${label}"]'::jsonb, null, null, null, null, 21);`;

    function mintRetest(baselineId: string, interventionId: string): string {
      q(`select public.approve_intervention('${interventionId}','${projectId}','${actor}');`);
      q(`select public.confirm_intervention_implementation('${interventionId}','${projectId}','${actor}','{"url":"https://x.example/i"}'::jsonb);`);
      q(`select public.authorize_early_retest('${interventionId}','${projectId}','${actor}','runtime contract needs it now');`);
      q(`select public.create_retest_protocol('${interventionId}','${projectId}','${actor}');`);
      return q(`select id from public.protocols where baseline_protocol_id='${baselineId}' and status in ('approved','active');`);
    }

    const base = mintBaseline("chain");
    const iv = q(registerSql(base, "first"));
    const retest = mintRetest(base, iv);
    check("fixture: a baseline -> intervention -> retest chain exists", retest.length > 0);

    /* ═══════════ 0. the gap, photographed ═══════════ */
    console.log("\n[0] Before 0078 — a retest protocol is accepted as a registration target");
    const chained = q(registerSql(retest, "chained"));
    check("0071's register_intervention accepts a retest protocol", chained.length > 0,
      "this is the state 0078 exists to forbid");

    /* ═══════════ 1. the precondition refuses to apply over a chained row ═══════════ */
    console.log("\n[1] 0078 refuses to apply while a chained intervention exists");
    const f = tranche[0];
    copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    const sqlPath = `/tmp/${f}`;
    execFileSync("docker", ["cp", path.join(dstDir, f), `${container}:${sqlPath}`], { stdio: "ignore" });

    // `-1` wraps the file in one transaction, as the staging runbook does, so a
    // refused apply leaves nothing half-applied.
    const applyOnce = (): string | null => {
      try {
        execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres",
          "-v", "ON_ERROR_STOP=1", "-1", "-f", sqlPath],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
        return null;
      } catch (e) {
        return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message);
      }
    };

    const REGPROC = "public.register_intervention(uuid,uuid,text,text,text,text,text,jsonb,text,text,text,timestamptz,integer)";
    // pg_get_functiondef is multi-line and q() keeps only the first line (the
    // CREATE header), so the match must happen in SQL and return one t/f. An
    // earlier draft matched in TypeScript: the "carries the check" assertion
    // failed on a correct body, and the "old body still in place" assertion
    // passed vacuously, because the header line never contains either string.
    const bodyHas0078 = (): string =>
      q(`select pg_get_functiondef('${REGPROC}'::regprocedure) like '%protocol_is_not_a_baseline%';`);
    const blocked = applyOnce();
    check("the apply fails",
      blocked !== null && blocked.includes("0078 precondition failed"),
      blocked ? (blocked.split("\n").find((l) => l.includes("ERROR")) ?? "") : "applied");
    check("and changed nothing — the old body is still in place",
      bodyHas0078() === "f", `body carries 0078: ${bodyHas0078()}`);

    // Superuser cleanup of the fixture — exactly the manual resolution the
    // precondition message asks an operator for.
    q(`delete from public.interventions where id='${chained}';`);

    /* ═══════════ 2. apply ═══════════ */
    console.log("\nApplying 0078...");
    const applied = applyOnce();
    check(`${f} applied cleanly once the chained row is resolved`, applied === null, applied ?? "");

    /* ═══════════ 3. the rule holds ═══════════ */
    console.log("\n[3] Registration is refused against a retest");
    const refused = qError(registerSql(retest, "chained-again"));
    check("an approved retest protocol is refused",
      refused !== null && refused.includes("protocol_is_not_a_baseline"),
      refused ? refused.split("\n")[0] : "accepted");
    check("no row was written by the refused call",
      q(`select count(*) from public.interventions where protocol_id='${retest}';`) === "0");

    q(`update public.protocols set status='completed' where id='${retest}';`);
    const refusedCompleted = qError(registerSql(retest, "completed-retest"));
    check("a COMPLETED retest is refused too — the exact case 0071 let through",
      refusedCompleted !== null && refusedCompleted.includes("protocol_is_not_a_baseline"),
      refusedCompleted ? refusedCompleted.split("\n")[0] : "accepted");

    /* ═══════════ 4. baselines are unaffected ═══════════ */
    console.log("\n[4] Baselines are unaffected");
    const base2 = mintBaseline("fresh");
    check("a baseline registration still succeeds", q(registerSql(base2, "fresh")).length > 0);

    const base3 = mintBaseline("to-be-draft");
    q(`update public.protocols set status='draft', approved_by=null, approved_at=null where id='${base3}';`);
    const notExec = qError(registerSql(base3, "draft"));
    check("an unapproved baseline is still refused as protocol_not_executable",
      notExec !== null && notExec.includes("protocol_not_executable"),
      notExec ? notExec.split("\n")[0] : "accepted");

    /* ═══════════ 5. replaced, not duplicated ═══════════ */
    console.log("\n[5] Replaced, not duplicated; grants intact");
    check("exactly one register_intervention overload",
      q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='register_intervention';`) === "1");
    check("the live body carries the 0078 check",
      bodyHas0078() === "t", `body carries 0078: ${bodyHas0078()}`);
    check("service_role can still execute it",
      q(`select count(*) from information_schema.role_routine_grants where routine_name='register_intervention' and grantee='service_role' and privilege_type='EXECUTE';`) === "1");
    check("no untrusted role can",
      q(`select count(*) from information_schema.role_routine_grants where routine_name='register_intervention' and grantee in ('PUBLIC','anon','authenticated');`) === "0");
    check("anon is actually refused",
      qError(`set role anon; ${registerSql(base2, "anon")}`) !== null);

    console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}`);
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
