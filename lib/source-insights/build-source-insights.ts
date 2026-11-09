/**
 * Aggregates per-run provider sources into the report's source section, and
 * compares two phases for the Outcome Card. Pure.
 *
 * Denominators are explicit: a domain is "cited in k of n", where n is the
 * readable runs that had a verified source list. Runs without one are
 * counted and named in the notes, never read as "not cited".
 */

import type {
  ProtocolReportRunSources,
  ProtocolReportSourceDomain,
  ProtocolReportSourceInsights,
  ProviderSourceStatus,
} from "@/lib/reports/protocol-report-types";
import { PROVIDER_SOURCES_RULE_VERSION } from "@/lib/source-insights/extract-provider-sources";
import {
  SOURCE_TYPE_LIST_VERSION,
  categorizeDomain,
  type SourceCategory,
} from "@/lib/source-insights/source-types";

export const MAX_DOMAINS_SHOWN = 40;
const MAX_URLS_PER_DOMAIN = 10;

export const SOURCE_DEFINITION_NOTE =
  "“Cited” means the answer points to the source with a numbered reference. “Retrieved only” means the provider returned the source but the answer does not point to it.";
export const NOT_READ_NOTE =
  "Zypact has not opened these pages. What they say, and whether they mention you or another brand, has not been checked.";
export const NO_CAUSAL_SOURCE_NOTE =
  "Whether a source is cited does not show that publishing or changing a page would change the answer.";

