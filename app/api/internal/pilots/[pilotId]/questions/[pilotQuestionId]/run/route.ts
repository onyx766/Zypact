import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { PILOT_JOB_ABANDONED_TEXT, pilotEngineNotOnQuestionText, pilotRunStartedText } from "@/lib/pilots/copy";
import { pilotChatGptEnabled, pilotEngineFromBody } from "@/lib/pilots/engines";
import { pilotIsOver, pilotNotStarted, resolvePilotQuestionTarget } from "@/lib/pilots/reads";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { startFailureHttpStatus, startWorkerMachine } from "@/lib/worker-control/fly-machine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;

/**
 * POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/run
 *
 * D-054 — starts the worker for one pilot question's measurement. The start
 * names that question's own job (D-052): the worker claims that job or
 * nothing. The paid-execution gate and the run request are
 * startWorkerMachine's own, and the database refuses the run request for a
 * pilot that is closed, outside its dates, or a retired question, whatever
 * this route decides.
 *
 * D-061 — the JSON body names the engine (`{ "engine": "openai_chatgpt" }`);
 * no body, or no engine, is Perplexity, as before. An engine outside the
 * closed set is refused, and a ChatGPT Run is refused unless the web host's
 * gate (ZYPACT_PILOT_CHATGPT_ENABLED) is exactly "true", before anything is
 * read or started.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; pilotQuestionId: string }> }
): Promise<NextResponse> {
  const guard = await requireFounderForRoute("pilot-question-run");
  if (!guard.ok) return guard.response;

  const { pilotId, pilotQuestionId } = await params;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  // An empty body is the pre-D-061 Run, on Perplexity.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "request_body_too_large" }, { status: 413 });
  }
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }
  }
  const choice = pilotEngineFromBody(body, { chatgptEnabled: pilotChatGptEnabled(), gated: true });
  if (!choice.ok) {
    return NextResponse.json({ ok: false, error: choice.error }, { status: choice.status });
  }
  const engine = choice.engine;

  const target = await resolvePilotQuestionTarget(getReportServiceClient(), pilotId, pilotQuestionId, engine);
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (pilotIsOver(target.pilotStatus, target.endsOn, todayUtc())) {
    return NextResponse.json(
      { ok: false, error: "This pilot is closed or past its end date, so its questions are no longer measured." },
      { status: 409 }
    );
  }

  if (pilotNotStarted(target.startsOn, todayUtc())) {
    return NextResponse.json(
      { ok: false, error: `This pilot starts on ${target.startsOn}. Its questions can be run from that day.` },
      { status: 409 }
    );
  }

  if (target.retired) {
    return NextResponse.json(
      { ok: false, error: "This question was retired, so it is no longer measured." },
      { status: 409 }
    );
  }

  // D-061 — the question has no measurement on the engine asked for.
  if (target.protocolId === null) {
    return NextResponse.json({ ok: false, error: pilotEngineNotOnQuestionText(engine) }, { status: 409 });
  }

  const job = target.job;
  if (!job) {
    return NextResponse.json({ ok: false, error: "This question has no measurement job to run." }, { status: 409 });
  }

  // A leased job blocks a second run only while its lease is still good;
  // a lapsed lease is resumed by the worker's own reclaim.
  if (job.status === "claimed" || job.status === "running") {
    const expiry = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : NaN;
    if (!Number.isNaN(expiry) && expiry > Date.now()) {
      return NextResponse.json(
        { ok: false, error: "This question's measurement is already running." },
        { status: 409 }
      );
    }
  }

  if (job.status === "needs_review") {
    return NextResponse.json(
      { ok: false, error: "This measurement is held for review. Resolve it from the pilot page before running again." },
      { status: 409 }
    );
  }

  // D-052 — an ended job is not run again by pressing Run. A failed one is
  // retried from the pilot page, where the cause is shown; one that cannot
  // be retried, or was abandoned, is retired there (D-054).
  if (job.status === "abandoned_exhausted") {
    return NextResponse.json({ ok: false, error: PILOT_JOB_ABANDONED_TEXT }, { status: 409 });
  }
  if (job.status === "failed") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This measurement stopped before it finished. Retry it from the pilot page, or retire the question there if it cannot be retried.",
      },
      { status: 409 }
    );
  }

  if (job.status === "succeeded") {
    return NextResponse.json(
      { ok: false, error: "This measurement has already finished." },
      { status: 409 }
    );
  }

  const start = await startWorkerMachine({
    jobId: job.id,
    projectId: job.projectId,
    via: "admin_pilot_run",
    requestedBy: guard.user.id,
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_question_run",
      actorUserId: guard.user.id,
      pilotId,
      pilotQuestionId,
      engine,
      jobId: job.id,
      ok: start.ok,
      code: start.ok ? null : start.code,
      refusal: start.ok ? null : start.refusal ?? null,
    })
  );

  if (!start.ok) {
    // The shared start path's words for an abandoned job name a request;
    // a pilot question has none, so it is told to retire the question.
    const error = start.refusal === "JOB_ATTEMPTS_EXHAUSTED" ? PILOT_JOB_ABANDONED_TEXT : start.detail;
    return NextResponse.json(
      { ok: false, error },
      { status: startFailureHttpStatus(start.code) }
    );
  }

  if (start.alreadyRunning) {
    if (start.runRequestWithdrawn) {
      return NextResponse.json(
        {
          ok: false,
          // D-061 — a worker measuring ChatGPT can run for many minutes.
          error:
            "The worker is still running from an earlier start, so nothing new was started. "
            + "Press Run again once it has stopped: usually within a minute for Perplexity, longer while it measures ChatGPT.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        started: true,
        detail: "The worker was already starting and takes this question when it is ready, or has already taken it.",
      },
      { status: 202 }
    );
  }

  return NextResponse.json(
    { ok: true, started: true, detail: pilotRunStartedText(engine, target.plannedRuns) },
    { status: 202 }
  );
}
