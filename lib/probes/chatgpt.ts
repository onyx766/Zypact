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
 *               max_output_tokens, store: false[, service_tier: "flex"] }
 *   response  { id: "resp_…", object: "response", status, model, error, service_tier,
 *               output: [ { type: "web_search_call", action: { sources } },
 *                         { type: "message", content: [ { type:
 *                           "output_text", text, annotations: [
 *                           { type: "url_citation", url, title, … } ] } ] } ],
 *               usage }
 *
 * Fixed configuration, never chosen at run time: a `ChatGptSetting` names
 * the model, the search mode and every request parameter, and its `version`
 * (`<family>:<search>:<model>`) names all of them: a setting is a function
 * of those three and of nothing else. Settings are frozen, and the adapter
 * refuses a setting object that is not what its own version names, so one
 * version cannot name two different requests. Founder decisions
 * (2026-11-10, D-050):
 *   - no model is approved until the benchmark (scripts/benchmark-chatgpt-
 *     models.ts) reports results and cost and the founder approves one. On
 *     2026-11-13 the founder chose gpt-5.4-2026-03-05; on 2026-11-17 it was
 *     confirmed on OpenAI's half-price flex tier (CHATGPT_CONFIRMATION_SETTING:
 *     raised output cap, flex; all seven criteria passed) and the founder
 *     approved that exact version, which CHATGPT_APPROVED_SETTING_VERSION now
 *     names. A run in a search mode with no approved setting is still refused
 *     before any call;
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
 * an unexpected served model, a service tier other than the one the setting
 * asks for, or no output text is a failure carrying all of that evidence —
 * never a partially-filled success.
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

/**
 * Setting families. Any change to request shape or rules is a new family, and
 * a family's request is never edited once a run has been recorded under it.
 *   v2 (2026-11-10): max_output_tokens 4000. Every run recorded to 2026-11-11.
 *     Not approvable: 2 of 21 gpt-5.4-2026-03-05 runs stopped at its cap.
 *   v3 (2026-11-13): max_output_tokens 8000; otherwise v2, unchanged.
 *   v4 (2026-11-17): service_tier "flex", OpenAI's half-price tier (founder,
 *     2026-11-17); otherwise v3, unchanged. A response must say flex served
 *     it. v2 and v3 send no service_tier (the project's default tier), so
 *     their request bytes are what was recorded.
 * There is deliberately no "current" family: every setting names its family,
 * so no caller can pick one up by default. Frozen, as every setting is.
 */
export const CHATGPT_SETTING_FAMILIES = Object.freeze({
  "openai-responses-websearch-v2": Object.freeze({ maxOutputTokens: 4000, serviceTier: null, approvable: false }),
  "openai-responses-websearch-v3": Object.freeze({ maxOutputTokens: 8000, serviceTier: null, approvable: true }),
  "openai-responses-websearch-v4": Object.freeze({ maxOutputTokens: 8000, serviceTier: "flex", approvable: true }),
} as const);
export type ChatGptSettingFamily = keyof typeof CHATGPT_SETTING_FAMILIES;

/**
 * The output cap a recorded setting version ran under, from its family. Null
 * for a version whose family this code does not know: the caller cannot tell
 * and must fail closed.
 */
export function maxOutputTokensOfSettingVersion(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const family = version.slice(0, Math.max(0, version.indexOf(":")));
  return Object.hasOwn(CHATGPT_SETTING_FAMILIES, family) ? CHATGPT_SETTING_FAMILIES[family as ChatGptSettingFamily].maxOutputTokens : null;
}

export type ChatGptSearchMode = "auto" | "required";
const CHATGPT_SEARCH_MODES: ReadonlySet<string> = new Set(["auto", "required"]);

