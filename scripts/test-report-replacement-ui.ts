#!/usr/bin/env tsx
/**
 * Founder replacement UI decision logic — executable.
 *
 * The panel's security-relevant choices (when replacement is offered, what the
 * request body carries, what each server response means) live in pure
 * functions so they can be driven directly rather than asserted by reading
 * JSX. B1a's review established that source-pattern assertions hide real
 * defects.
 *
 * None of this is the security boundary — 0035 fencing is. These tests check
 * the founder is not invited into an action the database will refuse, and that
 * no failure path ever retries.
 */
import {
  buildReplacePayload,
  classifyReplaceResponse,
  replacementAvailability,
  shouldRetryAutomatically,
} from "@/lib/snapshot-requests/report-replacement-ui";
import { toSnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";
import type { SnapshotReportArtifact } from "@/lib/db/types";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const ART = "6c1c1f7e-6a2f-4d2e-9d1a-0d0a7f5b2e11";
const REQ = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

function artifact(over: Partial<SnapshotReportArtifact> = {}): SnapshotReportArtifact {
  return {
    id: ART, snapshotRequestId: REQ, projectId: "p",
    fullReportMarkdown: "# Full A", shortReportMarkdown: "# Short A",
    fullReportFilename: "f.md", shortReportFilename: "s.md",
    generatedAt: "2026-01-01T00:00:00Z", publicToken: "t".repeat(43),
    deliveryClaimActive: false, deliveryClaimedAt: null,
    deliveredAt: null, deliveryMessageId: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

console.log("test-report-replacement-ui");

/* ---- U1-U3 availability ---- */
{
  const undelivered = toSnapshotReportPublicationState(artifact());
  check("U1 undelivered + unclaimed → replace offered",
    replacementAvailability(undelivered).canReplace === true);

  const claimed = toSnapshotReportPublicationState(
    artifact({ deliveryClaimActive: true, deliveryClaimedAt: "2026-01-02T00:00:00Z" })
  );
  const c = replacementAvailability(claimed);
  check("U2 active claim → replace withheld", c.canReplace === false);
  check("U2b claim reason surfaced as lock, not failure",
    !c.canReplace && c.reason === "claimed" && /locked/i.test(c.message));

  const delivered = toSnapshotReportPublicationState(
    artifact({ deliveredAt: "2026-01-03T00:00:00Z", deliveryMessageId: "m" })
  );
  const d = replacementAvailability(delivered);
  check("U3 delivered → replace withheld", d.canReplace === false);
  check("U3b delivered reason is final, not retryable",
    !d.canReplace && d.reason === "delivered");

  // A delivered artifact that also carries a stale claim must read as
  // delivered — the stronger, final condition.
  const both = toSnapshotReportPublicationState(
    artifact({ deliveredAt: "2026-01-03T00:00:00Z", deliveryClaimActive: true })
  );
  const b = replacementAvailability(both);
  check("U3c delivered wins over claimed", !b.canReplace && b.reason === "delivered");
}

/* ---- U4 / §21 exact request payload ---- */
{
  const state = toSnapshotReportPublicationState(artifact());
  const payload = buildReplacePayload(state, {
    fullReportMarkdown: "# Full B", shortReportMarkdown: "# Short B",
  });
  check("U4 payload fences on the loaded artifact id", payload.expectedArtifactId === ART);
  check("U4b payload fences on the loaded revision", payload.expectedRevision === state.revision);
  check("U4c payload carries the edited Full and Short",
    payload.fullReportMarkdown === "# Full B" && payload.shortReportMarkdown === "# Short B");
  check("U4d payload carries exactly the four declared fields",
    Object.keys(payload).length === 4);
  const serialized = JSON.stringify(payload).toLowerCase();
  check("U11 no claim token in the request body",
    !serialized.includes("token") && !serialized.includes("claim"));
  check("U11b no delivery message id or service metadata",
    !serialized.includes("messageid") && !serialized.includes("service"));
  // The revision must be the loaded one, not recomputed from the edits — that
  // is what makes the server able to detect a concurrent replacement.
  const edited = toSnapshotReportPublicationState(
    artifact({ fullReportMarkdown: "# Full B", shortReportMarkdown: "# Short B" })
  );
  check("U4e fences on the REVIEWED revision, not the edited content's",
    payload.expectedRevision !== edited.revision);
}

/* ---- U5-U10 response classification ---- */
{
  check("U5 2xx → success", classifyReplaceResponse(200, {}).kind === "success");
  const stale = classifyReplaceResponse(409, { error: "conflict" });
  check("U7 409 → stale", stale.kind === "stale");
  check("U7b stale message tells founder to refresh",
    stale.kind === "stale" && /refresh/i.test(stale.message));

  const failed = classifyReplaceResponse(500, { error: "internal_error" });
  check("U9 5xx → failure, NOT stale conflict", failed.kind === "failed");
  check("U9b failure message does not claim the report changed",
    failed.kind === "failed" && !/changed or became locked/i.test(failed.message));

  const applied = classifyReplaceResponse(500, { error: "replacement_applied_reload_failed" });
  check("U10 post-write reload failure is its own outcome",
    applied.kind === "applied_reload_failed");
  check("U10b it warns the write landed and forbids replacing again",
    applied.kind === "applied_reload_failed" && /do not replace again/i.test(applied.message));

  check("U8 no automatic retry for any outcome", shouldRetryAutomatically() === false);
  for (const s of [409, 500, 502, 503]) {
    check(`U8b status ${s} never classifies as success`,
      classifyReplaceResponse(s, {}).kind !== "success");
  }
}

/* ---- supplemental static checks on the panel (clearly separated) ---- */
{
  const fs = require("node:fs");
  const panel = fs.readFileSync("app/admin/snapshot-requests/replace-report-panel.tsx", "utf8");
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("static: posts to the founder server route, not Supabase",
    /replace-report/.test(code) && !/supabase|createClient|\.rpc\(/i.test(code));
  check("U6/§22: no provider or send import in the replacement path",
    !/resend|report-delivery|send-report|sendClientSnapshotReport/i.test(code));
  check("U6b: success does not invoke send", !/sendReport\(|SendReportButton/.test(code));
  check("§26: no force-unlock or release UI",
    !/force|unlock|releaseSnapshotReportDeliveryClaim/i.test(code));
  check("§26b: no age-based claim logic",
    !/claimedAt\s*[<>]|Date\.now\(\)|setTimeout/.test(code));
  check("§26c: no automatic retry construct",
    !/(for|while)\s*\(|attempt\s*\+\+/.test(code));
  check("§17: raw claim token never referenced",
    !/deliveryClaimToken|delivery_claim_token/.test(code));
  check("U12: Cancel only clears local state",
    /setEditing\(false\)/.test(code) && !/Cancel[\s\S]{0,200}fetch\(/.test(code));
  check("U13: one confirm gate before the single fetch",
    (code.match(/window\.confirm/g) ?? []).length === 1 &&
    (code.match(/await fetch\(/g) ?? []).length === 1);
  check("confirmation states the report will not be auto-sent",
    /NOT be sent automatically/.test(panel));
  check("success refreshes authoritative state via the server",
    /router\.refresh\(\)/.test(code));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
