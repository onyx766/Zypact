/**
 * Phase 5 — the founder's Outcome Card actions: generate, read, send.
 *
 * Generation reuses processOutcomeCard, the same build + integrity + persist
 * pipeline the scheduled worker runs, with auto-send forced off: a founder
 * click never emails a customer as a side effect. Sending is a separate,
 * explicit step that goes through deliverSavedOutcomeCard — the one function
 * that emails a customer a card, shared with the worker.
 *
 * Service-role client, so every caller must have passed the founder guard.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientReportDeliveryConfig } from "@/lib/snapshot-requests/client-report-delivery";
import {
  deliverSavedOutcomeCard,
  processOutcomeCard,
  type OutcomeCardProcessDeps,
  type OutcomeCardProcessResult,
} from "@/lib/reports/deliver-outcome-card";
import { isOutcomeCardPayload, type OutcomeCardPayload } from "@/lib/reports/outcome-card-types";
import type { MappedRpcFailure } from "@/lib/interventions/rpc-errors";
import type { RouteFailure } from "@/lib/interventions/route-guard";
import { readIntervention } from "@/lib/interventions/intervention-actions";
import { readRetestProgress } from "@/lib/interventions/retest-actions";

export interface StoredOutcomeCard {
  artifactId: string;
  publicToken: string;
  integrityStatus: "integrity_passed" | "needs_review" | "blocked" | string;
  integrityReasons: string[];
  generatedAt: string | null;
  deliveredAt: string | null;
  deliveryMessageId: string | null;
  deliveryClaimedAt: string | null;
  /** Null when the stored payload is not a shape this code can render. */
  payload: OutcomeCardPayload | null;
  /**
   * outcome_card_artifact_revision() of the stored content. The review screen
   * carries this to the send route, which refuses unless it still matches —
   * so what is sent is exactly what was reviewed.
   */
  revision: string;
}

export async function readOutcomeCard(
  client: SupabaseClient,
  interventionId: string
): Promise<StoredOutcomeCard | null> {
  const { data, error } = await client
    .from("outcome_card_artifacts")
    .select(
      "id,public_token,markdown,payload,integrity_status,integrity_reasons,generated_at,delivered_at,delivery_message_id,delivery_claimed_at"
    )
    .eq("intervention_id", interventionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as Record<string, unknown>;

  const { data: revision, error: revError } = await client.rpc("outcome_card_artifact_revision", {
    p_markdown: r.markdown,
    p_payload: r.payload,
  });
  if (revError) throw revError;

  return {
    artifactId: String(r.id),
    publicToken: String(r.public_token),
    integrityStatus: String(r.integrity_status),
    integrityReasons: Array.isArray(r.integrity_reasons)
      ? r.integrity_reasons.filter((x): x is string => typeof x === "string")
      : [],
    generatedAt: typeof r.generated_at === "string" ? r.generated_at : null,
    deliveredAt: typeof r.delivered_at === "string" ? r.delivered_at : null,
    deliveryMessageId: typeof r.delivery_message_id === "string" ? r.delivery_message_id : null,
    deliveryClaimedAt: typeof r.delivery_claimed_at === "string" ? r.delivery_claimed_at : null,
    payload: isOutcomeCardPayload(r.payload) ? r.payload : null,
    revision: String(revision),
  };
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

export type GenerateResult =
  | { ok: true; result: OutcomeCardProcessResult }
  | { ok: false; failure: MappedRpcFailure };

export async function generateOutcomeCard(
  client: SupabaseClient,
  interventionId: string,
  process: typeof processOutcomeCard = processOutcomeCard
): Promise<GenerateResult> {
  const iv = await readIntervention(client, interventionId);
  if (!iv) return { ok: false, failure: { status: 404, error: "not_found", message: "That intervention was not found." } };

  // The worker only builds a card once the retest job has SUCCEEDED
  // (findDeliverableInterventions). processOutcomeCard itself does not check
  // this, so a founder button calling it directly could build a card from a
  // half-finished retest. The same precondition is enforced here.
  const progress = await readRetestProgress(client, iv);
  if (!progress || progress.job?.status !== "succeeded") {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "retest_not_finished",
        message: progress?.job
          ? `The retest job is '${progress.job.status}'. A card is built only from a finished retest.`
          : "There is no finished retest to compare against yet.",
      },
    };
  }

  const deps: OutcomeCardProcessDeps = {
    client,
    // Forced off: generating is never also sending. The founder sends
    // explicitly, after reading the card.
    autoSendEnabled: false,
    // Unused while auto-send is off; present only to satisfy the type.
    deliveryConfig: { apiKey: "", from: "", appBaseUrl: "" },
  };
  const result = await process(interventionId, deps);

  if (result.outcome === "persist_refused") {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "persist_refused",
        message: "The card could not be saved: it is already delivered, or the intervention and retest no longer match.",
      },
    };
  }
  if (result.outcome === "intervention_not_ready") {
    return {
      ok: false,
      failure: { status: 409, error: "intervention_not_ready", message: result.detail ?? "This intervention is not ready for a card." },
    };
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

export interface SendInput {
  expectedArtifactId: string;
  expectedRevision: string;
  /** Required when the card is needs_review: the founder confirms they read it. */
  acknowledgeReview: boolean;
}

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; failure: RouteFailure };

