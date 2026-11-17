/**
 * PR #1 — access control, paid-route protection, spending limits and the
 * kill switch.
 *
 * What it pins:
 *   - paid execution is OFF unless explicitly switched on, and every missing
 *     or malformed setting is a refusal (fail closed);
 *   - the daily ceiling counts the last 24 hours of the ledger, reserved
 *     cost standing in for unknown actual cost, plus the largest cap of any
 *     job the worker could claim — queued, or claimed/running with attempts
 *     left (a crashed job being resumed) — and an unreadable or truncated
 *     ledger refuses;
 *   - the gate sits in front of Fly, so a refusal contacts nothing, and
 *     concurrent starts never produce more than one fresh start;
 *   - the eight legacy LLM routes refuse before any auth or model work;
 *   - only invited accounts pass the auth gates, founders always do, and
 *     ownership (tenant isolation) still answers 404;
 *   - an uninvited account is signed out at the callback;
 *   - production never returns mock model output;
 *   - the set of web entry points that can reach paid work is exactly the
 *     reviewed one — a new path fails this test until it is guarded.
 *
 * Offline: fetch is stubbed, Supabase is faked, and ZYPACT_MOCK_MODE=on, so
 * no provider, Fly machine or database is ever reached.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
delete process.env.ZYPACT_PAID_EXECUTION_ENABLED;
delete process.env.ZYPACT_DAILY_SPEND_CEILING_USD;
delete process.env.ZYPACT_LEGACY_PIPELINE_ENABLED;
process.env.ZYPACT_MOCK_MODE = "on";
process.env.SNAPSHOT_FOUNDER_EMAILS = "founder@zypact.example";
process.env.ZYPACT_ALLOWED_EMAILS = "alice@example.com, Bob@Example.com ";

import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDb } from "@/lib/db";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";
import { getAccessAllowlist, isEmailAllowed } from "@/lib/auth/access-allowlist";
import {
  DAILY_SPEND_CEILING_HARD_MAX_USD,
  evaluatePaidExecution,
  readPaidExecutionConfig,
} from "@/lib/worker-control/paid-execution-gate";
import {
  __setPaidExecutionGateForTests,
  __setRunRequestsForTests,
  startWorkerMachine,
} from "@/lib/worker-control/fly-machine";

/**
 * D-052 — every start now names its job through a run request. These checks
 * are about the paid gate and Fly, so the run request always succeeds here;
 * scripts/test-pilot-step1.ts covers the run request itself.
 */
const START_TARGET = {
  jobId: "00000000-0000-4000-8000-0000000000aa",
  projectId: "00000000-0000-4000-8000-0000000000bb",
  via: "admin_run_pipeline" as const,
  requestedBy: "00000000-0000-4000-8000-0000000000cc",
};
__setRunRequestsForTests({
  request: async () => ({
    outcome: "REQUESTED",
    requestId: "00000000-0000-4000-8000-0000000000dd",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }),
  cancel: async () => "CANCELLED",
});

import { legacyPipelineRefusal } from "@/lib/auth/route-helpers";
import { callModel } from "@/lib/llm/call-model";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ── fakes ──────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

/** Just enough PostgREST for the gate's three reads, recording each table. */
/**
 * `countFor` overrides the exact count one table reports (a number, or null
 * for a response that carries none); `ignoreInFor` makes one table ignore
 * its `.in()` filter, as a misbehaving response would.
 */
function fakeLedger(tables: Record<string, Row[]>, opts: {
  failOn?: string; countBonus?: number;
  countFor?: Record<string, number | null>; ignoreInFor?: string;
} = {}) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      let rows = [...(tables[table] ?? [])];
      let wantCount = false;
      const q = {
        select(_cols: string, o?: { count?: string }) { wantCount = o?.count === "exact"; return q; },
        gte(c: string, v: string) { rows = rows.filter((r) => String(r[c]) >= v); return q; },
        eq(c: string, v: unknown) { rows = rows.filter((r) => r[c] === v); return q; },
        in(c: string, vs: unknown[]) { if (opts.ignoreInFor !== table) rows = rows.filter((r) => vs.includes(r[c])); return q; },
        limit(n: number) { rows = rows.slice(0, n); return q; },
        then(resolve: (v: unknown) => unknown) {
          if (opts.failOn === table) return resolve({ data: null, error: { message: "down" }, count: null });
          const count = !wantCount ? null
            : opts.countFor && table in opts.countFor ? opts.countFor[table]
            : rows.length + (opts.countBonus ?? 0);
          return resolve({ data: rows, error: null, count });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, reads };
}

const NOW = new Date("2026-10-28T12:00:00Z");
const recent = "2026-10-28T06:00:00.000Z";
const old = "2026-10-26T06:00:00.000Z";
const ON = { ZYPACT_PAID_EXECUTION_ENABLED: "true", ZYPACT_DAILY_SPEND_CEILING_USD: "5" };

const realFetch = globalThis.fetch;
let flyCalls = 0;

