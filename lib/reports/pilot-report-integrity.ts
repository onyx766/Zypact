/**
 * D-055 — the combined pilot report's integrity status.
 *
 * Starts from the worst per-question result: every live question's own
 * signals (approved protocol, sample plan, reservations, evidence hashes)
 * go through the same `evaluateReportIntegrity` a one-question report uses.
 * The builder's structural findings are added: an unfinished or
 * unreconciled question needs review, evidence outside the pilot blocks.
 *
 * A retired question shows only its attempt counts, but every answer it did
 * collect still passes the same evidence and hash checks. Only the checks
 * that need a collected answer to mean anything (a reservation and a hash
 * per counted answer) are skipped for a retired question that collected
 * none, because they are false by construction there. D-061: the same two
 * checks are skipped for a live measurement with no attempt at all (a
 * ChatGPT measurement just added and still queued), which reserved and
 * collected nothing; the builder's "has not finished" reason already holds
 * the report, so it is named once instead of three times.
 *
 * The text checks read every string the page shows (the shared presentation
 * model) as well as the Markdown, so a phrase cannot reach the customer
 * through the page alone (METHODOLOGY §16 gates 11 and 14).
 */
import {
  evaluateReportIntegrity,
  type ReportIntegrityResult,
  type ReportIntegrityStatus,
} from "@/lib/export/report-integrity";
import { engineLabel, type PilotStructuralReason } from "@/lib/reports/build-pilot-report";
import { evaluateOutcomeCardIntegrity } from "@/lib/reports/outcome-card-integrity";
import type { PilotEngineKey } from "@/lib/reports/pilot-report-types";
import type { ProtocolIntegritySignals } from "@/lib/reports/protocol-integrity-signals";

const RANK: Record<ReportIntegrityStatus, number> = { integrity_passed: 0, needs_review: 1, blocked: 2 };

function worse(a: ReportIntegrityStatus, b: ReportIntegrityStatus): ReportIntegrityStatus {
  return RANK[b] > RANK[a] ? b : a;
}

export interface PilotQuestionSignals {
  ordinal: number;
  engine: PilotEngineKey;
  retired: boolean;
  /** Completed attempts of this question on this engine. */
  completedAttempts: number;
  /**
   * D-061 — every recorded attempt of this question on this engine. Absent:
   * not known, so the per-answer checks always run.
   */
  attempts?: number;
  signals: ProtocolIntegritySignals;
}

/**
 * D-062 — one Outcome Card's integrity inputs: both phases' signals (the
 * baseline's reused from the question loop), whether its intervention was
 * registered and implemented, and whether both phases were measured the
 * same way. The page text is scanned once, above, for the whole report.
 */
export interface PilotCardSignals {
  ordinal: number;
  engine: PilotEngineKey;
  baselineSignals: ProtocolIntegritySignals;
  retestSignals: ProtocolIntegritySignals;
  interventionRegisteredAndImplemented: boolean;
  measurement: { comparable: boolean; detail: string };
}

export function evaluatePilotReportIntegrity(input: {
  markdown: string;
  /** Every string the client page renders (presentationStrings). */
  pageText: string[];
  structural: PilotStructuralReason[];
  questionSignals: PilotQuestionSignals[];
  /** D-062 — absent: no Outcome Card. */
  cardSignals?: PilotCardSignals[];
}): ReportIntegrityResult {
  let status: ReportIntegrityStatus = "integrity_passed";
  const reasons: string[] = [];

  const body = evaluateReportIntegrity({
    markdown: `${input.markdown}\n${input.pageText.join("\n")}`,
    hasApprovedProtocol: true,
    hasApprovedSamplePlan: true,
    hasPaidCallReservation: true,
    hasCompleteEvidenceHashes: true,
  });
  if (body.status !== "integrity_passed") {
    status = worse(status, body.status);
    reasons.push(...body.reasons.map((r) => `Report text: ${r}`));
  }

  for (const q of [...input.questionSignals].sort((a, b) => a.ordinal - b.ordinal)) {
    const nothingCollected = q.completedAttempts === 0 && (q.retired || q.attempts === 0);
    const signals = nothingCollected
      ? { ...q.signals, hasPaidCallReservation: true, hasCompleteEvidenceHashes: true }
      : q.signals;
    const result = evaluateReportIntegrity({ markdown: "", ...signals });
    if (result.status === "integrity_passed") continue;
    status = worse(status, result.status);
    reasons.push(...result.reasons.map((r) => `Question ${q.ordinal} (${engineLabel(q.engine)}): ${r}`));
  }

  // D-062 — each card through the M7 card rule, worst first, named by its question and engine.
  const engineRank = (e: PilotEngineKey) => (e === "perplexity_sonar" ? 0 : 1);
  for (const c of [...(input.cardSignals ?? [])].sort((a, b) => a.ordinal - b.ordinal || engineRank(a.engine) - engineRank(b.engine))) {
    const result = evaluateOutcomeCardIntegrity({
      baselineMarkdown: "",
      baselineSignals: c.baselineSignals,
      retestMarkdown: "",
      retestSignals: c.retestSignals,
      interventionRegisteredAndImplemented: c.interventionRegisteredAndImplemented,
      measurement: c.measurement,
    });
    if (result.status === "integrity_passed") continue;
    status = worse(status, result.status);
    reasons.push(...result.reasons.map((r) => `Question ${c.ordinal} (${engineLabel(c.engine)}) Outcome Card: ${r}`));
  }

  for (const s of input.structural) {
    status = worse(status, s.status);
    reasons.push(s.reason);
  }

  if (status === "integrity_passed") return { status, reasons: [] };
  return { status, reasons: [...new Set(reasons)] };
}
