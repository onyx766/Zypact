#!/usr/bin/env tsx
/**
 * M2 canonical observations contract, third tranche (runtime writer
 * hardening) — route-level regression test for
 * `app/api/projects/analyze-probe-response/route.ts`.
 *
 * We import the route module directly and call `POST` with a synthetic
 * `Request`. The Supabase auth client is stubbed the same way as
 * `scripts/test-export-route-security.ts`/`scripts/test-auth-ownership.ts`,
 * and the DB adapter is the in-memory one (Supabase env vars are unset
 * here).
 *
 * This is exactly the manual-paste production path identified as an
 * unwired writer during the M2 tranche-2 NOT NULL preflight audit: it
 * must now create/resolve a manual_scan dataset_batches row after
 * authorization and before any probe write, and every probe_run/
 * probe_result it creates must carry a non-null dataset_id and
 * dataset_source_type.
 *
 * No live network, no Supabase, no LLM.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_MODEL;
process.env.ZYPACT_MOCK_MODE = "on";

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

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/projects/analyze-probe-response", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const { POST } = await import(
    "@/app/api/projects/analyze-probe-response/route"
  );
  const db = getDb();

  const alice: CurrentUser = { id: "user-alice-manual-paste", email: "alice@example.com" };
  const bob: CurrentUser = { id: "user-bob-manual-paste", email: "bob@example.com" };

  const project = await db.createProject({
    domain: `manual-paste-${Math.random().toString(36).slice(2, 8)}.example.com`,
    companyName: "Manual Paste Co",
    userId: alice.id,
  });

  const validBody = {
    projectId: project.id,
    prompt: "who should we use for AI visibility diagnostics",
    platform: "perplexity",
    rawResponse: "Manual Paste Co is a strong option for AI visibility diagnostics.",
  };

  // ------------------------------ 1 · unauthenticated -------------------------
  stubbedUser = null;
  const beforeUnauth = await db.getDatasetBatchesByProject(project.id);
  const r1 = await POST(postRequest(validBody));
  check("unauthenticated → not 200", r1.status !== 200);
  const afterUnauth = await db.getDatasetBatchesByProject(project.id);
  check(
    "unauthenticated request creates zero dataset_batches rows (auth checked before any write)",
    beforeUnauth.length === afterUnauth.length && afterUnauth.length === 0
  );

  // ------------------------------ 2 · non-owner --------------------------------
  stubbedUser = bob;
  const r2 = await POST(postRequest(validBody));
  check("non-owner → not 200", r2.status !== 200);
  const afterNonOwner = await db.getDatasetBatchesByProject(project.id);
  check(
    "non-owner request creates zero dataset_batches rows",
    afterNonOwner.length === 0
  );

  // ------------------------------ 3 · owner, valid submission ------------------
  stubbedUser = alice;
  const r3 = await POST(postRequest(validBody));
  check("owner, valid body → 200", r3.status === 200);
  const body3 = await r3.clone().json();
  check("response reports ok:true", body3?.ok === true);
  check("response includes a probeRunId", typeof body3?.probeRunId === "string");

  const batchesAfterFirst = await db.getDatasetBatchesByProject(project.id);
  check(
    "exactly one dataset_batches row created for this submission",
    batchesAfterFirst.length === 1
  );
  check(
    "the created batch is manual_scan",
    batchesAfterFirst[0]?.datasetSourceType === "manual_scan"
  );

  const runsAfterFirst = await db.getProbeRunsByProject(project.id);
  const resultsAfterFirst = await db.getProbeResultsByProject(project.id);
  check(
    "exactly one probe_run created, with non-null dataset_id and dataset_source_type",
    runsAfterFirst.length === 1 &&
      runsAfterFirst[0]?.datasetId != null &&
      runsAfterFirst[0]?.datasetSourceType === "manual_scan"
  );
  check(
    "exactly one probe_result created, with non-null dataset_id and dataset_source_type",
    resultsAfterFirst.length === 1 &&
      resultsAfterFirst[0]?.datasetId != null &&
      resultsAfterFirst[0]?.datasetSourceType === "manual_scan"
  );
  check(
    "the probe_run and probe_result share the same dataset_id as the created batch",
    runsAfterFirst[0]?.datasetId === batchesAfterFirst[0]?.id &&
      resultsAfterFirst[0]?.datasetId === batchesAfterFirst[0]?.id
  );

  // ------------------------------ 4 · second submission, same project ----------
  stubbedUser = alice;
  const r4 = await POST(postRequest(validBody));
  check("second owner submission → 200", r4.status === 200);

  const batchesAfterSecond = await db.getDatasetBatchesByProject(project.id);
  check(
    "a second submission creates a SECOND, distinct dataset_batches row — never reused across invocations (D-014)",
    batchesAfterSecond.length === 2
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "analyze-probe-response route regression PASSED."
        : "analyze-probe-response route regression FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
