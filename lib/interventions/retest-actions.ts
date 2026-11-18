/**
 * Phase 4 — creating and queueing an intervention's retest, and reading its
 * progress.
 *
 * Service-role client, so every caller must have passed the founder guard.
 * Same rules as intervention-actions.ts: project identity from the stored
 * row, never the request; a named outcome is mapped explicitly, never read
 * as success by default.
 *
 * Two separate steps, on purpose. Creating the retest protocol commits the
 * measurement design; queueing its job commits the spend (the worker picks
 * it up and makes paid provider calls). Keeping them apart lets the founder
 * cross each line deliberately.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  mapCreateRetestOutcome,
  mapRpcError,
  type MappedRpcFailure,
} from "@/lib/interventions/rpc-errors";
import { readIntervention } from "@/lib/interventions/intervention-actions";
import { PILOT_MEMBER_FAILURE, pilotMemberInterventionIds } from "@/lib/interventions/pilot-exclusions";

type OnUnmapped = (detail: { code: string | null; message: string | null }) => void;

const NOT_FOUND: MappedRpcFailure = { status: 404, error: "not_found", message: "That intervention was not found." };

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export interface RetestProtocolRef {
  id: string;
  status: string;
  plannedRuns: number | null;
  createdAt: string | null;
}

/**
 * The intervention's retest protocol: its baseline's one non-abandoned
 * retest. Exact because 0079 allows at most one per baseline, and 0077
 * guarantees an abandoned one observed nothing. Same rule
 * deliver-outcome-card.ts uses, so the two can never disagree.
 */
export async function findRetestProtocol(
  client: SupabaseClient,
  intervention: { projectId: string; protocolId: string }
): Promise<RetestProtocolRef | null> {
  const { data, error } = await client
    .from("protocols")
    .select("id,status,planned_baseline_runs,created_at")
    .eq("project_id", intervention.projectId)
    .eq("baseline_protocol_id", intervention.protocolId)
    .neq("status", "abandoned")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id),
    status: String(r.status),
    // 0073 stores a retest's planned count in planned_baseline_runs — the
    // column the slot machinery reads — whichever phase the protocol is.
    plannedRuns: typeof r.planned_baseline_runs === "number" ? r.planned_baseline_runs : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
  };
}

// ---------------------------------------------------------------------------
// 1. create the retest protocol
// ---------------------------------------------------------------------------

export type CreateRetestResult =
  | { ok: true; retestProtocolId: string; replayed: boolean }
  | { ok: false; failure: MappedRpcFailure };

export async function createRetest(
  client: SupabaseClient,
  interventionId: string,
  actor: string,
  onUnmapped?: OnUnmapped
): Promise<CreateRetestResult> {
  const iv = await readIntervention(client, interventionId);
  if (!iv) return { ok: false, failure: NOT_FOUND };
  // D-062 — a pilot member's retest is prepared on its pilot page.
  if ((await pilotMemberInterventionIds(client, [interventionId])).has(interventionId)) return { ok: false, failure: PILOT_MEMBER_FAILURE };

  // Eligibility is NOT re-checked here. create_retest_protocol calls 0072's
  // retest_eligibility itself — the single authority — and returns its
  // reason as the outcome when it refuses.
  const { data, error } = await client.rpc("create_retest_protocol", {
    p_intervention_id: interventionId,
    p_project_id: iv.projectId,
    p_approved_by: actor,
  });
  if (error) return { ok: false, failure: mapRpcError(error, onUnmapped) };

  const row = firstRow(data);
  const statusCode = typeof row?.status_code === "string" ? row.status_code : "";
  const mapped = mapCreateRetestOutcome(statusCode);
  if (!mapped.ok) {
    if (mapped.failure.error === "internal_error") {
      onUnmapped?.({ code: null, message: `create_retest_protocol outcome: ${statusCode || "(none)"}` });
    }
    return { ok: false, failure: mapped.failure };
  }

  const retestProtocolId = typeof row?.retest_protocol_id === "string" ? row.retest_protocol_id : null;
  if (!retestProtocolId) {
    onUnmapped?.({ code: null, message: `create_retest_protocol ${statusCode} returned no protocol id` });
    return {
      ok: false,
      failure: { status: 500, error: "internal_error", message: "Something went wrong. Nothing was run." },
    };
  }
  return { ok: true, retestProtocolId, replayed: mapped.replayed };
}

// ---------------------------------------------------------------------------
// 2. queue the retest run
// ---------------------------------------------------------------------------

export type QueueRetestResult =
  | { ok: true; jobId: string | null; jobStatus: string | null; replayed: boolean }
  | { ok: false; failure: MappedRpcFailure };

