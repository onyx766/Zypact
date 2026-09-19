/**
 * Phase 5 — Outcome Card delivery, the one path that emails a customer.
 *
 * deliverSavedOutcomeCard had no tests before this file (OPTION_A_TODO
 * Phase 7). It is driven here against a recording fake client and a fake
 * mail sender, so each assertion is about what actually reached the database
 * and the provider — and, as much, about what never did.
 *
 * The properties that matter most:
 *   - a card is never emailed unless a claim was granted first;
 *   - a claim is released only when non-delivery is PROVEN, and held
 *     otherwise, so an uncertain send can never become a duplicate email;
 *   - a founder send delivers the exact revision reviewed, or nothing;
 *   - `blocked` is refused before any claim;
 *   - generating a card never sends it, and never runs on an unfinished retest.
 */

import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ClientReportDeliveryError } from "@/lib/snapshot-requests/client-report-delivery";
import { deliverSavedOutcomeCard, type OutcomeCardProcessDeps } from "@/lib/reports/deliver-outcome-card";
import { NON_CAUSALITY_FOOTER, OUTCOME_CARD_VERSION } from "@/lib/reports/outcome-card-types";
import { generateOutcomeCard, sendReviewedOutcomeCard } from "@/lib/interventions/outcome-card-actions";
import { OutcomeCardControls } from "@/app/admin/interventions/[interventionId]/outcome-card-controls";

(globalThis as unknown as { React: unknown }).React = React;

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

