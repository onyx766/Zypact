import { strict as assert } from "node:assert";
import type { SnapshotRequest } from "../lib/db/types";
import { evaluateSnapshotRequestLimits } from "../lib/snapshot-requests/limits";

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  process.env.SNAPSHOT_REQUESTS_ENABLED = "true";
  process.env.SNAPSHOT_IP_HASH_SECRET =
    "test-ip-hash-secret-that-is-at-least-32-characters";
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  process.env.TURNSTILE_EXPECTED_HOSTNAME = "zypact.com";

  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        hostname: "zypact.com",
        action: "snapshot_request",
        "error-codes": [],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }
    )) as typeof fetch;

  try {
    const { POST } = await import(
      "../app/api/snapshot-requests/route"
    );

    const makeRequest = (
      workEmail: string,
      websiteUrl: string,
      ip = "203.0.113.40"
    ) =>
      new Request("http://localhost/api/snapshot-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `${ip}, 10.0.0.1`,
        },
        body: JSON.stringify({
          workEmail,
          companyName: "Limit Test SaaS",
          websiteUrl,
          buyerCategory: "B2B SaaS",
          turnstileToken: "mock-turnstile-token",
        }),
      });

    const first = await POST(
      makeRequest("first@example.com", "first.example.com")
    );

    assert.equal(first.status, 201);
    console.log("✓ first request is accepted");

    const repeatedEmail = await POST(
      makeRequest("FIRST@example.com", "different.example.com")
    );

    assert.equal(repeatedEmail.status, 429);
    console.log("✓ one request per normalized email per 30 days");

    const repeatedDomain = await POST(
      makeRequest("different@example.com", "www.first.example.com")
    );

    assert.equal(repeatedDomain.status, 429);
    console.log("✓ one request per normalized domain per 30 days");

    const secondIpRequest = await POST(
      makeRequest("second@example.com", "second.example.com")
    );

    const thirdIpRequest = await POST(
      makeRequest("third@example.com", "third.example.com")
    );

    assert.equal(secondIpRequest.status, 201);
    assert.equal(thirdIpRequest.status, 201);

    const fourthIpRequest = await POST(
      makeRequest("fourth@example.com", "fourth.example.com")
    );

    assert.equal(fourthIpRequest.status, 429);
    console.log("✓ fourth request from the same IP in 24 hours is blocked");

    const now = new Date("2026-07-14T12:00:00.000Z");
    const oldCreatedAt = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000
    ).toISOString();

    const oldActiveRequest: SnapshotRequest = {
      id: "old-active-request",
      workEmail: "old@example.com",
      normalizedEmail: "old@example.com",
      companyName: "Old SaaS",
      websiteUrl: "https://active.example.com",
      normalizedDomain: "active.example.com",
      buyerCategory: "B2B SaaS",
      status: "running",
      requestIpHash: null,
      projectId: null,
      createdAt: oldCreatedAt,
      updatedAt: oldCreatedAt,
    };

    const activeDecision = evaluateSnapshotRequestLimits(
      [oldActiveRequest],
      {
        workEmail: "new@example.com",
        normalizedEmail: "new@example.com",
        companyName: "New SaaS",
        websiteUrl: "https://active.example.com",
        normalizedDomain: "active.example.com",
        buyerCategory: "B2B SaaS",
        requestIpHash: null,
      },
      now
    );

    assert.deepEqual(activeDecision, {
      ok: false,
      code: "active_domain",
    });

    console.log("✓ an older active scan still blocks the same domain");

    const oldCompletedRequest: SnapshotRequest = {
      ...oldActiveRequest,
      id: "old-completed-request",
      normalizedDomain: "completed.example.com",
      websiteUrl: "https://completed.example.com",
      status: "report_ready",
    };

    const completedDecision = evaluateSnapshotRequestLimits(
      [oldCompletedRequest],
      {
        workEmail: "new-completed@example.com",
        normalizedEmail: "new-completed@example.com",
        companyName: "New Completed SaaS",
        websiteUrl: "https://completed.example.com",
        normalizedDomain: "completed.example.com",
        buyerCategory: "B2B SaaS",
        requestIpHash: null,
      },
      now
    );

    assert.deepEqual(completedDecision, { ok: true });
    console.log("✓ a completed request older than 30 days can be renewed");

    console.log(
      "\n6/6 checks passed. Snapshot request limits PASSED."
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
