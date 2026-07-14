/**
 * Sprint 12, Task 3 — sourcesCited wiring fix.
 *
 * The live-LLM Probe Analysis Agent frequently returns
 * `sourcesCited: []` even when the pasted AI response contains explicit
 * URLs (G2 links, product pages, etc.). Downstream, the deterministic
 * Gap Map citation scoring reads exactly this field — so a dropped URL
 * silently zeros out the "citation" gap. That is the wiring bug the
 * Sprint 12 brief calls out.
 *
 * Fix (no prompt change): after the agent returns, extract URLs from
 * the pasted `rawResponse` and union them into whatever `sourcesCited`
 * the LLM produced. Existing citations are preserved verbatim; new
 * ones are appended with a `classifySource`-style type inference.
 */

export interface SourceCitationLike {
  source: string;
  type: string;
}

/** Same URL pattern as `probe-analysis.buildMockProbeAnalysis`. */
const URL_RE = /https?:\/\/[^\s)\]"'<>]+/gi;

/** Same rough classifier heuristics as `probe-analysis.classifySource`. */
function classifyUrl(url: string): string {
  const lower = url.toLowerCase();
  if (/(^|\/\/|\.)g2\.com/.test(lower)) return "review_site";
  if (/(^|\/\/|\.)trustradius\./.test(lower)) return "review_site";
  if (/(^|\/\/|\.)capterra\./.test(lower)) return "review_site";
  if (/(^|\/\/|\.)producthunt\./.test(lower)) return "review_site";
  if (/(^|\/\/|\.)reddit\./.test(lower)) return "community";
  if (/(^|\/\/|\.)youtube\./.test(lower)) return "video";
  if (/\bdocs?\.|\/docs\/|\/documentation\b/.test(lower)) return "docs";
  if (/\bblog\.|\/blog\//.test(lower)) return "blog";
  if (/\bgithub\.com/.test(lower)) return "repo";
  return "external_source";
}

function toCitationArray(raw: unknown): SourceCitationLike[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceCitationLike[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = (item as { source?: unknown }).source;
    const type = (item as { type?: unknown }).type;
    if (typeof source !== "string" || source.trim().length === 0) continue;
    out.push({
      source: source.trim(),
      type: typeof type === "string" && type.trim().length > 0 ? type.trim() : classifyUrl(source),
    });
  }
  return out;
}

/**
 * Extract every URL out of `rawResponse` and union it with whatever the
 * LLM returned for `sourcesCited`. Preserves the LLM's original list
 * ordering and never overwrites a citation the LLM already produced.
 *
 * Exported for unit tests.
 */
export function mergeSourcesFromRawResponse(
  rawResponse: string,
  llmSourcesCited: unknown
): SourceCitationLike[] {
  const existing = toCitationArray(llmSourcesCited);
  const seen = new Set<string>();
  for (const c of existing) seen.add(c.source.toLowerCase());

  const merged: SourceCitationLike[] = [...existing];
  let m: RegExpExecArray | null;
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  while ((m = re.exec(rawResponse)) !== null) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (url.length === 0) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ source: url, type: classifyUrl(url) });
  }
  return merged;
}
