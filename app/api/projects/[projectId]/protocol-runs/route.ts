/**
 * M5-A — `POST /api/projects/:projectId/protocol-runs`
 *
 * Enqueues one protocol execution job. That is the whole contract.
 *
 * The request path never calls a provider, never reserves spend and never
 * touches an attempt: it writes a single queued job row and returns. All
 * paid work happens later, in the worker, under a claim token and behind
 * the SQL admission gate. A user hammering this endpoint therefore cannot
 * spend anything — `enqueue_protocol_execution_job` is idempotent per
 * protocol, so the second call returns ALREADY_EXISTS with the same job.
 *
 * Security contract, identical in shape to the export route:
 *   - unauthenticated          → 401
 *   - project missing          → 404
 *   - not on the allowlist     → 403 not_invited
 *   - non-owner / legacy owner → 404 (byte-identical; enumeration guard)
 *   - owner but not a founder  → 403 founder_only
 *   - protocol not in project  → 404
 *   - protocol not approved    → 409
 *   - owner + approved         → 200/201
 *
 * The response carries closed labels and identifiers only: no claim
 * token, no prompt text, no cost, no provider detail.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";
import { isFounderEmail } from "@/lib/auth/founder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  const { projectId } = await params;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "projectId is required" }, { status: 400 });
  }

  let owner: Awaited<ReturnType<typeof requireProjectOwner>>;
  try {
    owner = await requireProjectOwner(projectId);
  } catch (err) {
    const resp = authErrorResponse(err, { route: `protocol-runs/${projectId}`, projectId });
    if (resp) return resp;
    throw err;
  }

  // A queued job is claimed by the next worker start, whoever asked for that
  // start. While V1 is founder-operated, only a founder may put one there.
  if (!isFounderEmail(owner.user.email)) {
    return NextResponse.json({ ok: false, error: "founder_only" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }
  const protocolId = (body as { protocolId?: unknown } | null)?.protocolId;
  if (typeof protocolId !== "string" || protocolId.trim().length === 0) {
    return NextResponse.json({ ok: false, error: "protocolId is required" }, { status: 400 });
  }

  const db = getDb();

  // Tenant check before the enqueue RPC: a protocol id belonging to another
  // project must be indistinguishable from one that does not exist.
  const protocol = await db.getProtocol(protocolId, projectId);
  if (!protocol) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const result = await db.enqueueProtocolExecutionJob({ protocolId, projectId });

  switch (result.outcome) {
    case "QUEUED":
      return NextResponse.json(
        { ok: true, outcome: result.outcome, jobId: result.job?.id ?? null },
        { status: 201 }
      );
    case "ALREADY_EXISTS":
      return NextResponse.json(
        { ok: true, outcome: result.outcome, jobId: result.job?.id ?? null },
        { status: 200 }
      );
    case "PROTOCOL_NOT_FOUND":
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    case "PROTOCOL_NOT_APPROVED":
    case "NO_BASELINE_RUNS_PLANNED":
      return NextResponse.json(
        { ok: false, error: "not_executable", outcome: result.outcome },
        { status: 409 }
      );
    default: {
      // Exhaustiveness: a new outcome must not silently read as success.
      const unexpected: never = result.outcome;
      return NextResponse.json(
        { ok: false, error: "unexpected_outcome", outcome: unexpected as string },
        { status: 500 }
      );
    }
  }
}
