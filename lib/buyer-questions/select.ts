/**
 * Deterministic recommendation over one research set (design section 6):
 * validation, exact-duplicate merge, eligibility, ranking, near-duplicate
 * groups and composition, with an explanation for every candidate.
 *
 * Pure: the inputs are never mutated, nothing is created or stored, and
 * the output is identical for every ordering of the input arrays.
 */

import { findDuplicates } from "./duplicates";
import { validateResearchSet, type CandidateValidation } from "./validate-candidate";
import {
  MAX_QUESTIONS_PER_APPROVAL_SET,
  type BuyerStage,
  type Candidate,
  type CandidateSourceLink,
  type EvidenceGrade,
  type QuestionKind,
  type Refusal,
  type ResearchSet,
  type Signal,
  type Verification,
} from "./types";

export type DecisionRule =
  | "set_refused"
  | "refused"
  | "merged_duplicate"
  | "hypothesis_never_preselected"
  | "rating_below_threshold"
  | "marketing_flag_unresolved"
  | "brand_alias_unresolved"
  | "near_duplicate"
  | "stage_diversity"
  | "composition_limit"
  | "preselected_unbranded_first"
  | "preselected_unbranded_second_different_stage"
  | "preselected_unbranded_second_same_stage"
  | "preselected_branded";

export interface RatingExplanation {
  value: number;
  reason: string;
}

export interface CandidateExplanation {
  candidateId: string;
  grade: EvidenceGrade;
  verification: Verification | null;
  kind: QuestionKind;
  buyerStage: BuyerStage;
  ratings: {
    buyerRelevance: RatingExplanation;
    icpFit: RatingExplanation;
    commercialIntent: RatingExplanation;
    productRelevance: RatingExplanation;
  };
  relevanceSum: number;
  refusals: Refusal[];
  signals: Signal[];
  eligible: boolean;
  preselected: boolean;
  /** The rule that preselected or excluded the candidate. */
  rule: DecisionRule;
  /** Every rule that blocks eligibility, in a fixed order. */
  blockers: DecisionRule[];
  detail: string;
  /** For a merged duplicate: the candidate it was merged into. */
  mergedInto: string | null;
  /** For a merge representative: the other ids merged into it. */
  mergedFrom: string[];
  /** Every source link, including those of merged duplicates. */
  links: CandidateSourceLink[];
  nearDuplicates: string[];
}

export interface SlotResult {
  candidateId: string | null;
  explanation: string;
}

export interface Recommendation {
  setRefusals: Refusal[];
  /** Preselected ids: first unbranded, second unbranded, branded. */
  preselected: string[];
  slots: { unbranded: [SlotResult, SlotResult]; branded: SlotResult };
  /** One entry per input candidate, in ranking order. */
  candidates: CandidateExplanation[];
  summary: string[];
}

const GRADE_ORDER: Record<string, number> = { observed: 0, adapted: 1, hypothesis: 2 };

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ratingValue(c: Candidate, key: keyof Candidate["ratings"]): number {
  const v = c.ratings?.[key]?.value;
  return Number.isInteger(v) ? (v as number) : -1;
}

export function relevanceSum(c: Candidate): number {
  const keys = ["buyerRelevance", "icpFit", "commercialIntent", "productRelevance"] as const;
  const values = keys.map((k) => ratingValue(c, k));
  return values.some((v) => v < 0) ? -1 : values.reduce((a, b) => a + b, 0);
}

/** Relevance sum, then observed before adapted, then curator rank, then id. */
export function compareRank(a: Candidate, b: Candidate): number {
  return (
    relevanceSum(b) - relevanceSum(a) ||
    (GRADE_ORDER[a.grade] ?? 3) - (GRADE_ORDER[b.grade] ?? 3) ||
    (Number.isInteger(a.curatorRank) ? a.curatorRank : Number.MAX_SAFE_INTEGER) -
      (Number.isInteger(b.curatorRank) ? b.curatorRank : Number.MAX_SAFE_INTEGER) ||
    cmpStr(a.id, b.id)
  );
}

function sortFindings<T extends { code: string; detail?: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => cmpStr(a.code, b.code) || cmpStr(a.detail ?? "", b.detail ?? ""));
}

function sortLinks(links: readonly CandidateSourceLink[]): CandidateSourceLink[] {
  return [...links].sort(
    (a, b) =>
      cmpStr(a.candidateId, b.candidateId) ||
      cmpStr(a.sourceId, b.sourceId) ||
      cmpStr(a.relation, b.relation) ||
      cmpStr(a.quotedSpan ?? "", b.quotedSpan ?? "")
  );
}

