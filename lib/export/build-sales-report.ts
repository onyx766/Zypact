/**
 * Sprint 14B.1 — short sales report renderer hardening.
 *
 * This renderer is intentionally read-only: it consumes the already-generated
 * long MVP markdown export and produces a concise prospect-facing markdown
 * report. It does not call LLMs, probes, or the database.
 *
 * Invariant: client-facing interpretation must come from the corrected
 * derived 14A.2 export fields, not legacy probe fields.
 */

export interface BuildSalesReportOptions {
  /** Optional override when a human reviewer wants to constrain competitors to the true business frame. */
  focusCompetitors?: string[];
  /** Timestamp override for deterministic tests. */
  now?: Date;
}

export interface BuildSalesReportResult {
  markdown: string;
  filename: string;
  summary: {
    brand: string;
    domain: string;
    visibilityLine: string;
    brandedReputation: string;
    focusCompetitors: string[];
    firstFix: string;
  };
}

interface PromptRow {
  prompt: string;
  scorecardStatus: string;
  runs: string;
  recommendedAsProduct: string;
  citedAsSource: string;
  negativeMentions: string;
  productVerdict: string;
}

interface FixBriefSummary {
  lostPrompt: string;
  competitors: string[];
  fixType: string;
  rootCause: string;
  recommendedFix: string;
  evidenceNeeded: string[];
}

interface BrandedProbeEvidence {
  prompt: string;
  answerSummary: string;
  whyClientLost: string;
  productPosition: string;
}

const INTERNAL_PATTERNS = [
  /projectId/i,
  /gapMapId/i,
  /fixBriefId/i,
  /rawProbeRequest/i,
  /legacy\s+/i,
  /Sprint\s+\d+/i,
  /exportFormatVersion/i,
  /existing MVP scan export/i,
];

const DEFAULT_REPORT_DATE = new Date("2026-07-10T00:00:00.000Z");

function clean(value: string | undefined | null): string {
  return (value ?? "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/_\(fixType[^)]*\)_/gi, "")
    .replace(/_\(type[^)]*\)_/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "zypact-sales-report";
}

function extractBullet(markdown: string, label: string): string {
  const escaped = escapeRegex(label);
  const re = new RegExp(`^-\\s+\\*\\*${escaped}\\*\\*:\\s*(.+)$`, "im");
  return clean(markdown.match(re)?.[1]);
}

function extractBulletByPrefix(markdown: string, prefix: string): string {
  const escaped = escapeRegex(prefix);
  const re = new RegExp(`^-\\s+\\*\\*${escaped}[^*]*\\*\\*:\\s*(.+)$`, "im");
  return clean(markdown.match(re)?.[1]);
}

function extractSection(markdown: string, heading: string): string {
  const escaped = escapeRegex(heading);
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return markdown.match(re)?.[1]?.trim() ?? "";
}

function extractSubsection(markdown: string, heading: string): string {
  const escaped = escapeRegex(heading);
  const re = new RegExp(`(?:^|\\n)###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`, "i");
  return markdown.match(re)?.[1]?.trim() ?? "";
}

function splitCsv(value: string): string[] {
  return clean(value)
    .split(",")
    .map((item) => clean(item))
    .filter(Boolean);
}

function parsePromptRows(markdown: string): PromptRow[] {
  const section = extractSubsection(markdown, "Prompt-level aggregation");
  if (!section) return [];
  const rows: PromptRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|\s*-+/.test(trimmed) || /prompt\s*\|\s*scorecard status/i.test(trimmed)) {
      continue;
    }
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => clean(cell));
    if (cells.length < 7) continue;
    rows.push({
      prompt: cells[0],
      scorecardStatus: cells[1],
      runs: cells[2],
      recommendedAsProduct: cells[3],
      citedAsSource: cells[4],
      negativeMentions: cells[5],
      productVerdict: cells[6],
    });
  }
  return rows;
}

