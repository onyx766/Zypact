"use client";

import { useState } from "react";

import {
  MAX_COMPETITORS,
  MIN_COMPETITORS,
  competitorErrorMessage,
  competitorsToText,
  normalizeCompetitorInput,
  parseCompetitorsInput,
  type CompetitorValidationError,
} from "@/lib/snapshot-requests/competitors";

/**
 * Approve a snapshot request, supplying the competitor frame in the same
 * action.
 *
 * There is deliberately no separate Save: a saved-then-approved list opens a
 * window where the queued request carries something the founder did not
 * intend, and a queued request is immediately claimable. Approval sends the
 * final list, and the RPC stores it and queues in one statement.
 *
 * Every check here is feedback only. The RPC re-normalizes and re-validates,
 * and it is what actually decides.
 */
export function ApproveButton({
  requestId,
  competitors,
  scannedCompany,
  scannedDomain,
}: {
  requestId: string;
  /** Stored frame, prefilled for editing. */
  competitors: string[];
  /**
   * Scanned identity, required so the self-competitor check can never be
   * silently skipped at a call site. The RPC always applies this rule; a
   * caller that could omit these would show "valid" for input the RPC
   * rejects.
   */
  scannedCompany: string | null;
  scannedDomain: string | null;
}) {
  const [text, setText] = useState(
    competitorsToText(competitors)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] =
    useState<string | null>(null);

  const parsed = parseCompetitorsInput(
    text,
    scannedCompany,
    scannedDomain
  );

  const count =
    normalizeCompetitorInput(text).length;

  async function approve() {
    if (!parsed.ok) {
      setError(
        competitorErrorMessage(parsed.error)
      );
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/internal/snapshot-requests/${requestId}/approve`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            competitors: text,
          }),
        }
      );

      const payload = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        const code = payload?.error as
          | CompetitorValidationError
          | undefined;

        setError(
          code
            ? competitorErrorMessage(code) ||
              code
            : "Approval failed."
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
    <div style={{ maxWidth: 420 }}>
      <label
        htmlFor="snapshot-competitors"
        style={{
          display: "block",
          marginBottom: 6,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Competitors
      </label>

      <p
        style={{
          margin: "0 0 6px",
          fontSize: 12,
          color: "#555",
        }}
      >
        Add {MIN_COMPETITORS}–{MAX_COMPETITORS}{" "}
        competitors. One per line. Company names
        or domains. {count} entered.
      </p>

      <textarea
        id="snapshot-competitors"
        name="competitors"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        rows={6}
        disabled={busy}
        style={{
          width: "100%",
          marginBottom: 10,
          padding: 8,
          border: "1px solid #ccc",
          borderRadius: 8,
          fontFamily: "inherit",
          fontSize: 13,
        }}
      />

      <button
        type="button"
        onClick={approve}
        disabled={busy || !parsed.ok}
        style={{
          minHeight: 36,
          border: 0,
          borderRadius: 999,
          padding: "0 14px",
          background:
            busy || !parsed.ok ? "#888" : "#111",
          color: "#fff",
          cursor: busy
            ? "wait"
            : parsed.ok
              ? "pointer"
              : "not-allowed",
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
