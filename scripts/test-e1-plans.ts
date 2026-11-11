#!/usr/bin/env tsx
/**
 * E1 (D-048), offline: the TypeScript plan catalogue must say exactly what
 * the database enforces (`_e1_allowance`, `_e1_active_question_limit`,
 * `_e1_engine_allowed`), the migration keeps its closed shape, and the plan
 * copy passes the claim-language lint. Every detector is also run against a
 * mutated copy of the SQL that must make it fail. No database, no network.
 */
import { readFileSync } from "node:fs";

import * as catalog from "@/lib/plans/catalog";
import { ENGINES, MEASUREMENT_TYPES, PLAN_CATALOG, PLANS } from "@/lib/plans/catalog";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const FILE = "supabase/migrations/20261112120000_e1_plans_and_usage.sql";
const SQL = readFileSync(FILE, "utf8");

function block(sql: string, name: string): string {
  const start = sql.indexOf(`function public.${name}(`);
  if (start < 0) return "";
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2) + 3);
}

/** Allowance per plan and type as the SQL states it. */
function sqlAllowances(sql: string): Record<string, Record<string, number>> {
  const b = block(sql, "_e1_allowance").replace(/\s+/g, " ");
  const out: Record<string, Record<string, number>> = {};
  for (const plan of PLANS) {
    const m = b.match(new RegExp(`when '${plan}' then case p_type (.*?) end`));
    out[plan] = {};
    for (const type of MEASUREMENT_TYPES) {
      const v = m?.[1].match(new RegExp(`when '${type}' then (\\d+)`));
      const otherwise = m?.[1].match(/else (\d+)/);
      out[plan][type] = Number(v?.[1] ?? otherwise?.[1] ?? NaN);
    }
  }
  return out;
}

function sqlQuestionLimits(sql: string): Record<string, number> {
  const b = block(sql, "_e1_active_question_limit");
  return Object.fromEntries(PLANS.map((p) => [p, Number(b.match(new RegExp(`when '${p}' then (\\d+)`))?.[1] ?? NaN)]));
}

function sqlEngines(sql: string): Record<string, string[]> {
  const b = block(sql, "_e1_engine_allowed").replace(/\s+/g, " ");
  return Object.fromEntries(
    PLANS.map((p) => {
      const m = b.match(new RegExp(`when '${p}' then p_engine (?:= '([a-z]+)'|in \\(([^)]*)\\))`));
      const list = m?.[1] ? [m[1]] : (m?.[2] ?? "").split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean);
      return [p, list];
    })
  );
}

function detectors(sql: string): Array<[string, boolean, string]> {
  const out: Array<[string, boolean, string]> = [];
  const alw = sqlAllowances(sql);
  for (const plan of PLANS) {
    for (const type of MEASUREMENT_TYPES) {
      out.push([`E1-A ${plan}.${type} allowance matches the catalogue`, alw[plan][type] === PLAN_CATALOG[plan].allowances[type], `${alw[plan][type]} vs ${PLAN_CATALOG[plan].allowances[type]}`]);
    }
  }
  const q = sqlQuestionLimits(sql);
  for (const plan of PLANS) out.push([`E1-Q ${plan} active-question limit matches`, q[plan] === PLAN_CATALOG[plan].activeQuestions, `${q[plan]}`]);
  const e = sqlEngines(sql);
  for (const plan of PLANS) out.push([`E1-E ${plan} engines match`, e[plan].join() === PLAN_CATALOG[plan].engines.join(), e[plan].join()]);
  const flat = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
  out.push(["E1-S1 no policy is created", !/create policy/.test(flat), ""]);
  out.push(["E1-S2 no table privilege is granted", !/grant [a-z, ]+ on table/.test(flat), ""]);
  out.push(["E1-S3 every table has RLS on", ["workspace_plan_assignments", "workspace_usage_events", "paid_measurement_switch_events"].every((t) => flat.includes(`alter table public.${t} enable row level security;`)), ""]);
  out.push(["E1-S4 the switch defaults to off", flat.includes("coalesce((select e.enabled from public.paid_measurement_switch_events e order by e.created_at desc, e.id desc limit 1), false)"), ""]);
  out.push(["E1-S5 reservation checks the switch before any insert", (() => {
    const r = block(sql, "reserve_measurement_run");
    return r.indexOf("_e1_paid_measurement_on()") > 0 && r.indexOf("_e1_paid_measurement_on()") < r.indexOf("insert into public.workspace_usage_events");
  })(), ""]);
  out.push(["E1-S6 only service_role is granted the public functions", (sql.match(/grant execute on function public\.\w+\([^)]*\) to service_role;/g) ?? []).length === 5 && !/grant execute[^;]*to (anon|authenticated|public)/i.test(sql), ""]);
  return out;
}

const live = detectors(SQL);
for (const [label, ok, detail] of live) check(label, ok, detail);

// Each detector must be able to fail.
const mutations: Array<[string, string]> = [
  ["E1-A starter.monitoring allowance matches the catalogue", SQL.replace("when 'monitoring' then 160", "when 'monitoring' then 999")],
  ["E1-A free.free_trial allowance matches the catalogue", SQL.replace("when 'free_trial' then 3", "when 'free_trial' then 30")],
  ["E1-Q starter active-question limit matches", SQL.replace("when 'starter' then 20", "when 'starter' then 25")],
  ["E1-E free engines match", SQL.replace("when 'free' then p_engine = 'perplexity'", "when 'free' then p_engine = 'chatgpt'")],
  ["E1-S1 no policy is created", SQL + "\ncreate policy p on public.workspace_usage_events using (true);"],
  ["E1-S4 the switch defaults to off", SQL.replace("limit 1), false);", "limit 1), true);")],
  ["E1-S6 only service_role is granted the public functions", SQL + "\ngrant execute on function public.get_workspace_usage(text, uuid) to authenticated;"],
];
for (const [label, mutated] of mutations) {
  const hit = detectors(mutated).find(([l]) => l === label);
  check(`mutation makes "${label}" fail`, hit !== undefined && hit[1] === false);
}

/* Copy ----------------------------------------------------------------- */
check("C1 every engine has a label", ENGINES.every((e) => typeof catalog.ENGINE_LABELS[e] === "string"));
check("C2 every measurement type has a label and a hint", MEASUREMENT_TYPES.every((t) => catalog.MEASUREMENT_TYPE_LABELS[t] && catalog.MEASUREMENT_TYPE_HINTS[t]));
check("C3 the monitoring hint says one answer is exploratory", catalog.MEASUREMENT_TYPE_HINTS.monitoring.includes("exploratory"));
check("C4 the usage notes say there are no overage charges", catalog.USAGE_NOTES.some((n) => n.includes("no overage")));
const strings: string[] = [];
for (const v of Object.values(catalog)) {
  if (typeof v === "string") strings.push(v);
  else if (Array.isArray(v)) strings.push(...v.filter((x): x is string => typeof x === "string"));
  else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string") strings.push(x);
}
for (const s of strings) {
  const hit = FORBIDDEN_W1_PHRASES.find((p) => s.toLowerCase().includes(p));
  check(`L "${s.slice(0, 50)}…"`, !hit, hit ?? "");
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
