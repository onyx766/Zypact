-- Founder-only rejection of pending snapshot requests.
--
-- Only requests waiting for founder approval may be rejected.
-- Browser clients never call this function directly.

create or replace function
  public.reject_snapshot_request(
    p_request_id uuid
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  return query
  update public.snapshot_requests
     set status = 'rejected',
         progress_stage = null,
         progress_updated_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_approval'
  returning *;
end;
$$;

revoke all on function
  public.reject_snapshot_request(uuid)
from public;

revoke all on function
  public.reject_snapshot_request(uuid)
from anon;

revoke all on function
  public.reject_snapshot_request(uuid)
from authenticated;

grant execute on function
  public.reject_snapshot_request(uuid)
to service_role;
