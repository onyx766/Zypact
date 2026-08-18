import { NextResponse } from "next/server";
import {
  requireCurrentUser,
} from "@/lib/auth/current-user";
import {
  authErrorResponse,
} from "@/lib/auth/route-helpers";
import {
  isFounderEmail,
} from "@/lib/auth/founder";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function notFoundResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "not_found",
    },
    { status: 404 }
  );
}

function safeFilename(
  value: string
): string {
  return value.replace(
    /["\r\n]/g,
    "_"
  );
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      requestId: string;
      kind: string;
    }>;
  }
) {
  let user;

  try {
    user = await requireCurrentUser();
  } catch (error) {
    const response = authErrorResponse(error, {
      route:
        "snapshot-founder-report-download",
      projectId: null,
    });

    if (response) {
      return response;
    }

    throw error;
  }

  if (!isFounderEmail(user.email)) {
    return notFoundResponse();
  }

  const {
    requestId,
    kind,
  } = await context.params;

  if (
    !UUID_PATTERN.test(requestId) ||
    (kind !== "short" &&
      kind !== "full")
  ) {
    return notFoundResponse();
  }

  const artifact =
    await getDb()
      .getSnapshotReportArtifact(
        requestId
      );

  if (!artifact) {
    return notFoundResponse();
  }

  const markdown =
    kind === "short"
      ? artifact.shortReportMarkdown
      : artifact.fullReportMarkdown;

  const filename =
    safeFilename(
      kind === "short"
        ? artifact.shortReportFilename
        : artifact.fullReportFilename
    );

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "Content-Type":
        "text/markdown; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
