/**
 * Reads that feed the founder intervention screens: which baselines an
 * intervention can be registered against, and which of their runs can be
 * cited as supporting evidence.
 *
 * Service-role client, so callers must have passed `requireFounderForPage`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One citable run. `attemptId` is what gets stored in
 * `interventions.supporting_evidence`: it is the attempt's durable identity,
 * and it traces through `probe_run_id` to the stored raw response. The
 * ordinal is the "Run N" the protocol report shows, so the founder can match
 * a citation to the report they are reading.
 */
export interface CitableRun {
  attemptId: string;
  ordinal: number | null;
  brandPresent: boolean | null;
  position: string | null;
  summary: string | null;
}

export interface RegistrableBaseline {
  protocolId: string;
  projectId: string;
  companyName: string | null;
  domain: string | null;
  promptText: string | null;
  status: string;
  approvedAt: string | null;
  /** A live intervention already holds this baseline's one slot. */
  hasLiveIntervention: boolean;
  /**
   * Completed baseline attempts that produced a readable result. Only these
   * are offered: a failed attempt observed nothing, so citing it would make
   * the intervention look evidence-backed when it is not.
   */
  runs: CitableRun[];
}

const SUMMARY_LIMIT = 180;

function truncate(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const t = text.trim();
  return t.length > SUMMARY_LIMIT ? `${t.slice(0, SUMMARY_LIMIT - 1)}…` : t;
}

/**
 * Baselines an intervention may be registered against: `baseline_protocol_id`
 * null (0078) and status approved/active/completed (0071). Newest first.
 */
export async function listRegistrableBaselines(
  client: SupabaseClient,
  limit = 50
): Promise<RegistrableBaseline[]> {
  const { data: protocols, error } = await client
    .from("protocols")
    .select("id,project_id,buyer_question_version_id,status,approved_at")
    .is("baseline_protocol_id", null)
    .in("status", ["approved", "active", "completed"])
    .order("approved_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (protocols ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  const protocolIds = rows.map((r) => String(r.id));
  const projectIds = [...new Set(rows.map((r) => String(r.project_id)))];
  const versionIds = [...new Set(rows.map((r) => String(r.buyer_question_version_id)))];

  const [projects, versions, live, attempts] = await Promise.all([
    client.from("projects").select("id,company_name,domain").in("id", projectIds),
    client.from("buyer_question_versions").select("id,prompt_text").in("id", versionIds),
    client
      .from("interventions")
      .select("protocol_id")
      .in("protocol_id", protocolIds)
      .in("status", ["proposed", "approved", "implemented"]),
    client
      .from("protocol_attempts")
      .select("id,protocol_id,baseline_ordinal,probe_run_id")
      .in("protocol_id", protocolIds)
      .eq("attempt_kind", "baseline")
      .eq("status", "completed"),
  ]);
  for (const r of [projects, versions, live, attempts]) if (r.error) throw r.error;

  const attemptRows = (attempts.data ?? []) as Array<Record<string, unknown>>;
  const probeRunIds = attemptRows
    .map((a) => a.probe_run_id)
    .filter((id): id is string => typeof id === "string");

  const results = new Map<string, Record<string, unknown>>();
  if (probeRunIds.length > 0) {
    const { data, error: rErr } = await client
      .from("probe_results")
      .select("probe_run_id,client_mentioned,client_position,answer_summary")
      .in("probe_run_id", probeRunIds);
    if (rErr) throw rErr;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      results.set(String(r.probe_run_id), r);
    }
  }

  const projectById = new Map(
    ((projects.data ?? []) as Array<Record<string, unknown>>).map((p) => [String(p.id), p])
  );
  const promptById = new Map(
    ((versions.data ?? []) as Array<Record<string, unknown>>).map((v) => [String(v.id), v.prompt_text])
  );
  const liveProtocols = new Set(
    ((live.data ?? []) as Array<Record<string, unknown>>).map((l) => String(l.protocol_id))
  );

  return rows.map((r) => {
    const id = String(r.id);
    const project = projectById.get(String(r.project_id));
    const runs: CitableRun[] = attemptRows
      .filter((a) => a.protocol_id === id)
      .map((a) => {
        const result = typeof a.probe_run_id === "string" ? results.get(a.probe_run_id) : undefined;
        return {
          attemptId: String(a.id),
          ordinal: typeof a.baseline_ordinal === "number" ? a.baseline_ordinal : null,
          brandPresent: typeof result?.client_mentioned === "boolean" ? result.client_mentioned : null,
          position: typeof result?.client_position === "string" ? result.client_position : null,
          summary: truncate(result?.answer_summary),
        };
      })
      // A completed attempt with no stored result produced nothing readable.
      .filter((run) => run.brandPresent !== null || run.summary !== null)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

    return {
      protocolId: id,
      projectId: String(r.project_id),
      companyName: typeof project?.company_name === "string" ? project.company_name : null,
      domain: typeof project?.domain === "string" ? project.domain : null,
      promptText: typeof promptById.get(String(r.buyer_question_version_id)) === "string"
        ? (promptById.get(String(r.buyer_question_version_id)) as string)
        : null,
      status: String(r.status),
      approvedAt: typeof r.approved_at === "string" ? r.approved_at : null,
      hasLiveIntervention: liveProtocols.has(id),
      runs,
    };
  });
}

