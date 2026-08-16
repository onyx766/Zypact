# Zypact Canonical Decisions

- **Status:** Canonical decision register
- **Owner:** Founder/CEO, with methodology and technical review where required
- **Last updated:** 2026-08-16

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

## D-011 — The Founder Institute demo uses the existing manual engine

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** The 2026-09-03 demo uses the real manual/terminal engine already demonstrated. Newly completed platform automation is a bonus, not a dependency.
- **Reason:** Engineering selection, revised estimates, contracting, and onboarding cannot credibly guarantee a complete trust layer before the demo.
- **Effect:** Demo preparation proceeds independently from engineer selection.
- **Revisit trigger:** None for the 2026-09-03 event.

## D-012 — An in-progress retest is a valid demo state

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** The demo may show: “Registered retest — baseline recorded, intervention implemented, observation window open, retest scheduled for [date].”
- **Reason:** A complete baseline, intervention, indexing/observation window, and retest cannot be forced into the remaining demo schedule without compromising integrity.
- **Effect:** A partial retest cannot be presented as a completed Outcome Card.
- **Revisit trigger:** None for the demo; future customer timing follows the approved protocol.

## D-013 — Internal feasibility is not generalization

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** An internal Zypact test can establish operational feasibility only. Any broader method claim requires replication in at least two pilot contexts and must still state its limits.
- **Reason:** Multiple runs on one site do not create multiple independent intervention contexts.
- **Effect:** The feasibility plan includes internal testing plus external replication gates.
- **Revisit trigger:** Completed replicated outcomes and methodological review.

## D-014 — One canonical documentation package precedes code commitments

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** All engineering candidates receive the same merged canonical package before submitting or confirming estimates. No full-V1 contract is approved against superseded documents.
- **Reason:** Previous candidates estimated against conflicting definitions of V1, sampling, delivery, and retest.
- **Effect:** Documentation reset precedes code milestones. Contractor prices stay in contracts, not canonical product documents.
- **Revisit trigger:** None; future scope changes must follow the same change-control principle.

## D-015 — Long-term vision is non-binding

- **Date:** 2026-08-16
- **Status:** Approved
- **Decision:** CEO and technical-cofounder vision documents describe possible future direction but cannot authorize work or override current methodology, scope, engineering, or status documents.
- **Reason:** A long-term vision should guide decisions without creating accidental contractor scope.
- **Effect:** Every vision document carries an explicit non-binding header and horizon.
- **Revisit trigger:** The authority index may be revised when company governance changes.
