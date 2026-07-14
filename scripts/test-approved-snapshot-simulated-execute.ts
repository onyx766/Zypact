import { strict as assert } from "node:assert";
import {
  existsSync,
  readFileSync,
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

  const companyName =
    `Simulated Execution Test ${suffix}`;

  const outputPath =
    `/tmp/zypact-approved-execute-${suffix}.md`;

  const shortReportPath =
    outputPath.replace(/\.md$/i, "") +
    "-short.md";

  const requestId = randomUUID();
  const approvedBy = randomUUID();

  let projectId = "";

  try {
    const {
      error: insertError,
    } = await client
      .from("snapshot_requests")
      .insert({
        id: requestId,
        work_email:
          `execute-${suffix}@example.com`,
        normalized_email:
          `execute-${suffix}@example.com`,
        company_name: companyName,
        website_url:
          "https://example.com",
        normalized_domain:
          "example.com",
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

    console.log(
      "✓ temporary approved request created"
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
          "Example Analytics,Example Insights",
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

    console.log(output);

    if (command.status !== 0) {
      throw new Error(
        `Orchestrator exited with status ${command.status ?? "unknown"}.`
      );
    }

    assert.match(
      output,
      /Approved snapshot runner completed\./
    );

    assert.match(
      output,
      /probe mode\s+:\s+simulated/
    );

    console.log(
      "✓ simulated orchestrator completed"
    );

    const {
      data: storedRequest,
      error: requestError,
    } = await client
      .from("snapshot_requests")
      .select(
        "status,project_id,progress_stage,progress_updated_at"
      )
      .eq("id", requestId)
      .single();

    if (requestError) {
      throw requestError;
    }

    assert.equal(
      storedRequest.status,
      "report_ready"
    );

    console.log(
      "✓ successful execution reached report_ready"
    );

    assert.ok(
      storedRequest.project_id
    );

    assert.equal(
      storedRequest.progress_stage,
      "quality_review"
    );

    assert.ok(
      storedRequest.progress_updated_at
    );

    console.log(
      "✓ real progress reached quality_review"
    );

    projectId =
      storedRequest.project_id;

    console.log(
      "✓ queued request moved to running with a project"
    );

    const {
      data: projects,
      error: projectError,
    } = await client
      .from("projects")
      .select(
        "id,company_name,domain,category"
      )
      .eq("company_name", companyName);

    if (projectError) {
      throw projectError;
    }

    assert.equal(
      projects?.length,
      1
    );

    assert.equal(
      projects?.[0]?.id,
      projectId
    );

    assert.equal(
      projects?.[0]?.domain,
      "example.com"
    );

    console.log(
      "✓ exactly one reserved project was used"
    );

    const [
      pages,
      mirrors,
      prompts,
      probeRuns,
      probeResults,
    ] = await Promise.all([
      countRows(
        "site_pages",
        projectId
      ),
      countRows(
        "mirror_profiles",
        projectId
      ),
      countRows(
        "generated_prompts",
        projectId
      ),
      countRows(
        "probe_runs",
        projectId
      ),
      countRows(
        "probe_results",
        projectId
      ),
    ]);

    assert.ok(pages >= 1);
    assert.equal(mirrors, 1);
    assert.ok(prompts >= 5);
    assert.equal(probeRuns, 15);
    assert.equal(probeResults, 15);

    console.log(
      "✓ crawl, Mirror Profile, prompts and 15 simulated checks were stored"
    );

    const {
      count: liveCount,
      error: liveError,
    } = await client
      .from("probe_results")
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("project_id", projectId)
      .eq(
        "probe_mode",
        "live_perplexity"
      );

    if (liveError) {
      throw liveError;
    }

    assert.equal(
      liveCount ?? 0,
      0
    );

    console.log(
      "✓ no live Perplexity result was created"
    );

    assert.equal(
      existsSync(outputPath),
      true
    );

    const report =
      readFileSync(
        outputPath,
        "utf8"
      );

    assert.ok(
      report.length > 500
    );

    assert.match(
      report,
      /simulated/i
    );

    console.log(
      "✓ simulated MVP report was generated"
    );

    assert.equal(
      existsSync(shortReportPath),
      true
    );

    const shortReport =
      readFileSync(
        shortReportPath,
        "utf8"
      );

    assert.ok(
      shortReport.length > 300
    );

    assert.ok(
      shortReport.includes(
        `# Zypact Short Report — ${companyName}`
      )
    );

    assert.ok(
      shortReport.includes(
        "## 1. Executive diagnosis"
      )
    );

    assert.equal(
      shortReport.includes("projectId"),
      false
    );

    console.log(
      "✓ existing 14B short report was generated"
    );

    console.log(
      "\n9/9 checks passed. Approved snapshot simulated execution PASSED."
    );
  } finally {
    rmSync(
      shortReportPath,
      {
        force: true,
      }
    );
    let cleanupProjectId =
      projectId;

    if (!cleanupProjectId) {
      const {
        data,
      } = await client
        .from("snapshot_requests")
        .select("project_id")
        .eq("id", requestId)
        .maybeSingle();

      cleanupProjectId =
        data?.project_id ?? "";
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

    rmSync(
      outputPath,
      {
        force: true,
      }
    );

    console.log(
      "✓ all simulated execution test data deleted"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
