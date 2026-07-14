import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { CreateSnapshotRequestInput } from "@/lib/db/types";

const requestFieldsSchema = z
  .object({
    workEmail: z.string().trim().email().max(254),
    companyName: z.string().trim().min(2).max(120),
    websiteUrl: z.string().trim().min(1).max(2048),
    buyerCategory: z.string().trim().min(2).max(160),
  })
  .strict();

const submissionSchema = requestFieldsSchema
  .extend({
    turnstileToken: z
      .string()
      .trim()
      .min(1, "Complete the security check.")
      .max(2048),
  })
  .strict();

type RequestFields = z.infer<typeof requestFieldsSchema>;

export class SnapshotRequestValidationError extends Error {
  readonly issues: Record<string, string[]>;

  constructor(issues: Record<string, string[]>) {
    super("Invalid snapshot request");
    this.name = "SnapshotRequestValidationError";
    this.issues = issues;
  }
}

function validationIssues(
  error: z.ZodError
): Record<string, string[]> {
  const flattened = error.flatten().fieldErrors;
  const issues: Record<string, string[]> = {};

  for (const [field, messages] of Object.entries(flattened)) {
    if (messages && messages.length > 0) {
      issues[field] = messages;
    }
  }

  return issues;
}

function websiteError(message: string): SnapshotRequestValidationError {
  return new SnapshotRequestValidationError({
    websiteUrl: [message],
  });
}

function normalizeWebsite(raw: string): {
  websiteUrl: string;
  normalizedDomain: string;
} {
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;

  let url: URL;

  try {
    url = new URL(withProtocol);
  } catch {
    throw websiteError("Enter a valid company website.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw websiteError("Only HTTP and HTTPS websites are accepted.");
  }

  if (url.username || url.password) {
    throw websiteError("Website credentials are not accepted.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipCandidate = hostname.replace(/^\[/, "").replace(/\]$/, "");

  const blockedHost =
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isIP(ipCandidate) !== 0 ||
    !hostname.includes(".");

  if (blockedHost) {
    throw websiteError("Enter a public company domain.");
  }

  const normalizedDomain = hostname.startsWith("www.")
    ? hostname.slice(4)
    : hostname;

  const port = url.port ? `:${url.port}` : "";

  return {
    websiteUrl: `${url.protocol}//${hostname}${port}`,
    normalizedDomain,
  };
}

function normalizeFields(
  data: RequestFields
): CreateSnapshotRequestInput {
  const website = normalizeWebsite(data.websiteUrl);

  return {
    workEmail: data.workEmail,
    normalizedEmail: data.workEmail.toLowerCase(),
    companyName: data.companyName,
    websiteUrl: website.websiteUrl,
    normalizedDomain: website.normalizedDomain,
    buyerCategory: data.buyerCategory,
  };
}

export function normalizeSnapshotRequestInput(
  raw: unknown
): CreateSnapshotRequestInput {
  const parsed = requestFieldsSchema.safeParse(raw);

  if (!parsed.success) {
    throw new SnapshotRequestValidationError(
      validationIssues(parsed.error)
    );
  }

  return normalizeFields(parsed.data);
}

export function parseSnapshotRequestSubmission(raw: unknown): {
  input: CreateSnapshotRequestInput;
  turnstileToken: string;
} {
  const parsed = submissionSchema.safeParse(raw);

  if (!parsed.success) {
    throw new SnapshotRequestValidationError(
      validationIssues(parsed.error)
    );
  }

  return {
    input: normalizeFields(parsed.data),
    turnstileToken: parsed.data.turnstileToken,
  };
}

export function extractRequestIp(headers: Headers): string | null {
  const direct =
    headers.get("cf-connecting-ip") ||
    headers.get("x-real-ip");

  if (direct?.trim()) return direct.trim();

  const forwarded = headers.get("x-forwarded-for");
  const firstForwarded = forwarded?.split(",")[0]?.trim();

  return firstForwarded || null;
}

export function hashRequestIp(
  ip: string | null,
  secret: string
): string | null {
  if (!ip) return null;

  return createHmac("sha256", secret)
    .update(ip)
    .digest("hex");
}
