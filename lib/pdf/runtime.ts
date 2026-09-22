/**
 * Loads `@react-pdf/renderer` at call time rather than at module load.
 *
 * This is not a lazy-loading optimisation. It is required for the library to
 * run in the protocol worker at all.
 *
 * `@react-pdf/renderer` v4 depends on `@react-pdf/hyphenate`, which is pure
 * ESM (`"type": "module"`) and whose `exports` map declares only an `import`
 * condition for its language subpaths — there is no `require` condition. Node
 * resolves that correctly on its own, but this repository runs TypeScript
 * through `tsx`, and the worker's entrypoint is literally
 * `node --import tsx scripts/run-protocol-worker.ts`. Under tsx's CommonJS
 * resolver a static `import` of the renderer becomes a `require`, which walks
 * into that subpath and dies with:
 *
 *   ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './en-us' is not defined
 *   by "exports" in @react-pdf/hyphenate/package.json
 *
 * A dynamic `import()` is preserved as a real ESM import by tsx, so the
 * package resolves through the `import` condition and loads. Verified under
 * `tsx`, under `node --import tsx`, and under the Next.js build.
 *
 * The practical rule for this directory: NOTHING under `lib/pdf/` may
 * statically import `@react-pdf/renderer`. Type-only imports are fine —
 * they are erased before they reach Node — which is why `styles.ts` can name
 * `Style` from `@react-pdf/types` without loading anything.
 */

/**
 * The renderer module's shape. A type-only reference: `typeof import(...)`
 * is erased at compile time and never becomes a require.
 */
export type PdfRuntime = typeof import("@react-pdf/renderer");

let cached: Promise<PdfRuntime> | null = null;

/**
 * Returns the renderer module, loading it once per process.
 *
 * The PROMISE is cached rather than the resolved module, so concurrent
 * callers share one load instead of racing to start several.
 */
export function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!cached) {
    cached = import("@react-pdf/renderer").then((loaded) => {
      // `@react-pdf/renderer` declares `export = ReactPDF`. Depending on how
      // the importing module was compiled, the namespace can arrive either
      // directly or wrapped in `default`. Accept both rather than assuming.
      const candidate = loaded as PdfRuntime & { default?: PdfRuntime };
      const runtime =
        typeof candidate.renderToBuffer === "function"
          ? candidate
          : candidate.default;

      if (!runtime || typeof runtime.renderToBuffer !== "function") {
        throw new Error(
          "@react-pdf/renderer loaded but does not expose renderToBuffer; the package layout has changed.",
        );
      }

      return runtime;
    });
  }

  return cached;
}

/** Test seam. Drops the cached module so a test can force a reload. */
export function resetPdfRuntimeForTests(): void {
  cached = null;
}
