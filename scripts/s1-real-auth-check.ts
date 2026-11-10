#!/usr/bin/env tsx
/**
 * S1 real-login check against a NON-PRODUCTION Supabase project (D-045 gate;
 * CURRENT_STATUS §20.6 gate 6). Opt-in; never runs in CI.
 *
 *   ZYPACT_S1_REAL_AUTH=1 npx tsx scripts/s1-real-auth-check.ts
 *
 * Reads .env.s1test (S1TEST_SUPABASE_URL, S1TEST_ANON_KEY,
 * S1TEST_SERVICE_ROLE_KEY) and refuses to start if any value names the live
 * project. Drives the real S1 handlers with:
 *   - the real store (service-role RPCs on the test project's database), and
 *   - a real Auth port: supabase-js against the test project's GoTrue, one
 *     in-memory "browser" per client, standing in for the cookie-bound client.
 *
 * Emails are never sent: users are created and verified through the admin
 * generateLink API (no email) and verifyOtp, because the project's default
 * mail sender only delivers to team members. Prints check labels and
 * pass/fail only: no key, token, password or user id.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import type { AccountsConfig } from "@/lib/accounts/config";
import {
  handleResetPassword,
  handleSignIn,
  handleSignOut,
  handleSignUp,
  handleStepUp,
  resolveAccount,
  signResetGrant,
  type AuthPort,
  type AuthUser,
  type HandlerDeps,
} from "@/lib/accounts/handlers";
import { supabaseAccountStore } from "@/lib/accounts/store";

const LIVE_REF = "bfqpkfqsonixdnfiodwk";

if (process.env.ZYPACT_S1_REAL_AUTH !== "1") {
  console.log("SKIP: set ZYPACT_S1_REAL_AUTH=1 to run against the test project. A SKIP is not a pass.");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(".env.s1test", "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
// The dashboard's Data API page shows the URL with /rest/v1/ appended; the
// clients need the bare project origin.
const URL_ = (() => {
  try {
    return new URL(env.S1TEST_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
})();
const ANON = env.S1TEST_ANON_KEY ?? "";
const SERVICE = env.S1TEST_SERVICE_ROLE_KEY ?? "";
if (!URL_ || !ANON || !SERVICE) {
  console.log("REFUSED: .env.s1test is incomplete");
  process.exit(2);
}
if ([URL_, ANON, SERVICE].some((v) => v.includes(LIVE_REF)) || JSON.stringify(env).includes(LIVE_REF)) {
  console.log("REFUSED: .env.s1test names the live project");
  process.exit(2);
}

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

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
function browser(): SupabaseClient {
  return createClient(URL_, ANON, {
    auth: { persistSession: true, autoRefreshToken: false, storage: memoryStorage(), flowType: "pkce" },
  });
}
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

/** A real Auth port bound to one simulated browser. Mail-sending calls are recorded, not made. */
function authPort(client: SupabaseClient, sent: string[]): AuthPort {
  return {
    async signUp(email) {
      sent.push(`signUp:${email}`);
      return { sessionCreated: false, errorCode: null };
    },
    async signInWithPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error?.code === "email_not_confirmed") return "email_not_confirmed";
      return error ? null : toAuthUser(data.user);
    },
    async getUser() {
      const { data, error } = await client.auth.getUser();
      return error ? null : toAuthUser(data.user);
    },
    async signOut() {
      await client.auth.signOut({ scope: "local" });
    },
    async resendSignup(email) {
      sent.push(`resend:${email}`);
    },
    async resetPasswordForEmail(email) {
      sent.push(`reset:${email}`);
    },
    async exchangeCode() {
      return false;
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      return !error;
    },
    async verifyPassword(email, password) {
      const verifier = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await verifier.auth.signInWithPassword({ email, password });
      if (error) return false;
      await verifier.auth.signOut({ scope: "local" });
      return true;
    },
  };
}

const run = randomBytes(4).toString("hex");
const APPROVED = `s1-approved-${run}@example.com`;
const STRANGER = `s1-stranger-${run}@example.com`;
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;
const NEW_PASSWORD = `np-${randomBytes(9).toString("base64url")}`;

const config: AccountsConfig = {
  enabled: true,
  signupMode: "pilot",
  pilotAllowlist: new Set([APPROVED]),
  absoluteSeconds: 3600,
  idleSeconds: 900,
  hmacSecret: randomBytes(32).toString("hex"),
  hmacKeyId: "s1test",
};
const store = supabaseAccountStore(admin);
let tokenSeq = 0;
function deps(client: SupabaseClient, sent: string[]): HandlerDeps {
  return {
    config,
    store,
    auth: authPort(client, sent),
    newToken: () => `s1real-${run}-${++tokenSeq}-${randomBytes(24).toString("base64url")}`,
    now: () => Date.now(),
    log: () => {},
  };
}
const CTX = { ip: `198.51.100.${Math.floor(Math.random() * 200) + 20}`, origin: "https://test.invalid" };
const created: string[] = [];

