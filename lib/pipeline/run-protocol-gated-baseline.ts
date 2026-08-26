/**
 * M4 Stage B — the real, ledger-gated probe-call path.
 *
 * Unlike the legacy multi-prompt loop in scripts/mvp-scan.ts
 * (runMissingProbes), this runs exactly the ONE canonical prompt text
 * carried by an approved protocol's buyer_question_version, gated
 * through the M4 ledger before and after every live provider call:
 *
 *   admitAndReserveAttempt -> createProbeRun -> startAttempt ->
 *   provider call -> analyzeProbeResponse -> reconcileAttempt
 *
 * No DEFAULT_PROMPTS/DEFAULT_RUNS/DEFAULT_BUDGET_USD constant is read
 * here, and there is no silent fallback to 5 prompts, 3 runs, or a $2
 * budget: every count and every cap comes from the caller's
 * `plannedRuns` and the protocol's own admission rules, enforced
 * entirely inside `admitAndReserveAttempt`/`reconcileAttempt`.
 *
 * Cost semantics (Stage B item 2):
 *  - `reservationCeilingUsd` must be a conservative per-call CEILING,
 *    not an average estimate — the caller is responsible for supplying
 *    a value high enough that a single call's real cost only rarely
 *    exceeds it.
 *  - `actualCostUsd` is reconciled after every attempt regardless of
 *    outcome, even when it exceeds `reservationCeilingUsd` — the
 *    discrepancy is never hidden (see `reservationOverrunUsd`) and
 *    never retroactively "un-spent": once `reconcileAttempt` records a
 *    real cost, only a future admission can be blocked by it, never a
 *    past one undone.
 *
 * `generatedPromptId` is deliberately never set: an M4 protocol's
 * question lives in `buyer_question_versions`, not `generated_prompts`,
 * and probe_results.generated_prompt_id remains NULL for these runs
 * rather than being backfilled onto (or synthesized into) an unrelated
 * legacy table — Rule 16, no fabricated linkage.
 *
 * `unresolved_in_flight_attempt` (final Stage B review, point 5): found
 * when a prior, uncompleted invocation left a `reserved`/`in_progress`
 * row behind (a crash between reservation and reconciliation). This
 * module:
 *   - never calls the provider for that planned run (the loop breaks
 *     before entering the provider-call section at all);
 *   - never touches that row — no startAttempt, no reconcileAttempt —
 *     so it stays exactly as found, explicitly unresolved rather than
 *     silently marked failed/completed/cancelled;
 *   - never retries it automatically (no admitAndReserveAttempt with
 *     retryOfAttemptId is issued for a row this invocation didn't
 *     itself just create and fail);
 *   - is durable-worker recovery territory, not this CLI path's:
 *     resuming or terminalizing a genuinely crashed attempt safely is
 *     M5's job.
 */

import type {
  BuyerQuestionVersion,
  DatasetBatch,
  DbAdapter,
  ProbeMode,
  Protocol,
  ProtocolAttempt,
  AttemptKind,
} from "@/lib/db/types";
import { PerplexityProbeFailure, runPerplexityProbe } from "@/lib/probes/perplexity";
import { failProbeRunOrThrow } from "@/lib/pipeline/mark-probe-run-failed";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";

export type ProtocolStopReason =
  | "run_cap_exceeded"
  | "spend_cap_exceeded"
  | "rate_limit_exceeded"
  | "concurrency_limit_exceeded"
  | "unresolved_in_flight_attempt";

export interface ProtocolProbeCall {
  prompt: string;
  brandName: string;
  domain: string;
}

/** Injectable seam. Real callers pass `runPerplexityProbe` (the default); tests inject a fake with controllable cost/success/failure. */
export type ProtocolProbeCaller = (
  call: ProtocolProbeCall
) => ReturnType<typeof runPerplexityProbe>;

export interface RunProtocolGatedBaselineInput {
  db: DbAdapter;
  projectId: string;
  protocol: Protocol;
  promptText: string;
  brandName: string;
  domain: string;
  knownCompetitors: string[];
  datasetBatch: DatasetBatch;
  /** Exactly the caller-supplied planned count — never a legacy default. */
  plannedRuns: number;
  attemptKind: AttemptKind;
  /** Tags the probe_runs row and probe_results.probe_mode honestly — "simulated" for orchestration testing, "live_perplexity" for a real provider call. Never hardcoded inside this module. */
  probeMode: ProbeMode;
  /** Conservative per-call ceiling used for every reservation (Rule/item 2 — not an average). */
  reservationCeilingUsd: number;
  /** Real cost to reconcile per successfully-attempted call (may exceed `reservationCeilingUsd`). */
  actualCostUsd: number;
  callProvider?: ProtocolProbeCaller;
  assertLeaseOwnership?: () => void;
}

