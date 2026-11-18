#!/usr/bin/env tsx
/**
 * D-057 — suggested actions in a pilot, offline.
 *
 *   P  the rules, the copy and the action builder are pure;
 *   F  an action version needs every field and 1-10 well-formed links;
 *   L  the wording lint: METHODOLOGY §19, causal and promise wording, the
 *      repository's claim-language list, hedged predictions and causal
 *      verbs, read after NFKC, format-character and look-alike folding; it
 *      runs at save and at build; ordinary wording passes;
 *   S  only each action's latest version, reviewed and not withdrawn, is
 *      reportable; an edit after a review is a draft again;
 *   R  the report: the section on the page and in the Markdown from one
 *      presentation model, the fixed note, every link re-checked (a source
 *      not in the answer, an answer outside the pilot, not completed,
 *      tampered or retired blocks it), any action holds it for review, no
 *      section without a reviewed action;
 *   T  the routes: founder guard first, parse and lint before the checked
 *      save, closed log fields; the console's client code loads no server
 *      module;
 *   K  the store run for real against a fake client: the evidence check
 *      returns the answer's own source URL and refuses what is not in the
 *      answer, the checked save calls the database only after it, the
 *      picker, the reportable versions, the console's stored answer text;
 *   C  the console and share copy: rebuild after a change, stale
 *      revisions, the review prompt, the customer note; the limits the
 *      founder approved (30 suggested actions per pilot and 10 links per
 *      action, D-059 item 10; not counting withdrawn actions toward the 30
 *      is D-057's (engineer) rule, still proposed) and the 50-version rule,
 *      each worded on its own, and a final withdrawal (D-059 item 11); the
 *      console's panel rendered for real at and below the limit;
 *   M  the migration's contract: append-only tables, RLS, privileges, the
 *      evidence trigger, refusals before any write, review and withdrawal
 *      serialised on the pilot row, and save_pilot_report_artifact and
 *      share_pilot_report_artifact redefined byte for byte apart from their
 *      marked blocks (the content check and ACTIONS_STALE);
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
  normaliseForLint,
  revisionActionsCurrent,
  parseSavePilotAction,
  pilotActionStatus,
  PILOT_ACTION_PROMISE_PHRASES,
  PILOT_ACTION_TEXT_FIELDS,
  reportableActionVersions,
  type PilotActionEventRow,
  type PilotActionVersionRow,
} from "@/lib/pilots/action-rules";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import {
  currentReportableVersionIds,
  listPilotActionsForAdmin,
  loadEvidenceChoices,
  readReportableActions,
  savePilotActionChecked,
  storedAnswerText,
  verifyActionEvidence,
} from "@/lib/pilots/action-store";
import {
  ACTION_LIMIT_NOTE,
  EDIT_PILOT_ACTION_NOTE,
  MAX_ACTION_EVIDENCE,
  MAX_PILOT_ACTION_VERSIONS,
  MAX_PILOT_ACTIONS_IN_USE,
  REVIEW_PILOT_ACTION_PROMPT,
  SAVE_PILOT_ACTION_REFUSAL,
  savePilotActionRefusalWords,
  STALE_REVISION_WORDS,
  VERSION_LIMIT_REACHED_WORDS,
  WITHDRAW_PILOT_ACTION_PROMPT,
} from "@/lib/pilots/action-copy";
import { SHARE_PILOT_REPORT_REFUSAL } from "@/lib/reports/pilot-report-copy";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  textOf(renderToStaticMarkup(createElement(PilotReportView, { payload, revision: 1, sharedAt: "2026-11-20T10:00:00Z" })));
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
check("L5 a hypothesis worded as one passes, and a phrase matches only as whole words",
  lintPilotActionText(TEXT.whyItMightMatter).length === 0 && lintPilotActionText("The post was censured by moderators.").length === 0 &&
  lintPilotActionText("Make sure to keep the G2 profile current.").length === 0 && lintPilotActionText("Use proven tools to compare answers.").length === 0 &&
  Object.values(TEXT).every((t) => lintPilotActionText(t).length === 0));
const linted = parseSavePilotAction(body({ suggestedAction: "Publish a page; it will improve how often you are named." }));
check("L6 a lint hit refuses the save, on the field that has it", !linted.ok && (linted.issues.suggestedAction?.[0] ?? "").includes("will improve"));
const REVIEW_EVASIONS = [
  "This will likely improve how often you are named.",
  "Publishing this should increase mentions.",
  "This is expected to increase mentions.",
  "Adding schema causes Perplexity to cite you.",
  "The missing page led to the absence.",
  "AI buyers can not find you.",
  "We guar\u00ADantee this.",
  "This will\u200Bimprove the answers.",
  "The missing page c\u0430used it.",
];
check("L8 every rewording the review found to slip through is refused (hedges, inflections, causal verbs, invisible characters, look-alike letters)",
  REVIEW_EVASIONS.every((t) => lintPilotActionText(t).length > 0),
  REVIEW_EVASIONS.filter((t) => lintPilotActionText(t).length === 0).join(" | "));
const HARMLESS = [
  "Make sure to keep the comparison page current.",
  "Use proven tools to compare the answers.",
  "We want to know how likely buyers are to open such a page.",
  "Whether this could be tested within the pilot is open.",
  "The engine may favour other sources for reasons unrelated to any page.",
  "Whether the engine would read a new page at all within the pilot.",
];
check("L9 ordinary wording passes, both ways round: the patterns need a modal and a change verb, or a causal verb, as whole words",
  HARMLESS.every((t) => lintPilotActionText(t).length === 0),
  HARMLESS.filter((t) => lintPilotActionText(t).length > 0).map((t) => `${t} → ${lintPilotActionText(t).join(",")}`).join(" | "));
check("L10 the lint reads NFKC text with format characters removed and spaced, look-alike letters folded, whitespace collapsed",
  normaliseForLint("guar\u00ADantee", "remove") === "guarantee" && normaliseForLint("will\u200Bimprove", "space") === "will improve" &&
  normaliseForLint("c\u0430used", "remove") === "caused" && normaliseForLint("ＷＩＬＬ   improve", "remove") === "will improve" &&
  normaliseForLint("\uFEFFcan\u2019t find you", "remove") === "can't find you");
check("L11 hedged and causal variants each name the words that matched, so the writer sees what to reword",
  lintPilotActionText("This will likely improve how often you are named.").includes("will likely improve") &&
  lintPilotActionText("Publishing this should increase mentions.").includes("should increase") &&
  lintPilotActionText("The missing page led to the absence.").includes("led to"));
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
check("T2 the save route parses and lints first, then saves only through the checked save (exercised in K below)",
  src.save.indexOf("parseSavePilotAction(") > 0 && src.save.indexOf("parseSavePilotAction(") < src.save.indexOf("savePilotActionChecked(") &&
  !/savePilotAction\(client/.test(src.save) && !/verifyActionEvidence/.test(src.save));
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

/* ---------------------------------------------------------------- K: the store, run for real against a fake client */

