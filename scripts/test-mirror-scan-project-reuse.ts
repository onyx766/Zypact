import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { memoryAdapter } from "../lib/db/memory-adapter";
import {
  resolveMirrorScanProject,
} from "../lib/pipeline/run-mirror-scan";

async function main() {
  const suffix = randomUUID();
  const domain =
    `reserved-${suffix}.example.com`;

  const reservedProject =
    await memoryAdapter.createProject({
      domain,
      companyName:
        "Reserved Mirror Test",
      userId: null,
    });

  const resolved =
    await resolveMirrorScanProject(
      {
        websiteUrl:
          `https://${domain}`,
        companyName:
          "Reserved Mirror Test",
        projectId:
          reservedProject.id,
      },
      memoryAdapter
    );

  if (!resolved.ok) {
    throw new Error(
      "Expected reserved project resolution to succeed"
    );
  }

  assert.equal(
    resolved.project.id,
    reservedProject.id
  );

  assert.equal(
    resolved.created,
    false
  );

  console.log(
    "✓ reserved project is reused"
  );

  const repeated =
    await resolveMirrorScanProject(
      {
        websiteUrl:
          `https://www.${domain}`,
        projectId:
          reservedProject.id,
      },
      memoryAdapter
    );

  if (!repeated.ok) {
    throw new Error(
      "Expected repeated project resolution to succeed"
    );
  }

  assert.equal(
    repeated.project.id,
    reservedProject.id
  );

  console.log(
    "✓ repeated resolution keeps the same project"
  );

  const mismatch =
    await resolveMirrorScanProject(
      {
        websiteUrl:
          "https://different.example.com",
        projectId:
          reservedProject.id,
      },
      memoryAdapter
    );

  assert.equal(mismatch.ok, false);

  console.log(
    "✓ mismatched domains are rejected"
  );

  const missing =
    await resolveMirrorScanProject(
      {
        websiteUrl:
          `https://${domain}`,
        projectId:
          randomUUID(),
      },
      memoryAdapter
    );

  assert.equal(missing.ok, false);

  console.log(
    "✓ missing reserved projects are rejected"
  );

  const freshDomain =
    `fresh-${suffix}.example.com`;

  const fresh =
    await resolveMirrorScanProject(
      {
        websiteUrl:
          `https://${freshDomain}`,
        companyName:
          "Fresh Mirror Test",
        userId: null,
      },
      memoryAdapter
    );

  if (!fresh.ok) {
    throw new Error(
      "Expected fresh project resolution to succeed"
    );
  }

  assert.equal(fresh.created, true);
  assert.equal(
    fresh.project.domain,
    freshDomain
  );

  console.log(
    "✓ normal scans can still create a project"
  );

  const source = readFileSync(
    "lib/pipeline/run-mirror-scan.ts",
    "utf8"
  );

  assert.match(
    source,
    /resolveMirrorScanProject/
  );

  assert.match(
    source,
    /const project =\s+resolvedProject\.project/
  );

  console.log(
    "✓ Mirror Scan uses the resolved project"
  );

  console.log(
    "\n6/6 checks passed. Mirror project reuse PASSED."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
