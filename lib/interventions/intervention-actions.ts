/**
 * The M7 intervention RPCs, called from founder routes.
 *
 * Follows `lib/reports/review-actions.ts`: each function takes the
 * service-role client, which carries no user identity and applies no row
 * policy, so every caller MUST have passed `guardInterventionRoute` first.
 *
 * Two rules every function here keeps:
 *
 *   1. Project identity comes from the stored row, never the request. The
 *      intervention (or, for registration, the protocol) is read first and
 *      its `project_id` is what the RPC receives.
 *   2. An empty result is a refusal, not a success. approve/reject/abandon/
 *      confirm/authorize return `setof interventions` and answer a transition
 *      the current status does not allow with ZERO rows rather than an error.
 *      A route that equated "no error" with "done" would report success for
 *      something that never happened.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  describeRetestEligibility,
  mapRpcError,
  type EligibilityPresentation,
  type MappedRpcFailure,
} from "@/lib/interventions/rpc-errors";
import { mapInterventionRow, type Intervention } from "@/lib/interventions/types";
import type { ConfirmInput, RegisterInput } from "@/lib/interventions/validate";

export type ActionResult =
  | { ok: true; intervention: Intervention }
  | { ok: false; failure: MappedRpcFailure };

type OnUnmapped = (detail: { code: string | null; message: string | null }) => void;

const NOT_FOUND: MappedRpcFailure = {
  status: 404,
  error: "not_found",
  message: "That intervention was not found.",
};

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

export async function readIntervention(
  client: SupabaseClient,
  id: string
): Promise<Intervention | null> {
  const { data, error } = await client
    .from("interventions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapInterventionRow(data as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export async function registerIntervention(
  client: SupabaseClient,
  input: RegisterInput,
  onUnmapped?: OnUnmapped
): Promise<ActionResult> {
  const { data: protocol, error: readError } = await client
    .from("protocols")
    .select("id,project_id,status,baseline_protocol_id")
    .eq("id", input.protocolId)
    .maybeSingle();
  if (readError) throw readError;

  const p = protocol as Record<string, unknown> | null;
  if (!p) {
    return {
      ok: false,
      failure: { status: 404, error: "protocol_not_found", message: "That baseline protocol was not found." },
    };
  }

  // register_intervention accepts any approved/active/completed protocol,
  // including a completed RETEST. Registering against one would let
  // create_retest_protocol build a retest of a retest, and the Outcome Card
  // would then compare against the first retest as though it were the
  // baseline. Nothing in the canonical V1 scope describes chained retests,
  // so this refuses them. The database does not (yet) enforce it.
  if (p.baseline_protocol_id !== null && p.baseline_protocol_id !== undefined) {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "not_a_baseline",
        message: "That protocol is a retest. Interventions are registered against a baseline.",
      },
    };
  }

  const { data, error } = await client.rpc("register_intervention", {
    p_project_id: p.project_id,
    p_protocol_id: input.protocolId,
    p_hypothesis: input.hypothesis,
    p_expected_mechanism: input.expectedMechanism,
    p_action_type: input.actionType,
    p_action_target: input.actionTarget,
    p_owner: input.owner,
    p_supporting_evidence: input.supportingEvidence,
    p_alternative_explanations: input.alternativeExplanations,
    p_confounders_to_monitor: input.confoundersToMonitor,
    p_decision_threshold_note: input.decisionThresholdNote,
    p_implementation_deadline: input.implementationDeadline,
    p_expected_observation_days: input.expectedObservationDays,
  });

  if (error) return { ok: false, failure: mapRpcError(error, onUnmapped) };

  const row = firstRow(data);
  if (!row) {
    // register_intervention always returns the inserted row or raises. An
    // empty result means the contract changed underneath this code.
    onUnmapped?.({ code: null, message: "register_intervention returned no row" });
    return {
      ok: false,
      failure: { status: 500, error: "internal_error", message: "Something went wrong. Nothing was changed." },
    };
  }
  return { ok: true, intervention: mapInterventionRow(row) };
}

// ---------------------------------------------------------------------------
// transitions
// ---------------------------------------------------------------------------

type Transition =
  | { rpc: "approve_intervention"; verb: "approved" }
  | { rpc: "reject_intervention"; verb: "rejected"; reason: string }
  | { rpc: "abandon_intervention"; verb: "abandoned"; reason: string }
  | { rpc: "authorize_early_retest"; verb: "authorized for an early retest"; reason: string }
  | { rpc: "confirm_intervention_implementation"; verb: "confirmed as implemented"; confirm: ConfirmInput };

function argsFor(t: Transition, id: string, projectId: string, actor: string): Record<string, unknown> {
  switch (t.rpc) {
    case "approve_intervention":
      return { p_intervention_id: id, p_project_id: projectId, p_approved_by: actor };
    case "reject_intervention":
      return { p_intervention_id: id, p_project_id: projectId, p_rejected_by: actor, p_reason: t.reason };
    case "abandon_intervention":
      return { p_intervention_id: id, p_project_id: projectId, p_abandoned_by: actor, p_reason: t.reason };
    case "authorize_early_retest":
      return { p_intervention_id: id, p_project_id: projectId, p_authorized_by: actor, p_reason: t.reason };
    case "confirm_intervention_implementation":
      return {
        p_intervention_id: id,
        p_project_id: projectId,
        p_confirmed_by: actor,
        p_evidence: t.confirm.evidence,
        p_artifact_sha256: t.confirm.artifactSha256,
        p_deviations: t.confirm.deviations,
      };
  }
}

async function transition(
  client: SupabaseClient,
  id: string,
  actor: string,
  t: Transition,
  onUnmapped?: OnUnmapped
): Promise<ActionResult> {
  const current = await readIntervention(client, id);
  if (!current) return { ok: false, failure: NOT_FOUND };

  const { data, error } = await client.rpc(t.rpc, argsFor(t, id, current.projectId, actor));
  if (error) return { ok: false, failure: mapRpcError(error, onUnmapped) };

  const row = firstRow(data);
  if (!row) {
    return {
      ok: false,
      failure: {
        status: 409,
        error: "invalid_transition",
        message: `This intervention is '${current.status}', so it cannot be ${t.verb}.`,
      },
    };
  }
  return { ok: true, intervention: mapInterventionRow(row) };
}

export const approveIntervention = (c: SupabaseClient, id: string, actor: string, u?: OnUnmapped) =>
  transition(c, id, actor, { rpc: "approve_intervention", verb: "approved" }, u);

export const rejectIntervention = (c: SupabaseClient, id: string, actor: string, reason: string, u?: OnUnmapped) =>
  transition(c, id, actor, { rpc: "reject_intervention", verb: "rejected", reason }, u);

export const abandonIntervention = (c: SupabaseClient, id: string, actor: string, reason: string, u?: OnUnmapped) =>
  transition(c, id, actor, { rpc: "abandon_intervention", verb: "abandoned", reason }, u);

export const authorizeEarlyRetest = (c: SupabaseClient, id: string, actor: string, reason: string, u?: OnUnmapped) =>
  transition(c, id, actor, { rpc: "authorize_early_retest", verb: "authorized for an early retest", reason }, u);

export const confirmImplementation = (c: SupabaseClient, id: string, actor: string, confirm: ConfirmInput, u?: OnUnmapped) =>
  transition(c, id, actor, { rpc: "confirm_intervention_implementation", verb: "confirmed as implemented", confirm }, u);

// ---------------------------------------------------------------------------
// reads for the admin screens
// ---------------------------------------------------------------------------

export interface Eligibility extends EligibilityPresentation {
  reason: string;
  windowClosesAt: string | null;
  authorizedEarly: boolean;
}

/** Always asks 0072's retest_eligibility — the single authority — never re-derives it. */
export async function readEligibility(
  client: SupabaseClient,
  intervention: Pick<Intervention, "id" | "projectId">
): Promise<Eligibility> {
  const { data, error } = await client.rpc("retest_eligibility", {
    p_intervention_id: intervention.id,
    p_project_id: intervention.projectId,
  });
  if (error) throw error;
  const row = firstRow(data) ?? {};
  const reason = typeof row.reason === "string" ? row.reason : "INTERVENTION_NOT_FOUND";
  const windowClosesAt = typeof row.window_closes_at === "string" ? row.window_closes_at : null;
  return {
    ...describeRetestEligibility(reason, windowClosesAt),
    reason,
    windowClosesAt,
    authorizedEarly: row.authorized_early === true,
  };
}

