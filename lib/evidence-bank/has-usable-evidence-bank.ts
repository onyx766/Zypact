import type { EvidenceBankOutput } from "@/lib/schemas/evidence-bank.schema";

/**
 * Sprint 6 helper — will be consumed by the future Fix Agent (Sprint 7+).
 *
 * Returns `true` iff the Evidence Bank has enough content to safely feed a
 * downstream generator:
 *   - `productDescription` is non-empty OR `features` has at least 1 item; AND
 *   - `forbiddenClaims` has at least 3 items (the safety floor).
 *
 * The Fix Agent should refuse to run when this returns false — no bank, no fix.
 */
export function hasUsableEvidenceBank(
  bank: EvidenceBankOutput | null | undefined
): boolean {
  if (!bank) return false;
  const hasDescription = bank.productDescription.trim().length > 0;
  const hasFeature = bank.features.length >= 1;
  const hasForbiddenFloor = bank.forbiddenClaims.length >= 3;
  return (hasDescription || hasFeature) && hasForbiddenFloor;
}
