#!/usr/bin/env tsx
/**
 * Canonical V1 protocol-report builder contract.
 *
 * The legacy short report drew its client-facing interpretation from a
 * won/partial/lost verdict and reported a rate without ever showing what
 * happened to the attempts behind it. Both are prohibited for V1, so the
 * cases here pin the two properties that replace them:
 *
 *   - every reserved attempt stays visible in reconciliation, including a
 *     failure and a completed-but-unreadable run;
 *   - a rate is never stated without an interval, and never invented when
 *     nothing readable came back.
 *
 * Pure: no provider, no database, no network.
 */

import {
  buildProtocolReport,
  wilsonInterval,
} from "@/lib/reports/build-protocol-report";
import {
  isProtocolReportPayload,
  type BuildProtocolReportInput,
  type EvidenceAttemptInput,
  type EvidenceResultInput,
} from "@/lib/reports/protocol-report-types";
import {
  renderProtocolReportMarkdown,
  renderProtocolShortReportMarkdown,
} from "@/lib/reports/render-protocol-report-markdown";
import { evaluateArtifactIntegrity } from "@/lib/reports/deliver-protocol-report";
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

const NOW = new Date("2026-09-10T00:00:00.000Z");

function attempt(
  over: Partial<EvidenceAttemptInput> & { id: string }
): EvidenceAttemptInput {
  return {
    attemptKind: "baseline",
    status: "completed",
    baselineOrdinal: null,
    probeRunId: null,
    retryOfAttemptId: null,
    terminationReason: null,
    ...over,
  };
}

function result(
  over: Partial<EvidenceResultInput> & { probeRunId: string }
): EvidenceResultInput {
  return {
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "summary",
    rawResponseSha256: "a".repeat(64),
    providerModel: "sonar",
    providerLatencyMs: 1200,
    ...over,
  };
}

function input(
  over: Partial<BuildProtocolReportInput> = {}
): BuildProtocolReportInput {
  return {
    snapshotRequestId: "req-1",
    projectId: "proj-1",
    subject: {
      companyName: "Acme",
      websiteUrl: "https://acme.test",
      normalizedDomain: "acme.test",
    },
    question: {
      text: "best tool for X?",
      hash: "89c60d003f1f".padEnd(64, "0"),
      versionNumber: 1,
      intentType: "shortlist",
      provenance: "customer_supplied",
      approvedAt: "2026-09-09T02:12:29.194767+00:00",
    },
    protocol: {
      id: "protocol-1",
      provider: "perplexity_sonar",
      surface: "answer",
      model: "sonar",
      plannedBaselineRuns: 3,
      unitOfAnalysis: "buyer_question_version",
      primaryMetric: "presence_rate",
      methodologyVersion: "1.1",
      analyzerVersion: 1,
      entityResolutionVersion: 2,
      approvedAt: "2026-09-09T02:12:29.194767+00:00",
    },
    attempts: [],
    results: [],
    now: NOW,
    ...over,
  };
}

console.log("wilson interval");
{
  const zero = wilsonInterval(0, 3);
  check(
    "p=0 n=3 does not collapse to a point",
    !!zero && zero.low === 0 && zero.high > 0.5
  );

  const all = wilsonInterval(3, 3);
  check(
    "p=1 n=3 does not collapse to a point",
    !!all && all.high === 1 && all.low < 0.5
  );

  check("zero trials yields no interval", wilsonInterval(0, 0) === null);

  const wide = wilsonInterval(1, 3);
  const narrow = wilsonInterval(10, 30);
  check(
    "interval narrows as n grows at equal p",
    !!wide &&
      !!narrow &&
      wide.high - wide.low > narrow.high - narrow.low
  );
}

