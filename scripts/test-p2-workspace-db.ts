#!/usr/bin/env tsx
/**
 * P2 behaviour on a real PostgreSQL (20261111120000_p2_workspace_drafts_actions.sql, D-047).
 *
 * Runs against a DISPOSABLE Supabase Postgres container that already has
 * every repository migration applied — scripts/run-p2-workspace-db-local.sh
 * creates one, runs this file and removes it. Talks to it only through
 * `docker exec psql`; customer functions are called as service_role, the
 * only role granted them.
 *
 * Opt-in: without ZYPACT_P2_DB_CONTAINER it prints SKIP and exits 2 (a SKIP
 * is never a pass). No network: the diagnostic it stores comes from the W1
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
const tenant = (name: string, domain: string) => makeTenant(psql, name, domain);

function addDraft(t: Tenant, text: string, category = "discovery", rule: string | null = null): string[] {
  return row(psql(`select status, draft_id from public.add_question_draft(${who(t)}, ${lit(text)}, ${lit(category)}, ${lit(rule)});`));
}

function reviseDraft(t: Tenant, id: string, expected: number, text: string, category: string, status: string): string[] {
  return row(
    psql(`select status, version from public.revise_question_draft(${who(t)}, ${lit(id)}::uuid, ${expected}, ${lit(text)}, ${lit(category)}, ${lit(status)});`)
  );
}

function drafts(t: Tenant): Array<Record<string, unknown>> {
  const out = JSON.parse(psql(`select public.list_question_drafts(${who(t)});`)) as { status: string; drafts: Array<Record<string, unknown>> };
  return out.drafts ?? [];
}

function actions(t: Tenant): Array<Record<string, unknown>> {
  const out = JSON.parse(psql(`select public.list_workspace_actions(${who(t)});`)) as { status: string; actions: Array<Record<string, unknown>> };
  return out.actions ?? [];
}

async function main(): Promise<void> {
  console.log("test-p2-workspace-db");
  const a = tenant("Acme Analytics", "acme-analytics.example");
  const b = tenant("Other Co", "other-co.example");
  const nobody: Tenant = { accountId: a.accountId, token: randomBytes(32).toString("hex") };

  /* D: drafts ------------------------------------------------------- */
  const [s1, d1] = addDraft(a, "What is the best analytics tool for small retailers?");
  check("D1 a customer-written draft is ADDED", s1 === "ADDED" && /^[0-9a-f-]{36}$/.test(d1));
  check("D2 the same live text again is DUPLICATE and names the draft", addDraft(a, "What is the best analytics tool for small retailers?").join("|") === `DUPLICATE|${d1}`);
  const [s3, d3] = addDraft(a, "Acme Analytics vs Contoso for retail reporting", "comparison", "p2.suggest.vs_competitor.v1");
  check("D3 a suggested draft is ADDED", s3 === "ADDED");
  let list = drafts(a);
  const suggested = list.find((d) => d.id === d3);
  check("D4 a suggested draft records origin and rule", suggested?.origin === "suggested" && suggested?.suggestion_rule === "p2.suggest.vs_competitor.v1");
  check("D5 the customer draft is customer_written with no rule", list.find((d) => d.id === d1)?.origin === "customer_written" && list.find((d) => d.id === d1)?.suggestion_rule === null);
  check("D6 too-short text is refused by the function", fails(`select * from public.add_question_draft(${who(a)}, 'short', 'discovery', null);`)?.includes("p2_invalid_draft_args") === true);
  check("D7 an unknown category is refused by the table", fails(`select * from public.add_question_draft(${who(a)}, 'A long enough question here', 'pricing', null);`) !== null);
  check("D8 a malformed suggestion rule is refused", fails(`select * from public.add_question_draft(${who(a)}, 'A long enough question here', 'discovery', 'llm.made.this.up');`) !== null);
  check("D9 a padded text is refused (no silent trim)", fails(`select * from public.add_question_draft(${who(a)}, ' A long enough question here ', 'discovery', null);`) !== null);

  check("D10 a stale version is VERSION_CONFLICT", reviseDraft(a, d3, 7, "Anything at all goes here", "comparison", "draft").join("|") === "VERSION_CONFLICT|1");
  check("D11 saving with no change is UNCHANGED", reviseDraft(a, d3, 1, "Acme Analytics vs Contoso for retail reporting", "comparison", "draft").join("|") === "UNCHANGED|1");
  check("D12 editing suggested wording saves version 2", reviseDraft(a, d3, 1, "Acme Analytics or Contoso for retail dashboards?", "comparison", "draft").join("|") === "SAVED|2");
  list = drafts(a);
  check("D13 edited suggestion is suggestion_edited and keeps its rule", list.find((d) => d.id === d3)?.origin === "suggestion_edited" && list.find((d) => d.id === d3)?.suggestion_rule === "p2.suggest.vs_competitor.v1");
  check("D14 a category-only change keeps the origin", reviseDraft(a, d3, 2, "Acme Analytics or Contoso for retail dashboards?", "evaluation", "draft")[0] === "SAVED" && drafts(a).find((d) => d.id === d3)?.origin === "suggestion_edited");
  check("D15 renaming onto another live draft's text is DUPLICATE", reviseDraft(a, d3, 3, "What is the best analytics tool for small retailers?", "evaluation", "draft").join("|") === "DUPLICATE|3");
  check("D16 archiving saves a version", reviseDraft(a, d1, 1, "What is the best analytics tool for small retailers?", "discovery", "archived").join("|") === "SAVED|2");
  check("D17 archived text can be added again as a new draft", addDraft(a, "What is the best analytics tool for small retailers?")[0] === "ADDED");
  check("D18 restoring the archived twin is DUPLICATE", reviseDraft(a, d1, 2, "What is the best analytics tool for small retailers?", "discovery", "draft").join("|") === "DUPLICATE|2");
  const versions = psql(`select count(*) from public.workspace_question_draft_versions where draft_id = ${lit(d1)}::uuid;`, "supabase_admin");
  check("D19 every version is kept", versions === "2");

  /* L: draft cap ---------------------------------------------------- */
  const live = drafts(a).filter((d) => d.status === "draft").length;
  for (let i = live; i < 50; i += 1) addDraft(a, `Filler question number ${i} for the cap test`);
  check("L1 the 51st live draft is LIMIT_REACHED", addDraft(a, "One question too many for the cap")[0] === "LIMIT_REACHED");
  check("L2 restoring an archived draft over the cap is LIMIT_REACHED", (() => {
    const [, id] = addDraft(b, "Placeholder so tenant B exists in drafts");
    void id;
    // d1 is archived in A; give it unique text so only the cap applies.
    return reviseDraft(a, d1, 2, "A different restored question text", "discovery", "draft")[0] === "LIMIT_REACHED";
  })());

  /* I: isolation and sessions ---------------------------------------- */
  check("I1 another workspace cannot revise this draft (NOT_FOUND)", reviseDraft(b, d3, 3, "Hijacked question text here", "discovery", "archived")[0] === "NOT_FOUND");
  check("I2 another workspace lists only its own drafts", drafts(b).length === 1 && drafts(b)[0].text === "Placeholder so tenant B exists in drafts");
  check("I3 an unknown token is NOT_SIGNED_IN", addDraft(nobody, "Should never be stored anywhere")[0] === "NOT_SIGNED_IN");
  check("I4 list with an unknown token is NOT_SIGNED_IN", psql(`select public.list_question_drafts(${who(nobody)}) ->> 'status';`) === "NOT_SIGNED_IN");
  psql(`select public.revoke_account_session(${lit(b.token)}, 'sign_out');`);
  check("I5 a revoked session is NOT_SIGNED_IN", addDraft(b, "After sign out this must fail")[0] === "NOT_SIGNED_IN");

  /* A: actions ------------------------------------------------------ */
  const net = fixtureNet(acmeSite());
  const result = await runSiteDiagnostic("https://acme-analytics.example/", {
    transport: net.transport,
    dnsLookup: net.dnsLookup,
    now: net.clock.now,
    sleep: net.clock.sleep,
  } as Parameters<typeof runSiteDiagnostic>[1]);
  if (!result.ok) throw new Error("fixture diagnostic failed");
  const rows = toQ2p2Rows(result.report);
  const recorded = row(
    psql(
      `select status, run_id from public.record_site_diagnostic(${who(a)}, ${lit(JSON.stringify(rows.run))}::jsonb, ${lit(JSON.stringify(rows.pages))}::jsonb, ${lit(JSON.stringify(rows.findings))}::jsonb);`
    )
  );
  check("A0 the fixture diagnostic is recorded through P1", recorded[0] === "RECORDED");
  const runId = recorded[1];
  const finding = result.report.findings.find((f) => f.state === "issue" && f.pageIndex !== null) ?? result.report.findings.find((f) => f.pageIndex !== null);
  if (!finding) throw new Error("fixture has no page finding");
  const pageUrl = result.report.pages.find((p) => p.pageIndex === finding.pageIndex)?.url ?? null;

  const create = (t: Tenant, run: string | null, checkId: string | null, url: string | null, note: string | null, title = "Check the finding") =>
    row(
      psql(
        `select status, action_id from public.create_workspace_action(${who(t)}, ${run ? `${lit(run)}::uuid` : "null"}, ${lit(checkId)}, ${lit(url)}, ${lit(note)}, ${lit(title)}, 'The diagnostic found this.', null, 'Ask the web team to look.', 'Dana');`
      )
    );

  const [c1, a1] = create(a, runId, finding.checkId, pageUrl, null);
  check("A1 an action on a stored finding is CREATED", c1 === "CREATED");
  check("A2 the same finding again is ALREADY_TRACKED", create(a, runId, finding.checkId, pageUrl, null).join("|") === `ALREADY_TRACKED|${a1}`);
  check("A3 a check that is not in the run is EVIDENCE_NOT_FOUND", create(a, runId, "page.not_a_check", pageUrl, null)[0] === "EVIDENCE_NOT_FOUND");
  check("A4 a run of another workspace is EVIDENCE_NOT_FOUND", (() => {
    const c = tenant("Third Co", "third-co.example");
    return create(c, runId, finding.checkId, pageUrl, null)[0] === "EVIDENCE_NOT_FOUND";
  })());
  check("A5 a customer-note action is CREATED", create(a, null, null, null, "Sales heard this on three calls.")[0] === "CREATED");
  check("A6 both evidence kinds at once is refused", fails(`select * from public.create_workspace_action(${who(a)}, ${lit(runId)}::uuid, ${lit(finding.checkId)}, ${lit(pageUrl)}, 'note', 'Title here', 'Obs', null, 'Next', null);`) !== null);
  check("A7 no evidence at all is refused", fails(`select * from public.create_workspace_action(${who(a)}, null, null, null, null, 'Title here', 'Obs', null, 'Next', null);`) !== null);

  let acts = actions(a);
  const first = acts.find((x) => x.id === a1) as Record<string, unknown> & { evidence: Record<string, unknown> };
  check("A8 the list carries the finding's stored evidence", first?.evidence?.kind === "site_diagnostic_finding" && first.evidence.check_id === finding.checkId && first.evidence.page_url === pageUrl && first.evidence.run_id === runId);
  const revise = (version: number, status: string, owner: string | null = "Dana") =>
    row(
      psql(
        `select status, version from public.revise_workspace_action(${who(a)}, ${lit(a1)}::uuid, ${version}, 'Check the finding', 'The diagnostic found this.', null, 'Ask the web team to look.', ${lit(owner)}, ${lit(status)}, null);`
      )
    );
  check("A9 a stale action version is VERSION_CONFLICT", revise(5, "done").join("|") === "VERSION_CONFLICT|1");
  check("A10 no change is UNCHANGED", revise(1, "open").join("|") === "UNCHANGED|1");
  check("A11 closing saves version 2", revise(1, "done").join("|") === "SAVED|2");
  check("A12 a closed finding can be tracked again", create(a, runId, finding.checkId, pageUrl, null)[0] === "CREATED");
  acts = actions(a);
  check("A13 the list shows the latest version", acts.find((x) => x.id === a1)?.status === "done" && acts.find((x) => x.id === a1)?.version === 2);
  check("A14 another workspace cannot revise the action", (() => {
    const c = tenant("Fourth Co", "fourth-co.example");
    return row(psql(`select status from public.revise_workspace_action(${who(c)}, ${lit(a1)}::uuid, 2, 'x x x', 'o', null, 'n', null, 'open', null);`))[0] === "NOT_FOUND";
  })());
  check("A15 a direct insert pointing at another workspace's finding is refused", (() => {
    const c = psql(`select id from public.workspaces where id <> (select workspace_id from public.site_diagnostic_findings where run_id = ${lit(runId)}::uuid limit 1) order by created_at desc limit 1;`, "supabase_admin");
    const f = psql(`select id from public.site_diagnostic_findings where run_id = ${lit(runId)}::uuid limit 1;`, "supabase_admin");
    return fails(`insert into public.workspace_actions (workspace_id, evidence_kind, evidence_finding_id) values (${lit(c)}::uuid, 'site_diagnostic_finding', ${lit(f)}::uuid);`, "supabase_admin")?.includes("p2_evidence_not_in_workspace") === true;
  })());

  /* P: append-only and privileges ----------------------------------- */
  for (const table of ["workspace_question_drafts", "workspace_question_draft_versions", "workspace_actions", "workspace_action_versions"]) {
    check(`P1 ${table}: UPDATE is refused even for the owner`, fails(`update public.${table} set created_at = created_at;`, "supabase_admin")?.includes("p2_append_only") === true);
    check(`P2 ${table}: DELETE is refused even for the owner`, fails(`delete from public.${table};`, "supabase_admin")?.includes("p2_append_only") === true);
    check(`P3 ${table}: TRUNCATE is refused even for the owner`, fails(`truncate public.${table} cascade;`, "supabase_admin")?.includes("p2_append_only") === true);
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      check(`P4 ${table}: ${role} cannot read the table`, fails(`select 1 from public.${table} limit 1;`, role) !== null);
    }
  }
  for (const role of ["anon", "authenticated"] as const) {
    check(`P5 ${role} cannot call add_question_draft`, fails(`select * from public.add_question_draft(${who(a)}, 'A long enough question here', 'discovery', null);`, role)?.includes("permission denied") === true);
    check(`P6 ${role} cannot call list_workspace_actions`, fails(`select public.list_workspace_actions(${who(a)});`, role)?.includes("permission denied") === true);
  }
  check("P7 service_role cannot call a _p2_ helper", fails(`select public._p2_text_ok('abc', 1, 5);`)?.includes("permission denied") === true);

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