function extractLostPrompts(markdown: string): string[] {
  const section = extractSubsection(markdown, "Which prompts Vugio lost or under-performed") || extractSubsection(markdown, "Which prompts lost or under-performed");
  const prompts: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^-\s+(.+?)\s+\(/);
    if (m) prompts.push(clean(m[1]));
  }
  return prompts;
}

function parseFixBrief(markdown: string): FixBriefSummary {
  const fix = extractSection(markdown, "13\\. Fix Brief") || extractSection(markdown, "13. Fix Brief");
  const lostPrompt = clean(fix.match(/^-\s+\*\*lostPrompt\*\*:\s*(.+)$/m)?.[1]);
  const competitors = splitCsv(fix.match(/^-\s+\*\*competitorRecommended\*\*:\s*(.+)$/m)?.[1] ?? "");
  const fixType = clean(fix.match(/^-\s+\*\*fixType\*\*:\s*(.+)$/m)?.[1]);
  const rootCause = clean(fix.match(/^#### Root cause\s*\n([\s\S]*?)(?=^####|\z)/m)?.[1]);
  const recommendedFix = clean(fix.match(/^#### Recommended fix\s*\n([\s\S]*?)(?=^####|\z)/m)?.[1]);
  const evidenceBlock = fix.match(/^#### Evidence needed\s*\n([\s\S]*?)(?=^####|\z)/m)?.[1] ?? "";
  const evidenceNeeded = evidenceBlock
    .split(/\r?\n/)
    .map((line) => clean(line.replace(/^-\s+/, "")))
    .filter(Boolean);
  return { lostPrompt, competitors, fixType, rootCause, recommendedFix, evidenceNeeded };
}

function parseBrandedReputation(markdown: string): string {
  const executive = extractBullet(markdown, "Branded reputation");
  if (executive) return executive;
  const check = extractSubsection(markdown, "Branded reputation check");
  const firstLine = check.split(/\r?\n/).find((line) => line.trim().length > 0);
  return clean(firstLine) || "not measured";
}

function parseCompetitorMentions(markdown: string): Map<string, number> {
  const section = extractSubsection(markdown, "Which competitors appeared instead");
  const result = new Map<string, number>();
  for (const line of section.split(/\r?\n/)) {
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => clean(cell));
    if (cells.length !== 2 || /competitor/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;
    const count = Number(cells[1]);
    if (cells[0]) result.set(cells[0], Number.isFinite(count) ? count : 0);
  }
  return result;
}

function chooseFocusCompetitors(markdown: string, options: BuildSalesReportOptions, fixBrief: FixBriefSummary): string[] {
  if (options.focusCompetitors?.length) {
    return options.focusCompetitors.map(clean).filter(Boolean).slice(0, 5);
  }
  if (fixBrief.competitors.length > 0) {
    return fixBrief.competitors.slice(0, 5);
  }
  const top = splitCsv(extractBullet(markdown, "Top competitors AI recommended instead"));
  return top.slice(0, 5);
}

function formatList(items: string[], fallback = "not enough evidence yet"): string {
  const values = items.map(clean).filter(Boolean);
  if (values.length === 0) return fallback;
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function getScorecardPrompts(rows: PromptRow[], fixBrief?: FixBriefSummary): PromptRow[] {
  const included = rows.filter((row) => /^included$/i.test(row.scorecardStatus));
  if (fixBrief?.lostPrompt) {
    const exact = included.filter((row) => row.prompt.toLowerCase() === fixBrief.lostPrompt.toLowerCase());
    if (exact.length > 0) return exact;
  }
  return included;
}

function getBrandedRows(rows: PromptRow[]): PromptRow[] {
  return rows.filter((row) => /tracked_separately/i.test(row.scorecardStatus));
}

function numberFromLine(markdown: string, label: string): number | undefined {
  const escaped = escapeRegex(label);
  const m = markdown.match(new RegExp(`^-\\s+\\*\\*${escaped}\\*\\*:\\s*([0-9]+)`, "im"));
  const n = Number(m?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseSelectedPromptCount(markdown: string): number | undefined {
  return numberFromLine(markdown, "selected for probe");
}

function parseScorecardBasis(markdown: string, includedRows: PromptRow[]): { promptGroups: number; runs: number } {
  const promptGroups = numberFromLine(markdown, "scorecard prompt groups") ?? includedRows.length;
  const runs = numberFromLine(markdown, "scorecard runs") ?? includedRows.reduce((sum, row) => sum + (Number(row.runs) || 0), 0);
  return { promptGroups, runs };
}

function parseProbeMode(markdown: string): "simulated" | "live" {
  const lower = markdown.toLowerCase();

  if (
    lower.includes("probe mode          : simulated") ||
    lower.includes("probe mode: simulated") ||
    lower.includes("probe mode | simulated") ||
    lower.includes("simulated orchestration row") ||
    lower.includes("simulated competitor")
  ) {
    return "simulated";
  }

  return "live";
}

function visibilityHeadline(markdown: string, aiProbeResult: string, basis: { promptGroups: number; runs: number }): string {
  const rec = aiProbeResult.match(/recommendedAsProduct\s+([0-9]+%)/i)?.[1] ?? "0%";
  const promptLabel = basis.promptGroups === 1 ? "buyer prompt" : "buyer prompts";
  const mode = parseProbeMode(markdown);
  const runLabel = mode === "simulated"
    ? (basis.runs === 1 ? "simulated test run" : "simulated test runs")
    : (basis.runs === 1 ? "live AI run" : "live AI runs");

  if (basis.promptGroups > 0 && basis.runs > 0) {
    return `${rec} recommended as a product across ${basis.promptGroups} ${promptLabel} and ${basis.runs} ${runLabel}`;
  }

  return `${rec} recommended as a product in the unbranded buyer prompts tested`;
}

type VisibilityTone = "absent" | "mixed" | "strong";

function parseRecommendedPercent(aiProbeResult: string): number {
  const m = aiProbeResult.match(/recommendedAsProduct\s+([0-9]+)%/i);
  const n = Number(m?.[1]);
  return Number.isFinite(n) ? n : 0;
}

function parseOutcomeCount(aiProbeResult: string, label: "won" | "partial" | "lost"): number {
  const m = aiProbeResult.match(new RegExp(`([0-9]+)\\s+${label}`, "i"));
  const n = Number(m?.[1]);
  return Number.isFinite(n) ? n : 0;
}

function visibilityTone(aiProbeResult: string): VisibilityTone {
  const recommended = parseRecommendedPercent(aiProbeResult);
  const lost = parseOutcomeCount(aiProbeResult, "lost");
  const won = parseOutcomeCount(aiProbeResult, "won");
  if (recommended >= 70 && lost === 0 && won > 0) return "strong";
  if (recommended > 0) return "mixed";
  return "absent";
}

function executiveInterpretation(brand: string, brandedReputation: string, tone: VisibilityTone, competitors: string[]): string {
  const competitorText = formatList(competitors.slice(0, 3));
  if (tone === "strong") {
    return `${brand} was recommended in most of the unbranded buying prompts tested. The opportunity is not basic recovery from invisibility; it is consolidation — becoming the primary recommendation more often, improving cited-source coverage, and defending the position against ${competitorText}. When the brand was named directly, the branded reputation check was **${brandedReputation}**, which supports a visibility-consolidation interpretation.`;
  }
  if (tone === "mixed") {
    return `${brand} was recommended in most of the unbranded buyer runs tested, but not consistently as the primary recommendation. The opportunity is to consolidate that visibility into a stronger primary shortlist position against ${competitorText}. When the brand was named directly, the branded reputation check was **${brandedReputation}**.`;
  }
  return `${brand} did not appear as a recommended product in the unbranded buying prompts tested. When the brand was named directly, the branded reputation check was **${brandedReputation}**, which means this is not only a visibility gap — it is also a reputation-risk signal.`;
}

function competitorHeadlineLabel(tone: string, aiProbeResult: string): string {
  const normalizedTone = String(tone || "").toLowerCase();

  if (
    normalizedTone === "strong" ||
    normalizedTone === "winning" ||
    normalizedTone === "positive"
  ) {
    return "Other tools AI recommended in the same frame";
  }

  const normalizedScorecard = String(aiProbeResult || "").replace(/\s+/g, " ");

  const lostMatch =
    normalizedScorecard.match(/(\d+)\s+lost\b/i) ||
    normalizedScorecard.match(/lost\s*[:=]\s*(\d+)/i);

  const lostGroups = lostMatch ? Number(lostMatch[1]) : 0;

  if (lostGroups > 0) {
    return "Competitors AI recommended instead";
  }

  const recommendedRateMatch =
    normalizedScorecard.match(/recommendedAsProduct\s+(\d+(?:\.\d+)?)%/i) ||
    normalizedScorecard.match(/(\d+(?:\.\d+)?)%\s+recommended/i);

  const recommendedRate = recommendedRateMatch ? Number(recommendedRateMatch[1]) : 0;

  if (normalizedTone === "mixed" || recommendedRate > 0) {
    return "Other tools AI recommended in the same frame";
  }

  return "Competitors AI recommended instead";
}

function opportunityLabel(tone: VisibilityTone): string {
  if (tone === "strong") return "clearest consolidation opportunity";
  if (tone === "mixed") return "clearest under-performance opportunity";
  return "clearest buying-frame loss";
}

function frameRecommendationSentence(brand: string, tone: VisibilityTone, competitors: string[]): string {
  const competitorText = formatList(competitors.slice(0, 4));
  if (tone === "strong") return `In that frame, ${brand} was present, but AI still surfaced ${competitorText} prominently.`;
  if (tone === "mixed") return `In that frame, AI also recommended ${competitorText}, so ${brand} is not yet the clear primary choice.`;
  return `In that frame, AI recommended ${competitorText} instead.`;
}

function fixHeading(tone: VisibilityTone): string {
  return tone === "strong"
    ? "Strengthen comparison / proof content around the consolidation frame."
    : "Strengthen comparison / proof content around the under-performing buying frame.";
}

function sanitizeSentence(value: string): string {
  const cleaned = clean(value);
  if (!cleaned) return "";
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  return clean(sentences?.[0] ?? cleaned);
}

function parseBrandedProbeEvidence(markdown: string): BrandedProbeEvidence | null {
  const blocks = markdown.split(/\n### Live Perplexity Sonar probe · product verdict:/i).slice(1);
  for (const block of blocks) {
    if (!/\*\*scorecard status\*\*:\s*tracked_separately \(branded\)/i.test(block)) continue;
    if (!/\*\*negativeMention\*\*:\s*yes/i.test(block)) continue;
    const prompt = clean(block.match(/^-\s+\*\*prompt\*\*:\s*(.+)$/m)?.[1]);
    const productPosition = clean(block.match(/^-\s+\*\*productPosition\*\*:\s*(.+)$/m)?.[1]);
    const answerSummary = sanitizeSentence(block.match(/^-\s+\*\*answerSummary\*\*:\s*(.+)$/m)?.[1] ?? "");
    const whyClientLost = sanitizeSentence(block.match(/^-\s+\*\*whyClientLost\*\*:\s*(.+)$/m)?.[1] ?? "");
    if (prompt && (answerSummary || whyClientLost)) {
      return { prompt, answerSummary, whyClientLost, productPosition };
    }
  }
  return null;
}

function normalizeEvidenceSummary(value: string): string {
  return clean(value)
    .replace(/^The AI response indicates that\s+/i, "")
    .replace(/^The AI response indicated that\s+/i, "")
    .replace(/^The AI answer indicates that\s+/i, "");
}

function brandedEvidenceBlock(brand: string, evidence: BrandedProbeEvidence | null): string {
  if (!evidence) return "";
  const line = normalizeEvidenceSummary(evidence.answerSummary || evidence.whyClientLost);
  return `
### Direct evidence from the branded check

A buyer asked:

> ${evidence.prompt}

The AI response was summarized as:

> ${line}
`;
}

function trendLine(): string {
  return "**Trend vs previous scan:** — (first scan).";
}

function sanitizeClientMarkdown(markdown: string): string {
  let output = markdown.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test(output)) {
      throw new Error(`Sales report contains internal/debug wording blocked by ${String(pattern)}`);
    }
  }
  return output;
}

export function buildSalesReportFromMvpMarkdown(markdown: string, options: BuildSalesReportOptions = {}): BuildSalesReportResult {
  const brand = extractBullet(markdown, "Brand") || "the brand";
  const domain = extractBullet(markdown, "Domain") || "the website";
  const category = extractBullet(markdown, "Category (Mirror Profile)") || extractBullet(markdown, "Detected category") || "the buying category";
  const aiProbeResult = extractBulletByPrefix(markdown, "AI probe result") || "recommendedAsProduct 0% · citedAsSource 0%";
  const brandedReputation = parseBrandedReputation(markdown);
  const evidenceNeeded = extractSection(markdown, "3\\. Evidence Needed to Unlock Publish-Ready Assets")
    .split(/\r?\n/)
    .map((line) => clean(line.replace(/^-\s+/, "")))
    .filter((line) => line.length > 0 && !/^The following/i.test(line));

  const promptRows = parsePromptRows(markdown);
  const includedRows = promptRows.filter((row) => /^included$/i.test(row.scorecardStatus));
  const lostPrompts = extractLostPrompts(markdown);
  const fixBrief = parseFixBrief(markdown);
  const scorecardRows = getScorecardPrompts(promptRows, fixBrief);
  const brandedRows = getBrandedRows(promptRows);
  const focusCompetitors = chooseFocusCompetitors(markdown, options, fixBrief);
  const competitorMentions = parseCompetitorMentions(markdown);
  const date = options.now ?? DEFAULT_REPORT_DATE;
  const reportDate = date.toISOString().slice(0, 10);
  const selectedPromptCount = parseSelectedPromptCount(markdown);
  const basis = parseScorecardBasis(markdown, includedRows);
  const visibilityLine = visibilityHeadline(markdown, aiProbeResult, basis);
  const tone = visibilityTone(aiProbeResult);
  const brandedEvidence = parseBrandedProbeEvidence(markdown);

  const firstFix = fixBrief.recommendedFix || extractBullet(markdown, "Next recommended fix") || "Publish a focused comparison/alternative page with concrete product and pricing evidence.";
  const firstEvidence = fixBrief.evidenceNeeded.length > 0 ? fixBrief.evidenceNeeded : evidenceNeeded;

  const scorecardTable = scorecardRows.length > 0
    ? scorecardRows.map((row) => {
        const competitors = Array.from(competitorMentions.entries())
          .filter(([name]) => focusCompetitors.includes(name))
          .map(([name, count]) => `${name} (${count})`)
          .slice(0, 4)
          .join(", ") || formatList(focusCompetitors.slice(0, 3));
        return `| ${row.prompt} | ${row.runs} | ${row.recommendedAsProduct} | ${row.citedAsSource} | ${row.productVerdict} | ${competitors} |`;
      }).join("\n")
    : `| ${lostPrompts[0] ?? fixBrief.lostPrompt ?? "Core buyer prompt"} | n/a | 0% | 0% | lost | ${formatList(focusCompetitors.slice(0, 3))} |`;

  const brandedCheckText = extractSubsection(markdown, "Branded reputation check")
    .split(/\r?\n/)
    .map((line) => clean(line))
    .find(Boolean);
  const brandedLine = brandedCheckText || brandedReputation;
  const hiddenPromptCount = includedRows.length - scorecardRows.length;
  const promptFilterNote = hiddenPromptCount > 0
    ? `\n${scorecardRows.length} of ${includedRows.length} unbranded buyer prompts ${scorecardRows.length === 1 ? "is" : "are"} shown below. ${hiddenPromptCount} ${hiddenPromptCount === 1 ? "prompt was" : "prompts were"} excluded from the focused table because ${hiddenPromptCount === 1 ? "it was" : "they were"} outside the selected buying frame; see integrity notes.\n`
    : "";
  const selectedLine = selectedPromptCount
    ? `This snapshot covered ${basis.promptGroups} of the ${selectedPromptCount} highest-value buyer prompts identified for ${brand}. A full scan covers all ${selectedPromptCount} and tracks how visibility and branded reputation change over time.`
    : `This snapshot covered ${basis.promptGroups} buyer prompts for ${brand}. A full scan expands coverage and tracks how visibility and branded reputation change over time.`;

  const markdownOut = sanitizeClientMarkdown(`# Zypact Short Report — ${brand}

Generated: ${reportDate}  
Website: ${domain}  
Category read by AI: ${category}  
${trendLine()}

## 1. Executive diagnosis

**Visibility:** ${visibilityLine}.  
**Branded reputation:** ${brandedReputation}.  
**${competitorHeadlineLabel(tone, aiProbeResult)}:** ${formatList(focusCompetitors.slice(0, 3))}.

${executiveInterpretation(brand, brandedReputation, tone, focusCompetitors)}
${brandedEvidenceBlock(brand, brandedEvidence)}
## 2. What happened in the AI probes
${promptFilterNote}
| Buyer prompt tested | Runs | Recommended ${brand}? | Cited ${brand} as source? | Outcome | Competitors in the same frame |
|---|---:|---:|---:|---|---|
${scorecardTable}

### Branded reputation check

${brandedLine}

This check is tracked separately from the unbranded visibility scorecard. The unbranded scorecard answers: “Does AI suggest the brand spontaneously?” The branded check answers: “What does AI say when the brand is named directly?”

## 3. Why this matters commercially

AI answers increasingly behave like shortlists. When a buyer asks for alternatives or options in a category, brands that appear in the answer get the introduction. Brands that do not appear are invisible at the moment of consideration.

For ${brand}, the ${opportunityLabel(tone)} is:

> ${fixBrief.lostPrompt || lostPrompts[0] || "Alternatives in the core buying category"}

${frameRecommendationSentence(brand, tone, focusCompetitors)}

## 4. First recommended fix

**${fixHeading(tone)}**

${firstFix}

The page should be factual, specific, and evidence-led. It should not claim that AI will recommend ${brand}. The goal is to give AI systems and human buyers a clear, verifiable page that explains where ${brand} fits compared with the brands already appearing in answers.

### Evidence needed before publish-ready copy

${firstEvidence.length > 0 ? firstEvidence.map((item) => `- ${item}`).join("\n") : "- Specific product offerings, pricing details, and proof points that can be verified on the site."}

## 5. Suggested next step

${selectedLine}

Send the evidence listed above and we can generate the publish-ready page draft, verified against that evidence before it is used on the site.

## 6. Integrity notes

- Probe source: live Perplexity Sonar responses from a live scan performed on ${reportDate}.
- Sample size: small snapshot, not a market-wide benchmark.
- Scope: unbranded prompts are used for visibility; branded prompts are tracked separately for reputation.
- No new probes, LLM calls, or database writes are needed to render this short report.
- This report intentionally avoids out-of-frame competitors when a focused Fix Brief provides a narrower competitor set.
`);

  return {
    markdown: markdownOut,
    filename: `${slugify(brand)}-sales-report-14b3.md`,
    summary: {
      brand,
      domain,
      visibilityLine,
      brandedReputation,
      focusCompetitors,
      firstFix,
    },
  };
}
