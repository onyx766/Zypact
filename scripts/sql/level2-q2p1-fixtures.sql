-- Level 2 only: test fixtures for Q2′-1 (scripts/test-snapshot-worker-postgres-level2.sh).
-- Created in the disposable database after every migration has been applied,
-- and discarded with the container. Never part of a migration (QS-19).
--
--   level2_fixture.probe_member(ws)        the customer-path probe of §3b: a
--                                          SECURITY DEFINER function that calls F6,
--                                          executable by authenticated only.
--   level2_fixture.*_weak                  deliberately weakened copies, each derived
--                                          from the real function's own definition by
--                                          one textual change, used only to prove that
--                                          the corresponding test fails without the
--                                          property it checks.

create schema level2_fixture;
grant usage on schema level2_fixture to authenticated;

create function level2_fixture.probe_member(p_workspace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_current_account_member(p_workspace_id);
  return true;
end;
$$;
revoke all on function level2_fixture.probe_member(uuid) from public;
grant execute on function level2_fixture.probe_member(uuid) to authenticated;

-- Weakened F6 (QR-32): the same function without FOR SHARE.
do $w$
declare v text;
begin
  v := pg_get_functiondef('public.assert_current_account_member(uuid)'::regprocedure);
  if strpos(v, E'\n   for share;') = 0 then raise exception 'weak F6: anchor missing'; end if;
  v := replace(v, E'\n   for share;', ';');
  v := replace(v, 'FUNCTION public.assert_current_account_member(', 'FUNCTION level2_fixture.assert_member_no_share(');
  execute v;
end;
$w$;

-- Weakened F6 (QR-09): the same function ignoring removal.
do $w$
declare v text;
begin
  v := pg_get_functiondef('public.assert_current_account_member(uuid)'::regprocedure);
  if strpos(v, E'\n     and m.removed_at is null') = 0 then raise exception 'weak F6: removal anchor missing'; end if;
  v := replace(v, E'\n     and m.removed_at is null', '');
  v := replace(v, 'FUNCTION public.assert_current_account_member(', 'FUNCTION level2_fixture.assert_member_ignores_removal(');
  execute v;
end;
$w$;

-- Weakened F6 (QR-08 / QR-27): trusts a caller-supplied account id instead of the claims.
create function level2_fixture.assert_member_trusting_param(p_workspace_id uuid, p_account_id uuid)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.account_id = p_account_id and m.removed_at is null;
$$;

create function level2_fixture.probe_member_no_share(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform level2_fixture.assert_member_no_share(p_workspace_id);
  return true;
end;
$$;
create function level2_fixture.probe_member_ignores_removal(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform level2_fixture.assert_member_ignores_removal(p_workspace_id);
  return true;
end;
$$;
create function level2_fixture.probe_member_trusting_param(p_workspace_id uuid, p_account_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if level2_fixture.assert_member_trusting_param(p_workspace_id, p_account_id) is null then
    raise exception using errcode = '42501', message = 'q2p_not_authorised';
  end if;
  return true;
end;
$$;
revoke all on function level2_fixture.probe_member_no_share(uuid) from public;
revoke all on function level2_fixture.probe_member_ignores_removal(uuid) from public;
revoke all on function level2_fixture.probe_member_trusting_param(uuid, uuid) from public;
grant execute on function level2_fixture.probe_member_no_share(uuid) to authenticated;
grant execute on function level2_fixture.probe_member_ignores_removal(uuid) to authenticated;
grant execute on function level2_fixture.probe_member_trusting_param(uuid, uuid) to authenticated;

-- Weakened F8 (QR-33): the version-row UPDATE replaced by a plain row lock on
-- the workspace (the write-skew design §3e rejects).
do $w$
declare
  v text;
  anchor constant text := E'update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then';
begin
  v := pg_get_functiondef('public.remove_workspace_member(uuid,uuid,text,uuid,text,text)'::regprocedure);
  if strpos(v, anchor) = 0 then raise exception 'weak F8: anchor missing'; end if;
  v := replace(v, anchor, E'perform 1 from public.workspaces w where w.id = p_workspace_id for update;\n  if not found then');
  v := replace(v, 'FUNCTION public.remove_workspace_member(', 'FUNCTION level2_fixture.remove_member_lock_only(');
  execute v;
end;
$w$;

-- Weakened F4 (QR-23): the research-set row lock removed.
do $w$
declare
  v text;
  anchor constant text := E'and rs.project_id = v_session.project_id\n   for update;';
begin
  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text,text,text)'::regprocedure);
  if strpos(v, anchor) = 0 then raise exception 'weak F4: anchor missing'; end if;
  v := replace(v, anchor, E'and rs.project_id = v_session.project_id;');
  v := replace(v, 'FUNCTION public.approve_buyer_question_set(', 'FUNCTION level2_fixture.approve_set_no_set_lock(');
  execute v;
end;
$w$;

-- One reviewable research set (QR-11 to QR-25): two buyer/seller sources,
-- three candidates (observed, adapted, hypothesis), an exchanged invitation
-- and a live session. Tokens are synthetic and derived from the label.
-- The email "HMAC" is a fixed stand-in hex value; the database only stores
-- and compares it (D-039: the application computes it).
create function level2_fixture.make_review(p_ws uuid, p_project uuid, p_request uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  op constant uuid := '00000000-0000-4000-8000-0000000000f0';
  txt_obs constant text := 'Which invoicing tool suits a small accounting firm?';
  exc constant text := 'Q: Which invoicing tool suits a small accounting firm? Thanks!';
  inv_token text := rpad('inv-' || p_label || '-', 48, 'x');
  ses_token text := rpad('ses-' || p_label || '-', 48, 'y');
  rs uuid; s_pub uuid; s_site uuid; c_obs uuid; c_adp uuid; c_hyp uuid; inv uuid; ses uuid;
begin
  insert into public.question_research_sets (workspace_id, project_id, snapshot_request_id, site_context, icp, actor_type, actor_operator_id)
  values (p_ws, p_project, p_request, '{"summary":"fixture"}', '{"buyers":["accounting firms"]}', 'founder', op) returning id into rs;

  insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, excerpt, excerpt_sha256,
    buyer_authored, verification, personal_data_removed, actor_type, actor_operator_id)
  values (p_ws, p_project, 'public_community', 'https://forum.example.test/t/1', now(), exc, public._q2p_sha256_hex(exc),
    true, 'public_verifiable', true, 'founder', op) returning id into s_pub;
  insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, excerpt, excerpt_sha256,
    buyer_authored, verification, personal_data_removed, actor_type, actor_operator_id)
  values (p_ws, p_project, 'site_copy', 'https://vendor.example.test/', now(), 'Acme is the fastest invoicing tool.',
    public._q2p_sha256_hex('Acme is the fastest invoicing tool.'), false, 'public_verifiable', true, 'founder', op)
  returning id into s_site;

  insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
    evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
    commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
    curator_rank, preselected, primary_source_id, actor_type, actor_operator_id)
  values (p_ws, p_project, rs, txt_obs, public._q2p_sha256_hex(lower(txt_obs)),
    'observed', 'public_verifiable', 'unbranded', 3, 'asked by buyers', 3, 'core ICP', 2, 'shortlist intent', 2, 'product fits',
    'shortlist', 'vendor_evaluation', 1, true, s_pub, 'founder', op) returning id into c_obs;
  insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
  values (c_obs, s_pub, 'verbatim', txt_obs, p_ws, p_project, 'founder', op);

  insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
    evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
    commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
    adaptation_note, curator_rank, preselected, primary_source_id, actor_type, actor_operator_id)
  values (p_ws, p_project, rs, 'What invoicing tool works for a small accounting practice?',
    public._q2p_sha256_hex('what invoicing tool works for a small accounting practice?'),
    'adapted', 'public_verifiable', 'unbranded', 2, 'close paraphrase', 2, 'adjacent ICP', 1, 'research intent', 1, 'partial fit',
    'research', 'solution', 'reworded for practices', 2, true, s_pub, 'founder', op) returning id into c_adp;
  insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
  values (c_adp, s_pub, 'paraphrase_basis', null, p_ws, p_project, 'founder', op),
         (c_adp, s_pub, 'verbatim', txt_obs, p_ws, p_project, 'founder', op),
         (c_adp, s_site, 'context', null, p_ws, p_project, 'founder', op);

  insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
    evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
    commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
    curator_rank, preselected, actor_type, actor_operator_id)
  values (p_ws, p_project, rs, 'Is there an invoicing tool built for accountants?',
    public._q2p_sha256_hex('is there an invoicing tool built for accountants?'),
    'hypothesis', null, 'unbranded', 1, 'plausible', 1, 'broad', 1, 'early', 0, 'unclear',
    'awareness', 'problem', 3, false, 'founder', op) returning id into c_hyp;

  insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id,
    email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, actor_type, actor_operator_id)
  values (p_ws, p_project, p_request, rs, public._q2p_sha256_hex('buyer@' || p_project::text), 'k1', now(),
    public._q2p_token_hash('zypact.question_review_invitation.v1', inv_token), now() + interval '7 days', now(),
    'founder', op) returning id into inv;
  insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
    token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version)
  values (inv, p_ws, p_project, p_request, rs,
    public._q2p_token_hash('zypact.question_review_session.v1', ses_token), now() + interval '30 minutes', now(),
    'system', 'invitation_exchange', 'v1') returning id into ses;

  return jsonb_build_object('rs', rs, 's_pub', s_pub, 's_site', s_site, 'c_obs', c_obs, 'c_adp', c_adp, 'c_hyp', c_hyp,
    'inv', inv, 'ses', ses, 'inv_token', inv_token, 'ses_token', ses_token,
    'hmac', public._q2p_sha256_hex('buyer@' || p_project::text));
