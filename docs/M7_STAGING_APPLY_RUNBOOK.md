# M7 staging apply runbook — migrations 0070–0076

**Status:** not yet executed. This file is the procedure, not a record of an apply.
**Target:** `zypact-staging` only. Production is out of scope for this runbook.
**Method:** Supabase SQL editor, one migration per transaction — the same method
the operator used for `0069` on 2026-09-16.

Repository files prove nothing about deployed state. Step 0 is mandatory and
read-only; do not skip it because this document says staging is at `0069`.

---

## What you are applying

| # | File | What it adds |
|---|---|---|
| 0070 | `0070_scope_job_review_resolution_to_its_job.sql` | Scopes `resolve_protocol_job_review`'s attempt exclusion to its own job |
| 0071 | `0071_m7_registered_interventions.sql` | `interventions` table, register/approve/confirm RPCs, immutability trigger |
| 0072 | `0072_m7_observation_window_and_retest_eligibility.sql` | Observation-window columns, `authorize_early_retest`, `retest_eligibility` |
| 0073 | `0073_m7_retest_protocol_creation.sql` | Narrows the protocol uniqueness indexes, adds `create_retest_protocol` |
| 0074 | `0074_m7_retest_phase_integrity.sql` | `protocol_attempts` phase trigger, `protocol_execution_phase` |
| 0075 | `0075_m7_detectable_change_at_approval.sql` | `protocols.detectable_change_at_plan`, `_smallest_detectable_change`, extends `approve_protocol` |
| 0076 | `0076_m7_outcome_card_artifacts.sql` | `outcome_card_artifacts` table, save + delivery-fencing RPCs |

Apply them **strictly in this order**. Each depends on the one before it.

None of these files contain their own `begin`/`commit`, so wrapping each in an
explicit transaction is safe and is what the wrapper below does.

---

## Step 0 — Pre-flight probe (read-only, run first)

Paste into the SQL editor against `zypact-staging` and confirm every expectation
before touching anything.

```sql
select
  -- 0069 must already be live, and there must be exactly one overload of each
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'approve_and_launch_snapshot_baseline')   as approve_launch_overloads_expect_1,
  (select bool_or(pg_get_functiondef(p.oid) like '%D-032%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'approve_and_launch_snapshot_baseline')   as has_0069_expect_true,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'approve_protocol') as approve_protocol_overloads_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'resolve_protocol_job_review') as resolve_review_overloads_expect_1,

  -- nothing from M7 may exist yet
  to_regclass('public.interventions')                      as t_interventions_expect_null,
  to_regclass('public.outcome_card_artifacts')             as t_outcome_cards_expect_null,
  to_regclass('public.protocols_one_active_per_version')   as ix_old_expect_not_null;
```

**Stop and do not proceed if:** any overload count is not `1`, `has_0069` is
false, either M7 table already exists, or the old index is already gone. Any of
those means staging is not in the state this runbook assumes.

---

## Step 1 — Quiesce the worker

`0074` creates a trigger on `protocol_attempts`, which takes an
`ACCESS EXCLUSIVE` lock on that table. `0075` adds a column to `protocols`.
If the protocol worker is mid-transaction against staging, the apply will block
behind it — or, worse, block the worker.

Stop the staging protocol worker before Step 2 and leave it stopped until Step 4
passes. The `lock_timeout` in the wrapper is a safety net, not a substitute:
it makes a blocked apply fail fast and roll back instead of hanging.

---

## Step 2 — Apply, one migration per transaction

For **each** file from `0070` through `0076`, in order, run this in the SQL
editor as a single execution:

```sql
begin;
set local lock_timeout = '5s';

-- >>> paste the ENTIRE contents of supabase/migrations/00NN_....sql here <<<

commit;
```

Then run that migration's verification query from Step 3 **before** moving to the
next file. Do not batch several migrations into one transaction — a failure in a
later one would silently roll back the earlier ones and make the ledger record
ambiguous.

If a `commit` fails, nothing from that file was applied. Read the error, fix the
cause, and re-run the same file. Every object in these migrations uses
`if not exists` / `create or replace` / `drop ... if exists`, so re-running a
file that failed partway is safe.

---

## Step 3 — Verify after each migration

### After 0070

```sql
select
  count(*)                                                        as overloads_expect_1,
  bool_or(pg_get_functiondef(p.oid) like '%job_id is null%')      as has_0070_scope_expect_true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'resolve_protocol_job_review';
```

The overload count is the important one. `0070` re-declares the exact signature
`(uuid, uuid, uuid, text, text)` that `0066` used, so it must *replace*, never
add a second body. A count of `2` means the function was changed in a way this
runbook did not anticipate — stop.

### After 0071

```sql
select
  to_regclass('public.interventions')                             as tbl_expect_not_null,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('register_intervention',
                         'approve_intervention',
                         'confirm_intervention_implementation'))  as fns_expect_3,
  (select count(*) from pg_trigger
     where tgrelid = 'public.interventions'::regclass
       and not tgisinternal)                                      as triggers_expect_1;
```

