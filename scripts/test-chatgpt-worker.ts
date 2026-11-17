/**
 * D-056 phase A — the ChatGPT engine in the worker, switch off by default.
 *
 * Offline: the in-memory ledger, fake fetch, synthetic bodies shaped like the
 * stored 2026-11-17 confirmation-run responses. No network, no database, no
 * real key (OPENAI_PROBE_API_KEY and PERPLEXITY_API_KEY are set to sentinels
 * for the adapters' own presence checks only).
 *
 *   npm run test:chatgpt-worker
 */

import fs from "node:fs";

import { sha256Hex } from "@/lib/evidence/hash";
import type { DbAdapter } from "@/lib/db/types";
import { CHATGPT_PROVIDER, chatGptCitedUrls, chatGptSearchSources, runChatGptProbe, approvedChatGptSetting, type ChatGptSetting } from "@/lib/probes/chatgpt";
import { chatGptUsageFromBody, estimateChatGptCostUsd, worstCaseRunUsd } from "@/lib/probes/chatgpt-pricing";
import { OPENAI_RESPONSES_ENDPOINT } from "@/lib/probes/endpoints";
import { isFlexResourceUnavailable } from "@/lib/probes/openai-flex";
import { normalizeUrl, runPerplexityProbe, PerplexityProbeFailure } from "@/lib/probes/perplexity";
import { buildChatGptEngine, chatGptAnswerFromBody } from "@/lib/protocol-worker/chatgpt-engine";
import {
  CHATGPT_WORKER_SCHEMA_READY,
  claimBudgetMs,
  claimBudgetWithChatGptMs,
  resolveExecutionPlan,
  WorkerConfigError,
} from "@/lib/protocol-worker/execution-mode";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import {
  CHATGPT_PROTOCOL_PROVIDER,
  chatGptProfile,
  estimatedChatGptCost,
  FLEX_CAPACITY_UNAVAILABLE,
  perplexityProfile,
  providerProfileFor,
} from "@/lib/protocol-worker/provider-profile";
import type { AnalysisTransport, ChatGptEngine, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import { answerFromRawResponseBody, probeRunnerForProtocol, runOneIteration } from "@/lib/protocol-worker/worker";
import { CHATGPT_SURFACE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION, surfaceLimitation } from "@/lib/reports/surface-limitations";
import { buildSourceInsights } from "@/lib/source-insights/build-source-insights";
import {
  extractProviderSources,
  OPENAI_RESPONSES_SOURCES_RULE_VERSION,
  openAiBodyCitations,
  openAiBodySearchSourceUrls,
  PROVIDER_SOURCES_RULE_VERSION,
  sourcesRuleVersionForProvider,
} from "@/lib/source-insights/extract-provider-sources";

// The worker's leg deadlines are unref'd timers. A test waiting on one with
// nothing else pending would let Node exit early with status 0 — a silent
// pass. Keep the loop alive, and fail if it ever ends before the summary.
const keepAlive = setInterval(() => {}, 1_000);
let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    console.log("FAILED: the test ended before its summary");
    process.exit(1);
  }
});

process.env.OPENAI_PROBE_API_KEY = "SENTINEL-NOT-A-KEY";
process.env.PERPLEXITY_API_KEY = "SENTINEL-NOT-A-KEY";

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const QUESTION = "Which project management tools suit a small remote agency?";
const APPROVED = approvedChatGptSetting("auto");
if (!APPROVED) throw new Error("fixture: no approved ChatGPT setting");
const SETTING: ChatGptSetting = APPROVED;
const MODEL = SETTING.model;
const VERSION = SETTING.version;

type Wire = { url: string; init: RequestInit };
function fixtureFetch(status: number, body: string, wire: Wire[], headers: Record<string, string> = { "x-request-id": "req_fixture" }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    wire.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

/** Shaped like the stored confirmation-run bodies: web_search_call sources, url_citation annotations, flex. */
function chatgptBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp_fixture_1",
    object: "response",
    created_at: 1763380000,
    status: "completed",
    error: null,
    model: MODEL,
    service_tier: "flex",
    max_output_tokens: 8000,
    reasoning: { effort: "low" },
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "web_search_call", id: "ws_1", status: "completed",
        action: {
          type: "search", query: "project management tools small agency",
          sources: [
            { type: "url", url: "https://vendor-a.example/pricing?utm_source=openai" },
            { type: "url", url: "https://reviews.example/compare" },
            { type: "url", url: "https://forum.example/thread?id=7" },
          ],
        },
      },
      { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url: "https://vendor-a.example/pricing" } },
      {
        type: "message", id: "msg_1", role: "assistant", status: "completed",
        content: [{
          type: "output_text",
          text: "Vendor A fits small remote agencies. Reviewers compare it favourably. A forum thread agrees.",
          annotations: [
            { type: "url_citation", start_index: 0, end_index: 8, url: "https://vendor-a.example/pricing?utm_source=openai", title: "Vendor A pricing" },
            { type: "url_citation", start_index: 37, end_index: 46, url: "https://reviews.example/compare?ref=x&utm_source=openai", title: "Compare tools" },
            { type: "url_citation", start_index: 70, end_index: 75, url: "not a url", title: "broken" },
            { type: "url_citation", start_index: 80, end_index: 85, url: "https://vendor-a.example/pricing?utm_source=openai", title: "Vendor A pricing" },
          ],
        }],
      },
    ],
    usage: {
      input_tokens: 12000, input_tokens_details: { cached_tokens: 2000 },
      output_tokens: 900, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 12900,
    },
    ...over,
  });
}

