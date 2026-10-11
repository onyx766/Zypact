/**
 * Reads 0082's insert-only deviation ledger.
 *
 * Shared by the founder console and the Outcome Card builder so both see the
 * same rows in the same order.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mapDeviationRow, type InterventionDeviation } from "@/lib/interventions/types";

/**
 * True only for "the table is not there": PostgreSQL's undefined_table, or
 * PostgREST's schema-cache miss for a relation it has never seen.
 *
 * Code reaches an environment before a hand-applied migration does. Until
 * 0082 is applied there, the ledger cannot hold a row, so an empty list is
 * the true answer and building a card must not start failing. Every other
 * error still throws: a ledger that exists and cannot be read must never be
 * reported as "no deviations".
 */
function ledgerNotDeployed(error: { code?: string | null }): boolean {
  return error.code === "42P01" || error.code === "PGRST205";
}

/** The deviations recorded after implementation, oldest first. */
export async function readDeviationLedger(
  client: SupabaseClient,
  intervention: { id: string; projectId: string }
): Promise<InterventionDeviation[]> {
  const { data, error } = await client
    .from("intervention_deviations")
    .select("id,note,recorded_by,recorded_at,retest_attempts_at_record,card_delivered_at_record")
    .eq("intervention_id", intervention.id)
    .eq("project_id", intervention.projectId)
    .order("recorded_at", { ascending: true });

  if (error) {
    if (ledgerNotDeployed(error)) return [];
    throw error;
  }
  return ((data ?? []) as Record<string, unknown>[]).map(mapDeviationRow);
}
