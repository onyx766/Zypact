/**
 * How intervention state is shown in the founder console. A plain module so
 * server pages and client components share one definition.
 *
 * The stored status is one of exactly five values (0071). "Retest ready" and
 * "Observing" are NOT statuses — they are the retest_eligibility authority's
 * answer, rendered alongside the status, never stored or re-derived.
 */

import type { InterventionStatus } from "@/lib/interventions/types";
import type { EligibilityPresentation } from "@/lib/interventions/rpc-errors";

/** zpa pill tones available in admin.css; "neutral" is the untoned default. */
export type PillTone = "green" | "amber" | "blue" | "red" | "neutral";

export const STATUS_PRESENTATION: Record<InterventionStatus, { label: string; tone: PillTone; note: string }> = {
  proposed: { label: "Proposed", tone: "amber", note: "Awaiting your approval" },
  approved: { label: "Approved", tone: "green", note: "Claim frozen; not yet live" },
  implemented: { label: "Implemented", tone: "blue", note: "Live; window running" },
  rejected: { label: "Rejected", tone: "red", note: "Closed before approval" },
  abandoned: { label: "Abandoned", tone: "neutral", note: "Closed before measurement" },
};

export function statusPresentation(status: string) {
  return (
    STATUS_PRESENTATION[status as InterventionStatus] ?? {
      label: status,
      tone: "neutral" as PillTone,
      note: "",
    }
  );
}

/** Dot colour for the eligibility column, keyed by the authority's tone. */
export const ELIGIBILITY_DOT: Record<EligibilityPresentation["tone"], string> = {
  ready: "var(--zpa-green)",
  // A deviation is deliberately amber, never green: a window cut short must
  // not read as identical to one that ran its full course.
  deviation: "var(--zpa-amber)",
  waiting: "var(--zpa-blue)",
  neutral: "var(--zpa-dim)",
};

/** For statuses where the retest question does not arise, say why. */
export function nonImplementedEligibilityLabel(status: string): string {
  switch (status) {
    case "proposed":
    case "approved":
      return "Not started";
    default:
      return "Not applicable";
  }
}

export const ACTION_TYPE_LABELS: Record<string, string> = {
  content_published: "Content published",
  content_updated: "Content updated",
  page_created: "Page created",
  structured_data_added: "Structured data added",
  third_party_listing: "Third-party listing",
  documentation_updated: "Documentation updated",
  other: "Other",
};
