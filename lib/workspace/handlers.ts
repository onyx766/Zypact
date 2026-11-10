/**
 * P1 workspace handlers (D-046). Pure decisions over injected dependencies,
 * like lib/accounts/handlers.ts: the caller resolves the signed-in account
 * first, and the database re-checks its session on every call.
 *
 * No paid call and no model call. The diagnostic fetches only the workspace's
 * own website, through the W1 engine's existing bounds.
 */
import { createHmac } from "node:crypto";

import type { AccountContext } from "@/lib/accounts/handlers";
import type { DiagnosticResult } from "@/lib/site-diagnostic/engine";
import { REFUSAL_TEXT } from "@/lib/site-diagnostic/engine";
import { toQ2p2Rows, validateQ2p2Rows } from "@/lib/site-diagnostic/persistence-shape";
import { normalizeDiagnosticInput } from "@/lib/site-diagnostic/url";
import { OBJECTIVES, type Objective, type ProfileInput, type WorkspaceStore } from "@/lib/workspace/store";

export const DIAG_RATE_PURPOSE = "zypact.diag.rate_limit.v1";

/** One diagnostic run per bucket and window; every bucket must allow. */
export const DIAGNOSTIC_RATE_RULES: ReadonlyArray<{ kind: "account" | "ip" | "domain"; windowSeconds: number; max: number }> = [
  { kind: "account", windowSeconds: 86400, max: 3 },
  { kind: "domain", windowSeconds: 86400, max: 5 },
  { kind: "ip", windowSeconds: 86400, max: 10 },
];

export interface WorkspaceConfig {
  enabled: boolean;
  diagnosticEnabled: boolean;
  hmacSecret: string | null;
  hmacKeyId: string;
}

export interface WorkspaceDeps {
  config: WorkspaceConfig;
  store: WorkspaceStore;
  runDiagnostic(startUrl: string): Promise<DiagnosticResult>;
  log(entry: Record<string, string | number | boolean>): void;
}

export interface WorkspaceResult {
  status: number;
  body: Record<string, unknown>;
}

const json = (status: number, body: Record<string, unknown>): WorkspaceResult => ({ status, body });
const invalid = (field: string, message: string) => json(400, { ok: false, error: "invalid_input", field, message });
const notSignedIn = () => json(401, { ok: false, error: "not_signed_in", message: "Please sign in again." });

async function guarded(deps: WorkspaceDeps, event: string, account: AccountContext | null, token: string | null,
  run: (account: AccountContext, token: string) => Promise<WorkspaceResult>): Promise<WorkspaceResult> {
  if (!deps.config.enabled) return json(404, { ok: false, error: "not_found" });
  if (!account || !token) return notSignedIn();
  try {
    return await run(account, token);
  } catch {
    deps.log({ event, outcome: "error" });
    return json(500, { ok: false, error: "unavailable", message: "Something went wrong. Please try again." });
  }
}

export function diagnosticBucketKey(secret: string, kind: string, value: string): string {
  return createHmac("sha256", secret).update(`${DIAG_RATE_PURPOSE}\u001f${kind}\u001f${value}`).digest("hex");
}

const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= max ? text : null;
};
const tooLong = (value: unknown, max: number) => typeof value === "string" && value.trim().length > max;

/* ------------------------------------------------------------------ */
/* Website                                                              */
/* ------------------------------------------------------------------ */

export const INPUT_REFUSAL_TEXT: Record<string, string> = {
  empty: "Enter your website address.",
  invalid_url: "That doesn't look like a website address.",
  unsupported_protocol: "Use an http or https address.",
  embedded_credentials: "Remove the username or password from the address.",
  non_default_port: "Use the address without a port number.",
  ip_literal: "Use your domain name, not an IP address.",
  reserved_hostname: "That address is not a public website.",
  invalid_domain: "That domain name isn't valid.",
};

export function handleSetWebsite(
  deps: WorkspaceDeps,
  account: AccountContext | null,
  token: string | null,
  input: { website?: unknown; companyName?: unknown }
): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_set_website", account, token, async (acct, tok) => {
    const normalized = normalizeDiagnosticInput(typeof input.website === "string" ? input.website : "");
    if (!normalized.ok) return invalid("website", INPUT_REFUSAL_TEXT[normalized.reason] ?? "That address can't be used.");
    const company = clean(input.companyName, 120);
    if (!company) return invalid("companyName", "Enter your company name (up to 120 characters).");

    const status = await deps.store.setWebsite(tok, acct.accountId, normalized.value.normalizedDomain, company);
    deps.log({ event: "workspace_set_website", outcome: status.toLowerCase() });
    if (status === "NOT_SIGNED_IN") return notSignedIn();
    if (status === "DIFFERENT_WEBSITE_SET") {
      return json(409, {
        ok: false,
        error: "website_already_set",
        message: "Your workspace already has a website. Contact Zypact if it needs to change.",
      });
    }
    return json(200, { ok: true, redirect: "/account/website" });
  });
}

/* ------------------------------------------------------------------ */
/* Diagnostic                                                           */
/* ------------------------------------------------------------------ */

