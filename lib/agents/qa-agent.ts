import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { QA_AGENT_SYSTEM_PROMPT } from "@/lib/agent-prompts/qa-agent.prompt";
import {
  QaAgentOutputSchema,
  type QaAgentOutput,
  type QaVerdict,
  type QaViolation,
} from "@/lib/schemas/qa-agent.schema";
import {
  SPRINT_7_BANNED_PHRASES,
  findBannedPhrases,
} from "@/lib/schemas/fix-brief.schema";
import { extractEvidencePlaceholders } from "@/lib/schemas/generated-asset.schema";
import type { EvidenceBankOutput } from "@/lib/schemas/evidence-bank.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { GeneratedAssetRow } from "@/lib/db/types";

/**
 * QA Agent — Sprint 9.
 *
 * Adversarial verifier for Generated Assets. Wraps the asset, Evidence
 * Bank, and Mirror Profile in the canonical `<asset>`, `<evidence_bank>`,
 * `<mirror_profile>` tags and calls the model with
 * `QA_AGENT_SYSTEM_PROMPT`. Output is validated against
 * `QaAgentOutputSchema` — including verdict/violations consistency.
 *
 * The deterministic mock (used when no LLM key is configured) inspects the
 * asset for forbidden claims, unsupported numbers, fabrications,
 * competitor risk, and implied results. It NEVER flags a legitimate
 * `[EVIDENCE NEEDED: …]` placeholder as a violation.
 */

export interface RunQaAgentInput {
  asset: GeneratedAssetRow;
  evidenceBank: EvidenceBankOutput;
  mirrorProfile: SiteReaderOutput;
}

