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
  readProtocolEvidence,
  readRetestProtocolEvidence,
} from "@/lib/reports/read-protocol-evidence";
import { readIntegritySignals } from "@/lib/reports/protocol-integrity-signals";
import { renderProtocolReportMarkdown } from "@/lib/reports/render-protocol-report-markdown";
import { buildOutcomeCard } from "@/lib/reports/build-outcome-card";
import { renderOutcomeCardMarkdown } from "@/lib/reports/render-outcome-card-markdown";
import { evaluateOutcomeCardIntegrity } from "@/lib/reports/outcome-card-integrity";
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

async function loadRecipientForProject(
  client: SupabaseClient,
  projectId: string
): Promise<{ workEmail: string; companyName: string } | null> {
  // A project is created once per approved snapshot request in the current
  // founder-operated V1 flow (approve_and_launch_snapshot_baseline). Most
  // recent by created_at, defensively, in case that ever stops being 1:1.
  const { data, error } = await client
    .from("snapshot_requests")
    .select("work_email,company_name,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
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

  const { data: retestRow, error: retestError } = await deps.client
    .from("protocols")
    .select("id")
    .eq("project_id", interventionRow.project_id)
    .eq("baseline_protocol_id", interventionRow.protocol_id)
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

  const { data: baselineProtoRow, error: baselineProtoError } = await deps.client
    .from("protocols")
    .select("minimum_useful_change,detectable_change_at_plan")
    .eq("id", interventionRow.protocol_id)
    .maybeSingle();

  if (baselineProtoError) throw baselineProtoError;

  const baselineProto = baselineProtoRow as Record<string, any> | null;
  const minimumUsefulChange = baselineProto?.minimum_useful_change?.value;
  if (typeof minimumUsefulChange !== "number") {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["The retest protocol carries no minimum_useful_change (0073 stamps this at creation)."],
      detail: "minimum_useful_change.value is missing or not a number.",
    };
  }

  // The baseline's `subject` (company name, website, domain) lives on the
  // snapshot_request that spawned it — the reverse direction of the lookup
  // readProtocolEvidence already does (request.protocol_id -> protocol).
  const { data: originatingRequest, error: originatingRequestError } = await deps.client
    .from("snapshot_requests")
    .select("id")
    .eq("protocol_id", interventionRow.protocol_id)
    .maybeSingle();

  if (originatingRequestError) throw originatingRequestError;

  if (!originatingRequest) {
    return {
      ...base,
      outcome: "intervention_not_ready",
      integrityStatus: "blocked",
      integrityReasons: ["The baseline protocol has no originating snapshot request — cannot read its subject."],
      detail: "No snapshot_requests row has protocol_id equal to this intervention's baseline.",
    };
  }

  const baselineEvidence = await readProtocolEvidence(
    deps.client,
    (originatingRequest as Record<string, any>).id as string
  );
  const baselinePayload = buildProtocolReport({ ...baselineEvidence, now: now() });

  const retestEvidence = await readRetestProtocolEvidence(
    deps.client,
    retestProtocolId,
    interventionRow.project_id,
    baselinePayload.subject
  );
  const retestPayload = buildProtocolReport({ ...retestEvidence, now: now() });

  const card = buildOutcomeCard({
    projectId: interventionRow.project_id,
    baseline: baselinePayload,
    retest: retestPayload,
    intervention: toInterventionSummary(interventionRow),
    minimumUsefulChange,
    detectableChangeAtPlan: baselineProto?.detectable_change_at_plan ?? null,
    now: now(),
  });
  const markdown = renderOutcomeCardMarkdown(card);

  const baselineMarkdown = renderProtocolReportMarkdown(baselinePayload);
  const retestMarkdown = renderProtocolReportMarkdown(retestPayload);
  const [baselineSignals, retestSignals] = await Promise.all([
    readIntegritySignals(deps.client, baselinePayload),
    readIntegritySignals(deps.client, retestPayload),
  ]);

  const integrity = evaluateOutcomeCardIntegrity({
    baselineMarkdown,
    baselineSignals,
    retestMarkdown,
    retestSignals,
    interventionRegisteredAndImplemented: interventionRow.status === "implemented",
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

  const recipient = await loadRecipientForProject(deps.client, interventionRow.project_id);
  if (!recipient) {
    return {
      ...heldWithArtifact,
      outcome: "delivery_rejected",
      detail: "No usable recipient address for this project.",
    };
  }

  const { data: revisionData, error: revisionError } = await deps.client.rpc(
    "outcome_card_artifact_revision",
    { p_markdown: markdown, p_payload: card }
  );
  if (revisionError) throw revisionError;
  const revision = revisionData as string;

  const { data: begun, error: beginError } = await deps.client.rpc("begin_outcome_card_delivery", {
    p_intervention_id: interventionId,
    p_expected_artifact_id: artifactId,
    p_expected_revision: revision,
  });

  if (beginError) throw beginError;

  const claim = (Array.isArray(begun) ? begun[0] : begun) as Record<string, any> | null;
  if (!claim) {
    return {
      ...heldWithArtifact,
      outcome: "delivery_claim_unavailable",
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
        publicToken,
        questionText: card.question.text,
        deliveryIdempotencyKey: `outcome-card:${interventionId}:${revision.slice(0, 32)}`,
      },
      deps.deliveryConfig
    );
    messageId = sent.messageId;
  } catch (sendError) {
    const code = sendError instanceof ClientReportDeliveryError ? sendError.code : "unknown";

    if (PROVEN_NON_DELIVERY.has(code)) {
      try {
        await deps.client.rpc("release_outcome_card_delivery_claim", {
          p_intervention_id: interventionId,
          p_artifact_id: artifactId,
          p_delivery_claim_token: claimToken,
        });
      } catch {
        // A failed release is never reported as released.
      }
      return {
        ...heldWithArtifact,
        outcome: "delivery_rejected",
        detail: `Provider refused before sending (${code}). Claim released; retry is safe.`,
      };
    }

    return {
      ...heldWithArtifact,
      outcome: "delivery_ambiguous",
      detail: `Delivery outcome unknown (${code}). Claim intentionally held to prevent a duplicate email.`,
    };
  }

  const { data: finalized, error: finalizeError } = await deps.client.rpc("finalize_outcome_card_delivery", {
    p_intervention_id: interventionId,
    p_artifact_id: artifactId,
    p_delivery_claim_token: claimToken,
    p_delivery_message_id: messageId,
  });

  if (finalizeError) throw finalizeError;

  const done = (Array.isArray(finalized) ? finalized[0] : finalized) as Record<string, any> | null;
  if (!done) {
    return {
      ...heldWithArtifact,
      outcome: "delivery_ambiguous",
      messageId,
      detail:
        "Email was accepted by the provider but the delivery record did not finalize. Reconcile manually before any resend.",
    };
  }

  return {
    ...held,
    outcome: "delivered",
    artifactId,
    publicToken,
    messageId,
  };
}
