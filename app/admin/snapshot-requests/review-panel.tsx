"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { ReviewState } from "@/lib/reports/review-actions";

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

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> =
  {
    integrity_passed: { bg: "#dcfce7", fg: "#166534", label: "Integrity passed" },
    needs_review: { bg: "#fef9c3", fg: "#854d0e", label: "Needs review" },
    blocked: { bg: "#fee2e2", fg: "#991b1b", label: "Blocked" },
  };

function Badge({ status }: { status: string | null }) {
  if (!status) {
    return <span style={{ color: "#71717a" }}>Not classified</span>;
  }
  const style = STATUS_STYLES[status] ?? {
    bg: "#e4e4e7",
    fg: "#3f3f46",
    label: status,
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        background: style.bg,
        color: style.fg,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: ".02em",
      }}
    >
      {style.label}
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
    <section
      style={{
        marginTop: 28,
        padding: 24,
        border: "1px solid #e4e4e7",
        borderRadius: 12,
        background: "#fff",
      }}
    >
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Review</h2>
      <p style={{ margin: "0 0 20px", color: "#71717a", fontSize: 13 }}>
        Execution state, the integrity decision, and the actions available on
        them.
      </p>

      {/* ---------------------------------------------------- job state */}
      <div style={{ marginBottom: 20 }}>
        <strong style={{ fontSize: 13 }}>Execution job</strong>
        <div style={{ marginTop: 6, fontSize: 14 }}>
          {job ? (
            <>
              <code>{job.status}</code>
              {job.attemptCount !== null ? (
                <span style={{ color: "#71717a" }}>
                  {" "}
                  · {job.attemptCount} job attempt(s)
                </span>
              ) : null}
              {job.needsReviewReason ? (
                <p style={{ margin: "8px 0 0", color: "#854d0e" }}>
                  Held: <code>{job.needsReviewReason}</code>
                </p>
              ) : null}
              {job.priorNeedsReviewReason ? (
                <p style={{ margin: "8px 0 0", color: "#71717a" }}>
                  Previously held: <code>{job.priorNeedsReviewReason}</code>
                  {job.reviewResolution ? (
                    <>
                      {" "}
                      → resolved <code>{job.reviewResolution}</code>
                      {job.reviewedAt
                        ? ` on ${job.reviewedAt.slice(0, 10)}`
                        : ""}
                    </>
                  ) : null}
                </p>
              ) : null}
              {job.reviewNote ? (
                <p
                  style={{
                    margin: "8px 0 0",
                    padding: "8px 12px",
                    background: "#fafafa",
                    borderLeft: "3px solid #d4d4d8",
                    color: "#3f3f46",
                    fontSize: 13,
                  }}
                >
                  {job.reviewNote}
                </p>
              ) : null}
            </>
          ) : (
            <span style={{ color: "#71717a" }}>
              No protocol job. This request did not go through the M4/M5 path.
            </span>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ attempts */}
      {state.attempts.length > 0 ? (
        <div style={{ marginBottom: 20 }}>
          <strong style={{ fontSize: 13 }}>Attempts</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
            {state.attempts.map((attempt, index) => (
              <li key={index}>
                Run {attempt.ordinal ?? "—"}: <code>{attempt.status}</code>
                {attempt.terminationReason ? (
                  <span style={{ color: "#71717a" }}>
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
      <div style={{ marginBottom: 20 }}>
        <strong style={{ fontSize: 13 }}>Report integrity</strong>
        <div style={{ marginTop: 6 }}>
          <Badge status={artifact?.integrityStatus ?? null} />
          {artifact?.integrityReasons.length ? (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 14 }}>
              {artifact.integrityReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {isBlocked ? (
            <p style={{ margin: "10px 0 0", color: "#991b1b", fontSize: 13 }}>
              A blocked report is never delivered and is not readable by the
              client, even with the link.
            </p>
          ) : null}
          {alreadyDelivered ? (
            <p style={{ margin: "10px 0 0", color: "#166534", fontSize: 13 }}>
              Delivered {artifact?.deliveredAt?.slice(0, 10)}. A delivered
              report is immutable.
            </p>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------ resolve a job */}
      {jobNeedsReview && job ? (
        <div
          style={{
            marginBottom: 20,
            padding: 16,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 8,
          }}
        >
          <strong style={{ fontSize: 14 }}>Resolve this job</strong>
          <p style={{ margin: "6px 0 12px", fontSize: 13, color: "#713f12" }}>
            Unconfirmed attempts are marked <code>excluded</code>, never
            completed. No result is assumed for them.
          </p>

          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this the right resolution? (required, min 10 characters)"
            rows={3}
            style={{
              width: "100%",
              padding: 10,
              border: "1px solid #d4d4d8",
              borderRadius: 6,
              fontSize: 13,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
          />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy !== null || note.trim().length < 10}
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
              style={{
                padding: "9px 16px",
                borderRadius: 6,
                border: "none",
                background: note.trim().length < 10 ? "#a1a1aa" : "#166534",
                color: "#fff",
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy === "resolve" ? "Resolving…" : "Exclude & complete"}
            </button>

            <button
              type="button"
              disabled={busy !== null || note.trim().length < 10}
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
              style={{
                padding: "9px 16px",
                borderRadius: 6,
                border: "1px solid #dc2626",
                background: "#fff",
                color: "#dc2626",
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy === "fail" ? "Failing…" : "Close as failed"}
            </button>
          </div>
        </div>
      ) : null}

      {/* --------------------------------------------- regenerate / send */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => post({ action: "regenerate" }, "regenerate")}
          style={{
            padding: "9px 16px",
            borderRadius: 6,
            border: "1px solid #d4d4d8",
            background: "#fff",
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
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
          style={{
            padding: "9px 16px",
            borderRadius: 6,
            border: "none",
            background:
              isBlocked || alreadyDelivered ? "#a1a1aa" : "#18181b",
            color: "#fff",
            fontWeight: 600,
            cursor:
              isBlocked || alreadyDelivered
                ? "not-allowed"
                : busy
                  ? "wait"
                  : "pointer",
          }}
        >
          {busy === "deliver" ? "Sending…" : "Send to requester"}
        </button>

        {artifact && !isBlocked ? (
          <a
            href={`/report/${artifact.publicToken}`}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: "9px 16px",
              borderRadius: 6,
              border: "1px solid #d4d4d8",
              textDecoration: "none",
              color: "#18181b",
              fontWeight: 600,
            }}
          >
            Open report ↗
          </a>
        ) : null}
      </div>

      {message ? (
        <p
          style={{
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 6,
            background: message.kind === "ok" ? "#dcfce7" : "#fee2e2",
            color: message.kind === "ok" ? "#166534" : "#991b1b",
            fontSize: 13,
          }}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
