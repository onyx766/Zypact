/**
 * S1 configuration (D-045). Every switch fails closed: accounts are off,
 * and signup is closed, unless the environment says otherwise exactly.
 *
 *   ZYPACT_ACCOUNTS_ENABLED            "true" turns the account area on
 *   ZYPACT_SIGNUP_MODE                 "pilot" | "open"; anything else is closed
 *   ZYPACT_PILOT_SIGNUP_ALLOWLIST      comma-separated emails, used in pilot mode
 *   ZYPACT_ACCOUNT_SESSION_ABSOLUTE_MINUTES / _IDLE_MINUTES   session lifetimes
 *   ZYPACT_ACCOUNT_HMAC_SECRET   >= 32 characters; keys rate-limit buckets and reset grants, by purpose label
 *   ZYPACT_ACCOUNT_HMAC_KEY_ID   names that secret in stored rate-limit rows (default "k1")
 */

export type SignupMode = "closed" | "pilot" | "open";

export interface AccountsConfig {
  enabled: boolean;
  signupMode: SignupMode;
  pilotAllowlist: ReadonlySet<string>;
  absoluteSeconds: number;
  idleSeconds: number;
  hmacSecret: string | null;
  hmacKeyId: string;
}

export const ACCOUNTS_ENABLED_ENV = "ZYPACT_ACCOUNTS_ENABLED";

const DEFAULT_ABSOLUTE_MINUTES = 720;
const DEFAULT_IDLE_MINUTES = 60;

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function minutes(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function readAccountsConfig(env: Record<string, string | undefined> = process.env): AccountsConfig {
  const mode = (env.ZYPACT_SIGNUP_MODE ?? "").trim();
  const absoluteMinutes = minutes(env.ZYPACT_ACCOUNT_SESSION_ABSOLUTE_MINUTES, DEFAULT_ABSOLUTE_MINUTES, 5, 10080);
  const idleMinutes = Math.min(absoluteMinutes, minutes(env.ZYPACT_ACCOUNT_SESSION_IDLE_MINUTES, DEFAULT_IDLE_MINUTES, 5, 1440));
  const secret = env.ZYPACT_ACCOUNT_HMAC_SECRET ?? "";
  const keyId = (env.ZYPACT_ACCOUNT_HMAC_KEY_ID ?? "k1").trim();

  return {
    enabled: env[ACCOUNTS_ENABLED_ENV] === "true",
    signupMode: mode === "pilot" || mode === "open" ? mode : "closed",
    pilotAllowlist: new Set(
      (env.ZYPACT_PILOT_SIGNUP_ALLOWLIST ?? "").split(",").map(normalizeEmail).filter((e) => e.includes("@"))
    ),
    absoluteSeconds: absoluteMinutes * 60,
    idleSeconds: idleMinutes * 60,
    hmacSecret: secret.length >= 32 ? secret : null,
    hmacKeyId: /^[a-z0-9_.-]{1,32}$/.test(keyId) ? keyId : "k1",
  };
}

/** Whether this email may create an account and its workspace now. */
export function signupAllowed(email: string, config: Pick<AccountsConfig, "signupMode" | "pilotAllowlist">): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) return false;
  if (config.signupMode === "open") return true;
  if (config.signupMode === "pilot") return config.pilotAllowlist.has(normalized);
  return false;
}

export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt, which Supabase Auth uses, reads at most 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    return `Use at most ${PASSWORD_MAX_BYTES} bytes.`;
  }
  return null;
}

export function cleanWorkspaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 80 ? name : null;
}

export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
