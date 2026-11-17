#!/usr/bin/env tsx
/**
 * Pilot questions (D-054), offline.
 *
 *   M  the memory mirrors of create_pilot, add_pilot_question, close_pilot
 *      and the pilot gate in request_protocol_job_run, branch for branch;
 *   W  the real worker loop on the memory adapter: a pilot question's Run
 *      claims that question's job only, its five runs send the approved
 *      question for the pilot's company, and a closed pilot runs nothing;
 *   S  static contracts: the migration (including the two parity checks
 *      against pilot step 1), the routes, the pages and the preflight;
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

  /* S: static contracts ---------------------------------------------------- */
  console.log("\n[S] static contracts");
  const DIR = "supabase/migrations";
  const FILE = "20261118120000_pilot_questions.sql";
  const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok);
  const parsed = parseMigrationName(FILE);
  check("S1 the migration name is valid, follows pilot step 1 and is the newest", parsed.ok && parsed.kind === "timestamp"
    && (parsed.ok ? parsed.version : 0) > 20261114120000
    && Math.max(...versions.map((r) => (r.ok ? r.version : 0))) === (parsed.ok ? parsed.version : -1));
  const sql = read(path.join(DIR, FILE));
  const code = sql.replace(/--[^\n]*/g, "");
  const defined = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)/gi)].map((m) => m[1]).sort();
  check("S2 it defines exactly the three pilot functions and the Run request redefinition",
    defined.join(",") === ["add_pilot_question", "close_pilot", "create_pilot", "request_protocol_job_run"].join(","), defined.join(","));
  const blocks = code.split(/create\s+or\s+replace\s+function/i).slice(1);
  check("S3 every function is SECURITY DEFINER with search_path pinned",
    blocks.length === 4 && blocks.every((b) => /security definer/i.test(b) && /set search_path = public, pg_temp/i.test(b)));
  const SIGNATURES = [
    "create_pilot(uuid, text, text, text, text, integer, date, uuid)",
    "add_pilot_question(uuid, uuid, text, text, text, text, date, uuid)",
    "close_pilot(uuid, uuid, text)",
    "request_protocol_job_run(uuid, uuid, text, uuid, integer)",
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
  check("S7 a pilot holds at most 20 questions and lasts 90 days",
    code.includes("check (question_limit between 1 and 20)") && code.includes("check (ordinal between 1 and 20)")
      && code.includes("check (ends_on = starts_on + 90)") && code.includes("p_starts_on + 90"));
  check("S8 no evidence row is written directly",
    !/(insert\s+into|update|delete\s+from)\s+public\.(protocol_attempts|protocol_external_calls|provider_call_receipts|analysis_call_receipts|external_call_requests|probe_runs|probe_results)\b/i.test(code));
  check("S9 the only rows updated are a pilot's close, and the Run request's own housekeeping",
    [...code.matchAll(/update\s+public\.([a-z_]+)/gi)].every((m) =>
      ["pilots", "protocol_job_run_requests", "protocol_execution_jobs"].includes(m[1])));
  check("S10 nothing from the account stack is referenced (it may apply before Q2'-1)",
    !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_s1_[a-z_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(code));
  const GUARDED = [
    "claim_protocol_execution_job", "claim_protocol_execution_job_by_id", "claim_requested_protocol_execution_job",
    "authorize_operator_retry", "retry_failed_protocol_job", "reactivate_abandoned_job", "resolve_protocol_job_review",
    "complete_protocol_execution_job", "abort_attempt_and_fail_job_for_job", "admit_and_reserve_attempt_for_job",
    "_admit_and_reserve_attempt_core", "reconcile_attempt_for_job", "approve_protocol", "approve_buyer_question_version",
    "enqueue_protocol_execution_job", "approve_and_launch_snapshot_baseline", "create_snapshot_request_as_founder",
    "begin_snapshot_report_delivery",
  ];
  check("S11 it redefines none of the guarded approval, queue, claim, retry or request functions",
    GUARDED.every((fn) => !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i").test(code)));
  check("S12 the requested_via CHECK keeps step 1's four starts and adds admin_pilot_run only",
    code.includes("check (requested_via in (\n    'admin_run_pipeline', 'admin_run_retest',\n    'admin_founder_baseline', 'operator_cli', 'admin_pilot_run'\n  ));"));

  // Parity 1: request_protocol_job_run is step 1's, with two changes only.
  const step1 = read(path.join(DIR, "20261114120000_pilot_step1_operator_controls.sql"));
  const fnOf = (src: string, name: string) => {
    const start = src.indexOf(`create or replace function public.${name}(`);
    return src.slice(start, src.indexOf("\n$$;\n", start) + 5);
  };
  const actualRun = fnOf(sql, "request_protocol_job_run");
  const pilotBlock = actualRun.slice(
    actualRun.indexOf("\n  -- D-054: a pilot's measurement runs only"),
    actualRun.indexOf("\n  -- A dead lease with no claims left")
  );
  let expectedRun = fnOf(step1, "request_protocol_job_run");
  const swapRun = (from: string, to: string) => {
    if (expectedRun.split(from).length !== 2) throw new Error(`step 1 no longer contains exactly once: ${from.slice(0, 60)}`);
    expectedRun = expectedRun.replace(from, to);
  };
  swapRun("'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli'\n     )",
    "'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli',\n       'admin_pilot_run'\n     )");
  const notFound = "  if not v_found then\n    return query select 'JOB_NOT_FOUND'::text, null::uuid, null::timestamptz;\n    return;\n  end if;\n";
  swapRun(notFound, notFound + pilotBlock);
  check("S13 request_protocol_job_run is pilot step 1's, byte for byte, apart from admin_pilot_run and the pilot block",
    pilotBlock.length > 0 && actualRun === expectedRun);
  check("S14 the pilot block refuses a closed pilot and one past its end date, after the job is found and locked",
    pilotBlock.includes("pl.status <> 'active' or current_date > pl.ends_on")
      && pilotBlock.includes("'PILOT_CLOSED'::text")
      && actualRun.indexOf(pilotBlock) > actualRun.indexOf("for update nowait")
      && actualRun.indexOf(pilotBlock) < actualRun.indexOf("insert into public.protocol_job_run_requests"));

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
  check("S19 close_pilot changes no job", !fnOf(sql, "close_pilot").includes("protocol_execution_jobs"));

  // Routes.
  const R = "app/api/internal/pilots";
  const routeFiles = {
    create: `${R}/route.ts`,
    add: `${R}/[pilotId]/questions/route.ts`,
    close: `${R}/[pilotId]/close/route.ts`,
    run: `${R}/[pilotId]/questions/[pilotQuestionId]/run/route.ts`,
    retry: `${R}/[pilotId]/questions/[pilotQuestionId]/retry/route.ts`,
  };
  for (const key of ["create", "add", "close", "retry"] as const) {
    const src = read(routeFiles[key]);
    check(`S20 ${key}: the kill switch, then the founder guard, the actor from the session`,
      src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') > 0
        && src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') < src.indexOf("requireFounderForRoute(")
        && /(createdBy|addedBy|closedBy|actor): guard\.user\.id/.test(src));
  }
  const runSrc = read(routeFiles.run);
  check("S21 run: founder guard, then the pilot window, then the job state, then a start naming its job as admin_pilot_run",
    runSrc.indexOf("requireFounderForRoute(") > 0
      && runSrc.indexOf("pilotIsOver(") > runSrc.indexOf("requireFounderForRoute(")
      && ["\"failed\"", "\"abandoned_exhausted\"", "\"succeeded\"", "\"needs_review\""].every((s) => runSrc.indexOf(s) > 0 && runSrc.indexOf(s) < runSrc.indexOf("startWorkerMachine({"))
      && runSrc.includes('via: "admin_pilot_run"') && runSrc.includes("requestedBy: guard.user.id"));
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
  check("S25 the founder-experiments list leaves pilot protocols out",
    read("app/admin/snapshot-requests/page.tsx").includes("for (const protocolId of await pilotProtocolIds(client)) attachedIds.add(protocolId);"));
  const fly = read("lib/worker-control/fly-machine.ts");
  check("S26 the start path accepts admin_pilot_run and has fixed words for PILOT_CLOSED",
    fly.includes('"admin_founder_baseline" | "admin_pilot_run"') && /PILOT_CLOSED:\s*\n\s*"This pilot is closed/.test(fly));
  const preflight = read("scripts/sql/prod-preflight.sql");
  check("S27 the preflight checks the version, the three tables and the three functions as absent",
    (preflight.match(/'20261118120000'/g) ?? []).length === 2
      && TABLES.every((t) => preflight.includes(`('${t}')`))
      && ["create_pilot", "add_pilot_question", "close_pilot"].every((f) => preflight.includes(`('${f}')`)));
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
  });
  check("C7 the website is normalized as a request's, and the limit read as a number",
    okCreate.ok && okCreate.value.normalizedDomain === "acme.example" && okCreate.value.websiteUrl === "https://www.acme.example"
      && okCreate.value.companyName === "Acme" && okCreate.value.questionLimit === 15);
  const badCreate = parseCreatePilot({ companyName: "A", websiteUrl: "localhost", siteControlNote: "x", questionLimit: 21, startsOn: "2026-02-30", idempotencyKey: "k" });
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

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "Pilot questions PASSED." : `${failures} check(s) failed. Pilot questions FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
