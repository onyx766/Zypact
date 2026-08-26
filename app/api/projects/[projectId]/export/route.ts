/**
 * Sprint 11 — Secure Read-Only Markdown Export.
 *
 * `GET /api/projects/:projectId/export`
 *
 * Security contract (Sprint 11 + Sprint 10.5 carryover):
 *   - unauthenticated                → 401
 *   - project missing                → 404
 *   - authenticated non-owner        → 404 (byte-identical to missing;
 *                                     enumeration guard)
 *   - legacy `user_id IS NULL`       → 404
 *   - owner                          → 200; body depends on the M3
 *                                     integrity gate (see below)
 *
 * Read-only contract:
 *   - No database writes.
 *   - No LLM calls.
 *   - No QA status mutations.
 *   - No "mark as exported" flag.
 *   - Only serializes existing validated database data.
 *
 * Secret-leak prevention:
 *   - The final markdown is swept for literal matches against every
 *     known secret env var value AND for well-known secret prefixes
 *     (`sb_secret_…`, `sk-live-…`, `sk-proj-…`, `sk-…`) before being
 *     returned. Any match is replaced with `[REDACTED]`.
 *
 * M3 integrity gate (METHODOLOGY.md §16; lib/export/report-integrity.ts):
 *   - Evaluated on every newly-built artifact before it is returned.
 *   - `integrity_passed` → 200 + `text/markdown` attachment (unchanged
 *     from before this gate existed).
 *   - `needs_review` / `blocked` → 200 + JSON
 *     `{ ok: true, integrityStatus, reasons }`; the markdown body is
 *     never included in the response. No automatic delivery either way.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireProjectOwner } from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";
import { buildMvpReport, loadReportInputs } from "@/lib/export/build-mvp-report";
import { buildExportGateResponse } from "@/lib/export/export-gate-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

/**
 * Collect every process.env value that could plausibly represent a
 * secret we don't want landing in the report. The list is intentionally
 * broad; the redaction sweep is exact-string replacement, so entries that
 * happen not to appear in the report are simply no-ops.
 */
function collectSensitiveEnvValues(): string[] {
  const keys = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_ORG_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
  ];
  const values: string[] = [];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.length >= 8) values.push(v);
  }
  return values;
}

export async function GET(_req: Request, { params }: RouteContext) {
  const { projectId } = await params;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId is required" },
      { status: 400 }
    );
  }

  try {
    await requireProjectOwner(projectId);
  } catch (err) {
    const resp = authErrorResponse(err, {
      route: `export/${projectId}`,
      projectId,
    });
    if (resp) return resp;
    throw err;
  }

  const db = getDb();
  const inputs = await loadReportInputs(db, projectId);
  if (!inputs) {
    // Ownership guard already loaded the project once, so this should be
    // unreachable — but keep the 404 for belt-and-braces.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const provider = process.env.LLM_PROVIDER ?? null;
  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL ?? null
      : provider === "anthropic"
        ? process.env.ANTHROPIC_MODEL ?? null
        : null;
  const mockMode = process.env.ZYPACT_MOCK_MODE === "on";

  const { markdown, filename, warnings } = buildMvpReport({
    ...inputs,
    llmProvider: provider,
    llmModel: model,
    mockMode,
    sensitiveValues: collectSensitiveEnvValues(),
  });

  const hasCompleteEvidenceHashes =
    inputs.probeResults.length > 0 &&
    inputs.probeResults.every(
      (r) => typeof r.rawResponseSha256 === "string" && r.rawResponseSha256.length > 0
    );

  return buildExportGateResponse({
    projectId,
    markdown,
    filename,
    warnings,
    hasCompleteEvidenceHashes,
  });
}
