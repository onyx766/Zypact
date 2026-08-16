# Zypact V1 Methodology

- **Status:** Canonical V1 methodology
- **Version:** 1.0
- **Method date:** 2026-08-16
- **Initial live surface:** Perplexity Sonar
- **Authority:** Governs evidence, sampling, observations, uncertainty, retest comparisons, and client-facing methodological language

## 1. Purpose

This methodology defines what Zypact may measure, how it records that measurement, and what it may honestly say about the result.

It exists to prevent five failures:

1. treating a small set of stochastic responses as a stable market truth;
2. mixing evidence from different questions or conditions;
3. allowing model summaries to override stored facts;
4. presenting an observed before/after difference as proven causation; and
5. presenting one provider surface as the experience of every AI buyer.

## 2. Unit of observation

The atomic observation is one completed provider response attached to:

- one approved buyer-question version;
- one recorded protocol version;
- one provider/surface/model configuration;
- one timestamp and execution context;
- one immutable raw request and raw response;
- one versioned observation extractor.

A provider response is evidence of what that surface returned under those conditions. It is not proof that a buyer saw the answer, changed a shortlist, or made a purchase decision.

## 3. Evidence classes

| Class | Definition | May support |
|---|---|---|
| **Raw evidence** | Exact provider request/response and provider metadata | What was sent and returned |
| **Deterministic observation** | Reproducible extraction from raw evidence under a versioned rule | Mention, position, citations, raw competitor names |
| **Normalized observation** | Deterministic entity/alias resolution that retains raw values | Canonical competitor and product counts |
| **Interpretation** | Human- or model-assisted explanation grounded in identified evidence | Possible evidence gaps and intervention hypotheses |
| **External evidence** | Customer-supplied or publicly verified business/product evidence | Approved facts, implementation proof, business context |
| **Outcome comparison** | Versioned comparison of baseline and retest observations | Observed increase, decrease, no clear change, or inconclusive result |

Interpretation cannot overwrite raw or deterministic evidence.

## 4. Surface validity

### Current V1 surface

Perplexity Sonar is the current live V1 surface because an existing path has produced auditable responses and citations at a manageable cost.

Every external result must identify:

- provider and model/mode;
- exact buyer question;
- execution dates;
- number of planned, completed, failed, and excluded attempts;
- material configuration available from the provider;
- whether search/retrieval was enabled;
- methodology and analyzer version.

### Required limitation

Every Perplexity-only client artifact must state:

> This is a directional measurement of Perplexity Sonar under the recorded conditions. It does not represent what every buyer sees across ChatGPT, Gemini, Copilot, Claude, or all AI systems.

### Adding another surface

A second surface requires a written adapter-validity note covering:

- whether the tested interface corresponds to a public, private, API, tenant-specific, or search experience;
- what context the provider may inject;
- request and response provenance;
- reproducibility limits;
- terms/policy constraints;
- cost, rate limits, and expected latency;
- comparability with existing surfaces.

Model breadth alone is not sufficient justification.

## 5. Buyer questions

### Eligibility

A V1 buyer question should be:

- commercially meaningful to the customer;
- written without naming the audited brand when testing unbranded discovery or comparison;
- specific enough to represent a buyer decision context;
- reviewed for category, buyer role, constraints, and ambiguity;
- approved before any paid probe;
- assigned a stable identity and immutable version.

### Provenance

Question provenance may be:

- customer-supplied call or CRM evidence;
- RFP, objection, win/loss interview, support, or product-marketing material;
- founder/user-supplied question;
- model-assisted suggestion reviewed and approved by a human;
- public category benchmark question.

Question provenance affects relevance. It does not prove that every buyer asks the question.

### Versioning

Any wording change creates a new question version. A retest that changes wording must visibly identify the change and cannot silently compare the new wording as the same question.

## 6. Protocol registration

Before paid execution, a protocol must record:

- protocol ID and version;
- approved question IDs and versions;
- surface/provider/model configuration;
- region, account state, search mode, and other known context;
- planned baseline and retest runs;
- paraphrase plan, if any;
- treatment question and control set, if any;
- unit of analysis;
- primary and secondary metrics;
- minimum useful change or decision threshold;
- sample-planning method and assumptions;
- project run and spend caps;
- observation-window rule;
- analyzer/entity-resolution/methodology versions;
- approval actor and timestamp;
- declared limitations.

The system must not create paid attempts from an unapproved or unbounded protocol.

## 7. Sampling

### No universal run count

