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
}: {
  requestId: string;
  recipientEmail: string;
  alreadyDelivered: boolean;
}) {
  const router = useRouter();

  const [pending, setPending] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  async function sendReport() {
    const confirmed = window.confirm(
      alreadyDelivered
        ? `This report was already delivered. Send it again to ${recipientEmail}?`
        : `Send the private report to ${recipientEmail}?`
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
          // Resending is explicit: the route refuses to send again
          // without this flag, so a stray click cannot re-email a client.
          body: JSON.stringify({
            resend: alreadyDelivered,
          }),
        }
      );

      const payload =
        (await response.json()) as {
          ok?: boolean;
          error?: string;
        };

      if (!response.ok || !payload.ok) {
        throw new Error(
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
        disabled={pending}
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
            ? "Resend report"
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
