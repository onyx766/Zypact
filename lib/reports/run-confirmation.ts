/**
 * D-052 — the text the founder confirms before a Run spends money.
 *
 * Built from the protocol's own frozen plan and caps, never a constant: a
 * baseline approved under an older default keeps the plan it was approved
 * with. Kept outside the client component so it can be tested directly.
 */

export interface RunConfirmationPlan {
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  /** A lapsed lease: the press resumes rather than starts. */
  stale: boolean;
}

/**
 * D-052 — the Run confirmation, from the protocol's own plan and caps.
 * Measured on production evidence (D-036): a run takes about 20 seconds,
 * and a 5-run scan finished in 91-102 seconds.
 */
export function runConfirmationText(state: RunConfirmationPlan): string {
  const verb = state.stale
    ? "Resume the scan for this request now?"
    : "Run the scan for this request now?";
  const { plannedRuns, runCap, spendCapUsd } = state;
  if (plannedRuns === null || runCap === null || spendCapUsd === null || plannedRuns < 1) {
    return (
      verb +
      "\n\nOnly this request's measurement runs. Every run makes two real, paid provider " +
      "calls (one AI answer and one analysis), within the limits fixed when the request was approved."
    );
  }
  const minutes = Math.max(1, Math.round((plannedRuns * 20) / 60));
  return (
    verb +
    "\n\nOnly this request's measurement runs: " +
    plannedRuns + " planned run" + (plannedRuns === 1 ? "" : "s") +
    ", each making two real, paid provider calls (one AI answer and one analysis), so " +
    plannedRuns * 2 + " calls if nothing fails. Retries can raise that to at most " +
    runCap * 2 + " calls, and this measurement can never spend more than $" +
    spendCapUsd.toFixed(2) + ". It usually takes about " +
    minutes + " minute" + (minutes === 1 ? "" : "s") + "."
  );
}
