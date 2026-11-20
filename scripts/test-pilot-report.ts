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
 *   X  D-061, two engines: each engine's table, note and total count only
 *      its own questions and name the others; no figure combines engines;
 *      each engine's limitation sentence, verbatim; a measurement still
 *      being collected or with no readable answer never shows "0 of 0";
 *      the hero names only engines with a readable answer; ChatGPT's
 *      sources read under its own rule; "how it was measured" names
 *      ChatGPT's setting, tier and source rule; a slot on another engine or
 *      another question blocks; stored one-engine revisions still render;
 *      the reader reads each protocol's setting;
 *   W  wording: no forbidden claim, no overall score, no stored code on the
 *      page or in the Markdown, the D-053 limitation;
 *   T  the client page: token shape first, the shared-only read, noindex;
 *      an earlier link, once a later revision is shared, shows only a
 *      notice with nothing of the report (D-060); the routes are
 *      founder-guarded; the page itself, called for real with the read
 *      faked at the fetch layer (T13 to T16): the newest revision renders,
 *      an earlier link renders exactly the notice, anything else is a 404,
 *      and a malformed token is a 404 before any read;
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
import { ACTION_TYPES } from "@/lib/interventions/types";
import { RETEST_MEMBER_STATES, RETEST_NOTE_KINDS } from "@/lib/pilots/retest-rules";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import { OUTCOME_REASON_WORDS } from "@/lib/reports/pilot-retest-copy";
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
import { readPilotReportInput } from "@/lib/reports/read-pilot-evidence";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";
import { CHATGPT_SURFACE_LIMITATION, DEPENDENCE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION } from "@/lib/reports/surface-limitations";
import type { BuildProtocolReportInput, EvidenceAttemptInput, EvidenceResultInput } from "@/lib/reports/protocol-report-types";
import {
  extractProviderSources,
  OPENAI_RESPONSES_SOURCES_RULE_VERSION,
  PROVIDER_SOURCES_RULE_VERSION,
} from "@/lib/source-insights/extract-provider-sources";

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
  /** The planned slot (baseline ordinal); by default the run's position. A retry keeps its slot's ordinal. */
  ordinal?: number;
  /** A retry of the run at this index of the same list. */
  retryOf?: number;
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
      baselineOrdinal: r.ordinal ?? i + 1,
      probeRunId,
      retryOfAttemptId: r.retryOf === undefined ? null : attempts[r.retryOf]?.id ?? null,
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
  /** D-061 (review of phase B) — the job's review resolution, as the reader passes it. */
  reviewResolution?: string | null;
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
        ...(opts.reviewResolution === undefined ? {} : { reviewResolution: opts.reviewResolution }),
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
        preview: opts.preview ?? false,
      })
    )
  );
// D-060 — what an earlier link shows once a later revision is shared.
const { PilotReportReplacedNotice } = require("@/components/report/pilot-report-view") as { PilotReportReplacedNotice: unknown };
const renderReplacedNotice = () => textOf(renderToStaticMarkup(createElement(PilotReportReplacedNotice, {})));
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
  // D-062 — the retest's pure modules.
  "lib/pilots/retest-rules.ts",
  "lib/pilots/retest-copy.ts",
  "lib/reports/pilot-retest-copy.ts",
  "lib/reports/build-pilot-retests.ts",
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
// Run 5 failed at the provider and its retry, which keeps slot 5, completed.
const q2Runs: RunSpec[] = [
  ...five([false, true, false, false], [["vanta "], [], [], []]),
  { status: "failed" },
  { status: "completed", mentioned: false, competitors: [], ordinal: 5, retryOf: 4 },
];
// An excluded attempt exists only once a review closed its run, and a job
// that then succeeded was ended by that review (excluded_and_completed): 3
// of 5 planned answers completed (D-061, review of phase B).
const q3Runs: RunSpec[] = [
  { status: "completed", mentioned: null },
  { status: "completed", mentioned: true },
  { status: "completed", mentioned: false },
  { status: "excluded" },
];
const base = input([question(1, q1Runs), question(2, q2Runs), question(3, q3Runs, { reviewResolution: "excluded_and_completed" })]);
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
check("B6 the total line is a count over finished questions, each readable answer once; question 3, ended after review, is left out and named",
  portfolio.numerator === 5 + 1 && portfolio.denominator === 5 + 5 && portfolio.includedOrdinals.join() === "1,2"
    && portfolio.leftOutOrdinals.join() === "3" && perplexity.rows.find((r) => r.ordinal === 3)?.state === "ended_after_review",
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

const cleanBuilt = buildPilotReport(input([question(1, q1Runs), question(2, q2Runs)]));
const passed = integrityOf(cleanBuilt);
check("I1 a pilot whose questions all finished with good evidence passes with no reason",
  passed.status === "integrity_passed" && passed.reasons.length === 0, JSON.stringify(passed));
const baseI = integrityOf(built);
check("I1b a question a review ended (question 3: an excluded run, 3 of 5 planned answers completed) holds the report, for that reason alone",
  baseI.status === "needs_review"
    && JSON.stringify(baseI.reasons) === JSON.stringify(["Question 3: the Perplexity measurement ended after review with 3 of 5 planned answers completed."]),
  JSON.stringify(baseI.reasons));

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
check("I5c a pilot whose every question is retired never says the engine named the brand, and says what happened in words, never \"0 of 0\"",
  arEngine.measured && arEngine.questionsWithReadableAnswer === 0 && arEngine.questionsRetired === 1 &&
  arEngine.note === "no live question is measured on it; 1 retired." && !/named in \d+ of/i.test(arPage) &&
  presentPilotReport(allRetired.payload).engines[0] === "Perplexity: no live question is measured on it; 1 retired." &&
  !/\b0 of 0\b/.test(arPage) && !/\b0 of 0\b/.test(renderPilotReportMarkdown(allRetired.payload)) &&
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

/* ---------------------------------------------------------------- X: two engines (D-061) */

const GPT_MODEL = "gpt-5.4-2026-03-05";
const GPT_SETTING = "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05";
const G2_PAGE = "https://www.g2.com/categories/x";

/** A stored Responses body, shaped like the confirmation run's: search sources, and url_citation links carrying OpenAI's tag. */
function chatgptBody(text: string, cited: string[], returned: string[] = []): string {
  return JSON.stringify({
    id: "resp_x",
    object: "response",
    status: "completed",
    error: null,
    model: GPT_MODEL,
    service_tier: "flex",
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q", sources: [...cited, ...returned].map((url) => ({ type: "url", url })) } },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: cited.map((url, i) => ({ type: "url_citation", start_index: 0, end_index: 5, url: `${url}?utm_source=openai`, title: `Source ${i + 1}` })) }],
      },
    ],
  });
}

interface ChatGptOpts {
  jobStatus?: string | null;
  settingVersion?: string | null;
  provider?: string;
  questionText?: string;
  /** D-061 (review of phase B) — the job's review resolution, as the reader passes it. */
  reviewResolution?: string | null;
}

