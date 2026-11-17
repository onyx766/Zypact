# Production preflight (read-only)

Referenced by D-041, D-058 and CURRENT_STATUS §20.6, §24, §25 and §30–§34, and by [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md).

- **Current version: re-baselined 2026-11-17** to production as CURRENT_STATUS §25 records it after S1. **This version has never been run against production.** Running it is a gate of its own: the founder authorises it, and it changes nothing.
- **The first version** (written 2026-11-09, baseline 0001–0081) ran once against production on 2026-11-09 with every must-pass check PASS, before 0083, Q2′-1, Q2′-2 and S1 were applied. See *History* below.

## Purpose

Before any pending migration is applied to production, confirm the production database is exactly in the state the next apply was rehearsed against.

- **Recorded production state** (CURRENT_STATUS §25): 0001–0080, the 0081 alias `20260924023646`, 0083, Q2′-1 `20261102132000`, Q2′-2 `20261103173000` and S1 `20261109120000`. That is 85 ledger rows, with tail `20261109120000`.
- **Next pending migrations** under D-058's proposed release order: pilot step 1 `20261109130000`, pilot questions `20261109140000`, pilot report `20261109150000`, then pilot actions `20261109160000`.
- **Still unapplied, and after those:** P1 `20261110120000`, P2 `20261111120000`, E1 `20261112120000` and Q4 `20261113120000`.

The Supabase project named **`zypact-staging` is the production database** (D-041). There is no separate staging database.

## What it is

[`scripts/sql/prod-preflight.sql`](../scripts/sql/prod-preflight.sql) has the following properties:

- **One `READ ONLY` transaction, rolled back.** It has no write, lock, grant or schema statement, and `npm run test:prod-preflight` enforces that.
- **It prints only** check ids, PASS/FAIL, versions, hashes and counts. It prints no customer row, email, token, prompt or evidence.
- **Timeouts:** 30 seconds per statement and 2 seconds per lock.

## Before running

1. **Authorisation.** The founder authorises the run.
2. **Code.** Check out the `main` commit that is being released.
3. **Worker.** Stop the protocol worker (see [WORKER_DEPLOY_RUNBOOK.md](WORKER_DEPLOY_RUNBOOK.md)) and confirm no job is running.
4. **Connection string.** Take it from Supabase: Project Settings → Database. Use the `postgres` role, which can read `pg_control_system()`.
   - Keep it in your shell only.
   - Never paste it into chat, an issue, a pull request or a file in the repository.

## Run

```bash
export PGCLIENTENCODING=UTF8
psql -X -q -v ON_ERROR_STOP=1 "<connection string>" -f scripts/sql/prod-preflight.sql
```

`PGCLIENTENCODING=UTF8` matters on Windows: the migration files contain non-ASCII characters, and a WIN1252 client refuses them.

## Checks

| Id | Must be | Meaning |
|---|---|---|
| P1.1 | info | The cluster's system identifier. Record it privately; it is not published. |
| P1.2 | PASS | This role can read `pg_control_system()`. |
| P1.3 | PASS | PostgreSQL 15 or later. Production reported 17.6 on 2026-11-09. |
| P1.4 | info | The database name. |
| P2.1 | PASS | The ledger holds 0001 to 0080, each once. |
| P2.2 | PASS | The ledger holds the 0081 alias `20260924023646`. |
| P2.3 | PASS | The ledger tail is `20261109120000` (S1). It is the `expected_prev` of pilot step 1 at `20261109130000`. |
| P2.4 | PASS | None of these is recorded: 0081, 0082, 0084, 0085; the four pilot versions `20261109130000`–`20261109160000`; P1 to Q4, `20261110120000`–`20261113120000`; and the pilot migrations' old numbers `20261114120000`, `20261118120000`, `20261119120000` and `20261120120000`, so an apply under an old name is caught. |
| P2.5 | PASS | Exactly 85 ledger rows: no version anyone added outside the procedures. |
| P2.6 | PASS | The 4 applied versions, 0083, `20261102132000`, `20261103173000` and `20261109120000`, are each recorded. |
| P3.1 | PASS | `reconcile_attempt_for_job` is exactly as 0083 left it: md5 `721e487901b2272708e38565b7070c53`, the reserved procedure's `post_def`, which that procedure verified at the apply. |
| P3.2 | PASS | Only `service_role` may execute it. |
| P3.3 | PASS | `approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)` is exactly as 0069 left it: md5 `710dfb5cb84ce09a94040ebb84086025`. That was recomputed on 2026-11-17 on a disposable stack at the recorded production position (every migration up to S1). Pilot step 1 (D-052) redefines it. |
| P3.4 | PASS | Its five-argument version does not exist yet. |
| P4.1 | PASS | None of the 20 pending tables exists: pilot step 1, pilot questions, pilot report, pilot actions, P1, P2, E1 and Q4. |
| P4.2 | PASS | None of their 38 new public functions exists, nor any `_p1_`, `_p2_`, `_e1_` or `_q4_` helper. A function they redefine that already exists is checked by its pinned pre-state instead (P3.3). |
| P4.3 | PASS | `projects`, `buyer_question_versions`, `snapshot_requests`, `protocol_execution_jobs` and `protocol_attempts`, which the pilot migrations reference, exist. |
| P4.4 | PASS | All 25 applied tables exist: Q2′-1's 15, Q2′-2's 8 and S1's 2. |
| P4.5 | PASS | All 12 applied public functions exist: Q2′-1's 6 and S1's 6. |
| P4.6 | info | The count of `_q2p_`, `_q2p2_` and `_s1_` helpers. On a disposable stack at this position it is 40. |
| P5.1 | PASS | `anon`, `authenticated` and `service_role` exist. |
| P5.2 | PASS | `service_role` has BYPASSRLS. |
| P6.1 | PASS | No protocol job is `claimed` or `running`. |
| P6.2 | info | Other sessions with a transaction open over 60 seconds. |
| P6.3 | PASS | No protocol job is `queued`. The worker redeploy needs an empty queue (WORKER_DEPLOY_RUNBOOK §6). If a job is queued, for example the self-test retest, stop and let the founder decide whether to run it on the old worker or cancel it before going on. |

