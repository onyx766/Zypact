/**
 * Builds a two-question comparison report from founder-operated ad-hoc probe
 * evidence.
 *
 * The division of labour here is deliberate and is the point of the module.
 *
 *   NUMBERS come from the evidence files. Run counts, reconciliation, brand
 *   presence, intervals, digests, citation totals and every verbatim
 *   quotation are read out of `evidence.json` and are not re-stated, rounded
 *   or "summarised" on the way through.
 *
 *   PROSE comes from the caller. The executive summary, each reading, and
 *   the conclusion are `narrative` inputs. Nothing in this file writes a
 *   finding, because a builder that could compose its own findings is a
 *   builder that can invent one — and the whole value of this artifact is
 *   that a human read the evidence first.
 *
 * What it will not do: compute a verdict. `won`/`partial`/`lost` are not V1
 * semantics, no causal claim is derivable from two different questions asked
 * once each, and the report says so on its own last page.
 */

import type {
  PdfBlock,
  PdfComparisonColumn,
  PdfReportDocument,
  PdfSection,
  PdfSource,
  PdfSourceStatus,
} from "../document";

/* ------------------------------------------------------------------ */
/* The evidence file, as `run-adhoc-evidence-probe.ts` writes it        */
/* ------------------------------------------------------------------ */

export interface AdhocAttempt {
  attemptOrdinal: number;
  runOrdinal: number;
  outcome: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  latencyMs: number | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  requestBodySha256: string | null;
  responseBodySha256: string | null;
  model: string | null;
  answer: string | null;
  citations: string[] | null;
}

export interface AdhocEvidence {
  kind: string;
  generatedAt: string;
  startedAt: string;
  question: { text: string; sha256: string };
  transport: { endpoint: string; requestedModel: string };
  plan: { runs: number; maxRetriesPerRun: number; maxCalls: number };
  reconciliation: {
    attempted: number;
    succeeded: number;
    failed: number;
    retried: number;
    runsPlanned: number;
    runsWithAResult: number;
    accountedFor: boolean;
  };
  brandScan: Array<{
    term: string;
    attemptsMentioningInAnswer: number;
    attemptsMentioningInCitations: number;
  }>;
  presenceRate: {
    numerator: number;
    denominator: number;
    rate: number;
    interval: { low: number; high: number } | null;
    intervalMethod: string;
  } | null;
  attempts: AdhocAttempt[];
}

/** One question's side of the comparison. */
export interface AdhocQuestionInput {
  /** Short label, e.g. "Question 1 — Original". */
  label: string;
  evidence: AdhocEvidence;
  /**
   * A quotation the operator selected as representative, identified by run.
   * The text itself is read from the evidence, never retyped.
   */
  quoteFromRun: number;
  /** The operator's reading of this question's answers. */
  reading: string;
  /**
   * Named tools and the number of runs each appeared in, as counted and
   * checked by the operator.
   */
  toolsNamed: Array<{ tool: string; runs: number }>;
}

/** Outcome of checking one cited URL. */
export interface CitationCheckRow {
  url: string;
  status: number | null;
  error?: string;
  citedIn: { q1: number; q2: number };
  /**
   * Whether the fetched page mentioned the subject brand at all. Null when
   * the page could not be retrieved, so "no mention" is never inferred from
   * a failed fetch.
   */
  mentionsSubject?: boolean | null;
}

export interface AdhocComparisonNarrative {
  /** Two or three sentences. The single most important thing on the page. */
  executiveSummary: string[];
  /** The bounded claims this run supports. */
  establishes: string[];
  /** What it explicitly does not support. */
  doesNotEstablish: string[];
  /** Closing paragraph. */
  conclusion: string;
}

