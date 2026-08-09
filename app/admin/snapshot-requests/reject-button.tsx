"use client";

import { useState } from "react";

export function RejectButton({
  requestId,
}: {
  requestId: string;
}) {
  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  async function reject() {
    const confirmed = window.confirm(
      "Reject this snapshot request? No AI scan will run."
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/reject`,
        {
          method: "POST",
          headers: {
            accept:
              "application/json",
          },
        }
      );

      const payload = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        setError(
          payload?.error ||
            "Rejection failed."
        );

        return;
      }

      window.location.reload();
    } catch {
      setError("Rejection failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="founder-button founder-button-danger"
        type="button"
        onClick={reject}
        disabled={busy}
        style={{
          minHeight: 36,
          border:
            "1px solid #d0d0d0",
          borderRadius: 999,
          padding: "0 14px",
          background: "#fff",
          color: "#8b0000",
          cursor: busy
            ? "wait"
            : "pointer",
          fontWeight: 600,
        }}
      >
        {busy
          ? "Rejecting…"
          : "Reject"}
      </button>

      {error ? (
        <p
          role="alert"
          style={{
            margin: "8px 0 0",
            maxWidth: 220,
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
