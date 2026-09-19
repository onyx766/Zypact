/**
 * Phase 3 — the intervention admin UI, rendered to static markup.
 *
 * The pages themselves read through the service-role client and cannot run
 * without Supabase, so this renders the two client components that carry the
 * logic with fixture data and asserts on what a founder would see.
 *
 * The point is the negative space: every status offers exactly the moves it
 * allows. A Reject button on an approved intervention, or an Approve button
 * that is live with no evidence cited, would be a UI promising something the
 * database will refuse.
 *
 * Not covered: layout and styling. Those need a browser on staging.
 */

import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InterventionsTable, type InterventionRow } from "@/app/admin/interventions/interventions-table";
import { InterventionActionsPanel } from "@/app/admin/interventions/[interventionId]/intervention-actions-panel";

// tsx compiles component JSX with the classic transform (tsconfig keeps
// `jsx: preserve` for Next), so the components expect a global React — the
// same setup test-landing-page.ts uses.
(globalThis as unknown as { React: unknown }).React = React;

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** True when a <button> containing `text` carries the disabled attribute. */
function buttonDisabled(html: string, text: string): boolean | null {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (m[2].includes(text)) return /\bdisabled=""/.test(m[1]);
  }
  return null;
}

const row = (over: Partial<InterventionRow>): InterventionRow => ({
  id: "id", status: "proposed", hypothesis: "H", actionType: "page_created",
  actionTarget: "https://x.example", companyName: "Fixture Co", domain: "fixture.example",
  evidenceCount: 1, createdAt: "2026-09-18T00:00:00Z",
  created: { date: "Sep 18, 2026", time: "9:00 AM" }, implemented: null, eligibility: null, ...over,
});

const panel = (over: Partial<Parameters<typeof InterventionActionsPanel>[0]>) =>
  renderToStaticMarkup(createElement(InterventionActionsPanel, {
    interventionId: "iv", status: "proposed", hasEvidence: true, hasObservationWindow: true,
    eligibility: { eligible: false, reason: "INTERVENTION_NOT_IMPLEMENTED", label: "Not started", authorizedEarly: false },
    actionsEnabled: true, ...over,
  }));

console.log("\nIntervention admin UI (Phase 3)\n");

/* ═══════════ 1. the list ═══════════ */
console.log("[1] The list");
const rows: InterventionRow[] = [
  row({ id: "a", status: "proposed", hypothesis: "Proposal hypothesis" }),
  row({ id: "b", status: "implemented", hypothesis: "Live hypothesis",
    eligibility: { label: "Observing — closes Oct 9, 2026", tone: "waiting", eligible: false, windowClosesAt: "2026-10-09T00:00:00Z" } }),
  row({ id: "c", status: "implemented", hypothesis: "Early hypothesis",
    eligibility: { label: "Retest ready (early)", tone: "deviation", eligible: true, windowClosesAt: null } }),
  row({ id: "d", status: "rejected", hypothesis: "Rejected hypothesis", evidenceCount: 0 }),
  row({ id: "e", status: "abandoned", hypothesis: "Abandoned hypothesis" }),
];
const list = renderToStaticMarkup(createElement(InterventionsTable, { rows, baselines: [], actionsEnabled: true }));
check("every row renders", ["Proposal", "Live", "Early", "Rejected", "Abandoned"].every((h) => list.includes(`${h} hypothesis`)));
check("each row links to its detail page", list.includes('href="/admin/interventions/c"'));
check("the authority's eligibility label is shown for implemented rows",
  list.includes("Observing — closes Oct 9, 2026") && list.includes("Retest ready (early)"));
check("proposals say the retest has not started", list.includes("Not started"));
check("closed rows say retest does not apply", list.includes("Not applicable"));
check("tabs cover all five real statuses and nothing invented",
  ["Proposed", "Approved", "Implemented", "Rejected", "Abandoned"].every((s) => list.includes(`>${s} (`)) &&
  !/Retest pending|>Done</.test(list));
check("the retest-ready count includes the early one", /<p class="zpa-stat-value">1<\/p><p class="zpa-stat-label">Retest ready/.test(list));
check("a row with no evidence says so", list.includes("No supporting runs cited"));
check("the register button is live when actions are enabled", buttonDisabled(list, "Register intervention") === false);

const disabledList = renderToStaticMarkup(createElement(InterventionsTable, { rows, baselines: [], actionsEnabled: false }));
check("with the kill switch off, register is disabled", buttonDisabled(disabledList, "Register intervention") === true);
check("and the page says why", disabledList.includes("INTERVENTION_ADMIN_ENABLED=true"));

const empty = renderToStaticMarkup(createElement(InterventionsTable, { rows: [], baselines: [], actionsEnabled: true }));
check("an empty list explains itself", empty.includes("No interventions yet"));

/* ═══════════ 2. actions per status ═══════════ */
console.log("\n[2] Each status offers exactly its moves");

const proposed = panel({ status: "proposed" });
check("proposed: approve is live", buttonDisabled(proposed, "Approve and freeze") === false);
check("proposed: reject and abandon are offered", proposed.includes("Reject") && proposed.includes("Abandon"));
check("proposed: no implementation or early-retest action",
  !proposed.includes("Confirm implementation") && !proposed.includes("Authorize early retest"));

