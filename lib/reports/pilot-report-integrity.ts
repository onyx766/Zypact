/**
 * D-055 — the combined pilot report's integrity status.
 *
 * Starts from the worst per-question result: every live question's own
 * signals (approved protocol, sample plan, reservations, evidence hashes)
 * go through the same `evaluateReportIntegrity` a one-question report uses.
 * The builder's structural findings are added: an unfinished or
 * unreconciled question needs review, evidence outside the pilot blocks.
 * A retired question is reported as retired and does not hold the report.
 */
import {
  evaluateReportIntegrity,
  type ReportIntegrityResult,
  type ReportIntegrityStatus,
} from "@/lib/export/report-integrity";
import { engineLabel, type PilotStructuralReason } from "@/lib/reports/build-pilot-report";
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
  signals: ProtocolIntegritySignals;
}

export function evaluatePilotReportIntegrity(input: {
  markdown: string;
  structural: PilotStructuralReason[];
  questionSignals: PilotQuestionSignals[];
}): ReportIntegrityResult {
  let status: ReportIntegrityStatus = "integrity_passed";
  const reasons: string[] = [];

  const body = evaluateReportIntegrity({
    markdown: input.markdown,
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
    if (q.retired) continue;
    const result = evaluateReportIntegrity({ markdown: "", ...q.signals });
    if (result.status === "integrity_passed") continue;
    status = worse(status, result.status);
    reasons.push(...result.reasons.map((r) => `Question ${q.ordinal} (${engineLabel(q.engine)}): ${r}`));
  }

  for (const s of input.structural) {
    status = worse(status, s.status);
    reasons.push(s.reason);
  }

  if (status === "integrity_passed") return { status, reasons: [] };
  return { status, reasons: [...new Set(reasons)] };
}
