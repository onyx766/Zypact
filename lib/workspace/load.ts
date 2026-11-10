/**
 * Server-only: everything a workspace page reads, through the session-checked
 * P1/P2 functions. Pages render only what these return.
 */
import { notFound, redirect } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";
import { loadWorkspacePage, type WorkspacePageContext } from "@/lib/workspace/http";
import type { QuestionDraft, StoredDiagnostic, WorkspaceAction } from "@/lib/workspace/store";
import { buildDiagnosticView, type DiagnosticView } from "@/lib/workspace/view";

export interface WorkspaceData extends WorkspacePageContext {
  diagnostic: StoredDiagnostic | null;
  previousDiagnostic: StoredDiagnostic | null;
  view: DiagnosticView | null;
  drafts: QuestionDraft[];
  actions: WorkspaceAction[];
}

export async function loadWorkspace(options: { previous?: boolean } = {}): Promise<WorkspaceData> {
  if (!readAccountsConfig().enabled) notFound();
  const ctx = await loadWorkspacePage();
  const { deps, token, account } = ctx;

  const [diag, drafts, actions] = await Promise.all([
    deps.store.getDiagnostic(token, account.accountId),
    deps.store.listDrafts(token, account.accountId),
    deps.store.listActions(token, account.accountId),
  ]);
  if (diag.status === "NOT_SIGNED_IN" || !Array.isArray(drafts) || !Array.isArray(actions)) redirect("/account/sign-in");

  const diagnostic = diag.status === "OK" ? diag : null;
  let previousDiagnostic: StoredDiagnostic | null = null;
  if (options.previous && diagnostic) {
    const prior = diagnostic.history.find((h) => h.id !== diagnostic.run.id && h.outcome === "completed");
    if (prior) {
      const p = await deps.store.getDiagnostic(token, account.accountId, prior.id);
      if (p.status === "OK") previousDiagnostic = p;
    }
  }
  return {
    ...ctx,
    diagnostic,
    previousDiagnostic,
    view: diagnostic ? buildDiagnosticView(diagnostic) : null,
    drafts,
    actions,
  };
}
