import { NextResponse } from "next/server";
import {
  discoverCompetitors,
  NO_PROBE_RESULTS_MESSAGE,
} from "@/lib/pipeline/discover-competitors";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse, legacyPipelineRefusal } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  userCompetitors?: unknown;
}

export async function POST(req: Request) {
  const refused = legacyPipelineRefusal("discover-competitors");
  if (refused) return refused;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.projectId !== "string" || body.projectId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId is required" },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "discover-competitors",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const userCompetitors = Array.isArray(body.userCompetitors)
    ? body.userCompetitors
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : undefined;

  const result = await discoverCompetitors({
    projectId: body.projectId,
    userCompetitors,
  });

  if (!result.ok) {
    const status = result.error === NO_PROBE_RESULTS_MESSAGE ? 409 : 400;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  return NextResponse.json(
    {
      ok: true,
      projectId: result.projectId,
      competitors: result.stored,
      phantomCompetitors: result.output.phantomCompetitors,
      blindSpots: result.output.blindSpots,
      summary: result.output.summary,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