/** The same pilot question with a ChatGPT slot added beside its Perplexity one. */
function withChatGpt(q: PilotReportQuestionInput, runs: RunSpec[], opts: ChatGptOpts = {}): PilotReportQuestionInput {
  const protocolId = uid(9500 + q.ordinal);
  const text = opts.questionText ?? q.slots[0].evidence.question.text;
  const ev = evidence(protocolId, text, runs.map((r) => ({ ...r, body: r.body === undefined ? chatgptBody("Options include Vanta.", [G2_PAGE]) : r.body })));
  ev.protocol = { ...ev.protocol, provider: opts.provider ?? "openai_chatgpt", model: GPT_MODEL };
  ev.results = ev.results.map((r) => ({ ...r, providerModel: GPT_MODEL }));
  return {
    ...q,
    slots: [
      ...q.slots,
      {
        engine: "openai_chatgpt",
        protocolId,
        jobStatus: opts.jobStatus === undefined ? "succeeded" : opts.jobStatus,
        evidence: ev,
        execution: runs.length > 0 ? { firstOn: "2026-11-20", lastOn: "2026-11-21" } : { firstOn: null, lastOn: null },
        answerModes: runs.length > 0 ? ["live_openai_chatgpt"] : [],
        settingVersion: opts.settingVersion === undefined ? GPT_SETTING : opts.settingVersion,
        ...(opts.reviewResolution === undefined ? {} : { reviewResolution: opts.reviewResolution }),
      },
    ],
  };
}

// Question 1 on both engines, both finished; question 2 on both, its ChatGPT
// answers still being collected (none readable yet); question 3 on Perplexity only.
const two = buildPilotReport(input([
  withChatGpt(question(1, q1Runs), five([true, false, true, true, true])),
  withChatGpt(question(2, q2Runs), [{ status: "in_progress" }, { status: "reserved" }], { jobStatus: "running" }),
  question(3, q3Runs),
]));
const tp = two.payload;
const tView = presentPilotReport(tp);
const tPage = renderPage(tp);
const tMd = renderPilotReportMarkdown(tp);
const tMdFlat = flat(tMd);
const gptBrand = tp.brand.find((s) => s.engine === "openai_chatgpt")!;
const pplxBrand = tp.brand.find((s) => s.engine === "perplexity_sonar")!;
const gptEngine = tp.engines.find((e) => e.engine === "openai_chatgpt")!;
const sectionOf = (v: ReturnType<typeof presentPilotReport>, key: string) => v.sections.find((s) => s.key === key)!;
const condOf = (v: ReturnType<typeof presentPilotReport>, engine: string) => v.conditions.find((c) => c.key === `conditions-${engine}`)!;

check("X1 each engine's table and total count only the questions measured on it: ChatGPT's rows are questions 1 and 2, its total 4 of 5 from question 1 alone; Perplexity's section equals the one-engine report's",
  gptBrand.rows.map((r) => r.ordinal).join() === "1,2" && gptBrand.portfolio?.numerator === 4 && gptBrand.portfolio?.denominator === 5 &&
  gptBrand.portfolio?.includedOrdinals.join() === "1" && gptBrand.portfolio?.leftOutOrdinals.join() === "2" &&
  JSON.stringify(pplxBrand) === JSON.stringify(perplexity),
  JSON.stringify(gptBrand.portfolio));
const combined = `${pplxBrand.portfolio!.numerator + gptBrand.portfolio!.numerator} of ${pplxBrand.portfolio!.denominator + gptBrand.portfolio!.denominator}`;
check("X2 no figure combines engines: each total is its own engine's rows only, the two engines' sum appears nowhere, and every table section belongs to one engine",
  tp.brand.every((s) => !s.portfolio || s.portfolio.numerator === s.rows.filter((r) => s.portfolio!.includedOrdinals.includes(r.ordinal)).reduce((n, r) => n + (r.numerator ?? 0), 0)) &&
  !tPage.includes(combined) && !tMd.includes(combined) &&
  tView.sections.every((s) => /^(brand|competitors|sources|domains)-(perplexity_sonar|openai_chatgpt)$/.test(s.key)) &&
  !/combined across engines|all engines combined/.test(`${tPage}\n${tMd}`.toLowerCase()), combined);
check("X3 each engine's section carries its own required limitation, verbatim, on the page and in the Markdown, with the dependence warning by every table and the causal footer",
  condOf(tView, "openai_chatgpt").paragraphs.join() === CHATGPT_SURFACE_LIMITATION &&
  condOf(tView, "perplexity_sonar").paragraphs.join() === PERPLEXITY_SURFACE_LIMITATION &&
  [tPage, tMdFlat].every((t) => [CHATGPT_SURFACE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION, DEPENDENCE_LIMITATION, PILOT_CAUSAL_LIMIT].every((s) => t.includes(s))) &&
  tView.sections.filter((s) => s.key.startsWith("brand-")).length === 2 &&
  tView.sections.filter((s) => s.key.startsWith("brand-")).every((s) => s.notes.includes(DEPENDENCE_LIMITATION)));
const q2View = tView.questions.find((q) => q.key === uid(8002))!;
const q3View = tView.questions.find((q) => q.key === uid(8003))!;
check("X4 a live question not measured on ChatGPT is named, never counted: in the engine note, under ChatGPT's table and in its own section, and in no ChatGPT row or total",
  JSON.stringify(gptEngine.questionsNotMeasured) === "[3]" &&
  gptEngine.note === "1 of 2 questions with at least one readable answer; not measured on ChatGPT for question 3." &&
  sectionOf(tView, "brand-openai_chatgpt").notes.includes("Not measured on ChatGPT, so not in this table or its total: question 3.") &&
  q3View.lines.includes("ChatGPT: not measured for this question.") &&
  !gptBrand.rows.some((r) => r.ordinal === 3) && !gptBrand.portfolio!.leftOutOrdinals.includes(3) &&
  JSON.stringify(tp.engines.find((e) => e.engine === "perplexity_sonar")!.questionsNotMeasured) === "[]" &&
  [tPage, tMdFlat].every((t) => t.includes("not measured on ChatGPT for question 3")),
  gptEngine.note);
const gptRow2 = sectionOf(tView, "brand-openai_chatgpt").table!.rows.find((r) => r[0] === "2")!;
check("X5 a ChatGPT measurement still being collected never shows \"0 of 0\": its row and its question section say so in words, beside its counts",
  !/\b0 of 0\b/.test(tPage) && !/\b0 of 0\b/.test(tMd) &&
  gptRow2[1] === "Not finished" && gptRow2[2] === "No readable answer yet" && gptRow2[4].includes("2 still being collected") &&
  q2View.lines.includes("ChatGPT (Not finished): no readable answer yet; the measurement has not finished.") &&
  q2View.lines.some((l) => l.startsWith("Attempts: 2 attempted of 5 planned") && l.includes("2 still being collected")) &&
  two.structural.some((r) => r.status === "needs_review" && r.reason === "Question 2: 2 ChatGPT answers are still being collected."),
  JSON.stringify(gptRow2));

// ChatGPT added to questions 1 and 2 and still queued: no attempt, no answer.
const queued = buildPilotReport(input([
  withChatGpt(question(1, q1Runs), [], { jobStatus: "queued" }),
  withChatGpt(question(2, q2Runs), [], { jobStatus: "queued" }),
  question(3, q3Runs),
]));
const qView = presentPilotReport(queued.payload);
const qPage = renderPage(queued.payload);
const qMd = renderPilotReportMarkdown(queued.payload);
const heroLast = (pl: PilotReportPayload) => {
  const hero = presentPilotReport(pl).heroCopy;
  return hero[hero.length - 1];
};
check("X6 the hero names only the engines that produced a readable answer",
  heroLast(queued.payload).includes("Results show what Perplexity answered during the pilot;") &&
  heroLast(tp).includes("Results show what Perplexity and ChatGPT answered during the pilot;") &&
  !qPage.includes("what Perplexity and ChatGPT answered"), heroLast(queued.payload));
