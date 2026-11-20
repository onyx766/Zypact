#!/usr/bin/env tsx
/**
 * The pilot report's clarity changes, offline (no database, network,
 * provider or model):
 *
 *   A  competitor names (pilot-competitor-names/2, competitor-aliases/1):
 *      listed spellings are one row, every original spelling is kept, an
 *      answer counts a brand once, nothing is grouped by similarity, a name
 *      joining several brands is split only when every part is known
 *      ("Procter & Gamble" stays whole), the list has no spelling under two
 *      companies;
 *   D  the website table: each domain per question, cited and returned-only
 *      apart, the denominator is the answers with a usable source list, the
 *      category only from the fixed list (unknown stays Unclassified), at
 *      most three example pages, cited ones first;
 *   S  the summary (pilot-summary/1): each question's own figures, the head
 *      of each engine's competitor table, the most cited websites, and the
 *      four rules for a closer look, each engine apart; it adds no figure;
 *   L  layout and dates: summary first, how each engine was measured below
 *      the results, the pilot period and each engine's answer dates apart;
 *   P  the practice label: on the page and in the Markdown when the pilot is
 *      an internal practice run, never otherwise; an unreadable purpose holds
 *      the report for review and adds no label;
 *   O  a revision built before these changes renders exactly as before;
 *   M  the migration 20261109200000 and its route, statically.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

(require("node:module") as { _extensions: Record<string, unknown> })._extensions[".css"] = () => undefined;

import { parseMigrationName } from "./lib/migration-names";
import {
  buildCompetitors,
  buildPilotReport,
  MAX_EXAMPLE_URLS,
  type PilotReportInput,
  type PilotReportQuestionInput,
} from "@/lib/reports/build-pilot-report";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import { COMPETITOR_ALIASES, competitorKey, splitJoinedName } from "@/lib/reports/competitor-aliases";
import * as copy from "@/lib/reports/pilot-report-copy";
import { presentationStrings, presentPilotReport } from "@/lib/reports/pilot-report-presentation";
import { isPilotReportPayload, type PilotReportPayload } from "@/lib/reports/pilot-report-types";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";
import type { BuildProtocolReportInput, EvidenceAttemptInput, EvidenceResultInput } from "@/lib/reports/protocol-report-types";
import { DEPENDENCE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION } from "@/lib/reports/surface-limitations";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";

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
const NOW = new Date("2026-11-19T12:00:00.000Z");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let seq = 0;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A Sonar body: each URL is returned; the ones in `cited` get a numbered reference in the text. */
function sonarBody(urls: string[], cited: number[]): string {
  const refs = cited.map((i) => `[${i + 1}]`).join(" ");
  return JSON.stringify({
    id: "resp",
    model: "sonar",
    choices: [{ message: { role: "assistant", content: `Options include several tools ${refs}.` } }],
    citations: urls,
    search_results: urls.map((u, i) => ({ title: `Source ${i + 1}`, url: u })),
  });
}

interface Run {
  mentioned: boolean;
  competitors?: string[];
  urls?: string[];
  cited?: number[];
  status?: "completed" | "failed";
}

/**
 * Every completed run fills its own planned slot; a failed run is an earlier
 * attempt at slot 1 that a later attempt completed, so the plan is the
 * completed runs and a finished job reads "Finished".
 */