function eligibilityBlockers(c: Candidate, v: CandidateValidation): DecisionRule[] {
  const blockers: DecisionRule[] = [];
  if (c.grade !== "observed" && c.grade !== "adapted") blockers.push("hypothesis_never_preselected");
  if (
    ratingValue(c, "buyerRelevance") < 2 ||
    ratingValue(c, "icpFit") < 2 ||
    ratingValue(c, "productRelevance") < 2 ||
    ratingValue(c, "commercialIntent") < 1
  ) {
    blockers.push("rating_below_threshold");
  }
  if (v.marketing.flagged && !v.marketing.resolved) blockers.push("marketing_flag_unresolved");
  if (v.brandStatus === "unresolved") blockers.push("brand_alias_unresolved");
  return blockers;
}

const BLOCKER_DETAIL: Partial<Record<DecisionRule, string>> = {
  hypothesis_never_preselected: "Hypothesis: no supporting buyer-authored source, so never preselected.",
  rating_below_threshold:
    "Below the eligibility thresholds (buyer relevance, ICP fit and product relevance at least 2; commercial intent at least 1).",
  marketing_flag_unresolved:
    "Marketing-language flag not yet resolved with a recorded reason and a linked buyer-authored source.",
  brand_alias_unresolved: "Brand presence depends on a stripped alias the curator has not resolved.",
};

