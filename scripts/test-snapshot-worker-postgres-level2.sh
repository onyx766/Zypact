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
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
  -- Fresh unprivileged role: inherits only PUBLIC, proving PUBLIC has no
  -- execute access on the worker RPCs.
  if not exists (select 1 from pg_roles where rolname = 'level2_plain') then
    create role level2_plain nologin;
  end if;
end;
$$;
SQL

echo "created: anon, authenticated, service_role, level2_plain"

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

stale6="$(psql_q "select status||'|'||coalesce(project_id::text,'')||'|'||coalesce(progress_stage,'')||'|'||attempt_count||'|'||coalesce(claimed_by,'NULL')||'|'||coalesce(claim_token::text,'NULL')||'|'||coalesce(lease_expires_at::text,'NULL')
                  from public.snapshot_requests where id='${r6_stale}';")"
IFS='|' read -r s6 sp6 sg6 sn6 sw6 st6 sl6 <<<"${stale6}"

assert "6a. exhausted request becomes failed" "${s6}" "failed"
assert "6b. project ID preserved"             "${sp6}" "${p6}"
assert "6c. progress stage preserved"         "${sg6}" "building_diagnosis"
assert "6d. attempt count preserved"          "${sn6}" "${MAX_ATTEMPTS}"
assert "6e. claimed_by cleared"               "${sw6}" "NULL"
assert "6f. claim_token cleared"              "${st6}" "NULL"
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
This disposable PostgreSQL 16 run proves only the tested migration and
concurrency behavior. It does not make worker-owned progress, artifact
persistence, finalization, or paid scan execution safe.

Worker-owned progress writes, artifact persistence, report-ready
finalization, failed finalization, and crash-after-artifact reconciliation
remain unfenced.
NOTE
echo

if [[ ${tests_failed} -eq 0 && ${unexpected_blocking} -eq 0 && ${duplicate_claims} -eq 0 ]]; then
  echo "LEVEL2_RESULT=PASS"
  exit 0
fi

echo "LEVEL2_RESULT=FAIL"
exit 1
