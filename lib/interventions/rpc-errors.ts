/**
 * Translation from the M7 RPCs' failure vocabulary to HTTP.
 *
 * Every intervention route calls a `service_role` RPC and gets back one of
 * three things: a row, a named outcome string, or a raised Postgres error.
 * This module turns the second and third into a status code, a stable
 * machine-readable `error` code, and a sentence a founder can act on.
 *
 * Three rules:
 *
 *   1. Every message the migrations can raise is mapped explicitly.
 *      `scripts/test-intervention-rpc-errors.ts` reads 0071-0078 and fails if
 *      one is not — a new RAISE in a future migration cannot silently fall
 *      through to a generic 500.
 *   2. An unmapped error is a 500 whose body never echoes the database
 *      message. Raw Postgres text can carry identifiers and internal detail;
 *      it is logged server-side with closed fields and never returned.
 *   3. The founder-facing text states what happened and what to do next. It
 *      never softens a methodology refusal into something that sounds
 *      optional — `retest_already_started` is a rule, not a hiccup.
 */

export interface MappedRpcFailure {
  status: 400 | 404 | 409 | 500;
  /** Stable, machine-readable. Safe to return to the client. */
  error: string;
  /** Founder-facing. Safe to return to the client. */
  message: string;
}

type Entry = Omit<MappedRpcFailure, "error">;

/**
 * Keyed by the exact `message` each migration raises. Grouped by what the
 * failure means rather than by which migration raised it.
 */
export const RPC_ERROR_MAP: Readonly<Record<string, Entry>> = {
  // ---- malformed calls: the route sent something it should not have ----
  invalid_intervention_identity: {
    status: 400,
    message: "The project or baseline protocol was missing.",
  },
  invalid_supporting_evidence_shape: {
    status: 400,
    message: "Supporting evidence must be a list of run IDs.",
  },
  invalid_approve_intervention_args: {
    status: 400,
    message: "The approval request was incomplete.",
  },
  invalid_confirm_implementation_args: {
    status: 400,
    message: "The implementation confirmation was incomplete.",
  },
  invalid_implementation_evidence: {
    status: 400,
    message: "Implementation evidence must be an object describing what went live.",
  },
  invalid_authorize_early_retest_args: {
    status: 400,
    message: "The early-retest authorization was incomplete.",
  },
  invalid_create_retest_protocol_args: {
    status: 400,
    message: "The retest request was incomplete.",
  },
  invalid_reject_intervention_args: {
    status: 400,
    message: "The rejection request was incomplete.",
  },
  invalid_abandon_intervention_args: {
    status: 400,
    message: "The abandonment request was incomplete.",
  },
  invalid_record_intervention_deviation_args: {
    status: 400,
    message: "The deviation request was incomplete.",
  },
  invalid_approve_protocol_args: {
    status: 400,
    message: "The protocol approval request was incomplete.",
  },

  // ---- a reason is required and was not given ----
  rejection_needs_reason: {
    status: 400,
    message: "Say why this intervention is being rejected.",
  },
  abandonment_needs_reason: {
    status: 400,
    message: "Say why this intervention is being abandoned.",
  },
  early_retest_reason_required: {
    status: 400,
    message:
      "Say why the retest is starting before the observation window closes. This is recorded permanently as a deviation.",
  },

  deviation_needs_note: {
    status: 400,
    message: "Describe the deviation before recording it.",
  },
  deviation_note_too_long: {
    status: 400,
    message: "A deviation note can be at most 4000 characters.",
  },

  // ---- the thing referred to does not exist ----
  protocol_not_found: {
    status: 404,
    message: "That baseline protocol was not found in this project.",
  },

  // ---- a precondition the methodology requires is not met ----
  protocol_is_not_a_baseline: {
    status: 409,
    message: "That protocol is a retest. Interventions are registered against a baseline.",
  },
  protocol_not_executable: {
    status: 409,
    message:
      "This baseline has not been approved, so it has produced no evidence to base an intervention on.",
  },
  intervention_needs_evidence: {
    status: 409,
    message:
      "Cite at least one supporting run before approving. An intervention with no evidence behind it is not evidence-backed.",
  },
  observation_window_not_declared: {
    status: 409,
    message:
      "No observation window was set when this intervention was registered, so implementation cannot open one.",
  },
  retest_already_started: {
    status: 409,
    message:
      "The retest has already started measuring, so this intervention can no longer be abandoned. Let it finish: an inconclusive result is an honest outcome, and deviations can be recorded against it.",
  },

  // ---- a permanent record was about to be changed ----
  intervention_registration_is_immutable: {
    status: 409,
    message: "An approved intervention's registered claim cannot be edited.",
  },
  observation_window_is_immutable: {
    status: 409,
    message: "The observation window is frozen and cannot be moved.",
  },
  early_retest_authorization_is_immutable: {
    status: 409,
    message: "A recorded early-retest authorization cannot be changed.",
  },
  abandonment_is_immutable: {
    status: 409,
    message: "An abandonment is permanent and cannot be changed or reversed.",
  },
  intervention_deviation_is_immutable: {
    status: 409,
    message: "A recorded deviation is permanent and cannot be edited or removed.",
  },

  // ---- 0074's phase trigger: a worker-path invariant, never a founder input ----
  attempt_kind_retest_requires_a_retest_protocol: {
    status: 500,
    message: "An internal consistency check failed. Nothing was changed.",
  },
  attempt_kind_must_be_retest_on_a_retest_protocol: {
    status: 500,
    message: "An internal consistency check failed. Nothing was changed.",
  },

  // ---- 0076's Outcome Card artifact validation: built by code, not typed ----
  invalid_outcome_card_payload: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
  invalid_outcome_card_integrity_status: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
  invalid_outcome_card_integrity_reasons: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
  invalid_outcome_card_artifact_input: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
  integrity_passed_must_carry_no_reasons: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
  integrity_below_passed_requires_a_reason: {
    status: 500,
    message: "The Outcome Card could not be saved. Nothing was changed.",
  },
};

