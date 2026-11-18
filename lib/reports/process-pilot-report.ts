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
        attempts: m.counts.attempted,
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
  /** The link, only for a shared revision whose link still opens: the newest shared one (D-060). */
  publicToken: string | null;
  /**
   * D-060 — shared, and a later revision of the pilot has been shared since,
   * so its link no longer opens (D-059 item 9, read_shared_pilot_report).
   */
  replaced: boolean;
  /**
   * D-060 — the newest shared revision, read beside the newest revisions
   * because none of them is shared; it is listed last, after them.
   */
  olderThanListed: boolean;
  /** D-057 — the action versions the revision lists (its manifest), to tell a stale revision. */
  actionVersionIds: string[];
}

/** The action versions a stored manifest lists; none when it has no list (revisions before D-057). */
export function manifestActionVersionIds(manifest: unknown): string[] {
  const list = manifest && typeof manifest === "object" ? (manifest as { actionVersions?: unknown }).actionVersions : undefined;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The founder's list of a pilot's report revisions, newest first. The link
 * is shown only once shared, and only while it still opens (D-060): a shared
 * revision with a later shared revision is marked replaced and carries no
 * link. The list holds the newest revisions, so every revision shared after
 * a listed one is listed too, and "replaced" is exact for every row.
 *
 * D-060 — only the newest shared revision's link opens, so the page must
 * always show it. When none of the newest `limit` revisions is shared, it is
 * older than all of them; one more bounded read finds it, and it is listed
 * last, marked `olderThanListed`.
 */
export async function listPilotReportRevisions(
  client: SupabaseClient,
  pilotId: string,
  limit = 10
): Promise<PilotReportRevisionRow[]> {
  const columns = "id,revision,generated_at,integrity_status,integrity_reasons,shared_at,public_token,manifest";
  const { data, error } = await client
    .from("pilot_report_artifacts")
    .select(columns)
    .eq("pilot_id", pilotId)
    .order("revision", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  let olderShared: Record<string, unknown> | null = null;
  if (rows.length >= limit && !rows.some((r) => r.shared_at)) {
    const { data: shared, error: sharedError } = await client
      .from("pilot_report_artifacts")
      .select(columns)
      .eq("pilot_id", pilotId)
      .not("shared_at", "is", null)
      .order("revision", { ascending: false })
      .limit(1);
    if (sharedError) throw sharedError;
    olderShared = ((shared ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  }
  const listed = olderShared ? [...rows, olderShared] : rows;
  const sharedRevisions = listed.filter((r) => r.shared_at).map((r) => Number(r.revision));
  const newestShared = sharedRevisions.length > 0 ? Math.max(...sharedRevisions) : null;
  return listed.map((r) => {
    const replaced = Boolean(r.shared_at) && newestShared !== null && Number(r.revision) < newestShared;
    return {
      id: String(r.id),
      revision: Number(r.revision),
      generatedAt: String(r.generated_at),
      integrityStatus: String(r.integrity_status) as ReportIntegrityStatus,
      integrityReasons: Array.isArray(r.integrity_reasons) ? r.integrity_reasons.map(String) : [],
      sharedAt: r.shared_at ? String(r.shared_at) : null,
      publicToken: r.shared_at && r.public_token && !replaced ? String(r.public_token) : null,
      replaced,
      olderThanListed: r === olderShared,
      actionVersionIds: manifestActionVersionIds(r.manifest),
    };
  });
}

/**
 * D-060 — what a customer's link reads (read_shared_pilot_report):
 *   - `current`: the newest shared revision of its pilot, with its payload;
 *   - `replaced`: a later revision of the same pilot has been shared since,
 *     so this link no longer opens the report (D-059 item 9). It carries
 *     nothing of the report: no payload, revision, date or token;
 *   - `not_found`: no shared, non-blocked revision has this token.
 */
export type SharedPilotReportRead =
  | { state: "current"; payload: unknown; revision: number; generatedAt: string; sharedAt: string }
  | { state: "replaced" }
  | { state: "not_found" };

/**
 * The client read: only a shared revision, never a blocked one, and only the
 * newest shared one in full (read_shared_pilot_report, 20261109170000).
 *
 * The flag is read before the payload: a revision with a later shared one is
 * `replaced` even when a payload comes back with it, as it would if the
 * database function were rolled back to 20261109150000's, which still
 * returned it. Anything the function does not promise (no flag, or no
 * payload without the flag) fails closed as `not_found`.
 */
export async function readSharedPilotReport(
  client: SupabaseClient,
  publicToken: string
): Promise<SharedPilotReportRead> {
  const { data, error } = await client.rpc("read_shared_pilot_report", { p_public_token: publicToken });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return { state: "not_found" };
  if (row.newer_shared_revision === true) return { state: "replaced" };
  if (row.newer_shared_revision !== false || row.payload === null || row.payload === undefined) return { state: "not_found" };
  return {
    state: "current",
    payload: row.payload,
    revision: Number(row.revision),
    generatedAt: String(row.generated_at),
    sharedAt: String(row.shared_at),
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
  /** D-060 — shared, and a later revision has been shared since: its link no longer opens. */
  replaced: boolean;
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
  const isLatest = (newer ?? []).length === 0;
  // D-060 — a shared revision is replaced once any later revision is shared.
  let replaced = false;
  if (r.shared_at && !isLatest) {
    const { data: newerShared, error: newerSharedError } = await client
      .from("pilot_report_artifacts")
      .select("id")
      .eq("pilot_id", pilotId)
      .gt("revision", Number(r.revision))
      .not("shared_at", "is", null)
      .limit(1);
    if (newerSharedError) throw newerSharedError;
    replaced = (newerShared ?? []).length > 0;
  }
  return {
    id: String(r.id),
    revision: Number(r.revision),
    payload: r.payload,
    generatedAt: String(r.generated_at),
    integrityStatus: String(r.integrity_status) as ReportIntegrityStatus,
    integrityReasons: Array.isArray(r.integrity_reasons) ? r.integrity_reasons.map(String) : [],
    sharedAt: r.shared_at ? String(r.shared_at) : null,
    isLatest,
    replaced,
    actionVersionIds: manifestActionVersionIds(r.manifest),
  };
}
