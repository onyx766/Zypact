"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import type { PilotQuestionEngine } from "@/lib/db/types";
import {
  ADD_CHATGPT_BUTTON_LABEL,
  ADD_CHATGPT_PROMPT,
  ADD_CHATGPT_TO_ALL_BUTTON_LABEL,
  ADD_QUESTION_ALSO_CHATGPT_LABEL,
  addChatGptToAllPrompt,
  addChatGptToAllSummary,
  addQuestionPanelNote,
  CLOSE_PILOT_PROMPT,
  PILOT_REVIEW_BUTTON_LABEL,
  PILOT_REVIEW_RESOLUTION_PROMPT,
  pilotRetryPrompt,
  pilotRunConfirmationText,
  RETIRE_BOTH_ENGINES_NOTE,
  RETIRE_PILOT_QUESTION_PROMPT,
} from "@/lib/pilots/copy";
import { SHARE_NEEDS_REVIEW_PROMPT, SHARE_PASSED_PROMPT } from "@/lib/reports/pilot-report-copy";

/**
 * D-054 — the founder's pilot controls. Each form sends a fresh
 * idempotency key per opened form, so a repeated press after a lost
 * response replays instead of creating a second pilot or question.
 *
 * D-061 — two engines. Run and Retry name their engine in the body; a
 * ChatGPT measurement is added per question or to every question without
 * one, one call after another; a measurement held for review is resolved
 * here; Retire stays per question and stops it on both engines. Whether
 * ChatGPT is connected comes from the page, which reads the web host's gate
 * at request time; the routes check it again.
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

export function AddQuestionPanel({
  pilotId,
  disabled,
  chatgptConnected,
}: {
  pilotId: string;
  disabled: boolean;
  /** D-061 — the web host's ChatGPT gate, read by the page at request time. */
  chatgptConnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const [values, setValues] = useState({
    questionText: "",
    questionProvenance: "",
    customerApprovalRef: "",
    customerApprovedOn: today(),
  });
  // D-061 — off unless ticked: a queued ChatGPT measurement raises the
  // spending room every later start needs, so it is never added silently.
  const [addChatGpt, setAddChatGpt] = useState(false);
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
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/questions`, {
        ...values,
        idempotencyKey: key,
        addChatGpt: chatgptConnected && addChatGpt,
      });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(payload?.error ?? "The question could not be added.");
        return;
      }
      // D-061 — the question was added but its ChatGPT measurement was not:
      // say so before the page reloads, where it shows as not measured.
      if (payload?.chatgptAdded === false && typeof payload.detail === "string") window.alert(payload.detail);
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
          <p className="zpa-muted">{addQuestionPanelNote(chatgptConnected)}</p>
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
        {chatgptConnected ? (
          <fieldset className="zpa-field zpa-field-wide">
            <span>ChatGPT</span>
            <label>
              <input type="checkbox" checked={addChatGpt} onChange={(e) => setAddChatGpt(e.target.checked)} />{" "}
              {ADD_QUESTION_ALSO_CHATGPT_LABEL}
            </label>
          </fieldset>
        ) : null}
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
  /** D-061 — the engine of this measurement; Run and Retry name it in their body. */
  engine: PilotQuestionEngine;
  jobStatus: string | null;
  stale: boolean;
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  pilotOpen: boolean;
  /** D-062 — the slot's phase: a retest names `phase: "retest"` in its Run and Retry bodies. Absent: the baseline. */
  phase?: "baseline" | "retest";
  /** D-062 — added to the Run confirmation (a retest's own words). */
  confirmAddition?: string;
  /** D-062 — a retest that stopped before any answer is queued again, not retried: no Retry. */
  noRetry?: boolean;
}

/** Run for a queued (or lapsed) measurement; Retry for one that stopped at the provider. One engine's. */
export function QuestionControls(state: QuestionControlState) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const retryKey = useMemo(newKey, []);

  const runnable = state.pilotOpen && (state.jobStatus === "queued" || state.stale);
  const retryable = state.pilotOpen && state.jobStatus === "failed" && !state.noRetry;

  async function run() {
    const confirmText = pilotRunConfirmationText(state) + (state.confirmAddition ? `\n\n${state.confirmAddition}` : "");
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { payload } = await post(`/api/internal/pilots/${state.pilotId}/questions/${state.pilotQuestionId}/run`, {
        engine: state.engine,
        ...(state.phase === "retest" ? { phase: "retest" } : {}),
      });
      setMessage(payload?.detail ?? payload?.error ?? "No answer from the server.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const note = window.prompt(pilotRetryPrompt(state.engine));
    if (!note) return;
    setBusy(true);
    setMessage(null);
    try {
      const { payload } = await post(`/api/internal/pilots/${state.pilotId}/questions/${state.pilotQuestionId}/retry`, {
        note,
        idempotencyKey: retryKey,
        engine: state.engine,
        ...(state.phase === "retest" ? { phase: "retest" } : {}),
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

export function ClosePilotButton({ pilotId, warnings = [] }: { pilotId: string; /** D-062 (M19) — said before closing. */ warnings?: string[] }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function close() {
    const reason = window.prompt([CLOSE_PILOT_PROMPT, ...warnings].join("\n\n"));
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
 * 20261109200000 — marks a pilot as a customer pilot or an internal practice
 * run. The next report revision carries the label; nothing is measured
 * differently and no stored revision changes. `purpose` null: the database
 * has no purpose yet (its migration is not applied), so nothing is offered.
 */
export function PilotPurposeControl({ pilotId, purpose }: { pilotId: string; purpose: "customer" | "internal_practice" | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (purpose === null) {
    return <p className="zpa-muted">Purpose: not available until the database update for it is applied.</p>;
  }
  const next = purpose === "customer" ? "internal_practice" : "customer";

  async function change() {
    const ok = window.confirm(
      next === "internal_practice"
        ? "Mark this pilot as an internal practice run? Its next report revision will say “Internal practice run — not a customer report” at the top. Revisions already built keep their label."
        : "Mark this pilot as a customer pilot? Its next report revision will carry no practice label. Revisions already built keep their label."
    );
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok: done, payload } = await post(`/api/internal/pilots/${pilotId}/purpose`, { purpose: next });
      if (done) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The purpose could not be changed.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <p className="zpa-muted">
        <strong>Purpose:</strong> {purpose === "customer" ? "Customer pilot" : "Internal practice run (labelled on its report)"}
      </p>
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={change} disabled={busy}>
        {next === "internal_practice" ? "Mark as internal practice run" : "Mark as customer pilot"}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-054 — retires a question whose measurement stopped and cannot go on.
 * The database decides: a measurement that can still be retried, or one
 * that is running, is refused with the reason shown here.
 *
 * D-061 — per question, never per engine: it looks at every engine's
 * measurement, and retiring stops the question on both.
 */
export function RetireQuestionButton({ pilotId, pilotQuestionId }: { pilotId: string; pilotQuestionId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function retire() {
    const reason = window.prompt(RETIRE_PILOT_QUESTION_PROMPT);
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
      <p className="zpa-muted">{RETIRE_BOTH_ENGINES_NOTE}</p>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

function addEngineUrl(pilotId: string, pilotQuestionId: string): string {
  return `/api/internal/pilots/${pilotId}/questions/${pilotQuestionId}/engines`;
}

/**
 * D-061 — adds the ChatGPT measurement to one question. It queues it and
 * starts nothing: the founder then presses Run for it on ChatGPT.
 */
export function AddChatGptButton({ pilotId, pilotQuestionId }: { pilotId: string; pilotQuestionId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    if (!window.confirm(ADD_CHATGPT_PROMPT)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(addEngineUrl(pilotId, pilotQuestionId), { engine: "openai_chatgpt" });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "ChatGPT could not be added.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={add} disabled={busy}>
        {busy ? "Adding…" : ADD_CHATGPT_BUTTON_LABEL}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-061 — adds the ChatGPT measurement to every live question without one,
 * one call after another (never in parallel), and says how many were added.
 * Each call is the per-question add: it replays on a question that already
 * has ChatGPT, and starts nothing.
 */
export function AddChatGptToAllButton({ pilotId, pilotQuestionIds }: { pilotId: string; pilotQuestionIds: string[] }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function addAll() {
    if (pilotQuestionIds.length === 0 || !window.confirm(addChatGptToAllPrompt(pilotQuestionIds.length))) return;
    setBusy(true);
    setMessage(null);
    let added = 0;
    let firstRefusal: string | null = null;
    try {
      for (const pilotQuestionId of pilotQuestionIds) {
        let refusal: string | null = null;
        try {
          const { ok, payload } = await post(addEngineUrl(pilotId, pilotQuestionId), { engine: "openai_chatgpt" });
          if (ok) added += 1;
          else refusal = typeof payload?.error === "string" ? payload.error : "ChatGPT could not be added.";
        } catch {
          refusal = "The request did not reach the server.";
        }
        if (refusal !== null && firstRefusal === null) firstRefusal = refusal;
      }
      if (added === pilotQuestionIds.length) {
        window.location.reload();
        return;
      }
      setMessage(`${addChatGptToAllSummary(added, pilotQuestionIds.length, firstRefusal)} Refresh the page to see them.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={addAll} disabled={busy}>
        {busy ? "Adding…" : ADD_CHATGPT_TO_ALL_BUTTON_LABEL}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-061 — resolves one engine's measurement held for review, with the
 * request page's two resolutions and note rules. It runs and spends
 * nothing; the job comes from the pilot's own tables, not from this form.
 */
