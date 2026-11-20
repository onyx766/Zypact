# Zypact Current Status

- **Status:** Canonical repository-state record
- **As of:** 2026-08-16
- **Official repository baseline audited:** `ZypactHQ/zypact-clean-mvp` at `b339d42a28014d8436c180a7da0cb0ad876178b8`
- **Audit type:** Static tracked-tree inspection plus founder-supplied private execution evidence
- **Not established by this audit:** Production, preview, staging, or worker deployment state

> **Precedence notice — read this before using any figure below.**
>
> - **Current state as of:** 2026-08-26
> - **`main` at:** `c962734c2048da35e79c0ab40a8b90e9946cbeda`
> - **Validated head:** `3fc52856d34ccdac0b0a7c02d1b766624e3936bc`
> - **Shared tree:** `042e87006aec88462377c660ce1b2994187603d0` — identical for both commits above, so the merge into `main` added no content of its own
>
> Sections 1-12 are preserved historical snapshots, taken on 2026-08-16 and 2026-08-21. They are deliberately not rewritten, and several of their figures are now superseded. For any statement about the *current* repository, section 15 prevails, then section 13.
>
> **2026-11-18:** sections 16 to 39 were added after this notice. Each is dated and records one branch or step. For the repository inventory (migrations, `scripts/test-*.ts` files and registered commands), the latest measured figures are section 39's, and [`CLAUDE.md`](../CLAUDE.md) points there.

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

- **New free company score:** do not offer a fixed three-run visibility score.
- **Legacy short/full reports:** do not send as new sales assets without case-specific reconciliation and safe labeling.
- **Paid pilot sales:** may continue as a transparent founder-operated offer with no promise that unfinished automation already exists.
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

## 12. M5 — protocol execution worker: SQL/runtime foundation validated locally (not full M5 completion)

- **As of:** 2026-08-21
- **Scope of this entry:** migrations `0050_m5_protocol_execution_jobs_and_external_call_ledger.sql` and `0051_m5_protocol_worker_resumption_and_retry_safety.sql`, plus D-020/D-021/D-022 (see `docs/DECISIONS.md`). This entry does not update or supersede sections 1-11 above, which remain the 2026-08-16 audited baseline.

**What is validated, locally only:**

