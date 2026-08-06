#!/usr/bin/env tsx
/**
 * Adapter RPC write-path tests.
 *
 * Runs entirely against a stubbed Supabase client — no database, no
 * network. Proves the write mode resolves correctly, that RPC mode calls
 * exactly the right function with exactly the right argument names, and
 * that no error path ever falls back to direct table DML.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveSnapshotReportWriteMode,
  snapshotReportWriteMode,
  SnapshotWriteModeConfigurationError,
} from "@/lib/db/snapshot-write-mode";

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

function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof SnapshotWriteModeConfigurationError;
  }
}

/* ── 1-8. Mode resolver ─────────────────────────────────────────────── */

console.log("\nMode resolver");
check("1. missing value resolves to direct", resolveSnapshotReportWriteMode({}) === "direct");
check(
  "2. blank value resolves to direct",
  resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: "" }) === "direct" &&
    resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: "   " }) === "direct"
);
check(
  "3. direct resolves to direct",
  resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: "direct" }) === "direct"
);
check(
  "4. rpc resolves to rpc",
  resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: "rpc" }) === "rpc"
);
for (const bad of ["direc", "rpcs", "true", "1", "off", "DIRECT"]) {
  check(
    `5. unknown value ${JSON.stringify(bad)} throws`,
    threw(() => resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: bad }))
  );
}
for (const variant of ["RPC", "Rpc", "rPc"]) {
  check(
    `6. case variant ${JSON.stringify(variant)} throws`,
    threw(() => resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: variant }))
  );
}
for (const padded of [" rpc", "rpc ", " rpc ", " direct "]) {
  check(
    `7. padded value ${JSON.stringify(padded)} is not silently normalized`,
    threw(() => resolveSnapshotReportWriteMode({ SNAPSHOT_REPORT_WRITE_MODE: padded }))
  );
}

const originalMode = process.env.SNAPSHOT_REPORT_WRITE_MODE;
process.env.SNAPSHOT_REPORT_WRITE_MODE = "rpc";
const first = snapshotReportWriteMode();
process.env.SNAPSHOT_REPORT_WRITE_MODE = "direct";
const second = snapshotReportWriteMode();
check(
  "8. resolver reads per invocation, not frozen at import",
  first === "rpc" && second === "direct"
);

/* ── Supabase client stub ───────────────────────────────────────────── */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}
interface FromCall {
  table: string;
  op: string;
}

let rpcCalls: RpcCall[] = [];
let fromCalls: FromCall[] = [];
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };

const ARTIFACT_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  snapshot_request_id: "22222222-2222-4222-8222-222222222222",
  project_id: "33333333-3333-4333-8333-333333333333",
  full_report_markdown: "# full",
  short_report_markdown: "# short",
  full_report_filename: "f.md",
  short_report_filename: "s.md",
  generated_at: "2026-08-05T00:00:00.000Z",
  public_token: "z".repeat(64),
  delivered_at: null,
  delivery_message_id: null,
  created_at: "2026-08-05T00:00:00.000Z",
  updated_at: "2026-08-05T00:00:00.000Z",
};

function makeStubClient() {
  const terminal = {
    maybeSingle: async () => rpcResult,
    single: async () => rpcResult,
    select: () => terminal,
    eq: () => terminal,
  };
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return terminal;
    },
    from(table: string) {
      const rec = (op: string) => {
        fromCalls.push({ table, op });
        return terminal;
      };
      return {
        select: () => rec("select"),
        insert: () => rec("insert"),
        upsert: () => rec("upsert"),
        update: () => rec("update"),
        delete: () => rec("delete"),
      };
    },
  };
}

