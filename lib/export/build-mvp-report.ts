/**
 * Sprint 11 — Secure Read-Only Markdown Export.
 * Sprint 11.5 — Client-facing readability improvements (this file):
 *
 *   - Executive Summary added at the top.
 *   - Publishability status + aggregated "Evidence needed" surfaced
 *     before technical detail.
 *   - Probe results honestly labeled as simulated or live Perplexity.
 *     No report is allowed to imply "ChatGPT said …" without the
 *     persisted probe origin.
 *   - Recommended Next Actions turns each prioritized gap into a
 *     concrete website action (comparison page, FAQ block, proof block,
 *     JSON-LD schema).
 *   - Generated assets are grouped by publish status.
 *   - Technical metadata (projectId, provider, model, mockMode,
 *     timestamps, exportFormatVersion) is moved into a final
 *     "Appendix — Technical metadata" section.
 *   - companyName falls back from project → Mirror Profile → domain.
 *   - `NOT READY TO PUBLISH` now carries QA context so it does not
 *     read as failure.
 *
 * ## Hard invariants (unchanged from Sprint 11)
 *
 *   - Pure function. No DB writes. No LLM calls. No env access for
 *     secrets — the caller passes redaction inputs explicitly.
 *   - Dynamic-fence wrapping for asset content, minimum 4 backticks.
 *   - Two-layer secret sweep (explicit values + well-known prefixes).
 *
 * ## Deferred (Sprint 12 backlog — not built here)
 *
 *   - `probeMode` column on `probe_runs` / `probe_results` + backfill
 *     migration. Sprint 13 supports `live_perplexity`.
 *   - Deterministic QA violation layer (fabricated URLs, faq_block Q&A
 *     shape, proof_block evidence-bank references).
 *   - Evidence Bank provenance auto-fill.
 *   - QA merging: deterministic violations merged with LLM QA output.
 *   - Asset auto-repair based on merged QA output.
 *
 * All of the above require new engine features and were intentionally
 * left out of this sprint per the "Do not build new features" rule.
 */

import type {
  Project,
  MirrorProfileRow,
  GeneratedPrompt,
  ProbeMode,
  ProbeResult,
  Competitor,
  GapMapRow,
  Gap,
  EvidenceBankProvenance,
  EvidenceBankRow,
  FixBriefRow,
  GeneratedAssetRow,
  QaReportRow,
} from "@/lib/db/types";
import { buildProbeSetSummary, isBrandedPrompt, probeSetLabel, type PromptProbeAggregate } from "@/lib/probe-results/report-selection";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";

export const EXPORT_FORMAT_VERSION = 3;

/** Marker emitted whenever the secret sweep redacts a match. */
export const REDACTED_MARKER = "[REDACTED]";

/**
 * Section titles kept aligned with the client-facing narrative. The
 * appendix (Technical metadata) is the last section by design.
 */
export const REPORT_SECTIONS = [
  "1. Executive Summary",
  "2. Publishability Status",
  "3. Evidence Needed to Unlock Publish-Ready Assets",
  "4. Project Summary",
  "5. Mirror Profile",
  "6. Prompt Mirror summary",
  "7. Probe Results",
  "8. What this means",
  "9. Competitors",
  "10. Recommendation Gap Map",
  "11. Recommended Next Actions",
  "12. Evidence Bank",
  "13. Fix Brief",
  "14. Generated Assets",
  "15. QA Review",
  "16. Unsafe / needs-evidence warnings",
  "17. Known limitations",
  "18. Blocked fixes",
  "19. Appendix — Technical metadata",
] as const;

// `ProbeMode` is now re-exported from `lib/db/types` — kept here for
// backwards import compatibility with callers that pulled it from this
// module in Sprint 11.5.
export type { ProbeMode } from "@/lib/db/types";

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface BuildMvpReportInput {
  project: Project;
  mirrorProfile: MirrorProfileRow | null;
  prompts: GeneratedPrompt[];
  probeResults: ProbeResult[];
  competitors: Competitor[];
  gapMap: GapMapRow | null;
  gaps: Gap[];
  evidenceBank: EvidenceBankRow | null;
  fixBriefs: FixBriefRow[];
  assets: GeneratedAssetRow[];
  /** Latest QA report keyed by generated asset id. May be missing for pending assets. */
  latestQaByAsset: Map<string, QaReportRow>;
  /** Traceability: LLM provider actually used for this project's agents. */
  llmProvider?: string | null;
  /** Traceability: LLM model actually used for this project's agents. */
  llmModel?: string | null;
  /** Traceability: whether the agents ran in mock mode. */
  mockMode?: boolean;
  /** Timestamp override for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Any literal string in this list will be replaced with [REDACTED] in
   * the final markdown. Pass every known secret env var value.
   */
  sensitiveValues?: string[];
}

export interface BuildMvpReportOutput {
  markdown: string;
  filename: string;
  qaDistribution: Record<string, number>;
  /**
   * Sprint 11.5 addition — counts by publish-status bucket so callers can
   * surface a matching UI/warning without re-parsing the markdown.
   */
  publishability: {
    total: number;
    publishReady: number;
    needsEvidence: number;
    unsupportedClaims: number;
    pendingQa: number;
    qaFailed: number;
  };
  warnings: {
    secretsRedactedCount: number;
    notReadyAssetCount: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Dynamic fence helpers (unchanged; exported for unit tests)                */
/* -------------------------------------------------------------------------- */

export function longestBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 96 /* ` */) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

export function computeDynamicFence(content: string): string {
  const longest = longestBacktickRun(content);
  const len = Math.max(4, longest + 1);
  return "`".repeat(len);
}

export function wrapAssetContent(content: string, infoString: string): string {
  const fence = computeDynamicFence(content);
  const info = infoString.trim();
  return `${fence}${info}\n${content}\n${fence}`;
}

/* -------------------------------------------------------------------------- */
/*  Secret sweep (unchanged; exported for unit tests)                         */
/* -------------------------------------------------------------------------- */

export function redactSensitive(
  input: string,
  sensitiveValues: string[]
): { output: string; redactionCount: number } {
  let output = input;
  let count = 0;

  const uniqueValues = Array.from(
    new Set(sensitiveValues.filter((v) => typeof v === "string" && v.length >= 8))
  );

  for (const value of uniqueValues) {
    if (!value) continue;
    if (output.includes(value)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      output = output.replace(re, () => {
        count += 1;
        return REDACTED_MARKER;
      });
    }
  }

  const prefixPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bsb_secret_[A-Za-z0-9_-]{10,}\b/g, label: "sb_secret_" },
    { re: /\bsk-live-[A-Za-z0-9_-]{10,}\b/g, label: "sk-live-" },
    { re: /\bsk-proj-[A-Za-z0-9_-]{10,}\b/g, label: "sk-proj-" },
    { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "sk-" },
  ];
  for (const p of prefixPatterns) {
    output = output.replace(p.re, () => {
      count += 1;
      return REDACTED_MARKER;
    });
  }

  return { output, redactionCount: count };
}

/* -------------------------------------------------------------------------- */
/*  Small formatting helpers                                                  */
/* -------------------------------------------------------------------------- */

