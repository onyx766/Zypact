import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { FIX_AGENT_SYSTEM_PROMPT } from "@/lib/agent-prompts/fix-agent.prompt";
import {
  FixBriefOutputSchema,
  ROOT_CAUSE_MAX,
  type AssetType,
  type FixBriefOutput,
  type FixType,
} from "@/lib/schemas/fix-brief.schema";
import {
  extractEvidencePlaceholders,
  GeneratedAssetOutputSchema,
  type AssetTypeValue,
  type ClaimUsed,
  type GeneratedAssetOutput,
} from "@/lib/schemas/generated-asset.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type {
  CompetitorMention,
} from "@/lib/schemas/probe-analysis.schema";
import type { EvidenceBankOutput } from "@/lib/schemas/evidence-bank.schema";
import type { FixBriefRow, Gap, ProbeResult } from "@/lib/db/types";
import {
  defaultAssetsForFixType,
  inferFixType,
} from "@/lib/fix-brief/infer-fix-type";

/**
 * Fix Brief Agent — Sprint 7 (`fix_brief` mode only).
 *
 * The canonical system prompt supports two modes (`fix_brief` and
 * `generate_asset`). Sprint 7 calls the agent EXCLUSIVELY with
 * `<mode>fix_brief</mode>` — the deferred asset mode is not implemented.
 *
 * The user message is:
 *   <mode>fix_brief</mode>
 *   <gap>...</gap>
 *   <probe_result>...</probe_result>
 *   <mirror_profile>...</mirror_profile>
 *   <evidence_bank>...</evidence_bank>
 */

export type FixBriefMode = "fix_brief";
export const FIX_BRIEF_MODE: FixBriefMode = "fix_brief";

export interface RunFixBriefInput {
  gap: Gap;
  probeResult: ProbeResult;
  mirrorProfile: SiteReaderOutput;
  evidenceBank: EvidenceBankOutput;
}

export interface RunFixBriefResult {
  output: FixBriefOutput;
  usedMock: boolean;
  usedRetry: boolean;
}

/* -------------------------------------------------------------------------- */
/*  User-message builder                                                      */
/* -------------------------------------------------------------------------- */

function slimProbeResult(r: ProbeResult): unknown {
  return {
    id: r.id,
    generatedPromptId: r.generatedPromptId,
    prompt: r.prompt,
    platform: r.platform,
    verdict: r.verdict,
    clientMentioned: r.clientMentioned,
    clientPosition: r.clientPosition,
    competitorsMentioned: r.competitorsMentioned,
    sourcesCited: r.sourcesCited,
    answerSummary: r.answerSummary,
    whyClientLost: r.whyClientLost,
  };
}

function slimEvidenceBank(b: EvidenceBankOutput): unknown {
  // Strip audit fields the model never needs; they'd only distract.
  return {
    productDescription: b.productDescription,
    targetAudience: b.targetAudience,
    mainUseCases: b.mainUseCases,
    features: b.features,
    proofItems: b.proofItems,
    competitors: b.competitors,
    allowedClaims: b.allowedClaims,
    forbiddenClaims: b.forbiddenClaims,
    tone: b.tone,
    notes: b.notes,
  };
}

function slimGap(g: Gap): unknown {
  return {
    id: g.id,
    competitorName: g.competitorName,
    type: g.type,
    severity: g.severity,
    explanation: g.explanation,
    affectedPrompts: g.affectedPrompts,
    suggestedFixDirection: g.suggestedFixDirection,
  };
}

