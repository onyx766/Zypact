#!/usr/bin/env tsx
/**
 * E1 behaviour on a real PostgreSQL (20261112120000_e1_plans_and_usage.sql, D-048):
 * plan assignment, the paid-measurement switch, reservation before any
 * attempt, settlement, allowances, the failure budget, billing periods,
 * isolation, append-only and privileges.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network.
 */
import { randomUUID } from "node:crypto";

import { db, lit, makeChecker, makeTenant, requireContainer, row, who } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const RULE = `'e1.test', '1'`;

function workspaceOf(accountId: string): string {
  return psql(`select workspace_id from public.workspace_members where account_id = ${lit(accountId)}::uuid;`, "supabase_admin");
}

const reserve = (ws: string, type: string, engine: string, key: string) =>
  row(psql(`select status, reservation_id, allowance, used from public.reserve_measurement_run(${lit(ws)}::uuid, ${lit(type)}, ${lit(engine)}, ${lit(key)}, ${RULE});`));
const settle = (res: string, outcome: string, reason: string | null = null) =>
  psql(`select status from public.settle_measurement_run(${lit(res)}::uuid, ${lit(outcome)}, null, ${lit(reason)}, ${RULE});`);
const toggle = (on: boolean) => psql(`select status, enabled from public.set_paid_measurement_switch(${on}, ${lit(FOUNDER)}::uuid, 'test');`);
const assign = (ws: string, plan: string, key: string, anchor = "now()", source = "founder", actor = `'founder', ${lit(FOUNDER)}::uuid, null, null`) =>
  row(psql(`select status, assignment_id from public.assign_workspace_plan(${lit(ws)}::uuid, ${lit(plan)}, ${lit(source)}, ${anchor}, ${lit(key)}, ${actor}, null, null);`));

