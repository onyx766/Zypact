#!/usr/bin/env tsx
/**
 * The two-phase integrity combination for an Outcome Card.
 *
 * The property under test is "blocked always wins, across phases and
 * across the intervention gate, not just within one phase" — extending a
 * precedent `evaluateReportIntegrity` already establishes internally
 * (a blocked legacy-verdict exposure always beats a needs_review M4 gap)
 * to the two-phase case this file adds.
 *
 * Pure. No database, no network.
 */

import { evaluateOutcomeCardIntegrity } from "@/lib/reports/outcome-card-integrity";
import {
  evaluateServedProviderComparability,
  fingerprintRawResponseBody,
  UNREADABLE_FINGERPRINT,
} from "@/lib/reports/served-provider-comparability";
import type { ProtocolIntegritySignals } from "@/lib/reports/protocol-integrity-signals";

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

const CLEAN_MARKDOWN = "# Outcome Card\n\nNo legacy vocabulary here.";
const LEGACY_MARKDOWN = "3 won · 1 partial · 1 lost";

const PASSING: ProtocolIntegritySignals = {
  hasApprovedProtocol: true,
  hasApprovedSamplePlan: true,
  hasPaidCallReservation: true,
  hasCompleteEvidenceHashes: true,
};

const FAILING: ProtocolIntegritySignals = {
  hasApprovedProtocol: false,
  hasApprovedSamplePlan: true,
  hasPaidCallReservation: true,
  hasCompleteEvidenceHashes: true,
};

function base(over: Partial<Parameters<typeof evaluateOutcomeCardIntegrity>[0]> = {}) {
  return evaluateOutcomeCardIntegrity({
    baselineMarkdown: CLEAN_MARKDOWN,
    baselineSignals: PASSING,
    retestMarkdown: CLEAN_MARKDOWN,
    retestSignals: PASSING,
    interventionRegisteredAndImplemented: true,
    servedProvider: { comparable: true, detail: "" },
    ...over,
  });
}

async function main(): Promise<void> {
  console.log("[1] The clean case");
  {
    const r = base();
    check("both phases clean -> integrity_passed", r.status === "integrity_passed", r.status);
    check("integrity_passed carries no reasons", r.reasons.length === 0);
  }

  console.log("\n[2] A single-phase M4 gap -> needs_review, never worse");
  {
    const r = base({ retestSignals: FAILING });
    check("retest gap -> needs_review", r.status === "needs_review", r.status);
    check("the reason is prefixed by phase", r.reasons.some((x) => x.startsWith("Retest:")));
    check("the baseline is not blamed for the retest's gap", !r.reasons.some((x) => x.startsWith("Baseline:")));
  }
  {
    const r = base({ baselineSignals: FAILING });
    check("baseline gap -> needs_review", r.status === "needs_review", r.status);
    check("the reason is prefixed correctly", r.reasons.some((x) => x.startsWith("Baseline:")));
  }

  console.log("\n[3] blocked always wins, wherever it comes from");
  {
    const r = base({ retestMarkdown: LEGACY_MARKDOWN, baselineSignals: FAILING });
    check(
      "a blocked retest beats a needs_review baseline gap",
      r.status === "blocked",
      r.status
    );
    check("both phases' reasons are still recorded, not discarded",
      r.reasons.some((x) => x.startsWith("Retest:")) && r.reasons.some((x) => x.startsWith("Baseline:")));
  }
  {
    const r = base({ baselineMarkdown: LEGACY_MARKDOWN });
    check("a blocked baseline alone is enough", r.status === "blocked", r.status);
  }

  console.log("\n[4] The intervention gate — no single-phase equivalent");
  {
    const r = base({ interventionRegisteredAndImplemented: false });
    check("an unregistered intervention blocks the card outright", r.status === "blocked", r.status);
    check("the reason names the intervention specifically",
      r.reasons.some((x) => x.startsWith("Intervention:")));
  }
  {
    // The gate must not be silently overridable by two clean phases.
    const r = base({ interventionRegisteredAndImplemented: false, baselineSignals: PASSING, retestSignals: PASSING });
    check("clean phases cannot rescue an unregistered intervention", r.status === "blocked", r.status);
  }

  console.log("\n[4b] What the provider served must match across phases");
  {
    const b = ["model=sonar id=other object=chat.completion"];
    const r5 = Array(5).fill("model=sonar id=resp_ object=chat.completion");
    const same = evaluateServedProviderComparability(Array(5).fill(r5[0]), r5);
    check("both phases served identically -> comparable", same.comparable && same.detail === "");
    const changed = evaluateServedProviderComparability(Array(5).fill(b[0]), r5);
    check("Sonar-style ids then resp_ ids (intervention 055c3514's shape) -> not comparable",
      !changed.comparable && /id=other/.test(changed.detail) && /id=resp_/.test(changed.detail), changed.detail);
    const r = base({ servedProvider: changed });
    check("a provider-side change holds a clean card for review", r.status === "needs_review", r.status);
    check("and the reason names the provider", r.reasons.some((x) => x.startsWith("Provider:")));
    check("it never relaxes a blocked card",
      base({ servedProvider: changed, interventionRegisteredAndImplemented: false }).status === "blocked");
    const missing = evaluateServedProviderComparability([...r5.slice(0, 4), UNREADABLE_FINGERPRINT], r5);
    check("one counted attempt without a readable receipt -> not comparable", !missing.comparable, missing.detail);
    check("an empty phase -> not comparable", !evaluateServedProviderComparability([], r5).comparable);
    check("fingerprint of a Sonar body",
      fingerprintRawResponseBody(JSON.stringify({ id: "abc-123", model: "sonar", object: "chat.completion" }))
        === "model=sonar id=other object=chat.completion");
    check("fingerprint of an Agent-reformulated body",
      fingerprintRawResponseBody(JSON.stringify({ id: "resp_9", model: "sonar", object: "chat.completion" }))
        === "model=sonar id=resp_ object=chat.completion");
    check("an unparseable body is unreadable, never a match",
      fingerprintRawResponseBody("{not json") === UNREADABLE_FINGERPRINT &&
      fingerprintRawResponseBody(null) === UNREADABLE_FINGERPRINT);
  }

  console.log("\n[5] Determinism and reason accumulation");
  {
    const r1 = base({ retestSignals: FAILING, baselineSignals: FAILING });
    const r2 = base({ retestSignals: FAILING, baselineSignals: FAILING });
    check("identical input, identical output", JSON.stringify(r1) === JSON.stringify(r2));
    check("both phases' reasons appear when both fail",
      r1.reasons.filter((x) => x.startsWith("Baseline:")).length > 0 &&
      r1.reasons.filter((x) => x.startsWith("Retest:")).length > 0);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "Outcome Card integrity contract PASSED." : "Outcome Card integrity contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
