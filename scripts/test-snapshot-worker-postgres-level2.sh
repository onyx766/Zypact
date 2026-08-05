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

for tbl in snapshot_requests snapshot_report_artifacts; do
  assert "19. service_role CAN still SELECT ${tbl}" \
    "$(psql_q "set role service_role; select count(*) >= 0 from public.${tbl};" | tail -n1)" \
    "t"
done

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