function evidence(protocolId: string, text: string, runs: Run[]): BuildProtocolReportInput {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  let slot = 0;
  runs.forEach((r) => {
    const id = uid(++seq);
    const probeRunId = uid(++seq);
    const status = r.status ?? "completed";
    const baselineOrdinal = status === "completed" ? ++slot : 1;
    attempts.push({ id, attemptKind: "baseline", status, baselineOrdinal, probeRunId, retryOfAttemptId: null, terminationReason: status === "failed" ? "provider_error" : null });
    if (status === "completed") {
      const body = sonarBody(r.urls ?? ["https://www.g2.com/categories/x"], r.cited ?? [0]);
      results.push({
        probeRunId,
        clientMentioned: r.mentioned,
        clientPosition: null,
        competitorsMentioned: r.competitors ?? [],
        sourcesCited: [],
        answerSummary: "summary",
        rawResponseSha256: sha(body),
        rawResponse: body,
        providerModel: "sonar",
        providerLatencyMs: 1000,
      });
    }
  });
  return {
    snapshotRequestId: protocolId,
    projectId: PROJECT,
    subject: { companyName: COMPANY, websiteUrl: DOMAIN, normalizedDomain: DOMAIN },
    question: { text, hash: sha(text), versionNumber: 1, intentType: "shortlist", provenance: "operator", approvedAt: "2026-11-18T00:00:00Z" },
    protocol: {
      id: protocolId,
      provider: "perplexity_sonar",
      surface: "answer",
      model: "sonar",
      plannedBaselineRuns: runs.filter((r) => (r.status ?? "completed") === "completed").length,
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

function question(ordinal: number, runs: Run[], opts: { jobStatus?: string; execution?: { firstOn: string; lastOn: string } } = {}): PilotReportQuestionInput {
  const protocolId = uid(9000 + ordinal);
  return {
    pilotQuestionId: uid(8000 + ordinal),
    ordinal,
    provenance: "customer_supplied",
    customerApprovedOn: "2026-11-18",
    retiredAt: null,
    slots: [
      {
        engine: "perplexity_sonar",
        protocolId,
        jobStatus: opts.jobStatus ?? "succeeded",
        evidence: evidence(protocolId, `Which analytics tools suit a team of ${ordinal}?`, runs),
        execution: opts.execution ?? { firstOn: "2026-11-18", lastOn: "2026-11-19" },
        answerModes: ["live_perplexity"],
      },
    ],
  };
}

function input(questions: PilotReportQuestionInput[], purpose?: "customer" | "internal_practice" | null): PilotReportInput {
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
      ...(purpose === undefined ? {} : { purpose }),
    },
    questions,
    now: NOW,
  };
}

(globalThis as unknown as { React: unknown }).React = require("react");
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
const { PilotReportView } = require("@/components/report/pilot-report-view") as { PilotReportView: unknown };
const textOf = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const renderPage = (payload: PilotReportPayload) =>
  textOf(renderToStaticMarkup(createElement(PilotReportView, { payload, revision: 2, sharedAt: "2026-11-20T10:00:00Z", preview: false })));

/* ---------------------------------------------------------------- A */

console.log("test-pilot-report-clarity");
console.log("[A] competitor names");

const G2 = "https://www.g2.com/categories/x";
const REDDIT = "https://www.reddit.com/r/analytics/1";
const BLOG = "https://blog.unknown-site.test/post";
const BLOG_OTHER = "https://blog.unknown-site.test/older-post";
const OWN = "https://acme.test/pricing";

const q1Runs: Run[] = [
  { mentioned: false, competitors: ["OtterlyAI", "Profound"], urls: [G2, REDDIT, BLOG_OTHER], cited: [0] },
  { mentioned: false, competitors: ["Otterly AI", "otterlyai", "Profound and Peec AI"], urls: [BLOG], cited: [0] },
  { mentioned: false, competitors: ["Otterly.ai", "Peec AI"], urls: [G2, BLOG], cited: [0, 1] },
  { mentioned: false, competitors: ["Procter & Gamble", "Semrush, Ahrefs"], urls: [G2], cited: [0] },
  { mentioned: false, competitors: [], status: "failed" },
];
const q2Runs: Run[] = [
  { mentioned: true, competitors: ["Profound"], urls: [OWN, G2], cited: [0] },
  { mentioned: true, competitors: [], urls: [OWN], cited: [0] },
  { mentioned: true, competitors: ["Otterly"], urls: [G2], cited: [] },
  { mentioned: true, competitors: [], urls: [G2], cited: [0] },
];
const built = buildPilotReport(input([question(1, q1Runs), question(2, q2Runs)]));
const p = built.payload;
const comp = p.competitors[0];
const row = (name: string) => comp.rows.find((r) => r.name === name);
const otterly = row("Otterly.AI");

check("A1 the listed spellings OtterlyAI, Otterly AI, otterlyai and Otterly.ai are one row, under the list's name",
  !!otterly && !comp.rows.some((r) => /otterly ?ai$/i.test(r.name) && r.name !== "Otterly.AI"), JSON.stringify(comp.rows.map((r) => r.name)));
check("A2 an answer that used two listed spellings counts the company once (3 answers to question 1, not 4)",
  otterly?.appearances.find((a) => a.ordinal === 1)?.runs === 3, JSON.stringify(otterly?.appearances));
check("A3 every original spelling is kept beside the name, exactly as read",
  JSON.stringify(otterly?.alsoWrittenAs) === JSON.stringify(["Otterly AI", "OtterlyAI", "otterlyai", "Otterly.ai"].sort((a, b) => a.localeCompare(b))),
  JSON.stringify(otterly?.alsoWrittenAs));
check("A4 nothing is grouped by similarity: \"Otterly\" (not on the list) stays its own row",
  !!row("Otterly") && row("Otterly")!.appearances[0].ordinal === 2);
const profound = row("Profound");
const peec = row("Peec AI");
check("A5 \"Profound and Peec AI\" counts as each brand, because both are named on their own; the joined name is kept on each row",
  !!profound && !!peec && !row("Profound and Peec AI") &&
  profound.appearances.find((a) => a.ordinal === 1)?.runs === 2 && peec.appearances.find((a) => a.ordinal === 1)?.runs === 2 &&
  JSON.stringify(profound.namedWithOthersAs) === JSON.stringify(["Profound and Peec AI"]) &&
  JSON.stringify(peec.namedWithOthersAs) === JSON.stringify(["Profound and Peec AI"]),
  JSON.stringify(comp.rows));
check("A6 \"Procter & Gamble\" (no part known) stays whole, and so does \"Semrush, Ahrefs\" (neither named alone)",
  !!row("Procter & Gamble") && !!row("Semrush, Ahrefs") && !row("Procter") && !row("Semrush"));
check("A7 the splitter: \"AT&T\" has no spaced separator and is never split; an unknown part keeps a name whole; a listed part is enough",
  splitJoinedName("AT&T", new Set(["at", "t"])) === null &&
  splitJoinedName("Profound / Mystery Co", new Set(["profound"])) === null &&
  JSON.stringify(splitJoinedName("OtterlyAI and Profound", new Set(["profound"]))) === JSON.stringify(["OtterlyAI", "Profound"]));
check("A8 the section records its rule and the alias list version",
  comp.rule === "pilot-competitor-names/2" && comp.aliasListVersion === "competitor-aliases/1");
const owner = new Map<string, string>();
const clash = COMPETITOR_ALIASES.flatMap((e) =>
  [e.name, ...e.aliases].map(competitorKey).filter((k) => {
    const prev = owner.get(k);
    owner.set(k, e.name);
    return prev !== undefined && prev !== e.name;
  })
);
check("A9 no spelling is listed under two companies", clash.length === 0, clash.join());
check("A10 the per-question sections keep the analysis's own names, unchanged",
  p.questions[0].measurements[0].report.competitorsObserved.some((c) => c.name === "OtterlyAI"));
const empty = buildCompetitors("perplexity_sonar", []);
check("A11 no answer, no row", empty.rows.length === 0 && empty.rowsNotShown === 0);
const view = presentPilotReport(p);
const compSection = view.sections.find((s) => s.key === "competitors-perplexity_sonar")!;
check("A12 the table shows an \"Also written as\" column with the spellings and the joined names",
  compSection.table!.columns[3] === "Also written as" &&
  compSection.table!.rows.some((r) => r[0] === "Otterly.AI" && r[3].includes("OtterlyAI") && r[3].includes("Otterly AI")) &&
  compSection.table!.rows.some((r) => r[0] === "Peec AI" && r[3].includes("named with others as “Profound and Peec AI”")));

/* ---------------------------------------------------------------- D */

console.log("\n[D] websites");
const dom = p.domains![0];
const drow = (d: string) => dom.rows.find((r) => r.domain === d);
check("D1 g2.com: cited in 3 of question 1's 4 answers with a source list and 1 of question 2's; returned but not cited in 2 of question 2's (one answer had no references at all)",
  JSON.stringify(drow("g2.com")?.cells) === JSON.stringify([
    { ordinal: 1, citedInRuns: 3, retrievedOnlyInRuns: 0 },
    { ordinal: 2, citedInRuns: 1, retrievedOnlyInRuns: 2 },
  ]), JSON.stringify(drow("g2.com")?.cells));
check("D2 reddit.com was returned but never cited: counted apart, never as cited",
  JSON.stringify(drow("reddit.com")?.cells) === JSON.stringify([{ ordinal: 1, citedInRuns: 0, retrievedOnlyInRuns: 1 }]));
check("D3 categories come only from the fixed list: g2.com a review platform, reddit.com community, acme.test owned, an unknown blog unclassified",
  drow("g2.com")?.category === "review_platform" && drow("reddit.com")?.category === "community" &&
  drow("acme.test")?.category === "owned" && drow("blog.unknown-site.test")?.category === "unclassified");
check("D4 the denominator is each question's answers with a usable source list; the failed attempt is not one",
  JSON.stringify(dom.coverage) === JSON.stringify([
    { ordinal: 1, readableRuns: 4, runsWithSourceEvidence: 4 },
    { ordinal: 2, readableRuns: 4, runsWithSourceEvidence: 4 },
  ]), JSON.stringify(dom.coverage));
check(`D5 at most ${MAX_EXAMPLE_URLS} example pages per website, with the count of the rest`,
  dom.rows.every((r) => r.exampleUrls.length <= MAX_EXAMPLE_URLS && r.urlsNotShown >= 0) && drow("g2.com")!.exampleUrls[0] === G2);
const domSection = view.sections.find((s) => s.key === "domains-perplexity_sonar")!;
check("D6 the page's website table names the website, its type in words, the counts per question and its pages; unknown reads Unclassified",
  JSON.stringify(domSection.table!.columns) === JSON.stringify(["Website", "Type", "Cited in", "Returned but not cited", "Example pages"]) &&
  domSection.table!.rows.some((r) => r[0] === "g2.com" && r[1] === "Review platform" && r[2] === "Q1: 3 of 4; Q2: 1 of 4" && r[3] === "Q2: 2 of 4" && r[4].includes(G2)) &&
  domSection.table!.rows.some((r) => r[0] === "blog.unknown-site.test" && r[1] === "Unclassified") &&
  domSection.paragraphs[0] === copy.DOMAINS_INTRO);
check("D7 the source-type table is unchanged beside it", view.sections.some((s) => s.key === "sources-perplexity_sonar"));
check("D8 example pages list the cited ones first: a page only returned (seen in an earlier answer) comes after a cited page of the same website",
  JSON.stringify(drow("blog.unknown-site.test")?.exampleUrls) === JSON.stringify([BLOG, BLOG_OTHER]) &&
  JSON.stringify(drow("blog.unknown-site.test")?.cells) === JSON.stringify([{ ordinal: 1, citedInRuns: 2, retrievedOnlyInRuns: 1 }]),
  JSON.stringify(drow("blog.unknown-site.test")));

/* ---------------------------------------------------------------- S */

console.log("\n[S] summary");
const s = p.summary!;
const se = s.engines[0];
check("S1 the summary's competitors are the competitor table's first rows, with their answer totals",
  JSON.stringify(se.topCompetitors.map((c) => c.name)) === JSON.stringify(comp.rows.slice(0, 5).map((r) => r.name)) &&
  se.topCompetitors.every((c) => c.answers === row(c.name)!.appearances.reduce((n, a) => n + a.runs, 0)));
check("S2 the most cited websites, by answers citing them; a website only returned is never listed",
  se.topDomains[0]?.domain === "g2.com" && se.topDomains[0].answers === 4 && se.topDomains[0].questions === 2 &&
  !se.topDomains.some((d) => d.domain === "reddit.com"), JSON.stringify(se.topDomains));
const kinds = s.flags.map((f) => `${f.kind}:${f.ordinal}`);
check("S3 rule: question 1, brand named in none of 4 readable answers while 4 named other brands",
  s.flags.some((f) => f.kind === "brand_absent_competitors_named" && f.ordinal === 1 && f.readable === 4 && f.answersNamingOthers === 4), kinds.join());
check("S4 rule: question 1, no answer with a source list cited acme.test; question 2 cited it, so no point",
  kinds.includes("own_site_not_cited:1") && !kinds.includes("own_site_not_cited:2"), kinds.join());
check("S5 a finished question with readable answers and its own site cited raises no point", !kinds.some((k) => k.endsWith(":2")), kinds.join());
const unfinished = buildPilotReport(input([question(1, q1Runs.slice(0, 2), { jobStatus: "running" }), question(2, q2Runs.slice(0, 2))])).payload.summary!;
check("S6 rules: an unfinished measurement, and a finished one with fewer than 3 readable answers",
  unfinished.flags.some((f) => f.kind === "not_finished" && f.ordinal === 1 && f.state === "not_finished") &&
  unfinished.flags.some((f) => f.kind === "few_readable_answers" && f.ordinal === 2 && f.readable === 2 && f.floor === 3),
  JSON.stringify(unfinished.flags));
const sum = view.summary!;
check("S7 in words: each question's own result with its range, the dates, the competitors, the websites, the points",
  sum.heading === copy.SUMMARY_HEADING && sum.blocks[0].title === "Perplexity" &&
  sum.blocks[0].lines[0] === "Answers collected from 2026-11-18 to 2026-11-19." &&
  sum.blocks[0].lines.some((l) => l.startsWith(`Question 1 (Finished): ${COMPANY} named in 0 of 4 readable answers; likely range`)) &&
  sum.blocks[0].lines.some((l) => l.startsWith("Other brands named most often: ")) &&
  sum.blocks[0].lines.some((l) => l.startsWith("Websites cited most often: g2.com (Review platform; cited in 4 answers to 2 questions)")) &&
  sum.closerLook.includes(`Question 1 on Perplexity: ${COMPANY} was named in none of 4 readable answers, while 4 of them named other brands.`) &&
  sum.closerLook.includes("Question 1 on Perplexity: none of the 4 answers with a usable source list cited a page on acme.test."),
  JSON.stringify(sum));
const quiet = buildPilotReport(input([question(2, q2Runs)])).payload;
check("S8 no point met: the summary says so", presentPilotReport(quiet).summary!.closerLook[0] === copy.CLOSER_LOOK_NONE);
check("S9 the summary's question figures are the brand table's, never another figure",
  p.brand[0].rows.every((r) => sum.blocks[0].lines.some((l) => l.includes(`Question ${r.ordinal} (`) && l.includes(`${r.numerator} of ${r.denominator} readable answers`))));

/* ---------------------------------------------------------------- L */

console.log("\n[L] layout and dates");
const page = renderPage(p);
const md = renderPilotReportMarkdown(p);
check("L1 the summary comes first; how each engine was measured comes after the results and before the limits, on the page and in the Markdown",
  [page, md].every((t) => {
    const a = t.indexOf(copy.SUMMARY_HEADING);
    const b = t.indexOf(`Perplexity: was ${COMPANY} named?`);
    const c = t.indexOf(copy.MEASUREMENT_HEADING);
    const d = t.indexOf("Limits of this report");
    return a >= 0 && a < b && b < c && c < d;
  }));
check("L2 the chips say the pilot period and each engine's answer dates apart",
  view.chips[0] === "Pilot period: 2026-11-18 to 2027-02-16" &&
  view.chips.includes("Perplexity answers collected 2026-11-18 to 2026-11-19") &&
  page.includes("Pilot period: 2026-11-18 to 2027-02-16") && md.includes("- Perplexity answers collected 2026-11-18 to 2026-11-19"));
check("L3 the hero keeps the scope sentence only", view.heroCopy.length === 1 && view.heroCopy[0].startsWith("Every figure belongs to one question on one engine."));
check("L4 every summary and website string is in the integrity scan's page text",
  [sum.heading, sum.closerLookIntro, ...sum.closerLook, ...sum.blocks.flatMap((b) => b.lines), copy.DOMAINS_INTRO].every((t) => presentationStrings(view).includes(t)));
// The sentences METHODOLOGY requires verbatim are left out of the phrase scan, as in test:pilot-report (W1).
const MANDATED = [PERPLEXITY_SURFACE_LIMITATION, DEPENDENCE_LIMITATION].map((t) => t.toLowerCase());
const allText = MANDATED.reduce(
  (t, m) => t.split(m).join(" "),
  [page, md, ...(Object.values(copy).filter((v) => typeof v === "string") as string[])].join("\n").toLowerCase()
);
check("L5 no forbidden claim phrase, no score, no stored code in the new words",
  FORBIDDEN_W1_PHRASES.every((ph) => !allText.includes(ph)) && !/\bscore\b|\boverall\b/.test(allText.replace(/never a score|it is not a score/g, "")) &&
  ["brand_absent_competitors_named", "own_site_not_cited", "few_readable_answers", "internal_practice", "review_platform", "unclassified\b"].every((c) => !new RegExp(c).test(`${page}\n${md}`)),
  FORBIDDEN_W1_PHRASES.filter((ph) => allText.includes(ph)).join());
check("L6 the payload passes its type guard", isPilotReportPayload(p));

/* ---------------------------------------------------------------- P */

console.log("\n[P] the practice label");
const practice = buildPilotReport(input([question(2, q2Runs)], "internal_practice"));
const pPage = renderPage(practice.payload);
const pMd = renderPilotReportMarkdown(practice.payload);
check("P1 an internal practice run says so at the top, on the page and in the Markdown",
  practice.payload.purpose === "internal_practice" && pPage.indexOf(copy.PRACTICE_RUN_NOTICE) >= 0 &&
  pPage.indexOf(copy.PRACTICE_RUN_NOTICE) < pPage.indexOf(copy.SUMMARY_HEADING) && pMd.split("\n")[2] === `**${copy.PRACTICE_RUN_NOTICE}**`);
const customer = buildPilotReport(input([question(2, q2Runs)], "customer"));
check("P2 a customer pilot carries no practice label", customer.payload.purpose === "customer" &&
  !renderPage(customer.payload).includes(copy.PRACTICE_RUN_NOTICE) && !renderPilotReportMarkdown(customer.payload).includes(copy.PRACTICE_RUN_NOTICE));
const unknown = buildPilotReport(input([question(2, q2Runs)], null));
check("P3 an unreadable purpose holds the report for review and adds no label",
  unknown.payload.purpose === null && unknown.structural.some((r) => r.status === "needs_review" && r.reason.startsWith("The pilot's purpose")) &&
  !renderPage(unknown.payload).includes(copy.PRACTICE_RUN_NOTICE));
check("P4 a known purpose adds no review reason", !customer.structural.some((r) => r.reason.startsWith("The pilot's purpose")));
const reader = readFileSync("lib/reports/read-pilot-evidence.ts", "utf8");
check("P5 the reader passes the purpose it read, in its own query, unknown as null",
  /purpose,\n\s+\},\n\s+questions,/.test(reader) && reader.includes('.from("pilots").select("purpose")') && /if \(error \|\| !data\) return null;/.test(reader));

