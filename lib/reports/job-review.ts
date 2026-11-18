/**
 * Resolving a protocol job held for review (`needs_review`), the one way
 * both the request page and the pilot console do it: the existing
 * `resolve_protocol_job_review` RPC (0066, scoped by 0070), with its two
 * resolutions. Unconfirmed attempts become `excluded`, never completed.
 *
 * Moved here from review-actions.ts (which re-exports it, so the request
 * route is unchanged) so the pilot console (D-061) reuses the same call
 * without loading the report delivery code. The job is named by its id
 * alone; the caller resolves which job that is from its own tables, never
 * from a request body.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type JobReviewResolution = "excluded_and_completed" | "failed";

export async function resolveJobReview(
  client: SupabaseClient,
  input: {
    /** Kept so the request route's call is unchanged; the job id alone names the job. */
    requestId?: string;
    jobId: string;
    reviewedBy: string;
    resolution: JobReviewResolution;
    note: string;
  }
): Promise<{ ok: true; jobStatus: string } | { ok: false; error: string }> {
  const { data: job } = await client
    .from("protocol_execution_jobs")
    .select("id,project_id,status")
    .eq("id", input.jobId)
    .maybeSingle();

  const row = (job ?? null) as Record<string, any> | null;

  if (!row) return { ok: false, error: "Job not found." };

  if (row.status !== "needs_review") {
    return {
      ok: false,
      error: `Job is '${row.status}', not 'needs_review'. Only a job awaiting review can be resolved.`,
    };
  }

  const { data, error } = await client.rpc("resolve_protocol_job_review", {
    p_job_id: input.jobId,
    p_project_id: row.project_id,
    p_reviewed_by: input.reviewedBy,
    p_resolution: input.resolution,
    p_note: input.note,
  });

  if (error) return { ok: false, error: error.message };

  const resolved = (Array.isArray(data) ? data[0] : data) as
    | Record<string, any>
    | null;

  if (!resolved) {
    return { ok: false, error: "Resolution was refused." };
  }

  return { ok: true, jobStatus: resolved.status };
}