end;
$$;

-- An extra session for an existing invitation, optionally already aged
-- (created p_age ago, last seen p_idle ago).
create function level2_fixture.make_session(p_invitation uuid, p_label text, p_age interval, p_idle interval)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.question_review_invitations%rowtype;
  tok text := rpad('ses-' || p_label || '-', 48, 'z');
begin
  select * into i from public.question_review_invitations where id = p_invitation;
  insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
    token_hash, absolute_expires_at, last_seen_at, created_at, actor_type, rule_id, rule_version)
  values (i.id, i.workspace_id, i.project_id, i.snapshot_request_id, i.research_set_id,
    public._q2p_token_hash('zypact.question_review_session.v1', tok),
    now() - p_age + interval '30 minutes', now() - p_idle, now() - p_age, 'system', 'invitation_exchange', 'v1');
  return tok;
end;
$$;

-- Fault injection for QR-21: when l2.fault = 'on', the second wording
-- classification written in the transaction raises.
create function level2_fixture.fail_second_classification()
returns trigger
language plpgsql
as $$
declare n integer;
begin
  if current_setting('l2.fault', true) = 'on' then
    n := coalesce(nullif(current_setting('l2.fault_count', true), ''), '0')::integer + 1;
    perform set_config('l2.fault_count', n::text, true);
    if n = 2 then
      raise exception using errcode = 'P0001', message = 'l2_injected_fault';
    end if;
  end if;
  return new;
end;
$$;
create trigger l2_fault_injection
  before insert on public.approved_wording_classifications
  for each row execute function level2_fixture.fail_second_classification();
