# Zypact

- **Documentation status:** Canonical for V1 planning and engineering estimates
- **Documentation reset date:** 2026-08-16
- **Repository baseline audited:** official `ZypactHQ/zypact-clean-mvp` main at `b339d42a28014d8436c180a7da0cb0ad876178b8`
- **Code effect of this reset:** None

Zypact is building an evidence-backed workflow for examining whether a B2B company appears in AI-generated vendor recommendations for approved buyer questions.

The current V1 offer is:

> **Evidence-Backed Shortlist Diagnostic + Registered Retest**

Zypact records what one defined AI surface returned under documented conditions, preserves the evidence, shows observed brands, competitors, claims, and sources, registers one intervention hypothesis, and retests under a recorded protocol. It reports observed change, no clear change, or an inconclusive result. It does not promise causal proof, lost sales, or revenue impact.

## Documentation authority

No single document governs every domain. When documents appear to conflict, use the document that owns the relevant decision:

| Document | Authority |
|---|---|
| [`docs/ENGINEER_START_HERE.md`](docs/ENGINEER_START_HERE.md) | Required engineering entry point and reading order |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Approved dated decisions and superseded assumptions |
| [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) | Evidence, sampling, metrics, uncertainty, retest, and claim limits |
| [`docs/V1_SCOPE.md`](docs/V1_SCOPE.md) | Current product scope, workflow, inclusions, and exclusions |
| [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md) | Technical milestones, dependencies, acceptance tests, and estimate format |
| [`docs/PILOT_RUNBOOK.md`](docs/PILOT_RUNBOOK.md) | Founder-led qualification, operation, delivery, and escalation |
| [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md) | Verified repository reality, gaps, and deployment unknowns |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Sequencing, dependencies, dates, and kill gates |

Every engineer starts with [`docs/ENGINEER_START_HERE.md`](docs/ENGINEER_START_HERE.md). This active package is the only documentation included in the engineering handoff.


## Current V1 boundary

- Initial live surface: **Perplexity Sonar**, labeled as a directional proxy.
- External sampling: approved, configurable, and bounded; no fixed three-run client score.
- Paid calls: explicit question/protocol approval, admission control, and reservation before each attempt.
- Evidence: exact provider request/response plus audit metadata, hashes, and database-enforced immutability.
- Reporting: one canonical evidence snapshot across the dashboard, reports, exports, and Outcome Card.
- Retest: preserved question/protocol identity, registered intervention, observation window, and auditable before/after comparison.
- Delivery: automatic only after `integrity_passed`; founder/admin review only for `needs_review`; `blocked` never delivers.
- Claims: observed change only; no causal, revenue, or market-wide claim.

Full multi-model coverage, continuous monitoring, full AI Buyer Journey Intelligence, predictive scoring, CRM integrations, enterprise features, and causal/revenue attribution are outside V1.

## Verified code baseline

The 2026-08-16 static audit found reusable application, database, and worker foundations rather than a greenfield project:

- public landing, request, email-verification, founder approval/rejection, and secure report routes;
- manual live scan orchestration and Perplexity integration;
- crawler, site reader, prompt, evidence, competitor, Gap Map, Fix Brief, report, and delivery code;
- a PostgreSQL-backed worker claim queue with leases, fencing, idempotency, and recovery logic;
- 35 tracked SQL migrations, ending at `0035`;
- 73 `scripts/test-*.ts` files, 24 registered `test:*` commands, 2 registered `verify:*` commands, and 1 GitHub Actions workflow.

The same audit also found that legacy outputs still use fixed three-run settings and `won/partial/lost`, the raw provider response is reconstructed after JSON parsing rather than stored byte-for-byte, report renderers do not yet consume one structured canonical snapshot, and registered retest/uncertainty/Outcome Card behavior is not implemented. See [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md) for the precise inventory.

## Local setup

Run commands from the repository root.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill only the values required for the approved local or staging task. Never commit `.env.local` or secret values.

## Baseline validation

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
```

The exact registered test and verification commands are listed in [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md). M0 must run the safe applicable set and record every command and result; a file count is not test evidence.

## Database authority

The executable schema authority is `supabase/migrations/`. The audited tree contains 35 migrations through `0035_snapshot_report_delivery_fencing.sql`.

This repository audit does not prove the production, preview, or staging migration ledger. M0 must verify each environment before any schema work. Historical schema notes are archived because they stop at older migrations and are not an authoritative current schema inventory.


## Active terminology

Allowed Outcome Card statuses:

- `increase_observed`
- `decrease_observed`
- `no_clear_change`
- `inconclusive`

Prohibited commercial verdicts and claims include `won`, `lost`, `partial`, “lost sale,” “this fix caused the result,” and “this represents all AI buyers.” Legacy code may still contain those terms; their presence is a documented migration target, not permission to show them to customers.

## Change control

1. Work on feature branches through pull requests; no direct changes to `main`.
2. Do not force-push or rewrite published history.
3. Do not modify production without explicit milestone authorization.
4. Preserve unrelated founder/user work.
5. Never commit secrets, environment files, prospect evidence, generated reports, or raw client outputs.
6. Any change to evidence, sampling, scoring, protocol, retest, or report behavior must update the owning canonical document and tests.
7. Product behavior is not implemented merely because it appears in documentation.
8. Contractor prices and negotiations do not belong in canonical product or methodology files.