export interface RunQaAgentResult {
  output: QaAgentOutput;
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

/* -------------------------------------------------------------------------- */
/*  User-message builder                                                      */
/* -------------------------------------------------------------------------- */

function slimAsset(asset: GeneratedAssetRow): unknown {
  // Never send DB audit columns to the model — they distract and can leak
  // internal fields the QA Agent must not reason about.
  return {
    id: asset.id,
    fixBriefId: asset.fixBriefId,
    assetType: asset.assetType,
    title: asset.title,
    content: asset.content,
    placeholders: asset.placeholders,
    claimsUsed: asset.claimsUsed,
    qaStatus: asset.qaStatus,
  };
}

function slimEvidenceBank(bank: EvidenceBankOutput): unknown {
  return {
    productDescription: bank.productDescription,
    targetAudience: bank.targetAudience,
    mainUseCases: bank.mainUseCases,
    features: bank.features,
    proofItems: bank.proofItems,
    competitors: bank.competitors,
    allowedClaims: bank.allowedClaims,
    forbiddenClaims: bank.forbiddenClaims,
    tone: bank.tone,
    notes: bank.notes,
  };
}

function buildUserMessage(input: RunQaAgentInput): string {
  return [
    "<asset>",
    JSON.stringify(slimAsset(input.asset), null, 2),
    "</asset>",
    "<evidence_bank>",
    JSON.stringify(slimEvidenceBank(input.evidenceBank), null, 2),
    "</evidence_bank>",
    "<mirror_profile>",
    JSON.stringify(input.mirrorProfile, null, 2),
    "</mirror_profile>",
  ].join("\n");
}

/**
 * Sprint 12.1: normalize non-decision QA prose before Zod enforces the
 * decision contract. Verdicts, violations, quotes, reasons, and statuses
 * remain strict; this only makes the free-text summary resilient when a
 * model returns an empty string.
 */
export function preNormalizeQaAgentOutput(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const obj = parsed as Record<string, unknown>;
  const notes = obj.overallNotes;
  if (typeof notes !== "string" || notes.trim().length === 0) {
    return { ...obj, overallNotes: "No additional notes." };
  }
  return { ...obj, overallNotes: notes.trim() };
}

/* -------------------------------------------------------------------------- */
/*  Agent entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function runQaAgent(
  input: RunQaAgentInput
): Promise<RunQaAgentResult> {
  const userMessage = buildUserMessage(input);
  const mock = buildMockQaReport(input);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: QA_AGENT_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    // QA is adversarial — keep temperature low so subtle violations are
    // caught consistently rather than sometimes overlooked.
    temperature: 0.1,
    maxTokens: 3000,
    mockResponse,
  };

  const startedAt = Date.now();
  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: QaAgentOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
    preNormalize: preNormalizeQaAgentOutput,
  });
  const latencyMs = Date.now() - startedAt;

  if (!parsed.ok) {
    throw new Error(
      `QA Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  return {
    output: parsed.data,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
    provider: initial.provider,
    model: initial.model,
    latencyMs,
    requestText: `${call.system}\n\n${call.user}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deterministic mock                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder-safe removal: strip every `[EVIDENCE NEEDED: …]` span from
 * the asset content so downstream detectors (numbers, fabrication,
 * competitor risk) do not read inside placeholders. Placeholders are
 * legitimate — they belong in `placeholdersRemaining`, not `violations`.
 */
function stripPlaceholders(content: string): string {
  return content.replace(/\[EVIDENCE NEEDED:[^\]]*\]/g, " ");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function collectSupportedCorpus(
  bank: EvidenceBankOutput,
  mirror: SiteReaderOutput
): string {
  const parts: string[] = [];
  parts.push(bank.productDescription);
  parts.push(...bank.targetAudience);
  parts.push(...bank.mainUseCases);
  for (const f of bank.features) {
    parts.push(f.name, f.description);
  }
  for (const p of bank.proofItems) {
    parts.push(p.type, p.detail, p.sourceUrl ?? "");
  }
  parts.push(...bank.competitors);
  parts.push(...bank.allowedClaims);
  parts.push(bank.notes);

  parts.push(mirror.companyName ?? "");
  parts.push(mirror.website ?? "");
  parts.push(mirror.detectedCategory ?? "");
  parts.push(...mirror.targetAudience);
  parts.push(...mirror.useCases);
  parts.push(...mirror.features);
  parts.push(...mirror.painPointsAddressed);
  parts.push(...mirror.buyerIntentAngles);
  parts.push(mirror.aiReadabilityNotes);
  for (const c of mirror.claims) parts.push(c.claim);
  for (const p of mirror.proofSignals) parts.push(p.detail);
  for (const m of mirror.missingSignals) {
    parts.push(m.signal, m.whyItMatters);
  }
  parts.push(...mirror.competitorsMentioned);

  return normalize(parts.join(" \n "));
}

/**
 * Detect banned / forbidden guarantee-style phrases from BOTH the shared
 * Sprint 7 list and the project's own `forbiddenClaims`. Returns unique
 * violations (one per phrase found).
 */
function detectForbiddenClaimViolations(
  text: string,
  evidenceBank: EvidenceBankOutput
): QaViolation[] {
  const out: QaViolation[] = [];
  const seen = new Set<string>();

  const bannedHits = findBannedPhrases(text);
  for (const phrase of bannedHits) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "forbidden_claim",
      quote: phrase,
      reason: `Text contains banned guarantee-style claim "${phrase}" (Sprint 7 shared ban list).`,
      suggestedFix:
        "remove or rewrite this sentence with a specific, verifiable statement backed by the Evidence Bank",
    });
  }

  const norm = normalize(text);
  for (const claim of evidenceBank.forbiddenClaims) {
    const key = normalize(claim);
    if (key.length === 0) continue;
    if (!norm.includes(key)) continue;
    // Prefer the exact Sprint 7 phrase we already reported for identical
    // phrases (avoids duplicate reports for the same underlying string).
    const dedupeKey = `bank:${key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (SPRINT_7_BANNED_PHRASES.some((p) => normalize(p) === key)) continue;
    out.push({
      type: "forbidden_claim",
      quote: claim,
      reason: `Text contains a phrase the client has explicitly forbidden ("${claim}") in the Evidence Bank.`,
      suggestedFix:
        "remove or rewrite this sentence with a specific, verifiable statement backed by the Evidence Bank",
    });
  }

  return out;
}

/**
 * Match every number token that looks like a claim (statistic, percentage,
 * multiplier, count, or price). Verifies each verbatim against the
 * supported corpus; unsupported ones become `unsupported_number`
 * violations. Small integers (single digits without a unit) are ignored to
 * avoid false positives on section headings ("Q1", "1.").
 */
const NUMBER_PATTERN =
  /(?:\$\d{1,3}(?:,\d{3})+|\$\d+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+x\b|\d{2,}(?:\.\d+)?|\d+\.\d+)/gi;

function detectUnsupportedNumberViolations(
  strippedContent: string,
  supported: string
): QaViolation[] {
  const found = strippedContent.match(NUMBER_PATTERN) ?? [];
  const out: QaViolation[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const token = raw.trim();
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (supported.includes(key)) continue;
    out.push({
      type: "unsupported_number",
      quote: token,
      reason: `The number "${token}" is not present in the Evidence Bank or Mirror Profile.`,
      suggestedFix:
        "remove the number, or replace it with an [EVIDENCE NEEDED: source for this figure] placeholder",
    });
  }
  return out;
}

/**
 * Fabrication check for `claimsUsed`. Every claim entry that says it came
 * from the evidence bank / mirror profile must actually appear (as a
 * substring, normalized) in that source. Any claim that fails this check
 * is a fabrication regardless of surface form.
 */
function detectClaimFabricationViolations(
  asset: GeneratedAssetRow,
  evidenceBank: EvidenceBankOutput,
  mirrorProfile: SiteReaderOutput
): QaViolation[] {
  const bankCorpus = normalize(
    [
      evidenceBank.productDescription,
      ...evidenceBank.targetAudience,
      ...evidenceBank.mainUseCases,
      ...evidenceBank.features.flatMap((f) => [f.name, f.description]),
      ...evidenceBank.proofItems.flatMap((p) => [p.type, p.detail]),
      ...evidenceBank.allowedClaims,
      ...evidenceBank.competitors,
      evidenceBank.notes,
    ].join(" \n ")
  );
  const mirrorCorpus = normalize(
    [
      mirrorProfile.companyName ?? "",
      mirrorProfile.detectedCategory ?? "",
      mirrorProfile.website ?? "",
      ...mirrorProfile.targetAudience,
      ...mirrorProfile.useCases,
      ...mirrorProfile.features,
      ...mirrorProfile.painPointsAddressed,
      ...mirrorProfile.buyerIntentAngles,
      mirrorProfile.aiReadabilityNotes,
      ...mirrorProfile.claims.map((c) => c.claim),
      ...mirrorProfile.proofSignals.map((p) => p.detail),
      ...mirrorProfile.competitorsMentioned,
    ].join(" \n ")
  );

  const out: QaViolation[] = [];
  for (const c of asset.claimsUsed) {
    const raw = normalize(c.claim);
    // Also try a label-stripped form: many mock claims use a leading
    // "Audience:" / "Use case:" / "Category:" prefix which is metadata,
    // not a fact from the source. Match either form to avoid false
    // positives from labeling conventions.
    const stripped = normalize(c.claim.replace(/^[^:]+:\s*/, ""));
    if (raw.length === 0) continue;
    const corpus = c.source === "evidence_bank" ? bankCorpus : mirrorCorpus;
    if (corpus.includes(raw)) continue;
    if (stripped.length > 0 && corpus.includes(stripped)) continue;
    out.push({
      type: "fabrication",
      quote: c.claim,
      reason: `Claim marked as sourced from ${c.source} but no matching statement was found in that source.`,
      suggestedFix:
        "remove the claim, or add supporting evidence to the Evidence Bank / Mirror Profile before republishing",
    });
  }
  return out;
}

const COMPETITOR_RISK_PATTERNS: ReadonlyArray<{
  re: RegExp;
  reason: string;
}> = [
  { re: /\boutdated\b/i, reason: "calls a competitor outdated" },
  { re: /\blegacy\b/i, reason: "labels a competitor as legacy" },
  { re: /\bslow\b/i, reason: "describes a competitor as slow" },
  { re: /\binferior\b/i, reason: "calls a competitor inferior" },
  { re: /\bbroken\b/i, reason: "calls a competitor broken" },
  { re: /\bdying\b/i, reason: "calls a competitor dying" },
  { re: /\bworst\b/i, reason: "uses \"worst\" about a competitor" },
  { re: /\bnobody uses\b/i, reason: "says nobody uses the competitor" },
];

function detectCompetitorRiskViolations(
  strippedContent: string,
  evidenceBank: EvidenceBankOutput,
  mirrorProfile: SiteReaderOutput
): QaViolation[] {
  const competitors = new Set<string>();
  for (const c of evidenceBank.competitors) {
    const t = c.trim().toLowerCase();
    if (t.length > 0) competitors.add(t);
  }
  for (const c of mirrorProfile.competitorsMentioned) {
    const t = c.trim().toLowerCase();
    if (t.length > 0) competitors.add(t);
  }
  if (competitors.size === 0) return [];

  const contentLower = strippedContent.toLowerCase();
  const out: QaViolation[] = [];
  const seen = new Set<string>();
  for (const competitor of competitors) {
    if (!contentLower.includes(competitor)) continue;
    // Look for a disparaging pattern in a ±80-char window around any
    // occurrence of the competitor name.
    let idx = contentLower.indexOf(competitor);
    while (idx !== -1) {
      const from = Math.max(0, idx - 80);
      const to = Math.min(contentLower.length, idx + competitor.length + 80);
      const window = contentLower.slice(from, to);
      for (const pat of COMPETITOR_RISK_PATTERNS) {
        if (!pat.re.test(window)) continue;
        const key = `${competitor}:${pat.reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          type: "competitor_risk",
          quote: window.trim(),
          reason: `Text ${pat.reason} — risky and unverifiable statement about a competitor.`,
          suggestedFix:
            "remove or rewrite this as a neutral, factual comparison backed by the Evidence Bank",
        });
      }
      idx = contentLower.indexOf(competitor, idx + competitor.length);
    }
  }
  return out;
}

