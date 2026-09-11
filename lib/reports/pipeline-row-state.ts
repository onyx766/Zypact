/**
 * Per-row pipeline state for the admin request list.
 *
 * Three small reads for the whole page rather than three per row: the list
 * shows up to 100 requests, and a per-row query would turn one page load into
 * hundreds of round trips.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PipelineRowState {
  jobStatus: string | null;
  /**
   * A job that claims to be running but whose lease has lapsed. The worker
   * holding it is gone — killed, crashed, or terminated with its parent — and
   * nothing is executing. Reported separately because the row must not show
   * such a job as active: that is how a dead run looked like a live one for
   * twenty-four minutes.
   */
  stale: boolean;
  integrityStatus: string | null;
  publicToken: string | null;
  delivered: boolean;
}

const EMPTY: PipelineRowState = {
  jobStatus: null,
  stale: false,
  integrityStatus: null,
  publicToken: null,
  delivered: false,
};

const LEASED = new Set(["claimed", "running"]);

export async function loadPipelineRowStates(
  client: SupabaseClient,
  requests: { id: string; protocolId?: string | null }[]
): Promise<Record<string, PipelineRowState>> {
  const states: Record<string, PipelineRowState> = {};
  for (const request of requests) states[request.id] = { ...EMPTY };

  const requestIds = requests.map((r) => r.id);
  if (requestIds.length === 0) return states;

  const protocolIds = requests
    .map((r) => r.protocolId)
    .filter((id): id is string => typeof id === "string");

  if (protocolIds.length > 0) {
    const { data: jobs } = await client
      .from("protocol_execution_jobs")
      .select("protocol_id,status,created_at,lease_expires_at")
      .in("protocol_id", protocolIds)
      .order("created_at", { ascending: false });

    // Newest first, so the first row seen for a protocol is the current job.
    const latestByProtocol = new Map<
      string,
      { status: string; stale: boolean }
    >();

    const now = Date.now();

    for (const row of (jobs ?? []) as Record<string, any>[]) {
      if (latestByProtocol.has(row.protocol_id)) continue;

      const expiry = row.lease_expires_at
        ? Date.parse(row.lease_expires_at)
        : NaN;

      latestByProtocol.set(row.protocol_id, {
        status: row.status,
        // An unparseable or absent expiry on a leased job is treated as stale:
        // claiming to be running with no provable lease is exactly the state
        // that must not render as healthy.
        stale:
          LEASED.has(row.status) &&
          (Number.isNaN(expiry) || expiry < now),
      });
    }

    for (const request of requests) {
      if (request.protocolId) {
        const latest = latestByProtocol.get(request.protocolId);
        states[request.id].jobStatus = latest?.status ?? null;
        states[request.id].stale = latest?.stale ?? false;
      }
    }
  }

  const { data: artifacts } = await client
    .from("snapshot_report_artifacts")
    .select(
      "snapshot_request_id,integrity_status,public_token,delivered_at"
    )
    .in("snapshot_request_id", requestIds);

  for (const row of (artifacts ?? []) as Record<string, any>[]) {
    const state = states[row.snapshot_request_id];
    if (!state) continue;

    state.integrityStatus = row.integrity_status ?? null;
    state.delivered = Boolean(row.delivered_at);
    // A blocked report is never linked from the admin list. The founder
    // opens it through the request page, where the reasons are shown too.
    state.publicToken =
      row.integrity_status === "blocked" ? null : row.public_token ?? null;
  }

  return states;
}
