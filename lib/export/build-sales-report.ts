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

/** Rendered in place of a recommendation when no Fix Brief exists. */
export const NO_FIX_BRIEF_STATEMENT =
  "No evidence-backed recommended fix was produced in this snapshot. " +
  "A fix is only stated once a Fix Brief has been generated from the stored probe evidence.";

/** Rendered in place of a buyer frame when no scored prompt can be extracted. */
export const NO_FOCUS_PROMPT_STATEMENT =
  "No evidence-backed under-performance frame is available in this snapshot.";

/**
 * The full report titles this subsection with the client's own brand:
 *
 *     ### Which prompts ${brandName} lost or under-performed
 *
 * This parser previously matched one literal prospect brand name, so for
 * every other client the section was never found, `lostPrompts` came back
 * empty, and the renderer fell through to a fabricated buyer frame. Matching
 * structurally — fixed words around an arbitrary brand — works for any brand,
 * including names with spaces or punctuation, and for the brandless variant.
 */
const LOST_PROMPTS_HEADING =
  /(?:^|\n)###\s+Which prompts\b[^\n]*?lost or under-performed\s*\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/i;

function extractLostPromptsSection(markdown: string): string {
  return markdown.match(LOST_PROMPTS_HEADING)?.[1]?.trim() ?? "";
}

