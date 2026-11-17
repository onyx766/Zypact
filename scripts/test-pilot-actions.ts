#!/usr/bin/env tsx
/**
 * D-057 — suggested actions in a pilot, offline.
 *
 *   P  the rules, the copy and the action builder are pure;
 *   F  an action version needs every field and 1-10 well-formed links;
 *   L  the wording lint: METHODOLOGY §19, causal and promise wording, the
 *      repository's claim-language list; it runs at save and at build;
 *   S  only each action's latest version, reviewed and not withdrawn, is
 *      reportable; an edit after a review is a draft again;
 *   R  the report: the section on the page and in the Markdown from one
 *      presentation model, the fixed note, every link re-checked (a source
 *      not in the answer, an answer outside the pilot, not completed,
 *      tampered or retired blocks it), any action holds it for review, no
 *      section without a reviewed action;
 *   T  the routes: founder guard first, lint and evidence checks before the
 *      save, closed log fields; the console's client code loads no server
 *      module;
 *   M  the migration's contract: append-only tables, RLS, privileges, the
 *      evidence trigger, refusals before any write, and
 *      save_pilot_report_artifact redefined byte for byte apart from its
 *      marked block;
 *   D  the decision, the status and the runbook are written.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

(require("node:module") as { _extensions: Record<string, unknown> })._extensions[".css"] = () => undefined;

import {
  ACTIONS_HEADING,
  ACTIONS_NOT_REGISTERED_NOTE,
  ACTIONS_NOTE,
} from "@/lib/reports/pilot-report-copy";
import {
  lintPilotActionText,
  METHODOLOGY_19_PHRASES,
  parseSavePilotAction,
  pilotActionStatus,
  PILOT_ACTION_PROMISE_PHRASES,
  PILOT_ACTION_TEXT_FIELDS,
  reportableActionVersions,
  type PilotActionEventRow,
  type PilotActionVersionRow,
} from "@/lib/pilots/action-rules";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { buildPilotReport, type PilotReportInput, type PilotReportQuestionInput } from "@/lib/reports/build-pilot-report";
import type { PilotReportActionInput } from "@/lib/reports/build-pilot-actions";
import { runOrdinalsByAttemptId } from "@/lib/reports/build-protocol-report";
import { evaluatePilotReportIntegrity } from "@/lib/reports/pilot-report-integrity";
import { presentationStrings, presentPilotReport } from "@/lib/reports/pilot-report-presentation";
import type { PilotReportPayload } from "@/lib/reports/pilot-report-types";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";
import type { BuildProtocolReportInput, EvidenceAttemptInput, EvidenceResultInput } from "@/lib/reports/protocol-report-types";

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
const read = (p: string) => readFileSync(p, "utf8");

/* ---------------------------------------------------------------- fixtures */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PILOT = "22222222-2222-4222-8222-222222222222";
const COMPANY = "Acme Analytics";
const DOMAIN = "acme.test";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let seq = 0;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const G2 = "https://www.g2.com/categories/analytics";
const REDDIT = "https://www.reddit.com/r/analytics/comments/abc";

function sonarBody(content: string, cited: string[], extra: string[] = []): string {
  return JSON.stringify({
    id: "resp",
    model: "sonar",
    choices: [{ message: { role: "assistant", content } }],
    citations: cited,
    search_results: [...cited, ...extra].map((u, i) => ({ title: `Source ${i + 1}`, url: u })),
  });
}

interface RunSpec {
  status: "completed" | "failed";
  body?: string;
}