export function recommend(set: ResearchSet): Recommendation {
  const validation = validateResearchSet(set);
  const candidates = [...set.candidates].sort(compareRank);
  const setRefused = validation.refusals.length > 0;

  const valid = setRefused
    ? []
    : candidates.filter((c) => (validation.candidates.get(c.id)?.refusals.length ?? 1) === 0);
  const blockersOf = new Map(
    valid.map((c) => [c.id, eligibilityBlockers(c, validation.candidates.get(c.id) as CandidateValidation)])
  );

  // Exact duplicates merge into one representative: eligible first, then rank.
  const exact = findDuplicates(valid, set.siteContext);
  const mergedInto = new Map<string, string>();
  const mergedFrom = new Map<string, string[]>();
  for (const group of exact.exactGroups) {
    const members = valid
      .filter((c) => group.includes(c.id))
      .sort((a, b) => Number(blockersOf.get(a.id)!.length > 0) - Number(blockersOf.get(b.id)!.length > 0) || compareRank(a, b));
    const representative = members[0].id;
    mergedFrom.set(representative, members.slice(1).map((m) => m.id));
    for (const m of members.slice(1)) mergedInto.set(m.id, representative);
  }
  const representatives = valid.filter((c) => !mergedInto.has(c.id));
  const near = findDuplicates(representatives, set.siteContext);

  const eligible = representatives.filter((c) => blockersOf.get(c.id)!.length === 0);
  const decision = new Map<string, { rule: DecisionRule; detail: string }>();
  const takenGroups = new Set<number>();
  const take = (c: Candidate, rule: DecisionRule, detail: string): void => {
    decision.set(c.id, { rule, detail });
    const group = near.nearGroupOf.get(c.id);
    if (group !== undefined) takenGroups.add(group);
  };
  const freeOfTakenGroup = (c: Candidate): boolean => {
    const group = near.nearGroupOf.get(c.id);
    return group === undefined || !takenGroups.has(group);
  };

  const unbranded = eligible.filter((c) => c.kind === "unbranded");
  const branded = eligible.filter((c) => c.kind === "branded_accuracy");
  const slotUnbranded: [SlotResult, SlotResult] = [
    { candidateId: null, explanation: "No eligible unbranded candidate." },
    { candidateId: null, explanation: "No second eligible unbranded candidate." },
  ];
  let slotBranded: SlotResult = { candidateId: null, explanation: "No eligible branded-accuracy candidate." };

  const first = unbranded[0];
  if (first !== undefined) {
    take(first, "preselected_unbranded_first", "Highest-ranked eligible unbranded candidate.");
    slotUnbranded[0] = { candidateId: first.id, explanation: "Highest-ranked eligible unbranded candidate." };
    const remaining = unbranded.slice(1).filter(freeOfTakenGroup);
    const differentStage = remaining.find((c) => c.buyerStage !== first.buyerStage);
    const second = differentStage ?? remaining[0];
    if (second !== undefined) {
      const rule: DecisionRule = differentStage
        ? "preselected_unbranded_second_different_stage"
        : "preselected_unbranded_second_same_stage";
      const detail = differentStage
        ? `Highest-ranked eligible unbranded candidate at a buyer stage other than "${first.buyerStage}".`
        : `No eligible unbranded candidate at another buyer stage; the next-ranked one is used.`;
      take(second, rule, detail);
      slotUnbranded[1] = { candidateId: second.id, explanation: detail };
    }
  }
  const brandedChoice = branded.filter(freeOfTakenGroup)[0];
  if (brandedChoice !== undefined) {
    take(brandedChoice, "preselected_branded", "Highest-ranked eligible branded-accuracy candidate.");
    slotBranded = { candidateId: brandedChoice.id, explanation: "Highest-ranked eligible branded-accuracy candidate." };
  } else if (!setRefused) {
    const others = representatives.filter((c) => c.kind === "branded_accuracy").map((c) => c.id);
    if (others.length > 0) {
      slotBranded = {
        candidateId: null,
        explanation: `No eligible branded-accuracy candidate; not eligible or a near duplicate: ${others.join(", ")}.`,
      };
    }
  }

  const preselected = [slotUnbranded[0].candidateId, slotUnbranded[1].candidateId, slotBranded.candidateId].filter(
    (id): id is string => id !== null
  );
  if (preselected.length > MAX_QUESTIONS_PER_APPROVAL_SET) {
    throw new Error("internal: composition exceeded the approval-set limit");
  }
  const preselectedSet = new Set(preselected);
  const secondTaken = slotUnbranded[1].candidateId;
  const secondRule = secondTaken ? decision.get(secondTaken)?.rule : undefined;

  const explanations: CandidateExplanation[] = candidates.map((c) => {
    const v = validation.candidates.get(c.id) as CandidateValidation;
    const ownLinks = set.links.filter((l) => l.candidateId === c.id);
    const fromIds = mergedFrom.get(c.id) ?? [];
    const links = sortLinks([...ownLinks, ...set.links.filter((l) => fromIds.includes(l.candidateId))]);
    const group = near.nearGroupOf.get(c.id);
    const nearDuplicates = group === undefined ? [] : near.nearGroups[group].filter((id) => id !== c.id);
    const blockers = blockersOf.get(c.id) ?? [];

    let rule: DecisionRule;
    let detail: string;
    if (setRefused) {
      rule = "set_refused";
      detail = `The research set is refused: ${validation.refusals.map((r) => r.code).join(", ")}.`;
    } else if (v.refusals.length > 0) {
      rule = "refused";
      detail = `Refused: ${sortFindings(v.refusals).map((r) => r.code).join(", ")}.`;
    } else if (mergedInto.has(c.id)) {
      rule = "merged_duplicate";
      detail = `Exact duplicate of ${mergedInto.get(c.id)}; merged, keeping its source links.`;
    } else if (blockers.length > 0) {
      rule = blockers[0];
      detail = blockers.map((b) => BLOCKER_DETAIL[b]).join(" ");
    } else if (decision.has(c.id)) {
      ({ rule, detail } = decision.get(c.id)!);
    } else if (!freeOfTakenGroup(c)) {
      const chosen = preselected.filter((id) => nearDuplicates.includes(id));
      rule = "near_duplicate";
      detail = `Near duplicate of preselected ${chosen.join(", ")}; at most one of a group is preselected.`;
    } else if (
      c.kind === "unbranded" &&
      secondRule === "preselected_unbranded_second_different_stage" &&
      first !== undefined &&
      c.buyerStage === first.buyerStage &&
      compareRank(c, candidates.find((x) => x.id === secondTaken)!) < 0
    ) {
      rule = "stage_diversity";
      detail = "Eligible, but the second unbranded slot went to a candidate at a different buyer stage.";
    } else {
      rule = "composition_limit";
      detail = "Eligible, but its slot is filled by a higher-ranked candidate.";
    }

    return {
      candidateId: c.id,
      grade: c.grade,
      verification: v.verification,
      kind: c.kind,
      buyerStage: c.buyerStage,
      ratings: {
        buyerRelevance: { value: c.ratings?.buyerRelevance?.value, reason: c.ratings?.buyerRelevance?.reason },
        icpFit: { value: c.ratings?.icpFit?.value, reason: c.ratings?.icpFit?.reason },
        commercialIntent: { value: c.ratings?.commercialIntent?.value, reason: c.ratings?.commercialIntent?.reason },
        productRelevance: { value: c.ratings?.productRelevance?.value, reason: c.ratings?.productRelevance?.reason },
      },
      relevanceSum: relevanceSum(c),
      refusals: sortFindings(v.refusals),
      signals: sortFindings(v.signals),
      eligible: !setRefused && v.refusals.length === 0 && !mergedInto.has(c.id) && blockers.length === 0,
      preselected: preselectedSet.has(c.id),
      rule,
      blockers,
      detail,
      mergedInto: mergedInto.get(c.id) ?? null,
      mergedFrom: fromIds,
      links,
      nearDuplicates,
    };
  });

  const summary: string[] = [];
  if (setRefused) summary.push(`Research set refused: ${validation.refusals.map((r) => r.code).join(", ")}.`);
  const evidenced = explanations.filter(
    (e) => e.refusals.length === 0 && (e.grade === "observed" || e.grade === "adapted")
  );
  if (!setRefused && evidenced.length === 0) {
    summary.push(
      "No valid observed or adapted candidate: there is no supporting buyer-authored source, so nothing is preselected."
    );
  }
  summary.push(`${preselected.length} of ${candidates.length} candidates preselected.`);

  return {
    setRefusals: sortFindings(validation.refusals),
    preselected,
    slots: { unbranded: slotUnbranded, branded: slotBranded },
    candidates: explanations,
    summary,
  };
}
