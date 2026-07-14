import type { SourceCitation, SourceType } from "@/lib/schemas/probe-analysis.schema";

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
  rawResponse: string;
  /** Sprint 13C — exact buyer prompt sent to Perplexity, persisted for audit. */
  rawProbeRequest?: string;
  citations: string[];
  searchResults: PerplexitySearchResult[];
  sourceCitations: SourceCitation[];
  model: string;
  usedMock: boolean;
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

  const res = await fetcher("https://api.perplexity.ai/v1/sonar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
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
  };
}

export const __perplexityProbeTestUtils = {
  classifySource,
  sourceCitationsFromPerplexity,
  buildRawTranscript,
  buildUserPrompt,
};