export async function sendReviewedOutcomeCard(
  client: SupabaseClient,
  interventionId: string,
  input: SendInput,
  deliveryConfig: ClientReportDeliveryConfig,
  sendEmail?: OutcomeCardProcessDeps["sendEmail"]
): Promise<SendResult> {
  const iv = await readIntervention(client, interventionId);
  if (!iv) return { ok: false, failure: { status: 404, error: "not_found", message: "That intervention was not found." } };

  const card = await readOutcomeCard(client, interventionId);
  if (!card) {
    return { ok: false, failure: { status: 409, error: "no_card", message: "Generate the card before sending it." } };
  }

  // Refused before any claim, so a blocked card never holds one. 0076 also
  // refuses it in begin_outcome_card_delivery; this is the first of two gates.
  if (card.integrityStatus === "blocked") {
    return { ok: false, failure: { status: 409, error: "integrity_blocked", message: "This card is blocked and can never be delivered." } };
  }
  if (card.deliveredAt) {
    return { ok: false, failure: { status: 409, error: "already_delivered", message: "This card was already delivered." } };
  }
  if (card.integrityStatus === "needs_review" && !input.acknowledgeReview) {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "review_not_acknowledged",
        message: "This card needs review. Confirm you have read it and its flagged reasons before sending.",
      },
    };
  }
  if (card.integrityStatus !== "integrity_passed" && card.integrityStatus !== "needs_review") {
    return { ok: false, failure: { status: 409, error: "integrity_unknown", message: `Unrecognised integrity status '${card.integrityStatus}'.` } };
  }

  // Stale-review guard, before the claim. The database repeats it inside
  // begin_outcome_card_delivery, which is the authoritative check.
  if (card.artifactId !== input.expectedArtifactId || card.revision !== input.expectedRevision) {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "stale_review",
        message: "The card changed after you reviewed it. Reload and review the current version before sending.",
      },
    };
  }
  if (!card.payload) {
    return { ok: false, failure: { status: 409, error: "unrenderable_card", message: "The stored card is not in a shape that can be sent." } };
  }

  const delivery = await deliverSavedOutcomeCard(
    {
      interventionId,
      projectId: iv.projectId,
      baselineProtocolId: iv.protocolId,
      artifactId: card.artifactId,
      publicToken: card.publicToken,
      revision: input.expectedRevision,
      questionText: card.payload.question.text,
    },
    { client, deliveryConfig, sendEmail }
  );

  switch (delivery.outcome) {
    case "delivered":
      return { ok: true, messageId: delivery.messageId };
    case "delivery_rejected":
      return { ok: false, failure: { status: 502, error: "delivery_rejected", message: delivery.detail ?? "The email provider refused the message. Retrying is safe." } };
    case "delivery_ambiguous":
      return {
        ok: false,
        failure: {
          status: 502,
          error: "delivery_ambiguous",
          message:
            (delivery.detail ?? "The delivery outcome is unknown.") +
            " Do not resend until you have checked whether the customer received it.",
        },
      };
    default:
      return { ok: false, failure: { status: 409, error: delivery.outcome, message: delivery.detail ?? "The card could not be sent right now." } };
  }
}
