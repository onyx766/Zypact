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
 * the format of its response id, and the response `object` type.
 *
 * PR #3: this served-side fingerprint is now one part of the full
 * measurement fingerprint (measurement-fingerprint.ts), which also covers
 * the request parameters, the endpoint and the analysis model, and which
 * decides both the card's integrity and whether its outcome is comparable.
 */

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
