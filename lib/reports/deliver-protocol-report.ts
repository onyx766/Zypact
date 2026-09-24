/**
 * Turns a succeeded protocol job into a reviewed, optionally delivered report.
 *
 *   read evidence → build payload → derive integrity → persist → maybe send
 *
 * The integrity decision gates delivery, with the canonical rules:
 *   integrity_passed — may deliver automatically;
 *   needs_review     — persisted and held for a founder;
 *   blocked          — persisted for review, never delivered, never rendered.
 *
 * Auto-send is additionally gated on explicit configuration. A passing
 * integrity check means delivery is *permitted*, not that this deployment has
 * chosen to mail customers without a human in the loop.
 *
 * Delivery follows the same BEGIN → PROVIDER → FINALIZE fencing as the
 * founder-initiated path, including its asymmetry: the claim is released only
 * where non-delivery is PROVEN. An ambiguous provider outcome leaves the claim
 * held, because the alternative is emailing a customer twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateReportIntegrity,
  type ReportIntegrityCheckInput,
  type ReportIntegrityResult,
} from "@/lib/export/report-integrity";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import { readProtocolEvidence } from "@/lib/reports/read-protocol-evidence";
import { readIntegritySignals } from "@/lib/reports/protocol-integrity-signals";
import {
  renderProtocolReportMarkdown,
  renderProtocolShortReportMarkdown,
} from "@/lib/reports/render-protocol-report-markdown";
import { sendProtocolReportEmail } from "@/lib/reports/protocol-report-email";
import { snapshotReportArtifactRevision } from "@/lib/snapshot-requests/report-artifact-revision";
import { ClientReportDeliveryError, type ClientReportDeliveryConfig } from "@/lib/snapshot-requests/client-report-delivery";
import type { ProtocolReportPayload } from "@/lib/reports/protocol-report-types";

export type DeliveryOutcome =
  | "delivered"
  | "held_needs_review"
  | "held_blocked"
  | "held_auto_send_disabled"
  | "already_delivered"
  | "persist_refused"
  | "delivery_claim_unavailable"
  | "delivery_ambiguous"
  | "delivery_rejected";

export interface ProcessResult {
  snapshotRequestId: string;
  outcome: DeliveryOutcome;
  integrityStatus: string;
  integrityReasons: string[];
  artifactId: string | null;
  publicToken: string | null;
  messageId: string | null;
  detail?: string;
}

export interface ProcessDeps {
  client: SupabaseClient;
  /** False keeps the whole pipeline dry: build, classify, persist, stop. */
  autoSendEnabled: boolean;
  deliveryConfig: ClientReportDeliveryConfig;
  now?: () => Date;
  sendEmail?: typeof sendProtocolReportEmail;
}

/**
 * Errors that prove the provider never accepted the message. Only these
 * permit releasing the claim; everything else — a timeout, an unreachable
 * host, an unreadable response — may have been delivered.
 */
const PROVEN_NON_DELIVERY = new Set([
  "missing_api_key",
  "missing_from_address",
  "invalid_recipient",
  "invalid_idempotency_key",
  "invalid_public_token",
  "provider_rejected",
]);

