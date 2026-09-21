/**
 * Zypact print brand tokens.
 *
 * Single source of truth for anything a generated PDF draws. The colour
 * values are the SAME ones the web surface uses — they are lifted from
 * `tailwind.config.ts` (`theme.extend.colors.brand` / `.surface`) and from
 * `public/zypact-logo.svg` (the mark's ink). They are duplicated here rather
 * than imported because `tailwind.config.ts` is a build-time config that
 * pulls in `tailwindcss` and `tailwindcss-animate`, both of which are
 * devDependencies and therefore absent from the worker image, which installs
 * with `npm ci --omit=dev`. Importing it from `lib/` would make the worker
 * crash on a dependency it deliberately does not ship.
 *
 * If a brand colour changes in `tailwind.config.ts`, change it here too.
 * `scripts/test-pdf-render.ts` asserts the two stay in step.
 */

/** Brand green scale — `tailwind.config.ts` → `theme.extend.colors.brand`. */
export const BRAND_SCALE = {
  50: "#F2F8F5",
  100: "#E3F0EA",
  200: "#C6E1D5",
  300: "#96C7B2",
  400: "#5FA88C",
  500: "#2F8467",
  600: "#166B51",
  700: "#0E4A38",
  800: "#0A3527",
  900: "#07291E",
  950: "#041B14",
} as const;

/** Neutral surfaces — `tailwind.config.ts` → `theme.extend.colors.surface`. */
export const SURFACE = {
  default: "#FFFFFF",
  subtle: "#FAFBFA",
  muted: "#F5F8F6",
} as const;

/**
 * The ink of the logo mark, taken from `public/zypact-logo.svg`
 * (`stroke="#111827"`). This is the wordmark colour, not the brand green,
 * and the two are deliberately different.
 */
export const LOGO_INK = "#111827";

export const COLORS = {
  /** Primary brand green. Rules, the cover band, section markers. */
  brand: BRAND_SCALE[600],
  brandDeep: BRAND_SCALE[700],
  /** Darkest ink. Cover background and display type. */
  ink: BRAND_SCALE[900],
  logoInk: LOGO_INK,

  /** Body copy. Near-black rather than pure black: pure black prints harsh. */
  text: "#16211D",
  /** Secondary copy, captions, footers. */
  textMuted: "#5A6B64",
  /** Tertiary copy. Only for the least important line on a page. */
  textFaint: "#8A9B94",
  /** Reversed copy on the cover and on any dark fill. */
  textOnDark: "#FFFFFF",
  textOnDarkMuted: "#B7CEC3",

  surface: SURFACE.default,
  surfaceSubtle: SURFACE.subtle,
  surfaceMuted: SURFACE.muted,

  /** Hairlines. Light enough to organise a page without boxing it in. */
  rule: "#DDE6E1",
  ruleStrong: "#C2D1CA",

  /**
   * Status inks for source-verification outcomes. Muted on purpose: a
   * research report is not a dashboard, and a page of saturated red reads as
   * alarm rather than as fact.
   */
  statusPositive: BRAND_SCALE[600],
  statusNegative: "#9A3324",
  statusUnknown: "#8A6D1F",
  statusNeutral: "#5A6B64",
} as const;

/**
 * Type scale, in points. react-pdf's unit is the PDF point (72/inch), so
 * these are real typographic sizes and not CSS pixels.
 */
export const TYPE = {
  coverTitle: 32,
  coverSubtitle: 13,
  h1: 19,
  h2: 13.5,
  h3: 11,
  body: 9.8,
  bodyTight: 9.2,
  small: 8.4,
  caption: 7.6,
  micro: 7,
} as const;

export const LEADING = {
  coverTitle: 1.15,
  heading: 1.25,
  body: 1.55,
  tight: 1.35,
} as const;

/** Vertical rhythm, in points. */
export const SPACE = {
  xs: 3,
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  xxl: 36,
} as const;

/**
 * Page geometry. The margins leave room for the running header and the
 * footer rule without either colliding with body copy.
 */
export const PAGE = {
  marginTop: 58,
  /**
   * Must clear the footer: `footerOffset + footerHeight` measured up from the
   * page edge, plus a gap, or body copy runs into the running footer.
   */
  marginBottom: 70,
  marginHorizontal: 54,
  /** Distance from the page edge to the running header baseline. */
  headerOffset: 28,
  /** Distance from the TOP of the page down to the footer rule. Derived. */
  footerOffset: 32,
  /**
   * Reserved height for the footer block: a hairline rule plus up to two
   * lines of 7pt text. The footer is positioned by an explicit `top`, so it
   * needs a known height to sit the right distance above the page edge.
   */
  footerHeight: 26,
} as const;

/**
 * Page heights in points.
 *
 * Needed because the running footer is positioned with an explicit `top`
 * rather than `bottom`. In react-pdf v4 a `fixed` + `position: "absolute"`
 * element honours `top` but NOT `bottom`: with `bottom` the footer was laid
 * out in document flow instead, landing at y≈5241 on a page 842 points tall
 * — off the canvas on most pages, missing entirely on some, and 8 points
 * from the top on the last one. `top` places it correctly on every page, and
 * computing that `top` needs the page height.
 */
export const PAGE_HEIGHT = {
  A4: 841.89,
  LETTER: 792,
} as const;

/**
 * Logo geometry, copied verbatim from `public/zypact-logo.svg` so the PDF
 * draws the official mark rather than an approximation of it. The viewBox is
 * `0 0 600 200`; the mark itself occupies roughly x 29-159.
 */
export const LOGO = {
  viewBox: { width: 600, height: 200 },
  /** The single stroked Z. `d` is byte-identical to the asset's path. */
  markPath: "M42 48 H142 L46 150 H146",
  markStroke: LOGO_INK,
  markStrokeWidth: 10,
  /** The three white nodes sitting on the Z's vertices. */
  markNodes: [
    { cx: 42, cy: 48, r: 13 },
    { cx: 94, cy: 100, r: 13 },
    { cx: 146, cy: 150, r: 13 },
  ],
  /** Bounding box of the mark alone, used to crop it away from the wordmark. */
  markBox: { minX: 29, minY: 35, width: 130, height: 130 },
  /** The wordmark. There is no second Z — the mark is the Z. */
  wordmark: "ypact",
  wordmarkLetterSpacing: -0.048,
} as const;
