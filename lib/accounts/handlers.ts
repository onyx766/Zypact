/**
 * S1 request handlers (D-045). Pure decisions over injected dependencies:
 * the routes and pages adapt them to Next.js, and the tests drive them with
 * fakes. Nothing here reads the network, the database or the clock directly.
 *
 * Rules every handler keeps:
 *   - The account comes only from a verified Auth user, never a request body.
 *   - Identity is not a grant: an account session opens only for an account
 *     with exactly one active workspace membership (the database decides).
 *   - Sign-up, resend and password reset answer the same way whether or not
 *     the email is approved or already registered.
 *   - Logs carry closed fields only: no email, password, token or address.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  cleanWorkspaceName,
  isPlausibleEmail,
  normalizeEmail,
  passwordProblem,
  signupAllowed,
  type AccountsConfig,
} from "@/lib/accounts/config";
import { RATE_RULES, bucketKey, type BucketKind, type RatePurpose } from "@/lib/accounts/rate-limit";
import type { AccountStore, ActiveSession } from "@/lib/accounts/store";

export interface AuthUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  workspaceName: string | null;
}

/** The Auth operations S1 needs, bound to the current request's cookies. */
export interface AuthPort {
  signUp(email: string, password: string, workspaceName: string, redirectTo: string): Promise<{ sessionCreated: boolean; errorCode: string | null }>;
  /**
   * The signed-in user, null for wrong credentials, or "email_not_confirmed"
   * when the password is right but the address is unverified. Supabase Auth
   * with Confirm email on refuses that sign-in itself, with this error code.
   */
  signInWithPassword(email: string, password: string): Promise<AuthUser | null | "email_not_confirmed">;
  getUser(): Promise<AuthUser | null>;
  /** Ends this browser's Auth session only (scope "local"). */
  signOut(): Promise<void>;
  resendSignup(email: string, redirectTo: string): Promise<void>;
  resetPasswordForEmail(email: string, redirectTo: string): Promise<void>;
  exchangeCode(code: string): Promise<boolean>;
  updatePassword(password: string): Promise<boolean>;
  /** Checks a password on a separate, non-persisting client; never touches this browser's session. */
  verifyPassword(email: string, password: string): Promise<boolean>;
}

export interface HandlerDeps {
  config: AccountsConfig;
  store: AccountStore;
  auth: AuthPort;
  newToken(): string;
  now(): number;
  log(entry: Record<string, string | number | boolean>): void;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
  redirect?: string;
  setSessionCookie?: { token: string; maxAgeSeconds: number };
  clearSessionCookie?: boolean;
  setResetCookie?: { value: string; maxAgeSeconds: number };
  clearResetCookie?: boolean;
}

export interface AccountContext {
  accountId: string;
  email: string;
  workspaceName: string | null;
  session: ActiveSession;
}

export const SIGNUP_ACCEPTED =
  "If this email can register, we've sent a link to verify it. Check your inbox.";
export const RESEND_ACCEPTED =
  "If this email has an account waiting for verification, we've sent a new link.";
export const RESET_ACCEPTED =
  "If this email has an account, we've sent a link to reset the password.";
export const SIGN_IN_FAILED = "Email or password is incorrect.";

export const CALLBACK_PATH = "/account/auth/callback";
export const RESET_COOKIE_TTL_SECONDS = 900;
const RESET_PURPOSE = "zypact.account.password_reset.v1";

const json = (status: number, body: Record<string, unknown>): HandlerResult => ({ status, body });
const invalid = (field: string, message: string) => json(400, { ok: false, error: "invalid_input", field, message });

/* ------------------------------------------------------------------ */
/* Rate limits                                                          */
/* ------------------------------------------------------------------ */

class RateLimitUnavailable extends Error {}

async function withinLimits(
  deps: HandlerDeps,
  purpose: RatePurpose,
  values: Partial<Record<BucketKind, string>>
): Promise<boolean> {
  const secret = deps.config.hmacSecret;
  if (!secret) throw new RateLimitUnavailable("rate limit secret missing");
  for (const rule of RATE_RULES[purpose]) {
    const value = values[rule.kind];
    if (!value) continue;
    const allowed = await deps.store.takeRateLimit(
      purpose,
      rule.kind,
      bucketKey(secret, rule.kind, value),
      deps.config.hmacKeyId,
      rule.windowSeconds,
      rule.max
    );
    if (!allowed) return false;
  }
  return true;
}

