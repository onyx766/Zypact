/**
 * Boundary validation for intervention route bodies.
 *
 * The RPCs remain authoritative — they re-check everything that matters and
 * the database constraints check again. This layer exists so a founder gets a
 * precise sentence instead of a generic constraint failure, and so nothing
 * malformed reaches a `service_role` call at all.
 *
 * Deliberately NOT taken from the body: `projectId`, `approvedBy`, or any
 * other identity. Project identity is read from the stored intervention or
 * protocol row, and actor identity from the session. A client-supplied
 * project id could be chosen to make a cross-tenant call look valid.
 */

import { ACTION_TYPES, type ActionType } from "@/lib/interventions/types";

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string };

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LONG_TEXT = 4000;
const SHORT_TEXT = 2000;
const MAX_EVIDENCE_ITEMS = 50;
const MAX_EVIDENCE_ID = 200;
/** An observation window longer than a year is not a V1 experiment. */
const MAX_OBSERVATION_DAYS = 365;

function fail<T>(error: string, message: string): Validated<T> {
  return { ok: false, error, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requiredText(
  body: Record<string, unknown>,
  key: string,
  label: string,
  max: number
): Validated<string> {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    return fail("missing_field", `${label} is required.`);
  }
  if (v.length > max) return fail("field_too_long", `${label} must be ${max} characters or fewer.`);
  return { ok: true, value: v.trim() };
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  label: string,
  max: number
): Validated<string | null> {
  const v = body[key];
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return fail("invalid_field", `${label} must be text.`);
  if (v.length > max) return fail("field_too_long", `${label} must be ${max} characters or fewer.`);
  return { ok: true, value: v.trim() === "" ? null : v.trim() };
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export interface RegisterInput {
  protocolId: string;
  hypothesis: string;
  expectedMechanism: string;
  actionType: ActionType;
  actionTarget: string;
  owner: string;
  supportingEvidence: string[];
  expectedObservationDays: number;
  decisionThresholdNote: string | null;
  alternativeExplanations: string | null;
  confoundersToMonitor: string | null;
  implementationDeadline: string | null;
}

export function parseRegisterBody(body: unknown): Validated<RegisterInput> {
  if (!isObject(body)) return fail("invalid_body", "The request body must be a JSON object.");

  const protocolId = body.protocolId;
  if (typeof protocolId !== "string" || !UUID_PATTERN.test(protocolId)) {
    return fail("invalid_protocol_id", "Choose the baseline protocol this intervention responds to.");
  }

  const hypothesis = requiredText(body, "hypothesis", "Hypothesis", LONG_TEXT);
  if (!hypothesis.ok) return hypothesis;
  const expectedMechanism = requiredText(body, "expectedMechanism", "Expected mechanism", LONG_TEXT);
  if (!expectedMechanism.ok) return expectedMechanism;
  const actionTarget = requiredText(body, "actionTarget", "Action target", SHORT_TEXT);
  if (!actionTarget.ok) return actionTarget;
  const owner = requiredText(body, "owner", "Owner", SHORT_TEXT);
  if (!owner.ok) return owner;

  const actionType = body.actionType;
  if (typeof actionType !== "string" || !(ACTION_TYPES as readonly string[]).includes(actionType)) {
    return fail("invalid_action_type", `Action type must be one of: ${ACTION_TYPES.join(", ")}.`);
  }

  // Empty is allowed on purpose. 0071 treats a proposal with no evidence as
  // the honest `needs_evidence` state: it can be registered, and
  // approve_intervention will refuse it until evidence is cited.
  const rawEvidence = body.supportingEvidence ?? [];
  if (!Array.isArray(rawEvidence)) {
    return fail("invalid_supporting_evidence", "Supporting evidence must be a list of run IDs.");
  }
  if (rawEvidence.length > MAX_EVIDENCE_ITEMS) {
    return fail("invalid_supporting_evidence", `Cite at most ${MAX_EVIDENCE_ITEMS} supporting runs.`);
  }
  const supportingEvidence: string[] = [];
  for (const item of rawEvidence) {
    if (typeof item !== "string" || item.trim() === "" || item.length > MAX_EVIDENCE_ID) {
      return fail("invalid_supporting_evidence", "Each supporting run must be a non-empty run ID.");
    }
    if (!supportingEvidence.includes(item.trim())) supportingEvidence.push(item.trim());
  }

  // Required here although the column is nullable: no RPC can set it after
  // registration, and confirm_intervention_implementation refuses without
  // it. Omitting it would strand the intervention at 'approved' forever.
  const days = body.expectedObservationDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_OBSERVATION_DAYS) {
    return fail(
      "invalid_observation_days",
      `Expected observation window must be a whole number of days from 1 to ${MAX_OBSERVATION_DAYS}. It cannot be set later.`
    );
  }

  const decisionThresholdNote = optionalText(body, "decisionThresholdNote", "Decision threshold", LONG_TEXT);
  if (!decisionThresholdNote.ok) return decisionThresholdNote;
  const alternativeExplanations = optionalText(body, "alternativeExplanations", "Alternative explanations", LONG_TEXT);
  if (!alternativeExplanations.ok) return alternativeExplanations;
  const confoundersToMonitor = optionalText(body, "confoundersToMonitor", "Confounders to monitor", LONG_TEXT);
  if (!confoundersToMonitor.ok) return confoundersToMonitor;

  let implementationDeadline: string | null = null;
  if (body.implementationDeadline !== undefined && body.implementationDeadline !== null && body.implementationDeadline !== "") {
    const raw = body.implementationDeadline;
    const parsed = typeof raw === "string" ? new Date(raw) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return fail("invalid_deadline", "Implementation deadline must be a valid date.");
    }
    implementationDeadline = parsed.toISOString();
  }

  return {
    ok: true,
    value: {
      protocolId,
      hypothesis: hypothesis.value,
      expectedMechanism: expectedMechanism.value,
      actionType: actionType as ActionType,
      actionTarget: actionTarget.value,
      owner: owner.value,
      supportingEvidence,
      expectedObservationDays: days,
      decisionThresholdNote: decisionThresholdNote.value,
      alternativeExplanations: alternativeExplanations.value,
      confoundersToMonitor: confoundersToMonitor.value,
      implementationDeadline,
    },
  };
}

