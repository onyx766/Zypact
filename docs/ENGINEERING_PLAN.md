# Zypact V1 Engineering Plan

- **Status:** Canonical V1 implementation and estimate request
- **Plan date:** 2026-08-16
- **Repository rule:** Audit and pull-request workflow before production changes
- **Pricing:** Engineers supply independent hours and fixed prices; no preset budget anchor in this document

## 1. Objective

Complete the smallest trustworthy external paid-pilot V1 without rebuilding working code unnecessarily.

The engineering outcome is:

> An approved buyer question and bounded protocol can be executed from the web through a durable worker. Exact evidence is preserved immutably. Canonical observations drive every interface and report. One intervention can be registered and retested after a scheduled observation window. Safe reports deliver automatically; exceptions are reviewed or blocked.

## 2. Required preconditions

Before implementation begins:

1. canonical documentation is merged;
2. the engineer completes a read-only repository/deployment audit;
3. current production, preview, staging, and local environments are identified;
4. required access is granted through least-privilege and approved channels;
5. the milestone scope, acceptance tests, fixed price, timeline, exclusions, and warranty are agreed;
6. branch and pull-request rules are agreed;
7. database backup and migration recovery procedures are documented;
8. no prospect evidence or secrets are introduced into source control.

## 3. Engineering principles

- Reuse sound existing code; explain any proposed replacement.
- Raw evidence is immutable; derived observations are versioned and reproducible.
- One canonical snapshot/contract drives the dashboard and all reports.
- Long-running scans execute outside request/response web lifetimes.
- Paid calls fail closed without approval, admission, reservation, and limits.
- Retries are idempotent and cannot silently duplicate charges.
- Configurable sampling never means unbounded execution.
- Incomplete evidence yields explicit limitations, not inferred confidence.
- Report integrity is enforced by code and tests, not founder memory.
- Every schema or behavior change includes documentation and recovery notes.

### Audited reuse baseline

The documentation reset inspected official main commit `b339d42a28014d8436c180a7da0cb0ad876178b8`. M0 must re-verify the actual working base, but an estimate may not assume these foundations are absent:

- snapshot request, verification, founder approval/rejection, and secure report routes;
- manual scan orchestration and the current Perplexity adapter;
- 35 tracked migrations through `0035`;
- a database claim queue with worker lease, fencing, idempotency, reclaim, and delivery protections;
- 73 `scripts/test-*.ts` files, 24 registered `test:*` commands, and 2 registered `verify:*` commands;
- existing analysis, evidence, competitor, Gap Map, Fix Brief, report, and export paths.

The current worker is a reuse/refactor candidate, not a greenfield requirement. Its execution options still hard-code legacy prompt/run settings and an estimated project budget guard, and its production hosting/monitoring state is unknown. The current Perplexity adapter reconstructs a transcript after JSON parsing rather than preserving the exact body. The current short report parses the generated full-report Markdown rather than consuming one structured canonical snapshot.

Any proposal to replace these foundations must identify the failing requirement, migration risk, test impact, and lower-risk alternative.

## 4. Milestone structure

The engineer may propose a different technical decomposition after the audit, but every outcome and acceptance criterion below must be mapped explicitly.

### M0 — Read-only audit, security baseline, and plan reconciliation

#### Work

- inspect repository history, branches, application, database, migrations, worker/function paths, provider integrations, deployment, tests, and documentation;
- run existing safe tests;
- verify the current dependency/security finding, including the reported Next.js issue;
- classify every V1 area as `working`, `partial`, `missing`, `broken`, `unsafe`, `obsolete`, or `unknown` with code references;
- reproduce the known private regression-fixture inconsistencies without exposing prospect data or making new client claims;
- map current behavior to this plan;
- return a revised milestone estimate and dependencies.

#### Acceptance evidence

- written architecture and feature inventory;
- risk register;
- exact test commands and results;
- known-issue reproduction notes;
- no production mutation;
- revised hours, fixed price, dates, exclusions, operating costs, and warranty.

### M1 — Immutable evidence contract

#### Work

- remediate any confirmed critical/high dependency or framework issue from M0 that blocks safe staging, including the reported Next.js concern if authoritative advisory/version evidence confirms it;
- define one canonical provider-attempt/evidence contract;
- store exact raw request and response body as text or bytes;
- store SHA-256 hashes;
- optionally store parsed JSONB separately;
- retain HTTP status, latency, provider/model, usage, provider request ID, citations/source payloads, timestamps, and failure metadata;
- enforce immutability at the database layer for evidence fields;
- preserve attempt, retry, question, protocol, project, and tenant identity;
- document retention/deletion implications and migration behavior.

#### Acceptance tests

- security/dependency remediation is tied to the advisory or finding, lockfile changes are reviewed, and application regression checks pass;
- stored raw body matches the received fixture bytes/text and hash;
- parsed JSONB mutation cannot change the raw body;
- ordinary update/delete of immutable evidence is rejected;
- failed, timed-out, and non-JSON responses remain auditable;
- secrets and authorization headers are not stored or rendered;
- migration and rollback/forward-recovery tests pass.

### M2 — Canonical observations and entity resolution

