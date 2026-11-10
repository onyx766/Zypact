#!/usr/bin/env tsx
/**
 * P1 behaviour on a real PostgreSQL (20261110120000_p1_workspace_setup.sql, D-046):
 * the workspace website, customer-run diagnostics, diagnostic rate limits,
 * the versioned Brand Profile and the workspace state.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network: the stored diagnostic comes from the W1
 * fixture site through the real engine.
 */
import { randomBytes } from "node:crypto";

import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import { toQ2p2Rows } from "@/lib/site-diagnostic/persistence-shape";

import { acmeSite, fixtureNet } from "./fixtures/w1/fixture-net";
import { db, lit, makeChecker, makeTenant, requireContainer, row, who, type Tenant } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const setWebsite = (t: Tenant, domain: string, name = "Acme") =>
  psql(`select status from public.set_workspace_website(${who(t)}, ${lit(domain)}, ${lit(name)});`);

function saveProfile(t: Tenant, expected: number, opts: { name?: string; competitors?: string[]; objective?: string | null; run?: string | null } = {}): string[] {
  const comps = `array[${(opts.competitors ?? []).map((c) => lit(c)).join(",")}]::text[]`;
  return row(
    psql(
      `select status, version from public.save_brand_profile(${who(t)}, ${expected}, ${lit(opts.name ?? "Acme Analytics")}, 'Retail analytics', 'Analytics software', 'Retailers', ${comps}, ${lit(opts.objective === undefined ? "compare_competitors" : opts.objective)}, ${opts.run ? `${lit(opts.run)}::uuid` : "null"});`
    )
  );
}

const state = (t: Tenant) => JSON.parse(psql(`select public.get_workspace_state(${who(t)});`)) as Record<string, unknown>;

async function fixtureRows() {
  const net = fixtureNet(acmeSite());
  const result = await runSiteDiagnostic("https://acme-analytics.example/", {
    transport: net.transport,
    dnsLookup: net.dnsLookup,
    now: net.clock.now,
    sleep: net.clock.sleep,
  } as Parameters<typeof runSiteDiagnostic>[1]);
  if (!result.ok) throw new Error("fixture diagnostic failed");
  return toQ2p2Rows(result.report);
}

const record = (t: Tenant, rows: Awaited<ReturnType<typeof fixtureRows>>) =>
  row(
    psql(
      `select status, run_id from public.record_site_diagnostic(${who(t)}, ${lit(JSON.stringify(rows.run))}::jsonb, ${lit(JSON.stringify(rows.pages))}::jsonb, ${lit(JSON.stringify(rows.findings))}::jsonb);`
    )
  );

