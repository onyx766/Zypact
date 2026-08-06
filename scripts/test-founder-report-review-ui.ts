#!/usr/bin/env tsx
/**
 * Founder report-review contract tests.
 *
 * Two halves:
 *
 *   1. Behavioral — the Supabase row mapper is exercised against a stubbed
 *      client to prove `approved_at` / `approved_by` map exactly and that
 *      null survives as null.
 *   2. Static source assertions — the founder detail page is a React Server
 *      Component with no renderer available under this lightweight tsx test
 *      system, so its review contract and the rendering-safety properties
 *      are asserted against the source text.
 *
 * No database, network, route, or email is used.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const APPROVED_AT = "2026-08-06T12:00:00.000Z";
const APPROVED_BY = "00000000-0000-4000-8000-000000000abc";

/** Minimal snapshot_requests row; only the fields the mapper reads. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    work_email: "founder-review@example.invalid",
    normalized_email: "founder-review@example.invalid",
    company_name: "Review Fixture",
    website_url: "https://review.example.invalid",
    normalized_domain: "review.example.invalid",
    buyer_category: "B2B SaaS testing",
    status: "report_ready",
    request_ip_hash: null,
    project_id: "22222222-2222-4222-8222-222222222222",
    progress_stage: "quality_review",
    progress_updated_at: "2026-08-06T11:00:00.000Z",
    approved_at: APPROVED_AT,
    approved_by: APPROVED_BY,
    claimed_by: null,
    claim_token: null,
    lease_expires_at: null,
    attempt_count: 1,
    created_at: "2026-08-06T10:00:00.000Z",
    updated_at: "2026-08-06T11:30:00.000Z",
    ...overrides,
  };
}

/** Stub client whose `.maybeSingle()` returns whatever row we supply. */
function makeStubClient(data: unknown) {
  const terminal = {
    maybeSingle: async () => ({ data, error: null }),
    single: async () => ({ data, error: null }),
    select: () => terminal,
    eq: () => terminal,
    order: () => terminal,
    limit: () => terminal,
    returns: () => terminal,
  };
  return {
    from() {
      return terminal;
    },
    rpc() {
      return terminal;
    },
  };
}

