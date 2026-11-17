/**
 * D-057 — the database side of a pilot's suggested actions: save, review
 * and withdraw through their SECURITY DEFINER functions, the founder's list,
 * the versions a report may show, and the evidence picker.
 *
 * Identity comes from the pilot's own tables, never from the caller: an
 * answer is offered, or accepted, only when it is a completed attempt of one
 * of this pilot's measurements. A source is offered, or accepted, only when
 * it is among that answer's own extracted sources, so a URL is never typed
 * freehand; the report re-checks both at every build.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  pilotActionStatus,
  reportableActionVersions,
  type PilotActionEventRow,
  type PilotActionStatus,
  type PilotActionVersionRow,
  type SavePilotActionFields,
} from "@/lib/pilots/action-rules";
import type { PilotReportActionInput } from "@/lib/reports/build-pilot-actions";
import { runOrdinalsByAttemptId } from "@/lib/reports/build-protocol-report";
import type { EvidenceAttemptInput } from "@/lib/reports/protocol-report-types";
import { extractProviderSources, normalizeSourceUrl } from "@/lib/source-insights/extract-provider-sources";

const ENGINE_LABEL: Record<string, string> = { perplexity_sonar: "Perplexity", openai_chatgpt: "ChatGPT" };

type Row = Record<string, unknown>;
const one = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Row | undefined;

/* ---------------------------------------------------------------- writes */

export async function savePilotAction(
  client: SupabaseClient,
  input: { pilotId: string; writtenBy: string; fields: SavePilotActionFields }
): Promise<{ outcome: string; actionId: string | null; versionId: string | null; versionNumber: number | null }> {
  const f = input.fields;
  const { data, error } = await client.rpc("save_pilot_action", {
    p_pilot_id: input.pilotId,
    p_action_id: f.actionId,
    p_expected_version: f.expectedVersion,
    p_written_by: input.writtenBy,
    p_title: f.title,
    p_observation: f.observation,
    p_suggested_action: f.suggestedAction,
    p_why_it_might_matter: f.whyItMightMatter,
    p_alternative_explanations: f.alternativeExplanations,
    p_open_questions: f.openQuestions,
    p_evidence: f.evidence.map((e) => ({ attemptId: e.attemptId, sourceUrl: e.sourceUrl })),
    p_idempotency_key: f.idempotencyKey,
  });
  if (error) throw error;
  const row = one(data);
  return {
    outcome: String(row?.outcome ?? ""),
    actionId: row?.saved_action_id ? String(row.saved_action_id) : null,
    versionId: row?.saved_version_id ? String(row.saved_version_id) : null,
    versionNumber: typeof row?.saved_version_number === "number" ? row.saved_version_number : null,
  };
}

export async function reviewPilotAction(
  client: SupabaseClient,
  input: { pilotId: string; actionId: string; versionNumber: number; reviewedBy: string; confirmed: boolean }
): Promise<string> {
  const { data, error } = await client.rpc("review_pilot_action", {
    p_pilot_id: input.pilotId,
    p_action_id: input.actionId,
    p_version_number: input.versionNumber,
    p_reviewed_by: input.reviewedBy,
    p_confirmed: input.confirmed,
  });
  if (error) throw error;
  return String(one(data)?.outcome ?? "");
}

export async function withdrawPilotAction(
  client: SupabaseClient,
  input: { pilotId: string; actionId: string; withdrawnBy: string; reason: string }
): Promise<string> {
  const { data, error } = await client.rpc("withdraw_pilot_action", {
    p_pilot_id: input.pilotId,
    p_action_id: input.actionId,
    p_withdrawn_by: input.withdrawnBy,
    p_reason: input.reason,
  });
  if (error) throw error;
  return String(one(data)?.outcome ?? "");
}

/* ---------------------------------------------------------------- the pilot's answers */

interface PilotSlot {
  pilotQuestionId: string;
  ordinal: number;
  retired: boolean;
  engine: string;
  protocolId: string;
}

