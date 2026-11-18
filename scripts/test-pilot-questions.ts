#!/usr/bin/env tsx
/**
 * Pilot questions (D-054), offline.
 *
 *   M  the memory mirrors of create_pilot, add_pilot_question, close_pilot,
 *      retire_pilot_question and the pilot gates of the Run request, the
 *      requested claim and the retry, branch for branch, including a retest
 *      of a pilot baseline;
 *   W  the real worker loop on the memory adapter: a pilot question's Run
 *      claims that question's job only, its five runs send the approved
 *      question for the pilot's company, and a closed pilot runs nothing;
 *   S  static contracts: the migration (including the parity checks of
 *      the three redefinitions and the launch sequence against pilot step
 *      1), the routes, the pages and the preflight;
 *   C  copy: the Run confirmation, refusals and labels;
 *   E  D-061: the engines of a slot and the web host's ChatGPT gate;
 *   R  D-061: the console's reads, keyed by question and engine;
 *   H  D-061: adding ChatGPT, the add-question follow-up, resolving a
 *      measurement held for review, and the Run and Retry routes' engine
 *      and gate checks, through the code the routes run; (review of phase
 *      B) the add-question route's reply when ChatGPT is not added, and the
 *      retire route's words with the gate off;
 *   V  (review of phase B) one engine's cell of the pilot page, rendered:
 *      with the gate off ChatGPT offers no Run, Resume or Retry.
 *
 * The same rules against a real PostgreSQL are in test-pilot-questions-db.ts.
 * No database, no network, no provider.
 */
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DbAdapter, Protocol, ProtocolExecutionJob } from "@/lib/db/types";
import { sha256Hex } from "@/lib/evidence/hash";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import { runWorkerLoop } from "@/lib/protocol-worker/worker";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { parseMigrationName } from "./lib/migration-names";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

const FOUNDER = "11111111-1111-4111-8111-111111111111";
const ANSWER = "Acme Rival and Pilot Co are both options.";
const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const M5 = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "" });
const BODY = JSON.stringify({ id: "r", choices: [{ message: { content: ANSWER } }] });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysAhead = (n: number) => daysAgo(-n);

const OPTS: WorkerOptions = {
  workerId: "pilot-questions", leaseSeconds: 30, idleBackoffMs: 1, maxBackoffMs: 2,
  maxSlotsPerClaim: 7, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
  exitAfterClaimedJob: true, claimScope: "requested", providerTimeoutMs: 45000,
  runtimeBound: { allowsNewClaim: (): boolean => true },
};
const PAID_GATE_ALLOWS = async () => ({ ok: true as const, ceilingUsd: 10, spentLast24hUsd: 0, nextJobCapUsd: 0 });

interface Store {
  protocols: Map<string, Protocol>;
  protocolExecutionJobs: Map<string, ProtocolExecutionJob>;
  protocolAttempts: Map<string, { protocolId: string; status: string }>;
  buyerQuestionVersions: Map<string, { id: string; provenance: string; rationale: string; promptText: string; promptHash: string }>;
  pilots: Map<string, { id: string; endsOn: string; startsOn: string; status: string }>;
  pilotQuestions: Map<string, { id: string; pilotId: string; ordinal: number }>;
  pilotQuestionProtocols: Map<string, { pilotQuestionId: string; protocolId: string; engine: string; phase: string }>;
}
const store = () => (globalThis as unknown as Record<string, Store>)["__zypact_memory_store__"];