export function handleRunDiagnostic(
  deps: WorkspaceDeps,
  account: AccountContext | null,
  token: string | null,
  ctx: { ip: string }
): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_run_diagnostic", account, token, async (acct, tok) => {
    if (!deps.config.diagnosticEnabled) {
      return json(503, { ok: false, error: "diagnostic_unavailable", message: "The website diagnostic isn't available yet." });
    }
    const secret = deps.config.hmacSecret;
    if (!secret) {
      deps.log({ event: "workspace_run_diagnostic", outcome: "rate_limit_unconfigured" });
      return json(503, { ok: false, error: "unavailable", message: "The website diagnostic isn't available right now." });
    }
    const state = await deps.store.getState(tok, acct.accountId);
    if (state.status !== "OK") return notSignedIn();
    if (!state.website) return json(409, { ok: false, error: "no_website", message: "Add your website first." });
    const domain = state.website.domain;

    const values = { account: acct.accountId, domain, ip: ctx.ip };
    for (const rule of DIAGNOSTIC_RATE_RULES) {
      const allowed = await deps.store.takeDiagnosticRateLimit(
        rule.kind, diagnosticBucketKey(secret, rule.kind, values[rule.kind]), deps.config.hmacKeyId, rule.windowSeconds, rule.max);
      if (!allowed) {
        deps.log({ event: "workspace_run_diagnostic", outcome: "rate_limited" });
        return json(429, { ok: false, error: "rate_limited", message: "You've reached today's limit for website checks. Try again tomorrow." });
      }
    }

    const result = await deps.runDiagnostic(`https://${domain}/`);
    if (!result.ok) {
      deps.log({ event: "workspace_run_diagnostic", outcome: `refused_${result.refusal}` });
      return json(422, { ok: false, error: result.refusal, message: REFUSAL_TEXT[result.refusal] });
    }
    const rows = toQ2p2Rows(result.report);
    const problems = validateQ2p2Rows(rows);
    if (problems.length > 0) {
      deps.log({ event: "workspace_run_diagnostic", outcome: "rows_invalid", problems: problems.length });
      return json(500, { ok: false, error: "unavailable", message: "The result could not be saved. Please try again." });
    }
    const recorded = await deps.store.recordDiagnostic(tok, acct.accountId, rows);
    deps.log({ event: "workspace_run_diagnostic", outcome: recorded.status.toLowerCase(), pages: rows.pages.length });
    if (recorded.status === "NOT_SIGNED_IN") return notSignedIn();
    if (recorded.status !== "RECORDED") {
      return json(409, { ok: false, error: recorded.status.toLowerCase(), message: "The result does not match your workspace's website." });
    }
    return json(200, { ok: true, runId: recorded.runId, redirect: "/account/website" });
  });
}

/* ------------------------------------------------------------------ */
/* Brand Profile                                                        */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseProfileInput(input: Record<string, unknown>):
  | { ok: true; expectedVersion: number; profile: ProfileInput }
  | { ok: false; field: string; message: string } {
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { ok: false, field: "expectedVersion", message: "Reload the page and try again." };

  const companyName = clean(input.companyName, 120);
  if (!companyName) return { ok: false, field: "companyName", message: "Enter your company name (up to 120 characters)." };
  for (const [field, max] of [["description", 1000], ["category", 120], ["audience", 300]] as const) {
    if (tooLong(input[field], max)) return { ok: false, field, message: `Keep this under ${max} characters.` };
  }

  const rawCompetitors = Array.isArray(input.competitors)
    ? input.competitors
    : typeof input.competitors === "string"
      ? input.competitors.split(/[\n,]/)
      : [];
  const competitors: string[] = [];
  for (const raw of rawCompetitors) {
    const name = clean(raw, 80);
    if (raw !== undefined && typeof raw === "string" && raw.trim() !== "" && !name) {
      return { ok: false, field: "competitors", message: "Keep each competitor name under 80 characters." };
    }
    if (name && !competitors.some((c) => c.toLowerCase() === name.toLowerCase())) competitors.push(name);
  }
  if (competitors.length > 10) return { ok: false, field: "competitors", message: "List up to 10 competitors." };

  const objective = input.objective === "" || input.objective === null || input.objective === undefined ? null : input.objective;
  if (objective !== null && !OBJECTIVES.includes(objective as Objective)) return { ok: false, field: "objective", message: "Choose one of the listed goals." };

  const basedOn = input.basedOnRunId === "" || input.basedOnRunId === null || input.basedOnRunId === undefined ? null : input.basedOnRunId;
  if (basedOn !== null && (typeof basedOn !== "string" || !UUID_RE.test(basedOn))) return { ok: false, field: "basedOnRunId", message: "Reload the page and try again." };

  return {
    ok: true,
    expectedVersion,
    profile: {
      companyName,
      description: clean(input.description, 1000),
      category: clean(input.category, 120),
      audience: clean(input.audience, 300),
      competitors,
      objective: objective as Objective | null,
      basedOnRunId: basedOn as string | null,
    },
  };
}

export function handleSaveProfile(
  deps: WorkspaceDeps,
  account: AccountContext | null,
  token: string | null,
  input: Record<string, unknown>
): Promise<WorkspaceResult> {
  return guarded(deps, "workspace_save_profile", account, token, async (acct, tok) => {
    const parsed = parseProfileInput(input);
    if (!parsed.ok) return invalid(parsed.field, parsed.message);
    const saved = await deps.store.saveProfile(tok, acct.accountId, parsed.expectedVersion, parsed.profile);
    deps.log({ event: "workspace_save_profile", outcome: saved.status.toLowerCase() });
    if (saved.status === "NOT_SIGNED_IN") return notSignedIn();
    if (saved.status === "NO_WEBSITE") return json(409, { ok: false, error: "no_website", message: "Add your website first." });
    if (saved.status === "VERSION_CONFLICT") {
      return json(409, { ok: false, error: "version_conflict", message: "This profile was changed somewhere else. Reload the page to see the latest version." });
    }
    return json(200, { ok: true, version: saved.version, redirect: "/account" });
  });
}
