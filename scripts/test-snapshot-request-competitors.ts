#!/usr/bin/env tsx
/**
 * Competitors per snapshot request — architecture PR #4.
 *
 * Behavioral tests run against the in-memory adapter and the shared parser.
 * The migration is verified by static SQL inspection only: no database is
 * contacted, no migration is executed, no provider is called.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.ZYPACT_ALLOW_MEMORY_DB = "1";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { memoryAdapter } from "@/lib/db/memory-adapter";
import {
  MAX_COMPETITORS,
  MIN_COMPETITORS,
  normalizeCompetitorInput,
  parseCompetitorsInput,
} from "@/lib/snapshot-requests/competitors";

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

const COMPANY = "Northwind Analytics";
const DOMAIN = "northwind.example";

async function pendingRequest() {
  const created = await memoryAdapter.createSnapshotRequest({
    workEmail: `founder+${randomUUID()}@example.invalid`,
    normalizedEmail: `founder+${randomUUID()}@example.invalid`,
    companyName: COMPANY,
    websiteUrl: `https://${DOMAIN}`,
    normalizedDomain: DOMAIN,
    buyerCategory: "B2B SaaS analytics",
    requestIpHash: null,
  });

  const tokenHash = `hash-${created.id}`;

  await memoryAdapter.issueSnapshotRequestVerification({
    requestId: created.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const verified =
    await memoryAdapter.consumeSnapshotRequestVerification(tokenHash);

  if (verified?.status !== "pending_approval") {
    throw new Error(
      `fixture did not reach pending_approval (got ${verified?.status})`
    );
  }

  return created.id;
}

async function approve(
  id: string,
  competitors: string[]
) {
  return memoryAdapter.approveAndQueueSnapshotRequest(
    id,
    randomUUID(),
    competitors
  );
}

async function main(): Promise<void> {
  /* ── Shared parser contract ───────────────────────────────────────── */

  console.log("\nShared parser");

  check(
    "1. trims whitespace around every entry",
    JSON.stringify(normalizeCompetitorInput("  Alpha  \n  Beta  ")) ===
      JSON.stringify(["Alpha", "Beta"])
  );
  check(
    "2. removes blank entries",
    JSON.stringify(normalizeCompetitorInput("Alpha\n\n   \nBeta")) ===
      JSON.stringify(["Alpha", "Beta"])
  );
  check(
    "3. deduplicates case-insensitively",
    JSON.stringify(normalizeCompetitorInput("Alpha\nALPHA\nalpha\nBeta")) ===
      JSON.stringify(["Alpha", "Beta"])
  );
  check(
    "4. preserves first-seen casing",
    JSON.stringify(normalizeCompetitorInput("aLpHa\nALPHA")) ===
      JSON.stringify(["aLpHa"])
  );
  check(
    "5. preserves first-seen order",
    JSON.stringify(normalizeCompetitorInput("Gamma\nAlpha\nBeta")) ===
      JSON.stringify(["Gamma", "Alpha", "Beta"])
  );
  check(
    "6. accepts commas as well as newlines",
    JSON.stringify(normalizeCompetitorInput("Alpha, Beta\nGamma")) ===
      JSON.stringify(["Alpha", "Beta", "Gamma"])
  );
  check(
    "7. non-string input is refused",
    parseCompetitorsInput(null).ok === false
  );
  check(
    "8. one competitor is refused",
    (() => {
      const r = parseCompetitorsInput("Alpha");
      return !r.ok && r.error === "competitors_below_minimum";
    })()
  );
  check(
    "9. blank-only input is refused",
    (() => {
      const r = parseCompetitorsInput("   \n  \n");
      return !r.ok && r.error === "competitors_below_minimum";
    })()
  );
  check(
    `10. ${MIN_COMPETITORS} competitors are accepted`,
    parseCompetitorsInput("Alpha\nBeta").ok
  );
  check(
    `11. ${MAX_COMPETITORS} competitors are accepted`,
    parseCompetitorsInput(
      Array.from({ length: MAX_COMPETITORS }, (_, i) => `C${i}`).join("\n")
    ).ok
  );
  check(
    `12. ${MAX_COMPETITORS + 1} competitors are refused`,
    (() => {
      const r = parseCompetitorsInput(
        Array.from(
          { length: MAX_COMPETITORS + 1 },
          (_, i) => `C${i}`
        ).join("\n")
      );
      return !r.ok && r.error === "competitors_above_maximum";
    })()
  );
  check(
    "13. an entry longer than 200 characters is refused",
    (() => {
      const r = parseCompetitorsInput(`Alpha\n${"x".repeat(201)}`);
      return !r.ok && r.error === "competitor_too_long";
    })()
  );
  check(
    "14. the scanned company cannot be its own competitor",
    (() => {
      const r = parseCompetitorsInput(
        `Alpha\n${COMPANY}`,
        COMPANY,
        DOMAIN
      );
      return !r.ok && r.error === "competitor_is_scanned_company";
    })()
  );
  check(
    "15. the scanned domain cannot be its own competitor",
    (() => {
      const r = parseCompetitorsInput(
        `Alpha\n${DOMAIN.toUpperCase()}`,
        COMPANY,
        DOMAIN
      );
      return !r.ok && r.error === "competitor_is_scanned_company";
    })()
  );

  /* ── Approval behavior ────────────────────────────────────────────── */

  console.log("\nApproval");

  const pending = await pendingRequest();
  const beforeApproval =
    await memoryAdapter.getSnapshotRequest(pending);

  check(
    "16. a pending request carries an empty frame",
    JSON.stringify(beforeApproval?.competitors) === "[]",
    JSON.stringify(beforeApproval?.competitors)
  );

  check(
    "17. approval with no competitors is refused",
    (await approve(pending, [])) === null
  );
  check(
    "18. approval with blank-only competitors is refused",
    (await approve(pending, ["  ", ""])) === null
  );
  check(
    "19. approval with one competitor is refused",
    (await approve(pending, ["Alpha"])) === null
  );
  check(
    `20. approval with ${MAX_COMPETITORS + 1} competitors is refused`,
    (await approve(
      pending,
      Array.from({ length: MAX_COMPETITORS + 1 }, (_, i) => `C${i}`)
    )) === null
  );
  check(
    "21. approval with an over-long entry is refused",
    (await approve(pending, ["Alpha", "x".repeat(201)])) === null
  );
  check(
    "22. approval naming the scanned company is refused",
    (await approve(pending, ["Alpha", COMPANY])) === null
  );
  check(
    "23. approval naming the scanned domain is refused",
    (await approve(pending, ["Alpha", DOMAIN])) === null
  );

  const stillPending =
    await memoryAdapter.getSnapshotRequest(pending);

  check(
    "24. every refused approval left the request unqueued",
    stillPending?.status === "pending_approval" &&
      JSON.stringify(stillPending?.competitors) === "[]",
    `${stillPending?.status} ${JSON.stringify(stillPending?.competitors)}`
  );

  const approved = await approve(pending, [
    "  Gamma Corp  ",
    "alpha co",
    "ALPHA CO",
    "",
    "Beta Ltd",
  ]);

  check(
    "25. a valid approval stores the normalized frame and queues at once",
    approved !== null &&
      approved.status === "queued" &&
      approved.approvedAt !== null &&
      approved.approvedBy !== null &&
      JSON.stringify(approved.competitors) ===
        JSON.stringify(["Gamma Corp", "alpha co", "Beta Ltd"]),
    JSON.stringify(approved?.competitors)
  );

  const reApproved = await approve(pending, [
    "Replacement One",
    "Replacement Two",
  ]);

  check(
    "26. a queued request keeps its frame — approval cannot replace it",
    reApproved !== null &&
      JSON.stringify(reApproved.competitors) ===
        JSON.stringify(["Gamma Corp", "alpha co", "Beta Ltd"]),
    JSON.stringify(reApproved?.competitors)
  );

  const stored =
    await memoryAdapter.getSnapshotRequest(pending);

  check(
    "27. the stored row is unchanged after the second approval",
    JSON.stringify(stored?.competitors) ===
      JSON.stringify(["Gamma Corp", "alpha co", "Beta Ltd"])
  );
  check(
    "28. a claimed-shape request exposes competitors as string[]",
    Array.isArray(stored?.competitors) &&
      stored!.competitors.every((c) => typeof c === "string")
  );

  /* ── Migration contract (static SQL) ──────────────────────────────── */

  console.log("\nMigration 0034 (static inspection, no database)");

  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/0034_snapshot_request_competitors.sql"
    ),
    "utf-8"
  );

  check(
    "29. adds a jsonb competitors column defaulting to an empty array",
    /add column if not exists competitors jsonb not null default '\[\]'::jsonb/.test(
      sql
    )
  );
  check(
    "30. constrains the column to a JSON array",
    /jsonb_typeof\(competitors\) = 'array'/.test(sql)
  );
  check(
    "31. drops the old two-argument approval function",
    /drop function if exists\s*\n?\s*public\.approve_and_queue_snapshot_request\(uuid, uuid\);/.test(
      sql
    )
  );
  check(
    "32. defines the three-argument approval function",
    /approve_and_queue_snapshot_request\(\s*p_request_id uuid,\s*p_approved_by uuid,\s*p_competitors jsonb\s*\)/.test(
      sql
    )
  );
  check(
    "33. enforces the minimum, maximum, and length rules in SQL",
    /competitors_below_minimum/.test(sql) &&
      /competitors_above_maximum/.test(sql) &&
      /competitor_too_long/.test(sql)
  );
  check(
    "34. rejects the scanned company or domain in SQL",
    /competitor_is_scanned_company/.test(sql)
  );
  check(
    "35. stores the frame and queues in a single UPDATE",
    /set competitors = v_competitors,\s*\n\s*status = 'queued',/.test(sql)
  );
  check(
    "36. that UPDATE only applies to a pending_approval row",
    /where id = p_request_id\s*\n\s*and status = 'pending_approval'/.test(sql)
  );
  check(
    "37. keeps SECURITY DEFINER and a pinned search_path",
    /security definer/.test(sql) &&
      /set search_path = public, pg_temp/.test(sql)
  );
  check(
    "38. revokes approval execution from public, anon, and authenticated",
    /approve_and_queue_snapshot_request\(uuid, uuid, jsonb\)\s*\nfrom public;/.test(
      sql
    ) &&
      /approve_and_queue_snapshot_request\(uuid, uuid, jsonb\)\s*\nfrom anon;/.test(
        sql
      ) &&
      /approve_and_queue_snapshot_request\(uuid, uuid, jsonb\)\s*\nfrom authenticated;/.test(
        sql
      )
  );
  check(
    "39. grants approval execution to service_role only",
    /grant execute on function\s*\n\s*public\.approve_and_queue_snapshot_request\(uuid, uuid, jsonb\)\s*\nto service_role;/.test(
      sql
    )
  );
  check(
    "40. the normalization helper is granted to nobody",
    /_normalize_snapshot_competitors/.test(sql) &&
      !/grant execute on function\s*\n\s*public\._normalize_snapshot_competitors/.test(
        sql
      )
  );
  check(
    "41. the helper is revoked from public, anon, authenticated, service_role",
    ["public", "anon", "authenticated", "service_role"].every((role) =>
      new RegExp(
        `_normalize_snapshot_competitors\\(jsonb\\)\\s*\\nfrom ${role};`
      ).test(sql)
    )
  );
  check(
    "42. the migration performs no direct DML on snapshot_requests",
    !/^\s*(insert into|delete from)\s+public\.snapshot_requests/im.test(sql)
  );

  /* ── Scope guards ─────────────────────────────────────────────────── */

  console.log("\nScope");

  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf-8");

  const route = read(
    "app/api/internal/snapshot-requests/[requestId]/approve/route.ts"
  );

  check(
    // Migration 0062 cuts the approval route over from
    // approveAndQueueSnapshotRequest (legacy 'queued' + worker-claim path)
    // to approveAndLaunchSnapshotBaseline (creates/approves the M4 question
    // + protocol and enqueues one M5 baseline job; terminal status
    // 'approved', never claimed by the legacy worker). The old function is
    // untouched and still covered by this file's own tests above — only
    // the route's call site changed.
    "43. the approval route never writes snapshot_requests directly",
    !/from\("snapshot_requests"\)/.test(route) &&
      /approveAndLaunchSnapshotBaseline\(/.test(route)
  );
  check(
    "44. the route reuses the shared parser rather than its own copy",
    /@\/lib\/snapshot-requests\/competitors/.test(route)
  );
  check(
    "45. the founder UI reuses the shared parser too",
    /@\/lib\/snapshot-requests\/competitors/.test(
      read("app/admin/snapshot-requests/approve-button.tsx")
    )
  );
  check(
    "46. no separate competitor-save action was added",
    !/save-competitors|saveCompetitors/.test(route)
  );
  check(
    "47. the mvp-scan hardcoded fallback is unchanged by this PR",
    /"Profound", "Otterly AI"/.test(read("scripts/mvp-scan.ts"))
  );
  const listPage = read("app/admin/snapshot-requests/page.tsx");
  const detailPage = read(
    "app/admin/snapshot-requests/[requestId]/page.tsx"
  );
  const approveButton = read(
    "app/admin/snapshot-requests/approve-button.tsx"
  );

  check(
    "49. the request list no longer renders the approval editor",
    !/<ApproveButton/.test(listPage) &&
      !/approve-button/.test(listPage)
  );
  check(
    "50. a pending row instead navigates to its detail page",
    /Review/.test(listPage) &&
      /\/admin\/snapshot-requests\/\$\{request\.id\}/.test(listPage)
  );
  check(
    "51. the detail page is the only approval-editor call site",
    /<ApproveButton/.test(detailPage) &&
      /textarea/.test(approveButton)
  );
  check(
    "52. the detail page prefills the stored frame",
    /competitors=\{\s*request\.competitors\s*\}/.test(
      detailPage.replace(/\n\s*/g, " ").replace(/\s+/g, " ")
    ) ||
      /competitors=\{ request\.competitors \}/.test(
        detailPage.replace(/\n\s*/g, " ").replace(/\s+/g, " ")
      )
  );
  check(
    "53. the detail page supplies the scanned identity props",
    /scannedCompany=/.test(detailPage) &&
      /scannedDomain=/.test(detailPage)
  );
  check(
    "54. identity props are required, so no call site can omit them",
    /scannedCompany: string \| null;/.test(approveButton) &&
      /scannedDomain: string \| null;/.test(approveButton) &&
      !/scannedCompany\?:/.test(approveButton)
  );
  check(
    "55. the route validates against the stored row, not the request body",
    /db\.getSnapshotRequest\(requestId\)/.test(route) &&
      /snapshotRequest\.companyName/.test(route) &&
      /snapshotRequest\.normalizedDomain/.test(route)
  );
  check(
    "56. no worker, poller, or claim invocation was added here",
    !/claimNextSnapshotRequest\(/.test(route) &&
      !/setInterval/.test(route)
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("Approval stores a validated competitor frame and queues in");
  console.log("one statement, so a claimed request always carries the list");
  console.log("a founder reviewed. Live migration and RPC behavior is NOT");
  console.log("covered here — that needs a real database.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
