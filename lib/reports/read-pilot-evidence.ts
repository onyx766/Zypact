/**
 * D-055 — reads everything the combined pilot report is built from: the
 * pilot, its project (the brand the worker measured against), every pilot
 * question including retired ones, each question's engine slots (both
 * engines), each slot's job status and review resolution, each slot's
 * recorded setting (D-061), and each slot's protocol evidence through the
 * same reader a one-question report uses.
 *
 * Reads only. Identity comes from the pilot's own tables, never from the
 * caller: a protocol reaches the report only through `pilot_question_protocols`
 * for a question of this pilot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PilotReportInput, PilotReportQuestionInput } from "@/lib/reports/build-pilot-report";
import type {
  PilotRetestGroupInput,
  PilotRetestMemberInput,
  PilotRetestsInput,
  PilotRetestSlotInput,
} from "@/lib/reports/build-pilot-retests";
import { evaluateMeasurementCompatibility, readPhaseMeasurement } from "@/lib/reports/measurement-fingerprint";
import type { PilotEngineKey, PilotPurpose, PilotRetestText } from "@/lib/reports/pilot-report-types";
import type { BuildProtocolReportInput } from "@/lib/reports/protocol-report-types";
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
  const purpose = await readPilotPurpose(client, pilotId);

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
  // D-061 (review of phase B) — how a review ended the job, if one did: a
  // measurement a review ended is never read as finished.
  const reviewResolution = new Map<string, string>();
  if (protocolIds.length > 0) {
    const { data, error: jError } = await client
      .from("protocol_execution_jobs")
      .select("protocol_id,status,review_resolution")
      .in("protocol_id", protocolIds);
    if (jError) throw jError;
    for (const j of (data ?? []) as Array<Record<string, unknown>>) {
      jobStatus.set(String(j.protocol_id), String(j.status));
      if (typeof j.review_resolution === "string" && j.review_resolution) {
        reviewResolution.set(String(j.protocol_id), j.review_resolution);
      }
    }
  }

  // METHODOLOGY §4: when each slot's answers were collected, and how
  // (probe_runs.probe_mode), read from the attempts' own rows.
  const execution = new Map<string, { first: string | null; last: string | null }>();
  const modesByProtocol = new Map<string, Set<string>>();
  // D-062 (M6b, M17) — each baseline slot's latest reservation, as an instant.
  const latestReserved: Record<string, string | null> = {};
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
      if (typeof a.reserved_at === "string" && (!latestReserved[protocolId] || Date.parse(a.reserved_at) > Date.parse(latestReserved[protocolId]!))) {
        latestReserved[protocolId] = a.reserved_at;
      }
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
        reviewResolution: reviewResolution.get(protocolId) ?? null,
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

  // D-062 — the registered changes, their members and retest slots.
  const retests = await readPilotRetestsInput(client, {
    pilotId,
    projectId,
    subject,
    questionIds,
    baselineSlots: slotRows.map((r) => ({ protocolId: String(r.protocol_id) })),
    latestReserved,
  });

  return {
    retests,
    pilot: {
      id: String(p.id),
      projectId,
      companyName: String(p.company_name),
      websiteUrl: String(p.website_url),
      normalizedDomain: String(p.normalized_domain),
      startsOn: String(p.starts_on),
      endsOn: String(p.ends_on),
      status: p.status === "closed" ? "closed" : "active",
      purpose,
    },
    questions,
  };
}

/**
 * pilots.purpose (20261109200000), read on its own so that a database
 * without that migration still builds the report: the purpose is then null,
 * the report says nothing about a practice run and is held for review
 * (build-pilot-report.ts), never labelled by guess.
 */
