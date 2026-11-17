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
 *   C  copy: the Run confirmation, refusals and labels.
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
  check("S6 only Perplexity's baseline slot exists until ChatGPT is wired (D-053 item 3)",
    code.includes("engine             text not null check (engine = 'perplexity_sonar')")
      && code.includes("phase              text not null check (phase = 'baseline')"));
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
      && runSrc.includes('start.refusal === "JOB_ATTEMPTS_EXHAUSTED" ? PILOT_JOB_ABANDONED_TEXT')
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
  const page = read("app/admin/pilots/[pilotId]/page.tsx");
  check("S24 the pilot page shows ChatGPT as not measured and provenance in words, never the stored code",
    page.includes("{ENGINE_NOT_MEASURED}") && page.includes("pilotProvenanceLabel(q.questionProvenance)")
      && !/>\s*\{q\.questionProvenance\}\s*</.test(page) && !/>\s*\{m\.jobStatus\}\s*</.test(page));
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
  const texts = [
    ...Object.values(copy.CREATE_PILOT_REFUSAL), ...Object.values(copy.ADD_QUESTION_REFUSAL), ...Object.values(copy.CLOSE_PILOT_REFUSAL),
    ...["queued", "claimed", "running", "succeeded", "failed", "needs_review", "abandoned_exhausted", "other", null].map((s) => copy.pilotJobStatusLabel(s, false)),
    copy.pilotProvenanceLabel("customer_supplied"), copy.pilotProvenanceLabel("founder_supplied"), copy.pilotProvenanceLabel("x"),
    copy.ENGINE_NOT_MEASURED,
  ];
  check("C3 no refusal or label shows a stored code", texts.every((t) => !/[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t)), texts.find((t) => /[A-Z]{2,}_[A-Z]|[a-z]+_[a-z]+/.test(t)) ?? "");
  check("C4 no pilot copy uses a forbidden claim phrase",
    [...texts, confirm].every((t) => !FORBIDDEN_W1_PHRASES.some((p) => t.toLowerCase().includes(p))));
  check("C5 suppliers are named in words", copy.pilotProvenanceLabel("customer_supplied") === "Supplied by the customer"
    && copy.pilotProvenanceLabel("founder_supplied") === "Supplied by Zypact");
  check("C6 ChatGPT is listed and not connected; it reads Not measured, never zero",
    copy.PILOT_ENGINES.some((e) => e.key === "openai_chatgpt" && !e.connected) && copy.ENGINE_NOT_MEASURED === "Not measured");

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

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "Pilot questions PASSED." : `${failures} check(s) failed. Pilot questions FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