#### Work

- implement versioned deterministic run observations;
- replace commercial `won/partial/lost` with approved observation labels;
- normalize company/product aliases while retaining raw values;
- enforce brand-self exclusion;
- scope competitors, claims, gaps, and sources to exact question/run evidence;
- label portfolio aggregates explicitly;
- make analyzer/entity versions visible and reprocessable.

#### Acceptance tests

- audited-brand aliases resolve deterministically without merging distinct entities;
- the audited brand cannot appear as its own competitor;
- each prompt-scoped competitor has supporting run IDs for that question;
- mixed run results remain mixed and are not forced into a stable verdict;
- reprocessing changes derived rows/version but not raw evidence;
- live, simulated, historical, and current data cannot mix silently.

### M3 — One source of truth and report integrity gates

#### Work

- establish a canonical project/protocol snapshot or aggregation contract;
- make dashboard, short report, full report, export, and future Outcome Card consume it;
- reconcile planned/completed/failed/excluded denominators;
- implement integrity-gate results: `integrity_passed`, `needs_review`, and `blocked`;
- block unsupported causal, revenue, novelty, or broad-surface language;
- inject required surface and non-causality limitations;
- correct output-format/extension contracts.

#### Acceptance tests

- database, dashboard, short report, full report, and export show identical canonical figures;
- a `.json` output is valid JSON and a Markdown output uses a Markdown extension;
- missing evidence/hash, unresolved entity, denominator mismatch, or unsupported claim prevents automatic delivery;
- a safe fixture reaches `integrity_passed`;
- an ambiguous fixture reaches `needs_review`;
- an unsafe fixture reaches `blocked`;
- client rendering exposes no secret or raw internal metadata.

### M4 — Question, protocol, sampling, and paid-call control

#### Work

- create stable buyer-question identities and immutable versions;
- add explicit question and protocol approval;
- model planned baseline/retest sampling without a fixed three-run fallback;
- record sample-plan status, method assumptions, limits, and estimated cost;
- add operator-configured run, spend, rate, retry, and concurrency caps;
- perform admission control and reservation before each paid call;
- reconcile reservations after every terminal outcome;
- expose planned/completed/failed/excluded/remaining counts.

#### Acceptance tests

- an unapproved question/protocol cannot create a paid attempt;
- invalid, missing, or over-cap sampling plans fail closed;
- a variable run plan executes the approved count and never silently runs three;
- reservation exists before provider invocation;
- budget/cap exhaustion rejects the next call;
- timeout, retry, crash, and duplicate submission do not double-charge;
- completed and failed denominators reconcile with reservations and costs;
- project and tenant boundaries are enforced.

### M5 — Durable web-triggered worker execution

#### Work

- retain or refactor the existing out-of-request worker path after M0 evidence, rather than rebuilding it by default;
- complete and verify durable queue/claim/fencing/idempotency behavior against the new per-attempt contract;
- connect the approved web workflow to the worker;
- add bounded timeouts and retry classes;
- persist progress and recover abandoned work;
- expose health, queue age/depth, latency, failure, and spend signals;
- provide operator recovery without direct database edits.

#### Acceptance tests

- a staging user can start an approved bounded scan without terminal work;
- web timeout or refresh does not cancel or duplicate the job;
- two workers cannot complete/pay for the same claimed attempt;
- abandoned jobs recover according to documented rules;
- unrecoverable failure produces a usable error state and preserves evidence;
- health and alert checks demonstrate expected success/failure behavior.

### M6 — Pilot workspace and evidence experience

#### Work

- complete basic account/workspace/project onboarding;
- reconcile the public entry path around a Request Demo CTA and the approved V1/surface limitations, without a legacy free score or unsupported loss claim;
- show question/protocol approval, progress, counts, evidence, observations, competitors, sources, limitations, and spend status;
- add Evidence Map and one intervention-hypothesis workflow;
- support `needs_evidence` and human approval;
- implement honest loading, empty, exploratory, insufficient, failed, review, and blocked states;
- keep raw evidence tenant-protected and inspectable.

#### Acceptance tests

- a pilot user can understand one project without developer explanation;
- a prospect can request a demo without being shown a fixed three-run company score or a promise that unfinished automation already exists;
- every displayed number links to canonical supporting evidence;
- cross-question totals are labeled;
- insufficient evidence does not show a confident conclusion;
- the user can approve/reject the question, protocol, and intervention at the required stages;
- access-control tests prevent cross-tenant reads and writes.

### M7 — Registered intervention, observation window, and retest

#### Work

- persist intervention hypothesis, approval, target, owner, artifact/action hash, and implementation timestamp;
- schedule and enforce the observation window;
- preserve baseline/question/protocol identity;
- support treatment/control definitions when justified;
- execute bounded retest;
- calculate versioned comparison and uncertainty;
- record deviations and confounders;
- generate statuses limited to `increase_observed`, `decrease_observed`, `no_clear_change`, or `inconclusive`;
- render the permanent non-causality footer.

#### Acceptance tests

