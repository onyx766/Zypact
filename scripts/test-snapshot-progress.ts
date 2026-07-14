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

async function main() {
  const suffix = randomUUID();

  const request =
    await memoryAdapter.createSnapshotRequest({
      workEmail:
        `progress-${suffix}@example.com`,
      normalizedEmail:
        `progress-${suffix}@example.com`,
      companyName: "Progress Test",
      websiteUrl:
        `https://progress-${suffix}.example.com`,
      normalizedDomain:
        `progress-${suffix}.example.com`,
      buyerCategory: "B2B SaaS",
      requestIpHash:
        randomBytes(32).toString("hex"),
    });

  assert.equal(request.progressStage, null);
  console.log("✓ new requests have no fake progress");

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

  const reserved =
    await memoryAdapter
      .reserveSnapshotRequestProject(
        request.id
      );

  assert.equal(
    reserved?.progressStage,
    "reserved"
  );

  assert.ok(
    reserved?.progressUpdatedAt
  );

  console.log("✓ reservation records reserved");

  const projectId =
    reserved!.projectId!;

  const crawling =
    await memoryAdapter
      .updateSnapshotRequestProgress(
        request.id,
        projectId,
        "crawling"
      );

  assert.equal(
    crawling?.progressStage,
    "crawling"
  );

  console.log("✓ progress advances to crawling");

  const analyzing =
    await memoryAdapter
      .updateSnapshotRequestProgress(
        request.id,
        projectId,
        "analyzing_site"
      );

  assert.equal(
    analyzing?.progressStage,
    "analyzing_site"
  );

  console.log("✓ progress advances to analyzing_site");

  const backwards =
    await memoryAdapter
      .updateSnapshotRequestProgress(
        request.id,
        projectId,
        "crawling"
      );

  assert.equal(backwards, null);

  console.log("✓ progress cannot move backwards");

  const repeated =
    await memoryAdapter
      .updateSnapshotRequestProgress(
        request.id,
        projectId,
        "analyzing_site"
      );

  assert.equal(
    repeated?.progressStage,
    "analyzing_site"
  );

  console.log("✓ repeated progress is idempotent");

  const wrongProject =
    await memoryAdapter
      .updateSnapshotRequestProgress(
        request.id,
        randomUUID(),
        "generating_questions"
      );

  assert.equal(wrongProject, null);

  console.log("✓ wrong projects cannot update progress");

  const sql = readFileSync(
    "supabase/migrations/0025_snapshot_progress.sql",
    "utf8"
  );

  assert.match(
    sql,
    /v_new_rank < v_current_rank/
  );

  assert.match(
    sql,
    /progress_stage = 'reserved'/
  );

  console.log("✓ SQL enforces monotone progress");

  assert.match(
    sql,
    /grant execute[\s\S]*to service_role/i
  );

  assert.match(
    sql,
    /revoke all[\s\S]*from anon/i
  );

  console.log("✓ progress RPC is service-role only");

  console.log(
    "\n8/8 checks passed. Snapshot progress PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
