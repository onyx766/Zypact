/**
 * Sprint 10 — Supabase table-row validation.
 *
 * Companion to `test:full-pipeline`. After running the full pipeline
 * against Supabase, this script uses the same env vars to talk to
 * Supabase directly and print a row count for every one of the 13
 * MVP tables scoped to the project we just created (and, for the
 * whole-table counts, the totals across all projects).
 *
 * Usage:
 *   npx tsx scripts/verify-supabase-tables.ts <projectId>
 *
 * Fails with non-zero exit if any of the 13 tables has zero rows for
 * the given project. Purely read-only.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const TABLES = [
  "projects",
  "site_pages",
  "mirror_profiles",
  "generated_prompts",
  "probe_runs",
  "probe_results",
  "competitors",
  "gap_maps",
  "gaps",
  "evidence_banks",
  "fix_briefs",
  "generated_assets",
  "qa_reports",
] as const;

async function main() {
  const projectId = process.argv[2]?.trim();
  if (!projectId) {
    console.error("Usage: tsx scripts/verify-supabase-tables.ts <projectId>");
    process.exit(2);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
    );
    process.exit(2);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("");
  console.log(`Supabase table-row counts for project ${projectId}`);
  console.log("─────────────────────────────────────────────────────");

  const failures: string[] = [];

  for (const table of TABLES) {
    // `projects` is scoped by `id`, not `project_id`.
    const filterColumn = table === "projects" ? "id" : "project_id";

    const { count, error } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(filterColumn, projectId);

    if (error) {
      console.error(`✗ ${table.padEnd(20, " ")} — ERROR: ${error.message}`);
      failures.push(`${table}: ${error.message}`);
      continue;
    }

    const rows = count ?? 0;
    const label = rows > 0 ? "✓" : "✗";
    console.log(
      `${label} ${table.padEnd(20, " ")} rows(project) = ${rows}`
    );
    if (rows === 0) {
      failures.push(`${table} has zero rows for project ${projectId}`);
    }
  }

  console.log("─────────────────────────────────────────────────────");
  if (failures.length > 0) {
    console.error(
      `✗ Supabase table validation FAILED (${failures.length} table${
        failures.length === 1 ? "" : "s"
      } empty or errored):`
    );
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log("Supabase table validation PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
