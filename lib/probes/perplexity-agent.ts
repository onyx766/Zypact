/**
 * Perplexity Agent API adapter — POST /v1/agent.
 *
 * Same contract as the Sonar adapter (perplexity.ts): the same input, the
 * same `PerplexityProbeResult`, the same `PerplexityProbeFailure` with the
 * same three reasons 0037 allows, so the worker records both identically.
 * What differs is only the wire format:
 *
 *   request   { model, input, tools: [{ type: "web_search" }],
 *               max_output_tokens, temperature }
 *   response  { id: "resp_…", object: "response", status, model,
 *               output: [ { type: "search_results", results: [...] },
 *                         { type: "message", content: [ { type:
 *                           "output_text", text, annotations } ] } ],
 *               usage: { …, cost: { total_cost, currency, … } }, error }
 *
 * Fixed configuration, never chosen at run time: model `perplexity/sonar`
 * with the web_search tool. No `effort` preset (the docs' example serves a
 * different model under one), no `models` fallback list (a fallback would
 * change the measuring instrument mid-protocol), no instructions (the buyer
 * question is sent exactly as approved, as with Sonar).
 *
 * Evidence, as with Sonar: the exact serialized request and its SHA-256;
 * the exact response text and its SHA-256, captured before parsing; HTTP
 * status, latency and provider request id. A response that is not JSON, not
 * an Agent response, not `status: "completed"`, has no served model or no
 * output text is a failure carrying all of that evidence — never a
 * partially-filled success.
 *
 * Not wired into the production worker (scripts/run-protocol-worker.ts):
 * an Agent protocol fails closed there until a separately authorized change
 * supplies this runner.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import { PERPLEXITY_AGENT_ENDPOINT } from "@/lib/probes/endpoints";
import {
  PerplexityProbeFailure,
  buildRawTranscript,
  buildUserPrompt,
  normalizeUrl,
  sourceCitationsFromPerplexity,
  uniqueStrings,
  type PerplexityProbeResult,
  type PerplexitySearchResult,
  type RunPerplexityProbeInput,
} from "@/lib/probes/perplexity";

/** The only model this adapter sends. Another model needs approval and a code change. */
export const PERPLEXITY_AGENT_MODEL = "perplexity/sonar";

/** Same sampling as the Sonar adapter, for parity. Not a determinism guarantee. */
const TEMPERATURE = 0.2;

export function buildAgentRequestBody(prompt: string, maxTokens?: number): Record<string, unknown> {
  return {
    model: PERPLEXITY_AGENT_MODEL,
    input: prompt,
    tools: [{ type: "web_search" }],
    max_output_tokens: maxTokens ?? 1200,
    temperature: TEMPERATURE,
  };
}

interface AgentOutputItem {
  type?: unknown;
  results?: unknown;
  content?: unknown;
}

/** Concatenated `output_text` of every `message` item, untrimmed; "" when there is none. */
export function agentOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output as AgentOutputItem[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content as Array<{ type?: unknown; text?: unknown }>) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

/** Every `search_results` item's results, in the shape the Sonar adapter uses. */
export function agentSearchResults(output: unknown): Array<PerplexitySearchResult & { id?: number }> {
  if (!Array.isArray(output)) return [];
  const out: Array<PerplexitySearchResult & { id?: number }> = [];
  for (const item of output as AgentOutputItem[]) {
    if (item?.type !== "search_results" || !Array.isArray(item.results)) continue;
    for (const r of item.results as Record<string, unknown>[]) {
      if (!r || typeof r !== "object") continue;
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      out.push({
        id: typeof r.id === "number" ? r.id : undefined,
        title: str(r.title), url: str(r.url), date: str(r.date),
        last_updated: str(r.last_updated), snippet: str(r.snippet), source: str(r.source),
      });
    }
  }
  return out;
}

