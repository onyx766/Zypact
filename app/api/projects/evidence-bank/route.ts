import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  EvidenceBankInputSchema,
  EvidenceBankOutputSchema,
} from "@/lib/schemas/evidence-bank.schema";
import { getOrCreateEvidenceBank } from "@/lib/pipeline/get-or-create-evidence-bank";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/* -------------------------------------------------------------------------- */
/*  GET — return existing bank, or create a prefill draft from Mirror Profile */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId || projectId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId is required" },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "evidence-bank/GET",
      projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await getOrCreateEvidenceBank(projectId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status ?? 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    projectId,
    evidenceBank: result.bank,
    created: result.created,
  });
}

/* -------------------------------------------------------------------------- */
/*  POST — upsert edited bank                                                 */
/* -------------------------------------------------------------------------- */

interface PostBody {
  projectId?: unknown;
  evidenceBank?: unknown;
}

export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.projectId !== "string" || body.projectId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId is required" },
      { status: 400 }
    );
  }

  const parsed = EvidenceBankInputSchema.safeParse(body.evidenceBank);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Evidence Bank failed validation",
        issues: parsed.error.issues,
      },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "evidence-bank/POST",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const db = getDb();

  // Sprint 12 — POST always means "a user just edited this bank". Force
  // provenance to `user_edited` regardless of what the client sent, so a
  // client cannot claim `user_reviewed` (which is reserved for a future
  // explicit review UI).
  const saved = await db.upsertEvidenceBank(body.projectId, {
    ...parsed.data,
    provenance: "user_edited",
  });

  // Round-trip validation against the output schema — catches DB shape drift.
  const revalidated = EvidenceBankOutputSchema.safeParse(saved);
  if (!revalidated.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Stored Evidence Bank failed re-validation",
        issues: revalidated.error.issues,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    projectId: body.projectId,
    evidenceBank: revalidated.data,
  });
}
