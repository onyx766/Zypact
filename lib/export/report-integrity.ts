/**
 * M3 reliquat — minimum real implementation of the canonical report
 * integrity contract (METHODOLOGY.md §16; ENGINEERING_PLAN.md M3
 * acceptance tests).
 *
 * Before this file, `integrity_passed`/`needs_review` existed nowhere in
 * the application: the only occurrence in the whole repository was as
 * marketing copy in the landing page (asserted by
 * scripts/test-landing-page.ts). No function computed or enforced this
 * contract. This module is a genuine, minimal classifier — not a stub —
 * but it deliberately does not implement all 14 gates listed in
 * METHODOLOGY.md §16. It implements exactly the gates this milestone
 * scoped:
 *
 *   1. A report that still presents legacy `won`/`partial`/`lost`
 *      verdicts as client-facing ground truth is unsafe and must never
 *      reach `integrity_passed` automatically — it is `blocked`.
 *   2. M4 has not shipped yet: no approved/versioned protocol, no
 *      approved bounded sample plan, and no per-paid-attempt reservation
 *      exist anywhere in this codebase (confirmed by the M4 read-only
 *      audit that preceded this fix). Every real caller today therefore
 *      passes these flags as false (or omits them), which structurally
 *      caps every real report at `needs_review` — never
 *      `integrity_passed` — until M4 actually exists. This is not this
 *      module pretending M4 gates are satisfied; it is the opposite.
 *
 * `evaluateReportIntegrity` takes already-rendered output plus explicit
 * booleans for the M4 preconditions, rather than reaching into a
 * protocol/sampling system that does not exist. A future M4 caller wires
 * its own real signals into these same fields; nothing here needs to
 * change for that to happen.
 */

export type ReportIntegrityStatus =
  | "integrity_passed"
  | "needs_review"
  | "blocked";

export interface ReportIntegrityCheckInput {
  /** The rendered report body to scan for unsafe legacy-verdict exposure. */
  markdown: string;
  /**
   * M4 precondition. Always false/absent today — no protocol concept
   * exists anywhere in this codebase yet.
   */
  hasApprovedProtocol?: boolean;
  /**
   * M4 precondition. Always false/absent today — no approved, versioned
   * sample plan exists anywhere in this codebase yet.
   */
  hasApprovedSamplePlan?: boolean;
  /**
   * M4 precondition. Always false/absent today — no per-paid-attempt
   * reservation/reconciliation exists anywhere in this codebase yet.
   */
  hasPaidCallReservation?: boolean;
  /**
   * M1 evidence completeness for every probe result this report includes
   * (a request/response hash present). Optional: a caller that has not
   * computed this yet should omit it rather than assert a value it did
   * not check — omission is treated the same as `false` (fail closed).
   */
  hasCompleteEvidenceHashes?: boolean;
}

export interface ReportIntegrityResult {
  status: ReportIntegrityStatus;
  /** Empty iff status is `integrity_passed`. */
  reasons: string[];
}

/**
 * The exact, narrow patterns `lib/export/build-mvp-report.ts` renders
 * today for the legacy per-prompt-group verdict aggregate
 * (`PromptGroupVerdict`, `lib/probe-results/report-selection.ts`) — the
 * majority-threshold heuristic D-014 names as the methodological defect
 * being corrected. Anchored on the exact literal formatting so this
 * never false-positives on unrelated prose (e.g. "lost prompts" in a
 * Fix Brief suggestion, or the `whyClientLost` field name).
 */
const LEGACY_VERDICT_PATTERNS: readonly RegExp[] = [
  /\d+\s+won\s+·\s+\d+\s+partial\s+·\s+\d+\s+lost\b/,
  /\*\*won prompt groups\*\*:\s*\d+/,
  /\*\*partial prompt groups\*\*:\s*\d+/,
  /\*\*lost prompt groups\*\*:\s*\d+/,
];

/**
 * True iff the rendered report presents the legacy won/partial/lost
 * aggregate as client-facing ground truth. Does not replace
 * `PromptGroupVerdict` or `build-mvp-report.ts` — it only detects that
 * the legacy vocabulary is still what the report tells the client is
 * true, which D-014 and this milestone's scope say is unsafe to deliver
 * automatically.
 */
export function reportExposesLegacyVerdictAsTruth(markdown: string): boolean {
  return LEGACY_VERDICT_PATTERNS.some((pattern) => pattern.test(markdown));
}

/**
 * Classifies a report into the three canonical integrity states.
 * `blocked` always wins over `needs_review`: an unsafe artifact is never
 * merely "held for review," it is refused outright.
 */
export function evaluateReportIntegrity(
  input: ReportIntegrityCheckInput
): ReportIntegrityResult {
  if (reportExposesLegacyVerdictAsTruth(input.markdown)) {
    return {
      status: "blocked",
      reasons: [
        "Report exposes legacy won/partial/lost verdicts as client-facing ground truth — unsafe under the canonical V1 methodology (D-014). Automatic delivery is refused.",
      ],
    };
  }

  const reasons: string[] = [];

  if (!input.hasCompleteEvidenceHashes) {
    reasons.push(
      "One or more included probe results are missing required M1 evidence hashes."
    );
  }
  if (!input.hasApprovedProtocol) {
    reasons.push(
      "No approved, versioned protocol exists for this report yet (M4)."
    );
  }
  if (!input.hasApprovedSamplePlan) {
    reasons.push(
      "No approved bounded sampling plan exists for this report yet (M4)."
    );
  }
  if (!input.hasPaidCallReservation) {
    reasons.push(
      "No per-paid-attempt reservation/reconciliation exists for this report yet (M4)."
    );
  }

  if (reasons.length > 0) {
    return { status: "needs_review", reasons };
  }

  return { status: "integrity_passed", reasons: [] };
}
