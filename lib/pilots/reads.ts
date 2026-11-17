/**
 * D-054 — reads that feed the founder's pilot pages and the pilot Run and
 * Retry routes.
 *
 * Service-role client, so callers must have passed the founder guard. These
 * reads return question text to founder pages only; nothing here is logged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PilotSummary {
  id: string;
  projectId: string;
  companyName: string;
  normalizedDomain: string;
  status: "active" | "closed";
  questionLimit: number;
  startsOn: string;
  endsOn: string;
  createdAt: string;
  /** Live questions: a retired question does not count toward the limit. */
  questionCount: number;
}

export interface PilotDetail extends PilotSummary {
  websiteUrl: string;
  siteControlNote: string;
  closedAt: string | null;
  closeReason: string | null;
}

export interface PilotQuestionRow {
  id: string;
  ordinal: number;
  questionText: string;
  questionProvenance: string;
  customerApprovalRef: string;
  customerApprovedOn: string;
  addedAt: string;
  /** D-054 — set when the question was retired; it is then never measured again. */
  retiredAt: string | null;
  retireReason: string | null;
  /** The Perplexity baseline measurement. */
  perplexity: PilotMeasurement | null;
}

export interface PilotMeasurement {
  protocolId: string;
  jobId: string | null;
  jobStatus: string | null;
  /** Leased, but the lease has lapsed: nothing is executing. */
  stale: boolean;
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  completedRuns: number;
  failedRuns: number;
}

function summary(row: Record<string, unknown>, questionCount: number): PilotSummary {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    companyName: String(row.company_name),
    normalizedDomain: String(row.normalized_domain),
    status: row.status === "closed" ? "closed" : "active",
    questionLimit: Number(row.question_limit),
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    createdAt: String(row.created_at),
    questionCount,
  };
}

