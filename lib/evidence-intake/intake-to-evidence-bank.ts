export type IntakeProductOffering = {
  name?: string;
  description?: string;
  sourceUrl?: string;
  notes?: string;
};

export type IntakePricing = {
  planOrProduct?: string;
  price?: string;
  currency?: string;
  sourceUrl?: string;
  notes?: string;
};

export type IntakeCompetitorComparison = {
  competitor?: string;
  factualDifference?: string;
  whereBrandIsBetter?: string;
  whereCompetitorMayBeBetter?: string;
  sourceUrl?: string;
};

export type IntakeProofItem = {
  type?: string;
  detail?: string;
  sourceUrl?: string;
  canBeQuoted?: boolean;
};

export type EvidenceIntakeJson = {
  brand?: string;
  website?: string;
  category?: string;
  sourceReportPath?: string;
  evidenceBankStatus?: string;
  submittedBy?: string;
  permissionToUseInPublicCopy?: boolean;
  productOfferings?: IntakeProductOffering[];
  pricingAndPackaging?: IntakePricing[];
  serviceAndOperations?: {
    shipping?: string;
    support?: string;
    guaranteesOrPolicies?: string;
    sourceUrls?: string[];
  };
  competitorComparisons?: IntakeCompetitorComparison[];
  proofItems?: IntakeProofItem[];
  allowedClaims?: Array<string | { claim?: string; source?: string; sourceUrl?: string; notes?: string }>;
  forbiddenClaims?: string[];
  reviewerNotes?: string;
};

export type ReviewedEvidenceBank = {
  status: "user_reviewed";
  brand: string;
  website: string;
  category: string;
  provenance: "user_reviewed";
  evidenceBankStatus: "user_reviewed";
  sourceReportPath: string;
  reviewedAt: string;
  submittedBy: string;
  permissionToUseInPublicCopy: boolean;
  publicGenerationStatus: "allowed" | "blocked_until_public_permission";
  productDescription: string;
  productOfferings: Array<{
    name: string;
    description: string;
    sourceUrl: string;
    notes: string;
  }>;
  pricingAndPackaging: Array<{
    planOrProduct: string;
    price: string;
    currency: string;
    sourceUrl: string;
    notes: string;
  }>;
  serviceAndOperations: {
    shipping: string;
    support: string;
    guaranteesOrPolicies: string;
    sourceUrls: string[];
  };
  competitorComparisons: Array<{
    competitor: string;
    factualDifference: string;
    whereBrandIsBetter: string;
    whereCompetitorMayBeBetter: string;
    sourceUrl: string;
  }>;
  proofItems: Array<{
    type: string;
    detail: string;
    sourceUrl: string;
    canBeQuoted: boolean;
  }>;
  allowedClaims: string[];
  allowedClaimsWithSources: Array<{
    claim: string;
    source: string;
  }>;
  supportingEvidenceWithSources: Array<{
    claim: string;
    source: string;
  }>;
  forbiddenClaims: string[];
  reviewerNotes: string;
  qaWarnings: string[];
  nextStep: "generate_publish_ready_assets" | "request_public_permission_or_more_evidence";
};

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isGenericPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase().trim();
  return (
    !normalized ||
    normalized === "review | case_study | customer | certification | media | internal_metric" ||
    normalized.includes("evidence needed") ||
    normalized === "allowed claim 1" ||
    normalized === "allowed claim 2" ||
    normalized === "allowed claim 3"
  );
}

