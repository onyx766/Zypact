#!/usr/bin/env tsx
/**
 * Sprint 11 route-level security + read-only proof for
 * `app/api/projects/[projectId]/export/route.ts`.
 *
 * We import the route module directly and call `GET` with a synthetic
 * `Request` and `params`. The Supabase auth client is stubbed the same
 * way as `scripts/test-auth-ownership.ts`, and the DB adapter is the
 * in-memory one (Supabase env vars are unset here).
 *
 * Scenarios (all mandated by the sprint brief):
 *   1. Unauthenticated request                     → 401
 *   2. Missing projectId in DB                     → 404
 *   3. Authenticated non-owner                     → 404 (byte-identical
 *                                                    body to case 2 —
 *                                                    enumeration guard)
 *   4. Legacy `user_id IS NULL`                    → 404
 *   5. Owner                                       → 200 + text/markdown
 *   6. Read-only invariant: before/after row counts across every DB
 *      accessor for the exported project are identical AND no
 *      `updateGeneratedAssetQaStatus` / `save*` was called.
 *   7. Response body contains no secret literals.
 *
 * No live network, no Supabase, no LLM.
 */

// Force in-memory adapter and disable live LLM checks.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_MODEL;
process.env.ZYPACT_MOCK_MODE = "on"; // never call a real model, even accidentally

// A "fake" service role key we can look for in the export response to
// prove the sweep works end-to-end. Length > 8 so redactSensitive
// treats it as sensitive.
const FAKE_SERVICE_ROLE_KEY = "sb_secret_ROUTE_TEST_SHOULD_NEVER_LEAK_1234567";
process.env.SUPABASE_SERVICE_ROLE_KEY_UNUSED = FAKE_SERVICE_ROLE_KEY;
// Pretend the export route sees an OPENAI_API_KEY in env — the sweep
// should not include it in the response, but if a bug embedded it, the
// route's sweep would still hide it.
process.env.OPENAI_API_KEY = FAKE_SERVICE_ROLE_KEY;

import { getDb } from "@/lib/db";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { SupabaseClient } from "@supabase/supabase-js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let stubbedUser: CurrentUser | null = null;
const stubClient = {
  auth: {
    async getUser() {
      if (stubbedUser === null) return { data: { user: null }, error: null };
      return {
        data: { user: { id: stubbedUser.id, email: stubbedUser.email } },
        error: null,
      };
    },
  },
} as unknown as SupabaseClient;
__setSupabaseServerClientForTests(stubClient);

