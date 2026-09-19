"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, X } from "lucide-react";

import type { RegistrableBaseline } from "@/lib/interventions/admin-reads";
import { ACTION_TYPES } from "@/lib/interventions/types";
import { ACTION_TYPE_LABELS } from "./presentation";

/**
 * Registers an intervention as 'proposed'.
 *
 * Every field the RPC requires is here, and one it does not require but the
 * lifecycle does: the observation window has no setter after registration,
 * and implementation cannot be confirmed without it. It has no default on
 * purpose — a pre-filled number would be the tool choosing the methodology.
 */
export function RegisterDrawer({
  baselines,
  onClose,
}: {
  baselines: RegistrableBaseline[];
  onClose: () => void;
}) {
  const [protocolId, setProtocolId] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [mechanism, setMechanism] = useState("");
  const [actionType, setActionType] = useState("");
  const [actionTarget, setActionTarget] = useState("");
  const [owner, setOwner] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [days, setDays] = useState("");
  const [threshold, setThreshold] = useState("");
  const [alternatives, setAlternatives] = useState("");
  const [confounders, setConfounders] = useState("");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseline = useMemo(
    () => baselines.find((b) => b.protocolId === protocolId) ?? null,
    [baselines, protocolId]
  );

  // Evidence is scoped to one baseline. Switching baseline must not carry
  // citations from the previous one across.
  useEffect(() => setEvidence([]), [protocolId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggleEvidence = (id: string) =>
    setEvidence((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError("Set the observation window as a whole number of days from 1 to 365.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/internal/interventions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          protocolId,
          hypothesis,
          expectedMechanism: mechanism,
          actionType,
          actionTarget,
          owner,
          supportingEvidence: evidence,
          expectedObservationDays: n,
          decisionThresholdNote: threshold || null,
          alternativeExplanations: alternatives || null,
          confoundersToMonitor: confounders || null,
          implementationDeadline: deadline || null,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        setError(payload?.message || payload?.error || "Registration failed.");
        return;
      }
      window.location.href = `/admin/interventions/${payload.intervention.id}`;
    } catch {
      setError("Registration failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpi-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <aside className="zpi-drawer" role="dialog" aria-modal="true" aria-labelledby="zpi-register-title">
        <div className="zpi-drawer-head">
          <div>
            <h2 id="zpi-register-title">Register intervention</h2>
            <p className="zpa-muted">Fix the claim before anything goes live.</p>
          </div>
          <button type="button" className="zpi-icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form id="zpi-register-form" className="zpi-form" onSubmit={submit}>
          <label className="zpi-field">
            <span>Baseline <em>*</em></span>
            <select value={protocolId} onChange={(e) => setProtocolId(e.target.value)} required>
              <option value="" disabled>Select the baseline this responds to</option>
              {baselines.map((b) => (
                <option key={b.protocolId} value={b.protocolId} disabled={b.hasLiveIntervention}>
                  {(b.companyName ?? b.domain ?? "Unknown company")} — {b.promptText ?? "question unavailable"}
                  {b.hasLiveIntervention ? " (has a live intervention)" : ""}
                </option>
              ))}
            </select>
            {baselines.length === 0 ? (
              <small>No approved baseline exists yet. An intervention responds to baseline evidence.</small>
            ) : (
              <small>One live intervention per baseline. Baselines already holding one are disabled.</small>
            )}
          </label>

          <label className="zpi-field">
            <span>Hypothesis <em>*</em></span>
            <textarea rows={3} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} required
              placeholder="What you expect to change. e.g. The brand will be named in more shortlist answers." />
          </label>

          <label className="zpi-field">
            <span>Expected mechanism <em>*</em></span>
            <textarea rows={3} value={mechanism} onChange={(e) => setMechanism(e.target.value)} required
              placeholder="Why it would change. e.g. Sonar cites comparison pages for this question, and we have none." />
          </label>

          <div className="zpi-row">
            <label className="zpi-field">
              <span>Action type <em>*</em></span>
              <select value={actionType} onChange={(e) => setActionType(e.target.value)} required>
                <option value="" disabled>Select</option>
                {ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>{ACTION_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label className="zpi-field">
              <span>Owner <em>*</em></span>
              <input value={owner} onChange={(e) => setOwner(e.target.value)} required placeholder="Who implements it" />
            </label>
          </div>

          <label className="zpi-field">
            <span>Action target <em>*</em></span>
            <input value={actionTarget} onChange={(e) => setActionTarget(e.target.value)} required
              placeholder="Where it happens — a URL, page or listing" />
          </label>

          <fieldset className="zpi-field">
            <span>Supporting runs</span>
            {!baseline ? (
              <small>Choose a baseline to see its runs.</small>
            ) : baseline.runs.length === 0 ? (
              <small>This baseline has no completed, readable runs to cite.</small>
            ) : (
              <div className="zpi-runs">
                {baseline.runs.map((run) => (
                  <label key={run.attemptId} className={`zpi-run${evidence.includes(run.attemptId) ? " is-on" : ""}`}>
                    <input type="checkbox" checked={evidence.includes(run.attemptId)} onChange={() => toggleEvidence(run.attemptId)} />
                    <span>
                      <strong>Run {run.ordinal ?? "?"}</strong>{" "}
                      <span className="zpa-muted">
                        {run.brandPresent === null ? "no readable result" : run.brandPresent ? `brand present${run.position ? ` · ${run.position}` : ""}` : "brand absent"}
                      </span>
                      {run.summary ? <small>{run.summary}</small> : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <small>
              Only this baseline&apos;s runs can be cited. You can register without any, but approval
              requires at least one: an intervention with no evidence behind it is not evidence-backed.
            </small>
          </fieldset>

          <div className="zpi-row">
            <label className="zpi-field">
              <span>Observation window (days) <em>*</em></span>
              <input type="number" min={1} max={365} step={1} value={days} onChange={(e) => setDays(e.target.value)} required placeholder="e.g. 21" />
              <small>Starts when you confirm implementation. Cannot be changed later.</small>
            </label>
            <label className="zpi-field">
              <span>Implementation deadline</span>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </div>

          <label className="zpi-field">
            <span>Decision threshold</span>
            <textarea rows={2} value={threshold} onChange={(e) => setThreshold(e.target.value)}
              placeholder="What result would change the customer's next decision?" />
            <small>Recorded before the result exists, and frozen at approval.</small>
          </label>

          <details className="zpi-more">
            <summary>Alternative explanations and confounders</summary>
            <label className="zpi-field">
              <span>Alternative explanations</span>
              <textarea rows={2} value={alternatives} onChange={(e) => setAlternatives(e.target.value)} />
            </label>
            <label className="zpi-field">
              <span>Confounders to monitor</span>
              <textarea rows={2} value={confounders} onChange={(e) => setConfounders(e.target.value)} />
            </label>
          </details>

          <div className="zpi-note">
            <Info size={16} />
            <p>
              This registers the intervention as <strong>Proposed</strong>. Approving it freezes the
              hypothesis, mechanism, action, cited runs and decision threshold. Confirming implementation
              then opens the observation window.
            </p>
          </div>

          {error ? <p className="zpi-error" role="alert">{error}</p> : null}
        </form>

        <div className="zpi-drawer-foot">
          <button type="button" className="zpa-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="zpi-register-form" className="zpa-btn zpa-btn-primary" disabled={busy}>
            {busy ? "Registering…" : "Register intervention"}
          </button>
        </div>
      </aside>
    </div>
  );
}
