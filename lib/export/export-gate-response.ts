import { NextResponse } from "next/server";
import { evaluateReportIntegrity } from "@/lib/export/report-integrity";

/**
 * M3 reliquat — the canonical integrity contract (METHODOLOGY.md §16),
 * evaluated on a newly-built export artifact before it is ever returned
 * to a caller. `app/api/projects/[projectId]/export/route.ts`'s `GET`
 * calls this directly — it is the single real generation/export
 * boundary for a new V1 report, and this is not a parallel or
 * duplicated implementation of its gate logic.
 *
 * Lives outside the route file because Next.js's App Router route
 * contract only permits specific named exports (`GET`, `runtime`,
 * `dynamic`, etc.) from a `route.ts` file — any other export fails the
 * generated route type check. Extracting this here lets an integration
 * test call the exact function the route calls for all three integrity
 * outcomes, rather than re-implementing or only exercising the
 * standalone `evaluateReportIntegrity` classifier in isolation.
 *
 * `blocked`/`needs_review` are reachable today with real report data
 * (build-mvp-report.ts always renders the legacy won/partial/lost
 * aggregate unconditionally). `integrity_passed` is not yet reachable
 * with real data — see report-integrity.ts's own doc comment — so a
 * test exercising that branch necessarily supplies a synthetic
 * markdown, through this same function.
 *
 * hasApprovedProtocol/hasApprovedSamplePlan/hasPaidCallReservation are
 * intentionally omitted (never asserted true) below: no protocol,
 * sample-plan, or per-paid-attempt reservation concept exists anywhere
 * in this codebase yet (M4). Omitting them — rather than inventing a
 * signal — is what keeps every real export capped below
 * integrity_passed until M4 actually ships those preconditions.
 */
export function buildExportGateResponse(input: {
  projectId: string;
  markdown: string;
  filename: string;
  warnings: { secretsRedactedCount: number; notReadyAssetCount: number };
  hasCompleteEvidenceHashes: boolean;
}): NextResponse {
  const integrity = evaluateReportIntegrity({
    markdown: input.markdown,
    hasCompleteEvidenceHashes: input.hasCompleteEvidenceHashes,
  });

  if (integrity.status !== "integrity_passed") {
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "export_not_delivered",
        route: `export/${input.projectId}`,
        projectId: input.projectId,
        integrityStatus: integrity.status,
        reasons: integrity.reasons,
      })
    );
    // Read-only contract preserved: no database write, no "mark as
    // exported" flag, no side effect either way. The markdown body is
    // simply never included in the response — blocked and needs_review
    // both refuse automatic delivery of the artifact itself.
    //
    // `deliverable: false` is explicit and redundant with
    // `integrityStatus` on purpose: `ok: true` alone only means "the
    // request was handled," not "here is the report" — a consumer that
    // checks only `ok` (never `integrityStatus`, never Content-Type)
    // must still be unable to mistake this for a delivered artifact.
    //
    // The same signal is also exposed as response headers
    // (X-Zypact-Integrity-Status / X-Zypact-Deliverable), mirrored below
    // on the integrity_passed branch too — a consumer can gate a
    // download on headers alone, uniformly, without needing to branch on
    // body shape (JSON here vs raw markdown there) before deciding
    // whether it is even safe to read the body as a report.
    return NextResponse.json(
      {
        ok: true,
        deliverable: false,
        integrityStatus: integrity.status,
        reasons: integrity.reasons,
      },
      {
        status: 200,
        headers: {
          "X-Zypact-Integrity-Status": integrity.status,
          "X-Zypact-Deliverable": "false",
        },
      }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "export_generated",
      route: `export/${input.projectId}`,
      projectId: input.projectId,
      bytes: input.markdown.length,
      secretsRedactedCount: input.warnings.secretsRedactedCount,
      notReadyAssetCount: input.warnings.notReadyAssetCount,
    })
  );

  return new NextResponse(input.markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${input.filename}"`,
      "Cache-Control": "no-store",
      "X-Zypact-Export-Version": "1",
      "X-Zypact-Redactions": String(input.warnings.secretsRedactedCount),
      "X-Zypact-Integrity-Status": integrity.status,
      "X-Zypact-Deliverable": "true",
    },
  });
}
