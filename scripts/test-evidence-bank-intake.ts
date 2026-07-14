import assert from "node:assert/strict";
import { buildReviewedEvidenceBank } from "../lib/evidence-intake/intake-to-evidence-bank";

const filledVugio = {
  brand: "Vugio",
  website: "vugio.com",
  category: "E-commerce platform for creative professionals",
  sourceReportPath: "./exports/vugio-sales-report-14b6-final2.md",
  evidenceBankStatus: "pending_user_review",
  submittedBy: "Founder",
  permissionToUseInPublicCopy: true,
  productOfferings: [
    {
      name: "Studio equipment retail",
      description: "Vugio sells studio equipment and related products for creative professionals.",
      sourceUrl: "https://vugio.com/collections/studio-equipment",
      notes: "Public collection page",
    },
  ],
  pricingAndPackaging: [
    {
      planOrProduct: "US orders",
      price: "Free shipping available",
      currency: "USD",
      sourceUrl: "https://vugio.com/pages/shipping",
      notes: "Verify threshold before publishing",
    },
  ],
  serviceAndOperations: {
    shipping: "Free shipping on eligible US orders.",
    support: "Customer service support is available.",
    guaranteesOrPolicies: "Return policy should be verified before publishing.",
    sourceUrls: ["https://vugio.com/pages/shipping"],
  },
  competitorComparisons: [
    {
      competitor: "B&H Photo",
      factualDifference: "Vugio positions around studio equipment and expert consulting.",
      whereBrandIsBetter: "Use only if Vugio provides source-backed consulting details.",
      whereCompetitorMayBeBetter: "B&H has broader established retailer recognition.",
      sourceUrl: "https://vugio.com/pages/about-us",
    },
  ],
  proofItems: [
    {
      type: "customer",
      detail: "Customer service support is presented as a core service signal.",
      sourceUrl: "https://vugio.com/pages/about-us",
      canBeQuoted: true,
    },
  ],
  allowedClaims: [
    { claim: "Vugio offers customer service support.", sourceUrl: "https://vugio.com/pages/about-us" },
  ],
  forbiddenClaims: ["AI will recommend Vugio"],
  reviewerNotes: "Reviewed by founder before copy generation.",
};

const emptyTemplate = {
  brand: "EmptyCo",
  website: "empty.example",
  category: "Example",
  permissionToUseInPublicCopy: false,
  productOfferings: [{ name: "", description: "", sourceUrl: "", notes: "" }],
  proofItems: [{ type: "review | case_study | customer | certification | media | internal_metric", detail: "", sourceUrl: "", canBeQuoted: false }],
  allowedClaims: [],
  forbiddenClaims: [],
};

const bank = buildReviewedEvidenceBank(filledVugio, new Date("2026-07-10T00:00:00.000Z"));
assert.equal(bank.provenance, "user_reviewed");
assert.equal(bank.status, "user_reviewed");
assert.equal(bank.evidenceBankStatus, "user_reviewed");
assert.equal(bank.permissionToUseInPublicCopy, true);
assert.equal(bank.publicGenerationStatus, "allowed");
assert.equal(bank.nextStep, "generate_publish_ready_assets");
assert.deepEqual(bank.allowedClaims, ["Vugio offers customer service support."]);
assert(bank.supportingEvidenceWithSources.some((item) => item.claim.includes("Studio equipment retail")));
assert(bank.proofItems.length === 1);
assert(bank.competitorComparisons.length === 1);
assert(bank.forbiddenClaims.includes("guaranteed AI recommendations"));
assert(!JSON.stringify(bank).includes("AI will recommend Vugio"), "forbidden claims should not become allowed claims");

const emptyBank = buildReviewedEvidenceBank(emptyTemplate, new Date("2026-07-10T00:00:00.000Z"));
assert.equal(emptyBank.publicGenerationStatus, "blocked_until_public_permission");
assert.equal(emptyBank.nextStep, "request_public_permission_or_more_evidence");
assert(emptyBank.qaWarnings.some((warning) => warning.includes("permissionToUseInPublicCopy")));
assert.equal(emptyBank.allowedClaims.length, 0);

console.log("Evidence Bank intake conversion tests passed.");
