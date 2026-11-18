/**
 * D-061 — the pilot console's two new founder actions, as handlers whose
 * guard, environment, database and client are passed in by their route
 * files, so the tests run exactly the code the routes run:
 *
 *   questions/[pilotQuestionId]/engines   adds the ChatGPT baseline to a
 *                                         question (add_pilot_question_engine);
 *   questions/[pilotQuestionId]/review    resolves one engine's measurement
 *                                         held for review, with the request
 *                                         page's resolutions and note rules
 *                                         (resolve_protocol_job_review).
 *
 * And the follow-up the add-question route makes when the founder ticks
 * "also on ChatGPT" (`addChatGptAfterQuestion`).
 *
 * None of them starts the worker or reserves anything: Run stays the only
 * start (D-052). Each is behind the console's kill switch, then the founder
 * guard; the actor always comes from the session, and the job a review
 * resolves comes from the pilot's own tables, never from the body. Logs
 * carry closed fields only: never the question, a note or a reason.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FounderRouteGuard } from "@/lib/auth/founder";
import type { AddPilotQuestionEngineOutcome, DbAdapter, RetirePilotQuestionOutcome } from "@/lib/db/types";
import {
  ADD_CHATGPT_DONE_TEXT,
  ADD_CHATGPT_FAILED_TEXT,
  ADD_ENGINE_REFUSAL,
  PILOT_CHATGPT_NOT_CONNECTED,
  PILOT_CHATGPT_NOT_CONNECTED_YET,
  PILOT_REVIEW_DONE_TEXT,
  PILOT_REVIEW_NOT_HELD_TEXT,
  PILOT_REVIEW_REFUSED_TEXT,
  pilotEngineNotOnQuestionText,
  RETIRE_QUESTION_REFUSAL,
  retireQuestionRefusalText,
  type RetireEngineState,
} from "@/lib/pilots/copy";
import { pilotChatGptEnabled, pilotEngineFromBody } from "@/lib/pilots/engines";
import { resolvePilotQuestionTarget } from "@/lib/pilots/reads";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { resolveJobReview, type JobReviewResolution } from "@/lib/reports/job-review";

type Env = Readonly<Record<string, string | undefined>>;

const MAX_BODY_BYTES = 8_192;

/** The request page's resolutions and note rules (app/api/internal/snapshot-requests/[requestId]/review). */
export const PILOT_REVIEW_RESOLUTIONS: readonly JobReviewResolution[] = ["excluded_and_completed", "failed"];
export const PILOT_REVIEW_NOTE_MIN = 10;
export const PILOT_REVIEW_NOTE_MAX = 2000;

function info(event: string, fields: Record<string, unknown>, log: (line: string) => void): void {
  log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...fields }));
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "request_body_too_large" }, { status: 413 }) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 }) };
  }
}

/* ---------------------------------------------------------------- adding ChatGPT */

export interface AddPilotEngineDeps {
  env: Env;
  guard: () => Promise<FounderRouteGuard>;
  db: () => Pick<DbAdapter, "addPilotQuestionEngine">;
  log?: (line: string) => void;
}

