"use client";

import {
  useRouter,
} from "next/navigation";
import {
  useState,
} from "react";

export function SendReportButton({
  requestId,
  recipientEmail,
  alreadyDelivered,
  expectedArtifactId,
  expectedRevision,
  deliveryClaimActive,
}: {
  requestId: string;
  recipientEmail: string;
  alreadyDelivered: boolean;
  /** From authoritative publication state — never recomputed client-side. */
  expectedArtifactId: string;
  expectedRevision: string;
  deliveryClaimActive: boolean;
}) {
  const router = useRouter();

  const [pending, setPending] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  async function sendReport() {
    // Delivered reports are terminal in this workflow, so there is no
    // "send it again" branch left to confirm.
    const confirmed = window.confirm(
      `Send the private report to ${recipientEmail}?`
    );

    if (!confirmed) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/send-report`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          // The exact artifact and revision the founder is looking at. The
          // route fences on these, so a concurrent replacement is refused
          // rather than silently emailed.
          body: JSON.stringify({
            expectedArtifactId,
            expectedRevision,
          }),
        }
      );

      const payload =
        (await response.json()) as {
          ok?: boolean;
          error?: string;
          message?: string;
        };

      if (!response.ok || !payload.ok) {
        // The server phrases each outcome deliberately — uncertain delivery
        // and unconfirmed finalization both tell the founder NOT to resend.
        throw new Error(
          payload.message ||
          payload.error ||
          "Report delivery failed."
        );
      }

      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Report delivery failed."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={sendReport}
        disabled={
          pending ||
          alreadyDelivered ||
          deliveryClaimActive
        }
        style={{
          minHeight: 38,
          border: "1px solid #111",
          borderRadius: 999,
          background: "#111",
          color: "#fff",
          padding: "0 14px",
          cursor:
            pending
              ? "wait"
              : "pointer",
          fontWeight: 600,
          opacity:
            pending ? 0.65 : 1,
        }}
      >
        {pending
          ? "Sending…"
          : alreadyDelivered
            ? "Report delivered"
            : "Send report"}
      </button>

      {error ? (
        <p
          style={{
            margin: "8px 0 0",
            color: "#b42318",
            fontSize: 12,
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
