# Zypact Technical Cofounder Vision

- **Status:** Non-binding technical direction
- **Date:** 2026-08-16
- **Audience:** Future technical cofounder or long-term technical leader
- **Authority limit:** This document does not authorize V1 scope, architecture changes, migrations, vendors, or engineering spend

## 1. Technical mission

Build Zypact into a trustworthy measurement and learning system for AI-mediated B2B shortlists—not a collection of agents, dashboards, or model API wrappers.

The system must answer three questions defensibly:

1. What exact surface returned what exact evidence under which approved conditions?
2. What observations and intervention hypothesis can be traced to that evidence?
3. What changed at retest, with what uncertainty and confounders?

The current V1 contract is defined by [`V1_SCOPE.md`](V1_SCOPE.md), [`METHODOLOGY.md`](METHODOLOGY.md), and [`ENGINEERING_PLAN.md`](ENGINEERING_PLAN.md). This document begins only where those documents stop.

## 2. Starting reality

At the audited official commit, Zypact already has reusable foundations:

- a Next.js/TypeScript application;
- Supabase/PostgreSQL migrations and adapters;
- manual scan orchestration and a Perplexity path;
- analysis, evidence, competitor, Gap Map, Fix Brief, report, and export code;
- a database-backed worker with claim, lease, fencing, idempotency, reclaim, and delivery protections;
- a substantial test inventory.

It also has legacy assumptions that must be migrated: reconstructed provider transcripts, fixed run settings, old verdict enums, renderer disagreement risk, incomplete protocol identity, and no registered retest/Outcome Card.

The technical strategy is **preserve sound foundations, replace unsafe contracts, and avoid a rewrite without evidence**.

## 3. Target system boundaries

### Protocol plane

- stable buyer-question identity and immutable versions;
- provider/surface configuration and validity metadata;
- bounded sample plan, caps, estimated cost, and approvals;
- baseline, control, retest, and deviation relationships.

### Execution plane

- admission and reservation before every paid attempt;
- durable queue/claim, lease, fencing, idempotency, timeouts, and recovery;
- provider adapters isolated behind a provenance contract;
- per-attempt terminal state and spend reconciliation;
- privacy-safe operational telemetry.

### Evidence plane

- exact request and response bytes/text;
- hashes and immutable storage rules;
- provider/model, status, latency, usage, request ID, citations, failures, and retry lineage;
- tenant/project/question/protocol identity;
- retention and deletion policy that does not silently rewrite history.

### Interpretation plane

- deterministic, versioned run observations;
- reversible entity and alias resolution;
- prompt-scoped supporting-run graph;
- analyzer/methodology versioning and reprocessing;
- human/model interpretation that cannot overwrite evidence.

### Product plane

- one canonical project/protocol snapshot;
- customer evidence inspection and honest insufficiency states;
- registered intervention and implementation record;
- observation-window scheduler and same-question retest;
- uncertainty-aware Outcome Card;
- automatic/review/blocked integrity routing.

## 4. Non-negotiable invariants

1. No paid provider attempt without approval, admission, reservation, and bounds.
2. Raw evidence cannot be edited through ordinary application behavior.
3. Derived facts remain reproducible and versioned.
4. Every displayed number traces to canonical supporting evidence.
5. Prompt-scoped claims never borrow evidence from another question silently.
6. Live, simulated, historical, and current data cannot mix silently.
7. A retry, crash, refresh, or second worker cannot cause an untracked duplicate spend.
8. Question/protocol changes cannot masquerade as a same-condition retest.
9. No enum, report, or UI path can claim causality.
10. Incomplete evidence fails closed into an explicit state.
11. Tenant isolation is enforced in the database and tested.
12. Provider breadth never overrides surface validity.

## 5. Technical evolution after V1

### Stage A — Repeatable hybrid operations

- reduce founder steps only after they are measured;
- standardize protocol templates from completed pilots;
- improve queue, cost, and observation-window operations;
- add exportable audit records and incident learning;
- preserve negative and inconclusive outcomes.

### Stage B — Question portfolio and Experiment Ledger

- support multiple priority questions without collapsing them into one score;
- model treatment/control and implementation histories;
- add permissioned minimal-data intake from approved customer sources;
- build category-specific entity and intervention taxonomies;
- measure whether templates improve reliability and time-to-value.

### Stage C — Independent verification layer

- accept interventions performed by customers, agencies, or other platforms;
- expose reproducible protocol and evidence contracts;
- add surface-specific adapters only after validity review;
- support partner submissions and auditable verification APIs;
- publish methodology and compatibility/version boundaries.

### Stage D — Calibrated intervention intelligence

- construct a normalized Intervention–Outcome Graph;
- estimate time-to-observe and outcome distributions by context;
- compare recommendation ranking against naive baselines;
- monitor calibration, drift, subgroup error, and data leakage;
- retain human approval and visible uncertainty.