export interface ChatGptSetting {
  /** `${family}:${search}:${model}` — names every choice below: the setting is a function of the three. */
  readonly version: string;
  readonly model: string;
  readonly search: ChatGptSearchMode;
  /** null sends no `reasoning` field (a model that does not take one). */
  readonly reasoningEffort: "low" | null;
  /** The family's cap. Output tokens include reasoning tokens, hence a larger cap than Sonar's 1200. */
  readonly maxOutputTokens: number;
  /**
   * The family's service tier: "flex" is sent as `service_tier` and must be
   * what the response says served it; null sends no `service_tier` (the
   * project's default tier) and checks nothing.
   */
  readonly serviceTier: "flex" | null;
  /**
   * exact_or_snapshot: the served model must be the requested name or a dated
   * snapshot of it, or the run fails. recorded_only: the served model is
   * recorded but not checked — allowed for a benchmark reference model only,
   * never for an approved measurement.
   */
  readonly servedModelRule: "exact_or_snapshot" | "recorded_only";
}

/**
 * Reference-only models: no `reasoning` field is sent and the served name is
 * recorded, not checked. Fixed per model in every family, so one version can
 * never name two different requests.
 */
const CHATGPT_REFERENCE_MODELS: ReadonlySet<string> = new Set(["chat-latest"]);

/**
 * The setting for a model and search mode in a named family. The family is
 * required: there is no default. The arguments are checked at run time as
 * well as by the compiler, and the result is frozen, so a cast, a JavaScript
 * caller or a later write cannot produce a setting no family defines.
 */
export function chatGptSetting(model: string, search: ChatGptSearchMode, family: ChatGptSettingFamily): ChatGptSetting {
  if (typeof family !== "string" || !Object.hasOwn(CHATGPT_SETTING_FAMILIES, family)) throw new Error(`Unknown ChatGPT setting family: ${String(family)}`);
  if (!CHATGPT_SEARCH_MODES.has(search)) throw new Error(`Unknown ChatGPT search mode: ${String(search)}`);
  if (typeof model !== "string" || model.trim() === "" || model !== model.trim()) throw new Error("A ChatGPT setting needs a model name.");
  const reference = CHATGPT_REFERENCE_MODELS.has(model);
  return Object.freeze({
    version: `${family}:${search}:${model}`,
    model,
    search,
    reasoningEffort: reference ? null : "low",
    maxOutputTokens: CHATGPT_SETTING_FAMILIES[family].maxOutputTokens,
    serviceTier: CHATGPT_SETTING_FAMILIES[family].serviceTier,
    servedModelRule: reference ? "recorded_only" : "exact_or_snapshot",
  });
}

/**
 * The setting a version string names, or null when it names none this code
 * knows. Family and search mode contain no colon, so the model is everything
 * after the second one.
 */
export function chatGptSettingOfVersion(version: unknown): ChatGptSetting | null {
  if (typeof version !== "string") return null;
  const a = version.indexOf(":");
  const b = a < 0 ? -1 : version.indexOf(":", a + 1);
  if (a <= 0 || b < 0) return null;
  const family = version.slice(0, a);
  const search = version.slice(a + 1, b);
  const model = version.slice(b + 1);
  if (!Object.hasOwn(CHATGPT_SETTING_FAMILIES, family) || !CHATGPT_SEARCH_MODES.has(search) || model.trim() === "" || model !== model.trim()) return null;
  return chatGptSetting(model, search as ChatGptSearchMode, family as ChatGptSettingFamily);
}

/**
 * Whether a setting object is exactly what its own version names. A
 * hand-built or altered object (another cap, another search mode under the
 * same version string) is not, and the adapter refuses to send it.
 */
export function isCanonicalChatGptSetting(setting: unknown): setting is ChatGptSetting {
  if (!setting || typeof setting !== "object") return false;
  const given = setting as Record<string, unknown>;
  const named = chatGptSettingOfVersion(given.version) as Record<string, unknown> | null;
  if (!named) return false;
  const keys = Object.keys(named);
  return Object.keys(given).length === keys.length && keys.every((k) => given[k] === named[k]);
}

