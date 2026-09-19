/**
 * The intervention row as the application sees it.
 *
 * Mirrors `public.interventions` after migrations 0071, 0072 and 0077. Every
 * write goes through a `service_role` RPC; this type is read-only by intent.
 */

/** 0071's `interventions.status` constraint, exactly. */
export const INTERVENTION_STATUSES = [
  "proposed",
  "approved",
  "implemented",
  "rejected",
  "abandoned",
] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

/** 0071's `interventions.action_type` constraint, exactly. */
export const ACTION_TYPES = [
  "content_published",
  "content_updated",
  "page_created",
  "structured_data_added",
  "third_party_listing",
  "documentation_updated",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface Intervention {
  id: string;
  projectId: string;
  /** The baseline protocol this intervention is registered against. */
  protocolId: string;
  buyerQuestionVersionId: string;
  status: InterventionStatus;

  hypothesis: string;
  expectedMechanism: string;
  actionType: ActionType;
  actionTarget: string;
  owner: string;
  supportingEvidence: string[];
  alternativeExplanations: string | null;
  confoundersToMonitor: string | null;
  decisionThresholdNote: string | null;
  implementationDeadline: string | null;
  expectedObservationDays: number | null;

  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;

  implementedAt: string | null;
  implementationEvidence: Record<string, unknown> | null;
  implementationConfirmedBy: string | null;
  artifactSha256: string | null;
  protocolDeviations: string | null;

  observationWindowOpensAt: string | null;
  observationWindowClosesAt: string | null;
  earlyRetestAuthorizedBy: string | null;
  earlyRetestAuthorizedAt: string | null;
  earlyRetestReason: string | null;

  abandonedBy: string | null;
  abandonedAt: string | null;
  abandonedReason: string | null;

  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function mapInterventionRow(r: Row): Intervention {
  const evidence = Array.isArray(r.supporting_evidence)
    ? r.supporting_evidence.filter((e): e is string => typeof e === "string")
    : [];
  const impl =
    r.implementation_evidence && typeof r.implementation_evidence === "object" && !Array.isArray(r.implementation_evidence)
      ? (r.implementation_evidence as Record<string, unknown>)
      : null;

  return {
    id: str(r.id),
    projectId: str(r.project_id),
    protocolId: str(r.protocol_id),
    buyerQuestionVersionId: str(r.buyer_question_version_id),
    status: str(r.status) as InterventionStatus,

    hypothesis: str(r.hypothesis),
    expectedMechanism: str(r.expected_mechanism),
    actionType: str(r.action_type) as ActionType,
    actionTarget: str(r.action_target),
    owner: str(r.owner),
    supportingEvidence: evidence,
    alternativeExplanations: strOrNull(r.alternative_explanations),
    confoundersToMonitor: strOrNull(r.confounders_to_monitor),
    decisionThresholdNote: strOrNull(r.decision_threshold_note),
    implementationDeadline: strOrNull(r.implementation_deadline),
    expectedObservationDays:
      typeof r.expected_observation_days === "number" ? r.expected_observation_days : null,

    approvedBy: strOrNull(r.approved_by),
    approvedAt: strOrNull(r.approved_at),
    rejectedBy: strOrNull(r.rejected_by),
    rejectedAt: strOrNull(r.rejected_at),
    rejectedReason: strOrNull(r.rejected_reason),

    implementedAt: strOrNull(r.implemented_at),
    implementationEvidence: impl,
    implementationConfirmedBy: strOrNull(r.implementation_confirmed_by),
    artifactSha256: strOrNull(r.artifact_sha256),
    protocolDeviations: strOrNull(r.protocol_deviations),

    observationWindowOpensAt: strOrNull(r.observation_window_opens_at),
    observationWindowClosesAt: strOrNull(r.observation_window_closes_at),
    earlyRetestAuthorizedBy: strOrNull(r.early_retest_authorized_by),
    earlyRetestAuthorizedAt: strOrNull(r.early_retest_authorized_at),
    earlyRetestReason: strOrNull(r.early_retest_reason),

    abandonedBy: strOrNull(r.abandoned_by),
    abandonedAt: strOrNull(r.abandoned_at),
    abandonedReason: strOrNull(r.abandoned_reason),

    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}
