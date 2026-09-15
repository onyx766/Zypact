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

**What this does not claim.** Phase 3C exercised the deployed worker against an empty queue only. It establishes readiness, execution-enabled worker start, idle proof over three consecutive no-job cycles, zero iterations, graceful stop, and versioned return to `disabled`. It does not establish job claiming, provider execution, receipt durability, browser-disconnect survival, anti-double-payment behavior, abandoned-job recovery, or structured error/alert handling. Those M5 acceptance requirements remain open. This evidence does not close M5.
