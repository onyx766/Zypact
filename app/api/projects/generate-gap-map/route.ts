import { NextResponse } from "next/server";
import {
  generateGapMap,
  NO_COMPETITORS_MESSAGE,
  NO_PROBE_RESULTS_MESSAGE,
} from "@/lib/pipeline/generate-gap-map";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse, legacyPipelineRefusal } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
}

export async function POST(req: Request) {
  const refused = legacyPipelineRefusal("generate-gap-map");
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
      route: "generate-gap-map",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await generateGapMap({ projectId: body.projectId });

  if (!result.ok) {
    const status =
      result.error === NO_PROBE_RESULTS_MESSAGE ||
      result.error === NO_COMPETITORS_MESSAGE
        ? 409
        : 400;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  return NextResponse.json(
    {
      ok: true,
      projectId: result.projectId,
      gapMap: result.gapMap,
      prioritizedGaps: result.gaps,
      competitorDistances: result.output.competitorDistances,
      nodesCount: result.output.nodes.length,
      edgesCount: result.output.edges.length,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
      normalizedDistances: result.normalizedDistances,
    },
    { status: 200 }
  );
}
