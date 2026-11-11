#!/usr/bin/env tsx
/**
 * X1 (D-050) — the ChatGPT (OpenAI Responses API) adapter, offline.
 *
 * What it pins:
 *   - the request is POST /v1/responses with the fixed setting, the web
 *     search tool, sources requested, store:false, and the buyer question
 *     exactly as approved (no brand, no domain, no instructions); the bytes
 *     hashed are the bytes sent; the key is OPENAI_PROBE_API_KEY only;
 *   - a completed response yields the answer, cited and retrieved sources
 *     kept apart, the served model, the exact raw body and its hash, status,
 *     latency and request id;
 *   - no search, or no citations, is an observation, not a failure;
 *   - every unusable 2xx, HTTP error and network error fails with the full
 *     request/response evidence — never a partial success;
 *   - the worker refuses an openai_chatgpt protocol before anything is
 *     reserved, and refuses to replay a stored ChatGPT body as an answer;
 *   - no web entry point and no workspace module imports the adapter;
 *   - the adapter-validity note covers every METHODOLOGY §4 heading.
 *
 * No test contacts a provider: global fetch throws if called.
 */
import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "@/lib/evidence/hash";
import { OPENAI_RESPONSES_ENDPOINT } from "@/lib/probes/endpoints";
import {
  CHATGPT_APPROVED_MODEL,
  CHATGPT_BENCHMARK_CANDIDATES,
  CHATGPT_PROVIDER,
  CHATGPT_SETTING_FAMILY,
  ChatGptProbeFailure,
  approvedChatGptSetting,
  buildChatGptRequestBody,
  chatGptCitedUrls,
  chatGptOutputText,
  chatGptSearchSources,
  chatGptSetting,
  isServedModelOf,
  runChatGptProbe,
} from "@/lib/probes/chatgpt";
import {
  OPENAI_PRICE_TABLE,
  chatGptUsageFromBody,
  estimateChatGptCostUsd,
  typicalRunUsd,
  worstCaseRunUsd,
} from "@/lib/probes/chatgpt-pricing";
import {
  BENCHMARK_HARD_CEILING_USD,
  BENCHMARK_LIFETIME_CEILING_USD,
  BENCHMARK_QUESTION_SETS,
  BenchmarkBudget,
  benchmarkSpendLedger,
  citedDomainStability,
  remainingLifetimeUsd,
  isQuotaExhausted,
  parseBenchmarkArgs,
  planBenchmark,
  summariseBenchmark,
  type BenchmarkRecord,
} from "./lib/chatgpt-benchmark";
import { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import { answerFromRawResponseBody, probeRunnerForProtocol } from "@/lib/protocol-worker/worker";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let globalFetchCalls = 0;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("network disabled in tests");
}) as typeof fetch;

const QUESTION = "What is the best SOC 2 compliance software for a 50-person SaaS company?";
const MODEL = "gpt-6-luna";
const SERVED = `${MODEL}-2026-05-18`;
const AUTO = chatGptSetting(MODEL, "auto");
const REQUIRED = chatGptSetting(MODEL, "required");

type Wire = { url: string; init: RequestInit };
function fixtureFetch(status: number, body: string, wire: Wire[], headers: Record<string, string> = { "x-request-id": "req_abc" }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    wire.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers });
  }) as typeof fetch;
}

function responseBody(over: Record<string, unknown> = {}, output?: unknown[]): string {
  return JSON.stringify({
    id: "resp_123",
    object: "response",
    status: "completed",
    model: SERVED,
    error: null,
    output: output ?? [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "soc 2 software", sources: [
        { type: "url", url: "https://vendor-a.example/soc2" },
        { type: "url", url: "https://www.g2.com/categories/soc-2" },
        { type: "url", url: "https://retrieved-only.example/page" },
      ] } },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [
        { type: "output_text", text: "Vendor A is often listed [1]. Reviews on G2 compare options.", annotations: [
          { type: "url_citation", url: "https://vendor-a.example/soc2", title: "Vendor A SOC 2", start_index: 0, end_index: 10 },
          { type: "url_citation", url: "https://www.g2.com/categories/soc-2", title: "G2 SOC 2", start_index: 30, end_index: 40 },
          { type: "url_citation", url: "https://vendor-a.example/soc2", title: "Vendor A SOC 2", start_index: 41, end_index: 45 },
          { type: "url_citation", url: "https://cited-not-listed.example/x", title: "Unlisted", start_index: 46, end_index: 50 },
        ] },
      ] },
    ],
    usage: { input_tokens: 12000, input_tokens_details: { cached_tokens: 2000 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 12900 },
    ...over,
  });
}

