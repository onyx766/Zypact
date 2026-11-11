/**
 * X1 (D-050) — the "ChatGPT" engine adapter: OpenAI's Responses API with its
 * web search tool, POST /v1/responses.
 *
 * What this measures is the OpenAI developer API under a fixed, recorded
 * configuration. It is NOT the ChatGPT consumer app: the app adds its own
 * system instructions, memory, personalisation, account region and model
 * routing, none of which the API reproduces. The adapter-validity note,
 * docs/ADAPTER_VALIDITY_CHATGPT.md, says what may and may not be claimed.
 *
 * Same contract as the Perplexity adapters: the same input, the same
 * `PerplexityProbeResult`, and failures as `PerplexityProbeFailure` with the
 * same three reasons 0037 allows, so the worker can record all of them the
 * same way. (The type names predate a second provider; the evidence
 * contract is provider-neutral.)
 *
 *   request   { model, input, tools: [{ type: "web_search" }], tool_choice,
 *               include: ["web_search_call.action.sources"], reasoning,
 *               max_output_tokens, store: false }
 *   response  { id: "resp_…", object: "response", status, model, error,
 *               output: [ { type: "web_search_call", action: { sources } },
 *                         { type: "message", content: [ { type:
 *                           "output_text", text, annotations: [
 *                           { type: "url_citation", url, title, … } ] } ] } ],
 *               usage }
 *
 * Fixed configuration, never chosen at run time: a `ChatGptSetting` names
 * the model, the search mode and every request parameter, and its `version`
 * names all of them. Founder decisions (2026-11-10, D-050):
 *   - no model is approved until the benchmark (scripts/benchmark-chatgpt-
 *     models.ts) reports results and cost and the founder approves one, so
 *     CHATGPT_APPROVED_MODEL is null and a run without an explicit setting
 *     is refused before any call;
 *   - the main monitoring protocol uses automatic search, and whether search
 *     happened is recorded on every run; search-required is a separate
 *     setting, never mixed with automatic results;
 *   - token usage and web search calls are kept on every run, and cost is
 *     estimated from them (lib/probes/chatgpt-pricing.ts), unknown if it
 *     cannot be, never 0.
 * No instructions are sent: the buyer question goes exactly as approved, with
 * no brand, domain or project context, as with Sonar. `store: false` asks
 * OpenAI not to keep the response for later retrieval; Zypact keeps its own
 * copy as evidence.
 *
 * Evidence, as with Sonar: the exact serialized request and its SHA-256; the
 * exact response text and its SHA-256, captured before parsing; HTTP status,
 * latency and provider request id. A response that is not JSON, not a
 * Responses object, not `status: "completed"`, carries an error, has no id,
 * an unexpected served model, or no output text is a failure carrying all of
 * that evidence — never a partially-filled success.
 *
 * Cited is not retrieved (D-044). `citations` are only the URLs the answer
 * marks with a `url_citation` annotation, in first-cited order.
 * `searchResults` are every source the search step returned plus every cited
 * URL (OpenAI can cite a URL its sources list omits; that URL was still
 * retrieved). A retrieved-only URL is never turned into a citation.
 *
 * Not wired into any worker. No web entry point may import this module
 * (scripts/test-paid-execution-guards.ts). It reads its own key,
 * OPENAI_PROBE_API_KEY, so the analysis key already in the environment can
 * never switch measurement on by being present.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import { OPENAI_RESPONSES_ENDPOINT } from "@/lib/probes/endpoints";
import { chatGptUsageFromBody, estimateChatGptCostUsd, type ChatGptUsage, type CostEstimate } from "@/lib/probes/chatgpt-pricing";
import {
  PerplexityProbeFailure,
  buildUserPrompt,
  normalizeUrl,
  sourceCitationsFromPerplexity,
  uniqueStrings,
  type PerplexityProbeResult,
  type PerplexitySearchResult,
  type RunPerplexityProbeInput,
} from "@/lib/probes/perplexity";

/** The protocol provider value for this engine. */
export const CHATGPT_PROVIDER = "openai_chatgpt";

/** The setting family. Any change to request shape or rules is a new family. */
export const CHATGPT_SETTING_FAMILY = "openai-responses-websearch-v2";

export type ChatGptSearchMode = "auto" | "required";

