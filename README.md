# Zypact

AI visibility diagnostics for B2B SaaS marketing teams. Zypact tests real buyer
questions against AI search and reports where a brand is recommended, where it
is absent, and which competitors appear instead.

## Zypact V1

Zypact is an **AI Buyer Journey Intelligence** product for B2B SaaS companies.
Its job is to reveal which AI-assisted buyer decisions a company is losing,
which competitors enter the shortlist instead, the evidence contained in the
exact AI answers, what to test first, and whether the result changes on retest.

**The V1 promise:** run a controlled scan, see where the brand loses an
AI-assisted buyer decision, inspect the evidence, choose the first fix worth
testing, and retest the same question.

**The controlled V1 workflow:**

```
create account -> company/workspace -> project -> Mirror Profile ->
buyer questions -> approval -> AI runs -> raw evidence -> competitors ->
gaps -> controlled fix -> same-question retest -> before/after ->
founder-reviewed report
```

V1 is controlled and founder-reviewed. It is **not** continuous monitoring and
**not** predictive — those are V2 and V3. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

### Implementation status

Graded against repository evidence, not intent. Full inventory in
[`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md).

| Area | Status |
| --- | --- |
| Live Perplexity Sonar probe path, three runs per question, raw evidence stored | Implemented |
| Pipeline: Mirror Profile, prompts, probe analysis, competitors, Gap Map, Evidence Bank, Fix Brief, QA | Implemented |
| Report renderers, fenced report replacement, fenced delivery, founder review before delivery | Implemented |
| Account, projects, per-artifact project pages | Implemented |
| Company/workspace entity, onboarding, project dashboard | Missing |
| **Same-question retest and before/after** | **Missing** — no implementation in any layer |
| Buyer-journey stage metadata | Missing |
| Running a controlled scan without a terminal | Not possible today — operator-only |
| Cross-surface agreement between raw rows, aggregates, UI, short report, full report | Unverified |

The live snapshot path uses **Perplexity Sonar only**. Do not describe the
product as testing ChatGPT, Gemini, or Claude.

> **An engineering audit is required before any pricing decision or production
> change.** The scope, the known P0 integrity issues, and the required audit
> deliverables are in
> [`docs/Zypact_V1_Engineering_Audit_Brief.md`](docs/Zypact_V1_Engineering_Audit_Brief.md).
> Known issues include competitor contamination, inconsistent competitor counts
> across surfaces, alias duplication, over-broad Gap Maps, and renderer
> inconsistency. Until those are reproduced and classified, client-facing
> numbers are not defensible.

## Getting started

Run all commands from the repository root.

```bash
npm install
cp .env.example .env.local   # then fill in the values you need locally
npm run dev
```

## Validation

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
```

Targeted suites are registered in `package.json` under `test:*`, for example:

```bash
npm run test:snapshot-adapter-rpc-writes
npm run test:snapshot-worker-dml-revocation-contract
npm run test:snapshot-artifact-cascade-contract
```

The PostgreSQL Level 2 concurrency harness runs in CI against a disposable
PostgreSQL service container. It is triggered by changes to
`supabase/migrations/**`, the harness script, or its workflow file.

## Documentation

| Document | Contents |
| --- | --- |
| `DATABASE_SCHEMA.md` | Tables, columns, constraints, and the snapshot-report RPC surface |
| `docs/PR8_PRODUCTION_ROLLOUT.md` | Record of the RPC-only snapshot-report rollout |
| `docs/MVP_VALIDATION_REPORT.md` | Internal validation history |
| `docs/MVP-OPERATOR-RUNBOOK.md` | Operator procedures |
| [`MVP_SCOPE.md`](MVP_SCOPE.md), `AGENT_PIPELINE.md` | Original sprint scope (superseded by the V1 brief) and pipeline design |
| [`docs/Zypact_V1_Engineering_Audit_Brief.md`](docs/Zypact_V1_Engineering_Audit_Brief.md) | Approved V1 scope and engineering audit brief |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | V1 / V2 / V3 boundaries |
| [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md) | Implementation status graded against repository evidence |
| [`docs/ENGINEERING_ESTIMATE_REQUEST.md`](docs/ENGINEERING_ESTIMATE_REQUEST.md) | What the engineer must deliver before an estimate |

## Database

Production and Preview are both at migration `0035`. Snapshot report writes go
through approved `SECURITY DEFINER` RPCs only — direct table writes to
`snapshot_requests` and `snapshot_report_artifacts` are revoked. See
`DATABASE_SCHEMA.md` for the full contract.
