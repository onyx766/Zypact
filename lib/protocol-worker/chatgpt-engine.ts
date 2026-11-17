/**
 * D-056 — builds the ChatGPT engine the worker is given when
 * WORKER_CHATGPT_ENABLED is exactly "true".
 *
 * The only worker module that imports the adapter (lib/probes/chatgpt.ts).
 * scripts/run-protocol-worker.ts imports THIS file dynamically, inside the
 * live branch and only when the switch is on, so with the switch off the
 * adapter is never loaded. worker.ts and execute-job.ts reach ChatGPT only
 * through the injected engine (types.ts ChatGptEngine).
 *
 * Pure apart from the adapter it wraps: no environment read here, no fetch.
 */

import type { ProbeMode } from "@/lib/db/types";
import {
  approvedChatGptSetting,
  chatGptOutputText,
  isServedModelOf,
  runChatGptProbe,
  type ChatGptSetting,
} from "@/lib/probes/chatgpt";
import { worstCaseRunUsd } from "@/lib/probes/chatgpt-pricing";
import type { ChatGptEngine } from "@/lib/protocol-worker/types";

/**
 * The answer in a stored Responses body under `setting`, or null. Re-checks
 * what the adapter checked before accepting the answer, so a stored body can
 * never become an answer the adapter would have refused: a completed
 * response with no error, from the pinned model (or a dated snapshot of it),
 * served on the setting's tier, with non-empty output text.
 */
export function chatGptAnswerFromBody(setting: ChatGptSetting, raw: string | null): string | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const body = json as Record<string, unknown>;
  if (body.object !== "response" || body.status !== "completed") return null;
  if (body.error !== undefined && body.error !== null) return null;
  if (typeof body.model !== "string" || !isServedModelOf(setting.model, body.model)) return null;
  if (setting.serviceTier !== null && body.service_tier !== setting.serviceTier) return null;
  const text = chatGptOutputText(body.output).trim();
  return text.length === 0 ? null : text;
}

/**
 * The engine for the approved automatic-search setting, or null when there
 * is none or its worst case cannot be priced (the caller then refuses to
 * start). `runProbe` is injectable for tests; the worker uses the adapter.
 */
export function buildChatGptEngine(args: {
  callTimeoutMs: number;
  probeMode: ProbeMode;
  runProbe?: typeof runChatGptProbe;
}): ChatGptEngine | null {
  const setting = approvedChatGptSetting("auto");
  if (!setting) return null;
  const reserved = worstCaseRunUsd(setting.model, setting.maxOutputTokens);
  if (reserved === null || !(reserved > 0)) return null;
  if (!Number.isSafeInteger(args.callTimeoutMs) || args.callTimeoutMs <= 0) return null;
  const run = args.runProbe ?? runChatGptProbe;
  return {
    // The setting is passed explicitly on every call: the run is pinned to
    // exactly the version the protocol named, never re-read from a constant.
    runProbe: (input) => run({ ...input, setting }),
    settingVersion: setting.version,
    model: setting.model,
    callTimeoutMs: args.callTimeoutMs,
    reservedCostUsd: reserved,
    probeMode: args.probeMode,
    answerFromBody: (raw) => chatGptAnswerFromBody(setting, raw),
  };
}