const tooMany = () => json(429, { ok: false, error: "rate_limited", message: "Too many attempts. Please wait and try again." });

async function guarded(deps: HandlerDeps, event: string, run: () => Promise<HandlerResult>): Promise<HandlerResult> {
  if (!deps.config.enabled) return json(404, { ok: false, error: "not_found" });
  try {
    return await run();
  } catch (error) {
    deps.log({ event, outcome: error instanceof RateLimitUnavailable ? "rate_limit_unconfigured" : "error" });
    return json(error instanceof RateLimitUnavailable ? 503 : 500, { ok: false, error: "unavailable" });
  }
}

/* ------------------------------------------------------------------ */
/* Session establishment (sign-in and verified callback)                */
/* ------------------------------------------------------------------ */

type Established = { ok: true; token: string } | { ok: false; reason: "not_approved" | "workspace_ambiguous" | "workspace_conflict" };

async function establishSession(deps: HandlerDeps, user: AuthUser): Promise<Established> {
  const email = normalizeEmail(user.email);
  let token = deps.newToken();
  let status = await deps.store.openSession(user.id, token, deps.config.absoluteSeconds, deps.config.idleSeconds);

  if (status === "NO_MEMBERSHIP") {
    if (!signupAllowed(email, deps.config)) return { ok: false, reason: "not_approved" };
    const created = await deps.store.provisionWorkspace(user.id, cleanWorkspaceName(user.workspaceName) ?? "My workspace");
    if (created === "IDEMPOTENCY_KEY_CONFLICT") return { ok: false, reason: "workspace_conflict" };
    token = deps.newToken();
    status = await deps.store.openSession(user.id, token, deps.config.absoluteSeconds, deps.config.idleSeconds);
  }
  if (status === "AMBIGUOUS_MEMBERSHIP") return { ok: false, reason: "workspace_ambiguous" };
  if (status !== "OPENED") return { ok: false, reason: "not_approved" };
  return { ok: true, token };
}

const ESTABLISH_MESSAGE: Record<Exclude<Established, { ok: true }>["reason"], string> = {
  not_approved: "This email isn't approved for the Zypact pilot yet.",
  workspace_ambiguous: "This account belongs to more than one workspace. Please contact Zypact.",
  workspace_conflict: "Your workspace could not be set up. Please contact Zypact.",
};

/* ------------------------------------------------------------------ */
/* Handlers                                                             */
/* ------------------------------------------------------------------ */

export function handleSignUp(
  deps: HandlerDeps,
  input: { email?: unknown; password?: unknown; workspaceName?: unknown },
  ctx: { ip: string; origin: string }
): Promise<HandlerResult> {
  return guarded(deps, "account_sign_up", async () => {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email)) return invalid("email", "Enter a valid email address.");
    const pw = passwordProblem(input.password);
    if (pw) return invalid("password", pw);
    const name = cleanWorkspaceName(input.workspaceName);
    if (!name) return invalid("workspaceName", "Enter a company or workspace name (up to 80 characters).");

    if (!(await withinLimits(deps, "sign_up", { ip: ctx.ip, email }))) return tooMany();

    const allowed = signupAllowed(email, deps.config);
    if (allowed) {
      const result = await deps.auth.signUp(email, input.password as string, name, `${ctx.origin}${CALLBACK_PATH}`);
      // With email confirmation on, no session exists yet. If the project is
      // misconfigured and one was created, it is ended here, unused.
      if (result.sessionCreated) await deps.auth.signOut();
      if (result.errorCode === "weak_password") {
        return invalid("password", "Choose a stronger password.");
      }
      deps.log({ event: "account_sign_up", allowed: true, provider_error: result.errorCode !== null });
    } else {
      deps.log({ event: "account_sign_up", allowed: false });
    }
    return json(202, { ok: true, message: SIGNUP_ACCEPTED });
  });
}