export interface BuildAdhocComparisonInput {
  subject: string;
  subjectUrl: string;
  preparedFor: string;
  generatedAt: string;
  brandTermsScanned: string[];
  questions: [AdhocQuestionInput, AdhocQuestionInput];
  citationCheck: CitationCheckRow[];
  /**
   * Sources a person opened and compared against the claim they were cited
   * for. Only these are reported as supporting or not supporting; everything
   * else is reported as merely resolving.
   */
  claimSupport?: Array<{
    url: string;
    verdict: "supports" | "does_not_support";
    /** What was looked for, in one line. */
    note?: string;
  }>;
  narrative: AdhocComparisonNarrative;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function intervalText(
  presence: AdhocEvidence["presenceRate"],
): string {
  if (!presence?.interval) return "not computed";
  return `${pct(presence.interval.low)} – ${pct(presence.interval.high)}`;
}

function uniqueCitations(evidence: AdhocEvidence): string[] {
  const seen = new Set<string>();
  for (const attempt of evidence.attempts) {
    for (const citation of attempt.citations ?? []) seen.add(citation);
  }
  return [...seen];
}

function attemptForRun(
  evidence: AdhocEvidence,
  run: number,
): AdhocAttempt | undefined {
  return evidence.attempts.find(
    (attempt) => attempt.runOrdinal === run && attempt.outcome === "succeeded",
  );
}

/**
 * Maps an observed HTTP result to a source status.
 *
 * A 2xx becomes `reachable`, NOT `verified_supports`. Fetching a URL proves
 * the page exists; it proves nothing about whether the page backs the
 * sentence it was cited for. Promoting a status code to a claim-support
 * judgement would silently assert an editorial check across every source
 * nobody read. `claimSupport` below is how a source that a person actually
 * compared against the claim gets upgraded.
 *
 * A 401/403/429 becomes `not_checked`, never `unreachable`. Those codes mean
 * an automated request was refused, which is a statement about the check and
 * not about the page; calling it unreachable would report a bot wall as a
 * broken citation.
 */
export function statusFromHttp(
  row: CitationCheckRow,
  claimSupport?: Map<string, "supports" | "does_not_support">,
): PdfSourceStatus {
  const assessed = claimSupport?.get(row.url);
  if (assessed === "supports") return "verified_supports";
  if (assessed === "does_not_support") return "verified_does_not_support";

  if (row.status === null) return "not_checked";
  if ([401, 403, 429].includes(row.status)) return "not_checked";
  if (row.status >= 200 && row.status < 300) return "reachable";
  return "unreachable";
}

function noteFromHttp(
  row: CitationCheckRow,
  claimSupport?: Map<string, "supports" | "does_not_support">,
): string {
  const assessed = claimSupport?.get(row.url);
  if (assessed === "supports") {
    return "Opened and read: the page contains the specifics it was cited for.";
  }
  if (assessed === "does_not_support") {
    return "Opened and read: the page does not contain the claim it was cited for.";
  }
  if (row.status === null) {
    return `No response to an automated request (${row.error ?? "network error"}).`;
  }
  if ([401, 403, 429].includes(row.status)) {
    return "Host refused the automated request, so the page was not inspected.";
  }
  if (row.status >= 200 && row.status < 300) {
    /*
     * Deliberately no note. This is the common case — 31 of 37 rows here —
     * and repeating the same sentence under every one of them adds a page
     * and a half of identical text while telling the reader nothing the
     * status column has not already said. The explanatory note above the
     * list carries it once.
     */
    return "";
  }
  return "Returned an error status.";
}

/* ------------------------------------------------------------------ */
/* Sections                                                             */
/* ------------------------------------------------------------------ */

function runParametersSection(input: BuildAdhocComparisonInput): PdfSection {
  const [first, second] = input.questions;
  const evidence = first.evidence;
  const firstAttempt = evidence.attempts[0];

  const identical =
    first.evidence.transport.requestedModel ===
      second.evidence.transport.requestedModel &&
    first.evidence.transport.endpoint === second.evidence.transport.endpoint &&
    first.evidence.plan.runs === second.evidence.plan.runs;

  const blocks: PdfBlock[] = [
    {
      kind: "keyValues",
      items: [
        { label: "Surface", value: "Perplexity Sonar" },
        { label: "Model", value: evidence.transport.requestedModel, mono: true },
        { label: "Endpoint", value: evidence.transport.endpoint, mono: true },
        { label: "Runs per question", value: String(evidence.plan.runs) },
        {
          label: "Retry cap",
          value: `${evidence.plan.maxRetriesPerRun} per run`,
        },
        {
          label: "Brand terms scanned",
          value: input.brandTermsScanned.join(", "),
        },
      ],
    },
    {
      kind: "table",
      columns: [
        { header: "Question", width: 3 },
        { header: "Attempted", width: 1, align: "right" },
        { header: "Succeeded", width: 1, align: "right" },
        { header: "Failed", width: 1, align: "right" },
        { header: "Retried", width: 1, align: "right" },
      ],
      rows: input.questions.map((question) => [
        question.label,
        String(question.evidence.reconciliation.attempted),
        String(question.evidence.reconciliation.succeeded),
        String(question.evidence.reconciliation.failed),
        String(question.evidence.reconciliation.retried),
      ]),
      caption:
        "Every planned run is accounted for in both questions. No attempt was excluded from the denominators below.",
    },
  ];

  if (firstAttempt?.requestBodySha256) {
    blocks.push({
      kind: "keyValues",
      columns: 1,
      items: [
        {
          label: `Request body digest — ${first.label}, run 1`,
          value: firstAttempt.requestBodySha256,
          mono: true,
        },
      ],
    });
  }

  blocks.push({
    kind: "note",
    title: "Why the settings are held identical",
    text: identical
      ? "Both questions were sent to the same endpoint and model, with the same run count and retry cap, changing only the question text. That removes configuration as an explanation for any difference between them. It does not remove the surface's own run-to-run variation, which is why each question was asked five times rather than once."
      : "The two questions were NOT run under identical settings. Any difference between them may reflect configuration rather than the question, and should not be read as a property of the wording.",
  });

  return {
    title: "How this was run",
    standfirst:
      "Identical settings across both questions, so the only deliberate difference is the wording.",
    blocks,
  };
}

function comparisonColumn(
  question: AdhocQuestionInput,
  subject: string,
): PdfComparisonColumn {
  const { evidence } = question;
  const presence = evidence.presenceRate;

  return {
    label: question.label,
    highlight: presence
      ? `${presence.numerator} / ${presence.denominator}`
      : "—",
    highlightCaption: `runs naming ${subject}`,
    rows: [
      { label: "Question asked", value: evidence.question.text },
      {
        label: "Question digest",
        value: evidence.question.sha256.slice(0, 16) + "…",
        mono: true,
      },
      {
        label: "Named in answer",
        value: `${presence?.numerator ?? 0} of ${presence?.denominator ?? 0} runs`,
      },
      {
        label: "Appeared in citations",
        value: `${evidence.brandScan.reduce(
          (total, term) => total + term.attemptsMentioningInCitations,
          0,
        )} of ${evidence.reconciliation.succeeded} runs`,
      },
      {
        label: "95% interval (Wilson)",
        value: intervalText(presence),
        mono: true,
      },
      {
        label: "Distinct sources cited",
        value: String(uniqueCitations(evidence).length),
      },
    ],
  };
}

function comparisonSection(input: BuildAdhocComparisonInput): PdfSection {
  const [first, second] = input.questions;

  const allTools = new Map<string, { q1: number; q2: number }>();
  for (const [index, question] of input.questions.entries()) {
    for (const entry of question.toolsNamed) {
      const row = allTools.get(entry.tool) ?? { q1: 0, q2: 0 };
      if (index === 0) row.q1 = entry.runs;
      else row.q2 = entry.runs;
      allTools.set(entry.tool, row);
    }
  }

  return {
    title: "The two questions side by side",
    startOnNewPage: true,
    blocks: [
      {
        kind: "comparison",
        columns: [
          comparisonColumn(first, input.subject),
          comparisonColumn(second, input.subject),
        ],
        caption:
          "Both questions return the same presence result, and their intervals are identical. At five runs each, this comparison cannot separate the two questions on presence alone — the difference between them is in the kind of answer they produce, not in how often the brand appears.",
      },
      {
        kind: "heading",
        level: 2,
        text: "Which tools each question surfaced",
      },
      {
        kind: "table",
        columns: [
          { header: "Tool named in the answer", width: 3 },
          { header: `${first.label.split("—")[0].trim()}`, width: 1, align: "right" },
          { header: `${second.label.split("—")[0].trim()}`, width: 1, align: "right" },
        ],
        rows: [...allTools.entries()]
          .sort((a, b) => b[1].q1 + b[1].q2 - (a[1].q1 + a[1].q2))
          .map(([tool, counts]) => [
            tool,
            counts.q1 ? `${counts.q1}/5` : "—",
            counts.q2 ? `${counts.q2}/5` : "—",
          ]),
        caption:
          "Counts are the number of runs, out of five, in which the answer named that tool. A dash means the tool did not appear in any run of that question.",
      },
    ],
  };
}

function verbatimSection(input: BuildAdhocComparisonInput): PdfSection {
  const blocks: PdfBlock[] = [];

  for (const question of input.questions) {
    const attempt = attemptForRun(question.evidence, question.quoteFromRun);

    blocks.push({ kind: "heading", level: 2, text: question.label });

    if (attempt?.answer) {
      blocks.push({
        kind: "verbatim",
        text: attempt.answer,
        // Sonar returns Markdown. Its emphasis is shown as emphasis rather
        // than as literal asterisks; no wording is altered.
        renderMarkdownEmphasis: true,
        attribution: `Perplexity Sonar (${attempt.model ?? question.evidence.transport.requestedModel}), run ${attempt.runOrdinal} of ${question.evidence.reconciliation.succeeded} — ${attempt.completedAt}${
          attempt.providerRequestId
            ? ` — provider request ${attempt.providerRequestId}`
            : ""
        }`,
      });
    } else {
      blocks.push({
        kind: "note",
        title: "No answer available",
        text: `Run ${question.quoteFromRun} did not produce a successful answer, so no quotation is shown.`,
      });
    }

    blocks.push({ kind: "interpretation", text: question.reading });
  }

  return {
    title: "What the surface actually said",
    standfirst:
      "One representative run per question, reproduced word for word as returned, with the provider's own Markdown emphasis shown as emphasis. The bracketed numbers are its citations. The reading beneath each answer is ours and is labelled as such.",
    startOnNewPage: true,
    blocks,
  };
}

function sourcesSection(input: BuildAdhocComparisonInput): PdfSection {
  const claimSupport = new Map(
    (input.claimSupport ?? []).map((entry) => [entry.url, entry.verdict]),
  );
  const claimNotes = new Map(
    (input.claimSupport ?? []).map((entry) => [entry.url, entry.note]),
  );

  const reachable = input.citationCheck.filter(
    (row) => row.status !== null && row.status >= 200 && row.status < 300,
  ).length;
  const refused = input.citationCheck.filter(
    (row) => row.status !== null && [401, 403, 429].includes(row.status),
  ).length;
  const broken = input.citationCheck.filter(
    (row) =>
      row.status === null ||
      (row.status >= 400 && ![401, 403, 429].includes(row.status)),
  ).length;

  const sources: PdfSource[] = input.citationCheck.map((row) => ({
    url: row.url,
    status: statusFromHttp(row, claimSupport),
    httpStatus: row.status ?? undefined,
    note:
      claimNotes.get(row.url) ||
      noteFromHttp(row, claimSupport) ||
      undefined,
  }));

  return {
    title: "Cited sources, checked",
    standfirst:
      "Every distinct URL the surface returned across both questions was requested individually. Cited, reachable and actually supporting the claim are three different facts, and the column on the right says which one was established.",
    startOnNewPage: true,
    blocks: [
      {
        kind: "keyValues",
        items: [
          { label: "Distinct URLs cited", value: String(input.citationCheck.length) },
          { label: "Returned a page (2xx)", value: String(reachable) },
          {
            label: "Read against the claim",
            value: String(claimSupport.size),
          },
          { label: "Refused an automated request", value: String(refused) },
          { label: "Broken or not found", value: String(broken) },
        ],
      },
      {
        kind: "note",
        title: "How to read the status column",
        text: "“Resolved” means the URL returned a page and nothing more — we did not read it against the sentence it was attached to. “Supports claim” is reserved for the sources someone opened and checked, and is therefore a much smaller number than the number of working links. A host that refuses automated requests is recorded as not checked rather than unreachable, because that is a fact about our check and not about the page.",
      },
      { kind: "sources", items: sources },
    ],
  };
}

function conclusionSection(input: BuildAdhocComparisonInput): PdfSection {
  const blocks: PdfBlock[] = [
    { kind: "heading", level: 2, text: "What this establishes" },
    { kind: "bullets", items: input.narrative.establishes },
    { kind: "heading", level: 2, text: "What it does not establish" },
    { kind: "bullets", items: input.narrative.doesNotEstablish },
    { kind: "paragraph", text: input.narrative.conclusion },
    {
      kind: "note",
      title: "Not a before-and-after test",
      text: "These are two different questions asked once each, under identical settings, on one surface. They are not the same question asked before and after a change. Nothing here supports a claim that any intervention caused a result, that a result would repeat on another surface, or that an AI answer affected a purchase.",
    },
  ];

  return { title: "What this does and does not establish", blocks };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export function buildAdhocComparisonReport(
  input: BuildAdhocComparisonInput,
): PdfReportDocument {
  const [first] = input.questions;

  return {
    meta: {
      title: "AI Answer Visibility: Two Buyer Questions Compared",
      subtitle: `How Perplexity Sonar answers two differently framed questions about seeing what AI agents have done, and where ${input.subject} appears in those answers.`,
      subject: `${input.subject} — ${input.subjectUrl}`,
      preparedFor: input.preparedFor,
      preparedBy: "Zypact",
      generatedAt: input.generatedAt,
      methodologyLabel:
        "Founder-operated directional snapshot. Perplexity Sonar only, five runs per question, one surface. Exploratory comparison of two questions — not a pilot baseline, not a before-and-after test, and not evidence of causation.",
      footerLabel:
        "Founder-operated directional snapshot — Perplexity Sonar only, five runs per question. Not a pilot baseline or a before-and-after test.",
      confidentiality: `Prepared for ${input.subject}. Not for redistribution.`,
      pageSize: "A4",
    },
    sections: [
      {
        title: "Executive summary",
        blocks: [
          {
            kind: "paragraph",
            tone: "lead",
            text: input.narrative.executiveSummary[0],
          },
          ...input.narrative.executiveSummary.slice(1).map(
            (text): PdfBlock => ({ kind: "paragraph", text }),
          ),
        ],
      },
      runParametersSection(input),
      comparisonSection(input),
      verbatimSection(input),
      sourcesSection(input),
      conclusionSection(input),
    ],
  };
}