check("X7 an engine with slots but no readable answer yet never prints \"0 of 0\": no total, its rows and sections say why, and its note gives the counts",
  !/\b0 of 0\b/.test(qPage) && !/\b0 of 0\b/.test(qMd) &&
  sectionOf(qView, "brand-openai_chatgpt").notes.includes("No question has finished with a readable answer, so there is no total.") &&
  !sectionOf(qView, "brand-openai_chatgpt").notes.some((n) => n.startsWith("Total across") || n.startsWith("Left out")) &&
  sectionOf(qView, "brand-openai_chatgpt").table!.rows.every((r) => r[1] === "Not started" && r[2] === "No answer yet") &&
  ["competitors", "sources"].every((k) => sectionOf(qView, `${k}-openai_chatgpt`).notes.includes("There is no readable ChatGPT answer yet, so there is nothing to show here.")) &&
  qView.questions[0].lines.includes("ChatGPT (Not started): no answer has been collected yet.") &&
  qView.questions[0].lines.includes("Attempts: 0 attempted of 5 planned: 0 completed, 0 failed, 0 excluded after review, 0 without a readable result.") &&
  queued.payload.engines.find((e) => e.engine === "openai_chatgpt")!.note ===
    "0 of 2 questions with at least one readable answer; 2 not started; not measured on ChatGPT for question 3.",
  JSON.stringify(sectionOf(qView, "brand-openai_chatgpt").notes));
const stoppedGpt = buildPilotReport(input([withChatGpt(question(1, q1Runs), [{ status: "failed" }, { status: "failed" }], { jobStatus: "failed" })]));
const sView = presentPilotReport(stoppedGpt.payload);
check("X7b a ChatGPT measurement that stopped with no readable answer says so in its row, its line and its sections, never \"0 of 0\"",
  !/\b0 of 0\b/.test(renderPage(stoppedGpt.payload)) && !/\b0 of 0\b/.test(renderPilotReportMarkdown(stoppedGpt.payload)) &&
  sectionOf(sView, "brand-openai_chatgpt").table!.rows[0][2] === "No readable answer" &&
  sView.questions[0].lines.includes("ChatGPT (Stopped before finishing): it stopped before producing a readable answer.") &&
  ["competitors", "sources"].every((k) => sectionOf(sView, `${k}-openai_chatgpt`).notes.includes("No readable ChatGPT answer is reported, so there is nothing to show here.")));

// What readIntegritySignals gives a measurement with no completed attempt: both per-answer checks false by construction.
const signalsWith = (b: ReturnType<typeof buildPilotReport>, withAttempts: boolean): PilotQuestionSignals[] =>
  b.payload.questions.flatMap((q) =>
    q.measurements.map((m) => ({
      ordinal: q.ordinal,
      engine: m.engine,
      retired: q.retired,
      completedAttempts: m.counts.completed,
      ...(withAttempts ? { attempts: m.counts.attempted } : {}),
      signals: m.counts.completed === 0 ? { ...GOOD, hasPaidCallReservation: false, hasCompleteEvidenceHashes: false } : GOOD,
    }))
  );
const queuedI = integrityOf(queued, signalsWith(queued, true));
const queuedUnknown = integrityOf(queued, signalsWith(queued, false));
check("X8 a queued ChatGPT measurement with no attempt holds the report once, by its \"has not finished\" reason, without the per-answer reasons that are false by construction; with its attempt count unknown they still run",
  queuedI.status === "needs_review" && queuedI.reasons.includes("Question 1: the ChatGPT measurement has not finished.") &&
  !queuedI.reasons.some((r) => r.startsWith("Question 1 (ChatGPT):") || r.startsWith("Question 2 (ChatGPT):")) &&
  queuedUnknown.status === "needs_review" && queuedUnknown.reasons.some((r) => r.startsWith("Question 1 (ChatGPT):")),
  JSON.stringify(queuedI.reasons));
const stoppedI = integrityOf(stoppedGpt, signalsWith(stoppedGpt, true));
check("X8b a live measurement with attempts but no completed answer still runs every per-answer check",
  stoppedI.status === "needs_review" && stoppedI.reasons.some((r) => r.startsWith("Question 1 (ChatGPT):")), JSON.stringify(stoppedI.reasons));
check("X8c the build passes each measurement's attempt count to the integrity rule", /attempts: m\.counts\.attempted/.test(proc0));
const finishedEmpty = buildPilotReport(input([withChatGpt(question(1, q1Runs), [], { jobStatus: "succeeded" })]));
check("X8d defence in depth: a measurement marked finished with no recorded attempt is held for review",
  finishedEmpty.structural.some((r) => r.status === "needs_review" && r.reason === "Question 1: the ChatGPT measurement is marked finished but has no recorded attempt.") &&
  integrityOf(finishedEmpty, signalsWith(finishedEmpty, true)).status === "needs_review");

const gptReport1 = tp.questions[0].measurements.find((m) => m.engine === "openai_chatgpt")!.report;
const gptSources = tp.sources.find((s) => s.engine === "openai_chatgpt")!;
const sampleBody = chatgptBody("Options include Vanta.", [G2_PAGE]);
check("X9 ChatGPT's answers are read under openai-responses-sources/1: each linked citation found with OpenAI's tag removed, and counted in ChatGPT's own source table; the rule is recorded per engine",
  gptReport1.sourceInsights?.extractionVersion === OPENAI_RESPONSES_SOURCES_RULE_VERSION &&
  gptReport1.sourceInsights.runsWithSourceEvidence === 5 &&
  gptReport1.sourceInsights.runs.every((r) => r.cited.length === 1 && r.cited[0].url === G2_PAGE) &&
  gptSources.rows.find((r) => r.category === "review_platform")?.cells.find((c) => c.ordinal === 1)?.citedInRuns === 5 &&
  JSON.stringify(tp.conditions.find((c) => c.engine === "openai_chatgpt")!.sourceRule) === JSON.stringify([{ value: OPENAI_RESPONSES_SOURCES_RULE_VERSION, ordinals: [1, 2] }]) &&
  JSON.stringify(tp.conditions.find((c) => c.engine === "perplexity_sonar")!.sourceRule) === JSON.stringify([{ value: PROVIDER_SOURCES_RULE_VERSION, ordinals: [1, 2, 3] }]) &&
  // The rule matters: the same body read without the provider (as a Perplexity Agent body) has no source at all.
  extractProviderSources(sampleBody, sha(sampleBody)).cited.length === 0,
  JSON.stringify(gptReport1.sourceInsights?.runs[0]));
const gptConditionsText = [
  "ChatGPT: how it was measured",
  "Engine: ChatGPT's model, through OpenAI's API (not the ChatGPT app).",
  `Model: ${GPT_MODEL}.`,
  `Setting version: ${GPT_SETTING}.`,
  `Service tier: ${copy.SETTING_TIER_WORDS["openai-responses-websearch-v4"]}.`,
  `Web search: ${copy.SETTING_SEARCH_WORDS.auto}.`,
  "Answers: live answers from OpenAI's API.",
  `Sources: ${copy.SOURCE_RULE_WORDS[OPENAI_RESPONSES_SOURCES_RULE_VERSION]}.`,
];
const pplxCond = condOf(tView, "perplexity_sonar");
check("X10 \"how it was measured\" for ChatGPT names the engine in words, the model, the setting version, the flex tier, web search and the source rule, on the page and in the Markdown; Perplexity's names its own rule and no setting",
  gptConditionsText.every((t) => tPage.includes(t) && tMdFlat.includes(t)) &&
  /flex tier/.test(copy.SETTING_TIER_WORDS["openai-responses-websearch-v4"]) &&
  pplxCond.notes.includes(`Sources: ${copy.SOURCE_RULE_WORDS[PROVIDER_SOURCES_RULE_VERSION]}.`) &&
  !pplxCond.notes.some((n) => /^(Setting version|Service tier|Web search):/.test(n)),
  gptConditionsText.filter((t) => !tPage.includes(t) || !tMdFlat.includes(t)).join(" | "));

