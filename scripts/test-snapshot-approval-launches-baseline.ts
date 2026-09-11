#!/usr/bin/env tsx
/**
 * Migration 0062 — founder approval launches the canonical M4/M5
 * baseline, in one atomic operation, instead of the legacy status flip.
 *
 * Behavioral tests run against the in-memory adapter, which mirrors
 * `approve_and_launch_snapshot_baseline` exactly (see memory-adapter.ts).
 * Live migration/RPC behavior is not covered here — that needs a real
 * database. No network, no provider, no worker process.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.ZYPACT_ALLOW_MEMORY_DB = "1";

import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAdapter } from "../lib/db/memory-adapter";

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

async function makePendingApprovalRequest(overrides: {
  companyName?: string;
  buyerCategory?: string;
} = {}) {
  const suffix = randomUUID();
  const email = `baseline-${suffix}@example.com`;
  const domain = `baseline-${suffix}.example.com`;

  const request = await memoryAdapter.createSnapshotRequest({
    workEmail: email,
    normalizedEmail: email,
    companyName: overrides.companyName ?? "Baseline Launch Co",
    websiteUrl: `https://${domain}`,
    normalizedDomain: domain,
    buyerCategory:
      overrides.buyerCategory ??
      "best invoicing software for a 20-person agency",
    requestIpHash: `ip-${suffix}`,
  });

  const tokenHash = randomUUID();
  await memoryAdapter.issueSnapshotRequestVerification({
    requestId: request.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
  const verified =
    await memoryAdapter.consumeSnapshotRequestVerification(tokenHash);
  assert.equal(verified?.status, "pending_approval");

  return (await memoryAdapter.getSnapshotRequest(request.id))!;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  // ── 1. The golden path ────────────────────────────────────────────
  const request = await makePendingApprovalRequest();
  const founderId = randomUUID();
  const promptHash = hashOf(request.buyerCategory);

  const approved = await memoryAdapter.approveAndLaunchSnapshotBaseline(
    request.id,
    founderId,
    ["Alpha Analytics", "Beta Insights"],
    promptHash
  );

  check("1. approval succeeds", approved !== null);
  check("2. terminal status is 'approved', not 'queued'", approved?.status === "approved");
  check("3. a project was created", typeof approved?.projectId === "string");
  check("4. a protocol id is stamped on the request", typeof approved?.protocolId === "string");
  check(
    "5. approvedBy/approvedAt are set",
    approved?.approvedBy === founderId && approved?.approvedAt !== null
  );
  check(
    "6. competitors are stored, normalized",
    JSON.stringify(approved?.competitors) ===
      JSON.stringify(["Alpha Analytics", "Beta Insights"])
  );

  const projectId = approved!.projectId!;
  const protocolId = approved!.protocolId!;

  const protocol = await memoryAdapter.getProtocol(protocolId, projectId);
  check("7. the protocol exists and is approved", protocol?.status === "approved");
  check(
    "8. the protocol carries a real bounded sample plan, not zero/unbounded",
    protocol!.plannedBaselineRuns > 0 &&
      protocol!.plannedRetestRuns === 0 &&
      protocol!.runCap >= protocol!.plannedBaselineRuns &&
      protocol!.spendCapUsd > 0 &&
      protocol!.concurrencyLimit > 0
  );
  check(
    "8a. a new baseline plans 5 runs (D-032 / migration 0069), not the old 3",
    protocol!.plannedBaselineRuns === 5
  );
  check(
    "8b. run_cap keeps retry headroom above the plan (7 = 5 planned + 2)",
    protocol!.runCap === 7 &&
      protocol!.runCap - protocol!.plannedBaselineRuns === protocol!.retryCap
  );
  check(
    "8c. spend cap covers every run_cap attempt at the worker's default reservations",
    protocol!.runCap * (0.02 + 0.02) <= protocol!.spendCapUsd
  );
  check("9. the protocol's approver is the founder", protocol?.approvedBy === founderId);

  const version = await memoryAdapter.getBuyerQuestionVersion(
    protocol!.buyerQuestionVersionId,
    projectId
  );
  check("10. the buyer_question_version exists and is approved", version?.approvedAt !== null);
  check(
    "11. the question text is exactly the requester's buyer question",
    version?.promptText === request.buyerCategory
  );
  check("12. prompt_hash is exactly the caller-supplied hash", version?.promptHash === promptHash);
  check("13. provenance is customer_supplied", version?.provenance === "customer_supplied");

  // Baseline job readiness: enqueue_protocol_execution_job is idempotent
  // per protocol, so calling it again must report the job the approval
  // itself already created — never a second one.
  const reEnqueue = await memoryAdapter.enqueueProtocolExecutionJob({
    protocolId,
    projectId,
  });
  check(
    "14. approval already enqueued exactly one baseline job",
    reEnqueue.outcome === "ALREADY_EXISTS" && reEnqueue.job !== null
  );
  check("15. the job is queued, ready for the existing worker to claim", reEnqueue.job?.status === "queued");
  check(
    "16. the job's max_attempts matches the worker-recovery default",
    reEnqueue.job?.maxAttempts === 3
  );

  const firstJobId = reEnqueue.job!.id;

  // ── 2. Legacy worker cannot claim this request ──────────────────────
  const claim = await memoryAdapter.claimNextSnapshotRequest({
    workerId: "regression-worker",
    leaseSeconds: 300,
    maxAttempts: 3,
  });
  check(
    "17. the legacy claim path never selects a request approved this way",
    claim === null || claim.id !== request.id
  );

  // ── 3. Idempotent replay: no duplicate question/protocol/job ────────
  const replay = await memoryAdapter.approveAndLaunchSnapshotBaseline(
    request.id,
    founderId,
    ["Alpha Analytics", "Beta Insights"],
    promptHash
  );
  check(
    "18. a second approval call replays the same protocol, not a new one",
    replay?.protocolId === protocolId
  );
  const reEnqueueAfterReplay = await memoryAdapter.enqueueProtocolExecutionJob({
    protocolId,
    projectId,
  });
  check(
    "19. replay still resolves to exactly the one job created originally",
    reEnqueueAfterReplay.outcome === "ALREADY_EXISTS" &&
      reEnqueueAfterReplay.job?.id === firstJobId
  );

  // ── 4. Validation is still enforced (same rules as the legacy path) ──
  const tooFewCompetitors = await makePendingApprovalRequest();
  const rejectedTooFew = await memoryAdapter.approveAndLaunchSnapshotBaseline(
    tooFewCompetitors.id,
    randomUUID(),
    ["Only One"],
    hashOf(tooFewCompetitors.buyerCategory)
  );
  check("20. fewer than 2 competitors is refused", rejectedTooFew === null);
  check(
    "21. a refused approval creates no protocol/project side effect",
    (await memoryAdapter.getSnapshotRequest(tooFewCompetitors.id))?.status ===
      "pending_approval"
  );

  const selfCompetitor = await makePendingApprovalRequest({
    companyName: "Northwind Analytics",
  });
  const rejectedSelf = await memoryAdapter.approveAndLaunchSnapshotBaseline(
    selfCompetitor.id,
    randomUUID(),
    ["Northwind Analytics", "Beta Insights"],
    hashOf(selfCompetitor.buyerCategory)
  );
  check("22. a self-referencing competitor is refused", rejectedSelf === null);

  const emptyHash = await makePendingApprovalRequest();
  const rejectedEmptyHash = await memoryAdapter.approveAndLaunchSnapshotBaseline(
    emptyHash.id,
    randomUUID(),
    ["Alpha Analytics", "Beta Insights"],
    ""
  );
  check("23. an empty prompt hash is refused", rejectedEmptyHash === null);

  // ── 5. Migration 0062 (static inspection, no database) ───────────────
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/0062_snapshot_approval_launches_protocol_baseline.sql"
    ),
    "utf-8"
  );

  check(
    "24. adds a nullable protocol_id column, not a required one",
    /add column if not exists protocol_id uuid null/.test(migration)
  );
  check(
    "25. defines the new function with the caller-supplied prompt hash",
    /function\s+public\.approve_and_launch_snapshot_baseline\(\s*p_request_id uuid,\s*p_approved_by uuid,\s*p_competitors jsonb,\s*p_prompt_hash text/.test(
      migration
    )
  );
  check(
    "26. does not modify approve_and_queue_snapshot_request (0034) at all",
    !/create or replace function\s+public\.approve_and_queue_snapshot_request/.test(
      migration
    )
  );
  check(
    "27. is SECURITY DEFINER with a pinned search_path",
    /security definer/.test(migration) && /set search_path = public, pg_temp/.test(migration)
  );
  check(
    "28. revokes execution from public, anon, and authenticated",
    /from public;\s*revoke all on function\s+public\.approve_and_launch_snapshot_baseline\(uuid, uuid, jsonb, text\)\s*from anon;\s*revoke all on function\s+public\.approve_and_launch_snapshot_baseline\(uuid, uuid, jsonb, text\)\s*from authenticated;/.test(
      migration
    )
  );
  check(
    "29. grants execution to service_role only",
    /grant execute on function\s+public\.approve_and_launch_snapshot_baseline\(uuid, uuid, jsonb, text\)\s*to service_role;/.test(
      migration
    )
  );
  check(
    "30. reuses the existing competitor normalizer rather than reimplementing it",
    /public\._normalize_snapshot_competitors\(p_competitors\)/.test(migration)
  );
  check(
    "31. reuses the existing project helper rather than a new insert",
    /public\._ensure_snapshot_request_project\(p_request_id\)/.test(migration)
  );
  check(
    "32. approves the version through the existing RPC, not a raw UPDATE",
    /public\.approve_buyer_question_version\(v_version_id, v_project_id, p_approved_by\)/.test(
      migration
    )
  );
  check(
    "33. approves the protocol through the existing RPC, not a raw UPDATE",
    /public\.approve_protocol\(v_protocol_id, v_project_id, p_approved_by\)/.test(migration)
  );
  check(
    "34. enqueues through the existing M5 RPC, not a raw INSERT into protocol_execution_jobs",
    /public\.enqueue_protocol_execution_job\(v_protocol_id, v_project_id\)/.test(migration) &&
      !/insert into public\.protocol_execution_jobs/.test(migration)
  );
  check(
    "35. lands the request on 'approved', never 'queued'",
    /\n\s+status = 'approved',/.test(migration) && !/\n\s+status = 'queued',/.test(migration)
  );
  check(
    "36. has an idempotent-replay branch before any mutation",
    /if v_request\.status = 'approved'\s*and v_request\.protocol_id is not null then/.test(
      migration
    )
  );

  // ── 6. Migration 0069 (static inspection, no database) ───────────────
  // Raises the default for NEW baselines only. Every existing protocol —
  // started, completed, or approved-but-queued — must keep its frozen plan,
  // so the migration may redefine the function but never touch a row.
  const migration0069 = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/0069_new_baseline_default_five_runs.sql"
    ),
    "utf-8"
  );
  const sql0069 = migration0069
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  check(
    "37. 0069 redefines the launch function with the same signature",
    /create or replace function\s+public\.approve_and_launch_snapshot_baseline\(\s*p_request_id uuid,\s*p_approved_by uuid,\s*p_competitors jsonb,\s*p_prompt_hash text/.test(
      sql0069
    )
  );
  check(
    "38. 0069 inserts planned_baseline_runs = 5, planned_retest_runs = 0",
    /jsonb_build_object\('model', 'sonar'\),\s*5, 0,/.test(sql0069)
  );
  check(
    "39. 0069 inserts run_cap = 7 with spend cap 2 and retry_cap 2 unchanged",
    /\n\s*7, 2, 86400,\s*\n\s*10, 1, 2,/.test(sql0069)
  );
  check(
    "40. 0069 never updates, deletes or backfills an existing protocol",
    !/update\s+public\.protocols/i.test(sql0069) &&
      !/delete\s+from\s+public\.protocols/i.test(sql0069) &&
      !/alter\s+table\s+public\.protocols/i.test(sql0069)
  );
  check(
    "41. 0069 keeps the idempotent-replay branch, so a re-click never swaps an old protocol",
    /if v_request\.status = 'approved'\s*and v_request\.protocol_id is not null then/.test(
      sql0069
    )
  );
  check(
    "42. 0069 keeps the service_role-only ACL",
    /grant execute on function\s+public\.approve_and_launch_snapshot_baseline\(uuid, uuid, jsonb, text\)\s*to service_role;/.test(
      sql0069
    ) &&
      /revoke all on function\s+public\.approve_and_launch_snapshot_baseline\(uuid, uuid, jsonb, text\)\s*from authenticated;/.test(
        sql0069
      )
  );

  console.log(
    "\n─────────────────────────────────────────────────────────"
  );
  console.log(
    "Founder approval now creates and approves the buyer_question_version"
  );
  console.log(
    "and protocol, and enqueues exactly one protocol_execution_jobs"
  );
  console.log(
    "baseline job — the legacy 5x3 unapproved worker path is never"
  );
  console.log("reached for a request approved this way.");
  console.log(
    "─────────────────────────────────────────────────────────\n"
  );

  console.log(`${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log(`${failures} FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
