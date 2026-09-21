/**
 * The Zypact logo, drawn for PDF.
 *
 * This is the OFFICIAL mark, not a substitute: the path data, the three node
 * circles, their radii and the wordmark all come from `public/zypact-logo.svg`
 * by way of `brand.ts`. Nothing here is redrawn by eye.
 *
 * The asset is reproduced in two parts because the source SVG uses an SVG
 * `<text>` element for the wordmark, and text inside react-pdf's `Svg` does
 * not honour letter-spacing or a registered family the way a normal `Text`
 * does. So the Z mark is rendered as true vector geometry and the wordmark as
 * ordinary PDF text, with the proportions and the optical gap taken from the
 * source viewBox. The result is selectable, searchable text next to a crisp
 * resolution-independent mark, which is better than either an image of the
 * logo or an SVG whose spacing has drifted.
 *
 * Two tones are supported. `dark` is the asset's own ink (#111827), for use
 * on white. `light` is the same geometry reversed out for the dark cover; the
 * cover is a brand surface, and reversing a monochrome mark is a tonal
 * variant of the official asset rather than a different logo.
 */

import { createElement as h, type ReactElement } from "react";

import { COLORS, LOGO } from "./brand";
import type { PdfRuntime } from "./runtime";

export type LogoTone = "dark" | "light";

export interface BrandLogoOptions {
  /**
   * The loaded renderer module. Passed in rather than imported: see
   * `runtime.ts` for why nothing here may statically import it.
   */
  pdf: PdfRuntime;
  /** Height of the Z mark in points. The wordmark scales with it. */
  height?: number;
  tone?: LogoTone;
  /** Family for the wordmark. Pass the family resolved by `fonts.ts`. */
  fontFamily: string;
}

/*
 * Ratios derived from the source viewBox (0 0 600 200), where the mark's box
 * is 130 units tall:
 *   wordmark cap size   105 / 130
 *   gap to wordmark      25 / 130   (mark right edge 159 → text start 184)
 * Both the mark box and the wordmark are optically centred on y = 100 in the
 * source, so a row with `alignItems: "center"` reproduces the asset's
 * baseline relationship without hand-nudging.
 */
const WORDMARK_SIZE_RATIO = 105 / 130;
const WORDMARK_GAP_RATIO = 25 / 130;

/** Node fill: white on light backgrounds, the cover ink on dark ones. */
function nodeFill(tone: LogoTone): string {
  return tone === "light" ? COLORS.ink : "#FFFFFF";
}

function strokeColor(tone: LogoTone): string {
  return tone === "light" ? COLORS.textOnDark : LOGO.markStroke;
}

/** The Z mark alone, as vector geometry. */
export function brandMark(options: BrandLogoOptions): ReactElement {
  const { Circle, Path, Svg } = options.pdf;
  const height = options.height ?? 22;
  const tone = options.tone ?? "dark";
  const { markBox } = LOGO;
  const width = (markBox.width / markBox.height) * height;

  return h(
    Svg,
    {
      width,
      height,
      viewBox: `${markBox.minX} ${markBox.minY} ${markBox.width} ${markBox.height}`,
    },
    h(Path, {
      d: LOGO.markPath,
      fill: "none",
      stroke: strokeColor(tone),
      strokeWidth: LOGO.markStrokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
    ...LOGO.markNodes.map((node, index) =>
      h(Circle, {
        key: `node-${index}`,
        cx: node.cx,
        cy: node.cy,
        r: node.r,
        fill: nodeFill(tone),
        stroke: strokeColor(tone),
        strokeWidth: LOGO.markStrokeWidth,
      }),
    ),
  );
}

/** The full lockup: the Z mark followed by the "ypact" wordmark. */
export function brandLogo(options: BrandLogoOptions): ReactElement {
  const { Text, View } = options.pdf;
  const height = options.height ?? 22;
  const tone = options.tone ?? "dark";
  const wordmarkSize = height * WORDMARK_SIZE_RATIO;

  return h(
    View,
    { style: { flexDirection: "row", alignItems: "center" } },
    brandMark(options),
    h(
      Text,
      {
        style: {
          fontFamily: options.fontFamily,
          fontWeight: 700,
          fontSize: wordmarkSize,
          letterSpacing: wordmarkSize * LOGO.wordmarkLetterSpacing,
          color: tone === "light" ? COLORS.textOnDark : LOGO.markStroke,
          marginLeft: height * WORDMARK_GAP_RATIO,
        },
      },
      LOGO.wordmark,
    ),
  );
}