async function createUnverified(email: string, workspaceName: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "signup",
    email,
    password: PASSWORD,
    options: { data: { workspace_name: workspaceName } },
  });
  if (error || !data.user) throw new Error(`generateLink failed: ${error?.code ?? "no user"}`);
  created.push(data.user.id);
  return data.properties.hashed_token;
}

async function memberships(accountId: string): Promise<number> {
  // Closed tables: read through a service-role SQL-free path is impossible, so
  // count through the store's own refusal instead (NO_MEMBERSHIP vs OPENED).
  const probe = `probe-${run}-${randomBytes(24).toString("base64url")}`;
  const status = await store.openSession(accountId, probe, 3600, 900);
  if (status === "OPENED") await store.revokeSession(probe);
  return status === "NO_MEMBERSHIP" ? 0 : status === "OPENED" ? 1 : 2;
}

async function restStatus(path: string, key: string, bearer: string, body?: unknown): Promise<number> {
  const res = await fetch(`${URL_}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: key, authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

async function main(): Promise<void> {
  console.log("S1 real-login check (test project only)");

  /* 1. Sign-up policy against real Auth ---------------------------- */
  {
    const sent: string[] = [];
    const r = await handleSignUp(deps(browser(), sent), { email: STRANGER, password: PASSWORD, workspaceName: "Stranger Co" }, CTX);
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    check("R1 an unapproved email gets the same 202 and no Auth user is created",
      r.status === 202 && sent.length === 0 && !(data?.users ?? []).some((u) => u.email === STRANGER));
    const sentA: string[] = [];
    const ra = await handleSignUp(deps(browser(), sentA), { email: APPROVED, password: PASSWORD, workspaceName: "Approved Co" }, CTX);
    check("R1 an approved email reaches Auth sign-up with the same 202", ra.status === 202 && sentA.length === 1);
  }

  /* 2. Unverified, then verified ----------------------------------- */
  const tokenHash = await createUnverified(APPROVED, "Approved Co");
  const b1 = browser();
  const sent1: string[] = [];
  {
    const r = await handleSignIn(deps(b1, sent1), { email: APPROVED, password: PASSWORD }, CTX);
    const userId = created[0];
    check("R2 before verification, sign-in is refused with no session", r.status === 403 && r.body.error === "email_not_verified" && !r.setSessionCookie);
    check("R2 and no workspace was created", (await memberships(userId)) === 0);
  }
  {
    const { error } = await b1.auth.verifyOtp({ type: "email", token_hash: tokenHash });
    check("R3 the verification link's token confirms the email on the real Auth server", !error, error?.code ?? "");
    await b1.auth.signOut({ scope: "local" });
  }

  /* 3. First verified sign-in provisions the workspace ------------- */
  let token = "";
  let accountId = "";
  {
    const r = await handleSignIn(deps(b1, sent1), { email: APPROVED, password: PASSWORD }, CTX);
    token = r.setSessionCookie?.token ?? "";
    accountId = created[0];
    check("R4 first verified sign-in opens a session", r.status === 200 && token.length > 0, `status ${r.status} ${String(r.body.error ?? "")}`);
    check("R4 exactly one workspace membership now exists", (await memberships(accountId)) === 1);
    const account = await resolveAccount(deps(b1, sent1), token);
    check("R5 the session resolves through the real JWT to its workspace", account?.accountId === accountId && account.session.status === "ACTIVE" && account.workspaceName === "Approved Co");
  }
  {
    const b2 = browser();
    const r = await handleSignIn(deps(b2, []), { email: APPROVED, password: PASSWORD }, CTX);
    check("R6 a second sign-in elsewhere opens a second session without a second workspace", r.status === 200 && (await memberships(accountId)) === 1);
    const wrong = await handleSignIn(deps(browser(), []), { email: APPROVED, password: "definitely-not-it" }, CTX);
    check("R7 a wrong password is one generic 401", wrong.status === 401 && wrong.body.error === "invalid_credentials");
  }

  /* 4. Binding: a token never works for another identity ----------- */
  {
    await createUnverified(STRANGER, "Stranger Co");
    const strangerId = created[1];
    await admin.auth.admin.updateUserById(strangerId, { email_confirm: true });
    const bs = browser();
    const r = await handleSignIn(deps(bs, []), { email: STRANGER, password: PASSWORD }, CTX);
    check("R8 a verified but unapproved account gets no workspace and no session",
      r.status === 403 && r.body.error === "not_approved" && (await memberships(strangerId)) === 0);
    await bs.auth.signInWithPassword({ email: STRANGER, password: PASSWORD });
    const stolen = await resolveAccount(deps(bs, []), token);
    check("R9 another verified user presenting this session's token resolves to nothing", stolen === null);
    await bs.auth.signOut({ scope: "local" });
  }

  /* 5. Step-up ------------------------------------------------------- */
  {
    const d = deps(b1, sent1);
    const account = await resolveAccount(d, token);
    const bad = await handleStepUp(d, account, token, { password: "nope-nope-nope" });
    const good = await handleStepUp(d, account, token, { password: PASSWORD });
    const after = await resolveAccount(d, token);
    check("R10 step-up refuses a wrong password and records a correct one",
      bad.status === 401 && good.status === 200 && Boolean(after?.session.stepUpAt));
    check("R10 step-up did not end the browser's own Auth session", (await d.auth.getUser())?.id === accountId);
  }

  /* 6. Closed to the browser roles through the real API gateway ----- */
  {
    const { data: s } = await b1.auth.getSession();
    const userJwt = s.session?.access_token ?? "";
    const statuses = [
      await restStatus("/rest/v1/account_sessions?select=id&limit=1", ANON, ANON),
      await restStatus("/rest/v1/account_sessions?select=id&limit=1", ANON, userJwt),
      await restStatus("/rest/v1/workspaces?select=id&limit=1", ANON, userJwt),
      await restStatus("/rest/v1/account_rate_limit_events?select=id&limit=1", ANON, userJwt),
      await restStatus("/rest/v1/rpc/check_account_session", ANON, ANON, { p_token: token, p_account_id: accountId }),
      await restStatus("/rest/v1/rpc/check_account_session", ANON, userJwt, { p_token: token, p_account_id: accountId }),
      await restStatus("/rest/v1/rpc/open_account_session", ANON, userJwt, { p_account_id: accountId, p_token: "x".repeat(40), p_absolute_seconds: 3600, p_idle_seconds: 900 }),
      await restStatus("/rest/v1/rpc/create_workspace_with_owner", ANON, userJwt, { p_account_id: accountId, p_name: "x", p_idempotency_key: "x", p_actor_type: "system", p_rule_id: "x", p_rule_version: "1" }),
    ];
    check("R11 anon and signed-in browser tokens are refused on every S1/Q2′ table and function", statuses.every((c) => c >= 400), statuses.join(","));
  }

  /* 7. Sign-out ---------------------------------------------------- */
  {
    const d = deps(b1, sent1);
    const r = await handleSignOut(d, token);
    check("R12 sign-out revokes the session in the database", r.clearSessionCookie === true && (await store.checkSession(token, accountId)).status === "REVOKED");
  }

  /* 8. Password reset ends every session ---------------------------- */
  {
    const b3 = browser();
    const live = await handleSignIn(deps(b3, []), { email: APPROVED, password: PASSWORD }, CTX);
    const liveToken = live.setSessionCookie?.token ?? "";
    const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: APPROVED });
    const b4 = browser();
    const { error: vErr } = await b4.auth.verifyOtp({ type: "recovery", token_hash: data?.properties?.hashed_token ?? "" });
    const d4 = deps(b4, []);
    const refused = await handleResetPassword(d4, { password: NEW_PASSWORD }, null);
    const reset = await handleResetPassword(d4, { password: NEW_PASSWORD }, signResetGrant(d4, accountId));
    check("R13 a recovery session without the reset grant cannot change the password", !error && !vErr && refused.status === 401);
    check("R13 with the grant the password changes and every account session is revoked",
      reset.status === 200 && (await store.checkSession(liveToken, accountId)).status === "REVOKED");
    const oldPw = await handleSignIn(deps(browser(), []), { email: APPROVED, password: PASSWORD }, CTX);
    const newPw = await handleSignIn(deps(browser(), []), { email: APPROVED, password: NEW_PASSWORD }, CTX);
    check("R14 the old password no longer works; the new one does", oldPw.status === 401 && newPw.status === 200);
  }

  /* 9. Rate limit through the real RPC ------------------------------ */
  {
    const victim = `s1-ratelimit-${run}@example.com`;
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) codes.push((await handleSignIn(deps(browser(), []), { email: victim, password: "wrong-wrong-wrong" }, CTX)).status);
    check("R15 the email bucket allows 10 sign-in attempts, then refuses with 429", codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429, codes.join(","));
  }

  /* Cleanup --------------------------------------------------------- */
  for (const id of created) await admin.auth.admin.deleteUser(id);
  console.log(`  (removed ${created.length} test Auth users; closed-table rows stay in the test project)`);

  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "S1 REAL-LOGIN CHECK PASSED (test project)." : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  for (const id of created) await admin.auth.admin.deleteUser(id).catch(() => {});
  console.error(`s1-real-auth-check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