const noEvidence = panel({ status: "proposed", hasEvidence: false });
check("proposed without evidence: approve is disabled", buttonDisabled(noEvidence, "Approve and freeze") === true);
check("and it says what is missing", noEvidence.includes("Cite at least one supporting run"));

const approved = panel({ status: "approved" });
check("approved: confirm implementation is offered", approved.includes("Confirm implementation"));
check("approved: reject is NOT offered — the claim is frozen", !approved.includes("Reject"));
check("approved: approve is not offered again", !approved.includes("Approve and freeze"));
check("approved: abandon is offered", approved.includes("Abandon"));

const noWindow = panel({ status: "approved", hasObservationWindow: false });
check("approved with no window: no confirm button that would always fail",
  !noWindow.includes("Confirm implementation"));
check("and it explains the way out", noWindow.includes("register it again with a window"));

const observing = panel({ status: "implemented",
  eligibility: { eligible: false, reason: "OBSERVATION_WINDOW_OPEN", label: "Observing — closes Oct 9, 2026", authorizedEarly: false } });
check("implemented, window open: early retest can be authorized", observing.includes("Authorize early retest"));
check("implemented: the eligibility label is shown", observing.includes("Observing — closes Oct 9, 2026"));
check("implemented: abandon is still offered (0077 refuses it once measuring)", observing.includes("Abandon"));
check("implemented: no approve, reject or confirm",
  !observing.includes("Approve and freeze") && !observing.includes("Reject") && !observing.includes("Confirm implementation"));

const early = panel({ status: "implemented",
  eligibility: { eligible: true, reason: "AUTHORIZED_DEVIATION", label: "Retest ready (early)", authorizedEarly: true } });
check("already authorized: no second authorization offered", !early.includes("Authorize early retest"));

const elapsed = panel({ status: "implemented",
  eligibility: { eligible: true, reason: "WINDOW_ELAPSED", label: "Retest ready", authorizedEarly: false } });
check("window elapsed: no early authorization offered — there is nothing to deviate from",
  !elapsed.includes("Authorize early retest"));

for (const closed of ["rejected", "abandoned"]) {
  const html = panel({ status: closed });
  check(`${closed}: no actions at all`, !/<button/.test(html), html.match(/<button[^>]*>[^<]*/)?.[0]);
  check(`${closed}: says it is closed`, html.includes("Closed."));
}

/* ═══════════ 3. retest steps (Phase 4) ═══════════ */
console.log("\n[3] Retest steps");
const readyElig = { eligible: true, reason: "WINDOW_ELAPSED", label: "Retest ready", authorizedEarly: false };

const readyNoRetest = panel({ status: "implemented", eligibility: readyElig, retest: null });
check("eligible with no retest: create is offered", readyNoRetest.includes("Create retest protocol"));
check("and queue is not — there is nothing to queue yet", !readyNoRetest.includes("Queue retest run"));

const waiting = panel({ status: "implemented", retest: null,
  eligibility: { eligible: false, reason: "OBSERVATION_WINDOW_OPEN", label: "Observing — closes Oct 9, 2026", authorizedEarly: false } });
check("window open: create is not offered", !waiting.includes("Create retest protocol"));

const created = panel({ status: "implemented", eligibility: readyElig,
  retest: { protocolStatus: "approved", jobStatus: null, attempts: 0 } });
check("retest created, not queued: queue is offered", created.includes("Queue retest run"));
check("and it says it commits spend", created.includes("Commits spend"));
check("and create is not offered a second time", !created.includes("Create retest protocol"));
check("abandon is still offered before anything is queued", created.includes("Abandon"));

const queued = panel({ status: "implemented", eligibility: readyElig,
  retest: { protocolStatus: "approved", jobStatus: "queued", attempts: 0 } });
check("queued: no second queue button", !queued.includes("Queue retest run"));
check("queued: abandon is still possible — it would cancel the job", queued.includes("Abandon"));
check("queued: the job state is shown", queued.includes("Retest job queued"));

const measuringHtml = panel({ status: "implemented", eligibility: readyElig,
  retest: { protocolStatus: "active", jobStatus: "running", attempts: 2 } });
check("measuring: no Abandon button — 0077 would refuse it", buttonDisabled(measuringHtml, "Abandon") === null);
check("measuring: the rule is stated instead", measuringHtml.includes("can no longer be abandoned"));

const claimedNoAttempt = panel({ status: "implemented", eligibility: readyElig,
  retest: { protocolStatus: "approved", jobStatus: "claimed", attempts: 0 } });
check("claimed with no attempt yet: abandon is also withheld — an attempt may be landing",
  buttonDisabled(claimedNoAttempt, "Abandon") === null);

const done = panel({ status: "implemented", eligibility: readyElig,
  retest: { protocolStatus: "completed", jobStatus: "succeeded", attempts: 5 } });
check("completed retest: neither create nor queue is offered — one retest per intervention",
  !done.includes("Create retest protocol") && !done.includes("Queue retest run"));

const off = panel({ status: "proposed", actionsEnabled: false });
check("kill switch off: approve is disabled", buttonDisabled(off, "Approve and freeze") === true);
check("kill switch off: reject is disabled", buttonDisabled(off, "Reject") === true);
check("kill switch off: abandon is disabled", buttonDisabled(off, "Abandon") === true);

console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
if (failed > 0) process.exit(1);
