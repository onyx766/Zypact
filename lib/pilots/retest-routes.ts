/**
 * D-062 — the pilot retest's six founder routes, as handlers whose
 * environment, guard and database are passed in by their route files, so
 * the tests run exactly the code the routes run (as B's engine-routes.ts):
 *
 *   POST /api/internal/pilots/[pilotId]/retests                         register      gated
 *   POST …/retests/[retestId]/implementation                              record live   gated
 *   POST …/retests/[retestId]/prepare                                     prepare       gated
 *   POST …/retests/[retestId]/requeue                                     queue again   gated
 *   POST …/retests/[retestId]/abandon                                     withdraw      not gated
 *   POST …/retests/[retestId]/notes                                       log a change  not gated
 *
 * Every route checks, in this order: the console's kill switch
 * (SNAPSHOT_APPROVAL_ENABLED exactly "true"), the founder guard, the retest
 * gate (ZYPACT_PILOT_RETEST_ENABLED exactly "true") on the gated routes, the
 * ids, then the body (JSON of at most 16 KB, parsed and linted). Withdrawing
 * and logging spend nothing and are forward recovery once the gate is off
 * again, so they are not gated.
 *
 * None of them starts the worker or reserves anything: a retest runs only
 * through the pilot page's Run, with `phase: "retest"`. The actor always
 * comes from the session. Logs carry closed fields only (ids, outcome,
 * engine): never registered text, a reference, a link, a note or a reason.
 */
import { NextResponse } from "next/server";

import type { FounderRouteGuard } from "@/lib/auth/founder";
import type { DbAdapter } from "@/lib/db/types";
import { pilotRetestEnabled } from "@/lib/pilots/engines";
import { PILOT_RETEST_NOT_ENABLED, PILOT_RETEST_UNAVAILABLE } from "@/lib/pilots/retest-copy";
import {
  parseAbandonRetest,
  parseConfirmRetest,
  parseRegisterRetest,
  parseRequeueRetest,
  parseRetestNote,
} from "@/lib/pilots/retest-rules";
import {
  abandonRetestStep,
  addRetestNoteStep,
  confirmRetestStep,
  prepareRetestStep,
  registerRetestStep,
  requeueRetestStep,
  type RetestStepResult,
} from "@/lib/pilots/retest-store";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";

type Env = Readonly<Record<string, string | undefined>>;

export const MAX_RETEST_BODY_BYTES = 16_384;
/**
 * (engineer) The register body alone may be larger: its ten registered texts
 * are each allowed up to 2,000 characters (the pilot_retests CHECKs), 20,000
 * in all, which a 16 KB limit would refuse. Every other route keeps 16 KB.
 */
export const MAX_REGISTER_BODY_BYTES = 32_768;

type RetestDb = Pick<
  DbAdapter,
  | "registerPilotRetest"
  | "confirmPilotRetestImplementation"
  | "preparePilotRetests"
  | "abandonPilotRetest"
  | "requeuePilotRetestJob"
  | "addPilotRetestNote"
>;

export interface PilotRetestRouteDeps {
  env: Env;
  guard: () => Promise<FounderRouteGuard>;
  db: () => RetestDb;
  /** A question's ordinal, to name it in a register refusal; null when it cannot be read. */
  questionOrdinal?: (pilotQuestionId: string) => Promise<number | null>;
  today?: () => string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

function info(event: string, fields: Record<string, unknown>, log: (line: string) => void): void {
  log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...fields }));
}

const json = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status });

/** The order every route keeps: kill switch, founder guard, gate, ids. */
async function opening(
  ids: Record<string, string>,
  deps: PilotRetestRouteDeps,
  gated: boolean
): Promise<{ ok: true; actor: string } | { ok: false; response: NextResponse }> {
  if (deps.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return { ok: false, response: json({ ok: false, error: PILOT_RETEST_UNAVAILABLE }, 503) };
  }
  const guard = await deps.guard();
  if (!guard.ok) return { ok: false, response: guard.response };
  if (gated && !pilotRetestEnabled(deps.env)) {
    return { ok: false, response: json({ ok: false, error: PILOT_RETEST_NOT_ENABLED }, 409) };
  }
  if (Object.values(ids).some((id) => !UUID_PATTERN.test(id))) {
    return { ok: false, response: json({ ok: false, error: "invalid_id" }, 400) };
  }
  return { ok: true, actor: guard.user.id };
}

async function readBody(
  request: Request,
  limit: number = MAX_RETEST_BODY_BYTES
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > limit) return { ok: false, response: json({ ok: false, error: "request_body_too_large" }, 413) };
  if (raw.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: json({ ok: false, error: "invalid_body" }, 400) };
  }
}

function invalid(issues: Record<string, string[]>): NextResponse {
  return json({ ok: false, error: "Some fields need attention.", issues }, 400);
}

