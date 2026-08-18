import { NextResponse } from "next/server";
import { toSnapshotReportPublicationState } from "./report-publication-state";
import type { SnapshotReportArtifact } from "@/lib/db/types";

/**
 * SQLSTATEs `replace_undelivered_snapshot_report_artifact` raises deliberately.
 *
 * Migration 0035 signals every precondition failure with an explicit errcode:
 *   40001 serialization_failure    revision changed since preview
 *   55P03 lock_not_available       a delivery claim is held
 *   22023 invalid_parameter_value  wrong status / artifact mismatch / delivered
 *   P0002 no_data_found            request or artifact absent
 *
 * Only these mean "the founder's view is stale". Anything else — an outage, a
 * TypeError, an unknown code — is an incident, and reporting it as a conflict
 * would tell the founder to refresh while hiding a real failure.
 */
const EXPECTED_CONFLICT_SQLSTATES = new Set([
  "40001", "serialization_failure",
  "55P03", "lock_not_available",
  "22023", "invalid_parameter_value",
  "P0002", "no_data_found",
]);

export function isExpectedReportReplacementConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && EXPECTED_CONFLICT_SQLSTATES.has(code);
}

export const CONFLICT_MESSAGE =
  "The report changed or became locked. Refresh before replacing it.";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export interface ReplaceReportDeps {
  requireCurrentUser: () => Promise<{ email: string | null } | null>;
  isFounderEmail: (email: string | null) => boolean;
  getSnapshotReportArtifact: (
    requestId: string
  ) => Promise<SnapshotReportArtifact | null>;
  replaceUndeliveredSnapshotReportArtifact: (input: {
    snapshotRequestId: string;
    expectedArtifactId: string;
    expectedRevision: string;
    fullReportMarkdown: string;
    shortReportMarkdown: string;
  }) => Promise<{ artifactId: string; revision: string } | null>;
}

/**
 * Founder-only atomic replacement of a stored, undelivered snapshot report.
 *
 * Dependencies are injected so the exact production control flow is the thing
 * under test — the previous revision of this route was only ever asserted by
 * pattern matching, which is how an over-broad catch survived review.
 */
export function createReplaceReportHandler(deps: ReplaceReportDeps) {
  return async function POST(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
  ): Promise<Response> {
    const resolvedParams = await params;
    let user: { email: string | null } | null;
    try {
      user = await deps.requireCurrentUser();
    } catch {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // Matches sibling internal routes: a non-founder learns nothing about
    // whether the request exists.
    if (!user || !deps.isFounderEmail(user.email)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const {
      expectedArtifactId,
      expectedRevision,
      fullReportMarkdown,
      shortReportMarkdown,
    } = (body ?? {}) as Record<string, unknown>;

    if (!isNonEmptyString(expectedArtifactId) || !UUID.test(expectedArtifactId)) {
      return NextResponse.json(
        { error: "invalid_expected_artifact_id" },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(expectedRevision)) {
      return NextResponse.json(
        { error: "invalid_expected_revision" },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(fullReportMarkdown)) {
      return NextResponse.json(
        { error: "invalid_full_report_markdown" },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(shortReportMarkdown)) {
      return NextResponse.json(
        { error: "invalid_short_report_markdown" },
        { status: 400 }
      );
    }

    const existing = await deps.getSnapshotReportArtifact(resolvedParams.requestId);
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Narrow boundary: ONLY the replacement RPC may produce a 409. Auth,
    // validation, the reload and serialisation are deliberately outside it.
    let replaced: { artifactId: string; revision: string } | null;
    try {
      replaced = await deps.replaceUndeliveredSnapshotReportArtifact({
        snapshotRequestId: resolvedParams.requestId,
        expectedArtifactId,
        expectedRevision,
        fullReportMarkdown,
        shortReportMarkdown,
      });
    } catch (error) {
      if (isExpectedReportReplacementConflict(error)) {
        return NextResponse.json(
          { error: "conflict", message: CONFLICT_MESSAGE },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }

    // A null return also means a precondition rejected the write.
    if (!replaced) {
      return NextResponse.json(
        { error: "conflict", message: CONFLICT_MESSAGE },
        { status: 409 }
      );
    }

    // The write already happened. A reload failure here is an incident, not a
    // conflict: retrying or reporting "refresh" would both be wrong, and no
    // second replacement is attempted.
    let current: SnapshotReportArtifact | null;
    try {
      current = await deps.getSnapshotReportArtifact(resolvedParams.requestId);
    } catch {
      return NextResponse.json(
        {
          error: "replacement_applied_reload_failed",
          message:
            "The replacement was applied but its state could not be re-read. Refresh the page.",
        },
        { status: 500 }
      );
    }
    if (!current) {
      return NextResponse.json(
        { error: "replacement_applied_reload_failed" },
        { status: 500 }
      );
    }

    return NextResponse.json(toSnapshotReportPublicationState(current), {
      status: 200,
    });
  };
}