function buildUserMessage(input: RunFixBriefInput): string {
  return [
    `<mode>${FIX_BRIEF_MODE}</mode>`,
    "<gap>",
    JSON.stringify(slimGap(input.gap), null, 2),
    "</gap>",
    "<probe_result>",
    JSON.stringify(slimProbeResult(input.probeResult), null, 2),
    "</probe_result>",
    "<mirror_profile>",
    JSON.stringify(input.mirrorProfile, null, 2),
    "</mirror_profile>",
    "<evidence_bank>",
    JSON.stringify(slimEvidenceBank(input.evidenceBank), null, 2),
    "</evidence_bank>",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Agent entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function runFixBriefAgent(
  input: RunFixBriefInput
): Promise<RunFixBriefResult> {
  const userMessage = buildUserMessage(input);
  const mock = buildMockFixBrief(input);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: FIX_AGENT_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.15,
    maxTokens: 3000,
    mockResponse,
  };

  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: FixBriefOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });

  if (!parsed.ok) {
    throw new Error(
      `Fix Brief Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  return {
    output: parsed.data as FixBriefOutput,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deterministic mock (fix_brief mode only)                                  */
/* -------------------------------------------------------------------------- */

function priorityFromSeverity(sev: string): number {
  const s = sev.trim().toLowerCase();
  if (s === "high") return 1;
  if (s === "medium") return 3;
  return 5;
}

function chooseCompetitor(
  gap: Gap,
  probeResult: ProbeResult
): string {
  // 1. Prefer the competitor named on the gap row.
  if (gap.competitorName && gap.competitorName.trim().length > 0) {
    return gap.competitorName.trim();
  }
  // 2. Fallback: the top position competitor in the probe.
  const mentions = Array.isArray(probeResult.competitorsMentioned)
    ? (probeResult.competitorsMentioned as CompetitorMention[])
    : [];
  const sorted = [...mentions].sort(
    (a, b) => (a.position ?? 99) - (b.position ?? 99)
  );
  const first = sorted[0]?.name?.trim();
  if (first) return first;
  return "an alternative recommended by the AI";
}

/**
 * Build an evidence-bank-derived list of currently-usable facts. We prefer
 * concrete proof items over generic allowed claims; we do NOT invent.
 */
function buildEvidenceAvailable(bank: EvidenceBankOutput): string[] {
  const items: string[] = [];
  for (const p of bank.proofItems) {
    items.push(`${p.type}: ${p.detail}`);
    if (items.length >= 4) break;
  }
  if (items.length < 4) {
    for (const c of bank.allowedClaims) {
      if (items.length >= 4) break;
      items.push(c);
    }
  }
  if (items.length < 2 && bank.features.length > 0) {
    for (const f of bank.features) {
      if (items.length >= 4) break;
      const desc = f.description.trim() ? ` — ${f.description.trim()}` : "";
      items.push(`Feature: ${f.name}${desc}`);
    }
  }
  return items.filter((s) => s.trim().length > 0);
}

/**
 * What facts are missing given the fix type. We never claim these exist —
 * we ask for them, per Sprint 7 rule "if proof is missing, add an item to
 * evidenceNeeded".
 */
function buildEvidenceNeeded(
  fixType: FixType,
  competitor: string,
  bank: EvidenceBankOutput,
  mirror: SiteReaderOutput
): string[] {
  const needs: string[] = [];
  const hasStrongProof = bank.proofItems.length >= 2;
  const hasCustomer = bank.proofItems.some(
    (p) => p.type === "customer" || p.type === "case_study"
  );
  const hasReview = bank.proofItems.some((p) => p.type === "review");

  switch (fixType) {
    case "comparison_page":
      needs.push(
        `A neutral, factual comparison against ${competitor} (features, use cases, target audience).`
      );
      if (!hasCustomer) {
        needs.push(
          `At least one named customer or case study for the use case where ${competitor} currently wins.`
        );
      }
      break;
    case "proof_block":
      if (!hasStrongProof) {
        needs.push(
          "Concrete proof we can cite verbatim: customer names, quantitative outcomes, or a public case study URL."
        );
      }
      if (!hasReview) {
        needs.push(
          "Real, linkable review or testimonial (G2, Capterra, or hosted quote with attribution)."
        );
      }
      break;
    case "faq_block":
      needs.push(
        "One-sentence category framing, primary audience, and top 3 use cases stated in plain language."
      );
      break;
    case "comparison_table":
      needs.push(
        `Confirmed feature parity list vs. ${competitor} — only features we actually ship today.`
      );
      break;
    case "schema":
      needs.push(
        "Confirmed values for schema.org SoftwareApplication fields we can prove (name, applicationCategory, offers if applicable)."
      );
      break;
  }

  // If the Mirror Profile flagged a missing signal that clearly relates to
  // this fix, surface it so the user knows the gap already exists in-site.
  for (const m of mirror.missingSignals) {
    if (needs.length >= 5) break;
    const text = `${m.signal} — ${m.whyItMatters}`;
    if (!needs.some((n) => n.toLowerCase().includes(m.signal.toLowerCase()))) {
      needs.push(text);
    }
  }
  return needs.slice(0, 5);
}

function truncateRootCause(s: string): string {
  return s.length <= ROOT_CAUSE_MAX ? s : s.slice(0, ROOT_CAUSE_MAX - 1) + "…";
}

const IMPACT_TEMPLATES: Record<FixType, string> = {
  comparison_page:
    "This fix gives AI systems and human buyers a factual comparison page for the use case, without guaranteeing any specific AI mention or ranking.",
  proof_block:
    "This fix concentrates verifiable proof in one place so AI systems can cite it and buyers can trust it, without promising a change in AI behavior.",
  faq_block:
    "This fix gives AI systems and human buyers a clearer answer to the buyer question, without guaranteeing future mentions.",
  comparison_table:
    "This fix presents feature-level context AI can parse into a comparison, without predicting a specific outcome.",
  schema:
    "This fix makes the page's identity machine-readable so AI can categorize it correctly, without predicting a specific outcome.",
};

const ROOT_CAUSE_TEMPLATES: Record<FixType, string> = {
  comparison_page:
    "There is no comparison page on the client's site that positions them against %COMPETITOR% for this buyer question, so the AI defaults to the incumbent.",
  proof_block:
    "The client's site has thin proof signals for this use case, so the AI relies on %COMPETITOR%'s more concrete customer and review footprint.",
  faq_block:
    "The client's category framing is ambiguous, so the AI struggles to answer this buyer question with the client's name and falls back to %COMPETITOR%.",
  comparison_table:
    "There is no structured feature comparison the AI can lift when the buyer asks how the client stacks up against %COMPETITOR%.",
  schema:
    "The client's site lacks structured (schema.org) signals that would tell an AI parser exactly what category and audience the product serves, so %COMPETITOR% wins the classification.",
};

function buildRecommendedFix(
  fixType: FixType,
  competitor: string,
  gap: Gap
): string {
  const dir = (gap.suggestedFixDirection ?? "").trim();
  const suffix = dir.length > 0 ? ` Direction: ${dir}` : "";
  switch (fixType) {
    case "comparison_page":
      return `Publish a factual "How we compare to ${competitor}" page that names the buyer use case, states the client's category, and lists real, evidence-backed differences.${suffix}`;
    case "proof_block":
      return `Add a proof block near the top of the most-visited relevant page, featuring verifiable customer names, quantitative outcomes, and links to public case studies.${suffix}`;
    case "faq_block":
      return `Add an FAQ block that answers the buyer question in one sentence, states the category plainly, and lists the top three use cases.${suffix}`;
    case "comparison_table":
      return `Add a structured feature-comparison table (client vs. ${competitor}) covering only features the client actually ships today.${suffix}`;
    case "schema":
      return `Publish schema.org SoftwareApplication (or FAQPage) markup on the primary page for this use case, populated only with fields we can prove.${suffix}`;
  }
}

