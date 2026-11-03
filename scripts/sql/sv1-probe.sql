-- SV1 only: test objects for scripts/test-q2p-supabase-stack-sv1.ts.
-- Applied by the harness to a disposable local Supabase stack after every
-- migration, and discarded with it. Never part of a migration, and never run
-- against a remote database.
--
--   sv1_probe.probe_member(ws)  the isolated internal path to F6
--                               (assert_current_account_member), which no API
--                               role may execute directly. A SECURITY DEFINER
--                               wrapper, executable by authenticated only. The
--                               harness exposes the schema sv1_probe to PostgREST
--                               in the disposable stack's config.toml only.
--                               It proves F6's binding to real Auth tokens; it
--                               is not the customer account-authorisation flow.
--   sv1_fixture.*               data builders for the F4 cases. Not exposed to
--                               PostgREST and not executable by any API role.

create schema sv1_probe;
revoke all on schema sv1_probe from public;
grant usage on schema sv1_probe to authenticated;

create function sv1_probe.probe_member(p_workspace_id uuid)
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
revoke all on function sv1_probe.probe_member(uuid) from public, anon, authenticated, service_role;
grant execute on function sv1_probe.probe_member(uuid) to authenticated;

create schema sv1_fixture;
revoke all on schema sv1_fixture from public;

-- One reviewable research set on its own snapshot request (address
-- buyer@<label>.example.com): two sources, an observed candidate quoted
-- verbatim from a buyer-authored source, an exchanged and verified invitation
-- (its request_email_binding derived by the insert trigger) and a live session.
-- The same shape as the Level 2 fixture make_review.
create function sv1_fixture.make_review(p_ws uuid, p_project uuid, p_label text)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  op constant uuid := '00000000-0000-4000-8000-0000000000f0';
  txt constant text := 'Which invoicing tool suits a small accounting firm?';
  exc constant text := 'Q: Which invoicing tool suits a small accounting firm? Thanks!';
  ses_token text := rpad('sv1-ses-' || p_label || '-', 48, 'y');
  req uuid; rs uuid; s_pub uuid; c_obs uuid; inv uuid; ses uuid;
begin
  insert into public.snapshot_requests (work_email, normalized_email, company_name, website_url, normalized_domain,
    buyer_category, project_id, status)
  values ('Buyer@' || p_label || '.example.com', 'buyer@' || p_label || '.example.com', 'SV1', 'https://sv1.example.com',
    'sv1.example.com', 'crm', p_project, 'pending_approval')
  returning id into req;

  insert into public.question_research_sets (workspace_id, project_id, snapshot_request_id, site_context, icp, actor_type, actor_operator_id)
  values (p_ws, p_project, req, '{"summary":"sv1"}', '{"buyers":["accounting firms"]}', 'founder', op) returning id into rs;

  insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, excerpt, excerpt_sha256,
    buyer_authored, verification, personal_data_removed, actor_type, actor_operator_id)
  values (p_ws, p_project, 'public_community', 'https://forum.example.com/t/1', now(), exc, public._q2p_sha256_hex(exc),
    true, 'public_verifiable', true, 'founder', op) returning id into s_pub;

  insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash,
    evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason,
    commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage,
    curator_rank, preselected, primary_source_id, actor_type, actor_operator_id)
  values (p_ws, p_project, rs, txt, public._q2p_sha256_hex(lower(txt)),
    'observed', 'public_verifiable', 'unbranded', 3, 'asked by buyers', 3, 'core ICP', 2, 'shortlist intent', 2, 'product fits',
    'shortlist', 'vendor_evaluation', 1, true, s_pub, 'founder', op) returning id into c_obs;
  insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
  values (c_obs, s_pub, 'verbatim', txt, p_ws, p_project, 'founder', op);

  insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id,
    email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, actor_type, actor_operator_id)
  values (p_ws, p_project, req, rs, public._q2p_sha256_hex('buyer@' || p_label), 'k1', now(),
    public._q2p_token_hash('zypact.question_review_invitation.v1', rpad('sv1-inv-' || p_label || '-', 48, 'x')),
    now() + interval '7 days', now(), 'founder', op) returning id into inv;
  insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id,
    token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version)
  values (inv, p_ws, p_project, req, rs,
    public._q2p_token_hash('zypact.question_review_session.v1', ses_token), now() + interval '30 minutes', now(),
    'system', 'invitation_exchange', 'v1') returning id into ses;

  return jsonb_build_object('req', req, 'rs', rs, 'c_obs', c_obs, 'inv', inv, 'ses', ses, 'ses_token', ses_token,
    'items', jsonb_build_array(jsonb_build_object('origin', 'recommended_unchanged', 'candidate_id', c_obs,
      'text', txt, 'prompt_hash', public._q2p_sha256_hex(txt))));
end;
$$;
revoke all on function sv1_fixture.make_review(uuid, uuid, text) from public, anon, authenticated, service_role;