console.log("\nreconciliation keeps every attempt visible");
{
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({
          id: "a2",
          baselineOrdinal: 2,
          probeRunId: "p2",
          status: "failed",
          terminationReason: "provider_timeout",
        }),
        attempt({ id: "a3", baselineOrdinal: 3, probeRunId: "p3" }),
        // Completed but its provider result is missing entirely.
        attempt({ id: "a4", baselineOrdinal: 4, probeRunId: "p4" }),
      ],
      results: [
        result({ probeRunId: "p1", clientMentioned: true }),
        result({ probeRunId: "p2" }),
        result({ probeRunId: "p3", clientMentioned: false }),
      ],
    })
  );

  const r = payload.reconciliation;
  check("attempted counts every attempt", r.attempted === 4);
  check("completed excludes the failure", r.completed === 3);
  check("failed is surfaced", r.failed === 1);
  check("unreadable completed run is excluded, not hidden", r.excludedNoResult === 1);
  check("counts reconcile", r.accountedFor === true);
  check("planned is carried from the protocol", r.planned === 3);

  const o = payload.observation;
  check("denominator counts only readable runs", o.denominator === 2);
  check("numerator counts presence only", o.numerator === 1);
  check("rate is derived from readable runs", o.rate === 0.5);
  check("rate is always accompanied by an interval", o.interval !== null);

  // Three attempts completed against three planned, but only two were
  // readable. The shortfall the reader needs is the readable one, because
  // that is the number the rate is computed over.
  check(
    "shortfall is stated against readable runs, not completed ones",
    payload.uncertainty.some((n) =>
      n.includes("2 of 3 planned runs produced a readable result")
    )
  );
  check(
    "failed run remains in the run table",
    payload.runs.some((run) => run.status === "failed")
  );
}

console.log("\nnothing is tied to a 3-run plan: a 5-run protocol");
{
  // The default for new baselines is 5 (D-032). Every count below must come
  // from the protocol and the attempts, never from a constant.
  const payload = buildProtocolReport(
    input({
      protocol: { ...input().protocol, plannedBaselineRuns: 5 },
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({ id: "a2", baselineOrdinal: 2, probeRunId: "p2" }),
        attempt({
          id: "a3",
          baselineOrdinal: 3,
          probeRunId: "p3",
          status: "failed",
          terminationReason: "provider_timeout",
        }),
        attempt({ id: "a4", baselineOrdinal: 4, probeRunId: "p4" }),
        // Completed but with no readable provider result.
        attempt({ id: "a5", baselineOrdinal: 5, probeRunId: "p5" }),
      ],
      results: [
        result({ probeRunId: "p1", clientMentioned: true }),
        result({ probeRunId: "p2", clientMentioned: true }),
        result({ probeRunId: "p4", clientMentioned: false }),
      ],
    })
  );

  const r = payload.reconciliation;
  check("planned is 5, carried from the protocol", r.planned === 5);
  check("all 5 attempts are visible", r.attempted === 5 && payload.runs.length === 5);
  check("completed is 4", r.completed === 4);
  check("failed is 1", r.failed === 1);
  check("completed-without-result is 1", r.excludedNoResult === 1);
  check("counts reconcile", r.accountedFor === true);
  check("readable denominator is 3", payload.observation.denominator === 3);
  check("rate is 2 of 3 readable", payload.observation.numerator === 2);
  check(
    "shortfall is stated against the 5-run plan",
    payload.uncertainty.some((n) =>
      n.includes("3 of 5 planned runs produced a readable result")
    )
  );
  check(
    "integrity note states planned, completed, excluded and readable explicitly",
    payload.integrityNotes.some(
      (n) =>
        n.includes("5 planned") &&
        n.includes("4 completed") &&
        n.includes("0 excluded after review") &&
        n.includes("1 completed without a readable result") &&
        n.includes("3 readable and counted in the rate")
    )
  );

  const md = renderProtocolReportMarkdown(payload);
  check("markdown states planned runs", md.includes("- Planned runs: 5"));
  check("markdown states completed runs", md.includes("- Completed: 4"));
  check(
    "markdown states readable runs",
    md.includes("- Readable (counted in the rate): 3")
  );
}

console.log("\nempty result is honest, not a zero");
{
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, status: "failed" }),
      ],
      results: [],
    })
  );

  check("rate is null, not 0", payload.observation.rate === null);
  check("no interval is invented", payload.observation.interval === null);
  check(
    "empty state is stated explicitly",
    payload.uncertainty.some((n) => n.includes("not a zero"))
  );
}

