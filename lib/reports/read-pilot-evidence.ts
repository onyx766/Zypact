/**
 * D-055 — reads everything the combined pilot report is built from: the
 * pilot, its project (the brand the worker measured against), every pilot
 * question including retired ones, each question's engine slots (both
 * engines), each slot's job status, each slot's recorded setting (D-061),
 * and each slot's protocol evidence through the same reader a one-question
 * report uses.
 *
 * Reads only. Identity comes from the pilot's own tables, never from the
 * caller: a protocol reaches the report only through `pilot_question_protocols`
 * for a question of this pilot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PilotReportInput, PilotReportQuestionInput } from "@/lib/reports/build-pilot-report";
import type { PilotEngineKey } from "@/lib/reports/pilot-report-types";
import { ProtocolEvidenceError, readPilotProtocolEvidence } from "@/lib/reports/read-protocol-evidence";

const ENGINES: ReadonlySet<string> = new Set<PilotEngineKey>(["perplexity_sonar", "openai_chatgpt"]);

export async function readPilotReportInput(
  client: SupabaseClient,
  pilotId: string
): Promise<PilotReportInput | null> {
  const { data: pilotRow, error } = await client
    .from("pilots")
    .select("id,project_id,company_name,website_url,normalized_domain,starts_on,ends_on,status")
    .eq("id", pilotId)
    .maybeSingle();
  if (error) throw error;
  if (!pilotRow) return null;
  const p = pilotRow as Record<string, unknown>;
  const projectId = String(p.project_id);

  const { data: projectRow, error: projectError } = await client
    .from("projects")
    .select("id,company_name,domain")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!projectRow) throw new ProtocolEvidenceError(`Project ${projectId} of pilot ${pilotId} was not found.`);
  const proj = projectRow as Record<string, unknown>;
  // The worker sends project.company_name (or the domain) as the brand; the
  // report looks for the same brand. The builder flags a difference from the
  // pilot's own company name for review.
  const measuredBrand =
    typeof proj.company_name === "string" && proj.company_name.trim() ? proj.company_name.trim() : String(proj.domain ?? "");

  const { data: questionRows, error: qError } = await client
    .from("pilot_questions")
    .select("id,pilot_id,project_id,ordinal,question_provenance,customer_approved_on,retired_at")
    .eq("pilot_id", pilotId)
    .order("ordinal", { ascending: true });
  if (qError) throw qError;
  const qs = (questionRows ?? []) as Array<Record<string, unknown>>;

  const questionIds = qs.map((q) => String(q.id));
  const slotRows: Array<Record<string, unknown>> = [];
  if (questionIds.length > 0) {
    const { data, error: sError } = await client
      .from("pilot_question_protocols")
      .select("pilot_question_id,project_id,engine,phase,protocol_id")
      .in("pilot_question_id", questionIds)
      .eq("phase", "baseline");
    if (sError) throw sError;
    slotRows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const protocolIds = slotRows.map((s) => String(s.protocol_id));

  // D-061 — each protocol's recorded setting (model_config.setting_version).
  // A ChatGPT protocol's names its model, search mode and service tier; a
  // Perplexity protocol records none, which is null here, never a guess.
  const settingVersion = new Map<string, string>();
  if (protocolIds.length > 0) {
    const { data, error: pError } = await client.from("protocols").select("id,model_config").in("id", protocolIds);
    if (pError) throw pError;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const config = r.model_config;
      const value =
        config && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>).setting_version
          : undefined;
      if (typeof value === "string" && value.trim()) settingVersion.set(String(r.id), value);
    }
  }

  const jobStatus = new Map<string, string>();
  if (protocolIds.length > 0) {
    const { data, error: jError } = await client
      .from("protocol_execution_jobs")
      .select("protocol_id,status")
      .in("protocol_id", protocolIds);
    if (jError) throw jError;
    for (const j of (data ?? []) as Array<Record<string, unknown>>) jobStatus.set(String(j.protocol_id), String(j.status));
  }

  // METHODOLOGY §4: when each slot's answers were collected, and how
  // (probe_runs.probe_mode), read from the attempts' own rows.
  const execution = new Map<string, { first: string | null; last: string | null }>();
  const modesByProtocol = new Map<string, Set<string>>();
  if (protocolIds.length > 0) {
    const { data: attemptRows, error: aError } = await client
      .from("protocol_attempts")
      .select("protocol_id,reserved_at,terminalized_at,probe_run_id")
      .in("protocol_id", protocolIds);
    if (aError) throw aError;
    const probeRunToProtocol = new Map<string, string>();
    for (const a of (attemptRows ?? []) as Array<Record<string, unknown>>) {
      const protocolId = String(a.protocol_id);
      const start = typeof a.reserved_at === "string" ? a.reserved_at.slice(0, 10) : null;
      const end = typeof a.terminalized_at === "string" ? a.terminalized_at.slice(0, 10) : start;
      const w = execution.get(protocolId) ?? { first: null, last: null };
      if (start && (!w.first || start < w.first)) w.first = start;
      if (end && (!w.last || end > w.last)) w.last = end;
      execution.set(protocolId, w);
      if (typeof a.probe_run_id === "string") probeRunToProtocol.set(a.probe_run_id, protocolId);
    }
    const probeRunIds = [...probeRunToProtocol.keys()];
    if (probeRunIds.length > 0) {
      const { data: runRows, error: rError } = await client
        .from("probe_runs")
        .select("id,probe_mode")
        .in("id", probeRunIds);
      if (rError) throw rError;
      for (const r of (runRows ?? []) as Array<Record<string, unknown>>) {
        const protocolId = probeRunToProtocol.get(String(r.id));
        if (!protocolId) continue;
        const set = modesByProtocol.get(protocolId) ?? new Set<string>();
        set.add(typeof r.probe_mode === "string" && r.probe_mode ? r.probe_mode : "unrecorded");
        modesByProtocol.set(protocolId, set);
      }
    }
  }

  const subject = {
    companyName: measuredBrand,
    websiteUrl: String(p.website_url),
    normalizedDomain: String(p.normalized_domain),
  };

  const questions: PilotReportQuestionInput[] = [];
  for (const q of qs) {
    if (String(q.project_id) !== projectId) {
      throw new ProtocolEvidenceError(`Pilot question ${String(q.id)} belongs to another project.`);
    }
    const slots: PilotReportQuestionInput["slots"] = [];
    for (const s of slotRows.filter((row) => String(row.pilot_question_id) === String(q.id))) {
      const engine = String(s.engine);
      if (!ENGINES.has(engine)) continue;
      const protocolId = String(s.protocol_id);
      const evidence = await readPilotProtocolEvidence(client, protocolId, projectId, subject);
      const window = execution.get(protocolId) ?? { first: null, last: null };
      slots.push({
        engine: engine as PilotEngineKey,
        protocolId,
        jobStatus: jobStatus.get(protocolId) ?? null,
        evidence,
        execution: { firstOn: window.first, lastOn: window.last },
        answerModes: [...(modesByProtocol.get(protocolId) ?? [])].sort(),
        settingVersion: settingVersion.get(protocolId) ?? null,
      });
    }
    questions.push({
      pilotQuestionId: String(q.id),
      ordinal: Number(q.ordinal),
      provenance: String(q.question_provenance),
      customerApprovedOn: String(q.customer_approved_on),
      retiredAt: q.retired_at ? String(q.retired_at) : null,
      slots,
    });
  }

  return {
    pilot: {
      id: String(p.id),
      projectId,
      companyName: String(p.company_name),
      websiteUrl: String(p.website_url),
      normalizedDomain: String(p.normalized_domain),
      startsOn: String(p.starts_on),
      endsOn: String(p.ends_on),
      status: p.status === "closed" ? "closed" : "active",
    },
    questions,
  };
}

/**
 * D-055 — whether any of the pilot's measurements is still running: a job of
 * one of its protocols, or of a retest of one, holding a live lease or a
 * pending run request, or an attempt still reserved or in progress. A report
 * built then would read answers that are still being written, so the build
 * is refused; save_pilot_report_artifact refuses it again in the database.
 */
