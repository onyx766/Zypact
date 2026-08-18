import type { SourceCitation, SourceType } from "@/lib/schemas/probe-analysis.schema";
import { sha256Hex } from "@/lib/evidence/hash";

export interface PerplexitySearchResult {
  title?: string;
  url?: string;
  date?: string;
  last_updated?: string;
  snippet?: string;
  source?: string;
}

export interface PerplexityProbeResult {
  prompt: string;
  answer: string;
  /**
   * KNOWN M1 LIMITATION (first tranche, not yet closed): this is a
   * reconstructed transcript — `answer` + citations + search results,
   * formatted by `buildRawTranscript` — NOT the raw JSON response body
   * Perplexity actually returned. `rawResponseSha256` hashes this
   * transcript, so it proves the transcript hasn't been altered since it
   * was built, but it does not prove byte-for-byte fidelity to
   * Perplexity's original response. Capturing the true raw response body
   * (e.g. the exact `res.text()`/`res.json()` bytes) is still open work.
   */
  rawResponse: string;
  /** Sprint 13C — exact buyer prompt sent to Perplexity, persisted for audit. */
  rawProbeRequest?: string;
  citations: string[];
  searchResults: PerplexitySearchResult[];
  sourceCitations: SourceCitation[];
  model: string;
  usedMock: boolean;
  /**
   * M1 evidence contract — SHA-256 of `rawResponse`. Absent for mock
   * calls. See the KNOWN M1 LIMITATION note on `rawResponse` above: this
   * hashes the reconstructed transcript, not Perplexity's raw response
   * bytes.
   */
  rawResponseSha256?: string;
  /**
   * M1 evidence contract — SHA-256 of `rawProbeRequest` ONLY, i.e. the
   * trimmed buyer-question text sent as the user message. This is NOT a
   * hash of the complete outbound HTTP body: it does not cover `model`,
   * `temperature`, `max_tokens`, `stream`, or `web_search_options`. Use
   * `fullRequestBodySha256` for a hash that covers the exact JSON body
   * sent on the wire.
   */
  rawProbeRequestSha256?: string;
  /**
   * M1 evidence contract — SHA-256 of the exact JSON-serialized HTTP
   * request body sent to Perplexity (`model` + `messages` + all other
   * fields), as `JSON.stringify`'d before the call. Absent for mock calls.
   */
  fullRequestBodySha256?: string;
  /** M1 evidence contract — HTTP status returned by Perplexity. Absent for mock calls. */
  httpStatus?: number;
  /** M1 evidence contract — wall-clock milliseconds spent in the outbound call. */
  latencyMs?: number;
  /** M1 evidence contract — provider-assigned request id, when Perplexity returns one. */
  providerRequestId?: string | null;
}

export interface RunPerplexityProbeInput {
  prompt: string;
  brandName: string;
  domain?: string | null;
  maxTokens?: number;
  /** Unit-test only. When supplied, no network call is made. */
  mockResponse?: PerplexityProbeResult;
  fetchImpl?: typeof fetch;
}

function classifySource(source: string): SourceType {
  const s = source.toLowerCase();
  if (/g2\.com|capterra|trustradius|trustpilot|producthunt|product hunt/.test(s)) {
    return "review_site";
  }
  if (/reddit\.com|hackernews|hacker news|ycombinator|forum|community/.test(s)) {
    return "forum";
  }
  if (/techcrunch|forbes|wsj|nytimes|bloomberg|wired|verge|news/.test(s)) {
    return "news";
  }
  if (/blog|medium\.com|substack|dev\.to/.test(s)) return "blog";
  if (/https?:\/\//.test(s) || /\.com|\.io|\.ai|\.co|\.app/.test(s)) {
    return "vendor_site";
  }
  return "other";
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/[),.;]+$/g, "");
}

function sourceCitationsFromPerplexity(
  citations: string[],
  searchResults: PerplexitySearchResult[],
): SourceCitation[] {
  const urls = uniqueStrings([
    ...citations.map(normalizeUrl),
    ...searchResults.map((r) => normalizeUrl(r.url ?? "")),
  ]);
  return urls.map((source) => ({ source, type: classifySource(source) }));
}

