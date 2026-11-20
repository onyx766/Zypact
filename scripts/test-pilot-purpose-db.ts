#!/usr/bin/env tsx
/**
 * The pilot purpose on a real PostgreSQL (20261109200000_pilot_purpose.sql):
 *
 *   C  the columns: every pilot reads 'customer' by default, with no setter;
 *      only the two values are accepted; who set it and when are both set
 *      or both null;
 *   S  set_pilot_purpose: SET records the value, the setter and the time;
 *      the same value again is UNCHANGED and keeps the first record; an
 *      unknown pilot is PILOT_NOT_FOUND; a closed pilot can still be set;
 *      bad arguments raise 22023;
 *   G  grants: service_role may execute it, anon and authenticated may not,
 *      and service_role still may not write public.pilots directly;
 *   R  the migration re-run on this database is refused by its own guard.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network, no provider.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();
const FOUNDER = randomUUID();
const admin = (sql: string) => psql(sql, "supabase_admin");

function createPilot(domain: string): string {
  const [outcome, pilotId] = row(psql(
    `select outcome, coalesce(pilot_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Purpose Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`
  ));
  if (outcome !== "CREATED") throw new Error(`pilot not created: ${outcome}`);
  return pilotId;
}
const setPurpose = (pilotId: string, purpose: string, role: "service_role" | "anon" | "authenticated" = "service_role") =>
  psql(`select outcome from public.set_pilot_purpose(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(purpose)});`, role);
const state = (pilotId: string) =>
  admin(`select purpose || '|' || coalesce(purpose_set_by::text, '') || '|' || (purpose_set_at is not null)::text from public.pilots where id = ${lit(pilotId)}::uuid;`);

async function main(): Promise<void> {
  console.log("test-pilot-purpose-db");

  /* C ----------------------------------------------------------------- */
  const a = createPilot("purpose-a.example");
  check("C1 a new pilot reads customer, with no setter and no time", state(a) === "customer||false", state(a));
  check("C2 a value other than the two is refused by the CHECK",
    (fails(`update public.pilots set purpose = 'demo' where id = ${lit(a)}::uuid;`, "supabase_admin") ?? "").includes("pilots_purpose_check"));
  check("C3 a setter without a time is refused",
    (fails(`update public.pilots set purpose_set_by = ${lit(FOUNDER)}::uuid where id = ${lit(a)}::uuid;`, "supabase_admin") ?? "").includes("pilots_purpose_set_check"));

  /* S ----------------------------------------------------------------- */
  check("S1 set to internal practice: SET, with the setter and the time", setPurpose(a, "internal_practice") === "SET" &&
    state(a) === `internal_practice|${FOUNDER}|true`, state(a));
  const firstAt = admin(`select purpose_set_at::text from public.pilots where id = ${lit(a)}::uuid;`);
  check("S2 the same value again is UNCHANGED and keeps the first record", setPurpose(a, "internal_practice") === "UNCHANGED" &&
    admin(`select purpose_set_at::text from public.pilots where id = ${lit(a)}::uuid;`) === firstAt);
  check("S3 back to customer: SET", setPurpose(a, "customer") === "SET" && state(a).startsWith("customer|"));
  check("S4 an unknown pilot is PILOT_NOT_FOUND", setPurpose(randomUUID(), "customer") === "PILOT_NOT_FOUND");
  const b = createPilot("purpose-b.example");
  const closed = row(psql(`select outcome from public.close_pilot(${lit(b)}::uuid, ${lit(FOUNDER)}::uuid, 'Practice run finished for the day.');`))[0];
  check("S5 a closed pilot can still be set (no measurement changes)", closed === "CLOSED" && setPurpose(b, "internal_practice") === "SET");
  const bad = fails(`select * from public.set_pilot_purpose(${lit(a)}::uuid, ${lit(FOUNDER)}::uuid, 'demo');`);
  const nullSetter = fails(`select * from public.set_pilot_purpose(${lit(a)}::uuid, null, 'customer');`);
  check("S6 an unknown value or a missing setter raises invalid_set_pilot_purpose_args",
    (bad ?? "").includes("invalid_set_pilot_purpose_args") && (nullSetter ?? "").includes("invalid_set_pilot_purpose_args"));

  /* G ----------------------------------------------------------------- */
  check("G1 anon and authenticated may not execute it",
    (fails(`select * from public.set_pilot_purpose(${lit(a)}::uuid, ${lit(FOUNDER)}::uuid, 'customer');`, "anon") ?? "").includes("permission denied") &&
    (fails(`select * from public.set_pilot_purpose(${lit(a)}::uuid, ${lit(FOUNDER)}::uuid, 'customer');`, "authenticated") ?? "").includes("permission denied"));
  check("G2 PUBLIC holds no EXECUTE; service_role does",
    admin(`select has_function_privilege('public', 'public.set_pilot_purpose(uuid, uuid, text)', 'execute')::text;`) === "false" &&
    admin(`select has_function_privilege('service_role', 'public.set_pilot_purpose(uuid, uuid, text)', 'execute')::text;`) === "true");
  check("G3 service_role still may not write public.pilots directly",
    (fails(`update public.pilots set purpose = 'internal_practice' where id = ${lit(a)}::uuid;`) ?? "").includes("permission denied"));
  check("G4 the function is SECURITY DEFINER with a pinned search_path",
    admin(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where oid = 'public.set_pilot_purpose(uuid, uuid, text)'::regprocedure;`) ===
      "true|search_path=public, pg_temp");

  // Informational, for PILOT_PRODUCTION_PLAN step 5d's after-check (as the plan hashes: carriage returns removed).
  console.log(`  · md5 of set_pilot_purpose after the apply: ${admin(
    "select md5(replace(pg_get_functiondef('public.set_pilot_purpose(uuid, uuid, text)'::regprocedure), chr(13), ''));"
  )}`);

  /* R ----------------------------------------------------------------- */
  const migration = readFileSync("supabase/migrations/20261109200000_pilot_purpose.sql", "utf8");
  const rerun = fails(`begin;\n${migration}\nrollback;`, "supabase_admin");
  check("R1 re-run on this database, the migration's own guard refuses it",
    (rerun ?? "").includes("20261109200000 precondition: a pilot purpose column or set_pilot_purpose already exists"), (rerun ?? "").slice(0, 300));

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
