"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AssetType =
  | "comparison_page_outline"
  | "faq_block"
  | "proof_block"
  | "comparison_table"
  | "json_ld_schema";

const ASSET_BUTTONS: Array<{ type: AssetType; label: string }> = [
  { type: "comparison_page_outline", label: "Generate comparison page outline" },
  { type: "faq_block", label: "Generate FAQ block" },
  { type: "proof_block", label: "Generate proof block" },
  { type: "comparison_table", label: "Generate comparison table" },
  { type: "json_ld_schema", label: "Generate JSON-LD schema" },
];

interface Props {
  projectId: string;
  brief: {
    id: string;
    lostPrompt: string;
    recommendedFix: string;
    status: string;
    priority: number;
    fixType: string;
    assetsToGenerate: string[];
  };
  canGenerate: boolean;
  existingAssetCount: number;
}

export function FixBriefPanel({
  projectId,
  brief,
  canGenerate,
  existingAssetCount,
}: Props) {
  const router = useRouter();
  const [busyType, setBusyType] = useState<AssetType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{
    assetType: AssetType;
    title: string;
    placeholders: number;
    claimsUsed: number;
    qaStatus: string;
    usedMock: boolean;
  } | null>(null);

  async function onGenerate(assetType: AssetType) {
    setError(null);
    setFlash(null);
    setBusyType(assetType);
    try {
      const res = await fetch("/api/projects/generate-asset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          fixBriefId: brief.id,
          assetType,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        asset?: {
          title: string;
          assetType: string;
          placeholders: string[];
          claimsUsed: unknown[];
          qaStatus: string;
        };
        usedMock?: boolean;
      };
      if (!json.ok || !json.asset) {
        setError(json.error ?? "Unknown error");
        return;
      }
      setFlash({
        assetType,
        title: json.asset.title,
        placeholders: json.asset.placeholders.length,
        claimsUsed: json.asset.claimsUsed.length,
        qaStatus: json.asset.qaStatus,
        usedMock: Boolean(json.usedMock),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyType(null);
    }
  }

  const statusColor =
    brief.status === "needs_evidence"
      ? "#664d03"
      : brief.status === "ready_for_assets"
        ? "#0f5132"
        : "#495057";

  return (
    <div
      className="section"
      style={{
        marginBottom: 16,
        border: "1px solid #ddd",
        padding: 12,
        background: "white",
      }}
    >
      <div>
        <strong>Priority {brief.priority}</strong>{" "}
        <span style={{ color: statusColor, fontWeight: 600 }}>
          [{brief.status}]
        </span>{" "}
        <span className="muted">
          · fixType={brief.fixType} · id={brief.id.slice(0, 8)}… ·{" "}
          {existingAssetCount} asset{existingAssetCount === 1 ? "" : "s"} stored
        </span>
      </div>
      <div style={{ marginTop: 4 }}>
        <strong>Lost prompt:</strong> {brief.lostPrompt}
      </div>
      <div style={{ marginTop: 4 }}>
        <strong>Recommended fix:</strong> {brief.recommendedFix}
      </div>
      <div style={{ marginTop: 4 }} className="muted">
        <strong>Assets planned:</strong>{" "}
        {brief.assetsToGenerate.length === 0
          ? "—"
          : brief.assetsToGenerate.join(", ")}
      </div>

      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ASSET_BUTTONS.map((b) => (
          <button
            key={b.type}
            type="button"
            onClick={() => onGenerate(b.type)}
            disabled={!canGenerate || busyType !== null}
          >
            {busyType === b.type ? "Generating…" : b.label}
          </button>
        ))}
      </div>

      {!canGenerate && (
        <p className="error" style={{ marginTop: 8, fontSize: 12 }}>
          Evidence Bank must be prepared and usable before generating assets.
        </p>
      )}
      {error && (
        <p className="error" style={{ marginTop: 8, fontSize: 12 }}>
          {error}
        </p>
      )}
      {flash && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: "#f0f6ff",
            border: "1px solid #b6d4fe",
            fontSize: 12,
          }}
        >
          Generated <code>{flash.assetType}</code> · title:{" "}
          <strong>{flash.title}</strong> · placeholders: {flash.placeholders} ·
          claimsUsed: {flash.claimsUsed} · qaStatus:{" "}
          <strong>{flash.qaStatus}</strong>{" "}
          <span className="muted">
            ({flash.usedMock ? "mock" : "live LLM"})
          </span>
        </div>
      )}
    </div>
  );
}
