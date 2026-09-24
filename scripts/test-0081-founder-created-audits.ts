/**
 * Migration 0081 — founder-created audits and the `origin` column.
 *
 * Two halves, both offline:
 *   [1-3] the migration's SQL text, read as a contract;
 *   [4-6] the behaviour, exercised through the memory adapter and the
 *         route's own guard wiring.
 *
 * The SQL half matters because the whole safety argument of this change is
 * that the PUBLIC function is untouched. That is a property of the file, and
 * a test that only exercised the founder path would never notice if the
 * public one had been quietly widened in the same migration.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

process.env.ZYPACT_ALLOW_MEMORY_DB = "true";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MIGRATION = "supabase/migrations/0081_snapshot_request_origin_and_founder_creation.sql";
const sql = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
/** Statements only: comments carry prose that would match anything. */
const code = sql
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

const FOUNDER_FN = "public.create_snapshot_request_as_founder";
const PUBLIC_FN = "create_snapshot_request_guarded";

async function main(): Promise<void> {
  console.log("\n[1] the public function is untouched");
  {
    check("the migration never drops the public function",
      !new RegExp(`drop\\s+function[^;]*${PUBLIC_FN}`, "i").test(code));
    check("…never redefines it",
      !new RegExp(`create\\s+(or\\s+replace\\s+)?function[^;]*${PUBLIC_FN}`, "i").test(code));
    check("…and never re-grants it",
      !new RegExp(`grant[^;]*${PUBLIC_FN}`, "i").test(code));
    check("the public function is not mentioned in any statement at all",
      !code.includes(PUBLIC_FN));
  }

  console.log("\n[2] the origin column");
  {
    check("origin is added with a default, so existing rows are not rewritten",
      /add column if not exists origin text not null default 'public_form'/.test(code));
    check("…and constrained to exactly the two values",
      /check \(origin in \('public_form', 'founder'\)\)/.test(code));
    check("the constraint is added conditionally, so re-running is safe",
      /if not exists \(\s*select 1\s*from pg_constraint\s*where conname = 'snapshot_requests_origin_check'/.test(code));
    check("no UPDATE rewrites any existing row",
      !/^\s*update\s+public\.snapshot_requests/im.test(code));
  }

  console.log("\n[3] the founder function");
  {
    const fnStart = code.indexOf(`create or replace function ${FOUNDER_FN}(`);
    const fnEnd = code.indexOf("$$;", fnStart);
    // Bounded at the function's own terminator so the grants below it are
    // checked against the whole file instead, where they belong.
    const body = fnStart >= 0 && fnEnd > fnStart ? code.slice(fnStart, fnEnd) : "";
    check("the function body is found and bounded", body.length > 200,
      `${fnStart} → ${fnEnd}`);

    check("it keeps the active-domain check",
      /snapshot_limit_active_domain/.test(body));
    for (const skipped of [
      "snapshot_limit_email_30d",
      "snapshot_limit_domain_30d",
      "snapshot_limit_ip_daily",
    ]) {
      check(`it does not enforce ${skipped}`, !body.includes(skipped));
    }

    check("the active-domain check excludes report_ready, as the public one does",
      /'needs_founder_review'\s*\n\s*\)\s*\)\s*then/.test(body)
        && !/'report_ready'/.test(body));

    check("it takes the SAME domain lock key as the public function",
      /pg_advisory_xact_lock\(\s*hashtextextended\('snapshot-domain:' \|\| p_normalized_domain, 0\)/.test(body));
    check("it takes no email or IP lock, which it has no check for",
      !/'snapshot-email:'/.test(body) && !/'snapshot-ip:'/.test(body));

    // One regex over the VALUES list, because each of these is a position in
    // it: matching the strings loosely would also match the status names in
    // the active-domain check above, which legitimately mentions both
    // 'pending_verification' and 'approved'.
    const values =
      /p_buyer_category,\s*\n\s*'pending_approval',\s*\n\s*null,\s*\n\s*p_contact_name,\s*\n\s*'founder'\s*\n\s*\)\s*\n\s*returning \*/;
    check("the inserted row is pending_approval, no IP hash, origin founder",
      values.test(body));
    check("nothing inserts pending_verification",
      !/'pending_verification',\s*\n\s*null,/.test(body));

    check("it never calls the approval RPC",
      !/approve_and_launch|approve_protocol|approved_at\s*=/.test(body));
    check("it never enqueues a job", !/enqueue_protocol_execution_job/.test(body));

    check("it is revoked from public, anon and authenticated",
      ["public", "anon", "authenticated"].every((role) =>
        new RegExp(`revoke all on function ${FOUNDER_FN.replace(/[.]/g, "\\.")}\\([^)]*\\) from ${role};`, "s")
          .test(code)));
    check("…and granted only to service_role",
      new RegExp(`grant execute on function ${FOUNDER_FN.replace(/[.]/g, "\\.")}\\([^)]*\\) to service_role;`, "s")
        .test(code)
        && (code.match(/grant execute on function/g) ?? []).length === 1);
  }

  console.log("\n[4] adapter behaviour");
  {
    const { memoryAdapter } = await import("@/lib/db/memory-adapter");
    const { SnapshotRequestLimitError } = await import("@/lib/db/types");

    const base = {
      workEmail: "Buyer@Prospect.com",
      normalizedEmail: "buyer@prospect.com",
      companyName: "Prospect Inc",
      contactName: "Dana Buyer",
      websiteUrl: "https://prospect.com",
      normalizedDomain: "prospect.com",
      buyerCategory: "Which SOC 2 automation platforms suit a 50-person SaaS?",
    };

    const created = await memoryAdapter.createFounderSnapshotRequest(base);
    check("a founder request lands on pending_approval",
      created.status === "pending_approval", created.status);
    check("…is marked origin founder", created.origin === "founder", created.origin);
    check("…carries no IP hash", created.requestIpHash === null);
    check("…is not approved", created.approvedAt === null && created.approvedBy === null);
    check("…has no protocol and no project yet",
      created.protocolId === null && created.projectId === null);

    // The throttles the public path enforces must NOT fire here: same email,
    // same domain, immediately after — the exact case that blocked the founder.
    let second: Awaited<ReturnType<typeof memoryAdapter.createFounderSnapshotRequest>> | null = null;
    let secondError: unknown = null;
    try {
      second = await memoryAdapter.createFounderSnapshotRequest(base);
    } catch (error) {
      secondError = error;
    }
    check("a second request for an ACTIVE domain is refused",
      secondError instanceof SnapshotRequestLimitError
        && (secondError as InstanceType<typeof SnapshotRequestLimitError>).code === "active_domain",
      String(secondError));
    check("…and no row was created for it", second === null);

    // The decisive contrast. The SAME email, on a different domain, is the
    // case the public form refuses outright (email_30d) and the one that
    // blocked the founder. The founder path must accept it, and the public
    // path must still refuse it — proving the throttle was skipped for this
    // route rather than removed from the system.
    const sameEmailOtherDomain = {
      ...base,
      companyName: "Second Prospect",
      websiteUrl: "https://second-prospect.com",
      normalizedDomain: "second-prospect.com",
    };

    const reused = await memoryAdapter.createFounderSnapshotRequest(sameEmailOtherDomain);
    check("the same email is accepted again on another domain",
      reused.origin === "founder" && reused.status === "pending_approval");

    let publicRefusal: unknown = null;
    try {
      await memoryAdapter.createSnapshotRequest({
        ...sameEmailOtherDomain,
        normalizedDomain: "third-prospect.com",
        websiteUrl: "https://third-prospect.com",
      });
    } catch (error) {
      publicRefusal = error;
    }
    check("…while the PUBLIC path still refuses that same email",
      publicRefusal instanceof SnapshotRequestLimitError
        && (publicRefusal as InstanceType<typeof SnapshotRequestLimitError>).code === "email_30d",
      String(publicRefusal));

    const publicRow = await memoryAdapter.createSnapshotRequest({
      workEmail: "someone@other.com",
      normalizedEmail: "someone@other.com",
      companyName: "Other Ltd",
      websiteUrl: "https://other.com",
      normalizedDomain: "other.com",
      buyerCategory: "Which CRMs fit a 20-person agency?",
    });
    check("the public path still creates pending_verification",
      publicRow.status === "pending_verification", publicRow.status);
    check("…and is marked origin public_form",
      publicRow.origin === "public_form", publicRow.origin);
  }

  console.log("\n[5] route wiring");
  {
    const route = readFileSync(
      path.join(process.cwd(), "app/api/internal/snapshot-requests/route.ts"), "utf8");

    check("the route is founder-guarded before anything else",
      /const guard = await requireFounderForRoute\(ROUTE\);\s*\n\s*if \(!guard\.ok\) return guard\.response;/
        .test(route));
    check("the guard precedes reading the body",
      route.indexOf("requireFounderForRoute") < route.indexOf("request.text()"));
    check("it reuses the public normalizer rather than restating validation",
      /normalizeSnapshotRequestInput\(body\)/.test(route));
    check("it calls the founder adapter, never the public one",
      /createFounderSnapshotRequest\(/.test(route)
        && !/\bcreateSnapshotRequest\(/.test(route));
    check("an active-domain conflict answers 409",
      /error\.code === "active_domain"[\s\S]{0,400}?status: 409/.test(route));
    check("it never approves or runs a pipeline",
      !/approve|run-pipeline|runPipeline|enqueue/i.test(
        route.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")));
    check("the success log carries no email, company or question",
      /event: "founder_snapshot_request_created"/.test(route)
        && !/workEmail|companyName|buyerCategory|contactName/.test(
          route.slice(route.indexOf('event: "founder_snapshot_request_created"'),
            route.indexOf("return NextResponse.json(\n    {\n      ok: true"))));
  }

  console.log("\n[6] the admin list");
  {
    const table = readFileSync(
      path.join(process.cwd(), "app/admin/snapshot-requests/requests-table.tsx"), "utf8");
    const page = readFileSync(
      path.join(process.cwd(), "app/admin/snapshot-requests/page.tsx"), "utf8");

    check("the page passes origin through to the row", /origin: request\.origin,/.test(page));
    check("the table filters by origin", /const \[origin, setOrigin\] = useState<OriginKey>/.test(table));
    check("status counts are scoped to the origin filter",
      /all: scoped\.length,/.test(table));
    check("origin counts are taken over every row, not the filtered set",
      /originCounts = useMemo\(\s*\(\) => \(\{\s*all: rows\.length,/.test(table));
    check("a founder-created row is labelled in the list",
      /row\.origin === "founder"[\s\S]{0,300}?Founder/.test(table));
  }

  console.log("\n[7] the New audit form");
  {
    const panel = readFileSync(
      path.join(process.cwd(), "app/admin/snapshot-requests/new-audit-panel.tsx"), "utf8");
    const page = readFileSync(
      path.join(process.cwd(), "app/admin/snapshot-requests/page.tsx"), "utf8");

    check("the panel is rendered on the requests page",
      /<NewAuditPanel \/>/.test(page) && /from "\.\/new-audit-panel"/.test(page));

    // The route validates with the public form's strict zod schema, so the
    // body must carry exactly these five keys. A missing one is a 400 the
    // founder would have to decode from field errors; an extra one is a
    // refusal outright.
    for (const field of [
      "contactName", "workEmail", "companyName", "websiteUrl", "buyerCategory",
    ]) {
      check(`the form collects ${field}`, panel.includes(field));
    }
    check("it posts exactly those five, and nothing else",
      /body: JSON\.stringify\(values\)/.test(panel)
        && /const EMPTY: Record<FieldKey, string> = \{[^}]*\}/.test(panel)
        && (panel.match(/^\s{2}(contactName|workEmail|companyName|websiteUrl|buyerCategory): "",$/gm) ?? []).length === 5);

    check("it posts to the founder route", /"\/api\/internal\/snapshot-requests"/.test(panel));
    check("…and never to the public one",
      !/"\/api\/snapshot-requests"/.test(panel));

    check("field-level validation errors are surfaced",
      /payload\?\.issues/.test(panel) && /zpa-field-error/.test(panel));
    check("an active-domain conflict shows the server's own explanation",
      /payload\?\.detail/.test(panel));
    check("success goes to the review page, not to a scan",
      /window\.location\.href = payload\.reviewPath/.test(panel)
        && !/run-pipeline/.test(panel));
    check("the panel says approval is still required before any charge",
      /pending\s*\n?\s*approval[\s\S]{0,120}?approve it|nothing is scanned or charged/i.test(panel));
  }

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
