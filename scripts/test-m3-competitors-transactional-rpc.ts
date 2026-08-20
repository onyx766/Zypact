#!/usr/bin/env tsx
/**
 * M3 — incident fix (2026-08-20 staging exercise).
 *
 * `replaceCompetitorsForProject`'s two separate Supabase calls (DELETE,
 * then INSERT) were not atomic: the DELETE committed, the INSERT then
 * failed `competitors_canonical_entity_pair_check` (migration 0045)
 * because `canonical_entity_type` was never sent, and a real historical
 * project's six `competitors` rows were left deleted with nothing to
 * replace them.
 *
 * Two independent halves, exactly like scripts/test-m3-competitors-
 * canonical-entity.ts's own pattern:
 *
 *  1. Static assertions over migration 0046's SQL text only — no real
 *     Postgres connection, no staging, no Production. This is the only
 *     way to verify "the DELETE and the INSERT execute inside one
 *     transaction" and "a failed INSERT leaves prior rows intact"
 *     without a live database: both properties follow structurally from
 *     the DELETE and INSERT being two statements inside ONE PL/pgSQL
 *     function body, with no exception handler that could swallow a
 *     constraint violation and let the function return successfully
 *     after only the DELETE ran.
 *
 *  2. Real, runtime unit tests of `buildCompetitorsRpcPayload` — the
 *     exact pure function whose omission of `canonicalEntityType`
 *     caused the incident. No database, no LLM, no staging/Production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCompetitorsRpcPayload } from "@/lib/db/supabase-adapter";
import type { CompetitorInput } from "@/lib/db/types";

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

/* -------------------------------------------------------------------------- */
/*  Part 1 — migration 0046 static schema contract                           */
/* -------------------------------------------------------------------------- */

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function staticSchemaChecks(): void {
  console.log("\n[static — migration 0046 text]");

  const migrationPath = path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "0046_m3_replace_competitors_transactional_rpc.sql"
  );
  const raw = readFileSync(migrationPath, "utf8");
  const codeOnly = stripSqlComments(raw);
  const codeOnlyLower = codeOnly.toLowerCase();

  check(
    "creates exactly one function: replace_competitors_for_project(uuid, jsonb)",
    /create or replace function\s+public\.replace_competitors_for_project\(\s*p_project_id uuid,\s*p_competitors jsonb\s*\)/i.test(
      codeOnly
    )
  );
  check(
    "returns setof public.competitors — a row set, not a status/count",
    /returns setof public\.competitors/i.test(codeOnlyLower)
  );
  check(
    "is SECURITY DEFINER, volatile, with search_path pinned",
    /security definer/i.test(codeOnlyLower) &&
      /volatile/i.test(codeOnlyLower) &&
      /set search_path = public, pg_temp/i.test(codeOnlyLower)
  );

  // ---- Atomicity by construction ------------------------------------
  const bodyMatch = codeOnly.match(/as \$\$([\s\S]*?)\$\$;/);
  const body = bodyMatch ? bodyMatch[1] : "";
  check(
    "the function body is non-empty (found the $$ ... $$ block)",
    body.trim().length > 0
  );
  const deleteIdx = body.toLowerCase().indexOf("delete from public.competitors");
  const insertIdx = body.toLowerCase().indexOf("insert into public.competitors");
  check(
    "DELETE and INSERT both exist inside the SAME function body",
    deleteIdx !== -1 && insertIdx !== -1
  );
  check(
    "DELETE precedes INSERT in program order — a swap here would insert-then-delete, silently discarding what was just written",
    deleteIdx !== -1 && insertIdx !== -1 && deleteIdx < insertIdx
  );
  check(
    "no EXCEPTION handler anywhere in the body — a constraint violation on INSERT is never caught, so it always rolls back the DELETE above it",
    !/exception\s+when/i.test(body)
  );
  check(
    "the function ends with a read-back (RETURN QUERY ... FROM public.competitors), inside the same atomic call",
    /return query[\s\S]*from public\.competitors/i.test(body)
  );

  // ---- Project-scoping: never from the payload -----------------------
  check(
    "DELETE is scoped by the function's own p_project_id parameter, never a payload-supplied value",
    /delete\s+from public\.competitors\s+where project_id = p_project_id/i.test(
      body
    )
  );
  check(
    "INSERT's project_id column is populated from p_project_id (the parameter), not read from the JSONB payload",
    /select\s+p_project_id,/i.test(body.replace(/\n\s*/g, " "))
  );
  check(
    "raises explicitly on a NULL project_id — never silently no-ops or deletes across all projects",
    /if p_project_id is null then/i.test(body) && /raise exception/i.test(body)
  );

  // ---- canonical_entity_type derived server-side, never trusted -----
  check(
    "canonical_entity_type is computed from canonical_entity_id via CASE/WHEN inside the INSERT — never read from a client-supplied type field",
    /case\s+when nullif\(elem ->> 'canonicalEntityId', ''\) is not null\s+then 'competitor'\s+else null\s+end/i.test(
      body.replace(/\n\s*/g, " ")
    )
  );
  check(
    "the INSERT column list includes both canonical_entity_id and canonical_entity_type",
    /insert into public\.competitors \([\s\S]*?canonical_entity_id[\s\S]*?canonical_entity_type[\s\S]*?\)/i.test(
      body
    )
  );

  // ---- Existing constraints/grants/RLS from 0045/0010/0011 untouched -
  check(
    "does not alter, drop, or recreate any constraint on competitors (0045's FK/CHECKs keep applying to every row this function inserts)",
    !/alter table public\.competitors\s+(drop|add) constraint/i.test(codeOnly)
  );
  check(
    "does not touch RLS on competitors — no ENABLE/DISABLE/FORCE ROW LEVEL SECURITY statement",
    !/row level security/i.test(codeOnlyLower)
  );
  check(
    "does not GRANT or REVOKE anything on the competitors TABLE itself — only on the new FUNCTION",
    !/(grant|revoke)[\s\S]*?on table public\.competitors/i.test(codeOnlyLower)
  );

  // ---- Function-level privileges -------------------------------------
  check(
    "EXECUTE is revoked from public/anon/authenticated and granted only to service_role",
    /revoke all on function\s+public\.replace_competitors_for_project\(uuid, jsonb\)\s+from public/i.test(
      codeOnly
    ) &&
      /revoke all on function\s+public\.replace_competitors_for_project\(uuid, jsonb\)\s+from anon/i.test(
        codeOnly
      ) &&
      /revoke all on function\s+public\.replace_competitors_for_project\(uuid, jsonb\)\s+from authenticated/i.test(
        codeOnly
      ) &&
      /grant execute on function\s+public\.replace_competitors_for_project\(uuid, jsonb\)\s+to service_role/i.test(
        codeOnly
      )
  );

  // ---- No data written by this migration itself ----------------------
  check(
    "no bare INSERT/UPDATE/DELETE statement outside the function body — this migration writes no data itself",
    (() => {
      const withoutFunctionBody = codeOnly.replace(/as \$\$[\s\S]*?\$\$;/, "");
      return (
        !/insert\s+into/i.test(withoutFunctionBody) &&
        !/delete\s+from/i.test(withoutFunctionBody) &&
        !/update\s+\w+(\.\w+)?\s+set\b/i.test(withoutFunctionBody)
      );
    })()
  );
}

