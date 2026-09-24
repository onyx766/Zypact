"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

/**
 * Creates an audit for a prospect who never used the public form.
 *
 * The five fields are exactly the public form's, because the route validates
 * with the same normalizer: a founder-created audit must not be able to carry
 * a domain, email or question shape the public path would have refused. The
 * difference is which limits apply, not which values are legal.
 *
 * An inline panel rather than a modal, deliberately: a dialog needs a focus
 * trap, an escape key and a restore target to be usable with a keyboard, and
 * none of that is worth owning for a five-field form the page has room for.
 */

interface FieldIssues {
  [field: string]: string[];
}

const FIELDS = [
  {
    key: "contactName",
    label: "Contact name",
    placeholder: "Dana Buyer",
    type: "text",
  },
  {
    key: "workEmail",
    label: "Work email",
    placeholder: "dana@prospect.com",
    type: "email",
    hint: "Where the report is sent when you deliver it.",
  },
  {
    key: "companyName",
    label: "Company name",
    placeholder: "Prospect Inc",
    type: "text",
  },
  {
    key: "websiteUrl",
    label: "Company website",
    placeholder: "prospect.com",
    type: "text",
    hint: "The domain the audit measures.",
  },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"] | "buyerCategory";

const EMPTY: Record<FieldKey, string> = {
  contactName: "",
  workEmail: "",
  companyName: "",
  websiteUrl: "",
  buyerCategory: "",
};

export function NewAuditPanel() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<FieldKey, string>>(EMPTY);
  const [issues, setIssues] = useState<FieldIssues>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(key: FieldKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function close() {
    setOpen(false);
    setValues(EMPTY);
    setIssues({});
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setIssues({});
    setError(null);

    try {
      const response = await fetch("/api/internal/snapshot-requests", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(values),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        if (payload?.issues) setIssues(payload.issues as FieldIssues);
        setError(
          payload?.detail ??
            (payload?.issues
              ? "Check the highlighted fields."
              : "The audit could not be created.")
        );
        return;
      }

      // Straight to review: the row is `pending_approval`, and approving it is
      // the next thing the founder has to do — and the only thing that can
      // lead to a paid call.
      window.location.href = payload.reviewPath;
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
        onClick={() => setOpen(true)}
      >
        <Plus size={16} strokeWidth={2.2} />
        New audit
      </button>
    );
  }

  return (
    <section className="zpa-new-audit" aria-label="Create an audit">
      <div className="zpa-new-audit-head">
        <div>
          <h2>New audit</h2>
          <p className="zpa-muted">
            For a prospect who never used the public form. Created as pending
            approval — nothing is scanned or charged until you approve it.
          </p>
        </div>
        <button
          type="button"
          className="zpa-icon-btn"
          onClick={close}
          disabled={busy}
          aria-label="Cancel"
        >
          <X size={18} />
        </button>
      </div>

      <form className="zpa-new-audit-form" onSubmit={submit}>
        {FIELDS.map((field) => (
          <label key={field.key} className="zpa-field">
            <span>{field.label}</span>
            <input
              type={field.type}
              value={values[field.key]}
              onChange={(event) => set(field.key, event.target.value)}
              placeholder={field.placeholder}
              disabled={busy}
              required
              aria-invalid={Boolean(issues[field.key])}
            />
            {issues[field.key] ? (
              <small className="zpa-field-error">{issues[field.key].join(" ")}</small>
            ) : "hint" in field && field.hint ? (
              <small>{field.hint}</small>
            ) : null}
          </label>
        ))}

        <label className="zpa-field zpa-field-wide">
          <span>Buyer question</span>
          <textarea
            rows={3}
            value={values.buyerCategory}
            onChange={(event) => set("buyerCategory", event.target.value)}
            placeholder="Which SOC 2 automation platforms are best for a 50-person B2B SaaS company?"
            maxLength={300}
            disabled={busy}
            required
            aria-invalid={Boolean(issues.buyerCategory)}
          />
          {issues.buyerCategory ? (
            <small className="zpa-field-error">{issues.buyerCategory.join(" ")}</small>
          ) : (
            <small>
              One commercially important question a buyer would actually ask —
              not a category. {values.buyerCategory.trim().length}/300
            </small>
          )}
        </label>

        {error ? <p className="zpa-new-audit-error">{error}</p> : null}

        <div className="zpa-new-audit-foot">
          <button type="button" className="zpa-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="zpa-btn zpa-btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create audit"}
          </button>
        </div>
      </form>
    </section>
  );
}
