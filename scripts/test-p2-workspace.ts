#!/usr/bin/env tsx
/**
 * P2 workspace logic (D-047): suggestions, overlap warnings, input parsing,
 * suggested investigations, the Overview comparison, the Team Brief, the
 * handlers over a fake store, and a claim-language lint of every P2 string
 * a customer sees.
 *
 * Offline: the diagnostic fixture comes from the W1 fixture site through the
 * real engine; every fetch throws. The SQL is proved separately on a real
 * PostgreSQL by scripts/test-p2-workspace-db.ts.
 */
import * as actionsModule from "@/lib/workspace/actions";
import * as briefModule from "@/lib/workspace/brief";
import * as questionsModule from "@/lib/workspace/questions";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import { parseActionRevision, parseNewAction, suggestedInvestigations } from "@/lib/workspace/actions";
import { NOT_MEASURED, briefAsText, buildTeamBrief } from "@/lib/workspace/brief";
import type { WorkspaceDeps } from "@/lib/workspace/handlers";
import { compareDiagnostics, reviewNext } from "@/lib/workspace/overview";
import { handleAddDraft, handleCreateAction, handleReviseAction, handleReviseDraft } from "@/lib/workspace/p2-handlers";
import {
  MAX_SUGGESTIONS,
  draftOverlaps,
  overlapWithDrafts,
  parseDraftRevision,
  parseNewDraft,
  suggestQuestions,
} from "@/lib/workspace/questions";
import type { BrandProfile, QuestionDraft, StoredDiagnostic, WorkspaceAction, WorkspaceState, WorkspaceStore } from "@/lib/workspace/store";
import { buildDiagnosticView } from "@/lib/workspace/view";

import { acmeSite, fixtureNet } from "./fixtures/w1/fixture-net";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID2 = "21111111-2222-4333-8444-555555555555";
const RULE_RE = /^p2\.suggest\.[a-z_]{3,40}\.v[0-9]{1,3}$/;

const profile: BrandProfile = {
  version: 2,
  companyName: "Acme Analytics",
  description: "Retail analytics",
  category: "Retail analytics software",
  audience: "independent retailers",
  competitors: ["Contoso", "Fabrikam", "Northwind", "Tailspin"],
  objective: "compare_competitors",
  basedOnRunId: null,
  savedAt: "2026-11-10T10:00:00Z",
};

function draft(id: string, text: string, status: QuestionDraft["status"] = "draft"): QuestionDraft {
  return { id, version: 1, text, category: "discovery", origin: "customer_written", suggestionRule: null, status, createdAt: "", updatedAt: "" };
}

const state: WorkspaceState = {
  status: "OK",
  workspace: { id: UUID, name: "Acme" },
  website: { domain: "acme-analytics.example", verification: "none" },
  profile,
  latestRun: null,
};

function lint(label: string, text: string): void {
  const lower = text.toLowerCase();
  const hit = FORBIDDEN_W1_PHRASES.find((p) => lower.includes(p));
  check(label, !hit, hit ? `contains “${hit}”` : "");
}

async function fixtureDiagnostic(): Promise<StoredDiagnostic> {
  const net = fixtureNet(acmeSite());
  const result = await runSiteDiagnostic("https://acme-analytics.example/", {
    transport: net.transport,
    dnsLookup: net.dnsLookup,
    now: net.clock.now,
    sleep: net.clock.sleep,
  } as Parameters<typeof runSiteDiagnostic>[1]);
  if (!result.ok) throw new Error("fixture diagnostic failed");
  const r = result.report;
  const urlOf = new Map(r.pages.filter((p) => p.pageIndex !== null).map((p) => [p.pageIndex, p.url]));
  return {
    status: "OK",
    run: {
      id: UUID,
      normalizedDomain: r.input.normalizedDomain,
      startUrl: r.input.startUrl,
      ruleSetVersion: r.ruleSetVersion,
      crawlerVersion: r.crawlerVersion,
      pageCap: r.run.pageCap,
      startedAt: r.run.startedAt,
      completedAt: r.run.completedAt,
      outcome: r.run.outcome,
      domainVerified: false,
    },
    pages: r.pages
      .filter((p) => p.pageIndex !== null)
      .map((p) => ({ pageIndex: p.pageIndex as number, url: p.url, httpStatus: p.httpStatus, contentType: p.contentType, bytes: p.bytes, robotsAllowed: p.robotsAllowed, fetchError: p.fetchError })),
    findings: r.findings.map((f) => ({
      checkId: f.checkId,
      state: f.state,
      unknownReason: f.unknownReason,
      excerpt: f.excerpt?.text ?? null,
      pageUrl: f.pageIndex === null ? null : urlOf.get(f.pageIndex) ?? null,
      ruleVersion: f.ruleVersion,
    })),
    history: [{ id: UUID, completedAt: r.run.completedAt, outcome: r.run.outcome }],
  };
}

