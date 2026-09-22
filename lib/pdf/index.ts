/**
 * Public surface of the Zypact PDF layer.
 *
 * Callers should import from here rather than reaching into the individual
 * modules, so the internals (styles, block dispatch, logo geometry) stay free
 * to change without breaking a report.
 *
 * Scope note. This module renders documents; it does not decide whether a
 * document may be sent. Delivery gating — `integrity_passed` delivering
 * automatically, `needs_review` requiring founder review, `blocked` never
 * delivering — lives in the report delivery path and is deliberately not
 * duplicated here. Producing bytes is not authorisation to send them.
 *
 * Runtime note. Nothing under `lib/pdf/` statically imports
 * `@react-pdf/renderer`; it is loaded on demand by `runtime.ts`. That is a
 * hard requirement, not a preference — see the comment there. Importing this
 * barrel does not load the renderer, so a module that only needs the types
 * or the brand tokens pays nothing.
 */

export { BRAND_SCALE, COLORS, LOGO, PAGE, SPACE, SURFACE, TYPE } from "./brand";

export type {
  PdfBlock,
  PdfComparisonColumn,
  PdfDocumentProblem,
  PdfKeyValue,
  PdfPageSize,
  PdfReportDocument,
  PdfReportMeta,
  PdfSection,
  PdfSource,
  PdfSourceStatus,
  PdfTableColumn,
} from "./document";

export { validateReportDocument } from "./document";

export { sourceStatusLabel } from "./blocks";

export { brandLogo, brandMark, type BrandLogoOptions, type LogoTone } from "./logo";

export {
  resolveBrandFont,
  resetBrandFontForTests,
  type BrandFontSource,
  type ResolvedBrandFont,
} from "./fonts";

export {
  loadPdfRuntime,
  resetPdfRuntimeForTests,
  type PdfRuntime,
} from "./runtime";

export {
  PdfDocumentInvalidError,
  formatUtcDate,
  renderReportPdf,
  renderReportPdfBytes,
  type RenderReportResult,
} from "./render";
