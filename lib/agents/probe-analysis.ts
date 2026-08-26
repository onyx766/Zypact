import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { PROBE_ANALYSIS_SYSTEM_PROMPT } from "@/lib/agent-prompts/probe-analysis.prompt";
import {
  ProbeAnalysisOutputSchema,
  type ProbeAnalysisOutput,
  type Platform,
  type ClientIdentity,
  type CompetitorMention,
  type SourceCitation,
  type SourceType,
} from "@/lib/schemas/probe-analysis.schema";

/**
 * Agent 4 — Probe Analysis.
 *
 * Wraps a single pasted AI answer in the required XML tags and asks the
 * model whether the client won, partially appeared, or lost.
 *
 * When no LLM key is configured (mock mode) we run a deterministic text
 * analyzer that inspects the pasted answer and yields a schema-valid result.
 */

export interface RunProbeAnalysisInput {
  prompt: string;
  platform: Platform;
  aiResponse: string;
  clientName: ClientIdentity;
  knownCompetitors?: string[];
}

export interface RunProbeAnalysisResult {
  output: ProbeAnalysisOutput;
  usedMock: boolean;
  usedRetry: boolean;
  /** M1 evidence contract — provider that produced the final accepted output. */
  provider: "openai" | "anthropic" | "mock";
  /** M1 evidence contract — exact model string used for the final accepted output. */
  model: string;
  /** M1 evidence contract — wall-clock milliseconds across the call (plus repair retry, if any). */
  latencyMs: number;
  /** M1 evidence contract — exact request text sent to the model (system + user). */
  requestText: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildUserMessage(input: RunProbeAnalysisInput): string {
  const clientJson = JSON.stringify({
    name: input.clientName.name,
    domain: input.clientName.domain ?? "",
    aliases: input.clientName.aliases ?? [],
  });
  const competitorsJson = JSON.stringify(input.knownCompetitors ?? []);
  return [
    "<prompt>",
    escapeXml(input.prompt),
    "</prompt>",
    "<platform>",
    escapeXml(input.platform),
    "</platform>",
    "<ai_response>",
    escapeXml(input.aiResponse),
    "</ai_response>",
    "<client_name>",
    clientJson,
    "</client_name>",
    "<known_competitors>",
    competitorsJson,
    "</known_competitors>",
  ].join("\n");
}

export async function runProbeAnalysisAgent(
  input: RunProbeAnalysisInput
): Promise<RunProbeAnalysisResult> {
  if (input.aiResponse.trim().length === 0) {
    throw new Error("runProbeAnalysisAgent: aiResponse is empty");
  }

  const userMessage = buildUserMessage(input);
  const mock = buildMockProbeAnalysis(input);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: PROBE_ANALYSIS_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0,
    maxTokens: 2000,
    mockResponse,
  };

  const startedAt = Date.now();
  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: ProbeAnalysisOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });
  const latencyMs = Date.now() - startedAt;

  if (!parsed.ok) {
    // D-027 (B0.2A-1) — bounded: only the parse error code, never the raw
    // model output or the free-text Zod/JSON message (which could echo
    // fragments of the received value). This message is safe to log.
    throw new Error(`Probe Analysis Agent output failed validation (${parsed.code})`);
  }

  return {
    output: parsed.data as ProbeAnalysisOutput,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
    provider: initial.provider,
    model: initial.model,
    latencyMs,
    requestText: `${call.system}\n\n${call.user}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Mock analyzer                                                             */
/* -------------------------------------------------------------------------- */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive "whole-token" match: the term can contain dots and
 * hyphens (for domains like "acme.com") but MUST NOT be surrounded by
 * alphanumerics. This prevents "AI" matching "aid" or "gemini" in "geminis".
 */
function findFirstIndex(haystack: string, term: string): number {
  if (!term) return -1;
  const re = new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, "i");
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

interface Matched {
  name: string;
  index: number;
}

function extractContext(text: string, index: number, name: string): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + name.length + 60);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
}

const RECOMMENDATION_HINTS =
  /\b(recommend|recommends|recommended|best|top|option|options|alternative|alternatives|tool|tools|platform|platforms|choice|choices|consider|check out|try)\b/i;

const REFUSAL_HINTS =
  /\b(cannot|can't|i don't|not able|refuse|apologize|as an ai)\b/i;

function classifySource(source: string): SourceType {
  const s = source.toLowerCase();
  if (/g2\.com|capterra|trustradius|trustpilot|producthunt|product hunt/.test(s))
    return "review_site";
  if (/reddit\.com|hackernews|hacker news|ycombinator|forum|community/.test(s))
    return "forum";
  if (/techcrunch|forbes|wsj|nytimes|bloomberg|wired|verge|news/.test(s)) return "news";
  if (/blog|medium\.com|substack|dev\.to/.test(s)) return "blog";
  if (
    /\.com\/|\.io\/|\.ai\/|\.co\/|according to|per their|from their (site|website|docs)/.test(
      s
    )
  )
    return "vendor_site";
  return "other";
}

function extractSources(text: string): SourceCitation[] {
  const out: SourceCitation[] = [];
  const seen = new Set<string>();

  const urlRe = /https?:\/\/[^\s)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    out.push({ source: url, type: classifySource(url) });
  }

  const attribRe =
    /\baccording to\s+([A-Z][\w.&' -]{1,40}?)(?=[.,;:!?\n]|$)/g;
  while ((m = attribRe.exec(text)) !== null) {
    const name = m[1].trim();
    const key = `attrib:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: name, type: classifySource(name) });
  }
  return out;
}

