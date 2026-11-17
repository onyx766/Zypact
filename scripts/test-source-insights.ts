#!/usr/bin/env tsx
/**
 * Source insights: provider sources read from stored evidence.
 *
 * E*  extraction from one stored provider body (Sonar and Agent API)
 * C*  domain categories (fixed list, exact match only)
 * A*  aggregation across runs, with explicit denominators and notes
 * R*  the protocol report: payload, markdown, short markdown, view, integrity
 * O*  the Outcome Card before/after comparison
 * G*  import boundary and wording
 *
 * Pure: no provider, no database, no network.
 */

import { readFileSync } from "node:fs";

import { sha256Hex } from "@/lib/evidence/hash";
import { agentOutputText, agentSearchResults } from "@/lib/probes/perplexity-agent";
import { buildOutcomeCard } from "@/lib/reports/build-outcome-card";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import { evaluateArtifactIntegrity } from "@/lib/reports/deliver-protocol-report";
import { NON_CAUSALITY_FOOTER, isOutcomeCardPayload } from "@/lib/reports/outcome-card-types";
import type { MeasurementCompatibility } from "@/lib/reports/measurement-fingerprint";
import {
  isProtocolReportPayload,
  type BuildProtocolReportInput,
  type EvidenceAttemptInput,
  type EvidenceResultInput,
  type ProtocolReportPayload,
  type ProtocolReportRunSources,
} from "@/lib/reports/protocol-report-types";
import { renderOutcomeCardMarkdown } from "@/lib/reports/render-outcome-card-markdown";
import {
  renderProtocolReportMarkdown,
  renderProtocolShortReportMarkdown,
} from "@/lib/reports/render-protocol-report-markdown";
import {
  MAX_DOMAINS_SHOWN,
  buildSourceInsights,
  compareSourceInsights,
} from "@/lib/source-insights/build-source-insights";
import {
  agentBodyAnswerText,
  agentBodySearchResults,
  extractProviderSources,
  normalizeSourceUrl,
} from "@/lib/source-insights/extract-provider-sources";
import { categorizeDomain } from "@/lib/source-insights/source-types";

let total = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  total += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function sonarBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp-1",
    model: "sonar",
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "Popular options include Vanta [1] and Drata [3]. Acme is also used [1][9].",
        },
      },
    ],
    citations: [
      "https://www.g2.com/categories/soc-2",
      "https://example-blog.test/post",
      "https://drata.test/compare).",
      "https://docs.acme.test/soc2#pricing",
    ],
    search_results: [
      { title: "Best SOC 2 tools", url: "https://www.g2.com/categories/soc-2" },
      { title: "A blog post", url: "https://example-blog.test/post" },
      { title: "Drata compare", url: "https://drata.test/compare" },
      { title: "Acme docs", url: "https://docs.acme.test/soc2" },
      { title: "Reddit thread", url: "https://www.reddit.com/r/soc2/abc" },
    ],
    ...over,
  });
}

function agentBody(): string {
  return JSON.stringify({
    id: "r-1",
    object: "response",
    status: "completed",
    model: "perplexity/sonar",
    output: [
      {
        type: "search_results",
        results: [
          { id: 1, title: "Vanta", url: "https://vanta.test/" },
          { id: 2, title: "Capterra list", url: "https://capterra.com/soc2" },
          { id: 3, title: "Acme", url: "https://acme.test/" },
        ],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "Capterra lists several [web:2], see also [7]." }],
      },
    ],
  });
}

function stored(body: string) {
  return { rawResponse: body, rawResponseSha256: sha256Hex(body) };
}

/* ------------------------------------------------------------------ */
/* E: extraction                                                        */
/* ------------------------------------------------------------------ */

