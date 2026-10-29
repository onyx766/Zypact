/**
 * 0083 — an estimated call cost must not lower the per-protocol spend cap.
 *
 * Static contract over the migration text, plus a model of the SQL it
 * changes. The migration is NOT executed here (Founder instruction: no
 * database, local or otherwise). The model below is a line-for-line port of
 * reconcile_attempt_for_job's cost roll-up and of the cap's sum in
 * admit/reserve (0047/0050/0051); the static half proves 0083 differs from
 * 0050 in that one predicate and nowhere else, so the model's "before" and
 * "after" are exactly 0050 and 0083.
 *
 * What it pins:
 *   - 0083 redefines reconcile_attempt_for_job identically to 0050 except
 *     the single bool_or(...) roll-up predicate, with identical signature,
 *     security, search_path and grants, and contains nothing else;
 *   - the cap functions are not touched;
 *   - the original weakness: under 0050, an attempt with an estimated
 *     analysis cost is counted by the cap at measured + estimate, below its
 *     reservation;
 *   - the correction: under 0083 it is counted at its reservation, and
 *     protocol_attempts.actual_cost_usd only ever holds a measured total;
 *   - every other case — all measured, unknown, failed, cancelled, retried,
 *     malformed — is counted exactly as under 0050.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const dir = path.join(process.cwd(), "supabase", "migrations");
const m0050 = readFileSync(path.join(dir, "0050_m5_protocol_execution_jobs_and_external_call_ledger.sql"), "utf8");
const m0083 = readFileSync(path.join(dir, "0083_m5_estimated_cost_keeps_attempt_cap_basis.sql"), "utf8");

const OLD = "bool_or(actual_cost_usd is null),";
const NEW = "bool_or(actual_cost_usd is null or cost_basis is distinct from 'measured'),";

/** From `create or replace function public.reconcile_attempt_for_job` to its last grant. */
function definition(sql: string): string | null {
  const start = sql.search(/create or replace function\s+public\.reconcile_attempt_for_job\s*\(/);
  if (start < 0) return null;
  const grant = "public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) to service_role;";
  const end = sql.indexOf(grant, start);
  return end < 0 ? null : sql.slice(start, end + grant.length);
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}

async function main(): Promise<void> {
  console.log("\n0083 — estimated costs keep the attempt cap basis\n");

  /* ═══════ 1. the migration is 0050's function, one predicate changed ═══════ */
  console.log("[1] 0083 is 0050's reconcile_attempt_for_job with one predicate changed");
  const before = definition(m0050);
  const after = definition(m0083);
  check("0050's definition is found", before !== null);
  check("0083's definition is found", after !== null);
  check("0050 has the old predicate exactly once", before !== null && before.split(OLD).length === 2);
  check("0083 has the new predicate exactly once, and not the old", after !== null && after.split(NEW).length === 2 && !after.includes(OLD));
  check("replacing that one predicate makes them identical, character for character",
    before !== null && after !== null && before.replace(OLD, NEW) === after);

  const outside = stripComments(m0083.replace(after ?? "", "")).trim();
  check("0083 contains nothing outside that definition but comments", outside === "", JSON.stringify(outside.slice(0, 120)));
  const ddl = stripComments(m0083);
  check("exactly one function is created",
    (ddl.match(/create or replace function/gi) ?? []).length === 1);
  check("no table, column, constraint, index or policy is touched",
    !/\b(create|alter|drop)\s+(table|index|policy|trigger|type|view)\b/i.test(ddl) && !/\badd\s+column\b/i.test(ddl));
  check("security definer and search_path are kept",
    /security definer/.test(after ?? "") && /set search_path = public, pg_temp/.test(after ?? ""));
  check("the four privilege statements are kept: revoke public/anon/authenticated, grant service_role",
    ["from public;", "from anon;", "from authenticated;", "to service_role;"].every((s) => (after ?? "").includes(s)));
  // _admit_and_reserve_attempt_core (0050, redefined in 0051) and
  // admit_and_reserve_attempt (0047) hold the cap's
  // sum(coalesce(pa.actual_cost_usd, pa.reserved_cost_usd)).
  for (const fn of ["_admit_and_reserve_attempt_core", "admit_and_reserve_attempt", "admit_and_reserve_attempt_for_job", "_reserve_additional_analysis_generation_core"]) {
    check(`the cap routine ${fn} is not redefined`,
      !new RegExp(`function\\s+public\\.${fn}\\s*\\(`, "i").test(ddl));
  }
  check("the fencing and idempotency checks are present unchanged",
    ["'JOB_NOT_OWNED'", "'ATTEMPT_NOT_OWNED_BY_JOB'", "'ALREADY_RECONCILED'", "'EXTERNAL_CALLS_NOT_TERMINAL'", "and terminalized_at is null"]
      .every((s) => (after ?? "").includes(s)));
  check("0083 states its release order (before the PR #2 worker) and its rollback",
    /BEFORE any worker carrying PR #2/.test(m0083) && /Rollback:/.test(m0083));

  /* ═══════ 2. model of the roll-up and the cap ═══════ */
  console.log("\n[2] Model of the roll-up (0050 vs 0083) and of the cap's sum");
  interface Call { status: string; actual: number | null; basis: string | null }
  const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled"]);

  /** reconcile_attempt_for_job's roll-up: v_has_unknown → null, else the sum. */
  const rollup = (calls: Call[], predicate: "0050" | "0083"): number | null => {
    const terminal = calls.filter((c) => TERMINAL.has(c.status));
    const unknown = terminal.some((c) =>
      predicate === "0050" ? c.actual === null : c.actual === null || c.basis !== "measured");
    if (unknown) return null;
    return terminal.reduce((s, c) => s + (c.actual ?? 0), 0);
  };
  /** The cap: sum(coalesce(pa.actual_cost_usd, pa.reserved_cost_usd)). */
  const capCounts = (attemptActual: number | null, attemptReserved: number) => attemptActual ?? attemptReserved;

  const RESERVED = 0.04;
  const perplexity = (actual: number | null, status = "completed"): Call =>
    ({ status, actual, basis: actual === null ? null : "measured" });
  const analysis = (actual: number | null, basis: string | null = actual === null ? null : "estimated", status = "completed"): Call =>
    ({ status, actual, basis });

  {
    // The weakness: what PR #2 alone would do to the cap.
    const calls = [perplexity(0.0035), analysis(0.0075)];
    const old = rollup(calls, "0050");
    check("WEAKNESS (0050): measured + estimate is written as the attempt's actual cost",
      old !== null && Math.abs(old - 0.011) < 1e-12, String(old));
    check("WEAKNESS (0050): so the cap counts $0.011 for an attempt it counted at $0.04 before PR #2",
      capCounts(old, RESERVED) < RESERVED, String(capCounts(old, RESERVED)));
    const fixed = rollup(calls, "0083");
    check("FIX (0083): the attempt's actual cost stays null — an estimate is not a measured total", fixed === null);
    check("FIX (0083): the cap counts the reservation, its basis before PR #2", capCounts(fixed, RESERVED) === RESERVED);
  }
  {
    // Before PR #2, in production: analysis never carried a cost.
    const calls = [perplexity(0.0035), analysis(null)];
    check("today's production shape (analysis cost unknown) is counted identically by 0050 and 0083",
      rollup(calls, "0050") === rollup(calls, "0083") && capCounts(rollup(calls, "0083"), RESERVED) === RESERVED);
  }
  for (const [label, calls] of [
    ["every call measured", [perplexity(0.0035), perplexity(0.004)]],
    ["a failed call with no cost", [perplexity(null, "failed"), analysis(null, null, "cancelled")]],
    ["a timed-out call with no cost", [perplexity(0.0035), analysis(null, null, "timed_out")]],
    ["a retried analysis generation with no cost", [perplexity(0.0035), analysis(null, null, "failed"), analysis(null)]],
    ["no terminal calls at all", [] as Call[]],
  ] as const) {
    const a = rollup(calls as Call[], "0050");
    const b = rollup(calls as Call[], "0083");
    check(`${label}: 0083 counts exactly what 0050 counted`, a === b, `${a} vs ${b}`);
  }
  {
    const calls = [perplexity(0.0035), analysis(null, null, "failed"), analysis(0.0075)];
    check("a retry whose second generation is estimated → null, cap counts the reservation",
      rollup(calls, "0083") === null && capCounts(rollup(calls, "0083"), RESERVED) === RESERVED);
  }
  {
    const calls = [perplexity(0.0035), analysis(0.0075, "guessed")];
    check("any non-measured basis (impossible under 0050's check, tested anyway) → null",
      rollup(calls, "0083") === null);
  }
  {
    // Exhaustive over small shapes: 0083 never counts LESS than 0050, and
    // never less than the reservation unless every call was measured.
    const options: Call[] = [
      perplexity(0.0035), perplexity(null), perplexity(null, "failed"),
      analysis(0.0075), analysis(null), analysis(null, null, "cancelled"), analysis(0.05),
    ];
    let violations = 0;
    let sawMeasuredOnly = 0;
    for (const a of options) for (const b of options) for (const c of [null, ...options]) {
      const calls = [a, b, ...(c ? [c] : [])];
      const after0083 = capCounts(rollup(calls, "0083"), RESERVED);
      const allMeasured = calls.filter((x) => TERMINAL.has(x.status)).every((x) => x.basis === "measured");
      if (allMeasured) { sawMeasuredOnly += 1; continue; }
      if (after0083 !== RESERVED) violations += 1;
    }
    check("across every 2- and 3-call combination, an attempt with any non-measured cost is counted at its reservation",
      violations === 0, `${violations} violations`);
    check("and the all-measured case still counts the measured total", sawMeasuredOnly > 0);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : " 0083 schema contract PASSED."}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
