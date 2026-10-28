/**
 * The decision that must pass before the product starts any paid provider
 * work.
 *
 * Off unless explicitly switched on. Paid execution requires BOTH:
 *
 *   ZYPACT_PAID_EXECUTION_ENABLED=true          exactly "true"; anything
 *                                               else, or absence, is off
 *   ZYPACT_DAILY_SPEND_CEILING_USD=<number>     > 0 and <= the hard maximum
 *
 * and then a readable spend ledger showing that the last 24 hours of calls,
 * plus the largest spend cap of any job the worker could claim next, stay
 * within that ceiling. Every other state — a missing or malformed value, a
 * ceiling above the hard maximum, an unreadable or truncated ledger — is a
 * refusal. Missing configuration never enables spending.
 *
 * Which jobs count: every job the worker could claim on this start. Its
 * claim (0050, and 0054's identical predicate) takes a `queued` job, or a
 * `claimed`/`running` one whose lease has expired with attempts left — a
 * crashed job being resumed. 0059's targeted claim takes only `queued`
 * jobs, a subset. The gate counts `queued` jobs and every `claimed`/
 * `running` job with attempts left, lease expired OR NOT: the claim
 * compares against the database clock and this gate against the web
 * server's, so mirroring "expired" exactly could undercount at the
 * boundary. The only extra jobs counted are ones that become claimable the
 * moment their lease runs out. A job with no attempts left is not counted;
 * the claim abandons it instead of running it.
 *
 * Why "largest claimable cap" and not a sum: the worker runs as one machine
 * that claims one job per start and exits (D-034), and each job's spend is
 * bounded at every reservation by its protocol's `spend_cap_usd` in SQL
 * (0047/0050/0051). One start can therefore add at most one job's cap. A
 * second start while that job runs is a no-op on the same machine.
 *
 * Reserved cost stands in for actual cost wherever actual is unknown, so a
 * call that was paid for but never measured is counted, not ignored.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** No configured ceiling above this is accepted; a typo must not lift the cap. */
export const DAILY_SPEND_CEILING_HARD_MAX_USD = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** PostgREST's default page; a larger window is refused, never undercounted. */
const LEDGER_ROW_LIMIT = 1000;

export type PaidExecutionRefusal =
  | "paid_execution_disabled"
  | "spend_ceiling_not_configured"
  | "spend_ledger_unavailable"
  | "spend_ceiling_reached";

export type PaidExecutionDecision =
  | { ok: true; ceilingUsd: number; spentLast24hUsd: number; nextJobCapUsd: number }
  | { ok: false; code: PaidExecutionRefusal; detail: string };

export type PaidExecutionConfig =
  | { enabled: false; reason: "paid_execution_disabled" | "spend_ceiling_not_configured"; detail: string }
  | { enabled: true; ceilingUsd: number };

export function readPaidExecutionConfig(
  env: Record<string, string | undefined> = process.env
): PaidExecutionConfig {
  if (env.ZYPACT_PAID_EXECUTION_ENABLED?.trim() !== "true") {
    return {
      enabled: false,
      reason: "paid_execution_disabled",
      detail: "Paid execution is switched off on this deployment (ZYPACT_PAID_EXECUTION_ENABLED is not \"true\").",
    };
  }
  const raw = env.ZYPACT_DAILY_SPEND_CEILING_USD?.trim() ?? "";
  const ceiling = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > DAILY_SPEND_CEILING_HARD_MAX_USD) {
    return {
      enabled: false,
      reason: "spend_ceiling_not_configured",
      detail: `No valid daily spend ceiling is set (ZYPACT_DAILY_SPEND_CEILING_USD must be a number above 0 and at most ${DAILY_SPEND_CEILING_HARD_MAX_USD}).`,
    };
  }
  return { enabled: true, ceilingUsd: ceiling };
}