export interface InterventionListItem {
  intervention: Intervention;
  companyName: string | null;
  domain: string | null;
  /**
   * Present for `implemented` rows only, where it is the authority's answer.
   * For every other status the retest question does not arise yet (or ever),
   * and the list shows the status itself rather than an eligibility claim.
   */
  eligibility: Eligibility | null;
}

export async function listInterventions(
  client: SupabaseClient,
  options: { status?: string; limit?: number } = {}
): Promise<InterventionListItem[]> {
  let query = client
    .from("interventions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  if (options.status) query = query.eq("status", options.status);

  const { data, error } = await query;
  if (error) throw error;
  const interventions = (data ?? []).map((r) => mapInterventionRow(r as Record<string, unknown>));

  const projectIds = [...new Set(interventions.map((i) => i.projectId))];
  const projects = new Map<string, { companyName: string | null; domain: string | null }>();
  if (projectIds.length > 0) {
    const { data: rows, error: pErr } = await client
      .from("projects")
      .select("id,company_name,domain")
      .in("id", projectIds);
    if (pErr) throw pErr;
    for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
      projects.set(String(r.id), {
        companyName: typeof r.company_name === "string" ? r.company_name : null,
        domain: typeof r.domain === "string" ? r.domain : null,
      });
    }
  }

  return Promise.all(
    interventions.map(async (intervention) => ({
      intervention,
      companyName: projects.get(intervention.projectId)?.companyName ?? null,
      domain: projects.get(intervention.projectId)?.domain ?? null,
      eligibility:
        intervention.status === "implemented" ? await readEligibility(client, intervention) : null,
    }))
  );
}
