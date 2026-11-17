/**
 * D-055 — builds, checks and saves one revision of a pilot's combined
 * report, and shares a revision once the founder has reviewed it.
 *
 * No model call, no provider call, no email. The database re-checks that
 * every protocol and attempt in the manifest belongs to the pilot, that
 * every stored hash matches, and that no attempt of a pilot protocol was
 * left out, before it stores anything (save_pilot_report_artifact).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ReportIntegrityStatus } from "@/lib/export/report-integrity";
import { readReportableActions } from "@/lib/pilots/action-store";
import { buildPilotReport } from "@/lib/reports/build-pilot-report";
import { evaluatePilotReportIntegrity, type PilotQuestionSignals } from "@/lib/reports/pilot-report-integrity";
import { presentationStrings, presentPilotReport } from "@/lib/reports/pilot-report-presentation";
import { readIntegritySignals } from "@/lib/reports/protocol-integrity-signals";
import { readPilotReportInput } from "@/lib/reports/read-pilot-evidence";
import { ProtocolEvidenceError } from "@/lib/reports/read-protocol-evidence";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";

export type SavePilotReportOutcome =
  | "SAVED"
  | "PILOT_NOT_FOUND"
  | "EVIDENCE_OUTSIDE_PILOT"
  | "EVIDENCE_MISMATCH"
  | "EVIDENCE_INCOMPLETE"
  | "MEASUREMENT_IN_PROGRESS"
  | "ACTION_NOT_REVIEWED"
  | "ACTIONS_INCOMPLETE"
  | "ACTIONS_CONTENT_MISMATCH";

export interface BuildPilotReportResult {
  outcome: SavePilotReportOutcome;
  artifactId: string | null;
  revision: number | null;
  integrityStatus: ReportIntegrityStatus | null;
  integrityReasons: string[];
}

export async function buildAndSavePilotReport(
  client: SupabaseClient,
  pilotId: string,
  createdBy: string,
  now: () => Date = () => new Date()
): Promise<BuildPilotReportResult> {
  let input: Awaited<ReturnType<typeof readPilotReportInput>>;
  try {
    input = await readPilotReportInput(client, pilotId);
  } catch (error) {
    // The reader refuses a protocol or question outside the pilot's project
    // before any of its evidence is read; nothing is built or saved.
    if (error instanceof ProtocolEvidenceError) {
      return { outcome: "EVIDENCE_OUTSIDE_PILOT", artifactId: null, revision: null, integrityStatus: null, integrityReasons: [] };
    }
    throw error;
  }
  if (!input) return { outcome: "PILOT_NOT_FOUND", artifactId: null, revision: null, integrityStatus: null, integrityReasons: [] };

  // D-057 — each action's latest reviewed version; the builder re-checks
  // every link and the database refuses any other version at save.
  const actions = await readReportableActions(client, pilotId);
  const built = buildPilotReport({ ...input, actions, now: now() });
  const markdown = renderPilotReportMarkdown(built.payload);
  // Every string the client page renders, from the same presentation model.
  const pageText = presentationStrings(presentPilotReport(built.payload));

  const questionSignals: PilotQuestionSignals[] = [];
  for (const q of built.payload.questions) {
    for (const m of q.measurements) {
      questionSignals.push({
        ordinal: q.ordinal,
        engine: m.engine,
        retired: q.retired,
        completedAttempts: m.counts.completed,
        signals: await readIntegritySignals(client, m.report),
      });
    }
  }
  const integrity = evaluatePilotReportIntegrity({ markdown, pageText, structural: built.structural, questionSignals });

  const { data, error } = await client.rpc("save_pilot_report_artifact", {
    p_pilot_id: pilotId,
    p_created_by: createdBy,
    p_markdown: markdown,
    p_payload: built.payload,
    p_manifest: built.manifest,
    p_integrity_status: integrity.status,
    p_integrity_reasons: integrity.reasons,
    p_generated_at: built.payload.generatedAt,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const outcome = String(row?.outcome ?? "") as SavePilotReportOutcome;
  return {
    outcome,
    artifactId: row?.artifact_id ? String(row.artifact_id) : null,
    revision: typeof row?.revision === "number" ? row.revision : null,
    integrityStatus: outcome === "SAVED" ? integrity.status : null,
    integrityReasons: outcome === "SAVED" ? integrity.reasons : [],
  };
}

export type SharePilotReportOutcome =
  | "SHARED"
  | "ALREADY_SHARED"
  | "NOT_FOUND"
  | "BLOCKED"
  | "ACKNOWLEDGEMENT_REQUIRED"
  | "NOT_LATEST"
  // D-057 — an action changed since the revision was built.
  | "ACTIONS_STALE";

export async function sharePilotReport(
  client: SupabaseClient,
  input: { pilotId: string; artifactId: string; sharedBy: string; acknowledgeNeedsReview: boolean }
): Promise<{ outcome: SharePilotReportOutcome; publicToken: string | null }> {
  const { data, error } = await client.rpc("share_pilot_report_artifact", {
    p_artifact_id: input.artifactId,
    p_pilot_id: input.pilotId,
    p_shared_by: input.sharedBy,
    p_acknowledge_needs_review: input.acknowledgeNeedsReview,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    outcome: String(row?.outcome ?? "") as SharePilotReportOutcome,
    publicToken: row?.public_token ? String(row.public_token) : null,
  };
}

export interface PilotReportRevisionRow {
  id: string;
  revision: number;
  generatedAt: string;
  integrityStatus: ReportIntegrityStatus;
  integrityReasons: string[];
  sharedAt: string | null;
  publicToken: string | null;
  /** D-057 — the action versions the revision lists (its manifest), to tell a stale revision. */
  actionVersionIds: string[];
}