const STATUS_REASON: Record<Exclude<ProviderSourceStatus, "ok">, string> = {
  no_raw_response: "no stored provider response",
  hash_missing: "no recorded hash to verify the stored response",
  hash_mismatch: "the stored response did not match its recorded hash",
  not_provider_json: "the stored response is not a provider JSON body",
  unrecognised_shape: "the stored response has an unrecognised format",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function buildSourceInsights(
  runs: ProtocolReportRunSources[],
  subjectDomain: string
): ProtocolReportSourceInsights {
  const usable = runs.filter((run) => run.status === "ok");

  const byDomain = new Map<
    string,
    { cited: Set<number>; retrieved: Set<number>; urls: Set<string> }
  >();
  const entry = (domain: string) => {
    let e = byDomain.get(domain);
    if (!e) {
      e = { cited: new Set(), retrieved: new Set(), urls: new Set() };
      byDomain.set(domain, e);
    }
    return e;
  };

  let runsWithOwnedCitation = 0;
  for (const run of usable) {
    const citedDomains = new Set(run.cited.map((s) => s.domain));
    for (const source of run.cited) {
      const e = entry(source.domain);
      e.cited.add(run.ordinal);
      e.urls.add(source.url);
    }
    for (const source of run.retrievedOnly) {
      const e = entry(source.domain);
      if (!citedDomains.has(source.domain)) e.retrieved.add(run.ordinal);
      e.urls.add(source.url);
    }
    if ([...citedDomains].some((d) => categorizeDomain(d, subjectDomain) === "owned")) {
      runsWithOwnedCitation += 1;
    }
  }

  const sortNums = (s: Set<number>) => [...s].sort((a, b) => a - b);
  const all: ProtocolReportSourceDomain[] = [...byDomain.entries()]
    .map(([domain, e]) => ({
      domain,
      category: categorizeDomain(domain, subjectDomain),
      citedInRuns: e.cited.size,
      citedRunOrdinals: sortNums(e.cited),
      retrievedOnlyInRuns: e.retrieved.size,
      retrievedOnlyRunOrdinals: sortNums(e.retrieved),
      urls: [...e.urls].sort().slice(0, MAX_URLS_PER_DOMAIN),
    }))
    .sort(
      (a, b) =>
        b.citedInRuns - a.citedInRuns ||
        b.retrievedOnlyInRuns - a.retrievedOnlyInRuns ||
        a.domain.localeCompare(b.domain)
    );

  const domains = all.slice(0, MAX_DOMAINS_SHOWN);

  const notes = [
    SOURCE_DEFINITION_NOTE,
    `Read from each run's stored provider response under rule ${PROVIDER_SOURCES_RULE_VERSION}, after checking it against its recorded hash. Nothing was requested again.`,
    NOT_READ_NOTE,
    NO_CAUSAL_SOURCE_NOTE,
    `Types come from a fixed list of known domains (${SOURCE_TYPE_LIST_VERSION}); other domains are shown as unclassified. “Your site” means ${subjectDomain} and its subdomains.`,
  ];

  const missing = runs.filter((run) => run.status !== "ok");
  if (missing.length > 0) {
    const reasons = [...new Set(missing.map((run) => STATUS_REASON[run.status as Exclude<ProviderSourceStatus, "ok">]))];
    notes.push(
      `${missing.length} of ${plural(runs.length, "readable run")} had no usable source list (${reasons.join("; ")}). Their sources are not shown and are not counted as absent.`
    );
  }

  const unmarked = usable.filter(
    (run) => !run.markersFound && run.retrievedOnly.length > 0
  ).length;
  if (unmarked > 0) {
    notes.push(
      `In ${plural(unmarked, "run")} the answer had no numbered references, so none of its returned sources could be confirmed as cited.`
    );
  }

  const unmatched = usable.reduce((sum, run) => sum + run.unmatchedMarkers.length, 0);
  if (unmatched > 0) {
    notes.push(
      `${plural(unmatched, "numbered reference")} matched no returned source and ${unmatched === 1 ? "was" : "were"} not turned into a source.`
    );
  }

  if (all.length > domains.length) {
    notes.push(
      `${all.length - domains.length} further domain(s) are not listed here; they remain in each run's stored response.`
    );
  }

  return {
    extractionVersion: PROVIDER_SOURCES_RULE_VERSION,
    sourceTypeListVersion: SOURCE_TYPE_LIST_VERSION,
    readableRuns: runs.length,
    runsWithSourceEvidence: usable.length,
    runsWithOwnedCitation,
    runs,
    domains,
    domainsNotShown: all.length - domains.length,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Outcome Card: cited sources before and after                        */
/* ------------------------------------------------------------------ */

export interface OutcomeCardSourceDomain {
  domain: string;
  category: SourceCategory;
  baselineCitedInRuns: number;
  retestCitedInRuns: number;
}

export interface OutcomeCardSourceComparison {
  extractionVersion: string;
  baselineRunsWithSourceEvidence: number;
  retestRunsWithSourceEvidence: number;
  ownedCited: { baseline: number; retest: number };
  /** Domains cited in at least one phase. */
  domains: OutcomeCardSourceDomain[];
  notes: string[];
}

export const SOURCE_COMPARISON_NOTE =
  "These counts describe which sources each phase's answers pointed to. No outcome status is assigned to them, and a change in cited sources is not evidence that the intervention caused anything.";

/**
 * Null when either phase has no source section, or the two were read under
 * different rules: a comparison across rule versions would compare the rules,
 * not the answers.
 */
export function compareSourceInsights(
  baseline: ProtocolReportSourceInsights | undefined,
  retest: ProtocolReportSourceInsights | undefined
): OutcomeCardSourceComparison | null {
  if (!baseline || !retest) return null;
  if (
    baseline.extractionVersion !== retest.extractionVersion ||
    baseline.sourceTypeListVersion !== retest.sourceTypeListVersion
  ) {
    return null;
  }

  const merged = new Map<string, OutcomeCardSourceDomain>();
  for (const [phase, insights] of [["baseline", baseline], ["retest", retest]] as const) {
    for (const d of insights.domains) {
      if (d.citedInRuns === 0) continue;
      const row = merged.get(d.domain) ?? {
        domain: d.domain,
        category: d.category,
        baselineCitedInRuns: 0,
        retestCitedInRuns: 0,
      };
      if (phase === "baseline") row.baselineCitedInRuns = d.citedInRuns;
      else row.retestCitedInRuns = d.citedInRuns;
      merged.set(d.domain, row);
    }
  }

  const domains = [...merged.values()]
    .sort(
      (a, b) =>
        b.baselineCitedInRuns + b.retestCitedInRuns - (a.baselineCitedInRuns + a.retestCitedInRuns) ||
        a.domain.localeCompare(b.domain)
    )
    .slice(0, MAX_DOMAINS_SHOWN);

  return {
    extractionVersion: baseline.extractionVersion,
    baselineRunsWithSourceEvidence: baseline.runsWithSourceEvidence,
    retestRunsWithSourceEvidence: retest.runsWithSourceEvidence,
    ownedCited: { baseline: baseline.runsWithOwnedCitation, retest: retest.runsWithOwnedCitation },
    domains,
    notes: [SOURCE_COMPARISON_NOTE, SOURCE_DEFINITION_NOTE, NOT_READ_NOTE],
  };
}