export interface RunProtocolGatedBaselineResult {
  plannedRuns: number;
  attemptedPlannedRuns: number;
  completed: number;
  failedExhausted: number;
  skippedAlreadyDone: number;
  stoppedReason: ProtocolStopReason | null;
  /** Sum of (actualCostUsd - reservedCostUsd) across attempts reconciled this run, clamped to >= 0 per attempt — the explicit overrun, never hidden. */
  totalReservationOverrunUsd: number;
  /** Final Stage B review, point 6 — the authoritative planned/completed/failed/excluded/remaining summary, recomputed from a fresh ledger read after this invocation, never accumulated ad hoc from this loop's own local counters. */
  ledgerCounters: ProtocolLedgerCounters;
}

export interface ProtocolLedgerCounters {
  /** Always protocol.plannedBaselineRuns + protocol.plannedRetestRuns — the full approved plan, never just the baseline slice this CLI path executes. */
  planned: number;
  completed: number;
  /** failed + timed_out — genuine, non-excluded failures. */
  failed: number;
  /** excluded + cancelled — deliberately out of the denominator, still visible (CLAUDE.md: failed/excluded attempts remain visible in reconciliation). */
  excluded: number;
  /** planned minus every non-cancelled attempt consumed so far — mirrors admitAndReserveAttempt's own run_cap consumption rule exactly (a cancelled attempt frees its slot). */
  remaining: number;
}

/**
 * The single, ledger-derived source of truth for planned/completed/
 * failed/excluded/remaining (Rule 3: planned = baseline + retest,
 * always, regardless of which attempt kind actually ran). Never reads
 * anything but `protocol`'s own planned*Runs fields and a real
 * `protocol_attempts` snapshot — no local accumulator, no legacy
 * constant.
 */
export function computeProtocolLedgerCounters(
  protocol: Protocol,
  attempts: ProtocolAttempt[]
): ProtocolLedgerCounters {
  const planned = protocol.plannedBaselineRuns + protocol.plannedRetestRuns;
  const completed = attempts.filter((a) => a.status === "completed").length;
  const failed = attempts.filter(
    (a) => a.status === "failed" || a.status === "timed_out"
  ).length;
  const excluded = attempts.filter(
    (a) => a.status === "excluded" || a.status === "cancelled"
  ).length;
  const consumed = attempts.filter((a) => a.status !== "cancelled").length;
  const remaining = Math.max(0, planned - consumed);
  return { planned, completed, failed, excluded, remaining };
}

/** The explicit, never-hidden gap between what an attempt actually cost and what it reserved. Zero or negative (came in at/under ceiling) reports as 0. */
export function reservationOverrunUsd(attempt: ProtocolAttempt): number {
  if (attempt.actualCostUsd === null) return 0;
  return Math.max(0, attempt.actualCostUsd - attempt.reservedCostUsd);
}

export type ProtocolExecutionGateOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Single source of truth for "may this protocol run at all" — used by
 * scripts/mvp-scan.ts before it does anything else, and directly
 * unit-testable without spawning the CLI. Fails closed on every branch:
 * a missing protocol, a not-yet-approved protocol, a missing/dangling
 * buyer_question_version, or an unapproved version all refuse to run.
 */
export function checkProtocolExecutionGate(
  protocol: Protocol | null,
  version: BuyerQuestionVersion | null
): ProtocolExecutionGateOutcome {
  if (!protocol) return { ok: false, reason: "protocol_not_found" };
  if (protocol.status !== "approved" && protocol.status !== "active") {
    return { ok: false, reason: `protocol_not_approved:${protocol.status}` };
  }
  if (!version) return { ok: false, reason: "buyer_question_version_not_found" };
  if (version.approvedAt === null) {
    return { ok: false, reason: "buyer_question_version_not_approved" };
  }
  return { ok: true };
}

const STOPPING_ADMISSION_OUTCOMES = new Set([
  "RUN_CAP_EXCEEDED",
  "SPEND_CAP_EXCEEDED",
  "RATE_LIMIT_EXCEEDED",
  "CONCURRENCY_LIMIT_EXCEEDED",
]);