function fakeStore(overrides: Partial<WorkspaceStore> = {}): WorkspaceStore & { calls: string[] } {
  const calls: string[] = [];
  const fail = () => {
    throw new Error("not expected");
  };
  return {
    calls,
    setWebsite: fail,
    takeDiagnosticRateLimit: fail,
    recordDiagnostic: fail,
    getDiagnostic: fail,
    saveProfile: fail,
    getState: fail,
    listDrafts: fail,
    listActions: fail,
    async addDraft(_t, _a, text, category, rule) {
      calls.push(`addDraft:${category}:${rule ?? "-"}:${text}`);
      return { status: "ADDED", draftId: UUID };
    },
    async reviseDraft(_t, _a, id, v, _text, _c, status) {
      calls.push(`reviseDraft:${id}:${v}:${status}`);
      return { status: "SAVED", version: v + 1 };
    },
    async createAction(_t, _a, evidence) {
      calls.push(`createAction:${"note" in evidence ? "note" : evidence.checkId}`);
      return { status: "CREATED", actionId: UUID };
    },
    async reviseAction(_t, _a, id, v, _f, status) {
      calls.push(`reviseAction:${id}:${v}:${status}`);
      return { status: "SAVED", version: v + 1 };
    },
    ...overrides,
  } as WorkspaceStore & { calls: string[] };
}

function deps(store: WorkspaceStore, logs: Array<Record<string, unknown>> = [], enabled = true): WorkspaceDeps {
  return {
    config: { enabled, diagnosticEnabled: true, hmacSecret: "x".repeat(32), hmacKeyId: "k1" },
    store,
    runDiagnostic: () => {
      throw new Error("not expected");
    },
    log: (entry) => logs.push(entry),
  };
}

const account = {
  accountId: UUID,
  email: "person@example.test",
  workspaceName: "Acme",
  session: { status: "ACTIVE" as const, sessionId: UUID, workspaceId: UUID, membershipId: UUID, stepUpAt: null, absoluteExpiresAt: "2026-12-01T00:00:00Z" },
};

