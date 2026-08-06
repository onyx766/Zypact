# PR #8 — RPC-only snapshot report writes

**Internal technical rollout record.** This is an engineering change log and
sign-off. It is **not** an external security certification, audit, or
penetration test.

Date: 2026-08-06

## Purpose

Move snapshot report writes off direct table access and onto a fenced
`SECURITY DEFINER` RPC surface, then enforce that boundary in the database so
the application cannot bypass it.

## Final architecture

- Report artifact save, backfill, and delivery bookkeeping all execute through
  approved RPCs. The application performs no direct write to
  `snapshot_requests` or `snapshot_report_artifacts`.
- Direct `service_role` DML on both tables is revoked (migration 0032).
  `SELECT` is preserved.
- A project with a stored report cannot be deleted (migration 0033,
  `ON DELETE RESTRICT`), which closes an indirect path that previously allowed
  a delivered report to be destroyed by deleting its project.
- Delivery updates bookkeeping only. Report content and the public token are
  never modified by delivery or resend.

## Rollout sequence

1. PR #8 merged to `main`; Production deployed automatically from the merge
   commit, still in direct mode.
2. Production migration history reconciled — 0027–0029 had been applied outside
   the CLI and were missing from the history table.
3. Migrations 0030 and 0031 applied individually, with verification between
   them.
4. Production switched to RPC write mode and redeployed. Changing the variable
   alone does not affect a running deployment; a new deployment is required.
5. Artifact save validated against Production through the real adapter.
6. Initial delivery and one authorized resend validated through the deployed
   founder route.
7. Migration 0032 applied, revoking direct DML.
8. Migration 0033 applied, restricting artifact-linked project deletion.

Migrations 0032 and 0033 were each rehearsed inside a fully rolled-back
transaction against the live database before being applied for real, with hard
assertions that abort before `COMMIT` on any failure.

## Validation performed

- Artifact save proven to call the manual-save RPC, with a runtime guard that
  fails immediately on any direct artifact-table mutation.
- Delivery proven by database evidence rather than configuration: the RPC sets
  `updated_at = now()` while the direct path set it equal to `delivered_at`, so
  a divergence between the two columns identifies the path taken.
- Direct DML denial confirmed with SQLSTATE `42501` on both tables for
  `INSERT`, `UPDATE`, and `DELETE`.
- Project-delete restriction confirmed with SQLSTATE `23503` and the exact
  constraint name; an empty project remained deletable by the same role, so the
  failure is attributable to the foreign key and not to missing permission.
- Final rollout audit: **89 checks passed, 0 failed**.

## Final state

- Production and Preview both end at migration **0033**.
- Pending tracked migrations: **0**.
- Production runs RPC-only snapshot-report writes.
- The synthetic Production validation fixtures were removed in a single
  transaction — 2 requests, 2 artifacts, 2 exclusively linked projects — with
  zero orphan references and no unrelated row affected.
- Repository `main` synchronized; the rollout branch and three merged legacy
  branches deleted locally and remotely.

## Follow-up work — completed 2026-08-06

All three items listed as remaining after the PR #8 rollout are now closed.

1. **Level 2 BYPASSRLS fidelity — done.** The disposable harness created
   `service_role` without `BYPASSRLS` while the real role has it. No assertion
   had been wrong, but the gap was a latent trap: a direct write reduced to
   zero rows by RLS still returns success. The harness role now carries
   `BYPASSRLS`, a separate non-`BYPASSRLS` role exercises RLS filtering itself,
   the tautological visibility check was replaced with exact-count assertions,
   denials are pinned to SQLSTATE `42501`, and a new test demonstrates the
   silent zero-row false positive end to end. CI: **223 assertions passed, 0
   failed**.
2. **Direct compatibility-code removal — done (PR #11).** The three `direct`
   branches were deleted. Report artifact save, backfill, and delivery each
   call their approved RPC unconditionally. Runtime direct mutation paths
   against `snapshot_report_artifacts` and `snapshot_requests`: **0**. The
   adapter no longer mints public report tokens — the SQL layer owns them.
   Focused adapter tests: **67 passed, 0 failed**.
3. **Write-mode environment variable removal — done.** The resolver now treats
   absent configuration as `rpc` and rejects `direct` and every unsupported
   value. With that deployed and verified, the Production entry was removed.

## Transitional write-mode cleanup — completed 2026-08-06

- PR #11 merged to `main`; Production deployed automatically from the merge
  commit and reached READY.
- All three artifact mutation paths are RPC-only, with no compatibility branch
  and no fallback.
- The Production `SNAPSHOT_REPORT_WRITE_MODE` entry was removed. Only the
  Production-scoped record was deleted; no other environment entry changed.
- Exactly one same-commit Production redeployment was created afterward, from
  the identical merge commit, and reached READY. Environment changes apply only
  to new deployments, so the redeploy is what puts the absence into effect.
- Production now relies on absent → `rpc` resolution rather than on an
  explicitly configured mode.
- The four orphaned branch-specific Preview entries left behind by the deleted
  rollout branch were removed, each with an exact environment-and-branch
  selector so that identically named shared entries were not touched. No
  branch-scoped environment entry remains.
- Preview and Development define no write-mode entry in any scope.
- **No database, migration, privilege, route, report, email, AI, scan, worker,
  or cron action occurred during the environment cleanup.** No environment
  value was read or printed at any point.

This completes the transitional write-mode cleanup.

## Rollback

Two rules, and they are not interchangeable.

**Promoting or deploying older code is not a free action.** After migration
0032, an older direct-mode deployment cannot write — direct DML is
permission-denied. Separately, pre-PR #11 code defaults an *absent* variable to
`direct`, and the variable is now absent everywhere, so such a deployment would
select the blocked path. Before deploying or promoting pre-PR #11 code,
Production `SNAPSHOT_REPORT_WRITE_MODE=rpc` must first be restored **and** be
present in a new READY deployment; restoring the variable alone does not change
an already-built deployment. **Rolling forward with a correction is preferred.**

**Restoring the privileges revoked by migration 0032 is not a rollback option.**
It dismantles an active security boundary: without 0032 the fencing, ownership,
and delivered-artifact immutability rules enforced inside the RPCs can be
bypassed by writing to the tables directly. It is a last-resort emergency
action requiring explicit founder approval, a separately reviewed and controlled
migration, and a documented plan to restore RPC-only enforcement afterward —
never an ad hoc Production command. No such migration is planned or authorized.
