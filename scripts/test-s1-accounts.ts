#!/usr/bin/env tsx
/**
 * S1 accounts: handlers, policy, rate limits, cookies and boundaries (D-045).
 *
 * H*  handlers driven with a fake Auth port and a fake store that record
 *     every call (no network, no database)
 * C*  configuration and policy
 * R*  rate-limit keys
 * K*  the response adapter: cookie flags
 * S*  static checks on the real routes, pages and modules
 *
 * The database side is proven in the Level 2 harness (QS1 cases).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  PASSWORD_MIN_LENGTH,
  cleanWorkspaceName,
  passwordProblem,
  readAccountsConfig,
  signupAllowed,
  type AccountsConfig,
} from "@/lib/accounts/config";
import {
  RESET_ACCEPTED,
  RESEND_ACCEPTED,
  SIGNUP_ACCEPTED,
  SIGN_IN_FAILED,
  handleAuthCallback,
  handleForgotPassword,
  handleResendVerification,
  handleResetPassword,
  handleSignIn,
  handleSignOut,
  handleSignUp,
  handleStepUp,
  hasFreshStepUp,
  resolveAccount,
  signResetGrant,
  type AccountContext,
  type AuthPort,
  type AuthUser,
  type HandlerDeps,
} from "@/lib/accounts/handlers";
import { ACCOUNT_RATE_LIMIT_PURPOSE, bucketKey, clientIp } from "@/lib/accounts/rate-limit";
import type { AccountStore, OpenStatus } from "@/lib/accounts/store";

let total = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
let fetchCalls = 0;
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  fetchCalls += 1;
  throw new Error("network disabled");
};

const SECRET = "s".repeat(40);
const APPROVED = "pilot@acme.test";

function config(over: Partial<AccountsConfig> = {}): AccountsConfig {
  return {
    enabled: true,
    signupMode: "pilot",
    pilotAllowlist: new Set([APPROVED]),
    absoluteSeconds: 43200,
    idleSeconds: 3600,
    hmacSecret: SECRET,
    hmacKeyId: "k1",
    ...over,
  };
}

interface World {
  deps: HandlerDeps;
  calls: string[];
  logs: Array<Record<string, unknown>>;
  user: AuthUser | null;
  memberships: Map<string, number>;
  rateAllowed: boolean;
}

function world(over: Partial<AccountsConfig> = {}, user: AuthUser | null = null): World {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const memberships = new Map<string, number>();
  const w = { calls, logs, user, memberships, rateAllowed: true } as World;
  let tokens = 0;
  const auth: AuthPort = {
    async signUp(email, _pw, name, redirect) {
      calls.push(`auth.signUp:${email}:${name}:${redirect}`);
      return { sessionCreated: false, errorCode: null };
    },
    async signInWithPassword(email, password) {
      calls.push(`auth.signIn:${email}`);
      return w.user && password === "correct-horse-battery" ? w.user : null;
    },
    async getUser() {
      calls.push("auth.getUser");
      return w.user;
    },
    async signOut() {
      calls.push("auth.signOut");
    },
    async resendSignup(email) {
      calls.push(`auth.resend:${email}`);
    },
    async resetPasswordForEmail(email, redirect) {
      calls.push(`auth.reset:${email}:${redirect}`);
    },
    async exchangeCode(code) {
      calls.push(`auth.exchange:${code}`);
      return code === "good-code";
    },
    async updatePassword() {
      calls.push("auth.updatePassword");
      return true;
    },
    async verifyPassword(email, password) {
      calls.push(`auth.verify:${email}`);
      return password === "correct-horse-battery";
    },
  };
  const store: AccountStore = {
    async provisionWorkspace(accountId, name) {
      calls.push(`store.provision:${accountId}:${name}`);
      memberships.set(accountId, (memberships.get(accountId) ?? 0) + 1);
      return "CREATED";
    },
    async openSession(accountId, token) {
      calls.push(`store.open:${accountId}:${token}`);
      const n = memberships.get(accountId) ?? 0;
      const status: OpenStatus = n === 0 ? "NO_MEMBERSHIP" : n > 1 ? "AMBIGUOUS_MEMBERSHIP" : "OPENED";
      return status;
    },
    async checkSession(token, accountId) {
      calls.push(`store.check:${accountId}`);
      return token === "live-token" && (memberships.get(accountId) ?? 0) === 1
        ? {
            status: "ACTIVE",
            sessionId: "s1",
            workspaceId: "ws1",
            membershipId: "m1",
            stepUpAt: null,
            absoluteExpiresAt: "2026-11-10T00:00:00.000Z",
          }
        : { status: "NOT_FOUND" };
    },
    async recordStepUp(token, accountId) {
      calls.push(`store.stepUp:${accountId}`);
      return token === "live-token" ? "STEPPED_UP" : "NOT_FOUND";
    },
    async revokeSession(token) {
      calls.push(`store.revoke:${token}`);
      return "REVOKED";
    },
    async revokeAllForAccount(accountId, reason) {
      calls.push(`store.revokeAll:${accountId}:${reason}`);
      return 2;
    },
    async takeRateLimit(purpose, kind, key) {
      calls.push(`store.rate:${purpose}:${kind}:${key}`);
      return w.rateAllowed;
    },
  };
  w.deps = {
    config: config(over),
    store,
    auth,
    newToken: () => `token-${++tokens}`,
    now: () => 1_800_000_000_000,
    log: (entry) => logs.push(entry),
  };
  return w;
}

const verifiedUser = (email = APPROVED): AuthUser => ({
  id: "acct-1",
  email,
  emailConfirmedAt: "2026-11-09T00:00:00Z",
  workspaceName: "Acme Analytics",
});
const CTX = { ip: "203.0.113.7", origin: "https://www.zypact.com" };
const SIGNUP = { email: APPROVED, password: "correct-horse-battery", workspaceName: "Acme Analytics" };

async function main(): Promise<void> {
  console.log("test-s1-accounts");

  /* H: handlers ---------------------------------------------------- */
  {
    const w = world({ enabled: false });
    const r = await handleSignUp(w.deps, SIGNUP, CTX);
    check("H1 kill switch off: 404 and nothing else happens", r.status === 404 && w.calls.length === 0);
  }
  {
    const a = world();
    const ra = await handleSignUp(a.deps, SIGNUP, CTX);
    const b = world();
    const rb = await handleSignUp(b.deps, { ...SIGNUP, email: "stranger@else.test" }, CTX);
    check("H2 sign-up answers identically for an approved and an unapproved email",
      ra.status === 202 && rb.status === 202 && JSON.stringify(ra.body) === JSON.stringify(rb.body) && ra.body.message === SIGNUP_ACCEPTED);
    check("H2 only the approved email reaches Auth", a.calls.some((c) => c.startsWith("auth.signUp:")) && !b.calls.some((c) => c.startsWith("auth.signUp:")));
    check("H2 the verification link points at the configured callback",
      a.calls.some((c) => c.endsWith(":https://www.zypact.com/account/auth/callback")));
    check("H2 sign-up never opens a session or creates a workspace", !a.calls.some((c) => c.startsWith("store.open") || c.startsWith("store.provision")));
    check("H2 logs carry no email", !JSON.stringify([...a.logs, ...b.logs]).includes("@"));
  }
  {
    const w = world({ signupMode: "closed" });
    await handleSignUp(w.deps, SIGNUP, CTX);
    check("H3 closed mode: even an allowlisted email is not signed up", !w.calls.some((c) => c.startsWith("auth.signUp")));
    const o = world({ signupMode: "open" });
    await handleSignUp(o.deps, { ...SIGNUP, email: "anyone@else.test" }, CTX);
    check("H3 open mode: any valid email is signed up", o.calls.some((c) => c.startsWith("auth.signUp:anyone@else.test")));
  }
  {
    const w = world();
    const short = await handleSignUp(w.deps, { ...SIGNUP, password: "short" }, CTX);
    const noName = await handleSignUp(w.deps, { ...SIGNUP, workspaceName: "   " }, CTX);
    const badEmail = await handleSignUp(w.deps, { ...SIGNUP, email: "not-an-email" }, CTX);
    check("H4 invalid input is 400 before any rate limit or Auth call",
      short.status === 400 && noName.status === 400 && badEmail.status === 400 && w.calls.length === 0);
  }
  {
    const w = world();
    w.rateAllowed = false;
    const r = await handleSignUp(w.deps, SIGNUP, CTX);
    check("H5 a rate limit refuses before Auth", r.status === 429 && !w.calls.some((c) => c.startsWith("auth.")));
    const n = world({ hmacSecret: null });
    const rn = await handleSignUp(n.deps, SIGNUP, CTX);
    check("H5 no HMAC secret: 503, fail closed, nothing sent", rn.status === 503 && !n.calls.some((c) => c.startsWith("auth.")));
  }
  {
    const w = world({}, verifiedUser());
    const r = await handleSignIn(w.deps, { email: APPROVED, password: "correct-horse-battery" }, CTX);
    check("H6 first sign-in of an approved, verified account provisions its workspace and opens a session",
      r.status === 200 && w.calls.some((c) => c === "store.provision:acct-1:Acme Analytics") && r.setSessionCookie?.token === "token-2");
    check("H6 the session cookie lives as long as the session's absolute limit", r.setSessionCookie?.maxAgeSeconds === 43200);
    check("H6 the workspace is provisioned as a system action (rule s1.self_signup)",
      readFileSync("lib/accounts/store.ts", "utf8").includes('p_actor_type: "system"') && readFileSync("lib/accounts/store.ts", "utf8").includes('SELF_SIGNUP_RULE_ID = "s1.self_signup"'));
  }
  {
    const w = world({}, verifiedUser());
    const r = await handleSignIn(w.deps, { email: APPROVED, password: "wrong-password-123" }, CTX);
    check("H7 a wrong password is one generic 401", r.status === 401 && r.body.message === SIGN_IN_FAILED && !w.calls.some((c) => c.startsWith("store.open")));
  }
  {
    const w = world({}, { ...verifiedUser(), emailConfirmedAt: null });
    const r = await handleSignIn(w.deps, { email: APPROVED, password: "correct-horse-battery" }, CTX);
    check("H8 an unverified email is signed out and gets no session",
      r.status === 403 && w.calls.includes("auth.signOut") && !w.calls.some((c) => c.startsWith("store.open") || c.startsWith("store.provision")));
  }
  {
    // Real Supabase Auth (Confirm email on) refuses the sign-in itself with
    // email_not_confirmed; found by scripts/s1-real-auth-check.ts (R2).
    const w = world({}, { ...verifiedUser(), emailConfirmedAt: null });
    w.deps.auth.signInWithPassword = async () => "email_not_confirmed";
    const r = await handleSignIn(w.deps, { email: APPROVED, password: "correct-horse-battery" }, CTX);
    check("H8b when Auth itself refuses an unverified email, the person is told to verify, not that the password is wrong",
      r.status === 403 && r.body.error === "email_not_verified" && !w.calls.some((c) => c.startsWith("store.open") || c.startsWith("store.provision")) && !r.setSessionCookie);
  }
  {
    const w = world({}, verifiedUser("stranger@else.test"));
    const r = await handleSignIn(w.deps, { email: "stranger@else.test", password: "correct-horse-battery" }, CTX);
    check("H9 identity is not a grant: a verified but unapproved account gets no workspace and no session",
      r.status === 403 && r.body.error === "not_approved" && !w.calls.some((c) => c.startsWith("store.provision")) && w.calls.includes("auth.signOut") && !r.setSessionCookie);
  }
  {
    const w = world({ signupMode: "closed" }, verifiedUser("stranger@else.test"));
    w.memberships.set("acct-1", 1);
    const r = await handleSignIn(w.deps, { email: "stranger@else.test", password: "correct-horse-battery" }, CTX);
    check("H10 an existing member signs in even after sign-up closes (the allowlist governs creation only)",
      r.status === 200 && !w.calls.some((c) => c.startsWith("store.provision")));
  }
  {
    const w = world({}, verifiedUser());
    w.memberships.set("acct-1", 2);
    const r = await handleSignIn(w.deps, { email: APPROVED, password: "correct-horse-battery" }, CTX);
    check("H11 two memberships: refused, not guessed", r.status === 403 && r.body.error === "workspace_ambiguous" && !r.setSessionCookie);
  }
  {
    const w = world({}, verifiedUser());
    const r = await handleAuthCallback(w.deps, { code: "good-code", next: null });
    check("H12 a verified callback opens the session and lands on /account",
      r.status === 303 && r.redirect === "/account" && Boolean(r.setSessionCookie));
    const bad = world({}, verifiedUser());
    const rb = await handleAuthCallback(bad.deps, { code: "bad-code", next: null });
    check("H12 a bad code redirects to sign-in, no session", rb.redirect === "/account/sign-in?notice=link_invalid" && !rb.setSessionCookie);
    const reset = world({}, verifiedUser());
    const rr = await handleAuthCallback(reset.deps, { code: "good-code", next: "reset" });
    check("H12 a reset link grants the reset step only, no account session",
      rr.redirect === "/account/reset-password" && !rr.setSessionCookie && Boolean(rr.setResetCookie) && !reset.calls.some((c) => c.startsWith("store.open")));
  }
  {
    const w = world();
    const r = await handleSignOut(w.deps, "live-token");
    check("H13 sign-out revokes the session, ends Auth locally and clears the cookie",
      w.calls[0] === "store.revoke:live-token" && w.calls.includes("auth.signOut") && r.clearSessionCookie === true);
  }
  {
    const a = world();
    const ra = await handleResendVerification(a.deps, { email: APPROVED }, CTX);
    const b = world();
    const rb = await handleResendVerification(b.deps, { email: "stranger@else.test" }, CTX);
    check("H14 resend answers identically, and only sends for an approved email",
      ra.status === 202 && JSON.stringify(ra.body) === JSON.stringify(rb.body) && ra.body.message === RESEND_ACCEPTED &&
        a.calls.some((c) => c.startsWith("auth.resend")) && !b.calls.some((c) => c.startsWith("auth.resend")));
  }
  {
    const w = world();
    const r = await handleForgotPassword(w.deps, { email: "anyone@else.test" }, CTX);
    check("H15 forgot-password always answers the same, with the reset callback",
      r.status === 202 && r.body.message === RESET_ACCEPTED && w.calls.some((c) => c.endsWith(":https://www.zypact.com/account/auth/callback?next=reset")));
  }
  {
    const w = world({}, verifiedUser());
    const none = await handleResetPassword(w.deps, { password: "a-brand-new-password" }, null);
    check("H16 a password change without the reset grant is refused", none.status === 401 && !w.calls.includes("auth.updatePassword"));
    const forged = await handleResetPassword(w.deps, { password: "a-brand-new-password" }, `${1_900_000_000_000}.${"0".repeat(64)}`);
    check("H16 a forged grant is refused", forged.status === 401);
    const other = signResetGrant(w.deps, "acct-2");
    const wrongUser = await handleResetPassword(w.deps, { password: "a-brand-new-password" }, other);
    check("H16 another account's grant is refused", wrongUser.status === 401);
    const grant = signResetGrant(w.deps, "acct-1");
    const ok = await handleResetPassword(w.deps, { password: "a-brand-new-password" }, grant);
    check("H16 with a valid grant: password changed, every session revoked, signed out",
      ok.status === 200 && w.calls.includes("store.revokeAll:acct-1:password_change") && w.calls.includes("auth.signOut") && ok.clearSessionCookie === true && ok.clearResetCookie === true);
    const later = world({}, verifiedUser());
    later.deps.now = () => 1_800_000_000_000 + 16 * 60 * 1000;
    const expired = await handleResetPassword(later.deps, { password: "a-brand-new-password" }, grant);
    check("H16 an expired grant is refused", expired.status === 401);
  }
  {
    const w = world({}, verifiedUser());
    w.memberships.set("acct-1", 1);
    const account = await resolveAccount(w.deps, "live-token");
    check("H17 resolveAccount: verified user plus active session", account?.accountId === "acct-1" && account.session.workspaceId === "ws1");
    check("H17 no token: no account and no database call", (await resolveAccount(w.deps, null)) === null);
    const unverified = world({}, { ...verifiedUser(), emailConfirmedAt: null });
    unverified.memberships.set("acct-1", 1);
    check("H17 an unverified user never resolves", (await resolveAccount(unverified.deps, "live-token")) === null && !unverified.calls.some((c) => c.startsWith("store.check")));
    const off = world({ enabled: false }, verifiedUser());
    check("H17 accounts off: nothing resolves", (await resolveAccount(off.deps, "live-token")) === null && off.calls.length === 0);

    const bad = await handleStepUp(w.deps, account as AccountContext, "live-token", { password: "nope-nope-nope" });
    check("H18 step-up with a wrong password is refused and records nothing", bad.status === 401 && !w.calls.some((c) => c.startsWith("store.stepUp")));
    const good = await handleStepUp(w.deps, account as AccountContext, "live-token", { password: "correct-horse-battery" });
    check("H18 step-up verifies the password on the separate client, then records it",
      good.status === 200 && w.calls.includes(`auth.verify:${APPROVED}`) && w.calls.includes("store.stepUp:acct-1"));
    check("H18 step-up without a signed-in account is 401", (await handleStepUp(w.deps, null, null, { password: "x" })).status === 401);
    const fresh = { ...(account as AccountContext), session: { ...(account as AccountContext).session, stepUpAt: new Date(1_800_000_000_000 - 60_000).toISOString() } };
    check("H19 a step-up one minute old is fresh; eleven minutes old is not",
      hasFreshStepUp(fresh, 1_800_000_000_000) && !hasFreshStepUp(fresh, 1_800_000_000_000 + 10 * 60_000));
  }
  {
    const w = world({}, verifiedUser());
    await handleSignIn(w.deps, { email: APPROVED, password: "correct-horse-battery" }, CTX);
    const rates = w.calls.filter((c) => c.startsWith("store.rate:"));
    check("H20 sign-in takes from both the address and the email bucket", rates.length === 2 && rates[0].includes(":ip:") && rates[1].includes(":email:"));
    check("H20 buckets hold keyed hashes, never the address or email", rates.every((c) => /:[0-9a-f]{64}$/.test(c)) && !rates.some((c) => c.includes("@") || c.includes("203.0.113.7")));
  }

  /* C: configuration and policy ----------------------------------- */
  {
    const empty = readAccountsConfig({});
    check("C1 defaults fail closed: off, sign-up closed, no secret", !empty.enabled && empty.signupMode === "closed" && empty.hmacSecret === null);
    check("C1 'TRUE' or '1' does not enable accounts", !readAccountsConfig({ ZYPACT_ACCOUNTS_ENABLED: "TRUE" }).enabled && !readAccountsConfig({ ZYPACT_ACCOUNTS_ENABLED: "1" }).enabled);
    check("C2 an unknown mode is closed", readAccountsConfig({ ZYPACT_SIGNUP_MODE: "everyone" }).signupMode === "closed");
    const c = readAccountsConfig({ ZYPACT_PILOT_SIGNUP_ALLOWLIST: " Pilot@ACME.test , ,junk", ZYPACT_SIGNUP_MODE: "pilot" });
    check("C3 the allowlist is normalised and ignores junk", c.pilotAllowlist.has("pilot@acme.test") && c.pilotAllowlist.size === 1);
    check("C3 an allowlisted email matches regardless of case", signupAllowed("PILOT@acme.test", c));
    const l = readAccountsConfig({ ZYPACT_ACCOUNT_SESSION_ABSOLUTE_MINUTES: "999999", ZYPACT_ACCOUNT_SESSION_IDLE_MINUTES: "99999" });
    check("C4 lifetimes are clamped to the database bounds (7 days; idle within it)", l.absoluteSeconds === 604800 && l.idleSeconds === 86400);
    const s = readAccountsConfig({ ZYPACT_ACCOUNT_SESSION_ABSOLUTE_MINUTES: "10", ZYPACT_ACCOUNT_SESSION_IDLE_MINUTES: "60" });
    check("C4 idle never exceeds absolute", s.idleSeconds <= s.absoluteSeconds);
    check("C5 a short HMAC secret is treated as missing", readAccountsConfig({ ZYPACT_ACCOUNT_HMAC_SECRET: "short" }).hmacSecret === null);
    check("C6 password rules", passwordProblem("x".repeat(PASSWORD_MIN_LENGTH - 1)) !== null && passwordProblem("x".repeat(PASSWORD_MIN_LENGTH)) === null && passwordProblem("é".repeat(40)) !== null);
    check("C7 workspace names are trimmed and bounded", cleanWorkspaceName("  Acme\n  Inc ") === "Acme Inc" && cleanWorkspaceName("x".repeat(81)) === null);
  }

  /* R: rate-limit keys -------------------------------------------- */
  {
    const k = bucketKey(SECRET, "email", APPROVED);
    check("R1 bucket keys are 64-hex HMACs", /^[0-9a-f]{64}$/.test(k));
    check("R1 kind is part of the key", k !== bucketKey(SECRET, "ip", APPROVED));
    check("R1 the purpose label is versioned", ACCOUNT_RATE_LIMIT_PURPOSE === "zypact.account.rate_limit.v1");
    const h = new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" });
    check("R2 the first forwarded address is used", clientIp(h) === "198.51.100.1" && clientIp(new Headers()) === "unknown");
  }

  /* K: cookie flags (adapter source) ------------------------------ */
  {
    const http = readFileSync("lib/accounts/http.ts", "utf8");
    check("K1 session cookies are httpOnly, SameSite=Lax, secure in production", http.includes('httpOnly: true') && http.includes('sameSite: "lax"') && http.includes('process.env.NODE_ENV === "production"'));
    check("K2 the reset grant cookie is scoped to the reset route", http.includes('path: "/api/account/reset-password"'));
    check("K3 bodies are JSON only and capped", http.includes('startsWith("application/json")') && http.includes("MAX_BODY_BYTES = 4096"));
    check("K4 email links use the configured site, not the Host header", http.includes("origin: publicSiteUrl()"));
    check("K5 sign-out and the password check end only their own Auth session", (http.match(/scope: "local"/g) ?? []).length === 2 && !http.includes('scope: "global"'));
    const order = http.indexOf("if (!deps.config.enabled) return notEnabled();");
    check("K6 POST routes check the kill switch before reading the body", order > 0 && order < http.indexOf("await readJsonBody(request)", order));
  }

  /* S: static checks ---------------------------------------------- */
  {
    // S1's own seven routes go through accountPost. Every other route under
    // app/api/account is a workspace route (P1 D-046, P2 D-047) and goes
    // through workspacePost, which applies the same kill switch and body rules.
    const S1_ROUTES = ["sign-up", "sign-in", "sign-out", "resend-verification", "forgot-password", "reset-password", "step-up"];
    const allRoutes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = `${dir}/${entry}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (entry === "route.ts") allRoutes.push(p);
      }
    };
    walk("app/api/account");
    const routes = S1_ROUTES.map((d) => `app/api/account/${d}/route.ts`);
    const workspaceRoutes = allRoutes.filter((r) => !routes.includes(r));
    const postOnly = (s: string) => !/export (async )?function (GET|PUT|PATCH|DELETE)/.test(s) && !/export const (GET|PUT|PATCH|DELETE)\b/.test(s);
    check("S1 the seven S1 account API routes exist", routes.every((r) => existsSync(r)));
    check("S1 every S1 account API route is POST-only through accountPost",
      routes.every((r) => { const s = readFileSync(r, "utf8"); return s.includes("export const POST = accountPost(") && postOnly(s); }));
    check("S1 every other account API route is a POST-only workspace route through workspacePost",
      workspaceRoutes.length > 0 && workspaceRoutes.every((r) => { const s = readFileSync(r, "utf8"); return s.includes("export const POST = workspacePost(") && postOnly(s); }));
    const pages = ["app/account/page.tsx", "app/account/sign-up/page.tsx", "app/account/sign-in/page.tsx", "app/account/verify/page.tsx", "app/account/forgot-password/page.tsx", "app/account/reset-password/page.tsx"];
    check("S2 every account page returns 404 while accounts are off", pages.every((p) => readFileSync(p, "utf8").includes("readAccountsConfig()") && readFileSync(p, "utf8").includes("notFound()")));
    check("S2 every account page is noindex", pages.every((p) => readFileSync(p, "utf8").includes("robots: { index: false, follow: false }")) && readFileSync("lib/seo/legacy-routes.ts", "utf8").includes('"/account",'));
    const callback = readFileSync("app/account/auth/callback/route.ts", "utf8");
    check("S3 the callback is the only GET and checks the kill switch first", callback.includes("export async function GET") && callback.indexOf("notEnabled()") < callback.indexOf("handleAuthCallback(deps"));

    const clientFiles = ["app/account/account-form.tsx"];
    check("S4 browser components never import the store, the handlers or the HTTP adapter",
      clientFiles.every((f) => { const s = readFileSync(f, "utf8"); return s.startsWith('"use client"') && !/@\/lib\/accounts\//.test(s); }));

    const NEVER = [/^lib\/llm\//, /^lib\/probes\//, /^lib\/pipeline\//, /^lib\/agents\//, /^lib\/protocol-worker\//, /^lib\/worker-control\//, /^lib\/db\//];
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) : null;
      if (!base) return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (existsSync(c) && statSync(c).isFile()) return c;
      return null;
    };
    const reach = (seeds: string[]): Set<string> => {
      const seen = new Set<string>();
      const stack = [...seeds];
      while (stack.length) {
        const f = stack.pop() as string;
        if (seen.has(f)) continue;
        seen.add(f);
        for (const m of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
          const t = resolve(f, m[1]);
          if (t) stack.push(t);
        }
      }
      return seen;
    };
    // S1's own modules: no model, probe, worker, pipeline, legacy DB adapter,
    // and no website diagnostic.
    const authPages = pages.filter((p) => p !== "app/account/page.tsx");
    const s1Reach = reach(["lib/accounts/http.ts", "lib/accounts/handlers.ts", "lib/accounts/store.ts", ...routes, ...authPages, "app/account/auth/callback/route.ts"]);
    const s1Offending = [...s1Reach].filter((f) => [...NEVER, /^lib\/site-diagnostic\//, /^lib\/workspace\//].some((re) => re.test(f)));
    check(`S5 no S1 account module reaches a model, probe, worker, pipeline, legacy DB adapter, the diagnostic or the workspace${s1Offending.length ? ` — ${s1Offending.join(", ")}` : ""}`, s1Offending.length === 0);
    // Workspace modules (D-046, D-047) may reach the W1 website diagnostic —
    // it fetches only the workspace's own site, with no model call — and
    // nothing else on the list.
    const workspacePages = readdirSync("app/account").filter((d) => existsSync(`app/account/${d}/page.tsx`) && !authPages.includes(`app/account/${d}/page.tsx`) && d !== "auth").map((d) => `app/account/${d}/page.tsx`);
    const wsReach = reach(["app/account/page.tsx", ...workspacePages, ...workspaceRoutes]);
    const wsOffending = [...wsReach].filter((f) => NEVER.some((re) => re.test(f)));
    check(`S5 no workspace module reaches a model, probe, worker, pipeline or legacy DB adapter${wsOffending.length ? ` — ${wsOffending.join(", ")}` : ""}`, workspacePages.length >= 6 && wsOffending.length === 0, String(workspacePages.length));
    check("S5 founder login and the founder guard are untouched by S1",
      !readFileSync("app/login/page.tsx", "utf8").includes("accounts") && !readFileSync("lib/auth/founder.ts", "utf8").includes("accounts"));

    const handlers = readFileSync("lib/accounts/handlers.ts", "utf8");
    const logCalls = [...handlers.matchAll(/deps\.log\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    check("S6 every log call uses closed keys only", logCalls.length >= 8 && logCalls.every((body) => /^\s*event(: "[a-z_]+")?(, (allowed|outcome|provider_error): [^,]+)*\s*$/.test(body)), logCalls.find((b) => !/^\s*event:/.test(b)) ?? "");

    const env = readFileSync(".env.example", "utf8");
    check("S7 .env.example names every S1 variable without a value",
      ["ZYPACT_ACCOUNTS_ENABLED", "ZYPACT_SIGNUP_MODE", "ZYPACT_PILOT_SIGNUP_ALLOWLIST", "ZYPACT_ACCOUNT_SESSION_ABSOLUTE_MINUTES", "ZYPACT_ACCOUNT_SESSION_IDLE_MINUTES", "ZYPACT_ACCOUNT_HMAC_SECRET", "ZYPACT_ACCOUNT_HMAC_KEY_ID"]
        .every((v) => new RegExp(`^${v}=\\s*$`, "m").test(env)));
  }

  check("no network call", fetchCalls === 0);
  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
