#!/usr/bin/env tsx
/**
 * M2 canonical observations contract, third tranche (D-017, D-018,
 * D-019) — historical reprocessing.
 *
 * Runs the same entity-resolution step that
 * lib/pipeline/analyze-probe-response.ts wires into new probe_results
 * (locate the client's own mention, resolve each competitor mention,
 * one mention_ordinal per mention) against probe_results that already
 * exist — rows created before this tranche's wiring landed, or a pass
 * left incomplete for any reason.
 *
 * This script never calls an LLM provider, never recomputes product
 * signals, and never writes to probe_runs/probe_results or any other
 * M1/legacy evidence column. It only reads already-persisted fields
 * (rawResponse, competitorsMentioned) and writes exclusively through
 * migration 0042's two SECURITY DEFINER RPCs
 * (startOrResumeEntityResolutionPass / resolveAndRecordEntityObservation),
 * exactly as the live pipeline does.
 *
 * Usage:
 *   npx tsx scripts/backfill-entity-observations.ts \
 *     --project-id <id> [--probe-result-id <id>] \
 *     [--resolver-version <n>] [--dry-run | --apply]
 *
 * --dry-run (default): reports, for every targeted probe_result,
 *   whether an already-complete pass exists at the requested
 *   resolver_version. Performs zero reads beyond the existing
 *   getEntityObservationsActiveByProbeResult view and zero writes —
 *   neither RPC is ever called in this mode.
 * --apply: performs the writes described above for every targeted
 *   probe_result found to need it. A probe_result already complete at
 *   the requested resolver_version is skipped without calling either
 *   RPC (script-level idempotence, on top of both RPCs' own resume
 *   safety) — running --apply twice produces zero additional writes.
 *
 * --project-id is mandatory: this script never auto-discovers
 * projects, matching scripts/backfill-probe-result-dataset-identity.ts's
 * own blast-radius discipline. --probe-result-id, when given, narrows
 * the target to that one row (it must belong to --project-id).
 *
 * One probe_result's failure never aborts the batch: each is processed
 * in its own try/catch and reported as its own outcome, so one bad row
 * does not hide the result of every other row in the same run.
 */

import { getDb } from "@/lib/db";
import type {
  DbAdapter,
  EntityResolutionPassOutcome,
  ProbeResult,
} from "@/lib/db/types";
import { buildClientIdentity } from "@/lib/evidence/build-client-identity";
import { locateClientMention } from "@/lib/evidence/locate-client-mention";
import { normalizeEntityTextV1 } from "@/lib/evidence/normalize-entity-text";
import type { ClientIdentity } from "@/lib/schemas/probe-analysis.schema";
import { SiteReaderOutputSchema, type SiteReaderOutput } from "@/lib/schemas/site-reader.schema";

/**
 * Mirrors ENTITY_RESOLVER_VERSION in lib/pipeline/analyze-probe-response.ts.
 * Duplicated, not imported: that constant is not exported, and this
 * tranche's authorized file list does not include modifying that file
 * to export it. Changing the live pipeline's resolver version without
 * updating this default is a configuration drift this file cannot
 * detect on its own — pass --resolver-version explicitly if the two
 * ever diverge.
 */
const DEFAULT_RESOLVER_VERSION = 1;

/**
 * Serializes an unknown thrown value into a human-readable message,
 * without silently discarding structured diagnostic fields.
 *
 * A JS `Error`'s own `.message` is used directly. Anything else — most
 * notably a Supabase/PostgREST error, which the supabase-js client
 * throws as a plain object shaped like `{ message, code, details, hint }`
 * and which is NOT `instanceof Error` — has those fields extracted
 * explicitly. A bare `String(err)` on a plain object always collapses
 * to the literal, useless string "[object Object]", which is exactly
 * what happened here against real staging data: the Supabase adapter's
 * RPC wrappers do `if (error) throw error;` with the raw PostgrestError
 * object (lib/db/supabase-adapter.ts), so this catch site needs more
 * than a bare `String(err)` fallback to ever surface the real cause.
 */
export function serializeUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;

  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.code === "string" && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === "string" && e.details) parts.push(`details=${e.details}`);
    if (typeof e.hint === "string" && e.hint) parts.push(`hint=${e.hint}`);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(err);
    } catch {
      // Falls through to the String(err) fallback below — e.g. a
      // circular structure that JSON.stringify itself cannot handle.
    }
  }

  return String(err);
}

interface CompetitorMentionLike {
  name?: string;
  position?: number;
  context?: string;
}

