import { randomBytes } from "node:crypto";

export function createPublicReportToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidPublicReportToken(
  value: string
): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
