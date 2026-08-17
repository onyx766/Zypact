# Zypact V1 Scope

- **Status:** Canonical V1 product scope
- **Scope date:** 2026-08-16
- **Offer:** Evidence-Backed Shortlist Diagnostic + Registered Retest
- **Initial live surface:** Perplexity Sonar

## 1. V1 promise

> Approve a commercially meaningful buyer question, execute a bounded and recorded baseline on one defined AI surface, inspect the exact evidence and observed competitors, register one evidence-backed intervention hypothesis, and retest the same question after an explicit observation window.

V1 reports observed change, no clear change, or an inconclusive result. It does not promise causal proof, total AI-market coverage, or revenue attribution.

## 2. Target user

The initial user is a founder or marketing/product-marketing/growth leader at an English-language B2B SaaS company with:

- an identifiable category and competitor set;
- meaningful buyer consideration and contract value;
- access to real or defensible buyer questions;
- capacity to implement an intervention;
- willingness to wait through the recorded observation and retest window.

The first pilots are founder-operated. V1 does not require a mature self-serve onboarding or enterprise procurement experience.

## 3. V1 customer workflow

1. Founder/customer qualifies the company and pilot.
2. Customer supplies or approves buyer questions and context.
3. Zypact records a stable question identity and version.
4. A bounded protocol is created and explicitly approved before paid calls.
5. Baseline attempts run asynchronously with reservation, limits, timeouts, and recovery.
6. Exact raw requests/responses and metadata are stored immutably.
7. Canonical observations and entities are derived.
8. Customer inspects prompt-scoped evidence, observed competitors, sources, and limitations.
9. Zypact proposes one intervention hypothesis grounded in the evidence.
10. Customer approves and implements the intervention.
11. Zypact records implementation evidence and opens the observation window.
12. Retest runs under the preserved or explicitly versioned protocol.
13. Zypact creates an auditable Outcome Card.
14. The report delivers automatically if integrity passes; otherwise it enters `needs_review` or `blocked`.

## 4. Functional scope

### 4.1 Marketing and pilot entry

- a clear landing page for the Evidence-Backed Shortlist Diagnostic + Registered Retest;
- **Request Demo** as the primary call to action;
- honest disclosure that the initial live surface is Perplexity Sonar and the first pilots are hybrid/founder-operated;
- no fixed three-run free company score or unsupported “lost sale” claim;
- pricing may describe a paid/custom pilot path without requiring public fixed packages;
- self-serve checkout is not required for the core V1 trust workflow.

### 4.2 Account and workspace

- basic authentication;
- one owner role;
- basic company/workspace information;
- project creation and reopening;
- tenant-safe access controls;
- advanced teams/roles deferred.

### 4.3 Company and question intake

- company name, domain, category, audience, and approved competitor frame;
- optional site reading/Mirror Profile as a diagnostic input;
- manual or assisted buyer-question creation;
- question provenance, intent, buyer stage, persona, constraints, and priority;
- human correction and explicit approval;
- stable question identity and immutable versions.

### 4.4 Protocol planning and approval

- provider/surface/model configuration;
- planned baseline and retest sampling;
- optional controls and paraphrases;
- unit of analysis and declared primary metric;
- minimum useful change or decision threshold;
- sample-plan status and limitations;
- observation-window rule;
- estimated attempts and provider cost;
- project/protocol hard caps;
- explicit approval before every paid probe sequence.

There is no silent three-run default for an external measurement.

### 4.5 Paid-call safety

- admission control before enqueue/execution;
- reservation before every paid attempt;
- user/project/provider run and spend caps;
- rate and concurrency limits;
- idempotency and duplicate-call prevention;
- timeouts and bounded retries;
- spend reconciliation after success or failure;
- fail-closed behavior when required configuration or approval is missing.

### 4.6 Asynchronous execution

- durable worker or equivalent long-running execution path;
- web-triggered scan without terminal work for the external V1 user;
- progress stages and customer-visible status;
- safe retry/resume of recoverable stages;
- worker health, failure, queue-age, and cost monitoring;
- operator recovery path.

The manual/terminal runner remains an operator and verification tool.

### 4.7 Immutable evidence

For every provider attempt, preserve:

- exact outbound request;
- exact raw response body as text or bytes;
- SHA-256 integrity hash;
- optional parsed JSONB;
- provider, model/mode, HTTP status, latency, provider request ID, and usage;
- citations/sources returned;
- timestamps, failure metadata, attempt identity, and retry relationship;
- question, protocol, project, and tenant identity.

Evidence fields cannot be updated or deleted through ordinary application behavior.

### 4.8 Canonical observations

- run-level position: not observed, listed, primary, ambiguous, or analysis failed;
- audited brand cited as a source;
- observed raw and canonical competitors/products;
- citations, sources, claims, and relevant rationales;
- analyzer/methodology version;
- visible warnings and excluded/failed attempt reasons.