async function seedProject(userId: string | null): Promise<string> {
  const db = getDb();
  const p = await db.createProject({
    domain: `https://acme-${Math.random().toString(36).slice(2, 8)}.example.com`,
    companyName: "Acme",
    userId,
  });

  await db.saveSitePages(p.id, [
    {
      url: p.domain,
      title: "Home",
      content: `# Homepage\n\nAsync-first product\n\nSecret we forgot to redact upstream: ${FAKE_SERVICE_ROLE_KEY}`,
      pageType: "home",
    },
  ]);
  await db.saveMirrorProfile(p.id, {
    companyName: "Acme",
    website: p.domain,
    detectedCategory: "issue tracker",
    categoryConfidence: "high",
    targetAudience: ["PMs"],
    useCases: ["Issue tracking"],
    features: ["Cycles"],
    painPointsAddressed: ["Slow triage"],
    claims: [],
    proofSignals: [],
    competitorsMentioned: [],
    missingSignals: [
      { signal: "SOC2", whyItMatters: "trust" },
      { signal: "Pricing calc", whyItMatters: "buyer clarity" },
      { signal: "Case studies", whyItMatters: "sales enablement" },
    ],
    buyerIntentAngles: [],
    aiReadabilityNotes: "OK",
  });
  await db.replaceGeneratedPrompts(p.id, [
    {
      prompt: "Best issue tracker",
      intentType: "best_tools",
      commercialValue: 5,
      winnability: 4,
      priority: 20,
      rationale: "test",
      selected: true,
    },
  ]);
  await db.upsertEvidenceBank(p.id, {
    productDescription: "Acme async issue tracker.",
    targetAudience: ["PMs"],
    mainUseCases: ["Issue tracking"],
    features: [{ name: "Cycles", description: "" }],
    proofItems: [{ type: "customer", detail: "Vercel" }],
    competitors: ["Jira"],
    allowedClaims: ["Async-first"],
    forbiddenClaims: ["a", "b", "c"],
    tone: "confident",
    // Intentionally embed the fake secret in a field the report DOES
    // serialize (evidenceBank.notes → section 8) so the redaction sweep
    // has to fire to keep the export safe. If the sweep regresses, this
    // test will fail on the "no FAKE_SERVICE_ROLE_KEY in body" check.
    notes: `Ops note: NEVER paste service role tokens like ${FAKE_SERVICE_ROLE_KEY}`,
    provenance: "auto_filled_from_mirror_profile",
  });
  const fb = await db.saveFixBrief(p.id, {
    gapId: null,
    probeResultId: null,
    lostPrompt: "Best issue tracker",
    competitorRecommended: "Jira",
    rootCause: "No comparison page",
    recommendedFix: "Publish Acme vs Jira",
    fixType: "comparison_page",
    assetsToGenerate: ["comparison_page_outline"],
    evidenceNeeded: [],
    evidenceAvailable: [],
    priority: 1,
    expectedImpact: "Recover lost prompts",
    status: "ready_for_assets",
  });
  const asset = await db.saveGeneratedAsset(p.id, {
    fixBriefId: fb.id,
    assetType: "comparison_page_outline",
    title: "Acme vs Jira",
    content: "## Outline\n\nAsync-first.",
    placeholders: [],
    claimsUsed: [],
    qaStatus: "needs_evidence",
  });
  await db.saveQaReport(p.id, {
    generatedAssetId: asset.id,
    verdict: "needs_evidence",
    violations: [],
    placeholdersRemaining: [],
    overallNotes: "Add third-party evidence.",
  });
  return p.id;
}

async function snapshotProject(projectId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const [
    project,
    sitePages,
    mp,
    prompts,
    probes,
    comps,
    gm,
    gaps,
    eb,
    fbs,
    assets,
    qaReports,
  ] = await Promise.all([
    db.getProject(projectId),
    db.getSitePages(projectId),
    db.getMirrorProfile(projectId),
    db.getGeneratedPrompts(projectId),
    db.getProbeResultsByProject(projectId),
    db.getCompetitorsByProject(projectId),
    db.getLatestGapMap(projectId),
    db.getGapsByProject(projectId),
    db.getEvidenceBankByProject(projectId),
    db.getFixBriefsByProject(projectId),
    db.getGeneratedAssetsByProject(projectId),
    db.getQaReportsByProject(projectId),
  ]);
  return {
    project,
    sitePages: sitePages.length,
    mirrorProfile: mp ? { id: mp.id, updatedAt: mp.createdAt } : null,
    prompts: prompts.length,
    probes: probes.length,
    competitors: comps.length,
    gapMap: gm ? { id: gm.id, createdAt: gm.createdAt } : null,
    gaps: gaps.length,
    evidenceBank: eb ? { id: eb.id, updatedAt: eb.updatedAt } : null,
    fixBriefs: fbs.map((f) => ({ id: f.id, status: f.status, updatedAt: f.updatedAt })),
    assets: assets.map((a) => ({ id: a.id, qaStatus: a.qaStatus, updatedAt: a.updatedAt })),
    qaReports: qaReports.length,
  };
}