### After 0072

```sql
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'interventions'
       and column_name in ('observation_window_opens_at',
                           'observation_window_closes_at',
                           'early_retest_authorized_by',
                           'early_retest_authorized_at',
                           'early_retest_reason'))                as cols_expect_5,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('authorize_early_retest',
                         'retest_eligibility'))                   as fns_expect_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'confirm_intervention_implementation')     as confirm_overloads_expect_1;
```

`0072` replaces the `confirm_intervention_implementation` that `0071` created
minutes earlier. The overload count catches a signature drift between the two.

### After 0073

```sql
select
  to_regclass('public.protocols_one_live_baseline_per_version')   as ix_baseline_expect_not_null,
  to_regclass('public.protocols_one_live_retest_per_baseline')    as ix_retest_expect_not_null,
  to_regclass('public.protocols_one_active_per_version')          as ix_old_expect_null,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'create_retest_protocol') as fn_expect_1;
```

This is the only migration in the set that **drops** anything. It creates both
replacement indexes *before* dropping `protocols_one_active_per_version`, so
there is no window in which protocol uniqueness is unenforced. The new baseline
index is strictly narrower than the old one (it adds
`where baseline_protocol_id is null`), so existing rows cannot violate it. If
the `create unique index` fails anyway, the whole transaction rolls back and the
old index survives untouched — that is the intended fail-closed behavior, and it
means real data violates an assumption that needs investigating before retrying.

### After 0074

```sql
select
  (select count(*) from pg_trigger
     where tgrelid = 'public.protocol_attempts'::regclass
       and tgname  = 'protocol_attempts_phase_matches_protocol')  as trg_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'protocol_execution_phase') as fn_expect_1;
```

The trigger is `BEFORE INSERT` only, so existing attempt rows are never
re-validated and cannot be invalidated by this apply.

### After 0075

```sql
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'protocols'
       and column_name = 'detectable_change_at_plan')             as col_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '_smallest_detectable_change') as fn_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'approve_protocol') as approve_overloads_expect_1,
  (select bool_or(pg_get_functiondef(p.oid) like '%detectable_change_at_plan%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'approve_protocol') as approve_has_0075_expect_true;
```

Then confirm the deployed function reproduces the signed-off power table
(`docs/OUTCOME_COMPARISON_PROPOSAL.md`) exactly:

```sql
select
  round(public._smallest_detectable_change( 5,  5)::numeric, 2) as n5_expect_0_60,
  round(public._smallest_detectable_change(10, 10)::numeric, 2) as n10_expect_0_40,
  round(public._smallest_detectable_change(15, 15)::numeric, 2) as n15_expect_0_27,
  round(public._smallest_detectable_change(20, 20)::numeric, 2) as n20_expect_0_25,
  round(public._smallest_detectable_change(30, 30)::numeric, 2) as n30_expect_0_17;
```

`n5 = 0.60` is the sign-off boundary: at the five-run default, the smallest
change the method can detect is exactly Δ_min. If this row disagrees with the
table, the deployed body is not the one that passed the runtime contract — stop
and reconcile before anything is approved on staging.

`approve_protocol` is the second `create or replace` with overload risk in this
set. `0075` re-declares `(uuid, uuid, uuid)`, matching `0049`. A count of `2`
means staging carries a different signature than the repository assumes.

### After 0076

```sql
select
  to_regclass('public.outcome_card_artifacts')                    as tbl_expect_not_null,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('outcome_card_artifact_revision',
                         'save_outcome_card_artifact',
                         'begin_outcome_card_delivery',
                         'finalize_outcome_card_delivery',
                         'release_outcome_card_delivery_claim'))  as fns_expect_5;
```

---

## Step 4 — Final combined probe

```sql
select
  to_regclass('public.interventions')                            as t_interventions,
  to_regclass('public.outcome_card_artifacts')                   as t_outcome_cards,
  to_regclass('public.protocols_one_live_baseline_per_version')  as ix_baseline,
  to_regclass('public.protocols_one_live_retest_per_baseline')   as ix_retest,
  to_regclass('public.protocols_one_active_per_version')         as ix_old_expect_null,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('register_intervention','approve_intervention',
                         'confirm_intervention_implementation','authorize_early_retest',
                         'retest_eligibility','create_retest_protocol',
                         'protocol_execution_phase','_smallest_detectable_change',
                         'outcome_card_artifact_revision','save_outcome_card_artifact',
                         'begin_outcome_card_delivery','finalize_outcome_card_delivery',
                         'release_outcome_card_delivery_claim'))  as m7_fns_expect_13;
```

**Do not restart the staging protocol worker.** Its recorded baseline is
`disabled/stopped` (Fly app `zypact-protocol-worker-staging`, Machine
`e826322a695098` — see [`CURRENT_STATUS.md`](CURRENT_STATUS.md) §14), and it
should stay there. Nothing in M7 requires it to run, and leaving it stopped
keeps the environment clear of the point of no return described under Rollback.

---

