/**
 * Stylesheet for generated PDFs.
 *
 * Built as a FUNCTION of the resolved font family rather than as a static
 * sheet, because which family is available is only known at render time
 * (see `fonts.ts`): Inter when its files are vendored, Helvetica when they
 * are not. Everything else is fixed by `brand.ts`.
 *
 * The monospaced treatment uses Courier, which react-pdf has built in. It is
 * reserved for values that must be compared character by character — SHA-256
 * digests, provider request ids, model names, URLs — where a proportional
 * face makes a transposed character invisible.
 *
 * `StyleSheet.create` is deliberately not used. In react-pdf it is typed as
 * `<T extends Styles>(styles: T) => T` — identity, with no normalisation —
 * so calling it would buy nothing and would force a RUNTIME import of
 * `@react-pdf/renderer` into this module. That import is exactly what
 * `runtime.ts` exists to avoid. The `Style` type below comes from
 * `@react-pdf/types` as a type-only import, which is erased before it
 * reaches Node.
 */

import type { Style } from "@react-pdf/types";

import { BRAND_SCALE, COLORS, LEADING, PAGE, PAGE_HEIGHT, SPACE, TYPE } from "./brand";

import type { PdfPageSize } from "./document";

export const MONO_FAMILY = "Courier";

/**
 * Identity, but it constrains every value to `Style` while preserving the
 * literal key names for callers. That is what `StyleSheet.create` does, minus
 * the runtime import — and it type-checks the sheet, which `StyleSheet.create`
 * would do only at the point of use.
 */
function sheet<T extends Record<string, Style>>(styles: T): T {
  return styles;
}

