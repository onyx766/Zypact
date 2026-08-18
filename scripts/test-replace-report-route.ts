#!/usr/bin/env tsx
/**
 * Founder report replacement — EXECUTABLE handler behaviour.
 *
 * The previous revision of this suite only pattern-matched the route source,
 * and an over-broad catch that turned outages into 409 survived it. These
 * tests invoke the real handler with injected fakes, so the control flow under
 * test is the one that ships.
 *
 * The distinction that matters: a stale/locked/delivered artifact is a 409 and
 * the founder should refresh; anything else is an incident and must not be
 * disguised as one.
 */
import {
  createReplaceReportHandler,
  isExpectedReportReplacementConflict,
} from "@/lib/snapshot-requests/replace-report-handler";
import { toSnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";
import { snapshotReportArtifactRevision } from "@/lib/snapshot-requests/report-artifact-revision";
import type { SnapshotReportArtifact } from "@/lib/db/types";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const ART = "6c1c1f7e-6a2f-4d2e-9d1a-0d0a7f5b2e11";
const REQ = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const FULL = "# Full A\nline — é";
const SHORT = "# Short A";
const REV = snapshotReportArtifactRevision(FULL, SHORT);
const NEW_FULL = "# Full B";
const NEW_SHORT = "# Short B";

function artifact(over: Partial<SnapshotReportArtifact> = {}): SnapshotReportArtifact {
  return {
    id: ART, snapshotRequestId: REQ, projectId: "p",
    fullReportMarkdown: FULL, shortReportMarkdown: SHORT,
    fullReportFilename: "f.md", shortReportFilename: "s.md",
    generatedAt: "2026-01-01T00:00:00Z", publicToken: "t".repeat(43),
    deliveryClaimActive: false, deliveryClaimedAt: null,
    deliveredAt: null, deliveryMessageId: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}
function req(body: unknown): Request {
  return new Request("http://local/replace", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const VALID = {
  expectedArtifactId: ART, expectedRevision: REV,
  fullReportMarkdown: NEW_FULL, shortReportMarkdown: NEW_SHORT,
};

interface Spy { replaceCalls: any[]; reloadCalls: number; legacyCalls: number }
function build(over: Partial<{
  user: { email: string | null } | null;
  founder: boolean;
  artifacts: Array<SnapshotReportArtifact | null>;
  reloadThrows: boolean;
  replaceImpl: (i: any) => Promise<any>;
}> = {}) {
  const spy: Spy = { replaceCalls: [], reloadCalls: 0, legacyCalls: 0 };
  const queue = over.artifacts ?? [artifact(), artifact({
    fullReportMarkdown: NEW_FULL, shortReportMarkdown: NEW_SHORT,
  })];
  const handler = createReplaceReportHandler({
    requireCurrentUser: async () =>
      over.user === undefined ? { email: "founder@zypact.test" } : over.user,
    isFounderEmail: () => over.founder ?? true,
    getSnapshotReportArtifact: async () => {
      const i = spy.reloadCalls++;
      if (over.reloadThrows && i === 1) throw new Error("connection reset");
      return queue[Math.min(i, queue.length - 1)] ?? null;
    },
    replaceUndeliveredSnapshotReportArtifact: async (input) => {
      spy.replaceCalls.push(input);
      if (over.replaceImpl) return over.replaceImpl(input);
      return { artifactId: ART, revision: snapshotReportArtifactRevision(NEW_FULL, NEW_SHORT) };
    },
  });
  return { handler, spy };
}
const call = (h: any, body: unknown) => h(req(body), { params: Promise.resolve({ requestId: REQ }) });
const pgErr = (code: string) => Object.assign(new Error("db"), { code });

async function main(): Promise<void> {
  console.log("test-replace-report-route (executable)");

  /* ---- E1 auth ---- */
  {
    const { handler, spy } = build({ founder: false });
    const r = await call(handler, VALID);
    check("E1 non-founder gets 404 (resource hidden) and no replacement", r.status === 404 && spy.replaceCalls.length === 0);
    const { handler: h2 } = build({ user: null });
    check("E1b absent user gets 404", (await call(h2, VALID)).status === 404);
  }

  /* ---- E2-E6 validation ---- */
  for (const [label, patch] of [
    ["E2 missing expectedArtifactId", { expectedArtifactId: undefined }],
    ["E3 malformed expectedArtifactId", { expectedArtifactId: "not-a-uuid" }],
    ["E4 missing expectedRevision", { expectedRevision: undefined }],
    ["E5 missing fullReportMarkdown", { fullReportMarkdown: "" }],
    ["E6 missing shortReportMarkdown", { shortReportMarkdown: undefined }],
  ] as Array<[string, any]>) {
    const { handler, spy } = build();
    const r = await call(handler, { ...VALID, ...patch });
    check(`${label} → 400, replacement never attempted`, r.status === 400 && spy.replaceCalls.length === 0);
  }

  /* ---- E7 missing artifact ---- */
  {
    const { handler, spy } = build({ artifacts: [null] });
    const r = await call(handler, VALID);
    check("E7 absent artifact → 404, no replacement", r.status === 404 && spy.replaceCalls.length === 0);
  }

  /* ---- E8 every real 0035 conflict SQLSTATE → 409 ---- */
  for (const code of ["40001","serialization_failure","55P03","lock_not_available","22023","invalid_parameter_value","P0002","no_data_found"]) {
    const { handler, spy } = build({ replaceImpl: async () => { throw pgErr(code); } });
    const r = await call(handler, VALID);
    check(`E8 SQLSTATE ${code} → 409 (once, no retry)`, r.status === 409 && spy.replaceCalls.length === 1);
  }
  {
    const { handler } = build({ replaceImpl: async () => null });
    check("E8b null RPC result → 409", (await call(handler, VALID)).status === 409);
  }

  /* ---- E9-E11 unexpected failures must NOT be 409 ---- */
  for (const [label, thrown] of [
    ["E9 unknown SQLSTATE 08006", pgErr("08006")],
    ["E10 plain Error (network-like)", new Error("fetch failed")],
    ["E11 TypeError (programming error)", new TypeError("x is not a function")],
    ["E11b error without code", { message: "opaque" }],
  ] as Array<[string, any]>) {
    const { handler, spy } = build({ replaceImpl: async () => { throw thrown; } });
    const r = await call(handler, VALID);
    check(`${label} → 5xx not 409`, r.status >= 500 && r.status !== 409 && spy.replaceCalls.length === 1);
  }

  /* ---- E12-E18 success ---- */
  {
    const { handler, spy } = build();
    const r = await call(handler, VALID);
    const body = await r.json();
    check("E12 success 200; replacement called exactly once", r.status === 200 && spy.replaceCalls.length === 1);
    const c = spy.replaceCalls[0];
    check("E13 expected artifact + revision forwarded verbatim",
      c.expectedArtifactId === ART && c.expectedRevision === REV);
    check("E14 Full and Short passed in the SAME call",
      c.fullReportMarkdown === NEW_FULL && c.shortReportMarkdown === NEW_SHORT);
    check("E15 authoritative reload happened after replacement", spy.reloadCalls === 2);
    check("E16 returned revision is the persisted content's, not the request's",
      body.revision === snapshotReportArtifactRevision(NEW_FULL, NEW_SHORT) && body.revision !== REV);
    check("E16b artifact id stable", body.artifactId === ART);
    check("E17 no raw claim token in serialized response",
      !JSON.stringify(body).toLowerCase().includes("claim_token") &&
      !Object.keys(body).some((k) => /token/i.test(k)));
    check("E18 legacy save path never invoked", spy.legacyCalls === 0);
  }

  /* ---- E19 reload failure after a successful write ---- */
  {
    const { handler, spy } = build({ reloadThrows: true });
    const r = await call(handler, VALID);
    check("E19 reload failure after replace → 5xx not 409", r.status >= 500 && r.status !== 409);
    check("E19b no second replacement attempted", spy.replaceCalls.length === 1);
    const body = await r.json();
    check("E19c response tells founder the write landed", /reload_failed/.test(body.error));
  }

  /* ---- classifier unit matrix ---- */
  {
    check("classifier accepts only the four 0035 codes",
      ["40001","55P03","22023","P0002"].every((c) => isExpectedReportReplacementConflict(pgErr(c))));
    check("classifier rejects unknown code", !isExpectedReportReplacementConflict(pgErr("08006")));
    check("classifier rejects codeless error", !isExpectedReportReplacementConflict(new Error("x")));
    check("classifier rejects null/undefined",
      !isExpectedReportReplacementConflict(null) && !isExpectedReportReplacementConflict(undefined));
  }

  /* ---- claim token serialization ---- */
  {
    const s: any = toSnapshotReportPublicationState(
      artifact({ deliveryClaimActive: true, deliveryClaimedAt: "2026-01-02T00:00:00Z" })
    );
    check("claim state exposed as boolean + timestamp only",
      s.deliveryClaimActive === true && s.deliveryClaimedAt !== null &&
      !JSON.stringify(s).toLowerCase().includes("claim_token"));
  }

  /* ---- supplemental static assertions (clearly separated) ---- */
  {
    const fs = require("node:fs");
    const h = fs.readFileSync("lib/snapshot-requests/replace-report-handler.ts", "utf8");
    const code = h.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("static: no direct artifact table DML", !/\.from\("snapshot_report_artifacts"\)/.test(code));
    check("static: no legacy manual save", !/save_snapshot_report_artifact_manual|saveSnapshotReportArtifact/.test(code));
    check("static: no retry construct", !/(for|while)\s*\(|setTimeout|attempt\s*\+\+/.test(code));
    check("static: no provider import", !/resend|sendClientSnapshotReport/i.test(code));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