console.log("\nretries stay in the record");
{
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({
          id: "a1",
          baselineOrdinal: 1,
          status: "failed",
          probeRunId: "p1",
        }),
        attempt({ id: "a2", probeRunId: "p2", retryOfAttemptId: "a1" }),
      ],
      results: [result({ probeRunId: "p2", clientMentioned: true })],
    })
  );

  check("retry is counted", payload.reconciliation.retried === 1);
  check(
    "retry points back at the ordinal it replaced",
    payload.runs.some((run) => run.retryOfOrdinal === 1)
  );
  check(
    "original failure is not removed",
    payload.runs.filter((r) => r.status === "failed").length === 1
  );
  check(
    "retries are disclosed in integrity notes",
    payload.integrityNotes.some((n) => n.includes("retries of an earlier attempt") || n.includes("retries"))
  );
}

console.log("\ncompetitor aggregation");
{
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({ id: "a2", baselineOrdinal: 2, probeRunId: "p2" }),
      ],
      results: [
        result({
          probeRunId: "p1",
          competitorsMentioned: ["Beta", "Beta", "Gamma"],
        }),
        result({ probeRunId: "p2", competitorsMentioned: ["Beta"] }),
      ],
    })
  );

  const beta = payload.competitorsObserved.find((c) => c.name === "Beta");
  check("duplicate mention in one run counts once", beta?.runsMentionedIn === 2);
  check(
    "ordered by run coverage",
    payload.competitorsObserved[0]?.name === "Beta"
  );
}

console.log("\na reviewer-excluded attempt is not called a failure");
{
  // The shape 0066 produces: an ambiguous attempt resolved by review.
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({ id: "a2", baselineOrdinal: 2, probeRunId: "p2" }),
        attempt({
          id: "a3",
          baselineOrdinal: 3,
          status: "excluded",
          terminationReason: "excluded_by_review:excluded_and_completed",
        }),
      ],
      results: [
        result({ probeRunId: "p1", clientMentioned: true }),
        result({ probeRunId: "p2", clientMentioned: true }),
      ],
    })
  );

  const r = payload.reconciliation;
  check("exclusion is counted separately", r.excludedByReview === 1);
  check("exclusion is not counted as a provider failure", r.failed === 0);
  check("counts still reconcile", r.accountedFor === true);
  check("rate rests only on confirmed runs", r.completed === 2 && payload.observation.denominator === 2);
  check(
    "the exclusion is disclosed to the reader",
    payload.integrityNotes.some((n) => n.includes("excluded by a reviewer"))
  );
  check(
    "no result is assumed for the excluded run",
    payload.runs.some(
      (run) => run.status === "excluded" && run.brandPresent === null
    )
  );
}

console.log("\nthe client is not listed as its own competitor");
{
  // Real evidence: asked for "alternatives", the surface listed Fathom among
  // them. Reporting that back as a competitor would tell the reader they
  // compete with themselves.
  const payload = buildProtocolReport(
    input({
      subject: {
        companyName: "Fathom Analytics",
        websiteUrl: "https://usefathom.com",
        normalizedDomain: "usefathom.com",
      },
      attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
      results: [
        result({
          probeRunId: "p1",
          clientMentioned: true,
          competitorsMentioned: ["Plausible", "Fathom", "Matomo"],
        }),
      ],
    })
  );

  const names = payload.competitorsObserved.map((c) => c.name);
  check("drops the client's own brand", !names.includes("Fathom"));
  check("keeps genuine competitors", names.includes("Plausible") && names.includes("Matomo"));
  check("drops only the self-match", names.length === 2);

  // A generic token must not swallow unrelated brands.
  const generic = buildProtocolReport(
    input({
      subject: {
        companyName: "Fathom Analytics",
        websiteUrl: "https://usefathom.com",
        normalizedDomain: "usefathom.com",
      },
      attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
      results: [
        result({
          probeRunId: "p1",
          competitorsMentioned: ["Analytics", "June Analytics"],
        }),
      ],
    })
  );
  check(
    "a bare generic token is not treated as the client",
    generic.competitorsObserved.some((c) => c.name === "Analytics")
  );
  check(
    "an unrelated brand sharing a generic word is kept",
    generic.competitorsObserved.some((c) => c.name === "June Analytics")
  );
}

