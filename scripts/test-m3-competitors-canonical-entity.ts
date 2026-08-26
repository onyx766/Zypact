#!/usr/bin/env tsx
/**
 * M3 Stage C — `competitors.canonical_entity_id` (Option A, approved
 * read-only architecture brief).
 *
 * Two independent halves:
 *
 *  1. Static assertions over migration 0045's SQL text only — no real
 *     Postgres connection is used, mirroring the established pattern in
 *     scripts/test-m2-tranche3-schema-contract.ts. This verifies the FK
 *     is project-scoped and type-pinned at the database layer, not only
 *     applicatively, and that no redundant unique constraint was added
 *     to canonical_entities (its (id, project_id, entity_type) key
 *     already exists from migration 0038 and is reused as-is).
 *
 *  2. Runtime, pure-function checks (no database) over:
 *       - lib/pipeline/discover-competitors.ts's exact-rawText join
 *         (buildCanonicalIdByExactRawText / resolveCanonicalEntityId) —
 *         the only place a `canonical_entity_id` may be attributed;
 *       - lib/agents/competitor-discovery.ts's aiAgg/otherAgg bridge,
 *         proving it never transfers identity and never changes
 *         mentionCount/threatLevel;
 *       - lib/gap-map/compute-gap-scores.ts's collectCompetitorSignals,
 *         proving canonical-identity matching (not name normalization)
 *         drives mention-derived signals, and that a competitor with no
 *         canonical_entity_id gets an explicit, honest zero rather than
 *         a crash or a name-based guess.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildCanonicalIdByExactRawText,
  resolveCanonicalEntityId,
} from "@/lib/pipeline/discover-competitors";
import { buildMockCompetitorDiscovery } from "@/lib/agents/competitor-discovery";
import { collectCompetitorSignals } from "@/lib/gap-map/compute-gap-scores";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";
import type { Competitor, ProbeResult } from "@/lib/db/types";

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
/*  Part 1 — migration 0045 static schema contract                           */
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
  console.log("\n[static — migration 0045 text]");

  const migrationPath = path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "0045_m3_competitors_canonical_entity.sql"
  );
  const raw = readFileSync(migrationPath, "utf8");
  const codeOnly = stripSqlComments(raw);
  const codeOnlyLower = codeOnly.toLowerCase();

  check(
    "adds canonical_entity_id (nullable uuid) to competitors",
    /add column if not exists canonical_entity_id uuid null/.test(codeOnlyLower)
  );
  check(
    "adds canonical_entity_type (nullable text, constant discriminator) to competitors",
    /add column if not exists canonical_entity_type text null/.test(codeOnlyLower)
  );
  check(
    "canonical_entity_type is CHECK-pinned to the literal 'competitor' (or null) — never client/platform",
    codeOnly.includes("competitors_canonical_entity_type_check") &&
      codeOnly.includes(
        "check (canonical_entity_type is null or canonical_entity_type = 'competitor')"
      )
  );
  check(
    "the two columns travel together — both null or both non-null, never one without the other",
    codeOnly.includes("competitors_canonical_entity_pair_check") &&
      codeOnly.includes("canonical_entity_id is null and canonical_entity_type is null") &&
      codeOnly.includes("canonical_entity_id is not null and canonical_entity_type is not null")
  );
  check(
    "the FK is a 3-column composite (canonical_entity_id, project_id, canonical_entity_type) — project-scoped, not just (canonical_entity_id)",
    codeOnly.includes("competitors_canonical_entity_fk") &&
      codeOnly.includes(
        "foreign key (canonical_entity_id, project_id, canonical_entity_type)"
      ) &&
      codeOnly.includes(
        "references public.canonical_entities (id, project_id, entity_type)"
      )
  );
  check(
    "no new UNIQUE constraint is added to canonical_entities — its (id, project_id, entity_type) key from migration 0038 is reused as-is",
    !/alter table public\.canonical_entities\s+add constraint/i.test(codeOnly) &&
      !/create\s+unique\s+index.*canonical_entities/i.test(codeOnlyLower)
  );
  check(
    "no new UNIQUE/PRIMARY KEY constraint is added to competitors itself — only columns, checks, the FK, and a partial index",
    !/alter table public\.competitors\s+add constraint\s+\w+\s+unique/i.test(codeOnly) &&
      !/alter table public\.competitors\s+add constraint\s+\w+\s+primary key/i.test(codeOnly)
  );
  check(
    "a partial index on canonical_entity_id exists for the non-null case",
    codeOnly.includes("competitors_canonical_entity_idx") &&
      codeOnly.includes("on public.competitors (canonical_entity_id)") &&
      codeOnly.includes("where canonical_entity_id is not null")
  );
  check(
    "no INSERT/UPDATE/DELETE — this migration writes no data, no backfill",
    !/insert\s+into/i.test(codeOnlyLower) &&
      !/update\s+\w+(\.\w+)?\s+set\b/i.test(codeOnlyLower) &&
      !/delete\s+from/i.test(codeOnlyLower)
  );
  check(
    "no RLS/privilege statement touches competitors — this migration changes only columns/constraints/index",
    !/revoke|grant/i.test(codeOnly) && !/enable row level security/i.test(codeOnlyLower)
  );
}

