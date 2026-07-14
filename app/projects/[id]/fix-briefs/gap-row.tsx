"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Gap } from "@/lib/db/types";

interface Props {
  projectId: string;
  gap: Gap;
  canGenerate: boolean;
}

const cell: React.CSSProperties = {
  border: "1px solid #ddd",
  padding: "6px 8px",
  verticalAlign: "top",
};

export function GapRow({ projectId, gap, canGenerate }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ status: string; usedMock: boolean } | null>(
    null
  );

  const rowBackground =
    error != null
      ? "#fbf3f3"
      : gap.severity === "high"
        ? "#fbf3f3"
        : gap.severity === "medium"
          ? "#fbf9ef"
          : undefined;

  async function onClick() {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/generate-fix-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, gapId: gap.id }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        fixBrief?: { status: string };
        usedMock?: boolean;
      };
      if (!json.ok) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      setFlash({
        status: json.fixBrief?.status ?? "draft",
        usedMock: Boolean(json.usedMock),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const severityColor =
    gap.severity === "high"
      ? "#721c24"
      : gap.severity === "medium"
        ? "#664d03"
        : "#495057";

  return (
    <tr style={{ background: rowBackground }}>
      <td style={cell}>
        <strong>{gap.type}</strong>
      </td>
      <td style={cell}>
        <strong style={{ color: severityColor }}>{gap.severity}</strong>
      </td>
      <td style={cell}>{gap.explanation}</td>
      <td style={cell}>
        {gap.affectedPrompts.length === 0
          ? "—"
          : `${gap.affectedPrompts.length} prompt${gap.affectedPrompts.length === 1 ? "" : "s"}`}
      </td>
      <td style={cell}>{gap.suggestedFixDirection}</td>
      <td style={cell}>
        <button type="button" onClick={onClick} disabled={busy || !canGenerate}>
          {busy ? "Generating…" : "Generate Fix Brief"}
        </button>
        {flash && (
          <div style={{ marginTop: 6, fontSize: 11 }} className="muted">
            saved · status: <strong>{flash.status}</strong>{" "}
            ({flash.usedMock ? "mock" : "live LLM"})
          </div>
        )}
        {error && (
          <div style={{ marginTop: 6, fontSize: 11 }} className="error">
            {error}
          </div>
        )}
      </td>
    </tr>
  );
}
