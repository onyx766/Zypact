#!/usr/bin/env tsx
/**
 * Snapshot report delivery idempotency tests.
 *
 * The defect these cover: an initial send and an explicit resend once
 * shared one permanent provider key, so a resend was deduplicated
 * against the original email and silently delivered nothing.
 *
 * Every provider call is intercepted through a stubbed `globalThis.fetch`,
 * so no network request is made. `process.env` and every global mutated
 * here is restored after the run.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { createHash, randomUUID } from "node:crypto";
import { memoryAdapter } from "@/lib/db/memory-adapter";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";
import {
  ClientReportDeliveryError,
  sendClientSnapshotReport,
} from "@/lib/snapshot-requests/client-report-delivery";
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── harness ─────────────────────────────────────────────────────────── */

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

const FOUNDER_EMAIL = "founder@example.com";
const OUTSIDER_EMAIL = "outsider@example.com";

const OWNED_ENV = [
  "RESEND_API_KEY",
  "SNAPSHOT_EMAIL_FROM",
  "SNAPSHOT_FOUNDER_EMAILS",
  "NEXT_PUBLIC_SITE_URL",
] as const;

const originalEnv = new Map<string, string | undefined>(
  OWNED_ENV.map((k) => [k, process.env[k]])
);
const realFetch = globalThis.fetch;

process.env.RESEND_API_KEY = "placeholder-not-a-real-key";
process.env.SNAPSHOT_EMAIL_FROM = "Zypact <reports@example.com>";
process.env.SNAPSHOT_FOUNDER_EMAILS = FOUNDER_EMAIL;
process.env.NEXT_PUBLIC_SITE_URL = "https://example.invalid";

/** Auth stub — the same seam `scripts/test-auth-ownership.ts` uses. */
let currentEmail: string | null = FOUNDER_EMAIL;
__setSupabaseServerClientForTests({
  auth: {
    async getUser() {
      if (!currentEmail) return { data: { user: null }, error: null };
      return {
        data: { user: { id: "founder-id", email: currentEmail } },
        error: null,
      };
    },
  },
} as unknown as SupabaseClient);

/* ── provider stub ───────────────────────────────────────────────────── */

interface ProviderCall {
  idempotencyKey: string | null;
  url: string;
}

