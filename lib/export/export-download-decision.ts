/**
 * M3 reliquat — the client-side counterpart to
 * lib/export/export-gate-response.ts's headers. A browser download
 * button must never trigger a download for a `blocked`/`needs_review`
 * response, even one that returns HTTP 200 with `ok: true`.
 *
 * Pure and framework-free on purpose: this codebase has no DOM/React
 * test harness (no jsdom, no @testing-library), so the decision logic
 * a UI component relies on is kept in a plain function that ordinary
 * Node tests can exercise directly, exactly like every other pure
 * module in this repository. The React component
 * (app/projects/[id]/qa/export-download-button.tsx) only wires this
 * function to `fetch`/DOM APIs — it is not itself unit-tested, the same
 * way route.ts's Next.js framework glue is exercised through
 * lib/export/export-gate-response.ts rather than directly.
 *
 * All three conditions must hold before a download is safe:
 *   - Content-Type is text/markdown (not the JSON blocked/needs_review
 *     shape);
 *   - integrityStatus is exactly "integrity_passed";
 *   - deliverable is exactly true.
 * Reading these from response HEADERS (not the body) is deliberate: a
 * consumer can decide whether it is even safe to read the body as a
 * report before doing so, uniformly, regardless of whether the body
 * turns out to be raw markdown or a JSON status object.
 */

export interface ExportDownloadHeaders {
  contentType: string | null;
  integrityStatus: string | null;
  deliverable: string | null;
}

export type ExportDownloadDecision =
  | { shouldDownload: true }
  | { shouldDownload: false; integrityStatus: string };

export function decideExportDownload(
  headers: ExportDownloadHeaders
): ExportDownloadDecision {
  const isMarkdown = (headers.contentType ?? "")
    .toLowerCase()
    .startsWith("text/markdown");
  const isPassed = headers.integrityStatus === "integrity_passed";
  const isDeliverable = headers.deliverable === "true";

  if (isMarkdown && isPassed && isDeliverable) {
    return { shouldDownload: true };
  }

  return {
    shouldDownload: false,
    integrityStatus: headers.integrityStatus ?? "unknown",
  };
}
