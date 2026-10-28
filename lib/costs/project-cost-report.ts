/**
 * GET /api/internal/costs/projects/:projectId — reserved versus actual cost
 * for one project, founder-only.
 *
 * Read-only and aggregate-only: totals by call kind and by protocol, never a
 * request body, response, prompt or address. Every read is scoped to the
 * project in the path — the ledger rows by `project_id`, and the attempts
 * that attribute them to protocols by the same `project_id` — so one
 * project's figures cannot include another's.
 *
 * Refuses rather than undercounts: a ledger larger than one page, or any
 * read error, is a 503, not a partial total.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FounderRouteGuard } from "@/lib/auth/founder";
import { LLM_PRICE_TABLE_VERSION } from "@/lib/costs/llm-pricing";
import { reconcileCosts, type LedgerCostRow } from "@/lib/costs/reconcile-costs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page; a project above this is refused, never partly totalled. */
export const PROJECT_LEDGER_ROW_LIMIT = 5000;

export interface ProjectCostReportDeps {
  guard: () => Promise<FounderRouteGuard>;
  client: () => SupabaseClient;
}

function unavailable(): NextResponse {
  return NextResponse.json({ ok: false, error: "temporarily_unavailable" }, { status: 503 });
}

export async function handleProjectCostReport(
  projectId: string,
  deps: ProjectCostReportDeps
): Promise<NextResponse> {
  const guard = await deps.guard();
  if (!guard.ok) return guard.response;

  if (!UUID_PATTERN.test(projectId)) {
    return NextResponse.json({ ok: false, error: "invalid_project_id" }, { status: 400 });
  }

  let client: SupabaseClient;
  try {
    client = deps.client();
  } catch {
    return unavailable();
  }

  const calls = await client
    .from("protocol_external_calls")
    .select("protocol_attempt_id,call_kind,reserved_cost_usd,actual_cost_usd,cost_basis", { count: "exact" })
    .eq("project_id", projectId)
    .limit(PROJECT_LEDGER_ROW_LIMIT);
  if (calls.error || !Array.isArray(calls.data)) return unavailable();
  if (typeof calls.count !== "number" || calls.count > calls.data.length) return unavailable();
  const rows = calls.data as (LedgerCostRow & { protocol_attempt_id: unknown })[];

  const attemptIds = Array.from(new Set(rows.map((r) => String(r.protocol_attempt_id))));
  const protocolOf = new Map<string, string>();
  if (attemptIds.length > 0) {
    const attempts = await client
      .from("protocol_attempts")
      .select("id,protocol_id")
      .eq("project_id", projectId)
      .in("id", attemptIds);
    if (attempts.error || !Array.isArray(attempts.data)) return unavailable();
    for (const a of attempts.data as Record<string, unknown>[]) {
      protocolOf.set(String(a.id), String(a.protocol_id));
    }
  }

  const grouped = new Map<string, LedgerCostRow[]>();
  for (const row of rows) {
    // A ledger row whose attempt is not in this project is not attributed to
    // any protocol here; it still counts in the project totals it was read for.
    const protocolId = protocolOf.get(String(row.protocol_attempt_id)) ?? "unattributed";
    const list = grouped.get(protocolId) ?? [];
    list.push(row);
    grouped.set(protocolId, list);
  }

  const { total, byCallKind } = reconcileCosts(rows);
  const byProtocol = Array.from(grouped.entries())
    .map(([protocolId, list]) => ({ protocolId, ...reconcileCosts(list).total }))
    .sort((a, b) => a.protocolId.localeCompare(b.protocolId));

  return NextResponse.json({
    ok: true,
    projectId,
    priceTableVersion: LLM_PRICE_TABLE_VERSION,
    total,
    byCallKind,
    byProtocol,
  });
}