/**
 * Inline citation markers ([1], [web:2]) and whether each maps to a search
 * result id. Reported as evidence; an unmapped marker is not invented into
 * a source.
 */
export function agentCitationMarkers(
  text: string,
  results: Array<{ id?: number }>
): { mapped: number[]; unmapped: number[] } {
  const ids = new Set(results.map((r) => r.id).filter((n): n is number => typeof n === "number"));
  const mapped = new Set<number>();
  const unmapped = new Set<number>();
  for (const m of text.matchAll(/\[(?:web:)?(\d+)\]/g)) {
    const n = Number(m[1]);
    (ids.has(n) ? mapped : unmapped).add(n);
  }
  return { mapped: [...mapped].sort((a, b) => a - b), unmapped: [...unmapped].sort((a, b) => a - b) };
}

export async function runPerplexityAgentProbe(
  input: RunPerplexityProbeInput,
): Promise<PerplexityProbeResult> {
  if (input.mockResponse) {
    return {
      ...input.mockResponse,
      rawProbeRequest: input.mockResponse.rawProbeRequest || buildUserPrompt(input),
      // A mock never reaches a provider, so it has no outbound body (as Sonar).
      fullRequestBody: undefined,
      fullRequestBodySha256: undefined,
      usedMock: true,
    };
  }

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is required for live Perplexity probes.");

  const fetcher = input.fetchImpl ?? fetch;
  const rawProbeRequest = buildUserPrompt(input);
  // Serialized once: the bytes sent and the bytes hashed are the same string.
  const requestBodyJson = JSON.stringify(buildAgentRequestBody(rawProbeRequest, input.maxTokens));
  const rawProbeRequestSha256 = sha256Hex(rawProbeRequest);
  const fullRequestBodySha256 = sha256Hex(requestBodyJson);
  const evidence = { rawProbeRequestSha256, fullRequestBody: requestBodyJson, fullRequestBodySha256 };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetcher(PERPLEXITY_AGENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: requestBodyJson,
    });
  } catch (networkErr) {
    // Includes the worker's own deadline aborting the request (a timeout).
    throw new PerplexityProbeFailure(
      `Perplexity Agent API network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      { reason: "network_error", httpStatus: null, errorBody: null, errorBodySha256: null,
        latencyMs: Date.now() - startedAt, providerRequestId: null, ...evidence }
    );
  }

  const latencyMs = Date.now() - startedAt;
  const providerRequestId = res.headers.get("x-request-id") ?? res.headers.get("x-amzn-requestid") ?? null;

  if (!res.ok) {
    const err = await res.text();
    throw new PerplexityProbeFailure(`Perplexity Agent API ${res.status}: ${err.slice(0, 500)}`, {
      reason: "http_error", httpStatus: res.status, errorBody: err, errorBodySha256: sha256Hex(err),
      latencyMs, providerRequestId, ...evidence,
    });
  }

  const rawResponseBody = await res.text();
  const rawResponseBodySha256 = sha256Hex(rawResponseBody);
  // Every 2xx-but-unusable case fails with the whole body as evidence. The
  // reason stays within 0037's three values; the message names the cause.
  const unusable = (cause: string) =>
    new PerplexityProbeFailure(`Perplexity Agent API returned an unusable 2xx response (${cause}).`, {
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
  if (body.status !== "completed") throw unusable(`status:${String(body.status)}`);
  if (typeof body.id !== "string" || body.id.trim() === "") throw unusable("missing_id");
  if (typeof body.model !== "string" || body.model.trim() === "") throw unusable("missing_served_model");

  const answer = agentOutputText(body.output).trim();
  if (!answer) throw unusable("empty_output_text");

  const searchResults = agentSearchResults(body.output);
  const citations = uniqueStrings(searchResults.map((r) => normalizeUrl(r.url ?? "")));
  const sourceCitations = sourceCitationsFromPerplexity(citations, searchResults);
  const rawResponse = buildRawTranscript({ answer, citations, searchResults });

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
