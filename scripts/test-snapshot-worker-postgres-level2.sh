#!/usr/bin/env bash
set -Eeuo pipefail

# Level 2 validation for the snapshot worker claim foundation.
#
# Applies every tracked migration to a disposable PostgreSQL 16 service
# container, then proves the concurrency properties that single-threaded
# JavaScript and static SQL assertions cannot prove:
#
#   - one request cannot be claimed twice;
#   - FOR UPDATE SKIP LOCKED yields a different eligible request;
#   - an expired lease can be reclaimed;
#   - a superseded or expired token cannot renew.
#
# Concurrency is genuine: separate `docker exec ... psql` processes run at
# the same time, one holding an open transaction. Nothing here is sequential
# simulation, and no application or memory-adapter code is involved.
#
# Never prints the PostgreSQL password, a complete claim token, customer
# data, or environment values.

readonly PG_USER="zypact_level2"
readonly PG_DB="zypact_level2"

# Session A holds its lock this long; B must finish well inside it.
readonly HOLD_SECONDS=8
# B is considered "blocked" if it takes at least this long.
readonly BLOCKED_THRESHOLD_MS=4000
# Hard ceiling on any single psql invocation.
readonly PSQL_TIMEOUT=60

readonly LEASE_SECONDS=900
readonly MAX_ATTEMPTS=2

migrations_applied=0
tests_passed=0
tests_failed=0
unexpected_blocking=0
duplicate_claims=0

TMPDIR_LEVEL2="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zypact-level2-XXXXXX")"
readonly TMPDIR_LEVEL2

cleanup() {
  local status=$?
  rm -rf "${TMPDIR_LEVEL2}"
  return "${status}"
}
trap cleanup EXIT

fail_hard() {
  echo "FATAL: $*" >&2
  exit 1
}

pass() {
  tests_passed=$((tests_passed + 1))
  echo "PASS  $1"
}

fail() {
  tests_failed=$((tests_failed + 1))
  echo "FAIL  $1${2:+ — $2}"
}

assert() {
  # assert <name> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    fail "$1" "expected [$3], got [$2]"
  fi
}

# ── PostgreSQL access ────────────────────────────────────────────────────

# Scalar query. Uses the container's local socket, so no password travels
# and none is printed.
psql_q() {
  timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAqc "$1"
}

# Statement batch from stdin.
psql_stdin() {
  timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -q
}

# Query expected to fail. Prints the SQLSTATE, never the statement's data.
psql_expect_error() {
  local out
  if out="$(timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAqc "$1" 2>&1)"; then
    echo "NO_ERROR"
  else
    if grep -qiE "permission denied|must be owner|42501" <<<"${out}"; then
      echo "PERMISSION_DENIED"
    else
      echo "OTHER_ERROR"
    fi
  fi
}

# Exact SQLSTATE produced by a statement run as a given role, or NO_ERROR.
#
# `psql_expect_error` only reports an error *class*; this returns the
# five-character code, so a denial assertion cannot be satisfied by an
# unrelated failure.
#
# The result is carried out through a temp table rather than `raise notice`,
# because NOTICE is written to stderr — a first version of this helper used
# `raise notice` and discarded stderr, so every call returned an empty string
# and five denial assertions failed in CI with `got []`. This mirrors the
# `t21_probe` shape below, which is already proven against a real database.
#
# Everything runs inside a transaction that is rolled back, so a statement
# that unexpectedly succeeds cannot leave the database modified.
sqlstate_as_role() {
  # sqlstate_as_role <role> <statement>
  timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAq <<SQL | tail -n1
begin;
create temp table l2_sqlstate (s text);
grant insert on l2_sqlstate to $1;
set local role $1;
do \$do\$
declare s text := 'NO_ERROR';
begin
  begin
    $2
  exception when others then
    s := sqlstate;
  end;
  insert into l2_sqlstate values (s);
end
\$do\$;
reset role;
select s from l2_sqlstate;
rollback;
SQL
}

now_ms() { date +%s%3N; }

# Report a token as null/non-null plus a short prefix — never in full.
token_shape() {
  local t="$1"
  if [[ -z "${t}" ]]; then echo "null"; else echo "non-null(${t:0:8}…)"; fi
}

# ── Preflight ────────────────────────────────────────────────────────────

echo "── Preflight ────────────────────────────────────────────"

[[ -n "${POSTGRES_CONTAINER_ID:-}" ]] \
  || fail_hard "POSTGRES_CONTAINER_ID is empty."

running="$(docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER_ID}" 2>/dev/null || echo false)"
[[ "${running}" == "true" ]] \
  || fail_hard "Service container ${POSTGRES_CONTAINER_ID:0:12} is not running."

ready=false
for _ in $(seq 1 30); do
  if docker exec "${POSTGRES_CONTAINER_ID}" \
      pg_isready -U "${PG_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ "${ready}" == "true" ]] || fail_hard "PostgreSQL never reported ready."

echo "container : ${POSTGRES_CONTAINER_ID:0:12}"
echo "server    : $(psql_q 'show server_version;')"
echo "ready     : yes"

# ── Roles ────────────────────────────────────────────────────────────────

echo
echo "── Roles ────────────────────────────────────────────────"

psql_stdin <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  -- Supabase's real service_role holds BYPASSRLS. Creating it without that
  -- attribute made every RLS-enabled table invisible to it here, so a direct
  -- write expected to SUCCEED could silently affect zero rows and still look
  -- like a pass. Set the attribute whether the role is new or pre-existing.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  else
    alter role service_role bypassrls;
  end if;
  -- Fresh unprivileged role: inherits only PUBLIC, proving PUBLIC has no
  -- execute access on the worker RPCs.
  if not exists (select 1 from pg_roles where rolname = 'level2_plain') then
    create role level2_plain nologin;
  end if;
  -- Deliberately WITHOUT bypassrls: used only where RLS filtering itself is
  -- the property under test. Never used for RPC caller-equivalence tests.
  if not exists (select 1 from pg_roles where rolname = 'level2_rls_role') then
    create role level2_rls_role nologin nobypassrls;
  else
    alter role level2_rls_role nobypassrls;
  end if;
end;
$$;
SQL

echo "created: anon, authenticated, service_role, level2_plain, level2_rls_role"

# Role attributes are a precondition for every later assertion, so verify
# them before any test runs rather than trusting the DDL above.
assert "roles. service_role has BYPASSRLS (mirrors Supabase)" \
  "$(psql_q "select rolbypassrls::text from pg_roles where rolname='service_role';")" \
  "true"
assert "roles. level2_rls_role does NOT have BYPASSRLS" \
  "$(psql_q "select rolbypassrls::text from pg_roles where rolname='level2_rls_role';")" \
  "false"
assert "roles. level2_rls_role holds no elevated attributes" \
  "$(psql_q "select (rolsuper or rolcreatedb or rolcreaterole or rolreplication)::text
               from pg_roles where rolname='level2_rls_role';")" \
  "false"

# ── Migrations ───────────────────────────────────────────────────────────

echo
echo "── Migrations ───────────────────────────────────────────"

