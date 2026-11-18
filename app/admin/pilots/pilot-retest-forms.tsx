"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

import type { PilotQuestionEngine } from "@/lib/db/types";
import { pilotHeldReasonText, pilotJobStatusLabel, pilotRunsLine } from "@/lib/pilots/copy";
import {
  ABANDON_RETEST_PROMPT,
  confirmRetestPrompt,
  PREPARE_RETEST_PROMPT,
  REQUEUE_RETEST_PROMPT,
  RETEST_HYPOTHESIS_HINT,
  RETEST_REGISTER_BELOW_LIMIT_CONFIRMATION,
  RETEST_REGISTER_CONFIRMATION,
  RETEST_THRESHOLD_QUESTION,
  retestRouteErrorText,
  retestRunConfirmationAddition,
} from "@/lib/pilots/retest-copy";
import {
  ACTION_TYPE_WORDS,
  OUTCOME_RULE_SENTENCES,
  OUTCOME_STATUS_ORDER,
  PILOT_RETEST_LIMIT_SENTENCE,
  RETEST_GROUP_STATE_WORDS,
  RETEST_MEMBER_STATE_WORDS,
  RETEST_NOTE_KIND_WORDS,
} from "@/lib/reports/pilot-retest-copy";
import { QuestionControls, ResolveReviewControls } from "./pilot-forms";

/**
 * D-062 — the pilot page's Retest card: register a customer change, record
 * it as live, prepare its retests once the waiting period ends, run and
 * resolve each retest per question and engine, queue again one that stopped
 * before any answer, withdraw the change until its first retest answer, and
 * log other changes. Each form sends a fresh idempotency key per opened form
 * where the database takes one. The routes check everything again; the
 * console only shows what the page read. Every word is plain: no stored
 * code is shown.
 */

type Issues = Record<string, string[]>;