export function handleSignIn(
  deps: HandlerDeps,
  input: { email?: unknown; password?: unknown },
  ctx: { ip: string }
): Promise<HandlerResult> {
  return guarded(deps, "account_sign_in", async () => {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email) || typeof input.password !== "string" || input.password.length === 0) {
      return json(401, { ok: false, error: "invalid_credentials", message: SIGN_IN_FAILED });
    }
    if (!(await withinLimits(deps, "sign_in", { ip: ctx.ip, email }))) return tooMany();

    const user = await deps.auth.signInWithPassword(email, input.password);
    if (user === "email_not_confirmed") {
      deps.log({ event: "account_sign_in", outcome: "email_not_verified" });
      return json(403, { ok: false, error: "email_not_verified", message: "Verify your email first. We can send a new link." });
    }
    if (!user) {
      deps.log({ event: "account_sign_in", outcome: "invalid_credentials" });
      return json(401, { ok: false, error: "invalid_credentials", message: SIGN_IN_FAILED });
    }
    if (!user.emailConfirmedAt) {
      await deps.auth.signOut();
      deps.log({ event: "account_sign_in", outcome: "email_not_verified" });
      return json(403, { ok: false, error: "email_not_verified", message: "Verify your email first. We can send a new link." });
    }

    const established = await establishSession(deps, user);
    if (!established.ok) {
      await deps.auth.signOut();
      deps.log({ event: "account_sign_in", outcome: established.reason });
      return json(403, { ok: false, error: established.reason, message: ESTABLISH_MESSAGE[established.reason] });
    }
    deps.log({ event: "account_sign_in", outcome: "opened" });
    return {
      status: 200,
      body: { ok: true, redirect: "/account" },
      setSessionCookie: { token: established.token, maxAgeSeconds: deps.config.absoluteSeconds },
    };
  });
}

/** The link in a verification or password-reset email lands here. */
export function handleAuthCallback(
  deps: HandlerDeps,
  input: { code: string | null; next: string | null }
): Promise<HandlerResult> {
  return guarded(deps, "account_callback", async () => {
    const back = (notice: string): HandlerResult => ({ status: 303, body: {}, redirect: `/account/sign-in?notice=${notice}` });
    if (!input.code || !(await deps.auth.exchangeCode(input.code))) return back("link_invalid");
    const user = await deps.auth.getUser();
    if (!user) return back("link_invalid");

    if (input.next === "reset") {
      return {
        status: 303,
        body: {},
        redirect: "/account/reset-password",
        setResetCookie: { value: signResetGrant(deps, user.id), maxAgeSeconds: RESET_COOKIE_TTL_SECONDS },
      };
    }
    if (!user.emailConfirmedAt) {
      await deps.auth.signOut();
      return back("verify_email");
    }
    const established = await establishSession(deps, user);
    if (!established.ok) {
      await deps.auth.signOut();
      deps.log({ event: "account_callback", outcome: established.reason });
      return back(established.reason);
    }
    deps.log({ event: "account_callback", outcome: "opened" });
    return {
      status: 303,
      body: {},
      redirect: "/account",
      setSessionCookie: { token: established.token, maxAgeSeconds: deps.config.absoluteSeconds },
    };
  });
}

export function handleSignOut(deps: HandlerDeps, token: string | null): Promise<HandlerResult> {
  return guarded(deps, "account_sign_out", async () => {
    if (token) await deps.store.revokeSession(token);
    await deps.auth.signOut();
    return { status: 200, body: { ok: true, redirect: "/account/sign-in?notice=signed_out" }, clearSessionCookie: true };
  });
}

export function handleResendVerification(
  deps: HandlerDeps,
  input: { email?: unknown },
  ctx: { ip: string; origin: string }
): Promise<HandlerResult> {
  return guarded(deps, "account_resend", async () => {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email)) return invalid("email", "Enter a valid email address.");
    if (!(await withinLimits(deps, "resend_verification", { ip: ctx.ip, email }))) return tooMany();
    if (signupAllowed(email, deps.config)) await deps.auth.resendSignup(email, `${ctx.origin}${CALLBACK_PATH}`);
    return json(202, { ok: true, message: RESEND_ACCEPTED });
  });
}

export function handleForgotPassword(
  deps: HandlerDeps,
  input: { email?: unknown },
  ctx: { ip: string; origin: string }
): Promise<HandlerResult> {
  return guarded(deps, "account_forgot_password", async () => {
    const email = normalizeEmail(input.email);
    if (!isPlausibleEmail(email)) return invalid("email", "Enter a valid email address.");
    if (!(await withinLimits(deps, "password_reset", { ip: ctx.ip, email }))) return tooMany();
    await deps.auth.resetPasswordForEmail(email, `${ctx.origin}${CALLBACK_PATH}?next=reset`);
    return json(202, { ok: true, message: RESET_ACCEPTED });
  });
}

