import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryAdapter } from "../lib/db/memory-adapter";

async function main(): Promise<void> {
  const suffix = randomUUID();

  const request =
    await memoryAdapter.createSnapshotRequest({
      workEmail:
        `report-${suffix}@example.com`,
      normalizedEmail:
        `report-${suffix}@example.com`,
      companyName: "Artifact Test",
      websiteUrl:
        `https://artifact-${suffix}.example.com`,
      normalizedDomain:
        `artifact-${suffix}.example.com`,
      buyerCategory:
        "B2B SaaS testing",
      requestIpHash: null,
    });

  const saved =
    await memoryAdapter
      .saveSnapshotReportArtifact({
        snapshotRequestId: request.id,
        projectId: randomUUID(),
        fullReportMarkdown:
          "# Full report\n",
        shortReportMarkdown:
          "# Short report\n",
        fullReportFilename:
          "full.md",
        shortReportFilename:
          "short.md",
        generatedAt:
          new Date().toISOString(),
      });

  assert.ok(saved);

  const loaded =
    await memoryAdapter
      .getSnapshotReportArtifact(
        request.id
      );

  assert.ok(loaded);
  assert.equal(
    loaded.id,
    saved.id
  );
  assert.equal(
    loaded.snapshotRequestId,
    request.id
  );
  assert.equal(
    loaded.fullReportMarkdown,
    "# Full report\n"
  );
  assert.equal(
    loaded.shortReportMarkdown,
    "# Short report\n"
  );
  assert.equal(
    loaded.deliveredAt,
    null
  );

  console.log(
    "✓ snapshot report artifact saves and loads"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
