/**
 * Reserved versus actual cost, reconciled from the external-call ledger.
 *
 * Pure. Every row is counted exactly once, in exactly one cost bucket:
 *
 *   measured    actual cost the provider itself reported (Perplexity)
 *   estimated   actual cost computed from token counts (analysis, PR #2)
 *   unknown     no actual cost — in flight, failed, or unpriced
 *   malformed   anything else; reported, never silently totalled
 *
 * `reservedUsd` is the sum of reservations for the same rows, so
 * `actualKnownUsd` (measured + estimated) and the reserved total describe
 * the same calls and can be compared without double counting. A row whose
 * actual cost exceeds its reservation is an overrun and is listed by count
 * and amount: reservations are the admission control, so an overrun means
 * the per-call reservation is too low.
 */

export interface LedgerCostRow {
  call_kind: unknown;
  reserved_cost_usd: unknown;
  actual_cost_usd: unknown;
  cost_basis: unknown;
}

export interface CostBucketTotals {
  calls: number;
  reservedUsd: number;
  measuredUsd: number;
  measuredCalls: number;
  estimatedUsd: number;
  estimatedCalls: number;
  unknownCalls: number;
  malformedCalls: number;
  /** measured + estimated. */
  actualKnownUsd: number;
  overrunCalls: number;
  overrunUsd: number;
}

function emptyTotals(): CostBucketTotals {
  return {
    calls: 0, reservedUsd: 0, measuredUsd: 0, measuredCalls: 0, estimatedUsd: 0, estimatedCalls: 0,
    unknownCalls: 0, malformedCalls: 0, actualKnownUsd: 0, overrunCalls: 0, overrunUsd: 0,
  };
}

function money(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Sums are rounded to 8 places for display; the per-row arithmetic is exact enough at USD scale. */
function round(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function reconcileCosts(rows: LedgerCostRow[]): {
  total: CostBucketTotals;
  byCallKind: Record<string, CostBucketTotals>;
} {
  const total = emptyTotals();
  const byCallKind: Record<string, CostBucketTotals> = {};

  for (const row of rows) {
    const kind = typeof row.call_kind === "string" ? row.call_kind : "unknown_kind";
    const bucket = (byCallKind[kind] ??= emptyTotals());
    for (const t of [total, bucket]) t.calls += 1;

    const reserved = money(row.reserved_cost_usd);
    const actualRaw = row.actual_cost_usd;
    const actual = money(actualRaw);
    const basis = row.cost_basis ?? null;
    const hasActual = actualRaw !== null && actualRaw !== undefined;

    const malformed =
      reserved === null ||
      (basis === null && hasActual) ||
      (basis !== null && (actual === null || (basis !== "measured" && basis !== "estimated")));

    if (malformed) {
      for (const t of [total, bucket]) t.malformedCalls += 1;
      continue;
    }

    for (const t of [total, bucket]) t.reservedUsd += reserved!;

    if (basis === null) {
      for (const t of [total, bucket]) t.unknownCalls += 1;
      continue;
    }

    for (const t of [total, bucket]) {
      if (basis === "measured") { t.measuredUsd += actual!; t.measuredCalls += 1; }
      else { t.estimatedUsd += actual!; t.estimatedCalls += 1; }
      t.actualKnownUsd += actual!;
      if (actual! > reserved!) { t.overrunCalls += 1; t.overrunUsd += actual! - reserved!; }
    }
  }

  for (const t of [total, ...Object.values(byCallKind)]) {
    t.reservedUsd = round(t.reservedUsd);
    t.measuredUsd = round(t.measuredUsd);
    t.estimatedUsd = round(t.estimatedUsd);
    t.actualKnownUsd = round(t.actualKnownUsd);
    t.overrunUsd = round(t.overrunUsd);
  }
  return { total, byCallKind };
}
