"use client";

import {
  useRouter,
} from "next/navigation";
import {
  useState,
} from "react";
import { CircleCheck, Send } from "lucide-react";

import { cn } from "@/lib/utils";
import { ui } from "../ui-classes";

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
    <div className="flex flex-col items-start gap-1.5 lg:items-end">
      <button
        type="button"
        onClick={sendReport}
        disabled={
          pending ||
          alreadyDelivered ||
          deliveryClaimActive
        }
        className={cn(
          ui.btnOutline,
          alreadyDelivered && "text-success",
          pending && "cursor-wait"
        )}
      >
        {alreadyDelivered ? (
          <CircleCheck size={16} strokeWidth={2.2} />
        ) : (
          <Send size={15} strokeWidth={2.2} />
        )}
        {pending
          ? "Sending…"
          : alreadyDelivered
            ? "Report delivered"
            : "Send report"}
      </button>

      {error ? (
        <p className="max-w-xs text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