console.log("extraction");
{
  const body = sonarBody();
  const r = extractProviderSources(body, sha256Hex(body));
  check("E1 a verified Sonar body is read", r.status === "ok" && r.responseFormat === "chat_completions");
  check(
    "E1 cited = sources the answer points at, in first-cited order",
    r.cited.map((s) => s.domain).join(",") === "g2.com,drata.test",
    r.cited.map((s) => s.url).join(" ")
  );
  check("E1 a source cited twice keeps one entry with its marker", r.cited[0].markers.join(",") === "1");
  check("E1 titles come from search results", r.cited[0].title === "Best SOC 2 tools");
  check(
    "E1 retrieved only = returned and not pointed at",
    r.retrievedOnly.map((s) => s.domain).sort().join(",") === "docs.acme.test,example-blog.test,reddit.com"
  );
  check("E2 a reference with no source is reported, not invented", r.unmatchedMarkers.join(",") === "9");
  check("E5 trailing punctuation and fragments are removed", r.cited[1].url === "https://drata.test/compare");
  check("E5 fragments are removed from retrieved URLs", r.retrievedOnly.some((s) => s.url === "https://docs.acme.test/soc2"));
  check("E1 no URL is both cited and retrieved", !r.retrievedOnly.some((s) => r.cited.some((c) => c.url === s.url)));
}
{
  const body = sonarBody({ choices: [{ message: { content: "No references here." } }] });
  const r = extractProviderSources(body, sha256Hex(body));
  check("E3 no markers: nothing is confirmed as cited", r.status === "ok" && !r.markersFound && r.cited.length === 0 && r.retrievedOnly.length === 5);
}
{
  const body = sonarBody();
  check("E4 a body that does not match its hash is refused", extractProviderSources(body, "0".repeat(64)).status === "hash_mismatch");
  check("E4 a body with no hash is refused", extractProviderSources(body, null).status === "hash_missing");
  check("E4 no stored body", extractProviderSources(null, null).status === "no_raw_response");
  check("E4 an undefined body (reader did not load it)", extractProviderSources(undefined, "a".repeat(64)).status === "no_raw_response");
  const transcript = "Answer text\n\nPerplexity citations:\n- https://g2.com";
  check("E4 a legacy reconstructed transcript is not a provider body", extractProviderSources(transcript, sha256Hex(transcript)).status === "not_provider_json");
  const odd = JSON.stringify({ foo: 1 });
  check("E4 an unknown JSON shape is reported", extractProviderSources(odd, sha256Hex(odd)).status === "unrecognised_shape");
}
{
  check("E5 javascript: is refused", normalizeSourceUrl("javascript:alert(1)") === null);
  check("E5 credentials in a URL are refused", normalizeSourceUrl("https://user:pw@g2.com/x") === null);
  check("E5 a host without a dot is refused", normalizeSourceUrl("http://localhost/x") === null);
  check("E5 www is folded into the domain", normalizeSourceUrl("https://WWW.G2.com/a")?.domain === "g2.com");
  check("E5 a non-string is refused", normalizeSourceUrl(42) === null);
  check("E5 an overlong URL is refused", normalizeSourceUrl(`https://a.test/${"x".repeat(3000)}`) === null);
}
{
  const body = JSON.stringify({
    choices: [{ message: { content: "See [2]." } }],
    citations: ["not a url", "https://b.test/page"],
  });
  const r = extractProviderSources(body, sha256Hex(body));
  check("E6 an unusable citation keeps its position, so [2] is not shifted", r.cited.length === 1 && r.cited[0].domain === "b.test");
}
{
  const body = JSON.stringify({
    choices: [{ message: { content: "See [2]." } }],
    search_results: [{ url: "https://a.test/1" }, { url: "https://b.test/2" }],
  });
  const r = extractProviderSources(body, sha256Hex(body));
  check("E9 with no citations list, [n] indexes the search results", r.cited.length === 1 && r.cited[0].domain === "b.test" && r.retrievedOnly[0]?.domain === "a.test");
}
{
  const body = agentBody();
  const r = extractProviderSources(body, sha256Hex(body));
  check("E7 a verified Agent API body is read", r.status === "ok" && r.responseFormat === "agent_response");
  // D-056 — the protocol's provider selects the rule; Perplexity providers read exactly as before.
  check("E7b a Perplexity provider argument changes nothing (Agent and Sonar bodies)",
    JSON.stringify(extractProviderSources(body, sha256Hex(body), "perplexity_agent")) === JSON.stringify(r) &&
    JSON.stringify(extractProviderSources(sonarBody(), sha256Hex(sonarBody()), "perplexity_sonar")) === JSON.stringify(extractProviderSources(sonarBody(), sha256Hex(sonarBody()))));
  check("E7c the ChatGPT provider reads the same object:\"response\" shape under its own rule, never the Agent's",
    extractProviderSources(body, sha256Hex(body), "openai_chatgpt").responseFormat === "openai_responses");
  check("E7 [web:n] maps to the result's own id", r.cited.length === 1 && r.cited[0].domain === "capterra.com" && r.cited[0].markers[0] === 2);
  check("E7 an id with no result is unmatched", r.unmatchedMarkers.join(",") === "7");
  check("E7 the other results are retrieved only", r.retrievedOnly.map((s) => s.domain).sort().join(",") === "acme.test,vanta.test");

  const output = (JSON.parse(body) as { output: unknown }).output;
  check("E8 answer-text parity with the adapter", agentBodyAnswerText(output) === agentOutputText(output));
  const ours = agentBodySearchResults(output);
  const theirs = agentSearchResults(output);
  check(
    "E8 search-result parity with the adapter (id, url, title)",
    JSON.stringify(ours) === JSON.stringify(theirs.map((r) => ({ id: r.id, url: r.url, title: r.title })))
  );
}