export function buildMockFixBrief(input: RunFixBriefInput): FixBriefOutput {
  const { gap, probeResult, mirrorProfile, evidenceBank } = input;

  const competitor = chooseCompetitor(gap, probeResult);
  const fixType = inferFixType(gap.type, gap.suggestedFixDirection);
  const assets: AssetType[] = defaultAssetsForFixType(fixType);
  const priority = priorityFromSeverity(gap.severity);

  const rootCause = truncateRootCause(
    ROOT_CAUSE_TEMPLATES[fixType].replace("%COMPETITOR%", competitor)
  );
  const recommendedFix = buildRecommendedFix(fixType, competitor, gap);
  const expectedImpact = IMPACT_TEMPLATES[fixType];

  const evidenceAvailable = buildEvidenceAvailable(evidenceBank);
  const evidenceNeeded = buildEvidenceNeeded(
    fixType,
    competitor,
    evidenceBank,
    mirrorProfile
  );

  return {
    lostPrompt: probeResult.prompt,
    competitorRecommended: competitor,
    rootCause,
    recommendedFix,
    fixType,
    assetsToGenerate: assets,
    evidenceNeeded,
    evidenceAvailable,
    priority,
    expectedImpact,
  };
}

/* ========================================================================== */
/*  Sprint 8 — generate_asset mode                                            */
/* ========================================================================== */

/**
 * `runGenerateAssetAgent` is the Sprint 8 entry point. It uses the SAME
 * canonical Fix Agent system prompt as `runFixBriefAgent`, only the
 * `<mode>` tag flips to `generate_asset`. This function does NOT touch
 * `runFixBriefAgent` (Sprint 7) — the two modes are independent by design.
 */