function summarize(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const sentences = cleaned.split(/(?<=[.!?])\s+/).slice(0, 2);
  const joined = sentences.join(" ");
  return joined.length > 400 ? joined.slice(0, 397) + "…" : joined;
}

function collectClientTerms(client: ClientIdentity): string[] {
  const raw = [client.name, client.domain, ...(client.aliases ?? [])]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  // Also add the domain stem without TLD (e.g. "acme" from "acme.com").
  const extra: string[] = [];
  for (const t of raw) {
    if (t.includes(".") && !/\s/.test(t)) {
      const stem = t.split(".")[0];
      if (stem && stem.length >= 3) extra.push(stem);
    }
  }
  return Array.from(new Set([...raw, ...extra]));
}

export function buildMockProbeAnalysis(
  input: RunProbeAnalysisInput
): ProbeAnalysisOutput {
  const text = input.aiResponse;

  const clientTerms = collectClientTerms(input.clientName);
  let clientFirstIdx = -1;
  let clientMatchedTerm = "";
  for (const term of clientTerms) {
    const idx = findFirstIndex(text, term);
    if (idx >= 0 && (clientFirstIdx < 0 || idx < clientFirstIdx)) {
      clientFirstIdx = idx;
      clientMatchedTerm = term;
    }
  }
  const clientMentioned = clientFirstIdx >= 0;

  const competitors = (input.knownCompetitors ?? [])
    .filter((c) => c.trim().length > 0);
  const competitorMatches: Matched[] = [];
  for (const c of competitors) {
    const idx = findFirstIndex(text, c);
    if (idx >= 0) competitorMatches.push({ name: c, index: idx });
  }
  competitorMatches.sort((a, b) => a.index - b.index);

  const competitorsMentioned: CompetitorMention[] = competitorMatches.map((c, i) => ({
    name: c.name,
    position: i + 1,
    context: extractContext(text, c.index, c.name),
  }));

  const sourcesCited = extractSources(text);
  const answerSummary = summarize(text);

  let verdict: ProbeAnalysisOutput["verdict"];
  let clientPosition: ProbeAnalysisOutput["clientPosition"];
  let whyClientLost = "";

  if (clientMentioned) {
    const clientIsFirst =
      competitorMatches.length === 0 ||
      clientFirstIdx < competitorMatches[0].index;
    if (clientIsFirst) {
      verdict = "won";
      clientPosition = "primary";
    } else {
      verdict = "partial";
      clientPosition = "listed";
      whyClientLost = `AI listed ${competitorMatches[0].name} before mentioning ${clientMatchedTerm}.`;
    }
  } else if (competitorMatches.length > 0) {
    verdict = "lost";
    clientPosition = "absent";
    const top = competitorMatches.slice(0, 3).map((c) => c.name).join(", ");
    whyClientLost = `AI recommended ${top} and did not mention the client.`;
  } else if (!RECOMMENDATION_HINTS.test(text) || REFUSAL_HINTS.test(text)) {
    verdict = "not_relevant";
    clientPosition = "absent";
  } else {
    verdict = "lost";
    clientPosition = "absent";
    whyClientLost = "AI did not mention the client in its recommendation.";
  }

  return {
    prompt: input.prompt,
    platform: input.platform,
    clientMentioned,
    clientPosition,
    competitorsMentioned,
    sourcesCited,
    answerSummary,
    verdict,
    whyClientLost,
  };
}