shopt -s nullglob
migration_files=(supabase/migrations/*.sql)
shopt -u nullglob

[[ ${#migration_files[@]} -gt 0 ]] || fail_hard "No migrations found."

# Lexical filename order. Migrations are applied verbatim — never edited or
# preprocessed to make them pass.
IFS=$'\n' migration_files=($(printf '%s\n' "${migration_files[@]}" | sort))
unset IFS

for file in "${migration_files[@]}"; do
  echo "applying: ${file}"
  if ! psql_stdin <"${file}"; then
    fail_hard "Migration failed: ${file}"
  fi
  migrations_applied=$((migrations_applied + 1))
done

echo "migrations applied: ${migrations_applied}"

[[ ${migrations_applied} -eq ${#migration_files[@]} ]] \
  || fail_hard "Applied ${migrations_applied} of ${#migration_files[@]} migrations."

# ── Catalog verification of migration 0030 ───────────────────────────────

echo
echo "── Catalog verification (0030) ──────────────────────────"

assert "0030: four worker columns exist" \
  "$(psql_q "select count(*) from information_schema.columns
             where table_schema='public' and table_name='snapshot_requests'
               and column_name in ('claimed_by','claim_token','lease_expires_at','attempt_count');")" \
  "4"

assert "0030: attempt_count is NOT NULL default 0" \
  "$(psql_q "select is_nullable||'/'||coalesce(column_default,'none')
             from information_schema.columns
             where table_schema='public' and table_name='snapshot_requests'
               and column_name='attempt_count';")" \
  "NO/0"

assert "0030: three worker constraints exist" \
  "$(psql_q "select count(*) from pg_constraint
             where conrelid='public.snapshot_requests'::regclass
               and conname in ('snapshot_requests_attempt_count_check',
                               'snapshot_requests_claimed_by_length_check',
                               'snapshot_requests_claim_coherence_check');")" \
  "3"

assert "0030: partial stale-lease index exists" \
  "$(psql_q "select count(*) from pg_indexes
             where schemaname='public' and indexname='snapshot_requests_stale_lease_idx'
               and indexdef ilike '%where%status%running%claim_token is not null%';")" \
  "1"

assert "0030: four functions exist" \
  "$(psql_q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname in
               ('_ensure_snapshot_request_project','reserve_snapshot_request_project',
                'claim_next_snapshot_request','renew_snapshot_request_lease');")" \
  "4"

assert "0030: reserve RPC replaced (refuses worker-owned running)" \
  "$(psql_q "select case when prosrc ilike '%claim_token is not null%' then 'yes' else 'no' end
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='reserve_snapshot_request_project';")" \
  "yes"

assert "0030: claim RPC uses FOR UPDATE SKIP LOCKED" \
  "$(psql_q "select case when prosrc ilike '%skip locked%' then 'yes' else 'no' end
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='claim_next_snapshot_request';")" \
  "yes"

assert "0030: every worker function is SECURITY DEFINER" \
  "$(psql_q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.prosecdef
               and p.proname in ('_ensure_snapshot_request_project',
                                 'reserve_snapshot_request_project',
                                 'claim_next_snapshot_request',
                                 'renew_snapshot_request_lease');")" \
  "4"

assert "0030: service_role holds EXECUTE on claim and renew" \
  "$(psql_q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public'
               and p.proname in ('claim_next_snapshot_request','renew_snapshot_request_lease')
               and has_function_privilege('service_role', p.oid, 'EXECUTE');")" \
  "2"

assert "0030: helper is NOT executable by service_role (catalog)" \
  "$(psql_q "select has_function_privilege('service_role',
               'public._ensure_snapshot_request_project(uuid)', 'EXECUTE');")" \
  "f"

# ── Synthetic fixtures ───────────────────────────────────────────────────

echo
echo "── Fixtures ─────────────────────────────────────────────"

# Every value is synthetic: generated UUIDs, example.invalid domains, and
# non-routable addresses. No customer, Production, or Preview data.
seed_queued() {
  # seed_queued <label> <age_minutes>
  psql_q "insert into public.snapshot_requests
            (work_email, normalized_email, company_name, website_url,
             normalized_domain, buyer_category, status,
             approved_at, approved_by, created_at)
          values
            ('l2-$1@example.invalid', 'l2-$1@example.invalid',
             'Level2 $1', 'https://$1.example.invalid',
             '$1.example.invalid', 'B2B SaaS testing', 'queued',
             now(), gen_random_uuid(), now() - make_interval(mins => $2))
          returning id;"
}

echo "seeded synthetic requests using example.invalid domains only"

# ── Test 1 — one request cannot be claimed twice ─────────────────────────

echo
echo "── Test 1: one request cannot be claimed twice ──────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
r1="$(seed_queued "t1-only" 10)"

# Session A: claim inside an open transaction, then hold the row lock.
timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
  psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAqc "
    begin;
    select id from public.claim_next_snapshot_request('worker-A:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});
    select pg_sleep(${HOLD_SECONDS});
    commit;" > "${TMPDIR_LEVEL2}/a1.out" 2>"${TMPDIR_LEVEL2}/a1.err" &
a1_pid=$!

sleep 2  # let A acquire its lock

b1_start="$(now_ms)"
b1_rows="$(psql_q "select count(*) from public.claim_next_snapshot_request('worker-B:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});")"
b1_end="$(now_ms)"
b1_ms=$((b1_end - b1_start))

wait "${a1_pid}" || fail_hard "Session A failed in Test 1."
a1_id="$(head -n1 "${TMPDIR_LEVEL2}/a1.out" | tr -d '[:space:]')"

echo "session A claimed : $([[ "${a1_id}" == "${r1}" ]] && echo 'the request' || echo 'nothing')"
echo "session B rows    : ${b1_rows} (elapsed ${b1_ms} ms)"

assert "1a. A receives the request" "${a1_id}" "${r1}"
assert "1b. B receives zero rows while A holds the lock" "${b1_rows}" "0"

if [[ ${b1_ms} -ge ${BLOCKED_THRESHOLD_MS} ]]; then
  unexpected_blocking=$((unexpected_blocking + 1))
  fail "1c. B returns promptly (did not wait on A)" "took ${b1_ms} ms"
else
  pass "1c. B returns promptly (did not wait on A)"
fi

if [[ "${b1_rows}" != "0" ]]; then
  duplicate_claims=$((duplicate_claims + 1))
fi

assert "1d. exactly one project for the request" \
  "$(psql_q "select count(*) from public.projects p
             join public.snapshot_requests s on s.project_id = p.id where s.id='${r1}';")" "1"
assert "1e. attempt_count is 1" \
  "$(psql_q "select attempt_count from public.snapshot_requests where id='${r1}';")" "1"
assert "1f. exactly one non-null claim token" \
  "$(psql_q "select count(*) from public.snapshot_requests where id='${r1}' and claim_token is not null;")" "1"

# ── Test 2 — SKIP LOCKED claims another request ──────────────────────────

echo
echo "── Test 2: SKIP LOCKED claims another request ───────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
r2_old="$(seed_queued "t2-old" 60)"
r2_new="$(seed_queued "t2-new" 10)"

timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
  psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAqc "
    begin;
    select id from public.claim_next_snapshot_request('worker-A2:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});
    select pg_sleep(${HOLD_SECONDS});
    commit;" > "${TMPDIR_LEVEL2}/a2.out" 2>"${TMPDIR_LEVEL2}/a2.err" &
a2_pid=$!

sleep 2

b2_start="$(now_ms)"
b2_id="$(psql_q "select id from public.claim_next_snapshot_request('worker-B2:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" | tr -d '[:space:]')"
b2_end="$(now_ms)"
b2_ms=$((b2_end - b2_start))

wait "${a2_pid}" || fail_hard "Session A failed in Test 2."
a2_id="$(head -n1 "${TMPDIR_LEVEL2}/a2.out" | tr -d '[:space:]')"

echo "A claimed oldest  : $([[ "${a2_id}" == "${r2_old}" ]] && echo yes || echo no)"
echo "B claimed other   : $([[ "${b2_id}" == "${r2_new}" ]] && echo yes || echo no) (elapsed ${b2_ms} ms)"

assert "2a. A claims the oldest request" "${a2_id}" "${r2_old}"
assert "2b. B claims the other request"  "${b2_id}" "${r2_new}"
assert "2c. request IDs differ" "$([[ "${a2_id}" != "${b2_id}" ]] && echo yes || echo no)" "yes"

# Bounded observation: B finished long before A's sleep elapsed.
if [[ ${b2_ms} -ge ${BLOCKED_THRESHOLD_MS} ]]; then
  unexpected_blocking=$((unexpected_blocking + 1))
  fail "2d. B did not wait for A to commit" "took ${b2_ms} ms of A's ${HOLD_SECONDS}s hold"
else
  pass "2d. B did not wait for A to commit (${b2_ms} ms < ${HOLD_SECONDS}s hold)"
fi

tok_a="$(psql_q "select coalesce(claim_token::text,'') from public.snapshot_requests where id='${a2_id}';")"
tok_b="$(psql_q "select coalesce(claim_token::text,'') from public.snapshot_requests where id='${b2_id}';")"
echo "A token           : $(token_shape "${tok_a}")"
echo "B token           : $(token_shape "${tok_b}")"

assert "2e. both tokens are non-null" \
  "$([[ -n "${tok_a}" && -n "${tok_b}" ]] && echo yes || echo no)" "yes"
assert "2f. tokens differ" \
  "$([[ "${tok_a}" != "${tok_b}" ]] && echo yes || echo no)" "yes"

# ── Test 3 — expired lease reclaim ───────────────────────────────────────

echo
echo "── Test 3: expired lease reclaim ────────────────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
r3="$(seed_queued "t3" 30)"
psql_q "select 1 from public.claim_next_snapshot_request('worker-first:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" >/dev/null

# Advance the scan far enough that progress preservation is observable.
psql_q "update public.snapshot_requests
           set progress_stage='checking_ai_visibility', lease_expires_at = now() - interval '1 minute'
         where id='${r3}';" >/dev/null

before3="$(psql_q "select project_id||'|'||progress_stage||'|'||attempt_count||'|'||claimed_by||'|'||claim_token||'|'||extract(epoch from lease_expires_at)::bigint
                   from public.snapshot_requests where id='${r3}';")"
IFS='|' read -r p3 g3 n3 w3 t3 e3 <<<"${before3}"

reclaimed="$(psql_q "select id from public.claim_next_snapshot_request('worker-second:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" | tr -d '[:space:]')"

after3="$(psql_q "select project_id||'|'||progress_stage||'|'||attempt_count||'|'||claimed_by||'|'||claim_token||'|'||extract(epoch from lease_expires_at)::bigint
                  from public.snapshot_requests where id='${r3}';")"
IFS='|' read -r p3b g3b n3b w3b t3b e3b <<<"${after3}"

echo "old token         : $(token_shape "${t3}")"
echo "new token         : $(token_shape "${t3b}")"

assert "3a. same request returned"      "${reclaimed}" "${r3}"
assert "3b. project ID preserved"       "${p3b}" "${p3}"
assert "3c. progress stage preserved"   "${g3b}" "checking_ai_visibility"
assert "3d. attempt count increments"   "${n3b}" "$((n3 + 1))"
assert "3e. claimed_by changes"         "$([[ "${w3b}" != "${w3}" ]] && echo yes || echo no)" "yes"
assert "3f. claim token changes"        "$([[ "${t3b}" != "${t3}" ]] && echo yes || echo no)" "yes"
assert "3g. lease expiry advances"      "$([[ ${e3b} -gt ${e3} ]] && echo yes || echo no)" "yes"

# ── Test 4 — old-token renewal rejected after reclaim ────────────────────

echo
echo "── Test 4: old-token renewal rejected after reclaim ─────"

assert "4a. old token renewal returns zero rows" \
  "$(psql_q "select count(*) from public.renew_snapshot_request_lease('${r3}','${t3}',${LEASE_SECONDS});")" "0"

e4_before="$(psql_q "select extract(epoch from lease_expires_at)::bigint from public.snapshot_requests where id='${r3}';")"
sleep 1
assert "4b. current token renewal returns one row" \
  "$(psql_q "select count(*) from public.renew_snapshot_request_lease('${r3}','${t3b}',${LEASE_SECONDS});")" "1"

after4="$(psql_q "select claim_token||'|'||attempt_count||'|'||extract(epoch from lease_expires_at)::bigint
                  from public.snapshot_requests where id='${r3}';")"
IFS='|' read -r t4 n4 e4 <<<"${after4}"

assert "4c. token unchanged by renewal"        "$([[ "${t4}" == "${t3b}" ]] && echo yes || echo no)" "yes"
assert "4d. attempt count unchanged"           "${n4}" "${n3b}"
assert "4e. lease expiry advances"             "$([[ ${e4} -gt ${e4_before} ]] && echo yes || echo no)" "yes"

# ── Test 5 — expired current token cannot revive itself ──────────────────

echo
echo "── Test 5: expired current token cannot revive itself ───"

psql_q "update public.snapshot_requests set lease_expires_at = now() - interval '1 minute' where id='${r3}';" >/dev/null
e5_before="$(psql_q "select extract(epoch from lease_expires_at)::bigint from public.snapshot_requests where id='${r3}';")"

assert "5a. renewal with matching but expired token returns zero rows" \
  "$(psql_q "select count(*) from public.renew_snapshot_request_lease('${r3}','${t3b}',${LEASE_SECONDS});")" "0"

e5_after="$(psql_q "select extract(epoch from lease_expires_at)::bigint from public.snapshot_requests where id='${r3}';")"
assert "5b. lease was not revived" "${e5_after}" "${e5_before}"

# ── Test 6 — maximum-attempt terminalization ─────────────────────────────

echo
echo "── Test 6: maximum-attempt terminalization ──────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
r6_stale="$(seed_queued "t6-stale" 90)"
psql_q "select 1 from public.claim_next_snapshot_request('worker-x:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" >/dev/null
psql_q "update public.snapshot_requests
           set progress_stage='building_diagnosis',
               attempt_count=${MAX_ATTEMPTS},
               lease_expires_at = now() - interval '5 minutes'
         where id='${r6_stale}';" >/dev/null
p6="$(psql_q "select project_id from public.snapshot_requests where id='${r6_stale}';")"

r6_queued="$(seed_queued "t6-queued" 5)"

claimed6="$(psql_q "select id from public.claim_next_snapshot_request('worker-y:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" | tr -d '[:space:]')"

# The claim token is reduced to its shape in SQL, so the raw value never
# reaches a shell variable and cannot appear in an assertion failure message.
stale6="$(psql_q "select status||'|'||coalesce(project_id::text,'')||'|'||coalesce(progress_stage,'')||'|'||attempt_count||'|'||coalesce(claimed_by,'NULL')||'|'||case when claim_token is null then 'null' else 'non-null' end||'|'||coalesce(lease_expires_at::text,'NULL')
                  from public.snapshot_requests where id='${r6_stale}';")"
IFS='|' read -r s6 sp6 sg6 sn6 sw6 st6 sl6 <<<"${stale6}"

assert "6a. exhausted request becomes failed" "${s6}" "failed"
assert "6b. project ID preserved"             "${sp6}" "${p6}"
assert "6c. progress stage preserved"         "${sg6}" "building_diagnosis"
assert "6d. attempt count preserved"          "${sn6}" "${MAX_ATTEMPTS}"
assert "6e. claimed_by cleared"               "${sw6}" "NULL"
assert "6f. claim_token cleared"              "${st6}" "null"
assert "6g. lease_expires_at cleared"         "${sl6}" "NULL"
assert "6h. queued request claimed in the same call" "${claimed6}" "${r6_queued}"

# ── Test 7 — manual reservation protection ───────────────────────────────

echo
echo "── Test 7: manual reservation protection ────────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
r7="$(seed_queued "t7-manual" 20)"

assert "7a. manual RPC reserves a queued request" \
  "$(psql_q "select count(*) from public.reserve_snapshot_request_project('${r7}');")" "1"
assert "7b. reserved request is running/reserved with no worker ownership" \
  "$(psql_q "select status||'/'||progress_stage||'/'||
             case when claimed_by is null and claim_token is null and lease_expires_at is null
                  then 'unowned' else 'owned' end
             from public.snapshot_requests where id='${r7}';")" \
  "running/reserved/unowned"
assert "7c. manual RPC is idempotent for a manually running request" \
  "$(psql_q "select count(*) from public.reserve_snapshot_request_project('${r7}');")" "1"

r7w="$(seed_queued "t7-worker" 20)"
psql_q "select 1 from public.claim_next_snapshot_request('worker-z:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" >/dev/null

assert "7d. manual RPC returns zero rows for a worker-owned running request" \
  "$(psql_q "select count(*) from public.reserve_snapshot_request_project('${r7w}');")" "0"

# ── Test 8 — SQL privileges ──────────────────────────────────────────────

echo
echo "── Test 8: SQL privileges ───────────────────────────────"

# Real SET ROLE calls. Expected permission failures are captured, not
# treated as harness crashes.
for role in level2_plain anon authenticated; do
  assert "8. ${role} cannot execute claim" \
    "$(psql_expect_error "set role ${role}; select public.claim_next_snapshot_request('w',${LEASE_SECONDS},${MAX_ATTEMPTS});")" \
    "PERMISSION_DENIED"
  assert "8. ${role} cannot execute renew" \
    "$(psql_expect_error "set role ${role}; select public.renew_snapshot_request_lease(gen_random_uuid(),gen_random_uuid(),${LEASE_SECONDS});")" \
    "PERMISSION_DENIED"
done

assert "8. service_role CAN execute claim" \
  "$(psql_q "set role service_role; select count(*) >= 0 from public.claim_next_snapshot_request('w-svc',${LEASE_SECONDS},${MAX_ATTEMPTS});" | tail -n1)" \
  "t"
assert "8. service_role CAN execute renew" \
  "$(psql_q "set role service_role; select count(*) >= 0 from public.renew_snapshot_request_lease(gen_random_uuid(),gen_random_uuid(),${LEASE_SECONDS});" | tail -n1)" \
  "t"
assert "8. service_role CANNOT execute the internal helper" \
  "$(psql_expect_error "set role service_role; select public._ensure_snapshot_request_project(gen_random_uuid());")" \
  "PERMISSION_DENIED"

# ═════════════════════════════════════════════════════════════════════════
#  Migration 0031 — token-fenced writes
# ═════════════════════════════════════════════════════════════════════════

readonly MD_FULL='# Full report'
readonly MD_SHORT='# Short report'

# Claim a fresh request and echo "<request_id>|<project_id>|<claim_token>".
claim_fresh() {
  local label="$1"
  local id
  id="$(seed_queued "${label}" 10)"
  psql_q "select id||'|'||project_id||'|'||claim_token
            from public.claim_next_snapshot_request('w-${label}:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});"
}

# Insert an artifact directly, bypassing the RPCs. Legitimate here: 0031
# does not revoke table DML, and these fixtures set up states the RPCs
# deliberately refuse to create.
seed_artifact() {
  # seed_artifact <request_id> <project_id> <delivered: yes|no>
  psql_q "insert into public.snapshot_report_artifacts
            (snapshot_request_id, project_id, full_report_markdown,
             short_report_markdown, full_report_filename,
             short_report_filename, generated_at, public_token,
             delivered_at, delivery_message_id)
          values ('$1','$2','seeded full','seeded short','f.md','s.md', now(),
                  public._generate_snapshot_public_token(),
                  $([[ "$3" == "yes" ]] && echo "now()" || echo "null"),
                  $([[ "$3" == "yes" ]] && echo "'seeded-message-id'" || echo "null"))
          returning id;" >/dev/null
}

artifact_field() {
  psql_q "select coalesce($2::text,'NULL') from public.snapshot_report_artifacts
           where snapshot_request_id='$1';"
}

# Stable identity for a public token without ever holding or printing the
# token itself. Assertion failures show digests, never tokens.
artifact_token_id() {
  psql_q "select coalesce(md5(public_token),'NONE')
            from public.snapshot_report_artifacts
           where snapshot_request_id='$1';"
}

request_field() {
  psql_q "select coalesce($2::text,'NULL') from public.snapshot_requests where id='$1';"
}

# ── Test 9 — worker progress fencing ─────────────────────────────────────

echo
echo "── Test 9: worker progress fencing ──────────────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
IFS='|' read -r w9 p9 t9 <<<"$(claim_fresh "t9")"

assert "9a. correct active token advances progress" \
  "$(psql_q "select progress_stage from public.update_snapshot_request_progress_worker('${w9}','${p9}','${t9}','crawling');")" \
  "crawling"
assert "9b. wrong token cannot advance progress" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress_worker('${w9}','${p9}',gen_random_uuid(),'analyzing_site');")" \
  "0"
assert "9c. worker progress does not renew the lease" \
  "$(psql_q "select case when lease_expires_at = (select lease_expires_at from public.snapshot_requests where id='${w9}') then 'unchanged' else 'changed' end
             from public.snapshot_requests where id='${w9}';")" \
  "unchanged"

psql_q "update public.snapshot_requests set lease_expires_at = now() - interval '1 minute' where id='${w9}';" >/dev/null
assert "9d. expired token cannot advance progress" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress_worker('${w9}','${p9}','${t9}','analyzing_site');")" \
  "0"

t9b="$(psql_q "select claim_token from public.claim_next_snapshot_request('w-t9b:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});")"
assert "9e. old token cannot advance after reclaim" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress_worker('${w9}','${p9}','${t9}','analyzing_site');")" \
  "0"
assert "9f. new token can advance after reclaim" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress_worker('${w9}','${p9}','${t9b}','analyzing_site');")" \
  "1"
assert "9g. worker-owned request cannot use the manual progress path" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress('${w9}','${p9}','building_diagnosis');")" \
  "0"
assert "9h. worker-owned request cannot use manual finalization" \
  "$(psql_q "select count(*) from public.finalize_snapshot_request('${w9}','${p9}','failed');")" \
  "0"

# ── Test 10 — manual-owned request rejects worker paths ──────────────────

echo
echo "── Test 10: manual-owned request rejects worker paths ───"

psql_q "delete from public.snapshot_requests;" >/dev/null
m10="$(seed_queued "t10" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${m10}');" >/dev/null
p10="$(request_field "${m10}" project_id)"

assert "10a. manual reserve leaves ownership fields null" \
  "$(request_field "${m10}" claim_token)" "NULL"
assert "10b. manual-owned request rejects worker progress" \
  "$(psql_q "select count(*) from public.update_snapshot_request_progress_worker('${m10}','${p10}',gen_random_uuid(),'crawling');")" \
  "0"
assert "10c. manual-owned request rejects worker completion" \
  "$(psql_q "select count(*) from public.complete_snapshot_report_worker('${m10}','${p10}',gen_random_uuid(),'${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "0"
assert "10d. manual-owned request rejects worker failure" \
  "$(psql_q "select count(*) from public.mark_snapshot_request_failed_worker('${m10}','${p10}',gen_random_uuid());")" \
  "0"
assert "10e. manual progress path still works" \
  "$(psql_q "select progress_stage from public.update_snapshot_request_progress('${m10}','${p10}','crawling');")" \
  "crawling"

# ── Test 11 — atomic worker completion ───────────────────────────────────

echo
echo "── Test 11: atomic worker completion ────────────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
IFS='|' read -r w11 p11 t11 <<<"$(claim_fresh "t11")"
before11="$(request_field "${w11}" attempt_count)"

assert "11a. completion returns the artifact" \
  "$(psql_q "select count(*) from public.complete_snapshot_report_worker('${w11}','${p11}','${t11}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "1"
assert "11b. request became report_ready/quality_review in the same call" \
  "$(psql_q "select status||'/'||progress_stage from public.snapshot_requests where id='${w11}';")" \
  "report_ready/quality_review"
assert "11c. ownership fields cleared" \
  "$(psql_q "select case when claimed_by is null and claim_token is null and lease_expires_at is null
                   then 'cleared' else 'retained' end
             from public.snapshot_requests where id='${w11}';")" \
  "cleared"
assert "11d. attempt_count preserved" "$(request_field "${w11}" attempt_count)" "${before11}"

tok11="$(artifact_field "${w11}" public_token)"
assert "11e. public token is 64 characters" "${#tok11}" "64"
assert "11f. public token matches the route regex" \
  "$(psql_q "select case when '${tok11}' ~ '^[A-Za-z0-9_-]{43,128}\$' then 'yes' else 'no' end;")" \
  "yes"
assert "11g. delivery metadata is null on a new artifact" \
  "$(artifact_field "${w11}" delivered_at)" "NULL"
assert "11h. stale token cannot complete again" \
  "$(psql_q "select count(*) from public.complete_snapshot_report_worker('${w11}','${p11}','${t11}','other full','other short','x.md','y.md',now());")" \
  "0"

# Atomicity: a duplicate public_token forces a unique-index violation
# after the artifact insert, inside the same transaction.
psql_q "delete from public.snapshot_requests;" >/dev/null
IFS='|' read -r w11b p11b t11b <<<"$(claim_fresh "t11b")"
atomic_err="$(psql_expect_error "
  create or replace function pg_temp.force_fail() returns void language sql as \$f\$ select 1 \$f\$;
  begin;
  select public.complete_snapshot_report_worker('${w11b}','${p11b}','${t11b}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());
  select 1/0;
  commit;")"
assert "11i. forced failure inside completion rolls back the artifact" \
  "$(psql_q "select count(*) from public.snapshot_report_artifacts where snapshot_request_id='${w11b}';")" \
  "0"
assert "11j. forced failure inside completion rolls back report_ready" \
  "$(request_field "${w11b}" status)" "running"

# ── Test 12 — delivered artifact immutability ────────────────────────────

echo
echo "── Test 12: delivered artifact immutability ─────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
IFS='|' read -r w12 p12 t12 <<<"$(claim_fresh "t12")"
seed_artifact "${w12}" "${p12}" yes
tok12="$(artifact_token_id "${w12}")"

assert "12a. worker completion refuses a delivered artifact" \
  "$(psql_q "select count(*) from public.complete_snapshot_report_worker('${w12}','${p12}','${t12}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "0"
assert "12b. delivered content unchanged" \
  "$(artifact_field "${w12}" full_report_markdown)" "seeded full"
assert "12c. delivery metadata not cleared" \
  "$(artifact_field "${w12}" delivery_message_id)" "seeded-message-id"
assert "12d. public token unchanged" "$(artifact_token_id "${w12}")" "${tok12}"
assert "12e. worker failure refuses an artifact-bearing request" \
  "$(psql_q "select count(*) from public.mark_snapshot_request_failed_worker('${w12}','${p12}','${t12}');")" \
  "0"

# Manual and backfill writers against a delivered artifact.
psql_q "delete from public.snapshot_requests;" >/dev/null
m12="$(seed_queued "t12m" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${m12}');" >/dev/null
p12m="$(request_field "${m12}" project_id)"
seed_artifact "${m12}" "${p12m}" yes

assert "12f. manual save refuses a delivered artifact" \
  "$(psql_q "select count(*) from public.save_snapshot_report_artifact_manual('${m12}','${p12m}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "0"
assert "12g. manual content unchanged after refusal" \
  "$(artifact_field "${m12}" full_report_markdown)" "seeded full"

# ── Test 13 — manual save and token preservation ─────────────────────────

echo
echo "── Test 13: manual save and token preservation ──────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
m13="$(seed_queued "t13" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${m13}');" >/dev/null
p13="$(request_field "${m13}" project_id)"

assert "13a. manual save inserts an artifact" \
  "$(psql_q "select count(*) from public.save_snapshot_report_artifact_manual('${m13}','${p13}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "1"
tok13="$(artifact_field "${m13}" public_token)"
tok13id="$(artifact_token_id "${m13}")"
assert "13b. generated token is 64 characters" "${#tok13}" "64"
assert "13c. manual save updates an undelivered artifact" \
  "$(psql_q "select count(*) from public.save_snapshot_report_artifact_manual('${m13}','${p13}','updated full','updated short','f2.md','s2.md',now());")" \
  "1"
assert "13d. content updated" "$(artifact_field "${m13}" full_report_markdown)" "updated full"
assert "13e. public token preserved across update" \
  "$(artifact_token_id "${m13}")" "${tok13id}"
assert "13f. manual save does not finalize the request" \
  "$(request_field "${m13}" status)" "running"
assert "13g. empty artifact input is rejected" \
  "$(psql_expect_error "select public.save_snapshot_report_artifact_manual('${m13}','${p13}','','${MD_SHORT}','f.md','s.md',now());" )" \
  "OTHER_ERROR"

# ── Test 14 — backfill is insert-only ────────────────────────────────────

echo
echo "── Test 14: backfill is insert-only ─────────────────────"

psql_q "delete from public.snapshot_requests;" >/dev/null
b14="$(seed_queued "t14" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${b14}');" >/dev/null
p14="$(request_field "${b14}" project_id)"

assert "14a. backfill refuses a running request" \
  "$(psql_q "select count(*) from public.insert_snapshot_report_artifact_backfill('${b14}','${p14}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "0"

psql_q "update public.snapshot_requests set status='report_ready', progress_stage='quality_review' where id='${b14}';" >/dev/null
assert "14b. backfill inserts when the artifact is missing" \
  "$(psql_q "select count(*) from public.insert_snapshot_report_artifact_backfill('${b14}','${p14}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());")" \
  "1"
tok14="$(artifact_token_id "${b14}")"
assert "14c. backfill refuses an existing undelivered artifact" \
  "$(psql_q "select count(*) from public.insert_snapshot_report_artifact_backfill('${b14}','${p14}','overwrite full','overwrite short','x.md','y.md',now());")" \
  "0"
assert "14d. existing content untouched by refused backfill" \
  "$(artifact_field "${b14}" full_report_markdown)" "${MD_FULL}"
assert "14e. token untouched by refused backfill" \
  "$(artifact_token_id "${b14}")" "${tok14}"

# ── Test 15 — delivery and resend bookkeeping ────────────────────────────

echo
echo "── Test 15: delivery and resend bookkeeping ─────────────"

assert "15a. initial delivery succeeds on an undelivered artifact" \
  "$(psql_q "select count(*) from public.mark_snapshot_report_delivered('${b14}','msg-one',now(),false);")" \
  "1"
assert "15b. delivered_at is set" \
  "$(psql_q "select case when delivered_at is null then 'NULL' else 'set' end
             from public.snapshot_report_artifacts where snapshot_request_id='${b14}';")" \
  "set"
assert "15c. initial delivery refuses an already-delivered artifact" \
  "$(psql_q "select count(*) from public.mark_snapshot_report_delivered('${b14}','msg-two',now(),false);")" \
  "0"
assert "15d. resend succeeds and replaces the message ID" \
  "$(psql_q "select delivery_message_id from public.mark_snapshot_report_delivered('${b14}','msg-three',now(),true);")" \
  "msg-three"
assert "15e. delivery never changes content" \
  "$(artifact_field "${b14}" full_report_markdown)" "${MD_FULL}"
assert "15f. delivery never changes the public token" \
  "$(artifact_token_id "${b14}")" "${tok14}"

psql_q "delete from public.snapshot_requests;" >/dev/null
m15="$(seed_queued "t15" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${m15}');" >/dev/null
p15="$(request_field "${m15}" project_id)"
psql_q "select 1 from public.save_snapshot_report_artifact_manual('${m15}','${p15}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());" >/dev/null
assert "15g. resend refuses a never-delivered artifact" \
  "$(psql_q "select count(*) from public.mark_snapshot_report_delivered('${m15}','msg-x',now(),true);")" \
  "0"
assert "15h. delivery refuses a non-report_ready request" \
  "$(psql_q "select count(*) from public.mark_snapshot_report_delivered('${m15}','msg-y',now(),false);")" \
  "0"

# ── Test 16 — manual finalization artifact invariants ────────────────────

echo
echo "── Test 16: manual finalization artifact invariants ─────"

assert "16a. manual report_ready refuses without quality_review" \
  "$(psql_q "select count(*) from public.finalize_snapshot_request('${m15}','${p15}','report_ready');")" \
  "0"
psql_q "select 1 from public.update_snapshot_request_progress('${m15}','${p15}','quality_review');" >/dev/null
assert "16b. manual report_ready succeeds with artifact and quality_review" \
  "$(psql_q "select status from public.finalize_snapshot_request('${m15}','${p15}','report_ready');")" \
  "report_ready"

psql_q "delete from public.snapshot_requests;" >/dev/null
f16="$(seed_queued "t16" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${f16}');" >/dev/null
p16="$(request_field "${f16}" project_id)"
assert "16c. manual failed succeeds when no artifact exists" \
  "$(psql_q "select status from public.finalize_snapshot_request('${f16}','${p16}','failed');")" \
  "failed"

psql_q "delete from public.snapshot_requests;" >/dev/null
f16b="$(seed_queued "t16b" 10)"
psql_q "select 1 from public.reserve_snapshot_request_project('${f16b}');" >/dev/null
p16b="$(request_field "${f16b}" project_id)"
seed_artifact "${f16b}" "${p16b}" no
assert "16d. manual failed refuses an artifact-bearing request" \
  "$(psql_q "select count(*) from public.finalize_snapshot_request('${f16b}','${p16b}','failed');")" \
  "0"
assert "16e. manual report_ready refuses without an artifact" \
  "$(psql_q "select count(*) from public.finalize_snapshot_request('${f16b}','${p16b}','report_ready');" >/dev/null; \
     psql_q "delete from public.snapshot_report_artifacts where snapshot_request_id='${f16b}';" >/dev/null; \
     psql_q "select 1 from public.update_snapshot_request_progress('${f16b}','${p16b}','quality_review');" >/dev/null; \
     psql_q "select count(*) from public.finalize_snapshot_request('${f16b}','${p16b}','report_ready');")" \
  "0"

# ── Test 17 — corrected stale-at-max terminalization ─────────────────────

echo
echo "── Test 17: corrected stale-at-max terminalization ──────"

make_stale_at_max() {
  # make_stale_at_max <label> <artifact: none|undelivered|delivered>
  local label="$1" kind="$2" rid pid
  IFS='|' read -r rid pid _ <<<"$(claim_fresh "${label}")"
  [[ "${kind}" == "none" ]] || seed_artifact "${rid}" "${pid}" \
    "$([[ "${kind}" == "delivered" ]] && echo yes || echo no)"
  psql_q "update public.snapshot_requests
             set progress_stage='building_diagnosis',
                 attempt_count=${MAX_ATTEMPTS},
                 lease_expires_at = now() - interval '5 minutes'
           where id='${rid}';" >/dev/null
  echo "${rid}"
}

psql_q "delete from public.snapshot_requests;" >/dev/null
s17_none="$(make_stale_at_max "t17a" none)"
s17_undel="$(make_stale_at_max "t17b" undelivered)"
s17_del="$(make_stale_at_max "t17c" delivered)"
q17="$(seed_queued "t17q" 1)"

claimed17="$(psql_q "select id from public.claim_next_snapshot_request('w-t17:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" | tr -d '[:space:]')"

assert "17a. stale-at-max WITHOUT artifact becomes failed" \
  "$(request_field "${s17_none}" status)" "failed"
assert "17b. stale-at-max with UNDELIVERED artifact stays running" \
  "$(request_field "${s17_undel}" status)" "running"
assert "17c. stale-at-max with DELIVERED artifact stays running" \
  "$(request_field "${s17_del}" status)" "running"
assert "17d. artifact-bearing stale request keeps its ownership fields" \
  "$(psql_q "select case when claim_token is null then 'cleared' else 'retained' end
             from public.snapshot_requests where id='${s17_del}';")" \
  "retained"
assert "17e. artifact-bearing stale request keeps progress and attempts" \
  "$(psql_q "select progress_stage||'/'||attempt_count from public.snapshot_requests where id='${s17_del}';")" \
  "building_diagnosis/${MAX_ATTEMPTS}"
assert "17f. queued request is still claimable in the same call" \
  "${claimed17}" "${q17}"
assert "17g. delivered artifact survived terminalization intact" \
  "$(artifact_field "${s17_del}" delivery_message_id)" "seeded-message-id"

# ── Test 18 — privileges on the 0031 surface ─────────────────────────────

echo
echo "── Test 18: privileges on the 0031 surface ──────────────"

for role in level2_plain anon authenticated; do
  assert "18. ${role} cannot execute worker completion" \
    "$(psql_expect_error "set role ${role}; select public.complete_snapshot_report_worker(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'a','b','c','d',now());")" \
    "PERMISSION_DENIED"
  assert "18. ${role} cannot execute manual artifact save" \
    "$(psql_expect_error "set role ${role}; select public.save_snapshot_report_artifact_manual(gen_random_uuid(),gen_random_uuid(),'a','b','c','d',now());")" \
    "PERMISSION_DENIED"
  assert "18. ${role} cannot execute delivery" \
    "$(psql_expect_error "set role ${role}; select public.mark_snapshot_report_delivered(gen_random_uuid(),'m',now(),false);")" \
    "PERMISSION_DENIED"
done

for fn in \
  "complete_snapshot_report_worker(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'a','b','c','d',now())" \
  "mark_snapshot_request_failed_worker(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())" \
  "update_snapshot_request_progress_worker(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'crawling')" \
  "save_snapshot_report_artifact_manual(gen_random_uuid(),gen_random_uuid(),'a','b','c','d',now())" \
  "insert_snapshot_report_artifact_backfill(gen_random_uuid(),gen_random_uuid(),'a','b','c','d',now())" \
  "mark_snapshot_report_delivered(gen_random_uuid(),'m',now(),false)"; do
  assert "18. service_role CAN execute ${fn%%(*}" \
    "$(psql_q "set role service_role; select count(*) >= 0 from public.${fn};" | tail -n1)" \
    "t"
done

assert "18. service_role CANNOT execute _lock_active_snapshot_worker_claim" \
  "$(psql_expect_error "set role service_role; select public._lock_active_snapshot_worker_claim(gen_random_uuid(),gen_random_uuid(),gen_random_uuid());")" \
  "PERMISSION_DENIED"
assert "18. service_role CANNOT execute _generate_snapshot_public_token" \
  "$(psql_expect_error "set role service_role; select public._generate_snapshot_public_token();")" \
  "PERMISSION_DENIED"
assert "18. service_role CANNOT execute _assert_snapshot_artifact_input" \
  "$(psql_expect_error "set role service_role; select public._assert_snapshot_artifact_input('a','b','c','d',now());")" \
  "PERMISSION_DENIED"

# ═════════════════════════════════════════════════════════════════════════
#  Migration 0032 — direct table DML revoked from service_role
# ═════════════════════════════════════════════════════════════════════════
#
# Fixtures above run as the database owner, which is not subject to its own
# REVOKEs, so Tests 1–18 are unaffected. These tests use real `SET ROLE
# service_role` to prove what that role can and cannot do.

# Run one statement as service_role and classify the outcome.
as_service_role() {
  psql_expect_error "set role service_role; $1"
}

# ── Test 19 — service_role direct table privileges ───────────────────────

echo
echo "── Test 19: service_role direct table privileges ────────"

psql_q "delete from public.snapshot_requests;" >/dev/null

# Seed a known fixture so SELECT visibility is proven against an exact count.
# `count(*) >= 0` was previously used here and is always true — it passed even
# when RLS hid every row, which is exactly the false positive this test must
# now catch.
t19_req="$(seed_queued "t19-select" 19)"
psql_q "select 1 from public.reserve_snapshot_request_project('${t19_req}');" >/dev/null
t19_proj="$(request_field "${t19_req}" project_id)"
psql_q "select 1 from public.save_snapshot_report_artifact_manual(
          '${t19_req}','${t19_proj}','${MD_FULL}','${MD_SHORT}','f.md','s.md',now());" >/dev/null

assert "19. service_role SELECT sees the exact seeded snapshot_requests row" \
  "$(psql_q "set role service_role;
             select count(*) from public.snapshot_requests where id='${t19_req}';" | tail -n1)" \
  "1"
assert "19. service_role SELECT sees the exact seeded artifact row" \
  "$(psql_q "set role service_role;
             select count(*) from public.snapshot_report_artifacts
              where snapshot_request_id='${t19_req}';" | tail -n1)" \
  "1"
assert "19. service_role SELECT returns real column data, not an empty set" \
  "$(psql_q "set role service_role;
             select full_report_markdown from public.snapshot_report_artifacts
              where snapshot_request_id='${t19_req}';" | tail -n1)" \
  "${MD_FULL}"

# Denied writes. Each statement is syntactically valid, so a permission
# error is the only reason it can fail.
assert "19. service_role CANNOT INSERT snapshot_requests" \
  "$(as_service_role "insert into public.snapshot_requests
      (work_email, normalized_email, company_name, website_url,
       normalized_domain, buyer_category)
     values ('l2@example.invalid','l2@example.invalid','X',
             'https://x.example.invalid','x.example.invalid','B2B');")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT UPDATE snapshot_requests" \
  "$(as_service_role "update public.snapshot_requests set updated_at = now();")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT DELETE snapshot_requests" \
  "$(as_service_role "delete from public.snapshot_requests;")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT TRUNCATE snapshot_requests" \
  "$(as_service_role "truncate table public.snapshot_requests cascade;")" \
  "PERMISSION_DENIED"
# A `CREATE TEMP TABLE ... REFERENCES` probe can fail before PostgreSQL
# evaluates the referenced-table privilege — the role also needs TEMP and
# CREATE rights — so the failure would not isolate REFERENCES. Inspect the
# specific privilege instead.
assert "19. service_role does NOT hold REFERENCES on snapshot_requests" \
  "$(psql_q "select has_table_privilege('service_role','public.snapshot_requests','REFERENCES')::text;")" \
  "false"
assert "19. service_role CANNOT create a TRIGGER on snapshot_requests" \
  "$(as_service_role "create trigger l2_trg_probe after insert
     on public.snapshot_requests for each row execute function
     public._generate_snapshot_public_token();")" \
  "PERMISSION_DENIED"

assert "19. service_role CANNOT INSERT snapshot_report_artifacts" \
  "$(as_service_role "insert into public.snapshot_report_artifacts
      (snapshot_request_id, project_id, full_report_markdown,
       short_report_markdown, full_report_filename, short_report_filename,
       generated_at, public_token)
     values (gen_random_uuid(), gen_random_uuid(), 'f','s','f.md','s.md',
             now(), repeat('a',64));")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT UPDATE snapshot_report_artifacts" \
  "$(as_service_role "update public.snapshot_report_artifacts set updated_at = now();")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT DELETE snapshot_report_artifacts" \
  "$(as_service_role "delete from public.snapshot_report_artifacts;")" \
  "PERMISSION_DENIED"
assert "19. service_role CANNOT TRUNCATE snapshot_report_artifacts" \
  "$(as_service_role "truncate table public.snapshot_report_artifacts cascade;")" \
  "PERMISSION_DENIED"
# Same reasoning as the snapshot_requests REFERENCES check above.
assert "19. service_role does NOT hold REFERENCES on snapshot_report_artifacts" \
  "$(psql_q "select has_table_privilege('service_role','public.snapshot_report_artifacts','REFERENCES')::text;")" \
  "false"
assert "19. service_role CANNOT create a TRIGGER on snapshot_report_artifacts" \
  "$(as_service_role "create trigger l2_trg_probe2 after insert
     on public.snapshot_report_artifacts for each row execute function
     public._generate_snapshot_public_token();")" \
  "PERMISSION_DENIED"

# Exact SQLSTATE, not just an error class. `psql_expect_error` matches on
# message text; these pin the code to insufficient_privilege so an unrelated
# failure can never satisfy a denial assertion.
assert "19. INSERT denial SQLSTATE on snapshot_requests is 42501" \
  "$(sqlstate_as_role service_role "insert into public.snapshot_requests
      (work_email, normalized_email, company_name, website_url,
       normalized_domain, buyer_category)
     values ('l2s@example.invalid','l2s@example.invalid','X',
             'https://xs.example.invalid','xs.example.invalid','B2B');")" \
  "42501"
assert "19. UPDATE denial SQLSTATE on snapshot_requests is 42501" \
  "$(sqlstate_as_role service_role "update public.snapshot_requests set updated_at = now();")" \
  "42501"
assert "19. DELETE denial SQLSTATE on snapshot_requests is 42501" \
  "$(sqlstate_as_role service_role "delete from public.snapshot_requests;")" \
  "42501"
assert "19. UPDATE denial SQLSTATE on snapshot_report_artifacts is 42501" \
  "$(sqlstate_as_role service_role "update public.snapshot_report_artifacts set updated_at = now();")" \
  "42501"
assert "19. DELETE denial SQLSTATE on snapshot_report_artifacts is 42501" \
  "$(sqlstate_as_role service_role "delete from public.snapshot_report_artifacts;")" \
  "42501"

# A denial must also leave the database untouched. Without BYPASSRLS these
# counts would have been 0 regardless, which is why the role fidelity fix
# above is a precondition for this check meaning anything.
assert "19. denied writes left the seeded request row intact" \
  "$(psql_q "select count(*) from public.snapshot_requests where id='${t19_req}';")" \
  "1"
assert "19. denied writes left the seeded artifact row intact" \
  "$(psql_q "select count(*) from public.snapshot_report_artifacts
              where snapshot_request_id='${t19_req}';")" \
  "1"
assert "19. denied writes did not alter artifact content" \
  "$(psql_q "select full_report_markdown from public.snapshot_report_artifacts
              where snapshot_request_id='${t19_req}';")" \
  "${MD_FULL}"

# Catalog cross-check: exactly SELECT remains on both tables.
for tbl in snapshot_requests snapshot_report_artifacts; do
  assert "19. catalog: service_role holds only SELECT on ${tbl}" \
    "$(psql_q "select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type),'NONE')
                 from information_schema.role_table_grants
                where grantee='service_role' and table_schema='public'
                  and table_name='${tbl}';")" \
    "SELECT"
done

# Unrelated tables must keep their DML.
for tbl in projects probe_results generated_assets; do
  assert "19. unrelated table ${tbl} keeps service_role INSERT" \
    "$(psql_q "select has_table_privilege('service_role','public.${tbl}','INSERT')::text;")" \
    "true"
done

# ── Test 20 — RPC surface still works after revocation ───────────────────

echo
echo "── Test 20: RPC surface still works after revocation ────"

for fn in reserve_snapshot_request_project claim_next_snapshot_request \
          renew_snapshot_request_lease update_snapshot_request_progress \
          finalize_snapshot_request update_snapshot_request_progress_worker \
          complete_snapshot_report_worker mark_snapshot_request_failed_worker \
          save_snapshot_report_artifact_manual \
          insert_snapshot_report_artifact_backfill \
          mark_snapshot_report_delivered; do
  assert "20. service_role retains EXECUTE on ${fn}" \
    "$(psql_q "select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='${fn}';")" \
    "true"
done

for fn in _ensure_snapshot_request_project _lock_active_snapshot_worker_claim \
          _generate_snapshot_public_token _assert_snapshot_artifact_input; do
  assert "20. internal helper ${fn} still NOT executable by service_role" \
    "$(psql_q "select bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE'))::text
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname='public' and p.proname='${fn}';")" \
    "false"
done

# SECURITY DEFINER runs as its owner, so the RPCs must still mutate both
# tables even though service_role lost direct DML. This is the property
# the whole design depends on.
psql_q "delete from public.snapshot_requests;" >/dev/null
w20="$(seed_queued "t20-worker" 20)"

assert "20. service_role CAN claim through the RPC (writes snapshot_requests)" \
  "$(psql_q "set role service_role;
             select count(*) from public.claim_next_snapshot_request('w-t20:${RANDOM}', ${LEASE_SECONDS}, ${MAX_ATTEMPTS});" | tail -n1)" \
  "1"

IFS='|' read -r r20 p20 t20 <<<"$(psql_q "select id||'|'||project_id||'|'||claim_token
                                            from public.snapshot_requests where id='${w20}';")"

assert "20. worker progress fencing still works under service_role" \
  "$(psql_q "set role service_role;
             select progress_stage from public.update_snapshot_request_progress_worker('${r20}','${p20}','${t20}','crawling');" | tail -n1)" \
  "crawling"
assert "20. wrong token still rejected under service_role" \
  "$(psql_q "set role service_role;
             select count(*) from public.update_snapshot_request_progress_worker('${r20}','${p20}',gen_random_uuid(),'analyzing_site');" | tail -n1)" \
  "0"
assert "20. atomic completion still works (writes both tables)" \
  "$(psql_q "set role service_role;
             select count(*) from public.complete_snapshot_report_worker('${r20}','${p20}','${t20}','# full','# short','f.md','s.md',now());" | tail -n1)" \
  "1"
assert "20. completion finalized the request" \
  "$(psql_q "select status||'/'||progress_stage from public.snapshot_requests where id='${r20}';")" \
  "report_ready/quality_review"

# Manual save on a manual-owned running request.
psql_q "delete from public.snapshot_requests;" >/dev/null
m20="$(seed_queued "t20-manual" 20)"
psql_q "select 1 from public.reserve_snapshot_request_project('${m20}');" >/dev/null
pm20="$(psql_q "select project_id from public.snapshot_requests where id='${m20}';")"
assert "20. manual artifact save still works under service_role" \
  "$(psql_q "set role service_role;
             select count(*) from public.save_snapshot_report_artifact_manual('${m20}','${pm20}','# full','# short','f.md','s.md',now());" | tail -n1)" \
  "1"

# Backfill on a manual-owned report_ready request with no artifact.
psql_q "delete from public.snapshot_requests;" >/dev/null
b20="$(seed_queued "t20-backfill" 20)"
psql_q "select 1 from public.reserve_snapshot_request_project('${b20}');" >/dev/null
pb20="$(psql_q "select project_id from public.snapshot_requests where id='${b20}';")"
psql_q "update public.snapshot_requests set status='report_ready', progress_stage='quality_review' where id='${b20}';" >/dev/null
assert "20. backfill insert still works under service_role" \
  "$(psql_q "set role service_role;
             select count(*) from public.insert_snapshot_report_artifact_backfill('${b20}','${pb20}','# full','# short','f.md','s.md',now());" | tail -n1)" \
  "1"

assert "20. delivery bookkeeping still works under service_role" \
  "$(psql_q "set role service_role;
             select count(*) from public.mark_snapshot_report_delivered('${b20}','msg-t20',now(),false);" | tail -n1)" \
  "1"
assert "20. delivered artifact still immutable under service_role" \
  "$(psql_q "set role service_role;
             select count(*) from public.save_snapshot_report_artifact_manual('${b20}','${pb20}','overwrite','overwrite','x.md','y.md',now());" | tail -n1)" \
  "0"
assert "20. delivered content unchanged" \
  "$(psql_q "select full_report_markdown from public.snapshot_report_artifacts where snapshot_request_id='${b20}';")" \
  "# full"

# ── Test 21 — artifact survives project deletion (migration 0033) ────────
#
# Before 0033 the artifact's project foreign key was ON DELETE CASCADE and
# 0032 revoked nothing on public.projects, so deleting a project destroyed
# a delivered report through a table the boundary never covered.

echo
echo "── Test 21: project deletion cannot destroy a report ────"

assert "21. artifact project FK is ON DELETE RESTRICT" \
  "$(psql_q "select confdeltype from pg_constraint
              where conrelid='public.snapshot_report_artifacts'::regclass
                and conname='snapshot_report_artifacts_project_id_fkey';")" \
  "r"
assert "21. artifact request FK still ON DELETE CASCADE" \
  "$(psql_q "select confdeltype from pg_constraint
              where conrelid='public.snapshot_report_artifacts'::regclass
                and conname='snapshot_report_artifacts_snapshot_request_id_fkey';")" \
  "c"

# A delivered report, built through the approved surface.
psql_q "delete from public.snapshot_requests;" >/dev/null
d21="$(seed_queued "t21-delivered" 21)"
psql_q "select 1 from public.reserve_snapshot_request_project('${d21}');" >/dev/null
pd21="$(psql_q "select project_id from public.snapshot_requests where id='${d21}';")"
psql_q "select 1 from public.save_snapshot_report_artifact_manual('${d21}','${pd21}','# full','# short','f.md','s.md',now());" >/dev/null
psql_q "select 1 from public.update_snapshot_request_progress('${d21}','${pd21}','quality_review');" >/dev/null
psql_q "select 1 from public.finalize_snapshot_request('${d21}','${pd21}','report_ready');" >/dev/null
psql_q "select 1 from public.mark_snapshot_report_delivered('${d21}','msg-t21',now(),false);" >/dev/null

assert "21. fixture artifact is delivered" \
  "$(psql_q "select (delivered_at is not null)::text
               from public.snapshot_report_artifacts where snapshot_request_id='${d21}';")" \
  "true"

# The whole point: this delete must fail rather than cascade.
del21="$(psql_expect_error "delete from public.projects where id='${pd21}';")"
assert "21. deleting the project is refused while a report exists" \
  "$([[ "${del21}" != "NO_ERROR" ]] && echo blocked || echo allowed)" \
  "blocked"
assert "21. the delivered artifact survived" \
  "$(psql_q "select count(*) from public.snapshot_report_artifacts where snapshot_request_id='${d21}';")" \
  "1"
assert "21. delivered content survived unchanged" \
  "$(psql_q "select full_report_markdown from public.snapshot_report_artifacts where snapshot_request_id='${d21}';")" \
  "# full"
assert "21. the request survived" \
  "$(psql_q "select status from public.snapshot_requests where id='${d21}';")" \
  "report_ready"

# service_role keeps DELETE on projects: 0033 changes a constraint, not a grant.
assert "21. service_role still holds DELETE on public.projects" \
  "$(psql_q "select has_table_privilege('service_role','public.projects','DELETE')::text;")" \
  "true"
# The service_role case needs its own probe rather than psql_expect_error.
#
# 0011 enables RLS on public.projects and the schema defines no policies at
# all. The table owner is exempt (0011 sets `no force row level security`).
# service_role is now created WITH BYPASSRLS to match the real Supabase role,
# so a DELETE by id reaches the foreign key and is refused with 23503 — which
# is the property migration 0033 actually adds.
#
# That was not always true here. The harness previously created service_role
# without BYPASSRLS, so under RLS with no policy the row was invisible: the
# DELETE matched zero rows, succeeded trivially, and never reached the
# foreign key. An earlier version of this assertion read that silent no-op as
# meaningful, which is the false positive the role fidelity fix removes.
#
# This probe records who ran the statement, how many rows it actually removed,
# and the SQLSTATE. It runs with the production-faithful attribute first, then
# once more with BYPASSRLS deliberately removed, so the constraint refusal and
# the RLS no-op are distinguished rather than conflated. Everything runs inside
# a transaction that is rolled back, so the fixture is untouched either way.
t21_probe() {
  timeout "${PSQL_TIMEOUT}" docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 -tAq <<SQL
begin;
create temp table t21_probe (who text, state text, removed int);
grant insert on t21_probe to service_role;
set local role service_role;
do \$\$
declare
  s text := 'NO_ERROR';
  n integer := 0;
begin
  begin
    with d as (
      delete from public.projects where id = '$1' returning 1
    )
    select count(*) into n from d;
  exception when others then
    s := sqlstate;
  end;
  insert into t21_probe values (current_user, s, n);
end
\$\$;
reset role;
select who || '|' || state || '|' || removed from t21_probe;
rollback;
SQL
}

# The default probe now runs against the production-faithful role: service_role
# holds BYPASSRLS, so row visibility cannot do the blocking and the foreign key
# added by 0033 has to. This ordering was inverted previously, when the harness
# built service_role without BYPASSRLS — the "blocked" result it recorded came
# from RLS hiding the row, not from the constraint under test.
probe_fk="$(t21_probe "${pd21}" | tail -n1)"
echo "   probe (service_role, BYPASSRLS — production-faithful): ${probe_fk}"
assert "21. service_role sees the row under its production BYPASSRLS attribute" \
  "$(cut -d'|' -f1 <<<"${probe_fk}")" \
  "service_role"
assert "21. service_role delete on a report-bearing project raises 23503" \
  "$(cut -d'|' -f2 <<<"${probe_fk}")" \
  "23503"
assert "21. service_role delete removed no project row" \
  "$(cut -d'|' -f3 <<<"${probe_fk}")" \
  "0"

# Deliberately drop BYPASSRLS to record what the weaker role would have shown:
# no error and zero rows removed. Keeping this probe documents that the 23503
# above is genuinely the constraint and not an artifact of row filtering. The
# attribute is restored immediately, and the restoration is asserted, because
# every later test depends on the production-faithful default.
psql_q "alter role service_role nobypassrls;" >/dev/null
probe_rls="$(t21_probe "${pd21}" | tail -n1)"
psql_q "alter role service_role bypassrls;" >/dev/null
echo "   probe (service_role, BYPASSRLS removed — contrast only): ${probe_rls}"
assert "21. without BYPASSRLS the same delete is a silent zero-row no-op" \
  "${probe_rls}" \
  "service_role|NO_ERROR|0"
assert "21. the two probes disagree, so RLS was masking the constraint" \
  "$([ "$(cut -d'|' -f2 <<<"${probe_fk}")" != "$(cut -d'|' -f2 <<<"${probe_rls}")" ] && echo differ || echo same)" \
  "differ"
assert "21. service_role BYPASSRLS was restored to the harness default" \
  "$(psql_q "select rolbypassrls::text from pg_roles where rolname='service_role';")" \
  "true"
assert "21. the project survived both probes" \
  "$(psql_q "select count(*) from public.projects where id='${pd21}';")" \
  "1"
assert "21. the artifact survived both probes" \
  "$(psql_q "select count(*) from public.snapshot_report_artifacts where snapshot_request_id='${d21}';")" \
  "1"

# Normal lifecycle: a project with no artifact is still deletable.
free21="$(psql_q "insert into public.projects (domain) values ('t21-free.example.invalid') returning id;")"
assert "21. a project with no report is still deletable" \
  "$(psql_expect_error "delete from public.projects where id='${free21}';")" \
  "NO_ERROR"

# Deleting the request still removes its report — that cascade is retained.
psql_q "delete from public.snapshot_requests where id='${d21}';" >/dev/null
assert "21. deleting the request still removes its artifact" \
  "$(psql_q "select count(*) from public.snapshot_report_artifacts where snapshot_request_id='${d21}';")" \
  "0"
assert "21. the project is deletable once its report is gone" \
  "$(psql_expect_error "delete from public.projects where id='${pd21}';")" \
  "NO_ERROR"

# ── Test 22 — RLS visibility fidelity (regression guard) ─────────────────
#
# This test exists because of a real harness defect: `service_role` was created
# without BYPASSRLS while the production role has it. Every snapshot table has
# RLS enabled and the schema defines no policies, so a role lacking BYPASSRLS
# sees nothing — and an UPDATE or DELETE by such a role affects zero rows,
# succeeds, and returns exit status 0. A test asserting only "the command
# succeeded" would pass while doing nothing at all.
#
# `projects` is used as the subject because it has RLS enabled and is not
# covered by migration 0032, so both roles legitimately hold DML on it and the
# only difference between them is row visibility.

echo
echo "── Test 22: RLS visibility fidelity ─────────────────────"

assert "22. RLS is enabled on public.projects" \
  "$(psql_q "select relrowsecurity::text from pg_class where oid='public.projects'::regclass;")" \
  "true"
assert "22. no RLS policy exists on public.projects" \
  "$(psql_q "select count(*) from pg_policies where schemaname='public' and tablename='projects';")" \
  "0"

psql_q "grant select, update on table public.projects to level2_rls_role;" >/dev/null
t22_proj="$(psql_q "insert into public.projects (domain, company_name)
                    values ('t22-rls.example.invalid','Level2 RLS fidelity')
                    returning id;")"

# service_role: BYPASSRLS, so the row is visible and a write really lands.
assert "22. service_role (BYPASSRLS) sees the row" \
  "$(psql_q "set role service_role; select count(*) from public.projects where id='${t22_proj}';" | tail -n1)" \
  "1"
assert "22. service_role UPDATE reports exactly one affected row" \
  "$(psql_q "set role service_role;
             with u as (update public.projects set company_name='Updated by service_role'
                         where id='${t22_proj}' returning 1)
             select count(*) from u;" | tail -n1)" \
  "1"
assert "22. service_role UPDATE actually persisted" \
  "$(psql_q "select company_name from public.projects where id='${t22_proj}';")" \
  "Updated by service_role"

# level2_rls_role: no BYPASSRLS. It holds UPDATE, yet RLS hides the row, so the
# statement succeeds while affecting nothing. This is the exact false positive
# the hardening guards against, so it is asserted explicitly rather than left
# implicit.
assert "22. non-BYPASSRLS role sees zero rows under RLS" \
  "$(psql_q "set role level2_rls_role; select count(*) from public.projects where id='${t22_proj}';" | tail -n1)" \
  "0"
assert "22. non-BYPASSRLS UPDATE raises no error" \
  "$(sqlstate_as_role level2_rls_role "update public.projects set company_name='Should not apply' where id='${t22_proj}';")" \
  "NO_ERROR"
assert "22. non-BYPASSRLS UPDATE affects zero rows (silent no-op)" \
  "$(psql_q "set role level2_rls_role;
             with u as (update public.projects set company_name='Should not apply'
                         where id='${t22_proj}' returning 1)
             select count(*) from u;" | tail -n1)" \
  "0"
assert "22. the silent no-op left the value untouched" \
  "$(psql_q "select company_name from public.projects where id='${t22_proj}';")" \
  "Updated by service_role"

# Teardown: the harness owns this row and the grant.
psql_q "delete from public.projects where id='${t22_proj}';" >/dev/null
psql_q "revoke select, update on table public.projects from level2_rls_role;" >/dev/null
assert "22. temporary project row removed" \
  "$(psql_q "select count(*) from public.projects where id='${t22_proj}';")" \
  "0"
assert "22. temporary grant revoked" \
  "$(psql_q "select has_table_privilege('level2_rls_role','public.projects','UPDATE')::text;")" \
  "false"

# ── Q2′-1 — account-first data foundation (QR cases) ─────────────────────
#
# Runs after every migration, including the timestamped Q2′-1 file. Uses the
# Level 2 fixtures in scripts/sql/level2-q2p1-fixtures.sql (never shipped).
# Two-session cases run in separate psql processes fed through FIFOs; every
# ordering is enforced by a barrier on pg_stat_activity (idle in transaction,
# or waiting on a Lock), never by a sleep. Each concurrency, isolation and
# binding case is first run against a deliberately weakened copy of the
# function, which must show the failure the real function prevents.

echo
echo "── Q2′-1 — account-first foundation ─────────────────────"

psql_stdin < scripts/sql/level2-q2p1-fixtures.sql
# QR-39 baseline: every row of every pre-existing table, before any Q2′-1 case.
Q2P_BASELINE_TABLES="$(psql_q "select level2_fixture.capture_baseline();" | tail -n1)"

Q2P_DIR="${TMPDIR_LEVEL2}/q2p"
mkdir -p "${Q2P_DIR}"
Q2P_OP="00000000-0000-4000-8000-0000000000f0"   # founder operator id (synthetic)

q2p_sql() { psql_q "$1" | tail -n1; }
# SQLSTATE of a statement run as the owner (superuser) inside a rolled-back transaction.
q2p_state() { sqlstate_as_role "${PG_USER}" "$1"; }
q2p_uuid() { q2p_sql "select gen_random_uuid();"; }

# Two-session helpers. A session is a psql process reading statements from a
# FIFO on a fixed descriptor (7 or 8), so they work on bash 3.2 and 5. Each
# background psql closes both descriptors, so it never holds the other
# session's FIFO open and closing a descriptor always delivers EOF.
q2p_open() { # q2p_open <name> <fd>
  local name=$1 fd=$2
  rm -f "${Q2P_DIR}/${name}.in" "${Q2P_DIR}/${name}.out"
  mkfifo "${Q2P_DIR}/${name}.in"
  timeout 120 docker exec -i "${POSTGRES_CONTAINER_ID}" \
    psql -U "${PG_USER}" -d "${PG_DB}" -X -q -tA -v ON_ERROR_STOP=0 \
    < "${Q2P_DIR}/${name}.in" > "${Q2P_DIR}/${name}.out" 2>&1 7>&- 8>&- &
  eval "Q2P_PID_${name}=\$!"
  eval "exec ${fd}>\"${Q2P_DIR}/${name}.in\""
  printf '%s\n' "\\set VERBOSITY sqlstate" "set application_name = 'q2p_${name}';" >&"${fd}"
}
q2p_send() { printf '%s\n' "$2" >&"$1"; }   # q2p_send <fd> <sql>
q2p_close() { # q2p_close <name> <fd>
  eval "exec ${2}>&-"
  eval "wait \"\${Q2P_PID_${1}}\"" || true
}
q2p_out() { cat "${Q2P_DIR}/$1.out"; }
q2p_wait() { # q2p_wait <sql returning t> — barrier on catalog state
  local _
  for _ in $(seq 1 200); do
    [[ "$(q2p_sql "$1")" == "t" ]] && return 0
    sleep 0.05
  done
  return 1
}
q2p_idle_in_tx() { q2p_wait "select exists(select 1 from pg_stat_activity where application_name='q2p_$1' and state='idle in transaction');"; }
q2p_lock_wait() { q2p_wait "select exists(select 1 from pg_stat_activity where application_name='q2p_$1' and wait_event_type='Lock');"; }
q2p_settled() { q2p_wait "select exists(select 1 from pg_stat_activity where application_name='q2p_$1' and state in ('idle','idle in transaction'));"; }
q2p_claims() { printf "set local role authenticated; set local request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}';" "$1"; }

# Workspace with the given owners (account ids). Prints "ws m1 m2 ...".
q2p_workspace() { # q2p_workspace <key> <acct> [<acct>...]
  local key=$1; shift
  local first=$1; shift
  local row ws mids
  row="$(q2p_sql "set role service_role; select workspace_id || ' ' || membership_id from public.create_workspace_with_owner('${first}', 'Workspace ${key}', 'l2-${key}', 'founder', '${Q2P_OP}');")"
  ws="${row%% *}"; mids="${row#* }"
  local a
  for a in "$@"; do
    mids="${mids} $(q2p_sql "set role service_role; select membership_id from public.add_workspace_member('${ws}', '${a}', 'founder', '${Q2P_OP}');")"
  done
  echo "${ws} ${mids}"
}
q2p_active() { q2p_sql "select count(*) from public.workspace_members where workspace_id='$1' and removed_at is null;"; }
q2p_probe_as() { # SQLSTATE of probe_member(ws) as account <acct>
  sqlstate_as_role authenticated "perform set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true); perform level2_fixture.${3:-probe_member}('$2');"
}

ACCT_A="$(q2p_uuid)"; ACCT_B="$(q2p_uuid)"; ACCT_C="$(q2p_uuid)"; ACCT_X="$(q2p_uuid)"

# ── QR-01 / QR-02 / QR-28 — applied, closed tables, grants ───────────────
Q2P_TABLES="workspaces workspace_members workspace_membership_versions workspace_projects question_research_sets question_sources question_candidates question_candidate_sources question_review_invitations question_review_sessions approval_records buyer_question_version_origins approved_wording_classifications exception_items exception_events"
assert "QR-01. the Q2′-1 migration is applied (15 tables)" \
  "$(q2p_sql "select count(*) from pg_tables where schemaname='public' and tablename = any(string_to_array('${Q2P_TABLES}', ' '));")" "15"
for t in ${Q2P_TABLES}; do
  for r in anon authenticated level2_rls_role service_role; do
    assert "QR-02. ${r} cannot select ${t}" "$(sqlstate_as_role "${r}" "perform 1 from public.${t} limit 1;")" "42501"
  done
  assert "QR-02. anon cannot insert into ${t}" "$(sqlstate_as_role anon "insert into public.${t} default values;")" "42501"
  assert "QR-02. authenticated cannot insert into ${t}" "$(sqlstate_as_role authenticated "insert into public.${t} default values;")" "42501"
  assert "QR-02. ${t} has RLS on and no policy" \
    "$(q2p_sql "select (c.relrowsecurity and not exists(select 1 from pg_policy p where p.polrelid=c.oid))::text from pg_class c where c.oid='public.${t}'::regclass;")" "true"
done
for f in "create_workspace_with_owner(uuid,text,text,text,uuid,text,text)" "assign_project_to_workspace(uuid,uuid,text,uuid,text,text)" \
         "add_workspace_member(uuid,uuid,text,uuid,text,text)" "remove_workspace_member(uuid,uuid,text,uuid,text,text)" \
         "approve_buyer_question_set(text,uuid,jsonb,text,text,text,text,text)"; do
  assert "QR-28. anon cannot execute ${f%%(*}" "$(q2p_sql "select has_function_privilege('anon', 'public.${f}', 'execute')::text;")" "false"
  assert "QR-28. authenticated cannot execute ${f%%(*}" "$(q2p_sql "select has_function_privilege('authenticated', 'public.${f}', 'execute')::text;")" "false"
  assert "QR-28. service_role can execute ${f%%(*}" "$(q2p_sql "select has_function_privilege('service_role', 'public.${f}', 'execute')::text;")" "true"
done
for r in anon authenticated service_role level2_plain; do
  assert "QR-28. ${r} cannot execute F6 directly" \
    "$(sqlstate_as_role "${r}" "perform public.assert_current_account_member(gen_random_uuid());")" "42501"
done
# Detector bites: if F6 were granted to service_role, the check above would see it.
assert "QR-28 (weakened). a grant of F6 to service_role is detected (rolled back)" \
  "$(q2p_state "grant execute on function public.assert_current_account_member(uuid) to service_role; if has_function_privilege('service_role', 'public.assert_current_account_member(uuid)', 'execute') then raise exception using errcode = 'P0001'; end if;")" "P0001"

# ── QR-06 / QR-07 — F1 idempotency, F2 single mapping ────────────────────
read -r WS1 M1A <<<"$(q2p_workspace ws1 "${ACCT_A}")"
read -r WS2 M2B <<<"$(q2p_workspace ws2 "${ACCT_B}")"
assert "QR-06. F1 replay with the same key returns the same workspace" \
  "$(q2p_sql "set role service_role; select status || ':' || workspace_id from public.create_workspace_with_owner('${ACCT_A}', 'Workspace ws1', 'l2-ws1', 'founder', '${Q2P_OP}');")" "ALREADY_CREATED:${WS1}"
assert "QR-06. F1 with the same key and a different body returns IDEMPOTENCY_KEY_CONFLICT and writes nothing" \
  "$(q2p_sql "set role service_role; select concat_ws('|', status, workspace_id, membership_id) from public.create_workspace_with_owner('${ACCT_A}', 'Another name', 'l2-ws1', 'founder', '${Q2P_OP}');")|$(q2p_sql "select count(*) from public.workspaces where idempotency_key='l2-ws1';")" "IDEMPOTENCY_KEY_CONFLICT|1"
assert "QR-06. F1 refuses a customer actor" \
  "$(sqlstate_as_role service_role "perform public.create_workspace_with_owner('${ACCT_A}', 'X', 'l2-bad-actor', 'customer_account');")" "22023"
assert "QR-06. F1 created exactly one workspace, one version row (=1) and one owner" \
  "$(q2p_sql "select (select count(*) from public.workspaces where idempotency_key='l2-ws1') || '/' || (select version from public.workspace_membership_versions where workspace_id='${WS1}') || '/' || $(q2p_active "${WS1}");")" "1/1/1"

PROJ1="$(q2p_sql "insert into public.projects (domain, company_name) values ('q2p-one.test', 'Q2P One') returning id;")"
PROJ2="$(q2p_sql "insert into public.projects (domain, company_name) values ('q2p-two.test', 'Q2P Two') returning id;")"
REQ1="$(q2p_sql "insert into public.snapshot_requests (work_email, normalized_email, company_name, website_url, normalized_domain, buyer_category, project_id, status) values ('buyer@q2p-one.test','buyer@q2p-one.test','Q2P One','https://q2p-one.test','q2p-one.test','crm','${PROJ1}','pending_approval') returning id;")"
REQ2="$(q2p_sql "insert into public.snapshot_requests (work_email, normalized_email, company_name, website_url, normalized_domain, buyer_category, project_id, status) values ('buyer@q2p-two.test','buyer@q2p-two.test','Q2P Two','https://q2p-two.test','q2p-two.test','crm','${PROJ2}','pending_approval') returning id;")"
assert "QR-07. F2 maps project 1 to workspace 1" \
  "$(q2p_sql "set role service_role; select status from public.assign_project_to_workspace('${PROJ1}', '${WS1}', 'founder', '${Q2P_OP}');")" "MAPPED"
q2p_sql "set role service_role; select status from public.assign_project_to_workspace('${PROJ2}', '${WS2}', 'founder', '${Q2P_OP}');" >/dev/null
assert "QR-07. F2 refuses an already-mapped project" \
  "$(sqlstate_as_role service_role "perform public.assign_project_to_workspace('${PROJ1}', '${WS2}', 'founder', '${Q2P_OP}');")" "23505"
assert "QR-07. the original mapping is unchanged" \
  "$(q2p_sql "select workspace_id from public.workspace_projects where project_id='${PROJ1}';")" "${WS1}"

# ── QR-27 / QR-08 — claims binding and cross-workspace isolation (F6) ────
assert "QR-27. a member's own claims pass" "$(q2p_probe_as "${ACCT_A}" "${WS1}")" "NO_ERROR"
assert "QR-08. a member of workspace 1 is refused workspace 2" "$(q2p_probe_as "${ACCT_A}" "${WS2}")" "42501"
assert "QR-27. no claims are refused" \
  "$(sqlstate_as_role authenticated "perform level2_fixture.probe_member('${WS1}');")" "42501"
assert "QR-27. claim role anon is refused" \
  "$(sqlstate_as_role authenticated "perform set_config('request.jwt.claims', '{\"sub\":\"${ACCT_A}\",\"role\":\"anon\"}', true); perform level2_fixture.probe_member('${WS1}');")" "42501"
assert "QR-27. a non-UUID subject is refused" \
  "$(sqlstate_as_role authenticated "perform set_config('request.jwt.claims', '{\"sub\":\"not-a-uuid\",\"role\":\"authenticated\"}', true); perform level2_fixture.probe_member('${WS1}');")" "42501"
assert "QR-27. malformed claims JSON is refused" \
  "$(sqlstate_as_role authenticated "perform set_config('request.jwt.claims', '{not json', true); perform level2_fixture.probe_member('${WS1}');")" "42501"
assert "QR-27. X's claims with Y's workspace are refused" "$(q2p_probe_as "${ACCT_X}" "${WS1}")" "42501"
# Weakened: a guard that trusts an account parameter lets A act in B's workspace.
assert "QR-08/27 (weakened). a parameter-trusting guard admits A into workspace 2 when given B's id" \
  "$(sqlstate_as_role authenticated "perform set_config('request.jwt.claims', '{\"sub\":\"${ACCT_A}\",\"role\":\"authenticated\"}', true); perform level2_fixture.probe_member_trusting_param('${WS2}', '${ACCT_B}');")" "NO_ERROR"

# ── QR-31 / QR-09 / QR-04 — membership lifecycle ─────────────────────────
read -r WS3 M3A M3C <<<"$(q2p_workspace ws3 "${ACCT_A}" "${ACCT_C}")"
assert "QR-31. second owner added" "$(q2p_active "${WS3}")" "2"
assert "QR-31. a second active row for the same account is refused by the index" \
  "$(q2p_state "insert into public.workspace_members (workspace_id, account_id, role, actor_type, actor_operator_id) values ('${WS3}', '${ACCT_C}', 'owner', 'founder', '${Q2P_OP}');")" "23505"
assert "QR-31. F7 on an active member is an idempotent return" \
  "$(q2p_sql "set role service_role; select status || ':' || membership_id from public.add_workspace_member('${WS3}', '${ACCT_C}', 'founder', '${Q2P_OP}');")" "ALREADY_MEMBER:${M3C}"
assert "QR-31. remove C" \
  "$(q2p_sql "set role service_role; select status from public.remove_workspace_member('${WS3}', '${M3C}', 'founder', '${Q2P_OP}');")" "REMOVED"
assert "QR-09. a removed member is refused" "$(q2p_probe_as "${ACCT_C}" "${WS3}")" "42501"
assert "QR-09 (weakened). a guard that ignores removal admits the removed member" \
  "$(q2p_probe_as "${ACCT_C}" "${WS3}" probe_member_ignores_removal)" "NO_ERROR"
assert "QR-31. removing an already-removed membership is idempotent" \
  "$(q2p_sql "set role service_role; select status from public.remove_workspace_member('${WS3}', '${M3C}', 'founder', '${Q2P_OP}');")" "ALREADY_REMOVED"
M3C2="$(q2p_sql "set role service_role; select membership_id from public.add_workspace_member('${WS3}', '${ACCT_C}', 'founder', '${Q2P_OP}');")"
assert "QR-31. re-adding creates a new membership row with a new id" "$([[ -n "${M3C2}" && "${M3C2}" != "${M3C}" ]] && echo new)" "new"
assert "QR-09. the re-added member is accepted again" "$(q2p_probe_as "${ACCT_C}" "${WS3}")" "NO_ERROR"
assert "QR-31. the removed period is unchanged" \
  "$(q2p_sql "select (removed_at is not null)::text from public.workspace_members where id='${M3C}';")" "true"
q2p_sql "set role service_role; select status from public.remove_workspace_member('${WS3}', '${M3C2}', 'founder', '${Q2P_OP}');" >/dev/null
assert "QR-31. removing the last active owner is refused (last_active_owner)" \
  "$(sqlstate_as_role service_role "perform public.remove_workspace_member('${WS3}', '${M3A}', 'founder', '${Q2P_OP}');")" "P0001"
assert "QR-31. the last owner remains" "$(q2p_active "${WS3}")" "1"
assert "QR-04. removed_at cannot be set twice" \
  "$(q2p_state "update public.workspace_members set removed_at = now() where id='${M3C}';")" "55000"
assert "QR-04. removed_at cannot be reset to null" \
  "$(q2p_state "update public.workspace_members set removed_at = null, removed_actor_type = null, removed_operator_id = null where id='${M3C}';")" "55000"
assert "QR-04. an active membership's other columns are immutable" \
  "$(q2p_state "update public.workspace_members set account_id = gen_random_uuid() where id='${M3A}';")" "55000"
assert "QR-03. a membership cannot be deleted" "$(q2p_state "delete from public.workspace_members where id='${M3C}';")" "55000"
assert "QR-03. the version row cannot be deleted" "$(q2p_state "delete from public.workspace_membership_versions where workspace_id='${WS3}';")" "55000"
assert "QR-03. the version row only moves by +1" \
  "$(q2p_state "update public.workspace_membership_versions set version = version + 2 where workspace_id='${WS3}';")" "55000"
assert "QR-03. workspace_members cannot be truncated" "$(q2p_state "truncate public.workspace_members cascade;")" "55000"

# ── QR-32 — removal is serialised with in-flight protected calls ─────────
qr32_case_a() { # <probe function> → prints "blocked|removed_while_open|after"
  local probe=$1 ws m_a m_c blocked removed_open after
  read -r ws m_a m_c <<<"$(q2p_workspace "qr32a-${probe}" "${ACCT_A}" "${ACCT_C}")"
  q2p_open A 7; q2p_open B 8
  q2p_send 7 "begin; $(q2p_claims "${ACCT_C}") select level2_fixture.${probe}('${ws}');"
  q2p_idle_in_tx A || echo "barrier A failed" >&2
  q2p_send 8 "set role service_role; select status from public.remove_workspace_member('${ws}', '${m_c}', 'founder', '${Q2P_OP}');"
  if q2p_lock_wait B; then blocked=yes; else blocked=no; fi
  removed_open="$(q2p_sql "select (removed_at is not null)::text from public.workspace_members where id='${m_c}';")"
  q2p_send 7 "commit;"
  q2p_settled B || true
  q2p_close A 7; q2p_close B 8
  after="$(q2p_probe_as "${ACCT_C}" "${ws}")"
  echo "${blocked}|${removed_open}|${after}"
}
assert "QR-32a (weakened, no FOR SHARE). removal is NOT blocked and commits mid-operation" \
  "$(qr32_case_a probe_member_no_share)" "no|true|42501"
assert "QR-32a. removal waits for the in-flight call; the next call is refused" \
  "$(qr32_case_a probe_member)" "yes|false|42501"

qr32_removal_first() { # <B ends with commit|rollback> <A isolation> → A's outcome
  local finish=$1 iso=$2 ws m_a m_c
  read -r ws m_a m_c <<<"$(q2p_workspace "qr32-${finish}-${iso// /_}" "${ACCT_A}" "${ACCT_C}")"
  q2p_open B 8; q2p_open A 7
  q2p_send 8 "begin; set local role service_role; select status from public.remove_workspace_member('${ws}', '${m_c}', 'founder', '${Q2P_OP}');"
  q2p_idle_in_tx B || echo "barrier B failed" >&2
  q2p_send 7 "begin isolation level ${iso}; select 1; $(q2p_claims "${ACCT_C}") select level2_fixture.probe_member('${ws}');"
  q2p_lock_wait A || echo "barrier A failed" >&2
  q2p_send 8 "${finish};"
  q2p_settled A || true
  q2p_send 7 "rollback;"
  q2p_close B 8; q2p_close A 7
  q2p_out A | grep -oE '^(t|ERROR:  [0-9A-Z]{5})$' | tail -n1
}
assert "QR-32b. a call starting during a pending removal is refused once it commits" \
  "$(qr32_removal_first commit 'read committed')" "ERROR:  42501"
assert "QR-32c. if the removal rolls back, the call succeeds" \
  "$(qr32_removal_first rollback 'read committed')" "t"
r32d="$(qr32_removal_first commit 'repeatable read')"
assert "QR-32d. REPEATABLE READ: the call fails (40001 or refusal), never succeeds" \
  "$([[ "${r32d}" == "ERROR:  40001" || "${r32d}" == "ERROR:  42501" ]] && echo refused || echo "${r32d}")" "refused"

# ── QR-33 — concurrent owner removals never leave zero owners ────────────
# <fn> <S1 removes> <S2 removes> <S2 isolation> <S2 snapshot first: yes|no> → "S2 outcome|active owners"
qr33_case() {
  local fn=$1 first=$2 second=$3 iso=$4 snap=$5 ws m_a m_b target1 target2
  read -r ws m_a m_b <<<"$(q2p_workspace "qr33-${fn}-${first}-${iso// /_}-${snap}" "${ACCT_A}" "${ACCT_B}")"
  [[ "${first}" == "A" ]] && { target1=${m_a}; target2=${m_b}; } || { target1=${m_b}; target2=${m_a}; }
  q2p_open S1 7; q2p_open S2 8
  if [[ "${snap}" == "yes" ]]; then
    q2p_send 8 "begin isolation level ${iso}; select 1;"
    q2p_idle_in_tx S2 || echo "barrier S2 snapshot failed" >&2
  fi
  q2p_send 7 "begin; select status from ${fn}('${ws}', '${target1}', 'founder', '${Q2P_OP}');"
  q2p_idle_in_tx S1 || echo "barrier S1 failed" >&2
  if [[ "${snap}" == "yes" ]]; then
    q2p_send 8 "select status from ${fn}('${ws}', '${target2}', 'founder', '${Q2P_OP}');"
  else
    q2p_send 8 "begin isolation level ${iso}; select status from ${fn}('${ws}', '${target2}', 'founder', '${Q2P_OP}');"
  fi
  q2p_lock_wait S2 || echo "barrier S2 lock failed" >&2
  q2p_send 7 "commit;"
  q2p_settled S2 || true
  q2p_send 8 "commit;"
  q2p_close S1 7; q2p_close S2 8
  echo "$(q2p_out S2 | grep -oE '^(REMOVED|ALREADY_REMOVED|ERROR:  [0-9A-Z]{5})$' | tail -n1)|$(q2p_active "${ws}")"
}
assert "QR-33b (weakened, row lock only). REPEATABLE READ stale snapshot leaves ZERO owners" \
  "$(qr33_case level2_fixture.remove_member_lock_only A B 'repeatable read' yes)" "REMOVED|0"
assert "QR-33a (weakened). READ COMMITTED still refuses (difference is the stale snapshot)" \
  "$(qr33_case level2_fixture.remove_member_lock_only A B 'read committed' no)" "ERROR:  P0001|1"
assert "QR-33a. READ COMMITTED: second removal blocked, then refused; one owner remains" \
  "$(qr33_case public.remove_workspace_member A B 'read committed' no)" "ERROR:  P0001|1"
assert "QR-33b. REPEATABLE READ, stale snapshot: 40001; one owner remains" \
  "$(qr33_case public.remove_workspace_member A B 'repeatable read' yes)" "ERROR:  40001|1"
assert "QR-33c. SERIALIZABLE, stale snapshot: 40001; one owner remains" \
  "$(qr33_case public.remove_workspace_member A B 'serializable' yes)" "ERROR:  40001|1"
assert "QR-33d. opposite order, READ COMMITTED: refused; one owner remains" \
  "$(qr33_case public.remove_workspace_member B A 'read committed' no)" "ERROR:  P0001|1"
assert "QR-33d. opposite order, REPEATABLE READ: 40001; one owner remains" \
  "$(qr33_case public.remove_workspace_member B A 'repeatable read' yes)" "ERROR:  40001|1"
read -r WS33E M33EA M33EB <<<"$(q2p_workspace qr33e "${ACCT_A}" "${ACCT_B}")"
q2p_sql "set role service_role; select status from public.remove_workspace_member('${WS33E}', '${M33EA}', 'founder', '${Q2P_OP}');" >/dev/null
assert "QR-33e. a REPEATABLE READ removal starting after the first commits is refused" \
  "$(q2p_sql "begin isolation level repeatable read; set local role service_role; select coalesce((select 'unexpected' from public.remove_workspace_member('${WS33E}', '${M33EB}', 'founder', '${Q2P_OP}')), 'x'); rollback;" 2>&1 | grep -c 'last_active_owner')" "1"

# QR-33f — concurrent duplicate add of the same account.
read -r WS33F M33FA <<<"$(q2p_workspace qr33f "${ACCT_A}")"
q2p_open S1 7; q2p_open S2 8
q2p_send 7 "begin; set local role service_role; select membership_id from public.add_workspace_member('${WS33F}', '${ACCT_X}', 'founder', '${Q2P_OP}');"
q2p_idle_in_tx S1 || true
q2p_send 8 "set role service_role; select status || ':' || membership_id from public.add_workspace_member('${WS33F}', '${ACCT_X}', 'founder', '${Q2P_OP}');"
q2p_lock_wait S2 || true
q2p_send 7 "commit;"
q2p_settled S2 || true
q2p_close S1 7; q2p_close S2 8
M33F_S1="$(q2p_out S1 | grep -E '^[0-9a-f-]{36}$' | tail -n1)"
assert "QR-33f. concurrent duplicate add: one active row; the other returns the same membership" \
  "$(q2p_out S2 | grep -E '^ALREADY_MEMBER:' | tail -n1)|$(q2p_sql "select count(*) from public.workspace_members where workspace_id='${WS33F}' and account_id='${ACCT_X}' and removed_at is null;")" \
  "ALREADY_MEMBER:${M33F_S1}|1"

# QR-33g — concurrent double removal of the same member (three owners).
qr33g() { # <isolation> <snapshot first>
  local iso=$1 snap=$2 ws ma mb mc first_removed
  read -r ws ma mb mc <<<"$(q2p_workspace "qr33g-${iso// /_}" "${ACCT_A}" "${ACCT_B}" "${ACCT_C}")"
  q2p_open S1 7; q2p_open S2 8
  [[ "${snap}" == "yes" ]] && { q2p_send 8 "begin isolation level ${iso}; select 1;"; q2p_idle_in_tx S2 || true; }
  q2p_send 7 "begin; set local role service_role; select status from public.remove_workspace_member('${ws}', '${mc}', 'founder', '${Q2P_OP}');"
  q2p_idle_in_tx S1 || true
  if [[ "${snap}" == "yes" ]]; then
    q2p_send 8 "set local role service_role; select status from public.remove_workspace_member('${ws}', '${mc}', 'founder', '${Q2P_OP}');"
  else
    q2p_send 8 "begin isolation level ${iso}; set local role service_role; select status from public.remove_workspace_member('${ws}', '${mc}', 'founder', '${Q2P_OP}');"
  fi
  q2p_lock_wait S2 || true
  q2p_send 7 "commit;"
  first_removed="$(q2p_sql "select removed_at from public.workspace_members where id='${mc}';")"
  q2p_settled S2 || true
  q2p_send 8 "commit;"
  q2p_close S1 7; q2p_close S2 8
  echo "$(q2p_out S2 | grep -oE '^(REMOVED|ALREADY_REMOVED|ERROR:  [0-9A-Z]{5})$' | tail -n1)|$([[ "$(q2p_sql "select removed_at from public.workspace_members where id='${mc}';")" == "${first_removed}" ]] && echo unchanged)|$(q2p_active "${ws}")"
}
assert "QR-33g. double removal, READ COMMITTED: idempotent; removed_at unchanged" \
  "$(qr33g 'read committed' no)" "ALREADY_REMOVED|unchanged|2"
assert "QR-33g. double removal, REPEATABLE READ: 40001; removed_at unchanged" \
  "$(qr33g 'repeatable read' yes)" "ERROR:  40001|unchanged|2"

# ── Q2′-1 Phase 2 — sources, candidates, invitations, approval ──────────
q2p_json() { q2p_sql "select '$1'::jsonb ->> '$2';"; }
Q2P_PROTOCOLS_BEFORE="$(q2p_sql "select count(*) from public.protocols;")"
Q2P_JOBS_BEFORE="$(q2p_sql "select count(*) from public.protocol_execution_jobs;")"
Q2P_MEMBERS_BEFORE="$(q2p_sql "select count(*) from public.workspace_members;")"

REV1="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'one');")"
RS1="$(q2p_json "${REV1}" rs)"; SPUB1="$(q2p_json "${REV1}" s_pub)"; SSITE1="$(q2p_json "${REV1}" s_site)"
COBS1="$(q2p_json "${REV1}" c_obs)"; CADP1="$(q2p_json "${REV1}" c_adp)"; CHYP1="$(q2p_json "${REV1}" c_hyp)"
INV1="$(q2p_json "${REV1}" inv)"; SES1="$(q2p_json "${REV1}" ses)"; TOK1="$(q2p_json "${REV1}" ses_token)"
ITOK1="$(q2p_json "${REV1}" inv_token)"; HMAC1="$(q2p_json "${REV1}" hmac)"
assert "QR-11. the fixture research set, sources and candidates commit (deferred evidence checks pass)" \
  "$(q2p_sql "select count(*) from public.question_candidates where research_set_id='${RS1}';")" "3"

Q2P_SRC_COLS="workspace_id, project_id, source_kind, url, retrieved_at, customer_reference, customer_attested_at, received_at, excerpt, excerpt_sha256, buyer_authored, verification, personal_data_removed, actor_type, actor_operator_id"
q2p_src() { # <kind> <url|null> <retrieved|null> <ref|null> <attested|null> <received|null> <excerpt> <buyer> <verification> <pdr> [hash]
  local h="${11:-public._q2p_sha256_hex('$7')}"
  q2p_state "insert into public.question_sources (${Q2P_SRC_COLS}) values ('${WS1}', '${PROJ1}', '$1', $2, $3, $4, $5, $6, '$7', ${h}, $8, '$9', ${10}, 'founder', '${Q2P_OP}');"
}
assert "QR-11. a valid public source is accepted" "$(q2p_src public_review "'https://r.test/1'" "now()" null null null "Fine tool." true public_verifiable true)" "NO_ERROR"
assert "QR-11. a public source without a URL is refused" "$(q2p_src public_review null "now()" null null null "Fine tool." true public_verifiable true)" "23514"
assert "QR-11. a public source without a retrieval date is refused" "$(q2p_src public_review "'https://r.test/1'" null null null null "Fine tool." true public_verifiable true)" "23514"
assert "QR-11. valid customer material is accepted" "$(q2p_src customer_material null null "'ticket 42'" "now()" "now()" "We need faster invoicing." true customer_provided true)" "NO_ERROR"
assert "QR-11. customer material without attestation is refused" "$(q2p_src customer_material null null "'ticket 42'" null "now()" "We need faster invoicing." true customer_provided true)" "23514"
assert "QR-11. customer material without a reference is refused" "$(q2p_src customer_material null null null "now()" "now()" "We need faster invoicing." true customer_provided true)" "23514"
assert "QR-11. customer material without a date received is refused" "$(q2p_src customer_material null null "'ticket 42'" "now()" null "We need faster invoicing." true customer_provided true)" "23514"
assert "QR-11. personal data not confirmed removed is refused" "$(q2p_src public_review "'https://r.test/1'" "now()" null null null "Fine tool." true public_verifiable false)" "23514"
assert "QR-11. site copy marked buyer-authored is refused" "$(q2p_src site_copy "'https://v.test/'" "now()" null null null "Best tool." true public_verifiable true)" "23514"
assert "QR-11. an excerpt of 301 characters is refused" "$(q2p_src public_review "'https://r.test/1'" "now()" null null null "$(printf 'a%.0s' $(seq 1 301))" true public_verifiable true)" "23514"
assert "QR-11. an excerpt of 300 characters is accepted" "$(q2p_src public_review "'https://r.test/1'" "now()" null null null "$(printf 'a%.0s' $(seq 1 300))" true public_verifiable true)" "NO_ERROR"
assert "QR-11. an excerpt hash that does not match is refused" "$(q2p_src public_review "'https://r.test/1'" "now()" null null null "Fine tool." true public_verifiable true "repeat('0', 64)")" "23514"
assert "QR-11. customer material marked public_verifiable is refused" "$(q2p_src customer_material null null "'ticket 42'" "now()" "now()" "We need faster invoicing." true public_verifiable true)" "23514"

# QR-12 — Q1's [R] C-04 cases, through a real link insert.
Q2P_TEXT="Which invoicing tool suits a small accounting firm?"
q2p_span_case() { # <excerpt> <span>
  q2p_state "
    with s as (insert into public.question_sources (${Q2P_SRC_COLS}) values ('${WS1}', '${PROJ1}', 'public_community', 'https://f.test/x', now(), null, null, null, '$1', public._q2p_sha256_hex('$1'), true, 'public_verifiable', true, 'founder', '${Q2P_OP}') returning id)
    insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id)
      select '${CHYP1}', s.id, 'verbatim', '$2', '${WS1}', '${PROJ1}', 'founder', '${Q2P_OP}' from s;"
}
assert "QR-12. [R] C-04 span starting and ending inside words is refused" \
  "$(q2p_span_case "XWhich invoicing tool suits a small accounting firmly" "Which invoicing tool suits a small accounting firm")" "23514"
assert "QR-12. [R] C-04 span ending inside a word is refused" \
  "$(q2p_span_case "Honestly which invoicing tool suits a small accounting firmware team" "which invoicing tool suits a small accounting firm")" "23514"
assert "QR-12. [R] C-04 invented span not in the excerpt is refused" \
  "$(q2p_span_case "Our invoices take forever to reconcile." "${Q2P_TEXT}")" "23514"
assert "QR-12. [R] C-04 span bounded by spaces and punctuation is accepted" \
  "$(q2p_span_case "Q: ${Q2P_TEXT} Thanks!" "${Q2P_TEXT}")" "NO_ERROR"
assert "QR-12. [R] C-04 span equal to the whole excerpt is accepted" \
  "$(q2p_span_case "${Q2P_TEXT}" "${Q2P_TEXT}")" "NO_ERROR"
assert "QR-12. an accented letter next to the span counts as inside a word" \
  "$(q2p_span_case "éWhich invoicing tool" "Which invoicing tool")" "23514"
assert "QR-12. site copy linked as verbatim is refused" \
  "$(q2p_state "insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id) values ('${CHYP1}', '${SSITE1}', 'verbatim', 'Acme', '${WS1}', '${PROJ1}', 'founder', '${Q2P_OP}');")" "23514"

# QR-13 — primary source must be a supporting link; observed/adapted evidence (checked at commit).
q2p_cand() { # <grade> <verification|null> <primary|null> <note|null> → SQL inserting a candidate returning id
  printf "insert into public.question_candidates (workspace_id, project_id, research_set_id, candidate_text, normalized_hash, evidence_grade, verification, question_kind, buyer_relevance, buyer_relevance_reason, icp_fit, icp_fit_reason, commercial_intent, commercial_intent_reason, product_relevance, product_relevance_reason, intent, buyer_stage, adaptation_note, curator_rank, primary_source_id, actor_type, actor_operator_id) values ('%s', '%s', '%s', 'Fixture question?', repeat('a', 64), '%s', %s, 'unbranded', 1, 'r', 1, 'r', 1, 'r', 1, 'r', 'shortlist', 'problem', %s, 9, %s, 'founder', '%s')" \
    "${WS1}" "${PROJ1}" "${RS1}" "$1" "$2" "$4" "$3" "${Q2P_OP}"
}
assert "QR-13. a primary source with only a context link is refused at commit" \
  "$(q2p_state "with c as ($(q2p_cand hypothesis null "'${SSITE1}'" null) returning id) insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id) select id, '${SSITE1}', 'context', null, '${WS1}', '${PROJ1}', 'founder', '${Q2P_OP}' from c; set constraints all immediate;")" "23514"
assert "QR-13. a primary source that is a verbatim link is accepted" \
  "$(q2p_state "with c as ($(q2p_cand observed "'public_verifiable'" "'${SPUB1}'" null) returning id) insert into public.question_candidate_sources (candidate_id, source_id, relation, quoted_span, workspace_id, project_id, actor_type, actor_operator_id) select id, '${SPUB1}', 'verbatim', '${Q2P_TEXT}', '${WS1}', '${PROJ1}', 'founder', '${Q2P_OP}' from c; set constraints all immediate;")" "NO_ERROR"
assert "QR-13. observed without a verbatim buyer link is refused at commit" \
  "$(q2p_state "$(q2p_cand observed "'public_verifiable'" null null); set constraints all immediate;")" "23514"
assert "QR-13. adapted without a paraphrase basis is refused at commit" \
  "$(q2p_state "$(q2p_cand adapted "'public_verifiable'" null "'note'"); set constraints all immediate;")" "23514"
assert "QR-13. adapted without a note is refused" \
  "$(q2p_state "$(q2p_cand adapted "'public_verifiable'" null null);")" "23514"

# QR-14 — founder review can never record observed (Q1 R3).
q2p_class() { # <classification> <verification|null> <rule|null> <note|null>
  q2p_state "insert into public.approved_wording_classifications (version_id, workspace_id, project_id, classification, verification, rule, adaptation_note, actor_type, actor_operator_id) select id, '${WS1}', '${PROJ1}', '$1', $2, $3, $4, 'founder', '${Q2P_OP}' from public.buyer_question_versions where project_id = '${PROJ1}' limit 1;"
}
q2p_sql "insert into public.buyer_questions (project_id) values ('${PROJ1}') returning id;" >/dev/null
q2p_sql "insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance) select id, project_id, 1, 'Fixture version?', repeat('b',64), 'shortlist', 1, 1, 1, 'fixture', 'founder_supplied' from public.buyer_questions where project_id='${PROJ1}' limit 1;" >/dev/null
assert "QR-14. founder review recording observed is refused" "$(q2p_class observed "'public_verifiable'" "'founder_review'" null)" "23514"
assert "QR-14. founder review recording adapted with a note is accepted" "$(q2p_class adapted "'public_verifiable'" "'founder_review'" "'reworded'")" "NO_ERROR"
assert "QR-14. founder review recording adapted without a note is refused" "$(q2p_class adapted "'public_verifiable'" "'founder_review'" null)" "23514"
assert "QR-14. observed under inherited_unchanged is accepted" "$(q2p_class observed "'public_verifiable'" "'inherited_unchanged'" null)" "NO_ERROR"
assert "QR-14. pending_review with a rule is refused" "$(q2p_class pending_review null "'inherited_unchanged'" null)" "23514"

# ── QR-19 — approvals of 1, 2 and 3 questions through F4 ─────────────────
q2p_items() { # <origin> <candidate|null> <text> ... (triples) → JSON array
  local out="" sep=""
  while [[ $# -ge 3 ]]; do
    local cand="null"; [[ "$2" != "null" ]] && cand="\"$2\""
    out="${out}${sep}{\"origin\":\"$1\",\"candidate_id\":${cand},\"text\":\"$3\",\"prompt_hash\":\"$(q2p_sql "select public._q2p_sha256_hex('$3');")\"}"
    sep=","; shift 3
  done
  echo "[${out}]"
}
q2p_approve() { # <token> <rs> <items> <key> <hmac> [function]
  # The real RPC runs as service_role; a weakened fixture (schema level2_fixture,
  # which service_role cannot use) runs as the owner, like every other fixture.
  local as_role="set role service_role;"
  [[ "${6:-}" == level2_fixture.* ]] && as_role=""
  q2p_sql "${as_role} select concat_ws('|', status, approval_record_id, cardinality(version_ids)) from ${6:-public.approve_buyer_question_set}('$1', '$2', '$3'::jsonb, '$4', '${7:-consent-v1}', repeat('c', 64), '$5', 'k1');"
}
q2p_approve_state() { # SQLSTATE of the same call as service_role
  sqlstate_as_role service_role "perform public.approve_buyer_question_set('$1', '$2', '$3'::jsonb, '$4', 'consent-v1', repeat('c', 64), '$5', 'k1');"
}
CONSENT_OK="$(q2p_sql "select repeat('c', 64);")"

ITEMS1="$(q2p_items recommended_unchanged "${COBS1}" "${Q2P_TEXT}")"
R1="$(q2p_approve "${TOK1}" "${RS1}" "${ITEMS1}" key-one "${HMAC1}")"
REC1="$(cut -d'|' -f2 <<<"${R1}")"
assert "QR-19. one question approved" "$(cut -d'|' -f1,3 <<<"${R1}")" "APPROVED|1"
assert "QR-19. every approved version's approved_by is the approval record id" \
  "$(q2p_sql "select count(*) from public.buyer_question_versions v join public.approval_records a on v.id = any(a.approved_version_ids) where a.id='${REC1}' and v.approved_by = a.id and v.approved_at is not null;")" "1"
assert "QR-19. unchanged observed candidate: observed / inherited_unchanged / public_verifiable" \
  "$(q2p_sql "select c.classification || '/' || c.rule || '/' || c.verification from public.approved_wording_classifications c join public.approval_records a on c.version_id = any(a.approved_version_ids) where a.id='${REC1}';")" "observed/inherited_unchanged/public_verifiable"
assert "QR-19. version fields follow the Q1 v1 mapping (cv 4, win 4, priority 16, founder_supplied)" \
  "$(q2p_sql "select v.commercial_value || '/' || v.winnability || '/' || v.priority || '/' || v.provenance || '/' || v.intent_type from public.buyer_question_versions v join public.approval_records a on v.id = any(a.approved_version_ids) where a.id='${REC1}';")" "4/4/16/founder_supplied/shortlist"
assert "QR-19. every row written is invitation_holder with null account and membership" \
  "$(q2p_sql "select (select count(*) from public.approval_records where id='${REC1}' and actor_type='invitation_holder' and actor_account_id is null and actor_membership_id is null and actor_session_id='${SES1}' and actor_invitation_id='${INV1}') || '/' || (select count(*) from public.buyer_question_version_origins where approval_record_id='${REC1}' and actor_type='invitation_holder' and actor_account_id is null and actor_membership_id is null) || '/' || (select count(*) from public.approved_wording_classifications c join public.approval_records a on c.version_id = any(a.approved_version_ids) where a.id='${REC1}' and c.actor_type='invitation_holder' and c.actor_account_id is null);")" "1/1/1"

REV2="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'two');")"
ITEMS2="$(q2p_items recommended_edited "$(q2p_json "${REV2}" c_adp)" "What invoicing tool suits small accounting firms?" customer_written null "Which billing app do accountants recommend?")"
R2="$(q2p_approve "$(q2p_json "${REV2}" ses_token)" "$(q2p_json "${REV2}" rs)" "${ITEMS2}" key-two "$(q2p_json "${REV2}" hmac)")"
REC2="$(cut -d'|' -f2 <<<"${R2}")"
assert "QR-19. two questions approved" "$(cut -d'|' -f1,3 <<<"${R2}")" "APPROVED|2"
assert "QR-19. edited text with no exact source span stays pending_review; customer-written is pending, customer_supplied, 1/1/1" \
  "$(q2p_sql "select string_agg(o.origin || ':' || c.classification || ':' || v.provenance || ':' || v.commercial_value || v.winnability || v.priority, ',' order by o.origin) from public.buyer_question_version_origins o join public.approved_wording_classifications c on c.version_id=o.version_id join public.buyer_question_versions v on v.id=o.version_id where o.approval_record_id='${REC2}';")" \
  "customer_written:pending_review:customer_supplied:111,recommended_edited:pending_review:founder_supplied:224"

REV3="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'three');")"
ITEMS3="$(q2p_items recommended_edited "$(q2p_json "${REV3}" c_adp)" "${Q2P_TEXT}" replaced_with_candidate "$(q2p_json "${REV3}" c_hyp)" "Is there an invoicing tool built for accountants?" customer_written null "Which billing app do accountants recommend?")"
R3="$(q2p_approve "$(q2p_json "${REV3}" ses_token)" "$(q2p_json "${REV3}" rs)" "${ITEMS3}" key-three "$(q2p_json "${REV3}" hmac)")"
REC3="$(cut -d'|' -f2 <<<"${R3}")"
assert "QR-19. three questions approved" "$(cut -d'|' -f1,3 <<<"${R3}")" "APPROVED|3"
assert "QR-19. edited to an exact verbatim span of the primary source: observed / exact_source_match; replaced hypothesis: inherited" \
  "$(q2p_sql "select string_agg(o.origin || ':' || c.classification || ':' || coalesce(c.rule, '-'), ',' order by o.origin) from public.buyer_question_version_origins o join public.approved_wording_classifications c on c.version_id=o.version_id where o.approval_record_id='${REC3}';")" \
  "customer_written:pending_review:-,recommended_edited:observed:exact_source_match,replaced_with_candidate:hypothesis:inherited_unchanged"
assert "QR-19. no workspace_members row was created by any approval" \
  "$(q2p_sql "select count(*) from public.workspace_members;")" "${Q2P_MEMBERS_BEFORE}"

# ── QR-20 / QR-28 / QR-08 — uniform refusals, no writes ──────────────────
REVR="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'refuse');")"
RSR="$(q2p_json "${REVR}" rs)"; INVR="$(q2p_json "${REVR}" inv)"; HMACR="$(q2p_json "${REVR}" hmac)"
ITEMSR="$(q2p_items recommended_unchanged "$(q2p_json "${REVR}" c_obs)" "${Q2P_TEXT}")"
APPROVALS_BEFORE="$(q2p_sql "select count(*) from public.approval_records;")"
TOK_ABS="$(q2p_sql "select level2_fixture.make_session('${INVR}', 'abs', interval '31 minutes', interval '1 minute');")"
TOK_IDLE="$(q2p_sql "select level2_fixture.make_session('${INVR}', 'idle', interval '20 minutes', interval '16 minutes');")"
assert "QR-20. an absolutely expired session is refused" "$(q2p_approve_state "${TOK_ABS}" "${RSR}" "${ITEMSR}" key-r1 "${HMACR}")" "42501"
assert "QR-20. an idle session (16 min) is refused" "$(q2p_approve_state "${TOK_IDLE}" "${RSR}" "${ITEMSR}" key-r2 "${HMACR}")" "42501"
assert "QR-20. the invitation token presented as a session token (wrong purpose) is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" inv_token)" "${RSR}" "${ITEMSR}" key-r3 "${HMACR}")" "42501"
assert "QR-20 / QR-28. a session for another research set, with that set's ids, is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" ses_token)" "${RS1}" "$(q2p_items recommended_unchanged "${COBS1}" "${Q2P_TEXT}")" key-r4 "${HMACR}")" "42501"
assert "QR-20. a changed request email HMAC is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" ses_token)" "${RSR}" "${ITEMSR}" key-r5 "$(q2p_sql "select repeat('d', 64);")")" "42501"
assert "QR-20. a candidate from another research set is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" ses_token)" "${RSR}" "$(q2p_items recommended_unchanged "${COBS1}" "${Q2P_TEXT}")" key-r6 "${HMACR}")" "42501"
REVW2="$(q2p_sql "select level2_fixture.make_review('${WS2}', '${PROJ2}', '${REQ2}', 'ws2');")"
assert "QR-08. a workspace-1 session presented with workspace 2's research set is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" ses_token)" "$(q2p_json "${REVW2}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVW2}" c_obs)" "${Q2P_TEXT}")" key-r7 "${HMACR}")" "42501"
q2p_sql "update public.question_review_invitations set revoked_at = now() where id='${INVR}';" >/dev/null
assert "QR-20. a revoked invitation ends its live session immediately" \
  "$(q2p_approve_state "$(q2p_json "${REVR}" ses_token)" "${RSR}" "${ITEMSR}" key-r8 "${HMACR}")" "42501"
assert "QR-20. no refused call wrote anything" "$(q2p_sql "select count(*) from public.approval_records;")" "${APPROVALS_BEFORE}"
assert "QR-04. revoked_at cannot be set twice" "$(q2p_state "update public.question_review_invitations set revoked_at = now() where id='${INVR}';")" "55000"
assert "QR-04. exchanged_at cannot be reset to null" "$(q2p_state "update public.question_review_invitations set exchanged_at = null where id='${INVR}';")" "55000"
assert "QR-03. an invitation's token hash is immutable" "$(q2p_state "update public.question_review_invitations set token_hash = repeat('e', 64) where id='${INV1}';")" "55000"
assert "QR-04. a session's revoked_at cannot be set twice" \
  "$(q2p_state "update public.question_review_sessions set revoked_at = now() where id='${SES1}'; update public.question_review_sessions set revoked_at = now() + interval '1 second' where id='${SES1}';")" "55000"
assert "QR-03. last_seen_at cannot move backwards" "$(q2p_state "update public.question_review_sessions set last_seen_at = last_seen_at - interval '1 minute' where id='${SES1}';")" "55000"
assert "QR-03. a session's scope is immutable" "$(q2p_state "update public.question_review_sessions set research_set_id='${RS1}' where id='$(q2p_json "${REV2}" ses)';")" "55000"
assert "QR-20. a session cannot be created with another invitation's scope" \
  "$(q2p_state "insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id, token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version) values ('${INV1}', '${WS1}', '${PROJ1}', '${REQ1}', '${RSR}', repeat('f',64), now() + interval '10 minutes', now(), 'system', 'r', 'v1');")" "23503"

# ── QR-21 — all-or-nothing ───────────────────────────────────────────────
REVF="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'fault');")"
VERSIONS_BEFORE="$(q2p_sql "select count(*) from public.buyer_question_versions;")"
FAULT_RUN="$(psql_q "set l2.fault = 'on'; set role service_role; select status from public.approve_buyer_question_set('$(q2p_json "${REVF}" ses_token)', '$(q2p_json "${REVF}" rs)', '$(q2p_items recommended_unchanged "$(q2p_json "${REVF}" c_obs)" "${Q2P_TEXT}" customer_written null "Which billing app do accountants recommend?")'::jsonb, 'key-fault', 'consent-v1', repeat('c', 64), '$(q2p_json "${REVF}" hmac)', 'k1');" 2>&1 || true)"
assert "QR-21. a fault injected after the first question's writes aborts the committing call" "$(grep -c 'l2_injected_fault' <<<"${FAULT_RUN}")" "1"
assert "QR-21. everything rolled back: no approval record, no version" \
  "$(q2p_sql "select (select count(*) from public.approval_records where research_set_id='$(q2p_json "${REVF}" rs)') || '/' || ((select count(*) from public.buyer_question_versions) - ${VERSIONS_BEFORE});")" "0/0"

# ── QR-22 — idempotency ──────────────────────────────────────────────────
assert "QR-22. replay with the same key and set returns the original" \
  "$(q2p_approve "${TOK1}" "${RS1}" "${ITEMS1}" key-one "${HMAC1}")" "ALREADY_APPROVED|${REC1}|1"
assert "QR-22. the same key with a different set returns IDEMPOTENCY_KEY_CONFLICT (after authorisation)" \
  "$(q2p_approve "${TOK1}" "${RS1}" "$(q2p_items recommended_edited "${CADP1}" "Another wording entirely?")" key-one "${HMAC1}")" "IDEMPOTENCY_KEY_CONFLICT"
TOK1B="$(q2p_sql "select level2_fixture.make_session('${INV1}', 'one-b', interval '0 minutes', interval '0 minutes');")"
assert "QR-22. a new session replays only the exact approved set" \
  "$(q2p_approve "${TOK1B}" "${RS1}" "${ITEMS1}" key-one-b "${HMAC1}")" "ALREADY_APPROVED|${REC1}|1"
assert "QR-22e. a new session with a different set and a new key returns SET_ALREADY_APPROVED" \
  "$(q2p_approve "${TOK1B}" "${RS1}" "$(q2p_items replaced_with_candidate "${CHYP1}" "Is there an invoicing tool built for accountants?")" key-one-c "${HMAC1}")" "SET_ALREADY_APPROVED"
REVK="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'keyscope');")"
assert "QR-22. keys are scoped to the research set: key-one on another set creates that set's own approval" \
  "$(q2p_approve "$(q2p_json "${REVK}" ses_token)" "$(q2p_json "${REVK}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVK}" c_obs)" "${Q2P_TEXT}")" key-one "$(q2p_json "${REVK}" hmac)" | cut -d'|' -f1,3)" "APPROVED|1"

# ── QR-23 — two concurrent approvals with the same key ──────────────────
qr23() { # <function> → "S2 outcome|approval records for the set"
  local fn=$1 rev rs inv t1 t2 items hm
  rev="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'race-${fn##*.}');")"
  rs="$(q2p_json "${rev}" rs)"; inv="$(q2p_json "${rev}" inv)"; hm="$(q2p_json "${rev}" hmac)"
  t1="$(q2p_json "${rev}" ses_token)"
  t2="$(q2p_sql "select level2_fixture.make_session('${inv}', 'race2-${fn##*.}', interval '0 minutes', interval '0 minutes');")"
  items="$(q2p_items recommended_unchanged "$(q2p_json "${rev}" c_obs)" "${Q2P_TEXT}")"
  q2p_open S1 7; q2p_open S2 8
  q2p_send 7 "begin; select status from ${fn}('${t1}', '${rs}', '${items}'::jsonb, 'key-race-${fn##*.}', 'consent-v1', repeat('c', 64), '${hm}', 'k1');"
  q2p_idle_in_tx S1 || echo "barrier S1 failed" >&2
  q2p_send 8 "select status from ${fn}('${t2}', '${rs}', '${items}'::jsonb, 'key-race-${fn##*.}', 'consent-v1', repeat('c', 64), '${hm}', 'k1');"
  q2p_lock_wait S2 || echo "barrier S2 failed" >&2
  q2p_send 7 "commit;"
  q2p_settled S2 || true
  q2p_close S1 7; q2p_close S2 8
  echo "$(q2p_out S2 | grep -oE '^(APPROVED|ALREADY_APPROVED|ERROR:  [0-9A-Z]{5})$' | tail -n1)|$(q2p_sql "select count(*) from public.approval_records where research_set_id='${rs}';")"
}
assert "QR-23 (weakened, no research-set lock). the second caller does NOT replay" \
  "$(qr23 level2_fixture.approve_set_no_set_lock)" "ERROR:  23505|1"
assert "QR-23. exactly one durable approval; the other caller replays it" \
  "$(qr23 public.approve_buyer_question_set)" "ALREADY_APPROVED|1"

# ── QR-24 — exact text and duplicate hashes ──────────────────────────────
REVD="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'dup');")"
assert "QR-24. a duplicate prompt hash within the set is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVD}" ses_token)" "$(q2p_json "${REVD}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVD}" c_obs)" "${Q2P_TEXT}" customer_written null "${Q2P_TEXT}")" key-d1 "$(q2p_json "${REVD}" hmac)")" "22023"
assert "QR-24. 'recommended unchanged' text that differs from the candidate is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVD}" ses_token)" "$(q2p_json "${REVD}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVD}" c_obs)" "Which invoicing tool suits a small accounting firm ?")" key-d2 "$(q2p_json "${REVD}" hmac)")" "22023"
assert "QR-24. a prompt_hash that is not the SHA-256 of the exact text is refused" \
  "$(q2p_approve_state "$(q2p_json "${REVD}" ses_token)" "$(q2p_json "${REVD}" rs)" "[{\"origin\":\"customer_written\",\"candidate_id\":null,\"text\":\"A question?\",\"prompt_hash\":\"$(q2p_sql "select repeat('0', 64);")\"}]" key-d3 "$(q2p_json "${REVD}" hmac)")" "22023"
assert "QR-24. four questions are refused" \
  "$(q2p_approve_state "$(q2p_json "${REVD}" ses_token)" "$(q2p_json "${REVD}" rs)" "$(q2p_items customer_written null "One?" customer_written null "Two?" customer_written null "Three?" customer_written null "Four?")" key-d4 "$(q2p_json "${REVD}" hmac)")" "22023"

# ── QR-25 — no paid effect ───────────────────────────────────────────────
assert "QR-25. no protocol and no execution job was created" \
  "$(q2p_sql "select (select count(*) from public.protocols) || '/' || (select count(*) from public.protocol_execution_jobs);")" "${Q2P_PROTOCOLS_BEFORE}/${Q2P_JOBS_BEFORE}"
assert "QR-25. no launch-selection table exists in Q2′-1" "$(q2p_sql "select (to_regclass('public.buyer_question_launch_selections') is null)::text;")" "true"
assert "QR-25. request statuses are unchanged" \
  "$(q2p_sql "select string_agg(distinct status, ',') from public.snapshot_requests where id in ('${REQ1}', '${REQ2}');")" "pending_approval"

# ── QR-26 — exception queue ──────────────────────────────────────────────
EXI="$(q2p_sql "insert into public.exception_items (workspace_id, kind, reason, actor_type, actor_operator_id) values ('${WS1}', 'research', 'needs a second source', 'founder', '${Q2P_OP}') returning id;")"
q2p_sql "insert into public.exception_events (item_id, workspace_id, event, actor_type, actor_operator_id, created_at) values ('${EXI}', '${WS1}', 'opened', 'founder', '${Q2P_OP}', now() - interval '1 minute'), ('${EXI}', '${WS1}', 'resolved', 'founder', '${Q2P_OP}', now());" >/dev/null
assert "QR-26. the current state is the latest event" \
  "$(q2p_sql "select event from public.exception_events where item_id='${EXI}' order by created_at desc limit 1;")" "resolved"
assert "QR-26. an event cannot be edited" "$(q2p_state "update public.exception_events set event = 'opened' where item_id='${EXI}';")" "55000"
assert "QR-26. an 'assigned' event needs an assignee" \
  "$(q2p_state "insert into public.exception_events (item_id, workspace_id, event, actor_type, actor_operator_id) values ('${EXI}', '${WS1}', 'assigned', 'founder', '${Q2P_OP}');")" "23514"

# ── QR-05 / QR-34 — actor shapes and approval-record consistency ────────
q2p_actor() { # <actor columns> <values> — a question_sources row with the given actor
  q2p_state "insert into public.question_sources (workspace_id, project_id, source_kind, url, retrieved_at, excerpt, excerpt_sha256, buyer_authored, verification, personal_data_removed, $1) values ('${WS1}', '${PROJ1}', 'public_review', 'https://r.test/a', now(), 'Fine.', public._q2p_sha256_hex('Fine.'), true, 'public_verifiable', true, $2);"
}
assert "QR-05. system without rule fields is refused" "$(q2p_actor "actor_type" "'system'")" "23514"
assert "QR-05. customer_account without a membership is refused" "$(q2p_actor "actor_type, actor_account_id" "'customer_account', '${ACCT_A}'")" "23514"
assert "QR-05. customer_account with an invitation id is refused" "$(q2p_actor "actor_type, actor_account_id, actor_membership_id, actor_invitation_id" "'customer_account', '${ACCT_A}', '${M1A}', '${INV1}'")" "23514"
assert "QR-05. invitation_holder without a session is refused" "$(q2p_actor "actor_type, actor_invitation_id" "'invitation_holder', '${INV1}'")" "23514"
assert "QR-05. invitation_holder with an account id is refused" "$(q2p_actor "actor_type, actor_invitation_id, actor_session_id, actor_account_id" "'invitation_holder', '${INV1}', '${SES1}', '${ACCT_A}'")" "23514"
assert "QR-05. founder with an account id is refused" "$(q2p_actor "actor_type, actor_operator_id, actor_account_id" "'founder', '${Q2P_OP}', '${ACCT_A}'")" "23514"
assert "QR-05. a valid customer_account actor (own membership, own workspace) is accepted" "$(q2p_actor "actor_type, actor_account_id, actor_membership_id" "'customer_account', '${ACCT_A}', '${M1A}'")" "NO_ERROR"
assert "QR-05. a membership belonging to a different account is refused" "$(q2p_actor "actor_type, actor_account_id, actor_membership_id" "'customer_account', '${ACCT_B}', '${M1A}'")" "23503"
assert "QR-05. a membership of a different workspace is refused" "$(q2p_actor "actor_type, actor_account_id, actor_membership_id" "'customer_account', '${ACCT_B}', '${M2B}'")" "23503"
assert "QR-05. a valid invitation_holder actor is accepted" "$(q2p_actor "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '${INV1}', '${SES1}'")" "NO_ERROR"
assert "QR-05. a session belonging to a different invitation is refused" "$(q2p_actor "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '${INVR}', '${SES1}'")" "23503"
assert "QR-05. a session of another project is refused" "$(q2p_actor "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '$(q2p_json "${REVW2}" inv)', '$(q2p_json "${REVW2}" ses)'")" "23503"
q2p_ar() { # <session_type> <actor columns> <values> [step_up]
  q2p_state "insert into public.approval_records (workspace_id, project_id, snapshot_request_id, research_set_id, action_type, approved_version_ids, prompt_hashes, session_type, session_id, step_up_event_id, verified_email_hmac, email_hmac_key_id, consent_text_version, consent_text_sha256, idempotency_key, set_fingerprint, $2) values ('${WS1}', '${PROJ1}', '${REQ1}', '${RSR}', 'approve_buyer_question_set', array[gen_random_uuid()], array[repeat('a',64)], '$1', '${SES1}', ${4:-null}, repeat('a',64), 'k1', 'v1', repeat('a',64), 'k-' || gen_random_uuid(), repeat('a',64), $3);"
}
assert "QR-34. review_invitation with a customer_account actor is refused" "$(q2p_ar review_invitation "actor_type, actor_account_id, actor_membership_id" "'customer_account', '${ACCT_A}', '${M1A}'")" "23514"
assert "QR-34. account with an invitation_holder actor is refused" "$(q2p_ar account "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '${INV1}', '${SES1}'" "gen_random_uuid()")" "23514"
assert "QR-34. review_invitation whose actor session differs from session_id is refused" "$(q2p_ar review_invitation "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '$(q2p_json "${REV2}" inv)', '$(q2p_json "${REV2}" ses)'")" "23514"
assert "QR-34. account without a step-up event is refused" "$(q2p_ar account "actor_type, actor_account_id, actor_membership_id" "'customer_account', '${ACCT_A}', '${M1A}'")" "23514"
assert "QR-34. a consistent review_invitation record is accepted" "$(q2p_ar review_invitation "actor_type, actor_invitation_id, actor_session_id" "'invitation_holder', '${INV1}', '${SES1}'")" "NO_ERROR"
assert "QR-34. an action type other than approve_buyer_question_set is refused" \
  "$(q2p_state "insert into public.approval_records (workspace_id, project_id, snapshot_request_id, research_set_id, action_type, approved_version_ids, prompt_hashes, session_type, session_id, verified_email_hmac, email_hmac_key_id, consent_text_version, consent_text_sha256, idempotency_key, set_fingerprint, actor_type, actor_invitation_id, actor_session_id) values ('${WS1}', '${PROJ1}', '${REQ1}', '${RSR}', 'launch', array[gen_random_uuid()], array[repeat('a',64)], 'review_invitation', '${SES1}', repeat('a',64), 'k1', 'v1', repeat('a',64), 'k-x', repeat('a',64), 'invitation_holder', '${INV1}', '${SES1}');")" "23514"

# ── QR-03 — append-only, every table with rows ───────────────────────────
for t in workspaces workspace_projects question_research_sets question_sources question_candidates question_candidate_sources approval_records buyer_question_version_origins approved_wording_classifications exception_items exception_events; do
  assert "QR-03. ${t}: update refused" "$(q2p_state "update public.${t} set actor_type = actor_type where ctid = (select ctid from public.${t} limit 1);" 2>/dev/null)" "55000"
  assert "QR-03. ${t}: delete refused" "$(q2p_state "delete from public.${t} where ctid = (select ctid from public.${t} limit 1);")" "55000"
  assert "QR-03. ${t}: truncate refused" "$(q2p_state "truncate public.${t} cascade;")" "55000"
done

# ── Q2′-1 remediation round (R1–R4) ──────────────────────────────────────

# R1 — verified email before approval.
REVU="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r1u');")"
RSU="$(q2p_json "${REVU}" rs)"; HMACU="$(q2p_json "${REVU}" hmac)"
ITEMSU="$(q2p_items recommended_unchanged "$(q2p_json "${REVU}" c_obs)" "${Q2P_TEXT}")"
Q2P_INV_COLS="workspace_id, project_id, snapshot_request_id, research_set_id, email_hmac, email_hmac_key_id, email_verified_at, token_hash, expires_at, exchanged_at, created_at, actor_type, actor_operator_id"
q2p_inv_values() { # <verified expr> <exchanged expr> <token> [created expr] [expires expr]
  printf "'%s', '%s', '%s', '%s', '%s', 'k1', %s, public._q2p_token_hash('zypact.question_review_invitation.v1', '%s'), %s, %s, %s, 'founder', '%s'" \
    "${WS1}" "${PROJ1}" "${REQ1}" "${RSU}" "${HMACU}" "$1" "$3" "${5:-now() + interval '7 days'}" "$2" "${4:-now()}" "${Q2P_OP}"
}
Q2P_SES_INSERT="insert into public.question_review_sessions (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id, token_hash, absolute_expires_at, last_seen_at, actor_type, rule_id, rule_version) select i.id, '${WS1}', '${PROJ1}', '${REQ1}', '${RSU}', public._q2p_token_hash('zypact.question_review_session.v1', 'r1-session-token-0123456789abcdef0123456789'), now() + interval '20 minutes', now(), 'system', 'invitation_exchange', 'v1' from i;"
q2p_r1_call() { printf "perform %s('r1-session-token-0123456789abcdef0123456789', '%s', '%s'::jsonb, 'r1-key', 'consent-v1', repeat('c', 64), '%s', 'k1');" "$1" "${RSU}" "${ITEMSU}" "${HMACU}"; }
assert "QR-20e. an exchanged invitation without a verified email is refused by the table" \
  "$(q2p_state "insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values null "now()" r1-tok-a));")" "23514"
assert "QR-20e. an invitation can still be created before the email is verified (not yet exchanged)" \
  "$(q2p_state "insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values null null r1-tok-b));")" "NO_ERROR"
assert "QR-20k. a session cannot be created for an unexchanged invitation" \
  "$(q2p_state "with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values "now()" null r1-tok-c)) returning id) ${Q2P_SES_INSERT}")" "23514"
assert "QR-20f. F4's own check: with the table rule dropped, an exchanged but unverified invitation is refused" \
  "$(q2p_state "alter table public.question_review_invitations drop constraint question_review_invitations_exchange_needs_verified_email; set local session_replication_role = replica; with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values null "now()" r1-tok-d)) returning id) ${Q2P_SES_INSERT} set local session_replication_role = origin; $(q2p_r1_call public.approve_buyer_question_set)")" "42501"
assert "QR-20f (weakened, no email check). the same unverified invitation is APPROVED" \
  "$(q2p_state "alter table public.question_review_invitations drop constraint question_review_invitations_exchange_needs_verified_email; set local session_replication_role = replica; with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values null "now()" r1-tok-e)) returning id) ${Q2P_SES_INSERT} set local session_replication_role = origin; $(q2p_r1_call level2_fixture.approve_set_no_email_check)")" "NO_ERROR"
assert "QR-20h. an invitation issued 8 days ago (expired) cannot get a session" \
  "$(q2p_state "with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values "now()" "now() - interval '7 days'" r1-tok-f "now() - interval '8 days'" "now() - interval '1 day'")) returning id) ${Q2P_SES_INSERT}")" "23514"
assert "QR-20g. F4's own check: a session forced to outlive its expired invitation is refused" \
  "$(q2p_state "set local session_replication_role = replica; with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values "now()" "now() - interval '7 days'" r1-tok-g "now() - interval '8 days'" "now() - interval '1 day'")) returning id) ${Q2P_SES_INSERT} set local session_replication_role = origin; $(q2p_r1_call public.approve_buyer_question_set)")" "42501"
assert "QR-20k. F4's own check: a session forced onto an unexchanged invitation is refused" \
  "$(q2p_state "set local session_replication_role = replica; with i as (insert into public.question_review_invitations (${Q2P_INV_COLS}) values ($(q2p_inv_values "now()" null r1-tok-h)) returning id) ${Q2P_SES_INSERT} set local session_replication_role = origin; $(q2p_r1_call public.approve_buyer_question_set)")" "42501"
REVS="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r1s');")"
INVS2="$(q2p_sql "insert into public.question_review_invitations (workspace_id, project_id, snapshot_request_id, research_set_id, email_hmac, email_hmac_key_id, token_hash, expires_at, actor_type, actor_operator_id) values ('${WS1}', '${PROJ1}', '${REQ1}', '$(q2p_json "${REVS}" rs)', '$(q2p_json "${REVS}" hmac)', 'k1', public._q2p_token_hash('zypact.question_review_invitation.v1', 'r1-reissue'), now() + interval '7 days', 'founder', '${Q2P_OP}') returning id;")"
q2p_sql "update public.question_review_invitations set revoked_at = now(), superseded_by = '${INVS2}' where id = '$(q2p_json "${REVS}" inv)';" >/dev/null
assert "QR-20i. a superseded (reissued) invitation ends its session" \
  "$(q2p_approve_state "$(q2p_json "${REVS}" ses_token)" "$(q2p_json "${REVS}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVS}" c_obs)" "${Q2P_TEXT}")" r1-s "$(q2p_json "${REVS}" hmac)")" "42501"
REVJ="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r1j');")"
q2p_sql "update public.question_review_sessions set revoked_at = now() where id = '$(q2p_json "${REVJ}" ses)';" >/dev/null
assert "QR-20j. a revoked session is refused although its invitation is valid" \
  "$(q2p_approve_state "$(q2p_json "${REVJ}" ses_token)" "$(q2p_json "${REVJ}" rs)" "$(q2p_items recommended_unchanged "$(q2p_json "${REVJ}" c_obs)" "${Q2P_TEXT}")" r1-j "$(q2p_json "${REVJ}" hmac)")" "42501"

# R2 — observed only when the source backs the exact text.
q2p_r2() { q2p_sql "select level2_fixture.r2_case('${WS1}', '${PROJ1}', '${REQ1}', '$1', '$2'${3:+, '$3'});"; }
assert "QR-36g. control: an exact verbatim span on a buyer source → observed, with the winnability bonus (1+2+1)" \
  "$(q2p_r2 ctl control)" "observed/inherited_unchanged/public_verifiable|4"
assert "QR-36g. control, customer material → observed and stays customer_provided" \
  "$(q2p_r2 ctlc control_customer)" "observed/inherited_unchanged/customer_provided|4"
assert "QR-36a. fabricated: the span is no longer in the source excerpt → pending_review, no bonus" \
  "$(q2p_r2 fab fabricated)" "pending_review//|3"
assert "QR-36b. mismatched: the candidate text is not its verbatim span → pending_review" \
  "$(q2p_r2 mis mismatched)" "pending_review//|3"
assert "QR-36b (weakened, no span check). the mismatched candidate is promoted to observed" \
  "$(q2p_r2 misw mismatched level2_fixture.approve_set_no_span_check)" "observed/inherited_unchanged/public_verifiable|4"
assert "QR-36c. unverified: the primary source is not buyer-authored → pending_review" \
  "$(q2p_r2 nb not_buyer)" "pending_review//|3"
assert "QR-36d. unverified: the candidate claims customer_provided but the source is public → pending_review" \
  "$(q2p_r2 vm verification_mismatch)" "pending_review//|3"
assert "QR-36e. site copy as the primary verbatim source → pending_review" \
  "$(q2p_r2 sc site_copy)" "pending_review//|3"
assert "QR-36g. adapted with its paraphrase basis → adapted" \
  "$(q2p_r2 adc adapted_control)" "adapted/inherited_unchanged/public_verifiable|3"
assert "QR-36f. adapted whose basis was removed → pending_review" \
  "$(q2p_r2 adn adapted_no_basis)" "pending_review//|3"

# QR-40 — the shared Q1 compatibility vectors through the real F4.
Q2P_VECTORS="$(cat scripts/fixtures/q2p1-wording-vectors.json)"
while IFS='|' read -r vid vgot vexp; do
  [[ -n "${vid}" ]] && assert "QR-40. vector ${vid}: database ${vexp}" "${vgot}" "${vexp}"
done <<<"$(psql_q "select id || '|' || got || '|' || expected from level2_fixture.run_vectors('${WS1}', '${PROJ1}', '${REQ1}', '${Q2P_VECTORS}'::jsonb);")"

# R3 — canonical, order-independent fingerprint; set-scoped keys; explicit statuses after authorisation.
REVF2="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r3');")"
TOKF="$(q2p_json "${REVF2}" ses_token)"; RSF="$(q2p_json "${REVF2}" rs)"; HMF="$(q2p_json "${REVF2}" hmac)"; COF="$(q2p_json "${REVF2}" c_obs)"
ITEMS_AB="$(q2p_items recommended_unchanged "${COF}" "${Q2P_TEXT}" customer_written null "Which billing app do accountants recommend?")"
ITEMS_BA="$(q2p_items customer_written null "Which billing app do accountants recommend?" recommended_unchanged "${COF}" "${Q2P_TEXT}")"
RF="$(q2p_approve "${TOKF}" "${RSF}" "${ITEMS_AB}" r3-key "${HMF}")"
RECF="$(cut -d'|' -f2 <<<"${RF}")"
VIDS_F="$(q2p_sql "select approved_version_ids::text from public.approval_records where id='${RECF}';")"
assert "QR-22. two questions approved" "$(cut -d'|' -f1,3 <<<"${RF}")" "APPROVED|2"
assert "QR-22a. reordered items, same key → ALREADY_APPROVED with the original record" \
  "$(q2p_approve "${TOKF}" "${RSF}" "${ITEMS_BA}" r3-key "${HMF}")" "ALREADY_APPROVED|${RECF}|2"
assert "QR-22a. the stored version ids keep their original order" \
  "$(q2p_sql "select approved_version_ids::text from public.approval_records where id='${RECF}';")" "${VIDS_F}"
assert "QR-22b. reordered items, a new key → ALREADY_APPROVED with the original record" \
  "$(q2p_approve "${TOKF}" "${RSF}" "${ITEMS_BA}" r3-key-2 "${HMF}")" "ALREADY_APPROVED|${RECF}|2"
assert "QR-22c. same key, a different item set → IDEMPOTENCY_KEY_CONFLICT" \
  "$(q2p_approve "${TOKF}" "${RSF}" "$(q2p_items recommended_unchanged "${COF}" "${Q2P_TEXT}")" r3-key "${HMF}")" "IDEMPOTENCY_KEY_CONFLICT"
assert "QR-22d. same key and items, a different consent text version → IDEMPOTENCY_KEY_CONFLICT" \
  "$(q2p_approve "${TOKF}" "${RSF}" "${ITEMS_AB}" r3-key "${HMF}" public.approve_buyer_question_set consent-v2)" "IDEMPOTENCY_KEY_CONFLICT"
assert "QR-22. conflicts wrote nothing (one approval record for the set)" \
  "$(q2p_sql "select count(*) from public.approval_records where research_set_id='${RSF}';")" "1"
assert "QR-22g. an invalid token with a conflicting set gets the uniform refusal, not a status" \
  "$(q2p_approve_state "$(q2p_sql "select repeat('z', 48);")" "${RSF}" "$(q2p_items recommended_unchanged "${COF}" "${Q2P_TEXT}")" r3-key "${HMF}")" "42501"
q2p_sql "update public.question_review_sessions set revoked_at = now() where id = '$(q2p_json "${REVF2}" ses)';" >/dev/null
assert "QR-22f. a replay requires a valid session (revoked → uniform refusal)" \
  "$(q2p_approve_state "${TOKF}" "${RSF}" "${ITEMS_AB}" r3-key "${HMF}")" "42501"
REVW="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r3w');")"
ITEMS_W_AB="$(q2p_items recommended_unchanged "$(q2p_json "${REVW}" c_obs)" "${Q2P_TEXT}" customer_written null "Which billing app do accountants recommend?")"
ITEMS_W_BA="$(q2p_items customer_written null "Which billing app do accountants recommend?" recommended_unchanged "$(q2p_json "${REVW}" c_obs)" "${Q2P_TEXT}")"
q2p_approve "$(q2p_json "${REVW}" ses_token)" "$(q2p_json "${REVW}" rs)" "${ITEMS_W_AB}" r3w-key "$(q2p_json "${REVW}" hmac)" level2_fixture.approve_set_ordered_fingerprint >/dev/null
assert "QR-22w (weakened, order-dependent fingerprint). a reordered replay is a CONFLICT" \
  "$(q2p_approve "$(q2p_json "${REVW}" ses_token)" "$(q2p_json "${REVW}" rs)" "${ITEMS_W_BA}" r3w-key "$(q2p_json "${REVW}" hmac)" level2_fixture.approve_set_ordered_fingerprint)" "IDEMPOTENCY_KEY_CONFLICT"

# QR-23r — concurrent approvals with the same key, the second reordered.
REVC="$(q2p_sql "select level2_fixture.make_review('${WS1}', '${PROJ1}', '${REQ1}', 'r3c');")"
TC1="$(q2p_json "${REVC}" ses_token)"
TC2="$(q2p_sql "select level2_fixture.make_session('$(q2p_json "${REVC}" inv)', 'r3c2', interval '0 minutes', interval '0 minutes');")"
IC_AB="$(q2p_items recommended_unchanged "$(q2p_json "${REVC}" c_obs)" "${Q2P_TEXT}" customer_written null "Which billing app do accountants recommend?")"
IC_BA="$(q2p_items customer_written null "Which billing app do accountants recommend?" recommended_unchanged "$(q2p_json "${REVC}" c_obs)" "${Q2P_TEXT}")"
q2p_open S1 7; q2p_open S2 8
q2p_send 7 "begin; select approval_record_id from public.approve_buyer_question_set('${TC1}', '$(q2p_json "${REVC}" rs)', '${IC_AB}'::jsonb, 'r3c-key', 'consent-v1', repeat('c', 64), '$(q2p_json "${REVC}" hmac)', 'k1');"
q2p_idle_in_tx S1 || echo "barrier S1 failed" >&2
q2p_send 8 "select status || ':' || approval_record_id from public.approve_buyer_question_set('${TC2}', '$(q2p_json "${REVC}" rs)', '${IC_BA}'::jsonb, 'r3c-key', 'consent-v1', repeat('c', 64), '$(q2p_json "${REVC}" hmac)', 'k1');"
q2p_lock_wait S2 || echo "barrier S2 failed" >&2
q2p_send 7 "commit;"
q2p_settled S2 || true
q2p_close S1 7; q2p_close S2 8
assert "QR-23r. concurrent same-key approvals, the second reordered: one approval; the other replays it" \
  "$(q2p_out S2 | grep -E '^ALREADY_APPROVED:' | tail -n1)|$(q2p_sql "select count(*) from public.approval_records where research_set_id='$(q2p_json "${REVC}" rs)';")" \
  "ALREADY_APPROVED:$(q2p_out S1 | grep -E '^[0-9a-f-]{36}$' | tail -n1)|1"

# R4 — F1 and F7 without exception absorption.
# <function> <key> <S2 name> <S2 isolation> <S2 snapshot first> → "S1 outcome|S2 outcome|blocked|workspaces with key"
qr37() {
  local fn=$1 key=$2 name2=$3 iso=$4 snap=$5 blocked
  q2p_open S1 7; q2p_open S2 8
  [[ "${snap}" == "yes" ]] && { q2p_send 8 "begin isolation level ${iso}; select 1;"; q2p_idle_in_tx S2 || true; }
  q2p_send 7 "begin; select concat_ws('|', status, workspace_id) from ${fn}('${ACCT_A}', 'Race name', '${key}', 'founder', '${Q2P_OP}');"
  q2p_idle_in_tx S1 || echo "barrier S1 failed" >&2
  if [[ "${snap}" == "yes" ]]; then
    q2p_send 8 "select concat_ws('|', status, workspace_id) from ${fn}('${ACCT_A}', '${name2}', '${key}', 'founder', '${Q2P_OP}');"
  else
    q2p_send 8 "begin isolation level ${iso}; select concat_ws('|', status, workspace_id) from ${fn}('${ACCT_A}', '${name2}', '${key}', 'founder', '${Q2P_OP}');"
  fi
  if q2p_lock_wait S2; then blocked=blocked; else blocked=not_blocked; fi
  q2p_send 7 "commit;"
  q2p_settled S2 || true
  q2p_send 8 "commit;"
  q2p_close S1 7; q2p_close S2 8
  echo "$(q2p_out S1 | grep -E '^CREATED\|' | tail -n1)|$(q2p_out S2 | grep -oE '^(CREATED\|[0-9a-f-]{36}|ALREADY_CREATED\|[0-9a-f-]{36}|IDEMPOTENCY_KEY_CONFLICT|ERROR:  [0-9A-Z]{5})$' | tail -n1)|${blocked}|$(q2p_sql "select count(*) from public.workspaces where idempotency_key='${key}';")"
}
r="$(qr37 public.create_workspace_with_owner r4-a 'Race name' 'read committed' no)"
assert "QR-37a. F1, same key and body, READ COMMITTED: S2 waits on the key lock, then replays S1's workspace" \
  "$(cut -d'|' -f3,4,5,6 <<<"${r}")" "ALREADY_CREATED|$(cut -d'|' -f2 <<<"${r}")|blocked|1"
r="$(qr37 public.create_workspace_with_owner r4-b 'Another body' 'read committed' no)"
assert "QR-37b. F1, same key, different body: IDEMPOTENCY_KEY_CONFLICT; one workspace" \
  "$(cut -d'|' -f3,4,5 <<<"${r}")" "IDEMPOTENCY_KEY_CONFLICT|blocked|1"
r="$(qr37 public.create_workspace_with_owner r4-c 'Race name' 'repeatable read' yes)"
assert "QR-37c. F1, REPEATABLE READ stale snapshot: explicit 23505, never a returned row; one workspace" \
  "$(cut -d'|' -f3,4,5 <<<"${r}")" "ERROR:  23505|blocked|1"
assert "QR-37c. a retry in a new transaction replays" \
  "$(q2p_sql "set role service_role; select status from public.create_workspace_with_owner('${ACCT_A}', 'Race name', 'r4-c', 'founder', '${Q2P_OP}');")" "ALREADY_CREATED"
q2p_open S1 7; q2p_open S2 8
q2p_send 7 "begin; select status from public.create_workspace_with_owner('${ACCT_A}', 'D one', 'r4-d1', 'founder', '${Q2P_OP}');"
q2p_idle_in_tx S1 || true
q2p_send 8 "select status from public.create_workspace_with_owner('${ACCT_A}', 'D two', 'r4-d2', 'founder', '${Q2P_OP}');"
q2p_settled S2 || true
r37d_s2="$(q2p_out S2 | grep -E '^CREATED$' | tail -n1)"
q2p_send 7 "commit;"
q2p_close S1 7; q2p_close S2 8
assert "QR-37d. F1, different keys concurrently: the second does not wait; both created" \
  "${r37d_s2}|$(q2p_sql "select count(*) from public.workspaces where idempotency_key in ('r4-d1','r4-d2');")" "CREATED|2"
r="$(qr37 level2_fixture.create_workspace_no_key_lock r4-w 'Race name' 'read committed' no)"
assert "QR-37w (weakened, no key lock). same key and body, READ COMMITTED: 23505 instead of a replay" \
  "$(cut -d'|' -f3,5 <<<"${r}")" "ERROR:  23505|1"

# F7: <function> <isolation> <snapshot first> <second account> → "S2 outcome|blocked|active rows of the account(s)"
qr38() {
  local fn=$1 iso=$2 snap=$3 second=$4 ws m blocked
  read -r ws m <<<"$(q2p_workspace "qr38-${fn##*.}-${iso// /_}-${snap}-${second:0:8}" "${ACCT_A}")"
  q2p_open S1 7; q2p_open S2 8
  [[ "${snap}" == "yes" ]] && { q2p_send 8 "begin isolation level ${iso}; select 1;"; q2p_idle_in_tx S2 || true; }
  q2p_send 7 "begin; select status from ${fn}('${ws}', '${ACCT_X}', 'founder', '${Q2P_OP}');"
  q2p_idle_in_tx S1 || echo "barrier S1 failed" >&2
  if [[ "${snap}" == "yes" ]]; then
    q2p_send 8 "select status || ':' || membership_id from ${fn}('${ws}', '${second}', 'founder', '${Q2P_OP}');"
  else
    q2p_send 8 "begin isolation level ${iso}; select status || ':' || membership_id from ${fn}('${ws}', '${second}', 'founder', '${Q2P_OP}');"
  fi
  if q2p_lock_wait S2; then blocked=blocked; else blocked=not_blocked; fi
  q2p_send 7 "commit;"
  q2p_settled S2 || true
  q2p_send 8 "commit;"
  q2p_close S1 7; q2p_close S2 8
  echo "$(q2p_out S2 | grep -oE '^((ADDED|ALREADY_MEMBER):[0-9a-f-]{36}|ERROR:  [0-9A-Z]{5})$' | tail -n1 | awk -F: '{ if ($1 == "ERROR") print $0; else print $1 }')|${blocked}|$(q2p_sql "select count(*) from public.workspace_members where workspace_id='${ws}' and removed_at is null and account_id <> '${ACCT_A}';")"
}
assert "QR-38a. F7, duplicate add, REPEATABLE READ stale snapshot: 40001; one active row" \
  "$(qr38 public.add_workspace_member 'repeatable read' yes "${ACCT_X}")" "ERROR:  40001|blocked|1"
assert "QR-38b. F7, two different accounts concurrently: serialised on the version row; both added" \
  "$(qr38 public.add_workspace_member 'read committed' no "${ACCT_C}")" "ADDED|blocked|2"
assert "QR-38w (weakened, no version row). duplicate add, READ COMMITTED: S2 fails on the unique index (23505)" \
  "$(qr38 level2_fixture.add_member_no_version_row 'read committed' no "${ACCT_X}")" "ERROR:  23505|blocked|1"
r38c="$(qr38 public.add_workspace_member 'read committed' no "${ACCT_X}")"
assert "QR-38c. F7, duplicate add, READ COMMITTED: the same (workspace, account) membership is returned" "${r38c}" "ALREADY_MEMBER|blocked|1"

# QR-39 — no unintended writes to anything that existed before Q2′-1.
r39="$(q2p_sql "select level2_fixture.verify_baseline();")"
assert "QR-39. baseline captured over every pre-existing table" "${Q2P_BASELINE_TABLES}" \
  "$(q2p_sql "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname <> all (string_to_array('${Q2P_TABLES}', ' '));")"
assert "QR-39. no pre-existing row in any pre-existing table changed or disappeared" "${r39%%|*}" "0"
assert "QR-39. new rows appear only where the tests inserted fixtures or F4 created versions" \
  "${r39#*|}" "buyer_question_versions,buyer_questions,projects,snapshot_requests"
assert "QR-39. no protocol, paid job, attempt or external call was created" \
  "$(q2p_sql "select (select count(*) from public.protocols) - ${Q2P_PROTOCOLS_BEFORE} || '/' || (select count(*) from public.protocol_execution_jobs) - ${Q2P_JOBS_BEFORE};")" "0/0"

# ── Summary ──────────────────────────────────────────────────────────────

echo
echo "── Summary ──────────────────────────────────────────────"
echo "migrations applied  : ${migrations_applied}"
echo "tests passed        : ${tests_passed}"
echo "tests failed        : ${tests_failed}"
echo "unexpected blocking : ${unexpected_blocking}"
echo "duplicate claims    : ${duplicate_claims}"
echo

cat <<'NOTE'
The PostgreSQL Level 2 run proves the tested migration, privilege,
locking, and transaction behavior only.

Application callers have not yet migrated to the RPC surface. Migration
0032 must not be applied to Production until they have.
NOTE
echo

if [[ ${tests_failed} -eq 0 && ${unexpected_blocking} -eq 0 && ${duplicate_claims} -eq 0 ]]; then
  echo "LEVEL2_RESULT=PASS"
  exit 0
fi

echo "LEVEL2_RESULT=FAIL"
exit 1
