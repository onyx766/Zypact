"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-row control that takes an approved request all the way to a report.
 *
 * The run is a detached server-side process, so this button only starts it and
 * then watches. While a run is live it polls the row's own state rather than
 * holding anything open, which means a closed tab or a dev-server reload does
 * not interrupt a paid scan.
 *
 * The confirm dialog is deliberate: the click spends real money.
 */

export interface PipelineRowState {
  /** Latest protocol job status, when the request has one. */
  jobStatus: string | null;
  /** Leased but the lease has lapsed: nothing is actually executing. */
  stale: boolean;
  integrityStatus: string | null;
  publicToken: string | null;
  delivered: boolean;
}

const POLL_INTERVAL_MS = 6000;

/**
 * Only a job a worker actually holds counts as active.
 *
 * `queued` deliberately excluded: approval enqueues the job, so every approved
 * request sits at `queued` before anything runs. Treating it as active made
 * the row report "Running…" for work nobody had started, and — worse — hid the
 * button that would have started it.
 */
const ACTIVE_JOB = new Set(["claimed", "running"]);

/**
 * How long a click is trusted before the row stops claiming a run is starting.
 *
 * The spawned worker takes a few seconds to claim, so the job stays `queued`
 * briefly after a legitimate start. Without this the row would flip straight
 * back to "Run scan" and invite a second click. If the job is still `queued`
 * when this elapses, the start did not take and the row says so rather than
 * spinning forever.
 */
const START_GRACE_MS = 90_000;

function startNote(jobStatus: string | null): string {
  if (jobStatus === "succeeded") {
    return "The scan has finished. The worker builds the report when it stops, so refresh this page in a few minutes.";
  }
  if (jobStatus === null || jobStatus === "queued") {
    return "No worker claimed the job within 90 seconds. Check the Fly worker logs for the reason.";
  }
  return `The job ended as '${jobStatus}'. Check the Fly worker logs for the reason.`;
}

export function RunPipelineButton({
  requestId,
  state,
}: {
  requestId: string;
  state: PipelineRowState;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Timestamp of this session's click, or null. */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [graceExpired, setGraceExpired] = useState(false);

  // A lapsed lease means the worker is gone, so a leased-but-stale job is not
  // active no matter what its status column says.
  const claimed =
    state.jobStatus !== null &&
    ACTIVE_JOB.has(state.jobStatus) &&
    !state.stale;

  const starting = startedAt !== null && !graceExpired && !claimed;
  const active = claimed || starting;

  // Refreshes the server component while a run is live, then stops. An
  // interval left running would keep re-rendering every row forever.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => {
      if (activeRef.current) router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [active, router]);

  // Bounds the optimistic "starting" window. A spawn that never claimed the
  // job must surface as a failed start, not as a row that spins forever.
  useEffect(() => {
    if (startedAt === null || claimed) return;

    const remaining = START_GRACE_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setGraceExpired(true);
      return;
    }

    const timer = setTimeout(() => setGraceExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [startedAt, claimed]);

  // A claim proves the start worked, so the optimistic window is no longer
  // needed and must not be able to expire underneath a real run.
  useEffect(() => {
    if (claimed && startedAt !== null) {
      setStartedAt(null);
      setGraceExpired(false);
    }
  }, [claimed, startedAt]);

  async function start() {
    if (
      !window.confirm(
        "Run the scan now?\n\nThis makes 3 real, paid provider calls and takes about 5-6 minutes."
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/run-pipeline`,
        { method: "POST" }
      );
      const data = await response.json();

      if (!response.ok || data.ok === false) {
        setError(data.error ?? "Could not start the run.");
      } else {
        setStartedAt(Date.now());
        setGraceExpired(false);
        router.refresh();
      }
    } catch {
      setError("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (state.publicToken && !active) {
    return (
      <>
        <a
          className="zpa-btn zpa-btn-sm"
          href={`/report/${state.publicToken}`}
          target="_blank"
          rel="noreferrer"
        >
          Report ↗
        </a>
        {state.delivered ? <span className="zpa-sent">Sent</span> : null}
      </>
    );
  }

  if (active) {
    return (
      <span className="zpa-pill tone-blue" style={{ justifyContent: "center" }}>
        <span className="zpa-pill-label">
          {claimed ? `Running (${state.jobStatus})…` : "Starting…"}
        </span>
      </span>
    );
  }

  if (state.integrityStatus === "blocked") {
    return (
      <span className="zpa-pill tone-red" style={{ justifyContent: "center" }}>
        <span className="zpa-pill-label">Blocked</span>
      </span>
    );
  }

  if (state.jobStatus === "needs_review") {
    return (
      <a
        className="zpa-btn zpa-btn-sm zpa-btn-amber-ghost"
        href={`/admin/snapshot-requests/${requestId}`}
      >
        Needs review
      </a>
    );
  }

  const label = busy
    ? "Starting…"
    : state.stale
      ? "Resume run"
      : graceExpired
        ? "Run scan again"
        : "Run scan";

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className={`zpa-btn zpa-btn-sm ${
          state.stale ? "zpa-btn-warn" : "zpa-btn-green-ghost"
        }`}
      >
        {label}
      </button>

      {/* Says plainly that a run died, and that resuming continues from the
          evidence already paid for rather than starting over. */}
      {state.stale && !busy ? (
        <span className="zpa-action-note">
          A previous run stopped before finishing. Resuming reclaims it and
          continues from the runs already completed.
        </span>
      ) : null}

      {/* The click was accepted but this row never saw the job running. Polls
          are 6 s apart, so a job that finished between two of them looks the
          same as one nobody claimed; the job's own status tells them apart. */}
      {graceExpired && !error ? (
        <span className="zpa-action-note">{startNote(state.jobStatus)}</span>
      ) : null}

      {error ? (
        <span className="zpa-action-note tone-red">{error}</span>
      ) : null}
    </>
  );
}