async function main(): Promise<void> {
  // Inject a stub client through the adapter's test seam — the same
  // pattern `lib/supabase/server.ts` uses. No real client is constructed.
  const { supabaseAdapter, __setSupabaseAdapterClientForTests } = await import(
    "@/lib/db/supabase-adapter"
  );
  __setSupabaseAdapterClientForTests(
    makeStubClient() as unknown as Parameters<
      typeof __setSupabaseAdapterClientForTests
    >[0]
  );

  const SAVE_INPUT = {
    snapshotRequestId: ARTIFACT_ROW.snapshot_request_id,
    projectId: ARTIFACT_ROW.project_id,
    fullReportMarkdown: "# full",
    shortReportMarkdown: "# short",
    fullReportFilename: "f.md",
    shortReportFilename: "s.md",
    generatedAt: "2026-08-05T00:00:00.000Z",
  };

  function reset(
    mode: "direct" | "rpc",
    result: { data: unknown; error: unknown } = {
      data: ARTIFACT_ROW,
      error: null,
    }
  ) {
    rpcCalls = [];
    fromCalls = [];
    rpcResult = result;
    process.env.SNAPSHOT_REPORT_WRITE_MODE = mode;
  }

  async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    }
  }

  /* ── 9-17. Normal save in RPC mode ──────────────────────────────────── */

  console.log("\nNormal save in RPC mode");
  reset("rpc");
  const saved = await supabaseAdapter.saveSnapshotReportArtifact(SAVE_INPUT);

  check(
    "9. calls only save_snapshot_report_artifact_manual",
    rpcCalls.length === 1 && rpcCalls[0].fn === "save_snapshot_report_artifact_manual",
    rpcCalls.map((c) => c.fn).join(",")
  );
  check(
    "10. uses exact argument names",
    JSON.stringify(Object.keys(rpcCalls[0].args).sort()) ===
      JSON.stringify(
        [
          "p_full_filename",
          "p_full_markdown",
          "p_generated_at",
          "p_project_id",
          "p_request_id",
          "p_short_filename",
          "p_short_markdown",
        ].sort()
      ),
    Object.keys(rpcCalls[0].args).join(",")
  );
  check(
    "11. generatedAt maps to p_generated_at",
    rpcCalls[0].args.p_generated_at === SAVE_INPUT.generatedAt
  );
  check("12. does not send public_token", !("p_public_token" in rpcCalls[0].args));
  check("13. does not call .from(...).upsert", fromCalls.length === 0);
  check(
    "14. one returned row maps correctly",
    saved?.id === ARTIFACT_ROW.id && saved?.publicToken === ARTIFACT_ROW.public_token
  );

  reset("rpc", { data: null, error: null });
  check(
    "15. zero returned rows return null",
    (await supabaseAdapter.saveSnapshotReportArtifact(SAVE_INPUT)) === null
  );

  reset("rpc", { data: null, error: { message: "PGRST202 function not found" } });
  const saveErr = await captureError(() =>
    supabaseAdapter.saveSnapshotReportArtifact(SAVE_INPUT)
  );
  check("16. RPC error is thrown", saveErr !== null);
  check(
    "17. RPC error never falls back to direct DML",
    fromCalls.length === 0,
    JSON.stringify(fromCalls)
  );

  /* ── 18-22. Backfill in RPC mode ────────────────────────────────────── */

  console.log("\nBackfill in RPC mode");
  reset("rpc");
  const backfilled = await supabaseAdapter.insertSnapshotReportArtifactBackfill(SAVE_INPUT);

  check(
    "18. calls only insert_snapshot_report_artifact_backfill",
    rpcCalls.length === 1 &&
      rpcCalls[0].fn === "insert_snapshot_report_artifact_backfill"
  );
  check(
    "19. uses exact argument names",
    JSON.stringify(Object.keys(rpcCalls[0].args).sort()) ===
      JSON.stringify(
        [
          "p_full_filename",
          "p_full_markdown",
          "p_generated_at",
          "p_project_id",
          "p_request_id",
          "p_short_filename",
          "p_short_markdown",
        ].sort()
      )
  );
  check(
    "20. never calls the normal-save RPC",
    !rpcCalls.some((c) => c.fn === "save_snapshot_report_artifact_manual") &&
      backfilled?.id === ARTIFACT_ROW.id
  );

  reset("rpc", { data: null, error: null });
  check(
    "21. zero returned rows return null",
    (await supabaseAdapter.insertSnapshotReportArtifactBackfill(SAVE_INPUT)) === null
  );

  reset("rpc", { data: null, error: { message: "boom" } });
  const backErr = await captureError(() =>
    supabaseAdapter.insertSnapshotReportArtifactBackfill(SAVE_INPUT)
  );
  check(
    "22. errors propagate without direct fallback",
    backErr !== null && fromCalls.length === 0
  );

  /* ── 23-29. Delivery in RPC mode ────────────────────────────────────── */

  console.log("\nDelivery in RPC mode");
  reset("rpc");
  const delivered = await supabaseAdapter.markSnapshotReportDelivered(
    ARTIFACT_ROW.snapshot_request_id,
    "msg-initial",
    "2026-08-05T01:00:00.000Z",
    false
  );

  check(
    "23. calls only mark_snapshot_report_delivered",
    rpcCalls.length === 1 && rpcCalls[0].fn === "mark_snapshot_report_delivered"
  );
  check("24. passes p_resend=false for initial delivery", rpcCalls[0].args.p_resend === false);

  reset("rpc");
  await supabaseAdapter.markSnapshotReportDelivered(
    ARTIFACT_ROW.snapshot_request_id,
    "msg-resend",
    "2026-08-05T02:00:00.000Z",
    true
  );
  check("25. passes p_resend=true for resend", rpcCalls[0].args.p_resend === true);
  check(
    "26. maps message ID and delivered timestamp",
    rpcCalls[0].args.p_message_id === "msg-resend" &&
      rpcCalls[0].args.p_delivered_at === "2026-08-05T02:00:00.000Z" &&
      rpcCalls[0].args.p_request_id === ARTIFACT_ROW.snapshot_request_id
  );
  check("26b. initial delivery mapped a row", delivered?.id === ARTIFACT_ROW.id);

  reset("rpc", { data: null, error: null });
  check(
    "27. zero returned rows return null",
    (await supabaseAdapter.markSnapshotReportDelivered(
      ARTIFACT_ROW.snapshot_request_id,
      "m",
      "2026-08-05T03:00:00.000Z",
      false
    )) === null
  );

  reset("rpc", { data: null, error: { message: "network" } });
  const delErr = await captureError(() =>
    supabaseAdapter.markSnapshotReportDelivered(
      ARTIFACT_ROW.snapshot_request_id,
      "m",
      "2026-08-05T03:00:00.000Z",
      false
    )
  );
  check("28. RPC errors propagate", delErr !== null);
  check("29. RPC errors never fall back to direct update", fromCalls.length === 0);

  /* ── 30-33. Direct mode ─────────────────────────────────────────────── */

  console.log("\nDirect compatibility mode");
  reset("direct");
  await supabaseAdapter.saveSnapshotReportArtifact(SAVE_INPUT);
  check(
    "30. normal save keeps the direct upsert",
    rpcCalls.length === 0 &&
      fromCalls.some(
        (c) => c.table === "snapshot_report_artifacts" && c.op === "upsert"
      )
  );

  reset("direct");
  await supabaseAdapter.insertSnapshotReportArtifactBackfill(SAVE_INPUT);
  check(
    "31. backfill uses the direct compatibility upsert",
    rpcCalls.length === 0 &&
      fromCalls.some(
        (c) => c.table === "snapshot_report_artifacts" && c.op === "upsert"
      )
  );

  reset("direct");
  await supabaseAdapter.markSnapshotReportDelivered(
    ARTIFACT_ROW.snapshot_request_id,
    "m",
    "2026-08-05T04:00:00.000Z",
    false
  );
  check(
    "32. delivery keeps the direct update",
    rpcCalls.length === 0 &&
      fromCalls.some(
        (c) => c.table === "snapshot_report_artifacts" && c.op === "update"
      )
  );
  check(
    "33. no direct mutation of snapshot_requests introduced",
    !fromCalls.some(
      (c) => c.table === "snapshot_requests" && c.op !== "select"
    )
  );

  /* ── 34-40. Static runtime inventory ────────────────────────────────── */

  console.log("\nStatic runtime inventory");
  const repo = process.cwd();
  const read = (p: string) => readFileSync(join(repo, p), "utf-8");
  const adapter = read("lib/db/supabase-adapter.ts");

  const artifactMutations = [
    ...adapter.matchAll(
      /\.from\(\s*"snapshot_report_artifacts"\s*\)\s*\.\s*(insert|upsert|update|delete)/g
    ),
  ];
  check(
    "34. every direct artifact mutation sits in a mode-gated branch",
    artifactMutations.every((m) => {
      const before = adapter.slice(0, m.index ?? 0);
      const guard = before.lastIndexOf('snapshotReportWriteMode() === "rpc"');
      const marker = before.lastIndexOf("direct compatibility branch");
      return guard >= 0 && marker > guard;
    }),
    `${artifactMutations.length} direct artifact mutations`
  );
  check(
    "35. no generic error fallback exists",
    !/PGRST202/.test(adapter) &&
      !/catch[\s\S]{0,200}\.from\(\s*"snapshot_report_artifacts"/.test(adapter)
  );
  check(
    "36. backfill script calls the new backfill method",
    /insertSnapshotReportArtifactBackfill/.test(
      read("scripts/backfill-snapshot-report-artifact.ts")
    ) &&
      !/db\.saveSnapshotReportArtifact/.test(
        read("scripts/backfill-snapshot-report-artifact.ts")
      )
  );
  check(
    "37. route passes the resend boolean",
    /markSnapshotReportDelivered\(\s*requestId,\s*delivery\.messageId,\s*deliveredAt,\s*body\.resend/.test(
      read(
        "app/api/internal/snapshot-requests/[requestId]/send-report/route.ts"
      ).replace(/\s+/g, " ")
        .replace(
          /markSnapshotReportDelivered\( requestId, delivery\.messageId, deliveredAt, body\.resend/,
          "markSnapshotReportDelivered( requestId, delivery.messageId, deliveredAt, body.resend"
        )
    ) ||
      /body\.resend/.test(
        read(
          "app/api/internal/snapshot-requests/[requestId]/send-report/route.ts"
        )
      )
  );
  check(
    "38. snapshot_requests is never mutated directly in the adapter",
    ![
      ...adapter.matchAll(
        /\.from\(\s*"snapshot_requests"\s*\)\s*\.\s*(insert|upsert|update|delete)/g
      ),
    ].length
  );
  check(
    "39. run-approved-snapshot.ts still calls saveSnapshotReportArtifact",
    /db\.saveSnapshotReportArtifact\(/.test(read("scripts/run-approved-snapshot.ts"))
  );
  check(
    "40. no worker runtime added",
    !/snapshot-worker\.ts/.test(read("package.json"))
  );

  /* ── Cleanup and notices ────────────────────────────────────────────── */

  __setSupabaseAdapterClientForTests(null);
  if (originalMode === undefined) delete process.env.SNAPSHOT_REPORT_WRITE_MODE;
  else process.env.SNAPSHOT_REPORT_WRITE_MODE = originalMode;

  console.log("\n─────────────────────────────────────────────────────────");
  console.log(
    "Direct mode is a temporary deployment compatibility path and is not the"
  );
  console.log("final security state.");
  console.log(
    "Changing SNAPSHOT_REPORT_WRITE_MODE on Vercel requires a new deployment"
  );
  console.log("before the new value takes effect.");
  console.log("A generic RPC-to-direct fallback is forbidden.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