function mdEscape(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function safeString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "_none_";
  return items.map((it) => `- ${it}`).join("\n");
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function isoDay(now: Date): string {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
}

function nice(dt: string | null | undefined): string {
  if (!dt) return "n/a";
  return dt;
}

function truthyLimit<T>(list: T[], max: number): T[] {
  return list.slice(0, max);
}

function assetTypeToInfoString(assetType: string): string {
  return assetType === "json_ld_schema" ? "json" : "asset-markdown";
}

function isNotReadyToPublish(qaStatus: string): boolean {
  return (
    qaStatus === "pending_qa" ||
    qaStatus === "needs_evidence" ||
    qaStatus === "unsupported_claims" ||
    qaStatus === "qa_failed"
  );
}

/* -------------------------------------------------------------------------- */
/*  Sprint 11.5 helpers — brand name, probe mode, categories, actions          */
/* -------------------------------------------------------------------------- */

/**
 * companyName fallback:
 *   1. `project.companyName` if non-empty
 *   2. `mirrorProfile.json.companyName` if non-empty
 *   3. `project.domain` (last resort)
 */
export function resolveCompanyName(
  project: Project,
  mirrorProfile: MirrorProfileRow | null
): { name: string; source: "project" | "mirror_profile" | "domain" } {
  const p = project.companyName?.trim();
  if (p) return { name: p, source: "project" };
  const j = mirrorProfile?.json as { companyName?: unknown } | null | undefined;
  const mp =
    typeof j?.companyName === "string" ? j.companyName.trim() : "";
  if (mp) return { name: mp, source: "mirror_profile" };
  return { name: project.domain, source: "domain" };
}

/**
 * Sprint 12 — reads the persisted `probeMode` off a probe row. Migration
 * `0012` backfilled every existing row to `"simulated"`; Sprint 13
 * writes `probeMode: "live_perplexity"` for Perplexity Sonar answers.
 *
 * Passing `null` is treated as "no row available" and returns
 * `"simulated"` — the safest default when a row is missing from an
 * aggregate roll-up.
 */
export function deriveProbeMode(row: ProbeResult | null): ProbeMode {
  if (!row) return "simulated";
  return row.probeMode === "live_perplexity" ? "live_perplexity" : "simulated";
}

/**
 * Roll a full `ProbeResult[]` into a single sentinel value for
 * report metadata. If any row is `live_perplexity`, the report advertises
 * live Perplexity; otherwise simulated. Mixed sets show `mixed`.
 */
export type AggregateProbeMode = "simulated" | "live_perplexity" | "mixed" | "none";

export function aggregateProbeMode(rows: ProbeResult[]): AggregateProbeMode {
  if (rows.length === 0) return "none";
  let sawLivePerplexity = false;
  let sawSim = false;
  for (const r of rows) {
    if (r.probeMode === "live_perplexity") sawLivePerplexity = true;
    else sawSim = true;
  }
  if (sawLivePerplexity && sawSim) return "mixed";
  return sawLivePerplexity ? "live_perplexity" : "simulated";
}

function reportBrandTerms(input: BuildMvpReportInput, brandName?: string): string[] {
  const terms = new Set<string>();
  if (brandName?.trim()) terms.add(brandName.trim());
  if (input.project.companyName?.trim()) terms.add(input.project.companyName.trim());
  if (input.project.domain?.trim()) terms.add(input.project.domain.trim());
  const j = input.mirrorProfile?.json as { companyName?: unknown; website?: unknown } | null | undefined;
  if (typeof j?.companyName === "string" && j.companyName.trim()) terms.add(j.companyName.trim());
  if (typeof j?.website === "string" && j.website.trim()) terms.add(j.website.trim());
  return [...terms];
}

function getProbeSet(input: BuildMvpReportInput, brandName?: string) {
  return buildProbeSetSummary(input.probeResults, input.gapMap, {
    brandTerms: reportBrandTerms(input, brandName),
  });
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function timeValueForReport(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function isFixBriefStaleForProbeSet(fb: FixBriefRow, input: BuildMvpReportInput, brandName?: string): boolean {
  const probeSet = getProbeSet(input, brandName);
  const latest = probeSet.latestMainProbeCreatedAt;
  return Boolean(latest && timeValueForReport(fb.updatedAt || fb.createdAt) < timeValueForReport(latest));
}

function sortFixBriefsForDisplay(briefs: FixBriefRow[], input: BuildMvpReportInput, brandName?: string): FixBriefRow[] {
  return [...briefs].sort((a, b) => {
    const aStale = isFixBriefStaleForProbeSet(a, input, brandName) ? 1 : 0;
    const bStale = isFixBriefStaleForProbeSet(b, input, brandName) ? 1 : 0;
    return (aStale - bStale) || (a.priority - b.priority) || (timeValueForReport(b.createdAt) - timeValueForReport(a.createdAt));
  });
}


function fixBriefById(input: BuildMvpReportInput): Map<string, FixBriefRow> {
  return new Map(input.fixBriefs.map((fb) => [fb.id, fb]));
}

function currentFixBriefs(input: BuildMvpReportInput, brandName?: string): FixBriefRow[] {
  return input.fixBriefs.filter((fb) => !isFixBriefStaleForProbeSet(fb, input, brandName) && fb.status !== "historical");
}

function isCurrentAsset(input: BuildMvpReportInput, asset: GeneratedAssetRow, brandName?: string): boolean {
  if (asset.lifecycleStatus !== "active") return false;
  const fb = fixBriefById(input).get(asset.fixBriefId);
  if (!fb) return false;
  return !isFixBriefStaleForProbeSet(fb, input, brandName) && fb.status !== "historical";
}

function currentAssetsForReport(input: BuildMvpReportInput, brandName?: string): GeneratedAssetRow[] {
  return input.assets.filter((asset) => isCurrentAsset(input, asset, brandName));
}

function supersededAssetsForReport(input: BuildMvpReportInput, brandName?: string): GeneratedAssetRow[] {
  const current = new Set(currentAssetsForReport(input, brandName).map((a) => a.id));
  return input.assets.filter((asset) => !current.has(asset.id));
}

function qaDistributionForAssets(assets: GeneratedAssetRow[]): Record<string, number> {
  const qaDistribution: Record<string, number> = { pending_qa: 0, needs_evidence: 0, safe_to_publish: 0, unsupported_claims: 0, qa_failed: 0 };
  for (const a of assets) qaDistribution[a.qaStatus] = (qaDistribution[a.qaStatus] ?? 0) + 1;
  return qaDistribution;
}

function derivedFixBriefStatus(input: BuildMvpReportInput, fb: FixBriefRow, brandName?: string): string {
  if (isFixBriefStaleForProbeSet(fb, input, brandName) || fb.status === "historical") return "historical";
  const requested = [...new Set(fb.assetsToGenerate.map((v) => v.trim()).filter(Boolean))];
  if (requested.length === 0) return fb.status;
  const active = currentAssetsForReport(input, brandName).filter((a) => a.fixBriefId === fb.id);
  const safeTypes = new Set(active.filter((a) => a.qaStatus === "safe_to_publish").map((a) => a.assetType));
  if (requested.every((type) => safeTypes.has(type))) return "assets_ready";
  if (requested.some((type) => safeTypes.has(type))) return "partially_complete";
  return fb.status;
}

function activeFixBriefsNeedingEvidence(input: BuildMvpReportInput, brandName?: string): FixBriefRow[] {
  return currentFixBriefs(input, brandName).filter((fb) => derivedFixBriefStatus(input, fb, brandName) !== "assets_ready");
}

function isEvidenceNeedSatisfiedByCurrentState(need: string, input: BuildMvpReportInput): boolean {
  const n = need.toLowerCase();
  if (n.includes("human-review") || n.includes("human review") || n.includes("review the evidence bank")) {
    return input.evidenceBank?.provenance === "user_reviewed";
  }
  return false;
}

/** Human phrase for a simulated probe on `platform`. */
export function simulatedProbeLabel(platform: string): string {
  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
  return `Simulated ${platformName}-style probe`;
}

/** Human phrase for a live-platform-API probe on `platform`. */
export function liveProbeLabel(platform: string): string {
  const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
  return platform.toLowerCase() === "perplexity"
    ? "Live Perplexity Sonar probe"
    : `Live ${platformName} probe`;
}

/**
 * Human label for a probe based on its persisted mode. Used everywhere
 * the export talks about a probe row so the report never claims
 * "ChatGPT said …" for something the pipeline never actually asked
 * ChatGPT.
 */
export function probeHeadingLabel(row: ProbeResult): string {
  return deriveProbeMode(row) === "live_perplexity"
    ? liveProbeLabel(row.platform)
    : simulatedProbeLabel(row.platform);
}

/**
 * Human phrase for an Evidence Bank's provenance, used in Section 12.
 */
export function evidenceProvenanceLabel(
  p: EvidenceBankProvenance
): { label: string; caveat: string } {
  switch (p) {
    case "auto_filled_from_mirror_profile":
      return {
        label: "auto-filled from Mirror Profile",
        caveat:
          "This bank was auto-populated from the site scan and has not been reviewed by a human. Every claim published from it should be verified against the source page before use.",
      };
    case "user_edited":
      return {
        label: "user-edited",
        caveat:
          "A user modified this bank at least once, but no one has completed a full review-and-approve pass.",
      };
    case "user_reviewed":
      return {
        label: "user-reviewed",
        caveat:
          "A user has explicitly reviewed and approved this bank. Still audit before publishing high-stakes claims.",
      };
  }
}

/**
 * Category display: prefer `mirrorProfile.json.detectedCategory`. Add a
 * caveat when the mirror profile's `categoryConfidence` is not "high" or
 * when the category string is unusually long / niche-specific.
 */
export function resolveCategoryDisplay(
  project: Project,
  mirrorProfile: MirrorProfileRow | null
): { display: string; caveat: string | null } {
  const j =
    (mirrorProfile?.json as {
      detectedCategory?: unknown;
      categoryConfidence?: unknown;
    } | null | undefined) ?? {};
  const mpCat =
    typeof j.detectedCategory === "string" ? j.detectedCategory.trim() : "";
  const conf =
    typeof j.categoryConfidence === "string" ? j.categoryConfidence.trim() : "";
  const display = mpCat || project.category?.trim() || "unknown";

  let caveat: string | null = null;
  if (!display || display === "unknown") {
    caveat = "Category could not be inferred from the site; do not quote it.";
  } else if (conf && conf !== "high") {
    caveat = `Category confidence is \`${conf}\`. Verify before quoting.`;
  } else if (display.length > 60 || /\bfor\b/.test(display.toLowerCase())) {
    // "AI product development platform for teams" is exactly the kind of
    // model-authored super-specific label the brief warns against.
    caveat =
      "This category is model-inferred and may over-specify the brand's positioning. Confirm with the brand before quoting.";
  }
  return { display, caveat };
}

/**
 * Turn a prioritized gap into a concrete website action. Keeps the
 * agent's `suggestedFixDirection` as a fallback but leads with a
 * concrete, publishable action tied to the gap type.
 */
export function gapToRecommendedAction(
  gap: Gap,
  brandName: string
): string {
  const competitor = gap.competitorName && gap.competitorName.trim().length > 0
    ? gap.competitorName.trim()
    : "the top competitor";
  const t = gap.type.toLowerCase();
  const action = (() => {
    if (t.includes("comparison") || t.includes("compare")) {
      return `Publish a comparison page: **${brandName} vs ${competitor}** targeting the affected buyer prompts.`;
    }
    if (t.includes("faq") || t.includes("prompt") || t.includes("prompt_loss")) {
      return `Add FAQ answers to the site that directly answer the lost prompts (short, quotable Q&A blocks).`;
    }
    if (t.includes("proof")) {
      return `Add proof blocks (customer names, case studies, metrics) using **allowed claims from the Evidence Bank**.`;
    }
    if (t.includes("review") || t.includes("citation")) {
      return `Add and cite the specific third-party reviews or evaluation sources AI is already using in this probe set; do not claim G2/Capterra unless those sources actually appeared.`;
    }
    if (t.includes("entity") || t.includes("clarity") || t.includes("schema")) {
      return `Add JSON-LD schema markup so AI models can identify **${brandName}** as an entity in the category.`;
    }
    if (t.includes("pricing")) {
      return `Publish pricing evidence before releasing any JSON-LD **Offer** schema.`;
    }
    return `Address gap: ${gap.suggestedFixDirection.trim()}`;
  })();
  return action;
}

/**
 * Aggregate every "evidence needed" signal we have across Fix Briefs,
 * asset placeholders, and QA reports. De-duplicated, canonicalized on
 * whitespace, ordered by first appearance.
 */
export function aggregateEvidenceNeeded(input: BuildMvpReportInput, brandName?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const s = raw.replace(/\s+/g, " ").trim();
    if (s.length === 0) return;
    if (isEvidenceNeedSatisfiedByCurrentState(s, input)) return;
    const canonical = s.toLowerCase();
    if (seen.has(canonical)) return;
    seen.add(canonical);
    out.push(s);
  };
  for (const fb of activeFixBriefsNeedingEvidence(input, brandName)) {
    for (const e of fb.evidenceNeeded) push(e);
  }
  for (const asset of currentAssetsForReport(input, brandName)) {
    for (const p of asset.placeholders) {
      const m = /\[EVIDENCE NEEDED:\s*([^\]]*)\]/.exec(p);
      push(m ? m[1] : p);
    }
    const report = input.latestQaByAsset.get(asset.id);
    for (const p of report?.placeholdersRemaining ?? []) {
      const m = /\[EVIDENCE NEEDED:\s*([^\]]*)\]/.exec(p);
      push(m ? m[1] : p);
    }
  }
  return out;
}

/**
 * Bucket assets by publish-status for grouped rendering.
 */
function bucketAssets(assets: GeneratedAssetRow[]): {
  publishReady: GeneratedAssetRow[];
  needsEvidence: GeneratedAssetRow[];
  unsupportedClaims: GeneratedAssetRow[];
  pendingQa: GeneratedAssetRow[];
  qaFailed: GeneratedAssetRow[];
} {
  const publishReady: GeneratedAssetRow[] = [];
  const needsEvidence: GeneratedAssetRow[] = [];
  const unsupportedClaims: GeneratedAssetRow[] = [];
  const pendingQa: GeneratedAssetRow[] = [];
  const qaFailed: GeneratedAssetRow[] = [];
  for (const a of assets) {
    if (a.qaStatus === "safe_to_publish") publishReady.push(a);
    else if (a.qaStatus === "needs_evidence") needsEvidence.push(a);
    else if (a.qaStatus === "unsupported_claims") unsupportedClaims.push(a);
    else if (a.qaStatus === "qa_failed") qaFailed.push(a);
    else pendingQa.push(a);
  }
  return { publishReady, needsEvidence, unsupportedClaims, pendingQa, qaFailed };
}

