import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { SITE_READER_SYSTEM_PROMPT } from "@/lib/agent-prompts/site-reader.prompt";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { CrawledPage } from "@/lib/crawler/crawl-site";

/**
 * Agent 1 — Site Reader.
 *
 * Takes crawled pages, wraps them in <pages><page>…</page></pages>, calls the
 * model, parses + validates JSON, and returns a typed Mirror Profile.
 *
 * If no LLM key is configured we return a mock Mirror Profile built from the
 * crawled pages — enough to keep the rest of Sprint 1 wired end to end.
 */

export interface RunSiteReaderInput {
  pages: CrawledPage[];
  /** Passed through to the mock builder so the UI shows a sensible domain. */
  websiteUrl?: string;
  companyNameHint?: string;
}

export interface RunSiteReaderResult {
  output: SiteReaderOutput;
  usedMock: boolean;
  usedRetry: boolean;
}

const MAX_CHARS_PER_PAGE = 8_000;
const MAX_TOTAL_CHARS = 60_000;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPagesXml(pages: CrawledPage[]): string {
  let total = 0;
  const parts: string[] = ["<pages>"];
  for (const p of pages) {
    const room = Math.max(0, MAX_TOTAL_CHARS - total);
    if (room <= 200) break;
    const budget = Math.min(MAX_CHARS_PER_PAGE, room - 200);
    const text = p.text.slice(0, budget);
    total += text.length;
    parts.push(
      `<page url="${escapeXml(p.url)}" pageType="${escapeXml(p.pageType)}" title="${escapeXml(
        p.title
      )}">`,
      text,
      "</page>"
    );
  }
  parts.push("</pages>");
  return parts.join("\n");
}

export async function runSiteReaderAgent(
  input: RunSiteReaderInput
): Promise<RunSiteReaderResult> {
  if (input.pages.length === 0) {
    throw new Error("runSiteReaderAgent: no pages provided");
  }

  const userMessage = buildPagesXml(input.pages);
  const mockResponse = JSON.stringify(buildMockMirrorProfile(input));

  const call = {
    system: SITE_READER_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 4096,
    mockResponse,
  };

  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: SiteReaderOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });

  if (!parsed.ok) {
    throw new Error(
      `Site Reader Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  return {
    output: parsed.data,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
  };
}

function buildMockMirrorProfile(input: RunSiteReaderInput): SiteReaderOutput {
  const homepage = input.pages.find((p) => p.pageType === "homepage") ?? input.pages[0];
  let hostname = "";
  try {
    hostname = new URL(input.websiteUrl ?? homepage.url).hostname;
  } catch {
    hostname = "example.com";
  }
  const guessedName =
    input.companyNameHint?.trim() ||
    (homepage.title ? homepage.title.split(/[|·—-]/)[0].trim() : "") ||
    hostname.split(".")[0];

  const has = (t: string) => input.pages.some((p) => p.pageType === t);

  const missing: SiteReaderOutput["missingSignals"] = [];
  if (!has("pricing"))
    missing.push({ signal: "Pricing page", whyItMatters: "Buyers filter fast on price transparency." });
  if (!has("customers") && !has("case_studies"))
    missing.push({
      signal: "Named customers or case studies",
      whyItMatters: "AI answer engines lean on social proof.",
    });
  if (!has("comparison"))
    missing.push({
      signal: "Comparison page",
      whyItMatters: "'X vs Y' queries are prime AI-answer territory.",
    });
  if (!has("faq"))
    missing.push({
      signal: "FAQ",
      whyItMatters: "Structured Q&A is directly harvestable by LLM answer engines.",
    });

  // Schema requires at least 3 missingSignals ("no site is perfect").
  // Top up with generic-but-plausible items so the mock always validates.
  const filler: SiteReaderOutput["missingSignals"] = [
    {
      signal: "Third-party reviews (G2, Capterra, TrustRadius)",
      whyItMatters: "Independent reviews are highly weighted by AI answer engines.",
    },
    {
      signal: "Structured data / schema.org markup",
      whyItMatters: "Helps LLM crawlers cleanly extract product, FAQ, and review data.",
    },
    {
      signal: "Explicit differentiation statement",
      whyItMatters: "AIs need a 1-sentence 'why us over X' to cite you in comparisons.",
    },
    {
      signal: "Security / trust page",
      whyItMatters: "B2B buyers ask AIs about SOC2, ISO, and data handling before shortlisting.",
    },
  ];
  for (const item of filler) {
    if (missing.length >= 3) break;
    if (!missing.some((m) => m.signal === item.signal)) missing.push(item);
  }

  return {
    companyName: guessedName,
    website: input.websiteUrl ?? homepage.url,
    detectedCategory: "SaaS (mock — set OPENAI_API_KEY or ANTHROPIC_API_KEY for a real read)",
    categoryConfidence: "low",
    targetAudience: ["B2B SaaS teams (mock)"],
    useCases: ["Placeholder use case from mock"],
    features: ["Placeholder feature from mock"],
    painPointsAddressed: ["Placeholder pain point from mock"],
    claims: input.pages.slice(0, 3).map((p) => ({
      claim: (p.title || p.text.slice(0, 80)).trim() || "Homepage headline",
      sourceUrl: p.url,
      hasProof: false,
    })),
    proofSignals: [],
    competitorsMentioned: [],
    missingSignals: missing,
    buyerIntentAngles: [
      `best ${hostname.split(".")[0]} alternative`,
      `${hostname.split(".")[0]} vs competitor`,
      `how to use ${hostname.split(".")[0]}`,
    ],
    aiReadabilityNotes:
      "MOCK output. Configure an LLM API key and run again to get a real Mirror Profile.",
  };
}