async function loadRecipient(
  client: SupabaseClient,
  snapshotRequestId: string
): Promise<{ workEmail: string; companyName: string } | null> {
  const { data, error } = await client
    .from("snapshot_requests")
    .select("work_email,company_name")
    .eq("id", snapshotRequestId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as Record<string, any>;
  if (typeof row.work_email !== "string" || !row.work_email.includes("@")) {
    return null;
  }

  return { workEmail: row.work_email, companyName: row.company_name };
}

/**
 * Both bodies are stored and either can be read, so both pass the gate. A
 * `blocked` body blocks the artifact; otherwise the non-markdown signals,
 * which are the same for both, decide.
 */
export function evaluateArtifactIntegrity(
  fullMarkdown: string,
  shortMarkdown: string,
  signals: Omit<ReportIntegrityCheckInput, "markdown">
): ReportIntegrityResult {
  const full = evaluateReportIntegrity({ markdown: fullMarkdown, ...signals });
  if (full.status === "blocked") return full;
  return evaluateReportIntegrity({ markdown: shortMarkdown, ...signals });
}

export async function processProtocolReport(
  snapshotRequestId: string,
  deps: ProcessDeps
): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());

  const evidence = await readProtocolEvidence(
    deps.client,
    snapshotRequestId
  );
  const payload = buildProtocolReport({ ...evidence, now: now() });
  const markdown = renderProtocolReportMarkdown(payload);
  const shortMarkdown = renderProtocolShortReportMarkdown(payload);

  const signals = await readIntegritySignals(deps.client, payload);
  const integrity = evaluateArtifactIntegrity(
    markdown,
    shortMarkdown,
    signals
  );

  const stamp = payload.generatedAt.replace(/[:.]/g, "-");

  const { data, error } = await deps.client.rpc(
    "save_protocol_report_artifact",
    {
      p_request_id: payload.snapshotRequestId,
      p_project_id: payload.projectId,
      p_full_markdown: markdown,
      p_short_markdown: shortMarkdown,
      p_full_filename: `protocol-report-${stamp}.md`,
      p_short_filename: `protocol-report-short-${stamp}.md`,
      p_generated_at: payload.generatedAt,
      p_payload: payload,
      p_integrity_status: integrity.status,
      p_integrity_reasons: integrity.reasons,
    }
  );

  if (error) throw error;

  const artifact = (Array.isArray(data) ? data[0] : data) as
    | Record<string, any>
    | null;

  const base = {
    snapshotRequestId,
    integrityStatus: integrity.status,
    integrityReasons: integrity.reasons,
  };

  if (!artifact) {
    // The RPC refuses a delivered artifact, a non-approved request, or a job
    // that has not succeeded. All three are correct refusals, not errors.
    return {
      ...base,
      outcome: "persist_refused",
      artifactId: null,
      publicToken: null,
      messageId: null,
      detail:
        "Save refused: request must be approved, carry a protocol, have a succeeded job, and not already be delivered.",
    };
  }

  const artifactId = artifact.id as string;
  const publicToken = artifact.public_token as string;

  const held = {
    ...base,
    artifactId,
    publicToken,
    messageId: null,
  };

  if (integrity.status === "blocked") {
    return { ...held, outcome: "held_blocked" };
  }
  if (integrity.status === "needs_review") {
    return { ...held, outcome: "held_needs_review" };
  }
  if (!deps.autoSendEnabled) {
    return { ...held, outcome: "held_auto_send_disabled" };
  }
  if (artifact.delivered_at) {
    return { ...held, outcome: "already_delivered" };
  }

  // Recipient is loaded BEFORE the claim, so a missing address cannot orphan
  // a held claim.
  const recipient = await loadRecipient(deps.client, snapshotRequestId);

  if (!recipient) {
    return {
      ...held,
      outcome: "delivery_rejected",
      detail: "No usable recipient address on the request.",
    };
  }

  const revision = snapshotReportArtifactRevision(markdown, shortMarkdown);

  const { data: begun, error: beginError } = await deps.client.rpc(
    "begin_snapshot_report_delivery",
    {
      p_snapshot_request_id: snapshotRequestId,
      p_expected_artifact_id: artifactId,
      p_expected_revision: revision,
    }
  );

  if (beginError) throw beginError;

  const claim = (Array.isArray(begun) ? begun[0] : begun) as
    | Record<string, any>
    | null;

  if (!claim) {
    return {
      ...held,
      outcome: "delivery_claim_unavailable",
      detail:
        "Delivery claim refused: the artifact changed, is already delivered, or a claim is held.",
    };
  }

  const claimToken = claim.delivery_claim_token as string;
  const send = deps.sendEmail ?? sendProtocolReportEmail;

  let messageId: string;

  try {
    const sent = await send(
      {
        to: recipient.workEmail,
        companyName: recipient.companyName,
        publicToken,
        questionText: payload.question.text,
        // Bound to the revision, so a regenerated report is a new generation
        // to the provider rather than being deduplicated against the old one.
        deliveryIdempotencyKey: `protocol:${snapshotRequestId}:${revision.slice(0, 32)}`,
      },
      deps.deliveryConfig
    );
    messageId = sent.messageId;
  } catch (sendError) {
    const code =
      sendError instanceof ClientReportDeliveryError
        ? sendError.code
        : "unknown";

    if (PROVEN_NON_DELIVERY.has(code)) {
      // Provably never accepted: hand the claim back so a retry is possible.
      try {
        await deps.client.rpc(
          "release_snapshot_report_delivery_claim",
          {
            p_snapshot_request_id: snapshotRequestId,
            p_artifact_id: artifactId,
            p_delivery_claim_token: claimToken,
          }
        );
      } catch {
        // A failed release is never reported as released.
      }

      return {
        ...held,
        outcome: "delivery_rejected",
        detail: `Provider refused before sending (${code}). Claim released; retry is safe.`,
      };
    }

    return {
      ...held,
      outcome: "delivery_ambiguous",
      detail: `Delivery outcome unknown (${code}). Claim intentionally held to prevent a duplicate email.`,
    };
  }

  const { data: finalized, error: finalizeError } = await deps.client.rpc(
    "finalize_snapshot_report_delivery",
    {
      p_snapshot_request_id: snapshotRequestId,
      p_artifact_id: artifactId,
      p_delivery_claim_token: claimToken,
      p_delivery_message_id: messageId,
    }
  );

  if (finalizeError) throw finalizeError;

  const done = (Array.isArray(finalized) ? finalized[0] : finalized) as
    | Record<string, any>
    | null;

  if (!done) {
    // The email went out but the record did not close. Reported as ambiguous
    // so a human reconciles it; retrying would risk a second email.
    return {
      ...held,
      outcome: "delivery_ambiguous",
      messageId,
      detail:
        "Email was accepted by the provider but the delivery record did not finalize. Reconcile manually before any resend.",
    };
  }

  return {
    ...base,
    outcome: "delivered",
    artifactId,
    publicToken,
    messageId,
  };
}