const mismatched = buildPilotReport(input([withChatGpt(question(1, q1Runs), five([true, true, true]), { provider: "perplexity_sonar" })]));
check("X11 a slot whose protocol is on another engine blocks the report, and its section still carries its own engine's sentence",
  mismatched.structural.some((r) => r.status === "blocked" && r.reason === "Question 1: its ChatGPT measurement's protocol is for another engine.") &&
  integrityOf(mismatched).status === "blocked" &&
  condOf(presentPilotReport(mismatched.payload), "openai_chatgpt").paragraphs.join() === CHATGPT_SURFACE_LIMITATION);
const otherText = buildPilotReport(input([withChatGpt(question(1, q1Runs), five([true, true, true]), { questionText: "Which tools suit a very different team?" })]));
const otherHashQ = withChatGpt(question(1, q1Runs), five([true, true, true]));
otherHashQ.slots[1].evidence.question = { ...otherHashQ.slots[1].evidence.question, hash: sha("another version") };
const otherHash = buildPilotReport(input([otherHashQ]));
const sameQuestionReason = "Question 1: its measurements on different engines are not of the same approved question.";
check("X12 slots of one question whose approved text or hash differ block the report; the two-engine pilot has no blocking reason",
  [otherText, otherHash].every((b) => b.structural.some((r) => r.status === "blocked" && r.reason === sameQuestionReason) && integrityOf(b).status === "blocked") &&
  !two.structural.some((r) => r.status === "blocked") && !queued.structural.some((r) => r.status === "blocked"));

const mixedSetting = buildPilotReport(input([
  withChatGpt(question(1, q1Runs), five([true, true, true])),
  withChatGpt(question(2, q1Runs), five([true, true, true]), { settingVersion: "openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05" }),
]));
const noSetting = buildPilotReport(input([withChatGpt(question(1, q1Runs), five([true, true, true]), { settingVersion: null })]));
const msMd = flat(renderPilotReportMarkdown(mixedSetting.payload));
check("X13 ChatGPT questions under different settings are listed with their questions and held for review; ChatGPT answers with no recorded setting are held too; Perplexity, which records none, never is",
  mixedSetting.structural.some((r) => r.status === "needs_review" && r.reason === "ChatGPT questions were not all measured under the same setting.") &&
  msMd.includes(`Setting version: ${GPT_SETTING} (question 1); openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05 (question 2).`) &&
  msMd.includes(`Service tier: ${copy.SETTING_TIER_WORDS["openai-responses-websearch-v4"]} (question 1); OpenAI's standard tier (question 2).`) &&
  noSetting.structural.some((r) => r.status === "needs_review" && r.reason === "Some ChatGPT answers have no recorded setting.") &&
  integrityOf(noSetting).status === "needs_review" &&
  !built.structural.some((r) => /setting/.test(r.reason)) && JSON.stringify(p.conditions[0].settingVersion) === "[]",
  msMd.slice(0, 0));

// Report code may not import the adapter (P1), so its words are pinned to the adapter's source text.
const adapterSrc = readFileSync("lib/probes/chatgpt.ts", "utf8");
const families = [...adapterSrc.matchAll(/"(openai-responses-websearch-v\d+)": Object\.freeze\(\{[^}]*serviceTier: (null|"flex")/g)].map((m) => ({ family: m[1], flex: m[2] === '"flex"' }));
const searchModes = (/const CHATGPT_SEARCH_MODES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(adapterSrc)?.[1] ?? "").split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
const approvedSetting = /export const CHATGPT_APPROVED_SETTING_VERSION: string \| null = "([^"]+)";/.exec(adapterSrc)?.[1] ?? "";
check("X14 the report's setting words cover exactly the adapter's setting families and search modes, say flex where the adapter sends flex, and the approved setting is the one the fixtures use",
  families.length >= 3 && JSON.stringify(Object.keys(copy.SETTING_TIER_WORDS).sort()) === JSON.stringify(families.map((f) => f.family).sort()) &&
  families.every((f) => (f.flex ? /flex tier/ : /standard tier/).test(copy.SETTING_TIER_WORDS[f.family])) &&
  searchModes.length === 2 && JSON.stringify(Object.keys(copy.SETTING_SEARCH_WORDS).sort()) === JSON.stringify([...searchModes].sort()) &&
  approvedSetting === GPT_SETTING && copy.settingTierWords(approvedSetting) === copy.SETTING_TIER_WORDS["openai-responses-websearch-v4"] &&
  copy.settingSearchWords(approvedSetting) === copy.SETTING_SEARCH_WORDS.auto,
  JSON.stringify({ families, searchModes, approvedSetting }));
check("X15 the source-rule words cover exactly the two rules, and an unknown setting or rule is said to be unknown, never guessed",
  JSON.stringify(Object.keys(copy.SOURCE_RULE_WORDS).sort()) === JSON.stringify([OPENAI_RESPONSES_SOURCES_RULE_VERSION, PROVIDER_SOURCES_RULE_VERSION].sort()) &&
  copy.sourceRuleWords("provider-sources/0") === copy.UNKNOWN_SOURCE_RULE_WORDS &&
  copy.sourceRuleWords("constructor") === copy.UNKNOWN_SOURCE_RULE_WORDS &&
  copy.settingTierWords("openai-responses-websearch-v9:auto:gpt-x") === copy.UNKNOWN_SETTING_WORDS &&
  copy.settingSearchWords("openai-responses-websearch-v4:sometimes:gpt-x") === copy.UNKNOWN_SETTING_WORDS &&
  copy.settingTierWords("constructor:auto:gpt-x") === copy.UNKNOWN_SETTING_WORDS &&
  copy.settingTierWords("openai-responses-websearch-v4") === copy.UNKNOWN_SETTING_WORDS &&
  copy.settingTierWords("") === "not recorded" && copy.settingSearchWords("") === "not recorded");

/**
 * A revision as built before D-061: the same payload without the fields
 * D-061 added, and with the state the builder of that time gave a job that
 * succeeded ("measured"; "ended after review" did not exist).
 */
function asBeforeD061(pl: PilotReportPayload): PilotReportPayload {
  const c = JSON.parse(JSON.stringify(pl)) as PilotReportPayload;
  for (const e of c.engines) delete e.questionsNotMeasured;
  for (const k of c.conditions) {
    delete k.settingVersion;
    delete k.sourceRule;
  }
  for (const q of c.questions) {
    for (const m of q.measurements) {
      delete m.settingVersion;
      if (m.state === "ended_after_review") m.state = "measured";
    }
  }
  for (const s of c.brand) for (const r of s.rows) if (r.state === "ended_after_review") r.state = "measured";
  return c;
}
const oldOne = asBeforeD061(p);
const oldTwo = asBeforeD061(tp);
const oldPage = renderPage(oldOne);
const oldMd = flat(renderPilotReportMarkdown(oldOne));
const oldTwoPage = renderPage(oldTwo);
check("X16 a stored revision built before D-061 still passes the type guard and renders, with every required sentence and no gap",
  isPilotReportPayload(oldOne) && isPilotReportPayload(oldTwo) &&
  conditionsText.every((t) => oldPage.includes(t) && oldMd.includes(t)) &&
  [oldPage, oldMd, oldTwoPage, flat(renderPilotReportMarkdown(oldTwo))].every((t) => !/undefined|NaN|\[object Object\]/.test(t)) &&
  oldTwoPage.includes(CHATGPT_SURFACE_LIMITATION) && !oldPage.includes("Sources: read") && !oldTwoPage.includes("Setting version") &&
  oldPage.includes(`ChatGPT: ${ENGINE_NOT_MEASURED_NOTE}`) && oldPage.includes("ChatGPT: not measured for this question."),
  conditionsText.filter((t) => !oldPage.includes(t)).join(" | "));
