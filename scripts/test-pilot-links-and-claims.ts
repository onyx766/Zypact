#!/usr/bin/env tsx
/**
 * D-060 — an earlier shared pilot report link stops working (D-059 item 9),
 * and the unscoped protocol claims are revoked, offline.
 *
 *   L  the migration 20261109170000_pilot_links_and_claim_scope.sql: inside
 *      the D-058 numbering window, directly after pilot actions; it
 *      redefines exactly one function, read_shared_pilot_report, with the
 *      same signature, output columns, SECURITY DEFINER, STABLE and pinned
 *      search_path; its body is 20261109150000's byte for byte apart from
 *      the marked D-060 block, which withholds the payload exactly when the
 *      flag says a later revision has been shared; its grants are restated;
 *   C  the revokes name exactly the two unscoped claim signatures, from
 *      service_role, with the public, anon and authenticated revokes
 *      restated; neither claim is created, replaced, dropped or altered (the
 *      M5 [2b] patterns); the requested claim is untouched; the pre- and
 *      postconditions are there, each guard's condition pinned exactly (the
 *      database suite also makes each one refuse); no live code path calls
 *      either claim;
 *   N  nothing else is created, changed or dropped, no row is written, and
 *      the header carries the recovery notes;
 *   A  the app, run for real against fake clients: the client read is
 *      three-way (current, replaced, not found) and passes no payload for a
 *      replaced link even if one comes back; the founder's list and preview
 *      mark a replaced revision and show no link for it; the preview's
 *      status line and both share-time notes say the earlier link stops
 *      working; the list keeps the one link that opens even when it is older
 *      than the ten newest revisions;
 *   D  the decisions, the gate note, the runbooks, the preflight and the
 *      wiring.
 *
 * No database, no network. The customer's page itself is called for real in
 * scripts/test-pilot-report.ts (T13 to T16).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseMigrationName } from "./lib/migration-names";
import { STALE_REVISION_WORDS } from "@/lib/pilots/action-copy";
import {
  BLOCKED_REVISION_PREVIEW_WORDS,
  NOT_LATEST_REVISION_PREVIEW_WORDS,
  OLDER_SHARED_REVISION_WORDS,
  PREVIEW_SHARE_NOTE_WORDS,
  previewStatusWords,
  REPLACED_REVISION_PREVIEW_WORDS,
  SHARED_REVISION_PREVIEW_WORDS,
  SHARING_ENDS_EARLIER_LINK_WORDS,
} from "@/lib/reports/pilot-report-copy";
import {
  listPilotReportRevisions,
  readPilotReportRevision,
  readSharedPilotReport,
} from "@/lib/reports/process-pilot-report";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (p: string) => readFileSync(p, "utf8");
const stripComments = (sql: string) =>
  sql.split("\n").map((line) => (line.indexOf("--") === -1 ? line : line.slice(0, line.indexOf("--")))).join("\n");
const flat = (t: string) => t.replace(/\s+/g, " ").trim();

console.log("test-pilot-links-and-claims");

/* ---------------------------------------------------------------- L */

const DIR = "supabase/migrations";
const FILE = "20261109170000_pilot_links_and_claim_scope.sql";
const MIG = read(path.join(DIR, FILE));
const OLD = read(path.join(DIR, "20261109150000_pilot_report_artifacts.sql"));
const CODE = stripComments(MIG);

const parsed = parseMigrationName(FILE);
const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok).map((r) => (r.ok ? r.version : 0));
const version = parsed.ok ? parsed.version : 0;
check("L1 the version is inside the D-058 window (after 20261109160000, before 20261110120000) and directly follows pilot actions",
  parsed.ok && parsed.kind === "timestamp" && version > 20261109160000 && version < 20261110120000 &&
  versions.includes(20261109160000) && versions.includes(20261110120000) &&
  !versions.some((v) => v > 20261109160000 && v < version));
check("L2 nothing from the account stack is referenced (it applies before P1)",
  !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_s1_[a-z_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(CODE));

const defined = [...CODE.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_.0-9]+)\s*\(/gi)].map((m) => m[1]);
const fnText = (sql: string) => {
  const s = sql.indexOf("create or replace function public.read_shared_pilot_report(");
  return s < 0 ? "" : sql.slice(s, sql.indexOf("\n$$;", s) + 4);
};
const NEW_READ = fnText(MIG);
const OLD_READ = fnText(OLD);
const headerOf = (t: string) => t.slice(0, t.indexOf("as $$\n") + "as $$\n".length);
check("L3 exactly one function is defined: read_shared_pilot_report, with 20261109150000's signature and output columns",
  defined.join(",") === "public.read_shared_pilot_report" && NEW_READ !== "" && OLD_READ !== "" &&
  headerOf(NEW_READ) === headerOf(OLD_READ) &&
  /returns table \(\n  payload jsonb,\n  revision integer,\n  generated_at timestamptz,\n  shared_at timestamptz,\n  newer_shared_revision boolean\n\)/.test(headerOf(NEW_READ)),
  defined.join(","));
