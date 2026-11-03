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
  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)'::regprocedure);
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
-- it (D-039: the application computes it). Authorisation does not use it: the
-- insert trigger binds each invitation to the request's persisted address
-- (request_email_binding), and F4 checks that binding.
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

-- ── Remediation round (R1–R4) ──────────────────────────────────────────

-- Weakened copies, each one textual change from the real definition.
do $w$
declare
  v text;
  procedure_name text;
  cases constant text[][] := array[
    -- [source function, anchor, replacement, fixture name]
    array['public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)',
          E'\n     or v_invitation.email_verified_at is null', '', 'approve_set_no_email_check'],
    array['public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)',
          'and public._q2p_observed_span_ok(v_cand.id, v_cand.primary_source_id, v_texts[v_i], v_cand.verification) then',
          'then', 'approve_set_no_span_check'],
    array['public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)',
          E'\n                     order by u.prompt_hash)', ')', 'approve_set_ordered_fingerprint'],
    array['public.create_workspace_with_owner(uuid,text,text,text,uuid,text,text)',
          E'\n  perform pg_advisory_xact_lock(hashtextextended(''zypact.q2p.create_workspace:'' || p_idempotency_key, 0));', '',
          'create_workspace_no_key_lock'],
    array['public.add_workspace_member(uuid,uuid,text,uuid,text,text)',
          E'\n  update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then\n    raise exception using errcode = ''22023'', message = ''q2p_workspace_not_found'';\n  end if;',
          '', 'add_member_no_version_row']
  ];
  i integer;
begin
  for i in 1 .. array_length(cases, 1) loop
    v := pg_get_functiondef(cases[i][1]::regprocedure);
    if strpos(v, cases[i][2]) = 0 then raise exception 'weak fixture %: anchor missing', cases[i][4]; end if;
    v := replace(v, cases[i][2], cases[i][3]);
    procedure_name := split_part(cases[i][1], '(', 1);
    v := replace(v, 'FUNCTION ' || procedure_name || '(', 'FUNCTION level2_fixture.' || cases[i][4] || '(');
    execute v;
  end loop;
end;
$w$;

