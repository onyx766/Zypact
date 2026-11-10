/**
 * Q4 question approval and activation (D-049): consent text, input parsing,
 * the handlers, and the view joining drafts with active questions. The
 * handlers are pure decisions over injected dependencies, as P1/P2; the
 * database re-checks the session, the step-up and the plan's limit.
 *
 * Approving a question never starts, reserves or authorises a measurement.
 */
import { createHash } from "node:crypto";

import type { AccountContext } from "@/lib/accounts/handlers";
import { guarded, invalid, json, notSignedIn, type WorkspaceDeps, type WorkspaceResult } from "@/lib/workspace/handlers";
import type { ActiveQuestion, ActiveQuestions, QuestionDraft } from "@/lib/workspace/store";

export const APPROVAL_CONSENT_VERSION = "q4.activate.v1";
export const APPROVAL_CONSENT_TEXT =
  "I approve this exact wording as an active buyer question for this workspace. Approving does not start a measurement or use any of the plan's allowance. If I change the wording later, the change is approved as a new version and earlier versions and their results are kept.";
export const APPROVAL_CONSENT_SHA256 = createHash("sha256").update(APPROVAL_CONSENT_TEXT, "utf8").digest("hex");

export const ACTIVE_NOTE =
  "Active questions are the ones your plan can measure. Approving one starts nothing: measurement runs only when it is switched on and only within your allowance.";
export const ARCHIVE_NOTE = "Archiving stops a question from being measured. Its versions and results are kept, and runs it already used are not given back.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseApproval(input: Record<string, unknown>):
  | { ok: true; draftId: string; expectedVersion: number; idempotencyKey: string }
  | { ok: false; field: string; message: string } {
  if (typeof input.draftId !== "string" || !UUID_RE.test(input.draftId)) return { ok: false, field: "draftId", message: "Reload the page and try again." };
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, field: "expectedVersion", message: "Reload the page and try again." };
  if (typeof input.idempotencyKey !== "string" || !UUID_RE.test(input.idempotencyKey)) return { ok: false, field: "idempotencyKey", message: "Reload the page and try again." };
  if (input.consentVersion !== APPROVAL_CONSENT_VERSION) return { ok: false, field: "consentVersion", message: "The approval wording has changed. Reload the page and try again." };
  return { ok: true, draftId: input.draftId, expectedVersion, idempotencyKey: input.idempotencyKey.toLowerCase() };
}

const APPROVE_MESSAGES: Record<string, [number, string, string]> = {
  STEP_UP_REQUIRED: [403, "step_up_required", "Confirm your password to approve questions."],
  NO_WEBSITE: [409, "no_website", "Add your website first."],
  NOT_FOUND: [404, "not_found", "Reload the page and try again."],
  VERSION_CONFLICT: [409, "version_conflict", "This draft was changed somewhere else. Reload the page to see the latest wording."],
  DRAFT_ARCHIVED: [409, "draft_archived", "Restore the draft before approving it."],
  ALREADY_ACTIVE_WORDING: [409, "already_active_wording", "An active question already has exactly this wording."],
  LIMIT_REACHED: [409, "limit_reached", "Your plan's active-question limit is reached. Archive an active question first."],
  IDEMPOTENCY_KEY_CONFLICT: [409, "idempotency_key_conflict", "Reload the page and try again."],
};

export function handleApproveDraft(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_approve_draft", account, token, async (acct, tok) => {
    const parsed = parseApproval(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const res = await deps.store.approveDraft(tok, acct.accountId, parsed.draftId, parsed.expectedVersion, parsed.idempotencyKey, APPROVAL_CONSENT_VERSION, APPROVAL_CONSENT_SHA256);
    deps.log({ event: "workspace_approve_draft", outcome: res.status.toLowerCase() });
    if (res.status === "NOT_SIGNED_IN") return notSignedIn();
    const failure = APPROVE_MESSAGES[res.status];
    if (failure) return json(failure[0], { ok: false, error: failure[1], message: failure[2] });
    return json(200, { ok: true, status: res.status.toLowerCase(), buyerQuestionId: res.buyerQuestionId, versionId: res.versionId });
  });
}

export function handleArchiveActive(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_archive_active", account, token, async (acct, tok) => {
    if (typeof input.buyerQuestionId !== "string" || !UUID_RE.test(input.buyerQuestionId)) return invalid("buyerQuestionId", "Reload the page and try again.");
    const status = await deps.store.archiveActive(tok, acct.accountId, input.buyerQuestionId);
    deps.log({ event: "workspace_archive_active", outcome: status.toLowerCase() });
    if (status === "NOT_SIGNED_IN") return notSignedIn();
    if (status === "NOT_FOUND") return json(404, { ok: false, error: "not_found", message: "Reload the page and try again." });
    return json(200, { ok: true, status: status.toLowerCase() });
  });
}

/* ------------------------------------------------------------------ */
/* View                                                                 */
/* ------------------------------------------------------------------ */

export type DraftActivation =
  | { kind: "not_approved" }
  | { kind: "active_current"; question: ActiveQuestion; version: number }
  | { kind: "active_changed"; question: ActiveQuestion; version: number }
  | { kind: "archived"; question: ActiveQuestion };

/** How each draft relates to its approved question, if it has one. */
export function draftActivation(draft: QuestionDraft, active: ActiveQuestions | null): DraftActivation {
  const question = active?.questions.find((q) => q.draftId === draft.id);
  if (!question) return { kind: "not_approved" };
  const latest = question.versions[question.versions.length - 1];
  if (!question.active) return { kind: "archived", question };
  return latest && latest.text === draft.text
    ? { kind: "active_current", question, version: latest.number }
    : { kind: "active_changed", question, version: latest?.number ?? 0 };
}
