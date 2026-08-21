#!/usr/bin/env tsx
/**
 * M4 — approved_by UUID validation.
 *
 * Regression test for a real staging incident: a synthetic fixture
 * passed `"staging-smoke-test@zypact.test"` (an email) as `approvedBy`
 * to `approveBuyerQuestionVersion`. Postgres rejected it (error 22P02,
 * invalid input syntax for type uuid) — but only AFTER a
 * `dataset_batches` row, a `buyer_questions` row, and a
 * `buyer_question_versions` row had already been created by the same
 * script, leaving three orphaned residue rows on the staging synthetic
 * project (dataset_batches id bd2da884-a1b3-4ac8-878f-ff0555adddf2,
 * buyer_questions id 6b175293-055f-40b1-8b16-23a8faec89fc,
 * buyer_question_versions id 47168500-eb08-4925-b39f-74a355f367ac —
 * known, harmless, deliberately left in place, never backfilled or
 * cleaned up per explicit instruction).
 *
 * Confirmed by reading both migration 0047 and the live staging
 * schema: `buyer_question_versions.approved_by` and
 * `protocols.approved_by` are bare `uuid null` columns with NO foreign
 * key to `auth.users`, `projects.user_id`, or any other table — so
 * there is no "real actor" a synthetic fixture is required to match;
 * the only requirement is a well-formed UUID string.
 *
 * This suite proves:
 *   1. the shared validator rejects every non-UUID shape (email,
 *      malformed UUID, empty string) and accepts every valid UUID;
 *   2. the memory adapter's approveBuyerQuestionVersion AND
 *      approveProtocol reject BEFORE any state mutation — the exact
 *      incident value included;
 *   3. both adapters call the SAME shared validator, as the very first
 *      statement in both approval methods, via static source
 *      inspection (no staging access in this pass).
 *
 * Real in-memory adapter (getDb()), mock LLM mode. No network, no
 * payment, no staging/Production, no migration applied.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import {
  isValidUuid,
  validateApprovedByUuid,
} from "@/lib/db/validate-approved-by-uuid";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const db = getDb();
const memoryAdapterSrc = readFileSync("lib/db/memory-adapter.ts", "utf-8");
const supabaseAdapterSrc = readFileSync("lib/db/supabase-adapter.ts", "utf-8");

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  // 1. the shared validator itself: every invalid shape, every valid one
  // ------------------------------------------------------------------
  console.log("\n[1] shared validator: valid UUIDs pass, every non-UUID shape is rejected");

  check("a real UUID (randomUUID()) is valid", isValidUuid(randomUUID()));
  check(
    "the fixed, explicitly-named synthetic test-actor UUID is valid",
    isValidUuid("11111111-1111-4111-8111-111111111111")
  );
  check(
    "the exact real incident value (an email) is invalid",
    !isValidUuid("staging-smoke-test@zypact.test")
  );
  check("an empty string is invalid", !isValidUuid(""));
  check("a UUID missing a segment is invalid", !isValidUuid("11111111-1111-4111-8111"));
  check(
    "a UUID with a non-hex character is invalid",
    !isValidUuid("1111111z-1111-4111-8111-111111111111")
  );
  check(
    "a UUID with the wrong number of hex digits in a segment is invalid",
    !isValidUuid("111111111-1111-4111-8111-111111111111")
  );

  function throwsFor(approvedBy: string): string | null {
    try {
      validateApprovedByUuid(approvedBy);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  check(
    "validateApprovedByUuid does not throw for a valid UUID",
    throwsFor("11111111-1111-4111-8111-111111111111") === null
  );
  check(
    "validateApprovedByUuid throws with a clear message for the exact incident email",
    throwsFor("staging-smoke-test@zypact.test") ===
      'invalid_approved_by: must be a UUID string, got "staging-smoke-test@zypact.test"'
  );

  // ------------------------------------------------------------------
  // 2. memory adapter: both approval methods reject BEFORE any write
  // ------------------------------------------------------------------
  console.log("\n[2] memory adapter approveBuyerQuestionVersion / approveProtocol reject before any write");

  {
    const project = await db.createProject({
      domain: `approved-by-validation-${randomUUID()}.test`,
      companyName: "Approved-By Validation Test Co",
    });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: project.id,
      versionNumber: 1,
      promptText: "reproduces the exact staging incident's approver value",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 4,
      winnability: 3,
      priority: 1,
      rationale: "regression fixture for the approved_by staging incident",
      provenance: "founder_supplied",
    });

    let threw = false;
    let message = "";
    try {
      await db.approveBuyerQuestionVersion({
        versionId: version.id,
        projectId: project.id,
        approvedBy: "staging-smoke-test@zypact.test", // the real incident value
      });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(
      "approveBuyerQuestionVersion throws on the exact incident email value",
      threw && message === 'invalid_approved_by: must be a UUID string, got "staging-smoke-test@zypact.test"'
    );

    const versionsAfter = await db.getBuyerQuestionVersionsByQuestion(question.id, project.id);
    check(
      "the version remains unapproved after the rejected call — no partial state mutation",
      versionsAfter.length === 1 &&
        versionsAfter[0]!.approvedBy === null &&
        versionsAfter[0]!.approvedAt === null
    );

    // A subsequent, valid call must succeed cleanly.
    const approved = await db.approveBuyerQuestionVersion({
      versionId: version.id,
      projectId: project.id,
      approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    check(
      "a subsequent call with a valid UUID succeeds",
      approved.outcome === "APPROVED" && approved.version?.approvedBy === "11111111-1111-4111-8111-111111111111"
    );

    // approveProtocol carries the identical contract.
    const protocol = await db.createProtocol({
      projectId: project.id,
      buyerQuestionVersionId: version.id,
      provider: "perplexity_sonar",
      surface: "answer",
      plannedBaselineRuns: 1,
      plannedRetestRuns: 0,
      unitOfAnalysis: "buyer_question_version",
      primaryMetric: "presence_rate",
      samplePlanningMethod: "fixed_by_protocol",
      runCap: 5,
      spendCapUsd: 5,
      timeWindowSeconds: 3600,
      rateLimitPerHour: 100,
      concurrencyLimit: 10,
      retryCap: 1,
    });

    let protocolThrew = false;
    try {
      await db.approveProtocol({
        protocolId: protocol.id,
        projectId: project.id,
        approvedBy: "staging-smoke-test@zypact.test",
      });
    } catch {
      protocolThrew = true;
    }
    check("approveProtocol also throws on the exact incident email value", protocolThrew);

    const protocolAfter = await db.getProtocol(protocol.id, project.id);
    check(
      "the protocol remains in draft after the rejected call — no partial state mutation",
      protocolAfter?.status === "draft" &&
        protocolAfter.approvedBy === null &&
        protocolAfter.approvedAt === null
    );
  }

  // ------------------------------------------------------------------
  // 3. both adapters call the SAME shared validator, first, before any
  //    network/state operation — static source verification.
  // ------------------------------------------------------------------
  console.log("\n[3] both adapters enforce the identical shared rule (static source check)");

  for (const [label, methodName, src] of [
    ["memory adapter approveBuyerQuestionVersion", "async approveBuyerQuestionVersion(", memoryAdapterSrc],
    ["memory adapter approveProtocol", "async approveProtocol(", memoryAdapterSrc],
    ["supabase adapter approveBuyerQuestionVersion", "async approveBuyerQuestionVersion(", supabaseAdapterSrc],
    ["supabase adapter approveProtocol", "async approveProtocol(", supabaseAdapterSrc],
  ] as const) {
    const start = src.indexOf(methodName);
    const body = src.slice(start, start + 500);
    const validateIdx = body.indexOf("validateApprovedByUuid(input.approvedBy)");
    const stateOpIdx =
      body.indexOf("getStore()") !== -1
        ? body.indexOf("getStore()")
        : body.indexOf("getClient()");
    check(
      `${label} calls the shared validator BEFORE touching store/network`,
      validateIdx !== -1 && stateOpIdx !== -1 && validateIdx < stateOpIdx
    );
  }

  check(
    "both adapters import the SAME shared validator (no duplicated/re-derived rule)",
    memoryAdapterSrc.includes(
      'import { validateApprovedByUuid } from "@/lib/db/validate-approved-by-uuid";'
    ) &&
      supabaseAdapterSrc.includes(
        'import { validateApprovedByUuid } from "@/lib/db/validate-approved-by-uuid";'
      )
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 approved_by UUID validation suite PASSED."
        : "M4 approved_by UUID validation suite FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
