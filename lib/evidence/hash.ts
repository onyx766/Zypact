import { createHash } from "node:crypto";

/**
 * Lower-case hex SHA-256 of a string, matching the format enforced by the
 * `*_sha256_format_check` constraints added in migration 0036.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
