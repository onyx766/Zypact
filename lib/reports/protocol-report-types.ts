/**
 * Canonical V1 protocol-report payload.
 *
 * This is the one snapshot that drives every client view and artifact. It is
 * produced once from stored protocol evidence, persisted verbatim, and read
 * back by the client page — no re-derivation at render time, so a later
 * analyzer change can never silently restate a delivered number.
 *
 * Deliberately absent, per METHODOLOGY.md section 7 and D-001/D-002:
 * `won` / `partial` / `lost` verdicts, a single universal visibility score,
 * and any causal or revenue claim. Everything here is scoped to one buyer
 * question version on one provider surface, and every attempt the protocol
 * reserved is accounted for in `reconciliation`.
 */

/** Wire format version. Bump only with a reader that handles both. */
export const PROTOCOL_REPORT_VERSION = 1 as const;

export interface ProtocolReportSubject {
  companyName: string;
  websiteUrl: string;
  normalizedDomain: string;
}

export interface ProtocolReportQuestion {
  /** Exact approved prompt text. Never paraphrased for display. */
  text: string;
  /** SHA-256 of the prompt, so a reader can prove identity across retests. */
  hash: string;
  versionNumber: number;
  intentType: string;
  provenance: string;
  approvedAt: string | null;
}

export interface ProtocolReportProtocol {
  id: string;
  provider: string;
  surface: string;
  model: string;
  plannedBaselineRuns: number;
  unitOfAnalysis: string;
  primaryMetric: string;
  methodologyVersion: string;
  analyzerVersion: number | null;
  entityResolutionVersion: number | null;
  approvedAt: string | null;
}

/**
 * Full attempt accounting. `attempted` is every attempt row the protocol
 * created, including ones that failed and ones that were superseded by a
 * retry; V1 requires failed and excluded attempts to stay visible in the
 * denominator rather than being quietly dropped.
 */
export interface ProtocolReportReconciliation {
  planned: number;
  attempted: number;
  completed: number;
  failed: number;
  /**
   * Attempts a reviewer excluded rather than the provider failing — an
   * ambiguous call resolved administratively. Kept separate from `failed`
   * because calling a reviewed exclusion a provider failure misstates what
   * happened.
   */
  excludedByReview: number;
  /** Attempts that exist only as a retry of an earlier attempt. */
  retried: number;
  /** Completed attempts with no readable provider result. */
  excludedNoResult: number;
  /** True when completed + failed + excludedByReview equals attempted. */
  accountedFor: boolean;
}

export interface ProtocolReportInterval {
  low: number;
  high: number;
}

/**
 * The single reported observation. `rate` is null when nothing completed —
 * an honest empty state rather than a fabricated zero.
 */
export interface ProtocolReportObservation {
  metric: string;
  numerator: number;
  denominator: number;
  rate: number | null;
  interval: ProtocolReportInterval | null;
  intervalMethod: "wilson_95";
}

export interface ProtocolReportRun {
  ordinal: number;
  status: string;
  /** null when the attempt produced no readable result. */
  brandPresent: boolean | null;
  position: string | null;
  competitors: string[];
  citedSourceCount: number;
  answerSummary: string;
  /** SHA-256 of the stored raw provider response. */
  evidenceHash: string | null;
  providerModel: string | null;
  latencyMs: number | null;
  /** Ordinal this attempt retried, when it is a retry. */
  retryOfOrdinal: number | null;
  terminationReason: string | null;
}

export interface ProtocolReportCompetitor {
  name: string;
  runsMentionedIn: number;
}

export interface ProtocolReportPayload {
  reportVersion: typeof PROTOCOL_REPORT_VERSION;
  generatedAt: string;
  snapshotRequestId: string;
  projectId: string;

  subject: ProtocolReportSubject;
  question: ProtocolReportQuestion;
  protocol: ProtocolReportProtocol;
  reconciliation: ProtocolReportReconciliation;
  observation: ProtocolReportObservation;
  runs: ProtocolReportRun[];
  competitorsObserved: ProtocolReportCompetitor[];

  uncertainty: string[];
  integrityNotes: string[];
  limitations: string[];
}

/**
 * Narrows a stored payload before it is rendered.
 *
 * The column is `jsonb`, so a row written by an older build, a hand-edited
 * row, or a future version can all arrive here. The page must fall back to a
 * legacy render rather than throw halfway through a client-facing document,
 * so this checks the fields the renderer actually dereferences.
 */
export function isProtocolReportPayload(
  value: unknown
): value is ProtocolReportPayload {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;

  if (candidate.reportVersion !== PROTOCOL_REPORT_VERSION) return false;

  for (const key of [
    "subject",
    "question",
    "protocol",
    "reconciliation",
    "observation",
  ]) {
    const nested = candidate[key];
    if (typeof nested !== "object" || nested === null) return false;
  }

  return (
    Array.isArray(candidate.runs) &&
    Array.isArray(candidate.competitorsObserved) &&
    Array.isArray(candidate.uncertainty) &&
    Array.isArray(candidate.integrityNotes) &&
    Array.isArray(candidate.limitations)
  );
}

/* ------------------------------------------------------------------ */
/* Builder input — decoupled from database row shapes on purpose, so a  */
/* schema rename cannot silently change a delivered report.             */
/* ------------------------------------------------------------------ */

export interface EvidenceAttemptInput {
  id: string;
  attemptKind: string;
  status: string;
  baselineOrdinal: number | null;
  probeRunId: string | null;
  retryOfAttemptId: string | null;
  terminationReason: string | null;
}

export interface EvidenceResultInput {
  probeRunId: string;
  clientMentioned: boolean | null;
  clientPosition: string | null;
  competitorsMentioned: string[];
  sourcesCited: unknown[];
  answerSummary: string | null;
  rawResponseSha256: string | null;
  providerModel: string | null;
  providerLatencyMs: number | null;
}

export interface BuildProtocolReportInput {
  snapshotRequestId: string;
  projectId: string;
  subject: ProtocolReportSubject;
  question: ProtocolReportQuestion;
  protocol: ProtocolReportProtocol;
  attempts: EvidenceAttemptInput[];
  results: EvidenceResultInput[];
  /** Injected for deterministic tests. */
  now?: Date;
}
