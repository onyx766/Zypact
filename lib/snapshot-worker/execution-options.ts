/**
 * Execution options for a claimed snapshot request.
 *
 * A future worker claims a request and must decide, without an operator,
 * what the manual CLI decides through flags. This turns a claimed row into
 * the exact six-field contract `runApprovedSnapshot` consumes.
 *
 * It is deliberately pure: no database read, no network, no provider, no
 * filesystem access, no `process.env`. Everything it returns is either a
 * fixed server-side decision or derived from the claimed row. That matters
 * because it runs *before* any provider-capable work — resolution failing
 * closed is what keeps an unusable request from spending money.
 *
 * Nothing here claims, polls, renews a lease, or executes anything.
 */

import {
  MAX_COMPETITORS,
  MAX_COMPETITOR_LENGTH,
  MIN_COMPETITORS,
  normalizeCompetitorList,
} from "@/lib/snapshot-requests/competitors";
import type { SnapshotRequest } from "@/lib/db/types";
import type { ApprovedSnapshotExecutionOptions } from "@/lib/snapshot-engine/run-approved-snapshot";

/** Live probing. A worker-executed scan is never simulated. */
const WORKER_PROBE_MODE = "live" as const;

/**
 * Budget ceiling handed to `mvp-scan`.
 *
 * This is the existing *estimated-cost admission guard*: `mvp-scan` refuses
 * to start paid probes when its projected spend exceeds this number. It is
 * not a measured-spend circuit breaker — nothing halts a run that turns out
 * to cost more than projected. Do not describe it as a hard spend cap.
 */
const WORKER_BUDGET_USD = 2;

/**
 * Requested prompt ceiling, not a guarantee. Similarity deduplication in
 * prompt selection can yield fewer than this, which reduces sample size
 * rather than increasing spend.
 */
const WORKER_PROMPTS = 5;

/** Probe repetitions per selected prompt. Exact. */
const WORKER_RUNS = 3;

/** Matches the UUID validation the founder-facing routes already apply. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerExecutionOptionsErrorReason =
  /* Permanent request/input failures — a founder must fix the request. */
  | "competitors_not_an_array"
  | "competitor_not_a_string"
  | "competitors_below_minimum"
  | "competitors_above_maximum"
  | "competitor_too_long"
  /* Impossible-state failures — the claim RPC should prevent these. */
  | "request_not_running"
  | "request_project_missing"
  | "request_id_unsafe";

/**
 * Thrown for every resolution failure.
 *
 * Deliberately carries only a field name and a machine-readable reason, so
 * it is safe to log anywhere. It never echoes competitor values, company
 * name, domain, work email, website URL, project id, or any claim token —
 * the worker that logs this has no way to leak customer data through it.
 */
export class WorkerExecutionOptionsError extends Error {
  readonly reason: WorkerExecutionOptionsErrorReason;
  readonly field: string;

  constructor(reason: WorkerExecutionOptionsErrorReason, field: string) {
    super(`Worker execution options rejected (${reason}) for field ${field}.`);
    this.name = "WorkerExecutionOptionsError";
    this.reason = reason;
    this.field = field;
  }
}

/**
 * Deterministic, request-scoped output path.
 *
 * Identical to the derivation `scripts/run-approved-snapshot.ts` already
 * uses, so the artifact filenames the completion RPC stores are unchanged.
 * The id is UUID-validated first, which is what keeps a separator or `..`
 * out of the path — this only ever appends a validated segment.
 */
function outputPathFor(requestId: string): string {
  return `./exports/snapshots/${requestId}/mvp-scan.md`;
}

/**
 * Validates the stored competitor frame.
 *
 * Approval already enforced these rules, but the frame is re-validated
 * because rows predating migration 0034 hold `[]`, and because a resolver
 * that trusts its input has no way to stop a scan that cannot produce a
 * usable report. Normalization reuses the shared module so the worker
 * cannot drift from the approval contract.
 *
 * A refusal here is the only thing standing between an invalid frame and
 * `mvp-scan`'s hardcoded fallback list, which belongs to a different market
 * entirely. Nothing in this function substitutes a default.
 */
function resolveCompetitors(claimed: SnapshotRequest): string[] {
  const stored: unknown = claimed.competitors;

  if (!Array.isArray(stored)) {
    throw new WorkerExecutionOptionsError(
      "competitors_not_an_array",
      "competitors"
    );
  }

  if (stored.some((entry) => typeof entry !== "string")) {
    throw new WorkerExecutionOptionsError(
      "competitor_not_a_string",
      "competitors"
    );
  }

  // Returns a new array; the caller's stored array is never mutated.
  const competitors = normalizeCompetitorList(stored as string[]);

  if (competitors.length < MIN_COMPETITORS) {
    throw new WorkerExecutionOptionsError(
      "competitors_below_minimum",
      "competitors"
    );
  }

  if (competitors.length > MAX_COMPETITORS) {
    throw new WorkerExecutionOptionsError(
      "competitors_above_maximum",
      "competitors"
    );
  }

  if (
    competitors.some((value) => value.length > MAX_COMPETITOR_LENGTH)
  ) {
    throw new WorkerExecutionOptionsError(
      "competitor_too_long",
      "competitors"
    );
  }

  return competitors;
}

/**
 * Turns a claimed request into the engine's execution options.
 *
 * Throws `WorkerExecutionOptionsError` rather than returning a result
 * object: every caller must stop, and the existing engine guards already
 * signal failure by throwing.
 */
export function resolveWorkerExecutionOptions(
  claimed: SnapshotRequest
): ApprovedSnapshotExecutionOptions {
  // `claim_next_snapshot_request` sets `running` in the same statement that
  // reserves the project, so anything else means the caller did not hand us
  // a freshly claimed row.
  if (claimed.status !== "running") {
    throw new WorkerExecutionOptionsError(
      "request_not_running",
      "status"
    );
  }

  // The claim RPC guarantees a project, but a resolver that assumes it
  // would pass `null` into an engine that requires it.
  if (
    typeof claimed.projectId !== "string" ||
    claimed.projectId.trim() === ""
  ) {
    throw new WorkerExecutionOptionsError(
      "request_project_missing",
      "projectId"
    );
  }

  // Validated before the id is ever concatenated into a path.
  if (!UUID_PATTERN.test(claimed.id)) {
    throw new WorkerExecutionOptionsError(
      "request_id_unsafe",
      "id"
    );
  }

  return {
    competitors: resolveCompetitors(claimed),
    probeMode: WORKER_PROBE_MODE,
    budgetUsd: WORKER_BUDGET_USD,
    prompts: WORKER_PROMPTS,
    runs: WORKER_RUNS,
    out: outputPathFor(claimed.id),
  };
}
