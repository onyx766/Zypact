/**
 * P2 workspace handlers (D-047): draft buyer questions and actions. Pure
 * decisions over injected dependencies, as P1's handlers.ts; the database
 * re-checks the session on every call and takes the workspace from it.
 *
 * No paid call, no model call, and nothing that starts a measurement.
 */
import type { AccountContext } from "@/lib/accounts/handlers";
import { parseActionRevision, parseNewAction } from "@/lib/workspace/actions";
import { guarded, invalid, json, notSignedIn, type WorkspaceDeps, type WorkspaceResult } from "@/lib/workspace/handlers";
import { LIVE_DRAFT_LIMIT, parseDraftRevision, parseNewDraft } from "@/lib/workspace/questions";
import type { ReviseStatus } from "@/lib/workspace/store";

const RELOAD = "This was changed somewhere else. Reload the page to see the latest version.";

function reviseResult(status: ReviseStatus, version: number | null, what: "draft" | "action"): WorkspaceResult {
  switch (status) {
    case "SAVED":
    case "UNCHANGED":
      return json(200, { ok: true, version, unchanged: status === "UNCHANGED" });
    case "NOT_SIGNED_IN":
      return notSignedIn();
    case "NOT_FOUND":
      return json(404, { ok: false, error: "not_found", message: "Reload the page and try again." });
    case "VERSION_CONFLICT":
      return json(409, { ok: false, error: "version_conflict", message: RELOAD });
    case "DUPLICATE":
      return json(409, { ok: false, error: "duplicate", message: "Another draft already has exactly this wording." });
    case "LIMIT_REACHED":
      return json(409, {
        ok: false,
        error: "limit_reached",
        message: what === "draft" ? `You can keep up to ${LIVE_DRAFT_LIMIT} drafts. Archive one first.` : "You have reached the limit of open actions. Close one first.",
      });
  }
}

export function handleAddDraft(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_add_draft", account, token, async (acct, tok) => {
    const parsed = parseNewDraft(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const added = await deps.store.addDraft(tok, acct.accountId, parsed.text, parsed.category, parsed.suggestionRule);
    deps.log({ event: "workspace_add_draft", outcome: added.status.toLowerCase(), suggested: parsed.suggestionRule !== null });
    switch (added.status) {
      case "ADDED":
        return json(200, { ok: true, draftId: added.draftId });
      case "DUPLICATE":
        return json(409, { ok: false, error: "duplicate", message: "You already have a draft with exactly this wording." });
      case "LIMIT_REACHED":
        return json(409, { ok: false, error: "limit_reached", message: `You can keep up to ${LIVE_DRAFT_LIMIT} drafts. Archive one first.` });
      case "NOT_SIGNED_IN":
        return notSignedIn();
    }
  });
}

export function handleReviseDraft(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_revise_draft", account, token, async (acct, tok) => {
    const parsed = parseDraftRevision(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const saved = await deps.store.reviseDraft(tok, acct.accountId, parsed.draftId, parsed.expectedVersion, parsed.text, parsed.category, parsed.status);
    deps.log({ event: "workspace_revise_draft", outcome: saved.status.toLowerCase() });
    return reviseResult(saved.status, saved.version, "draft");
  });
}

export function handleCreateAction(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_create_action", account, token, async (acct, tok) => {
    const parsed = parseNewAction(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const created = await deps.store.createAction(tok, acct.accountId, parsed.evidence, parsed.fields);
    deps.log({ event: "workspace_create_action", outcome: created.status.toLowerCase(), evidence: "note" in parsed.evidence ? "customer_note" : "finding" });
    switch (created.status) {
      case "CREATED":
        return json(200, { ok: true, actionId: created.actionId });
      case "ALREADY_TRACKED":
        return json(409, { ok: false, error: "already_tracked", message: "An open action already tracks this finding." });
      case "EVIDENCE_NOT_FOUND":
        return json(409, { ok: false, error: "evidence_not_found", message: "That finding is no longer available. Reload the page." });
      case "LIMIT_REACHED":
        return json(409, { ok: false, error: "limit_reached", message: "You have reached the limit of open actions. Close one first." });
      case "NOT_SIGNED_IN":
        return notSignedIn();
    }
  });
}

export function handleReviseAction(deps: WorkspaceDeps, account: AccountContext | null, token: string | null, input: Record<string, unknown>): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_revise_action", account, token, async (acct, tok) => {
    const parsed = parseActionRevision(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const saved = await deps.store.reviseAction(tok, acct.accountId, parsed.actionId, parsed.expectedVersion, parsed.fields, parsed.status, parsed.decisionNote);
    deps.log({ event: "workspace_revise_action", outcome: saved.status.toLowerCase(), status: parsed.status });
    return reviseResult(saved.status, saved.version, "action");
  });
}
