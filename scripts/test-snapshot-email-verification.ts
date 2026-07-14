import { strict as assert } from "node:assert";
import { getDb } from "../lib/db";
import {
  generateSnapshotEmailVerificationToken,
  hashSnapshotEmailVerificationToken,
} from "../lib/snapshot-requests/email-verification";

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const firstToken =
    generateSnapshotEmailVerificationToken({
      now: new Date("2026-07-14T12:00:00.000Z"),
      ttlMinutes: 30,
    });

  const secondToken =
    generateSnapshotEmailVerificationToken({
      now: new Date("2026-07-14T12:00:00.000Z"),
      ttlMinutes: 30,
    });

  assert.match(firstToken.token, /^[A-Za-z0-9_-]{43}$/);
  console.log("✓ raw token is a 256-bit base64url value");

  assert.match(firstToken.tokenHash, /^[0-9a-f]{64}$/);
  console.log("✓ only a SHA-256-compatible hash is prepared for storage");

  assert.equal(
    hashSnapshotEmailVerificationToken(
      firstToken.token
    ),
    firstToken.tokenHash
  );
  console.log("✓ token hashing is deterministic");

  assert.notEqual(
    firstToken.token,
    firstToken.tokenHash
  );

  assert.notEqual(
    firstToken.token,
    secondToken.token
  );

  console.log("✓ generated raw tokens are unique and differ from hashes");

  assert.equal(
    firstToken.expiresAt,
    "2026-07-14T12:30:00.000Z"
  );
  console.log("✓ expiration is calculated from the configured TTL");

  const db = getDb();
  const stamp = Date.now();

  const request = await db.createSnapshotRequest({
    workEmail: `verify-${stamp}@example.com`,
    normalizedEmail: `verify-${stamp}@example.com`,
    companyName: "Verification Test SaaS",
    websiteUrl: `https://verify-${stamp}.example.com`,
    normalizedDomain: `verify-${stamp}.example.com`,
    buyerCategory: "B2B SaaS",
    requestIpHash: `verify-ip-${stamp}`,
  });

  const liveToken =
    generateSnapshotEmailVerificationToken({
      ttlMinutes: 30,
    });

  const issued =
    await db.issueSnapshotRequestVerification({
      requestId: request.id,
      tokenHash: liveToken.tokenHash,
      expiresAt: liveToken.expiresAt,
    });

  assert.equal(issued, true);
  console.log("✓ token hash is issued for a pending request");

  const wrongTokenResult =
    await db.consumeSnapshotRequestVerification(
      hashSnapshotEmailVerificationToken(
        "wrong-verification-token"
      )
    );

  assert.equal(wrongTokenResult, null);
  console.log("✓ an incorrect token cannot verify the request");

  const verified =
    await db.consumeSnapshotRequestVerification(
      liveToken.tokenHash
    );

  assert.ok(verified);
  assert.equal(verified.status, "pending_approval");
  assert.equal(verified.projectId, null);

  console.log(
    "✓ valid token atomically moves the request to pending_approval"
  );

  const reused =
    await db.consumeSnapshotRequestVerification(
      liveToken.tokenHash
    );

  assert.equal(reused, null);
  console.log("✓ a consumed token cannot be reused");

  const reissued =
    await db.issueSnapshotRequestVerification({
      requestId: request.id,
      tokenHash:
        generateSnapshotEmailVerificationToken()
          .tokenHash,
      expiresAt:
        generateSnapshotEmailVerificationToken()
          .expiresAt,
    });

  assert.equal(reissued, false);
  console.log("✓ a verified request cannot receive another token");

  const expiredRequest =
    await db.createSnapshotRequest({
      workEmail: `expired-${stamp}@example.com`,
      normalizedEmail: `expired-${stamp}@example.com`,
      companyName: "Expired Verification Test",
      websiteUrl: `https://expired-${stamp}.example.com`,
      normalizedDomain: `expired-${stamp}.example.com`,
      buyerCategory: "B2B SaaS",
      requestIpHash: `expired-ip-${stamp}`,
    });

  const expiredIssue =
    await db.issueSnapshotRequestVerification({
      requestId: expiredRequest.id,
      tokenHash:
        generateSnapshotEmailVerificationToken()
          .tokenHash,
      expiresAt: new Date(
        Date.now() - 60_000
      ).toISOString(),
    });

  assert.equal(expiredIssue, false);
  console.log("✓ an already-expired token is not issued");

  console.log(
    "\n11/11 checks passed. Snapshot email verification foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
