/**
 * Phase 6 — the sampling-power disclosure required by §5 of the signed-off
 * OUTCOME_COMPARISON_PROPOSAL.
 *
 * What this proves:
 *
 *   1. The signed-off power table is reproduced exactly by the TypeScript
 *      source the PL/pgSQL mirrors.
 *   2. A draft protocol carries null. The value is a fact about an approval,
 *      not about a plan that has not been approved.
 *   3. `approveProtocol` stamps the value migration 0075's SET clause would
 *      produce — symmetric denominators, both taken from
 *      `planned_baseline_runs`.
 *   4. The snapshot-approval path stamps it too. That path is how every real
 *      baseline is approved, so a disclosure that only worked on the direct
 *      path would never actually be seen by a founder.
 *
 * This is a memory-adapter test. It does not prove the deployed PL/pgSQL
 * agrees — `test:m7-0075-runtime` does that against real PostgreSQL, and the
 * staging probe recorded in CURRENT_STATUS §16 confirms the deployed body.
 * What this pins is that the TypeScript path cannot silently drift from it.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { smallestDetectableChange } from "@/lib/reports/compare-protocols";

const db = getDb();
const APPROVER = "11111111-1111-4111-8111-111111111111";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function round2(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

async function approvedVersionFor(projectId: string): Promise<string> {
  const question = await db.createBuyerQuestion({ projectId });
  const version = await db.createBuyerQuestionVersion({
    buyerQuestionId: question.id,
    projectId,
    versionNumber: 1,
    promptText: "best invoicing software for a 20-person agency",
    promptHash: `hash-${randomUUID()}`,
    intentType: "shortlist",
    commercialValue: 4,
    winnability: 3,
    priority: 1,
    rationale: "disclosure fixture",
    provenance: "founder_supplied",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId,
    approvedBy: APPROVER,
  });
  return version.id;
}

async function main(): Promise<void> {
  console.log("\nDetectable-change disclosure (Phase 6)\n");

  // ------------------------------------------------- the signed-off table
  // If this block fails, the disclosure is lying and the sign-off no longer
  // describes the shipped method.
  const TABLE: Array<[number, number]> = [
    [5, 0.6],
    [10, 0.4],
    [15, 0.27],
    [20, 0.25],
    [30, 0.17],
  ];

  for (const [n, expected] of TABLE) {
    check(
      `smallestDetectableChange(${n}, ${n}) rounds to ${expected}`,
      round2(smallestDetectableChange(n, n)) === expected,
      `got ${String(round2(smallestDetectableChange(n, n)))}`
    );
  }

  // The boundary the sign-off turns on: at the five-run default the smallest
  // detectable change is not smaller than Δ_min, so the plan can only detect
  // a change at least as large as the one already agreed to be the minimum
  // worth acting on. Keeping that visible is the whole point of §5.
  const atFive = smallestDetectableChange(5, 5);
  check(
    "at n=5 the detectable change is not smaller than Δ_min (0.60)",
    atFive !== null && atFive >= 0.6,
    `got ${String(atFive)}`
  );

  // -------------------------------------------------------- draft is null
  const project = await db.createProject({
    domain: `disclosure-${randomUUID()}.test`,
    companyName: "Disclosure Fixture Co",
  });
  const versionId = await approvedVersionFor(project.id);

  const draft = await db.createProtocol({
    projectId: project.id,
    buyerQuestionVersionId: versionId,
    provider: "perplexity_sonar",
    surface: "answer",
    plannedBaselineRuns: 10,
    plannedRetestRuns: 0,
    unitOfAnalysis: "buyer_question_version",
    primaryMetric: "presence_rate",
    samplePlanningMethod: "fixed_by_protocol",
    runCap: 12,
    spendCapUsd: 5,
    timeWindowSeconds: 3600,
    rateLimitPerHour: 100,
    concurrencyLimit: 10,
    retryCap: 2,
  });

  check(
    "a draft protocol has no disclosed value",
    draft.detectableChangeAtPlan === null,
    `got ${String(draft.detectableChangeAtPlan)}`
  );

  // ------------------------------------------------------- approval stamps
  const approval = await db.approveProtocol({
    protocolId: draft.id,
    projectId: project.id,
    approvedBy: APPROVER,
  });

  check("approval succeeded", approval.outcome === "APPROVED", approval.outcome);

  check(
    "approval stamps the disclosure",
    approval.protocol?.detectableChangeAtPlan !== null &&
      approval.protocol?.detectableChangeAtPlan !== undefined
  );

  // 0075 passes planned_baseline_runs for BOTH denominators. A plan of 10
  // must disclose sdc(10, 10) — never sdc(10, 0), which is what a careless
  // read of the retest column would produce.
  check(
    "the stamped value is sdc(plannedBaselineRuns, plannedBaselineRuns)",
    approval.protocol?.detectableChangeAtPlan ===
      smallestDetectableChange(10, 10),
    `got ${String(approval.protocol?.detectableChangeAtPlan)}`
  );

  check(
    "a 10-run plan discloses 0.40, not the 5-run default",
    round2(approval.protocol?.detectableChangeAtPlan) === 0.4,
    `got ${String(round2(approval.protocol?.detectableChangeAtPlan))}`
  );

  // A re-read through the same method the admin page uses must carry it too —
  // a value stamped on the returned row but lost by the row mapper would be
  // invisible exactly where §5 requires it to be visible.
  const reread = await db.getProtocol(draft.id, project.id);
  check(
    "getProtocol carries the disclosure back",
    reread?.detectableChangeAtPlan === approval.protocol?.detectableChangeAtPlan,
    `got ${String(reread?.detectableChangeAtPlan)}`
  );

  // ------------------------------------------- the snapshot-approval path
  // Every real baseline is approved through this path, not the direct one.
  const domain = `snapshot-${randomUUID()}.invalid`;
  const request = await db.createSnapshotRequest({
    workEmail: `fixture@${domain}`,
    normalizedEmail: `fixture@${domain}`,
    companyName: "Snapshot Fixture Co",
    contactName: "Fixture Person",
    websiteUrl: `https://${domain}`,
    normalizedDomain: domain,
    buyerCategory: "best invoicing software for a 20-person agency",
  });

  // The request must clear email verification before it is approvable, the
  // same as in production. Approving an unverified request is a state the
  // adapter refuses, and the fixture must not pretend otherwise.
  const tokenHash = `token-${randomUUID()}`;
  await db.issueSnapshotRequestVerification({
    requestId: request.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const verified = await db.consumeSnapshotRequestVerification(tokenHash);
  check("the fixture request reached pending_approval", verified !== null);

  // Approval requires a competitor frame of 2-12 names, none of them the
  // requesting company itself. An empty array is refused, which is why this
  // fixture supplies a real frame rather than a placeholder.
  const launched = await db.approveAndLaunchSnapshotBaseline(
    request.id,
    APPROVER,
    ["Alpha Invoicing", "Beta Billing"],
    `hash-${randomUUID()}`
  );

  const launchedProtocol =
    launched?.protocolId && launched?.projectId
      ? await db.getProtocol(launched.protocolId, launched.projectId)
      : null;

  check(
    "the snapshot-approval path produced a protocol",
    launchedProtocol !== null,
    `launched ${launched ? "ok" : "null"}`
  );

  check(
    "the snapshot-approved baseline carries the disclosure",
    launchedProtocol?.detectableChangeAtPlan !== null &&
      launchedProtocol?.detectableChangeAtPlan !== undefined,
    `got ${String(launchedProtocol?.detectableChangeAtPlan)}`
  );

  // D-032: that path plans 5 runs, so the value a founder actually sees on
  // the admin page for a real request is 0.60 — the Δ_min boundary.
  check(
    "the five-run default discloses 0.60",
    round2(launchedProtocol?.detectableChangeAtPlan) === 0.6,
    `got ${String(round2(launchedProtocol?.detectableChangeAtPlan))}`
  );

  console.log(
    `\n${passed}/${passed + failed} checks passed.${
      failed ? ` ${failed} FAILED.` : ""
    }\n`
  );

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
