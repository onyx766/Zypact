import type { GapMapRow, ProbeResult } from "@/lib/db/types";

export type ReportProbeMode = "simulated" | "live_perplexity";

export type PromptGroupVerdict = "won" | "partial" | "lost" | "not_relevant";

export interface PromptProbeAggregate {
  key: string;
  prompt: string;
  generatedPromptId: string | null;
  isBranded: boolean;
  runs: number;
  won: number;
  partial: number;
  lost: number;
  notRelevant: number;
  clientMentionedRuns: number;
  primaryRuns: number;
  mentionRate: number;
  primaryRate: number;
  productMentionedRuns: number;
  productPrimaryRuns: number;
  negativeMentionRuns: number;
  productRecommendationRate: number;
  productPrimaryRate: number;
  negativeMentionRate: number;
  citedAsSourceRuns: number;
  sourceCitationRate: number;
  verdict: PromptGroupVerdict;
  latestCreatedAt: string;
  rows: ProbeResult[];
}

export interface ProbeSetSummary {
  /** Perplexity and simulated rows: the rows this summary reads. */
  total: number;
  livePerplexity: number;
  simulated: number;
  /**
   * D-061 — ChatGPT rows (probe mode `live_openai_chatgpt`) given to the
   * summary and left out of every figure in it: they are neither live
   * Perplexity nor simulated.
   */
  chatGptRowsLeftOut: number;
  includedMode: ReportProbeMode;
  excludedModes: ReportProbeMode[];
  mainProbeResults: ProbeResult[];
  historicalProbeResults: ProbeResult[];
  promptGroups: PromptProbeAggregate[];
  unbrandedPromptGroups: PromptProbeAggregate[];
  brandedPromptGroups: PromptProbeAggregate[];
  scorecardPromptGroups: PromptProbeAggregate[];
  scorecardProbeResults: ProbeResult[];
  scorecardUsesUnbranded: boolean;
  latestMainProbeCreatedAt: string | null;
  latestLiveProbeCreatedAt: string | null;
  gapMapStale: boolean;
}

export interface ProbeSelectionOptions {
  brandTerms?: string[];
}