- retest cannot run before eligibility without a recorded authorized deviation;
- silent question/configuration changes break comparison and are displayed;
- baseline/retest denominators and evidence reconcile;
- uncertainty-specific fixtures cover clear movement, no clear movement, insufficient evidence, conflicting controls, and provider drift;
- no selectable state can assert causality;
- every Outcome Card contains the standard footer.

### M8 — Automatic delivery, deployment hardening, and handoff

#### Work

- connect report delivery to integrity states;
- automatically deliver `integrity_passed` artifacts;
- route `needs_review` to founder/admin;
- prevent delivery of `blocked` artifacts;
- deploy/configure worker and application on Zypact-controlled accounts;
- finalize security, monitoring, alerting, cost controls, production smoke tests, and recovery;
- document environment variables without values, migrations, rollback/forward recovery, incidents, and operator procedures;
- deliver code/documentation handoff and warranty terms.

#### Acceptance tests

- live staging demonstration before approval;
- successful safe report delivery without founder action;
- review and blocked scenarios demonstrated;
- provider failure, worker restart, and budget exhaustion demonstrated safely;
- full existing and new test suite passes under documented commands;
- no secrets, prospect evidence, or unrelated files appear in the pull request;
- production ownership remains under Zypact-controlled accounts.

## 5. Cross-milestone acceptance matrix

| Requirement | Minimum proof |
|---|---|
| Exact evidence | Raw-body fixture/hash and database immutability test |
| Canonical figures | Same fixture produces identical database/UI/report/export figures |
| Configurable sampling | Multiple approved run plans, boundary rejection, and no hidden fallback |
| Uncertainty | Versioned calculation plus clear/no-change/inconclusive fixtures |
| Paid-call safety | Reservation-before-call, caps, retries, reconciliation tests |
| Long-running execution | Staging job survives web disconnect and worker recovery |
| Retest identity | Question/protocol/version preservation and deviation tests |
| Report safety | Integrity-pass, review, and blocked end-to-end fixtures |
| Tenant security | Cross-tenant denial tests and server-side secret checks |
| Operations | Health checks, alerts, runbook, migration/recovery documentation |

## 6. Required validation evidence

For every milestone, the engineer provides:

- pull-request URL and exact commit hash;
- changed-path list;
- test commands and unedited result summary;
- new regression tests;
- staging demonstration;
- database migration and recovery notes when applicable;
- screenshots or report artifacts when relevant;
- known limitations and deferred work;
- confirmation that no secrets/prospect evidence were committed.

Existing repository test commands must be enumerated during M0 rather than summarized only as a file count. Live credential-dependent tests run against approved staging resources.

At the audited base, the registered command inventory is recorded in [`CURRENT_STATUS.md`](CURRENT_STATUS.md). M0 must also classify the unregistered `scripts/test-*.ts` files and must not claim that a file count equals a passing test count.

## 7. Estimate format

Each candidate returns:

| Milestone | Existing code reused | Work included | Hours | Fixed price | Dependencies | Acceptance evidence | Exclusions |
|---|---|---|---:|---:|---|---|---|
| M0 |  |  |  |  |  |  |  |
| M1 |  |  |  |  |  |  |  |
| M2 |  |  |  |  |  |  |  |
| M3 |  |  |  |  |  |  |  |
| M4 |  |  |  |  |  |  |  |
| M5 |  |  |  |  |  |  |  |
| M6 |  |  |  |  |  |  |  |
| M7 |  |  |  |  |  |  |  |
| M8 |  |  |  |  |  |  |  |

Also provide:

- total fixed price and calendar duration;
- payment/release schedule;
- assumptions about run caps, concurrency, staging, and provider costs;
- expected pilot infrastructure/provider monthly costs;
- bug-fix warranty;
- post-warranty maintenance rate;
- availability and communication cadence;
- ownership and handoff terms.

The estimate must not optimize around a presumed founder budget. Any reduced-scope alternative must identify exactly which acceptance criteria and pilot capabilities are removed.

## 8. Access and change control

- Initial audit access is read-only where practical.
- Work occurs on feature branches through pull requests.
- No direct changes to `main`.
- No force-push or history rewrite.
- No production mutation without explicit milestone authorization.
- Use staging/test credentials and resources.
- Never request secrets in chat, email, documentation, or source control.
- No critical infrastructure remains in a contractor-owned account.
- Preserve unrelated founder/user work.
- Every accepted milestone receives a normal reviewed merge.

## 9. Warranty baseline

The final contract must state:

- warranty duration per milestone or final acceptance;
- definition of an in-scope defect;
- exclusions for provider changes, new features, and unrelated code;
- response expectations for critical defects;
- process for reproducing and accepting fixes;
- maintenance terms after warranty.

No warranty duration is assumed until it is in the signed milestone agreement.

## 10. Engineering stop conditions

Stop and request a product/methodology decision when:

- repository behavior contradicts a canonical requirement materially;
- sample/uncertainty requirements cannot be implemented defensibly;
- a migration risks evidence loss or tenant exposure;
- provider access cannot preserve required provenance;
- budget/reservation semantics are ambiguous;
- a requested UI statement would violate the methodology;
- an apparent scope change adds a provider, integration, enterprise feature, or causal claim;
- the available staging environment cannot safely demonstrate acceptance.
