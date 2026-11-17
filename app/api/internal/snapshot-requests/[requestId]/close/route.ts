import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import type { CloseFailedSnapshotRequestOutcome } from "@/lib/db/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_NOTE_LENGTH = 10;
const MAX_NOTE_LENGTH = 2000;

const REFUSAL_TEXT: Record<Exclude<CloseFailedSnapshotRequestOutcome, "CLOSED" | "ALREADY_CLOSED">, string> = {
  REQUEST_NOT_FOUND: "This request no longer exists.",
  REQUEST_NOT_CLOSABLE:
    "Only an approved request whose measurement stopped can be closed here. A request still waiting for approval is rejected instead.",
  JOB_NOT_ENDED_IN_FAILURE:
    "This request's measurement has not stopped in failure, so it cannot be closed. A measurement held for review is resolved first.",
  REPORT_PRESENT:
    "A report exists for this request, so it is not closed automatically. Look at the report first.",
};

/**
 * POST /api/internal/snapshot-requests/:requestId/close
 *
 * D-052 — closes an approved request whose measurement stopped in failure.
 * The request moves to the existing `failed` status, which no longer blocks
 * a new audit of the same website, and who closed it and why is recorded.
 * The measurement's evidence is kept exactly as it is. Nothing is sent to
 * the requester.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Closing a request is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute("snapshot-request-close");
  if (!guard.ok) return guard.response;

  const { requestId } = await params;
  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ ok: false, error: "invalid_request_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { note } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof note !== "string" ||
    note.trim().length < MIN_NOTE_LENGTH ||
    note.length > MAX_NOTE_LENGTH
  ) {
    return NextResponse.json(
      { ok: false, error: `A note of ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters is required.` },
      { status: 400 }
    );
  }

  const outcome = await getDb().closeFailedSnapshotRequest({
    requestId,
    closedBy: guard.user.id,
    reason: note.trim(),
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "snapshot_request_close",
      requestId,
      actorUserId: guard.user.id,
      outcome,
    })
  );

  if (outcome === "CLOSED" || outcome === "ALREADY_CLOSED") {
    return NextResponse.json(
      {
        ok: true,
        outcome,
        detail: "Request closed. Its evidence is kept, and the website can be audited again.",
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    { ok: false, outcome, error: REFUSAL_TEXT[outcome] },
    { status: outcome === "REQUEST_NOT_FOUND" ? 404 : 409 }
  );
}