function buildUserPrompt(input: RunPerplexityProbeInput): string {
  // Sprint 13C integrity rule: the platform must receive the buyer prompt
  // AS-IS. Do not leak the audited brand name, domain, category, or project
  // context into the Perplexity request. Zypact may use client identity only
  // after the platform answer is returned, during internal analysis.
  return input.prompt.trim();
}

function buildRawTranscript(args: {
  answer: string;
  citations: string[];
  searchResults: PerplexitySearchResult[];
}): string {
  const lines: string[] = [args.answer.trim()];
  if (args.citations.length > 0) {
    lines.push("", "Perplexity citations:");
    for (const url of args.citations) lines.push(`- ${url}`);
  }
  if (args.searchResults.length > 0) {
    lines.push("", "Perplexity search results:");
    for (const r of args.searchResults) {
      const title = r.title?.trim() || "Untitled source";
      const url = r.url?.trim() || "";
      const snippet = r.snippet?.trim() || "";
      lines.push(`- ${title}${url ? ` — ${url}` : ""}${snippet ? ` — ${snippet}` : ""}`);
    }
  }
  return lines.join("\n").trim();
}

interface PerplexityApiResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

export async function runPerplexityProbe(
  input: RunPerplexityProbeInput,
): Promise<PerplexityProbeResult> {
  if (input.mockResponse) {
    return {
      ...input.mockResponse,
      rawProbeRequest: input.mockResponse.rawProbeRequest || buildUserPrompt(input),
      usedMock: true,
    };
  }

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is required for live Perplexity probes.");

  const model = process.env.PERPLEXITY_MODEL || "sonar";
  const fetcher = input.fetchImpl ?? fetch;
  const rawProbeRequest = buildUserPrompt(input);
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: rawProbeRequest,
      },
    ],
    temperature: 0.2,
    max_tokens: input.maxTokens ?? 1200,
    stream: false,
    web_search_options: {
      search_mode: "web",
    },
  };

  // Serialized once and reused for both the outbound call and the hash, so
  // the hash is guaranteed byte-identical to what actually went on the wire.
  const requestBodyJson = JSON.stringify(body);

  const startedAt = Date.now();
  const res = await fetcher("https://api.perplexity.ai/v1/sonar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: requestBodyJson,
  });
  const latencyMs = Date.now() - startedAt;
  const providerRequestId =
    res.headers.get("x-request-id") ?? res.headers.get("x-amzn-requestid") ?? null;

  if (!res.ok) {
    // KNOWN M1 LIMITATION (first tranche, not yet closed): a failed
    // Perplexity attempt (non-2xx status, or the empty-answer case below)
    // is thrown here and never reaches `saveProbeResult` — no
    // `probe_results` row, no evidence row, no failure metadata is
    // persisted for it. METHODOLOGY.md requires failed/excluded attempts
    // to remain visible in denominator reconciliation; that requirement
    // is not yet met. The caller only sees an in-memory Error.
    const err = await res.text();
    throw new Error(`Perplexity ${res.status}: ${err.slice(0, 500)}`);
  }

  const json = (await res.json()) as PerplexityApiResponse;
  const answer = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!answer) throw new Error("Perplexity returned an empty answer.");

  const citations = uniqueStrings((json.citations ?? []).map(normalizeUrl));
  const searchResults = Array.isArray(json.search_results) ? json.search_results : [];
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
    model: json.model || model,
    usedMock: false,
    rawResponseSha256: sha256Hex(rawResponse),
    rawProbeRequestSha256: sha256Hex(rawProbeRequest),
    fullRequestBodySha256: sha256Hex(requestBodyJson),
    httpStatus: res.status,
    latencyMs,
    providerRequestId,
  };
}

export const __perplexityProbeTestUtils = {
  classifySource,
  sourceCitationsFromPerplexity,
  buildRawTranscript,
  buildUserPrompt,
};
