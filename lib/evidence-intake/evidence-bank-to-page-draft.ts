type JsonRecord = Record<string, unknown>;

type Claim = {
  claim: string;
  source: string;
};

type EvidenceItem = {
  label: string;
  detail: string;
  source: string;
};

type PageDraftResult = {
  ok: boolean;
  publicGenerationStatus: string;
  markdown: string;
  warnings: string[];
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanLines(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function bulletList(items: string[], fallback = "- No reviewed evidence provided."): string {
  const cleaned = cleanLines(items);
  return cleaned.length ? cleaned.map((item) => `- ${item}`).join("\n") : fallback;
}

function normalizeAllowedClaims(value: unknown): Claim[] {
  return asArray(value)
    .map((item) => {
      if (typeof item === "string") {
        return { claim: item.trim(), source: "" };
      }

      const record = asRecord(item);
      const claim = asString(record.claim || record.detail || record.text);
      const source = asString(record.source || record.sourceUrl || record.url);

      return { claim, source };
    })
    .filter((item) => item.claim.length > 0 && item.source.length > 0);
}

function normalizeSupportingEvidence(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const label = asString(record.type || record.label || record.name || record.category) || "Evidence";
      const detail = asString(record.detail || record.description || record.factualDifference || record.claim || record.notes);
      const source = asString(record.sourceUrl || record.source || record.url);

      return { label, detail, source };
    })
    .filter((item) => item.detail.length > 0 && item.source.length > 0);
}

function normalizeProductOfferings(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const name = asString(record.name || record.planOrProduct || record.product || record.title);
      const description = asString(record.description || record.notes || record.detail);
      const source = asString(record.sourceUrl || record.source || record.url);
      const detail = [name, description].filter(Boolean).join(" — ");

      return { label: "Product / offering", detail, source };
    })
    .filter((item) => item.detail.length > 0 && item.source.length > 0);
}

function normalizePricing(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const planOrProduct = asString(record.planOrProduct || record.name || record.product);
      const price = asString(record.price);
      const currency = asString(record.currency);
      const notes = asString(record.notes || record.description);
      const source = asString(record.sourceUrl || record.source || record.url);
      const detail = [planOrProduct, [price, currency].filter(Boolean).join(" "), notes]
        .filter(Boolean)
        .join(" — ");

      return { label: "Pricing / packaging", detail, source };
    })
    .filter((item) => item.detail.length > 0 && item.source.length > 0);
}

function normalizeCompetitorComparisons(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const competitor = asString(record.competitor);
      const factualDifference = asString(record.factualDifference);
      const whereBrandIsBetter = asString(record.whereBrandIsBetter);
      const whereCompetitorMayBeBetter = asString(record.whereCompetitorMayBeBetter);
      const source = asString(record.sourceUrl || record.source || record.url);
      const parts = [
        competitor ? `Compared with ${competitor}` : "Competitor comparison",
        factualDifference,
        whereBrandIsBetter ? `Brand advantage: ${whereBrandIsBetter}` : "",
        whereCompetitorMayBeBetter ? `Competitor advantage: ${whereCompetitorMayBeBetter}` : "",
      ].filter(Boolean);

      return { label: "Competitor comparison", detail: parts.join(" — "), source };
    })
    .filter((item) => item.detail.length > 0 && item.source.length > 0);
}

function normalizeProofItems(value: unknown): EvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const type = asString(record.type) || "Proof";
      const detail = asString(record.detail || record.description || record.name);
      const source = asString(record.sourceUrl || record.source || record.url);
      const canBeQuoted = Boolean(record.canBeQuoted);
      const suffix = canBeQuoted ? "Can be quoted publicly." : "Use as background unless approved for quotation.";

      return { label: type, detail: `${detail} ${suffix}`.trim(), source };
    })
    .filter((item) => item.detail.length > 0 && item.source.length > 0);
}

function serviceOperationsToEvidence(value: unknown): EvidenceItem[] {
  const record = asRecord(value);
  const sourceUrls = asArray(record.sourceUrls).map(asString).filter(Boolean);
  const source = sourceUrls[0] || "";
  const details = [
    asString(record.shipping) ? `Shipping: ${asString(record.shipping)}` : "",
    asString(record.support) ? `Support: ${asString(record.support)}` : "",
    asString(record.guaranteesOrPolicies) ? `Policies: ${asString(record.guaranteesOrPolicies)}` : "",
  ].filter(Boolean);

  if (!source || details.length === 0) return [];

  return [
    {
      label: "Service / operations",
      detail: details.join(" — "),
      source,
    },
  ];
}

function collectSourceList(items: EvidenceItem[], claims: Claim[]): string[] {
  const sources = new Set<string>();
  for (const claim of claims) {
    if (claim.source) sources.add(claim.source);
  }
  for (const item of items) {
    if (item.source) sources.add(item.source);
  }
  return Array.from(sources);
}

