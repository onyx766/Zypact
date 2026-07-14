-- Founder Institute Basic Prototype — founder approval gate.
--
-- Security contract:
--   - only the server-side service role can call the RPC;
--   - approval metadata is recorded;
--   - pending_approval moves through approved to queued atomically;
--   - repeated approval of an already queued request is idempotent;
--   - no project or AI scan is created here.

alter table public.snapshot_requests
  add column if not exists approved_at timestamptz null,
  add column if not exists approved_by uuid null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname =
       'snapshot_requests_approval_pair_check'
       and conrelid =
         'public.snapshot_requests'::regclass
  ) then
    alter table public.snapshot_requests
      add constraint
        snapshot_requests_approval_pair_check
      check (
        (
          approved_at is null
          and approved_by is null
        )
        or
        (
          approved_at is not null
          and approved_by is not null
        )
      );
  end if;
end;
$$;

create index if not exists
  snapshot_requests_queued_created_idx
  on public.snapshot_requests (
    created_at asc
  )
  where status = 'queued';

create or replace function
  public.approve_and_queue_snapshot_request(
    p_request_id uuid,
    p_approved_by uuid
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_approved_count integer;
begin
  if p_request_id is null
     or p_approved_by is null then
    return;
  end if;

  -- Both updates belong to the same transaction. Other sessions
  -- cannot observe the intermediate approved state.
  update public.snapshot_requests
     set status = 'approved',
         approved_at = now(),
         approved_by = p_approved_by,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_approval';

  get diagnostics
    v_approved_count = row_count;

  if v_approved_count = 1 then
    return query
    update public.snapshot_requests
       set status = 'queued',
           updated_at = now()
     where id = p_request_id
       and status = 'approved'
    returning *;

    return;
  end if;

  -- Idempotent second call.
  return query
  select request.*
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.status = 'queued'
     and request.approved_at is not null
     and request.approved_by is not null;
end;
$$;

revoke all on function
  public.approve_and_queue_snapshot_request(
    uuid,
    uuid
  )
from public;

revoke all on function
  public.approve_and_queue_snapshot_request(
    uuid,
    uuid
  )
from anon;

revoke all on function
  public.approve_and_queue_snapshot_request(
    uuid,
    uuid
  )
from authenticated;

grant execute on function
  public.approve_and_queue_snapshot_request(
    uuid,
    uuid
  )
to service_role;