export async function pilotMeasurementInProgress(client: SupabaseClient, pilotId: string): Promise<boolean> {
  const { data: qRows, error: qError } = await client.from("pilot_questions").select("id").eq("pilot_id", pilotId);
  if (qError) throw qError;
  const questionIds = ((qRows ?? []) as Array<Record<string, unknown>>).map((q) => String(q.id));
  if (questionIds.length === 0) return false;

  const { data: slotRows, error: sError } = await client
    .from("pilot_question_protocols")
    .select("protocol_id")
    .in("pilot_question_id", questionIds);
  if (sError) throw sError;
  const baseIds = ((slotRows ?? []) as Array<Record<string, unknown>>).map((r) => String(r.protocol_id));
  if (baseIds.length === 0) return false;

  const { data: retestRows, error: rError } = await client.from("protocols").select("id").in("baseline_protocol_id", baseIds);
  if (rError) throw rError;
  const protocolIds = [...baseIds, ...((retestRows ?? []) as Array<Record<string, unknown>>).map((r) => String(r.id))];

  const { data: attempts, error: aError } = await client
    .from("protocol_attempts")
    .select("id")
    .in("protocol_id", protocolIds)
    .in("status", ["reserved", "in_progress"])
    .limit(1);
  if (aError) throw aError;
  if ((attempts ?? []).length > 0) return true;

  const nowIso = new Date().toISOString();
  const { data: jobs, error: jError } = await client
    .from("protocol_execution_jobs")
    .select("id,status,lease_expires_at")
    .in("protocol_id", protocolIds);
  if (jError) throw jError;
  const jobRows = (jobs ?? []) as Array<Record<string, unknown>>;
  if (
    jobRows.some(
      (j) =>
        (j.status === "claimed" || j.status === "running") &&
        typeof j.lease_expires_at === "string" &&
        Date.parse(j.lease_expires_at) > Date.now()
    )
  ) {
    return true;
  }
  const jobIds = jobRows.map((j) => String(j.id));
  if (jobIds.length === 0) return false;
  const { data: requests, error: reqError } = await client
    .from("protocol_job_run_requests")
    .select("id")
    .in("job_id", jobIds)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .limit(1);
  if (reqError) throw reqError;
  return (requests ?? []).length > 0;
}
