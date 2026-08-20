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

## D-016 — Golden-fixture preservation is bit-identical only for pre-existing columns; M1 columns stay NULL absent historical proof

- **Date:** 2026-08-19
- **Status:** Approved
- **Approval date:** 2026-08-19
- **Decision:** For any historical dataset used as a golden fixture under D-014 (HockeyStack or any other export later designated as such), the "bit-identical" preservation guarantee applies exactly to the columns that already existed on that data before any backfill: the legacy columns (`verdict`, `product_verdict`, `client_position`, `raw_response`) and any other column already populated at original capture time. Columns introduced by M1 (`raw_response_body`, `raw_response_sha256`, `raw_response_body_sha256`, `raw_probe_request_sha256`, `full_request_body_sha256`) and provider/retry metadata (`provider_http_status`, `provider_latency_ms`, `provider_request_id`, `provider_model`, `retry_count`) must remain `NULL` on any row for which no historical proof of the exact original provider response exists — never fabricated, never computed retroactively. No SHA-256 or other hash may be computed after the fact over content that was not itself captured with M1 fidelity, since doing so would misrepresent byte-for-byte fidelity that was never established.
- **Reason:** The export diagnosed during the M2 tranche-2 staging preflight (15 `probe_runs`/`probe_results`, legacy columns present, all M1 evidence/hash/provider-metadata columns absent) is confirmed pre-M1. Retroactively computing a hash over this data would fabricate the appearance of M1-grade evidence fidelity that was never actually captured — a direct violation of the CLAUDE.md invariant that incomplete or inconsistent evidence fails closed into an honest state, and a necessary clarification of D-014's HockeyStack-fixture clause, which implicitly assumed "preserve bit-identically" meant preserving what already existed, not synthesizing new evidence-grade fields.
- **Effect:** Clarifies/amends D-014's golden-fixture clause without altering its substance; establishes a general rule for any pre-M1 historical dataset encountered during M2 backfill design or execution. No file, code, or migration is changed by this decision entry itself. Any future golden-fixture test (including the limitation already documented in `scripts/test-m2-tranche2-writers.ts`) must explicitly assert this NULL-preservation once a concrete pre-M1 dataset is designated as the fixture.
- **Revisit trigger:** None, unless a HockeyStack dataset genuinely captured under M1 (with its evidence columns actually populated) is later located — D-014's original bit-identical hash-preservation clause would then apply to that dataset as originally written, since it would carry real M1 fidelity.

## D-017 — Append-only entity observation ledger, deterministic v1 resolver, and brand-self exclusion