export interface ChatGptSetting {
  /** `${family}:${search}:${model}` — names every choice below. */
  version: string;
  model: string;
  search: ChatGptSearchMode;
  /** null sends no `reasoning` field (a model that does not take one). */
  reasoningEffort: "low" | null;
  /** Output tokens include reasoning tokens, hence a larger cap than Sonar's 1200. */
  maxOutputTokens: number;
  /**
   * exact_or_snapshot: the served model must be the requested name or a dated
   * snapshot of it, or the run fails. recorded_only: the served model is
   * recorded but not checked — allowed for a benchmark reference model only,
   * never for an approved measurement.
   */
  servedModelRule: "exact_or_snapshot" | "recorded_only";
}

export const CHATGPT_MAX_OUTPUT_TOKENS = 4000;

export function chatGptSetting(
  model: string,
  search: ChatGptSearchMode,
  opts: { reasoningEffort?: "low" | null; servedModelRule?: ChatGptSetting["servedModelRule"] } = {}
): ChatGptSetting {
  return {
    version: `${CHATGPT_SETTING_FAMILY}:${search}:${model}`,
    model,
    search,
    reasoningEffort: opts.reasoningEffort === undefined ? "low" : opts.reasoningEffort,
    maxOutputTokens: CHATGPT_MAX_OUTPUT_TOKENS,
    servedModelRule: opts.servedModelRule ?? "exact_or_snapshot",
  };
}

/**
 * Models the benchmark compares (founder, 2026-11-10: a currently supported,
 * cost-efficient model with web search; chat-latest as a reference only,
 * never assumed to reproduce ChatGPT.com). chat-latest takes no reasoning
 * field and its served name is recorded, not checked.
 */
/**
 * How fixed a model ID is, from OpenAI's model pages (read 2026-11-11):
 * - dated_snapshot: a date-stamped snapshot ID; the strongest pin OpenAI offers.
 * - undated_id: the ID is listed as its own default snapshot and OpenAI does
 *   not say it changes, but there is no dated ID, so a silent change cannot
 *   be ruled out from the documentation.
 * - moving_alias: OpenAI says the underlying snapshot is regularly updated.
 */
export type ModelPinning = "dated_snapshot" | "undated_id" | "moving_alias";

export const CHATGPT_BENCHMARK_CANDIDATES: ReadonlyArray<{ role: "candidate" | "reference"; pinning: ModelPinning; setting: ChatGptSetting }> = [
  { role: "candidate", pinning: "undated_id", setting: chatGptSetting("gpt-6-luna", "auto") },
  { role: "candidate", pinning: "undated_id", setting: chatGptSetting("gpt-6.1-terra", "auto") },
  { role: "reference", pinning: "moving_alias", setting: chatGptSetting("chat-latest", "auto", { reasoningEffort: null, servedModelRule: "recorded_only" }) },
  { role: "candidate", pinning: "dated_snapshot", setting: chatGptSetting("gpt-5.5-2026-04-23", "auto") },
  { role: "candidate", pinning: "dated_snapshot", setting: chatGptSetting("gpt-5.4-2026-03-05", "auto") },
];

/** No model is approved yet. Setting one is a founder decision and a code change. */
export const CHATGPT_APPROVED_MODEL: string | null = null;

/** The approved setting for a search mode, or null while no model is approved. */
export function approvedChatGptSetting(search: ChatGptSearchMode, approvedModel: string | null = CHATGPT_APPROVED_MODEL): ChatGptSetting | null {
  if (approvedModel === null) return null;
  const s = chatGptSetting(approvedModel, search);
  return s.servedModelRule === "exact_or_snapshot" ? s : null;
}