function stopReasonFor(outcome: string): ProtocolStopReason | null {
  switch (outcome) {
    case "RUN_CAP_EXCEEDED":
      return "run_cap_exceeded";
    case "SPEND_CAP_EXCEEDED":
      return "spend_cap_exceeded";
    case "RATE_LIMIT_EXCEEDED":
      return "rate_limit_exceeded";
    case "CONCURRENCY_LIMIT_EXCEEDED":
      return "concurrency_limit_exceeded";
    default:
      return null;
  }
}

export async function runProtocolGatedBaseline(
  input: RunProtocolGatedBaselineInput
): Promise<RunProtocolGatedBaselineResult> {
  const { db } = input;
  const callProvider: ProtocolProbeCaller = input.callProvider ?? runPerplexityProbe;

  let completed = 0;
  let failedExhausted = 0;
  let skippedAlreadyDone = 0;
  let attemptedPlannedRuns = 0;
  let stoppedReason: ProtocolStopReason | null = null;
  let totalReservationOverrunUsd = 0;

  for (let i = 0; i < input.plannedRuns; i += 1) {
    input.assertLeaseOwnership?.();

    // Deterministic (not random) so a whole-script re-run after a crash
    // resumes instead of double-admitting — Rule 11 at the CLI layer.
    const idempotencyKey = `${input.protocol.id}:${input.attemptKind}:${i}`;
    const admission = await db.admitAndReserveAttempt({
      protocolId: input.protocol.id,
      projectId: input.projectId,
      attemptKind: input.attemptKind,
      idempotencyKey,
      estimatedCostUsd: input.reservationCeilingUsd,
    });

    if (admission.outcome === "ALREADY_RESERVED") {
      const existing = admission.attempt!;
      const terminal = existing.status !== "reserved" && existing.status !== "in_progress";
      if (!terminal) {
        // A genuinely in-flight attempt from a previous, uncompleted
        // invocation. Resuming it safely is M5's durable-worker concern,
        // not this CLI path's — fail closed rather than guess.
        stoppedReason = "unresolved_in_flight_attempt";
        break;
      }
      skippedAlreadyDone += 1;
      if (existing.status === "completed") completed += 1;
      else failedExhausted += 1;
      totalReservationOverrunUsd += reservationOverrunUsd(existing);
      continue;
    }

    if (STOPPING_ADMISSION_OUTCOMES.has(admission.outcome)) {
      stoppedReason = stopReasonFor(admission.outcome);
      break;
    }

    if (admission.outcome !== "RESERVED") {
      // NOT_FOUND / PROTOCOL_NOT_APPROVED / RETRY_CAP_EXCEEDED /
      // INVALID_RETRY_REFERENCE cannot happen on a fresh, non-retry
      // admission against a protocol the caller already validated as
      // approved — a real occurrence means a serious contract break,
      // not a business-as-usual outcome to swallow.
      throw new Error(
        `Unexpected admission outcome '${admission.outcome}' for a fresh (non-retry) attempt.`
      );
    }

    attemptedPlannedRuns += 1;
    let currentAttempt = admission.attempt!;
    let retryIndex = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const probeRun = await db.createProbeRun(
        input.projectId,
        "perplexity",
        input.probeMode,
        "pending",
        { datasetId: input.datasetBatch.id, datasetSourceType: input.datasetBatch.datasetSourceType }
      );

      // Rule 10 — the reservation already exists (created above); this
      // is the only path that ever links it to a probe_runs row, and it
      // runs strictly before the provider call below.
      const started = await db.startAttempt({
        attemptId: currentAttempt.id,
        projectId: input.projectId,
        probeRunId: probeRun.id,
      });
      if (started.outcome !== "STARTED") {
        throw new Error(
          `startAttempt returned '${started.outcome}' for freshly reserved attempt ${currentAttempt.id}.`
        );
      }

      let outcomeKind: "completed" | "failed" | "timed_out";
      let terminationReason: string | null = null;

      try {
        const live = await callProvider({
          prompt: input.promptText,
          brandName: input.brandName,
          domain: input.domain,
        });

        if (
          probeRequestLeaksClientIdentity({
            rawRequest: live.rawProbeRequest ?? input.promptText,
            originalPrompt: input.promptText,
            brandTerms: [input.brandName],
            domain: input.domain,
          })
        ) {
          const integrityError = `Probe request integrity failed for prompt: ${input.promptText}`;
          await failProbeRunOrThrow(db, probeRun.id, integrityError);
          outcomeKind = "failed";
          terminationReason = "probe_request_identity_leak";
        } else {
          const analyzed = await analyzeProbeResponse({
            projectId: input.projectId,
            prompt: input.promptText,
            platform: "perplexity",
            probeRunId: probeRun.id,
            rawResponse: live.rawResponse,
            rawProbeRequest: live.rawProbeRequest,
            knownCompetitors: input.knownCompetitors,
            probeMode: input.probeMode,
            rawResponseSha256: live.rawResponseSha256,
            rawResponseBody: live.rawResponseBody,
            rawResponseBodySha256: live.rawResponseBodySha256,
            rawProbeRequestSha256: live.rawProbeRequestSha256,
            fullRequestBodySha256: live.fullRequestBodySha256,
            providerHttpStatus: live.httpStatus,
            providerLatencyMs: live.latencyMs,
            providerRequestId: live.providerRequestId,
            providerModel: live.model,
            retryCount: retryIndex,
            datasetId: input.datasetBatch.id,
            datasetSourceType: input.datasetBatch.datasetSourceType,
          });
          if (!analyzed.ok) {
            outcomeKind = "failed";
            terminationReason = analyzed.error;
          } else {
            outcomeKind = "completed";
          }
        }
      } catch (err) {
        if (err instanceof PerplexityProbeFailure) {
          await db.recordProbeFailure({
            probeRunId: probeRun.id,
            projectId: input.projectId,
            platform: "perplexity",
            prompt: input.promptText,
            failureReason: err.reason,
            providerHttpStatus: err.httpStatus,
            providerErrorBody: err.errorBody,
            providerErrorBodySha256: err.errorBodySha256,
            providerLatencyMs: err.latencyMs,
            providerRequestId: err.providerRequestId,
            rawProbeRequestSha256: err.rawProbeRequestSha256,
            fullRequestBodySha256: err.fullRequestBodySha256,
            retryCount: retryIndex,
          });
          // network_error is the closest available signal to a timeout;
          // Perplexity's failure taxonomy (0037) has no distinct "timed
          // out" reason of its own.
          outcomeKind = err.reason === "network_error" ? "timed_out" : "failed";
          terminationReason = err.reason;
        } else {
          const message = err instanceof Error ? err.message : String(err);
          await failProbeRunOrThrow(db, probeRun.id, `Perplexity probe failed: ${message}`);
          outcomeKind = "failed";
          terminationReason = message;
        }
      }

      const reconciled = await db.reconcileAttempt({
        attemptId: currentAttempt.id,
        projectId: input.projectId,
        status: outcomeKind,
        actualCostUsd: input.actualCostUsd,
        probeRunId: probeRun.id,
        terminationReason,
      });
      if (reconciled.outcome !== "RECONCILED") {
        throw new Error(
          `reconcileAttempt returned '${reconciled.outcome}' for attempt ${currentAttempt.id}.`
        );
      }
      totalReservationOverrunUsd += reservationOverrunUsd(reconciled.attempt!);

      if (outcomeKind === "completed") {
        completed += 1;
        break;
      }

      // Bounded retry — the ledger's own retry_cap enforcement inside
      // admitAndReserveAttempt is the single source of truth; this loop
      // never counts or bounds retries itself.
      retryIndex += 1;
      const retryKey = `${idempotencyKey}:retry:${retryIndex}`;
      const retryAdmission = await db.admitAndReserveAttempt({
        protocolId: input.protocol.id,
        projectId: input.projectId,
        attemptKind: input.attemptKind,
        idempotencyKey: retryKey,
        estimatedCostUsd: input.reservationCeilingUsd,
        retryOfAttemptId: currentAttempt.id,
      });

      if (retryAdmission.outcome === "RESERVED") {
        currentAttempt = retryAdmission.attempt!;
        continue;
      }

      // RETRY_CAP_EXCEEDED, or a cap exhausted on the retry itself —
      // this one planned run is exhausted. Move on to the next planned
      // run rather than aborting every remaining one; a genuinely
      // exhausted spend/rate/concurrency cap still stops the whole loop
      // via stoppedReason below.
      failedExhausted += 1;
      if (STOPPING_ADMISSION_OUTCOMES.has(retryAdmission.outcome)) {
        stoppedReason = stopReasonFor(retryAdmission.outcome);
      }
      break;
    }

    if (stoppedReason) break;
  }

  const ledgerAttempts = await db.getProtocolAttempts(input.protocol.id, input.projectId);
  const ledgerCounters = computeProtocolLedgerCounters(input.protocol, ledgerAttempts);

  return {
    plannedRuns: input.plannedRuns,
    attemptedPlannedRuns,
    completed,
    failedExhausted,
    skippedAlreadyDone,
    stoppedReason,
    totalReservationOverrunUsd,
    ledgerCounters,
  };
}