/**
 * QA-status → soft-tone tagline for the NOT READY blockquote. Warnings
 * are never hidden; this only reframes them so the report doesn't read
 * like the scan failed.
 */
function qaContextTagline(qaStatus: string): string {
  switch (qaStatus) {
    case "needs_evidence":
      return "Held by QA to prevent unsupported claims — add the missing evidence to the Evidence Bank and re-run QA.";
    case "unsupported_claims":
      return "Held by QA because one or more claims are not backed by the Evidence Bank yet — trim the claims or add the supporting proof and re-run QA.";
    case "pending_qa":
      return "QA has not run against this draft yet. This is expected for freshly generated assets; run QA before publishing.";
    case "qa_failed":
      return "QA did not complete for this asset. Treat it as not publishable and re-run QA on this asset after resolving the failure.";
    default:
      return "Held by QA to prevent unsupported claims.";
  }
}

/* -------------------------------------------------------------------------- */
/*  Section builders                                                          */
/* -------------------------------------------------------------------------- */

function sectionExecSummary(
  input: BuildMvpReportInput,
  brandName: string,
  categoryDisplay: string,
  qaDist: Record<string, number>
): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[0]}`);
  parts.push("");
  parts.push(`- **Brand**: ${brandName}`);
  parts.push(`- **Domain**: \`${input.project.domain}\``);
  parts.push(`- **Category (Mirror Profile)**: ${categoryDisplay}`);

  const probeSet = getProbeSet(input, brandName);
  const mainProbes = probeSet.mainProbeResults;
  const scoreGroups = probeSet.scorecardPromptGroups;
  const totalPrompts = scoreGroups.length;
  const totalRuns = scoreGroups.reduce((sum, g) => sum + g.runs, 0);
  const lost = scoreGroups.filter((g) => g.verdict === "lost").length;
  const partial = scoreGroups.filter((g) => g.verdict === "partial").length;
  const won = scoreGroups.filter((g) => g.verdict === "won").length;
  const productRuns = scoreGroups.reduce((sum, g) => sum + (g.productMentionedRuns ?? 0), 0);
  const productRate = totalRuns > 0 ? productRuns / totalRuns : 0;
  const citedRuns = scoreGroups.reduce((sum, g) => sum + (g.citedAsSourceRuns ?? 0), 0);
  const citedRate = totalRuns > 0 ? citedRuns / totalRuns : 0;
  const modeSuffix = probeSetLabel(probeSet);
  const brandedSuffix = probeSet.scorecardUsesUnbranded ? " unbranded" : "";
  parts.push(
    `- **AI probe result (${modeSuffix}${brandedSuffix} product-recommendation scorecard, ${totalPrompts} prompt${totalPrompts === 1 ? "" : "s"} / ${totalRuns} run${totalRuns === 1 ? "" : "s"})**: ${won} won · ${partial} partial · ${lost} lost · recommendedAsProduct ${pct(productRate)} · citedAsSource ${pct(citedRate)}`
  );
  if (probeSet.brandedPromptGroups.length > 0 && probeSet.scorecardUsesUnbranded) {
    const brandedRuns = probeSet.brandedPromptGroups.reduce((sum, g) => sum + g.runs, 0);
    const reputation = brandedReputationSummary(probeSet.brandedPromptGroups);
    parts.push(
      `- **Branded probes tracked separately**: ${probeSet.brandedPromptGroups.length} prompt${probeSet.brandedPromptGroups.length === 1 ? "" : "s"} / ${brandedRuns} run${brandedRuns === 1 ? "" : "s"}`
    );
    parts.push(`- **Branded reputation**: ${reputation.label}`);
  }

  if (probeSet.excludedModes.length > 0) {
    parts.push(
      `- **Historical probes excluded from main summary**: ${probeSet.historicalProbeResults.length} simulated result${probeSet.historicalProbeResults.length === 1 ? "" : "s"}`
    );
  }

  if (probeSet.gapMapStale) {
    parts.push(
      `- **Gap Map freshness**: ⚠️ Gap Map may be stale — regenerate after live probes.`
    );
  }

  // Top competitors recommended instead. Prefer the probe set that drives
  // the main report. Simulated rows stay visible later but do not decide
  // the client-facing live summary once live Perplexity data exists.
  const mentionCounts = new Map<string, number>();
  for (const r of probeSet.scorecardProbeResults) {
    const arr = Array.isArray(r.competitorsMentioned)
      ? (r.competitorsMentioned as Array<{ name?: string }>)
      : [];
    for (const c of arr) {
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!name) continue;
      if (isAiPlatformName(name)) continue;
      mentionCounts.set(name, (mentionCounts.get(name) ?? 0) + 1);
    }
  }
  let topCompetitors: string[] = [...mentionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => n);
  if (topCompetitors.length === 0) {
    topCompetitors = [...input.competitors]
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .slice(0, 3)
      .map((c) => c.name);
  }
  const competitorRelationshipLabel = lost > 0 || partial > 0
    ? "Top competitors AI recommended instead"
    : "Top competitors AI recommended alongside";
  parts.push(
    `- **${competitorRelationshipLabel}**: ${
      topCompetitors.length > 0 ? topCompetitors.join(", ") : "_none recorded_"
    }`
  );

  // Biggest gap. If the Gap Map predates live probes, tell the reader
  // not to over-trust the derived gap until it has been regenerated.
  const biggestGap = [...input.gaps].sort((a, b) => {
    const rank = (sev: string) => (sev === "high" ? 3 : sev === "medium" ? 2 : 1);
    return rank(b.severity) - rank(a.severity);
  })[0];
  parts.push(
    biggestGap
      ? `- **Biggest gap**: ${mdEscape(biggestGap.explanation)} _(type \`${biggestGap.type}\`, severity ${biggestGap.severity}${probeSet.gapMapStale ? "; may be stale" : ""})_`
      : "- **Biggest gap**: _no prioritized gaps recorded_"
  );

  // Next recommended fix (lowest fix-brief.priority = highest priority).
  // Sprint 13A.2: if a Fix Brief predates the selected live probe set, do
  // not present it as a fresh recommendation without a warning.
  const nextFix = sortFixBriefsForDisplay(input.fixBriefs, input, brandName)[0];
  if (!nextFix) {
    parts.push("- **Next recommended fix**: _no Fix Brief generated yet_");
  } else if (isFixBriefStaleForProbeSet(nextFix, input, brandName)) {
    parts.push(
      "- **Next recommended fix**: _existing Fix Brief is based on earlier probe data — regenerate Fix Briefs after the live scorecard_"
    );
  } else {
    parts.push(
      `- **Next recommended fix**: ${mdEscape(nextFix.recommendedFix)} _(fixType \`${nextFix.fixType}\`, status \`${derivedFixBriefStatus(input, nextFix, brandName)}\`)_`
    );
  }

  const currentAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);
  const totalAssets = currentAssets.length;
  const publishReady = qaDist.safe_to_publish ?? 0;
  parts.push(
    totalAssets === 0
      ? "- **Publishability**: no current assets generated yet"
      : `- **Publishability**: ${publishReady} of ${totalAssets} current assets are safe to publish (${totalAssets - publishReady} current assets held by QA; ${supersededAssets.length} superseded/historical assets kept for audit)`
  );

  const evidence = aggregateEvidenceNeeded(input, brandName);
  parts.push(
    evidence.length === 0
      ? "- **Evidence needed to unlock publish-ready assets**: none blocking today"
      : `- **Evidence needed to unlock publish-ready assets**: ${evidence.length} distinct evidence gap${evidence.length === 1 ? "" : "s"} (see Section 3)`
  );
  parts.push("");
  const probeCaveat =
    probeSet.includedMode === "live_perplexity"
      ? "> This is a **small live Perplexity buyer-prompt probe** for the main scorecard. Older simulated probes, if present, are historical test context and are excluded from the main result."
      : "> This is a **small, simulated buyer-prompt probe**, not a full market-wide benchmark. The findings below reflect a targeted sample of AI-style answers, not a statistical audit of every AI platform.";
  parts.push(probeCaveat);
  parts.push("");
  return parts.join("\n");
}

function sectionPublishability(input: BuildMvpReportInput): string {
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const activeAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);
  const b = bucketAssets(activeAssets);
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[1]}`);
  parts.push("");
  parts.push(`- **Current active assets**: ${activeAssets.length}`);
  parts.push(`- **Superseded / historical assets kept for audit**: ${supersededAssets.length}`);
  parts.push(`- **Publish-ready** (\`safe_to_publish\`): ${b.publishReady.length}`);
  parts.push(`- **Needs evidence**: ${b.needsEvidence.length}`);
  parts.push(`- **Unsupported claims**: ${b.unsupportedClaims.length}`);
  parts.push(`- **Pending QA**: ${b.pendingQa.length}`);
  parts.push(`- **QA failed**: ${b.qaFailed.length}`);
  parts.push("");
  if (activeAssets.length > 0 && b.publishReady.length === 0) {
    parts.push(
      "> **This does not mean the scan failed.** It means the Evidence Bank does not yet contain enough verified facts to safely publish these drafts. Every current asset is preserved below, and superseded assets are kept in an audit section so the team can track progress without resetting history."
    );
    parts.push("");
  }
  return parts.join("\n");
}

function sectionEvidenceNeeded(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[2]}`);
  parts.push("");
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const evidence = aggregateEvidenceNeeded(input, brandName);
  if (evidence.length === 0) {
    parts.push(
      "_Every current active asset either has enough evidence already or does not depend on external evidence to publish._"
    );
    parts.push("");
    return parts.join("\n");
  }
  parts.push(
    "The following distinct evidence signals are missing across current active Fix Briefs, active asset placeholders, and active QA reports. Superseded assets remain auditable later but do not pollute the current unlock list."
  );
  parts.push("");
  for (const e of evidence) {
    parts.push(`- ${mdEscape(e)}`);
  }
  parts.push("");
  return parts.join("\n");
}

function sectionProjectSummary(input: BuildMvpReportInput, brandName: string, brandSource: string): string {
  const { project } = input;
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[3]}`);
  parts.push("");
  parts.push(`- **Brand**: ${brandName} _(source: \`${brandSource}\`)_`);
  parts.push(`- **Domain**: \`${project.domain}\``);
  parts.push(`- **projectId**: \`${project.id}\``);
  parts.push(`- **createdAt**: ${nice(project.createdAt)}`);
  parts.push("");
  return parts.join("\n");
}

