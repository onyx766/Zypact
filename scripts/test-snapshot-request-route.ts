import { strict as assert } from "node:assert";
import {
  hashRequestIp,
  normalizeSnapshotRequestInput,
  parseSnapshotRequestSubmission,
  SnapshotRequestValidationError,
} from "../lib/snapshot-requests/normalize-request";

type MockMode =
  | "success"
  | "failed"
  | "wrong_action";

async function main() {
  const normalized = normalizeSnapshotRequestInput({
    workEmail: " Founder@Example.com ",
    companyName: " Example SaaS ",
    websiteUrl:
      "WWW.Example.com/pricing?source=test#section",
    buyerCategory: " B2B SaaS software ",
  });

  assert.equal(
    normalized.workEmail,
    "Founder@Example.com"
  );
  console.log("✓ original trimmed email is preserved");

  assert.equal(
    normalized.normalizedEmail,
    "founder@example.com"
  );
  console.log("✓ email is normalized");

  assert.equal(normalized.normalizedDomain, "example.com");
  console.log("✓ domain is normalized and www is removed");

  assert.equal(
    normalized.websiteUrl,
    "https://www.example.com"
  );
  console.log("✓ website is reduced to a safe origin");

  assert.throws(
    () =>
      normalizeSnapshotRequestInput({
        workEmail: "founder@example.com",
        companyName: "Example",
        websiteUrl: "http://localhost:3000",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log("✓ localhost websites are rejected");

  assert.throws(
    () =>
      normalizeSnapshotRequestInput({
        workEmail: "founder@example.com",
        companyName: "Example",
        websiteUrl: "http://127.0.0.1",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log("✓ IP-address websites are rejected");

  const secret =
    "test-secret-that-is-at-least-32-characters";
  const hashA = hashRequestIp("203.0.113.10", secret);
  const hashB = hashRequestIp("203.0.113.10", secret);

  assert.equal(hashA, hashB);
  console.log("✓ IP hashing is deterministic");

  assert.notEqual(hashA, "203.0.113.10");
  console.log("✓ raw IP is not stored as the hash");

  assert.throws(
    () =>
      parseSnapshotRequestSubmission({
        workEmail: "founder@example.com",
        companyName: "Example SaaS",
        websiteUrl: "https://example.com",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log("✓ Turnstile token is required");

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;

  process.env.SNAPSHOT_REQUESTS_ENABLED = "false";
  process.env.SNAPSHOT_IP_HASH_SECRET = secret;

  const { POST } = await import(
    "../app/api/snapshot-requests/route"
  );

  const makeRequest = (
    body: Record<string, unknown>
  ): Request =>
    new Request(
      "http://localhost/api/snapshot-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for":
            "203.0.113.10, 10.0.0.1",
        },
        body: JSON.stringify(body),
      }
    );

  const validBody = {
    workEmail: "Founder@Example.com",
    companyName: "Example SaaS",
    websiteUrl: "example.com/pricing",
    buyerCategory: "B2B SaaS software",
    turnstileToken: "mock-turnstile-token",
  };

  const disabledResponse = await POST(
    makeRequest(validBody)
  );

  assert.equal(disabledResponse.status, 503);
  console.log("✓ route is closed by default");

  process.env.SNAPSHOT_REQUESTS_ENABLED = "true";

  const missingConfigurationResponse = await POST(
    makeRequest(validBody)
  );

  assert.equal(
    missingConfigurationResponse.status,
    503
  );
  console.log(
    "✓ route fails closed without Turnstile secret"
  );

  process.env.TURNSTILE_SECRET_KEY =
    "test-turnstile-secret";
  process.env.TURNSTILE_EXPECTED_HOSTNAME =
    "zypact.com";

  const originalFetch = globalThis.fetch;
  let mode: MockMode = "success";
  let fetchCalls = 0;
  let lastUrl = "";
  let lastPayload: Record<string, unknown> = {};

  globalThis.fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => {
    fetchCalls += 1;
    lastUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    lastPayload = JSON.parse(
      String(init?.body || "{}")
    ) as Record<string, unknown>;

    if (mode === "failed") {
      return new Response(
        JSON.stringify({
          success: false,
          "error-codes": [
            "invalid-input-response",
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        hostname: "zypact.com",
        action:
          mode === "wrong_action"
            ? "different_action"
            : "snapshot_request",
        "error-codes": [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }
    );
  }) as typeof fetch;

  try {
    const callsBeforeInvalid = fetchCalls;

    const invalidResponse = await POST(
      makeRequest({
        ...validBody,
        workEmail: "not-an-email",
        companyName: "X",
      })
    );

    assert.equal(invalidResponse.status, 400);
    assert.equal(fetchCalls, callsBeforeInvalid);
    console.log(
      "✓ invalid fields are rejected before Turnstile"
    );

    mode = "failed";

    const failedChallengeResponse = await POST(
      makeRequest(validBody)
    );

    assert.equal(
      failedChallengeResponse.status,
      400
    );
    console.log(
      "✓ failed Turnstile challenge is rejected"
    );

    mode = "wrong_action";

    const wrongActionResponse = await POST(
      makeRequest(validBody)
    );

    assert.equal(wrongActionResponse.status, 400);
    console.log(
      "✓ unexpected Turnstile action is rejected"
    );

    mode = "success";

    const validResponse = await POST(
      makeRequest(validBody)
    );

    assert.equal(validResponse.status, 201);

    assert.equal(
      lastUrl,
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    );

    assert.equal(
      lastPayload.response,
      "mock-turnstile-token"
    );

    assert.equal(
      lastPayload.remoteip,
      "203.0.113.10"
    );

    assert.equal(
      typeof lastPayload.idempotency_key,
      "string"
    );

    console.log(
      "✓ Siteverify receives token, IP, and idempotency key"
    );

    const json = (await validResponse.json()) as {
      ok: boolean;
      requestId?: string;
      status?: string;
      nextStep?: string;
      projectId?: string;
      turnstileToken?: string;
    };

    assert.equal(json.ok, true);
    assert.ok(json.requestId);
    assert.equal(
      json.status,
      "pending_verification"
    );
    assert.equal(json.nextStep, "verify_email");
    assert.equal("projectId" in json, false);
    assert.equal("turnstileToken" in json, false);

    console.log(
      "✓ verified request is saved without project, scan, or token exposure"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(
    "\n16/16 checks passed. Server-side Turnstile foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
