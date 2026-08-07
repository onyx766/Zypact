import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type {
  SupabaseClient,
} from "@supabase/supabase-js";

interface TestUser {
  id: string;
  email: string | null;
}

async function main() {
  delete process.env.VERCEL_ENV;
  Object.assign(process.env, { NODE_ENV: "test" });
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ZYPACT_ALLOW_MEMORY_DB;

  process.env
    .SNAPSHOT_APPROVAL_ENABLED =
    "false";

  delete process.env
    .SNAPSHOT_FOUNDER_EMAILS;

  const [
    { getDb },
    {
      __setSupabaseServerClientForTests,
    },
    { POST },
  ] = await Promise.all([
    import("../lib/db"),
    import("../lib/supabase/server"),
    import(
      "../app/api/internal/snapshot-requests/[requestId]/approve/route"
    ),
  ]);

  function setAuthUser(
    user: TestUser | null
  ) {
    const client = {
      auth: {
        async getUser() {
          return {
            data: {
              user,
            },
            error: null,
          };
        },
      },
    } as unknown as SupabaseClient;

    __setSupabaseServerClientForTests(
      client
    );
  }

  /**
   * Approval now carries the founder's competitor frame. The default is a
   * valid two-competitor list so the auth and allowlist cases below are
   * unchanged — the route checks identity long before it parses this body.
   * Pass `null` to exercise a missing frame.
   */
  function invoke(
    requestId: string,
    competitors: string | null =
      "Alpha Analytics\nBeta Insights"
  ) {
    return POST(
      new Request(
        `http://localhost/api/internal/snapshot-requests/${requestId}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(
            competitors === null
              ? {}
              : { competitors }
          ),
        }
      ),
      {
        params: {
          requestId,
        },
      }
    );
  }

  const founder = {
    id:
      "11111111-1111-4111-8111-111111111111",
    email:
      "founder@zypact.com",
  };

  try {
    setAuthUser(founder);

    const disabledResponse =
      await invoke(randomUUID());

    assert.equal(
      disabledResponse.status,
      503
    );

    console.log(
      "✓ approval route is closed by default"
    );

    process.env
      .SNAPSHOT_APPROVAL_ENABLED =
      "true";

    setAuthUser(null);

    const unauthenticatedResponse =
      await invoke(randomUUID());

    assert.equal(
      unauthenticatedResponse.status,
      401
    );

    console.log(
      "✓ unauthenticated callers are rejected"
    );

    setAuthUser(founder);

    const missingAllowlistResponse =
      await invoke(randomUUID());

    assert.equal(
      missingAllowlistResponse.status,
      503
    );

    console.log(
      "✓ missing founder allowlist fails closed"
    );

    process.env
      .SNAPSHOT_FOUNDER_EMAILS =
      "founder@zypact.com";

    setAuthUser({
      id:
        "22222222-2222-4222-8222-222222222222",
      email:
        "other@zypact.com",
    });

    const nonFounderResponse =
      await invoke(randomUUID());

    assert.equal(
      nonFounderResponse.status,
      404
    );

    console.log(
      "✓ non-founder callers receive a generic refusal"
    );

    setAuthUser(founder);

    const malformedResponse =
      await invoke("not-a-uuid");

    assert.equal(
      malformedResponse.status,
      400
    );

    console.log(
      "✓ malformed request IDs are rejected"
    );

    const db = getDb();
    const stamp = randomUUID();

    const request =
      await db.createSnapshotRequest({
        workEmail:
          `approval-${stamp}@example.com`,
        normalizedEmail:
          `approval-${stamp}@example.com`,
        companyName:
          "Founder Approval Test",
        websiteUrl:
          `https://approval-${stamp}.example.com`,
        normalizedDomain:
          `approval-${stamp}.example.com`,
        buyerCategory:
          "B2B SaaS",
        requestIpHash: null,
      });

    const tokenHash =
      "a".repeat(64);

    const issued =
      await db.issueSnapshotRequestVerification({
        requestId: request.id,
        tokenHash,
        expiresAt: new Date(
          Date.now() + 30 * 60 * 1000
        ).toISOString(),
      });

    assert.equal(issued, true);

    const verified =
      await db.consumeSnapshotRequestVerification(
        tokenHash
      );

    assert.equal(
      verified?.status,
      "pending_approval"
    );

    // The route validates against the STORED company and domain, not
    // anything the caller sent, so a self-reference is refused with a
    // useful message rather than a generic failure.
    const selfCompany = await invoke(
      request.id,
      `Alpha Analytics\n${request.companyName}`
    );

    assert.equal(selfCompany.status, 400);

    assert.equal(
      (
        (await selfCompany.json()) as { error?: string }
      ).error,
      "competitor_is_scanned_company"
    );

    const selfDomain = await invoke(
      request.id,
      `Alpha Analytics\n${request.normalizedDomain.toUpperCase()}`
    );

    assert.equal(selfDomain.status, 400);

    assert.equal(
      (
        (await selfDomain.json()) as { error?: string }
      ).error,
      "competitor_is_scanned_company"
    );

    // A caller cannot smuggle a different identity to make a self-reference
    // look valid: the body's company/domain fields are ignored entirely.
    const spoofed = await POST(
      new Request(
        `http://localhost/api/internal/snapshot-requests/${request.id}/approve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            competitors: `Alpha Analytics\n${request.companyName}`,
            companyName: "Something Else",
            normalizedDomain: "elsewhere.example",
          }),
        }
      ),
      { params: { requestId: request.id } }
    );

    assert.equal(spoofed.status, 400);

    assert.equal(
      (
        (await spoofed.json()) as { error?: string }
      ).error,
      "competitor_is_scanned_company"
    );

    // Approval without a competitor frame is refused, and the request stays
    // pending_approval so the founder can correct it.
    const missingCompetitors =
      await invoke(request.id, null);

    assert.equal(
      missingCompetitors.status,
      400
    );

    assert.equal(
      (
        (await missingCompetitors.json()) as {
          error?: string;
        }
      ).error,
      "competitors_required"
    );

    assert.equal(
      (
        await db.getSnapshotRequest(
          request.id
        )
      )?.status,
      "pending_approval"
    );

    const approvalResponse =
      await invoke(request.id);

    assert.equal(
      approvalResponse.status,
      200
    );

    const approvalJson =
      (await approvalResponse.json()) as {
        ok?: boolean;
        status?: string;
        nextStep?: string;
        projectId?: string;
      };

    assert.equal(
      approvalJson.ok,
      true
    );

    // The approved row carries the normalized frame the founder submitted.
    assert.deepEqual(
      (
        await db.getSnapshotRequest(
          request.id
        )
      )?.competitors,
      ["Alpha Analytics", "Beta Insights"]
    );

    assert.equal(
      approvalJson.status,
      "queued"
    );

    assert.equal(
      approvalJson.nextStep,
      "awaiting_scan_runner"
    );

    assert.equal(
      "projectId" in approvalJson,
      false
    );

    console.log(
      "✓ pending approval moves atomically to queued without a project"
    );

    const repeatedResponse =
      await invoke(request.id);

    assert.equal(
      repeatedResponse.status,
      200
    );

    const repeatedJson =
      (await repeatedResponse.json()) as {
        status?: string;
      };

    assert.equal(
      repeatedJson.status,
      "queued"
    );

    console.log(
      "✓ repeated founder approval is idempotent"
    );

    const wrongStateStamp =
      randomUUID();

    const wrongStateRequest =
      await db.createSnapshotRequest({
        workEmail:
          `wrong-state-${wrongStateStamp}@example.com`,
        normalizedEmail:
          `wrong-state-${wrongStateStamp}@example.com`,
        companyName:
          "Wrong State Test",
        websiteUrl:
          `https://wrong-state-${wrongStateStamp}.example.com`,
        normalizedDomain:
          `wrong-state-${wrongStateStamp}.example.com`,
        buyerCategory:
          "B2B SaaS",
        requestIpHash: null,
      });

    const wrongStateResponse =
      await invoke(
        wrongStateRequest.id
      );

    assert.equal(
      wrongStateResponse.status,
      409
    );

    console.log(
      "✓ requests in another state are not changed"
    );

    console.log(
      "\n8/8 checks passed. Founder approval route PASSED."
    );
  } finally {
    __setSupabaseServerClientForTests(
      null
    );

    process.env
      .SNAPSHOT_APPROVAL_ENABLED =
      "false";
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
