export type EvidenceIntakeInput = {
  brand: string;
  website: string;
  category: string;
  generated?: string;
  visibilityLine?: string;
  reputationLine?: string;
  competitorLabel?: string;
  competitors: string[];
  comparisonCompetitors?: string[];
  evidenceNeeded: string[];
  firstFix?: string;
  sourceReportPath?: string;
};

export type EvidenceIntakeOutput = {
  markdown: string;
  jsonTemplate: Record<string, unknown>;
};

function clean(value: string | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

function splitCompetitors(value: string): string[] {
  return value
    .replace(/\.$/, "")
    .replace(/ and /gi, ", ")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw).replace(/[.;:]$/, "");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function extractCompetitorsFromEvidenceText(text: string): string[] {
  const normalized = clean(text);
  const results: string[] = [];

  const patterns = [
    /compared\s+(?:to|with|against)\s+(.+?)(?:\s+that\b|\s+which\b|\s+before\b|\s+for\b|\.|$)/i,
    /competitors\s+like\s+(.+?)(?:,\s+focusing\b|\s+that\b|\.|$)/i,
    /vs\.?\s+(.+?)(?:\s+that\b|\.|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    results.push(...splitCompetitors(match[1]));
  }

  const cleaned = results
    .map((name) =>
      name
        .replace(/^competitors?\s+/i, "")
        .replace(/^like\s+/i, "")
        .replace(/\s+can\s+be\s+highlighted$/i, "")
        .trim(),
    )
    .filter(
      (name) =>
        !/^(?:direct\s+)?competitors?$/i.test(name) &&
        !/^(?:other\s+)?(?:tools?|alternatives?)$/i.test(name),
    );

  return uniq(cleaned);
}

function deriveComparisonCompetitors(evidenceNeeded: string[], firstFix: string | undefined, fallbackCompetitors: string[]): string[] {
  const fromEvidence = uniq(evidenceNeeded.flatMap(extractCompetitorsFromEvidenceText));
  if (fromEvidence.length) return fromEvidence.slice(0, 5);

  const fromFix = extractCompetitorsFromEvidenceText(firstFix || "");
  if (fromFix.length) return fromFix.slice(0, 5);

  return uniq(fallbackCompetitors).slice(0, 5);
}

export function parseShortSalesReport(markdown: string, sourceReportPath?: string): EvidenceIntakeInput {
  const lines = markdown.split(/\r?\n/);

  const title = lines.find((line) => line.startsWith("# Zypact Short Report —")) || "";
  const brand = clean(title.split("—")[1]) || "Unknown brand";
  const generated = clean((lines.find((line) => line.startsWith("Generated:")) || "").replace(/^Generated:\s*/, ""));
  const website = clean((lines.find((line) => line.startsWith("Website:")) || "").replace(/^Website:\s*/, ""));
  const category = clean((lines.find((line) => line.startsWith("Category read by AI:")) || "").replace(/^Category read by AI:\s*/, ""));

  const visibilityLine = clean(stripMarkdown(lines.find((line) => line.startsWith("**Visibility:**")) || "").replace(/^Visibility:\s*/, ""));
  const reputationLine = clean(stripMarkdown(lines.find((line) => line.startsWith("**Branded reputation:**")) || "").replace(/^Branded reputation:\s*/, ""));

  const competitorLine = lines.find((line) =>
    line.startsWith("**Competitors AI recommended instead:**") ||
    line.startsWith("**Other tools AI recommended in the same frame:**")
  ) || "";
  const competitorLabel = clean(stripMarkdown(competitorLine.split(":")[0] || ""));
  const competitorText = clean(stripMarkdown(competitorLine.replace(/^\*\*.*?:\*\*\s*/, "")));
  const competitors = splitCompetitors(competitorText);

  const evidenceNeeded: string[] = [];
  const evidenceHeaderIndex = lines.findIndex((line) => line.trim() === "### Evidence needed before publish-ready copy");
  if (evidenceHeaderIndex >= 0) {
    for (let i = evidenceHeaderIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("## ") || line.startsWith("### ")) break;
      if (line.startsWith("- ")) evidenceNeeded.push(stripMarkdown(line));
    }
  }

  const firstFixHeaderIndex = lines.findIndex((line) => line.trim() === "## 4. First recommended fix");
  let firstFix = "";
  if (firstFixHeaderIndex >= 0) {
    const bold = lines.slice(firstFixHeaderIndex + 1, firstFixHeaderIndex + 8).find((line) => /^\*\*.+\*\*/.test(line.trim()));
    firstFix = bold ? stripMarkdown(bold) : "";
  }

  const resolvedEvidenceNeeded = evidenceNeeded.length ? evidenceNeeded : ["specific product, pricing, proof, and competitor-comparison evidence"];
  const comparisonCompetitors = deriveComparisonCompetitors(resolvedEvidenceNeeded, firstFix, competitors);

  return {
    brand,
    website,
    category,
    generated,
    visibilityLine,
    reputationLine,
    competitorLabel,
    competitors,
    comparisonCompetitors,
    evidenceNeeded: resolvedEvidenceNeeded,
    firstFix,
    sourceReportPath,
  };
}

function checkbox(items: string[]): string {
  return items.map((item) => `- [ ] ${item}`).join("\n");
}

function competitorQuestions(competitors: string[]): string {
  if (!competitors.length) {
    return "- What are the 2–3 alternatives buyers compare you against most often?\n- Where do you clearly fit better, worse, or differently?";
  }

  return competitors
    .slice(0, 5)
    .map((name) => `- Compared with ${name}, what is one factual difference a buyer should know? Add a source or internal note if available.`)
    .join("\n");
}

export function buildEvidenceIntake(input: EvidenceIntakeInput): EvidenceIntakeOutput {
  const brand = input.brand || "the brand";
  const competitors = input.competitors || [];
  const comparisonCompetitors = input.comparisonCompetitors?.length ? input.comparisonCompetitors : competitors;
  const generated = input.generated || new Date().toISOString().slice(0, 10);

  const jsonTemplate = {
    brand,
    website: input.website || "",
    category: input.category || "",
    sourceReportPath: input.sourceReportPath || "",
    evidenceBankStatus: "pending_user_review",
    submittedBy: "",
    permissionToUseInPublicCopy: false,
    productOfferings: [
      {
        name: "",
        description: "",
        sourceUrl: "",
        notes: "",
      },
    ],
    pricingAndPackaging: [
      {
        planOrProduct: "",
        price: "",
        currency: "",
        sourceUrl: "",
        notes: "",
      },
    ],
    serviceAndOperations: {
      shipping: "",
      support: "",
      guaranteesOrPolicies: "",
      sourceUrls: [],
    },
    competitorComparisons: comparisonCompetitors.slice(0, 5).map((name) => ({
      competitor: name,
      factualDifference: "",
      whereBrandIsBetter: "",
      whereCompetitorMayBeBetter: "",
      sourceUrl: "",
    })),
    proofItems: [
      {
        type: "review | case_study | customer | certification | media | internal_metric",
        detail: "",
        sourceUrl: "",
        canBeQuoted: false,
      },
    ],
    allowedClaims: [],
    forbiddenClaims: [
      "guaranteed AI recommendations",
      "guaranteed rankings",
      "#1 / best in market unless independently sourced",
      "revenue growth without proof",
    ],
    reviewerNotes: "",
  };

  const markdown = `# Evidence Intake — ${brand}\n\nGenerated: ${generated}\nWebsite: ${input.website || ""}\nCategory read by AI: ${input.category || ""}\nSource report: ${input.sourceReportPath || "short sales report"}\n\n## Why we need this\n\nThe short scan identified a recommended website fix, but Zypact should not generate publish-ready copy until the missing evidence is reviewed by a human.\n\n**Visibility signal:** ${input.visibilityLine || "not provided"}\n**Branded reputation signal:** ${input.reputationLine || "not provided"}\n**${input.competitorLabel || "Relevant competitors / alternatives"}:** ${competitors.length ? competitors.join(", ") : "not provided"}.\n\n## Recommended fix to unlock\n\n${input.firstFix || "Create evidence-backed content for the buying frame identified in the scan."}\n\n## Evidence required before publish-ready copy\n\n${checkbox(input.evidenceNeeded)}\n\n## Please fill this in\n\n### 1. Product / offering details\n\n- What exactly does ${brand} sell or provide in this buying frame?\n- Which products, services, plans, or categories should be compared?\n- Add URLs for the relevant product, collection, pricing, or service pages.\n\n### 2. Pricing / packaging\n\n- What prices, ranges, plans, or quote-based details can be used publicly?\n- Are there shipping, support, setup, warranty, return, or service details that matter to buyers?\n- Add URLs or notes for anything that should be verified before publishing.\n\n### 3. Competitor comparison facts\n\n${competitorQuestions(comparisonCompetitors)}\n\n### 4. Proof and trust signals\n\n- Reviews, testimonials, ratings, case studies, customer names, certifications, media mentions, or community references that can be cited.\n- For each proof item, include the source URL and whether it can be quoted publicly.\n\n### 5. Claims we are allowed to make\n\nList only claims that are true, source-backed, and safe to publish.\n\n- Allowed claim 1:\n- Source:\n- Allowed claim 2:\n- Source:\n- Allowed claim 3:\n- Source:\n\n### 6. Claims we should avoid\n\nList anything that should not be said publicly.\n\n- Avoid:\n- Avoid:\n- Avoid:\n\n## Output after review\n\nOnce this is filled, Zypact can turn it into a reviewed Evidence Bank and generate the recommended page draft with QA.\n\n**Do not claim:** AI will recommend ${brand}.\n**Do claim only:** what the evidence supports.\n`;

  return { markdown, jsonTemplate };
}