export async function queueRetestRun(
  client: SupabaseClient,
  interventionId: string,
  onUnmapped?: OnUnmapped
): Promise<QueueRetestResult> {
  const iv = await readIntervention(client, interventionId);
  if (!iv) return { ok: false, failure: NOT_FOUND };
  // D-062 — a pilot member's retest is queued on its pilot page.
  if ((await pilotMemberInterventionIds(client, [interventionId])).has(interventionId)) return { ok: false, failure: PILOT_MEMBER_FAILURE };

  if (iv.status !== "implemented") {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "intervention_not_implemented",
        message: `This intervention is '${iv.status}', so there is no retest to run.`,
      },
    };
  }

  const retest = await findRetestProtocol(client, iv);
  if (!retest) {
    return {
      ok: false,
      failure: { status: 409, error: "no_retest_protocol", message: "Create the retest protocol before queueing its run." },
    };
  }

  // The same RPC and the same default max_attempts the baseline path uses
  // (0069 calls it without p_max_attempts), so the two phases cannot drift
  // apart. Idempotent per protocol: a second call returns ALREADY_EXISTS
  // with the existing job and spends nothing.
  const { data, error } = await client.rpc("enqueue_protocol_execution_job", {
    p_protocol_id: retest.id,
    p_project_id: iv.projectId,
  });
  if (error) return { ok: false, failure: mapRpcError(error, onUnmapped) };

  const row = firstRow(data);
  const outcome = typeof row?.status === "string" ? row.status : "";
  const job = (row?.job ?? null) as Record<string, unknown> | null;
  const jobId = job && typeof job.id === "string" ? job.id : null;
  const jobStatus = job && typeof job.status === "string" ? job.status : null;

  switch (outcome) {
    case "QUEUED":
      return { ok: true, jobId, jobStatus, replayed: false };
    case "ALREADY_EXISTS":
      return { ok: true, jobId, jobStatus, replayed: true };
    case "PROTOCOL_NOT_FOUND":
      return { ok: false, failure: { status: 404, error: "retest_protocol_not_found", message: "The retest protocol was not found." } };
    case "PROTOCOL_NOT_APPROVED":
      return { ok: false, failure: { status: 409, error: "retest_not_approved", message: "The retest protocol is not approved, so it cannot run." } };
    case "NO_BASELINE_RUNS_PLANNED":
      return { ok: false, failure: { status: 409, error: "retest_has_no_plan", message: "The retest protocol plans no runs." } };
    default:
      onUnmapped?.({ code: null, message: `enqueue_protocol_execution_job outcome: ${outcome || "(none)"}` });
      return { ok: false, failure: { status: 500, error: "internal_error", message: "Something went wrong. Nothing was queued." } };
  }
}

// ---------------------------------------------------------------------------
// 3. progress
// ---------------------------------------------------------------------------

export interface RetestProgress {
  protocol: RetestProtocolRef;
  job: {
    id: string;
    status: string;
    attemptCount: number;
    maxAttempts: number | null;
    needsReviewReason: string | null;
    failureReason: string | null;
    updatedAt: string | null;
  } | null;
  attempts: {
    total: number;
    byStatus: Record<string, number>;
    /**
     * Counted rather than assumed. 0074's trigger requires every attempt on a
     * retest protocol to be `retest`, so anything else here means that
     * invariant was bypassed — shown, never hidden.
     */
    byKind: Record<string, number>;
  };
}

export async function readRetestProgress(
  client: SupabaseClient,
  intervention: { projectId: string; protocolId: string }
): Promise<RetestProgress | null> {
  const protocol = await findRetestProtocol(client, intervention);
  if (!protocol) return null;

  const [jobRes, attemptRes] = await Promise.all([
    client
      .from("protocol_execution_jobs")
      .select("id,status,attempt_count,max_attempts,needs_review_reason,failure_reason,updated_at")
      .eq("protocol_id", protocol.id)
      .maybeSingle(),
    client.from("protocol_attempts").select("status,attempt_kind").eq("protocol_id", protocol.id),
  ]);
  if (jobRes.error) throw jobRes.error;
  if (attemptRes.error) throw attemptRes.error;

  const j = jobRes.data as Record<string, unknown> | null;
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const rows = (attemptRes.data ?? []) as Array<Record<string, unknown>>;
  for (const a of rows) {
    const s = String(a.status);
    const k = String(a.attempt_kind);
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }

  return {
    protocol,
    job: j
      ? {
          id: String(j.id),
          status: String(j.status),
          attemptCount: typeof j.attempt_count === "number" ? j.attempt_count : 0,
          maxAttempts: typeof j.max_attempts === "number" ? j.max_attempts : null,
          needsReviewReason: typeof j.needs_review_reason === "string" ? j.needs_review_reason : null,
          failureReason: typeof j.failure_reason === "string" ? j.failure_reason : null,
          updatedAt: typeof j.updated_at === "string" ? j.updated_at : null,
        }
      : null,
    attempts: { total: rows.length, byStatus, byKind },
  };
}
