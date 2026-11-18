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
 * D-061 — it also holds the startup check that the connected database can
 * record a ChatGPT attempt (`checkChatGptSchema`). Living here, it is loaded
 * only with the switch on, so with the switch off it is never called.
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

/**
 * D-061 — the capability a ChatGPT attempt needs from the connected schema:
 * the probe mode 20261109180000 adds to the probe_runs and probe_results
 * CHECKs (and, with it, persist taking the platform from the probe run).
 */
export const CHATGPT_SCHEMA_CAPABILITY = "live_openai_chatgpt";

export type ChatGptSchemaCheck =
  | { ready: true }
  /**
   * `capabilities_unreadable`: the read failed, which is what a database
   * without 20261109180000 gives (PostgREST has no such function).
   * `capability_missing`: the reply is not a list naming the capability.
   */
  | { ready: false; reason: "capabilities_unreadable" | "capability_missing" };

/**
 * D-061 — whether the connected database can record a ChatGPT attempt.
 * With the switch on, the worker entry point calls this at startup with the
 * adapter's `protocolWorkerCapabilities()` and refuses to start, before any
 * claim, unless it is ready. A read that throws (a missing function, an
 * unreachable database) is a refusal, never a pass: a worker switched on
 * ahead of the migration would otherwise fail its first ChatGPT attempt
 * after admission and reservation, at the probe-mode CHECK. The thrown value
 * is never inspected or logged; only the closed reason leaves this function.
 */
export async function checkChatGptSchema(readCapabilities: () => Promise<unknown>): Promise<ChatGptSchemaCheck> {
  let capabilities: unknown;
  try {
    capabilities = await readCapabilities();
  } catch {
    return { ready: false, reason: "capabilities_unreadable" };
  }
  if (!Array.isArray(capabilities) || !capabilities.includes(CHATGPT_SCHEMA_CAPABILITY)) {
    return { ready: false, reason: "capability_missing" };
  }
  return { ready: true };
}