/** POST questions/[pilotQuestionId]/engines with `{ "engine": "openai_chatgpt" }`. */
export async function handleAddPilotQuestionEngine(
  request: Request,
  ids: { pilotId: string; pilotQuestionId: string },
  deps: AddPilotEngineDeps
): Promise<NextResponse> {
  if (deps.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Adding ChatGPT to a pilot question is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await deps.guard();
  if (!guard.ok) return guard.response;

  const { pilotId, pilotQuestionId } = ids;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  // ChatGPT is the only engine added this way: Perplexity's baseline comes
  // with the question (add_pilot_question).
  const engine = (parsed.body as Record<string, unknown> | null)?.engine;
  if (engine !== "openai_chatgpt") {
    return NextResponse.json({ ok: false, error: "invalid_engine" }, { status: 400 });
  }
  if (!pilotChatGptEnabled(deps.env)) {
    return NextResponse.json({ ok: false, error: PILOT_CHATGPT_NOT_CONNECTED }, { status: 409 });
  }

  let result: Awaited<ReturnType<DbAdapter["addPilotQuestionEngine"]>>;
  try {
    result = await deps.db().addPilotQuestionEngine({
      pilotId,
      pilotQuestionId,
      engine: "openai_chatgpt",
      addedBy: guard.user.id,
    });
  } catch {
    // One transaction in the database: a failure leaves nothing behind. The
    // error itself is never echoed or logged, only that it happened.
    info("pilot_question_engine_add", {
      actorUserId: guard.user.id, pilotId, pilotQuestionId, engine, outcome: "FAILED",
    }, deps.log ?? console.info);
    return NextResponse.json({ ok: false, error: ADD_CHATGPT_FAILED_TEXT }, { status: 500 });
  }

  info("pilot_question_engine_add", {
    actorUserId: guard.user.id,
    pilotId,
    pilotQuestionId,
    engine,
    outcome: result.outcome,
    protocolId: result.protocolId,
    jobId: result.jobId,
  }, deps.log ?? console.info);

  if (result.outcome === "ADDED" || result.outcome === "ALREADY_ADDED") {
    return NextResponse.json(
      { ok: true, outcome: result.outcome, detail: ADD_CHATGPT_DONE_TEXT },
      { status: result.outcome === "ADDED" ? 201 : 200 }
    );
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: ADD_ENGINE_REFUSAL[result.outcome] },
    { status: result.outcome === "PILOT_NOT_FOUND" || result.outcome === "QUESTION_NOT_FOUND" ? 404 : 409 }
  );
}

/**
 * After add_pilot_question, when the founder asked for ChatGPT too: two
 * calls, not one transaction. When this second one does not add ChatGPT
 * (the gate is off, the database refuses, or the call fails), the question
 * keeps its Perplexity measurement and the reply says ChatGPT was not
 * added, in words.
 */
export async function addChatGptAfterQuestion(
  db: Pick<DbAdapter, "addPilotQuestionEngine">,
  input: { pilotId: string; pilotQuestionId: string; addedBy: string; chatgptEnabled: boolean }
): Promise<{ added: boolean; outcome: AddPilotQuestionEngineOutcome | "NOT_CONNECTED" | "FAILED"; words: string }> {
  if (!input.chatgptEnabled) return { added: false, outcome: "NOT_CONNECTED", words: PILOT_CHATGPT_NOT_CONNECTED_YET };
  try {
    const result = await db.addPilotQuestionEngine({
      pilotId: input.pilotId,
      pilotQuestionId: input.pilotQuestionId,
      engine: "openai_chatgpt",
      addedBy: input.addedBy,
    });
    if (result.outcome === "ADDED" || result.outcome === "ALREADY_ADDED") {
      return { added: true, outcome: result.outcome, words: ADD_CHATGPT_DONE_TEXT };
    }
    return { added: false, outcome: result.outcome, words: ADD_ENGINE_REFUSAL[result.outcome] };
  } catch {
    return { added: false, outcome: "FAILED", words: ADD_CHATGPT_FAILED_TEXT };
  }
}

/* ---------------------------------------------------------------- a retire refusal, in words */

/**
 * D-061 (review of phase B) — the retire route's words for a refusal. Only
 * when the web gate is off and the refusal sends the founder to Retry
 * (QUESTION_RETRYABLE) or to Run (QUESTION_JOB_ACTIVE) does it read each
 * engine's job of the question, so the words can say the measurement meant
 * is ChatGPT's and that ChatGPT must be switched on first
 * (retireQuestionRefusalText). Reads only, and the client is built only
 * then; a read that fails falls back to the fixed words, and nothing is
 * logged.
 */
