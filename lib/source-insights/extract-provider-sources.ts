/**
 * Reads the sources a provider returned from one stored response, by fixed
 * rules. No model, no network, no clock.
 *
 * "Cited" means the answer text points at the source with a numbered
 * reference ([n], or [web:n] on the Agent API). "Retrieved only" means the
 * provider returned the source and the answer does not point at it. A
 * reference that matches nothing is reported, never turned into a source.
 *
 * The body is used only when it re-hashes to the SHA-256 recorded beside it,
 * so a source list always traces to the exact bytes the provider sent.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import type {
  ProtocolReportRunSources,
  ProviderSourceRef,
  ProviderSourceStatus,
} from "@/lib/reports/protocol-report-types";
import { bareDomain } from "@/lib/source-insights/source-types";

export const PROVIDER_SOURCES_RULE_VERSION = "provider-sources/1";

/**
 * D-056 — the rule for the ChatGPT engine (OpenAI Responses API with web
 * search), chosen by the protocol's provider, never guessed from the body:
 *
 *   - only a `completed` body is read; any other is `unrecognised_shape`;
 *   - cited: each `url_citation` annotation on the answer's `output_text`,
 *     numbered 1, 2, 3… in the order they appear, with its title;
 *   - retrieved: each `web_search_call.action.sources[].url`;
 *   - a citation whose URL is unusable is an unmatched marker, never a source;
 *   - markersFound: at least one `url_citation` annotation is present.
 *
 * URL identity: OpenAI appends `utm_source=openai` to many cited links (573
 * of 821 in the 2026-11-17 confirmation run) and to some search sources
 * (288 of 3,404). Matched as received, 763 of the 821 cited URLs are found
 * among their run's sources; with that one parameter removed, all 821 are.
 * So this rule removes exactly the query parameter `utm_source` when its
 * value is `openai`, and nothing else. The URL as received stays in the
 * stored body, which is the evidence.
 */
export const OPENAI_RESPONSES_SOURCES_RULE_VERSION = "openai-responses-sources/1";

/** The source rule a protocol provider is read under. */
export function sourcesRuleVersionForProvider(provider: string | null | undefined): string {
  return provider === "openai_chatgpt" ? OPENAI_RESPONSES_SOURCES_RULE_VERSION : PROVIDER_SOURCES_RULE_VERSION;
}

const MAX_SOURCES_PER_LIST = 50;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

export type ExtractedRunSources = Omit<ProtocolReportRunSources, "ordinal">;

function empty(status: ProviderSourceStatus): ExtractedRunSources {
  return {
    status,
    responseFormat: null,
    cited: [],
    retrievedOnly: [],
    unmatchedMarkers: [],
    markersFound: false,
  };
}

/** A canonical http(s) URL and its bare domain, or null when unusable. */
export function normalizeSourceUrl(raw: unknown): { url: string; domain: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/[),.;]+$/g, "");
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const domain = bareDomain(parsed.hostname);
  if (!domain || !domain.includes(".")) return null;
  parsed.hash = "";
  return { url: parsed.toString(), domain };
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

function markerNumbers(text: string, pattern: RegExp): number[] {
  const order: number[] = [];
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0 && !order.includes(n)) order.push(n);
  }
  return order;
}

interface Candidate {
  url: string;
  domain: string;
  title: string | null;
}

/**
 * Splits returned sources into cited and retrieved-only. `cited` keeps the
 * order the answer first points at them; each URL appears in one list only.
 */
function split(
  citedEntries: Array<{ candidate: Candidate; marker: number }>,
  returned: Candidate[]
): Pick<ExtractedRunSources, "cited" | "retrievedOnly"> {
  const citedByUrl = new Map<string, ProviderSourceRef>();
  for (const { candidate, marker } of citedEntries) {
    const existing = citedByUrl.get(candidate.url);
    if (existing) {
      if (!existing.markers.includes(marker)) existing.markers.push(marker);
      existing.title ??= candidate.title;
    } else {
      citedByUrl.set(candidate.url, { ...candidate, markers: [marker] });
    }
  }

  const retrieved = new Map<string, ProviderSourceRef>();
  for (const candidate of returned) {
    if (citedByUrl.has(candidate.url)) {
      const ref = citedByUrl.get(candidate.url) as ProviderSourceRef;
      ref.title ??= candidate.title;
      continue;
    }
    const existing = retrieved.get(candidate.url);
    if (existing) existing.title ??= candidate.title;
    else retrieved.set(candidate.url, { ...candidate, markers: [] });
  }

  return {
    cited: [...citedByUrl.values()].slice(0, MAX_SOURCES_PER_LIST),
    retrievedOnly: [...retrieved.values()].slice(0, MAX_SOURCES_PER_LIST),
  };
}