type FakeRow = Record<string, unknown>;
interface FakeRpcCall { fn: string; args: Record<string, unknown> }
/** A read-only stand-in for the Supabase query builder: select, eq, in, order; and rpc recorded. */
function fakeClient(tables: Record<string, FakeRow[]>, rpcCalls: FakeRpcCall[] = []): SupabaseClient {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; };
    q.in = (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; };
    q.order = (c: string, o?: { ascending?: boolean }) => {
      rows.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (o?.ascending === false ? -1 : 1));
      return q;
    };
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    return q;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return { data: [{ outcome: "SAVED", saved_action_id: uid(6001), saved_version_id: uid(6002), saved_version_number: 1 }], error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const kq1 = question(11, FIVE);
const kq2 = question(12, FIVE, "2026-11-19T00:00:00Z");
const kTampered = question(13, FIVE);
kTampered.slots[0].evidence.results[0] = { ...kTampered.slots[0].evidence.results[0], rawResponse: `${kTampered.slots[0].evidence.results[0].rawResponse} ` };
const attemptRows = (q: PilotReportQuestionInput) => q.slots[0].evidence.attempts.map((a) => ({
  id: a.id, protocol_id: q.slots[0].protocolId, attempt_kind: a.attemptKind, status: a.status, baseline_ordinal: a.baselineOrdinal,
  probe_run_id: a.probeRunId, retry_of_attempt_id: a.retryOfAttemptId, termination_reason: a.terminationReason,
}));
const resultRows = (q: PilotReportQuestionInput) => q.slots[0].evidence.results.map((r) => ({
  probe_run_id: r.probeRunId, raw_response: r.rawResponse, raw_response_sha256: r.rawResponseSha256, answer_summary: r.answerSummary,
}));
const KQS = [kq1, kq2, kTampered];
const K_ACT = { a: uid(6101), b: uid(6102), c: uid(6103) };
const K_VER = { a1: uid(6111), a2: uid(6112), b1: uid(6121), c1: uid(6131) };
const kAtt = kq1.slots[0].evidence.attempts;
const kTables: Record<string, FakeRow[]> = {
  pilot_questions: KQS.map((q) => ({ id: q.pilotQuestionId, pilot_id: PILOT, ordinal: q.ordinal, retired_at: q.retiredAt })),
  pilot_question_protocols: KQS.map((q) => ({ pilot_question_id: q.pilotQuestionId, engine: "perplexity_sonar", phase: "baseline", protocol_id: q.slots[0].protocolId })),
  protocol_attempts: KQS.flatMap(attemptRows),
  probe_results: KQS.flatMap(resultRows),
  pilot_actions: [
    { id: K_ACT.a, pilot_id: PILOT, created_at: "2026-11-19T01:00:00Z" },
    { id: K_ACT.b, pilot_id: PILOT, created_at: "2026-11-19T02:00:00Z" },
    { id: K_ACT.c, pilot_id: PILOT, created_at: "2026-11-19T03:00:00Z" },
  ],
  pilot_action_versions: [
    { id: K_VER.a1, action_id: K_ACT.a, pilot_id: PILOT, version_number: 1, title: "A v1", observation: TEXT.observation, suggested_action: TEXT.suggestedAction, why_it_might_matter: TEXT.whyItMightMatter, alternative_explanations: TEXT.alternativeExplanations, open_questions: TEXT.openQuestions, written_at: "2026-11-19T01:00:00Z" },
    { id: K_VER.a2, action_id: K_ACT.a, pilot_id: PILOT, version_number: 2, title: "A v2", observation: TEXT.observation, suggested_action: TEXT.suggestedAction, why_it_might_matter: TEXT.whyItMightMatter, alternative_explanations: TEXT.alternativeExplanations, open_questions: TEXT.openQuestions, written_at: "2026-11-19T04:00:00Z" },
    { id: K_VER.b1, action_id: K_ACT.b, pilot_id: PILOT, version_number: 1, title: "B v1", observation: TEXT.observation, suggested_action: TEXT.suggestedAction, why_it_might_matter: TEXT.whyItMightMatter, alternative_explanations: TEXT.alternativeExplanations, open_questions: TEXT.openQuestions, written_at: "2026-11-19T02:00:00Z" },
    { id: K_VER.c1, action_id: K_ACT.c, pilot_id: PILOT, version_number: 1, title: "C v1", observation: TEXT.observation, suggested_action: TEXT.suggestedAction, why_it_might_matter: TEXT.whyItMightMatter, alternative_explanations: TEXT.alternativeExplanations, open_questions: TEXT.openQuestions, written_at: "2026-11-19T03:00:00Z" },
  ],
  pilot_action_events: [
    { action_id: K_ACT.a, action_version_id: K_VER.a1, pilot_id: PILOT, event: "reviewed", created_at: "2026-11-19T01:30:00Z", reason: null },
    { action_id: K_ACT.b, action_version_id: K_VER.b1, pilot_id: PILOT, event: "reviewed", created_at: "2026-11-19T02:30:00Z", reason: null },
    { action_id: K_ACT.c, action_version_id: K_VER.c1, pilot_id: PILOT, event: "reviewed", created_at: "2026-11-19T03:30:00Z", reason: null },
    { action_id: K_ACT.c, action_version_id: null, pilot_id: PILOT, event: "withdrawn", created_at: "2026-11-19T05:00:00Z", reason: "No longer supported." },
  ],
  pilot_action_evidence: [
    { action_version_id: K_VER.b1, position: 2, attempt_id: kAtt[1].id, source_url: null },
    { action_version_id: K_VER.b1, position: 1, attempt_id: kAtt[0].id, source_url: G2 },
    { action_version_id: K_VER.a2, position: 1, attempt_id: kAtt[0].id, source_url: null },
    { action_version_id: K_VER.c1, position: 1, attempt_id: kTampered.slots[0].evidence.attempts[0].id, source_url: null },
  ],
};

const kDone = (async () => {
  const kc = fakeClient(kTables);
  const posted = "https://WWW.G2.com/categories/analytics#reviews";
  const v1 = await verifyActionEvidence(kc, PILOT, [{ attemptId: kAtt[0].id, sourceUrl: posted }, { attemptId: kAtt[0].id, sourceUrl: G2 }, { attemptId: kAtt[1].id, sourceUrl: null }]);
  check("K1 verifyActionEvidence accepts a source of that answer and returns it as the answer's own extracted URL, two spellings collapsing to one link",
    v1.outcome === "OK" && v1.links.length === 2 && v1.links[0].sourceUrl === G2 && v1.links[1].sourceUrl === null, JSON.stringify(v1));
  const v2 = await verifyActionEvidence(kc, PILOT, [{ attemptId: kAtt[0].id, sourceUrl: "https://www.example.com/not-in-the-answer" }]);
  const v3 = await verifyActionEvidence(kc, PILOT, [{ attemptId: uid(424299), sourceUrl: null }]);
  const v4 = await verifyActionEvidence(kc, PILOT, [{ attemptId: kAtt[2].id, sourceUrl: G2 }]);
  const v5 = await verifyActionEvidence(kc, PILOT, [{ attemptId: kTampered.slots[0].evidence.attempts[0].id, sourceUrl: G2 }]);
  check("K2 a source not in that answer, an answer outside the pilot, a failed attempt, or a tampered answer is refused with nothing to store",
    v2.outcome === "SOURCE_NOT_IN_ANSWER" && v3.outcome === "EVIDENCE_OUTSIDE_PILOT" && v4.outcome === "EVIDENCE_NOT_AN_ANSWER" &&
    v5.outcome === "SOURCE_NOT_IN_ANSWER" && [v2, v3, v4, v5].every((v) => v.links.length === 0),
    [v2, v3, v4, v5].map((v) => v.outcome).join(","));

  const calls: FakeRpcCall[] = [];
  const kc2 = fakeClient(kTables, calls);
  const fields = (evidenceLinks: { attemptId: string; sourceUrl: string | null }[]) => {
    const parsed = parseSavePilotAction({ ...TEXT, evidence: evidenceLinks, idempotencyKey: KEY });
    if (!parsed.ok) throw new Error("fixture does not parse");
    return parsed.value;
  };
  const refused = await savePilotActionChecked(kc2, { pilotId: PILOT, writtenBy: uid(1), fields: fields([{ attemptId: kAtt[0].id, sourceUrl: "https://www.example.com/not-in-the-answer" }]) });
  const callsAfterRefusal = calls.length;
  const saved = await savePilotActionChecked(kc2, { pilotId: PILOT, writtenBy: uid(1), fields: fields([{ attemptId: kAtt[0].id, sourceUrl: posted }]) });
  const sentEvidence = calls[0]?.args.p_evidence as { attemptId: string; sourceUrl: string | null }[] | undefined;
  check("K3 the checked save calls the database only when the links pass, and sends each source as the answer's own extracted URL, never as posted",
    refused.outcome === "SOURCE_NOT_IN_ANSWER" && callsAfterRefusal === 0 && saved.outcome === "SAVED" && calls.length === 1 &&
    calls[0].fn === "save_pilot_action" && sentEvidence?.length === 1 && sentEvidence[0].sourceUrl === G2, JSON.stringify(calls));

  const choices = await loadEvidenceChoices(kc, PILOT, kq1.pilotQuestionId);
  check("K4 the picker offers a question's completed answers that re-hash, each with its own sources, in answer order",
    choices !== null && choices.length === 4 && choices.every((c) => c.engineLabel === "Perplexity") &&
    choices[0].sources.some((x) => x.url === G2 && x.cited) && choices[0].sources.some((x) => x.url === REDDIT && !x.cited) &&
    choices.map((c) => c.answerNumber).join() === [...choices.map((c) => c.answerNumber)].sort((a, b) => a - b).join(), JSON.stringify(choices?.map((c) => c.answerNumber)));
  const tamperedChoices = await loadEvidenceChoices(kc, PILOT, kTampered.pilotQuestionId);
  check("K5 a tampered answer is not offered, a retired question offers nothing, and another pilot's question is unknown",
    tamperedChoices?.length === 3 && (await loadEvidenceChoices(kc, PILOT, kq2.pilotQuestionId))?.length === 0 &&
    (await loadEvidenceChoices(kc, uid(31337), kq1.pilotQuestionId)) === null);

  const reportable = await readReportableActions(kc, PILOT);
  check("K6 a report reads each action's latest reviewed version only: an edited action (draft again) and a withdrawn one are left out",
    reportable.length === 1 && reportable[0].versionId === K_VER.b1 && reportable[0].title === "B v1" && reportable[0].reviewedAt === "2026-11-19T02:30:00Z",
    JSON.stringify(reportable.map((r) => r.versionId)));
  check("K7 its links come in their stored order, with the stored source",
    reportable[0]?.evidence.map((e) => `${e.attemptId}|${e.sourceUrl ?? ""}`).join() === `${kAtt[0].id}|${G2},${kAtt[1].id}|`);
  check("K8 the versions a report built now would list are exactly those",
    JSON.stringify(await currentReportableVersionIds(kc, PILOT)) === JSON.stringify([K_VER.b1]));

  const admin = await listPilotActionsForAdmin(kc, PILOT);
  const b = admin.find((x) => x.actionId === K_ACT.b);
  const cRow = admin.find((x) => x.actionId === K_ACT.c);
  check("K9 the console shows each linked answer's stored text after its fingerprint check, so the review prompt's claim can be true",
    b?.evidence[0].answerText === "Options include Vanta [1]." && b.evidence[0].answerNote === null &&
    cRow?.evidence[0].answerText === null && (cRow?.evidence[0].answerNote ?? "").includes("fingerprint") &&
    admin.find((x) => x.actionId === K_ACT.a)?.status === "draft" && cRow?.status === "withdrawn", JSON.stringify(b?.evidence[0]));
  check("K10 the stored answer text is read from a Sonar or a Responses-shaped body, and nothing is made up",
    storedAnswerText(sonarBody("Answer text.", [])) === "Answer text." &&
    storedAnswerText(JSON.stringify({ object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "Part one." }, { type: "output_text", text: "Part two." }] }] })) === "Part one.\nPart two." &&
    storedAnswerText("not json") === null && storedAnswerText(JSON.stringify({ choices: [] })) === null && storedAnswerText(null) === null);
  check("K11 a revision is current only when its listed versions are exactly the reviewed, current ones",
    revisionActionsCurrent([K_VER.b1], [K_VER.b1]) && revisionActionsCurrent([], []) &&
    !revisionActionsCurrent([K_VER.b1, K_VER.c1], [K_VER.b1]) && !revisionActionsCurrent([], [K_VER.b1]) && !revisionActionsCurrent([K_VER.a1], [K_VER.a2]));
})().catch((error) => {
  check("K the store checks ran", false, String(error));
});

