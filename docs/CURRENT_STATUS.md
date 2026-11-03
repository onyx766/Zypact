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
   while only one job is ever queued.
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

## 20. Q2′-1 account-first data foundation — local commits only, not pushed, not applied anywhere

- **As of:** 2026-11-02
- **Base:** `main` at `13ccdc1` (merge of #97, the D-040 documents)
- **Status:** **local only, awaiting independent review of the email-binding
  correction.** Five local commits form a straight line on
  `feat/q2p1-account-foundation`: `13ccdc1` → `0d3f3f6` (B1 revision 3,
  migration-name rules) → `20e5755` (Q2′-1) → `6a258f6` (remediation R1–R4) →
  `f7ce558` (remediation R6) → the email-binding commit that adds this
  paragraph. The independent source review of the first four commits requested
  changes: F4 compared a caller-supplied email HMAC with the invitation's own
  value and never read the persisted request address, so an approval succeeded
  after that address changed (reproduced locally). The fifth commit corrects
  that (20.2, "Email binding") and the two documentation errors the review
  found (D-041's guard count, D-042's tenant-pinning claim). Nothing
  has been pushed. No pull request, cloud CI run or Vercel Preview exists, and
  no SQL from this branch has run against any Supabase project. The migration
  has run only in disposable local PostgreSQL containers with
  `--network none`. **No result here is independently reviewed, and the
  author does not self-certify it.** The next decision is independent review,
  not production deployment.
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
| `npm run test:q2p-schema` (QS-01 to QS-26, Q1 compatibility, 46 mutation self-tests) | offline | 209/209 |
| `scripts/test-snapshot-worker-postgres-level2.sh` | PostgreSQL 16-alpine `sha256:0cefaabd…31ab`, `--network none` | 634 passed, 0 failed (386 Q2′-1, including 30 for QR-41 to QR-43; 25 R6; 220 existing; 3 role preconditions) |
| Production-order run: Q2′-1 applied through the named-file procedure before 0083, the full Q2′-1 suite, QR-35, then 0083 by the reserved-version procedure; schema compared with CI order | PostgreSQL 17.6 `sha256:00bc8661…2929`, `--network none` | 426 passed, 0 failed, in two identical runs (388 QR + 25 R6 + 10 P + 3 roles); schema dump equals CI order |
| The 21 B1 test suites | offline | logs byte-identical to the `f7ce558` run |
| The 9 M0 CI-workflow suites | offline | all pass |
| `npm run typecheck`, `npm run build:verify` | local | pass, pass |
| `git diff --check f7ce558..HEAD` | local | clean |

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
not digest. **No CI run has executed any of this.**

`package.json` now registers 104 `test:*` and 4 `verify:*` commands. 192 files
match `scripts/test-*.ts`, and `supabase/migrations/` holds 83 files: the 82
historical files plus `20261102132000`. These figures supersede section 19.1's.

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
- **Not run by CI,** and not independently reviewed.

### 20.6 Remaining gates before production

Each gate needs its own authorisation, in this order:

1. Independent review of the email-binding commit. `0d3f3f6`, `20e5755`,
   `6a258f6` and `f7ce558` were reviewed, with REQUEST CHANGES.
2. Push and pull request, with advance notice that CI's Level 2 job will apply
   every migration, including 0083 and Q2′-1, to a disposable database, that
   the M0 workflows will run, and that a Vercel Preview will be built.
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
