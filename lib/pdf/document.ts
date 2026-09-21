/**
 * The document model for generated PDFs.
 *
 * A report is DATA here, not layout. Callers describe what the report says;
 * `render.ts` decides how it looks. That separation is what lets the protocol
 * report, the Outcome Card and a founder-operated snapshot share one brand
 * without sharing a code path, and it is what makes a report testable: a test
 * can assert the model without rendering a byte.
 *
 * Two block kinds carry methodology weight rather than styling weight, and
 * they are separate types on purpose:
 *
 *   `verbatim`       — exactly what a provider returned. Never edited, never
 *                      trimmed for fit, always visibly attributed.
 *   `interpretation` — what Zypact concluded from it.
 *
 * The canonical package requires that a reader can always tell those apart
 * (CLAUDE.md, "Evidence and paid-call invariants"). Keeping them as distinct
 * block kinds means a caller cannot accidentally blur them by choosing a
 * style, and a reviewer can grep for one without reading the whole document.
 */

export type PdfPageSize = "A4" | "LETTER";

export interface PdfReportMeta {
  /** Cover title. Required — a report without a title is not deliverable. */
  title: string;
  /** One supporting line under the title. */
  subtitle?: string;
  /** The subject of the report, e.g. the company being looked at. */
  subject?: string;
  /** Who this was prepared for. */
  preparedFor?: string;
  /** Who produced it. Defaults to "Zypact" at render time. */
  preparedBy?: string;
  /** ISO-8601 instant. Rendered as a UTC date; never reformatted to local. */
  generatedAt: string;

  /**
   * The methodology label that must travel with the document — for example
   * "Founder-operated directional snapshot. Perplexity Sonar only."
   *
   * This is not decoration. A directional single-surface probe presented
   * without its label reads as a pilot baseline, which it is not, so the
   * renderer prints this on the cover AND in the footer of every page. A
   * document whose scope can be established only by reading the cover is one
   * page-screenshot away from misrepresenting itself.
   */
  methodologyLabel?: string;

  /** Short handling line, e.g. "Prepared for Orbit. Not for redistribution." */
  confidentiality?: string;

  /** Defaults to A4. */
  pageSize?: PdfPageSize;

  /**
   * Suppresses the page footer's document id line. Only for fixtures whose
   * output is byte-compared across runs.
   */
  omitGeneratedAtInFooter?: boolean;
}

/** A label/value pair, used for run parameters and identity fields. */
export interface PdfKeyValue {
  label: string;
  value: string;
  /** Renders the value in the monospaced treatment — digests, ids, models. */
  mono?: boolean;
}

export interface PdfTableColumn {
  header: string;
  /** Relative width. Columns are sized by their share of the total. */
  width?: number;
  align?: "left" | "right" | "center";
  /** Renders this column's cells in the monospaced treatment. */
  mono?: boolean;
}

/** One side of a side-by-side comparison. */
export interface PdfComparisonColumn {
  /** Short label above the panel, e.g. "Question 1 — Original". */
  label: string;
  /** Optional headline figure for the panel. */
  highlight?: string;
  /** Optional caption under the headline figure. */
  highlightCaption?: string;
  /** Body rows for the panel. */
  rows: PdfKeyValue[];
}

/**
 * The outcome of checking one cited source.
 *
 * There is deliberately no default and no boolean. "Cited" and "verified to
 * support the claim" are different facts, and a model that lets the second be
 * inferred from the first is a model that will eventually overstate.
 */
export type PdfSourceStatus =
  | "verified_supports"
  | "verified_does_not_support"
  | "unreachable"
  | "not_checked";

export interface PdfSource {
  url: string;
  /** Page title, when it could be read. */
  title?: string;
  status: PdfSourceStatus;
  /** HTTP status observed when the URL was checked, when it was checked. */
  httpStatus?: number;
  /** What the check established, in one line. */
  note?: string;
}