const IMPLIED_RESULT_PATTERNS: ReadonlyArray<{
  re: RegExp;
  phrase: string;
}> = [
  { re: /\bai\s+will\s+recommend\s+you\b/i, phrase: "AI will recommend you" },
  { re: /\bwill\s+rank\s+in\s+chatgpt\b/i, phrase: "will rank in ChatGPT" },
  { re: /\bwill\s+rank\s+(?:higher|#?1|first|top)\b/i, phrase: "will rank higher" },
  { re: /\b10x\s+your\s+visibility\b/i, phrase: "10x your visibility" },
  { re: /\bguaranteed\s+results?\b/i, phrase: "guaranteed results" },
  { re: /\bguaranteed\s+outcomes?\b/i, phrase: "guaranteed outcomes" },
];

function detectImpliedResultViolations(text: string): QaViolation[] {
  const out: QaViolation[] = [];
  const seen = new Set<string>();
  for (const pat of IMPLIED_RESULT_PATTERNS) {
    if (!pat.re.test(text)) continue;
    if (seen.has(pat.phrase)) continue;
    seen.add(pat.phrase);
    out.push({
      type: "implied_result",
      quote: pat.phrase,
      reason: `Text implies a promised outcome ("${pat.phrase}") that Zypact cannot guarantee.`,
      suggestedFix:
        "remove the promise; describe only what the fix publishes, never what AI will do next",
    });
  }
  return out;
}

/**
 * Compose the final verdict from the collected violations and placeholder
 * list, respecting the schema's cross-field rules exactly.
 */
function computeVerdict(
  violations: QaViolation[],
  placeholdersRemaining: string[]
): QaVerdict {
  const nonQuality = violations.filter((v) => v.type !== "quality");
  if (nonQuality.length > 0) return "unsupported_claims";
  if (placeholdersRemaining.length > 0) return "needs_evidence";
  if (violations.length > 0) return "needs_evidence"; // quality-only
  return "safe_to_publish";
}

function summarizeVerdict(
  verdict: QaVerdict,
  violations: QaViolation[],
  placeholdersRemaining: string[],
  asset: GeneratedAssetRow
): string {
  const titleTag = asset.title.length > 0 ? `"${asset.title}"` : asset.assetType;
  switch (verdict) {
    case "safe_to_publish":
      return `QA passed for ${titleTag}: no violations found and no placeholders remain.`;
    case "needs_evidence": {
      const parts: string[] = [];
      if (placeholdersRemaining.length > 0) {
        parts.push(
          `${placeholdersRemaining.length} [EVIDENCE NEEDED] placeholder${placeholdersRemaining.length === 1 ? "" : "s"} remain`
        );
      }
      if (violations.length > 0) {
        parts.push(
          `${violations.length} quality flag${violations.length === 1 ? "" : "s"}`
        );
      }
      return `QA flagged ${titleTag} as needs_evidence: ${parts.join(" and ") || "client confirmation required"}.`;
    }
    case "unsupported_claims": {
      const kinds = new Set(violations.map((v) => v.type));
      const list = [...kinds].join(", ");
      return `QA blocked ${titleTag}: ${violations.length} violation${violations.length === 1 ? "" : "s"} (${list}).`;
    }
  }
}

/** Public for testing — do not import from route/UI code. */
export function buildMockQaReport(input: RunQaAgentInput): QaAgentOutput {
  const { asset, evidenceBank, mirrorProfile } = input;

  const placeholdersRemaining = Array.from(
    new Set(extractEvidencePlaceholders(asset.content))
  );

  const stripped = stripPlaceholders(asset.content);
  const supported = collectSupportedCorpus(evidenceBank, mirrorProfile);

  const violations: QaViolation[] = [];

  // 1. Forbidden claims — check title + stripped content + claim strings.
  violations.push(
    ...detectForbiddenClaimViolations(
      [asset.title, stripped, asset.claimsUsed.map((c) => c.claim).join(" ")].join(
        " \n "
      ),
      evidenceBank
    )
  );

  // 2. Implied results — same corpus, ordered before unsupported numbers so
  //    "10x your visibility" fires as implied_result AND forbidden_claim
  //    (the latter dedupes the phrase itself).
  violations.push(
    ...detectImpliedResultViolations([asset.title, stripped].join(" \n "))
  );

  // 3. Unsupported numbers — stripped content only (numbers inside
  //    [EVIDENCE NEEDED: …] are meta, not asset claims).
  violations.push(
    ...detectUnsupportedNumberViolations(stripped, supported)
  );

  // 4. Fabrication — verify each claimsUsed entry appears in its source.
  violations.push(
    ...detectClaimFabricationViolations(asset, evidenceBank, mirrorProfile)
  );

  // 5. Competitor risk — disparaging language near any known competitor.
  violations.push(
    ...detectCompetitorRiskViolations(stripped, evidenceBank, mirrorProfile)
  );

  const verdict = computeVerdict(violations, placeholdersRemaining);
  const overallNotes = summarizeVerdict(
    verdict,
    violations,
    placeholdersRemaining,
    asset
  );

  return {
    verdict,
    violations,
    placeholdersRemaining,
    overallNotes,
  };
}