export function ResolveReviewControls({
  pilotId,
  pilotQuestionId,
  engine,
  phase = "baseline",
}: {
  pilotId: string;
  pilotQuestionId: string;
  engine: PilotQuestionEngine;
  /** D-062 — a retest held for review is resolved the same way, with `phase: "retest"`. */
  phase?: "baseline" | "retest";
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function resolve(resolution: "excluded_and_completed" | "failed") {
    const note = window.prompt(PILOT_REVIEW_RESOLUTION_PROMPT[resolution]);
    if (!note) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/questions/${pilotQuestionId}/review`, {
        engine,
        resolution,
        note,
        ...(phase === "retest" ? { phase: "retest" } : {}),
      });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The review could not be recorded.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button
        type="button"
        className="zpa-btn zpa-btn-sm zpa-btn-amber-ghost"
        onClick={() => resolve("excluded_and_completed")}
        disabled={busy}
      >
        {PILOT_REVIEW_BUTTON_LABEL.excluded_and_completed}
      </button>
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-warn" onClick={() => resolve("failed")} disabled={busy}>
        {PILOT_REVIEW_BUTTON_LABEL.failed}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-055 — builds a new revision of the pilot's combined report from stored
 * evidence. It spends nothing and shares nothing.
 */
export function BuildPilotReportButton({ pilotId }: { pilotId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function build() {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/report`, {});
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The report could not be built.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={build} disabled={busy}>
        {busy ? "Building…" : "Build report"}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

/**
 * D-055 — the founder's share of the latest revision, offered only on the
 * revision's preview page (app/admin/pilots/[pilotId]/report/[artifactId]),
 * below the revision rendered exactly as the customer will see it. The
 * confirmation says the founder has read this revision; a revision that
 * needs review also sends the acknowledgement the database requires. A
 * blocked revision has no Share button and the database refuses it anyway.
 */
export function SharePilotReportButton({
  pilotId,
  artifactId,
  needsReview,
}: {
  pilotId: string;
  artifactId: string;
  needsReview: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function share() {
    if (!window.confirm(needsReview ? SHARE_NEEDS_REVIEW_PROMPT : SHARE_PASSED_PROMPT)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/report/${artifactId}/share`, {
        acknowledgeNeedsReview: needsReview,
      });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The report could not be shared.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zpa-actions">
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={share} disabled={busy}>
        {needsReview ? "I have read it and every reason: share" : "I have read it: share"}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}