export async function retireRefusalWords(
  client: () => SupabaseClient,
  ids: { pilotId: string; pilotQuestionId: string },
  outcome: Exclude<RetirePilotQuestionOutcome, "RETIRED">,
  chatgptEnabled: boolean,
  now: () => number = Date.now
): Promise<string> {
  if (chatgptEnabled || (outcome !== "QUESTION_RETRYABLE" && outcome !== "QUESTION_JOB_ACTIVE")) {
    return RETIRE_QUESTION_REFUSAL[outcome];
  }
  try {
    const c = client();
    const [px, gpt] = await Promise.all([
      resolvePilotQuestionTarget(c, ids.pilotId, ids.pilotQuestionId, "perplexity_sonar"),
      resolvePilotQuestionTarget(c, ids.pilotId, ids.pilotQuestionId, "openai_chatgpt"),
    ]);
    const state = (t: Awaited<ReturnType<typeof resolvePilotQuestionTarget>>): RetireEngineState | null => {
      if (!t?.job) return null;
      const lease = t.job.leaseExpiresAt ? Date.parse(t.job.leaseExpiresAt) : Number.NaN;
      return {
        status: t.job.status,
        stale: (t.job.status === "claimed" || t.job.status === "running") && !Number.isNaN(lease) && lease <= now(),
      };
    };
    return retireQuestionRefusalText(outcome, {
      chatgptConnected: false,
      engines: { perplexity_sonar: state(px), openai_chatgpt: state(gpt) },
    });
  } catch {
    return RETIRE_QUESTION_REFUSAL[outcome];
  }
}

/* ---------------------------------------------------------------- a measurement held for review */

export interface ResolvePilotReviewDeps {
  env: Env;
  guard: () => Promise<FounderRouteGuard>;
  client: () => SupabaseClient;
  log?: (line: string) => void;
}

/**
 * POST questions/[pilotQuestionId]/review with `{ engine, resolution, note }`.
 *
 * Not behind the ChatGPT gate: a resolution spends nothing and starts
 * nothing, and a ChatGPT measurement held for review must stay resolvable
 * after the gate is turned off (forward recovery, 20261109180000).
 */
export async function handleResolvePilotQuestionReview(
  request: Request,
  ids: { pilotId: string; pilotQuestionId: string },
  deps: ResolvePilotReviewDeps
): Promise<NextResponse> {
  if (deps.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Resolving a held measurement is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await deps.guard();
  if (!guard.ok) return guard.response;

  const { pilotId, pilotQuestionId } = ids;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const choice = pilotEngineFromBody(parsed.body, {
    chatgptEnabled: pilotChatGptEnabled(deps.env),
    gated: false,
    required: true,
  });
  if (!choice.ok) return NextResponse.json({ ok: false, error: choice.error }, { status: choice.status });
  const engine = choice.engine;

  const { resolution, note } = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof resolution !== "string" || !PILOT_REVIEW_RESOLUTIONS.includes(resolution as JobReviewResolution)) {
    return NextResponse.json({ ok: false, error: "invalid_resolution" }, { status: 400 });
  }
  if (typeof note !== "string" || note.trim().length < PILOT_REVIEW_NOTE_MIN || note.length > PILOT_REVIEW_NOTE_MAX) {
    return NextResponse.json(
      { ok: false, error: `A review note of ${PILOT_REVIEW_NOTE_MIN}-${PILOT_REVIEW_NOTE_MAX} characters is required.` },
      { status: 400 }
    );
  }

  const client = deps.client();
  const target = await resolvePilotQuestionTarget(client, pilotId, pilotQuestionId, engine);
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  if (target.protocolId === null || target.job === null) {
    return NextResponse.json({ ok: false, error: pilotEngineNotOnQuestionText(engine) }, { status: 409 });
  }
  if (target.job.status !== "needs_review") {
    return NextResponse.json({ ok: false, error: PILOT_REVIEW_NOT_HELD_TEXT }, { status: 409 });
  }

  // The reviewer is the signed-in founder, from the session.
  const result = await resolveJobReview(client, {
    jobId: target.job.id,
    reviewedBy: guard.user.id,
    resolution: resolution as JobReviewResolution,
    note: note.trim(),
  });

  info("pilot_question_review", {
    actorUserId: guard.user.id,
    pilotId,
    pilotQuestionId,
    engine,
    jobId: target.job.id,
    resolution,
    ok: result.ok,
    jobStatus: result.ok ? result.jobStatus : null,
  }, deps.log ?? console.info);

  if (!result.ok) return NextResponse.json({ ok: false, error: PILOT_REVIEW_REFUSED_TEXT }, { status: 409 });
  return NextResponse.json(
    { ok: true, detail: PILOT_REVIEW_DONE_TEXT[resolution as JobReviewResolution] },
    { status: 200 }
  );
}