/**
 * The setting under confirmation (founder, 2026-11-13: gpt-5.4-2026-03-05;
 * output cap 8000 because 2 of its 21 runs stopped at 4000; founder,
 * 2026-11-17: on the half-price flex tier, family v4). The v3 confirmation
 * run was prepared but never run. The benchmark runs this setting, and its
 * version is the one to approve if the confirmation run passes. An approval
 * names a version, not this constant, so preparing a later confirmation
 * cannot change what is approved.
 */
export const CHATGPT_CONFIRMATION_SETTING: ChatGptSetting = chatGptSetting("gpt-5.4-2026-03-05", "auto", "openai-responses-websearch-v4");

/**
 * How fixed a model ID is, from OpenAI's model pages (read 2026-11-11):
 * - dated_snapshot: a date-stamped snapshot ID; the strongest pin OpenAI offers.
 * - undated_id: the ID is listed as its own default snapshot and OpenAI does
 *   not say it changes, but there is no dated ID, so a silent change cannot
 *   be ruled out from the documentation.
 * - moving_alias: OpenAI says the underlying snapshot is regularly updated.
 */
export type ModelPinning = "dated_snapshot" | "undated_id" | "moving_alias";

const V2: ChatGptSettingFamily = "openai-responses-websearch-v2";

/**
 * Models the benchmark compares (founder, 2026-11-10: a currently supported,
 * cost-efficient model with web search; chat-latest as a reference only,
 * never assumed to reproduce ChatGPT.com). chat-latest takes no reasoning
 * field and its served name is recorded, not checked.
 *
 * One entry per model, so `--models` names exactly one setting. The first four
 * stay as recorded (v2, cap 4000). gpt-5.4-2026-03-05 now runs under the
 * confirmation setting (v4: cap 8000, flex tier); its 21 runs recorded under
 * v2 keep their own version string and stay readable, but that setting is no
 * longer run.
 */
export const CHATGPT_BENCHMARK_CANDIDATES: ReadonlyArray<Readonly<{ role: "candidate" | "reference"; pinning: ModelPinning; setting: ChatGptSetting }>> = Object.freeze([
  Object.freeze({ role: "candidate" as const, pinning: "undated_id" as const, setting: chatGptSetting("gpt-6-luna", "auto", V2) }),
  Object.freeze({ role: "candidate" as const, pinning: "undated_id" as const, setting: chatGptSetting("gpt-6.1-terra", "auto", V2) }),
  Object.freeze({ role: "reference" as const, pinning: "moving_alias" as const, setting: chatGptSetting("chat-latest", "auto", V2) }),
  Object.freeze({ role: "candidate" as const, pinning: "dated_snapshot" as const, setting: chatGptSetting("gpt-5.5-2026-04-23", "auto", V2) }),
  Object.freeze({ role: "candidate" as const, pinning: "dated_snapshot" as const, setting: CHATGPT_CONFIRMATION_SETTING }),
]);

/**
 * The one setting version approved for measurement, or null. Approving is a
 * founder decision and a code change to this line, made only after the
 * confirmation run of that exact version has passed.
 *
 * Approved by the founder on 2026-11-17 ("I approve ChatGPT"), after the
 * confirmation run of this exact version passed all seven criteria the same
 * day (D-050, ADAPTER_VALIDITY_CHATGPT.md). Approval is not wiring: no worker
 * calls this adapter, and a pilot measures on ChatGPT only once it is wired
 * and deployed under its own authorisation (D-053 item 3).
 *
 * It is a full version string, not a model name, so that approving names the
 * family (and with it the output cap) and the search mode, and so that
 * preparing a later confirmation run can neither change nor switch off what
 * is approved.
 */
export const CHATGPT_APPROVED_SETTING_VERSION: string | null = "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05";

/**
 * The approved setting for a search mode, or null: the setting the approved
 * version names, when it names one this code knows, in an approvable family
 * (never v2, whose cap cut answers off), for a model whose served name is
 * checked (never the reference), and for exactly this search mode (the other
 * mode has never been run, so it is not approved by approving this one).
 * Null means the run is refused before any call.
 */
