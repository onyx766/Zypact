/**
 * Font resolution for generated PDFs.
 *
 * Inter is the brand face (`tailwind.config.ts` → `fontFamily.sans`), but on
 * the web it arrives from the Google Fonts CDN. A PDF renderer must not do
 * that: the protocol worker is inert by construction and must not reach the
 * network to lay out a document, and a font fetched at render time makes the
 * output depend on someone else's uptime.
 *
 * So this module registers Inter from FILES ON DISK when they are present,
 * and otherwise falls back to Helvetica, which react-pdf has built in and
 * which needs no files at all. A missing font degrades the typography; it
 * never fails the render, and it never changes a number on the page.
 *
 * To vendor Inter, drop the four static TTFs into `assets/fonts/inter/`:
 *
 *   Inter-Regular.ttf  Inter-Medium.ttf  Inter-SemiBold.ttf  Inter-Bold.ttf
 *
 * Inter is licensed SIL OFL 1.1, which permits embedding; commit the
 * accompanying `OFL.txt` alongside the files. `ZYPACT_PDF_FONT_DIR` overrides
 * the directory, which is how a container image can mount them elsewhere.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PdfRuntime } from "./runtime";

export type BrandFontSource = "inter-vendored" | "helvetica-builtin";

export interface ResolvedBrandFont {
  /** The family name to pass to react-pdf styles. */
  family: string;
  /** Which of the two paths above actually happened. */
  source: BrandFontSource;
  /**
   * Human-readable explanation, recorded by callers that keep a render log.
   * Never contains a secret; it names files and directories only.
   */
  detail: string;
}

/** Weight → filename, for the vendored static instances. */
const INTER_FILES: ReadonlyArray<{ weight: 400 | 500 | 600 | 700; file: string }> = [
  { weight: 400, file: "Inter-Regular.ttf" },
  { weight: 500, file: "Inter-Medium.ttf" },
  { weight: 600, file: "Inter-SemiBold.ttf" },
  { weight: 700, file: "Inter-Bold.ttf" },
];

/**
 * Registration mutates process-global state inside react-pdf, so it must
 * happen at most once per process. Memoised rather than guarded by a boolean
 * so concurrent callers all observe the same resolution.
 */
let resolved: ResolvedBrandFont | null = null;

function fontDirectory(): string {
  const override = process.env.ZYPACT_PDF_FONT_DIR;
  if (override && override.trim()) return path.resolve(override.trim());

  // `lib/pdf/fonts.ts` → repository root is two levels up. The package is
  // CommonJS (no `"type"` in package.json) so `__dirname` is normally
  // defined, but this file also ships inside the worker image; if it is ever
  // loaded as an ES module `__dirname` disappears, and a font lookup is not
  // worth a ReferenceError. Fall back to the process cwd in that case.
  const here = typeof __dirname === "undefined" ? null : __dirname;
  const root = here ? path.resolve(here, "..", "..") : process.cwd();
  return path.join(root, "assets", "fonts", "inter");
}

/**
 * react-pdf hyphenates by default, which litters a justified research report
 * with mid-word breaks ("evi-dence"). Returning the word whole disables it.
 * This is a global setting, applied once alongside registration.
 */
function disableHyphenation(pdf: PdfRuntime): void {
  pdf.Font.registerHyphenationCallback((word) => [word]);
}

/**
 * Registers the brand face if its files are on disk, else falls back.
 *
 * Takes the loaded renderer rather than importing it — see `runtime.ts`.
 *
 * Never throws. A font that fails to register is a cosmetic problem, and a
 * cosmetic problem must not take down a report that is otherwise correct.
 */
export function resolveBrandFont(pdf: PdfRuntime): ResolvedBrandFont {
  if (resolved) return resolved;

  disableHyphenation(pdf);

  const dir = fontDirectory();
  const present = INTER_FILES.map((entry) => ({
    ...entry,
    fullPath: path.join(dir, entry.file),
  })).filter((entry) => existsSync(entry.fullPath));

  if (present.length !== INTER_FILES.length) {
    const missing = INTER_FILES.filter(
      (entry) => !present.some((candidate) => candidate.file === entry.file),
    ).map((entry) => entry.file);

    resolved = {
      family: "Helvetica",
      source: "helvetica-builtin",
      detail:
        present.length === 0
          ? `No vendored Inter files in ${dir}; using built-in Helvetica.`
          : `Incomplete Inter set in ${dir} (missing ${missing.join(", ")}); using built-in Helvetica.`,
    };
    return resolved;
  }

  try {
    pdf.Font.register({
      family: "Inter",
      fonts: present.map((entry) => ({
        // A Buffer rather than a path: react-pdf resolves string sources
        // relative to the process cwd on some platforms, and a worker's cwd
        // is not this repository.
        src: readFileSync(entry.fullPath) as unknown as string,
        fontWeight: entry.weight,
      })),
    });

    resolved = {
      family: "Inter",
      source: "inter-vendored",
      detail: `Registered Inter (${present.length} weights) from ${dir}.`,
    };
  } catch (error) {
    resolved = {
      family: "Helvetica",
      source: "helvetica-builtin",
      detail: `Inter registration failed (${
        error instanceof Error ? error.message : "unknown error"
      }); using built-in Helvetica.`,
    };
  }

  return resolved;
}

/**
 * Test seam. Clears the memo so a test can exercise both branches in one
 * process. Not for production callers.
 */
export function resetBrandFontForTests(): void {
  resolved = null;
}