console.log("\nprohibited V1 language is absent");
{
  const payload = buildProtocolReport(
    input({
      attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
      results: [result({ probeRunId: "p1", clientMentioned: true })],
    })
  );

  const serialized = JSON.stringify(payload).toLowerCase();
  for (const banned of ['"won"', '"lost"', '"partial"', "visibility score"]) {
    check(`no ${banned}`, !serialized.includes(banned));
  }
  check(
    "directional framing is stated",
    payload.uncertainty.some((n) => n.toLowerCase().includes("directional"))
  );
  check(
    "single-surface limitation is stated",
    payload.limitations.some((l) => l.includes("does not represent all AI buyers"))
  );
  check(
    "no causal claim is made",
    payload.limitations.some((l) => l.includes("does not establish"))
  );
}

console.log("\nstored-payload guard");
{
  const payload = buildProtocolReport(
    input({
      attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
      results: [result({ probeRunId: "p1" })],
    })
  );

  // Survives the round trip the jsonb column actually performs.
  const roundTripped = JSON.parse(JSON.stringify(payload));
  check("accepts a real payload after JSON round trip", isProtocolReportPayload(roundTripped));

  check("rejects null", !isProtocolReportPayload(null));
  check("rejects a string", !isProtocolReportPayload("{}"));
  check("rejects an array", !isProtocolReportPayload([]));
  check(
    "rejects an unknown report version",
    !isProtocolReportPayload({ ...roundTripped, reportVersion: 99 })
  );
  check(
    "rejects a payload missing observation",
    !isProtocolReportPayload({ ...roundTripped, observation: undefined })
  );
  check(
    "rejects a payload whose runs are not an array",
    !isProtocolReportPayload({ ...roundTripped, runs: "three" })
  );
}

console.log("\nmarkdown projection");
{
  const payload = buildProtocolReport(
    input({
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({
          id: "a2",
          baselineOrdinal: 2,
          status: "failed",
          terminationReason: "provider_timeout",
        }),
      ],
      results: [
        result({
          probeRunId: "p1",
          clientMentioned: true,
          competitorsMentioned: ["Beta"],
        }),
      ],
    })
  );

  const markdown = renderProtocolReportMarkdown(payload);

  check("includes the exact question text", markdown.includes("best tool for X?"));
  check("includes the full prompt hash", markdown.includes(payload.question.hash));
  check("shows the interval next to the rate", markdown.includes("95% interval"));
  check("keeps the failed run in the table", markdown.includes("provider_timeout"));
  check("states reconciliation", markdown.includes("Attempt reconciliation"));
  check(
    "escapes a pipe so a brand name cannot break the table",
    renderProtocolReportMarkdown(
      buildProtocolReport(
        input({
          attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
          results: [
            result({ probeRunId: "p1", competitorsMentioned: ["A|B"] }),
          ],
        })
      )
    ).includes("A\\|B")
  );

  const lower = markdown.toLowerCase();
  for (const banned of ["won the", "lost the", "visibility score"]) {
    check(`markdown omits "${banned}"`, !lower.includes(banned));
  }
}

