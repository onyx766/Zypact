/**
 * Building protocol reports for requests whose scan has finished.
 *
 * Two callers share this module, so the rules below cannot drift apart:
 *
 *   - `scripts/run-report-delivery-worker.ts`, the standalone report worker;
 *   - `scripts/run-protocol-worker.ts`, which runs ONE pass after its scan
 *     loop stops. Without that pass a scan started from the admin console
 *     succeeded and then produced no report, because nothing else ran.
 *
 * Nothing here calls a provider that charges per call. Email is sent only
 * when SNAPSHOT_AUTO_DELIVERY_ENABLED is exactly "true".
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicSiteUrl } from "@/lib/seo/site";
import {
  findDeliverableRequests,
  processProtocolReport,
  type ProcessResult,
} from "@/lib/reports/deliver-protocol-report";
import type { ClientReportDeliveryConfig } from "@/lib/snapshot-requests/client-report-delivery";

export type ReportPassLog = (event: string, fields?: Record<string, unknown>) => void;

export interface ReportPassConfig {
  client: SupabaseClient;
  autoSendEnabled: boolean;
  deliveryConfig: ClientReportDeliveryConfig;
}

export type ResolvedReportPassConfig =
  | { ok: true; config: ReportPassConfig }
  | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

export function resolveReportPassConfig(
  env: Env,
  makeClient: (url: string, key: string) => SupabaseClient = (url, key) =>
    createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
): ResolvedReportPassConfig {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return {
      ok: false,
      reason:
        "Supabase service-role configuration is required: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    };
  }

  // Exactly "true". An unset, empty, or misspelled value leaves auto-send
  // off, so a typo can never start mailing customers.
  const autoSendEnabled = env.SNAPSHOT_AUTO_DELIVERY_ENABLED === "true";

  // Same origin as every other customer-email path (lib/seo/site.ts), so a
  // report sent by this worker and one sent from the admin console link to
  // the same host. Always resolves: unset falls back to the canonical host.
  const appBaseUrl = publicSiteUrl();
  const apiKey = env.RESEND_API_KEY ?? "";
  const from = env.SNAPSHOT_EMAIL_FROM ?? "";

  // Validated only when it will actually be used, so the dry pipeline runs on
  // a host with no mail credentials at all.
  if (autoSendEnabled) {
    if (!apiKey) return { ok: false, reason: "RESEND_API_KEY is required when auto-delivery is enabled." };
    if (!from) return { ok: false, reason: "SNAPSHOT_EMAIL_FROM is required when auto-delivery is enabled." };
  }

  return {
    ok: true,
    config: {
      client: makeClient(url, key),
      autoSendEnabled,
      deliveryConfig: { apiKey, from, appBaseUrl },
    },
  };
}

/** Outcomes that mean a human needs to look. */
export const ATTENTION: ReadonlySet<ProcessResult["outcome"]> = new Set([
  "held_blocked",
  "delivery_ambiguous",
  "delivery_rejected",
  "delivery_claim_unavailable",
]);

export function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error
      ? JSON.stringify(error)
      : String(error);
}

export interface ReportPassDeps {
  findDeliverableRequests: typeof findDeliverableRequests;
  processProtocolReport: typeof processProtocolReport;
}

const DEFAULT_DEPS: ReportPassDeps = { findDeliverableRequests, processProtocolReport };

/**
 * Processes each request in turn. One failing request never stops the rest.
 * `shouldStop` is read before every request, so a shutdown ends the batch at
 * a request boundary rather than halfway through one.
 */
export async function processReportRequests(
  config: ReportPassConfig,
  requestIds: string[],
  log: ReportPassLog,
  options: { shouldStop?: () => boolean; deps?: ReportPassDeps } = {}
): Promise<{ processed: number; needsAttention: number; failed: number; stopped: boolean }> {
  const deps = options.deps ?? DEFAULT_DEPS;
  let processed = 0;
  let needsAttention = 0;
  let failed = 0;

  for (const requestId of requestIds) {
    if (options.shouldStop?.()) return { processed, needsAttention, failed, stopped: true };

    try {
      const result = await deps.processProtocolReport(requestId, {
        client: config.client,
        autoSendEnabled: config.autoSendEnabled,
        deliveryConfig: config.deliveryConfig,
      });
      processed += 1;
      if (ATTENTION.has(result.outcome)) needsAttention += 1;

      log("report_processed", {
        requestId,
        outcome: result.outcome,
        integrityStatus: result.integrityStatus,
        integrityReasonCount: result.integrityReasons.length,
        artifactId: result.artifactId,
        needsAttention: ATTENTION.has(result.outcome),
        ...(result.detail ? { detail: result.detail } : {}),
      });
    } catch (error) {
      failed += 1;
      log("report_failed", { requestId, message: describeError(error) });
    }
  }

  return { processed, needsAttention, failed, stopped: false };
}

export const REPORT_PASS_LIMIT = 25;

/**
 * One pass over every succeeded, undelivered request. Never throws: the scan
 * that ran before it has already stored its evidence, and a report failure
 * must not be reported as a crashed worker. The next pass retries it.
 */
export async function runReportPass(input: {
  env: Env;
  log: ReportPassLog;
  shouldStop: () => boolean;
  resolveConfig?: (env: Env) => ResolvedReportPassConfig;
  deps?: ReportPassDeps;
}): Promise<void> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const resolved = (input.resolveConfig ?? resolveReportPassConfig)(input.env);

  if (!resolved.ok) {
    input.log("report_pass_configuration_rejected", { reason: resolved.reason });
    return;
  }

  const { config } = resolved;
  input.log("report_pass_started", {
    autoSendEnabled: config.autoSendEnabled,
    limit: REPORT_PASS_LIMIT,
  });

  let ids: string[];
  try {
    ids = await deps.findDeliverableRequests(config.client, REPORT_PASS_LIMIT);
  } catch (error) {
    input.log("report_pass_failed", { message: describeError(error) });
    return;
  }

  if (ids.length === 0) {
    input.log("report_pass_finished", { found: 0, processed: 0, needsAttention: 0, failed: 0, stopped: false });
    return;
  }

  const summary = await processReportRequests(config, ids, input.log, {
    shouldStop: input.shouldStop,
    deps,
  });
  input.log("report_pass_finished", { found: ids.length, ...summary });
}