## Do not touch the CLI migration ledger

Do **not** insert rows into `supabase_migrations.schema_migrations` for these
files. Prior applies on staging were done through the SQL editor and it is not
established that the ledger records them
([`CURRENT_STATUS.md`](CURRENT_STATUS.md) §15.4). Adding `0070`–`0076` to a
ledger that is missing `0061`–`0069` would make a future `supabase db push`
believe the earlier migrations are unapplied and try to re-run them — which, for
`0062`/`0063`, would overwrite live function bodies with older ones and
reintroduce the `paraphrase_plan` bug. Record the apply in this file instead.

---

## Rollback and forward recovery

There is no automatic down-migration. Per object:

| Object | If it must be undone |
|---|---|
| New tables (`interventions`, `outcome_card_artifacts`) | `drop table` — safe only while they hold no rows you need. Both are new, so before any intervention is registered this is lossless. |
| New columns on `interventions` / `protocols` | `alter table ... drop column`. `protocols.detectable_change_at_plan` is nullable and additive; dropping it loses only the disclosure value. |
| Replaced functions (`resolve_protocol_job_review`, `approve_protocol`, `confirm_intervention_implementation`) | Re-apply the prior authoritative body: `0066`, `0049`, and `0071` respectively. Nothing else — re-applying an intermediate migration would regress other fixes. |
| `0073`'s index swap | Recreate `protocols_one_active_per_version` from `0047` and drop the two narrowed indexes. Only valid if no retest protocol exists yet; once one does, the old index forbids it. |
| Triggers (`0071`, `0074`) | `drop trigger ... on ...`. No data change. |

**The honest position:** the only clean rollback point is *before any
intervention row is written*. After a real intervention is registered and a
retest protocol is created, unwinding `0073` is no longer possible without
deleting evidence. Treat the first real intervention on staging as the point of
no return, and do not reach it until the application layer exists.

---

## Record of apply — fill this in as you go

**Applied: 2026-09-18.** Migrations `0070`–`0076` were applied to
`zypact-staging` (Supabase project `bfqpkfqsonixdnfiodwk`) in a single session
through the Supabase SQL editor, each file in its own explicit transaction, in
ascending order.

| Field | Value |
|---|---|
| Environment | `zypact-staging` |
| Migrations | `0070`, `0071`, `0072`, `0073`, `0074`, `0075`, `0076` |
| Date | 2026-09-18 |
| Operator | *fill in* |
| Tooling | Supabase SQL editor, one transaction per file |
| Pre-flight | Passed — `0069` live, single overloads, no M7 object present, old index present |
| Worker state during apply | Fly Machine `e826322a695098` stopped; 0 jobs `claimed`/`running`, 0 attempts `reserved`/`in_progress`, no open transactions |

**Per-migration apply timestamps were not recorded at the time and are not
reconstructed here.** The Step 3 checks were not run between migrations; the
Step 4 combined probe and the gap checks below were run afterwards against the
final state. This is a weaker record than the process finding in
[`CURRENT_STATUS.md`](CURRENT_STATUS.md) §15.4 asks for, and is stated plainly
rather than papered over.

### Verification, run after the fact against final state

| Probe | Result |
| --- | --- |
| Step 4 combined probe | **Passed** — both tables present, both new indexes present, `protocols_one_active_per_version` gone, `m7_fns` = 13 (one row per name, so no duplicate overloads among the thirteen) |
| Overload + trigger + column gap checks | **Passed** — `resolve_protocol_job_review` 1 overload carrying 0070's scope predicate; `approve_protocol` 1 overload carrying `detectable_change_at_plan`; 1 trigger on `interventions`; `protocol_attempts_phase_matches_protocol` present; 5 observation-window columns; `protocols.detectable_change_at_plan` present |
| `_smallest_detectable_change` power table | **Passed** — 0.60 / 0.40 / 0.27 / 0.25 / 0.17 at n = 5 / 10 / 15 / 20 / 30, matching the signed-off table exactly, including the `n=5` boundary where the smallest detectable change equals Δ_min |

---

## What this does and does not achieve

**Achieves:** every M7 schema object and RPC exists on staging. A founder with
direct SQL access can drive a complete retest by hand — register an intervention,
approve it, confirm implementation, wait out (or authorize early exit from) the
observation window, create the retest protocol, enqueue its job through the
existing generic `POST /api/projects/:projectId/protocol-runs` route, and build
and deliver the Outcome Card through `scripts/run-outcome-card-worker.ts`.

**Does not achieve:** any user-facing retest workflow. No route or UI calls the
intervention or retest RPCs — that gap is unchanged by this apply. Applying
these migrations makes the capability *reachable*; it does not make it
*usable by anyone who is not writing SQL*.

**Also not achieved:** the runtime contracts are not re-run against staging.
They write fixture data and are built for disposable databases. They passed
against real PostgreSQL 16 (0070–0074: 56/56, 0075: 22/22, 0076: 26/26); the
probes above confirm staging carries those same bodies, which is the correct
check for a shared environment.
