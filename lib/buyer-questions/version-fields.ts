/**
 * Mapping curator ratings to the existing `buyer_question_versions`
 * fields (design section 6; a provisional heuristic, v1).
 *
 *   commercial_value = 1 + commercial intent, plus 1 if ICP fit is 3 (1-5)
 *   winnability      = 1 + product relevance, plus 1 if observed      (1-5)
 *   priority         = commercial_value x winnability, capped at 25  (1-25)
 *
 * These numbers only let versions sort consistently. They are not measures
 * of anything, and the rationale never presents them as such. Every result
 * passes the existing 0048 validator.
 */

import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";
import type { EvidenceGrade, RelevanceRatings } from "./types";

export const VERSION_MAPPING_VERSION = "v1";
export const AWAITING_REVIEW_RATIONALE = "awaiting review";

export interface VersionFields {
  commercialValue: number;
  winnability: number;
  priority: number;
  rationale: string;
}

function ratingValue(ratings: RelevanceRatings, key: keyof RelevanceRatings): number {
  const value = ratings[key]?.value;
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error(`invalid_rating: ${key} must be an integer 0..3`);
  }
  return value;
}

function reasonOf(ratings: RelevanceRatings, key: keyof RelevanceRatings): string {
  const reason = ratings[key]?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(`invalid_rating: ${key} needs a reason`);
  }
  return reason.trim();
}

export function mapVersionFields(ratings: RelevanceRatings, wordingGrade: EvidenceGrade): VersionFields {
  const buyerRelevance = ratingValue(ratings, "buyerRelevance");
  const icpFit = ratingValue(ratings, "icpFit");
  const commercialIntent = ratingValue(ratings, "commercialIntent");
  const productRelevance = ratingValue(ratings, "productRelevance");
  const observed = wordingGrade === "observed";

  const commercialValue = 1 + commercialIntent + (icpFit === 3 ? 1 : 0);
  const winnability = 1 + productRelevance + (observed ? 1 : 0);
  const priority = Math.min(25, commercialValue * winnability);

  const rationale = [
    `Sort order from curator ratings (heuristic ${VERSION_MAPPING_VERSION}).`,
    `Buyer relevance ${buyerRelevance}: ${reasonOf(ratings, "buyerRelevance")}.`,
    `ICP fit ${icpFit}: ${reasonOf(ratings, "icpFit")}.`,
    `Commercial intent ${commercialIntent}: ${reasonOf(ratings, "commercialIntent")}.`,
    `Product relevance ${productRelevance}: ${reasonOf(ratings, "productRelevance")}.`,
    `Wording ${observed ? "observed" : "not observed"}.`,
  ].join(" ");

  const fields = { commercialValue, winnability, priority, rationale };
  validateBuyerQuestionVersionNumericFields(fields);
  return fields;
}

/** A customer-written question before the founder's review: the lowest valid values. */
export function customerWrittenVersionFields(): VersionFields {
  const fields = { commercialValue: 1, winnability: 1, priority: 1, rationale: AWAITING_REVIEW_RATIONALE };
  validateBuyerQuestionVersionNumericFields(fields);
  return fields;
}
