#!/usr/bin/env tsx
/**
 * Static contract for 0075 — power shown at approval.
 *
 * The central assertion here is differential, exactly like 0070's: strip
 * the ONE new SET clause this migration adds to approve_protocol's UPDATE,
 * and the remainder of the function body must reproduce 0049's original
 * body EXACTLY. A contract that only checked "the new clause is present"
 * would pass just as happily if the rewrite had also dropped a guard,
 * reordered a check, or weakened the ACL.
 *
 * What this file CANNOT verify — because it is text-only — is that
 * `_smallest_detectable_change` actually computes the right numbers. That is
 * exactly the class of bug the 0073 run-count error was: 67 passing text
 * checks, one migration that could never execute. The runtime contract
 * (test-m7-0075-runtime-contract.ts) is not optional polish here; it is the
 * only thing that can prove this arithmetic against a real database.
 *
 * Text-only. No database, no network.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const NEW_FILE = "0075_m7_detectable_change_at_approval.sql";
const OLD_FILE = "0049_m4_fix_protocol_rpc_status_ambiguities.sql";

const rawNew = readFileSync(path.join(MIGRATIONS, NEW_FILE), "utf8");
const rawOld = readFileSync(path.join(MIGRATIONS, OLD_FILE), "utf8");

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}
function flat(sql: string): string {
  return stripComments(sql).replace(/\s+/g, " ").trim();
}
function fnBody(sql: string, name: string): string {
  const m = flat(sql).match(
    new RegExp(`create or replace function\\s+public\\.${name}[\\s\\S]*?\\$\\$;`, "i")
  );
  return m ? m[0] : "";
}

const newApprove = fnBody(rawNew, "approve_protocol");
const oldApprove = fnBody(rawOld, "approve_protocol");
const helper = fnBody(rawNew, "_smallest_detectable_change");

/* ═══════════════ 1. identity and placement ═══════════════ */
{
  console.log("\n[1] The migration is where and what it claims to be");

  assert("0075 defines approve_protocol exactly once", newApprove !== "");
  assert("0049 is still readable as the prior definition", oldApprove !== "");
  assert("0075 defines the new helper exactly once", helper !== "");

  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => ({ f, n: Number(f.slice(0, 4)) }))
    .sort((a, b) => a.n - b.n);
  assert("0075 is present in the ledger", files.some((x) => x.f === NEW_FILE));

  const definers = files.filter((x) =>
    /create\s+(or\s+replace\s+)?function\s+public\.approve_protocol\s*\(/i.test(
      stripComments(readFileSync(path.join(MIGRATIONS, x.f), "utf8"))
    )
  );
  assert(
    "0075 is the LAST migration to define approve_protocol",
    definers.length > 0 && definers[definers.length - 1].f === NEW_FILE,
    definers.map((d) => d.f).join(" -> ")
  );

  for (const { f, n } of files.filter((x) => x.n > 75)) {
    const sql = stripComments(readFileSync(path.join(MIGRATIONS, f), "utf8"));
    assert(
      `${f} leaves approve_protocol alone`,
      !/create\s+(or\s+replace\s+)?function[\s\S]{0,120}?approve_protocol\s*\(/i.test(sql),
      String(n)
    );
  }
}

/* ═══════════════ 2. the differential assertion ═══════════════ */
{
  console.log("\n[2] Exactly one clause added; nothing else changed");

  const NEEDLE =
    "detectable_change_at_plan = public._smallest_detectable_change( pr.planned_baseline_runs, pr.planned_baseline_runs ), ";

  assert("the new SET clause is present", newApprove.includes(NEEDLE.trim().replace(/\s+/g, " ")) ||
    /detectable_change_at_plan = public\._smallest_detectable_change\(\s*pr\.planned_baseline_runs,\s*pr\.planned_baseline_runs\s*\),/i.test(newApprove));

  const reverted = newApprove.replace(
    /detectable_change_at_plan = public\._smallest_detectable_change\(\s*pr\.planned_baseline_runs,\s*pr\.planned_baseline_runs\s*\),\s*/i,
    ""
  );
  assert(
    "reverting that ONE clause reproduces 0049's approve_protocol EXACTLY",
    reverted === oldApprove,
    reverted === oldApprove ? "" : `lengths ${reverted.length} vs ${oldApprove.length}`
  );

  assert(
    "the new clause is computed on the row BEING approved, not some other row",
    /public\._smallest_detectable_change\(\s*pr\.planned_baseline_runs, pr\.planned_baseline_runs\s*\)/i.test(newApprove)
  );
  assert(
    "symmetric n vs n — no baseline/retest branch inside approve_protocol",
    !/baseline_protocol_id/i.test(newApprove)
  );
}

/* ═══════════════ 3. every original guard survives ═══════════════ */
{
  console.log("\n[3] approve_protocol's original guards are all still present");

  for (const [label, needle] of [
    ["argument validation", "invalid_approve_protocol_args"],
    ["not-found short-circuit", "'NOT_FOUND'"],
    ["already-approved is idempotent, not an error", "'ALREADY_APPROVED'"],
    ["abandoned protocols are refused", "'CONFLICT'"],
    ["the question version must itself be approved first", "'VERSION_NOT_APPROVED'"],
    ["only a draft protocol transitions", "pr.status = 'draft'"],
    ["the row is locked before mutation", "for update"],
    ["tenant scoping on the lookup", "p.project_id = p_project_id"],
  ] as const) {
    assert(label, newApprove.includes(needle));
  }

  assert("the signature is unchanged, so grants survive create-or-replace",
    /approve_protocol\(\s*p_protocol_id uuid, p_project_id uuid, p_approved_by uuid\s*\)/i
      .test(newApprove.replace(/\s+/g, " ")));
}

/* ═══════════════ 4. the column ═══════════════ */
{
  console.log("\n[4] detectable_change_at_plan");

  const sql = flat(rawNew);
  assert("the column is added, nullable, double precision",
    /add column if not exists detectable_change_at_plan double precision null/i.test(sql));
  assert("a bounds CHECK exists: null, or in [0,1]",
    /protocols_detectable_change_bounds_check/.test(sql) &&
    /detectable_change_at_plan is null or \(detectable_change_at_plan >= 0 and detectable_change_at_plan <= 1\)/i.test(sql));
  assert("no existing protocol row is touched — additive only",
    !/update public\.protocols\s+set\s+detectable_change_at_plan/i.test(sql.replace(newApprove, "")));
}

/* ═══════════════ 5. the helper: privileges and shape ═══════════════ */
{
  console.log("\n[5] _smallest_detectable_change");

  assert("immutable — pure function of its two arguments", /immutable/i.test(helper));
  assert("search_path pinned", /set search_path = public, pg_temp/i.test(helper));
  assert("null/non-positive n yields null, not a crash or a fabricated 0",
    /p_n1 is null or p_n2 is null or p_n1 <= 0 or p_n2 <= 0/i.test(helper) &&
    /return null/i.test(helper));
  assert("uses the same WILSON_Z as lib/reports/build-protocol-report.ts",
    /1\.959963984540054/.test(helper));
  assert("squares by direct multiplication, not power(), matching the TS file's x ** 2",
    !/power\(/i.test(helper));

  const sql = flat(rawNew);
  assert("revoked from untrusted roles",
    /revoke all on function public\._smallest_detectable_change\(integer, integer\) from public, anon, authenticated/i.test(sql));
  assert("granted to service_role",
    /grant execute on function public\._smallest_detectable_change\(integer, integer\) to service_role/i.test(sql));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, string, string, (s: string) => boolean]> = [
    [
      "dropping the disclosure write",
      "detectable_change_at_plan = public._smallest_detectable_change( pr.planned_baseline_runs, pr.planned_baseline_runs ),",
      "",
      (s) => !/detectable_change_at_plan = public\._smallest_detectable_change/i.test(s),
    ],
    [
      "computing against the wrong protocol's plan",
      "pr.planned_baseline_runs, pr.planned_baseline_runs",
      "v_row.planned_baseline_runs, v_row.planned_baseline_runs",
      (s) => !/public\._smallest_detectable_change\(\s*pr\.planned_baseline_runs, pr\.planned_baseline_runs\s*\)/i.test(s),
    ],
    [
      "losing the VERSION_NOT_APPROVED guard",
      "'VERSION_NOT_APPROVED'",
      "'OOPS'",
      (s) => !/'VERSION_NOT_APPROVED'/.test(s),
    ],
    [
      "widening the helper's ACL",
      "revoke all on function public._smallest_detectable_change(integer, integer) from public, anon, authenticated;",
      "",
      (s) => !/revoke all on function public\._smallest_detectable_change\(integer, integer\) from public, anon, authenticated/i.test(s),
    ],
  ];

  for (const [label, needle, replacement, detects] of mutations) {
    const mutated = flat(rawNew).replace(needle, replacement);
    assert(`the mutation "${label}" actually changes the SQL`, mutated !== flat(rawNew));
    assert(`…and a detector refuses it`, detects(mutated));
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nM7 0075 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0075 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
