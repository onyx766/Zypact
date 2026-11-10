/**
 * Customer views built from stored P1 rows. Pure.
 *
 * The diagnostic view is reconstructed from the stored findings plus the W1
 * catalogue at the run's rule set: titles, "establishes" / "does not
 * establish" text and fix text are not stored (Q2′-2), by design.
 *
 * The profile draft is read from the homepage's own title, meta description
 * and H1 excerpts. Nothing is generated: what the site does not say is left
 * blank for the customer to fill in.
 */
import { AREA_LABELS, CHECK_AREAS, W1_CATALOG, type CheckArea, type Priority } from "@/lib/site-diagnostic/catalog";
import {
  NO_SCORE_STATEMENT,
  OUTCOME_TEXT,
  OWNERSHIP_NOT_VERIFIED,
  SAMPLE_LIMIT_STATEMENT,
  SCOPE_STATEMENT,
  UNKNOWN_REASON_TEXT,
} from "@/lib/site-diagnostic/copy";
import type { BrandProfile, StoredDiagnostic, StoredFinding, WorkspaceState } from "@/lib/workspace/store";

export interface ViewFinding {
  checkId: string;
  title: string;
  state: StoredFinding["state"];
  pageUrl: string | null;
  excerpt: string | null;
  establishes: string;
  doesNotEstablish: string;
  unknownReasonText: string | null;
  fix: string | null;
  priority: Priority;
}

export interface DiagnosticView {
  runId: string;
  domain: string;
  completedAt: string;
  outcomeText: string;
  ruleSetVersion: string;
  pagesFetched: number;
  pageCap: number;
  counts: Record<StoredFinding["state"], number>;
  notices: string[];
  areas: Array<{ area: CheckArea; label: string; findings: ViewFinding[] }>;
  fixList: ViewFinding[];
  history: StoredDiagnostic["history"];
  /** Findings whose check is not in this build's catalogue; shown, never dropped. */
  unknownChecks: number;
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function buildDiagnosticView(stored: StoredDiagnostic): DiagnosticView {
  const counts = { pass: 0, issue: 0, info: 0, unknown: 0 };
  const byArea = new Map<CheckArea, ViewFinding[]>();
  let unknownChecks = 0;

  for (const f of stored.findings) {
    counts[f.state] += 1;
    const def = W1_CATALOG.find((d) => d.checkId === f.checkId);
    if (!def) {
      unknownChecks += 1;
      continue;
    }
    const fix = f.state === "issue" ? def.fix.issue ?? null : f.state === "info" ? def.fix.info ?? null : null;
    const vf: ViewFinding = {
      checkId: f.checkId,
      title: def.title,
      state: f.state,
      pageUrl: f.pageUrl,
      excerpt: f.excerpt,
      establishes: def.establishes,
      doesNotEstablish: def.doesNotEstablish,
      unknownReasonText: f.unknownReason ? UNKNOWN_REASON_TEXT[f.unknownReason as keyof typeof UNKNOWN_REASON_TEXT] ?? f.unknownReason : null,
      fix,
      priority: def.priority,
    };
    const list = byArea.get(def.area) ?? [];
    list.push(vf);
    byArea.set(def.area, list);
  }

  const areas = CHECK_AREAS.filter((a) => byArea.has(a)).map((area) => ({
    area,
    label: AREA_LABELS[area],
    findings: byArea.get(area) as ViewFinding[],
  }));
  const fixList = areas
    .flatMap((a) => a.findings)
    .filter((f) => f.state === "issue" && f.fix)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.title.localeCompare(b.title));

  const notices = [SCOPE_STATEMENT, NO_SCORE_STATEMENT, SAMPLE_LIMIT_STATEMENT];
  if (!stored.run.domainVerified) notices.push(OWNERSHIP_NOT_VERIFIED);

  return {
    runId: stored.run.id,
    domain: stored.run.normalizedDomain,
    completedAt: stored.run.completedAt,
    outcomeText: OUTCOME_TEXT[stored.run.outcome as keyof typeof OUTCOME_TEXT] ?? stored.run.outcome,
    ruleSetVersion: stored.run.ruleSetVersion,
    pagesFetched: stored.pages.filter((p) => p.bytes > 0).length,
    pageCap: stored.run.pageCap,
    counts,
    notices,
    areas,
    fixList,
    history: stored.history,
    unknownChecks,
  };
}

export interface ProfileDraft {
  companyName: string;
  description: string | null;
  sources: string[];
}

/**
 * A starting point for the Brand Profile, taken only from the homepage's own
 * words. The customer reviews and edits everything before it is saved.
 */
export function draftProfile(state: WorkspaceState, diagnostic: StoredDiagnostic | null): ProfileDraft {
  const homepage = diagnostic?.pages.find((p) => p.pageIndex === 0)?.url ?? null;
  const onHomepage = (checkId: string) =>
    diagnostic?.findings.find((f) => f.checkId === checkId && f.pageUrl === homepage && f.excerpt)?.excerpt ?? null;

  const sources: string[] = [];
  const meta = onHomepage("page.meta_description");
  const h1 = onHomepage("page.h1");
  const title = onHomepage("page.title");
  if (meta) sources.push("your homepage's meta description");
  else if (h1) sources.push("your homepage's main heading");

  return {
    companyName: state.workspace.name,
    description: meta ?? h1 ?? null,
    sources: title && !meta && !h1 ? ["your homepage's title"] : sources,
  };
}

export const OBJECTIVE_LABELS: Record<NonNullable<BrandProfile["objective"]>, string> = {
  describe_product: "Understand how AI describes our product",
  compare_competitors: "Understand how AI compares us with competitors",
  investigate_sources: "Investigate which sources AI cites",
  review_after_change: "Review evidence after a marketing change",
};

/** Setup steps for the Overview, in order; each is done or not, never scored. */
export function setupSteps(state: WorkspaceState): Array<{ id: string; label: string; done: boolean; href: string }> {
  return [
    { id: "website", label: "Add your website", done: state.website !== null, href: "/account/website" },
    { id: "diagnostic", label: "Run the website diagnostic", done: state.latestRun !== null, href: "/account/website" },
    { id: "profile", label: "Review your Brand Profile", done: state.profile !== null, href: "/account/profile" },
    { id: "objective", label: "Choose what you want to learn first", done: Boolean(state.profile?.objective), href: "/account/profile" },
  ];
}
