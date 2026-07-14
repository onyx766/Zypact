import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  buildSnapshotRequestPayload,
} from "../lib/snapshot-requests/public-form";
import {
  verifySnapshotEmailLink,
} from "../lib/snapshot-requests/verification-ui";

async function main() {
  const values = {
    workEmail: " mentor@example.com ",
    companyName: " Mentor SaaS ",
    websiteUrl: " mentor.example.com ",
    buyerCategory: " B2B SaaS ",
    inviteCode: "  FI-MENTOR-ACCESS  ",
  };

  const payload =
    buildSnapshotRequestPayload(
      values,
      "turnstile-token"
    );

  assert.deepEqual(payload, {
    workEmail: "mentor@example.com",
    companyName: "Mentor SaaS",
    websiteUrl: "mentor.example.com",
    buyerCategory: "B2B SaaS",
    inviteCode: "FI-MENTOR-ACCESS",
    turnstileToken: "turnstile-token",
  });

  console.log(
    "✓ invitation code is trimmed into the request payload"
  );

  const payloadWithoutCode =
    buildSnapshotRequestPayload(
      {
        ...values,
        inviteCode: "   ",
      },
      "turnstile-token"
    );

  assert.equal(
    "inviteCode" in payloadWithoutCode,
    false
  );

  console.log(
    "✓ blank invitation codes are omitted"
  );

  const token = "A".repeat(43);

  const queued =
    await verifySnapshotEmailLink(
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            status: "queued",
            nextStep:
              "awaiting_scan_runner",
          }),
          {
            status: 200,
            headers: {
              "content-type":
                "application/json",
            },
          }
        )) as typeof fetch
    );

  assert.deepEqual(queued, {
    ok: true,
    status: "queued",
    nextStep: "awaiting_scan_runner",
  });

  console.log(
    "✓ queued verification responses are preserved"
  );

  const pending =
    await verifySnapshotEmailLink(
      token,
      (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            status: "pending_approval",
            nextStep:
              "awaiting_founder_approval",
          }),
          {
            status: 200,
            headers: {
              "content-type":
                "application/json",
            },
          }
        )) as typeof fetch
    );

  assert.deepEqual(pending, {
    ok: true,
    status: "pending_approval",
    nextStep:
      "awaiting_founder_approval",
  });

  console.log(
    "✓ normal requests still preserve the approval state"
  );

  const scanFormSource =
    readFileSync(
      "app/scan/scan-form.tsx",
      "utf8"
    );

  assert.match(
    scanFormSource,
    /id="inviteCode"/
  );

  assert.match(
    scanFormSource,
    /Email verification is still required/
  );

  console.log(
    "✓ the public form exposes an optional invitation field"
  );

  const verificationSource =
    readFileSync(
      "app/verify-email/verify-email-client.tsx",
      "utf8"
    );

  assert.match(
    verificationSource,
    /in the scan queue/
  );

  assert.match(
    verificationSource,
    /waiting for approval/
  );

  console.log(
    "✓ the verification page contains both safe outcomes"
  );

  console.log(
    "\n6/6 checks passed. FI invitation public UI PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