let providerCalls: ProviderCall[] = [];
let providerMessageId = "msg-initial";
let providerShouldFail = false;
let networkEscapes = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  if (!url.startsWith("https://api.resend.com/")) {
    // Nothing else may reach the network from this suite.
    networkEscapes += 1;
    throw new Error(`unexpected network call: ${url}`);
  }

  const headers = new Headers(init?.headers);
  providerCalls.push({
    idempotencyKey: headers.get("idempotency-key"),
    url,
  });

  if (providerShouldFail) {
    return new Response(JSON.stringify({ name: "provider_boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ id: providerMessageId }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

/* ── fixtures ────────────────────────────────────────────────────────── */

interface Fixture {
  requestId: string;
  artifactId: string;
}

async function seed(): Promise<Fixture> {
  const suffix = randomUUID();
  const request = await memoryAdapter.createSnapshotRequest({
    workEmail: `client-${suffix}@example.com`,
    normalizedEmail: `client-${suffix}@example.com`,
    companyName: "Delivery Test",
    websiteUrl: `https://delivery-${suffix}.example.com`,
    normalizedDomain: `delivery-${suffix}.example.com`,
    buyerCategory: "B2B SaaS testing",
    requestIpHash: null,
  });

  const artifact = await memoryAdapter.saveSnapshotReportArtifact({
    snapshotRequestId: request.id,
    projectId: randomUUID(),
    fullReportMarkdown: "# Full report\n",
    shortReportMarkdown: "# Short report\n",
    fullReportFilename: "full.md",
    shortReportFilename: "short.md",
    generatedAt: new Date().toISOString(),
  });

  if (!artifact) {
    throw new Error("seed fixture: saveSnapshotReportArtifact returned null");
  }

  return { requestId: request.id, artifactId: artifact.id };
}

type Body = string | undefined;

async function post(
  requestId: string,
  body: Body
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { POST } = await import(
    "@/app/api/internal/snapshot-requests/[requestId]/send-report/route"
  );
  const request = new Request(
    `https://example.invalid/api/internal/snapshot-requests/${requestId}/send-report`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    }
  );
  const response = await POST(request, { params: Promise.resolve({ requestId }) });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { status: response.status, payload };
}

function resetCalls(): void {
  providerCalls = [];
}

/* ── 1-5. First delivery ─────────────────────────────────────────────── */

async function firstDeliveryCases(): Promise<void> {
  console.log("\nFirst delivery");

  for (const [label, body] of [
    ["1. empty body first send → 200", undefined],
    ["2. {} first send → 200", "{}"],
    ['3. { resend: false } first send → 200', '{"resend":false}'],
  ] as Array<[string, Body]>) {
    const fx = await seed();
    resetCalls();
    const { status } = await post(fx.requestId, body);
    check(label, status === 200, `status ${status}`);
  }

  const fx = await seed();
  resetCalls();
  providerMessageId = "msg-first-send";
  const { status } = await post(fx.requestId, undefined);

  check(
    "4. first send uses the /initial key",
    providerCalls.length === 1 &&
      providerCalls[0].idempotencyKey ===
        `snapshot-report/${fx.artifactId}/initial`,
    providerCalls[0]?.idempotencyKey ?? "no call"
  );
  console.log(`      key: ${providerCalls[0]?.idempotencyKey}`);

  const stored = await memoryAdapter.getSnapshotReportArtifact(fx.requestId);
  check(
    "5. first send persists message ID and deliveredAt",
    status === 200 &&
      stored?.deliveryMessageId === "msg-first-send" &&
      typeof stored?.deliveredAt === "string",
    `messageId=${stored?.deliveryMessageId} deliveredAt=${stored?.deliveredAt}`
  );
}

/* ── 6-12. Guard, resend generations, legacy ─────────────────────────── */

async function resendCases(): Promise<void> {
  console.log("\nIntent guard and resend generations");

  const fx = await seed();
  providerMessageId = "msg-gen-one";
  await post(fx.requestId, undefined);

  resetCalls();
  const blocked = await post(fx.requestId, undefined);
  check(
    "6. already delivered without resend → 409, zero provider calls",
    blocked.status === 409 &&
      blocked.payload.error === "already_delivered" &&
      typeof blocked.payload.deliveredAt === "string" &&
      providerCalls.length === 0,
    `status ${blocked.status}, calls ${providerCalls.length}`
  );

  resetCalls();
  providerMessageId = "msg-gen-two";
  const resent = await post(fx.requestId, '{"resend":true}');
  check("7. already delivered with resend:true → 200", resent.status === 200);

  const expectedDigest = createHash("sha256")
    .update("msg-gen-one")
    .digest("hex");
  const resendKey = providerCalls[0]?.idempotencyKey ?? "";
  check(
    "8. resend key carries the SHA-256 digest, not the raw message ID",
    resendKey === `snapshot-report/${fx.artifactId}/resend/${expectedDigest}` &&
      !resendKey.includes("msg-gen-one"),
    resendKey
  );
  console.log(`      key: ${resendKey}`);
  console.log(`      raw provider id "msg-gen-one" present in key: ${resendKey.includes("msg-gen-one")}`);

  resetCalls();
  providerMessageId = "msg-gen-three";
  await post(fx.requestId, '{"resend":true}');
  const secondResendKey = providerCalls[0]?.idempotencyKey ?? "";
  check(
    "9. resend after a new persisted message ID produces a new key",
    secondResendKey !== resendKey &&
      secondResendKey ===
        `snapshot-report/${fx.artifactId}/resend/${createHash("sha256")
          .update("msg-gen-two")
          .digest("hex")}`,
    secondResendKey
  );

  // 10. concurrent first sends
  const concurrentFx = await seed();
  resetCalls();
  providerMessageId = "msg-concurrent-initial";
  await Promise.all([
    post(concurrentFx.requestId, undefined),
    post(concurrentFx.requestId, undefined),
  ]);
  const initialKeys = providerCalls.map((c) => c.idempotencyKey);
  check(
    "10. two concurrent first sends use identical keys",
    initialKeys.length === 2 &&
      initialKeys[0] === initialKeys[1] &&
      initialKeys[0] === `snapshot-report/${concurrentFx.artifactId}/initial`,
    JSON.stringify(initialKeys)
  );
  console.log(`      keys: ${JSON.stringify(initialKeys)}`);

  // 11. concurrent resends from one generation
  resetCalls();
  providerMessageId = "msg-concurrent-resend";
  await Promise.all([
    post(concurrentFx.requestId, '{"resend":true}'),
    post(concurrentFx.requestId, '{"resend":true}'),
  ]);
  const resendKeys = providerCalls.map((c) => c.idempotencyKey);
  check(
    "11. two concurrent resends of one generation use identical keys",
    resendKeys.length === 2 && resendKeys[0] === resendKeys[1],
    JSON.stringify(resendKeys)
  );
  console.log(`      keys: ${JSON.stringify(resendKeys)}`);

  // 12. legacy delivered artifact with no message ID
  const legacyFx = await seed();
  const legacy = await memoryAdapter.getSnapshotReportArtifact(
    legacyFx.requestId
  );
  if (legacy) {
    await memoryAdapter.markSnapshotReportDelivered(
      legacyFx.requestId,
      "",
      new Date().toISOString(),
      false
    );
  }
  resetCalls();
  providerMessageId = "msg-legacy";
  await post(legacyFx.requestId, '{"resend":true}');
  check(
    "12. legacy delivered artifact without a message ID uses /resend/legacy",
    providerCalls[0]?.idempotencyKey ===
      `snapshot-report/${legacyFx.artifactId}/resend/legacy`,
    providerCalls[0]?.idempotencyKey ?? "no call"
  );
  console.log(`      key: ${providerCalls[0]?.idempotencyKey}`);
}

/* ── 13. Provider success, persistence failure ───────────────────────── */

async function persistenceFailureCase(): Promise<void> {
  console.log("\nProvider success followed by persistence failure");

  const fx = await seed();
  const original = memoryAdapter.markSnapshotReportDelivered.bind(memoryAdapter);
  (
    memoryAdapter as unknown as {
      markSnapshotReportDelivered: () => Promise<null>;
    }
  ).markSnapshotReportDelivered = async () => null;

  resetCalls();
  providerMessageId = "msg-persist-fail";
  const failedRun = await post(fx.requestId, undefined);
  const keyDuringFailure = providerCalls[0]?.idempotencyKey ?? "";

  (
    memoryAdapter as unknown as {
      markSnapshotReportDelivered: typeof original;
    }
  ).markSnapshotReportDelivered = original;

  const stored = await memoryAdapter.getSnapshotReportArtifact(fx.requestId);
  resetCalls();
  await post(fx.requestId, undefined);
  const retryKey = providerCalls[0]?.idempotencyKey ?? "";

  check(
    "13. persistence failure → 500, deliveredAt unset, retry reuses the same key",
    failedRun.status === 500 &&
      stored?.deliveredAt === null &&
      retryKey === keyDuringFailure &&
      retryKey === `snapshot-report/${fx.artifactId}/initial`,
    `status ${failedRun.status}, deliveredAt ${stored?.deliveredAt}, key ${retryKey}`
  );
  console.log(`      key on both attempts: ${retryKey}`);
}

/* ── 14-18. Body contract ────────────────────────────────────────────── */

async function bodyContractCases(): Promise<void> {
  console.log("\nRequest-body contract");

  const cases: Array<[string, Body]> = [
    ["14. malformed JSON → 400", "{invalid-json"],
    ["15. array body → 400", "[]"],
    ["16. null body → 400", "null"],
    ["17. non-boolean resend → 400", '{"resend":"yes"}'],
    ["18. unknown property → 400", '{"resend":true,"force":true}'],
  ];

  for (const [label, body] of cases) {
    const fx = await seed();
    resetCalls();
    const { status, payload } = await post(fx.requestId, body);
    check(
      label,
      status === 400 &&
        payload.error === "invalid_body" &&
        providerCalls.length === 0,
      `status ${status}, error ${String(payload.error)}, calls ${providerCalls.length}`
    );
  }
}

/* ── 19-22. Key validation and authorization ─────────────────────────── */

async function senderAndAuthCases(): Promise<void> {
  console.log("\nKey validation and authorization");

  const base = {
    requestId: randomUUID(),
    to: "client@example.com",
    companyName: "Key Test",
    publicToken: "z".repeat(44),
    visibilitySummary: "s",
    brandedReputation: "b",
    firstPriorityAction: "f",
  };
  const config = {
    apiKey: "placeholder-not-a-real-key",
    from: "Zypact <reports@example.com>",
    replyTo: null,
    appBaseUrl: "https://example.invalid",
  };

  for (const [label, key] of [
    ["19. empty idempotency key is rejected before fetch", "   "],
    ["20. key longer than 256 characters is rejected before fetch", "k".repeat(257)],
  ] as Array<[string, string]>) {
    resetCalls();
    let code = "";
    try {
      await sendClientSnapshotReport(
        { ...base, deliveryIdempotencyKey: key },
        config
      );
    } catch (error) {
      code =
        error instanceof ClientReportDeliveryError ? error.code : "wrong_type";
    }
    check(
      label,
      code === "invalid_idempotency_key" && providerCalls.length === 0,
      `code ${code}, calls ${providerCalls.length}`
    );
  }

  const fx = await seed();
  currentEmail = OUTSIDER_EMAIL;
  resetCalls();
  const denied = await post(fx.requestId, undefined);
  currentEmail = FOUNDER_EMAIL;
  check(
    "21. non-founder → concealed 404, zero provider calls",
    denied.status === 404 &&
      denied.payload.error === "not_found" &&
      providerCalls.length === 0,
    `status ${denied.status}, calls ${providerCalls.length}`
  );

  resetCalls();
  const missing = await post(randomUUID(), undefined);
  check(
    "22. missing artifact → 404, zero provider calls",
    missing.status === 404 &&
      missing.payload.error === "report_not_found" &&
      providerCalls.length === 0,
    `status ${missing.status}, calls ${providerCalls.length}`
  );
}

/* ── run ─────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  try {
    await firstDeliveryCases();
    await resendCases();
    await persistenceFailureCase();
    await bodyContractCases();
    await senderAndAuthCases();

    console.log("\nIsolation");
    check(
      "23. no request escaped the provider stub",
      networkEscapes === 0,
      `escapes: ${networkEscapes}`
    );
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __setSupabaseServerClientForTests(null);
    providerShouldFail = false;
  }

  const envRestored = OWNED_ENV.every(
    (k) => process.env[k] === originalEnv.get(k)
  );
  check("24. process.env and globals restored", envRestored);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