function readStoredCompetitorMentions(probeResult: ProbeResult): CompetitorMentionLike[] {
  // probeResult.competitorsMentioned is `unknown` at the adapter-type
  // level (typed as CompetitorMention[] by callers — see
  // lib/db/types.ts). This reads the value already persisted by
  // saveProbeResult at analysis time; it is never recomputed here.
  const raw = probeResult.competitorsMentioned;
  if (!Array.isArray(raw)) return [];
  return raw as CompetitorMentionLike[];
}

export type ProbeResultBackfillOutcome =
  | {
      probeResultId: string;
      action: "would_process" | "skipped_already_completed";
      expectedMentionCount: number;
      activeObservationCount: number;
    }
  | {
      probeResultId: string;
      action: "processed";
      expectedMentionCount: number;
      activeObservationCount: number;
      passOutcome: EntityResolutionPassOutcome;
    }
  | {
      probeResultId: string;
      action: "error";
      error: string;
    };

export interface EntityObservationBackfillOptions {
  projectId: string;
  probeResultId?: string;
  resolverVersion?: number;
  apply: boolean;
}

export interface EntityObservationBackfillReport {
  projectId: string;
  resolverVersion: number;
  apply: boolean;
  outcomes: ProbeResultBackfillOutcome[];
}

async function planProbeResult(
  db: DbAdapter,
  clientName: ClientIdentity,
  probeResult: ProbeResult,
  resolverVersion: number
): Promise<{
  clientRawText: string | null;
  normalizedBrandTerms: string[];
  competitorMentions: Array<{ name: string; position?: number; context?: string }>;
  expectedMentionCount: number;
  activeObservationCountAtVersion: number;
  needsProcessing: boolean;
}> {
  const brandTerms = [clientName.name, clientName.domain ?? "", ...(clientName.aliases ?? [])];
  const clientRawText = locateClientMention(probeResult.rawResponse, brandTerms);
  const normalizedBrandTerms = brandTerms
    .map((term) => normalizeEntityTextV1(term))
    .filter((normalized) => normalized.length > 0);

  const competitorMentions = readStoredCompetitorMentions(probeResult).filter(
    (c): c is { name: string; position?: number; context?: string } =>
      typeof c.name === "string" && c.name.trim().length > 0
  );

  const expectedMentionCount = (clientRawText !== null ? 1 : 0) + competitorMentions.length;

  const activeObservations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
  const activeObservationCountAtVersion = activeObservations.filter(
    (o) => o.resolverVersion === resolverVersion
  ).length;

  const needsProcessing = activeObservationCountAtVersion !== expectedMentionCount;

  return {
    clientRawText,
    normalizedBrandTerms,
    competitorMentions,
    expectedMentionCount,
    activeObservationCountAtVersion,
    needsProcessing,
  };
}

async function applyProbeResult(
  db: DbAdapter,
  project: { id: string },
  probeResult: ProbeResult,
  resolverVersion: number,
  clientName: ClientIdentity,
  plan: Awaited<ReturnType<typeof planProbeResult>>
): Promise<ProbeResultBackfillOutcome> {
  if (plan.normalizedBrandTerms.length === 0) {
    return {
      probeResultId: probeResult.id,
      action: "error",
      error:
        "no usable normalized brand terms were available; entity resolution was not attempted",
    };
  }
  if (!probeResult.datasetId) {
    return {
      probeResultId: probeResult.id,
      action: "error",
      error:
        "probe_result has no dataset_id; entity resolution requires an already-resolved dataset identity and this script never invents one",
    };
  }

  try {
    const pass = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion,
      datasetId: probeResult.datasetId,
      expectedMentionCount: plan.expectedMentionCount,
      companyName: clientName.name,
      domain: clientName.domain ?? "",
      normalizedBrandTerms: plan.normalizedBrandTerms,
      mirrorAliases: clientName.aliases ?? [],
    });

    let mentionOrdinal = 0;
    if (plan.clientRawText !== null) {
      await db.resolveAndRecordEntityObservation({
        resolutionPassId: pass.resolutionPassId,
        mentionOrdinal: 0,
        rawText: plan.clientRawText,
        normalizedText: normalizeEntityTextV1(plan.clientRawText),
        status: "excluded_brand_self",
        proposedEntityType: "client",
      });
      mentionOrdinal = 1;
    } else {
      mentionOrdinal = 1;
    }

    for (const competitor of plan.competitorMentions) {
      await db.resolveAndRecordEntityObservation({
        resolutionPassId: pass.resolutionPassId,
        mentionOrdinal,
        rawText: competitor.name,
        normalizedText: normalizeEntityTextV1(competitor.name),
        status: "resolved",
        proposedEntityType: "competitor",
        context: competitor.context ?? null,
      });
      mentionOrdinal += 1;
    }

    const activeObservations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    const activeAtVersion = activeObservations.filter((o) => o.resolverVersion === resolverVersion);
    if (activeAtVersion.length !== plan.expectedMentionCount) {
      return {
        probeResultId: probeResult.id,
        action: "error",
        error: `entity resolution pass ${pass.resolutionPassId} produced ${activeAtVersion.length} active observation(s), expected ${plan.expectedMentionCount}`,
      };
    }

    return {
      probeResultId: probeResult.id,
      action: "processed",
      expectedMentionCount: plan.expectedMentionCount,
      activeObservationCount: activeAtVersion.length,
      passOutcome: pass.passOutcome,
    };
  } catch (err) {
    return {
      probeResultId: probeResult.id,
      action: "error",
      error: serializeUnknownError(err),
    };
  }
}

