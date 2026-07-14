alter table public.snapshot_requests
  add column if not exists progress_stage text null,
  add column if not exists progress_updated_at timestamptz null;

alter table public.snapshot_requests
  drop constraint if exists snapshot_requests_progress_stage_check;

alter table public.snapshot_requests
  add constraint snapshot_requests_progress_stage_check
  check (
    progress_stage is null
    or progress_stage in (
      'reserved',
      'crawling',
      'analyzing_site',
      'generating_questions',
      'checking_ai_visibility',
      'building_diagnosis',
      'quality_review'
    )
  );

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
    update public.snapshot_requests
       set progress_stage =
             coalesce(progress_stage, 'reserved'),
           progress_updated_at =
             coalesce(progress_updated_at, now()),
           updated_at = now()
     where id = p_request_id;

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
    returning id into v_project_id;
  end if;

  return query
  update public.snapshot_requests
     set project_id = v_project_id,
         status = 'running',
         progress_stage = 'reserved',
         progress_updated_at = now(),
         updated_at = now()
   where id = p_request_id
     and status = 'queued'
  returning *;
end;
$$;

create or replace function
  public.update_snapshot_request_progress(
    p_request_id uuid,
    p_project_id uuid,
    p_progress_stage text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_current_stage text;
  v_current_rank integer;
  v_new_rank integer;
begin
  v_new_rank :=
    case p_progress_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else null
    end;

  if v_new_rank is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_snapshot_progress_stage';
  end if;

  select request.progress_stage
    into v_current_stage
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
     and request.status = 'running'
   for update;

  if not found then
    return;
  end if;

  v_current_rank :=
    case v_current_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else 0
    end;

  if v_new_rank < v_current_rank then
    return;
  end if;

  return query
  update public.snapshot_requests request
     set progress_stage = p_progress_stage,
         progress_updated_at =
           case
             when request.progress_stage
                    is distinct from p_progress_stage
             then now()
             else request.progress_updated_at
           end,
         updated_at = now()
   where request.id = p_request_id
     and request.project_id = p_project_id
     and request.status = 'running'
  returning *;
end;
$$;

revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from public;

revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from anon;

revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from authenticated;

grant execute on function
  public.update_snapshot_request_progress(uuid, uuid, text)
to service_role;
