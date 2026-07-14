-- Founder Institute Basic Prototype — safe verification delivery failure.
--
-- When email delivery fails:
--   - the request becomes failed;
--   - the token hash and expiration are removed;
--   - the user may submit a new request;
--   - no project or AI scan is created.
--
-- The transition only applies while the request is still waiting
-- for email verification. A request already verified is preserved.

create or replace function public.fail_snapshot_verification_delivery(
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_updated_count integer;
begin
  update public.snapshot_requests
     set status = 'failed',
         verification_token_hash = null,
         verification_expires_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_verification'
     and verified_at is null;

  get diagnostics v_updated_count = row_count;

  return v_updated_count = 1;
end;
$$;

revoke all on function public.fail_snapshot_verification_delivery(
  uuid
) from public;

revoke all on function public.fail_snapshot_verification_delivery(
  uuid
) from anon;

revoke all on function public.fail_snapshot_verification_delivery(
  uuid
) from authenticated;

grant execute on function public.fail_snapshot_verification_delivery(
  uuid
) to service_role;