/**
 * Snapshot requests whose protocol job has succeeded and whose report has not
 * been delivered yet.
 */
export async function findDeliverableRequests(
  client: SupabaseClient,
  limit = 25
): Promise<string[]> {
  const { data: jobs, error } = await client
    .from("protocol_execution_jobs")
    .select("protocol_id")
    .eq("status", "succeeded")
    .limit(500);

  if (error) throw error;

  const protocolIds = (jobs ?? [])
    .map((row: Record<string, any>) => row.protocol_id)
    .filter((id: unknown): id is string => typeof id === "string");

  if (protocolIds.length === 0) return [];

  // Both states, since 0080: saving a report moves a request to
  // 'report_ready' (or keeps it 'approved' when the report is blocked). A
  // query for 'approved' alone would lose every request the moment its
  // first report was saved, and a saved-but-undelivered report is exactly
  // the case this worker exists to finish.
  const { data: requests, error: requestError } = await client
    .from("snapshot_requests")
    .select("id,protocol_id,status")
    .in("protocol_id", protocolIds)
    .in("status", ["approved", "report_ready"])
    .limit(limit * 4);

  if (requestError) throw requestError;

  const candidateIds = (requests ?? []).map(
    (row: Record<string, any>) => row.id as string
  );

  if (candidateIds.length === 0) return [];

  const { data: delivered, error: deliveredError } = await client
    .from("snapshot_report_artifacts")
    .select("snapshot_request_id,delivered_at")
    .in("snapshot_request_id", candidateIds);

  if (deliveredError) throw deliveredError;

  const deliveredIds = new Set(
    (delivered ?? [])
      .filter((row: Record<string, any>) => row.delivered_at)
      .map((row: Record<string, any>) => row.snapshot_request_id as string)
  );

  return candidateIds
    .filter((id) => !deliveredIds.has(id))
    .slice(0, limit);
}

export type { ProtocolReportPayload };
