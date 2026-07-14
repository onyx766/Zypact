import { strict as assert } from "node:assert";
import {
  hashRequestIp,
  normalizeSnapshotRequestInput,
  parseSnapshotRequestSubmission,
  SnapshotRequestValidationError,
} from "../lib/snapshot-requests/normalize-request";

type TurnstileMode =
  | "success"
  | "failed"
  | "wrong_action";

type ResendMode =
  | "success"
  | "failed";

async function main() {
  const normalized =
    normalizeSnapshotRequestInput({
      workEmail:
        " Founder@Example.com ",
      companyName:
        " Example SaaS ",
      websiteUrl:
        "WWW.Example.com/pricing?source=test#section",
      buyerCategory:
        " B2B SaaS software ",
    });

  assert.equal(
    normalized.workEmail,
    "Founder@Example.com"
  );
  console.log(
    "✓ original trimmed email is preserved"
  );

  assert.equal(
    normalized.normalizedEmail,
    "founder@example.com"
  );
  console.log("✓ email is normalized");

  assert.equal(
    normalized.normalizedDomain,
    "example.com"
  );
  console.log(
    "✓ domain is normalized and www is removed"
  );

  assert.equal(
    normalized.websiteUrl,
    "https://www.example.com"
  );
  console.log(
    "✓ website is reduced to a safe origin"
  );

  assert.throws(
    () =>
      normalizeSnapshotRequestInput({
        workEmail:
          "founder@example.com",
        companyName: "Example",
        websiteUrl:
          "http://localhost:3000",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log(
    "✓ localhost websites are rejected"
  );

  assert.throws(
    () =>
      normalizeSnapshotRequestInput({
        workEmail:
          "founder@example.com",
        companyName: "Example",
        websiteUrl:
          "http://127.0.0.1",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log(
    "✓ IP-address websites are rejected"
  );

  const secret =
    "test-secret-that-is-at-least-32-characters";

  const hashA =
    hashRequestIp(
      "203.0.113.10",
      secret
    );

  const hashB =
    hashRequestIp(
      "203.0.113.10",
      secret
    );

  assert.equal(hashA, hashB);
  console.log(
    "✓ IP hashing is deterministic"
  );

  assert.notEqual(
    hashA,
    "203.0.113.10"
  );
  console.log(
    "✓ raw IP is not stored as the hash"
  );

  assert.throws(
    () =>
      parseSnapshotRequestSubmission({
        workEmail:
          "founder@example.com",
        companyName:
          "Example SaaS",
        websiteUrl:
          "https://example.com",
        buyerCategory: "B2B SaaS",
      }),
    SnapshotRequestValidationError
  );
  console.log(
    "✓ Turnstile token is required"
  );

  delete process.env
    .NEXT_PUBLIC_SUPABASE_URL;

  delete process.env
    .SUPABASE_SERVICE_ROLE_KEY;

  delete process.env
    .TURNSTILE_SECRET_KEY;

  delete process.env.RESEND_API_KEY;
  delete process.env
    .SNAPSHOT_EMAIL_FROM;

  delete process.env
    .SNAPSHOT_PUBLIC_BASE_URL;

  process.env
    .SNAPSHOT_REQUESTS_ENABLED =
    "false";

  process.env
    .SNAPSHOT_EMAIL_VERIFICATION_ENABLED =
    "false";

  process.env
    .SNAPSHOT_IP_HASH_SECRET =
    secret;

  const { POST } = await import(
    "../app/api/snapshot-requests/route"
  );

  const makeRequest = (
    body: Record<string, unknown>,
    ip = "203.0.113.10"
  ): Request =>
    new Request(
      "http://localhost/api/snapshot-requests",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          "x-forwarded-for":
            `${ip}, 10.0.0.1`,
        },
        body: JSON.stringify(body),
      }
    );

  const validBody = {
    workEmail:
      "Founder@Example.com",
    companyName: "Example SaaS",
    websiteUrl:
      "example.com/pricing",
    buyerCategory:
      "B2B SaaS software",
    turnstileToken:
      "mock-turnstile-token",
  };

  const disabledResponse =
    await POST(
      makeRequest(validBody)
    );

  assert.equal(
    disabledResponse.status,
    503
  );
  console.log(
    "✓ route is closed by default"
  );

  process.env
    .SNAPSHOT_REQUESTS_ENABLED =
    "true";

  process.env
    .SNAPSHOT_EMAIL_VERIFICATION_ENABLED =
    "true";

  const missingConfigurationResponse =
    await POST(
      makeRequest(validBody)
    );

  assert.equal(
    missingConfigurationResponse.status,
    503
  );
  console.log(
    "✓ route fails closed without email configuration"
  );

  process.env
    .TURNSTILE_SECRET_KEY =
    "test-turnstile-secret";

  process.env
    .TURNSTILE_EXPECTED_HOSTNAME =
    "zypact.com";

  process.env.RESEND_API_KEY =
    "re_mock_api_key";

  process.env.SNAPSHOT_EMAIL_FROM =
    "Zypact <verify@updates.zypact.com>";

  process.env
    .SNAPSHOT_EMAIL_REPLY_TO =
    "contact@zypact.com";

  process.env
    .SNAPSHOT_PUBLIC_BASE_URL =
    "https://zypact.com";

  process.env
    .SNAPSHOT_EMAIL_VERIFICATION_TTL_MINUTES =
    "30";

  const originalFetch =
    globalThis.fetch;

  let turnstileMode:
    TurnstileMode = "success";

  let resendMode:
    ResendMode = "success";

  let networkCalls = 0;
  let turnstileCalls = 0;
  let resendCalls = 0;

  let lastTurnstilePayload:
    Record<string, unknown> = {};

  let lastResendBody:
    Record<string, unknown> = {};

  globalThis.fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => {
    networkCalls += 1;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (
      url ===
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    ) {
      turnstileCalls += 1;

      lastTurnstilePayload =
        JSON.parse(
          String(init?.body || "{}")
        ) as Record<
          string,
          unknown
        >;

      if (
        turnstileMode === "failed"
      ) {
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
              "content-type":
                "application/json",
            },
          }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          hostname: "zypact.com",
          action:
            turnstileMode ===
            "wrong_action"
              ? "different_action"
              : "snapshot_request",
          "error-codes": [],
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json",
          },
        }
      );
    }

    if (
      url ===
      "https://api.resend.com/emails"
    ) {
      resendCalls += 1;

      lastResendBody =
        JSON.parse(
          String(init?.body || "{}")
        ) as Record<
          string,
          unknown
        >;

      if (resendMode === "failed") {
        return new Response(
          JSON.stringify({
            name:
              "validation_error",
            message:
              "Simulated email failure",
          }),
          {
            status: 422,
            headers: {
              "content-type":
                "application/json",
            },
          }
        );
      }

      return new Response(
        JSON.stringify({
          id:
            `mock-email-${resendCalls}`,
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json",
          },
        }
      );
    }

    throw new Error(
      `Unexpected network URL: ${url}`
    );
  }) as typeof fetch;

  try {
    const callsBeforeInvalid =
      networkCalls;

    const invalidResponse =
      await POST(
        makeRequest({
          ...validBody,
          workEmail:
            "not-an-email",
          companyName: "X",
        })
      );

    assert.equal(
      invalidResponse.status,
      400
    );

    assert.equal(
      networkCalls,
      callsBeforeInvalid
    );

    console.log(
      "✓ invalid fields are rejected before Turnstile"
    );

    turnstileMode = "failed";

    const failedChallengeResponse =
      await POST(
        makeRequest(validBody)
      );

    assert.equal(
      failedChallengeResponse.status,
      400
    );

    console.log(
      "✓ failed Turnstile challenge is rejected"
    );

    turnstileMode =
      "wrong_action";

    const wrongActionResponse =
      await POST(
        makeRequest(validBody)
      );

    assert.equal(
      wrongActionResponse.status,
      400
    );

    console.log(
      "✓ unexpected Turnstile action is rejected"
    );

    turnstileMode = "success";
    resendMode = "success";

    const validResponse =
      await POST(
        makeRequest(validBody)
      );

    assert.equal(
      validResponse.status,
      201
    );

    assert.equal(
      lastTurnstilePayload.response,
      "mock-turnstile-token"
    );

    assert.equal(
      lastTurnstilePayload.remoteip,
      "203.0.113.10"
    );

    assert.equal(
      typeof lastTurnstilePayload
        .idempotency_key,
      "string"
    );

    console.log(
      "✓ Siteverify receives token, IP, and idempotency key"
    );

    assert.deepEqual(
      lastResendBody.to,
      ["Founder@Example.com"]
    );

    assert.equal(
      lastResendBody.from,
      "Zypact <verify@updates.zypact.com>"
    );

    assert.equal(
      lastResendBody.reply_to,
      "contact@zypact.com"
    );

    assert.match(
      String(lastResendBody.html),
      /\/verify-email\?token=[A-Za-z0-9_-]{43}/
    );

    console.log(
      "✓ verification email is prepared after the request is saved"
    );

    const json =
      (await validResponse.json()) as {
        ok: boolean;
        requestId?: string;
        status?: string;
        nextStep?: string;
        projectId?: string;
        turnstileToken?: string;
        token?: string;
      };

    assert.equal(json.ok, true);
    assert.ok(json.requestId);

    assert.equal(
      json.status,
      "pending_verification"
    );

    assert.equal(
      json.nextStep,
      "check_email"
    );

    assert.equal(
      "projectId" in json,
      false
    );

    assert.equal(
      "turnstileToken" in json,
      false
    );

    assert.equal(
      "token" in json,
      false
    );

    console.log(
      "✓ successful response exposes no verification token or project"
    );

    resendMode = "failed";

    const failureBody = {
      ...validBody,
      workEmail:
        "delivery-failure@example.com",
      companyName:
        "Delivery Failure SaaS",
      websiteUrl:
        "delivery-failure.example.com",
    };

    const deliveryFailureResponse =
      await POST(
        makeRequest(failureBody)
      );

    assert.equal(
      deliveryFailureResponse.status,
      503
    );

    const failureJson =
      (await deliveryFailureResponse.json()) as {
        code?: string;
        requestId?: string;
        token?: string;
      };

    assert.equal(
      failureJson.code,
      "verification_email_delivery_failed"
    );

    assert.equal(
      "requestId" in failureJson,
      false
    );

    assert.equal(
      "token" in failureJson,
      false
    );

    console.log(
      "✓ email delivery failure returns a safe response"
    );

    const failedEmailHtml =
      String(lastResendBody.html);

    const tokenMatch =
      failedEmailHtml.match(
        /token=([A-Za-z0-9_-]{43})/
      );

    assert.ok(tokenMatch);

    const { POST: verifyEmail } =
      await import(
        "../app/api/snapshot-requests/verify-email/route"
      );

    const invalidatedLinkResponse =
      await verifyEmail(
        new Request(
          "http://localhost/api/snapshot-requests/verify-email",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json",
            },
            body: JSON.stringify({
              token: tokenMatch[1],
            }),
          }
        )
      );

    assert.equal(
      invalidatedLinkResponse.status,
      400
    );

    console.log(
      "✓ failed delivery invalidates the stored verification hash"
    );

    resendMode = "success";

    const retryResponse =
      await POST(
        makeRequest(failureBody)
      );

    assert.equal(
      retryResponse.status,
      201
    );

    console.log(
      "✓ failed delivery does not block a clean retry"
    );

    assert.ok(
      turnstileCalls >= 5
    );

    assert.equal(
      resendCalls,
      3
    );
  } finally {
    globalThis.fetch =
      originalFetch;
  }

  console.log(
    "\n20/20 checks passed. Snapshot request email flow PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