export async function runEntityObservationBackfill(
  db: DbAdapter,
  options: EntityObservationBackfillOptions
): Promise<EntityObservationBackfillReport> {
  const resolverVersion = options.resolverVersion ?? DEFAULT_RESOLVER_VERSION;

  const project = await db.getProject(options.projectId);
  if (!project) throw new Error(`project not found: ${options.projectId}`);

  const mirrorRow = await db.getMirrorProfile(options.projectId);
  const mirrorProfile: SiteReaderOutput | null = mirrorRow
    ? (() => {
        const parsed = SiteReaderOutputSchema.safeParse(mirrorRow.json);
        return parsed.success ? parsed.data : null;
      })()
    : null;
  const clientName = buildClientIdentity(project, mirrorProfile);

  const allResults = await db.getProbeResultsByProject(options.projectId);
  let targets = allResults;
  if (options.probeResultId) {
    targets = allResults.filter((r) => r.id === options.probeResultId);
    if (targets.length === 0) {
      throw new Error(
        `probe_result ${options.probeResultId} was not found in project ${options.projectId}`
      );
    }
  }

  const outcomes: ProbeResultBackfillOutcome[] = [];
  for (const probeResult of targets) {
    const plan = await planProbeResult(db, clientName, probeResult, resolverVersion);

    if (!plan.needsProcessing) {
      outcomes.push({
        probeResultId: probeResult.id,
        action: "skipped_already_completed",
        expectedMentionCount: plan.expectedMentionCount,
        activeObservationCount: plan.activeObservationCountAtVersion,
      });
      continue;
    }

    if (!options.apply) {
      outcomes.push({
        probeResultId: probeResult.id,
        action: "would_process",
        expectedMentionCount: plan.expectedMentionCount,
        activeObservationCount: plan.activeObservationCountAtVersion,
      });
      continue;
    }

    outcomes.push(await applyProbeResult(db, project, probeResult, resolverVersion, clientName, plan));
  }

  return { projectId: options.projectId, resolverVersion, apply: options.apply, outcomes };
}

interface RunOptions {
  projectId: string;
  probeResultId?: string;
  resolverVersion?: number;
  apply: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  let projectId: string | undefined;
  let probeResultId: string | undefined;
  let resolverVersion: number | undefined;
  let apply = false;
  let dryRunExplicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-id") {
      const value = argv[i + 1];
      if (!value) throw new Error("--project-id requires a value");
      projectId = value;
      i += 1;
    } else if (arg === "--probe-result-id") {
      const value = argv[i + 1];
      if (!value) throw new Error("--probe-result-id requires a value");
      probeResultId = value;
      i += 1;
    } else if (arg === "--resolver-version") {
      const value = argv[i + 1];
      if (!value) throw new Error("--resolver-version requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--resolver-version must be a positive integer");
      }
      resolverVersion = parsed;
      i += 1;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      dryRunExplicit = true;
    }
  }

  if (!projectId) {
    throw new Error("--project-id is required. This script never auto-discovers projects.");
  }
  if (apply && dryRunExplicit) {
    throw new Error(
      "both --apply and --dry-run were given; pass exactly one so the intended mode is unambiguous"
    );
  }

  return { projectId, probeResultId, resolverVersion, apply };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const db = getDb();

  console.log(options.apply ? "MODE: --apply (writes will be performed)" : "MODE: --dry-run (no writes)");

  const report = await runEntityObservationBackfill(db, options);
  console.log(
    `project ${report.projectId}, resolver_version ${report.resolverVersion}: ${report.outcomes.length} probe_result(s) targeted`
  );
  for (const outcome of report.outcomes) {
    console.log(`  ${outcome.probeResultId}:`, outcome);
  }
  const counts: Record<string, number> = {};
  for (const outcome of report.outcomes) {
    counts[outcome.action] = (counts[outcome.action] ?? 0) + 1;
  }
  console.log("summary:", counts);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
