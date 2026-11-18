# Production preflight (read-only)

Referenced by D-041, D-058, D-060, D-061 and D-062, CURRENT_STATUS §20.6, §24, §25, §30–§34 and §36–§39, and [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md).

- **Current version: re-baselined 2026-11-17** to production as CURRENT_STATUS §25 records it after S1. **This version has never been run against production.** Running it is a gate of its own: the founder authorises it, and it changes nothing.
  - **2026-11-18:** this baseline has now run against production: `FAIL (2)` at `2ae02e1`, then, after #132, `PREFLIGHT: PASS` at `e2acca3` (*History*). Steps 2 to 5a were applied after that, so from then on it fails on production by design and is not run there again.
  - **2026-11-18 (D-061):** edited for ChatGPT phase B, on the same baseline. `20261109180000` is in both P2.4 lists, three more pending functions are checked absent (P4.2: 41), and the new P3.5 pins `persist_probe_result_for_job`, which that migration redefines. After the review of D-061, P6.4, P7.1 and P7.2 check the data that migration's preconditions read: 29 checks, of which 27 must pass. This edited version has not run against production either. **2026-11-18:** it has: the `e2acca3` run above is this version, with #132's change.
  - **2026-11-18 (D-062):** edited for the pilot retest, on the same baseline. `20261109190000` is in both P2.4 lists, and its four tables and 13 functions are checked absent (P4.1: 24, P4.2: 54). No pin is added, and the number of checks is unchanged. This version has run only on disposable databases (*History*); production is past the point where it can pass.
- **The first version** (written 2026-11-09, baseline 0001–0081) ran once against production on 2026-11-09 with every must-pass check PASS, before 0083, Q2′-1, Q2′-2 and S1 were applied. See *History* below.

## Purpose

Before any pending migration is applied to production, confirm the production database is exactly in the state the next apply was rehearsed against.

- **Recorded production state** (CURRENT_STATUS §25): 0001–0080, the 0081 alias `20260924023646`, 0083, Q2′-1 `20261102132000`, Q2′-2 `20261103173000` and S1 `20261109120000`. That is 85 ledger rows, with tail `20261109120000`.
- **Next pending migrations** under D-058's release order (approved by the founder on 2026-11-17): pilot step 1 `20261109130000`, pilot questions `20261109140000`, pilot report `20261109150000`, then pilot actions `20261109160000`.
  - **Then** (D-060, 2026-11-17): the pilot links and claim scope `20261109170000`, inside D-058's window, with `expected_prev=20261109160000`.
  - **Then** (D-061, 2026-11-18): the ChatGPT measurement schema `20261109180000`, inside the same window, with `expected_prev=20261109170000`.
  - **Then** (D-062, 2026-11-18): the pilot retest `20261109190000`, inside the same window, with `expected_prev=20261109180000`.
- **Still unapplied, and after those:** P1 `20261110120000`, P2 `20261111120000`, E1 `20261112120000` and Q4 `20261113120000`.

The Supabase project named **`zypact-staging` is the production database** (D-041). There is no separate staging database.

## What it is

[`scripts/sql/prod-preflight.sql`](../scripts/sql/prod-preflight.sql) has the following properties:

- **One `READ ONLY` transaction, rolled back.** It has no write, lock, grant, schema, role or session statement, and no function with a side effect. `npm run test:prod-preflight` enforces that.
  - The contract test also inserts each forbidden pattern into a copy and proves it is caught. The patterns are advisory locks, a session `set_config`, `pg_terminate_backend`, `set role`, `nextval`, every write and DDL keyword, a second DO block, and psql includes and shell escapes.
- **The one DO block** only raises. It runs only when a must-pass check failed, so psql exits non-zero under `ON_ERROR_STOP`.
- **It confirms its target.** It requires `-v expected_sysid=<value>`, and P1.1 passes only when the cluster's system identifier equals it.
- **It fails closed.**
  - Only P1.4 and P6.2 are informational. Every other check must come out exactly true; false or null is a FAIL.
  - With `row_security = off`, a role without BYPASSRLS errors instead of reading 0 rows.