/** The requested model or a dated snapshot of it (`gpt-6-luna-2026-05-18`). */
export function isServedModelOf(requested: string, served: string): boolean {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return served === requested || new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}$`).test(served);
}

export function buildChatGptRequestBody(prompt: string, setting: ChatGptSetting, maxTokens?: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: setting.model,
    input: prompt,
    tools: [{ type: "web_search" }],
    tool_choice: setting.search === "required" ? "required" : "auto",
    include: ["web_search_call.action.sources"],
  };
  if (setting.reasoningEffort !== null) body.reasoning = { effort: setting.reasoningEffort };
  body.max_output_tokens = maxTokens ?? setting.maxOutputTokens;
  body.store = false;
  return body;
}

/** The adapter's result: the shared probe result plus the run's usage, cost and setting. */
export interface ChatGptProbeResult extends PerplexityProbeResult {
  setting: ChatGptSetting;
  usage: ChatGptUsage;
  cost: CostEstimate;
}

/**
 * A failure with whatever usage the 2xx body reported, so a billed-but-
 * unusable run still counts toward spend.
 */
export class ChatGptProbeFailure extends PerplexityProbeFailure {
  readonly usage: ChatGptUsage | null;
  readonly cost: CostEstimate;
  constructor(message: string, fields: ConstructorParameters<typeof PerplexityProbeFailure>[1], usage: ChatGptUsage | null, cost: CostEstimate) {
    super(message, fields);
    this.name = "ChatGptProbeFailure";
    this.usage = usage;
    this.cost = cost;
  }
}

interface OutputItem {
  type?: unknown;
  content?: unknown;
  action?: unknown;
}

type Annotation = { type?: unknown; url?: unknown; title?: unknown };

function textParts(output: unknown): Array<{ text: string; annotations: Annotation[] }> {
  if (!Array.isArray(output)) return [];
  const parts: Array<{ text: string; annotations: Annotation[] }> = [];
  for (const item of output as OutputItem[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content as Array<{ type?: unknown; text?: unknown; annotations?: unknown }>) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        parts.push({ text: c.text, annotations: Array.isArray(c.annotations) ? (c.annotations as Annotation[]) : [] });
      }
    }
  }
  return parts;
}

/** Concatenated `output_text` of every `message` item, untrimmed; "" when there is none. */
export function chatGptOutputText(output: unknown): string {
  return textParts(output).map((p) => p.text).join("");
}

/** URLs of `url_citation` annotations, in order, normalised and de-duplicated. */
export function chatGptCitedUrls(output: unknown): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];
  for (const part of textParts(output)) {
    for (const a of part.annotations) {
      if (a?.type !== "url_citation" || typeof a.url !== "string") continue;
      const url = normalizeUrl(a.url);
      if (!url || seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      out.push({ url, title: typeof a.title === "string" ? a.title : undefined });
    }
  }
  return out;
}

/** Every `web_search_call` source URL, normalised and de-duplicated. */
export function chatGptSearchSources(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const urls: string[] = [];
  for (const item of output as OutputItem[]) {
    if (item?.type !== "web_search_call" || !item.action || typeof item.action !== "object") continue;
    const sources = (item.action as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const s of sources as Array<{ url?: unknown }>) {
      if (typeof s?.url === "string") urls.push(normalizeUrl(s.url));
    }
  }
  return uniqueStrings(urls);
}

/** The analysis transcript: answer, then cited, then retrieved sources. */
function buildChatGptTranscript(answer: string, cited: Array<{ url: string; title?: string }>, retrieved: string[]): string {
  const lines: string[] = [answer.trim()];
  if (cited.length > 0) {
    lines.push("", "ChatGPT (OpenAI API) cited sources:");
    for (const c of cited) lines.push(`- ${c.title?.trim() ? `${c.title.trim()} — ` : ""}${c.url}`);
  }
  if (retrieved.length > 0) {
    lines.push("", "ChatGPT (OpenAI API) retrieved sources:");
    for (const url of retrieved) lines.push(`- ${url}`);
  }
  return lines.join("\n").trim();
}

export interface RunChatGptProbeInput extends RunPerplexityProbeInput {
  /** The measurement setting. Omitted → the approved setting for `search` (default "auto"). */
  setting?: ChatGptSetting;
  search?: ChatGptSearchMode;
}

export async function runChatGptProbe(input: RunChatGptProbeInput): Promise<ChatGptProbeResult> {
  const setting = input.setting ?? approvedChatGptSetting(input.search ?? "auto");
  // Refused before any key is read or any request is built: nothing is spent.
  if (!setting) throw new Error("No ChatGPT model is approved; pass an explicit benchmark setting.");

  if (input.mockResponse) {
    return {
      ...input.mockResponse,
      rawProbeRequest: input.mockResponse.rawProbeRequest || buildUserPrompt(input),
      // A mock never reaches a provider, so it has no outbound body.
      fullRequestBody: undefined,
      fullRequestBodySha256: undefined,
      usedMock: true,
      setting,
      usage: chatGptUsageFromBody(null),
      cost: { usd: null, basis: "unknown", reason: "usage_missing" },
    };
  }

  const apiKey = process.env.OPENAI_PROBE_API_KEY;
  if (!apiKey) throw new Error("OPENAI_PROBE_API_KEY is required for live ChatGPT probes.");

  const fetcher = input.fetchImpl ?? fetch;
  const rawProbeRequest = buildUserPrompt(input);
  // Serialized once: the bytes sent and the bytes hashed are the same string.
  const requestBodyJson = JSON.stringify(buildChatGptRequestBody(rawProbeRequest, setting, input.maxTokens));
  const rawProbeRequestSha256 = sha256Hex(rawProbeRequest);
  const fullRequestBodySha256 = sha256Hex(requestBodyJson);
  const evidence = { rawProbeRequestSha256, fullRequestBody: requestBodyJson, fullRequestBodySha256 };
  const unknownCost: CostEstimate = { usd: null, basis: "unknown", reason: "usage_missing" };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetcher(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: requestBodyJson,
    });
  } catch (networkErr) {
    throw new ChatGptProbeFailure(
      `OpenAI Responses API network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      { reason: "network_error", httpStatus: null, errorBody: null, errorBodySha256: null,
        latencyMs: Date.now() - startedAt, providerRequestId: null, ...evidence },
      null, unknownCost
    );
  }

  const latencyMs = Date.now() - startedAt;
  const providerRequestId = res.headers.get("x-request-id") ?? null;

  if (!res.ok) {
    const err = await res.text();
    throw new ChatGptProbeFailure(`OpenAI Responses API ${res.status}: ${err.slice(0, 500)}`, {
      reason: "http_error", httpStatus: res.status, errorBody: err, errorBodySha256: sha256Hex(err),
      latencyMs, providerRequestId, ...evidence,
    }, null, unknownCost);
  }

  const rawResponseBody = await res.text();
  const rawResponseBodySha256 = sha256Hex(rawResponseBody);
  let json: unknown;
  let parsedOk = true;
  try {
    json = JSON.parse(rawResponseBody);
  } catch {
    parsedOk = false;
  }
  // Usage is read from whatever the body reported, success or not, so a
  // billed-but-unusable run still counts toward spend.
  const usage = parsedOk ? chatGptUsageFromBody(json) : null;
  const cost = usage ? estimateChatGptCostUsd(setting.model, usage) : unknownCost;
  const unusable = (cause: string) =>
    new ChatGptProbeFailure(`OpenAI Responses API returned an unusable 2xx response (${cause}).`, {
      reason: "empty_answer", httpStatus: res.status, errorBody: rawResponseBody,
      errorBodySha256: rawResponseBodySha256, latencyMs, providerRequestId, ...evidence,
    }, usage, cost);

  if (!parsedOk) throw unusable("invalid_json");
  if (!json || typeof json !== "object" || Array.isArray(json)) throw unusable("not_an_object");
  const body = json as Record<string, unknown>;
  if (body.object !== "response") throw unusable(`unexpected_object:${String(body.object)}`);
  if (body.error !== undefined && body.error !== null) throw unusable("error_present");
  if (body.status !== "completed") throw unusable(`status:${String(body.status)}`);
  if (typeof body.id !== "string" || body.id.trim() === "") throw unusable("missing_id");
  if (typeof body.model !== "string" || body.model.trim() === "") throw unusable("missing_served_model");
  if (setting.servedModelRule === "exact_or_snapshot" && !isServedModelOf(setting.model, body.model)) {
    throw unusable(`unexpected_served_model:${body.model}`);
  }
  // Search-required: a run in which the model did not search is not a
  // measurement under that setting.
  if (setting.search === "required" && !usage?.searchOccurred) throw unusable("search_required_not_performed");

  const answer = chatGptOutputText(body.output).trim();
  if (!answer) throw unusable("empty_output_text");

  const cited = chatGptCitedUrls(body.output);
  const retrieved = uniqueStrings([...chatGptSearchSources(body.output), ...cited.map((c) => c.url)]);
  const titles = new Map(cited.map((c) => [c.url.toLowerCase(), c.title]));
  const searchResults: PerplexitySearchResult[] = retrieved.map((url) => {
    const title = titles.get(url.toLowerCase());
    return title ? { url, title } : { url };
  });
  const citations = cited.map((c) => c.url);
  const sourceCitations = sourceCitationsFromPerplexity(citations, []);
  const rawResponse = buildChatGptTranscript(answer, cited, retrieved);

  return {
    prompt: input.prompt,
    answer,
    rawResponse,
    rawProbeRequest,
    citations,
    searchResults,
    sourceCitations,
    model: body.model,
    usedMock: false,
    rawResponseSha256: sha256Hex(rawResponse),
    rawResponseBody,
    rawResponseBodySha256,
    rawProbeRequestSha256,
    fullRequestBody: requestBodyJson,
    fullRequestBodySha256,
    httpStatus: res.status,
    latencyMs,
    providerRequestId,
    setting,
    usage: usage ?? chatGptUsageFromBody(null),
    cost,
  };
}