/* ------------------------------------------------------------------ */
/* C: categories                                                        */
/* ------------------------------------------------------------------ */

console.log("categories");
check("C1 the subject's subdomain is owned", categorizeDomain("docs.acme.test", "www.acme.test") === "owned");
check("C1 the subject's apex is owned", categorizeDomain("acme.test", "acme.test") === "owned");
check("C2 a listed domain's subdomain keeps its type", categorizeDomain("learn.g2.com", "acme.test") === "review_platform");
check("C3 a lookalike is not listed", categorizeDomain("notg2.com", "acme.test") === "unclassified");
check("C3 a listed name inside another domain is not listed", categorizeDomain("g2.com.evil.test", "acme.test") === "unclassified");
check("C4 an unknown blog is unclassified, not guessed", categorizeDomain("myblog.medium-like.test", "acme.test") === "unclassified");

/* ------------------------------------------------------------------ */
/* A: aggregation                                                       */
/* ------------------------------------------------------------------ */

console.log("aggregation");
function runOf(ordinal: number, body: string | null): ProtocolReportRunSources {
  return { ordinal, ...extractProviderSources(body, body === null ? null : sha256Hex(body)) };
}
{
  const runs = [
    runOf(1, sonarBody()),
    runOf(2, sonarBody({ choices: [{ message: { content: "Acme docs [4] and G2 [1]." } }] })),
    runOf(3, null),
  ];
  const s = buildSourceInsights(runs, "acme.test");
  check("A1 readable runs and runs with a source list are both stated", s.readableRuns === 3 && s.runsWithSourceEvidence === 2);
  const g2 = s.domains.find((d) => d.domain === "g2.com");
  check("A2 a domain is counted once per run it was cited in", g2?.citedInRuns === 2 && g2.citedRunOrdinals.join(",") === "1,2");
  const docs = s.domains.find((d) => d.domain === "docs.acme.test");
  check("A3 cited in one run, retrieved only in another", docs?.citedInRuns === 1 && docs.retrievedOnlyInRuns === 1 && docs.category === "owned");
  check("A4 owned citations are counted per run", s.runsWithOwnedCitation === 1);
  check("A5 the run without a source list is named, not read as absent", s.notes.some((n) => n.includes("1 of 3 readable runs had no usable source list") && n.includes("not counted as absent")));
  check("A6 an unmatched reference is disclosed", s.notes.some((n) => n.includes("matched no returned source")));
  check("A7 the not-read note is always present", s.notes.some((n) => n.includes("Zypact has not opened these pages")));
  check("A8 the no-causation note is always present", s.notes.some((n) => n.includes("does not show that publishing or changing a page would change the answer")));
  check("A9 domains sort by cited runs first", s.domains[0].domain === "g2.com");
}
{
  const s = buildSourceInsights([runOf(1, sonarBody({ choices: [{ message: { content: "none" } }] }))], "acme.test");
  check("A10 no references: disclosed", s.notes.some((n) => n.includes("no numbered references")));
}
{
  const urls = Array.from({ length: MAX_DOMAINS_SHOWN + 5 }, (_, i) => `https://d${i}.test/`);
  const body = JSON.stringify({ choices: [{ message: { content: "x" } }], citations: urls });
  const s = buildSourceInsights([runOf(1, body)], "acme.test");
  check("A11 the domain cap is disclosed, never silent", s.domains.length === MAX_DOMAINS_SHOWN && s.domainsNotShown === 5 && s.notes.some((n) => n.includes("5 further domain")));
}
{
  const s = buildSourceInsights([], "acme.test");
  check("A12 no readable runs: an honest empty section", s.readableRuns === 0 && s.runsWithSourceEvidence === 0 && s.domains.length === 0);
}