- **Output:** one line per check (`id`, `PASS`/`FAIL`/`info`, label, observed value), then a last line, `PREFLIGHT: PASS` or `PREFLIGHT: FAIL (n)`. It prints no customer row, email, token, prompt or evidence.
- **Exit code:** 0 only on `PREFLIGHT: PASS`.
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
psql -X -q -v ON_ERROR_STOP=1 -v expected_sysid=<from your private record> \
     "<connection string>" -f scripts/sql/prod-preflight.sql
echo "exit $?"
```

`expected_sysid` is the system identifier recorded privately when the first version ran on 2026-11-09. Read it from your own record; it is never written into the repository, a pull request or a chat. Without it, or with a different value, P1.1 fails.

`PGCLIENTENCODING=UTF8` matters on Windows: the migration files contain non-ASCII characters, and a WIN1252 client refuses them.

## Checks

| Id | Must be | Meaning |
|---|---|---|
| P1.1 | PASS | This is the target database: the cluster's system identifier equals `-v expected_sysid`. The observed value is printed; keep the output private. |
| P1.2 | PASS | This role can read `pg_control_system()`. |
| P1.3 | PASS | PostgreSQL 15 or later. Production reported 17.6 on 2026-11-09. |
| P1.4 | info | The database name. |
| P2.1 | PASS | The ledger holds 0001 to 0080, each once. |
| P2.2 | PASS | The ledger holds the 0081 alias `20260924023646`. |
| P2.3 | PASS | The ledger tail is `20261109120000` (S1). It is the `expected_prev` of pilot step 1 at `20261109130000`. |
| P2.4 | PASS | None of these is recorded: 0081, 0082, 0084, 0085; the four pilot versions `20261109130000`–`20261109160000`; the pilot links and claim scope `20261109170000` (D-060); the ChatGPT measurement schema `20261109180000` (D-061); the pilot retest `20261109190000` (D-062); P1 to Q4, `20261110120000`–`20261113120000`; and the pilot migrations' old numbers `20261114120000`, `20261118120000`, `20261119120000` and `20261120120000`, so an apply under an old name is caught. The version is in both lists, the checked one and the printed one. |
| P2.5 | PASS | Exactly 85 ledger rows: no version anyone added outside the procedures. |
| P2.6 | PASS | The 4 applied versions, 0083, `20261102132000`, `20261103173000` and `20261109120000`, are each recorded. |
| P3.1 | PASS | `reconcile_attempt_for_job` is exactly as 0083 left it: md5 `721e487901b2272708e38565b7070c53`, the reserved procedure's `post_def`, which that procedure verified at the apply. |
| P3.2 | PASS | Only `service_role` may execute it. |
| P3.3 | PASS | `approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)` is exactly as 0069 left it: md5 `710dfb5cb84ce09a94040ebb84086025`. That was recomputed on 2026-11-17 on a disposable stack at the recorded production position (every migration up to S1). Pilot step 1 (D-052) redefines it. |
| P3.4 | PASS | Its five-argument version does not exist yet. |
| P3.5 | PASS | `persist_probe_result_for_job(uuid, uuid, uuid, jsonb)` is exactly as 0054 left it: md5 `d812b7f4c606e03ea171113f9fbc9762`. It was computed on 2026-11-17 on a disposable `supabase/postgres:17.6.1.167` at the recorded production state (every migration through S1 applied as `postgres`, 85 ledger rows), and has **never been observed on production**. ChatGPT phase B (`20261109180000`, D-061) redefines it. |
| P4.1 | PASS | None of the 24 pending tables exists: pilot step 1, pilot questions, pilot report, pilot actions, the pilot retest, P1, P2, E1 and Q4. The 24 include the four of `20261109190000` (D-062): `pilot_retests`, `pilot_retest_members`, `pilot_retest_notes` and `pilot_retest_steps`; there were 20 before. |
| P4.2 | PASS | None of their 54 new public functions exists, nor any `_p1_`, `_p2_`, `_e1_` or `_q4_` helper. The 54 include the three of `20261109180000` (D-061): `pilot_question_protocols_consistency`, `add_pilot_question_engine` and `protocol_worker_capabilities` (38 → 41); and the 13 of `20261109190000` (D-062): `pilot_retest_job_is_final`, `register_pilot_retest`, `confirm_pilot_retest_implementation`, `prepare_pilot_retests`, `abandon_pilot_retest`, `requeue_pilot_retest_job`, `add_pilot_retest_note`, `pilot_retests_guard`, `pilot_retest_rows_append_only`, `pilot_retest_slot_check`, `pilot_retest_intervention_guard`, `pilot_retest_protocol_guard` and `pilot_retest_card_guard` (41 → 54). A function they redefine that already exists is checked by its pinned pre-state instead (P3.3, P3.5). |
| P4.3 | PASS | `projects`, `buyer_question_versions`, `snapshot_requests`, `protocol_execution_jobs` and `protocol_attempts`, which the pilot migrations reference, exist. |
| P4.4 | PASS | All 25 applied tables exist: Q2′-1's 15, Q2′-2's 8 and S1's 2. |
| P4.5 | PASS | All 12 applied public functions exist: Q2′-1's 6 and S1's 6. |
| P4.6 | PASS | All 40 `_q2p_`, `_q2p2_` and `_s1_` helpers exist: 19, 16 and 5, the distinct helpers the three applied migrations define. There are no overloads. |
| P5.1 | PASS | `anon`, `authenticated` and `service_role` exist. |
| P5.2 | PASS | `service_role` has BYPASSRLS. |
| P6.1 | PASS | No protocol job is `claimed` or `running`. |
| P6.2 | info | Other sessions with a transaction open over 60 seconds. |
| P6.3 | PASS | No protocol job is `queued`. Until step 5a applies `20261109170000`, the deployed pre-D-052 worker would take any queued job through the global claim on any start, and the worker redeploy needs an empty queue (WORKER_DEPLOY_RUNBOOK §6). If a job is queued, for example the self-test retest, stop and let the founder decide whether to run it on the old worker or cancel it before going on. **Kept as it is for this baseline (D-060):** step 1 runs before that migration. After it, a queued job without a pending run request is inert; once the founder confirms D-060 item 5 *(engineer)*, the runbook's rule becomes "no job holds a live lease and no run request is pending", and a preflight re-baselined after the migration would check that instead. |
| P6.4 | info | The number of protocol attempts `reserved` or `in_progress`. **Informational at step 1 since 2026-11-18** (it was must-pass): production holds one such attempt from 23 September, under a job abandoned that day, which concerns only `20261109180000`. Step 5b's own before-check requires it to be 0, and that migration's precondition refuses to apply otherwise. P6.1 and P6.3 do not see an attempt left open under a job held for review. |
| P7.1 | PASS | Every protocol names a provider `20261109180000` accepts: `perplexity`, `perplexity_sonar`, `perplexity_agent` or `openai_chatgpt` (its precondition's list; PF-29a ties them). |
| P7.2 | PASS | Every probe run of a protocol attempt is `perplexity`, so existing results keep their replay hashes when `20261109180000` takes the platform from the run. |

**Validated locally on 2026-11-17.** The check ran against a disposable `supabase/postgres:17.6.1.167` built to the recorded production state: every migration through S1 in filename order, and the ledger rows written as production holds them (80 + alias + 0083 + 3 = 85).

- Every must-pass check passed.
- P3.1 computed `721e4879…`, the reserved procedure's `post_def`. P3.3 computed `710dfb5c…`, the existing pin.
- After pilot step 1 was applied to the same database and recorded, P2.3, P2.4, P2.5, P3.3, P3.4, P4.1 and P4.2 failed, as they should.
- **Not exercised in that first run:** a queued job making P6.3 fail.

**Re-validated on 2026-11-17 after the review of PR #129**, on a fresh disposable database built to the same state:

| Case | Result |
|---|---|
| The right `expected_sysid` | every check PASS; last line `PREFLIGHT: PASS`; exit 0 |
| No `expected_sysid` | P1.1 FAIL; `PREFLIGHT: FAIL (1)`; exit 3 |
| A wrong `expected_sysid` | P1.1 FAIL; `PREFLIGHT: FAIL (1)`; exit 3 |
| One queued job (inserted only in that copy) | P6.3 FAIL; `PREFLIGHT: FAIL (1)`; exit 3 |
| The queued job removed | `PREFLIGHT: PASS`; exit 0 |
| A role without BYPASSRLS reading `protocol_execution_jobs` with `row_security = off` | error, not 0 rows |

**If P3.3 fails:** its pin `710dfb5c…` was computed on disposable databases and has never been observed on production. The first version of this check, which ran on production on 2026-11-09, did not include it. Stop. Compare the observed hash against a disposable copy built to the recorded state before anything else.

**If P3.5 fails** (D-061): the same. Its pin `d812b7f4…` was computed on a disposable database and has never been observed on production. Stop, and compare against a disposable copy built to the recorded state. A mismatch means production's `persist_probe_result_for_job` is not 0054's, which plan step 5b expects to replace.

The run is in the D-058 pull request's notes, and `npm run test:prod-preflight` enforces the structure: the applied set is a prefix of the migrations on disk, every pending object is checked absent, every applied object is checked present, and the pins are as stated.

## Decision

- **Every must-pass check is PASS:** the founder may be asked to authorise the next apply (pilot step 1, `20261109130000`, `expected_prev=20261109120000`).
- **Any FAIL, or P1.2 shows `NO ACCESS`:** stop. Apply nothing, and record what was observed. A failing preflight is not worked around.

Record the date, the commit and the full output **privately**. CURRENT_STATUS records only the result and the date, not the system identifier.

## The apply sequence afterwards

This is for reference only. **Each step needs its own founder authorisation**, run in this order, never with `supabase db push` or `supabase migration repair` (D-041). Every apply runs in one transaction with its ledger row, so a failure leaves nothing behind. The full plan, including the worker and web steps, is [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md).

The procedure is the D-041 named-file text. The repository holds its rehearsal copy, [`scripts/sql/sv1-apply-named-migration.sql`](../scripts/sql/sv1-apply-named-migration.sql), whose header says *never run against a remote database*. The production copy is the body below that header, unchanged, and must match the body sha256 the header records. Preparing that copy is part of each step's authorisation.

- **2026-11-17 (D-058 item 5):** the body changed. Its sha256 is now `db6feffff039c324bef2a8894deb3e2c3236f5c0e8bbca7cd4ecc204b8972cca`; Q2′-1, Q2′-2 and S1 used the earlier body, `8a430331…`.
  - It now refuses a `new_version` that is not strictly later than `expected_prev`, and both must be 14 digits. The earlier body checked only the tail, which let a disposable database record `20261109125000` after `20261109160000`.
  - With `-v target_sysid=<value>`, it refuses any database whose system identifier differs. Every production apply passes it.
- **Proved on a disposable database** at the recorded state:
  - The four pilot migrations applied in order. The first ran without `target_sysid`, the other three with the right one.
  - `20261109125000` after `20261109160000` was refused (exit 3).
  - A wrong `target_sysid` was refused (exit 3).
  - Each refusal left the ledger unchanged.
- **Until P1 to Q4 are applied,** every production migration is numbered strictly between `20261109160000` and `20261110120000`, or waits (D-058 item 4).

**Done** (CURRENT_STATUS §25): 0083 (reserved version), then Q2′-1, Q2′-2 and S1 (named file).

**Next** (D-058, approved by the founder on 2026-11-17; each apply still needs its own authorisation):

| Step | Procedure | Arguments |
|---|---|---|
| 1. Pilot step 1 | named file | `new_version=20261109130000`, `new_name=pilot_step1_operator_controls`, `expected_prev=20261109120000` |
| 2. Pilot questions | named file | `new_version=20261109140000`, `new_name=pilot_questions`, `expected_prev=20261109130000` |
| 3. Pilot report | named file | `new_version=20261109150000`, `new_name=pilot_report_artifacts`, `expected_prev=20261109140000` |
| 4. Pilot actions | named file | `new_version=20261109160000`, `new_name=pilot_actions`, `expected_prev=20261109150000` |
| 4a. Pilot links and claim scope (D-060) | named file | `new_version=20261109170000`, `new_name=pilot_links_and_claim_scope`, `expected_prev=20261109160000` |
| 4b. ChatGPT measurement (D-061) | named file | `new_version=20261109180000`, `new_name=chatgpt_measurement`, `expected_prev=20261109170000` |
| 4c. Pilot retest (D-062) | named file | `new_version=20261109190000`, `new_name=pilot_retest`, `expected_prev=20261109180000` |

The plan numbers these steps 2–5, 5a, 5b and 5c ([`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md)); steps 2 to 5a (rows 1 to 4a) were applied on 2026-11-18. Before 4b, a read-only count of protocol attempts that are `reserved` or `in_progress` must be 0, because that migration's precondition refuses otherwise (plan step 5b gives the query).

