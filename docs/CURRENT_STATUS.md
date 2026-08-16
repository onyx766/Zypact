# Zypact Current Status

- **Status:** Canonical repository-state record
- **As of:** 2026-08-16
- **Official repository baseline audited:** `ZypactHQ/zypact-clean-mvp` at `b339d42a28014d8436c180a7da0cb0ad876178b8`
- **Audit type:** Static tracked-tree inspection plus founder-supplied private execution evidence
- **Not established by this audit:** Production, preview, staging, or worker deployment state

## 1. Reading rule

This file distinguishes repository facts from deployment facts and planned V1 behavior.

| Label | Meaning |
|---|---|
| **Verified in code** | Directly observed in the audited tracked tree |
| **Demonstrated privately** | Supported by founder-supplied terminal output or private artifacts; the evidence is intentionally not committed |
| **Partial** | A reusable path exists but does not satisfy the canonical V1 contract |
| **Missing** | No implementation matching the requirement was found in the audited tree |
| **Deployment unknown** | Repository code exists, but operation in a managed environment was not verified |
| **Legacy unsafe** | Existing behavior is retained in code/history but cannot be used for new external claims under the canonical methodology |

Documentation is not implementation. An engineer must re-fetch the official repository, identify the actual base, and update this inventory during M0.

## 2. Executive status

Zypact is not a greenfield build. The repository contains a real Next.js application, PostgreSQL/Supabase persistence, a manual live-scan path, a database-backed worker with concurrency protections, analysis stages, reports, and secured founder delivery.

The paid-pilot V1 is nevertheless incomplete. The highest-risk gaps are not landing-page polish: they are exact immutable evidence, one canonical reporting contract, replacement of legacy score semantics, approved bounded sampling with reservation before each paid attempt, a customer-operable workflow, integrity-gated delivery, and registered retest with uncertainty.

Legacy client reports remain frozen for new external use until they are individually reconciled or the new integrity contract is implemented.

## 3. Audited repository inventory

| Item | Verified value at the audited commit |
|---|---|
| Framework | Next.js `14.2.5`, React `18.3.1`, TypeScript |
| SQL migrations | 35 files, `0001` through `0035_snapshot_report_delivery_fencing.sql` |
| Test source files | 73 files matching `scripts/test-*.ts` |
| Registered test commands | 24 `test:*` scripts in `package.json` |
| Registered verification commands | 2 `verify:*` scripts in `package.json` |
| GitHub Actions workflows | 1 tracked workflow |
| Primary database adapter | Supabase/PostgreSQL adapter plus a legacy memory adapter |
| Initial provider path | Perplexity Sonar |
| Long-running execution code | Snapshot worker, database claim queue, leases, fencing, and recovery |

The number 73 describes files, not 73 independently registered commands. The repository does not support a statement that “76 test scripts passed” without an exact command log.

## 4. Working and reusable foundations

### 4.1 Public and founder request flow — verified in code

The audited application contains:

- landing, request, email-verification, thank-you, login, and auth callback routes;
- public snapshot request creation and email verification;
- founder/admin request list and request detail;
- founder approve and reject routes;
- secure-token report rendering;
- fenced report-artifact replacement and send routes;
- request limits and status transitions.

This is a founder-controlled snapshot flow, not yet the canonical customer question/protocol approval workflow.

### 4.2 Analysis pipeline — verified in code; legacy semantics remain

Reusable stages exist for:

- site crawling and reading;
- Mirror Profile generation;
- buyer-prompt generation/selection;
- live or simulated probe execution;
- probe analysis;
- Evidence Bank generation;
- competitor discovery;
- Gap Map generation;
- Fix Brief and asset generation;
- QA;
- full and short reports;
- exports and client packages.

A founder-supplied private execution demonstrated that the manual terminal runner can complete live Perplexity calls and persist results. Prospect names, questions, raw responses, and generated reports are not reproduced here.

The active implementation still uses legacy `won`, `partial`, and `lost` verdicts in schemas, prompts, pages, aggregation, Gap Map/Fix Brief logic, and reports. Those paths are migration inputs, not approved external V1 semantics.

### 4.3 Worker and concurrency controls — verified in code; deployment unknown

The worker is not merely a future idea. The audited tree includes:

- `scripts/snapshot-worker.ts` as the process entry point;
- `lib/snapshot-worker/worker.ts` for the claim loop and recovery behavior;
- `lib/snapshot-worker/execution-options.ts` for fail-closed request resolution;
- `lib/snapshot-engine/run-approved-snapshot.ts` for reusable execution;
- claim, lease renewal, attempt limits, fencing tokens, idempotent completion, DML revocation, and delivery-fencing migrations/tests.

The database claim RPC acts as the queue. Existing code prevents two workers from owning the same active claim and provides bounded reclaim behavior. This should be evaluated and reused rather than assumed absent.

What remains unknown is the operating environment: process manager/container, restart policy, health endpoint, metrics, alerting, queue-age monitoring, cost monitoring, deployment ownership, and incident recovery have not been verified in a Zypact-controlled live environment.

### 4.4 Founder delivery fencing — verified in code; not the new integrity model

Current report delivery uses `report_ready`, secure tokens, insert-only/fenced artifact operations, and idempotent send protections. This is valuable infrastructure.

`report_ready` does not implement the canonical `integrity_passed`, `needs_review`, and `blocked` decision contract. Delivery is founder-triggered, not automatic after a machine-enforced integrity pass.

## 5. Trust gaps

### 5.1 Exact raw evidence — partial

Current schema/adapter fields include `raw_response` and `raw_probe_request`, but the provider implementation does not yet meet the canonical evidence contract:

- the Perplexity response is parsed with `res.json()`;
- `raw_response` is then reconstructed from answer text, citations, and search results;
- `raw_probe_request` stores the buyer prompt, not the complete outbound HTTP body;
- no per-attempt SHA-256 of exact request/response bytes was found;
- HTTP status, latency, provider request ID, usage, full failure body/metadata, and retry relationship are not preserved as one complete attempt record;
- database-enforced immutability of the raw evidence fields was not found.

Therefore current stored content may be useful evidence, but it is not a byte-identical, tamper-evident provider transcript.

### 5.2 Sampling and paid-call control — partial and legacy unsafe

The worker execution resolver currently fixes:

- 5 requested prompts;
- 3 runs per selected prompt;
- `WORKER_BUDGET_USD = 2`, an estimated provider-cost guard—not an engineering budget or a measured spend cap.

The code comments correctly state that this budget is a projected-cost admission guard, not a measured spend circuit breaker. The audited tree does not show:

- an approved versioned sample plan per question/protocol;
- variable external run counts without a hidden three-run fallback;
- reservation immediately before every provider attempt;
- per-attempt cost reconciliation after terminal outcomes;
- a complete operator-configured run/spend/rate/concurrency policy tied to the approved protocol.

Project reservation and worker claim fencing are not substitutes for per-paid-attempt reservation.

### 5.3 Approval identity — partial

Founder approval of a snapshot request and competitor frame exists. The audited tree does not implement a customer-visible, immutable question version plus protocol version approved before every paid probe sequence.

### 5.4 Canonical figures — partial and legacy unsafe

The full report is assembled from database-derived summaries, while the short report is derived by parsing generated Markdown. The dashboard/pages and report formats do not yet consume one shared structured canonical evidence snapshot.

Consequences include avoidable disagreement risk across:

- database rows;
- project pages;
- short report;
- full report;
- export/client package;
- future Outcome Card.

The canonical V1 requires one versioned aggregation contract and integrity tests across every renderer.

### 5.5 Competitor and Gap Map integrity — partial

The code contains useful protections:

- competitor-frame validation;
- some audited-brand and platform-name filtering;
- prompt-scoped scorecard competitor helpers;
- Gap Map grounding that uses prompt evidence for eligible legacy groups.

The audited tree does not yet provide the complete required contract:

- deterministic, versioned, reversible alias/entity resolution;
- brand-self exclusion enforced at every ingestion/aggregation boundary;
- one canonical supporting-run map for every prompt-scoped competitor, claim, gap, and intervention;
- safe handling of unresolved entities and mixed results under the new methodology.

### 5.6 Client claims and report gates — legacy unsafe

Legacy pages and reports still contain language such as “buyer questions won or lost,” “lost moments,” and `won/partial/lost` scorecards. The current report builder does not enforce all canonical surface, uncertainty, causality, denominator, entity, and evidence-hash gates.

Existing `needs_evidence` behavior for some Fix Brief/assets is not the same as the report-level `needs_review` state.