export function handleResetPassword(
  deps: HandlerDeps,
  input: { password?: unknown },
  resetCookie: string | null
): Promise<HandlerResult> {
  return guarded(deps, "account_reset_password", async () => {
    const user = await deps.auth.getUser();
    if (!user || !verifyResetGrant(deps, user.id, resetCookie)) {
      return json(401, { ok: false, error: "reset_link_required", message: "Open the reset link from your email again." });
    }
    const pw = passwordProblem(input.password);
    if (pw) return invalid("password", pw);
    if (!(await deps.auth.updatePassword(input.password as string))) {
      return invalid("password", "That password can't be used. Choose another.");
    }
    // A password change ends every account session (SELF_SERVICE_PRODUCT §5.2).
    await deps.store.revokeAllForAccount(user.id, "password_change");
    await deps.auth.signOut();
    deps.log({ event: "account_reset_password", outcome: "changed" });
    return {
      status: 200,
      body: { ok: true, redirect: "/account/sign-in?notice=password_changed" },
      clearSessionCookie: true,
      clearResetCookie: true,
    };
  });
}

export function handleStepUp(
  deps: HandlerDeps,
  account: AccountContext | null,
  token: string | null,
  input: { password?: unknown }
): Promise<HandlerResult> {
  return guarded(deps, "account_step_up", async () => {
    if (!account || !token) return json(401, { ok: false, error: "not_signed_in" });
    if (!(await withinLimits(deps, "step_up", { account: account.accountId }))) return tooMany();
    if (typeof input.password !== "string" || !(await deps.auth.verifyPassword(account.email, input.password))) {
      deps.log({ event: "account_step_up", outcome: "invalid_credentials" });
      return json(401, { ok: false, error: "invalid_credentials", message: "That password is incorrect." });
    }
    const status = await deps.store.recordStepUp(token, account.accountId);
    deps.log({ event: "account_step_up", outcome: status.toLowerCase() });
    return status === "STEPPED_UP"
      ? json(200, { ok: true })
      : json(401, { ok: false, error: "not_signed_in" });
  });
}

/* ------------------------------------------------------------------ */
/* Who is signed in                                                     */
/* ------------------------------------------------------------------ */

/** The account behind this request, or null. Never trusts a body or a query. */
export async function resolveAccount(deps: HandlerDeps, token: string | null): Promise<AccountContext | null> {
  if (!deps.config.enabled || !token) return null;
  const user = await deps.auth.getUser();
  if (!user || !user.emailConfirmedAt || !user.email) return null;
  const session = await deps.store.checkSession(token, user.id);
  if (session.status !== "ACTIVE") return null;
  return { accountId: user.id, email: normalizeEmail(user.email), workspaceName: user.workspaceName, session };
}

/** True when a step-up happened within the last `maxAgeSeconds`. */
export function hasFreshStepUp(account: AccountContext, nowMs: number, maxAgeSeconds = 600): boolean {
  const at = account.session.stepUpAt ? Date.parse(account.session.stepUpAt) : NaN;
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= maxAgeSeconds * 1000;
}

/* ------------------------------------------------------------------ */
/* Password-reset grant                                                 */
/* ------------------------------------------------------------------ */
// Set only after a recovery link's code is exchanged, bound to that user and
// a 15-minute expiry. Without it, a signed-in browser could change the
// password with no proof beyond an open session.

function resetMac(secret: string, userId: string, expiresAtMs: number): string {
  return createHmac("sha256", secret).update(`${RESET_PURPOSE}\u001f${userId}\u001f${expiresAtMs}`).digest("hex");
}

export function signResetGrant(deps: Pick<HandlerDeps, "config" | "now">, userId: string): string {
  const secret = deps.config.hmacSecret;
  if (!secret) throw new RateLimitUnavailable("secret missing");
  const expires = deps.now() + RESET_COOKIE_TTL_SECONDS * 1000;
  return `${expires}.${resetMac(secret, userId, expires)}`;
}

export function verifyResetGrant(deps: Pick<HandlerDeps, "config" | "now">, userId: string, value: string | null): boolean {
  const secret = deps.config.hmacSecret;
  if (!secret || !value) return false;
  const [expiresRaw, mac] = value.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires <= deps.now() || !/^[0-9a-f]{64}$/.test(mac ?? "")) return false;
  const expected = Buffer.from(resetMac(secret, userId, expires), "hex");
  return timingSafeEqual(expected, Buffer.from(mac, "hex"));
}