async function main(): Promise<void> {
  const { supabaseAdapter, __setSupabaseAdapterClientForTests } =
    await import("@/lib/db/supabase-adapter");

  const load = async (data: unknown) => {
    __setSupabaseAdapterClientForTests(
      makeStubClient(data) as unknown as Parameters<
        typeof __setSupabaseAdapterClientForTests
      >[0]
    );
    return supabaseAdapter.getSnapshotRequest(
      "11111111-1111-4111-8111-111111111111"
    );
  };

  /* ── 1-7. Mapping ─────────────────────────────────────────────────── */

  console.log("\nApproval metadata mapping");

  const approved = await load(row());

  check(
    "1. populated approved_at maps exactly to approvedAt",
    approved?.approvedAt === APPROVED_AT,
    String(approved?.approvedAt)
  );
  check(
    "2. populated approved_by maps exactly to approvedBy",
    approved?.approvedBy === APPROVED_BY,
    String(approved?.approvedBy)
  );
  check(
    "3. the actor is not transformed into another value",
    approved?.approvedBy === APPROVED_BY &&
      approved?.approvedBy !== approved?.id &&
      approved?.approvedBy !== approved?.projectId
  );

  const unapproved = await load(
    row({ approved_at: null, approved_by: null })
  );

  check(
    "4. null approved_at stays null (never defaulted to a timestamp)",
    unapproved?.approvedAt === null,
    String(unapproved?.approvedAt)
  );
  check(
    "5. null approved_by stays null (never defaulted to an actor)",
    unapproved?.approvedBy === null,
    String(unapproved?.approvedBy)
  );

  check(
    "6. pre-existing fields still map correctly",
    approved?.id === "11111111-1111-4111-8111-111111111111" &&
      approved?.workEmail === "founder-review@example.invalid" &&
      approved?.companyName === "Review Fixture" &&
      approved?.status === "report_ready" &&
      approved?.projectId === "22222222-2222-4222-8222-222222222222" &&
      approved?.progressStage === "quality_review" &&
      approved?.attemptCount === 1 &&
      approved?.createdAt === "2026-08-06T10:00:00.000Z" &&
      approved?.updatedAt === "2026-08-06T11:30:00.000Z"
  );
  check(
    "7. the returned shape gained exactly the two approval keys",
    approved !== null &&
      Object.keys(approved).filter((k) => k.startsWith("approved"))
        .length === 2
  );

  __setSupabaseAdapterClientForTests(null);

  /* ── 8-19. Founder detail UI contract (static source) ─────────────── */

  console.log("\nFounder detail UI contract");

  const repo = process.cwd();
  const read = (p: string) => readFileSync(join(repo, p), "utf-8");
  const detail = read(
    "app/admin/snapshot-requests/[requestId]/page.tsx"
  );

  check(
    "8. approval state is displayed",
    /label="Approval"/.test(detail) &&
      /Not approved yet/.test(detail)
  );
  check(
    "9. approved timestamp is displayed through the shared formatter",
    /label="Approved at"/.test(detail) &&
      /formatDate\(\s*request\.approvedAt\s*\)/.test(detail)
  );
  check(
    "10. approved actor is displayed",
    /label="Approved by"/.test(detail) &&
      /request\.approvedBy/.test(detail)
  );
  check(
    "11. short report renders inline",
    /heading="Short report"/.test(detail) &&
      /artifact\.shortReportMarkdown/.test(detail)
  );
  check(
    "12. full report renders inline",
    /heading="Full report"/.test(detail) &&
      /markdown=\{\s*artifact\.fullReportMarkdown/.test(detail)
  );
  check(
    "13. short and full previews are distinguishable",
    /heading="Short report"/.test(detail) &&
      /heading="Full report"/.test(detail)
  );
  check(
    "14. the short download link is preserved",
    /reports\/short/.test(detail)
  );
  check(
    "15. the full download link is preserved",
    /reports\/full/.test(detail)
  );
  check(
    "16. previews are bounded and wrap long content",
    /maxHeight/.test(detail) &&
      /overflow: "auto"/.test(detail) &&
      /whiteSpace: "pre-wrap"/.test(detail)
  );
  check(
    "17. the missing-artifact state is preserved",
    /The report will appear here after/.test(detail)
  );
  check(
    "18. an empty report column renders a neutral state",
    /This report is empty\./.test(detail)
  );
  check(
    "19. founder authorization is unchanged",
    /requireFounderForPage/.test(detail)
  );

  /* ── 20-26. Safety and scope ──────────────────────────────────────── */

  console.log("\nRendering safety and scope");

  // Match the JSX prop, not the word: the component's own docblock states
  // that dangerouslySetInnerHTML is deliberately not used, and a bare
  // substring search flags that prose as a violation.
  const executable = detail
    .split("\n")
    .filter(
      (l) =>
        !l.trimStart().startsWith("*") &&
        !l.trimStart().startsWith("//")
    )
    .join("\n");

  check(
    "20. the detail page introduces no dangerouslySetInnerHTML",
    !/dangerouslySetInnerHTML\s*=/.test(executable) &&
      !/dangerouslySetInnerHTML/.test(executable)
  );
  check(
    "21. no Markdown-to-HTML parser is invoked",
    !/ReactMarkdown|react-markdown|marked\(|micromark|remark|rehype/.test(
      detail
    )
  );
  check(
    "22. no raw-HTML rendering option is enabled",
    !/allowDangerousHtml|skipHtml=\{false\}|rehype-raw/.test(detail)
  );

  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  });

  check(
    "23. no Markdown dependency was added",
    !deps.some((d) =>
      /markdown|remark|marked|mdx|rehype|showdown|micromark/i.test(d)
    ),
    deps.length + " deps"
  );

  // The public report page must never surface founder review metadata.
  const publicReport = read("app/report/[secureToken]/page.tsx");
  check(
    "24. the public report page does not expose approvedBy",
    !/approvedBy|approved_by/.test(publicReport)
  );

  check(
    "25. approve/reject/send action components are still wired",
    /<ApproveButton/.test(detail) &&
      /<RejectButton/.test(detail) &&
      /<SendReportButton/.test(detail)
  );

  // Guard the two things this change explicitly must not add.
  check(
    "26. no engine trigger or run route was introduced",
    !/run-approved-snapshot|claim_next_snapshot_request|\/run\b/.test(
      detail
    )
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("Reports render as pre-formatted plain text. Rich Markdown");
  console.log("rendering is deferred: no Markdown dependency is installed,");
  console.log("and adding one was outside this change's scope.");
  console.log("Engine execution remains CLI-only and is not touched here.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
