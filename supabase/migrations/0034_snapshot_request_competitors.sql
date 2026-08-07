-- Architecture PR #4 — competitors per snapshot request.
--
-- A snapshot cannot be executed without a competitor frame: the renderer
-- refuses an empty `--focus-competitors` value, and prompt generation falls
-- back to a hardcoded list that belongs to Zypact's own market rather than
-- the client's. The manual CLI solves this by requiring `--competitors`,
-- which is why manual runs are safe. Automatic execution has no such
-- operator, so the list has to be stored with the request.
--
-- Competitor discovery cannot supply it: `discover_competitors` refuses to
-- run without probe evidence, so competitors are an output of a scan, not an
-- input to one. The founder therefore supplies them at approval time.
--
-- `[]` stays valid before approval. Historical rows keep `[]` and are never
-- backfilled with invented competitors. The minimum is enforced at the
-- approval boundary, not on the column, because pre-approval and historical
-- rows legitimately hold none.

alter table public.snapshot_requests
  add column if not exists competitors jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'snapshot_requests_competitors_is_array'
  ) then
    alter table public.snapshot_requests
      add constraint snapshot_requests_competitors_is_array
        check (jsonb_typeof(competitors) = 'array');
  end if;
end;
$$;

comment on column public.snapshot_requests.competitors is
  'Founder-reviewed competitor frame, stored at approval. Ordered JSON array '
  'of trimmed, case-insensitively deduplicated strings. Empty before '
  'approval and for historical rows. Minimum 2 / maximum 12 enforced by '
  'approve_and_queue_snapshot_request, not by a column constraint.';

-- ---------------------------------------------------------------------------
-- Normalization
--
-- Mirrors `parseCompetitors` in scripts/run-approved-snapshot.ts exactly, so
-- a stored list can never produce a run the manual CLI would have rejected:
-- trim, drop blanks, deduplicate case-insensitively, keep first-seen casing,
-- keep first-seen order.
-- ---------------------------------------------------------------------------

create or replace function
  public._normalize_snapshot_competitors(
    p_competitors jsonb
  )
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_element jsonb;
  v_value text;
  v_seen text[] := array[]::text[];
  v_result jsonb := '[]'::jsonb;
begin
  if p_competitors is null
     or jsonb_typeof(p_competitors) <> 'array' then
    return null;
  end if;

  for v_element in
    select value from jsonb_array_elements(p_competitors)
  loop
    -- Any non-string element makes the whole input invalid rather than
    -- being silently skipped: a caller sending objects or numbers has a
    -- different contract in mind and should be told so.
    if jsonb_typeof(v_element) <> 'string' then
      return null;
    end if;

    v_value := btrim(v_element #>> '{}');

    if v_value = '' then
      continue;
    end if;

    if lower(v_value) = any (v_seen) then
      continue;
    end if;

    v_seen := v_seen || lower(v_value);
    v_result := v_result || to_jsonb(v_value);
  end loop;

  return v_result;
end;
$$;

revoke all on function
  public._normalize_snapshot_competitors(jsonb)
from public;
revoke all on function
  public._normalize_snapshot_competitors(jsonb)
from anon;
revoke all on function
  public._normalize_snapshot_competitors(jsonb)
from authenticated;
revoke all on function
  public._normalize_snapshot_competitors(jsonb)
from service_role;

-- ---------------------------------------------------------------------------
-- Approval
--
-- The two-argument form is dropped in the same migration. Leaving it callable
-- would leave a path that queues a request with no competitor frame, and a
-- queued request is claimable immediately. A stale caller failing closed
-- during rollout is the intended trade: it can never queue an unusable
-- request.
-- ---------------------------------------------------------------------------

drop function if exists
  public.approve_and_queue_snapshot_request(uuid, uuid);

create or replace function
  public.approve_and_queue_snapshot_request(
    p_request_id uuid,
    p_approved_by uuid,
    p_competitors jsonb
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_competitors jsonb;
  v_count integer;
  v_value text;
begin
  if p_request_id is null
     or p_approved_by is null then
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

  -- Idempotent second call. The stored list is returned untouched: once a
  -- request is queued a worker may already have claimed it, so replacing
  -- its competitor frame would change what a running scan is measuring.
  if v_request.status = 'queued'
     and v_request.approved_at is not null
     and v_request.approved_by is not null then
    return query
    select request.*
      from public.snapshot_requests request
     where request.id = p_request_id;

    return;
  end if;

  if v_request.status <> 'pending_approval' then
    return;
  end if;

  v_competitors := public._normalize_snapshot_competitors(p_competitors);

  if v_competitors is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_competitors_shape';
  end if;

  v_count := jsonb_array_length(v_competitors);

  if v_count < 2 then
    raise exception using
      errcode = '22023',
      message = 'competitors_below_minimum';
  end if;

  if v_count > 12 then
    raise exception using
      errcode = '22023',
      message = 'competitors_above_maximum';
  end if;

  for v_value in
    select value #>> '{}' from jsonb_array_elements(v_competitors) as value
  loop
    if char_length(v_value) > 200 then
      raise exception using
        errcode = '22023',
        message = 'competitor_too_long';
    end if;

    -- Same self-reference rule the discovery agent already applies: a brand
    -- cannot be its own competitor, and a scan framed against itself would
    -- produce a meaningless comparison.
    if lower(v_value) = lower(btrim(coalesce(v_request.company_name, '')))
       or lower(v_value) = lower(btrim(coalesce(v_request.normalized_domain, ''))) then
      raise exception using
        errcode = '22023',
        message = 'competitor_is_scanned_company';
    end if;
  end loop;

  -- One statement: the validated frame, the approval metadata, and the
  -- queued transition. A worker can only ever observe a queued request that
  -- already carries its final competitor list.
  return query
  update public.snapshot_requests
     set competitors = v_competitors,
         status = 'queued',
         approved_at = now(),
         approved_by = p_approved_by,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_approval'
  returning *;
end;
$$;

revoke all on function
  public.approve_and_queue_snapshot_request(uuid, uuid, jsonb)
from public;
revoke all on function
  public.approve_and_queue_snapshot_request(uuid, uuid, jsonb)
from anon;
revoke all on function
  public.approve_and_queue_snapshot_request(uuid, uuid, jsonb)
from authenticated;

grant execute on function
  public.approve_and_queue_snapshot_request(uuid, uuid, jsonb)
to service_role;