No model-generated summary may override deterministic evidence.

### 4.9 Entity and competitor resolution

- raw names retained;
- deterministic and versioned aliases;
- parent/product distinction where needed;
- audited-brand self-exclusion;
- prompt-scoped competitor evidence with supporting run IDs;
- explicit labeling for portfolio-level aggregates;
- reversible reprocessing from immutable evidence.

### 4.10 Evidence map and intervention brief

- question → observation → competitor/product → criterion/claim → source;
- customer-approved evidence and missing-evidence state;
- one intervention hypothesis;
- supporting evidence and expected mechanism;
- owner, target, implementation requirement, and expected observation window;
- alternative explanations and evidence still needed;
- `needs_evidence` blocking state when the brief cannot support a safe action.

### 4.11 Registered intervention

- intervention ID, hypothesis, action type, owner, and target;
- approval and timestamp;
- approved asset/action hash when possible;
- implementation evidence and timestamp;
- protocol deviations and confounders;
- observation-window start, end, and retest eligibility.

### 4.12 Retest and outcome

- preserved question and baseline identity;
- versioned retest protocol;
- scheduled execution after the observation window;
- treatment/control relationship when used;
- baseline/retest numerator, denominator, uncertainty, and failed/excluded attempts;
- statuses limited to `increase_observed`, `decrease_observed`, `no_clear_change`, or `inconclusive`;
- explicit configuration differences and confounders;
- permanent non-causality footer.

### 4.13 Dashboard and evidence access

- project/protocol status;
- approved buyer questions;
- planned/completed/failed/excluded attempts;
- spend reserved and reconciled where appropriate;
- raw evidence access under tenant permissions;
- run- and question-level observations;
- evidence map and intervention state;
- observation-window and retest schedule;
- Outcome Card/report state;
- honest loading, empty, blocked, failed, exploratory, and insufficient-evidence states.

No advanced trend chart appears without adequate history and a defined method.

### 4.14 Reports and delivery

- one canonical data snapshot drives dashboard and reports;
- client-facing diagnostic report;
- registered-intervention record;
- Outcome Card after retest;
- exact sample, surface, dates, limitations, and evidence links;
- automatic generation/delivery after all integrity gates pass;
- `needs_review` founder/admin exception;
- `blocked` state for unsafe artifacts;
- basic share/export path;
- PDF optional unless explicitly quoted or already stable.

## 5. Category benchmark acquisition feature

V1 may support a founder-operated one-question category benchmark as the free acquisition asset.

It must use:

- one exact published buyer question;
- one recorded surface/protocol;
- a documented sample plan;
- inclusion frequency and uncertainty;
- raw-evidence auditability;
- visible time, category, and surface limitations;
- no overall company visibility score.

Full benchmark automation is not required for the first external paid-pilot-ready V1.

## 6. Automation boundary

### Automated when integrity passes

- approved-protocol execution;
- evidence persistence;
- deterministic observation and canonical aggregation;
- integrity checks;
- report rendering;
- delivery after `integrity_passed`.

### Human decision remains required

- buyer-question approval;
- protocol approval and budget authorization;
- intervention selection and approval;
- confirmation that implementation occurred;
- handling `needs_review` artifacts;
- customer interpretation and next decision during the first pilots.

## 7. V1 acceptance definition

V1 is paid-pilot ready only when:

1. an external user can complete the approved workflow without developer database/code edits;
2. no paid attempt occurs without approval, admission, reservation, and bounded limits;
3. every displayed fact traces to immutable evidence;
4. aliases, competitors, counts, and reports agree across the system;
5. sample limitations and uncertainty control the language shown;
6. insufficient evidence produces an exploratory, insufficient, or inconclusive state—not false confidence;
7. one registered intervention and same-question retest work end to end;
8. observation-window scheduling prevents premature retests;
9. automatic delivery occurs only after integrity passes;
10. staging, monitoring, recovery, migration, rollback, test, and handoff procedures are documented.

## 8. Explicitly deferred

- broad multi-model/public-surface coverage;
- full AI Buyer Journey Intelligence;
- continuous weekly/monthly monitoring;
- predictive buyer intelligence or expected lift;
- advanced journey expansion;
- CRM, Gong, Slack, or HubSpot integrations;
- autonomous publishing;
- generic content studio;
- advanced teams, tasks, comments, and permissions;
- public API;
- white-label;
- enterprise SSO;
- native mobile application;
- complex self-serve pricing entitlements;
- causal or revenue attribution.

## 9. V1 non-goals

V1 is not intended to:

- measure what every buyer sees;
- prove a sale was won or lost because of AI;
- compete on the largest prompt database or number of supported models;
- replace SEO, content, PR, product marketing, or CRM platforms;
- guarantee that an intervention changes an AI response;
- create a polished broad dashboard before the measurement is trustworthy.
