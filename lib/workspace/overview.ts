/**
 * The Overview's three questions — what changed, what deserves attention,
 * what to review next — from stored workspace rows only (D-047). Pure.
 *
 * "What changed" compares the two most recent completed website diagnostics,
 * check by check and page by page, and only when both ran under the same
 * rule set; otherwise it says they are not comparable rather than reporting
 * a change the rules made. Nothing is alerted on, and nothing about AI
 * answers is said: no AI answer has been measured in a self-service
 * workspace yet.
 */
import { findingTitle } from "@/lib/workspace/actions";
import type { QuestionDraft, StoredDiagnostic, WorkspaceAction, WorkspaceState } from "@/lib/workspace/store";
import type { DiagnosticView } from "@/lib/workspace/view";

export interface FindingChange {
  checkId: string;
  title: string;
  pageUrl: string | null;
  from: string | null;
  to: string;
}

export type DiagnosticComparison =
  | { kind: "none" }
  | { kind: "first"; completedAt: string }
  | { kind: "not_comparable"; reason: string; completedAt: string; previousAt: string }
  | { kind: "compared"; completedAt: string; previousAt: string; newIssues: FindingChange[]; resolved: FindingChange[] };

const key = (checkId: string, pageUrl: string | null) => `${checkId}\u001f${pageUrl ?? ""}`;

export function compareDiagnostics(latest: StoredDiagnostic | null, previous: StoredDiagnostic | null): DiagnosticComparison {
  if (!latest) return { kind: "none" };
  if (!previous) return { kind: "first", completedAt: latest.run.completedAt };
  if (latest.run.ruleSetVersion !== previous.run.ruleSetVersion) {
    return {
      kind: "not_comparable",
      reason: "The two checks ran under different rule versions, so their results are not compared.",
      completedAt: latest.run.completedAt,
      previousAt: previous.run.completedAt,
    };
  }
  const before = new Map(previous.findings.map((f) => [key(f.checkId, f.pageUrl), f.state]));
  const newIssues: FindingChange[] = [];
  const resolved: FindingChange[] = [];
  for (const f of latest.findings) {
    const was = before.get(key(f.checkId, f.pageUrl)) ?? null;
    if (f.state === "issue" && was !== "issue") {
      newIssues.push({ checkId: f.checkId, title: findingTitle(f.checkId), pageUrl: f.pageUrl, from: was, to: f.state });
    }
    if (f.state === "pass" && was === "issue") {
      resolved.push({ checkId: f.checkId, title: findingTitle(f.checkId), pageUrl: f.pageUrl, from: was, to: f.state });
    }
  }
  // An issue whose page was not fetched this time is neither new nor
  // resolved: absence is never read as a pass.
  return { kind: "compared", completedAt: latest.run.completedAt, previousAt: previous.run.completedAt, newIssues, resolved };
}

export interface NextItem {
  label: string;
  href: string;
}

/** Ordered, rule-based next steps. Each says what to do, never how much it matters. */
export function reviewNext(state: WorkspaceState, drafts: readonly QuestionDraft[], actions: readonly WorkspaceAction[]): NextItem[] {
  const items: NextItem[] = [];
  if (!state.website) return [{ label: "Add your website", href: "/account/website" }];
  if (!state.latestRun) items.push({ label: "Run the website diagnostic", href: "/account/website" });
  if (!state.profile) items.push({ label: "Review your Brand Profile", href: "/account/profile" });
  else if (!state.profile.objective) items.push({ label: "Choose what you want to learn first", href: "/account/profile" });

  const live = actions.filter((a) => a.status === "open" || a.status === "in_progress");
  const unowned = live.filter((a) => !a.ownerName).length;
  if (unowned > 0) items.push({ label: `Assign an owner to ${unowned} open action${unowned === 1 ? "" : "s"}`, href: "/account/actions" });
  if (live.length > 0) items.push({ label: `Review ${live.length} open action${live.length === 1 ? "" : "s"}`, href: "/account/actions" });

  const liveDrafts = drafts.filter((d) => d.status === "draft").length;
  if (state.profile && liveDrafts === 0) items.push({ label: "Draft your first buyer questions", href: "/account/questions" });
  else if (liveDrafts > 0) items.push({ label: `Review ${liveDrafts} draft question${liveDrafts === 1 ? "" : "s"}`, href: "/account/questions" });

  const doneSinceRun = actions.some((a) => a.status === "done" && state.latestRun && a.updatedAt > state.latestRun.completedAt);
  if (doneSinceRun) items.push({ label: "Re-run the website diagnostic to check pages your team changed", href: "/account/website" });
  if (state.latestRun) items.push({ label: "Prepare a team brief", href: "/account/reports" });
  return items;
}

/** Diagnostic issues worth attention, highest priority first; at most `limit`. */
export function attentionItems(view: DiagnosticView | null, limit = 5) {
  if (!view) return [];
  return view.fixList.slice(0, limit);
}