/* ---------------------------------------------------------------- C: console and share copy */

check("C1 a withdrawal, an edit and a review each tell the founder that a report built before must be built again",
  /build the report again/i.test(WITHDRAW_PILOT_ACTION_PROMPT) && /build the report again/i.test(EDIT_PILOT_ACTION_NOTE) &&
  /build the report again/i.test(REVIEW_PILOT_ACTION_PROMPT));
check("C2 a stale revision is named so, and the share refusal says what to do",
  SHARE_PILOT_REPORT_REFUSAL.ACTIONS_STALE === "An action changed after this revision was built. Build the report again." &&
  /cannot be shared/.test(STALE_REVISION_WORDS));
check("C3 the console marks a stale revision and offers no Share for it",
  /isStale\(r\)[\s\S]*STALE_REVISION_WORDS/.test(read("app/admin/pilots/[pilotId]/page.tsx")) &&
  /&& !stale;/.test(read("app/admin/pilots/[pilotId]/report/[artifactId]/page.tsx")));
check("C4 the review prompt names what the console shows: the stored answers under each link",
  /stored answers it links to \(shown under each link\)/.test(REVIEW_PILOT_ACTION_PROMPT) && /Read the stored answer/.test(read("app/admin/pilots/pilot-action-forms.tsx")));