check("L4 it stays SQL, SECURITY DEFINER and STABLE with the pinned search_path",
  /\nlanguage sql\nsecurity definer\nstable\nset search_path = public, pg_temp\nas \$\$\n$/.test(headerOf(NEW_READ)));

const ORIGINAL_FIRST_LINE = "  select a.payload, a.revision, a.generated_at, a.shared_at,\n";
const END_MARKER = "  -- D-060 end\n";
const bStart = NEW_READ.indexOf("  -- D-060 begin");
const bEnd = NEW_READ.indexOf(END_MARKER);
const BLOCK = bStart > 0 && bEnd > bStart ? NEW_READ.slice(bStart, bEnd + END_MARKER.length) : "";
const restored = BLOCK ? NEW_READ.slice(0, bStart) + ORIGINAL_FIRST_LINE + NEW_READ.slice(bEnd + END_MARKER.length) : "";
check("L5 its body is 20261109150000's byte for byte apart from the one marked D-060 block, which takes the place of the original first select line",
  BLOCK !== "" && restored === OLD_READ && OLD_READ.includes(ORIGINAL_FIRST_LINE) && !NEW_READ.includes(ORIGINAL_FIRST_LINE) &&
  NEW_READ.split("-- D-060 begin").length === 2 && NEW_READ.split("-- D-060 end").length === 2,
  `${restored.length} vs ${OLD_READ.length}`);
const FLAG_TEST = "exists ( select 1 from public.pilot_report_artifacts b where b.pilot_id = a.pilot_id and b.revision > a.revision and b.shared_at is not null)";
const blockCode = flat(stripComments(BLOCK));
check("L6 the block withholds the payload exactly when the flag is true: the same test, then NULL, else the payload, then the other columns in order",
  flat(OLD_READ).includes(FLAG_TEST) &&
  blockCode === `select case when ${FLAG_TEST} then null::jsonb else a.payload end, a.revision, a.generated_at, a.shared_at,`, blockCode);
const READ_GRANTS = [
  "revoke all on function public.read_shared_pilot_report(text) from public;",
  "revoke all on function public.read_shared_pilot_report(text) from anon;",
  "revoke all on function public.read_shared_pilot_report(text) from authenticated;",
  "grant execute on function public.read_shared_pilot_report(text) to service_role;",
];
check("L7 the read's four privilege lines are restated exactly as 20261109150000 wrote them, right after the definition",
  READ_GRANTS.every((l) => OLD.includes(l) && CODE.includes(l)) &&
  CODE.indexOf(READ_GRANTS[0]) > CODE.indexOf("create or replace function public.read_shared_pilot_report(") &&
  CODE.includes(`$$;\n\n${READ_GRANTS.join("\n")}\n`));
check("L8 an unshared, blocked or malformed-token revision still reads nothing (the inherited where clause)",
  /where p_public_token ~ '\^\[0-9a-f\]\{64\}\$'\n     and a\.public_token = p_public_token\n     and a\.shared_at is not null\n     and a\.integrity_status <> 'blocked';\n\$\$;$/.test(NEW_READ));

/* ---------------------------------------------------------------- C */

const CLAIM = "public.claim_protocol_execution_job(text, integer)";
const CLAIM_BY_ID = "public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)";
const revokes = [...CODE.matchAll(/revoke\s+(all|execute)\s+on\s+function\s+([\s\S]*?)\s+from\s+([a-z_]+)\s*;/gi)]
  .map((m) => ({ fn: flat(m[2]), role: m[3] }));
const svcRevokes = revokes.filter((r) => r.role === "service_role").map((r) => r.fn).sort();
check("C1 the service_role revokes name exactly the two unscoped claim signatures",
  JSON.stringify(svcRevokes) === JSON.stringify([CLAIM, CLAIM_BY_ID].sort()), JSON.stringify(svcRevokes));
const V0054 = read(path.join(DIR, "0054_m5_worker_probe_result_and_alert_outbox.sql"));
const V0059 = read(path.join(DIR, "0059_m5_phase3d_targeted_claim.sql"));
check("C2 their public, anon and authenticated revokes are restated exactly as 0054 and 0059 wrote them, and none is granted back",
  ["public", "anon", "authenticated", "service_role"].every((role) =>
    CODE.includes(`revoke all on function\n  ${CLAIM} from ${role};`) && CODE.includes(`revoke all on function\n  ${CLAIM_BY_ID} from ${role};`)) &&
  ["public", "anon", "authenticated"].every((role) =>
    V0054.includes(`revoke all on function\n  ${CLAIM} from ${role};`) && V0059.includes(`revoke all on function\n  ${CLAIM_BY_ID} from ${role};`)) &&
  V0054.includes(`grant execute on function\n  ${CLAIM} to service_role;`) && V0059.includes(`grant execute on function\n  ${CLAIM_BY_ID} to service_role;`));
