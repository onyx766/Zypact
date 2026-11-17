/**
 * Customer wording for a run that ended without a readable answer.
 *
 * The stored termination reason is an internal code (for example
 * `http_error:RECEIPTED`). The evidence and the markdown projection, which
 * reviewers reconcile against the evidence, keep the code; the client view
 * shows these words instead. Since D-052 a run that failed at the provider is
 * routinely retried, so such rows appear in delivered reports.
 */
export function runEndLabel(status: string, terminationReason: string | null): string | null {
  if (status === "completed" || status === "reserved" || status === "in_progress") return null;
  if (status === "excluded") return "Excluded after review";
  if (status === "timed_out") return "No reply in time";
  if (status === "cancelled") return "Cancelled before it ran";
  const reason = (terminationReason ?? "").toLowerCase();
  if (reason.startsWith("empty_provider_answer")) return "The AI engine's answer was empty";
  if (reason.startsWith("http_error") || reason.startsWith("empty_answer") || reason.startsWith("provider_error")) {
    return "The AI engine returned an error";
  }
  return "This run did not complete";
}