-- Runs the shared Q1 compatibility vectors (scripts/fixtures/q2p1-wording-vectors.json)
-- through the real F4: one research set, source, candidate and session per vector.
create function level2_fixture.run_vectors(p_ws uuid, p_project uuid, p_request uuid, p_doc jsonb)
returns table (id text, got text, expected text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  op constant uuid := '00000000-0000-4000-8000-0000000000f0';
  v jsonb; l jsonb;
  rs uuid; src uuid; cand uuid; inv uuid; tok text; verif text; status text; rec uuid;
begin
  for v in select * from jsonb_array_elements(p_doc -> 'vectors') loop
    insert into public.question_research_sets (workspace_id, project_id, snapshot_request_id, site_context, icp, actor_type, actor_operator_id)
    values (p_ws, p_project, p_request, '{}', '{}', 'founder', op) returning question_research_sets.id into rs;
    verif := case when v ->> 'sourceKind' = 'customer_material' then 'customer_provided' else 'public_verifiable' end;
    insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, customer_reference,
      customer_attested_at, received_at, excerpt, excerpt_sha256, buyer_authored, verification, personal_data_removed,
      actor_type, actor_operator_id)
    values (p_ws, p_project, v ->> 'sourceKind',
      case when v ->> 'sourceKind' = 'customer_material' then null else 'https://forum.example.org/s' end,
      case when v ->> 'sourceKind' = 'customer_material' then null else now() end,
      case when v ->> 'sourceKind' = 'customer_material' then 'ticket-s' end,
      case when v ->> 'sourceKind' = 'customer_material' then now() end,
      case when v ->> 'sourceKind' = 'customer_material' then now() end,
      v ->> 'excerpt', public._q2p_sha256_hex(v ->> 'excerpt'), v ->> 'sourceKind' <> 'site_copy', verif, true, 'founder', op)
    returning question_sources.id into src;
    insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
      evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
      commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
      adaptation_note, curator_rank, preselected, primary_source_id, actor_type, actor_operator_id)
    values (p_ws, p_project, rs, v ->> 'candidateText', public._q2p_sha256_hex(lower(v ->> 'candidateText')),
      v ->> 'grade', case when v ->> 'grade' = 'hypothesis' then null else verif end, 'unbranded',
      3, 'fits the stated need', 3, 'fits the stated need', 2, 'fits the stated need', 3, 'fits the stated need',
      'shortlist', 'solution',
      case when v ->> 'grade' = 'adapted' then 'reworded the complaint as a question' end, 1, true,
      case when jsonb_array_length(v -> 'links') > 0 then src end, 'founder', op)
    returning question_candidates.id into cand;
    for l in select * from jsonb_array_elements(v -> 'links') loop
      insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
      values (cand, src, l ->> 'relation', l ->> 'span', p_ws, p_project, 'founder', op);
    end loop;
    set constraints all immediate;
    set constraints all deferred;
    insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id,
      email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, actor_type, actor_operator_id)
    values (p_ws, p_project, p_request, rs, repeat('a', 64), 'k1', now(),
      public._q2p_token_hash('zypact.question_review_invitation.v1', 'vinv-' || (v ->> 'id') || repeat('x', 40)),
      now() + interval '7 days', now(), 'founder', op) returning question_review_invitations.id into inv;
    tok := 'vses-' || (v ->> 'id') || repeat('y', 40);
    insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
      token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version)
    values (inv, p_ws, p_project, p_request, rs, public._q2p_token_hash('zypact.question_review_session.v1', tok),
      now() + interval '30 minutes', now(), 'system', 'invitation_exchange', 'v1');
    select a.status, a.approval_record_id into status, rec
      from public.approve_buyer_question_set(tok, rs,
        jsonb_build_array(jsonb_build_object(
          'origin', v ->> 'origin',
          'candidate_id', case when v ->> 'origin' = 'customer_written' then null else cand end,
          'text', v ->> 'approvedText',
          'prompt_hash', public._q2p_sha256_hex(v ->> 'approvedText'))),
        'vec-' || (v ->> 'id'), 'consent-v1', repeat('c', 64)) a;
    return query
      select v ->> 'id',
             coalesce((select c.classification || '/' || coalesce(c.rule, '') || '/' || coalesce(c.verification, '')
                         from public.approved_wording_classifications c
                         join public.approval_records r on c.version_id = any(r.approved_version_ids)
                        where r.id = rec), 'status=' || coalesce(status, 'null')),
             v ->> 'db';
  end loop;
end;
$$;

-- R2: one unchanged approval of a candidate whose evidence is then tampered
-- with by p_mode. Triggers (and so foreign keys and append-only guards) are
-- bypassed with session_replication_role = replica for the tampering only;
-- CHECK constraints still apply. Returns "classification/rule/verification|winnability".
create function level2_fixture.r2_case(p_ws uuid, p_project uuid, p_request uuid, p_label text, p_mode text,
                                       p_fn text default 'public.approve_buyer_question_set')
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  op constant uuid := '00000000-0000-4000-8000-0000000000f0';
  txt constant text := 'Which invoicing tool works best for a small accounting firm?';
  exc constant text := 'Which tool? Honestly: Which invoicing tool works best for a small accounting firm?';
  kind text := case when p_mode = 'control_customer' then 'customer_material' else 'public_community' end;
  verif text := case when p_mode = 'control_customer' then 'customer_provided' else 'public_verifiable' end;
  grade text := case when p_mode in ('adapted_control', 'adapted_no_basis') then 'adapted' else 'observed' end;
  span text := case when p_mode = 'mismatched' then 'Which tool?' else txt end;
  rs uuid; src uuid; cand uuid; inv uuid; tok text := 'r2-' || p_label || repeat('q', 40);
  st text; rec uuid; out text;
