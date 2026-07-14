import { createHmac } from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type SnapshotFiInviteConfiguration =
  | {
      kind: "disabled";
    }
  | {
      kind: "enabled";
      hashSecret: string;
      expectedCodeHash: string;
    }
  | {
      kind: "invalid";
    };

export function normalizeSnapshotFiInviteCode(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw
    .normalize("NFKC")
    .trim()
    .toUpperCase();

  if (
    normalized.length === 0 ||
    normalized.length > 120
  ) {
    return null;
  }

  return normalized;
}

export function normalizeSnapshotFiInviteHash(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().toLowerCase();

  return HASH_PATTERN.test(normalized)
    ? normalized
    : null;
}

export function hashSnapshotFiInviteCode(
  rawCode: string | null | undefined,
  secret: string
): string | null {
  const code =
    normalizeSnapshotFiInviteCode(rawCode);

  if (!code) {
    return null;
  }

  if (secret.length < 32) {
    throw new Error(
      "Snapshot FI invite hash secret must contain at least 32 characters."
    );
  }

  return createHmac("sha256", secret)
    .update(code)
    .digest("hex");
}

export function readSnapshotFiInviteConfiguration(
  env: NodeJS.ProcessEnv = process.env
): SnapshotFiInviteConfiguration {
  const hashSecret =
    env.SNAPSHOT_FI_INVITE_HASH_SECRET
      ?.trim() || "";

  const rawExpectedHash =
    env.SNAPSHOT_FI_INVITE_CODE_HASH
      ?.trim() || "";

  if (!hashSecret && !rawExpectedHash) {
    return {
      kind: "disabled",
    };
  }

  const expectedCodeHash =
    normalizeSnapshotFiInviteHash(
      rawExpectedHash
    );

  if (
    hashSecret.length < 32 ||
    !expectedCodeHash
  ) {
    return {
      kind: "invalid",
    };
  }

  return {
    kind: "enabled",
    hashSecret,
    expectedCodeHash,
  };
}
