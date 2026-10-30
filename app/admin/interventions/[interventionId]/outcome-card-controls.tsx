"use client";

import { useState } from "react";
import { FileCheck2, Mail, RefreshCw, ShieldX } from "lucide-react";

import { cn } from "@/lib/utils";
import { ui } from "../../ui-classes";

/**
 * Generate and send controls for one intervention's Outcome Card.
 *
 * Send carries the artifact id and revision the founder is looking at. The
 * route refuses if either changed, so a card regenerated in another tab is
 * never sent on the strength of a review of its predecessor.
 */
export function OutcomeCardControls({
  interventionId,
  canGenerate,
  generateBlockedReason,
  card,
  actionsEnabled,
  attemptsRecorded,
}: {
  interventionId: string;
  canGenerate: boolean;
  generateBlockedReason: string | null;
  card: {
    artifactId: string;
    revision: string;
    integrityStatus: string;
    delivered: boolean;
  } | null;
  actionsEnabled: boolean;
  attemptsRecorded?: number;
}) {
  const [busy, setBusy] = useState<"generate" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const off = !actionsEnabled;
  const base = `/api/internal/interventions/${interventionId}/outcome-card`;

  async function call(kind: "generate" | "send", path: string, body: unknown) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        setError(payload?.message || payload?.error || `Request failed (${res.status}).`);
        setBusy(null);
        return;
      }
      window.location.reload();
    } catch {
      setError("Request failed. Check your connection and try again.");
      setBusy(null);
    }
  }

  const blocked = card?.integrityStatus === "blocked";
  const needsReview = card?.integrityStatus === "needs_review";
  const sendable = card !== null && !card.delivered && !blocked;

  return (
    <div className="flex flex-col gap-3">
      {card && !card.delivered ? (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-foreground">
          Outcome Card ready for review{typeof attemptsRecorded === "number" ? ` · ${attemptsRecorded} attempts recorded` : ""}.
        </p>
      ) : null}
      {!card?.delivered ? (
        <>
          <button
            type="button"
            className={cn(card ? ui.btnOutline : ui.btnPrimary, "w-full")}
            disabled={off || !canGenerate || busy !== null}
            onClick={() => call("generate", base, {})}
          >
            {card ? <RefreshCw size={16} /> : <FileCheck2 size={16} />}
            {busy === "generate" ? "Building…" : card ? "Rebuild card" : "Build Outcome Card"}
          </button>
          {!canGenerate && generateBlockedReason ? (
            <p className="text-xs text-muted-foreground">{generateBlockedReason}</p>
          ) : null}
          {card ? (
            <p className="text-xs text-muted-foreground">
              Rebuilding replaces this undelivered card. Building never sends anything.
            </p>
          ) : null}
        </>
      ) : null}

      {blocked ? (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <ShieldX size={14} className="mt-0.5 shrink-0" />
          Blocked cards are never delivered. Resolve the flagged reasons and rebuild.
        </p>
      ) : null}

      {sendable ? (
        <>
          {needsReview ? (
            <label className="flex items-start gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={off || busy !== null}
              />
              I have read this card and each flagged reason, and it is accurate to send as it is.
            </label>
          ) : null}
          <button
            type="button"
            className={cn(ui.btnPrimary, "w-full")}
            disabled={off || busy !== null || (needsReview && !acknowledged)}
            onClick={() => {
              if (!window.confirm("Email this exact card to the customer? This cannot be undone.")) return;
              void call("send", `${base}/send`, {
                expectedArtifactId: card.artifactId,
                expectedRevision: card.revision,
                acknowledgeReview: needsReview ? acknowledged : false,
              });
            }}
          >
            <Mail size={16} /> {busy === "send" ? "Sending…" : "Send to customer"}
          </button>
        </>
      ) : null}

      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