function money(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * What one ledger row counts toward the ceiling, by how its cost is known:
 *
 *   measured   the provider's own charge (Perplexity usage.cost) — counted
 *   estimated  computed from token counts and a price list (PR #2) —
 *              counted as the LARGER of the estimate and the reservation,
 *              so an estimate can never make spend look smaller than the
 *              reservation-based count it replaces
 *   none       no actual cost yet (in flight, failed, unpriced) — the
 *              reservation is counted
 *
 * Anything else — an unknown basis, or a basis without its cost — is null,
 * and the gate refuses.
 */
export function countedCostUsd(row: Record<string, unknown>): number | null {
  const reserved = money(row.reserved_cost_usd);
  const basis = row.cost_basis ?? null;
  if (basis === null) return row.actual_cost_usd === null || row.actual_cost_usd === undefined ? reserved : null;
  const actual = money(row.actual_cost_usd);
  if (actual === null) return null;
  if (basis === "measured") return actual;
  if (basis === "estimated") return reserved === null ? null : Math.max(actual, reserved);
  return null;
}

export async function evaluatePaidExecution(deps: {
  client: SupabaseClient;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}): Promise<PaidExecutionDecision> {
  const config = readPaidExecutionConfig(deps.env);
  if (!config.enabled) return { ok: false, code: config.reason, detail: config.detail };

  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const unavailable = (detail: string): PaidExecutionDecision => ({
    ok: false, code: "spend_ledger_unavailable", detail,
  });

  let calls: Record<string, unknown>[];
  let claimableCaps: Record<string, unknown>[];
  try {
    const { data, error, count } = await deps.client
      .from("protocol_external_calls")
      .select("reserved_cost_usd,actual_cost_usd,cost_basis", { count: "exact" })
      .gte("created_at", since)
      .limit(LEDGER_ROW_LIMIT);
    if (error || !Array.isArray(data)) return unavailable("The spend ledger could not be read.");
    if (typeof count !== "number" || count > data.length) {
      return unavailable("The spend ledger returned an incomplete window, so spend cannot be totalled.");
    }
    calls = data as Record<string, unknown>[];

    const jobs = await deps.client
      .from("protocol_execution_jobs")
      .select("protocol_id,status,attempt_count,max_attempts")
      .in("status", ["queued", "claimed", "running"]);
    if (jobs.error || !Array.isArray(jobs.data)) return unavailable("The job queue could not be read.");
    const claimable: string[] = [];
    for (const job of jobs.data as Record<string, unknown>[]) {
      if (job.status === "queued") {
        claimable.push(String(job.protocol_id));
        continue;
      }
      const attempts = job.attempt_count;
      const max = job.max_attempts;
      if (!Number.isInteger(attempts) || !Number.isInteger(max)) {
        return unavailable("A claimed job's attempt counts could not be read.");
      }
      if ((attempts as number) < (max as number)) claimable.push(String(job.protocol_id));
    }
    const protocolIds = Array.from(new Set(claimable));
    claimableCaps = [];
    if (protocolIds.length > 0) {
      const caps = await deps.client
        .from("protocols")
        .select("id,spend_cap_usd")
        .in("id", protocolIds);
      if (caps.error || !Array.isArray(caps.data) || caps.data.length !== protocolIds.length) {
        return unavailable("A claimable job's spend cap could not be read.");
      }
      claimableCaps = caps.data as Record<string, unknown>[];
    }
  } catch {
    return unavailable("The spend ledger could not be read.");
  }

  let spent = 0;
  for (const row of calls) {
    const value = countedCostUsd(row);
    if (value === null) return unavailable("A ledger row carries no usable cost.");
    spent += value;
  }

  let nextJobCap = 0;
  for (const row of claimableCaps) {
    const cap = money(row.spend_cap_usd);
    if (cap === null) return unavailable("A claimable job's spend cap is not a usable number.");
    nextJobCap = Math.max(nextJobCap, cap);
  }

  if (spent + nextJobCap > config.ceilingUsd) {
    return {
      ok: false,
      code: "spend_ceiling_reached",
      detail: `Starting now could take the last 24 hours past the daily ceiling ($${(spent + nextJobCap).toFixed(4)} of $${config.ceilingUsd.toFixed(2)}).`,
    };
  }
  return { ok: true, ceilingUsd: config.ceilingUsd, spentLast24hUsd: spent, nextJobCapUsd: nextJobCap };
}
