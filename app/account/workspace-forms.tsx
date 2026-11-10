"use client";

/**
 * Client forms for the customer workspace (P1, P2). Each posts JSON to its
 * own route (never a form post, as the account pages), then reloads the
 * page so what is shown is always what the database stored.
 */
import { useState } from "react";

type Message = { tone: "success" | "error"; text: string } | null;

async function postJson(endpoint: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body: parsed };
  } catch {
    return { ok: false, body: { message: "Something went wrong. Please try again." } };
  }
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  async function submit(endpoint: string, body: unknown, after: "reload" | "redirect" | "stay" = "reload", success?: string) {
    setBusy(true);
    setMessage(null);
    const res = await postJson(endpoint, body);
    if (res.ok) {
      if (after === "redirect" && typeof res.body.redirect === "string") {
        window.location.assign(res.body.redirect);
        return true;
      }
      if (after === "reload") {
        window.location.reload();
        return true;
      }
      setMessage({ tone: "success", text: success ?? "Saved." });
      setBusy(false);
      return true;
    }
    setMessage({ tone: "error", text: typeof res.body.message === "string" ? res.body.message : "Something went wrong. Please try again." });
    setBusy(false);
    return false;
  }
  return { busy, message, submit };
}

function Alert({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <div className={`zw-alert is-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
      {message.text}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Website and diagnostic (P1)                                          */
/* ------------------------------------------------------------------ */

export function WebsiteForm({ defaultCompany }: { defaultCompany: string }) {
  const [website, setWebsite] = useState("");
  const [companyName, setCompanyName] = useState(defaultCompany);
  const { busy, message, submit } = useSubmit();
  return (
    <form
      className="zw-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/account/website", { website, companyName }, "reload");
      }}
    >
      <label className="zw-label">
        Website address
        <input className="zw-input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" autoComplete="url" />
      </label>
      <label className="zw-label">
        Company name
        <input className="zw-input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoComplete="organization" />
      </label>
      <div>
        <button className="zw-button" type="submit" disabled={busy || !website.trim() || !companyName.trim()}>
          {busy ? "Saving…" : "Save website"}
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

export function RunDiagnosticButton({ label }: { label: string }) {
  const { busy, message, submit } = useSubmit();
  return (
    <div className="zw-form">
      <div>
        <button className="zw-button" type="button" disabled={busy} onClick={() => void submit("/api/account/diagnostic", {}, "reload")}>
          {busy ? "Checking your site… this can take up to a minute" : label}
        </button>
      </div>
      <Alert message={message} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Brand Profile and objective (P1)                                     */
/* ------------------------------------------------------------------ */

export interface ProfileFormValues {
  expectedVersion: number;
  companyName: string;
  description: string;
  category: string;
  audience: string;
  competitors: string;
  objective: string;
  basedOnRunId: string;
}

export function ProfileForm({ initial, objectives }: { initial: ProfileFormValues; objectives: Array<{ id: string; label: string }> }) {
  const [v, setV] = useState(initial);
  const { busy, message, submit } = useSubmit();
  const set = (k: keyof ProfileFormValues) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      className="zw-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/account/brand-profile", v, "redirect");
      }}
    >
      <label className="zw-label">
        Company name
        <input className="zw-input" value={v.companyName} onChange={set("companyName")} />
      </label>
      <label className="zw-label">
        What you sell <span className="zw-hint">One or two sentences, in your own words.</span>
        <textarea className="zw-textarea" value={v.description} onChange={set("description")} maxLength={1000} />
      </label>
      <label className="zw-label">
        Category <span className="zw-hint">What a buyer would call your kind of product, e.g. “inventory software”.</span>
        <input className="zw-input" value={v.category} onChange={set("category")} maxLength={120} />
      </label>
      <label className="zw-label">
        Who you sell to <span className="zw-hint">e.g. “independent retailers with 1–20 stores”.</span>
        <input className="zw-input" value={v.audience} onChange={set("audience")} maxLength={300} />
      </label>
      <label className="zw-label">
        Competitors <span className="zw-hint">One per line, up to 10.</span>
        <textarea className="zw-textarea" value={v.competitors} onChange={set("competitors")} />
      </label>
      <fieldset className="zw-label" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ marginBottom: 6 }}>What do you want to learn first?</legend>
        {objectives.map((o) => (
          <label key={o.id} className="zw-radio">
            <input type="radio" name="objective" value={o.id} checked={v.objective === o.id} onChange={set("objective")} />
            <span>{o.label}</span>
          </label>
        ))}
      </fieldset>
      <div>
        <button className="zw-button" type="submit" disabled={busy || !v.companyName.trim()}>
          {busy ? "Saving…" : "Save Brand Profile"}
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Draft questions (P2)                                                 */
/* ------------------------------------------------------------------ */

type Option = { id: string; label: string };

export function AddDraftForm({ categories }: { categories: Option[] }) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState(categories[0]?.id ?? "discovery");
  const { busy, message, submit } = useSubmit();
  return (
    <form
      className="zw-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/account/questions", { text, category }, "reload");
      }}
    >
      <label className="zw-label">
        Question
        <input className="zw-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Write it the way a buyer would ask it" />
      </label>
      <div className="zw-row">
        <label className="zw-label" style={{ flex: 1 }}>
          Type
          <select className="zw-select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button className="zw-button" type="submit" disabled={busy || text.trim().length < 8}>
          {busy ? "Adding…" : "Add draft"}
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

export function AddSuggestionButton({ text, category, rule }: { text: string; category: string; rule: string }) {
  const { busy, message, submit } = useSubmit();
  return (
    <span className="zw-inline">
      <button
        className="zw-button is-secondary is-small"
        type="button"
        disabled={busy}
        onClick={() => void submit("/api/account/questions", { text, category, suggestionRule: rule }, "reload")}
      >
        {busy ? "Adding…" : "Add as draft"}
      </button>
      <Alert message={message} />
    </span>
  );
}

export function DraftEditor({
  draft,
  categories,
}: {
  draft: { id: string; version: number; text: string; category: string; status: "draft" | "archived" };
  categories: Option[];
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  const [category, setCategory] = useState(draft.category);
  const { busy, message, submit } = useSubmit();
  const save = (status: "draft" | "archived", t = text, c = category) =>
    void submit("/api/account/questions/revise", { draftId: draft.id, expectedVersion: draft.version, text: t, category: c, status }, "reload");

  if (!editing) {
    return (
      <span className="zw-inline">
        {draft.status === "draft" ? (
          <>
            <button className="zw-button is-secondary is-small" type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="zw-button is-secondary is-small" type="button" disabled={busy} onClick={() => save("archived", draft.text, draft.category)}>
              Archive
            </button>
          </>
        ) : (
          <button className="zw-button is-secondary is-small" type="button" disabled={busy} onClick={() => save("draft", draft.text, draft.category)}>
            Restore
          </button>
        )}
        <Alert message={message} />
      </span>
    );
  }
  return (
    <form
      className="zw-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save("draft");
      }}
    >
      <input className="zw-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} aria-label="Question" />
      <div className="zw-row">
        <select className="zw-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Type" style={{ flex: 1 }}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="zw-button" type="submit" disabled={busy || text.trim().length < 8}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="zw-button is-secondary" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Actions (P2)                                                         */
/* ------------------------------------------------------------------ */

export interface ActionFieldValues {
  title: string;
  observation: string;
  whyItMatters: string;
  nextStep: string;
  ownerName: string;
}

export function TrackFindingButton({
  evidence,
  fields,
}: {
  evidence: { runId: string; checkId: string; pageUrl: string | null };
  fields: ActionFieldValues;
}) {
  const { busy, message, submit } = useSubmit();
  return (
    <span className="zw-inline">
      <button
        className="zw-button is-small"
        type="button"
        disabled={busy}
        onClick={() => void submit("/api/account/actions", { ...fields, evidence: { kind: "site_diagnostic_finding", ...evidence } }, "reload")}
      >
        {busy ? "Adding…" : "Track as an action"}
      </button>
      <Alert message={message} />
    </span>
  );
}

function ActionFieldsInputs({ v, set }: { v: ActionFieldValues; set: (k: keyof ActionFieldValues) => (e: { target: { value: string } }) => void }) {
  return (
    <>
      <label className="zw-label">
        Title
        <input className="zw-input" value={v.title} onChange={set("title")} maxLength={160} />
      </label>
      <label className="zw-label">
        Observation <span className="zw-hint">What did you find?</span>
        <textarea className="zw-textarea" value={v.observation} onChange={set("observation")} maxLength={1000} />
      </label>
      <label className="zw-label">
        Why it matters <span className="zw-hint">Optional. Why this could be relevant to your goal.</span>
        <textarea className="zw-textarea" value={v.whyItMatters} onChange={set("whyItMatters")} maxLength={1000} />
      </label>
      <label className="zw-label">
        Next step <span className="zw-hint">What specifically should the team look into?</span>
        <textarea className="zw-textarea" value={v.nextStep} onChange={set("nextStep")} maxLength={1000} />
      </label>
      <label className="zw-label">
        Owner <span className="zw-hint">Optional. Who is responsible?</span>
        <input className="zw-input" value={v.ownerName} onChange={set("ownerName")} maxLength={120} />
      </label>
    </>
  );
}

export function NewNoteActionForm() {
  const [v, setV] = useState<ActionFieldValues>({ title: "", observation: "", whyItMatters: "", nextStep: "", ownerName: "" });
  const [note, setNote] = useState("");
  const { busy, message, submit } = useSubmit();
  const set = (k: keyof ActionFieldValues) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form
      className="zw-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/account/actions", { ...v, evidence: { kind: "customer_note", note } }, "reload");
      }}
    >
      <ActionFieldsInputs v={v} set={set} />
      <label className="zw-label">
        Evidence <span className="zw-hint">Where and when did you see this? Recorded once and not editable later.</span>
        <textarea className="zw-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
      <div>
        <button className="zw-button" type="submit" disabled={busy || !v.title.trim() || !v.observation.trim() || !v.nextStep.trim() || !note.trim()}>
          {busy ? "Adding…" : "Add action"}
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

export function ActionEditor({
  action,
  statuses,
}: {
  action: ActionFieldValues & { id: string; version: number; status: string; decisionNote: string };
  statuses: Option[];
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<ActionFieldValues>(action);
  const [status, setStatus] = useState(action.status);
  const [decisionNote, setDecisionNote] = useState(action.decisionNote);
  const { busy, message, submit } = useSubmit();
  const set = (k: keyof ActionFieldValues) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  if (!open) {
    return (
      <button className="zw-button is-secondary is-small" type="button" onClick={() => setOpen(true)}>
        Update
      </button>
    );
  }
  return (
    <form
      className="zw-form zw-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/account/actions/revise", { ...v, actionId: action.id, expectedVersion: action.version, status, decisionNote }, "reload");
      }}
    >
      <ActionFieldsInputs v={v} set={set} />
      <label className="zw-label">
        Status
        <select className="zw-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="zw-label">
        Decision <span className="zw-hint">Optional. What was decided, and why.</span>
        <textarea className="zw-textarea" value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={1000} />
      </label>
      <div className="zw-row">
        <button className="zw-button" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="zw-button is-secondary" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Reports (P2)                                                         */
/* ------------------------------------------------------------------ */

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      className="zw-button"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied("done");
        } catch {
          setCopied("failed");
        }
      }}
    >
      {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed — select the text below" : label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Question approval (Q4)                                               */
/* ------------------------------------------------------------------ */

/**
 * Approves a draft's current wording. If the server asks for a step-up, the
 * password is confirmed through S1's step-up route and the approval is
 * retried with the same idempotency key, so a double click or a retry never
 * creates a second approval.
 */
export function ApproveDraftButton({
  draftId,
  expectedVersion,
  label,
  consentText,
  consentVersion,
}: {
  draftId: string;
  expectedVersion: number;
  label: string;
  consentText: string;
  consentVersion: string;
}) {
  const [open, setOpen] = useState(false);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function approve() {
    setBusy(true);
    setMessage(null);
    if (needPassword) {
      const step = await postJson("/api/account/step-up", { password });
      setPassword("");
      if (!step.ok) {
        setMessage({ tone: "error", text: typeof step.body.message === "string" ? step.body.message : "That password was not accepted." });
        setBusy(false);
        return;
      }
    }
    const res = await postJson("/api/account/questions/approve", { draftId, expectedVersion, idempotencyKey: key, consentVersion });
    if (res.ok) {
      window.location.reload();
      return;
    }
    if (res.body.error === "step_up_required") {
      setNeedPassword(true);
      setMessage({ tone: "error", text: "Confirm your password to approve." });
    } else {
      setMessage({ tone: "error", text: typeof res.body.message === "string" ? res.body.message : "Something went wrong. Please try again." });
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button className="zw-button is-small" type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form
      className="zw-form zw-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void approve();
      }}
    >
      <p className="zw-small" style={{ margin: 0 }}>{consentText}</p>
      {needPassword ? (
        <label className="zw-label">
          Password
          <input className="zw-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      ) : null}
      <div className="zw-row">
        <button className="zw-button" type="submit" disabled={busy || (needPassword && password.length === 0)}>
          {busy ? "Approving…" : "I approve"}
        </button>
        <button className="zw-button is-secondary" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Alert message={message} />
    </form>
  );
}

export function ArchiveActiveButton({ buyerQuestionId }: { buyerQuestionId: string }) {
  const { busy, message, submit } = useSubmit();
  return (
    <span className="zw-inline">
      <button
        className="zw-button is-secondary is-small"
        type="button"
        disabled={busy}
        onClick={() => {
          if (window.confirm("Archive this question? It stops being measured. Its results are kept, and runs it already used are not given back.")) {
            void submit("/api/account/questions/archive-active", { buyerQuestionId }, "reload");
          }
        }}
      >
        {busy ? "Archiving…" : "Archive"}
      </button>
      <Alert message={message} />
    </span>
  );
}
