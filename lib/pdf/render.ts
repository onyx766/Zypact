/**
 * Renders a `PdfReportDocument` to PDF bytes.
 *
 * This is the server-safe entry point. It has no browser dependency, no
 * network call and no Next.js import, so it runs unchanged in a Next route,
 * in a script, and inside the protocol worker image — which installs with
 * `npm ci --omit=dev` and ships no Chromium. `@react-pdf/renderer` is a
 * runtime dependency precisely so that image keeps it.
 *
 * The renderer is deliberately incurious about meaning. It will lay out
 * whatever the document model says, including a claim that is wrong. What it
 * guarantees is narrower and worth stating: a verbatim block is never
 * silently edited to fit, the methodology label appears on every page rather
 * than only on the cover, and a structurally malformed document is refused
 * before it can be rendered and sent.
 */

import { createElement as h, type ReactElement } from "react";

import { COLORS } from "./brand";
import { renderBlock, type BlockContext } from "./blocks";
import {
  type PdfReportDocument,
  type PdfSection,
  validateReportDocument,
} from "./document";
import { resolveBrandFont, type ResolvedBrandFont } from "./fonts";
import { brandLogo } from "./logo";
import { loadPdfRuntime, type PdfRuntime } from "./runtime";
import { createStyles, type PdfStyles } from "./styles";

/** Points per page size. react-pdf accepts these names directly. */
const PAGE_SIZES = { A4: "A4", LETTER: "LETTER" } as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Formats an instant as a UTC date.
 *
 * Explicitly not `toLocaleDateString`: that reads the host's locale and time
 * zone, so the same report would carry a different date depending on which
 * machine rendered it, and a client-facing artifact whose date moves is one
 * nobody can reconcile against the evidence.
 */