/* ---------------------------------------------------------------- O */

console.log("\n[O] revisions built before");
const old = JSON.parse(JSON.stringify(p)) as PilotReportPayload & Record<string, unknown>;
delete old.summary;
delete old.domains;
delete old.purpose;
for (const c of old.competitors) {
  c.rule = "pilot-competitor-names/1";
  delete c.aliasListVersion;
  for (const r of c.rows) {
    delete r.alsoWrittenAs;
    delete r.namedWithOthersAs;
  }
}
const ov = presentPilotReport(old);
const oPage = renderPage(old);
check("O1 an earlier revision keeps its layout: no summary, no website table, engines first, its own chips and hero",
  ov.layout === "classic" && ov.summary === null && !ov.sections.some((s) => s.key.startsWith("domains-")) &&
  ov.chips[0] === "Pilot 2026-11-18 to 2027-02-16" && ov.enginesHeading === "Engines" &&
  ov.heroCopy[0].startsWith("Perplexity: ") && oPage.indexOf("Engines") < oPage.indexOf(`Perplexity: was ${COMPANY} named?`));
check("O2 its competitor table keeps three columns",
  ov.sections.find((s) => s.key === "competitors-perplexity_sonar")!.table!.columns.length === 3);
check("O3 it carries no practice label", ov.practiceNotice === null && !oPage.includes(copy.PRACTICE_RUN_NOTICE));
check("O4 it still passes the type guard", isPilotReportPayload(old));

