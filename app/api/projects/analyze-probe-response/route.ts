import { NextResponse } from "next/server";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { Platform } from "@/lib/schemas/probe-analysis.schema";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  generatedPromptId?: unknown;
  prompt?: unknown;
  platform?: unknown;
  rawResponse?: unknown;
  knownCompetitors?: unknown;
}

export async function POST(req: Request) {
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
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "prompt is required" },
      { status: 400 }
    );
  }
  if (typeof body.rawResponse !== "string" || body.rawResponse.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "rawResponse is required" },
      { status: 400 }
    );
  }
  const platformResult = Platform.safeParse(body.platform);
  if (!platformResult.success) {
    return NextResponse.json(
      {
        ok: false,
        error: `platform must be one of: perplexity | chatgpt | gemini`,
      },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "analyze-probe-response",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const generatedPromptId =
    typeof body.generatedPromptId === "string" && body.generatedPromptId.trim().length > 0
      ? body.generatedPromptId
      : null;

  const knownCompetitors = Array.isArray(body.knownCompetitors)
    ? body.knownCompetitors.filter((c): c is string => typeof c === "string")
    : undefined;

  const result = await analyzeProbeResponse({
    projectId: body.projectId,
    generatedPromptId,
    prompt: body.prompt,
    platform: platformResult.data,
    rawResponse: body.rawResponse,
    knownCompetitors,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, probeRunId: result.probeRunId ?? null },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      probeRunId: result.probeRunId,
      result: result.result,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
