import { strict as assert } from "node:assert";
import {
  normalizeSnapshotVerificationToken,
  verifySnapshotEmailLink,
} from "../lib/snapshot-requests/verification-ui";

async function main() {
  const token = "A".repeat(43);

  assert.equal(
    normalizeSnapshotVerificationToken(
      `  ${token}  `
    ),
    token
  );

  assert.equal(
    normalizeSnapshotVerificationToken(
      "invalid-token"
    ),
    null
  );

  console.log(
    "✓ verification tokens are normalized and validated"
  );

  let invalidFetchCalls = 0;

  const invalidFetch = (async () => {
    invalidFetchCalls += 1;
    throw new Error("fetch should not run");
  }) as typeof fetch;

  const invalid =
    await verifySnapshotEmailLink(
      "invalid-token",
      invalidFetch
    );

  assert.deepEqual(invalid, {
    ok: false,
    reason: "invalid_link",
  });

  assert.equal(invalidFetchCalls, 0);

  console.log(
    "✓ malformed tokens are rejected before any request"
  );

  let capturedMethod = "";
  let capturedCache = "";
  let capturedBody: Record<string, unknown> = {};

  const successFetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => {
    assert.equal(
      input,
      "/api/snapshot-requests/verify-email"
    );

    capturedMethod = init?.method || "";
    capturedCache = String(init?.cache || "");

    capturedBody = JSON.parse(
      String(init?.body || "{}")
    ) as Record<string, unknown>;

    return new Response(
      JSON.stringify({
        ok: true,
        status: "pending_approval",
        nextStep:
          "awaiting_founder_approval",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }
    );
  }) as typeof fetch;

  const success =
    await verifySnapshotEmailLink(
      token,
      successFetch
    );

  assert.equal(capturedMethod, "POST");
  assert.equal(capturedCache, "no-store");
  assert.deepEqual(capturedBody, {
    token,
  });

  console.log(
    "✓ verification uses a no-store POST request"
  );

  assert.deepEqual(success, {
    ok: true,
    status: "pending_approval",
    nextStep:
      "awaiting_founder_approval",
  });

  assert.equal("token" in success, false);
  assert.equal("requestId" in success, false);

  console.log(
    "✓ successful UI result exposes no token or request ID"
  );

  const invalidLink =
    await verifySnapshotEmailLink(
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
          }),
          { status: 400 }
        )) as typeof fetch
    );

  assert.deepEqual(invalidLink, {
    ok: false,
    reason: "invalid_link",
  });

  console.log(
    "✓ expired or reused links receive the generic invalid state"
  );

  const unavailable =
    await verifySnapshotEmailLink(
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
          }),
          { status: 503 }
        )) as typeof fetch
    );

  assert.deepEqual(unavailable, {
    ok: false,
    reason: "unavailable",
  });

  console.log(
    "✓ disabled verification receives an unavailable state"
  );

  const failed =
    await verifySnapshotEmailLink(
      token,
      (async () => {
        throw new Error(
          "simulated connection failure"
        );
      }) as typeof fetch
    );

  assert.deepEqual(failed, {
    ok: false,
    reason: "request_failed",
  });

  console.log(
    "✓ network failures receive a safe generic state"
  );

  console.log(
    "\n7/7 checks passed. Snapshot verification page foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
