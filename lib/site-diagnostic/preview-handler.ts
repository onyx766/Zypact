/**
 * Founder-only W1 preview: the route handler's logic, with its guard and
 * engine injected so scripts/test-w1-preview.ts can drive it offline.
 *
 * Not customer-facing (S1 and G1 gate that). Stateless: it runs the engine
 * in memory and returns the frozen report; it writes nothing, to the Q2′
 * tables or anywhere else.
 *
 * Order matters and is tested: the kill switch, then the founder guard, and
 * only then is the request body read.
 *
 * Logs carry closed fields only: never the URL, the domain, page content or
 * an error message.
 */
import { NextResponse } from "next/server";

import { REFUSAL_TEXT, type DiagnosticResult } from "@/lib/site-diagnostic/engine";
import { exportReportMarkdown } from "@/lib/site-diagnostic/export";
import { normalizeDiagnosticInput } from "@/lib/site-diagnostic/url";

export const W1_PREVIEW_ROUTE = "/api/internal/site-diagnostics/preview";
export const W1_PREVIEW_ENV = "ZYPACT_W1_PREVIEW_ENABLED";
export const W1_PREVIEW_MAX_BODY_BYTES = 8 * 1024;
/** Per-domain pause between preview runs, per server instance. */
export const W1_PREVIEW_DOMAIN_COOLDOWN_MS = 30_000;

export type PreviewGuard = () => Promise<
  { ok: true; user: { id: string } } | { ok: false; response: NextResponse }
>;

export interface PreviewDeps {
  enabled: () => boolean;
  guard: PreviewGuard;
  run: (url: string, signal: AbortSignal) => Promise<DiagnosticResult>;
  now?: () => number;
  log?: (entry: Record<string, string | number | boolean | null>) => void;
}

/** Module-level, so it spans requests within one instance only. */
const lastRunByDomain = new Map<string, number>();

export function resetPreviewCooldownsForTests(): void {
  lastRunByDomain.clear();
}

export function previewEnabledFromEnv(): boolean {
  return process.env[W1_PREVIEW_ENV] === "true";
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

export async function handleW1Preview(request: Request, deps: PreviewDeps): Promise<NextResponse> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((entry) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry })));

  // 1. Kill switch, before anything else (default off on every environment).
  if (!deps.enabled()) return json(503, { ok: false, error: "preview_disabled" });

  // 2. Founder only. 401 / 404 / 503 come from the guard unchanged.
  const guard = await deps.guard();
  if (!guard.ok) return guard.response;

  // 3. Only now read the body: JSON, small.
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return json(415, { ok: false, error: "unsupported_media_type" });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > W1_PREVIEW_MAX_BODY_BYTES) return json(413, { ok: false, error: "request_too_large" });
  let url: unknown;
  try {
    url = (JSON.parse(raw) as { url?: unknown }).url;
  } catch {
    return json(400, { ok: false, error: "invalid_request" });
  }
  if (typeof url !== "string" || url.length > 2048) return json(400, { ok: false, error: "invalid_request" });

  const normalized = normalizeDiagnosticInput(url);
  if (!normalized.ok) {
    return json(422, { ok: false, error: normalized.reason, message: REFUSAL_TEXT[normalized.reason] });
  }
  const domain = normalized.value.normalizedDomain;
  const last = lastRunByDomain.get(domain);
  if (last !== undefined && now() - last < W1_PREVIEW_DOMAIN_COOLDOWN_MS) {
    return json(429, { ok: false, error: "rate_limited", retryAfterMs: W1_PREVIEW_DOMAIN_COOLDOWN_MS - (now() - last) });
  }
  lastRunByDomain.set(domain, now());

  const started = now();
  const controller = new AbortController();
  request.signal?.addEventListener("abort", () => controller.abort());
  try {
    const result = await deps.run(url, controller.signal);
    if (!result.ok) {
      log({ event: "w1_preview_refused", refusal: result.refusal, userId: guard.user.id });
      return json(422, { ok: false, error: result.refusal, message: REFUSAL_TEXT[result.refusal] });
    }
    const { report } = result;
    log({
      event: "w1_preview_run",
      userId: guard.user.id,
      outcome: report.run.outcome,
      stopReason: report.run.stopReason,
      pageCount: report.pages.length,
      requestCount: report.run.requestCount,
      durationMs: now() - started,
    });
    return json(200, { ok: true, report, markdown: exportReportMarkdown(report) });
  } catch (error) {
    log({ event: "w1_preview_error", userId: guard.user.id, errorName: error instanceof Error ? error.name : "unknown" });
    return json(500, { ok: false, error: "internal_error" });
  }
}
