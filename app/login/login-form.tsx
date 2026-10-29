"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface Props {
  next: string;
}

export function LoginForm({ next }: Props) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const origin = window.location.origin;
      const nextParam = encodeURIComponent(
        next || "/admin/snapshot-requests"
      );
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${nextParam}`,
          // Existing accounts only. Not a control on its own (the browser
          // can be bypassed); the server-side allowlist is.
          shouldCreateUser: false,
        },
      });
      if (err) {
        setError(err.message);
        return;
      }
      window.location.href = `/login?sent=1&next=${nextParam}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="founder-login-form" onSubmit={onSubmit}>
      <label className="founder-login-label" htmlFor="founder-email">
        Email
      </label>
      <div className="founder-login-field">
        <svg
          className="founder-login-field-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3.5 6 8.5 7 8.5-7" />
        </svg>
        <input
          id="founder-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder="you@company.com"
        />
      </div>

      <button
        type="submit"
        className="founder-login-submit"
        disabled={busy || email.length === 0}
      >
        {busy ? (
          "Sending…"
        ) : (
          <>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4Z" />
            </svg>
            Send magic link
          </>
        )}
      </button>

      {error ? (
        <div className="founder-login-alert founder-login-alert-error" role="alert">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16h.01" />
          </svg>
          <p className="founder-login-alert-title">{error}</p>
        </div>
      ) : null}
    </form>
  );
}
