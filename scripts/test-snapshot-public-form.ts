import { strict as assert } from "node:assert";
import {
  buildSnapshotRequestPayload,
  submitSnapshotRequest,
} from "../lib/snapshot-requests/public-form";

async function main() {
  const values = {
    contactName: " Jane Smith ",
    workEmail: " Founder@Example.com ",
    companyName: " Example SaaS ",
    websiteUrl: " example.com ",
    buyerCategory: " B2B SaaS software ",
  };

  const token = "mock-turnstile-token";

  assert.deepEqual(
    buildSnapshotRequestPayload(
      values,
      token
    ),
    {
      contactName: "Jane Smith",
      workEmail: "Founder@Example.com",
      companyName: "Example SaaS",
      websiteUrl: "example.com",
      buyerCategory:
        "B2B SaaS software",
      turnstileToken: token,
    }
  );

  console.log(
    "✓ public form payload is trimmed"
  );

  let missingTokenCalls = 0;

  const missingToken =
    await submitSnapshotRequest(
      values,
      "",
      (async () => {
        missingTokenCalls += 1;
        throw new Error(
          "fetch should not run"
        );
      }) as typeof fetch
    );

  assert.equal(missingToken.ok, false);

  if (!missingToken.ok) {
    assert.equal(
      missingToken.reason,
      "security_check"
    );

    assert.ok(
      missingToken.fieldErrors
        .turnstileToken
    );
  }

  assert.equal(missingTokenCalls, 0);

  console.log(
    "✓ missing Turnstile token is rejected locally"
  );

  let capturedInput = "";
  let capturedMethod = "";
  let capturedCache = "";
  let capturedBodyJson = "";

  const success =
    await submitSnapshotRequest(
      values,
      token,
      (async (
        input: URL | RequestInfo,
        init?: RequestInit
      ) => {
        capturedInput = String(input);
        capturedMethod =
          init?.method || "";
        capturedCache =
          String(init?.cache || "");

        capturedBodyJson =
          String(init?.body || "{}");

        return new Response(
          JSON.stringify({
            ok: true,
            requestId:
              "private-request-id",
            status:
              "pending_verification",
            nextStep: "check_email",
          }),
          {
            status: 201,
            headers: {
              "content-type":
                "application/json",
            },
          }
        );
      }) as typeof fetch
    );

  assert.equal(
    capturedInput,
    "/api/snapshot-requests"
  );

  assert.equal(
    capturedMethod,
    "POST"
  );

  assert.equal(
    capturedCache,
    "no-store"
  );

  const capturedBody = JSON.parse(
    capturedBodyJson
  ) as Record<string, unknown>;

  assert.equal(
    capturedBody.turnstileToken,
    token
  );

  console.log(
    "✓ request uses a no-store POST"
  );

  assert.deepEqual(success, {
    ok: true,
    status: "pending_verification",
    nextStep: "check_email",
  });

  assert.equal(
    "requestId" in success,
    false
  );

  assert.equal(
    "turnstileToken" in success,
    false
  );

  console.log(
    "✓ successful UI result exposes no request ID or token"
  );

  const validation =
    await submitSnapshotRequest(
      values,
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            issues: {
              workEmail: [
                "Invalid email address",
              ],
            },
          }),
          {
            status: 400,
            headers: {
              "content-type":
                "application/json",
            },
          }
        )) as typeof fetch
    );

  assert.equal(validation.ok, false);

  if (!validation.ok) {
    assert.equal(
      validation.reason,
      "validation"
    );

    assert.deepEqual(
      validation.fieldErrors
        .workEmail,
      ["Invalid email address"]
    );
  }

  console.log(
    "✓ server field errors are preserved"
  );

  const limited =
    await submitSnapshotRequest(
      values,
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code:
              "snapshot_request_limit",
          }),
          { status: 429 }
        )) as typeof fetch
    );

  assert.equal(limited.ok, false);

  if (!limited.ok) {
    assert.equal(
      limited.reason,
      "limit"
    );
  }

  console.log(
    "✓ request limits receive a dedicated state"
  );

  const deliveryFailure =
    await submitSnapshotRequest(
      values,
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            code:
              "verification_email_delivery_failed",
          }),
          { status: 503 }
        )) as typeof fetch
    );

  assert.equal(
    deliveryFailure.ok,
    false
  );

  if (!deliveryFailure.ok) {
    assert.equal(
      deliveryFailure.reason,
      "delivery_failed"
    );
  }

  console.log(
    "✓ email delivery failures receive a retryable state"
  );

  const unavailable =
    await submitSnapshotRequest(
      values,
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
          }),
          { status: 503 }
        )) as typeof fetch
    );

  assert.equal(unavailable.ok, false);

  if (!unavailable.ok) {
    assert.equal(
      unavailable.reason,
      "unavailable"
    );
  }

  console.log(
    "✓ disabled form receives an unavailable state"
  );

  const networkFailure =
    await submitSnapshotRequest(
      values,
      token,
      (async () => {
        throw new Error(
          "simulated connection failure"
        );
      }) as typeof fetch
    );

  assert.equal(
    networkFailure.ok,
    false
  );

  if (!networkFailure.ok) {
    assert.equal(
      networkFailure.reason,
      "request_failed"
    );
  }

  console.log(
    "✓ network failure receives a safe generic state"
  );

  console.log(
    "\n8/8 checks passed. Public snapshot form foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
