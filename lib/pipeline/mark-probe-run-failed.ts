/**
 * M1 evidence contract, fourth-tranche correction.
 *
 * Marks a `probe_runs` row "failed". If that write itself fails, this
 * throws a compound error naming the run id, instead of silently
 * discarding the persistence failure (the previous behavior used
 * `.catch(() => undefined)`). A `probe_runs` row must never be left
 * silently stuck in "pending" because a status write failure was
 * swallowed.
 *
 * `causeMessage` describes the original failure that triggered marking
 * the run failed (a Perplexity error, an identity-leak integrity
 * failure, etc.). Only one error can propagate from this function, so
 * that message is folded into the compound error text when the status
 * write itself fails — otherwise the original failure is lost with no
 * trace of why the run was being marked failed in the first place.
 */
export async function failProbeRunOrThrow(
  db: { updateProbeRunStatus(id: string, status: "failed"): Promise<void> },
  probeRunId: string,
  causeMessage: string
): Promise<void> {
  try {
    await db.updateProbeRunStatus(probeRunId, "failed");
  } catch (statusErr) {
    throw new Error(
      `${causeMessage} — additionally, marking probe_runs ${probeRunId} as "failed" itself failed (${
        statusErr instanceof Error ? statusErr.message : String(statusErr)
      }); this run may be stuck in "pending".`,
      { cause: statusErr }
    );
  }
}
