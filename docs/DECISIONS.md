# Zypact Canonical Decisions

- **Status:** Canonical decision register
- **Owner:** Founder/CEO, with methodology and technical review where required
- **Last updated:** 2026-08-19

This register records the decisions that govern the documentation reset. A later decision may supersede an earlier one only when it is added here with a date, rationale, and affected documents.

## Decision format

Each entry records:

- **Status:** approved, provisional, superseded, or requires research;
- **Decision:** the rule now in force;
- **Reason:** why it was chosen;
- **Effect:** documents, product behavior, or commercial language affected;
- **Revisit trigger:** evidence that requires a new decision.

## D-001 — External measurement cannot use a fixed three-run default

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Three provider runs may be used for an engineering smoke test or explicitly labeled demonstration, but not as a stable external client measurement or visibility percentage.
- **Reason:** A private same-question live test produced absent, listed, and primary observations across three runs, demonstrating that the sample was unstable. The confidential fixture remains outside source control.
- **Effect:** Remove fixed three-run client scoring, `won/partial/lost` aggregation, and three-run measurement claims from active product, sales, report, and engineering documentation.
- **Revisit trigger:** None for the prohibition. A future methodology may define bounded sampling procedures, but it cannot relabel three observations as a stable market measurement without new evidence.

## D-002 — Sampling is a protocol parameter, not a magic number

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Planned baseline and retest runs are versioned protocol parameters. The methodology must consider baseline rate, variance, minimum useful change, uncertainty, budget, and the unit of analysis.
- **Reason:** Replacing three runs with another universal number would repeat the same methodological error.
- **Effect:** Engineering must support configurable sampling without silently falling back to three.
- **Revisit trigger:** Validated pilot data may support protocol templates by category or use case.

## D-003 — Every protocol has technical hard caps and spend controls

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Every project/protocol must be bounded by operator-configured run, spend, time-window, rate, and concurrency limits. Each paid attempt is admitted and reserved before the provider call.
- **Reason:** Configurable scientific sampling cannot create unbounded technical or financial risk.
- **Effect:** V1 scope and engineering acceptance tests include boundary rejection, reservation ordering, retry idempotency, and spend reconciliation.
- **Revisit trigger:** Pilot operating data may change production limit values without changing the invariant.

## D-004 — Perplexity Sonar is the initial directional V1 surface

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** V1 uses Perplexity Sonar because the live path currently exists and is auditable and economical. Its results are labeled as directional observations of that recorded surface and configuration.
- **Reason:** API output from other providers may not represent their public consumer or tenant-specific buying experience. Adding provider breadth before validity would increase scope without improving truth.
- **Effect:** No V1 report may present Perplexity results as ChatGPT, Gemini, Copilot, or “all AI.”
- **Revisit trigger:** A second surface is added only after its access method, public relevance, provenance, cost, and comparability are documented.

## D-005 — V1 is a diagnostic plus registered retest

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** The current V1 offer is **Evidence-Backed Shortlist Diagnostic + Registered Retest**.
- **Reason:** “AI Buyer Journey Intelligence” is too broad for the current product. “Verified lift experiment” promises more than the method has yet demonstrated.
- **Effect:** V1 centers on approved buyer questions, recorded protocol, baseline evidence, one intervention hypothesis, an observation window, retest, and Outcome Card.
- **Revisit trigger:** Replicated feasibility and customer evidence may justify a stronger product-mechanism name.

## D-006 — No causal or revenue guarantee

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Zypact reports observed changes under recorded conditions. It does not claim that an intervention caused a change or that AI exclusion caused a lost sale unless a future design and evidence justify a narrowly stated claim.
- **Reason:** Before/after movement, stable controls, citations, and referral data can still be confounded.
- **Effect:** Every Outcome Card includes a non-removable footer: “This Outcome Card documents an observed change under the recorded conditions. It does not establish that the intervention caused the change.”
- **Revisit trigger:** No sales or UI toggle can override this. A future causal methodology requires independent statistical and legal review plus a new decision.

## D-007 — Causality is not an outcome enum

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Outcome status is limited to `increase_observed`, `decrease_observed`, `no_clear_change`, or `inconclusive`. `causality_not_established` is not a selectable result.
- **Reason:** Making causal status selectable would imply that other routine cases establish causality.
- **Effect:** The renderer supplies the standard methodology footer on every Outcome Card.
- **Revisit trigger:** Only a formally approved new methodology can change the footer policy.