function buildBlockedMarkdown(bank: JsonRecord, warnings: string[]): string {
  const brand = asString(bank.brand) || "Unknown brand";
  const publicGenerationStatus = asString(bank.publicGenerationStatus) || "unknown";

  return `# Page Draft Blocked — ${brand}\n\nThis Evidence Bank is not approved for public page generation.\n\n**publicGenerationStatus:** ${publicGenerationStatus}\n\n## Required before generation\n\n${bulletList(warnings)}\n\n## Safety rule\n\nDo not generate publish-ready copy until the Evidence Bank is reviewed and public generation is allowed.\n`;
}

export function buildComparisonPageDraftFromEvidenceBank(bankInput: unknown): PageDraftResult {
  const bank = asRecord(bankInput);
  const brand = asString(bank.brand) || "Unknown brand";
  const website = asString(bank.website);
  const category = asString(bank.category) || "the reviewed buying frame";
  const publicGenerationStatus = asString(bank.publicGenerationStatus) || "unknown";
  const status = asString(bank.status || bank.evidenceBankStatus);
  const warnings = asArray(bank.qaWarnings || bank.warnings).map(asString).filter(Boolean);

  const allowedClaims = normalizeAllowedClaims(
    asArray(bank.allowedClaimsWithSources).length > 0
      ? bank.allowedClaimsWithSources
      : bank.allowedClaims
  );
  const evidenceItems = [
    ...normalizeProductOfferings(bank.productOfferings),
    ...normalizePricing(bank.pricingAndPackaging),
    ...serviceOperationsToEvidence(bank.serviceAndOperations),
    ...normalizeCompetitorComparisons(bank.competitorComparisons),
    ...normalizeProofItems(bank.proofItems),
    ...normalizeSupportingEvidence(bank.supportingEvidenceWithSources),
  ];

  const blockingReasons: string[] = [];
  if (publicGenerationStatus !== "allowed") {
    blockingReasons.push(`publicGenerationStatus is ${publicGenerationStatus || "missing"}.`);
  }
  if (status !== "user_reviewed") {
    blockingReasons.push(`Evidence Bank status is ${status || "missing"}, not user_reviewed.`);
  }
  if (allowedClaims.length === 0) {
    blockingReasons.push("No source-backed allowed claims are available for public copy.");
  }

  if (blockingReasons.length > 0) {
    return {
      ok: false,
      publicGenerationStatus,
      warnings: [...blockingReasons, ...warnings],
      markdown: buildBlockedMarkdown(bank, [...blockingReasons, ...warnings]),
    };
  }

  const sources = collectSourceList(evidenceItems, allowedClaims);
  const competitorEvidence = normalizeCompetitorComparisons(bank.competitorComparisons);
  const offeringEvidence = normalizeProductOfferings(bank.productOfferings);
  const pricingEvidence = normalizePricing(bank.pricingAndPackaging);
  const proofEvidence = normalizeProofItems(bank.proofItems);

  const pageTitle = `${brand} comparison page draft`;
  const canonicalLine = website ? `Website reviewed: ${website}` : "Website reviewed: not provided";

  const markdown = `# ${pageTitle}\n\n${canonicalLine}\nCategory / buying frame: ${category}\nEvidence status: user_reviewed\n\n> Drafting rule: this page uses only reviewed evidence and source-backed allowed claims. It does not claim that AI systems will recommend ${brand}.\n\n## Page copy\n\n### ${brand} for ${category}\n\n${brand} provides an option in the ${category} buying frame. The copy below should be published only after final human review because it is generated from a reviewed Evidence Bank, not from independent live verification.\n\n### What ${brand} provides\n\n${bulletList(offeringEvidence.map((item) => `${item.detail} Source: ${item.source}`))}\n\n### Approved claims for public copy\n\n${bulletList(allowedClaims.map((item) => `${item.claim} Source: ${item.source}`))}\n\n### Pricing and packaging details\n\n${bulletList(pricingEvidence.map((item) => `${item.detail} Source: ${item.source}`))}\n\n### Comparison facts to include\n\n${bulletList(competitorEvidence.map((item) => `${item.detail} Source: ${item.source}`))}\n\n### Proof and trust signals\n\n${bulletList(proofEvidence.map((item) => `${item.detail} Source: ${item.source}`))}\n\n## Internal QA notes\n\n- Do not claim that AI will recommend ${brand}.\n- Do not claim guaranteed rankings, guaranteed visibility, or guaranteed revenue impact.\n- Do not use unsupported superlatives such as “#1” or “best” unless independently sourced.\n- Keep claims tied to the sources listed below.\n\n## Source list\n\n${bulletList(sources)}\n`;

  return {
    ok: true,
    publicGenerationStatus,
    warnings,
    markdown,
  };
}