check("C5 the customer's note promises no step that does not exist: the team registers a test with the customer",
  /the Zypact team registers it with you as a separate step/.test(ACTIONS_NOT_REGISTERED_NOTE));

/* D-059 items 10 and 11 (approved by the founder on 2026-11-17): the limits and a final withdrawal. */
const ACTIONS_SQL = read("supabase/migrations/20261109160000_pilot_actions.sql");
check("C6 the app's limits are the database's: 30 actions in use, 1 to 10 links, 50 versions",
  MAX_PILOT_ACTIONS_IN_USE === 30 && MAX_ACTION_EVIDENCE === 10 && MAX_PILOT_ACTION_VERSIONS === 50 &&
  /event = 'withdrawn'\)\) >= 30 then\s+return query select 'LIMIT_REACHED'/.test(ACTIONS_SQL) &&
  /jsonb_array_length\(p_evidence\) not between 1 and 10/.test(ACTIONS_SQL) &&
  /if v_latest >= 50 then\s+return query select 'LIMIT_REACHED'/.test(ACTIONS_SQL));
check("C7 the action limit and the version limit read differently: a new action gets the first, an edit the second",
  savePilotActionRefusalWords("LIMIT_REACHED", false) === SAVE_PILOT_ACTION_REFUSAL.LIMIT_REACHED &&
  savePilotActionRefusalWords("LIMIT_REACHED", true) === VERSION_LIMIT_REACHED_WORDS &&
  SAVE_PILOT_ACTION_REFUSAL.LIMIT_REACHED.includes("30 suggested actions") && !/version|edit/i.test(SAVE_PILOT_ACTION_REFUSAL.LIMIT_REACHED) &&
  VERSION_LIMIT_REACHED_WORDS.includes("50 versions") && !/30/.test(VERSION_LIMIT_REACHED_WORDS) &&
  savePilotActionRefusalWords("CONFLICT", true) === SAVE_PILOT_ACTION_REFUSAL.CONFLICT &&
  savePilotActionRefusalWords("SOMETHING_NEW", false) === "The action could not be saved.");
