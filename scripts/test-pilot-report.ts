#!/usr/bin/env tsx
/**
 * D-055 — the combined pilot report, offline.
 *
 *   P  the builder, the integrity rule, the Markdown and the copy are pure:
 *      no database, network, provider or model import, and no fetch;
 *   B  the builder: per-question rows equal each question's own report;
 *      denominators keep failed and excluded attempts visible; the
 *      portfolio line is a count beside the rows, never a rate or a score;
 *      competitors grouped across questions as a portfolio aggregate;
 *      source types per question; the evidence index and manifest cover
 *      every attempt, a retired question's included;
 *   E  ChatGPT is "not measured", never zero;
 *   I  integrity: the worst per-question result, an unfinished question
 *      needs review, evidence outside the pilot blocks, a retired question
 *      does not hold the report;
 *   C  the required wording (METHODOLOGY §4, §7, §16 gates 5 and 12) is on
 *      both the page and the Markdown; versions that differ are listed and
 *      held for review; answers that were not live are held for review;
 *   N  answers still being collected are their own count, never "failed",
 *      and the reconciliation check can fail;
 *   V  the page and the Markdown render one presentation model; the
 *      founder's preview renders the same stored payload as the customer's
 *      page;
 *   W  wording: no forbidden claim, no overall score, no stored code on the
 *      page or in the Markdown, the D-053 limitation;
 *   T  the client page: token shape first, the shared-only read, noindex;
 *      the routes are founder-guarded;
 *   M  the migration's contract: privileges, RLS, the append-only guard,
 *      the save and share refusals, nothing redefined.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/*
 * Next resolves `import "./x.css"` itself; bare Node cannot parse one. Same
 * stub scripts/test-outcome-card-view.ts uses.
 */
(require("node:module") as { _extensions: Record<string, unknown> })._extensions[".css"] = () => undefined;

import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import {
  buildPilotReport,
  ENGINE_NOT_MEASURED_NOTE,
  PILOT_CAUSAL_LIMIT,
  PILOT_LIMITATIONS,
  questionLabel,
  type PilotReportInput,
  type PilotReportQuestionInput,
} from "@/lib/reports/build-pilot-report";
import { evaluatePilotReportIntegrity, type PilotQuestionSignals } from "@/lib/reports/pilot-report-integrity";
import * as copy from "@/lib/reports/pilot-report-copy";
import { presentationStrings, presentPilotReport } from "@/lib/reports/pilot-report-presentation";
import { isPilotReportPayload, type PilotReportPayload } from "@/lib/reports/pilot-report-types";
import { buildAndSavePilotReport } from "@/lib/reports/process-pilot-report";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";
import { DEPENDENCE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION } from "@/lib/reports/surface-limitations";
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

/* ---------------------------------------------------------------- fixtures */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PILOT = "22222222-2222-4222-8222-222222222222";
const COMPANY = "Acme Analytics";
const DOMAIN = "acme.test";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const NOW = new Date("2026-11-19T12:00:00.000Z");

function sonarBody(content: string, urls: string[]): string {
  return JSON.stringify({
    id: "resp",
    model: "sonar",
    choices: [{ message: { role: "assistant", content } }],
    citations: urls,
    search_results: urls.map((u, i) => ({ title: `Source ${i + 1}`, url: u })),
  });
}

interface RunSpec {
  status: "completed" | "failed" | "excluded" | "reserved" | "in_progress" | "timed_out" | "mystery";
  mentioned?: boolean | null;
  competitors?: string[];
  body?: string | null;
}

