-- Level 2 only: test fixtures for S1 (scripts/test-snapshot-worker-postgres-level2.sh).
-- Created in the disposable database after every migration has been applied,
-- and discarded with the container. Never part of a migration.
--
--   level2_s1.attempt(sql)        runs one statement and always rolls it back;
--                                 returns 'OK' or 'SQLSTATE:message'
--   level2_s1.workspace(account, key)
--                                 a workspace whose first owner is `account`,
--                                 created through F1 as the founder path;
--                                 returns 'workspace_id membership_id'
--   level2_s1.raw_session(...)    inserts a session row directly, as the owner,
--                                 with chosen past instants, so expiry can be
--                                 tested without waiting
--   level2_s1.raw_rate_event(...) inserts a rate-limit row with a chosen age

create schema level2_s1;

create function level2_s1.attempt(p_sql text)
returns text
language plpgsql
as $$
begin
  begin
    execute p_sql;
    raise exception using errcode = 'P0001', message = 'l2s1_rollback';
  exception when others then
    if sqlerrm = 'l2s1_rollback' then
      return 'OK';
    end if;
    return sqlstate || ':' || sqlerrm;
  end;
end;
$$;

create function level2_s1.workspace(p_account uuid, p_key text)
returns text
language sql
as $$
  select w.workspace_id || ' ' || w.membership_id
    from public.create_workspace_with_owner(p_account, 'S1 ' || p_key, 'l2-s1-' || p_key,
                                            'founder', '00000000-0000-4000-8000-0000000000f1') w;
$$;

create function level2_s1.raw_session(
  p_account uuid, p_workspace uuid, p_member uuid, p_token text,
  p_created_ago interval, p_seen_ago interval, p_absolute_seconds integer, p_idle_seconds integer)
returns uuid
language sql
as $$
  insert into public.account_sessions (token_hash, account_id, workspace_id, membership_id,
    created_at, last_seen_at, absolute_expires_at, idle_timeout_seconds)
  values (public._q2p_token_hash('zypact.account_session.v1', p_token), p_account, p_workspace, p_member,
    clock_timestamp() - p_created_ago, clock_timestamp() - p_seen_ago,
    clock_timestamp() - p_created_ago + make_interval(secs => p_absolute_seconds), p_idle_seconds)
  returning id;
$$;

create function level2_s1.raw_rate_event(p_purpose text, p_key text, p_age interval, p_ttl interval)
returns bigint
language sql
as $$
  insert into public.account_rate_limit_events (purpose, bucket_kind, bucket_key, key_id, occurred_at, expires_at)
  values (p_purpose, 'ip', p_key, 'l2', clock_timestamp() - p_age, clock_timestamp() - p_age + p_ttl)
  returning id;
$$;
