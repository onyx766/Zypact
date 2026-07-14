import { strict as assert } from "node:assert";
import {
  hashRequestIp,
  normalizeSnapshotRequestInput,
  SnapshotRequestValidationError,
} from "../lib/snapshot-requests/normalize-request";

async function main() {
  const normalized = normalizeSnapshotRequestInput({
    workEmail: " Founder@Example.com ",
    companyName: " Example SaaS ",
    websiteUrl: "WWW.Example.com/pricing?source=test#section",
    buyerCategory: " B2B SaaS software ",
  });

  assert.equal(normalized.workEmail, "Founder@Example.com");
  console.log("✓ original trimmed email is preserved");

  assert.equal(normalized.normalizedEmail, "founder@example.com");
  console.log("✓ email is normalized");

  assert.equal(normalized.normalizedDomain, "example.com");
  console.log("✓ domain is normalized and www is removed");

  assert.equal(normalized.websiteUrl, "https://www.example.com");
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

  const secret = "test-secret-that-is-at-least-32-characters";
  const hashA = hashRequestIp("203.0.113.10", secret);
  const hashB = hashRequestIp("203.0.113.10", secret);

  assert.equal(hashA, hashB);
  console.log("✓ IP hashing is deterministic");

  assert.notEqual(hashA, "203.0.113.10");
  console.log("✓ raw IP is not stored as the hash");

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  process.env.SNAPSHOT_REQUESTS_ENABLED = "false";
  process.env.SNAPSHOT_IP_HASH_SECRET = secret;

  const { POST } = await import(
    "../app/api/snapshot-requests/route"
  );

  const disabledResponse = await POST(
    new Request("http://localhost/api/snapshot-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workEmail: "founder@example.com",
        companyName: "Example SaaS",
        websiteUrl: "https://example.com",
        buyerCategory: "B2B SaaS",
      }),
    })
  );

  assert.equal(disabledResponse.status, 503);
  console.log("✓ route is closed by default");

  process.env.SNAPSHOT_REQUESTS_ENABLED = "true";

  const invalidResponse = await POST(
    new Request("http://localhost/api/snapshot-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workEmail: "not-an-email",
        companyName: "X",
        websiteUrl: "localhost",
        buyerCategory: "",
      }),
    })
  );

  assert.equal(invalidResponse.status, 400);
  console.log("✓ invalid public requests are rejected");

  const validResponse = await POST(
    new Request("http://localhost/api/snapshot-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10, 10.0.0.1",
      },
      body: JSON.stringify({
        workEmail: "Founder@Example.com",
        companyName: "Example SaaS",
        websiteUrl: "example.com/pricing",
        buyerCategory: "B2B SaaS software",
      }),
    })
  );

  assert.equal(validResponse.status, 201);

  const json = (await validResponse.json()) as {
    ok: boolean;
    requestId?: string;
    status?: string;
    nextStep?: string;
    projectId?: string;
  };

  assert.equal(json.ok, true);
  assert.ok(json.requestId);
  assert.equal(json.status, "pending_verification");
  assert.equal(json.nextStep, "verify_email");
  assert.equal("projectId" in json, false);

  console.log("✓ valid request is saved without creating a project or scan");

  console.log(
    "\n11/11 checks passed. Snapshot request route foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