/* -------------------------------------------------------------------------- */
/*  Part 2 — buildCompetitorsRpcPayload (the exact function whose gap        */
/*  caused the incident)                                                     */
/* -------------------------------------------------------------------------- */

function baseCompetitor(over: Partial<CompetitorInput> = {}): CompetitorInput {
  return {
    name: "Widgetco",
    website: null,
    discoverySource: "ai_answer",
    mentionCount: 1,
    promptIds: [],
    threatLevel: "medium",
    confidence: "verified",
    isPhantom: false,
    isBlindSpot: false,
    canonicalEntityId: null,
    ...over,
  };
}

function payloadChecks(): void {
  console.log("\n[buildCompetitorsRpcPayload: the incident's exact root cause]");

  const canonical = baseCompetitor({
    canonicalEntityId: "11111111-1111-4111-8111-111111111111",
  });
  const [canonicalRow] = buildCompetitorsRpcPayload([canonical]) as Array<
    Record<string, unknown>
  >;
  check(
    "a row with a real canonicalEntityId gets canonicalEntityType='competitor' in the payload — the exact field the incident's INSERT was missing",
    canonicalRow.canonicalEntityId === "11111111-1111-4111-8111-111111111111" &&
      canonicalRow.canonicalEntityType === "competitor"
  );

  const nonCanonical = baseCompetitor({
    discoverySource: "client_site",
    canonicalEntityId: null,
  });
  const [nonCanonicalRow] = buildCompetitorsRpcPayload([nonCanonical]) as Array<
    Record<string, unknown>
  >;
  check(
    "a non-canonical row (canonicalEntityId null) gets canonicalEntityType null — never 'competitor' without an id",
    nonCanonicalRow.canonicalEntityId === null &&
      nonCanonicalRow.canonicalEntityType === null
  );

  check(
    "the two fields are never desynchronized across a mixed batch — this is what a real replaceCompetitorsForProject call sends",
    (() => {
      const rows = buildCompetitorsRpcPayload([canonical, nonCanonical]) as Array<
        Record<string, unknown>
      >;
      return rows.every((r) =>
        r.canonicalEntityId === null
          ? r.canonicalEntityType === null
          : r.canonicalEntityType === "competitor"
      );
    })()
  );

  check(
    "an empty competitor list produces an empty payload — no spurious row",
    buildCompetitorsRpcPayload([]).length === 0
  );

  check(
    "every field the RPC's INSERT column list expects is present in the payload",
    (() => {
      const [row] = buildCompetitorsRpcPayload([canonical]) as Array<
        Record<string, unknown>
      >;
      return (
        "name" in row &&
        "website" in row &&
        "discoverySource" in row &&
        "mentionCount" in row &&
        "promptIds" in row &&
        "threatLevel" in row &&
        "confidence" in row &&
        "isPhantom" in row &&
        "isBlindSpot" in row &&
        "canonicalEntityId" in row &&
        "canonicalEntityType" in row
      );
    })()
  );
}

/* -------------------------------------------------------------------------- */

function main(): void {
  staticSchemaChecks();
  payloadChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M3 transactional replace_competitors_for_project contract PASSED."
        : "M3 transactional replace_competitors_for_project contract FAILED.")
  );
  console.log(
    "\nPart 1 verifies migration 0046's TEXT only — it is not created in\n" +
      "the database, not applied to staging, not applied to Production.\n" +
      "Part 2 is a real runtime test of the payload-building pure function,\n" +
      "no database, no LLM, no staging/Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
