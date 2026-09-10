/**
 * Derives the M4 integrity preconditions from stored protocol evidence.
 *
 * `lib/export/report-integrity.ts` takes these as booleans and its comments
 * say they are "always false today — no protocol concept exists anywhere in
 * this codebase yet", anticipating that "a future M4 caller wires its own
 * real signals into these same fields". This is that caller.
 *
 * Every signal is COMPUTED from the evidence, never asserted by the caller.
 * A missing or unreadable field yields `false`, so an incomplete scan fails
 * closed into needs_review instead of passing on an assumption.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ProtocolReportPayload,
} from "@/lib/reports/protocol-report-types";

export interface ProtocolIntegritySignals {
  hasApprovedProtocol: boolean;
  hasApprovedSamplePlan: boolean;
  hasPaidCallReservation: boolean;
  hasCompleteEvidenceHashes: boolean;
}

/**
 * Rows the signals are computed over. Fetched separately from the report
 * payload on purpose: the payload is what the client is told, and an
 * integrity check that only inspected the payload could never notice a field
 * the payload chose not to carry.
 */
interface IntegrityRows {
  protocolStatus: string | null;
  plannedBaselineRuns: number | null;
  paraphrasePlanCount: number;
  samplePlanningMethod: string | null;
  questionApprovedAt: string | null;
  /** One entry per attempt that is counted in the report. */
  reservations: (number | null)[];
  /** One entry per probe result behind a counted attempt. */
  evidence: {
    rawResponseSha256: string | null;
    rawProbeRequestSha256: string | null;
    /** Generated column: 'captured' | 'legacy_hash_only' | 'absent'. */
    fullRequestBodyCapture: string | null;
  }[];
  countedAttempts: number;
}

async function loadIntegrityRows(
  client: SupabaseClient,
  payload: ProtocolReportPayload
): Promise<IntegrityRows> {
  const { data: protocol } = await client
    .from("protocols")
    .select(
      "status,planned_baseline_runs,paraphrase_plan,sample_planning_method,buyer_question_version_id"
    )
    .eq("id", payload.protocol.id)
    .maybeSingle();

  const proto = (protocol ?? {}) as Record<string, any>;

  const { data: version } = await client
    .from("buyer_question_versions")
    .select("approved_at")
    .eq("id", proto.buyer_question_version_id ?? "")
    .maybeSingle();

  const { data: attempts } = await client
    .from("protocol_attempts")
    .select("id,status,reserved_cost_usd,probe_run_id")
    .eq("protocol_id", payload.protocol.id);

  // Only attempts that contribute an observation are checked. An excluded or
  // failed attempt has no result to hash, and demanding one would hold every
  // partially-failed scan for review forever.
  const counted = (attempts ?? []).filter(
    (row: Record<string, any>) => row.status === "completed"
  );

  const probeRunIds = counted
    .map((row: Record<string, any>) => row.probe_run_id)
    .filter((id: unknown): id is string => typeof id === "string");

  let evidence: IntegrityRows["evidence"] = [];

  if (probeRunIds.length > 0) {
    const { data: results } = await client
      .from("probe_results")
      .select(
        "raw_response_sha256,raw_probe_request_sha256,full_request_body_capture"
      )
      .in("probe_run_id", probeRunIds);

    evidence = (results ?? []).map((row: Record<string, any>) => ({
      rawResponseSha256: row.raw_response_sha256 ?? null,
      rawProbeRequestSha256: row.raw_probe_request_sha256 ?? null,
      fullRequestBodyCapture: row.full_request_body_capture ?? null,
    }));
  }

  return {
    protocolStatus: proto.status ?? null,
    plannedBaselineRuns: proto.planned_baseline_runs ?? null,
    paraphrasePlanCount: Array.isArray(proto.paraphrase_plan)
      ? proto.paraphrase_plan.length
      : 0,
    samplePlanningMethod: proto.sample_planning_method ?? null,
    questionApprovedAt:
      (version as Record<string, any> | null)?.approved_at ?? null,
    reservations: counted.map(
      (row: Record<string, any>) => row.reserved_cost_usd ?? null
    ),
    evidence,
    countedAttempts: counted.length,
  };
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmptyHash(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveIntegritySignals(
  rows: IntegrityRows
): ProtocolIntegritySignals {
  const hasApprovedProtocol =
    rows.protocolStatus === "approved" &&
    nonEmptyHash(rows.questionApprovedAt);

  const hasApprovedSamplePlan =
    isPositive(rows.plannedBaselineRuns) &&
    rows.paraphrasePlanCount > 0 &&
    nonEmptyHash(rows.samplePlanningMethod);

  // Every counted attempt must carry its own reservation. A single attempt
  // without one means a paid call happened outside admission control, which
  // is precisely what this precondition exists to detect.
  const hasPaidCallReservation =
    rows.countedAttempts > 0 &&
    rows.reservations.length === rows.countedAttempts &&
    rows.reservations.every(isPositive);

  // Both directions of the exchange must be hashed, for every counted
  // attempt: a response hash alone cannot prove what was asked.
  //
  // The request side is `raw_probe_request_sha256`, which is the M1 contract
  // `report-integrity.ts` documents ("a request/response hash present").
  // `full_request_body_sha256` is deliberately NOT required here — it belongs
  // to M1-A (migration 0055), a strictly stronger level where the exact
  // outbound body is retained and hash-verified. The generated
  // `full_request_body_capture` column reports which level a row reached, and
  // the current protocol worker records `absent` on every row, so requiring
  // M1-A would hold every report for review until the worker is changed.
  // That is a scope decision, not something to smuggle in through a gate.
  const hasCompleteEvidenceHashes =
    rows.countedAttempts > 0 &&
    rows.evidence.length === rows.countedAttempts &&
    rows.evidence.every(
      (row) =>
        nonEmptyHash(row.rawResponseSha256) &&
        nonEmptyHash(row.rawProbeRequestSha256)
    );

  return {
    hasApprovedProtocol,
    hasApprovedSamplePlan,
    hasPaidCallReservation,
    hasCompleteEvidenceHashes,
  };
}

export async function readIntegritySignals(
  client: SupabaseClient,
  payload: ProtocolReportPayload
): Promise<ProtocolIntegritySignals> {
  return deriveIntegritySignals(
    await loadIntegrityRows(client, payload)
  );
}

/** Exported for tests, which construct rows directly. */
export type { IntegrityRows };