**Validated locally on 2026-11-17.** The check ran against a disposable `supabase/postgres:17.6.1.167` built to the recorded production state: every migration through S1 in filename order, and the ledger rows written as production holds them (80 + alias + 0083 + 3 = 85).

- Every must-pass check passed.
- P3.1 computed `721e4879…`, the reserved procedure's `post_def`. P3.3 computed `710dfb5c…`, the existing pin.
- After pilot step 1 was applied to the same database and recorded, P2.3, P2.4, P2.5, P3.3, P3.4, P4.1 and P4.2 failed, as they should.
- **Not exercised:** a queued job making P6.3 fail.

The run is in the D-058 pull request's notes, and `npm run test:prod-preflight` enforces the structure: the applied set is a prefix of the migrations on disk, every pending object is checked absent, every applied object is checked present, and the pins are as stated.

## Decision

- **Every must-pass check is PASS:** the founder may be asked to authorise the next apply (pilot step 1, `20261109130000`, `expected_prev=20261109120000`).
- **Any FAIL, or P1.2 shows `NO ACCESS`:** stop. Apply nothing, and record what was observed. A failing preflight is not worked around.

Record the date, the commit and the full output **privately**. CURRENT_STATUS records only the result and the date, not the system identifier.

## The apply sequence afterwards

This is for reference only. **Each step needs its own founder authorisation**, run in this order, never with `supabase db push` or `supabase migration repair` (D-041). Every apply runs in one transaction with its ledger row, so a failure leaves nothing behind. The full plan, including the worker and web steps, is [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md).

The procedure is the D-041 named-file text. The repository holds its rehearsal copy, [`scripts/sql/sv1-apply-named-migration.sql`](../scripts/sql/sv1-apply-named-migration.sql), whose header says *never run against a remote database*. The production copy is the body below that header, unchanged, and must match the source sha256 the header records. Preparing that copy is part of each step's authorisation.

**Done** (CURRENT_STATUS §25): 0083 (reserved version), then Q2′-1, Q2′-2 and S1 (named file).

**Proposed next** (D-058, the founder's choice):

| Step | Procedure | Arguments |
|---|---|---|
| 1. Pilot step 1 | named file | `new_version=20261109130000`, `new_name=pilot_step1_operator_controls`, `expected_prev=20261109120000` |
| 2. Pilot questions | named file | `new_version=20261109140000`, `new_name=pilot_questions`, `expected_prev=20261109130000` |
| 3. Pilot report | named file | `new_version=20261109150000`, `new_name=pilot_report_artifacts`, `expected_prev=20261109140000` |
| 4. Pilot actions | named file | `new_version=20261109160000`, `new_name=pilot_actions`, `expected_prev=20261109150000` |

P1, P2, E1 and Q4 follow later, behind the D-045 gates, with `expected_prev=20261109160000` for P1.

- **Why this position.** The four pilot migrations depend on nothing in P1 to Q4, and P1 to Q4 define no function the pilot migrations define. Both stacks reference only earlier tables, through foreign keys. On 2026-11-17 the full schema dump (privileges and comments included) was identical with the pilot migrations in the old order (after Q4) and the new order (after S1): 26,440 lines.
- **What each migration redefines:**
  - Pilot step 1 redefines `approve_and_launch_snapshot_baseline` (pinned by P3.3).
  - Pilot questions redefines step 1's `request_protocol_job_run`, `claim_requested_protocol_execution_job` and `retry_failed_protocol_job`.
  - Pilot actions redefines the report's `save_pilot_report_artifact` and `share_pilot_report_artifact`.

  All of these are unapplied, so they are checked by absence.

**This preflight is valid only before step 1.** Once pilot step 1 is applied it fails by design, so do not re-run it as a post-check. After each step, confirm that the ledger tail, the row count and that step's objects are as expected (PILOT_PRODUCTION_PLAN.md lists the checks).

## Recovery

- **A failed apply** rolls back entirely: the migration and its ledger row together.
- **Undoing a completed step** is a forward migration, separately authorised, using each migration's header recovery notes, in the reverse order (actions, report, questions, step 1). The web app is rolled back first.

## What it does not show

- That the application, the worker or the Supabase Auth settings are ready.
- What the deployed worker image is, or what its secrets and switches are set to (PILOT_PRODUCTION_PLAN.md, *Check read-only first*).
- That a data row is correct. It reads catalog metadata, the ledger and four counts.

## History

- **2026-11-09:** first version, baseline 0001–0081 with tail `20260924023646` and 81 rows; it pinned 0083's pre-state, `baaf43cc…`. It ran against production at 17:12 PST at `main` `60720a2`: all 15 must-pass checks PASS (CURRENT_STATUS §25). It then failed by design once 0083 was applied.
- **2026-11-17:** re-baselined to the post-S1 state, with P2.6, P4.4, P4.5, P4.6 and P6.3 added, and the pilot migrations renumbered under D-058.
