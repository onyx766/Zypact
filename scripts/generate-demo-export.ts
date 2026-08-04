#!/usr/bin/env tsx
/**
 * One-shot demo generator for the Sprint 11 export route.
 *
 * This DOES NOT bypass auth. It runs the real handler in
 * `app/api/projects/[projectId]/export/route.ts` which calls
 * `requireProjectOwner`, `authErrorResponse`, the redaction sweep, and
 * writes the same headers a browser would receive. The Supabase server
 * auth client is stubbed (same pattern as `scripts/test-auth-ownership.ts`)
 * so we can drive the handler from a Node script — but the stub is
 * populated ONLY with the actual project owner's id read from Supabase
 * via the service-role adapter. If the project owner does not match, the
 * script exits without touching the handler. If the project has no owner
 * (legacy `user_id IS NULL`), the script also refuses.
 *
 * Usage:
 *   scripts/run-with-env.py npx tsx scripts/generate-demo-export.ts <projectId> <outFile>
 *
 * Only reads. Never writes to the database. Never prints any secret.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getDb } from "@/lib/db";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function main(): Promise<void> {
  const [projectId, outFile] = process.argv.slice(2);
  if (!projectId || !outFile) {
    fail(
      "Usage: scripts/run-with-env.py npx tsx scripts/generate-demo-export.ts <projectId> <outFile>",
      2
    );
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    fail(
      "Refusing to run: this script targets Supabase and needs both\n" +
        "  NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.",
      2
    );
  }

  // 1. Look up the real owner via the service-role adapter — the SAME
  //    lookup `requireProjectOwner` will later do internally. We only
  //    use the returned id to seed the auth stub; we do not skip the
  //    ownership check itself.
  const project = await getDb().getProject(projectId);
  if (!project) fail(`Project ${projectId} not found in Supabase.`);
  if (!project.userId) {
    fail(
      `Project ${projectId} has user_id = NULL (legacy). Per Sprint 10.5, ` +
        `legacy projects are not exportable. Run a fresh scan as an ` +
        `authenticated user and re-run this script with that projectId.`
    );
  }

  const ownerId = project.userId!;

  // 2. Stub the Supabase server auth client to identify as the real
  //    owner. This is the *only* thing this script does that a browser
  //    would otherwise do via `middleware.ts` refreshing the SSR
  //    session cookie. `requireProjectOwner` still runs, still hits
  //    Supabase for the project row, still enforces `project.userId ===
  //    user.id`, and still logs deny-reasons.
  const stubClient = {
    auth: {
      async getUser() {
        return {
          data: { user: { id: ownerId, email: null } },
          error: null,
        };
      },
    },
  } as unknown as SupabaseClient;
  __setSupabaseServerClientForTests(stubClient);

  // 3. Call the real route handler.
  const { GET } = await import(
    "@/app/api/projects/[projectId]/export/route"
  );
  const req = new Request(`http://localhost/api/projects/${projectId}/export`);
  const res = await GET(req, { params: { projectId } });

  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  const contentDisposition = res.headers.get("content-disposition") ?? "";
  const xRed = res.headers.get("x-zypact-redactions") ?? "";
  const exportVersion = res.headers.get("x-zypact-export-version") ?? "";

  if (status !== 200) {
    fail(
      `Export route returned HTTP ${status}. Expected 200. Aborting without writing ${outFile}.`
    );
  }
  if (!contentType.startsWith("text/markdown")) {
    fail(
      `Unexpected Content-Type: ${contentType}. Expected text/markdown. Aborting.`
    );
  }

  const body = await res.text();

  // 4. Server-side sanity checks BEFORE writing anything to disk. We
  //    verify against process.env directly rather than trusting the
  //    header — the redaction count is informational only.
  const secretKeys = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_ORG_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
  ] as const;
  const leaks: string[] = [];
  for (const k of secretKeys) {
    const v = process.env[k];
    if (typeof v === "string" && v.length >= 8 && body.includes(v)) {
      leaks.push(k);
    }
  }
  if (leaks.length > 0) {
    fail(
      `Refusing to write ${outFile}: secret env value(s) appeared in the ` +
        `response body: ${leaks.join(", ")}. This indicates the sweep ` +
        `regressed. Do not ship this build.`
    );
  }

  // 5. Prefix sweep to catch any leftover well-known secret shapes.
  const dangerousPatterns: Array<[string, RegExp]> = [
    ["sb_secret_", /sb_secret_[A-Za-z0-9_-]{10,}/],
    ["sk-live-", /sk-live-[A-Za-z0-9_-]{10,}/],
    ["sk-proj-", /sk-proj-[A-Za-z0-9_-]{10,}/],
    ["sk- (generic)", /sk-[A-Za-z0-9]{20,}/],
  ];
  const shapeHits = dangerousPatterns.filter(([, re]) => re.test(body));
  if (shapeHits.length > 0) {
    fail(
      `Refusing to write ${outFile}: secret-shaped substrings detected: ` +
        shapeHits.map(([n]) => n).join(", ")
    );
  }

  // 6. Extract the summary metadata for reporting. The report itself
  //    was already computed by the handler; we just parse the counts we
  //    embedded in section 1 for a quick programmatic recap.
  const readCount = (label: string): string => {
    const m = body.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "n/a";
  };
  const qaLine = readCount("QA distribution");

  const abs = resolve(outFile);
  writeFileSync(abs, body, { encoding: "utf-8" });

  console.log(JSON.stringify(
    {
      status,
      contentType,
      contentDisposition,
      exportFormatVersion: exportVersion,
      redactionCount: xRed,
      bytes: body.length,
      filename: outFile,
      absolutePath: abs,
      projectId,
      ownerUserIdPrefix: ownerId.slice(0, 8) + "…",
      metadata: {
        projectId: readCount("projectId"),
        detectedCategory: readCount("detectedCategory"),
        provider: readCount("provider"),
        model: readCount("model"),
        mockMode: readCount("mock mode"),
        promptsTotal: readCount("prompts total"),
        distinctPromptsScorecard: readCount(
          "distinct prompts represented in scorecard results"
        ),
        scorecardProbeRuns: readCount("scorecard probe runs"),
        allStoredProbeRows: readCount("all stored probe rows"),
        competitors: readCount("competitors"),
        prioritizedGaps: readCount("prioritized gaps"),
        fixBriefs: readCount("fix briefs"),
        generatedAssets: readCount("generated assets"),
        qaReports: readCount("QA reports (latest per asset)"),
        qaDistribution: qaLine,
      },
      leakChecks: {
        envValueLeaks: leaks.length,
        secretShapeLeaks: shapeHits.length,
      },
    },
    null,
    2
  ));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