// X16b (review of phase B, APP-6) — a stored revision built before D-061
// keeps the words of that time wherever D-061 changed them, so the page
// still says what its stored Markdown says. Pinned exactly on two old
// payloads: one with a question not started beside a finished one, and one
// whose only question is not started (no readable answer at all).
const NOT_STARTED_ATTEMPTS = "0 attempted of 5 planned: 0 completed, 0 failed, 0 excluded after review, 0 without a readable result";
const OLD_ZERO_ROW = ["2", "Not started", "0 of 0 readable answers", "no range (no readable answer)", NOT_STARTED_ATTEMPTS, "Not enough answers"];
const OLD_ZERO_LINE = "Perplexity (Not started): named in 0 of 0 readable answers; likely range no range (no readable answer).";
const newUnfinished = unfinished.payload;
const oldUnfinished = asBeforeD061(newUnfinished);
const oldUnfinishedText = pageText(oldUnfinished);
const newUnfinishedText = pageText(newUnfinished);
const swapped = newUnfinishedText
  .filter((t) => !t.startsWith("Sources: "))
  .map((t) => (t === "No answer yet" ? "0 of 0 readable answers" : t === "Perplexity (Not started): no answer has been collected yet." ? OLD_ZERO_LINE : t));
check("X16b an old revision with a question not started beside a finished one renders exactly as before D-061: its row says \"0 of 0 readable answers\", its line the old words, and every other string is unchanged (the new build differs only in those two and the source rule)",
  JSON.stringify(presentPilotReport(oldUnfinished).sections.find((s) => s.key === "brand-perplexity_sonar")!.table!.rows.find((r) => r[0] === "2")) === JSON.stringify(OLD_ZERO_ROW) &&
  presentPilotReport(oldUnfinished).questions[1].lines[0] === OLD_ZERO_LINE &&
  JSON.stringify(oldUnfinishedText) === JSON.stringify(swapped) &&
  newUnfinishedText.filter((t) => t.startsWith("Sources: ")).length === 1 && newUnfinishedText.includes("No answer yet") &&
  // ...and a revision whose questions all finished reads as before, apart from the one new line, the source rule.
  JSON.stringify(pageText(asBeforeD061(cleanBuilt.payload))) === JSON.stringify(pageText(cleanBuilt.payload).filter((t) => !t.startsWith("Sources: "))),
  JSON.stringify(oldUnfinishedText.filter((t, i) => t !== swapped[i])));
const nothingYet = buildPilotReport(input([question(1, [], { jobStatus: "queued" })])).payload;
const oldNothing = presentPilotReport(asBeforeD061(nothingYet));
const newNothing = presentPilotReport(nothingYet);
const notesOf = (v: ReturnType<typeof presentPilotReport>, key: string) => v.sections.find((s) => s.key === key)!.notes;
check("X16c an old revision whose only question is not started keeps the hero's engine, the total line, and the empty-section notes of that time; a new build words them for D-061",
  oldNothing.heroCopy[oldNothing.heroCopy.length - 1].includes("Results show what Perplexity answered during the pilot;") &&
  JSON.stringify(notesOf(oldNothing, "brand-perplexity_sonar")) === JSON.stringify([
    "Total across 0 finished questions: named in 0 of 0 readable answers. Each readable answer counts once (unweighted). No question has finished with a readable answer, so there is no total.",
    "Left out of the total: question 1.",
    DEPENDENCE_LIMITATION,
  ]) &&
  JSON.stringify(notesOf(oldNothing, "competitors-perplexity_sonar")) === JSON.stringify(["No other brand was named in a readable answer."]) &&
  JSON.stringify(notesOf(oldNothing, "sources-perplexity_sonar")) === JSON.stringify(["No readable answer had a usable source list."]) &&
  oldNothing.questions[0].lines[0] === "Perplexity (Not started): named in 0 of 0 readable answers; likely range no range (no readable answer)." &&
  newNothing.heroCopy[newNothing.heroCopy.length - 1].includes("Results show what the engines answered during the pilot;") &&
  JSON.stringify(notesOf(newNothing, "brand-perplexity_sonar")) === JSON.stringify(["No question has finished with a readable answer, so there is no total.", DEPENDENCE_LIMITATION]) &&
  JSON.stringify(notesOf(newNothing, "competitors-perplexity_sonar")) === JSON.stringify(["There is no readable Perplexity answer yet, so there is nothing to show here."]) &&
  !/\b0 of 0\b/.test(renderPage(nothingYet)) && /\b0 of 0\b/.test(renderPage(asBeforeD061(nothingYet))),
  JSON.stringify({ hero: oldNothing.heroCopy, brand: notesOf(oldNothing, "brand-perplexity_sonar") }));
check("X17 every string of the two-engine presentation appears on the page and in the Markdown",
  pageText(tp).every((t) => tPage.includes(flat(t).trim()) && (tMdFlat.includes(flat(t).trim()) || tMdFlat.includes(flat(t).replace(/\|/g, "\\|").trim()))),
  pageText(tp).filter((t) => !tPage.includes(flat(t).trim()) || !tMdFlat.includes(flat(t).trim())).slice(0, 3).join(" | "));

/* X19-X21: review of phase B (APP-1, APP-2) */

// APP-1 — question 1 retired because ChatGPT stopped for good, while its Perplexity measurement had finished 5 of 5.
const retiredMixed = buildPilotReport(input([
  withChatGpt(question(1, q1Runs, { retiredAt: "2026-11-21T09:00:00Z" }), [{ status: "failed" }, { status: "failed" }, { status: "failed" }], { jobStatus: "abandoned_exhausted" }),
  question(2, q1Runs),
]));
const rmView = presentPilotReport(retiredMixed.payload);
const rmPage = renderPage(retiredMixed.payload);
const rmMd = flat(renderPilotReportMarkdown(retiredMixed.payload));
const rmQ1 = rmView.questions.find((qq) => qq.key === uid(8001))!;
const rmPplx = retiredMixed.payload.brand.find((s) => s.engine === "perplexity_sonar")!;
check("X19 a question retired while one engine's measurement had finished says so truthfully: one of its measurements could not finish, each engine's line says how far it got, and never that its only measurement could not finish",
  rmQ1.meta.includes(copy.RETIRED_ONE_OF_SEVERAL_WORDS) && !rmQ1.meta.includes(copy.RETIRED_WORDS) &&
  !rmQ1.meta.includes("Retired: its measurement could not finish") &&
  rmQ1.lines[0] === "Perplexity (retired after this measurement finished): 5 attempted of 5 planned: 5 completed, 0 failed, 0 excluded after review, 0 without a readable result." &&
  rmQ1.lines[1] === "ChatGPT (retired; this measurement could not finish): 3 attempted of 5 planned: 0 completed, 3 failed, 0 excluded after review, 0 without a readable result." &&
  [rmPage, rmMd].every((t) => t.includes(copy.RETIRED_ONE_OF_SEVERAL_WORDS) && t.includes("Perplexity (retired after this measurement finished)")),
  JSON.stringify(rmQ1));
