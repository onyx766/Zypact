/**
 * Phase 1 — the intervention route plumbing.
 *
 * The centrepiece is section [1]. It reads migrations 0071-0078 and 0082 from disk,
 * extracts every `message = '...'` they can raise, and fails if any is
 * missing from RPC_ERROR_MAP. A future migration that adds a RAISE without
 * a matching entry breaks this test instead of reaching a founder as a
 * generic 500. The map cannot drift out of date silently.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  RPC_ERROR_MAP,
  describeRetestEligibility,
  mapCreateRetestOutcome,
  mapRpcError,
} from "@/lib/interventions/rpc-errors";
import { evaluateFounderAccess } from "@/lib/auth/founder";
import { interventionAdminEnabled } from "@/lib/interventions/route-guard";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const M7_RANGE = /^(007[1-8]|0082)_.*\.sql$/;

function raisedMessages(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => M7_RANGE.test(f)).sort()) {
    // Strip `--` comments first so a message quoted in prose is not counted.
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const m of sql.matchAll(/message\s*=\s*'([a-z_]+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

console.log("\nIntervention route plumbing (Phase 1)\n");

/* ═══════════ 1. every raised message is mapped ═══════════ */
console.log("[1] Every message 0071-0078 and 0082 can raise is mapped");
const raised = raisedMessages();
check("found the M7 migrations and their messages", raised.size >= 25, `found ${raised.size}`);
for (const [message, file] of raised) {
  check(`mapped: ${message}`, message in RPC_ERROR_MAP, `raised in ${file}, missing from RPC_ERROR_MAP`);
}

// The reverse direction: a map entry no migration raises is dead, and dead
// entries hide typos — a misspelt key would pass every other check here.
for (const key of Object.keys(RPC_ERROR_MAP)) {
  check(`not stale: ${key}`, raised.has(key), "in RPC_ERROR_MAP but raised by no migration in 0071-0078 or 0082");
}

/* ═══════════ 2. mapping behaviour ═══════════ */
console.log("\n[2] mapRpcError");
const refusal = mapRpcError({ message: "retest_already_started", code: "P0001" });
check("the abandonment refusal is a 409", refusal.status === 409);
check("its error code is the raised message", refusal.error === "retest_already_started");
check("its wording states the rule rather than softening it",
  /can no longer be abandoned/.test(refusal.message));

const prefixed = mapRpcError({ message: "unexpected_retest_protocol_approval_status:CONFLICT", code: "P0001" });
check("the dynamic-suffix message from 0073 is matched by prefix",
  prefixed.error === "unexpected_retest_protocol_approval_status" && prefixed.status === 500);
check("the dynamic suffix is not echoed back", !prefixed.message.includes("CONFLICT"));

const dup = mapRpcError({ message: "duplicate key value violates unique constraint \"interventions_one_live_per_protocol\"", code: "23505" });
check("a unique violation maps to already_live", dup.error === "already_live" && dup.status === 409);
check("the constraint name is not echoed back", !dup.message.includes("interventions_one_live_per_protocol"));

let logged: { code: string | null; message: string | null } | null = null;
const secret = 'relation "internal_table_xyz" does not exist';
const unknown = mapRpcError({ message: secret, code: "42P01" }, (d) => { logged = d; });
check("an unknown error is a 500", unknown.status === 500 && unknown.error === "internal_error");
check("an unknown error never echoes the database message", !unknown.message.includes("internal_table_xyz"));
check("an unknown error is handed to the logger with its real text",
  (logged as { message: string | null } | null)?.message === secret);

check("a message with surrounding whitespace still matches",
  mapRpcError({ message: "  abandonment_is_immutable \n" }).error === "abandonment_is_immutable");
check("a null message does not throw", mapRpcError({ message: null, code: null }).status === 500);

/* ═══════════ 3. retest eligibility presentation ═══════════ */
console.log("\n[3] describeRetestEligibility");
const elapsed = describeRetestEligibility("WINDOW_ELAPSED", "2026-10-01T00:00:00Z");
const early = describeRetestEligibility("AUTHORIZED_DEVIATION", "2026-10-01T00:00:00Z");
check("an elapsed window is eligible", elapsed.eligible && elapsed.tone === "ready");
check("an authorized deviation is eligible", early.eligible);
check("a deviation never looks identical to an elapsed window",
  early.tone !== elapsed.tone && early.label !== elapsed.label);
const open = describeRetestEligibility("OBSERVATION_WINDOW_OPEN", "2026-10-03T00:00:00Z");
check("an open window is not eligible", !open.eligible);
check("an open window shows its closing date", open.label === "Observing — closes Oct 3, 2026", open.label);
check("an unknown future reason never defaults to eligible",
  !describeRetestEligibility("SOMETHING_A_LATER_MIGRATION_ADDS", null).eligible);

/* ═══════════ 4. create_retest_protocol outcomes ═══════════ */
console.log("\n[4] mapCreateRetestOutcome");
const created = mapCreateRetestOutcome("CREATED");
const replay = mapCreateRetestOutcome("RETEST_ALREADY_EXISTS");
check("CREATED succeeds", created.ok && !created.replayed);
check("a double click is an idempotent success, not an error", replay.ok && replay.replayed);
const tooSoon = mapCreateRetestOutcome("OBSERVATION_WINDOW_OPEN");
check("an open window is a 409", !tooSoon.ok && tooSoon.failure.status === 409);
check("an unrecognised outcome fails closed", !mapCreateRetestOutcome("NEW_OUTCOME").ok);

/* ═══════════ 5. founder decision and kill switch ═══════════ */
console.log("\n[5] Founder decision and kill switch");
const allow = new Set(["founder@zypact.example"]);
check("an allowlisted email is a founder",
  evaluateFounderAccess("founder@zypact.example", allow) === "founder");
check("the comparison is case- and whitespace-insensitive",
  evaluateFounderAccess("  Founder@Zypact.Example ", allow) === "founder");
check("any other email is not a founder",
  evaluateFounderAccess("someone@elsewhere.example", allow) === "not_founder");
check("a missing email is not a founder", evaluateFounderAccess(null, allow) === "not_founder");
check("an empty allowlist is a configuration error, not a refusal",
  evaluateFounderAccess("founder@zypact.example", new Set()) === "allowlist_missing");

check("the kill switch is off when unset", !interventionAdminEnabled({}));
check("the kill switch is off for anything but exactly \"true\"",
  !interventionAdminEnabled({ INTERVENTION_ADMIN_ENABLED: "1" }) &&
  !interventionAdminEnabled({ INTERVENTION_ADMIN_ENABLED: "TRUE" }) &&
  !interventionAdminEnabled({ INTERVENTION_ADMIN_ENABLED: "yes" }));
check("the kill switch is on for exactly \"true\"",
  interventionAdminEnabled({ INTERVENTION_ADMIN_ENABLED: "true" }));

console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
if (failed > 0) process.exit(1);
