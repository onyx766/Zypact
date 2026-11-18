# Spend Ledger Gate

- **Status:** Approved design baseline (D-037). Not implemented. Not applied to any database.
- **Scope:** the protocol-job execution path: claim, reservation, send and receipt of paid provider calls recorded in `protocol_external_calls`.
- **Owner:** Founder/CEO. Each implementation step below needs its own explicit authorisation.
- **Last updated:** 2026-10-29

This document is the reference for the remediation of PG-9 gaps G1, G3 and G4. It records what the database will guarantee, what it will not, and what must be true outside the database before paid execution is enabled. Production and paid execution remain on HOLD until every activation precondition in section 12 is met and separately authorised.

Nothing here has been run against PostgreSQL. Every behaviour below is a specification, and every test in section 14 is an acceptance criterion, not a result.

## 1. Why the current ceiling is not enough

`lib/worker-control/paid-execution-gate.ts` reads the last 24 hours of ledger spend and the largest claimable cap, then the worker claims a job. PG-9 run 40906150478 (12 assertions passed) reproduced three gaps:

| Gap | Cause |
|---|---|
| G1 | Two workers both pass one read and both claim. The check is outside the claim transaction. |
| G3 | The queue changes between the read and the claim, so the job claimed was never read. |
| G4 | The window is measured on the worker's clock, so a worker ahead of the database undercounts the edge. |

Review of the remediation found gaps that any claim-time check shares:

- **The per-protocol cap can be refilled.** `reconcile_attempt_for_job` can lower an attempt's counted cost to its measured actual, and an attempt can be reconciled as `cancelled` after its calls were sent (0083). Either frees cap that a claim-time check never counted, so "cap minus spent" is not a sound bound on future spend.
- **Reservation time is the wrong anchor.** A reservation created by an operator retry and claimed more than 24 hours later falls out of a `created_at` window while still unsent.
- **New tables are writable by default.** Supabase default privileges (0011) give `service_role` select, insert, update and delete on new public tables unless revoked.
- **NaN passes existing checks.** 0050's `reserved_cost_usd >= 0` and `actual_cost_usd >= 0` accept `NaN`, which PostgreSQL sorts above every number.

## 2. Design in one paragraph

Safety rests on the ledger, not the claim. Every insert into `protocol_external_calls` (a reservation) and every send marker (`request_sent_at` set) passes a gate. The gate serialises on one `spend_controls` row, reads exposure from one snapshot taken after the lock, uses the database clock at the moment of decision, and refuses if the ceiling would be exceeded. Claim admission stays, but only for liveness: it places a hold so admitted jobs are unlikely to be refused mid-run, and it caps live claims. Every refusal leaves no persisted change (section 13.1 defines this exactly and how it is tested).

## 3. What is counted

Each ledger row contributes a charge to the window total W at decision time d:

| Row state | Charge | Counted when |
|---|---|---|
| Not sent (`request_sent_at` null), open | max(reserved, actual) | always, at any age |
| Not sent, terminal | 0 | never: a terminal row cannot reopen, and no request leaves without a committed send marker |
| Sent, no cost recorded or still `in_progress` | max(reserved, actual) | while `request_sent_at` > d − 24 h − M |
| Sent, measured cost | actual | same window |
| Sent, estimated cost | max(actual, reserved) | same window |

M is a 5-minute margin covering the 60-second mark-to-wire deadline M_w plus clock tolerance. Holds H are the unused part of each live admission's hold. Reconcile, attempt status, leases and the per-protocol cap are not inputs to W, so a refilled cap cannot cause an undercount.

## 4. The gate

Seven triggers on `protocol_external_calls`, all `ENABLE ALWAYS` so they fire even under `session_replication_role = replica`:

| Trigger | Role |
|---|---|
| before insert, per statement | take the lock; refuse if disabled or latched |
| before insert, per row | shape only: the row must start `reserved`, unsent, with no cost and a valid reservation |
| after insert, per statement | the authoritative ceiling check |
| before update, per row | immutability, and the gated send transition |
| after update, per statement | at most one send transition per statement |
| before delete, per row | refuse |
| before truncate, per statement | refuse |

