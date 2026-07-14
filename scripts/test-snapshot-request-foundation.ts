import { strict as assert } from "node:assert";
import { memoryAdapter } from "../lib/db/memory-adapter";

async function main() {
  const request = await memoryAdapter.createSnapshotRequest({
    workEmail: "Founder@Example.com",
    normalizedEmail: "founder@example.com",
    companyName: "Example SaaS",
    websiteUrl: "https://example.com",
    normalizedDomain: "example.com",
    buyerCategory: "AI visibility software",
    requestIpHash: "test-ip-hash",
  });

  assert.ok(request.id);
  console.log("✓ request receives an id");

  assert.equal(request.status, "pending_verification");
  console.log("✓ initial status is pending_verification");

  assert.equal(request.projectId, null);
  console.log("✓ no project is created");

  assert.equal(request.workEmail, "Founder@Example.com");
  console.log("✓ original work email is preserved");

  assert.equal(request.normalizedEmail, "founder@example.com");
  console.log("✓ normalized email is stored");

  assert.equal(request.normalizedDomain, "example.com");
  console.log("✓ normalized domain is stored");

  assert.equal(request.requestIpHash, "test-ip-hash");
  console.log("✓ only the supplied IP hash is stored");

  assert.equal(request.createdAt, request.updatedAt);
  console.log("✓ creation timestamps are initialized");

  console.log(
    "\n8/8 checks passed. Snapshot request persistence foundation PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