function extractLostPrompts(markdown: string): string[] {
  const section = extractLostPromptsSection(markdown);
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

interface PromptCompetitorCount {
  name: string;
  count: number;
  bestPosition: number;
  positionTotal: number;
}

function normalizePromptCompetitorKey(
  value: string
): string {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function promptCompetitorNamesMatch(
  left: string,
  right: string
): boolean {
  const a =
    normalizePromptCompetitorKey(left);

  const b =
    normalizePromptCompetitorKey(right);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  return (
    a.length >= 4 &&
    b.length >= 4 &&
    (a.includes(b) || b.includes(a))
  );
}

function parsePromptCompetitorMentions(
  markdown: string
): Map<
  string,
  Map<string, PromptCompetitorCount>
> {
  const result =
    new Map<
      string,
      Map<string, PromptCompetitorCount>
    >();

  const blocks = markdown
    .split(
      /\n### Live Perplexity Sonar probe · product verdict:/i
    )
    .slice(1);

  for (const block of blocks) {
    if (
      !/\*\*scorecard status\*\*:\s*included/i.test(
        block
      )
    ) {
      continue;
    }

    const prompt = clean(
      block.match(
        /^-\s+\*\*prompt\*\*:\s*(.+)$/m
      )?.[1]
    );

    if (!prompt) {
      continue;
    }

    const section =
      block.match(
        /-\s+\*\*competitors mentioned[^*]*\*\*:\s*\n([\s\S]*?)(?=\n-\s+\*\*sources cited|\n##\s+|\n###\s+|\n---|$)/i
      )?.[1] ?? "";

    const promptKey =
      normalizePromptCompetitorKey(prompt);

    const counts =
      result.get(promptKey) ??
      new Map<
        string,
        PromptCompetitorCount
      >();

    for (
      const line of section.split(/\r?\n/)
    ) {
      const cells = line
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => clean(cell));

      if (
        cells.length < 3 ||
        !/^\d+$/.test(cells[0])
      ) {
        continue;
      }

      const position = Number(cells[0]);
      const name = cells[1];

      if (
        !name ||
        !Number.isFinite(position)
      ) {
        continue;
      }

      const competitorKey =
        normalizePromptCompetitorKey(name);

      if (!competitorKey) {
        continue;
      }

      const existing =
        counts.get(competitorKey);

      counts.set(
        competitorKey,
        {
          name:
            existing?.name ?? name,
          count:
            (existing?.count ?? 0) + 1,
          bestPosition:
            Math.min(
              existing?.bestPosition ??
                position,
              position
            ),
          positionTotal:
            (existing?.positionTotal ?? 0) +
            position,
        }
      );
    }

    result.set(promptKey, counts);
  }

  return result;
}

function promptCompetitorsFor(
  prompt: string,
  mentions: Map<
    string,
    Map<string, PromptCompetitorCount>
  >,
  allowedNames?: string[]
): PromptCompetitorCount[] {
  const values = Array.from(
    mentions
      .get(
        normalizePromptCompetitorKey(
          prompt
        )
      )
      ?.values() ?? []
  );

  const filtered =
    allowedNames?.length
      ? values.filter((item) =>
          allowedNames.some((allowed) =>
            promptCompetitorNamesMatch(
              item.name,
              allowed
            )
          )
        )
      : values;

  return filtered.sort(
    (a, b) =>
      a.bestPosition -
        b.bestPosition ||
      b.count - a.count ||
      a.positionTotal / a.count -
        b.positionTotal / b.count ||
      a.name.localeCompare(b.name)
  );
}

function isGenericCompetitorLabel(
  value: string
): boolean {
  const normalized = clean(value).toLowerCase();

  return (
    normalized === "traditional mdr" ||
    normalized === "legacy mdr" ||
    normalized === "mdr" ||
    normalized === "ai-native solutions" ||
    normalized === "ai-native security platforms"
  );
}

function promptLossType(
  prompt: string,
  competitors: PromptCompetitorCount[],
  verdict?: string
): string {
  // A question the brand won is not a loss of any kind, and a partial result
  // is not a clean one. Labelling either as a loss contradicted the outcome
  // column standing next to it.
  const outcome = (verdict ?? "").trim().toLowerCase();
  if (outcome === "won") return "Won — brand recommended";
  if (outcome === "partial") return "Present but not prioritized";
  if (outcome === "not_relevant") return "Not relevant";

  const normalized = clean(prompt).toLowerCase();
  const hasNamedProduct = competitors.some(
    (item) => !isGenericCompetitorLabel(item.name)
  );

  if (
    /alternatives?|best tools?|most effective|platforms? for/i.test(
      normalized
    ) &&
    hasNamedProduct
  ) {
    return "Competitive shortlist loss";
  }

  if (
    /cost benefits?|roi|risks?|compared to|vs\b/i.test(
      normalized
    )
  ) {
    return "Authority / source loss";
  }

  return hasNamedProduct
    ? "Competitive discovery loss"
    : "Category-association loss";
}

/**
 * Provenance of the competitor list on the executive-diagnosis line.
 * Assigned at the branch that selects the list — never inferred afterwards
 * by comparing names, because an observed competitor may also appear in a
 * manually supplied comparison set.
 */
type CompetitorDisplaySource = "observed" | "manual" | "none";

type CompetitorDisplaySelection = {
  competitors: string[];
  source: CompetitorDisplaySource;
};

/**
 * Single resolver for the labelled competitor line: returns the displayed
 * list AND its provenance together, so the label can never contradict the
 * value.
 *
 * Fix Brief competitors are NOT an input. That field comes from the Fix
 * Brief agent's unconstrained `competitorRecommended` string
 * (lib/pipeline/generate-fix-brief.ts; schema `z.string().min(1)`), so it
 * is not guaranteed to be observed AI evidence and no truthful
 * client-facing label exists for it. It falls through to the manual set or
 * the existing empty state.
 */
function resolveCompetitorDisplay(
  observedCompetitorSummary: string[],
  observedReportCompetitors: string[],
  observedFrameCompetitors: string[],
  manualCompetitors: string[] | undefined
): CompetitorDisplaySelection {
  const norm = (items: string[]): string[] => {
    const seen = new Set<string>();
    return items
      .map(clean)
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  if (observedCompetitorSummary.length > 0) {
    return { competitors: observedCompetitorSummary, source: "observed" };
  }

  const reportObserved = norm(observedReportCompetitors);
  if (reportObserved.length > 0) {
    return { competitors: reportObserved.slice(0, 3), source: "observed" };
  }

  // Per-probe observed evidence. Generic contextual labels are excluded
  // using the same predicate the summary path already applies.
  const frameObserved = norm(observedFrameCompetitors).filter(
    (name) => !isGenericCompetitorLabel(name)
  );
  if (frameObserved.length > 0) {
    return { competitors: frameObserved.slice(0, 3), source: "observed" };
  }

  const manual = norm(manualCompetitors ?? []);
  if (manual.length > 0) {
    return { competitors: manual.slice(0, 3), source: "manual" };
  }

  return { competitors: [], source: "none" };
}

function chooseFocusCompetitors(markdown: string, options: BuildSalesReportOptions, fixBrief: FixBriefSummary): string[] {
  const seen = new Set<string>();

  const unique = (items: string[]): string[] =>
    items
      .map(clean)
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

  const observedCompetitors = unique([
    ...splitCsv(extractBullet(markdown, "Top competitors AI recommended instead")),
    ...fixBrief.competitors,
  ]);

  if (observedCompetitors.length > 0) {
    return observedCompetitors.slice(0, 5);
  }

  return unique(options.focusCompetitors ?? []).slice(0, 5);
}

function formatList(items: string[], fallback = "not enough evidence yet"): string {
  const seen = new Set<string>();
  const values = items
    .map(clean)
    .filter(Boolean)
    .filter((item) => {
      const key = item
        .toLowerCase()
        .replace(/\s*\([^)]*\)/g, "")
        .trim();

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

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

function brandedReputationHasNegativeSignal(
  value: string
): boolean {
  const negativeCountMatch =
    value.match(
      /(\d+)\s*\/\s*\d+\s+branded runs negative/i
    );

  if (negativeCountMatch) {
    return Number(negativeCountMatch[1]) > 0;
  }

  const normalized =
    value.toLowerCase();

  return (
    normalized.includes("negative") &&
    !normalized.includes("positive")
  );
}

function brandedReputationWasMeasured(
  value: string
): boolean {
  const normalized = clean(value);

  return !/^(not measured|not tested in this snapshot)$/i.test(
    normalized
  );
}

function brandedReputationDisplay(
  value: string
): string {
  return brandedReputationWasMeasured(value)
    ? clean(value)
    : "Not tested in this snapshot";
}

/**
 * The strategic reading in section 1.
 *
 * `competitors` must be scoped to the SAME buyer question the report goes on
 * to name as the priority frame. It used to receive the project-wide tally,
 * so the summary could tell a client to defend against products that were
 * only recommended for a different question — or, worse, for a question they
 * won — while section 3 named an entirely different set. When the selected
 * question has no competing product on record the clause is dropped rather
 * than backfilled from the global list.
 */
function executiveInterpretation(
  brand: string,
  brandedReputation: string,
  tone: VisibilityTone,
  competitors: string[]
): string {
  // `formatList` substitutes a placeholder for an empty list, which would
  // render as "against not enough evidence yet". Decide on the list itself.
  const hasCompetitors = competitors.length > 0;
  const competitorText =
    formatList(competitors.slice(0, 3));

  const reputationMeasured =
    brandedReputationWasMeasured(
      brandedReputation
    );

  if (tone === "strong") {
    const reputationSentence =
      reputationMeasured
        ? ` When the brand was named directly, the branded reputation check was **${brandedReputation}**, which supports a visibility-consolidation interpretation.`
        : " Branded reputation was not tested in this snapshot.";

    const defence = hasCompetitors
      ? ` and defending the position against ${competitorText} in that frame`
      : "";
    return `${brand} was recommended in most of the unbranded buying prompts tested. The opportunity is not basic recovery from invisibility; it is consolidation — becoming the primary recommendation more often, improving cited-source coverage${defence}.${reputationSentence}`;
  }

  if (tone === "mixed") {
    const reputationSentence =
      reputationMeasured
        ? ` When the brand was named directly, the branded reputation check was **${brandedReputation}**.`
        : " Branded reputation was not tested in this snapshot.";

    const against = hasCompetitors
      ? ` against ${competitorText} in the buying frame below`
      : "";
    return `${brand} was recommended in some of the unbranded buyer runs tested, but not consistently as the primary recommendation. The opportunity is to consolidate that visibility into a stronger primary shortlist position${against}.${reputationSentence}`;
  }

  if (
    reputationMeasured &&
    brandedReputationHasNegativeSignal(
      brandedReputation
    )
  ) {
    return `${brand} did not appear as a recommended product in the unbranded buying prompts tested. When the brand was named directly, the branded reputation check was **${brandedReputation}**. The result combines a discovery gap with a negative branded signal that should be reviewed.`;
  }

  if (!reputationMeasured) {
    return `${brand} did not appear as a recommended product in the unbranded buying prompts tested. Branded reputation was not tested in this snapshot. This identifies a discoverability gap without making a claim about branded reputation.`;
  }

  return `${brand} did not appear as a recommended product in the unbranded buying prompts tested. When the brand was named directly, the branded reputation check was **${brandedReputation}**. This points to a discoverability gap, not a negative reputation signal.`;
}

function competitorHeadlineLabel(
  tone: string,
  aiProbeResult: string,
  hasManualComparisonSet: boolean
): string {
  if (hasManualComparisonSet) {
    return "Comparison set selected for this scan";
  }

  const normalizedTone = String(tone || "").toLowerCase();

  if (
    normalizedTone === "strong" ||
    normalizedTone === "winning" ||
    normalizedTone === "positive"
  ) {
    return "Other tools AI recommended across the tested prompts";
  }

  const normalizedScorecard = String(aiProbeResult || "").replace(/\s+/g, " ");

  const lostMatch =
    normalizedScorecard.match(/(\d+)\s+lost\b/i) ||
    normalizedScorecard.match(/lost\s*[:=]\s*(\d+)/i);

  const lostGroups = lostMatch ? Number(lostMatch[1]) : 0;

  if (lostGroups > 0) {
    return "Competitors AI recommended across the tested prompts";
  }

  const recommendedRateMatch =
    normalizedScorecard.match(/recommendedAsProduct\s+(\d+(?:\.\d+)?)%/i) ||
    normalizedScorecard.match(/(\d+(?:\.\d+)?)%\s+recommended/i);

  const recommendedRate = recommendedRateMatch ? Number(recommendedRateMatch[1]) : 0;

  if (normalizedTone === "mixed" || recommendedRate > 0) {
    return "Other tools AI recommended in the same frame";
  }

  return "Competitors AI recommended across the tested prompts";
}

function opportunityLabel(tone: VisibilityTone): string {
  if (tone === "strong") return "clearest consolidation opportunity";
  if (tone === "mixed") return "clearest under-performance opportunity";
  return "clearest buying-frame loss";
}

function frameRecommendationSentence(
  brand: string,
  tone: VisibilityTone,
  competitors: string[]
): string {
  if (competitors.length === 0) {
    if (tone === "strong") {
      return `In that frame, ${brand} was present and no other specific product was observed in the stored prompt-level runs.`;
    }

    if (tone === "mixed") {
      return `In that frame, ${brand} appeared inconsistently, and no specific competing product was observed in the stored prompt-level runs.`;
    }

    return "In that frame, no specific competing product was recommended in the stored runs; the answers focused on general strategies instead.";
  }

  const competitorText =
    formatList(
      competitors.slice(0, 4)
    );

  if (tone === "strong") {
    return `In that frame, ${brand} was present, but AI still surfaced ${competitorText} prominently.`;
  }

  if (tone === "mixed") {
    return `In that frame, AI also recommended ${competitorText}, so ${brand} is not yet the clear primary choice.`;
  }

  return `In that frame, AI recommended ${competitorText} instead.`;
}

function fixHeading(
  tone: VisibilityTone,
  hasFrameCompetitors: boolean
): string {
  if (!hasFrameCompetitors) {
    return "Publish an answer-first, evidence-backed page for the missing buyer question.";
  }

  return tone === "strong"
    ? "Strengthen comparison / proof content around the consolidation frame."
    : "Strengthen comparison / proof content around the under-performing buying frame.";
}

function normalizeFixText(value: string): string {
  const text = clean(value)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  const withoutBrokenTail = text
    .replace(
      /\b(emphasi|emphasiz|positioni|compariso|competi|outlin|capabilit)\s*$/i,
      ""
    )
    .replace(/[,:;\s]+$/g, "")
    .trim();

  if (!withoutBrokenTail) return "";

  return /[.!?]$/.test(withoutBrokenTail)
    ? withoutBrokenTail
    : `${withoutBrokenTail}.`;
}

function frameAwareFix(
  brand: string,
  focusPrompt: string,
  frameCompetitors: string[],
  originalFix: string
): string {
  const cleanedOriginalFix =
    normalizeFixText(originalFix);

  if (
    frameCompetitors.length > 0 &&
    cleanedOriginalFix
  ) {
    return cleanedOriginalFix;
  }

  return normalizeFixText(`Publish an answer-first page that directly addresses “${clean(
    focusPrompt
  )}” for ${brand}'s target audience. Explain the documented methodology, concrete steps, and verifiable evidence without framing the page as a competitor comparison.`);
}

function fixSafetySentence(
  brand: string,
  hasFrameCompetitors: boolean
): string {
  if (hasFrameCompetitors) {
    return `The page should be factual, specific, and evidence-led. It should not claim that AI will recommend ${brand}. The goal is to give AI systems and human buyers a clear, verifiable page that explains where ${brand} fits compared with the brands actually appearing in those prompt-matched runs.`;
  }

  return `The page should be factual, specific, and evidence-led. It should not claim that AI will recommend ${brand}. The goal is to answer the buyer question clearly using ${brand}'s documented methodology and verifiable evidence.`;
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
  const brandedReputationRaw =
    parseBrandedReputation(markdown);

  const brandedReputation =
    brandedReputationDisplay(
      brandedReputationRaw
    );
  const evidenceNeeded = extractSection(markdown, "3\\. Evidence Needed to Unlock Publish-Ready Assets")
    .split(/\r?\n/)
    .map((line) => clean(line.replace(/^-\s+/, "")))
    .filter((line) => line.length > 0 && !/^The following/i.test(line));

  const promptRows = parsePromptRows(markdown);
  const includedRows = promptRows.filter((row) => /^included$/i.test(row.scorecardStatus));
  const lostPrompts = extractLostPrompts(markdown);
  const fixBrief = parseFixBrief(markdown);
  const scorecardRows = includedRows;
  const brandedRows = getBrandedRows(promptRows);
  const focusCompetitors = chooseFocusCompetitors(markdown, options, fixBrief);
  const promptCompetitorMentions =
    parsePromptCompetitorMentions(markdown);

  const observedCompetitorMentions =
    Array.from(
      parseCompetitorMentions(markdown)
        .entries()
    )
      .filter(
        ([name, count]) =>
          count > 0 &&
          !isGenericCompetitorLabel(name)
      )
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          a[0].localeCompare(b[0])
      )
      .slice(0, 4);

  const observedCompetitorSummary =
    observedCompetitorMentions.map(
      ([name, count]) =>
        `${name} — ${count} ${
          count === 1
            ? "mention"
            : "mentions"
        }`
    );

  // Only a prompt that genuinely appears in the report may frame the
  // commercial argument. The previous literal fallback invented a buyer frame
  // present in no stored run — exactly the claim this report must never make.
  const focusPrompt =
    fixBrief.lostPrompt ||
    lostPrompts[0] ||
    "";
  const hasFocusPrompt = focusPrompt !== "";

  /**
   * A Fix Brief is the only sanctioned source of a recommended fix.
   *
   * `parseFixBrief` returns empty strings when the full report says "No Fix
   * Brief generated yet", so a real brief is one that actually carries a
   * recommendation.
   */
  const hasFixBrief = fixBrief.recommendedFix.trim() !== "";

  const frameCompetitorRows =
    promptCompetitorsFor(
      focusPrompt,
      promptCompetitorMentions,
      options.focusCompetitors
    );

  const frameCompetitors =
    frameCompetitorRows.map(
      (item) => item.name
    );

  const date = options.now ?? new Date();
  const reportDate = date.toISOString().slice(0, 10);

  const competitorDisplay = resolveCompetitorDisplay(
    observedCompetitorSummary,
    splitCsv(extractBullet(markdown, "Top competitors AI recommended instead")),
    frameCompetitors,
    options.focusCompetitors
  );

  const basis = parseScorecardBasis(markdown, includedRows);
  const visibilityLine = visibilityHeadline(markdown, aiProbeResult, basis);
  const tone = visibilityTone(aiProbeResult);
  const brandedEvidence =
    brandedReputationWasMeasured(
      brandedReputationRaw
    )
      ? parseBrandedProbeEvidence(
          markdown
        )
      : null;

  /**
   * The recommended fix is rendered from the persisted Fix Brief and nothing
   * else.
   *
   * Previously this fell back to a "Next recommended fix" bullet and then to
   * a hardcoded sentence, and passed the result through `frameAwareFix`
   * unconditionally. A snapshot whose full report said "No Fix Brief
   * generated yet" therefore still shipped a confident "First recommended
   * fix" to the client — a recommendation with no evidence behind it.
   *
   * `frameAwareFix` is only reachable inside this branch, so no absent-brief
   * path can invoke it.
   */
  const firstFix = hasFixBrief
    ? frameAwareFix(
        brand,
        focusPrompt,
        frameCompetitors,
        fixBrief.recommendedFix
      )
    : NO_FIX_BRIEF_STATEMENT;

  const firstEvidence =
    fixBrief.evidenceNeeded.length > 0
      ? fixBrief.evidenceNeeded
      : evidenceNeeded;

  const firstFixSafetySentence =
    fixSafetySentence(
      brand,
      frameCompetitors.length > 0
    );

  const scorecardTable =
    scorecardRows.length > 0
      ? scorecardRows
          .map((row) => {
            const rowCompetitors =
              promptCompetitorsFor(
                row.prompt,
                promptCompetitorMentions
              );

            const namedCompetitors =
              rowCompetitors.filter(
                (item) =>
                  !isGenericCompetitorLabel(
                    item.name
                  )
              );

            const hasGenericComparison =
              rowCompetitors.some(
                (item) =>
                  isGenericCompetitorLabel(
                    item.name
                  )
              );

            const competitorCell =
              namedCompetitors.length > 0
                ? namedCompetitors
                    .slice(0, 4)
                    .map(
                      (item) =>
                        `${item.name} (${item.count})`
                    )
                    .join(", ")
                : hasGenericComparison
                  ? "AI compared the category with traditional MDR; no specific competing brand dominated these runs"
                  : "No specific products were recommended in these runs";

            const lossType =
              promptLossType(
                row.prompt,
                rowCompetitors,
                row.productVerdict
              );

            return `| ${row.prompt} | ${row.runs} | ${row.recommendedAsProduct} | ${row.citedAsSource} | ${row.productVerdict} | ${lossType} | ${competitorCell} |`;
          })
          .join("\n")
      : `| ${focusPrompt} | n/a | 0% | 0% | lost | Category-association loss | No prompt-matched competitor evidence was available |`;

  const brandedCheckText = extractSubsection(markdown, "Branded reputation check")
    .split(/\r?\n/)
    .map((line) => clean(line))
    .find(Boolean);
  const brandedLine = brandedCheckText || brandedReputation;
  const promptFilterNote =
    includedRows.length > 0
      ? `\nAll ${includedRows.length} tested buyer prompts are shown below. Each prompt was run ${includedRows[0]?.runs || "multiple"} times using live AI answers.\n`
      : "";
  const selectedLine = `This snapshot covered ${basis.promptGroups} targeted buyer prompts for ${brand}. A fuller recurring scan can expand the prompt set, add branded reputation checks, and track whether ${brand} gains or loses visibility over time.`;

  const markdownOut = sanitizeClientMarkdown(`# Zypact Short Report — ${brand}

Generated: ${reportDate}  
Website: ${domain}  
Category read by AI: ${category}  
${trendLine()}

## 1. Executive diagnosis

**Visibility:** ${visibilityLine}.  
**Branded reputation:** ${brandedReputation}.  
**${
  competitorHeadlineLabel(
    tone,
    aiProbeResult,
    competitorDisplay.source === "manual"
  )
}:** ${formatList(competitorDisplay.competitors)}.

${executiveInterpretation(brand, brandedReputation, tone, frameCompetitors)}
${brandedEvidenceBlock(brand, brandedEvidence)}
## 2. What happened in the AI probes
${promptFilterNote}
| Buyer prompt tested | Runs | Recommended ${brand}? | Cited ${brand} as source? | Outcome | Result type | Brands / products observed |
|---|---:|---:|---:|---|---|---|
${scorecardTable}

### Branded reputation check

${brandedLine}

${
  brandedReputationWasMeasured(
    brandedReputationRaw
  )
    ? "This check is tracked separately from the unbranded visibility scorecard. The unbranded scorecard answers: “Does AI suggest the brand spontaneously?” The branded check answers: “What does AI say when the brand is named directly?”"
    : "No branded reputation probe was included in this snapshot, so this report makes no positive or negative claim about what AI says when the brand is named directly."
}

## 3. Why this matters commercially

AI answers increasingly behave like shortlists. When a buyer asks for alternatives or options in a category, brands that appear in the answer get the introduction. Brands that do not appear are invisible at the moment of consideration.

${
  hasFocusPrompt
    ? `For ${brand}, the ${opportunityLabel(tone)} is:

> ${focusPrompt}

${frameRecommendationSentence(brand, tone, frameCompetitors)}`
    : NO_FOCUS_PROMPT_STATEMENT
}

## 4. First recommended fix

${
  hasFixBrief
    ? `**${fixHeading(tone, frameCompetitors.length > 0)}**

${firstFix}

${firstFixSafetySentence}`
    : firstFix
}

${
  hasFixBrief
    ? `### Evidence needed before publish-ready copy

${firstEvidence.length > 0 ? firstEvidence.map((item) => `- ${item}`).join("\n") : "- Specific product offerings, pricing details, and proof points that can be verified on the site."}`
    : ""
}

## 5. Suggested next step

${selectedLine}

Send the evidence listed above and we can generate the publish-ready page draft, verified against that evidence before it is used on the site.

## 6. Integrity notes

- Probe source: live Perplexity Sonar responses from the stored scan for this project. This report was generated on ${reportDate}; that is the render date, not the scan date.
- Sample size: small snapshot, not a market-wide benchmark.
- Scope: unbranded prompts are used for visibility; branded prompts are tracked separately for reputation.
- No new probes, LLM calls, or database writes are needed to render this short report.
- Competitors shown in each table row and any “In that frame” statement come only from the stored runs for that exact prompt.
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