// ---------------------------------------------------------------------------
// reason-only bodies: reject, abandon, authorize early retest
// ---------------------------------------------------------------------------

export function parseReasonBody(body: unknown, label: string): Validated<string> {
  if (!isObject(body)) return fail("invalid_body", "The request body must be a JSON object.");
  const reason = requiredText(body, "reason", label, SHORT_TEXT);
  if (!reason.ok) return { ok: false, error: "reason_required", message: reason.message };
  return reason;
}

// ---------------------------------------------------------------------------
// confirm implementation
// ---------------------------------------------------------------------------

export interface ConfirmInput {
  evidence: Record<string, unknown>;
  artifactSha256: string | null;
  deviations: string | null;
}

export function parseConfirmBody(body: unknown): Validated<ConfirmInput> {
  if (!isObject(body)) return fail("invalid_body", "The request body must be a JSON object.");

  // 0072 requires an object, and an empty one proves nothing went live.
  const evidence = body.evidence;
  if (!isObject(evidence) || Object.keys(evidence).length === 0) {
    return fail(
      "invalid_implementation_evidence",
      "Describe what went live — at least a URL or a note — before confirming implementation."
    );
  }
  if (JSON.stringify(evidence).length > LONG_TEXT * 4) {
    return fail("invalid_implementation_evidence", "Implementation evidence is too large.");
  }

  let artifactSha256: string | null = null;
  if (body.artifactSha256 !== undefined && body.artifactSha256 !== null && body.artifactSha256 !== "") {
    const raw = body.artifactSha256;
    // 0071's check is lowercase hex; normalising case here rather than
    // failing on a pasted uppercase hash.
    if (typeof raw !== "string" || !/^[0-9a-f]{64}$/i.test(raw.trim())) {
      return fail("invalid_artifact_hash", "Artifact hash must be a 64-character SHA-256 hex digest, or left blank.");
    }
    artifactSha256 = raw.trim().toLowerCase();
  }

  const deviations = optionalText(body, "deviations", "Protocol deviations", LONG_TEXT);
  if (!deviations.ok) return deviations;

  return { ok: true, value: { evidence, artifactSha256, deviations: deviations.value } };
}