## D-008 — Automatic delivery is gated; founder review is exceptional

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Reports with all required integrity checks pass as `integrity_passed` and may be delivered automatically. Exceptions become `needs_review`; unsafe artifacts become `blocked`.
- **Reason:** Mandatory founder delivery prevents automation, while ungated delivery risks credibility.
- **Effect:** Founder/admin review is an exception workflow, not the universal V1 delivery path.
- **Revisit trigger:** Integrity-gate performance and false-pass/false-block evidence from pilots.

## D-009 — Prompt-scoped evidence governs prompt-scoped claims

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Competitors, gaps, claims, sources, and recommendations attached to a buyer question must derive from runs for that exact approved question/version and protocol.
- **Reason:** Cross-prompt aggregation previously produced misleading competitor and Gap Map statements.
- **Effect:** Cross-question or category totals must be labeled as aggregates and cannot be substituted into a prompt-level explanation.
- **Revisit trigger:** None; this is an evidence-integrity invariant.

## D-010 — Category benchmark replaces the fragile free company score

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** The scalable free acquisition asset is a one-question category benchmark with a documented sample, surface, dates, uncertainty, and raw-evidence trail—not a three-run per-company visibility score.
- **Reason:** The benchmark amortizes one credible measurement across prospects in the same category without turning a tiny sample into a company diagnosis.
- **Effect:** Until a benchmark is ready, outreach may book calls but does not attach legacy reports.
- **Revisit trigger:** Lead quality, benchmark cost, conversion, and methodology performance.

## D-011 — Internal feasibility is not generalization

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** An internal Zypact test can establish operational feasibility only. Any broader method claim requires replication in at least two pilot contexts and must still state its limits.
- **Reason:** Multiple runs on one site do not create multiple independent intervention contexts.
- **Effect:** The feasibility plan includes internal testing plus external replication gates.
- **Revisit trigger:** Completed replicated outcomes and methodological review.

## D-012 — One canonical documentation package precedes code commitments

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** All engineering candidates receive the same merged canonical package before submitting or confirming estimates. No full-V1 contract is approved against superseded documents.
- **Reason:** Previous candidates estimated against conflicting definitions of V1, sampling, delivery, and retest.
- **Effect:** Documentation reset precedes code milestones. Contractor prices stay in contracts, not canonical product documents.
- **Revisit trigger:** None; future scope changes must follow the same change-control principle.

## D-013 — Future roadmap is non-binding

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** Future roadmap phases do not authorize work or override current methodology, scope, engineering, or status documents.
- **Reason:** Future direction must not create accidental contractor scope.
- **Effect:** Only the active canonical package and an accepted milestone agreement authorize engineering work.
- **Revisit trigger:** The authority index may be revised when company governance changes.

## D-014 — Canonical observation vocabulary replaces won, partial, lost; mixed results are never collapsed

- **Date:** 2026-08-19
- **Status:** Approved
- **Approval date:** 2026-08-19
- **Decision:** Run-level results use `not_observed_in_run`, `listed_in_run`, `primary_in_run`, `ambiguous_in_run`, and `analysis_failed` in place of `won`/`partial`/`lost`/`not_relevant`. The former `negative` position becomes `listed_in_run` combined with a separate `negative_claim_detected` flag. `not_relevant` becomes a separate context field, not a position. `analysis_failed` is a status distinct from `run_position`, excluded from the observed/not-observed denominator. Question-level results use `observed_consistently_in_sample`, `not_observed_consistently_in_sample`, `mixed_in_sample`, and `insufficient_evidence`; `mixed_in_sample` may never be converted to `won`, `partial`, or `lost`. `insufficient_evidence` is mandatory when completed runs equal zero, and any threshold above that floor is a versioned protocol parameter, not an engineering constant. `canonical_entities` and `entity_aliases` are scoped per project, never shared across tenants. Every canonical observation carries a mandatory, non-null `dataset_id` and `dataset_source_type` (`snapshot_request`, `manual_scan`, or `legacy_unresolved`); `snapshot_request_id` remains nullable on the existing `ProbeRun`/`ProbeResult` structures for compatibility. Legacy compatibility is provided by a strictly additive adapter that modifies exactly one existing report-generation file; no other existing consumer is changed. A golden fixture must confirm that the 15 already-stored HockeyStack runs remain bit-identical after backfill.
- **Reason:** The current per-prompt aggregate verdict is computed by a majority-threshold heuristic that forces a single stable label from what may be an unstable, mixed sample — the same methodological failure D-001 already corrected for the fixed three-run default. `METHODOLOGY.md` §9 and §10 already prescribe the correct vocabulary; it was not yet implemented, and the client-facing aggregate report does not yet honor it.
- **Effect:** `METHODOLOGY.md` (version 1.0 to 1.1). Future implementation work would affect `lib/schemas/probe-analysis.schema.ts`, `lib/db/types.ts`, `lib/db/memory-adapter.ts`, `lib/db/supabase-adapter.ts`, `lib/probe-results/report-selection.ts` (additive only), `lib/export/build-mvp-report.ts` (the only modified legacy consumer), and `scripts/mvp-scan.ts`, plus a future additive migration. No code, migration, or consumer file is changed by this decision entry itself.
- **Revisit trigger:** Pilot data on the real frequency of `mixed_in_sample` and `insufficient_evidence`; completion of the M3 consumer migration, which retires the temporary legacy-column clause of this decision.