/* ---------------------------------------------------------------- M */

console.log("\n[M] migration 20261109200000 and its route");
const FILE = "20261109200000_pilot_purpose.sql";
const SQL = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const CODE = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const versions = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok).map((r) => (r.ok ? r.version : 0));
const parsed = parseMigrationName(FILE);
const version = parsed.ok ? parsed.version : 0;
check("M1 numbered inside D-058's window, directly after 20261109190000 and before 20261110120000",
  parsed.ok && version > 20261109190000 && version < 20261110120000 && versions.includes(20261109190000) && versions.includes(20261110120000) &&
  !versions.some((v) => v > 20261109190000 && v < version));
check("M2 the header names expected_prev, the lock, the deploy order and both recoveries",
  SQL.includes("expected_prev=20261109190000") && SQL.includes("ACCESS EXCLUSIVE") && SQL.includes("Before any pilot is set") && SQL.includes("Forward recovery"));
check("M3 two precondition blocks: 20261109190000 applied, nothing created here exists",
  (CODE.match(/do \$precondition\$/g) ?? []).length === 2 && CODE.includes("to_regclass('public.pilot_retests') is null") && CODE.includes("proname = 'set_pilot_purpose'"));
check("M4 the column: not null, default customer, two values only; who set it and when, both or neither",
  /add column purpose text not null default 'customer'/.test(CODE) && CODE.includes("check (purpose in ('customer', 'internal_practice'))") &&
  CODE.includes("check ((purpose_set_by is null) = (purpose_set_at is null))"));
