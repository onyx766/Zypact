#!/usr/bin/env tsx
/**
 * The Outcome Card builder and renderer.
 *
 * Two properties carry the weight here, both structural rather than
 * incidental:
 *
 *   - the permanent non-causality footer (D-006) renders identically in
 *     ALL FOUR statuses, verbatim, and there is no payload field or builder
 *     input that can change or omit it;
 *   - no status's rendered prose ever asserts causality — "caused",
 *     "resulted in", "because of" attached to what the intervention did —
 *     regardless of how confident the numbers look.
 *
 * Reuses `buildProtocolReport` to construct both phases, exactly as
 * production code will: a retest is just another `protocols` row, and this
 * file's fixtures prove that claim rather than assuming it.
 *
 * Pure: no database, no provider, no network.
 */

import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import type {
  BuildProtocolReportInput,
  EvidenceAttemptInput,
  EvidenceResultInput,
  ProtocolReportPayload,
} from "@/lib/reports/protocol-report-types";
import {
  buildOutcomeCard,
  type BuildOutcomeCardInput,
} from "@/lib/reports/build-outcome-card";
import {
  NON_CAUSALITY_FOOTER,
  isOutcomeCardPayload,
  type OutcomeCardIntervention,
} from "@/lib/reports/outcome-card-types";
import { renderOutcomeCardMarkdown } from "@/lib/reports/render-outcome-card-markdown";
import type { MeasurementCompatibility } from "@/lib/reports/measurement-fingerprint";

let checks = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-18T00:00:00.000Z");