/** The action versions a stored manifest lists; none when it has no list (revisions before D-057). */
export function manifestActionVersionIds(manifest: unknown): string[] {
  const list = manifest && typeof manifest === "object" ? (manifest as { actionVersions?: unknown }).actionVersions : undefined;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/** The founder's list of a pilot's report revisions, newest first. The link is shown only once shared. */
export async function listPilotReportRevisions(
  client: SupabaseClient,
  pilotId: string,
  limit = 10
): Promise<PilotReportRevisionRow[]> {
  const { data, error } = await client
    .from("pilot_report_artifacts")
    .select("id,revision,generated_at,integrity_status,integrity_reasons,shared_at,public_token,manifest")
    .eq("pilot_id", pilotId)
    .order("revision", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    revision: Number(r.revision),
    generatedAt: String(r.generated_at),
    integrityStatus: String(r.integrity_status) as ReportIntegrityStatus,
    integrityReasons: Array.isArray(r.integrity_reasons) ? r.integrity_reasons.map(String) : [],
    sharedAt: r.shared_at ? String(r.shared_at) : null,
    publicToken: r.shared_at && r.public_token ? String(r.public_token) : null,
    actionVersionIds: manifestActionVersionIds(r.manifest),
  }));
}

export interface SharedPilotReport {
  payload: unknown;
  revision: number;
  generatedAt: string;
  sharedAt: string;
  newerSharedRevision: boolean;
}

/** The client read: only a shared revision, never a blocked one (read_shared_pilot_report). */
export async function readSharedPilotReport(
  client: SupabaseClient,
  publicToken: string
): Promise<SharedPilotReport | null> {
  const { data, error } = await client.rpc("read_shared_pilot_report", { p_public_token: publicToken });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row || row.payload === null || row.payload === undefined) return null;
  return {
    payload: row.payload,
    revision: Number(row.revision),
    generatedAt: String(row.generated_at),
    sharedAt: String(row.shared_at),
    newerSharedRevision: row.newer_shared_revision === true,
  };
}

export interface PilotReportRevision {
  id: string;
  revision: number;
  payload: unknown;
  generatedAt: string;
  integrityStatus: ReportIntegrityStatus;
  integrityReasons: string[];
  sharedAt: string | null;
  isLatest: boolean;
  /** D-057 — the action versions the revision lists, to tell a stale revision. */
  actionVersionIds: string[];
}

/**
 * The founder's preview read: one saved revision of this pilot, shared or
 * not, blocked included, by its id. The stored payload is the one the
 * customer page renders once the revision is shared, so the founder reviews
 * exactly what the customer will see. Used only behind the founder guard.
 */
export async function readPilotReportRevision(
  client: SupabaseClient,
  pilotId: string,
  artifactId: string
): Promise<PilotReportRevision | null> {
  const { data, error } = await client
    .from("pilot_report_artifacts")
    .select("id,revision,payload,generated_at,integrity_status,integrity_reasons,shared_at,manifest")
    .eq("id", artifactId)
    .eq("pilot_id", pilotId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const { data: newer, error: newerError } = await client
    .from("pilot_report_artifacts")
    .select("id")
    .eq("pilot_id", pilotId)
    .gt("revision", Number(r.revision))
    .limit(1);
  if (newerError) throw newerError;
  return {
    id: String(r.id),
    revision: Number(r.revision),
    payload: r.payload,
    generatedAt: String(r.generated_at),
    integrityStatus: String(r.integrity_status) as ReportIntegrityStatus,
    integrityReasons: Array.isArray(r.integrity_reasons) ? r.integrity_reasons.map(String) : [],
    sharedAt: r.shared_at ? String(r.shared_at) : null,
    isLatest: (newer ?? []).length === 0,
    actionVersionIds: manifestActionVersionIds(r.manifest),
  };
}
