#!/usr/bin/env tsx
/**
 * Static contract assertions over migration 0031.
 *
 * These read the migration as text. They prove the SQL *says* what the
 * fencing design requires — they do not execute PostgreSQL, so they
 * prove nothing about locking, transaction atomicity, or privileges.
 *
 * No database, network, or migration execution occurs here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/0031_snapshot_worker_fenced_writes.sql"
);

const sql = readFileSync(MIGRATION, "utf-8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

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

function has(fragment: string): boolean {
  return flat.includes(fragment.replace(/\s+/g, " ").toLowerCase());
}

/** Body of a `create or replace function public.<name>(` block. */
function body(name: string): string {
  const re = new RegExp(
    `create or replace function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
    "i"
  );
  return re.exec(sql)?.[0] ?? "";
}

const PUBLIC_RPCS = [
  ["update_snapshot_request_progress", "uuid, uuid, text"],
  ["finalize_snapshot_request", "uuid, uuid, text"],
  ["update_snapshot_request_progress_worker", "uuid, uuid, uuid, text"],
  [
    "complete_snapshot_report_worker",
    "uuid, uuid, uuid, text, text, text, text, timestamptz",
  ],
  ["mark_snapshot_request_failed_worker", "uuid, uuid, uuid"],
  [
    "save_snapshot_report_artifact_manual",
    "uuid, uuid, text, text, text, text, timestamptz",
  ],
  [
    "insert_snapshot_report_artifact_backfill",
    "uuid, uuid, text, text, text, text, timestamptz",
  ],
  ["mark_snapshot_report_delivered", "uuid, text, timestamptz, boolean"],
  ["claim_next_snapshot_request", "text, integer, integer"],
] as const;

const INTERNAL_HELPERS = [
  ["_lock_active_snapshot_worker_claim", "uuid, uuid, uuid"],
  ["_generate_snapshot_public_token", ""],
  ["_assert_snapshot_artifact_input", "text, text, text, text, timestamptz"],
] as const;

const ARTIFACT_RPCS = [
  "complete_snapshot_report_worker",
  "save_snapshot_report_artifact_manual",
  "insert_snapshot_report_artifact_backfill",
  "mark_snapshot_report_delivered",
];

const WORKER_RPCS = [
  "update_snapshot_request_progress_worker",
  "complete_snapshot_report_worker",
  "mark_snapshot_request_failed_worker",
];

console.log("\nFunctions exist");
for (const [name] of [...PUBLIC_RPCS, ...INTERNAL_HELPERS]) {
  check(`${name} is defined`, body(name).length > 0);
}

console.log("\nSignatures");
check(
  "worker progress signature",
  has(
    "public.update_snapshot_request_progress_worker( p_request_id uuid, p_project_id uuid, p_claim_token uuid, p_progress_stage text )"
  )
);
check(
  "atomic completion signature",
  has(
    "public.complete_snapshot_report_worker( p_request_id uuid, p_project_id uuid, p_claim_token uuid, p_full_markdown text, p_short_markdown text, p_full_filename text, p_short_filename text, p_generated_at timestamptz )"
  )
);
check(
  "worker failure signature",
  has(
    "public.mark_snapshot_request_failed_worker( p_request_id uuid, p_project_id uuid, p_claim_token uuid )"
  )
);
check(
  "manual save signature",
  has(
    "public.save_snapshot_report_artifact_manual( p_request_id uuid, p_project_id uuid, p_full_markdown text, p_short_markdown text, p_full_filename text, p_short_filename text, p_generated_at timestamptz )"
  )
);
check(
  "backfill signature",
  has(
    "public.insert_snapshot_report_artifact_backfill( p_request_id uuid, p_project_id uuid, p_full_markdown text, p_short_markdown text, p_full_filename text, p_short_filename text, p_generated_at timestamptz )"
  )
);
check(
  "delivery signature includes p_resend",
  has(
    "public.mark_snapshot_report_delivered( p_request_id uuid, p_message_id text, p_delivered_at timestamptz, p_resend boolean )"
  )
);
check(
  "manual RPC signatures unchanged from 0025/0026",
  has("public.update_snapshot_request_progress( p_request_id uuid, p_project_id uuid, p_progress_stage text )") &&
    has("public.finalize_snapshot_request( p_request_id uuid, p_project_id uuid, p_final_status text )")
);

console.log("\nSecurity pattern");
const fnCount = PUBLIC_RPCS.length + INTERNAL_HELPERS.length;
check(
  `all ${fnCount} functions are SECURITY DEFINER`,
  (sql.match(/security definer/gi) ?? []).length === fnCount,
  `found ${(sql.match(/security definer/gi) ?? []).length}`
);
check(
  `all ${fnCount} functions set search_path`,
  (sql.match(/set search_path = public, pg_temp/gi) ?? []).length === fnCount
);

/**
 * Signature matcher tolerant of the multi-line form these long argument
 * lists use, e.g. `public.f(\n  uuid, uuid, text\n)`.
 */
function signaturePattern(name: string, args: string): string {
  const argList = args
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .join("\\s*,\\s*");
  return `public\\.${name}\\s*\\(\\s*${argList}\\s*\\)`;
}

function revokedFrom(name: string, args: string, role: string): boolean {
  return new RegExp(
    `revoke\\s+all\\s+on\\s+function\\s+${signaturePattern(name, args)}\\s+from\\s+${role}`,
    "i"
  ).test(flat);
}
function grantedTo(name: string, args: string, role: string): boolean {
  return new RegExp(
    `grant\\s+execute\\s+on\\s+function\\s+${signaturePattern(name, args)}\\s+to\\s+${role}`,
    "i"
  ).test(flat);
}

/** The SET list of an UPDATE, excluding its WHERE clause. */
function setList(source: string, table: string): string {
  const re = new RegExp(
    `update\\s+public\\.${table}\\s+set([\\s\\S]*?)\\s+where\\s`,
    "i"
  );
  return re.exec(source)?.[1] ?? "";
}

for (const [name, args] of PUBLIC_RPCS) {
  check(
    `${name}: revoked from public/anon/authenticated`,
    ["public", "anon", "authenticated"].every((r) => revokedFrom(name, args, r))
  );
  check(
    `${name}: granted to service_role`,
    grantedTo(name, args, "service_role")
  );
}

for (const [name, args] of INTERNAL_HELPERS) {
  check(
    `${name}: revoked from all four roles including service_role`,
    ["public", "anon", "authenticated", "service_role"].every((r) =>
      revokedFrom(name, args, r)
    )
  );
  check(
    `${name}: never granted to anyone`,
    !new RegExp(
      `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}`,
      "i"
    ).test(sql)
  );
}

console.log("\nLocking");
check(
  "worker helper locks the request row FOR UPDATE",
  /for update/i.test(body("_lock_active_snapshot_worker_claim"))
);
check(
  "worker helper returns the locked row type",
  /returns public\.snapshot_requests/i.test(
    body("_lock_active_snapshot_worker_claim")
  )
);
for (const name of ARTIFACT_RPCS) {
  const b = body(name);
  const reqIdx = b.search(/from public\.snapshot_requests/i);
  const artIdx = b.search(/from public\.snapshot_report_artifacts/i);
  const viaHelper = /_lock_active_snapshot_worker_claim/i.test(b);
  check(
    `${name}: locks request before artifact`,
    (viaHelper && artIdx >= 0) ||
      (reqIdx >= 0 && artIdx >= 0 && reqIdx < artIdx),
    `req@${reqIdx} art@${artIdx} helper=${viaHelper}`
  );
  check(
    `${name}: locks the artifact row FOR UPDATE`,
    /snapshot_report_artifacts[\s\S]{0,200}?for update/i.test(b)
  );
}

console.log("\nToken and lease predicates");
const helper = body("_lock_active_snapshot_worker_claim");
for (const [label, re] of [
  ["claim_token is non-null", /claim_token is null/i],
  ["claim_token equals the supplied token", /claim_token <> p_claim_token/i],
  ["lease_expires_at is non-null", /lease_expires_at is null/i],
  ["lease is unexpired", /lease_expires_at <= now\(\)/i],
  ["status is running", /status <> 'running'/i],
  ["project ID matches", /project_id <> p_project_id/i],
  ["claimed_by coherence checked", /claimed_by is null/i],
] as Array<[string, RegExp]>) {
  check(`worker helper enforces: ${label}`, re.test(helper));
}
check(
  "worker helper never renews the lease",
  !/set[\s\S]{0,120}lease_expires_at\s*=/i.test(helper)
);
for (const name of WORKER_RPCS) {
  check(
    `${name}: never renews the lease`,
    !/lease_expires_at\s*=\s*now\(\)\s*\+/i.test(body(name))
  );
}

console.log("\nManual ownership guards");
for (const name of [
  "update_snapshot_request_progress",
  "finalize_snapshot_request",
  "save_snapshot_report_artifact_manual",
  "insert_snapshot_report_artifact_backfill",
]) {
  check(
    `${name}: refuses worker-owned requests (claim_token IS NOT NULL)`,
    /claim_token is not null/i.test(body(name))
  );
}
check(
  "manual save requires status = running",
  /status <> 'running'/i.test(body("save_snapshot_report_artifact_manual"))
);
check(
  "backfill requires status = report_ready",
  /status <> 'report_ready'/i.test(
    body("insert_snapshot_report_artifact_backfill")
  )
);

console.log("\nArtifact input validation");
for (const name of [
  "complete_snapshot_report_worker",
  "save_snapshot_report_artifact_manual",
  "insert_snapshot_report_artifact_backfill",
]) {
  check(
    `${name}: validates artifact input`,
    /_assert_snapshot_artifact_input/i.test(body(name))
  );
}
check(
  "artifact validation raises SQLSTATE 22023",
  /errcode = '22023'[\s\S]{0,80}invalid_snapshot_artifact_input/i.test(
    body("_assert_snapshot_artifact_input")
  )
);
check(
  "delivery validation raises SQLSTATE 22023",
  /errcode = '22023'[\s\S]{0,80}invalid_snapshot_delivery_input/i.test(
    body("mark_snapshot_report_delivered")
  )
);

console.log("\nPublic token contract");
check(
  "token generated from two gen_random_uuid() values with hyphens removed",
  has(
    "select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')"
  )
);
check(
  "no RPC accepts a caller-supplied public token",
  !/p_public_token/i.test(sql)
);
for (const name of [
  "complete_snapshot_report_worker",
  "save_snapshot_report_artifact_manual",
  "insert_snapshot_report_artifact_backfill",
]) {
  const b = body(name);
  check(
    `${name}: inserts a generated token`,
    /_generate_snapshot_public_token\(\)/i.test(b)
  );
  const updates = b.match(/update public\.snapshot_report_artifacts[\s\S]*?where/gi) ?? [];
  check(
    `${name}: public_token omitted from every artifact UPDATE SET list`,
    updates.every((u) => !/public_token\s*=/i.test(u))
  );
  check(
    `${name}: delivery fields omitted from every artifact UPDATE SET list`,
    updates.every(
      (u) => !/delivered_at\s*=/i.test(u) && !/delivery_message_id\s*=/i.test(u)
    )
  );
}

console.log("\nDelivered-artifact guards");
for (const name of [
  "complete_snapshot_report_worker",
  "save_snapshot_report_artifact_manual",
]) {
  check(
    `${name}: refuses a delivered artifact`,
    /delivered_at is not null/i.test(body(name))
  );
}
check(
  "backfill is insert-only (no UPDATE of the artifact table)",
  !/update public\.snapshot_report_artifacts/i.test(
    body("insert_snapshot_report_artifact_backfill")
  )
);
check(
  "backfill returns early when any artifact exists",
  /if v_artifact_exists then\s*return;/i.test(
    body("insert_snapshot_report_artifact_backfill")
  )
);

console.log("\nDelivery RPC");
const delivery = body("mark_snapshot_report_delivered");
check(
  "delivery requires request status report_ready",
  /status <> 'report_ready'/i.test(delivery)
);
check(
  "delivery requires the artifact to exist",
  /if not found then\s*return;/i.test(delivery)
);
check(
  "initial delivery requires delivered_at IS NULL",
  /not p_resend[\s\S]{0,80}delivered_at is not null/i.test(delivery)
);
check(
  "resend requires delivered_at IS NOT NULL",
  /p_resend[\s\S]{0,80}delivered_at is null/i.test(delivery)
);
const deliveryUpdate = setList(delivery, "snapshot_report_artifacts");
check(
  "delivery updates only delivered_at, delivery_message_id, updated_at",
  /delivered_at = p_delivered_at/i.test(deliveryUpdate) &&
    /delivery_message_id = p_message_id/i.test(deliveryUpdate) &&
    !/full_report_markdown\s*=/i.test(deliveryUpdate) &&
    !/short_report_markdown\s*=/i.test(deliveryUpdate) &&
    !/_filename\s*=/i.test(deliveryUpdate) &&
    !/generated_at\s*=/i.test(deliveryUpdate) &&
    !/public_token\s*=/i.test(deliveryUpdate) &&
    !/project_id\s*=/i.test(deliveryUpdate) &&
    !/snapshot_request_id\s*=/i.test(deliveryUpdate),
  `SET list: ${deliveryUpdate.replace(/\s+/g, " ").trim()}`
);

console.log("\nAtomic completion");
const completion = body("complete_snapshot_report_worker");
check(
  "completion mutates the artifact and the request in one function",
  /insert into public\.snapshot_report_artifacts/i.test(completion) &&
    /update public\.snapshot_requests/i.test(completion)
);
check(
  "completion sets report_ready and quality_review",
  /status = 'report_ready'/i.test(completion) &&
    /progress_stage = 'quality_review'/i.test(completion)
);
check(
  "completion clears all three ownership fields",
  /claimed_by = null/i.test(completion) &&
    /claim_token = null/i.test(completion) &&
    /lease_expires_at = null/i.test(completion)
);
check(
  "completion preserves attempt_count",
  !/attempt_count\s*=/i.test(completion)
);

console.log("\nFailure invariants");
const workerFail = body("mark_snapshot_request_failed_worker");
check(
  "worker failure requires no artifact",
  /v_artifact_exists then\s*return;/i.test(workerFail)
);
check(
  "worker failure clears ownership",
  /claimed_by = null/i.test(workerFail) &&
    /claim_token = null/i.test(workerFail) &&
    /lease_expires_at = null/i.test(workerFail)
);
const workerFailUpdate = setList(workerFail, "snapshot_requests");
check(
  "worker failure preserves project, progress, and attempt_count",
  !/project_id\s*=/i.test(workerFailUpdate) &&
    !/progress_stage\s*=/i.test(workerFailUpdate) &&
    !/attempt_count\s*=/i.test(workerFailUpdate),
  `SET list: ${workerFailUpdate.replace(/\s+/g, " ").trim()}`
);
const manualFinal = body("finalize_snapshot_request");
check(
  "manual failed finalization requires no artifact",
  /'failed'\s*and v_artifact_exists/i.test(manualFinal)
);
check(
  "manual report_ready finalization requires an artifact",
  /if not v_artifact_exists then\s*return;/i.test(manualFinal)
);
check(
  "manual report_ready still requires quality_review",
  /progress_stage is distinct from 'quality_review'/i.test(manualFinal)
);
check(
  "manual finalization keeps invalid-status validation",
  /invalid_snapshot_final_status/i.test(manualFinal)
);

console.log("\nClaim-next correction");
const claim = body("claim_next_snapshot_request");
check(
  "terminalization skips artifact-bearing requests",
  /attempt_count >= p_max_attempts[\s\S]{0,200}not exists[\s\S]{0,200}snapshot_report_artifacts/i.test(
    claim
  )
);
check("claim-next preserves FOR UPDATE SKIP LOCKED", /for update skip locked/i.test(claim));
check(
  "claim-next preserves stale-before-queued ordering",
  /case when request\.status = 'running' then 0 else 1 end/i.test(claim)
);
check(
  "claim-next preserves project reservation",
  /_ensure_snapshot_request_project/i.test(claim)
);
check("claim-next preserves token generation", /gen_random_uuid\(\)/i.test(claim));
check(
  "claim-next preserves attempt increment",
  /attempt_count = snapshot_requests\.attempt_count \+ 1/i.test(claim)
);
check(
  "claim-next preserves input validation",
  /invalid_worker_id/i.test(claim) &&
    /invalid_lease_seconds/i.test(claim) &&
    /invalid_max_attempts/i.test(claim)
);
check(
  "claim-next performs no automatic reconciliation to report_ready",
  !/status = 'report_ready'/i.test(claim)
);

console.log("\nPrivilege boundary is untouched in 0031");
check("no ALTER DEFAULT PRIVILEGES", !/alter default privileges/i.test(sql));
check(
  "no table privilege revocation",
  !/revoke[\s\S]{0,80}on\s+table\s+/i.test(sql)
);
check("no table privilege grant", !/grant[\s\S]{0,80}on\s+table\s+/i.test(sql));
check("no CREATE/ALTER TABLE", !/\b(create|alter)\s+table\b/i.test(sql));

console.log("\n─────────────────────────────────────────────────────────");
console.log(
  "LIMITATION: Static SQL assertions do not prove locking, transaction"
);
console.log(
  "atomicity, or privilege behavior. FOR UPDATE ordering, all-or-nothing"
);
console.log(
  "completion, and SET ROLE enforcement remain unproven until the"
);
console.log("PostgreSQL Level 2 harness runs against a real database.");
console.log("─────────────────────────────────────────────────────────");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
