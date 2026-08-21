#!/usr/bin/env tsx
/**
 * M4 — buyer_question_versions numeric-field validation.
 *
 * Regression test for a real staging incident: a `commercialValue:
 * 0.7, winnability: 0.5` fixture reached Postgres and was rejected by
 * the `commercial_value integer`/`winnability integer` columns (error
 * 22P02) — but only AFTER a `dataset_batches` row and a
 * `buyer_questions` row had already been created by the same script,
 * leaving two orphaned residue rows on the staging synthetic project
 * (dataset_batches id 3d62b8d6-0d47-411f-a506-b551147ec1b4,
 * buyer_questions id 49261f56-3a66-4a7f-813b-4666d2743a95 — known,
 * harmless, deliberately left in place, never backfilled or cleaned up
 * per explicit instruction).
 *
 * Canonical contract (migration 0047, unchanged):
 *   - commercialValue: integer, 1..5
 *   - winnability: integer, 1..5
 *   - priority: integer, 1..25
 *
 * This suite proves:
 *   1. the shared validator rejects every invalid shape (float,
 *      out-of-range, non-finite) and accepts every valid one;
 *   2. the memory adapter's createBuyerQuestionVersion rejects BEFORE
 *      any row is written — the exact 0.7/0.5 incident values included;
 *   3. both adapters call the SAME shared validator, as the very first
 *      statement in createBuyerQuestionVersion, via static source
 *      inspection (the Supabase adapter cannot be exercised live here
 *      — no staging access in this pass).
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
import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";

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
  console.log("\n[1] shared validator: valid inputs pass, every invalid shape is rejected");

  const valid = { commercialValue: 4, winnability: 3, priority: 5 };
  let validThrew = false;
  try {
    validateBuyerQuestionVersionNumericFields(valid);
  } catch {
    validThrew = true;
  }
  check("a fully valid input (4, 3, 5) does not throw", !validThrew);

  function throwsFor(fields: { commercialValue: number; winnability: number; priority: number }): string | null {
    try {
      validateBuyerQuestionVersionNumericFields(fields);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  check(
    "the exact real incident values (commercialValue: 0.7, winnability: 0.5, priority: 1) are rejected — commercialValue checked first",
    throwsFor({ commercialValue: 0.7, winnability: 0.5, priority: 1 }) === "invalid_commercial_value: must be an integer 1..5, got 0.7"
  );
  check(
    "a float winnability (commercialValue valid, winnability: 0.5) is rejected",
    throwsFor({ commercialValue: 4, winnability: 0.5, priority: 1 })?.startsWith("invalid_winnability") ?? false
  );
  check(
    "a float priority (commercialValue/winnability valid, priority: 2.5) is rejected",
    throwsFor({ commercialValue: 4, winnability: 3, priority: 2.5 })?.startsWith("invalid_priority") ?? false
  );
  check(
    "commercialValue = 0 (below 1..5) is rejected",
    throwsFor({ commercialValue: 0, winnability: 3, priority: 1 })?.startsWith("invalid_commercial_value") ?? false
  );
  check(
    "commercialValue = 6 (above 1..5) is rejected",
    throwsFor({ commercialValue: 6, winnability: 3, priority: 1 })?.startsWith("invalid_commercial_value") ?? false
  );
  check(
    "winnability = 1 (exact lower bound) is accepted",
    throwsFor({ commercialValue: 4, winnability: 1, priority: 1 }) === null
  );
  check(
    "winnability = 5 (exact upper bound) is accepted",
    throwsFor({ commercialValue: 4, winnability: 5, priority: 1 }) === null
  );
  check(
    "winnability = 0 (below 1..5) is rejected",
    throwsFor({ commercialValue: 4, winnability: 0, priority: 1 })?.startsWith("invalid_winnability") ?? false
  );
  check(
    "winnability = 6 (above 1..5) is rejected",
    throwsFor({ commercialValue: 4, winnability: 6, priority: 1 })?.startsWith("invalid_winnability") ?? false
  );
  check(
    "winnability = 25 is rejected — this is priority's upper bound, NOT winnability's; a bound mix-up bug would wrongly accept this",
    throwsFor({ commercialValue: 4, winnability: 25, priority: 1 })?.startsWith("invalid_winnability") ?? false
  );
  check(
    "priority = 0 (below 1..25) is rejected",
    throwsFor({ commercialValue: 4, winnability: 3, priority: 0 })?.startsWith("invalid_priority") ?? false
  );
  check(
    "priority = 26 (above 1..25) is rejected",
    throwsFor({ commercialValue: 4, winnability: 3, priority: 26 })?.startsWith("invalid_priority") ?? false
  );
  check(
    "priority = 25 (exact upper bound) is accepted",
    throwsFor({ commercialValue: 4, winnability: 3, priority: 25 }) === null
  );
  check(
    "priority = 1 (exact lower bound) is accepted",
    throwsFor({ commercialValue: 4, winnability: 3, priority: 1 }) === null
  );
  check(
    "NaN is rejected, never silently coerced",
    throwsFor({ commercialValue: Number.NaN, winnability: 3, priority: 1 })?.startsWith("invalid_commercial_value") ?? false
  );
  check(
    "a negative integer is rejected",
    throwsFor({ commercialValue: -1, winnability: 3, priority: 1 })?.startsWith("invalid_commercial_value") ?? false
  );

  // ------------------------------------------------------------------
  // 2. memory adapter: rejects BEFORE any row is written
  // ------------------------------------------------------------------
  console.log("\n[2] memory adapter createBuyerQuestionVersion rejects before any write");

  {
    const project = await db.createProject({
      domain: `numeric-validation-${randomUUID()}.test`,
      companyName: "Numeric Validation Test Co",
    });
    const question = await db.createBuyerQuestion({ projectId: project.id });

    let threw = false;
    let message = "";
    try {
      await db.createBuyerQuestionVersion({
        buyerQuestionId: question.id,
        projectId: project.id,
        versionNumber: 1,
        promptText: "reproduces the exact staging incident",
        promptHash: `hash-${randomUUID()}`,
        intentType: "shortlist",
        commercialValue: 0.7, // the real incident value
        winnability: 0.5, // the real incident value
        priority: 1,
        rationale: "regression fixture for the staging incident",
        provenance: "founder_supplied",
      });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check(
      "createBuyerQuestionVersion throws on the exact incident values (0.7 / 0.5)",
      threw && message === "invalid_commercial_value: must be an integer 1..5, got 0.7"
    );

    const versionsAfter = await db.getBuyerQuestionVersionsByQuestion(question.id, project.id);
    check(
      "zero buyer_question_versions rows exist after the rejected call — no partial write",
      versionsAfter.length === 0
    );

    // A second, valid call on the SAME question must succeed cleanly —
    // proving the rejection is a real validation gate, not a broken
    // adapter that always throws.
    const valid = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: project.id,
      versionNumber: 1,
      promptText: "valid replacement fixture",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 4,
      winnability: 3,
      priority: 5,
      rationale: "valid integer fixture, matches the corrected staging plan",
      provenance: "founder_supplied",
    });
    check(
      "a subsequent call with valid integers (4, 3, 5) on the same question succeeds",
      valid.commercialValue === 4 && valid.winnability === 3 && valid.priority === 5
    );

    // ------------------------------------------------------------------
    // 3. both adapters call the SAME shared validator, first, before any
    //    network/state operation — static source verification (no live
    //    staging access in this pass).
    // ------------------------------------------------------------------
    console.log("\n[3] both adapters enforce the identical shared rule (static source check)");

    const memFnStart = memoryAdapterSrc.indexOf("async createBuyerQuestionVersion(");
    const memFnBody = memoryAdapterSrc.slice(memFnStart, memFnStart + 600);
    check(
      "memory adapter imports the shared validator",
      memoryAdapterSrc.includes(
        'import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";'
      )
    );
    check(
      "memory adapter's createBuyerQuestionVersion calls the shared validator BEFORE touching the store (getStore()/store.buyerQuestions)",
      (() => {
        const validateIdx = memFnBody.indexOf("validateBuyerQuestionVersionNumericFields(input)");
        const storeIdx = memFnBody.indexOf("getStore()");
        return validateIdx !== -1 && storeIdx !== -1 && validateIdx < storeIdx;
      })()
    );

    const supFnStart = supabaseAdapterSrc.indexOf("async createBuyerQuestionVersion(");
    const supFnBody = supabaseAdapterSrc.slice(supFnStart, supFnStart + 600);
    check(
      "supabase adapter imports the SAME shared validator (no duplicated/re-derived rule)",
      supabaseAdapterSrc.includes(
        'import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";'
      )
    );
    check(
      "supabase adapter's createBuyerQuestionVersion calls the shared validator BEFORE any network call (getClient())",
      (() => {
        const validateIdx = supFnBody.indexOf("validateBuyerQuestionVersionNumericFields(input)");
        const clientIdx = supFnBody.indexOf("getClient()");
        return validateIdx !== -1 && clientIdx !== -1 && validateIdx < clientIdx;
      })()
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 numeric-field validation suite PASSED."
        : "M4 numeric-field validation suite FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
