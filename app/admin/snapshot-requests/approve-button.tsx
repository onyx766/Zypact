"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";

import {
  MAX_COMPETITORS,
  MIN_COMPETITORS,
  competitorErrorMessage,
  competitorsToText,
  normalizeCompetitorInput,
  parseCompetitorsInput,
  type CompetitorValidationError,
} from "@/lib/snapshot-requests/competitors";
import { cn } from "@/lib/utils";
import { ui } from "../ui-classes";

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
 *
 * D-052 — for an audit the founder created, approval also records who wrote
 * the question, because the report shows that provenance to the customer.
 * A public-form question was written by the requester, so nothing is asked.
 */
export function ApproveButton({
  requestId,
  competitors,
  scannedCompany,
  scannedDomain,
  origin,
}: {
  requestId: string;
  /** Where the request came from (0081). */
  origin: "public_form" | "founder";
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
  const [provenance, setProvenance] = useState<
    "" | "customer_supplied" | "founder_supplied"
  >("");
  const needsProvenance = origin === "founder";

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

    if (needsProvenance && !provenance) {
      setError("Say who supplied this question before approving.");
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
            ...(needsProvenance ? { questionProvenance: provenance } : {}),
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
    <div className="w-full max-w-xl">
      <label
        htmlFor="snapshot-competitors"
        className="block text-sm font-semibold text-foreground"
      >
        Competitors
      </label>

      <p className="mt-1 text-xs text-muted-foreground">
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
        className={cn(ui.input, "mt-2 font-mono text-[13px] leading-6")}
      />

      {needsProvenance ? (
        <fieldset className="mt-4" disabled={busy}>
          <legend className="block text-sm font-semibold text-foreground">
            Who supplied this question?
          </legend>
          <p className="mt-1 text-xs text-muted-foreground">
            Required for an audit you created. The report shows this to the
            customer.
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="question-provenance"
              value="customer_supplied"
              checked={provenance === "customer_supplied"}
              onChange={() => {
                setProvenance("customer_supplied");
                setError(null);
              }}
            />
            The customer wrote it themselves
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="question-provenance"
              value="founder_supplied"
              checked={provenance === "founder_supplied"}
              onChange={() => {
                setProvenance("founder_supplied");
                setError(null);
              }}
            />
            Zypact recommended or drafted it, even if the customer then edited it
          </label>
        </fieldset>
      ) : null}

      <button
        type="button"
        onClick={approve}
        disabled={busy || !parsed.ok || (needsProvenance && !provenance)}
        className={cn(ui.btnPrimary, "mt-3", busy && "cursor-wait")}
      >
        <CircleCheck size={16} strokeWidth={2.2} />
        {busy ? "Approving…" : "Approve"}
      </button>

      {error ? (
        <p
          role="alert"
          className="mt-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