/**
 * Raised with a dynamic suffix by 0073 (`unexpected_retest_protocol_approval_status:<status>`),
 * so it cannot be a key in the exact-match map above.
 */
const PREFIX_MAP: ReadonlyArray<[string, Entry]> = [
  [
    "unexpected_retest_protocol_approval_status:",
    {
      status: 500,
      message: "The retest protocol was created but could not be approved. Nothing was run.",
    },
  ],
];

/**
 * Postgres SQLSTATEs that reach a route when a constraint rather than a named
 * RAISE refuses the write.
 */
const SQLSTATE_MAP: Readonly<Record<string, MappedRpcFailure>> = {
  // interventions_one_live_per_protocol (0071) is the realistic source here.
  "23505": {
    status: 409,
    error: "already_live",
    message:
      "This baseline already has a live intervention. Reject or abandon it before registering another.",
  },
  // A CHECK constraint. The RPCs validate first, so reaching this means an
  // input slipped past them — reported without echoing which constraint.
  "23514": {
    status: 400,
    error: "constraint_violation",
    message: "That input was rejected by a data rule. Nothing was changed.",
  },
};

const UNMAPPED: MappedRpcFailure = {
  status: 500,
  error: "internal_error",
  message: "Something went wrong. Nothing was changed.",
};

/** The subset of a Supabase/PostgREST error this module reads. */
export interface RpcErrorLike {
  message?: string | null;
  code?: string | null;
}

/**
 * Map a raised RPC error. Never returns the raw database message.
 *
 * `onUnmapped` lets the caller log the real message with its own closed-field
 * logger; this module deliberately does not log, so it stays pure and
 * testable.
 */
