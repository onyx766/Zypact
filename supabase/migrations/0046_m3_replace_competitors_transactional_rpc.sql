-- M3 — incident fix. Staging exercise of Competitor Discovery
-- (2026-08-20, historical project) revealed that
-- `replaceCompetitorsForProject`'s two separate Supabase calls
-- (DELETE, then INSERT) are not atomic: the DELETE committed, the
-- following INSERT then failed a CHECK constraint added by migration
-- 0045 (`competitors_canonical_entity_pair_check`, because the
-- application's INSERT payload did not set `canonical_entity_type`
-- alongside a non-null `canonical_entity_id`), and the six existing
-- `competitors` rows for that project were left deleted with nothing
-- to replace them.
--
-- This migration adds exactly one SECURITY DEFINER RPC,
-- `replace_competitors_for_project`, whose entire body — the DELETE,
-- the INSERT, and the final read-back — executes as a single
-- PL/pgSQL function call. Postgres wraps one function invocation in
-- one implicit transaction: if the INSERT raises (any constraint
-- violation, including the pair/type/FK checks from migration 0045),
-- the exception propagates uncaught (no `exception when others`
-- handler here), so the DELETE that already ran inside the SAME
-- function call is rolled back too. The failure mode observed in
-- staging — old rows gone, new rows never written — becomes
-- structurally impossible through this path.
--
-- `canonical_entity_type` is derived here from `canonical_entity_id`
-- alone (`'competitor'` iff non-null, `NULL` otherwise) — the RPC
-- does not trust a client-supplied type value at all, so a future
-- application-side payload bug (the exact class of bug that caused
-- this incident) can no longer desynchronize the two columns.
--
-- project-scoping: both the DELETE and the INSERT operate only on
-- `p_project_id`, the function's own parameter — never on any
-- project_id embedded in the JSONB payload. A payload cannot write or
-- delete rows for a project other than the one explicitly named by
-- the caller.
--
-- Existing grants on `public.competitors` (SELECT/INSERT/UPDATE/DELETE
-- to service_role and authenticated, SELECT to anon — migration 0010)
-- are left completely untouched by this migration. RLS on
-- `competitors` (enabled, no policies, NO FORCE — migration 0011) is
-- also untouched; SECURITY DEFINER functions in this codebase have
-- never altered RLS on their target tables (see 0039, 0042), and this
-- one does not either. The FK, CHECK, and index added by migration
-- 0045 are not modified in any way — they still apply to every row
-- this function inserts, exactly as before.
--
-- What this migration does NOT do:
--   * Does not backfill or otherwise write to any existing row.
--   * Does not revoke or narrow any existing grant on `competitors`.
--   * Does not change RLS, does not add or remove any policy.
--   * Does not modify migrations 0001-0045 in any way.
--   * Does not apply to, or connect to, any staging or production
--     database — this file is created locally only.

create or replace function
  public.replace_competitors_for_project(
    p_project_id uuid,
    p_competitors jsonb
  )
returns setof public.competitors
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  if p_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_replace_competitors_project_id';
  end if;

  if p_competitors is null or jsonb_typeof(p_competitors) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'invalid_replace_competitors_shape';
  end if;

  -- Both statements below run inside this one function invocation —
  -- one implicit transaction. An exception raised by the INSERT
  -- (constraint violation of any kind) is never caught here, so it
  -- rolls back the DELETE above too.
  delete from public.competitors
   where project_id = p_project_id;

  if jsonb_array_length(p_competitors) > 0 then
    insert into public.competitors (
      project_id,
      name,
      website,
      discovery_source,
      mention_count,
      prompt_ids,
      threat_level,
      confidence,
      is_phantom,
      is_blind_spot,
      canonical_entity_id,
      canonical_entity_type
    )
    select
      p_project_id,
      elem ->> 'name',
      elem ->> 'website',
      elem ->> 'discoverySource',
      (elem ->> 'mentionCount')::integer,
      coalesce(elem -> 'promptIds', '[]'::jsonb),
      elem ->> 'threatLevel',
      elem ->> 'confidence',
      (elem ->> 'isPhantom')::boolean,
      (elem ->> 'isBlindSpot')::boolean,
      nullif(elem ->> 'canonicalEntityId', '')::uuid,
      case
        when nullif(elem ->> 'canonicalEntityId', '') is not null
          then 'competitor'
        else null
      end
      from jsonb_array_elements(p_competitors) as elem;
  end if;

  return query
    select *
      from public.competitors
     where project_id = p_project_id;
end;
$$;

revoke all on function
  public.replace_competitors_for_project(uuid, jsonb)
from public;
revoke all on function
  public.replace_competitors_for_project(uuid, jsonb)
from anon;
revoke all on function
  public.replace_competitors_for_project(uuid, jsonb)
from authenticated;
grant execute on function
  public.replace_competitors_for_project(uuid, jsonb)
to service_role;
