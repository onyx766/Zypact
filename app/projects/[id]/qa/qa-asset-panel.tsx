"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  projectId: string;
  asset: {
    id: string;
    title: string;
    assetType: string;
    qaStatus: string;
  };
  canRun: boolean;
  hasExistingReport: boolean;
}

interface RunQaFlash {
  verdict: string;
  violations: number;
  placeholders: number;
  qaStatus: string;
  usedMock: boolean;
}

/**
 * Sprint 9 client component. Fires the `POST /api/projects/run-qa`
 * endpoint for a single asset and shows a raw summary flash inline.
 *
 * We intentionally do not render export / copy / publish buttons here —
 * those are out of Sprint 9 scope.
 */
export function QaAssetPanel({ projectId, asset, canRun, hasExistingReport }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<RunQaFlash | null>(null);

  async function onRun() {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/run-qa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, assetId: asset.id }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        qaReport?: {
          verdict: string;
          violations: unknown[];
          placeholdersRemaining: unknown[];
        };
        asset?: { qaStatus: string };
        usedMock?: boolean;
      };
      if (!json.ok || !json.qaReport || !json.asset) {
        setError(json.error ?? "Unknown error");
        return;
      }
      setFlash({
        verdict: json.qaReport.verdict,
        violations: json.qaReport.violations.length,
        placeholders: json.qaReport.placeholdersRemaining.length,
        qaStatus: json.asset.qaStatus,
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
    <div>
      <button type="button" onClick={onRun} disabled={!canRun || busy}>
        {busy
          ? "Running QA…"
          : hasExistingReport
            ? "Re-run QA"
            : "Run QA"}
      </button>
      {!canRun && (
        <div className="error" style={{ marginTop: 4, fontSize: 11 }}>
          Prepare Evidence Bank first.
        </div>
      )}
      {error && (
        <div className="error" style={{ marginTop: 4, fontSize: 11 }}>
          {error}
        </div>
      )}
      {flash && (
        <div
          style={{
            marginTop: 6,
            padding: 6,
            background: "#f0f6ff",
            border: "1px solid #b6d4fe",
            fontSize: 11,
          }}
        >
          Verdict: <strong>{flash.verdict}</strong> · violations:{" "}
          {flash.violations} · placeholders: {flash.placeholders} · qaStatus:{" "}
          <strong>{flash.qaStatus}</strong>{" "}
          <span className="muted">
            ({flash.usedMock ? "mock" : "live LLM"})
          </span>
        </div>
      )}
    </div>
  );
}
