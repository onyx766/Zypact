-- Worker claim, lease, and fencing for approved snapshot requests.
--
-- Dormant infrastructure: no worker process exists yet. Nothing in the
-- deployed application calls the RPCs added here.
--
-- Fencing model
--   `lease_expires_at` alone cannot fence a stalled worker: a systemd
--   restart reuses the same machine label, so `claimed_by` is not a
--   process identity. Every worker-owned mutation is therefore gated on
--   `claim_token`, a fresh uuid the database generates per claim. A
--   caller can never choose or reuse a token.
--
-- Manual CLI compatibility
--   Requests reserved by the manual runner keep all three ownership
--   fields null. They are never reclaimed or terminalized here, and
--   `reserve_snapshot_request_project` keeps its signature and behavior
--   for them. It now refuses worker-owned running requests so the CLI
--   cannot run beside a worker.
--
-- No crawl, LLM agent, probe, or paid API call occurs in this migration.

-- ── Schema ───────────────────────────────────────────────────────────

alter table public.snapshot_requests
  add column if not exists claimed_by text null,
  add column if not exists claim_token uuid null,
  add column if not exists lease_expires_at timestamptz null,
  add column if not exists attempt_count integer not null default 0;

alter table public.snapshot_requests
  drop constraint if exists snapshot_requests_attempt_count_check;

alter table public.snapshot_requests
  add constraint snapshot_requests_attempt_count_check
  check (attempt_count >= 0);

alter table public.snapshot_requests
  drop constraint if exists snapshot_requests_claimed_by_length_check;

alter table public.snapshot_requests
  add constraint snapshot_requests_claimed_by_length_check
  check (
    claimed_by is null
    or char_length(claimed_by) between 1 and 100
  );

-- Ownership is all-or-nothing. Manual CLI runs leave all three null.
alter table public.snapshot_requests
  drop constraint if exists snapshot_requests_claim_coherence_check;

alter table public.snapshot_requests
  add constraint snapshot_requests_claim_coherence_check
  check (
    (
      claimed_by is null
      and claim_token is null
      and lease_expires_at is null
    )
    or (
      claimed_by is not null
      and claim_token is not null
      and lease_expires_at is not null
    )
  );

-- Stale-lease scan. Partial so manual runs never enter the index.
create index if not exists snapshot_requests_stale_lease_idx
  on public.snapshot_requests (lease_expires_at, created_at)
  where status = 'running'
    and claim_token is not null;

-- ── Internal project helper ──────────────────────────────────────────
--
-- Shared by `reserve_snapshot_request_project` and
-- `claim_next_snapshot_request` so project creation is defined once.
-- The caller must already hold the snapshot-request row lock. This
-- helper never changes status, lease, or attempt count.

create or replace function
  public._ensure_snapshot_request_project(
    p_request_id uuid
  )
returns uuid
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_project_id uuid;
begin
  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id;

  if not found then
    return null;
  end if;

  v_project_id := v_request.project_id;

  if v_project_id is not null then
    return v_project_id;
  end if;

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

  return v_project_id;
end;
$$;

revoke all on function
  public._ensure_snapshot_request_project(uuid)
from public;

revoke all on function
  public._ensure_snapshot_request_project(uuid)
from anon;

revoke all on function
  public._ensure_snapshot_request_project(uuid)
from authenticated;

revoke all on function
  public._ensure_snapshot_request_project(uuid)
from service_role;

-- ── Manual reservation (signature unchanged) ─────────────────────────

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

  -- A worker owns this request. The manual runner must not attach to it.
  if v_request.status = 'running'
     and v_request.claim_token is not null then
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

  v_project_id :=
    public._ensure_snapshot_request_project(p_request_id);

  if v_project_id is null then
    return;
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

-- ── Atomic claim ─────────────────────────────────────────────────────
--
-- Selects, reserves the project, transitions, and leases in one
-- transaction. Splitting these would leave a request `running` with a
-- null project and no way to recover it.

