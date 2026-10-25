/**
 * Turns a registered intervention with a completed retest into a reviewed,
 * optionally delivered Outcome Card.
 *
 *   read intervention + both phases → build both reports → build the card
 *   → render → derive per-phase integrity → combine → persist → maybe send
 *
 * Structured as closely as possible after deliver-protocol-report.ts's own
 * flow and DeliveryOutcome vocabulary — this is the same pipeline shape
 * applied to a two-phase artifact, not an independently invented one. The
 * canonical delivery rules are unchanged: integrity_passed may deliver
 * automatically; needs_review is held for a founder; blocked is refused —
 * and for this artifact, refused a second time at the database layer by
 * begin_outcome_card_delivery itself (0076), not only by the check below.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import {
  ProtocolEvidenceError,
  readBaselineProtocolEvidence,
  readRetestProtocolEvidence,
} from "@/lib/reports/read-protocol-evidence";
import { readIntegritySignals } from "@/lib/reports/protocol-integrity-signals";
import { renderProtocolReportMarkdown } from "@/lib/reports/render-protocol-report-markdown";
import { buildOutcomeCard } from "@/lib/reports/build-outcome-card";
import { renderOutcomeCardMarkdown } from "@/lib/reports/render-outcome-card-markdown";
import { evaluateOutcomeCardIntegrity } from "@/lib/reports/outcome-card-integrity";
import {
  evaluateServedProviderComparability,
  readServedProviderFingerprints,
} from "@/lib/reports/served-provider-comparability";
import { sendOutcomeCardEmail } from "@/lib/reports/outcome-card-email";
import type { OutcomeCardIntervention } from "@/lib/reports/outcome-card-types";
import { ClientReportDeliveryError, type ClientReportDeliveryConfig } from "@/lib/snapshot-requests/client-report-delivery";

export type OutcomeCardDeliveryOutcome =
  | "delivered"
  | "held_needs_review"
  | "held_blocked"
  | "held_auto_send_disabled"
  | "already_delivered"
  | "persist_refused"
  | "delivery_claim_unavailable"
  | "delivery_ambiguous"
  | "delivery_rejected"
  | "intervention_not_ready";

export interface OutcomeCardProcessResult {
  interventionId: string;
  outcome: OutcomeCardDeliveryOutcome;
  integrityStatus: string;
  integrityReasons: string[];
  artifactId: string | null;
  publicToken: string | null;
  messageId: string | null;
  detail?: string;
}

export interface OutcomeCardProcessDeps {
  client: SupabaseClient;
  autoSendEnabled: boolean;
  deliveryConfig: ClientReportDeliveryConfig;
  now?: () => Date;
  sendEmail?: typeof sendOutcomeCardEmail;
}

/** Mirrors deliver-protocol-report.ts's exact set. */
const PROVEN_NON_DELIVERY = new Set([
  "missing_api_key",
  "missing_from_address",
  "invalid_recipient",
  "invalid_idempotency_key",
  "invalid_public_token",
  "provider_rejected",
]);

interface InterventionRow {
  id: string;
  project_id: string;
  status: string;
  protocol_id: string;
  hypothesis: string;
  expected_mechanism: string;
  action_type: string;
  action_target: string;
  owner: string;
  approved_at: string | null;
  implemented_at: string | null;
  protocol_deviations: string | null;
  early_retest_reason: string | null;
  observation_window_opens_at: string | null;
  observation_window_closes_at: string | null;
}

function toInterventionSummary(row: InterventionRow): OutcomeCardIntervention {
  return {
    hypothesis: row.hypothesis,
    expectedMechanism: row.expected_mechanism,
    actionType: row.action_type,
    actionTarget: row.action_target,
    owner: row.owner,
    approvedAt: row.approved_at,
    implementedAt: row.implemented_at,
    protocolDeviations: row.protocol_deviations,
    earlyRetestReason: row.early_retest_reason,
    observationWindowOpensAt: row.observation_window_opens_at,
    observationWindowClosesAt: row.observation_window_closes_at,
  };
}

