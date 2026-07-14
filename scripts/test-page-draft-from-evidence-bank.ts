import assert from "node:assert/strict";
import { buildComparisonPageDraftFromEvidenceBank } from "../lib/evidence-intake/evidence-bank-to-page-draft";

const blocked = buildComparisonPageDraftFromEvidenceBank({
  brand: "BlockedCo",
  website: "blocked.example",
  category: "Example software",
  status: "user_reviewed",
  evidenceBankStatus: "user_reviewed",
  publicGenerationStatus: "blocked_until_public_permission",
  allowedClaims: ["DemoCo includes workflow templates on the Team plan."],
    allowedClaimsWithSources: [
      {
        claim: "DemoCo includes workflow templates on the Team plan.",
        source: "https://demo.example/pricing",
      },
    ],
});

assert.equal(blocked.ok, false);
assert.match(blocked.markdown, /Page Draft Blocked/);
assert.match(blocked.markdown, /publicGenerationStatus is blocked_until_public_permission/);
assert.doesNotMatch(blocked.markdown, /## Page copy/);

const missingClaims = buildComparisonPageDraftFromEvidenceBank({
  brand: "NoClaimCo",
  website: "noclaim.example",
  category: "Example software",
  status: "user_reviewed",
  evidenceBankStatus: "user_reviewed",
  publicGenerationStatus: "allowed",
  allowedClaims: [],
});

assert.equal(missingClaims.ok, false);
assert.match(missingClaims.markdown, /No source-backed allowed claims/);

const allowed = buildComparisonPageDraftFromEvidenceBank({
  brand: "DemoCo",
  website: "demo.example",
  category: "Example B2B software",
  status: "user_reviewed",
  evidenceBankStatus: "user_reviewed",
  publicGenerationStatus: "allowed",
  productOfferings: [
    {
      name: "DemoCo Platform",
      description: "A project workflow platform for software teams.",
      sourceUrl: "https://demo.example/product",
    },
  ],
  pricingAndPackaging: [
    {
      planOrProduct: "Team plan",
      price: "$20/user/month",
      currency: "USD",
      sourceUrl: "https://demo.example/pricing",
    },
  ],
  serviceAndOperations: {
    support: "Email support is included on paid plans.",
    sourceUrls: ["https://demo.example/support"],
  },
  competitorComparisons: [
    {
      competitor: "Competitor A",
      factualDifference: "DemoCo includes workflow templates on the Team plan.",
      whereBrandIsBetter: "Templates are included without an add-on.",
      whereCompetitorMayBeBetter: "Competitor A may have broader enterprise integrations.",
      sourceUrl: "https://demo.example/pricing",
    },
  ],
  proofItems: [
    {
      type: "internal_metric",
      detail: "TEST ONLY: 100 teams in sample dataset.",
      sourceUrl: "https://demo.example/proof",
      canBeQuoted: true,
    },
  ],
  allowedClaims: [
    {
      claim: "DemoCo includes workflow templates on the Team plan.",
      source: "https://demo.example/pricing",
    },
  ],
});

assert.equal(allowed.ok, true);
assert.match(allowed.markdown, /## Page copy/);
assert.match(allowed.markdown, /DemoCo includes workflow templates on the Team plan/);
assert.match(allowed.markdown, /Compared with Competitor A/);
assert.match(allowed.markdown, /Do not claim that AI will recommend DemoCo/);
assert.match(allowed.markdown, /https:\/\/demo\.example\/pricing/);

console.log("Evidence Bank to page draft tests passed.");