export function mapRpcError(
  err: RpcErrorLike,
  onUnmapped?: (detail: { code: string | null; message: string | null }) => void
): MappedRpcFailure {
  const message = err.message?.trim() ?? "";

  const exact = RPC_ERROR_MAP[message];
  if (exact) return { ...exact, error: message };

  for (const [prefix, entry] of PREFIX_MAP) {
    if (message.startsWith(prefix)) {
      return { ...entry, error: prefix.slice(0, -1) };
    }
  }

  const bySqlstate = err.code ? SQLSTATE_MAP[err.code] : undefined;
  if (bySqlstate) return bySqlstate;

  onUnmapped?.({ code: err.code ?? null, message: err.message ?? null });
  return UNMAPPED;
}

// ---------------------------------------------------------------------------
// Named outcomes: returned as data, not raised
// ---------------------------------------------------------------------------

/**
 * `retest_eligibility` (0072) returns one of these as `reason`. They are not
 * failures — `OBSERVATION_WINDOW_OPEN` is the normal state for most of an
 * intervention's life — so they get a presentation, not an HTTP status.
 */
export type RetestEligibilityReason =
  | "INTERVENTION_NOT_FOUND"
  | "INTERVENTION_NOT_IMPLEMENTED"
  | "AUTHORIZED_DEVIATION"
  | "OBSERVATION_WINDOW_OPEN"
  | "WINDOW_ELAPSED";

export interface EligibilityPresentation {
  /** Short badge text. */
  label: string;
  /**
   * `deviation` is deliberately distinct from `ready`: a window cut short
   * must never look identical to one that ran its full course.
   */
  tone: "neutral" | "waiting" | "ready" | "deviation";
  /** Whether a retest may be created right now. */
  eligible: boolean;
}

export function describeRetestEligibility(
  reason: string,
  windowClosesAt: string | null
): EligibilityPresentation {
  switch (reason) {
    case "WINDOW_ELAPSED":
      return { label: "Retest ready", tone: "ready", eligible: true };
    case "AUTHORIZED_DEVIATION":
      return { label: "Retest ready (early)", tone: "deviation", eligible: true };
    case "OBSERVATION_WINDOW_OPEN":
      return {
        label: windowClosesAt
          ? `Observing — closes ${formatDay(windowClosesAt)}`
          : "Observing",
        tone: "waiting",
        eligible: false,
      };
    case "INTERVENTION_NOT_IMPLEMENTED":
      return { label: "Not started", tone: "neutral", eligible: false };
    default:
      // INTERVENTION_NOT_FOUND, or anything a later migration adds. Never
      // defaults to eligible.
      return { label: "Not applicable", tone: "neutral", eligible: false };
  }
}

/**
 * `create_retest_protocol` (0073) outcomes. `CREATED` and
 * `RETEST_ALREADY_EXISTS` both succeed — the second is the idempotent replay
 * of a double click, and must not look like an error.
 */
export function mapCreateRetestOutcome(
  status: string
): { ok: true; replayed: boolean } | { ok: false; failure: MappedRpcFailure } {
  switch (status) {
    case "CREATED":
      return { ok: true, replayed: false };
    case "RETEST_ALREADY_EXISTS":
      return { ok: true, replayed: true };
    case "INTERVENTION_NOT_FOUND":
      return {
        ok: false,
        failure: { status: 404, error: "intervention_not_found", message: "That intervention was not found in this project." },
      };
    case "BASELINE_NOT_FOUND":
      return {
        ok: false,
        failure: { status: 404, error: "baseline_not_found", message: "The baseline protocol for this intervention was not found." },
      };
    case "BASELINE_HAS_NO_PLAN":
      return {
        ok: false,
        failure: { status: 409, error: "baseline_has_no_plan", message: "The baseline planned no runs, so there is nothing to compare a retest against." },
      };
    case "INTERVENTION_NOT_IMPLEMENTED":
      return {
        ok: false,
        failure: { status: 409, error: "intervention_not_implemented", message: "Confirm the intervention was implemented before starting a retest." },
      };
    case "OBSERVATION_WINDOW_OPEN":
      return {
        ok: false,
        failure: {
          status: 409,
          error: "observation_window_open",
          message:
            "The observation window is still open. Wait for it to close, or authorize an early retest with a recorded reason.",
        },
      };
    default:
      return { ok: false, failure: { ...UNMAPPED } };
  }
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