async function pilotSlots(client: SupabaseClient, pilotId: string): Promise<PilotSlot[]> {
  const { data: qRows, error: qError } = await client
    .from("pilot_questions")
    .select("id,ordinal,retired_at")
    .eq("pilot_id", pilotId);
  if (qError) throw qError;
  const questions = new Map(((qRows ?? []) as Row[]).map((q) => [String(q.id), q]));
  if (questions.size === 0) return [];
  const { data: sRows, error: sError } = await client
    .from("pilot_question_protocols")
    .select("pilot_question_id,engine,phase,protocol_id")
    .in("pilot_question_id", [...questions.keys()])
    .eq("phase", "baseline");
  if (sError) throw sError;
  return ((sRows ?? []) as Row[]).map((s) => {
    const q = questions.get(String(s.pilot_question_id))!;
    return {
      pilotQuestionId: String(s.pilot_question_id),
      ordinal: Number(q.ordinal),
      retired: q.retired_at !== null && q.retired_at !== undefined,
      engine: String(s.engine),
      protocolId: String(s.protocol_id),
    };
  });
}

interface AnswerRow {
  attemptId: string;
  protocolId: string;
  status: string;
  answerNumber: number;
  probeRunId: string | null;
}

async function answersOf(client: SupabaseClient, protocolIds: string[]): Promise<AnswerRow[]> {
  if (protocolIds.length === 0) return [];
  const { data, error } = await client
    .from("protocol_attempts")
    .select("id,protocol_id,attempt_kind,status,baseline_ordinal,probe_run_id,retry_of_attempt_id,termination_reason")
    .in("protocol_id", protocolIds);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const out: AnswerRow[] = [];
  for (const protocolId of protocolIds) {
    const own = rows.filter((r) => String(r.protocol_id) === protocolId);
    const attempts: EvidenceAttemptInput[] = own.map((r) => ({
      id: String(r.id),
      attemptKind: String(r.attempt_kind),
      status: String(r.status),
      baselineOrdinal: typeof r.baseline_ordinal === "number" ? r.baseline_ordinal : null,
      probeRunId: typeof r.probe_run_id === "string" ? r.probe_run_id : null,
      retryOfAttemptId: typeof r.retry_of_attempt_id === "string" ? r.retry_of_attempt_id : null,
      terminationReason: typeof r.termination_reason === "string" ? r.termination_reason : null,
    }));
    const ordinals = runOrdinalsByAttemptId(attempts);
    for (const a of attempts) {
      out.push({ attemptId: a.id, protocolId, status: a.status, answerNumber: ordinals.get(a.id) ?? 0, probeRunId: a.probeRunId });
    }
  }
  return out;
}

async function storedAnswers(client: SupabaseClient, probeRunIds: string[]): Promise<Map<string, Row>> {
  if (probeRunIds.length === 0) return new Map();
  const { data, error } = await client
    .from("probe_results")
    .select("probe_run_id,raw_response,raw_response_sha256,answer_summary")
    .in("probe_run_id", probeRunIds);
  if (error) throw error;
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.probe_run_id), r]));
}

export interface PilotEvidenceChoice {
  attemptId: string;
  engine: string;
  engineLabel: string;
  answerNumber: number;
  summary: string;
  sources: { url: string; domain: string; cited: boolean }[];
}

/**
 * The evidence picker: one question's completed answers whose stored
 * response re-hashes to its recorded fingerprint, each with its own
 * extracted sources. A retired question, or one of another pilot, offers
 * nothing.
 */
export async function loadEvidenceChoices(
  client: SupabaseClient,
  pilotId: string,
  pilotQuestionId: string
): Promise<PilotEvidenceChoice[] | null> {
  const slots = (await pilotSlots(client, pilotId)).filter((s) => s.pilotQuestionId === pilotQuestionId);
  if (slots.length === 0) return null;
  if (slots.some((s) => s.retired)) return [];
  const answers = (await answersOf(client, slots.map((s) => s.protocolId))).filter((a) => a.status === "completed" && a.probeRunId);
  const stored = await storedAnswers(client, answers.map((a) => a.probeRunId!));
  const choices: PilotEvidenceChoice[] = [];
  for (const a of answers.sort((x, y) => x.answerNumber - y.answerNumber)) {
    const r = stored.get(a.probeRunId!);
    if (!r) continue;
    const sources = extractProviderSources(
      typeof r.raw_response === "string" ? r.raw_response : null,
      typeof r.raw_response_sha256 === "string" ? r.raw_response_sha256 : null
    );
    if (sources.status === "no_raw_response" || sources.status === "hash_missing" || sources.status === "hash_mismatch") continue;
    const engine = slots.find((s) => s.protocolId === a.protocolId)!.engine;
    choices.push({
      attemptId: a.attemptId,
      engine,
      engineLabel: ENGINE_LABEL[engine] ?? "Unknown engine",
      answerNumber: a.answerNumber,
      summary: typeof r.answer_summary === "string" ? r.answer_summary : "",
      sources: [
        ...sources.cited.map((s) => ({ url: s.url, domain: s.domain, cited: true })),
        ...sources.retrievedOnly.map((s) => ({ url: s.url, domain: s.domain, cited: false })),
      ],
    });
  }
  return choices;
}

