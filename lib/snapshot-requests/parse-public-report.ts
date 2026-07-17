export interface PublicReportPromptRow {
  prompt: string;
  runs: string;
  recommended: string;
  cited: string;
  outcome: string;
  competitors: string;
}

export interface PublicSnapshotReport {
  brand: string;
  generated: string;
  website: string;
  category: string;
  trend: string;
  visibility: string;
  brandedReputation: string;
  competitorLabel: string;
  competitors: string;
  executiveNarrative: string;
  brandedEvidencePrompt: string;
  brandedEvidenceSummary: string;
  promptIntro: string;
  promptRows: PublicReportPromptRow[];
  brandedCheck: string;
  commercialExplanation: string;
  focusPrompt: string;
  frameExplanation: string;
  firstFixHeading: string;
  firstFixBody: string;
  evidenceNeeded: string[];
  nextStep: string;
  integrityNotes: string[];
}

function clean(value: string | undefined | null): string {
  return (value ?? "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(
  markdown: string,
  heading: string
): string {
  const escaped = escapeRegex(heading);

  return (
    markdown.match(
      new RegExp(
        `(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
        "i"
      )
    )?.[1]?.trim() ?? ""
  );
}

function extractSubsection(
  markdown: string,
  heading: string
): string {
  const escaped = escapeRegex(heading);

  return (
    markdown.match(
      new RegExp(
        `(?:^|\\n)###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|\\n##\\s+|$)`,
        "i"
      )
    )?.[1]?.trim() ?? ""
  );
}

function extractMetadata(
  markdown: string,
  label: string
): string {
  const escaped = escapeRegex(label);

  return clean(
    markdown.match(
      new RegExp(`^${escaped}:\\s*(.+)$`, "im")
    )?.[1]
  );
}

function extractBoldLine(
  markdown: string,
  label: string
): string {
  const escaped = escapeRegex(label);

  return clean(
    markdown.match(
      new RegExp(
        `^\\*\\*${escaped}:\\*\\*\\s*(.+)$`,
        "im"
      )
    )?.[1]
  ).replace(/\.$/, "");
}

function paragraphsBeforeHeading(
  value: string
): string[] {
  return value
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(
      (paragraph) =>
        paragraph.length > 0 &&
        !paragraph.startsWith("###") &&
        !paragraph.startsWith("|") &&
        !paragraph.startsWith("**")
    );
}

function parsePromptRows(
  section: string
): PublicReportPromptRow[] {
  const rows: PublicReportPromptRow[] = [];

  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (
      !trimmed.startsWith("|") ||
      /^\|\s*-+/.test(trimmed) ||
      /buyer prompt tested/i.test(trimmed)
    ) {
      continue;
    }

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map(clean);

    if (cells.length < 6) {
      continue;
    }

    rows.push({
      prompt: cells[0],
      runs: cells[1],
      recommended: cells[2],
      cited: cells[3],
      outcome: cells[4],
      competitors: cells[5],
    });
  }

  return rows;
}

function extractList(
  value: string
): string[] {
  return value
    .split(/\r?\n/)
    .map((line) =>
      clean(line.replace(/^-\s+/, ""))
    )
    .filter(Boolean);
}

export function parsePublicSnapshotReport(
  markdown: string
): PublicSnapshotReport {
  const brand =
    clean(
      markdown.match(
        /^#\s+Zypact Short Report\s+[—-]\s+(.+)$/m
      )?.[1]
    ) || "Your company";

  const executive = extractSection(
    markdown,
    "1\\. Executive diagnosis"
  );

  const probes = extractSection(
    markdown,
    "2\\. What happened in the AI probes"
  );

  const commercial = extractSection(
    markdown,
    "3\\. Why this matters commercially"
  );

  const fix = extractSection(
    markdown,
    "4\\. First recommended fix"
  );

  const next = extractSection(
    markdown,
    "5\\. Suggested next step"
  );

  const integrity =
    extractSection(
      markdown,
      "6\\. Integrity notes"
    ) ||
    extractSection(
      markdown,
      "5\\. Integrity notes"
    );

  const competitorMatch = executive.match(
    /^\*\*(Competitors AI recommended across the tested prompts|Other tools AI recommended across the tested prompts|Competitors AI recommended instead):\*\*\s*(.+)$/im
  );

  const executiveParagraphs =
    paragraphsBeforeHeading(executive);

  const promptIntro =
    probes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 0 &&
          !line.startsWith("|") &&
          !line.startsWith("###")
      ) ?? "";

  const brandedEvidence = extractSubsection(
    executive,
    "Direct evidence from the branded check"
  );

  const evidencePrompt =
    clean(
      brandedEvidence.match(
        /A buyer asked:\s*\n+\s*>\s*(.+)/i
      )?.[1]
    );

  const evidenceSummary =
    clean(
      brandedEvidence.match(
        /The AI response was summarized as:\s*\n+\s*>\s*(.+)/i
      )?.[1]
    );

  const brandedCheckSection =
    extractSubsection(
      probes,
      "Branded reputation check"
    );

  const brandedCheck =
    clean(
      brandedCheckSection
        .split(/\r?\n/)
        .find((line) => line.trim()) ?? ""
    );

  const commercialParagraphs =
    commercial
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

  const focusPrompt =
    clean(
      commercial.match(
        /(?:clearest buying-frame loss|clearest consolidation opportunity) is:\s*\n+\s*>\s*(.+)/i
      )?.[1]
    );

  const frameExplanation =
    clean(
      commercialParagraphs.find(
        (paragraph) =>
          /^In that frame,/i.test(paragraph)
      )
    );

  const fixHeading =
    clean(
      fix.match(/^\*\*(.+?)\*\*/m)?.[1]
    );

  const evidenceSection =
    extractSubsection(
      fix,
      "Evidence needed before publish-ready copy"
    );

  const fixBody =
    clean(
      fix
        .replace(/^\*\*.+?\*\*\s*/s, "")
        .split(
          /\n###\s+Evidence needed before publish-ready copy/i
        )[0]
    );

  return {
    brand,
    generated: extractMetadata(
      markdown,
      "Generated"
    ),
    website: extractMetadata(
      markdown,
      "Website"
    ),
    category: extractMetadata(
      markdown,
      "Category read by AI"
    ),
    trend:
      extractBoldLine(
        markdown,
        "Trend vs previous scan"
      ) || "— (first scan)",
    visibility: extractBoldLine(
      executive,
      "Visibility"
    ),
    brandedReputation: extractBoldLine(
      executive,
      "Branded reputation"
    ),
    competitorLabel:
      clean(competitorMatch?.[1]) ||
      "Competitors observed",
    competitors:
      clean(competitorMatch?.[2]).replace(
        /\.$/,
        ""
      ) || "No specific products observed",
    executiveNarrative:
      clean(executiveParagraphs[0]),
    brandedEvidencePrompt:
      evidencePrompt,
    brandedEvidenceSummary:
      evidenceSummary,
    promptIntro: clean(promptIntro),
    promptRows: parsePromptRows(probes),
    brandedCheck,
    commercialExplanation:
      clean(commercialParagraphs[0]),
    focusPrompt,
    frameExplanation,
    firstFixHeading:
      fixHeading || "Build the first evidence-backed fix",
    firstFixBody: fixBody,
    evidenceNeeded:
      extractList(evidenceSection),
    nextStep: clean(next),
    integrityNotes:
      extractList(integrity),
  };
}
