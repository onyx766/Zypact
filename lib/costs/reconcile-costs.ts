/**
 * Reserved versus actual cost, reconciled from the external-call ledger.
 *
 * Pure. Every row is counted exactly once, in exactly one cost bucket:
 *
 *   measured    actual cost the provider itself reported (Perplexity)
 *   estimated   actual cost computed from token counts (analysis, PR #2;
 *               ChatGPT's provider leg, D-056, from OpenAI's price table)
 *   unknown     no actual cost — in flight, failed, or unpriced
 *   malformed   anything else; reported, never silently totalled
 *
 * `reservedUsd` is the sum of reservations for the same rows, so
 * `actualKnownUsd` (measured + estimated) and the reserved total describe
 * the same calls and can be compared without double counting. A row whose
 * actual cost exceeds its reservation is an overrun and is listed by count
 * and amount: reservations are the admission control, so an overrun means
 * the per-call reservation is too low.
 *
 * Two splits of the same rows (D-061):
 *   byCallKind  the ledger's own label. The provider leg of EVERY engine is
 *               `perplexity` there (D-061 item 1), so this split does not
 *               separate engines; it is kept as the ledger states it.
 *   byLeg       the provider leg by engine, through the protocol's provider
 *               (`perplexity`, `chatgpt`), and `analysis` apart. A provider
 *               leg whose protocol's provider is not known is
 *               `provider_engine_unknown`, never filed under an engine.
 */

export interface LedgerCostRow {
  call_kind: unknown;
  reserved_cost_usd: unknown;
  actual_cost_usd: unknown;
  cost_basis: unknown;
  /**
   * D-061 — the provider of the protocol the row's attempt belongs to
   * (`protocols.provider`), when the caller joined it. It decides only the
   * `byLeg` split.
   */
  provider?: unknown;
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

/** D-061 — the `byLeg` buckets. */
export type CostLeg = "perplexity" | "chatgpt" | "analysis" | "provider_engine_unknown" | "unknown_kind";

/** Every provider string a Perplexity protocol has been written with. */
const PERPLEXITY_PROVIDERS: ReadonlySet<string> = new Set(["perplexity", "perplexity_sonar", "perplexity_agent"]);

/**
 * D-061 — the leg a ledger row belongs to: the analysis leg as such, and the
 * provider leg (`call_kind = 'perplexity'` for every engine) by the
 * protocol's provider.
 */
export function costLegOf(row: Pick<LedgerCostRow, "call_kind" | "provider">): CostLeg {
  if (row.call_kind === "analysis") return "analysis";
  if (row.call_kind !== "perplexity") return "unknown_kind";
  if (typeof row.provider === "string" && PERPLEXITY_PROVIDERS.has(row.provider)) return "perplexity";
  if (row.provider === "openai_chatgpt") return "chatgpt";
  return "provider_engine_unknown";
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
  byLeg: Partial<Record<CostLeg, CostBucketTotals>>;
} {
  const total = emptyTotals();
  const byCallKind: Record<string, CostBucketTotals> = {};
  const byLeg: Partial<Record<CostLeg, CostBucketTotals>> = {};

  for (const row of rows) {
    const kind = typeof row.call_kind === "string" ? row.call_kind : "unknown_kind";
    const bucket = (byCallKind[kind] ??= emptyTotals());
    const leg = (byLeg[costLegOf(row)] ??= emptyTotals());
    const buckets = [total, bucket, leg];
    for (const t of buckets) t.calls += 1;

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
      for (const t of buckets) t.malformedCalls += 1;
      continue;
    }

    for (const t of buckets) t.reservedUsd += reserved!;

    if (basis === null) {
      for (const t of buckets) t.unknownCalls += 1;
      continue;
    }

    for (const t of buckets) {
      if (basis === "measured") { t.measuredUsd += actual!; t.measuredCalls += 1; }
      else { t.estimatedUsd += actual!; t.estimatedCalls += 1; }
      t.actualKnownUsd += actual!;
      if (actual! > reserved!) { t.overrunCalls += 1; t.overrunUsd += actual! - reserved!; }
    }
  }

  for (const t of [total, ...Object.values(byCallKind), ...Object.values(byLeg)]) {
    if (!t) continue;
    t.reservedUsd = round(t.reservedUsd);
    t.measuredUsd = round(t.measuredUsd);
    t.estimatedUsd = round(t.estimatedUsd);
    t.actualKnownUsd = round(t.actualKnownUsd);
    t.overrunUsd = round(t.overrunUsd);
  }
  return { total, byCallKind, byLeg };
}