export type PdfBlock =
  | { kind: "heading"; text: string; level?: 2 | 3 }
  | { kind: "paragraph"; text: string; tone?: "default" | "muted" | "lead" }
  | { kind: "bullets"; items: string[]; ordered?: boolean }
  | { kind: "keyValues"; items: PdfKeyValue[]; columns?: 1 | 2 }
  | {
      kind: "table";
      columns: PdfTableColumn[];
      rows: string[][];
      caption?: string;
    }
  | {
      kind: "comparison";
      columns: [PdfComparisonColumn, PdfComparisonColumn];
      caption?: string;
    }
  | {
      kind: "verbatim";
      /** Exact provider text. The renderer does not trim or reflow it. */
      text: string;
      /** Who or what produced it, e.g. "Perplexity Sonar, run 3 of 5". */
      attribution?: string;
      /** Overrides the default "Verbatim" eyebrow. */
      label?: string;
    }
  | { kind: "interpretation"; text: string; label?: string }
  | { kind: "sources"; items: PdfSource[]; caption?: string }
  | { kind: "note"; text: string; title?: string }
  | { kind: "spacer"; size?: "sm" | "md" | "lg" }
  | { kind: "pageBreak" };

export interface PdfSection {
  /** Section heading. Omit for an untitled run of blocks. */
  title?: string;
  /** Optional standfirst under the section heading. */
  standfirst?: string;
  blocks: PdfBlock[];
  /** Forces this section to begin on a fresh page. */
  startOnNewPage?: boolean;
}

export interface PdfReportDocument {
  meta: PdfReportMeta;
  sections: PdfSection[];
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

export interface PdfDocumentProblem {
  path: string;
  message: string;
}

/**
 * Structural checks that catch a malformed report before it is rendered and
 * sent. This validates SHAPE, not truthfulness: it cannot know whether a
 * number is right, only whether the document is internally coherent.
 *
 * Returns every problem rather than the first, so a caller fixes one round
 * of mistakes instead of one mistake.
 */
export function validateReportDocument(
  doc: PdfReportDocument,
): PdfDocumentProblem[] {
  const problems: PdfDocumentProblem[] = [];

  if (!doc.meta.title.trim()) {
    problems.push({ path: "meta.title", message: "Title is empty." });
  }

  if (Number.isNaN(Date.parse(doc.meta.generatedAt))) {
    problems.push({
      path: "meta.generatedAt",
      message: `Not an ISO-8601 instant: ${JSON.stringify(doc.meta.generatedAt)}.`,
    });
  }

  if (doc.sections.length === 0) {
    problems.push({ path: "sections", message: "Report has no sections." });
  }

  doc.sections.forEach((section, sectionIndex) => {
    const at = `sections[${sectionIndex}]`;

    if (section.blocks.length === 0 && !section.title) {
      problems.push({
        path: at,
        message: "Section has neither a title nor any blocks.",
      });
    }

    section.blocks.forEach((block, blockIndex) => {
      const blockAt = `${at}.blocks[${blockIndex}]`;

      switch (block.kind) {
        case "table": {
          if (block.columns.length === 0) {
            problems.push({ path: blockAt, message: "Table has no columns." });
            break;
          }
          block.rows.forEach((row, rowIndex) => {
            if (row.length !== block.columns.length) {
              problems.push({
                path: `${blockAt}.rows[${rowIndex}]`,
                message: `Row has ${row.length} cells but the table declares ${block.columns.length} columns.`,
              });
            }
          });
          break;
        }

        case "verbatim": {
          if (!block.text.length) {
            problems.push({
              path: blockAt,
              message:
                "Verbatim block is empty. An empty quotation misrepresents the source; omit the block instead.",
            });
          }
          break;
        }

        case "sources": {
          block.items.forEach((source, sourceIndex) => {
            if (!/^https?:\/\//i.test(source.url)) {
              problems.push({
                path: `${blockAt}.items[${sourceIndex}]`,
                message: `Source URL is not http(s): ${JSON.stringify(source.url)}.`,
              });
            }
          });
          break;
        }

        case "bullets": {
          if (block.items.length === 0) {
            problems.push({ path: blockAt, message: "Bullet list is empty." });
          }
          break;
        }

        default:
          break;
      }
    });
  });

  return problems;
}
