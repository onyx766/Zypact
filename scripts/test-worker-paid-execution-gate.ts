/**
 * PR-1 — the production worker asks the paid-execution gate before every
 * claim.
 *
 * The web start path already refused paid work without the switch, a valid
 * ceiling and a readable ledger (PR #1). The worker process itself did not:
 * a machine started any other way claimed and spent outside the ledger
 * ceiling. What this file pins:
 *
 *   [1] each refusal — switch missing, ceiling invalid, ledger unavailable
 *       or incomplete, budget exceeded — and a gate that throws: no claim,
 *       no reservation, no provider or analysis call; the loop ends with
 *       `paid_execution_refused` and the closed refusal code;
 *   [2] an allowing gate lets the claim through, and the gate is asked
 *       again before the next claim: allow → one job runs; refuse → the
 *       second queued job is not claimed and stays claimable;
 *   [3] order: the runtime bound is asked first; a bound that declines a
 *       claim means the gate is not even read;
 *   [4] paidExecutionGateFor: a service client that cannot be built is a
 *       refusal, and the decision comes from the real evaluatePaidExecution
 *       over the ledger;
 *   [5] static: the production entry wires the gate from an explicit
 *       service-role client, in the live branch only; no production caller
 *       outside the gated loop reaches runOneIteration or runWorkerLoop;
 *       the loop asks the gate before runOneIteration — and each pin is
 *       shown to fail on a mutated source;
 *   [6] the gate is awaited, so the stop signal and the runtime bound are
 *       re-asked after it resolves: an ALLOW that arrives after a stop was
 *       requested, or after the bound ran out, claims nothing; an ALLOW with
 *       both still valid claims exactly once.
 *
 * Offline: the in-memory adapter, a fixture fetch, a fake ledger client.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "@/lib/evidence/hash";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { runWorkerLoop, type PaidExecutionGate } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import {
  paidExecutionGateFor,
  type PaidExecutionDecision,
  type PaidExecutionRefusal,
} from "@/lib/worker-control/paid-execution-gate";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { DbAdapter } from "@/lib/db/types";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

let globalFetchCalls = 0;
globalThis.fetch = (async () => { globalFetchCalls += 1; throw new Error("no network"); }) as typeof fetch;
process.env.PERPLEXITY_API_KEY = "test-only-not-a-key";

const QUESTION = "Which SOC 2 compliance tools suit a 50-person SaaS company?";
const APPROVER = "11111111-1111-4111-8111-111111111111";
const PROVIDER_BODY = JSON.stringify({ id: "pplx-1", object: "chat.completion", model: "sonar", choices: [{ message: { content: "Vanta and Drata." } }] });
const ANALYSIS_BODY = JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] });
const ANALYSIS_OUT = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "None." });

const ALLOW: PaidExecutionDecision = { ok: true, ceilingUsd: 5, spentLast24hUsd: 0, nextJobCapUsd: 2 };
const refuse = (code: PaidExecutionRefusal): PaidExecutionDecision => ({ ok: false, code, detail: "fixture" });

type Row = Record<string, unknown>;
/** Just enough PostgREST for the gate's three reads (as test-paid-execution-guards). */
function fakeLedger(tables: Record<string, Row[]>, opts: { failOn?: string; countBonus?: number } = {}) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      reads.push(table);
      let rows = [...(tables[table] ?? [])];
      let wantCount = false;
      const q = {
        select(_cols: string, o?: { count?: string }) { wantCount = o?.count === "exact"; return q; },
        gte(c: string, v: string) { rows = rows.filter((r) => String(r[c]) >= v); return q; },
        in(c: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        limit(n: number) { rows = rows.slice(0, n); return q; },
        then(resolve: (v: unknown) => unknown) {
          if (opts.failOn === table) return resolve({ data: null, error: { message: "down" }, count: null });
          return resolve({ data: rows, error: null, count: wantCount ? rows.length + (opts.countBonus ?? 0) : null });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { client, reads };
}
const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const ONE_QUEUED = {
  protocol_execution_jobs: [{ protocol_id: "p1", status: "queued", attempt_count: 0, max_attempts: 3 }],
  protocols: [{ id: "p1", spend_cap_usd: 2 }],
};
const ON = (ceiling: string) => ({ ZYPACT_PAID_EXECUTION_ENABLED: "true", ZYPACT_DAILY_SPEND_CEILING_USD: ceiling });

async function main(): Promise<void> {
  console.log("\nPR-1 — the worker's paid-execution gate\n");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seed(domain: string) {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: project.id, versionNumber: 1, promptText: QUESTION,
      promptHash: sha256Hex(QUESTION), intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: project.id, approvedBy: APPROVER });
    const protocol = await db.createProtocol({
      projectId: project.id, buyerQuestionVersionId: version.id, provider: "perplexity_sonar", surface: "answer",
      modelConfig: { model: "sonar" }, plannedBaselineRuns: 1, plannedRetestRuns: 0,
      paraphrasePlan: [{ text: QUESTION, hash: sha256Hex(QUESTION) }], unitOfAnalysis: "run",
      primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 3, spendCapUsd: 1,
      timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 0,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id, protocolId: protocol.id };
  }

  /** Drains whatever is claimable, so each case starts from an empty queue. */
  async function drain(): Promise<void> {
    for (;;) {
      const c = await db.claimProtocolExecutionJob({ workerId: "drain", leaseSeconds: 60 });
      if (!c.job || !c.claimToken) return;
      await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
    }
  }

  const OPTS: WorkerOptions = {
    workerId: "pr1-test", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 4,
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
    exitAfterClaimedJob: false, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
  };

  /** A worker whose every claim, admission, request and analysis is counted. */
  function harness() {
    const wire = { claims: 0, admissions: 0, fetches: 0, analyses: 0 };
    const spyDb: DbAdapter = {
      ...db,
      claimProtocolExecutionJob: async (input) => { wire.claims += 1; return db.claimProtocolExecutionJob(input); },
      admitAndReserveAttemptForJob: async (input) => { wire.admissions += 1; return db.admitAndReserveAttemptForJob(input); },
    };
    const analysis: AnalysisTransport = {
      prepare: () => ({ provider: "openai" as const, model: "gpt-4o-2024-08-06", url: "https://api.openai.com/v1/chat/completions",
        rawRequestBody: ANALYSIS_BODY, requestSha256: sha256Hex(ANALYSIS_BODY) }),
      execute: async () => {
        wire.analyses += 1;
        return { provider: "openai" as const, model: "gpt-4o-2024-08-06", content: ANALYSIS_OUT, usedMock: false,
          modelReturned: "gpt-4o-2024-08-06", latencyMs: 5, requestSha256: sha256Hex(ANALYSIS_BODY),
          contentSha256: sha256Hex(ANALYSIS_OUT), providerRequestId: "a-1", httpStatus: 200, usage: null };
      },
    };
    const deps: WorkerDeps = {
      db: spyDb, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: (async () => {
        wire.fetches += 1;
        return new Response(PROVIDER_BODY, { status: 200, headers: { "x-request-id": `req-${wire.fetches}` } });
      }) as typeof fetch,
      runProbe: runPerplexityProbe,
    };
    return { deps, wire };
  }

  /** Runs the loop with a scripted gate; the signal stops it once the script runs out. */
  async function runWith(gateScript: Array<PaidExecutionDecision | "throw">, opts: WorkerOptions = OPTS) {
    const h = harness();
    const signal = { aborted: false };
    let asked = 0;
    const gate: PaidExecutionGate = async () => {
      const step = gateScript[asked];
      asked += 1;
      if (step === undefined) { signal.aborted = true; return refuse("paid_execution_disabled"); }
      if (step === "throw") throw new Error("ledger client exploded");
      return step;
    };
    const seen: IterationResult[] = [];
    await runWorkerLoop(h.deps, opts, gate, signal, async () => {}, (r) => seen.push(r), new WorkerHealth(h.deps.now));
    return { ...h, asked: () => asked, seen };
  }

  /* ═══════ [1] every refusal: nothing claimed, reserved or sent ═══════ */
  console.log("[1] Refusals");
  const REFUSALS: PaidExecutionRefusal[] = ["paid_execution_disabled", "spend_ceiling_not_configured", "spend_ledger_unavailable", "spend_ceiling_reached"];
  for (const code of REFUSALS) {
    await drain();
    const { protocolId } = await seed(`refuse-${code}.test`);
    const r = await runWith([refuse(code)]);
    check(`${code}: the loop ends with paid_execution_refused and the code`,
      r.seen.length === 1 && r.seen[0].outcome === "paid_execution_refused" && r.seen[0].detail === code && r.seen[0].jobId === null,
      JSON.stringify(r.seen));
    check(`${code}: zero claims, reservations, requests and analyses`,
      r.wire.claims === 0 && r.wire.admissions === 0 && r.wire.fetches === 0 && r.wire.analyses === 0, JSON.stringify(r.wire));
    check(`${code}: asked once, never retried`, r.asked() === 1, String(r.asked()));
    const c = await db.claimProtocolExecutionJob({ workerId: "inspector", leaseSeconds: 60 });
    check(`${code}: the queued job is untouched and still claimable`, c.job?.protocolId === protocolId && c.job?.attemptCount === 1,
      JSON.stringify({ protocolId: c.job?.protocolId === protocolId, attempts: c.job?.attemptCount }));
    if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
  }
  {
    await drain();
    await seed("refuse-throw.test");
    const r = await runWith(["throw"]);
    check("a gate that throws is a refusal (spend_ledger_unavailable), never a pass",
      r.seen[0]?.outcome === "paid_execution_refused" && r.seen[0]?.detail === "spend_ledger_unavailable", JSON.stringify(r.seen));
    check("…with zero claims, reservations and requests", r.wire.claims === 0 && r.wire.admissions === 0 && r.wire.fetches === 0);
    await drain();
  }

  /* ═══════ [2] allowed, then re-asked before the next claim ═══════ */
  console.log("\n[2] Re-evaluated before every claim");
  {
    await drain();
    const first = await seed("allow-first.test");
    const second = await seed("allow-second.test");
    const r = await runWith([ALLOW, refuse("spend_ceiling_reached")]);
    const firstAttempts = await db.getProtocolAttempts(first.protocolId, first.projectId);
    const secondAttempts = await db.getProtocolAttempts(second.protocolId, second.projectId);
    check("allowed: exactly one claim, and that job ran (one request, one analysis)",
      r.wire.claims === 1 && r.wire.fetches === 1 && r.wire.analyses === 1 && firstAttempts.length + secondAttempts.length === 1,
      JSON.stringify(r.wire));
    check("the gate was asked again before the second claim, and refused it",
      r.asked() === 2 && r.seen.at(-1)?.outcome === "paid_execution_refused" && r.seen.at(-1)?.detail === "spend_ceiling_reached",
      `asked=${r.asked()} ${JSON.stringify(r.seen.map((s) => s.outcome))}`);
    const ranProtocol = firstAttempts.length === 1 ? second.protocolId : first.protocolId;
    const c = await db.claimProtocolExecutionJob({ workerId: "inspector", leaseSeconds: 60 });
    check("…so the other queued job was never claimed and is still claimable",
      c.job?.protocolId === ranProtocol && c.job?.attemptCount === 1, JSON.stringify(c.job?.attemptCount));
    if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
  }
  {
    await drain();
    // An empty queue: every pass is a claim attempt, each one gated.
    const r = await runWith([ALLOW, ALLOW, ALLOW, refuse("paid_execution_disabled")]);
    check("idle polling: one gate answer per claim attempt (3 allowed → 3 claims, then refused)",
      r.asked() === 4 && r.wire.claims === 3 && r.wire.fetches === 0, `asked=${r.asked()} claims=${r.wire.claims}`);
  }

  /* ═══════ [3] order: runtime bound, then gate, then claim ═══════ */
  console.log("\n[3] Order");
  {
    await drain();
    await seed("bound-first.test");
    const r = await runWith([ALLOW], { ...OPTS, runtimeBound: { allowsNewClaim: () => false } });
    check("a runtime bound that declines a claim stops the loop before the gate is read",
      r.asked() === 0 && r.wire.claims === 0, `asked=${r.asked()} claims=${r.wire.claims}`);
    await drain();
  }

  /* ═══════ [4] paidExecutionGateFor over the real decision ═══════ */
  console.log("\n[4] paidExecutionGateFor");
  {
    let built = 0;
    const gate = paidExecutionGateFor(() => { built += 1; throw new Error("missing NEXT_PUBLIC_SUPABASE_URL"); }, ON("5"));
    const d = await gate();
    check("a service client that cannot be built is spend_ledger_unavailable",
      !d.ok && d.code === "spend_ledger_unavailable" && built === 1, JSON.stringify(d));
  }
  const cases: Array<[string, Record<string, string | undefined>, ReturnType<typeof fakeLedger>, PaidExecutionRefusal | "ok"]> = [
    ["switch missing", {}, fakeLedger(ONE_QUEUED), "paid_execution_disabled"],
    ["switch not exactly \"true\"", { ZYPACT_PAID_EXECUTION_ENABLED: "TRUE ", ZYPACT_DAILY_SPEND_CEILING_USD: "5" }, fakeLedger(ONE_QUEUED), "paid_execution_disabled"],
    ["ceiling missing", { ZYPACT_PAID_EXECUTION_ENABLED: "true" }, fakeLedger(ONE_QUEUED), "spend_ceiling_not_configured"],
    ["ceiling not a number", ON("five"), fakeLedger(ONE_QUEUED), "spend_ceiling_not_configured"],
    ["ceiling zero", ON("0"), fakeLedger(ONE_QUEUED), "spend_ceiling_not_configured"],
    ["ceiling above the $50 hard maximum", ON("51"), fakeLedger(ONE_QUEUED), "spend_ceiling_not_configured"],
    ["ledger unreadable", ON("5"), fakeLedger(ONE_QUEUED, { failOn: "protocol_external_calls" }), "spend_ledger_unavailable"],
    ["ledger window incomplete", ON("5"), fakeLedger(ONE_QUEUED, { countBonus: 1 }), "spend_ledger_unavailable"],
    ["budget exceeded (24h spend + largest claimable cap > ceiling)", ON("3"), fakeLedger({
      ...ONE_QUEUED,
      protocol_external_calls: [{ created_at: recent, reserved_cost_usd: 1.5, actual_cost_usd: 1.5, cost_basis: "measured" }],
    }), "spend_ceiling_reached"],
    ["within budget", ON("5"), fakeLedger(ONE_QUEUED), "ok"],
  ];
  for (const [label, env, ledger, want] of cases) {
    const d = await paidExecutionGateFor(() => ledger.client, env)();
    const got = d.ok ? "ok" : d.code;
    check(`${label} → ${want}`, got === want, got);
    if (want === "paid_execution_disabled" || want === "spend_ceiling_not_configured") {
      check(`${label}: decided from configuration, the ledger is not read`, ledger.reads.length === 0, ledger.reads.join(","));
    }
  }
  {
    // The real gate inside the real loop: refused before any claim.
    await drain();
    await seed("real-gate.test");
    const h = harness();
    const ledger = fakeLedger({ ...ONE_QUEUED, protocol_external_calls: [{ created_at: recent, reserved_cost_usd: 1.5, actual_cost_usd: 1.5, cost_basis: "measured" }] });
    const seen: IterationResult[] = [];
    // A safety stop, so a loop that ignored the gate fails here instead of polling for ever.
    const stop = { aborted: false };
    await runWorkerLoop(h.deps, OPTS, paidExecutionGateFor(() => ledger.client, ON("3")), stop, async () => {},
      (r) => { seen.push(r); if (seen.length >= 3) stop.aborted = true; }, new WorkerHealth(h.deps.now));
    check("the real gate in the real loop: over budget → no claim, no request",
      seen[0]?.detail === "spend_ceiling_reached" && h.wire.claims === 0 && h.wire.fetches === 0, JSON.stringify(seen));
    await drain();
  }

  /* ═══════ [6] the world may move while the gate is awaited ═══════ */
  console.log("\n[6] Re-checked after the gate resolves");
  for (const variant of ["stop_requested", "bound_exhausted", "both_valid"] as const) {
    await drain();
    const { protocolId } = await seed(`pending-${variant}.test`);
    const h = harness();
    const signal = { aborted: false };
    let room = true;
    let boundAsked = 0;
    const bound = { allowsNewClaim: () => { boundAsked += 1; return room; } };
    // A gate that stays pending until the test releases it with ALLOW.
    let release: (d: PaidExecutionDecision) => void = () => {};
    let asked = 0;
    const gate: PaidExecutionGate = () => {
      asked += 1;
      if (asked > 1) return Promise.resolve(refuse("paid_execution_disabled"));
      return new Promise<PaidExecutionDecision>((res) => { release = res; });
    };
    const seen: IterationResult[] = [];
    const loop = runWorkerLoop(h.deps, { ...OPTS, exitAfterClaimedJob: true, runtimeBound: bound }, gate, signal,
      async () => {}, (r) => seen.push(r), new WorkerHealth(h.deps.now));
    // Let the loop reach the pending gate.
    for (let i = 0; i < 5 && asked === 0; i += 1) await Promise.resolve();
    const pendingAtGate = asked === 1 && h.wire.claims === 0;
    if (variant === "stop_requested") signal.aborted = true;
    if (variant === "bound_exhausted") room = false;
    release(ALLOW);
    await loop;
    const label = variant === "stop_requested" ? "ALLOW after a stop was requested"
      : variant === "bound_exhausted" ? "ALLOW after the runtime bound ran out" : "ALLOW with stop and bound still valid";
    check(`${label}: the loop was parked on the pending gate, nothing claimed yet`, pendingAtGate);
    if (variant === "both_valid") {
      check(`${label}: exactly one normal claim, and its job ran`,
        h.wire.claims === 1 && h.wire.admissions === 1 && h.wire.fetches === 1 && seen.length === 1 && seen[0].outcome === "completed",
        `${JSON.stringify(h.wire)} ${JSON.stringify(seen.map((x) => x.outcome))}`);
      check(`${label}: the bound was asked before and again after the gate`, boundAsked === 2, String(boundAsked));
    } else {
      check(`${label}: no claim, reservation, request or analysis`,
        h.wire.claims === 0 && h.wire.admissions === 0 && h.wire.fetches === 0 && h.wire.analyses === 0, JSON.stringify(h.wire));
      check(`${label}: stopped without a refusal event and without asking the gate again`,
        seen.length === 0 && asked === 1, `seen=${JSON.stringify(seen)} asked=${asked}`);
      const c = await db.claimProtocolExecutionJob({ workerId: "inspector", leaseSeconds: 60 });
      check(`${label}: the queued job is untouched and still claimable`,
        c.job?.protocolId === protocolId && c.job?.attemptCount === 1, JSON.stringify(c.job?.attemptCount));
      if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
    }
  }
  await drain();

  /* ═══════ [5] static protection ═══════ */
  console.log("\n[5] Static protection");
  const entry = readFileSync("scripts/run-protocol-worker.ts", "utf8");
  const workerSrc = readFileSync("lib/protocol-worker/worker.ts", "utf8");
  const live = entry.slice(entry.indexOf("async function runLive"), entry.indexOf("async function main"));
  const disabled = entry.slice(entry.indexOf("async function runDisabled"), entry.indexOf("async function runLive"));

  const entryWired = (src: string): boolean => {
    const liveSrc = src.slice(src.indexOf("async function runLive"), src.indexOf("async function main"));
    return /const paidExecutionGate = paidExecutionGateFor\(getReportServiceClient, process\.env\);/.test(liveSrc)
      && /await runWorkerLoop\(deps, opts, paidExecutionGate, signal, sleep,/.test(liveSrc);
  };
  check("the entry builds the gate from the explicit service-role client and passes it to the loop", entryWired(entry));
  check("…and that pin fails if the loop is handed another gate",
    !entryWired(entry.replace("runWorkerLoop(deps, opts, paidExecutionGate,", "runWorkerLoop(deps, opts, async () => ({ ok: true }) as never,")));
  for (const mod of ["@/lib/worker-control/paid-execution-gate", "@/lib/reports/service-client"]) {
    check(`\`${mod}\` is imported dynamically, in the live branch only`,
      live.includes(`import("${mod}")`) && !new RegExp(`^import [^;]*"${mod.replace(/[/@]/g, "\\$&")}";`, "m").test(entry));
  }
  for (const token of ["paidExecutionGate", "getReportServiceClient", "paid-execution-gate", "service-client"]) {
    check(`the disabled (inert) path never mentions \`${token}\``, !disabled.includes(token));
  }
  const serviceClient = readFileSync("lib/reports/service-client.ts", "utf8");
  check("the gate's client is service-role only, with no memory-adapter fallback",
    /SUPABASE_SERVICE_ROLE_KEY/.test(serviceClient) && /throw new Error/.test(serviceClient) && !/memory/i.test(serviceClient));

  const loopBody = (src: string): string => {
    const at = src.indexOf("export async function runWorkerLoop(");
    return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at));
  };
  const gatedBeforeClaim = (src: string): boolean => {
    const body = loopBody(src);
    const bound = body.indexOf("opts.runtimeBound.allowsNewClaim()");
    const gate = body.indexOf("await paidExecutionGate()");
    const iterate = body.indexOf("await runOneIteration(");
    const recheck = body.search(/if \(signal\.aborted\) break;\s*if \(!opts\.runtimeBound\.allowsNewClaim\(\)\) break;/);
    return bound > 0 && gate > bound && recheck > gate && iterate > recheck && /if \(!paid\.ok\) \{[\s\S]{0,200}?break;/.test(body)
      && /paidExecutionGate: PaidExecutionGate,/.test(body);
  };
  check("the loop asks the gate after the runtime bound, re-asks stop and bound after it, then claims; breaks on refusal",
    gatedBeforeClaim(workerSrc));
  check("…and that pin fails when the post-gate re-check is removed",
    !gatedBeforeClaim(workerSrc.replace(/    if \(signal\.aborted\) break;\n    if \(!opts\.runtimeBound\.allowsNewClaim\(\)\) break;\n/, "")));
  check("…and that pin fails when the gate call is removed",
    !gatedBeforeClaim(workerSrc.replace("paid = await paidExecutionGate();", "paid = { ok: true } as never;")));

  // No non-test production code may reach the ungated iteration, or a loop
  // without the gate. Scanned: lib/, app/, scripts/ except test files.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
      if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) files.push(p);
    }
  };
  for (const root of ["lib", "app", "scripts"]) walk(root);
  const production = files.filter((f) => !/^scripts\/test-/.test(f) && !/\.test\.tsx?$/.test(f));
  const sources: Array<[string, string]> = production.map((f) => [f, readFileSync(f, "utf8")]);
  /** Files that CALL `name` (its own definition is not a call). */
  const callers = (name: string, entries: Array<[string, string]>) =>
    entries
      .filter(([, src]) => new RegExp(`\\b${name}\\s*\\(`).test(src.replace(new RegExp(`export async function ${name}\\(`, "g"), "")))
      .map(([f]) => f);
  const iterationCallers = callers("runOneIteration", sources);
  check("runOneIteration is called only inside lib/protocol-worker/worker.ts (by the gated loop)",
    iterationCallers.length === 1 && iterationCallers[0] === path.join("lib", "protocol-worker", "worker.ts"), iterationCallers.join(","));
  check("…and only once there — inside runWorkerLoop",
    (workerSrc.match(/\brunOneIteration\s*\(/g) ?? []).length === 2 && loopBody(workerSrc).includes("await runOneIteration("));
  const loopCallers = callers("runWorkerLoop", sources);
  check("runWorkerLoop has exactly one production caller: the worker entry",
    loopCallers.length === 1 && loopCallers[0] === path.join("scripts", "run-protocol-worker.ts"), loopCallers.join(","));
  check("…and that scan would catch a new ungated caller",
    callers("runOneIteration", [...sources, ["app/planted.ts", "await runOneIteration(deps, opts, health);"]]).length === 2);

  check("global fetch was never called", globalFetchCalls === 0, String(globalFetchCalls));
  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
