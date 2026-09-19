/**
 * Server-side actions behind the founder review UI.
 *
 * Three things a reviewer needs, and nothing else:
 *   - see what state a request is in and why it is held;
 *   - resolve a job stuck on `needs_review`;
 *   - regenerate the report, and send it when they choose to.
 *
 * Delivery here is the same orchestrator the delivery worker runs, called
 * with sending switched on for this one request. A second delivery path would
 * eventually disagree with the first about the integrity gate, and the gate is
 * the whole point.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { publicSiteUrl } from "@/lib/seo/site";

import {
  processProtocolReport,
  type ProcessResult,
} from "@/lib/reports/deliver-protocol-report";

export type JobReviewResolution = "excluded_and_completed" | "failed";

export interface ReviewState {
  requestStatus: string | null;
  protocolId: string | null;
  job: {
    id: string;
    status: string;
    needsReviewReason: string | null;
    priorNeedsReviewReason: string | null;
    reviewResolution: string | null;
    reviewNote: string | null;
    reviewedAt: string | null;
    attemptCount: number | null;
  } | null;
  attempts: {
    ordinal: number | null;
    status: string;
    terminationReason: string | null;
  }[];
  artifact: {
    id: string;
    integrityStatus: string | null;
    integrityReasons: string[];
    publicToken: string;
    deliveredAt: string | null;
    generatedAt: string;
  } | null;
}

export async function loadReviewState(
  client: SupabaseClient,
  requestId: string
): Promise<ReviewState> {
  const { data: request } = await client
    .from("snapshot_requests")
    .select("status,protocol_id")
    .eq("id", requestId)
    .maybeSingle();

  const req = (request ?? null) as Record<string, any> | null;
  const protocolId = req?.protocol_id ?? null;

  let job: ReviewState["job"] = null;
  let attempts: ReviewState["attempts"] = [];

  if (protocolId) {
    const { data: jobRow } = await client
      .from("protocol_execution_jobs")
      .select(
        "id,status,needs_review_reason,prior_needs_review_reason,review_resolution,review_note,reviewed_at,attempt_count"
      )
      .eq("protocol_id", protocolId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (jobRow) {
      const j = jobRow as Record<string, any>;
      job = {
        id: j.id,
        status: j.status,
        needsReviewReason: j.needs_review_reason ?? null,
        priorNeedsReviewReason: j.prior_needs_review_reason ?? null,
        reviewResolution: j.review_resolution ?? null,
        reviewNote: j.review_note ?? null,
        reviewedAt: j.reviewed_at ?? null,
        attemptCount: j.attempt_count ?? null,
      };
    }

    const { data: attemptRows } = await client
      .from("protocol_attempts")
      .select("baseline_ordinal,status,termination_reason")
      .eq("protocol_id", protocolId)
      .order("created_at", { ascending: true });

    attempts = (attemptRows ?? []).map((row: Record<string, any>) => ({
      ordinal: row.baseline_ordinal ?? null,
      status: row.status,
      terminationReason: row.termination_reason ?? null,
    }));
  }

  const { data: artifactRow } = await client
    .from("snapshot_report_artifacts")
    .select(
      "id,integrity_status,integrity_reasons,public_token,delivered_at,generated_at"
    )
    .eq("snapshot_request_id", requestId)
    .maybeSingle();

  const a = (artifactRow ?? null) as Record<string, any> | null;

  return {
    requestStatus: req?.status ?? null,
    protocolId,
    job,
    attempts,
    artifact: a
      ? {
          id: a.id,
          integrityStatus: a.integrity_status ?? null,
          integrityReasons: Array.isArray(a.integrity_reasons)
            ? a.integrity_reasons
            : [],
          publicToken: a.public_token,
          deliveredAt: a.delivered_at ?? null,
          generatedAt: a.generated_at,
        }
      : null,
  };
}

export async function resolveJobReview(
  client: SupabaseClient,
  input: {
    requestId: string;
    jobId: string;
    reviewedBy: string;
    resolution: JobReviewResolution;
    note: string;
  }
): Promise<{ ok: true; jobStatus: string } | { ok: false; error: string }> {
  const { data: job } = await client
    .from("protocol_execution_jobs")
    .select("id,project_id,status")
    .eq("id", input.jobId)
    .maybeSingle();

  const row = (job ?? null) as Record<string, any> | null;

  if (!row) return { ok: false, error: "Job not found." };

  if (row.status !== "needs_review") {
    return {
      ok: false,
      error: `Job is '${row.status}', not 'needs_review'. Only a job awaiting review can be resolved.`,
    };
  }

  const { data, error } = await client.rpc("resolve_protocol_job_review", {
    p_job_id: input.jobId,
    p_project_id: row.project_id,
    p_reviewed_by: input.reviewedBy,
    p_resolution: input.resolution,
    p_note: input.note,
  });

  if (error) return { ok: false, error: error.message };

  const resolved = (Array.isArray(data) ? data[0] : data) as
    | Record<string, any>
    | null;

  if (!resolved) {
    return { ok: false, error: "Resolution was refused." };
  }

  return { ok: true, jobStatus: resolved.status };
}

export async function regenerateReport(
  client: SupabaseClient,
  requestId: string,
  options: { send: boolean }
): Promise<ProcessResult> {
  // Same origin as every other customer-email path (lib/seo/site.ts).
  const appBaseUrl = publicSiteUrl();
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const from = process.env.SNAPSHOT_EMAIL_FROM ?? "";

  if (options.send && (!apiKey || !from)) {
    throw new Error(
      "Delivery configuration is incomplete: RESEND_API_KEY and SNAPSHOT_EMAIL_FROM are both required to send."
    );
  }

  return processProtocolReport(requestId, {
    client,
    // A founder pressing Send is the human in the loop, so this does not
    // consult SNAPSHOT_AUTO_DELIVERY_ENABLED — that flag governs unattended
    // sending by the worker, not an explicit action taken here.
    autoSendEnabled: options.send,
    deliveryConfig: { apiKey, from, appBaseUrl },
  });
}