- Migrations `0050` and `0051` apply sequentially, cleanly, in full, on a genuinely disposable local PostgreSQL/Supabase stack (`supabase init`/`start` under a fresh `mktemp` workdir) — never against any staging or Production database, never against any long-lived local instance.
- Static (text-only, no database) contract tests: `scripts/test-m5-0050-schema-contract.ts` — **173/173** checks passed. `scripts/test-m5-0051-schema-contract.ts` — **70/70** checks passed.
- Real runtime contract test `scripts/test-m5-0051-runtime-contract.ts` (opt-in, disposable stack, real RPC calls over real `psql` connections): **70/70** checks passed, on one single fresh execution, with no retry.
- D-020 was already committed prior to this M5-0051 tranche. D-021 and D-022 (D-022 is an append-only amendment correcting D-021's transactional ordering and two invalid scalar-subquery expressions, found by the runtime test above) are present in the local, uncommitted changeset as of this entry — not yet committed.
- Runtime-validated behaviors: worker-resumption idempotence (`RESUME_CURRENT_ATTEMPT`, never a second admission from a stale key); genuine two-process OS-level concurrency on both `authorize_operator_retry` (identical key/fingerprint racing the same job) and `retry_full_attempt_for_job` (same source attempt racing the same job) — both races resolve to exactly one durable effect, never a duplicate; the two structurally separated automatic retry paths (`retry_full_attempt_for_job` / `retry_analysis_generation_for_job`), each idempotent-replay-safe; a real, reproducible server-side SHA-256 request fingerprint (via `_sha256_hex`, pgcrypto schema resolved dynamically, matching the precedent already established by migration `0035`); ACL/RLS surface (M4 raw RPCs, the newly revoked `reserve_additional_analysis_generation_for_job`, and the `protocol_execution_job_monitoring_v1` monitoring view — `service_role`-only, denied to `anon`/`authenticated`); atomic fault-injected rollback of `create_probe_run_and_start_attempt_for_job`; and a dedicated defensive scenario proving `SOURCE_NOT_AUTHORITATIVE_GENERATION` still fires correctly against a valid, constraint-respecting pre-D-021-style historical state (an older analysis generation with no `retry_of_external_call_id` link, coexisting with a strictly newer generation).
- `zypact-postgres` (the developer's separate, pre-existing local Postgres container, Compose project `zweb-zpact`) was confirmed strictly unchanged throughout every phase of this work — same container ID, `StartedAt`, restart count, health status, ports, network, and mounts, verified before and after every disposable-stack run.
- No migration `0052` exists anywhere in the repository. The cutover migration that will revoke the M4 raw RPCs (`admit_and_reserve_attempt`, `start_attempt`, `reconcile_attempt`) from `service_role` is deliberately not yet created; those three RPCs remain intentionally, temporarily granted to `service_role` until that future cutover migration ships, per D-021's documented rollout sequencing.
- No staging or Production database was touched at any point. No provider or LLM call of any kind occurred.
- `npm run typecheck`: exactly one error, pre-existing and unrelated to this tranche — `scripts/verify-anon-hardened.ts(104,16): error TS2393: Duplicate function implementation.` This file was not touched by this work and predates it.
- `package.json` and `package-lock.json` are out of scope for this tranche; both carry pre-existing local modifications unrelated to M5-0050/0051 and were not touched by this work.

**What this entry does NOT claim:** this is the **SQL/runtime foundation for M5, validated locally** — not "M5 entirely complete." Still to be built and validated separately: the M5 worker process itself (TypeScript claim/execute loop), its provider/analysis adapters, real end-to-end provider integration, and the future cutover migration that finally revokes the M4 raw RPCs from `service_role`. No fallback to the legacy MVP pipeline, M7/M8, or `lib/snapshot-worker/` exists or is introduced by this tranche; the M5 protocol-execution ledger remains structurally separate from that legacy system.

## 13. Post-PR #12 canonical repository status

- **As of:** 2026-08-26
- **`main` at:** `c962734c2048da35e79c0ab40a8b90e9946cbeda`
- **Validated head:** `3fc52856d34ccdac0b0a7c02d1b766624e3936bc`
- **Shared tree:** `042e87006aec88462377c660ce1b2994187603d0`
- **Scope of this entry:** current repository inventory and the validation evidence that accompanied PR #12. This section supersedes the inventory figures in sections 3, 7 and 12 for current-state purposes; it does not rewrite them.

PR #12 merged the cumulative M1-M5 **technical tranches** into `main` by merge commit, preserving all 44 commits. The merge commit and the validated head share the tree above, so every figure below was measured on exactly the code that was validated.

### 13.1 Measured inventory

Measured mechanically from tree `042e87006aec88462377c660ce1b2994187603d0`, not carried over from earlier sections.

| Item | Current value |
|---|---|
| Framework | Next.js `15.5.21`, React `19.2.8`, React DOM `19.2.8`, TypeScript `5.5.3` |
| SQL migrations | 54 files, `0001_init.sql` through `0054_m5_worker_probe_result_and_alert_outbox.sql` |
| Migration continuity | `0001`-`0054` complete: 54 unique numbers, no gap, no `0055` |
| Test source files | 115 files matching `scripts/test-*.ts` |
| Verification source files | 4 files matching `scripts/verify-*.ts` |
| Registered test commands | 24 `test:*` scripts in `package.json` |
| Registered verification commands | 2 `verify:*` scripts in `package.json` |
| GitHub Actions workflows | 1 tracked workflow (`.github/workflows/snapshot-worker-postgres-level2.yml`) |

Superseded figures: section 3 records Next.js `14.2.5` / React `18.3.1`, 35 migrations through `0035`, and 73 `scripts/test-*.ts` files. Those were accurate at commit `b339d42a…` on 2026-08-16 and are no longer the current state.

### 13.2 M5 migrations now present

| Migration | Subject |
|---|---|
| `0050_m5_protocol_execution_jobs_and_external_call_ledger.sql` | Execution-job and external-call ledger |
| `0051_m5_protocol_worker_resumption_and_retry_safety.sql` | Worker resumption and retry safety |
| `0052_m5_durable_call_payloads_and_probe_result_replay.sql` | Durable call payloads and replay-safe probe results |
| `0053_m5_analysis_parse_failure_and_raw_request_body.sql` | Analysis parse-failure ledger and raw request body |
| `0054_m5_worker_probe_result_and_alert_outbox.sql` | Worker probe result and alert outbox |

Section 12 states that no migration `0052` exists anywhere in the repository. That was true on 2026-08-21 and is superseded: `0052`, `0053` and `0054` are present in `main`.

### 13.3 Validation matrix

| Contract | Result |
|---|---:|
| Typecheck | PASS |
| Schema contract 0050 | 173/173 |
| Schema contract 0051 | 109/109 |
| Schema contract 0052 | 59/59 |
| Schema contract 0053 | 66/66 |
| Schema contract 0054 | 143/143 |
| Content contract 0054 | 34/34 |
| M5-2 adapter contract | 163/163 |
| D-027 call-model contract | 88/88 |
| D-027 parse-analysis contract | 14/14 |
| Runtime 0050 | 34/34, exit 0, no SKIP |
| Runtime 0051 | 106/106, exit 0, no SKIP |
| Runtime 0052 | 86/86, exit 0, no SKIP |
| Runtime 0053 | 90/90, exit 0, no SKIP |
| Runtime 0054 Run 15 | 39/39 scenarios, 62/62 checks, exit 0 |
| GitHub PostgreSQL Level 2 (CI) | 223 passed, 0 failed |

Each runtime figure is backed by a distinct frozen Canonical V2 evidence archive held outside the repository. The 0054 figure is specifically supported by Run 15; the earlier 0054 archives remain preserved. Each archive records the exact harness executed, the migration under test, the terminal output, the true harness exit code and the post-run identity of the protected local container. The `0051` figure supersedes the `70/70` recorded in section 12: the harness has since grown.

The CI figure comes from workflow run `32934943786`, which applied all 54 migrations to a disposable PostgreSQL 16 service container built from GitHub's synthetic merge of `6492adaa…` and `3fc52856…`. It used no repository secret, contacted no remote database or provider, and deployed nothing.

Deliberately not used as a release gate: the legacy full `test-probe-analysis` smoke path, because it crawls `linear.app` and selects a database adapter. Its D-027 bounded-error preflight did pass.

### 13.4 What is established, and what is not

**Established — SQL/RPC/adapter foundations.** Migrations `0036`-`0054` apply cleanly in sequence. Their RPCs, constraints, ACL surface, fencing, retry bounds, replay-safety and monitoring views are covered by schema contracts and by real runtime contracts executed against disposable local PostgreSQL stacks. The M1-M5 technical tranches are integrated into `main`.

**Not established — the M5 worker as a running system.** The real M5 worker process (a long-running TypeScript claim/execute loop), provider execution through that worker, alert dispatch and supervised deployment are outside what PR #12 delivered. Nothing in this section should be read as evidence that they exist or operate. This is a statement about the M5 worker path only: the repository has carried legacy and manual provider paths since well before this work, and they are unaffected.

**Not established — product milestone completion.** Integration of the M1-M5 *technical tranches* is not acceptance of the M1-M5 *milestones*. Each milestone's acceptance criteria in [`ENGINEERING_PLAN.md`](ENGINEERING_PLAN.md) must be audited individually before any milestone is declared complete. No milestone is marked complete by this section.

**Still open — the M4 raw-RPC cutover.** The migration that revokes the three raw M4 RPCs (`admit_and_reserve_attempt`, `start_attempt`, `reconcile_attempt`) from `service_role` has not shipped. A search of all 54 migrations in `main` finds no `REVOKE` targeting those three functions. Section 12 attributed this future work to a then-nonexistent `0052`; `0052` now exists and did not perform the cutover, so the cutover remains pending and absent from `main`.

**Still unknown — environment state.** Production, preview, and staging environment states, together with worker deployment state, remain unverified by this entry, exactly as stated in sections 1 and 9. Repository content proves nothing about any deployed environment. Any future environment-specific schema work must verify the target environment independently before execution.

### 13.5 Superseded local-workstation notes

Section 12 records that `package.json` and `package-lock.json` carried pre-existing local modifications, and that `npm run typecheck` produced exactly one error in `scripts/verify-anon-hardened.ts`. Both were observations of a developer workstation at that date, not facts about the canonical tree. Typecheck passes on the validated head, and PR #12 introduced no effective `package.json`, `package-lock.json`, `tsconfig.json` or `next.config` change relative to `main`.

## 14. M5 Phase 3C — empty-queue live smoke on staging (demonstrated privately)

**Label:** Demonstrated privately. The evidence is founder-supplied terminal output; nothing from the run is committed as raw evidence.

On 2026-08-31, the successful `v6` harness run switched staging Machine `e826322a695098` from `disabled` to `live`, started it once, observed the worker on an empty queue, stopped it once, and restored the Machine to `disabled/stopped` on the baseline configuration. No job was enqueued and no provider call was made.

- Supabase staging project: `bfqpkfqsonixdnfiodwk`
- image digest: `sha256:51a1a20f20692c4c60f07552ae7753254c8e5f0c973534f66f1a23adecf630e6`
- worker source commit: `16a85cba0f9765b6864ca52f8d50dc47bb47a8aa`
- harness: `zypact_phase3c_manual_smoke_v6.sh`
- harness SHA-256: `c5fbc17088a1a04005570d6e22c8d02f495b8ec3e54737e3acb6165f957444e0` (kept outside the repository)
- exit code: `0`

```text
FLY=STOPPED_DISABLED_BASELINE_RESTORED
DATABASE=UNCHANGED_EMPTY_QUEUE
OBSERVATION=READINESS_WORKER_STARTED_IDLE_PROOF_ITERATIONS_ZERO_WORKER_STOPPED
M5_B3_PHASE_3C_EMPTY_QUEUE_LIVE_SMOKE_COMPLETE_RETURNED_DISABLED_STOPPED
```

This entry records only the successful `v6` validation. Earlier harness revisions produced diagnostic, fail-closed results and are not counted as successful Phase 3C evidence.

## 15. `fix/v1-customer-flow` — unmerged branch status

- **As of:** 2026-09-15
- **`main` at:** `6a50b976293c9b49a610ad686bacb3dc8b85fae3`
- **Branch head:** `91ff9545a4498db3f3dfe4a41ef33589ee71ad67` (`fix/v1-customer-flow`)
- **Scope of this entry:** what exists on the unmerged branch, and what remains
  unverified about it. This section supersedes section 13's inventory figures
  for current-state purposes; it does not rewrite them.

### 15.1 The branch is not `main`, and none of it is deployed

> **Superseded on 2026-09-16 — see 15.7.** Both claims in this subsection are
> now false: the branch was merged to `main` by PR #40, and eight of the nine
> migrations are applied to the staging database. The original text is kept
> below unrewritten, because what it got wrong is itself the finding.

The V1 customer flow — public demo request, founder approval, protocol
baseline execution, client report rendering and delivery — exists **only on
this branch**. It is 11 commits and 102 changed files ahead of `main`, and it
adds nine migrations, `0061` through `0069`.

**No migration in `0061`–`0069` has been applied to any environment.** No
staging demonstration has been performed for this branch. Any statement that
"the baseline workflow is live" must name the exact path that served it,
because it is not this branch running on `main`.

Section 13.4's finding still stands unchanged: the M5 worker **as a running
system** is not established. Section 14 records the only deployed-worker
evidence there is — a single empty-queue staging smoke on 2026-08-31, which
explicitly does not establish job claiming, provider execution, receipt
durability, anti-double-payment behaviour or recovery.

### 15.2 Measured inventory

| Item | Current value on the branch head |
|---|---|
| SQL migrations | 69 files, `0001_init.sql` through `0069_new_baseline_default_five_runs.sql` |
| Migration continuity | `0001`-`0069` complete, no gap |
| Registered test commands | 57 `test:*` and `verify:*` scripts in `package.json` |

Section 13.1's figures (54 migrations, 24 registered `test:*`, 2 `verify:*`)
were accurate at tree `042e8700…` and are superseded here.

### 15.3 Migrations 0061-0069 are now audited

They were not audited when the branch was written. A full read-only audit is
recorded in [`MIGRATION_AUDIT_0061_0069.md`](MIGRATION_AUDIT_0061_0069.md).

Verdict: all nine are additive, privilege-hardened and carry rollback notes;
nothing found blocks applying them to staging. Nine findings are recorded, of
which one was fixed in that pass (`blocked` artifacts were deliverable through
the send-report API because the gate existed only in admin React components),
one is a deployment precondition (`0064` requires PostgreSQL 16+), and one
becomes a real defect precisely when M7 lands (`resolve_protocol_job_review`
excludes attempts across the whole protocol rather than the job, which
corrupts a retest denominator as soon as a protocol has two jobs).

The audit also records that `approve_and_launch_snapshot_baseline` is defined
three times across `0062`, `0063` and `0069`, and that **only `0069` is
authoritative**.

### 15.4 Registered-command results are not all green

Measured on the branch head, on Windows, offline:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `test:seo` | PASS |
| `test:protocol-report` | PASS |
| `test:protocol-integrity` | PASS |
| `test:m0-0057-schema` | PASS |
| `test:snapshot-worker-migration-contract` | PASS |
| `test:snapshot-worker-dml-revocation-contract` | PASS |
| `test:snapshot-artifact-cascade-contract` | PASS |
| `test:m5-0056-schema` | PASS (71/71) after renormalisation |
| `test:m5-0059-schema` | PASS (127/127) after renormalisation |
| `test:m5-0060-schema` | PASS (183/183) after renormalisation and one fix |
| `test:snapshot-send-idempotency` | **FAIL — 6 passed, 18 failed** |

`test:snapshot-send-idempotency` is a pre-existing failure unrelated to this
branch: it exercises a send-report contract that predates delivery fencing and
sends no `expectedArtifactId`/`expectedRevision`, so every failure is
`400 invalid_expected_artifact_id`. It is one of the commands section 7 lists
as the registered inventory. It should be rewritten against the fenced
contract or retired; until then it is not coverage.

**The remaining 45 registered commands were deliberately not run.** Real
`PERPLEXITY_API_KEY` and `OPENAI_API_KEY` values are present in the local
environment, and a mechanical scan could not reliably separate the scripts
that issue a paid provider call or contact a database from those that do not.
Running them blind risks unapproved spend. Classifying every script and
running the safe set against approved staging resources remains M0 work, and
this table must not be read as a suite pass.

### 15.5 Windows checkouts produced false test failures

`core.autocrlf` is `true` and the repository carried no `.gitattributes`, so
every text file materialised with CRLF on Windows while several contract tests
pin SHA-256 digests computed over LF. `test:m5-0059-schema` scored 111/127 for
that reason alone — a false failure that masks real ones on the machine where
the work is actually done.

A `.gitattributes` forcing `eol=lf` is added on this branch. **Existing
working copies still need `git add --renormalize .` run once, committed on its
own**, because a `.gitattributes` does not rewrite files already checked out.

Two POSIX-separator path assertions and one obsolete "no migration above 0060
exists" assertion were also fixed; see the audit's section 5.

### 15.6 Still absent — M7 in its entirety

No migration in `0001`-`0069` mentions an intervention record, an observation
window, or any outcome status. The schema carries the *hooks* for retest and
nothing more:

- `protocols.baseline_protocol_id` (self-FK, `0047`);
- `protocols.planned_retest_runs`, which `0062`/`0069` set to `0`;
- `protocol_attempts.attempt_kind in ('baseline','retest','control','paraphrase')`.

Two further facts bound the work:

- `0050`'s own header states the durable execution job exists at
  baseline granularity and **"jamais le retest — M7"**. A retest therefore
  needs its own job path, not merely a new `attempt_kind` value.
- No code path can create a retest protocol. The only `insert into
  public.protocols` in the entire ledger is
  `approve_and_launch_snapshot_baseline`, and `protocols` has had every table
  privilege revoked since `0047`.

Item 6-9 of section 6 remain open exactly as written.

## 15.7 Observed staging migration state — corrects 15.1

- **As of:** 2026-09-16
- **Method:** direct read-only probe of the staging database through the
  Supabase SQL editor (`information_schema.columns`, `pg_proc`,
  `pg_get_functiondef`). No write was issued.
- **Environment:** staging, confirmed by the operator.

**Section 15.1 is wrong on both of its claims.** They were true when written on
2026-09-15 and are recorded here as superseded rather than deleted.

1. **The branch is merged.** PR #40 merged `fix/v1-customer-flow` into `main`
   at `589483c`. Section 15's title and 15.1's first claim both predate that.
2. **Eight of the nine migrations are applied to staging.** 15.1 states that no
   migration in `0061`–`0069` has been applied to any environment.

| Migration | Staging | Evidence used |
|---|---|---|
| `0061` | applied | `snapshot_requests.contact_name` present |
| `0062` | applied | `approve_and_launch_snapshot_baseline` exists |
| `0063` | applied | its body contains `paraphrase_plan` |
| `0064` | **unknown** | data-only backfill, no schema marker |
| `0065` | applied | `snapshot_report_artifacts.report_payload` present |
| `0066` | applied | `resolve_protocol_job_review` exists |
| `0067` | applied | `protocol_execution_jobs.prior_needs_review_reason` present |
| `0068` | applied | `snapshot_report_artifacts.integrity_status` present |
| `0069` | applied 2026-09-16 | see below |

**`0069` apply, 2026-09-16.** Applied by the operator through the Supabase SQL
editor against `zypact-staging`, wrapped in an explicit transaction, and
verified immediately afterwards by re-reading `pg_proc`:

| Verified property | Result |
|---|---|
| Overloads of `approve_and_launch_snapshot_baseline` | exactly 1 |
| Signature | `(uuid, uuid, jsonb, text)` |
| Body carries `D-032` (the five-run default) | true |
| Body still carries `paraphrase_plan` (0063's fix) | true |
| `execute` grants to `service_role` | 1 |

The single-overload result matters: `create or replace` with a differing
argument list would have created a second function rather than replacing the
first, leaving the application free to resolve to either. It did not.

An earlier probe in the same session reported `0062` as absent. That was a
faulty query — it asserted the signature as `(uuid,uuid,text[],text)` when the
competitors parameter is `jsonb`. `0062` is applied. Recorded here because the
same mistake would, if acted on, have overwritten the live function with the
oldest of its three bodies.

**Not established by this probe:** when each migration was applied, by whom,
through what tooling, or whether the Supabase CLI ledger
(`supabase_migrations.schema_migrations`) records them. Production state was
not probed and remains unknown. No runtime contract has been executed against
staging, so this establishes schema presence only — never that any RPC behaves
correctly.

**Consequence for `0069`.** It is the only outstanding migration, and it is the
only authoritative body of `approve_and_launch_snapshot_baseline` (see
[`MIGRATION_AUDIT_0061_0069.md`](MIGRATION_AUDIT_0061_0069.md) §4). Until it is
applied, staging creates new baselines with the old three-run plan. Re-applying
`0062` or `0063` at this point would overwrite the live function with an older
body and reintroduce the `paraphrase_plan` bug `0063` fixed.

**Process finding.** Eight migrations reached a real environment without a
recorded apply, and this document asserted the opposite for a day. Sections 1
and 9 warn that repository files prove nothing about deployed state; this is
the mirror-image failure, where the documentation proved nothing either. Any
future apply must record environment, date, operator and tooling at the time it
happens, and a probe like this one must precede any migration run rather than
follow it.

**What this does not claim.** Phase 3C exercised the deployed worker against an empty queue only. It establishes readiness, execution-enabled worker start, idle proof over three consecutive no-job cycles, zero iterations, graceful stop, and versioned return to `disabled`. It does not establish job claiming, provider execution, receipt durability, browser-disconnect survival, anti-double-payment behavior, abandoned-job recovery, or structured error/alert handling. Those M5 acceptance requirements remain open. This evidence does not close M5.

## 16. M7 migrations 0070-0076 applied to staging

- **As of:** 2026-09-18
- **Environment:** `zypact-staging` (Supabase project `bfqpkfqsonixdnfiodwk`)
- **Tooling:** Supabase SQL editor, one migration per explicit transaction, applied in ascending order
- **Procedure and verification SQL:** [`M7_STAGING_APPLY_RUNBOOK.md`](M7_STAGING_APPLY_RUNBOOK.md)

This supersedes 15.6's "Still absent — M7 in its entirety" **at the schema layer
of staging only**. It changes nothing about `main`, production, or the
application layer.

**Pre-flight (read-only, before any write).** `0069` live and carrying `D-032`;
exactly one overload each of `approve_and_launch_snapshot_baseline`,
`approve_protocol` and `resolve_protocol_job_review`; neither `interventions`
nor `outcome_card_artifacts` present; `protocols_one_active_per_version` still
present. Worker quiesced: Fly Machine `e826322a695098` stopped, zero jobs in
`claimed`/`running`, zero attempts in `reserved`/`in_progress`, no open
transactions.

**Verified after apply.**

| Property | Result |
|---|---|
| `interventions`, `outcome_card_artifacts` | both present |
| `protocols_one_live_baseline_per_version`, `protocols_one_live_retest_per_baseline` | both present |
| `protocols_one_active_per_version` (0047's index, dropped by 0073) | gone |
| The 13 new M7 functions | 13 rows — one per name, so no duplicate overload |
| `resolve_protocol_job_review` | 1 overload, body carries 0070's job-scoping predicate |
| `approve_protocol` | 1 overload, body carries `detectable_change_at_plan` |
| Triggers on `interventions` / `protocol_attempts` | 1 / `protocol_attempts_phase_matches_protocol` present |
| Observation-window columns / `protocols.detectable_change_at_plan` | 5 / present |
| `_smallest_detectable_change` at n = 5/10/15/20/30 | 0.60 / 0.40 / 0.27 / 0.25 / 0.17 — the signed-off table exactly |

The `n=5` value matters beyond a schema check: at the five-run default the
smallest detectable change equals Δ_min, so the deployed PL/pgSQL body
reproduces the sign-off boundary rather than merely existing under the right
name.

**Recorded weakness.** Per-migration apply timestamps were not captured at the
time. The Step 3 per-migration checks were skipped; the combined and gap probes
above were run afterwards against final state. 15.4's process finding asks for
the stronger record, and this apply did not fully meet it. The verification is
sound — every probe reads current state — but the timing record is not.

**The CLI ledger was deliberately not touched.** No row was inserted into
`supabase_migrations.schema_migrations`. It is not established that the ledger
records `0061`-`0069` (see 15.7); adding only `0070`-`0076` would lead a future
`supabase db push` to re-run the earlier migrations, which for `0062`/`0063`
would overwrite live function bodies with older ones.

**What this does not establish.** No runtime contract was executed against
staging — the M7 harnesses write fixture data and target disposable databases.
They passed against real PostgreSQL 16 (0070-0074: 56/56, 0075: 22/22, 0076:
26/26), and the probes above confirm staging carries those same bodies, but no
M7 RPC has been invoked on staging. No intervention exists, no retest protocol
exists, no Outcome Card exists. The worker remains `disabled/stopped`.

**The application layer is unchanged and still absent.** No route or UI calls
`register_intervention`, `approve_intervention`,
`confirm_intervention_implementation`, `authorize_early_retest`,
`create_retest_protocol` or `retest_eligibility`. `detectable_change_at_plan` is
stored but rendered nowhere, so the §5 condition of the founder sign-off remains
open. A retest is now reachable on staging only by an operator issuing SQL
directly. That is a capability, not a workflow.

### 16.1 Migration 0077 applied to staging

- **As of:** 2026-09-18
- **Environment:** `zypact-staging`, Supabase SQL editor, one explicit transaction
- **Runtime contract before apply:** `test:m7-0077-runtime` 52/52 against real PostgreSQL 16

| Property | Result |
|---|---|
| `reject_intervention`, `abandon_intervention` | both present |
| `_reject_registered_intervention_edit` | 1 overload, body carries `abandonment_is_immutable` |
| `protocol_execution_jobs_status_check` | present, allows `cancelled` |
| Check constraints listing job status values | exactly one; no stale pre-0077 duplicate |
| New `interventions` columns | 5 of 5 |
| Interventions on staging at apply time | 0 |
| Jobs `claimed`/`running` at apply time | 0 |

**Recorded weakness.** The pre-flight probe returned `reject_intervention` and
`abandon_intervention` as already present, which is consistent with it having
been run after the apply rather than before. The constraint-name check it
carried (`protocol_execution_jobs_status_check` exists) is valid in either
order, and the post-apply constraint listing independently rules out the
failure it guarded against. The ordering is recorded as observed rather than
as intended.

A verification query initially counted 3 status-referencing check constraints
against an expectation of 1. The query was too loose — it matched
`claim_fields_check` and `needs_review_reason_pair_check`, which reference
`status` without enumerating it. A full constraint listing confirmed exactly
one enumerating check. The discrepancy was in the probe, not the schema.

### 16.2 Migration 0078 applied to staging

- **As of:** 2026-09-18 · `zypact-staging`, Supabase SQL editor, one explicit transaction
- **Runtime contract before apply:** `test:m7-0078-runtime` 16/16

| Probe | Before apply | After apply |
|---|---|---|
| Interventions registered against a retest protocol | 0 | 0 |
| `register_intervention` overloads | 1 | 1 |
| Body carries `protocol_is_not_a_baseline` | false | true |

The pre-flight was run before the apply and confirmed the old body was live,
so unlike 16.1 this record shows the intended order.

### 16.3 Migration 0079 applied to staging

- **As of:** 2026-09-18 · `zypact-staging`, Supabase SQL editor, one explicit transaction
- **Runtime contract before apply:** `test:m7-0079-runtime` 19/19. Section [0]
  reproduced the defect on 0073 itself: a completed retest was followed by a
  second `CREATED` retest for the same intervention.

**Recorded weakness.** No separate pre-flight probe was run. The migration's own
precondition block (abort if any baseline carries more than one non-abandoned
retest) executed inside the same transaction and the apply succeeded, so that
condition held — but the body-before check was not captured.

**Post-apply verification, 2026-09-19.** Founder-reported: one
`create_retest_protocol` overload, body carrying the widened predicate. Reported
rather than captured here; no screenshot is attached to this record.

## 17. M7 application layer — built on `feat/m7-retest`, not merged, not deployed

- **As of:** 2026-09-19
- **Branch:** `feat/m7-retest`, based on `main` at `589483c`. Not merged.
- **Plan and per-phase record:** [`OPTION_A_TODO.md`](OPTION_A_TODO.md)

This supersedes §16's closing statement that the application layer is absent
— **on this branch only.** `main` and every deployed environment are unchanged
by it until the branch is merged and deployed.

**Built.** A founder can, from `/admin/interventions`, register an
intervention against a baseline, approve / reject / abandon it, confirm its
implementation, authorize an early retest, create the retest protocol, queue
its run, follow its progress, build the Outcome Card, review it, and send it.
Every action is a founder route behind the `INTERVENTION_ADMIN_ENABLED` kill
switch and the founder allowlist; every write is a `service_role` RPC with the
project id taken from the stored row, never the request.

**Schema added on this branch and applied to staging:** `0077` (reject,
abandon, job cancellation), `0078` (register against baselines only), `0079`
(one retest per intervention). Records: §16.1–16.3. Each passed a runtime
contract against real PostgreSQL 16 first (52/52, 16/16, 19/19).

**Two defects found and fixed while building it.** `0073` let a completed
retest be followed by a second retest for the same intervention (fixed by
`0079`). `deliver-outcome-card.ts` resolved an intervention's retest with no
status filter, so after one abandonment it would have thrown on every
delivery for that baseline (fixed alongside `0079`).

**Customer links now have one origin.** Report and Outcome Card links, from the
web app and the workers alike, come from `publicSiteUrl()`
(`NEXT_PUBLIC_SITE_URL`, falling back to `https://www.zypact.com`).
`SNAPSHOT_PUBLIC_BASE_URL` now builds email-verification links only.

**What this does not establish.**

- **No retest has ever run outside a test harness.** Phase 4 step 4 — the first
  real retest attempt on staging, and with it the first `attempt_kind =
  'retest'` written by the deployed worker — is held for an explicit founder
  go-ahead, because the first attempt cannot be rolled back without deleting
  evidence. Until it runs, no Outcome Card has been built from real data.
- **Browser and session checks: founder-reported, 2026-09-19.** The founder ran
  the pages locally against `zypact-staging` (`npm run dev`, `.env.local`
  pointing at the staging project) and reported every case as expected: the
  admin pages render, a non-founder gets 404 and a signed-out request 401, the
  kill switch returns 503, the intervention lifecycle behaves as designed, and
  no retest attempt exists. Reported, not captured: no screenshots or query
  output are attached to this record, and no automated test covers the session
  paths. This is weaker evidence than the runtime contracts above and is
  recorded as such.
- **`test:snapshot-send-idempotency` fails, before and after this branch**
  (identical 18 failures). It predates the revision-fenced send handler
  (`a1f3f03`) and still posts empty bodies. Stale, not regressed.

## 18. Reconciled repository and deployment state

- **As of:** 2026-09-30
- **`main` at:** `d2f4cdf` ("Rebuild the public pages light, on evidence instead of invented proof", #60)
- **Method:** read-only inspection of the tracked tree, `git` history, and three
  independent code traces of the baseline, retest and report/delivery paths. No
  database was probed, no provider was called, no deployment was inspected.
- **Scope:** this section supersedes the inventory figures in sections 3, 7, 12,
  13 and 15, and corrects section 17's merge status. It does not rewrite them.

### 18.1 Measured inventory

| Item | Value on `d2f4cdf` |
|---|---|
| SQL migrations | 81, `0001_init.sql` through `0081_snapshot_request_origin_and_founder_creation.sql`, no gaps |
| Test source files | 176 matching `scripts/test-*.ts` |
| Registered commands | 88 `test:*`, 3 `verify:*` |

Section 15.2 recorded 69 migrations and 57 registered commands on the then
unmerged `fix/v1-customer-flow`. Both are superseded.

### 18.2 Section 17 is corrected: M7 is merged

Section 17 records the M7 application layer as built on `feat/m7-retest`, "Not
merged." That branch is now an ancestor of `main`, as are
`fix/v1-customer-flow` and `feat/enable-live-production-worker`. Migrations
`0071`-`0079` (interventions, observation window, retest protocol creation,
retest phase integrity, detectable change, Outcome Card artifacts, rejection and
abandonment, baseline-only registration, one retest per intervention) are in
`main`, together with `0080` and `0081`.

### 18.3 What is wired end to end, in code

Both halves of the V1 workflow exist on `main` and are connected. Traced
function by function:

- **Baseline.** `/scan` → `create_snapshot_request_guarded` → email verification
  → `consume_snapshot_request_verification` → founder approval →
  `approve_and_launch_snapshot_baseline` (project, buyer question, question
  version, protocol, `approve_protocol`, `enqueue_protocol_execution_job`, all in
  one transaction) → worker claim → `admit_and_reserve_attempt_for_job` →
  Perplexity → `record_provider_call_receipt_for_job` → OpenAI analysis →
  `persist_probe_result_for_job` → `runReportPass` → `save_protocol_report_artifact`
  → `/report/[secureToken]`.
- **Retest.** `/admin/interventions` → `register_intervention` →
  `approve_intervention` → `confirm_intervention_implementation` →
  `retest_eligibility` → `create_retest_protocol` →
  `enqueue_protocol_execution_job` → worker (which branches on
  `baselineProtocolId` to label the attempt `retest`) → `compareProtocols` →
  `save_outcome_card_artifact` → `/outcome-card/[secureToken]`.

No stub, simulated-provider path or unimplemented branch was found on either
route. `ZYPACT_MOCK_MODE` must be exactly `"off"` for the worker to start live,
and the Perplexity leg never reads it.

### 18.4 What has actually run, and what has not

- **Baseline, live, proven.** D-036 records production evidence: a completed run
  takes a median of 18 s (p90 22 s), and three 5-run baselines completed in 91 s,
  93 s and 102 s.
- **Retest, never run.** D-034 states that no retest has run outside a test
  harness. [`OPTION_A_TODO.md`](OPTION_A_TODO.md) still carries the UI-driven
  end-to-end run as unchecked, held for an explicit founder go-ahead. No
  Outcome Card has been built from real data.

### 18.5 Open findings

1. **Execution is founder-triggered, and the public copy says otherwise.** The
   approve route contains no worker start; a founder must press Run pipeline,
   which calls `startWorkerMachine()`. `app/page.tsx` and `app/scan/page.tsx`
   both tell the reader the baseline "runs automatically" after approval. One of
   the two must change. Changing the copy is the smaller act; wiring approval to
   a machine start changes who can cause paid spend and would need its own
   decision record.
2. **The job claim is not scoped.** `claim_protocol_execution_job` takes the
   oldest eligible job globally, so a start intended for one request can claim
   another. `claim_protocol_execution_job_by_id` (0059) exists and
   `runWorkerLoop` never calls it — a wired-but-unused safety barrier. Latent
   while only one job is ever queued. **Fixed on branch `feat/pilot-mode-phase1`
   by D-052 (§30), not yet deployed:** each start names its job, and the live
   worker claims that job or nothing.
3. **`blocked` is unreachable on the V1 path.** `reportExposesLegacyVerdictAsTruth`
   is four regexes matching legacy `won/partial/lost` aggregates;
   `renderProtocolShortReportMarkdown` emits none of them. The practical states
   are `integrity_passed` and `needs_review`. The four `blocked` guards —
   orchestrator, send handler, migration 0080's status transition, and the public
   page allowlist — are correct and currently dormant.
4. **The integrity classifier implements 4 of METHODOLOGY §16's 14 gates**, by
   its own header. M1-A full-request-body hashing is deliberately not required,
   because the worker records `absent` on every row.
5. **The founder "Send report" button emails a degraded message.** It parses
   protocol short-report markdown with `parsePublicSnapshotReport`, a legacy
   parser looking for strings the protocol renderer never emits, so its
   placeholder fallbacks fire. The review panel's "Send to requester" path uses
   `sendProtocolReportEmail` and is correct. Two templates, one artifact.
6. **`needs_review` is one click from delivery.** The Send report button carries
   no acknowledgement step, while the Outcome Card path requires
   `acknowledgeReview`. The asymmetry appears unintentional.
7. **Protocol deviations cannot be recorded after implementation is confirmed.**
   `confirm_intervention_implementation` returns without acting unless status is
   `approved` (0071), and it is the only writer of `protocol_deviations`. A
   confounder discovered during an open observation window therefore has no
   product surface. See [`SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md`](SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md).
8. **D-036's slot fix is not yet in effect.** It states that the change takes
   effect only when the production config is redeployed; until then the machine
   keeps `WORKER_MAX_SLOTS_PER_CLAIM = 1`, under which no 5-run baseline or
   retest can complete. The redeploy procedure, and the drift check that is the
   only way to confirm the bounds actually landed, are recorded in
   [`WORKER_DEPLOY_RUNBOOK.md`](WORKER_DEPLOY_RUNBOOK.md).

### 18.6 Recording gap

Nothing was recorded in this file between 2026-09-19 and this entry, while pull
requests #48 through #60 landed on `main` — including the merge of the entire M7
application layer, the production worker going live under D-034, and three
decisions (D-034, D-035, D-036). Section 15.7's process finding asked for a
record written at the time the change happens. That did not occur here either.

## 19. Buyer Question Intelligence Q1 — offline rules, run locally, not in CI

- **As of:** 2026-11-01
- **Base:** `main` at `6d81553` (merge of #95, the Q0 documents)
- **Status:** **complete and merged.** PR #96 merged into `main` as `19a644c`, and its content is identical to the independently reviewed head `841f188`. No production deployment followed: `vercel.json` disables Git deployments for `main`. Single-source primary inference is deferred to a separate decision. The direction for later steps is now D-040 ([`SELF_SERVICE_PRODUCT.md`](SELF_SERVICE_PRODUCT.md)).
- **Scope:** the pure functions in `lib/buyer-questions/` and their offline tests,
  as defined by the accepted Q1 scope and test plan. Nothing in this section is
  wired into a route, page, worker, RPC or workflow. No migration, database,
  network, provider or paid path changed.

### 19.1 Commands added

| Command | Plan cases | Local result on 2026-11-01 |
|---|---|---|
| `npm run test:bqi-candidates` | C-01 to C-28 | 229/229 checks passed |
| `npm run test:bqi-selection` | S-01 to S-18 | 81/81 checks passed |
| `npm run test:bqi-wording` | W-01 to W-11, P-01 to P-04 | 110/110 checks passed |

These results are after the corrective round authorised on 2026-11-01. A
review of the first commit (`ed08c3a`) found that approved-wording
classification accepted unvalidated quoted spans as observed evidence, that
public links could upgrade a candidate's verification, that near duplicates
were grouped transitively, that merged duplicates mixed their evidence links,
and that the feature-list detector was narrower than the plan. Adversarial
subcases, marked `[R]` under the existing case IDs, fail against `ed08c3a`'s
library and pass after the correction.

An independent review of the corrected commit (`5bf9473`) then found three
more defects: a `paraphrase_basis` span could make a buyer's statement
observed wording; set-level refusals, including colliding source ids, were
ignored by the wording classifier and founder review; and two texts that are
empty after observed normalisation ("???", "!!!") matched. Only a validated
`verbatim` link now establishes observed wording, any set-level refusal refuses
classification, colliding ids are refused together, and empty wording matches
nothing. Subcases marked `[R2]` fail against `5bf9473`'s library and pass
after this correction.

Review of `1c221b5` found two more: founder review could record a buyer's
statement as `observed`, and `validateCandidate` called without source
results treated linked sources as valid. Founder review now records only
`adapted` or `hypothesis`, as the design specifies (`observed` is refused as
`classification_not_allowed`), and standalone candidate validation validates
each linked source itself. Subcases marked `[R3]` fail against `1c221b5`'s
library and pass after this correction.

These three commands are registered in `package.json` but are **not** run by any
CI workflow. Adding them to CI is a separate decision. With them, `package.json`
registers 103 `test:*` and 4 `verify:*` commands, and 191 files match
`scripts/test-*.ts`. These figures supersede section 18.1's command and file
counts, which were already behind `main` before this branch.

### 19.2 What these tests do not establish

They test rules over in-memory inputs only. No Q0 acceptance criterion in
[`BUYER_QUESTION_INTELLIGENCE.md`](BUYER_QUESTION_INTELLIGENCE.md) is met by Q1
alone: enforcement on save, stored rows, the approval RPC, rendered cards and
pages, and criteria 25 and 32 to 69 all need the later steps (Q2, Q3, Q4, Q4b).
The marketing-language, personal-data, length and question-shape detectors are
provisional `v1` review signals, not validated classifiers. Passing them is
never evidence of buyer authorship. `public_verifiable` records that the
curator gave a public URL and retrieval date; Q1 fetches nothing, and its text
match is not independent verification of that source.

## 20. Q2′-1 account-first data foundation — draft PR #100, not merged, not applied anywhere

- **As of:** 2026-11-03
- **Base:** `main` at `a2629dc`, the merge of #99 (B1 revision 3)
- **Status:** **draft pull request #100, not merged.** No SQL from this branch
  has run against any Supabase project. The migration has run only in
  disposable PostgreSQL databases: local containers with `--network none`, and
  GitHub Actions service containers.
  - **B1 is merged.** #99 (`0d3f3f6`, the migration-name rules) merged into
    `main` with a merge commit, `a2629dca03b7b3441eda2445e87158dd1de6b79e`, on
    2026-11-03. No deployment or migration followed (20.3).
  - **#100** (`feat/q2p1-account-foundation`) was opened stacked on B1, then
    retargeted to `main` after #99 merged. It holds only Q2′-1's 12 files.
  - **Its commits:**
    - `20e5755` (Q2′-1);
    - `6a258f6` (remediation R1–R4);
    - `f7ce558` (remediation R6);
    - `b5eb27a` (email binding);
    - `32bd5e8` and `b22b5a3` (CI readiness, and the scope check split from
      the persistent contract);
    - the documentation refresh that adds this paragraph.
  - **Independent review:** the review of `0d3f3f6..f7ce558` requested
    changes. F4 compared a caller-supplied email HMAC with the invitation's
    own value and never read the persisted request address, so an approval
    succeeded after that address changed (reproduced locally). `b5eb27a`
    corrects that (20.2, "Email binding"), and the review of `b5eb27a` passed
    for the PR and CI phase only. `32bd5e8`, `b22b5a3` and `5dd27a0` (the
    documentation refresh) were then independently reviewed and passed for
    the final merge-readiness stage, with no new material CI or scope-contract
    blocker. The later documentation correction records these reviews.
  - **This is not production deployment.** Merging #100 needs separate
    authorisation, and every production step stays gated (20.6).
- **Scope:** one migration,
  `supabase/migrations/20261102132000_q2p1_account_workspace_foundation.sql`,
  the first with a 14-digit version (D-041), plus its tests. It implements the
  closed database foundation for D-040's account and workspace model. Nothing
  in this section is wired into a route, page, worker or workflow, and no
  TypeScript adapter exists (Founder decision D-2). F3, F5 and
  `bqi_enrollments` moved to Q2′-1b (Founder decision D-1). No provider, paid
  path, spend gate, PG-9 file or existing migration changed.

### 20.1 What the migration adds

- **15 new tables,** all closed: RLS enabled with no policies, and every
  privilege revoked from `public`, `anon`, `authenticated` and
  `service_role`. Rows are reached only through the functions below.
- **Tenant pinning:** the nine project-scoped tables (research sets, sources,
  candidates, candidate sources, invitations, sessions, approval records,
  version origins and wording classifications) are pinned by a composite
  foreign key to `(project_id, workspace_id)` in `workspace_projects`, so
  their rows cannot name a project from another workspace. The other six are
  not project-pinned. `workspaces` is the root, and `workspace_projects` is
  the pin itself. `workspace_members` and `workspace_membership_versions`
  carry `workspace_id` only. `exception_items` and `exception_events` have a
  nullable `workspace_id` and no project (limitation 10).
- **Actors:** four actor types (`customer_account`, `invitation_holder`,
  `founder`, `system`), checked by `_q2p_actor_shape_ok` and by composite
  foreign keys to memberships and sessions.
- **Functions,** each `SECURITY DEFINER`, owned by the migration role, with
  `search_path = public, pg_temp` and `lock_timeout = 5s`:

| Function | Purpose | Granted to |
|---|---|---|
| F1 `create_workspace_with_owner` | workspace and first owner, idempotent by key | `service_role` only |
| F2 `assign_project_to_workspace` | pins an existing project to one workspace | `service_role` only |
| F4 `approve_buyer_question_set` | records a customer approval from an invitation session; takes **no email value** from the caller; **no paid effect, no job, no protocol** | `service_role` only |
| F6 `assert_current_account_member` | binds the account from `request.jwt.claims` and checks membership `FOR SHARE` | no role |
| F7 `add_workspace_member` | adds a member | `service_role` only |
| F8 `remove_workspace_member` | removes a member | `service_role` only |

### 20.2 Security invariants, and the test that holds each one

| Invariant | Enforced by | Tests |
|---|---|---|
| Membership changes are serialised | every change first increments the workspace's row in `workspace_membership_versions`, so it serialises under READ COMMITTED and raises `40001` under REPEATABLE READ and SERIALIZABLE | QR two-session cases, weakened copy |
| R1: only a verified email can approve | table check `exchanged_at is null or email_verified_at is not null`. A session needs an exchanged, verified invitation and never outlives it. F4 refuses when `email_verified_at` is null. | QR, QS |
| R2: "observed" only with a source-backed span | `_q2p_observed_span_ok`: a byte-exact verbatim span of the primary source, buyer-authored, not site copy, the same verification, the hash intact, on word boundaries. `adapted` needs `_q2p_adapted_basis_ok`. Anything else is `pending_review`. | 9 Q1 vectors (`scripts/fixtures/q2p1-wording-vectors.json`), QR |
| R3: approval idempotency is bound to content | a canonical fingerprint over the action, research set, consent text version and hash, and the items sorted by prompt hash, so it does not depend on order. `unique (research_set_id, idempotency_key)`. `ALREADY_APPROVED`, `IDEMPOTENCY_KEY_CONFLICT` and `SET_ALREADY_APPROVED` are returned only after full authorisation. A replay needs a valid session. | QR, QS |
| R4: no swallowed errors | no `unique_violation` handlers. F1 takes a transaction advisory lock on its key and returns `IDEMPOTENCY_KEY_CONFLICT`. `40001`, `23505`, `40P01` and `55P03` propagate, and nothing is written. | QS mutations, QR |
| R6: a revocation or expiry is decided at the decision instant | F4 locks the session `FOR UPDATE`, then the invitation `FOR SHARE`, then the snapshot request `FOR SHARE`, then the research set `FOR UPDATE`, always in that order. After the locks it takes one `clock_timestamp()` and uses it for absolute, idle and invitation expiry, `last_seen_at` and `approval_records.approved_at`. F4 contains no `now()`. | R6-A to R6-H (25 assertions), QS-25 |
| Email binding: the request's persisted address, never a caller value, authorises | each invitation carries `request_email_binding`, a `NOT NULL` SHA-256 of a domain label, the invitation id and the request's `normalized_email`. A `BEFORE INSERT` trigger derives it from the request row, read `FOR SHARE`, and refuses any caller-supplied value (`22023`). It is immutable (`55000`). F4 takes no email argument. It reads the request's address `FOR SHARE` and refuses (`42501`) unless the binding recomputed from it matches, before any idempotency status, so a replay is refused too. | QR-41 to QR-43, QS-26 |
| Grants and ownership | every function owned by the migration role, `EXECUTE` exactly as in 20.1; no table privilege for any API role | QS, the role preconditions in each Level 2 run |
| Nothing that existed before is written | baseline and verify around the whole Q2′-1 block | QR-39 |

Each concurrency and refusal invariant also has a **weakened proof**. The
fixtures take the function from `pg_get_functiondef`, make one textual change
(for example, removing the invitation lock, using the transaction clock,
removing the binding comparison, or reading the request without a lock), and
the same case then shows the defect: an approval after a committed
revocation, a revoker that isn't blocked, an approval after expiry, or an
approval after the request's address changed.

### 20.3 Commands and local results at the email-binding commit

The evidence package records the exact commit, the logs and two identical
production-order runs.

| Command or run | Venue | Result |
|---|---|---|
| `npm run test:q2p-schema` (QS-01 to QS-26 except QS-15, Q1 compatibility, 46 mutation self-tests) | offline | 207/207 at `b22b5a3` (209/209 at `b5eb27a`, when it still held QS-15) |
| `Q2P_SCOPE_BASE=<base> npm run test:q2p1-scope` (QS-15) | offline | 6/6 at `b22b5a3`, base B1 |
| `scripts/test-snapshot-worker-postgres-level2.sh` | PostgreSQL 16-alpine `sha256:0cefaabd…31ab`, `--network none` | 634 passed, 0 failed (386 Q2′-1, including 30 for QR-41 to QR-43; 25 R6; 220 existing; 3 role preconditions) |
| Production-order run: Q2′-1 applied through the named-file procedure before 0083, the full Q2′-1 suite, QR-35, then 0083 by the reserved-version procedure; schema compared with CI order | PostgreSQL 17.6 `sha256:00bc8661…2929`, `--network none` | 426 passed, 0 failed, in two identical runs (388 QR + 25 R6 + 10 P + 3 roles); schema dump equals CI order |
| The 21 B1 test suites | offline | logs byte-identical to the `f7ce558` run |
| The 9 M0 CI-workflow suites | offline | all pass |
| `npm run typecheck`, `npm run build:verify` | local | pass, pass |
| `git diff --check f7ce558..HEAD` | local | clean |

**Two commands, so that later migrations cannot be failed by a Q2′-1-only rule:**
- **`test:q2p-schema`** is the persistent schema and security regression
  contract: QS-01 to QS-26 except QS-15, the Q1 vectors and the mutations. It
  needs no base. Every check stays true when later migrations are added:
  - QS-01 now requires Q2′-1 to apply after every four-digit migration, and
    to be the first timestamped migration, instead of the last one.
  - QS-12b compares only with migrations applied before Q2′-1.
- **`test:q2p1-scope`** is QS-15, the Q2′-1 change-scope check. Its strictness
  is unchanged. It needs `Q2P_SCOPE_BASE`, the commit the change is reviewed
  against, and checks every path changed since that commit's merge base with
  `HEAD`, plus untracked files. A missing or unresolvable base, or a base
  with no shared history, fails. It is never skipped and never falls back to
  a pinned commit. For example:
  `Q2P_SCOPE_BASE=test/b1-timestamp-migration-names npm run test:q2p1-scope`.

**CI configuration (in #100):**
- `q2p-schema-contract.yml` runs `test:q2p-schema` on pull requests into any
  base branch that touch migrations or its inputs.
- `q2p1-scope.yml` runs `test:q2p1-scope` with the pull request's base SHA,
  only when the Q2′-1 migration file or the check itself is in the diff. It
  runs again when the base changes.
- Both run on the stacked pull request without manual dispatch, which GitHub
  allows only for workflows already on the default branch.
- Level 2's timeout rises from 15 to 25 minutes. Its triggers are unchanged,
  as are M0's.
- All four workflows keep `contents: read`, use no secrets and start no
  external resource.
- GitHub cannot mark a check as required on this plan.

At `f7ce558` the same runs gave 178/178, 605/0 and 397/0 (×2). The Level 2
difference is QR-20's caller-HMAC case, removed because the parameter no
longer exists, and the 30 new assertions. Every other assertion line is
unchanged.

**Known failures, unchanged and not counted as passes.** None of these runs in CI.

- `m7-0071`: 2 failures, caused by 0077. `m7-0073`: 1 failure, caused by 0079. Both fail on `main` too.
- `snapshot-send-idempotency`: 6 passed and 18 failed, identical to `main`.
- `bqi-wording` P-04: fails, because it compares changed paths against Q1's plan, and this branch is not Q1.
- `pg9-harness-offline`: fails closed on any timestamped migration, by design. PG-9 evidence stays pinned to commits at or before `13ccdc1`, and is never evidence for Q2′-1.
- Skipped (opt-in or CI-only): `m0-0057-runtime`, the Docker bodies of the B1 runtime harnesses, and the Docker half of the hosting contract.

The local runs used plain PostgreSQL images, not the Supabase stack, and
macOS shims for `timeout` and millisecond `date`. CI pulls its image by tag,
not digest.

**GitHub Actions runs at `b22b5a3`** (2026-11-03; logs read, not only the status):

| Run | Base | Result |
|---|---|---|
| M0 on #99 (B1), `41635225993` | `main` at `0f094c1` (PR merge ref) | success; every suite passed |
| Q2′-1 schema contract, `41635257694` | B1 | success; 207 checks |
| Q2′-1 change scope (QS-15), `41635257648` | B1 (`Q2P_SCOPE_BASE` = `0d3f3f6`) | success; 12 paths |
| Level 2, manual run on the branch, `41635269204` | — | success: 83 migrations, 634 passed, 0 failed (30 QR-41 to QR-43, 25 R6); 13 min 37 s |
| M0, manual run on the branch, `41635275317` | — | success; every suite passed |
| Q2′-1 change scope (QS-15) after retargeting to `main`, `41642157104` | `main` at `a2629dc` (merge base `0d3f3f6`) | success; 12 paths |

The runs against `main` for the commit that adds this text are recorded on
#100, not here, because a commit cannot record its own CI.

Previews: Vercel built Preview deployments of both branches, READY and
Preview-only. They were built after `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`
and `SNAPSHOT_IP_HASH_SECRET` were made Production-only. Production and its
domains were unchanged throughout.

On this branch, `package.json` registers 105 `test:*` and 4 `verify:*`
commands, 193 files match `scripts/test-*.ts`, and `supabase/migrations/`
holds 83 files: the 82 historical files plus `20261102132000`. On `main` at
`a2629dc` the figures are 103, 4, 191 and 82. These figures supersede section
19.1's.

### 20.4 Known limitations

1. **A revocation that waits can carry an earlier `revoked_at`.** When a
   revocation `UPDATE` waits on F4's `FOR SHARE`, PostgreSQL computes its
   `clock_timestamp()` before the wait. The revocation correctly commits after
   the approval, but its timestamp can be earlier than `approved_at`. No
   Q2′-1 code writes `revoked_at`. Q4′'s revocation path must lock the row
   first, then stamp the time.
2. **The lock order is a convention for future code:** session, then
   invitation, then snapshot request, then research set. A path that breaks it
   can deadlock with F4. PostgreSQL then aborts one side with `40P01`, which
   fails closed (R6-F; QR-43 for the request).
3. `buyer_question_versions.approved_at` is still written by the unmodified
   0047 function, which uses `now()`. The authoritative instant is
   `approval_records.approved_at`.
4. The invitation-expiry case in R6-D also expires the session, because a
   session may not outlive its invitation. Invitation expiry on its own is
   covered statically.
5. Classification is stricter than Q1: a near match that Q1 grades observed
   becomes `pending_review` here.
6. The order of questions in an approval is treated as meaningless.
7. F1 under REPEATABLE READ raises `23505` instead of returning a status.
8. There are no RPCs to issue, exchange, revoke or reissue an invitation. That is Q4′.
9. `service_role` is the trust boundary. Who holds that key is unresolved (A4, on HOLD).
10. `exception_items.workspace_id` and `exception_events.workspace_id` are
    nullable. An event with a null `workspace_id` escapes its composite
    foreign key to the item's workspace (`MATCH SIMPLE`).
11. **A restored address makes an existing invitation valid again.** F4
    compares the request's current address with the binding. If the address
    changes, every invitation bound to it stops authorising. If it is changed
    back to the exact original `normalized_email`, an invitation that is
    otherwise still valid (unrevoked, unexpired, with a live session)
    authorises again (QR-41, documented). No path changes an address today;
    any future one that must make a change final has to revoke the request's
    outstanding invitations in the same transaction.
12. **The binding is an unkeyed SHA-256, not an HMAC.**
    - **Who can exploit it.** Anyone who obtains an invitation row (its id and
      binding) can test guessed addresses offline. Work addresses are easy to
      guess: the domain comes from the request. That includes anyone holding
      an export, dump, replica, log or backup copy of
      `question_review_invitations` without `snapshot_requests`, and anyone
      holding a binding after the request's address is erased. **The risk
      does not depend on plaintext access.**
    - **Under the current access model:**
      - no API role can read the table;
      - the owner can read it, and can also read the plaintext address;
      - no code exports the table, logs the binding or erases addresses.
    - **Judgement:** acceptable for the Q2′-1 foundation under that model.
      It is not acceptable once the invitations table is exported, replicated
      or retained separately from the requests table, or once address
      erasure exists.
    - **Removing the risk** needs a keyed binding, which needs a new secret.
      That is outside this authorisation; the credential model is unchanged.
15. **The binding proves email continuity, not recipient identity.** It shows
    that the request's persisted address has not changed since the invitation
    was issued. It does not show that the invitation was sent to, or verified
    by, that address: `email_hmac` and `email_verified_at` are written by the
    issuer, and the database holds no key to compare `email_hmac` with the
    request's address. No Q2′-1 code issues or exchanges invitations; the
    tests insert them as the owner. Recipient matching must be enforced by
    Q4′, at two gates:
    - **The issue RPC** (owner-run, `SECURITY DEFINER`) takes no recipient
      address parameter. The server sends the token only to the request's
      `normalized_email`, read under lock, and stores that address's keyed
      `email_hmac`.
    - **The exchange RPC** is the only writer of `exchanged_at` and
      `email_verified_at`. It sets them only after proof of possession of that
      same address (the delivered token). Under the lock order session,
      invitation, request, it re-checks the binding, and the server re-checks
      that the address's keyed HMAC equals the invitation's `email_hmac`.

    Until both exist, nothing in the database stops an invitation from being
    inserted with another address's `email_hmac` and verification time.
    Q4′'s issue and exchange RPCs are therefore a gate before any customer
    use (20.6).
13. **The `REPEATABLE READ` cost:** any update of the request row after F4's
    snapshot, including an unrelated worker status change, fails the approval
    closed with `40001` (QR-43). Under `READ COMMITTED` the approval waits
    instead.
14. A change of `work_email` alone, such as its display case, does not affect
    the binding. Only `normalized_email` is bound.

### 20.5 What these tests do not establish

- **No production behaviour.** They do not establish production grants,
  Supabase role behaviour, PostgREST exposure, or whether the production role
  can call `pg_control_system()`.
- **No end-to-end path.** No route, session token, email verification or
  customer flow exists to exercise the functions. S1 (JWT binding) has not
  run against any Supabase project.
- **No Supabase stack.** CI runs the same plain-PostgreSQL harness, not the
  Supabase stack or PostgREST.
- **Review scope.** The independent reviews passed `b5eb27a` for the PR and
  CI phase, and `32bd5e8`, `b22b5a3` and `5dd27a0` for merge readiness. They
  are not reviews of production application, which stays gated (20.6).

### 20.6 Remaining gates before production

> **2026-11-17 note:** this list describes the state when it was written. Gate 3, the read-only preflight, ran against production on 2026-11-09 with every must-pass check PASS, and 0083, Q2′-1, Q2′-2 and S1 were applied to production on 2026-11-09 and 2026-11-10 (§25).

Each gate needs its own authorisation, in this order:

1. **Done.** Independent review: `0d3f3f6..f7ce558` requested changes,
   `b5eb27a` passed for the PR and CI phase, and `32bd5e8`, `b22b5a3` and
   `5dd27a0` passed for the final merge-readiness stage.
2. **Done:** B1 merged as #99 (`a2629dc`). #100 is open as a draft against
   `main`. Its four CI workflows passed against `main` at `5dd27a0`, and must
   pass again on any later head before it merges. Branch
   protection is unavailable on this plan, so that is a merge rule. Merging
   #100 needs separate authorisation, and is not production application.
3. The read-only production preflight from `PROD_PREFLIGHT_SPEC.md` (P3),
   including production grants and access to `pg_control_system()`. It has
   not run.
4. 0083 applied to production by the reserved-version procedure (D-041,
   strategy B).
5. Q2′-1 applied to production by the named-file procedure (D-041).
6. S1 JWT binding shown on a non-production Supabase project (G1), before any
   customer use.
7. Q4′'s issue and exchange RPCs enforcing recipient matching (20.4, item 15),
   before any customer use of invitations.

Q2′-1b, Q2′-2, PG-9, PR-B, A3, A4 and G4-C remain on HOLD.

## 21. Q2′-2 workspace domains and site diagnostics — local implementation only

- **As of:** 2026-11-03
- **Base:** `main` at `62cf0c4` (#101, the SV1 harness, merged after #100).
  Section 20's header predates two merges: #100 merged at `c5250b9` and
  #101 at `62cf0c4`. Q2′-1 is merged but **not applied to any Supabase
  project**.
- **Status:** two local commits on `feat/q2p2-domains-diagnostics`:
  `e28cf3b` (the implementation) and the remediation commit that answers its
  independent review (21.5). **Not pushed, no pull request.** The review of
  `e28cf3b` requested changes; the remediation awaits its own independent
  review. No SQL from this
  branch has run against any Supabase project; it has run only in disposable
  local databases (plain PostgreSQL containers with `--network none`, and the
  disposable local Supabase stack of SV1).
- **Authorisation:** Founder code authorisation for the Q2′-2 local
  implementation only, with decisions Q2-R1 to Q2-R4 (D-043). It authorises no
  push, pull request, merge, deployment, production SQL, W1 or V1d code, AI
  call or billing.
- **Scope:** one migration,
  `supabase/migrations/20261103173000_q2p2_domains_and_site_diagnostics.sql`
  (8 closed tables, 16 internal functions; D-043), and its tests. The 11
  allowlisted paths are exactly: the migration;
  `scripts/test-q2p2-schema-contract.ts`; `scripts/test-q2p2-scope.ts`;
  `.github/workflows/q2p2-scope.yml`; `.github/workflows/q2p-schema-contract.yml`;
  `scripts/sql/level2-q2p2-fixtures.sql`;
  `scripts/test-snapshot-worker-postgres-level2.sh`;
  `scripts/test-q2p-supabase-stack-sv1.ts`; `package.json`; this file; and
  `docs/DECISIONS.md`. Nothing is wired into a route, page, worker or
  workflow other than the test workflows.

### 21.1 What the migration adds

- **Domain verification:** `workspace_domains` (append-only; one row per
  workspace and domain; the same domain may be claimed by several workspaces),
  `workspace_domain_state` (the per-domain serialisation row; a function of
  the event log: an update may only advance `seq` to an existing event, and
  the guard derives every other column from that event and the shared
  transition function `_q2p2_next_status`), `workspace_domain_challenges`
  (hash only, 48-hour maximum lifetime, issued once, consumed once and only
  for the success event the state has applied) and
  `workspace_domain_verification_events` (append-only, gap-free `seq` per
  domain, exact transition matrix, stale-observation refusals).
- **Read helper:** `_q2p2_domain_verified(domain)` locks the state `FOR SHARE`
  and is true only while verified and before `recheck_due_at` (30 days after
  the observation; fail closed).
- **Site diagnostics:** `site_diagnostic_runs` (a run may cite only the
  domain's current verification; workspace-isolated cache; completed runs
  frozen; re-runs supersede within one workspace and project),
  `site_diagnostic_pages` (sanitised URLs only, no bodies, at most 10 pages)
  and `site_diagnostic_findings` (`unknown_reason` exactly when the state is
  unknown; excerpts only as a complete bundle with hash, offsets and a
  personal-data screen version; `detail` must match the approved spec of its
  own check and rule version, and the registry ships empty, so only a null
  `detail` can be stored until a check's vocabulary is approved (21.6)).
- **Stored domain form:** lowercase LDH labels of 1 to 63 characters, 4 to
  253 in all; no `--` in positions 3 and 4 except the `xn--` A-label prefix;
  the last label alphabetic or an A-label (IDNA TLDs accepted). The A-label's
  shape is checked, not its Punycode (V1d converts and validates).
- **Rate limits:** `diagnostic_rate_limit_events` (keyed 64-hex buckets under
  the purpose label `zypact.diag.rate_limit.v1`, at most 48 hours, no foreign
  key, no update, delete only once expired) and the cleanup
  `_q2p2_purge_rate_limit_events()`, the only `SECURITY DEFINER` function.
- **Closed:** RLS on with no policies; no table, sequence or function
  privilege for `anon`, `authenticated` or `service_role`.

### 21.2 Commands and local results

On the uncommitted remediation tree that became the remediation commit, macOS
with Colima. The results at `e28cf3b` are in 21.5.

| Command | Result |
|---|---|
| `npm run test:q2p2-schema` (static, with mutation self-tests) | 187/187 (55 mutations, each refused by its detector) |
| `npm run test:q2p-schema` (Q2′-1, unchanged) | 207/207 |
| `Q2P2_SCOPE_BASE=62cf0c4 npm run test:q2p2-scope` | PASS, 11 paths; the negative matrix T2–T8 at `e28cf3b` each failed closed (missing base, bad base, an app file, a doc outside the allowlist, a second Q2′-2 migration, an edited existing migration, a PG-9 path); an mtime-only touch is not a change |
| Level 2, PostgreSQL 16 (pinned digest, `--network none`) | 805 passed, 0 failed (the previous 634 plus 171 QR2 assertions) |
| Production-order variant, PostgreSQL 17.6, run 1 / run 2 | 605/0 and 605/0 (554 plus the same 51 new QR2 assertions); P0–P5, QR-35 and QR2-35 pass; schema equals CI order (P4) and is identical across runs |
| SV1, disposable local Supabase stack (CLI 2.111.0), run 1 / run 2 | 172 PASS, 0 FAIL, 0 NOT ESTABLISHED, 12 INFO in each; 14 Q2′-2 functions closed to every API role (SV1-72, SV1-79); the manifest (SV1-90) 183/183; SV1-66 and SV1-67 pass; no non-local fetch |
| `npm run build:verify` / `npm run typecheck` | pass / pass |
| Offline regressions (9 M0, 16 QX-03, 21 B1 suites) | exit codes identical to the `e28cf3b` run, and no change from `main` at `62cf0c4` (below) |

- **Production order (D-041), generated variant, not committed:** 0001–0080;
  0081's content recorded as `20260924023646`; **0083 first** by the
  reserved-version procedure (`expected_tail` `20260924023646`; the tail stays
  the alias); Q2′-1 by the named-file procedure (`expected_prev`
  `20260924023646`); then Q2′-2 by the named-file procedure (`expected_prev`
  `20261102132000`). Q2′-2 with the wrong predecessor is refused and records
  nothing; a second apply is refused; the ledger statements equal the file
  bytes; 84 rows. QR2-35 proves every function, column, constraint, trigger
  and table grant that existed before Q2′-2, Q2′-1's included, is unchanged.
  The full schema equals CI's lexical order. (Section 20's Q2′-1 evidence used
  the older fallback order, 0083 after Q2′-1.)
- **Pre-existing failures, identical on clean `main` at `62cf0c4`:**
  `snapshot-send-idempotency` (6/24), `pg9-harness-offline` (200/221; fails
  closed on timestamped migrations by design, D-041), `m7-0071-schema` (2) and
  `m7-0073-schema` (1) ("no later migration" guards that see 0077). Two runtime
  contracts SKIP without their opt-in. **Branch-dependent:** `bqi-wording`
  P-04 passes on `main` but fails on any non-BQI branch (it allows only Q1's
  paths against `origin/main`; not in CI), as it did on the Q2′-1 branch.
- **SV1 extension:** Phase A applies Q2′-2 by the named-file procedure after
  Q2′-1 (SV1-68, a second apply refused SV1-69). New checks, in both phases
  and both key models where they use the API: the Q2′-2 catalog (SV1-70 to
  SV1-75), REST reads and writes (SV1-76, SV1-77), direct GraphQL with the
  existing positive control (SV1-78), RPC (SV1-79), OpenAPI for all three
  roles (SV1-80) and the rate-limit purge on the real stack (SV1-81). Every
  existing assertion is kept. **SV1-90** is a fail-closed manifest: a
  mandatory assertion that is missing, an unlisted or duplicated one, or a
  mandatory one recorded as INFO fails the run. SV1-90a proves the check
  rejects each of those mutations before any stack starts. This closes H2.
- **One development failure, fixed in the harness:** the first SV1 run failed
  SV1-77 for `diagnostic_rate_limit_events` (POST and PATCH answered
  `428C9`). The write probe used the table's first column, an identity
  column, which PostgreSQL refuses before checking privileges, so the probe
  never reached the privilege check. The probe now uses the first column
  that is neither identity nor generated; for every Q2′-1 table that is the
  same column as before. Nothing was written, and all reads, GraphQL and RPC
  were refused in that run. The two runs above are after the fix.
- `test:q2p1-scope` fails on this diff, as designed; its workflow runs only
  when the Q2′-1 migration is in the diff, so CI does not run it here.

### 21.3 Known limitations

1. **No writer path.** No RPC issues challenges, records observations, starts
   runs or writes rate-limit rows. W1 and V1d must add them, and must call
   `_q2p2_domain_verified` (or lock the state `FOR SHARE`) at their decision
   instant.
2. **No observation.** Nothing fetches DNS, files or pages. The schema
   constrains what may be stored, not whether an observation is true.
3. **Purge not scheduled.** The cleanup exists and is tested; scheduling it is
   a gate before customer use (Q2-R4).
4. **Key reuse needs review.** Q2-R2 reuse of the IP hash secret needs a legal
   and security review (with D5), and environment isolation is a deployment
   duty the schema cannot enforce. `snapshot_requests.request_ip_hash` (0018)
   remains a permanent keyed IP hash, out of Q2′-2 scope.
5. **Clock trust.** Freshness and expiry use the database clock; an observer
   that reports `checked_at` is trusted within the 10-minute window.
6. **A re-check needs a new challenge.** The standing-proof re-check that
   Revision 2 allowed is not implemented: every `verification_succeeded`
   must cite the domain's current, unconsumed challenge. This is stricter,
   not weaker.
7. **SV1 limits remain:** H1 (the network guard covers only Node `fetch`).
   H2 (an assertion removed from both phases) is closed by the SV1-90
   manifest. The manifest requires both key models; a stack without the new
   key model fails SV1-90 rather than passing with fewer checks.
8. **Not run in CI:** SV1 is local and opt-in. The production-order variant
   is generated from the harness and not committed.

### 21.4 Remaining gates before production

> **2026-11-17 note:** written before the applies. The preflight ran on 2026-11-09 and 0083, Q2′-1 and Q2′-2 (then S1) were applied to production on 2026-11-09 and 2026-11-10 (§25).

Each needs its own authorisation: independent review of this commit; push and
a pull request (CI will apply the migration to disposable PostgreSQL in the
Level 2 job, so the Founder is notified in advance); merge; the read-only
production preflight; 0083, then Q2′-1, then Q2′-2 applied to production by
the D-041 procedures; S1 and G1 before any customer-facing W1 or V1d.

Q2′-1b, Q2′-2 production, PG-9, PR-B, A3, A4, G4-C, 0083 production, every
production apply and any AI marketing analysis remain on HOLD.

### 21.5 Independent review of `e28cf3b` and its remediation

- **Verdict at `e28cf3b`: REQUEST CHANGES.** The checksums, the 11-path scope,
  the test logs and the pre-existing regression baseline were confirmed.
  Findings:
  1. The state and challenge guards relied on `pg_trigger_depth() >= 2`.
     That proves only that some trigger is running, not that the
     verification-event trigger made the write.
  2. `site_diagnostic_findings.detail` accepted arbitrary JSON up to 4 KB,
     which did not enforce the no-page-body, no-sensitive-data boundary.
  3. The stated domain form ("IDNA A-labels allowed") did not match the
     regex, which refused A-label TLDs such as `xn--p1ai`.
- **Corrections** (same 11 paths; D-043):
  1. The state is a function of the event log. An update may change only
     `seq`, to `old.seq + 1`, and only when that event exists for the domain
     and workspace; the guard derives every other column from the event and
     the shared transition function. The event trigger validates BEFORE
     INSERT under the state lock and advances the state AFTER INSERT, writing
     only `seq`. Consumption is allowed only for the success event the state
     has applied. Three new functions: `_q2p2_next_status`,
     `_q2p2_advance_domain_state` and `_q2p2_finding_detail_is_safe` (14 in
     all).
  2. `detail` must pass `_q2p2_finding_detail_is_safe` as well as the size
     cap.
  3. The regex and the stated form now agree, and both are in the migration.
- **New evidence:**
  - **QR2-18**, an unrelated trigger on a fixture table whose writes reach
    the guards at depth 2. It cannot advance the state without an event,
    forge a verified state, consume the current challenge, create a state
    row for a missing domain, or delete the state. With the guards exactly
    as reviewed at `e28cf3b`, the same trigger forges a verified state and
    consumes the challenge. The real guards are restored and the domain
    still verifies through its own event.
  - **QR2-19**: 21 `detail` cases (one accepted, 20 refused: free text,
    email, URL, phone numbers as text and as a number, HTML, case, length,
    nesting, null, key form, decimals, top-level shape, empty, key and array
    counts). A schema-valid detail over 4 KB is refused by the size cap.
  - **QR2-20**: 15 domain forms, and an IDNA-TLD domain stored.
  - **QR2-21**: every stored state equals the replay of its own event log.
  - The static contract gained 40 checks, including 13 new mutation
    self-tests.
- **Changed expectation:** in QR2-05's weakened case (the state read without
  `FOR UPDATE`), the stale writer is now stopped by the unique
  `(domain_id, seq)` index (23505) rather than by the old state guard
  (55000). The point of that case is unchanged: without the lock the refusal
  is not a retryable 40001.
- **Two defects in my own tests, found and fixed during the remediation:**
  - **The static contract's comment stripper** removed `--` to end of line
    even inside string literals, which truncated the `xn--` regex. It now
    keeps `--` inside single-quoted strings.
  - **The first remediation Level 2 run** reported 772/0. Its new case tables
    were driven by `while read … <<heredoc`, and the `docker exec -i` inside
    each assertion consumed the rest of the heredoc, so only the first case
    of QR2-19 and of QR2-20 ran. The tables are now arrays, and each has an
    assertion that all of its cases ran. The 805/0 run is after that fix.
    The one older `while read` loop (QR-40) calls no `docker exec` in its
    body, and all 9 of its vectors appear in the log.
- **Residuals:**
  - The generic `detail` shape left one lowercase word as a possible value.
    This became the merge blocker and is answered by 21.6.
  - Owner-level trigger bypass (disabling triggers, `session_replication_role
    = replica`) remains outside what any table guard can stop; no API role
    can do it.

### 21.6 Merge blocker: per-check `detail` validation (local correction)

- **Blocker (Founder, draft PR #102 stage):** diagnostic `detail` fields must
  enforce an approved per-check schema that prevents sensitive values from
  being persisted. That needs a separate correction and an independent review
  before merge.
- **Base:** `84f26ff`, the head of draft PR #102. The correction is one local
  commit on top. It is not pushed.
- **Correction** (same 11 paths; D-043):
  - `_q2p2_finding_detail_is_safe` (a generic shape) is replaced by three
    functions, 16 in all:
    - `_q2p2_finding_detail_spec(check_id, rule_version)`, the registry;
    - `_q2p2_detail_matches_spec(spec, detail)`;
    - `_q2p2_finding_detail_is_valid(check_id, rule_version, detail)`.
  - The table constraint `site_diagnostic_findings_detail_per_check` applies
    them with the 4 KB cap.
- **Fail-closed default:** the registry returns no spec for any check, so
  every non-null `detail` is refused. No field was invented. The check
  vocabulary is not yet defined; it belongs to W1's check catalogue.
- **Schema decision needed:** approve, per check and rule version, its fields,
  types, token lists and each count's `max` (at most 10 000). Each approval is
  a later migration that replaces the registry, and it goes through
  independent review.
- **What a spec can allow:** booleans, bounded integer counts, ratios 0 to 1,
  and tokens from a field's own list. It cannot allow free text, free
  numbers, arbitrary identifiers, URLs, addresses, nulls or nesting. A
  malformed spec matches nothing.
- **Development defect, fixed:** the first Level 2 run aborted before any
  QR2 case. In the new fixture `level2_q2p2.with_spec`, the inner text
  `$b$$f$` contained `$$`, which closed the fixture's own `$$` body. The
  fixture body now uses `$ws$`. The aborted log is kept in the evidence.
- **Tests:**
  - **QR2-19:** the registry is empty for every probed check and version; a
    null `detail` is stored, and a well-formed one is refused.
  - With a fixture spec (installed for one rolled-back statement):
    - a matching detail and a subset are accepted;
    - the same detail under another rule version or another check is
      refused;
    - 20 refused cases, among them a 10-digit and a 9-digit number as
      counts, an arbitrary identifier, and email, URL and free text;
    - 5 malformed specs match nothing;
    - the empty registry is back afterwards.
  - **QR2-13:** a spec-valid detail over 4 KB is refused by the size cap.
  - **Static contract:** QS2-21 is rewritten as 9 detectors with 11
    mutation self-tests.
  - **SV1:** expects 16 closed functions.
- **Residual:**
  - A count is still a number up to its field's `max`. An approved spec must
    not declare a count where a 1- to 5-digit value could identify a
    person; that is part of each spec's review.
  - Owner-level trigger bypass remains outside any table guard.

| Command | Result |
|---|---|
| `npm run test:q2p2-schema` / `npm run test:q2p-schema` | 206/206 (62 mutation self-tests) / 207/207 |
| `Q2P2_SCOPE_BASE=62cf0c4 npm run test:q2p2-scope` | PASS, 11 paths |
| Level 2, PostgreSQL 16 | 818 passed, 0 failed (QR2-19 now 35 assertions, replacing 22) |
| Production-order variant, PostgreSQL 17.6, run 1 / run 2 | 618/0 and 618/0; P0–P5, QR-35, QR2-35 and P4 pass; schemas identical across runs |
| SV1, disposable local Supabase stack, run 1 / run 2 | 172 PASS, 0 FAIL, 0 NOT ESTABLISHED, 12 INFO in each; 16 functions closed; manifest 183/183 |
| `npm run build:verify` / `npm run typecheck` | pass / pass |
| Offline regressions (9 M0, 16 QX-03, 21 B1 suites) | exit codes identical to the `84f26ff` run (only the pre-existing failures) |

## 22. W1 Website Buyer-Readiness Diagnostic — offline engine and founder preview, draft PR, not merged, not deployed

Recorded 2026-11-05 on branch `feat/w1-website-diagnostic`, base `main` @ `5851f3d` (PR #102).
Scope chosen 2026-11-04 under the Technical Co-founder handoff of 2026-11-03 (§7, §13): W1-A
(check catalogue and rules), W1-B (robots-aware bounded crawler) and W1-C (immutable report,
exports), plus a founder-only stateless preview behind a default-off kill switch. **Not in
scope and still gated:** W1-D (writer RPCs, run persistence, customer UI, release controls), S1,
G1, any migration, any production change. Design and the decisions needed:
[`W1_WEBSITE_DIAGNOSTIC.md`](W1_WEBSITE_DIAGNOSTIC.md).

### 22.1 Status notes

- PRs #100, #101 and #102 are merged (`c5250b9`, `62cf0c4`, `5851f3d`). The "not merged / not
  pushed" headings in sections 20 and 21, and D-042 and D-043, are historical. Neither Q2′
  migration is applied to any hosted database.
- No migration is added. The Q2′-2 detail registry stays empty, so W1 findings would persist
  with `detail = NULL`.
- Shared modules: `lib/crawler/safe-fetch.ts` gains optional, default-preserving options and
  `safeFetchOnce`; `lib/crawler/outbound-url-safety.ts` is strictly tighter (IPv6 allow-list
  `2000::/3`, plus `192.88.99.0/24`). `lib/crawler/crawl-site.ts` is unchanged.
- The preview route makes live outbound requests only when `ZYPACT_W1_PREVIEW_ENABLED=true`.

### 22.2 Commands added

| Command | Result on this branch |
| --- | --- |
| `npm run test:w1-contract` | 294/294 |
| `npm run test:w1-robots` | 46/46 |
| `npm run test:w1-safe-fetch` | 15/15 (127.0.0.1 only) |
| `npm run test:w1-crawl` | 59/59 |
| `npm run test:w1-report` | 71/71 |
| `npm run test:w1-preview` | 26/26 |
| `npm run test:outbound-url-safety` (existing suite, now registered) | ALL PASS |
| `npm run test:crawl-apex-www-fallback` (existing suite, now registered) | ALL PASS |
| `npm run test:w1` (all eight) | pass |
| `npm run w1:diagnose -- <url>` | CLI; live run against www.zypact.com completed (4 pages, 7 requests) |

Inventory on this branch: 117 `test:*` and 4 `verify:*` commands, 202 `scripts/test-*.ts` files,
84 migrations. This supersedes the counts in §20.3 (main at `5851f3d` has 108 / 4 / 196 / 84).

### 22.3 Regression runs (local; none of these runs in CI)

`npm run typecheck` pass; `npm run build:verify` pass; `test:q2p2-schema` and `test:q2p-schema`
pass; `test:landing-page`, `test:intervention-page`, `test:bqi-candidates`, `test:bqi-selection`
pass. Pre-existing on `main`, not caused by this change: `test:seo` 61/63 (legacy-route 410
cases), and `test:paid-execution-guards` 129/132 on Windows. The latter's three failing checks
compare path lists with `\` separators, and the W1 route appears in none of them.

### 22.4 What these tests do not establish

Behaviour against the open web at scale; hosted Vercel or Supabase behaviour; the deployment
plan's real function duration limit; that the D11 claim-language review, the D5 privacy review
or the founder's approval of the catalogue and fetch bounds have happened. They have not.

## 23. Source insights — provider sources in the report and Outcome Card, draft PR, not merged, not deployed

**Branch:** `feat/source-insights`, based on `main` at `10630aa`. **Decision:** D-044, approved by the Founder on 2026-11-09. Built ahead of written authorisation at the engineer's request so the founder could review working code. Merged as PR #105 (`b6546f2`); **not deployed.**

**What changed:**

- `lib/source-insights/`: `extract-provider-sources.ts` (rule `provider-sources/1`), `source-types.ts` (list `source-types/1`), `build-source-insights.ts` (aggregation and the Outcome Card comparison). Pure; no provider, model, database or network import.
- `lib/reports/read-protocol-evidence.ts` also reads `probe_results.raw_response`. On protocol-worker rows this is the exact provider body, whose hash is `raw_response_sha256`.
- The protocol report payload gains an optional `sourceInsights`; the Outcome Card payload gains an optional `sourceComparison`. Both are additive. Reports and cards saved earlier still validate and render as before.
- The client report page, the full and short Markdown, the Outcome Card page and its Markdown show the new sections. When the section is present, the run table's "Sources" column shows the provider's cited and retrieved counts instead of the model-extracted count.
- `npm run source-insights:audit` is a read-only check of stored evidence that prints counts only.

**No migration, no new provider call, no model call, no crawler, no deployment.** No change to the worker, the paid-call path, the evidence tables or any RPC.

**Tests:** `npm run test:source-insights` — 82/82. Unchanged and passing: `test-build-protocol-report`, `test:outcome-card` (40/40), `test:outcome-card-build` (58/58), `test:outcome-card-view` (40/40), `test:outcome-card-delivery` (47/47), `test:outcome-card-integrity`, `test:outcome-card-email`, `test-compare-protocols` (66/66), `test-measurement-compatibility` (89/89), `test-perplexity-agent-adapter` (158/158), `test:report-pass` (38/38). `test-paid-execution-guards` is 129/132 and `test-0080-report-ready-contract` is 35/36, the same failures as on `main`.

**Audit (2026-11-09), `npm run source-insights:audit` against the Supabase project `zypact-staging`, which is the production database (D-041); read-only, counts only:** 45 protocol-worker rows read; 45 `ok` (every body re-hashed to its recorded SHA-256); all 45 `chat_completions`; 43 answers carry numbered references, 2 have sources but no references (disclosed in the section's notes); **0 unmatched references**; 294 cited and 436 retrieved-only sources. The rule behaves as designed on real Sonar responses.

**Done:** deploy the web app and the worker. Founder sign-off on D-044 and the `source-types/1` list: done, 2026-11-09. Read-only audit of production evidence: passed, 2026-11-09. Deployed 2026-11-09 and verified on a regenerated report (not sent).

**Deferred:** reading third-party pages, competitor websites as a source type, suggested actions, new providers or crawlers, any cross-question source score.

## 24. S1 customer accounts — draft PR, not merged, not applied anywhere, not deployed

**Branch:** `feat/s1-accounts`, based on `main` at `34a690e`. **Decision:** D-045, proposed. The founder approved building S1 and opening its pull request on 2026-11-09. That approval does not cover any database apply.

**What it adds:**

- **Migration `20261109120000_s1_account_sessions.sql`:**
  - two closed tables, `account_sessions` and `account_rate_limit_events`;
  - six functions only `service_role` may execute: `open_account_session`, `check_account_session`, `record_account_step_up`, `revoke_account_session`, `revoke_account_sessions_for_account`, `take_account_rate_limit`;
  - five `_s1_` helpers no role may execute, including the purge.
  - It changes no existing table, function or grant.
- **`lib/accounts/`:** configuration and policy, rate-limit keys, the service-role store, pure request handlers, and the Next.js adapter.
- **Routes:**
  - `/api/account/{sign-up,sign-in,sign-out,resend-verification,forgot-password,reset-password,step-up}` (POST, JSON only);
  - `/account/auth/callback` (GET, the email link).
- **Pages:** `/account`, `/account/sign-up`, `/account/sign-in`, `/account/verify`, `/account/forgot-password`, `/account/reset-password`. All are noindex and answer 404 unless `ZYPACT_ACCOUNTS_ENABLED=true`.
- **`.env.example`:** names the seven S1 variables, without values.

**Nothing changes for the founder:** `/login`, the founder guard, invitation sessions and every existing route are untouched.

**Tests (2026-11-09):**

- `npm run test:s1-schema`: **61/61**. Static, with every detector proven able to fail by a mutated copy of the migration.
- `npm run test:s1-accounts`: **71/71**. Handlers with fake Auth and store; policy, cookies, enumeration, the reset grant and step-up; static boundary checks.
- **Level 2 S1 cases (QS1-01 to QS1-15):**
  - Run locally against a disposable PostgreSQL 16 cluster with every migration applied: **67 QS1 checks pass** (70 including the harness's role checks).
  - A copy with the removal revocation disabled fails QS1-10 as expected.
  - The full harness runs in CI (`snapshot-worker-postgres-level2.yml`) when the PR opens.
- `npm run typecheck`: clean. `npm run build:verify`: passes.
- The account pages were rendered locally with accounts on. No form was submitted, because `.env.local` points at production Auth.
- Unchanged and the same as `main`:
  - `test:q2p-schema` and `test:q2p2-schema` pass;
  - `test:seo` 63/65 (the 2 trailing-slash and case 410 failures, as on `main`);
  - `test-paid-execution-guards` 129/132;
  - `test-m7-0071` / `0073`, `test-pg9-harness-offline` and `test-worker-image-provenance` fail exactly as on `main`.
- **Not run:** SV1 on a real local Supabase stack with GoTrue (needs Docker). The customer flow against a real Auth server has not been exercised end to end.

**Gates before customer use:** see D-045. They are:
- the founder authorises the production order (preflight, 0083, Q2′-1, Q2′-2, S1);
- the security review;
- the Supabase Auth settings and SMTP;
- the HMAC secret;
- the scheduled purge.

## 25. Production preflight written — not run against production

[`PROD_PREFLIGHT_SPEC.md`](PROD_PREFLIGHT_SPEC.md) and [`scripts/sql/prod-preflight.sql`](../scripts/sql/prod-preflight.sql) were added on 2026-11-09. D-041 and §20.6 referenced them, but they did not exist in the repository.

- **What it is:** a single read-only transaction, rolled back, that checks:
  - the cluster identity;
  - the migration ledger;
  - 0083's pinned pre-state;
  - that no Q2′-1, Q2′-2 or S1 object exists yet;
  - the API roles;
  - that no protocol job is running.
- **Local validation:**
  - **Clean copy:** on a disposable PostgreSQL 16 built to production's recorded state, all 15 must-pass checks pass.
  - **Changed copy:** after 0083 and Q2′-1 are applied, P2.4, P2.5, P3.1, P4.1 and P4.2 fail.
- **`npm run test:prod-preflight`: 15/15.** It keeps the script read-only and current with every timestamped migration, and two mutations prove it catches a commit and a write.
- **It has not been run against production.** Running it needs the founder's authorisation, and every apply after it needs its own.

**Founder decision, 2026-11-09 (written reply "I approve"):**

- **Approved:**
  - the S1 design (D-045);
  - a security review before customer use (the reviewer is not yet named);
  - running this preflight against production;
  - a real-login test on a non-production Supabase project before customer use.
- **Not approved by that reply:** any production apply. Each still needs its own authorisation.
- **Vercel:** the account block reported earlier the same day was resolved.

**Production preflight run, 2026-11-09 at 17:12 PST (founder-authorised, read-only):**

- **Result: all 15 must-pass checks PASS. 0 FAIL.**
- Run with `scripts/sql/prod-preflight.sql` at `main` `60720a2`, against `zypact-staging`, which is production.
- The server is PostgreSQL 17.6.
- **Ledger:** 81 rows; 0001–0080 plus the alias `20260924023646`, which is the tail. No held or pending version is recorded.
- **0083 pre-state:** `reconcile_attempt_for_job` has md5 `baaf43cc539611ec78fef9762c168a53`, which matches the reserved procedure's pin, and only `service_role` may execute it.
- **No Q2′-1, Q2′-2 or S1 object exists.**
- **Activity:** no protocol job is claimed or running.
- **The cluster system identifier** is recorded privately for the 0083 apply, not here.
- **Nothing was changed.**
- **Next gate:** the founder's authorisation of step 1, 0083 by the reserved-version procedure, with the worker stopped. Steps 2 to 4 (Q2′-1, Q2′-2, S1) each need their own.

**Q2′-1 applied to production, 2026-11-09 evening PST (founder-authorised: "I agree"):**

- **Procedure:** the D-041 named-file procedure, which is the body of `scripts/sql/sv1-apply-named-migration.sql` below its rehearsal header (sha256 `8a430331…`, matching the recorded source). It ran with `--single-transaction`, `new_version=20261102132000` and `expected_prev=20260924023646`.
- **Rehearsed first** on a disposable PostgreSQL built to the live state (0001–0081 plus 0083):
  - a wrong `expected_prev` was refused;
  - the apply succeeded;
  - a second apply was refused.
- **Live read-only pre-check** immediately before:
  - 0083 recorded, 82 ledger rows, tail `20260924023646`;
  - no Q2′-1 table present;
  - no protocol job claimed or running.
- **The apply was run by the engineer** from their own terminal.
- **Read-only verification afterwards:**
  - `20261102132000` is recorded; the ledger has 83 rows with that version as the tail;
  - all 15 Q2′-1 tables exist, each with RLS on and no policy;
  - no API role holds any table privilege;
  - the five founder/system functions are executable by `service_role` only;
  - no API role may execute the `_q2p_` helpers or `assert_current_account_member`.
- **Next:** Q2′-2 (`20261103173000`, `expected_prev=20261102132000`), then S1 (`20261109120000`, `expected_prev=20261103173000`). Each needs its own founder authorisation.

**Q2′-2 applied to production, 2026-11-09 evening PST (founder-authorised: "I agree"):**

- **Procedure:** the D-041 named-file procedure (the same verified copy, sha256 `8a430331…`), with `new_version=20261103173000` and `expected_prev=20261102132000`.
- **Rehearsed first** on a disposable PostgreSQL built to the live state (0001–0081, 0083 and Q2′-1):
  - a wrong `expected_prev` was refused;
  - the apply succeeded;
  - a second apply was refused.
- **Live read-only pre-check:**
  - 83 ledger rows, tail `20261102132000`;
  - Q2′-1 tables present;
  - no Q2′-2 table yet;
  - no protocol job claimed or running.
- **The apply was run by the engineer.**
- **Read-only verification afterwards:**
  - `20261103173000` is recorded; the ledger has 84 rows with that version as the tail;
  - all 8 Q2′-2 tables exist, each with RLS on and no policy;
  - no API role holds any table privilege or any privilege on `diagnostic_rate_limit_events_id_seq`;
  - all 16 `_q2p2_` helpers exist, and no API role may execute them.
- **The Q2′-2 production HOLD is lifted.** Still open as a gate before customer use: scheduling `_q2p2_purge_rate_limit_events()` (Q2-R4).
- **Next:** S1 (`20261109120000`, `expected_prev=20261103173000`). That needs its own founder authorisation.

**S1 applied to production, 2026-11-10 PST (founder-authorised: "agree"):**

- **The file applied** is the corrected one from PR #113 (`6bd179f`): it also revokes `account_rate_limit_events_id_seq` from the API roles.
- **Procedure:** the D-041 named-file procedure (the verified copy, sha256 `8a430331…`), with `new_version=20261109120000` and `expected_prev=20261103173000`.
- **Rehearsed first** on a disposable PostgreSQL built to the live state **with Supabase-like default privileges**:
  - a wrong `expected_prev` was refused;
  - the apply succeeded;
  - a second apply was refused.
- **Live read-only pre-check:** 84 ledger rows, tail `20261103173000`, no S1 table, no protocol job claimed or running.
- **The apply was run by the engineer.**
- **Read-only verification afterwards:**
  - `20261109120000` is recorded; the ledger has 85 rows with that version as the tail;
  - both S1 tables exist with RLS on and no policy;
  - no API-role privilege on either table or on the identity sequence;
  - the 6 S1 functions are executable by `service_role` only;
  - the 5 `_s1_` helpers exist, and no API role may execute them;
  - `account_sessions` is empty.
- **The production database order of D-045 gate 1 is complete:** 0083, Q2′-1, Q2′-2 and S1 are all applied.
- **The account area is still off** (`ZYPACT_ACCOUNTS_ENABLED` unset).
- **Still open before any customer use (D-045):**
  - the S1 security review (reviewer not yet named);
  - the real-login test on a non-production Supabase project;
  - Supabase Auth settings and SMTP;
  - `ZYPACT_ACCOUNT_HMAC_SECRET`;
  - scheduling `_s1_purge_account_rate_limit_events()` and `_q2p2_purge_rate_limit_events()`.

**S1 real-login check on a non-production Supabase project, 2026-11-10 (founder-approved; CURRENT_STATUS §20.6 gate 6):**

- **The test project:** `zypact-s1-test` is a separate project in its own organisation, on PostgreSQL 17.11. It is not `zypact-staging`; the script refuses to run if any setting names the live project.
- **The database changes:** all 85 migration files were applied to it in production order.
- **On real Supabase,** whose default privileges grant API roles automatically, these all count 0:
  - API-role privileges on the Q2′ and S1 tables;
  - API-role privileges on both identity sequences, which confirms the #113 fix;
  - `authenticated` execute rights on the S1 functions.
- **Result: `ZYPACT_S1_REAL_AUTH=1 npm run s1:real-auth-check` passed 20/20.** It drives the real S1 handlers with the real store and the project's real GoTrue:
  - **Sign-up and access:**
    - an unapproved email creates no Auth user;
    - an unverified sign-in is refused, with no workspace;
    - the email is verified through a real verification token;
    - the first verified sign-in creates exactly one workspace and opens a session that resolves through the real JWT;
    - a second sign-in creates no second workspace;
    - a wrong password gets one generic 401;
    - a verified but unapproved user gets no workspace or session.
  - **Sessions:**
    - a session token presented with another user's identity resolves to nothing;
    - step-up refuses a wrong password and records a correct one;
    - every Q2′ and S1 table and function is refused to anon and to signed-in browser tokens through the real API gateway;
    - sign-out revokes the session.
  - **Password reset:** a reset without the grant is refused; with it, the password changes and every session is revoked.
  - **Rate limits:** the sign-in email bucket refuses the 11th attempt.
- **Found and fixed:** with Confirm email on, Supabase Auth itself refuses an unverified sign-in (`email_not_confirmed`). S1 had shown "Email or password is incorrect". It now answers "Verify your email first" (unit check H8b).
- **Not exercised:**
  - real email delivery: users were created and verified through the admin `generateLink` API, because the default sender only mails team members;
  - the PKCE `exchangeCode` callback;
  - the Next.js cookie adapter end to end.

  These depend on production SMTP and a deployed environment, and remain part of the customer-use gates (D-045).

## 26. P1 + P2 workspace (D-046, D-047, approved 2026-11-10) — merged through #117, not applied anywhere, not deployed

- **History:** P2 was built in #116 on `feat/p1-workspace`, and both merged into `main` through #117. D-046 and D-047 were approved by the Founder on 2026-11-10, with the rulings recorded in D-047: Stripe, and paid paths built but switched off.
- **What it adds:**
  - customer pages for P1 (Overview, Website, Brand profile with the objective step);
  - P2 draft buyer questions, the action log, and a copyable Team Brief;
  - a Sources page that states what it will hold;
  - migration `20261111120000_p2_workspace_drafts_actions.sql`.
  - No paid call, no model call, no measurement.
- **Commands and local results (2026-11-10):**

| Command | Result |
|---|---|
| `npm run test:p2-workspace` | 107/107 (offline; suggestions, overlaps, parsing, investigations, comparison, brief, handlers, request-size caps, claim-language lint) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | 71/71 on a disposable `supabase/postgres:17.6.1.167` with all 87 migrations applied |
| `npm run typecheck` | pass |
| `npm run build:verify` | pass |
| `npm run test:s1-schema` | 63/63 |
| `npm run test:q2p2-schema` | pass |
| `npm run test:w1` | pass |
| `npm run test:s1-accounts` | 74/74. S1 and S5 now separate S1's own modules (still barred from the diagnostic and the workspace) from workspace routes and pages (`workspacePost`; the diagnostic allowed; models, probes, workers, pipeline and legacy DB still barred) |
| `npm run test:p1-workspace` | 27/27 (P1 handlers, offline) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` (P1 part) | 45/45 (`scripts/test-p1-workspace-db.ts`) |

- **Not established:**
  - no browser walk-through of the pages against a running Supabase stack;
  - no concurrency test of the draft and action caps (they rely on P1's per-workspace advisory lock);
  - no Supabase-stack (SV1-style) run of the P2 objects.
- **Gates before customer use:** the D-045 gates, then named-file applies under D-041 for P1 and P2, each separately authorised.

## 27. E1 plans and usage (D-048) — branch `feat/e1-plans-usage`, not applied anywhere, paid measurement off

- **What it adds:**
  - Free and Starter allowances, enforced in the database;
  - append-only plan assignments;
  - a usage ledger in which every run is reserved before any attempt, then consumed or released;
  - a founder paid-measurement switch, off by default;
  - the `/account/plan` page.
- **Not connected yet:** no measurement path calls the ledger, and Stripe is not connected.
- **Commands and local results (2026-11-10):**

| Command | Result |
|---|---|
| `npm run test:e1-plans` | 52/52 |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74 (all 88 migrations applied) |
| `npm run test:prod-preflight` | pass (E1's version, 3 tables, 5 functions and `_e1_` listed) |

## 28. Q4 question approval and activation (D-049) — branch `feat/q4-question-activation`, not applied anywhere

- **What it adds:**
  - customers approve drafts into M4 buyer-question versions in their own project, with a step-up and a consent record;
  - the plan's active-question limit;
  - changed wording becomes a new version;
  - archive and reactivation;
  - an Active questions section on `/account/questions`.
- **Not connected yet:** nothing measures active questions.
- **Commands and local results (2026-11-10):**

| Command | Result |
|---|---|
| `npm run test:q4-activation` | 42/42 |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74, Q4 52/52 (all 89 migrations applied) |
| `npm run test:prod-preflight` | pass (Q4's version, 2 tables, 3 functions and `_q4_` listed) |

## 29. X1 ChatGPT adapter and model benchmark (D-050) — branch `feat/x1-chatgpt-adapter`, not wired, benchmark calls only

- **What it adds:**
  - `lib/probes/chatgpt.ts`, the OpenAI Responses API with web search under versioned settings (`auto` for monitoring, `required` as a separate protocol). `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05` is approved for measurement (2026-11-17); the adapter is not wired.
  - `lib/probes/chatgpt-pricing.ts`, usage capture and cost estimation from the dated price table. Unknown, never $0.
  - `scripts/benchmark-chatgpt-models.ts`, a dry run by default. It compares candidate models against the `chat-latest` reference:
    - candidates: `gpt-6-luna`, `gpt-6.1-terra`, and, from 2026-11-11, the dated snapshots `gpt-5.5-2026-04-23` and `gpt-5.4-2026-03-05`;
    - question sets: `general`, `smaller-vendor` or both, with per-model repeats;
    - spending: a $40 lifetime ceiling counted from every recorded run.
  - The validity note `docs/ADAPTER_VALIDITY_CHATGPT.md`, recording the founder's 2026-11-10 decisions.
- **Model choice (2026-11-13):**
  - The founder chose `gpt-5.4-2026-03-05` on 2026-11-13. On 2026-11-17, after the confirmation run passed, the founder approved its flex setting for measurement, and `CHATGPT_APPROVED_SETTING_VERSION` now names it. Nothing calls the adapter until it is wired.
  - Its new setting, `openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05`, raises the output cap from 4,000 to 8,000 tokens. It is the version to approve if the confirmation run passes, and the 4,000-cap setting can never be approved.
  - A 60-run confirmation run with a $12 cap was prepared under that setting and never run. On 2026-11-17 the founder agreed to run it on OpenAI's half-price flex tier and added OpenAI credit. The run now uses `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05` (the `v3` setting plus `service_tier: "flex"`), which is the version to approve if it passes.
  - Wiring this model into the worker would need longer worker time limits than the present 45 seconds per provider call. That is a separate decision; see D-050.
- **Not connected:**
  - the worker refuses provider `openai_chatgpt`;
  - no web entry point or other app module imports the adapter;
  - `OPENAI_PROBE_API_KEY` appears in no deployment configuration in the repository, and this work did not add it to Vercel or Fly. It is used only for local benchmark runs.
- **Commands and local results (2026-11-13 unless dated otherwise):**

| Command | Result |
|---|---|
| `npm run test:chatgpt-adapter` | 182/182 on 2026-11-13; 193/193 on 2026-11-17 with the `v4` (flex) setting |
| Mutation check of that suite, in a scratch copy: 79 deliberate single-line defects, one at a time | the suite failed on all 79 |
| Live benchmark, 2026-11-11, founder-confirmed budget | 124 of 150 runs reached the models before the account credit ran out; estimated spend $5.73 plus $0.22 for the smoke test; results in the validity note |
| `npm run benchmark:chatgpt-models` (dry run, no flags) | prints the plan for all five models: 250 runs, over the 150-run limit, so a live run of it would be refused; no call |
| Smaller-vendor validation dry run, 2026-11-11 (`--question-set=smaller-vendor`, 110 runs, `--max-usd=10`) | plan and lifetime ledger printed, no call |
| Smaller-vendor validation, live, 2026-11-11 (founder-approved $10 phase) | 84 of 110 runs before the $10 cap stopped it as designed; estimated spend $9.41 (lifetime $15.35 of $40); results and blind review in the validity note; recommendation `gpt-5.4-2026-03-05` |
| Confirmation dry run (`--models=gpt-5.4-2026-03-05 --question-set=general,smaller-vendor --repeats=3 --max-failed=3 --max-usd=12`) | 60 runs under the `v3` setting; projected $9.05, worst case $0.54 per run; lifetime $15.35 spent, $24.65 left; no call |
| The same dry run on 2026-11-17, under the `v4` (flex) setting | 60 runs; projected $7.68 at the upper bound ($5.98 if flex halves the input tokens too), worst case $0.54 per run, deadline 290 s per call; lifetime $15.35 spent, $24.65 left; no call |
| Confirmation run, live, 2026-11-17 (founder-authorised, $12 cap, flex) | 60 of 60 usable, all served on flex by `gpt-5.4-2026-03-05`, 0 at the 8,000 cap, slowest 145 s, estimated $5.64 (upper bound); all seven criteria pass; lifetime $20.9955 of $40 over 297 runs; results in the validity note |
| Offline simulation of the live loop, in a scratch copy with a stand-in provider (no network, fake key) | each of these behaved as designed: a complete run; a run cut off at the cap; repeated and alternating failures; a rejected request; a deadline; an overrun; a budget stop; a credit refusal; resume under one cap, with the failure count carried over; a resume refused past the failure limit or with a higher cap; a second resume of the same run; two runs at once; a killed process; missing earlier output; a damaged ledger. Not a validation against OpenAI |
| `npm run test:paid-execution-guards` | 143/143 |
| `npm run test:perplexity-agent-adapter` | 158/158 |
| `npm run test:measurement-compatibility` | 89/89 |
| `npm run test:s1-accounts` | 74/74 |
| `npm run typecheck`, `npm run build:verify` | pass |

## 30. Pilot Mode (D-051, D-052, D-053) — decisions recorded; step 1 on branch `feat/pilot-mode-phase1`, not applied anywhere, not deployed

- **Decision (D-051, 2026-11-14):**
  - the team may run paid pilot measurements, and the self-test retest, under today's controls with a worker daily ceiling the founder confirms (10 USD proposed);
  - Perplexity only;
  - Pilot Mode rules: a results-only login comes before customer spend authorisation, the team confirms website ownership, written approvals are kept, one login per customer;
  - each production step is authorised when it comes.

  Still open: pilot terms, a named security reviewer, and the ChatGPT confirmation test.
- **Decision (D-053, 2026-11-16 and 2026-11-17):**
  - a 1,500 USD pilot with both engines;
  - 15 questions (20 at most), 5 answers per question per engine, a retest of up to 5 questions on both engines, 90 days;
  - recommended actions written by the team, each linked to its evidence;
  - the 60-point retest limit in the pilot terms;
  - a 10 USD daily ceiling;
  - ChatGPT on OpenAI's flex tier;
  - the offer's wording.

  ChatGPT measures nothing for a pilot until it is confirmed, approved, wired and deployed. Still open: the security reviewer.

  Not built for the pilot:
  - one project holding all the questions;
  - the combined pilot report;
  - recommended actions;
  - ChatGPT in the worker;
  - the customer login.
- **The assessment, in brief:** no rebuild is needed. The founder-operated engine and the customer account area both exist and are not connected: nothing calls `assign_project_to_workspace`, and no session-checked read of reports or Outcome Cards exists. The work, in order:
  1. **Before the first paid pilot:** step 1, below.
  2. **The customer login:**
     - enable the account area: the P1, P2, E1 and Q4 applies, SMTP, Auth settings, the HMAC secret, purges, the security, privacy and wording reviews, and a browser test;
     - a Pilot plan;
     - a team view of workspaces, with the project link;
     - results in the login;
     - link withdrawal.
  3. **Before the first pilot retest:**
     - a confounder log (§18.5 item 7);
     - recorded customer approvals and card reviewer;
     - the Outcome Card's threshold note and email copy.
  4. **Before subscriptions:** measuring customer-approved questions, exact answers in the login, colleague logins.
- **What step 1 adds (D-052):**
  - run requests, with the requested claim in the live worker (§18.5 item 2);
  - a founder retry of a run that failed at the provider;
  - closing a failed request;
  - who wrote the question, recorded at approval;
  - the per-run brand-self exclusion, customer wording for a run that ended without an answer, and a retry listed after the run it retried;
  - provenance shown in words;
  - page titles;
  - the Run confirmation from the protocol's plan;
  - the retest copy;
  - the preflight rows for the new migration.
- **Production steps waiting for authorisation, in order:**
  1. Apply `20261114120000` at the position the founder chooses (D-052, release order: after 0083, renamed below `20261102132000`, or after Q4), with the read-only preflight re-baselined for that position (`PROD_PREFLIGHT_SPEC.md`).
     - **2026-11-17 correction (D-058, approved by the founder on 2026-11-17):** "below `20261102132000`" is no longer possible, since Q2′-1 is applied. The migration is renumbered `20261109130000`, directly after S1, and the preflight is re-baselined to production's recorded state. The whole sequence is in [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md).
  2. Redeploy the worker from the same commit (`WORKER_DEPLOY_RUNBOOK.md` §6, with an empty queue). This also brings D-036's 7 slots and 900 seconds into effect (§18.5 item 8). The worker goes before the web app: started by the old console, it finds no run request and stops (D-052, deploy order). Confirm the machine runs the new image (the `gitSha` its start event reports, `WORKER_DEPLOY_RUNBOOK.md` §6) before step 3. A rollback runs in the reverse order.
  3. Deploy the web app.
  4. Set the paid-execution switch and `ZYPACT_DAILY_SPEND_CEILING_USD` (the figure the founder confirms; 10 USD proposed) on both the web host and the worker. Their deployed values are not known from the repository.
  5. Run the self-test retest (`SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md` §5 and §7). Carry its confounder note outside the card (§4, option 1) unless the confounder log ships first.
- **Not established here:**
  - anything about production: the migration ledger, the worker's configuration, the switches;
  - two founder sessions racing on a real stack beyond the advisory lock (no Level 2 case);
  - the report page's legacy branch, which still says "AI visibility snapshot" for legacy artifacts. That branch is frozen by the runbook and its tests, so it is left for the wording review.
- **Inventory on this branch:** 90 migrations, 217 files matching `scripts/test-*.ts`, 128 `test:*` and 4 `verify:*` commands.
- **Commands and local results (2026-11-14):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass (`next-env.d.ts` restored afterwards) |
| `npm run test:pilot-step1` | 75/75 |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60 (all 90 migrations applied) |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 PASS and 0 FAIL on `postgres:16-alpine`, with the new migration applied. The local runner then exits 1 from its cleanup trap under `set -e` when it has no shim directory (a bug in `scripts/run-snapshot-worker-postgres-level2-local.sh`, not changed here); CI runs the harness directly. |
| `npm run test:protocol-report` | 114 checks pass (100 on `main`) |
| `npm run test:prod-preflight` | 18/18 |
| `npm run test:worker-start` | 41/41 |
| `npm run test:paid-execution-guards` | 142/142 |
| `npm run test:founder-baseline-control`, `npm run test:scan-page` | pass, 52/52 |
| The CI jobs this PR triggers: `test:m0-worker-execution-gate`, `test:m5-tk-r`, `test:m5-phase3d-bounds`, `test:m5-b3-max-runtime`, `test:m5-phase3d-evidence`, `test:m5-0059-schema`, `test:m5-0060-schema`, `test:m5-2-adapter`, `test:m0-worker-hosting-contract`, `test:q2p-schema`, `test:q2p2-schema`, `test:s1-schema`, `test:prod-preflight` | all pass |
| Every `test:*` command (128) | 105 exit 0. Of the other 23: 10 legacy smoke tests need a configured database and fail the same way on `main`; 3 opt-in runtime tests skip; 9 fail identically on `main` at `c0bc011` (`seo`, `m7-0071-schema`, `m7-0073-schema`, `0080-report-ready`, `pdf`, `pg9-harness-offline`, `snapshot-send-idempotency`, `q2p1-scope`, `q2p2-scope`); `bqi-wording` fails only its P-04 change-scope check, which lists every path outside the BQI pull request and passes on `main`. |

## 31. Pilot questions (D-054) — branch `feat/pilot-questions`, stacked on step 1, not applied anywhere, not deployed

- **What it adds:** one pilot holds all of a customer's approved questions in one project. Before this, each question needed its own request, project and report.
  - Migration `20261118120000_pilot_questions.sql` (renumbered `20261109140000_pilot_questions.sql` on 2026-11-17, D-058) adds:
    - three tables: `pilots`, `pilot_questions` and `pilot_question_protocols`, the per-engine slot, which allows Perplexity's baseline only;
    - `create_pilot` (start date between yesterday and 60 days ahead), `add_pilot_question`, `close_pilot` (refused while a measurement is running or about to start) and `retire_pilot_question`;
    - three step 1 functions redefined, each byte for byte apart from its pilot block:
      - `request_protocol_job_run` accepts `admin_pilot_run` and refuses a Run for a closed, ended or not-started pilot or a retired question, under a `FOR SHARE` lock on the pilot;
      - `claim_requested_protocol_execution_job` refuses the same states at the claim, a second barrier;
      - `retry_failed_protocol_job` refuses them before anything is reserved.

      Each covers a pilot baseline and any retest of it.
  - Each added question gets the same Perplexity plan and caps as an audit, through the same approval sequence.
  - **Pilots** in the founder console: create a pilot, add approved questions, Run, Retry or Retire per question, close the pilot. ChatGPT shows as "Not measured".
  - No report, no email, no provider call. The worker's only change is to treat a claim refused for a closed pilot like step 1's other claim refusals.
- **Review (2026-11-17):** an independent read-only review of the first version found six defects, none of which spent without approval or exceeded a cap. All six are fixed on this branch and tested (D-054 item 11):
  1. a pending or running Run could spend after a close;
  2. a retest bypassed the closed-pilot block;
  3. there was no start-date bound and no check before the start;
  4. a question whose measurement could not go on could never be measured again;
  5. the founder-experiments list could lose founder baselines;
  6. a database test did not prove the protocol key.
- **Not established:**
  - **No browser walk-through** of the pilot pages against a running stack. The routes and pages are checked statically and by `build:verify` only.
  - **A pilot's measurements are not visible in any report yet.** The combined pilot report is the next step.
  - **No concurrency test.** The Run/close interleaving rests on the pilot row lock, which the static tests check; no test races two sessions.
- **Open:** D-054 *Open*:
  - a live pilot does not block a public request for its website;
  - every question is stored with intent `shortlist`;
  - the release position;
  - D-037 coverage of the three redefined functions;
  - Outcome Card recipients for interventions on pilot baselines;
  - the older claims (0054, 0059) do not check pilots, and only the requested claim is live;
  - a retry reserved just before a close keeps its reservation.
- **Inventory on this branch:** 91 migrations, 219 files matching `scripts/test-*.ts`, 129 `test:*` and 4 `verify:*` commands.
- **Commands and local results (2026-11-17, after the review's fixes):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass; the six routes and two pages are built (`next-env.d.ts` restored afterwards) |
| `npm run test:pilot-questions` | 128/128 (87 before the review's fixes) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 69/69 (all 91 migrations applied) |
| `npm run test:pilot-step1` | 75/75 (S8 now checks the release order after Q4, since this migration is newer) |
| `npm run test:prod-preflight` | 18/18 (the version, three tables and four functions added to the absence checks) |
| `npm run test:founder-baseline-control` | pass, with a check that pilot protocols are left out of the founder experiments |
| `npm run test:worker-start` | 41/41 |
| `npm run test:paid-execution-guards` | 143/143. Its founder-route inventory now names the pilot Run route as the fourth route that can start the worker, and checks it is founder-guarded before the start. The first version of this branch failed that check: the route was added without updating the inventory. |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 PASS and 0 FAIL on `postgres:16-alpine`, with all 91 migrations applied, including this one. The local runner then exits 1 from its known cleanup trap (§30). CI's Level 2 job runs only for pull requests into `main`, so it does not run on this stacked branch. |

## 32. Combined pilot report (D-055) — branch `feat/pilot-report`, not applied anywhere, not deployed

- **Base:** `main` at `53262cf`, which holds pilot step 1 (D-052) and pilot questions (D-054).
- **What it adds:**
  - **Migration** `20261119120000_pilot_report_artifacts.sql` (renumbered `20261109150000_pilot_report_artifacts.sql` on 2026-11-17, D-058):
    - `pilot_report_artifacts`, append-only revisions that are immutable once shared;
    - `save_pilot_report_artifact`, which refuses evidence outside the pilot, a manifest that leaves out a protocol or attempt, and a hash mismatch;
    - `share_pilot_report_artifact`, for the newest revision only. It never shares a blocked one, and shares a needs-review one only with an acknowledgement;
    - `read_shared_pilot_report`;
    - the guard trigger's function.
  - **A pure builder, integrity rule and Markdown** in `lib/reports/build-pilot-report.ts`, `pilot-report-integrity.ts` and `render-pilot-report-markdown.ts`.
  - **The reader** `lib/reports/read-pilot-evidence.ts`, and `readPilotProtocolEvidence` in `read-protocol-evidence.ts`.
  - **Build and share** in `lib/reports/process-pilot-report.ts`, with two founder routes under `/api/internal/pilots/[pilotId]/report`.
  - **The admin section** on the pilot page, the founder's preview of each revision (`/admin/pilots/[pilotId]/report/[artifactId]`, the only place Share is offered), and the customer page `/pilot-report/[secureToken]`.
  - **One presentation model**, `lib/reports/pilot-report-presentation.ts`, rendered by both the page and the Markdown.
  - **No provider or model call, no email, no change to any existing function.**
- **Independent review of 6d08ab5 (2026-11-17):** seven findings, all fixed on this branch (D-055 items 10 to 15):
  1. the required wording was missing from the page;
  2. "share" could happen without the founder seeing the revision;
  3. answers still being collected counted as failed, and the reconciliation check could not fire;
  4. the page and the Markdown differed, source counts had no denominator, and the hero overstated;
  5. retired questions skipped the evidence checks and still showed rates;
  6. a race was reported as a hash mismatch;
  7. three tests did not prove what they claimed.
- **Not established:**
  - no browser walk-through;
  - no report built from real pilot evidence;
  - no Level 2 run with this migration. It changes no worker path; CI's Level 2 job applies it on a pull request into `main`;
  - no test races a Run against a save on two real database sessions. The ordering rests on the pilot-row lock, which is checked statically (M12).
- **Open:** D-055 *Open for the founder*:
  - the total line;
  - whether the first report waits for recommended actions;
  - older shared links.
- **Inventory on this branch:** 92 migrations, 221 files matching `scripts/test-*.ts`, 130 `test:*` and 4 `verify:*` commands.
- **Commands and local results (2026-11-17):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass; the two routes, the preview and the customer page are built (`next-env.d.ts` restored afterwards) |
| `npm run test:pilot-report` | 93/93 (59 before the review's fixes) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 69/69, pilot report 39/39 (34 before the review's fixes; all 92 migrations applied) |
| `npm run test:pilot-questions` | 128/128. S1 now checks that pilot questions directly follow step 1, not that it is the newest migration. |
| `npm run test:pilot-step1` | 75/75 |
| `npm run test:protocol-report` | pass |
| `npm run test:prod-preflight` | 18/18 (the version, the table and four functions added to the absence checks) |
| `npm run test:paid-execution-guards` | 143/143 |
| `npm run test:source-insights` | pass |
| `npm run test:founder-baseline-control`, `npm run test:worker-start` | pass, 41/41 |

## 33. ChatGPT in the worker, phase A (D-056) — branch `feat/chatgpt-worker`, switch off, not deployed

- **Base:** `feat/x1-chatgpt-adapter` at `ce25c28` (PR #121). Section 32 is reserved for the combined pilot report (D-055), built on another branch.
- **What it adds:**
  - a provider profile per engine;
  - the `WORKER_CHATGPT_ENABLED` switch, off everywhere and refused at startup until phase B;
  - a lazily loaded ChatGPT engine pinned to the approved setting;
  - estimated cost from usage;
  - the flex capacity refusal as a failed, retryable attempt;
  - the source rule `openai-responses-sources/1`, chosen by provider;
  - the ChatGPT surface limitation and fingerprint endpoint.
- **Unchanged:** the Perplexity path. Every pre-existing worker suite passes unmodified apart from the four tests listed under D-056's *Tests*.
- **Not in phase A:**
  - any migration;
  - any change to an existing numeric bound;
  - any canon document;
  - any deployment;
  - any provider call.
- **Founder decisions before the switch can be turned on:** D-056 *For the founder*: the time limits, the caps, the daily ceiling, the flex handling and the source rule.
- **Commands and local results (2026-11-17):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass (`next-env.d.ts` restored afterwards) |
| `npm run test:chatgpt-worker` | 104/104 (new; 102 before the review fixes) |
| `npm run test:chatgpt-adapter` | 195/195 |
| `npm run test:source-insights` | pass |
| `npm run test:paid-execution-guards` | 145/145 |
| `npm run test:worker-start` | 41/41 |
| `npm run test:pilot-step1`, `npm run test:pilot-questions` | pass |
| `npm run test:protocol-report` | pass |
| `npm run test:m0-worker-execution-gate` | 498/498 |
| `npm run test:m0-worker-hosting-contract` | 150/150 |
| `scripts/test-worker-execution-options.ts` | 56 passed, 0 failed |
| Offline worker suites: `test:m5-a-worker-loop` 52, `test:m5-a-recovery` 18, `test:m5-a-real-probe-fencing` 18, `test:m5-a-conflict-identity` 62, `test:m5-a-failure-matrix` 58, `test:m5-a-abort-and-cancel` 23, `test:m5-a-throttling` 28, `test:m5-a-lifecycle` 34, `test:m5-tk-r` 120, `test:m5-phase3d-bounds` 62, `test:m5-b3-max-runtime` 189, `test:m5-phase3d-evidence` 131, `test:m5-2-adapter` 359, `test:cost-recording` 59, `test:perplexity-agent-adapter` 158, `test:worker-precheck-closure` 171, `test:worker-paid-execution-gate` 69, `test:worker-image-provenance` 89, `test:report-pass` 38, `test:m5-0056-schema` 71, `test:m5-0059-schema` 165, `test:m5-0060-schema` 266, `test:m5-0083-schema` 30 | all pass |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 PASS and 0 FAIL on `postgres:16-alpine` with all 91 migrations applied (the local runner then exits 1 from its known cleanup trap, §30) |

## 34. Suggested actions in the pilot report (D-057) — branch `feat/pilot-actions`, stacked on the combined report, not applied anywhere, not deployed

- **Base:** `feat/pilot-report` at `0ebadf0` (PR #125). Section numbers 33 and 34 are used on two open branches (ChatGPT in the worker uses 33); they are renumbered when both merge.
- **What it adds** (D-053 item 4):
  - **Migration** `20261120120000_pilot_actions.sql` (renumbered `20261109160000_pilot_actions.sql` on 2026-11-17, D-058):
    - four append-only tables (`pilot_actions`, `pilot_action_versions`, `pilot_action_evidence`, `pilot_action_events`), with a guard trigger on each and the evidence trigger;
    - `save_pilot_action`, `review_pilot_action`, `withdraw_pilot_action`;
    - `save_pilot_report_artifact` redefined with one marked block: listed action versions must be reviewed, latest and not withdrawn; a reviewed action cannot be left out; a revision with an action is never `integrity_passed`; unless the revision is blocked, what the payload shows of each action must equal the stored version and its links (`ACTIONS_CONTENT_MISMATCH`);
    - `share_pilot_report_artifact` redefined with one marked block: a revision whose actions changed since the build is refused (`ACTIONS_STALE`).
  - **Rules and copy:** `lib/pilots/action-rules.ts` (validation, the wording lint, which version is reportable) and `lib/pilots/action-copy.ts` (import-free, for the console's client code).
  - **The store:** `lib/pilots/action-store.ts` (save, review, withdraw, the founder's list, the reportable versions, the evidence picker, and the source check before a save).
  - **The builder:** `lib/reports/build-pilot-actions.ts`, called by `buildPilotReport`. It re-checks every link at every build. `runOrdinalsByAttemptId` is exported from `build-protocol-report.ts`, so an action's "answer N" is the report's own run number.
  - **The report:** a "Suggested actions" section in the shared presentation model, on the page and in the Markdown, with the fixed D-057 note.
  - **Console:** four founder routes under `/api/internal/pilots/[pilotId]/actions` (save, evidence choices, review, withdraw), and the Suggested actions panel on the pilot page (`app/admin/pilots/pilot-action-forms.tsx`), whose evidence picker offers only an answer's own sources.
  - **No provider or model call, no email, no worker, spend or claim change.**
- **Independent review of `813bedb` (2026-11-17):** eight findings, all fixed (D-057, *Independent review*):
  - a withdrawn or superseded action could be shared → `ACTIONS_STALE`, and the console marks the revision out of date;
  - the lint was evaded by hedges, inflections, causal verbs, invisible characters and look-alike letters → normalised text, whole-word phrases, modal and causal patterns;
  - the database checked only an action's identity → its content and links too (`ACTIONS_CONTENT_MISMATCH`);
  - the evidence trigger did not refuse a retired question → it does;
  - a posted source URL was stored as posted → the answer's own extracted URL is stored;
  - two simultaneous reviews or withdrawals ended in a 500 → serialised on the pilot row, and the second answers "already done";
  - the review prompt claimed more than the console showed → the stored answer is shown under each link; the customer note no longer names a step that does not exist;
  - tests that proved less than they claimed → the store runs for real against a fake client (K), and the DB suite covers each gap (C, S, Q, K, R8).
- **Not established:**
  - no browser walk-through of the panel or the picker;
  - no report built from real pilot evidence;
  - no Level 2 run with this migration. It changes no worker path.
  - `test-pilot-questions-db` P22 (retiring at most 5 questions) failed once in a full run on 2026-11-17 and passed on two re-runs of the same code. It depends on lease lapses in `abandon()`, so it can be intermittent; it is not touched by this branch.
- **Open:** D-057 *Open for the founder*:
  - the *(engineer)* rules;
  - fingerprints in an appendix;
  - a second reviewer.
- **Inventory on this branch:** 93 migrations, 223 files matching `scripts/test-*.ts`, 131 `test:*` and 4 `verify:*` commands.
- **Commands and local results (2026-11-17, after the review's fixes):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass; the four routes and the pilot page are built (`next-env.d.ts` restored afterwards) |
| `npm run test:pilot-actions` | 91/91 (68 before the review's fixes) |
| `npm run test:pilot-report` | 93/93 |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 69/69, pilot report 39/39, pilot actions 53/53 (37 before), all 93 migrations applied. A first full run had pilot questions at 68/69 (P22, see *Not established*); two later runs passed it. |
| `npm run test:pilot-questions` | pass |
| `npm run test:pilot-step1` | pass |
| `npm run test:protocol-report` | pass |
| `npm run test:source-insights` | pass |
| `npm run test:prod-preflight` | pass (the version, four tables and five functions added to the absence checks) |
| `npm run test:paid-execution-guards` | 143/143 |
| `npm run test:founder-baseline-control`, `npm run test:worker-start` | pass, 41/41 |

## 35. Release prep for the pilot (D-058, approved 2026-11-17) — branch `release/pilot-production-prep`, PR #129, nothing applied anywhere

- **What it changes:**
  - **Renumbered migrations.** The four pilot migrations are renumbered to sit directly after S1 and before P1: `20261109130000` (step 1), `20261109140000` (questions), `20261109150000` (report) and `20261109160000` (actions). Their SQL is unchanged; only header comments stating an order or a version changed.
  - **Re-baselined preflight.** It now matches production as §25 records it after S1 (`PROD_PREFLIGHT_SPEC.md`). This version has never been run against production.
  - **Corrected notes.** Dated notes correct D-045, D-052, D-054, D-055 and D-057, and §20.6, §21.4 and §30–§34, where they described production as untouched or offered the "below `20261102132000`" option.
  - **The production plan.** [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md) is new: the step-by-step plan, with each founder approval, read-only check and rollback, the release order, ChatGPT later, and what to check read-only first. It is linked from PILOT_RUNBOOK §2.1.
- **Founder decisions:** the release order (D-058) and step 1, the read-only preflight, were approved on 2026-11-17 ("I agree."). Every later production step in the plan awaits its own authorisation.
- **Commands and local results (2026-11-17):**

| Command | Result |
|---|---|
| Schema equivalence: two disposable `supabase/postgres:17.6.1.167` databases, all 93 migrations, the pilot four applied after Q4 (the old order) and after S1 (the new one), compared by full `pg_dump --schema-only` | identical, 26,440 lines, privileges and comments included |
| Re-baselined preflight against a disposable database built to the recorded production state (85 ledger rows, tail `20261109120000`) | every must-pass check PASS. P3.1 computed `721e4879…` (0083's `post_def`) and P3.3 `710dfb5c…`. After pilot step 1 was applied and recorded: P2.3, P2.4, P2.5, P3.3, P3.4, P4.1 and P4.2 FAIL, as designed. |
| `npm run test:prod-preflight` | 24/24. The contract now checks the applied set is a prefix of the migrations on disk, applied objects are present, pending objects absent, and the pins and counts. A mutation check confirmed PF-12, PF-12a and PF-21 each catch a removed entry. |
| `npm run test:pilot-step1`, `test:pilot-questions`, `test:pilot-report`, `test:pilot-actions` | pass |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | 93 migrations applied in the new order; P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 69/69, pilot report 39/39, pilot actions 53/53 |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 PASS, 0 FAIL, 93 migrations with the pilot four applied directly after S1. The local runner then exits 1 from its known cleanup trap. |
| `npm run typecheck`, `npm run build:verify` | pass (`next-env.d.ts` restored) |

- **Independent review of PR #129 (2026-11-17), fixed on the same branch.** It found nothing that blocks a read-only run. Its findings:
  1. **The named-file guard did not enforce order.** It checked only that the tail equals `expected_prev`, and a disposable database recorded `20261109125000` after `20261109160000`.
     - **Fix:** the guard refuses any version not strictly later than `expected_prev`, and both must be 14 digits. An optional `-v target_sysid` guard refuses a different database.
     - **New body sha256:** `db6feffff039c324bef2a8894deb3e2c3236f5c0e8bbca7cd4ecc204b8972cca`. Q2′-1, Q2′-2 and S1 used `8a430331…`.
     - **D-058 item 4:** until P1 to Q4 are applied, every production migration is numbered strictly between `20261109160000` and `20261110120000`, or waits.
  2. **The preflight never confirmed its target.** It now requires `-v expected_sysid`, and P1.1 must pass.
  3. **A FAIL left the exit code at 0.** The check set is now built once. The last line is `PREFLIGHT: PASS` or `PREFLIGHT: FAIL (n)`, and a FAIL raises inside the read-only transaction, so psql exits 3. A must-pass check that comes out null now counts as a FAIL.
  4. **The read-only contract missed** advisory locks, a session `set_config`, `pg_terminate_backend` and `set role`. It now refuses them and every other side-effecting pattern. 34 mutation checks prove each is caught.
  5. **The records disagreed on whether D-058 was approved.** They now all say approved.
  6. **Smaller fixes:**
     - P4.6 is must-pass at 40 helpers;
     - `row_security = off`;
     - a diagnosis note for P3.3, whose pin has never been observed on production.
- **Results after the review's fixes (2026-11-17):**

| Command | Result |
|---|---|
| `npm run test:prod-preflight` | 71/71, including 34 mutation checks and the apply procedure's body sha256 |
| Preflight on a fresh disposable database at the recorded state | right `expected_sysid`: all PASS, `PREFLIGHT: PASS`, exit 0. Missing or wrong value: P1.1 FAIL, exit 3. One queued job: P6.3 FAIL, exit 3. Job removed: PASS, exit 0. |
| Named-file procedure on that database | the four pilot migrations in order: exit 0 each, tail `20261109160000`, 89 rows. Out of order (`20261109125000`): refused, exit 3. Wrong `target_sysid`: refused, exit 3. Ledger unchanged by each refusal. |
| `row_security = off` with a role without BYPASSRLS | error instead of 0 rows |

- **Not established:** nothing about production.

## 36. Pilot report links and the unscoped claims (D-059, D-060) — branch `feat/pilot-decisions-link-withdrawal`, not applied anywhere, not deployed

- **Base:** `main` at `d03363f`.
- **Founder decisions (D-059):** the founder's "I agree." of 2026-11-17 is recorded against the 14-point list. Items 1 to 6 will be implemented by ChatGPT phase B (planned as D-061, PR B; not built, and D-061 is not yet recorded); items 7, 8, 10, 11 and 12 were already built; item 9 is built here; item 13 (the login's security reviewer) is still open; item 14 (the production plan) is done. D-059 authorises no production step beyond D-058's.
  - **2026-11-18:** D-061 is recorded and phase B is built, on branch `feat/chatgpt-phase-b`, which merges this branch (§37). It is not applied anywhere and not deployed, and the ChatGPT switch stays off.
- **What it adds (D-060):**
  - **Migration** `20261109170000_pilot_links_and_claim_scope.sql`, numbered inside D-058's window:
    - `read_shared_pilot_report` redefined, same signature, columns and grants. Once a later revision of a pilot is shared, an earlier revision's link answers no payload and the "newer revision shared" flag. Its body is 20261109150000's byte for byte apart from one marked block;
    - `claim_protocol_execution_job` and `claim_protocol_execution_job_by_id` revoked from `service_role`, with their other revokes restated. Neither is dropped or redefined;
    - pre- and postconditions that refuse the whole apply. It writes no row and creates nothing.
  - **The customer page** answers three ways: the report, a replaced link, or a 404. A replaced link shows a short noindex notice with nothing of the report and no pointer to the new link. The "a newer revision has been shared" banner is gone.
  - **The founder console** marks an earlier shared revision "Replaced — its link no longer opens" and shows no link for it, on the pilot page and on the preview. The share prompts, the preview's note above Share and the pilot page's report note say the earlier link stops working. The pilot page lists the ten newest revisions; when none of them is shared, one more bounded read adds the newest shared revision below them, with its link, so the one link that opens is always on the page.
  - **Suggested actions** (D-059 items 10 and 11): `MAX_PILOT_ACTIONS_IN_USE = 30`; the console disables a new action at the limit and says why (it counts actions not withdrawn, D-057's *(engineer)* rule, still proposed); the action limit and the 50-version limit read differently; the withdraw prompt says a withdrawal is final.
  - **Preflight:** `20261109170000` added to both P2.4 lists, nothing else.
  - **Documents:** D-059, D-060 and dated notes in D-031 and D-054 to D-058; SPEND_LEDGER_GATE §11 (0085's revoke of the two claims becomes a no-op; the three suites that call them as `service_role`); WORKER_DEPLOY_RUNBOOK §3 and §6 and PILOT_PRODUCTION_PLAN (step 5a; the R rule; step 13's note; the proposed rule before a worker redeploy after the migration, "no job holds a live lease and no run request is pending", D-060 item 5 *(engineer)*, with the empty-queue rule in force until the founder confirms it); PROD_PREFLIGHT_SPEC; PILOT_RUNBOOK §8.2 and §8.3.
- **Checked before the revoke:** no web route, neither `scripts/run-protocol-worker.ts` nor `scripts/run-pipeline-once.ts`, and nothing in `lib/worker-control/**` calls either unscoped claim. Only `lib/db/supabase-adapter.ts` (the RPC calls), `lib/db/memory-adapter.ts` and the worker loop's `global` branch name them, and no live entry point sets `global`. No suite that calls them applies `20261109170000`: each applies a bounded migration set that ends before it. The 0050 to 0054 runtimes and `test:m7-0077-runtime` call them as the database owner, and `test:m5-0060-runtime` through a SECURITY DEFINER helper. PG-9 (0001–0081 and 0083; it refuses timestamped files) and `test:m5-a-stack-runtime` (up to 0056) call them as `service_role` over PostgREST, and `test:m5-0059-runtime` (up to 0059) through `set role service_role`; each of those three would need to move to the requested claim or the owner path before its set reached this migration.
- **The preflight's P6.3 (no queued job) is unchanged:** step 1 runs before this migration, while the deployed worker still predates D-052 and uses the global claim.
- **Independent review (2026-11-17), fixed on this branch:**
  - the migration's guards were never tested refusing: the database suite now re-runs the migration in a rolled-back transaction after setups that trip each precondition and the postconditions on the unscoped claims and the read's grants (G1 to G9), and the static suite pins each guard's condition exactly (C6b, C7b);
  - the recovery notes promised that re-running 20261109150000 §5 reopens older links. It restores the function only: D-060's page still shows the notice, and the web deployment from before step 7 has no pilot report page. The header, D-060 and the plan now say both are needed (the restored function and a separately authorised deploy of a pre-D-060 pilot build);
  - the documents said every caller of the revoked claims calls as the owner; three suites call as `service_role` (above);
  - the database suites' "no payload" reads accepted any payload without a pilot id; K1 and K2 were not rolled back; K6 did not compare the bodies. All three are fixed;
  - D-060 item 5 (the rule before a worker redeploy) is now marked *(engineer)*, proposed for founder confirmation, with the empty-queue rule in force until then; P6.3's wording, the plan's steps 6 and 9 and runbook §3 agree;
  - the new console words had no test: the preview's status line is a tested function, both "stops working" notes are copy constants whose placement is checked, the customer page is called for real (`test:pilot-report` T13 to T16) and the actions panel is rendered for real (`test:pilot-actions` C12);
  - the only link that opens could fall outside the pilot page's ten rows (fixed, above);
  - the R rule told the operator to apply every migration on R, P1 to Q4 included; D-061 was cited as if recorded; "withdrawn actions do not count" was credited to the founder; D-031's grant was revoked without a note. All four are corrected.
- **Not established:**
  - no browser walk-through of the notice or the console;
  - nothing about production. The migration is applied nowhere, and the edited preflight has not run against production; if R includes this change, the preflight is run again from R before step 2 (PILOT_PRODUCTION_PLAN, the R rule). Whether step 1's authorisation covers that re-run is not recorded;
  - `read_shared_pilot_report`'s md5 after the step, `7b90ce86…`, comes from a disposable rehearsal only;
  - D-060 item 5 and D-057's "withdrawn actions do not count" are *(engineer)* rules awaiting the founder.
- **Inventory on this branch:** 94 migrations, 227 files matching `scripts/test-*.ts`, 134 `test:*` and 4 `verify:*` commands.
- **Commands and local results (2026-11-17):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build:verify` | pass; `/pilot-report/[secureToken]`, `/admin/pilots/[pilotId]` and the preview are built (`next-env.d.ts` restored afterwards) |
| `npm run test:pilot-links-claims` | 38/38 (new; 32 before the review fixes: C6b, C7b and A8 to A11 added). Eight mutations of the migration and the client read (payload not withheld, a claim granted back or not revoked, the inherited where clause changed, a claim redefined, the requested claim revoked, the replaced flag ignored, the replaced link kept in the console) were each caught, and every file restored byte for byte |
| `npm run test:pilot-report` | 99/99 (93 on `main`: T8e, T8f and T13 to T16 added; T8d and T9 pin the new behaviour) |
| `npm run test:pilot-actions` | 98/98 (91 on `main`: C6 to C12 added) |
| Mutations after the review fixes, on a scratch copy of the tree (never the worktree) | 14 offline mutations each caught by `test:pilot-links-claims`, `test:pilot-report` or `test:pilot-actions`: the preview's status line collapsed, inverted or reworded; either "stops working" note deleted; the client read or the page turning a replaced link into a 404 or into the report; the list's extra read removed; the panel's limit ignored or counting withdrawn actions; an `or` turned into `and` in a pre- or postcondition. 5 migration-guard mutations (`or` to `and` at each guard) each caught by the database suite's G checks on a disposable database, with the unmutated baseline at 28/28 |
| `npm run test:pilot-questions`, `npm run test:pilot-step1` | 128/128, 75/75 |
| `npm run test:prod-preflight` | 71/71 |
| `npm run test:m5-0059-schema`, `npm run test:m5-0060-schema` | 168/168 and 275/275; the [2b] guards examine the new migration too and pass (167 and 272 before) |
| `npm run test:paid-execution-guards` | 145/145 |
| `test:m7-0070`, `0072`, `0074`, `0075`, `0076-schema` | pass; `m7-0071-schema` (2) and `m7-0073-schema` (1) fail as on `main` (§30), and neither failure names the new migration (before the review fixes, not re-run) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | exit 0, all 94 migrations applied: P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 69/69, pilot report 39/39 (R5 rewritten), pilot actions 53/53, pilot links and claims 28/28 (new; 19 before the review fixes: G1 to G9 added) |
| The two report suites on a disposable database without `20261109170000` (a negative control) | pilot report 38/39 (R5 fails); pilot links and claims 23/28 (R4, R5, R8, K1 and K3 fail; the G checks pass, because they re-run the file in a rolled-back transaction whatever the database's state): they detect the change |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 passed and 0 failed on `postgres:16-alpine` with all 94 migrations applied, the new one's pre- and postconditions included. The local runner then exits 1 from its known cleanup trap (§30). Run before the review fixes, which changed only the migration's header comments (everything from its precondition block down is byte-identical), so not re-run |
| Preflight on a fresh disposable `supabase/postgres:17.6.1.167` at the recorded state (85 rows, migrations applied as `postgres`) | every must-pass check PASS, `PREFLIGHT: PASS`, exit 0 |
| `20261109170000` through the named-file procedure on that database, out of order (tail S1) | refused by its own precondition, exit 3; ledger unchanged at 85 rows, nothing changed |
| The four pilot migrations, then `20261109170000`, in order with `target_sysid` | exit 0 each; 90 rows, tail `20261109170000`; `service_role` can execute neither unscoped claim, and can execute the requested claim and the read; md5 of the read `36dd5bc1…` before, `7b90ce86…` after. The preflight then fails by design: P2.3, P2.4 (which now lists `20261109170000`), P2.5, P3.3, P3.4, P4.1, P4.2; `PREFLIGHT: FAIL (7)`, exit 3 |

The last three rows ran before the review fixes. The fixes changed only the migration's header comments and none of its statements, and the read's definition (its md5) is unchanged, so they were not re-run.

## 37. ChatGPT in the worker, phase B (D-061) — branch `feat/chatgpt-phase-b`, merges §36's branch, not applied anywhere, not deployed, switch off

- **Base:** `main` at `d03363f`. Phase B's code is commit `c3f6088`; D-060's branch (`da2151e`, §36) is merged into it at `f580273`; this section's documents are on top.
- **Founder values (D-059 items 1 to 6, approved 2026-11-17), as built:**
  - a ChatGPT call timeout of 290 s;
  - a lease of 330 s, a readiness window of 240 s and a runtime ceiling of 2,400 s, in the three Fly files;
  - ChatGPT caps of 7 runs, 2 retries and 4 USD, in `add_pilot_question_engine`;
  - the 10-then-20 USD daily ceiling, recorded as a production step (PILOT_PRODUCTION_PLAN Part C);
  - the flex refusal and the source rule, unchanged from phase A.

  `WORKER_CHATGPT_ENABLED` stays `"false"` in every Fly file.
- **What it adds (D-061):**
  - **Migration** `20261109180000_chatgpt_measurement.sql`, numbered inside D-058's window, applied after `20261109170000` (`expected_prev=20261109170000`). It:
    - adds `live_openai_chatgpt` to both probe-mode CHECKs;
    - adds one live baseline per question version per engine, an index that replaces 0073's;
    - accepts `openai_chatgpt` as a pilot slot engine, with a BEFORE INSERT consistency trigger;
    - has `persist_probe_result_for_job` take the platform from the probe run (0054's body otherwise; Perplexity hashes unchanged);
    - adds `add_pilot_question_engine`, with caps of 7, 2 and 4 USD and the approved setting;
    - has `retire_pilot_question` cover every slot of the question and their retests;
    - adds `protocol_worker_capabilities()`.

    It writes no row and redefines no M5 spend, reservation, receipt or retry function: the provider leg of every engine keeps `call_kind 'perplexity'` (D-061 item 1). Its preconditions refuse while any protocol attempt is `reserved` or `in_progress`.
  - **The worker:**
    - the four bound values in the three Fly files (14 `[env]` values, hosting contract updated);
    - `CHATGPT_WORKER_SCHEMA_READY = true`;
    - with the switch on, a whole-claim startup rule, and a startup capability check that logs `worker_chatgpt_schema_refused` and exits 78 against a database without the migration.
  - **The readers:**
    - the cost report's `byLeg` (the provider leg per engine through the protocol's provider) and `openAiPriceTableVersion`;
    - `searchResultsPresence` for the Responses shape;
    - `coerceProbeMode`, and the legacy request-report readers leaving ChatGPT rows out of every Perplexity figure.
  - **The pilot console:**
    - the web host's gate `ZYPACT_PILOT_CHATGPT_ENABLED`; off, ChatGPT shows as "Not connected";
    - Run and Retry per engine;
    - **Add ChatGPT**, per question or for every question without it, and an unticked "also on ChatGPT" box when adding a question (new route `POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/engines`);
    - **Resolve review** per engine (new route `…/questions/:pilotQuestionId/review`);
    - **Retire** stops a question on both engines.
  - **The pilot report:**
    - two engines, each with its own table, total and limitation sentence, and nothing combined;
    - a question not measured on an engine is named, never counted;
    - no "0 of 0" for a measurement without a readable answer;
    - setting, flex, web-search and source-rule lines;
    - two new `blocked` reasons and three new needs-review reasons;
    - the integrity rule for a measurement with no attempt yet;
    - new optional payload fields.
  - **Suggested actions** use each engine's own source rule.
  - **Preflight:** `20261109180000` in both P2.4 lists; three pending functions (P4.2 now 41); P3.5 pins `persist_probe_result_for_job` at md5 `d812b7f4c606e03ea171113f9fbc9762`, computed on a disposable `supabase/postgres:17.6.1.167` at the recorded production state.
  - **Documents:**
    - D-061, with dated notes in D-029, D-030, D-032, D-034, D-036, D-037, D-051, D-053, D-056, D-057 and D-059;
    - `CLAUDE.md`'s live-surface lines and inventory;
    - V1_SCOPE, METHODOLOGY (document version 1.3; the default protocol methodology version stays 1.1), PILOT_RUNBOOK, ROADMAP and ENGINEER_START_HERE;
    - WORKER_DEPLOY_RUNBOOK §2, §5, §6, a new §6a (the switch-on deploy, the startup refusal, the web gate) and §10;
    - PILOT_PRODUCTION_PLAN: step 5b for the migration, step 6's new values, Part C in order;
    - PROD_PREFLIGHT_SPEC;
    - comment lines in `.env.example` for the web gate;
    - a dated pointer to this section in this file's precedence notice.
- **For the founder** *(engineer, proposed)*:
  - the new customer wording: the setting, flex and web-search lines, the source-rule line (now shown for Perplexity too; with the words that replace "0 of 0" and "Ended after review", it changes Perplexity-only reports as well) and the words that replace "0 of 0";
  - the integrity rule change;
  - the two new `blocked` reasons;
  - the new optional payload fields;
  - the console choices: the ChatGPT box unticked by default, review not gated, the "Not connected" words, exit 78.

  The full list is in D-061.
- **Inventory on this branch** (`f580273`; this section's documents add no file). Recounted on 2026-11-18 after the review fixes, which add one non-test file (`app/admin/pilots/pilot-engine-cell.tsx`): unchanged.
  - 95 migrations: 82 four-digit (`0001`–`0081` and `0083`) and 13 timestamped, the last `20261113120000`;
  - 229 files matching `scripts/test-*.ts`;
  - 135 `test:*` and 4 `verify:*` commands.
- **Commands and local results** (2026-11-17 to 18). The full pass ran on the merged tree, `f580273`'s content. The final results after the review fixes are in the second table, under *The review*; where the two differ, the second supersedes the first:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build:verify` | exit 0; `next-env.d.ts` unchanged |
| `npm run test:pilot-actions`, `test:pilot-report`, `test:pilot-links-claims` | 109/109, 122/122, 38/38 |
| `npm run test:pilot-questions`, `test:pilot-step1` | 218/218, 75/75 |
| `npm run test:prod-preflight`, `test:chatgpt-phase-b-schema`, `test:paid-execution-guards` | 72/72, 68/68, 145/145 |
| `npm run test:m0-worker-hosting-contract` | 170/170, the static half only. The Docker half needs a clean committed tree and runs in CI |
| `npm run test:chatgpt-worker`, `test:cost-recording`, `test:measurement-compatibility`, `test:chatgpt-adapter` | 141/141, 74/74, 106/106, 195/195 |
| `npm run test:worker-start`, `test:m0-worker-execution-gate`, `test:m5-b3-max-runtime` | 41/41, 498/498, 189/189 |
| Schema contracts: m5-0056, m0-0057, m5-0059, m5-0060, m5-0083 | 71/71, 82/82, 169/169, 278/278, 30/30 |
| Schema contracts: m7-0070, 0072, 0074, 0075 and 0076; q2p, q2p2 and s1 | pass |
| `test:m7-0071-schema`, `test:m7-0073-schema` | 2 and 1 failures, the failing lines identical to `main` `d03363f`'s (§30, already failing) |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | exit 0, 95 migrations applied, 0 failures: P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 70/70, pilot report 39/39, pilot actions 53/53, pilot links and claims 28/28, ChatGPT phase B 58/58 (new) |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 passed and 0 failed, all 95 migrations applied on `postgres:16-alpine`. The local runner then exits 1 from its known cleanup trap (§30) |
| Before the merge, on phase B's own tree: `test:export`, `test:export-route`, `test:pipeline-integrity`, `test:public-site-url`, `test:source-insights`, `test:outcome-card`, `test:protocol-report`, `test:founder-baseline-control` | 135/135, 17/17, 96/96, 22/22, 84/84, 40/40, pass, pass |
| Before the merge: §33's offline worker suites (the eight m5-a suites, tk-r, phase3d, m5-2-adapter, agent adapter, precheck closure, paid gate, image provenance, report pass) | all pass with their baseline counts |
| Before the merge: known failing suites (§30) on a fresh `git archive` of `d03363f` and on the branch | m7-0071, m7-0073, 0080-report-ready and pg9-harness-offline fail with identical lines in both; bqi-wording 109/110 in both, its P-04 change-scope check. None is worse |
| Preflight rehearsal before the merge (`supabase/postgres:17.6.1.167` at the recorded state: 85 rows, tail S1, `-v expected_sysid` set to the disposable cluster's own identifier) | every must-pass check PASS, P3.5 included; `PREFLIGHT: PASS`, exit 0 |
| `20261109180000` through the named-file procedure on that database, out of order (tail S1) | refused, exit 3; ledger unchanged |
| The four pilot migrations, then `20261109180000`, in order with `target_sysid` (`expected_prev=20261109160000` there, because `20261109170000` was not yet in that tree) | exit 0 each; 90 rows. md5 after the apply: persist `4d80da43d46d0ee2cfb2c4898f54e652`, retire `a52b4f27c4170844e192575ed1108abd`. The preflight then fails by design: P2.3, P2.4, P2.5, P3.3, P3.4, P3.5, P4.1 and P4.2, `PREFLIGHT: FAIL (8)`, exit 3 |
| After this section's documents (2026-11-18): `npm run typecheck` | exit 0 |
| After the documents: `test:prod-preflight` (reads PROD_PREFLIGHT_SPEC), `test:chatgpt-phase-b-schema`, `test:pilot-actions` (reads DECISIONS, this file and PILOT_RUNBOOK), `test:pilot-links-claims` (reads DECISIONS, this file, WORKER_DEPLOY_RUNBOOK and PILOT_PRODUCTION_PLAN) | 72/72, 68/68, 109/109, 38/38 |
| After the documents: `test:m5-b3-max-runtime`, `test:s1-accounts` and `test:w1-preview` (each reads `.env.example`); `test:m0-worker-hosting-contract` | 189/189, 74/74, 26/26; 170/170, the static half only |
| After the documents: the 0051 to 0054 schema contracts (`npx tsx scripts/test-m5-005N-schema-contract.ts`, which read DECISIONS) | 117/117, 67/67, 74/74, 150/150 |
| After the documents: `test:q2p1-scope`, `test:q2p2-scope` | 3 and 4 failures, the same lines as on `main` at `d03363f` (no scope base is set; §30) |
| After the documents: `test:bqi-wording` | 109/110: P-04, the change-scope check, which fails on any branch that is not BQI's and passes on `main` (110/110 at `d03363f`) |

- **The review (2026-11-18).** Two independent reviewers read the branch: 3 major and 11 minor findings, all fixed in the working tree on top of `f580273`. Among the fixes:
  - **DB-1, the retire rule** (D-061 engineering rule 7): once one slot has stopped for good, `retire_pilot_question` refuses (`QUESTION_JOB_ACTIVE`) while any other slot, or any retest of any slot, holds a reserved or in-progress attempt or a claimed or running job, lease lapsed or not. A retired question refuses every Run, so such a run could never close, and it would hold every report save of the pilot;
  - **"Ended after review":** a measurement a review ended (for example a ChatGPT timeout resolved with **Finish without the unconfirmed run**) never reads "Finished". It shows its own figures and its completed planned answers, is left out of its engine's total and named there, and holds the report for review;
  - **the per-engine retired words:** a question retired with two measurements says one of them could not finish and how far each got, with attempt counts only; an engine whose questions are all retired reads "no live question is measured on it", never "0 of 0"; a revision built before D-061 keeps its own words (`builtBeforeD061`);
  - **three new preflight checks,** P6.4, P7.1 and P7.2, mirroring the migration's data preconditions (PROD_PREFLIGHT_SPEC, PF-29 to PF-29c);
  - **the switch-off order** (WORKER_DEPLOY_RUNBOOK §6a, the migration's header): a read-only query first, unfinished ChatGPT runs finished, the web gate off, the query again until no ChatGPT run is pending or in flight, then the worker switch;
  - with the gate off, while no measurement of the question has stopped for good, Retire refuses it; for a ChatGPT measurement that could be retried or has an unfinished run, it says ChatGPT must be turned back on first;
  - the pilot page counts timed-out and cancelled attempts as failed and shows excluded attempts separately, as the report does.

  The *(engineer)* choices and the founder's questions they raise are in D-061 (*Further choices*, item 8, and *For the founder to review*).

| Command (after the review fixes, 2026-11-18) | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build:verify` | exit 0 |
| `npm run test:pilot-questions`, `test:pilot-step1`, `test:pilot-report`, `test:pilot-actions`, `test:pilot-links-claims` | 243/243, 75/75, 133/133, 109/109, 38/38 |
| `npm run test:chatgpt-phase-b-schema`, `test:prod-preflight`, `test:chatgpt-worker` | 74/74, 76/76, 141/141 |
| `npm run test:cost-recording`, `test:measurement-compatibility`, `test:paid-execution-guards`, `test:worker-start` | 74/74, 106/106, 145/145, 41/41 |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | exit 0, 95 migrations applied: P1 45, P2 71, E1 74, Q4 52, pilot step 1 60, pilot questions 70, pilot report 39, pilot actions 53, pilot links and claims 28, ChatGPT phase B 81/81 |
| `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2` | `LEVEL2_RESULT=PASS`, 886 passed and 0 failed. The runner exits 1 from its known cleanup trap (§30) |
| `test:m7-0071-schema`, `test:m7-0073-schema` | 2 and 1 failures, the same lines as `main` |
| Rehearsal on a fresh disposable `supabase/postgres:17.6.1.167` at the recorded state: `20261109130000` to `20261109180000` in order through the named-file procedure, `expected_prev=20261109170000` for the last | 91 rows, tail `20261109180000`. md5 after the apply: persist `4d80da43d46d0ee2cfb2c4898f54e652` (unchanged), retire `f1d660a5097e672a38ffaec28b048a0b` (after the DB-1 fix; it replaces `a52b4f27…` above) |
| The preflight on a fresh disposable copy at the recorded state, then one negative control at a time (PROD_PREFLIGHT_SPEC, *History*) | `PREFLIGHT: PASS`, exit 0; each control fails only its own check (P6.4, P7.1, P7.2), `FAIL (1)`, exit 3 |

- **Mutation trials, as each part reported them** (every file restored and its sha256 checked):
  - **The database:** none reported. The `test:m7-0073-schema` exception has fixtures showing that any other migration touching the index is still caught.
  - **The worker bounds:**
    - five mutations of the three Fly files, each caught: a runtime of 2,355 s (3 failures), a lease of 300 s (5), a readiness window of 110,000 ms (4), the ChatGPT timeout line removed (11) and 8 slots (3);
    - with the new startup rule disabled in a scratch copy of `execution-mode.ts`, `test:chatgpt-worker` gave 114/120: the six new checks fail.
  - **The console and readers:** 10 breaks, each caught:
    - the gate made truthy;
    - Run ungated;
    - the pilot read on Perplexity only;
    - the review's job taken from the body;
    - a failed capability read passing;
    - the refusal not exiting;
    - ChatGPT cost filed as Perplexity;
    - the fingerprint's provider dropped;
    - ChatGPT rows read by the summary;
    - `coerceProbeMode` turning ChatGPT into simulated.
  - **The report and actions:** 19 breaks, M1 to M19 (for example the engine check off, "0 of 0" printed, the source rule always Perplexity's, flex described as the standard tier, a slot's provider ignored), each caught by its expected checks in the final run. One, M6 (questions not measured left unnamed), was missed on its first trial and caught on its second.
- **Not established:**
  - no live ChatGPT call through the worker. Every test uses a fake fetch or a fixture; the only real ChatGPT calls are the adapter's benchmark and confirmation runs (§29), outside the worker;
  - no browser walk-through of the console or the report;
  - Level 2 applies the migration but exercises no ChatGPT path;
  - nothing is applied to any hosted database, and the edited preflight has not run against production. The P3.5 pin has never been observed on production. If R includes this branch, the preflight is run again from R before step 2 (PILOT_PRODUCTION_PLAN, the R rule);
  - the merged preflight file, with both versions in P2.4, has not itself been run on a disposable database. Each branch's edit was, and the merge only added `20261109170000` to the two lists. **2026-11-18:** the reviewed file, with P6.4, P7.1 and P7.2, was run on a fresh disposable copy (the review table above);
  - the migration's preconditions are pinned by the static suite but not exercised refusing on a database, apart from the out-of-order apply above. **2026-11-18:** each of the ten preconditions now refuses on a database (G1–G12), and G1 proves the first recovery;
  - the md5 values after the apply come from the pre-merge rehearsal (`20261109170000` touches neither function). **2026-11-18:** superseded by the post-review rehearsal on the merged tree (the review table above).
- **Open:**
  - the founder's review of the *(engineer)* items above;
  - D-060 item 5, still proposed. Part C's worker-secret change and switch-on redeploy happen with pilot jobs queued, so they need it, or an empty queue;
  - the pilot retest on both engines against 0079's one retest per intervention;
  - nothing in the database limits `protocols.provider`, so a new provider string would count as its own engine; a CHECK is a possible follow-up;
  - a probe run's platform is not tied to its protocol's provider in `create_probe_run_and_start_attempt_for_job`;
  - the slot loop still never re-checks the deadline; with the switch off, the whole-claim rule is enforced only by the hosting contract;
  - the founder-only request review panel and interventions page still show the stored code `perplexity_outcome_unknown`. No customer page does;
  - `lib/agents/competitor-discovery.ts` and `gap-map.ts` (legacy) pass a row's probe mode through unchanged;
  - an engine whose questions are all retired still reads "0 of 0 questions with at least one readable answer; 1 retired." It is a question count, pinned by I5c. **2026-11-18:** fixed by the review; it now reads "no live question is measured on it" (I5c);
  - `README.md` line 37, and `ADAPTER_VALIDITY_CHATGPT.md`'s status lines and open items 7 and 8, still describe ChatGPT as not wired and its time limits as undecided. Neither file is edited here, and `test:chatgpt-adapter` pins the note's "not wired into any worker". **2026-11-18:** both are now updated, and the pin follows the note's new text;
  - the deployed worker's lease and readiness values are unrecorded (WORKER_DEPLOY_RUNBOOK §5, §10).

## 38. First production preflight at `2ae02e1` (2026-11-18): two findings, nothing changed

- **Run:** the founder ran the Supabase SQL editor version of `scripts/sql/prod-preflight.sql` (generated from `main` `2ae02e1`, the same checks plus P0.1, which stands in for `row_security = off`; tested against the psql version on a disposable copy at the recorded state). The founder approved running the updated check at the new R, and accepted the identifier read in the dashboard as the record (the 2026-11-09 private record was not available here). The number is not written anywhere in the repository.
- **Result:** `PREFLIGHT: FAIL (2)`. P1.1 PASS; every other check PASS except:
  - **P3.3:** production's `approve_and_launch_snapshot_baseline` is 0069's code with Windows line endings (from its 2026-09-16 SQL-editor apply). Shown read-only: whitespace-free body and definition match the disposable copy's; attributes match. Step 2 drops and replaces this function and compares no text. **Fix:** P3.1, P3.3 and P3.5 now hash each definition with carriage returns removed (`test:prod-preflight` PF-30); pins unchanged.
  - **P6.4:** one `retest` attempt `in_progress` since 2026-09-23 under a job `abandoned_exhausted` that day (Perplexity Sonar, 0.04 USD reserved). It blocks only step 5b (`20261109180000`'s precondition). **Fix:** P6.4 is informational at step 1; step 5b keeps the requirement. Closing the attempt is its own founder-approved step (one `reconcile_attempt` call, prepared and tested first).
- **Founder decision, 2026-11-18** (relayed: "I agree."): this plan.
- **Next:** run the adjusted check again at the new R; then step 2 needs its own approval.
- **Note for PR C:** its status section becomes §39.
- **2026-11-18, later (recorded with PR C): steps 1 to 5a done on production.**
  - **Step 1:** the adjusted check, run again at `main` `e2acca3` (after #132): `PREFLIGHT: PASS`.
  - **Steps 2, 3, 4, 5 and 5a** (`20261109130000` to `20261109170000`): applied in order through the named-file procedure, run by the operator with psql in Docker. The read-only check afterwards: tail `20261109170000`, 90 ledger rows; both unscoped claims revoked from `service_role`; `read_shared_pilot_report` md5 `7b90ce86…`, the rehearsal's pin (PILOT_PRODUCTION_PLAN step 5a); RLS on; 0 jobs.
  - **Not done:** closing the 2026-09-23 attempt and step 5b, both put to the founder for approval. Nothing from step 5b onwards has been done; the worker and the web app are not redeployed.
  - From step 2 onwards the preflight fails on production by design (PROD_PREFLIGHT_SPEC, *This preflight is valid only before step 1*); it is not run there again.

## 39. Pilot retest and Outcome Cards (D-062) — branch `feat/pilot-retest`, not applied anywhere, not deployed, retest gate unset

- **Base:** D-061's branch at `f672be1` (merged to `main` as #131). The code is commit `8d07d73`; `main` at `e2acca3` (#132, the preflight's line endings) is merged in at `b0964fe`; this section's documents and the two code reviews' fixes (*Review fixes* below) are on top.
- **What it adds (D-062):**
  - **Migration** `20261109190000_pilot_retest.sql`, numbered inside D-058's window, applied after `20261109180000` (`expected_prev=20261109180000`, plan step 5c). It:
    - lets a pilot slot be a `retest` slot that names its member;
    - adds four tables: the group, its members (one M7 intervention per question and engine), its log of other changes and the writer record;
    - adds six group steps (register, record as live, prepare, withdraw, queue again, add a note), each one transaction wrapping the M7 functions and checking every result, and the helper `pilot_retest_job_is_final`;
    - adds six trigger functions and eight triggers that keep pilot members out of every generic M7 path and out of `outcome_card_artifacts`;
    - redefines `save_pilot_report_artifact` and `share_pilot_report_artifact`: `20261109160000`'s bodies plus one marked block each, which re-check every embedded card and every retest against the database.

    It writes no row, calls no provider and redefines no 0071–0079 or M5 function.
  - **The pilot console:** a **Retest** card. **Register a change to measure again** (1 to 5 questions, both baselines finished with 5 readable answers each, the customer's dated written approval, the 60-point limit and the four status rules shown); **Record the change as live**; **Prepare the retests** once the waiting period is over; **Withdraw the change** until the first retest answer; a members table with Run, Retry and review per engine, `phase: "retest"`, and **Queue again** for a retest that stopped before any answer; **Log another change**. Six new founder routes under `/api/internal/pilots/[pilotId]/retests`, behind `SNAPSHOT_APPROVAL_ENABLED` and the founder guard; register, record as live, prepare and requeue, and Run and Retry of a retest, also behind the web host's gate `ZYPACT_PILOT_RETEST_ENABLED` (exactly `"true"`, read at request time, unset).
  - **The pilot report:** a Retest section after the suggested actions. Each group's registered text, dates and log; each final retest's **Outcome Card**, with its status in words, the four status sentences, before and after with failed and excluded attempts, the difference (after minus before) and its 95% range, the 60-point limit and the smallest change this retest could show (or, when the rule can give the card no status from its answers, that it cannot show any change, and why), the customer's threshold, how it was measured, the sources, the notes with their flags, "no control questions", the evidence references and the footer from its constant. Nothing is combined across cards or engines. Any retest makes the revision need review.
  - **The generic M7 exclusions** (D-062, *The generic M7 path*).
  - **Preflight:** `20261109190000` in both P2.4 lists; the four tables and 13 functions pending (P4.1 now 24, P4.2 now 54); no new pin.
  - **Documents:** D-062; this section and the dated note in §38; `CLAUDE.md`'s inventory; PILOT_RUNBOOK §10 and §12–§16; METHODOLOGY document version 1.4 (§13–§15; the default protocol methodology version stays 1.1); PILOT_PRODUCTION_PLAN (step 5c, the retest gate as Part D, and the dated production record); PROD_PREFLIGHT_SPEC.
- **For the founder:** the departures from the design brief, every *(engineer)* value and wording, including the review fixes' customer words. The list is in D-062, *For the founder to review*. (The method note's "(D-038)" is gone after the review.)
- **Inventory on this branch** (`b0964fe` plus this section's documents, which add no file), counted on 2026-11-18:
  - 96 migrations: 82 four-digit (`0001`–`0081` and `0083`) and 14 timestamped, the last `20261113120000`;
  - 232 files matching `scripts/test-*.ts`;
  - 137 `test:*` and 4 `verify:*` commands.

  On `main` at `e2acca3`: 95 migrations, 229 files and 135 plus 4 commands. The branch adds `20261109190000_pilot_retest.sql`, `test-pilot-retest.ts`, `test-pilot-retest-schema.ts` and `test-pilot-retest-db.ts`, and registers `test:pilot-retest` and `test:pilot-retest-schema`.
- **Commands and local results** (2026-11-18, on the merged tree):

| Command | Result |
|---|---|
| `npm run typecheck`, `npm run build:verify` | exit 0 each |
| `npm run test:pilot-retest`, `test:pilot-retest-schema` (new) | 111/111, 50/50 |
| `npm run test:pilot-report`, `test:pilot-actions`, `test:pilot-questions`, `test:pilot-step1`, `test:pilot-links-claims` | 133/133, 109/109, 243/243, 75/75, 38/38 |
| `npm run test:paid-execution-guards`, `test:prod-preflight` (after merging #132), `test:chatgpt-worker`, `test:chatgpt-phase-b-schema` | 145/145, 77/77, 141/141, 74/74 (the last before merging #132; see below) |
| `npm run test:outcome-card`, `test:intervention-rpc-errors`, `test:intervention-routes`, `test:retest-actions` | 40/40, 120/120, 46/46, 32/32 |
| `npm run test:outcome-card-delivery`, `test:intervention-admin-ui`, `test:outcome-card-build`, `test:outcome-card-integrity`, `test:outcome-card-view`, `test:compare-protocols` | 51/51, 50/50, 58/58, 21/21, 40/40, 66/66 |
| `test:m7-0071-schema`, `test:m7-0073-schema` | fail with the same lines as on `main` (§30, already failing); `test:pilot-retest-schema` runs each m7 guard against the new file alone and it adds none |
| `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db` | 96 migrations applied, all green: P1 45/45, P2 71/71, E1 74/74, Q4 52/52, pilot step 1 60/60, pilot questions 70/70, pilot report 39/39, pilot actions 53/53, pilot links and claims 28/28, ChatGPT phase B 81/81, pilot retest 112/112 (new) |
| Preflight rehearsal: a fresh disposable `supabase/postgres:17.6.1.167` at the recorded state (85 rows, tail S1, `-v expected_sysid` set to that cluster's own identifier), this branch's preflight | every must-pass check PASS, `PREFLIGHT: PASS`, exit 0. Negative controls: one new table present → P4.1 only, `FAIL (1)`, exit 3; one new function present → P4.2 only, `FAIL (1)`, exit 3 |
| On the same database, through the named-file procedure | `20261109190000` with the tail at S1, and again at `20261109170000`: refused, exit 3, ledger unchanged (the second also by its own precondition with `expected_prev` set to the real tail). `20261109130000`–`20261109170000` in order, then `20261109180000`, then `20261109190000` (`expected_prev=20261109180000`): exit 0 each; 92 rows, tail `20261109190000`. The preflight then fails by design: P2.3, P2.4, P2.5, P3.3, P3.4, P3.5, P4.1, P4.2, `FAIL (8)`, exit 3 |
| md5 at tail `20261109180000` (the migration's precondition 4) | save `prosrc` `e66f4dd316ff2f2cb250442b5fc119f2`, share `prosrc` `dc8b5f430f0d4ebd630e6793e64e669e` |
| md5 of `pg_get_functiondef` after the apply | save `46738a76be0bf9176278db6ccb6832b4`, share `7763dadf4df6c9d7aa5cf86f2d6a9a7f` (superseded by the review fixes below: share `d53b169fb8b649bc67272b4fde87fcb5`); the 13 new functions are listed in PILOT_PRODUCTION_PLAN step 5c |

| After this section's documents: `npm run typecheck` | exit 0 |
| After the documents: `test:prod-preflight` (reads PROD_PREFLIGHT_SPEC), `test:pilot-retest-schema`, `test:pilot-retest` | 77/77, 50/50, 111/111 |
| After the documents: `test:pilot-actions` (reads DECISIONS, this file and PILOT_RUNBOOK), `test:pilot-links-claims` (reads DECISIONS, this file, WORKER_DEPLOY_RUNBOOK and PILOT_PRODUCTION_PLAN), `test:pilot-report`, `test:pilot-questions` | 109/109, 38/38, 133/133, 243/243 |
| After the documents: the 0051 to 0054 schema contracts (read DECISIONS); `test:chatgpt-worker`, `test:chatgpt-adapter` | 117/117, 67/67, 74/74, 150/150; 141/141, 195/195 |
| After the documents: `test:chatgpt-phase-b-schema` | 73/74: S46 fails, and fails identically on `main` at `e2acca3`. #132 made P3.5 hash the definition with carriage returns removed, and S46's pattern still expects the earlier `md5(pg_get_functiondef(oid))` text. Not caused by this branch |
| After the documents: `test:bqi-wording`; `test:q2p1-scope`, `test:q2p2-scope` | 109/110, its P-04 change-scope check; 3 and 4 failures, no scope base set. The same as on `main` (§30, §37) |
| `git diff --check` | clean |

- **Review fixes** (2026-11-18, after two independent code reviews; uncommitted on top of `b0964fe`). Every new rule is marked *(engineer)* in D-062:
  - **Database** (the migration is not applied anywhere, so it was changed in place; save and share stay `20261109160000`'s bodies outside the marked blocks):
    - the share re-checks M1: a revision whose cards are no longer exactly the final retests with an attempt is `RETESTS_STALE` (a retest that could be retried at the save and is final once the pilot ends or closes);
    - the precondition and postcondition pins hash `prosrc` with carriage returns removed (as PF-30); the pins are unchanged;
    - preparation reads back each retest's run, retry and spend caps against its baseline's;
    - tests: P4 asserts ChatGPT 7/2/4 and Perplexity 7/2/2; P6 (a retest under other caps is refused); S5 now beside a withdrawal step, which writes its step row; K5 (after one group's confirm step, a generic abandon on its member and a generic confirm on another group's member are each refused); G9–G11 (precondition 2's index, `add_pilot_question_engine` and consistency function, precondition 3's other six signatures, precondition 6's Outcome Card branch); V15 (the share's M1 re-check).
  - **Application:** a card shows the smallest change it could show only when the rule could give it a status from its answers, otherwise "This retest cannot show any change: …" (5 vs 2 no longer prints 80 points); "Difference (after minus before)" and "difference" in the rule sentences and method note; no "(D-038)" in customer text; "No departure" only for a change made as registered; the evidence link and source-action titles linted at build (kept in the payload, left out of the page and Markdown, needs review); the register body limit 64 KB and the three request-shape codes in words; the M17 line says "may have been collected".
  - **Also:** `test:chatgpt-phase-b-schema` S46 follows P3.5's carriage-return form (74/74 again); `.env.example` documents `ZYPACT_PILOT_RETEST_ENABLED` in comments only.
  - **Rehearsal re-run** (same procedure as above, fresh disposable database): preflight PASS at the recorded state, both negative controls `FAIL (1)`, the out-of-order applies refused, steps 2 to 5c exit 0 (92 rows); precondition pins at tail `20261109180000` `e66f4dd3…`/`dc8b5f43…`, the same with and without carriage returns removed. After the apply only two definitions changed: `share_pilot_report_artifact` `d53b169fb8b649bc67272b4fde87fcb5` and `prepare_pilot_retests` `dfdee5f0d3ecf336102808e14538be4f` (PILOT_PRODUCTION_PLAN step 5c); every value is the same with and without carriage returns removed. The preflight then fails by design, `FAIL (8)`.
  - **Results after the fixes:** `typecheck` and `build:verify` exit 0; `test:pilot-retest` 118/118, `test:pilot-retest-schema` 51/51, `test:pilot-report` 133/133, `test:pilot-actions` 109/109, `test:pilot-questions` 243/243, `test:pilot-step1` 75/75, `test:pilot-links-claims` 38/38, `test:chatgpt-phase-b-schema` 74/74, `test:prod-preflight` 77/77, `test:paid-execution-guards` 145/145, `test:m5-b3-max-runtime` 189/189; the intervention and Outcome Card suites unchanged and green; `ZYPACT_P2_DB_LOCAL=1 npm run test:p2-workspace-db`: 96 migrations, every suite green, pilot retest 118/118; `ZYPACT_LEVEL2_LOCAL=1 npm run test:snapshot-worker-postgres-level2`: `LEVEL2_RESULT=PASS` (the runner exits 1 from its known cleanup trap).
  - **Mutations:** 3 for the card's smallest change and 2 for the share's M1 re-check, plus 1 for the caps readback, each caught (R13/R14, V15 and P7b, P6), every file restored and its sha256 checked.
- **Mutation trials:** 8 by the application's builder (for example a held retest counted as final, a card from a final retest with no attempt, the footer taken from the payload, register or a retest Run outside the gate, no withholding at build, a member's generic transition allowed, a guard message falling to the generic 500) and 5 by the database's builder; each was caught, and every file was restored with its sha256 checked.
- **Not established:**
  - no live retest has been run;
  - no browser walk-through of the console or the report;
  - the application's payload has never gone through the real `save_pilot_report_artifact`: the DB suite builds its payloads in SQL;
  - nothing is applied to any hosted database; the md5 values above come from the disposable rehearsal only and have never been observed on production.
- **Open:**
  - the founder's review of D-062;
  - `test:chatgpt-phase-b-schema` S46 has failed on `main` since #132 (above); fixed on this branch by the review fixes, so it stays failing on `main` until this branch merges;
  - the questions D-061 left open, unchanged.

## 40. Production record, 2026-11-18, and the ChatGPT switch (Part C, step C2)

Recorded from the operator's checks on 2026-11-18. Each step had the founder's written approval, relayed by the engineer. Production identifiers are not recorded here.

- **Step 1** (read-only preflight): PASS at `main` `e2acca3`, with P6.4 informational (one attempt open since 2026-09-23).
- **Steps 2–5a:** applied through the named-file procedure (`--single-transaction`, `target_sysid`, `expected_prev`). The ledger tail was `20261109170000` with 90 rows, the unscoped claims were revoked, every pilot table had RLS on, and no job was claimed or running.
- **Close-out before step 5b:** the one open attempt was closed with one call of 0047's `reconcile_attempt`, status `excluded`. It was a retest attempt reserved on 2026-09-23 under a job left `abandoned_exhausted`. Its 0.04 USD cost was kept and nothing was deleted. The statement had first been tested on a disposable copy, where it refused when no attempt or more than one was open, and refused a second run.
- **Step 5b:** `20261109180000` applied. The tail is `20261109180000`, with 91 rows, no open attempt and no running job.
- **Step 6:** the worker was redeployed from `e2acca3` (Fly release v7) on the same machine, which stayed `stopped`. Check (c) observed 7 slots, a 2,400 s runtime, a 330 s lease, a 240,000 ms readiness window and a 290,000 ms ChatGPT timeout. Check (d) observed `WORKER_CHATGPT_ENABLED` `false`, with no same-named secret.
  - The `--digest` provenance comparison waits for the first authorised start.
  - A first deploy attempt from an account Fly had flagged was refused by Fly's builder, and changed nothing.
- **Step 7:** the web app is deployed from `e2acca3`.
  - `ZYPACT_ACCOUNTS_ENABLED` had been set to `true` on the web host, with `ZYPACT_SIGNUP_MODE` `pilot`, contrary to the recorded state. It was removed with the founder's agreement before this deploy, and `/account` now answers 404.
  - `account_sessions` held 2 rows.
  - `/admin/pilots` loads, and ChatGPT shows "Not connected".
- **Step 8:** set on the web host's Production environment:
  - paid execution `true`, with a daily ceiling of `10`;
  - `SNAPSHOT_APPROVAL_ENABLED` and `INTERVENTION_ADMIN_ENABLED` both `true`;
  - the three Fly worker-control names. The token is a deploy token scoped to the worker application, expiring 2027-11-18.

  The legacy pipeline, auto-delivery and ChatGPT gate names are absent.
- **Step 9:** the worker secrets for paid execution `true` and a daily ceiling of `10` were set (Fly release v8). The machine stayed `stopped` with check (c) and (d) values unchanged.
- **Step 10 is skipped by the founder's decision.** Production shows that the self-test retest already ran. Its 2026-10-09 retest succeeded, and its Outcome Card passed integrity, read `no_clear_change` and was delivered. A second intervention, implemented 2026-10-10, was retested on 2026-10-25 and also read `no_clear_change`, with its card undelivered. `SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md` still reads "window OPEN" and is out of date. All three retests ran on the worker deployed before step 6.
- **Not yet run in production:** any job on the step 6 worker; the pilot console end to end; ChatGPT. There is no pilot customer yet. The founder asked for an end-to-end practice pilot on Zypact's own site first, covering both engines, a retest and the Outcome Card.
- **Part C, step C2 (this pull request):**
  - `fly.worker.production.toml` sets `WORKER_CHATGPT_ENABLED = "true"`. Staging and the template stay `"false"`.
  - The hosting contract now states the switch per deployable file, as it states the execution mode, so a flip either way breaks the contract instead of passing as a toml edit.
  - The founder approved turning ChatGPT on (relayed, 2026-11-18).
  - Order:
    1. C1, the measurement key as a worker secret;
    2. merge this pull request (R′) and redeploy the worker from it under WORKER_DEPLOY_RUNBOOK §6 and §6a, with check (d) expecting `true`;
    3. C3, the web gate;
    4. C4 keeps the 10 USD ceiling for the first supervised ChatGPT day.
  - **R rule (updated after PR #133 merged as `0f5b0da` on 2026-11-18):** R′ now carries `20261109190000` (the pilot retest, §39), which is below `20261110120000` and not applied. So **step 5c is applied before the C2 worker deploy**, under its own approval, with the step 5c checks and fingerprints in PILOT_PRODUCTION_PLAN. The retest gate `ZYPACT_PILOT_RETEST_ENABLED` stays unset (Part D).

## 40a. Production record, 2026-11-18 to 2026-11-20: step 5c, Part C, and the practice pilot

Recorded from the operator's checks. Each production step had the founder's written approval, relayed by the engineer. Production identifiers are not recorded here. This extends §40.

- **Step 5c:** `20261109190000` (the pilot retest, §39) was applied through the named-file procedure before the C2 worker deploy, because PR #133 merged before PR #134 and the R rule then required it. After: tail `20261109190000`, 92 rows, the 8 retest triggers present and enabled, and the retest tables in place with RLS on. The retest gate `ZYPACT_PILOT_RETEST_ENABLED` stays unset (Part D).
- **C1:** the measurement key was set as a worker secret by the operator in their own terminal (Fly release v9). Its value was never shown in chat or recorded.
- **C2:** the worker was redeployed from `main` `2aa3e68` (#134; Fly release v10) on the same machine, which stayed `stopped`. Check (c) was unchanged from step 6, and check (d) observed `WORKER_CHATGPT_ENABLED` `true`, with no same-named secret.
- **C3:** `ZYPACT_PILOT_CHATGPT_ENABLED` was set to `true` on the web host's Production environment, followed by a redeploy.
- **The first runs on the step 6/C2 worker (2026-11-18):** a practice pilot for Zypact itself, with 3 questions supplied by the founder (recorded on the pilot as supplied by the customer, since Zypact is the customer of its own practice run).
  - The first Perplexity job succeeded, and its start event's `--digest` provenance comparison matched `2aa3e68`.
  - The first ChatGPT job succeeded under setting `openai-responses-websearch-v4`, model `gpt-5.4-2026-03-05`, service tier flex.
  - One ChatGPT request was refused by the flex tier (`flex_capacity_unavailable`) and was retried by hand, as D-059 item 5 provides. The refused attempt stays visible; no cost was recorded for it.
- **C4, the daily ceiling:** the first ChatGPT day started at 10 USD.
  - With ChatGPT queued, the gate counts each ChatGPT call at no less than 0.54 USD and adds the largest queued cap (4 USD) to the last 24 hours' spend. At 10 USD that left room for about two ChatGPT questions per day.
  - The founder approved 20 USD (D-059 item 4). It was set on the web host first. The worker, still at 10 USD, refused four starts with `spend_ceiling_reached` and spent nothing. Its secret was then set to 20 (Fly release v11). Both hosts must carry the same value.
- **The practice pilot's evidence (read-only check, 2026-11-20):**
  - Perplexity, model `sonar` (`https://api.perplexity.ai/v1/sonar`): 15 attempts, 15 completed.
  - ChatGPT (OpenAI Responses API with web search): 16 attempts, 15 completed, 1 not completed (the flex refusal).
  - Every completed attempt, on both engines, has a provider-call receipt with a stored response SHA-256.
  - `protocol_attempts.actual_cost_usd` is null on every attempt; the cost lives per call in `protocol_external_calls`.
- **The practice pilot's API cost** (`protocol_external_calls`, read-only):

  | Engine | Answers | Analysis model | Total |
  |---|---|---|---|
  | Perplexity | 0.0653 USD, measured | 0.1422 USD, estimated | 0.2075 USD |
  | ChatGPT | 1.4431 USD, estimated | 0.1623 USD, estimated | 1.6054 USD |
  | **Total** | | | **1.8129 USD** |

  "Estimated" is the provider's reported token and search usage priced by our tables, not an invoice; it is to be compared with the providers' billing pages. 9.56 USD was reserved for this 1.81 USD: a ChatGPT answer cost about 0.10 USD against 0.54 USD reserved. The reservation keeps the paid-call guarantee; it is why the daily ceiling, not the cost, sets the pace.
- **The first pilot report** was built and read by the founder. The founder's review (2026-11-19) led to §41 (D-063).
- **The self-test record is closed:** SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md now records the two retests that ran (§40, step 10).
- **Open:**
  - the working daily ceiling for a customer pilot (founder decision; see PILOT_RUNBOOK §8.1);
  - every worker report pass re-processes the same 8 older snapshot requests and holds them (nothing is sent). To be reviewed;
  - revoking the older Fly application token that predates the step 8 deploy token;
  - step 5d and the web deploy for §41, each under its own approval;
  - Part D (the retest gate) and the practice pilot's retest and Outcome Card, which the founder asked to validate separately.

## 41. Pilot report clarity (D-063) — branch `feat/pilot-report-clarity`, not applied anywhere, not deployed

- **Why:** the founder's review of the practice pilot report (2026-11-19): too technical at the top, one competitor under several spellings, too many "Unclassified" sources without the websites behind them, pilot dates mixed with measurement dates, and no sign that the report was a practice run.
- **What changed (application):** `lib/reports/competitor-aliases.ts` (new), `build-pilot-report.ts` (competitors under `pilot-competitor-names/2`, the website table, the summary, the purpose), `pilot-report-types.ts`, `pilot-report-copy.ts`, `pilot-report-presentation.ts`, `render-pilot-report-markdown.ts`, `components/report/pilot-report-view.tsx`, `read-pilot-evidence.ts` (reads `pilots.purpose` on its own, unknown when it cannot), the purpose route and control on the pilot's admin page, and the two DB adapters.
- **What changed (schema):** `20261109200000_pilot_purpose.sql`, PILOT_PRODUCTION_PLAN step 5d (`expected_prev=20261109190000`; 93 ledger rows after). The preflight lists it as pending (P2.4) and `set_pilot_purpose` as a pending function (P4.2: 55).
- **Tests:** new `test:pilot-report-clarity` and `scripts/test-pilot-purpose-db.ts` (in the local DB runner); updated `test:pilot-report` (I5c, X2) and `test:pilot-retest-schema` (F1: 55). Commands and results are in the pull request.
- **Inventory after this branch:** 97 migrations (82 four-digit and 15 timestamped, the last `20261113120000`; the new `20261109200000` sits inside the pilot window), 234 files matching `scripts/test-*.ts`, and 138 `test:*` commands (one more: `test:pilot-report-clarity`).
- **Open:** founder confirmation of the new wording, the alias seed and the four rules; extending the alias list and `source-types/1` from the practice pilot's real names and domains (each a separate, reviewed change); step 5d in production; a report rebuilt from production evidence and reviewed before any customer sees it.
