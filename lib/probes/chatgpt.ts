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
 * Fixed configuration, never chosen at run time (CHATGPT_MEASUREMENT_SETTING).
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
 * The ChatGPT measurement setting, versioned. Any change is a new version
 * and a new measuring instrument; results across versions are not directly
 * comparable. The model is an engineer default awaiting founder approval
 * (D-050 open item 1).
 *
 * No temperature: OpenAI's reasoning models reject one. Reasoning effort
 * "low" is the lowest level the web search tool accepts. Output tokens
 * include reasoning tokens, hence a larger cap than Sonar's 1200.
 */
export const CHATGPT_MEASUREMENT_SETTING = {
  version: "openai-responses-websearch-v1",
  model: "gpt-5-mini",
  tool: "web_search",
  toolChoice: "auto",
  reasoningEffort: "low",
  maxOutputTokens: 4000,
} as const;

export const CHATGPT_MODEL = CHATGPT_MEASUREMENT_SETTING.model;

/**
 * The served model is the approved model or a dated snapshot of it
 * (`gpt-5-mini-2025-08-07`). Anything else, including a different family
 * member, is a different instrument and fails.
 */
export function isApprovedServedModel(served: string): boolean {
  return served === CHATGPT_MODEL || new RegExp(`^${CHATGPT_MODEL.replace(/[.]/g, "\\.")}-\\d{4}-\\d{2}-\\d{2}$`).test(served);
}

export function buildChatGptRequestBody(prompt: string, maxTokens?: number): Record<string, unknown> {
  return {
    model: CHATGPT_MEASUREMENT_SETTING.model,
    input: prompt,
    tools: [{ type: CHATGPT_MEASUREMENT_SETTING.tool }],
    tool_choice: CHATGPT_MEASUREMENT_SETTING.toolChoice,
    include: ["web_search_call.action.sources"],
    reasoning: { effort: CHATGPT_MEASUREMENT_SETTING.reasoningEffort },
    max_output_tokens: maxTokens ?? CHATGPT_MEASUREMENT_SETTING.maxOutputTokens,
    store: false,
  };
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

/** How many web searches the model chose to run. Zero is an observation, not a failure. */
export function chatGptSearchCount(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  return (output as OutputItem[]).filter((i) => i?.type === "web_search_call").length;
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

export async function runChatGptProbe(input: RunPerplexityProbeInput): Promise<PerplexityProbeResult> {
  if (input.mockResponse) {
    return {
      ...input.mockResponse,
      rawProbeRequest: input.mockResponse.rawProbeRequest || buildUserPrompt(input),
      // A mock never reaches a provider, so it has no outbound body.
      fullRequestBody: undefined,
      fullRequestBodySha256: undefined,
      usedMock: true,
    };
  }

  const apiKey = process.env.OPENAI_PROBE_API_KEY;
  if (!apiKey) throw new Error("OPENAI_PROBE_API_KEY is required for live ChatGPT probes.");

  const fetcher = input.fetchImpl ?? fetch;
  const rawProbeRequest = buildUserPrompt(input);
  // Serialized once: the bytes sent and the bytes hashed are the same string.
  const requestBodyJson = JSON.stringify(buildChatGptRequestBody(rawProbeRequest, input.maxTokens));
  const rawProbeRequestSha256 = sha256Hex(rawProbeRequest);
  const fullRequestBodySha256 = sha256Hex(requestBodyJson);
  const evidence = { rawProbeRequestSha256, fullRequestBody: requestBodyJson, fullRequestBodySha256 };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetcher(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: requestBodyJson,
    });
  } catch (networkErr) {
    throw new PerplexityProbeFailure(
      `OpenAI Responses API network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      { reason: "network_error", httpStatus: null, errorBody: null, errorBodySha256: null,
        latencyMs: Date.now() - startedAt, providerRequestId: null, ...evidence }
    );
  }

  const latencyMs = Date.now() - startedAt;
  const providerRequestId = res.headers.get("x-request-id") ?? null;

  if (!res.ok) {
    const err = await res.text();
    throw new PerplexityProbeFailure(`OpenAI Responses API ${res.status}: ${err.slice(0, 500)}`, {
      reason: "http_error", httpStatus: res.status, errorBody: err, errorBodySha256: sha256Hex(err),
      latencyMs, providerRequestId, ...evidence,
    });
  }

  const rawResponseBody = await res.text();
  const rawResponseBodySha256 = sha256Hex(rawResponseBody);
  const unusable = (cause: string) =>
    new PerplexityProbeFailure(`OpenAI Responses API returned an unusable 2xx response (${cause}).`, {
      reason: "empty_answer", httpStatus: res.status, errorBody: rawResponseBody,
      errorBodySha256: rawResponseBodySha256, latencyMs, providerRequestId, ...evidence,
    });

  let json: unknown;
  try {
    json = JSON.parse(rawResponseBody);
  } catch {
    throw unusable("invalid_json");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw unusable("not_an_object");
  const body = json as Record<string, unknown>;
  if (body.object !== "response") throw unusable(`unexpected_object:${String(body.object)}`);
  if (body.error !== undefined && body.error !== null) throw unusable("error_present");
  if (body.status !== "completed") throw unusable(`status:${String(body.status)}`);
  if (typeof body.id !== "string" || body.id.trim() === "") throw unusable("missing_id");
  if (typeof body.model !== "string" || body.model.trim() === "") throw unusable("missing_served_model");
  if (!isApprovedServedModel(body.model)) throw unusable(`unexpected_served_model:${body.model}`);

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
  };
}
