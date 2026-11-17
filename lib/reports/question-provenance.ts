/**
 * Plain-language labels for a buyer question version's provenance.
 *
 * The stored value is a code from the `buyer_question_versions.provenance`
 * check (migration 0047). The report used to print that code to the reader
 * ("provenance customer_supplied"), which is a database value, not a
 * sentence. Every client view and the markdown projection take their label
 * from here, so they cannot disagree about what a provenance means.
 *
 * The meanings follow docs/BUYER_QUESTION_INTELLIGENCE.md: a question the
 * customer wrote is `customer_supplied`; one Zypact recommended or wrote is
 * `founder_supplied`. "Supplied", not "written": a recommended question the
 * customer then edited is still `founder_supplied`.
 */

export const QUESTION_PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  customer_supplied: "supplied by the requester",
  founder_supplied: "supplied by Zypact",
  crm_evidence: "taken from the requester's CRM records",
  model_assisted_reviewed: "drafted with AI assistance and reviewed by a person",
  public_benchmark: "a public category benchmark",
};

/**
 * The label for a stored provenance code. An unknown code is shown as words
 * rather than hidden, so a new value added to the database check is still
 * visible to the reader until it is given a label here.
 */
export function questionProvenanceLabel(code: string): string {
  return QUESTION_PROVENANCE_LABELS[code] ?? code.replace(/_/g, " ");
}
