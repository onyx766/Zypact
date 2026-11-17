/**
 * D-056 — what differs between the engines a protocol can name, in one place.
 *
 * The worker's slot logic is the same for every engine: claim, admit and
 * reserve, mark the exact bytes as sent, call, write the receipt, analyse,
 * reconcile. What changes per engine is only:
 *
 *   runProbe         the adapter (chosen by probeRunnerForProtocol, before admission)
 *   platform         the probe_runs.platform label ('perplexity' | 'chatgpt', 0003)
 *   probeMode        the probe mode the attempt is recorded under
 *   callTimeoutMs    the deadline of the provider leg (the analysis leg keeps its own)
 *   reservedCostUsd  what admission reserves for the provider leg
 *   costFromBody     the cost read from the exact bytes about to become the receipt
 *   answerFromBody   the answer replayed from a stored body
 *   failureLabel     the closed label a definite provider failure is recorded under
 *
 * The Perplexity profile is exactly what the worker did before this module:
 * the same runner, `platform: "perplexity"`, the injected probe mode, the
 * configured provider timeout and reservation, the MEASURED cost from
 * `usage.cost.total_cost`, the same answer reader, and the failure's own
 * reason as its label.
 *
 * The ChatGPT profile comes from the injected engine (types.ts) and the pure
 * pricing module. This file never imports lib/probes/chatgpt.ts: the adapter
 * is loaded only by chatgpt-engine.ts, and only when the switch is on.
 */

import type { CostBasis, ProbeMode } from "@/lib/db/types";
import type { ChatGptEngine, PerplexityProbeRunner, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import { chatGptUsageFromBody, estimateChatGptCostUsd } from "@/lib/probes/chatgpt-pricing";
import { isFlexResourceUnavailable } from "@/lib/probes/openai-flex";
import type { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import {
  answerFromRawResponseBody,
  measuredCostUsdFromRawResponseBody,
} from "@/lib/protocol-worker/worker";

/** The protocol provider value of the ChatGPT engine (lib/probes/chatgpt.ts CHATGPT_PROVIDER; pinned equal by test). */
export const CHATGPT_PROTOCOL_PROVIDER = "openai_chatgpt";

/** The label a flex capacity refusal (unbilled 429) is recorded under. */
export const FLEX_CAPACITY_UNAVAILABLE = "flex_capacity_unavailable";

/** A cost and its basis, as the receipt RPC takes them as a pair (0050's pair check). */
export interface ReceiptCost {
  readonly actualCostUsd: number;
  readonly costBasis: Exclude<CostBasis, "unknown">;
}

export interface ProviderProfile {
  readonly engine: "perplexity" | "chatgpt";
  readonly runProbe: PerplexityProbeRunner;
  readonly platform: "perplexity" | "chatgpt";
  readonly probeMode: ProbeMode;
  readonly callTimeoutMs: number;
  readonly reservedCostUsd: number;
  /** Null when no cost can be read: the receipt then records an honest unknown. */
  costFromBody(raw: string | null | undefined): ReceiptCost | null;
  answerFromBody(raw: string | null): string | null;
  /** The closed label of a definite (http_error / empty_answer) provider failure. */
  failureLabel(e: PerplexityProbeFailure): string;
}

function measuredPerplexityCost(raw: string | null | undefined): ReceiptCost | null {
  const usd = measuredCostUsdFromRawResponseBody(raw);
  return usd === null ? null : { actualCostUsd: usd, costBasis: "measured" };
}

/**
 * ChatGPT: estimated from the usage the stored body reports, priced by the
 * REQUESTED model's row under the dated price table, at the tier the body
 * names. Upper bound on flex (see chatgpt-pricing.ts). Null when the body is
 * absent, not JSON, or reports no usage: the receipt then records an unknown
 * cost, which every cap and the daily ceiling count at the reservation.
 *
 * The price-table version behind the estimate is not stored: the ledger has
 * no column for it. It is OPENAI_PRICE_TABLE.version at the time of the call.
 */
export function estimatedChatGptCost(model: string, raw: string | null | undefined): ReceiptCost | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const estimate = estimateChatGptCostUsd(model, chatGptUsageFromBody(json));
  return estimate.basis === "estimated_from_usage" ? { actualCostUsd: estimate.usd, costBasis: "estimated" } : null;
}

export function perplexityProfile(
  runProbe: PerplexityProbeRunner,
  deps: Pick<WorkerDeps, "probeMode">,
  opts: Pick<WorkerOptions, "providerTimeoutMs" | "perplexityReservedCostUsd">
): ProviderProfile {
  return {
    engine: "perplexity",
    runProbe,
    platform: "perplexity",
    probeMode: deps.probeMode,
    callTimeoutMs: opts.providerTimeoutMs,
    reservedCostUsd: opts.perplexityReservedCostUsd,
    costFromBody: measuredPerplexityCost,
    answerFromBody: answerFromRawResponseBody,
    failureLabel: (e) => e.reason,
  };
}

export function chatGptProfile(engine: ChatGptEngine): ProviderProfile {
  return {
    engine: "chatgpt",
    runProbe: engine.runProbe,
    platform: "chatgpt",
    probeMode: engine.probeMode,
    callTimeoutMs: engine.callTimeoutMs,
    reservedCostUsd: engine.reservedCostUsd,
    costFromBody: (raw) => estimatedChatGptCost(engine.model, raw),
    answerFromBody: (raw) => engine.answerFromBody(raw),
    // An unbilled flex capacity refusal is an ordinary known failure with
    // its own label: one fetch, a failed attempt, the reservation kept, and
    // the founder's Retry (D-052) as the way on. Nothing resends it here.
    failureLabel: (e) => (isFlexResourceUnavailable(e.httpStatus, e.errorBody) ? FLEX_CAPACITY_UNAVAILABLE : e.reason),
  };
}

/** The profile of the engine probeRunnerForProtocol chose. */
export function providerProfileFor(
  routed: { runProbe: PerplexityProbeRunner; engine: "perplexity" | "chatgpt" },
  deps: Pick<WorkerDeps, "probeMode" | "chatgpt">,
  opts: Pick<WorkerOptions, "providerTimeoutMs" | "perplexityReservedCostUsd">
): ProviderProfile | null {
  if (routed.engine === "chatgpt") return deps.chatgpt ? chatGptProfile(deps.chatgpt) : null;
  return perplexityProfile(routed.runProbe, deps, opts);
}
