-- Enforce the snapshot RPC boundary by revoking direct table DML.
--
-- Direct writes are prohibited after every production writer has migrated
-- to the SECURITY DEFINER RPC surface added by migrations 0030 and 0031.
-- Until then the RPCs are advisory: any holder of the service-role key can
-- bypass every token, lease, and delivered-artifact guard by writing to
-- these tables directly. This migration is what makes the fencing real.
--
-- service_role retains read access and approved RPC execution. SELECT is
-- deliberately preserved: the founder admin pages, the public report page,
-- and the send-report route all read through the adapter, and none of them
-- writes directly.
--
-- The SECURITY DEFINER RPCs continue to mutate both tables after this
-- migration, because such a function executes with the privileges of its
-- owner rather than the caller.
--
-- FUTURE MIGRATIONS MUST NOT re-grant direct non-SELECT privileges on
-- these tables, and must not re-add them through ALTER DEFAULT PRIVILEGES.
-- A new writer belongs behind a new RPC, not behind a restored GRANT.
--
-- DEPLOYMENT ORDER WARNING: this migration must not be applied to
-- Production before all current artifact writers use the RPC surface.
-- `lib/db/supabase-adapter.ts` still calls `.from("snapshot_report_artifacts")`
-- directly in `saveSnapshotReportArtifact` and `markSnapshotReportDelivered`.
-- Applying this to Production first would break report storage and founder
-- delivery. Apply only after those callers have been migrated and deployed.
--
-- Scope: exactly two tables, exactly one role, exactly six privileges.
-- No table is created or altered, no data is touched, no function is
-- dropped or replaced, no ownership changes, no RLS setting changes, and
-- no default privileges are modified.
--
-- REVOKE is idempotent: revoking a privilege the role does not hold is a
-- no-op, so this migration is safe to re-apply.

revoke insert on table public.snapshot_requests from service_role;
revoke update on table public.snapshot_requests from service_role;
revoke delete on table public.snapshot_requests from service_role;
revoke truncate on table public.snapshot_requests from service_role;
revoke references on table public.snapshot_requests from service_role;
revoke trigger on table public.snapshot_requests from service_role;

revoke insert on table public.snapshot_report_artifacts from service_role;
revoke update on table public.snapshot_report_artifacts from service_role;
revoke delete on table public.snapshot_report_artifacts from service_role;
revoke truncate on table public.snapshot_report_artifacts from service_role;
revoke references on table public.snapshot_report_artifacts from service_role;
revoke trigger on table public.snapshot_report_artifacts from service_role;