function sectionMirrorProfile(input: BuildMvpReportInput, categoryDisplay: string, categoryCaveat: string | null): string {
  const row = input.mirrorProfile;
  if (!row) {
    return `## ${REPORT_SECTIONS[4]}\n\n_No Mirror Profile has been generated yet._\n`;
  }
  const j = (row.json ?? {}) as Record<string, unknown>;

  const targetAudience = Array.isArray(j.targetAudience) ? (j.targetAudience as string[]) : [];
  const useCases = Array.isArray(j.useCases) ? (j.useCases as string[]) : [];
  const features = Array.isArray(j.features) ? (j.features as string[]) : [];
  const painPoints = Array.isArray(j.painPointsAddressed)
    ? (j.painPointsAddressed as string[])
    : [];
  const proofSignals = Array.isArray(j.proofSignals)
    ? (j.proofSignals as Array<{ type?: string; detail?: string; sourceUrl?: string }>)
    : [];
  const missingSignals = Array.isArray(j.missingSignals)
    ? (j.missingSignals as Array<{ signal?: string; whyItMatters?: string }>)
    : [];
  const buyerAngles = Array.isArray(j.buyerIntentAngles)
    ? (j.buyerIntentAngles as string[])
    : [];
  const claims = Array.isArray(j.claims)
    ? (j.claims as Array<{ claim?: string; sourceUrl?: string; hasProof?: boolean }>)
    : [];
  const competitorsMentioned = Array.isArray(j.competitorsMentioned)
    ? (j.competitorsMentioned as string[])
    : [];

  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[4]}`);
  parts.push("");
  parts.push(`- **companyName (Mirror Profile)**: ${safeString(j.companyName)}`);
  parts.push(`- **website**: ${safeString(j.website)}`);
  parts.push(`- **Detected category**: ${categoryDisplay}`);
  parts.push(`- **categoryConfidence**: ${safeString(j.categoryConfidence)}`);
  if (categoryCaveat) {
    parts.push(`- **Category caveat**: ${categoryCaveat}`);
  }
  parts.push(`- **aiReadabilityNotes**: ${safeString(j.aiReadabilityNotes)}`);
  parts.push(`- **createdAt**: ${nice(row.createdAt)}`);
  parts.push("");
  parts.push("### Target audience");
  parts.push(bulletList(targetAudience));
  parts.push("");
  parts.push("### Use cases");
  parts.push(bulletList(useCases));
  parts.push("");
  parts.push("### Features");
  parts.push(bulletList(features));
  parts.push("");
  parts.push("### Pain points addressed");
  parts.push(bulletList(painPoints));
  parts.push("");
  parts.push("### Buyer intent angles");
  parts.push(bulletList(buyerAngles));
  parts.push("");
  parts.push("### Competitors mentioned on the site");
  parts.push(bulletList(competitorsMentioned));
  parts.push("");
  parts.push("### Claims (from site copy)");
  if (claims.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| claim | sourceUrl | hasProof |");
    parts.push("|---|---|---|");
    for (const c of claims) {
      parts.push(
        `| ${mdEscape(safeString(c.claim))} | ${mdEscape(safeString(c.sourceUrl))} | ${yesNo(Boolean(c.hasProof))} |`
      );
    }
  }
  parts.push("");
  parts.push("### Proof signals");
  if (proofSignals.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| type | detail | sourceUrl |");
    parts.push("|---|---|---|");
    for (const p of proofSignals) {
      parts.push(
        `| ${mdEscape(safeString(p.type))} | ${mdEscape(safeString(p.detail))} | ${mdEscape(safeString(p.sourceUrl))} |`
      );
    }
  }
  parts.push("");
  parts.push("### Missing signals (site is not perfect)");
  if (missingSignals.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| signal | why it matters |");
    parts.push("|---|---|");
    for (const m of missingSignals) {
      parts.push(
        `| ${mdEscape(safeString(m.signal))} | ${mdEscape(safeString(m.whyItMatters))} |`
      );
    }
  }
  parts.push("");
  return parts.join("\n");
}

function sectionPrompts(input: BuildMvpReportInput): string {
  const { prompts } = input;
  const total = prompts.length;
  const selected = prompts.filter((p) => p.selected);
  const byIntent = new Map<string, number>();
  for (const p of prompts) {
    byIntent.set(p.intentType, (byIntent.get(p.intentType) ?? 0) + 1);
  }
  const intentRows = Array.from(byIntent.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `| ${mdEscape(k)} | ${v} |`);

  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[5]}`);
  parts.push("");
  // Both counts describe STORED prompt rows and their authoring-intent
  // `selected` flag. Neither is the number of prompts actually probed —
  // the appendix carries the scorecard-derived counts for that.
  parts.push(`- **stored prompt rows**: ${total}`);
  parts.push(`- **rows marked selected**: ${selected.length}`);
  parts.push("");
  parts.push("### Intent distribution");
  if (intentRows.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| intentType | count |");
    parts.push("|---|---|");
    parts.push(intentRows.join("\n"));
  }
  parts.push("");
  parts.push("### Stored prompt targets");
  if (selected.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| priority | commercialValue | winnability | intent | prompt |");
    parts.push("|---|---|---|---|---|");
    const sorted = [...selected].sort((a, b) => b.priority - a.priority);
    for (const p of sorted) {
      parts.push(
        `| ${p.priority} | ${p.commercialValue} | ${p.winnability} | ${mdEscape(p.intentType)} | ${mdEscape(p.prompt)} |`
      );
    }
  }
  parts.push("");
  return parts.join("\n");
}


function reportProductPosition(row: ProbeResult): string {
  return row.clientPosition || row.productPosition || "absent";
}

function reportRecommendedAsProduct(row: ProbeResult): boolean {
  const pos = reportProductPosition(row);
  return pos === "primary" || pos === "listed";
}

function reportProductVerdict(row: ProbeResult): "won" | "partial" | "lost" | "not_relevant" {
  const pos = reportProductPosition(row);
  if (pos === "primary") return "won";
  if (pos === "listed") return "partial";
  if (pos === "negative") return "lost";
  return "lost";
}

type BrandedReputationState = "not_measured" | "positive" | "mixed" | "at_risk";

function brandedReputationSummary(groups: PromptProbeAggregate[]): { state: BrandedReputationState; runs: number; negative: number; label: string } {
  const runs = groups.reduce((sum, g) => sum + g.runs, 0);
  const negative = groups.reduce((sum, g) => sum + (g.negativeMentionRuns ?? 0), 0);
  if (runs === 0) return { state: "not_measured", runs, negative, label: "not measured" };
  if (negative === 0) return { state: "positive", runs, negative, label: `positive (0/${runs} branded runs negative)` };
  if (negative === runs) return { state: "at_risk", runs, negative, label: `at risk (${negative}/${runs} branded runs negative)` };
  return { state: "mixed", runs, negative, label: `mixed (${negative}/${runs} branded runs negative)` };
}

function sectionProbeResults(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[6]}`);
  parts.push("");

  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const probeSet = getProbeSet(input, brandName);
  const main = probeSet.mainProbeResults;
  const scoreGroups = probeSet.scorecardPromptGroups;
  const total = main.length;
  const totalScorePrompts = scoreGroups.length;
  const totalScoreRuns = scoreGroups.reduce((sum, g) => sum + g.runs, 0);
  const lost = scoreGroups.filter((g) => g.verdict === "lost").length;
  const partial = scoreGroups.filter((g) => g.verdict === "partial").length;
  const won = scoreGroups.filter((g) => g.verdict === "won").length;
  const productRuns = scoreGroups.reduce((sum, g) => sum + (g.productMentionedRuns ?? 0), 0);
  const productRate = totalScoreRuns > 0 ? productRuns / totalScoreRuns : 0;
  const citedRuns = scoreGroups.reduce((sum, g) => sum + (g.citedAsSourceRuns ?? 0), 0);
  const citedRate = totalScoreRuns > 0 ? citedRuns / totalScoreRuns : 0;
  const negativeRuns = scoreGroups.reduce((sum, g) => sum + (g.negativeMentionRuns ?? 0), 0);
  const negativeRate = totalScoreRuns > 0 ? negativeRuns / totalScoreRuns : 0;

  parts.push("### Probe Set");
  parts.push("");
  parts.push(`- **live_perplexity rows stored**: ${probeSet.livePerplexity}`);
  parts.push(`- **simulated rows stored**: ${probeSet.simulated}`);
  parts.push(`- **included in main summary**: ${probeSet.includedMode}`);
  parts.push(
    `- **excluded from main summary**: ${probeSet.excludedModes.length > 0 ? probeSet.excludedModes.join(", ") : "none"}`
  );
  parts.push(`- **unbranded prompt groups**: ${probeSet.unbrandedPromptGroups.length}`);
  parts.push(`- **branded prompt groups**: ${probeSet.brandedPromptGroups.length}`);
  parts.push(`- **scorecard basis**: ${probeSet.scorecardUsesUnbranded ? "unbranded prompts only" : "all main prompts"}`);
  parts.push(`- **recommendedAsProduct rate**: ${pct(productRate)} (${productRuns}/${totalScoreRuns} runs recommend the brand as a product/tool)`);
  parts.push(`- **citedAsSource rate**: ${pct(citedRate)} (${citedRuns}/${totalScoreRuns} runs cite the brand as a source)`);
  parts.push(`- **negativeMention rate**: ${pct(negativeRate)} (${negativeRuns}/${totalScoreRuns} runs mention the brand negatively)`);
  if (probeSet.gapMapStale) {
    parts.push(
      `- **derived-data warning**: Gap Map may be stale — regenerate after live probes.`
    );
  }
  parts.push("");

  if (probeSet.includedMode === "live_perplexity") {
    parts.push(
      "> The main scorecard below uses **live Perplexity Sonar probes only**. Simulated probes remain available as historical test rows and do not drive the live summary."
    );
  } else {
    parts.push(
      "> **Every main result in this section came from a simulated, manually-entered probe.** No live call was made to ChatGPT, Perplexity, Gemini, or any other AI platform API."
    );
  }
  parts.push("");
  parts.push(`- **main probe origin**: ${probeSet.includedMode}`);
  parts.push(`- **main probe rows**: ${total}`);
  parts.push(`- **scorecard prompt groups**: ${totalScorePrompts}`);
  parts.push(`- **scorecard runs**: ${totalScoreRuns}`);
  parts.push(`- **lost prompt groups**: ${lost}`);
  parts.push(`- **partial prompt groups**: ${partial}`);
  parts.push(`- **won prompt groups**: ${won}`);
  parts.push("");

  if (main.length === 0) {
    parts.push("_No probe results recorded._");
    parts.push("");
    return parts.join("\n");
  }

  if (probeSet.promptGroups.length > 0) {
    parts.push("### Prompt-level aggregation");
    parts.push("");
    parts.push("| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |");
    parts.push("|---|---|---|---|---|---|---|");
    const scoreKeys = new Set(probeSet.scorecardPromptGroups.map((g) => g.key));
    for (const g of probeSet.promptGroups) {
      const status = scoreKeys.has(g.key) ? "included" : g.isBranded ? "tracked_separately (branded)" : "excluded";
      parts.push(`| ${mdEscape(g.prompt)} | ${status} | ${g.runs} | ${pct(g.productRecommendationRate ?? 0)} | ${pct(g.sourceCitationRate ?? 0)} | ${pct(g.negativeMentionRate ?? 0)} | ${g.verdict} |`);
    }
    parts.push("");
  }

  const renderRow = (r: ProbeResult, scorecardStatus: "included" | "tracked_separately (branded)" | "excluded"): void => {
    const mode = deriveProbeMode(r);
    parts.push(`### ${probeHeadingLabel(r)} · product verdict: **${reportProductVerdict(r)}**`);
    parts.push("");
    parts.push(`- **scorecard status**: ${scorecardStatus}`);
    parts.push(`- **prompt**: ${mdEscape(r.prompt)}`);
    parts.push(`- **platform**: \`${r.platform}\``);
    parts.push(
      `- **probe origin**: ${mode} ${mode === "live_perplexity" ? "(live Perplexity API response)" : "(not a live platform response)"}`
    );
    const productPosition = reportProductPosition(r);
    parts.push(`- **recommendedAsProduct**: ${yesNo(reportRecommendedAsProduct(r))}`);
    parts.push(`- **productPosition**: ${productPosition}`);
    if (productPosition === "negative") {
      parts.push(`- **negativeMention**: yes — brand was mentioned with caveats or as inferior, so it does not count as a product recommendation.`);
    }
    parts.push(`- **citedAsSource**: ${yesNo(Boolean(r.citedAsSource))}${r.clientSourceCount ? ` (${r.clientSourceCount} client source${r.clientSourceCount === 1 ? "" : "s"})` : ""}`);
    if (r.rawProbeRequest && r.rawProbeRequest.trim()) {
      parts.push(`- **rawProbeRequest**: ${mdEscape(r.rawProbeRequest.trim())}`);
    }
    if (Array.isArray(r.platformsReferenced) && r.platformsReferenced.length > 0) {
      parts.push(`- **platforms referenced**: ${r.platformsReferenced.map(mdEscape).join(", ")}`);
    }
    parts.push(`- **answerSummary**: ${mdEscape(r.answerSummary)}`);
    if (r.whyClientLost && r.whyClientLost.trim().length > 0) {
      parts.push(`- **whyClientLost**: ${mdEscape(r.whyClientLost)}`);
    }
    const comps = Array.isArray(r.competitorsMentioned)
      ? (r.competitorsMentioned as Array<{ name?: string; position?: number; context?: string }>)
      : [];
    if (comps.length > 0) {
      parts.push(`- **competitors mentioned (in the ${mode === "live_perplexity" ? "live Perplexity answer" : "simulated answer"})**:`);
      parts.push("");
      parts.push("  | position | name | context |");
      parts.push("  |---|---|---|");
      for (const c of comps) {
        parts.push(
          `  | ${safeString(c.position)} | ${mdEscape(safeString(c.name))} | ${mdEscape(safeString(c.context))} |`
        );
      }
    }
    const sources = Array.isArray(r.sourcesCited)
      ? (r.sourcesCited as Array<{ source?: string; type?: string }>)
      : [];
    if (sources.length > 0) {
      parts.push(`- **sources cited in the ${mode === "live_perplexity" ? "live Perplexity answer" : "simulated answer"})**:`);
      parts.push("");
      parts.push("  | source | type |");
      parts.push("  |---|---|");
      for (const src of sources) {
        parts.push(
          `  | ${mdEscape(safeString(src.source))} | ${mdEscape(safeString(src.type))} |`
        );
      }
    }
    parts.push("");
  };

  const scorecardRowIds = new Set(probeSet.scorecardProbeResults.map((r) => r.id));
  for (const r of main) {
    const status = scorecardRowIds.has(r.id)
      ? "included"
      : isBrandedPrompt(r.prompt, [brandName, input.project.domain])
        ? "tracked_separately (branded)"
        : "excluded";
    renderRow(r, status);
  }

  if (probeSet.historicalProbeResults.length > 0) {
    parts.push("### Historical simulated probes excluded from main summary");
    parts.push("");
    parts.push(
      "These rows are kept for auditability because they exercised the pipeline before live probes existed. They do not drive the Executive Summary or What This Means section."
    );
    parts.push("");
    for (const r of probeSet.historicalProbeResults) renderRow(r, "excluded");
  }

  return parts.join("\n");
}