export function createStyles(
  fontFamily: string,
  pageSize: PdfPageSize = "A4",
) {
  /*
   * The footer is pinned with `top`, not `bottom` — see PAGE_HEIGHT in
   * brand.ts for why `bottom` cannot be used here.
   */
  const footerTop =
    PAGE_HEIGHT[pageSize] - PAGE.footerOffset - PAGE.footerHeight;

  return sheet({
    /* ---------------------------------------------------------- pages */
    coverPage: {
      fontFamily,
      backgroundColor: COLORS.ink,
      color: COLORS.textOnDark,
      paddingTop: 64,
      paddingBottom: 56,
      paddingHorizontal: PAGE.marginHorizontal,
      flexDirection: "column",
      justifyContent: "space-between",
    },
    contentPage: {
      fontFamily,
      backgroundColor: COLORS.surface,
      color: COLORS.text,
      paddingTop: PAGE.marginTop,
      paddingBottom: PAGE.marginBottom,
      paddingHorizontal: PAGE.marginHorizontal,
      fontSize: TYPE.body,
      lineHeight: LEADING.body,
    },

    /* ---------------------------------------------------------- cover */
    coverTop: { flexDirection: "column" },
    coverLogoRow: { flexDirection: "row", alignItems: "center" },
    coverRule: {
      marginTop: SPACE.xl,
      width: 56,
      height: 2.5,
      backgroundColor: COLORS.brand,
    },
    coverTitle: {
      marginTop: SPACE.xl,
      fontSize: TYPE.coverTitle,
      fontWeight: 700,
      lineHeight: LEADING.coverTitle,
      letterSpacing: -0.8,
      color: COLORS.textOnDark,
      maxWidth: "88%",
    },
    coverSubtitle: {
      marginTop: SPACE.md,
      fontSize: TYPE.coverSubtitle,
      lineHeight: LEADING.tight,
      color: COLORS.textOnDarkMuted,
      maxWidth: "78%",
    },
    coverMetaGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      marginTop: SPACE.xxl,
    },
    coverMetaCell: { width: "50%", marginBottom: SPACE.lg, paddingRight: SPACE.lg },
    coverMetaLabel: {
      fontSize: TYPE.micro,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: BRAND_SCALE[300],
      marginBottom: 3,
    },
    coverMetaValue: {
      fontSize: TYPE.small,
      color: COLORS.textOnDark,
      lineHeight: LEADING.tight,
    },
    coverBottom: { flexDirection: "column" },
    coverBottomRule: {
      height: 0.75,
      backgroundColor: "#1C4234",
      marginBottom: SPACE.md,
    },
    coverMethodology: {
      fontSize: TYPE.caption,
      lineHeight: LEADING.tight,
      color: COLORS.textOnDarkMuted,
    },
    coverConfidentiality: {
      marginTop: SPACE.xs,
      fontSize: TYPE.caption,
      color: "#7FA292",
    },

    /* -------------------------------------------------- running frame */
    runningHeader: {
      position: "absolute",
      top: PAGE.headerOffset,
      left: PAGE.marginHorizontal,
      right: PAGE.marginHorizontal,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    runningHeaderText: {
      fontSize: TYPE.micro,
      color: COLORS.textFaint,
      letterSpacing: 0.4,
    },
    footer: {
      position: "absolute",
      top: footerTop,
      left: PAGE.marginHorizontal,
      right: PAGE.marginHorizontal,
      height: PAGE.footerHeight,
    },
    footerRule: { height: 0.75, backgroundColor: COLORS.rule, marginBottom: 6 },
    footerRow: { flexDirection: "row", justifyContent: "space-between" },
    footerText: {
      fontSize: TYPE.micro,
      color: COLORS.textFaint,
      lineHeight: LEADING.tight,
      maxWidth: "82%",
    },
    footerPage: { fontSize: TYPE.micro, color: COLORS.textMuted },

    /* ------------------------------------------------------- sections */
    sectionHeader: { marginBottom: SPACE.md },
    sectionTitle: {
      fontSize: TYPE.h1,
      fontWeight: 700,
      letterSpacing: -0.35,
      color: COLORS.ink,
      lineHeight: LEADING.heading,
    },
    sectionRule: {
      marginTop: SPACE.sm,
      width: 34,
      height: 2,
      backgroundColor: COLORS.brand,
    },
    sectionStandfirst: {
      marginTop: SPACE.md,
      fontSize: TYPE.bodyTight,
      lineHeight: LEADING.body,
      color: COLORS.textMuted,
    },
    sectionBody: { marginTop: SPACE.md },

    /* --------------------------------------------------------- blocks */
    h2: {
      marginTop: SPACE.lg,
      marginBottom: SPACE.sm,
      fontSize: TYPE.h2,
      fontWeight: 600,
      color: COLORS.ink,
      lineHeight: LEADING.heading,
    },
    h3: {
      marginTop: SPACE.md,
      marginBottom: SPACE.xs,
      fontSize: TYPE.h3,
      fontWeight: 600,
      color: COLORS.brandDeep,
      lineHeight: LEADING.heading,
      letterSpacing: 0.1,
    },
    paragraph: { marginBottom: SPACE.sm, fontSize: TYPE.body, lineHeight: LEADING.body },
    paragraphLead: {
      marginBottom: SPACE.md,
      fontSize: TYPE.h3,
      lineHeight: LEADING.body,
      color: COLORS.ink,
    },
    paragraphMuted: {
      marginBottom: SPACE.sm,
      fontSize: TYPE.bodyTight,
      lineHeight: LEADING.body,
      color: COLORS.textMuted,
    },

    bulletRow: { flexDirection: "row", marginBottom: SPACE.xs, paddingRight: SPACE.sm },
    bulletMarker: {
      width: 16,
      fontSize: TYPE.body,
      color: COLORS.brand,
      lineHeight: LEADING.body,
    },
    bulletText: { flex: 1, fontSize: TYPE.body, lineHeight: LEADING.body },

    /* ----------------------------------------------------- key/values */
    kvGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: SPACE.sm },
    // The bottom margin does the grouping work: without it a value sits
    // directly under the next pair's label and the two read as one field.
    kvCellHalf: { width: "50%", paddingRight: SPACE.lg, marginBottom: SPACE.md },
    kvCellFull: { width: "100%", marginBottom: SPACE.md },
    kvLabel: {
      fontSize: TYPE.micro,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      color: COLORS.textFaint,
      marginBottom: 2,
    },
    kvValue: { fontSize: TYPE.bodyTight, lineHeight: LEADING.tight, color: COLORS.text },
    kvValueMono: {
      fontFamily: MONO_FAMILY,
      fontSize: TYPE.caption,
      lineHeight: LEADING.tight,
      color: COLORS.text,
    },

    /* ---------------------------------------------------------- table */
    table: { marginBottom: SPACE.md },
    tableHeadRow: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: COLORS.ruleStrong,
      paddingBottom: 5,
    },
    tableHeadCell: {
      fontSize: TYPE.micro,
      letterSpacing: 0.7,
      textTransform: "uppercase",
      color: COLORS.textMuted,
      fontWeight: 600,
      paddingRight: SPACE.sm,
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.75,
      borderBottomColor: COLORS.rule,
      paddingVertical: 5,
    },
    tableCell: {
      fontSize: TYPE.small,
      lineHeight: LEADING.tight,
      paddingRight: SPACE.sm,
      color: COLORS.text,
    },
    tableCellMono: {
      fontFamily: MONO_FAMILY,
      fontSize: TYPE.caption,
      lineHeight: LEADING.tight,
      paddingRight: SPACE.sm,
      color: COLORS.text,
    },
    caption: {
      marginTop: SPACE.xs,
      // A caption belongs to the block ABOVE it, so it needs clear air
      // beneath or it reads as a standfirst for whatever follows.
      marginBottom: SPACE.lg,
      fontSize: TYPE.caption,
      color: COLORS.textFaint,
      lineHeight: LEADING.tight,
    },

    /* ----------------------------------------------------- comparison */
    comparisonRow: { flexDirection: "row", marginBottom: SPACE.sm },
    comparisonCol: { width: "50%" },
    comparisonColLeft: { paddingRight: SPACE.md },
    comparisonColRight: {
      paddingLeft: SPACE.md,
      borderLeftWidth: 0.75,
      borderLeftColor: COLORS.rule,
    },
    comparisonLabel: {
      fontSize: TYPE.micro,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      color: COLORS.brand,
      fontWeight: 600,
      // No bottom margin: the band it sits in supplies the spacing, and
      // doubling the two pushes the headline figure out of alignment.
      marginBottom: 0,
    },
    comparisonHighlight: {
      fontSize: 21,
      fontWeight: 700,
      color: COLORS.ink,
      lineHeight: 1.1,
      letterSpacing: -0.4,
    },
    comparisonHighlightCaption: {
      fontSize: TYPE.caption,
      color: COLORS.textMuted,
      marginTop: 2,
      lineHeight: LEADING.tight,
    },

    /* ------------------------------------------- verbatim / reading */
    verbatim: {
      marginBottom: SPACE.md,
      paddingLeft: SPACE.md,
      borderLeftWidth: 2,
      borderLeftColor: COLORS.brand,
    },
    verbatimEyebrow: {
      fontSize: TYPE.micro,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: COLORS.brand,
      fontWeight: 600,
      marginBottom: 4,
    },
    verbatimText: {
      fontSize: TYPE.bodyTight,
      lineHeight: LEADING.body,
      color: COLORS.text,
    },
    verbatimAttribution: {
      marginTop: 5,
      fontSize: TYPE.caption,
      color: COLORS.textFaint,
    },
    interpretation: {
      marginBottom: SPACE.md,
      paddingLeft: SPACE.md,
      borderLeftWidth: 2,
      borderLeftColor: COLORS.ruleStrong,
    },
    interpretationEyebrow: {
      fontSize: TYPE.micro,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: COLORS.textMuted,
      fontWeight: 600,
      marginBottom: 4,
    },

    /* --------------------------------------------------------- sources */
    sourceRow: {
      flexDirection: "row",
      borderBottomWidth: 0.75,
      borderBottomColor: COLORS.rule,
      paddingVertical: 6,
    },
    sourceMain: { flex: 1, paddingRight: SPACE.md },
    sourceTitle: {
      fontSize: TYPE.small,
      color: COLORS.text,
      lineHeight: LEADING.tight,
      marginBottom: 2,
    },
    sourceUrl: {
      fontFamily: MONO_FAMILY,
      fontSize: TYPE.caption,
      color: COLORS.textMuted,
      lineHeight: LEADING.tight,
      textDecoration: "none",
    },
    sourceNote: {
      fontSize: TYPE.caption,
      color: COLORS.textFaint,
      lineHeight: LEADING.tight,
      marginTop: 2,
    },
    sourceStatus: {
      width: 104,
      fontSize: TYPE.caption,
      lineHeight: LEADING.tight,
      textAlign: "right",
    },

    /* ----------------------------------------------------------- note */
    note: {
      marginBottom: SPACE.md,
      paddingTop: SPACE.sm,
      paddingBottom: SPACE.sm,
      borderTopWidth: 0.75,
      borderTopColor: COLORS.ruleStrong,
      borderBottomWidth: 0.75,
      borderBottomColor: COLORS.ruleStrong,
    },
    noteTitle: {
      fontSize: TYPE.micro,
      letterSpacing: 0.9,
      textTransform: "uppercase",
      color: COLORS.textMuted,
      fontWeight: 600,
      marginBottom: 3,
    },
    noteText: {
      fontSize: TYPE.small,
      lineHeight: LEADING.body,
      color: COLORS.textMuted,
    },
  });
}

export type PdfStyles = ReturnType<typeof createStyles>;