/**
 * Before a save: every linked answer is one of this pilot's, and every named
 * source is among that answer's own sources. The database checks the answer
 * again; only this check can see the source.
 */
export async function verifyActionEvidence(
  client: SupabaseClient,
  pilotId: string,
  links: { attemptId: string; sourceUrl: string | null }[]
): Promise<"OK" | "EVIDENCE_OUTSIDE_PILOT" | "EVIDENCE_NOT_AN_ANSWER" | "SOURCE_NOT_IN_ANSWER"> {
  const slots = await pilotSlots(client, pilotId);
  const answers = await answersOf(client, slots.map((s) => s.protocolId));
  const byId = new Map(answers.map((a) => [a.attemptId, a]));
  for (const link of links) {
    if (!byId.has(link.attemptId)) return "EVIDENCE_OUTSIDE_PILOT";
  }
  const named = links.filter((l) => l.sourceUrl !== null);
  if (named.length === 0) return "OK";
  const stored = await storedAnswers(
    client,
    named.map((l) => byId.get(l.attemptId)!.probeRunId).filter((id): id is string => typeof id === "string")
  );
  for (const link of named) {
    const a = byId.get(link.attemptId)!;
    const r = a.probeRunId ? stored.get(a.probeRunId) : undefined;
    if (a.status !== "completed" || !r) return "EVIDENCE_NOT_AN_ANSWER";
    const sources = extractProviderSources(
      typeof r.raw_response === "string" ? r.raw_response : null,
      typeof r.raw_response_sha256 === "string" ? r.raw_response_sha256 : null
    );
    const wanted = normalizeSourceUrl(link.sourceUrl)?.url ?? link.sourceUrl;
    if (sources.status !== "ok" || ![...sources.cited, ...sources.retrievedOnly].some((s) => s.url === wanted)) {
      return "SOURCE_NOT_IN_ANSWER";
    }
  }
  return "OK";
}

/* ---------------------------------------------------------------- reads */

interface ActionRows {
  actions: Row[];
  versions: Row[];
  events: Row[];
}

async function actionRows(client: SupabaseClient, pilotId: string): Promise<ActionRows> {
  const [a, v, e] = await Promise.all([
    client.from("pilot_actions").select("id,created_at").eq("pilot_id", pilotId).order("created_at", { ascending: true }),
    client
      .from("pilot_action_versions")
      .select("id,action_id,version_number,title,observation,suggested_action,why_it_might_matter,alternative_explanations,open_questions,written_at")
      .eq("pilot_id", pilotId),
    client.from("pilot_action_events").select("action_id,action_version_id,event,created_at,reason").eq("pilot_id", pilotId),
  ]);
  for (const r of [a, v, e]) if (r.error) throw r.error;
  return { actions: (a.data ?? []) as Row[], versions: (v.data ?? []) as Row[], events: (e.data ?? []) as Row[] };
}

const versionRow = (r: Row): PilotActionVersionRow => ({
  id: String(r.id),
  actionId: String(r.action_id),
  versionNumber: Number(r.version_number),
});
const eventRow = (r: Row): PilotActionEventRow => ({
  actionId: String(r.action_id),
  actionVersionId: r.action_version_id ? String(r.action_version_id) : null,
  event: r.event === "withdrawn" ? "withdrawn" : "reviewed",
  createdAt: String(r.created_at),
});

