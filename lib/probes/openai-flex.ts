/**
 * OpenAI flex tier: recognising a capacity refusal.
 *
 * OpenAI's flex guide: when flex has no capacity a request gets "a `429
 * Resource Unavailable` error code. You will not be charged when this
 * occurs." OpenAI documents no type or code for it, so the error's own words
 * ("resource unavailable") are matched, in the error's type, code or message.
 *
 * Pure: no fetch, no environment, no adapter import. Moved here from
 * scripts/lib/chatgpt-benchmark.ts (D-056) so the worker can label such a
 * refusal without importing the benchmark or the adapter.
 */
export function isFlexResourceUnavailable(httpStatus: number | null, body: string | null): boolean {
  if (httpStatus !== 429 || !body) return false;
  try {
    const e = (JSON.parse(body) as { error?: { type?: unknown; code?: unknown; message?: unknown } } | null)?.error;
    const words = [e?.type, e?.code, e?.message].filter((x): x is string => typeof x === "string").join(" ");
    return /resource[\s_-]*unavailable/i.test(words);
  } catch {
    return false;
  }
}