function candidate(url: unknown, title: unknown): Candidate | null {
  const normalized = normalizeSourceUrl(url);
  return normalized ? { ...normalized, title: cleanTitle(title) } : null;
}

/** Sonar chat completions: [n] is 1-based into `citations`, else into `search_results`. */
function fromChatCompletions(body: Record<string, unknown>): ExtractedRunSources {
  const choices = body.choices as Array<{ message?: { content?: unknown } }>;
  const content = choices[0]?.message?.content;
  const answer = typeof content === "string" ? content : "";

  const searchResults = Array.isArray(body.search_results)
    ? (body.search_results as Array<Record<string, unknown>>).filter((r) => r && typeof r === "object")
    : [];
  const titleByUrl = new Map<string, string | null>();
  const searchCandidates: Candidate[] = [];
  for (const r of searchResults) {
    const c = candidate(r.url, r.title);
    if (!c) continue;
    searchCandidates.push(c);
    if (!titleByUrl.get(c.url)) titleByUrl.set(c.url, c.title);
  }

  const citationList = Array.isArray(body.citations)
    ? (body.citations as unknown[]).filter((u): u is string => typeof u === "string")
    : [];
  // Keeps positions: an unusable entry still occupies its index, so [n] is
  // never shifted onto a different source.
  const reference: Array<Candidate | null> =
    citationList.length > 0
      ? citationList.map((u) => {
          const n = normalizeSourceUrl(u);
          return n ? { ...n, title: titleByUrl.get(n.url) ?? null } : null;
        })
      : searchResults.map((r) => candidate(r.url, r.title));

  const markers = markerNumbers(answer, /\[(\d+)\]/g);
  const citedEntries: Array<{ candidate: Candidate; marker: number }> = [];
  const unmatched: number[] = [];
  for (const n of markers) {
    const ref = reference[n - 1];
    if (ref) citedEntries.push({ candidate: ref, marker: n });
    else unmatched.push(n);
  }

  const returned = [...reference.filter((c): c is Candidate => c !== null), ...searchCandidates];
  return {
    status: "ok",
    responseFormat: "chat_completions",
    ...split(citedEntries, returned),
    unmatchedMarkers: unmatched.sort((a, b) => a - b),
    markersFound: markers.length > 0,
  };
}

/*
 * Agent API body readers. Same rules as agentOutputText / agentSearchResults
 * in lib/probes/perplexity-agent.ts, kept separate so report pages never
 * import a provider adapter (test-paid-execution-guards). Parity is pinned
 * by test-source-insights.
 */
type AgentItem = { type?: unknown; results?: unknown; content?: unknown };

export function agentBodyAnswerText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output as AgentItem[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content as Array<{ type?: unknown; text?: unknown }>) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

export function agentBodySearchResults(
  output: unknown
): Array<{ id?: number; url?: string; title?: string }> {
  if (!Array.isArray(output)) return [];
  const out: Array<{ id?: number; url?: string; title?: string }> = [];
  for (const item of output as AgentItem[]) {
    if (item?.type !== "search_results" || !Array.isArray(item.results)) continue;
    for (const r of item.results as Record<string, unknown>[]) {
      if (!r || typeof r !== "object") continue;
      out.push({
        id: typeof r.id === "number" ? r.id : undefined,
        url: typeof r.url === "string" ? r.url : undefined,
        title: typeof r.title === "string" ? r.title : undefined,
      });
    }
  }
  return out;
}

/*
 * OpenAI Responses body readers, raw: the same items lib/probes/chatgpt.ts
 * reads (chatGptCitedUrls, chatGptSearchSources), kept separate so report
 * pages never import a provider adapter. Parity is pinned by
 * test-chatgpt-worker.
 */
type OpenAiItem = { type?: unknown; content?: unknown; action?: unknown };

export function openAiBodyCitations(output: unknown): Array<{ url: unknown; title: unknown }> {
  if (!Array.isArray(output)) return [];
  const out: Array<{ url: unknown; title: unknown }> = [];
  for (const item of output as OpenAiItem[]) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content as Array<{ type?: unknown; text?: unknown; annotations?: unknown }>) {
      if (c?.type !== "output_text" || typeof c.text !== "string" || !Array.isArray(c.annotations)) continue;
      for (const a of c.annotations as Array<{ type?: unknown; url?: unknown; title?: unknown }>) {
        if (a?.type === "url_citation") out.push({ url: a.url, title: a.title });
      }
    }
  }
  return out;
}

