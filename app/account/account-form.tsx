"use client";

import { useState } from "react";

export interface AccountField {
  name: string;
  label: string;
  type: "email" | "password" | "text";
  autoComplete: string;
  placeholder?: string;
}

/**
 * One form for every account page. Posts JSON (never a form post, so a
 * cross-site page cannot submit it without a CORS preflight) and either
 * follows the server's redirect or shows its message. Field values never
 * leave this component except in that one request.
 */
export function AccountForm({
  endpoint,
  fields,
  submitLabel,
  busyLabel,
}: {
  endpoint: string;
  fields: AccountField[];
  submitLabel: string;
  busyLabel: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = (await res.json().catch(() => ({}))) as { redirect?: string; message?: string };
      if (res.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      if (res.ok) {
        setMessage({ tone: "success", text: body.message ?? "Done." });
        setValues({});
        return;
      }
      setMessage({ tone: "error", text: body.message ?? "Something went wrong. Please try again." });
    } catch {
      setMessage({ tone: "error", text: "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const complete = fields.every((f) => (values[f.name] ?? "").length > 0);

  return (
    <form className="founder-login-form" onSubmit={onSubmit} noValidate>
      {fields.map((field) => (
        <div key={field.name}>
          <label className="founder-login-label" htmlFor={`account-${field.name}`}>
            {field.label}
          </label>
          <div className="founder-login-field">
            <input
              id={`account-${field.name}`}
              type={field.type}
              value={values[field.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
              autoComplete={field.autoComplete}
              placeholder={field.placeholder}
              required
              style={{ paddingLeft: 16 }}
            />
          </div>
        </div>
      ))}

      <button type="submit" className="founder-login-submit" disabled={busy || !complete}>
        {busy ? busyLabel : submitLabel}
      </button>

      {message ? (
        <div
          className={`founder-login-alert founder-login-alert-${message.tone}`}
          role={message.tone === "error" ? "alert" : "status"}
        >
          <p className="founder-login-alert-title">{message.text}</p>
        </div>
      ) : null}
    </form>
  );
}

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { redirect?: string };
      window.location.assign(body.redirect ?? "/account/sign-in");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="founder-login-submit" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
