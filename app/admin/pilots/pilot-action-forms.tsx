"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import {
  EDIT_PILOT_ACTION_NOTE,
  MAX_ACTION_EVIDENCE,
  PILOT_ACTION_STATUS_WORDS,
  PILOT_ACTION_TEXT_FIELDS,
  REVIEW_PILOT_ACTION_PROMPT,
  WITHDRAW_PILOT_ACTION_PROMPT,
  type PilotActionStatus,
} from "@/lib/pilots/action-copy";

/**
 * D-057 — the founder's suggested actions for one pilot. An action is
 * written by the team and links to the stored answers it rests on, picked
 * question by question from each answer's own sources, never typed. A saved
 * version is a draft until it is reviewed; only reviewed versions reach a
 * report, and an edit needs a new review.
 */

type Issues = Record<string, string[]>;
type TextKey = (typeof PILOT_ACTION_TEXT_FIELDS)[number]["key"];

export interface PilotActionView {
  actionId: string;
  status: PilotActionStatus;
  versionNumber: number;
  title: string;
  observation: string;
  suggestedAction: string;
  whyItMightMatter: string;
  alternativeExplanations: string;
  openQuestions: string;
  withdrawReason: string | null;
  evidence: {
    attemptId: string;
    sourceUrl: string | null;
    words: string;
    /** The stored answer's text, read after its fingerprint check, for the founder to read before a review. */
    answerText: string | null;
    answerNote: string | null;
  }[];
}

export interface PilotActionQuestion {
  pilotQuestionId: string;
  ordinal: number;
  text: string;
}

interface Choice {
  attemptId: string;
  engineLabel: string;
  answerNumber: number;
  summary: string;
  sources: { url: string; domain: string; cited: boolean }[];
}

interface Link {
  attemptId: string;
  sourceUrl: string | null;
  words: string;
}

async function send(url: string, body: unknown): Promise<{ ok: boolean; payload: Record<string, any> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  return { ok: response.ok && Boolean(payload?.ok), payload };
}

