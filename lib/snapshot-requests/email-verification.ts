import {
  createHash,
  randomBytes,
} from "node:crypto";

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 24 * 60;

export interface SnapshotEmailVerificationToken {
  token: string;
  tokenHash: string;
  expiresAt: string;
}

export function hashSnapshotEmailVerificationToken(
  token: string
): string {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

export function generateSnapshotEmailVerificationToken(
  options: {
    now?: Date;
    ttlMinutes?: number;
  } = {}
): SnapshotEmailVerificationToken {
  const now = options.now ?? new Date();
  const ttlMinutes =
    options.ttlMinutes ?? DEFAULT_TTL_MINUTES;

  if (
    !Number.isFinite(ttlMinutes) ||
    ttlMinutes < MIN_TTL_MINUTES ||
    ttlMinutes > MAX_TTL_MINUTES
  ) {
    throw new Error(
      `Verification TTL must be between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES} minutes`
    );
  }

  const token = randomBytes(TOKEN_BYTES).toString(
    "base64url"
  );

  const tokenHash =
    hashSnapshotEmailVerificationToken(token);

  const expiresAt = new Date(
    now.getTime() + ttlMinutes * 60 * 1000
  ).toISOString();

  return {
    token,
    tokenHash,
    expiresAt,
  };
}