export async function listPilots(client: SupabaseClient, limit = 100): Promise<PilotSummary[]> {
  const { data, error } = await client
    .from("pilots")
    .select("id,project_id,company_name,normalized_domain,status,question_limit,starts_on,ends_on,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const { data: questions, error: qError } = await client
    .from("pilot_questions")
    .select("pilot_id")
    .in("pilot_id", rows.map((r) => String(r.id)))
    .is("retired_at", null);
  if (qError) throw qError;
  const counts = new Map<string, number>();
  for (const q of (questions ?? []) as Array<Record<string, unknown>>) {
    const id = String(q.pilot_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return rows.map((r) => summary(r, counts.get(String(r.id)) ?? 0));
}

export async function loadPilot(
  client: SupabaseClient,
  pilotId: string
): Promise<{ pilot: PilotDetail; questions: PilotQuestionRow[] } | null> {
  const { data: pilotRow, error } = await client
    .from("pilots")
    .select(
      "id,project_id,company_name,website_url,normalized_domain,site_control_note,status,question_limit,starts_on,ends_on,created_at,closed_at,close_reason"
    )
    .eq("id", pilotId)
    .maybeSingle();
  if (error) throw error;
  if (!pilotRow) return null;
  const p = pilotRow as Record<string, unknown>;

  const { data: questionRows, error: qError } = await client
    .from("pilot_questions")
    .select(
      "id,ordinal,buyer_question_version_id,question_provenance,customer_approval_ref,customer_approved_on,added_at,retired_at,retire_reason"
    )
    .eq("pilot_id", pilotId)
    .order("ordinal", { ascending: true });
  if (qError) throw qError;
  const qs = (questionRows ?? []) as Array<Record<string, unknown>>;

  const pilot: PilotDetail = {
    ...summary(p, qs.filter((q) => !q.retired_at).length),
    websiteUrl: String(p.website_url),
    siteControlNote: String(p.site_control_note),
    closedAt: p.closed_at ? String(p.closed_at) : null,
    closeReason: p.close_reason ? String(p.close_reason) : null,
  };
  if (qs.length === 0) return { pilot, questions: [] };

  const questionIds = qs.map((q) => String(q.id));
  const versionIds = qs.map((q) => String(q.buyer_question_version_id));
  const [versions, slots] = await Promise.all([
    client.from("buyer_question_versions").select("id,prompt_text").in("id", versionIds),
    client
      .from("pilot_question_protocols")
      .select("pilot_question_id,protocol_id,engine,phase")
      .in("pilot_question_id", questionIds)
      .eq("engine", "perplexity_sonar")
      .eq("phase", "baseline"),
  ]);
  if (versions.error) throw versions.error;
  if (slots.error) throw slots.error;

  const textByVersion = new Map(
    ((versions.data ?? []) as Array<Record<string, unknown>>).map((v) => [String(v.id), String(v.prompt_text)])
  );
  const protocolByQuestion = new Map(
    ((slots.data ?? []) as Array<Record<string, unknown>>).map((s) => [String(s.pilot_question_id), String(s.protocol_id)])
  );
  const protocolIds = [...protocolByQuestion.values()];

  const measurements = new Map<string, PilotMeasurement>();
  if (protocolIds.length > 0) {
    const [protocols, jobs, attempts] = await Promise.all([
      client.from("protocols").select("id,planned_baseline_runs,run_cap,spend_cap_usd").in("id", protocolIds),
      client.from("protocol_execution_jobs").select("id,protocol_id,status,lease_expires_at").in("protocol_id", protocolIds),
      client.from("protocol_attempts").select("protocol_id,status").in("protocol_id", protocolIds),
    ]);
    if (protocols.error) throw protocols.error;
    if (jobs.error) throw jobs.error;
    if (attempts.error) throw attempts.error;
    const jobByProtocol = new Map(
      ((jobs.data ?? []) as Array<Record<string, unknown>>).map((j) => [String(j.protocol_id), j])
    );
    const tally = new Map<string, { completed: number; failed: number }>();
    for (const a of (attempts.data ?? []) as Array<Record<string, unknown>>) {
      const t = tally.get(String(a.protocol_id)) ?? { completed: 0, failed: 0 };
      if (a.status === "completed") t.completed += 1;
      else if (a.status === "failed") t.failed += 1;
      tally.set(String(a.protocol_id), t);
    }
    for (const pr of (protocols.data ?? []) as Array<Record<string, unknown>>) {
      const id = String(pr.id);
      const job = jobByProtocol.get(id);
      const status = job ? String(job.status) : null;
      const lease = job?.lease_expires_at ? Date.parse(String(job.lease_expires_at)) : NaN;
      measurements.set(id, {
        protocolId: id,
        jobId: job ? String(job.id) : null,
        jobStatus: status,
        stale: (status === "claimed" || status === "running") && !Number.isNaN(lease) && lease <= Date.now(),
        plannedRuns: typeof pr.planned_baseline_runs === "number" ? pr.planned_baseline_runs : null,
        runCap: typeof pr.run_cap === "number" ? pr.run_cap : null,
        spendCapUsd: pr.spend_cap_usd === null || pr.spend_cap_usd === undefined ? null : Number(pr.spend_cap_usd),
        completedRuns: tally.get(id)?.completed ?? 0,
        failedRuns: tally.get(id)?.failed ?? 0,
      });
    }
  }

  const questions: PilotQuestionRow[] = qs.map((q) => {
    const protocolId = protocolByQuestion.get(String(q.id));
    return {
      id: String(q.id),
      ordinal: Number(q.ordinal),
      questionText: textByVersion.get(String(q.buyer_question_version_id)) ?? "",
      questionProvenance: String(q.question_provenance),
      customerApprovalRef: String(q.customer_approval_ref),
      customerApprovedOn: String(q.customer_approved_on),
      addedAt: String(q.added_at),
      retiredAt: q.retired_at ? String(q.retired_at) : null,
      retireReason: q.retire_reason ? String(q.retire_reason) : null,
      perplexity: protocolId ? measurements.get(protocolId) ?? null : null,
    };
  });
  return { pilot, questions };
}

/** The pilot state a Run or Retry needs, or null when the question is not this pilot's. */
export interface PilotQuestionTarget {
  pilotStatus: "active" | "closed";
  startsOn: string;
  endsOn: string;
  /** D-054 — a retired question is never run or retried again. */
  retired: boolean;
  protocolId: string;
  job: {
    id: string;
    projectId: string;
    status: string;
    leaseExpiresAt: string | null;
    nextBaselineOrdinal: number;
  } | null;
  plannedRuns: number | null;
}

export async function resolvePilotQuestionTarget(
  client: SupabaseClient,
  pilotId: string,
  pilotQuestionId: string
): Promise<PilotQuestionTarget | null> {
  const { data: pilotRow, error } = await client
    .from("pilots")
    .select("id,status,starts_on,ends_on")
    .eq("id", pilotId)
    .maybeSingle();
  if (error) throw error;
  if (!pilotRow) return null;

  const { data: questionRow, error: qError } = await client
    .from("pilot_questions")
    .select("id,pilot_id,retired_at")
    .eq("id", pilotQuestionId)
    .eq("pilot_id", pilotId)
    .maybeSingle();
  if (qError) throw qError;
  if (!questionRow) return null;

  const { data: slot, error: sError } = await client
    .from("pilot_question_protocols")
    .select("protocol_id")
    .eq("pilot_question_id", pilotQuestionId)
    .eq("engine", "perplexity_sonar")
    .eq("phase", "baseline")
    .maybeSingle();
  if (sError) throw sError;
  if (!slot) return null;
  const protocolId = String((slot as Record<string, unknown>).protocol_id);

  const [{ data: jobRow, error: jError }, { data: protocolRow, error: pError }] = await Promise.all([
    client
      .from("protocol_execution_jobs")
      .select("id,project_id,status,lease_expires_at,next_baseline_ordinal")
      .eq("protocol_id", protocolId)
      .maybeSingle(),
    client.from("protocols").select("planned_baseline_runs").eq("id", protocolId).maybeSingle(),
  ]);
  if (jError) throw jError;
  if (pError) throw pError;
  const j = jobRow as Record<string, unknown> | null;
  const p = pilotRow as Record<string, unknown>;
  const planned = (protocolRow as Record<string, unknown> | null)?.planned_baseline_runs;
  return {
    pilotStatus: p.status === "closed" ? "closed" : "active",
    startsOn: String(p.starts_on),
    endsOn: String(p.ends_on),
    retired: Boolean((questionRow as Record<string, unknown>).retired_at),
    protocolId,
    job: j
      ? {
          id: String(j.id),
          projectId: String(j.project_id),
          status: String(j.status),
          leaseExpiresAt: j.lease_expires_at ? String(j.lease_expires_at) : null,
          nextBaselineOrdinal: Number(j.next_baseline_ordinal),
        }
      : null,
    plannedRuns: typeof planned === "number" ? planned : null,
  };
}

/** Every protocol a pilot measures, so other founder lists can leave them out. */
export async function pilotProtocolIds(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client.from("pilot_question_protocols").select("protocol_id");
  if (error) throw error;
  return new Set(((data ?? []) as Array<Record<string, unknown>>).map((r) => String(r.protocol_id)));
}

/** True when a pilot no longer measures: closed, or past its end date. */
export function pilotIsOver(status: "active" | "closed", endsOn: string, today: string): boolean {
  return status !== "active" || today > endsOn;
}

/** D-054 — true before a pilot's start date: its questions cannot be run yet. */
export function pilotNotStarted(startsOn: string, today: string): boolean {
  return today < startsOn;
}