const defined = [...CODE.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_.0-9]+)\s*\(/gi)].map((m) => m[1]);
check("M5 exactly one function is created, and no existing function is redefined",
  JSON.stringify(defined) === JSON.stringify(["public.set_pilot_purpose"]));
check("M6 the function is SECURITY DEFINER with a pinned search_path, locks the pilot row, and only service_role may execute it",
  /security definer/.test(CODE) && /set search_path = public, pg_temp/.test(CODE) && /for update;/.test(CODE) &&
  ["public", "anon", "authenticated"].every((r) => CODE.includes(`revoke all on function public.set_pilot_purpose(uuid, uuid, text) from ${r};`)) &&
  CODE.includes("grant execute on function public.set_pilot_purpose(uuid, uuid, text) to service_role;"));
check("M7 no grant on a table changes, no row of another table is written, nothing from the account stack is referenced",
  !/grant\s+[a-z, ]+\s+on\s+table/i.test(CODE) && !/insert into|delete from/i.test(CODE) && (CODE.match(/update public\./g) ?? []).length === 1 &&
  !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(CODE));
const route = readFileSync("app/api/internal/pilots/[pilotId]/purpose/route.ts", "utf8");
check("M8 the route is founder-guarded, checks the id and the value, and fails closed without the migration",
  route.indexOf("requireFounderForRoute") < route.indexOf("setPilotPurpose") && route.includes("UUID_PATTERN.test(pilotId)") &&
  route.includes('new Set(["customer", "internal_practice"])') && route.includes("status: 503"));
const preflight = readFileSync("scripts/sql/prod-preflight.sql", "utf8");
check("M9 the preflight lists 20261109200000 as not yet applied, in both lists, and counts set_pilot_purpose as pending",
  (preflight.match(/'20261109200000'/g) ?? []).length === 2 && preflight.includes("('set_pilot_purpose')"));

console.log(`\n${total - failures}/${total} checks passed.`);
if (failures > 0) {
  console.error("Pilot report clarity FAILED.");
  process.exit(1);
}