## D-015 — Append-only backfill write path for probe_results via a scoped SECURITY DEFINER RPC

- **Date:** 2026-08-19
- **Status:** Approved
- **Approval date:** 2026-08-19
- **Decision:** Backfilling `probe_results.dataset_id`, `dataset_source_type`, `run_position`, `negative_claim_detected`, and `observation_schema_version` onto existing rows is performed exclusively through a single `SECURITY DEFINER` RPC, never through a `GRANT UPDATE` to `service_role` on `probe_results`. The RPC locks the target `probe_results` row `FOR UPDATE`, rereads its five target columns under that lock, locks and validates the referenced `dataset_batches` row (must exist, with matching `project_id` and `dataset_source_type`, else raises `errcode 22023`), and then applies exactly one of three mutually exclusive outcomes: if all five columns already match the requested values (compared with `IS NOT DISTINCT FROM`), it returns `ALREADY_APPLIED` without writing; if all five columns are `NULL`, it writes all five columns in one `UPDATE` guarded by a `WHERE` clause repeating the all-`NULL` precondition, and returns `APPLIED`; in every other case — including a `NULL` `dataset_id` alongside another already-populated or differing column — it returns `CONFLICT` without writing, and no preexisting differing value is ever overwritten. A target row that does not exist for the given project returns `NOT_FOUND`. The function always returns exactly one row with an explicit status column (`APPLIED`, `ALREADY_APPLIED`, `NOT_FOUND`, or `CONFLICT`), never an empty set, so `NOT_FOUND` and `CONFLICT` remain distinguishable. The function is pinned with `set search_path = public, pg_temp`, is revoked from `PUBLIC`/`anon`/`authenticated`, and grants `EXECUTE` to `service_role` only; `service_role` never receives `UPDATE`/`DELETE`/`TRUNCATE` on `probe_results` itself, so the append-only invariant from migration `0036` remains intact at the table-privilege level. No `SET` clause and no function parameter can reach `verdict`, `product_verdict`, `client_position`, `raw_response`/`raw_response_body`, any M1 evidence hash, `project_id`, or `snapshot_request_id` — those columns stay structurally unreachable through this RPC.
- **Reason:** Migration `0036` revoked `UPDATE`/`DELETE`/`TRUNCATE` on `probe_results` from `service_role` as a deliberate evidence-append-only invariant. The M2 backfill (D-014) needs to write five new columns onto already-existing rows, which a blanket `GRANT UPDATE` would satisfy but would also reopen general write access to a table whose append-only property is central to the M1 evidence contract. A narrowly scoped RPC with an explicit, race-safe status contract satisfies the backfill need without weakening that invariant, and reuses the `SECURITY DEFINER` RPC pattern already established for the snapshot worker (migration `0031`).
- **Effect:** A future, separately created migration (numbered after `0038`) adds this RPC and its `REVOKE`/`GRANT` statements only — no table, column, or constraint change, no `NOT NULL`, no data written by the migration itself. The M2 tranche-2 backfill script (not yet created) calls this RPC exclusively for `probe_results` writes; `probe_runs`, which was never append-only restricted, may continue to use ordinary `UPDATE`. No file is changed by this decision entry itself.
- **Revisit trigger:** None for the RPC-only mechanism itself. A future decision to grant `service_role` broader `UPDATE` privilege on `probe_results`, or to change the append-only invariant established by migration `0036`, requires its own separate decision entry.