function sonarBody(): string {
  return JSON.stringify({
    id: "sonar-fixture", model: "sonar",
    choices: [{ message: { content: "Vendor A is often recommended [1]." } }],
    citations: ["https://vendor-a.example/"],
    search_results: [{ url: "https://vendor-a.example/", title: "Vendor A" }],
    usage: { cost: { total_cost: 0.006 } },
  });
}

const ANALYSIS_BODY = JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] });
const ANALYSIS_OUT = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "None." });
const analysis: AnalysisTransport = {
  prepare: () => ({ provider: "openai" as const, model: "gpt-4o-2024-08-06", url: "https://api.openai.com/v1/chat/completions",
    rawRequestBody: ANALYSIS_BODY, requestSha256: sha256Hex(ANALYSIS_BODY) }),
  execute: async () => ({ provider: "openai" as const, model: "gpt-4o-2024-08-06", content: ANALYSIS_OUT, usedMock: false,
    modelReturned: "gpt-4o-2024-08-06", latencyMs: 5, requestSha256: sha256Hex(ANALYSIS_BODY),
    contentSha256: sha256Hex(ANALYSIS_OUT), providerRequestId: "a-1", httpStatus: 200, usage: null }),
};

const OPTS: WorkerOptions = {
  workerId: "d056-test", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 4,
  perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
  exitAfterClaimedJob: false, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
};

function engine(over: { callTimeoutMs?: number } = {}): ChatGptEngine {
  const e = buildChatGptEngine({ callTimeoutMs: over.callTimeoutMs ?? 290000, probeMode: "live_openai_chatgpt", runProbe: runChatGptProbe });
  if (!e) throw new Error("fixture: engine not built");
  return e;
}

