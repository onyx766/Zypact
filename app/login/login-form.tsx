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
    <form onSubmit={onSubmit}>
      <label>
        Email{" "}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          style={{ width: 260 }}
        />
      </label>{" "}
      <button type="submit" disabled={busy || email.length === 0}>
        {busy ? "Sending…" : "Send magic link"}
      </button>
      {error ? (
        <p style={{ color: "crimson" }} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
