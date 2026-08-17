# Engineer Start Here — Zypact V1

- **Status:** Canonical required engineering entry point
- **Purpose:** Tell an engineer exactly what to read, verify, estimate, and deliver
- **Scope date:** 2026-08-16

## 1. Your assignment

Begin with a read-only audit of the existing Zypact repository and deployment evidence. Then return a repository-specific milestone estimate for completing the trustworthy external paid-pilot V1.

Do not assume the product requires a rebuild. Do not begin feature implementation, modify production, or estimate from superseded documents.

This documentation was reconciled against official main commit `b339d42a28014d8436c180a7da0cb0ad876178b8` on 2026-08-16. Re-fetch and identify your actual base before relying on that snapshot.

The target outcome is:

> An approved buyer question and bounded protocol can run from the web through a durable worker. Exact provider evidence is stored immutably. Canonical observations drive every interface and report. One intervention can be registered and retested after an observation window. Safe reports deliver automatically; exceptions are reviewed or blocked.

## 2. Read these documents in this order

### 1. [`CURRENT_STATUS.md`](CURRENT_STATUS.md)

Understand what was verified in the audited official tree, what remains partial or missing, and which deployment facts are still unknown. Re-verify the inventory against the actual branch and environments before implementation.

### 2. [`V1_SCOPE.md`](V1_SCOPE.md)

Understand exactly what the external paid-pilot V1 must deliver and what is explicitly deferred.

### 3. [`METHODOLOGY.md`](METHODOLOGY.md)

Understand the evidence, sampling, uncertainty, competitor, retest, reporting, and language rules the implementation must enforce.

### 4. [`ENGINEERING_PLAN.md`](ENGINEERING_PLAN.md)

Map the repository to milestones M0–M8, acceptance tests, dependencies, estimates, staging demonstrations, and handoff requirements.

### 5. [`DECISIONS.md`](DECISIONS.md)

Use the dated decisions to resolve old assumptions and terminology. If a requirement still appears ambiguous, stop and ask rather than selecting the cheapest interpretation.

### Supporting operational context

- [`PILOT_RUNBOOK.md`](PILOT_RUNBOOK.md): how the founder and customer operate the first pilots.
- [`ROADMAP.md`](ROADMAP.md): sequencing and kill gates; not a contractor schedule.

## 3. Most important changes from the old V1 documents

1. A fixed three-run sample is not an external client measurement.
2. Sampling is configurable by approved protocol and bounded by hard run/spend limits.
3. `won`, `partial`, and `lost` are not active client verdicts.
4. Perplexity Sonar is a directional V1 surface, not “all AI.”
5. Every paid call requires approval, admission, and reservation before execution.
6. Dashboard, short report, full report, export, and Outcome Card use one canonical evidence contract.
7. Prompt-scoped claims require prompt-scoped supporting run IDs.
8. A registered intervention includes implementation evidence and an observation window.
9. Retest preserves question/protocol identity and reports uncertainty.
10. Outcome statuses are only `increase_observed`, `decrease_observed`, `no_clear_change`, or `inconclusive`.
11. Every Outcome Card carries a permanent non-causality footer.
12. `integrity_passed` reports may deliver automatically; `needs_review` is exceptional; `blocked` never delivers.

## 3.1 Existing foundations you must assess before estimating

The audited tree already contains a manual scan engine, a Perplexity adapter, snapshot request and founder approval routes, 35 migrations, report delivery fencing, and a database-backed worker with claim, lease, fencing, idempotency, and recovery logic.

Do not quote a new worker or a rebuild merely because hosting is incomplete. Separate:

- code that can be retained;
- code that needs contract changes;
- missing deployment/process supervision;
- genuinely missing V1 behavior.

The exact known gaps and registered test commands are in [`CURRENT_STATUS.md`](CURRENT_STATUS.md).

## 4. Your first deliverable — M0 only

Before quoting or committing to the full implementation, return:

1. repository branch/hash and architecture inventory;
2. deployment/environment topology;
3. migration ledger and database-risk notes;
4. exact existing test commands and results;
5. V1 feature inventory marked `working`, `partial`, `missing`, `broken`, `unsafe`, `obsolete`, or `unknown`, with code references;
6. reproduction/classification of the known evidence and report issues;
7. data-flow diagram from question approval through provider call, evidence, report, and retest;
8. security, privacy, reliability, cost, and maintainability risk register;
9. recommendation on which current code to retain, refactor, or replace;
10. revised milestones, hours, fixed price, dependencies, acceptance evidence, exclusions, operating costs, schedule, warranty, and maintenance terms.

## 5. Estimate against these outcomes

| Milestone | Required outcome |
|---|---|
| M0 | Read-only audit and repository-specific plan |
| M1 | Immutable exact provider evidence and metadata |
| M2 | Canonical observations, aliases, and prompt-scoped competitors |
| M3 | One source of truth and report integrity gates |
| M4 | Question/protocol approval, configurable sampling, caps, and spend reservation |
| M5 | Durable web-triggered worker, recovery, monitoring, and no duplicate paid calls |
| M6 | Pilot workspace, evidence access, and intervention approval |
| M7 | Observation window, same-question retest, uncertainty, and Outcome Card |
| M8 | Automatic/review/blocked delivery, deployment hardening, and handoff |

For each milestone, state existing code reused, work included, hours, fixed price, dependencies, acceptance evidence, and exclusions. Do not optimize around a presumed founder budget.

## 6. Change-control and access rules

- Initial audit is read-only where practical.
- Use a feature branch and pull request; do not commit directly to `main`.
- Do not force-push or rewrite history.
- Do not modify production without explicit milestone authorization.
- Do not request or commit secret values.
- Use staging/test resources for demonstrations.
- Do not commit prospect reports, raw client evidence, environment files, or unrelated assets.
- Preserve unrelated existing work.
- Every milestone requires a live staging demonstration and documented test evidence before release.
- Every schema change requires migration and recovery notes.
- Critical infrastructure and accounts remain controlled by Zypact.

## 7. Documents that do not define your contracted scope

- materials not included in this engineering repository;
- roadmap items beyond the approved milestone.

Only the active canonical package and signed milestone agreement authorize work.

## 8. Stop and ask when

- repository reality materially contradicts `CURRENT_STATUS.md`;
- a requirement would violate `METHODOLOGY.md`;
- sample or uncertainty implementation is not defensible;
- provider access cannot preserve required provenance;
- migration risks evidence loss or tenant exposure;
- run/spend caps or reservation semantics are ambiguous;
- a requested feature expands providers, integrations, enterprise scope, or causal claims;
- staging cannot demonstrate acceptance safely.

Do not silently substitute an old assumption, especially the old three-run behavior.