function evidence(protocolId: string, runs: RunSpec[]): BuildProtocolReportInput {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  runs.forEach((r, i) => {
    const id = uid(++seq);
    const probeRunId = uid(++seq);
    attempts.push({
      id,
      attemptKind: "baseline",
      status: r.status,
      baselineOrdinal: i + 1,
      probeRunId,
      retryOfAttemptId: null,
      terminationReason: r.status === "failed" ? "provider_error" : null,
    });
    if (r.status === "completed") {
      const body = r.body ?? sonarBody("Options include Vanta [1].", [G2], [REDDIT]);
      results.push({
        probeRunId,
        clientMentioned: i % 2 === 0,
        clientPosition: null,
        competitorsMentioned: ["Vanta"],
        sourcesCited: [],
        answerSummary: "summary",
        rawResponseSha256: sha(body),
        rawResponse: body,
        providerModel: "sonar",
        providerLatencyMs: 1000,
      });
    }
  });
  const question = "Which analytics tools suit a small team?";
  return {
    snapshotRequestId: protocolId,
    projectId: PROJECT,
    subject: { companyName: COMPANY, websiteUrl: DOMAIN, normalizedDomain: DOMAIN },
    question: { text: question, hash: sha(question), versionNumber: 1, intentType: "shortlist", provenance: "operator", approvedAt: "2026-11-18T00:00:00Z" },
    protocol: {
      id: protocolId,
      provider: "perplexity_sonar",
      surface: "answer",
      model: "sonar",
      plannedBaselineRuns: 5,
      unitOfAnalysis: "buyer_question_version",
      primaryMetric: "presence_rate",
      methodologyVersion: "1",
      analyzerVersion: 1,
      entityResolutionVersion: 1,
      approvedAt: "2026-11-18T00:00:00Z",
    },
    attempts,
    results,
  };
}

function question(ordinal: number, runs: RunSpec[], retiredAt: string | null = null): PilotReportQuestionInput {
  const protocolId = uid(9000 + ordinal);
  return {
    pilotQuestionId: uid(8000 + ordinal),
    ordinal,
    provenance: "customer_supplied",
    customerApprovedOn: "2026-11-18",
    retiredAt,
    slots: [
      {
        engine: "perplexity_sonar",
        protocolId,
        jobStatus: "succeeded",
        evidence: evidence(protocolId, runs),
        execution: { firstOn: "2026-11-18", lastOn: "2026-11-19" },
        answerModes: ["live_perplexity"],
      },
    ],
  };
}

const FIVE: RunSpec[] = [{ status: "completed" }, { status: "completed" }, { status: "failed" }, { status: "completed" }, { status: "completed" }];

function input(questions: PilotReportQuestionInput[], actions: PilotReportActionInput[]): PilotReportInput {
  return {
    pilot: {
      id: PILOT,
      projectId: PROJECT,
      companyName: COMPANY,
      websiteUrl: `https://${DOMAIN}`,
      normalizedDomain: DOMAIN,
      startsOn: "2026-11-18",
      endsOn: "2027-02-16",
      status: "active",
    },
    questions,
    actions,
    now: NOW,
  };
}

const TEXT = {
  title: "Add a comparison page against Vanta",
  observation: "In question 1, the answers that named Vanta cited a G2 category page; none cited the customer's own site.",
  suggestedAction: "Publish a plain comparison page with Vanta, and keep the G2 profile current.",
  whyItMightMatter: "One hypothesis: the engine draws on pages that compare products directly, and the customer has none.",
  alternativeExplanations: "The engine may favour G2 for reasons unrelated to the content of any comparison page.",
  openQuestions: "Whether the engine would read a new page at all within the pilot, and how answers vary over time.",
};

function action(n: number, evidenceLinks: { attemptId: string; sourceUrl: string | null }[], over: Partial<typeof TEXT> = {}): PilotReportActionInput {
  return {
    ...TEXT,
    ...over,
    actionId: uid(7000 + n),
    versionId: uid(7100 + n),
    versionNumber: 1,
    reviewedAt: "2026-11-20T09:00:00Z",
    evidence: evidenceLinks,
  };
}

/* A rendered page, as a reader sees it. */
(globalThis as unknown as { React: unknown }).React = require("react");
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
const { PilotReportView } = require("@/components/report/pilot-report-view") as { PilotReportView: unknown };
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const renderPage = (payload: PilotReportPayload) =>
  textOf(renderToStaticMarkup(createElement(PilotReportView, { payload, revision: 1, sharedAt: "2026-11-20T10:00:00Z", newerSharedRevision: false })));