function newKey(): string {
  return crypto.randomUUID();
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysFrom(days: number): string {
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

function RuleSentences() {
  return (
    <>
      <p className="zpa-muted">{PILOT_RETEST_LIMIT_SENTENCE}</p>
      <ul className="zpa-muted">
        {OUTCOME_STATUS_ORDER.map((s) => (
          <li key={s}>{OUTCOME_RULE_SENTENCES[s]}</li>
        ))}
      </ul>
    </>
  );
}

/* ---------------------------------------------------------------- register */

export interface RetestRegisterQuestion {
  pilotQuestionId: string;
  ordinal: number;
  text: string;
  refusal: string | null;
}

const TEXT_FIELDS = [
  "changeTitle",
  "changeDescription",
  "changeTarget",
  "changeOwner",
  "hypothesis",
  "expectedMechanism",
  "alternativeExplanations",
  "openQuestions",
  "decisionThreshold",
  "confoundersToMonitor",
] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export function RetestRegisterPanel({
  pilotId,
  questions,
  sourceActions,
  labels,
  maxQuestions,
}: {
  pilotId: string;
  questions: RetestRegisterQuestion[];
  sourceActions: { versionId: string; title: string }[];
  /** The registered fields' labels (lib/pilots/retest-rules.ts RETEST_TEXT_LABELS, M18). */
  labels: Record<TextField, string>;
  maxQuestions: number;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const [picked, setPicked] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [text, setText] = useState<Record<TextField, string>>(
    Object.fromEntries(TEXT_FIELDS.map((f) => [f, ""])) as Record<TextField, string>
  );
  const [actionType, setActionType] = useState("");
  const [observationDays, setObservationDays] = useState("21");
  const [approvalRef, setApprovalRef] = useState("");
  const [approvedOn, setApprovedOn] = useState(today());
  // No pre-fill (M2): the founder answers the threshold question explicitly.
  const [belowLimit, setBelowLimit] = useState<"" | "yes" | "no">("");
  const [confirmed, setConfirmed] = useState(false);
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (list: string[], set: (v: string[]) => void, id: string, max: number) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : list.length >= max ? list : [...list, id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIssues({});
    setError(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/retests`, {
        ...text,
        pilotQuestionIds: picked,
        actionType,
        thresholdBelowLimit: belowLimit === "" ? null : belowLimit === "yes",
        observationDays,
        customerApprovalRef: approvalRef,
        customerApprovedOn: approvedOn,
        sourceActionVersionIds: sources,
        confirmed,
        idempotencyKey: key,
      });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(retestRouteErrorText(payload?.error, "The change could not be registered."));
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
      <button type="button" className="zpa-btn zpa-btn-primary" onClick={() => { setKey(newKey()); setOpen(true); }}>
        <Plus size={16} strokeWidth={2.2} />
        Register a change to measure again
      </button>
    );
  }

  const area = (f: TextField, rows = 2, hint?: string) => (
    <label key={f} className="zpa-field zpa-field-wide">
      <span>{labels[f]}</span>
      <textarea value={text[f]} onChange={(e) => setText((c) => ({ ...c, [f]: e.target.value }))} rows={rows} />
      {hint ? <span className="zpa-muted">{hint}</span> : null}
      <FieldError issues={issues} field={f} />
    </label>
  );

  return (
    <section className="zpa-new-audit" aria-label="Register a change">
      <div className="zpa-new-audit-head">
        <div>
          <h2>Register a change</h2>
          <p className="zpa-muted">
            Only after the customer approved the change in writing. Each chosen question is measured again on Perplexity and
            on ChatGPT once the waiting period ends. Nothing runs or is spent now.
          </p>
          <RuleSentences />
        </div>
        <button type="button" className="zpa-icon-btn" onClick={() => setOpen(false)} disabled={busy} aria-label="Cancel">
          <X size={18} />
        </button>
      </div>
      <form className="zpa-new-audit-form" onSubmit={submit}>
        <fieldset className="zpa-field zpa-field-wide">
          <span>Questions (at most {maxQuestions})</span>
          {questions.map((q) => (
            <label key={q.pilotQuestionId}>
              <input
                type="checkbox"
                disabled={q.refusal !== null}
                checked={picked.includes(q.pilotQuestionId)}
                onChange={() => toggle(picked, setPicked, q.pilotQuestionId, maxQuestions)}
              />{" "}
              {q.ordinal}. {q.text}
              {q.refusal ? <span className="zpa-muted"> ({q.refusal})</span> : null}
            </label>
          ))}
          <FieldError issues={issues} field="pilotQuestionIds" />
        </fieldset>
        <label className="zpa-field zpa-field-wide">
          <span>{labels.changeTitle}</span>
          <input value={text.changeTitle} onChange={(e) => setText((c) => ({ ...c, changeTitle: e.target.value }))} />
          <FieldError issues={issues} field="changeTitle" />
        </label>
        {area("changeDescription", 3)}
        {area("changeTarget")}
        {area("changeOwner", 1)}
        <label className="zpa-field">
          <span>Kind of change</span>
          <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
            <option value="">Choose…</option>
            {Object.entries(ACTION_TYPE_WORDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <FieldError issues={issues} field="actionType" />
        </label>
        {area("hypothesis", 3, RETEST_HYPOTHESIS_HINT)}
        {area("expectedMechanism", 3)}
        {area("alternativeExplanations", 3)}
        {area("openQuestions", 3)}
        {area("decisionThreshold", 3)}
        <fieldset className="zpa-field zpa-field-wide">
          <span>{RETEST_THRESHOLD_QUESTION}</span>
          <label>
            <input type="radio" name="belowLimit" checked={belowLimit === "yes"} onChange={() => setBelowLimit("yes")} /> Yes
          </label>
          <label>
            <input type="radio" name="belowLimit" checked={belowLimit === "no"} onChange={() => setBelowLimit("no")} /> No
          </label>
          <FieldError issues={issues} field="thresholdBelowLimit" />
        </fieldset>
        {area("confoundersToMonitor", 3)}
        <label className="zpa-field">
          <span>Waiting period (days)</span>
          <input type="number" min={7} max={60} value={observationDays} onChange={(e) => setObservationDays(e.target.value)} />
          <FieldError issues={issues} field="observationDays" />
        </label>
        <label className="zpa-field">
          <span>Where the customer&apos;s written approval is kept</span>
          <input value={approvalRef} onChange={(e) => setApprovalRef(e.target.value)} />
          <FieldError issues={issues} field="customerApprovalRef" />
        </label>
        <label className="zpa-field">
          <span>Date the customer approved it</span>
          <input type="date" max={today()} value={approvedOn} onChange={(e) => setApprovedOn(e.target.value)} />
          <FieldError issues={issues} field="customerApprovedOn" />
        </label>
        {sourceActions.length > 0 ? (
          <fieldset className="zpa-field zpa-field-wide">
            <span>From reviewed suggested actions (optional, at most 5)</span>
            {sourceActions.map((a) => (
              <label key={a.versionId}>
                <input type="checkbox" checked={sources.includes(a.versionId)} onChange={() => toggle(sources, setSources, a.versionId, 5)} />{" "}
                {a.title}
              </label>
            ))}
            <FieldError issues={issues} field="sourceActionVersionIds" />
          </fieldset>
        ) : null}
        <label className="zpa-field zpa-field-wide">
          <span>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {RETEST_REGISTER_CONFIRMATION}
            {belowLimit === "yes" ? ` ${RETEST_REGISTER_BELOW_LIMIT_CONFIRMATION}` : ""}
          </span>
          <FieldError issues={issues} field="confirmed" />
        </label>
        <div className="zpa-new-audit-foot">
          {error ? <p className="zpa-new-audit-error">{error}</p> : null}
          <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy || !confirmed}>
            {busy ? "Registering…" : "Register the change"}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------------------------------------------------------------- a live change */

export interface RetestCellView {
  memberId: string;
  engine: PilotQuestionEngine;
  state: string;
  jobStatus: string | null;
  stale: boolean;
  needsReviewReason: string | null;
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  completedRuns: number;
  failedRuns: number;
  excludedRuns: number;
  /** Every attempt of the retest; none means it stopped before any answer. */
  attempts: number;
  canRequeue: boolean;
}

export interface RetestGroupView {
  id: string;
  sequence: number;
  state: string;
  fields: { label: string; text: string }[];
  observationDays: number;
  implementBy: string;
  wentLiveOn: string | null;
  windowClosesAt: string | null;
  canAbandon: boolean;
  canPrepare: boolean;
  questions: { pilotQuestionId: string; ordinal: number; cells: RetestCellView[] }[];
  notes: { id: string; line: string }[];
}

function closesOnAfter(days: number): string {
  return daysFrom(days);
}

function StepButton({
  label,
  prompt,
  ask,
  url,
  body,
  tone = "",
}: {
  label: string;
  prompt: string;
  /** "reason": the prompt asks for a written reason; "confirm": a yes or no. */
  ask: "reason" | "confirm";
  url: string;
  body: (answer: string | true) => unknown;
  tone?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function run(answer: string | true) {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await post(url, body(answer));
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(retestRouteErrorText(payload?.error, "No answer from the server."));
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
        className={`zpa-btn zpa-btn-sm ${tone}`}
        disabled={busy}
        onClick={() => {
          if (ask === "reason") {
            const answer = window.prompt(prompt);
            if (answer) void run(answer);
          } else if (window.confirm(prompt)) {
            void run(true);
          }
        }}
      >
        {label}
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </div>
  );
}

function RecordLiveForm({ pilotId, group }: { pilotId: string; group: RetestGroupView }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ wentLiveOn: today(), evidenceUrl: "", artifactSha256: "", note: "", deviationNote: "" });
  const [asRegistered, setAsRegistered] = useState<"" | "yes" | "no">("");
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof values, v: string) => setValues((c) => ({ ...c, [k]: v }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!window.confirm(confirmRetestPrompt(group.observationDays, closesOnAfter(group.observationDays)))) return;
    setBusy(true);
    setIssues({});
    setError(null);
    try {
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/retests/${group.id}/implementation`, {
        wentLiveOn: values.wentLiveOn,
        evidenceUrl: values.evidenceUrl || null,
        artifactSha256: values.artifactSha256 || null,
        note: values.note,
        implementedAsRegistered: asRegistered === "" ? null : asRegistered === "yes",
        deviationNote: asRegistered === "no" ? values.deviationNote : null,
        confirmed: true,
      });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(retestRouteErrorText(payload?.error, "The change could not be recorded as live."));
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
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-primary" onClick={() => setOpen(true)}>
        Record the change as live
      </button>
    );
  }
  return (
    <form className="zpa-new-audit-form" onSubmit={submit}>
      <p className="zpa-muted">
        The waiting period starts when you record this and ends {group.observationDays} days later; it can never be moved. The
        change must not have gone live before it was registered.
      </p>
      <label className="zpa-field">
        <span>Go-live date the customer reports</span>
        <input type="date" max={today()} value={values.wentLiveOn} onChange={(e) => set("wentLiveOn", e.target.value)} />
        <FieldError issues={issues} field="wentLiveOn" />
      </label>
      <label className="zpa-field zpa-field-wide">
        <span>Link to the live change</span>
        <input value={values.evidenceUrl} onChange={(e) => set("evidenceUrl", e.target.value)} placeholder="https://" />
        <FieldError issues={issues} field="evidenceUrl" />
      </label>
      <label className="zpa-field zpa-field-wide">
        <span>Or its SHA-256 fingerprint</span>
        <input value={values.artifactSha256} onChange={(e) => set("artifactSha256", e.target.value)} />
        <FieldError issues={issues} field="artifactSha256" />
      </label>
      <label className="zpa-field zpa-field-wide">
        <span>Internal note (not shown to the customer)</span>
        <textarea value={values.note} onChange={(e) => set("note", e.target.value)} rows={2} />
        <FieldError issues={issues} field="note" />
      </label>
      <fieldset className="zpa-field zpa-field-wide">
        <span>Was the change made as registered?</span>
        <label>
          <input type="radio" name={`asRegistered-${group.id}`} checked={asRegistered === "yes"} onChange={() => setAsRegistered("yes")} /> Yes
        </label>
        <label>
          <input type="radio" name={`asRegistered-${group.id}`} checked={asRegistered === "no"} onChange={() => setAsRegistered("no")} /> No
        </label>
        <FieldError issues={issues} field="implementedAsRegistered" />
      </fieldset>
      {asRegistered === "no" ? (
        <label className="zpa-field zpa-field-wide">
          <span>How it differs (written to the log of other changes, which the customer reads)</span>
          <textarea value={values.deviationNote} onChange={(e) => set("deviationNote", e.target.value)} rows={2} />
          <FieldError issues={issues} field="deviationNote" />
        </label>
      ) : null}
      <div className="zpa-new-audit-foot">
        {error ? <p className="zpa-new-audit-error">{error}</p> : null}
        <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
          {busy ? "Recording…" : "Record as live"}
        </button>
      </div>
    </form>
  );
}

function AddNoteForm({ pilotId, group }: { pilotId: string; group: RetestGroupView }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(newKey);
  const [values, setValues] = useState({ notedOn: today(), kind: "", text: "", correctsNoteId: "" });
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
      const { ok, payload } = await post(`/api/internal/pilots/${pilotId}/retests/${group.id}/notes`, {
        ...values,
        correctsNoteId: values.correctsNoteId || null,
        idempotencyKey: key,
      });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(retestRouteErrorText(payload?.error, "The note could not be added."));
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
      <button type="button" className="zpa-btn zpa-btn-sm" onClick={() => { setKey(newKey()); setOpen(true); }}>
        Log another change
      </button>
    );
  }
  return (
    <form className="zpa-new-audit-form" onSubmit={submit}>
      <label className="zpa-field">
        <span>Kind of change</span>
        <select value={values.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="">Choose…</option>
          {Object.entries(RETEST_NOTE_KIND_WORDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <FieldError issues={issues} field="kind" />
      </label>
      <label className="zpa-field">
        <span>Day it happened</span>
        <input type="date" max={today()} value={values.notedOn} onChange={(e) => set("notedOn", e.target.value)} />
        <FieldError issues={issues} field="notedOn" />
      </label>
      <label className="zpa-field zpa-field-wide">
        <span>What changed (the customer reads this)</span>
        <textarea value={values.text} onChange={(e) => set("text", e.target.value)} rows={2} />
        <FieldError issues={issues} field="text" />
      </label>
      {group.notes.length > 0 ? (
        <label className="zpa-field zpa-field-wide">
          <span>Corrects an earlier note (optional)</span>
          <select value={values.correctsNoteId} onChange={(e) => set("correctsNoteId", e.target.value)}>
            <option value="">None</option>
            {group.notes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.line.slice(0, 80)}
              </option>
            ))}
          </select>
          <FieldError issues={issues} field="correctsNoteId" />
        </label>
      ) : null}
      <div className="zpa-new-audit-foot">
        {error ? <p className="zpa-new-audit-error">{error}</p> : null}
        <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add to the log"}
        </button>
      </div>
    </form>
  );
}

