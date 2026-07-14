-- Atomically reserve an approved snapshot request and create its project.
--
-- queued -> running
--
-- The same request can be reserved repeatedly without creating another
-- project. No crawl, LLM agent, probe, or paid API call occurs here.

create or replace function
  public.reserve_snapshot_request_project(
    p_request_id uuid
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_project_id uuid;
begin
  if p_request_id is null then
    return;
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
   for update;

  if not found then
    return;
  end if;

  if v_request.approved_at is null
     or v_request.approved_by is null then
    return;
  end if;

  if v_request.status = 'running'
     and v_request.project_id is not null then
    return query
    select request.*
      from public.snapshot_requests request
     where request.id = p_request_id;

    return;
  end if;

  if v_request.status <> 'queued' then
    return;
  end if;

  v_project_id := v_request.project_id;

  if v_project_id is null then
    insert into public.projects (
      user_id,
      company_name,
      domain,
      category
    )
    values (
      null,
      v_request.company_name,
      v_request.normalized_domain,
      v_request.buyer_category
    )
    returning id
      into v_project_id;
  end if;

  return query
  update public.snapshot_requests
     set project_id = v_project_id,
         status = 'running',
         updated_at = now()
   where id = p_request_id
     and status = 'queued'
  returning *;
end;
$$;

revoke all on function
  public.reserve_snapshot_request_project(uuid)
from public;

revoke all on function
  public.reserve_snapshot_request_project(uuid)
from anon;

revoke all on function
  public.reserve_snapshot_request_project(uuid)
from authenticated;

grant execute on function
  public.reserve_snapshot_request_project(uuid)
to service_role;