function nonEmptyUrlOrNote(...values: string[]): boolean {
  return values.some((value) => Boolean(clean(value)));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeForbiddenClaims(input: string[] | undefined): string[] {
  return uniqueStrings([
    ...(input || []),
    "guaranteed AI recommendations",
    "guaranteed rankings",
    "guaranteed citations",
    "#1 / best in market unless independently sourced",
    "revenue growth without proof",
  ]);
}

function normalizeExplicitAllowedClaims(input: EvidenceIntakeJson): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  const claims = input.allowedClaims || [];
  const out: ReviewedEvidenceBank["allowedClaimsWithSources"] = [];

  for (const item of claims) {
    if (typeof item === "string") {
      const claim = clean(item);
      if (!claim || isGenericPlaceholder(claim)) continue;
      // String-only claims are allowed only when reviewer explicitly provides notes.
      // They remain source="reviewer_notes" so generated copy can trace why it exists.
      if (clean(input.reviewerNotes)) out.push({ claim, source: "reviewer_notes" });
      continue;
    }

    const claim = clean(item.claim);
    const source = clean(item.sourceUrl || item.source || item.notes);
    if (!claim || isGenericPlaceholder(claim) || !source) continue;
    out.push({ claim, source });
  }

  return out;
}

function claimsFromOfferings(offerings: ReviewedEvidenceBank["productOfferings"]): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  return offerings.map((offering) => ({
    claim: `${offering.name}: ${offering.description}`.replace(/:\s*$/, ""),
    source: offering.sourceUrl || offering.notes,
  })).filter((item) => item.claim && item.source);
}

function claimsFromPricing(pricing: ReviewedEvidenceBank["pricingAndPackaging"]): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  return pricing.map((item) => {
    const price = [item.price, item.currency].filter(Boolean).join(" ").trim();
    return {
      claim: price ? `${item.planOrProduct}: ${price}` : item.planOrProduct,
      source: item.sourceUrl || item.notes,
    };
  }).filter((item) => item.claim && item.source);
}

function claimsFromProofItems(proofItems: ReviewedEvidenceBank["proofItems"]): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  return proofItems.map((item) => ({
    claim: item.detail,
    source: item.sourceUrl,
  })).filter((item) => item.claim && item.source);
}

function claimsFromCompetitorComparisons(comparisons: ReviewedEvidenceBank["competitorComparisons"]): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  return comparisons.flatMap((item) => {
    const source = item.sourceUrl || "reviewer_notes";
    const claims: ReviewedEvidenceBank["allowedClaimsWithSources"] = [];
    if (item.factualDifference) claims.push({ claim: `Compared with ${item.competitor}: ${item.factualDifference}`, source });
    if (item.whereBrandIsBetter) claims.push({ claim: `Where the brand may fit better than ${item.competitor}: ${item.whereBrandIsBetter}`, source });
    if (item.whereCompetitorMayBeBetter) claims.push({ claim: `Where ${item.competitor} may fit better: ${item.whereCompetitorMayBeBetter}`, source });
    return claims;
  });
}

