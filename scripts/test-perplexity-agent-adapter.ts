/**
 * PR #4 — the Perplexity Agent API adapter, offline.
 *
 * What it pins:
 *   - the request is POST /v1/agent with model perplexity/sonar, the
 *     web_search tool and the buyer question exactly as approved — no brand,
 *     no preset, no fallback list, no instructions — and the bytes hashed
 *     are the bytes sent;
 *   - a completed response yields the answer, sources, served model, the
 *     exact raw body and its hash, status, latency and request id;
 *   - missing search results are an observation, not a failure;
 *   - empty output, incomplete/failed/queued status, malformed or non-Agent
 *     bodies, missing id or served model, HTTP errors and timeouts all fail
 *     with the full request/response evidence — never a partial success;
 *   - measured cost is usage.cost.total_cost in USD, and absent, malformed or
 *     non-USD cost is unknown (null), never zero;
 *   - the worker parses stored Agent bodies, routes each protocol to its
 *     adapter before anything is reserved, refuses an Agent protocol unless
 *     the adapter is wired in, and the production entry point does not wire
 *     it in;
 *   - an Agent protocol run end to end through the worker records the exact
 *     evidence and the measured cost.
 *
 * No test contacts a provider: global fetch throws if called, and every
 * request goes through an injected fixture.
 */

import fs from "node:fs";
import { sha256Hex } from "@/lib/evidence/hash";
import { PERPLEXITY_AGENT_ENDPOINT, PERPLEXITY_SONAR_ENDPOINT } from "@/lib/probes/endpoints";
import {
  PERPLEXITY_AGENT_MODEL,
  agentCitationMarkers,
  agentOutputText,
  agentSearchResults,
  runPerplexityAgentProbe,
} from "@/lib/probes/perplexity-agent";
import { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import {
  answerFromRawResponseBody,
  measuredCostUsdFromRawResponseBody,
  probeRunnerForProtocol,
  runOneIteration,
} from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { DbAdapter } from "@/lib/db/types";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Nothing may reach a real provider.
let globalFetchCalls = 0;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must never be called by this test");
}) as typeof fetch;
process.env.PERPLEXITY_API_KEY = "test-only-not-a-key";

const QUESTION = "Which SOC 2 compliance tools suit a 50-person SaaS company?";

function agentBody(over: Record<string, unknown> = {}, outputOver?: unknown[]): string {
  return JSON.stringify({
    id: "resp_abc123",
    object: "response",
    status: "completed",
    model: "perplexity/sonar",
    output: outputOver ?? [
      { type: "search_results", queries: ["soc 2 tools"], results: [
        { id: 1, url: "https://vanta.example/soc2", title: "Vanta", snippet: "s", date: "2026-09-01" },
        { id: 2, url: "https://drata.example/", title: "Drata" },
      ] },
      { type: "message", id: "msg_1", content: [{ type: "output_text", text: "Vanta [1] and Drata [2] are common choices.", annotations: [] }] },
    ],
    usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020,
      cost: { input_cost: 0.0002, output_cost: 0.0003, tool_calls_cost: 0.0025, total_cost: 0.003, currency: "USD" } },
    ...over,
  });
}

