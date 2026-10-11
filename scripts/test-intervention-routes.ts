/**
 * Phase 2 — intervention routes and the action layer beneath them.
 *
 * The action layer is driven against a fake Supabase client that records
 * every table read and RPC call. That is what lets this test assert the two
 * properties that matter most and that a happy-path test would miss:
 *
 *   - project identity is taken from the STORED row, never from anything the
 *     caller supplied, so a cross-tenant call cannot be dressed up as valid;
 *   - an RPC returning ZERO rows is reported as a refusal. The transition
 *     RPCs answer a disallowed transition with an empty set, not an error,
 *     so "no error" must never be read as "done".
 *
 * It does not prove the RPCs themselves — the 0071-0077 runtime contracts do
 * that against real PostgreSQL.
 */

delete process.env.INTERVENTION_ADMIN_ENABLED;

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  abandonIntervention,
  recordDeviation,
  approveIntervention,
  confirmImplementation,
  listInterventions,
  readEligibility,
  registerIntervention,
  rejectIntervention,
} from "@/lib/interventions/intervention-actions";
import { parseConfirmBody, parseDeviationBody, parseReasonBody, parseRegisterBody } from "@/lib/interventions/validate";
import { readDeviationLedger } from "@/lib/interventions/deviation-ledger";
import { transitionHandler } from "@/lib/interventions/route-handlers";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

// ---------------------------------------------------------------- fake client
type Row = Record<string, unknown>;
interface RpcCall { name: string; args: Record<string, unknown> }

function fakeClient(opts: {
  tables?: Record<string, Row[]>;
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };
}) {
  const rpcCalls: RpcCall[] = [];
  const tables = opts.tables ?? {};

  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      order: () => q,
      limit: (n: number) => { rows = rows.slice(0, n); return q; },
      eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return q; },
      in: (col: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  }

  const client = {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: [], error: null };
    },
  } as unknown as SupabaseClient;

  return { client, rpcCalls };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const BASELINE = "22222222-2222-4222-8222-222222222222";
const RETEST = "33333333-3333-4333-8333-333333333333";
const IV = "44444444-4444-4444-8444-444444444444";
const ACTOR = "55555555-5555-4555-8555-555555555555";

function ivRow(status: string, extra: Row = {}): Row {
  return {
    id: IV, project_id: PROJECT, protocol_id: BASELINE, buyer_question_version_id: "bqv",
    status, hypothesis: "h", expected_mechanism: "m", action_type: "page_created",
    action_target: "https://x.example", owner: "o", supporting_evidence: ["run-1"],
    created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z", ...extra,
  };
}

const validRegister = {
  protocolId: BASELINE,
  hypothesis: "A comparison page will get us cited for the shortlist question.",
  expectedMechanism: "Sonar retrieves comparison pages for shortlist prompts.",
  actionType: "page_created",
  actionTarget: "https://x.example/compare",
  owner: "Client marketing",
  supportingEvidence: ["run-1", "run-2"],
  expectedObservationDays: 21,
};