let stubbedUser: { id: string; email: string | null } | null = null;
let signOuts = 0;
let getUserCalls = 0;
const stubAuth = {
  auth: {
    async getUser() {
      getUserCalls += 1;
      return { data: { user: stubbedUser }, error: null };
    },
    async exchangeCodeForSession() { return { error: null }; },
    async signOut() { signOuts += 1; return { error: null }; },
  },
} as unknown as SupabaseClient;
__setSupabaseServerClientForTests(stubAuth);

function json(body: unknown): Request {
  return new Request("http://local.test/api", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  console.log("\nPaid execution guards (PR #1)\n");

  /* ═══════ 1. configuration fails closed ═══════ */
  console.log("[1] Paid execution is off unless explicitly on");
  check("nothing set → disabled", readPaidExecutionConfig({}).enabled === false);
  for (const v of ["TRUE", "1", "yes", "on", " ", "false"]) {
    check(`ZYPACT_PAID_EXECUTION_ENABLED=${JSON.stringify(v)} → disabled`,
      readPaidExecutionConfig({ ZYPACT_PAID_EXECUTION_ENABLED: v, ZYPACT_DAILY_SPEND_CEILING_USD: "5" }).enabled === false);
  }
  for (const c of [undefined, "", "0", "-1", "abc", "5usd", "1e2", "Infinity", String(DAILY_SPEND_CEILING_HARD_MAX_USD + 1)]) {
    const r = readPaidExecutionConfig({ ZYPACT_PAID_EXECUTION_ENABLED: "true", ZYPACT_DAILY_SPEND_CEILING_USD: c });
    check(`enabled but ceiling ${JSON.stringify(c)} → refused as not configured`,
      !r.enabled && r.reason === "spend_ceiling_not_configured");
  }
  const okCfg = readPaidExecutionConfig({ ZYPACT_PAID_EXECUTION_ENABLED: "true", ZYPACT_DAILY_SPEND_CEILING_USD: " 2.50 " });
  check("enabled with a valid ceiling → enabled at that ceiling", okCfg.enabled && okCfg.ceilingUsd === 2.5);
  check("the hard maximum itself is accepted",
    readPaidExecutionConfig({ ...ON, ZYPACT_DAILY_SPEND_CEILING_USD: String(DAILY_SPEND_CEILING_HARD_MAX_USD) }).enabled);

  /* ═══════ 2. the ledger decision ═══════ */
  console.log("\n[2] The daily ceiling against the ledger");
  {
    const { client, reads } = fakeLedger({});
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: {} });
    check("disabled refuses without reading anything", !r.ok && r.code === "paid_execution_disabled" && reads.length === 0);
  }
  const ledger = (calls: Row[], jobs: Row[] = [], protocols: Row[] = [], o = {}) =>
    fakeLedger({ protocol_external_calls: calls, protocol_execution_jobs: jobs, protocols }, o);
  {
    const { client } = ledger(
      [
        // 0050 pairs actual cost with its basis; a Perplexity receipt is `measured`.
        { created_at: recent, reserved_cost_usd: 0.05, actual_cost_usd: 0.004, cost_basis: "measured" },
        { created_at: recent, reserved_cost_usd: 0.05, actual_cost_usd: null },
        { created_at: old, reserved_cost_usd: 100, actual_cost_usd: 100 },
      ],
      [{ protocol_id: "p1", status: "queued" }, { protocol_id: "p2", status: "queued" }, { protocol_id: "p3", status: "succeeded" }],
      [{ id: "p1", spend_cap_usd: 0.25 }, { id: "p2", spend_cap_usd: "0.40" }, { id: "p3", spend_cap_usd: 99 }]
    );
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("under the ceiling → allowed", r.ok, JSON.stringify(r));
    check("actual cost counts where known, reserved where not", r.ok && Math.abs(r.spentLast24hUsd - 0.054) < 1e-9,
      r.ok ? String(r.spentLast24hUsd) : "");
    check("rows older than 24 hours are not counted", r.ok && r.spentLast24hUsd < 1);
    check("the next job is the largest queued cap, and only queued jobs count", r.ok && r.nextJobCapUsd === 0.4,
      r.ok ? String(r.nextJobCapUsd) : "");
  }
  {
    const { client } = ledger([{ created_at: recent, reserved_cost_usd: 4.8, actual_cost_usd: null }],
      [{ protocol_id: "p1", status: "queued" }], [{ id: "p1", spend_cap_usd: 0.25 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("spent + next job cap over the ceiling → refused", !r.ok && r.code === "spend_ceiling_reached", JSON.stringify(r));
  }
  {
    const { client } = ledger([{ created_at: recent, reserved_cost_usd: 4.75, actual_cost_usd: null }],
      [{ protocol_id: "p1", status: "queued" }], [{ id: "p1", spend_cap_usd: 0.25 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("exactly at the ceiling → allowed", r.ok, JSON.stringify(r));
  }
  for (const [label, l] of [
    ["the ledger read fails", ledger([], [], [], { failOn: "protocol_external_calls" })],
    ["the ledger window is truncated", ledger([{ created_at: recent, reserved_cost_usd: 0.01, actual_cost_usd: null }], [], [], { countBonus: 5 })],
    ["the job queue read fails", ledger([], [], [], { failOn: "protocol_execution_jobs" })],
    ["a queued job's protocol is missing", ledger([], [{ protocol_id: "p9", status: "queued" }], [])],
    ["a ledger row has no usable cost", ledger([{ created_at: recent, reserved_cost_usd: null, actual_cost_usd: null }])],
    ["a queued cap is not a number", ledger([], [{ protocol_id: "p1", status: "queued" }], [{ id: "p1", spend_cap_usd: "lots" }])],
  ] as const) {
    const r = await evaluatePaidExecution({ client: l.client, now: () => NOW, env: ON });
    check(`${label} → refused as unavailable`, !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
  }

  /* ═══════ 2d. PG-9 C1: every read is complete, or the gate refuses ═══════ */
  console.log("\n[2d] Complete reads only (PG-9 C1)");
  {
    const jobs2 = [{ protocol_id: "p1", status: "queued" }, { protocol_id: "p2", status: "queued" }];
    const caps2 = [{ id: "p1", spend_cap_usd: 0.25 }, { id: "p2", spend_cap_usd: 0.4 }];
    const call = { created_at: recent, reserved_cost_usd: 0.05, actual_cost_usd: null };
    const base = await evaluatePaidExecution({ client: ledger([call], jobs2, caps2).client, now: () => NOW, env: ON });
    check("a complete, valid read is unchanged: allowed, same totals",
      base.ok && Math.abs(base.spentLast24hUsd - 0.05) < 1e-9 && base.nextJobCapUsd === 0.4, JSON.stringify(base));
    for (const [label, o] of [
      ["the job queue carries no count", { countFor: { protocol_execution_jobs: null } }],
      ["the job queue count is larger than its rows (truncated, e.g. at max_rows)", { countFor: { protocol_execution_jobs: 3 } }],
      ["the job queue count is smaller than its rows (inconsistent)", { countFor: { protocol_execution_jobs: 1 } }],
      ["the spend caps carry no count", { countFor: { protocols: null } }],
      ["the spend cap count is larger than its rows (truncated)", { countFor: { protocols: 3 } }],
      ["the spend cap count is smaller than its rows (inconsistent)", { countFor: { protocols: 1 } }],
      ["the ledger count is smaller than its rows (inconsistent)", { countFor: { protocol_external_calls: 0 } }],
      ["the ledger carries no count", { countFor: { protocol_external_calls: null } }],
    ] as const) {
      const r = await evaluatePaidExecution({ client: ledger([call], jobs2, caps2, o).client, now: () => NOW, env: ON });
      check(`${label} → refused as unavailable`, !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
    }
    for (const [label, caps, o] of [
      ["one required cap row is missing", [caps2[0]], {}],
      ["a cap row is duplicated (count consistent)", [...caps2, caps2[1]], {}],
      ["a cap row nobody asked for comes back", [...caps2, { id: "p9", spend_cap_usd: 0.1 }], { ignoreInFor: "protocols" }],
      ["a duplicate hides a missing row (same row count)", [caps2[0], caps2[0]], {}],
      ["a cap row has no id", [caps2[0], { spend_cap_usd: 0.4 }], { ignoreInFor: "protocols" }],
    ] as const) {
      const r = await evaluatePaidExecution({ client: ledger([call], jobs2, caps as unknown as Row[], o).client, now: () => NOW, env: ON });
      check(`${label} → refused as unavailable`, !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
    }
    for (const [label, job] of [
      ["a live job with no protocol id", { status: "queued" }],
      ["a live job whose protocol id is not a string", { protocol_id: 7, status: "queued" }],
      ["a live job with an empty protocol id", { protocol_id: "", status: "queued" }],
    ] as const) {
      const r = await evaluatePaidExecution({ client: ledger([call], [job as Row], caps2).client, now: () => NOW, env: ON });
      check(`${label} → refused as unavailable`, !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
    }
    {
      // Two live jobs on one protocol id are one cap, read once.
      const r = await evaluatePaidExecution({
        client: ledger([call], [jobs2[0], { protocol_id: "p1", status: "running", attempt_count: 1, max_attempts: 3 }], [caps2[0]]).client,
        now: () => NOW, env: ON });
      check("two live jobs sharing a protocol id need its one cap row, and are allowed", r.ok && r.nextJobCapUsd === 0.25, JSON.stringify(r));
    }
    {
      const l = ledger([call], [], []);
      const r = await evaluatePaidExecution({ client: l.client, now: () => NOW, env: ON });
      check("with no claimable job, the cap table is not read at all", r.ok && r.nextJobCapUsd === 0 && !l.reads.includes("protocols"),
        l.reads.join(","));
    }
  }

  /* ═══════ 2b. resumable jobs: what the worker's claim can pick up ═══════ */
  console.log("\n[2b] Jobs the worker can resume count toward the ceiling");
  const expiredLease = "2026-10-28T11:00:00.000Z";
  const liveLease = "2026-10-28T12:10:00.000Z";
  const nearCeiling = [{ created_at: recent, reserved_cost_usd: 4.0, actual_cost_usd: null }];
  {
    // The shape 0050's claim resumes: running, lease expired, attempts left.
    // Before this correction the gate saw no queued job and allowed a start
    // that could spend this job's whole $2 cap past the ceiling.
    const { client } = ledger(nearCeiling,
      [{ protocol_id: "r1", status: "running", lease_expires_at: expiredLease, attempt_count: 1, max_attempts: 3 }],
      [{ id: "r1", spend_cap_usd: 2 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("an expired-lease running job with attempts left is counted → refused at $4 + $2 > $5",
      !r.ok && r.code === "spend_ceiling_reached", JSON.stringify(r));
  }
  {
    const { client } = ledger(nearCeiling,
      [{ protocol_id: "c1", status: "claimed", lease_expires_at: expiredLease, attempt_count: 0, max_attempts: 1 }],
      [{ id: "c1", spend_cap_usd: 2 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("an expired-lease claimed job is counted the same way", !r.ok && r.code === "spend_ceiling_reached", JSON.stringify(r));
  }
  {
    const { client } = ledger(nearCeiling,
      [{ protocol_id: "c2", status: "claimed", lease_expires_at: liveLease, attempt_count: 1, max_attempts: 3 }],
      [{ id: "c2", spend_cap_usd: 2 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("a live-lease job with attempts left is also counted, so clock skew cannot undercount",
      !r.ok && r.code === "spend_ceiling_reached", JSON.stringify(r));
  }
  {
    const { client } = ledger(nearCeiling,
      [{ protocol_id: "x1", status: "running", lease_expires_at: expiredLease, attempt_count: 3, max_attempts: 3 }],
      [{ id: "x1", spend_cap_usd: 2 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("an exhausted job (no attempts left) is not counted — the claim abandons it",
      r.ok && r.nextJobCapUsd === 0, JSON.stringify(r));
  }
  {
    const { client } = ledger([],
      [{ protocol_id: "q1", status: "queued" },
       { protocol_id: "r2", status: "running", lease_expires_at: expiredLease, attempt_count: 1, max_attempts: 2 }],
      [{ id: "q1", spend_cap_usd: 0.25 }, { id: "r2", spend_cap_usd: 2 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("with queued and resumable jobs together, the largest cap of either counts", r.ok && r.nextJobCapUsd === 2,
      JSON.stringify(r));
  }
  for (const [label, job] of [
    ["missing attempt counts", { protocol_id: "b1", status: "running", lease_expires_at: expiredLease }],
    ["non-integer attempt counts", { protocol_id: "b2", status: "claimed", lease_expires_at: expiredLease, attempt_count: "1", max_attempts: 3 }],
  ] as const) {
    const { client } = ledger([], [job], [{ id: job.protocol_id, spend_cap_usd: 0.25 }]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check(`a claimed/running job with ${label} → refused as unavailable`,
      !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
  }
  {
    const { client } = ledger([],
      [{ protocol_id: "r3", status: "running", lease_expires_at: expiredLease, attempt_count: 1, max_attempts: 2 }], []);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check("a resumable job whose protocol cannot be read → refused as unavailable",
      !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
  }
  console.log("\n[2c] Unreadable spend records refuse");
  for (const [label, row] of [
    ["a non-numeric actual cost with no reservation", { created_at: recent, reserved_cost_usd: null, actual_cost_usd: "abc" }],
    ["a negative actual cost with no reservation", { created_at: recent, reserved_cost_usd: null, actual_cost_usd: -1 }],
    ["a non-finite reservation", { created_at: recent, reserved_cost_usd: "Infinity", actual_cost_usd: null }],
    ["an actual cost with no basis (impossible under 0050's pair check)", { created_at: recent, reserved_cost_usd: 0.02, actual_cost_usd: 0.01, cost_basis: null }],
    ["a basis with no actual cost", { created_at: recent, reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: "estimated" }],
    ["an unknown cost basis", { created_at: recent, reserved_cost_usd: 0.02, actual_cost_usd: 0.01, cost_basis: "guessed" }],
    ["an estimated cost with no reservation", { created_at: recent, reserved_cost_usd: null, actual_cost_usd: 0.01, cost_basis: "estimated" }],
  ] as const) {
    const { client } = ledger([row]);
    const r = await evaluatePaidExecution({ client, now: () => NOW, env: ON });
    check(`${label} → refused as unavailable`, !r.ok && r.code === "spend_ledger_unavailable", JSON.stringify(r));
  }

  /* ═══════ 3. the gate in front of Fly, and the kill switch ═══════ */
  console.log("\n[3] Starts go through the gate; the kill switch stops them");
  Object.assign(process.env, {
    FLY_WORKER_APP: "zypact-protocol-worker", FLY_WORKER_MACHINE_ID: "m1", FLY_API_TOKEN: "t",
  });
  let machineStarted = false;
  globalThis.fetch = (async () => {
    flyCalls += 1;
    const previous = machineStarted ? "started" : "stopped";
    machineStarted = true;
    return new Response(JSON.stringify({ previous_state: previous }), { status: 200 });
  }) as typeof fetch;

  __setPaidExecutionGateForTests(null);
  {
    flyCalls = 0;
    const r = await startWorkerMachine(START_TARGET);
    check("default gate, nothing configured → blocked, Fly not contacted",
      !r.ok && r.code === "paid_execution_blocked" && flyCalls === 0, JSON.stringify(r));
  }
  {
    // Ledger configuration present but paid execution not switched on: the
    // refusal comes from the switch, before any query leaves the process.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
    flyCalls = 0;
    const r = await startWorkerMachine(START_TARGET);
    check("default gate, switch off → blocked as disabled, Fly not contacted",
      !r.ok && r.code === "paid_execution_blocked" && /switched off/.test(r.detail) && flyCalls === 0, JSON.stringify(r));
    process.env.ZYPACT_PAID_EXECUTION_ENABLED = "true";
    flyCalls = 0;
    const r2 = await startWorkerMachine(START_TARGET);
    check("default gate, switch on but no ceiling → blocked, Fly not contacted",
      !r2.ok && r2.code === "paid_execution_blocked" && /ceiling/.test(r2.detail) && flyCalls === 0, JSON.stringify(r2));
    delete process.env.ZYPACT_PAID_EXECUTION_ENABLED;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  {
    // Kill switch: the same allowing ledger, decided by the env at call time.
    const { client } = ledger([]);
    const env: Record<string, string | undefined> = { ...ON };
    __setPaidExecutionGateForTests(() => evaluatePaidExecution({ client, now: () => NOW, env }));
    machineStarted = false; flyCalls = 0;
    const first = await startWorkerMachine(START_TARGET);
    check("switch on → starts", first.ok && flyCalls === 1, JSON.stringify(first));
    env.ZYPACT_PAID_EXECUTION_ENABLED = "false";
    machineStarted = false; flyCalls = 0;
    const second = await startWorkerMachine(START_TARGET);
    check("switch flipped off → the very next start is refused, Fly not contacted",
      !second.ok && second.code === "paid_execution_blocked" && flyCalls === 0, JSON.stringify(second));
  }

  /* ═══════ 4. concurrency ═══════ */
  console.log("\n[4] Concurrent starts");
  {
    const { client } = ledger([{ created_at: recent, reserved_cost_usd: 4.75, actual_cost_usd: null }],
      [{ protocol_id: "p1", status: "queued" }], [{ id: "p1", spend_cap_usd: 0.25 }]);
    __setPaidExecutionGateForTests(() => evaluatePaidExecution({ client, now: () => NOW, env: ON }));
    machineStarted = false; flyCalls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => startWorkerMachine(START_TARGET)));
    const fresh = results.filter((r) => r.ok && !r.alreadyRunning).length;
    check("five simultaneous starts at the ceiling's edge give exactly one fresh start",
      fresh === 1, JSON.stringify(results));
    check("the rest report the machine already running, not a second job",
      results.filter((r) => r.ok && r.alreadyRunning).length === 4);
    const decisions = await Promise.all(Array.from({ length: 5 }, () =>
      evaluatePaidExecution({ client, now: () => NOW, env: ON })));
    check("concurrent decisions over one ledger agree",
      new Set(decisions.map((d) => JSON.stringify(d))).size === 1);
  }
  {
    // The case the correction exists for, under concurrency: nothing queued,
    // one resumable job whose cap would cross the ceiling. Every one of the
    // simultaneous starts must refuse, and Fly must never be contacted.
    const { client } = ledger([{ created_at: recent, reserved_cost_usd: 4.0, actual_cost_usd: null }],
      [{ protocol_id: "r1", status: "running", lease_expires_at: "2026-10-28T11:00:00.000Z", attempt_count: 1, max_attempts: 3 }],
      [{ id: "r1", spend_cap_usd: 2 }]);
    __setPaidExecutionGateForTests(() => evaluatePaidExecution({ client, now: () => NOW, env: ON }));
    machineStarted = false; flyCalls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => startWorkerMachine(START_TARGET)));
    check("five simultaneous starts against a resumable job over the ceiling all refuse",
      results.every((r) => !r.ok && r.code === "paid_execution_blocked"), JSON.stringify(results));
    check("and none of them contacts Fly", flyCalls === 0, String(flyCalls));
  }
  {
    const { client } = ledger([],
      [{ protocol_id: "r1", status: "running", lease_expires_at: "2026-10-28T11:00:00.000Z", attempt_count: 1, max_attempts: 3 }],
      [{ id: "r1", spend_cap_usd: 2 }]);
    __setPaidExecutionGateForTests(() => evaluatePaidExecution({ client, now: () => NOW, env: ON }));
    machineStarted = false; flyCalls = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => startWorkerMachine(START_TARGET)));
    check("under the ceiling, simultaneous starts to resume a job still give exactly one fresh start",
      results.filter((r) => r.ok && !r.alreadyRunning).length === 1, JSON.stringify(results));
  }
  __setPaidExecutionGateForTests(null);
  globalThis.fetch = realFetch;

  /* ═══════ 5. the legacy LLM routes ═══════ */
  console.log("\n[5] Legacy LLM routes refuse before any work");
  const LEGACY = [
    "analyze-probe-response", "discover-competitors", "generate-asset", "generate-buyer-prompts",
    "generate-fix-brief", "generate-gap-map", "run-mirror-scan", "run-qa",
  ];
  stubbedUser = { id: "user-alice", email: "alice@example.com" };
  for (const route of LEGACY) {
    const mod = await import(`@/app/api/projects/${route}/route`);
    getUserCalls = 0;
    const res: Response = await mod.POST(json({ projectId: "p1", websiteUrl: "https://example.com" }));
    const body = await res.json().catch(() => ({}));
    check(`${route}: 403 legacy_pipeline_disabled, and no session was even read`,
      res.status === 403 && body.error === "legacy_pipeline_disabled" && getUserCalls === 0,
      `${res.status} ${JSON.stringify(body)} getUser=${getUserCalls}`);
  }
  check("legacy flag on but paid execution off → still refused",
    legacyPipelineRefusal("t", { ZYPACT_LEGACY_PIPELINE_ENABLED: "true" }) !== null);
  check("paid execution on but legacy flag off → still refused", legacyPipelineRefusal("t", ON) !== null);
  check("both on → allowed through to the route's own auth",
    legacyPipelineRefusal("t", { ...ON, ZYPACT_LEGACY_PIPELINE_ENABLED: "true" }) === null);
  {
    Object.assign(process.env, ON, { ZYPACT_LEGACY_PIPELINE_ENABLED: "true" });
    stubbedUser = { id: "user-carol", email: "carol@example.com" };
    const mod = await import("@/app/api/projects/run-mirror-scan/route");
    const res: Response = await mod.POST(json({ websiteUrl: "https://example.com" }));
    const body = await res.json().catch(() => ({}));
    check("with both switches on, an uninvited account is 403 not_invited", res.status === 403 && body.error === "not_invited",
      `${res.status} ${JSON.stringify(body)}`);
    for (const k of ["ZYPACT_PAID_EXECUTION_ENABLED", "ZYPACT_DAILY_SPEND_CEILING_USD", "ZYPACT_LEGACY_PIPELINE_ENABLED"]) delete process.env[k];
  }

  /* ═══════ 6. allowlist, founders, tenant isolation ═══════ */
  console.log("\n[6] Invited accounts only; founders always; ownership still 404");
  const list = getAccessAllowlist();
  check("the list is the union of invited testers and founders",
    list.has("alice@example.com") && list.has("bob@example.com") && list.has("founder@zypact.example") && list.size === 3);
  check("matching ignores case and surrounding space", isEmailAllowed("  ALICE@example.com "));
  check("a null or empty email is never allowed", !isEmailAllowed(null) && !isEmailAllowed(""));
  check("an empty configuration allows nobody", getAccessAllowlist({}).size === 0 && !isEmailAllowed("founder@zypact.example", getAccessAllowlist({})));

  const { requireCurrentUser, requireInvitedUser, requireProjectOwner, requireProjectOwnerForPage, ForbiddenError, NotFoundError } =
    await import("@/lib/auth/current-user");
  const db = getDb();
  const aliceProject = await db.createProject({ domain: "a.example.com", companyName: "A", userId: "user-alice" });
  const bobProject = await db.createProject({ domain: "b.example.com", companyName: "B", userId: "user-bob" });

  stubbedUser = { id: "user-carol", email: "carol@example.com" };
  let err: unknown = null;
  try { await requireInvitedUser(); } catch (e) { err = e; }
  check("an uninvited session → ForbiddenError", err instanceof ForbiddenError);
  err = null;
  try { await requireCurrentUser(); } catch (e) { err = e; }
  check("requireCurrentUser stays 'signed in' only, so founder routes keep their concealed 404", err === null, String(err));
  err = null;
  try { await requireProjectOwner(aliceProject.id); } catch (e) { err = e; }
  check("an uninvited session is refused before ownership is even considered", err instanceof ForbiddenError);

  stubbedUser = { id: "founder-1", email: "Founder@zypact.example" };
  err = null;
  try { await requireInvitedUser(); } catch (e) { err = e; }
  check("a founder passes without being on the tester list", err === null, String(err));

  stubbedUser = { id: "user-alice", email: "alice@example.com" };
  const own = await requireProjectOwner(aliceProject.id);
  check("an invited owner reaches their own project", own.project.id === aliceProject.id);
  err = null;
  try { await requireProjectOwner(bobProject.id); } catch (e) { err = e; }
  check("an invited user gets 404 on another tenant's project, never 403",
    err instanceof NotFoundError && (err as InstanceType<typeof NotFoundError>).reason === "ownership_denied");

  stubbedUser = { id: "user-carol", email: "carol@example.com" };
  err = null;
  try { await requireProjectOwnerForPage(aliceProject.id, `/projects/${aliceProject.id}`); } catch (e) { err = e; }
  const digest = String((err as { digest?: unknown } | null)?.digest ?? "");
  check("project pages send an uninvited session to /login with an error, not to the project",
    digest.includes("NEXT_REDIRECT") && digest.includes("/login?error="), digest);

  /* ═══════ 7. founder-only job queueing ═══════ */
  console.log("\n[7] Only a founder may queue a protocol job");
  {
    const { POST } = await import("@/app/api/projects/[projectId]/protocol-runs/route");
    stubbedUser = { id: "user-alice", email: "alice@example.com" };
    const res = await POST(json({ protocolId: "x" }), { params: Promise.resolve({ projectId: aliceProject.id }) });
    const body = await res.json();
    check("an invited owner who is not a founder → 403 founder_only", res.status === 403 && body.error === "founder_only",
      `${res.status} ${JSON.stringify(body)}`);
    const founderProject = await db.createProject({ domain: "f.example.com", companyName: "F", userId: "founder-1" });
    stubbedUser = { id: "founder-1", email: "founder@zypact.example" };
    const res2 = await POST(json({ protocolId: "missing" }), { params: Promise.resolve({ projectId: founderProject.id }) });
    check("a founder owner passes the guard (and meets the ordinary 404 for an unknown protocol)", res2.status === 404,
      String(res2.status));
  }

  /* ═══════ 8. the sign-in callback ═══════ */
  console.log("\n[8] An uninvited account is signed out at the callback");
  {
    const { GET } = await import("@/app/auth/callback/route");
    const { NextRequest } = await import("next/server");
    stubbedUser = { id: "user-carol", email: "carol@example.com" };
    signOuts = 0;
    const res = await GET(new NextRequest("http://local.test/auth/callback?code=abc&next=/admin"));
    check("uninvited: signed out, sent to /login with an error",
      signOuts === 1 && (res.headers.get("location") ?? "").includes("/login?error="), res.headers.get("location") ?? "");
    stubbedUser = { id: "user-alice", email: "alice@example.com" };
    signOuts = 0;
    const res2 = await GET(new NextRequest("http://local.test/auth/callback?code=abc&next=/admin"));
    check("invited: kept signed in and sent on", signOuts === 0 && !(res2.headers.get("location") ?? "").includes("/login"),
      res2.headers.get("location") ?? "");
  }

  /* ═══════ 9. no mock output in production ═══════ */
  console.log("\n[9] Mock output is refused on the production deployment");
  {
    const call = { system: "s", user: "u", mockResponse: "{\"invented\":true}" };
    const dev = await callModel(call);
    check("outside production, mock mode still works for development", dev.usedMock === true);
    process.env.VERCEL_ENV = "production";
    let threw = false;
    try { await callModel(call); } catch { threw = true; }
    check("VERCEL_ENV=production with ZYPACT_MOCK_MODE=on → refused", threw);
    delete process.env.VERCEL_ENV;
  }

  /* ═══════ 10. the reviewed inventory of paid entry points ═══════ */
  console.log("\n[10] Every web entry point that can reach paid work is a reviewed, guarded one");
  {
    const root = process.cwd();
    const resolve = (from: string, spec: string): string | null => {
      let p: string;
      if (spec.startsWith("@/")) p = path.join(root, spec.slice(2));
      else if (spec.startsWith(".")) p = path.resolve(path.dirname(from), spec);
      else return null;
      for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts"), path.join(p, "index.tsx")]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      return null;
    };
    const deps = new Map<string, string[]>();
    const depsOf = (f: string): string[] => {
      const hit = deps.get(f);
      if (hit) return hit;
      const src = fs.readFileSync(f, "utf8");
      const out: string[] = [];
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const r = resolve(f, m[1] ?? m[2]);
        if (r) out.push(r);
      }
      deps.set(f, out);
      return out;
    };
    const reaches = (entry: string, sink: string): boolean => {
      const seen = new Set<string>();
      const stack = [entry];
      while (stack.length) {
        const f = stack.pop()!;
        if (f === sink) return true;
        if (seen.has(f)) continue;
        seen.add(f);
        stack.push(...depsOf(f));
      }
      return false;
    };
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const entries = walk(path.join(root, "app")).filter((f) => /\.(ts|tsx)$/.test(f));
    const rel = (f: string) => path.relative(root, f);
    const sink = (p: string) => path.join(root, p);

    const llm = entries.filter((e) => reaches(e, sink("lib/llm/call-model.ts"))).map(rel).sort();
    const expectedLlm = LEGACY.map((r) => `app/api/projects/${r}/route.ts`).sort();
    check("exactly the eight legacy routes reach a model call", JSON.stringify(llm) === JSON.stringify(expectedLlm), llm.join(", "));
    for (const f of llm) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      const handler = src.slice(src.indexOf("export async function POST"));
      check(`${f} refuses as its handler's first statement`,
        /^export async function POST\([^)]*\) \{\n\s+const refused = legacyPipelineRefusal\(/.test(handler));
    }

    const perplexity = entries.filter((e) => reaches(e, sink("lib/probes/perplexity.ts"))).map(rel);
    check("no web entry point reaches the Perplexity probe directly", perplexity.length === 0, perplexity.join(", "));
    // PR #4 — the Agent API adapter is a paid call too.
    const agent = entries.filter((e) => reaches(e, sink("lib/probes/perplexity-agent.ts"))).map(rel);
    check("no web entry point reaches the Perplexity Agent API adapter", agent.length === 0, agent.join(", "));
    // X1 (D-050) — the ChatGPT (OpenAI Responses API) adapter is a paid call too.
    const chatgpt = entries.filter((e) => reaches(e, sink("lib/probes/chatgpt.ts"))).map(rel);
    check("no web entry point reaches the ChatGPT adapter", chatgpt.length === 0, chatgpt.join(", "));

    const fly = entries.filter((e) => reaches(e, sink("lib/worker-control/fly-machine.ts"))).map(rel).sort();
    const expectedFly = [
      "app/api/internal/founder-baselines/[jobId]/run/route.ts",
      "app/api/internal/interventions/[interventionId]/run-retest/route.ts",
      // D-054 — a pilot question's Run, founder-guarded like the others.
      "app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/run/route.ts",
      "app/api/internal/snapshot-requests/[requestId]/run-pipeline/route.ts",
    ];
    check("exactly the four founder routes can start the worker", JSON.stringify(fly) === JSON.stringify(expectedFly), fly.join(", "));
    for (const f of fly) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      // Three reviewed guard shapes. Whichever it is, it must come before
      // the route's start call.
      const guardAt = src.search(/requireFounderForRoute\(|guardInterventionRoute\(|isFounderEmail\(user\.email\)/);
      const startAt = src.indexOf("startWorkerMachine({");
      check(`${f} is founder-guarded before it can start the worker`, guardAt > 0 && startAt > guardAt,
        `guard@${guardAt} start@${startAt}`);
    }
    // requireCurrentUser checks a session only. Every caller must pair it
    // with a founder check, or the allowlist would be bypassed.
    const signedInOnly = [...entries, ...walk(path.join(root, "lib"))]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(path.join("lib", "auth", "current-user.ts")))
      .filter((f) => /requireCurrentUser\(\)/.test(fs.readFileSync(f, "utf8")));
    check("there are callers of requireCurrentUser to check", signedInOnly.length > 0);
    for (const f of signedInOnly) {
      const src = fs.readFileSync(f, "utf8");
      check(`${rel(f)} pairs requireCurrentUser with a founder check`,
        // The three reviewed shapes: the shared helper, the decision
        // function, and the approve route's own founderEmails().has(...).
        /isFounderEmail\(|evaluateFounderAccess\(|founderEmails\(\)[\s\S]*?\.has\(/.test(src));
    }

    // Every project page enforces ownership itself, before its first read.
    const projectPages = entries.filter((f) =>
      /app\/projects\/\[id\]\/[^/]+\/page\.tsx$/.test(rel(f)));
    check("there are project pages to check", projectPages.length >= 10, String(projectPages.length));
    for (const f of projectPages) {
      const src = fs.readFileSync(f, "utf8");
      const body = src.slice(src.indexOf("export default async function"));
      const guardAt = body.indexOf("await requireProjectOwnerForPage(id");
      const firstRead = body.search(/getDb\(\)|db\.[a-zA-Z]+\(/);
      check(`${rel(f)} checks ownership before its first data read`,
        guardAt > 0 && (firstRead === -1 || guardAt < firstRead), `guard@${guardAt} read@${firstRead}`);
    }

    const flySrc = fs.readFileSync(sink("lib/worker-control/fly-machine.ts"), "utf8");
    const startBody = flySrc.slice(flySrc.indexOf("export async function startWorkerMachine"));
    check("inside startWorkerMachine the gate runs before the only Fly start call",
      startBody.indexOf("await gate()") > 0 && startBody.indexOf("await gate()") < startBody.indexOf('"/start"'));
    check("the start endpoint is called from nowhere else in the web app",
      entries.every((e) => !fs.readFileSync(e, "utf8").includes("machines.dev")));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
