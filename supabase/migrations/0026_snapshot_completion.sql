create or replace function
  public.finalize_snapshot_request(
    p_request_id uuid,
    p_project_id uuid,
    p_final_status text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
begin
  if p_final_status not in (
    'report_ready',
    'failed'
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_snapshot_final_status';
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_request.status = p_final_status then
    return query
    select request.*
      from public.snapshot_requests request
     where request.id = p_request_id;

    return;
  end if;

  if v_request.status <> 'running' then
    return;
  end if;

  if p_final_status = 'report_ready'
     and v_request.progress_stage
           <> 'quality_review' then
    return;
  end if;

  return query
  update public.snapshot_requests
     set status = p_final_status,
         updated_at = now()
   where id = p_request_id
     and project_id = p_project_id
     and status = 'running'
  returning *;
end;
$$;

revoke all on function
  public.finalize_snapshot_request(
    uuid,
    uuid,
    text
  )
from public;

revoke all on function
  public.finalize_snapshot_request(
    uuid,
    uuid,
    text
  )
from anon;

revoke all on function
  public.finalize_snapshot_request(
    uuid,
    uuid,
    text
  )
from authenticated;

grant execute on function
  public.finalize_snapshot_request(
    uuid,
    uuid,
    text
  )
to service_role;