export function formatUtcDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function formatUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(iso)}, ${hh}:${mm} UTC`;
}

/* ------------------------------------------------------------------ */
/* Cover                                                                */
/* ------------------------------------------------------------------ */

function coverMetaCell(
  label: string,
  value: string,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  return h(
    View,
    { key, style: ctx.styles.coverMetaCell },
    h(Text, { style: ctx.styles.coverMetaLabel }, label),
    h(Text, { style: ctx.styles.coverMetaValue }, value),
  );
}

function renderCover(
  doc: PdfReportDocument,
  ctx: BlockContext,
  font: ResolvedBrandFont,
): ReactElement {
  const { Page, Text, View } = ctx.pdf;
  const { styles } = ctx;
  const { meta } = doc;

  const cells: ReactElement[] = [];
  if (meta.subject) {
    cells.push(coverMetaCell("Subject", meta.subject, ctx, "cover-subject"));
  }
  if (meta.preparedFor) {
    cells.push(
      coverMetaCell("Prepared for", meta.preparedFor, ctx, "cover-for"),
    );
  }
  cells.push(
    coverMetaCell("Prepared by", meta.preparedBy ?? "Zypact", ctx, "cover-by"),
  );
  cells.push(
    coverMetaCell(
      "Date",
      formatUtcTimestamp(meta.generatedAt),
      ctx,
      "cover-date",
    ),
  );

  return h(
    Page,
    {
      key: "cover",
      size: PAGE_SIZES[meta.pageSize ?? "A4"],
      style: styles.coverPage,
    },
    h(
      View,
      { style: styles.coverTop },
      h(
        View,
        { style: styles.coverLogoRow },
        brandLogo({
          pdf: ctx.pdf,
          height: 24,
          tone: "light",
          fontFamily: font.family,
        }),
      ),
      h(View, { style: styles.coverRule }),
      h(Text, { style: styles.coverTitle }, meta.title),
      meta.subtitle
        ? h(Text, { style: styles.coverSubtitle }, meta.subtitle)
        : null,
      h(View, { style: styles.coverMetaGrid }, ...cells),
    ),
    h(
      View,
      { style: styles.coverBottom },
      h(View, { style: styles.coverBottomRule }),
      meta.methodologyLabel
        ? h(Text, { style: styles.coverMethodology }, meta.methodologyLabel)
        : null,
      meta.confidentiality
        ? h(Text, { style: styles.coverConfidentiality }, meta.confidentiality)
        : null,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Running frame                                                        */
/* ------------------------------------------------------------------ */

function renderRunningHeader(
  doc: PdfReportDocument,
  ctx: BlockContext,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const left = doc.meta.subject ?? doc.meta.title;
  return h(
    View,
    { key: "header", style: ctx.styles.runningHeader, fixed: true },
    h(Text, { style: ctx.styles.runningHeaderText }, left),
    h(Text, { style: ctx.styles.runningHeaderText }, "Zypact"),
  );
}

/**
 * The footer carries the methodology label on EVERY page, not just the
 * cover. A single page of a PDF travels on its own — forwarded, screenshotted,
 * pasted into a deck — and a directional single-surface probe that arrives
 * without its scope reads as something stronger than it is.
 */
function renderFooter(
  doc: PdfReportDocument,
  ctx: BlockContext,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const { styles } = ctx;
  const label = doc.meta.methodologyLabel ?? "";

  return h(
    View,
    { key: "footer", style: styles.footer, fixed: true },
    h(View, { style: styles.footerRule }),
    h(
      View,
      { style: styles.footerRow },
      h(Text, { style: styles.footerText }, label),
      h(Text, {
        style: styles.footerPage,
        render: ({
          pageNumber,
          totalPages,
        }: {
          pageNumber: number;
          totalPages: number;
        }) => `${pageNumber} / ${totalPages}`,
      }),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                             */
/* ------------------------------------------------------------------ */

function renderSection(
  section: PdfSection,
  ctx: BlockContext,
  index: number,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const { styles } = ctx;
  const key = `s${index}`;

  const header = section.title
    ? h(
        View,
        { key: `${key}-head`, style: styles.sectionHeader, wrap: false },
        h(Text, { style: styles.sectionTitle }, section.title),
        h(View, { style: styles.sectionRule }),
        section.standfirst
          ? h(Text, { style: styles.sectionStandfirst }, section.standfirst)
          : null,
      )
    : null;

  const body = section.blocks
    .map((block, blockIndex) => renderBlock(block, ctx, `${key}-b${blockIndex}`))
    .filter((element): element is ReactElement => element !== null);

  return h(
    View,
    {
      key,
      break: section.startOnNewPage === true && index > 0,
      style: { marginBottom: 20 },
    },
    header,
    h(View, { style: styles.sectionBody }, ...body),
  );
}

/* ------------------------------------------------------------------ */
/* Document                                                             */
/* ------------------------------------------------------------------ */

/**
 * What `renderToBuffer` accepts: `ReactElement<DocumentProps>`.
 *
 * Derived from the runtime's own signature rather than naming `DocumentProps`
 * directly, because `@react-pdf/renderer` declares `export = ReactPDF` and
 * its prop types live inside that namespace — reaching them by name would
 * mean a value import, which `runtime.ts` forbids in this directory.
 */
type PdfDocumentElement = Parameters<PdfRuntime["renderToBuffer"]>[0];

function buildDocument(
  doc: PdfReportDocument,
  font: ResolvedBrandFont,
  pdf: PdfRuntime,
): PdfDocumentElement {
  const { Document, Page } = pdf;
  const styles: PdfStyles = createStyles(font.family);
  const ctx: BlockContext = { pdf, styles };
  const { meta } = doc;

  return h(
    Document,
    {
      title: meta.title,
      author: meta.preparedBy ?? "Zypact",
      subject: meta.subtitle ?? meta.methodologyLabel ?? meta.title,
      creator: "Zypact",
      producer: "Zypact",
    },
    renderCover(doc, ctx, font),
    h(
      Page,
      {
        key: "body",
        size: PAGE_SIZES[meta.pageSize ?? "A4"],
        style: styles.contentPage,
        wrap: true,
      },
      renderRunningHeader(doc, ctx),
      renderFooter(doc, ctx),
      ...doc.sections.map((section, index) => renderSection(section, ctx, index)),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Entry points                                                         */
/* ------------------------------------------------------------------ */

export class PdfDocumentInvalidError extends Error {
  readonly problems: ReadonlyArray<{ path: string; message: string }>;

  constructor(problems: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Report document is not renderable:\n${problems
        .map((problem) => `  - ${problem.path}: ${problem.message}`)
        .join("\n")}`,
    );
    this.name = "PdfDocumentInvalidError";
    this.problems = problems;
  }
}

export interface RenderReportResult {
  bytes: Buffer;
  /** Which font was actually used, for a caller that keeps a render log. */
  font: ResolvedBrandFont;
}

/**
 * Renders the document and returns the PDF bytes.
 *
 * Throws `PdfDocumentInvalidError` when the document is structurally
 * malformed. Failing here is the point: a report with a table row that does
 * not match its header, or an empty verbatim quotation, is a report that
 * would misrepresent something once it reached a client.
 */
export async function renderReportPdf(
  doc: PdfReportDocument,
): Promise<RenderReportResult> {
  const problems = validateReportDocument(doc);
  if (problems.length > 0) {
    throw new PdfDocumentInvalidError(problems);
  }

  const pdf = await loadPdfRuntime();
  const font = resolveBrandFont(pdf);
  const bytes = await pdf.renderToBuffer(buildDocument(doc, font, pdf));

  return { bytes, font };
}

/** Convenience wrapper that returns only the bytes. */
export async function renderReportPdfBytes(
  doc: PdfReportDocument,
): Promise<Buffer> {
  const { bytes } = await renderReportPdf(doc);
  return bytes;
}

/** Exported for tests that assert on the palette without rendering. */
export const RENDER_COLORS = COLORS;
