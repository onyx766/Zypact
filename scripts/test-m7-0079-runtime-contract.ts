#!/usr/bin/env tsx
/**
 * 0079 — real PostgreSQL runtime contract: one retest per registered
 * intervention.
 *
 * Photographs the gap first — on 0073, a completed retest is followed by a
 * fresh second one for the same intervention — then proves the precondition
 * refuses to apply over a baseline already carrying two retests, then proves
 * a completed retest is returned rather than replaced, while abandonment
 * still frees the baseline for a genuinely new intervention's retest.
 *
 * Discipline inherited from the 0056/0070-0078 harnesses: opt-in via
 * ZYPACT_M7_0079_RUNTIME_TEST=1, disposable stack, no .env, no remote
 * database, cleanup only after full success, a SKIP is never a pass.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0079_RUNTIME_TEST";
const BEFORE = 78;
const MAXV = 79;

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

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0079-"));
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
    check("the tranche under test is exactly 0079 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0079_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0078 only...");
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

    /* ═══════════ fixtures ═══════════ */
    const projectId = q(`insert into public.projects (domain) values ('m7-0079.example') returning id;`);
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

    /** An intervention carried to retest eligibility (early-authorized). */
    function mintEligible(baselineId: string, label: string): string {
      const iv = q(
        `select id from public.register_intervention('${projectId}','${baselineId}','h-${label}','m-${label}','content_published','https://x.example/${label}','owner','["run-${label}"]'::jsonb, null, null, null, null, 21);`
      );
      q(`select public.approve_intervention('${iv}','${projectId}','${actor}');`);
      q(`select public.confirm_intervention_implementation('${iv}','${projectId}','${actor}','{"url":"https://x.example/i"}'::jsonb);`);
      q(`select public.authorize_early_retest('${iv}','${projectId}','${actor}','runtime contract needs it now');`);
      return iv;
    }

    /** "STATUS:retest-id" from one create_retest_protocol call. */
    const createRetest = (iv: string): string =>
      q(`select status_code || ':' || coalesce(retest_protocol_id::text, '') from public.create_retest_protocol('${iv}','${projectId}','${actor}');`);
    const retestCount = (baselineId: string): string =>
      q(`select count(*) from public.protocols where baseline_protocol_id='${baselineId}';`);

    const REGPROC = "public.create_retest_protocol(uuid,uuid,uuid)";
    // Matched in SQL: pg_get_functiondef is multi-line and q() keeps only the
    // first line (see the 0078 harness for the bug this avoids).
    const bodyHas0079 = (): string =>
      q(`select pg_get_functiondef('${REGPROC}'::regprocedure) like '%''draft'', ''approved'', ''active'', ''completed''%';`);

    /* ═══════════ 0. the gap, photographed ═══════════ */
    console.log("[0] Before 0079 — a completed retest is replaced by a fresh one");
    const b1 = mintBaseline("gap");
    const iv1 = mintEligible(b1, "gap");
    const first = createRetest(iv1);
    check("fixture: the first retest is created", first.startsWith("CREATED:"), first);
    const firstId = first.split(":")[1];

    q(`update public.protocols set status='completed' where id='${firstId}';`);
    const second = createRetest(iv1);
    check("0073 mints a SECOND retest for the same intervention once the first completes",
      second.startsWith("CREATED:") && second.split(":")[1] !== firstId,
      `${second} — this is the state 0079 exists to forbid`);
    check("the baseline now carries two non-abandoned retests", retestCount(b1) === "2");

    /* ═══════════ 1. the precondition refuses to apply over that state ═══════════ */
    console.log("\n[1] 0079 refuses to apply while a baseline has two retests");
    const f = tranche[0];
    copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    const sqlPath = `/tmp/${f}`;
    execFileSync("docker", ["cp", path.join(dstDir, f), `${container}:${sqlPath}`], { stdio: "ignore" });
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

    const blocked = applyOnce();
    check("the apply fails",
      blocked !== null && blocked.includes("0079 precondition failed"),
      blocked ? (blocked.split("\n").find((l) => l.includes("ERROR")) ?? "") : "applied");
    check("and changed nothing — the 0073 body is still in place",
      bodyHas0079() === "f", `body carries 0079: ${bodyHas0079()}`);

    // Superuser cleanup: remove the duplicate, which is the manual resolution
    // the precondition message asks an operator for.
    q(`delete from public.protocols where id='${second.split(":")[1]}';`);
    check("fixture: back to one retest on the baseline", retestCount(b1) === "1");

    /* ═══════════ 2. apply ═══════════ */
    console.log("\nApplying 0079...");
    const applied = applyOnce();
    check(`${f} applied cleanly once the duplicate is resolved`, applied === null, applied ?? "");
    check("the live body carries the widened predicate", bodyHas0079() === "t", `body carries 0079: ${bodyHas0079()}`);

    /* ═══════════ 3. a completed retest is returned, never replaced ═══════════ */
    console.log("\n[3] One retest per intervention");
    const again = createRetest(iv1);
    check("a completed retest is returned as RETEST_ALREADY_EXISTS",
      again === `RETEST_ALREADY_EXISTS:${firstId}`, again);
    check("and no new protocol row was written", retestCount(b1) === "1");

    const b2 = mintBaseline("live");
    const iv2 = mintEligible(b2, "live");
    const live = createRetest(iv2);
    const liveId = live.split(":")[1];
    check("a live retest is still returned on replay (0073 behaviour unchanged)",
      createRetest(iv2) === `RETEST_ALREADY_EXISTS:${liveId}`);

    /* ═══════════ 4. an abandoned retest does not block a replacement ═══════════ */
    console.log("\n[4] Abandonment still frees the baseline for a new retest");
    const b3 = mintBaseline("abandon");
    const iv3 = mintEligible(b3, "a1");
    const abandonedRetest = createRetest(iv3).split(":")[1];
    q(`select public.abandon_intervention('${iv3}','${projectId}','${actor}','client rolled the change back');`);
    check("fixture: the first retest was abandoned with its intervention",
      q(`select status from public.protocols where id='${abandonedRetest}';`) === "abandoned");

    const iv3b = mintEligible(b3, "a2");
    const replacement = createRetest(iv3b);
    check("the replacement intervention gets its own fresh retest",
      replacement.startsWith("CREATED:") && replacement.split(":")[1] !== abandonedRetest, replacement);
    check("the baseline holds exactly one non-abandoned retest — what deliver-outcome-card relies on",
      q(`select count(*) from public.protocols where baseline_protocol_id='${b3}' and status <> 'abandoned';`) === "1");

    /* ═══════════ 5. replaced, not duplicated ═══════════ */
    console.log("\n[5] Replaced, not duplicated; grants intact");
    check("exactly one create_retest_protocol overload",
      q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_retest_protocol';`) === "1");
    check("service_role can still execute it",
      q(`select count(*) from information_schema.role_routine_grants where routine_name='create_retest_protocol' and grantee='service_role' and privilege_type='EXECUTE';`) === "1");
    check("no untrusted role can",
      q(`select count(*) from information_schema.role_routine_grants where routine_name='create_retest_protocol' and grantee in ('PUBLIC','anon','authenticated');`) === "0");
    check("anon is actually refused",
      qError(`set role anon; select * from public.create_retest_protocol('${iv2}','${projectId}','${actor}');`) !== null);

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