async function main(): Promise<void> {
  console.log("\nIntervention routes (Phase 2)\n");

  /* ═══════════ 1. validation ═══════════ */
  console.log("[1] Body validation");
  const ok = parseRegisterBody(validRegister);
  check("a complete registration parses", ok.ok);

  const smuggled = parseRegisterBody({ ...validRegister, projectId: OTHER_PROJECT });
  check("a client-supplied projectId is dropped, not trusted",
    smuggled.ok && !("projectId" in smuggled.value));

  const noDays = parseRegisterBody({ ...validRegister, expectedObservationDays: undefined });
  check("the observation window is required — it cannot be set later",
    !noDays.ok && noDays.error === "invalid_observation_days");
  check("a fractional window is refused",
    !parseRegisterBody({ ...validRegister, expectedObservationDays: 2.5 }).ok);

  const noEvidence = parseRegisterBody({ ...validRegister, supportingEvidence: [] });
  check("empty evidence is allowed at registration (the honest needs_evidence state)",
    noEvidence.ok && noEvidence.value.supportingEvidence.length === 0);
  const dupEvidence = parseRegisterBody({ ...validRegister, supportingEvidence: ["run-1", " run-1 "] });
  check("duplicate evidence ids collapse", dupEvidence.ok && dupEvidence.value.supportingEvidence.length === 1);

  check("an invented action type is refused",
    !parseRegisterBody({ ...validRegister, actionType: "Social Proof" }).ok);
  check("hypothesis and mechanism are separately required",
    !parseRegisterBody({ ...validRegister, expectedMechanism: "  " }).ok);
  check("a non-uuid protocol id is refused",
    !parseRegisterBody({ ...validRegister, protocolId: "not-a-uuid" }).ok);

  check("a blank reason is refused", !parseReasonBody({ reason: "   " }, "Reason").ok);
  check("a missing body is refused", !parseReasonBody(undefined, "Reason").ok);

  check("empty implementation evidence proves nothing and is refused",
    !parseConfirmBody({ evidence: {} }).ok);
  const upper = parseConfirmBody({ evidence: { url: "https://x" }, artifactSha256: "A".repeat(64) });
  check("an uppercase hash is normalised to the lowercase 0071 requires",
    upper.ok && upper.value.artifactSha256 === "a".repeat(64));
  check("a malformed hash is refused",
    !parseConfirmBody({ evidence: { url: "https://x" }, artifactSha256: "abc" }).ok);

  /* ═══════════ 2. registration ═══════════ */
  console.log("\n[2] registerIntervention");
  const input = (ok as { ok: true; value: Parameters<typeof registerIntervention>[1] }).value;

  {
    const { client, rpcCalls } = fakeClient({ tables: { protocols: [] } });
    const r = await registerIntervention(client, input);
    check("a missing protocol is a 404", !r.ok && r.failure.status === 404);
    check("and the RPC is never called", rpcCalls.length === 0);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { protocols: [{ id: BASELINE, project_id: PROJECT, status: "completed", baseline_protocol_id: RETEST }] },
    });
    const r = await registerIntervention(client, input);
    check("registering against a retest protocol is refused",
      !r.ok && r.failure.error === "not_a_baseline" && r.failure.status === 409);
    check("and the RPC is never called", rpcCalls.length === 0);
  }
  const baselineProtocol = { id: BASELINE, project_id: PROJECT, status: "approved", baseline_protocol_id: null };
  const goodAttempts = [
    { id: "run-1", protocol_id: BASELINE, attempt_kind: "baseline", status: "completed" },
    { id: "run-2", protocol_id: BASELINE, attempt_kind: "baseline", status: "completed" },
  ];
  {
    // D-009: a run from ANOTHER protocol (another question) is refused.
    const { client, rpcCalls } = fakeClient({
      tables: {
        protocols: [baselineProtocol],
        protocol_attempts: [goodAttempts[0], { ...goodAttempts[1], protocol_id: RETEST }],
      },
    });
    const r = await registerIntervention(client, input);
    check("evidence from another protocol is refused",
      !r.ok && r.failure.error === "evidence_not_from_this_baseline");
    check("and the RPC is never called", rpcCalls.length === 0);
  }
  {
    const { client } = fakeClient({
      tables: {
        protocols: [baselineProtocol],
        protocol_attempts: [goodAttempts[0], { ...goodAttempts[1], status: "failed" }],
      },
    });
    const r = await registerIntervention(client, input);
    check("a failed attempt cannot be cited — it observed nothing",
      !r.ok && r.failure.error === "evidence_not_from_this_baseline");
  }
  {
    const { client } = fakeClient({
      tables: { protocols: [baselineProtocol], protocol_attempts: [goodAttempts[0]] },
    });
    const r = await registerIntervention(client, input);
    check("an id that is not an attempt at all is refused",
      !r.ok && r.failure.message.startsWith("1 cited run is"));
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { protocols: [baselineProtocol], protocol_attempts: goodAttempts },
      rpc: () => ({ data: [ivRow("proposed")], error: null }),
    });
    const r = await registerIntervention(client, input);
    check("a baseline registration succeeds", r.ok && r.intervention.status === "proposed");
    check("the RPC receives the project id from the stored protocol row",
      rpcCalls[0]?.args.p_project_id === PROJECT);
    check("the observation window is passed at registration",
      rpcCalls[0]?.args.p_expected_observation_days === 21);
  }
  {
    const { client } = fakeClient({
      tables: { protocols: [baselineProtocol], protocol_attempts: goodAttempts },
      rpc: () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
    });
    const r = await registerIntervention(client, input);
    check("a second live intervention on one baseline maps to already_live",
      !r.ok && r.failure.error === "already_live");
  }

  /* ═══════════ 3. transitions ═══════════ */
  console.log("\n[3] Transitions");
  {
    const { client, rpcCalls } = fakeClient({ tables: { interventions: [] } });
    const r = await approveIntervention(client, IV, ACTOR);
    check("an unknown intervention is a 404", !r.ok && r.failure.status === 404);
    check("and no RPC is called for it", rpcCalls.length === 0);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [ivRow("proposed")] },
      rpc: () => ({ data: [ivRow("approved")], error: null }),
    });
    const r = await approveIntervention(client, IV, ACTOR);
    check("approve succeeds", r.ok && r.intervention.status === "approved");
    check("the RPC receives the stored project id", rpcCalls[0]?.args.p_project_id === PROJECT);
    check("the actor comes from the caller's session argument", rpcCalls[0]?.args.p_approved_by === ACTOR);
  }
  {
    // The important one: reject_intervention on an APPROVED row returns zero
    // rows and no error. It must not be reported as done.
    const { client } = fakeClient({
      tables: { interventions: [ivRow("approved")] },
      rpc: () => ({ data: [], error: null }),
    });
    const r = await rejectIntervention(client, IV, ACTOR, "too late");
    check("an empty RPC result is a refusal, not a success",
      !r.ok && r.failure.error === "invalid_transition" && r.failure.status === 409);
    check("the refusal names the current status",
      !r.ok && r.failure.message.includes("'approved'"));
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [ivRow("implemented")] },
      rpc: () => ({ data: null, error: { code: "P0001", message: "retest_already_started" } }),
    });
    const r = await abandonIntervention(client, IV, ACTOR, "results look bad");
    check("the 0077 refusal surfaces as retest_already_started",
      !r.ok && r.failure.error === "retest_already_started" && r.failure.status === 409);
  }
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [ivRow("approved")] },
      rpc: () => ({ data: [ivRow("implemented")], error: null }),
    });
    await confirmImplementation(client, IV, ACTOR, {
      evidence: { url: "https://x.example/compare" }, artifactSha256: null, deviations: null,
    });
    check("confirm passes evidence as an object, as 0072 requires",
      typeof rpcCalls[0]?.args.p_evidence === "object" && !Array.isArray(rpcCalls[0]?.args.p_evidence));
  }

  /* ═══════════ 3b. deviations after implementation (0082) ═══════════ */
  console.log("\n[3b] Recording a deviation after implementation");
  {
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: [ivRow("implemented")] },
      rpc: () => ({ data: [ivRow("implemented")], error: null }),
    });
    const r = await recordDeviation(client, IV, ACTOR, "Homepage rebuilt on day 5.");
    check("it calls record_intervention_deviation", rpcCalls[0]?.name === "record_intervention_deviation");
    check("the project comes from the stored row, and the actor and note are passed",
      rpcCalls[0]?.args.p_project_id === PROJECT && rpcCalls[0]?.args.p_recorded_by === ACTOR &&
      rpcCalls[0]?.args.p_note === "Homepage rebuilt on day 5.");
    check("a returned row is a success", r.ok);
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [ivRow("approved")] },
      rpc: () => ({ data: [], error: null }),
    });
    const r = await recordDeviation(client, IV, ACTOR, "too early");
    check("an intervention that is not implemented is refused, not silently accepted",
      !r.ok && r.failure.error === "invalid_transition" && r.failure.message.includes("'approved'"));
  }
  {
    const { client } = fakeClient({
      tables: { interventions: [ivRow("implemented")] },
      rpc: () => ({ data: null, error: { code: "22023", message: "deviation_note_too_long" } }),
    });
    const r = await recordDeviation(client, IV, ACTOR, "x");
    check("the database's length refusal is mapped",
      !r.ok && r.failure.error === "deviation_note_too_long" && r.failure.status === 400);
  }
  {
    check("a body without a note is refused", !parseDeviationBody({}).ok && !parseDeviationBody({ note: "   " }).ok);
    check("a non-object body is refused", !parseDeviationBody("note").ok);
    const ok = parseDeviationBody({ note: "  Homepage rebuilt.  " });
    check("the note is trimmed", ok.ok && ok.value === "Homepage rebuilt.");
    check("a note over 4000 characters is refused before the database is asked",
      !parseDeviationBody({ note: "x".repeat(4001) }).ok);
  }
  {
    const { client } = fakeClient({
      tables: {
        intervention_deviations: [
          { id: "d1", intervention_id: IV, project_id: PROJECT, note: "n1", recorded_by: ACTOR, recorded_at: "2026-10-01T00:00:00Z", retest_attempts_at_record: 0, card_delivered_at_record: false },
          { id: "d2", intervention_id: IV, project_id: PROJECT, note: "n2", recorded_by: ACTOR, recorded_at: "2026-10-10T00:00:00Z", retest_attempts_at_record: 5, card_delivered_at_record: true },
          { id: "d3", intervention_id: IV, project_id: OTHER_PROJECT, note: "foreign", recorded_by: ACTOR, recorded_at: "2026-10-10T00:00:00Z", retest_attempts_at_record: 0, card_delivered_at_record: false },
        ],
      },
    });
    const rows = await readDeviationLedger(client, { id: IV, projectId: PROJECT });
    check("the ledger read is scoped to the intervention's own project",
      rows.length === 2 && rows.every((r) => r.note !== "foreign"));
    check("the database's state stamps are carried through",
      rows[1].retestAttemptsAtRecord === 5 && rows[1].cardDeliveredAtRecord === true && rows[0].cardDeliveredAtRecord === false);
  }
  {
    const failing = (code: string) => ({
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q; q.order = () => q;
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code, message: "x" } });
        return q;
      },
    }) as unknown as SupabaseClient;
    check("an environment without the ledger table reads as no deviations",
      (await readDeviationLedger(failing("42P01"), { id: IV, projectId: PROJECT })).length === 0 &&
      (await readDeviationLedger(failing("PGRST205"), { id: IV, projectId: PROJECT })).length === 0);
    let threw = false;
    try { await readDeviationLedger(failing("42501"), { id: IV, projectId: PROJECT }); } catch { threw = true; }
    check("any other read failure throws, and is never reported as 'no deviations'", threw);
  }

  /* ═══════════ 4. eligibility reads ═══════════ */
  console.log("\n[4] Eligibility comes from the authority");
  {
    const { client, rpcCalls } = fakeClient({
      rpc: () => ({ data: [{ eligible: false, reason: "OBSERVATION_WINDOW_OPEN", window_closes_at: "2026-10-09T00:00:00Z", authorized_early: false }], error: null }),
    });
    const e = await readEligibility(client, { id: IV, projectId: PROJECT });
    check("readEligibility calls retest_eligibility", rpcCalls[0]?.name === "retest_eligibility");
    check("and presents the closing date", e.label === "Observing — closes Oct 9, 2026", e.label);
  }
  {
    const rows = [
      ivRow("proposed", { id: "a" }),
      ivRow("implemented", { id: "b" }),
      ivRow("rejected", { id: "c" }),
    ];
    const { client, rpcCalls } = fakeClient({
      tables: { interventions: rows, projects: [{ id: PROJECT, company_name: "Fixture Co", domain: "fixture.example" }] },
      rpc: () => ({ data: [{ eligible: true, reason: "WINDOW_ELAPSED", window_closes_at: null, authorized_early: false }], error: null }),
    });
    const items = await listInterventions(client);
    check("the list returns every row", items.length === 3);
    check("eligibility is asked only for the implemented row",
      rpcCalls.filter((c) => c.name === "retest_eligibility").length === 1);
    check("non-implemented rows carry no eligibility claim",
      items.filter((i) => i.eligibility === null).length === 2);
    check("company is joined from projects", items[0]?.companyName === "Fixture Co");
  }

  /* ═══════════ 5. the kill switch runs first ═══════════ */
  console.log("\n[5] Nothing is read before the guard");
  let bodyRead = false;
  const trap = {
    json: async () => { bodyRead = true; return {}; },
  } as unknown as Request;
  const handler = transitionHandler<null>({
    route: "test", event: "test",
    parse: () => ({ ok: true, value: null }),
    act: async () => { throw new Error("act must not run"); },
  });
  const res = await handler(trap, { params: Promise.resolve({ interventionId: IV }) });
  check("with the kill switch unset the route answers 503", res.status === 503);
  check("and never reads the request body", !bodyRead);

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