/** Resolve cited attempt ids back to their run cards, for the detail page. */
export async function readCitedRuns(
  client: SupabaseClient,
  attemptIds: string[]
): Promise<CitableRun[]> {
  if (attemptIds.length === 0) return [];
  const { data: attempts, error } = await client
    .from("protocol_attempts")
    .select("id,baseline_ordinal,probe_run_id")
    .in("id", attemptIds);
  if (error) throw error;
  const rows = (attempts ?? []) as Array<Record<string, unknown>>;

  const probeRunIds = rows.map((a) => a.probe_run_id).filter((id): id is string => typeof id === "string");
  const results = new Map<string, Record<string, unknown>>();
  if (probeRunIds.length > 0) {
    const { data, error: rErr } = await client
      .from("probe_results")
      .select("probe_run_id,client_mentioned,client_position,answer_summary")
      .in("probe_run_id", probeRunIds);
    if (rErr) throw rErr;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) results.set(String(r.probe_run_id), r);
  }

  const byId = new Map(rows.map((a) => [String(a.id), a]));
  // Preserve the cited order, and keep ids that no longer resolve visible
  // rather than dropping them — a citation that points at nothing is a fact
  // the founder should see.
  return attemptIds.map((id) => {
    const a = byId.get(id);
    const result = a && typeof a.probe_run_id === "string" ? results.get(a.probe_run_id) : undefined;
    return {
      attemptId: id,
      ordinal: a && typeof a.baseline_ordinal === "number" ? a.baseline_ordinal : null,
      brandPresent: typeof result?.client_mentioned === "boolean" ? result.client_mentioned : null,
      position: typeof result?.client_position === "string" ? result.client_position : null,
      summary: truncate(result?.answer_summary),
    };
  });
}

/** The baseline's question text and company, for the detail page header. */
export async function readBaselineContext(
  client: SupabaseClient,
  protocolId: string
): Promise<{ promptText: string | null; companyName: string | null; domain: string | null; plannedRuns: number | null }> {
  const { data: p, error } = await client
    .from("protocols")
    .select("project_id,buyer_question_version_id,planned_baseline_runs")
    .eq("id", protocolId)
    .maybeSingle();
  if (error) throw error;
  if (!p) return { promptText: null, companyName: null, domain: null, plannedRuns: null };
  const row = p as Record<string, unknown>;

  const [v, proj] = await Promise.all([
    client.from("buyer_question_versions").select("prompt_text").eq("id", String(row.buyer_question_version_id)).maybeSingle(),
    client.from("projects").select("company_name,domain").eq("id", String(row.project_id)).maybeSingle(),
  ]);
  const version = (v.data ?? null) as Record<string, unknown> | null;
  const project = (proj.data ?? null) as Record<string, unknown> | null;
  return {
    promptText: typeof version?.prompt_text === "string" ? version.prompt_text : null,
    companyName: typeof project?.company_name === "string" ? project.company_name : null,
    domain: typeof project?.domain === "string" ? project.domain : null,
    plannedRuns: typeof row.planned_baseline_runs === "number" ? row.planned_baseline_runs : null,
  };
}
