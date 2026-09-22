/**
 * Block renderers.
 *
 * One function per `PdfBlock` kind. Each returns a react-pdf element tree and
 * knows nothing about the document around it, so a new block kind is a local
 * change and a report that never uses a kind never pays for it.
 *
 * Two constraints shape the mechanics here, both external:
 *
 * JSX is not used anywhere under `lib/`. The repository compiles with
 * `jsx: "preserve"` (tsconfig.json) because Next.js does that transform for
 * application code — but `lib/` is also copied into the worker image and
 * executed by `tsx`, with no Next.js in the picture. Preserved JSX would
 * reach Node as JSX and fail. `createElement` sidesteps it and keeps `lib/`
 * free of `.tsx`, as it already is.
 *
 * The renderer module is passed in, never imported. See `runtime.ts`: a
 * static import of `@react-pdf/renderer` breaks under tsx's CommonJS
 * resolver, which is what the worker runs on.
 */

import { createElement as h, type ReactElement } from "react";

import { COLORS, SPACE } from "./brand";
import type {
  PdfBlock,
  PdfComparisonColumn,
  PdfKeyValue,
  PdfSource,
  PdfSourceStatus,
} from "./document";
import type { PdfRuntime } from "./runtime";
import type { PdfStyles } from "./styles";

/** Everything a block renderer needs that is not the block itself. */
export interface BlockContext {
  pdf: PdfRuntime;
  styles: PdfStyles;
}

/* ------------------------------------------------------------------ */
/* Source status presentation                                           */
/* ------------------------------------------------------------------ */

/**
 * How each verification outcome is worded and coloured.
 *
 * The wording is the important part. "Verified" alone would let a reader
 * assume the source backs the claim, when all that was verified is that the
 * page exists. Each label therefore names what was actually established.
 */
const SOURCE_STATUS_PRESENTATION: Record<
  PdfSourceStatus,
  { label: string; color: string }
> = {
  verified_supports: { label: "Supports claim", color: COLORS.statusPositive },
  verified_does_not_support: {
    label: "Does not support",
    color: COLORS.statusNegative,
  },
  // "Resolved", not "Verified": the page came back, and that is all this
  // says. Whether it backs the claim is a separate judgement.
  reachable: { label: "Resolved", color: COLORS.statusNeutral },
  unreachable: { label: "Unreachable", color: COLORS.statusUnknown },
  not_checked: { label: "Not checked", color: COLORS.statusNeutral },
};

export function sourceStatusLabel(status: PdfSourceStatus): string {
  return SOURCE_STATUS_PRESENTATION[status].label;
}

/* ------------------------------------------------------------------ */
/* Individual blocks                                                    */
/* ------------------------------------------------------------------ */

