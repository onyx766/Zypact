import { strict as assert } from "node:assert";
import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { memoryAdapter } from "../lib/db/memory-adapter";

async function main() {
  const suffix = randomUUID();
  const email =
    `reservation-${suffix}@example.com`;
  const domain =
    `reservation-${suffix}.example.com`;

  const request =
    await memoryAdapter.createSnapshotRequest({
      workEmail: email,
      normalizedEmail: email,
      companyName: "Reservation Test",
      websiteUrl: `https://${domain}`,
      normalizedDomain: domain,
      buyerCategory: "B2B SaaS analytics",
      requestIpHash: `ip-${suffix}`,
    });

  const tokenHash =
    randomBytes(32).toString("hex");

  const issued =
    await memoryAdapter
      .issueSnapshotRequestVerification({
        requestId: request.id,
        tokenHash,
        expiresAt: new Date(
          Date.now() + 30 * 60 * 1000
        ).toISOString(),
      });

  assert.equal(issued, true);

  const verified =
    await memoryAdapter
      .consumeSnapshotRequestVerification(
        tokenHash
      );

  assert.equal(
    verified?.status,
    "pending_approval"
  );

  console.log(
    "✓ verification still waits for approval"
  );

  const approved =
    await memoryAdapter
      .approveAndQueueSnapshotRequest(
        request.id,
        randomUUID()
      );

  assert.equal(approved?.status, "queued");
  assert.equal(approved?.projectId, null);

  console.log(
    "✓ approval queues without creating a project"
  );

  const reserved =
    await memoryAdapter
      .reserveSnapshotRequestProject(
        request.id
      );

  assert.equal(reserved?.status, "running");
  assert.ok(reserved?.projectId);

  console.log(
    "✓ reservation moves queued to running"
  );

  const project =
    await memoryAdapter.getProject(
      reserved!.projectId!
    );

  assert.ok(project);
  assert.equal(
    project?.companyName,
    "Reservation Test"
  );
  assert.equal(project?.domain, domain);
  assert.equal(
    project?.category,
    "B2B SaaS analytics"
  );

  console.log(
    "✓ project uses the approved request data"
  );

  const repeated =
    await memoryAdapter
      .reserveSnapshotRequestProject(
        request.id
      );

  assert.equal(
    repeated?.projectId,
    reserved?.projectId
  );
  assert.equal(repeated?.status, "running");

  console.log(
    "✓ repeated reservation reuses the same project"
  );

  const blockedSuffix = randomUUID();

  const blockedRequest =
    await memoryAdapter.createSnapshotRequest({
      workEmail:
        `blocked-${blockedSuffix}@example.com`,
      normalizedEmail:
        `blocked-${blockedSuffix}@example.com`,
      companyName: "Blocked Test",
      websiteUrl:
        `https://blocked-${blockedSuffix}.example.com`,
      normalizedDomain:
        `blocked-${blockedSuffix}.example.com`,
      buyerCategory: "B2B SaaS",
      requestIpHash:
        `blocked-ip-${blockedSuffix}`,
    });

  const blocked =
    await memoryAdapter
      .reserveSnapshotRequestProject(
        blockedRequest.id
      );

  assert.equal(blocked, null);

  console.log(
    "✓ unapproved requests cannot create projects"
  );

  const sql = readFileSync(
    "supabase/migrations/0024_snapshot_project_reservation.sql",
    "utf8"
  );

  assert.match(sql, /for update/i);
  assert.match(
    sql,
    /insert into public\.projects/i
  );
  assert.match(
    sql,
    /status = 'running'/i
  );

  console.log(
    "✓ SQL reservation locks the request row"
  );

  assert.match(
    sql,
    /grant execute[\s\S]*to service_role/i
  );
  assert.match(
    sql,
    /revoke all[\s\S]*from anon/i
  );
  assert.match(
    sql,
    /revoke all[\s\S]*from authenticated/i
  );

  console.log(
    "✓ reservation RPC is service-role only"
  );

  console.log(
    "\n8/8 checks passed. Snapshot project reservation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
