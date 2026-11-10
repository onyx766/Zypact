/**
 * Server-only: the P1 workspace RPCs (20261110120000_p1_workspace_setup.sql).
 *
 * Every call carries the account session token and the account id the server
 * read from a verified Auth user; the database re-checks that session and
 * takes the workspace from it. Nothing here accepts a workspace id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { serviceClient } from "@/lib/accounts/store";
import type { Q2p2Rows } from "@/lib/site-diagnostic/persistence-shape";

export const OBJECTIVES = ["describe_product", "compare_competitors", "investigate_sources", "review_after_change"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export interface BrandProfile {
  version: number;
  companyName: string;
  description: string | null;
  category: string | null;
  audience: string | null;
  competitors: string[];
  objective: Objective | null;
  basedOnRunId: string | null;
  savedAt: string;
}

export interface WorkspaceState {
  status: "OK";
  workspace: { id: string; name: string };
  website: { domain: string; verification: string } | null;
  profile: BrandProfile | null;
  latestRun: {
    id: string;
    completedAt: string;
    outcome: string;
    pages: number;
    counts: { pass: number; issue: number; info: number; unknown: number };
  } | null;
}

export interface StoredFinding {
  checkId: string;
  state: "pass" | "issue" | "info" | "unknown";
  unknownReason: string | null;
  excerpt: string | null;
  pageUrl: string | null;
  ruleVersion: string;
}

export interface StoredDiagnostic {
  status: "OK";
  run: {
    id: string;
    normalizedDomain: string;
    startUrl: string;
    ruleSetVersion: string;
    crawlerVersion: string;
    pageCap: number;
    startedAt: string;
    completedAt: string;
    outcome: string;
    domainVerified: boolean;
  };
  pages: Array<{ pageIndex: number; url: string; httpStatus: number | null; contentType: string | null; bytes: number; robotsAllowed: boolean; fetchError: string | null }>;
  findings: StoredFinding[];
  history: Array<{ id: string; completedAt: string; outcome: string }>;
}

export type NotSignedIn = { status: "NOT_SIGNED_IN" };

export interface ProfileInput {
  companyName: string;
  description: string | null;
  category: string | null;
  audience: string | null;
  competitors: string[];
  objective: Objective | null;
  basedOnRunId: string | null;
}

export interface WorkspaceStore {
  setWebsite(token: string, accountId: string, domain: string, companyName: string): Promise<"SET" | "ALREADY_SET" | "DIFFERENT_WEBSITE_SET" | "NOT_SIGNED_IN">;
  takeDiagnosticRateLimit(kind: "account" | "ip" | "domain", key: string, keyId: string, windowSeconds: number, max: number): Promise<boolean>;
  recordDiagnostic(token: string, accountId: string, rows: Q2p2Rows): Promise<{ status: "RECORDED" | "NO_WEBSITE" | "DOMAIN_MISMATCH" | "NOT_SIGNED_IN"; runId: string | null }>;
  getDiagnostic(token: string, accountId: string, runId?: string | null): Promise<StoredDiagnostic | NotSignedIn | { status: "NONE" }>;
  saveProfile(token: string, accountId: string, expectedVersion: number, profile: ProfileInput): Promise<{ status: "SAVED" | "VERSION_CONFLICT" | "NO_WEBSITE" | "NOT_SIGNED_IN"; version: number | null }>;
  getState(token: string, accountId: string): Promise<WorkspaceState | NotSignedIn>;
}

async function rpcRow<T>(promise: PromiseLike<{ data: unknown; error: { code?: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`workspace: rpc failed (${error.code ?? "unknown"})`);
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined) throw new Error("workspace: rpc returned nothing");
  return row as T;
}

type Json = Record<string, unknown>;

function toProfile(p: Json | null): BrandProfile | null {
  if (!p) return null;
  return {
    version: Number(p.version),
    companyName: String(p.company_name),
    description: (p.description as string | null) ?? null,
    category: (p.category as string | null) ?? null,
    audience: (p.audience as string | null) ?? null,
    competitors: Array.isArray(p.competitors) ? (p.competitors as string[]) : [],
    objective: (p.objective as Objective | null) ?? null,
    basedOnRunId: (p.based_on_run_id as string | null) ?? null,
    savedAt: String(p.saved_at),
  };
}

export function supabaseWorkspaceStore(client: SupabaseClient = serviceClient()): WorkspaceStore {
  return {
    async setWebsite(token, accountId, domain, companyName) {
      const row = await rpcRow<{ status: "SET" | "ALREADY_SET" | "DIFFERENT_WEBSITE_SET" | "NOT_SIGNED_IN" }>(
        client.rpc("set_workspace_website", { p_token: token, p_account_id: accountId, p_domain: domain, p_company_name: companyName })
      );
      return row.status;
    },
    async takeDiagnosticRateLimit(kind, key, keyId, windowSeconds, max) {
      const row = await rpcRow<{ allowed: boolean }>(
        client.rpc("take_diagnostic_rate_limit", {
          p_bucket_kind: kind,
          p_bucket_key: key,
          p_key_id: keyId,
          p_window_seconds: windowSeconds,
          p_max: max,
        })
      );
      return row.allowed === true;
    },
    async recordDiagnostic(token, accountId, rows) {
      const row = await rpcRow<{ status: "RECORDED" | "NO_WEBSITE" | "DOMAIN_MISMATCH" | "NOT_SIGNED_IN"; run_id: string | null }>(
        client.rpc("record_site_diagnostic", {
          p_token: token,
          p_account_id: accountId,
          p_run: rows.run,
          p_pages: rows.pages,
          p_findings: rows.findings,
        })
      );
      return { status: row.status, runId: row.run_id };
    },
    async getDiagnostic(token, accountId, runId = null) {
      const d = await rpcRow<Json>(client.rpc("get_site_diagnostic", { p_token: token, p_account_id: accountId, p_run_id: runId }));
      if (d.status !== "OK") return { status: d.status as "NONE" | "NOT_SIGNED_IN" };
      const run = d.run as Json;
      return {
        status: "OK",
        run: {
          id: String(run.id),
          normalizedDomain: String(run.normalized_domain),
          startUrl: String(run.start_url),
          ruleSetVersion: String(run.rule_set_version),
          crawlerVersion: String(run.crawler_version),
          pageCap: Number(run.page_cap),
          startedAt: String(run.started_at),
          completedAt: String(run.completed_at),
          outcome: String(run.outcome),
          domainVerified: run.domain_verified === true,
        },
        pages: (d.pages as Json[]).map((p) => ({
          pageIndex: Number(p.page_index),
          url: String(p.url),
          httpStatus: p.http_status === null ? null : Number(p.http_status),
          contentType: (p.content_type as string | null) ?? null,
          bytes: Number(p.bytes),
          robotsAllowed: p.robots_allowed === true,
          fetchError: (p.fetch_error as string | null) ?? null,
        })),
        findings: (d.findings as Json[]).map((f) => ({
          checkId: String(f.check_id),
          state: f.state as StoredFinding["state"],
          unknownReason: (f.unknown_reason as string | null) ?? null,
          excerpt: (f.excerpt as string | null) ?? null,
          pageUrl: (f.page_url as string | null) ?? null,
          ruleVersion: String(f.rule_version),
        })),
        history: (d.history as Json[]).map((h) => ({ id: String(h.id), completedAt: String(h.completed_at), outcome: String(h.outcome) })),
      };
    },
    async saveProfile(token, accountId, expectedVersion, profile) {
      const row = await rpcRow<{ status: "SAVED" | "VERSION_CONFLICT" | "NO_WEBSITE" | "NOT_SIGNED_IN"; version: number | null }>(
        client.rpc("save_brand_profile", {
          p_token: token,
          p_account_id: accountId,
          p_expected_version: expectedVersion,
          p_company_name: profile.companyName,
          p_description: profile.description,
          p_category: profile.category,
          p_audience: profile.audience,
          p_competitors: profile.competitors,
          p_objective: profile.objective,
          p_based_on_run_id: profile.basedOnRunId,
        })
      );
      return { status: row.status, version: row.version };
    },
    async getState(token, accountId) {
      const s = await rpcRow<Json>(client.rpc("get_workspace_state", { p_token: token, p_account_id: accountId }));
      if (s.status !== "OK") return { status: "NOT_SIGNED_IN" };
      const run = s.latest_run as Json | null;
      return {
        status: "OK",
        workspace: s.workspace as { id: string; name: string },
        website: (s.website as WorkspaceState["website"]) ?? null,
        profile: toProfile((s.profile as Json | null) ?? null),
        latestRun: run
          ? {
              id: String(run.id),
              completedAt: String(run.completed_at),
              outcome: String(run.outcome),
              pages: Number(run.pages),
              counts: run.counts as { pass: number; issue: number; info: number; unknown: number },
            }
          : null,
      };
    },
  };
}