const grants = [...CODE.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => flat(m[0]));
check("C3 the only grant is the read's to service_role",
  JSON.stringify(grants) === JSON.stringify([READ_GRANTS[3]]), JSON.stringify(grants));
// The guards of scripts/test-m5-0059-schema-contract.ts and
// scripts/test-m5-0060-schema-contract.ts [2b], applied here too.
const touches = (sql: string, name: string) =>
  new RegExp(`(create\\s+(or\\s+replace\\s+)?function|drop\\s+function|alter\\s+function)[\\s\\S]{0,120}?${name}\\s*\\(`, "i").test(sql);
check("C4 neither claim, nor the job context function, is created, replaced, dropped or altered (the M5 [2b] patterns), and no comment names a definition of one",
  ["claim_protocol_execution_job", "claim_protocol_execution_job_by_id", "get_protocol_execution_job_context"].every((n) => !touches(CODE, n)) &&
  [...MIG.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/gi)].every((m) => m[1] === "read_shared_pilot_report"));
check("C5 the requested claim, the live worker's, is not revoked",
  !revokes.some((r) => r.fn.includes("claim_requested_protocol_execution_job")));
const pre = CODE.slice(CODE.indexOf("do $pre$"), CODE.indexOf("$pre$;"));
const post = CODE.slice(CODE.indexOf("do $post$"), CODE.indexOf("$post$;"));
check("C6 the precondition refuses unless the read, its columns, both claims and an executable requested claim exist; it runs before any change",
  CODE.indexOf("do $pre$") >= 0 && CODE.indexOf("do $pre$") < CODE.indexOf("create or replace function") &&
  pre.includes("to_regclass('public.pilot_report_artifacts') is null") &&
  pre.includes("to_regprocedure('public.read_shared_pilot_report(text)') is null") &&
  pre.includes("'TABLE(payload jsonb, revision integer, generated_at timestamp with time zone, shared_at timestamp with time zone, newer_shared_revision boolean)'") &&
  pre.includes(`to_regprocedure('${CLAIM}') is null`) && pre.includes(`to_regprocedure('${CLAIM_BY_ID}') is null`) &&
  pre.includes("not has_function_privilege('service_role', 'public.claim_requested_protocol_execution_job(text, integer)', 'execute')") &&
  (pre.match(/raise exception/g) ?? []).length === 4);
check("C7 the postcondition refuses unless no API role can call either claim, the requested claim and the read stay service_role's, and the read keeps its definition flags; it runs after every change",
  CODE.indexOf("do $post$") > CODE.lastIndexOf("revoke all on function") &&
  post.includes("array['service_role', 'anon', 'authenticated']") &&
  post.includes(`has_function_privilege(v_role, '${CLAIM}', 'execute')`) && post.includes(`has_function_privilege(v_role, '${CLAIM_BY_ID}', 'execute')`) &&
  post.includes("not has_function_privilege('service_role', 'public.claim_requested_protocol_execution_job(text, integer)', 'execute')") &&
  post.includes("not has_function_privilege('service_role', 'public.read_shared_pilot_report(text)', 'execute')") &&
  /p\.prosecdef\s+and p\.provolatile = 's'\s+and p\.proconfig = array\['search_path=public, pg_temp'\]::text\[\]/.test(post) &&
  (post.match(/raise exception/g) ?? []).length === 4);
// Each guard's condition exactly, flattened: an `or` turned into an `and`
// changes the text here. scripts/test-pilot-links-and-claims-db.ts makes
// each guard refuse on a real database.
const conditions = (block: string) => [...block.matchAll(/\bif\s+([\s\S]*?)\s+then\b/g)].map((m) => flat(m[1]));
const REQUESTED_FN = "public.claim_requested_protocol_execution_job(text, integer)";
const READ_FN = "public.read_shared_pilot_report(text)";
const PRE_CONDITIONS = [
  `to_regclass('public.pilot_report_artifacts') is null or to_regprocedure('${READ_FN}') is null`,
  `pg_get_function_result('${READ_FN}'::regprocedure) is distinct from 'TABLE(payload jsonb, revision integer, generated_at timestamp with time zone, shared_at timestamp with time zone, newer_shared_revision boolean)'`,
  `to_regprocedure('${CLAIM}') is null or to_regprocedure('${CLAIM_BY_ID}') is null`,
  `to_regprocedure('${REQUESTED_FN}') is null or not has_function_privilege('service_role', '${REQUESTED_FN}', 'execute')`,
];
const POST_CONDITIONS = [
  `has_function_privilege(v_role, '${CLAIM}', 'execute') or has_function_privilege(v_role, '${CLAIM_BY_ID}', 'execute')`,
  `not has_function_privilege('service_role', '${REQUESTED_FN}', 'execute')`,
  `not has_function_privilege('service_role', '${READ_FN}', 'execute') or has_function_privilege('anon', '${READ_FN}', 'execute') or has_function_privilege('authenticated', '${READ_FN}', 'execute')`,
  `not exists ( select 1 from pg_proc p where p.oid = '${READ_FN}'::regprocedure and p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=public, pg_temp']::text[])`,
];
check("C6b the four preconditions are exactly these conditions, in this order",
  JSON.stringify(conditions(pre)) === JSON.stringify(PRE_CONDITIONS), JSON.stringify(conditions(pre)));