function answer(
  event: string,
  result: RetestStepResult,
  fields: Record<string, unknown>,
  deps: PilotRetestRouteDeps
): NextResponse {
  info(event, { ...fields, outcome: result.outcome, ok: result.ok }, deps.log ?? console.info);
  return result.ok
    ? json({ ok: true, outcome: result.outcome, detail: result.detail, ...(result.extra ?? {}) }, result.status)
    : json({ ok: false, outcome: result.outcome, error: result.detail }, result.status);
}

function unmapped(route: string, deps: PilotRetestRouteDeps) {
  // The database's own text goes to the server log only, never to the founder.
  return (d: { code: string | null; message: string | null }) =>
    (deps.logError ?? console.error)(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "pilot_retest_rpc_unmapped_error", route, code: d.code, message: d.message })
    );
}

/* ---------------------------------------------------------------- the six handlers */

export async function handleRegisterPilotRetest(
  request: Request,
  ids: { pilotId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, true);
  if (!open.ok) return open.response;
  const read = await readBody(request, MAX_REGISTER_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseRegisterRetest(read.body, (deps.today ?? todayUtc)());
  if (!parsed.ok) return invalid(parsed.issues);
  const result = await registerRetestStep(
    deps.db(),
    {
      pilotId: ids.pilotId,
      registeredBy: open.actor,
      fields: parsed.value,
      // Read only for a per-question refusal, to name the question.
      ordinalOf: (id) => (deps.questionOrdinal ? deps.questionOrdinal(id) : Promise.resolve(null)),
    },
    unmapped("pilot-retest-register", deps)
  );
  return answer(
    "pilot_retest_register",
    result,
    { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: result.extra?.pilotRetestId ?? null, questions: parsed.value.pilotQuestionIds.length },
    deps
  );
}

export async function handleConfirmPilotRetest(
  request: Request,
  ids: { pilotId: string; retestId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, true);
  if (!open.ok) return open.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const parsed = parseConfirmRetest(read.body, (deps.today ?? todayUtc)());
  if (!parsed.ok) return invalid(parsed.issues);
  const result = await confirmRetestStep(
    deps.db(),
    { pilotId: ids.pilotId, pilotRetestId: ids.retestId, confirmedBy: open.actor, fields: parsed.value },
    unmapped("pilot-retest-implementation", deps)
  );
  return answer("pilot_retest_implementation", result, { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: ids.retestId }, deps);
}

export async function handlePreparePilotRetests(
  request: Request,
  ids: { pilotId: string; retestId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, true);
  if (!open.ok) return open.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const result = await prepareRetestStep(
    deps.db(),
    { pilotId: ids.pilotId, pilotRetestId: ids.retestId, preparedBy: open.actor },
    unmapped("pilot-retest-prepare", deps)
  );
  return answer("pilot_retest_prepare", result, { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: ids.retestId }, deps);
}

export async function handleRequeuePilotRetest(
  request: Request,
  ids: { pilotId: string; retestId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, true);
  if (!open.ok) return open.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const parsed = parseRequeueRetest(read.body);
  if (!parsed.ok) return invalid(parsed.issues);
  const result = await requeueRetestStep(
    deps.db(),
    { pilotId: ids.pilotId, pilotRetestId: ids.retestId, requeuedBy: open.actor, fields: parsed.value },
    unmapped("pilot-retest-requeue", deps)
  );
  return answer(
    "pilot_retest_requeue",
    result,
    { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: ids.retestId, pilotQuestionId: parsed.value.pilotQuestionId, engine: parsed.value.engine },
    deps
  );
}

export async function handleAbandonPilotRetest(
  request: Request,
  ids: { pilotId: string; retestId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, false);
  if (!open.ok) return open.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const parsed = parseAbandonRetest(read.body);
  if (!parsed.ok) return invalid(parsed.issues);
  const result = await abandonRetestStep(
    deps.db(),
    { pilotId: ids.pilotId, pilotRetestId: ids.retestId, abandonedBy: open.actor, fields: parsed.value },
    unmapped("pilot-retest-abandon", deps)
  );
  return answer("pilot_retest_abandon", result, { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: ids.retestId }, deps);
}

export async function handleAddPilotRetestNote(
  request: Request,
  ids: { pilotId: string; retestId: string },
  deps: PilotRetestRouteDeps
): Promise<NextResponse> {
  const open = await opening(ids, deps, false);
  if (!open.ok) return open.response;
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const parsed = parseRetestNote(read.body, (deps.today ?? todayUtc)());
  if (!parsed.ok) return invalid(parsed.issues);
  const result = await addRetestNoteStep(
    deps.db(),
    { pilotId: ids.pilotId, pilotRetestId: ids.retestId, writtenBy: open.actor, fields: parsed.value },
    unmapped("pilot-retest-note", deps)
  );
  return answer(
    "pilot_retest_note",
    result,
    { actorUserId: open.actor, pilotId: ids.pilotId, pilotRetestId: ids.retestId, noteId: result.extra?.noteId ?? null, kind: parsed.value.kind },
    deps
  );
}
