/**
 * Hard source rules (D-039, design sections 5 and 9) and the provisional
 * `possible_personal_data` review signal.
 *
 * The curator's `personalDataRemoved` confirmation, and the customer's
 * attestation for customer material, are hard rules checked on their own
 * fields. The personal-data pattern is a separate review signal: it never
 * refuses, accepts or confirms a source, and its absence says nothing
 * about whether personal data is present.
 */

import { createHash } from "node:crypto";
import { codePointLength } from "./normalize";
import {
  EXCERPT_MAX_CODE_POINTS,
  SOURCE_KINDS,
  type QuestionSource,
  type Refusal,
  type Signal,
  type SourceKind,
  type Verification,
} from "./types";

export const PUBLIC_SOURCE_KINDS: readonly SourceKind[] = [
  "public_community",
  "public_review",
  "public_analyst",
  "site_copy",
];

export function isPublicKind(kind: SourceKind): boolean {
  return PUBLIC_SOURCE_KINDS.includes(kind);
}

/**
 * Seller-authored text: the customer's own site copy, or any source not
 * authored by a buyer. Usable only as `context`.
 */
export function isSellerSource(source: QuestionSource): boolean {
  return source.kind === "site_copy" || source.buyerAuthored !== true;
}

/** A source's own verification status, fixed by its kind. */
export function sourceVerification(source: QuestionSource): Verification {
  return source.kind === "customer_material" ? "customer_provided" : "public_verifiable";
}

export function sha256Utf8Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Personal-data patterns v1 (provisional). Kinds only; matched text is never echoed. */
const PERSONAL_DATA_PATTERNS_V1: ReadonlyArray<[string, RegExp]> = [
  ["email", /[^\s@]+@[^\s@]+\.[^\s@]+/u],
  ["handle", /(?:^|[^\p{L}\p{N}_@])@[A-Za-z0-9_]{2,}/u],
  ["phone", /\+?\d[\d\s().-]{7,}\d/u],
  ["url", /\bhttps?:\/\/\S+|\bwww\.\S+/iu],
];

export function possiblePersonalDataSignal(text: string): Signal | null {
  const kinds = PERSONAL_DATA_PATTERNS_V1.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  return kinds.length === 0 ? null : { code: "possible_personal_data", detail: kinds.join(",") };
}

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

export interface SourceValidation {
  sourceId: string;
  refusals: Refusal[];
  signals: Signal[];
}

export function validateSource(source: QuestionSource): SourceValidation {
  const refusals: Refusal[] = [];
  const signals: Signal[] = [];

  if (!(SOURCE_KINDS as readonly string[]).includes(source.kind)) {
    refusals.push({ code: "unknown_source_kind" });
  }

  const excerpt = typeof source.excerpt === "string" ? source.excerpt : "";
  const length = codePointLength(excerpt);
  if (length === 0) refusals.push({ code: "excerpt_empty" });
  if (length > EXCERPT_MAX_CODE_POINTS) {
    refusals.push({ code: "excerpt_too_long", detail: `${length} code points` });
  }
  if (source.excerptSha256 !== sha256Utf8Hex(excerpt)) {
    refusals.push({ code: "excerpt_hash_mismatch" });
  }

  if (source.kind === "customer_material") {
    if (isBlank(source.customerReference)) refusals.push({ code: "customer_material_missing_reference" });
    if (isBlank(source.customerAttestedAt)) refusals.push({ code: "customer_material_missing_attestation" });
    if (isBlank(source.retrievedAt)) refusals.push({ code: "customer_material_missing_date_received" });
  } else if (isPublicKind(source.kind)) {
    if (isBlank(source.url)) refusals.push({ code: "public_source_missing_url" });
    if (isBlank(source.retrievedAt)) refusals.push({ code: "public_source_missing_retrieved_at" });
  }

  if (source.personalDataRemoved !== true) {
    refusals.push({ code: "personal_data_confirmation_missing" });
  }

  if (source.kind === "site_copy" && source.buyerAuthored === true) {
    refusals.push({ code: "site_copy_cannot_be_buyer_authored" });
  }

  const personal = possiblePersonalDataSignal(excerpt);
  if (personal !== null) signals.push(personal);

  return { sourceId: source.id, refusals, signals };
}