async function main(): Promise<void> {
  console.log("test-e1-plans-db");
  const ta = makeTenant(psql, "Acme", "acme-analytics.example");
  const tb = makeTenant(psql, "Other", "other-co.example");
  const a = workspaceOf(ta.accountId);
  const b = workspaceOf(tb.accountId);

  /* T: periods ------------------------------------------------------ */
  const ps = (anchor: string, at: string) => psql(`select to_char(public._e1_period_start(${lit(anchor)}::timestamptz, ${lit(at)}::timestamptz) at time zone 'UTC', 'YYYY-MM-DD HH24:MI');`, "supabase_admin");
  check("T1 inside the first month the period starts at the anchor", ps("2026-01-15 10:00+00", "2026-02-10 00:00+00") === "2026-01-15 10:00");
  check("T2 after a month the period moves by whole months", ps("2026-01-15 10:00+00", "2026-03-20 00:00+00") === "2026-03-15 10:00");
  check("T3 a month-end anchor never starts after the instant", ps("2026-01-31 00:00+00", "2026-02-28 12:00+00") === "2026-02-28 00:00");
  check("T5 a month-end anchor's periods follow month arithmetic (31 Jan + 2 months is 31 Mar)", ps("2026-01-31 00:00+00", "2026-03-30 00:00+00") === "2026-02-28 00:00" && ps("2026-01-31 00:00+00", "2026-03-31 00:00+00") === "2026-03-31 00:00");
  check("T6 exactly at a period boundary is the new period", ps("2026-01-15 10:00+00", "2026-02-15 10:00+00") === "2026-02-15 10:00");
  check("T4 before the anchor is the anchor", ps("2026-05-01 00:00+00", "2026-04-01 00:00+00") === "2026-05-01 00:00");

  /* S: the switch --------------------------------------------------- */
  check("S1 with no switch record, nothing can be reserved", reserve(a, "free_trial", "perplexity", "k-off")[0] === "PAID_MEASUREMENT_OFF");
  check("S2 the refused reservation wrote nothing", psql(`select count(*) from public.workspace_usage_events where workspace_id = ${lit(a)}::uuid;`, "supabase_admin") === "0");
  check("S3 the founder turns paid measurement on", toggle(true) === "RECORDED|t");

  /* F: Free plan ---------------------------------------------------- */
  const usage = JSON.parse(psql(`select public.get_workspace_usage(${who(ta)});`)) as { plan: string; source: string; active_question_limit: number; engines: string[]; types: Array<{ type: string; allowance: number; lifetime: boolean }> };
  check("F1 no assignment means Free by default", usage.plan === "free" && usage.source === "default");
  check("F2 Free: 1 active question and Perplexity only", usage.active_question_limit === 1 && usage.engines.join() === "perplexity");
  check("F3 Free: 3 lifetime runs, nothing else", usage.types.find((t) => t.type === "free_trial")?.allowance === 3 && usage.types.find((t) => t.type === "free_trial")?.lifetime === true && usage.types.filter((t) => t.type !== "free_trial").every((t) => t.allowance === 0));
  check("F4 Free cannot use ChatGPT", reserve(a, "free_trial", "chatgpt", "k-gpt")[0] === "ENGINE_NOT_IN_PLAN");
  check("F5 Free has no monitoring", reserve(a, "monitoring", "perplexity", "k-mon")[0] === "NOT_IN_PLAN");
  const r1 = reserve(a, "free_trial", "perplexity", "k1");
  check("F6 the first run is RESERVED (1 of 3)", r1[0] === "RESERVED" && r1[2] === "3" && r1[3] === "1");
  check("F7 the same key replays the same reservation", reserve(a, "free_trial", "perplexity", "k1").slice(0, 2).join() === `ALREADY_RESERVED,${r1[1]}`);
  check("F8 the same key for another type is IDEMPOTENCY_KEY_CONFLICT", reserve(a, "monitoring", "perplexity", "k1")[0] === "IDEMPOTENCY_KEY_CONFLICT");
  const r2 = reserve(a, "free_trial", "perplexity", "k2");
  const r3 = reserve(a, "free_trial", "perplexity", "k3");
  check("F9 runs two and three are reserved", r2[0] === "RESERVED" && r3[0] === "RESERVED");
  check("F10 a fourth is ALLOWANCE_EXHAUSTED while three are held", reserve(a, "free_trial", "perplexity", "k4")[0] === "ALLOWANCE_EXHAUSTED");
  check("F11 a release needs a reason", fails(`select * from public.settle_measurement_run(${lit(r3[1])}::uuid, 'released', null, null, ${RULE});`) !== null);
  check("F12 a failed run is released", settle(r3[1], "released", "provider_timeout") === "SETTLED");
  check("F13 the released run frees its place", reserve(a, "free_trial", "perplexity", "k5")[0] === "RESERVED");
  check("F14 a successful run is consumed", settle(r1[1], "consumed") === "SETTLED");
  check("F15 the same settlement again is ALREADY_SETTLED", settle(r1[1], "consumed") === "ALREADY_SETTLED");
  check("F16 a different settlement is SETTLEMENT_CONFLICT", settle(r1[1], "released", "late_failure") === "SETTLEMENT_CONFLICT");
  check("F17 an unknown reservation is NOT_FOUND", settle(randomUUID(), "consumed") === "NOT_FOUND");
  const after = JSON.parse(psql(`select public.get_workspace_usage(${who(ta)});`)) as { types: Array<{ type: string; consumed: number; held: number; released: number }> };
  const ft = after.types.find((t) => t.type === "free_trial");
  check("F18 usage shows consumed, held and released separately", ft?.consumed === 1 && ft?.held === 2 && ft?.released === 1, JSON.stringify(ft));

  /* B: failure budget ----------------------------------------------- */
  {
    const t = makeTenant(psql, "Flaky", "flaky.example");
    const w = workspaceOf(t.accountId);
    for (let i = 0; i < 3; i += 1) settle(reserve(w, "free_trial", "perplexity", `f${i}`)[1], "released", "provider_error");
    check("B1 after as many releases as the allowance, reservation stops", reserve(w, "free_trial", "perplexity", "f3")[0] === "FAILURE_BUDGET_EXHAUSTED");
  }

  /* P: plans -------------------------------------------------------- */
  check("P1 the founder assigns Starter", assign(b, "starter", "plan-b-1", "'2026-09-01 00:00+00'::timestamptz")[0] === "ASSIGNED");
  check("P2 the same key and body is ALREADY_ASSIGNED", assign(b, "starter", "plan-b-1", "'2026-09-01 00:00+00'::timestamptz")[0] === "ALREADY_ASSIGNED");
  check("P3 the same key with another body is IDEMPOTENCY_KEY_CONFLICT", assign(b, "free", "plan-b-1")[0] === "IDEMPOTENCY_KEY_CONFLICT");
  check("P4 source founder needs a founder actor", fails(`select * from public.assign_workspace_plan(${lit(b)}::uuid, 'starter', 'founder', now(), 'plan-x', 'system', null, 'e1.test', '1', null, null);`) !== null);
  check("P5 Stripe references only with source stripe", fails(`select * from public.assign_workspace_plan(${lit(b)}::uuid, 'starter', 'founder', now(), 'plan-y', 'founder', ${lit(FOUNDER)}::uuid, null, null, 'cus_ABCDEF123', null);`) !== null);
  check("P6 a Stripe assignment is a system actor", assign(b, "starter", "plan-b-stripe", "'2026-09-01 00:00+00'::timestamptz", "stripe", `'system', null, 'e1.stripe_webhook', '1'`)[0] === "ASSIGNED");
  check("P7 an unknown workspace is refused", fails(`select * from public.assign_workspace_plan(gen_random_uuid(), 'starter', 'founder', now(), 'plan-z', 'founder', ${lit(FOUNDER)}::uuid, null, null, null, null);`) !== null);

  const ub = JSON.parse(psql(`select public.get_workspace_usage(${who(tb)});`)) as { plan: string; period_start: string; active_question_limit: number; engines: string[]; types: Array<{ type: string; allowance: number }> };
  check("P8 Starter: 20 questions, both engines", ub.plan === "starter" && ub.active_question_limit === 20 && ub.engines.join() === "perplexity,chatgpt");
  check("P9 Starter: 160 monitoring, 50 deep baseline, 30 retest, no free trial", ["monitoring:160", "deep_baseline:50", "retest:30", "free_trial:0"].every((x) => ub.types.some((t) => `${t.type}:${t.allowance}` === x)));
  check("P10 the period started in the second month of the anchor", new Date(ub.period_start).getTime() > Date.now() - 31 * 86400000 && new Date(ub.period_start).getTime() <= Date.now());
  check("P11 Starter may use ChatGPT for monitoring", reserve(b, "monitoring", "chatgpt", "m-gpt")[0] === "RESERVED");
  check("P12 Starter cannot use the free trial", reserve(b, "free_trial", "perplexity", "m-ft")[0] === "NOT_IN_PLAN");
  psql(`do $$ begin for i in 1..29 loop perform public.reserve_measurement_run(${lit(b)}::uuid, 'retest', 'perplexity', 'rt' || i, ${RULE}); end loop; end $$;`);
  const filled = psql(`select count(*) from public.workspace_usage_events where workspace_id = ${lit(b)}::uuid and measurement_type = 'retest';`, "supabase_admin");
  check("P13 29 retests reserved in one go", filled === "29");
  check("P14 the 30th retest is the last", reserve(b, "retest", "perplexity", "rt30")[0] === "RESERVED" && reserve(b, "retest", "perplexity", "rt31")[0] === "ALLOWANCE_EXHAUSTED");
  check("P15 allowances are per type: deep baselines are untouched", reserve(b, "deep_baseline", "perplexity", "db1")[0] === "RESERVED");
  check("P16 Starter reservations carry the billing period", psql(`select count(*) from public.workspace_usage_events where workspace_id = ${lit(b)}::uuid and period_start is null;`, "supabase_admin") === "0");
  check("P17 workspaces are independent", JSON.parse(psql(`select public.get_workspace_usage(${who(ta)});`)).plan === "free");

  /* O: switch off again --------------------------------------------- */
  check("O1 the founder turns paid measurement off", toggle(false) === "RECORDED|f");
  check("O2 a new reservation is refused", reserve(b, "deep_baseline", "perplexity", "db2")[0] === "PAID_MEASUREMENT_OFF");
  check("O3 an existing reservation still replays", reserve(b, "deep_baseline", "perplexity", "db1")[0] === "ALREADY_RESERVED");
  check("O4 settlement still works while off", settle(reserve(b, "deep_baseline", "perplexity", "db1")[1], "consumed") === "SETTLED");

  /* I: integrity ---------------------------------------------------- */
  check("I1 a settlement without its reservation is refused", fails(`insert into public.workspace_usage_events (reservation_id, workspace_id, plan, measurement_type, engine, event, period_start, rule_id, rule_version) values (gen_random_uuid(), ${lit(a)}::uuid, 'free', 'free_trial', 'perplexity', 'consumed', null, 'x', '1');`, "supabase_admin")?.includes("e1_settlement_without_reservation") === true);
  check("I2 a free-trial row must be lifetime", fails(`insert into public.workspace_usage_events (reservation_id, workspace_id, plan, measurement_type, engine, event, period_start, idempotency_key, rule_id, rule_version) values (gen_random_uuid(), ${lit(a)}::uuid, 'free', 'free_trial', 'perplexity', 'reserved', now(), 'zz', 'x', '1');`, "supabase_admin") !== null);
  for (const table of ["workspace_plan_assignments", "workspace_usage_events", "paid_measurement_switch_events"]) {
    check(`I3 ${table}: UPDATE is refused`, fails(`update public.${table} set created_at = created_at;`, "supabase_admin")?.includes("e1_append_only") === true);
    check(`I4 ${table}: DELETE is refused`, fails(`delete from public.${table};`, "supabase_admin")?.includes("e1_append_only") === true);
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      check(`I5 ${table}: ${role} cannot read it`, fails(`select 1 from public.${table} limit 1;`, role) !== null);
    }
  }
  for (const role of ["anon", "authenticated"] as const) {
    check(`I6 ${role} cannot reserve`, fails(`select * from public.reserve_measurement_run(${lit(a)}::uuid, 'free_trial', 'perplexity', 'x', ${RULE});`, role)?.includes("permission denied") === true);
    check(`I7 ${role} cannot flip the switch`, fails(`select * from public.set_paid_measurement_switch(true, gen_random_uuid(), 'x');`, role)?.includes("permission denied") === true);
    check(`I8 ${role} cannot assign a plan`, fails(`select * from public.assign_workspace_plan(${lit(a)}::uuid, 'starter', 'founder', now(), 'k', 'founder', gen_random_uuid(), null, null, null, null);`, role)?.includes("permission denied") === true);
  }
  check("I9 service_role cannot call an _e1_ helper", fails(`select public._e1_allowance('starter', 'retest');`)?.includes("permission denied") === true);
  check("I10 an unknown session cannot read usage", JSON.parse(psql(`select public.get_workspace_usage(${lit("0".repeat(64))}, ${lit(ta.accountId)}::uuid);`)).status === "NOT_SIGNED_IN");

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
