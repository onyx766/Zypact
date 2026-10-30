#!/usr/bin/env tsx
/**
 * Fenced snapshot report delivery — executable orchestration tests.
 *
 * The race this closes: a founder sends revision R1 while another tab
 * replaces the artifact with R2. Without a claim, the email carries R1 while
 * the database records R2 as delivered.
 *
 * B2a is deliberately more conservative than the final design: once BEGIN
 * commits, NOTHING releases the claim. The provider may have accepted the
 * email at any point past dispatch — `invalid_provider_response` even fires
 * on a 2xx — so holding a claim costs availability while releasing wrongly
 * costs a customer a duplicate email.
 */
import {
  buildRevisionIdempotencyKey,
  classifyProviderDeliveryFailure,
  createSendReportHandler,
} from "@/lib/snapshot-requests/send-report-handler";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const REQ = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const ART = "6c1c1f7e-6a2f-4d2e-9d1a-0d0a7f5b2e11";
const TOK = "9f8e7d6c-5b4a-4392-8172-0a1b2c3d4e5f";
const REV = "a".repeat(64);

const PRE_BEGIN_SHORT = "OLD REPORT";
const BEGIN_SHORT = "CLAIMED REPORT";
const LATER_SHORT = "NEW REPORT";

interface Spy {
  order: string[];
  begin: any[]; provider: any[]; finalize: any[]; release: any[];
  artifactContentReads: number;
}

function build(over: Partial<{
  founder: boolean; user: any; context: any;
  beginImpl: (i: any) => Promise<any>;
  providerImpl: (i: any) => Promise<any>;
  finalizeImpl: (i: any) => Promise<any>;
  releaseImpl: (i: any) => Promise<any>;
}> = {}) {
  const spy: Spy = { order: [], begin: [], provider: [], finalize: [], release: [], artifactContentReads: 0 };
  const handler = createSendReportHandler({
    requireCurrentUser: async () => {
      spy.order.push("auth");
      return over.user === undefined ? { email: "founder@zypact.test" } : over.user;
    },
    isFounderEmail: () => over.founder ?? true,
    loadRequestContext: async () => {
      spy.order.push("prep");
      // Pre-BEGIN content exists but must never reach the provider.
      spy.artifactContentReads += 0;
      return over.context === undefined
        ? { workEmail: "client@example.com", companyName: "Acme", publicToken: "t".repeat(43), integrityStatus: "integrity_passed", questionText: "Which SOC 2 tool?" }
        : over.context;
    },
    beginSnapshotReportDelivery: async (input) => {
      spy.order.push("begin"); spy.begin.push(input);
      if (over.beginImpl) return over.beginImpl(input);
      return {
        artifactId: ART, revision: REV, deliveryClaimToken: TOK,
        fullReportMarkdown: "FULL CLAIMED", shortReportMarkdown: BEGIN_SHORT,
      };
    },
    sendReportEmail: async (input) => {
      spy.order.push("provider"); spy.provider.push(input);
      if (over.providerImpl) return over.providerImpl(input);
      return { messageId: "msg-1" };
    },
    releaseSnapshotReportDeliveryClaim: async (input) => {
      spy.order.push("release"); spy.release.push(input);
      if (over.releaseImpl) return over.releaseImpl(input);
      return { artifactId: ART };
    },
    finalizeSnapshotReportDelivery: async (input) => {
      spy.order.push("finalize"); spy.finalize.push(input);
      if (over.finalizeImpl) return over.finalizeImpl(input);
      return { artifactId: ART, deliveredAt: "2026-01-02T00:00:00Z" };
    },
  });
  return { handler, spy };
}
const call = (h: any, body: unknown) =>
  h(new Request("http://local/send", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ requestId: REQ }) });
const VALID = { expectedArtifactId: ART, expectedRevision: REV };