begin
  insert into public.question_research_sets (workspace_id, project_id, snapshot_request_id, site_context, icp, actor_type, actor_operator_id)
  values (p_ws, p_project, p_request, '{}', '{}', 'founder', op) returning id into rs;
  insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, customer_reference,
    customer_attested_at, received_at, excerpt, excerpt_sha256, buyer_authored, verification, personal_data_removed, actor_type, actor_operator_id)
  values (p_ws, p_project, kind,
    case when kind = 'customer_material' then null else 'https://forum.example.org/r2' end,
    case when kind = 'customer_material' then null else now() end,
    case when kind = 'customer_material' then 'ticket-r2' end,
    case when kind = 'customer_material' then now() end, case when kind = 'customer_material' then now() end,
    exc, public._q2p_sha256_hex(exc), true, verif, true, 'founder', op) returning id into src;
  insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
    evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
    commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
    adaptation_note, curator_rank, preselected, primary_source_id, actor_type, actor_operator_id)
  values (p_ws, p_project, rs, txt, public._q2p_sha256_hex(lower(txt)), grade, verif, 'unbranded',
    3, 'r', 3, 'r', 2, 'r', 2, 'r', 'shortlist', 'solution',
    case when grade = 'adapted' then 'reworded' end, 1, true, src, 'founder', op) returning id into cand;
  if grade = 'adapted' then
    insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
    values (cand, src, 'paraphrase_basis', null, p_ws, p_project, 'founder', op);
  else
    insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
    values (cand, src, 'verbatim', span, p_ws, p_project, 'founder', op);
  end if;
  set constraints all immediate;
  set constraints all deferred;

  set local session_replication_role = replica;
  if p_mode = 'fabricated' then
    update public.question_sources set excerpt = 'Our month-end close takes too long.',
      excerpt_sha256 = public._q2p_sha256_hex('Our month-end close takes too long.') where id = src;
  elsif p_mode = 'not_buyer' then
    update public.question_sources set buyer_authored = false where id = src;
  elsif p_mode = 'site_copy' then
    update public.question_sources set source_kind = 'site_copy', buyer_authored = false where id = src;
  elsif p_mode = 'verification_mismatch' then
    update public.question_candidates set verification = 'customer_provided' where id = cand;
  elsif p_mode = 'adapted_no_basis' then
    delete from public.question_candidate_sources where candidate_id = cand and relation = 'paraphrase_basis';
  end if;
  set local session_replication_role = origin;

  insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id,
    email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, actor_type, actor_operator_id)
  values (p_ws, p_project, p_request, rs, repeat('a', 64), 'k1', now(),
    public._q2p_token_hash('zypact.question_review_invitation.v1', 'r2i-' || p_label || repeat('x', 40)),
    now() + interval '7 days', now(), 'founder', op) returning id into inv;
  insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
    token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version)
  values (inv, p_ws, p_project, p_request, rs, public._q2p_token_hash('zypact.question_review_session.v1', tok),
    now() + interval '30 minutes', now(), 'system', 'invitation_exchange', 'v1');

  execute format('select status, approval_record_id from %s($1, $2, $3, $4, $5, $6)', p_fn)
    into st, rec
    using tok, rs, jsonb_build_array(jsonb_build_object('origin', 'recommended_unchanged', 'candidate_id', cand,
            'text', txt, 'prompt_hash', public._q2p_sha256_hex(txt))),
          'r2-' || p_label, 'consent-v1', repeat('c', 64);
  select c.classification || '/' || coalesce(c.rule, '') || '/' || coalesce(c.verification, '') || '|' || v.winnability
    into out
    from public.approved_wording_classifications c
    join public.buyer_question_versions v on v.id = c.version_id
    join public.approval_records r on v.id = any(r.approved_version_ids)
   where r.id = rec;
  return coalesce(out, 'status=' || coalesce(st, 'null'));
end;
$$;