const throwsWith = async (fn: () => Promise<unknown>, message: string): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof Error && error.message === message;
  }
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  const createInput = (domain: string, over: Partial<Parameters<DbAdapter["createPilot"]>[0]> = {}) => ({
    createdBy: FOUNDER,
    companyName: `Pilot Co ${domain}`,
    websiteUrl: `https://${domain}`,
    normalizedDomain: domain,
    siteControlNote: "The customer added the DNS record we sent them.",
    questionLimit: 15,
    startsOn: today(),
    idempotencyKey: randomUUID(),
    ...over,
  });
  const question = (n: number) => `Which pilot analytics tools suit a shop of ${n} people?`;
  const addInput = (pilotId: string, text: string, over: Partial<Parameters<DbAdapter["addPilotQuestion"]>[0]> = {}) => ({
    pilotId,
    addedBy: FOUNDER,
    questionText: text,
    promptHash: sha(text),
    questionProvenance: "customer_supplied" as const,
    customerApprovalRef: "Email 'Pilot questions' of 12 Nov",
    customerApprovedOn: today(),
    idempotencyKey: randomUUID(),
    ...over,
  });

  /* M: memory mirrors ----------------------------------------------------- */
  console.log("[M] memory mirrors");
  check("M1 a pilot without a website-control note is refused",
    await throwsWith(() => db.createPilot(createInput("m1.example", { siteControlNote: "short" })), "invalid_create_pilot_args"));
  check("M2 a question limit above 20 is refused",
    await throwsWith(() => db.createPilot(createInput("m2.example", { questionLimit: 21 })), "invalid_create_pilot_args"));
  const cIn = createInput("pilot-m.example");
  const created = await db.createPilot(cIn);
  check("M3 a pilot is created with its own project", created.outcome === "CREATED" && Boolean(created.pilotId && created.projectId));
  const pilot = store().pilots.get(created.pilotId!)!;
  const end = new Date(`${cIn.startsOn}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 90);
  check("M4 the pilot ends 90 days after it starts", pilot.endsOn === end.toISOString().slice(0, 10), pilot.endsOn);
  const replay = await db.createPilot(cIn);
  check("M5 a replay of the same key answers the same pilot",
    replay.outcome === "ALREADY_CREATED" && replay.pilotId === created.pilotId && replay.projectId === created.projectId);
  check("M6 the same key with a different body is a conflict",
    (await db.createPilot({ ...cIn, questionLimit: 10 })).outcome === "IDEMPOTENCY_KEY_CONFLICT");
  check("M7 a second open pilot for the website is refused",
    (await db.createPilot(createInput("pilot-m.example"))).outcome === "DOMAIN_HAS_LIVE_PILOT");
  await db.createFounderSnapshotRequest({
    workEmail: "p@busy.example", normalizedEmail: "p@busy.example", companyName: "Busy Co",
    websiteUrl: "https://busy.example", normalizedDomain: "busy.example", buyerCategory: question(0),
  });
  check("M8 a website with a request in progress cannot start a pilot",
    (await db.createPilot(createInput("busy.example"))).outcome === "DOMAIN_HAS_LIVE_REQUEST");

  const pid = created.pilotId!;
  const first = await db.addPilotQuestion(addInput(pid, question(1)));
  check("M9 an approved question is added, with a protocol and a queued job",
    first.outcome === "ADDED" && Boolean(first.protocolId && first.jobId)
      && store().protocolExecutionJobs.get(first.jobId!)?.status === "queued");
  const slot = [...store().pilotQuestionProtocols.values()].find((s) => s.pilotQuestionId === first.pilotQuestionId)!;
  check("M10 its slot is Perplexity's baseline", slot.engine === "perplexity_sonar" && slot.phase === "baseline" && slot.protocolId === first.protocolId);

  // The protocol plan is the one a founder-created request's approval writes.
  const req = await db.createFounderSnapshotRequest({
    workEmail: "p@parity.example", normalizedEmail: "p@parity.example", companyName: "Parity Co",
    websiteUrl: "https://parity.example", normalizedDomain: "parity.example", buyerCategory: question(99),
  });
  const approved = await db.approveAndLaunchSnapshotBaseline(req.id, FOUNDER, ["Beta Co", "Gamma Co"], sha(question(99)), "customer_supplied");
  const ref = store().protocols.get(approved!.protocolId!)!;
  const mine = store().protocols.get(first.protocolId!)!;
  const PLAN_FIELDS = [
    "provider", "surface", "modelConfig", "plannedBaselineRuns", "plannedRetestRuns", "unitOfAnalysis", "primaryMetric",
    "minimumUsefulChange", "samplePlanningMethod", "samplePlanningAssumptions", "runCap", "spendCapUsd", "timeWindowSeconds",
    "rateLimitPerHour", "concurrencyLimit", "retryCap", "observationWindowRule", "analyzerVersion", "entityResolutionVersion",
    "methodologyVersion", "status", "detectableChangeAtPlan", "baselineProtocolId",
  ] as const;
  const differing = PLAN_FIELDS.filter((f) => JSON.stringify(mine[f]) !== JSON.stringify(ref[f]));
  check("M11 the pilot protocol's plan equals a request approval's, field by field", differing.length === 0, differing.join(","));
  check("M12 its plan sends exactly the approved question with its hash",
    JSON.stringify(mine.paraphrasePlan) === JSON.stringify([{ text: question(1), hash: sha(question(1)) }]));
  const refJob = [...store().protocolExecutionJobs.values()].find((j) => j.protocolId === ref.id)!;
  const myJob = store().protocolExecutionJobs.get(first.jobId!)!;
  check("M13 its job matches a request approval's job (claims, ordinal, status)",
    myJob.maxAttempts === refJob.maxAttempts && myJob.nextBaselineOrdinal === refJob.nextBaselineOrdinal && myJob.status === refJob.status);
  const version = store().buyerQuestionVersions.get(mine.buyerQuestionVersionId)!;
  check("M14 the version records the customer as supplier and the written approval in its rationale",
    version.provenance === "customer_supplied" && version.rationale.includes("approved by the customer in writing")
      && version.promptText === question(1) && version.promptHash === sha(question(1)));

  const replayQ = addInput(pid, question(2));
  const second = await db.addPilotQuestion(replayQ);
  const again = await db.addPilotQuestion(replayQ);
  check("M15 a replayed key answers the same question, protocol and job",
    again.outcome === "ALREADY_ADDED" && again.pilotQuestionId === second.pilotQuestionId
      && again.protocolId === second.protocolId && again.jobId === second.jobId);
  check("M16 the same key for a different question is a conflict",
    (await db.addPilotQuestion({ ...replayQ, questionText: question(3), promptHash: sha(question(3)) })).outcome === "IDEMPOTENCY_KEY_CONFLICT");
  check("M17 the same question twice is refused", (await db.addPilotQuestion(addInput(pid, question(1)))).outcome === "DUPLICATE_QUESTION");
  check("M18 a hash that is not the text's is refused",
    (await db.addPilotQuestion(addInput(pid, question(4), { promptHash: sha("something else") }))).outcome === "HASH_MISMATCH");
  check("M19 a question without its supplier is refused",
    await throwsWith(() => db.addPilotQuestion(addInput(pid, question(5), { questionProvenance: null as never })), "question_provenance_required"));
  check("M20 a question without the customer's approval reference is refused",
    await throwsWith(() => db.addPilotQuestion(addInput(pid, question(6), { customerApprovalRef: " " })), "invalid_add_pilot_question_args"));
  check("M21 an approval dated in the future is refused",
    await throwsWith(() => db.addPilotQuestion(addInput(pid, question(7), { customerApprovedOn: "2999-01-01" })), "invalid_add_pilot_question_args"));
  check("M22 a question that is not trimmed is refused",
    await throwsWith(() => db.addPilotQuestion(addInput(pid, ` ${question(8)}`, { promptHash: sha(` ${question(8)}`) })), "invalid_add_pilot_question_args"));
  check("M23 an unknown pilot answers not found", (await db.addPilotQuestion(addInput(randomUUID(), question(9)))).outcome === "PILOT_NOT_FOUND");

  const full = await db.createPilot(createInput("pilot-full.example", { questionLimit: 20 }));
  let added = 0;
  for (let n = 1; n <= 20; n += 1) {
    if ((await db.addPilotQuestion(addInput(full.pilotId!, question(100 + n)))).outcome === "ADDED") added += 1;
  }
  check("M24 a 20-question pilot takes 20 questions", added === 20);
  check("M25 the 21st question is refused", (await db.addPilotQuestion(addInput(full.pilotId!, question(121)))).outcome === "LIMIT_REACHED");
  const ordinals = [...store().pilotQuestions.values()].filter((q) => q.pilotId === full.pilotId).map((q) => q.ordinal).sort((a, b) => a - b);
  check("M26 the questions are numbered 1 to 20", ordinals.join(",") === Array.from({ length: 20 }, (_, i) => i + 1).join(","));
  const fullProject = store().pilots.get(full.pilotId!) as unknown as { projectId: string };
  check("M27 all 20 protocols belong to the pilot's one project",
    [...store().protocols.values()].filter((p) => p.projectId === fullProject.projectId).length === 20);

  // The Run gate.
  const runFor = (jobId: string) => {
    const job = store().protocolExecutionJobs.get(jobId)!;
    return db.requestProtocolJobRun({ jobId, projectId: job.projectId, via: "admin_pilot_run", requestedBy: FOUNDER, ttlSeconds: 120 });
  };
  const requested = await runFor(first.jobId!);
  check("M28 a Run for an open pilot's question is recorded under admin_pilot_run", requested.outcome === "REQUESTED");
  await db.cancelProtocolJobRunRequest(requested.requestId!);
  const ended = await db.createPilot(createInput("pilot-ended.example"));
  const endedQ = await db.addPilotQuestion(addInput(ended.pilotId!, question(200)));
  const endedRow = store().pilots.get(ended.pilotId!)!;
  store().pilots.set(ended.pilotId!, { ...endedRow, startsOn: daysAgo(91), endsOn: daysAgo(1) }); // test setup: a pilot past its end
  check("M29 a Run for a pilot past its end date is refused", (await runFor(endedQ.jobId!)).outcome === "PILOT_CLOSED");
  check("M30 a question cannot be added to a pilot past its end date",
    (await db.addPilotQuestion(addInput(ended.pilotId!, question(201)))).outcome === "PILOT_ENDED");

  check("M31 closing needs a reason", await throwsWith(() => db.closePilot({ pilotId: pid, closedBy: FOUNDER, reason: "no" }), "invalid_close_pilot_args"));
  check("M32 a pilot closes", (await db.closePilot({ pilotId: pid, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "CLOSED");
  check("M33 closing again replays", (await db.closePilot({ pilotId: pid, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "ALREADY_CLOSED");
  check("M34 an unknown pilot cannot be closed", (await db.closePilot({ pilotId: randomUUID(), closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "PILOT_NOT_FOUND");
  check("M35 a Run for a closed pilot's question is refused", (await runFor(first.jobId!)).outcome === "PILOT_CLOSED");
  check("M36 closing changed no job", store().protocolExecutionJobs.get(first.jobId!)?.status === "queued");
  check("M37 no question can be added to a closed pilot", (await db.addPilotQuestion(addInput(pid, question(10)))).outcome === "PILOT_CLOSED");
  check("M38 a replay still answers after the pilot closed", (await db.addPilotQuestion(replayQ)).outcome === "ALREADY_ADDED");
  check("M39 the website can start a new pilot once the old one is closed",
    (await db.createPilot(createInput("pilot-m.example"))).outcome === "CREATED");

  /* M: the review's fixes (D-054) ----------------------------------------- */
  console.log("\n[M] dates, closing, the claim barrier, retests and retiring");
  const setJob = (jobId: string, over: Partial<ProtocolExecutionJob>) => {
    const j = store().protocolExecutionJobs.get(jobId)!;
    store().protocolExecutionJobs.set(jobId, { ...j, ...over });
  };
  const setPilot = (pilotId: string, over: Record<string, unknown>) => {
    const row = store().pilots.get(pilotId)!;
    store().pilots.set(pilotId, { ...row, ...over } as typeof row);
  };
  const claimNow = () => db.claimRequestedProtocolExecutionJob({ workerId: "pilot-questions", leaseSeconds: 30 });
  const runRequestOf = (jobId: string) =>
    [...(store() as unknown as { protocolJobRunRequests: Map<string, { jobId: string; status: string; refusalCode: string | null }> })
      .protocolJobRunRequests.values()].filter((r) => r.jobId === jobId);

  // Finding 3: the start date is bounded, and a Run waits for it.
  check("M40 a start date two days ago is refused",
    (await db.createPilot(createInput("pilot-d1.example", { startsOn: daysAgo(2) }))).outcome === "START_DATE_OUT_OF_RANGE");
  check("M41 a start date 61 days ahead is refused",
    (await db.createPilot(createInput("pilot-d1.example", { startsOn: daysAhead(61) }))).outcome === "START_DATE_OUT_OF_RANGE");
  const fromYesterdayInput = createInput("pilot-d2.example", { startsOn: daysAgo(1) });
  const fromYesterday = await db.createPilot(fromYesterdayInput);
  const later = await db.createPilot(createInput("pilot-d3.example", { startsOn: daysAhead(60) }));
  check("M42 yesterday and 60 days ahead are accepted", fromYesterday.outcome === "CREATED" && later.outcome === "CREATED");
  check("M43 the replay is checked before the date window: the same key with an out-of-range date is a conflict",
    (await db.createPilot({ ...fromYesterdayInput, startsOn: daysAgo(5) })).outcome === "IDEMPOTENCY_KEY_CONFLICT");
  const laterQ = await db.addPilotQuestion(addInput(later.pilotId!, question(400)));
  check("M44 questions can be added before the start, but their Run is refused and nothing is recorded",
    laterQ.outcome === "ADDED" && (await runFor(laterQ.jobId!)).outcome === "PILOT_NOT_STARTED" && runRequestOf(laterQ.jobId!).length === 0);

  // Finding 1: a close waits for a pending Run or a live lease.
  const c1 = await db.createPilot(createInput("pilot-c1.example"));
  const c1q = await db.addPilotQuestion(addInput(c1.pilotId!, question(410)));
  const c1run = await runFor(c1q.jobId!);
  check("M45 a pilot with a pending Run cannot be closed",
    c1run.outcome === "REQUESTED"
      && (await db.closePilot({ pilotId: c1.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "PILOT_JOB_ACTIVE"
      && store().pilots.get(c1.pilotId!)?.status === "active");
  await db.cancelProtocolJobRunRequest(c1run.requestId!);
  check("M46 once the Run is withdrawn, it closes",
    (await db.closePilot({ pilotId: c1.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "CLOSED");
  const c2 = await db.createPilot(createInput("pilot-c2.example"));
  const c2q = await db.addPilotQuestion(addInput(c2.pilotId!, question(420)));
  setJob(c2q.jobId!, { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }); // test setup: a run in progress
  const c2busy = await db.closePilot({ pilotId: c2.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." });
  setJob(c2q.jobId!, { leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }); // test setup: its lease lapses
  check("M47 a measurement holding a live lease blocks the close; once its lease lapses, the pilot closes",
    c2busy === "PILOT_JOB_ACTIVE"
      && (await db.closePilot({ pilotId: c2.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "CLOSED");
  check("M48 the lapsed job of the closed pilot cannot be resumed", (await runFor(c2q.jobId!)).outcome === "PILOT_CLOSED");

  // Finding 1, second barrier: a request recorded before the pilot ended is refused at the claim.
  const c3 = await db.createPilot(createInput("pilot-c3.example"));
  const c3q = await db.addPilotQuestion(addInput(c3.pilotId!, question(430)));
  check("M49 a Run for an open pilot is recorded", (await runFor(c3q.jobId!)).outcome === "REQUESTED");
  setPilot(c3.pilotId!, { startsOn: daysAgo(91), endsOn: daysAgo(1) }); // test setup: the pilot ends while the request waits
  const c3claim = await claimNow();
  check("M50 the claim refuses that job, records the refusal, and leaves the job queued",
    c3claim.outcome === "PILOT_CLOSED" && c3claim.job === null
      && runRequestOf(c3q.jobId!).every((r) => r.status === "refused" && r.refusalCode === "PILOT_CLOSED")
      && store().protocolExecutionJobs.get(c3q.jobId!)?.status === "queued");

  // Finding 2: a retest of a pilot baseline is gated like the baseline.
  const r1 = await db.createPilot(createInput("pilot-r1.example"));
  const r1q = await db.addPilotQuestion(addInput(r1.pilotId!, question(440)));
  const baseline = store().protocols.get(r1q.protocolId!)!;
  const retestProtocol: Protocol = { ...baseline, id: randomUUID(), baselineProtocolId: baseline.id }; // test setup: what create_retest_protocol writes
  store().protocols.set(retestProtocol.id, retestProtocol);
  const baselineJob = store().protocolExecutionJobs.get(r1q.jobId!)!;
  const retestJob: ProtocolExecutionJob = { ...baselineJob, id: randomUUID(), protocolId: retestProtocol.id, status: "queued" };
  store().protocolExecutionJobs.set(retestJob.id, retestJob);
  const retestRun = await runFor(retestJob.id);
  check("M51 a pilot baseline's retest can be run while the pilot is open, and blocks its close",
    retestRun.outcome === "REQUESTED"
      && (await db.closePilot({ pilotId: r1.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." })) === "PILOT_JOB_ACTIVE");
  setPilot(r1.pilotId!, { status: "closed", closedBy: FOUNDER, closedAt: new Date().toISOString(), closeReason: "Closed for the test." }); // test setup
  check("M52 the claim refuses the closed pilot's retest", (await claimNow()).outcome === "PILOT_CLOSED");
  check("M53 a Run for the closed pilot's retest is refused", (await runFor(retestJob.id)).outcome === "PILOT_CLOSED");

  // Finding 4: retiring a question whose measurement cannot go on.
  const t1 = await db.createPilot(createInput("pilot-t1.example", { questionLimit: 3 }));
  const t1a = await db.addPilotQuestion(addInput(t1.pilotId!, question(450)));
  const t1b = await db.addPilotQuestion(addInput(t1.pilotId!, question(451)));
  const retire = (pilotQuestionId: string, pilotId = t1.pilotId!) =>
    db.retirePilotQuestion({ pilotId, pilotQuestionId, retiredBy: FOUNDER, reason: "The measurement cannot go on." });
  check("M54 a queued question cannot be retired", (await retire(t1a.pilotQuestionId!)) === "QUESTION_NOT_STOPPED");
  const t1aRun = await runFor(t1a.jobId!);
  check("M55 a question with a pending Run cannot be retired", (await retire(t1a.pilotQuestionId!)) === "QUESTION_JOB_ACTIVE");
  await db.cancelProtocolJobRunRequest(t1aRun.requestId!);
  // Test setup: run 1 failed at the provider (a terminal failed attempt in slot 1).
  setJob(t1a.jobId!, { status: "failed", failureReason: "provider_error", currentAttemptId: null, nextBaselineOrdinal: 1 });
  (store().protocolAttempts as unknown as Map<string, unknown>).set(randomUUID(), {
    id: randomUUID(), projectId: t1.projectId!, jobId: t1a.jobId!, protocolId: t1a.protocolId!, status: "failed",
    terminalizedAt: new Date().toISOString(), baselineOrdinal: 1, retryOfAttemptId: null,
  });
  check("M56 a provider failure that can still be retried is not retired", (await retire(t1a.pilotQuestionId!)) === "QUESTION_RETRYABLE");
  setJob(t1b.jobId!, { status: "abandoned_exhausted" }); // test setup: the worker stopped too many times
  check("M57 an abandoned question is retired, once", (await retire(t1b.pilotQuestionId!)) === "RETIRED"
    && (await retire(t1b.pilotQuestionId!)) === "ALREADY_RETIRED");
  check("M58 a retired question's Run is refused", (await runFor(t1b.jobId!)).outcome === "PILOT_QUESTION_RETIRED");
  const t1again = await db.addPilotQuestion(addInput(t1.pilotId!, question(451)));
  check("M59 its approved text can be added again, as a new question with the next ordinal",
    t1again.outcome === "ADDED" && t1again.pilotQuestionId !== t1b.pilotQuestionId
      && [...store().pilotQuestions.values()].find((q) => q.id === t1again.pilotQuestionId)?.ordinal === 3);
  check("M60 a live question's text is still a duplicate", (await db.addPilotQuestion(addInput(t1.pilotId!, question(450)))).outcome === "DUPLICATE_QUESTION");
  check("M61 the limit counts live questions only: a fourth is refused at 3 live",
    (await db.addPilotQuestion(addInput(t1.pilotId!, question(452)))).outcome === "ADDED"
      && (await db.addPilotQuestion(addInput(t1.pilotId!, question(453)))).outcome === "LIMIT_REACHED");
  check("M62 retiring needs a reason, and answers an unknown question",
    await throwsWith(() => db.retirePilotQuestion({ pilotId: t1.pilotId!, pilotQuestionId: t1a.pilotQuestionId!, retiredBy: FOUNDER, reason: "no" }), "invalid_retire_pilot_question_args")
      && (await retire(randomUUID())) === "QUESTION_NOT_FOUND");

  const t2 = await db.createPilot(createInput("pilot-t2.example", { questionLimit: 20 }));
  const t2qs = [];
  for (let n = 0; n < 6; n += 1) t2qs.push(await db.addPilotQuestion(addInput(t2.pilotId!, question(460 + n))));
  for (const q of t2qs) setJob(q.jobId!, { status: "abandoned_exhausted" }); // test setup
  const retiredFive = [];
  for (const q of t2qs.slice(0, 5)) retiredFive.push(await retire(q.pilotQuestionId!, t2.pilotId!));
  check("M63 at most 5 questions of a pilot are retired", retiredFive.every((o) => o === "RETIRED")
    && (await retire(t2qs[5].pilotQuestionId!, t2.pilotId!)) === "RETIRE_LIMIT_REACHED");

  // Smaller point: the retry refuses a closed pilot's job before reserving.
  const f1 = await db.createPilot(createInput("pilot-f1.example"));
  const f1q = await db.addPilotQuestion(addInput(f1.pilotId!, question(470)));
  setJob(f1q.jobId!, { status: "failed", failureReason: "provider_error", currentAttemptId: null }); // test setup
  await db.closePilot({ pilotId: f1.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." });
  const f1retry = await db.retryFailedProtocolJob({
    jobId: f1q.jobId!, projectId: f1.projectId!, actor: FOUNDER, reason: "Perplexity returned HTTP 500.",
    sourceAttemptId: randomUUID(), idempotencyKey: randomUUID(),
  });
  check("M64 a retry for a closed pilot's question is refused before anything is reserved",
    f1retry.outcome === "PILOT_CLOSED" && store().protocolExecutionJobs.get(f1q.jobId!)?.status === "failed");
  check("M65 a closed pilot's question cannot be retired",
    (await retire(f1q.pilotQuestionId!, f1.pilotId!)) === "PILOT_CLOSED");

  /* W: the worker loop ---------------------------------------------------- */
  console.log("\n[W] a pilot question's Run measures that question only");
  const prompts: Array<{ prompt: string; brandName?: string }> = [];
  const analysis: AnalysisTransport = {
    prepare: () => ({
      provider: "openai" as const, model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      rawRequestBody: REQ, requestSha256: sha256Hex(REQ),
    }),
    execute: async () => ({
      provider: "openai" as const, model: "gpt-4o-mini", content: M5, usedMock: false,
      modelReturned: null,
      latencyMs: 5, requestSha256: sha256Hex(REQ), contentSha256: sha256Hex(M5),
      providerRequestId: "ana", httpStatus: 200,
    }),
  };
  const deps: WorkerDeps = {
    db, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
    realFetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    runProbe: (async (input: { prompt: string; brandName?: string; fetchImpl?: typeof fetch }) => {
      await (input.fetchImpl ?? (async () => new Response("{}")))("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
      prompts.push({ prompt: input.prompt, brandName: input.brandName });
      return {
        prompt: input.prompt, answer: ANSWER, rawResponse: BODY, citations: [], searchResults: [],
        sourceCitations: [], model: "sonar", usedMock: false, rawResponseBody: BODY,
        rawResponseBodySha256: sha256Hex(BODY), httpStatus: 200, latencyMs: 7, providerRequestId: "r",
      };
    }) as WorkerDeps["runProbe"],
  };
  async function runLoop(): Promise<IterationResult[]> {
    const seen: IterationResult[] = [];
    await runWorkerLoop(deps, OPTS, PAID_GATE_ALLOWS, { aborted: false }, async () => undefined,
      (r) => seen.push(r), new WorkerHealth(() => Date.now()));
    return seen;
  }

  // Nothing else may be queued-and-requested from the sections above.
  const wPilot = await db.createPilot(createInput("pilot-w.example", { companyName: "Worker Pilot Co" }));
  const q1 = await db.addPilotQuestion(addInput(wPilot.pilotId!, question(301)));
  const q2 = await db.addPilotQuestion(addInput(wPilot.pilotId!, question(302), { questionProvenance: "founder_supplied" }));
  const idle = await runLoop();
  check("W1 with no Run pressed the worker claims nothing", idle.length === 1 && idle[0].detail === "NO_RUN_REQUEST"
    && store().protocolExecutionJobs.get(q1.jobId!)?.status === "queued", JSON.stringify(idle));
  check("W2 the Run for question 2 is recorded", (await runFor(q2.jobId!)).outcome === "REQUESTED");
  const ran = await runLoop();
  const q2Job = store().protocolExecutionJobs.get(q2.jobId!)!;
  check("W3 the worker measured question 2 to the end and left question 1 queued",
    ran.length === 1 && ran[0].jobId === q2.jobId && ran[0].outcome === "completed"
      && q2Job.status === "succeeded" && store().protocolExecutionJobs.get(q1.jobId!)?.status === "queued", JSON.stringify(ran));
  const q2Attempts = [...store().protocolAttempts.values()].filter((a) => a.protocolId === q2.protocolId);
  check("W4 five runs completed under question 2's protocol", q2Attempts.length === 5 && q2Attempts.every((a) => a.status === "completed"));
  check("W5 every run sent question 2's approved text for the pilot's company",
    prompts.length === 5 && prompts.every((p) => p.prompt === question(302) && p.brandName === "Worker Pilot Co"), JSON.stringify(prompts.slice(0, 1)));
  await db.closePilot({ pilotId: wPilot.pilotId!, closedBy: FOUNDER, reason: "Closing to check the Run gate." });
  check("W6 once the pilot is closed, question 1's Run is refused", (await runFor(q1.jobId!)).outcome === "PILOT_CLOSED");
  const after = await runLoop();
  check("W7 and the worker claims nothing", after.length === 1 && after[0].detail === "NO_RUN_REQUEST"
    && store().protocolExecutionJobs.get(q1.jobId!)?.status === "queued");
  const wEnd = await db.createPilot(createInput("pilot-w2.example", { companyName: "Worker Pilot Two" }));
  const wEndQ = await db.addPilotQuestion(addInput(wEnd.pilotId!, question(303)));
  check("W8 a Run for an open pilot's question is recorded", (await runFor(wEndQ.jobId!)).outcome === "REQUESTED");
  setPilot(wEnd.pilotId!, { startsOn: daysAgo(91), endsOn: daysAgo(1) }); // test setup: the pilot ends while the request waits
  const promptsBefore = prompts.length;
  const refused = await runLoop();
  check("W9 the worker's claim refuses it as a run request, calls no provider, and the job stays queued",
    refused.length === 1 && refused[0].outcome === "run_request_refused" && refused[0].detail === "PILOT_CLOSED"
      && prompts.length === promptsBefore && store().protocolExecutionJobs.get(wEndQ.jobId!)?.status === "queued",
    JSON.stringify(refused));

  /* S: static contracts ---------------------------------------------------- */
  console.log("\n[S] static contracts");
  const DIR = "supabase/migrations";
  const FILE = "20261109140000_pilot_questions.sql";
  const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok);
  const parsed = parseMigrationName(FILE);
  // Directly after pilot step 1: no migration sorts between them. Later
  // migrations (the pilot report, D-055) may follow it.
  check("S1 the migration name is valid and directly follows pilot step 1", parsed.ok && parsed.kind === "timestamp"
    && (parsed.ok ? parsed.version : 0) > 20261109130000
    && versions.some((r) => r.ok && r.version === 20261109130000)
    && !versions.some((r) => r.ok && r.version > 20261109130000 && r.version < (parsed.ok ? parsed.version : 0)));
  const sql = read(path.join(DIR, FILE));
  const code = sql.replace(/--[^\n]*/g, "");
  const defined = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)/gi)].map((m) => m[1]).sort();
  check("S2 it defines exactly the four pilot functions and the three step 1 redefinitions",
    defined.join(",") === [
      "add_pilot_question", "claim_requested_protocol_execution_job", "close_pilot", "create_pilot",
      "request_protocol_job_run", "retire_pilot_question", "retry_failed_protocol_job",
    ].join(","), defined.join(","));
  const blocks = code.split(/create\s+or\s+replace\s+function/i).slice(1);
  check("S3 every function is SECURITY DEFINER with search_path pinned",
    blocks.length === 7 && blocks.every((b) => /security definer/i.test(b) && /set search_path = public, pg_temp/i.test(b)));
  const SIGNATURES = [
    "create_pilot(uuid, text, text, text, text, integer, date, uuid)",
    "add_pilot_question(uuid, uuid, text, text, text, text, date, uuid)",
    "close_pilot(uuid, uuid, text)",
    "retire_pilot_question(uuid, uuid, uuid, text)",
    "request_protocol_job_run(uuid, uuid, text, uuid, integer)",
    "claim_requested_protocol_execution_job(text, integer)",
    "retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text)",
  ];
  check("S4 each function is revoked from public, anon and authenticated and granted to service_role only",
    SIGNATURES.every((s) => ["public", "anon", "authenticated"].every((r) => code.includes(`revoke all on function public.${s} from ${r};`))
      && code.includes(`grant execute on function public.${s} to service_role;`)));
  const TABLES = ["pilots", "pilot_questions", "pilot_question_protocols"];
  check("S5 the three tables have RLS on, no policy, and are read-only to service_role",
    TABLES.every((t) => code.includes(`alter table public.${t} enable row level security;`)
      && code.includes(`revoke all on table public.${t} from public, anon, authenticated, service_role;`)
      && code.includes(`grant select on table public.${t} to service_role;`))
      && !/create\s+policy/i.test(code) && !/grant\s+(insert|update|delete|all)/i.test(code));
  // D-053 item 3: this migration opens Perplexity's baseline slot only.
  // ChatGPT phase B (20261109180000, D-061) widens the engine to
  // openai_chatgpt; the phase stays baseline until the pilot retest.
  const phaseB = read(path.join(DIR, "20261109180000_chatgpt_measurement.sql")).replace(/--[^\n]*/g, "");
  check("S6 this migration allows only Perplexity's baseline slot; phase B (D-061) widens the engine to ChatGPT and leaves the phase baseline",
    code.includes("engine             text not null check (engine = 'perplexity_sonar')")
      && code.includes("phase              text not null check (phase = 'baseline')")
      && phaseB.includes("add constraint pilot_question_protocols_engine_check\n  check (engine in ('perplexity_sonar', 'openai_chatgpt'));")
      && !phaseB.includes("add constraint pilot_question_protocols_phase_check"));
  check("S7 a pilot holds at most 20 live questions (25 with retired ones) and lasts 90 days",
    code.includes("check (question_limit between 1 and 20)") && code.includes("check (ordinal between 1 and 25)")
      && code.includes("check (ends_on = starts_on + 90)") && code.includes("p_starts_on + 90"));
  check("S8 no evidence row is written directly",
    !/(insert\s+into|update|delete\s+from)\s+public\.(protocol_attempts|protocol_external_calls|provider_call_receipts|analysis_call_receipts|external_call_requests|probe_runs|probe_results)\b/i.test(code));
  check("S9 the only rows updated are a pilot's close, a question's retirement, and step 1's own job and request housekeeping",
    [...code.matchAll(/update\s+public\.([a-z_]+)/gi)].every((m) =>
      ["pilots", "pilot_questions", "protocol_job_run_requests", "protocol_execution_jobs"].includes(m[1])));
  check("S10 nothing from the account stack is referenced (it may apply before Q2'-1)",
    !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_s1_[a-z_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(code));
  const GUARDED = [
    "claim_protocol_execution_job", "claim_protocol_execution_job_by_id",
    "authorize_operator_retry", "reactivate_abandoned_job", "resolve_protocol_job_review",
    "complete_protocol_execution_job", "abort_attempt_and_fail_job_for_job", "admit_and_reserve_attempt_for_job",
    "_admit_and_reserve_attempt_core", "reconcile_attempt_for_job", "approve_protocol", "approve_buyer_question_version",
    "enqueue_protocol_execution_job", "approve_and_launch_snapshot_baseline", "create_snapshot_request_as_founder",
    "begin_snapshot_report_delivery",
  ];
  check("S11 it redefines none of the guarded approval, queue, older claim, retry or request functions",
    GUARDED.every((fn) => !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i").test(code)));
  check("S12 the requested_via CHECK keeps step 1's four starts and adds admin_pilot_run only",
    code.includes("check (requested_via in (\n    'admin_run_pipeline', 'admin_run_retest',\n    'admin_founder_baseline', 'operator_cli', 'admin_pilot_run'\n  ));"));
  check("S12b the refusal_code CHECK keeps step 1's three codes and adds PILOT_CLOSED only",
    code.includes("check (refusal_code in ('JOB_NOT_FOUND', 'JOB_NOT_ELIGIBLE', 'JOB_LOCKED', 'PILOT_CLOSED'));"));

  // Parity 1: request_protocol_job_run is step 1's, with two changes only.
  const step1 = read(path.join(DIR, "20261109130000_pilot_step1_operator_controls.sql"));
  const fnOf = (src: string, name: string) => {
    const start = src.indexOf(`create or replace function public.${name}(`);
    return src.slice(start, src.indexOf("\n$$;\n", start) + 5);
  };
  const actualRun = fnOf(sql, "request_protocol_job_run");
  const pilotBlock = actualRun.slice(
    actualRun.indexOf("\n  -- D-054: a pilot's measurement, its baseline"),
    actualRun.indexOf("\n  -- A dead lease with no claims left")
  );
  const PILOT_DECLARATIONS =
    "  -- D-054\n  v_pilot public.pilots%rowtype;\n  v_pilot_id uuid;\n  v_question_retired boolean := false;\n";
  let expectedRun = fnOf(step1, "request_protocol_job_run");
  const swapRun = (from: string, to: string) => {
    if (expectedRun.split(from).length !== 2) throw new Error(`step 1 no longer contains exactly once: ${from.slice(0, 60)}`);
    expectedRun = expectedRun.replace(from, to);
  };
  swapRun("  v_expires timestamptz;\nbegin", "  v_expires timestamptz;\n" + PILOT_DECLARATIONS + "begin");
  swapRun("'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli'\n     )",
    "'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli',\n       'admin_pilot_run'\n     )");
  const notFound = "  if not v_found then\n    return query select 'JOB_NOT_FOUND'::text, null::uuid, null::timestamptz;\n    return;\n  end if;\n";
  swapRun(notFound, notFound + pilotBlock);
  check("S13 request_protocol_job_run is pilot step 1's, byte for byte, apart from admin_pilot_run, three declarations and the pilot block",
    pilotBlock.length > 0 && actualRun === expectedRun);
  const RETEST_MATCH = "or pqp.protocol_id = (\n        select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id\n      )";
  check("S14 the pilot block covers a retest of a pilot baseline, locks the pilot FOR SHARE, and refuses closed, ended, not started and retired",
    pilotBlock.includes(RETEST_MATCH)
      && pilotBlock.includes("where pl.id = v_pilot_id\n     for share;")
      && pilotBlock.includes("v_pilot.status <> 'active' or current_date > v_pilot.ends_on")
      && pilotBlock.includes("current_date < v_pilot.starts_on")
      && ["'PILOT_CLOSED'::text", "'PILOT_NOT_STARTED'::text", "'PILOT_QUESTION_RETIRED'::text"].every((o) => pilotBlock.includes(o))
      && actualRun.indexOf(pilotBlock) > actualRun.indexOf("for update nowait")
      && actualRun.indexOf(pilotBlock) < actualRun.indexOf("insert into public.protocol_job_run_requests"));

  // Parity 1b: the requested claim is step 1's, apart from its pilot block.
  const actualClaim = fnOf(sql, "claim_requested_protocol_execution_job");
  const claimBlock = actualClaim.slice(
    actualClaim.indexOf("  -- D-054: the second barrier."),
    actualClaim.indexOf("  if not (\n    v_job.status = 'queued'")
  );
  const claimAnchor = "    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs, null::uuid;\n    return;\n  end if;\n\n";
  const step1Claim = fnOf(step1, "claim_requested_protocol_execution_job");
  check("S29 claim_requested_protocol_execution_job is pilot step 1's, byte for byte, apart from the pilot block after the job is found",
    claimBlock.length > 0 && step1Claim.split(claimAnchor).length === 2
      && actualClaim === step1Claim.replace(claimAnchor, claimAnchor + claimBlock));
  check("S30 the claim's pilot block covers retests, refuses closed, ended, not started and retired, and records the refusal",
    claimBlock.includes("select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id")
      && ["pl.status <> 'active'", "current_date > pl.ends_on", "current_date < pl.starts_on", "pq.retired_at is not null"].every((c) => claimBlock.includes(c))
      && claimBlock.includes("refusal_code = 'PILOT_CLOSED'")
      && claimBlock.includes("'PILOT_CLOSED'::text, null::public.protocol_execution_jobs, null::uuid"));

  // Parity 1c: the provider-failure retry is step 1's, apart from its declarations and pilot block.
  const actualRetry = fnOf(sql, "retry_failed_protocol_job");
  const retryBlock = actualRetry.slice(
    actualRetry.indexOf("  -- D-054: a pilot's measurement is retried only"),
    actualRetry.indexOf("  select pa.* into v_source")
  );
  const retryAnchor = "  if found and v_request_status <> 'approved' then\n    return query select 'REQUEST_NOT_OPEN'::text, null::text, null::uuid;\n    return;\n  end if;\n\n";
  let expectedRetry = fnOf(step1, "retry_failed_protocol_job");
  const retryDeclOld = "  v_replay_analysis numeric;\nbegin";
  const retryParts = [expectedRetry.split(retryAnchor).length, expectedRetry.split(retryDeclOld).length];
  expectedRetry = expectedRetry.replace(retryDeclOld, "  v_replay_analysis numeric;\n" + PILOT_DECLARATIONS + "begin")
    .replace(retryAnchor, retryAnchor + retryBlock);
  check("S31 retry_failed_protocol_job is pilot step 1's, byte for byte, apart from three declarations and the pilot block after the request check",
    retryBlock.length > 0 && retryParts.join(",") === "2,2" && actualRetry === expectedRetry);
  check("S32 the retry's pilot block covers retests, locks the pilot FOR SHARE and refuses before the source run is read or anything reserved",
    retryBlock.includes("select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id")
      && retryBlock.includes("for share;")
      && ["v_pilot.status <> 'active'", "current_date > v_pilot.ends_on", "current_date < v_pilot.starts_on", "v_question_retired"].every((c) => retryBlock.includes(c))
      && actualRetry.indexOf(retryBlock) < actualRetry.indexOf("from public.authorize_operator_retry(\n      p_job_id, p_project_id, p_actor::text, btrim(p_reason), 'retry_full_attempt',\n      v_source.id"));

  // Parity 2: add_pilot_question launches exactly as approve_and_launch does.
  const segment = (src: string) => {
    const start = src.indexOf("  insert into public.buyer_question_versions (");
    const endMarker = "message = format('unexpected_protocol_execution_job_enqueue_status:%s', v_enqueue_status);\n  end if;\n";
    return src.slice(start, src.indexOf(endMarker, start) + endMarker.length);
  };
  const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const launchSrc = step1.slice(step1.indexOf("create or replace function\n  public.approve_and_launch_snapshot_baseline("));
  const expectedLaunch = strip(segment(launchSrc))
    .split("v_request.buyer_category").join("p_question_text")
    .split("p_approved_by").join("p_added_by")
    .split("v_provenance").join("p_question_provenance");
  const actualLaunch = strip(segment(fnOf(sql, "add_pilot_question")));
  check("S15 the version, M4 approval, protocol plan, protocol approval and queue are approve_and_launch's, comments aside",
    expectedLaunch.length > 500 && actualLaunch === expectedLaunch,
    actualLaunch.length + "/" + expectedLaunch.length);

  const addFn = fnOf(sql, "add_pilot_question");
  check("S16 the hash is re-checked in SQL against the exact text before anything is created",
    addFn.includes("encode(sha256(convert_to(p_question_text, 'UTF8')), 'hex') <> p_prompt_hash")
      && addFn.indexOf("HASH_MISMATCH") < addFn.indexOf("insert into public.buyer_questions"));
  check("S17 the pilot row is locked before the replay, state, duplicate and limit checks",
    addFn.indexOf("for update;") < addFn.indexOf("q.idempotency_key = p_idempotency_key")
      && addFn.indexOf("q.idempotency_key = p_idempotency_key") < addFn.indexOf("'PILOT_CLOSED'::text")
      && addFn.indexOf("'PILOT_CLOSED'::text") < addFn.indexOf("'LIMIT_REACHED'::text"));
  const createFn = fnOf(sql, "create_pilot");
  check("S18 create_pilot takes the request's per-website lock and refuses a live request or pilot",
    createFn.includes("hashtextextended('snapshot-domain:' || p_normalized_domain, 0)")
      && createFn.includes("'DOMAIN_HAS_LIVE_REQUEST'") && createFn.includes("'DOMAIN_HAS_LIVE_PILOT'")
      && ["pending_verification", "verified", "pending_approval", "approved", "queued", "running", "quality_review", "needs_founder_review"]
        .every((st) => createFn.includes(`'${st}'`)));
  const closeFn = fnOf(sql, "close_pilot");
  check("S19 close_pilot changes no job, and refuses while a baseline or retest holds a live lease or a pending request",
    !/update\s+public\.protocol_execution_jobs/i.test(closeFn)
      && closeFn.includes("'PILOT_JOB_ACTIVE'::text")
      && closeFn.includes("on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id")
      && closeFn.includes("j.status in ('claimed', 'running') and j.lease_expires_at > now()")
      && closeFn.includes("r.status = 'pending'\n              and r.expires_at > now()")
      && closeFn.indexOf("for update;") < closeFn.indexOf("'PILOT_JOB_ACTIVE'::text"));
  check("S19b create_pilot bounds the start date to [yesterday, today + 60], after the replay",
    createFn.includes("if p_starts_on < current_date - 1 or p_starts_on > current_date + 60 then")
      && createFn.indexOf("'IDEMPOTENCY_KEY_CONFLICT'::text") < createFn.indexOf("'START_DATE_OUT_OF_RANGE'::text"));
  check("S19c add_pilot_question ignores retired questions for duplicates and the limit, and never reuses an ordinal",
    addFn.includes("and q.prompt_hash = p_prompt_hash\n       and q.retired_at is null")
      && addFn.includes("select count(*) filter (where q.retired_at is null), count(*)\n    into v_count, v_total")
      && addFn.includes("p_pilot_id, v_project_id, v_total + 1, v_version_id")
      && code.includes("create unique index if not exists pilot_questions_one_live_prompt\n  on public.pilot_questions (pilot_id, prompt_hash)\n  where retired_at is null;")
      && !code.includes("pilot_questions_prompt_key"));
  const retireFn = fnOf(sql, "retire_pilot_question");
  check("S19d retire_pilot_question locks the pilot, takes only a stopped question that cannot be retried, at most 5, and changes no job",
    retireFn.indexOf("for update;") < retireFn.indexOf("'QUESTION_JOB_ACTIVE'::text")
      && retireFn.includes("if v_job.status not in ('failed', 'abandoned_exhausted') then")
      && retireFn.includes("'QUESTION_RETRYABLE'::text") && retireFn.includes("if v_retired >= 5 then")
      && retireFn.includes("v_job.failure_reason = 'provider_error'")
      && !/update\s+public\.protocol_execution_jobs/i.test(retireFn)
      && /update public\.pilot_questions\s+set retired_by = p_retired_by/.test(retireFn));

  // Routes.
  const R = "app/api/internal/pilots";
  const routeFiles = {
    create: `${R}/route.ts`,
    add: `${R}/[pilotId]/questions/route.ts`,
    close: `${R}/[pilotId]/close/route.ts`,
    run: `${R}/[pilotId]/questions/[pilotQuestionId]/run/route.ts`,
    retry: `${R}/[pilotId]/questions/[pilotQuestionId]/retry/route.ts`,
    retire: `${R}/[pilotId]/questions/[pilotQuestionId]/retire/route.ts`,
  };
  for (const key of ["create", "add", "close", "retry", "retire"] as const) {
    const src = read(routeFiles[key]);
    check(`S20 ${key}: the kill switch, then the founder guard, the actor from the session`,
      src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') > 0
        && src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') < src.indexOf("requireFounderForRoute(")
        && /(createdBy|addedBy|closedBy|retiredBy|actor): guard\.user\.id/.test(src));
  }
  const runSrc = read(routeFiles.run);
  check("S21 run: founder guard, then the pilot window, then the job state, then a start naming its job as admin_pilot_run",
    runSrc.indexOf("requireFounderForRoute(") > 0
      && runSrc.indexOf("pilotIsOver(") > runSrc.indexOf("requireFounderForRoute(")
      && ["\"failed\"", "\"abandoned_exhausted\"", "\"succeeded\"", "\"needs_review\""].every((s) => runSrc.indexOf(s) > 0 && runSrc.indexOf(s) < runSrc.indexOf("startWorkerMachine({"))
      && runSrc.includes('via: "admin_pilot_run"') && runSrc.includes("requestedBy: guard.user.id"));
  check("S21b run: refuses before the start date and for a retired question, and names retiring for an abandoned measurement",
    runSrc.indexOf("pilotNotStarted(") > runSrc.indexOf("pilotIsOver(") && runSrc.includes("target.retired")
      // D-062 — a retest's abandoned job has its own words; a baseline's still names retiring.
      && runSrc.includes('start.refusal === "JOB_ATTEMPTS_EXHAUSTED"\n        ? phase === "retest" ? RETEST_JOB_ABANDONED_TEXT : PILOT_JOB_ABANDONED_TEXT')
      && !runSrc.includes("Close the request"));
  const retrySrc = read(routeFiles.retry);
  check("S22 retry never starts the worker and never takes the failed run from the body",
    !retrySrc.includes("startWorkerMachine") && !retrySrc.includes("body.sourceAttemptId") && retrySrc.includes("pilotIsOver("));
  const PRIVATE = ["questionText", "customerApprovalRef", "companyName", "siteControlNote", "note", "reason", "websiteUrl"];
  const leaks = Object.entries(routeFiles).flatMap(([key, file]) => {
    const src = read(file);
    return [...src.matchAll(/console\.(?:info|log|error)\(\s*JSON\.stringify\(\{([\s\S]*?)\}\)/g)].flatMap((m) =>
      PRIVATE.filter((word) => new RegExp(`\\b${word}\\b`).test(m[1].replace(/parsed\.value\.(normalizedDomain|questionProvenance)/g, ""))).map((w) => `${key}:${w}`));
  });
  check("S23 no route logs the company, the website, a question, an approval reference, a note or a reason", leaks.length === 0, leaks.join(","));
  // D-061 — the two new handlers log through one helper; every call's fields are closed too.
  const handlerSrc = read("lib/pilots/engine-routes.ts");
  const infoCalls = [...handlerSrc.matchAll(/\binfo\("([a-z_]+)", \{([\s\S]*?)\}, deps\.log/g)];
  const handlerLeaks = infoCalls.flatMap((m) => PRIVATE.filter((word) => new RegExp(`\\b${word}\\b`).test(m[2])).map((w) => `${m[1]}:${w}`));
  check("S23b neither new handler logs a question, a note or a reason (closed fields only)",
    infoCalls.length === 3 && handlerLeaks.length === 0 && !/console\.(?:info|log|error|warn)\(/.test(handlerSrc),
    `${infoCalls.length} ${handlerLeaks.join(",")}`);
  const page = read("app/admin/pilots/[pilotId]/page.tsx");
  // Review of phase B (APP-8): the per-engine cell is its own component, rendered for real in section V.
  const cell = read("app/admin/pilots/pilot-engine-cell.tsx");
  check("S24 the pilot page shows ChatGPT as not measured and provenance in words, never the stored code",
    cell.includes("{ENGINE_NOT_MEASURED}") && page.includes("pilotProvenanceLabel(q.questionProvenance)")
      && !/>\s*\{q\.questionProvenance\}\s*</.test(page) && ![page, cell].some((s) => />\s*\{m\.jobStatus\}\s*</.test(s)));
  const adminPage = read("app/admin/snapshot-requests/page.tsx");
  check("S25 the founder-experiments list leaves pilot protocols out in the query, before its 20-row limit",
    adminPage.includes('jobsQuery = jobsQuery.not("protocol_id", "in", `(${pilotIds.join(",")})`);')
      && adminPage.indexOf("jobsQuery.not(") < adminPage.indexOf(".limit(20)")
      && adminPage.indexOf("await pilotProtocolIds(client)") < adminPage.indexOf("jobsQuery.not("));
  const fly = read("lib/worker-control/fly-machine.ts");
  check("S26 the start path accepts admin_pilot_run and has fixed words for PILOT_CLOSED",
    fly.includes('"admin_founder_baseline" | "admin_pilot_run"') && /PILOT_CLOSED:\s*\n\s*"This pilot is closed/.test(fly)
      && /PILOT_NOT_STARTED:\s*\n\s*"This pilot has not started/.test(fly) && /PILOT_QUESTION_RETIRED:\s*\n\s*"This pilot question was retired/.test(fly));
  const workerSrc = read("lib/protocol-worker/worker.ts");
  check("S26b the worker treats a claim refused for a closed pilot as a refused run request",
    /claimed\.outcome === "JOB_LOCKED" \|\|\s*\n\s*claimed\.outcome === "PILOT_CLOSED"\s*\n\s*\) \{\s*\n\s*return \{ outcome: "run_request_refused"/.test(workerSrc));
  const preflight = read("scripts/sql/prod-preflight.sql");
  check("S27 the preflight checks the version, the three tables and the three functions as absent",
    (preflight.match(/'20261109140000'/g) ?? []).length === 2
      && TABLES.every((t) => preflight.includes(`('${t}')`))
      && ["create_pilot", "add_pilot_question", "close_pilot", "retire_pilot_question"].every((f) => preflight.includes(`('${f}')`)));
  check("S28 the DB runner runs the pilot-questions database test",
    read("scripts/run-p2-workspace-db-local.sh").includes("npx tsx scripts/test-pilot-questions-db.ts"));

  // D-061 — two engines in the console: the routes' wiring.
  const ENGINE_CHOICE = "pilotEngineFromBody(body, { chatgptEnabled: pilotChatGptEnabled(), gated: true })";
  check("S33 run: the engine comes from the body through the gated choice, after the founder guard and before the slot read; the read takes that engine",
    runSrc.includes(ENGINE_CHOICE)
      && runSrc.indexOf(ENGINE_CHOICE) > runSrc.indexOf("requireFounderForRoute(")
      && runSrc.indexOf(ENGINE_CHOICE) < runSrc.indexOf("resolvePilotQuestionTarget(")
      // D-062 — and the phase (absent: the baseline), checked by the gated phase choice before the read.
      && runSrc.includes("resolvePilotQuestionTarget(getReportServiceClient(), pilotId, pilotQuestionId, engine, phase)")
      && runSrc.indexOf("pilotPhaseFromBody(body, {") < runSrc.indexOf("resolvePilotQuestionTarget(")
      && runSrc.indexOf("target.protocolId === null") > runSrc.indexOf("target.retired")
      && runSrc.indexOf("target.protocolId === null") < runSrc.indexOf("startWorkerMachine({")
      && !runSrc.includes("_request: Request"));
  check("S34 retry: the engine comes from the body through the gated choice, before the slot read; the read takes that engine; it still never starts the worker",
    retrySrc.includes(ENGINE_CHOICE)
      && retrySrc.indexOf(ENGINE_CHOICE) < retrySrc.indexOf("resolvePilotQuestionTarget(")
      && retrySrc.includes("resolvePilotQuestionTarget(client, pilotId, pilotQuestionId, engine, phase)")
      && retrySrc.indexOf("pilotPhaseFromBody(body, {") < retrySrc.indexOf("resolvePilotQuestionTarget(")
      && retrySrc.indexOf("target.protocolId === null") < retrySrc.indexOf("getDb().retryFailedProtocolJob(")
      && !retrySrc.includes("startWorkerMachine") && !retrySrc.includes("fly-machine"));
  const engineRouteFile = `${R}/[pilotId]/questions/[pilotQuestionId]/engines/route.ts`;
  const reviewRouteFile = `${R}/[pilotId]/questions/[pilotQuestionId]/review/route.ts`;
  const engineRouteSrc = read(engineRouteFile);
  const reviewRouteSrc = read(reviewRouteFile);
  check("S35 the two new routes are the handlers the tests run, with the process env, their own founder guard and the shared clients",
    engineRouteSrc.includes("return handleAddPilotQuestionEngine(request, await params, {")
      && engineRouteSrc.includes("env: process.env,") && engineRouteSrc.includes('guard: () => requireFounderForRoute("pilot-question-engine-add"),')
      && engineRouteSrc.includes("db: getDb,")
      && reviewRouteSrc.includes("return handleResolvePilotQuestionReview(request, await params, {")
      && reviewRouteSrc.includes("env: process.env,") && reviewRouteSrc.includes('guard: () => requireFounderForRoute("pilot-question-review"),')
      && reviewRouteSrc.includes("client: getReportServiceClient,")
      && [engineRouteSrc, reviewRouteSrc].every((s) => /^export async function POST\(/m.test(s) && !/export async function (GET|PUT|PATCH|DELETE)/.test(s)));
  // No new file reaches the worker starter, directly or through any import.
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(process.cwd(), spec.slice(2))
      : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      try { if (readFileSync(c, "utf8") !== undefined) return c; } catch { /* next */ }
    }
    return null;
  };
  const reachesFile = (entry: string, sink: string): boolean => {
    const seen = new Set<string>();
    const stack = [path.join(process.cwd(), entry)];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (f === path.join(process.cwd(), sink)) return true;
      if (seen.has(f)) continue;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const next = resolveImport(f, m[1] ?? m[2]);
        if (next) stack.push(next);
      }
    }
    return false;
  };
  const NEW_FILES = [engineRouteFile, reviewRouteFile, "lib/pilots/engine-routes.ts", "lib/pilots/engines.ts", "lib/reports/job-review.ts", "app/admin/pilots/pilot-engine-cell.tsx"];
  const starters = NEW_FILES.filter((f) => reachesFile(f, "lib/worker-control/fly-machine.ts")
    || reachesFile(f, "lib/probes/chatgpt.ts") || reachesFile(f, "lib/protocol-worker/chatgpt-engine.ts")
    || /startWorkerMachine|fly-machine/.test(read(f)));
  check("S36 no new route or helper reaches the worker starter, the ChatGPT adapter or the worker's engine, by any import",
    starters.length === 0 && reachesFile(routeFiles.run, "lib/worker-control/fly-machine.ts"), starters.join(","));
  check("S37 the add-question route adds ChatGPT only when asked, only after the question exists, through the shared follow-up with the gate read at request time",
    read(routeFiles.add).includes("(body as Record<string, unknown> | null)?.addChatGpt === true")
      && read(routeFiles.add).includes("wantsChatGpt && added && result.pilotQuestionId")
      && read(routeFiles.add).includes("chatgptEnabled: pilotChatGptEnabled(),")
      && read(routeFiles.add).indexOf("addChatGptAfterQuestion(") > read(routeFiles.add).indexOf("getDb().addPilotQuestion("));
  check("S38 the page reads the ChatGPT gate at request time and builds one cell per engine from it (no engine constant)",
    page.includes("const chatgptConnected = pilotChatGptEnabled();") && page.includes("const engines = pilotEngines(chatgptConnected);")
      && page.includes("{engines.map((e) => (") && page.includes("<PilotEngineCell")
      && page.includes("engine={e.key}") && page.includes("measurement={q.engines[e.key]}") && page.includes("connected={e.connected}")
      && !page.includes("PILOT_ENGINES") && !/q\.perplexity\b/.test(page));
  check("S39 the page passes each cell the gate's connection, Add ChatGPT when the gate is on, and the pilot's window; it offers Retire per question once any engine stopped (the cell's behaviour is rendered in section V)",
    page.includes("canAddChatGpt={canAddChatGpt}") && page.includes("retired={q.retiredAt !== null}")
      && page.includes("pilotOpen={!over && !notStarted && q.retiredAt === null}")
      && page.includes("const canAddChatGpt = chatgptConnected && !over;")
      && page.includes("{canAddChatGpt && withoutChatGpt.length > 0 ? (")
      && page.includes("Object.values(q.engines).some(stopped)")
      && page.includes("chatgptConnected={chatgptConnected}")
      && !page.includes("<QuestionControls") && cell.includes("{p.connected ? (\n        <QuestionControls"));
  check("S40 the action-question list takes a live question measured on any engine",
    page.includes(".filter((q) => q.retiredAt === null && measuredOnAnyEngine(q))")
      && page.includes("Object.values(q.engines).some((m) => m !== null)"));
  const forms = read("app/admin/pilots/pilot-forms.tsx");
  const addAllBody = forms.slice(forms.indexOf("export function AddChatGptToAllButton"), forms.indexOf("export function ResolveReviewControls"));
  check("S41 the forms name the engine in every Run, Retry and review body; Add ChatGPT posts the ChatGPT engine, one question after another",
    // D-062 — a retest's bodies also name `phase: "retest"`; a baseline's are unchanged.
    forms.includes("/run`, {\n        engine: state.engine,\n        ...(state.phase === \"retest\" ? { phase: \"retest\" } : {}),\n      });")
      && forms.includes("idempotencyKey: retryKey,\n        engine: state.engine,\n        ...(state.phase === \"retest\" ? { phase: \"retest\" } : {}),")
      && forms.includes("/review`, {\n        engine,\n        resolution,\n        note,\n        ...(phase === \"retest\" ? { phase: \"retest\" } : {}),")
      && (forms.match(/\{ engine: "openai_chatgpt" \}/g) ?? []).length === 2
      && addAllBody.includes("for (const pilotQuestionId of pilotQuestionIds) {") && !addAllBody.includes("Promise.all")
      && forms.includes("window.prompt(RETIRE_PILOT_QUESTION_PROMPT)") && forms.includes("<p className=\"zpa-muted\">{RETIRE_BOTH_ENGINES_NOTE}</p>")
      && forms.includes("addChatGpt: chatgptConnected && addChatGpt,"));
  check("S42 the pilot list's line comes from the gate at request time",
    read("app/admin/pilots/page.tsx").includes("{pilotEnginesSubtitle(pilotChatGptEnabled())}")
      && !read("app/admin/pilots/page.tsx").includes("ChatGPT is not connected yet"));

  /* C: copy ---------------------------------------------------------------- */
  console.log("\n[C] copy");
  const copy = await import("@/lib/pilots/copy");
  const confirm = copy.pilotRunConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 2, stale: false });
  check("C1 the Run confirmation states this question only, Perplexity, the plan, the call ceiling and the cap",
    confirm.startsWith("Run this pilot question now?") && confirm.includes("Only this question's measurement runs, on Perplexity")
      && confirm.includes("5 planned runs") && confirm.includes("10 calls if nothing fails")
      && confirm.includes("at most 14 calls") && confirm.includes("$2.00"), confirm);
  check("C2 an unknown plan never invents numbers",
    !/\d/.test(copy.pilotRunConfirmationText({ plannedRuns: null, runCap: null, spendCapUsd: null, stale: false })));
  // D-061 — ChatGPT's own Run confirmation, from its own plan and caps (7 / 2 / 4, D-059).
  const gptConfirm = copy.pilotRunConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 4, stale: false, engine: "openai_chatgpt" });
  // Review of phase B (APP-4): the timing is the worker's bound, not a typical maximum, and a Run with
  // no room under the daily limit is refused by the paid-execution gate, never queued.
  check("C1b ChatGPT's Run confirmation: 5 answers on ChatGPT (OpenAI's API with web search), at most 7 runs, a 4.00 USD cap, its typical timing and the worker's bound (a timeout holds it for review), and a refused Run when the daily limit has no room; no Perplexity figure",
    gptConfirm.startsWith("Run this pilot question on ChatGPT now?")
      && gptConfirm.includes("5 answers on ChatGPT (OpenAI's API with web search), at most 7 runs, a 4.00 USD cap for this question")
      && gptConfirm.includes("Most answers take 30-60 seconds; a call is stopped after about 5 minutes and the measurement is then held for review.")
      && gptConfirm.includes("If today's spending limit has no room, Run is refused; press it again later.")
      && !/slowest|may wait for room|usually takes|in total/i.test(gptConfirm) && !gptConfirm.includes("Perplexity") && !gptConfirm.includes("$"), gptConfirm);
  // "About 5 minutes" is the bound every Fly file sets (WORKER_CHATGPT_TIMEOUT_MS), and the paid gate refuses outright.
  const flyTimeout = (file: string) => Number(/^\s*WORKER_CHATGPT_TIMEOUT_MS\s*=\s*"(\d+)"\s*$/m.exec(read(file))?.[1] ?? NaN);
  const prodTimeout = flyTimeout("fly.worker.production.toml");
  check("C1e \"stopped after about 5 minutes\" holds: production's WORKER_CHATGPT_TIMEOUT_MS is at most 300000 ms (and over 240000, so not much shorter), and every Fly file sets the same",
    Number.isInteger(prodTimeout) && prodTimeout <= 300_000 && prodTimeout > 240_000
      && ["fly.worker.staging.toml", "fly.worker.toml.template"].every((f) => flyTimeout(f) === prodTimeout)
      && copy.CHATGPT_TIMING_WORDS.includes("stopped after about 5 minutes"), String(prodTimeout));
  check("C1f the words for a full daily limit are the gate's behaviour: startWorkerMachine refuses before anything starts when the paid-execution gate says no",
    /if \(!decision\.ok\) \{\s*return \{ ok: false, code: "paid_execution_blocked", detail: decision\.detail \};/.test(read("lib/worker-control/fly-machine.ts"))
      && read("lib/worker-control/fly-machine.ts").indexOf("decision = await gate();") < read("lib/worker-control/fly-machine.ts").indexOf("requested = await runRequests.request(")
      && /code: "spend_ceiling_reached"/.test(read("lib/worker-control/paid-execution-gate.ts")));
  check("C1c Perplexity's confirmation is unchanged when the engine is named",
    copy.pilotRunConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 2, stale: false, engine: "perplexity_sonar" }) === confirm);
  check("C1d a lapsed ChatGPT measurement is resumed in words that name ChatGPT",
    copy.pilotRunConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 4, stale: true, engine: "openai_chatgpt" })
      .startsWith("Resume this pilot question's ChatGPT measurement now?"));
  const gptUnknownPlan = copy.pilotRunConfirmationText({ plannedRuns: null, runCap: null, spendCapUsd: null, stale: false, engine: "openai_chatgpt" });
  check("C2b ChatGPT with an unknown plan never invents numbers, and says a long call is stopped and held for review, and that a full daily limit refuses the Run",
    !/\d/.test(gptUnknownPlan) && gptUnknownPlan.includes("a call that takes too long is stopped and the measurement is then held for review")
      && gptUnknownPlan.includes("If today's spending limit has no room, Run is refused; press it again later.") && !gptUnknownPlan.includes("may wait for room"), gptUnknownPlan);
  const HELD_CODES = ["perplexity_outcome_unknown", "analysis_outcome_unknown", "ambiguous_external_call_sent_without_receipt", "operator_retry_of_failed_job", null];
  const ENGINES = ["perplexity_sonar", "openai_chatgpt"] as const;
  const engineTexts = [
    copy.ENGINE_NOT_CONNECTED, copy.ENGINE_NOT_CONNECTED_CONTROLS_NOTE, copy.PILOT_CHATGPT_NOT_CONNECTED, copy.PILOT_CHATGPT_NOT_CONNECTED_YET,
    ...Object.values(copy.ADD_ENGINE_REFUSAL), copy.ADD_CHATGPT_DONE_TEXT, copy.ADD_CHATGPT_FAILED_TEXT, copy.ADD_CHATGPT_PROMPT,
    copy.ADD_CHATGPT_BUTTON_LABEL, copy.ADD_CHATGPT_TO_ALL_BUTTON_LABEL, copy.addChatGptToAllPrompt(1), copy.addChatGptToAllPrompt(3),
    copy.addChatGptToAllSummary(2, 3, copy.ADD_ENGINE_REFUSAL.QUESTION_RETIRED), copy.addChatGptToAllSummary(3, 3, null),
    ...Object.values(copy.PILOT_REVIEW_RESOLUTION_PROMPT), ...Object.values(copy.PILOT_REVIEW_DONE_TEXT), ...Object.values(copy.PILOT_REVIEW_BUTTON_LABEL),
    copy.PILOT_REVIEW_NOT_HELD_TEXT, copy.PILOT_REVIEW_REFUSED_TEXT,
    ...HELD_CODES.flatMap((c) => ENGINES.map((e) => copy.pilotHeldReasonText(c, e))),
    ...ENGINES.flatMap((e) => [copy.pilotEngineNotOnQuestionText(e), copy.pilotRetryPrompt(e), copy.pilotEngineLabel(e),
      copy.pilotRunStartedText(e, 5), copy.pilotRunStartedText(e, null)]),
    copy.pilotEnginesSubtitle(true), copy.pilotEnginesSubtitle(false), copy.addQuestionPanelNote(true), copy.addQuestionPanelNote(false),
    copy.ADD_QUESTION_ALSO_CHATGPT_LABEL, copy.RETIRE_PILOT_QUESTION_PROMPT, copy.RETIRE_BOTH_ENGINES_NOTE,
    gptConfirm, gptUnknownPlan,
  ];
  const texts = [
    ...Object.values(copy.CREATE_PILOT_REFUSAL), ...Object.values(copy.ADD_QUESTION_REFUSAL), ...Object.values(copy.CLOSE_PILOT_REFUSAL),
    ...["queued", "claimed", "running", "succeeded", "failed", "needs_review", "abandoned_exhausted", "other", null].map((s) => copy.pilotJobStatusLabel(s, false)),
    copy.pilotProvenanceLabel("customer_supplied"), copy.pilotProvenanceLabel("founder_supplied"), copy.pilotProvenanceLabel("x"),
    copy.ENGINE_NOT_MEASURED,
    ...engineTexts,
  ];
  check("C3 no refusal, label, prompt or engine text shows a stored code (D-061 strings included)",
    texts.every((t) => !/[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t)), texts.find((t) => /[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t)) ?? "");
  check("C4 no pilot copy uses a forbidden claim phrase",
    [...texts, confirm].every((t) => !FORBIDDEN_W1_PHRASES.some((p) => t.toLowerCase().includes(p))));
  check("C5 suppliers are named in words", copy.pilotProvenanceLabel("customer_supplied") === "Supplied by the customer"
    && copy.pilotProvenanceLabel("founder_supplied") === "Supplied by Zypact");
  // D-061 — whether ChatGPT is connected is the gate's, passed in at request time: no constant says so.
  const off = copy.pilotEngines(false);
  const on = copy.pilotEngines(true);
  check("C6 ChatGPT is listed; it is connected only when the gate passed in says so; Perplexity always is; a missing slot reads Not measured, never zero",
    off.some((e) => e.key === "openai_chatgpt" && !e.connected) && on.some((e) => e.key === "openai_chatgpt" && e.connected)
      && [off, on].every((list) => list.length === 2 && list[0].key === "perplexity_sonar" && list[0].connected)
      && !("PILOT_ENGINES" in copy) && copy.ENGINE_NOT_MEASURED === "Not measured" && copy.ENGINE_NOT_CONNECTED === "Not connected");
  check("C6b off, the list says ChatGPT is not connected yet; on, it no longer does",
    copy.pilotEnginesSubtitle(false).includes("ChatGPT is not connected yet") && !copy.pilotEnginesSubtitle(true).includes("not connected")
      && copy.addQuestionPanelNote(false).includes("ChatGPT is not connected yet") && !copy.addQuestionPanelNote(true).includes("not connected"));
  check("C6c retiring says plainly that it stops the question on both engines, even if one could go on (B1 / D-061 item 7)",
    copy.RETIRE_PILOT_QUESTION_PROMPT.includes("Retiring stops this question on both engines, Perplexity and ChatGPT, even if one of its measurements could still go on")
      && copy.RETIRE_BOTH_ENGINES_NOTE.includes("Perplexity and ChatGPT alike")
      && copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE.includes("on Perplexity or on ChatGPT"));
  // Review of phase B (APP-1): the other engine's figures, finished ones included, are no longer reported.
  check("C6f the retire prompt and the abandoned-run reply say the other engine's figures, finished ones included, are no longer reported, and that an unfinished run keeps the question",
    copy.RETIRE_PILOT_QUESTION_PROMPT.includes("or has already finished")
      && copy.RETIRE_PILOT_QUESTION_PROMPT.includes("its figures on the other engine, finished ones included, are no longer reported or counted in any total")
      && copy.RETIRE_PILOT_QUESTION_PROMPT.includes("and while neither has a run that has not finished")
      && copy.PILOT_JOB_ABANDONED_TEXT.includes("its figures on the other engine, finished ones included, are then no longer reported"));
  // Review of phase B (DB-1): the refusal names the two everyday unfinished runs and what to do.
  check("C6g the refusal for an unfinished run names a Retry not yet run and a run stopped part-way, and says to press Run (or resolve its review) first",
    ["a Retry you approved but have not run yet", "a run whose worker stopped part-way", "a run held for review",
      "Press Run for it on that engine and let it finish, or resolve its review, then retire the question."]
      .every((t) => copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE.includes(t)));
  // Review of phase B (APP-5): with the web gate off, the refusals that send the founder to Retry or Run say ChatGPT must be on.
  const st = (status: string, stale = false) => ({ status, stale });
  const refusalText = copy.retireQuestionRefusalText;
  check("C6h with the gate off, RETRYABLE whose retryable measurement is ChatGPT's says ChatGPT is switched off and must be turned back on to retry it",
    refusalText("QUESTION_RETRYABLE", { chatgptConnected: false, engines: { perplexity_sonar: st("succeeded"), openai_chatgpt: st("failed") } }) === copy.RETIRE_RETRYABLE_CHATGPT_OFF
      && refusalText("QUESTION_RETRYABLE", { chatgptConnected: false, engines: { perplexity_sonar: st("queued"), openai_chatgpt: st("failed") } }) === copy.RETIRE_RETRYABLE_CHATGPT_OFF
      && copy.RETIRE_RETRYABLE_CHATGPT_OFF.includes("ChatGPT is switched off, so this measurement can't be retried now; turn ChatGPT back on to retry it."));
  check("C6i with both failed and the gate off, Perplexity is to be retried and ChatGPT waits for the gate; with only Perplexity failed, the usual words",
    refusalText("QUESTION_RETRYABLE", { chatgptConnected: false, engines: { perplexity_sonar: st("failed"), openai_chatgpt: st("failed") } }) === copy.RETIRE_RETRYABLE_BOTH_CHATGPT_OFF
      && refusalText("QUESTION_RETRYABLE", { chatgptConnected: false, engines: { perplexity_sonar: st("failed"), openai_chatgpt: st("queued") } }) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_RETRYABLE);
  check("C6j with the gate off, an unfinished run that can only be ChatGPT's (queued or lease lapsed, beside a Perplexity that finished or stopped) says ChatGPT must be on to finish it; a live run or a Perplexity run keeps the usual words",
    refusalText("QUESTION_JOB_ACTIVE", { chatgptConnected: false, engines: { perplexity_sonar: st("abandoned_exhausted"), openai_chatgpt: st("queued") } }) === copy.RETIRE_UNFINISHED_CHATGPT_OFF
      && refusalText("QUESTION_JOB_ACTIVE", { chatgptConnected: false, engines: { perplexity_sonar: st("succeeded"), openai_chatgpt: st("running", true) } }) === copy.RETIRE_UNFINISHED_CHATGPT_OFF
      && refusalText("QUESTION_JOB_ACTIVE", { chatgptConnected: false, engines: { perplexity_sonar: st("succeeded"), openai_chatgpt: st("running", false) } }) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE
      && refusalText("QUESTION_JOB_ACTIVE", { chatgptConnected: false, engines: { perplexity_sonar: st("queued"), openai_chatgpt: st("failed") } }) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE
      && refusalText("QUESTION_JOB_ACTIVE", { chatgptConnected: false, engines: { perplexity_sonar: st("abandoned_exhausted"), openai_chatgpt: st("needs_review") } }) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE);
  check("C6k with the gate on, without a ChatGPT measurement, or for any other refusal, the usual words",
    (["QUESTION_RETRYABLE", "QUESTION_JOB_ACTIVE"] as const).every((o) =>
      refusalText(o, { chatgptConnected: true, engines: { perplexity_sonar: st("abandoned_exhausted"), openai_chatgpt: st("failed") } }) === copy.RETIRE_QUESTION_REFUSAL[o]
        && refusalText(o, { chatgptConnected: false, engines: { perplexity_sonar: st("failed"), openai_chatgpt: null } }) === copy.RETIRE_QUESTION_REFUSAL[o]
        && refusalText(o, { chatgptConnected: false }) === copy.RETIRE_QUESTION_REFUSAL[o])
      && refusalText("QUESTION_NOT_STOPPED", { chatgptConnected: false, engines: { perplexity_sonar: st("succeeded"), openai_chatgpt: st("queued") } }) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_NOT_STOPPED);
  check("C6l every gate-off refusal is in plain words with no stored code",
    [copy.RETIRE_RETRYABLE_CHATGPT_OFF, copy.RETIRE_RETRYABLE_BOTH_CHATGPT_OFF, copy.RETIRE_UNFINISHED_CHATGPT_OFF, copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE]
      .every((t) => !/[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t) && !FORBIDDEN_W1_PHRASES.some((ph) => t.toLowerCase().includes(ph))));
  check("C6d a held measurement names its own engine, never the stored reason code",
    copy.pilotHeldReasonText("perplexity_outcome_unknown", "openai_chatgpt").includes("a ChatGPT call may have been made")
      && copy.pilotHeldReasonText("perplexity_outcome_unknown", "perplexity_sonar").includes("a Perplexity call may have been made")
      && HELD_CODES.every((c) => ENGINES.every((e) => !copy.pilotHeldReasonText(c, e).includes("perplexity_") && !copy.pilotHeldReasonText(c, e).includes("_unknown"))));
  check("C6e the Run route's reply names the engine and its timing (typical, then the worker's bound and what a timeout does)",
    copy.pilotRunStartedText("openai_chatgpt", 5) === "Measurement started for this question only: 5 planned runs on ChatGPT. Most answers take 30-60 seconds; a call is stopped after about 5 minutes and the measurement is then held for review."
      && copy.pilotRunStartedText("perplexity_sonar", 5) === "Measurement started for this question only: 5 planned runs on Perplexity, about 20 seconds each."
      && copy.pilotRunStartedText("openai_chatgpt", null) === "Measurement started for this question only.");

  const { parseAddPilotQuestion, parseCreatePilot, promptHashOf } = await import("@/lib/pilots/validate");
  const okCreate = parseCreatePilot({
    companyName: " Acme ", websiteUrl: "www.Acme.example/path", siteControlNote: "Customer added our DNS record.",
    questionLimit: "15", startsOn: "2026-11-20", idempotencyKey: randomUUID(),
  }, "2026-11-17");
  check("C7 the website is normalized as a request's, and the limit read as a number",
    okCreate.ok && okCreate.value.normalizedDomain === "acme.example" && okCreate.value.websiteUrl === "https://www.acme.example"
      && okCreate.value.companyName === "Acme" && okCreate.value.questionLimit === 15);
  const badCreate = parseCreatePilot({ companyName: "A", websiteUrl: "localhost", siteControlNote: "x", questionLimit: 21, startsOn: "2026-02-30", idempotencyKey: "k" }, "2026-11-17");
  check("C8 every bad field is named", !badCreate.ok
    && ["companyName", "websiteUrl", "siteControlNote", "questionLimit", "startsOn", "idempotencyKey"].every((k) => k in badCreate.issues));
  const okAdd = parseAddPilotQuestion({
    questionText: `  ${question(400)}  `, questionProvenance: "founder_supplied", customerApprovalRef: "Email of 12 Nov",
    customerApprovedOn: "2026-11-12", idempotencyKey: randomUUID(),
  }, "2026-11-17");
  check("C9 a question is trimmed and hashed exactly as the database re-checks it",
    okAdd.ok && okAdd.value.questionText === question(400) && okAdd.value.promptHash === sha(question(400))
      && promptHashOf(question(400)) === sha(question(400)));
  const badAdd = parseAddPilotQuestion({ questionText: "short", customerApprovalRef: "", customerApprovedOn: "2026-11-18", idempotencyKey: "x" }, "2026-11-17");
  check("C10 a short question, a missing supplier, reference or key, and a future approval date are each refused",
    !badAdd.ok && ["questionText", "questionProvenance", "customerApprovalRef", "customerApprovedOn", "idempotencyKey"].every((k) => k in badAdd.issues));
  const startOn = (startsOn: string) => parseCreatePilot({
    companyName: "Acme", websiteUrl: "acme.example", siteControlNote: "Customer added our DNS record.",
    questionLimit: 15, startsOn, idempotencyKey: randomUUID(),
  }, "2026-11-17");
  check("C11 the start date is accepted from yesterday to 60 days ahead, as the database checks it",
    startOn("2026-11-16").ok && startOn("2027-01-16").ok
      && !startOn("2026-11-15").ok && !startOn("2027-01-17").ok && !startOn("2062-11-17").ok);
  check("C12 the new refusals and prompts have fixed words, with no stored code",
    [copy.CREATE_PILOT_REFUSAL.START_DATE_OUT_OF_RANGE, copy.CLOSE_PILOT_REFUSAL.PILOT_JOB_ACTIVE, copy.CLOSE_PILOT_PROMPT,
      copy.PILOT_JOB_ABANDONED_TEXT, ...Object.values(copy.RETIRE_QUESTION_REFUSAL)]
      .every((t) => t.length > 10 && !/[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t))
      && copy.CLOSE_PILOT_PROMPT.includes("cannot be closed while one of its measurements is running")
      && !copy.CLOSE_PILOT_PROMPT.includes("will no longer be measured")
      && !copy.PILOT_JOB_ABANDONED_TEXT.includes("request"));

  /* E: engines and the web gate (D-061) ------------------------------------ */
  console.log("\n[E] the engines of a slot and the web host's ChatGPT gate (D-061)");
  const engineMod = await import("@/lib/pilots/engines");
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
    check(`E1 ZYPACT_PILOT_CHATGPT_ENABLED=${JSON.stringify(v)} is off`,
      engineMod.pilotChatGptEnabled({ ZYPACT_PILOT_CHATGPT_ENABLED: v }) === false);
  }
  check("E2 the gate is on only when the variable is exactly \"true\"",
    engineMod.pilotChatGptEnabled({ ZYPACT_PILOT_CHATGPT_ENABLED: "true" }) === true);
  const gateBefore = process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  process.env.ZYPACT_PILOT_CHATGPT_ENABLED = "true";
  const readOn = engineMod.pilotChatGptEnabled();
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  const readOff = engineMod.pilotChatGptEnabled();
  if (gateBefore !== undefined) process.env.ZYPACT_PILOT_CHATGPT_ENABLED = gateBefore;
  check("E3 it is read from the environment at each request, never cached", readOn === true && readOff === false);
  check("E4 a slot's engine is one of a closed set of two",
    JSON.stringify(engineMod.PILOT_QUESTION_ENGINES) === JSON.stringify(["perplexity_sonar", "openai_chatgpt"])
      && engineMod.isPilotQuestionEngine("openai_chatgpt") && engineMod.isPilotQuestionEngine("perplexity_sonar")
      && ["perplexity", "chatgpt", "openai", "OPENAI_CHATGPT", "", null, 1].every((v) => !engineMod.isPilotQuestionEngine(v)));
  const choose = engineMod.pilotEngineFromBody;
  const GATED_OFF = { chatgptEnabled: false, gated: true };
  check("E5 a body without an engine is Perplexity, as before D-061: no body, {}, a null engine, a body that is not an object",
    [undefined, null, {}, { engine: null }, [], "x"].every((b) => {
      const c = choose(b, GATED_OFF);
      return c.ok && c.engine === "perplexity_sonar";
    }));
  check("E6 an engine outside the closed set is refused (400), whatever the gate",
    [{ engine: "perplexity" }, { engine: "chatgpt" }, { engine: "OPENAI_CHATGPT" }, { engine: 1 }, { engine: "" }, { engine: {} }].every((b) => {
      const c = choose(b, { chatgptEnabled: true, gated: true });
      return !c.ok && c.status === 400 && c.error === "invalid_engine";
    }));
  const gptOff = choose({ engine: "openai_chatgpt" }, GATED_OFF);
  check("E7 ChatGPT on a gated action with the gate off is refused (409), in words",
    !gptOff.ok && gptOff.status === 409 && gptOff.error === copy.PILOT_CHATGPT_NOT_CONNECTED);
  const gptOn = choose({ engine: "openai_chatgpt" }, { chatgptEnabled: true, gated: true });
  check("E8 ChatGPT with the gate on is chosen", gptOn.ok && gptOn.engine === "openai_chatgpt");
  const ungated = choose({ engine: "openai_chatgpt" }, { chatgptEnabled: false, gated: false });
  check("E9 an action that spends nothing is not gated: a ChatGPT measurement stays resolvable with the gate off",
    ungated.ok && ungated.engine === "openai_chatgpt");
  const required = choose({}, { chatgptEnabled: true, gated: false, required: true });
  check("E10 where the engine is required, its absence is refused (400)", !required.ok && required.status === 400);
  const sonarOff = choose({ engine: "perplexity_sonar" }, GATED_OFF);
  check("E11 Perplexity is never behind the ChatGPT gate", sonarOff.ok && sonarOff.engine === "perplexity_sonar");

  /* R: reads keyed by question and engine (D-061) -------------------------- */
  console.log("\n[R] the console's reads, keyed by question and engine (D-061)");
  type Rows = Record<string, Array<Record<string, unknown>>>;
  type RpcReply = (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
  /** A fake PostgREST client: filters applied and recorded per query, writes impossible, RPCs recorded. */
  const fakeClient = (tables: Rows, rpcReply?: RpcReply) => {
    const reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
    const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      from(table: string) {
        let rows = [...(tables[table] ?? [])];
        const filters: Array<[string, string, unknown]> = [];
        reads.push({ table, filters });
        const q: Record<string, unknown> = {
          select: () => q,
          eq(c: string, v: unknown) { filters.push(["eq", c, v]); rows = rows.filter((r) => r[c] === v); return q; },
          in(c: string, vs: unknown[]) { filters.push(["in", c, vs]); rows = rows.filter((r) => vs.includes(r[c])); return q; },
          is(c: string, v: unknown) { filters.push(["is", c, v]); rows = rows.filter((r) => (r[c] ?? null) === v); return q; },
          order(c: string, o?: { ascending?: boolean }) {
            const dir = o?.ascending === false ? -1 : 1;
            rows = [...rows].sort((a, b) => (Number(a[c]) - Number(b[c])) * dir);
            return q;
          },
          limit(n: number) { rows = rows.slice(0, n); return q; },
          maybeSingle: async () => rows.length > 1
            ? { data: null, error: { code: "PGRST116", message: "more than one row" } }
            : { data: rows[0] ?? null, error: null },
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          },
        };
        return q;
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcs.push({ name, args });
        return rpcReply ? rpcReply(name, args) : { data: null, error: { message: "no rpc in this fixture" } };
      },
    } as unknown as SupabaseClient;
    return { client, reads, rpcs };
  };
  const reads = await import("@/lib/pilots/reads");
  const RP = randomUUID();
  const RQ1 = randomUUID();
  const RQ2 = randomUUID();
  const PROJ = randomUUID();
  const PX1 = randomUUID();
  const GP1 = randomUUID();
  const PX2 = randomUUID();
  const JOB = { px1: randomUUID(), gp1: randomUUID(), px2: randomUUID() };
  const nowIso = new Date().toISOString();
  const questionRow = (id: string, ordinal: number, versionId: string) => ({
    id, pilot_id: RP, ordinal, buyer_question_version_id: versionId, question_provenance: "customer_supplied",
    customer_approval_ref: "Email of 12 Nov", customer_approved_on: today(), added_at: nowIso, retired_at: null, retire_reason: null,
  });
  const V1 = randomUUID();
  const V2 = randomUUID();
  const attemptsOf = (protocolId: string, statuses: string[]) => statuses.map((status) => ({ protocol_id: protocolId, status }));
  const readTables = (): Rows => ({
    pilots: [{
      id: RP, project_id: PROJ, company_name: "Reads Co", website_url: "https://reads.example", normalized_domain: "reads.example",
      site_control_note: "The customer added the DNS record we sent them.", status: "active", question_limit: 15,
      starts_on: daysAgo(1), ends_on: daysAhead(89), created_at: nowIso, closed_at: null, close_reason: null,
    }],
    pilot_questions: [questionRow(RQ2, 2, V2), questionRow(RQ1, 1, V1)],
    buyer_question_versions: [{ id: V1, prompt_text: question(901) }, { id: V2, prompt_text: question(902) }],
    // ChatGPT's slot first: whatever the order, neither engine stands in for the other.
    pilot_question_protocols: [
      { pilot_question_id: RQ1, protocol_id: GP1, engine: "openai_chatgpt", phase: "baseline" },
      { pilot_question_id: RQ1, protocol_id: PX1, engine: "perplexity_sonar", phase: "baseline" },
      { pilot_question_id: RQ2, protocol_id: PX2, engine: "perplexity_sonar", phase: "baseline" },
    ],
    protocols: [
      { id: PX1, planned_baseline_runs: 5, run_cap: 7, spend_cap_usd: 2 },
      { id: GP1, planned_baseline_runs: 5, run_cap: 7, spend_cap_usd: "4.00" },
      { id: PX2, planned_baseline_runs: 5, run_cap: 7, spend_cap_usd: 2 },
    ],
    protocol_execution_jobs: [
      { id: JOB.px1, project_id: PROJ, protocol_id: PX1, status: "succeeded", lease_expires_at: null, next_baseline_ordinal: 6, needs_review_reason: null },
      { id: JOB.gp1, project_id: PROJ, protocol_id: GP1, status: "needs_review", lease_expires_at: null, next_baseline_ordinal: 3, needs_review_reason: "perplexity_outcome_unknown" },
      { id: JOB.px2, project_id: PROJ, protocol_id: PX2, status: "running", lease_expires_at: new Date(Date.now() - 60_000).toISOString(), next_baseline_ordinal: 2, needs_review_reason: null },
    ],
    protocol_attempts: [
      ...attemptsOf(PX1, ["completed", "completed", "completed", "completed", "completed"]),
      ...attemptsOf(GP1, ["completed", "completed", "timed_out"]),
      ...attemptsOf(PX2, ["completed", "failed"]),
    ],
  });
  const fr = fakeClient(readTables());
  const loaded = await reads.loadPilot(fr.client, RP);
  const lq1 = loaded?.questions.find((q) => q.id === RQ1);
  const lq2 = loaded?.questions.find((q) => q.id === RQ2);
  check("R1 a question with both slots carries each engine's own measurement, never one in place of the other",
    !!lq1 && lq1.engines.perplexity_sonar?.protocolId === PX1 && lq1.engines.perplexity_sonar?.engine === "perplexity_sonar"
      && lq1.engines.openai_chatgpt?.protocolId === GP1 && lq1.engines.openai_chatgpt?.engine === "openai_chatgpt",
    JSON.stringify(lq1?.engines));
  // Review of phase B (APP-7): a timed-out run is counted as failed, as the customer report counts it.
  check("R2 each engine keeps its own job, status, runs, caps and hold reason; ChatGPT's timed-out run is counted as failed",
    lq1?.engines.perplexity_sonar?.jobId === JOB.px1 && lq1.engines.perplexity_sonar.jobStatus === "succeeded"
      && lq1.engines.perplexity_sonar.completedRuns === 5 && lq1.engines.perplexity_sonar.spendCapUsd === 2
      && lq1.engines.perplexity_sonar.needsReviewReason === null && lq1.engines.perplexity_sonar.failedRuns === 0
      && lq1.engines.openai_chatgpt?.jobId === JOB.gp1 && lq1.engines.openai_chatgpt.jobStatus === "needs_review"
      && lq1.engines.openai_chatgpt.completedRuns === 2 && lq1.engines.openai_chatgpt.failedRuns === 1
      && lq1.engines.openai_chatgpt.excludedRuns === 0
      && lq1.engines.openai_chatgpt.spendCapUsd === 4 && lq1.engines.openai_chatgpt.needsReviewReason === "perplexity_outcome_unknown");
  const t7 = readTables();
  t7.protocol_attempts.push(...attemptsOf(PX2, ["cancelled", "excluded", "reserved"]));
  const px2Counted = (await reads.loadPilot(fakeClient(t7).client, RP))?.questions.find((q) => q.id === RQ2)?.engines.perplexity_sonar;
  check("R2b the console counts runs as the customer report does: failed, timed out and cancelled as failed, excluded after review on its own, a run still open in neither",
    px2Counted?.completedRuns === 1 && px2Counted.failedRuns === 2 && px2Counted.excludedRuns === 1
      && copy.pilotRunsLine(px2Counted) === "1 of 5 runs completed, 2 failed, 1 excluded after review"
      && copy.pilotRunsLine({ completedRuns: 5, plannedRuns: 5, failedRuns: 0, excludedRuns: 0 }) === "5 of 5 runs completed"
      && copy.pilotRunsLine({ completedRuns: 0, plannedRuns: null, failedRuns: 1 }) === "0 of ? runs completed, 1 failed"
      && read("lib/reports/build-pilot-report.ts").includes('const FAILED_STATUSES = new Set(["failed", "timed_out", "cancelled"]);')
      && read("lib/pilots/reads.ts").includes('const FAILED_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out", "cancelled"]);'),
    JSON.stringify(px2Counted));
  check("R3 a question measured on Perplexity only has no ChatGPT measurement (null, never zero), and its own lapsed lease",
    !!lq2 && lq2.engines.openai_chatgpt === null && lq2.engines.perplexity_sonar?.protocolId === PX2
      && lq2.engines.perplexity_sonar.stale === true && lq2.engines.perplexity_sonar.failedRuns === 1);
  check("R3b the questions keep their order and their own texts", loaded?.questions.map((q) => q.ordinal).join(",") === "1,2"
    && lq1?.questionText === question(901) && lq2?.questionText === question(902));
  const slotRead = fr.reads.find((r) => r.table === "pilot_question_protocols");
  check("R4 the slot read takes every engine's baseline: no engine filter, the baseline phase only",
    !!slotRead && slotRead.filters.some(([op, c, v]) => op === "eq" && c === "phase" && v === "baseline")
      && !slotRead.filters.some(([, c]) => c === "engine"), JSON.stringify(slotRead?.filters));
  const dup = readTables();
  dup.pilot_question_protocols.push({ pilot_question_id: RQ1, protocol_id: randomUUID(), engine: "openai_chatgpt", phase: "baseline" });
  check("R5 two baseline slots on one engine for one question is an error, never a silent pick",
    await reads.loadPilot(fakeClient(dup).client, RP).then(() => false, (e: unknown) => e instanceof Error && e.message.includes("two baseline slots")));
  const tGpt = await reads.resolvePilotQuestionTarget(fr.client, RP, RQ1, "openai_chatgpt");
  const tPx = await reads.resolvePilotQuestionTarget(fr.client, RP, RQ1, "perplexity_sonar");
  check("R6 the target is exactly one slot: the question's baseline on the engine asked for, with its own job",
    tGpt?.engine === "openai_chatgpt" && tGpt.protocolId === GP1 && tGpt.job?.id === JOB.gp1 && tGpt.job.status === "needs_review"
      && tGpt.plannedRuns === 5 && tPx?.engine === "perplexity_sonar" && tPx.protocolId === PX1 && tPx.job?.id === JOB.px1);
  const targetSlotReads = fr.reads.filter((r) => r.table === "pilot_question_protocols").slice(1);
  check("R7 its slot read filters by question, engine and the baseline phase",
    targetSlotReads.length === 2 && targetSlotReads.every((r) => r.filters.some(([op, c]) => op === "eq" && c === "pilot_question_id")
      && r.filters.some(([op, c, v]) => op === "eq" && c === "phase" && v === "baseline"))
      && targetSlotReads[0].filters.some(([op, c, v]) => op === "eq" && c === "engine" && v === "openai_chatgpt")
      && targetSlotReads[1].filters.some(([op, c, v]) => op === "eq" && c === "engine" && v === "perplexity_sonar"));
  const tNone = await reads.resolvePilotQuestionTarget(fr.client, RP, RQ2, "openai_chatgpt");
  check("R8 a question without a slot on that engine answers its pilot state and no slot, never another engine's",
    !!tNone && tNone.protocolId === null && tNone.job === null && tNone.plannedRuns === null && tNone.pilotStatus === "active"
      && tNone.retired === false && tNone.engine === "openai_chatgpt");
  check("R9 a question that is not this pilot's answers null",
    (await reads.resolvePilotQuestionTarget(fr.client, RP, randomUUID(), "openai_chatgpt")) === null
      && (await reads.resolvePilotQuestionTarget(fr.client, randomUUID(), RQ1, "openai_chatgpt")) === null);
  const readsBefore = fr.reads.length;
  check("R10 an engine outside the closed set throws before anything is read",
    await reads.resolvePilotQuestionTarget(fr.client, RP, RQ1, "perplexity" as never).then(() => false, () => true)
      && fr.reads.length === readsBefore);

  /* H: the new founder actions and the Run/Retry engine checks (D-061) ----- */
  console.log("\n[H] adding ChatGPT, the add-question follow-up, resolving a held measurement, Run and Retry (D-061)");
  const handlers = await import("@/lib/pilots/engine-routes");
  const { NextResponse } = await import("next/server");
  let guardCalls = 0;
  const founderGuard = async () => {
    guardCalls += 1;
    return { ok: true as const, user: { id: FOUNDER, email: "founder@zypact.example" } };
  };
  const refusingGuard = async () => {
    guardCalls += 1;
    return { ok: false as const, response: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) };
  };
  const ENV_ON = { SNAPSHOT_APPROVAL_ENABLED: "true", ZYPACT_PILOT_CHATGPT_ENABLED: "true" };
  const ENV_GATE_OFF = { SNAPSHOT_APPROVAL_ENABLED: "true" };
  const rawPost = (text: string) =>
    new Request("http://local.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: text });
  const jsonPost = (body: unknown) => rawPost(JSON.stringify(body));
  const handlerLogs: string[] = [];
  const slotsOf = (pilotQuestionId: string) =>
    [...store().pilotQuestionProtocols.values()].filter((s) => s.pilotQuestionId === pilotQuestionId);
  const GPT = { engine: "openai_chatgpt" };

  const hPilot = await db.createPilot(createInput("pilot-h.example"));
  const hq = await db.addPilotQuestion(addInput(hPilot.pilotId!, question(950)));
  const idsH = { pilotId: hPilot.pilotId!, pilotQuestionId: hq.pilotQuestionId! };
  let dbCalls = 0;
  const addDeps = (over: Partial<Parameters<typeof handlers.handleAddPilotQuestionEngine>[2]> = {}) => ({
    env: ENV_ON, guard: founderGuard, db: () => { dbCalls += 1; return db; }, log: (l: string) => { handlerLogs.push(l); }, ...over,
  });
  guardCalls = 0;
  dbCalls = 0;
  const ks = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps({ env: { ZYPACT_PILOT_CHATGPT_ENABLED: "true" } }));
  check("H1 add: the kill switch first (503), before the founder guard and the database", ks.status === 503 && guardCalls === 0 && dbCalls === 0);
  const denied = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps({ guard: refusingGuard }));
  check("H2 add: then the founder guard's own refusal, before the database", denied.status === 404 && dbCalls === 0);
  const badStatuses = [
    (await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), { ...idsH, pilotQuestionId: "not-a-uuid" }, addDeps())).status,
    (await handlers.handleAddPilotQuestionEngine(rawPost("{not json"), idsH, addDeps())).status,
    ...(await Promise.all([{}, { engine: "perplexity_sonar" }, { engine: "gemini" }, { engine: null }].map(async (b) =>
      (await handlers.handleAddPilotQuestionEngine(jsonPost(b), idsH, addDeps())).status))),
  ];
  check("H3 add: a malformed id, an unreadable body, and any engine but ChatGPT are refused (400), before the database",
    badStatuses.every((s) => s === 400) && dbCalls === 0, badStatuses.join(","));
  const offRes = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps({ env: ENV_GATE_OFF }));
  const offBody = await offRes.json();
  check("H4 add with the gate off: refused (409) in words, before the database, and nothing is added",
    offRes.status === 409 && offBody.error === copy.PILOT_CHATGPT_NOT_CONNECTED && dbCalls === 0 && slotsOf(idsH.pilotQuestionId).length === 1);
  const addedRes = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps());
  const addedBody = await addedRes.json();
  const hSlots = slotsOf(idsH.pilotQuestionId);
  const gptSlot = hSlots.find((s) => s.engine === "openai_chatgpt");
  const gptProtocol = gptSlot ? store().protocols.get(gptSlot.protocolId) : undefined;
  const sonarProtocol = store().protocols.get(hq.protocolId!);
  const gptJob = gptSlot ? [...store().protocolExecutionJobs.values()].find((j) => j.protocolId === gptSlot.protocolId) : undefined;
  check("H5 add with the gate on: 201 in words, ChatGPT's baseline slot beside Perplexity's",
    addedRes.status === 201 && addedBody.ok === true && addedBody.outcome === "ADDED" && addedBody.detail === copy.ADD_CHATGPT_DONE_TEXT
      && hSlots.length === 2 && gptSlot?.phase === "baseline" && hSlots.some((s) => s.engine === "perplexity_sonar"));
  check("H6 its protocol is ChatGPT's plan on the question's own version (5 runs, caps 7 / 2 / 4), approved by the signed-in founder",
    gptProtocol?.provider === "openai_chatgpt" && gptProtocol.plannedBaselineRuns === 5 && gptProtocol.runCap === 7
      && gptProtocol.retryCap === 2 && gptProtocol.spendCapUsd === 4 && gptProtocol.status === "approved"
      && gptProtocol.approvedBy === FOUNDER && gptProtocol.buyerQuestionVersionId === sonarProtocol?.buyerQuestionVersionId
      && JSON.stringify(gptProtocol.paraphrasePlan) === JSON.stringify(sonarProtocol?.paraphrasePlan));
  check("H6b the add prompts' fixed figures are the plan the add writes (5 answers, at most 7 runs, a 4.00 USD cap)",
    !!gptProtocol && [copy.ADD_CHATGPT_PROMPT, copy.ADD_QUESTION_ALSO_CHATGPT_LABEL, copy.addChatGptToAllPrompt(2)].every((t) =>
      t.includes(`${gptProtocol.plannedBaselineRuns} answers on ChatGPT`) && t.includes(`at most ${gptProtocol.runCap} runs`)
        && t.includes(`${gptProtocol.spendCapUsd.toFixed(2)} USD cap`)));
  check("H7 its job is queued and nothing is started: no run request exists for it",
    gptJob?.status === "queued" && runRequestOf(gptJob.id).length === 0);
  const replayRes = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps());
  const replayBody = await replayRes.json();
  check("H8 a repeated press answers the same slot (200), adding nothing",
    replayRes.status === 200 && replayBody.outcome === "ALREADY_ADDED" && slotsOf(idsH.pilotQuestionId).length === 2);
  const unknownQ = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), { ...idsH, pilotQuestionId: randomUUID() }, addDeps());
  check("H9 a question that is not this pilot's: 404, in words",
    unknownQ.status === 404 && (await unknownQ.json()).error === copy.ADD_ENGINE_REFUSAL.QUESTION_NOT_FOUND);
  const hClosed = await db.createPilot(createInput("pilot-h2.example"));
  const hcq = await db.addPilotQuestion(addInput(hClosed.pilotId!, question(951)));
  await db.closePilot({ pilotId: hClosed.pilotId!, closedBy: FOUNDER, reason: "The customer ended the pilot early." });
  const closedRes = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), { pilotId: hClosed.pilotId!, pilotQuestionId: hcq.pilotQuestionId! }, addDeps());
  check("H10 a closed pilot: 409 in words, and nothing is added",
    closedRes.status === 409 && (await closedRes.json()).error === copy.ADD_ENGINE_REFUSAL.PILOT_CLOSED && slotsOf(hcq.pilotQuestionId!).length === 1);
  const throwing = { addPilotQuestionEngine: async () => { throw Object.assign(new Error("SENTINEL-DB-ERROR"), { code: "P0001" }); } };
  const thrownRes = await handlers.handleAddPilotQuestionEngine(jsonPost(GPT), idsH, addDeps({ db: () => throwing as unknown as DbAdapter }));
  const thrownBody = await thrownRes.json();
  check("H11 a database failure answers in words (500) and never echoes or logs the error",
    thrownRes.status === 500 && thrownBody.error === copy.ADD_CHATGPT_FAILED_TEXT && !JSON.stringify(thrownBody).includes("SENTINEL")
      && !handlerLogs.some((l) => l.includes("SENTINEL")));
  const addLines = handlerLogs.map((l) => JSON.parse(l) as Record<string, unknown>);
  check("H12 every add line is closed: the actor from the session, no question text, no company",
    addLines.some((l) => l.event === "pilot_question_engine_add" && l.outcome === "ADDED" && l.actorUserId === FOUNDER)
      && handlerLogs.every((l) => !l.includes(question(950)) && !l.includes("Pilot Co")));

  // The add-question route's follow-up (two calls; the question keeps Perplexity when the second does not add).
  const fq = await db.addPilotQuestion(addInput(hPilot.pilotId!, question(952)));
  const followIn = { pilotId: hPilot.pilotId!, pilotQuestionId: fq.pilotQuestionId!, addedBy: FOUNDER };
  const notConnected = await handlers.addChatGptAfterQuestion(db, { ...followIn, chatgptEnabled: false });
  check("H13 follow-up with the gate off: ChatGPT is not added, in words, and the question keeps its Perplexity slot",
    !notConnected.added && notConnected.outcome === "NOT_CONNECTED" && notConnected.words === copy.PILOT_CHATGPT_NOT_CONNECTED_YET
      && slotsOf(fq.pilotQuestionId!).map((s) => s.engine).join(",") === "perplexity_sonar");
  const follow = await handlers.addChatGptAfterQuestion(db, { ...followIn, chatgptEnabled: true });
  check("H14 with the gate on: the ChatGPT slot is added right after the question",
    follow.added && follow.outcome === "ADDED" && slotsOf(fq.pilotQuestionId!).map((s) => s.engine).sort().join(",") === "openai_chatgpt,perplexity_sonar");
  check("H15 a repeated follow-up replays", (await handlers.addChatGptAfterQuestion(db, { ...followIn, chatgptEnabled: true })).outcome === "ALREADY_ADDED");
  const refusedFollow = await handlers.addChatGptAfterQuestion(
    { addPilotQuestionEngine: async () => ({ outcome: "QUESTION_RETIRED" as const, protocolId: null, jobId: null }) },
    { ...followIn, chatgptEnabled: true });
  check("H16 a database refusal comes back in words, not added", !refusedFollow.added && refusedFollow.words === copy.ADD_ENGINE_REFUSAL.QUESTION_RETIRED);
  const failedFollow = await handlers.addChatGptAfterQuestion(throwing, { ...followIn, chatgptEnabled: true });
  check("H17 a failure comes back in words, never thrown and never echoed",
    !failedFollow.added && failedFollow.outcome === "FAILED" && failedFollow.words === copy.ADD_CHATGPT_FAILED_TEXT);

  // Resolving a measurement held for review, per slot.
  const VP = randomUUID();
  const VQ = randomUUID();
  const VPROJ = randomUUID();
  const VPX = randomUUID();
  const VGP = randomUUID();
  const VJPX = randomUUID();
  const VJGP = randomUUID();
  const reviewTables = (o: { gptStatus?: string; withGpt?: boolean } = {}): Rows => ({
    pilots: [{ id: VP, status: "active", starts_on: daysAgo(1), ends_on: daysAhead(89) }],
    pilot_questions: [{ id: VQ, pilot_id: VP, retired_at: null }],
    pilot_question_protocols: [
      { pilot_question_id: VQ, protocol_id: VPX, engine: "perplexity_sonar", phase: "baseline" },
      ...(o.withGpt === false ? [] : [{ pilot_question_id: VQ, protocol_id: VGP, engine: "openai_chatgpt", phase: "baseline" }]),
    ],
    protocol_execution_jobs: [
      { id: VJPX, project_id: VPROJ, protocol_id: VPX, status: "needs_review", lease_expires_at: null, next_baseline_ordinal: 2 },
      { id: VJGP, project_id: VPROJ, protocol_id: VGP, status: o.gptStatus ?? "needs_review", lease_expires_at: null, next_baseline_ordinal: 3 },
    ],
    protocols: [{ id: VPX, planned_baseline_runs: 5 }, { id: VGP, planned_baseline_runs: 5 }],
  });
  const idsV = { pilotId: VP, pilotQuestionId: VQ };
  const resolvedReply: RpcReply = (_name, args) => ({
    data: [{ id: args.p_job_id, status: args.p_resolution === "failed" ? "failed" : "succeeded" }], error: null,
  });
  const reviewDeps = (fc: ReturnType<typeof fakeClient>, over: Partial<Parameters<typeof handlers.handleResolvePilotQuestionReview>[2]> = {}) => ({
    env: ENV_GATE_OFF, guard: founderGuard, client: () => fc.client, log: (l: string) => { handlerLogs.push(l); }, ...over,
  });
  const NOTE = "  The ChatGPT call timed out; finishing with the answers we have.  ";
  const review = (fc: ReturnType<typeof fakeClient>, body: unknown, over = {}, ids = idsV) =>
    handlers.handleResolvePilotQuestionReview(typeof body === "string" ? rawPost(body) : jsonPost(body), ids, reviewDeps(fc, over));
  {
    const fc = fakeClient(reviewTables(), resolvedReply);
    guardCalls = 0;
    const r = await review(fc, { engine: "openai_chatgpt", resolution: "failed", note: NOTE }, { env: {} });
    check("H18 review: the kill switch first (503), before the guard and any read", r.status === 503 && guardCalls === 0 && fc.reads.length === 0 && fc.rpcs.length === 0);
    const g = await review(fc, { engine: "openai_chatgpt", resolution: "failed", note: NOTE }, { guard: refusingGuard });
    check("H19 review: then the founder guard, before any read", g.status === 404 && fc.reads.length === 0);
    const bad = await Promise.all([
      review(fc, { resolution: "failed", note: NOTE }),
      review(fc, { engine: "gemini", resolution: "failed", note: NOTE }),
      review(fc, { engine: "openai_chatgpt", resolution: "succeeded", note: NOTE }),
      review(fc, { engine: "openai_chatgpt", note: NOTE }),
      review(fc, { engine: "openai_chatgpt", resolution: "failed", note: "too short" }),
      review(fc, { engine: "openai_chatgpt", resolution: "failed", note: "   short     " }),
      review(fc, { engine: "openai_chatgpt", resolution: "failed", note: "x".repeat(2001) }),
      review(fc, { engine: "openai_chatgpt", resolution: "failed" }),
      review(fc, "{not json"),
    ]);
    check("H20 review: no engine, another engine, another resolution, a missing or out-of-bounds note, or an unreadable body is refused (400), before any read",
      bad.every((r) => r.status === 400) && fc.reads.length === 0 && fc.rpcs.length === 0, bad.map((r) => r.status).join(","));
    check("H21 review: the request page's resolutions and note bounds",
      JSON.stringify(handlers.PILOT_REVIEW_RESOLUTIONS) === JSON.stringify(["excluded_and_completed", "failed"])
        && handlers.PILOT_REVIEW_NOTE_MIN === 10 && handlers.PILOT_REVIEW_NOTE_MAX === 2000
        && read("app/api/internal/snapshot-requests/[requestId]/review/route.ts").includes("const MAX_NOTE_LENGTH = 2000;\nconst MIN_NOTE_LENGTH = 10;"));
  }
  {
    const fc = fakeClient(reviewTables(), resolvedReply);
    // The gate is off here: a held ChatGPT measurement stays resolvable; the body's job id is ignored.
    const r = await review(fc, { engine: "openai_chatgpt", resolution: "excluded_and_completed", note: NOTE, jobId: VJPX });
    const body = await r.json();
    const call = fc.rpcs[0];
    check("H22 review with the gate off resolves the ChatGPT slot's own job through resolve_protocol_job_review, in words",
      r.status === 200 && body.ok === true && body.detail === copy.PILOT_REVIEW_DONE_TEXT.excluded_and_completed
        && fc.rpcs.length === 1 && call.name === "resolve_protocol_job_review", JSON.stringify(body));
    check("H23 the job is the ChatGPT slot's (from the pilot's tables, never the body), its project the job's, the reviewer the signed-in founder, the note trimmed",
      call?.args.p_job_id === VJGP && call.args.p_project_id === VPROJ && call.args.p_reviewed_by === FOUNDER
        && call.args.p_resolution === "excluded_and_completed" && call.args.p_note === NOTE.trim(), JSON.stringify(call?.args));
    const fp = fakeClient(reviewTables(), resolvedReply);
    const rp = await review(fp, { engine: "perplexity_sonar", resolution: "failed", note: NOTE });
    check("H24 the Perplexity engine resolves Perplexity's job, with the failed resolution",
      rp.status === 200 && fp.rpcs.length === 1 && fp.rpcs[0].args.p_job_id === VJPX && fp.rpcs[0].args.p_resolution === "failed"
        && (await rp.json()).detail === copy.PILOT_REVIEW_DONE_TEXT.failed);
  }
  {
    const notHeld = fakeClient(reviewTables({ gptStatus: "failed" }), resolvedReply);
    const r = await review(notHeld, { engine: "openai_chatgpt", resolution: "failed", note: NOTE });
    check("H25 a measurement that is not held for review is refused (409) in words, and nothing is resolved",
      r.status === 409 && (await r.json()).error === copy.PILOT_REVIEW_NOT_HELD_TEXT && notHeld.rpcs.length === 0);
    const noSlot = fakeClient(reviewTables({ withGpt: false }), resolvedReply);
    const s = await review(noSlot, { engine: "openai_chatgpt", resolution: "failed", note: NOTE });
    check("H26 a question with no slot on that engine is refused (409) in words, and nothing is resolved",
      s.status === 409 && (await s.json()).error === copy.pilotEngineNotOnQuestionText("openai_chatgpt") && noSlot.rpcs.length === 0);
    const failing = fakeClient(reviewTables(), () => ({ data: null, error: { message: "SENTINEL-RPC-ERROR" } }));
    const f = await review(failing, { engine: "openai_chatgpt", resolution: "failed", note: NOTE });
    const fBody = await f.json();
    check("H27 a database refusal answers in fixed words (409), never the database's message",
      f.status === 409 && fBody.error === copy.PILOT_REVIEW_REFUSED_TEXT && !JSON.stringify(fBody).includes("SENTINEL")
        && !handlerLogs.some((l) => l.includes("SENTINEL")));
    const none = fakeClient(reviewTables(), () => ({ data: [], error: null }));
    const n = await review(none, { engine: "openai_chatgpt", resolution: "failed", note: NOTE });
    check("H28 an RPC that resolves nothing is a refusal (409)", n.status === 409 && none.rpcs.length === 1);
    const other = fakeClient(reviewTables(), resolvedReply);
    const o = await review(other, { engine: "openai_chatgpt", resolution: "failed", note: NOTE }, {}, { pilotId: VP, pilotQuestionId: randomUUID() });
    check("H29 a question that is not this pilot's answers 404, and nothing is resolved", o.status === 404 && other.rpcs.length === 0);
    const reviewLines = handlerLogs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "pilot_question_review");
    check("H30 every review line is closed: the engine, the job and the resolution, never the note",
      reviewLines.length >= 3 && reviewLines.every((l) => !("note" in l)) && handlerLogs.every((l) => !l.includes(NOTE.trim())));
  }

  // Review of phase B (APP-5): the retire route's words with the gate off read each engine's job of the question.
  {
    const retireTables = (px: Record<string, unknown>, gp: Record<string, unknown> | null): Rows => ({
      pilots: [{ id: VP, status: "active", starts_on: daysAgo(1), ends_on: daysAhead(89) }],
      pilot_questions: [{ id: VQ, pilot_id: VP, retired_at: null }],
      pilot_question_protocols: [
        { pilot_question_id: VQ, protocol_id: VPX, engine: "perplexity_sonar", phase: "baseline" },
        ...(gp ? [{ pilot_question_id: VQ, protocol_id: VGP, engine: "openai_chatgpt", phase: "baseline" }] : []),
      ],
      protocol_execution_jobs: [
        { id: VJPX, project_id: VPROJ, protocol_id: VPX, lease_expires_at: null, next_baseline_ordinal: 2, ...px },
        ...(gp ? [{ id: VJGP, project_id: VPROJ, protocol_id: VGP, lease_expires_at: null, next_baseline_ordinal: 2, ...gp }] : []),
      ],
      protocols: [{ id: VPX, planned_baseline_runs: 5 }, { id: VGP, planned_baseline_runs: 5 }],
    });
    const NOW = Date.now();
    const words = (fc: ReturnType<typeof fakeClient>, outcome: Parameters<typeof handlers.retireRefusalWords>[2], gateOn: boolean) =>
      handlers.retireRefusalWords(() => fc.client, idsV, outcome, gateOn, () => NOW);
    const retryableGpt = fakeClient(retireTables({ status: "succeeded" }, { status: "failed" }));
    check("H41 retire refusal with the gate off: a retryable ChatGPT measurement is named, with the gate as the reason it can't be retried now",
      (await words(retryableGpt, "QUESTION_RETRYABLE", false)) === copy.RETIRE_RETRYABLE_CHATGPT_OFF
        && retryableGpt.reads.some((r) => r.table === "protocol_execution_jobs"));
    const lapsed = fakeClient(retireTables({ status: "abandoned_exhausted" },
      { status: "running", lease_expires_at: new Date(NOW - 60_000).toISOString() }));
    const live = fakeClient(retireTables({ status: "abandoned_exhausted" },
      { status: "running", lease_expires_at: new Date(NOW + 60_000).toISOString() }));
    check("H42 an unfinished ChatGPT run whose lease lapsed is named, with the gate as the reason; one still running keeps the usual words",
      (await words(lapsed, "QUESTION_JOB_ACTIVE", false)) === copy.RETIRE_UNFINISHED_CHATGPT_OFF
        && (await words(live, "QUESTION_JOB_ACTIVE", false)) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_JOB_ACTIVE);
    const untouched = fakeClient(retireTables({ status: "succeeded" }, { status: "failed" }));
    const other = await words(untouched, "PILOT_CLOSED", false);
    const gateOn = await words(untouched, "QUESTION_RETRYABLE", true);
    const noGpt = fakeClient(retireTables({ status: "failed" }, null));
    check("H43 with the gate on, or for any other refusal, nothing is read and the fixed words come back; with no ChatGPT measurement, the usual words",
      other === copy.RETIRE_QUESTION_REFUSAL.PILOT_CLOSED && gateOn === copy.RETIRE_QUESTION_REFUSAL.QUESTION_RETRYABLE && untouched.reads.length === 0
        && (await words(noGpt, "QUESTION_RETRYABLE", false)) === copy.RETIRE_QUESTION_REFUSAL.QUESTION_RETRYABLE);
    const broken = await handlers.retireRefusalWords(() => { throw new Error("SENTINEL-CLIENT"); }, idsV, "QUESTION_RETRYABLE", false);
    check("H44 a client that cannot be built, or a read that fails, falls back to the fixed words (never thrown, never echoed)",
      broken === copy.RETIRE_QUESTION_REFUSAL.QUESTION_RETRYABLE);
  }

  // The Run and Retry routes themselves, with a founder session: the engine
  // and the gate are checked before anything is read or started. A body that
  // passes them reaches the slot read, which needs the service client; with
  // no Supabase configuration in this test that client throws, which is how
  // the test sees the read was reached and nothing before it read or started.
  const { __setSupabaseServerClientForTests } = await import("@/lib/supabase/server");
  let sessionUser: { id: string; email: string } = { id: FOUNDER, email: "founder@zypact.example" };
  __setSupabaseServerClientForTests({
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: null }) },
  } as unknown as SupabaseClient);
  const savedEnv = {
    founders: process.env.SNAPSHOT_FOUNDER_EMAILS,
    approval: process.env.SNAPSHOT_APPROVAL_ENABLED,
    gate: process.env.ZYPACT_PILOT_CHATGPT_ENABLED,
  };
  process.env.SNAPSHOT_FOUNDER_EMAILS = "founder@zypact.example";
  process.env.SNAPSHOT_APPROVAL_ENABLED = "true";
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  const runRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/run/route");
  const retryRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/retry/route");
  const SERVICE_CLIENT_MISSING = "Supabase service-role configuration is required for report review.";
  const routeParams = () => ({ params: Promise.resolve({ pilotId: randomUUID(), pilotQuestionId: randomUUID() }) });
  const outcomeOf = async (p: Promise<Response>): Promise<{ status?: number; body?: Record<string, unknown>; threw?: string }> => {
    try {
      const r = await p;
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) };
    }
  };
  const runWith = (text: string) => outcomeOf(runRoute.POST(rawPost(text), routeParams()));
  const retryWith = (body: unknown) => outcomeOf(retryRoute.POST(jsonPost(body), routeParams()));
  const RETRY = { note: "Perplexity returned HTTP 500 on run 2.", idempotencyKey: randomUUID() };
  const reachedRead = (o: { threw?: string }) => o.threw === SERVICE_CLIENT_MISSING;
  const refusedOff = (o: { status?: number; body?: Record<string, unknown> }) =>
    o.status === 409 && o.body?.error === copy.PILOT_CHATGPT_NOT_CONNECTED;

  const runUnknown = await runWith(JSON.stringify({ engine: "gemini" }));
  check("H31 Run: an engine outside the closed set is refused (400) before anything is read",
    runUnknown.status === 400 && runUnknown.body?.error === "invalid_engine", JSON.stringify(runUnknown));
  const runOff = await runWith(JSON.stringify(GPT));
  check("H32 Run on ChatGPT with the gate off is refused (409) in words before anything is read or started", refusedOff(runOff), JSON.stringify(runOff));
  process.env.ZYPACT_PILOT_CHATGPT_ENABLED = "TRUE";
  const runAlmost = await runWith(JSON.stringify(GPT));
  process.env.ZYPACT_PILOT_CHATGPT_ENABLED = "true";
  const runOn = await runWith(JSON.stringify(GPT));
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  check("H33 only exactly \"true\" opens the gate: then a ChatGPT Run goes on to read its slot",
    refusedOff(runAlmost) && reachedRead(runOn), JSON.stringify([runAlmost, runOn]));
  const runEmpty = await runWith("");
  const runNoEngine = await runWith("{}");
  check("H34 Run with no body or no engine is Perplexity's, as before D-061, and is not behind the ChatGPT gate",
    reachedRead(runEmpty) && reachedRead(runNoEngine), JSON.stringify([runEmpty, runNoEngine]));
  const runBroken = await runWith("{not json");
  const runHuge = await runWith(JSON.stringify({ engine: "perplexity_sonar", pad: "x".repeat(2000) }));
  check("H35 Run: an unreadable body is refused (400) and an oversized one (413)",
    runBroken.status === 400 && runHuge.status === 413, JSON.stringify([runBroken.status, runHuge.status]));
  sessionUser = { id: randomUUID(), email: "someone@else.example" };
  const runStranger = await runWith(JSON.stringify({ engine: "gemini" }));
  sessionUser = { id: FOUNDER, email: "founder@zypact.example" };
  check("H36 Run: the founder guard comes before the engine is even read", runStranger.status === 404, JSON.stringify(runStranger));

  const retryUnknown = await retryWith({ ...RETRY, engine: "perplexity" });
  const retryOff = await retryWith({ ...RETRY, ...GPT });
  check("H37 Retry: an unknown engine (400) and ChatGPT with the gate off (409, in words) are refused before anything is read or reserved",
    retryUnknown.status === 400 && retryUnknown.body?.error === "invalid_engine" && refusedOff(retryOff), JSON.stringify([retryUnknown, retryOff]));
  process.env.ZYPACT_PILOT_CHATGPT_ENABLED = "true";
  const retryOn = await retryWith({ ...RETRY, ...GPT });
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  const retryNoEngine = await retryWith(RETRY);
  check("H38 Retry on ChatGPT with the gate on, and Retry with no engine (Perplexity), go on to read their slot",
    reachedRead(retryOn) && reachedRead(retryNoEngine), JSON.stringify([retryOn, retryNoEngine]));
  const retryNoNote = await retryWith({ ...GPT });
  check("H39 Retry still asks for its note first", retryNoNote.status === 400, JSON.stringify(retryNoNote));
  process.env.SNAPSHOT_APPROVAL_ENABLED = "false";
  const retryKilled = await retryWith({ ...RETRY, ...GPT });
  check("H40 Retry: the kill switch still comes first", retryKilled.status === 503, JSON.stringify(retryKilled));
  process.env.SNAPSHOT_APPROVAL_ENABLED = "true";

  // Review of phase B (APP-8): the add-question route itself, with a founder session and the memory database,
  // when ChatGPT is asked for and does not get added (the gate is off, or the follow-up call fails).
  const addRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/route");
  const aPilot = await db.createPilot(createInput("pilot-h4.example"));
  const addBody = (n: number, over: Record<string, unknown> = {}) => ({
    questionText: question(n), questionProvenance: "customer_supplied", customerApprovalRef: "Email of 12 Nov",
    customerApprovedOn: today(), idempotencyKey: randomUUID(), addChatGpt: true, ...over,
  });
  const addWith = async (body: unknown) => {
    const r = await addRoute.POST(jsonPost(body), { params: Promise.resolve({ pilotId: aPilot.pilotId! }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const slotsOfText = (n: number) => {
    const qRow = [...store().pilotQuestions.values()].find((q) => q.pilotId === aPilot.pilotId
      && store().buyerQuestionVersions.get((q as unknown as { buyerQuestionVersionId: string }).buyerQuestionVersionId)?.promptText === question(n));
    return qRow ? slotsOf(qRow.id).map((s) => s.engine).sort().join(",") : "none";
  };
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  const offAdd = await addWith(addBody(960));
  check("H45 add-question with ChatGPT asked for and the gate off: the question is added (201) with its Perplexity measurement only, chatgptAdded false, and the reply says ChatGPT was not added and why",
    offAdd.status === 201 && offAdd.body.ok === true && offAdd.body.chatgptAdded === false
      && offAdd.body.detail === `Question added and its Perplexity measurement queued; ChatGPT was not added. ${copy.PILOT_CHATGPT_NOT_CONNECTED_YET} Nothing runs until you press Run for it.`
      && slotsOfText(960) === "perplexity_sonar", JSON.stringify(offAdd));
  process.env.ZYPACT_PILOT_CHATGPT_ENABLED = "true";
  // The route's getDb() is this same memory adapter object; its follow-up call is made to fail for one request.
  const memoryAdapterRef = db as { addPilotQuestionEngine: DbAdapter["addPilotQuestionEngine"] };
  const realAddEngine = memoryAdapterRef.addPilotQuestionEngine;
  memoryAdapterRef.addPilotQuestionEngine = async () => { throw Object.assign(new Error("SENTINEL-FOLLOW-UP"), { code: "P0001" }); };
  let failedAdd: Awaited<ReturnType<typeof addWith>>;
  try {
    failedAdd = await addWith(addBody(961));
  } finally {
    memoryAdapterRef.addPilotQuestionEngine = realAddEngine;
  }
  check("H46 add-question with the gate on and the ChatGPT follow-up failing: the question stays with Perplexity (201), chatgptAdded false, in words, and the error is never echoed",
    failedAdd.status === 201 && failedAdd.body.chatgptAdded === false
      && failedAdd.body.detail === `Question added and its Perplexity measurement queued; ChatGPT was not added. ${copy.ADD_CHATGPT_FAILED_TEXT} Nothing runs until you press Run for it.`
      && !JSON.stringify(failedAdd.body).includes("SENTINEL") && slotsOfText(961) === "perplexity_sonar", JSON.stringify(failedAdd));
  const okAddRoute = await addWith(addBody(962));
  const plainAdd = await addWith(addBody(963, { addChatGpt: undefined }));
  check("H47 controls: with the gate on and the follow-up working, both measurements are queued (chatgptAdded true); without asking, ChatGPT is not tried (chatgptAdded null)",
    okAddRoute.status === 201 && okAddRoute.body.chatgptAdded === true && slotsOfText(962) === "openai_chatgpt,perplexity_sonar"
      && plainAdd.status === 201 && plainAdd.body.chatgptAdded === null && slotsOfText(963) === "perplexity_sonar", JSON.stringify([okAddRoute.body, plainAdd.body]));
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;

  // ...and the retire route with the gate off: without a service client it falls back to the fixed words, never fails.
  const retireRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/retire/route");
  const rq = await db.addPilotQuestion(addInput(aPilot.pilotId!, question(964)));
  const rqChatGpt = await db.addPilotQuestionEngine({ pilotId: aPilot.pilotId!, pilotQuestionId: rq.pilotQuestionId!, engine: "openai_chatgpt", addedBy: FOUNDER });
  setJob(rqChatGpt.jobId!, { status: "failed", failureReason: "provider_error", currentAttemptId: null, nextBaselineOrdinal: 1 }); // test setup: a ChatGPT provider failure
  (store().protocolAttempts as unknown as Map<string, unknown>).set(randomUUID(), {
    id: randomUUID(), projectId: aPilot.projectId!, jobId: rqChatGpt.jobId!, protocolId: rqChatGpt.protocolId!, status: "failed",
    terminalizedAt: new Date().toISOString(), baselineOrdinal: 1, retryOfAttemptId: null,
  }); // test setup: its failed attempt in slot 1, retryable
  const retireRes = await retireRoute.POST(jsonPost({ reason: "ChatGPT cannot go on for this question." }),
    { params: Promise.resolve({ pilotId: aPilot.pilotId!, pilotQuestionId: rq.pilotQuestionId! }) });
  const retireBody = (await retireRes.json()) as Record<string, unknown>;
  check("H48 the retire route answers a retryable ChatGPT measurement with the gate off (409, QUESTION_RETRYABLE) in fixed words when the engines cannot be read; the question stays",
    retireRes.status === 409 && retireBody.outcome === "QUESTION_RETRYABLE" && retireBody.error === copy.RETIRE_QUESTION_REFUSAL.QUESTION_RETRYABLE
      && (store().pilotQuestions.get(rq.pilotQuestionId!) as unknown as { retiredAt: string | null }).retiredAt === null, JSON.stringify(retireBody));
  const retireSrc = read("app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/retire/route.ts");
  check("H49 the retire route words a refusal through retireRefusalWords with a lazily built service client and the gate read at request time, after the database answered",
    retireSrc.includes("await retireRefusalWords(\n    getReportServiceClient,\n    { pilotId, pilotQuestionId },\n    outcome,\n    pilotChatGptEnabled()\n  );")
      && retireSrc.indexOf("getDb().retirePilotQuestion(") < retireSrc.indexOf("retireRefusalWords(")
      && !retireSrc.includes("RETIRE_QUESTION_REFUSAL["));
  __setSupabaseServerClientForTests(null);
  for (const [k, v] of [["SNAPSHOT_FOUNDER_EMAILS", savedEnv.founders], ["SNAPSHOT_APPROVAL_ENABLED", savedEnv.approval],
    ["ZYPACT_PILOT_CHATGPT_ENABLED", savedEnv.gate]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  /* V: one engine's cell, rendered (review of phase B, APP-8) --------------- */
  // The cell the pilot page renders per question and engine (S38, S39 check
  // the page passes it the gate's connection), rendered for real: with the
  // web gate off, ChatGPT offers no Run, Resume or Retry, whatever its state.
  console.log("\n[V] one engine's cell, rendered");
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
  const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
  const { PilotEngineCell } = await import("@/app/admin/pilots/pilot-engine-cell");
  const measurement = (engine: "perplexity_sonar" | "openai_chatgpt", over: Record<string, unknown> = {}) => ({
    engine, protocolId: randomUUID(), jobId: randomUUID(), jobStatus: "queued", needsReviewReason: null, stale: false,
    plannedRuns: 5, runCap: 7, spendCapUsd: engine === "openai_chatgpt" ? 4 : 2, completedRuns: 0, failedRuns: 0, excludedRuns: 0, ...over,
  });
  const cellHtml = (engine: "perplexity_sonar" | "openai_chatgpt", m: Record<string, unknown> | null, o: { connected: boolean; canAddChatGpt?: boolean; retired?: boolean; pilotOpen?: boolean }) =>
    renderToStaticMarkup(createElement(PilotEngineCell, {
      pilotId: randomUUID(), pilotQuestionId: randomUUID(), engine, measurement: m === null ? null : measurement(engine, m),
      connected: o.connected, canAddChatGpt: o.canAddChatGpt ?? o.connected, retired: o.retired ?? false, pilotOpen: o.pilotOpen ?? true,
    }));
  const RUN = />Run<\/button>/;
  const RESUME = />Resume<\/button>/;
  const RETRY_BUTTON = />Retry failed run<\/button>/;
  const gateOff = { connected: false };
  const offCells = [
    cellHtml("openai_chatgpt", { jobStatus: "queued" }, gateOff),
    cellHtml("openai_chatgpt", { jobStatus: "running", stale: true }, gateOff),
    cellHtml("openai_chatgpt", { jobStatus: "failed", failedRuns: 1 }, gateOff),
  ];
  check("V1 gate off: a queued, a lapsed and a failed ChatGPT measurement offer no Run, Resume or Retry, and each says Run and Retry are off",
    offCells.every((h) => !RUN.test(h) && !RESUME.test(h) && !RETRY_BUTTON.test(h) && h.includes(copy.ENGINE_NOT_CONNECTED_CONTROLS_NOTE)),
    offCells.map((h) => h.slice(0, 120)).join(" | "));
  const heldOff = cellHtml("openai_chatgpt", { jobStatus: "needs_review", needsReviewReason: "perplexity_outcome_unknown" }, gateOff);
  check("V2 gate off: a held ChatGPT measurement still offers both review resolutions (they spend nothing), and no Run",
    heldOff.includes(copy.PILOT_REVIEW_BUTTON_LABEL.excluded_and_completed) && heldOff.includes(copy.PILOT_REVIEW_BUTTON_LABEL.failed)
      && heldOff.includes(copy.pilotHeldReasonText("perplexity_outcome_unknown", "openai_chatgpt")) && !RUN.test(heldOff));
  const onCells = {
    queued: cellHtml("openai_chatgpt", { jobStatus: "queued" }, { connected: true }),
    lapsed: cellHtml("openai_chatgpt", { jobStatus: "running", stale: true }, { connected: true }),
    failed: cellHtml("openai_chatgpt", { jobStatus: "failed", failedRuns: 1 }, { connected: true }),
    closed: cellHtml("openai_chatgpt", { jobStatus: "queued" }, { connected: true, pilotOpen: false }),
  };
  check("V3 controls, gate on: the same ChatGPT measurements offer Run, Resume and Retry, and none once the pilot is over or the question retired",
    RUN.test(onCells.queued) && RESUME.test(onCells.lapsed) && RETRY_BUTTON.test(onCells.failed)
      && !RUN.test(onCells.closed) && !onCells.queued.includes(copy.ENGINE_NOT_CONNECTED_CONTROLS_NOTE));
  check("V4 Perplexity is never behind the gate: with ChatGPT off (Perplexity is always connected) it offers Run and Retry",
    RUN.test(cellHtml("perplexity_sonar", { jobStatus: "queued" }, { connected: true, canAddChatGpt: false }))
      && RETRY_BUTTON.test(cellHtml("perplexity_sonar", { jobStatus: "failed", failedRuns: 1 }, { connected: true, canAddChatGpt: false })));
  const ADD = new RegExp(`>${copy.ADD_CHATGPT_BUTTON_LABEL}</button>`);
  check("V5 a question without ChatGPT reads \"Not measured\", never zero, and offers Add ChatGPT only when the gate allows it and the question is live",
    [cellHtml("openai_chatgpt", null, gateOff), cellHtml("openai_chatgpt", null, { connected: true }), cellHtml("openai_chatgpt", null, { connected: true, retired: true })]
      .every((h) => h.includes(copy.ENGINE_NOT_MEASURED) && !/\b0 of\b/.test(h))
      && !ADD.test(cellHtml("openai_chatgpt", null, gateOff)) && ADD.test(cellHtml("openai_chatgpt", null, { connected: true }))
      && !ADD.test(cellHtml("openai_chatgpt", null, { connected: true, retired: true }))
      && !ADD.test(cellHtml("perplexity_sonar", null, { connected: true })));
  check("V6 the cell counts runs as the customer report does (APP-7): failed (a timeout included) and excluded after review",
    cellHtml("openai_chatgpt", { jobStatus: "succeeded", completedRuns: 3, failedRuns: 1, excludedRuns: 1 }, gateOff).includes("3 of 5 runs completed, 1 failed, 1 excluded after review"));

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "Pilot questions PASSED." : `${failures} check(s) failed. Pilot questions FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