export function PilotActionsPanel({
  pilotId,
  questions,
  actions,
}: {
  pilotId: string;
  questions: PilotActionQuestion[];
  actions: PilotActionView[];
}) {
  const [editing, setEditing] = useState<PilotActionView | "new" | null>(null);

  return (
    <div>
      {editing ? (
        <PilotActionForm
          key={editing === "new" ? "new" : `${editing.actionId}-${editing.versionNumber}`}
          pilotId={pilotId}
          questions={questions}
          action={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className="zpa-btn zpa-btn-primary"
          disabled={questions.length === 0}
          onClick={() => setEditing("new")}
        >
          <Plus size={16} strokeWidth={2.2} />
          Write a suggested action
        </button>
      )}

      {actions.length === 0 ? (
        <p className="zpa-muted">No suggested action yet.</p>
      ) : (
        actions.map((a, i) => (
          <article key={a.actionId} className="zpa-card">
            <h3 className="zpa-question">
              {i + 1}. {a.title}
            </h3>
            <p className="zpa-muted">
              {PILOT_ACTION_STATUS_WORDS[a.status]} · version {a.versionNumber}
              {a.withdrawReason ? ` · ${a.withdrawReason}` : ""}
            </p>
            <ul className="zpa-muted">
              {PILOT_ACTION_TEXT_FIELDS.filter((f) => f.key !== "title").map((f) => (
                <li key={f.key}>
                  <strong>{f.label}:</strong> {a[f.key]}
                </li>
              ))}
            </ul>
            <p className="zpa-muted">
              <strong>Based on:</strong>
            </p>
            <ul className="zpa-muted">
              {a.evidence.map((e) => (
                <li key={`${e.attemptId}-${e.sourceUrl ?? ""}`}>
                  {e.words}
                  {e.sourceUrl ? (
                    <>
                      {" "}
                      <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                        open the source
                      </a>
                    </>
                  ) : null}
                  <details>
                    <summary>Read the stored answer</summary>
                    {e.answerText !== null ? (
                      <p style={{ whiteSpace: "pre-wrap" }}>{e.answerText}</p>
                    ) : (
                      <p>{e.answerNote ?? "No stored answer."}</p>
                    )}
                  </details>
                </li>
              ))}
            </ul>
            {a.status !== "withdrawn" ? (
              <div className="zpa-actions">
                <p className="zpa-muted">{EDIT_PILOT_ACTION_NOTE}</p>
                <button type="button" className="zpa-btn zpa-btn-sm" onClick={() => setEditing(a)}>
                  Edit (a new version, reviewed again)
                </button>
                {a.status === "draft" ? <ReviewActionButton pilotId={pilotId} action={a} /> : null}
                <WithdrawActionButton pilotId={pilotId} actionId={a.actionId} />
              </div>
            ) : null}
          </article>
        ))
      )}
    </div>
  );
}

function PilotActionForm({
  pilotId,
  questions,
  action,
  onClose,
}: {
  pilotId: string;
  questions: PilotActionQuestion[];
  action: PilotActionView | null;
  onClose: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<Record<TextKey, string>>(() => ({
    title: action?.title ?? "",
    observation: action?.observation ?? "",
    suggestedAction: action?.suggestedAction ?? "",
    whyItMightMatter: action?.whyItMightMatter ?? "",
    alternativeExplanations: action?.alternativeExplanations ?? "",
    openQuestions: action?.openQuestions ?? "",
  }));
  const [links, setLinks] = useState<Link[]>(() =>
    (action?.evidence ?? []).map((e) => ({ attemptId: e.attemptId, sourceUrl: e.sourceUrl, words: e.words }))
  );
  const [questionId, setQuestionId] = useState("");
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [answerId, setAnswerId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [issues, setIssues] = useState<Issues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickQuestion(id: string) {
    setQuestionId(id);
    setChoices(null);
    setAnswerId("");
    setSourceUrl("");
    if (!id) return;
    try {
      const response = await fetch(`/api/internal/pilots/${pilotId}/actions/evidence?pilotQuestionId=${id}`, {
        headers: { accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
      setChoices(response.ok && payload?.ok ? (payload.choices as Choice[]) : []);
    } catch {
      setChoices([]);
    }
  }

  function addLink() {
    const question = questions.find((q) => q.pilotQuestionId === questionId);
    const answer = choices?.find((c) => c.attemptId === answerId);
    if (!question || !answer) return;
    const url = sourceUrl || null;
    if (links.some((l) => l.attemptId === answer.attemptId && l.sourceUrl === url)) return;
    const words = `Question ${question.ordinal}, ${answer.engineLabel} answer ${answer.answerNumber}${url ? `; source ${url}` : ""}`;
    setLinks((current) => [...current, { attemptId: answer.attemptId, sourceUrl: url, words }]);
    setAnswerId("");
    setSourceUrl("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIssues({});
    setError(null);
    try {
      const { ok, payload } = await send(`/api/internal/pilots/${pilotId}/actions`, {
        ...values,
        actionId: action?.actionId ?? null,
        expectedVersion: action?.versionNumber ?? null,
        evidence: links.map((l) => ({ attemptId: l.attemptId, sourceUrl: l.sourceUrl })),
        idempotencyKey: key,
      });
      if (!ok) {
        if (payload?.issues) setIssues(payload.issues as Issues);
        setError(payload?.error ?? "The action could not be saved.");
        return;
      }
      window.location.reload();
    } catch {
      setError("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const answer = choices?.find((c) => c.attemptId === answerId);

  return (
    <section className="zpa-new-audit" aria-label="Write a suggested action">
      <div className="zpa-new-audit-head">
        <div>
          <h2>{action ? `Edit: a new version of "${action.title}"` : "Write a suggested action"}</h2>
          <p className="zpa-muted">
            A hypothesis to test, written from the stored answers, never a prediction. It is saved as a draft and appears in
            a report only once you review it. It names no owner, timing or expected result: those are set if the customer
            chooses to test it as a registered change.
          </p>
          {action ? <p className="zpa-muted">{EDIT_PILOT_ACTION_NOTE}</p> : null}
        </div>
        <button type="button" className="zpa-icon-btn" onClick={onClose} disabled={busy} aria-label="Cancel">
          <X size={18} />
        </button>
      </div>
      <form className="zpa-new-audit-form" onSubmit={submit}>
        {PILOT_ACTION_TEXT_FIELDS.map((f) => (
          <label key={f.key} className="zpa-field zpa-field-wide">
            <span>
              {f.label} ({f.min}-{f.max} characters)
            </span>
            {f.key === "title" ? (
              <input value={values[f.key]} onChange={(e) => setValues((c) => ({ ...c, [f.key]: e.target.value }))} />
            ) : (
              <textarea rows={3} value={values[f.key]} onChange={(e) => setValues((c) => ({ ...c, [f.key]: e.target.value }))} />
            )}
            {issues[f.key] ? <span className="zpa-new-audit-error">{issues[f.key].join(" ")}</span> : null}
          </label>
        ))}

        <fieldset className="zpa-field zpa-field-wide">
          <span>
            The answers it rests on (1 to {MAX_ACTION_EVIDENCE}), picked from this pilot&apos;s stored answers
          </span>
          {links.length === 0 ? <p className="zpa-muted">No answer linked yet.</p> : null}
          <ul className="zpa-muted">
            {links.map((l) => (
              <li key={`${l.attemptId}-${l.sourceUrl ?? ""}`}>
                {l.words}{" "}
                <button
                  type="button"
                  className="zpa-btn zpa-btn-sm"
                  onClick={() => setLinks((c) => c.filter((x) => !(x.attemptId === l.attemptId && x.sourceUrl === l.sourceUrl)))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <select value={questionId} onChange={(e) => void pickQuestion(e.target.value)}>
            <option value="">Choose a question</option>
            {questions.map((q) => (
              <option key={q.pilotQuestionId} value={q.pilotQuestionId}>
                {q.ordinal}. {q.text}
              </option>
            ))}
          </select>
          {choices !== null && choices.length === 0 ? (
            <p className="zpa-muted">This question has no completed, verified answer yet.</p>
          ) : null}
          {choices && choices.length > 0 ? (
            <select value={answerId} onChange={(e) => { setAnswerId(e.target.value); setSourceUrl(""); }}>
              <option value="">Choose an answer</option>
              {choices.map((c) => (
                <option key={c.attemptId} value={c.attemptId}>
                  {c.engineLabel} answer {c.answerNumber}: {c.summary.slice(0, 120)}
                </option>
              ))}
            </select>
          ) : null}
          {answer ? (
            <select value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}>
              <option value="">The answer itself, no particular source</option>
              {answer.sources.map((s) => (
                <option key={s.url} value={s.url}>
                  {s.cited ? "Cited" : "Returned, not cited"}: {s.url}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="zpa-btn zpa-btn-sm"
            onClick={addLink}
            disabled={!answer || links.length >= MAX_ACTION_EVIDENCE}
          >
            Link this answer
          </button>
          {issues.evidence ? <span className="zpa-new-audit-error">{issues.evidence.join(" ")}</span> : null}
        </fieldset>

        <div className="zpa-new-audit-foot">
          {error ? <p className="zpa-new-audit-error">{error}</p> : null}
          <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save as a draft"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ReviewActionButton({ pilotId, action }: { pilotId: string; action: PilotActionView }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function review() {
    if (!window.confirm(REVIEW_PILOT_ACTION_PROMPT)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await send(`/api/internal/pilots/${pilotId}/actions/${action.actionId}/review`, {
        versionNumber: action.versionNumber,
        confirmed: true,
      });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The action could not be reviewed.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-primary" onClick={review} disabled={busy}>
        I have read it: mark reviewed
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </>
  );
}

function WithdrawActionButton({ pilotId, actionId }: { pilotId: string; actionId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function withdraw() {
    const reason = window.prompt(WITHDRAW_PILOT_ACTION_PROMPT);
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, payload } = await send(`/api/internal/pilots/${pilotId}/actions/${actionId}/withdraw`, { reason });
      if (ok) {
        window.location.reload();
        return;
      }
      setMessage(payload?.error ?? "The action could not be withdrawn.");
    } catch {
      setMessage("The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="zpa-btn zpa-btn-sm zpa-btn-warn" onClick={withdraw} disabled={busy}>
        Withdraw
      </button>
      {message ? <p className="zpa-action-note">{message}</p> : null}
    </>
  );
}
