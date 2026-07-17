"use client";

import { useState } from "react";

export function ApproveButton({
  requestId,
}: {
  requestId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] =
    useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/approve`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
          },
        }
      );

      const payload = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        setError(
          payload?.error ||
            "Approval failed."
        );
        return;
      }

      window.location.reload();
    } catch {
      setError("Approval failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={approve}
        disabled={busy}
        style={{
          minHeight: 36,
          border: 0,
          borderRadius: 999,
          padding: "0 14px",
          background: "#111",
          color: "#fff",
          cursor: busy
            ? "wait"
            : "pointer",
          fontWeight: 600,
        }}
      >
        {busy ? "Approving…" : "Approve"}
      </button>

      {error ? (
        <p
          role="alert"
          style={{
            margin: "8px 0 0",
            maxWidth: 180,
            color: "crimson",
            fontSize: 12,
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
