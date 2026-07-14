import { NextResponse } from "next/server";
import { generateFixBrief } from "@/lib/pipeline/generate-fix-brief";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  gapId?: unknown;
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
  if (typeof body.gapId !== "string" || body.gapId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "gapId is required" },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "generate-fix-brief",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await generateFixBrief({
    projectId: body.projectId,
    gapId: body.gapId,
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
      fixBrief: result.fixBrief,
      output: result.output,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