check("X19b its finished Perplexity figures are still not reported and left out of every total: the row shows counts only, the total is question 2's alone, and no other-brand or source figure comes from it",
  JSON.stringify(rmView.sections.find((s) => s.key === "brand-perplexity_sonar")!.table!.rows.find((r) => r[0] === "1")) ===
    JSON.stringify(["1", "Retired", "Not reported (retired)", "—", "5 attempted of 5 planned: 5 completed, 0 failed, 0 excluded after review, 0 without a readable result", "—"]) &&
  rmPplx.portfolio?.includedOrdinals.join() === "2" && rmPplx.portfolio?.leftOutOrdinals.join() === "1" &&
  retiredMixed.payload.sources.find((s) => s.engine === "perplexity_sonar")!.coverage.every((c) => c.ordinal === 2) &&
  retiredMixed.payload.competitors.find((s) => s.engine === "perplexity_sonar")!.rows.every((r) => r.appearances.every((a) => a.ordinal === 2)) &&
  rmQ1.lines.every((l) => !/named in/.test(l)),
  JSON.stringify(rmPplx.portfolio));
check("X19c the method note says retiring needs one measurement that could not finish, stops the question on every engine, and reports no figure even for a finished one",
  retiredMixed.payload.methodNotes.includes("A question is retired when one of its measurements could not finish, and retiring stops it on every engine. A retired question shows its attempt counts only, with no rate, range or reading, even for a measurement that had finished, and it is left out of every total.") &&
  !retiredMixed.payload.methodNotes.some((n) => n.startsWith("A retired question's measurement could not finish")) &&
  rmPage.includes("even for a measurement that had finished") && rmMd.includes("even for a measurement that had finished"));
const oneEngineRetired = presentPilotReport(withRetired.payload).questions[1];
check("X19d a retired question with one measurement keeps the earlier words: that measurement could not finish",
  oneEngineRetired.meta.includes(copy.RETIRED_WORDS) && oneEngineRetired.lines[0].startsWith("Perplexity (retired): "));

// APP-2 — a ChatGPT measurement a review ended after a timeout: the job succeeded with planned runs never made.
const ended = (runs: RunSpec[], reviewResolution?: string | null) => buildPilotReport(input([
  withChatGpt(question(1, q1Runs), five([true, true, true, true, true])),
  withChatGpt(question(2, q1Runs), runs, { jobStatus: "succeeded", ...(reviewResolution === undefined ? {} : { reviewResolution }) }),
]));
const timeoutAt3 = ended([{ status: "completed", mentioned: true }, { status: "completed", mentioned: true }, { status: "timed_out" }], "excluded_and_completed");
const t3View = presentPilotReport(timeoutAt3.payload);
const t3Gpt = timeoutAt3.payload.brand.find((s) => s.engine === "openai_chatgpt")!;
const t3Row = sectionOf(t3View, "brand-openai_chatgpt").table!.rows.find((r) => r[0] === "2")!;
const t3Q2 = t3View.questions.find((qq) => qq.key === uid(8002))!;
const t3I = integrityOf(timeoutAt3);
const ENDED_LINE = "Ended after review with 2 of 5 planned answers completed, so this result rests on fewer answers than planned; it is not counted in the total.";
check("X20 a measurement a review ended (timeout at run 3, the rest never made) never reads \"Finished\": its row says \"Ended after review\" beside its own figures and counts, and its section says how many planned answers it completed",
  t3Gpt.rows.find((r) => r.ordinal === 2)?.state === "ended_after_review" &&
  JSON.stringify(t3Row) === JSON.stringify(["2", "Ended after review", "2 of 2 readable answers", t3Row[3], "3 attempted of 5 planned: 2 completed, 1 failed, 0 excluded after review, 0 without a readable result", "Not enough answers"]) &&
  t3Q2.lines.some((l) => l.startsWith("ChatGPT (Ended after review): named in 2 of 2 readable answers;")) && t3Q2.lines.includes(ENDED_LINE) &&
  !t3Q2.lines.some((l) => l.startsWith("ChatGPT (Finished)")) &&
  [renderPage(timeoutAt3.payload), flat(renderPilotReportMarkdown(timeoutAt3.payload))].every((t) => t.includes(ENDED_LINE)),
  JSON.stringify(t3Row));
check("X20b it holds the report for review, with a reason that names it, even when every per-answer signal is good",
  t3I.status === "needs_review" && t3I.reasons.includes("Question 2: the ChatGPT measurement ended after review with 2 of 5 planned answers completed.") &&
  timeoutAt3.structural.some((r) => r.status === "needs_review" && r.reason.startsWith("Question 2: the ChatGPT measurement ended after review")),
  JSON.stringify(t3I));
check("X20c (engineer) it is left out of ChatGPT's total and named there, and its evidence stays: the total is question 1's 5 of 5 alone",
  t3Gpt.portfolio?.includedOrdinals.join() === "1" && t3Gpt.portfolio?.leftOutOrdinals.join() === "2" &&
  t3Gpt.portfolio?.numerator === 5 && t3Gpt.portfolio?.denominator === 5 &&
  sectionOf(t3View, "brand-openai_chatgpt").notes.includes("Left out of the total: question 2.") &&
  timeoutAt3.payload.evidenceIndex.filter((e) => e.ordinal === 2 && e.engine === "openai_chatgpt").length === 3 &&
  timeoutAt3.payload.methodNotes.some((n) => n.startsWith("A measurement that a review ended")),
  JSON.stringify(t3Gpt.portfolio));
const timeoutAt5 = ended([...five([true, true, true, true]), { status: "timed_out" }], "excluded_and_completed");
const unflagged = ended([{ status: "completed", mentioned: true }, { status: "completed", mentioned: true }, { status: "timed_out" }]);
const fullPlanReviewed = ended(five([true, true, true, true, true]), "excluded_and_completed");
const finishedNormally = ended(five([true, true, true, true, true]), null);
const stateOf2 = (b: ReturnType<typeof buildPilotReport>) => b.payload.questions[1].measurements.find((m) => m.engine === "openai_chatgpt")!.state;
check("X20d a timeout at run 5 (every planned run made, 4 completed) is ended after review too; without the recorded resolution, fewer completed answers than planned still mark it (defence in depth); a full plan a review ended says so without \"fewer\"",
  stateOf2(timeoutAt5) === "ended_after_review" && integrityOf(timeoutAt5).reasons.includes("Question 2: the ChatGPT measurement ended after review with 4 of 5 planned answers completed.") &&
  stateOf2(unflagged) === "ended_after_review" && integrityOf(unflagged).status === "needs_review" &&
  stateOf2(fullPlanReviewed) === "ended_after_review" &&
  presentPilotReport(fullPlanReviewed.payload).questions[1].lines.includes("Ended after review with 5 of 5 planned answers completed; it is not counted in the total."));
check("X20e control: a measurement that finished its plan with no review reads \"Finished\", passes, and counts in its total",
  stateOf2(finishedNormally) === "measured" && integrityOf(finishedNormally).status === "integrity_passed" &&
  finishedNormally.payload.brand.find((s) => s.engine === "openai_chatgpt")!.portfolio?.includedOrdinals.join() === "1,2");

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