check("C7b the four postconditions are exactly these conditions, in this order, the first inside the loop over the three API roles",
  JSON.stringify(conditions(post)) === JSON.stringify(POST_CONDITIONS) &&
  /foreach v_role in array array\['service_role', 'anon', 'authenticated'\] loop\s+if has_function_privilege\(v_role,/.test(post),
  JSON.stringify(conditions(post)));

/** Every .ts/.tsx file under these roots, test scripts excluded. */
function sources(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const name of readdirSync(p)) {
      const full = path.join(p, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !/^scripts\/test-/.test(full)) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}
const LIVE = sources(["app", "lib", "components", "scripts"]).concat(["middleware.ts"].filter((f) => { try { return statSync(f).isFile(); } catch { return false; } }));
// A quoted RPC name, or a call of the adapter method (a definition has no dot).
const CALLS = /["'`]claim_protocol_execution_job(_by_id)?["'`]|\.claimProtocolExecutionJob(ById)?\(/;
const callers = LIVE.filter((f) => CALLS.test(read(f))).sort();
// The adapters define the RPC calls; the worker loop reaches the global one
// only for claimScope "global", which no live entry point sets.
const ALLOWED_CALLERS = ["lib/db/memory-adapter.ts", "lib/db/supabase-adapter.ts", "lib/protocol-worker/worker.ts"];
check("C8 no live code path calls either unscoped claim: only the adapters and the worker loop's harness branch name them (the scan finds both known sites)",
  callers.every((f) => ALLOWED_CALLERS.includes(f)) &&
  callers.includes("lib/db/supabase-adapter.ts") && callers.includes("lib/protocol-worker/worker.ts") &&
  /rpc\("claim_protocol_execution_job"/.test(read("lib/db/supabase-adapter.ts")) && /rpc\("claim_protocol_execution_job_by_id"/.test(read("lib/db/supabase-adapter.ts")) &&
  !/claimProtocolExecutionJobById\(/.test(read("lib/protocol-worker/worker.ts")),
  callers.join(","));
const worker = read("lib/protocol-worker/worker.ts");
const runner = read("scripts/run-protocol-worker.ts");
check("C9 the live runner claims through the requested claim only, and the loop calls the global one only when told to",
  /claimScope: "requested",/.test(runner) && !/claimScope: "global"/.test(runner) &&
  LIVE.filter((f) => /claimScope:\s*"global"/.test(read(f))).length === 0 &&
  /opts\.claimScope === "requested"\s*\?\s*await deps\.db\.claimRequestedProtocolExecutionJob\(/.test(worker));

/* ---------------------------------------------------------------- N */

check("N1 nothing else: no table, index, trigger, policy, view, type, sequence, schema or extension; nothing altered, dropped, commented or truncated; no row written",
  !/\bcreate\s+(unique\s+)?(table|index|trigger|policy|view|materialized|type|sequence|schema|extension|rule|domain)\b/i.test(CODE) &&
  !/\b(alter|drop|truncate|comment\s+on|insert\s+into|delete\s+from|security\s+invoker)\b/i.test(CODE) &&
  !/\bupdate\s+public\./i.test(CODE) && !/\bbegin\s*;|\bcommit\b|\brollback\b/i.test(CODE));
/** The header's comment text as flowing prose, so a phrase may wrap. */
const HEADER = flat(MIG.slice(0, MIG.indexOf("do $pre$")).split("\n").map((l) => l.replace(/^--\s?/, "")).join(" "));
const HEADER_PHRASES = ["D-059", "D-060", "expected_prev 20261109160000", "Preconditions", "Postconditions", "Rollback / forward recovery",
  "re-run 20261109150000 section 5",
  `grant execute on function ${CLAIM} to service_role;`, `grant execute on function ${CLAIM_BY_ID} to service_role;`,
  "the table is append-only", "0085"];
check("N2 the header names the decisions, the order, the pre- and postconditions and both recovery steps",
  HEADER_PHRASES.every((t) => HEADER.includes(t)), HEADER_PHRASES.filter((t) => !HEADER.includes(t)).join(" | "));

/* ---------------------------------------------------------------- A */

type Row = Record<string, unknown>;
const PILOT = "22222222-2222-4222-8222-222222222222";
const tok = (n: number) => String(n).repeat(64).slice(0, 64);
function rpcClient(data: unknown): SupabaseClient {
  return { rpc: async () => ({ data, error: null }) } as unknown as SupabaseClient;
}
/** A fake of the few query-builder calls the founder's reads make, over in-memory rows. */
function tableClient(rows: Row[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "pilot_report_artifacts") throw new Error(`unexpected table ${table}`);
      let out = rows.map((r) => ({ ...r }));
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (c: string, v: unknown) => { out = out.filter((r) => r[c] === v); return q; },
        gt: (c: string, v: number) => { out = out.filter((r) => Number(r[c]) > v); return q; },
        not: (c: string, op: string, v: unknown) => {
          if (op !== "is" || v !== null) throw new Error("unexpected not()");
          out = out.filter((r) => r[c] !== null && r[c] !== undefined);
          return q;
        },
        order: (c: string, o: { ascending: boolean }) => { out.sort((a, b) => (Number(a[c]) - Number(b[c])) * (o.ascending ? 1 : -1)); return q; },
        limit: (n: number) => { out = out.slice(0, n); return q; },
        maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve({ data: out, error: null }).then(ok, ko),
      });
      return q;
    },
  } as unknown as SupabaseClient;
}
const artifact = (revision: number, shared: boolean, status = "integrity_passed"): Row => ({
  id: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
  pilot_id: PILOT,
  revision,
  generated_at: "2026-11-20T09:00:00Z",
  integrity_status: status,
  integrity_reasons: status === "integrity_passed" ? [] : ["A reason."],
  shared_at: shared ? `2026-11-2${revision}T10:00:00Z` : null,
  public_token: tok(revision),
  manifest: { protocols: [], attempts: [] },
  payload: { pilotId: PILOT },
});

const aDone = (async () => {
  const PAYLOAD = { pilotId: PILOT };
  const current = await readSharedPilotReport(rpcClient([{ payload: PAYLOAD, revision: 5, generated_at: "g", shared_at: "s", newer_shared_revision: false }]), tok(5));
  const replaced = await readSharedPilotReport(rpcClient([{ payload: null, revision: 3, generated_at: "g", shared_at: "s", newer_shared_revision: true }]), tok(3));
  const replacedWithPayload = await readSharedPilotReport(rpcClient([{ payload: PAYLOAD, revision: 3, generated_at: "g", shared_at: "s", newer_shared_revision: true }]), tok(3));
  check("A1 the newest shared revision reads as current, with its payload, revision and dates",
    current.state === "current" && current.payload === PAYLOAD && current.revision === 5 && current.sharedAt === "s");
  check("A2 an earlier link reads as replaced, with nothing of the report, even when the old function still returns a payload",
    replaced.state === "replaced" && replacedWithPayload.state === "replaced" &&
    JSON.stringify(Object.keys(replacedWithPayload)) === JSON.stringify(["state"]) && JSON.stringify(Object.keys(replaced)) === JSON.stringify(["state"]));
  const nf = await Promise.all([
    readSharedPilotReport(rpcClient([]), tok(1)),
    readSharedPilotReport(rpcClient(null), tok(1)),
    readSharedPilotReport(rpcClient([{ payload: null, revision: 1, generated_at: "g", shared_at: "s", newer_shared_revision: false }]), tok(1)),
    readSharedPilotReport(rpcClient([{ payload: PAYLOAD, revision: 1, generated_at: "g", shared_at: "s" }]), tok(1)),
    readSharedPilotReport(rpcClient([{ payload: PAYLOAD, revision: 1, generated_at: "g", shared_at: "s", newer_shared_revision: null }]), tok(1)),
  ]);
  check("A3 no row, no payload without the flag, or a missing flag reads as not found (fail closed)",
    nf.every((r) => r.state === "not_found"), nf.map((r) => r.state).join(","));
  let thrown = false;
  try {
    await readSharedPilotReport({ rpc: async () => ({ data: null, error: new Error("db down") }) } as unknown as SupabaseClient, tok(1));
  } catch {
    thrown = true;
  }
  check("A4 a database error is raised, never read as a page", thrown);

  // Revisions 1 and 3 shared, 2 unshared, 4 blocked, 5 built but not shared.
  const rowsA = [artifact(1, true), artifact(2, false), artifact(3, true), artifact(4, false, "blocked"), artifact(5, false)];
  const listA = await listPilotReportRevisions(tableClient(rowsA), PILOT);
  const by = (list: typeof listA, n: number) => list.find((r) => r.revision === n)!;
  check("A5 the founder's list: the newest shared revision keeps its link; an earlier shared one is replaced and shows none; unshared and blocked ones neither",
    listA.map((r) => r.revision).join(",") === "5,4,3,2,1" &&
    by(listA, 3).publicToken === tok(3) && !by(listA, 3).replaced &&
    by(listA, 1).publicToken === null && by(listA, 1).replaced && by(listA, 1).sharedAt !== null &&
    [2, 4, 5].every((n) => by(listA, n).publicToken === null && !by(listA, n).replaced));
  const listB = await listPilotReportRevisions(tableClient([artifact(1, true), artifact(2, false), artifact(3, false)]), PILOT);
  const listC = await listPilotReportRevisions(tableClient([...rowsA.slice(0, 4), artifact(5, true)]), PILOT);
  check("A6 later revisions that are not shared replace nothing; once revision 5 is shared, 3 and 1 are both replaced",
    by(listB, 1).publicToken === tok(1) && !by(listB, 1).replaced &&
    by(listC, 5).publicToken === tok(5) && by(listC, 3).replaced && by(listC, 1).replaced &&
    by(listC, 3).publicToken === null && by(listC, 1).publicToken === null);
  const tc = tableClient([...rowsA.slice(0, 4), artifact(5, true)]);
  const [p1, p3, p5, p2] = await Promise.all([1, 3, 5, 2].map((n) => readPilotReportRevision(tc, PILOT, String(artifact(n, false).id))));
  const tcOpen = tableClient(rowsA);
  const p3open = await readPilotReportRevision(tcOpen, PILOT, String(artifact(3, false).id));
  check("A7 the founder's preview marks a shared revision replaced only once a later one is shared",
    p1?.replaced === true && p3?.replaced === true && p5?.replaced === false && p5?.isLatest === true &&
    p2?.replaced === false && p3open?.replaced === false && p3open?.isLatest === false);

  // The preview's status line (previewStatusWords), in every state the
  // preview can be in, against whether the preview offers Share.
  const BASE = { sharedAt: null as string | null, replaced: false, integrityStatus: "integrity_passed", isLatest: true, stale: false };
  const agree: boolean[] = [];
  for (const sharedAt of [null, "2026-11-21T10:00:00Z"]) {
    for (const replacedIn of [false, true]) {
      for (const integrityStatus of ["integrity_passed", "needs_review", "blocked"]) {
        for (const isLatest of [false, true]) {
          for (const staleIn of [false, true]) {
            // As readPilotReportRevision and the preview compute them.
            const replacedFlag = replacedIn && sharedAt !== null && !isLatest;
            const stale = sharedAt === null && staleIn;
            const canShare = isLatest && sharedAt === null && integrityStatus !== "blocked" && !stale;
            agree.push((previewStatusWords({ sharedAt, replaced: replacedFlag, integrityStatus, isLatest, stale }) === null) === canShare);
          }
        }
      }
    }
  }
  const pv = flat(read("app/admin/pilots/[pilotId]/report/[artifactId]/page.tsx"));
  const iShare = pv.indexOf("{canShare ? (");
  const iNote = pv.indexOf('<p className="zpa-muted">{PREVIEW_SHARE_NOTE_WORDS}</p>');
  const iButton = pv.indexOf("<SharePilotReportButton");
  const iElse = iButton < 0 ? -1 : pv.indexOf(") : (", iButton);
  const STATUS_CALL =
    // D-062 — the preview also says when it is a retest, not an action, that made the revision out of date.
    "{previewStatusWords({ sharedAt: revision.sharedAt, replaced: revision.replaced, integrityStatus: revision.integrityStatus, isLatest: revision.isLatest, stale, staleWords: actionsStale ? undefined : RETEST_OUT_OF_DATE_WORDS, })}";
  const iStatus = pv.indexOf(STATUS_CALL);
  check("A8 the preview's status line: a replaced revision says its link no longer opens, a shared one that its link is on the pilot page; blocked, older and out-of-date ones say why they cannot be shared; it is empty exactly when Share is offered; the preview shows it, with the revision's own fields, where Share is not offered",
    previewStatusWords({ ...BASE, sharedAt: "s", replaced: true, isLatest: false }) === REPLACED_REVISION_PREVIEW_WORDS &&
    previewStatusWords({ ...BASE, sharedAt: "s" }) === SHARED_REVISION_PREVIEW_WORDS &&
    previewStatusWords({ ...BASE, sharedAt: "s", isLatest: false }) === SHARED_REVISION_PREVIEW_WORDS &&
    previewStatusWords({ ...BASE, integrityStatus: "blocked" }) === BLOCKED_REVISION_PREVIEW_WORDS &&
    previewStatusWords({ ...BASE, isLatest: false }) === NOT_LATEST_REVISION_PREVIEW_WORDS &&
    previewStatusWords({ ...BASE, stale: true }) === STALE_REVISION_WORDS &&
    previewStatusWords({ ...BASE, stale: true, staleWords: "x" }) === "x" &&
    agree.length === 48 && agree.every(Boolean) &&
    /no longer opens/.test(REPLACED_REVISION_PREVIEW_WORDS) && !/no longer opens/.test(SHARED_REVISION_PREVIEW_WORDS) &&
    iShare > 0 && iButton > iShare && iElse > iButton && iStatus > iElse &&
    pv.split("previewStatusWords(").length === 2 && !/REPLACED_REVISION_PREVIEW_WORDS|STALE_REVISION_WORDS/.test(pv),
    `${agree.filter((x) => !x).length} disagreements; ${iShare}/${iButton}/${iElse}/${iStatus}`);

  const pilotPage = flat(read("app/admin/pilots/[pilotId]/page.tsx"));
  const iCard = pilotPage.indexOf('<h2 className="zpa-title">Pilot report</h2>');
  const iRule = pilotPage.indexOf("The customer receives only the private link you send them. {SHARING_ENDS_EARLIER_LINK_WORDS} </p>");
  const iBuild = pilotPage.indexOf("<BuildPilotReportButton");
  check("A9 both share-time notes say the earlier link stops working: the pilot page's report note, and the preview's note above Share, shown only where Share is offered",
    /^Once a newer revision is shared, the link to the one shared before it stops working\.$/.test(SHARING_ENDS_EARLIER_LINK_WORDS) &&
    /The link to any earlier revision you shared then stops working\.$/.test(PREVIEW_SHARE_NOTE_WORDS) &&
    iCard > 0 && iRule > iCard && iBuild > iRule &&
    iShare > 0 && iNote > iShare && iButton > iNote && iElse > iButton,
    `${iCard}/${iRule}/${iBuild} ${iShare}/${iNote}/${iButton}`);

  // The one link that opens stays on the pilot page, even when it is older
  // than the ten newest revisions the page lists.
  const winRow = (revision: number, shared: boolean): Row => ({
    id: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
    pilot_id: PILOT,
    revision,
    generated_at: `2026-11-20T09:${String(revision).padStart(2, "0")}:00Z`,
    integrity_status: "integrity_passed",
    integrity_reasons: [],
    shared_at: shared ? `2026-11-20T10:${String(revision).padStart(2, "0")}:00Z` : null,
    public_token: revision.toString(16).padStart(64, "0"),
    manifest: { protocols: [], attempts: [] },
    payload: { pilotId: PILOT },
  });
  const winTok = (n: number) => n.toString(16).padStart(64, "0");
  /** Revisions 1 and 2 shared, then `unsharedAfter` revisions built and not shared. */
  const builds = (unsharedAfter: number) => [winRow(1, true), winRow(2, true), ...Array.from({ length: unsharedAfter }, (_, i) => winRow(i + 3, false))];
  const counting = (rows: Row[]) => {
    const inner = tableClient(rows) as unknown as { from: (t: string) => unknown };
    const seen = { reads: 0 };
    return { seen, client: { from: (t: string) => { seen.reads += 1; return inner.from(t); } } as unknown as SupabaseClient };
  };
  const live = (list: typeof listA) => list.filter((r) => r.publicToken !== null);
  const w10 = counting(builds(10));
  const list10 = await listPilotReportRevisions(w10.client, PILOT);
  const w9 = counting(builds(9));
  const list9 = await listPilotReportRevisions(w9.client, PILOT);
  const w8 = counting(builds(8));
  const list8 = await listPilotReportRevisions(w8.client, PILOT);
  check("A10 the one link that opens is always listed: with ten newer unshared revisions, revision 2 is read beside them and listed last with its exact link, marked older; when it is among the ten newest, no extra read is made",
    list10.map((r) => r.revision).join(",") === "12,11,10,9,8,7,6,5,4,3,2" && w10.seen.reads === 2 &&
    live(list10).length === 1 && by(list10, 2).publicToken === winTok(2) && by(list10, 2).olderThanListed && !by(list10, 2).replaced &&
    list10.every((r) => r.revision === 2 || (!r.olderThanListed && !r.replaced && r.publicToken === null)) &&
    list9.map((r) => r.revision).join(",") === "11,10,9,8,7,6,5,4,3,2" && w9.seen.reads === 1 &&
    live(list9).length === 1 && by(list9, 2).publicToken === winTok(2) && list9.every((r) => !r.olderThanListed) &&
    list8.map((r) => r.revision).join(",") === "10,9,8,7,6,5,4,3,2,1" && w8.seen.reads === 1 &&
    live(list8).length === 1 && by(list8, 2).publicToken === winTok(2) && by(list8, 1).replaced && by(list8, 1).publicToken === null &&
    list8.every((r) => !r.olderThanListed),
    `${list10.map((r) => r.revision).join(",")} reads ${w10.seen.reads}`);

  const none = counting(Array.from({ length: 12 }, (_, i) => winRow(i + 1, false)));
  const listNone = await listPilotReportRevisions(none.client, PILOT);
  const fewer = counting(Array.from({ length: 4 }, (_, i) => winRow(i + 1, false)));
  const listFewer = await listPilotReportRevisions(fewer.client, PILOT);
  const tw = tableClient(builds(10));
  const [pw2, pw1] = await Promise.all([2, 1].map((n) => readPilotReportRevision(tw, PILOT, String(winRow(n, false).id))));
  const wordsFor = (r: typeof pw2) =>
    r === null ? null : previewStatusWords({ sharedAt: r.sharedAt, replaced: r.replaced, integrityStatus: r.integrityStatus, isLatest: r.isLatest, stale: false });
  const iToken = pilotPage.indexOf("{r.publicToken ? (");
  const iOlder = pilotPage.indexOf("{r.olderThanListed ? (");
  const iOlderWords = pilotPage.indexOf("{OLDER_SHARED_REVISION_WORDS}");
  const iReplaced = pilotPage.indexOf(") : r.replaced ? (");
  check("A11 with nothing shared, no link is listed and nothing is added (the extra read happens only when the ten newest hold no shared revision); the pilot page marks the added revision inside its link; revision 2's preview says its link is on the pilot page, which A10 makes true, and revision 1's that it was replaced",
    listNone.length === 10 && listNone.every((r) => r.publicToken === null && !r.olderThanListed) && none.seen.reads === 2 &&
    listFewer.length === 4 && fewer.seen.reads === 1 &&
    iToken > 0 && iOlder > iToken && iOlderWords > iOlder && iReplaced > iOlderWords &&
    /This is the link that opens\.$/.test(OLDER_SHARED_REVISION_WORDS) &&
    wordsFor(pw2) === SHARED_REVISION_PREVIEW_WORDS && wordsFor(pw1) === REPLACED_REVISION_PREVIEW_WORDS,
    `${listNone.length}/${none.seen.reads} ${listFewer.length}/${fewer.seen.reads} ${iToken}/${iOlder}/${iOlderWords}/${iReplaced}`);
})().catch((error) => check("A the app checks ran", false, String(error)));

/* ---------------------------------------------------------------- D */

const decisions = read("docs/DECISIONS.md");
const d059 = decisions.slice(decisions.indexOf("## D-059 "), decisions.indexOf("## D-060 "));
const d060 = decisions.slice(decisions.indexOf("## D-060 "));
check("D1 D-059 (the founder's rulings) and D-060 (this engineering) are recorded; D-060 marks its own rules (engineer)",
  decisions.includes("## D-059 ") && decisions.includes("## D-060 ") && decisions.indexOf("## D-059 ") < decisions.indexOf("## D-060 ") &&
  /I agree\./.test(d059) && /20261109170000/.test(d060) && /\(engineer\)/.test(d060));
check("D2 the spend-ledger gate notes that 0085's revoke of the two claims became a no-op",
  /20261109170000/.test(read("docs/SPEND_LEDGER_GATE.md")) && /no-op/.test(read("docs/SPEND_LEDGER_GATE.md")));
const QUEUE_RULE = "no job holds a live lease and no run request is pending";
check("D3 the worker runbook and the production plan state the queue rule that holds once 20261109170000 is applied",
  [read("docs/WORKER_DEPLOY_RUNBOOK.md"), read("docs/PILOT_PRODUCTION_PLAN.md")].every((t) => t.includes(QUEUE_RULE) && t.includes("20261109170000")));
const preflight = read("scripts/sql/prod-preflight.sql");
check("D4 the preflight checks the version as not yet recorded, in both P2.4 lists",
  (preflight.match(/'20261109170000'/g) ?? []).length === 2);
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
check("D5 test:pilot-links-claims is registered, and the database suite is in the local runner",
  pkg.scripts["test:pilot-links-claims"] === "tsx scripts/test-pilot-links-and-claims.ts" &&
  read("scripts/run-p2-workspace-db-local.sh").includes("npx tsx scripts/test-pilot-links-and-claims-db.ts"));
check("D6 the status records this work", /## 36\. /.test(read("docs/CURRENT_STATUS.md")));

void aDone.then(() => {
  console.log(`\n${total - failures}/${total} checks passed.`);
  if (total < 38) {
    console.error(`Pilot links and claims FAILED: only ${total} checks ran.`);
    process.exit(1);
  }
  if (failures > 0) {
    console.error("Pilot links and claims FAILED.");
    process.exit(1);
  }
  console.log("Pilot links and claims PASSED.");
});
