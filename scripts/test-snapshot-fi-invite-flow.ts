import { strict as assert } from "node:assert";

async function main() {
  delete process.env
    .NEXT_PUBLIC_SUPABASE_URL;

  delete process.env
    .SUPABASE_SERVICE_ROLE_KEY;

  process.env
    .SNAPSHOT_EMAIL_VERIFICATION_ENABLED =
    "true";

  const secret =
    "fi-invite-test-secret-with-at-least-32-characters";

  const inviteCode =
    "FI-MENTOR-ACCESS";

  const {
    hashSnapshotFiInviteCode,
    normalizeSnapshotFiInviteCode,
  } = await import(
    "../lib/snapshot-requests/fi-invite"
  );

  const {
    parseSnapshotRequestSubmission,
  } = await import(
    "../lib/snapshot-requests/normalize-request"
  );

  const expectedHash =
    hashSnapshotFiInviteCode(
      inviteCode,
      secret
    );

  assert.ok(expectedHash);
  assert.equal(
    expectedHash?.length,
    64
  );
  assert.notEqual(
    expectedHash,
    inviteCode
  );

  console.log(
    "✓ invitation codes are represented only by an HMAC hash"
  );

  assert.equal(
    normalizeSnapshotFiInviteCode(
      "  fi-mentor-access  "
    ),
    inviteCode
  );

  const parsed =
    parseSnapshotRequestSubmission({
      workEmail:
        "mentor@example.com",
      companyName:
        "Founder Institute Test",
      websiteUrl:
        "https://fi-invite.example.com",
      buyerCategory:
        "B2B SaaS",
      inviteCode:
        "  fi-mentor-access  ",
      turnstileToken:
        "test-turnstile-token",
    });

  assert.equal(
    parsed.inviteCode,
    "fi-mentor-access"
  );

  console.log(
    "✓ optional invitation input is accepted and trimmed"
  );

  process.env
    .SNAPSHOT_FI_INVITE_HASH_SECRET =
    secret;

  process.env
    .SNAPSHOT_FI_INVITE_CODE_HASH =
    expectedHash!;

  const [
    { getDb },
    {
      generateSnapshotEmailVerificationToken,
    },
    { POST },
  ] = await Promise.all([
    import("../lib/db"),
    import(
      "../lib/snapshot-requests/email-verification"
    ),
    import(
      "../app/api/snapshot-requests/verify-email/route"
    ),
  ]);

  const db = getDb();
  const stamp = Date.now();

  const makeRequest = (
    token: string
  ) =>
    new Request(
      "http://localhost/api/snapshot-requests/verify-email",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
        },
        body: JSON.stringify({
          token,
        }),
      }
    );

  async function createVerification(
    label: string,
    inviteCodeHash:
      string | null
  ) {
    const request =
      await db.createSnapshotRequest({
        workEmail:
          `${label}-${stamp}@example.com`,
        normalizedEmail:
          `${label}-${stamp}@example.com`,
        companyName:
          `FI ${label}`,
        websiteUrl:
          `https://${label}-${stamp}.example.com`,
        normalizedDomain:
          `${label}-${stamp}.example.com`,
        buyerCategory:
          "B2B SaaS",
        requestIpHash:
          `${label}-ip-${stamp}`,
      });

    const verification =
      generateSnapshotEmailVerificationToken({
        ttlMinutes: 30,
      });

    const issued =
      await db.issueSnapshotRequestVerification({
        requestId: request.id,
        tokenHash:
          verification.tokenHash,
        expiresAt:
          verification.expiresAt,
        inviteCodeHash,
      });

    assert.equal(issued, true);

    return {
      request,
      verification,
    };
  }

  const matching =
    await createVerification(
      "matching",
      expectedHash
    );

  const matchingResponse =
    await POST(
      makeRequest(
        matching.verification.token
      )
    );

  assert.equal(
    matchingResponse.status,
    200
  );

  const matchingJson =
    (await matchingResponse.json()) as {
      ok?: boolean;
      status?: string;
      nextStep?: string;
      requestId?: string;
      token?: string;
      projectId?: string;
    };

  assert.equal(
    matchingJson.ok,
    true
  );

  assert.equal(
    matchingJson.status,
    "queued"
  );

  assert.equal(
    matchingJson.nextStep,
    "awaiting_scan_runner"
  );

  assert.equal(
    "requestId" in matchingJson,
    false
  );

  assert.equal(
    "token" in matchingJson,
    false
  );

  assert.equal(
    "projectId" in matchingJson,
    false
  );

  console.log(
    "✓ a matching FI invitation queues only after email verification"
  );

  const reusedResponse =
    await POST(
      makeRequest(
        matching.verification.token
      )
    );

  assert.equal(
    reusedResponse.status,
    400
  );

  console.log(
    "✓ the verified invitation link cannot be reused"
  );

  const incorrectHash =
    hashSnapshotFiInviteCode(
      "INCORRECT-CODE",
      secret
    );

  const incorrect =
    await createVerification(
      "incorrect",
      incorrectHash
    );

  const incorrectResponse =
    await POST(
      makeRequest(
        incorrect.verification.token
      )
    );

  const incorrectJson =
    (await incorrectResponse.json()) as {
      status?: string;
      nextStep?: string;
    };

  assert.equal(
    incorrectJson.status,
    "pending_approval"
  );

  assert.equal(
    incorrectJson.nextStep,
    "awaiting_founder_approval"
  );

  console.log(
    "✓ an incorrect invitation still requires founder approval"
  );

  const absent =
    await createVerification(
      "absent",
      null
    );

  const absentResponse =
    await POST(
      makeRequest(
        absent.verification.token
      )
    );

  const absentJson =
    (await absentResponse.json()) as {
      status?: string;
    };

  assert.equal(
    absentJson.status,
    "pending_approval"
  );

  console.log(
    "✓ a missing invitation still requires founder approval"
  );

  const preserved =
    await createVerification(
      "preserved",
      expectedHash
    );

  delete process.env
    .SNAPSHOT_FI_INVITE_HASH_SECRET;

  const invalidConfigurationResponse =
    await POST(
      makeRequest(
        preserved.verification.token
      )
    );

  assert.equal(
    invalidConfigurationResponse.status,
    503
  );

  console.log(
    "✓ incomplete invitation configuration fails closed"
  );

  process.env
    .SNAPSHOT_FI_INVITE_HASH_SECRET =
    secret;

  const retryResponse =
    await POST(
      makeRequest(
        preserved.verification.token
      )
    );

  const retryJson =
    (await retryResponse.json()) as {
      status?: string;
    };

  assert.equal(
    retryJson.status,
    "queued"
  );

  console.log(
    "✓ a configuration failure does not consume the email token"
  );

  assert.equal(
    matching.request.projectId,
    null
  );

  console.log(
    "✓ no project or AI scan is created"
  );

  console.log(
    "\n8/8 checks passed. FI invitation backend PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
