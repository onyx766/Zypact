/**
 * Server-only: adapts the S1 handlers to Next.js. Builds the real
 * dependencies (config, service-role store, cookie-bound Auth), reads JSON
 * bodies safely, and turns a HandlerResult into a response with cookies.
 */
import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

import { readAccountsConfig } from "@/lib/accounts/config";
import {
  RESET_COOKIE_TTL_SECONDS,
  resolveAccount,
  type AccountContext,
  type AuthPort,
  type AuthUser,
  type HandlerDeps,
  type HandlerResult,
} from "@/lib/accounts/handlers";
import { clientIp } from "@/lib/accounts/rate-limit";
import { supabaseAccountStore } from "@/lib/accounts/store";
import { publicSiteUrl } from "@/lib/seo/site";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const SESSION_COOKIE = "zy_account";
export const RESET_COOKIE = "zy_account_reset";
export const MAX_BODY_BYTES = 4096;

function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    workspaceName: typeof meta.workspace_name === "string" ? meta.workspace_name : null,
  };
}

function supabaseAuthPort(): AuthPort {
  const client = () => getSupabaseServerClient();
  return {
    async signUp(email, password, workspaceName, redirectTo) {
      const { data, error } = await (await client()).auth.signUp({
        email,
        password,
        options: { emailRedirectTo: redirectTo, data: { workspace_name: workspaceName } },
      });
      return { sessionCreated: Boolean(data?.session), errorCode: error ? (error.code ?? "unknown") : null };
    },
    async signInWithPassword(email, password) {
      const { data, error } = await (await client()).auth.signInWithPassword({ email, password });
      if (error?.code === "email_not_confirmed") return "email_not_confirmed";
      return error ? null : toAuthUser(data.user);
    },
    async getUser() {
      const { data, error } = await (await client()).auth.getUser();
      return error ? null : toAuthUser(data.user);
    },
    async signOut() {
      await (await client()).auth.signOut({ scope: "local" });
    },
    async resendSignup(email, redirectTo) {
      await (await client()).auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo } });
    },
    async resetPasswordForEmail(email, redirectTo) {
      await (await client()).auth.resetPasswordForEmail(email, { redirectTo });
    },
    async exchangeCode(code) {
      const { error } = await (await client()).auth.exchangeCodeForSession(code);
      return !error;
    },
    async updatePassword(password) {
      const { error } = await (await client()).auth.updateUser({ password });
      return !error;
    },
    async verifyPassword(email, password) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !anon) return false;
      const verifier = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await verifier.auth.signInWithPassword({ email, password });
      if (error) return false;
      // Ends only the session this check created; the browser's stays as it was.
      await verifier.auth.signOut({ scope: "local" });
      return true;
    },
  };
}

export function accountDeps(): HandlerDeps {
  return {
    config: readAccountsConfig(),
    store: supabaseAccountStore(),
    auth: supabaseAuthPort(),
    newToken: () => randomBytes(32).toString("base64url"),
    now: () => Date.now(),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** The current account for a page or route, or null. */
export async function currentAccount(deps: HandlerDeps = accountDeps()): Promise<AccountContext | null> {
  if (!deps.config.enabled) return null;
  const store = await cookies();
  return resolveAccount(deps, store.get(SESSION_COOKIE)?.value ?? null);
}

export async function readCookie(name: string): Promise<string | null> {
  return (await cookies()).get(name)?.value ?? null;
}

/** JSON only, at most `maxBytes` (MAX_BODY_BYTES unless a route sets a larger cap); anything else is refused before parsing. */
export async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "unsupported_media_type" }, { status: 415 }) };
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 }) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 }) };
  }
}

const secureCookies = () => process.env.NODE_ENV === "production";

export function toResponse(result: HandlerResult, origin: string): NextResponse {
  const response = result.redirect
    ? NextResponse.redirect(new URL(result.redirect, origin), result.status === 303 ? 303 : 302)
    : NextResponse.json(result.body, { status: result.status });
  const base = { httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, path: "/" };
  if (result.setSessionCookie) {
    response.cookies.set(SESSION_COOKIE, result.setSessionCookie.token, { ...base, maxAge: result.setSessionCookie.maxAgeSeconds });
  }
  if (result.clearSessionCookie) response.cookies.set(SESSION_COOKIE, "", { ...base, maxAge: 0 });
  if (result.setResetCookie) {
    response.cookies.set(RESET_COOKIE, result.setResetCookie.value, {
      ...base,
      path: "/api/account/reset-password",
      maxAge: Math.min(result.setResetCookie.maxAgeSeconds, RESET_COOKIE_TTL_SECONDS),
    });
  }
  if (result.clearResetCookie) {
    response.cookies.set(RESET_COOKIE, "", { ...base, path: "/api/account/reset-password", maxAge: 0 });
  }
  return response;
}

export function notEnabled(): NextResponse {
  return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
}

/**
 * A POST route: the kill switch first, then the body, then the handler.
 * Email links always point at the configured site, never at the request's
 * Host header.
 */
export function accountPost(
  run: (deps: HandlerDeps, body: Record<string, unknown>, ctx: { ip: string; origin: string }) => Promise<HandlerResult>
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const deps = accountDeps();
    if (!deps.config.enabled) return notEnabled();
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const result = await run(deps, parsed.body, { ip: clientIp(request.headers), origin: publicSiteUrl() });
    return toResponse(result, new URL(request.url).origin);
  };
}