create or replace function
  public.claim_next_snapshot_request(
    p_worker_id text,
    p_lease_seconds integer,
    p_max_attempts integer
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_worker_id text;
  v_candidate public.snapshot_requests%rowtype;
  v_project_id uuid;
  v_token uuid;
begin
  v_worker_id := btrim(coalesce(p_worker_id, ''));

  if char_length(v_worker_id) < 1
     or char_length(v_worker_id) > 100 then
    raise exception using
      errcode = '22023',
      message = 'invalid_worker_id';
  end if;

  if p_lease_seconds is null
     or p_lease_seconds < 60
     or p_lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'invalid_lease_seconds';
  end if;

  if p_max_attempts is null
     or p_max_attempts < 1
     or p_max_attempts > 10 then
    raise exception using
      errcode = '22023',
      message = 'invalid_max_attempts';
  end if;

  -- Terminalize exhausted worker-owned requests before selecting, so an
  -- abandoned request cannot sit in `running` forever. Manual runs are
  -- excluded: their claim_token is null.
  update public.snapshot_requests
     set status = 'failed',
         claimed_by = null,
         claim_token = null,
         lease_expires_at = null,
         updated_at = now()
   where status = 'running'
     and claim_token is not null
     and lease_expires_at <= now()
     and attempt_count >= p_max_attempts;

  -- Stale worker-owned requests first: they already consumed paid
  -- probes, so resuming one costs only the missing runs.
  select request.*
    into v_candidate
    from public.snapshot_requests request
   where (
           request.status = 'running'
       and request.claim_token is not null
       and request.lease_expires_at <= now()
       and request.attempt_count < p_max_attempts
         )
      or (
           request.status = 'queued'
       and request.approved_at is not null
       and request.approved_by is not null
         )
   order by
     case when request.status = 'running' then 0 else 1 end,
     request.created_at asc,
     request.id asc
   limit 1
   for update skip locked;

  if not found then
    return;
  end if;

  v_project_id :=
    public._ensure_snapshot_request_project(v_candidate.id);

  if v_project_id is null then
    return;
  end if;

  v_token := gen_random_uuid();

  return query
  update public.snapshot_requests
     set project_id = v_project_id,
         status = 'running',
         progress_stage =
           case
             when snapshot_requests.status = 'queued'
               then 'reserved'
             else snapshot_requests.progress_stage
           end,
         progress_updated_at =
           case
             when snapshot_requests.status = 'queued'
               then now()
             else snapshot_requests.progress_updated_at
           end,
         attempt_count = snapshot_requests.attempt_count + 1,
         claimed_by = v_worker_id,
         claim_token = v_token,
         lease_expires_at =
           now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where snapshot_requests.id = v_candidate.id
  returning *;
end;
$$;

revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from public;

revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from anon;

revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from authenticated;

grant execute on function
  public.claim_next_snapshot_request(text, integer, integer)
to service_role;

-- ── Lease renewal ────────────────────────────────────────────────────
--
-- An expired lease is lost permanently, even before another worker
-- reclaims it. Reviving one would let a stalled worker resume writing
-- after ownership had already moved on.

create or replace function
  public.renew_snapshot_request_lease(
    p_request_id uuid,
    p_claim_token uuid,
    p_lease_seconds integer
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
  if p_lease_seconds is null
     or p_lease_seconds < 60
     or p_lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'invalid_lease_seconds';
  end if;

  if p_request_id is null
     or p_claim_token is null then
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

  if v_request.status <> 'running'
     or v_request.claimed_by is null
     or v_request.claim_token is null
     or v_request.lease_expires_at is null
     or v_request.claim_token <> p_claim_token
     or v_request.lease_expires_at <= now() then
    return;
  end if;

  return query
  update public.snapshot_requests
     set lease_expires_at =
           now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_request_id
     and status = 'running'
     and claim_token = p_claim_token
     and lease_expires_at > now()
  returning *;
end;
$$;

revoke all on function
  public.renew_snapshot_request_lease(uuid, uuid, integer)
from public;

revoke all on function
  public.renew_snapshot_request_lease(uuid, uuid, integer)
from anon;

revoke all on function
  public.renew_snapshot_request_lease(uuid, uuid, integer)
from authenticated;

grant execute on function
  public.renew_snapshot_request_lease(uuid, uuid, integer)
to service_role;
