"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import { CLOSE_PILOT_PROMPT, pilotRunConfirmationText } from "@/lib/pilots/copy";

/**
 * D-054 — the founder's pilot controls. Each form sends a fresh
 * idempotency key per opened form, so a repeated press after a lost
 * response replays instead of creating a second pilot or question.
 */

type Issues = Record<string, string[]>;

function newKey(): string {
  return crypto.randomUUID();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; payload: Record<string, any> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  return { ok: response.ok && Boolean(payload?.ok), payload };
}

function FieldError({ issues, field }: { issues: Issues; field: string }) {
  const messages = issues[field];
  if (!messages || messages.length === 0) return null;
  return <span className="zpa-new-audit-error">{messages.join(" ")}</span>;
}

export function NewPilotPanel() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const [values, setValues] = useState({
    companyName: "",
    websiteUrl: "",
    siteControlNote: "",
    questionLimit: "15",
    startsOn: today(),
  });
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof values, v: string) => setValues((c) => ({ ...c, [k]: v }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIssues({});
    setError(null);
    try {
      const { ok, payload } = await post("/api/internal/pilots", { ...values, idempotencyKey: key });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(payload?.error ?? "The pilot could not be created.");
        return;
      }
      window.location.href = payload!.pilotPath;
    } catch {
      setError("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="zpa-btn zpa-btn-primary" onClick={() => { setKey(newKey()); setOpen(true); }}>
        <Plus size={16} strokeWidth={2.2} />
        New pilot
      </button>
    );
  }

  return (
    <section className="zpa-new-audit" aria-label="Create a pilot">
      <div className="zpa-new-audit-head">
        <div>
          <h2>New pilot</h2>
          <p className="zpa-muted">
            One project for one customer. Nothing is measured or charged until you add an approved
            question and press Run for it.
          </p>
        </div>
        <button type="button" className="zpa-icon-btn" onClick={() => setOpen(false)} disabled={busy} aria-label="Cancel">
          <X size={18} />
        </button>
      </div>
      <form className="zpa-new-audit-form" onSubmit={submit}>
        <label className="zpa-field">
          <span>Company name</span>
          <input value={values.companyName} onChange={(e) => set("companyName", e.target.value)} placeholder="Customer Inc" />
          <FieldError issues={issues} field="companyName" />
        </label>
        <label className="zpa-field">
          <span>Company website</span>
          <input value={values.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} placeholder="customer.com" />
          <FieldError issues={issues} field="websiteUrl" />
        </label>
        <label className="zpa-field zpa-field-wide">
          <span>How you confirmed the customer controls this website</span>
          <textarea
            value={values.siteControlNote}
            onChange={(e) => set("siteControlNote", e.target.value)}
            placeholder="For example: the request came from an address at this domain, and the customer added a DNS record we gave them."
            rows={3}
          />
          <FieldError issues={issues} field="siteControlNote" />
        </label>
        <label className="zpa-field">
          <span>Question limit (at most 20)</span>
          <input type="number" min={1} max={20} value={values.questionLimit} onChange={(e) => set("questionLimit", e.target.value)} />
          <FieldError issues={issues} field="questionLimit" />
        </label>
        <label className="zpa-field">
          <span>Start date, from yesterday to 60 days ahead (the pilot ends 90 days later)</span>
          <input
            type="date"
            min={daysFromToday(-1)}
            max={daysFromToday(60)}
            value={values.startsOn}
            onChange={(e) => set("startsOn", e.target.value)}
          />
          <FieldError issues={issues} field="startsOn" />
        </label>
        <div className="zpa-new-audit-foot">
          {error ? <p className="zpa-new-audit-error">{error}</p> : null}
          <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create pilot"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function AddQuestionPanel({ pilotId, disabled }: { pilotId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const [values, setValues] = useState({
    questionText: "",
    questionProvenance: "",
    customerApprovalRef: "",
    customerApprovedOn: today(),
  });
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof values, v: string) => setValues((c) => ({ ...c, [k]: v }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIssues({});
    setError(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/questions`, { ...values, idempotencyKey: key });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(payload?.error ?? "The question could not be added.");
        return;
      }
      window.location.reload();
    } catch {
      setError("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="zpa-btn zpa-btn-primary"
        disabled={disabled}
        onClick={() => { setKey(newKey()); setOpen(true); }}
      >
        <Plus size={16} strokeWidth={2.2} />
        Add approved question
      </button>
    );
  }

  return (
    <section className="zpa-new-audit" aria-label="Add a question">
      <div className="zpa-new-audit-head">
        <div>
          <h2>Add an approved question</h2>
          <p className="zpa-muted">
            Only a question the customer has approved in writing. Adding it queues its Perplexity
            measurement; nothing runs or is charged until you press Run for it.
          </p>
        </div>
        <button type="button" className="zpa-icon-btn" onClick={() => setOpen(false)} disabled={busy} aria-label="Cancel">
          <X size={18} />
        </button>
      </div>
      <form className="zpa-new-audit-form" onSubmit={submit}>
        <label className="zpa-field zpa-field-wide">
          <span>Buyer question, exactly as approved</span>
          <textarea value={values.questionText} onChange={(e) => set("questionText", e.target.value)} rows={2} />
          <FieldError issues={issues} field="questionText" />
        </label>
        <fieldset className="zpa-field zpa-field-wide">
          <span>Who supplied this question</span>
          <label>
            <input
              type="radio"
              name="questionProvenance"
              checked={values.questionProvenance === "customer_supplied"}
              onChange={() => set("questionProvenance", "customer_supplied")}
            />{" "}
            The customer wrote it
          </label>
          <label>
            <input
              type="radio"
              name="questionProvenance"
              checked={values.questionProvenance === "founder_supplied"}
              onChange={() => set("questionProvenance", "founder_supplied")}
            />{" "}
            Zypact recommended or drafted it (even if the customer edited it)
          </label>
          <FieldError issues={issues} field="questionProvenance" />
        </fieldset>
        <label className="zpa-field">
          <span>Where the customer&apos;s written approval is kept</span>
          <input
            value={values.customerApprovalRef}
            onChange={(e) => set("customerApprovalRef", e.target.value)}
            placeholder="Email “Pilot questions” from the customer"
          />
          <FieldError issues={issues} field="customerApprovalRef" />
        </label>
        <label className="zpa-field">
          <span>Date the customer approved it</span>
          <input type="date" value={values.customerApprovedOn} onChange={(e) => set("customerApprovedOn", e.target.value)} />
          <FieldError issues={issues} field="customerApprovedOn" />
        </label>
        <div className="zpa-new-audit-foot">
          {error ? <p className="zpa-new-audit-error">{error}</p> : null}
          <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
            {busy ? "Adding…" : "Add question"}
          </button>
        </div>
      </form>
    </section>
  );
}

export interface QuestionControlState {
  pilotId: string;
  pilotQuestionId: string;
  jobStatus: string | null;
  stale: boolean;
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  pilotOpen: boolean;
}

/** Run for a queued (or lapsed) measurement; Retry for one that stopped at the provider. */
export function QuestionControls(state: QuestionControlState) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retryKey = useMemo(newKey, []);

  const runnable = state.pilotOpen && (state.jobStatus === "queued" || state.stale);
  const retryable = state.pilotOpen && state.jobStatus === "failed";

  async function run() {
    if (!window.confirm(pilotRunConfirmationText(state))) return;
    setBusy(true);
    setMessage(null);
    try {
      const { payload } = await post(`/api/internal/pilots/${state.pilotId}/questions/${state.pilotQuestionId}/run`, {});
      setMessage(payload?.detail ?? payload?.error ?? "No answer from the server.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const note = window.prompt("Why retry this run? (10-2000 characters, kept with the retry)");
    if (!note) return;
    setBusy(true);
    setMessage(null);
    try {
      const { payload } = await post(`/api/internal/pilots/${state.pilotId}/questions/${state.pilotQuestionId}/retry`, {
        note,
        idempotencyKey: retryKey,
      });
      setMessage(payload?.detail ?? payload?.error ?? "No answer from the server.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (!runnable && !retryable) return null;
  return (
    <div className="zpa-actions">
      {runnable ? (
        <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-primary" onClick={run} disabled={busy}>
          {state.stale ? "Resume" : "Run"}
        </button>
      ) : null}
      {retryable ? (
        <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-amber-ghost" onClick={retry} disabled={busy}>
          Retry failed run
        </button>
      ) : null}
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

export function ClosePilotButton({ pilotId }: { pilotId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function close() {
    const reason = window.prompt(CLOSE_PILOT_PROMPT);
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/close`, { reason });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The pilot could not be closed.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-warn" onClick={close} disabled={busy}>
        Close pilot
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-054 — retires a question whose measurement stopped and cannot go on.
 * The database decides: a measurement that can still be retried, or one
 * that is running, is refused with the reason shown here.
 */
export function RetireQuestionButton({ pilotId, pilotQuestionId }: { pilotId: string; pilotQuestionId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function retire() {
    const reason = window.prompt(
      "Why retire this question? (10-2000 characters)\n\nIts measurement stopped and cannot go on. The question and its evidence are kept, it no longer counts toward the limit, it can never be run again, and you can add the same approved question again."
    );
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/questions/${pilotQuestionId}/retire`, { reason });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The question could not be retired.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-warn" onClick={retire} disabled={busy}>
        Retire question
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}