console.log("\nshort projection: same figures, less detail");
{
  // A realistic 5-run baseline with a failure, an unreadable run, and more
  // named brands than the short report lists.
  const payload = buildProtocolReport(
    input({
      protocol: { ...input().protocol, plannedBaselineRuns: 5 },
      attempts: [
        attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" }),
        attempt({ id: "a2", baselineOrdinal: 2, probeRunId: "p2" }),
        attempt({
          id: "a3",
          baselineOrdinal: 3,
          probeRunId: "p3",
          status: "failed",
          terminationReason: "provider_timeout",
        }),
        attempt({ id: "a4", baselineOrdinal: 4, probeRunId: "p4" }),
        attempt({ id: "a5", baselineOrdinal: 5, probeRunId: "p5" }),
      ],
      results: [
        result({
          probeRunId: "p1",
          clientMentioned: true,
          competitorsMentioned: ["Beta", "Gamma", "Delta"],
        }),
        result({
          probeRunId: "p2",
          clientMentioned: false,
          competitorsMentioned: ["Beta", "Epsilon", "Zeta"],
        }),
        result({
          probeRunId: "p4",
          clientMentioned: true,
          competitorsMentioned: ["Beta", "Gamma"],
        }),
      ],
    })
  );

  const full = renderProtocolReportMarkdown(payload);
  const short = renderProtocolShortReportMarkdown(payload);

  check("short differs from full", short !== full);
  check(
    "short is materially shorter (under 60% of full)",
    short.length < full.length * 0.6
  );

  check("keeps the exact question text", short.includes("best tool for X?"));
  check(
    "states the same numerator and denominator",
    short.includes("2 of 3 readable runs")
  );
  const interval = payload.observation.interval!;
  check(
    "states the same interval as the full report",
    short.includes(
      `95% interval ${Math.round(interval.low * 100)}% to ${Math.round(
        interval.high * 100
      )}%`
    ) &&
      full.includes(
        `${Math.round(interval.low * 100)}% to ${Math.round(
          interval.high * 100
        )}%`
      )
  );
  check(
    "keeps failed and unreadable runs visible",
    short.includes("5 planned") &&
      short.includes("1 failed") &&
      short.includes("1 without a readable result") &&
      short.includes("3 counted in the rate")
  );
  check(
    "keeps every uncertainty note",
    payload.uncertainty.every((note) => short.includes(note))
  );
  check(
    "keeps every limitation",
    payload.limitations.every((note) => short.includes(note))
  );

  check("drops the run-by-run table", !short.includes("Run-by-run"));
  check(
    "drops evidence hashes",
    !short.includes(payload.question.hash.slice(0, 12)) &&
      !short.includes("a".repeat(16))
  );
  check("drops integrity notes", !short.includes("Integrity notes"));

  check(
    "lists the top three brands",
    short.includes("- Beta — 3 of 3") && short.includes("- Gamma — 2 of 3")
  );
  check(
    "points to the rest instead of listing them",
    short.includes("and 2 more, listed in the full report")
  );
  check(
    "keeps the non-displacement caveat",
    short.includes("not evidence that a brand displaced you")
  );

  const lower = short.toLowerCase();
  for (const banned of ["won the", "lost the", "visibility score"]) {
    check(`short omits "${banned}"`, !lower.includes(banned));
  }
}

console.log("\nshort projection: honest edge states");
{
  const empty = renderProtocolShortReportMarkdown(
    buildProtocolReport(
      input({
        attempts: [attempt({ id: "a1", baselineOrdinal: 1, status: "failed" })],
        results: [],
      })
    )
  );
  check("empty result is not a zero", empty.includes("not a zero"));
  check("no interval is invented", !empty.includes("95% interval"));

  const payload = buildProtocolReport(
    input({
      attempts: [attempt({ id: "a1", baselineOrdinal: 1, probeRunId: "p1" })],
      results: [result({ probeRunId: "p1" })],
    })
  );
  const unreconciled = renderProtocolShortReportMarkdown({
    ...payload,
    reconciliation: { ...payload.reconciliation, accountedFor: false },
  });
  check(
    "non-reconciling counts are flagged",
    unreconciled.includes("Attempt counts do not reconcile")
  );
}

console.log("\nboth stored bodies pass the integrity gate");
{
  const signals = {
    hasApprovedProtocol: true,
    hasApprovedSamplePlan: true,
    hasPaidCallReservation: true,
    hasCompleteEvidenceHashes: true,
  };
  const clean = "# report";
  const legacy = "**lost prompt groups**: 2";

  check(
    "clean bodies pass",
    evaluateArtifactIntegrity(clean, clean, signals).status ===
      "integrity_passed"
  );
  check(
    "a legacy verdict in the short body blocks the artifact",
    evaluateArtifactIntegrity(clean, legacy, signals).status === "blocked"
  );
  check(
    "a legacy verdict in the full body blocks the artifact",
    evaluateArtifactIntegrity(legacy, clean, signals).status === "blocked"
  );
  check(
    "missing signals still hold for review",
    evaluateArtifactIntegrity(clean, clean, {}).status === "needs_review"
  );

  // The revision must hash the body actually stored as short, or the
  // delivery claim is refused against the database's own computation.
  const worker = readFileSync(
    path.join(process.cwd(), "lib", "reports", "deliver-protocol-report.ts"),
    "utf8"
  );
  check(
    "the short body is stored as the short report",
    worker.includes("p_short_markdown: shortMarkdown")
  );
  check(
    "the delivery revision covers both bodies",
    worker.includes("snapshotReportArtifactRevision(markdown, shortMarkdown)")
  );
}

console.log(
  failures === 0
    ? "\nAll protocol-report builder checks passed."
    : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
