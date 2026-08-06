-- Close the indirect deletion path around a stored snapshot report.
--
-- Migrations 0031 and 0032 make a delivered artifact immutable through the
-- write surface: `mark_snapshot_report_delivered` touches bookkeeping only,
-- `save_snapshot_report_artifact_manual` refuses a delivered artifact, and
-- service_role holds no direct INSERT/UPDATE/DELETE on either snapshot
-- table.
--
-- One path survived all of that. `snapshot_report_artifacts.project_id`
-- referenced `public.projects` with ON DELETE CASCADE, and 0032 revoked
-- nothing on `public.projects`. Deleting a project therefore destroyed
-- every artifact bound to it, delivered or not, without touching a
-- protected table. The parent `snapshot_requests` row survived, because its
-- own project reference is ON DELETE SET NULL — so the result was a
-- report_ready request whose report no longer existed. That state is
-- exactly what `finalize_snapshot_request` refuses to create ("report_ready
-- without a stored report would be a lie to the founder"), reachable
-- through the back door.
--
-- This was observed in Zypact Preview on 2026-08-05: a synthetic project
-- was deleted and its stored artifact disappeared with it.
--
-- The correction is a constraint, not a privilege. RESTRICT makes the
-- database refuse to delete a project while any snapshot report artifact
-- still references it. No role loses a grant, no RPC changes behavior, no
-- data is read or written, and `public.projects` keeps every privilege it
-- had.
--
-- SCOPE NOTE: RESTRICT blocks the delete whenever an artifact exists, not
-- only when that artifact has been delivered. A foreign key cannot express
-- "only when delivered_at is not null"; that would require a BEFORE DELETE
-- trigger on `public.projects`. The stricter rule was chosen deliberately:
-- no application code path deletes a project — there is no adapter method,
-- no DELETE route handler, and no account or project deletion flow — so
-- nothing in the product lifecycle regresses. Only four optional local test
-- harnesses delete projects as cleanup, and each of them already deletes
-- `snapshot_requests` first, which 0032 blocks for service_role.
--
-- WHEN A PROJECT DELETION FLOW IS BUILT, it must decide explicitly what
-- happens to a stored report: delete the artifact through an approved RPC
-- first, or refuse the deletion. Forcing that decision is the point.
--
-- The sibling constraint on `snapshot_request_id` stays ON DELETE CASCADE.
-- Removing a snapshot request should still remove its report, and 0032
-- already blocks service_role from deleting a snapshot request.

alter table public.snapshot_report_artifacts
  drop constraint if exists
    snapshot_report_artifacts_project_id_fkey;

alter table public.snapshot_report_artifacts
  add constraint snapshot_report_artifacts_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete restrict;
