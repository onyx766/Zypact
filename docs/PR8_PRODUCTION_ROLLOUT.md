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

## Remaining non-blocking work

1. **Level 2 BYPASSRLS fidelity.** The disposable harness role is created
   without `BYPASSRLS`, while the real `service_role` has it. No current
   assertion is wrong — the denial probes rely on privilege checks, which
   precede RLS, and the remaining `SET ROLE` sites call `SECURITY DEFINER`
   RPCs that execute as the owner. The risk is latent: a future direct-write
   test expecting success could silently pass on zero affected rows.
2. **Direct compatibility-code removal.** The `direct` branches in the adapter
   are unreachable in any environment now that 0032 is applied everywhere.
3. **Write-mode environment variable removal.** Safe only *after* the resolver
   stops defaulting to `direct`; removing the variable first would select the
   dead path.

## Rollback

After migration 0032, promoting an older direct-mode deployment is **not** a
complete rollback — direct writes are permission-denied. A rollback also
requires restoring the revoked grants, or rolling forward instead.
