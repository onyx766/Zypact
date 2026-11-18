/**
 * Phase 4 — creating, queueing and reading an intervention's retest.
 *
 * Driven against a recording fake client, like test-intervention-routes.ts,
 * so the assertions can be about what reached the database: which project id,
 * which RPC, which arguments — and, as importantly, which calls never happened.
 *
 * Does not prove the RPCs; 0073/0077/0079's runtime contracts do. Does not run
 * a retest; that is Phase 4 step 4, held for an explicit go-ahead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createRetest,
  findRetestProtocol,
  queueRetestRun,
  readRetestProgress,
} from "@/lib/interventions/retest-actions";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

type Row = Record<string, unknown>;
interface RpcCall { name: string; args: Record<string, unknown> }

function fakeClient(opts: {
  tables?: Record<string, Row[]>;
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
}) {
  const rpcCalls: RpcCall[] = [];
  const tables = opts.tables ?? {};
  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      maybeSingle: async () =>
        rows.length > 1
          ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }
          : { data: rows[0] ?? null, error: null },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  }
  const client = {
    from: (t: string) => query(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: [], error: null };
    },
  } as unknown as SupabaseClient;
  return { client, rpcCalls };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BASELINE = "22222222-2222-4222-8222-222222222222";
const RETEST = "33333333-3333-4333-8333-333333333333";
const OLD_RETEST = "66666666-6666-4666-8666-666666666666";
const IV = "44444444-4444-4444-8444-444444444444";
const ACTOR = "55555555-5555-4555-8555-555555555555";

const iv = (status: string): Row => ({
  id: IV, project_id: PROJECT, protocol_id: BASELINE, buyer_question_version_id: "bqv", status,
  hypothesis: "h", expected_mechanism: "m", action_type: "page_created", action_target: "t", owner: "o",
  supporting_evidence: ["a"], created_at: "x", updated_at: "x",
});
const retestRow = (id: string, status: string): Row => ({
  id, project_id: PROJECT, baseline_protocol_id: BASELINE, status, planned_baseline_runs: 5, created_at: "x",
});

async function main(): Promise<void> {
  console.log("\nRetest actions (Phase 4)\n");

  /* ═══════════ 1. resolving an intervention's retest ═══════════ */
  console.log("[1] findRetestProtocol");
  {
    const { client } = fakeClient({
      tables: { protocols: [retestRow(OLD_RETEST, "abandoned"), retestRow(RETEST, "approved")] },
    });
    const found = await findRetestProtocol(client, { projectId: PROJECT, protocolId: BASELINE });
    check("an abandoned retest is passed over for the live one — the case that crashed delivery",
      found?.id === RETEST, String(found?.id));
    check("the retest's planned count comes from planned_baseline_runs", found?.plannedRuns === 5);
  }
  {
    const { client } = fakeClient({ tables: { protocols: [retestRow(OLD_RETEST, "abandoned")] } });
    check("only abandoned retests means no retest",
      (await findRetestProtocol(client, { projectId: PROJECT, protocolId: BASELINE })) === null);
  }

  /* ═══════════ 2. create ═══════════ */
  console.log("\n[2] createRetest");
  {
    const { client, rpcCalls } = fakeClient({ tables: { interventions: [] } });
    const r = await createRetest(client, IV, ACTOR);
    check("an unknown intervention is a 404 and calls nothing", !r.ok && r.failure.status === 404 && rpcCalls.length === 0);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [iv("implemented")] },
      rpc: () => ({ data: [{ status_code: "CREATED", retest_protocol_id: RETEST }], error: null }),
    });
    const r = await createRetest(client, IV, ACTOR);
    check("CREATED returns the new retest id", r.ok && r.retestProtocolId === RETEST && !r.replayed);
    check("the RPC gets the stored project id", rpcCalls[0]?.args.p_project_id === PROJECT);
    check("the actor is recorded as the approver", rpcCalls[0]?.args.p_approved_by === ACTOR);
    check("eligibility is not re-derived — exactly one RPC, create_retest_protocol, is called",
      rpcCalls.length === 1 && rpcCalls[0].name === "create_retest_protocol");
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [iv("implemented")] },
      rpc: () => ({ data: [{ status_code: "RETEST_ALREADY_EXISTS", retest_protocol_id: RETEST }], error: null }),
    });
    const r = await createRetest(client, IV, ACTOR);
    check("a replay (including a completed retest, 0079) is a success, not an error",
      r.ok && r.replayed && r.retestProtocolId === RETEST);
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [iv("implemented")] },
      rpc: () => ({ data: [{ status_code: "OBSERVATION_WINDOW_OPEN", retest_protocol_id: null }], error: null }),
    });
    const r = await createRetest(client, IV, ACTOR);
    check("an open window is refused as the authority said", !r.ok && r.failure.error === "observation_window_open");
  }
  {
    let logged = "";
    const { client } = fakeClient({
      tables: { interventions: [iv("implemented")] },
      rpc: () => ({ data: [{ status_code: "CREATED", retest_protocol_id: null }], error: null }),
    });
    const r = await createRetest(client, IV, ACTOR, (d) => { logged = d.message ?? ""; });
    check("CREATED without an id is a 500, never a success with no protocol", !r.ok && r.failure.status === 500);
    check("and it is logged", logged.includes("returned no protocol id"));
  }

  /* ═══════════ 3. queue ═══════════ */
  console.log("\n[3] queueRetestRun");
  for (const status of ["proposed", "approved", "rejected", "abandoned"]) {
    const { client, rpcCalls } = fakeClient({ tables: { interventions: [iv(status)], protocols: [retestRow(RETEST, "approved")] } });
    const r = await queueRetestRun(client, IV);
    check(`a '${status}' intervention cannot queue a retest, and nothing is called`,
      !r.ok && r.failure.status === 409 && rpcCalls.length === 0);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [iv("implemented")], protocols: [retestRow(OLD_RETEST, "abandoned")] },
    });
    const r = await queueRetestRun(client, IV);
    check("with only an abandoned retest, nothing is queued",
      !r.ok && r.failure.error === "no_retest_protocol" && rpcCalls.length === 0);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [iv("implemented")], protocols: [retestRow(OLD_RETEST, "abandoned"), retestRow(RETEST, "approved")] },
      rpc: () => ({ data: [{ status: "QUEUED", job: { id: "job-1", status: "queued" } }], error: null }),
    });
    const r = await queueRetestRun(client, IV);
    check("QUEUED queues the job", r.ok && !r.replayed && r.jobId === "job-1" && r.jobStatus === "queued");
    check("the LIVE retest is what gets enqueued, never the abandoned one",
      rpcCalls[0]?.name === "enqueue_protocol_execution_job" && rpcCalls[0]?.args.p_protocol_id === RETEST);
    check("with the stored project id", rpcCalls[0]?.args.p_project_id === PROJECT);
    check("and the RPC's default max_attempts, exactly as the baseline path (0069) calls it",
      !("p_max_attempts" in (rpcCalls[0]?.args ?? {})));
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [iv("implemented")], protocols: [retestRow(RETEST, "approved")] },
      rpc: () => ({ data: [{ status: "ALREADY_EXISTS", job: { id: "job-1", status: "running" } }], error: null }),
    });
    const r = await queueRetestRun(client, IV);
    check("a double click returns the existing job and spends nothing more", r.ok && r.replayed && r.jobId === "job-1");
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [iv("implemented")], protocols: [retestRow(RETEST, "approved")] },
      rpc: () => ({ data: [{ status: "SOMETHING_NEW", job: null }], error: null }),
    });
    const r = await queueRetestRun(client, IV);
    check("an unrecognised enqueue outcome fails closed", !r.ok && r.failure.status === 500);
  }

  /* ═══════════ 4. progress ═══════════ */
  console.log("\n[4] readRetestProgress");
  {
    const { client } = fakeClient({
      tables: {
        protocols: [retestRow(RETEST, "active")],
        protocol_execution_jobs: [{ id: "job-1", protocol_id: RETEST, status: "running", attempt_count: 1, max_attempts: 3 }],
        protocol_attempts: [
          { protocol_id: RETEST, status: "completed", attempt_kind: "retest" },
          { protocol_id: RETEST, status: "completed", attempt_kind: "retest" },
          { protocol_id: RETEST, status: "in_progress", attempt_kind: "retest" },
          { protocol_id: BASELINE, status: "completed", attempt_kind: "baseline" },
        ],
      },
    });
    const p = await readRetestProgress(client, { projectId: PROJECT, protocolId: BASELINE });
    check("progress counts only the retest's own attempts", p?.attempts.total === 3);
    check("by status", p?.attempts.byStatus.completed === 2 && p?.attempts.byStatus.in_progress === 1);
    check("by kind — all retest", p?.attempts.byKind.retest === 3 && Object.keys(p?.attempts.byKind ?? {}).length === 1);
    check("the job is read", p?.job?.status === "running" && p?.job?.attemptCount === 1);
  }
  {
    const { client } = fakeClient({
      tables: {
        protocols: [retestRow(RETEST, "active")],
        protocol_attempts: [{ protocol_id: RETEST, status: "completed", attempt_kind: "baseline" }],
      },
    });
    const p = await readRetestProgress(client, { projectId: PROJECT, protocolId: BASELINE });
    check("a non-retest attempt on a retest protocol is counted, not hidden", p?.attempts.byKind.baseline === 1);
    check("no job yet reads as null", p?.job === null);
  }
  {
    const { client } = fakeClient({ tables: { protocols: [] } });
    check("no retest means no progress", (await readRetestProgress(client, { projectId: PROJECT, protocolId: BASELINE })) === null);
  }

  /* ═══════════ D-062: a pilot member (§3.6) ═══════════ */
  console.log("\n[D-062] a pilot retest member is managed on its pilot page");
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [iv("implemented")], pilot_retest_members: [{ intervention_id: IV, pilot_id: "p" }], protocols: [retestRow(RETEST, "approved")] },
    });
    const created = await createRetest(client, IV, ACTOR);
    const queued = await queueRetestRun(client, IV);
    check("creating a member's retest answers 409 pilot_member and calls nothing",
      !created.ok && created.failure.status === 409 && created.failure.error === "pilot_member");
    check("queueing a member's retest run answers 409 pilot_member and calls nothing",
      !queued.ok && queued.failure.error === "pilot_member" && rpcCalls.length === 0);
  }

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
