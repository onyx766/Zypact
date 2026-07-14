"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  projectId: string;
  hasProbeResults: boolean;
  hasCompetitors: boolean;
}

export function GeneratePanel({
  projectId,
  hasProbeResults,
  hasCompetitors,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{
    competitorCount: number;
    prioritizedCount: number;
    nodesCount: number;
    edgesCount: number;
    normalizedDistances: boolean;
    usedMock: boolean;
  } | null>(null);

  const disabled = busy || !hasProbeResults || !hasCompetitors;

  async function onClick() {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/generate-gap-map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        competitorDistances?: unknown[];
        prioritizedGaps?: unknown[];
        nodesCount?: number;
        edgesCount?: number;
        normalizedDistances?: boolean;
        usedMock?: boolean;
      };
      if (!json.ok) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      setFlash({
        competitorCount: json.competitorDistances?.length ?? 0,
        prioritizedCount: json.prioritizedGaps?.length ?? 0,
        nodesCount: json.nodesCount ?? 0,
        edgesCount: json.edgesCount ?? 0,
        normalizedDistances: Boolean(json.normalizedDistances),
        usedMock: Boolean(json.usedMock),
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
      <button type="button" onClick={onClick} disabled={disabled}>
        {busy ? "Generating…" : "Generate Gap Matrix"}
      </button>
      {!hasProbeResults && (
        <p className="error" style={{ marginTop: 8 }}>
          Run at least one probe analysis before generating a gap map.
        </p>
      )}
      {hasProbeResults && !hasCompetitors && (
        <p className="error" style={{ marginTop: 8 }}>
          Run competitor discovery before generating a gap map.
        </p>
      )}
      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          Error: {error}
        </p>
      )}
      {flash && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: "#f0f6ff",
            border: "1px solid #b6d4fe",
          }}
        >
          <strong>Generated</strong>{" "}
          <span className="muted">
            ({flash.usedMock ? "mock" : "live LLM"}
            {flash.normalizedDistances ? "; distances normalized" : ""})
          </span>
          <div style={{ marginTop: 4 }} className="muted">
            {flash.competitorCount} competitor distances ·{" "}
            {flash.prioritizedCount} prioritized gaps ·{" "}
            {flash.nodesCount} nodes · {flash.edgesCount} edges
          </div>
        </div>
      )}
    </div>
  );
}