/* ------------------------------------------------------------------ */
/* R: the protocol report                                               */
/* ------------------------------------------------------------------ */

console.log("report");
const NOW = new Date("2026-11-09T00:00:00.000Z");
const SUBJECT = { companyName: "Acme", websiteUrl: "https://acme.test", normalizedDomain: "acme.test" };
const QUESTION = {
  text: "Which SOC 2 tool should we shortlist?",
  hash: "b".repeat(64),
  versionNumber: 1,
  intentType: "shortlist",
  provenance: "customer_supplied",
  approvedAt: "2026-11-01T00:00:00.000Z",
};

function attempt(over: Partial<EvidenceAttemptInput> & { id: string }): EvidenceAttemptInput {
  return { attemptKind: "baseline", status: "completed", baselineOrdinal: null, probeRunId: null, retryOfAttemptId: null, terminationReason: null, ...over };
}
function result(over: Partial<EvidenceResultInput> & { probeRunId: string }): EvidenceResultInput {
  return {
    clientMentioned: true,
    clientPosition: "listed",
    competitorsMentioned: ["Vanta"],
    sourcesCited: [{ source: "model said g2", type: "review_site" }],
    answerSummary: "summary",
    rawResponseSha256: "a".repeat(64),
    providerModel: "sonar",
    providerLatencyMs: 1000,
    ...over,
  };
}
function phase(protocolId: string, bodies: Array<string | null>): BuildProtocolReportInput {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  bodies.forEach((body, i) => {
    attempts.push(attempt({ id: `${protocolId}-a${i}`, baselineOrdinal: i + 1, probeRunId: `${protocolId}-p${i}` }));
    results.push(result({ probeRunId: `${protocolId}-p${i}`, ...(body === null ? { rawResponse: null } : stored(body)) }));
  });
  attempts.push(attempt({ id: `${protocolId}-failed`, baselineOrdinal: bodies.length + 1, status: "failed", terminationReason: "provider_error" }));
  return {
    snapshotRequestId: "req-1",
    projectId: "proj-1",
    subject: SUBJECT,
    question: QUESTION,
    protocol: {
      id: protocolId,
      provider: "perplexity_sonar",
      surface: "answer",
      model: "sonar",
      plannedBaselineRuns: bodies.length + 1,
      unitOfAnalysis: "buyer_question_version",
      primaryMetric: "presence_rate",
      methodologyVersion: "1.1",
      analyzerVersion: 1,
      entityResolutionVersion: 2,
      approvedAt: "2026-11-01T00:00:00.000Z",
    },
    attempts,
    results,
    now: NOW,
  };
}