-- QR-39: a snapshot of every row of every table that existed before Q2′-1,
-- taken before the Q2′-1 cases run; checked again at the end.
create table level2_fixture.row_baseline (tbl text, row_text text);
create function level2_fixture.capture_baseline()
returns integer
language plpgsql
as $$
declare t text; n integer := 0;
begin
  for t in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and c.relname not in ('workspaces','workspace_members','workspace_membership_versions','workspace_projects',
                'question_research_sets','question_sources','question_candidates','question_candidate_sources',
                'question_review_invitations','question_review_sessions','approval_records',
                'buyer_question_version_origins','approved_wording_classifications','exception_items','exception_events')
  loop
    execute format('insert into level2_fixture.row_baseline select %L, to_jsonb(x)::text from public.%I x', t, t);
    n := n + 1;
  end loop;
  return n;
end;
$$;
-- "changed_or_missing|tables_with_new_rows"
create function level2_fixture.verify_baseline()
returns text
language plpgsql
as $$
declare t text; missing bigint := 0; m bigint; grown text[] := '{}'; now_n bigint; was_n bigint;
begin
  for t in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and c.relname not in ('workspaces','workspace_members','workspace_membership_versions','workspace_projects',
                'question_research_sets','question_sources','question_candidates','question_candidate_sources',
                'question_review_invitations','question_review_sessions','approval_records',
                'buyer_question_version_origins','approved_wording_classifications','exception_items','exception_events')
            order by 1
  loop
    execute format('select count(*) from level2_fixture.row_baseline b where b.tbl = %L
                      and not exists (select 1 from public.%I x where to_jsonb(x)::text = b.row_text)', t, t) into m;
    missing := missing + m;
    execute format('select count(*) from public.%I', t) into now_n;
    select count(*) into was_n from level2_fixture.row_baseline b where b.tbl = t;
    if now_n > was_n then grown := grown || t; end if;
  end loop;
  return missing || '|' || array_to_string(grown, ',');
end;
$$;

-- ── R6: invitation lock and decision-point clock ──────────────────────

-- Weakened copies of F4, one textual change each.
do $w$
declare v text;
begin
  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)'::regprocedure);
  if strpos(v, E'where i.id = v_session.invitation_id\n   for share;') = 0 then raise exception 'weak R6a: anchor missing'; end if;
  v := replace(v, E'where i.id = v_session.invitation_id\n   for share;', 'where i.id = v_session.invitation_id;');
  v := replace(v, 'FUNCTION public.approve_buyer_question_set(', 'FUNCTION level2_fixture.approve_set_no_invitation_lock(');
  execute v;

  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)'::regprocedure);
  if strpos(v, 'v_check_at := clock_timestamp();') = 0 then raise exception 'weak R6b: anchor missing'; end if;
  v := replace(v, 'v_check_at := clock_timestamp();', 'v_check_at := now();');
  v := replace(v, 'FUNCTION public.approve_buyer_question_set(', 'FUNCTION level2_fixture.approve_set_transaction_clock(');
  execute v;
end;
$w$;

-- Pause an approval AFTER its authorisation decision (its locks held): when
-- l2.pause = 'on', the first wording classification insert sleeps 3 s.
create function level2_fixture.pause_after_authorisation()
returns trigger
language plpgsql
as $$
begin
  if current_setting('l2.pause', true) = 'on' then
    perform pg_sleep(3);
  end if;
  return new;
end;
$$;
create trigger l2_pause_after_authorisation
  before insert on public.approved_wording_classifications
  for each row execute function level2_fixture.pause_after_authorisation();

-- A reviewable research set whose session and invitation expire p_in from
-- now (wall clock); the idle variant leaves the session p_idle_left before
-- its 15-minute idle limit.
create function level2_fixture.make_expiring_review(p_ws uuid, p_project uuid, p_request uuid, p_label text,
                                                    p_kind text, p_in interval)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb := level2_fixture.make_review(p_ws, p_project, p_request, p_label);
  c timestamptz := clock_timestamp();
  tok text := rpad('exp-' || p_label || '-', 48, 'e');
