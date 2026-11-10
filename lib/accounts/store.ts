/**
 * Server-only: the S1 database calls, through the service-role client.
 *
 * Every function here is a closed RPC granted to service_role alone
 * (20261109120000_s1_account_sessions.sql, and Q2′-1's F1). Callers decide
 * who the account is from a verified Auth user first; this module never
 * takes an identity from a request body.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { BucketKind, RatePurpose } from "@/lib/accounts/rate-limit";

export const SELF_SIGNUP_RULE_ID = "s1.self_signup";
export const SELF_SIGNUP_RULE_VERSION = "1";

export type OpenStatus = "OPENED" | "NO_MEMBERSHIP" | "AMBIGUOUS_MEMBERSHIP";
export type CheckStatus = "ACTIVE" | "NOT_FOUND" | "REVOKED" | "EXPIRED";

export interface ActiveSession {
  status: "ACTIVE";
  sessionId: string;
  workspaceId: string;
  membershipId: string;
  stepUpAt: string | null;
  absoluteExpiresAt: string;
}

export interface AccountStore {
  provisionWorkspace(accountId: string, name: string): Promise<"CREATED" | "ALREADY_CREATED" | "IDEMPOTENCY_KEY_CONFLICT">;
  openSession(accountId: string, token: string, absoluteSeconds: number, idleSeconds: number): Promise<OpenStatus>;
  checkSession(token: string, accountId: string): Promise<ActiveSession | { status: Exclude<CheckStatus, "ACTIVE"> }>;
  recordStepUp(token: string, accountId: string): Promise<"STEPPED_UP" | Exclude<CheckStatus, "ACTIVE">>;
  revokeSession(token: string): Promise<"REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND">;
  revokeAllForAccount(accountId: string, reason: "password_change" | "email_change" | "admin_revoke"): Promise<number>;
  takeRateLimit(purpose: RatePurpose, kind: BucketKind, key: string, keyId: string, windowSeconds: number, max: number): Promise<boolean>;
}

let cached: SupabaseClient | null = null;
/** Server-only service-role client for the closed S1/P1 RPCs. */
export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("accounts: Supabase service-role configuration is required.");
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

async function one<T>(promise: PromiseLike<{ data: unknown; error: { code?: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`accounts: rpc failed (${error.code ?? "unknown"})`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("accounts: rpc returned no row");
  return row as T;
}

export function supabaseAccountStore(client: SupabaseClient = serviceClient()): AccountStore {
  return {
    async provisionWorkspace(accountId, name) {
      const row = await one<{ status: "CREATED" | "ALREADY_CREATED" | "IDEMPOTENCY_KEY_CONFLICT" }>(
        client.rpc("create_workspace_with_owner", {
          p_account_id: accountId,
          p_name: name,
          p_idempotency_key: `${SELF_SIGNUP_RULE_ID}:${accountId}`,
          p_actor_type: "system",
          p_rule_id: SELF_SIGNUP_RULE_ID,
          p_rule_version: SELF_SIGNUP_RULE_VERSION,
        })
      );
      return row.status;
    },
    async openSession(accountId, token, absoluteSeconds, idleSeconds) {
      const row = await one<{ status: OpenStatus }>(
        client.rpc("open_account_session", {
          p_account_id: accountId,
          p_token: token,
          p_absolute_seconds: absoluteSeconds,
          p_idle_seconds: idleSeconds,
        })
      );
      return row.status;
    },
    async checkSession(token, accountId) {
      const row = await one<{
        status: CheckStatus;
        session_id: string | null;
        workspace_id: string | null;
        membership_id: string | null;
        step_up_at: string | null;
        absolute_expires_at: string | null;
      }>(client.rpc("check_account_session", { p_token: token, p_account_id: accountId }));
      if (row.status !== "ACTIVE") return { status: row.status };
      return {
        status: "ACTIVE",
        sessionId: row.session_id as string,
        workspaceId: row.workspace_id as string,
        membershipId: row.membership_id as string,
        stepUpAt: row.step_up_at,
        absoluteExpiresAt: row.absolute_expires_at as string,
      };
    },
    async recordStepUp(token, accountId) {
      const row = await one<{ status: "STEPPED_UP" | Exclude<CheckStatus, "ACTIVE"> }>(
        client.rpc("record_account_step_up", { p_token: token, p_account_id: accountId })
      );
      return row.status;
    },
    async revokeSession(token) {
      const row = await one<{ status: "REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND" }>(
        client.rpc("revoke_account_session", { p_token: token, p_reason: "sign_out" })
      );
      return row.status;
    },
    async revokeAllForAccount(accountId, reason) {
      const row = await one<{ revoked_count: number }>(
        client.rpc("revoke_account_sessions_for_account", { p_account_id: accountId, p_reason: reason })
      );
      return row.revoked_count;
    },
    async takeRateLimit(purpose, kind, key, keyId, windowSeconds, max) {
      const row = await one<{ allowed: boolean }>(
        client.rpc("take_account_rate_limit", {
          p_purpose: purpose,
          p_bucket_kind: kind,
          p_bucket_key: key,
          p_key_id: keyId,
          p_window_seconds: windowSeconds,
          p_max: max,
        })
      );
      return row.allowed === true;
    },
  };
}