P1, P2, E1 and Q4 follow later, behind the D-045 gates. P1's `expected_prev` is the ledger tail at the time P1 is applied: `20261109170000`, or a later migration in the pilot window if one is applied first (D-058 item 2, dated note). It is no longer `20261109160000`.
- **2026-11-18 (D-061):** with 4b applied, P1's `expected_prev` is `20261109180000`, or the tail if a later migration in the window, such as the pilot retest's `20261109190000`, is applied first.
- **2026-11-18 (D-062):** with 4c applied, it is `20261109190000`.

- **Why this position.** The four pilot migrations depend on nothing in P1 to Q4, and P1 to Q4 define no function the pilot migrations define. Both stacks reference only earlier tables, through foreign keys. On 2026-11-17 the full schema dump (privileges and comments included) was identical with the pilot migrations in the old order (after Q4) and the new order (after S1): 26,440 lines.
- **What each migration redefines:**
  - Pilot step 1 redefines `approve_and_launch_snapshot_baseline` (pinned by P3.3).
  - Pilot questions redefines step 1's `request_protocol_job_run`, `claim_requested_protocol_execution_job` and `retry_failed_protocol_job`.
  - Pilot actions redefines the report's `save_pilot_report_artifact` and `share_pilot_report_artifact`.
  - The pilot links and claim scope (D-060) redefines the report's `read_shared_pilot_report`, and revokes `claim_protocol_execution_job` and `claim_protocol_execution_job_by_id` from `service_role`. A revoke redefines nothing, so no md5 pin applies to those two.
  - The ChatGPT measurement (D-061) redefines two functions:
    - `persist_probe_result_for_job`, which production already has (0054), so P3.5 pins it;
    - the questions migration's `retire_pilot_question`, which is unapplied and in the absence list.

    It creates `pilot_question_protocols_consistency`, `add_pilot_question_engine` and `protocol_worker_capabilities`, now in the absence list (P4.2: 41), and no table. Its CHECK, index and trigger changes are not checked by the preflight; the migration's own preconditions check them at the apply.
  - The pilot retest (D-062) redefines the actions migration's `save_pilot_report_artifact` and `share_pilot_report_artifact`, which are unapplied at this baseline and in the absence list; its own precondition pins their source (`md5(replace(prosrc, chr(13), ''))`, carriage returns removed as in PF-30) to the actions migration's at the apply. It creates four tables and 13 functions, now in the absence lists (P4.1: 24, P4.2: 54), and eight triggers, three of them on existing production tables (`interventions`, `protocols`, `outcome_card_artifacts`). Its triggers and its change to the pilot slot table are not checked by the preflight; the migration's own preconditions and postconditions check them.

  All of these are unapplied, so they are checked by absence, apart from the pinned P3.3 and P3.5. `read_shared_pilot_report` was already in the absence list (P4.2); D-060 added only its version to P2.4.