export function openAiBodySearchSourceUrls(output: unknown): unknown[] {
  if (!Array.isArray(output)) return [];
  const out: unknown[] = [];
  for (const item of output as OpenAiItem[]) {
    if (item?.type !== "web_search_call" || !item.action || typeof item.action !== "object") continue;
    const sources = (item.action as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const src of sources as Array<{ url?: unknown }>) out.push(src?.url);
  }
  return out;
}

/** Removes exactly `utm_source=openai` from a normalized URL (rule openai-responses-sources/1). */
function withoutOpenAiUtm(normalized: { url: string; domain: string }): { url: string; domain: string } {
  const parsed = new URL(normalized.url);
  const kept = [...parsed.searchParams].filter(([k, v]) => !(k === "utm_source" && v === "openai"));
  if (kept.length === [...parsed.searchParams].length) return normalized;
  parsed.search = "";
  for (const [k, v] of kept) parsed.searchParams.append(k, v);
  return { url: parsed.toString(), domain: normalized.domain };
}

function openAiCandidate(url: unknown, title: unknown): Candidate | null {
  const normalized = normalizeSourceUrl(url);
  return normalized ? { ...withoutOpenAiUtm(normalized), title: cleanTitle(title) } : null;
}

function fromOpenAiResponses(body: Record<string, unknown>): ExtractedRunSources {
  if (body.object !== "response" || body.status !== "completed" || !Array.isArray(body.output)) {
    return empty("unrecognised_shape");
  }
  const citations = openAiBodyCitations(body.output);
  const citedEntries: Array<{ candidate: Candidate; marker: number }> = [];
  const unmatched: number[] = [];
  citations.forEach((c, i) => {
    const ref = openAiCandidate(c.url, c.title);
    if (ref) citedEntries.push({ candidate: ref, marker: i + 1 });
    else unmatched.push(i + 1);
  });
  const returned = openAiBodySearchSourceUrls(body.output)
    .map((u) => openAiCandidate(u, null))
    .filter((c): c is Candidate => c !== null);
  return {
    status: "ok",
    responseFormat: "openai_responses",
    ...split(citedEntries, returned),
    unmatchedMarkers: unmatched,
    markersFound: citations.length > 0,
  };
}

/** Agent API: [n] or [web:n] refers to a search result's own `id`. */
function fromAgentResponse(body: Record<string, unknown>): ExtractedRunSources {
  const answer = agentBodyAnswerText(body.output);
  const results = agentBodySearchResults(body.output);

  const byId = new Map<number, Candidate>();
  const returned: Candidate[] = [];
  for (const r of results) {
    const c = candidate(r.url, r.title);
    if (!c) continue;
    returned.push(c);
    if (typeof r.id === "number" && !byId.has(r.id)) byId.set(r.id, c);
  }

  const markers = markerNumbers(answer, /\[(?:web:)?(\d+)\]/g);
  const citedEntries: Array<{ candidate: Candidate; marker: number }> = [];
  const unmatched: number[] = [];
  for (const n of markers) {
    const ref = byId.get(n);
    if (ref) citedEntries.push({ candidate: ref, marker: n });
    else unmatched.push(n);
  }

  return {
    status: "ok",
    responseFormat: "agent_response",
    ...split(citedEntries, returned),
    unmatchedMarkers: unmatched.sort((a, b) => a - b),
    markersFound: markers.length > 0,
  };
}

export function extractProviderSources(
  rawResponse: string | null | undefined,
  rawResponseSha256: string | null | undefined,
  // D-056 — the protocol's provider decides the rule. Absent (every caller
  // before D-056) or any Perplexity provider reads exactly as before.
  provider?: string | null
): ExtractedRunSources {
  if (typeof rawResponse !== "string" || rawResponse.length === 0) return empty("no_raw_response");
  if (typeof rawResponseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(rawResponseSha256)) {
    return empty("hash_missing");
  }
  if (sha256Hex(rawResponse) !== rawResponseSha256) return empty("hash_mismatch");

  let json: unknown;
  try {
    json = JSON.parse(rawResponse);
  } catch {
    return empty("not_provider_json");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return empty("not_provider_json");
  const body = json as Record<string, unknown>;

  if (provider === "openai_chatgpt") return fromOpenAiResponses(body);
  if (body.object === "response" && Array.isArray(body.output)) return fromAgentResponse(body);
  if (Array.isArray(body.choices) && body.choices.length > 0) return fromChatCompletions(body);
  return empty("unrecognised_shape");
}
