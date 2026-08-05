import { strict as assert } from "node:assert";
import { getDb } from "../lib/db";
import { generateSnapshotEmailVerificationToken } from "../lib/snapshot-requests/email-verification";

async function main() {
  delete process.env.VERCEL_ENV;
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ZYPACT_ALLOW_MEMORY_DB;

  process.env.SNAPSHOT_EMAIL_VERIFICATION_ENABLED =
    "false";

  const { POST } = await import(
    "../app/api/snapshot-requests/verify-email/route"
  );

  const makeRequest = (
    body: unknown,
    rawBody?: string
  ) =>
    new Request(
      "http://localhost/api/snapshot-requests/verify-email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body:
          rawBody !== undefined
            ? rawBody
            : JSON.stringify(body),
      }
    );

  const disabled = await POST(
    makeRequest({
      token: "A".repeat(43),
    })
  );

  assert.equal(disabled.status, 503);
  console.log("✓ verification route is closed by default");

  process.env.SNAPSHOT_EMAIL_VERIFICATION_ENABLED =
    "true";

  const invalidJson = await POST(
    makeRequest(null, "{invalid-json")
  );

  assert.equal(invalidJson.status, 400);
  console.log("✓ invalid JSON is rejected generically");

  const malformedToken = await POST(
    makeRequest({
      token: "not-a-valid-token",
    })
  );

  assert.equal(malformedToken.status, 400);
  console.log("✓ malformed token is rejected");

  const db = getDb();
  const stamp = Date.now();

  const request = await db.createSnapshotRequest({
    workEmail: `route-verify-${stamp}@example.com`,
    normalizedEmail:
      `route-verify-${stamp}@example.com`,
    companyName: "Verification Route Test",
    websiteUrl:
      `https://route-verify-${stamp}.example.com`,
    normalizedDomain:
      `route-verify-${stamp}.example.com`,
    buyerCategory: "B2B SaaS",
    requestIpHash: `route-verify-ip-${stamp}`,
  });

  const verification =
    generateSnapshotEmailVerificationToken({
      ttlMinutes: 30,
    });

  const issued =
    await db.issueSnapshotRequestVerification({
      requestId: request.id,
      tokenHash: verification.tokenHash,
      expiresAt: verification.expiresAt,
    });

  assert.equal(issued, true);

  const wrongToken =
    generateSnapshotEmailVerificationToken();

  const wrongResponse = await POST(
    makeRequest({
      token: wrongToken.token,
    })
  );

  assert.equal(wrongResponse.status, 400);
  console.log("✓ incorrect token does not verify the request");

  const validResponse = await POST(
    makeRequest({
      token: verification.token,
    })
  );

  assert.equal(validResponse.status, 200);

  const validJson = (await validResponse.json()) as {
    ok?: boolean;
    status?: string;
    nextStep?: string;
    requestId?: string;
    token?: string;
  };

  assert.equal(validJson.ok, true);
  assert.equal(
    validJson.status,
    "pending_approval"
  );
  assert.equal(
    validJson.nextStep,
    "awaiting_founder_approval"
  );
  assert.equal("requestId" in validJson, false);
  assert.equal("token" in validJson, false);

  assert.match(
    validResponse.headers.get("cache-control") || "",
    /no-store/
  );

  console.log(
    "✓ valid token verifies without exposing request ID or token"
  );

  const reusedResponse = await POST(
    makeRequest({
      token: verification.token,
    })
  );

  assert.equal(reusedResponse.status, 400);

  const reusedJson =
    (await reusedResponse.json()) as {
      code?: string;
    };

  assert.equal(
    reusedJson.code,
    "invalid_verification_link"
  );

  console.log("✓ consumed token cannot be reused");

  const oversizedResponse = await POST(
    new Request(
      "http://localhost/api/snapshot-requests/verify-email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2048",
        },
        body: JSON.stringify({
          token: "A".repeat(43),
        }),
      }
    )
  );

  assert.equal(oversizedResponse.status, 413);
  console.log("✓ oversized body is rejected");

  console.log(
    "\n7/7 checks passed. Email verification route PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