- **Date:** 2026-08-20
- **Status:** Approved
- **Approval date:** 2026-08-20
- **Decision:** Entity resolution and brand-self exclusion are implemented via four tables, two active-head read views, and exactly two `SECURITY DEFINER` RPCs, with no other write path. Schema: `entity_observations` (append-only) records one row per individual raw mention extracted from a `probe_result` — `probe_result_id`/`probe_run_id`/`generated_prompt_id`/`project_id`/`dataset_id`/`dataset_source_type` all FK-locked, directly and via composite FKs to `probe_results` and to its own `resolution_pass_id`, so every one of those fields is transitively pinned to the same tenant, dataset, and pass by Postgres itself; `canonical_entity_id`/`entity_type` are nullable only for `status in ('ambiguous','unresolved')`, and a single CHECK makes both directions of the brand-self rule explicit in one place — `status='excluded_brand_self'` requires `entity_type='client'`, and `status='resolved'` permits only `entity_type in ('competitor','platform')`, structurally forbidding `resolved`+`client` from ever coexisting; `mention_ordinal`/`observation_generation`/`resolver_version` carry positivity CHECKs; the identity/idempotency key is `UNIQUE(resolution_pass_id, mention_ordinal, observation_generation)`. `entity_resolution_passes` (control-plane, not append-only) tracks one resolution attempt per `(probe_result_id, resolver_version)`: `status` is `in_progress`/`completed`/`abandoned`, partial unique indexes guarantee at most one `completed` and at most one `in_progress` pass per that pair, `expected_mention_count` is fixed at pass start and a pass with `expected_mention_count=0` completes immediately (never waits on an observation that will never arrive), `last_activity_at` (not `started_at`) drives staleness detection for resume-vs-abandon decisions so a legitimately slow but still-active pass is never falsely abandoned, and `dataset_source_type` is carried and FK-locked here too, back to `dataset_batches`. `entity_brand_snapshots` (append-only) freezes the exact brand-term inputs (`company_name`, `domain`, mirror-profile aliases, and their normalized forms) used for a given `(project_id, dataset_id, resolver_version)`, created once and never recomputed, so a historical dataset's resolutions remain reproducible even after the project's live profile later changes. `entity_aliases` gains `alias_generation` (default 1, safe on existing rows since Postgres back-fills a constant default without a rewrite) and its uniqueness key changes from `(project_id, entity_type, normalized_text)` to `(project_id, normalized_text, alias_generation)` — dropping `entity_type` from the key is what makes client/competitor exclusivity a structural property rather than a convention, since only one `entity_type` can ever be active for a given normalized text at a time. `canonical_entities` gains a partial unique index enforcing exactly one `entity_type='client'` row per project. Both migration preconditions this schema change depends on are mandatory, executed before the migration applies, and fail closed with no automatic correction if violated: zero pre-existing `entity_aliases` rows may share `(project_id, normalized_text)` under different `entity_type` values (the old key permitted this; the new one cannot), and zero projects may already have more than one `canonical_entities` row with `entity_type='client'`. Active-head views — `entity_aliases_active` (max `alias_generation` per `(project_id, normalized_text)`) and `entity_observations_active` (max `observation_generation` per `(probe_result_id, mention_ordinal)`, scoped to only the highest-`resolver_version` pass that has actually reached `status='completed'`, so an in-progress or abandoned pass can never contribute a partial result) — are the only sanctioned read path for "what does this currently mean"; no consumer queries the base tables directly for that purpose. Normalization is deterministic v1, no LLM call: Unicode NFKC, NFD diacritic stripping, Unicode case-fold, one trailing legal-suffix strip from a fixed list (`inc`, `inc.`, `incorporated`, `llc`, `l.l.c.`, `ltd`, `ltd.`, `limited`, `corp`, `corp.`, `corporation`, `co`, `co.`, `company`, `plc`, `gmbh`, `ag`, `sa`, `s.a.`, `sas`, `sarl`, `s.a.r.l.`, `bv`, `b.v.`, `nv`, `n.v.`, `pty`, `pty ltd`, `oy`, `ab`, `spa`, `s.p.a.`), Unicode punctuation/symbol removal, whitespace collapse, and a narrow domain-shaped branch (strip only a leading `www.`); brand-self matching is exact-string comparison against this same normalizer's output for the project's company name, domain, domain stem, and Mirror Profile aliases — no separate or fuzzy matching logic. `resolve_and_record_entity_observation`'s alias-side comparison against the active head resolves to exactly: no existing head → insert generation 1, `APPLIED`; head identical (regardless of `resolver_version`) → no write, `ALREADY_APPLIED`; higher `resolver_version` with a differing mapping → insert `head_generation+1`, `SUPERSEDED_PRIOR`; same `resolver_version` with a differing mapping → no write, `CONFLICT`; head is `client` and the proposal is `competitor`/`platform` → the function raises unconditionally, at any `resolver_version`, never returning a row — a `client` identity can never be demoted through this ordinary path. `observation_outcome` is `APPLIED`/`ALREADY_APPLIED`/`CONFLICT` only (three values — a correction is always a new pass at a higher `resolver_version`, producing a fresh generation-1 `APPLIED` row, never a same-pass supersession, so `SUPERSEDED_PRIOR` never fires for observations); `alias_outcome` is `APPLIED`/`ALREADY_APPLIED`/`SUPERSEDED_PRIOR`/`CONFLICT`/`NOT_APPLICABLE` (the last exactly when `status in ('ambiguous','unresolved')`). Both RPCs derive `project_id`/`probe_result_id`/`probe_run_id`/`generated_prompt_id`/`dataset_id`/`dataset_source_type`/`resolver_version` internally from the locked pass row and, via its `probe_result_id`, from `probe_results` — none of these are accepted as independently-supplied, independently-verified parameters, removing an entire class of mismatch preconditions. Both RPCs are `SECURITY DEFINER`, `set search_path = public, pg_temp`, owned by the same role that owns every other object these migrations create (in this project, the role that runs `supabase db push` — never `service_role`), revoked from `PUBLIC`/`anon`/`authenticated`, with `EXECUTE` granted to `service_role` only. `service_role` receives **no** `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` on any of the four tables or two views — only `SELECT` — so the RPCs are structurally the only writers, not merely the intended ones; every relevant object starts with an explicit `REVOKE ALL` from `PUBLIC`/`anon`/`authenticated`/`service_role` before the narrow `SELECT`/`EXECUTE` grants are applied. This includes revoking the `INSERT` grant migration `0038` gave `service_role` on `entity_aliases`; `canonical_entities` keeps its existing direct-`INSERT` grant from `0038` unchanged, because as a bare identity row with no `raw_text`/`normalized_text`/status column, a direct insert into it cannot attach a mention, resolve an alias, or bypass brand-self exclusion or the one-client-per-project constraint — those guarantees live in `entity_aliases`/`entity_observations`, which are RPC-only, and in the constraint itself, which applies regardless of write path.
- **Reason:** `METHODOLOGY.md` §11 and Report Integrity Gates 6–7 (§16) already require brand-self exclusion and complete-or-visibly-uncertain entity normalization as delivery preconditions, but neither is enforceable today: the read-only audit that preceded this decision found no table linking a resolved or unresolved mention back to the `probe_result`/`probe_run`/question that produced it, no idempotency key, no ambiguity/non-resolution state, no correction mechanism compatible with the existing append-only privilege model, and no mechanism preventing the same normalized text from being registered as both the client's own brand and a competitor. Ten rounds of read-only review surfaced and closed, in turn: an overstated claim that a single `UNIQUE` constraint alone could guarantee client/competitor exclusivity; a real risk of `entity_observations_active` mixing rows from a crashed, partial reprocessing pass; brand-term reproducibility breaking once a project's live profile changes; a genuine security contradiction where granting `service_role` direct table privileges would have made the RPCs' business logic bypassable despite being `SECURITY DEFINER`; and two silent migration-breaking preconditions (the `entity_aliases` cross-type collision, the `canonical_entities` multi-client case) that a naïve `ALTER TABLE` would not have caught before failing or, worse, succeeding on the wrong data.
- **Effect:** This decision entry authorizes design only. Separate, later implementation steps — not authorized here and not performed by this entry — are: the literal PL/pgSQL bodies of `start_or_resume_entity_resolution_pass` and `resolve_and_record_entity_observation` (this entry fixes their contract — parameters, preconditions, locking order, concurrency resolution, return semantics — exhaustively; the executable body text is written and tested against a real database separately, exactly as D-015's RPC was); the future migration itself (provisionally numbered after `0040`) containing every `CREATE TABLE`/`ALTER TABLE`/`CREATE VIEW`/`GRANT`/`REVOKE` statement this decision specifies, gated on both migration preconditions above returning zero rows; a historical reprocessing script (parallel to `scripts/backfill-probe-result-dataset-identity.ts`) that resolves entities for `probe_results` that already existed before this tranche, using only already-stored evidence, never a new LLM call; and any future manual-override mechanism for correcting a resolution outside the ordinary deterministic-resolver path, which is explicitly out of scope for both the resolver and this decision and requires its own separate decision entry. Implementation would also retire `createEntityAlias` (`lib/db/types.ts`, `lib/db/supabase-adapter.ts`, `lib/db/memory-adapter.ts`) once `entity_aliases` becomes RPC-only-written — an audit performed before this decision's approval confirmed its only caller anywhere in the repository is `scripts/test-m2-schema-contract.ts` (the method's own code comment already reads "No caller populates these yet"), so no production code path is affected; that test's direct calls must be rewritten to exercise the same constraint coverage through the new RPC surface, with a regression test asserting the direct-insert call site is gone. No table, column, constraint, RPC, migration, or code file is created or changed by this decision entry itself.
- **Revisit trigger:** Real ambiguous/unresolved rates from pilot use may justify a v2 normalizer or a resolver_version bump to the legal-suffix list; any future introduction of a manual-override correction mechanism, or of LLM-assisted resolution, requires its own separate decision, since this draft explicitly excludes both from v1; the `p_stale_after` default (15 minutes) is an operational parameter, adjustable without a new decision if pilot data shows it is miscalibrated.

## D-018 — Amendment to D-017: RPC resolves the canonical entity internally, enforces brand-self exclusion unconditionally for competitor/platform proposals, and reports pass completion in its return row

- **Date:** 2026-08-20
- **Status:** Approved
- **Approval date:** 2026-08-20
- **Decision:** Amends D-017's `resolve_and_record_entity_observation` contract in three ways, all discovered during pre-implementation audit, none new capability. First: the parameter `p_proposed_canonical_id` is removed — a caller cannot supply an id for an entity that does not yet exist. The RPC resolves the canonical entity internally: for `p_proposed_entity_type = 'client'`, via find-or-create against `canonical_entities(project_id, entity_type='client')`, guarded by `canonical_entities_one_client_per_project`, race-safe via the identical insert-on-conflict-then-reselect pattern already specified for `entity_brand_snapshots`; for `'competitor'`/`'platform'`, by reusing the active alias head's `canonical_entity_id` for `(project_id, normalized_text)` if one exists, or creating a fresh `canonical_entities` row of the proposed type otherwise. Second: before honoring any `'competitor'`/`'platform'` proposal, the RPC unconditionally checks the proposal's `normalized_text` against the current pass's own `brand_snapshot_id`'s `normalized_brand_terms`, regardless of whether a pre-existing alias head exists for that text; a match overrides the proposal to `status = 'excluded_brand_self'`, `entity_type = 'client'`, linked to the project's client entity — closing the gap where a first-ever sighting of the client's own name inside an LLM's `competitorsMentioned` output, independent of `clientMentioned`, would otherwise have nothing to compare against. Third: the function's return row gains `pass_status text`, restricted to exactly `'in_progress'` or `'completed'` — never `'abandoned'`, never null. `'completed'` is returned only by the call that causes the pass's row count to reach `expected_mention_count`; `'in_progress'` is returned when it does not. A call referencing a pass that is already `'abandoned'` or already `'completed'` raises at the existing precondition ("pass must be `in_progress`") before any row is returned — a completed pass is rejected outright by that precondition, so `pass_status` can never be returned for a call made against one; it is reported only by the single call that performs the transition. All other aspects of D-017's contract — locking order, the remaining preconditions, the `observation_outcome`/`alias_outcome` vocabularies, the demote-block precondition protecting an already-established `client` head — are unchanged.
- **Reason:** D-017 as approved implicitly required a caller-supplied canonical entity id for a `resolved`/`excluded_brand_self` proposal, unsatisfiable for a genuinely new entity; its brand-self protection covered only an already-established alias head, leaving a first-sighting LLM-drift case uncovered; and it gave callers no RPC-native completion signal, which pre-implementation review showed is necessary — a mention-processing loop can finish with zero thrown exceptions while the pass never reaches `completed` (a miscounted `expected_mention_count`, a silently-skipped mention, or zero calls happening when they should not have), and only an explicit, verified read of pass status can safely gate whether a caller reports `entityResolutionError`.
- **Effect:** No file, migration, or code is created or changed by this entry itself. It corrects the contract that the still-unwritten migration `0042` and the still-unwritten pipeline wiring (`analyze-probe-response.ts`) must implement — nothing has been built against the prior, incomplete signature.
- **Revisit trigger:** None beyond D-017's own.