/** D-061 — the real reader: both engines' slots, and each protocol's recorded setting (a non-string one is not a setting). */
async function readerReadsSettingVersion(): Promise<boolean> {
  const PQ1 = uid(8101);
  const PQ2 = uid(8102);
  const PPLX = uid(9101);
  const GPT = uid(9102);
  const GPT_ODD = uid(9103);
  const QV = uid(7101);
  const text = "Which analytics tools suit a team of 1?";
  const protocol = (id: string, provider: string, modelConfig: unknown) => ({
    id, project_id: PROJECT, buyer_question_version_id: QV, provider, surface: "answer", model_config: modelConfig,
    planned_baseline_runs: 5, methodology_version: 1, analyzer_version: 1, entity_resolution_version: 1,
  });
  const client = stubClient(
    {
      pilots: [{ id: PILOT, project_id: PROJECT, company_name: COMPANY, website_url: `https://${DOMAIN}`, normalized_domain: DOMAIN, starts_on: "2026-11-18", ends_on: "2027-02-16", status: "active" }],
      projects: [{ id: PROJECT, company_name: COMPANY, domain: DOMAIN }],
      pilot_questions: [
        { id: PQ1, pilot_id: PILOT, project_id: PROJECT, ordinal: 1, question_provenance: "customer_supplied", customer_approved_on: "2026-11-18", retired_at: null },
        { id: PQ2, pilot_id: PILOT, project_id: PROJECT, ordinal: 2, question_provenance: "customer_supplied", customer_approved_on: "2026-11-18", retired_at: null },
      ],
      pilot_question_protocols: [
        { pilot_question_id: PQ1, project_id: PROJECT, engine: "perplexity_sonar", phase: "baseline", protocol_id: PPLX },
        { pilot_question_id: PQ1, project_id: PROJECT, engine: "openai_chatgpt", phase: "baseline", protocol_id: GPT },
        { pilot_question_id: PQ2, project_id: PROJECT, engine: "openai_chatgpt", phase: "baseline", protocol_id: GPT_ODD },
      ],
      protocols: [
        protocol(PPLX, "perplexity_sonar", { model: "sonar" }),
        protocol(GPT, "openai_chatgpt", { model: GPT_MODEL, setting_version: GPT_SETTING }),
        protocol(GPT_ODD, "openai_chatgpt", { model: GPT_MODEL, setting_version: 4 }),
      ],
      // Review of phase B (APP-2): the job's review resolution reaches the builder.
      protocol_execution_jobs: [
        { protocol_id: PPLX, status: "succeeded", review_resolution: null },
        { protocol_id: GPT, status: "succeeded", review_resolution: "excluded_and_completed" },
        { protocol_id: GPT_ODD, status: "queued", review_resolution: null },
      ],
      buyer_question_versions: [{ id: QV, prompt_text: text, prompt_hash: sha(text), version_number: 1, intent_type: "shortlist", provenance: "operator", approved_at: "2026-11-18T00:00:00Z" }],
    },
    []
  );
  const read = await readPilotReportInput(client as never, PILOT);
  const slot = (ordinal: number, engine: string) => read?.questions.find((q) => q.ordinal === ordinal)?.slots.find((s) => s.engine === engine);
  return (
    read?.questions[0].slots.length === 2 &&
    slot(1, "openai_chatgpt")?.settingVersion === GPT_SETTING &&
    slot(1, "openai_chatgpt")?.evidence.protocol.provider === "openai_chatgpt" &&
    slot(1, "openai_chatgpt")?.evidence.protocol.model === GPT_MODEL &&
    slot(1, "perplexity_sonar")?.settingVersion === null &&
    slot(2, "openai_chatgpt")?.settingVersion === null &&
    slot(1, "openai_chatgpt")?.jobStatus === "succeeded" &&
    slot(1, "openai_chatgpt")?.reviewResolution === "excluded_and_completed" &&
    slot(1, "perplexity_sonar")?.reviewResolution === null &&
    slot(2, "openai_chatgpt")?.reviewResolution === null
  );
}

/* ---------------------------------------------------------------- W */

const SECTION_19 = ["you lost the sale", "cannot find you", "overall ai visibility", "caused the lift", "we control what", "we guarantee", "no competitor offers"];
const copyTexts = Object.values(copy).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "object" ? Object.values(v as Record<string, string>) : []));
// D-061 — the two-engine renders (finished, still collecting, queued, stopped) are scanned too, and (review of
// phase B) a question retired while one engine had finished, and a measurement a review ended.
const twoEnginePages = [tPage, qPage, renderPage(stoppedGpt.payload), renderPage(tp, { preview: true }), rmPage, renderPage(timeoutAt3.payload), renderPage(allRetired.payload)];
const twoEngineMds = [tMd, qMd, renderPilotReportMarkdown(stoppedGpt.payload), renderPilotReportMarkdown(mixedSetting.payload),
  renderPilotReportMarkdown(retiredMixed.payload), renderPilotReportMarkdown(timeoutAt3.payload), renderPilotReportMarkdown(allRetired.payload)];
const pages = [renderPage(p), renderPage(withRetired.payload), renderPage(unfinished.payload), renderPage(p, { preview: true }), renderReplacedNotice(), ...twoEnginePages];
// The two sentences METHODOLOGY §4 and §7 require verbatim are left out of the phrase scan ("not guaranteed" is a required negation).
// D-062 — and the Outcome Card's footer (D-006), which says "caused" only to deny it.
const MANDATED = [PERPLEXITY_SURFACE_LIMITATION, DEPENDENCE_LIMITATION, NON_CAUSALITY_FOOTER].map((t) => t.toLowerCase());
const allText = MANDATED.reduce(
  (t, m) => t.split(m).join(" "),
  [md, renderPilotReportMarkdown(withRetired.payload), renderPilotReportMarkdown(unfinished.payload), ...twoEngineMds, ...pages, ...copyTexts, ...PILOT_LIMITATIONS, ...p.methodNotes, PILOT_CAUSAL_LIMIT, readFileSync("components/report/pilot-report-view.tsx", "utf8")]
    .join("\n")
    .toLowerCase()
);
check("W1 no forbidden claim phrase in the Markdown, the copy, the method notes or the view",
  FORBIDDEN_W1_PHRASES.every((ph) => !allText.includes(ph)) && SECTION_19.every((ph) => !allText.includes(ph)),
  [...FORBIDDEN_W1_PHRASES, ...SECTION_19].filter((ph) => allText.includes(ph)).join(","));
check("W2 no score, overall figure or combined-engine wording", !/\bscore\b|\boverall\b|combined across engines|all engines combined/.test(allText.replace(/never a score|it is not a score/g, "")));
const STORED_CODES = ["customer_supplied", "founder_supplied", "observed_consistently_in_sample", "not_observed_consistently_in_sample", "mixed_in_sample", "insufficient_evidence", "perplexity_sonar", "openai_chatgpt", "integrity_passed", "needs_review", "abandoned_exhausted", "not_finished", "review_platform", "ended_after_review", "excluded_and_completed"];
const STORED_CODES_ALL = [
  ...STORED_CODES, "live_perplexity", "simulated", "in_progress", "excluded_no_result", "timed_out", "perplexity-sonar",
  // D-062 — the four statuses, the ten member states, the eight note kinds, the six underscored action types and the
  // comparison's reason prefixes. Plain-word codes (other, the group states) are covered in test:pilot-retest (W4).
  "increase_observed", "decrease_observed", "no_clear_change", ...RETEST_MEMBER_STATES, ...RETEST_NOTE_KINDS,
  ...ACTION_TYPES.filter((t) => t.includes("_")), ...Object.keys(OUTCOME_REASON_WORDS),
];
const renderedAll = [md, renderPilotReportMarkdown(withRetired.payload), ...twoEngineMds, ...pages].join("\n");
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
check("T8d the share confirmation says the founder has read this revision, and (D-060) that the earlier shared link stops working",
  /I have read this revision in full/.test(copy.SHARE_PASSED_PROMPT) && /I have read this revision in full/.test(copy.SHARE_NEEDS_REVIEW_PROMPT) &&
  [copy.SHARE_PASSED_PROMPT, copy.SHARE_NEEDS_REVIEW_PROMPT].every((t) => t.includes("the link to any earlier revision of this report stops working")));
