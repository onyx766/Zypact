#!/usr/bin/env tsx
/**
 * Worker execution-options resolver tests.
 *
 * Entirely pure: no database, no network, no provider, no filesystem write,
 * no process spawned. The resolver is a pure function, so these tests call
 * it directly and inspect its source statically for forbidden dependencies.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  WorkerExecutionOptionsError,
  resolveWorkerExecutionOptions,
} from "@/lib/snapshot-worker/execution-options";
import type { SnapshotRequest } from "@/lib/db/types";

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

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

/** Sentinel values that must never appear in any thrown message. */
const COMPANY = "Northwind Analytics";
const DOMAIN = "northwind.example";
const EMAIL = "founder@northwind.example";
const WEBSITE = "https://northwind.example";
const SECRET_COMPETITOR = "Zzz Secret Competitor Ltd";

function claimed(
  overrides: Partial<SnapshotRequest> = {}
): SnapshotRequest {
  return {
    id: REQUEST_ID,
    workEmail: EMAIL,
    normalizedEmail: EMAIL,
    companyName: COMPANY,
    websiteUrl: WEBSITE,
    normalizedDomain: DOMAIN,
    buyerCategory: "B2B SaaS analytics",
    status: "running",
    requestIpHash: null,
    projectId: PROJECT_ID,
    progressStage: "reserved",
    progressUpdatedAt: null,
    approvedAt: "2026-08-07T00:00:00.000Z",
    approvedBy: PROJECT_ID,
    competitors: ["Alpha Analytics", "Beta Insights"],
    ...overrides,
  } as SnapshotRequest;
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function main(): void {
  /* ── Valid resolution ─────────────────────────────────────────────── */

  console.log("\nValid resolution");

  const options = resolveWorkerExecutionOptions(claimed());

  check(
    "1. probe mode is fixed to live",
    options.probeMode === "live"
  );
  check("2. budget is fixed to 2", options.budgetUsd === 2);
  check("3. prompts is fixed to 5", options.prompts === 5);
  check("4. runs is fixed to 3", options.runs === 3);
  check(
    "5. output path is the request-scoped default",
    options.out === `./exports/snapshots/${REQUEST_ID}/mvp-scan.md`,
    options.out
  );
  check(
    "6. competitors come from the claimed request",
    JSON.stringify(options.competitors) ===
      JSON.stringify(["Alpha Analytics", "Beta Insights"])
  );
  check(
    "7. the result has exactly the six engine fields",
    JSON.stringify(Object.keys(options).sort()) ===
      JSON.stringify(
        [
          "budgetUsd",
          "competitors",
          "out",
          "probeMode",
          "prompts",
          "runs",
        ].sort()
      ),
    Object.keys(options).join(",")
  );
  check(
    "8. no execute field is produced",
    !("execute" in options) && !("dryRun" in options)
  );

  /* ── Determinism ──────────────────────────────────────────────────── */

  console.log("\nDeterminism");

  check(
    "9. the same request resolves identically",
    JSON.stringify(resolveWorkerExecutionOptions(claimed())) ===
      JSON.stringify(resolveWorkerExecutionOptions(claimed()))
  );
  check(
    "10. a different request resolves to a different output path",
    resolveWorkerExecutionOptions(claimed({ id: OTHER_ID })).out !==
      options.out
  );

  /* ── Competitor normalization ─────────────────────────────────────── */

  console.log("\nCompetitor normalization");

  const normalized = resolveWorkerExecutionOptions(
    claimed({
      competitors: [
        "  Gamma Corp  ",
        "alpha co",
        "ALPHA CO",
        "",
        "Beta Ltd",
      ],
    })
  ).competitors;

  check(
    "11. entries are trimmed",
    normalized[0] === "Gamma Corp"
  );
  check(
    "12. blank entries are removed",
    !normalized.includes("")
  );
  check(
    "13. duplicates are removed case-insensitively",
    normalized.filter((c) => c.toLowerCase() === "alpha co").length === 1
  );
  check(
    "14. first-seen casing is preserved",
    normalized.includes("alpha co") && !normalized.includes("ALPHA CO")
  );
  check(
    "15. first-seen order is preserved",
    JSON.stringify(normalized) ===
      JSON.stringify(["Gamma Corp", "alpha co", "Beta Ltd"]),
    JSON.stringify(normalized)
  );

  const twelve = Array.from({ length: 12 }, (_, i) => `C${i}`);
  check(
    "16. exactly 12 competitors are accepted",
    resolveWorkerExecutionOptions(claimed({ competitors: twelve }))
      .competitors.length === 12
  );

  /* ── Competitor refusals ──────────────────────────────────────────── */

  console.log("\nCompetitor refusals");

  const refuse = (
    label: string,
    competitors: unknown,
    reason: string
  ): void => {
    const error = capture(() =>
      resolveWorkerExecutionOptions(
        claimed({ competitors: competitors as string[] })
      )
    );

    check(
      label,
      error instanceof WorkerExecutionOptionsError &&
        error.reason === reason,
      `${(error as Error)?.constructor?.name}: ${
        (error as WorkerExecutionOptionsError)?.reason
      }`
    );
  };

  refuse("17. empty frame refused", [], "competitors_below_minimum");
  refuse(
    "18. one competitor refused",
    ["Alpha"],
    "competitors_below_minimum"
  );
  refuse(
    "19. blank-only frame refused",
    ["  ", ""],
    "competitors_below_minimum"
  );
  refuse(
    "20. thirteen competitors refused",
    Array.from({ length: 13 }, (_, i) => `C${i}`),
    "competitors_above_maximum"
  );
  refuse(
    "21. over-long entry refused",
    ["Alpha", "x".repeat(201)],
    "competitor_too_long"
  );
  refuse(
    "22. non-array input refused",
    "Alpha,Beta",
    "competitors_not_an_array"
  );
  refuse(
    "23. non-string entry refused",
    ["Alpha", 42],
    "competitor_not_a_string"
  );

  /* ── Claim preconditions ──────────────────────────────────────────── */

  console.log("\nClaim preconditions");

  const refuseRequest = (
    label: string,
    overrides: Partial<SnapshotRequest>,
    reason: string
  ): void => {
    const error = capture(() =>
      resolveWorkerExecutionOptions(claimed(overrides))
    );

    check(
      label,
      error instanceof WorkerExecutionOptionsError &&
        error.reason === reason,
      `${(error as WorkerExecutionOptionsError)?.reason}`
    );
  };

  refuseRequest(
    "24. a queued request is refused",
    { status: "queued" as SnapshotRequest["status"] },
    "request_not_running"
  );
  refuseRequest(
    "25. a report_ready request is refused",
    { status: "report_ready" as SnapshotRequest["status"] },
    "request_not_running"
  );
  refuseRequest(
    "26. a null project is refused",
    { projectId: null },
    "request_project_missing"
  );
  refuseRequest(
    "27. a blank project is refused",
    { projectId: "   " },
    "request_project_missing"
  );

  /* ── Output path safety ───────────────────────────────────────────── */

  console.log("\nOutput path safety");

  const unsafeIds = [
    ["28. parent traversal", "../../etc/passwd"],
    ["29. forward slash", "aaa/bbb"],
    ["30. backslash", "aaa\\bbb"],
    ["31. absolute path", "/etc/passwd"],
    ["32. non-uuid text", "not-a-uuid"],
    ["33. empty id", ""],
  ];

  for (const [label, id] of unsafeIds) {
    const error = capture(() =>
      resolveWorkerExecutionOptions(claimed({ id }))
    );

    check(
      `${label} is refused before any path is built`,
      error instanceof WorkerExecutionOptionsError &&
        error.reason === "request_id_unsafe",
      `${(error as WorkerExecutionOptionsError)?.reason}`
    );
  }

  check(
    "34. every resolved path stays under the exports root",
    resolveWorkerExecutionOptions(claimed()).out.startsWith(
      "./exports/snapshots/"
    ) && !resolveWorkerExecutionOptions(claimed()).out.includes("..")
  );

  /* ── Error confidentiality ────────────────────────────────────────── */

  console.log("\nError confidentiality");

  const errors: string[] = [];

  for (const build of [
    () => resolveWorkerExecutionOptions(claimed({ competitors: [] })),
    () =>
      resolveWorkerExecutionOptions(
        claimed({ competitors: [SECRET_COMPETITOR, "x".repeat(201)] })
      ),
    () => resolveWorkerExecutionOptions(claimed({ projectId: null })),
    () =>
      resolveWorkerExecutionOptions(
        claimed({ status: "queued" as SnapshotRequest["status"] })
      ),
    () => resolveWorkerExecutionOptions(claimed({ id: "../escape" })),
  ]) {
    const error = capture(build);

    // A build that does not throw means a precondition was lost. Record it
    // as a visible failure rather than dereferencing null, so a mutation
    // shows up as a failed assertion instead of crashing the suite.
    errors.push(
      error instanceof Error
        ? `${error.name} ${error.message}`
        : "MISSING_ERROR"
    );
  }

  const joined = errors.join(" | ");

  check(
    "35. no competitor value appears in any error",
    !joined.includes(SECRET_COMPETITOR)
  );
  check(
    "36. no company name, domain, email, or website appears",
    !joined.includes(COMPANY) &&
      !joined.includes(DOMAIN) &&
      !joined.includes(EMAIL) &&
      !joined.includes(WEBSITE)
  );
  check(
    "37. no project id appears",
    !joined.includes(PROJECT_ID)
  );
  check(
    "38. every invalid input actually threw",
    !errors.includes("MISSING_ERROR"),
    errors.filter((e) => e === "MISSING_ERROR").length + " did not throw"
  );
  check(
    "38a. errors still identify the field and reason",
    errors.every((e) => /reason|rejected/i.test(e)) &&
      joined.includes("competitors")
  );

  /* ── Purity ───────────────────────────────────────────────────────── */

  console.log("\nPurity");

  const input = claimed();
  const originalCompetitors = input.competitors;
  const envBefore = JSON.stringify(process.env);

  resolveWorkerExecutionOptions(input);

  check(
    "39. the input object is not mutated",
    input.id === REQUEST_ID &&
      input.status === "running" &&
      input.projectId === PROJECT_ID
  );
  check(
    "40. the stored competitor array is not mutated in place",
    input.competitors === originalCompetitors &&
      JSON.stringify(input.competitors) ===
        JSON.stringify(["Alpha Analytics", "Beta Insights"])
  );
  check(
    "41. the returned competitor array is a distinct copy",
    resolveWorkerExecutionOptions(input).competitors !==
      input.competitors
  );
  check(
    "42. process.env is not mutated",
    JSON.stringify(process.env) === envBefore
  );

  /* ── Source-level scope and dependency guards ─────────────────────── */

  console.log("\nScope and dependencies");

  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf-8");

  const source = read("lib/snapshot-worker/execution-options.ts");

  const executable = source
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return (
        !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*")
      );
    })
    .join("\n");

  check(
    "43. the resolver never reads process.env",
    !/process\.env/.test(executable)
  );
  check(
    "44. the resolver performs no network or provider call",
    !/fetch\(|axios|perplexity|openai|anthropic/i.test(executable)
  );
  check(
    "45. the resolver imports no database adapter or client",
    !/@\/lib\/db\/(supabase|memory)-adapter|createClient|getDb\(/.test(
      executable
    )
  );
  check(
    "46. the resolver performs no filesystem or process work",
    !/node:fs|writeFile|mkdir|child_process|spawn/.test(executable)
  );
  check(
    "47. the resolver is synchronous — no async or await",
    !/\basync\b|\bawait\b/.test(executable)
  );
  check(
    "48. competitor rules are reused, not redefined",
    /@\/lib\/snapshot-requests\/competitors/.test(executable) &&
      !/const MIN_COMPETITORS =|const MAX_COMPETITORS =/.test(executable)
  );
  check(
    "49. no claim, poll, lease, or worker loop entered the resolver",
    !/claimNextSnapshotRequest|setInterval|setTimeout|renewSnapshotRequestLease|SIGTERM/.test(
      executable
    )
  );
  check(
    "50. the fixed values are pinned in source, not derived from input",
    /const WORKER_PROBE_MODE = "live"/.test(executable) &&
      /const WORKER_BUDGET_USD = 2;/.test(executable) &&
      /const WORKER_PROMPTS = 5;/.test(executable) &&
      /const WORKER_RUNS = 3;/.test(executable)
  );
  check(
    "51. budget is documented as an estimated-cost guard, not a hard stop",
    /not a measured-spend circuit breaker/.test(source)
  );
  check(
    "52. prompt under-fill is documented",
    /can yield fewer than this/.test(source)
  );
  check(
    "53. the manual CLI is untouched by this change",
    /parseCompetitors/.test(read("scripts/run-approved-snapshot.ts")) &&
      !/resolveWorkerExecutionOptions/.test(
        read("scripts/run-approved-snapshot.ts")
      )
  );
  check(
    "54. the mvp-scan fallback is unchanged and unreferenced here",
    /"Profound", "Otterly AI"/.test(read("scripts/mvp-scan.ts")) &&
      !/Profound/.test(source)
  );
  check(
    "55. a resolved frame always carries at least two competitors",
    resolveWorkerExecutionOptions(claimed()).competitors.length >= 2 &&
      resolveWorkerExecutionOptions(
        claimed({ competitors: twelve })
      ).competitors.length >= 2
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("The resolver is pure and fails closed before any provider");
  console.log("work. An invalid competitor frame throws here rather than");
  console.log("reaching mvp-scan, whose hardcoded fallback is unchanged");
  console.log("and stays unreachable. No worker or poller is added.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
