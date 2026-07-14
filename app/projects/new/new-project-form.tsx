"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewProjectForm() {
  const router = useRouter();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/run-mirror-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ websiteUrl, companyName: companyName || undefined }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        projectId?: string;
        error?: string;
      };
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/projects/new")}`);
        return;
      }
      if (!json.ok || !json.projectId) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      router.push(`/projects/${json.projectId}/mirror`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={onSubmit}>
        <label htmlFor="url">Website URL</label>
        <input
          id="url"
          type="text"
          required
          placeholder="https://example.com"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
        />

        <label htmlFor="company">Company name (optional)</label>
        <input
          id="company"
          type="text"
          placeholder="Acme Inc."
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />

        <button type="submit" disabled={busy}>
          {busy ? "Running Mirror Scan…" : "Run Mirror Scan"}
        </button>
      </form>

      {busy && (
        <p className="muted" style={{ marginTop: 16 }}>
          Crawling + reading the site. This can take 20–60 seconds.
        </p>
      )}
      {error && (
        <p className="error" style={{ marginTop: 16 }}>
          Error: {error}
        </p>
      )}
    </>
  );
}