export type GenerateAssetMode = "generate_asset";
export const GENERATE_ASSET_MODE: GenerateAssetMode = "generate_asset";

export interface RunGenerateAssetInput {
  fixBrief: FixBriefRow;
  evidenceBank: EvidenceBankOutput;
  mirrorProfile: SiteReaderOutput;
  assetType: AssetTypeValue;
}

export interface RunGenerateAssetResult {
  output: GeneratedAssetOutput;
  usedMock: boolean;
  usedRetry: boolean;
  /** Sprint 13B.1 — persisted traceability for asset-generation benchmarks. */
  generationProvider: string;
  generationModel: string;
}

function slimFixBriefForAgent(f: FixBriefRow): unknown {
  return {
    id: f.id,
    gapId: f.gapId,
    lostPrompt: f.lostPrompt,
    competitorRecommended: f.competitorRecommended,
    rootCause: f.rootCause,
    recommendedFix: f.recommendedFix,
    fixType: f.fixType,
    assetsToGenerate: f.assetsToGenerate,
    evidenceNeeded: f.evidenceNeeded,
    evidenceAvailable: f.evidenceAvailable,
    priority: f.priority,
    expectedImpact: f.expectedImpact,
  };
}

function buildGenerateAssetUserMessage(input: RunGenerateAssetInput): string {
  return [
    `<mode>${GENERATE_ASSET_MODE}</mode>`,
    "<fix_brief>",
    JSON.stringify(slimFixBriefForAgent(input.fixBrief), null, 2),
    "</fix_brief>",
    "<evidence_bank>",
    JSON.stringify(slimEvidenceBank(input.evidenceBank), null, 2),
    "</evidence_bank>",
    "<mirror_profile>",
    JSON.stringify(input.mirrorProfile, null, 2),
    "</mirror_profile>",
    `<asset_type>${input.assetType}</asset_type>`,
  ].join("\n");
}