async function main(): Promise<void> {
  console.log("test-p2-workspace");

  /* S: suggestions -------------------------------------------------- */
  check("S1 no profile, no suggestions", suggestQuestions(null, []).length === 0);
  const s = suggestQuestions(profile, []);
  check("S2 at most MAX_SUGGESTIONS", s.length > 0 && s.length <= MAX_SUGGESTIONS, String(s.length));
  check("S3 every rule id matches the database pattern", s.every((x) => RULE_RE.test(x.rule)));
  check("S4 every text fits the draft bounds", s.every((x) => x.text.length >= 8 && x.text.length <= 300));
  check("S5 compare_competitors puts comparison first", s[0]?.category === "comparison");
  check("S6 at most three vs-competitor suggestions", s.filter((x) => x.rule.startsWith("p2.suggest.vs_competitor")).length === 3);
  check("S7 the category reads in-sentence (lowercased)", s.some((x) => x.text.includes("best retail analytics software options for independent retailers")));
  const bare = suggestQuestions({ ...profile, category: null, audience: null, competitors: [], objective: null }, []);
  check("S8 rules without inputs are skipped, not filled generically", bare.length === 2 && bare.every((x) => x.text.includes("Acme Analytics")));
  check("S9 an acronym category keeps its case", suggestQuestions({ ...profile, category: "CRM", competitors: [] }, []).some((x) => x.text.includes("best CRM options")));
  const taken = suggestQuestions(profile, [draft("d1", "How much does Acme Analytics cost?")]);
  check("S10 a suggestion already drafted is left out", !taken.some((x) => x.rule.startsWith("p2.suggest.brand_pricing")));
  const archivedTaken = suggestQuestions(profile, [draft("d1", "How much does Acme Analytics cost?", "archived")]);
  check("S11 an archived draft does not hide a suggestion", archivedTaken.some((x) => x.rule.startsWith("p2.suggest.brand_pricing")));
  check("S12 suggestions are deterministic", JSON.stringify(suggestQuestions(profile, [])) === JSON.stringify(s));

  /* O: overlaps ----------------------------------------------------- */
  const ds = [
    draft("a", "What is the best retail analytics software?"),
    draft("b", "what is the BEST retail analytics software"),
    draft("c", "Which retail analytics software is the best one?"),
    draft("d", "How do I export sales data to a spreadsheet?"),
    draft("e", "What is the best retail analytics software?", "archived"),
  ];
  const ov = draftOverlaps(ds, profile);
  check("O1 punctuation and case differences are the same question", ov.get("a")?.some((w) => w.kind === "same" && w.otherId === "b") === true);
  check("O2 the relation is symmetric", ov.get("b")?.some((w) => w.otherId === "a") === true);
  check("O3 an unrelated draft has no warning", !ov.has("d"));
  check("O4 archived drafts are not compared", ![...ov.values()].flat().some((w) => w.otherId === "e"));
  check("O5 a same-key pair is not also reported as similar", (ov.get("a") ?? []).filter((w) => w.otherId === "b").length === 1);
  const brandPair = draftOverlaps([draft("x", "Is Acme Analytics good for retailers?"), draft("y", "Is acme analytics good for retailers")], profile);
  check("O6 brand mentions normalise to the same key", brandPair.get("x")?.[0]?.kind === "same");
  check("O7 overlapWithDrafts flags a proposed text", overlapWithDrafts("What is the best retail analytics software", ds, profile).length >= 1);
  check("O8 overlapWithDrafts ignores unrelated text", overlapWithDrafts("Who makes the cheapest barcode scanner?", ds, profile).length === 0);

  /* P: parsing ------------------------------------------------------ */
  check("P1 a draft is parsed and whitespace collapsed", (() => {
    const p = parseNewDraft({ text: "  What   is the best tool?\n", category: "discovery" });
    return p.ok && p.text === "What is the best tool?" && p.suggestionRule === null;
  })());
  check("P2 too short is refused", !parseNewDraft({ text: "short", category: "discovery" }).ok);
  check("P3 too long is refused", !parseNewDraft({ text: "x".repeat(301), category: "discovery" }).ok);
  check("P4 an unknown category is refused", !parseNewDraft({ text: "A good long question", category: "pricing" }).ok);
  check("P5 a malformed rule is refused", !parseNewDraft({ text: "A good long question", category: "discovery", suggestionRule: "gpt.made.it" }).ok);
  check("P6 a valid rule is kept", (() => {
    const p = parseNewDraft({ text: "A good long question", category: "discovery", suggestionRule: "p2.suggest.brand_use.v1" });
    return p.ok && p.suggestionRule === "p2.suggest.brand_use.v1";
  })());
  check("P7 a revision needs a uuid and version ≥ 1", !parseDraftRevision({ draftId: "nope", expectedVersion: 1, text: "A good long question", category: "discovery", status: "draft" }).ok && !parseDraftRevision({ draftId: UUID, expectedVersion: 0, text: "A good long question", category: "discovery", status: "draft" }).ok);
  check("P8 a revision status must be draft or archived", !parseDraftRevision({ draftId: UUID, expectedVersion: 1, text: "A good long question", category: "discovery", status: "approved" }).ok);
  const fields = { title: "Fix pricing page", observation: "No prices shown.", nextStep: "Ask web team." };
  check("P9 an action needs evidence", !parseNewAction({ ...fields }).ok);
  check("P10 a note action is parsed", (() => {
    const p = parseNewAction({ ...fields, evidence: { kind: "customer_note", note: "Heard on a sales call, 3 Nov." } });
    return p.ok && "note" in p.evidence && p.fields.whyItMatters === null && p.fields.ownerName === null;
  })());
  check("P11 a finding action needs a valid run id and check id", !parseNewAction({ ...fields, evidence: { kind: "site_diagnostic_finding", runId: "x", checkId: "page.h1" } }).ok && !parseNewAction({ ...fields, evidence: { kind: "site_diagnostic_finding", runId: UUID, checkId: "DROP TABLE" } }).ok);
  check("P12 a finding action is parsed", (() => {
    const p = parseNewAction({ ...fields, evidence: { kind: "site_diagnostic_finding", runId: UUID, checkId: "page.h1", pageUrl: "https://a.example/" } });
    return p.ok && !("note" in p.evidence) && p.evidence.pageUrl === "https://a.example/";
  })());
  check("P13 an empty owner becomes null, a long one is refused", (() => {
    const a = parseNewAction({ ...fields, ownerName: "   ", evidence: { kind: "customer_note", note: "n" } });
    const b = parseNewAction({ ...fields, ownerName: "x".repeat(121), evidence: { kind: "customer_note", note: "n" } });
    return a.ok && a.fields.ownerName === null && !b.ok;
  })());
  check("P14 an action revision needs a known status", !parseActionRevision({ ...fields, actionId: UUID, expectedVersion: 1, status: "won" }).ok);

  /* I: suggested investigations -------------------------------------- */
  const diag = await fixtureDiagnostic();
  const view = buildDiagnosticView(diag);
  const inv = suggestedInvestigations(view, []);
  check("I1 one investigation per fixable issue", inv.length === view.fixList.length && inv.length > 0, `${inv.length} vs ${view.fixList.length}`);
  check("I2 every field fits the database bounds", inv.every((i) => i.fields.title.length >= 3 && i.fields.title.length <= 160 && i.fields.observation.length <= 1000 && (i.fields.whyItMatters ?? "").length <= 1000 && i.fields.nextStep.length <= 1000));
  check("I3 each names its stored finding", inv.every((i) => i.ref.runId === UUID && view.fixList.some((f) => f.checkId === i.ref.checkId && f.pageUrl === i.ref.pageUrl)));
  check("I4 why-it-matters carries the scope statement", inv.every((i) => (i.fields.whyItMatters ?? "").includes("It does not show how any AI system answers buyers.")));
  const tracked: WorkspaceAction = {
    id: UUID2, version: 1, title: "t", observation: "o", whyItMatters: null, nextStep: "n", ownerName: null, status: "open", decisionNote: null, createdAt: "", updatedAt: "",
    evidence: { kind: "site_diagnostic_finding", runId: UUID, checkId: inv[0].ref.checkId, state: "issue", excerpt: null, pageUrl: inv[0].ref.pageUrl, ruleVersion: "1", runCompletedAt: null },
  };
  check("I5 an already tracked finding is not suggested again", suggestedInvestigations(view, [tracked]).length === inv.length - 1);
  check("I6 a closed action does not hide the suggestion", suggestedInvestigations(view, [{ ...tracked, status: "done" }]).length === inv.length);
  check("I7 no diagnostic, no suggestions", suggestedInvestigations(null, []).length === 0);

  /* C: comparison --------------------------------------------------- */
  check("C1 no diagnostic is none", compareDiagnostics(null, null).kind === "none");
  check("C2 one diagnostic is first", compareDiagnostics(diag, null).kind === "first");
  const otherRules = { ...diag, run: { ...diag.run, ruleSetVersion: "w1-older" } };
  check("C3 different rule sets are not compared", compareDiagnostics(diag, otherRules).kind === "not_comparable");
  const issue = diag.findings.find((f) => f.state === "issue") as StoredDiagnostic["findings"][number];
  const passBefore = { ...diag, findings: diag.findings.map((f) => (f === issue ? { ...f, state: "pass" as const } : f)) };
  const c4 = compareDiagnostics(diag, passBefore);
  check("C4 pass → issue is a new issue", c4.kind === "compared" && c4.newIssues.length === 1 && c4.newIssues[0].checkId === issue.checkId && c4.resolved.length === 0);
  const c5 = compareDiagnostics(passBefore, diag);
  check("C5 issue → pass is resolved", c5.kind === "compared" && c5.resolved.length === 1 && c5.newIssues.length === 0);
  const missing = { ...diag, findings: diag.findings.filter((f) => f !== issue) };
  const c6 = compareDiagnostics(missing, diag);
  check("C6 an issue absent from the newer run is not called resolved", c6.kind === "compared" && c6.resolved.length === 0);
  check("C7 identical runs report nothing", (() => {
    const c = compareDiagnostics(diag, diag);
    return c.kind === "compared" && c.newIssues.length === 0 && c.resolved.length === 0;
  })());

  /* N: review next -------------------------------------------------- */
  check("N1 no website: only add the website", JSON.stringify(reviewNext({ ...state, website: null }, [], []).map((n) => n.href)) === JSON.stringify(["/account/website"]));
  const nx = reviewNext({ ...state, latestRun: { id: UUID, completedAt: "2026-11-01T00:00:00Z", outcome: "completed", pages: 3, counts: { pass: 1, issue: 1, info: 0, unknown: 0 } } }, [], [tracked]);
  check("N2 an unowned action asks for an owner first", nx[0]?.label === "Assign an owner to 1 open action");

  /* B: brief -------------------------------------------------------- */
  const brief = buildTeamBrief({ state, view, drafts: [draft("d", "What is the best tool for shops?")], actions: [tracked], now: new Date("2026-11-10T12:00:00Z") });
  check("B1 nine sections in the agreed order", brief.sections.map((x) => x.heading.split(".")[0]).join(",") === "1,2,3,4,5,6,7,8,9");
  check("B2 the summary says nothing was measured", brief.sections[0].lines.includes(NOT_MEASURED));
  check("B3 sources and retests say none, never a placeholder", brief.sections[3].lines[0].startsWith("None yet") && brief.sections[6].lines[0].startsWith("None"));
  check("B4 the diagnostic notices are in the limitations", view.notices.every((n) => brief.sections[7].lines.includes(n)));
  check("B5 competitors are named, with no observation claimed", brief.sections[2].lines[0].includes("Contoso") && brief.sections[2].lines[1].startsWith("There are no competitor observations"));
  check("B6 an unowned action is shown as such", brief.sections[5].lines[0].includes("no owner yet"));
  const text = briefAsText(brief);
  check("B7 plain text has every heading", brief.sections.every((x) => text.includes(x.heading)));
  check("B8 the brief is deterministic for a fixed clock", briefAsText(buildTeamBrief({ state, view, drafts: [draft("d", "What is the best tool for shops?")], actions: [tracked], now: new Date("2026-11-10T12:00:00Z") })) === text);
  const empty = buildTeamBrief({ state: { ...state, profile: null }, view: null, drafts: [], actions: [], now: new Date("2026-11-10T12:00:00Z") });
  check("B9 an empty workspace still yields an honest brief", empty.sections[1].lines[0] === "No website issues were recorded." && empty.sections[0].lines.includes("The website diagnostic has not been run yet."));

  /* H: handlers ----------------------------------------------------- */
  const logs: Array<Record<string, unknown>> = [];
  const store = fakeStore();
  check("H1 accounts disabled is 404", (await handleAddDraft(deps(store, [], false), account, "tok", { text: "A good question here", category: "discovery" })).status === 404);
  check("H2 no session is 401 and nothing is stored", (await handleAddDraft(deps(store), null, null, { text: "A good question here", category: "discovery" })).status === 401 && store.calls.length === 0);
  check("H3 invalid input is 400 and nothing is stored", (await handleAddDraft(deps(store), account, "tok", { text: "short", category: "discovery" })).status === 400 && store.calls.length === 0);
  const added = await handleAddDraft(deps(store, logs), account, "tok", { text: "A good question here", category: "comparison", suggestionRule: "p2.suggest.vs_competitor.v1" });
  check("H4 a valid draft is stored once", added.status === 200 && store.calls.join() === "addDraft:comparison:p2.suggest.vs_competitor.v1:A good question here");
  check("H5 logs carry no question text", !JSON.stringify(logs).includes("good question"));
  const dup = await handleAddDraft(deps(fakeStore({ addDraft: async () => ({ status: "DUPLICATE", draftId: UUID }) })), account, "tok", { text: "A good question here", category: "discovery" });
  check("H6 DUPLICATE is 409 duplicate", dup.status === 409 && dup.body.error === "duplicate");
  const cap = await handleAddDraft(deps(fakeStore({ addDraft: async () => ({ status: "LIMIT_REACHED", draftId: null }) })), account, "tok", { text: "A good question here", category: "discovery" });
  check("H7 LIMIT_REACHED is 409 limit_reached", cap.status === 409 && cap.body.error === "limit_reached");
  const conflict = await handleReviseDraft(deps(fakeStore({ reviseDraft: async () => ({ status: "VERSION_CONFLICT", version: 3 }) })), account, "tok", { draftId: UUID, expectedVersion: 1, text: "A good question here", category: "discovery", status: "draft" });
  check("H8 VERSION_CONFLICT is 409", conflict.status === 409 && conflict.body.error === "version_conflict");
  const gone = await handleReviseDraft(deps(fakeStore({ reviseDraft: async () => ({ status: "NOT_SIGNED_IN", version: null }) })), account, "tok", { draftId: UUID, expectedVersion: 1, text: "A good question here", category: "discovery", status: "draft" });
  check("H9 a session the database rejects is 401", gone.status === 401);
  const boom = await handleAddDraft(deps(fakeStore({ addDraft: async () => { throw new Error("rpc failed (XX000)"); } }), logs), account, "tok", { text: "A good question here", category: "discovery" });
  check("H10 a store error is 500 with a generic message", boom.status === 500 && !JSON.stringify(boom.body).includes("XX000"));
  const actLogs: Array<Record<string, unknown>> = [];
  const astore = fakeStore();
  const made = await handleCreateAction(deps(astore, actLogs), account, "tok", { ...fields, evidence: { kind: "customer_note", note: "Customer said so on 3 Nov." } });
  check("H11 a note action is created", made.status === 200 && astore.calls.join() === "createAction:note");
  check("H12 action logs carry no note or title text", !JSON.stringify(actLogs).includes("Customer said") && !JSON.stringify(actLogs).includes("pricing page"));
  const tracked409 = await handleCreateAction(deps(fakeStore({ createAction: async () => ({ status: "ALREADY_TRACKED", actionId: UUID }) })), account, "tok", { ...fields, evidence: { kind: "site_diagnostic_finding", runId: UUID, checkId: "page.h1", pageUrl: null } });
  check("H13 ALREADY_TRACKED is 409", tracked409.status === 409 && tracked409.body.error === "already_tracked");
  const revised = await handleReviseAction(deps(astore), account, "tok", { ...fields, actionId: UUID, expectedVersion: 2, status: "done" });
  check("H14 an action revision passes version and status", revised.status === 200 && astore.calls.includes(`reviseAction:${UUID}:2:done`));

  /* R: request size ------------------------------------------------ */
  {
    const { readFileSync, existsSync } = await import("node:fs");
    const { ACTION_BODY_MAX_BYTES } = await import("@/lib/workspace/http");
    const { MAX_BODY_BYTES } = await import("@/lib/accounts/http");
    const emoji = "😀";
    const big = (n: number) => emoji.repeat(n);
    const worst = JSON.stringify({
      actionId: UUID, expectedVersion: 99999, status: "in_progress",
      title: big(160), observation: big(1000), whyItMatters: big(1000), nextStep: big(1000), ownerName: big(120), decisionNote: big(1000),
      evidence: { kind: "customer_note", note: big(1000) },
    });
    check("R1 the largest valid action body fits the action cap", Buffer.byteLength(worst, "utf8") <= ACTION_BODY_MAX_BYTES, String(Buffer.byteLength(worst, "utf8")));
    check("R2 the largest valid draft body fits the 4 KB account cap", Buffer.byteLength(JSON.stringify({ draftId: UUID, expectedVersion: 99999, text: "é".repeat(300), category: "use_case", status: "archived", suggestionRule: "p2.suggest." + "a".repeat(40) + ".v999" }), "utf8") <= MAX_BODY_BYTES);
    const routes = ["questions", "questions/revise", "actions", "actions/revise"].map((r) => `app/api/account/${r}/route.ts`);
    check("R3 only the two action routes raise the cap", routes.every((r) => existsSync(r) && readFileSync(r, "utf8").includes("ACTION_BODY_MAX_BYTES") === r.includes("/actions")));
    check("R4 P2 routes go through workspacePost", routes.every((r) => readFileSync(r, "utf8").includes("export const POST = workspacePost(")));
  }

  /* L: claim language ------------------------------------------------ */
  const strings: Array<[string, string]> = [];
  const collect = (prefix: string, mod: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "string") strings.push([`${prefix}.${k}`, v]);
      else if (v && typeof v === "object" && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "string") strings.push([`${prefix}.${k}.${k2}`, v2]);
    }
  };
  collect("questions", questionsModule as unknown as Record<string, unknown>);
  collect("actions", actionsModule as unknown as Record<string, unknown>);
  collect("brief", briefModule as unknown as Record<string, unknown>);
  for (const [k, v] of strings) lint(`L ${k}`, v);
  for (const x of suggestQuestions(profile, [])) lint(`L suggestion ${x.rule}`, x.text);
  lint("L brief text", text.replace(/Shows:.*$/gm, ""));
  for (const i of inv) lint(`L investigation ${i.ref.checkId}`, `${i.fields.title} ${i.fields.observation} ${i.fields.nextStep}`);

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
