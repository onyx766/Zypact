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
 *   W  wording: no forbidden claim, no overall score, no stored code, the
 *      D-053 limitation;
 *   T  the client page: token shape first, the shared-only read, noindex;
 *      the routes are founder-guarded;
 *   M  the migration's contract: privileges, RLS, the append-only guard,
 *      the save and share refusals, nothing redefined.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import {
  buildPilotReport,
  ENGINE_NOT_MEASURED_NOTE,
  PILOT_LIMITATIONS,
  questionLabel,
  type PilotReportInput,
  type PilotReportQuestionInput,
} from "@/lib/reports/build-pilot-report";
import { evaluatePilotReportIntegrity, type PilotQuestionSignals } from "@/lib/reports/pilot-report-integrity";
import * as copy from "@/lib/reports/pilot-report-copy";
import { isPilotReportPayload } from "@/lib/reports/pilot-report-types";
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
  status: "completed" | "failed" | "excluded";
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

function question(ordinal: number, runs: RunSpec[], opts: { jobStatus?: string | null; retiredAt?: string | null; projectId?: string; company?: string } = {}): PilotReportQuestionInput {
  const protocolId = uid(9000 + ordinal);
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
        evidence: evidence(protocolId, `Which analytics tools suit a team of ${ordinal}?`, runs, opts.projectId, opts.company),
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
      signals: ordinal === undefined || ordinal === q.ordinal ? { ...GOOD, ...over } : GOOD,
    }))
  );

/* ---------------------------------------------------------------- P */

console.log("test-pilot-report");
const PURE = [
  "lib/reports/build-pilot-report.ts",
  "lib/reports/pilot-report-integrity.ts",
  "lib/reports/render-pilot-report-markdown.ts",
  "lib/reports/pilot-report-types.ts",
  "lib/reports/pilot-report-copy.ts",
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
  row2.attempted === 6 && row2.failed === 1 && row2.denominator === 5 && row2.numerator === 1, JSON.stringify(row2));
const row3 = perplexity.rows.find((r) => r.ordinal === 3)!;
check("B4 an answer without a readable result and an excluded attempt are counted as such, not as 'not named'",
  row3.denominator === 2 && row3.excluded === 2 && row3.attempted === 4, JSON.stringify(row3));
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
  md.includes(`ChatGPT: ${ENGINE_NOT_MEASURED_NOTE}`) && !/ChatGPT[^\n]*\b0 of\b/.test(md) && md.includes("**ChatGPT**: not measured for this question."));
check("E4 the client view renders engines from the payload and has no hard-coded zero for an engine",
  /payload\.engines/.test(readFileSync("components/report/pilot-report-view.tsx", "utf8")) &&
  !/ChatGPT[^\n]*0%/.test(readFileSync("components/report/pilot-report-view.tsx", "utf8")));

/* ---------------------------------------------------------------- I */

const passed = evaluatePilotReportIntegrity({ markdown: md, structural: built.structural, questionSignals: signalsFor(built) });
check("I1 a pilot whose questions all finished with good evidence passes with no reason",
  passed.status === "integrity_passed" && passed.reasons.length === 0, JSON.stringify(passed));

const unfinished = buildPilotReport(input([question(1, q1Runs), question(2, [], { jobStatus: "queued" })]));
const unfinishedI = evaluatePilotReportIntegrity({ markdown: renderPilotReportMarkdown(unfinished.payload), structural: unfinished.structural, questionSignals: signalsFor(unfinished) });
check("I2 a question not yet run makes the report need review, naming the question",
  unfinishedI.status === "needs_review" && unfinishedI.reasons.some((r) => r.startsWith("Question 2:")), JSON.stringify(unfinishedI.reasons));
check("I3 an unfinished question is left out of the total line and named",
  unfinished.payload.brand[0].portfolio!.leftOutOrdinals.includes(2) && !unfinished.payload.brand[0].portfolio!.includedOrdinals.includes(2));

const withRetired = buildPilotReport(input([
  question(1, q1Runs),
  question(2, [{ status: "failed" }, { status: "failed" }], { jobStatus: "abandoned_exhausted", retiredAt: "2026-11-19T09:00:00Z" }),
]));
const retiredI = evaluatePilotReportIntegrity({ markdown: renderPilotReportMarkdown(withRetired.payload), structural: withRetired.structural, questionSignals: signalsFor(withRetired, { hasPaidCallReservation: false, hasCompleteEvidenceHashes: false }, 2) });
const retiredRow = withRetired.payload.brand[0].rows.find((r) => r.ordinal === 2)!;
check("I4 a retired question does not hold the report", retiredI.status === "integrity_passed", JSON.stringify(retiredI));
check("I5 a retired question is still listed, its failed attempts counted in its own row, and named as left out",
  withRetired.payload.questions[1].retired && retiredRow.retired && retiredRow.attempted === 2 && retiredRow.failed === 2 &&
  withRetired.payload.brand[0].portfolio!.leftOutOrdinals.includes(2) && withRetired.manifest.attempts.length === 7 &&
  renderPilotReportMarkdown(withRetired.payload).includes(copy.RETIRED_WORDS));