export function resolveGenerateAssetModelOverride(): string | undefined {
  const raw = process.env.ASSET_GENERATION_MODEL?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export async function runGenerateAssetAgent(
  input: RunGenerateAssetInput
): Promise<RunGenerateAssetResult> {
  // Sprint 13B.1: JSON-LD is structured data, not prose. Generate it from
  // the Evidence Bank / Mirror Profile with a deterministic template so the
  // model cannot invent ratings, ProductHunt URLs, pricing, versions, etc.
  if (input.assetType === "json_ld_schema") {
    return {
      output: buildJsonLdSchemaMock(input),
      usedMock: false,
      usedRetry: false,
      generationProvider: "deterministic",
      generationModel: "json_ld_template_v1",
    };
  }

  const userMessage = buildGenerateAssetUserMessage(input);
  const mock = buildMockGeneratedAsset(input);
  const mockResponse = JSON.stringify(mock);

  const assetGenerationModel = resolveGenerateAssetModelOverride();
  const call = {
    system: FIX_AGENT_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.12,
    maxTokens: 4000,
    mockResponse,
    model: assetGenerationModel,
  };

  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: GeneratedAssetOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
    preNormalize: (raw) =>
      preNormalizeGeneratedAssetContent(raw, input.assetType),
  });

  if (!parsed.ok) {
    throw new Error(
      `Generate-Asset Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  return {
    output: parsed.data,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
    generationProvider: initial.provider,
    generationModel: initial.model,
  };
}

/**
 * Pre-Zod normalizer for generate_asset output.
 *
 * Three model-output reconciliations, all defensive:
 *
 *   1. `assetType` pinning. The caller asks for exactly one asset type
 *      at a time (`input.assetType`). We pass that as `expectedAssetType`
 *      here and pin the field so a model that ignores the request (e.g.
 *      returns `comparison_page_outline` for every call) still lands
 *      under the correct row in `generated_assets`. `assetType` is a
 *      request-side invariant, not something the model should override.
 *
 *   2. `json_ld_schema` content shape. The schema requires
 *      `content` to be a JSON *string* (superRefine then parses it).
 *      OpenAI regularly emits `content` as an actual JSON-LD object
 *      instead — semantically correct, wrong wire shape. Serialize it
 *      so every consumer that reads `content` as a string still works.
 *
 *   3. Placeholder round-trip. The schema requires that every entry in
 *      `placeholders` also appears literally in `content` (and vice
 *      versa). LLMs frequently list "wished-for" evidence items in
 *      `placeholders` without inserting the corresponding
 *      `[EVIDENCE NEEDED: …]` marker into content. The safest
 *      reconciliation is to make `placeholders` reflect exactly what's
 *      literally present in `content`, using the same canonical
 *      extractor Zod itself uses.
 *
 * Defensive throughout: if the parsed value isn't the expected shape,
 * return it unchanged and let Zod produce the real error. This does not
 * weaken any schema — Zod still validates every field afterwards.
 */
export function preNormalizeGeneratedAssetContent(
  raw: unknown,
  expectedAssetType?: AssetTypeValue
): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  let normalized: Record<string, unknown> = obj;

  if (expectedAssetType) {
    normalized = { ...normalized, assetType: expectedAssetType };
  }

  const effectiveAssetType =
    (normalized.assetType as string | undefined) ??
    (obj.assetType as string | undefined);

  if (
    effectiveAssetType === "json_ld_schema" &&
    normalized.content &&
    typeof normalized.content !== "string" &&
    typeof normalized.content === "object"
  ) {
    try {
      normalized = {
        ...normalized,
        content: JSON.stringify(normalized.content),
      };
    } catch {
      // keep as-is; Zod will produce the real error
    }
  }

  if (
    typeof normalized.content === "string" &&
    Array.isArray(normalized.placeholders)
  ) {
    const found = extractEvidencePlaceholders(normalized.content);
    normalized = { ...normalized, placeholders: found };
  }

  return normalized;
}

/* --------------------------------------------------------------------------
 *  Deterministic mock builders
 * -------------------------------------------------------------------------- */

/** Canonical placeholders used across mock content. Kept short so the mock
 *  stays deterministic and the placeholders array matches character-for-
 *  character. */
const PLACEHOLDER_PROOF =
  "[EVIDENCE NEEDED: proof item, customer quote, metric, or source]";
const PLACEHOLDER_DIFFERENTIATION = (competitor: string) =>
  `[EVIDENCE NEEDED: neutral, verifiable differentiation vs ${competitor}]`;
const PLACEHOLDER_PRICING =
  "[EVIDENCE NEEDED: pricing or packaging evidence]";
const PLACEHOLDER_FAQ_ANSWER =
  "[EVIDENCE NEEDED: canonical short answer for the buyer question]";
const PLACEHOLDER_COMPETITOR_FACT = (competitor: string) =>
  `[EVIDENCE NEEDED: neutral, verifiable statement about ${competitor}]`;

function clientNameFromMirror(mirror: SiteReaderOutput): string {
  const raw = mirror.companyName?.trim();
  if (raw && raw.length > 0) return raw;
  return "the client";
}

function pushClaim(
  arr: ClaimUsed[],
  claim: string,
  source: "evidence_bank" | "mirror_profile"
) {
  const trimmed = claim.trim();
  if (trimmed.length === 0) return;
  if (arr.some((c) => c.claim === trimmed && c.source === source)) return;
  arr.push({ claim: trimmed, source });
}

function firstProofDetail(bank: EvidenceBankOutput): string | null {
  const p = bank.proofItems[0];
  if (!p) return null;
  return `${p.type}: ${p.detail}`;
}

/** Public for testing — do not import from route/UI code. */
export function buildMockGeneratedAsset(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  switch (input.assetType) {
    case "comparison_page_outline":
      return buildComparisonPageOutlineMock(input);
    case "faq_block":
      return buildFaqBlockMock(input);
    case "proof_block":
      return buildProofBlockMock(input);
    case "comparison_table":
      return buildComparisonTableMock(input);
    case "json_ld_schema":
      return buildJsonLdSchemaMock(input);
  }
}

function buildComparisonPageOutlineMock(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  const { fixBrief, evidenceBank, mirrorProfile } = input;
  const client = clientNameFromMirror(mirrorProfile);
  const competitor = fixBrief.competitorRecommended;
  const audience =
    mirrorProfile.targetAudience.length > 0
      ? mirrorProfile.targetAudience.slice(0, 4)
      : evidenceBank.targetAudience.slice(0, 4);
  const useCases =
    mirrorProfile.useCases.length > 0
      ? mirrorProfile.useCases.slice(0, 4)
      : evidenceBank.mainUseCases.slice(0, 4);
  const mirrorFeatureNames = mirrorProfile.features
    .slice(0, 4)
    .map((f) => f.trim())
    .filter((s) => s.length > 0);
  const bankFeatureNames = evidenceBank.features
    .slice(0, 4)
    .map((f) => f.name.trim())
    .filter((s) => s.length > 0);
  const differentiators =
    mirrorFeatureNames.length > 0 ? mirrorFeatureNames : bankFeatureNames;
  const differentiatorSource: "mirror_profile" | "evidence_bank" =
    mirrorFeatureNames.length > 0 ? "mirror_profile" : "evidence_bank";
  const hasProof = evidenceBank.proofItems.length > 0;

  const placeholders: string[] = [];
  const claims: ClaimUsed[] = [];

  const title = `How ${client} compares to ${competitor}`;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `This page answers the buyer question "${fixBrief.lostPrompt}" and explains, factually, when ${client} is a better fit than ${competitor}.`
  );

  lines.push("");
  lines.push("## Who this is for");
  if (audience.length === 0) {
    lines.push(`- [EVIDENCE NEEDED: primary buyer persona for ${client}]`);
    placeholders.push(`[EVIDENCE NEEDED: primary buyer persona for ${client}]`);
  } else {
    for (const a of audience) {
      lines.push(`- ${a}`);
      pushClaim(claims, `Audience: ${a}`, "mirror_profile");
    }
  }

  lines.push("");
  lines.push(`## When to consider ${client}`);
  if (useCases.length === 0) {
    lines.push(`- [EVIDENCE NEEDED: primary use cases for ${client}]`);
    placeholders.push(`[EVIDENCE NEEDED: primary use cases for ${client}]`);
  } else {
    for (const u of useCases) {
      lines.push(`- ${u}`);
      pushClaim(claims, `Use case: ${u}`, "mirror_profile");
    }
  }

  lines.push("");
  lines.push(`## How ${client} compares to ${competitor}`);
  const category = mirrorProfile.detectedCategory?.trim();
  if (category) {
    lines.push(`- Category: ${category}`);
    pushClaim(claims, `Category: ${category}`, "mirror_profile");
  }
  if (differentiators.length > 0) {
    lines.push(`- ${client} differentiators: ${differentiators.join(", ")}`);
    pushClaim(
      claims,
      `Differentiators: ${differentiators.join(", ")}`,
      differentiatorSource
    );
  }
  const diffPlaceholder = PLACEHOLDER_DIFFERENTIATION(competitor);
  lines.push(`- ${diffPlaceholder}`);
  placeholders.push(diffPlaceholder);

  lines.push("");
  lines.push("## Proof");
  if (hasProof) {
    for (const p of evidenceBank.proofItems.slice(0, 4)) {
      lines.push(`- ${p.type}: ${p.detail}`);
      pushClaim(claims, `${p.type}: ${p.detail}`, "evidence_bank");
    }
  }
  if (!hasProof || evidenceBank.proofItems.length < 2) {
    lines.push(`- ${PLACEHOLDER_PROOF}`);
    placeholders.push(PLACEHOLDER_PROOF);
  }

  lines.push("");
  lines.push("## Frequently asked questions");
  lines.push(`- Q: ${fixBrief.lostPrompt}`);
  lines.push(`  A: ${PLACEHOLDER_FAQ_ANSWER}`);
  placeholders.push(PLACEHOLDER_FAQ_ANSWER);

  return {
    assetType: "comparison_page_outline",
    title,
    content: lines.join("\n"),
    placeholders,
    claimsUsed: claims,
  };
}

function buildFaqBlockMock(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  const { fixBrief, evidenceBank, mirrorProfile } = input;
  const client = clientNameFromMirror(mirrorProfile);
  const competitor = fixBrief.competitorRecommended;
  const description =
    evidenceBank.productDescription.trim().length > 0
      ? evidenceBank.productDescription.trim()
      : mirrorProfile.detectedCategory
        ? `${client} is ${mirrorProfile.detectedCategory}.`
        : `${client} — [EVIDENCE NEEDED: one-sentence product description]`;
  const hasEvidenceDescription =
    evidenceBank.productDescription.trim().length > 0 ||
    Boolean(mirrorProfile.detectedCategory);

  const audience =
    mirrorProfile.targetAudience[0] ?? evidenceBank.targetAudience[0] ?? null;
  const useCase =
    mirrorProfile.useCases[0] ?? evidenceBank.mainUseCases[0] ?? null;
  const proof = firstProofDetail(evidenceBank);

  const placeholders: string[] = [];
  const claims: ClaimUsed[] = [];

  const title = `${client} — FAQ block`;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");

  lines.push(`### What does ${client} do?`);
  if (hasEvidenceDescription) {
    lines.push(description);
    pushClaim(
      claims,
      description,
      evidenceBank.productDescription.trim().length > 0
        ? "evidence_bank"
        : "mirror_profile"
    );
  } else {
    lines.push(`[EVIDENCE NEEDED: one-sentence product description]`);
    placeholders.push(`[EVIDENCE NEEDED: one-sentence product description]`);
  }
  lines.push("");

  lines.push(`### Who is ${client} for?`);
  if (audience) {
    lines.push(`- ${audience}`);
    pushClaim(claims, `Audience: ${audience}`, "mirror_profile");
  } else {
    lines.push(`- [EVIDENCE NEEDED: primary buyer persona for ${client}]`);
    placeholders.push(`[EVIDENCE NEEDED: primary buyer persona for ${client}]`);
  }
  lines.push("");

  lines.push(`### What use case does ${client} support?`);
  if (useCase) {
    lines.push(`- ${useCase}`);
    pushClaim(claims, `Use case: ${useCase}`, "mirror_profile");
  } else {
    lines.push(`- [EVIDENCE NEEDED: primary use case for ${client}]`);
    placeholders.push(`[EVIDENCE NEEDED: primary use case for ${client}]`);
  }
  lines.push("");

  lines.push(`### How is ${client} different from ${competitor}?`);
  const diffPlaceholder = PLACEHOLDER_DIFFERENTIATION(competitor);
  lines.push(diffPlaceholder);
  placeholders.push(diffPlaceholder);
  lines.push("");

  lines.push("### What proof is available?");
  if (proof) {
    lines.push(`- ${proof}`);
    pushClaim(claims, proof, "evidence_bank");
  } else {
    lines.push(`- ${PLACEHOLDER_PROOF}`);
    placeholders.push(PLACEHOLDER_PROOF);
  }

  return {
    assetType: "faq_block",
    title,
    content: lines.join("\n"),
    placeholders,
    claimsUsed: claims,
  };
}

function buildProofBlockMock(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  const { fixBrief, evidenceBank, mirrorProfile } = input;
  const client = clientNameFromMirror(mirrorProfile);

  const placeholders: string[] = [];
  const claims: ClaimUsed[] = [];

  const title = `${client} — Proof block`;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `Verifiable proof for the buyer question "${fixBrief.lostPrompt}", drawn only from the Evidence Bank.`
  );
  lines.push("");

  lines.push("## What we can prove today");
  if (evidenceBank.proofItems.length === 0) {
    lines.push(`- ${PLACEHOLDER_PROOF}`);
    placeholders.push(PLACEHOLDER_PROOF);
  } else {
    for (const p of evidenceBank.proofItems.slice(0, 6)) {
      const url = p.sourceUrl ? ` (${p.sourceUrl})` : "";
      lines.push(`- **${p.type}**: ${p.detail}${url}`);
      pushClaim(claims, `${p.type}: ${p.detail}`, "evidence_bank");
    }
  }
  lines.push("");

  lines.push("## Proof still to gather");
  if (evidenceBank.proofItems.length < 3) {
    lines.push(`- ${PLACEHOLDER_PROOF}`);
    if (!placeholders.includes(PLACEHOLDER_PROOF)) {
      placeholders.push(PLACEHOLDER_PROOF);
    }
  } else {
    lines.push(
      "- Confirmed public case study URL for the featured customer above."
    );
    lines.push(
      "- Confirmed third-party review link (G2, Capterra, or TrustRadius)."
    );
  }

  return {
    assetType: "proof_block",
    title,
    content: lines.join("\n"),
    placeholders,
    claimsUsed: claims,
  };
}

