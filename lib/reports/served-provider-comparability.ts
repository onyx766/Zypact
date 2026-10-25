/**
 * Whether a baseline and its retest were served by the same provider
 * pipeline, judged from what the provider RETURNED rather than what Zypact
 * asked for.
 *
 * compare-protocols.ts already treats a different `model_config` as an
 * identity mismatch. That catches a change Zypact makes. It cannot catch a
 * change the provider makes behind an unchanged request: intervention
 * 055c3514's baseline answered with Sonar-style response ids and its retest
 * with `resp_` ids, the format of Perplexity's Agent API, while both phases
 * sent byte-identical `{"model":"sonar", ...}` bodies.
 *
 * So every successful Perplexity receipt of every counted attempt is reduced
 * to a fingerprint of three fields the provider sets: the model it reports,
 * the format of its response id, and the response `object` type. A card
 * whose two phases do not share exactly one fingerprint — or where any
 * counted attempt has no readable receipt — cannot show the phases were
 * comparable, and is held for review with the reason stated. Nothing here
 * changes how the outcome is computed; it decides only whether a person must
 * read the card before it can be sent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** A counted attempt whose receipt could not be read yields this. */
export const UNREADABLE_FINGERPRINT = "unreadable";

export function fingerprintRawResponseBody(raw: unknown): string {
  if (typeof raw !== "string") return UNREADABLE_FINGERPRINT;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return UNREADABLE_FINGERPRINT;
  }
  if (!json || typeof json !== "object") return UNREADABLE_FINGERPRINT;
  const body = json as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : "none";
  const id = typeof body.id === "string" ? body.id : "";
  const idFormat = id === "" ? "none" : id.startsWith("resp_") ? "resp_" : "other";
  const object = typeof body.object === "string" ? body.object : "none";
  return `model=${model} id=${idFormat} object=${object}`;
}

/**
 * One fingerprint per counted (completed) attempt of the protocol. An
 * attempt with no successful Perplexity receipt contributes
 * UNREADABLE_FINGERPRINT rather than being skipped, so missing evidence can
 * never make two phases look alike.
 */
export async function readServedProviderFingerprints(
  client: SupabaseClient,
  protocolId: string
): Promise<string[]> {
  const { data: attempts, error: attemptError } = await client
    .from("protocol_attempts")
    .select("id,status")
    .eq("protocol_id", protocolId);
  if (attemptError) throw attemptError;

  const counted = (attempts ?? [])
    .filter((row: Record<string, any>) => row.status === "completed")
    .map((row: Record<string, any>) => row.id as string);
  if (counted.length === 0) return [];

  const { data: calls, error: callError } = await client
    .from("protocol_external_calls")
    .select("id,protocol_attempt_id,call_kind")
    .in("protocol_attempt_id", counted);
  if (callError) throw callError;

  const perplexityCalls = (calls ?? []).filter(
    (row: Record<string, any>) => row.call_kind === "perplexity"
  );

  let receipts: Record<string, any>[] = [];
  if (perplexityCalls.length > 0) {
    const { data, error } = await client
      .from("provider_call_receipts")
      .select("external_call_id,outcome,raw_response_body")
      .in("external_call_id", perplexityCalls.map((row: Record<string, any>) => row.id));
    if (error) throw error;
    receipts = (data ?? []) as Record<string, any>[];
  }

  return counted.map((attemptId) => {
    const fingerprints = perplexityCalls
      .filter((call: Record<string, any>) => call.protocol_attempt_id === attemptId)
      .flatMap((call: Record<string, any>) =>
        receipts.filter((r) => r.external_call_id === call.id && r.outcome === "success")
      )
      .map((r) => fingerprintRawResponseBody(r.raw_response_body));
    // No successful receipt, or successful receipts that disagree, is not
    // evidence of a single configuration having served the attempt.
    const distinct = Array.from(new Set(fingerprints));
    return distinct.length === 1 ? distinct[0] : UNREADABLE_FINGERPRINT;
  });
}

export interface ServedProviderComparability {
  comparable: boolean;
  /** Plain statement for the integrity reasons; empty when comparable. */
  detail: string;
}

export function evaluateServedProviderComparability(
  baseline: string[],
  retest: string[]
): ServedProviderComparability {
  const all = [...baseline, ...retest];
  const distinct = Array.from(new Set(all)).sort();
  if (baseline.length === 0 || retest.length === 0) {
    return {
      comparable: false,
      detail: "A phase has no counted attempt, so what served it cannot be compared.",
    };
  }
  if (distinct.includes(UNREADABLE_FINGERPRINT)) {
    return {
      comparable: false,
      detail:
        "At least one counted attempt has no readable provider receipt, so the provider configuration that served it is unknown.",
    };
  }
  if (distinct.length > 1) {
    const b = Array.from(new Set(baseline)).sort().join("; ");
    const r = Array.from(new Set(retest)).sort().join("; ");
    return {
      comparable: false,
      detail: `The provider did not serve both phases the same way (baseline: ${b}; retest: ${r}). The request was unchanged; the change is on the provider's side, so the two phases may not be comparable.`,
    };
  }
  return { comparable: true, detail: "" };
}