async function main(): Promise<void> {
  /* ═══════ 1. routing and profiles ═══════ */
  console.log("\n[1] Routing and provider profiles");
  const sonar = (async () => { throw new Error("no Sonar here"); }) as unknown as WorkerDeps["runProbe"];
  const eng = engine();
  check("the worker's provider value is the adapter's", CHATGPT_PROTOCOL_PROVIDER === CHATGPT_PROVIDER);
  const off = probeRunnerForProtocol({ runProbe: sonar }, { provider: CHATGPT_PROVIDER, modelConfig: { model: MODEL, setting_version: VERSION } });
  check("switch off (no engine): refused as not enabled", !off.ok && off.detail === "PROVIDER_ADAPTER_NOT_ENABLED");
  for (const [label, mc] of [
    ["no setting version", { model: MODEL }],
    ["another setting version", { model: MODEL, setting_version: VERSION.replace("-v4:", "-v3:") }],
    ["another model", { model: "gpt-6-luna-2026-05-18", setting_version: VERSION }],
  ] as const) {
    const r = probeRunnerForProtocol({ runProbe: sonar, chatgpt: eng }, { provider: CHATGPT_PROVIDER, modelConfig: mc });
    check(`engine on, ${label}: refused as not approved`, !r.ok && r.detail === "PROVIDER_MODEL_NOT_APPROVED");
  }
  const on = probeRunnerForProtocol({ runProbe: sonar, chatgpt: eng }, { provider: CHATGPT_PROVIDER, modelConfig: { model: MODEL, setting_version: VERSION } });
  check("engine on, the approved setting: the ChatGPT runner", on.ok && on.engine === "chatgpt" && on.runProbe === eng.runProbe);
  const sonarRoute = probeRunnerForProtocol({ runProbe: sonar, chatgpt: eng }, { provider: "perplexity_sonar", modelConfig: { model: "sonar" } });
  check("a Sonar protocol still routes to Sonar with the engine on", sonarRoute.ok && sonarRoute.engine === "perplexity" && sonarRoute.runProbe === sonar);

  const pp = perplexityProfile(sonar, { probeMode: "live_perplexity" }, OPTS);
  check("Perplexity profile: exactly the values used before (timeout, reservation, platform, probe mode, readers)",
    pp.callTimeoutMs === OPTS.providerTimeoutMs && pp.reservedCostUsd === OPTS.perplexityReservedCostUsd &&
    pp.platform === "perplexity" && pp.probeMode === "live_perplexity" && pp.answerFromBody === answerFromRawResponseBody &&
    JSON.stringify(pp.costFromBody(sonarBody())) === JSON.stringify({ actualCostUsd: 0.006, costBasis: "measured" }) &&
    pp.costFromBody(chatgptBody()) === null);
  check("providerProfileFor returns null for a ChatGPT route without an engine",
    providerProfileFor({ runProbe: sonar, engine: "chatgpt" }, { probeMode: "simulated" }, OPTS) === null);
  const cp = chatGptProfile(eng);
  check("ChatGPT profile: its own timeout, the setting's worst case reserved, platform chatgpt, its probe mode",
    cp.callTimeoutMs === 290000 && cp.reservedCostUsd === worstCaseRunUsd(MODEL, 8000) && cp.reservedCostUsd === 0.54 &&
    cp.platform === "chatgpt" && cp.probeMode === "live_openai_chatgpt");
  const usage = chatGptUsageFromBody(JSON.parse(chatgptBody()));
  const est = estimateChatGptCostUsd(MODEL, usage);
  check("ChatGPT cost: estimated from the body's usage at the flex rate (upper bound)",
    est.basis === "estimated_from_usage" && JSON.stringify(estimatedChatGptCost(MODEL, chatgptBody())) === JSON.stringify({ actualCostUsd: est.usd, costBasis: "estimated" }));
  check("ChatGPT cost: none when the body is missing, not JSON or reports no usage",
    estimatedChatGptCost(MODEL, null) === null && estimatedChatGptCost(MODEL, "{") === null &&
    estimatedChatGptCost(MODEL, JSON.stringify({ object: "response" })) === null);
  check("ChatGPT answer reader: a completed flex answer from the pinned model",
    chatGptAnswerFromBody(SETTING, chatgptBody())?.startsWith("Vendor A fits") === true);
  check("ChatGPT answer reader refuses another tier, another model, no tier, an unfinished body and an error",
    chatGptAnswerFromBody(SETTING, chatgptBody({ service_tier: "default" })) === null &&
    chatGptAnswerFromBody(SETTING, chatgptBody({ model: "gpt-6-luna-2026-05-18" })) === null &&
    chatGptAnswerFromBody(SETTING, chatgptBody({ service_tier: undefined })) === null &&
    chatGptAnswerFromBody(SETTING, chatgptBody({ status: "incomplete" })) === null &&
    chatGptAnswerFromBody(SETTING, chatgptBody({ error: { message: "x" } })) === null);
  check("the Perplexity answer reader still refuses a ChatGPT body", answerFromRawResponseBody(chatgptBody()) === null);
  const flexBody = JSON.stringify({ error: { message: "Resource unavailable, please try again later.", type: "invalid_request_error" } });
  const flexFail = new PerplexityProbeFailure("x", { reason: "http_error", httpStatus: 429, errorBody: flexBody, errorBodySha256: sha256Hex(flexBody),
    latencyMs: 1, providerRequestId: null, rawProbeRequestSha256: "a", fullRequestBody: "{}", fullRequestBodySha256: "b" });
  const rateBody = JSON.stringify({ error: { message: "Rate limit reached for requests", type: "requests" } });
  const rateFail = new PerplexityProbeFailure("x", { reason: "http_error", httpStatus: 429, errorBody: rateBody, errorBodySha256: sha256Hex(rateBody),
    latencyMs: 1, providerRequestId: null, rawProbeRequestSha256: "a", fullRequestBody: "{}", fullRequestBodySha256: "b" });
  check("a flex capacity refusal is labelled flex_capacity_unavailable; an ordinary 429 keeps http_error",
    cp.failureLabel(flexFail) === FLEX_CAPACITY_UNAVAILABLE && cp.failureLabel(rateFail) === "http_error" && pp.failureLabel(flexFail) === "http_error");
  check("the benchmark's flex rule is the lib one", isFlexResourceUnavailable(429, flexBody) && !isFlexResourceUnavailable(429, rateBody));

  /* ═══════ 2. configuration ═══════ */
  console.log("\n[2] Configuration: the switch and its bounds");
  const REF = "abcdefghijklmnopqrst";
  const liveEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    WORKER_EXECUTION_MODE: "live", NODE_ENV: "production", ZYPACT_MOCK_MODE: "off", WORKER_ID: "worker-fixture-1",
    NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, WORKER_EXPECTED_SUPABASE_PROJECT_REF: REF, WORKER_LIVE_CONFIRM: `LIVE:${REF}`,
    LLM_PROVIDER: "openai", OPENAI_MODEL: "gpt-4o-mini-2024-07-18", WORKER_EXIT_AFTER_CLAIMED_JOB: "true",
    WORKER_PROVIDER_TIMEOUT_MS: "45000", WORKER_MAX_RUNTIME_SECONDS: "900", WORKER_GRACE_MS: "10000",
    SUPABASE_SERVICE_ROLE_KEY: "SENTINEL-1", PERPLEXITY_API_KEY: "SENTINEL-2", OPENAI_API_KEY: "SENTINEL-3",
    ...over,
  });
  const ON = { WORKER_CHATGPT_ENABLED: "true", OPENAI_PROBE_API_KEY: "SENTINEL-4", WORKER_CHATGPT_TIMEOUT_MS: "290000",
    WORKER_LEASE_SECONDS: "330", WORKER_READY_STALE_MS: "240000", WORKER_MAX_RUNTIME_SECONDS: "2400" };
  const refusal = (env: Record<string, string | undefined>, ready = true): WorkerConfigError | null => {
    try { resolveExecutionPlan(env, { chatgptSchemaReady: ready }); return null; } catch (e) { if (e instanceof WorkerConfigError) return e; throw e; }
  };
  const cfgOf = (env: Record<string, string | undefined>, ready = true) => {
    const p = resolveExecutionPlan(env, { chatgptSchemaReady: ready });
    if (p.mode !== "live") throw new Error("not live");
    return p.config;
  };
  const baseCfg = cfgOf(liveEnv(), false);
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
    const c = cfgOf(liveEnv({ WORKER_CHATGPT_ENABLED: v }), false);
    check(`WORKER_CHATGPT_ENABLED=${JSON.stringify(v)} is off`, c.chatgpt.enabled === false);
  }
  check("off: every other field equals the configuration without the switch",
    JSON.stringify({ ...cfgOf(liveEnv({ WORKER_CHATGPT_ENABLED: "false" }), false), chatgpt: null }) === JSON.stringify({ ...baseCfg, chatgpt: null }) &&
    baseCfg.claimBudgetMs === claimBudgetMs(45000, 10000));
  check("off: no ChatGPT variable is read (an absent key and timeout are fine)",
    cfgOf(liveEnv({ WORKER_CHATGPT_TIMEOUT_MS: "nonsense" }), false).chatgpt.enabled === false);
  check("the schema is not ready yet (phase B)", CHATGPT_WORKER_SCHEMA_READY === false);
  const notReady = refusal(liveEnv(ON), false);
  check("on before phase B: refused, naming the switch", !!notReady && notReady.variables.includes("WORKER_CHATGPT_ENABLED"));
  const good = cfgOf(liveEnv(ON));
  check("on, with the recommended bounds: enabled with its own timeout",
    good.chatgpt.enabled === true && good.chatgpt.callTimeoutMs === 290000);
  check("on: the claim budget covers the ChatGPT leg plus the analysis leg plus grace",
    good.claimBudgetMs === claimBudgetWithChatGptMs(45000, 290000, 10000) && good.claimBudgetMs === 345000);
  check("on: the Perplexity timeout is unchanged", good.providerTimeoutMs === 45000);
  for (const [label, over, variable] of [
    ["no measurement key", { OPENAI_PROBE_API_KEY: undefined }, "OPENAI_PROBE_API_KEY"],
    ["no ChatGPT timeout", { WORKER_CHATGPT_TIMEOUT_MS: undefined }, "WORKER_CHATGPT_TIMEOUT_MS"],
    ["a ChatGPT timeout that is not an integer", { WORKER_CHATGPT_TIMEOUT_MS: "290s" }, "WORKER_CHATGPT_TIMEOUT_MS"],
    ["timeout + grace beyond today's 60 s lease", { WORKER_LEASE_SECONDS: undefined }, "WORKER_CHATGPT_TIMEOUT_MS"],
    ["readiness inside the heartbeat interval", { WORKER_READY_STALE_MS: "60000" }, "WORKER_READY_STALE_MS"],
    ["a runtime that cannot hold one ChatGPT claim", { WORKER_MAX_RUNTIME_SECONDS: "300" }, "WORKER_CHATGPT_TIMEOUT_MS"],
  ] as const) {
    const e = refusal(liveEnv({ ...ON, ...over }));
    check(`on, ${label}: refused, naming ${variable}`, !!e && e.variables.includes(variable), e ? e.variables.join(",") : "accepted");
  }
  check("no refusal message carries a value", [refusal(liveEnv({ ...ON, OPENAI_PROBE_API_KEY: undefined }))].every((e) => !!e && !e.message.includes("SENTINEL")));

  /* ═══════ 3. through the worker ═══════ */
  console.log("\n[3] Through the worker, with the in-memory ledger");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;
  const APPROVER = "11111111-1111-4111-8111-111111111111";
  async function seed(domain: string, provider: string, modelConfig: Record<string, unknown>, opts: { spendCapUsd?: number; runs?: number } = {}) {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: project.id, versionNumber: 1, promptText: QUESTION,
      promptHash: sha256Hex(QUESTION), intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: project.id, approvedBy: APPROVER });
    const protocol = await db.createProtocol({
      projectId: project.id, buyerQuestionVersionId: version.id, provider, surface: "answer", modelConfig,
      plannedBaselineRuns: opts.runs ?? 1, plannedRetestRuns: 0, paraphrasePlan: [{ text: QUESTION, hash: sha256Hex(QUESTION) }],
      unitOfAnalysis: "run", primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 3, spendCapUsd: opts.spendCapUsd ?? 4,
      timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id, protocolId: protocol.id };
  }
  type Spy = { marks: Array<Record<string, any>>; receipts: Array<Record<string, any>>; admissions: Array<Record<string, any>>;
    starts: Array<Record<string, any>>; aborts: Array<Record<string, any>> };
  function spying(base: DbAdapter, hooks: { onMark?: (input: Record<string, any>) => void } = {}): { db: DbAdapter; spy: Spy } {
    const spy: Spy = { marks: [], receipts: [], admissions: [], starts: [], aborts: [] };
    return {
      spy,
      db: {
        ...base,
        markExternalCallSentForJob: async (input) => {
          hooks.onMark?.(input as unknown as Record<string, any>);
          spy.marks.push(input as unknown as Record<string, any>);
          return base.markExternalCallSentForJob(input);
        },
        recordProviderCallReceiptForJob: async (input) => {
          spy.receipts.push(input as unknown as Record<string, any>);
          return base.recordProviderCallReceiptForJob(input);
        },
        admitAndReserveAttemptForJob: async (input) => {
          spy.admissions.push(input as unknown as Record<string, any>);
          return base.admitAndReserveAttemptForJob(input);
        },
        createProbeRunAndStartAttemptForJob: async (input) => {
          spy.starts.push(input as unknown as Record<string, any>);
          return base.createProbeRunAndStartAttemptForJob(input);
        },
        abortAttemptAndFailJobForJob: async (input) => {
          spy.aborts.push(input as unknown as Record<string, any>);
          return base.abortAttemptAndFailJobForJob(input);
        },
      },
    };
  }
  async function drive(deps: WorkerDeps, opts: WorkerOptions = OPTS, max = 6): Promise<IterationResult[]> {
    const out: IterationResult[] = [];
    for (let i = 0; i < max; i += 1) {
      const r = await runOneIteration(deps, opts, new WorkerHealth(deps.now));
      out.push(r);
      if (r.outcome === "no_job") break;
    }
    return out;
  }
  const MC = { model: MODEL, setting_version: VERSION };
  const baseDeps = (over: Partial<WorkerDeps>): WorkerDeps => ({
    db, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
    realFetch: fixtureFetch(500, "{}", []), runProbe: sonar, ...over,
  });

  {
    const { projectId, protocolId } = await seed("chatgpt-off.test", CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    const r = await runOneIteration(baseDeps({ realFetch: fixtureFetch(200, chatgptBody(), wire) }), OPTS, new WorkerHealth(() => Date.now()));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("switch off: an openai_chatgpt job is refused as not enabled", r.outcome === "failed" && r.detail === "PROVIDER_ADAPTER_NOT_ENABLED", `${r.outcome}:${r.detail}`);
    check("switch off: before admission — no attempt, nothing reserved, nothing sent", attempts.length === 0 && wire.length === 0);
  }
  {
    const { projectId, protocolId } = await seed("chatgpt-on.test", CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    const { db: spyDb, spy } = spying(db);
    const results = await drive(baseDeps({ db: spyDb, chatgpt: engine(), realFetch: fixtureFetch(200, chatgptBody(), wire) }));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("switch on: the job completes", results.some((r) => r.outcome === "completed"), results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("exactly one request, to the Responses endpoint", wire.length === 1 && wire[0].url === OPENAI_RESPONSES_ENDPOINT);
    const providerMark = spy.marks.find((m) => m.callKind === "perplexity");
    const sent = String(wire[0]?.init.body ?? "");
    check("the bytes sent are the bytes marked, with their hash", !!providerMark && providerMark.requestBody === sent &&
      providerMark.requestBodySha256 === sha256Hex(sent));
    const body = JSON.parse(sent || "{}");
    check("the request is the approved setting: pinned model, cap 8000, low effort, flex last",
      body.model === MODEL && body.max_output_tokens === 8000 && body.reasoning?.effort === "low" &&
      body.service_tier === "flex" && Object.keys(body).pop() === "service_tier");
    check("the authorization header never reaches the ledger", !JSON.stringify(spy.marks).includes("SENTINEL"));
    check("admission reserved the setting's worst case for the ChatGPT leg", spy.admissions[0]?.perplexityReservedCostUsd === 0.54 &&
      spy.admissions[0]?.analysisReservedCostUsd === OPTS.analysisReservedCostUsd);
    check("the attempt is recorded as platform chatgpt under its own probe mode",
      spy.starts[0]?.platform === "chatgpt" && spy.starts[0]?.probeMode === "live_openai_chatgpt");
    const rec = spy.receipts[0] ?? {};
    check("the receipt keeps the exact body and its hash", rec.outcome === "success" && rec.rawResponseBody === chatgptBody() &&
      rec.rawResponseSha256 === sha256Hex(chatgptBody()));
    check("with its cost, estimated from usage", rec.costBasis === "estimated" && rec.actualCostUsd === est.usd, `${rec.actualCostUsd}/${rec.costBasis}`);
    check("one completed attempt", attempts.filter((a) => a.status === "completed").length === 1, attempts.map((a) => a.status).join(","));
  }
  {
    // A crash after the provider receipt and before the analysis leg: the
    // next claim replays the stored ChatGPT answer and never sends again.
    const { projectId, protocolId } = await seed("chatgpt-replay.test", CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    let crashed = false;
    const { db: crashDb } = spying(db, { onMark: (m) => { if (m.callKind === "analysis" && !crashed) { crashed = true; throw new Error("simulated crash"); } } });
    const SHORT: WorkerOptions = { ...OPTS, leaseSeconds: 0.4 };
    const deps = baseDeps({ db: crashDb, chatgpt: engine(), realFetch: fixtureFetch(200, chatgptBody(), wire) });
    let threw = false;
    try { await runOneIteration(deps, SHORT, new WorkerHealth(deps.now)); } catch { threw = true; }
    await new Promise((res) => setTimeout(res, 500));
    const results = await drive(deps, SHORT);
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("the crash happened after the ChatGPT receipt", threw && crashed);
    check("the next claim completes the job from the stored answer", results.some((r) => r.outcome === "completed"),
      results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("and the ChatGPT request was sent exactly once", wire.length === 1, String(wire.length));
    check("one attempt, completed", attempts.length === 1 && attempts[0].status === "completed", attempts.map((a) => a.status).join(","));
  }
  {
    const flex429 = JSON.stringify({ error: { message: "Resource Unavailable", type: "server_error", code: null } });
    const { projectId, protocolId } = await seed("chatgpt-flex429.test", CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    const { db: spyDb, spy } = spying(db);
    const results = await drive(baseDeps({ db: spyDb, chatgpt: engine(), realFetch: fixtureFetch(429, flex429, wire) }));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("flex 429: exactly one fetch, nothing resent", wire.length === 1, String(wire.length));
    check("flex 429: the attempt fails with the flex label", results.some((r) => r.outcome === "failed" && (r.detail ?? "").startsWith(`${FLEX_CAPACITY_UNAVAILABLE}:`)),
      results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("flex 429: a provider_error receipt keeps the refusal body, with no cost (counted at the reservation)",
      spy.receipts.length === 1 && spy.receipts[0].outcome === "provider_error" && spy.receipts[0].rawResponseBody === flex429 &&
      spy.receipts[0].actualCostUsd === undefined && spy.receipts[0].costBasis === undefined);
    check("flex 429: the job closes as provider_error, which the founder's Retry (D-052) accepts",
      spy.aborts.length === 1 && spy.aborts[0].failureReason === "provider_error" && String(spy.aborts[0].terminationReason).startsWith(FLEX_CAPACITY_UNAVAILABLE));
    check("flex 429: the attempt is failed, never completed", attempts.length === 1 && attempts[0].status === "failed");
  }
  {
    const { projectId, protocolId } = await seed("chatgpt-timeout.test", CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    const { db: spyDb, spy } = spying(db);
    const hang: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => {
      wire.push({ url: String(url), init: init ?? {} });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    const t0 = Date.now();
    const results = await drive(baseDeps({ db: spyDb, chatgpt: engine({ callTimeoutMs: 50 }), realFetch: hang }));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("timeout: the ChatGPT leg uses the engine's deadline, not the 45 s provider timeout", Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
    check("timeout: one request, then needs review", wire.length === 1 && results.some((r) => r.outcome === "needs_review_perplexity_unknown"),
      results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("timeout: the receipt says the outcome is unknown, with no body and no cost",
      spy.receipts[0]?.outcome === "provider_outcome_unknown" && spy.receipts[0]?.rawResponseBody === null && spy.receipts[0]?.actualCostUsd === undefined);
    check("timeout: nothing completed", attempts.every((a) => a.status !== "completed"));
  }
  for (const [label, over, cause] of [
    ["another tier", { service_tier: "default" }, "standard"],
    ["no tier", { service_tier: undefined }, "standard"],
    ["another model", { model: "gpt-6-luna-2026-05-18" }, "flex"],
  ] as const) {
    const bodyOther = chatgptBody(over);
    const { projectId, protocolId } = await seed(`chatgpt-${label.replace(/ /g, "-")}.test`, CHATGPT_PROVIDER, MC);
    const wire: Wire[] = [];
    const { db: spyDb, spy } = spying(db);
    const results = await drive(baseDeps({ db: spyDb, chatgpt: engine(), realFetch: fixtureFetch(200, bodyOther, wire) }));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    const expected = estimateChatGptCostUsd(MODEL, chatGptUsageFromBody(JSON.parse(bodyOther)));
    check(`${label}: one call, a provider error, no completed attempt`, wire.length === 1 && spy.receipts[0]?.outcome === "provider_error" &&
      attempts.every((a) => a.status !== "completed") && !results.some((r) => r.outcome === "completed"));
    check(`${label}: the whole body is kept, with its estimated cost (${cause} rate)`,
      spy.receipts[0]?.rawResponseBody === bodyOther && spy.receipts[0]?.costBasis === "estimated" &&
      expected.basis === "estimated_from_usage" && spy.receipts[0]?.actualCostUsd === expected.usd,
      `${spy.receipts[0]?.actualCostUsd}/${spy.receipts[0]?.costBasis}`);
  }
  {
    // The Perplexity path with the engine on: unchanged.
    const { projectId, protocolId } = await seed("sonar-with-engine.test", "perplexity_sonar", { model: "sonar" }, { spendCapUsd: 1 });
    const wire: Wire[] = [];
    const { db: spyDb, spy } = spying(db);
    const results = await drive(baseDeps({ db: spyDb, chatgpt: engine(), runProbe: runPerplexityProbe, realFetch: fixtureFetch(200, sonarBody(), wire) }));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("Perplexity with the engine on: the job completes through Sonar", results.some((r) => r.outcome === "completed") &&
      wire.length === 1 && /perplexity\.ai/.test(wire[0].url), results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("Perplexity: the reservation is the configured one", spy.admissions[0]?.perplexityReservedCostUsd === OPTS.perplexityReservedCostUsd);
    check("Perplexity: platform perplexity under the injected probe mode", spy.starts[0]?.platform === "perplexity" && spy.starts[0]?.probeMode === "live_perplexity");
    check("Perplexity: the measured cost, as before", spy.receipts[0]?.costBasis === "measured" && spy.receipts[0]?.actualCostUsd === 0.006);
    check("Perplexity: one completed attempt", attempts.filter((a) => a.status === "completed").length === 1);
  }

  /* ═══════ 4. sources ═══════ */
  console.log("\n[4] Sources: rule openai-responses-sources/1, chosen by provider");
  const raw = chatgptBody();
  const s = extractProviderSources(raw, sha256Hex(raw), CHATGPT_PROVIDER);
  check("read under the OpenAI rule", s.status === "ok" && s.responseFormat === "openai_responses");
  check("cited in order, utm_source=openai removed, other parameters kept",
    JSON.stringify(s.cited.map((c) => c.url)) === JSON.stringify(["https://vendor-a.example/pricing", "https://reviews.example/compare?ref=x"]));
  check("repeated citations of one URL merge their numbers", JSON.stringify(s.cited[0]?.markers) === "[1,4]" && s.cited[0]?.title === "Vendor A pricing");
  check("an unusable citation is an unmatched marker, never a source", JSON.stringify(s.unmatchedMarkers) === "[3]");
  check("retrieved only: search sources the answer does not cite (a cited URL is never listed twice)",
    JSON.stringify(s.retrievedOnly.map((c) => c.url)) === JSON.stringify(["https://reviews.example/compare", "https://forum.example/thread?id=7"]));
  check("markers found", s.markersFound === true);
  check("an unfinished body is not read", extractProviderSources(chatgptBody({ status: "incomplete" }), sha256Hex(chatgptBody({ status: "incomplete" })), CHATGPT_PROVIDER).status === "unrecognised_shape");
  check("the hash is still checked first", extractProviderSources(raw, "0".repeat(64), CHATGPT_PROVIDER).status === "hash_mismatch");
  check("without the provider the same body is read as before (Agent shape) — why the provider must decide",
    extractProviderSources(raw, sha256Hex(raw)).responseFormat === "agent_response");
  const sb = sonarBody();
  check("a Sonar body reads identically with or without its provider",
    JSON.stringify(extractProviderSources(sb, sha256Hex(sb), "perplexity_sonar")) === JSON.stringify(extractProviderSources(sb, sha256Hex(sb))));
  check("rule versions by provider", sourcesRuleVersionForProvider(CHATGPT_PROVIDER) === OPENAI_RESPONSES_SOURCES_RULE_VERSION &&
    sourcesRuleVersionForProvider("perplexity_sonar") === PROVIDER_SOURCES_RULE_VERSION && sourcesRuleVersionForProvider(null) === PROVIDER_SOURCES_RULE_VERSION);
  // Parity: the report's readers read exactly the items the adapter reads.
  const out = JSON.parse(raw).output;
  const seen = new Set<string>();
  const citedParity: Array<{ url: string; title?: string }> = [];
  for (const c of openAiBodyCitations(out)) {
    if (typeof c.url !== "string") continue;
    const u = normalizeUrl(c.url);
    if (!u || seen.has(u.toLowerCase())) continue;
    seen.add(u.toLowerCase());
    citedParity.push({ url: u, title: typeof c.title === "string" ? c.title : undefined });
  }
  check("parity: the cited items equal chatGptCitedUrls", JSON.stringify(citedParity) === JSON.stringify(chatGptCitedUrls(out)));
  const searchParity = [...new Set(openAiBodySearchSourceUrls(out).filter((u): u is string => typeof u === "string").map(normalizeUrl))];
  check("parity: the retrieved items equal chatGptSearchSources", JSON.stringify(searchParity) === JSON.stringify(chatGptSearchSources(out)));
  const insights = buildSourceInsights([{ ordinal: 1, ...s }], "client.example", sourcesRuleVersionForProvider(CHATGPT_PROVIDER));
  check("source insights name the rule they were read under", insights.extractionVersion === OPENAI_RESPONSES_SOURCES_RULE_VERSION &&
    insights.notes.some((n) => n.includes(OPENAI_RESPONSES_SOURCES_RULE_VERSION)) && insights.notes.some((n) => n.includes("linked citation")));
  check("Perplexity insights are unchanged by default", buildSourceInsights([], "client.example").extractionVersion === PROVIDER_SOURCES_RULE_VERSION);

  /* ═══════ 5. labels ═══════ */
  console.log("\n[5] Report labels");
  check("the ChatGPT limitation is the validity note's, verbatim",
    surfaceLimitation(CHATGPT_PROVIDER) === CHATGPT_SURFACE_LIMITATION &&
    fs.readFileSync("docs/ADAPTER_VALIDITY_CHATGPT.md", "utf8").includes(CHATGPT_SURFACE_LIMITATION));
  check("Perplexity keeps its own", surfaceLimitation("perplexity_sonar") === PERPLEXITY_SURFACE_LIMITATION);
  const fp = fs.readFileSync("lib/reports/measurement-fingerprint.ts", "utf8");
  check("the fingerprint knows the ChatGPT endpoint", /openai_chatgpt: OPENAI_RESPONSES_ENDPOINT/.test(fp));

  /* ═══════ 6. static boundaries ═══════ */
  console.log("\n[6] Boundaries");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  for (const f of ["lib/protocol-worker/worker.ts", "lib/protocol-worker/execute-job.ts", "lib/protocol-worker/provider-profile.ts"]) {
    check(`${f} imports neither the adapter nor the engine`,
      !/(?:from\s*|import\(\s*)"@\/lib\/(?:probes\/chatgpt|protocol-worker\/chatgpt-engine)"/.test(read(f)));
  }
  const entry = read("scripts/run-protocol-worker.ts");
  check("the entry point builds the engine only with the switch on, under the ChatGPT probe mode",
    /if \(cfg\.chatgpt\.enabled\) \{/.test(entry) && /probeMode: "live_openai_chatgpt"/.test(entry) &&
    /\.\.\.\(chatgpt \? \{ chatgpt \} : \{\}\)/.test(entry));
  for (const f of ["fly.worker.toml.template", "fly.worker.staging.toml", "fly.worker.production.toml"]) {
    check(`${f} states the switch off`, read(f).includes('WORKER_CHATGPT_ENABLED = "false"'));
  }
  check("the benchmark imports the flex rule from lib", /from "@\/lib\/probes\/openai-flex"/.test(read("scripts/lib/chatgpt-benchmark.ts")) &&
    !/export function isFlexResourceUnavailable/.test(read("scripts/lib/chatgpt-benchmark.ts")));

  finished = true;
  clearInterval(keepAlive);
  console.log(`\n${passed}/${passed + failures.length} checks passed.`);
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length}`);
    process.exit(1);
  }
  console.log("ChatGPT worker (D-056 phase A) PASSED.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