export function RetestGroupPanel({
  pilotId,
  group,
  pilotOpen,
  retestEnabled,
  chatgptConnected,
}: {
  pilotId: string;
  group: RetestGroupView;
  /** The pilot is open and inside its dates. */
  pilotOpen: boolean;
  /** The web host's retest gate (ZYPACT_PILOT_RETEST_ENABLED), read by the page at request time. */
  retestEnabled: boolean;
  /** The web host's ChatGPT gate. */
  chatgptConnected: boolean;
}) {
  const base = `/api/internal/pilots/${pilotId}/retests/${group.id}`;
  const requeueReason = useMemo(() => REQUEUE_RETEST_PROMPT, []);
  return (
    <div className="zpa-card">
      <h3 className="zpa-title">
        Change {group.sequence}: {RETEST_GROUP_STATE_WORDS[group.state] ?? "Unknown state"}
      </h3>
      <ul className="zpa-muted">
        {group.fields.map((f) => (
          <li key={f.label}>
            <strong>{f.label}:</strong> {f.text}
          </li>
        ))}
        <li>
          <strong>Waiting period:</strong> {group.observationDays} days. To go live by {group.implementBy}.
          {group.wentLiveOn ? ` Went live on ${group.wentLiveOn}.` : ""}
          {group.windowClosesAt ? ` The waiting period ends ${group.windowClosesAt.slice(0, 16).replace("T", " ")} UTC.` : ""}
        </li>
      </ul>
      <RuleSentences />

      <div className="zpa-toolbar">
        {retestEnabled && pilotOpen && group.state === "registered" ? <RecordLiveForm pilotId={pilotId} group={group} /> : null}
        {retestEnabled && pilotOpen && group.canPrepare ? (
          <StepButton label="Prepare the retests" prompt={PREPARE_RETEST_PROMPT} ask="confirm" url={`${base}/prepare`} body={() => ({})} tone="zpa-btn-primary" />
        ) : null}
        {group.canAbandon ? (
          <StepButton
            label="Withdraw the change"
            prompt={ABANDON_RETEST_PROMPT}
            ask="reason"
            url={`${base}/abandon`}
            body={(reason) => ({ reason, confirmed: true })}
            tone="zpa-btn-warn"
          />
        ) : null}
      </div>

      <table className="zpa-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Perplexity</th>
            <th>ChatGPT</th>
          </tr>
        </thead>
        <tbody>
          {group.questions.map((q) => (
            <tr key={q.pilotQuestionId}>
              <td>{q.ordinal}</td>
              {(["perplexity_sonar", "openai_chatgpt"] as const).map((engine) => {
                const c = q.cells.find((x) => x.engine === engine);
                if (!c) return <td key={engine}>—</td>;
                const connected = retestEnabled && (engine === "perplexity_sonar" || chatgptConnected);
                return (
                  <td key={engine}>
                    <p>{RETEST_MEMBER_STATE_WORDS[c.state] ?? "Unknown state"}</p>
                    {c.jobStatus !== null ? (
                      <>
                        <p className="zpa-muted">{pilotJobStatusLabel(c.jobStatus, c.stale)}</p>
                        <p className="zpa-muted">
                          {pilotRunsLine({
                            plannedRuns: c.plannedRuns,
                            completedRuns: c.completedRuns,
                            failedRuns: c.failedRuns,
                            excludedRuns: c.excludedRuns,
                          })}
                        </p>
                      </>
                    ) : null}
                    {c.jobStatus === "needs_review" ? (
                      <>
                        <p className="zpa-muted">{pilotHeldReasonText(c.needsReviewReason, engine)}</p>
                        <ResolveReviewControls pilotId={pilotId} pilotQuestionId={q.pilotQuestionId} engine={engine} phase="retest" />
                      </>
                    ) : null}
                    {connected && c.jobStatus !== null ? (
                      <QuestionControls
                        pilotId={pilotId}
                        pilotQuestionId={q.pilotQuestionId}
                        engine={engine}
                        jobStatus={c.jobStatus}
                        stale={c.stale}
                        plannedRuns={c.plannedRuns}
                        runCap={c.runCap}
                        spendCapUsd={c.spendCapUsd}
                        pilotOpen={pilotOpen}
                        phase="retest"
                        confirmAddition={retestRunConfirmationAddition(q.ordinal, engine)}
                        noRetry={c.attempts === 0}
                      />
                    ) : null}
                    {retestEnabled && pilotOpen && c.canRequeue ? (
                      <StepButton
                        label="Queue again"
                        prompt={requeueReason}
                        ask="reason"
                        url={`${base}/requeue`}
                        body={(reason) => ({ pilotQuestionId: q.pilotQuestionId, engine, reason })}
                      />
                    ) : null}
                    {!connected && c.jobStatus !== null ? (
                      <p className="zpa-muted">Run and Retry of this retest are off on this server.</p>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Other changes we recorded</h4>
      {group.notes.length === 0 ? (
        <p className="zpa-muted">None yet.</p>
      ) : (
        <ul className="zpa-muted">
          {group.notes.map((n) => (
            <li key={n.id}>{n.line}</li>
          ))}
        </ul>
      )}
      {group.state !== "abandoned" ? <AddNoteForm pilotId={pilotId} group={group} /> : null}
    </div>
  );
}
