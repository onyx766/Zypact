type ClientFile = {
  relativePath: string;
  content: string;
};

type PackageStatus = "page_draft_ready" | "page_draft_blocked" | "evidence_needed" | "frame_mismatch_detected";

type BuildClientPackageInput = {
  brand?: string;
  salesReportMarkdown: string;
  evidenceIntakeMarkdown: string;
  pageDraftMarkdown?: string;
  expectedCompetitors?: string[];
  generatedAt?: string;
};

type ClientPackageResult = {
  brand: string;
  slug: string;
  status: PackageStatus;
  files: ClientFile[];
  manifest: Record<string, unknown>;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(markdown: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function deriveBrand(input: BuildClientPackageInput): string {
  const explicit = asString(input.brand);
  if (explicit) return explicit;

  const combined = [
    input.salesReportMarkdown,
    input.evidenceIntakeMarkdown,
    input.pageDraftMarkdown || "",
  ].join("\n");

  const brand = firstMatch(combined, [
    /^#\s+Zypact Short Report\s+[—-]\s+(.+)$/m,
    /^#\s+Evidence Intake\s+[—-]\s+(.+)$/m,
    /^#\s+Page Draft Blocked\s+[—-]\s+(.+)$/m,
    /^#\s+.+?\s+[—-]\s+(.+)$/m,
  ]);

  return brand || "Client";
}

function toSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "client";
}

function inferStatus(pageDraftMarkdown?: string): PackageStatus {
  const page = asString(pageDraftMarkdown);
  if (!page) return "evidence_needed";
  if (/^#\s+Page Draft Blocked\b/m.test(page)) return "page_draft_blocked";
  if (/##\s+Page copy\b/i.test(page)) return "page_draft_ready";
  return "page_draft_blocked";
}

function extractLine(markdown: string, label: string): string {
  const pattern = new RegExp(`^\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)$`, "m");
  return firstMatch(markdown, [pattern]);
}

type FrameConsistencyResult = {
  status: "passed" | "skipped" | "frame_mismatch_detected";
  expectedCompetitors: string[];
  actualCompetitors: string[];
  matchedCompetitors: string[];
  reason: string;
};

function splitCompetitorList(value: string): string[] {
  return value
    .replace(/\s+and\s+/gi, ",")
    .split(",")
    .map((item) => item.trim())
    .map((item) => item.replace(/\.$/, "").trim())
    .filter(Boolean);
}

function normalizeCompetitorName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function competitorNamesMatch(expected: string, actual: string): boolean {
  const e = normalizeCompetitorName(expected);
  const a = normalizeCompetitorName(actual);
  if (!e || !a) return false;
  if (e === a) return true;

  // Allows "Zoom Webinars" ↔ "Zoom", "Microsoft Sentinel" ↔ "Sentinel".
  if (e.length >= 4 && a.length >= 4 && (e.includes(a) || a.includes(e))) {
    return true;
  }

  return false;
}

function extractFrameCompetitors(markdown: string): string[] {
  const line =
    markdown
      .split(/\r?\n/)
      .find((item) =>
        item.startsWith("**Competitors AI recommended instead:**") ||
        item.startsWith("**Other tools AI recommended in the same frame:**")
      ) || "";

  const text = line.replace(/^\*\*.*?:\*\*\s*/, "").trim();
  return splitCompetitorList(text).slice(0, 8);
}

function evaluateFrameConsistency(expectedCompetitors: string[] | undefined, actualCompetitors: string[]): FrameConsistencyResult {
  const expected = Array.from(
    new Set((expectedCompetitors ?? []).map((item) => item.trim()).filter(Boolean))
  );

  const actual = Array.from(
    new Set(actualCompetitors.map((item) => item.trim()).filter(Boolean))
  );

  if (expected.length === 0) {
    return {
      status: "skipped",
      expectedCompetitors: [],
      actualCompetitors: actual,
      matchedCompetitors: [],
      reason: "No expected competitors were provided, so frame consistency was not checked.",
    };
  }

  if (actual.length === 0) {
    return {
      status: "skipped",
      expectedCompetitors: expected,
      actualCompetitors: [],
      matchedCompetitors: [],
      reason: "No competitor line could be extracted from the sales report, so frame consistency was not checked.",
    };
  }

  const matched = expected.filter((expectedName) =>
    actual.some((actualName) => competitorNamesMatch(expectedName, actualName))
  );

  if (matched.length === 0) {
    return {
      status: "frame_mismatch_detected",
      expectedCompetitors: expected,
      actualCompetitors: actual,
      matchedCompetitors: [],
      reason: "None of the expected competitors appeared in the sales report competitor frame.",
    };
  }

  return {
    status: "passed",
    expectedCompetitors: expected,
    actualCompetitors: actual,
    matchedCompetitors: matched,
    reason: "At least one expected competitor appeared in the sales report competitor frame.",
  };
}

function extractWebsite(markdown: string): string {
  return firstMatch(markdown, [/^Website:\s*(.+)$/m]);
}

function extractRecommendedFix(markdown: string): string {
  return firstMatch(markdown, [
    /##\s+4\.\s+First recommended fix[\s\S]*?^\*\*(.+?)\*\*\s*$/m,
    /##\s+Recommended fix to unlock[\s\S]*?^(.+?)$/m,
  ]);
}

function extractEvidenceBullets(markdown: string): string[] {
  const section = firstMatch(markdown, [
    /###\s+Evidence needed before publish-ready copy\s*\n([\s\S]*?)(?:\n##|\n###|\n$)/i,
    /##\s+Evidence required before publish-ready copy\s*\n([\s\S]*?)(?:\n##|\n###|\n$)/i,
  ]);

  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+(\[[ xX]\]\s*)?\S/.test(line))
    .map((line) => line.replace(/^-\s+(\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean);
}

function bulletList(items: string[], fallback: string): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (!cleaned.length) return `- ${fallback}`;
  return cleaned.map((item) => `- ${item}`).join("\n");
}

function buildReadme(params: {
  brand: string;
  website: string;
  status: PackageStatus;
  visibility: string;
  brandedReputation: string;
  recommendedFix: string;
  evidenceBullets: string[];
  generatedAt: string;
  pageFileName: string | null;
  frameConsistency: FrameConsistencyResult;
}): string {
  const statusLabel =
    params.status === "frame_mismatch_detected"
      ? "Frame mismatch detected — package blocked"
      : params.status === "page_draft_ready"
        ? "Reviewed page draft included"
        : params.status === "page_draft_blocked"
          ? "Page draft blocked until evidence is complete"
          : "Evidence needed before page draft";

  const pageLine =
    params.status === "frame_mismatch_detected"
      ? "- No page draft is included because the competitor frame did not match the expected market."
      : params.pageFileName
        ? `- \`${params.pageFileName}\` — page draft or blocked generation note.`
        : "- No page draft is included yet because reviewed evidence is still needed.";

  const nextStep =
    params.status === "frame_mismatch_detected"
      ? "Review the scan frame before sending this package. Re-run the scan or rebuild the sales report with the correct expected competitor set."
      : params.status === "page_draft_ready"
        ? "Review the page draft, confirm the claims are accurate, then publish or adapt it on the relevant site page."
        : "Fill in the evidence request before any publish-ready copy is generated.";

  const frameMismatchBlock =
    params.status === "frame_mismatch_detected"
      ? `## Frame consistency warning

This package is blocked because the competitor frame may not match the intended market.

- Expected competitors: ${params.frameConsistency.expectedCompetitors.join(", ") || "not provided"}
- Competitors found in report: ${params.frameConsistency.actualCompetitors.join(", ") || "not found"}
- Matched competitors: ${params.frameConsistency.matchedCompetitors.join(", ") || "none"}
- Reason: ${params.frameConsistency.reason}

Do not send this package as client outreach until the frame is reviewed.

`
      : "";

  return `# Zypact AI Visibility Snapshot — ${params.brand}

Generated: ${params.generatedAt}
${params.website ? `Website: ${params.website}\n` : ""}Status: ${statusLabel}

## What is included

- \`01-ai-visibility-summary.md\` — short visibility snapshot and recommended fix.
- \`02-evidence-request.md\` — proof needed before publishing new copy.
${pageLine}
- \`04-next-email.md\` — short follow-up email you can send or adapt.
- \`manifest.json\` — package metadata.

## Snapshot

${params.visibility ? `**Visibility:** ${params.visibility}\n` : ""}${params.brandedReputation ? `**Branded reputation:** ${params.brandedReputation}\n` : ""}${params.recommendedFix ? `**Recommended fix:** ${params.recommendedFix}\n` : ""}

${frameMismatchBlock}## Evidence still needed

${bulletList(params.evidenceBullets, "Use the evidence request file to provide source-backed product, pricing, comparison, and proof details.")}

## Next step

${nextStep}

## Safety rule

Do not claim that AI will recommend ${params.brand}. Only use claims that are reviewed, source-backed, and approved for public copy.
`;
}

function buildNextEmail(params: {
  brand: string;
  website: string;
  status: PackageStatus;
  visibility: string;
  brandedReputation: string;
  recommendedFix: string;
  evidenceBullets: string[];
  frameConsistency: FrameConsistencyResult;
}): string {
  if (params.status === "frame_mismatch_detected") {
    return `Subject: Frame mismatch detected for ${params.brand} package

Hi {{first_name}},

Do not send this as outreach yet.

The Zypact package for ${params.brand} was blocked because the competitor frame may not match the intended market.

Expected competitors:
${bulletList(params.frameConsistency.expectedCompetitors, "Expected competitors were not provided.")}

Competitors found in the report:
${bulletList(params.frameConsistency.actualCompetitors, "No competitors were extracted from the report.")}

Matched competitors:
${bulletList(params.frameConsistency.matchedCompetitors, "No expected competitors matched the report frame.")}

Reason: ${params.frameConsistency.reason}

Next step: review the scan frame, then re-run the scan or rebuild the sales report with the correct competitor set before sending any client-facing email.

Best,
{{your_name}}
`;
  }

  const subject =
    params.status === "page_draft_ready"
      ? `AI visibility fix draft for ${params.brand}`
      : `Evidence needed to unlock the ${params.brand} AI visibility fix`;

  const snapshotLines = [
    params.visibility ? `- Visibility: ${params.visibility}` : "",
    params.brandedReputation ? `- Branded reputation: ${params.brandedReputation}` : "",
    params.recommendedFix ? `- Recommended fix: ${params.recommendedFix}` : "",
  ].filter(Boolean);

  const bodyIntro =
    params.status === "page_draft_ready"
      ? `I put together the short AI visibility snapshot for ${params.brand}. It includes the short AI visibility summary, the reviewed evidence trail, and a safe page draft grounded in approved sources.`
      : `I put together the short AI visibility snapshot for ${params.brand}. It includes the short AI visibility summary and the exact evidence needed before we generate publish-ready copy.`;

  const ask =
    params.status === "page_draft_ready"
      ? "The next step is to review the draft for factual accuracy, then decide whether to publish it as-is or adapt it into an existing page."
      : `The next step is to fill in the evidence request, especially:\n\n${bulletList(params.evidenceBullets, "the product, pricing, comparison, and proof details that are safe to publish")}`;

  return `Subject: ${subject}

Hi {{first_name}},

${bodyIntro}

Key snapshot:
${snapshotLines.length ? snapshotLines.join("\n") : "- See the attached summary for the key finding."}

${ask}

Safety note: we should not claim that AI will recommend ${params.brand}. The draft should only use claims that are reviewed, source-backed, and approved for public copy.

Best,
{{your_name}}
`;
}

function normalizeMarkdown(markdown: string): string {
  return markdown.trimEnd() + "\n";
}

export function buildClientPackage(input: BuildClientPackageInput): ClientPackageResult {
  const brand = deriveBrand(input);
  const slug = toSlug(brand);
  const frameConsistency = evaluateFrameConsistency(
    input.expectedCompetitors,
    extractFrameCompetitors(input.salesReportMarkdown)
  );
  const baseStatus = inferStatus(input.pageDraftMarkdown);
  const status: PackageStatus =
    frameConsistency.status === "frame_mismatch_detected"
      ? "frame_mismatch_detected"
      : baseStatus;
  const generatedAt = input.generatedAt || new Date().toISOString().slice(0, 10);

  const website = extractWebsite(input.salesReportMarkdown) || extractWebsite(input.evidenceIntakeMarkdown);
  const visibility = extractLine(input.salesReportMarkdown, "Visibility") || extractLine(input.evidenceIntakeMarkdown, "Visibility signal");
  const brandedReputation = extractLine(input.salesReportMarkdown, "Branded reputation") || extractLine(input.evidenceIntakeMarkdown, "Branded reputation signal");
  const recommendedFix = extractRecommendedFix(input.salesReportMarkdown) || extractRecommendedFix(input.evidenceIntakeMarkdown);
  const evidenceBullets = extractEvidenceBullets(input.salesReportMarkdown).length
    ? extractEvidenceBullets(input.salesReportMarkdown)
    : extractEvidenceBullets(input.evidenceIntakeMarkdown);

  const pageFileName =
    status !== "frame_mismatch_detected" && input.pageDraftMarkdown
      ? status === "page_draft_ready"
        ? "03-page-draft.md"
        : "03-page-draft-blocked.md"
      : null;

  const readme = buildReadme({
    brand,
    website,
    status,
    visibility,
    brandedReputation,
    recommendedFix,
    evidenceBullets,
    generatedAt,
    pageFileName,
    frameConsistency,
  });

  const email = buildNextEmail({
    brand,
    website,
    status,
    visibility,
    brandedReputation,
    recommendedFix,
    evidenceBullets,
    frameConsistency,
  });

  const manifest = {
    brand,
    slug,
    website,
    generatedAt,
    status,
    files: [
      "00-README.md",
      "01-ai-visibility-summary.md",
      "02-evidence-request.md",
      ...(pageFileName ? [pageFileName] : []),
      "04-next-email.md",
      "manifest.json",
    ],
    frameConsistency,
    safety: {
      noGuaranteedAiRecommendationClaims: true,
      publicCopyMustUseReviewedSourceBackedClaims: true,
      blockedWhenCompetitorFrameMismatches: true,
    },
  };

  const files: ClientFile[] = [
    { relativePath: "00-README.md", content: normalizeMarkdown(readme) },
    { relativePath: "01-ai-visibility-summary.md", content: normalizeMarkdown(input.salesReportMarkdown) },
    { relativePath: "02-evidence-request.md", content: normalizeMarkdown(input.evidenceIntakeMarkdown) },
    ...(pageFileName && input.pageDraftMarkdown
      ? [{ relativePath: pageFileName, content: normalizeMarkdown(input.pageDraftMarkdown) }]
      : []),
    { relativePath: "04-next-email.md", content: normalizeMarkdown(email) },
    { relativePath: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];

  return { brand, slug, status, files, manifest };
}
