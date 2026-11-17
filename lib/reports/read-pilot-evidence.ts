/**
 * D-055 — reads everything the combined pilot report is built from: the
 * pilot, its project (the brand the worker measured against), every pilot
 * question including retired ones, each question's engine slots, each
 * slot's job status, and each slot's protocol evidence through the same
 * reader a one-question report uses.
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
  const jobStatus = new Map<string, string>();
  if (protocolIds.length > 0) {
    const { data, error: jError } = await client
      .from("protocol_execution_jobs")
      .select("protocol_id,status")
      .in("protocol_id", protocolIds);
    if (jError) throw jError;
    for (const j of (data ?? []) as Array<Record<string, unknown>>) jobStatus.set(String(j.protocol_id), String(j.status));
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
      slots.push({ engine: engine as PilotEngineKey, protocolId, jobStatus: jobStatus.get(protocolId) ?? null, evidence });
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
