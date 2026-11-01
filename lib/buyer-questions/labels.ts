/**
 * The single source of customer-facing evidence labels (design section 4).
 *
 * "Observed — customer-provided" is never presented as independently
 * verified, and no label says a question is one "buyers ask".
 */

import type { EvidenceGrade, Origin, Verification, WordingClassification } from "./types";

export const OBSERVED_LABELS: Readonly<Record<Verification, string>> = {
  public_verifiable: "Observed — verified source",
  customer_provided: "Observed — customer-provided",
};

export const ADAPTED_LABEL = "Adapted from buyer language";
export const HYPOTHESIS_LABEL = "Our hypothesis: not found in buyer sources";
export const PENDING_REVIEW_LABEL = "Evidence review pending";

export const ORIGIN_LABELS: Readonly<Record<Origin, string>> = {
  recommended_unchanged: "Recommended",
  recommended_edited: "Edited by you",
  replaced_with_candidate: "Chosen by you from the candidates",
  customer_written: "Written by you",
};

export function gradeLabel(grade: EvidenceGrade, verification: Verification | null): string {
  if (grade === "observed") {
    if (verification === null) throw new Error("observed wording needs a verification status");
    return OBSERVED_LABELS[verification];
  }
  return grade === "adapted" ? ADAPTED_LABEL : HYPOTHESIS_LABEL;
}

export function classificationLabel(classification: WordingClassification, verification: Verification | null): string {
  return classification === "pending_review" ? PENDING_REVIEW_LABEL : gradeLabel(classification, verification);
}

/** For example "Edited by you · Adapted from buyer language". */
export function approvedQuestionLabel(
  origin: Origin,
  classification: WordingClassification,
  verification: Verification | null
): string {
  return `${ORIGIN_LABELS[origin]} · ${classificationLabel(classification, verification)}`;
}

/** Phrases no customer-facing label may contain (case-insensitive). */
export const FORBIDDEN_LABEL_PHRASES: readonly string[] = [
  "buyers ask",
  "real buyer question",
  "probability",
  "win rate",
  "likelihood",
];

/** Additionally forbidden in any label for customer-provided material. */
export const FORBIDDEN_CUSTOMER_PROVIDED_PHRASES: readonly string[] = ["verified"];

/** Every label this module can produce, with whether it can describe customer-provided material. */
export function allLabels(): Array<{ label: string; customerProvided: boolean }> {
  const origins = Object.keys(ORIGIN_LABELS) as Origin[];
  const wordings: Array<[WordingClassification, Verification | null]> = [
    ["observed", "public_verifiable"],
    ["observed", "customer_provided"],
    ["adapted", "public_verifiable"],
    ["adapted", "customer_provided"],
    ["hypothesis", null],
    ["pending_review", null],
  ];
  const labels: Array<{ label: string; customerProvided: boolean }> = [];
  for (const [classification, verification] of wordings) {
    const customerProvided = verification === "customer_provided";
    labels.push({ label: classificationLabel(classification, verification), customerProvided });
    for (const origin of origins) {
      labels.push({ label: approvedQuestionLabel(origin, classification, verification), customerProvided });
    }
  }
  for (const label of Object.values(ORIGIN_LABELS)) labels.push({ label, customerProvided: false });
  return labels;
}