**This preflight is valid only before step 1.** Once pilot step 1 is applied it fails by design, so do not re-run it as a post-check. After each step, confirm that the ledger tail, the row count and that step's objects are as expected (PILOT_PRODUCTION_PLAN.md lists the checks).

## Recovery

- **A failed apply** rolls back entirely: the migration and its ledger row together.
- **Undoing a completed step** is a forward migration, separately authorised, using each migration's header recovery notes, in the reverse order (pilot retest, ChatGPT measurement, links and claim scope, actions, report, questions, step 1). The web app is rolled back first. The ChatGPT measurement can be undone that way only while no ChatGPT row exists; after that its recovery is forward only (D-061). The pilot retest can be undone that way only while no `pilot_retests` row exists (D-062).

## What it does not show

- That the application, the worker or the Supabase Auth settings are ready.
- What the deployed worker image is, or what its secrets and switches are set to (PILOT_PRODUCTION_PLAN.md, *Check read-only first*).
- That a data row is correct. It reads catalog metadata, the ledger and counts of jobs, attempts, probe runs, protocols and sessions.

## History

- **2026-11-18, first production run of this baseline** (at `main` `2ae02e1`, in the Supabase SQL editor version, run by the founder; the founder accepted that run's identifier reading as the record, option 2): `PREFLIGHT: FAIL (2)`. P1.1 PASS; every check PASS except two:
  - **P3.3** observed `57322a0b…`. A read-only comparison showed the same code as 0069's file: the body without whitespace and the definition without whitespace both equal the disposable copy's (`d195cffb…`, `48d5039f…`), with the same attributes; production's body carries Windows line endings (5,853 bytes against 5,668), from the 2026-09-16 SQL-editor apply. Since then P3.1, P3.3 and P3.5 hash each definition with carriage returns removed (PF-30); the pins are unchanged. Proven on a disposable copy: the same code with Windows line endings fails the old check and passes the new one, and a real code change still fails.
  - **P6.4** observed 1: a `retest` attempt `in_progress` since 2026-09-23 under a job `abandoned_exhausted` the same day (Perplexity Sonar, 0.04 USD reserved). It concerns only step 5b; P6.4 is now informational at step 1. Closing that attempt is its own founder-approved step before step 5b.
- **2026-11-18, second production run** (at `main` `e2acca3`, after #132): `PREFLIGHT: PASS`. Steps 2 to 5a were then applied (PILOT_PRODUCTION_PLAN.md; CURRENT_STATUS §38, dated note), after which this check fails on production by design.

- **2026-11-09:** first version, baseline 0001–0081 with tail `20260924023646` and 81 rows; it pinned 0083's pre-state, `baaf43cc…`. It ran against production at 17:12 PST at `main` `60720a2`: all 15 must-pass checks PASS (CURRENT_STATUS §25). It then failed by design once 0083 was applied.
- **2026-11-17:** re-baselined to the post-S1 state, with P2.6, P4.4, P4.5, P4.6 and P6.3 added, and the pilot migrations renumbered under D-058.
- **2026-11-17 (D-060):** `20261109170000` added to both P2.4 lists; nothing else changed. Re-validated on a fresh disposable `supabase/postgres:17.6.1.167` built to the recorded state (every migration through S1 applied as `postgres`, 85 ledger rows), with `-v expected_sysid` set to that cluster's own identifier: every must-pass check PASS, `PREFLIGHT: PASS`, exit 0. On the same database `20261109170000` applied out of order (tail S1) was refused by its own precondition (exit 3, ledger unchanged); the four pilot migrations and then `20261109170000` applied in order through the named-file procedure with `target_sysid` (exit 0 each; 90 rows, tail `20261109170000`); the preflight then failed by design: P2.3, P2.4 (listing `20261109170000` too), P2.5, P3.3, P3.4, P4.1 and P4.2, `PREFLIGHT: FAIL (7)`, exit 3. This edited version has not run against production; if R includes D-060, run it from R before step 2 (PILOT_PRODUCTION_PLAN.md, the R rule).
- **2026-11-17 to 18 (D-061):** `20261109180000` added to both P2.4 lists. `pilot_question_protocols_consistency`, `add_pilot_question_engine` and `protocol_worker_capabilities` were added to the pending functions (P4.2: 38 → 41). P3.5 was added, with its contract check PF-22b.
  - **Validated** on the phase B branch before D-060's branch was merged into it, on a fresh disposable `supabase/postgres:17.6.1.167` built to the recorded state (every migration through S1 applied as `postgres`, 85 ledger rows), with `-v expected_sysid` set to that cluster's own identifier. P3.5 computed `d812b7f4c606e03ea171113f9fbc9762` there, and every must-pass check passed: `PREFLIGHT: PASS`, exit 0.
  - **On the same database:**
    - `20261109180000` applied out of order (tail S1) was refused (exit 3, ledger unchanged);
    - the four pilot migrations and then `20261109180000` applied in order through the named-file procedure with `target_sysid`, exit 0 each, 90 rows. `expected_prev` was `20261109160000` there, because D-060's file was not yet in that tree;
    - the preflight then failed by design: P2.3, P2.4, P2.5, P3.3, P3.4, P3.5, P4.1 and P4.2, `PREFLIGHT: FAIL (8)`, exit 3.
  - **Not run on a disposable database: the merged file,** which lists both `20261109170000` and `20261109180000`. The merge only added D-060's version to the two lists, each branch's edit was validated on its own, and `npm run test:prod-preflight` passes on it (72/72).
  - This edited version has not run against production. If R includes D-061, run it from R before step 2 (PILOT_PRODUCTION_PLAN.md, the R rule).
- **2026-11-18 (review of D-061):** P6.4, P7.1 and P7.2 added, must-pass, mirroring `20261109180000`'s data preconditions (PF-29 to PF-29c). On a fresh disposable `supabase/postgres:17.6.1.167` at the recorded state (85 rows, own sysid): `PREFLIGHT: PASS`, exit 0. Negative controls, one at a time, on rows inserted only in that copy: a job held for review with its attempt in progress → P6.4 FAIL only, `FAIL (1)`, exit 3; a draft `gemini` protocol → P7.1 only; a failed job whose run was on `chatgpt` → P7.2 only. After all applies the preflight fails by design with the same eight checks as before.
- **2026-11-18 (D-062):** `20261109190000` added to both P2.4 lists; `pilot_retests`, `pilot_retest_members`, `pilot_retest_notes` and `pilot_retest_steps` added to the pending tables (P4.1: 20 → 24) and the migration's 13 functions to the pending functions (P4.2: 41 → 54). No pin: the two functions it redefines are pilot functions, absent at this baseline.
  - **Validated** on a fresh disposable `supabase/postgres:17.6.1.167` built to the recorded state (main's migrations through S1, byte-identical to the branch's; applied as `postgres`; 85 ledger rows), with `-v expected_sysid` set to that cluster's own identifier: every must-pass check PASS, `PREFLIGHT: PASS`, exit 0. Negative controls: one of the four tables created → P4.1 only, `FAIL (1)`, exit 3; one of the 13 functions created → P4.2 only, `FAIL (1)`, exit 3; both removed → `PREFLIGHT: PASS`.
  - **On the same database:** `20261109190000` with the tail at S1 was refused by the named-file guard (exit 3, ledger unchanged); `20261109130000` to `20261109170000` applied in order (90 rows); `20261109190000` was refused again there, by the guard and, with `expected_prev` set to the real tail, by its own precondition (`20261109180000` not applied); `20261109180000` then `20261109190000` applied (91, then 92 rows). The preflight then failed by design: P2.3, P2.4, P2.5, P3.3, P3.4, P3.5, P4.1 and P4.2, `PREFLIGHT: FAIL (8)`, exit 3.
  - It has not run against production, and cannot pass there now.
