/**
 * D-062 (§3.6) — the generic M7 screens and routes leave a pilot question's
 * interventions alone. Because of 20261109190000's triggers, an
 * intervention on a pilot baseline is always a member of a registered
 * change (or a recovery row, §2.8): it is managed on its pilot page, its
 * retest runs from there, and its Outcome Card lives in the pilot report.
 *
 * Reads only, with the service-role client: callers have passed the founder
 * guard (or are the delivery worker). Only `select`, `eq` and `in` are used.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MappedRpcFailure } from "@/lib/interventions/rpc-errors";

type Row = Record<string, unknown>;

/** The ids among `interventionIds` that are members of a pilot's registered change. */
export async function pilotMemberInterventionIds(client: SupabaseClient, interventionIds: string[]): Promise<Set<string>> {
  if (interventionIds.length === 0) return new Set();
  const { data, error } = await client.from("pilot_retest_members").select("intervention_id,pilot_id").in("intervention_id", interventionIds);
  if (error) throw error;
  return new Set(((data ?? []) as Row[]).map((r) => String(r.intervention_id)));
}

/** The pilot of a member intervention, or null when it is not one. */
export async function pilotOfMember(client: SupabaseClient, interventionId: string): Promise<string | null> {
  const { data, error } = await client.from("pilot_retest_members").select("intervention_id,pilot_id").eq("intervention_id", interventionId);
  if (error) throw error;
  const row = ((data ?? []) as Row[])[0];
  return row ? String(row.pilot_id) : null;
}

/** The ids among `protocolIds` that are a pilot question's slot protocol (any phase). */
export async function pilotSlotProtocolIds(client: SupabaseClient, protocolIds: string[]): Promise<Set<string>> {
  if (protocolIds.length === 0) return new Set();
  const { data, error } = await client.from("pilot_question_protocols").select("protocol_id").in("protocol_id", protocolIds);
  if (error) throw error;
  return new Set(((data ?? []) as Row[]).map((r) => String(r.protocol_id)));
}

/** A pilot member, refused by every generic M7 action. */
export const PILOT_MEMBER_FAILURE: MappedRpcFailure = {
  status: 409,
  error: "pilot_member",
  message: "Managed on its pilot page: this intervention belongs to a pilot question's registered change.",
};

/** A pilot question's baseline, refused by the generic registration. */
export const PILOT_BASELINE_FAILURE: MappedRpcFailure = {
  status: 409,
  error: "pilot_baseline",
  message: "This baseline is a pilot question's measurement. Register a change for it on its pilot page.",
};