async function expectFailure(run: () => Promise<unknown>): Promise<PerplexityProbeFailure | Error | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e as Error;
  }
}

async function main(): Promise<void> {
  console.log("test-chatgpt-adapter");
  const ORIGINAL_KEY = process.env.OPENAI_PROBE_API_KEY;
  process.env.OPENAI_PROBE_API_KEY = "test-key-not-real";

  /* Q: request -------------------------------------------------------- */
  const wire: Wire[] = [];
  const ok = await runChatGptProbe({ setting: AUTO, prompt: `  ${QUESTION}  `, brandName: "Acme Compliance", domain: "acme.example", fetchImpl: fixtureFetch(200, responseBody(), wire) });
  const sent = String(wire[0]?.init.body ?? "");
  const parsed = JSON.parse(sent || "{}") as Record<string, unknown>;
  check("Q1 one POST to the Responses endpoint", wire.length === 1 && wire[0].url === OPENAI_RESPONSES_ENDPOINT && wire[0].init.method === "POST");
  check("Q2 the endpoint is OpenAI's /v1/responses", OPENAI_RESPONSES_ENDPOINT === "https://api.openai.com/v1/responses");
  check("Q3 the input is the buyer question exactly, trimmed", parsed.input === QUESTION);
  check("Q4 no brand, domain or instructions are sent", !/acme/i.test(sent) && !("instructions" in parsed) && !("previous_response_id" in parsed));
  check("Q5 the body is the fixed setting", sent === JSON.stringify(buildChatGptRequestBody(QUESTION, AUTO)));
  check("Q6 web search tool, auto choice, sources included, store:false",
    JSON.stringify(parsed.tools) === '[{"type":"web_search"}]' && parsed.tool_choice === "auto" &&
    JSON.stringify(parsed.include) === '["web_search_call.action.sources"]' && parsed.store === false);
  check("Q7 no temperature and no fallback model list", !("temperature" in parsed) && !("models" in parsed));
  check("Q8 the setting is versioned and names search mode and model", AUTO.version === `${CHATGPT_SETTING_FAMILY}:auto:${MODEL}` && parsed.model === MODEL);
  check("Q8b reasoning effort low is sent; output cap 4000", JSON.stringify(parsed.reasoning) === '{"effort":"low"}' && parsed.max_output_tokens === 4000);
  check("Q9 the bearer key is OPENAI_PROBE_API_KEY", (wire[0].init.headers as Record<string, string>).authorization === "Bearer test-key-not-real");
  check("Q10 the hashed body is the sent body", ok.fullRequestBody === sent && ok.fullRequestBodySha256 === sha256Hex(sent));
  check("Q11 the prompt hash is of the trimmed question", ok.rawProbeRequestSha256 === sha256Hex(QUESTION) && ok.rawProbeRequest === QUESTION);

  delete process.env.OPENAI_PROBE_API_KEY;
  const prevAnalysis = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "analysis-key";
  const noKeyWire: Wire[] = [];
  const noKey = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), noKeyWire) }));
  check("Q12 the analysis key alone does not enable a probe", !!noKey && /OPENAI_PROBE_API_KEY/.test(noKey.message) && noKeyWire.length === 0);
  if (prevAnalysis === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevAnalysis;
  process.env.OPENAI_PROBE_API_KEY = "test-key-not-real";

  /* S: success -------------------------------------------------------- */
  const raw = responseBody();
  check("S1 the answer is the output text", ok.answer === "Vendor A is often listed [1]. Reviews on G2 compare options.");
  check("S2 the raw body is exact and hashed", ok.rawResponseBody === raw && ok.rawResponseBodySha256 === sha256Hex(raw));
  check("S3 status, latency and request id are recorded", ok.httpStatus === 200 && typeof ok.latencyMs === "number" && ok.providerRequestId === "req_abc");
  check("S4 the served (dated) model is recorded", ok.model === SERVED && ok.usedMock === false);
  check("S5 citations are the annotated URLs only, de-duplicated, in order",
    JSON.stringify(ok.citations) === JSON.stringify(["https://vendor-a.example/soc2", "https://www.g2.com/categories/soc-2", "https://cited-not-listed.example/x"]));
  const retrievedUrls = ok.searchResults.map((r) => r.url);
  check("S6 a retrieved-only URL is kept as retrieved and never cited",
    retrievedUrls.includes("https://retrieved-only.example/page") && !ok.citations.includes("https://retrieved-only.example/page"));
  check("S7 a cited URL missing from the sources list still counts as retrieved", retrievedUrls.includes("https://cited-not-listed.example/x"));
  check("S8 source classification uses cited URLs only", ok.sourceCitations.length === 3 && ok.sourceCitations.some((s) => s.type === "review_site"));
  check("S9 the transcript separates cited from retrieved", /cited sources:[\s\S]*retrieved sources:/.test(ok.rawResponse) && ok.rawResponseSha256 === sha256Hex(ok.rawResponse));
  check("S10 no citation markers are invented", ok.citationMarkers === undefined);
  const noSearch = await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({}, [
    { type: "message", content: [{ type: "output_text", text: "An answer from model knowledge.", annotations: [] }] },
  ]), []) });
  check("S11 an answer with no search and no citations is an observation", noSearch.answer.length > 0 && noSearch.citations.length === 0 && noSearch.searchResults.length === 0);
  check("S12 the bare model name is accepted as served", (await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ model: MODEL }), []) })).model === MODEL);

  /* H: helpers -------------------------------------------------------- */
  const out = JSON.parse(raw).output;
  check("H1 output text joins every output_text part", chatGptOutputText([{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "refusal", refusal: "x" }, { type: "output_text", text: "b" }] }]) === "ab");
  check("H2 sources come from web_search_call items only", JSON.stringify(chatGptSearchSources(out)) === JSON.stringify(["https://vendor-a.example/soc2", "https://www.g2.com/categories/soc-2", "https://retrieved-only.example/page"]));
  check("H3 usage counts web search calls and search actions", (() => {
    const u = chatGptUsageFromBody({ output: [...out, { type: "web_search_call", action: { type: "open_page", url: "https://x.example" } }] });
    return u.webSearchCalls === 2 && u.searchActions === 1 && u.searchOccurred;
  })());
  check("H4 cited URLs ignore non-url annotations", chatGptCitedUrls([{ type: "message", content: [{ type: "output_text", text: "x", annotations: [{ type: "file_citation", file_id: "f" }, { type: "url_citation", url: "https://a.example/)" }] }] }]).map((c) => c.url).join() === "https://a.example/");
  check("H5 served-model rule: exact or dated snapshot only",
    isServedModelOf(MODEL, MODEL) && isServedModelOf(MODEL, `${MODEL}-2026-01-31`) && isServedModelOf("gpt-6.1-terra", "gpt-6.1-terra-2026-09-01") &&
    !isServedModelOf("gpt-6.1-terra", "gpt-641-terra") && !isServedModelOf(MODEL, `${MODEL}-pro`) && !isServedModelOf(MODEL, "gpt-6") && !isServedModelOf(MODEL, `${MODEL}-2026-01-31-x`));

  /* F: failures ------------------------------------------------------- */
  const unusableCases: Array<[string, string, RegExp]> = [
    ["invalid JSON", "not json", /invalid_json/],
    ["an array", "[]", /not_an_object/],
    ["a chat completion body", JSON.stringify({ object: "chat.completion", choices: [] }), /unexpected_object/],
    ["an error object", responseBody({ error: { code: "server_error", message: "x" } }), /error_present/],
    ["status incomplete", responseBody({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), /status:incomplete/],
    ["status failed", responseBody({ status: "failed" }), /status:failed/],
    ["a missing id", responseBody({ id: "" }), /missing_id/],
    ["a missing served model", responseBody({ model: null }), /missing_served_model/],
    ["another model served", responseBody({ model: "gpt-6.1-terra-2026-09-01" }), /unexpected_served_model/],
    ["empty output text", responseBody({}, [{ type: "message", content: [{ type: "output_text", text: "   ", annotations: [] }] }]), /empty_output_text/],
    ["a refusal only", responseBody({}, [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]), /empty_output_text/],
  ];
  for (const [label, body, cause] of unusableCases) {
    const w: Wire[] = [];
    const e = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, body, w) }));
    const f = e instanceof PerplexityProbeFailure ? e : null;
    check(`F ${label} fails with the whole body as evidence`,
      !!f && cause.test(f.message) && f.reason === "empty_answer" && f.httpStatus === 200 && f.errorBody === body &&
      f.errorBodySha256 === sha256Hex(body) && f.fullRequestBody === String(w[0]?.init.body) && f.fullRequestBodySha256 === sha256Hex(f.fullRequestBody) &&
      f.providerRequestId === "req_abc", e?.message ?? "no failure");
  }
  for (const status of [400, 401, 429, 500]) {
    const errBody = JSON.stringify({ error: { message: "nope", type: "x" } });
    const e = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(status, errBody, []) }));
    const f = e instanceof PerplexityProbeFailure ? e : null;
    check(`F HTTP ${status} is http_error with the body`, !!f && f.reason === "http_error" && f.httpStatus === status && f.errorBody === errBody && f.errorBodySha256 === sha256Hex(errBody));
  }
  const net = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: (async () => { throw new Error("aborted"); }) as typeof fetch }));
  check("F a network error or timeout is network_error with the request", net instanceof PerplexityProbeFailure && net.reason === "network_error" && net.httpStatus === null && net.fullRequestBodySha256 === sha256Hex(net.fullRequestBody));
  check("F the failure message never echoes the key", !/test-key-not-real/.test(String(net?.message)));

  /* M: mock ----------------------------------------------------------- */
  const mock = await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", mockResponse: { ...ok, fullRequestBody: "forged", fullRequestBodySha256: sha256Hex("forged") } });
  check("M1 a mock is marked and carries no outbound body", mock.usedMock === true && mock.fullRequestBody === undefined && mock.fullRequestBodySha256 === undefined);

  /* A: approval ------------------------------------------------------ */
  check("A1 no model is approved yet", CHATGPT_APPROVED_MODEL === null && approvedChatGptSetting("auto") === null && approvedChatGptSetting("required") === null);
  const refusedWire: Wire[] = [];
  const refused = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), refusedWire) }));
  check("A2 a run without a setting is refused before any request", !!refused && /No ChatGPT model is approved/.test(refused.message) && refusedWire.length === 0);
  const mockRefused = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", mockResponse: ok }));
  check("A3 even a mock needs a setting", !!mockRefused);
  check("A4 an approved model yields an exact-snapshot setting per search mode", (() => {
    const a = approvedChatGptSetting("auto", MODEL);
    const r = approvedChatGptSetting("required", MODEL);
    return !!a && !!r && a.servedModelRule === "exact_or_snapshot" && a.version !== r.version;
  })());
  check("A5 gpt-5-mini is not a candidate (OpenAI shutdown 2026-12-11)", !CHATGPT_BENCHMARK_CANDIDATES.some((c) => c.setting.model.startsWith("gpt-5-mini")));
  check("A9 the dated snapshots are candidates, checked exactly, pinning recorded", (() => {
    const dated = CHATGPT_BENCHMARK_CANDIDATES.filter((c) => c.pinning === "dated_snapshot");
    return dated.length === 2 && dated.every((c) => /-\d{4}-\d{2}-\d{2}$/.test(c.setting.model) && c.role === "candidate" && c.setting.servedModelRule === "exact_or_snapshot") &&
      isServedModelOf("gpt-5.5-2026-04-23", "gpt-5.5-2026-04-23") && !isServedModelOf("gpt-5.5-2026-04-23", "gpt-5.5") && !isServedModelOf("gpt-5.5-2026-04-23", "gpt-5.5-2026-06-01");
  })());
  check("A10 pinning matches OpenAI's documentation (luna undated, chat-latest moving)", (() => {
    const p = Object.fromEntries(CHATGPT_BENCHMARK_CANDIDATES.map((c) => [c.setting.model, c.pinning]));
    return p["gpt-6-luna"] === "undated_id" && p["gpt-6.1-terra"] === "undated_id" && p["chat-latest"] === "moving_alias" &&
      p["gpt-5.5-2026-04-23"] === "dated_snapshot" && p["gpt-5.4-2026-03-05"] === "dated_snapshot";
  })());
  check("A6 chat-latest is a reference only, recorded not checked, no reasoning field", (() => {
    const ref = CHATGPT_BENCHMARK_CANDIDATES.find((c) => c.setting.model === "chat-latest");
    return !!ref && ref.role === "reference" && ref.setting.servedModelRule === "recorded_only" && !("reasoning" in buildChatGptRequestBody("q", ref.setting));
  })());
  check("A7 every candidate is priced", CHATGPT_BENCHMARK_CANDIDATES.every((c) => worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens) !== null));
  const ref = CHATGPT_BENCHMARK_CANDIDATES.find((c) => c.role === "reference")!.setting;
  const refRun = await runChatGptProbe({ setting: ref, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ model: "gpt-6-chat-2026-10-01" }), []) });
  check("A8 the reference records whatever model was served", refRun.model === "gpt-6-chat-2026-10-01");

  /* R: search modes ---------------------------------------------------- */
  const reqWire: Wire[] = [];
  const req = await runChatGptProbe({ setting: REQUIRED, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), reqWire) });
  check("R1 search-required sends tool_choice required and is its own version", JSON.parse(String(reqWire[0].init.body)).tool_choice === "required" && req.setting.version !== AUTO.version && req.usage.searchOccurred);
  const noSearchBody = responseBody({}, [{ type: "message", content: [{ type: "output_text", text: "From memory.", annotations: [] }] }]);
  const reqNoSearch = await expectFailure(() => runChatGptProbe({ setting: REQUIRED, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, noSearchBody, []) }));
  check("R2 search-required without a search fails with evidence", reqNoSearch instanceof ChatGptProbeFailure && /search_required_not_performed/.test(reqNoSearch.message) && reqNoSearch.errorBody === noSearchBody);
  check("R3 automatic search without a search is recorded, not failed", noSearch.usage.searchOccurred === false && noSearch.usage.webSearchCalls === 0);
  check("R4 automatic search that searched is recorded", ok.usage.searchOccurred === true && ok.usage.webSearchCalls === 1 && ok.setting.search === "auto");

  /* P: usage and cost --------------------------------------------------- */
  check("P1 usage is kept on the result", ok.usage.inputTokens === 12000 && ok.usage.cachedInputTokens === 2000 && ok.usage.outputTokens === 900 && ok.usage.reasoningTokens === 400 && ok.usage.totalTokens === 12900);
  const expectUsd = Math.round(((10000 * 0.1 + 2000 * 0.01 + 900 * 0.5) / 1e6 + 0.01) * 1e6) / 1e6;
  check("P2 cost is estimated from usage and the price table", ok.cost.usd === expectUsd && ok.cost.basis === "estimated_from_usage" && (ok.cost as { priceTable: string }).priceTable === OPENAI_PRICE_TABLE.version, JSON.stringify(ok.cost));
  check("P3 missing usage is unknown, never 0", (() => {
    const c = estimateChatGptCostUsd(MODEL, chatGptUsageFromBody({ output: [] }));
    return c.usd === null && c.basis === "unknown";
  })());
  check("P4 an unpriced model is unknown", estimateChatGptCostUsd("gpt-9-unknown", ok.usage).usd === null);
  check("P5 malformed usage values are null, not 0", (() => {
    const u = chatGptUsageFromBody({ usage: { input_tokens: -1, output_tokens: "9", total_tokens: 1.5 } });
    return u.inputTokens === null && u.outputTokens === null && u.totalTokens === null && u.cachedInputTokens === null;
  })());
  check("P6 cached tokens above input are capped at input", estimateChatGptCostUsd(MODEL, { ...ok.usage, cachedInputTokens: 99999 }).usd! < (ok.cost.usd as number));
  check("P12 the dated snapshots are priced as published (2026-11-11)",
    JSON.stringify(OPENAI_PRICE_TABLE.models["gpt-5.5-2026-04-23"]) === JSON.stringify({ input: 5, cachedInput: 0.5, output: 30 }) &&
    JSON.stringify(OPENAI_PRICE_TABLE.models["gpt-5.4-2026-03-05"]) === JSON.stringify({ input: 2.5, cachedInput: 0.25, output: 15 }));
  check("P13 a typical run is estimated below its worst case, and unpriced is null", (typicalRunUsd("gpt-5.5-2026-04-23") as number) < (worstCaseRunUsd("gpt-5.5-2026-04-23", 4000) as number) && typicalRunUsd("unpriced-model") === null);
  check("P7 the price table is dated and sourced", OPENAI_PRICE_TABLE.recordedOn === "2026-11-11" && OPENAI_PRICE_TABLE.source.startsWith("https://developers.openai.com/") && OPENAI_PRICE_TABLE.webSearchPerCallUsd === 0.01);
  check("P8 worst case exceeds a typical run", (worstCaseRunUsd(MODEL, 4000) as number) > (ok.cost.usd as number));
  const billedFail = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ status: "incomplete" }), []) }));
  check("P9 a billed-but-unusable run carries its usage and cost", billedFail instanceof ChatGptProbeFailure && billedFail.usage?.outputTokens === 900 && billedFail.cost.usd !== null);
  const httpFail = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(500, "{}", []) }));
  check("P10 an HTTP failure has unknown cost, not 0", httpFail instanceof ChatGptProbeFailure && httpFail.cost.usd === null && httpFail.usage === null);
  check("P11 the mock has unknown cost", mock.cost.usd === null && mock.usage.inputTokens === null);

  /* K: benchmark -------------------------------------------------------- */
  const kq = [{ id: "q1", category: "discovery" as const, text: "a b c" }, { id: "q2", category: "comparison" as const, text: "d e f" }];
  const firstThree = CHATGPT_BENCHMARK_CANDIDATES.slice(0, 3);
  const kplan = planBenchmark(kq, firstThree, 2);
  check("K1 the plan is questions × repeats × models", kplan.length === 12 && new Set(kplan.map((p) => p.index)).size === 12);
  check("K2 the plan interleaves models within each question", kplan[0].setting.model !== kplan[1].setting.model && kplan[0].question.id === kplan[1].question.id && kplan[3].question.id === "q2");
  check("K3 the first benchmark's plan (three models) is 150 runs", planBenchmark(new Array(10).fill(kq[0]), firstThree, 5).length === 150);
  const phase2Models = ["gpt-5.5-2026-04-23", "gpt-5.4-2026-03-05", "gpt-6-luna", "chat-latest"];
  const phase2 = planBenchmark(new Array(10).fill(kq[0]), CHATGPT_BENCHMARK_CANDIDATES.filter((c) => phase2Models.includes(c.setting.model)), 3, { "chat-latest": 2 });
  check("K24 per-model repeats: the smaller validation is 3×10×3 + 10×2 = 110 runs", phase2.length === 110 &&
    phase2.filter((p) => p.setting.model === "chat-latest").length === 20 && phase2.filter((p) => p.setting.model === "gpt-6-luna").length === 30 &&
    !phase2.some((p) => p.setting.model === "chat-latest" && p.repeat === 3) && new Set(phase2.map((p) => p.index)).size === 110);
  check("K25 the reduced model drops out of the last round only (fair partial stop)", phase2.slice(0, 80).every((p) => p.repeat <= 2) && phase2.slice(80).every((p) => p.repeat === 3));
  check("K26 --repeats-by-model and --question-set are parsed and bounded", (() => {
    const a = parseBenchmarkArgs(["--question-set=smaller-vendor", "--repeats=3", "--repeats-by-model=chat-latest:2,gpt-5.5-2026-04-23:1"]);
    return a.ok && a.args.questionSet === "smaller-vendor" && a.args.repeatsByModel["chat-latest"] === 2 && a.args.repeatsByModel["gpt-5.5-2026-04-23"] === 1 &&
      !parseBenchmarkArgs(["--repeats-by-model=chat-latest:6"]).ok && !parseBenchmarkArgs(["--repeats-by-model=chat-latest"]).ok && !parseBenchmarkArgs(["--question-set=other"]).ok;
  })());
  const lrec = (over: Partial<BenchmarkRecord>) => ({ model: "gpt-6-luna", cost: null, httpStatus: 200, responseBody: null, usage: null, ...over }) as Pick<BenchmarkRecord, "model" | "cost" | "httpStatus" | "responseBody" | "usage">;
  const quota = JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } });
  const ledger = benchmarkSpendLedger([
    lrec({ cost: { usd: 1.5, basis: "estimated_from_usage", priceTable: "x" } }),
    lrec({ httpStatus: 429, responseBody: quota }),
    lrec({ httpStatus: 500, responseBody: "{}" }),
  ], () => 0.25);
  check("K27 the ledger counts estimates, $0 for credit refusals, worst case for other unknowns", !!ledger && ledger.estimatedUsd === 1.5 && ledger.refusedNotBilled === 1 && ledger.unknownCountedAtWorstCase === 1 && ledger.totalUsd === 1.75);
  check("K28 the ledger refuses an unpriced unknown, and the lifetime ceiling is $40 including earlier spend",
    benchmarkSpendLedger([lrec({ httpStatus: 500 })], () => null) === null && BENCHMARK_LIFETIME_CEILING_USD === 40 &&
    remainingLifetimeUsd({ runs: 1, estimatedUsd: 5.95, refusedNotBilled: 0, unknownCountedAtWorstCase: 0, totalUsd: 5.95 }) === 34.05 &&
    remainingLifetimeUsd({ runs: 1, estimatedUsd: 41, refusedNotBilled: 0, unknownCountedAtWorstCase: 0, totalUsd: 41 }) === 0);
  check("K4 dry run is the default", (() => { const a = parseBenchmarkArgs([]); return a.ok && !a.args.live; })());
  check("K5 live needs a cap", !parseBenchmarkArgs(["--live", "--i-confirm-founder-approved-budget"]).ok);
  check("K6 live needs the confirmation flag", !parseBenchmarkArgs(["--live", "--max-usd=10"]).ok);
  check("K7 the cap may not exceed the founder ceiling", BENCHMARK_HARD_CEILING_USD === 40 && !parseBenchmarkArgs(["--live", "--max-usd=40.01", "--i-confirm-founder-approved-budget"]).ok && parseBenchmarkArgs(["--live", "--max-usd=40", "--i-confirm-founder-approved-budget"]).ok);
  check("K8 repeats are bounded and unknown flags refused", !parseBenchmarkArgs(["--repeats=6"]).ok && !parseBenchmarkArgs(["--repeats=0"]).ok && !parseBenchmarkArgs(["--yes"]).ok);
  const budget = new BenchmarkBudget(1);
  check("K9 a run is refused when its worst case could pass the cap", budget.canStart(1) && !budget.canStart(1.01));
  budget.settle({ usd: null, basis: "unknown", reason: "usage_missing" }, 0.4);
  check("K10 an unknown cost settles at the worst case", budget.spentUsd === 0.4);
  check("K11 a run above its worst case is an overrun", budget.settle({ usd: 0.5, basis: "estimated_from_usage", priceTable: "x" }, 0.3).overrun && budget.spentUsd === 0.9);
  check("K12 a null cost (no call) settles at the worst case", (() => { const b = new BenchmarkBudget(5); b.settle(null, 0.2); return b.spentUsd === 0.2; })());
  check("K13 cited-domain stability", citedDomainStability([{ citations: ["https://www.a.example/x", "https://b.example"] }, { citations: ["https://a.example/y"] }]) === 0.5 &&
    citedDomainStability([{ citations: [] }, { citations: [] }]) === 1 && citedDomainStability([{ citations: [] }]) === null);
  const rec = (over: Partial<BenchmarkRecord>): BenchmarkRecord => ({
    index: 0, model: MODEL, role: "candidate", settingVersion: AUTO.version, questionId: "q1", repeat: 1, startedAt: "", outcome: "completed", failure: null,
    httpStatus: 200, latencyMs: 1000, servedModel: SERVED, providerRequestId: null, usage: ok.usage, cost: ok.cost, citations: ["https://a.example"], retrievedCount: 3,
    answerChars: 100, requestBody: null, requestBodySha256: null, responseBody: null, responseBodySha256: null, ...over,
  });
  const sum = summariseBenchmark([
    rec({}),
    rec({ repeat: 2, latencyMs: 3000, usage: noSearch.usage, citations: [] }),
    rec({ repeat: 3, outcome: "failed", failure: "http_error:429", usage: null, cost: { usd: null, basis: "unknown", reason: "usage_missing" }, citations: [] }),
  ])[0];
  check("K14 summary counts runs, failures and search rate", sum.runs === 3 && sum.completed === 2 && sum.failures["http_error:429"] === 1 && sum.searchRate === 0.5 && sum.answersWithoutCitation === 1);
  check("K15 summary cost excludes unknowns and counts them", sum.runsWithUnknownCost === 1 && sum.estimatedCostUsd === Math.round(2 * (ok.cost.usd as number) * 1e6) / 1e6);
  check("K16 summary latency and stability", sum.latencyP50Ms === 1000 && sum.latencyP90Ms === 3000 && sum.medianCitedDomainStability === 0);
  const runnerSrc = fs.readFileSync("scripts/benchmark-chatgpt-models.ts", "utf8");
  check("K17 the runner reads the key only to check it is set (never prints or writes it)",
    (runnerSrc.match(/process\.env\.OPENAI_PROBE_API_KEY/g) ?? []).length === 1 && runnerSrc.includes("if (!process.env.OPENAI_PROBE_API_KEY)"));
  check("K18 the runner writes only under .benchmark-out (the spend ledger)", runnerSrc.includes('".benchmark-out"') && /--out must be under \.benchmark-out/.test(runnerSrc));
  check("K29 a live run is refused when its cap exceeds what is left of the lifetime ceiling",
    /benchmarkSpendLedger\(readLedgerRecords\(\)/.test(runnerSrc) && /if \(\(args\.maxUsd as number\) > remaining\)/.test(runnerSrc) &&
    runnerSrc.indexOf("(args.maxUsd as number) > remaining") < runnerSrc.indexOf("process.env.OPENAI_PROBE_API_KEY"));
  const sv = JSON.parse(fs.readFileSync(BENCHMARK_QUESTION_SETS["smaller-vendor"], "utf8")) as { version: string; questions: Array<{ id: string; text: string; category: string }> };
  const vendorNames = ["asana", "hubspot", "salesforce", "zendesk", "gainsight", "chargebee", "stripe", "mixpanel", "amplitude", "pagerduty", "greenhouse", "lever", "outreach", "salesloft", "productboard", "pendo", "appcues", "bamboohr", "rippling", "ironclad", "docusign"];
  check("K30 the smaller-vendor set: ten brand-free questions across four categories, lint-clean",
    sv.version === "x1-smaller-vendor-questions-v1" && sv.questions.length === 10 && new Set(sv.questions.map((q) => q.id)).size === 10 &&
    new Set(sv.questions.map((q) => q.category)).size === 4 && sv.questions.every((q) => !vendorNames.some((v) => q.text.toLowerCase().includes(v))) &&
    sv.questions.every((q) => !FORBIDDEN_W1_PHRASES.some((p) => q.text.toLowerCase().includes(p))));
  check("K19 .benchmark-out is git-ignored", /^\.benchmark-out\/$/m.test(fs.readFileSync(".gitignore", "utf8")));
  const qs = JSON.parse(fs.readFileSync("scripts/fixtures/chatgpt-benchmark-questions.json", "utf8")) as { questions: Array<{ text: string; category: string }> };
  check("K20 ten questions across the four categories", qs.questions.length === 10 && new Set(qs.questions.map((q) => q.category)).size === 4);
  check("K21 the questions pass the claim-language lint", qs.questions.every((q) => !FORBIDDEN_W1_PHRASES.some((p) => q.text.toLowerCase().includes(p))));
  check("K23 a credit-exhausted 429 stops the benchmark; a rate-limit 429 does not",
    isQuotaExhausted(429, JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } })) &&
    !isQuotaExhausted(429, JSON.stringify({ error: { type: "requests", code: "rate_limit_exceeded" } })) &&
    !isQuotaExhausted(500, JSON.stringify({ error: { type: "insufficient_quota" } })) && !isQuotaExhausted(429, "not json") &&
    /isQuotaExhausted\(record\.httpStatus, record\.responseBody\)/.test(runnerSrc));
  check("K22 the benchmark is not a test:* command (CI never runs it)", !/"test:[^"]*": "[^"]*benchmark-chatgpt/.test(fs.readFileSync("package.json", "utf8")));

  /* W: worker --------------------------------------------------------- */
  const runner = async () => ok;
  const route = probeRunnerForProtocol({ runProbe: runner, runAgentProbe: runner }, { provider: CHATGPT_PROVIDER, modelConfig: { model: MODEL } });
  check("W1 the worker refuses an openai_chatgpt protocol (not wired)", !route.ok && route.detail === "UNKNOWN_PROVIDER");
  check("W2 a stored ChatGPT body is not replayed as an answer", answerFromRawResponseBody(raw) === null);
  check("W3 the worker does not import the adapter", !/probes\/chatgpt/.test(fs.readFileSync("lib/protocol-worker/worker.ts", "utf8")));

  /* B: boundary ------------------------------------------------------- */
  const importers = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return importers(p);
      return /\.(ts|tsx)$/.test(e.name) && /probes\/chatgpt"/.test(fs.readFileSync(p, "utf8")) ? [p] : [];
    });
  check("B1 nothing under app/ imports the adapter", importers("app").length === 0, importers("app").join(", "));
  const libImporters = importers("lib").filter((p) => p !== path.join("lib", "probes", "chatgpt.ts"));
  check("B2 nothing else under lib/ imports the adapter yet", libImporters.length === 0, libImporters.join(", "));
  const pricingSrc = fs.readFileSync("lib/probes/chatgpt-pricing.ts", "utf8");
  check("B4 the pricing module cannot make a call", !/fetch\(|process\.env|from "@\/lib\/probes\/chatgpt"/.test(pricingSrc));
  const scriptImporters = importers("scripts").map((p) => p.replace(/\\/g, "/")).sort();
  check("B5 only the benchmark and this test import the adapter under scripts/",
    JSON.stringify(scriptImporters) === JSON.stringify(["scripts/benchmark-chatgpt-models.ts", "scripts/lib/chatgpt-benchmark.ts", "scripts/test-chatgpt-adapter.ts"]), scriptImporters.join(", "));
  check("B3 the adapter never reads the analysis key", !/process\.env\.OPENAI_API_KEY\b/.test(fs.readFileSync("lib/probes/chatgpt.ts", "utf8")));

  /* N: validity note -------------------------------------------------- */
  const note = fs.readFileSync("docs/ADAPTER_VALIDITY_CHATGPT.md", "utf8");
  for (const heading of [
    "Interface type",
    "Injected context",
    "Request and response provenance",
    "Reproducibility limits",
    "Terms and policy constraints",
    "Cost, rate limits and latency",
    "Comparability with existing surfaces",
  ]) check(`N §4 note covers "${heading}"`, note.includes(`## ${heading}`));
  check("N the note states the required limitation", note.includes("It is not what users of the ChatGPT app see"));
  check("N the note names the setting family and price table", note.includes(CHATGPT_SETTING_FAMILY) && note.includes(OPENAI_PRICE_TABLE.version));
  check("N the note states the V1 claim boundary", note.includes("controlled OpenAI API responses, not observations of ChatGPT.com"));
  check("N the note records that no scraping service is used", /third-party ChatGPT scraping/.test(note));
  const hit = FORBIDDEN_W1_PHRASES.find((p) => note.toLowerCase().includes(p));
  check("N the note passes the claim-language lint", !hit, hit ?? "");

  check("Z no test reached the network", globalFetchCalls === 0);
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_PROBE_API_KEY;
  else process.env.OPENAI_PROBE_API_KEY = ORIGINAL_KEY;

  console.log(`\n${checks - failures}/${checks} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
