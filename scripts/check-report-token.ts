#!/usr/bin/env tsx
/**
 * Read-only diagnostic for a 404 on `/report/[secureToken]`.
 *
 * Reproduces the exact gates `app/report/[secureToken]/page.tsx` applies
 * (format check, row lookup, client-readability check) so it's possible to
 * tell whether a token 404s because no row matches it or because the row
 * exists but isn't delivered/passed integrity yet. Never prints report
 * content, the token itself, or any other client-identifying evidence.
 *
 * Usage:
 *   npx tsx scripts/check-report-token.ts <secureToken>
 */

// `dotenv/config` alone reads `.env` and NOTHING else, so a key that lives in
// `.env.local` — where Next.js looks — is invisible to a bare tsx run. Load
// them explicitly, in Next.js precedence order: a variable already exported
// in the shell wins, then `.env.local`, then `.env`. `config()` never
// overwrites a value already present, so listing `.env.local` first is what
// makes it win.
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: ".env.local" });
loadEnvFile();

import { getDb } from "@/lib/db";
import { isValidPublicReportToken } from "@/lib/snapshot-requests/public-report-token";

async function main(): Promise<void> {
  const token = process.argv[2]?.trim();
  if (!token) {
    console.error("Usage: npx tsx scripts/check-report-token.ts <secureToken>");
    process.exit(2);
  }

  console.log("check-report-token");
  console.log("───────────────────");

  const validFormat = isValidPublicReportToken(token);
  console.log(`format check          : ${validFormat ? "PASS" : "FAIL (would 404 at the route's format gate)"}`);
  if (!validFormat) {
    console.log("\nVERDICT: WOULD 404 — token fails the route's own format check.");
    return;
  }

  const artifact = await getDb().getSnapshotReportArtifactByPublicToken(token);
  if (!artifact) {
    console.log("row lookup            : NO MATCHING ROW in snapshot_report_artifacts");
    console.log(
      "\nVERDICT: WOULD 404 — no row matches this token. Either the token is " +
        "wrong/stale, or this environment's Supabase project is not the one " +
        "the report was written to."
    );
    return;
  }

  console.log("row lookup            : MATCH");
  console.log(`id                     : ${artifact.id}`);
  console.log(`snapshotRequestId      : ${artifact.snapshotRequestId}`);
  console.log(`projectId              : ${artifact.projectId}`);
  console.log(`integrityStatus        : ${artifact.integrityStatus ?? "null"}`);
  console.log(`integrityReasons       : ${artifact.integrityReasons?.join("; ") ?? "none"}`);
  console.log(`deliveredAt            : ${artifact.deliveredAt ?? "null"}`);
  console.log(`deliveryClaimActive    : ${artifact.deliveryClaimActive}`);
  console.log(`deliveryClaimedAt      : ${artifact.deliveryClaimedAt ?? "null"}`);
  console.log(`generatedAt            : ${artifact.generatedAt}`);
  console.log(`createdAt              : ${artifact.createdAt}`);
  console.log(`updatedAt              : ${artifact.updatedAt}`);

  // Mirrors app/report/[secureToken]/page.tsx's readability gate exactly.
  const status = artifact.integrityStatus ?? null;
  const delivered = artifact.deliveredAt !== null;
  const readable = status !== "blocked" && (status === "integrity_passed" || delivered);

  console.log("");
  if (readable) {
    console.log("VERDICT: WOULD RENDER — this token should not 404.");
    return;
  }

  if (status === "blocked") {
    console.log("VERDICT: WOULD 404 — integrity_status is 'blocked' (never delivered by design).");
  } else if (status === "needs_review" && !delivered) {
    console.log("VERDICT: WOULD 404 — integrity_status is 'needs_review' and not yet delivered (awaiting founder review).");
  } else {
    console.log("VERDICT: WOULD 404 — legacy artifact (null integrity_status) not yet delivered.");
  }
}

main().catch((error) => {
  console.error("ERROR", error instanceof Error ? error.message : error);
  process.exit(1);
});