function sectionWhatThisMeans(
  input: BuildMvpReportInput,
  brandName: string
): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[7]}`);
  parts.push("");

  const probeSet = getProbeSet(input, brandName);
  const mainProbes = probeSet.scorecardProbeResults;
  const groups = probeSet.scorecardPromptGroups;
  const lostResults = groups.filter((g) => g.verdict === "lost");
  const partialResults = groups.filter((g) => g.verdict === "partial");
  const negativeResults = groups.filter((g) => (g.negativeMentionRuns ?? 0) > 0);
  const total = groups.length;

  parts.push(`### Which prompts ${brandName} lost or under-performed`);
  if (lostResults.length === 0 && partialResults.length === 0) {
    parts.push(
      `_${brandName} was recommended as a primary or listed product/tool on every sampled scorecard prompt._`
    );
  } else {
    if (lostResults.length > 0) {
      parts.push("**Lost prompts** (brand was not recommended as a product/tool):");
      for (const r of lostResults) parts.push(`- ${mdEscape(r.prompt)} (${r.runs} run${r.runs === 1 ? "" : "s"}, recommendedAsProduct ${pct(r.productRecommendationRate ?? 0)}, citedAsSource ${pct(r.sourceCitationRate ?? 0)})`);
    }
    if (partialResults.length > 0) {
      if (lostResults.length > 0) parts.push("");
      parts.push("**Partial prompts** (brand was cited/listed, but not the primary product recommendation):");
      for (const r of partialResults) parts.push(`- ${mdEscape(r.prompt)} (${r.runs} run${r.runs === 1 ? "" : "s"}, recommendedAsProduct ${pct(r.productRecommendationRate ?? 0)}, citedAsSource ${pct(r.sourceCitationRate ?? 0)})`);
    }
  }
  if (negativeResults.length > 0) {
    parts.push("");
    parts.push("**Negative mention risk** (brand was named, but with credibility concerns or negative positioning):");
    for (const r of negativeResults) parts.push(`- ${mdEscape(r.prompt)} (${r.negativeMentionRuns}/${r.runs} run${r.runs === 1 ? "" : "s"} negative)`);
  }

  const brandedReputation = brandedReputationSummary(probeSet.brandedPromptGroups);
  if (brandedReputation.state !== "not_measured") {
    parts.push("");
    parts.push("### Branded reputation check");
    if (brandedReputation.state === "at_risk") {
      parts.push(`${brandedReputation.negative}/${brandedReputation.runs} branded run${brandedReputation.runs === 1 ? "" : "s"} mentioned ${brandName} negatively. This is a reputation risk, not just a visibility gap.`);
    } else if (brandedReputation.state === "mixed") {
      parts.push(`${brandedReputation.negative}/${brandedReputation.runs} branded run${brandedReputation.runs === 1 ? "" : "s"} mentioned ${brandName} negatively. Treat the branded result as mixed until more runs confirm the pattern.`);
    } else {
      parts.push(`0/${brandedReputation.runs} branded run${brandedReputation.runs === 1 ? "" : "s"} mentioned ${brandName} negatively.`);
    }
  }
  parts.push("");

  if (probeSet.historicalProbeResults.length > 0) {
    parts.push("### Historical simulated probes excluded from this summary");
    parts.push(
      `${probeSet.historicalProbeResults.length} simulated probe result${probeSet.historicalProbeResults.length === 1 ? "" : "s"} are still shown in Section 7 for auditability, but live Perplexity results take precedence in the main report.`
    );
    parts.push("");
  }

  const mentionCounts = new Map<string, number>();
  for (const r of mainProbes) {
    const arr = Array.isArray(r.competitorsMentioned)
      ? (r.competitorsMentioned as Array<{ name?: string }>)
      : [];
    for (const c of arr) {
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!name) continue;
      if (isAiPlatformName(name)) continue;
      mentionCounts.set(name, (mentionCounts.get(name) ?? 0) + 1);
    }
  }
  const rankedCompetitors = [...mentionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  parts.push(lostResults.length > 0 || partialResults.length > 0 ? "### Which competitors appeared instead" : "### Which competitors appeared alongside");
  if (rankedCompetitors.length === 0) {
    parts.push("_No specific competitors were named in the sampled main probe answers._");
  } else {
    parts.push("| competitor | mentions across main probes |");
    parts.push("|---|---|");
    for (const [name, count] of rankedCompetitors) {
      parts.push(`| ${mdEscape(name)} | ${count} |`);
    }
  }
  parts.push("");

  parts.push("### Why this matters commercially");
  if (lostResults.length === 0 && partialResults.length === 0 && total > 0) {
    parts.push(
      `In the main probe set, ${brandName} is already appearing in the AI shortlist. The next opportunity is not basic visibility; it is strengthening source coverage, proof, and comparison evidence so the brand keeps that position across more prompts and platforms.`
    );
  } else {
    parts.push(
      `When a buyer asks an AI assistant "best tools for …", the AI's answer functions as a shortlist. Prompts where ${brandName} was absent or downranked mean the brand is not on that shortlist for those buyers. Fixing the missing site content (comparison pages, FAQ answers, proof blocks) is the direct lever to appear on future shortlists.`
    );
  }
  parts.push("");

  parts.push("### Sampling caveat");
  if (probeSet.includedMode === "live_perplexity") {
    parts.push(
      `This scan's main scorecard is a **small live Perplexity probe** — ${total} unbranded prompt group${total === 1 ? "" : "s"} when available, with branded prompts tracked separately. It does not represent ChatGPT, Gemini, Claude, or a market-wide benchmark.`
    );
  } else {
    parts.push(
      `This scan is a **small, simulated probe** — ${total} sampled result${total === 1 ? "" : "s"}, no live platform-API integration. Do not read the numbers as a full market benchmark.`
    );
  }
  parts.push("");
  return parts.join("\n");
}

