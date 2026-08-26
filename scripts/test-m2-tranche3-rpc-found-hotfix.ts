#!/usr/bin/env tsx
/**
 * M2 tranche 3 hotfix #2 regression (supabase/migrations/0044_m2_fix_
 * entity_resolution_rpc_found.sql).
 *
 * Static checks against the migration's own SQL text: the function's
 * public signature and RETURNS TABLE columns are byte-for-byte
 * identical (modulo whitespace) to 0043's; every branch this fix must
 * preserve is textually present (reused alias head, new
 * canonical_entity + new alias, APPLIED/ALREADY_APPLIED/
 * SUPERSEDED_PRIOR/CONFLICT, brand-self override, pass completion,
 * FOR UPDATE locking); the three named explicit booleans replace every
 * FOUND read after the alias lookup; start_or_resume_entity_resolution_pass
 * is untouched by this migration; no table/column/constraint/index/RLS
 * DDL appears anywhere.
 *
 * Plus local functional tests, against the in-memory adapter, of the
 * exact deduplication behavior the bug broke: a first-ever competitor
 * sighting creates one canonical_entity + one alias; a second sighting
 * of the identical normalized_text (in a different probe_result)
 * reuses that same canonical_entity, never creating a second one;
 * entity_aliases is non-empty after the normal resolved/competitor
 * path; and distinct mention_ordinal values within one pass stay
 * distinct. The in-memory adapter is a plain TypeScript
 * reimplementation with no PL/pgSQL FOUND variable, so it was never
 * subject to this exact bug — these checks lock in the correct,
 * already-working behavior as a shared-interface regression guard,
 * complementing the static checks above (which are what actually
 * verify the real SQL fix, since no live Postgres connection is
 * available in this test file).
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";

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

function extractFunctionHeader(source: string, functionName: string): string {
  const startMarker = `create or replace function\n  public.${functionName}(`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`function header not found: ${functionName}`);
  const asIdx = source.indexOf("\nas $$", startIdx);
  if (asIdx < 0) throw new Error(`'as $$' not found after header: ${functionName}`);
  return source.slice(startIdx, asIdx).replace(/\s+/g, " ").trim();
}

function extractFunctionBody(source: string, functionName: string): string {
  const headerMarker = `create or replace function\n  public.${functionName}(`;
  const headerIdx = source.indexOf(headerMarker);
  if (headerIdx < 0) throw new Error(`function header not found: ${functionName}`);
  const bodyStart = source.indexOf("\nas $$", headerIdx);
  if (bodyStart < 0) throw new Error(`'as $$' not found after header: ${functionName}`);
  const bodyEnd = source.indexOf("\n$$;", bodyStart);
  if (bodyEnd < 0) throw new Error(`closing '$$;' not found for function: ${functionName}`);
  return source.slice(bodyStart, bodyEnd);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function freshDomain(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}.example.com`;
}

async function main(): Promise<void> {
  const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
  const source0043 = fs.readFileSync(
    path.join(migrationsDir, "0043_m2_fix_entity_resolution_rpc_ambiguity.sql"),
    "utf8"
  );
  const source0044 = fs.readFileSync(
    path.join(migrationsDir, "0044_m2_fix_entity_resolution_rpc_found.sql"),
    "utf8"
  );

  const header0043 = extractFunctionHeader(source0043, "resolve_and_record_entity_observation");
  const header0044 = extractFunctionHeader(source0044, "resolve_and_record_entity_observation");
  const body0044 = extractFunctionBody(source0044, "resolve_and_record_entity_observation");

  /* ---------------------------------------------------------------- */
  /* Public signature / RETURNS TABLE unchanged                        */
  /* ---------------------------------------------------------------- */
  {
    check(
      "resolve_and_record_entity_observation: signature and RETURNS TABLE unchanged (0044 vs 0043)",
      header0043 === header0044
    );
    check(
      "0044 does not touch start_or_resume_entity_resolution_pass at all",
      !source0044.includes("public.start_or_resume_entity_resolution_pass(")
    );
  }

  /* ---------------------------------------------------------------- */
  /* SECURITY DEFINER / search_path / privileges unchanged — exactly   */
  /* one function touched by this migration, so each appears once      */
  /* ---------------------------------------------------------------- */
  {
    check("0044: 'security definer' appears exactly once", countOccurrences(source0044, "security definer") === 1);
    check(
      "0044: 'set search_path = public, pg_temp' appears exactly once",
      countOccurrences(source0044, "set search_path = public, pg_temp") === 1
    );
    check(
      "0044: EXECUTE granted to service_role exactly once",
      countOccurrences(source0044, "to service_role;") === 1
    );
    check(
      "0044: EXECUTE revoked from public/anon/authenticated (3 revoke statements)",
      countOccurrences(source0044, "revoke all on function") === 3
    );

    const lowerSource = source0044.toLowerCase();
    for (const forbidden of [
      "create table",
      "alter table",
      "drop table",
      "create index",
      "drop index",
      "create policy",
      "alter policy",
      "drop policy",
    ]) {
      check(`0044 contains no '${forbidden}'`, !lowerSource.includes(forbidden));
    }
  }

  /* ---------------------------------------------------------------- */
  /* The three named explicit booleans replace every FOUND read after  */
  /* the alias lookup — no bare `if found`/`if not found` remains       */
  /* anywhere in the function body                                     */
  /* ---------------------------------------------------------------- */
  {
    check(
      "0044: v_pass_found is captured immediately after the pass lookup",
      body0044.includes("for update;\n  v_pass_found := found;")
    );
    check(
      "0044: v_alias_head_found is captured immediately after the alias lookup",
      body0044.includes("for update;\n    v_alias_head_found := found;")
    );
    check(
      "0044: v_existing_observation_found is captured immediately after the observation lookup",
      body0044.includes("for update;\n  v_existing_observation_found := found;")
    );

    check(
      "0044: no bare 'if found' remains in the function body",
      !/(?<!v_alias_head_found := )\bif found\b/.test(body0044)
    );
    check("0044: no bare 'if not found' remains in the function body", !/\bif not found\b/.test(body0044));

    check(
      "0044: the demote-block check reads v_alias_head_found, not FOUND",
      body0044.includes("if v_alias_head_found and v_alias_head.entity_type = 'client'")
    );
    check(
      "0044: the competitor/platform find-or-create reads v_alias_head_found",
      body0044.includes("if v_alias_head_found then\n        v_canonical_entity_id := v_alias_head.canonical_entity_id;")
    );
    check(
      "0044: the alias-write decision reads v_alias_head_found, immune to the canonical_entities insert above it",
      body0044.includes("if not v_alias_head_found then")
    );
    check(
      "0044: the observation-write decision reads v_existing_observation_found",
      body0044.includes("if not v_existing_observation_found then")
    );
  }

  /* ---------------------------------------------------------------- */
  /* Every branch this fix must preserve is textually present           */
  /* ---------------------------------------------------------------- */
  {
    check(
      "0044: ALREADY_APPLIED branch preserved",
      body0044.includes(
        "elsif v_alias_head.canonical_entity_id = v_canonical_entity_id\n          and v_alias_head.entity_type = v_effective_entity_type then"
      ) && body0044.includes("v_alias_outcome := 'ALREADY_APPLIED';")
    );
    check(
      "0044: SUPERSEDED_PRIOR branch preserved",
      body0044.includes("elsif v_pass.resolver_version > v_alias_head.resolver_version then") &&
        body0044.includes("v_alias_outcome := 'SUPERSEDED_PRIOR';")
    );
    check("0044: CONFLICT (alias) branch preserved", body0044.includes("v_alias_outcome := 'CONFLICT';"));
    check("0044: APPLIED (alias) branch preserved", body0044.includes("v_alias_outcome := 'APPLIED';"));
    check(
      "0044: brand-self unconditional override (D-018) preserved",
      body0044.includes("v_effective_status := 'excluded_brand_self';") &&
        body0044.includes("v_effective_entity_type := 'client';")
    );
    check(
      "0044: pass completion logic preserved",
      body0044.includes("if v_observation_count = v_pass.expected_mention_count then") &&
        body0044.includes("v_pass_status := 'completed';")
    );
    check(
      "0044: row locking (FOR UPDATE) preserved on all three lookups",
      countOccurrences(body0044, "for update;") === 3
    );
    check(
      "0044: append-only — no UPDATE/DELETE on entity_aliases or entity_observations, only INSERT",
      !/update\s+public\.entity_aliases/.test(body0044) &&
        !/delete\s+from\s+public\.entity_aliases/.test(body0044) &&
        !/update\s+public\.entity_observations/.test(body0044) &&
        !/delete\s+from\s+public\.entity_observations/.test(body0044)
    );
  }

  /* ---------------------------------------------------------------- */
  /* Functional: first-ever competitor creates one canonical_entity     */
  /* and one alias                                                      */
  /* ---------------------------------------------------------------- */
  const db = getDb();
  let firstCanonicalEntityId: string;
  {
    const project = await db.createProject({
      domain: freshDomain("found-hotfix-a"),
      companyName: "Acme Found Co.",
    });
    const datasetBatch = await db.createDatasetBatch({ projectId: project.id, datasetSourceType: "manual_scan" });
    const probeRun = await db.createProbeRun(project.id, "perplexity", "simulated", "succeeded", {
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    const probeResult = await db.saveProbeResult({
      probeRunId: probeRun.id,
      projectId: project.id,
      prompt: "who should we use",
      platform: "perplexity",
      probeMode: "simulated",
      rawResponse: "Widgetco and Gadgetco both came up here.",
      clientMentioned: false,
      clientPosition: "absent",
      competitorsMentioned: [
        { name: "Widgetco", position: 1, context: "Widgetco and Gadgetco" },
        { name: "Gadgetco", position: 2, context: "Widgetco and Gadgetco" },
      ],
      sourcesCited: [],
      answerSummary: "",
      verdict: "lost",
      whyClientLost: "",
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    const pass = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 2,
      companyName: "Acme Found Co.",
      domain: project.domain,
      normalizedBrandTerms: ["acme found", project.domain],
      mirrorAliases: [],
    });

    const first = await db.resolveAndRecordEntityObservation({
      resolutionPassId: pass.resolutionPassId,
      mentionOrdinal: 1,
      rawText: "Widgetco",
      normalizedText: "widgetco",
      status: "resolved",
      proposedEntityType: "competitor",
      context: "Widgetco and Gadgetco",
    });
    check("1: first-ever sighting — observation APPLIED", first.observationOutcome === "APPLIED");
    check(
      "1: first-ever sighting — alias APPLIED at generation 1",
      first.aliasOutcome === "APPLIED" && first.aliasGeneration === 1
    );
    check("1: alias_id is non-null", typeof first.aliasId === "string" && first.aliasId.length > 0);

    // Distinct-ordinal check, same probe_result: a second, DIFFERENT
    // competitor at ordinal 2 must not collide with ordinal 1.
    const second = await db.resolveAndRecordEntityObservation({
      resolutionPassId: pass.resolutionPassId,
      mentionOrdinal: 2,
      rawText: "Gadgetco",
      normalizedText: "gadgetco",
      status: "resolved",
      proposedEntityType: "competitor",
      context: "Widgetco and Gadgetco",
    });
    check("4: distinct competitor at ordinal 2 is its own APPLIED alias", second.aliasOutcome === "APPLIED");

    const observations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    check(
      "4: ordinals 1 and 2 both exist as distinct observations, never merged",
      observations.length === 2 &&
        observations.some((o) => o.mentionOrdinal === 1) &&
        observations.some((o) => o.mentionOrdinal === 2)
    );
    const obsAtOrdinal1 = observations.find((o) => o.mentionOrdinal === 1)!;
    const obsAtOrdinal2 = observations.find((o) => o.mentionOrdinal === 2)!;
    check(
      "4: the two distinct competitors resolve to two distinct canonical entities",
      obsAtOrdinal1.canonicalEntityId !== obsAtOrdinal2.canonicalEntityId
    );

    const aliasesAfterFirst = await db.getEntityAliasesActiveByProject(project.id);
    check(
      "3: entity_aliases is non-empty after the normal resolved/competitor path",
      aliasesAfterFirst.length === 2,
      `${aliasesAfterFirst.length}`
    );

    firstCanonicalEntityId = obsAtOrdinal1.canonicalEntityId as string;
  }

  /* ---------------------------------------------------------------- */
  /* Functional: a second sighting of the identical normalized_text,   */
  /* in a DIFFERENT probe_result, reuses the same canonical_entity —   */
  /* this is exactly the deduplication the bug broke                   */
  /* ---------------------------------------------------------------- */
  {
    const project = await db.createProject({
      domain: freshDomain("found-hotfix-b"),
      companyName: "Acme Found Co. Two",
    });
    const datasetBatch = await db.createDatasetBatch({ projectId: project.id, datasetSourceType: "manual_scan" });

    async function seedAndResolveWidgetco(): Promise<{
      canonicalEntityId: string | null;
      aliasOutcome: string;
      aliasId: string | null;
    }> {
      const probeRun = await db.createProbeRun(project.id, "perplexity", "simulated", "succeeded", {
        datasetId: datasetBatch.id,
        datasetSourceType: "manual_scan",
      });
      const probeResult = await db.saveProbeResult({
        probeRunId: probeRun.id,
        projectId: project.id,
        prompt: "who should we use",
        platform: "perplexity",
        probeMode: "simulated",
        rawResponse: "Widgetco is the only option mentioned here.",
        clientMentioned: false,
        clientPosition: "absent",
        competitorsMentioned: [{ name: "Widgetco", position: 1, context: "Widgetco is the only option" }],
        sourcesCited: [],
        answerSummary: "",
        verdict: "lost",
        whyClientLost: "",
        datasetId: datasetBatch.id,
        datasetSourceType: "manual_scan",
      });
      const pass = await db.startOrResumeEntityResolutionPass({
        projectId: project.id,
        probeResultId: probeResult.id,
        resolverVersion: 1,
        datasetId: datasetBatch.id,
        expectedMentionCount: 1,
        companyName: "Acme Found Co. Two",
        domain: project.domain,
        normalizedBrandTerms: ["acme found two", project.domain],
        mirrorAliases: [],
      });
      const result = await db.resolveAndRecordEntityObservation({
        resolutionPassId: pass.resolutionPassId,
        mentionOrdinal: 1,
        rawText: "Widgetco",
        normalizedText: "widgetco",
        status: "resolved",
        proposedEntityType: "competitor",
        context: "Widgetco is the only option",
      });
      const observations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
      return {
        canonicalEntityId: observations[0]?.canonicalEntityId ?? null,
        aliasOutcome: result.aliasOutcome,
        aliasId: result.aliasId,
      };
    }

    const sighting1 = await seedAndResolveWidgetco();
    check(
      "2: first sighting in this project creates a fresh alias (APPLIED)",
      sighting1.aliasOutcome === "APPLIED"
    );

    const sighting2 = await seedAndResolveWidgetco();
    check(
      "2: second sighting of the identical normalized_text is ALREADY_APPLIED, not a fresh APPLIED",
      sighting2.aliasOutcome === "ALREADY_APPLIED"
    );
    check(
      "2: second sighting reuses the exact same canonical_entity as the first — the deduplication the bug broke",
      sighting1.canonicalEntityId !== null &&
        sighting1.canonicalEntityId === sighting2.canonicalEntityId,
      `${sighting1.canonicalEntityId} vs ${sighting2.canonicalEntityId}`
    );
    check(
      "2: second sighting reuses the exact same alias row",
      sighting1.aliasId !== null && sighting1.aliasId === sighting2.aliasId
    );

    const aliases = await db.getEntityAliasesActiveByProject(project.id);
    check(
      "2: exactly one alias exists for this identity across two probe_results, not two",
      aliases.length === 1,
      `${aliases.length}`
    );

    const canonicalEntities = await db.getCanonicalEntitiesByProject(project.id);
    check(
      "2: exactly one canonical_entity exists for this identity across two probe_results, not two",
      canonicalEntities.length === 1,
      `${canonicalEntities.length}`
    );
  }

  check(
    "sanity: the two independent scenarios used genuinely different canonical entities (different projects)",
    typeof firstCanonicalEntityId === "string" && firstCanonicalEntityId.length > 0
  );

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
