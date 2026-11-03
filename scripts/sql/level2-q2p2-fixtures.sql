-- Level 2 only: test fixtures for Q2′-2 (scripts/test-snapshot-worker-postgres-level2.sh).
-- Created in the disposable database after every migration has been applied,
-- and discarded with the container. Never part of a migration.
--
--   level2_q2p2.attempt(sql, keep)   runs one statement; returns 'OK' or
--                                    'SQLSTATE:message'. With keep = false the
--                                    statement's effects are always rolled back.
--   level2_q2p2.domain / challenge / ev / run   data builders
--   level2_q2p2.reach(domain, status)           drives a domain into a status
--   level2_q2p2.weak_* + use_apply / use_run_guard
--                                    deliberately weakened copies of the
--                                    Q2′-2 trigger functions, each one textual
--                                    change from the real definition, swapped
--                                    in only to prove what a guard prevents
--   level2_q2p2.capture_baseline / verify_baseline   QR2-17

create schema level2_q2p2;

create function level2_q2p2.attempt(p_sql text, p_keep boolean default false)
returns text
language plpgsql
as $$
begin
  begin
    execute p_sql;
    if not p_keep then
      raise exception using errcode = 'P0001', message = 'l2q2_rollback';
    end if;
    return 'OK';
  exception when others then
    if sqlerrm = 'l2q2_rollback' then
      return 'OK';
    end if;
    return sqlstate || ':' || sqlerrm;
  end;
end;
$$;

create function level2_q2p2.domain(p_ws uuid, p_domain text)
returns uuid
language sql
as $$
  insert into public.workspace_domains (workspace_id, normalized_domain, actor_type, actor_operator_id)
  values (p_ws, p_domain, 'founder', '00000000-0000-4000-8000-0000000000f0') returning id;
$$;

create function level2_q2p2.challenge(p_dom uuid, p_ttl interval default interval '24 hours')
returns uuid
language sql
as $$
  insert into public.workspace_domain_challenges (domain_id, workspace_id, method, challenge_sha256, expires_at,
    actor_type, actor_operator_id)
  select d.id, d.workspace_id, 'dns_txt', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
         clock_timestamp() + p_ttl, 'founder', '00000000-0000-4000-8000-0000000000f0'
    from public.workspace_domains d where d.id = p_dom
  returning id;
$$;

-- The SQL that appends one event; seq defaults to the state's next number.
create function level2_q2p2.ev_sql(p_dom uuid, p_event text, p_challenge uuid default null,
                                   p_checked_at timestamptz default null, p_seq bigint default null)
returns text
language plpgsql
as $$
declare
  v_ws uuid;
  v_seq bigint;
begin
  select s.workspace_id, coalesce(p_seq, s.seq + 1) into v_ws, v_seq from public.workspace_domain_state s where s.domain_id = p_dom;
  return format(
    'insert into public.workspace_domain_verification_events (domain_id, workspace_id, seq, event, challenge_id, checked_at, evidence_sha256, actor_type, rule_id, rule_version) values (%L, %L, %s, %L, %L, %L, %L, %L, %L, %L)',
    p_dom, v_ws, v_seq, p_event, p_challenge,
    case when p_event in ('verification_succeeded', 'verification_failed', 'verification_lost')
         then coalesce(p_checked_at, clock_timestamp()) end,
    case when p_event in ('verification_succeeded', 'verification_failed') then repeat('e', 64) end,
    'system', 'l2_v1d_check', 'v1');
end;
$$;

create function level2_q2p2.ev(p_dom uuid, p_event text, p_challenge uuid default null,
                               p_checked_at timestamptz default null, p_seq bigint default null, p_keep boolean default true)
returns text
language sql
as $$ select level2_q2p2.attempt(level2_q2p2.ev_sql(p_dom, p_event, p_challenge, p_checked_at, p_seq), p_keep); $$;

create function level2_q2p2.status(p_dom uuid)
returns text
language sql
as $$ select status || '/' || seq from public.workspace_domain_state where domain_id = p_dom; $$;

create function level2_q2p2.current_challenge(p_dom uuid)
returns uuid
language sql
as $$ select current_challenge_id from public.workspace_domain_state where domain_id = p_dom; $$;

-- Drives a fresh domain into a status: none, pending, verified, unverified, revoked.
create function level2_q2p2.reach(p_ws uuid, p_domain text, p_status text)
returns uuid
language plpgsql
as $$
declare
  d uuid := level2_q2p2.domain(p_ws, p_domain);
  c uuid;
  r text;