function sectionCompetitors(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[8]}`);
  parts.push("");
  const phantoms = input.competitors.filter((c) => c.isPhantom);
  const blindSpots = input.competitors.filter((c) => c.isBlindSpot);
  parts.push(`- **total competitors**: ${input.competitors.length}`);
  parts.push(`- **phantom competitors**: ${phantoms.length}`);
  parts.push(`- **blind spots**: ${blindSpots.length}`);
  parts.push("");
  if (input.competitors.length === 0) {
    parts.push("_No competitors discovered._");
    parts.push("");
    return parts.join("\n");
  }
  parts.push("| name | website | source | threat | confidence | mentions | phantom | blindSpot |");
  parts.push("|---|---|---|---|---|---|---|---|");
  for (const c of input.competitors) {
    parts.push(
      `| ${mdEscape(c.name)} | ${mdEscape(safeString(c.website))} | ${mdEscape(c.discoverySource)} | ${mdEscape(c.threatLevel)} | ${mdEscape(c.confidence)} | ${c.mentionCount} | ${yesNo(c.isPhantom)} | ${yesNo(c.isBlindSpot)} |`
    );
  }
  parts.push("");
  return parts.join("\n");
}

function sectionGapMap(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[9]}`);
  parts.push("");
  if (!input.gapMap) {
    parts.push("_No Gap Map has been generated yet._");
    parts.push("");
    return parts.join("\n");
  }
  const g = (input.gapMap.json ?? {}) as {
    competitorDistances?: Array<{
      competitor?: string;
      recommendationDistance?: number;
      gapScores?: Record<string, number>;
      topReasons?: string[];
      evidenceStrength?: string;
    }>;
    prioritizedGaps?: Array<{
      type?: string;
      severity?: string;
      explanation?: string;
      suggestedFixDirection?: string;
    }>;
  };
  const distances = g.competitorDistances ?? [];
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const probeSet = getProbeSet(input, brandName);
  if (probeSet.gapMapStale) {
    parts.push(
      "> ⚠️ **Gap Map may be stale — regenerate after live probes.** This Gap Map was created before the latest live Perplexity probe, so treat derived gaps and distances as historical until regenerated."
    );
    parts.push("");
  }
  parts.push(`- **gapMapId**: \`${input.gapMap.id}\``);
  parts.push(`- **createdAt**: ${nice(input.gapMap.createdAt)}`);
  parts.push(`- **competitor distances**: ${distances.length}`);
  parts.push(`- **prioritized gaps**: ${input.gaps.length}`);
  parts.push("");
  parts.push("### Competitor recommendation distances");
  if (distances.length === 0) {
    parts.push("_none_");
  } else {
    parts.push(
      "| competitor | distance | prompt_loss | citation | review | comparison_content | proof | entity_clarity | evidence | top reasons |"
    );
    parts.push(
      "|---|---|---|---|---|---|---|---|---|---|"
    );
    for (const d of distances) {
      const s = d.gapScores ?? {};
      const reasons = (d.topReasons ?? []).map((r) => mdEscape(r)).join("; ");
      parts.push(
        `| ${mdEscape(safeString(d.competitor))} | ${safeString(d.recommendationDistance)} | ${safeString(s.prompt_loss)} | ${safeString(s.citation)} | ${safeString(s.review)} | ${safeString(s.comparison_content)} | ${safeString(s.proof)} | ${safeString(s.entity_clarity)} | ${mdEscape(safeString(d.evidenceStrength))} | ${reasons} |`
      );
    }
  }
  parts.push("");
  parts.push(`### Prioritized gaps (top ${input.gaps.length})`);
  if (input.gaps.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| type | severity | competitor | explanation | suggested fix direction | affected prompts |");
    parts.push("|---|---|---|---|---|---|");
    for (const gap of input.gaps) {
      parts.push(
        `| ${mdEscape(gap.type)} | ${mdEscape(gap.severity)} | ${mdEscape(safeString(gap.competitorName))} | ${mdEscape(gap.explanation)} | ${mdEscape(gap.suggestedFixDirection)} | ${gap.affectedPrompts.length} |`
      );
    }
  }
  parts.push("");
  return parts.join("\n");
}

function sectionRecommendedNextActions(
  input: BuildMvpReportInput,
  brandName: string
): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[10]}`);
  parts.push("");
  if (input.gaps.length === 0) {
    parts.push("_No prioritized gaps to translate into gap-recovery actions yet._");
    if (input.fixBriefs.length > 0) {
      parts.push("");
      parts.push("### Consolidation actions");
      for (const fb of sortFixBriefsForDisplay(input.fixBriefs, input, brandName)) {
        const stale = isFixBriefStaleForProbeSet(fb, input, brandName);
        const prefix = stale ? "Historical Fix Brief — regenerate before using:" : "Current Fix Brief:";
        parts.push(`- ${prefix} **${fb.fixType}** — ${mdEscape(fb.recommendedFix)} Expected impact: ${mdEscape(fb.expectedImpact)}`);
      }
    }
    parts.push("");
    return parts.join("\n");
  }
  parts.push(
    "Each row below is a concrete, publishable website action derived from a prioritized gap. \"Add proof blocks using allowed claims from the Evidence Bank\" is a **website page edit**, not a marketing suggestion."
  );
  parts.push("");
  parts.push("| # | gap type | severity | recommended website action |");
  parts.push("|---|---|---|---|");
  input.gaps.forEach((g, i) => {
    parts.push(
      `| ${i + 1} | ${mdEscape(g.type)} | ${mdEscape(g.severity)} | ${mdEscape(
        gapToRecommendedAction(g, brandName)
      )} |`
    );
  });
  parts.push("");
  // Also expose Fix Brief-derived asset generation as a follow-up action.
  if (input.fixBriefs.length > 0) {
    parts.push("### From the Fix Briefs");
    for (const fb of sortFixBriefsForDisplay(input.fixBriefs, input, brandName)) {
      const stale = isFixBriefStaleForProbeSet(fb, input, brandName);
      const prefix = stale ? "Historical Fix Brief — regenerate before using:" : "Publish";
      const line = `- ${prefix} **${fb.fixType}** to answer the lost prompt _\"${mdEscape(fb.lostPrompt)}\"_ — expected impact: ${mdEscape(fb.expectedImpact)}`;
      parts.push(line);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function sectionEvidenceBank(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[11]}`);
  parts.push("");
  const bank = input.evidenceBank;
  if (!bank) {
    parts.push("_No Evidence Bank has been prepared for this project._");
    parts.push("");
    return parts.join("\n");
  }
  const prov = evidenceProvenanceLabel(bank.provenance);
  parts.push(`- **provenance**: \`${bank.provenance}\` — ${prov.label}`);
  parts.push(`- **productDescription**: ${bank.productDescription.length} chars`);
  parts.push(`- **features**: ${bank.features.length}`);
  parts.push(`- **proofItems**: ${bank.proofItems.length}`);
  parts.push(`- **competitors listed**: ${bank.competitors.length}`);
  parts.push(`- **allowedClaims**: ${bank.allowedClaims.length}`);
  parts.push(`- **forbiddenClaims**: ${bank.forbiddenClaims.length}`);
  parts.push(`- **tone**: ${bank.tone}`);
  parts.push(`- **updatedAt**: ${nice(bank.updatedAt)}`);
  parts.push("");
  parts.push(`> ${prov.caveat}`);
  parts.push("");
  parts.push("### Product description");
  parts.push(bank.productDescription.length > 0 ? bank.productDescription : "_empty_");
  parts.push("");
  parts.push("### Target audience");
  parts.push(bulletList(bank.targetAudience));
  parts.push("");
  parts.push("### Main use cases");
  parts.push(bulletList(bank.mainUseCases));
  parts.push("");
  parts.push("### Features");
  if (bank.features.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| name | description |");
    parts.push("|---|---|");
    for (const f of bank.features) {
      parts.push(`| ${mdEscape(f.name)} | ${mdEscape(f.description)} |`);
    }
  }
  parts.push("");
  parts.push("### Proof items");
  if (bank.proofItems.length === 0) {
    parts.push("_none_");
  } else {
    parts.push("| type | detail | sourceUrl |");
    parts.push("|---|---|---|");
    for (const p of bank.proofItems) {
      parts.push(
        `| ${mdEscape(p.type)} | ${mdEscape(p.detail)} | ${mdEscape(safeString(p.sourceUrl))} |`
      );
    }
  }
  parts.push("");
  parts.push("### Allowed claims");
  parts.push(bulletList(bank.allowedClaims));
  parts.push("");
  parts.push("### Forbidden claims");
  parts.push(bulletList(bank.forbiddenClaims));
  parts.push("");
  if (bank.notes && bank.notes.trim().length > 0) {
    parts.push("### Notes");
    parts.push(bank.notes);
    parts.push("");
  }
  return parts.join("\n");
}

function sectionFixBrief(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[12]}`);
  parts.push("");
  if (input.fixBriefs.length === 0) {
    parts.push("_No Fix Brief generated yet._");
    parts.push("");
    return parts.join("\n");
  }
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const sorted = sortFixBriefsForDisplay(input.fixBriefs, input, brandName);
  for (const fb of sorted) {
    const displayStatus = derivedFixBriefStatus(input, fb, brandName);
    parts.push(`### Fix Brief · \`${fb.id}\` · priority ${fb.priority} · status: **${displayStatus}**`);
    parts.push("");
    parts.push(`- **lostPrompt**: ${mdEscape(fb.lostPrompt)}`);
    parts.push(`- **competitorRecommended**: ${mdEscape(fb.competitorRecommended)}`);
    parts.push(`- **fixType**: \`${fb.fixType}\``);
    parts.push(`- **expectedImpact**: ${mdEscape(fb.expectedImpact)}`);
    parts.push(`- **createdAt**: ${nice(fb.createdAt)}`);
    parts.push(`- **updatedAt**: ${nice(fb.updatedAt)}`);
    if (isFixBriefStaleForProbeSet(fb, input)) {
      parts.push(`- **data freshness**: historical — this Fix Brief was created before the latest selected probe set; regenerate it before treating it as a current recommendation.`);
    }
    parts.push("");
    parts.push("#### Root cause");
    parts.push(fb.rootCause);
    parts.push("");
    parts.push("#### Recommended fix");
    parts.push(fb.recommendedFix);
    parts.push("");
    parts.push("#### Assets to generate");
    parts.push(bulletList(fb.assetsToGenerate));
    parts.push("");
    parts.push("#### Evidence needed");
    const currentNeeds = displayStatus === "assets_ready"
      ? []
      : fb.evidenceNeeded.filter((need) => !isEvidenceNeedSatisfiedByCurrentState(need, input));
    parts.push(bulletList(currentNeeds));
    parts.push("");
    parts.push("#### Evidence available");
    parts.push(bulletList(fb.evidenceAvailable));
    parts.push("");
  }
  return parts.join("\n");
}

