import { strict as assert } from "node:assert";
import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  readFileSync,
} from "node:fs";

import {
  memoryAdapter,
} from "../lib/db/memory-adapter";

async function createRunningRequest(
  label: string
) {
  const suffix = randomUUID();
  const domain =
    `${label}-${suffix}.example.com`;

  const request =
    await memoryAdapter
      .createSnapshotRequest({
        workEmail:
          `${label}-${suffix}@example.com`,
        normalizedEmail:
          `${label}-${suffix}@example.com`,
        companyName:
          `${label} Test`,
        websiteUrl:
          `https://${domain}`,
        normalizedDomain: domain,
        buyerCategory:
          "B2B SaaS",
        requestIpHash:
          randomBytes(32).toString("hex"),
      });

  const token =
    randomBytes(32).toString("hex");

  await memoryAdapter
    .issueSnapshotRequestVerification({
      requestId: request.id,
      tokenHash: token,
      expiresAt: new Date(
        Date.now() + 30 * 60 * 1000
      ).toISOString(),
    });

  await memoryAdapter
    .consumeSnapshotRequestVerification(
      token
    );

  await memoryAdapter
    .approveAndQueueSnapshotRequest(
      request.id,
      randomUUID()
    );

  const running =
    await memoryAdapter
      .reserveSnapshotRequestProject(
        request.id
      );

  assert.ok(running?.projectId);

  return running!;
}

async function main() {
  const failedCandidate =
    await createRunningRequest(
      "completion-failed"
    );

  const failed =
    await memoryAdapter
      .finalizeSnapshotRequest(
        failedCandidate.id,
        failedCandidate.projectId!,
        "failed"
      );

  assert.equal(
    failed?.status,
    "failed"
  );

  console.log(
    "✓ running requests can finish as failed"
  );

  const repeatedFailure =
    await memoryAdapter
      .finalizeSnapshotRequest(
        failedCandidate.id,
        failedCandidate.projectId!,
        "failed"
      );

  assert.equal(
    repeatedFailure?.status,
    "failed"
  );

  console.log(
    "✓ failed finalization is idempotent"
  );

  const readyCandidate =
    await createRunningRequest(
      "completion-ready"
    );

  const prematureReady =
    await memoryAdapter
      .finalizeSnapshotRequest(
        readyCandidate.id,
        readyCandidate.projectId!,
        "report_ready"
      );

  assert.equal(
    prematureReady,
    null
  );

  console.log(
    "✓ report_ready requires quality_review"
  );

  await memoryAdapter
    .updateSnapshotRequestProgress(
      readyCandidate.id,
      readyCandidate.projectId!,
      "quality_review"
    );

  const ready =
    await memoryAdapter
      .finalizeSnapshotRequest(
        readyCandidate.id,
        readyCandidate.projectId!,
        "report_ready"
      );

  assert.equal(
    ready?.status,
    "report_ready"
  );

  console.log(
    "✓ quality-reviewed requests reach report_ready"
  );

  const repeatedReady =
    await memoryAdapter
      .finalizeSnapshotRequest(
        readyCandidate.id,
        readyCandidate.projectId!,
        "report_ready"
      );

  assert.equal(
    repeatedReady?.status,
    "report_ready"
  );

  console.log(
    "✓ successful finalization is idempotent"
  );

  const downgrade =
    await memoryAdapter
      .finalizeSnapshotRequest(
        readyCandidate.id,
        readyCandidate.projectId!,
        "failed"
      );

  assert.equal(
    downgrade,
    null
  );

  console.log(
    "✓ final states cannot overwrite each other"
  );

  const wrongProjectCandidate =
    await createRunningRequest(
      "completion-project"
    );

  const wrongProject =
    await memoryAdapter
      .finalizeSnapshotRequest(
        wrongProjectCandidate.id,
        randomUUID(),
        "failed"
      );

  assert.equal(
    wrongProject,
    null
  );

  console.log(
    "✓ wrong projects cannot finalize requests"
  );

  const sql = readFileSync(
    "supabase/migrations/0026_snapshot_completion.sql",
    "utf8"
  );

  assert.match(
    sql,
    /progress_stage[\s\S]*quality_review/
  );

  assert.match(
    sql,
    /status <> 'running'/
  );

  assert.match(
    sql,
    /grant execute[\s\S]*to service_role/i
  );

  assert.match(
    sql,
    /revoke all[\s\S]*from anon/i
  );

  console.log(
    "✓ SQL enforces completion transitions and permissions"
  );

  console.log(
    "\n8/8 checks passed. Snapshot completion PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