interface Wire { url: string; body: string; method: string }
function fixtureFetch(status: number, body: string, wire: Wire[], headers: Record<string, string> = { "x-request-id": "req-1" }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    wire.push({ url: String(url), body: String(init?.body ?? ""), method: init?.method ?? "GET" });
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

async function expectFailure(label: string, run: () => Promise<unknown>, reason: string, cause?: RegExp) {
  try {
    await run();
    check(`${label} → failure`, false, "resolved");
  } catch (e) {
    const ok = e instanceof PerplexityProbeFailure && e.reason === reason && (!cause || cause.test(e.message));
    check(`${label} → ${reason}${cause ? ` (${cause.source})` : ""}`, ok, e instanceof Error ? e.message : String(e));
    if (e instanceof PerplexityProbeFailure) {
      check(`${label}: the exact request and its hash are kept`,
        e.fullRequestBody.length > 0 && e.fullRequestBodySha256 === sha256Hex(e.fullRequestBody));
      if (e.errorBody !== null) {
        check(`${label}: the whole response body is kept, with a hash that verifies`,
          e.errorBodySha256 === sha256Hex(e.errorBody));
      }
    }
  }
}

async function main(): Promise<void> {
  console.log("\nPerplexity Agent API adapter (PR #4)\n");

  /* ═══════ 1. the request ═══════ */
  console.log("[1] The request: fixed configuration, the question exactly as approved");
  {
    const wire: Wire[] = [];
    const r = await runPerplexityAgentProbe({ prompt: `  ${QUESTION}  `, brandName: "Acme Compliance", domain: "acme.example",
      fetchImpl: fixtureFetch(200, agentBody(), wire) });
    const sent = JSON.parse(wire[0].body);
    check("POST to the Agent endpoint", wire.length === 1 && wire[0].method === "POST" && wire[0].url === PERPLEXITY_AGENT_ENDPOINT);
    check("the endpoint is /v1/agent, not Sonar's", PERPLEXITY_AGENT_ENDPOINT === "https://api.perplexity.ai/v1/agent" &&
      (PERPLEXITY_AGENT_ENDPOINT as string) !== PERPLEXITY_SONAR_ENDPOINT);
    check("model perplexity/sonar with the web_search tool",
      sent.model === PERPLEXITY_AGENT_MODEL && sent.model === "perplexity/sonar" &&
      JSON.stringify(sent.tools) === JSON.stringify([{ type: "web_search" }]));
    check("the input is the buyer question exactly (trimmed), nothing else", sent.input === QUESTION);
    check("no brand, domain or project context is injected",
      !wire[0].body.includes("Acme") && !wire[0].body.includes("acme.example"));
    check("no preset, fallback list, instructions or background mode",
      !("effort" in sent) && !("models" in sent) && !("instructions" in sent) && !("background" in sent) && !("preset" in sent));
    check("output limit and sampling are explicit", sent.max_output_tokens === 1200 && sent.temperature === 0.2);
    check("the stored request is byte-identical to the bytes sent", r.fullRequestBody === wire[0].body);
    check("and its SHA-256 covers those exact bytes", r.fullRequestBodySha256 === sha256Hex(wire[0].body));
    check("the question's own hash is kept separately", r.rawProbeRequestSha256 === sha256Hex(QUESTION));
  }

  /* ═══════ 2. a completed response ═══════ */
  console.log("\n[2] A completed response");
  {
    const wire: Wire[] = [];
    const raw = agentBody();
    const r = await runPerplexityAgentProbe({ prompt: QUESTION, brandName: "Acme", fetchImpl: fixtureFetch(200, raw, wire) });
    check("the answer is the message's output_text", r.answer === "Vanta [1] and Drata [2] are common choices.");
    check("sources come from search_results", JSON.stringify(r.citations) === JSON.stringify(["https://vanta.example/soc2", "https://drata.example/"]),
      JSON.stringify(r.citations));
    check("source records keep title and url", r.searchResults.length === 2 && r.searchResults[0].title === "Vanta");
    check("the served model is what the provider reported", r.model === "perplexity/sonar");
    check("the raw response is stored exactly as received", r.rawResponseBody === raw);
    check("with a SHA-256 that verifies", r.rawResponseBodySha256 === sha256Hex(raw));
    check("status, latency and request id are recorded",
      r.httpStatus === 200 && typeof r.latencyMs === "number" && r.providerRequestId === "req-1");
    check("not a mock", r.usedMock === false);
    check("citation markers map to search-result ids",
      JSON.stringify(agentCitationMarkers(r.answer, agentSearchResults(JSON.parse(raw).output))) === JSON.stringify({ mapped: [1, 2], unmapped: [] }));
    check("an unmapped marker is reported, never invented into a source",
      JSON.stringify(agentCitationMarkers("See [3] and [web:1].", [{ id: 1 }])) === JSON.stringify({ mapped: [1], unmapped: [3] }));
  }
  {
    const wire: Wire[] = [];
    const raw = agentBody({}, [{ type: "message", content: [{ type: "output_text", text: "No sources here." }] }]);
    const r = await runPerplexityAgentProbe({ prompt: QUESTION, brandName: "Acme", fetchImpl: fixtureFetch(200, raw, wire) });
    check("no search results → still a valid answer, with no sources (an observation)",
      r.answer === "No sources here." && r.citations.length === 0 && r.searchResults.length === 0);
  }

  /* ═══════ 3. failures keep their evidence ═══════ */
  console.log("\n[3] Unusable responses fail with full evidence");
  const run = (status: number, body: string) => () =>
    runPerplexityAgentProbe({ prompt: QUESTION, brandName: "Acme", fetchImpl: fixtureFetch(status, body, []) });
  await expectFailure("empty output text", run(200, agentBody({}, [{ type: "message", content: [{ type: "output_text", text: "   " }] }])), "empty_answer", /empty_output_text/);
  await expectFailure("no message item at all", run(200, agentBody({}, [{ type: "search_results", results: [] }])), "empty_answer", /empty_output_text/);
  for (const status of ["incomplete", "failed", "in_progress", "queued", "cancelled"]) {
    await expectFailure(`status ${status}`, run(200, agentBody({ status, error: status === "failed" ? { code: "x", message: "boom" } : undefined })),
      "empty_answer", new RegExp(`status:${status}`));
  }
  await expectFailure("a non-JSON 2xx body", run(200, "<html>oops</html>"), "empty_answer", /invalid_json/);
  await expectFailure("a JSON array", run(200, "[]"), "empty_answer", /not_an_object/);
  await expectFailure("a Sonar-shaped body on the Agent endpoint", run(200, JSON.stringify({ id: "x", object: "chat.completion", model: "sonar", choices: [{ message: { content: "a" } }] })),
    "empty_answer", /unexpected_object/);
  await expectFailure("a response with no id", run(200, agentBody({ id: "" })), "empty_answer", /missing_id/);
  await expectFailure("a response with no served model", run(200, agentBody({ model: undefined })), "empty_answer", /missing_served_model/);
  await expectFailure("an HTTP 429", run(429, "{\"error\":\"rate limited\"}"), "http_error");
  await expectFailure("an HTTP 500", run(500, "upstream"), "http_error");
  await expectFailure("a timeout (the worker's deadline aborts the request)", () =>
    runPerplexityAgentProbe({ prompt: QUESTION, brandName: "Acme",
      fetchImpl: (async () => { throw new DOMException("The operation was aborted.", "AbortError"); }) as typeof fetch }),
    "network_error", /aborted/);
  {
    delete process.env.PERPLEXITY_API_KEY;
    const wire: Wire[] = [];
    let threw = false;
    try { await runPerplexityAgentProbe({ prompt: QUESTION, brandName: "Acme", fetchImpl: fixtureFetch(200, agentBody(), wire) }); }
    catch { threw = true; }
    check("no API key → refused before any request", threw && wire.length === 0);
    process.env.PERPLEXITY_API_KEY = "test-only-not-a-key";
  }

  /* ═══════ 4. cost ═══════ */
  console.log("\n[4] Measured cost: usage.cost.total_cost in USD, or unknown");
  check("an Agent body's total_cost is measured", measuredCostUsdFromRawResponseBody(agentBody()) === 0.003);
  for (const [label, cost] of [
    ["no cost object", undefined],
    ["a string total", { total_cost: "0.003", currency: "USD" }],
    ["a negative total", { total_cost: -1, currency: "USD" }],
    ["a non-USD currency", { total_cost: 0.003, currency: "EUR" }],
    ["no total", { input_cost: 0.001, currency: "USD" }],
  ] as const) {
    const body = agentBody({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, ...(cost ? { cost } : {}) } });
    check(`${label} → unknown (null), never 0`, measuredCostUsdFromRawResponseBody(body) === null);
  }
  check("no usage at all → unknown", measuredCostUsdFromRawResponseBody(agentBody({ usage: undefined })) === null);
  check("a Sonar body with no currency is still measured as before",
    measuredCostUsdFromRawResponseBody(JSON.stringify({ choices: [], usage: { cost: { total_cost: 0.0035 } } })) === 0.0035);

  /* ═══════ 5. the worker's parser and dispatch ═══════ */
  console.log("\n[5] The worker reads stored Agent bodies and routes by provider");
  check("a stored completed Agent body yields its answer", answerFromRawResponseBody(agentBody()) === "Vanta [1] and Drata [2] are common choices.");
  for (const status of ["incomplete", "failed", "queued"]) {
    check(`a stored ${status} Agent body yields no answer`, answerFromRawResponseBody(agentBody({ status })) === null);
  }
  check("a stored Agent body with empty output yields no answer",
    answerFromRawResponseBody(agentBody({}, [{ type: "message", content: [{ type: "output_text", text: "" }] }])) === null);
  check("a stored Sonar body is read exactly as before",
    answerFromRawResponseBody(JSON.stringify({ choices: [{ message: { content: " hi " } }] })) === "hi");
  check("agentOutputText ignores non-message items", agentOutputText([{ type: "search_results", results: [] }]) === "");

  const sonarRunner = (async () => { throw new Error("sonar"); }) as unknown as WorkerDeps["runProbe"];
  const agentRunner = (async () => { throw new Error("agent"); }) as unknown as WorkerDeps["runProbe"];
  const route = (provider: string, model: unknown, withAgent: boolean) =>
    probeRunnerForProtocol({ runProbe: sonarRunner, runAgentProbe: withAgent ? agentRunner : undefined },
      { provider, modelConfig: { model } });
  const sonar = route("perplexity_sonar", "sonar", true);
  check("perplexity_sonar → the Sonar adapter", sonar.ok && sonar.runProbe === sonarRunner);
  const legacy = route("perplexity", "sonar", true);
  check("the legacy \"perplexity\" label → the Sonar adapter, as before PR #4", legacy.ok && legacy.runProbe === sonarRunner);
  const agentOff = route("perplexity_agent", "perplexity/sonar", false);
  check("perplexity_agent without the adapter wired in → refused", !agentOff.ok && agentOff.detail === "PROVIDER_ADAPTER_NOT_ENABLED");
  const agentOtherModel = route("perplexity_agent", "openai/gpt-5.6-sol", true);
  check("perplexity_agent with an unapproved model → refused", !agentOtherModel.ok && agentOtherModel.detail === "PROVIDER_MODEL_NOT_APPROVED");
  const agentOn = route("perplexity_agent", "perplexity/sonar", true);
  check("perplexity_agent with the adapter and the approved model → the Agent adapter", agentOn.ok && agentOn.runProbe === agentRunner);
  const unknown = route("someone_else", "x", true);
  check("an unknown provider → refused", !unknown.ok && unknown.detail === "UNKNOWN_PROVIDER");
  {
    const entry = fs.readFileSync("scripts/run-protocol-worker.ts", "utf8");
    check("the production worker entry point does not wire the Agent adapter in",
      !/runAgentProbe|perplexity-agent|runPerplexityAgentProbe/.test(entry));
    const worker = fs.readFileSync("lib/protocol-worker/worker.ts", "utf8");
    const slot = worker.slice(worker.indexOf("async function runOneSlot"));
    check("the provider is routed before admission and reservation",
      slot.indexOf("probeRunnerForProtocol(") > 0 && slot.indexOf("probeRunnerForProtocol(") < slot.indexOf("admitAndReserveAttemptForJob("));
    check("execute-job.ts is untouched by PR #4 (the worker passes the routed runner in)",
      fs.readFileSync("lib/protocol-worker/execute-job.ts", "utf8").includes("res = await deps.runProbe({"));
  }

  /* ═══════ 6. end to end through the worker ═══════ */
  console.log("\n[6] Through the worker, with the in-memory ledger");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;
  const APPROVER = "11111111-1111-4111-8111-111111111111";
  async function seed(domain: string, provider: string, model: string) {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: project.id, versionNumber: 1, promptText: QUESTION,
      promptHash: sha256Hex(QUESTION), intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: project.id, approvedBy: APPROVER });
    const protocol = await db.createProtocol({
      projectId: project.id, buyerQuestionVersionId: version.id, provider, surface: "answer", modelConfig: { model },
      plannedBaselineRuns: 1, plannedRetestRuns: 0, paraphrasePlan: [{ text: QUESTION, hash: sha256Hex(QUESTION) }],
      unitOfAnalysis: "run", primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 3, spendCapUsd: 1,
      timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 0,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id, protocolId: protocol.id };
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
    workerId: "pr4-test", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 4,
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
    exitAfterClaimedJob: false, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
  };
  {
    const { projectId, protocolId } = await seed("agent-off.test", "perplexity_agent", "perplexity/sonar");
    const wire: Wire[] = [];
    let sonarCalls = 0;
    const deps: WorkerDeps = {
      db, analysis, now: () => 1_700_000_000_000, sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: fixtureFetch(200, agentBody(), wire),
      runProbe: (async () => { sonarCalls += 1; throw new Error("must not run Sonar for an Agent protocol"); }) as unknown as WorkerDeps["runProbe"],
    };
    const r = await runOneIteration(deps, OPTS, new WorkerHealth(deps.now));
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("an Agent protocol with the adapter not wired in is refused", r.outcome === "failed" && r.detail === "PROVIDER_ADAPTER_NOT_ENABLED",
      `${r.outcome}:${r.detail}`);
    check("before admission: no attempt, so nothing reserved", attempts.length === 0, String(attempts.length));
    check("nothing was sent, and Sonar was not substituted", wire.length === 0 && sonarCalls === 0);
  }
  {
    const { projectId, protocolId } = await seed("agent-on.test", "perplexity_agent", "perplexity/sonar");
    const wire: Wire[] = [];
    const raw = agentBody();
    const receipts: Array<Record<string, unknown>> = [];
    const spyDb: DbAdapter = {
      ...db,
      recordProviderCallReceiptForJob: async (input) => {
        receipts.push(input as unknown as Record<string, unknown>);
        return db.recordProviderCallReceiptForJob(input);
      },
    };
    const deps: WorkerDeps = {
      db: spyDb, analysis, now: () => 1_700_000_000_000, sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: fixtureFetch(200, raw, wire),
      runProbe: (async () => { throw new Error("must not run Sonar"); }) as unknown as WorkerDeps["runProbe"],
      runAgentProbe: runPerplexityAgentProbe,
    };
    const results: IterationResult[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await runOneIteration(deps, OPTS, new WorkerHealth(deps.now));
      results.push(r);
      if (r.outcome === "no_job" || r.outcome === "completed") break;
    }
    const attempts = await db.getProtocolAttempts(protocolId, projectId);
    check("with the adapter wired in, the Agent protocol's job completes", results.some((r) => r.outcome === "completed"),
      results.map((r) => `${r.outcome}:${r.detail}`).join(" | "));
    check("exactly one request, to the Agent endpoint", wire.length === 1 && wire[0].url === PERPLEXITY_AGENT_ENDPOINT, JSON.stringify(wire.map((w) => w.url)));
    check("the counted attempt completed", attempts.filter((a) => a.status === "completed").length === 1, attempts.map((a) => a.status).join(","));
    const rec = receipts[0] ?? {};
    check("the receipt stores the exact raw Agent body", rec.rawResponseBody === raw);
    check("with its hash", rec.rawResponseSha256 === sha256Hex(raw));
    check("and the provider's own cost, measured", rec.actualCostUsd === 0.003 && rec.costBasis === "measured",
      `${rec.actualCostUsd}/${rec.costBasis}`);
  }
  check("global fetch was never called", globalFetchCalls === 0, String(globalFetchCalls));

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