export async function readPilotPurpose(client: SupabaseClient, pilotId: string): Promise<PilotPurpose | null> {
  const { data, error } = await client.from("pilots").select("purpose").eq("id", pilotId).maybeSingle();
  if (error || !data) return null;
  const value = (data as Record<string, unknown>).purpose;
  return value === "customer" || value === "internal_practice" ? value : null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/**
 * D-062 — what the report needs of the pilot's registered changes: every
 * group (abandoned ones included) with its notes and source actions, each
 * member with its intervention and requeue count, and each retest slot with
 * its protocol, job, attempts, evidence (the same reader a question section
 * uses) and, once it has an attempt, both phases' measurement fingerprints
 * compared (measurement-fingerprint.ts). Identity comes from the pilot's own
 * tables: a retest reaches the report only through a member of a group of
 * this pilot and its retest slot. Reads only.
 */
export async function readPilotRetestsInput(
  client: SupabaseClient,
  ctx: {
    pilotId: string;
    projectId: string;
    subject: BuildProtocolReportInput["subject"];
    questionIds: string[];
    baselineSlots: { protocolId: string }[];
    latestReserved: Record<string, string | null>;
  }
): Promise<PilotRetestsInput> {
  const baselineLatestReservedAt: Record<string, string | null> = {};
  for (const s of ctx.baselineSlots) baselineLatestReservedAt[s.protocolId] = ctx.latestReserved[s.protocolId] ?? null;

  const groupRows = await rows(client.from("pilot_retests").select("*").eq("pilot_id", ctx.pilotId));
  if (groupRows.length === 0) return { groups: [], baselineLatestReservedAt };

  const [memberRows, noteRows, stepRows, slotRows] = await Promise.all([
    rows(client.from("pilot_retest_members").select("*").eq("pilot_id", ctx.pilotId)),
    rows(client.from("pilot_retest_notes").select("id,pilot_retest_id,noted_on,kind,text,corrects_note_id,written_at").eq("pilot_id", ctx.pilotId)),
    rows(client.from("pilot_retest_steps").select("member_id,step").eq("pilot_id", ctx.pilotId).eq("step", "requeue")),
    ctx.questionIds.length > 0
      ? rows(
          client
            .from("pilot_question_protocols")
            .select("pilot_question_id,engine,phase,protocol_id,pilot_retest_member_id")
            .in("pilot_question_id", ctx.questionIds)
            .eq("phase", "retest")
        )
      : Promise.resolve([] as Row[]),
  ]);
  for (const m of memberRows) {
    if (String(m.project_id) !== ctx.projectId) throw new ProtocolEvidenceError(`Pilot retest member ${String(m.id)} belongs to another project.`);
  }

  const interventionIds = memberRows.map((m) => String(m.intervention_id));
  const baselineIds = [...new Set(memberRows.map((m) => String(m.baseline_protocol_id)))];
  const retestIds = slotRows.map((s) => String(s.protocol_id));
  const sourceIds = [...new Set(groupRows.flatMap((g) => (Array.isArray(g.source_action_version_ids) ? g.source_action_version_ids.map(String) : [])))];

  const [interventionRows, baselineRows, retestProtocolRows, jobRows, attemptRows, versionRows] = await Promise.all([
    interventionIds.length > 0 ? rows(client.from("interventions").select("*").in("id", interventionIds)) : Promise.resolve([] as Row[]),
    baselineIds.length > 0 ? rows(client.from("protocols").select("id,buyer_question_version_id").in("id", baselineIds)) : Promise.resolve([] as Row[]),
    retestIds.length > 0
      ? rows(
          client
            .from("protocols")
            .select("id,project_id,provider,surface,planned_baseline_runs,run_cap,minimum_useful_change,detectable_change_at_plan,baseline_protocol_id,buyer_question_version_id")
            .in("id", retestIds)
        )
      : Promise.resolve([] as Row[]),
    retestIds.length > 0
      ? rows(
          client
            .from("protocol_execution_jobs")
            .select("id,protocol_id,status,failure_reason,review_resolution,current_attempt_id,next_baseline_ordinal")
            .in("protocol_id", retestIds)
        )
      : Promise.resolve([] as Row[]),
    retestIds.length > 0
      ? rows(
          client
            .from("protocol_attempts")
            .select("id,protocol_id,job_id,status,baseline_ordinal,terminalized_at,retry_of_attempt_id,reserved_at,probe_run_id")
            .in("protocol_id", retestIds)
        )
      : Promise.resolve([] as Row[]),
    sourceIds.length > 0 ? rows(client.from("pilot_action_versions").select("id,action_id,title").in("id", sourceIds)) : Promise.resolve([] as Row[]),
  ]);
  const actionIds = [...new Set(versionRows.map((v) => String(v.action_id)))];
  const withdrawnRows =
    actionIds.length > 0
      ? await rows(client.from("pilot_action_events").select("action_id,event").in("action_id", actionIds).eq("event", "withdrawn"))
      : [];
  const withdrawn = new Set(withdrawnRows.map((e) => String(e.action_id)));

  // Answer modes of the retest attempts (probe_runs.probe_mode).
  const probeRunToProtocol = new Map<string, string>();
  for (const a of attemptRows) if (typeof a.probe_run_id === "string") probeRunToProtocol.set(a.probe_run_id, String(a.protocol_id));
  const modes = new Map<string, Set<string>>();
  if (probeRunToProtocol.size > 0) {
    for (const r of await rows(client.from("probe_runs").select("id,probe_mode").in("id", [...probeRunToProtocol.keys()]))) {
      const protocolId = probeRunToProtocol.get(String(r.id));
      if (!protocolId) continue;
      const set = modes.get(protocolId) ?? new Set<string>();
      set.add(typeof r.probe_mode === "string" && r.probe_mode ? r.probe_mode : "unrecorded");
      modes.set(protocolId, set);
    }
  }

  const ivById = new Map(interventionRows.map((r) => [String(r.id), r]));
  const baselineVersion = new Map(baselineRows.map((r) => [String(r.id), str(r.buyer_question_version_id)]));
  const protocolById = new Map(retestProtocolRows.map((r) => [String(r.id), r]));
  const jobByProtocol = new Map(jobRows.map((r) => [String(r.protocol_id), r]));
  const slotByMember = new Map(slotRows.filter((s) => s.pilot_retest_member_id).map((s) => [String(s.pilot_retest_member_id), s]));
  const requeues = new Map<string, number>();
  for (const st of stepRows) if (st.member_id) requeues.set(String(st.member_id), (requeues.get(String(st.member_id)) ?? 0) + 1);

  const members = new Map<string, PilotRetestMemberInput[]>();
  for (const m of memberRows) {
    const memberId = String(m.id);
    const baselineProtocolId = String(m.baseline_protocol_id);
    const iv = ivById.get(String(m.intervention_id));
    const slotRow = slotByMember.get(memberId);
    let retest: PilotRetestSlotInput | null = null;
    if (slotRow) {
      const protocolId = String(slotRow.protocol_id);
      const pr = protocolById.get(protocolId);
      if (!pr || String(pr.project_id) !== ctx.projectId) {
        throw new ProtocolEvidenceError(`Retest protocol ${protocolId} is not this pilot's.`);
      }
      const job = jobByProtocol.get(protocolId);
      const attempts = attemptRows.filter((a) => String(a.protocol_id) === protocolId);
      const evidence = await readPilotProtocolEvidence(client, protocolId, ctx.projectId, ctx.subject);
      const firsts = attempts.map((a) => str(a.reserved_at)).filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort();
      const lasts = attempts
        .map((a) => str(a.terminalized_at) ?? str(a.reserved_at))
        .filter((d): d is string => !!d)
        .map((d) => d.slice(0, 10))
        .sort();
      const muc = pr.minimum_useful_change && typeof pr.minimum_useful_change === "object"
        ? num((pr.minimum_useful_change as Row).value)
        : null;
      const compatibility =
        attempts.length > 0
          ? evaluateMeasurementCompatibility(
              await readPhaseMeasurement(client, baselineProtocolId, ctx.projectId),
              await readPhaseMeasurement(client, protocolId, ctx.projectId)
            )
          : null;
      retest = {
        protocolId,
        protocol: {
          provider: String(pr.provider),
          surface: String(pr.surface),
          plannedBaselineRuns: num(pr.planned_baseline_runs),
          runCap: num(pr.run_cap) ?? 0,
          minimumUsefulChange: muc,
          detectableChangeAtPlan: num(pr.detectable_change_at_plan),
          baselineProtocolId: str(pr.baseline_protocol_id),
          buyerQuestionVersionId: String(pr.buyer_question_version_id),
        },
        job: job
          ? {
              id: String(job.id),
              status: String(job.status),
              failureReason: str(job.failure_reason),
              reviewResolution: str(job.review_resolution),
              currentAttemptId: str(job.current_attempt_id),
              nextBaselineOrdinal: num(job.next_baseline_ordinal) ?? 0,
            }
          : null,
        attempts: attempts.map((a) => ({
          id: String(a.id),
          jobId: String(a.job_id),
          status: String(a.status),
          baselineOrdinal: num(a.baseline_ordinal),
          terminalizedAt: str(a.terminalized_at),
          retryOfAttemptId: str(a.retry_of_attempt_id),
          reservedAt: str(a.reserved_at),
        })),
        evidence,
        execution: { firstOn: firsts[0] ?? null, lastOn: lasts[lasts.length - 1] ?? null },
        answerModes: [...(modes.get(protocolId) ?? [])].sort(),
        compatibility,
      };
    }
    const list = members.get(String(m.pilot_retest_id)) ?? [];
    list.push({
      id: memberId,
      pilotQuestionId: String(m.pilot_question_id),
      engine: String(m.engine) as PilotEngineKey,
      baselineProtocolId,
      interventionId: String(m.intervention_id),
      requeueCount: requeues.get(memberId) ?? 0,
      baselineQuestionVersionId: baselineVersion.get(baselineProtocolId) ?? null,
      intervention: iv
        ? {
            status: String(iv.status),
            protocolId: String(iv.protocol_id),
            approvedAt: str(iv.approved_at),
            implementedAt: str(iv.implemented_at),
            windowOpensAt: str(iv.observation_window_opens_at),
            windowClosesAt: str(iv.observation_window_closes_at),
            protocolDeviations: str(iv.protocol_deviations),
            earlyRetestAuthorizedAt: str(iv.early_retest_authorized_at),
            hypothesis: String(iv.hypothesis),
            expectedMechanism: String(iv.expected_mechanism),
            actionType: String(iv.action_type),
            actionTarget: String(iv.action_target),
            owner: String(iv.owner),
            alternativeExplanations: str(iv.alternative_explanations),
            confoundersToMonitor: str(iv.confounders_to_monitor),
            decisionThresholdNote: str(iv.decision_threshold_note),
          }
        : null,
      retest,
    });
    members.set(String(m.pilot_retest_id), list);
  }

  const versionById = new Map(versionRows.map((v) => [String(v.id), v]));
  const groups: PilotRetestGroupInput[] = groupRows.map((g) => {
    const text: PilotRetestText = {
      changeTitle: String(g.change_title),
      changeDescription: String(g.change_description),
      changeTarget: String(g.change_target),
      changeOwner: String(g.change_owner),
      hypothesis: String(g.hypothesis),
      expectedMechanism: String(g.expected_mechanism),
      alternativeExplanations: String(g.alternative_explanations),
      openQuestions: String(g.open_questions),
      decisionThreshold: String(g.decision_threshold),
      confoundersToMonitor: String(g.confounders_to_monitor),
    };
    const sources = Array.isArray(g.source_action_version_ids) ? g.source_action_version_ids.map(String) : [];
    return {
      id: String(g.id),
      sequence: Number(g.sequence),
      registeredAt: String(g.registered_at),
      customerApprovedOn: String(g.customer_approved_on),
      text,
      actionType: String(g.action_type),
      thresholdBelowLimit: g.threshold_below_limit === true,
      outcomeRule: String(g.outcome_rule),
      observationDays: Number(g.observation_days),
      implementBy: String(g.implement_by),
      sourceActions: sources.map((id) => {
        const v = versionById.get(id);
        const gone = !v || withdrawn.has(String(v.action_id));
        return { versionId: id, title: gone || !v ? null : String(v.title), withdrawn: gone };
      }),
      implementedAt: str(g.implemented_at),
      windowOpensAt: str(g.window_opens_at),
      windowClosesAt: str(g.window_closes_at),
      wentLiveOn: str(g.went_live_on),
      evidenceUrl: str(g.evidence_url),
      artifactSha256: str(g.artifact_sha256),
      implementedAsRegistered: typeof g.implemented_as_registered === "boolean" ? g.implemented_as_registered : null,
      retestsPreparedAt: str(g.retests_prepared_at),
      abandonedAt: str(g.abandoned_at),
      notes: noteRows
        .filter((n) => String(n.pilot_retest_id) === String(g.id))
        .map((n) => ({
          id: String(n.id),
          notedOn: String(n.noted_on),
          kind: String(n.kind),
          text: String(n.text),
          correctsNoteId: str(n.corrects_note_id),
          writtenAt: String(n.written_at),
        })),
      members: members.get(String(g.id)) ?? [],
    };
  });
  return { groups, baselineLatestReservedAt };
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