async function main(): Promise<void> {
  const { GET } = await import(
    "@/app/api/projects/[projectId]/export/route"
  );

  const alice: CurrentUser = { id: "user-alice", email: "alice@example.com" };
  const bob: CurrentUser = { id: "user-bob", email: "bob@example.com" };

  const aliceProjectId = await seedProject(alice.id);
  const legacyProjectId = await seedProject(null);

  const req = new Request("http://localhost/api/projects/x/export");

  // ------------------------------ 1 · no session ------------------------------
  stubbedUser = null;
  const r1 = await GET(req, { params: { projectId: aliceProjectId } });
  check("unauthenticated → 401", r1.status === 401);
  const body1 = await r1.clone().json();
  check(
    "unauthenticated body is generic 'unauthorized'",
    body1?.error === "unauthorized"
  );

  // ------------------------------ 2 · missing project -------------------------
  stubbedUser = alice;
  const r2 = await GET(req, {
    params: { projectId: "00000000-0000-0000-0000-000000000000" },
  });
  check("missing project → 404", r2.status === 404);
  const body2 = await r2.clone().json();
  check("missing body is generic 'not_found'", body2?.error === "not_found");

  // ------------------------------ 3 · non-owner -------------------------------
  stubbedUser = bob;
  const r3 = await GET(req, { params: { projectId: aliceProjectId } });
  check("non-owner → 404", r3.status === 404);
  const body3 = await r3.clone().json();
  check(
    "non-owner and missing-project bodies are byte-identical",
    JSON.stringify(body2) === JSON.stringify(body3) && r2.status === r3.status
  );

  // ------------------------------ 4 · legacy null-owner ------------------------
  stubbedUser = alice;
  const r4 = await GET(req, { params: { projectId: legacyProjectId } });
  check("legacy null-owner → 404", r4.status === 404);

  // Snapshot BEFORE the owner export so we can prove read-only.
  const before = await snapshotProject(aliceProjectId);

  // ------------------------------ 5 · owner (success) --------------------------
  stubbedUser = alice;
  const r5 = await GET(req, { params: { projectId: aliceProjectId } });
  check("owner → 200", r5.status === 200);
  check(
    "owner response is text/markdown",
    (r5.headers.get("content-type") ?? "").startsWith("text/markdown")
  );
  const cd = r5.headers.get("content-disposition") ?? "";
  check(
    "content-disposition is attachment with a .md filename",
    /attachment; filename="zypact-report-[a-f0-9-]{36}-\d{8}\.md"/.test(cd),
    cd
  );
  const text = await r5.clone().text();
  check(
    "owner response body contains client-report heading",
    text.startsWith("# Zypact MVP — Client Report")
  );
  // Sprint 11.5 client-facing sections
  check(
    "owner response body has Executive Summary near the top",
    text.includes("## 1. Executive Summary")
  );
  check(
    "owner response body contains all 19 client-facing section headings",
    [
      "## 1. Executive Summary",
      "## 2. Publishability Status",
      "## 3. Evidence Needed to Unlock Publish-Ready Assets",
      "## 4. Project Summary",
      "## 5. Mirror Profile",
      "## 6. Prompt Mirror summary",
      "## 7. Probe Results",
      "## 8. What this means",
      "## 9. Competitors",
      "## 10. Recommendation Gap Map",
      "## 11. Recommended Next Actions",
      "## 12. Evidence Bank",
      "## 13. Fix Brief",
      "## 14. Generated Assets",
      "## 15. QA Review",
      "## 16. Unsafe / needs-evidence warnings",
      "## 17. Known limitations",
      "## 18. Blocked fixes",
      "## 19. Appendix — Technical metadata",
    ].every((s) => text.includes(s))
  );
  check(
    "probe section carries the simulated-probe honesty label",
    text.includes("came from a simulated, manually-entered probe") &&
      text.includes("No live call was made")
  );
  check(
    "appendix explicitly records probe origin as simulated",
    text.includes("**probe origin**: simulated (no live platform API integration)")
  );

  // ------------------------------ 6 · read-only proof -------------------------
  const after = await snapshotProject(aliceProjectId);
  check(
    "export made no DB writes (before/after snapshot equal)",
    JSON.stringify(before) === JSON.stringify(after)
  );
  const xRed = r5.headers.get("x-zypact-redactions") ?? "";
  check(
    "X-Zypact-Redactions header is set to an integer",
    /^\d+$/.test(xRed),
    `header=${xRed}`
  );
  check(
    "sweep fired at least once (fake key embedded in evidenceBank.notes)",
    parseInt(xRed, 10) >= 1,
    `header=${xRed}`
  );

  // ------------------------------ 7 · secret leak sweep -----------------------
  check(
    "FAKE_SERVICE_ROLE_KEY does not appear anywhere in the export body",
    !text.includes(FAKE_SERVICE_ROLE_KEY)
  );
  check(
    "sb_secret_-prefixed secret is fully redacted in the export body",
    !/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "Sprint 11 export route scenario PASSED."
        : "Sprint 11 export route scenario FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