/* -------------------------------------------------------------------------- */
/*  Part 2a — discover-competitors.ts's exact-rawText join                    */
/* -------------------------------------------------------------------------- */

function mention(
  rawText: string,
  canonicalEntityId: string
): ResolvedCompetitorMention {
  return {
    canonicalEntityId,
    rawText,
    normalizedText: rawText.trim().toLowerCase(),
    mentionOrdinal: 1,
    context: null,
    generatedPromptId: null,
  };
}

function discoveryJoinChecks(): void {
  console.log("\n[discover-competitors.ts: exact-rawText canonical join]");

  // Exact match: the discovery agent's returned name is byte-identical
  // to an observed rawText for one canonical entity.
  {
    const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
      ["pr-1", [mention("Widgetco Inc.", "canonical:widgetco")]],
    ]);
    const byRawText = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
    check(
      "exact match: an ai_answer name identical to an observed rawText resolves to that canonical id",
      resolveCanonicalEntityId("Widgetco Inc.", "ai_answer", byRawText) === "canonical:widgetco"
    );
    check(
      "no fuzzy fallback: a near-miss name (case/whitespace-different in a way exact match rejects) does NOT resolve",
      resolveCanonicalEntityId("widgetco inc.", "ai_answer", byRawText) === null
    );
  }

  // Paraphrase: the agent's returned name was never observed verbatim
  // for any canonical entity — must stay NULL, never guessed.
  {
    const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
      ["pr-1", [mention("Acme Tool", "canonical:acmetool")]],
    ]);
    const byRawText = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
    check(
      "LLM paraphrase: an ai_answer name that was never observed verbatim resolves to NULL, never a guess",
      resolveCanonicalEntityId("The Acme Tool Platform", "ai_answer", byRawText) === null
    );
  }

  // Non-ai_answer sources never get a canonical id, even if their name
  // happens to match an observed rawText exactly.
  for (const source of ["user", "client_site", "model_knowledge"]) {
    const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
      ["pr-1", [mention("Widgetco", "canonical:widgetco")]],
    ]);
    const byRawText = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
    check(
      `discoverySource '${source}' without an ai_answer contribution stays NULL, even on an exact name match`,
      resolveCanonicalEntityId("Widgetco", source, byRawText) === null
    );
  }

  // Ambiguity: the exact same raw text observed for two DIFFERENT
  // canonical entities must never be guessed either way.
  {
    const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
      ["pr-1", [mention("Acme", "canonical:acme-one")]],
      ["pr-2", [mention("Acme", "canonical:acme-two")]],
    ]);
    const byRawText = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
    check(
      "ambiguous exact rawText (same text, two different canonical entities) resolves to NULL, not an arbitrary pick",
      resolveCanonicalEntityId("Acme", "ai_answer", byRawText) === null
    );
  }

  // Platform names are excluded from the exact-match universe entirely.
  {
    const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
      ["pr-1", [mention("ChatGPT", "canonical:chatgpt")]],
    ]);
    const byRawText = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
    check(
      "a platform name never enters the exact-match universe, even verbatim",
      resolveCanonicalEntityId("ChatGPT", "ai_answer", byRawText) === null
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Part 2b — competitor-discovery.ts's aiAgg/otherAgg bridge                 */
/* -------------------------------------------------------------------------- */

function bridgeChecks(): void {
  console.log("\n[competitor-discovery.ts: aiAgg/otherAgg bridge never transfers identity or inflates scores]");

  const probeResults = [
    { id: "pr-a", generatedPromptId: "prompt-1", competitorsMentioned: [] },
    { id: "pr-b", generatedPromptId: "prompt-1", competitorsMentioned: [] },
  ] as any;

  // Two mentions of the SAME canonical entity across two probe_results —
  // this is what a real ai_answer contribution with 2 mentions looks like.
  const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
    ["pr-a", [mention("Widgetco", "canonical:widgetco")]],
    ["pr-b", [mention("Widgetco", "canonical:widgetco")]],
  ]);

  const withoutBridge = buildMockCompetitorDiscovery({
    mirrorProfile: { companyName: "Acme", website: "acme.com", competitorsMentioned: [] } as any,
    userCompetitors: [],
    probeResults,
    resolvedMentionsByProbeResult,
  });
  const withBridge = buildMockCompetitorDiscovery({
    mirrorProfile: {
      companyName: "Acme",
      website: "acme.com",
      // Same display-name match as the ai_answer entry — triggers the bridge.
      competitorsMentioned: ["Widgetco"],
    } as any,
    userCompetitors: [],
    probeResults,
    resolvedMentionsByProbeResult,
  });

  const wNoBridge = withoutBridge.competitors.find((c) => c.name.toLowerCase().includes("widgetco"))!;
  const wBridge = withBridge.competitors.find((c) => c.name.toLowerCase().includes("widgetco"))!;

  check(
    "precondition: both scenarios discover exactly one Widgetco entry",
    withoutBridge.competitors.length === 1 && withBridge.competitors.length === 1
  );
  check(
    "the bridge does not change mentionCount — still exactly the ai_answer mention count (2), not 3",
    wNoBridge.mentionCount === 2 && wBridge.mentionCount === 2
  );
  check(
    "the bridge does not change threatLevel",
    wNoBridge.threatLevel === wBridge.threatLevel
  );
  check(
    "the bridge only adds a source (client_site alongside ai_answer) — it does not replace discoverySource with a non-ai_answer value",
    wBridge.discoverySource === "ai_answer"
  );

  // Now prove the join at the orchestrator boundary (discover-competitors.ts)
  // resolves canonicalEntityId from the ai_answer contribution only, and
  // that the bridge's presence/absence does not change WHICH canonical id
  // gets attributed.
  const byRawTextNoBridge = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
  const byRawTextWithBridge = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
  check(
    "canonical_entity_id attribution is identical with or without the client_site bridge — the bridge never participates in the identity join",
    resolveCanonicalEntityId(wNoBridge.name, wNoBridge.discoverySource, byRawTextNoBridge) ===
      resolveCanonicalEntityId(wBridge.name, wBridge.discoverySource, byRawTextWithBridge) &&
      resolveCanonicalEntityId(wBridge.name, wBridge.discoverySource, byRawTextWithBridge) ===
        "canonical:widgetco"
  );

  // A client_site/user-only entry (no ai_answer contribution at all) must
  // never acquire a canonical_entity_id via the bridge.
  const clientOnly = buildMockCompetitorDiscovery({
    mirrorProfile: { companyName: "Acme", website: "acme.com", competitorsMentioned: ["SiteOnlyRival"] } as any,
    userCompetitors: [],
    probeResults,
    resolvedMentionsByProbeResult,
  });
  const siteOnly = clientOnly.competitors.find((c) => c.name === "SiteOnlyRival")!;
  const byRawTextForSiteOnly = buildCanonicalIdByExactRawText(resolvedMentionsByProbeResult);
  check(
    "a client_site-only entry (no ai_answer contribution) never resolves a canonical_entity_id, even after the merge pass runs",
    resolveCanonicalEntityId(siteOnly.name, siteOnly.discoverySource, byRawTextForSiteOnly) === null
  );
}

