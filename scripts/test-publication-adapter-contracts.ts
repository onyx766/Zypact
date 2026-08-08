#!/usr/bin/env tsx
/**
 * Executable contract tests for the four migration-0035 publication adapters.
 *
 * These were previously asserted by matching adapter source, which proves the
 * strings appear somewhere — not that a call actually reaches the right RPC
 * with the right parameter names. B2's delivery fencing depends on `begin`,
 * `finalize` and `release` being wire-correct, so the real adapters are driven
 * here against a recording fake client.
 *
 * No network, no credentials, no database.
 */
import {
  supabaseAdapter,
  __setSupabaseAdapterClientForTests,
} from "@/lib/db/supabase-adapter";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const REQ = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const ART = "6c1c1f7e-6a2f-4d2e-9d1a-0d0a7f5b2e11";
const TOK = "9f8e7d6c-5b4a-4392-8172-0a1b2c3d4e5f";
const REV = "a".repeat(64);

interface Call { name: string; args: Record<string, unknown> }

/** Records every rpc() and returns a controlled PostgREST-shaped result. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { maybeSingle: async () => result };
    },
    from() {
      throw new Error("adapter must not touch tables directly");
    },
  };
  __setSupabaseAdapterClientForTests(client as never);
  return calls;
}

async function main(): Promise<void> {
  console.log("test-publication-adapter-contracts (executable)");

  /* ---- REPLACE ---- */
  {
    const calls = fakeClient({ data: { artifact_id: ART, revision: REV }, error: null });
    const out = await supabaseAdapter.replaceUndeliveredSnapshotReportArtifact({
      snapshotRequestId: REQ, expectedArtifactId: ART, expectedRevision: REV,
      fullReportMarkdown: "# Full", shortReportMarkdown: "# Short",
    });
    check("REPLACE issues exactly one rpc call", calls.length === 1);
    check("REPLACE rpc name", calls[0]?.name === "replace_undelivered_snapshot_report_artifact");
    const a = calls[0]?.args ?? {};
    check("REPLACE p_snapshot_request_id", a.p_snapshot_request_id === REQ);
    check("REPLACE p_expected_artifact_id", a.p_expected_artifact_id === ART);
    check("REPLACE p_expected_revision", a.p_expected_revision === REV);
    check("REPLACE p_full_report_markdown", a.p_full_report_markdown === "# Full");
    check("REPLACE p_short_report_markdown", a.p_short_report_markdown === "# Short");
    check("REPLACE passes exactly the five declared params", Object.keys(a).length === 5);
    check("REPLACE normalizes snake_case → camelCase",
      out?.artifactId === ART && out?.revision === REV);
    check("REPLACE never falls back to the legacy manual save",
      !calls.some((c) => c.name === "save_snapshot_report_artifact_manual"));
  }
  {
    const calls = fakeClient({ data: null, error: null });
    check("REPLACE null data normalizes to null",
      (await supabaseAdapter.replaceUndeliveredSnapshotReportArtifact({
        snapshotRequestId: REQ, expectedArtifactId: ART, expectedRevision: REV,
        fullReportMarkdown: "f", shortReportMarkdown: "s",
      })) === null && calls.length === 1);
  }

  /* ---- BEGIN ---- */
  {
    const calls = fakeClient({
      data: {
        artifact_id: ART, revision: REV, delivery_claim_token: TOK,
        full_report_markdown: "# Full claimed", short_report_markdown: "# Short claimed",
      }, error: null,
    });
    const out = await supabaseAdapter.beginSnapshotReportDelivery({
      snapshotRequestId: REQ, expectedArtifactId: ART, expectedRevision: REV,
    });
    check("BEGIN issues exactly one rpc call", calls.length === 1);
    check("BEGIN rpc name", calls[0]?.name === "begin_snapshot_report_delivery");
    const a = calls[0]?.args ?? {};
    check("BEGIN p_snapshot_request_id", a.p_snapshot_request_id === REQ);
    check("BEGIN p_expected_artifact_id", a.p_expected_artifact_id === ART);
    check("BEGIN p_expected_revision", a.p_expected_revision === REV);
    check("BEGIN passes exactly the three declared params", Object.keys(a).length === 3);
    check("BEGIN returns the claim token server-side", out?.deliveryClaimToken === TOK);
    check("BEGIN returns the claimed markdown B2 must email verbatim",
      out?.shortReportMarkdown === "# Short claimed" &&
      out?.fullReportMarkdown === "# Full claimed");
    check("BEGIN normalizes artifact id and revision",
      out?.artifactId === ART && out?.revision === REV);
  }

  /* ---- FINALIZE ---- */
  {
    const calls = fakeClient({
      data: { artifact_id: ART, delivered_at: "2026-01-02T03:04:05Z" }, error: null,
    });
    const out = await supabaseAdapter.finalizeSnapshotReportDelivery({
      snapshotRequestId: REQ, artifactId: ART, deliveryClaimToken: TOK,
      deliveryMessageId: "msg-123",
    });
    check("FINALIZE issues exactly one rpc call", calls.length === 1);
    check("FINALIZE rpc name", calls[0]?.name === "finalize_snapshot_report_delivery");
    const a = calls[0]?.args ?? {};
    check("FINALIZE p_snapshot_request_id", a.p_snapshot_request_id === REQ);
    check("FINALIZE p_artifact_id", a.p_artifact_id === ART);
    check("FINALIZE p_delivery_claim_token", a.p_delivery_claim_token === TOK);
    check("FINALIZE p_delivery_message_id", a.p_delivery_message_id === "msg-123");
    check("FINALIZE passes exactly the four declared params", Object.keys(a).length === 4);
    check("FINALIZE normalizes delivered_at",
      out?.artifactId === ART && out?.deliveredAt === "2026-01-02T03:04:05Z");
  }

  /* ---- RELEASE ---- */
  {
    const calls = fakeClient({ data: { artifact_id: ART }, error: null });
    const out = await supabaseAdapter.releaseSnapshotReportDeliveryClaim({
      snapshotRequestId: REQ, artifactId: ART, deliveryClaimToken: TOK,
    });
    check("RELEASE issues exactly one rpc call", calls.length === 1);
    check("RELEASE rpc name", calls[0]?.name === "release_snapshot_report_delivery_claim");
    const a = calls[0]?.args ?? {};
    check("RELEASE p_snapshot_request_id", a.p_snapshot_request_id === REQ);
    check("RELEASE p_artifact_id", a.p_artifact_id === ART);
    check("RELEASE p_delivery_claim_token", a.p_delivery_claim_token === TOK);
    check("RELEASE passes exactly the three declared params", Object.keys(a).length === 3);
    check("RELEASE normalizes artifact id", out?.artifactId === ART);
  }

  /* ---- error propagation: all four must reject, never swallow ---- */
  const pgError = { code: "40001", message: "serialization failure", details: null, hint: null };
  const invocations: Array<[string, () => Promise<unknown>]> = [
    ["REPLACE", () => supabaseAdapter.replaceUndeliveredSnapshotReportArtifact({
      snapshotRequestId: REQ, expectedArtifactId: ART, expectedRevision: REV,
      fullReportMarkdown: "f", shortReportMarkdown: "s" })],
    ["BEGIN", () => supabaseAdapter.beginSnapshotReportDelivery({
      snapshotRequestId: REQ, expectedArtifactId: ART, expectedRevision: REV })],
    ["FINALIZE", () => supabaseAdapter.finalizeSnapshotReportDelivery({
      snapshotRequestId: REQ, artifactId: ART, deliveryClaimToken: TOK,
      deliveryMessageId: "m" })],
    ["RELEASE", () => supabaseAdapter.releaseSnapshotReportDeliveryClaim({
      snapshotRequestId: REQ, artifactId: ART, deliveryClaimToken: TOK })],
  ];
  for (const [name, invoke] of invocations) {
    fakeClient({ data: null, error: pgError });
    let threw: unknown = null;
    try { await invoke(); } catch (e) { threw = e; }
    check(`${name} propagates the RPC error rather than swallowing it`, threw !== null);
    check(`${name} preserves SQLSTATE for the route classifier`,
      (threw as { code?: string } | null)?.code === "40001");
  }

  __setSupabaseAdapterClientForTests(null as never);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