type Row = Record<string, unknown>;
interface Call { name: string; args: Record<string, unknown> }
type RpcImpl = (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

function fakeClient(tables: Record<string, Row[]>, rpc: RpcImpl) {
  const calls: Call[] = [];
  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      order: () => q,
      limit: (n: number) => { rows = rows.slice(0, n); return q; },
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  }
  const client = {
    from: (t: string) => query(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return rpc(name, args);
    },
  } as unknown as SupabaseClient;
  return { client, calls, names: () => calls.map((c) => c.name) };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const IV = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = "77777777-7777-4777-8777-777777777777";
const REVISION = "a".repeat(64);
const CONFIG = { apiKey: "k", from: "f@zypact.example", appBaseUrl: "https://zypact.example" };

const recipientTables = {
  snapshot_requests: [{ project_id: PROJECT, work_email: "buyer@customer.example", company_name: "Customer Co", created_at: "x" }],
};

function sender(behaviour: "ok" | "proven" | "unknown") {
  const sent: Array<Record<string, unknown>> = [];
  const fn = (async (input: Record<string, unknown>) => {
    sent.push(input);
    if (behaviour === "proven") throw new ClientReportDeliveryError("provider_rejected", 422);
    if (behaviour === "unknown") throw new Error("socket hang up");
    return { provider: "resend" as const, messageId: "msg-1" };
  }) as unknown as NonNullable<OutcomeCardProcessDeps["sendEmail"]>;
  return { fn, sent };
}

const card = {
  interventionId: IV, projectId: PROJECT, artifactId: ARTIFACT, publicToken: "tok",
  revision: REVISION, questionText: "Which tool?",
};

async function main(): Promise<void> {
  console.log("\nOutcome Card delivery (Phase 5)\n");

  /* ═══════════ 1. deliverSavedOutcomeCard ═══════════ */
  console.log("[1] The one path that emails a customer");
  {
    const { client, names } = fakeClient({ snapshot_requests: [] }, () => ({ data: null, error: null }));
    const s = sender("ok");
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: s.fn });
    check("no recipient: refused, and no claim is taken", r.outcome === "delivery_rejected" && names().length === 0);
    check("and nothing is sent", s.sent.length === 0);
  }
  for (const [message, outcome] of [
    ["artifact revision changed since preview", "delivery_claim_unavailable"],
    ["outcome card is blocked and may never be delivered", "held_blocked"],
    ["outcome card already delivered", "already_delivered"],
    ["delivery claim is active", "delivery_claim_unavailable"],
  ] as const) {
    const { client } = fakeClient(recipientTables, (n) =>
      n === "begin_outcome_card_delivery" ? { data: null, error: { message } } : { data: null, error: null });
    const s = sender("ok");
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: s.fn });
    check(`begin refuses "${message}": ${outcome}, nothing sent`, r.outcome === outcome && s.sent.length === 0, r.outcome);
  }
  {
    const { client } = fakeClient(recipientTables, (n) =>
      n === "begin_outcome_card_delivery" ? { data: null, error: { message: "connection reset" } } : { data: null, error: null });
    let threw = false;
    try { await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: sender("ok").fn }); }
    catch { threw = true; }
    check("an unrecognised begin error is thrown, never read as a refusal", threw);
  }
  {
    const { client, calls } = fakeClient(recipientTables, (n) => {
      if (n === "begin_outcome_card_delivery") return { data: [{ delivery_claim_token: "claim-1" }], error: null };
      if (n === "finalize_outcome_card_delivery") return { data: [{ id: ARTIFACT }], error: null };
      return { data: null, error: null };
    });
    const s = sender("ok");
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: s.fn });
    check("happy path delivers", r.outcome === "delivered" && r.messageId === "msg-1");
    check("the claim is taken on the exact revision", calls.find((c) => c.name === "begin_outcome_card_delivery")?.args.p_expected_revision === REVISION);
    check("the email is keyed to the revision, so a retry is deduplicated",
      s.sent[0]?.deliveryIdempotencyKey === `outcome-card:${IV}:${REVISION.slice(0, 32)}`);
    check("finalize uses the granted claim token",
      calls.find((c) => c.name === "finalize_outcome_card_delivery")?.args.p_delivery_claim_token === "claim-1");
    check("begin happens before the send, finalize after",
      calls.map((c) => c.name).join(",") === "begin_outcome_card_delivery,finalize_outcome_card_delivery");
  }
  {
    const { client, names } = fakeClient(recipientTables, (n) =>
      n === "begin_outcome_card_delivery" ? { data: [{ delivery_claim_token: "claim-1" }], error: null } : { data: null, error: null });
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: sender("proven").fn });
    check("provider proves non-delivery: the claim is released", names().includes("release_outcome_card_delivery_claim"));
    check("and the outcome says retry is safe", r.outcome === "delivery_rejected" && /retry is safe/.test(r.detail ?? ""));
  }
  {
    const { client, names } = fakeClient(recipientTables, (n) =>
      n === "begin_outcome_card_delivery" ? { data: [{ delivery_claim_token: "claim-1" }], error: null } : { data: null, error: null });
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: sender("unknown").fn });
    check("uncertain send: the claim is HELD, never released", !names().includes("release_outcome_card_delivery_claim"));
    check("and the outcome is ambiguous, not a failure to retry", r.outcome === "delivery_ambiguous");
  }
  {
    const { client } = fakeClient(recipientTables, (n) => {
      if (n === "begin_outcome_card_delivery") return { data: [{ delivery_claim_token: "claim-1" }], error: null };
      if (n === "finalize_outcome_card_delivery") return { data: [], error: null };
      return { data: null, error: null };
    });
    const r = await deliverSavedOutcomeCard(card, { client, deliveryConfig: CONFIG, sendEmail: sender("ok").fn });
    check("sent but not finalized: ambiguous, with the message id kept for reconciliation",
      r.outcome === "delivery_ambiguous" && r.messageId === "msg-1");
  }

  /* ═══════════ 2. sendReviewedOutcomeCard ═══════════ */
  console.log("\n[2] A founder sends exactly what was reviewed, or nothing");
  const ivRow = { id: IV, project_id: PROJECT, protocol_id: "b", buyer_question_version_id: "q", status: "implemented",
    hypothesis: "h", expected_mechanism: "m", action_type: "page_created", action_target: "t", owner: "o",
    supporting_evidence: ["a"], created_at: "x", updated_at: "x" };
  // Satisfies isOutcomeCardPayload: the send path refuses anything else.
  const validPayload = {
    reportVersion: OUTCOME_CARD_VERSION,
    nonCausalityFooter: NON_CAUSALITY_FOOTER,
    subject: {}, question: { text: "Which tool?" }, baseline: {}, retest: {}, intervention: {}, comparison: {},
    uncertainty: [], limitations: [],
  };
  const artifactRow = (over: Row = {}): Row => ({
    id: ARTIFACT, intervention_id: IV, public_token: "tok", markdown: "md",
    payload: validPayload, integrity_status: "integrity_passed", integrity_reasons: [],
    generated_at: "x", delivered_at: null, delivery_message_id: null, delivery_claimed_at: null, ...over,
  });
  const sendClient = (artifact: Row) =>
    fakeClient({ interventions: [ivRow], outcome_card_artifacts: [artifact], ...recipientTables }, (n) => {
      if (n === "outcome_card_artifact_revision") return { data: REVISION, error: null };
      if (n === "begin_outcome_card_delivery") return { data: [{ delivery_claim_token: "claim-1" }], error: null };
      if (n === "finalize_outcome_card_delivery") return { data: [{ id: ARTIFACT }], error: null };
      return { data: null, error: null };
    });
  const expected = { expectedArtifactId: ARTIFACT, expectedRevision: REVISION, acknowledgeReview: false };

  {
    const { client, names } = sendClient(artifactRow({ integrity_status: "blocked" }));
    const s = sender("ok");
    const r = await sendReviewedOutcomeCard(client, IV, expected, CONFIG, s.fn);
    check("blocked is refused", !r.ok && r.failure.error === "integrity_blocked");
    check("before any claim is taken", !names().includes("begin_outcome_card_delivery") && s.sent.length === 0);
  }
  {
    const { client, names } = sendClient(artifactRow({ integrity_status: "needs_review" }));
    const r = await sendReviewedOutcomeCard(client, IV, expected, CONFIG, sender("ok").fn);
    check("needs_review without acknowledgement is refused, no claim",
      !r.ok && r.failure.error === "review_not_acknowledged" && !names().includes("begin_outcome_card_delivery"));
  }
  {
    const { client } = sendClient(artifactRow({ integrity_status: "needs_review" }));
    const s = sender("ok");
    const r = await sendReviewedOutcomeCard(client, IV, { ...expected, acknowledgeReview: true }, CONFIG, s.fn);
    check("needs_review WITH acknowledgement is sent", r.ok && s.sent.length === 1);
  }
  {
    const { client, names } = sendClient(artifactRow());
    const s = sender("ok");
    const r = await sendReviewedOutcomeCard(client, IV, { ...expected, expectedRevision: "b".repeat(64) }, CONFIG, s.fn);
    check("a changed revision is refused as a stale review", !r.ok && r.failure.error === "stale_review");
    check("before any claim, and nothing is sent", !names().includes("begin_outcome_card_delivery") && s.sent.length === 0);
  }
  {
    const { client } = sendClient(artifactRow());
    const r = await sendReviewedOutcomeCard(client, IV, { ...expected, expectedArtifactId: "88888888-8888-4888-8888-888888888888" }, CONFIG, sender("ok").fn);
    check("a regenerated artifact is refused as a stale review", !r.ok && r.failure.error === "stale_review");
  }
  {
    const { client, names } = sendClient(artifactRow({ delivered_at: "2026-09-18T00:00:00Z" }));
    const r = await sendReviewedOutcomeCard(client, IV, expected, CONFIG, sender("ok").fn);
    check("an already delivered card is not sent again", !r.ok && r.failure.error === "already_delivered"
      && !names().includes("begin_outcome_card_delivery"));
  }
  {
    const { client, names } = sendClient(artifactRow({ payload: { question: { text: "partial" } } }));
    const s = sender("ok");
    const r = await sendReviewedOutcomeCard(client, IV, expected, CONFIG, s.fn);
    check("a stored card that fails the payload shape guard is never sent",
      !r.ok && r.failure.error === "unrenderable_card" && s.sent.length === 0
      && !names().includes("begin_outcome_card_delivery"));
  }
  {
    const { client, calls } = sendClient(artifactRow());
    const s = sender("ok");
    const r = await sendReviewedOutcomeCard(client, IV, expected, CONFIG, s.fn);
    check("integrity_passed is sent", r.ok && s.sent.length === 1);
    check("with the reviewed revision, not a recomputed one",
      calls.find((c) => c.name === "begin_outcome_card_delivery")?.args.p_expected_revision === REVISION);
  }

  /* ═══════════ 3. generateOutcomeCard ═══════════ */
  console.log("\n[3] Generating never sends, and never runs on an unfinished retest");
  const genTables = (jobStatus: string | null): Record<string, Row[]> => ({
    interventions: [ivRow],
    protocols: [{ id: "r", project_id: PROJECT, baseline_protocol_id: "b", status: "active", planned_baseline_runs: 5, created_at: "x" }],
    protocol_execution_jobs: jobStatus ? [{ id: "j", protocol_id: "r", status: jobStatus, attempt_count: 1 }] : [],
    protocol_attempts: [],
  });
  for (const js of [null, "queued", "running", "needs_review", "failed"]) {
    const { client } = fakeClient(genTables(js), () => ({ data: null, error: null }));
    let called = false;
    const r = await generateOutcomeCard(client, IV, (async () => { called = true; return {} as never; }) as never);
    check(`retest job '${js ?? "none"}': refused, and the pipeline never runs`,
      !r.ok && r.failure.error === "retest_not_finished" && !called);
  }
  {
    const { client } = fakeClient(genTables("succeeded"), () => ({ data: null, error: null }));
    let seen: OutcomeCardProcessDeps | null = null;
    const r = await generateOutcomeCard(client, IV, (async (_id: string, deps: OutcomeCardProcessDeps) => {
      seen = deps;
      return { interventionId: IV, outcome: "held_auto_send_disabled", integrityStatus: "integrity_passed",
        integrityReasons: [], artifactId: ARTIFACT, publicToken: "tok", messageId: null };
    }) as never);
    check("a finished retest runs the pipeline", r.ok);
    check("with auto-send forced OFF — generating never emails a customer",
      (seen as OutcomeCardProcessDeps | null)?.autoSendEnabled === false);
  }

  /* ═══════════ 4. the controls ═══════════ */
  console.log("\n[4] Controls");
  const controls = (over: Partial<Parameters<typeof OutcomeCardControls>[0]>) =>
    renderToStaticMarkup(createElement(OutcomeCardControls, {
      interventionId: IV, canGenerate: true, generateBlockedReason: null, card: null, actionsEnabled: true, ...over,
    }));
  const disabledOf = (html: string, text: string): boolean | null => {
    for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) if (m[2].includes(text)) return /\bdisabled=""/.test(m[1]);
    return null;
  };
  const noCard = controls({});
  check("no card yet: build is offered, send is not", noCard.includes("Build Outcome Card") && !noCard.includes("Send to customer"));
  const notReady = controls({ canGenerate: false, generateBlockedReason: "The retest job is 'running'." });
  check("unfinished retest: build is disabled and says why",
    disabledOf(notReady, "Build Outcome Card") === true && notReady.includes("is &#x27;running&#x27;"));
  const cardOf = (integrityStatus: string, delivered = false) => ({ artifactId: ARTIFACT, revision: REVISION, integrityStatus, delivered });
  const passedHtml = controls({ card: cardOf("integrity_passed") });
  check("integrity passed: send is live", disabledOf(passedHtml, "Send to customer") === false);
  const reviewHtml = controls({ card: cardOf("needs_review") });
  check("needs review: send starts disabled until the review is confirmed", disabledOf(reviewHtml, "Send to customer") === true);
  check("and the confirmation is asked for", reviewHtml.includes("I have read this card"));
  const blockedHtml = controls({ card: cardOf("blocked") });
  check("blocked: there is no send button at all", disabledOf(blockedHtml, "Send to customer") === null);
  check("and it says blocked cards are never delivered", blockedHtml.includes("never delivered"));
  const deliveredHtml = controls({ card: cardOf("integrity_passed", true) });
  check("delivered: neither rebuild nor send is offered",
    !deliveredHtml.includes("Rebuild card") && !deliveredHtml.includes("Send to customer"));

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
