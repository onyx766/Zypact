"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  projectId: string;
  hasProbeResults: boolean;
}

export function DiscoverPanel({ projectId, hasProbeResults }: Props) {
  const router = useRouter();
  const [userCompetitorsInput, setUserCompetitorsInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    competitorCount: number;
    phantomCount: number;
    blindSpotCount: number;
  } | null>(null);

  async function onClick() {
    setError(null);
    setSummary(null);
    setMeta(null);
    setBusy(true);
    const userCompetitors = userCompetitorsInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    try {
      const res = await fetch("/api/projects/discover-competitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, userCompetitors }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        summary?: string;
        competitors?: unknown[];
        phantomCompetitors?: string[];
        blindSpots?: string[];
      };
      if (!json.ok) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      setSummary(json.summary ?? "");
      setMeta({
        competitorCount: json.competitors?.length ?? 0,
        phantomCount: json.phantomCompetitors?.length ?? 0,
        blindSpotCount: json.blindSpots?.length ?? 0,
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <div>
        <strong>User-declared competitors</strong>{" "}
        <span className="muted">(optional; one per line or comma-separated)</span>
      </div>
      <textarea
        value={userCompetitorsInput}
        onChange={(e) => setUserCompetitorsInput(e.target.value)}
        rows={4}
        placeholder="Zapier
Make
Notion"
        style={{
          width: "100%",
          padding: 8,
          font: "inherit",
          border: "1px solid #999",
          background: "white",
        }}
      />
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={onClick}
          disabled={busy || !hasProbeResults}
        >
          {busy ? "Discovering…" : "Discover Competitors"}
        </button>
        {!hasProbeResults && (
          <span className="error" style={{ marginLeft: 12 }}>
            Run at least one probe analysis before discovering competitors.
          </span>
        )}
      </div>

      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          Error: {error}
        </p>
      )}

      {summary && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: "#f0f6ff",
            border: "1px solid #b6d4fe",
          }}
        >
          <strong>Summary:</strong> {summary}
          {meta && (
            <div style={{ marginTop: 4 }} className="muted">
              {meta.competitorCount} competitors · {meta.phantomCount} phantom ·{" "}
              {meta.blindSpotCount} blind spots
            </div>
          )}
        </div>
      )}
    </div>
  );
}