function buildComparisonTableMock(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  const { fixBrief, evidenceBank, mirrorProfile } = input;
  const client = clientNameFromMirror(mirrorProfile);
  const competitor = fixBrief.competitorRecommended;

  const placeholders: string[] = [];
  const claims: ClaimUsed[] = [];

  const useCase =
    mirrorProfile.useCases[0] ??
    evidenceBank.mainUseCases[0] ??
    null;
  const audience =
    mirrorProfile.targetAudience[0] ??
    evidenceBank.targetAudience[0] ??
    null;
  const proofSummary = firstProofDetail(evidenceBank);

  const clientUseCase = useCase
    ? useCase
    : (() => {
        const ph = `[EVIDENCE NEEDED: primary use case for ${client}]`;
        placeholders.push(ph);
        return ph;
      })();
  if (useCase) pushClaim(claims, `Use case: ${useCase}`, "mirror_profile");
  const competitorUseCase = PLACEHOLDER_COMPETITOR_FACT(competitor);
  if (!placeholders.includes(competitorUseCase)) {
    placeholders.push(competitorUseCase);
  }

  const clientAudience = audience
    ? audience
    : (() => {
        const ph = `[EVIDENCE NEEDED: primary buyer persona for ${client}]`;
        placeholders.push(ph);
        return ph;
      })();
  if (audience) pushClaim(claims, `Audience: ${audience}`, "mirror_profile");

  const clientProof = proofSummary
    ? proofSummary
    : (() => {
        if (!placeholders.includes(PLACEHOLDER_PROOF)) {
          placeholders.push(PLACEHOLDER_PROOF);
        }
        return PLACEHOLDER_PROOF;
      })();
  if (proofSummary) pushClaim(claims, proofSummary, "evidence_bank");

  if (!placeholders.includes(PLACEHOLDER_PRICING)) {
    placeholders.push(PLACEHOLDER_PRICING);
  }

  const title = `${client} vs ${competitor} — comparison table`;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `A structured comparison for the buyer question "${fixBrief.lostPrompt}". Only claims we can back up appear here.`
  );
  lines.push("");
  lines.push(`| Dimension | ${client} | ${competitor} |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| Use case | ${clientUseCase} | ${competitorUseCase} |`);
  lines.push(`| Audience | ${clientAudience} | ${competitorUseCase} |`);
  lines.push(`| Proof available | ${clientProof} | ${competitorUseCase} |`);
  lines.push(`| Pricing | ${PLACEHOLDER_PRICING} | ${PLACEHOLDER_PRICING} |`);

  return {
    assetType: "comparison_table",
    title,
    content: lines.join("\n"),
    placeholders,
    claimsUsed: claims,
  };
}

