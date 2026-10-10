"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface FounderBaselineRow {
  jobId: string;
  protocolId: string;
  projectId: string;
  questionVersion: number;
  buyerQuestion: string;
  promptHash: string;
  plannedRuns: number;
  runCap: number;
  retryCap: number;
  spendCapUsd: number;
  jobStatus: string;
  attemptCount: number;
  nextBaselineOrdinal: number | null;
  protocolStatus: string;
  createdAt: string;
}

const ACTIVE = new Set(["claimed", "running"]);

function statusTone(status: string): string {
  if (status === "succeeded") return "green";
  if (status === "queued" || ACTIVE.has(status)) return "blue";
  if (status === "needs_review") return "amber";
  if (status === "failed") return "red";
  return "neutral";
}

function shortId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function RunBaselineButton({ row }: { row: FounderBaselineRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = starting || ACTIVE.has(row.jobStatus);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, router]);

  useEffect(() => {
    if (ACTIVE.has(row.jobStatus) || row.jobStatus !== "queued") {
      setStarting(false);
    }
  }, [row.jobStatus]);

  const eligible =
    row.jobStatus === "queued" &&
    row.attemptCount === 0 &&
    row.plannedRuns === 5 &&
    row.runCap === 5 &&
    row.retryCap === 0 &&
    row.spendCapUsd <= 0.25;

  async function start() {
    if (!eligible) return;

    const ok = window.confirm(
      "Run this standalone baseline now?\n\n" +
        "This starts exactly the displayed queued job after server-side safety checks. " +
        "Plan: 5 runs, run cap 5, retry cap 0, spend cap $0.25."
    );
    if (!ok) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/founder-baselines/${row.jobId}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocolId: row.protocolId }),
        }
      );
      const data = await response.json();

      if (!response.ok || data.ok === false) {
        setError(data.error ?? "Could not start this baseline.");
        return;
      }

      setStarting(true);
      router.refresh();
    } catch {
      setError("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (ACTIVE.has(row.jobStatus) || starting) {
    return (
      <span className="zpa-pill tone-blue">
        <span className="zpa-pill-label">
          {ACTIVE.has(row.jobStatus) ? `Running (${row.jobStatus})…` : "Starting…"}
        </span>
      </span>
    );
  }

  if (row.jobStatus !== "queued") {
    return (
      <span className={`zpa-pill tone-${statusTone(row.jobStatus)}`}>
        <span className="zpa-pill-label">{row.jobStatus}</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="zpa-btn zpa-btn-sm zpa-btn-green-ghost"
        onClick={start}
        disabled={busy || !eligible}
      >
        {busy ? "Starting…" : "Run baseline"}
      </button>
      {!eligible ? (
        <span className="zpa-action-note tone-red">
          Safety guard failed. Review this row before starting.
        </span>
      ) : null}
      {error ? (
        <span className="zpa-action-note tone-red">{error}</span>
      ) : null}
    </>
  );
}

export function FounderBaselinePanel({ rows }: { rows: FounderBaselineRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section className="zpa-card" style={{ marginBottom: 24, overflow: "hidden" }}>
      <div style={{ padding: "20px 22px 14px" }}>
        <p className="zpa-eyebrow">Founder experiments</p>
        <h2 style={{ margin: "4px 0 6px", fontSize: 20, fontWeight: 750 }}>
          Standalone baseline jobs
        </h2>
        <p className="zpa-subtitle" style={{ margin: 0 }}>
          Baselines created outside a snapshot request. Starting a row is allowed
          only when the server verifies the exact job, protocol, caps, zero prior
          attempts, no competing runnable job, and a stopped worker.
        </p>
      </div>

      <div className="zpa-table-scroll">
        <table className="zpa-table">
          <thead>
            <tr>
              <th>Buyer question</th>
              <th>Protocol / job</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.jobId}>
                <td className="zpa-question" style={{ minWidth: 310 }}>
                  <div style={{ fontWeight: 650 }}>{row.buyerQuestion}</div>
                  <div className="zpa-muted" style={{ marginTop: 6, fontSize: 12 }}>
                    Question v{row.questionVersion} · hash {shortId(row.promptHash)}
                  </div>
                </td>
                <td style={{ minWidth: 190 }}>
                  <div title={row.protocolId} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    Protocol {shortId(row.protocolId)}
                  </div>
                  <div title={row.jobId} className="zpa-muted" style={{ marginTop: 5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
                    Job {shortId(row.jobId)}
                  </div>
                </td>
                <td style={{ minWidth: 155 }}>
                  <div>{row.plannedRuns} planned runs</div>
                  <div className="zpa-muted" style={{ marginTop: 4, fontSize: 12 }}>
                    cap {row.runCap} · retry {row.retryCap} · ${row.spendCapUsd.toFixed(2)}
                  </div>
                </td>
                <td>
                  <span className={`zpa-pill tone-${statusTone(row.jobStatus)}`}>
                    <span className="zpa-pill-label">{row.jobStatus}</span>
                  </span>
                </td>
                <td>
                  <div>{row.attemptCount}</div>
                  <div className="zpa-muted" style={{ marginTop: 4, fontSize: 12 }}>
                    next slot {row.nextBaselineOrdinal ?? "—"}
                  </div>
                </td>
                <td>
                  <div className="zpa-actions">
                    <RunBaselineButton row={row} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
