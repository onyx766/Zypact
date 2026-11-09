/**
 * Account rate limits. Buckets are keyed HMACs under their own purpose label,
 * so neither an address nor an email is stored, and a key from another
 * feature's limiter can never collide with one of these.
 */
import { createHmac } from "node:crypto";

export const ACCOUNT_RATE_LIMIT_PURPOSE = "zypact.account.rate_limit.v1";

export type RatePurpose = "sign_up" | "sign_in" | "resend_verification" | "password_reset" | "step_up";
export type BucketKind = "ip" | "email" | "account";

export interface RateRule {
  kind: BucketKind;
  windowSeconds: number;
  max: number;
}

/** Per purpose: every bucket must allow, or the request is refused. */
export const RATE_RULES: Record<RatePurpose, RateRule[]> = {
  sign_up: [
    { kind: "ip", windowSeconds: 3600, max: 10 },
    { kind: "email", windowSeconds: 3600, max: 3 },
  ],
  sign_in: [
    { kind: "ip", windowSeconds: 900, max: 30 },
    { kind: "email", windowSeconds: 900, max: 10 },
  ],
  resend_verification: [
    { kind: "ip", windowSeconds: 3600, max: 10 },
    { kind: "email", windowSeconds: 3600, max: 3 },
  ],
  password_reset: [
    { kind: "ip", windowSeconds: 3600, max: 10 },
    { kind: "email", windowSeconds: 3600, max: 3 },
  ],
  step_up: [{ kind: "account", windowSeconds: 900, max: 5 }],
};

export function bucketKey(secret: string, kind: BucketKind, value: string): string {
  return createHmac("sha256", secret)
    .update(`${ACCOUNT_RATE_LIMIT_PURPOSE}\u001f${kind}\u001f${value}`)
    .digest("hex");
}

/** The caller's address as the platform reports it; "unknown" is one shared bucket. */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