/* -------------------------------------------------------------------------- */
/*  Part 2c — compute-gap-scores.ts: canonical-identity matching             */
/* -------------------------------------------------------------------------- */

function probe(id: string, prompt: string, verdict: string): ProbeResult {
  return {
    id,
    probeRunId: "run-1",
    projectId: "proj-1",
    generatedPromptId: `gp-${id}`,
    prompt,
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: "",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict,
    whyClientLost: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as any;
}

function competitorRow(name: string, canonicalEntityId: string | null): Competitor {
  return {
    id: `c-${name}`,
    projectId: "proj-1",
    name,
    website: null,
    discoverySource: canonicalEntityId ? "ai_answer" : "client_site",
    mentionCount: 0,
    promptIds: [],
    threatLevel: "low",
    confidence: canonicalEntityId ? "verified" : "unverified",
    isPhantom: false,
    isBlindSpot: false,
    canonicalEntityId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function computeGapScoresChecks(): void {
  console.log("\n[compute-gap-scores.ts: canonical-identity matching, explicit NULL handling]");

  const prLost = probe("pr-lost", "Best tools?", "lost");
  const prLost2 = probe("pr-lost-2", "Best tools?", "lost"); // same prompt group

  // Two probe_results, same canonicalEntityId, different surface forms —
  // must be counted once per prompt group and matched by identity, not name.
  const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
    ["pr-lost", [mention("Widgetco", "canonical:widgetco")]],
    ["pr-lost-2", [mention("Widgetco Inc.", "canonical:widgetco")]],
  ]);

  const linked = competitorRow("Widgetco Inc.", "canonical:widgetco");
  const linkedSignals = collectCompetitorSignals(
    linked,
    [prLost, prLost2],
    resolvedMentionsByProbeResult
  );
  check(
    "a competitor with a real canonical_entity_id matching resolved mentions shows a genuine appearance",
    linkedSignals.appearances === 1 // one prompt group ("Best tools?"), both rows in it
  );
  check(
    "clientLostWhenAppears reflects the lost verdict for the matched prompt group",
    linkedSignals.clientLostWhenAppears === 1
  );

  // A competitor with NO canonical_entity_id (client_site/user/paraphrased
  // ai_answer) must get an explicit, honest zero — never a name-based guess
  // that could accidentally match "Widgetco"'s own mentions.
  const unlinked = competitorRow("Widgetco", null);
  const unlinkedSignals = collectCompetitorSignals(
    unlinked,
    [prLost, prLost2],
    resolvedMentionsByProbeResult
  );
  check(
    "a competitor with canonical_entity_id = NULL gets zero appearances — explicit non-resolution, not a name-based fallback match",
    unlinkedSignals.appearances === 0
  );
  check(
    "a competitor with canonical_entity_id = NULL gets zero clientLostWhenAppears, zero proofSignalCount — every mention-derived signal stays at its honest default",
    unlinkedSignals.clientLostWhenAppears === 0 && unlinkedSignals.proofSignalCount === 0
  );
  check(
    "collectCompetitorSignals never throws for a NULL canonical_entity_id — an unresolved row is a valid, well-defined state",
    true // reaching this line without throwing already proves it
  );

  // Two DIFFERENT canonical entities must never be conflated even when one
  // competitor row's name is a substring/superset of the other's.
  const other = competitorRow("Gadgetco", "canonical:gadgetco");
  const otherSignals = collectCompetitorSignals(other, [prLost, prLost2], resolvedMentionsByProbeResult);
  check(
    "a genuinely different canonical entity (no matching mentions in this fixture) correctly shows zero appearances",
    otherSignals.appearances === 0
  );
}

/* -------------------------------------------------------------------------- */

function main(): void {
  staticSchemaChecks();
  discoveryJoinChecks();
  bridgeChecks();
  computeGapScoresChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M3 Stage C competitors.canonical_entity_id contract PASSED."
        : "M3 Stage C competitors.canonical_entity_id contract FAILED.")
  );
  console.log(
    "\nPart 1 verifies migration 0045's TEXT only — it is never applied to\n" +
      "any database. Parts 2a-2c are pure-function checks against the real\n" +
      "exported helpers (no database, no LLM, no staging/Production)."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