**Multi-row inserts.** The ceiling check runs after the statement, reads the statement's rows from its transition table, excludes those rows from the ledger scan by id and adds them back explicitly. The result does not depend on whether a row trigger can see rows processed earlier in the same statement. Two $0.60 reservations in one statement against a $1.00 ceiling are refused together.

**Time.** Every decision uses `clock_timestamp()` read after the lock, never `now()`. The send guard overwrites `request_sent_at` with that time, so a lock wait or long transaction cannot backdate a send.

**Immutability.** Once written, a ledger row's reservation, creation time, attempt, project, kind and generation never change; `request_sent_at` is set once; a recorded cost is set once; a terminal status never reopens; rows are never deleted.

## 5. Isolation

A REPEATABLE READ or SERIALIZABLE transaction keeps the snapshot taken at its first statement. `SELECT … FOR UPDATE` raises a serialisation error only if the other transaction updated the row, not if it merely locked it, so a stale snapshot could otherwise read an exposure that misses a committed reservation.

Two independent layers close this:

1. Every decision path, the claim included, refuses with `ZP008` unless `current_setting('transaction_isolation')` is `read committed`. A transaction cannot change its isolation after its first query, so the check is reliable.
2. Every gate decision (a reservation insert, a send marker, `enable_paid_execution`, `record_spend_call_review`, `disable_paid_execution`) takes the lock by updating `spend_controls.decision_seq`. Under READ COMMITTED it waits and proceeds; under REPEATABLE READ or SERIALIZABLE it fails with `40001` if any decision committed after the caller's snapshot. The claim instead takes the lock with `SELECT … FOR UPDATE` and never updates `spend_controls`: under READ COMMITTED that is sufficient, the claim's decision affects only liveness, and it keeps the claim's refusals free of writes (section 13.1).

**Lemma S.** Any decision that gets past the lock sees, in every later statement, every decision committed before the lock was granted. Writes that are not decisions (receipts, cancelling unsent rows, reconcile, leases, the sweep) can only make exposure look higher, except an overrun, which is counted in Ω and latches.

## 6. Safety statement

For a database-clock window (τ − 24 h, τ], let K be the calls whose wire send falls inside it, and let g\* be the latest gate decision covering any call in K, with ceiling C\*. Then

> billed cost of K ≤ C\* + Ω

where Ω is recorded overruns, estimate error, and unresolved costs. C\* is at most 50 USD.

This is not an absolute ceiling. It holds only if:

- every paid call writes the ledger, and the gate fires on every write (P1);
- a request is sent only after its send marker commits (P2);
- ledger rows are immutable as in section 4 (P3);
- gate decisions serialise on the lock (P4, with Lemma S);
- no paid path runs outside the ledger (P5, section 11);
- the worker sends within M_w of issuing the send marker;
- the database clock does not step back by more than M − M_w (A_clk).

## 7. Send concurrency and in-flight calls

A send is refused (`ZP006`) while `max_inflight_calls` (default 1) send markers inside the in-flight horizon have no recorded cost. Sends are serialised, so this is a ledger fact: at any moment, at most `max_inflight_calls` unresolved send markers exist inside the horizon.

How many requests the provider is actually still processing is a different question. That bound needs **A_R**: the provider finishes processing and billing a request within R_max of its wire send, including after the client aborts. A_R has not been verified for Perplexity. **No hard bound on in-flight provider requests is claimed until it is.** The horizon must be set to at least R_max + M_w + M.

A sent call with no recorded cost past the horizon latches all spending (`SPEND_COST_UNRESOLVED`) until reviewed, so a crashed worker or an aborted request cannot quietly widen the bound.

## 8. Latches and reviews

| Latch | Condition | Clears when |
|---|---|---|
| `SPEND_OVERRUN_UNREVIEWED` | any row with actual > reserved | an `overrun` review is recorded for each |
| `SPEND_COST_UNRESOLVED` | a sent row past the horizon with no cost | an `unresolved_cost` review is recorded for each |

A latch refuses every claim, reservation and send. Reviews are append-only rows in `spend_call_reviews`, recorded by `record_spend_call_review` (operator only), which refuses a review whose condition the row does not currently meet. A review never changes what is counted. Before recording one, the operator checks the provider's usage for that call; the note must not contain secrets, prompts or customer content.

