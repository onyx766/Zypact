import { strict as assert } from "node:assert";
import {
  randomUUID,
} from "node:crypto";
import {
  spawnSync,
} from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Required Supabase variables are missing"
  );
}

const client = createClient(
  url,
  serviceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

async function countRows(
  table: string,
  projectId: string
): Promise<number> {
  const { count, error } = await client
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
    randomUUID().slice(0, 8);

  const domain =
    `reserved-dry-run-${suffix}.example.com`;

  let projectId = "";

  try {
    const {
      data: project,
      error: projectError,
    } = await client
      .from("projects")
      .insert({
        user_id: null,
        company_name:
          "Reserved Dry Run Test",
        domain,
        category:
          "B2B SaaS analytics",
      })
      .select("id")
      .single();

    if (projectError || !project) {
      throw (
        projectError ??
        new Error(
          "Temporary project was not created"
        )
      );
    }

    projectId = project.id;

    const command = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/mvp-scan.ts",
        "--brand",
        "Reserved Dry Run Test",
        "--domain",
        domain,
        "--category",
        "B2B SaaS analytics",
        "--competitors",
        "Example One,Example Two",
        "--project-id",
        projectId,
        "--probe-mode",
        "simulated",
        "--budget-usd",
        "0",
        "--prompts",
        "5",
        "--runs",
        "3",
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
      new RegExp(
        `reserved project:\\s+${projectId}`
      )
    );

    assert.match(
      output,
      /project\s+:\s+reuse/
    );

    assert.match(
      output,
      /dry-run complete: no paid probes, no writes\./
    );

    console.log(
      "✓ dry-run resolves the explicit reserved project"
    );

    const {
      data: storedProjects,
      error: storedProjectError,
    } = await client
      .from("projects")
      .select("id")
      .eq("domain", domain);

    if (storedProjectError) {
      throw storedProjectError;
    }

    assert.equal(
      storedProjects?.length,
      1
    );

    assert.equal(
      storedProjects?.[0]?.id,
      projectId
    );

    console.log(
      "✓ dry-run does not create a duplicate project"
    );

    const [
      pages,
      mirrors,
      prompts,
      probes,
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
    ]);

    assert.equal(pages, 0);
    assert.equal(mirrors, 0);
    assert.equal(prompts, 0);
    assert.equal(probes, 0);

    console.log(
      "✓ dry-run performs no crawl, prompt generation, or probes"
    );

    assert.doesNotMatch(
      output,
      /api\.perplexity\.ai/i
    );

    console.log(
      "✓ dry-run makes no Perplexity request"
    );

    console.log(
      "\n4/4 checks passed. Reserved-project dry-run PASSED."
    );
  } finally {
    if (projectId) {
      const { error } = await client
        .from("projects")
        .delete()
        .eq("id", projectId);

      if (error) throw error;
    }

    console.log(
      "✓ temporary dry-run project deleted"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