function timeValue(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function isLive(row: ProbeResult): boolean {
  return row.probeMode === "live_perplexity";
}

/**
 * D-061 — a ChatGPT answer (probe mode `live_openai_chatgpt`). The legacy
 * request report reads Perplexity and simulated answers only: a ChatGPT row
 * is neither live Perplexity nor simulated, and adding it to a Perplexity
 * figure would combine two engines (D-053 item 3). Every reader here leaves
 * it out.
 */
export function isChatGptProbeRow(row: Pick<ProbeResult, "probeMode">): boolean {
  return row.probeMode === "live_openai_chatgpt";
}

/** D-061 — the rows a legacy Perplexity reader may read: every row but ChatGPT's. */
export function withoutChatGptRows<T extends Pick<ProbeResult, "probeMode">>(rows: T[]): T[] {
  return rows.filter((r) => !isChatGptProbeRow(r));
}

function keyForPrompt(row: ProbeResult): string {
  const prompt = row.prompt.trim().toLowerCase().replace(/\s+/g, " ");
  if (prompt) return `prompt:${prompt}`;
  if (row.generatedPromptId) return `id:${row.generatedPromptId}`;
  return `row:${row.id}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBrandTerms(terms: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of terms ?? []) {
    const term = raw.trim();
    if (!term || term.length < 3) continue;
    out.add(term);
    const stem = term.split(".")[0]?.trim();
    if (stem && stem.length >= 3) out.add(stem);
  }
  return [...out];
}

export function isBrandedPrompt(prompt: string, brandTerms: string[] | undefined): boolean {
  const terms = normalizeBrandTerms(brandTerms);
  if (terms.length === 0) return false;
  return terms.some((term) => {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i");
    return re.test(prompt);
  });
}

export function sortProbeResultsNewestFirst(rows: ProbeResult[]): ProbeResult[] {
  return [...rows].sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt));
}

/**
 * Sprint 13A.2 — main report probe selection.
 *
 * If live Perplexity exists, the client-facing report uses all live
 * Perplexity rows. We intentionally do NOT de-duplicate live rows by prompt
 * anymore: multi-run probes need every run so mentionRate can be computed.
 * Older simulated rows remain visible as historical/test context.
 *
 * D-061 — a ChatGPT row is never selected, as live or as simulated.
 */
export function selectMainReportProbeResults(rows: ProbeResult[]): ProbeResult[] {
  const sorted = sortProbeResultsNewestFirst(withoutChatGptRows(rows));
  const live = sorted.filter(isLive);
  return live.length > 0 ? live : sorted;
}


function authoritativeProductPosition(row: ProbeResult): string {
  return row.clientPosition || row.productPosition || "absent";
}

function rowProductVerdict(row: ProbeResult): PromptGroupVerdict {
  const pos = authoritativeProductPosition(row);
  if (pos === "primary") return "won";
  if (pos === "listed") return "partial";
  return "lost";
}

function rowRecommendedAsProduct(row: ProbeResult): boolean {
  const pos = authoritativeProductPosition(row);
  return pos === "primary" || pos === "listed";
}

export function buildPromptProbeAggregates(
  rows: ProbeResult[],
  options: ProbeSelectionOptions = {},
): PromptProbeAggregate[] {
  // D-061 — a ChatGPT row is never part of a legacy aggregate.
  const sorted = sortProbeResultsNewestFirst(withoutChatGptRows(rows));
  const byKey = new Map<string, ProbeResult[]>();
  for (const row of sorted) {
    const key = keyForPrompt(row);
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const groups: PromptProbeAggregate[] = [];
  for (const [key, groupRows] of byKey.entries()) {
    const rowsNewest = sortProbeResultsNewestFirst(groupRows);
    const runs = rowsNewest.length;
    const won = rowsNewest.filter((r) => rowProductVerdict(r) === "won").length;
    const partial = rowsNewest.filter((r) => rowProductVerdict(r) === "partial").length;
    const lost = rowsNewest.filter((r) => rowProductVerdict(r) === "lost").length;
    const notRelevant = rowsNewest.filter((r) => rowProductVerdict(r) === "not_relevant").length;
    const clientMentionedRuns = rowsNewest.filter((r) => r.clientMentioned).length;
    const primaryRuns = rowsNewest.filter((r) => r.clientPosition === "primary").length;
    const mentionRate = runs > 0 ? clientMentionedRuns / runs : 0;
    const primaryRate = runs > 0 ? primaryRuns / runs : 0;
    const productMentionedRuns = rowsNewest.filter(rowRecommendedAsProduct).length;
    const productPrimaryRuns = rowsNewest.filter((r) => authoritativeProductPosition(r) === "primary").length;
    const negativeMentionRuns = rowsNewest.filter((r) => authoritativeProductPosition(r) === "negative").length;
    const productRecommendationRate = runs > 0 ? productMentionedRuns / runs : 0;
    const productPrimaryRate = runs > 0 ? productPrimaryRuns / runs : 0;
    const negativeMentionRate = runs > 0 ? negativeMentionRuns / runs : 0;
    const citedAsSourceRuns = rowsNewest.filter((r) => r.citedAsSource).length;
    const sourceCitationRate = runs > 0 ? citedAsSourceRuns / runs : 0;

    let verdict: PromptGroupVerdict = "lost";
    if (runs > 0 && notRelevant === runs) verdict = "not_relevant";
    else if (won / Math.max(1, runs) >= 0.5 || productPrimaryRate >= 0.5) verdict = "won";
    else if (productRecommendationRate > 0 || partial > 0) verdict = "partial";

    const first = rowsNewest[0]!;
    groups.push({
      key,
      prompt: first.prompt,
      generatedPromptId: first.generatedPromptId,
      isBranded: isBrandedPrompt(first.prompt, options.brandTerms),
      runs,
      won,
      partial,
      lost,
      notRelevant,
      clientMentionedRuns,
      primaryRuns,
      mentionRate,
      primaryRate,
      productMentionedRuns,
      productPrimaryRuns,
      negativeMentionRuns,
      productRecommendationRate,
      productPrimaryRate,
      negativeMentionRate,
      citedAsSourceRuns,
      sourceCitationRate,
      verdict,
      latestCreatedAt: first.createdAt,
      rows: rowsNewest,
    });
  }

  return groups.sort((a, b) => timeValue(b.latestCreatedAt) - timeValue(a.latestCreatedAt));
}

export function buildProbeSetSummary(
  rows: ProbeResult[],
  gapMap: GapMapRow | null = null,
  options: ProbeSelectionOptions = {},
): ProbeSetSummary {
  // D-061 — ChatGPT rows are counted as left out, and read nowhere below:
  // not as live Perplexity, not as simulated, not as historical.
  const read = withoutChatGptRows(rows);
  const sorted = sortProbeResultsNewestFirst(read);
  const live = sorted.filter(isLive);
  const simulated = sorted.filter((r) => !isLive(r));
  const mainProbeResults = selectMainReportProbeResults(sorted);
  const mainIds = new Set(mainProbeResults.map((r) => r.id));
  const historicalProbeResults = sorted.filter((r) => !mainIds.has(r.id));
  const promptGroups = buildPromptProbeAggregates(mainProbeResults, options);
  const unbrandedPromptGroups = promptGroups.filter((g) => !g.isBranded);
  const brandedPromptGroups = promptGroups.filter((g) => g.isBranded);
  const scorecardUsesUnbranded = unbrandedPromptGroups.length > 0;
  const scorecardPromptGroups = scorecardUsesUnbranded ? unbrandedPromptGroups : promptGroups;
  const scorecardKeys = new Set(scorecardPromptGroups.map((g) => g.key));
  const scorecardProbeResults = mainProbeResults.filter((r) => scorecardKeys.has(keyForPrompt(r)));
  const latestLiveProbeCreatedAt = live[0]?.createdAt ?? null;
  const latestMainProbeCreatedAt = mainProbeResults[0]?.createdAt ?? null;
  const gapMapStale = Boolean(
    gapMap && latestLiveProbeCreatedAt && timeValue(gapMap.createdAt) < timeValue(latestLiveProbeCreatedAt)
  );

  return {
    total: read.length,
    livePerplexity: live.length,
    simulated: simulated.length,
    chatGptRowsLeftOut: rows.length - read.length,
    includedMode: live.length > 0 ? "live_perplexity" : "simulated",
    excludedModes: live.length > 0 && simulated.length > 0 ? ["simulated"] : [],
    mainProbeResults,
    historicalProbeResults,
    promptGroups,
    unbrandedPromptGroups,
    brandedPromptGroups,
    scorecardPromptGroups,
    scorecardProbeResults,
    scorecardUsesUnbranded,
    latestMainProbeCreatedAt,
    latestLiveProbeCreatedAt,
    gapMapStale,
  };
}

export function probeSetLabel(summary: ProbeSetSummary): string {
  return summary.includedMode === "live_perplexity"
    ? "live Perplexity"
    : "simulated";
}
