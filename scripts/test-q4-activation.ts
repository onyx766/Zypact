#!/usr/bin/env tsx
/**
 * Q4 (D-049), offline: consent text and its hash, approval input parsing,
 * the approve/archive handlers over a fake store, the draft-to-question
 * view, the routes' shape, and the claim-language lint. The SQL is proved by
 * scripts/test-q4-activation-db.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import * as activation from "@/lib/workspace/activation";
import {
  APPROVAL_CONSENT_SHA256,
  APPROVAL_CONSENT_TEXT,
  APPROVAL_CONSENT_VERSION,
  draftActivation,
  handleApproveDraft,
  handleArchiveActive,
  parseApproval,
} from "@/lib/workspace/activation";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import type { WorkspaceDeps } from "@/lib/workspace/handlers";
import type { ActiveQuestions, ApproveStatus, QuestionDraft, WorkspaceStore } from "@/lib/workspace/store";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const UUID = "11111111-2222-4333-8444-555555555555";
const KEY = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const account = {
  accountId: UUID,
  email: "person@example.test",
  workspaceName: "Acme",
  session: { status: "ACTIVE" as const, sessionId: UUID, workspaceId: UUID, membershipId: UUID, stepUpAt: null, absoluteExpiresAt: "2026-12-01T00:00:00Z" },
};

function deps(store: Partial<WorkspaceStore>, logs: Array<Record<string, unknown>> = []): WorkspaceDeps {
  return {
    config: { enabled: true, diagnosticEnabled: true, hmacSecret: "s".repeat(32), hmacKeyId: "k1" },
    store: store as WorkspaceStore,
    runDiagnostic: () => {
      throw new Error("not expected");
    },
    log: (e) => logs.push(e),
  };
}

const approving = (status: ApproveStatus, calls: string[] = []) => ({
  async approveDraft(_t: string, _a: string, draftId: string, v: number, key: string, cv: string, cs: string) {
    calls.push(`${draftId}:${v}:${key}:${cv}:${cs}`);
    return { status, buyerQuestionId: status === "ACTIVATED" ? UUID : null, versionId: status === "ACTIVATED" ? UUID : null };
  },
});

const body = { draftId: UUID, expectedVersion: 2, idempotencyKey: KEY, consentVersion: APPROVAL_CONSENT_VERSION };

function draft(id: string, text: string): QuestionDraft {
  return { id, version: 1, text, category: "discovery", origin: "customer_written", suggestionRule: null, status: "draft", createdAt: "", updatedAt: "" };
}

async function main(): Promise<void> {
  console.log("test-q4-activation");

  /* C: consent ------------------------------------------------------ */
  check("C1 the consent version matches the database pattern", /^q4\.[a-z_]{3,40}\.v[0-9]{1,3}$/.test(APPROVAL_CONSENT_VERSION));
  check("C2 the consent hash is the SHA-256 of the shown text", APPROVAL_CONSENT_SHA256 === createHash("sha256").update(APPROVAL_CONSENT_TEXT).digest("hex"));
  check("C3 the consent says approval starts no measurement", APPROVAL_CONSENT_TEXT.includes("does not start a measurement"));
  check("C4 the consent says earlier versions are kept", APPROVAL_CONSENT_TEXT.includes("earlier versions and their results are kept"));

  /* P: parsing ------------------------------------------------------ */
  check("P1 a valid approval parses and lowercases the key", (() => {
    const p = parseApproval({ ...body, idempotencyKey: KEY.toUpperCase() });
    return p.ok && p.idempotencyKey === KEY;
  })());
  check("P2 a non-uuid key is refused", !parseApproval({ ...body, idempotencyKey: "retry-1" }).ok);
  check("P3 an old consent version is refused", !parseApproval({ ...body, consentVersion: "q4.activate.v0" }).ok);
  check("P4 a version below 1 is refused", !parseApproval({ ...body, expectedVersion: 0 }).ok);

  /* H: handlers ----------------------------------------------------- */
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const ok = await handleApproveDraft(deps(approving("ACTIVATED", calls), logs), account, "tok", body);
  check("H1 an approval passes the server's consent version and hash", ok.status === 200 && calls[0] === `${UUID}:2:${KEY}:${APPROVAL_CONSENT_VERSION}:${APPROVAL_CONSENT_SHA256}`);
  const forged: string[] = [];
  await handleApproveDraft(deps(approving("ACTIVATED", forged)), account, "tok", { ...body, consentSha256: "f".repeat(64), consentText: "anything" });
  check("H2 the client cannot choose the consent hash", forged.length === 1 && forged[0].endsWith(APPROVAL_CONSENT_SHA256) && !forged[0].includes("f".repeat(64)));
  const step = await handleApproveDraft(deps(approving("STEP_UP_REQUIRED")), account, "tok", body);
  check("H3 STEP_UP_REQUIRED is 403 step_up_required", step.status === 403 && step.body.error === "step_up_required");
  const limit = await handleApproveDraft(deps(approving("LIMIT_REACHED")), account, "tok", body);
  check("H4 LIMIT_REACHED is 409 limit_reached", limit.status === 409 && limit.body.error === "limit_reached");
  for (const s of ["VERSION_ADDED", "REACTIVATED", "UNCHANGED", "ALREADY_APPROVED"] as const) {
    const r = await handleApproveDraft(deps(approving(s)), account, "tok", body);
    check(`H5 ${s} is 200`, r.status === 200 && r.body.status === s.toLowerCase());
  }
  for (const s of ["NO_WEBSITE", "NOT_FOUND", "VERSION_CONFLICT", "DRAFT_ARCHIVED", "ALREADY_ACTIVE_WORDING", "IDEMPOTENCY_KEY_CONFLICT"] as const) {
    const r = await handleApproveDraft(deps(approving(s)), account, "tok", body);
    check(`H6 ${s} is a refusal with a message`, r.status >= 400 && typeof r.body.message === "string");
  }
  check("H7 the database rejecting the session is 401", (await handleApproveDraft(deps(approving("NOT_SIGNED_IN")), account, "tok", body)).status === 401);
  check("H8 no session is 401 before the store", (await handleApproveDraft(deps({}), null, null, body)).status === 401);
  check("H9 logs carry closed fields only", JSON.stringify(logs) === JSON.stringify([{ event: "workspace_approve_draft", outcome: "activated" }]));
  const arch = await handleArchiveActive(deps({ archiveActive: async () => "ARCHIVED" }), account, "tok", { buyerQuestionId: UUID });
  check("H10 archive is 200", arch.status === 200 && arch.body.status === "archived");
  check("H11 archive of a foreign question is 404", (await handleArchiveActive(deps({ archiveActive: async () => "NOT_FOUND" }), account, "tok", { buyerQuestionId: UUID })).status === 404);
  check("H12 archive needs a uuid", (await handleArchiveActive(deps({}), account, "tok", { buyerQuestionId: "x" })).status === 400);

  /* V: draft view --------------------------------------------------- */
  const active: ActiveQuestions = {
    limit: 1,
    activeCount: 1,
    questions: [
      { buyerQuestionId: "q1", draftId: "d1", active: true, since: "", versions: [{ id: "v1", number: 1, text: "Old wording here", category: "discovery", approvedAt: "" }, { id: "v2", number: 2, text: "Current wording", category: "discovery", approvedAt: "" }] },
      { buyerQuestionId: "q2", draftId: "d2", active: false, since: "", versions: [{ id: "v3", number: 1, text: "Archived one", category: "discovery", approvedAt: "" }] },
    ],
  };
  check("V1 an unapproved draft is not_approved", draftActivation(draft("d9", "x x x x x"), active).kind === "not_approved");
  check("V2 a draft matching its latest version is active_current", (() => {
    const a = draftActivation(draft("d1", "Current wording"), active);
    return a.kind === "active_current" && a.version === 2;
  })());
  check("V3 a draft edited since approval is active_changed", draftActivation(draft("d1", "Newer wording"), active).kind === "active_changed");
  check("V4 a draft whose question is archived is archived", draftActivation(draft("d2", "Archived one"), active).kind === "archived");
  check("V5 no list means not_approved", draftActivation(draft("d1", "Current wording"), null).kind === "not_approved");

  /* R: routes ------------------------------------------------------- */
  for (const r of ["app/api/account/questions/approve/route.ts", "app/api/account/questions/archive-active/route.ts"]) {
    const src = readFileSync(r, "utf8");
    check(`R1 ${r} is POST-only through workspacePost`, src.includes("export const POST = workspacePost(") && !/export (async )?function (GET|PUT|PATCH|DELETE)/.test(src));
  }
  const forms = readFileSync("app/account/workspace-forms.tsx", "utf8");
  check("R2 the browser never imports the activation module (it holds the consent hash logic)", !forms.includes("@/lib/workspace/activation"));
  check("R3 the approve button retries with the same idempotency key", /useState\(\(\) => crypto\.randomUUID\(\)\)/.test(forms) && forms.includes("idempotencyKey: key"));

  /* L: claim language ------------------------------------------------ */
  for (const [k, v] of Object.entries(activation)) {
    if (typeof v !== "string") continue;
    const hit = FORBIDDEN_W1_PHRASES.find((p) => v.toLowerCase().includes(p));
    check(`L ${k}`, !hit, hit ?? "");
  }

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
