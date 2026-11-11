/**
 * X1 (D-050) — cost estimation for the ChatGPT engine, from recorded usage.
 *
 * Pure: no provider call, no environment. Kept apart from the adapter so a
 * report or a ledger can estimate a cost without importing a module that
 * can spend money.
 *
 * OpenAI's Responses API reports token usage but not a charged amount, so a
 * cost here is an ESTIMATE: recorded usage multiplied by a dated, versioned
 * price table copied from OpenAI's public pricing page. Founder decision
 * (2026-11-10): a cost that cannot be estimated is unknown (null), never 0.
 * Usage is kept on every run (and the raw body is stored), so a later price
 * table or an invoice reconciliation can recompute any run.
 */

export const OPENAI_PRICE_TABLE = {
  /** 2026-11-11: added the two dated snapshots; earlier rows unchanged from openai-prices-2026-11-10. */
  version: "openai-prices-2026-11-11",
  source: "https://developers.openai.com/api/docs/pricing",
  recordedOn: "2026-11-11",
  /** Copied by an engineer from the public page; not yet reconciled with an invoice. */
  status: "recorded_from_public_page",
  /** "$10.00 / 1k calls + search content tokens billed at model rates." */
  webSearchPerCallUsd: 0.01,
  /** USD per 1M tokens, standard tier, short context. */
  models: {
    "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
    "gpt-6.1-terra": { input: 1.0, cachedInput: 0.05, output: 5.0 },
    "chat-latest": { input: 5.0, cachedInput: 0.5, output: 30.0 },
    /** Dated snapshots (the only genuinely pinned IDs found, 2026-11-11). */
    "gpt-5.5-2026-04-23": { input: 5.0, cachedInput: 0.5, output: 30.0 },
    "gpt-5.4-2026-03-05": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  },
} as const;

export type PricedModel = keyof typeof OPENAI_PRICE_TABLE.models;

/** Usage read from a stored Responses body. Null where the provider did not report it. */
export interface ChatGptUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** Included in outputTokens; reported separately for analysis. */
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** Every web_search_call item; each is billed as a call (an upper bound if OpenAI bills fewer). */
  webSearchCalls: number;
  /** web_search_call items whose action is a search (as opposed to opening a page). */
  searchActions: number;
  /** Whether the model searched at all on this run. */
  searchOccurred: boolean;
}

const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Total: any shape yields a usage object; unreported fields are null, never 0. */
export function chatGptUsageFromBody(body: unknown): ChatGptUsage {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const u = b.usage && typeof b.usage === "object" ? (b.usage as Record<string, unknown>) : {};
  const inDetails = u.input_tokens_details && typeof u.input_tokens_details === "object" ? (u.input_tokens_details as Record<string, unknown>) : {};
  const outDetails = u.output_tokens_details && typeof u.output_tokens_details === "object" ? (u.output_tokens_details as Record<string, unknown>) : {};
  const output = Array.isArray(b.output) ? (b.output as Array<Record<string, unknown>>) : [];
  const calls = output.filter((i) => i?.type === "web_search_call");
  const searchActions = calls.filter((i) => {
    const a = i.action && typeof i.action === "object" ? (i.action as Record<string, unknown>) : null;
    return a?.type === "search";
  }).length;
  return {
    inputTokens: nonNegInt(u.input_tokens),
    cachedInputTokens: nonNegInt(inDetails.cached_tokens),
    outputTokens: nonNegInt(u.output_tokens),
    reasoningTokens: nonNegInt(outDetails.reasoning_tokens),
    totalTokens: nonNegInt(u.total_tokens),
    webSearchCalls: calls.length,
    searchActions,
    searchOccurred: calls.length > 0,
  };
}

export type CostEstimate =
  | { usd: number; basis: "estimated_from_usage"; priceTable: string }
  | { usd: null; basis: "unknown"; reason: "model_not_priced" | "usage_missing" };

/**
 * Cost of one run under the price table, keyed by the REQUESTED model (the
 * price row), not the served snapshot name. Cached input is billed at the
 * cached rate when reported; an unreported cached count is treated as no
 * caching (the higher, uncached rate). Search content tokens are part of
 * input tokens and billed at the model's input rate.
 */
export function estimateChatGptCostUsd(model: string, usage: ChatGptUsage): CostEstimate {
  const price = (OPENAI_PRICE_TABLE.models as Record<string, { input: number; cachedInput: number; output: number }>)[model];
  if (!price) return { usd: null, basis: "unknown", reason: "model_not_priced" };
  if (usage.inputTokens === null || usage.outputTokens === null) return { usd: null, basis: "unknown", reason: "usage_missing" };
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const usd =
    ((usage.inputTokens - cached) * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000 +
    usage.webSearchCalls * OPENAI_PRICE_TABLE.webSearchPerCallUsd;
  return { usd: Math.round(usd * 1e6) / 1e6, basis: "estimated_from_usage", priceTable: OPENAI_PRICE_TABLE.version };
}

/**
 * A deliberately pessimistic ceiling for one run, used to reserve budget
 * before a call: a full search context of input (128k), the whole output
 * cap, and ASSUMED_MAX_SEARCH_CALLS searches. Not a guarantee — a run that
 * exceeds it must stop the caller (see the benchmark).
 */
export const ASSUMED_MAX_INPUT_TOKENS = 128_000;
export const ASSUMED_MAX_SEARCH_CALLS = 10;

export function worstCaseRunUsd(model: string, maxOutputTokens: number): number | null {
  const price = (OPENAI_PRICE_TABLE.models as Record<string, { input: number; output: number }>)[model];
  if (!price) return null;
  return (
    Math.round(
      ((ASSUMED_MAX_INPUT_TOKENS * price.input + maxOutputTokens * price.output) / 1_000_000 +
        ASSUMED_MAX_SEARCH_CALLS * OPENAI_PRICE_TABLE.webSearchPerCallUsd) * 1e6
    ) / 1e6
  );
}

/**
 * A TYPICAL run, for planning estimates only (never for reservation): the
 * medians observed in the first benchmark (2026-11-11) — about 12,000 input
 * tokens of which about 4,400 cached, one search call — with output set to
 * 2,500 tokens, above the largest median output seen (chat-latest, ~2,300).
 */
export const TYPICAL_RUN_ASSUMPTION = { inputTokens: 12_000, cachedInputTokens: 4_400, outputTokens: 2_500, webSearchCalls: 1 } as const;

export function typicalRunUsd(model: string): number | null {
  const u = TYPICAL_RUN_ASSUMPTION;
  const est = estimateChatGptCostUsd(model, {
    inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, outputTokens: u.outputTokens,
    reasoningTokens: null, totalTokens: null, webSearchCalls: u.webSearchCalls, searchActions: u.webSearchCalls, searchOccurred: true,
  });
  return est.usd;
}
