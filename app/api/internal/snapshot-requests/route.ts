import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { SnapshotRequestLimitError } from "@/lib/db/types";
import {
  normalizeSnapshotRequestInput,
  SnapshotRequestValidationError,
} from "@/lib/snapshot-requests/normalize-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/internal/snapshot-requests";

/**
 * Founder-created audits (migration 0081).
 *
 * The public form at `/api/snapshot-requests` is the only other way a request
 * is created, and its four limits are written for an endpoint open to
 * strangers. A prospect the founder approached never filled that form in, so
 * three of those limits refuse work they were never meant to describe. This
 * route is the founder's own door: same validation, same normalization, same
 * table, no abuse throttles — and the public route is untouched.
 *
 * What it deliberately does NOT do:
 *
 *   - It does not approve. The row lands on `pending_approval`, which is what
 *     `approve_and_launch_snapshot_baseline` requires, so no paid provider
 *     call can happen until the founder approves it on the detail page with
 *     the competitor frame in hand.
 *   - It does not skip the active-domain check. That one is not a throttle:
 *     two live requests for one domain race for the same project reservation
 *     and would measure the same company twice, concurrently.
 *   - It does not send a verification email. There is nobody waiting to click
 *     one; the founder is the vouching party.
 */

const MAX_BODY_BYTES = 8_192;

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireFounderForRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const raw = await request.text();

  // Bounded before parsing, exactly as the public route is: an unbounded body
  // is a cost this endpoint has no reason to accept.
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "request_body_too_large" },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  let input;
  try {
    // The same normalizer the public form uses. Reused rather than restated
    // so a founder-created audit cannot carry a domain, an email or a
    // question shape the public path would have refused — one rule, one
    // implementation.
    input = normalizeSnapshotRequestInput(body);
  } catch (error) {
    if (error instanceof SnapshotRequestValidationError) {
      return NextResponse.json(
        { ok: false, error: "validation_failed", issues: error.issues },
        { status: 400 }
      );
    }
    throw error;
  }

  let created;
  try {
    created = await getDb().createFounderSnapshotRequest({
      workEmail: input.workEmail,
      normalizedEmail: input.normalizedEmail,
      companyName: input.companyName,
      contactName: input.contactName ?? null,
      websiteUrl: input.websiteUrl,
      normalizedDomain: input.normalizedDomain,
      buyerCategory: input.buyerCategory,
    });
  } catch (error) {
    if (
      error instanceof SnapshotRequestLimitError &&
      error.code === "active_domain"
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "active_domain",
          detail:
            "That domain already has an audit in progress. Finish or reject it before starting another.",
        },
        { status: 409 }
      );
    }
    throw error;
  }

  // Closed fields only: an id, a status and a domain. No email address, no
  // company name and no question text reach the log.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "founder_snapshot_request_created",
      route: ROUTE,
      requestId: created.id,
      status: created.status,
      normalizedDomain: created.normalizedDomain,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      requestId: created.id,
      status: created.status,
      origin: created.origin,
      reviewPath: `/admin/snapshot-requests/${created.id}`,
    },
    { status: 201 }
  );
}