## 9. Emergency disable

`disable_paid_execution` (granted to `service_role`, the safe direction) takes the lock, waiting for any send or gate in progress, then commits.

- **G1, enforced by the database:** after it commits, no claim, reservation or send marker can commit.
- **G2, not enforced by the database:** calls whose send marker committed earlier may still reach the provider, each within M_w (60 s) of its marker, if the worker honours its deadline. There are at most `max_inflight_calls` of them.
- **G3:** their cost was already counted when they were reserved. Disable stops growth; it does not cancel spend already authorised.
- **G4:** requests already at the provider may keep running. That is bounded only under A_R.
- **G5:** the only hard provider-side stop is revoking or rotating the provider key. Stopping the Fly machine or switching off the worker's flag does not recall a request in flight.

It returns `potentially_unsent_call_ids`: every call whose send marker committed within M_w before the decision and has no recorded cost. **This is a conservative set, not an observation of network state.** It can include calls already on the wire, answered but not yet receipted, or abandoned at the worker deadline. Receipts still succeed after disable, so evidence is preserved.

## 10. Pre-activation audit

`enable_paid_execution` (operator only, never `service_role`) refuses unless the gate is installed, the five legacy paths are revoked (section 11) and the audit below is clean. It re-runs the audit under the lock, so nothing can change between check and use. `spend_preactivation_audit` runs the same checks read-only beforehand.

| Check | Blocks | How it clears |
|---|---|---|
| PA1 claim live, or live within the horizon, with no admission row | yes | lifecycle only: wait out the lease and horizon, or terminalise through existing RPCs |
| PA2 unsent reservation from before the gate, unreviewed | yes | a `preactivation_unsent` review; the row stays counted |
| PA3 sent call with no cost, inside the horizon | yes | wait for the horizon or a receipt |
| PA4 sent call with no cost, past the horizon, unreviewed | yes | an `unresolved_cost` review |
| PA5 overrun, unreviewed | yes | an `overrun` review |
| PA6 ledger integrity anomaly | yes | a separately reviewed forward-fix migration |
| PA7 exposure already above the requested ceiling | yes | exposure falls, or a ceiling no higher than 50 USD is chosen |
| PA8 ledger row with no job | no | informational |

Rows that existed before the gate are never deleted or rewritten. They are counted by the same rule as every other row, and activation acts as the gate decision for them.

## 11. Paths outside the gate

The gate covers the protocol-job ledger only. Five database entry points are ceiling-blind or feed spend that never reaches the ledger, and 0085 revokes them from `public`, `anon`, `authenticated` and `service_role`:

- `claim_protocol_execution_job(text, integer)`
- `claim_protocol_execution_job_by_id(text, integer, uuid, uuid)`
- `admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid)`
- `start_attempt(uuid, uuid, uuid)`
- `reconcile_attempt(uuid, uuid, text, numeric, uuid, text)`

