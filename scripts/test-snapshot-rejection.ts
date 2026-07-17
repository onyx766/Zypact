import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  memoryAdapter,
} from "../lib/db/memory-adapter";

async function main(): Promise<void> {
  const suffix = randomUUID();

  const request =
    await memoryAdapter
      .createSnapshotRequest({
        workEmail:
          `reject-${suffix}@example.com`,
        normalizedEmail:
          `reject-${suffix}@example.com`,
        companyName:
          "Reject Test",
        websiteUrl:
          `https://reject-${suffix}.example.com`,
        normalizedDomain:
          `reject-${suffix}.example.com`,
        buyerCategory:
          "B2B SaaS testing",
        requestIpHash: null,
      });

  const tokenHash = randomUUID();

  const issued =
    await memoryAdapter
      .issueSnapshotRequestVerification({
        requestId: request.id,
        tokenHash,
        expiresAt:
          new Date(
            Date.now() +
              60 * 60 * 1000
          ).toISOString(),
      });

  assert.equal(issued, true);

  const verified =
    await memoryAdapter
      .consumeSnapshotRequestVerification(
        tokenHash
      );

  assert.ok(verified);

  assert.equal(
    verified.status,
    "pending_approval"
  );

  const rejected =
    await memoryAdapter
      .rejectSnapshotRequest(
        request.id
      );

  assert.ok(rejected);

  assert.equal(
    rejected.status,
    "rejected"
  );

  const stored =
    await memoryAdapter
      .getSnapshotRequest(
        request.id
      );

  assert.equal(
    stored?.status,
    "rejected"
  );

  const repeated =
    await memoryAdapter
      .rejectSnapshotRequest(
        request.id
      );

  assert.equal(repeated, null);

  console.log(
    "✓ pending snapshot request can be rejected once"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