## 6. Missing paid-pilot V1 capabilities

No complete implementation matching these requirements was found at the audited commit:

1. stable buyer-question and protocol identities with immutable versions;
2. explicit customer question/protocol approval before paid execution;
3. configurable bounded sampling and uncertainty-aware interpretation;
4. per-paid-attempt reservation and cost reconciliation;
5. one basic project dashboard route that represents the entire canonical workflow;
6. registered intervention record with implementation evidence;
7. observation-window eligibility and scheduling;
8. same-question registered retest;
9. comparison engine and Outcome Card using only approved statuses;
10. automatic delivery after `integrity_passed` with exception-only review;
11. deployed worker health, monitoring, alerting, and operator recovery demonstration.

Project-specific pages exist under `app/projects/[id]/`, but no `app/projects/[id]/page.tsx` project dashboard was found.

## 7. Test-command inventory

### Baseline compile/build

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
```

### Registered `test:*` commands

```bash
npm run test:mirror
npm run test:prompts
npm run test:probe
npm run test:competitors
npm run test:gap-map
npm run test:evidence
npm run test:fix-brief
npm run test:assets
npm run test:qa
npm run test:full-pipeline
npm run test:auth
npm run test:export
npm run test:export-route
npm run test:pipeline-integrity
npm run test:mvp-scan
npm run test:prompt-cardinality
npm run test:db-adapter-selection
npm run test:snapshot-send-idempotency
npm run test:snapshot-worker-claim
npm run test:snapshot-worker-migration-contract
npm run test:snapshot-worker-fencing-migration-contract
npm run test:snapshot-worker-dml-revocation-contract
npm run test:snapshot-adapter-rpc-writes
npm run test:snapshot-artifact-cascade-contract
```

### Registered `verify:*` commands

```bash
npm run verify:anon-hardened
npm run verify:export-readonly-live
```

These commands are an inventory, not a claim that they all pass in every environment. M0 must:

1. identify credential, database, Docker, network, or production dependencies;
2. run every safe applicable command against approved resources;
3. explain every skipped or failed command;
4. inventory unregistered `scripts/test-*.ts` files and their intended harness;
5. include all existing and new milestone tests in acceptance evidence.

## 8. Security and dependency status

- Next.js is pinned to `14.2.5`; whether it is affected by a relevant current advisory must be verified against authoritative advisories during M0.
- Server-side secret boundaries and Supabase DML/RPC restrictions have substantial existing tests, but the full tenant model for the new workflow does not exist yet.
- No active self-serve Stripe checkout was found in the audited application route tree. Billing is not a prerequisite for the trust layer.
- `output/` is already ignored by `.gitignore`; generated evidence and reports must remain outside source control.

## 9. Deployment unknowns

This tracked-tree audit does not establish:

- which commit is live on Vercel or any worker host;
- production, preview, or staging environment-variable completeness;
- production and preview migration ledgers;
- whether the worker is deployed and continuously supervised;
- DNS, email delivery, provider, monitoring, or alert health;
- backup/restore readiness;
- actual production cost and rate-limit configuration.

Do not convert a repository capability into a production claim until M0 captures environment-specific evidence.

## 10. Safe operating status

- **Founder Institute demo:** use a non-confidential, founder-audited manual/terminal flow; disclose what is manual and what remains planned.
- **New free company score:** do not offer a fixed three-run visibility score.
- **Legacy short/full reports:** do not send as new sales assets without case-specific reconciliation and safe labeling.
- **Paid pilot sales:** may continue as a transparent founder-operated offer, subject to lawful contracting/payment authority and no promise that unfinished automation already exists.
- **Category benchmark:** planned acquisition experiment, not yet a shipped feature.
- **Production code mutation:** requires an approved milestone, branch/PR, staging evidence, and explicit authorization.

## 11. Immediate engineering action

M0 must update this file with:

- actual base branch and hash;
- environment/deployment topology;
- migration ledger by environment;
- exact command-by-command test results;
- dependency/security findings;
- data flow from approval through provider attempt, canonical snapshot, delivery, and retest;
- code references for every `working`, `partial`, `missing`, `unsafe`, or `unknown` classification;
- reuse/refactor/replace recommendation for the current worker and report pipeline;
- revised milestones, dependencies, operating costs, exclusions, schedule, and warranty.