let seq = 0;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function evidence(protocolId: string, question: string, runs: RunSpec[], projectId = PROJECT, company = COMPANY): BuildProtocolReportInput {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  runs.forEach((r, i) => {
    const id = uid(++seq);
    const probeRunId = r.status === "excluded" && r.mentioned === undefined ? null : uid(++seq);
    attempts.push({
      id,
      attemptKind: "baseline",
      status: r.status,
      baselineOrdinal: i + 1,
      probeRunId,
      retryOfAttemptId: null,
      terminationReason: r.status === "failed" ? "provider_error" : null,
    });
    if (probeRunId && r.status === "completed") {
      const body = r.body === undefined ? sonarBody(`Options include Vanta [1].`, ["https://www.g2.com/categories/x"]) : r.body;
      results.push({
        probeRunId,
        clientMentioned: r.mentioned === undefined ? true : r.mentioned,
        clientPosition: null,
        competitorsMentioned: r.competitors ?? [],
        sourcesCited: [],
        answerSummary: "summary",
        rawResponseSha256: body === null ? null : sha(body),
        rawResponse: body,
        providerModel: "sonar",
        providerLatencyMs: 1000,
      });
    }
  });
  return {
    snapshotRequestId: protocolId,
    projectId,
    subject: { companyName: company, websiteUrl: DOMAIN, normalizedDomain: DOMAIN },
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

const five = (mentioned: boolean[], competitors: string[][] = []): RunSpec[] =>
  mentioned.map((m, i) => ({ status: "completed", mentioned: m, competitors: competitors[i] ?? [] }));

interface QuestionOpts {
  jobStatus?: string | null;
  retiredAt?: string | null;
  projectId?: string;
  company?: string;
  analyzerVersion?: number | null;
  answerModes?: string[];
  execution?: { firstOn: string | null; lastOn: string | null };
}

function question(ordinal: number, runs: RunSpec[], opts: QuestionOpts = {}): PilotReportQuestionInput {
  const protocolId = uid(9000 + ordinal);
  const ev = evidence(protocolId, `Which analytics tools suit a team of ${ordinal}?`, runs, opts.projectId, opts.company);
  if (opts.analyzerVersion !== undefined) ev.protocol = { ...ev.protocol, analyzerVersion: opts.analyzerVersion };
  return {
    pilotQuestionId: uid(8000 + ordinal),
    ordinal,
    provenance: ordinal % 2 === 0 ? "founder_supplied" : "customer_supplied",
    customerApprovedOn: "2026-11-18",
    retiredAt: opts.retiredAt ?? null,
    slots: [
      {
        engine: "perplexity_sonar",
        protocolId,
        jobStatus: opts.jobStatus === undefined ? "succeeded" : opts.jobStatus,
        evidence: ev,
        execution: opts.execution ?? (runs.length > 0 ? { firstOn: "2026-11-18", lastOn: "2026-11-19" } : { firstOn: null, lastOn: null }),
        answerModes: opts.answerModes ?? (runs.length > 0 ? ["live_perplexity"] : []),
      },
    ],
  };
}

function input(questions: PilotReportQuestionInput[]): PilotReportInput {
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
    now: NOW,
  };
}

const GOOD = { hasApprovedProtocol: true, hasApprovedSamplePlan: true, hasPaidCallReservation: true, hasCompleteEvidenceHashes: true };
const signalsFor = (built: ReturnType<typeof buildPilotReport>, over: Partial<typeof GOOD> = {}, ordinal?: number): PilotQuestionSignals[] =>
  built.payload.questions.flatMap((q) =>
    q.measurements.map((m) => ({
      ordinal: q.ordinal,
      engine: m.engine,
      retired: q.retired,
      completedAttempts: m.counts.completed,
      signals: ordinal === undefined || ordinal === q.ordinal ? { ...GOOD, ...over } : GOOD,
    }))
  );
const pageText = (payload: PilotReportPayload) => presentationStrings(presentPilotReport(payload));
const integrityOf = (b: ReturnType<typeof buildPilotReport>, signals: PilotQuestionSignals[] = signalsFor(b)) =>
  evaluatePilotReportIntegrity({ markdown: renderPilotReportMarkdown(b.payload), pageText: pageText(b.payload), structural: b.structural, questionSignals: signals });

/* A rendered page, as a reader sees it (scripts/test-outcome-card-view.ts). */
(globalThis as unknown as { React: unknown }).React = require("react");
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
const { PilotReportView } = require("@/components/report/pilot-report-view") as { PilotReportView: unknown };
function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const renderPage = (payload: PilotReportPayload, opts: { preview?: boolean; sharedAt?: string | null } = {}) =>
  textOf(
    renderToStaticMarkup(
      createElement(PilotReportView, {
        payload,
        revision: 3,
        sharedAt: opts.preview ? null : opts.sharedAt ?? "2026-11-20T10:00:00Z",
        newerSharedRevision: false,
        preview: opts.preview ?? false,
      })
    )
  );
const flat = (t: string) => t.replace(/\s+/g, " ");

/* ---------------------------------------------------------------- P */

console.log("test-pilot-report");
const PURE = [
  "lib/reports/build-pilot-report.ts",
  "lib/reports/pilot-report-integrity.ts",
  "lib/reports/render-pilot-report-markdown.ts",
  "lib/reports/pilot-report-types.ts",
  "lib/reports/pilot-report-copy.ts",
  "lib/reports/pilot-report-presentation.ts",
];
const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
const banned = /supabase|openai|perplexity|probes|protocol-worker|node:http|node:https|undici|resend|read-protocol-evidence|read-pilot-evidence|protocol-integrity-signals"$/;
check("P1 the builder, integrity rule, Markdown, types and copy import no database, network, provider or model module",
  PURE.every((f) => importsOf(f).every((m) => !banned.test(m) || m.endsWith("protocol-integrity-signals") && f.endsWith("pilot-report-integrity.ts"))),
  PURE.map((f) => `${f}: ${importsOf(f).join(",")}`).join(" | "));
check("P2 nothing in them calls fetch or a model",
  PURE.every((f) => !/\bfetch\(|\.rpc\(|\.from\(|chat\.completions|responses\.create/.test(readFileSync(f, "utf8"))));
check("P3 the integrity rule imports only the signals' type from the database reader",
  /import type \{ ProtocolIntegritySignals \} from "@\/lib\/reports\/protocol-integrity-signals"/.test(readFileSync("lib/reports/pilot-report-integrity.ts", "utf8")));

/* ---------------------------------------------------------------- B */

const q1Runs = five([true, true, true, true, true], [["Vanta", COMPANY], ["Drata"], [], [], []]);
const q2Runs: RunSpec[] = [
  ...five([false, true, false, false], [["vanta "], [], [], []]),
  { status: "failed" },
  { status: "completed", mentioned: false, competitors: [] },
];
const q3Runs: RunSpec[] = [
  { status: "completed", mentioned: null },
  { status: "completed", mentioned: true },
  { status: "completed", mentioned: false },
  { status: "excluded" },
];
const base = input([question(1, q1Runs), question(2, q2Runs), question(3, q3Runs)]);
const built = buildPilotReport(base);
const p = built.payload;
const perplexity = p.brand.find((s) => s.engine === "perplexity_sonar")!;

const direct1 = buildProtocolReport({ ...base.questions[0].slots[0].evidence, subject: { companyName: COMPANY, websiteUrl: `https://${DOMAIN}`, normalizedDomain: DOMAIN }, now: NOW });
check("B1 a question's section embeds exactly the payload buildProtocolReport builds for it",
  JSON.stringify(p.questions[0].measurements[0].report) === JSON.stringify(direct1));
check("B2 each table row repeats its question's own numerator and denominator",
  perplexity.rows.every((r) => {
    const m = p.questions.find((q) => q.ordinal === r.ordinal)!.measurements[0].report;
    return r.numerator === m.observation.numerator && r.denominator === m.observation.denominator;
  }));
const row2 = perplexity.rows.find((r) => r.ordinal === 2)!;
check("B3 a failed attempt stays in the attempts and out of the denominator",
  row2.counts.attempted === 6 && row2.counts.failed === 1 && row2.denominator === 5 && row2.numerator === 1, JSON.stringify(row2));
const row3 = perplexity.rows.find((r) => r.ordinal === 3)!;
check("B4 an answer without a readable result and an excluded attempt are counted as such, not as 'not named'",
  row3.denominator === 2 && row3.counts.excludedByReview === 1 && row3.counts.noReadableResult === 1 && row3.counts.attempted === 4 && row3.counts.reconciles,
  JSON.stringify(row3));
check("B5 labels follow the disclosed rule: every answer, no answer, some answers, too few answers",
  questionLabel(5, 5) === "observed_consistently_in_sample" && questionLabel(0, 5) === "not_observed_consistently_in_sample" &&
  questionLabel(2, 5) === "mixed_in_sample" && questionLabel(2, 2) === "insufficient_evidence" && row3.label === "insufficient_evidence");
const portfolio = perplexity.portfolio!;
check("B6 the total line is a count over finished questions, each readable answer once",
  portfolio.numerator === 5 + 1 + 1 && portfolio.denominator === 5 + 5 + 2 && portfolio.includedOrdinals.join() === "1,2,3",
  JSON.stringify(portfolio));
check("B7 the total line carries no rate or interval of its own, and says why",
  !("rate" in portfolio) && !("interval" in portfolio) && /not a rate for the company/.test(portfolio.heterogeneity));
const comp = p.competitors.find((s) => s.engine === "perplexity_sonar")!;
const vanta = comp.rows.find((r) => r.name.toLowerCase() === "vanta");
check("B8 a competitor is grouped across questions by name apart from spacing and case, with its runs per question",
  !!vanta && vanta.appearances.length === 2 && vanta.appearances[0].ordinal === 1 && vanta.appearances[0].runs === 1 && vanta.appearances[1].ordinal === 2,
  JSON.stringify(comp.rows));
check("B9 the client's own brand never appears as a competitor", comp.rows.every((r) => r.name.toLowerCase() !== COMPANY.toLowerCase()));
const src = p.sources.find((s) => s.engine === "perplexity_sonar")!;
const review = src.rows.find((r) => r.category === "review_platform");
check("B10 source types are counted per question, once per answer", !!review && review.cells.find((c) => c.ordinal === 1)?.citedInRuns === 5,
  JSON.stringify(src.rows));
const totalAttempts = base.questions.reduce((s, q) => s + q.slots[0].evidence.attempts.length, 0);
check("B11 the evidence index and the manifest list every attempt, failed and excluded ones included",
  p.evidenceIndex.length === totalAttempts && built.manifest.attempts.length === totalAttempts &&
  built.manifest.protocols.length === 3 && p.evidenceIndex.some((e) => e.status === "failed") && p.evidenceIndex.some((e) => e.status === "excluded"));
check("B12 the payload passes its own type guard and names the pilot", isPilotReportPayload(p) && p.pilotId === PILOT && p.projectId === PROJECT);

/* ---------------------------------------------------------------- E */

const chatgpt = p.engines.find((e) => e.engine === "openai_chatgpt")!;
const md = renderPilotReportMarkdown(p);
check("E1 ChatGPT is listed as not measured in this pilot yet", chatgpt.measured === false && chatgpt.note === ENGINE_NOT_MEASURED_NOTE);
check("E2 ChatGPT has no brand, competitor or source section, so nothing can show it as zero",
  [...p.brand, ...p.competitors, ...p.sources].every((s) => s.engine !== "openai_chatgpt"));
check("E3 the Markdown says ChatGPT was not measured and never gives it a count",
  md.includes(`ChatGPT: ${ENGINE_NOT_MEASURED_NOTE}`) && !/ChatGPT[^\n]*\b0 of\b/.test(md) && md.includes("ChatGPT: not measured for this question."));
check("E4 the client view renders engines from the presentation model, which reads them from the payload, and has no hard-coded zero for an engine",
  /v\.engines\.map/.test(readFileSync("components/report/pilot-report-view.tsx", "utf8")) &&
  /payload\.engines\.map/.test(readFileSync("lib/reports/pilot-report-presentation.ts", "utf8")) &&
  !/ChatGPT[^\n]*0%/.test(readFileSync("components/report/pilot-report-view.tsx", "utf8")) &&
  !/ChatGPT[^.]*\b0 of\b/.test(renderPage(p)));

/* ---------------------------------------------------------------- I */

const passed = integrityOf(built);
check("I1 a pilot whose questions all finished with good evidence passes with no reason",
  passed.status === "integrity_passed" && passed.reasons.length === 0, JSON.stringify(passed));

const unfinished = buildPilotReport(input([question(1, q1Runs), question(2, [], { jobStatus: "queued" })]));
const unfinishedI = integrityOf(unfinished);
check("I2 a question not yet run makes the report need review, naming the question",
  unfinishedI.status === "needs_review" && unfinishedI.reasons.some((r) => r.startsWith("Question 2:")), JSON.stringify(unfinishedI.reasons));
check("I3 an unfinished question is left out of the total line and named",
  unfinished.payload.brand[0].portfolio!.leftOutOrdinals.includes(2) && !unfinished.payload.brand[0].portfolio!.includedOrdinals.includes(2));

const withRetired = buildPilotReport(input([
  question(1, q1Runs),
  question(2, [{ status: "failed" }, { status: "failed" }], { jobStatus: "abandoned_exhausted", retiredAt: "2026-11-19T09:00:00Z" }),
]));
// A retired question that collected no answer: the per-answer checks are false by construction there.
const retiredI = integrityOf(withRetired, signalsFor(withRetired, { hasPaidCallReservation: false, hasCompleteEvidenceHashes: false }, 2));
const retiredRow = withRetired.payload.brand[0].rows.find((r) => r.ordinal === 2)!;
check("I4a a retired question that collected no answer does not hold the report", retiredI.status === "integrity_passed", JSON.stringify(retiredI));
const retiredWithAnswers = buildPilotReport(input([
  question(1, q1Runs),
  question(2, [{ status: "completed", mentioned: true }, { status: "completed", mentioned: true }, { status: "failed" }], { jobStatus: "abandoned_exhausted", retiredAt: "2026-11-19T09:00:00Z" }),
]));
const retiredHashI = integrityOf(retiredWithAnswers, signalsFor(retiredWithAnswers, { hasCompleteEvidenceHashes: false }, 2));
check("I4b a retired question's collected answers still pass the evidence and hash checks: a missing hash holds the report",
  retiredHashI.status === "needs_review" && retiredHashI.reasons.some((r) => r.startsWith("Question 2 (Perplexity):")), JSON.stringify(retiredHashI));
check("I5 a retired question is still listed, its failed attempts counted in its own row, and named as left out",
  withRetired.payload.questions[1].retired && retiredRow.retired && retiredRow.counts.attempted === 2 && retiredRow.counts.failed === 2 &&
  withRetired.payload.brand[0].portfolio!.leftOutOrdinals.includes(2) && withRetired.manifest.attempts.length === 7 &&
  renderPilotReportMarkdown(withRetired.payload).includes(copy.RETIRED_WORDS));
const rwRow = retiredWithAnswers.payload.brand[0].rows.find((r) => r.ordinal === 2)!;
const rwPage = renderPage(retiredWithAnswers.payload);
check("I5b a retired question shows its attempt counts only: no rate, range or reading, on the page or in the Markdown",
  rwRow.numerator === null && rwRow.denominator === null && rwRow.intervalLow === null && rwRow.label === null &&
  /Retired Not reported \(retired\)/.test(rwPage) && !/named in 2 of 2/.test(rwPage) &&
  !/named in 2 of 2/.test(renderPilotReportMarkdown(retiredWithAnswers.payload)) &&
  rwPage.includes("Perplexity (retired): 3 attempted of 5 planned: 2 completed, 1 failed"), rwPage.slice(0, 0));
const allRetired = buildPilotReport(input([
  question(1, [{ status: "completed", mentioned: true }, { status: "completed", mentioned: true }], { jobStatus: "failed", retiredAt: "2026-11-19T09:00:00Z" }),
]));
const arEngine = allRetired.payload.engines.find((e) => e.engine === "perplexity_sonar")!;
const arPage = renderPage(allRetired.payload);
check("I5c a pilot whose every question is retired never says the engine named the brand, and says what happened",
  arEngine.measured && arEngine.questionsWithReadableAnswer === 0 && arEngine.questionsRetired === 1 &&
  arEngine.note === "0 of 0 questions with at least one readable answer; 1 retired." && !/named in \d+ of/i.test(arPage) &&
  allRetired.payload.brand[0].portfolio === null, arEngine.note);

// The builder's own check is defence in depth: the real reader refuses foreign evidence first (I6a, below).
const foreign = buildPilotReport(input([question(1, q1Runs, { projectId: "33333333-3333-4333-8333-333333333333" })]));
const foreignI = evaluatePilotReportIntegrity({ markdown: "x", pageText: [], structural: foreign.structural, questionSignals: signalsFor(foreign) });
check("I6b if evidence from another project ever reached the builder, it would block the report (defence in depth)", foreignI.status === "blocked", JSON.stringify(foreignI));

const badSignals = integrityOf(built, signalsFor(built, { hasCompleteEvidenceHashes: false }, 3));
check("I7 the worst per-question result decides, and the reason names the question and engine",
  badSignals.status === "needs_review" && badSignals.reasons.some((r) => r.startsWith("Question 3 (Perplexity):")), JSON.stringify(badSignals.reasons));

const legacy = evaluatePilotReportIntegrity({ markdown: `${md}\n3 won · 1 partial · 1 lost`, pageText: pageText(p), structural: [], questionSignals: signalsFor(built) });
check("I8 report text exposing legacy verdicts is blocked", legacy.status === "blocked");
const legacyPage = evaluatePilotReportIntegrity({ markdown: md, pageText: [...pageText(p), "3 won · 1 partial · 1 lost"], structural: [], questionSignals: signalsFor(built) });
check("I8b the text check reads the page's strings too, not only the Markdown", legacyPage.status === "blocked");
const proc0 = readFileSync("lib/reports/process-pilot-report.ts", "utf8");
check("I8c the build passes every string the page renders to the integrity check",
  /presentationStrings\(presentPilotReport\(built\.payload\)\)/.test(proc0) && /evaluatePilotReportIntegrity\(\{ markdown, pageText,/.test(proc0));

const otherBrand = buildPilotReport(input([question(1, q1Runs, { company: "Someone Else" })]));
check("I9 a measured brand that differs from the pilot's company needs review",
  otherBrand.structural.some((s) => s.status === "needs_review" && /brand looked for/.test(s.reason)));
const empty = buildPilotReport(input([]));
check("I10 a pilot with no question needs review", empty.structural.some((s) => s.status === "needs_review"));


/* ---------------------------------------------------------------- C */

const pagePlain = renderPage(p);
const mdPlain = flat(md);
const conditionsText = [
  PERPLEXITY_SURFACE_LIMITATION,
  DEPENDENCE_LIMITATION,
  PILOT_CAUSAL_LIMIT,
  "Engine: Perplexity Sonar, through Perplexity's API.",
  "Model: sonar.",
  "Answers: live answers from Perplexity's API.",
  "Answers collected from 2026-11-18 to 2026-11-19.",
  "Methodology version 1; analysis version 1.",
];
check("C1 the page carries the required wording: §4 directional line, §7 dependence warning, causal-limit footer, engine, model, answer mode, dates and versions",
  conditionsText.every((t) => pagePlain.includes(t)), conditionsText.filter((t) => !pagePlain.includes(t)).join(" | "));
check("C2 the Markdown carries the same required wording", conditionsText.every((t) => mdPlain.includes(t)), conditionsText.filter((t) => !mdPlain.includes(t)).join(" | "));
check("C3 the dependence warning sits with every table of ranges and with the question sections",
  presentPilotReport(p).sections.filter((s) => s.key.startsWith("brand-")).every((s) => s.notes.includes(DEPENDENCE_LIMITATION)) &&
  presentPilotReport(p).questionsIntro.includes(DEPENDENCE_LIMITATION));
check("C4 a version shared by every question is listed once, not per question",
  p.conditions[0].analyzerVersion.length === 1 && p.conditions[0].analyzerVersion[0].ordinals.join() === "1,2,3" &&
  (mdPlain.match(/Methodology version/g) ?? []).length === 1);
const mixed = buildPilotReport(input([question(1, q1Runs), question(2, q1Runs, { analyzerVersion: 2 })]));
const mixedMd = flat(renderPilotReportMarkdown(mixed.payload));
check("C5 versions that differ between questions are listed with their questions and hold the report for review",
  mixed.structural.some((r) => r.status === "needs_review" && /same analysis version/.test(r.reason)) &&
  mixedMd.includes("analysis version 1 (question 1); 2 (question 2)") && integrityOf(mixed).status === "needs_review", mixedMd.slice(0, 0));
const simulated = buildPilotReport(input([question(1, q1Runs, { answerModes: ["simulated"] })]));
check("C6 answers that were not live provider answers hold the report for review and are named in words",
  simulated.structural.some((r) => /not live answers/.test(r.reason)) && renderPage(simulated.payload).includes("Answers: simulated answers, not from the provider."));
const undated = buildPilotReport(input([question(1, q1Runs, { execution: { firstOn: null, lastOn: null } })]));
check("C7 answers with no recorded dates hold the report for review", undated.structural.some((r) => /no recorded dates/.test(r.reason)));
const required = (txt: string) => [PERPLEXITY_SURFACE_LIMITATION, DEPENDENCE_LIMITATION, PILOT_CAUSAL_LIMIT].every((t) => txt.includes(t));
check("C8 the required wording is present on every rendering, whatever the pilot's state",
  [built, unfinished, withRetired, retiredWithAnswers].every((b) => required(renderPage(b.payload)) && required(flat(renderPilotReportMarkdown(b.payload)))));

/* ---------------------------------------------------------------- N */

const collecting = buildPilotReport(input([
  question(1, [...five([true, true, true]), { status: "in_progress" }, { status: "reserved" }], { jobStatus: "running" }),
]));
const cRow = collecting.payload.brand[0].rows[0];
const cPage = renderPage(collecting.payload);
check("N1 reserved and in-progress attempts are their own count, never failed",
  cRow.counts.inProgress === 2 && cRow.counts.failed === 0 && cRow.counts.completed === 3 && cRow.counts.reconciles,
  JSON.stringify(cRow.counts));
check("N2 the page says they are still being collected and never calls them failed",
  cPage.includes("2 still being collected") && cPage.includes("0 failed") && !/2 failed/.test(cPage));
check("N3 answers still being collected hold the report for review",
  collecting.structural.some((r) => r.status === "needs_review" && /still being collected/.test(r.reason)));
const unknownStatus = buildPilotReport(input([question(1, [...five([true, true, true, true]), { status: "mystery" }])]));
const uRow = unknownStatus.payload.brand[0].rows[0];
check("N4 the reconciliation check can fail: an attempt in a state the report does not know does not reconcile, and holds the report",
  !uRow.counts.reconciles && uRow.counts.unrecognised === 1 &&
  unknownStatus.structural.some((r) => /attempt counts do not reconcile/.test(r.reason)) && integrityOf(unknownStatus).status === "needs_review");
check("N5 every question of a normal pilot reconciles", perplexity.rows.every((r) => r.counts.reconciles));
check("N6 timed-out attempts count as failed", buildPilotReport(input([question(1, [...five([true, true, true, true]), { status: "timed_out" }])])).payload.brand[0].rows[0].counts.failed === 1);

/* ---------------------------------------------------------------- V */

const view = presentPilotReport(p);
const srcSection = view.sections.find((s) => s.key === "sources-perplexity_sonar")!;
check("V1 source cells show k of n answers with a usable source list",
  !!srcSection.table && srcSection.table.rows.some((r) => r.some((c) => c.includes("Q1: 5 of 5"))) && srcSection.paragraphs[0].includes("of the question's answers with a usable source list"),
  JSON.stringify(srcSection.table?.rows));
const thinBuilt = buildPilotReport(input([question(1, [...five([true, true, true, true]), { status: "completed", mentioned: true, body: "not json" }])]));
const thinPage = renderPage(thinBuilt.payload);
check("V2 the page shows the note on answers with no usable source list, as the Markdown does",
  thinPage.includes("Some readable answers had no usable source list") && renderPilotReportMarkdown(thinBuilt.payload).includes("Some readable answers had no usable source list"));
const q3Words = "4 attempted of 5 planned: 3 completed, 0 failed, 1 excluded after review, 1 without a readable result";
check("V3 question sections show completed, failed, excluded and no-result counts, on the page and in the Markdown",
  pagePlain.includes(`Attempts: ${q3Words}.`) && mdPlain.includes(`Attempts: ${q3Words}.`), q3Words);
const unfinishedPage = renderPage(unfinished.payload);
check("V4 the hero and engines say only what is true: readable answers counted, not-started questions named, ChatGPT never said to be asked",
  !/asked several times on each engine/.test(pagePlain) && pagePlain.includes("ChatGPT has not been measured in this pilot yet.") &&
  unfinishedPage.includes("Perplexity: 1 of 2 questions with at least one readable answer; 1 not started.") &&
  !/ChatGPT[^.]*asked/.test(pagePlain));
const pageNoChrome = (t: string) =>
  t.split(copy.PREVIEW_BANNER_WORDS).join(" ")
    .replace(/Revision 3, built [0-9-]+, (shared [0-9-]+|not shared)/, " ")
    .replace(/\s+/g, " ");
check("V5 the founder's preview and the customer's page render the identical stored payload, apart from the preview label and the revision chip",
  pageNoChrome(renderPage(p, { preview: true })) === pageNoChrome(renderPage(p)) && renderPage(p, { preview: true }).includes(copy.PREVIEW_BANNER_WORDS) &&
  !renderPage(p).includes(copy.PREVIEW_BANNER_WORDS));
check("V6 every string of the presentation model appears on the page, and in the Markdown",
  pageText(p).every((t) => pagePlain.includes(flat(t).trim())) && pageText(p).every((t) => mdPlain.includes(flat(t).replace(/\|/g, "\\|").trim()) || mdPlain.includes(flat(t).trim())),
  pageText(p).filter((t) => !pagePlain.includes(flat(t).trim())).slice(0, 3).join(" | "));
const viewSrc = readFileSync("components/report/pilot-report-view.tsx", "utf8");
const mdSrc = readFileSync("lib/reports/render-pilot-report-markdown.ts", "utf8");
check("V7 the page and the Markdown both render the one presentation model and read no payload section directly",
  /presentPilotReport\(payload\)/.test(viewSrc) && /presentPilotReport\(payload\)/.test(mdSrc) &&
  !/payload\.(brand|competitors|sources|questions|engines|conditions|limitations|methodNotes)/.test(viewSrc) &&
  !/payload\.(brand|competitors|sources|questions|engines|conditions|limitations|methodNotes)/.test(mdSrc));

/* ---------------------------------------------------------------- I6a: the real reader with foreign evidence */

type Row = Record<string, unknown>;
function stubClient(tables: Record<string, Row[]>, rpcCalls: string[]) {
  const query = (rows: Row[]) => {
    let out = rows;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => ((out = out.filter((r) => r[c] === v)), chain),
      in: (c: string, vs: unknown[]) => ((out = out.filter((r) => vs.includes(r[c]))), chain),
      gt: (c: string, v: unknown) => ((out = out.filter((r) => String(r[c]) > String(v))), chain),
      order: () => chain,
      limit: (n: number) => ((out = out.slice(0, n)), chain),
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: out, error: null }),
    };
    return chain;
  };
  return {
    from: (t: string) => query(tables[t] ?? []),
    rpc: async (name: string) => {
      rpcCalls.push(name);
      return { data: null, error: new Error("no rpc in this test") };
    },
  };
}
async function readerRefusesForeignEvidence(): Promise<boolean> {
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const PQ = uid(8001);
  const PROTO = uid(9001);
  const calls: string[] = [];
  const client = stubClient(
    {
      pilots: [{ id: PILOT, project_id: PROJECT, company_name: COMPANY, website_url: `https://${DOMAIN}`, normalized_domain: DOMAIN, starts_on: "2026-11-18", ends_on: "2027-02-16", status: "active" }],
      projects: [{ id: PROJECT, company_name: COMPANY, domain: DOMAIN }],
      pilot_questions: [{ id: PQ, pilot_id: PILOT, project_id: PROJECT, ordinal: 1, question_provenance: "customer_supplied", customer_approved_on: "2026-11-18", retired_at: null }],
      pilot_question_protocols: [{ pilot_question_id: PQ, project_id: PROJECT, engine: "perplexity_sonar", phase: "baseline", protocol_id: PROTO }],
      protocols: [{ id: PROTO, project_id: OTHER, buyer_question_version_id: uid(7001) }],
    },
    calls
  );
  const result = await buildAndSavePilotReport(client as never, PILOT, uid(1));
  return result.outcome === "EVIDENCE_OUTSIDE_PILOT" && result.artifactId === null && calls.length === 0;
}

/* ---------------------------------------------------------------- W */

const SECTION_19 = ["you lost the sale", "cannot find you", "overall ai visibility", "caused the lift", "we control what", "we guarantee", "no competitor offers"];
const copyTexts = Object.values(copy).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "object" ? Object.values(v as Record<string, string>) : []));
const pages = [renderPage(p), renderPage(withRetired.payload), renderPage(unfinished.payload), renderPage(p, { preview: true })];
// The two sentences METHODOLOGY §4 and §7 require verbatim are left out of the phrase scan ("not guaranteed" is a required negation).
const MANDATED = [PERPLEXITY_SURFACE_LIMITATION, DEPENDENCE_LIMITATION].map((t) => t.toLowerCase());
const allText = MANDATED.reduce(
  (t, m) => t.split(m).join(" "),
  [md, renderPilotReportMarkdown(withRetired.payload), renderPilotReportMarkdown(unfinished.payload), ...pages, ...copyTexts, ...PILOT_LIMITATIONS, ...p.methodNotes, PILOT_CAUSAL_LIMIT, readFileSync("components/report/pilot-report-view.tsx", "utf8")]
    .join("\n")
    .toLowerCase()
);
check("W1 no forbidden claim phrase in the Markdown, the copy, the method notes or the view",
  FORBIDDEN_W1_PHRASES.every((ph) => !allText.includes(ph)) && SECTION_19.every((ph) => !allText.includes(ph)),
  [...FORBIDDEN_W1_PHRASES, ...SECTION_19].filter((ph) => allText.includes(ph)).join(","));
check("W2 no score, overall figure or combined-engine wording", !/\bscore\b|\boverall\b|combined across engines|all engines combined/.test(allText.replace(/never a score|it is not a score/g, "")));
const STORED_CODES = ["customer_supplied", "founder_supplied", "observed_consistently_in_sample", "not_observed_consistently_in_sample", "mixed_in_sample", "insufficient_evidence", "perplexity_sonar", "openai_chatgpt", "integrity_passed", "needs_review", "abandoned_exhausted", "not_finished", "review_platform"];
const STORED_CODES_ALL = [...STORED_CODES, "live_perplexity", "simulated", "in_progress", "excluded_no_result", "timed_out", "perplexity-sonar"];
const renderedAll = [md, renderPilotReportMarkdown(withRetired.payload), ...pages].join("\n");
check("W3 no stored code reaches the Markdown or the rendered page (customer view and preview)",
  STORED_CODES_ALL.every((c) => !renderedAll.includes(c)), STORED_CODES_ALL.filter((c) => renderedAll.includes(c)).join(","));
check("W4 the D-053 limitation is stated", md.includes("Results show what these engines answered during the pilot. They don't represent every AI tool or every buyer."));
check("W5 the Markdown states the total is not a score and how it is weighted",
  md.includes(copy.PORTFOLIO_WEIGHTING_WORDS) && p.methodNotes.some((n) => n.includes("It is not a score")));

/* ---------------------------------------------------------------- T */

const page = readFileSync("app/pilot-report/[secureToken]/page.tsx", "utf8");
const tokenCheck = page.indexOf("PILOT_REPORT_TOKEN.test(secureToken)");
const read = page.indexOf("readSharedPilotReport(");
check("T1 the page checks the token's shape before any read, and answers 404 otherwise",
  tokenCheck > 0 && read > tokenCheck && /\^\[0-9a-f\]\{64\}\$/.test(page) && /notFound\(\)/.test(page));
check("T2 the page reads only through the shared-only function, never the table", !page.includes('.from("pilot_report_artifacts")') && page.includes("readSharedPilotReport"));
check("T3 the page is noindex", /index:\s*false/.test(page) && /follow:\s*false/.test(page));
check("T4 the page renders only a payload that passes the type guard", /isPilotReportPayload\(shared\.payload\)/.test(page));
const proc = readFileSync("lib/reports/process-pilot-report.ts", "utf8");
check("T5 the client read goes through read_shared_pilot_report", /rpc\("read_shared_pilot_report"/.test(proc));
for (const [file, call] of [
  ["app/api/internal/pilots/[pilotId]/report/route.ts", "buildAndSavePilotReport("],
  ["app/api/internal/pilots/[pilotId]/report/[artifactId]/share/route.ts", "sharePilotReport("],
] as const) {
  const src = readFileSync(file, "utf8");
  const guard = src.indexOf("requireFounderForRoute(");
  check(`T6 ${file.split("/").slice(-2).join("/")}: the founder is checked before any work, behind the console switch`,
    guard > 0 && src.indexOf(call) > guard && src.indexOf('SNAPSHOT_APPROVAL_ENABLED !== "true"') < guard);
  check(`T7 ${file.split("/").slice(-2).join("/")}: its log has closed fields only`,
    !/questionText|markdown|payload:|publicToken|public_token/.test(src.slice(src.indexOf("console.info"), src.indexOf("\n  );", src.indexOf("console.info")))));
}
const admin = readFileSync("app/admin/pilots/[pilotId]/page.tsx", "utf8");
const previewPage = readFileSync("app/admin/pilots/[pilotId]/report/[artifactId]/page.tsx", "utf8");
check("T8 Share is offered only on the revision's preview, never on the pilot page, and only for the newest revision that is neither shared nor blocked",
  !admin.includes("SharePilotReportButton") && previewPage.includes("<SharePilotReportButton") &&
  /canShare = revision\.isLatest && revision\.sharedAt === null && revision\.integrityStatus !== "blocked"/.test(previewPage) &&
  admin.includes("/admin/pilots/${pilot.id}/report/${r.id}"));
check("T8b the preview is founder-only and renders the stored revision with the customer's own view, labelled as a preview",
  previewPage.indexOf("requireFounderForPage(") > 0 && previewPage.indexOf("requireFounderForPage(") < previewPage.indexOf("readPilotReportRevision(") &&
  /<PilotReportView[\s\S]*payload=\{revision\.payload\}[\s\S]*preview/.test(previewPage) && /isPilotReportPayload\(revision\.payload\)/.test(previewPage));
const customerPage = readFileSync("app/pilot-report/[secureToken]/page.tsx", "utf8");
check("T8c the customer's page renders the same view from the stored payload, without the preview label",
  /<PilotReportView[\s\S]*payload=\{shared\.payload\}/.test(customerPage) && !/preview/.test(customerPage.slice(customerPage.indexOf("<PilotReportView"))));
check("T8d the share confirmation says the founder has read this revision",
  /I have read this revision in full/.test(copy.SHARE_PASSED_PROMPT) && /I have read this revision in full/.test(copy.SHARE_NEEDS_REVIEW_PROMPT));
const buildRoute = readFileSync("app/api/internal/pilots/[pilotId]/report/route.ts", "utf8");
check("T10 the build route refuses while a measurement is running, after the founder check and before any build",
  buildRoute.indexOf("requireFounderForRoute(") < buildRoute.indexOf("pilotMeasurementInProgress(") &&
  buildRoute.indexOf("pilotMeasurementInProgress(") < buildRoute.indexOf("buildAndSavePilotReport(client") &&
  buildRoute.includes("BUILD_PILOT_REPORT_REFUSAL.MEASUREMENT_IN_PROGRESS"));
const reader = readFileSync("lib/reports/read-pilot-evidence.ts", "utf8");
check("T11 'still running' covers live leases, pending run requests and reserved or in-progress attempts, for the pilot's protocols and their retests",
  /\.in\("status", \["reserved", "in_progress"\]\)/.test(reader) && /\.eq\("status", "pending"\)/.test(reader) &&
  /lease_expires_at/.test(reader) && /baseline_protocol_id/.test(reader));
check("T12 the mismatch refusal names the realistic cause and says to build again",
  /still finishing/.test(copy.BUILD_PILOT_REPORT_REFUSAL.EVIDENCE_MISMATCH) && /Build the report again/.test(copy.BUILD_PILOT_REPORT_REFUSAL.EVIDENCE_MISMATCH));
check("T9 the console shows a link only once a revision is shared",
  /publicToken: r\.shared_at && r\.public_token/.test(proc));

/* ---------------------------------------------------------------- M */

const MIG = readFileSync("supabase/migrations/20261109150000_pilot_report_artifacts.sql", "utf8");
const body = MIG.replace(/^\s*--.*$/gm, "");
const fns = [...body.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
check("M1 four functions are created", fns.sort().join(",") === "pilot_report_artifacts_guard,read_shared_pilot_report,save_pilot_report_artifact,share_pilot_report_artifact", fns.join(","));
for (const fn of ["save_pilot_report_artifact", "share_pilot_report_artifact", "read_shared_pilot_report"]) {
  const def = body.slice(body.indexOf(`function public.${fn}(`), body.indexOf("$$;", body.indexOf(`function public.${fn}(`)));
  check(`M2 ${fn} is SECURITY DEFINER with a pinned search_path, executable by service_role only`,
    /security definer/.test(def) && /set search_path = public, pg_temp/.test(def) &&
    new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public;`).test(body) &&
    new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from anon;`).test(body) &&
    new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from authenticated;`).test(body) &&
    new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`).test(body));
}
check("M3 the guard's function is executable by no role", /revoke all on function public\.pilot_report_artifacts_guard\(\) from public, anon, authenticated, service_role;/.test(body));
check("M4 RLS is on and service_role may only read the table",
  /alter table public\.pilot_report_artifacts enable row level security;/.test(body) &&
  /revoke all on table public\.pilot_report_artifacts from public, anon, authenticated, service_role;/.test(body) &&
  /grant select on table public\.pilot_report_artifacts to service_role;/.test(body) && !/grant (insert|update|delete)/.test(body));
check("M5 the guard runs before every update and delete, and freezes a shared revision and all content",
  /before update or delete on public\.pilot_report_artifacts/.test(body) && body.includes("pilot_report_artifact_is_shared_and_immutable") &&
  body.includes("pilot_report_artifact_content_is_immutable") && body.includes("pilot_report_artifacts_are_append_only"));
check("M6 the save refuses evidence outside the pilot, an incomplete manifest and a hash mismatch",
  ["EVIDENCE_OUTSIDE_PILOT", "EVIDENCE_INCOMPLETE", "EVIDENCE_MISMATCH"].every((o) => body.includes(`'${o}'::text`)));
check("M7 the share refuses a blocked revision, a needs-review one without acknowledgement, and an older revision",
  ["BLOCKED", "ACKNOWLEDGEMENT_REQUIRED", "NOT_LATEST"].every((o) => body.includes(`'${o}'::text`)));
check("M8 the read answers only a shared, non-blocked revision for a well-formed token",
  /p_public_token ~ '\^\[0-9a-f\]\{64\}\$'/.test(body) && /a\.shared_at is not null/.test(body) && /a\.integrity_status <> 'blocked'/.test(body));
check("M9 a blocked revision can never be marked shared, by constraint too", /integrity_status <> 'blocked' or shared_at is null/.test(body));
check("M10 nothing existing is redefined and nothing from the account stack is used",
  !/create or replace function public\.(request_protocol_job_run|claim_|retry_|approve_|save_protocol|save_outcome)/.test(body) &&
  !/workspace_|account_session/.test(body));
check("M11 the payload must name the pilot it is saved for", body.includes("(p_payload ->> 'pilotId') is distinct from p_pilot_id::text"));
const saveDef = body.slice(body.indexOf("function public.save_pilot_report_artifact("), body.indexOf("$$;", body.indexOf("function public.save_pilot_report_artifact(")));
check("M12 the save refuses while a measurement is running, before any evidence check, for baselines and retests alike",
  saveDef.indexOf("'MEASUREMENT_IN_PROGRESS'::text") > 0 &&
  saveDef.indexOf("'MEASUREMENT_IN_PROGRESS'::text") < saveDef.indexOf("'EVIDENCE_INCOMPLETE'::text") &&
  saveDef.indexOf("'MEASUREMENT_IN_PROGRESS'::text") < saveDef.indexOf("'EVIDENCE_MISMATCH'::text") &&
  /pr\.baseline_protocol_id = pqp\.protocol_id/.test(saveDef) && /a\.status in \('reserved', 'in_progress'\)/.test(saveDef) &&
  /r\.status = 'pending'/.test(saveDef) && /j\.lease_expires_at > now\(\)/.test(saveDef) &&
  saveDef.indexOf("for update") < saveDef.indexOf("'MEASUREMENT_IN_PROGRESS'::text"));

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
check("R1 test:pilot-report is registered", pkg.scripts["test:pilot-report"] === "tsx scripts/test-pilot-report.ts");

readerRefusesForeignEvidence()
  .then((ok) => {
    check("I6a the real reader refuses evidence from another project: the build answers EVIDENCE_OUTSIDE_PILOT and nothing is saved", ok);
  })
  .catch((error) => check("I6a the real reader refuses evidence from another project", false, String(error)))
  .finally(() => {
    console.log(`\n${total - failures}/${total} checks passed.`);
    if (failures > 0) {
      console.error("Pilot report FAILED.");
      process.exit(1);
    }
    console.log("Pilot report PASSED.");
  });