const flat = (t: string) => t.replace(/\s+/g, " ").trim();
const GOOD_SIGNALS = { hasApprovedProtocol: true, hasApprovedSamplePlan: true, hasPaidCallReservation: true, hasCompleteEvidenceHashes: true };
function integrityOf(built: ReturnType<typeof buildPilotReport>) {
  return evaluatePilotReportIntegrity({
    markdown: renderPilotReportMarkdown(built.payload),
    pageText: presentationStrings(presentPilotReport(built.payload)),
    structural: built.structural,
    questionSignals: built.payload.questions.flatMap((q) =>
      q.measurements.map((m) => ({ ordinal: q.ordinal, engine: m.engine, retired: q.retired, completedAttempts: m.counts.completed, signals: GOOD_SIGNALS }))
    ),
  });
}

/* ---------------------------------------------------------------- P */

console.log("test-pilot-actions");
const PURE = ["lib/pilots/action-rules.ts", "lib/pilots/action-copy.ts", "lib/reports/build-pilot-actions.ts"];
const FORBIDDEN_IMPORT = /from "(@supabase|@\/lib\/db|@\/lib\/probes|openai|@anthropic-ai|@\/lib\/protocol-worker|@\/lib\/reports\/service-client|next\/)/;
check("P1 the rules, the copy and the action builder import no database, provider, model or framework module",
  PURE.every((f) => !FORBIDDEN_IMPORT.test(read(f))), PURE.filter((f) => FORBIDDEN_IMPORT.test(read(f))).join(","));
