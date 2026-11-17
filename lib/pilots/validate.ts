/**
 * D-054 — input checks for the pilot routes.
 *
 * The website is normalized by the same function a request uses, and a
 * question follows the request form's rule (trimmed, 10-300 characters), so
 * a pilot cannot carry a domain or a question shape a request would have
 * refused. The database re-checks every bound; these give the founder a
 * readable message first.
 */
import { createHash } from "node:crypto";

import type { QuestionProvenanceChoice } from "@/lib/db/types";
import {
  normalizeWebsite,
  SnapshotRequestValidationError,
} from "@/lib/snapshot-requests/normalize-request";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** D-053: 15 questions, 20 at most. */
export const DEFAULT_QUESTION_LIMIT = 15;
export const MAX_QUESTION_LIMIT = 20;
/** D-053: 90 days. */
export const PILOT_LENGTH_DAYS = 90;
/** D-054: a pilot starts no earlier than yesterday and no later than 60 days ahead. */
export const START_DAYS_BEFORE_TODAY = 1;
export const START_DAYS_AFTER_TODAY = 60;

export type Issues = Record<string, string[]>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Issues };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in YYYY-MM-DD form. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today as the database's current_date (UTC on Supabase). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus whole days, as the SQL's date + integer. */
export function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function text(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v.trim() : "";
}

export interface CreatePilotFields {
  companyName: string;
  websiteUrl: string;
  normalizedDomain: string;
  siteControlNote: string;
  questionLimit: number;
  startsOn: string;
  idempotencyKey: string;
}

export function parseCreatePilot(raw: unknown, today = todayUtc()): Parsed<CreatePilotFields> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const issues: Issues = {};
  const add = (k: string, m: string) => {
    (issues[k] ??= []).push(m);
  };

  const companyName = text(body, "companyName");
  if (companyName.length < 2 || companyName.length > 120) add("companyName", "Enter the company name (2-120 characters).");

  let websiteUrl = "";
  let normalizedDomain = "";
  try {
    const site = normalizeWebsite(text(body, "websiteUrl"));
    websiteUrl = site.websiteUrl;
    normalizedDomain = site.normalizedDomain;
  } catch (error) {
    if (error instanceof SnapshotRequestValidationError) {
      for (const m of error.issues.websiteUrl ?? []) add("websiteUrl", m);
    } else {
      throw error;
    }
  }

  const siteControlNote = text(body, "siteControlNote");
  if (siteControlNote.length < 10 || siteControlNote.length > 2000) {
    add("siteControlNote", "Say how you confirmed the customer controls this website (10-2000 characters).");
  }

  const limitRaw = body.questionLimit ?? DEFAULT_QUESTION_LIMIT;
  const questionLimit = typeof limitRaw === "string" ? Number(limitRaw) : limitRaw;
  if (typeof questionLimit !== "number" || !Number.isInteger(questionLimit) || questionLimit < 1 || questionLimit > MAX_QUESTION_LIMIT) {
    add("questionLimit", `The question limit is a whole number from 1 to ${MAX_QUESTION_LIMIT}.`);
  }

  const startsOn = text(body, "startsOn");
  if (!isIsoDay(startsOn)) {
    add("startsOn", "Enter the start date.");
  } else if (
    startsOn < addDaysIso(today, -START_DAYS_BEFORE_TODAY)
    || startsOn > addDaysIso(today, START_DAYS_AFTER_TODAY)
  ) {
    add("startsOn", `The start date must be between yesterday and ${START_DAYS_AFTER_TODAY} days from today.`);
  }

  const idempotencyKey = text(body, "idempotencyKey");
  if (!UUID_PATTERN.test(idempotencyKey)) add("idempotencyKey", "Reload the page and try again.");

  if (Object.keys(issues).length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      companyName,
      websiteUrl,
      normalizedDomain,
      siteControlNote,
      questionLimit: questionLimit as number,
      startsOn,
      idempotencyKey,
    },
  };
}

export interface AddPilotQuestionFields {
  questionText: string;
  promptHash: string;
  questionProvenance: QuestionProvenanceChoice;
  customerApprovalRef: string;
  customerApprovedOn: string;
  idempotencyKey: string;
}

/**
 * Prompt identity: the SHA-256 of the exact approved question text, as the
 * request approval computes it. The database re-checks it (D-054).
 */
export function promptHashOf(questionText: string): string {
  return createHash("sha256").update(questionText).digest("hex");
}

export function parseAddPilotQuestion(raw: unknown, today = todayUtc()): Parsed<AddPilotQuestionFields> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const issues: Issues = {};
  const add = (k: string, m: string) => {
    (issues[k] ??= []).push(m);
  };

  const questionText = text(body, "questionText");
  if (questionText.length < 10 || questionText.length > 300) {
    add("questionText", "Enter the full buyer question (10-300 characters).");
  }

  const provenance = body.questionProvenance;
  if (provenance !== "customer_supplied" && provenance !== "founder_supplied") {
    add("questionProvenance", "Say who supplied this question, the customer or Zypact.");
  }

  const customerApprovalRef = text(body, "customerApprovalRef");
  if (customerApprovalRef.length < 3 || customerApprovalRef.length > 300) {
    add("customerApprovalRef", "Say where the customer's written approval is kept (3-300 characters).");
  }

  const customerApprovedOn = text(body, "customerApprovedOn");
  if (!isIsoDay(customerApprovedOn) || customerApprovedOn > today) {
    add("customerApprovedOn", "Enter the date the customer approved this question in writing (not in the future).");
  }

  const idempotencyKey = text(body, "idempotencyKey");
  if (!UUID_PATTERN.test(idempotencyKey)) add("idempotencyKey", "Reload the page and try again.");

  if (Object.keys(issues).length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      questionText,
      promptHash: promptHashOf(questionText),
      questionProvenance: provenance as QuestionProvenanceChoice,
      customerApprovalRef,
      customerApprovedOn,
      idempotencyKey,
    },
  };
}
