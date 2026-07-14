import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import {
  DEFAULT_FORBIDDEN_CLAIMS,
  PRODUCT_DESCRIPTION_MAX,
  type EvidenceBankInput,
  type FeatureItem,
  type ProofItem,
  type ProofType,
} from "@/lib/schemas/evidence-bank.schema";

/**
 * Build a draft `EvidenceBankInput` from a Mirror Profile.
 *
 * Guardrails:
 *  - We never invent proof. If the Mirror Profile has no proof signals, the
 *    proof list stays empty.
 *  - `allowedClaims` only includes claims the Mirror Profile marked
 *    `hasProof === true`, plus safe factual restatements from features and
 *    use cases (which are objective, not marketing puffery).
 *  - `forbiddenClaims` is seeded with the shared default list and can only
 *    be extended, never shrunk (Zod enforces min 3).
 *  - The user MUST edit and confirm before this is trustworthy — the return
 *    value is a draft, not a finished bank.
 */

/**
 * Map from Mirror Profile ProofSignal.type → Evidence Bank ProofItem.type.
 * The Mirror set is a subset of the Evidence Bank set; the mapping is 1:1
 * except that unknown / new Mirror types fall through to "other".
 */
const MIRROR_TO_EB_PROOF_TYPE: Record<string, ProofType> = {
  customer: "customer",
  case_study: "case_study",
  review: "review",
  award: "award",
  integration: "integration",
  press: "press",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (s.length === 0) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function buildProductDescription(profile: SiteReaderOutput): string {
  const label = profile.companyName?.trim();
  const category = profile.detectedCategory?.trim();
  const notes = profile.aiReadabilityNotes?.trim();
  const parts: string[] = [];
  if (label && category) parts.push(`${label} — ${category}.`);
  else if (label) parts.push(`${label}.`);
  else if (category) parts.push(`${category}.`);
  if (notes) parts.push(notes);
  const combined = parts.join(" ").trim();
  return truncate(combined, PRODUCT_DESCRIPTION_MAX);
}

function buildFeatures(profile: SiteReaderOutput): FeatureItem[] {
  return dedupe(profile.features ?? []).map((name) => ({
    name,
    description: "",
  }));
}

function buildProofItems(profile: SiteReaderOutput): ProofItem[] {
  const items: ProofItem[] = [];
  for (const p of profile.proofSignals ?? []) {
    const detail = p.detail?.trim();
    if (!detail) continue;
    const type = MIRROR_TO_EB_PROOF_TYPE[p.type] ?? "other";
    const item: ProofItem = { type, detail };
    if (p.sourceUrl && isProbablyUrl(p.sourceUrl)) {
      item.sourceUrl = p.sourceUrl.trim();
    }
    items.push(item);
  }
  return items;
}

function isProbablyUrl(raw: string): boolean {
  try {
    // Reject empty or fragment-only strings; require an absolute URL.
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function buildAllowedClaims(profile: SiteReaderOutput): string[] {
  const provenClaims = (profile.claims ?? [])
    .filter((c) => c.hasProof && c.claim?.trim())
    .map((c) => c.claim.trim());

  const safeUseCases = (profile.useCases ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .map((u) => `Supports: ${u}`);

  const safeFeatures = (profile.features ?? [])
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((f) => `Feature: ${f}`);

  return dedupe([...provenClaims, ...safeUseCases, ...safeFeatures]);
}

export function buildEvidenceBankPrefill(
  profile: SiteReaderOutput
): EvidenceBankInput {
  return {
    productDescription: buildProductDescription(profile),
    targetAudience: dedupe(profile.targetAudience ?? []),
    mainUseCases: dedupe(profile.useCases ?? []),
    features: buildFeatures(profile),
    proofItems: buildProofItems(profile),
    competitors: dedupe(profile.competitorsMentioned ?? []),
    allowedClaims: buildAllowedClaims(profile),
    forbiddenClaims: [...DEFAULT_FORBIDDEN_CLAIMS],
    tone: "plain",
    notes: "",
    // Sprint 12 — every auto-filled bank starts here. It is promoted to
    // `user_edited` the first time a user POSTs to
    // `/api/projects/evidence-bank`.
    provenance: "auto_filled_from_mirror_profile",
  };
}
