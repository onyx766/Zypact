import type { ClientIdentity } from "@/lib/schemas/probe-analysis.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";

/**
 * M2 canonical observations contract, third tranche (D-017, D-018,
 * D-019) — the single, shared definition of how a project's client
 * identity (name, domain, aliases) is derived for entity resolution.
 *
 * Moved here, verbatim, from a private function of the same name that
 * previously lived in lib/pipeline/analyze-probe-response.ts. That
 * function had been hand-duplicated into
 * scripts/backfill-entity-observations.ts (the historical reprocessing
 * script) because it was not exported; this module is the fix — both
 * the live pipeline and the backfill script now import this one
 * definition, so they can never drift apart again.
 *
 * No functional change from either prior copy: same precedence (project
 * companyName, then Mirror Profile companyName, then the domain's stem),
 * same alias set (Mirror Profile companyName and the domain stem, each
 * only when distinct from the chosen name).
 */
export function buildClientIdentity(
  project: { companyName: string | null; domain: string },
  mp: SiteReaderOutput | null
): ClientIdentity {
  const name =
    (project.companyName && project.companyName.trim()) ||
    (mp?.companyName && mp.companyName.trim()) ||
    project.domain.split(".")[0];
  const aliases = new Set<string>();
  if (mp?.companyName && mp.companyName !== name) aliases.add(mp.companyName);
  const stem = project.domain.split(".")[0];
  if (stem && stem !== name) aliases.add(stem);
  return {
    name,
    domain: project.domain,
    aliases: Array.from(aliases),
  };
}
