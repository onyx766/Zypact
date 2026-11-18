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
 *   - a setting version names one request: families are frozen, the v2
 *     versions recorded to 2026-11-11 still mean what they meant, and the
 *     confirmation setting (gpt-5.4-2026-03-05, output cap 8000, OpenAI's
 *     flex tier) is the one awaiting approval;
 *   - the flex tier: the request asks for it, an answer another tier served
 *     is a failure that stops the benchmark, a flex capacity refusal (HTTP
 *     429 "Resource Unavailable") is not an attempt and books nothing, and
 *     cost is an upper bound (output at the flex rate, input at standard);
 *   - the benchmark's spend rules: the lifetime ledger fails closed, a call
 *     is reserved in writing before it is made, and the run stops itself on
 *     refusals and repeated unknown costs;
 *   - the adapter-validity note covers every METHODOLOGY §4 heading.
 *
 * No test contacts a provider: global fetch throws if called.
 */
import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "@/lib/evidence/hash";
import { OPENAI_RESPONSES_ENDPOINT } from "@/lib/probes/endpoints";
import {
  CHATGPT_APPROVED_SETTING_VERSION,
  CHATGPT_BENCHMARK_CANDIDATES,
  CHATGPT_CONFIRMATION_SETTING,
  CHATGPT_PROVIDER,
  CHATGPT_SETTING_FAMILIES,
  ChatGptProbeFailure,
  approvedChatGptSetting,
  buildChatGptRequestBody,
  chatGptCitedUrls,
  chatGptOutputText,
  chatGptSearchSources,
  chatGptSetting,
  chatGptSettingOfVersion,
  isCanonicalChatGptSetting,
  isServedModelOf,
  maxOutputTokensOfSettingVersion,
  runChatGptProbe,
} from "@/lib/probes/chatgpt";
import {
  OPENAI_PRICE_TABLE,
  chatGptUsageFromBody,
  estimateChatGptCostUsd,
  flexAllTokensCostUsd,
  typicalRunUsd,
  worstCaseRunUsd,
  type ChatGptUsage,
} from "@/lib/probes/chatgpt-pricing";
import {
  BENCHMARK_HARD_CEILING_USD,
  BENCHMARK_LIFETIME_CEILING_USD,
  BENCHMARK_MAX_RUNS,
  BENCHMARK_QUESTION_SETS,
  BENCHMARK_SPEND_CHECKPOINT,
  BenchmarkBudget,
  DEADLINE_FAILURE,
  FLEX_BUSY_BACKOFF_MS,
  FLEX_BUSY_FAILURE,
  FLEX_BUSY_MAX_WAIT_PER_INVOCATION_MS,
  FLEX_CALL_DEADLINE_MS,
  MAX_CONSECUTIVE_UNKNOWN_COST,
  MAX_UNKNOWN_COST_RUNS,
  NO_RUNS,
  benchmarkSpendLedger,
  callDeadlineMs,
  capFitsLifetime,
  citedDomainStability,
  countRun,
  failedRuns,
  flexBusyWaitMs,
  hasUnknownCost,
  incompleteReasonOfBody,
  isCreditRefusal,
  isFlexBusyRefusal,
  isFlexResourceUnavailable,
  isNotBilledRefusal,
  ledgerCoversCheckpoint,
  mergeQuestionSets,
  recordsThroughCheckpoint,
  projectedRunUsd,
  recordedRunCost,
  remainingLifetimeUsd,
  runsCapAllows,
  isQuotaExhausted,
  isRequestRejected,
  parseBenchmarkArgs,
  parseLedgerLines,
  planBenchmark,
  planIdentityKey,
  resumePoint,
  servedOffRequestedTier,
  servedTierOfBody,
  stopAfterRun,
  summariseBenchmark,
  unsettledReservations,
  wasFlexRequest,
  type BenchmarkPlanFile,
  type BenchmarkQuestion,
  type BenchmarkRecord,
  type LedgerRecord,
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
const V2 = "openai-responses-websearch-v2";
const V3 = "openai-responses-websearch-v3";
const V4 = "openai-responses-websearch-v4";
const MODEL = "gpt-6-luna";
const SERVED = `${MODEL}-2026-05-18`;
const AUTO = chatGptSetting(MODEL, "auto", V2);
const REQUIRED = chatGptSetting(MODEL, "required", V2);
const CONFIRM_MODEL = "gpt-5.4-2026-03-05";

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
  check("Q8 the setting is versioned and names family, search mode and model", AUTO.version === `${V2}:auto:${MODEL}` && parsed.model === MODEL);
  check("Q8b reasoning effort low is sent; output cap 4000 under family v2", JSON.stringify(parsed.reasoning) === '{"effort":"low"}' && parsed.max_output_tokens === 4000);

  /* V: setting families ------------------------------------------------ */
  const body54 = (cap: number, flex = false) => `{"model":"${CONFIRM_MODEL}","input":"q","tools":[{"type":"web_search"}],"tool_choice":"auto","include":["web_search_call.action.sources"],"reasoning":{"effort":"low"},"max_output_tokens":${cap},"store":false${flex ? ',"service_tier":"flex"' : ""}}`;
  check("V1 three families: v2 keeps the 4000 cap and cannot be approved, v3 raises the cap to 8000, v4 is v3 on the flex tier",
    JSON.stringify(CHATGPT_SETTING_FAMILIES) === JSON.stringify({
      [V2]: { maxOutputTokens: 4000, serviceTier: null, approvable: false },
      [V3]: { maxOutputTokens: 8000, serviceTier: null, approvable: true },
      [V4]: { maxOutputTokens: 8000, serviceTier: "flex", approvable: true },
    }));
  const old54 = chatGptSetting(CONFIRM_MODEL, "auto", V2);
  check("V2 a v2 setting is what was recorded: the same version string and the same request bytes",
    old54.version === "openai-responses-websearch-v2:auto:gpt-5.4-2026-03-05" && old54.maxOutputTokens === 4000 && JSON.stringify(buildChatGptRequestBody("q", old54)) === body54(4000));
  const v3For54 = chatGptSetting(CONFIRM_MODEL, "auto", V3);
  check("V3 the confirmation setting is a new version that differs from v2 in the output cap and the service tier only, and v3 still builds the request it named",
    CHATGPT_CONFIRMATION_SETTING.version === "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05" && CHATGPT_CONFIRMATION_SETTING.version !== old54.version &&
    JSON.stringify(buildChatGptRequestBody("q", CHATGPT_CONFIRMATION_SETTING)) === body54(8000, true) &&
    JSON.stringify(buildChatGptRequestBody("q", v3For54)) === body54(8000) && v3For54.version === "openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05" &&
    JSON.stringify({ ...CHATGPT_CONFIRMATION_SETTING, version: "", maxOutputTokens: 0, serviceTier: null }) === JSON.stringify({ ...old54, version: "", maxOutputTokens: 0, serviceTier: null }));
  const recordedVersions = ["gpt-6-luna", "gpt-6.1-terra", "chat-latest", "gpt-5.5-2026-04-23", CONFIRM_MODEL].map((m) => `openai-responses-websearch-v2:auto:${m}`);
  check("V4 every version recorded to 2026-11-11 is still built, at 4000, and the four other candidates keep theirs",
    recordedVersions.every((v) => chatGptSetting(v.split(":")[2], "auto", V2).version === v && chatGptSetting(v.split(":")[2], "auto", V2).maxOutputTokens === 4000) &&
    JSON.stringify(CHATGPT_BENCHMARK_CANDIDATES.slice(0, 4).map((c) => c.setting.version)) === JSON.stringify(recordedVersions.slice(0, 4)));
  check("V5 a recorded version's cap comes from its family; an unknown family cannot be told",
    recordedVersions.every((v) => maxOutputTokensOfSettingVersion(v) === 4000) && maxOutputTokensOfSettingVersion(CHATGPT_CONFIRMATION_SETTING.version) === 8000 &&
    maxOutputTokensOfSettingVersion("openai-responses-websearch-v9:auto:x") === null && maxOutputTokensOfSettingVersion("openai-responses-websearch-v3") === null &&
    maxOutputTokensOfSettingVersion("constructor:auto:x") === null && maxOutputTokensOfSettingVersion("") === null && maxOutputTokensOfSettingVersion(undefined) === null);
  check("V6 a version names one request: one candidate per model, unique versions, the reference rule fixed by the model in every family",
    new Set(CHATGPT_BENCHMARK_CANDIDATES.map((c) => c.setting.model)).size === CHATGPT_BENCHMARK_CANDIDATES.length &&
    new Set(CHATGPT_BENCHMARK_CANDIDATES.map((c) => c.setting.version)).size === CHATGPT_BENCHMARK_CANDIDATES.length &&
    JSON.stringify(chatGptSetting("chat-latest", "auto", V2)) === JSON.stringify(CHATGPT_BENCHMARK_CANDIDATES[2].setting) &&
    chatGptSetting("chat-latest", "auto", V3).reasoningEffort === null && chatGptSetting("chat-latest", "auto", V3).servedModelRule === "recorded_only" &&
    chatGptSetting.length === 3);
  const capWire: Wire[] = [];
  const capOverride = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", maxTokens: 8000, fetchImpl: fixtureFetch(200, responseBody(), capWire) }));
  const sameCapWire: Wire[] = [];
  await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", maxTokens: 4000, fetchImpl: fixtureFetch(200, responseBody(), sameCapWire) });
  check("V8 settings and families are frozen, and a setting is built only from a known family, search mode and model", (() => {
    const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
    const cast = chatGptSetting as unknown as (m: unknown, s: unknown, f: unknown) => unknown;
    return Object.isFrozen(CHATGPT_SETTING_FAMILIES) && Object.isFrozen(CHATGPT_SETTING_FAMILIES[V3]) && Object.isFrozen(CHATGPT_SETTING_FAMILIES[V4]) && Object.isFrozen(CHATGPT_CONFIRMATION_SETTING) &&
      Object.isFrozen(CHATGPT_BENCHMARK_CANDIDATES) && CHATGPT_BENCHMARK_CANDIDATES.every((c) => Object.isFrozen(c) && Object.isFrozen(c.setting)) &&
      throws(() => { (CHATGPT_CONFIRMATION_SETTING as { maxOutputTokens: number }).maxOutputTokens = 32000; }) && CHATGPT_CONFIRMATION_SETTING.maxOutputTokens === 8000 &&
      throws(() => cast(CONFIRM_MODEL, "auto", "constructor")) && throws(() => cast(CONFIRM_MODEL, "auto", "openai-responses-websearch-v9")) &&
      throws(() => cast(CONFIRM_MODEL, "bogus", V3)) && throws(() => cast("", "auto", V3)) && throws(() => cast(" gpt ", "auto", V3)) && throws(() => cast(null, "auto", V3));
  })());
  check("V9 a version string names at most one setting, and it is read back exactly",
    JSON.stringify(chatGptSettingOfVersion(CHATGPT_CONFIRMATION_SETTING.version)) === JSON.stringify(CHATGPT_CONFIRMATION_SETTING) &&
    recordedVersions.every((v) => chatGptSettingOfVersion(v)?.version === v && chatGptSettingOfVersion(v)?.maxOutputTokens === 4000) &&
    chatGptSettingOfVersion(`${V3}:required:${CONFIRM_MODEL}`)?.search === "required" && chatGptSettingOfVersion(`${V3}:auto:a:b`)?.model === "a:b" &&
    [CONFIRM_MODEL, `${V3}:auto`, `${V3}:auto:`, `${V3}:bogus:x`, "openai-responses-websearch-v9:auto:x", "constructor:auto:x", `:auto:x`, `${V3}:auto: x`, "", null, undefined, 7].every((v) => chatGptSettingOfVersion(v) === null));
  const forged = { ...CHATGPT_CONFIRMATION_SETTING, maxOutputTokens: 16000 };
  const forgedWire: Wire[] = [];
  const forgedRun = await expectFailure(() => runChatGptProbe({ setting: forged, maxTokens: 16000, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), forgedWire) }));
  const relabelled = { ...AUTO, search: "required" as const, reasoningEffort: null, servedModelRule: "recorded_only" as const };
  const relabelledRun = await expectFailure(() => runChatGptProbe({ setting: relabelled, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), forgedWire) }));
  const extraField = await expectFailure(() => runChatGptProbe({ setting: { ...AUTO, temperature: 1 } as typeof AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), forgedWire) }));
  const searchClash = await expectFailure(() => runChatGptProbe({ setting: AUTO, search: "required", prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), forgedWire) }));
  check("V10 the adapter refuses a setting that is not what its version names, and a search mode that contradicts it, before any request",
    isCanonicalChatGptSetting(AUTO) && isCanonicalChatGptSetting(CHATGPT_CONFIRMATION_SETTING) && isCanonicalChatGptSetting({ ...AUTO }) &&
    !isCanonicalChatGptSetting(forged) && !isCanonicalChatGptSetting(relabelled) && !isCanonicalChatGptSetting({ ...AUTO, temperature: 1 }) && !isCanonicalChatGptSetting(null) && !isCanonicalChatGptSetting({}) &&
    !!forgedRun && /does not match its version/.test(forgedRun.message) && !!relabelledRun && /does not match its version/.test(relabelledRun.message) &&
    !!extraField && /does not match its version/.test(extraField.message) && !!searchClash && /search mode is fixed by the setting/.test(searchClash.message) && forgedWire.length === 0 &&
    (await runChatGptProbe({ setting: AUTO, search: "auto", prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), []) })).setting === AUTO);
  check("V7 a run-time maxTokens cannot change the cap the version names",
    !!capOverride && /fixed by the setting/.test(capOverride.message) && capWire.length === 0 && buildChatGptRequestBody.length === 2 &&
    sameCapWire.length === 1 && JSON.parse(String(sameCapWire[0].init.body)).max_output_tokens === 4000);
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
  const brokenBody = (status: number): typeof fetch =>
    (async () => new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset mid-body")); } }), { status, headers: { "x-request-id": "req_body" } })) as typeof fetch;
  for (const status of [200, 500]) {
    const e = await expectFailure(() => runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: brokenBody(status) }));
    const f = e instanceof ChatGptProbeFailure ? e : null;
    check(`F a body that fails to arrive after HTTP ${status} is a network_error with the request evidence, cost unknown`,
      !!f && f.reason === "network_error" && f.httpStatus === status && f.errorBody === null && f.providerRequestId === "req_body" &&
      f.fullRequestBodySha256 === sha256Hex(f.fullRequestBody) && f.rawProbeRequestSha256 === sha256Hex(QUESTION) && f.cost.usd === null && f.usage === null &&
      /reading the response body/.test(f.message), e?.message ?? "no failure");
  }

  /* M: mock ----------------------------------------------------------- */
  const mock = await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", mockResponse: { ...ok, fullRequestBody: "forged", fullRequestBodySha256: sha256Hex("forged") } });
  check("M1 a mock is marked and carries no outbound body", mock.usedMock === true && mock.fullRequestBody === undefined && mock.fullRequestBodySha256 === undefined);

  /* A: approval ------------------------------------------------------ */
  const CONFIRM_VERSION = "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05";
  check("A1 exactly the confirmed setting is approved (founder, 2026-11-17): auto search only, cap 8000, flex",
    CHATGPT_APPROVED_SETTING_VERSION === CONFIRM_VERSION && JSON.stringify(approvedChatGptSetting("auto")) === JSON.stringify(CHATGPT_CONFIRMATION_SETTING) &&
    approvedChatGptSetting("auto")?.maxOutputTokens === 8000 && approvedChatGptSetting("auto")?.serviceTier === "flex" && approvedChatGptSetting("required") === null);
  const refusedWire: Wire[] = [];
  const refused = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", search: "required", fetchImpl: fixtureFetch(200, responseBody(), refusedWire) }));
  check("A2 a run in a search mode with no approved setting is refused before any request", !!refused && /No ChatGPT setting is approved/.test(refused.message) && refusedWire.length === 0);
  const mockRefused = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", search: "required", mockResponse: ok }));
  check("A3 even a mock needs an approved setting", !!mockRefused);
  const approvedWire: Wire[] = [];
  const approvedRun = await runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ model: CONFIRM_MODEL, service_tier: "flex" }), approvedWire) });
  check("A13 a run with no explicit setting sends exactly the approved request: the pinned model, auto search, cap 8000, low effort, flex last", (() => {
    if (approvedWire.length !== 1 || !approvedRun) return false;
    const sent = String(approvedWire[0].init.body);
    const body = JSON.parse(sent);
    return sent === JSON.stringify(buildChatGptRequestBody(QUESTION, CHATGPT_CONFIRMATION_SETTING)) && body.model === CONFIRM_MODEL &&
      body.max_output_tokens === 8000 && body.service_tier === "flex" && Object.keys(body).pop() === "service_tier";
  })());
  check("A4 approving the confirmation setting's version yields exactly that setting (cap 8000, flex), never the 4000-cap one", (() => {
    const a = approvedChatGptSetting("auto", CONFIRM_VERSION);
    return !!a && CHATGPT_CONFIRMATION_SETTING.version === CONFIRM_VERSION && JSON.stringify(a) === JSON.stringify(CHATGPT_CONFIRMATION_SETTING) && a.maxOutputTokens === 8000 &&
      a.serviceTier === "flex" && a.servedModelRule === "exact_or_snapshot" && a.search === "auto" && a.version !== old54.version && isCanonicalChatGptSetting(a);
  })());
  check("A11 an approval is of one exact version: not a bare model name, not the other search mode, never a v2 setting, never the reference",
    approvedChatGptSetting("required", CONFIRM_VERSION) === null && approvedChatGptSetting("auto", CONFIRM_MODEL) === null && approvedChatGptSetting("auto", "") === null &&
    approvedChatGptSetting("auto", "openai-responses-websearch-v9:auto:gpt-5.4-2026-03-05") === null && approvedChatGptSetting("auto", `${V3}:auto:chat-latest`) === null &&
    recordedVersions.every((v) => approvedChatGptSetting("auto", v) === null && approvedChatGptSetting("required", v) === null) &&
    CHATGPT_SETTING_FAMILIES[V2].approvable === false && CHATGPT_SETTING_FAMILIES[V3].approvable === true && CHATGPT_SETTING_FAMILIES[V4].approvable === true);
  check("A12 the benchmark runs the setting awaiting approval, and an approval follows its version string, not that constant",
    CHATGPT_BENCHMARK_CANDIDATES.filter((c) => c.setting.model === CONFIRM_MODEL).length === 1 &&
    CHATGPT_BENCHMARK_CANDIDATES.find((c) => c.setting.model === CONFIRM_MODEL)?.setting === CHATGPT_CONFIRMATION_SETTING &&
    approvedChatGptSetting("auto", `${V3}:auto:gpt-5.5-2026-04-23`)?.model === "gpt-5.5-2026-04-23" &&
    approvedChatGptSetting("required", `${V3}:required:${CONFIRM_MODEL}`)?.search === "required" && approvedChatGptSetting("auto", `${V3}:required:${CONFIRM_MODEL}`) === null);
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
  check("P7 the price table is dated and sourced", OPENAI_PRICE_TABLE.recordedOn === "2026-11-17" && OPENAI_PRICE_TABLE.version === "openai-prices-2026-11-17" &&
    OPENAI_PRICE_TABLE.source.startsWith("https://developers.openai.com/") && OPENAI_PRICE_TABLE.webSearchPerCallUsd === 0.01);
  check("P16 the flex row is the chosen model's, at half the standard rates (cached input as published, $0.13)",
    JSON.stringify(OPENAI_PRICE_TABLE.flexModels) === JSON.stringify({ "gpt-5.4-2026-03-05": { input: 1.25, cachedInput: 0.13, output: 7.5 } }));
  check("P8 worst case exceeds a typical run", (worstCaseRunUsd(MODEL, 4000) as number) > (ok.cost.usd as number));
  check("P14 the chosen model's worst case is $0.48 at the 4000 cap and $0.54 at 8000", worstCaseRunUsd(CONFIRM_MODEL, 4000) === 0.48 && worstCaseRunUsd(CONFIRM_MODEL, 8000) === 0.54);
  check("P15 a worst case is null, never NaN, for a cap that is not a number or a model that is not priced",
    worstCaseRunUsd(CONFIRM_MODEL, undefined as unknown as number) === null && worstCaseRunUsd(CONFIRM_MODEL, Number.NaN) === null && worstCaseRunUsd(CONFIRM_MODEL, -1) === null &&
    worstCaseRunUsd("constructor", 4000) === null && estimateChatGptCostUsd("constructor", ok.usage).usd === null);
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
    return a.ok && a.args.questionSets.join() === "smaller-vendor" && a.args.repeatsByModel["chat-latest"] === 2 && a.args.repeatsByModel["gpt-5.5-2026-04-23"] === 1 &&
      !parseBenchmarkArgs(["--repeats-by-model=chat-latest:6"]).ok && !parseBenchmarkArgs(["--repeats-by-model=chat-latest"]).ok && !parseBenchmarkArgs(["--question-set=other"]).ok;
  })());
  check("K31 --question-set takes several sets, in order, each once; the default is general alone", (() => {
    const both = parseBenchmarkArgs(["--question-set=general,smaller-vendor"]);
    const none = parseBenchmarkArgs([]);
    return both.ok && both.args.questionSets.join() === "general,smaller-vendor" && none.ok && none.args.questionSets.join() === "general" &&
      !parseBenchmarkArgs(["--question-set=general,general"]).ok && !parseBenchmarkArgs(["--question-set=general,other"]).ok &&
      !parseBenchmarkArgs(["--question-set="]).ok && !parseBenchmarkArgs(["--question-set=constructor"]).ok;
  })());
  const lrec = (over: Partial<LedgerRecord>): LedgerRecord => ({ model: "gpt-6-luna", settingVersion: `${V2}:auto:gpt-6-luna`, cost: null, httpStatus: 200, responseBody: null, usage: null, ...over });
  const quota = JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } });
  const ledger = benchmarkSpendLedger([
    lrec({ cost: { usd: 1.5, basis: "estimated_from_usage", priceTable: "x" } }),
    lrec({ httpStatus: 429, responseBody: quota }),
    lrec({ httpStatus: 500, responseBody: "{}" }),
  ], () => 0.25, () => 4000);
  check("K27 the ledger counts estimates, $0 for credit refusals, worst case for other unknowns", !!ledger && ledger.estimatedUsd === 1.5 && ledger.refusedNotBilled === 1 && ledger.unknownCountedAtWorstCase === 1 && ledger.unsettledReservations === 0 && ledger.totalUsd === 1.75);
  const cutOff = (settingVersion: unknown) => lrec({ model: CONFIRM_MODEL, httpStatus: null, settingVersion: settingVersion as string });
  check("K32 an unknown-cost run is counted at the worst case of the cap it ran under: $0.48 at 4000, $0.54 at 8000", (() => {
    const l = benchmarkSpendLedger([cutOff(old54.version), cutOff(CHATGPT_CONFIRMATION_SETTING.version)], worstCaseRunUsd, maxOutputTokensOfSettingVersion);
    return !!l && l.unknownCountedAtWorstCase === 2 && l.totalUsd === 1.02;
  })());
  check("K33 the ledger refuses to count when it cannot tell the cap, but a known cost needs none",
    benchmarkSpendLedger([cutOff("openai-responses-websearch-v9:auto:gpt-5.4-2026-03-05")], worstCaseRunUsd, maxOutputTokensOfSettingVersion) === null &&
    benchmarkSpendLedger([cutOff(undefined)], worstCaseRunUsd, maxOutputTokensOfSettingVersion) === null &&
    benchmarkSpendLedger([lrec({ settingVersion: "unknown:auto:x", cost: { usd: 0.2, basis: "estimated_from_usage", priceTable: "x" } })], worstCaseRunUsd, maxOutputTokensOfSettingVersion)?.totalUsd === 0.2);
  const badCost = (usd: unknown) => lrec({ cost: { usd, basis: "estimated_from_usage", priceTable: "x" } as unknown as LedgerRecord["cost"] });
  check("K34 the ledger fails closed on any amount that is not a finite number of dollars: null, never NaN",
    [Number.NaN, Number.POSITIVE_INFINITY, -0.01, "0.2", undefined].every((usd) => benchmarkSpendLedger([badCost(usd)], worstCaseRunUsd, maxOutputTokensOfSettingVersion) === null) &&
    benchmarkSpendLedger([lrec({ httpStatus: 500 })], () => Number.NaN, () => 4000) === null &&
    benchmarkSpendLedger([lrec({ httpStatus: 500 })], worstCaseRunUsd, () => undefined as unknown as number) === null &&
    benchmarkSpendLedger([], worstCaseRunUsd, maxOutputTokensOfSettingVersion, [{ reservedWorstCaseUsd: Number.NaN }]) === null &&
    benchmarkSpendLedger([lrec({ httpStatus: 500, reservedWorstCaseUsd: Number.NaN })], worstCaseRunUsd, maxOutputTokensOfSettingVersion) === null);
  check("K35 a call reserved but never recorded is counted at its reservation, and an unknown-cost record at the amount reserved for it", (() => {
    const reservations = [{ index: 0, reservedWorstCaseUsd: 0.54 }, { index: 1, reservedWorstCaseUsd: 0.54 }, { index: 2, reservedWorstCaseUsd: 0.54 }];
    const pending = unsettledReservations(reservations, [{ index: 0 }, { index: 2 }]);
    const l = benchmarkSpendLedger([lrec({ cost: { usd: 0.1, basis: "estimated_from_usage", priceTable: "x" } }), lrec({ httpStatus: 500, reservedWorstCaseUsd: 0.31 })], worstCaseRunUsd, maxOutputTokensOfSettingVersion, pending);
    return pending.length === 1 && pending[0].index === 1 && unsettledReservations(reservations, []).length === 3 &&
      !!l && l.unsettledReservations === 1 && l.unknownCountedAtWorstCase === 1 && l.totalUsd === 0.95 && l.runs === 2;
  })());
  check("K36 the repository's recorded spend is a floor: a ledger holding less from that period cannot authorise a live run",
    BENCHMARK_SPEND_CHECKPOINT.runs === 297 && BENCHMARK_SPEND_CHECKPOINT.usd === 20.99554 && BENCHMARK_SPEND_CHECKPOINT.through === "2026-11-17T23:59:59.999Z" &&
    ledgerCoversCheckpoint({ runs: 297, totalUsd: 20.99554 }) && ledgerCoversCheckpoint({ runs: 300, totalUsd: 21 }) &&
    !ledgerCoversCheckpoint({ runs: 0, totalUsd: 0 }) && !ledgerCoversCheckpoint({ runs: 237, totalUsd: 15.351313 }) &&
    !ledgerCoversCheckpoint({ runs: 297, totalUsd: 9.4 }) && !ledgerCoversCheckpoint({ runs: 60, totalUsd: 20.99554 }) &&
    !ledgerCoversCheckpoint({ runs: 297, totalUsd: Number.NaN }) && !ledgerCoversCheckpoint(null));
  check("K49 later runs cannot stand in for missing earlier ones: only runs started up to the checkpoint count toward it",
    recordsThroughCheckpoint([{ startedAt: "2026-11-17T09:09:28.645Z" }, { startedAt: "2026-11-17T23:59:59.999Z" }, { startedAt: "2026-11-18T00:00:00.000Z" }, { startedAt: "2026-11-20T10:00:00.000Z" }, { startedAt: undefined }, {}]).length === 2 &&
    // Compared as instants: a timestamp without milliseconds or with an offset is read for what it is, and an unreadable one is left out.
    recordsThroughCheckpoint([{ startedAt: "2026-11-17T23:59:59Z" }, { startedAt: "2026-11-17T20:00:00+02:00" }]).length === 2 &&
    recordsThroughCheckpoint([{ startedAt: "2026-11-17T19:30:00-05:00" }, { startedAt: "not a time" }, { startedAt: "" }]).length === 0);
  check("K37 a cap is accepted only as a positive test: NaN, a missing amount or no remaining figure is a refusal",
    capFitsLifetime(12, 24.648687) && capFitsLifetime(24.648687, 24.648687) && !capFitsLifetime(24.65, 24.648687) && !capFitsLifetime(Number.NaN, 24) &&
    !capFitsLifetime(12, Number.NaN) && !capFitsLifetime(null, 24) && !capFitsLifetime(12, null) && !capFitsLifetime(0, 24) && !capFitsLifetime(-1, 24) && !capFitsLifetime(Number.POSITIVE_INFINITY, 24));
  check("K28 the ledger refuses an unpriced unknown, and the lifetime ceiling is $40 including earlier spend",
    benchmarkSpendLedger([lrec({ httpStatus: 500 })], () => null, () => 4000) === null && BENCHMARK_LIFETIME_CEILING_USD === 40 &&
    remainingLifetimeUsd({ totalUsd: 5.95 }) === 34.05 && remainingLifetimeUsd({ totalUsd: 15.351313 }) === 24.648687 && remainingLifetimeUsd({ totalUsd: 41 }) === 0);
  check("K4 dry run is the default", (() => { const a = parseBenchmarkArgs([]); return a.ok && !a.args.live; })());
  check("K5 live needs a cap", !parseBenchmarkArgs(["--live", "--i-confirm-founder-approved-budget"]).ok);
  check("K6 live needs the confirmation flag", !parseBenchmarkArgs(["--live", "--max-usd=10"]).ok);
  check("K7 the cap may not exceed the founder ceiling", BENCHMARK_HARD_CEILING_USD === 40 && !parseBenchmarkArgs(["--live", "--max-usd=40.01", "--i-confirm-founder-approved-budget"]).ok && parseBenchmarkArgs(["--live", "--max-usd=40", "--i-confirm-founder-approved-budget"]).ok);
  check("K8 repeats are bounded and unknown flags refused", !parseBenchmarkArgs(["--repeats=6"]).ok && !parseBenchmarkArgs(["--repeats=0"]).ok && !parseBenchmarkArgs(["--yes"]).ok);
  check("K38 a cap that is not a positive number is refused in a dry run too; empty values are not zero",
    !parseBenchmarkArgs(["--max-usd=abc"]).ok && !parseBenchmarkArgs(["--max-usd="]).ok && !parseBenchmarkArgs(["--max-usd=0"]).ok && !parseBenchmarkArgs(["--max-usd=-5"]).ok &&
    !parseBenchmarkArgs(["--max-usd=41"]).ok && parseBenchmarkArgs(["--max-usd=12"]).ok && !parseBenchmarkArgs(["--repeats="]).ok && !parseBenchmarkArgs(["--questions="]).ok &&
    !parseBenchmarkArgs(["--models="]).ok && !parseBenchmarkArgs(["--models=gpt-6-luna,gpt-6-luna"]).ok && !parseBenchmarkArgs(["--models=gpt-6-luna,,chat-latest"]).ok);
  check("K39 --resume names the stopped run's directory, --max-failed is a whole number, and --start-at is gone", (() => {
    const a = parseBenchmarkArgs(["--resume=.benchmark-out/confirm-1", "--max-failed=3"]);
    const none = parseBenchmarkArgs([]);
    return a.ok && a.args.resume === ".benchmark-out/confirm-1" && a.args.maxFailed === 3 && none.ok && none.args.resume === null && none.args.maxFailed === null &&
      !parseBenchmarkArgs(["--resume="]).ok && !parseBenchmarkArgs(["--resume"]).ok && !parseBenchmarkArgs(["--max-failed=-1"]).ok && !parseBenchmarkArgs(["--max-failed=1.5"]).ok &&
      !parseBenchmarkArgs(["--max-failed="]).ok && parseBenchmarkArgs(["--max-failed=0"]).ok && !parseBenchmarkArgs(["--start-at=5"]).ok;
  })());
  check("K51 the two switches that allow spending take no value: --live=false is refused, never read as --live",
    !parseBenchmarkArgs(["--live=false"]).ok && !parseBenchmarkArgs(["--live=", "--max-usd=12", "--i-confirm-founder-approved-budget"]).ok &&
    !parseBenchmarkArgs(["--live", "--max-usd=12", "--i-confirm-founder-approved-budget=no"]).ok &&
    parseBenchmarkArgs(["--live", "--max-usd=12", "--i-confirm-founder-approved-budget"]).ok);
  const budget = new BenchmarkBudget(1);
  check("K9 a run is refused when its worst case could pass the cap", budget.canStart(1) && !budget.canStart(1.01));
  budget.settle({ usd: null, basis: "unknown", reason: "usage_missing" }, 0.4);
  check("K10 an unknown cost settles at the worst case", budget.spentUsd === 0.4);
  check("K11 a run above its worst case is an overrun", budget.settle({ usd: 0.5, basis: "estimated_from_usage", priceTable: "x" }, 0.3).overrun && budget.spentUsd === 0.9);
  check("K12 a null cost (no call) settles at the worst case", (() => { const b = new BenchmarkBudget(5); b.settle(null, 0.2); return b.spentUsd === 0.2; })());
  check("K52 a resumed run's budget starts at what the phase already booked, so one cap covers every part", (() => {
    const b = new BenchmarkBudget(12, 11.6);
    const c = new BenchmarkBudget(12, 4);
    c.settle({ usd: 0.15, basis: "estimated_from_usage", priceTable: "x" }, 0.54);
    return !b.canStart(0.54) && b.spentUsd === 11.6 && b.partUsd === 0 && c.canStart(0.54) && c.spentUsd === 4.15 && c.partUsd === 0.15 && new BenchmarkBudget(12).spentUsd === 0;
  })());
  check("K58 a call refused for lack of credit books nothing against the cap, as the ledger counts it", (() => {
    const b = new BenchmarkBudget(12, 4);
    const r = b.settleNotBilled();
    return r.overrun === false && b.spentUsd === 4 && b.partUsd === 0 &&
      fs.readFileSync("scripts/benchmark-chatgpt-models.ts", "utf8").includes("const { overrun } = notBilled ? budget.settleNotBilled() : budget.settle(record.cost, worst);") &&
      fs.readFileSync("scripts/benchmark-chatgpt-models.ts", "utf8").includes("const notBilled = isNotBilledRefusal(record);");
  })());
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
  const capped = (repeat: number) => rec({ repeat, outcome: "failed", failure: "empty_answer:status:incomplete", incompleteReason: "max_output_tokens", latencyMs: 9000,
    usage: { ...ok.usage, outputTokens: 8000 }, cost: { usd: 0.2, basis: "estimated_from_usage", priceTable: "x" }, citations: [] });
  const sum2 = summariseBenchmark([
    rec({ cost: { usd: 0.1, basis: "estimated_from_usage", priceTable: "x" } }),
    capped(2),
    rec({ repeat: 3, outcome: "failed", failure: DEADLINE_FAILURE, latencyMs: 240000, usage: null, cost: { usd: null, basis: "unknown", reason: "usage_missing" }, citations: [] }),
    rec({ repeat: 4, outcome: "failed", failure: "empty_answer:status:incomplete", incompleteReason: "content_filter", usage: null, cost: null, citations: [] }),
  ])[0];
  check("K40 the summary says how close the output cap came: runs stopped at it, the provider's reasons, the largest output and the slowest call",
    sum2.stoppedAtOutputCap === 1 && JSON.stringify(sum2.incompleteReasons) === JSON.stringify({ max_output_tokens: 1, content_filter: 1 }) && sum2.maxOutputTokens === 8000 &&
    sum2.latencyMaxMs === 240000 && sum2.deadlineAborts === 1 && sum.stoppedAtOutputCap === 0 && sum.deadlineAborts === 0 && sum.maxOutputTokens === 900);
  check("K41 two cost figures, named for what they are: per billed attempt, and per usable answer (failed attempts included)",
    sum2.estimatedCostUsd === 0.3 && sum2.runsWithUnknownCost === 2 && sum2.meanCostPerBilledRunUsd === 0.15 && sum2.meanCostPerCompletedRunUsd === 0.3);
  check("K42 the provider's reason for stopping a run is read from the stored body",
    incompleteReasonOfBody(responseBody({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })) === "max_output_tokens" &&
    incompleteReasonOfBody(responseBody()) === null && incompleteReasonOfBody("not json") === null && incompleteReasonOfBody(null) === null && incompleteReasonOfBody("null") === null &&
    incompleteReasonOfBody(JSON.stringify({ incomplete_details: { reason: 7 } })) === null);
  const runnerSrc = fs.readFileSync("scripts/benchmark-chatgpt-models.ts", "utf8");
  check("K17 the runner reads the key only to check it is set (never prints or writes it)",
    (runnerSrc.match(/process\.env\.OPENAI_PROBE_API_KEY/g) ?? []).length === 1 && runnerSrc.includes("if (!process.env.OPENAI_PROBE_API_KEY)"));
  check("K18 the runner writes only under .benchmark-out (the spend ledger), by path and by real path, and never through a link",
    runnerSrc.includes('".benchmark-out"') && runnerSrc.includes('"--out");') && /must be under \.benchmark-out\/ \(git-ignored, and the lifetime spend ledger\)/.test(runnerSrc) &&
    runnerSrc.includes('if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(') &&
    runnerSrc.includes('if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new Error(') && /leads out of \.benchmark-out\/ through a symbolic link/.test(runnerSrc) &&
    runnerSrc.includes("if (e.isSymbolicLink()) throw new Error(") && /is a symbolic link; the ledger does not follow links/.test(runnerSrc));
  check("K57 a ledger line that is cut short or is not a JSON object is an error naming the file and line, never a skipped line", (() => {
    const refused = (text: string) => { try { parseLedgerLines(text, "x/runs.jsonl"); return ""; } catch (e) { return (e as Error).message; } };
    const good = parseLedgerLines('{"index":0}\n\n  \n{"index":1}\n', "x/runs.jsonl");
    return good.length === 2 && good[1].index === 1 && parseLedgerLines("", "x").length === 0 &&
      ["null", "7", "[]", '"text"', '{"index":0', "true"].every((line) => /^x\/runs\.jsonl line 2 is not a JSON object; the lifetime spend cannot be counted\.$/.test(refused(`{"index":0}\n${line}\n`))) &&
      runnerSrc.includes('return fs.existsSync(file) ? parseLedgerLines(fs.readFileSync(file, "utf8"), path.relative(REPO, file)) : [];');
  })());
  const keyCheckAt = runnerSrc.indexOf("process.env.OPENAI_PROBE_API_KEY");
  const RUN_FILE_NAMES = ["runs.jsonl", "reservations.jsonl", "summary.json", "plan.json"];
  check("K29 a live run is refused when its cap does not fit in what is left of the lifetime ceiling, before the key is looked at",
    /benchmarkSpendLedger\(earlier\.records, worstCaseRunUsd, maxOutputTokensOfSettingVersion, earlier\.unsettled\)/.test(runnerSrc) &&
    runnerSrc.includes("if (!capFitsLifetime(room, remaining)) fail(") && runnerSrc.indexOf("if (!capFitsLifetime(room, remaining)) fail(") < keyCheckAt &&
    runnerSrc.includes("const room = args.maxUsd === null ? null : Math.round((args.maxUsd - phaseSpentBeforeUsd) * 1e6) / 1e6;") &&
    runnerSrc.includes("if (!ledger) fail(") && runnerSrc.indexOf("if (!ledger) fail(") < keyCheckAt);
  check("K43 a live run is refused when the local ledger holds less than the repository records, before the key is looked at",
    runnerSrc.includes("const throughCheckpoint = benchmarkSpendLedger(recordsThroughCheckpoint(earlier.records), worstCaseRunUsd, maxOutputTokensOfSettingVersion);") &&
    runnerSrc.includes("const covered = ledgerCoversCheckpoint(throughCheckpoint);") && runnerSrc.includes("if (!covered) fail(") && runnerSrc.indexOf("if (!covered) fail(") < keyCheckAt &&
    runnerSrc.indexOf("if (!args.live) {") < runnerSrc.indexOf("if (!covered) fail("));
  check("K44 each call is reserved in writing before it is made, and a run directory is never reused",
    runnerSrc.includes("fs.appendFileSync(reservationsFile,") && runnerSrc.indexOf("fs.appendFileSync(reservationsFile,") < runnerSrc.indexOf("await runChatGptProbe(") &&
    runnerSrc.indexOf("await runChatGptProbe(") < runnerSrc.indexOf("fs.appendFileSync(runsFile,") && /--out already holds a benchmark run/.test(runnerSrc) &&
    runnerSrc.includes("unsettled.push(...unsettledReservations(run.reservations, run.records));") && RUN_FILE_NAMES.every((f) => runnerSrc.includes(`"${f}"`)));
  const idOf = { questions: "x1-benchmark-questions-v1+x1-smaller-vendor-questions-v1", questionIds: ["d1", "s1"], settingVersions: [CONFIRM_VERSION], repeats: 3, repeatsByModel: {}, planned: 60, maxFailed: 3 as number | null };
  const planOf = (over: Partial<BenchmarkPlanFile> = {}): BenchmarkPlanFile => ({ writtenAt: "2026-11-14T10:00:00.000Z", ...idOf, capUsd: 12, startIndex: 0, resumedFrom: null, phaseSpentBeforeUsd: 0, phaseFailedBefore: 0, ...over });
  type PartRecord = Pick<BenchmarkRecord, "index" | "outcome" | "httpStatus" | "responseBody" | "usage">;
  const done = (index: number): PartRecord => ({ index, outcome: "completed", httpStatus: 200, responseBody: null, usage: ok.usage });
  const failedAt = (index: number, httpStatus: number, responseBody: string | null = "{}"): PartRecord => ({ index, outcome: "failed", httpStatus, responseBody, usage: null });
  const cappedAt = (index: number): PartRecord => ({ index, outcome: "failed", httpStatus: 200, responseBody: null, usage: ok.usage });
  const first5 = [0, 1, 2, 3, 4].map(done);
  check("K45 a resumed run starts after the last index the stopped run reserved, and inherits what the phase booked", (() => {
    const plain = resumePoint({ plan: planOf(), records: first5, reservations: first5, bookedUsd: 0.7 }, idOf);
    const killedMidCall = resumePoint({ plan: planOf(), records: first5, reservations: [...first5, { index: 5 }], bookedUsd: 1.24 }, idOf);
    const secondPart = resumePoint({ plan: planOf({ startIndex: 5, resumedFrom: "confirm-1", phaseSpentBeforeUsd: 0.7 }), records: [5, 6, 7, 8, 9].map(done), reservations: [], bookedUsd: 0.6 }, idOf);
    const nothingRun = resumePoint({ plan: planOf({ startIndex: 5, phaseSpentBeforeUsd: 0.7 }), records: [], reservations: [], bookedUsd: 0 }, idOf);
    return plain.ok && plain.startIndex === 5 && plain.phaseSpentBeforeUsd === 0.7 && plain.earlierCapUsd === 12 && plain.phaseFailedBefore === 0 &&
      killedMidCall.ok && killedMidCall.startIndex === 6 && killedMidCall.phaseSpentBeforeUsd === 1.24 &&
      secondPart.ok && secondPart.startIndex === 10 && secondPart.phaseSpentBeforeUsd === 1.3 &&
      nothingRun.ok && nothingRun.startIndex === 5 && nothingRun.phaseSpentBeforeUsd === 0.7;
  })());
  check("K53 a call refused for lack of credit was never processed or billed, so a resumed run runs that one index again; no other failure is retried", (() => {
    const afterCredit = resumePoint({ plan: planOf(), records: [...first5, failedAt(5, 429, quota)], reservations: [...first5, { index: 5 }], bookedUsd: 0.7 }, idOf);
    const afterServerError = resumePoint({ plan: planOf(), records: [...first5, failedAt(5, 500)], reservations: [], bookedUsd: 1.24 }, idOf);
    const afterRateLimit = resumePoint({ plan: planOf(), records: [...first5, failedAt(5, 429, JSON.stringify({ error: { type: "requests" } }))], reservations: [], bookedUsd: 1.24 }, idOf);
    return afterCredit.ok && afterCredit.startIndex === 5 && afterCredit.phaseFailedBefore === 0 && afterServerError.ok && afterServerError.startIndex === 6 && afterServerError.phaseFailedBefore === 1 &&
      afterRateLimit.ok && afterRateLimit.startIndex === 6 && afterRateLimit.phaseFailedBefore === 1;
  })());
  check("K60 the failure count is the phase's: a resumed run inherits the failures of the parts before it, and a credit refusal is not one", (() => {
    const part1 = resumePoint({ plan: planOf(), records: [done(0), cappedAt(1), failedAt(2, 500), done(3), cappedAt(4), failedAt(5, 429, quota)], reservations: [], bookedUsd: 1.5 }, idOf);
    const part2 = resumePoint({ plan: planOf({ startIndex: 5, resumedFrom: "confirm-1", phaseSpentBeforeUsd: 1.5, phaseFailedBefore: 3 }), records: [done(5), cappedAt(6)], reservations: [], bookedUsd: 0.4 }, idOf);
    const seeded = { ...NO_RUNS, failed: part1.ok ? part1.phaseFailedBefore : -1 };
    const cappedRun = { ...cappedAt(6), cost: { usd: 0.2, basis: "estimated_from_usage" as const, priceTable: "x" } };
    const next = countRun(seeded, cappedRun);
    const refusal = countRun(next, { ...failedAt(7, 429, quota), cost: null });
    return part1.ok && part1.phaseFailedBefore === 3 && part1.startIndex === 5 && part2.ok && part2.phaseFailedBefore === 4 &&
      failedRuns([done(0), cappedAt(1), failedAt(2, 500), failedAt(3, 429, quota)]) === 2 &&
      next.failed === 4 && stopAfterRun(cappedRun, false, next, 3) === "failure_limit" && stopAfterRun(cappedRun, false, countRun(NO_RUNS, cappedRun), 3) === null &&
      JSON.stringify(refusal) === JSON.stringify(next) && isCreditRefusal(failedAt(7, 429, quota)) && !isCreditRefusal(failedAt(7, 429)) && !isCreditRefusal(cappedAt(1)) &&
      runnerSrc.includes("let counts = { ...NO_RUNS, failed: phaseFailedBefore };") &&
      runnerSrc.includes("const overFailureLimit = args.maxFailed !== null && phaseFailedBefore > args.maxFailed;") && runnerSrc.includes("if (overFailureLimit) fail(") &&
      runnerSrc.indexOf("if (overFailureLimit) fail(") < keyCheckAt;
  })());
  check("K61 a resumed run keeps the phase cap: a higher one needs its own switch, which takes no value",
    runnerSrc.includes("const raisesCap = earlierCapUsd !== null && args.maxUsd !== null && args.maxUsd > earlierCapUsd + 1e-9;") &&
    runnerSrc.includes("if (raisesCap && !args.higherCapConfirmed) fail(") && runnerSrc.indexOf("if (raisesCap && !args.higherCapConfirmed) fail(") < keyCheckAt &&
    (() => { const a = parseBenchmarkArgs(["--i-confirm-founder-approved-higher-cap"]); const none = parseBenchmarkArgs([]); return a.ok && a.args.higherCapConfirmed && none.ok && !none.args.higherCapConfirmed; })() &&
    !parseBenchmarkArgs(["--i-confirm-founder-approved-higher-cap=yes"]).ok);
  check("K54 a run is continued only by the same plan, and only when its own files say what it ran and spent", (() => {
    const refusedFor = (r: ReturnType<typeof resumePoint>) => (r.ok ? "" : r.error);
    const base = { plan: planOf(), records: first5, reservations: first5, bookedUsd: 0.7 };
    return /different plan/.test(refusedFor(resumePoint(base, { ...idOf, repeats: 2 }))) && /different plan/.test(refusedFor(resumePoint(base, { ...idOf, questionIds: ["d1"] }))) &&
      /different plan/.test(refusedFor(resumePoint(base, { ...idOf, settingVersions: [old54.version] }))) && /different plan/.test(refusedFor(resumePoint(base, { ...idOf, planned: 30 }))) &&
      /different plan/.test(refusedFor(resumePoint(base, { ...idOf, maxFailed: null }))) && /different plan/.test(refusedFor(resumePoint(base, { ...idOf, maxFailed: 5 }))) &&
      /no readable plan\.json/.test(refusedFor(resumePoint({ ...base, plan: { ...planOf(), phaseFailedBefore: undefined } }, idOf))) && /no readable plan\.json/.test(refusedFor(resumePoint({ ...base, plan: { ...planOf(), maxFailed: "3" } }, idOf))) &&
      /no readable plan\.json/.test(refusedFor(resumePoint({ ...base, plan: null }, idOf))) && /no readable plan\.json/.test(refusedFor(resumePoint({ ...base, plan: { ...planOf(), capUsd: "12" } }, idOf))) &&
      /cannot be counted/.test(refusedFor(resumePoint({ ...base, bookedUsd: null }, idOf))) && /cannot be counted/.test(refusedFor(resumePoint({ ...base, bookedUsd: Number.NaN }, idOf))) &&
      /nothing left/.test(refusedFor(resumePoint({ ...base, records: [done(59)] }, idOf))) && /outside its own plan/.test(refusedFor(resumePoint({ ...base, records: [done(60)] }, idOf))) &&
      /outside its own plan/.test(refusedFor(resumePoint({ plan: planOf({ startIndex: 5 }), records: [done(2)], reservations: [], bookedUsd: 0.1 }, idOf))) &&
      planIdentityKey({ ...idOf, repeatsByModel: { a: 1, b: 2 } }) === planIdentityKey({ ...idOf, repeatsByModel: { b: 2, a: 1 } }) && planIdentityKey(idOf) !== planIdentityKey({ ...idOf, repeatsByModel: { a: 1 } });
  })());
  check("K55 the runner reads a resume from the stopped run's files, writes its own plan before any call, and refuses a run that was already continued",
    runnerSrc.includes("const plan = fullPlan.slice(startIndex);") && runnerSrc.includes("const budget = new BenchmarkBudget(args.maxUsd as number, phaseSpentBeforeUsd);") &&
    runnerSrc.includes('fs.writeFileSync(path.join(out, "plan.json")') && runnerSrc.indexOf('fs.writeFileSync(path.join(out, "plan.json")') < runnerSrc.indexOf("fs.appendFileSync(reservationsFile,") &&
    runnerSrc.includes("const continuedBy = earlier.continued.find((c) => c.resumedFrom === resumedFrom);") && runnerSrc.includes("if (continuedBy) fail(`--resume: that run was already continued by") &&
    runnerSrc.includes('const dir = insideLedger(args.resume, "--resume");') && runnerSrc.includes("if (!capFitsLifetime(room, remaining)) fail("));
  check("K59 no run directory is created for a run that could not make a single call",
    runnerSrc.includes("if (plan.length === 0 || (room as number) < firstWorst) fail(") &&
    runnerSrc.indexOf("if (plan.length === 0 || (room as number) < firstWorst) fail(") < runnerSrc.indexOf("const out = outputDir(args.out);") &&
    runnerSrc.indexOf("const out = outputDir(args.out);") < runnerSrc.indexOf("fs.mkdirSync(out, { recursive: true });"));
  check("K50 one live run at a time: an exclusive lock is taken before the ledger is read, and is never taken over",
    runnerSrc.includes('fd = fs.openSync(LOCK_FILE, "wx");') && runnerSrc.includes("if (args.live) acquireLiveLock(") &&
    runnerSrc.indexOf("if (args.live) acquireLiveLock(") < runnerSrc.indexOf("const earlier = readLedger();") &&
    (runnerSrc.match(/unlinkSync\(LOCK_FILE\)/g) ?? []).length === 1 && runnerSrc.indexOf("unlinkSync(LOCK_FILE)") > runnerSrc.indexOf("const release = () => {"));
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

  /* C: the confirmation run -------------------------------------------- */
  const generalSet = { name: "general", ...(JSON.parse(fs.readFileSync(BENCHMARK_QUESTION_SETS.general, "utf8")) as { version: string; questions: BenchmarkQuestion[] }) };
  const svSet = { name: "smaller-vendor", ...(sv as { version: string; questions: BenchmarkQuestion[] }) };
  const bothSets = mergeQuestionSets([generalSet, svSet]);
  const confirmation = planBenchmark(bothSets?.questions ?? [], CHATGPT_BENCHMARK_CANDIDATES.filter((c) => [CONFIRM_MODEL].includes(c.setting.model)), 3);
  check("C1 both question sets merge into 20 questions with distinct ids, each knowing its set; a shared id is refused",
    !!bothSets && bothSets.version === "x1-benchmark-questions-v1+x1-smaller-vendor-questions-v1" && bothSets.questions.length === 20 &&
    new Set(bothSets.questions.map((q) => q.id)).size === 20 && bothSets.setOfQuestion.get("d1") === "general" && bothSets.setOfQuestion.get("s10") === "smaller-vendor" &&
    bothSets.setOfQuestion.size === 20 && mergeQuestionSets([generalSet, { ...generalSet, name: "again" }]) === null);
  check("C2 --questions keeps the first n of each set, not of the merged list", (() => {
    const m = mergeQuestionSets([generalSet, svSet], 2);
    return !!m && m.questions.map((q) => q.id).join() === "d1,d2,s1,s2" && mergeQuestionSets([generalSet], 99)?.questions.length === 10;
  })());
  check("C3 the confirmation plan is 20 questions × 3 repeats = 60 runs of the confirmation setting only",
    confirmation.length === 60 && confirmation.length <= BENCHMARK_MAX_RUNS && confirmation.every((p) => p.setting === CHATGPT_CONFIRMATION_SETTING && p.role === "candidate") &&
    (bothSets?.questions ?? []).every((q) => confirmation.filter((p) => p.question.id === q.id).map((p) => p.repeat).join() === "1,2,3") &&
    confirmation.every((p, i) => p.index === i) && JSON.parse(JSON.stringify(buildChatGptRequestBody(confirmation[0].question.text, confirmation[0].setting))).max_output_tokens === 8000);
  const used = (outputTokens: number | null): ChatGptUsage => ({ inputTokens: 20000, cachedInputTokens: 0, outputTokens, reasoningTokens: null, totalTokens: null, webSearchCalls: 4, searchActions: 4, searchOccurred: true, serviceTier: null });
  const earlierRuns = [
    { model: CONFIRM_MODEL, settingVersion: old54.version, questionId: "s1", usage: used(2000) }, // $0.05 input + $0.03 output + $0.04 search = $0.12
    { model: CONFIRM_MODEL, settingVersion: old54.version, questionId: "s2", usage: used(4000) }, // stopped at 4000: $0.15 as recorded, $0.21 at 8000
    { model: CONFIRM_MODEL, settingVersion: old54.version, questionId: "s3", usage: null },
    { model: CONFIRM_MODEL, settingVersion: old54.version, questionId: "s4", usage: used(null) },
    { model: "gpt-6-luna", settingVersion: `${V2}:auto:gpt-6-luna`, questionId: "d1", usage: used(4000) },
  ];
  const projectedFrom = recordedRunCost(earlierRuns, CHATGPT_CONFIRMATION_SETTING, estimateChatGptCostUsd, maxOutputTokensOfSettingVersion);
  const asRecorded = recordedRunCost(earlierRuns, old54, estimateChatGptCostUsd, maxOutputTokensOfSettingVersion);
  check("C4 the projection prices the model's recorded runs again, a run that stopped at a lower cap counted at the planned cap, and states its basis",
    !!projectedFrom && projectedFrom.runs === 2 && projectedFrom.meanUsd === 0.165 && projectedFrom.maxUsd === 0.21 && projectedFrom.raisedToCap === 1 &&
    projectedFrom.settingVersions.join() === old54.version && projectedFrom.questionIds.join() === "s1,s2" &&
    !!asRecorded && asRecorded.meanUsd === 0.135 && asRecorded.raisedToCap === 0 &&
    recordedRunCost(earlierRuns, { model: "gpt-5.5-2026-04-23", maxOutputTokens: 8000 }, estimateChatGptCostUsd, maxOutputTokensOfSettingVersion) === null);
  check("C5 a dry run projects from recorded runs where there are any and never below the fixed assumption, which understates the chosen model",
    (typicalRunUsd(CONFIRM_MODEL) as number) < (projectedFrom?.meanUsd ?? 0) &&
    JSON.stringify(projectedRunUsd(projectedFrom, typicalRunUsd(CONFIRM_MODEL))) === JSON.stringify({ usd: 0.165, basis: "recorded_mean" }) &&
    JSON.stringify(projectedRunUsd({ meanUsd: 0.01 }, 0.0676)) === JSON.stringify({ usd: 0.0676, basis: "typical_assumption_floor" }) &&
    JSON.stringify(projectedRunUsd(null, 0.0676)) === JSON.stringify({ usd: 0.0676, basis: "typical_assumption_only" }) && projectedRunUsd(null, null).usd === null &&
    /projectedRunUsd\(recorded, typicalRunUsd\(s\.model\)\)/.test(runnerSrc));
  check("C6 how many runs a cap lets start: one more than fit below cap minus the worst case",
    runsCapAllows(12, 0.54, 0.1451) === 79 && runsCapAllows(12, 0.54, 0.2365) === 49 && runsCapAllows(1, 0.54, 0.46) === 2 && runsCapAllows(0.5, 0.54, 0.1) === 0 &&
    runsCapAllows(12, 0.54, 0) === null && runsCapAllows(Number.NaN, 0.54, 0.1) === null);
  check("C7 the per-call deadline follows the output cap: 120 s at 4000, 240 s at 8000, never past Node's own 300 s; on the flex tier it is that 290 s maximum",
    callDeadlineMs(4000) === 120_000 && callDeadlineMs(8000) === 240_000 && callDeadlineMs(100) === 120_000 && callDeadlineMs(50_000) === 290_000 &&
    callDeadlineMs(8000, null) === 240_000 && callDeadlineMs(8000, "flex") === 290_000 && callDeadlineMs(4000, "flex") === 290_000 && FLEX_CALL_DEADLINE_MS === 290_000 &&
    runnerSrc.includes("const deadlineMs = callDeadlineMs(run.setting.maxOutputTokens, run.setting.serviceTier);") && runnerSrc.includes("const deadline = callDeadline(deadlineMs);") && !/CALL_DEADLINE_MS/.test(runnerSrc));
  check("C8 an over-limit plan is printed by a dry run and refused for a live run before anything is spent",
    runnerSrc.includes("if (overRunLimit && args.live) fail(") && runnerSrc.indexOf("if (overRunLimit && args.live) fail(") < keyCheckAt &&
    planBenchmark(generalSet.questions, CHATGPT_BENCHMARK_CANDIDATES, 5).length === 250 && BENCHMARK_MAX_RUNS === 150);
  const one = { consecutiveUnknownCost: 1, unknownCost: 1, failed: 1 };
  check("K23 a credit-exhausted 429 stops the benchmark; a rate-limit 429 does not",
    isQuotaExhausted(429, JSON.stringify({ error: { type: "insufficient_quota", code: "credit_balance_exhausted" } })) &&
    !isQuotaExhausted(429, JSON.stringify({ error: { type: "requests", code: "rate_limit_exceeded" } })) &&
    !isQuotaExhausted(500, JSON.stringify({ error: { type: "insufficient_quota" } })) && !isQuotaExhausted(429, "not json") &&
    stopAfterRun({ httpStatus: 429, responseBody: quota }, false, one) === "provider_quota_exhausted" &&
    stopAfterRun({ httpStatus: 429, responseBody: JSON.stringify({ error: { type: "requests", code: "rate_limit_exceeded" } }) }, false, one) === null &&
    runnerSrc.includes("const stop = stopAfterRun(record, overrun, counts, args.maxFailed);") && runnerSrc.includes("counts = countRun(counts, record);"));
  check("K46 a rejected request (400, 401, 403, 404) stops the benchmark at once; a 429 or 5xx does not",
    [400, 401, 403, 404].every(isRequestRejected) && ![429, 500, 503, 200, null].some(isRequestRejected) &&
    [400, 401, 403, 404].every((status) => stopAfterRun({ httpStatus: status, responseBody: "{}" }, false, one) === "request_rejected") &&
    stopAfterRun({ httpStatus: 500, responseBody: "{}" }, false, one) === null);
  type CountedRun = Pick<BenchmarkRecord, "cost" | "outcome" | "usage" | "httpStatus" | "responseBody">;
  const unknownRun: CountedRun = { cost: null, outcome: "failed", usage: null, httpStatus: 500, responseBody: "{}" };
  const knownOk: CountedRun = { cost: { usd: 0.1, basis: "estimated_from_usage", priceTable: "x" }, outcome: "completed", usage: ok.usage, httpStatus: 200, responseBody: null };
  const knownFailed: CountedRun = { ...knownOk, outcome: "failed" };
  const after = (...runs: CountedRun[]) => runs.reduce(countRun, NO_RUNS);
  check("K47 runs of unknown cost stop the benchmark: two in a row, or three in all even when successes come between",
    MAX_CONSECUTIVE_UNKNOWN_COST === 2 && MAX_UNKNOWN_COST_RUNS === 3 && stopAfterRun({ httpStatus: null, responseBody: null }, false, after(unknownRun)) === null &&
    stopAfterRun({ httpStatus: null, responseBody: null }, false, after(unknownRun, unknownRun)) === "repeated_unknown_cost" &&
    stopAfterRun({ httpStatus: null, responseBody: null }, false, after(unknownRun, knownOk, unknownRun)) === null &&
    stopAfterRun({ httpStatus: null, responseBody: null }, false, after(unknownRun, knownOk, unknownRun, knownOk, unknownRun)) === "unknown_cost_limit" &&
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownOk)) === null && stopAfterRun({ httpStatus: 200, responseBody: null }, true, after(knownOk)) === "worst_case_exceeded" &&
    JSON.stringify(after(unknownRun, knownOk, knownFailed)) === JSON.stringify({ consecutiveUnknownCost: 0, unknownCost: 1, failed: 2 }) && Object.isFrozen(NO_RUNS) &&
    hasUnknownCost({ cost: null }) && hasUnknownCost({ cost: { usd: null, basis: "unknown", reason: "usage_missing" } }) && !hasUnknownCost({ cost: { usd: 0, basis: "estimated_from_usage", priceTable: "x" } }));
  check("K56 --max-failed stops a run whose answers keep failing at a known cost (cut off at the cap, say); without it there is no such stop",
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownFailed, knownFailed, knownFailed), 3) === null &&
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownFailed, knownFailed, knownFailed, knownFailed), 3) === "failure_limit" &&
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownFailed), 0) === "failure_limit" &&
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownFailed, knownFailed, knownFailed, knownFailed)) === null &&
    stopAfterRun({ httpStatus: 200, responseBody: null }, false, after(knownOk, knownOk, knownOk, knownOk), 3) === null);
  check("K48 a call the runner's own deadline cut off is labelled apart from other network errors, and the deadline covers the whole call",
    DEADLINE_FAILURE === "network_error:deadline" && runnerSrc.includes('f.reason === "network_error" && deadline.timedOut() ? DEADLINE_FAILURE') &&
    /finally \{\s*deadline\.dispose\(\);/.test(runnerSrc));
  check("K22 the benchmark is not a test:* command (CI never runs it)", !/"test:[^"]*": "[^"]*benchmark-chatgpt/.test(fs.readFileSync("package.json", "utf8")));

  /* X: the flex tier (founder, 2026-11-17) ------------------------------ */
  const flexReq = JSON.stringify(buildChatGptRequestBody(QUESTION, CHATGPT_CONFIRMATION_SETTING));
  const v3Req = JSON.stringify(buildChatGptRequestBody(QUESTION, v3For54));
  check("X1 v4 asks for the flex tier, last in the body; v2 and v3 send no tier, so their recorded bytes are unchanged",
    CHATGPT_CONFIRMATION_SETTING.serviceTier === "flex" && v3For54.serviceTier === null && old54.serviceTier === null &&
    JSON.parse(flexReq).service_tier === "flex" && Object.keys(JSON.parse(flexReq)).pop() === "service_tier" &&
    !("service_tier" in JSON.parse(v3Req)) && !("service_tier" in buildChatGptRequestBody("q", old54)) &&
    CHATGPT_BENCHMARK_CANDIDATES.slice(0, 4).every((c) => c.setting.serviceTier === null && !("service_tier" in buildChatGptRequestBody("q", c.setting))));
  const flexWire: Wire[] = [];
  const servedFlex = responseBody({ model: CONFIRM_MODEL, service_tier: "flex" });
  const servedDefault = responseBody({ model: CONFIRM_MODEL, service_tier: "default" });
  const flexOk = await runChatGptProbe({ setting: CHATGPT_CONFIRMATION_SETTING, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, servedFlex, flexWire) });
  // The fixture's usage: 12000 input (2000 cached), 900 output, one search call.
  const flexUpper = Math.round(((10000 * 2.5 + 2000 * 0.25 + 900 * 7.5) / 1e6 + 0.01) * 1e6) / 1e6;
  const flexLower = Math.round(((10000 * 1.25 + 2000 * 0.13 + 900 * 7.5) / 1e6 + 0.01) * 1e6) / 1e6;
  const standard54 = Math.round(((10000 * 2.5 + 2000 * 0.25 + 900 * 15) / 1e6 + 0.01) * 1e6) / 1e6;
  check("X2 an answer flex served succeeds; the tier is kept with the usage; the cost counted is an upper bound (output at the flex rate, input at standard)",
    JSON.parse(String(flexWire[0]?.init.body ?? "{}")).service_tier === "flex" && flexOk.usage.serviceTier === "flex" && flexOk.cost.usd === flexUpper &&
    flexAllTokensCostUsd(CONFIRM_MODEL, flexOk.usage) === flexLower && flexLower < flexUpper && flexUpper < standard54 &&
    estimateChatGptCostUsd(CONFIRM_MODEL, { ...flexOk.usage, serviceTier: "default" }).usd === standard54 &&
    estimateChatGptCostUsd(CONFIRM_MODEL, { ...flexOk.usage, serviceTier: null }).usd === standard54 &&
    estimateChatGptCostUsd(MODEL, { ...ok.usage, serviceTier: "flex" }).usd === ok.cost.usd && flexAllTokensCostUsd(MODEL, { ...ok.usage, serviceTier: "flex" }) === null &&
    flexAllTokensCostUsd(CONFIRM_MODEL, { ...flexOk.usage, serviceTier: "default" }) === null && flexAllTokensCostUsd(CONFIRM_MODEL, { ...flexOk.usage, inputTokens: null }) === null &&
    chatGptUsageFromBody(JSON.parse(servedFlex)).serviceTier === "flex" && chatGptUsageFromBody({ service_tier: 7 }).serviceTier === null && chatGptUsageFromBody(null).serviceTier === null);
  const offTier = await expectFailure(() => runChatGptProbe({ setting: CHATGPT_CONFIRMATION_SETTING, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, servedDefault, []) }));
  const noTier = await expectFailure(() => runChatGptProbe({ setting: CHATGPT_CONFIRMATION_SETTING, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ model: CONFIRM_MODEL }), []) }));
  check("X3 an answer another tier served, or one naming no tier, is a failure with its body, usage and a cost at the standard rate; a setting with no tier checks none",
    offTier instanceof ChatGptProbeFailure && /unexpected_service_tier:default/.test(offTier.message) && offTier.errorBody === servedDefault && offTier.usage?.serviceTier === "default" &&
    offTier.cost.usd === standard54 && noTier instanceof ChatGptProbeFailure && /unexpected_service_tier:none/.test(noTier.message) && noTier.cost.usd === standard54 &&
    (await runChatGptProbe({ setting: AUTO, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ service_tier: "default" }), []) })).usage.serviceTier === "default" &&
    (await runChatGptProbe({ setting: v3For54, prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, servedFlex, []) })).setting === v3For54);
  const unavailable = JSON.stringify({ error: { message: "Resource unavailable. Please retry your request later.", type: "server_error", code: null } });
  const unavailableCode = JSON.stringify({ error: { message: "x", type: "x", code: "resource_unavailable" } });
  const rateLimit = JSON.stringify({ error: { message: "Rate limit reached for gpt-5.4 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.", type: "tokens", code: "rate_limit_exceeded" } });
  const busyRec = (over: Partial<Pick<BenchmarkRecord, "httpStatus" | "responseBody" | "usage" | "requestBody">> = {}) => ({ httpStatus: 429 as number | null, responseBody: unavailable as string | null, usage: null as ChatGptUsage | null, requestBody: flexReq as string | null, ...over });
  check("X4 a flex capacity refusal is a 429 'Resource Unavailable' to a flex request with no usage; a rate limit, a credit refusal, a non-flex request or another status is not",
    isFlexBusyRefusal(busyRec()) && isFlexBusyRefusal(busyRec({ responseBody: unavailableCode })) && isNotBilledRefusal(busyRec()) &&
    isFlexResourceUnavailable(429, JSON.stringify({ error: { message: "RESOURCE-UNAVAILABLE" } })) && !isFlexResourceUnavailable(500, unavailable) && !isFlexResourceUnavailable(429, "not json") && !isFlexResourceUnavailable(429, null) &&
    !isFlexBusyRefusal(busyRec({ responseBody: rateLimit })) && !isNotBilledRefusal(busyRec({ responseBody: rateLimit })) &&
    !isFlexBusyRefusal(busyRec({ responseBody: quota })) && isNotBilledRefusal(busyRec({ responseBody: quota })) &&
    !isFlexBusyRefusal(busyRec({ requestBody: v3Req })) && !isFlexBusyRefusal(busyRec({ requestBody: null })) && !isFlexBusyRefusal({ httpStatus: 429, responseBody: unavailable, usage: null }) &&
    !isFlexBusyRefusal(busyRec({ httpStatus: 503 })) && !isFlexBusyRefusal(busyRec({ usage: ok.usage })) &&
    wasFlexRequest({ requestBody: flexReq }) && !wasFlexRequest({ requestBody: v3Req }) && !wasFlexRequest({ requestBody: "not json" }) && !wasFlexRequest({ requestBody: "null" }) && !wasFlexRequest({}));
  const flexLedger = (over: Partial<LedgerRecord>) => lrec({ model: CONFIRM_MODEL, settingVersion: CHATGPT_CONFIRMATION_SETTING.version, httpStatus: 429, requestBody: flexReq, ...over });
  const busyBooked = benchmarkSpendLedger([flexLedger({ responseBody: unavailable }), flexLedger({ responseBody: rateLimit })], worstCaseRunUsd, maxOutputTokensOfSettingVersion);
  check("X5 a flex capacity refusal books nothing and is no failed run; a rate limit to the same request keeps the unknown-cost rule (worst case)",
    !!busyBooked && busyBooked.refusedNotBilled === 1 && busyBooked.unknownCountedAtWorstCase === 1 && busyBooked.totalUsd === 0.54 &&
    JSON.stringify(countRun(NO_RUNS, { ...busyRec(), cost: null, outcome: "failed" })) === JSON.stringify(NO_RUNS) &&
    JSON.stringify(countRun(NO_RUNS, { ...busyRec({ responseBody: rateLimit }), cost: null, outcome: "failed" })) === JSON.stringify({ consecutiveUnknownCost: 1, unknownCost: 1, failed: 1 }) &&
    failedRuns([{ ...busyRec(), outcome: "failed" }, { ...busyRec({ responseBody: rateLimit }), outcome: "failed" }]) === 1);
  const busyAt = (index: number) => ({ index, outcome: "failed" as const, ...busyRec() });
  check("X6 reservations are settled by count per index, so a call made again after a refusal is still accounted for; a resume repeats a trailing refusal only when nothing is open after it",
    unsettledReservations([{ index: 5 }, { index: 5 }, { index: 5 }], [busyAt(5), busyAt(5), done(5)]).length === 0 &&
    unsettledReservations([{ index: 5 }, { index: 5 }], [busyAt(5)]).length === 1 && unsettledReservations([{ index: 4 }, { index: 5 }, { index: 5 }], [done(4), busyAt(5)])[0]?.index === 5 &&
    (() => {
      const stoppedBusy = resumePoint({ plan: planOf(), records: [...first5, busyAt(5), busyAt(5)], reservations: [...first5, { index: 5 }, { index: 5 }], bookedUsd: 0.7 }, idOf);
      const killedMidRetry = resumePoint({ plan: planOf(), records: [...first5, busyAt(5)], reservations: [...first5, { index: 5 }, { index: 5 }], bookedUsd: 1.24 }, idOf);
      const busyThenDone = resumePoint({ plan: planOf(), records: [...first5, busyAt(5), done(5)], reservations: [...first5, { index: 5 }, { index: 5 }], bookedUsd: 0.85 }, idOf);
      return stoppedBusy.ok && stoppedBusy.startIndex === 5 && stoppedBusy.phaseFailedBefore === 0 && killedMidRetry.ok && killedMidRetry.startIndex === 6 &&
        busyThenDone.ok && busyThenDone.startIndex === 6 && busyThenDone.phaseFailedBefore === 0;
    })());
  check("X7 a flex request whose response says another tier (or none) served it stops the run at once, whatever the adapter made of the answer",
    stopAfterRun({ httpStatus: 200, responseBody: servedDefault, requestBody: flexReq }, false, NO_RUNS) === "service_tier_mismatch" &&
    stopAfterRun({ httpStatus: 200, responseBody: responseBody({ model: CONFIRM_MODEL, status: "incomplete" }), requestBody: flexReq }, false, NO_RUNS) === "service_tier_mismatch" &&
    stopAfterRun({ httpStatus: 200, responseBody: servedFlex, requestBody: flexReq }, false, NO_RUNS) === null &&
    stopAfterRun({ httpStatus: 200, responseBody: servedDefault, requestBody: v3Req }, false, NO_RUNS) === null &&
    stopAfterRun({ httpStatus: 200, responseBody: servedDefault }, false, NO_RUNS) === null &&
    stopAfterRun({ httpStatus: 429, responseBody: unavailable, requestBody: flexReq }, false, NO_RUNS) === null &&
    stopAfterRun({ httpStatus: 200, responseBody: servedDefault, requestBody: flexReq }, true, NO_RUNS) === "worst_case_exceeded" &&
    servedOffRequestedTier({ requestBody: flexReq, responseBody: "not json" }) === false && servedOffRequestedTier({ requestBody: flexReq, responseBody: null }) === false &&
    servedTierOfBody(servedFlex) === "flex" && servedTierOfBody(responseBody()) === "none" && servedTierOfBody(unavailable) === null && servedTierOfBody(null) === null);
  check("X8 waits after a capacity refusal: 30 s doubling, five per index, an hour per invocation",
    JSON.stringify(FLEX_BUSY_BACKOFF_MS) === JSON.stringify([30_000, 60_000, 120_000, 240_000, 480_000]) && Object.isFrozen(FLEX_BUSY_BACKOFF_MS) &&
    flexBusyWaitMs(0, 0) === 30_000 && flexBusyWaitMs(4, 0) === 480_000 && flexBusyWaitMs(5, 0) === null && flexBusyWaitMs(0, 3_570_000) === 30_000 &&
    flexBusyWaitMs(0, 3_570_001) === null && flexBusyWaitMs(-1, 0) === null && flexBusyWaitMs(1.5, 0) === null && flexBusyWaitMs(0, Number.NaN) === null &&
    FLEX_BUSY_MAX_WAIT_PER_INVOCATION_MS === 3_600_000);
  const flexRec = (over: Partial<BenchmarkRecord>) => rec({ model: CONFIRM_MODEL, settingVersion: CHATGPT_CONFIRMATION_SETTING.version, servedModel: CONFIRM_MODEL, requestBody: flexReq, responseBody: servedFlex, ...over });
  const sumFlex = summariseBenchmark([
    flexRec({}),
    flexRec({ outcome: "failed", failure: FLEX_BUSY_FAILURE, httpStatus: 429, responseBody: unavailable, usage: null, cost: null, latencyMs: 300_000, citations: [] }),
    flexRec({ outcome: "failed", failure: "empty_answer:unexpected_service_tier:default", responseBody: servedDefault, citations: [] }),
  ])[0];
  check("X9 the summary leaves refusals OpenAI did not bill out of every figure, counts them apart, and shows the tier each processed answer names",
    sumFlex.runs === 2 && sumFlex.refusedNotBilled === 1 && sumFlex.failed === 1 && sumFlex.completed === 1 && sumFlex.latencyMaxMs === 1000 &&
    JSON.stringify(sumFlex.servedServiceTiers) === JSON.stringify({ flex: 1, default: 1 }) && sumFlex.runsWithUnknownCost === 0 &&
    summariseBenchmark([flexRec({ outcome: "failed", failure: FLEX_BUSY_FAILURE, httpStatus: 429, responseBody: unavailable, usage: null, cost: null })])[0].runs === 0);
  check("X10 the runner books a capacity refusal at nothing, records it, waits and makes the same index again; it resumes at that index; the deadline follows the tier",
    runnerSrc.includes("const busy = isFlexBusyRefusal(record);") && runnerSrc.includes("const wait = flexBusyWaitMs(busyRetries, busyWaitedMs);") &&
    runnerSrc.includes("i -= 1; // the same plan index again") && runnerSrc.indexOf("fs.appendFileSync(runsFile,") < runnerSrc.indexOf("i -= 1; // the same plan index again") &&
    runnerSrc.indexOf("fs.appendFileSync(reservationsFile,") < runnerSrc.indexOf("const busy = isFlexBusyRefusal(record);") &&
    runnerSrc.indexOf("budget.settleNotBilled();") > runnerSrc.indexOf("if (busy) {") && runnerSrc.includes('stopReason = "provider_busy";') &&
    runnerSrc.includes('stopReason === "provider_quota_exhausted" || stopReason === "provider_busy" ? lastIndex : lastIndex + 1') &&
    runnerSrc.includes("callDeadlineMs(c.setting.maxOutputTokens, c.setting.serviceTier)"));

  /* W: worker --------------------------------------------------------- */
  const runner = async () => ok;
  const route = probeRunnerForProtocol({ runProbe: runner, runAgentProbe: runner }, { provider: CHATGPT_PROVIDER, modelConfig: { model: MODEL } });
  // D-056 — the worker knows the provider now, and refuses it before admission unless the engine is enabled.
  check("W1 the worker refuses an openai_chatgpt protocol when the engine is not enabled", !route.ok && route.detail === "PROVIDER_ADAPTER_NOT_ENABLED");
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
  // D-056 — exactly one worker module imports the adapter, and only the worker entry point loads it, dynamically.
  check("B2 under lib/ only lib/protocol-worker/chatgpt-engine.ts imports the adapter",
    libImporters.length === 1 && libImporters[0] === path.join("lib", "protocol-worker", "chatgpt-engine.ts"), libImporters.join(", "));
  const engineImporters = [...importers("lib"), ...importers("app"), ...importers("scripts").filter((p) => !/test-/.test(p))]
    .filter((p) => /protocol-worker\/chatgpt-engine"/.test(fs.readFileSync(p, "utf8")));
  check("B6 only scripts/run-protocol-worker.ts loads the engine, and only by a dynamic import",
    (() => {
      const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return all(p);
        return /\.(ts|tsx)$/.test(e.name) && /protocol-worker\/chatgpt-engine"/.test(fs.readFileSync(p, "utf8")) ? [p] : [];
      });
      const users = [...all("lib"), ...all("app"), ...all("scripts").filter((p) => !path.basename(p).startsWith("test-"))];
      const entry = fs.readFileSync("scripts/run-protocol-worker.ts", "utf8");
      return users.length === 1 && users[0] === path.join("scripts", "run-protocol-worker.ts") &&
        /cfg\.chatgpt\.enabled \? import\("@\/lib\/protocol-worker\/chatgpt-engine"\) : Promise\.resolve\(null\)/.test(entry) &&
        !/^import [^\n]*chatgpt-engine/m.test(entry);
    })(), engineImporters.join(", "));
  const pricingSrc = fs.readFileSync("lib/probes/chatgpt-pricing.ts", "utf8");
  check("B4 the pricing module cannot make a call", !/fetch\(|process\.env|from "@\/lib\/probes\/chatgpt"/.test(pricingSrc));
  const scriptImporters = importers("scripts").map((p) => p.replace(/\\/g, "/")).sort();
  // D-061 — the phase B schema test reads the adapter's approved setting constants, to prove
  // add_pilot_question_engine's SQL literals equal them (B-overview item 6); it makes no call.
  check("B5 only the benchmark and the three ChatGPT tests import the adapter under scripts/",
    JSON.stringify(scriptImporters) === JSON.stringify([
      "scripts/benchmark-chatgpt-models.ts", "scripts/lib/chatgpt-benchmark.ts", "scripts/test-chatgpt-adapter.ts",
      "scripts/test-chatgpt-phase-b-schema.ts", "scripts/test-chatgpt-worker.ts",
    ]), scriptImporters.join(", "));
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
  check("N the note names every setting family and the price table", Object.keys(CHATGPT_SETTING_FAMILIES).every((f) => note.includes(f)) && note.includes(OPENAI_PRICE_TABLE.version));
  check("N the note records the founder's choice, the confirmation setting, and its approval for measurement on 2026-11-17, and says it is not wired",
    note.includes(CHATGPT_CONFIRMATION_SETTING.version) && note.includes("2026-11-13") && /Approved for measurement by the founder on 2026-11-17/.test(note) &&
    /not wired into any worker/.test(note) && note.includes("CHATGPT_APPROVED_SETTING_VERSION") &&
    !note.includes("CHATGPT_APPROVED_MODEL") && CHATGPT_APPROVED_SETTING_VERSION === CHATGPT_CONFIRMATION_SETTING.version);
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
