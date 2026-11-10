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
  CHATGPT_MEASUREMENT_SETTING,
  CHATGPT_MODEL,
  CHATGPT_PROVIDER,
  buildChatGptRequestBody,
  chatGptCitedUrls,
  chatGptOutputText,
  chatGptSearchCount,
  chatGptSearchSources,
  isApprovedServedModel,
  runChatGptProbe,
} from "@/lib/probes/chatgpt";
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
const SERVED = `${CHATGPT_MODEL}-2025-08-07`;

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
    usage: { input_tokens: 20, output_tokens: 300, total_tokens: 320 },
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
  const ok = await runChatGptProbe({ prompt: `  ${QUESTION}  `, brandName: "Acme Compliance", domain: "acme.example", fetchImpl: fixtureFetch(200, responseBody(), wire) });
  const sent = String(wire[0]?.init.body ?? "");
  const parsed = JSON.parse(sent || "{}") as Record<string, unknown>;
  check("Q1 one POST to the Responses endpoint", wire.length === 1 && wire[0].url === OPENAI_RESPONSES_ENDPOINT && wire[0].init.method === "POST");
  check("Q2 the endpoint is OpenAI's /v1/responses", OPENAI_RESPONSES_ENDPOINT === "https://api.openai.com/v1/responses");
  check("Q3 the input is the buyer question exactly, trimmed", parsed.input === QUESTION);
  check("Q4 no brand, domain or instructions are sent", !/acme/i.test(sent) && !("instructions" in parsed) && !("previous_response_id" in parsed));
  check("Q5 the body is the fixed setting", sent === JSON.stringify(buildChatGptRequestBody(QUESTION)));
  check("Q6 web search tool, auto choice, sources included, store:false",
    JSON.stringify(parsed.tools) === '[{"type":"web_search"}]' && parsed.tool_choice === "auto" &&
    JSON.stringify(parsed.include) === '["web_search_call.action.sources"]' && parsed.store === false);
  check("Q7 no temperature and no fallback model list", !("temperature" in parsed) && !("models" in parsed));
  check("Q8 the setting is versioned", CHATGPT_MEASUREMENT_SETTING.version === "openai-responses-websearch-v1" && parsed.model === CHATGPT_MODEL);
  check("Q9 the bearer key is OPENAI_PROBE_API_KEY", (wire[0].init.headers as Record<string, string>).authorization === "Bearer test-key-not-real");
  check("Q10 the hashed body is the sent body", ok.fullRequestBody === sent && ok.fullRequestBodySha256 === sha256Hex(sent));
  check("Q11 the prompt hash is of the trimmed question", ok.rawProbeRequestSha256 === sha256Hex(QUESTION) && ok.rawProbeRequest === QUESTION);

  delete process.env.OPENAI_PROBE_API_KEY;
  const prevAnalysis = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "analysis-key";
  const noKeyWire: Wire[] = [];
  const noKey = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody(), noKeyWire) }));
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
  const noSearch = await runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({}, [
    { type: "message", content: [{ type: "output_text", text: "An answer from model knowledge.", annotations: [] }] },
  ]), []) });
  check("S11 an answer with no search and no citations is an observation", noSearch.answer.length > 0 && noSearch.citations.length === 0 && noSearch.searchResults.length === 0);
  check("S12 the bare model name is accepted as served", (await runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, responseBody({ model: CHATGPT_MODEL }), []) })).model === CHATGPT_MODEL);

  /* H: helpers -------------------------------------------------------- */
  const out = JSON.parse(raw).output;
  check("H1 output text joins every output_text part", chatGptOutputText([{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "refusal", refusal: "x" }, { type: "output_text", text: "b" }] }]) === "ab");
  check("H2 sources come from web_search_call items only", JSON.stringify(chatGptSearchSources(out)) === JSON.stringify(["https://vendor-a.example/soc2", "https://www.g2.com/categories/soc-2", "https://retrieved-only.example/page"]));
  check("H3 search count", chatGptSearchCount(out) === 1 && chatGptSearchCount(null) === 0);
  check("H4 cited URLs ignore non-url annotations", chatGptCitedUrls([{ type: "message", content: [{ type: "output_text", text: "x", annotations: [{ type: "file_citation", file_id: "f" }, { type: "url_citation", url: "https://a.example/)" }] }] }]).map((c) => c.url).join() === "https://a.example/");
  check("H5 served-model rule: exact or dated snapshot only",
    isApprovedServedModel(CHATGPT_MODEL) && isApprovedServedModel(`${CHATGPT_MODEL}-2026-01-31`) &&
    !isApprovedServedModel(`${CHATGPT_MODEL}-pro`) && !isApprovedServedModel("gpt-5") && !isApprovedServedModel(`${CHATGPT_MODEL}-2026-01-31-x`));

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
    ["another model served", responseBody({ model: "gpt-4o-2024-08-06" }), /unexpected_served_model/],
    ["empty output text", responseBody({}, [{ type: "message", content: [{ type: "output_text", text: "   ", annotations: [] }] }]), /empty_output_text/],
    ["a refusal only", responseBody({}, [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]), /empty_output_text/],
  ];
  for (const [label, body, cause] of unusableCases) {
    const w: Wire[] = [];
    const e = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(200, body, w) }));
    const f = e instanceof PerplexityProbeFailure ? e : null;
    check(`F ${label} fails with the whole body as evidence`,
      !!f && cause.test(f.message) && f.reason === "empty_answer" && f.httpStatus === 200 && f.errorBody === body &&
      f.errorBodySha256 === sha256Hex(body) && f.fullRequestBody === String(w[0]?.init.body) && f.fullRequestBodySha256 === sha256Hex(f.fullRequestBody) &&
      f.providerRequestId === "req_abc", e?.message ?? "no failure");
  }
  for (const status of [400, 401, 429, 500]) {
    const errBody = JSON.stringify({ error: { message: "nope", type: "x" } });
    const e = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: fixtureFetch(status, errBody, []) }));
    const f = e instanceof PerplexityProbeFailure ? e : null;
    check(`F HTTP ${status} is http_error with the body`, !!f && f.reason === "http_error" && f.httpStatus === status && f.errorBody === errBody && f.errorBodySha256 === sha256Hex(errBody));
  }
  const net = await expectFailure(() => runChatGptProbe({ prompt: QUESTION, brandName: "A", fetchImpl: (async () => { throw new Error("aborted"); }) as typeof fetch }));
  check("F a network error or timeout is network_error with the request", net instanceof PerplexityProbeFailure && net.reason === "network_error" && net.httpStatus === null && net.fullRequestBodySha256 === sha256Hex(net.fullRequestBody));
  check("F the failure message never echoes the key", !/test-key-not-real/.test(String(net?.message)));

  /* M: mock ----------------------------------------------------------- */
  const mock = await runChatGptProbe({ prompt: QUESTION, brandName: "A", mockResponse: { ...ok, fullRequestBody: "forged", fullRequestBodySha256: sha256Hex("forged") } });
  check("M1 a mock is marked and carries no outbound body", mock.usedMock === true && mock.fullRequestBody === undefined && mock.fullRequestBodySha256 === undefined);

  /* W: worker --------------------------------------------------------- */
  const runner = async () => ok;
  const route = probeRunnerForProtocol({ runProbe: runner, runAgentProbe: runner }, { provider: CHATGPT_PROVIDER, modelConfig: { model: CHATGPT_MODEL } });
  check("W1 the worker refuses an openai_chatgpt protocol (not wired)", !route.ok && route.detail === "UNKNOWN_PROVIDER");
  check("W2 a stored ChatGPT body is not replayed as an answer", answerFromRawResponseBody(raw) === null);
  check("W3 the worker does not import the adapter", !/probes\/chatgpt/.test(fs.readFileSync("lib/protocol-worker/worker.ts", "utf8")));

  /* B: boundary ------------------------------------------------------- */
  const importers = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return importers(p);
      return /\.(ts|tsx)$/.test(e.name) && /@\/lib\/probes\/chatgpt|probes\/chatgpt"/.test(fs.readFileSync(p, "utf8")) ? [p] : [];
    });
  check("B1 nothing under app/ imports the adapter", importers("app").length === 0, importers("app").join(", "));
  const libImporters = importers("lib").filter((p) => p !== path.join("lib", "probes", "chatgpt.ts"));
  check("B2 nothing else under lib/ imports the adapter yet", libImporters.length === 0, libImporters.join(", "));
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
  check("N the note names the pinned setting version", note.includes(CHATGPT_MEASUREMENT_SETTING.version));
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