export function buildReviewedEvidenceBank(input: EvidenceIntakeJson, now = new Date()): ReviewedEvidenceBank {
  const brand = clean(input.brand) || "Unknown brand";
  const website = clean(input.website);
  const category = clean(input.category);
  const submittedBy = clean(input.submittedBy);
  const permissionToUseInPublicCopy = Boolean(input.permissionToUseInPublicCopy);

  const productOfferings = (input.productOfferings || [])
    .map((item) => ({
      name: clean(item.name),
      description: clean(item.description),
      sourceUrl: clean(item.sourceUrl),
      notes: clean(item.notes),
    }))
    .filter((item) => item.name || item.description || item.sourceUrl || item.notes)
    .filter((item) => !isGenericPlaceholder(item.name) && !isGenericPlaceholder(item.description));

  const pricingAndPackaging = (input.pricingAndPackaging || [])
    .map((item) => ({
      planOrProduct: clean(item.planOrProduct),
      price: clean(item.price),
      currency: clean(item.currency),
      sourceUrl: clean(item.sourceUrl),
      notes: clean(item.notes),
    }))
    .filter((item) => item.planOrProduct || item.price || item.sourceUrl || item.notes)
    .filter((item) => !isGenericPlaceholder(item.planOrProduct));

  const serviceAndOperations = {
    shipping: clean(input.serviceAndOperations?.shipping),
    support: clean(input.serviceAndOperations?.support),
    guaranteesOrPolicies: clean(input.serviceAndOperations?.guaranteesOrPolicies),
    sourceUrls: uniqueStrings((input.serviceAndOperations?.sourceUrls || []).map(clean)),
  };

  const competitorComparisons = (input.competitorComparisons || [])
    .map((item) => ({
      competitor: clean(item.competitor),
      factualDifference: clean(item.factualDifference),
      whereBrandIsBetter: clean(item.whereBrandIsBetter),
      whereCompetitorMayBeBetter: clean(item.whereCompetitorMayBeBetter),
      sourceUrl: clean(item.sourceUrl),
    }))
    .filter((item) => item.competitor && !isGenericPlaceholder(item.competitor))
    .filter((item) => item.factualDifference || item.whereBrandIsBetter || item.whereCompetitorMayBeBetter || item.sourceUrl);

  const proofItems = (input.proofItems || [])
    .map((item) => ({
      type: clean(item.type),
      detail: clean(item.detail),
      sourceUrl: clean(item.sourceUrl),
      canBeQuoted: Boolean(item.canBeQuoted),
    }))
    .filter((item) => item.detail || item.sourceUrl)
    .filter((item) => !isGenericPlaceholder(item.type) && !isGenericPlaceholder(item.detail));

  const allowedClaimsWithSources = uniqueClaimSources(normalizeExplicitAllowedClaims(input));

  const supportingEvidenceWithSources = uniqueClaimSources([
    ...claimsFromOfferings(productOfferings),
    ...claimsFromPricing(pricingAndPackaging),
    ...claimsFromProofItems(proofItems),
    ...claimsFromCompetitorComparisons(competitorComparisons),
  ]);

  const qaWarnings: string[] = [];
  if (!permissionToUseInPublicCopy) qaWarnings.push("permissionToUseInPublicCopy is false — do not generate public copy yet.");
  if (!submittedBy) qaWarnings.push("submittedBy is empty — capture reviewer identity before marking as client-approved.");
  if (!productOfferings.length) qaWarnings.push("No product offerings were provided.");
  if (!allowedClaimsWithSources.length) qaWarnings.push("No source-backed allowed claims were provided.");
  if (competitorComparisons.some((item) => !nonEmptyUrlOrNote(item.sourceUrl))) {
    qaWarnings.push("Some competitor comparison facts lack source URLs; treat them as internal notes until verified.");
  }

  const productDescription = productOfferings.length
    ? `${brand} — ${productOfferings.map((item) => item.name || item.description).filter(Boolean).slice(0, 3).join(", ")}.`
    : `${brand}${category ? ` — ${category}` : ""}.`;

  return {
    status: "user_reviewed",
    brand,
    website,
    category,
    provenance: "user_reviewed",
    evidenceBankStatus: "user_reviewed",
    sourceReportPath: clean(input.sourceReportPath),
    reviewedAt: now.toISOString(),
    submittedBy,
    permissionToUseInPublicCopy,
    publicGenerationStatus: permissionToUseInPublicCopy ? "allowed" : "blocked_until_public_permission",
    productDescription,
    productOfferings,
    pricingAndPackaging,
    serviceAndOperations,
    competitorComparisons,
    proofItems,
    allowedClaims: allowedClaimsWithSources.map((item) => item.claim),
    allowedClaimsWithSources,
    supportingEvidenceWithSources,
    forbiddenClaims: normalizeForbiddenClaims(input.forbiddenClaims),
    reviewerNotes: clean(input.reviewerNotes),
    qaWarnings,
    nextStep: permissionToUseInPublicCopy && allowedClaimsWithSources.length
      ? "generate_publish_ready_assets"
      : "request_public_permission_or_more_evidence",
  };
}

function uniqueClaimSources(items: ReviewedEvidenceBank["allowedClaimsWithSources"]): ReviewedEvidenceBank["allowedClaimsWithSources"] {
  const seen = new Set<string>();
  const out: ReviewedEvidenceBank["allowedClaimsWithSources"] = [];
  for (const item of items) {
    const claim = clean(item.claim);
    const source = clean(item.source);
    if (!claim || !source) continue;
    const key = `${claim.toLowerCase()}|${source.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ claim, source });
  }
  return out;
}