const foreign = buildPilotReport(input([question(1, q1Runs, { projectId: "33333333-3333-4333-8333-333333333333" })]));
const foreignI = evaluatePilotReportIntegrity({ markdown: "x", structural: foreign.structural, questionSignals: signalsFor(foreign) });
check("I6 evidence from another project blocks the report", foreignI.status === "blocked", JSON.stringify(foreignI));

const badSignals = evaluatePilotReportIntegrity({ markdown: md, structural: built.structural, questionSignals: signalsFor(built, { hasCompleteEvidenceHashes: false }, 3) });
check("I7 the worst per-question result decides, and the reason names the question and engine",
  badSignals.status === "needs_review" && badSignals.reasons.some((r) => r.startsWith("Question 3 (Perplexity):")), JSON.stringify(badSignals.reasons));

const legacy = evaluatePilotReportIntegrity({ markdown: `${md}\n3 won · 1 partial · 1 lost`, structural: [], questionSignals: signalsFor(built) });
check("I8 report text exposing legacy verdicts is blocked", legacy.status === "blocked");

const otherBrand = buildPilotReport(input([question(1, q1Runs, { company: "Someone Else" })]));
check("I9 a measured brand that differs from the pilot's company needs review",
  otherBrand.structural.some((s) => s.status === "needs_review" && /brand looked for/.test(s.reason)));
const empty = buildPilotReport(input([]));
check("I10 a pilot with no question needs review", empty.structural.some((s) => s.status === "needs_review"));

/* ---------------------------------------------------------------- W */

const SECTION_19 = ["you lost the sale", "cannot find you", "overall ai visibility", "caused the lift", "we control what", "we guarantee", "no competitor offers"];
const copyTexts = Object.values(copy).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "object" ? Object.values(v as Record<string, string>) : []));
const allText = [md, renderPilotReportMarkdown(withRetired.payload), renderPilotReportMarkdown(unfinished.payload), ...copyTexts, ...PILOT_LIMITATIONS, ...p.methodNotes, readFileSync("components/report/pilot-report-view.tsx", "utf8")].join("\n").toLowerCase();
check("W1 no forbidden claim phrase in the Markdown, the copy, the method notes or the view",
  FORBIDDEN_W1_PHRASES.every((ph) => !allText.includes(ph)) && SECTION_19.every((ph) => !allText.includes(ph)),
  [...FORBIDDEN_W1_PHRASES, ...SECTION_19].filter((ph) => allText.includes(ph)).join(","));
check("W2 no score, overall figure or combined-engine wording", !/\bscore\b|\boverall\b|combined across engines|all engines combined/.test(allText.replace(/never a score|it is not a score/g, "")));
const STORED_CODES = ["customer_supplied", "founder_supplied", "observed_consistently_in_sample", "not_observed_consistently_in_sample", "mixed_in_sample", "insufficient_evidence", "perplexity_sonar", "openai_chatgpt", "integrity_passed", "needs_review", "abandoned_exhausted", "not_finished", "review_platform"];
check("W3 no stored code reaches the Markdown", STORED_CODES.every((c) => !md.includes(c) && !renderPilotReportMarkdown(withRetired.payload).includes(c)),
  STORED_CODES.filter((c) => md.includes(c)).join(","));
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
check("T8 the console offers Share only for the newest revision that is not blocked",
  /latest && r\.id === latest\.id && r\.integrityStatus !== "blocked"/.test(admin) && admin.includes("SharePilotReportButton"));
check("T9 the console shows a link only once a revision is shared",
  /publicToken: r\.shared_at && r\.public_token/.test(proc));

/* ---------------------------------------------------------------- M */

const MIG = readFileSync("supabase/migrations/20261119120000_pilot_report_artifacts.sql", "utf8");
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

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
check("R1 test:pilot-report is registered", pkg.scripts["test:pilot-report"] === "tsx scripts/test-pilot-report.ts");

console.log(`\n${total - failures}/${total} checks passed.`);
if (failures > 0) {
  console.error("Pilot report FAILED.");
  process.exit(1);
}
console.log("Pilot report PASSED.");