// D-060 (D-059 item 9) — the old "a newer revision has been shared" banner is gone: a current page is always the newest shared one.
const customerBranches = customerPage.slice(customerPage.indexOf("readSharedPilotReport("));
check("T8e an earlier link (replaced) renders only the notice, which takes no props, before any payload is looked at; nothing else renders a newer-revision banner",
  customerBranches.indexOf('shared.state === "not_found"') > 0 &&
  customerBranches.indexOf('shared.state === "not_found"') < customerBranches.indexOf('shared.state === "replaced"') &&
  /if \(shared\.state === "replaced"\) return <PilotReportReplacedNotice \/>;/.test(customerBranches) &&
  customerBranches.indexOf('shared.state === "replaced"') < customerBranches.indexOf("isPilotReportPayload(shared.payload)") &&
  !("NEWER_REVISION_WORDS" in copy) && !/newerSharedRevision/.test(readFileSync("components/report/pilot-report-view.tsx", "utf8") + customerPage + previewPage));
const notice = renderReplacedNotice();
check("T8f the notice says the link was replaced and shows nothing of a report: no revision, date or link but the home page",
  notice.includes(copy.REPLACED_LINK_WORDS) && notice.includes(copy.PRIVATE_REPORT_WORDS) && !/Revision|\d/.test(notice) &&
  (renderToStaticMarkup(createElement(PilotReportReplacedNotice, {})).match(/href="/g) ?? []).length === 1);
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
check("T9 the console shows a link only once a revision is shared, and (D-060) only while it still opens",
  /publicToken: r\.shared_at && r\.public_token && !replaced \?/.test(proc) &&
  /\) : r\.replaced \? \(/.test(admin) && admin.includes("{REPLACED_REVISION_WORDS}"));

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

/*
 * D-060 — the customer's page itself, called for real (T13 to T16). The
 * database's answer is faked at the fetch layer, the configuration is a
 * dummy, non-secret value, and any other request is refused, so nothing
 * leaves the process. Both are restored afterwards.
 */
async function customerPageChecks(): Promise<void> {
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const networkOff = (globalThis as unknown as { fetch: unknown }).fetch;
  let answer: unknown = [];
  let reads = 0;
  let strays = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-not-a-key";
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown }).url);
    if (!url.startsWith("http://127.0.0.1:9/rest/v1/rpc/read_shared_pilot_report")) {
      strays += 1;
      throw new Error("network disabled");
    }
    reads += 1;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { notFound } = require("next/navigation") as { notFound: () => never };
    let NOT_FOUND = "";
    try {
      notFound();
    } catch (error) {
      NOT_FOUND = String((error as { digest?: unknown }).digest ?? "");
    }
    const Page = (require("@/app/pilot-report/[secureToken]/page") as {
      default: (props: { params: Promise<{ secureToken: string }> }) => Promise<unknown>;
    }).default;
    /** One request to the page, answered by `rows`; reads must run one at a time. */
    const open = async (rows: unknown, token = "c".repeat(64)) => {
      answer = rows;
      reads = 0;
      try {
        const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ secureToken: token }) }));
        return { html, reads, thrown: null as string | null };
      } catch (error) {
        return { html: "", reads, thrown: String((error as { digest?: unknown }).digest ?? error) };
      }
    };
    const STORED = JSON.parse(JSON.stringify(p)) as PilotReportPayload;
    const SHARED_AT = "2026-11-21T10:00:00Z";
    const rowWith = (extra: Record<string, unknown>) => [{ revision: 5, generated_at: p.generatedAt, shared_at: SHARED_AT, ...extra }];

    const current = await open(rowWith({ payload: STORED, newer_shared_revision: false }));
    check("T13 the customer's page, called for real, renders the newest shared revision with the customer's own view, from its payload, after one read",
      current.thrown === null && current.reads === 1 && current.html.includes(COMPANY) &&
      current.html === renderToStaticMarkup(createElement(PilotReportView, { payload: STORED, revision: 5, sharedAt: SHARED_AT })),
      current.thrown ?? "");

    const NOTICE = renderToStaticMarkup(createElement(PilotReportReplacedNotice, {}));
    const replacedWithheld = await open(rowWith({ payload: null, newer_shared_revision: true }));
    const replacedReturned = await open(rowWith({ payload: STORED, newer_shared_revision: true }));
    check("T14 an earlier link renders exactly the replaced notice and nothing of the report, whether its payload is withheld or (with 20261109150000's read) still returned",
      [replacedWithheld, replacedReturned].every((r) => r.thrown === null && r.reads === 1 && r.html === NOTICE &&
        r.html.includes(copy.REPLACED_LINK_WORDS) && !r.html.includes(COMPANY) && !r.html.includes(DOMAIN)),
      [replacedWithheld, replacedReturned].map((r) => r.thrown ?? "rendered").join(","));

    const refused = [];
    for (const rows of [
      [],
      null,
      rowWith({ payload: STORED }),
      rowWith({ payload: STORED, newer_shared_revision: null }),
      rowWith({ payload: null, newer_shared_revision: false }),
      rowWith({ payload: { pilotId: PILOT }, newer_shared_revision: false }),
    ]) {
      refused.push(await open(rows));
    }
    check("T15 no row, a row without the flag, a current row without a payload, and a payload that fails the type guard are each a 404, after one read",
      NOT_FOUND.includes("404") && refused.every((r) => r.thrown === NOT_FOUND && r.reads === 1),
      `${NOT_FOUND}: ${refused.map((r) => `${r.thrown}/${r.reads}`).join(",")}`);

    const malformed = [];
    for (const token of ["not-a-token", "C".repeat(64), "c".repeat(63), `${"c".repeat(64)}0`]) {
      malformed.push(await open(rowWith({ payload: STORED, newer_shared_revision: false }), token));
    }
    check("T16 a malformed token is a 404 before any read, and the page made no other request",
      malformed.every((r) => r.thrown === NOT_FOUND && r.reads === 0) && strays === 0,
      `${malformed.map((r) => `${r.thrown}/${r.reads}`).join(",")} strays ${strays}`);
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = networkOff;
    for (const [name, value] of [["NEXT_PUBLIC_SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

readerRefusesForeignEvidence()
  .then((ok) => {
    check("I6a the real reader refuses evidence from another project: the build answers EVIDENCE_OUTSIDE_PILOT and nothing is saved", ok);
  })
  .catch((error) => check("I6a the real reader refuses evidence from another project", false, String(error)))
  .then(() => readerReadsSettingVersion())
  .then(
    (ok) => check("X18 the real reader reads both engines' slots, each protocol's recorded setting (a protocol with none, or a non-string one, gives none) and each job's review resolution (review of phase B)", ok),
    (error) => check("X18 the real reader reads each protocol's recorded setting", false, String(error))
  )
  .then(() => customerPageChecks())
  .catch((error) => check("T13 the customer's page checks ran", false, String(error)))
  .finally(() => {
    console.log(`\n${total - failures}/${total} checks passed.`);
    if (failures > 0) {
      console.error("Pilot report FAILED.");
      process.exit(1);
    }
    console.log("Pilot report PASSED.");
  });