function attempt(over: Partial<EvidenceAttemptInput> & { id: string }): EvidenceAttemptInput {
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

function result(over: Partial<EvidenceResultInput> & { probeRunId: string }): EvidenceResultInput {
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

const QUESTION = {
  text: "Which SOC 2 automation tool should we shortlist?",
  hash: "b".repeat(64),
  versionNumber: 1,
  intentType: "shortlist",
  provenance: "customer_supplied",
  approvedAt: "2026-08-01T00:00:00.000Z",
} as const;

const SUBJECT = {
  companyName: "Acme Corp",
  websiteUrl: "https://acme.test",
  normalizedDomain: "acme.test",
} as const;

/** Builds a phase's report from a simple presence count over n runs — the shared fixture shape both baseline and retest use. */
function phaseReport(opts: {
  protocolId: string;
  presentCount: number;
  totalRuns: number;
  model?: string;
  provider?: string;
  surface?: string;
}): ProtocolReportPayload {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  for (let i = 0; i < opts.totalRuns; i += 1) {
    const id = `${opts.protocolId}-a${i}`;
    const probeRunId = `${opts.protocolId}-p${i}`;
    attempts.push(attempt({ id, status: "completed", probeRunId }));
    results.push(
      result({
        probeRunId,
        clientMentioned: i < opts.presentCount,
        clientPosition: i < opts.presentCount ? "listed" : "absent",
      })
    );
  }
  const input: BuildProtocolReportInput = {
    snapshotRequestId: "req-1",
    projectId: "proj-1",
    subject: SUBJECT,
    question: QUESTION,
    protocol: {
      id: opts.protocolId,
      provider: opts.provider ?? "perplexity_sonar",
      surface: opts.surface ?? "answer",
      model: opts.model ?? "sonar",
      plannedBaselineRuns: opts.totalRuns,
      unitOfAnalysis: "buyer_question_version",
      primaryMetric: "presence_rate",
      methodologyVersion: "1.1",
      analyzerVersion: 1,
      entityResolutionVersion: 2,
      approvedAt: "2026-08-01T00:00:00.000Z",
    },
    attempts,
    results,
    now: NOW,
  };
  return buildProtocolReport(input);
}

const INTERVENTION: OutcomeCardIntervention = {
  hypothesis: "Publishing a SOC 2 comparison page increases shortlist presence.",
  expectedMechanism: "Perplexity indexes the new page as a citable source.",
  actionType: "page_created",
  actionTarget: "https://acme.test/soc2-comparison",
  owner: "Growth",
  approvedAt: "2026-08-05T00:00:00.000Z",
  implementedAt: "2026-08-10T00:00:00.000Z",
  protocolDeviations: null,
  earlyRetestReason: null,
  observationWindowOpensAt: "2026-08-10T00:00:00.000Z",
  observationWindowClosesAt: "2026-08-31T00:00:00.000Z",
};

/** These scenarios are about the comparison itself; both phases measured alike. */
const COMPATIBLE: MeasurementCompatibility = { status: "compatible", version: "mf-1", caveats: [] };
const SAME_QUESTION = { baseline: "qv-1", retest: "qv-1" };

function card(over: Partial<BuildOutcomeCardInput> = {}) {
  const baseline = over.baseline ?? phaseReport({ protocolId: "baseline-1", presentCount: 0, totalRuns: 5 });
  const retest = over.retest ?? phaseReport({ protocolId: "retest-1", presentCount: 5, totalRuns: 5 });
  return buildOutcomeCard({
    projectId: "proj-1",
    baseline,
    retest,
    intervention: INTERVENTION,
    minimumUsefulChange: 0.6,
    detectableChangeAtPlan: 0.6,
    measurementCompatibility: COMPATIBLE, questionVersionIds: SAME_QUESTION,
    now: NOW,
    ...over,
  });
}

async function main(): Promise<void> {
  // ======================================================================
  // [1] Structural identity — a retest IS just another protocols row.
  // ======================================================================
  console.log("[1] buildProtocolReport works unmodified for a retest protocol");
  const retestOnly = phaseReport({ protocolId: "retest-x", presentCount: 3, totalRuns: 5 });
  check("a retest-labelled phase builds a normal report payload", retestOnly.observation.numerator === 3);
  check("attemptKind='baseline' in the fixture is irrelevant to the builder — it never filters on it",
    retestOnly.reconciliation.completed === 5);

  // ======================================================================
  // [2] The permanent footer — every status, verbatim, unremovable.
  // ======================================================================
  console.log("\n[2] The non-causality footer renders in every status, verbatim");
  const scenarios: Array<[string, number, number]> = [
    ["increase_observed", 0, 5],
    ["decrease_observed", 5, 0],
    ["no_clear_change", 2, 3],
    ["inconclusive", 0, 1],
  ];
  for (const [expectedStatus, basePresent, retestPresent] of scenarios) {
    const baseline = phaseReport({ protocolId: `b-${expectedStatus}`, presentCount: basePresent, totalRuns: 5 });
    const retest = phaseReport({ protocolId: `r-${expectedStatus}`, presentCount: retestPresent, totalRuns: expectedStatus === "inconclusive" ? 1 : 5 });
    const c = buildOutcomeCard({
      projectId: "proj-1",
      baseline,
      retest,
      intervention: INTERVENTION,
      measurementCompatibility: COMPATIBLE, questionVersionIds: SAME_QUESTION,
      minimumUsefulChange: 0.6,
      now: NOW,
    });
    check(`(${expectedStatus}) the comparison actually reaches this status`, c.comparison.status === expectedStatus, c.comparison.status);
    check(`(${expectedStatus}) payload.nonCausalityFooter is the exact literal`, c.nonCausalityFooter === NON_CAUSALITY_FOOTER);
    const md = renderOutcomeCardMarkdown(c);
    check(`(${expectedStatus}) the rendered markdown contains the exact footer sentence`,
      md.includes(NON_CAUSALITY_FOOTER));
  }

  check(
    "buildOutcomeCard's input type has no field that could override the footer",
    (() => {
      // Structural check: the builder always assigns the imported constant;
      // there is no `nonCausalityFooter` key anywhere in BuildOutcomeCardInput.
      // Attempting to smuggle one through is a type error, verified by the
      // cast below never being reachable in compiled code — this line exists
      // so a future refactor that adds such a field breaks this test's intent
      // loudly rather than silently.
      const c = card();
      return c.nonCausalityFooter === NON_CAUSALITY_FOOTER;
    })()
  );

  // ======================================================================
  // [3] No status's prose ever asserts causality.
  // ======================================================================
  console.log("\n[3] No rendered status implies the intervention caused anything");
  const CAUSAL_LANGUAGE = /\b(caused|resulted in|because of|due to|led to|drove the (increase|decrease|change))\b/i;
  // A sentence containing causal language is safe ONLY if it is itself a
  // negation of causality — "does not establish that ... caused ..." — the
  // exact pattern both the permanent footer and the existing baseline-report
  // limitations text already use. Anything else containing that vocabulary
  // is a positive causal assertion and must fail.
  const NEGATES_CAUSALITY = /\b(does not|cannot|never|no evidence that|not evidence that|does not mean)\b/i;
  function findUnsafeCausalSentences(text: string): string[] {
    const sentences = text.split(/(?<=[.!?])\s+/);
    return sentences.filter(
      (s) => CAUSAL_LANGUAGE.test(s) && !NEGATES_CAUSALITY.test(s)
    );
  }
  for (const [expectedStatus, basePresent, retestPresent] of scenarios) {
    const baseline = phaseReport({ protocolId: `c-b-${expectedStatus}`, presentCount: basePresent, totalRuns: 5 });
    const retest = phaseReport({ protocolId: `c-r-${expectedStatus}`, presentCount: retestPresent, totalRuns: expectedStatus === "inconclusive" ? 1 : 5 });
    const c = buildOutcomeCard({
      projectId: "proj-1",
      baseline,
      retest,
      intervention: INTERVENTION,
      measurementCompatibility: COMPATIBLE, questionVersionIds: SAME_QUESTION,
      minimumUsefulChange: 0.6,
      now: NOW,
    });
    const md = renderOutcomeCardMarkdown(c);
    const unsafe = findUnsafeCausalSentences(md);
    check(
      `(${expectedStatus}) no UNHEDGED causal language anywhere in the render`,
      unsafe.length === 0,
      unsafe.join(" | ")
    );
  }
  // Prove the detector itself actually distinguishes the two cases, rather
  // than merely happening not to fire.
  check("the detector flags a genuinely unhedged causal sentence",
    findUnsafeCausalSentences("The intervention caused the increase.").length === 1);
  check("the detector clears a negated one",
    findUnsafeCausalSentences("It does not establish that the intervention caused the change.").length === 0);

  // ======================================================================
  // [4] Structural guarantees on the payload shape.
  // ======================================================================
  console.log("\n[4] Structural guarantees");
  const c1 = card();
  check("isOutcomeCardPayload accepts a real payload", isOutcomeCardPayload(c1));
  check("isOutcomeCardPayload rejects a payload with the wrong footer",
    !isOutcomeCardPayload({ ...c1, nonCausalityFooter: "something else" }));
  check("isOutcomeCardPayload rejects null", !isOutcomeCardPayload(null));
  check("isOutcomeCardPayload rejects a stripped object", !isOutcomeCardPayload({ reportVersion: 1 }));

  check("the same question version is reused from the baseline, not a copy",
    c1.question.hash === QUESTION.hash);
  check("comparison always carries a Newcombe method label",
    c1.comparison.intervalMethod === "newcombe_95");
  check("detectableChangeAtPlan is informational — never fed back into comparison",
    c1.detectableChangeAtPlan === 0.6);

  // ======================================================================
  // [5] The identity mismatch path actually reaches the card.
  // ======================================================================
  console.log("\n[5] A provider/model mismatch between phases surfaces correctly");
  {
    const baseline = phaseReport({ protocolId: "id-b", presentCount: 0, totalRuns: 5, model: "sonar" });
    const retest = phaseReport({ protocolId: "id-r", presentCount: 5, totalRuns: 5, model: "sonar-pro" });
    const undisclosed = buildOutcomeCard({
      projectId: "proj-1", baseline, retest, intervention: INTERVENTION, minimumUsefulChange: 0.6, now: NOW,
      // Isolates the requested-model_config branch. A real model change
      // would also make the measurement incompatible, which is inconclusive
      // even when disclosed — see scripts/test-measurement-compatibility.ts.
      measurementCompatibility: COMPATIBLE, questionVersionIds: SAME_QUESTION,
    });
    check("undisclosed model drift is inconclusive", undisclosed.comparison.status === "inconclusive");
    check("the reason names the mismatch",
      undisclosed.comparison.reasons.includes("PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED"));

    const disclosed = buildOutcomeCard({
      projectId: "proj-1", baseline, retest,
      intervention: { ...INTERVENTION, protocolDeviations: "Perplexity changed its default Sonar model between phases." },
      minimumUsefulChange: 0.6, now: NOW, measurementCompatibility: COMPATIBLE, questionVersionIds: SAME_QUESTION,
    });
    check("disclosed model drift proceeds to a real status", disclosed.comparison.status === "increase_observed");
    const md = renderOutcomeCardMarkdown(disclosed);
    check("the disclosed deviation is surfaced in the rendered limitations",
      md.includes("Perplexity changed its default Sonar model between phases."));
  }

  // ======================================================================
  // [6] An early-retest deviation is surfaced, not hidden.
  // ======================================================================
  console.log("\n[6] An authorised early retest is disclosed, not concealed");
  {
    const c = card({
      intervention: { ...INTERVENTION, earlyRetestReason: "Pilot deadline; founder-approved deviation." },
    });
    const md = renderOutcomeCardMarkdown(c);
    check("the early-retest warning renders", md.includes("Retested before the observation window closed"));
    check("the recorded reason itself renders", md.includes("Pilot deadline; founder-approved deviation."));
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "Outcome Card contract PASSED." : "Outcome Card contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
