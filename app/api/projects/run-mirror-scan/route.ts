import { NextResponse } from "next/server";
import { runMirrorScan } from "@/lib/pipeline/run-mirror-scan";
import { requireInvitedUser } from "@/lib/auth/current-user";
import { authErrorResponse, legacyPipelineRefusal } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  websiteUrl?: unknown;
  companyName?: unknown;
}

function ensureProtocol(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function POST(req: Request) {
  const refused = legacyPipelineRefusal("run-mirror-scan");
  if (refused) return refused;
  let user;
  try {
    user = await requireInvitedUser();
  } catch (err) {
    const resp = authErrorResponse(err, { route: "run-mirror-scan" });
    if (resp) return resp;
    throw err;
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.websiteUrl !== "string" || body.websiteUrl.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "websiteUrl is required" },
      { status: 400 }
    );
  }
  const websiteUrl = ensureProtocol(body.websiteUrl);
  const companyName =
    typeof body.companyName === "string" && body.companyName.trim().length > 0
      ? body.companyName.trim()
      : undefined;

  const result = await runMirrorScan({
    websiteUrl,
    companyName,
    userId: user.id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, projectId: result.project?.id ?? null },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      projectId: result.project.id,
      mirrorProfile: result.mirrorProfile,
      pagesCrawled: result.pages.length,
      usedMock: result.usedMock,
      usedRetry: result.usedRetry,
    },
    { status: 200 }
  );
}