const baseline = buildProtocolReport(phase("base-1", [sonarBody(), sonarBody(), null]));
{
  const s = baseline.sourceInsights;
  check("R1 the report carries a source section", s !== undefined);
  check("R2 its denominator is the rate's readable runs (failed run excluded)", s?.readableRuns === baseline.observation.denominator && s?.readableRuns === 3);
  check("R3 the model-extracted list is not used for the section", !JSON.stringify(s).includes("model said g2"));
  check("R4 the payload still validates", isProtocolReportPayload(baseline));
  check("R5 the payload carries no raw provider body", !JSON.stringify(baseline).includes("Popular options include"));
  const noBody = buildProtocolReport({ ...phase("x", [sonarBody()]), results: phase("x", [sonarBody()]).results.map(({ rawResponse: _r, ...rest }) => rest) });
  check("R6 a reader that did not load bodies yields 'unavailable', not zero", noBody.sourceInsights?.runsWithSourceEvidence === 0 && noBody.sourceInsights.runs[0].status === "no_raw_response");
}
{
  const md = renderProtocolReportMarkdown(baseline);
  check("R7 markdown has the source section", md.includes("## 4. Sources the answers cited"));
  check("R7 markdown states owned citations with a denominator", md.includes("Your site was cited in 0 of 2 run(s) with a usable source list."));
  check("R7 markdown rows state k of n", md.includes("| g2.com | Review platform | 2 of 2 | 0 of 2 | 1, 2 |"));
  check("R8 the run table shows provider counts", md.includes("2 cited · 3 retrieved only"));
  check("R8 a run without a body says unavailable", md.includes("| unavailable |"));
  check("R9 later sections renumbered", md.includes("## 5. How certain this is") && md.includes("## 7. Integrity notes"));
  const short = renderProtocolShortReportMarkdown(baseline);
  check("R10 short report summarises sources", short.includes("## Sources cited") && short.includes("g2.com (review platform) — cited in 2 of 2"));
  check("R10 short report keeps the not-read caveat", short.includes("Zypact has not opened these pages"));
  const without = { ...baseline } as ProtocolReportPayload;
  delete without.sourceInsights;
  const signals = { hasApprovedProtocol: true, hasApprovedSamplePlan: true };
  const withSection = evaluateArtifactIntegrity(md, short, signals);
  const withoutSection = evaluateArtifactIntegrity(
    renderProtocolReportMarkdown(without),
    renderProtocolShortReportMarkdown(without),
    signals
  );
  check(
    "R11 the new section does not change the integrity decision",
    withSection.status === withoutSection.status &&
      JSON.stringify(withSection.reasons) === JSON.stringify(withoutSection.reasons),
    `${withSection.status} vs ${withoutSection.status}`
  );
  check("R12 no verdict vocabulary in the source section", !/\b(won|lost|partial)\b/i.test(md.split("## 4.")[1].split("## 5.")[0]));
}
{
  const legacy = { ...baseline } as ProtocolReportPayload;
  delete legacy.sourceInsights;
  const md = renderProtocolReportMarkdown(legacy);
  check("R13 a report saved before this change still validates", isProtocolReportPayload(legacy));
  check("R13 and renders without the section, with the stored count", !md.includes("Sources the answers cited") && md.includes("| 1 |"));
}

/* ------------------------------------------------------------------ */
/* O: Outcome Card                                                      */
/* ------------------------------------------------------------------ */

