import { NextResponse } from "next/server";
import { generateBuyerPrompts } from "@/lib/pipeline/generate-buyer-prompts";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse, legacyPipelineRefusal } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  userInputs?: unknown;
}

interface UserInputs {
  category?: string;
  competitors?: string[];
  audience?: string[];
}

function parseUserInputs(raw: unknown): UserInputs | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const out: UserInputs = {};
  if (typeof obj.category === "string") out.category = obj.category;
  if (Array.isArray(obj.competitors))
    out.competitors = obj.competitors.filter((c): c is string => typeof c === "string");
  if (Array.isArray(obj.audience))
    out.audience = obj.audience.filter((a): a is string => typeof a === "string");
  return Object.keys(out).length ? out : undefined;
}

export async function POST(req: Request) {
  const refused = legacyPipelineRefusal("generate-buyer-prompts");
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
      route: "generate-buyer-prompts",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await generateBuyerPrompts({
    projectId: body.projectId,
    userInputs: parseUserInputs(body.userInputs),
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  return NextResponse.json(
    {
      ok: true,
      projectId: result.projectId,
      totalPrompts: result.stored.length,
      recommendedForProbe: result.output.recommendedForProbe,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
