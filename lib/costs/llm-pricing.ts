/**
 * What an analysis model call cost, estimated from the token counts the
 * provider reported and a versioned price list.
 *
 * Perplexity reports its own charge (`usage.cost.total_cost`), recorded as
 * `measured`. OpenAI and Anthropic report token counts only, so the cost of
 * an analysis call can at best be ESTIMATED, and is recorded with
 * cost_basis `estimated` — never `measured`. 0050 and 0058 already pair
 * `actual_cost_usd` with a basis and accept `estimated`; no schema change is
 * needed to store it.
 *
 * Fail closed: any model not listed here exactly, any missing or malformed
 * token count, and any mock call yields null. A null cost leaves the ledger
 * row's actual cost unknown, and the paid-execution gate then counts the
 * reservation instead — so a pricing gap can never make spend look smaller.
 *
 * The estimate charges every input token at the full input rate. Cached-
 * input discounts are ignored on purpose: overstating a cost is safe here,
 * understating it is not.
 */

/** Bump whenever a price below changes; recorded alongside each estimate in reviews. */
export const LLM_PRICE_TABLE_VERSION = "2026-10-28.1";

interface ModelPrice {
  provider: "openai" | "anthropic";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Where the price came from, so a reviewer can check it. */
  source: string;
}

/**
 * Exact model identifiers only — never a prefix or a family match, so a new
 * snapshot is unpriced (null) until someone adds it deliberately.
 *
 * gpt-4o-2024-08-06 is the analysis model every production protocol has
 * used (verified in production records, 2026-10-24/25). OpenAI's pricing
 * page lists "gpt-4o" at these rates; it does not list the dated snapshot
 * separately, so mapping the snapshot to them is an assumption awaiting
 * Founder approval (PR #2).
 */
const PRICES: Record<string, ModelPrice> = {
  "gpt-4o-2024-08-06": {
    provider: "openai",
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    source: "developers.openai.com/api/docs/pricing, gpt-4o standard, read 2026-10-28",
  },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The token counts a provider reported, or null when they are absent or not
 * clean non-negative integers. Anthropic's cache-creation and cache-read
 * input tokens are added to input; NOT conservative for cache writes, which
 * Anthropic bills above the base input rate — price them before listing a model.
 */
export function tokenUsageFromProviderJson(
  provider: "openai" | "anthropic",
  json: unknown
): TokenUsage | null {
  const usage = (json as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  if (provider === "openai") {
    if (!isTokenCount(u.prompt_tokens) || !isTokenCount(u.completion_tokens)) return null;
    return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
  }
  if (!isTokenCount(u.input_tokens) || !isTokenCount(u.output_tokens)) return null;
  let input = u.input_tokens;
  for (const extra of [u.cache_creation_input_tokens, u.cache_read_input_tokens]) {
    if (extra === undefined || extra === null) continue;
    if (!isTokenCount(extra)) return null;
    input += extra;
  }
  return { inputTokens: input, outputTokens: u.output_tokens };
}

/**
 * Estimated USD cost, rounded to 8 decimal places so the same response always
 * yields the same number (0058 compares it on a replayed receipt). Null
 * whenever it cannot be priced exactly.
 */
export function estimateLlmCostUsd(input: {
  provider: string;
  model: string | null | undefined;
  usage: TokenUsage | null | undefined;
}): number | null {
  if (input.provider !== "openai" && input.provider !== "anthropic") return null;
  if (!input.model || !input.usage) return null;
  const price = PRICES[input.model];
  if (!price || price.provider !== input.provider) return null;
  const { inputTokens, outputTokens } = input.usage;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return null;
  const usd =
    (inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion) / 1_000_000;
  if (!Number.isFinite(usd) || usd < 0) return null;
  return Math.round(usd * 1e8) / 1e8;
}