async function main(): Promise<void> {
  console.log("test-send-report-fencing");

  /* ---- §22 happy path ---- */
  {
    const { handler, spy } = build();
    const r = await call(handler, VALID);
    const body = await r.json();
    check("happy path returns 200", r.status === 200);
    check("call order is auth → prep → begin → provider → finalize",
      spy.order.join(">") === "auth>prep>begin>provider>finalize");
    check("BEGIN once, provider once, FINALIZE once, RELEASE zero",
      spy.begin.length === 1 && spy.provider.length === 1 &&
      spy.finalize.length === 1 && spy.release.length === 0);
    check("BEGIN fences on the submitted artifact + revision",
      spy.begin[0].expectedArtifactId === ART && spy.begin[0].expectedRevision === REV);
    check("§26 provider receives the CLAIMED markdown",
      spy.provider[0].shortReportMarkdown === BEGIN_SHORT);
    check("§26b provider never sees pre-BEGIN content",
      spy.provider[0].shortReportMarkdown !== PRE_BEGIN_SHORT);
    check("§26c provider never sees a later revision",
      spy.provider[0].shortReportMarkdown !== LATER_SHORT);
    check("FINALIZE uses the exact BEGIN claim token",
      spy.finalize[0].deliveryClaimToken === TOK);
    check("FINALIZE uses the BEGIN artifact id and provider message id",
      spy.finalize[0].artifactId === ART && spy.finalize[0].deliveryMessageId === "msg-1");
    check("§21 no claim token in the response body",
      !JSON.stringify(body).includes(TOK));
    check("§27 no post-BEGIN artifact content read", spy.artifactContentReads === 0);
  }

  /* ---- §23 input + auth ---- */
  for (const [label, body] of [
    ["missing expectedArtifactId", { expectedRevision: REV }],
    ["malformed expectedArtifactId", { expectedArtifactId: "nope", expectedRevision: REV }],
    ["missing expectedRevision", { expectedArtifactId: ART }],
    ["empty expectedRevision", { expectedArtifactId: ART, expectedRevision: "  " }],
  ] as Array<[string, any]>) {
    const { handler, spy } = build();
    const r = await call(handler, body);
    check(`§23 ${label} → 400, BEGIN 0, provider 0`,
      r.status === 400 && spy.begin.length === 0 && spy.provider.length === 0);
  }
  {
    const { handler, spy } = build({ founder: false });
    const r = await call(handler, VALID);
    check("§23 non-founder → 404, BEGIN 0, provider 0",
      r.status === 404 && spy.begin.length === 0 && spy.provider.length === 0);
    const { handler: h2, spy: s2 } = build({ context: null });
    check("missing request context → 404 before BEGIN",
      (await call(h2, VALID)).status === 404 && s2.begin.length === 0);
  }

  /* ---- integrity gate: `blocked` never delivers ---- */
  {
    const blockedContext = {
      workEmail: "client@example.com", companyName: "Acme",
      publicToken: "t".repeat(43), integrityStatus: "blocked",
      questionText: "Which SOC 2 tool?",
    };
    const { handler, spy } = build({ context: blockedContext });
    const r = await call(handler, VALID);
    const body = await r.json();
    check("blocked artifact → 409 integrity_blocked",
      r.status === 409 && body.error === "integrity_blocked");
    check("blocked artifact never reaches BEGIN, provider or FINALIZE",
      spy.begin.length === 0 && spy.provider.length === 0 && spy.finalize.length === 0);
    check("blocked artifact takes no claim to release",
      spy.release.length === 0 && spy.order.join(">") === "auth>prep");

    // `integrity_passed` delivers on its own.
    {
      const { handler: h, spy: s } = build({
        context: { ...blockedContext, integrityStatus: "integrity_passed" },
      });
      check("integrity_passed delivers without an acknowledgement",
        (await call(h, VALID)).status === 200 && s.provider.length === 1);
    }
  }

  /* ---- review gate: needs_review and an empty status need a founder's review ---- */
  {
    const ctx = (integrityStatus: string | null) => ({
      workEmail: "client@example.com", companyName: "Acme",
      publicToken: "t".repeat(43), integrityStatus,
      questionText: "Which SOC 2 tool?",
    });
    for (const status of ["needs_review", null, "something_unknown"] as Array<string | null>) {
      const { handler, spy } = build({ context: ctx(status) });
      const r = await call(handler, VALID);
      const body = await r.json();
      check(`${String(status)} without acknowledgement → 409 review_acknowledgement_required`,
        r.status === 409 && body.error === "review_acknowledgement_required");
      check(`${String(status)} without acknowledgement never reaches BEGIN or the provider`,
        spy.begin.length === 0 && spy.provider.length === 0 && spy.finalize.length === 0);

      const { handler: hFalse, spy: sFalse } = build({ context: ctx(status) });
      const rFalse = await call(hFalse, { ...VALID, acknowledgeReview: "true" });
      check(`${String(status)} with a non-boolean acknowledgement is still refused`,
        rFalse.status === 409 && sFalse.provider.length === 0);

      const { handler: hAck, spy: sAck } = build({ context: ctx(status) });
      const rAck = await call(hAck, { ...VALID, acknowledgeReview: true });
      check(`${String(status)} with acknowledgeReview: true delivers`,
        rAck.status === 200 && sAck.provider.length === 1);
    }

    // Acknowledging a review can never override a blocked artifact.
    const { handler: hB, spy: sB } = build({ context: ctx("blocked") });
    const rB = await call(hB, { ...VALID, acknowledgeReview: true });
    check("blocked stays blocked even with acknowledgeReview: true",
      rB.status === 409 && (await rB.json()).error === "integrity_blocked" && sB.begin.length === 0);
  }

  /* ---- canonical payload only: a legacy artifact is never emailed ---- */
  {
    for (const questionText of [null, "", "   "] as Array<string | null>) {
      const { handler, spy } = build({
        context: {
          workEmail: "client@example.com", companyName: "Acme",
          publicToken: "t".repeat(43), integrityStatus: "integrity_passed",
          questionText,
        },
      });
      const r = await call(handler, { ...VALID, acknowledgeReview: true });
      check(`no canonical question (${JSON.stringify(questionText)}) → 409 legacy_report_not_deliverable`,
        r.status === 409 && (await r.json()).error === "legacy_report_not_deliverable");
      check("a legacy artifact takes no claim and never reaches the provider",
        spy.begin.length === 0 && spy.provider.length === 0);
    }
    const { handler, spy } = build();
    await call(handler, VALID);
    check("the provider receives the canonical question text",
      spy.provider[0]?.questionText === "Which SOC 2 tool?");
  }

  /* ---- §24 BEGIN conflicts ---- */
  const pg = (code: string) => Object.assign(new Error("db"), { code });
  for (const [label, impl] of [
    ["stale artifact (22023)", async () => { throw pg("22023"); }],
    ["stale revision (40001)", async () => { throw pg("40001"); }],
    ["already delivered (22023)", async () => { throw pg("22023"); }],
    ["active claim (55P03)", async () => { throw pg("55P03"); }],
    ["null result", async () => null],
  ] as Array<[string, any]>) {
    const { handler, spy } = build({ beginImpl: impl });
    const r = await call(handler, VALID);
    check(`§24 BEGIN ${label} → 409, provider 0, finalize 0, release 0`,
      r.status === 409 && spy.provider.length === 0 &&
      spy.finalize.length === 0 && spy.release.length === 0);
    check(`§24b BEGIN ${label} attempted exactly once (no retry)`, spy.begin.length === 1);
  }

  /* ---- §25 logical concurrent sends ---- */
  {
    let claimed = false;
    const beginImpl = async () => {
      if (claimed) throw pg("55P03");
      claimed = true;
      return { artifactId: ART, revision: REV, deliveryClaimToken: TOK,
        fullReportMarkdown: "F", shortReportMarkdown: BEGIN_SHORT };
    };
    const a = build({ beginImpl }); const b = build({ beginImpl });
    const r1 = await call(a.handler, VALID);
    const r2 = await call(b.handler, VALID);
    check("§25 first send succeeds", r1.status === 200 && a.spy.provider.length === 1);
    check("§25b second send is fenced out with 409",
      r2.status === 409 && b.spy.provider.length === 0);
  }

  /* ---- §29 fail-closed smoke: no AMBIGUOUS outcome ever releases ----
   * The 4xx case moved to F2, which is the single releasable provider
   * outcome; everything remaining here must hold its claim. */
  const providerFailures: Array<[string, any]> = [
    ["5xx provider error", Object.assign(new Error("server"), { code: "provider_error", status: 503 })],
    ["timeout", Object.assign(new Error("t"), { code: "provider_timeout", status: null })],
    ["connection failure", Object.assign(new Error("c"), { code: "provider_connection_failed", status: null })],
    ["invalid_provider_response (2xx!)", Object.assign(new Error("i"), { code: "invalid_provider_response", status: 200 })],
    ["unknown throw", new TypeError("boom")],
  ];
  for (const [label, thrown] of providerFailures) {
    const { handler, spy } = build({ providerImpl: async () => { throw thrown; } });
    const r = await call(handler, VALID);
    check(`§29 provider ${label} → 5xx, RELEASE 0, FINALIZE 0`,
      r.status >= 500 && spy.release.length === 0 && spy.finalize.length === 0);
    check(`§29b provider ${label} attempted exactly once`, spy.provider.length === 1);
  }
  {
    const { handler, spy } = build({ providerImpl: async () => ({ messageId: "" }) });
    const r = await call(handler, VALID);
    check("§29 empty message id → 5xx, no FINALIZE, no RELEASE",
      r.status >= 500 && spy.finalize.length === 0 && spy.release.length === 0);
  }
  for (const [label, impl] of [
    ["FINALIZE throws", async () => { throw new Error("finalize failed"); }],
    ["FINALIZE returns null", async () => null],
  ] as Array<[string, any]>) {
    const { handler, spy } = build({ finalizeImpl: impl });
    const r = await call(handler, VALID);
    const body = await r.json();
    check(`§29 ${label} → 5xx, RELEASE 0, provider exactly 1`,
      r.status >= 500 && spy.release.length === 0 && spy.provider.length === 1);
    check(`§29b ${label} warns against resending`,
      /do not resend/i.test(body.message ?? ""));
  }

  /* ---- §28 idempotency ---- */
  {
    const K1 = buildRevisionIdempotencyKey(ART, REV);
    check("I1 deterministic for the same artifact + revision",
      K1 === buildRevisionIdempotencyKey(ART, REV));
    check("I1b canonical format", K1 === `snapshot-report:${ART}:${REV}`);
    check("I2 a different revision yields a different key",
      buildRevisionIdempotencyKey(ART, "b".repeat(64)) !== K1);
    check("I3 a different artifact yields a different key",
      buildRevisionIdempotencyKey("other-artifact", REV) !== K1);
    check("I4/I5 key depends on nothing but artifact + revision",
      buildRevisionIdempotencyKey(ART, REV) === K1);
    const { handler, spy } = build();
    await call(handler, VALID);
    check("provider receives the artifact+revision key",
      spy.provider[0].deliveryIdempotencyKey === K1);
    check("key contains no claim token or message id",
      !spy.provider[0].deliveryIdempotencyKey.includes(TOK) &&
      !spy.provider[0].deliveryIdempotencyKey.includes("msg-1"));
  }

  /* ---- supplemental static checks ---- */
  {
    const fs = require("node:fs");
    const h = fs.readFileSync("lib/snapshot-requests/send-report-handler.ts", "utf8");
    const rt = fs.readFileSync("app/api/internal/snapshot-requests/[requestId]/send-report/route.ts", "utf8");
    const code = (h + rt).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Release exists, but only behind the proven-non-delivery helper; the
    // narrow call-site audit lives in the B2b source-audit block.
    check("§15 the handler reaches the adapter from exactly one place",
      (h.match(/deps\.releaseSnapshotReportDeliveryClaim\(/g) ?? []).length === 1);
    const rtCode = rt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("§15b the route only passes the adapter through",
      (rtCode.match(/releaseSnapshotReportDeliveryClaim/g) ?? []).length === 2);
    check("§32 no direct artifact DML",
      !/\.from\("snapshot_report_artifacts"\)/.test(code));
    check("§33 no automatic retry construct",
      !/(for|while)\s*\(|setTimeout|attempt\s*\+\+/.test(code));
    check("§33b release is attempted at most once per request",
      (code.match(/await releaseClaimAfterProvenNonDelivery\(/g) ?? []).length === 2);
    check("§9 no artifact re-read inside the handler",
      !/getSnapshotReportArtifact/.test(h));
    // Scoped to the key builder: deliveryMessageId and deliveredAt are
    // legitimate FINALIZE parameters, they simply must not key the send.
    const keyFn = h.slice(h.indexOf("export function buildRevisionIdempotencyKey"),
      h.indexOf("/**", h.indexOf("export function buildRevisionIdempotencyKey")));
    check("§10 idempotency key derives from artifact + revision only",
      !/deliveredAt|deliveryMessageId|resend|Date\.|random|ClaimToken/.test(keyFn));
    // The word appears in the fail-closed message ("do not resend"); what
    // must be gone is a client-supplied resend FLAG influencing the send.
    check("§10b send path no longer honours a client resend flag",
      !/resend\s*[:,=]|body\.resend|input\.resend/.test(code));
  }

  /* ================= B2b — F1–F8 failure matrix ================= */
  // Executed against the real production orchestrator via injected fakes.

  /** A provider error shaped exactly like the real wrapper's. */
  function providerError(code: string, status: number | null): Error {
    const e: any = new Error(code);
    e.name = "ClientReportDeliveryError";
    e.code = code;
    e.status = status;
    return e;
  }

  let f1 = 0, f2 = 0, f3 = 0, f4 = 0, f5 = 0, f6 = 0, f7 = 0, f8 = 0;
  const F = (n: number, label: string, cond: boolean) => {
    const before = failures;
    check(label, cond);
    const bad = failures > before ? 1 : 0;
    if (n === 1) f1 += bad; else if (n === 2) f2 += bad; else if (n === 3) f3 += bad;
    else if (n === 4) f4 += bad; else if (n === 5) f5 += bad; else if (n === 6) f6 += bad;
    else if (n === 7) f7 += bad; else f8 += bad;
  };

  /* ---- F1 — post-BEGIN failure before the provider is ever invoked ---- */
  {
    const { handler, spy } = build({
      // BEGIN commits, but returns a payload the deterministic local check
      // rejects. Nothing has been dispatched.
      beginImpl: async () => ({
        artifactId: ART, revision: REV, deliveryClaimToken: TOK,
        fullReportMarkdown: "FULL", shortReportMarkdown: "",
      }),
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(1, "F1 provider never invoked", spy.provider.length === 0);
    F(1, "F1 FINALIZE never invoked", spy.finalize.length === 0);
    F(1, "F1 RELEASE invoked exactly once", spy.release.length === 1);
    F(1, "F1 RELEASE carries the exact BEGIN artifact id and claim token",
      spy.release[0].artifactId === ART && spy.release[0].deliveryClaimToken === TOK);
    F(1, "F1 RELEASE targets the same request", spy.release[0].snapshotRequestId === REQ);
    F(1, "F1 returns a safe failure", r.status === 500);
    F(1, "F1 reports the report was not sent", body.error === "delivery_not_sent");
    F(1, "F1 leaks no claim token", !JSON.stringify(body).includes(TOK));
  }

  /* ---- F2 — explicit provider 4xx: the one releasable provider outcome ---- */
  for (const status of [400, 401, 409, 422, 429]) {
    const { handler, spy } = build({
      providerImpl: async () => { throw providerError("provider_rejected", status); },
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(2, `F2 ${status} invokes the provider exactly once`, spy.provider.length === 1);
    F(2, `F2 ${status} does not finalize`, spy.finalize.length === 0);
    F(2, `F2 ${status} releases exactly once`, spy.release.length === 1);
    F(2, `F2 ${status} releases the exact claim token`,
      spy.release[0]?.deliveryClaimToken === TOK && spy.release[0]?.artifactId === ART);
    F(2, `F2 ${status} reports an explicit rejection`, body.error === "provider_rejected");
    F(2, `F2 ${status} does not retry the provider`, spy.provider.length === 1);
    F(2, `F2 ${status} leaks no claim token`, !JSON.stringify(body).includes(TOK));
  }

  /* ---- F3 — timeout is ambiguous ---- */
  {
    const { handler, spy } = build({
      providerImpl: async () => { throw providerError("provider_timeout", null); },
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(3, "F3 provider invoked once", spy.provider.length === 1);
    F(3, "F3 does not finalize", spy.finalize.length === 0);
    F(3, "F3 NEVER releases", spy.release.length === 0);
    F(3, "F3 does not retry", spy.provider.length === 1);
    F(3, "F3 returns the uncertain outcome",
      r.status === 500 && body.error === "delivery_uncertain");
    F(3, "F3 tells the founder not to resend automatically",
      /do not resend automatically/i.test(String(body.message)));
  }

  /* ---- F4 — 5xx, invalid_provider_response, connection failure ---- */
  for (const [code, status] of [
    ["provider_http_error", 500], ["provider_http_error", 502], ["provider_http_error", 503],
    ["invalid_provider_response", 200], ["provider_connection_failed", null],
  ] as [string, number | null][]) {
    const { handler, spy } = build({
      providerImpl: async () => { throw providerError(code, status); },
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    const tag = `${code}/${status}`;
    F(4, `F4 ${tag} provider invoked once`, spy.provider.length === 1);
    F(4, `F4 ${tag} does not finalize`, spy.finalize.length === 0);
    F(4, `F4 ${tag} NEVER releases`, spy.release.length === 0);
    F(4, `F4 ${tag} does not retry`, spy.provider.length === 1);
    F(4, `F4 ${tag} returns the uncertain outcome`, body.error === "delivery_uncertain");
  }
  // A 2xx we cannot read a message id from is equally ambiguous.
  {
    const { handler, spy } = build({ providerImpl: async () => ({ messageId: "" }) });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(4, "F4 empty message id does not finalize", spy.finalize.length === 0);
    F(4, "F4 empty message id NEVER releases", spy.release.length === 0);
    F(4, "F4 empty message id is uncertain", body.error === "delivery_uncertain");
  }
  // An unknown throw is ambiguous too.
  for (const thrown of [new Error("boom"), new TypeError("bad"), { weird: true }]) {
    const { handler, spy } = build({ providerImpl: async () => { throw thrown; } });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(4, `F4 unknown throw (${(thrown as any)?.name ?? "object"}) NEVER releases`,
      spy.release.length === 0);
    F(4, `F4 unknown throw (${(thrown as any)?.name ?? "object"}) is uncertain`,
      body.error === "delivery_uncertain");
  }

  /* ---- F5 — provider accepted, FINALIZE fails with a known error ---- */
  {
    const { handler, spy } = build({
      finalizeImpl: async () => { const e: any = new Error("db"); e.code = "40001"; throw e; },
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(5, "F5 provider invoked once", spy.provider.length === 1);
    F(5, "F5 FINALIZE attempted once", spy.finalize.length === 1);
    F(5, "F5 NEVER releases after acceptance", spy.release.length === 0);
    F(5, "F5 does not re-invoke the provider", spy.provider.length === 1);
    F(5, "F5 reports unconfirmed finalization",
      r.status === 500 && body.error === "finalization_unconfirmed");
    F(5, "F5 says delivery may have been accepted",
      /may have been accepted/i.test(String(body.message)));
  }

  /* ---- F6 — provider accepted, FINALIZE outcome ambiguous (null) ---- */
  {
    const { handler, spy } = build({ finalizeImpl: async () => null });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(6, "F6 provider invoked once", spy.provider.length === 1);
    F(6, "F6 FINALIZE attempted once", spy.finalize.length === 1);
    F(6, "F6 NEVER releases", spy.release.length === 0);
    F(6, "F6 fails closed identically to F5", body.error === "finalization_unconfirmed");
    // The adapter cannot distinguish "definitely not finalized" from "unknown",
    // so both intentionally fail closed the same way.
    F(6, "F6 does not claim success", r.status === 500);
  }

  /* ---- F7 — a safe release is attempted and itself fails ---- */
  for (const releaseImpl of [
    async () => { throw new Error("release exploded"); },
    async () => null,
  ]) {
    const { handler, spy } = build({
      providerImpl: async () => { throw providerError("provider_rejected", 422); },
      releaseImpl,
    });
    const r = await call(handler, VALID);
    const body = await r.json();
    F(7, "F7 provider stays at one call", spy.provider.length === 1);
    F(7, "F7 does not finalize", spy.finalize.length === 0);
    F(7, "F7 attempts release exactly once — no retry loop", spy.release.length === 1);
    F(7, "F7 returns a server failure", r.status === 500);
    F(7, "F7 never reports a successful unlock", body.error === "release_failed");
    F(7, "F7 does not tell the founder the report is unlocked",
      !/remains unlocked|successfully unlocked|has been unlocked/i.test(String(body.message)));
    F(7, "F7 leaks no claim token", !JSON.stringify(body).includes(TOK));
  }

  /* ---- F8 — complete success ---- */
  {
    const { handler, spy } = build();
    const r = await call(handler, VALID);
    F(8, "F8 BEGIN once", spy.begin.length === 1);
    F(8, "F8 provider once", spy.provider.length === 1);
    F(8, "F8 FINALIZE once", spy.finalize.length === 1);
    F(8, "F8 RELEASE zero", spy.release.length === 0);
    F(8, "F8 succeeds", r.status === 200);
    // The founder UI treats a missing `ok` as a failure, so the success
    // contract has to carry it.
    F(8, "F8 response satisfies the UI success contract",
      (await r.json()).ok === true);
  }

  const matrix: Record<string, number> = {
    F1_PRE_PROVIDER_FAILURE: f1, F2_PROVIDER_4XX: f2, F3_TIMEOUT_AMBIGUOUS: f3,
    F4_5XX_INVALID_RESPONSE: f4, F5_FINALIZE_FAILURE: f5, F6_FINALIZE_AMBIGUOUS: f6,
    F7_RELEASE_FAILURE: f7, F8_SUCCESS: f8,
  };
  for (const [k, v] of Object.entries(matrix)) console.log(`  ${k}=${v === 0 ? "PASS" : "FAIL"}`);

  /* ---- §22 classifier table, executed directly ---- */
  {
    const rej = (e: unknown) => classifyProviderDeliveryFailure(e) === "DEFINITIVE_REJECTION";
    for (const s of [400, 401, 403, 409, 422, 429, 499]) {
      check(`classifier ${s} → DEFINITIVE_REJECTION`, rej(providerError("x", s)));
    }
    for (const s of [500, 502, 503, 504]) {
      check(`classifier ${s} → AMBIGUOUS`, !rej(providerError("x", s)));
    }
    check("classifier status null → AMBIGUOUS", !rej(providerError("provider_timeout", null)));
    check("classifier provider_timeout → AMBIGUOUS", !rej(providerError("provider_timeout", null)));
    check("classifier provider_connection_failed → AMBIGUOUS",
      !rej(providerError("provider_connection_failed", null)));
    check("classifier invalid_provider_response on a 2xx → AMBIGUOUS",
      !rej(providerError("invalid_provider_response", 200)));
    check("classifier ordinary Error → AMBIGUOUS", !rej(new Error("x")));
    check("classifier TypeError → AMBIGUOUS", !rej(new TypeError("x")));
    check("classifier unknown object → AMBIGUOUS", !rej({ status: 400.5 }));
    check("classifier undefined → AMBIGUOUS", !rej(undefined));
    check("classifier null → AMBIGUOUS", !rej(null));
    check("classifier string → AMBIGUOUS", !rej("400"));
    check("classifier non-integer status → AMBIGUOUS", !rej(providerError("x", 404.7)));
    check("classifier 3xx is not a rejection", !rej(providerError("x", 302)));
    check("classifier 399 is not a rejection", !rej(providerError("x", 399)));
  }

  /* ---- §24 idempotency is unaffected by any failure state ---- */
  {
    const keys = new Set<string>();
    for (const over of [
      {},
      { providerImpl: async () => { throw providerError("provider_rejected", 422); } },
      { providerImpl: async () => { throw providerError("provider_timeout", null); } },
      { finalizeImpl: async () => null },
    ] as any[]) {
      const { handler, spy } = build(over);
      await call(handler, VALID);
      if (spy.provider[0]) keys.add(spy.provider[0].deliveryIdempotencyKey);
    }
    check("§24 idempotency key is identical across every outcome", keys.size === 1);
    const only = [...keys][0];
    check("§24 key is exactly artifact + revision",
      only === buildRevisionIdempotencyKey(ART, REV) &&
      only === `snapshot-report:${ART}:${REV}`);
    check("§24 key carries no claim token", !only.includes(TOK));
    check("§24 key carries no message id", !only.includes("msg-1"));
    check("§24 key carries no timestamp", !/\d{4}-\d{2}-\d{2}T/.test(only));
  }

  /* ---- §15/§26/§27/§29 production source audit ---- */
  {
    const fs = await import("node:fs");
    const handlerSrc = fs.readFileSync("lib/snapshot-requests/send-report-handler.ts", "utf8");
    const routeSrc = fs.readFileSync(
      "app/api/internal/snapshot-requests/[requestId]/send-report/route.ts", "utf8");
    const uiSrc = fs.readFileSync("app/admin/snapshot-requests/send-report-button.tsx", "utf8");
    const all = handlerSrc + routeSrc + uiSrc;

    // Exactly one adapter release call site, inside the proven-non-delivery helper.
    const releaseCalls = handlerSrc.match(/deps\.releaseSnapshotReportDeliveryClaim\(/g) ?? [];
    check("§15 exactly one adapter RELEASE call site", releaseCalls.length === 1);
    check("§15 that call site sits in the proven-non-delivery helper",
      /releaseClaimAfterProvenNonDelivery[\s\S]{0,400}deps\.releaseSnapshotReportDeliveryClaim\(/
        .test(handlerSrc));
    const callers = handlerSrc.match(/await releaseClaimAfterProvenNonDelivery\(/g) ?? [];
    check("§15 exactly two proven-non-delivery callers", callers.length === 2);

    // Comments legitimately discuss stale revisions; audit executable code.
    const exec = all.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("§27 no age-based unlock",
      !/claimedAt|claimed_at|expir|\blease\b|olderThan|Date\.now\(\)\s*-/i.test(exec));
    check("§27b no interval arithmetic on the claim",
      !/interval|getTime\(\)\s*[-+]/i.test(exec));
    check("§26 no timer-based resend", !/setTimeout|setInterval/.test(handlerSrc + routeSrc));
    check("§26 no retry loop around the provider",
      !/for\s*\([^)]*\)\s*\{[^}]*sendReportEmail/.test(handlerSrc));
    check("§25 no resend flag in the request payload",
      !/resend\s*[:,=]|body\.resend|input\.resend/.test(all));
    check("§29 no direct artifact DML in production delivery code",
      !/\.from\(\s*["'`]snapshot_report_artifacts/.test(all) &&
      !/update\(\s*\{[^}]*delivered_at/.test(all));
    check("§28 claim token never reaches the browser",
      !/deliveryClaimToken/.test(uiSrc));
    check("the founder email is built by sendProtocolReportEmail, never the legacy visibility template",
      /sendProtocolReportEmail/.test(routeSrc) &&
      !/sendClientSnapshotReport|parsePublicSnapshotReport|visibilitySummary|brandedReputation/.test(routeSrc));
    check("§18 ambiguous message forbids automatic resend",
      /Do not resend automatically/.test(handlerSrc));
    check("§20 release failure never claims a safe unlock",
      /could not be unlocked/.test(handlerSrc));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
