#!/usr/bin/env tsx
/**
 * Resolves a protocol execution job that is stuck on `needs_review`.
 *
 * A worker cannot do this: every recovery RPC needs a claim token, and a
 * needs_review job is not claimable by design. The reviewer is the authority,
 * so the resolution comes from here (and, later, from the admin UI that calls
 * the same RPC).
 *
 * Two resolutions, both honest about what is unknown:
 *
 *   excluded_and_completed — the ambiguous attempts are marked `excluded` and
 *     the job succeeds on the evidence that IS confirmed. Nothing is assumed
 *     about the excluded calls; the report shows them excluded, not observed.
 *
 *   failed — the job is closed as failed. Use when the confirmed evidence is
 *     too thin to report at all.
 *
 * A note is mandatory. The record must say why a human overrode an automated
 * fail-closed decision.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
 *     scripts/resolve-protocol-job-review.ts \
 *       --job-id <uuid> --reviewed-by <uuid> \
 *       --resolution excluded_and_completed --note "..."
 */

import { createClient } from "@supabase/supabase-js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLUTIONS = ["excluded_and_completed", "failed"] as const;

type Resolution = (typeof RESOLUTIONS)[number];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let jobId = "";
  let reviewedBy = "";
  let resolution = "";
  let note = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] ?? "";

    if (arg === "--job-id") { jobId = next; i += 1; }
    else if (arg === "--reviewed-by") { reviewedBy = next; i += 1; }
    else if (arg === "--resolution") { resolution = next; i += 1; }
    else if (arg === "--note") { note = next; i += 1; }
    else fail(`Unknown argument: ${arg}`);
  }

  if (!UUID.test(jobId)) fail("--job-id must be a valid UUID.");
  if (!UUID.test(reviewedBy)) fail("--reviewed-by must be a valid UUID.");
  if (!RESOLUTIONS.includes(resolution as Resolution)) {
    fail(`--resolution must be one of: ${RESOLUTIONS.join(", ")}`);
  }
  if (!note.trim()) fail("--note is required.");

  return {
    jobId,
    reviewedBy,
    resolution: resolution as Resolution,
    note: note.trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail(
      "Supabase service-role configuration is required. Run with DOTENV_CONFIG_PATH=.env.local."
    );
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: job, error: jobError } = await client
    .from("protocol_execution_jobs")
    .select("id,project_id,status,needs_review_reason,protocol_id")
    .eq("id", args.jobId)
    .maybeSingle();

  if (jobError) fail(`Lookup failed: ${jobError.message}`);
  if (!job) fail(`Job ${args.jobId} was not found.`);

  const row = job as Record<string, any>;

  if (row.status !== "needs_review") {
    fail(
      `Job is '${row.status}', not 'needs_review'. Only a job awaiting review can be resolved.`
    );
  }

  const { data, error } = await client.rpc(
    "resolve_protocol_job_review",
    {
      p_job_id: args.jobId,
      p_project_id: row.project_id,
      p_reviewed_by: args.reviewedBy,
      p_resolution: args.resolution,
      p_note: args.note,
    }
  );

  if (error) fail(`Resolution failed: ${error.message}`);

  const resolved = Array.isArray(data) ? data[0] : data;
  if (!resolved) {
    fail("Resolution was refused. The job must still be in 'needs_review'.");
  }

  console.log(
    JSON.stringify(
      {
        status: "resolved",
        jobId: resolved.id,
        jobStatus: resolved.status,
        resolution: resolved.review_resolution,
        reviewedAt: resolved.reviewed_at,
        originalReason: row.needs_review_reason,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