begin
  if p_kind = 'absolute' then
    insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
      token_hash, absolute_expires_at, last_seen_at, created_at, actor_type, rule_id, rule_version)
    select i.id, i.workspace_id, i.project_id, i.snapshot_request_id, i.research_set_id,
           public._q2p_token_hash('zypact.question_review_session.v1', tok), c + p_in, c, c, 'system', 'invitation_exchange', 'v1'
      from public.question_review_invitations i where i.id = (r ->> 'inv')::uuid;
  elsif p_kind = 'idle' then
    insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
      token_hash, absolute_expires_at, last_seen_at, created_at, actor_type, rule_id, rule_version)
    select i.id, i.workspace_id, i.project_id, i.snapshot_request_id, i.research_set_id,
           public._q2p_token_hash('zypact.question_review_session.v1', tok),
           c + interval '10 minutes', c - interval '15 minutes' + p_in, c - interval '20 minutes', 'system', 'invitation_exchange', 'v1'
      from public.question_review_invitations i where i.id = (r ->> 'inv')::uuid;
  elsif p_kind = 'invitation' then
    -- A second invitation for the same set, expiring p_in from now, with a
    -- session that expires with it (a session may not outlive its invitation).
    insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id,
      email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, created_at, actor_type, actor_operator_id)
    values (p_ws, p_project, p_request, (r ->> 'rs')::uuid, r ->> 'hmac', 'k1', c,
      public._q2p_token_hash('zypact.question_review_invitation.v1', 'expinv-' || p_label),
      c + p_in, c, c - interval '7 days' + p_in + interval '1 second', 'founder', '00000000-0000-4000-8000-0000000000f0');
    insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
      token_hash, absolute_expires_at, last_seen_at, created_at, actor_type, rule_id, rule_version)
    select i.id, i.workspace_id, i.project_id, i.snapshot_request_id, i.research_set_id,
           public._q2p_token_hash('zypact.question_review_session.v1', tok), c + p_in, c, c, 'system', 'invitation_exchange', 'v1'
      from public.question_review_invitations i
     where i.token_hash = public._q2p_token_hash('zypact.question_review_invitation.v1', 'expinv-' || p_label);
  end if;
  return r || jsonb_build_object('exp_token', tok);
end;
$$;

-- ── Email binding (QR-41 to QR-43) ─────────────────────────────────────

-- Weakened copies of F4, one textual change each.
do $w$
declare v text;
  anchor_lock constant text := E'where r.id = v_session.snapshot_request_id\n   for share;';
  anchor_check constant text := E'\n     or public._q2p_request_email_binding(v_invitation.id, v_request_email)\n          is distinct from v_invitation.request_email_binding then';
begin
  -- The request's address read without a lock.
  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)'::regprocedure);
  if strpos(v, anchor_lock) = 0 then raise exception 'weak EB-a: anchor missing'; end if;
  v := replace(v, anchor_lock, 'where r.id = v_session.snapshot_request_id;');
  v := replace(v, 'FUNCTION public.approve_buyer_question_set(', 'FUNCTION level2_fixture.approve_set_no_request_lock(');
  execute v;

  -- The binding comparison removed (as at f7ce558, F4 never compares the
  -- persisted address).
  v := pg_get_functiondef('public.approve_buyer_question_set(text,uuid,jsonb,text,text,text)'::regprocedure);
  if strpos(v, anchor_check) = 0 then raise exception 'weak EB-b: anchor missing'; end if;
  v := replace(v, anchor_check, ' then');
  v := replace(v, 'FUNCTION public.approve_buyer_question_set(', 'FUNCTION level2_fixture.approve_set_no_binding_check(');
  execute v;
end;
$w$;

-- A reviewable research set on its own snapshot request (address
-- buyer@<label>.test), so a case can change that request's address without
-- touching any other case's request.
create function level2_fixture.make_request_review(p_ws uuid, p_project uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  req uuid;
begin
  insert into public.snapshot_requests (work_email, normalized_email, company_name, website_url, normalized_domain,
    buyer_category, project_id, status)
  values ('Buyer@' || p_label || '.test', 'buyer@' || p_label || '.test', 'EB', 'https://eb.test', 'eb.test',
    'crm', p_project, 'pending_approval')
  returning id into req;
  return level2_fixture.make_review(p_ws, p_project, req, p_label) || jsonb_build_object('req', req);
end;
$$;