Zypact does not define three, ten, thirty, fifty, or one hundred runs as universally sufficient.

The planned sample depends on:

- baseline inclusion rate;
- response variance and dependence;
- minimum change that would alter a customer decision;
- number and diversity of buyer questions;
- whether the analysis is per-question or portfolio-level;
- surface and configuration stability;
- budget and time constraints;
- treatment/control design;
- acceptable uncertainty.

### Pilot sample planning

When no reliable baseline exists, the protocol may use a staged design:

1. an explicitly exploratory initial sample estimates baseline behavior;
2. the protocol calculates or reviews the additional sample required;
3. the customer/operator approves the bounded plan and spend;
4. if the required sample exceeds the hard cap or commercial value, the test stops or remains exploratory.

The method must not silently stop at a convenient sample and issue a confident verdict.

### Dependence warning

Repeated calls to the same model are not guaranteed to be independent. Classical confidence calculations may overstate certainty when outputs are correlated. Zypact must document the estimator and its assumptions and should prefer conservative language when dependence is unknown.

### Technical caps

Scientific planning does not override operational safety. Every protocol is bounded by configured limits for:

- runs per question;
- total project/provider attempts;
- hourly/daily admission;
- concurrency;
- provider spend;
- retry attempts;
- execution and observation windows.

The production values are operating configuration, not claims of statistical sufficiency.

## 8. Run inclusion and denominator

Every metric must identify its denominator.

Provider attempts may be:

- planned;
- reserved;
- queued;
- running;
- completed and included;
- completed but excluded under a predeclared rule;
- failed;
- timed out;
- cancelled.

Only responses satisfying the registered inclusion rules enter the analysis. Exclusions require a reason and remain auditable. Failures cannot disappear from the report denominator explanation.

No report may display a rate without both numerator and denominator.

## 9. Run-level observations

Run-level observations describe only the stored response.

Allowed position labels:

- `not_observed_in_run`
- `listed_in_run`
- `primary_in_run`
- `ambiguous_in_run`
- `analysis_failed`

These labels do not mean that the customer won or lost a sale.

Additional observations may include:

- raw and canonical brands/products mentioned;
- recommendation order when identifiable;
- citations and source URLs;
- audited brand cited as a source;
- relevant claims or decision criteria;
- negative or inaccurate claims with evidence references;
- parsing/analyzer warnings.

## 10. Question- and portfolio-level summaries

Question-level summaries must preserve disagreement between runs.

Allowed descriptive labels include:

- `observed_consistently_in_sample`
- `not_observed_consistently_in_sample`
- `mixed_in_sample`
- `insufficient_evidence`

The exact thresholds, if used, must be versioned and disclosed. Labels cannot conceal numerator, denominator, uncertainty, or excluded/failed attempts.

Portfolio summaries must not imply that unrelated questions are interchangeable. A portfolio result must show:

- included question versions;
- weighting method;
- buyer-stage or priority context when used;
- per-question results;
- aggregate numerator/denominator;
- uncertainty and heterogeneity limitations.

A global “AI visibility score” is outside V1.

## 11. Competitor and entity resolution

### Prompt scope

A competitor attached to a question must have supporting run IDs from that exact question/version and protocol.

### Normalization

Normalization must:

- retain the raw observed string;
- map aliases under deterministic versioned rules;
- distinguish product from parent/company where relevant;
- block the audited brand and approved aliases from becoming its own competitor;
- avoid merging genuinely distinct entities;
- permit reprocessing without mutating raw evidence.

Cross-question competitor totals must be labeled as portfolio aggregates and cannot be used as if they came from one prompt.

## 12. Evidence map and intervention hypothesis

The evidence map may connect:

- buyer question;
- observed recommendation or non-observation;
- competitor/product;
- decision criterion or claim;
- cited or retrieved source;
- customer-approved product evidence;
- possible evidence gap.

The system may propose an intervention hypothesis such as a comparison page, clarification, third-party evidence effort, documentation update, structured data change, or product-claim correction.

Every intervention brief must state:

- supporting evidence;
- expected mechanism;
- target and owner;
- implementation requirement;
- expected observation window;
- known alternative explanations;
- evidence still needed;
- what outcome would be considered useful, unchanged, or inconclusive.

“The missing page caused the result” is prohibited unless a future approved design establishes that specific causal claim.

## 13. Registered retest

A retest requires:

1. a completed or explicitly bounded baseline;
2. one registered intervention hypothesis;
3. customer/operator approval;
4. implementation evidence, timestamp, and artifact/action hash when possible;
5. a defined observation/indexing window;
6. a scheduled retest protocol;
7. preserved question identity and recorded configuration;
8. control questions or comparison structure when justified;
9. a confounder log;
10. a versioned outcome calculation.

Retest execution remains blocked until the recorded observation-window rule is satisfied or an authorized override is documented as a protocol deviation.

## 14. Controls and confounders

Controls may help detect wider model or market drift, but they do not automatically establish causality.

A control set must be justified by:

- relationship to the treatment question;
- expected exposure or non-exposure to the intervention;
- preserved wording and configuration;
- sample and cost plan;
- predeclared comparison rule.

The confounder log should capture material changes such as:

- model or provider updates;
- prompt or configuration changes;
- competitor launches or campaigns;
- unrelated customer content, PR, product, pricing, or website changes;
- source indexing or removal;
- major news or category events;
- incomplete or delayed intervention implementation.

## 15. Outcome statuses

The only V1 Outcome Card statuses are:

- `increase_observed`
- `decrease_observed`
- `no_clear_change`
- `inconclusive`

Each status must link to baseline and retest evidence, method version, numerator/denominator, uncertainty, controls where used, and confounders.

`causality_not_established` is not an enum or selectable state.

Every Outcome Card includes this permanent footer:

> **This Outcome Card documents an observed change under the recorded conditions. It does not establish that the intervention caused the change.**

## 16. Report integrity gates

Before automatic delivery, the report builder must confirm:

1. required raw request/response evidence and hashes exist;
2. every included run belongs to the approved project, question version, and protocol;
3. planned, completed, failed, excluded, and included counts reconcile;
4. live, simulated, historical, and current data are not silently mixed;
5. provider, surface, model/mode, dates, and method version are present;
6. brand-self exclusion passes;
7. entity normalization is complete or uncertainty is visible;
8. prompt-scoped competitors and claims have supporting run IDs;
9. cross-question aggregates are explicitly labeled;
10. uncertainty/sample status supports the displayed language;
11. no unsupported causal, revenue, novelty, or market-wide statement appears;
12. required surface and causal-limit footers are present;
13. sensitive technical metadata and secrets are excluded from client content;
14. the rendered artifact agrees with the canonical stored snapshot.

Resulting report states:

- `integrity_passed` — automatic generation/delivery allowed;
- `needs_review` — held for founder/admin review;
- `blocked` — unsafe to deliver.

## 17. One-question category benchmark

The free acquisition benchmark measures one exact category buyer question under one recorded protocol. It is not a company-wide visibility score.

The benchmark must publish:

- question wording and rationale;
- surface/provider/model and dates;
- sample-planning method;
- planned/completed/failed/excluded counts;
- inclusion frequency and uncertainty for observed brands;
- entity-resolution rules;
- access to or description of the raw-evidence audit trail;
- category and time limitations;
- funding/sponsorship or conflicts when relevant.

Required limitation:

> This benchmark measures responses to this exact buyer question on the recorded AI surface and dates. It is not a complete measure of any company’s overall AI visibility.

The benchmark must not call a brand the category winner unless the published methodology defines and supports that narrower claim.

## 18. Feasibility and generalization

An internal test on Zypact may establish whether the workflow can run and whether a change is detectable in that single context. It cannot establish generality.

Before Zypact markets a verified-lift mechanism, the method should be replicated in at least two external pilot contexts, include failure/inconclusive cases, and be reviewed for:

- sample and dependency assumptions;
- treatment/control validity;
- observation timing;
- confounders;
- cost and customer value;
- reproducibility.

## 19. Prohibited language

Without direct evidence and an approved narrow context, Zypact must not say:

- “You lost the sale.”
- “AI buyers cannot find you.”
- “This is your overall AI visibility.”
- “This fix caused the lift.”
- “We control what ChatGPT or other AI systems say.”
- “We guarantee citations, recommendations, leads, or revenue.”
- “No competitor offers this.”

A defensible competitive statement is:

> As of the documented research date, we did not identify a major public offer whose primary unit of value was the same registered protocol described here.

This statement still requires dated research and should not be repeated indefinitely without re-verification.

## 20. Method change control

Any material change to sampling, inclusion rules, entity resolution, uncertainty, controls, outcome status, or report language requires:

- a methodology version change;
- a dated decision entry;
- impact analysis on active protocols;
- migration or reprocessing rules;
- new or updated regression tests;
- disclosure when old and new results are not directly comparable.

Methodology changes do not rewrite immutable raw evidence.