async function evidenceOf(client: SupabaseClient, versionIds: string[]): Promise<Map<string, { attemptId: string; sourceUrl: string | null }[]>> {
  const out = new Map<string, { attemptId: string; sourceUrl: string | null }[]>();
  if (versionIds.length === 0) return out;
  const { data, error } = await client
    .from("pilot_action_evidence")
    .select("action_version_id,position,attempt_id,source_url")
    .in("action_version_id", versionIds)
    .order("position", { ascending: true });
  if (error) throw error;
  for (const r of (data ?? []) as Row[]) {
    const list = out.get(String(r.action_version_id)) ?? [];
    list.push({ attemptId: String(r.attempt_id), sourceUrl: typeof r.source_url === "string" ? r.source_url : null });
    out.set(String(r.action_version_id), list);
  }
  return out;
}

/** Each action's latest version, when reviewed and not withdrawn, oldest action first: what a report shows. */
export async function readReportableActions(client: SupabaseClient, pilotId: string): Promise<PilotReportActionInput[]> {
  const rows = await actionRows(client, pilotId);
  const chosen = reportableActionVersions(
    rows.actions.map((a) => String(a.id)),
    rows.versions.map(versionRow),
    rows.events.map(eventRow)
  );
  const evidence = await evidenceOf(client, chosen.map((c) => c.versionId));
  return chosen.map((c) => {
    const v = rows.versions.find((r) => String(r.id) === c.versionId)!;
    return {
      actionId: c.actionId,
      versionId: c.versionId,
      versionNumber: Number(v.version_number),
      title: String(v.title),
      observation: String(v.observation),
      suggestedAction: String(v.suggested_action),
      whyItMightMatter: String(v.why_it_might_matter),
      alternativeExplanations: String(v.alternative_explanations),
      openQuestions: String(v.open_questions),
      reviewedAt: c.reviewedAt,
      evidence: evidence.get(c.versionId) ?? [],
    };
  });
}

export interface PilotActionAdminRow {
  actionId: string;
  status: PilotActionStatus;
  versionNumber: number;
  versionId: string;
  title: string;
  observation: string;
  suggestedAction: string;
  whyItMightMatter: string;
  alternativeExplanations: string;
  openQuestions: string;
  writtenAt: string;
  withdrawReason: string | null;
  evidence: { attemptId: string; sourceUrl: string | null; words: string }[];
}

/** The founder's list: every action with its latest version, status and links in words. */
export async function listPilotActionsForAdmin(client: SupabaseClient, pilotId: string): Promise<PilotActionAdminRow[]> {
  const rows = await actionRows(client, pilotId);
  const versions = rows.versions.map(versionRow);
  const events = rows.events.map(eventRow);
  const latest = rows.actions
    .map((a) => ({ id: String(a.id), s: pilotActionStatus(String(a.id), versions, events) }))
    .filter((x) => x.s.latest !== null);
  const evidence = await evidenceOf(client, latest.map((x) => x.s.latest!.id));
  const slots = await pilotSlots(client, pilotId);
  const answers = await answersOf(client, slots.map((s) => s.protocolId));
  const answerById = new Map(answers.map((a) => [a.attemptId, a]));
  const slotByProtocol = new Map(slots.map((s) => [s.protocolId, s]));
  return latest.map(({ id, s }) => {
    const v = rows.versions.find((r) => String(r.id) === s.latest!.id)!;
    const withdrawn = rows.events.find((e) => String(e.action_id) === id && e.event === "withdrawn");
    return {
      actionId: id,
      status: s.status,
      versionNumber: s.latest!.versionNumber,
      versionId: s.latest!.id,
      title: String(v.title),
      observation: String(v.observation),
      suggestedAction: String(v.suggested_action),
      whyItMightMatter: String(v.why_it_might_matter),
      alternativeExplanations: String(v.alternative_explanations),
      openQuestions: String(v.open_questions),
      writtenAt: String(v.written_at),
      withdrawReason: withdrawn && typeof withdrawn.reason === "string" ? withdrawn.reason : null,
      evidence: (evidence.get(s.latest!.id) ?? []).map((link) => {
        const a = answerById.get(link.attemptId);
        const slot = a ? slotByProtocol.get(a.protocolId) : undefined;
        const words =
          a && slot
            ? `Question ${slot.ordinal}, ${ENGINE_LABEL[slot.engine] ?? "Unknown engine"} answer ${a.answerNumber}`
            : "An answer that is no longer one of this pilot's";
        return { ...link, words: link.sourceUrl ? `${words}; source ${link.sourceUrl}` : words };
      }),
    };
  });
}
