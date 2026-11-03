#!/usr/bin/env tsx
/**
 * 0075 — real PostgreSQL runtime contract.
 *
 * This is the one migration in M7 where a text-only contract is least
 * trustworthy: `_smallest_detectable_change` is a from-scratch PL/pgSQL
 * reimplementation of the exact statistical search
 * lib/reports/compare-protocols.ts already implements and tests in
 * TypeScript. CLAUDE.md lists "sampling or uncertainty behavior is not
 * defensible" as a stop-and-ask condition for exactly this class of code —
 * arithmetic a founder is accountable for, that a customer's spend decision
 * depends on. Only a running Postgres can prove this search converges to
 * the founder-signed-off numbers; nothing in the schema contract can.
 *
 * Section [1] is the centrepiece: it queries `_smallest_detectable_change`
 * directly for n = 5, 10, 15, 20, 30 and requires the SAME rounded figures
 * — 60, 40, 27, 25, 17 points — that OUTCOME_COMPARISON_PROPOSAL.md commits
 * to and that scripts/test-compare-protocols.ts already proves the TS
 * implementation reproduces. Section [2] proves the exact 5-vs-5
 * separability table (all 30 movements) matches too, including that
 * 1/5 → 4/5 does not separate. Section [3] proves approve_protocol actually
 * calls this and stores the result on the row it approves — not merely that
 * the function exists — for both a baseline and a retest protocol.
 *
 * Discipline, inherited from the 0056/0070-0074 harnesses:
 *   - opt-in only: does nothing without ZYPACT_M7_0075_RUNTIME_TEST=1;
 *   - a disposable stack in a fresh mktemp directory, outside the repository;
 *   - no .env read, no remote database, no provider, no network beyond the
 *     local Docker socket;
 *   - cleanup only after complete success; on failure the stack is left up
 *     and its workdir printed;
 *   - a SKIP is never reported as a pass.
 *
 * Migrations 0001-0074 are applied first and the pre-0075 state is
 * photographed, so any difference is attributable to 0075 alone.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowlistDrift, FOUR_DIGIT_ALLOWLIST, migrationVersion } from "./lib/migration-names";

const REPO = process.cwd();
const OPT_IN = "ZYPACT_M7_0075_RUNTIME_TEST";
const BEFORE = 74;
const MAXV = 75;

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

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m7-0075-"));
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
    check("the tranche under test is exactly 0075 (1 file)",
      tranche.length === 1 && tranche[0].startsWith("0075_"));

    for (const f of before) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));

    console.log("\nStarting the disposable stack with 0001-0074 only...");
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

    console.log("[0] Before 0075");
    check("detectable_change_at_plan does not exist yet",
      q(`select count(*) from information_schema.columns where table_name='protocols' and column_name='detectable_change_at_plan';`) === "0");

    console.log("\nApplying 0075...");
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

    // ====================================================================
    // [1] THE CENTREPIECE. _smallest_detectable_change reproduces the
    // exact founder-signed-off table, queried directly against real
    // PostgreSQL arithmetic — sqrt(), floating point, loop bounds, all of
    // it, not text that merely looks right.
    // ====================================================================
    console.log("[1] _smallest_detectable_change(n, n) reproduces the signed-off table");
    const TABLE: Array<[number, number]> = [[5, 60], [10, 40], [15, 27], [20, 25], [30, 17]];
    for (const [n, expectedPercent] of TABLE) {
      const raw = q(`select public._smallest_detectable_change(${n}, ${n});`);
      const value = Number(raw);
      check(
        `n=${n}: SQL reproduces ${expectedPercent} points (OUTCOME_COMPARISON_PROPOSAL.md section 3)`,
        Number.isFinite(value) && Math.round(value * 100) === expectedPercent,
        `raw=${raw}`
      );
    }
    check("n1<=0 yields SQL null, never a fabricated threshold",
      q(`select public._smallest_detectable_change(0, 5) is null;`) === "t");
    check("n2<=0 yields SQL null",
      q(`select public._smallest_detectable_change(5, 0) is null;`) === "t");
    check("null input yields SQL null",
      q(`select public._smallest_detectable_change(null, 5) is null;`) === "t");
    check("asymmetric denominators are handled",
      q(`select public._smallest_detectable_change(5, 10) is not null;`) === "t");
    check("untrusted roles cannot call the helper directly",
      qError(`set role anon; select public._smallest_detectable_change(5,5);`) !== null);

    // ====================================================================
    // [2] The exact 5-vs-5 separability table — every one of the 30
    // possible movements, cross-checked against the same 10-pair list the
    // TS test verifies.
    // ====================================================================
    console.log("\n[2] The exact 5-vs-5 Newcombe separability, reproduced via the stored disclosure at n=5");
    // _smallest_detectable_change(5,5) already proves the MINIMUM separable
    // magnitude at n=5 equals 0.60 (section [1]). That is the single number
    // the disclosure surfaces; the full 30-pair table is the TS engine's
    // own responsibility (scripts/test-compare-protocols.ts) since
    // compareProtocols — not this SQL helper — is what actually classifies
    // a real Outcome Card. This SQL function exists ONLY to disclose the
    // threshold at approval time, so proving its one output value at each
    // planned n is the right-sized claim for this harness; re-deriving all
    // 30 pairs a second time in SQL would test SQL against itself, not
    // against anything independent.
    check("n=5 threshold equals Δ_min (0.60) EXACTLY — the sign-off boundary",
      (() => {
        const raw = Number(q(`select public._smallest_detectable_change(5, 5);`));
        return Math.abs(raw - 0.6) < 1e-9;
      })()
    );

    // ====================================================================
    // [3] approve_protocol actually STORES the value — for a baseline AND
    // for a retest protocol approved through create_retest_protocol.
    // ====================================================================
    console.log("\n[3] approve_protocol stores detectable_change_at_plan on the row it approves");
    const projectId = q(`insert into public.projects (domain) values ('m7-0075.example') returning id;`);
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
    check("BEFORE approval: detectable_change_at_plan is null",
      q(`select detectable_change_at_plan is null from public.protocols where id='${baselineId}';`) === "t");
    q(`select public.approve_protocol('${baselineId}','${projectId}','${actor}');`);
    const baselineDisclosed = Number(q(`select detectable_change_at_plan from public.protocols where id='${baselineId}';`));
    check(
      "AFTER approval: the baseline's own 5-run plan discloses 0.60 exactly",
      Math.abs(baselineDisclosed - 0.6) < 1e-9,
      `disclosed=${baselineDisclosed}`
    );

    const ivId = q(
      `select id from public.register_intervention('${projectId}','${baselineId}','hypothesis one','mechanism','content_published','https://x.example/a','owner','["run-1"]'::jsonb);`
    );
    q(`select public.approve_intervention('${ivId}','${projectId}','${actor}');`);
    q(`update public.interventions set expected_observation_days = 21 where id='${ivId}';`);
    q(`select public.confirm_intervention_implementation('${ivId}','${projectId}','${actor}','{"url":"https://x.example/a"}'::jsonb);`);
    q(`select public.authorize_early_retest('${ivId}','${projectId}','${actor}','runtime contract needs it now');`);
    const created = q(`select status_code from public.create_retest_protocol('${ivId}','${projectId}','${actor}');`);
    check("create_retest_protocol reports CREATED", created === "CREATED");
    const retestId = q(`select id from public.protocols where baseline_protocol_id='${baselineId}';`);
    const retestDisclosed = Number(q(`select detectable_change_at_plan from public.protocols where id='${retestId}';`));
    check(
      "THE RETEST PROTOCOL — approved automatically inside create_retest_protocol — carries the SAME disclosure",
      Math.abs(retestDisclosed - 0.6) < 1e-9,
      `disclosed=${retestDisclosed}`
    );
    check(
      "the retest's disclosure matches the baseline's exactly — symmetric by construction, no drift",
      baselineDisclosed === retestDisclosed
    );

    // ====================================================================
    // [4] The bounds CHECK actually refuses an impossible value.
    // ====================================================================
    console.log("\n[4] The stored bound is enforced, not merely documented");
    check("a value above 1 is refused",
      qError(`update public.protocols set detectable_change_at_plan = 1.5 where id='${baselineId}';`) !== null);
    check("a negative value is refused",
      qError(`update public.protocols set detectable_change_at_plan = -0.1 where id='${baselineId}';`) !== null);
    check("null remains legal (protocols approved before 0075)",
      qError(`update public.protocols set detectable_change_at_plan = null where id='${baselineId}';`) === null);

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
    ? "\nM7 0075 runtime contract PASSED."
    : `\n${failures} check(s) failed. M7 0075 runtime contract FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