begin
  if p_status = 'none' then return d; end if;
  c := level2_q2p2.challenge(d);
  r := level2_q2p2.ev(d, 'challenge_issued', c);
  if p_status = 'revoked' then r := level2_q2p2.ev(d, 'revoked'); end if;
  if p_status in ('verified', 'unverified') then r := level2_q2p2.ev(d, 'verification_succeeded', c); end if;
  if p_status = 'unverified' then r := level2_q2p2.ev(d, 'verification_lost'); end if;
  if level2_q2p2.status(d) not like p_status || '/%' then
    raise exception 'reach % failed: %', p_status, level2_q2p2.status(d);
  end if;
  return d;
end;
$$;

-- One event attempt per (status, event), rolled back: 'OK', or the refusal message.
create function level2_q2p2.matrix_row(p_ws uuid, p_label text, p_status text)
returns text
language plpgsql
as $$
declare
  ev text;
  out text := '';
  d uuid;
  c uuid;
  r text;
begin
  foreach ev in array array['challenge_issued', 'verification_succeeded', 'verification_failed',
                            'challenge_expired', 'verification_lost', 'revoked'] loop
    d := level2_q2p2.reach(p_ws, p_label || '-' || replace(ev, '_', '-') || '.example.com', p_status);
    c := case when ev = 'challenge_issued' then level2_q2p2.challenge(d)
              else coalesce(level2_q2p2.current_challenge(d), level2_q2p2.challenge(d)) end;
    r := level2_q2p2.ev(d, ev, case when ev in ('verification_lost', 'revoked') then null else c end, null, null, false);
    out := out || ev || '=' || case when r = 'OK' then 'OK' else split_part(r, ':', 2) end || ' ';
  end loop;
  return btrim(out);
end;
$$;

create function level2_q2p2.run(p_ws uuid, p_project uuid, p_domain text, p_dom uuid default null,
                                p_event uuid default null, p_cap int default 10, p_supersedes uuid default null)
returns uuid
language sql
as $$
  insert into public.site_diagnostic_runs (workspace_id, project_id, normalized_domain, start_url, rule_set_version,
    crawler_version, user_agent, page_cap, supersedes_run_id, domain_id, domain_verification_event_id,
    cache_scope_workspace_id, actor_type, actor_operator_id)
  values (p_ws, p_project, p_domain, 'https://' || p_domain || '/', 'w1.l2', 'crawler.l2',
    'ZypactBot/l2 (+https://zypact.com/bot)', p_cap, p_supersedes, p_dom, p_event, p_ws,
    'founder', '00000000-0000-4000-8000-0000000000f0')
  returning id;
$$;

create function level2_q2p2.page_sql(p_run uuid, p_index int, p_url text, p_bytes int default 10,
                                     p_hash text default repeat('c', 64))
returns text
language sql
as $$
  select format(
    'insert into public.site_diagnostic_pages (run_id, workspace_id, project_id, page_index, url, query_present, fetched_at, http_status, content_type, bytes, body_sha256, robots_allowed) select id, workspace_id, project_id, %s, %L, false, clock_timestamp(), 200, %L, %s, %L, true from public.site_diagnostic_runs where id = %L',
    p_index, p_url, 'text/html', p_bytes, p_hash, p_run);
$$;

-- QR2-09: is the domain verified once its re-check is overdue? The overdue
-- state is forced with triggers disabled, judged, and always rolled back.
create function level2_q2p2.overdue_probe(p_dom uuid, p_ws uuid, p_project uuid, p_domain text)
returns text
language plpgsql
as $$
declare
  v_ev uuid;
  v_helper boolean;
  v_run text;
begin
  begin
    select verified_event_id into v_ev from public.workspace_domain_state where domain_id = p_dom;
    perform set_config('session_replication_role', 'replica', true);
    update public.workspace_domain_state set recheck_due_at = clock_timestamp() - interval '1 second' where domain_id = p_dom;
    perform set_config('session_replication_role', 'origin', true);
    v_helper := public._q2p2_domain_verified(p_dom);
    v_run := level2_q2p2.attempt(format('select level2_q2p2.run(%L, %L, %L, %L, %L)', p_ws, p_project, p_domain, p_dom, v_ev));
    raise exception using errcode = 'P0001', message = 'l2q2_result:' || v_helper::text || '|' || v_run;
  exception when others then
    return replace(sqlerrm, 'l2q2_result:', '');
  end;
