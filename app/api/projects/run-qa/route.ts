import { NextResponse } from "next/server";
import { runQa } from "@/lib/pipeline/run-qa";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  assetId?: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (typeof body.projectId !== "string" || body.projectId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId is required" },
      { status: 400 }
    );
  }
  if (typeof body.assetId !== "string" || body.assetId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "assetId is required" },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "run-qa",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await runQa({
    projectId: body.projectId,
    assetId: body.assetId,
  });

  if (!result.ok) {
    const status = result.status ?? 400;
    return NextResponse.json(
      { ok: false, error: result.error },
      { status }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      projectId: result.projectId,
      qaReport: result.qaReport,
      asset: result.updatedAsset,
      output: result.output,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
