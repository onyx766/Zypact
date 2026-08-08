import { createHash } from "node:crypto";

/**
 * Canonical revision of a stored snapshot report artifact.
 *
 * Must stay byte-identical to `public.snapshot_report_artifact_revision` in
 * migration 0035 — the founder previews a revision computed here and the
 * database re-checks it inside a locked transaction, so any divergence would
 * either block every legitimate replacement or, worse, let a stale one
 * through.
 *
 * Hash-of-hashes rather than concatenated markdown: hashing each field first
 * fixes the boundary, so no pair of report bodies can collide by moving text
 * across the join.
 */
export function snapshotReportArtifactRevision(
  fullReportMarkdown: string,
  shortReportMarkdown: string
): string {
  const innerFull = createHash("sha256")
    .update(Buffer.from(fullReportMarkdown, "utf8"))
    .digest();
  const innerShort = createHash("sha256")
    .update(Buffer.from(shortReportMarkdown, "utf8"))
    .digest();

  return createHash("sha256")
    .update(Buffer.concat([innerFull, innerShort]))
    .digest("hex");
}
