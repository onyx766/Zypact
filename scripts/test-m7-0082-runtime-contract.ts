#!/usr/bin/env tsx
/**
 * 0082 — real PostgreSQL runtime contract: deviations recorded after
 * implementation.
 *
 * Photographs the gap first — on 0081 an implemented intervention has no
 * writer for a deviation — then proves the ledger accepts a note only while
 * the intervention is 'implemented', stamps the state it was written in,
 * replays a duplicate, and cannot be edited or erased by anyone.
 *
 * Unlike the 0070-0079 harnesses this one needs no Docker: it creates its own
 * PostgreSQL cluster with `initdb` in a temp directory, on a free loopback
 * port with trust auth, and removes it afterwards. It bootstraps the three
 * Supabase roles the same way scripts/test-snapshot-worker-postgres-level2.sh
 * does and applies every migration verbatim.
 *
 * Opt-in via ZYPACT_M7_0082_RUNTIME_TEST=1. No .env, no remote database, no
 * provider. A SKIP is never a pass.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0082_RUNTIME_TEST";
const BEFORE = 81;
const MAXV = 82;
const USER = "zypact_test";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** `initdb`, `pg_ctl` and `psql` from ZYPACT_PG_BIN, or from PATH. */
function pgBinary(name: string): string {
  const dir = process.env.ZYPACT_PG_BIN;
  if (!dir) return name;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(dir, exe);
}
function available(cmd: string): boolean {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
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
      `SKIP — this harness creates a disposable local PostgreSQL cluster and is opt-in.\n` +
      `      Run it with ${OPT_IN}=1 and PostgreSQL 16 binaries on PATH or in ZYPACT_PG_BIN.\n` +
      `      Nothing was verified; nothing is claimed.`
    );
    process.exit(0);
  }
  for (const cmd of ["initdb", "pg_ctl", "psql"]) {
    if (!available(pgBinary(cmd))) {
      console.log(`SKIP — \`${cmd}\` is not available. Nothing was verified.`);
      process.exit(0);
    }
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0082-"));
  const dataDir = path.join(workdir, "data");
  const port = await freePort();
  console.log(`Disposable cluster: ${dataDir} on 127.0.0.1:${port}`);
  let started = false;
  let succeeded = false;

  const psqlArgs = (extra: string[]) =>
    ["-h", "127.0.0.1", "-p", String(port), "-U", USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", ...extra];
  // `-t` drops headers, but psql still prints a command tag on the next line
  // for writes. Keep only the scalar's own line.
  const q = (sql: string): string =>
    execFileSync(pgBinary("psql"), psqlArgs(["-tAc", sql]),
      { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/, 1)[0];
  const qError = (sql: string): string | null => {
    try { q(sql); return null; }
    catch (e) { return String((e as { stderr?: Buffer }).stderr ?? (e as Error).message); }
  };
  const applyFile = (file: string): void => {
    execFileSync(pgBinary("psql"), psqlArgs(["-q", "-f", file]), { stdio: ["ignore", "ignore", "pipe"] });
  };

  try {
    execFileSync(pgBinary("initdb"), ["-D", dataDir, "-U", USER, "-A", "trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
    execFileSync(pgBinary("pg_ctl"),
      ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-l", path.join(workdir, "server.log"), "-w", "start"],
      { stdio: "ignore" });
    started = true;

    // Same three roles the level-2 harness creates. service_role carries
    // BYPASSRLS, as Supabase's does.
    q(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`);

    const srcDir = path.join(REPO, "supabase", "migrations");
    const all = selectMigrations(readdirSync(srcDir), MAXV);
    const tranche = all.slice(BEFORE);
    check("the tranche under test is exactly 0082 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0082_"));

    console.log(`\nApplying 0001-00${BEFORE} verbatim...`);
    for (const f of all.slice(0, BEFORE)) applyFile(path.join(srcDir, f));
    console.log("Applied.\n");

    /* ═══════════ fixtures ═══════════ */
    const projectId = q(`insert into public.projects (domain) values ('m7-0082.example') returning id;`);
    const otherProject = q(`insert into public.projects (domain) values ('m7-0082-other.example') returning id;`);
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
    const register = (baselineId: string, label: string): string =>
      q(`select id from public.register_intervention('${projectId}','${baselineId}','h-${label}','m-${label}','content_published','https://x.example/${label}','owner','["run-${label}"]'::jsonb, null, null, null, null, 21);`);
    const approve = (iv: string) => q(`select public.approve_intervention('${iv}','${projectId}','${actor}');`);
    const implement = (iv: string) =>
      q(`select public.confirm_intervention_implementation('${iv}','${projectId}','${actor}','{"url":"https://x.example/i"}'::jsonb);`);
    const record = (iv: string, note: string, project = projectId): string =>
      q(`select count(*) from public.record_intervention_deviation('${iv}','${project}','${actor}',$n$${note}$n$);`);
    const ledgerCount = (iv: string): string =>
      q(`select count(*) from public.intervention_deviations where intervention_id='${iv}';`);

    /* ═══════════ 0. the gap, photographed ═══════════ */
    console.log("[0] Before 0082 — an implemented intervention cannot take a deviation");
    const b0 = mintBaseline("gap");
    const iv0 = register(b0, "gap");
    approve(iv0);
    implement(iv0);
    check("fixture: the intervention is implemented",
      q(`select status from public.interventions where id='${iv0}';`) === "implemented");
    // 0072 answers a second confirm with the existing row, as a replay. The
    // deviation passed alongside it is accepted by the signature and dropped.
    check("confirming again with a deviation is treated as a replay of the first confirm",
      q(`select count(*) from public.confirm_intervention_implementation('${iv0}','${projectId}','${actor}','{"url":"https://x.example/i"}'::jsonb, null, 'homepage rebuilt mid-window');`) === "1");
    check("and protocol_deviations is still empty — the disclosure was silently dropped",
      q(`select coalesce(protocol_deviations,'<null>') from public.interventions where id='${iv0}';`) === "<null>");
    check("no ledger exists yet",
      q(`select to_regclass('public.intervention_deviations') is null;`) === "t");

    /* ═══════════ 1. apply 0082 ═══════════ */
    console.log("\n[1] 0082 applies, and applies again");
    const file = path.join(srcDir, tranche[0]);
    applyFile(file);
    applyFile(file);
    check("the ledger table exists", q(`select to_regclass('public.intervention_deviations') is not null;`) === "t");
    check("exactly one record_intervention_deviation overload",
      q(`select count(*) from pg_proc where proname='record_intervention_deviation';`) === "1");
    check("row level security is enabled on the ledger",
      q(`select relrowsecurity from pg_class where oid='public.intervention_deviations'::regclass;`) === "t");

    console.log("\n[2] ACL — read for service_role, nothing for anyone else");
    const REGPROC = "public.record_intervention_deviation(uuid,uuid,uuid,text)";
    for (const [role, priv, want] of [
      ["service_role", "SELECT", "t"], ["service_role", "INSERT", "f"],
      ["service_role", "UPDATE", "f"], ["service_role", "DELETE", "f"],
      ["service_role", "TRUNCATE", "f"],
      ["anon", "SELECT", "f"], ["authenticated", "SELECT", "f"],
    ] as const) {
      check(`${role} ${priv} on the ledger is ${want === "t" ? "granted" : "denied"}`,
        q(`select has_table_privilege('${role}','public.intervention_deviations','${priv}');`) === want);
    }
    for (const [role, want] of [["service_role", "t"], ["anon", "f"], ["authenticated", "f"]] as const) {
      check(`${role} execute on the RPC is ${want === "t" ? "granted" : "denied"}`,
        q(`select has_function_privilege('${role}','${REGPROC}','EXECUTE');`) === want);
    }

    /* ═══════════ 3. status gating ═══════════ */
    console.log("\n[3] Accepted only while the intervention is 'implemented'");
    const b1 = mintBaseline("gate");
    const iv1 = register(b1, "gate");
    check("proposed: no row returned, nothing written", record(iv1, "too early") === "0" && ledgerCount(iv1) === "0");
    approve(iv1);
    check("approved: no row returned, nothing written", record(iv1, "still too early") === "0" && ledgerCount(iv1) === "0");
    implement(iv1);
    check("implemented: the intervention row is returned", record(iv1, "Homepage rebuilt on day 5.") === "1");
    check("and exactly one ledger row exists", ledgerCount(iv1) === "1");
    check("the row carries the note, the actor and a timestamp",
      q(`select note || '|' || (recorded_by = '${actor}')::text || '|' || (recorded_at <= now())::text from public.intervention_deviations where intervention_id='${iv1}';`) === "Homepage rebuilt on day 5.|true|true");
    check("it is stamped as recorded before any retest attempt and before delivery",
      q(`select retest_attempts_at_record::text || '|' || card_delivered_at_record::text from public.intervention_deviations where intervention_id='${iv1}';`) === "0|false");
    check("the gap intervention from [0] can now be given its disclosure",
      record(iv0, "homepage rebuilt mid-window") === "1" && ledgerCount(iv0) === "1");

    const bR = mintBaseline("rejected");
    const ivR = register(bR, "rejected");
    q(`select public.reject_intervention('${ivR}','${projectId}','${actor}','not this one');`);
    check("rejected: nothing written", record(ivR, "late") === "0" && ledgerCount(ivR) === "0");
    const bA = mintBaseline("abandoned");
    const ivA = register(bA, "abandoned");
    approve(ivA); implement(ivA);
    q(`select public.abandon_intervention('${ivA}','${projectId}','${actor}','stopped');`);
    check("abandoned: nothing written", record(ivA, "late") === "0" && ledgerCount(ivA) === "0");

    /* ═══════════ 4. validation and tenancy ═══════════ */
    console.log("\n[4] Validation and project scoping");
    check("an empty note is refused by name", (qError(`select public.record_intervention_deviation('${iv1}','${projectId}','${actor}','   ');`) ?? "").includes("deviation_needs_note"));
    check("a null note is refused by name", (qError(`select public.record_intervention_deviation('${iv1}','${projectId}','${actor}',null);`) ?? "").includes("deviation_needs_note"));
    check("a note over 4000 characters is refused by name",
      (qError(`select public.record_intervention_deviation('${iv1}','${projectId}','${actor}',repeat('x',4001));`) ?? "").includes("deviation_note_too_long"));
    check("a note of exactly 4000 characters is accepted",
      q(`select count(*) from public.record_intervention_deviation('${iv1}','${projectId}','${actor}',repeat('y',4000));`) === "1");
    check("a null actor is refused", (qError(`select public.record_intervention_deviation('${iv1}','${projectId}',null,'x');`) ?? "").includes("invalid_record_intervention_deviation_args"));
    const beforeForeign = ledgerCount(iv1);
    check("another project's id finds nothing and writes nothing",
      record(iv1, "cross-tenant", otherProject) === "0" && ledgerCount(iv1) === beforeForeign);

    /* ═══════════ 5. replay ═══════════ */
    console.log("\n[5] A repeated submit does not duplicate");
    const beforeReplay = ledgerCount(iv1);
    check("the same note again returns the row", record(iv1, "Homepage rebuilt on day 5.") === "1");
    check("and inserts nothing", ledgerCount(iv1) === beforeReplay);
    check("surrounding whitespace is the same note", record(iv1, "  Homepage rebuilt on day 5.  ") === "1" && ledgerCount(iv1) === beforeReplay);
    check("a different note is a new row", record(iv1, "Pricing page changed on day 9.") === "1" && ledgerCount(iv1) === String(Number(beforeReplay) + 1));

    console.log("\n[6] A real two-process race on one identical note");
    const raceSql = `select count(*) from public.record_intervention_deviation('${iv0}','${projectId}','${actor}','raced note');`;
    const before = ledgerCount(iv0);
    await Promise.all([0, 1].map(() => new Promise<void>((resolve) => {
      const child = spawn(pgBinary("psql"), psqlArgs(["-tAc", raceSql]), { stdio: "ignore" });
      child.on("exit", () => resolve());
    })));
    check("EXACTLY ONE row was written by the two concurrent submits",
      ledgerCount(iv0) === String(Number(before) + 1), `before=${before} after=${ledgerCount(iv0)}`);

    /* ═══════════ 7. insert-only ═══════════ */
    console.log("\n[7] The ledger cannot be edited or erased");
    const rowId = q(`select id from public.intervention_deviations where intervention_id='${iv1}' order by recorded_at limit 1;`);
    check("UPDATE is refused even for the owner",
      (qError(`update public.intervention_deviations set note='rewritten' where id='${rowId}';`) ?? "").includes("intervention_deviation_is_immutable"));
    check("DELETE is refused even for the owner",
      (qError(`delete from public.intervention_deviations where id='${rowId}';`) ?? "").includes("intervention_deviation_is_immutable"));
    check("TRUNCATE is refused even for the owner",
      (qError(`truncate public.intervention_deviations;`) ?? "").includes("intervention_deviation_is_immutable"));
    check("the note is unchanged afterwards",
      q(`select note from public.intervention_deviations where id='${rowId}';`) === "Homepage rebuilt on day 5.");
    const asService = (sql: string) =>
      spawnSync(pgBinary("psql"), psqlArgs(["-tAc", `set role service_role; ${sql}`]), { encoding: "utf8" }).stderr;
    check("service_role cannot INSERT directly",
      asService(`insert into public.intervention_deviations (intervention_id, project_id, note, recorded_by, retest_attempts_at_record, card_delivered_at_record) values ('${iv1}','${projectId}','forged','${actor}',0,false);`).includes("permission denied"));
    check("service_role cannot UPDATE directly",
      asService(`update public.intervention_deviations set note='x' where id='${rowId}';`).includes("permission denied"));
    check("service_role can still record through the RPC",
      spawnSync(pgBinary("psql"), psqlArgs(["-tAc", `set role service_role; select count(*) from public.record_intervention_deviation('${iv1}','${projectId}','${actor}','via service role');`]), { encoding: "utf8" }).stdout.trim().split(/\r?\n/).pop() === "1");

    /* ═══════════ 8. the state it was written in ═══════════ */
    console.log("\n[8] Notes written after the retest began, and after delivery, say so");
    q(`select public.authorize_early_retest('${iv1}','${projectId}','${actor}','runtime contract needs it now');`);
    const retest = q(`select status_code || ':' || coalesce(retest_protocol_id::text, '') from public.create_retest_protocol('${iv1}','${projectId}','${actor}');`);
    check("fixture: the retest protocol is created", retest.startsWith("CREATED:"), retest);
    const retestId = retest.split(":")[1];
    check("a note recorded before any attempt is stamped 0",
      record(iv1, "after retest created, before any attempt") === "1" &&
      q(`select retest_attempts_at_record from public.intervention_deviations where intervention_id='${iv1}' and note='after retest created, before any attempt';`) === "0");
    check("fixture: one retest attempt is admitted",
      q(`select status from public.admit_and_reserve_attempt('${retestId}','${projectId}','retest','0082-attempt-1',0.01);`) === "RESERVED");
    check("a note recorded after that attempt is stamped 1",
      record(iv1, "after the first retest attempt") === "1" &&
      q(`select retest_attempts_at_record from public.intervention_deviations where intervention_id='${iv1}' and note='after the first retest attempt';`) === "1");

    const artifactId = q(
      `select id from public.save_outcome_card_artifact('${iv1}','${projectId}','${b1}','${retestId}','# Outcome Card',now(),'{"v":1}'::jsonb,'integrity_passed','[]'::jsonb);`
    );
    check("fixture: an Outcome Card is saved", artifactId.length === 36, artifactId);
    check("a note recorded before delivery is stamped not-delivered",
      record(iv1, "after the card was built, before delivery") === "1" &&
      q(`select card_delivered_at_record from public.intervention_deviations where intervention_id='${iv1}' and note='after the card was built, before delivery';`) === "f");
    const revision = q(`select public.outcome_card_artifact_revision('# Outcome Card', '{"v":1}'::jsonb);`);
    const claim = q(`select delivery_claim_token from public.begin_outcome_card_delivery('${iv1}','${artifactId}','${revision}');`);
    check("fixture: the card is delivered",
      qError(`select public.finalize_outcome_card_delivery('${iv1}','${artifactId}','${claim}','msg-0082');`) === null &&
      q(`select delivered_at is not null from public.outcome_card_artifacts where id='${artifactId}';`) === "t");
    check("recording is still accepted after delivery", record(iv1, "found after the customer received the card") === "1");
    check("and that note is stamped as recorded after delivery",
      q(`select card_delivered_at_record from public.intervention_deviations where intervention_id='${iv1}' and note='found after the customer received the card';`) === "t");
    check("the delivered card itself is untouched",
      q(`select payload::text || '|' || (delivered_at is not null)::text from public.outcome_card_artifacts where id='${artifactId}';`) === `{"v": 1}|true`);

    /* ═══════════ 9. the comparison engine's input is not reachable ═══════════ */
    console.log("\n[9] protocol_deviations is never written by this path");
    check("the implementation-time column is still empty on every fixture",
      q(`select count(*) from public.interventions where protocol_deviations is not null;`) === "0");
    check("the intervention row returned by the RPC is otherwise unchanged",
      q(`select status from public.interventions where id='${iv1}';`) === "implemented");

    succeeded = failures === 0;
  } finally {
    if (started) {
      try { execFileSync(pgBinary("pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" }); }
      catch { console.log("warning: the disposable cluster did not stop cleanly."); }
    }
    if (succeeded && existsSync(workdir)) {
      try { rmSync(workdir, { recursive: true, force: true }); } catch { /* left for inspection */ }
    } else {
      console.log(`Left for inspection: ${workdir}`);
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
  console.log("0082 runtime contract PASSED.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
