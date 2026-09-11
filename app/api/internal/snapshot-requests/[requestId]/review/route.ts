import { NextResponse } from "next/server";

import { requireCurrentUser } from "@/lib/auth/current-user";
import { isFounderEmail } from "@/lib/auth/founder";
import { getReportServiceClient } from "@/lib/reports/service-client";
import {
  regenerateReport,
  resolveJobReview,
  type JobReviewResolution,
} from "@/lib/reports/review-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLUTIONS: readonly JobReviewResolution[] = [
  "excluded_and_completed",
  "failed",
];

/** Long enough to explain a decision, short enough not to be a dumping ground. */
const MAX_NOTE_LENGTH = 2000;
const MIN_NOTE_LENGTH = 10;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Founder-only review actions.
 *
 * Three actions, each a deliberate human decision:
 *   resolve_job — give a `needs_review` job an outcome;
 *   regenerate  — rebuild and re-classify the report without sending;
 *   deliver     — send the report to the requester.
 *
 * `deliver` is the only outward-facing one and is never implied by the others.
 * A regenerate that happened to pass the integrity gate must not put mail in a
 * customer's inbox as a side effect.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const { requestId } = await params;

  let user: { email: string | null } | null;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 404, not 403: a non-founder is not told this endpoint exists.
  if (!user || !isFounderEmail(user.email)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ ok: false, error: "invalid_request_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const { action, jobId, resolution, note } = (body ?? {}) as Record<
    string,
    unknown
  >;

  const client = getReportServiceClient();

  try {
    if (action === "resolve_job") {
      if (!isNonEmptyString(jobId) || !UUID_PATTERN.test(jobId)) {
        return NextResponse.json({ ok: false, error: "invalid_job_id" }, { status: 400 });
      }
      if (
        !isNonEmptyString(resolution) ||
        !RESOLUTIONS.includes(resolution as JobReviewResolution)
      ) {
        return NextResponse.json({ ok: false, error: "invalid_resolution" }, { status: 400 });
      }
      if (
        !isNonEmptyString(note) ||
        note.trim().length < MIN_NOTE_LENGTH ||
        note.length > MAX_NOTE_LENGTH
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: `A review note of ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters is required.`,
          },
          { status: 400 }
        );
      }

      // The reviewer is the authenticated founder, taken from the session and
      // never from the request body.
      const reviewer = await client
        .from("snapshot_requests")
        .select("approved_by")
        .eq("id", requestId)
        .maybeSingle();

      const reviewedBy = (reviewer.data as Record<string, any> | null)
        ?.approved_by;

      if (!isNonEmptyString(reviewedBy)) {
        return NextResponse.json(
          { ok: false, error: "This request has no approver to attribute the review to." },
          { status: 409 }
        );
      }

      const result = await resolveJobReview(client, {
        requestId,
        jobId,
        reviewedBy,
        resolution: resolution as JobReviewResolution,
        note: note.trim(),
      });

      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    }

    if (action === "regenerate" || action === "deliver") {
      const result = await regenerateReport(client, requestId, {
        send: action === "deliver",
      });

      const failed =
        result.outcome === "delivery_ambiguous" ||
        result.outcome === "delivery_rejected" ||
        result.outcome === "delivery_claim_unavailable" ||
        result.outcome === "persist_refused";

      return NextResponse.json(
        {
          ok: !failed,
          outcome: result.outcome,
          integrityStatus: result.integrityStatus,
          integrityReasons: result.integrityReasons,
          publicToken: result.publicToken,
          detail: result.detail ?? null,
        },
        { status: failed ? 409 : 200 }
      );
    }

    return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Review action failed.",
      },
      { status: 500 }
    );
  }
}