check("P2 none of them calls fetch", PURE.every((f) => !/\bfetch\(/.test(read(f))));
check("P3 the console's copy module has no imports at all, so client code can load it", !/^import /m.test(read("lib/pilots/action-copy.ts")));

/* ---------------------------------------------------------------- F */

const KEY = "33333333-3333-4333-8333-333333333333";
const ATT = "44444444-4444-4444-8444-444444444444";
const body = (over: Record<string, unknown> = {}) => ({ ...TEXT, evidence: [{ attemptId: ATT, sourceUrl: null }], idempotencyKey: KEY, ...over });
const good = parseSavePilotAction(body());
check("F1 a complete action with one linked answer parses, as a new action", good.ok && good.value.actionId === null && good.value.expectedVersion === null && good.value.evidence.length === 1);
check("F2 every text field is required",
  PILOT_ACTION_TEXT_FIELDS.every((f) => {
    const r = parseSavePilotAction(body({ [f.key]: "" }));
    return !r.ok && (r.issues[f.key]?.length ?? 0) > 0;
  }));
check("F3 every text field has a maximum",
  PILOT_ACTION_TEXT_FIELDS.every((f) => {
    const r = parseSavePilotAction(body({ [f.key]: "a".repeat(f.max + 1) }));
    return !r.ok && (r.issues[f.key]?.length ?? 0) > 0;
  }));
check("F4 at least one and at most ten linked answers",
  !parseSavePilotAction(body({ evidence: [] })).ok &&
  !parseSavePilotAction(body({ evidence: Array.from({ length: 11 }, (_, i) => ({ attemptId: uid(500 + i), sourceUrl: null })) })).ok &&
  parseSavePilotAction(body({ evidence: Array.from({ length: 10 }, (_, i) => ({ attemptId: uid(500 + i), sourceUrl: null })) })).ok);
check("F5 a link needs an attempt id and, if any, an http(s) source",
  !parseSavePilotAction(body({ evidence: [{ attemptId: "nope", sourceUrl: null }] })).ok &&
  !parseSavePilotAction(body({ evidence: [{ attemptId: ATT, sourceUrl: "ftp://x.example/file" }] })).ok &&
  !parseSavePilotAction(body({ evidence: [{ attemptId: ATT, sourceUrl: "http://x" }] })).ok &&
  parseSavePilotAction(body({ evidence: [{ attemptId: ATT, sourceUrl: G2 }] })).ok);
check("F6 the same answer and source cannot be linked twice",
  !parseSavePilotAction(body({ evidence: [{ attemptId: ATT, sourceUrl: G2 }, { attemptId: ATT, sourceUrl: G2 }] })).ok &&
  parseSavePilotAction(body({ evidence: [{ attemptId: ATT, sourceUrl: G2 }, { attemptId: ATT, sourceUrl: null }] })).ok);
check("F7 an edit names the action and the version it edits, both or neither",
  parseSavePilotAction(body({ actionId: uid(1), expectedVersion: 2 })).ok &&
  !parseSavePilotAction(body({ actionId: uid(1) })).ok &&
  !parseSavePilotAction(body({ expectedVersion: 2 })).ok);
check("F8 a form needs its idempotency key", !parseSavePilotAction(body({ idempotencyKey: "" })).ok);

/* ---------------------------------------------------------------- L */

check("L1 every METHODOLOGY §19 phrase is refused", METHODOLOGY_19_PHRASES.every((p) => lintPilotActionText(`We think ${p} here.`).includes(p)));
check("L2 causal and promise wording is refused",
  ["This will improve your answers.", "A page will increase mentions.", "We guarantee it.", "It is guaranteed.", "The missing page caused this.",
    "Because of this page you are absent.", "This ensures citations.", "To boost your ranking, publish."].every((t) => lintPilotActionText(t).length > 0));
check("L3 the repository's claim-language list is refused too", FORBIDDEN_W1_PHRASES.every((p) => lintPilotActionText(`Note: ${p}.`).length > 0));
check("L4 case and typographic apostrophes do not hide a phrase",
  lintPilotActionText("WILL IMPROVE").length > 0 && lintPilotActionText("AI buyers can’t find you").length > 0);
check("L5 a hypothesis worded as one passes, and a phrase only matches at a word start",
  lintPilotActionText(TEXT.whyItMightMatter).length === 0 && lintPilotActionText("The post was censured by moderators.").length === 0 &&
  Object.values(TEXT).every((t) => lintPilotActionText(t).length === 0));
const linted = parseSavePilotAction(body({ suggestedAction: "Publish a page; it will improve how often you are named." }));
check("L6 a lint hit refuses the save, on the field that has it", !linted.ok && (linted.issues.suggestedAction?.[0] ?? "").includes("will improve"));
check("L7 the promise list covers the words the decision names",
  ["will improve", "will increase", "guarantee", "caused", "because of this page", "ensure", "boost your ranking"].every((p) => PILOT_ACTION_PROMISE_PHRASES.includes(p)));

/* ---------------------------------------------------------------- S */

const A = uid(1);
const v = (id: number, n: number): PilotActionVersionRow => ({ id: uid(id), actionId: A, versionNumber: n });
const reviewed = (id: number, at = "2026-11-19T00:00:00Z"): PilotActionEventRow => ({ actionId: A, actionVersionId: uid(id), event: "reviewed", createdAt: at });
const withdrawn: PilotActionEventRow = { actionId: A, actionVersionId: null, event: "withdrawn", createdAt: "2026-11-20T00:00:00Z" };
check("S1 a version never reviewed is a draft and not reportable",
  pilotActionStatus(A, [v(11, 1)], []).status === "draft" && reportableActionVersions([A], [v(11, 1)], []).length === 0);
check("S2 a reviewed latest version is reportable, with its review date",
  JSON.stringify(reportableActionVersions([A], [v(11, 1)], [reviewed(11)])) === JSON.stringify([{ actionId: A, versionId: uid(11), reviewedAt: "2026-11-19T00:00:00Z" }]));
check("S3 an edit after a review is a draft again, and the older reviewed version is not shown instead",
  pilotActionStatus(A, [v(11, 1), v(12, 2)], [reviewed(11)]).status === "draft" &&
  reportableActionVersions([A], [v(11, 1), v(12, 2)], [reviewed(11)]).length === 0);
check("S4 once the edit is reviewed, it is the version shown",
  reportableActionVersions([A], [v(11, 1), v(12, 2)], [reviewed(11), reviewed(12, "2026-11-20T00:00:00Z")])[0]?.versionId === uid(12));
check("S5 a withdrawn action is never shown, reviewed or not",
  pilotActionStatus(A, [v(11, 1)], [reviewed(11), withdrawn]).status === "withdrawn" &&
  reportableActionVersions([A], [v(11, 1)], [reviewed(11), withdrawn]).length === 0);

/* ---------------------------------------------------------------- R */

const q1 = question(1, FIVE);
const q2 = question(2, FIVE);
const a1 = q1.slots[0].evidence.attempts;
const okLink = { attemptId: a1[0].id, sourceUrl: G2 };
const built = buildPilotReport(input([q1, q2], [action(1, [okLink, { attemptId: a1[1].id, sourceUrl: REDDIT }, { attemptId: q2.slots[0].evidence.attempts[3].id, sourceUrl: null }])]));
const p = built.payload;
const integ = integrityOf(built);
check("R1 a reviewed action reaches the payload with every link resolved, and the manifest lists its version",
  p.actions?.length === 1 && p.actions[0].evidence.length === 3 && built.manifest.actionVersions.join() === uid(7101) &&
  p.actions[0].evidence[0].sourceCited === true && p.actions[0].evidence[0].sourceDomain === "g2.com" &&
  p.actions[0].evidence[0].rawResponseSha256 === q1.slots[0].evidence.results[0].rawResponseSha256);
check("R2 a source the engine returned but the answer does not cite is labelled so",
  p.actions?.[0].evidence[1].sourceCited === false && p.actions?.[0].evidence[2].sourceUrl === null);
const ordinals = runOrdinalsByAttemptId(a1);
check("R3 each link's answer number is the run number the question's own report uses",
  p.actions?.[0].evidence[0].answerNumber === ordinals.get(a1[0].id) && p.actions?.[0].evidence[0].ordinal === 1 &&
  p.actions?.[0].evidence[2].ordinal === 2);
check("R4 any action holds the report for review, and a good one does not block it",
  integ.status === "needs_review" && integ.reasons.some((r) => r.includes("suggested action")) && !built.structural.some((s) => s.status === "blocked"));
const md = renderPilotReportMarkdown(p);
const page = renderPage(p);
const strings = presentationStrings(presentPilotReport(p));
check("R5 the page and the Markdown both carry the section, the fixed note and the testing note",
  [page, md].every((t) => t.includes(ACTIONS_HEADING) && flat(t).includes(ACTIONS_NOTE) && flat(t).includes(ACTIONS_NOT_REGISTERED_NOTE)));
check("R6 the fixed note is the decision's wording, exactly",
  ACTIONS_NOTE === "Suggested by the Zypact team from the answers above. These are hypotheses to test, not predictions; we can't say any change will alter what an AI engine answers.");
check("R7 every field and every link is shown, on the page and in the Markdown",
  Object.values(TEXT).every((t) => flat(page).includes(t) && md.includes(t)) &&
  ["Question 1, Perplexity answer 1", "Question 2, Perplexity answer 4", "cited in that answer", "returned by the engine but not cited in that answer"].every((w) => page.includes(w) && md.includes(w)));
check("R8 every presentation string appears on the page and in the Markdown",
  strings.every((t) => flat(page).includes(flat(t)) && (flat(md).includes(flat(t)) || flat(md).includes(flat(t).replace(/\|/g, "\\|")))),
  strings.filter((t) => !flat(page).includes(flat(t))).slice(0, 2).join(" | "));
check("R9 no stored code reaches the page or the Markdown",
  ["perplexity_sonar", "integrity_passed", "needs_review", "customer_supplied", "reviewed_at", "version_id"].every((c) => !page.includes(c) && !md.includes(c)));
const viewSrc = read("components/report/pilot-report-view.tsx");
const mdSrc = read("lib/reports/render-pilot-report-markdown.ts");
check("R10 the page and the Markdown render the section from the presentation model, never the payload",
  !/payload\.actions/.test(viewSrc) && !/payload\.actions/.test(mdSrc) && /v\.actions/.test(viewSrc) && /v\.actions/.test(mdSrc));

const none = buildPilotReport(input([q1, q2], []));
const nonePage = renderPage(none.payload);
check("R11 with no reviewed action there is no section at all, and nothing in the manifest",
  presentPilotReport(none.payload).actions === null && !nonePage.includes(ACTIONS_HEADING) && !nonePage.includes(ACTIONS_NOTE) &&
  !renderPilotReportMarkdown(none.payload).includes(ACTIONS_HEADING) && none.manifest.actionVersions.length === 0 &&
  !none.structural.some((s) => s.reason.includes("suggested action")));

const blocks = (actions: PilotReportActionInput[], questions = [q1, q2]) => {
  const b = buildPilotReport(input(questions, actions));
  return integrityOf(b).status === "blocked" && b.structural.some((s) => s.status === "blocked");
};
check("R12 a source that is not among that answer's sources blocks the report",
  blocks([action(2, [{ attemptId: a1[0].id, sourceUrl: "https://www.example.com/not-in-the-answer" }])]));
check("R13 an answer that is not one of this pilot's blocks it", blocks([action(3, [{ attemptId: uid(424242), sourceUrl: null }])]));
check("R14 an answer that did not complete blocks it", blocks([action(4, [{ attemptId: a1[2].id, sourceUrl: null }])]));
const tampered = question(3, FIVE);
tampered.slots[0].evidence.results[0] = { ...tampered.slots[0].evidence.results[0], rawResponse: `${tampered.slots[0].evidence.results[0].rawResponse} ` };
check("R15 an answer whose stored response no longer matches its fingerprint blocks it",
  blocks([action(5, [{ attemptId: tampered.slots[0].evidence.attempts[0].id, sourceUrl: null }])], [q1, tampered]));
check("R16 wording an action may not use blocks it, whatever the database holds",
  blocks([action(6, [okLink], { suggestedAction: "Publish a comparison page; it will improve how often you are named." })]));
const retired = question(4, FIVE, "2026-11-19T00:00:00Z");
check("R17 an answer to a question retired since blocks it", blocks([action(7, [{ attemptId: retired.slots[0].evidence.attempts[0].id, sourceUrl: null }])], [q1, retired]));
check("R18 a blocked action is still listed in the payload, so the founder's preview shows why",
  buildPilotReport(input([q1], [action(8, [{ attemptId: uid(424243), sourceUrl: null }])])).payload.actions?.length === 1);
check("R19 two actions keep their order and their numbers",
  presentPilotReport(buildPilotReport(input([q1, q2], [action(1, [okLink]), action(2, [okLink], { title: "Keep the G2 profile current" })])).payload)
    .actions?.actions.map((a) => a.heading).join("|") === `1. ${TEXT.title}|2. Keep the G2 profile current`);
const copyTexts = [ACTIONS_NOTE, ACTIONS_NOT_REGISTERED_NOTE, ACTIONS_HEADING].join("\n").toLowerCase();
check("R20 the section's own words use no forbidden phrase", [...FORBIDDEN_W1_PHRASES, ...METHODOLOGY_19_PHRASES].every((ph) => !copyTexts.includes(ph)));

/* ---------------------------------------------------------------- T */

const ROUTES = {
  save: "app/api/internal/pilots/[pilotId]/actions/route.ts",
  evidence: "app/api/internal/pilots/[pilotId]/actions/evidence/route.ts",
  review: "app/api/internal/pilots/[pilotId]/actions/[actionId]/review/route.ts",
  withdraw: "app/api/internal/pilots/[pilotId]/actions/[actionId]/withdraw/route.ts",
};
const src = Object.fromEntries(Object.entries(ROUTES).map(([k, f]) => [k, read(f)])) as Record<keyof typeof ROUTES, string>;
check("T1 every route checks the founder before it reads the request or the database",
  Object.values(src).every((s) => {
    const guard = s.indexOf("requireFounderForRoute(");
    const firstRead = Math.min(...["request.json()", "getReportServiceClient()", "new URL(request.url)"].map((m) => (s.indexOf(m) < 0 ? Infinity : s.indexOf(m))));
    return guard > 0 && guard < firstRead;
  }));
check("T2 the save route lints and checks the links before the database write",
  src.save.indexOf("parseSavePilotAction(") < src.save.indexOf("verifyActionEvidence(") &&
  src.save.indexOf("verifyActionEvidence(") < src.save.indexOf("savePilotAction(client"));
const logBlocks = Object.values(src).flatMap((s) => [...s.matchAll(/console\.info\(\s*JSON\.stringify\(\{([\s\S]*?)\}\)\s*\);/g)].map((m) => m[1]));
check("T3 the routes log closed fields only: no wording, reason, source or question text",
  logBlocks.length === 4 && logBlocks.every((b) => !/title|observation|suggested|why|alternative|openQuestions|reason|sourceUrl|summary|text/i.test(b)),
  String(logBlocks.length));
check("T4 the evidence route only reads; the others only write through their functions",
  /export async function GET/.test(src.evidence) && !/export async function POST/.test(src.evidence) &&
  ["save", "review", "withdraw"].every((k) => /export async function POST/.test(src[k as keyof typeof src]) && !/\.from\(/.test(src[k as keyof typeof src])));
const panel = read("app/admin/pilots/pilot-action-forms.tsx");
check("T5 the console's client panel loads only the import-free copy module, never the rules or the store",
  /"use client"/.test(panel) && /from "@\/lib\/pilots\/action-copy"/.test(panel) && !/action-rules|action-store|@\/lib\/reports\/|node:/.test(panel));
check("T6 a source is picked from the answer's own sources: the panel has no free-text URL field",
  !/type="url"/.test(panel) && !/placeholder="https?:/.test(panel) && /answer\.sources\.map/.test(panel));
const proc = read("lib/reports/process-pilot-report.ts");
check("T7 a report build reads the reviewed actions and hands them to the builder",
  proc.indexOf("readReportableActions(client, pilotId)") > 0 && proc.indexOf("readReportableActions(") < proc.indexOf("buildPilotReport({"));
const adminPage = read("app/admin/pilots/[pilotId]/page.tsx");
check("T8 the pilot page shows the actions panel, offering only live questions", /<PilotActionsPanel/.test(adminPage) && /q\.retiredAt === null/.test(adminPage));
const store = read("lib/pilots/action-store.ts");
check("T9 the store writes only through the three functions", ["save_pilot_action", "review_pilot_action", "withdraw_pilot_action"].every((f) => store.includes(`rpc("${f}"`)) &&
  !/\.(insert|update|upsert|delete)\(/.test(store));

/* ---------------------------------------------------------------- M */

const MIG = read("supabase/migrations/20261120120000_pilot_actions.sql");
const OLD = read("supabase/migrations/20261119120000_pilot_report_artifacts.sql");
const TABLES = ["pilot_actions", "pilot_action_versions", "pilot_action_evidence", "pilot_action_events"];
check("M1 four tables, RLS on each, and service_role may only read them",
  TABLES.every((t) =>
    new RegExp(`create table if not exists public\\.${t} \\(`).test(MIG) &&
    MIG.includes(`alter table public.${t} enable row level security;`) &&
    MIG.includes(`revoke all on table public.${t} from public, anon, authenticated, service_role;`) &&
    MIG.includes(`grant select on table public.${t} to service_role;`)) &&
  !/create policy/i.test(MIG));
check("M2 every table is append-only: a trigger refuses every update and delete",
  TABLES.every((t) => new RegExp(`before update or delete on public\\.${t}\\s+for each row execute function public\\.pilot_actions_append_only\\(\\)`).test(MIG)));
check("M3 the trigger functions are executable by no role",
  ["pilot_actions_append_only()", "pilot_action_evidence_check()"].every((f) =>
    MIG.includes(`revoke all on function public.${f} from public, anon, authenticated, service_role;`)));
check("M4 every inserted link must be a completed answer of this pilot with a stored hash",
  /before insert on public\.pilot_action_evidence/.test(MIG) &&
  /pq\.pilot_id = new\.pilot_id[\s\S]*a\.status = 'completed'[\s\S]*r\.raw_response_sha256 is not null/.test(MIG) &&
  /foreign key \(attempt_id, project_id\)\s+references public\.protocol_attempts \(id, project_id\)/.test(MIG));
const FNS = [
  "save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid)",
  "review_pilot_action(uuid, uuid, integer, uuid, boolean)",
  "withdraw_pilot_action(uuid, uuid, uuid, text)",
  "save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz)",
];
check("M5 the functions are executable by service_role only",
  FNS.every((f) => ["public", "anon", "authenticated"].every((r) => MIG.includes(`revoke all on function public.${f} from ${r};`)) &&
    MIG.includes(`grant execute on function public.${f} to service_role;`)));
const defs = [...MIG.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\n\$\$;/g)];
check("M6 every function pins its search_path, and the three writers are security definer",
  defs.length === 6 && defs.every((d) => /set search_path = public, pg_temp/.test(d[2])) &&
  ["save_pilot_action", "review_pilot_action", "withdraw_pilot_action", "save_pilot_report_artifact"].every((n) =>
    defs.some((d) => d[1] === n && /security definer/.test(d[2]))));
const saveAction = defs.find((d) => d[1] === "save_pilot_action")?.[2] ?? "";
check("M7 save_pilot_action refuses before it writes: every refusal comes before the first insert",
  saveAction.lastIndexOf("'QUESTION_RETIRED'") > 0 && saveAction.lastIndexOf("'QUESTION_RETIRED'") < saveAction.indexOf("insert into") &&
  ["'EVIDENCE_OUTSIDE_PILOT'", "'EVIDENCE_NOT_AN_ANSWER'", "'VERSION_CONFLICT'", "'ACTION_WITHDRAWN'", "'CONFLICT'", "'LIMIT_REACHED'"].every((o) => saveAction.indexOf(o) > 0 && saveAction.indexOf(o) < saveAction.indexOf("insert into")));
check("M8 an edit must name the version it edits, and a replay with another body is a conflict",
  /v_latest is distinct from p_expected_version/.test(saveAction) && /request_fingerprint = v_fingerprint/.test(saveAction));
const fnBody = (sql: string) => {
  const s = sql.indexOf("create or replace function public.save_pilot_report_artifact(");
  return sql.slice(s, sql.indexOf("\n$$;", s) + 4);
};
const NEW_SAVE = fnBody(MIG);
const blockStart = NEW_SAVE.indexOf("  -- D-057 begin");
const blockEnd = NEW_SAVE.indexOf("  -- D-057 end\n");
const withoutBlock = blockStart > 0 && blockEnd > blockStart ? NEW_SAVE.slice(0, blockStart) + NEW_SAVE.slice(blockEnd + "  -- D-057 end\n".length + 1) : "";
check("M9 save_pilot_report_artifact is 20261119120000's body byte for byte apart from the marked D-057 block",
  withoutBlock === fnBody(OLD), `${withoutBlock.length} vs ${fnBody(OLD).length}`);
const block = blockStart > 0 ? NEW_SAVE.slice(blockStart, blockEnd) : "";
check("M10 the block refuses an unreviewed, stale or withdrawn version, an omitted reviewed action, and a pass with any action",
  block.includes("'ACTION_NOT_REVIEWED'") && block.includes("'ACTIONS_INCOMPLETE'") &&
  /p_integrity_status = 'integrity_passed'/.test(block) && /event = 'withdrawn'/.test(block) && /max\(pav2\.version_number\)/.test(block));
check("M11 the block runs after every evidence check and before the revision is numbered",
  NEW_SAVE.indexOf("'EVIDENCE_MISMATCH'") < blockStart && blockEnd < NEW_SAVE.indexOf("select coalesce(max(pra.revision), 0) + 1 into v_revision"));
check("M12 nothing from the account stack, and no other existing function redefined",
  !/workspace_|account_session|_q2p_|_s1_/.test(MIG) && defs.map((d) => d[1]).sort().join(",") ===
    "pilot_action_evidence_check,pilot_actions_append_only,review_pilot_action,save_pilot_action,save_pilot_report_artifact,withdraw_pilot_action");
check("M13 a review and a withdrawal take the pilot lock a report save takes, so they never interleave",
  ["review_pilot_action", "withdraw_pilot_action"].every((n) => /from public\.pilots where id = p_pilot_id for share/.test(defs.find((d) => d[1] === n)?.[2] ?? "")) &&
  /for update/.test(saveAction));

/* ---------------------------------------------------------------- D */

const decisions = read("docs/DECISIONS.md");
check("D1 D-057 is recorded, with its engineer rules marked for confirmation", /## D-057 /.test(decisions) && /\(engineer\)/.test(decisions.slice(decisions.indexOf("## D-057 "))));
check("D2 the status and the runbook describe suggested actions",
  /## 34\. /.test(read("docs/CURRENT_STATUS.md")) && /D-057/.test(read("docs/PILOT_RUNBOOK.md")));
check("D3 test:pilot-actions is registered", /"test:pilot-actions": "tsx scripts\/test-pilot-actions\.ts"/.test(read("package.json")));

console.log(`\n${total - failures}/${total} checks passed.`);
if (failures > 0) {
  console.error("Pilot actions FAILED.");
  process.exit(1);
}
console.log("Pilot actions PASSED.");