end;
$$;

-- Weakened copies (one textual change each) and the swaps that install them.
do $w$
declare
  v text;
  procedure_name text;
  cases constant text[][] := array[
    array['public._q2p2_apply_verification_event()',
          ' where s.domain_id = new.domain_id for update;', ' where s.domain_id = new.domain_id;', 'weak_apply_no_lock'],
    array['public._q2p2_apply_verification_event()',
          E'      if new.checked_at > v_now or new.checked_at < v_now - interval ''10 minutes'' then\n        raise exception using errcode = ''22023'', message = ''q2p2_stale_observation'';\n      end if;\n    end if;',
          '    end if;', 'weak_apply_no_stale_check'],
    array['public._q2p2_apply_verification_event()',
          E'    if st.current_challenge_id is distinct from new.challenge_id then\n      raise exception using errcode = ''22023'', message = ''q2p2_challenge_not_current'';\n    end if;\n',
          '', 'weak_apply_no_current_check'],
    array['public._q2p2_run_guard()',
          'st.verified_event_id is distinct from new.domain_verification_event_id', 'false', 'weak_run_guard_historical']
  ];
  i integer;
begin
  for i in 1 .. array_length(cases, 1) loop
    v := pg_get_functiondef(cases[i][1]::regprocedure);
    if strpos(v, cases[i][2]) = 0 then raise exception 'weak fixture %: anchor missing', cases[i][4]; end if;
    v := replace(v, cases[i][2], cases[i][3]);
    procedure_name := split_part(cases[i][1], '(', 1);
    v := replace(v, 'FUNCTION ' || procedure_name || '(', 'FUNCTION level2_q2p2.' || cases[i][4] || '(');
    execute v;
  end loop;
end;
$w$;

create function level2_q2p2.use_apply(p_fn text)
returns void
language plpgsql
as $$
begin
  execute format('create or replace trigger workspace_domain_verification_events_apply before insert on public.workspace_domain_verification_events for each row execute function %s()', p_fn);
end;
$$;

create function level2_q2p2.use_run_guard(p_fn text)
returns void
language plpgsql
as $$
begin
  execute format('create or replace trigger site_diagnostic_runs_guard before insert or update or delete on public.site_diagnostic_runs for each row execute function %s()', p_fn);
end;
$$;

-- QR2-08: pause an event AFTER its trigger has locked and advanced the state.
create function level2_q2p2.pause_after_event()
returns trigger
language plpgsql
as $$
begin
  if current_setting('l2q2.pause', true) = 'on' then
    perform pg_sleep(3);
  end if;
  return new;
end;
$$;
create trigger l2q2_pause_after_event after insert on public.workspace_domain_verification_events
  for each row execute function level2_q2p2.pause_after_event();

-- QR2-17: every row of every table that is not a Q2′-2 table, before and after.
create table level2_q2p2.row_baseline (tbl text, row_text text);
create function level2_q2p2.q2p2_tables()
returns text[]
language sql
as $$ select array['workspace_domains','workspace_domain_state','workspace_domain_challenges',
  'workspace_domain_verification_events','site_diagnostic_runs','site_diagnostic_pages',
  'site_diagnostic_findings','diagnostic_rate_limit_events']; $$;
create function level2_q2p2.capture_baseline()
returns integer
language plpgsql
as $$
declare t text; n integer := 0;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and c.relname <> all (level2_q2p2.q2p2_tables()) loop
    execute format('insert into level2_q2p2.row_baseline select %L, to_jsonb(x)::text from public.%I x', t, t);
    n := n + 1;
  end loop;
  return n;
end;
$$;
create function level2_q2p2.verify_baseline()
returns text
language plpgsql
as $$
declare t text; missing bigint := 0; m bigint; grown text[] := '{}'; now_n bigint; was_n bigint;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and c.relname <> all (level2_q2p2.q2p2_tables()) order by 1 loop
    execute format('select count(*) from level2_q2p2.row_baseline b where b.tbl = %L
                      and not exists (select 1 from public.%I x where to_jsonb(x)::text = b.row_text)', t, t) into m;
    missing := missing + m;
    execute format('select count(*) from public.%I', t) into now_n;
    select count(*) into was_n from level2_q2p2.row_baseline b where b.tbl = t;
    if now_n <> was_n then grown := grown || t; end if;
  end loop;
  return missing || '|' || array_to_string(grown, ',');
end;
$$;