async function loadRecipientForBaseline(
  client: SupabaseClient,
  projectId: string,
  baselineProtocolId: string
): Promise<{ workEmail: string; companyName: string } | null> {
  // The recipient is whoever requested THIS card's baseline. Taking the
  // project's most recent request instead stopped being safe once one
  // project held several baselines: a standalone founder baseline (#66) has
  // no request, so the newest request in its project belonged to a
  // different audit, and its address would have received this card. No
  // request for the baseline means no recipient, and nothing is sent.
  const { data, error } = await client
    .from("snapshot_requests")
    .select("work_email,company_name,created_at")
    .eq("project_id", projectId)
    .eq("protocol_id", baselineProtocolId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as Record<string, any>;
  if (typeof row.work_email !== "string" || !row.work_email.includes("@")) {
    return null;
  }
  return { workEmail: row.work_email, companyName: row.company_name };
}

export async function processOutcomeCard(
  interventionId: string,
  deps: OutcomeCardProcessDeps
): Promise<OutcomeCardProcessResult> {
  const now = deps.now ?? (() => new Date());
  const base = {
    interventionId,
    artifactId: null as string | null,
    publicToken: null as string | null,
    messageId: null as string | null,
  };

  const { data: interventionData, error: interventionError } = await deps.client
    .from("interventions")
    .select(
      "id,project_id,status,protocol_id,hypothesis,expected_mechanism,action_type,action_target,owner,approved_at,implemented_at,protocol_deviations,early_retest_reason,observation_window_opens_at,observation_window_closes_at"
    )
    .eq("id", interventionId)
    .maybeSingle();

  if (interventionError) throw interventionError;

  const interventionRow = interventionData as InterventionRow | null;
  if (!interventionRow) {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["Intervention not found."],
      detail: "No intervention with this id exists.",
    };
  }

  // Not a security check — save_outcome_card_artifact (0076) re-derives and
  // enforces this independently at the database layer regardless of what
  // this function decides. This early return only avoids doing the rest of
  // the work (reading both phases' full evidence) for a card that could
  // never be saved anyway.
  if (interventionRow.status !== "implemented") {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["Intervention is not confirmed implemented yet."],
      detail: `Intervention status is ${interventionRow.status}, expected implemented.`,
    };
  }

  // A retest protocol records its baseline, not the intervention that created
  // it. Resolving by baseline is still exact once abandoned retests are
  // excluded: 0079 guarantees at most one non-abandoned retest per baseline,
  // and 0077 guarantees an abandoned one observed nothing. Without the status
  // filter, a baseline that had an intervention abandoned and a replacement
  // registered holds two retest rows, and maybeSingle() throws.
  const { data: retestRow, error: retestError } = await deps.client
    .from("protocols")
    .select("id")
    .eq("project_id", interventionRow.project_id)
    .eq("baseline_protocol_id", interventionRow.protocol_id)
    .neq("status", "abandoned")
    .maybeSingle();

  if (retestError) throw retestError;

  if (!retestRow) {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["No retest protocol exists for this intervention yet."],
      detail: "create_retest_protocol has not been called, or it refused.",
    };
  }
  const retestProtocolId = (retestRow as Record<string, any>).id as string;

  // Both columns belong to the RETEST protocol, not the baseline. 0073 stamps
  // `minimum_useful_change` onto the retest row as it inserts it, and approves
  // that row through `approve_protocol` — which 0075 made the only writer of
  // `detectable_change_at_plan`. A baseline approved before 0075 existed holds
  // null in both, because 0075 deliberately did not backfill, so reading them
  // from the baseline blocked the card for every audit older than that
  // migration while the error below correctly named the retest.
  //
  // Nothing is lost when both rows are populated: 0073 gives the retest the
  // baseline's own run count, and 0075 computes the figure as
  // `_smallest_detectable_change(n, n)` — "symmetric by construction for both
  // a baseline and a retest protocol", in its own words — so the two rows
  // agree by construction rather than by coincidence.
  const { data: retestProtoRow, error: retestProtoError } = await deps.client
    .from("protocols")
    .select("minimum_useful_change,detectable_change_at_plan")
    .eq("id", retestProtocolId)
    .maybeSingle();

  if (retestProtoError) throw retestProtoError;

  const retestProto = retestProtoRow as Record<string, any> | null;
  const minimumUsefulChange = retestProto?.minimum_useful_change?.value;
  if (typeof minimumUsefulChange !== "number") {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["The retest protocol carries no minimum_useful_change (0073 stamps this at creation)."],
      detail: "minimum_useful_change.value is missing or not a number.",
    };
  }

  // The baseline's `subject` (company name, website, domain) comes from the
  // snapshot_request that spawned it, or — for a standalone founder baseline,
  // which has none — from the project the worker measured it against.
  // readBaselineProtocolEvidence verifies the protocol is an approved
  // baseline of this project either way; anything it cannot verify blocks
  // the card here, before anything is built or saved.
  let baselineEvidence: Awaited<ReturnType<typeof readBaselineProtocolEvidence>>;
  let retestEvidence: Awaited<ReturnType<typeof readRetestProtocolEvidence>>;
  try {
    baselineEvidence = await readBaselineProtocolEvidence(
      deps.client,
      interventionRow.protocol_id,
      interventionRow.project_id
    );
    retestEvidence = await readRetestProtocolEvidence(
      deps.client,
      retestProtocolId,
      interventionRow.project_id,
      baselineEvidence.subject
    );
  } catch (error) {
    if (!(error instanceof ProtocolEvidenceError)) throw error;
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["The baseline or retest evidence could not be tied to this intervention's project."],
      detail: error.message,
    };
  }

  const baselinePayload = buildProtocolReport({ ...baselineEvidence, now: now() });
  const retestPayload = buildProtocolReport({ ...retestEvidence, now: now() });

  const card = buildOutcomeCard({
    projectId: interventionRow.project_id,
    baseline: baselinePayload,
    retest: retestPayload,
    intervention: toInterventionSummary(interventionRow),
    minimumUsefulChange,
    detectableChangeAtPlan: retestProto?.detectable_change_at_plan ?? null,
    now: now(),
  });
  const markdown = renderOutcomeCardMarkdown(card);

  const baselineMarkdown = renderProtocolReportMarkdown(baselinePayload);
  const retestMarkdown = renderProtocolReportMarkdown(retestPayload);
  const [baselineSignals, retestSignals, baselineServed, retestServed] = await Promise.all([
    readIntegritySignals(deps.client, baselinePayload),
    readIntegritySignals(deps.client, retestPayload),
    readServedProviderFingerprints(deps.client, interventionRow.protocol_id),
    readServedProviderFingerprints(deps.client, retestProtocolId),
  ]);

  const integrity = evaluateOutcomeCardIntegrity({
    baselineMarkdown,
    baselineSignals,
    retestMarkdown,
    retestSignals,
    interventionRegisteredAndImplemented: interventionRow.status === "implemented",
    servedProvider: evaluateServedProviderComparability(baselineServed, retestServed),
  });

  const { data: savedData, error: saveError } = await deps.client.rpc(
    "save_outcome_card_artifact",
    {
      p_intervention_id: interventionId,
      p_project_id: interventionRow.project_id,
      p_baseline_protocol_id: interventionRow.protocol_id,
      p_retest_protocol_id: retestProtocolId,
      p_markdown: markdown,
      p_generated_at: card.generatedAt,
      p_payload: card,
      p_integrity_status: integrity.status,
      p_integrity_reasons: integrity.reasons,
    }
  );

  if (saveError) throw saveError;

  const artifact = (Array.isArray(savedData) ? savedData[0] : savedData) as Record<string, any> | null;

  const held = {
    ...base,
    integrityStatus: integrity.status,
    integrityReasons: integrity.reasons,
  };

  if (!artifact) {
    return {
      ...held,
      outcome: "persist_refused",
      detail:
        "Save refused: the intervention must be implemented and the retest protocol must actually belong to its baseline, or the artifact is already delivered.",
    };
  }

  const artifactId = artifact.id as string;
  const publicToken = artifact.public_token as string;
  const heldWithArtifact = { ...held, artifactId, publicToken };

  if (integrity.status === "blocked") {
    return { ...heldWithArtifact, outcome: "held_blocked" };
  }
  if (integrity.status === "needs_review") {
    return { ...heldWithArtifact, outcome: "held_needs_review" };
  }
  if (!deps.autoSendEnabled) {
    return { ...heldWithArtifact, outcome: "held_auto_send_disabled" };
  }
  if (artifact.delivered_at) {
    return { ...heldWithArtifact, outcome: "already_delivered" };
  }

  const { data: revisionData, error: revisionError } = await deps.client.rpc(
    "outcome_card_artifact_revision",
    { p_markdown: markdown, p_payload: card }
  );
  if (revisionError) throw revisionError;

  const delivery = await deliverSavedOutcomeCard(
    {
      interventionId,
      projectId: interventionRow.project_id,
      baselineProtocolId: interventionRow.protocol_id,
      artifactId,
      publicToken,
      revision: revisionData as string,
      questionText: card.question.text,
    },
    deps
  );

  return {
    ...heldWithArtifact,
    outcome: delivery.outcome,
    messageId: delivery.messageId,
    ...(delivery.detail ? { detail: delivery.detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// The one path that emails a customer an Outcome Card
// ---------------------------------------------------------------------------

export interface SavedOutcomeCardDelivery {
  interventionId: string;
  projectId: string;
  /** The intervention's baseline. Its own snapshot request names the recipient. */
  baselineProtocolId: string;
  artifactId: string;
  publicToken: string;
  /**
   * outcome_card_artifact_revision() of the content being sent. For the
   * automatic path this is the card just built; for a founder send it is
   * the revision of the card the founder reviewed. begin_outcome_card_delivery
   * refuses unless the stored artifact still has exactly this revision, so a
   * card that changed after review is never the one delivered.
   */
  revision: string;
  questionText: string;
}

export interface SavedOutcomeCardDeliveryResult {
  outcome: Extract<
    OutcomeCardDeliveryOutcome,
    | "delivered"
    | "already_delivered"
    | "held_blocked"
    | "delivery_claim_unavailable"
    | "delivery_rejected"
    | "delivery_ambiguous"
  >;
  messageId: string | null;
  detail?: string;
}

/**
 * 0076's begin_outcome_card_delivery raises (rather than returning no row)
 * when it refuses. Each refusal is a known state, not a crash: mapped here so
 * neither the worker nor a founder route treats a stale revision or an
 * in-flight claim as an unexpected error.
 */
const BEGIN_REFUSALS: Record<string, { outcome: SavedOutcomeCardDeliveryResult["outcome"]; detail: string }> = {
  "outcome card already delivered": {
    outcome: "already_delivered",
    detail: "This card was already delivered.",
  },
  "outcome card is blocked and may never be delivered": {
    outcome: "held_blocked",
    detail: "This card is blocked and can never be delivered.",
  },
  "artifact revision changed since preview": {
    outcome: "delivery_claim_unavailable",
    detail: "The card changed after it was reviewed. Reload and review the current version before sending.",
  },
  "delivery claim is active": {
    outcome: "delivery_claim_unavailable",
    detail: "Another delivery of this card is already in progress.",
  },
  "artifact id mismatch": {
    outcome: "delivery_claim_unavailable",
    detail: "The card was regenerated after it was reviewed. Reload and review the current version before sending.",
  },
  "outcome card artifact not found": {
    outcome: "delivery_claim_unavailable",
    detail: "No saved card exists for this intervention.",
  },
};

export async function deliverSavedOutcomeCard(
  card: SavedOutcomeCardDelivery,
  deps: Pick<OutcomeCardProcessDeps, "client" | "deliveryConfig" | "sendEmail">
): Promise<SavedOutcomeCardDeliveryResult> {
  const recipient = await loadRecipientForBaseline(
    deps.client,
    card.projectId,
    card.baselineProtocolId
  );
  if (!recipient) {
    return {
      outcome: "delivery_rejected",
      messageId: null,
      detail:
        "No snapshot request with a usable address started this card's baseline, so it has no recipient. Nothing was sent.",
    };
  }

  const { data: begun, error: beginError } = await deps.client.rpc("begin_outcome_card_delivery", {
    p_intervention_id: card.interventionId,
    p_expected_artifact_id: card.artifactId,
    p_expected_revision: card.revision,
  });

  if (beginError) {
    const refusal = BEGIN_REFUSALS[String((beginError as { message?: unknown }).message ?? "").trim()];
    if (refusal) return { ...refusal, messageId: null };
    throw beginError;
  }

  const claim = (Array.isArray(begun) ? begun[0] : begun) as Record<string, any> | null;
  if (!claim) {
    return {
      outcome: "delivery_claim_unavailable",
      messageId: null,
      detail: "Delivery claim refused: the artifact changed, is already delivered, is blocked, or a claim is held.",
    };
  }

  const claimToken = claim.delivery_claim_token as string;
  const send = deps.sendEmail ?? sendOutcomeCardEmail;

  let messageId: string;
  try {
    const sent = await send(
      {
        to: recipient.workEmail,
        companyName: recipient.companyName,
        publicToken: card.publicToken,
        questionText: card.questionText,
        // Keyed on content revision, so retrying the same revision is
        // deduplicated by the provider while a different revision is a
        // genuinely new message.
        deliveryIdempotencyKey: `outcome-card:${card.interventionId}:${card.revision.slice(0, 32)}`,
      },
      deps.deliveryConfig
    );
    messageId = sent.messageId;
  } catch (sendError) {
    const code = sendError instanceof ClientReportDeliveryError ? sendError.code : "unknown";

    if (PROVEN_NON_DELIVERY.has(code)) {
      try {
        await deps.client.rpc("release_outcome_card_delivery_claim", {
          p_intervention_id: card.interventionId,
          p_artifact_id: card.artifactId,
          p_delivery_claim_token: claimToken,
        });
      } catch {
        // A failed release is never reported as released.
      }
      return {
        outcome: "delivery_rejected",
        messageId: null,
        detail: `Provider refused before sending (${code}). Claim released; retry is safe.`,
      };
    }

    return {
      outcome: "delivery_ambiguous",
      messageId: null,
      detail: `Delivery outcome unknown (${code}). Claim intentionally held to prevent a duplicate email.`,
    };
  }

  const { data: finalized, error: finalizeError } = await deps.client.rpc("finalize_outcome_card_delivery", {
    p_intervention_id: card.interventionId,
    p_artifact_id: card.artifactId,
    p_delivery_claim_token: claimToken,
    p_delivery_message_id: messageId,
  });

  if (finalizeError) throw finalizeError;

  const done = (Array.isArray(finalized) ? finalized[0] : finalized) as Record<string, any> | null;
  if (!done) {
    return {
      outcome: "delivery_ambiguous",
      messageId,
      detail:
        "Email was accepted by the provider but the delivery record did not finalize. Reconcile manually before any resend.",
    };
  }

  return { outcome: "delivered", messageId };
}

/**
 * Implemented interventions whose retest protocol has a succeeded job and
 * whose card has not been delivered yet. Mirrors findDeliverableRequests's
 * exact three-step shape: find the candidate parent rows, require the
 * SUCCEEDED job precondition (a retest protocol can exist while its job is
 * still queued or running — that is not this function's business yet),
 * then exclude anything already delivered.
 */
export async function findDeliverableInterventions(
  client: SupabaseClient,
  limit = 25
): Promise<string[]> {
  const { data: interventions, error: interventionsError } = await client
    .from("interventions")
    .select("id,protocol_id")
    .eq("status", "implemented")
    .limit(500);

  if (interventionsError) throw interventionsError;

  const rows = (interventions ?? []) as Array<{ id: string; protocol_id: string }>;
  if (rows.length === 0) return [];

  const baselineIds = rows.map((r) => r.protocol_id);

  // Same resolution rule as processOutcomeCard: abandoned retests never
  // belong to a deliverable intervention (see 0079).
  const { data: retests, error: retestsError } = await client
    .from("protocols")
    .select("id,baseline_protocol_id")
    .in("baseline_protocol_id", baselineIds)
    .neq("status", "abandoned");

  if (retestsError) throw retestsError;

  const retestRows = (retests ?? []) as Array<{ id: string; baseline_protocol_id: string }>;
  if (retestRows.length === 0) return [];

  const { data: jobs, error: jobsError } = await client
    .from("protocol_execution_jobs")
    .select("protocol_id")
    .eq("status", "succeeded")
    .in(
      "protocol_id",
      retestRows.map((r) => r.id)
    );

  if (jobsError) throw jobsError;

  const succeededRetestProtocolIds = new Set(
    (jobs ?? []).map((j: Record<string, any>) => j.protocol_id as string)
  );

  const retestProtocolIdByBaseline = new Map(
    retestRows
      .filter((r) => succeededRetestProtocolIds.has(r.id))
      .map((r) => [r.baseline_protocol_id, r.id])
  );

  const candidateInterventionIds = rows
    .filter((r) => retestProtocolIdByBaseline.has(r.protocol_id))
    .map((r) => r.id);

  if (candidateInterventionIds.length === 0) return [];

  const { data: existingArtifacts, error: artifactsError } = await client
    .from("outcome_card_artifacts")
    .select("intervention_id,delivered_at")
    .in("intervention_id", candidateInterventionIds);

  if (artifactsError) throw artifactsError;

  const deliveredIds = new Set(
    (existingArtifacts ?? [])
      .filter((a: Record<string, any>) => a.delivered_at)
      .map((a: Record<string, any>) => a.intervention_id as string)
  );

  return candidateInterventionIds.filter((id) => !deliveredIds.has(id)).slice(0, limit);
}