export function approvedChatGptSetting(search: ChatGptSearchMode, approvedVersion: string | null = CHATGPT_APPROVED_SETTING_VERSION): ChatGptSetting | null {
  const s = approvedVersion === null ? null : chatGptSettingOfVersion(approvedVersion);
  if (!s || s.search !== search || s.servedModelRule !== "exact_or_snapshot") return null;
  const family = s.version.slice(0, s.version.indexOf(":")) as ChatGptSettingFamily;
  return CHATGPT_SETTING_FAMILIES[family].approvable ? s : null;
}

/** The requested model or a dated snapshot of it (`gpt-6-luna-2026-05-18`). */
export function isServedModelOf(requested: string, served: string): boolean {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return served === requested || new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}$`).test(served);
}

export function buildChatGptRequestBody(prompt: string, setting: ChatGptSetting): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: setting.model,
    input: prompt,
    tools: [{ type: "web_search" }],
    tool_choice: setting.search === "required" ? "required" : "auto",
    include: ["web_search_call.action.sources"],
  };
  if (setting.reasoningEffort !== null) body.reasoning = { effort: setting.reasoningEffort };
  body.max_output_tokens = setting.maxOutputTokens;
  body.store = false;
  // Last, and only when the family names a tier, so every v2 and v3 request is byte-for-byte what was recorded.
  if (setting.serviceTier !== null) body.service_tier = setting.serviceTier;
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
  if (!setting) throw new Error("No ChatGPT setting is approved for this search mode; pass an explicit benchmark setting.");
  // The setting must be exactly what its version names: a hand-built or
  // altered object would send one request under another request's name.
  if (!isCanonicalChatGptSetting(setting)) throw new Error("The ChatGPT setting does not match its version; build settings with chatGptSetting().");
  // The search mode and the output cap are the setting's. Another value would be a request the version does not name.
  if (input.search !== undefined && input.search !== setting.search) {
    throw new Error("The ChatGPT search mode is fixed by the setting; search cannot change it.");
  }
  if (input.maxTokens !== undefined && input.maxTokens !== setting.maxOutputTokens) {
    throw new Error("The ChatGPT output cap is fixed by the setting; maxTokens cannot change it.");
  }

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
  const requestBodyJson = JSON.stringify(buildChatGptRequestBody(rawProbeRequest, setting));
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
  // The body can fail to arrive after the headers did (a dropped connection,
  // or the caller's deadline firing mid-read). That is a network error with
  // the request evidence and the status already received, never a bare throw
  // that loses both. Its cost is unknown: the provider may have billed it.
  const readBody = async (): Promise<string> => {
    try {
      return await res.text();
    } catch (bodyErr) {
      throw new ChatGptProbeFailure(
        `OpenAI Responses API network error while reading the response body: ${bodyErr instanceof Error ? bodyErr.message : String(bodyErr)}`,
        { reason: "network_error", httpStatus: res.status, errorBody: null, errorBodySha256: null,
          latencyMs: Date.now() - startedAt, providerRequestId, ...evidence },
        null, unknownCost
      );
    }
  };

  if (!res.ok) {
    const err = await readBody();
    throw new ChatGptProbeFailure(`OpenAI Responses API ${res.status}: ${err.slice(0, 500)}`, {
      reason: "http_error", httpStatus: res.status, errorBody: err, errorBodySha256: sha256Hex(err),
      latencyMs, providerRequestId, ...evidence,
    }, null, unknownCost);
  }

  const rawResponseBody = await readBody();
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
  // The tier is part of the setting. OpenAI: the response names the tier that
  // actually served the request, which "may be different" from the one asked
  // for. An answer from another tier (or a body naming none) is not a
  // measurement under this setting; its usage is kept and priced at the tier
  // the body names.
  if (setting.serviceTier !== null && body.service_tier !== setting.serviceTier) {
    throw unusable(`unexpected_service_tier:${typeof body.service_tier === "string" ? body.service_tier : "none"}`);
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
