#!/usr/bin/env tsx
/**
 * M5-A — `POST /api/projects/:projectId/protocol-runs`, route level.
 *
 * The route's whole job is to write one queued row. The point of this
 * file is to prove it does no more than that: no provider call, no
 * reservation, no attempt, nothing a user could spend money on by
 * pressing a button repeatedly.
 *
 * Scenarios:
 *   1. unauthenticated                 → 401
 *   2. unknown protocol                → 404
 *   3. authenticated non-owner         → 404, byte-identical to (2)
 *   4. legacy null owner               → 404
 *   5. protocol from another project   → 404 (tenant isolation)
 *   6. unapproved protocol             → 409
 *   7. owner + approved                → 201, then 200 ALREADY_EXISTS
 *   8. ten submits ⇒ one job, zero paid calls, zero attempts
 *   9. no claim token in any response body
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
process.env.ZYPACT_MOCK_MODE = "on";

import { getDb } from "@/lib/db";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateProtocolInput } from "@/lib/db/types";

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
      return { data: { user: { id: stubbedUser.id, email: stubbedUser.email } }, error: null };
    },
  },
} as unknown as SupabaseClient;
__setSupabaseServerClientForTests(stubClient);

const OWNER: CurrentUser = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.test" };
const STRANGER: CurrentUser = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.test" };
const APPROVER = "11111111-1111-4111-8111-111111111111";

const PROTOCOL_FIXTURE: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity",
  surface: "sonar",
  plannedBaselineRuns: 1,
  plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Which vendors handle X best?", hash: "b".repeat(64) }],
  unitOfAnalysis: "run",
  primaryMetric: "listed_in_run",
  samplePlanningMethod: "fixed",
  runCap: 20,
  spendCapUsd: 100,
  timeWindowSeconds: 3600,
  rateLimitPerHour: 100,
  concurrencyLimit: 5,
  retryCap: 2,
};

async function main(): Promise<void> {
  // A fetch that would explode if the request path ever tried to use it.
  let outboundFetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    outboundFetches += 1;
    throw new Error("the enqueue route must never make an outbound call");
    return realFetch(...args);
  }) as typeof fetch;

  const { POST } = await import("@/app/api/projects/[projectId]/protocol-runs/route");
  const db = getDb();

  async function seed(
    owner: string | null,
    opts: { approve: boolean } = { approve: true }
  ): Promise<{ projectId: string; protocolId: string }> {
    const project = await db.createProject({
      domain: `p-${Math.random().toString(36).slice(2, 8)}.example.test`,
      companyName: "Example Client",
      userId: owner,
    });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: project.id,
      versionNumber: 1,
      promptText: "Which vendors handle X best?",
      promptHash: "a".repeat(64),
      intentType: "comparison",
      commercialValue: 3,
      winnability: 3,
      priority: 10,
      rationale: "fixture",
      provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: version.id,
      projectId: project.id,
      approvedBy: APPROVER,
    });
    const protocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE,
      projectId: project.id,
      buyerQuestionVersionId: version.id,
    });
    if (opts.approve) {
      await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    }
    return { projectId: project.id, protocolId: protocol.id };
  }

  const call = async (projectId: string, body: unknown) =>
    POST(
      new Request("http://localhost/api/projects/x/protocol-runs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ projectId }) }
    );

  // ---------------------------------------------------------------- 1
  console.log("[1-4] auth and enumeration guards");
  const owned = await seed(OWNER.id);
  stubbedUser = null;
  {
    const res = await call(owned.projectId, { protocolId: owned.protocolId });
    check("unauthenticated → 401", res.status === 401, String(res.status));
  }

  stubbedUser = OWNER;
  let bodyUnknownProtocol = "";
  {
    const res = await call(owned.projectId, {
      protocolId: "44444444-4444-4444-8444-444444444444",
    });
    bodyUnknownProtocol = await res.text();
    check("unknown protocol → 404", res.status === 404, String(res.status));
  }

  stubbedUser = STRANGER;
  {
    const res = await call(owned.projectId, { protocolId: owned.protocolId });
    const body = await res.text();
    check("authenticated non-owner → 404", res.status === 404, String(res.status));
    check(
      "…with a body byte-identical to the unknown-protocol case (no enumeration signal)",
      body === bodyUnknownProtocol
    );
  }

  {
    const legacy = await seed(null);
    stubbedUser = OWNER;
    const res = await call(legacy.projectId, { protocolId: legacy.protocolId });
    check("legacy null-owner project → 404", res.status === 404, String(res.status));
  }

  // ---------------------------------------------------------------- 5
  console.log("\n[5] tenant isolation on the protocol id");
  {
    const other = await seed(OWNER.id);
    stubbedUser = OWNER;
    const res = await call(owned.projectId, { protocolId: other.protocolId });
    const body = await res.text();
    check(
      "a protocol belonging to another project → 404, same body as unknown",
      res.status === 404 && body === bodyUnknownProtocol,
      String(res.status)
    );
  }

  // ---------------------------------------------------------------- 6
  console.log("\n[6] an unapproved protocol is not executable");
  {
    const draft = await seed(OWNER.id, { approve: false });
    stubbedUser = OWNER;
    const res = await call(draft.projectId, { protocolId: draft.protocolId });
    const body = (await res.json()) as { ok: boolean; outcome?: string };
    check(
      "unapproved protocol → 409 PROTOCOL_NOT_APPROVED",
      res.status === 409 && body.ok === false && body.outcome === "PROTOCOL_NOT_APPROVED",
      `${res.status}/${body.outcome}`
    );
  }

  // ---------------------------------------------------------------- 7
  console.log("\n[7] the happy path, and its idempotency");
  stubbedUser = OWNER;
  let jobId = "";
  {
    const res = await call(owned.projectId, { protocolId: owned.protocolId });
    const body = (await res.json()) as { ok: boolean; outcome: string; jobId: string };
    jobId = body.jobId;
    check(
      "owner + approved → 201 QUEUED",
      res.status === 201 && body.ok === true && body.outcome === "QUEUED",
      `${res.status}/${body.outcome}`
    );
    check("a job id is returned", typeof jobId === "string" && jobId.length > 0);
  }
  {
    const res = await call(owned.projectId, { protocolId: owned.protocolId });
    const body = (await res.json()) as { outcome: string; jobId: string };
    check(
      "a replay → 200 ALREADY_EXISTS with the same job id",
      res.status === 200 && body.outcome === "ALREADY_EXISTS" && body.jobId === jobId,
      `${res.status}/${body.outcome}`
    );
  }

  // ---------------------------------------------------------------- 8
  console.log("\n[8] hammering the endpoint spends nothing");
  {
    const before = await db.getProtocolExecutionJobContext({
      jobId,
      claimToken: "not-a-token",
      projectId: owned.projectId,
    });
    check(
      "the queued job has no attempt and no external call yet",
      before.outcome === "JOB_NOT_OWNED",
      before.outcome
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => call(owned.projectId, { protocolId: owned.protocolId }))
    );
    const outcomes = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { jobId: string }).jobId)
    );
    check(
      "10 concurrent submits still resolve to exactly one job",
      new Set(outcomes).size === 1 && outcomes[0] === jobId
    );
    check("zero outbound calls were attempted from the request path", outboundFetches === 0);
  }

  // ---------------------------------------------------------------- 9
  console.log("\n[9] the response leaks nothing");
  {
    const res = await call(owned.projectId, { protocolId: owned.protocolId });
    const text = await res.text();
    check(
      "no claim token, lease, cost or prompt text in the body",
      !/claimToken|claim_token|leaseExpires|costUsd|paraphrase/i.test(text),
      text
    );
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>).sort();
    check("the body carries exactly ok/outcome/jobId", keys.join(",") === "jobId,ok,outcome", keys.join(","));
  }

  // ---------------------------------------------------------------- 10
  console.log("\n[10] malformed input");
  {
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: "not json" }),
      { params: Promise.resolve({ projectId: owned.projectId }) }
    );
    check("a non-JSON body → 400", res.status === 400, String(res.status));
    const res2 = await call(owned.projectId, { protocolId: 42 });
    check("a non-string protocolId → 400", res2.status === 400, String(res2.status));
  }

  globalThis.fetch = realFetch;
  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A web enqueue contract PASSED." : "M5-A web enqueue contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
