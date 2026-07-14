import type { AssetType, FixType } from "@/lib/schemas/fix-brief.schema";

/**
 * Sprint 7 mapping helpers.
 *
 * `inferFixType` converts a Gap.type (or a suggestedFixDirection hint) into
 * the canonical `FixType` used by the Fix Brief. `defaultAssetsForFixType`
 * maps a `FixType` to the default set of asset types the Fix Brief will
 * later ask the (deferred) `generate_asset` mode to produce.
 *
 * Both helpers are deterministic and covered by the Sprint 7 unit test.
 * They are kept LLM-independent so the mock and the pipeline runner can
 * share the same logic without coordination overhead.
 */

/**
 * Map a Gap.type (as produced by the Gap Map Agent) — and, as fallback, a
 * suggestedFixDirection hint — to a canonical FixType.
 */
export function inferFixType(
  gapType: string,
  suggestedFixDirection?: string
): FixType {
  const key = gapType.trim().toLowerCase();
  switch (key) {
    case "comparison_content":
      return "comparison_page";
    case "citation":
      // Ambiguous: could be a proof block ("get named in the source") or a
      // comparison page. Sprint 5's citation gap is usually "AI is citing
      // vendor pages we don't own", so proof_block is the closer fit.
      return "proof_block";
    case "review":
      return "proof_block";
    case "proof":
      return "proof_block";
    case "entity_clarity":
      return "faq_block";
    case "prompt_loss":
      return "comparison_page";
    case "schema":
    case "structured_data":
      return "schema";
    default:
      break;
  }

  const hint = (suggestedFixDirection ?? "").toLowerCase();
  if (/\bschema\b|structured data|json-?ld/.test(hint)) return "schema";
  if (/\bcompar/.test(hint)) return "comparison_page";
  if (/\breview\b|g2|capterra/.test(hint)) return "proof_block";
  if (/\bproof\b|case stud|customer/.test(hint)) return "proof_block";
  if (/\bfaq\b|category|clari/.test(hint)) return "faq_block";
  return "faq_block";
}

/**
 * The default set of assets we'll want the (deferred) `generate_asset`
 * mode to produce for a given FixType. Order matters — the first entry is
 * the primary asset for that fix.
 */
export function defaultAssetsForFixType(fixType: FixType): AssetType[] {
  switch (fixType) {
    case "comparison_page":
      return ["comparison_page_outline", "comparison_table", "faq_block"];
    case "faq_block":
      return ["faq_block"];
    case "proof_block":
      return ["proof_block"];
    case "comparison_table":
      return ["comparison_table"];
    case "schema":
      return ["json_ld_schema"];
  }
}
