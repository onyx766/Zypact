# Production preflight (read-only)

Referenced by D-041 and CURRENT_STATUS §20.6 and §24. Written 2026-11-09. **It has never been run against production.** Running it is a gate of its own: the founder authorises it, and it changes nothing.

## Purpose

Before any of the pending migrations are applied to production, confirm the production database is exactly in the state those procedures were rehearsed against. The pending migrations are 0083, then Q2′-1, then Q2′-2, then S1.

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
| P1.1 | info | The cluster's system identifier. The 0083 apply's `target_sysid` must equal it. |
| P1.2 | PASS | This role can read `pg_control_system()`. |
| P1.3 | PASS | PostgreSQL 15 or later. |
| P1.4 | info | The database name. |
| P2.1 | PASS | The ledger holds 0001 to 0080, each once. |
| P2.2 | PASS | The ledger holds the 0081 alias `20260924023646`. |
| P2.3 | PASS | The ledger tail is `20260924023646`. |
| P2.4 | PASS | None of 0081 to 0085, `20261102132000`, `20261103173000` or `20261109120000` is recorded. |
| P2.5 | PASS | Exactly 81 ledger rows: no version anyone added outside the procedures. |
| P3.1 | PASS | `reconcile_attempt_for_job` is exactly as 0050 left it (md5 `baaf43cc539611ec78fef9762c168a53`, the reserved procedure's pinned pre-state). |
| P3.2 | PASS | Only `service_role` may execute it. |
| P4.1 | PASS | None of the 25 Q2′-1, Q2′-2 or S1 tables exists. |
| P4.2 | PASS | None of their public functions or `_q2p_`, `_q2p2_` or `_s1_` helpers exists. |
| P4.3 | PASS | `projects`, `buyer_question_versions` and `snapshot_requests`, which Q2′ references, exist. |
| P5.1 | PASS | `anon`, `authenticated` and `service_role` exist. |
| P5.2 | PASS | `service_role` has BYPASSRLS. |
| P6.1 | PASS | No protocol job is `claimed` or `running`. |
| P6.2 | info | Other sessions with a transaction open over 60 seconds. |

**Validated locally on 2026-11-09** against a disposable PostgreSQL 16 built to production's recorded state: 0001 to 0081 applied, and the ledger as D-041 describes it.

- Every must-pass check passed, and P3.1's hash matched the reserved procedure's pin.
- After 0083 and Q2′-1 were applied to the same database, P2.4, P2.5, P3.1, P4.1 and P4.2 failed, as they should.

## Decision

- **Every must-pass check is PASS:** the founder may be asked to authorise the first apply (0083).
- **Any FAIL, or P1.2 shows `NO ACCESS`:** stop. Apply nothing, and record what was observed. A failing preflight is not worked around.

Record the date, the commit and the full output **privately**. CURRENT_STATUS records only the result and the date, not the system identifier.

## The apply sequence afterwards

This is for reference only. **Each step needs its own founder authorisation**, run in this order, never with `supabase db push` or `supabase migration repair` (D-041). Every apply runs in one transaction with its ledger row, so a failure leaves nothing behind.

The procedures are the D-041 texts. The repository holds their rehearsal copies, [`scripts/sql/sv1-apply-reserved-migration.sql`](../scripts/sql/sv1-apply-reserved-migration.sql) and [`scripts/sql/sv1-apply-named-migration.sql`](../scripts/sql/sv1-apply-named-migration.sql), whose headers say *never run against a remote database*. The production copy is the body below that header, unchanged, and must match the source sha256 the header records. Preparing that copy is part of each step's authorisation.

| Step | Procedure | Arguments |
|---|---|---|
| 1. 0083 | reserved version | `target_sysid=<P1.1>`, `version=0083`, `name=m5_estimated_cost_keeps_attempt_cap_basis`, `expected_tail=20260924023646` |
| 2. Q2′-1 | named file | `new_version=20261102132000`, `new_name=q2p1_account_workspace_foundation`, `expected_prev=20260924023646` |
| 3. Q2′-2 | named file | `new_version=20261103173000`, `new_name=q2p2_domains_and_site_diagnostics`, `expected_prev=20261102132000` |
| 4. S1 | named file | `new_version=20261109120000`, `new_name=s1_account_sessions`, `expected_prev=20261103173000` |

`expected_prev` stays `20260924023646` after 0083, because `0083` sorts below it.

**This preflight is valid only before step 1.** Once 0083 is applied it fails by design, so do not re-run it as a post-check. After each step, confirm that the ledger tail and that step's objects are as expected.

## Recovery

- **A failed apply** rolls back entirely: the migration and its ledger row together.
- **Undoing a completed step** is a forward migration, separately authorised:
  - Q2′-1, Q2′-2 and S1 create only new, empty tables and functions. Dropping them before any customer data exists loses nothing.
  - 0083 replaces one function. Its pre-state definition is pinned above.

## What it does not show

- That the application, the worker or the Supabase Auth settings are ready.
- That S1's account sessions bind to real Auth tokens on a non-production Supabase project (CURRENT_STATUS §20.6, gate 6).
- That a data row is correct. It reads catalog metadata, the ledger and three counts.
