"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, RefreshCw, Send, ShieldCheck } from "lucide-react";

import type { ReviewState } from "@/lib/reports/review-actions";
import { cn } from "@/lib/utils";
import {
  INTEGRITY_PRESENTATION,
  toneClass,
  ui,
} from "../ui-classes";

/**
 * Founder review surface for the protocol report path.
 *
 * Exists because `needs_review` and `blocked` were previously invisible and
 * unactionable: a job could stop with paid evidence behind it and the only
 * way to see why — or to do anything about it — was a database query.
 *
 * The two destructive-ish actions are separated deliberately. Regenerate
 * rebuilds and re-classifies without sending; Send is the only control that
 * puts mail in someone's inbox, and it asks for confirmation first.
 */

function Badge({ status }: { status: string | null }) {
  if (!status) {
    return <span className="text-sm text-muted-foreground">Not classified</span>;
  }
  const presentation = INTEGRITY_PRESENTATION[status] ?? {
    label: status,
    tone: "neutral" as const,
  };
  return (
    <span className={cn(ui.pill, toneClass[presentation.tone])}>
      {presentation.label}
    </span>
  );
}

export function ReviewPanel({
  requestId,
  state,
}: {
  requestId: string;
  state: ReviewState;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  const job = state.job;
  const artifact = state.artifact;

  const jobNeedsReview = job?.status === "needs_review";
  const isBlocked = artifact?.integrityStatus === "blocked";
  const alreadyDelivered = Boolean(artifact?.deliveredAt);
  const noteTooShort = note.trim().length < 10;

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json();

      if (!response.ok || data.ok === false) {
        setMessage({
          kind: "error",
          text: data.detail || data.error || "The action failed.",
        });
      } else {
        setMessage({
          kind: "ok",
          text:
            data.outcome === "delivered"
              ? "Report delivered."
              : data.outcome
                ? `Done: ${String(data.outcome).replace(/_/g, " ")}.`
                : "Done.",
        });
        setNote("");
        router.refresh();
      }
    } catch {
      setMessage({
        kind: "error",
        text: "The request did not complete. Check the job state before retrying.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={cn(ui.panel, "mt-4 p-6")}>
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border",
            toneClass.neutral
          )}
        >
          <ShieldCheck size={20} strokeWidth={1.9} />
        </span>
        <div>
          <h2 className="max-w-none text-lg font-semibold leading-snug tracking-tight text-foreground">
            Review
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Execution state, the integrity decision, and the actions available on
            them.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {/* ---------------------------------------------------- job state */}
        <div className={cn(ui.subPanel, "p-4")}>
          <p className={ui.label}>Execution job</p>
          <div className="mt-2 text-sm text-foreground">
            {job ? (
              <>
                <code className={ui.code}>{job.status}</code>
                {job.attemptCount !== null ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {job.attemptCount} job attempt(s)
                  </span>
                ) : null}
                {job.needsReviewReason ? (
                  <p className="mt-2 text-warning">
                    Held: <code className={ui.code}>{job.needsReviewReason}</code>
                  </p>
                ) : null}
                {job.priorNeedsReviewReason ? (
                  <p className="mt-2 text-muted-foreground">
                    Previously held:{" "}
                    <code className={ui.code}>{job.priorNeedsReviewReason}</code>
                    {job.reviewResolution ? (
                      <>
                        {" "}
                        → resolved{" "}
                        <code className={ui.code}>{job.reviewResolution}</code>
                        {job.reviewedAt
                          ? ` on ${job.reviewedAt.slice(0, 10)}`
                          : ""}
                      </>
                    ) : null}
                  </p>
                ) : null}
                {job.reviewNote ? (
                  <p className="mt-2 border-l-2 border-border bg-muted/50 px-3 py-2 text-[13px] text-foreground">
                    {job.reviewNote}
                  </p>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                No protocol job. This request did not go through the M4/M5 path.
              </span>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ attempts */}
        {state.attempts.length > 0 ? (
          <div className={cn(ui.subPanel, "p-4")}>
            <p className={ui.label}>Attempts</p>
            <ul className="mt-2 space-y-1.5 text-sm text-foreground">
              {state.attempts.map((attempt, index) => (
                <li key={index}>
                  Run {attempt.ordinal ?? "—"}:{" "}
                  <code className={ui.code}>{attempt.status}</code>
                  {attempt.terminationReason ? (
                    <span className="text-muted-foreground [overflow-wrap:anywhere]">
                      {" "}
                      — {attempt.terminationReason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ----------------------------------------------------- integrity */}
        <div className={cn(ui.subPanel, "p-4")}>
          <p className={ui.label}>Report integrity</p>
          <div className="mt-2">
            <Badge status={artifact?.integrityStatus ?? null} />
            {artifact?.integrityReasons.length ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground">
                {artifact.integrityReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {isBlocked ? (
              <p className="mt-3 text-[13px] text-destructive">
                A blocked report is never delivered and is not readable by the
                client, even with the link.
              </p>
            ) : null}
            {alreadyDelivered ? (
              <p className="mt-3 text-[13px] text-success">
                Delivered {artifact?.deliveredAt?.slice(0, 10)}. A delivered
                report is immutable.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ resolve a job */}
      {jobNeedsReview && job ? (
        <div className={cn("mt-4 rounded-xl border p-4", toneClass.warning)}>
          <strong className="text-sm font-semibold">Resolve this job</strong>
          <p className="mb-3 mt-1.5 text-[13px] text-foreground">
            Unconfirmed attempts are marked{" "}
            <code className={ui.code}>excluded</code>, never completed. No result
            is assumed for them.
          </p>

          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this the right resolution? (required, min 10 characters)"
            rows={3}
            className={cn(ui.input, "mb-3")}
          />

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={busy !== null || noteTooShort}
              onClick={() =>
                post(
                  {
                    action: "resolve_job",
                    jobId: job.id,
                    resolution: "excluded_and_completed",
                    note,
                  },
                  "resolve"
                )
              }
              className={cn(ui.btnPrimary, busy && "cursor-wait")}
            >
              {busy === "resolve" ? "Resolving…" : "Exclude & complete"}
            </button>

            <button
              type="button"
              disabled={busy !== null || noteTooShort}
              onClick={() =>
                post(
                  {
                    action: "resolve_job",
                    jobId: job.id,
                    resolution: "failed",
                    note,
                  },
                  "fail"
                )
              }
              className={cn(ui.btnDanger, busy && "cursor-wait")}
            >
              {busy === "fail" ? "Failing…" : "Close as failed"}
            </button>
          </div>
        </div>
      ) : null}

      {/* --------------------------------------------- regenerate / send */}
      <div className="mt-5 flex flex-wrap gap-2.5">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post({ action: "regenerate" }, "regenerate")}
          className={cn(ui.btnOutline, busy && "cursor-wait")}
        >
          <RefreshCw size={15} strokeWidth={2.2} />
          {busy === "regenerate" ? "Regenerating…" : "Regenerate report"}
        </button>

        <button
          type="button"
          disabled={busy !== null || isBlocked || alreadyDelivered}
          onClick={() => {
            if (
              window.confirm(
                "Send this report to the requester's email address now?"
              )
            ) {
              post({ action: "deliver" }, "deliver");
            }
          }}
          className={cn(ui.btnPrimary, busy && "cursor-wait")}
        >
          <Send size={15} strokeWidth={2.2} />
          {busy === "deliver" ? "Sending…" : "Send to requester"}
        </button>

        {artifact && !isBlocked ? (
          <a
            href={`/report/${artifact.publicToken}`}
            target="_blank"
            rel="noreferrer"
            className={ui.btnOutline}
          >
            Open report
            <ArrowUpRight size={15} strokeWidth={2.2} />
          </a>
        ) : null}
      </div>

      {message ? (
        <p
          className={cn(
            "mt-4 rounded-lg border px-3.5 py-2.5 text-[13px]",
            message.kind === "ok" ? toneClass.success : toneClass.danger
          )}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
