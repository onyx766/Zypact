import { strict as assert } from "node:assert";
import {
  existsSync,
  rmSync,
} from "node:fs";
import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  spawnSync,
} from "node:child_process";
import {
  createClient,
} from "@supabase/supabase-js";

import {
  getDb,
} from "../lib/db";

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    "Supabase service-role configuration is required."
  );
}

const client =
  createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

async function main() {
  const db = getDb();

  const suffix =
    `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const domain =
    `approved-dry-run-${suffix}.example.com`;

  const email =
    `approved-dry-run-${suffix}@example.com`;

  const outputPath =
    `/tmp/zypact-approved-dry-run-${suffix}.md`;

  let requestId = "";

  try {
    const request =
      await db.createSnapshotRequest({
        workEmail: email,
        normalizedEmail: email,
        companyName:
          "Approved Dry Run Test",
        websiteUrl:
          `https://${domain}`,
        normalizedDomain: domain,
        buyerCategory:
          "B2B SaaS analytics",
        requestIpHash:
          randomBytes(32).toString("hex"),
      });

    requestId = request.id;

    const tokenHash =
      randomBytes(32).toString("hex");

    const issued =
      await db.issueSnapshotRequestVerification({
        requestId,
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

    const approved =
      await db.approveAndQueueSnapshotRequest(
        requestId,
        randomUUID()
      );

    assert.equal(
      approved?.status,
      "queued"
    );

    assert.equal(
      approved?.projectId,
      null
    );

    console.log(
      "✓ test request is approved and queued"
    );

    const command =
      spawnSync(
        "npx",
        [
          "tsx",
          "scripts/run-approved-snapshot.ts",
          "--request-id",
          requestId,
          "--competitors",
          "Example One,Example Two",
          "--probe-mode",
          "simulated",
          "--budget-usd",
          "0",
          "--prompts",
          "5",
          "--runs",
          "3",
          "--out",
          outputPath,
          "--dry-run",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: "utf8",
        }
      );

    const output =
      `${command.stdout ?? ""}\n${command.stderr ?? ""}`;

    if (command.status !== 0) {
      throw new Error(output);
    }

    assert.match(
      output,
      /reserve on execute/
    );

    assert.match(
      output,
      /dry-run complete: no reservation, no crawl, no prompts, no probes\./
    );

    console.log(
      "✓ orchestrator prints the queued execution plan"
    );

    const {
      data: storedRequest,
      error: requestError,
    } = await client
      .from("snapshot_requests")
      .select("status,project_id")
      .eq("id", requestId)
      .single();

    if (requestError) {
      throw requestError;
    }

    assert.equal(
      storedRequest.status,
      "queued"
    );

    assert.equal(
      storedRequest.project_id,
      null
    );

    console.log(
      "✓ dry-run does not reserve or mutate the request"
    );

    const {
      data: projects,
      error: projectError,
    } = await client
      .from("projects")
      .select("id")
      .eq("domain", domain);

    if (projectError) {
      throw projectError;
    }

    assert.equal(
      projects?.length,
      0
    );

    assert.equal(
      existsSync(outputPath),
      false
    );

    console.log(
      "✓ dry-run creates no project or report file"
    );

    const source =
      await import(
        "node:fs/promises"
      ).then((fs) =>
        fs.readFile(
          "scripts/run-approved-snapshot.ts",
          "utf8"
        )
      );

    assert.match(
      source,
      /reserveSnapshotRequestProject/
    );

    assert.match(
      source,
      /"--project-id"/
    );

    console.log(
      "✓ execute path uses reservation and the reserved project ID"
    );

    console.log(
      "\n5/5 checks passed. Approved snapshot dry-run PASSED."
    );
  } finally {
    if (requestId) {
      const { error } = await client
        .from("snapshot_requests")
        .delete()
        .eq("id", requestId);

      if (error) throw error;
    }

    const { error: projectDeleteError } =
      await client
        .from("projects")
        .delete()
        .eq("domain", domain);

    if (projectDeleteError) {
      throw projectDeleteError;
    }

    rmSync(
      outputPath,
      {
        force: true,
      }
    );

    console.log(
      "✓ temporary orchestrator test data deleted"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
