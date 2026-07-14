import { NextResponse } from "next/server";
import { generateAsset } from "@/lib/pipeline/generate-asset";
import { AssetTypeSchema } from "@/lib/schemas/generated-asset.schema";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  projectId?: unknown;
  fixBriefId?: unknown;
  assetType?: unknown;
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
  if (
    typeof body.fixBriefId !== "string" ||
    body.fixBriefId.trim().length === 0
  ) {
    return NextResponse.json(
      { ok: false, error: "fixBriefId is required" },
      { status: 400 }
    );
  }
  const assetTypeParsed = AssetTypeSchema.safeParse(body.assetType);
  if (!assetTypeParsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: `assetType is required and must be one of: ${AssetTypeSchema.options.join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(body.projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: "generate-asset",
      projectId: body.projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const result = await generateAsset({
    projectId: body.projectId,
    fixBriefId: body.fixBriefId,
    assetType: assetTypeParsed.data,
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
      asset: result.asset,
      output: result.output,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