Stage D is not an LLM prompt. It requires comparable histories, statistical review, and evidence that prediction improves customer decisions.

## 6. Architecture principles

- Prefer explicit contracts and state machines over implicit agent choreography.
- Treat provider calls as financial side effects with ledger semantics.
- Separate immutable evidence from reprocessable interpretation.
- Keep provider adapters surface-specific; do not force false cross-provider comparability.
- Use PostgreSQL constraints/RPCs/transactions for invariants that must survive process failure.
- Make long-running work observable and recoverable outside web request lifetimes.
- Build idempotency into every boundary that can retry.
- Keep client renderers downstream of one canonical structured snapshot.
- Version methodology, analyzers, entities, protocols, reports, and comparisons.
- Make “unknown,” “insufficient,” and “inconclusive” first-class product states.
- Optimize for auditability and operating clarity before model cleverness.

## 7. Security and data governance direction

- minimize intake from CRM, calls, RFPs, and support data;
- extract approved business questions rather than ingest entire datasets by default;
- separate tenant data and cross-customer benchmarks;
- require explicit rights for anonymized aggregate learning;
- support retention, deletion, legal hold, and export policies before enterprise expansion;
- prevent secrets, personal data, and raw customer evidence from entering logs or source control;
- keep critical infrastructure and keys in Zypact-controlled accounts;
- maintain migration, backup, restore, incident, and access-review evidence.

Cross-customer learning is not permitted merely because it would improve a model.

## 8. Observability and reliability direction

Track at minimum:

- queue depth and oldest job age;
- claim, lease, reclaim, and fencing events;
- provider attempt success, failure, timeout, and latency;
- reservation, reconciliation, and spend by approved boundary;
- analyzer/entity/report version and failure;
- integrity pass/review/block rate;
- observation-window and retest eligibility delays;
- delivery success and idempotency;
- tenant-access denials and security events.

Operational dashboards are justified by incident response and cost control, not appearance.

## 9. Experiment and data-quality discipline

- sampling plans belong to versioned protocols, not UI constants;
- repeated provider calls may be correlated;
- question diversity and portfolio design may matter more than repetition alone;
- controls can reveal drift but do not automatically establish causality;
- model/provider/configuration changes are recorded as possible breaks in comparability;
- uncertainty calculations are tested with synthetic fixtures and reviewed methodologically;
- positive, negative, unchanged, failed, and inconclusive cases all remain in the ledger.

The technical leader must be willing to say that a desired product claim is not supported by the available design.

## 10. Build-versus-buy principles

Buy commodity infrastructure when it preserves ownership, security, and auditability. Build the contracts and data structures that express Zypact's differentiated learning loop.

Likely commodities:

- identity and email delivery;
- managed PostgreSQL and object storage;
- process/container hosting;
- error tracking and basic telemetry;
- billing and invoicing when required.

Likely differentiated assets:

- question/protocol model;
- exact evidence and attempt ledger;
- deterministic observation/entity layer;
- prompt-scoped evidence graph;
- intervention and observation-window model;
- comparison/Outcome Card method;
- integrity gates;
- normalized Intervention–Outcome Graph.

No vendor decision in this section is pre-approved.

## 11. What not to build without validated pull

- maximum model coverage;
- generic prompt-volume tracking;
- 3D or decorative analytics;
- autonomous publishing or a generic content studio;
- CRM/call ingestion before minimum-data and permission rules;
- enterprise SSO/governance before enterprise demand;
- predictive lift scores before calibration data;
- custom infrastructure that duplicates a reliable managed service;
- a rewrite motivated by aesthetics rather than failed invariants.

## 12. Technical cofounder mandate

The future technical cofounder should own:

- evidence and protocol architecture;
- security, tenancy, migrations, and production reliability;
- cost-safe provider execution;
- methodological implementation with causal humility;
- developer standards, tests, observability, and incident learning;
- the technical hiring sequence;
- the path from founder-operated workflow to repeatable product;
- honest communication about risk, uncertainty, and tradeoffs.

The founder owns buyer truth, category design, customer decisions, and commercial validation. The partnership succeeds when product evidence—not title, urgency, or feature volume—resolves disagreements.

## 13. Open technical questions

Before long-term architecture is committed, answer with pilot evidence:

- Which Perplexity configuration is stable enough for which claims?
- What sample planning methods remain useful under correlated outputs?
- Which intervention types produce observable effects within customer-relevant windows?
- How should control questions be selected and interpreted?
- Which exact evidence should use database text versus object storage bytes?
- What retention/deletion model preserves auditability and customer rights?
- When does the PostgreSQL queue cease to meet throughput/operability needs?
- Which second surface has enough public validity to justify an adapter?
- What minimum outcome volume supports any calibrated recommendation?

These are research questions. Architecture should make them measurable without pretending they are already answered.