const saveRoute = read("app/api/internal/pilots/[pilotId]/actions/route.ts");
check("C8 the save route picks the words by whether the save was an edit",
  /savePilotActionRefusalWords\(result\.outcome, parsed\.value\.actionId !== null\)/.test(saveRoute) && !/SAVE_PILOT_ACTION_REFUSAL\[/.test(saveRoute));
const forms = read("app/admin/pilots/pilot-action-forms.tsx");
check("C9 the console offers no new action at the limit, counting actions not withdrawn, and says why in plain words",
  /const atLimit = actions\.filter\(\(a\) => a\.status !== "withdrawn"\)\.length >= MAX_PILOT_ACTIONS_IN_USE;/.test(forms) &&
  /disabled=\{questions\.length === 0 \|\| atLimit\}/.test(forms) && /\{atLimit \? <p className="zpa-muted">\{ACTION_LIMIT_NOTE\}<\/p> : null\}/.test(forms) &&
  ACTION_LIMIT_NOTE.includes("30 suggested actions") && /Withdrawn actions do not count/.test(ACTION_LIMIT_NOTE));
check("C10 the withdraw prompt says a withdrawal is final and cannot be undone",
  /A withdrawal is final: it cannot be undone\./.test(WITHDRAW_PILOT_ACTION_PROMPT));
check("C11 the new console words use no forbidden phrase",
  [ACTION_LIMIT_NOTE, VERSION_LIMIT_REACHED_WORDS, SAVE_PILOT_ACTION_REFUSAL.LIMIT_REACHED, WITHDRAW_PILOT_ACTION_PROMPT].join("\n").toLowerCase()
    .split("\n").every((t) => [...FORBIDDEN_W1_PHRASES, ...METHODOLOGY_19_PHRASES].every((ph) => !t.includes(ph)) && !/\bscore\b|\boverall\b/.test(t)));
// The console's panel itself, rendered at and below the limit (D-059 item 10).
const { PilotActionsPanel } = require("@/app/admin/pilots/pilot-action-forms") as { PilotActionsPanel: unknown };
const panelAction = (i: number, status: "draft" | "reviewed" | "withdrawn") => ({
  actionId: `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`,
  status,
  versionNumber: 1,
  title: `Action ${i}`,
  observation: "Named in two of the five stored answers.",
  suggestedAction: "Add a comparison page for small teams.",
  whyItMightMatter: "One possibility is that answers draw on comparison pages.",
  alternativeExplanations: "The engine may weight other sources.",
  openQuestions: "Whether this holds on another engine.",
  withdrawReason: status === "withdrawn" ? "It no longer holds." : null,
  evidence: [],
});
const panelQuestions = [{ pilotQuestionId: "00000000-0000-4000-8000-000000000999", ordinal: 1, text: "Which tools suit a small team?" }];
const renderPanel = (actions: ReturnType<typeof panelAction>[], questions = panelQuestions) =>
  renderToStaticMarkup(createElement(PilotActionsPanel, { pilotId: "00000000-0000-4000-8000-000000000998", questions, actions }));
/** Whether the "Write a suggested action" button is disabled, and whether the limit note shows; null when there is no such button. */
const panelState = (html: string) => {
  const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Write a suggested action<\/button>/.exec(html)?.[0];
  return button === undefined ? null : { disabled: /\sdisabled=""/.test(button), note: textOf(html).includes(ACTION_LIMIT_NOTE) };
};
const inUse = (n: number) => Array.from({ length: n }, (_, i) => panelAction(i, i % 2 === 0 ? "draft" : "reviewed"));
const at30 = panelState(renderPanel(inUse(30)));
const at29 = panelState(renderPanel([...inUse(29), panelAction(99, "withdrawn")]));
const at30w = panelState(renderPanel([...inUse(30), panelAction(99, "withdrawn")]));
const noQuestion = panelState(renderPanel(inUse(3), []));
check("C12 the panel, rendered: with 30 actions in use the new-action button is disabled and the note says why; 29 in use and one withdrawn leave it enabled with no note; with no question to link it is disabled without the note",
  at30?.disabled === true && at30.note && at29?.disabled === false && !at29.note &&
  at30w?.disabled === true && at30w.note && noQuestion?.disabled === true && !noQuestion.note,
  JSON.stringify({ at30, at29, at30w, noQuestion }));

/* ---------------------------------------------------------------- M */

const MIG = read("supabase/migrations/20261109160000_pilot_actions.sql");
const OLD = read("supabase/migrations/20261109150000_pilot_report_artifacts.sql");
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
check("M4 every inserted link must be a completed answer of this pilot with a stored hash, to a question not retired (proved on a real database by the DB suite)",
  /before insert on public\.pilot_action_evidence/.test(MIG) &&
  /pq\.pilot_id = new\.pilot_id[\s\S]*a\.status = 'completed'[\s\S]*r\.raw_response_sha256 is not null/.test(MIG) &&
  /pq\.retired_at is not null[\s\S]*pilot_action_evidence_question_retired/.test(MIG) &&
  /foreign key \(attempt_id, project_id\)\s+references public\.protocol_attempts \(id, project_id\)/.test(MIG));
const FNS = [
  "save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid)",
  "review_pilot_action(uuid, uuid, integer, uuid, boolean)",
  "withdraw_pilot_action(uuid, uuid, uuid, text)",
  "save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz)",
  "share_pilot_report_artifact(uuid, uuid, uuid, boolean)",
];
check("M5 the functions are executable by service_role only",
  FNS.every((f) => ["public", "anon", "authenticated"].every((r) => MIG.includes(`revoke all on function public.${f} from ${r};`)) &&
    MIG.includes(`grant execute on function public.${f} to service_role;`)));
const defs = [...MIG.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\n\$\$;/g)];
check("M6 every function pins its search_path, and the three writers are security definer",
  defs.length === 7 && defs.every((d) => /set search_path = public, pg_temp/.test(d[2])) &&
  ["save_pilot_action", "review_pilot_action", "withdraw_pilot_action", "save_pilot_report_artifact", "share_pilot_report_artifact"].every((n) =>
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
check("M9 save_pilot_report_artifact is 20261109150000's body byte for byte apart from the marked D-057 block",
  withoutBlock === fnBody(OLD), `${withoutBlock.length} vs ${fnBody(OLD).length}`);
const block = blockStart > 0 ? NEW_SAVE.slice(blockStart, blockEnd) : "";
check("M10 the block refuses an unreviewed, stale or withdrawn version, an omitted reviewed action, and a pass with any action",
  block.includes("'ACTION_NOT_REVIEWED'") && block.includes("'ACTIONS_INCOMPLETE'") &&
  /p_integrity_status = 'integrity_passed'/.test(block) && /event = 'withdrawn'/.test(block) && /max\(pav2\.version_number\)/.test(block));
check("M11 the block runs after every evidence check and before the revision is numbered",
  NEW_SAVE.indexOf("'EVIDENCE_MISMATCH'") < blockStart && blockEnd < NEW_SAVE.indexOf("select coalesce(max(pra.revision), 0) + 1 into v_revision"));
check("M12 nothing from the account stack, and no other existing function redefined",
  !/workspace_|account_session|_q2p_|_s1_/.test(MIG) && defs.map((d) => d[1]).sort().join(",") ===
    "pilot_action_evidence_check,pilot_actions_append_only,review_pilot_action,save_pilot_action,save_pilot_report_artifact,share_pilot_report_artifact,withdraw_pilot_action");
check("M13 a review and a withdrawal take the pilot row for update, as a save does, so two of them (or one and a save or share) never interleave",
  ["review_pilot_action", "withdraw_pilot_action"].every((n) => /from public\.pilots where id = p_pilot_id for update/.test(defs.find((d) => d[1] === n)?.[2] ?? "")) &&
  /for update/.test(saveAction));
const shareBody = (sql: string) => {
  const st = sql.indexOf("create or replace function public.share_pilot_report_artifact(");
  return sql.slice(st, sql.indexOf("\n$$;", st) + 4);
};
const NEW_SHARE = shareBody(MIG);
const sBlockStart = NEW_SHARE.indexOf("  -- D-057 begin");
const sBlockEnd = NEW_SHARE.indexOf("  -- D-057 end\n");
const shareWithout = sBlockStart > 0 && sBlockEnd > sBlockStart ? NEW_SHARE.slice(0, sBlockStart) + NEW_SHARE.slice(sBlockEnd + "  -- D-057 end\n".length + 1) : "";
check("M14 share_pilot_report_artifact is 20261109150000's body byte for byte apart from the marked D-057 block",
  shareWithout === shareBody(OLD), `${shareWithout.length} vs ${shareBody(OLD).length}`);
const sBlock = sBlockStart > 0 ? NEW_SHARE.slice(sBlockStart, sBlockEnd) : "";
check("M15 the share block refuses ACTIONS_STALE when a listed version is not current, reviewed and live, or a reviewed action is missing, after the newest-revision check",
  sBlock.includes("'ACTIONS_STALE'") && /event = 'withdrawn'/.test(sBlock) && /event = 'reviewed'/.test(sBlock) && /max\(pav2\.version_number\)/.test(sBlock) &&
  /v_art\.manifest -> 'actionVersions'/.test(sBlock) && NEW_SHARE.indexOf("'NOT_LATEST'") < sBlockStart &&
  sBlockEnd < NEW_SHARE.indexOf("'ACKNOWLEDGEMENT_REQUIRED'"));
check("M16 the save block compares what the payload shows of each action with the stored version and its links, except in a blocked revision",
  block.includes("'ACTIONS_CONTENT_MISMATCH'") && /p_integrity_status <> 'blocked'/.test(block) &&
  ["title", "observation", "suggestedAction", "whyItMightMatter", "alternativeExplanations", "openQuestions"].every((k) => block.includes(`(a ->> '${k}')`)) &&
  /pilot_action_evidence pae/.test(block) && /jsonb_typeof\(a -> 'evidence'\) is distinct from 'array'/.test(block));

/* ---------------------------------------------------------------- D */

const decisions = read("docs/DECISIONS.md");
check("D1 D-057 is recorded, with its engineer rules marked for confirmation", /## D-057 /.test(decisions) && /\(engineer\)/.test(decisions.slice(decisions.indexOf("## D-057 "))));
check("D2 the status and the runbook describe suggested actions",
  /## 34\. /.test(read("docs/CURRENT_STATUS.md")) && /D-057/.test(read("docs/PILOT_RUNBOOK.md")));
check("D3 test:pilot-actions is registered", /"test:pilot-actions": "tsx scripts\/test-pilot-actions\.ts"/.test(read("package.json")));

// The K checks are asynchronous; the summary waits for them, and a run with
// fewer checks than this suite holds fails rather than passing quietly.
void kDone.then(() => {
  console.log(`\n${total - failures}/${total} checks passed.`);
  if (total < 98) {
    console.error(`Pilot actions FAILED: only ${total} checks ran.`);
    process.exit(1);
  }
  if (failures > 0) {
    console.error("Pilot actions FAILED.");
    process.exit(1);
  }
  console.log("Pilot actions PASSED.");
});