> **2026-11-17 (D-060):** the first two were revoked early. Migration `20261109170000_pilot_links_and_claim_scope.sql` revokes both claims from `service_role` and restates their revokes from `public`, `anon` and `authenticated`, without redefining or dropping either. Once it is applied, 0085's revoke of these two becomes a no-op; the other three are unchanged and still wait for 0085. `enable_paid_execution`'s check that the five legacy paths are revoked (section 10) is unaffected: it finds these two already revoked.
>
> Three suites call these two claims as `service_role`: PG-9 (`scripts/test-pg9-paid-gate-runtime.ts`: its fixture claims, its direct claims and its worker loop, which takes the global branch, all over PostgREST with the service-role key), `test:m5-a-stack-runtime` and `test:m5-0059-runtime`. Each is unaffected today only because its migration set ends before `20261109170000` (PG-9's allowlist is 0001–0081 and 0083, and it refuses every timestamped file). Before PG-9's allowlist is extended to timestamped migrations that reach `20261109170000` (the PR-B plan in section 14 extends it for a new run), its fixture claims, direct claims and worker loop must move to the requested claim (`claimScope: "requested"`) or to the owner path; otherwise its roster fails at the first claim with `42501`. The same holds for the other two if their sets are ever extended.

Paid calls made outside the ledger cannot be seen by any database control:

- `scripts/mvp-scan.ts` (raw M4 admission and a direct probe);
- `scripts/run-live-perplexity-probes.ts` and `scripts/run-adhoc-evidence-probe.ts`;
- the legacy web pipeline (`lib/agents/*`), currently gated by `legacyPipelineRefusal`.

PR-D makes the legacy routes refuse unconditionally in production and the three scripts refuse until they are retired, and adds a static check that fails the build on any provider call site outside the worker. Beyond that, only provider-side account limits and key custody (provider keys held only by the worker) bound these paths.

## 12. Migrations and activation

**0084** installs the gate, disabled. **0085** revokes the five legacy paths. Each file is one top-level `DO` statement with no `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`:

- The Supabase CLI v2.111.0 sends every statement of a file and the `schema_migrations` insert as one batch with a single Sync, which is one implicit transaction (`apps/cli-go/pkg/migration/file.go`, `MigrationFile.ExecBatch`).
- `psql` (the Level 2 CI job) autocommits per statement, and one statement is its own transaction.
- `LOCK TABLE` runs inside the `DO`, holding `protocol_external_calls` in `SHARE ROW EXCLUSIVE` mode until commit, so no ledger row can be written between `gate_installed_at` and the triggers existing.
- Each file ends with a self-verification block. Any failure rolls back everything, including the ledger row under the CLI.

**Migration 0082 remains on HOLD.** 0084 and 0085 refuse if the ledger records it. They are numbered after it without renumbering it; resolving 0082 later is a separate decision.

**Applying a migration**, each step separately authorised:

1. Use a clean, detached checkout of the exact approved `main` commit.
2. Confirm `supabase/migrations` holds exactly 0001–0081, 0083 and the target, and no 0082.
3. Read the remote ledger with `supabase migration list`: 0083 or 0084 latest as expected, no 0082.
4. `supabase db push --dry-run` must list exactly the target file. Never use `--include-all`.
5. Apply with Supabase CLI v2.111.0 (checksum-verified), then read the ledger again.

**Rollout:**

| Step | Action | Precondition |
|---|---|---|
| S0 | baseline | worker stopped; paid switch off |
| S1 | apply 0084 | the procedure above. From here every ledger insert and send fails closed until enabled. |
| S2 | deploy the PR-C worker image, kept stopped | independent comparison of the image's source digest against its claimed commit |
| S3 | apply 0085 | S2; no other worker image exists |
| S4 | checklist | PR-D deployed; provider keys only on the worker; provider-side limits set; **A_R verified independently** |
| S5 | `enable_paid_execution` | S3 and S4; a clean pre-activation audit |
| S6 | canary | separate Founder authorisation |

**Rollback:**

- **RB1:** disable first. It is always safe.
- **RB2:** any migration that drops or weakens a gate trigger, or re-grants a revoked legacy path, must refuse unless paid execution is disabled. Afterwards `enable_paid_execution` refuses and claims return `SPEND_GATE_MISSING`.
- **RB3:** an older worker image after 0085 cannot claim; the fix is forward only.
- **RB4:** 0084 may be dropped only before 0085 and only while disabled. Audit tables are kept.

Superuser actions and writes as `postgres` through the SQL editor are outside the guarantee and must be recorded in the runbook.

## 13. Outcomes and error codes

| Code or status | Meaning | Writes |
|---|---|---|
| `22023` | invalid arguments | none |
| `55P03` | lock timeout | none |
| `40001` | stale snapshot under REPEATABLE READ or SERIALIZABLE | none |
| `ZP001` `SPEND_CEILING_REACHED` | the gate refused a reservation | none: the RPC rolls back |
| `ZP002` `PAID_EXECUTION_DISABLED` | disabled | none |
| `ZP003` | a latch is set | none |
| `ZP004` | controls, gate or exposure missing, or a legacy path still executable | none |
| `ZP005` | a ledger or audit row would change illegally | none |
| `ZP006` | in-flight limit, or more than one send per statement | none |
| `ZP007` `PREACTIVATION_AUDIT_FAILED` | activation refused; detail lists codes and counts only | none |
| `ZP008` `SPEND_REQUIRES_READ_COMMITTED` | wrong isolation level | none |
| claim `SPEND_CEILING_REACHED`, `LIVE_CLAIM_LIMIT_REACHED`, `PAID_EXECUTION_DISABLED`, `SPEND_GATE_MISSING`, `SPEND_CONTROLS_MISSING`, latch reasons | a spending refusal | none |
| claim `NO_JOB_AVAILABLE` | not a refusal: nothing is eligible | none; the exhausted-job sweep is its own RPC |
| claim `CLAIMED` | admission | the job update and one `spend_admissions` row |

**Privileges.** Every new function starts with `revoke all` from `public`, `anon`, `authenticated` and `service_role`, is `SECURITY DEFINER` where it writes, and sets `search_path = pg_catalog, pg_temp`. `service_role` may execute four: the claim, the sweep, the exposure read and disable. New tables have row level security on, and `service_role` may only select from them. 0084 verifies all of this before it commits.

**Lock order:** job, then protocol, then call, then `spend_controls`. The claim holds `spend_controls` but never waits on a job row (`SKIP LOCKED`), so no wait cycle can form.

### 13.1 What "a refusal writes nothing" means

A refusal leaves no persisted change. After the refusing call ends, every row in the tables listed under the regression assertions below has the same contents, and the `spend_controls` row has the same `decision_seq` and the same `xmin`. Row locks taken on the way are not persisted changes; they end with the transaction. There are two kinds of refusal, and they reach that result differently.

**Status returns (the claim only).** `claim_protocol_execution_job_within_spend` returns `SPEND_CONTROLS_MISSING`, `PAID_EXECUTION_DISABLED`, `SPEND_GATE_MISSING`, a latch reason, `LIVE_CLAIM_LIMIT_REACHED` or `SPEND_CEILING_REACHED` as a normal result, and its transaction commits. It writes nothing because it issues no write before its last refusal branch:

- it takes the `spend_controls` lock with `SELECT … FOR UPDATE`, which changes neither the row nor its `xmin`;
- it never calls `_spend_lock_controls`, so `decision_seq` is untouched;
- it locks the candidate job with `SELECT … FOR UPDATE SKIP LOCKED`, which also changes nothing;
- its only writes, the job update and one `spend_admissions` row, come after every refusal branch, on `CLAIMED`.

`NO_JOB_AVAILABLE` is not a refusal, but it follows the same rule. The exhausted-job sweep is a separate RPC.

**Exceptions (every other refusal).** The gate triggers, the send guard, `enable_paid_execution` and `record_spend_call_review` take the lock through `_spend_lock_controls`, which increments `decision_seq` before deciding. When they then refuse, they raise an exception: `ZP001`–`ZP008` or `22023`, or PostgreSQL raises `55P03` or `40001` itself. The claim also raises `ZP004` when its exposure read is unavailable. The exception aborts the statement and everything it did: the increment, any rows it inserted or updated, and any trigger effects.

- No function on the ledger path catches exceptions (0050–0083 have no exception handlers there), so under PostgREST the whole RPC transaction rolls back.
- A caller that does catch the error, with a PL/pgSQL `EXCEPTION` block or an explicit savepoint, gets the same result for that work: the catch rolls back to the savepoint taken before the call, and the increment is inside it.
- An explicit transaction left in the aborted state can only be rolled back.

`decision_seq` therefore changes only when a decision succeeds and its own writes persist:

| Successful operation | `decision_seq` change | Other writes |
|---|---|---|
| reservation insert statement with at least one row | +2 (the before-statement and after-statement triggers) | the ledger rows |
| send marker | +1 | the marker |
| `enable_paid_execution` | +1 | the `spend_controls` row, one `spend_control_events` row |
| `record_spend_call_review` | +1 | one `spend_call_reviews` row |
| `disable_paid_execution` | +1 | the `spend_controls` row, one `spend_control_events` row |
| claim returning `CLAIMED` | 0 | the job update, one `spend_admissions` row |
| reservation insert statement with zero rows, while enabled | +1 (the before-statement trigger only) | none. No current path issues one and it is not a refusal; it is listed so the counter's behaviour is fully specified. |

**Regression assertions for PR-B.** Before each case, record:

- the full `spend_controls` row, including `decision_seq`, `updated_at`, `updated_by` and `xmin`;
- a row count and an ordered content hash of `spend_control_events`, `spend_admissions`, `spend_call_reviews`, `protocol_external_calls`, `external_call_requests`, `protocol_attempts`, `protocol_execution_jobs`, `protocol_operator_actions`, `protocol_execution_job_alerts` and `protocol_execution_job_alert_deliveries`.

After the call ends, record them again.

- **R1, status returns:** for each claim refusal status and for `NO_JOB_AVAILABLE`, with and without exhausted jobs present, every recorded value is identical after the transaction commits, `decision_seq` and `xmin` included. `SPEND_CONTROLS_MISSING` is reached only in the disposable stack, by disabling the delete guard as superuser during setup.
- **R2, exceptions:** for each of `ZP001`–`ZP008`, `22023`, `55P03` and `40001`, raised both from a PostgREST call and from an explicit psql transaction that is then rolled back, every recorded value is identical.
- **R3, caught exceptions:** a test-only PL/pgSQL block catches `ZP001` from a gate refusal, writes one unrelated marker row and commits. The marker persists, and every recorded value is identical, `decision_seq` included.
- **R4, successes:** each operation in the table above changes `decision_seq` by exactly the amount shown and changes only the rows listed.

## 14. Implementation plan and acceptance tests

| PR | Scope | Authorisation |
|---|---|---|
| PR-A | D-037 and this document | this PR; no code, no CI effect |
| PR-B | migration 0084; offline schema-contract tests; an opt-in disposable-stack runtime suite; PG-9 allowlists (the baseline run excludes 0084, a new run includes it, both refuse 0082) | separate. **Pushing it triggers the Level 2 workflow, which applies every migration to a disposable PostgreSQL.** |
| PR-C | the worker uses the new claim and sweep, maps the new error codes, and enforces M_w | separate |
| PR-D | migration 0085; legacy routes refuse in production; scripts refuse; static paid-call-site check | separate, and also triggers Level 2 |
| PR-E | reservation sizing so each reservation covers its worst-case cost; the review runbook | separate |
| Ops | S0–S6 | each step separately |

The PR-B suite must include, with exact expected results:

- **Atomicity:** a writer racing the migration in both orders; a lock timeout and an injected self-check failure leave no objects and no ledger row, under both the CLI and `psql`; 0082 recorded is refused; re-apply is refused.
- **Isolation:** actual REPEATABLE READ, SERIALIZABLE and READ UNCOMMITTED transactions whose snapshot predates a committed reservation are refused with `ZP008`; with that check disabled in the disposable stack, `40001`. A function-level `default_transaction_isolation` setting does not change the current transaction, so tests assert the effective `transaction_isolation` before asserting the outcome.
- **Visibility:** two $0.60 reservations in one statement against $1.00 are refused, with zero rows.
- **Time:** lock waits and long transactions do not backdate decisions or send markers; boundary rows are counted by decision time.
- **Concurrency:** a lease expiry, a crash and a client abort each leave the in-flight count correct; simultaneous sends admit exactly the limit; no deadlocks across random interleavings.
- **Disable:** forced races in both orders; a fake provider receives at most the potentially-unsent calls, within M_w, and nothing afterwards.
- **Refusals:** R1–R4 (section 13.1), including `spend_controls.decision_seq` and `xmin`.
- **Pre-activation:** each blocking check refuses activation; reviews clear only the clearable checks; pre-gate rows are byte-identical before and after.
- **Regression:** the full PG-9 roster and the M5 runtime contracts on 0084 behave as before.

## 15. Open items

- A_R: verify Perplexity's server-side processing horizon from documentation or a documented measurement. Activation blocker.
- Provider-side account limits and key custody. Activation blockers.
- Whether the three paid scripts are retired or moved onto the job system.
- Whether the unresolved-cost latch stays strict, stopping all paid activity after any client timeout until reviewed, beyond the pilot.
- The Agent API stays disabled until its tool-call cost can be bounded by a reservation.