console.log("outcome card");
const COMPATIBLE: MeasurementCompatibility = { status: "compatible", version: "mf-1", caveats: [] };
const retestBody = sonarBody({ choices: [{ message: { content: "Acme docs [4], G2 [1]." } }] });
const retest = buildProtocolReport(phase("retest-1", [retestBody, retestBody, retestBody]));
function cardOf(b: ProtocolReportPayload, r: ProtocolReportPayload) {
  return buildOutcomeCard({
    projectId: "proj-1",
    baseline: b,
    retest: r,
    intervention: {
      hypothesis: "h",
      expectedMechanism: "m",
      actionType: "page_updated",
      actionTarget: "https://acme.test/x",
      owner: "o",
      approvedAt: null,
      implementedAt: null,
      protocolDeviations: null,
      earlyRetestReason: null,
      observationWindowOpensAt: null,
      observationWindowClosesAt: null,
    },
    minimumUsefulChange: 0.6,
    measurementCompatibility: COMPATIBLE,
    questionVersionIds: { baseline: "qv-1", retest: "qv-1" },
    now: NOW,
  });
}
{
  const card = cardOf(baseline, retest);
  const c = card.sourceComparison;
  check("O1 the card compares cited sources", c !== null && c !== undefined);
  check("O2 owned citations before and after, with denominators", c?.ownedCited.baseline === 0 && c.ownedCited.retest === 3 && c.baselineRunsWithSourceEvidence === 2 && c.retestRunsWithSourceEvidence === 3);
  const docs = c?.domains.find((d) => d.domain === "docs.acme.test");
  check("O3 per-domain counts per phase", docs?.baselineCitedInRuns === 0 && docs.retestCitedInRuns === 3);
  check("O4 no status is assigned to source changes", !JSON.stringify(c).match(/increase_observed|decrease_observed|no_clear_change/));
  check("O5 the card still validates and keeps its footer", isOutcomeCardPayload(card) && card.nonCausalityFooter === NON_CAUSALITY_FOOTER);
  const md = renderOutcomeCardMarkdown(card);
  check("O6 markdown has the section and renumbers", md.includes("## 5. Sources cited, before and after") && md.includes("## 6. How certain this is") && md.includes("## 7. What this does not tell you"));
  check("O6 markdown keeps the permanent footer", md.includes("It does not establish that the intervention caused the change."));
  check("O7 the comparison note disclaims causation", c?.notes[0].includes("not evidence that the intervention caused anything") ?? false);
}
{
  const legacy = { ...baseline } as ProtocolReportPayload;
  delete legacy.sourceInsights;
  const card = cardOf(legacy, retest);
  check("O8 a phase without a source section: no comparison", card.sourceComparison === null);
  check("O8 and the card renders its original sections", renderOutcomeCardMarkdown(card).includes("## 5. How certain this is"));
  check(
    "O9 different rule versions are never compared",
    compareSourceInsights(baseline.sourceInsights, { ...retest.sourceInsights!, extractionVersion: "provider-sources/0" }) === null
  );
}

/* ------------------------------------------------------------------ */
/* G: boundary and wording                                              */
/* ------------------------------------------------------------------ */

console.log("boundary");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const file of [
  "lib/source-insights/extract-provider-sources.ts",
  "lib/source-insights/build-source-insights.ts",
  "lib/source-insights/source-types.ts",
]) {
  const src = stripComments(readFileSync(file, "utf8"));
  check(`G1 ${file} imports no provider, model, database or network module`, !/from ["']@\/lib\/(probes|llm|db|supabase|agents|pipeline|protocol-worker|crawler)\//.test(src) && !/\bfetch\(/.test(src));
}
const view = readFileSync("components/report/protocol-report-view.tsx", "utf8");
check("G2 the report view renders the section only when the payload has it", view.includes("payload.sourceInsights ? ("));
const cardView = readFileSync("components/report/outcome-card-view.tsx", "utf8");
check("G3 the card view renders the comparison only when present", cardView.includes("payload.sourceComparison ? ("));

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