function renderAssetBlock(
  input: BuildMvpReportInput,
  asset: GeneratedAssetRow
): string {
  const parts: string[] = [];
  const latest = input.latestQaByAsset.get(asset.id) ?? null;
  const effectiveStatus = asset.qaStatus;
  const notReady = isNotReadyToPublish(effectiveStatus);

  parts.push(`#### Asset · ${mdEscape(asset.title)}`);
  parts.push("");
  parts.push(`- **assetId**: \`${asset.id}\``);
  parts.push(`- **fixBriefId**: \`${asset.fixBriefId}\``);
  parts.push(`- **assetType**: \`${asset.assetType}\``);
  parts.push(`- **generation**: ${mdEscape(asset.generationProvider ?? "unknown")} / ${mdEscape(asset.generationModel ?? "unknown")}`);
  parts.push(`- **qa_status**: \`${effectiveStatus}\``);
  parts.push(`- **lifecycle**: \`${asset.lifecycleStatus}\``);
  parts.push(`- **QA verdict**: ${latest ? `\`${latest.verdict}\`` : "_no QA report_"}`);
  parts.push(`- **violations**: ${latest ? latest.violations.length : 0}`);
  parts.push(
    `- **placeholders still required**: ${latest ? latest.placeholdersRemaining.length : asset.placeholders.length}`
  );
  parts.push(`- **claims used**: ${asset.claimsUsed.length}`);
  parts.push(`- **safe-to-publish**: ${yesNo(effectiveStatus === "safe_to_publish")}`);
  if (notReady) {
    parts.push("");
    parts.push(
      `> **NOT READY TO PUBLISH** — ${qaContextTagline(effectiveStatus)}`
    );
  }
  parts.push("");
  if (latest && latest.violations.length > 0) {
    parts.push("**Violations**");
    parts.push("| type | quote | reason | suggested fix |");
    parts.push("|---|---|---|---|");
    for (const v of latest.violations) {
      parts.push(
        `| \`${mdEscape(v.type)}\` | ${mdEscape(v.quote)} | ${mdEscape(v.reason)} | ${mdEscape(v.suggestedFix)} |`
      );
    }
    parts.push("");
  }
  if (asset.placeholders.length > 0) {
    parts.push("**Placeholders declared in content**");
    parts.push(bulletList(asset.placeholders.map((p) => `\`${p}\``)));
    parts.push("");
  }
  if (asset.claimsUsed.length > 0) {
    parts.push("**Claims used**");
    parts.push("| claim | source |");
    parts.push("|---|---|");
    for (const c of asset.claimsUsed) {
      parts.push(`| ${mdEscape(c.claim)} | \`${mdEscape(c.source)}\` |`);
    }
    parts.push("");
  }
  parts.push("**Asset content**");
  parts.push("");
  parts.push(wrapAssetContent(asset.content, assetTypeToInfoString(asset.assetType)));
  parts.push("");
  return parts.join("\n");
}

function sectionAssetsGrouped(input: BuildMvpReportInput): {
  markdown: string;
  notReadyCount: number;
} {
  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[13]}`);
  parts.push("");
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const activeAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);

  if (input.assets.length === 0) {
    parts.push("_No generated assets yet._");
    parts.push("");
    return { markdown: parts.join("\n"), notReadyCount: 0 };
  }

  const bucket = bucketAssets(activeAssets);
  const notReadyCount =
    bucket.needsEvidence.length +
    bucket.unsupportedClaims.length +
    bucket.pendingQa.length +
    bucket.qaFailed.length;

  const groups: Array<{
    label: string;
    intro: string;
    assets: GeneratedAssetRow[];
  }> = [
    {
      label: "Publish-ready",
      intro:
        "These assets passed QA and can be published as-is. Review copy for tone before shipping.",
      assets: bucket.publishReady,
    },
    {
      label: "Needs evidence",
      intro:
        "QA held these assets because the Evidence Bank does not yet contain the specific facts they rely on. Add the missing evidence and re-run QA to promote them to publish-ready.",
      assets: bucket.needsEvidence,
    },
    {
      label: "Unsupported claims",
      intro:
        "QA flagged one or more claims that are not backed by the Evidence Bank. Trim the claims or add supporting proof, then re-run QA.",
      assets: bucket.unsupportedClaims,
    },
    {
      label: "Pending QA",
      intro:
        "QA has not run against these drafts yet. Run QA before deciding whether to publish.",
      assets: bucket.pendingQa,
    },
    {
      label: "QA failed",
      intro:
        "QA started but did not complete for these assets. They are not publishable until QA is re-run successfully.",
      assets: bucket.qaFailed,
    },
  ];

  for (const g of groups) {
    parts.push(`### ${g.label} (${g.assets.length})`);
    parts.push("");
    if (g.assets.length === 0) {
      parts.push(`_None._`);
      parts.push("");
      continue;
    }
    parts.push(g.intro);
    parts.push("");
    for (const asset of g.assets) {
      parts.push(renderAssetBlock(input, asset));
    }
  }

  if (supersededAssets.length > 0) {
    parts.push(`### Superseded assets (${supersededAssets.length})`);
    parts.push("");
    parts.push("These assets are kept for auditability and progress history. They do not drive the current publishability score.");
    parts.push("");
    for (const asset of supersededAssets) {
      parts.push(renderAssetBlock(input, asset));
    }
  }

  const modelSummary = renderGenerationModelSummary(input, activeAssets);
  if (modelSummary) {
    parts.push(modelSummary);
  }

  return { markdown: parts.join("\n"), notReadyCount };
}

function renderGenerationModelSummary(input: BuildMvpReportInput, assetsForSummary?: GeneratedAssetRow[]): string {
  const sourceAssets = assetsForSummary ?? input.assets;
  const assets = sourceAssets.filter((a) => a.generationModel && a.generationModel !== "legacy_unknown");
  if (assets.length === 0) return "";
  const groups = new Map<string, { assets: number; violations: number; placeholders: number; safe: number; needs: number; unsupported: number }>();
  for (const asset of assets) {
    const model = `${asset.generationProvider ?? "unknown"}/${asset.generationModel ?? "unknown"}`;
    const qa = input.latestQaByAsset.get(asset.id) ?? null;
    const row = groups.get(model) ?? { assets: 0, violations: 0, placeholders: 0, safe: 0, needs: 0, unsupported: 0 };
    row.assets += 1;
    row.violations += qa ? qa.violations.length : 0;
    row.placeholders += qa ? qa.placeholdersRemaining.length : asset.placeholders.length;
    if (asset.qaStatus === "safe_to_publish") row.safe += 1;
    if (asset.qaStatus === "needs_evidence") row.needs += 1;
    if (asset.qaStatus === "unsupported_claims") row.unsupported += 1;
    groups.set(model, row);
  }
  const parts: string[] = [];
  parts.push("### Generation model benchmark");
  parts.push("");
  parts.push("| generation | assets | safe | needs evidence | unsupported claims | total violations | placeholders | avg violations / asset |");
  parts.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [model, row] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = row.assets > 0 ? (row.violations / row.assets).toFixed(1) : "0.0";
    parts.push(`| ${mdEscape(model)} | ${row.assets} | ${row.safe} | ${row.needs} | ${row.unsupported} | ${row.violations} | ${row.placeholders} | ${avg} |`);
  }
  parts.push("");
  return parts.join("\n");
}

function sectionQaReview(input: BuildMvpReportInput, qaDist: Record<string, number>): string {
  const parts: string[] = [];
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const activeAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);
  const activeReports = activeAssets.filter((a) => input.latestQaByAsset.has(a.id)).length;
  parts.push(`## ${REPORT_SECTIONS[14]}`);
  parts.push("");
  parts.push(`- **current active assets with a QA report**: ${activeReports} / ${activeAssets.length}`);
  parts.push(`- **superseded / historical assets kept for audit**: ${supersededAssets.length}`);
  parts.push("");
  parts.push("### QA status distribution");
  parts.push("| qa_status | count |");
  parts.push("|---|---|");
  for (const [k, v] of Object.entries(qaDist)) parts.push(`| ${mdEscape(k)} | ${v} |`);
  parts.push("");
  if (activeReports === 0) {
    parts.push("_No QA reports have been persisted yet._");
    parts.push("");
    return parts.join("\n");
  }
  parts.push("### Latest verdict per asset");
  parts.push("| asset | assetType | qa_status | verdict | violations | placeholders remaining |");
  parts.push("|---|---|---|---|---|---|");
  for (const asset of activeAssets) {
    const latest = input.latestQaByAsset.get(asset.id) ?? null;
    parts.push(`| ${mdEscape(asset.title)} | \`${mdEscape(asset.assetType)}\` | \`${asset.qaStatus}\` | ${latest ? `\`${mdEscape(latest.verdict)}\`` : "_none_"} | ${latest ? latest.violations.length : 0} | ${latest ? latest.placeholdersRemaining.length : asset.placeholders.length} |`);
  }
  parts.push("");
  return parts.join("\n");
}

function sectionWarnings(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const activeAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);
  const notReady = activeAssets.filter((a) => isNotReadyToPublish(a.qaStatus));
  const pending = activeAssets.filter((a) => a.qaStatus === "pending_qa");
  const qaFailed = activeAssets.filter((a) => a.qaStatus === "qa_failed");
  const missingReports = activeAssets.filter((a) => !input.latestQaByAsset.has(a.id));
  parts.push(`## ${REPORT_SECTIONS[15]}`);
  parts.push("");
  parts.push(`- **current active assets NOT READY TO PUBLISH**: ${notReady.length}`);
  parts.push(`- **superseded / historical assets excluded from current warnings**: ${supersededAssets.length}`);
  parts.push(`- **assets still \`pending_qa\`**: ${pending.length}`);
  parts.push(`- **assets with \`qa_failed\`**: ${qaFailed.length}`);
  parts.push(`- **assets with no QA report**: ${missingReports.length}`);
  parts.push("");
  if (notReady.length === 0) {
    if (
      currentAssetsForReport(
        input,
        resolveCompanyName(
          input.project,
          input.mirrorProfile
        ).name
      ).length === 0
    ) {
      parts.push(
        "No active assets were available for QA."
      );
    } else {
      parts.push(
        "All current active assets pass QA."
      );
    }
    parts.push("");
    return parts.join("\n");
  }
  parts.push("### Warnings per asset");
  parts.push("| asset | qa_status | reason to hold |");
  parts.push("|---|---|---|");
  for (const asset of notReady) {
    const latest = input.latestQaByAsset.get(asset.id) ?? null;
    const reason = !latest ? `qa_status=${asset.qaStatus} but no QA report is stored` : `${latest.violations.length} violation(s)${latest.placeholdersRemaining.length ? `, ${latest.placeholdersRemaining.length} placeholder(s) remaining` : ""}`;
    parts.push(`| ${mdEscape(asset.title)} | \`${asset.qaStatus}\` | ${mdEscape(reason)} |`);
  }
  parts.push("");
  parts.push("> Every row above is a current active asset labeled **NOT READY TO PUBLISH**. Superseded assets are preserved in Section 14 for audit history but excluded from current warnings.");
  parts.push("");
  return parts.join("\n");
}

