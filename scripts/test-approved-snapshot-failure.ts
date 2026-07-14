import { strict as assert } from "node:assert";
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

async function countRows(
  table: string,
  projectId: string
): Promise<number> {
  const { count, error } =
    await client
      .from(table)
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("project_id", projectId);

  if (error) throw error;

  return count ?? 0;
}

async function main() {
  const suffix =
    `${Date.now()}-${randomUUID().slice(0, 8)}`;

  const requestId =
    randomUUID();

  const approvedBy =
    randomUUID();

  const reservedDomain =
    `reserved-${suffix}.example.com`;

  const requestedDomain =
    `requested-${suffix}.example.com`;

  let projectId = "";

  try {
    const { error: insertError } =
      await client
        .from("snapshot_requests")
        .insert({
          id: requestId,
          work_email:
            `failure-${suffix}@example.com`,
          normalized_email:
            `failure-${suffix}@example.com`,
          company_name:
            `Failure Test ${suffix}`,
          website_url:
            `https://${requestedDomain}`,
          normalized_domain:
            reservedDomain,
          buyer_category:
            "B2B SaaS analytics",
          status: "queued",
          request_ip_hash:
            randomBytes(32).toString("hex"),
          verified_at:
            new Date().toISOString(),
          approved_at:
            new Date().toISOString(),
          approved_by: approvedBy,
        });

    if (insertError) {
      throw insertError;
    }

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
          `/tmp/zypact-failure-${suffix}.md`,
          "--execute",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: "utf8",
        }
      );

    const output =
      `${command.stdout ?? ""}\n${command.stderr ?? ""}`;

    assert.notEqual(
      command.status,
      0
    );

    console.log(
      "✓ deterministic runner failure occurred"
    );

    const {
      data: request,
      error: requestError,
    } = await client
      .from("snapshot_requests")
      .select(
        "status,project_id,progress_stage"
      )
      .eq("id", requestId)
      .single();

    if (requestError) {
      throw requestError;
    }

    assert.equal(
      request.status,
      "failed"
    );

    assert.ok(
      request.project_id
    );

    projectId =
      request.project_id;

    assert.equal(
      request.progress_stage,
      "reserved"
    );

    console.log(
      "✓ failure after reservation records failed"
    );

    const {
      data: projects,
      error: projectError,
    } = await client
      .from("projects")
      .select("id")
      .eq("id", projectId);

    if (projectError) {
      throw projectError;
    }

    assert.equal(
      projects?.length,
      1
    );

    console.log(
      "✓ failure keeps exactly one reserved project"
    );

    const [
      pages,
      prompts,
      probes,
    ] = await Promise.all([
      countRows(
        "site_pages",
        projectId
      ),
      countRows(
        "generated_prompts",
        projectId
      ),
      countRows(
        "probe_results",
        projectId
      ),
    ]);

    assert.equal(pages, 0);
    assert.equal(prompts, 0);
    assert.equal(probes, 0);

    console.log(
      "✓ deterministic failure created no pipeline rows"
    );

    assert.doesNotMatch(
      output,
      /api\.perplexity\.ai/i
    );

    console.log(
      "✓ failure test made no Perplexity request"
    );

    console.log(
      "\n5/5 checks passed. Approved snapshot failure PASSED."
    );
  } finally {
    let cleanupProjectId =
      projectId;

    if (!cleanupProjectId) {
      const {
        data: cleanupRequest,
        error: cleanupLookupError,
      } = await client
        .from("snapshot_requests")
        .select("project_id")
        .eq("id", requestId)
        .maybeSingle();

      if (cleanupLookupError) {
        throw cleanupLookupError;
      }

      cleanupProjectId =
        cleanupRequest?.project_id ?? "";
    }

    const {
      error: requestDeleteError,
    } = await client
      .from("snapshot_requests")
      .delete()
      .eq("id", requestId);

    if (requestDeleteError) {
      throw requestDeleteError;
    }

    if (cleanupProjectId) {
      const {
        error: projectDeleteError,
      } = await client
        .from("projects")
        .delete()
        .eq("id", cleanupProjectId);

      if (projectDeleteError) {
        throw projectDeleteError;
      }
    }

    console.log(
      "✓ temporary failure test data deleted"
    );

  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
