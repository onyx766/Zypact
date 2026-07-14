import { strict as assert } from "node:assert";
import {
  buildSnapshotVerificationLink,
  renderSnapshotVerificationEmail,
  sendSnapshotVerificationEmail,
  SnapshotEmailDeliveryError,
} from "../lib/snapshot-requests/verification-email-delivery";

async function main() {
  const token = "A".repeat(43);

  const verificationLink =
    buildSnapshotVerificationLink(
      "https://zypact.com",
      token
    );

  const parsedLink = new URL(verificationLink);

  assert.equal(parsedLink.origin, "https://zypact.com");
  assert.equal(parsedLink.pathname, "/verify-email");
  assert.equal(
    parsedLink.searchParams.get("token"),
    token
  );

  console.log("✓ private verification link is built correctly");

  const rendered = renderSnapshotVerificationEmail({
    companyName: '<Example & "SaaS">',
    verificationLink,
    expiresInMinutes: 30,
  });

  assert.ok(
    rendered.html.includes(
      "&lt;Example &amp; &quot;SaaS&quot;&gt;"
    )
  );

  assert.equal(
    rendered.html.includes('<Example & "SaaS">'),
    false
  );

  console.log("✓ company-controlled HTML is escaped");

  assert.ok(rendered.text.includes(verificationLink));
  assert.ok(rendered.text.includes("30 minutes"));

  console.log("✓ plain-text version contains the link and expiry");

  const config = {
    apiKey: "re_mock_api_key",
    from: "Zypact <verify@updates.zypact.com>",
    replyTo: "contact@zypact.com",
    appBaseUrl: "https://zypact.com",
  };

  const input = {
    requestId: "request-123",
    to: "founder@example.com",
    companyName: "Example SaaS",
    token,
    expiresInMinutes: 30,
  };

  let calls = 0;
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};

  const successfulFetch = (async (
    request: URL | RequestInfo,
    init?: RequestInit
  ) => {
    calls += 1;

    capturedUrl =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;

    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(
      String(init?.body ?? "{}")
    ) as Record<string, unknown>;

    return new Response(
      JSON.stringify({
        id: "email-message-123",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }
    );
  }) as typeof fetch;

  const result =
    await sendSnapshotVerificationEmail(
      input,
      config,
      successfulFetch
    );

  assert.equal(calls, 1);
  assert.equal(
    capturedUrl,
    "https://api.resend.com/emails"
  );
  assert.equal(
    capturedHeaders.get("authorization"),
    "Bearer re_mock_api_key"
  );

  console.log("✓ Resend endpoint and Bearer authentication are used");

  assert.deepEqual(capturedBody.to, [
    "founder@example.com",
  ]);
  assert.equal(capturedBody.from, config.from);
  assert.equal(
    capturedBody.reply_to,
    "contact@zypact.com"
  );
  assert.equal(
    typeof capturedBody.html,
    "string"
  );
  assert.equal(
    typeof capturedBody.text,
    "string"
  );

  console.log("✓ sender, recipient, reply-to, HTML, and text are sent");

  assert.equal(
    capturedHeaders.get("idempotency-key"),
    "snapshot-verification-request-123"
  );

  assert.equal(
    capturedHeaders
      .get("idempotency-key")
      ?.includes(token),
    false
  );

  console.log("✓ stable idempotency key does not expose the token");

  assert.deepEqual(result, {
    provider: "resend",
    messageId: "email-message-123",
  });

  console.log("✓ provider message ID is returned");

  const failedFetch = (async () =>
    new Response(
      JSON.stringify({
        name: "validation_error",
        message: `provider rejected ${token}`,
      }),
      {
        status: 422,
        headers: {
          "content-type": "application/json",
        },
      }
    )) as typeof fetch;

  await assert.rejects(
    () =>
      sendSnapshotVerificationEmail(
        input,
        config,
        failedFetch
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof SnapshotEmailDeliveryError
      );
      assert.equal(error.code, "validation_error");
      assert.equal(error.status, 422);
      assert.equal(
        error.message.includes(token),
        false
      );
      return true;
    }
  );

  console.log("✓ provider failures do not leak the token");

  let invalidConfigurationFetchCalls = 0;

  const forbiddenFetch = (async () => {
    invalidConfigurationFetchCalls += 1;
    throw new Error("fetch should not run");
  }) as typeof fetch;

  await assert.rejects(
    () =>
      sendSnapshotVerificationEmail(
        input,
        {
          ...config,
          apiKey: "",
        },
        forbiddenFetch
      ),
    SnapshotEmailDeliveryError
  );

  assert.equal(invalidConfigurationFetchCalls, 0);

  console.log("✓ missing configuration fails before any network call");

  console.log(
    "\n9/9 checks passed. Snapshot verification email delivery PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