function renderHeading(
  block: Extract<PdfBlock, { kind: "heading" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const level = block.level ?? 2;
  return h(
    ctx.pdf.Text,
    {
      key,
      style: level === 2 ? ctx.styles.h2 : ctx.styles.h3,
      minPresenceAhead: 48,
    },
    block.text,
  );
}

function renderParagraph(
  block: Extract<PdfBlock, { kind: "paragraph" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const style =
    block.tone === "lead"
      ? ctx.styles.paragraphLead
      : block.tone === "muted"
        ? ctx.styles.paragraphMuted
        : ctx.styles.paragraph;
  return h(ctx.pdf.Text, { key, style }, block.text);
}

function renderBullets(
  block: Extract<PdfBlock, { kind: "bullets" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  return h(
    View,
    { key, style: { marginBottom: SPACE.sm } },
    ...block.items.map((item, index) =>
      h(
        View,
        { key: `${key}-i${index}`, style: ctx.styles.bulletRow, wrap: false },
        h(
          Text,
          { style: ctx.styles.bulletMarker },
          block.ordered ? `${index + 1}.` : "—",
        ),
        h(Text, { style: ctx.styles.bulletText }, item),
      ),
    ),
  );
}

/**
 * Above this many characters, a monospaced value gets a full-width cell.
 *
 * This exists to protect evidence, not to tidy the layout. A SHA-256 digest
 * is 64 characters; in a half-width cell it does not fit, and react-pdf
 * breaks the overflow by INSERTING A HYPHEN — so `3f1c9ab...` renders as
 * `3-` on one line and the remainder on the next. A reader cannot tell that
 * hyphen from part of the value, and a digest that cannot be read back
 * character for character is not verifiable.
 *
 * At the monospaced size (7.6pt Courier, ~0.6em per character) a full-width
 * cell on A4 holds roughly 100 characters, which covers digests, provider
 * request ids and ordinary URLs.
 */
const MONO_FULL_WIDTH_THRESHOLD = 34;

function renderKeyValue(
  item: PdfKeyValue,
  ctx: BlockContext,
  full: boolean,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const needsFullWidth =
    full ||
    (item.mono === true && item.value.length > MONO_FULL_WIDTH_THRESHOLD);

  return h(
    View,
    {
      key,
      style: needsFullWidth ? ctx.styles.kvCellFull : ctx.styles.kvCellHalf,
      wrap: false,
    },
    h(Text, { style: ctx.styles.kvLabel }, item.label),
    h(
      Text,
      { style: item.mono ? ctx.styles.kvValueMono : ctx.styles.kvValue },
      item.value,
    ),
  );
}

function renderKeyValues(
  block: Extract<PdfBlock, { kind: "keyValues" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const full = (block.columns ?? 2) === 1;
  return h(
    ctx.pdf.View,
    { key, style: ctx.styles.kvGrid },
    ...block.items.map((item, index) =>
      renderKeyValue(item, ctx, full, `${key}-kv${index}`),
    ),
  );
}

/**
 * Column widths are declared as relative shares and converted to percentages
 * here, so a caller writes `width: 2` rather than doing the arithmetic. A
 * column with no declared width counts as 1.
 */
function columnWidths(columns: { width?: number }[]): string[] {
  const shares = columns.map((column) => column.width ?? 1);
  const total = shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share) => `${(share / total) * 100}%`);
}

function renderTable(
  block: Extract<PdfBlock, { kind: "table" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const widths = columnWidths(block.columns);

  const head = h(
    View,
    { key: `${key}-head`, style: ctx.styles.tableHeadRow },
    ...block.columns.map((column, index) =>
      h(
        Text,
        {
          key: `${key}-h${index}`,
          style: [
            ctx.styles.tableHeadCell,
            { width: widths[index], textAlign: column.align ?? "left" },
          ],
        },
        column.header,
      ),
    ),
  );

  const rows = block.rows.map((row, rowIndex) =>
    h(
      View,
      { key: `${key}-r${rowIndex}`, style: ctx.styles.tableRow, wrap: false },
      ...row.map((cell, cellIndex) => {
        const column = block.columns[cellIndex];
        return h(
          Text,
          {
            key: `${key}-r${rowIndex}c${cellIndex}`,
            style: [
              column.mono ? ctx.styles.tableCellMono : ctx.styles.tableCell,
              { width: widths[cellIndex], textAlign: column.align ?? "left" },
            ],
          },
          cell,
        );
      }),
    ),
  );

  return h(
    View,
    { key, style: ctx.styles.table },
    head,
    ...rows,
    block.caption
      ? h(Text, { style: ctx.styles.caption }, block.caption)
      : null,
  );
}

/** One cell of a comparison band. `side` only decides the divider and padding. */
function comparisonCell(
  ctx: BlockContext,
  side: "left" | "right",
  key: string,
  ...children: (ReactElement | null)[]
): ReactElement {
  return h(
    ctx.pdf.View,
    {
      key,
      style: [
        ctx.styles.comparisonCol,
        side === "left"
          ? ctx.styles.comparisonColLeft
          : ctx.styles.comparisonColRight,
      ],
    },
    ...children,
  );
}

/**
 * A side-by-side comparison, laid out BAND BY BAND rather than as two
 * independent columns.
 *
 * Two stacked columns are the obvious implementation and the wrong one: as
 * soon as one side's value wraps to a second line, every row beneath it on
 * that side sits lower than its counterpart, and the reader can no longer
 * scan across. Comparing is the entire purpose of the block, so corresponding
 * rows share a flex row and therefore share a baseline. Rows are matched by
 * index; if one side has fewer rows, the missing cells render empty rather
 * than pulling the rest of the column up.
 *
 * The dividing rule is the right-hand cell's left border. Because the bands
 * are contiguous, those borders stack into one continuous line.
 */
function renderComparison(
  block: Extract<PdfBlock, { kind: "comparison" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  const [left, right] = block.columns;

  const band = (
    bandKey: string,
    build: (column: PdfComparisonColumn, side: "left" | "right") => (ReactElement | null)[],
  ): ReactElement =>
    h(
      View,
      { key: bandKey, style: ctx.styles.comparisonRow, wrap: false },
      comparisonCell(ctx, "left", `${bandKey}-l`, ...build(left, "left")),
      comparisonCell(ctx, "right", `${bandKey}-r`, ...build(right, "right")),
    );

  const bands: ReactElement[] = [];

  bands.push(
    band(`${key}-label`, (column) => [
      h(Text, { style: ctx.styles.comparisonLabel }, column.label),
    ]),
  );

  if (left.highlight || right.highlight) {
    bands.push(
      band(`${key}-highlight`, (column) => [
        column.highlight
          ? h(Text, { style: ctx.styles.comparisonHighlight }, column.highlight)
          : null,
        column.highlightCaption
          ? h(
              Text,
              { style: ctx.styles.comparisonHighlightCaption },
              column.highlightCaption,
            )
          : null,
      ]),
    );
  }

  const rowCount = Math.max(left.rows.length, right.rows.length);
  for (let index = 0; index < rowCount; index += 1) {
    bands.push(
      band(`${key}-row${index}`, (column) => {
        const row = column.rows[index];
        if (!row) return [null];
        return [
          h(Text, { style: ctx.styles.kvLabel }, row.label),
          h(
            Text,
            { style: row.mono ? ctx.styles.kvValueMono : ctx.styles.kvValue },
            row.value,
          ),
        ];
      }),
    );
  }

  return h(
    View,
    { key },
    ...bands,
    block.caption
      ? h(Text, { style: ctx.styles.caption }, block.caption)
      : null,
  );
}

/**
 * Splits text on `**bold**` and returns react-pdf children.
 *
 * Only paired double asterisks are treated as emphasis. An unpaired `**` is
 * left exactly as it appears, because guessing at the author's intent is how
 * a quotation stops being one.
 */
function markdownEmphasisChildren(
  text: string,
  ctx: BlockContext,
  key: string,
): (ReactElement | string)[] {
  const parts: (ReactElement | string)[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      h(
        ctx.pdf.Text,
        { key: `${key}-b${index}`, style: { fontWeight: 700 } },
        match[1],
      ),
    );
    cursor = match.index + match[0].length;
    index += 1;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : [text];
}

function renderVerbatim(
  block: Extract<PdfBlock, { kind: "verbatim" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;

  // The provider's exact text. Not trimmed, not reflowed, not shortened to
  // fit: a quotation edited for layout is no longer evidence. The only
  // transformation permitted is the provider's own Markdown emphasis, and
  // only when the caller asks for it.
  const body = block.renderMarkdownEmphasis
    ? markdownEmphasisChildren(block.text, ctx, `${key}-md`)
    : [block.text];

  return h(
    View,
    { key, style: ctx.styles.verbatim },
    h(Text, { style: ctx.styles.verbatimEyebrow }, block.label ?? "Verbatim"),
    h(Text, { style: ctx.styles.verbatimText }, ...body),
    block.attribution
      ? h(Text, { style: ctx.styles.verbatimAttribution }, block.attribution)
      : null,
  );
}

function renderInterpretation(
  block: Extract<PdfBlock, { kind: "interpretation" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  return h(
    View,
    { key, style: ctx.styles.interpretation },
    h(
      Text,
      { style: ctx.styles.interpretationEyebrow },
      block.label ?? "Zypact reading",
    ),
    h(Text, { style: ctx.styles.verbatimText }, block.text),
  );
}

/**
 * Characters that fit on one line of the URL column: about 373 points of
 * width at 7.6pt Courier, whose advance is 0.6 em. Deliberately a little
 * under the true maximum so a rounding error cannot push a line into the
 * status column.
 */
const URL_CHARS_PER_LINE = 76;

/**
 * Hard-wraps a long URL at structural boundaries, using explicit newlines.
 *
 * Every automatic option here is wrong in a way that matters. Hyphenation is
 * off document-wide (see `fonts.ts`), so a URL is one unbreakable token that
 * runs straight through the status column. Turning hyphenation back on, or
 * seeding the string with zero-width spaces, does produce breaks — but
 * react-pdf renders a hyphen at the break, and since a hyphen is a legal URL
 * character the printed address silently becomes a different address
 * (`.../monitoring-best-practices` prints as `.../monitoring-best--` +
 * `practices`). Truncating removes the reader's ability to check the source
 * at all.
 *
 * Choosing the break points here avoids all of it: a newline is a hard break
 * that react-pdf does not decorate, so every visible character is a
 * character of the real URL and no character is added. Breaks are preferred
 * after a path separator or similar boundary, and fall back to a hard cut
 * only for an unbroken run longer than a line. The `Link` target keeps the
 * untouched URL, so the link still resolves.
 */
function wrappableUrl(url: string, perLine = URL_CHARS_PER_LINE): string {
  if (url.length <= perLine) return url;

  const lines: string[] = [];
  let rest = url;

  while (rest.length > perLine) {
    const window = rest.slice(0, perLine);
    // Break AFTER the boundary character so it stays on the line it belongs
    // to, matching how a reader reads a path.
    const boundary = Math.max(
      window.lastIndexOf("/"),
      window.lastIndexOf("-"),
      window.lastIndexOf("_"),
      window.lastIndexOf("."),
      window.lastIndexOf("&"),
      window.lastIndexOf("?"),
    );
    const cut = boundary > perLine * 0.4 ? boundary + 1 : perLine;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest.length > 0) lines.push(rest);
  return lines.join("\n");
}

function renderSource(
  source: PdfSource,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Link, Text, View } = ctx.pdf;
  const presentation = SOURCE_STATUS_PRESENTATION[source.status];
  const httpSuffix =
    source.httpStatus === undefined ? "" : ` · HTTP ${source.httpStatus}`;

  return h(
    View,
    { key, style: ctx.styles.sourceRow, wrap: false },
    h(
      View,
      { style: ctx.styles.sourceMain },
      source.title
        ? h(Text, { style: ctx.styles.sourceTitle }, source.title)
        : null,
      h(
        Link,
        { src: source.url, style: ctx.styles.sourceUrl },
        wrappableUrl(source.url),
      ),
      source.note
        ? h(Text, { style: ctx.styles.sourceNote }, source.note)
        : null,
    ),
    h(
      Text,
      { style: [ctx.styles.sourceStatus, { color: presentation.color }] },
      `${presentation.label}${httpSuffix}`,
    ),
  );
}

function renderSources(
  block: Extract<PdfBlock, { kind: "sources" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  return h(
    View,
    { key, style: { marginBottom: SPACE.md } },
    ...block.items.map((source, index) =>
      renderSource(source, ctx, `${key}-s${index}`),
    ),
    block.caption
      ? h(Text, { style: ctx.styles.caption }, block.caption)
      : null,
  );
}

function renderNote(
  block: Extract<PdfBlock, { kind: "note" }>,
  ctx: BlockContext,
  key: string,
): ReactElement {
  const { Text, View } = ctx.pdf;
  return h(
    View,
    { key, style: ctx.styles.note, wrap: false },
    block.title ? h(Text, { style: ctx.styles.noteTitle }, block.title) : null,
    h(Text, { style: ctx.styles.noteText }, block.text),
  );
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

const SPACER_SIZES = { sm: SPACE.sm, md: SPACE.lg, lg: SPACE.xxl } as const;

export function renderBlock(
  block: PdfBlock,
  ctx: BlockContext,
  key: string,
): ReactElement | null {
  switch (block.kind) {
    case "heading":
      return renderHeading(block, ctx, key);
    case "paragraph":
      return renderParagraph(block, ctx, key);
    case "bullets":
      return renderBullets(block, ctx, key);
    case "keyValues":
      return renderKeyValues(block, ctx, key);
    case "table":
      return renderTable(block, ctx, key);
    case "comparison":
      return renderComparison(block, ctx, key);
    case "verbatim":
      return renderVerbatim(block, ctx, key);
    case "interpretation":
      return renderInterpretation(block, ctx, key);
    case "sources":
      return renderSources(block, ctx, key);
    case "note":
      return renderNote(block, ctx, key);
    case "spacer":
      return h(ctx.pdf.View, {
        key,
        style: { height: SPACER_SIZES[block.size ?? "md"] },
      });
    case "pageBreak":
      return h(ctx.pdf.View, { key, break: true });
    default: {
      // Exhaustiveness: adding a block kind without a renderer is a compile
      // error here rather than a silently missing paragraph in a client PDF.
      const unreachable: never = block;
      return unreachable;
    }
  }
}
