"use client";

import { useState } from "react";
import { decideExportDownload } from "@/lib/export/export-download-decision";

interface Props {
  projectId: string;
}

interface BlockedState {
  integrityStatus: string;
  reasons: string[];
}

export function ExportDownloadButton({ projectId }: Props) {
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<BlockedState | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setBlocked(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/export`);
      if (!res.ok) {
        setError(`Export request failed (HTTP ${res.status}).`);
        return;
      }

      // M3 reliquat — never trust `ok:true`/HTTP 200 alone. A
      // blocked/needs_review response is also 200. The decision reads
      // only response headers, so the body is never parsed as a report
      // before it is confirmed safe to do so.
      const decision = decideExportDownload({
        contentType: res.headers.get("content-type"),
        integrityStatus: res.headers.get("x-zypact-integrity-status"),
        deliverable: res.headers.get("x-zypact-deliverable"),
      });

      if (!decision.shouldDownload) {
        let reasons: string[] = [];
        try {
          const body = await res.json();
          if (Array.isArray(body?.reasons)) reasons = body.reasons;
        } catch {
          // Body wasn't JSON (unexpected for this branch) — show the
          // status alone rather than guessing at a reason.
        }
        setBlocked({ integrityStatus: decision.integrityStatus, reasons });
        return;
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(contentDisposition);
      const filename = match?.[1] ?? `zypact-report-${projectId}.md`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        style={{
          display: "inline-block",
          padding: "8px 14px",
          background: "#111",
          color: "#fff",
          textDecoration: "none",
          borderRadius: 4,
          fontWeight: 600,
          border: "none",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Checking…" : "Download report (.md)"}
      </button>

      {blocked && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            border: "1px solid #d33",
            background: "#fff5f5",
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>
            Report not available — status: {blocked.integrityStatus}
          </p>
          <p style={{ margin: "4px 0 0" }}>
            This report is not ready for automatic delivery. No file was
            downloaded.
          </p>
          {blocked.reasons.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              {blocked.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="error" style={{ fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
