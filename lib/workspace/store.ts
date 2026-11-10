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

/* P2 (D-047): draft buyer questions and the customer's action log. */

export const DRAFT_CATEGORIES = ["discovery", "comparison", "evaluation", "use_case"] as const;
export type DraftCategory = (typeof DRAFT_CATEGORIES)[number];
export type DraftOrigin = "customer_written" | "suggested" | "suggestion_edited";
export type DraftStatus = "draft" | "archived";

export interface QuestionDraft {
  id: string;
  version: number;
  text: string;
  category: DraftCategory;
  origin: DraftOrigin;
  suggestionRule: string | null;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
}

export const ACTION_STATUSES = ["open", "in_progress", "done", "dismissed"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export type ActionEvidence =
  | {
      kind: "site_diagnostic_finding";
      runId: string;
      checkId: string;
      state: StoredFinding["state"];
      excerpt: string | null;
      pageUrl: string | null;
      ruleVersion: string;
      runCompletedAt: string | null;
    }
  | { kind: "customer_note"; note: string };

export interface ActionFields {
  title: string;
  observation: string;
  whyItMatters: string | null;
  nextStep: string;
  ownerName: string | null;
}

export interface WorkspaceAction extends ActionFields {
  id: string;
  version: number;
  status: ActionStatus;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: ActionEvidence;
}

/** Names one stored finding; the database resolves it inside the session's workspace. */
export interface FindingRef {
  runId: string;
  checkId: string;
  pageUrl: string | null;
}

export type AddDraftStatus = "ADDED" | "DUPLICATE" | "LIMIT_REACHED" | "NOT_SIGNED_IN";
export type ReviseStatus = "SAVED" | "UNCHANGED" | "VERSION_CONFLICT" | "NOT_FOUND" | "DUPLICATE" | "LIMIT_REACHED" | "NOT_SIGNED_IN";
export type CreateActionStatus = "CREATED" | "ALREADY_TRACKED" | "EVIDENCE_NOT_FOUND" | "LIMIT_REACHED" | "NOT_SIGNED_IN";

export interface WorkspaceStore {
  setWebsite(token: string, accountId: string, domain: string, companyName: string): Promise<"SET" | "ALREADY_SET" | "DIFFERENT_WEBSITE_SET" | "NOT_SIGNED_IN">;
  takeDiagnosticRateLimit(kind: "account" | "ip" | "domain", key: string, keyId: string, windowSeconds: number, max: number): Promise<boolean>;
  recordDiagnostic(token: string, accountId: string, rows: Q2p2Rows): Promise<{ status: "RECORDED" | "NO_WEBSITE" | "DOMAIN_MISMATCH" | "NOT_SIGNED_IN"; runId: string | null }>;
  getDiagnostic(token: string, accountId: string, runId?: string | null): Promise<StoredDiagnostic | NotSignedIn | { status: "NONE" }>;
  saveProfile(token: string, accountId: string, expectedVersion: number, profile: ProfileInput): Promise<{ status: "SAVED" | "VERSION_CONFLICT" | "NO_WEBSITE" | "NOT_SIGNED_IN"; version: number | null }>;
  getState(token: string, accountId: string): Promise<WorkspaceState | NotSignedIn>;
  addDraft(token: string, accountId: string, text: string, category: DraftCategory, suggestionRule: string | null): Promise<{ status: AddDraftStatus; draftId: string | null }>;
  reviseDraft(token: string, accountId: string, draftId: string, expectedVersion: number, text: string, category: DraftCategory, status: DraftStatus): Promise<{ status: ReviseStatus; version: number | null }>;
  listDrafts(token: string, accountId: string): Promise<QuestionDraft[] | NotSignedIn>;
  createAction(token: string, accountId: string, evidence: FindingRef | { note: string }, fields: ActionFields): Promise<{ status: CreateActionStatus; actionId: string | null }>;
  reviseAction(token: string, accountId: string, actionId: string, expectedVersion: number, fields: ActionFields, status: ActionStatus, decisionNote: string | null): Promise<{ status: ReviseStatus; version: number | null }>;
  listActions(token: string, accountId: string): Promise<WorkspaceAction[] | NotSignedIn>;
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

    async addDraft(token, accountId, text, category, suggestionRule) {
      const row = await rpcRow<{ status: AddDraftStatus; draft_id: string | null }>(
        client.rpc("add_question_draft", { p_token: token, p_account_id: accountId, p_text: text, p_category: category, p_suggestion_rule: suggestionRule })
      );
      return { status: row.status, draftId: row.draft_id };
    },
    async reviseDraft(token, accountId, draftId, expectedVersion, text, category, status) {
      const row = await rpcRow<{ status: ReviseStatus; version: number | null }>(
        client.rpc("revise_question_draft", {
          p_token: token,
          p_account_id: accountId,
          p_draft_id: draftId,
          p_expected_version: expectedVersion,
          p_text: text,
          p_category: category,
          p_status: status,
        })
      );
      return { status: row.status, version: row.version };
    },
    async listDrafts(token, accountId) {
      const out = await rpcRow<Json>(client.rpc("list_question_drafts", { p_token: token, p_account_id: accountId }));
      if (out.status !== "OK") return { status: "NOT_SIGNED_IN" };
      return (out.drafts as Json[]).map((d) => ({
        id: String(d.id),
        version: Number(d.version),
        text: String(d.text),
        category: d.category as DraftCategory,
        origin: d.origin as DraftOrigin,
        suggestionRule: (d.suggestion_rule as string | null) ?? null,
        status: d.status as DraftStatus,
        createdAt: String(d.created_at),
        updatedAt: String(d.updated_at),
      }));
    },
    async createAction(token, accountId, evidence, fields) {
      const ref = "note" in evidence ? null : evidence;
      const row = await rpcRow<{ status: CreateActionStatus; action_id: string | null }>(
        client.rpc("create_workspace_action", {
          p_token: token,
          p_account_id: accountId,
          p_evidence_run_id: ref?.runId ?? null,
          p_evidence_check_id: ref?.checkId ?? null,
          p_evidence_page_url: ref?.pageUrl ?? null,
          p_evidence_note: "note" in evidence ? evidence.note : null,
          p_title: fields.title,
          p_observation: fields.observation,
          p_why_it_matters: fields.whyItMatters,
          p_next_step: fields.nextStep,
          p_owner_name: fields.ownerName,
        })
      );
      return { status: row.status, actionId: row.action_id };
    },
    async reviseAction(token, accountId, actionId, expectedVersion, fields, status, decisionNote) {
      const row = await rpcRow<{ status: ReviseStatus; version: number | null }>(
        client.rpc("revise_workspace_action", {
          p_token: token,
          p_account_id: accountId,
          p_action_id: actionId,
          p_expected_version: expectedVersion,
          p_title: fields.title,
          p_observation: fields.observation,
          p_why_it_matters: fields.whyItMatters,
          p_next_step: fields.nextStep,
          p_owner_name: fields.ownerName,
          p_status: status,
          p_decision_note: decisionNote,
        })
      );
      return { status: row.status, version: row.version };
    },
    async listActions(token, accountId) {
      const out = await rpcRow<Json>(client.rpc("list_workspace_actions", { p_token: token, p_account_id: accountId }));
      if (out.status !== "OK") return { status: "NOT_SIGNED_IN" };
      return (out.actions as Json[]).map((a) => {
        const e = a.evidence as Json;
        const evidence: ActionEvidence =
          e.kind === "customer_note"
            ? { kind: "customer_note", note: String(e.note) }
            : {
                kind: "site_diagnostic_finding",
                runId: String(e.run_id),
                checkId: String(e.check_id),
                state: e.state as StoredFinding["state"],
                excerpt: (e.excerpt as string | null) ?? null,
                pageUrl: (e.page_url as string | null) ?? null,
                ruleVersion: String(e.rule_version),
                runCompletedAt: (e.run_completed_at as string | null) ?? null,
              };
        return {
          id: String(a.id),
          version: Number(a.version),
          title: String(a.title),
          observation: String(a.observation),
          whyItMatters: (a.why_it_matters as string | null) ?? null,
          nextStep: String(a.next_step),
          ownerName: (a.owner_name as string | null) ?? null,
          status: a.status as ActionStatus,
          decisionNote: (a.decision_note as string | null) ?? null,
          createdAt: String(a.created_at),
          updatedAt: String(a.updated_at),
          evidence,
        };
      });
    },
  };
}