async function main(): Promise<void> {
  console.log("test-p1-workspace-db");
  const a = makeTenant(psql, "Acme", null);
  const b = makeTenant(psql, "Other", null);
  const nobody: Tenant = { accountId: a.accountId, token: randomBytes(32).toString("hex") };
  const rows = await fixtureRows();

  /* W: website ------------------------------------------------------ */
  check("W1 no website: state has none", state(a).website === null);
  check("W2 no website: profile is NO_WEBSITE", saveProfile(a, 0)[0] === "NO_WEBSITE");
  check("W3 no website: diagnostic is NO_WEBSITE", record(a, rows)[0] === "NO_WEBSITE");
  check("W4 an unnormalised domain is refused", fails(`select * from public.set_workspace_website(${who(a)}, 'HTTPS://Acme.example/', 'Acme');`)?.includes("p1_invalid_website_args") === true);
  check("W5 a blank company name is refused", fails(`select * from public.set_workspace_website(${who(a)}, 'acme-analytics.example', '  ');`) !== null);
  check("W6 the website is SET", setWebsite(a, "acme-analytics.example") === "SET");
  check("W7 the same website again is ALREADY_SET", setWebsite(a, "acme-analytics.example") === "ALREADY_SET");
  check("W8 a different website is DIFFERENT_WEBSITE_SET", setWebsite(a, "elsewhere.example") === "DIFFERENT_WEBSITE_SET");
  check("W9 an unknown session is NOT_SIGNED_IN", setWebsite(nobody, "acme-analytics.example") === "NOT_SIGNED_IN");
  const st = state(a) as { website: { domain: string; verification: string } };
  check("W10 state shows the domain, not verified", st.website.domain === "acme-analytics.example" && st.website.verification === "none");
  check("W11 the website created exactly one project mapping", psql(`select count(*) from public.workspace_projects where rule_id = 'p1.workspace_setup' and workspace_id = (select workspace_id from public.workspace_domains where normalized_domain = 'acme-analytics.example');`, "supabase_admin") === "1");

  /* D: diagnostics -------------------------------------------------- */
  check("D1 another workspace's domain is DOMAIN_MISMATCH", (() => {
    setWebsite(b, "other-co.example", "Other");
    return record(b, rows)[0] === "DOMAIN_MISMATCH";
  })());
  const [rs, runId] = record(a, rows);
  check("D2 the workspace's own diagnostic is RECORDED", rs === "RECORDED");
  const d = JSON.parse(psql(`select public.get_site_diagnostic(${who(a)}, null);`)) as { status: string; run: { id: string }; findings: unknown[]; pages: unknown[] };
  check("D3 the latest diagnostic is readable with its rows", d.status === "OK" && d.run.id === runId && d.findings.length === rows.findings.length && d.pages.length === rows.pages.length);
  const other = JSON.parse(psql(`select public.get_site_diagnostic(${who(b)}, ${lit(runId)}::uuid);`)) as { status: string };
  check("D4 another workspace cannot read the run by id", other.status !== "OK");
  check("D5 an unknown session cannot read it", (JSON.parse(psql(`select public.get_site_diagnostic(${who(nobody)}, null);`)) as { status: string }).status === "NOT_SIGNED_IN");
  check("D6 state carries the run and its counts", (() => {
    const s = state(a) as { latest_run: { id: string; counts: Record<string, number> } };
    const total = Object.values(s.latest_run.counts).reduce((x, y) => x + y, 0);
    return s.latest_run.id === runId && total === rows.findings.length;
  })());

  /* R: rate limit --------------------------------------------------- */
  const key = "a".repeat(64);
  const take = () => psql(`select allowed from public.take_diagnostic_rate_limit('account', ${lit(key)}, 'k1', 3600, 2);`);
  check("R1 the first two units are allowed", take() === "t" && take() === "t");
  check("R2 the third is refused", take() === "f");
  check("R3 another bucket is independent", psql(`select allowed from public.take_diagnostic_rate_limit('domain', ${lit(key)}, 'k1', 3600, 2);`) === "t");
  check("R4 invalid arguments are refused", fails(`select * from public.take_diagnostic_rate_limit('planet', ${lit(key)}, 'k1', 3600, 2);`) !== null);

  /* B: Brand Profile ------------------------------------------------ */
  check("B1 the first profile saves as version 1", saveProfile(a, 0, { run: runId, competitors: ["Contoso", "Fabrikam"] }).join("|") === "SAVED|1");
  check("B2 a stale expected version is VERSION_CONFLICT", saveProfile(a, 0).join("|") === "VERSION_CONFLICT|1");
  check("B3 the next save is version 2", saveProfile(a, 1, { objective: null }).join("|") === "SAVED|2");
  check("B4 state shows the latest version", (() => {
    const p = (state(a) as { profile: { version: number; objective: string | null } }).profile;
    return p.version === 2 && p.objective === null;
  })());
  check("B5 both versions are kept", psql(`select count(*) from public.workspace_brand_profiles where actor_account_id = ${lit(a.accountId)}::uuid;`, "supabase_admin") === "2");
  check("B6 duplicate competitors (any case) are refused", fails(`select * from public.save_brand_profile(${who(a)}, 2, 'Acme', null, null, null, array['Contoso','contoso']::text[], null, null);`) !== null);
  check("B7 more than 10 competitors are refused", fails(`select * from public.save_brand_profile(${who(a)}, 2, 'Acme', null, null, null, array['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10','a11']::text[], null, null);`) !== null);
  check("B8 an unknown objective is refused", fails(`select * from public.save_brand_profile(${who(a)}, 2, 'Acme', null, null, null, '{}'::text[], 'grow_revenue', null);`) !== null);
  check("B9 a run of another workspace is refused", saveProfileFails(b, runId));
  check("B10 an unknown session is NOT_SIGNED_IN", saveProfile(nobody, 2)[0] === "NOT_SIGNED_IN");
  check("B11 profile rows cannot be updated", fails(`update public.workspace_brand_profiles set company_name = 'x';`, "supabase_admin")?.includes("p1_append_only") === true);
  check("B12 profile rows cannot be deleted", fails(`delete from public.workspace_brand_profiles;`, "supabase_admin")?.includes("p1_append_only") === true);

  /* P: privileges --------------------------------------------------- */
  for (const role of ["anon", "authenticated", "service_role"] as const) {
    check(`P1 ${role} cannot read workspace_brand_profiles`, fails(`select 1 from public.workspace_brand_profiles limit 1;`, role) !== null);
  }
  const calls = [
    `select * from public.set_workspace_website(${who(a)}, 'x.example', 'X');`,
    `select * from public.take_diagnostic_rate_limit('account', ${lit(key)}, 'k1', 60, 1);`,
    `select public.get_site_diagnostic(${who(a)}, null);`,
    `select public.get_workspace_state(${who(a)});`,
  ];
  for (const role of ["anon", "authenticated"] as const) {
    for (const sql of calls) check(`P2 ${role} cannot call ${sql.match(/public\.(\w+)/)?.[1]}`, fails(sql, role)?.includes("permission denied") === true);
  }
  check("P3 service_role cannot call a _p1_ helper", fails(`select * from public._p1_site(gen_random_uuid());`)?.includes("permission denied") === true);

  finish();
}

function saveProfileFails(t: Tenant, foreignRun: string): boolean {
  return fails(`select * from public.save_brand_profile(${who(t)}, 0, 'Other', null, null, null, '{}'::text[], null, ${lit(foreignRun)}::uuid);`)?.includes("p1_run_not_in_workspace") === true;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
