#!/usr/bin/env tsx
/**
 * Integrity-signal derivation contract.
 *
 * These four booleans decide whether a report may be emailed to a customer
 * without a human looking at it, so every one of them must be derived from
 * evidence and must fail closed. The cases here pin the failure direction:
 * a missing field always produces `false`, never a pass.
 *
 * Pure: no provider, no database, no network.
 */

import {
  deriveIntegritySignals,
  type IntegrityRows,
} from "@/lib/reports/protocol-integrity-signals";
import { evaluateReportIntegrity } from "@/lib/export/report-integrity";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

const HASH = "a".repeat(64);

function rows(over: Partial<IntegrityRows> = {}): IntegrityRows {
  return {
    protocolStatus: "approved",
    plannedBaselineRuns: 3,
    paraphrasePlanCount: 1,
    samplePlanningMethod: "fixed_operator_default_pending_pilot_calibration",
    questionApprovedAt: "2026-09-09T02:12:29.194767+00:00",
    reservations: [0.04, 0.04],
    evidence: [
      {
        rawResponseSha256: HASH,
        rawProbeRequestSha256: HASH,
        fullRequestBodyCapture: "absent",
      },
      {
        rawResponseSha256: HASH,
        rawProbeRequestSha256: HASH,
        fullRequestBodyCapture: "absent",
      },
    ],
    countedAttempts: 2,
    ...over,
  };
}

console.log("a complete protocol run satisfies every precondition");
{
  const s = deriveIntegritySignals(rows());
  check("approved protocol", s.hasApprovedProtocol);
  check("approved sample plan", s.hasApprovedSamplePlan);
  check("paid call reservation", s.hasPaidCallReservation);
  check("complete evidence hashes", s.hasCompleteEvidenceHashes);

  const verdict = evaluateReportIntegrity({
    markdown: "# clean report",
    ...s,
  });
  check("classifies as integrity_passed", verdict.status === "integrity_passed");
  check("passing carries no reasons", verdict.reasons.length === 0);
}

console.log("\nM1-A body capture is not required for M1 completeness");
{
  // Every current row records `absent`. Requiring the exact body here would
  // hold every report forever; that is a scope decision, not a gate.
  const s = deriveIntegritySignals(rows());
  check(
    "absent body capture still passes M1",
    s.hasCompleteEvidenceHashes
  );
}

console.log("\nevery signal fails closed");
{
  check(
    "unapproved protocol fails",
    !deriveIntegritySignals(rows({ protocolStatus: "draft" }))
      .hasApprovedProtocol
  );
  check(
    "unapproved question version fails",
    !deriveIntegritySignals(rows({ questionApprovedAt: null }))
      .hasApprovedProtocol
  );
  check(
    "zero planned runs fails the sample plan",
    !deriveIntegritySignals(rows({ plannedBaselineRuns: 0 }))
      .hasApprovedSamplePlan
  );
  check(
    "empty paraphrase plan fails the sample plan",
    !deriveIntegritySignals(rows({ paraphrasePlanCount: 0 }))
      .hasApprovedSamplePlan
  );
  check(
    "missing planning method fails the sample plan",
    !deriveIntegritySignals(rows({ samplePlanningMethod: null }))
      .hasApprovedSamplePlan
  );
  check(
    "a single unreserved attempt fails reservation",
    !deriveIntegritySignals(rows({ reservations: [0.04, null] }))
      .hasPaidCallReservation
  );
  check(
    "a zero reservation fails reservation",
    !deriveIntegritySignals(rows({ reservations: [0.04, 0] }))
      .hasPaidCallReservation
  );
  check(
    "fewer reservations than attempts fails",
    !deriveIntegritySignals(rows({ reservations: [0.04] }))
      .hasPaidCallReservation
  );
  check(
    "a missing response hash fails evidence",
    !deriveIntegritySignals(
      rows({
        evidence: [
          { rawResponseSha256: null, rawProbeRequestSha256: HASH, fullRequestBodyCapture: "absent" },
          { rawResponseSha256: HASH, rawProbeRequestSha256: HASH, fullRequestBodyCapture: "absent" },
        ],
      })
    ).hasCompleteEvidenceHashes
  );
  check(
    "a missing request hash fails evidence",
    !deriveIntegritySignals(
      rows({
        evidence: [
          { rawResponseSha256: HASH, rawProbeRequestSha256: null, fullRequestBodyCapture: "absent" },
          { rawResponseSha256: HASH, rawProbeRequestSha256: HASH, fullRequestBodyCapture: "absent" },
        ],
      })
    ).hasCompleteEvidenceHashes
  );
  check(
    "fewer results than attempts fails evidence",
    !deriveIntegritySignals(
      rows({
        evidence: [
          { rawResponseSha256: HASH, rawProbeRequestSha256: HASH, fullRequestBodyCapture: "absent" },
        ],
      })
    ).hasCompleteEvidenceHashes
  );
}

console.log("\nno counted attempts can never pass");
{
  const s = deriveIntegritySignals(
    rows({ countedAttempts: 0, reservations: [], evidence: [] })
  );
  check("reservation fails with no attempts", !s.hasPaidCallReservation);
  check("evidence fails with no attempts", !s.hasCompleteEvidenceHashes);

  const verdict = evaluateReportIntegrity({ markdown: "# empty", ...s });
  check("classifies as needs_review", verdict.status === "needs_review");
  check("states why", verdict.reasons.length >= 2);
}

console.log("\nlegacy verdict language is blocked outright");
{
  const s = deriveIntegritySignals(rows());
  const verdict = evaluateReportIntegrity({
    markdown: "**won prompt groups**: 3",
    ...s,
  });
  check(
    "blocked wins over a full set of passing signals",
    verdict.status === "blocked"
  );
}

console.log(
  failures === 0
    ? "\nAll integrity-signal checks passed."
    : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
