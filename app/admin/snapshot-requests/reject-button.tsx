"use client";

import { useState } from "react";
import { CircleX } from "lucide-react";

import { cn } from "@/lib/utils";
import { ui } from "../ui-classes";

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
        type="button"
        onClick={reject}
        disabled={busy}
        className={cn(ui.btnDanger, busy && "cursor-wait")}
      >
        <CircleX size={16} strokeWidth={2.2} />
        {busy
          ? "Rejecting…"
          : "Reject"}
      </button>

      {error ? (
        <p
          role="alert"
          className="mt-2 max-w-[220px] text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