function buildJsonLdSchemaMock(
  input: RunGenerateAssetInput
): GeneratedAssetOutput {
  const { fixBrief, evidenceBank, mirrorProfile } = input;
  const client = clientNameFromMirror(mirrorProfile);

  const placeholders: string[] = [];
  const claims: ClaimUsed[] = [];

  const isFaqLike = fixBrief.fixType === "faq_block";
  let title: string;
  let contentObject: Record<string, unknown>;

  if (isFaqLike) {
    // FAQPage — one Q&A per lost prompt.
    const question = fixBrief.lostPrompt;
    const answerText = PLACEHOLDER_FAQ_ANSWER;
    placeholders.push(PLACEHOLDER_FAQ_ANSWER);

    title = `${client} — FAQPage JSON-LD`;
    contentObject = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answerText,
          },
        },
      ],
    };
  } else {
    title = `${client} — SoftwareApplication JSON-LD`;
    const base: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: client,
    };
    if (mirrorProfile.detectedCategory && mirrorProfile.detectedCategory.trim().length > 0) {
      base.applicationCategory = mirrorProfile.detectedCategory;
      pushClaim(
        claims,
        `Category: ${mirrorProfile.detectedCategory}`,
        "mirror_profile"
      );
    }
    if (evidenceBank.productDescription.trim().length > 0) {
      base.description = evidenceBank.productDescription.trim();
      pushClaim(
        claims,
        `Description: ${evidenceBank.productDescription.trim()}`,
        "evidence_bank"
      );
    }
    if (mirrorProfile.website && mirrorProfile.website.trim().length > 0) {
      base.url = mirrorProfile.website;
      pushClaim(claims, `URL: ${mirrorProfile.website}`, "mirror_profile");
    }
    if (evidenceBank.targetAudience.length > 0) {
      base.audience = {
        "@type": "Audience",
        audienceType: evidenceBank.targetAudience[0],
      };
      pushClaim(
        claims,
        `Audience: ${evidenceBank.targetAudience[0]}`,
        "evidence_bank"
      );
    }
    contentObject = base;
  }

  const content = JSON.stringify(contentObject, null, 2);
  return {
    assetType: "json_ld_schema",
    title,
    content,
    placeholders,
    claimsUsed: claims,
  };
}