function sectionLimitations(input: BuildMvpReportInput): string {
  const limits: string[] = [];
  if (!input.mirrorProfile) limits.push("No Mirror Profile has been generated for this project.");
  if (input.prompts.length === 0) limits.push("No buyer prompts have been generated yet.");
  if (input.probeResults.length === 0) limits.push("No probe results have been recorded.");
  if (input.competitors.length === 0) limits.push("No competitors have been discovered.");
  if (!input.gapMap) limits.push("No Gap Map has been generated.");
  if (input.gaps.length === 0) limits.push("No prioritized gaps yet.");
  if (!input.evidenceBank) limits.push("No Evidence Bank has been prepared.");
  if (input.fixBriefs.length === 0) limits.push("No Fix Brief has been created.");
  if (input.assets.length === 0) limits.push("No generated assets yet.");
  if (input.latestQaByAsset.size < input.assets.length) {
    limits.push(
      `${input.assets.length - input.latestQaByAsset.size} generated asset(s) do not have a QA report yet.`
    );
  }
  const modeSummary = aggregateProbeMode(input.probeResults);
  if (modeSummary === "live_perplexity") {
    limits.push(
      "Probe answers in this scan came from live Perplexity Sonar API responses only. Do not generalize them to ChatGPT, Gemini, Claude, or the whole market."
    );
  } else if (modeSummary === "mixed") {
    limits.push(
      "This scan mixes simulated probe answers with live Perplexity Sonar API responses. Each probe row is labeled with its origin."
    );
  } else {
    limits.push(
      "Probe answers in this scan are **simulated**, not live platform-API responses. Do not quote them as if ChatGPT / Perplexity / Gemini actually said them."
    );
  }
  limits.push(
    "This export is a snapshot of stored data only. No LLM calls, no probes, no writes. Re-run the pipeline before shipping if the state has changed since generation."
  );

  const parts: string[] = [];
  parts.push(`## ${REPORT_SECTIONS[16]}`);
  parts.push("");
  parts.push(bulletList(limits));
  parts.push("");
  return parts.join("\n");
}

function sectionBlockedFixes(input: BuildMvpReportInput): string {
  const parts: string[] = [];
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  parts.push(`## ${REPORT_SECTIONS[17]}`);
  parts.push("");
  const rows = input.fixBriefs.map((fb) => ({ fb, status: derivedFixBriefStatus(input, fb, brandName), needs: fb.evidenceNeeded.filter((need) => !isEvidenceNeedSatisfiedByCurrentState(need, input)) }));
  const blocked = rows.filter((r) => r.status !== "assets_ready" && r.status !== "historical");
  const historical = rows.filter((r) => r.status === "historical");
  const missingEvidenceForBriefs = blocked.filter((r) => r.needs.length > 0);
  if (blocked.length === 0 && missingEvidenceForBriefs.length === 0) {
    parts.push("_No current blocked fixes recorded._");
    if (historical.length > 0) {
      parts.push("");
      parts.push(`_${historical.length} historical Fix Brief${historical.length === 1 ? "" : "s"} kept for audit._`);
    }
    parts.push("");
    return parts.join("\n");
  }
  if (blocked.length > 0) {
    parts.push("### Current Fix Briefs not yet ready");
    parts.push("| fixBriefId | derived status | stored status | fixType | competitor | lostPrompt |");
    parts.push("|---|---|---|---|---|---|");
    for (const { fb, status } of blocked) parts.push(`| \`${fb.id}\` | \`${status}\` | \`${fb.status}\` | \`${fb.fixType}\` | ${mdEscape(fb.competitorRecommended)} | ${mdEscape(fb.lostPrompt)} |`);
    parts.push("");
  }
  if (missingEvidenceForBriefs.length > 0) {
    parts.push("### Current Fix Briefs still asking for evidence");
    for (const { fb, needs } of truthyLimit(missingEvidenceForBriefs, 10)) {
      parts.push(`- Fix Brief \`${fb.id}\` (fixType \`${fb.fixType}\`) needs:`);
      for (const need of needs) parts.push(`  - ${mdEscape(need)}`);
    }
    parts.push("");
  }
  if (historical.length > 0) {
    parts.push("### Historical Fix Briefs kept for audit");
    parts.push("| fixBriefId | fixType | lostPrompt |");
    parts.push("|---|---|---|");
    for (const { fb } of historical) parts.push(`| \`${fb.id}\` | \`${fb.fixType}\` | ${mdEscape(fb.lostPrompt)} |`);
    parts.push("");
  }
  return parts.join("\n");
}

function sectionAppendixMetadata(
  input: BuildMvpReportInput,
  qaDist: Record<string, number>,
  now: Date
): string {
  const brandName = resolveCompanyName(input.project, input.mirrorProfile).name;
  const activeAssets = currentAssetsForReport(input, brandName);
  const supersededAssets = supersededAssetsForReport(input, brandName);
  const probeSet = getProbeSet(input, brandName);
  const rows: Array<[string, string]> = [
    ["report generated", now.toISOString()],
    ["exportFormatVersion", String(EXPORT_FORMAT_VERSION)],
    ["projectId", input.project.id],
    ["scanId (mirrorProfileId)", input.mirrorProfile?.id ?? "n/a"],
    ["source URL tested", `\`${input.project.domain}\``],
    ["provider", input.llmProvider ?? "n/a"],
    ["model", input.llmModel ?? "n/a"],
    ["mock mode", input.mockMode ? "on" : "off"],
    [
      "probe origin",
      (() => {
        const m = aggregateProbeMode(input.probeResults);
        if (m === "live_perplexity") return "live_perplexity (real Perplexity Sonar API responses)";
        if (m === "mixed")
          return "mixed simulated + live Perplexity (see per-probe labels in Section 7)";
        if (m === "none") return "simulated (no live platform API integration)";
        return "simulated (no live platform API integration)";
      })(),
    ],
    ["project.createdAt", nice(input.project.createdAt)],
    ["mirrorProfile.createdAt", nice(input.mirrorProfile?.createdAt ?? null)],
    ["evidenceBank.updatedAt", nice(input.evidenceBank?.updatedAt ?? null)],
    ["prompts total", String(input.prompts.length)],
    // Derived from the SAME probe subset the Executive Summary uses
    // (`scorecardPromptGroups` / `scorecardProbeResults`), so the two
    // sections can never disagree — including when branded prompt groups
    // exist and the scorecard is restricted to unbranded prompts. Stored
    // rows flagged `selected` are authoring intent and must never be
    // reported as prompts probed.
    [
      "distinct prompts represented in scorecard results",
      String(probeSet.scorecardPromptGroups.length),
    ],
    ["scorecard probe runs", String(probeSet.scorecardProbeResults.length)],
    ["all stored probe rows", String(input.probeResults.length)],
    ["competitors", String(input.competitors.length)],
    ["prioritized gaps", String(input.gaps.length)],
    ["fix briefs", String(input.fixBriefs.length)],
    ["generated assets", String(input.assets.length)],
    ["current active assets", String(activeAssets.length)],
    ["superseded / historical assets", String(supersededAssets.length)],
    ["QA reports (latest per asset)", String(input.latestQaByAsset.size)],
    [
      "QA distribution",
      Object.entries(qaDist)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "n/a",
    ],
  ];
  const lines = rows.map(([k, v]) => `- **${k}**: ${v}`).join("\n");
  return [
    `## ${REPORT_SECTIONS[18]}`,
    "",
    "_This appendix contains identifiers, timestamps, and traceability data — useful for auditing or reproducing a scan, but not client-facing content._",
    "",
    lines,
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Top-level builder                                                         */
/* -------------------------------------------------------------------------- */

export function buildMvpReport(input: BuildMvpReportInput): BuildMvpReportOutput {
  const now = input.now ?? new Date();

  const brand = resolveCompanyName(input.project, input.mirrorProfile);
  const cat = resolveCategoryDisplay(input.project, input.mirrorProfile);
  const currentAssets = currentAssetsForReport(input, brand.name);
  const qaDistribution = qaDistributionForAssets(currentAssets);

  const assetsSection = sectionAssetsGrouped(input);

  const sections = [
    sectionExecSummary(input, brand.name, cat.display, qaDistribution),
    sectionPublishability(input),
    sectionEvidenceNeeded(input),
    sectionProjectSummary(input, brand.name, brand.source),
    sectionMirrorProfile(input, cat.display, cat.caveat),
    sectionPrompts(input),
    sectionProbeResults(input),
    sectionWhatThisMeans(input, brand.name),
    sectionCompetitors(input),
    sectionGapMap(input),
    sectionRecommendedNextActions(input, brand.name),
    sectionEvidenceBank(input),
    sectionFixBrief(input),
    assetsSection.markdown,
    sectionQaReview(input, qaDistribution),
    sectionWarnings(input),
    sectionLimitations(input),
    sectionBlockedFixes(input),
    sectionAppendixMetadata(input, qaDistribution, now),
  ];

  const header = [
    "# Zypact MVP — Client Report",
    "",
    `> Read-only snapshot of the AI-visibility scan for **${brand.name}** (\`${input.project.domain}\`). Generated ${now.toISOString()}.`,
    "> Rendering this export triggered no new LLM calls, live probes, or database writes.",
    "",
    "---",
    "",
  ].join("\n");

  const body = sections.join("\n---\n\n");

  const raw = `${header}${body}\n`;
  const swept = redactSensitive(raw, input.sensitiveValues ?? []);

  const filename = `zypact-report-${input.project.id}-${isoDay(now)}.md`;

  return {
    markdown: swept.output,
    filename,
    qaDistribution,
    publishability: {
      total: currentAssets.length,
      publishReady: qaDistribution.safe_to_publish ?? 0,
      needsEvidence: qaDistribution.needs_evidence ?? 0,
      unsupportedClaims: qaDistribution.unsupported_claims ?? 0,
      pendingQa: qaDistribution.pending_qa ?? 0,
      qaFailed: qaDistribution.qa_failed ?? 0,
    },
    warnings: {
      secretsRedactedCount: swept.redactionCount,
      notReadyAssetCount: assetsSection.notReadyCount,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Loader helper (used by the route handler)                                 */
/* -------------------------------------------------------------------------- */

export async function loadReportInputs(
  db: import("@/lib/db/types").DbAdapter,
  projectId: string
): Promise<Omit<BuildMvpReportInput, "sensitiveValues" | "llmProvider" | "llmModel" | "mockMode" | "now"> | null> {
  const project = await db.getProject(projectId);
  if (!project) return null;

  const [
    mirrorProfile,
    prompts,
    probeResults,
    competitors,
    gapMap,
    gaps,
    evidenceBank,
    fixBriefs,
    assets,
    qaReports,
  ] = await Promise.all([
    db.getMirrorProfile(projectId),
    db.getGeneratedPrompts(projectId),
    db.getProbeResultsByProject(projectId),
    db.getCompetitorsByProject(projectId),
    db.getLatestGapMap(projectId),
    db.getGapsByProject(projectId),
    db.getEvidenceBankByProject(projectId),
    db.getFixBriefsByProject(projectId),
    db.getGeneratedAssetsByProject(projectId),
    db.getQaReportsByProject(projectId),
  ]);

  const latestQaByAsset = new Map<string, QaReportRow>();
  const sortedReports = [...qaReports].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
  for (const r of sortedReports) {
    if (!latestQaByAsset.has(r.generatedAssetId)) {
      latestQaByAsset.set(r.generatedAssetId, r);
    }
  }

  return {
    project,
    mirrorProfile,
    prompts,
    probeResults,
    competitors,
    gapMap,
    gaps,
    evidenceBank,
    fixBriefs,
    assets,
    latestQaByAsset,
  };
}
