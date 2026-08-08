#!/usr/bin/env bash
# Executable fencing tests for migration 0035.
#
# Send and Replace must never both proceed against the same artifact: a
# persistent delivery claim carries exclusion across the external email call
# that no row lock can span. These tests exercise the real RPCs against a
# disposable local PostgreSQL, not a mock.
#
# Deliberately separate from test-snapshot-worker-postgres-level2.sh, which is
# Docker-only. Connection contract is purpose-named so an ambient DATABASE_URL
# pointing at Supabase can never satisfy it.
set -uo pipefail

URL="${ZYPACT_FENCING_TEST_DATABASE_URL:-}"
[ -z "$URL" ] && { echo "FATAL: set ZYPACT_FENCING_TEST_DATABASE_URL"; exit 2; }

# Loopback only, via a real URL parser. A hand-rolled regex is the wrong tool
# here: "127.0.0.1.evil.example" and "user@127.0.0.1@evil.example" are exactly
# the shapes substring matching gets wrong, and the cost of being wrong is a
# destructive fixture reset against someone else's database.
HOST="$(ZURL="$URL" node -e '
  try {
    const u = new URL(process.env.ZURL);
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") process.exit(3);
    // Node strips the brackets from IPv6 literals; ::ffff:127.0.0.1 and any
    // other mapped form is deliberately not accepted.
    process.stdout.write(u.hostname.toLowerCase());
  } catch { process.exit(3); }
')" || { echo "FATAL: unparseable or non-postgres URL"; exit 2; }

case "$HOST" in
  127.0.0.1|localhost|::1|"[::1]") : ;;
  *) echo "FATAL: refusing non-loopback host '${HOST}'"; exit 2 ;;
esac

PSQL_BIN="${PSQL_BIN:-$(command -v psql || echo /opt/homebrew/opt/postgresql@16/bin/psql)}"
q()  { "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -qtA -c "$1" 2>&1; }
qf() { "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -qtA -c "$1" >/dev/null 2>&1; }   # expect success
qe() { "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -qtA -c "$1" >/dev/null 2>&1 && return 1 || return 0; } # expect failure

pass=0; fail=0
ck(){ if [ "$2" = "0" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

FULL_A='# Full A
line two — unicode é'
SHORT_A='# Short A'
FULL_B='# Full B (corrected)'
SHORT_B='# Short B (corrected)'

# Deterministic disposable fixture keyed to a fixed namespace; only these rows
# are removed, never unrelated local data.
reset_fixture() {
  qf "delete from public.snapshot_report_artifacts where project_id in (select id from public.projects where domain like 'fencing-test-%');
      delete from public.snapshot_requests where normalized_domain like 'fencing-test-%';
      delete from public.projects where domain like 'fencing-test-%';"
}
mk() { # $1=slug $2=status $3=full $4=short -> "requestId artifactId"
  "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -qtA <<SQL
with p as (
  insert into public.projects (domain) values ('fencing-test-$1.example') returning id
), r as (
  insert into public.snapshot_requests
    (work_email, normalized_email, company_name, website_url, normalized_domain, buyer_category, status)
  values ('f@$1.example','f@$1.example','F$1','https://$1.example','fencing-test-$1.example','saas','$2')
  returning id
)
insert into public.snapshot_report_artifacts
  (snapshot_request_id, project_id, full_report_markdown, short_report_markdown,
   full_report_filename, short_report_filename, generated_at, public_token)
select r.id, p.id, \$\$$3\$\$, \$\$$4\$\$, 'f.md', 's.md', now(), replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')
from r, p
returning snapshot_request_id || ' ' || id;
SQL
}
rev(){ q "select public.snapshot_report_artifact_revision(\$\$$1\$\$, \$\$$2\$\$);"; }

# Topology check. pgcrypto sits in `public` on a stock cluster (repository CI)
# and in `extensions` on Supabase, and migration 0035 discovers which at
# migration time. Rather than forcing one layout, detect whichever is present
# and assert the generated revision function actually baked THAT schema in —
# so a regression to a hardcoded schema fails here on either environment.
PGC_SCHEMA="$("$PSQL_BIN" "$URL" -qtA -c "select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';" 2>/dev/null)"
if [ -z "$PGC_SCHEMA" ]; then
  echo "FATAL: pgcrypto is not installed in the target database"
  exit 2
fi
BAKED="$("$PSQL_BIN" "$URL" -qtA -c "select (regexp_match(pg_get_functiondef('public.snapshot_report_artifact_revision(text,text)'::regprocedure),'([a-zA-Z_\"-]+)\.digest'))[1];" 2>/dev/null | tr -d '\"')"
if [ "$BAKED" != "$PGC_SCHEMA" ]; then
  echo "FATAL: revision function references '${BAKED:-<none>}'.digest but pgcrypto is in '${PGC_SCHEMA}'"
  exit 2
fi
DYN="$("$PSQL_BIN" "$URL" -qtA -c "select (pg_get_functiondef('public.snapshot_report_artifact_revision(text,text)'::regprocedure) ~* 'execute |pg_extension')::text;" 2>/dev/null)"
if [ "$DYN" != "false" ]; then
  echo "FATAL: revision function contains runtime dynamic SQL"
  exit 2
fi
echo "  topology: pgcrypto in '${PGC_SCHEMA}'; revision function baked ${BAKED}.digest, no runtime dynamic SQL"

echo "test-snapshot-report-delivery-fencing-postgres"
reset_fixture

# ---- D1 revision parity -----------------------------------------------------
D1=0
for pair in "full|short" "HockeyStack — visibilité IA|short" "a
b
c|x
y" "|"; do
  f="${pair%%|*}"; s="${pair##*|}"
  pg="$(rev "$f" "$s")"
  nd="$(node -e 'const{createHash:h}=require("crypto");const[f,s]=[process.argv[1],process.argv[2]];console.log(h("sha256").update(Buffer.concat([h("sha256").update(Buffer.from(f,"utf8")).digest(),h("sha256").update(Buffer.from(s,"utf8")).digest()])).digest("hex"))' "$f" "$s")"
  [ "$pg" = "$nd" ] || D1=1
  printf '%s' "$pg" | grep -qE '^[0-9a-f]{64}$' || D1=1
done
ck "D1 revision parity + format (4 inputs)" $D1

# ---- D2 replacement success -------------------------------------------------
read -r RQ AR <<<"$(mk d2 report_ready "$FULL_A" "$SHORT_A")"
REV_A="$(rev "$FULL_A" "$SHORT_A")"
qf "select * from public.replace_undelivered_snapshot_report_artifact('$RQ','$AR','$REV_A',\$\$$FULL_B\$\$,\$\$$SHORT_B\$\$);"; r2=$?
got="$(q "select full_report_markdown='$FULL_B' and short_report_markdown='$SHORT_B' and id='$AR' and delivered_at is null and delivery_message_id is null from public.snapshot_report_artifacts where id='$AR';")"
[ "$r2" = "0" ] && [ "$got" = "t" ] && ck "D2 replacement success (id stable, both bodies, delivery untouched)" 0 || ck "D2 replacement success" 1

# ---- D3 stale replacement ---------------------------------------------------
before="$(q "select md5(full_report_markdown||short_report_markdown) from public.snapshot_report_artifacts where id='$AR';")"
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQ','$AR','$REV_A',\$\$X\$\$,\$\$Y\$\$);"; d3=$?
after="$(q "select md5(full_report_markdown||short_report_markdown) from public.snapshot_report_artifacts where id='$AR';")"
[ "$d3" = "0" ] && [ "$before" = "$after" ] && ck "D3 stale revision rejected, content unchanged" 0 || ck "D3 stale revision" 1

# ---- D4 wrong statuses ------------------------------------------------------
d4=0
for st in pending_approval running failed; do
  read -r RQ4 AR4 <<<"$(mk "d4$st" "$st" "$FULL_A" "$SHORT_A")"
  qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQ4','$AR4','$REV_A',\$\$X\$\$,\$\$Y\$\$);" || d4=1
done
ck "D4 replacement rejected for pending_approval/running/failed" $d4

# ---- D5 delivered -----------------------------------------------------------
read -r RQ5 AR5 <<<"$(mk d5 report_ready "$FULL_A" "$SHORT_A")"
qf "update public.snapshot_report_artifacts set delivered_at=now(), delivery_message_id='m' where id='$AR5';"
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQ5','$AR5','$REV_A',\$\$X\$\$,\$\$Y\$\$);"
ck "D5 delivered artifact replacement rejected" $?

# ---- D7 begin success (also sets up D6/D9) ----------------------------------
read -r RQ7 AR7 <<<"$(mk d7 report_ready "$FULL_A" "$SHORT_A")"
BEG="$(q "select delivery_claim_token || '|' || revision || '|' || md5(full_report_markdown) || '|' || md5(short_report_markdown) from public.begin_snapshot_report_delivery('$RQ7','$AR7','$REV_A');")"
TOK="${BEG%%|*}"; rest="${BEG#*|}"; RV="${rest%%|*}"; rest="${rest#*|}"; MF="${rest%%|*}"; MS="${rest##*|}"
exp_f="$(printf '%s' "$FULL_A" | md5 -q 2>/dev/null || printf '%s' "$FULL_A" | md5sum | cut -d' ' -f1)"
st="$(q "select delivery_claim_token is not null and delivery_claimed_at is not null from public.snapshot_report_artifacts where id='$AR7';")"
[ -n "$TOK" ] && [ "$RV" = "$REV_A" ] && [ "$MF" = "$exp_f" ] && [ "$st" = "t" ] \
  && ck "D7 begin returns claim + exact claimed markdown" 0 || ck "D7 begin success" 1

# ---- D6 replacement blocked by active claim / ORDER A -----------------------
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQ7','$AR7','$REV_A',\$\$X\$\$,\$\$Y\$\$);"
ck "D6/ORDER-A send-first blocks replace" $?

# ---- D9 second begin / ORDER C ---------------------------------------------
qe "select * from public.begin_snapshot_report_delivery('$RQ7','$AR7','$REV_A');"; d9=$?
tok2="$(q "select delivery_claim_token from public.snapshot_report_artifacts where id='$AR7';")"
[ "$d9" = "0" ] && [ "$tok2" = "$TOK" ] && ck "D9/ORDER-C second begin rejected, claim unchanged" 0 || ck "D9 second begin" 1

# ---- D11 finalize wrong token ----------------------------------------------
qe "select * from public.finalize_snapshot_report_delivery('$RQ7','$AR7',gen_random_uuid(),'msg');"; d11=$?
s11="$(q "select delivery_claim_token='$TOK' and delivered_at is null from public.snapshot_report_artifacts where id='$AR7';")"
[ "$d11" = "0" ] && [ "$s11" = "t" ] && ck "D11 finalize wrong token rejected, claim preserved" 0 || ck "D11 finalize wrong token" 1

# ---- D13 release wrong token ------------------------------------------------
qe "select * from public.release_snapshot_report_delivery_claim('$RQ7','$AR7',gen_random_uuid());"; d13=$?
s13="$(q "select delivery_claim_token='$TOK' from public.snapshot_report_artifacts where id='$AR7';")"
[ "$d13" = "0" ] && [ "$s13" = "t" ] && ck "D13 release wrong token rejected, claim preserved" 0 || ck "D13 release wrong token" 1

# ---- D14 old claim still fences --------------------------------------------
qf "update public.snapshot_report_artifacts set delivery_claimed_at = now() - interval '30 days' where id='$AR7';"
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQ7','$AR7','$REV_A',\$\$X\$\$,\$\$Y\$\$);"; a=$?
qe "select * from public.begin_snapshot_report_delivery('$RQ7','$AR7','$REV_A');"; b=$?
[ "$a" = "0" ] && [ "$b" = "0" ] && ck "D14 30-day-old claim still fences replace and begin" 0 || ck "D14 old claim fences" 1

# ---- D10 finalize correct token --------------------------------------------
qf "select * from public.finalize_snapshot_report_delivery('$RQ7','$AR7','$TOK','msg-123');"; d10=$?
s10="$(q "select delivered_at is not null and delivery_message_id='msg-123' and delivery_claim_token is null and delivery_claimed_at is null from public.snapshot_report_artifacts where id='$AR7';")"
[ "$d10" = "0" ] && [ "$s10" = "t" ] && ck "D10 finalize sets delivery and clears claim" 0 || ck "D10 finalize" 1

# ---- D12 release correct token ---------------------------------------------
read -r RQC ARC <<<"$(mk d12 report_ready "$FULL_A" "$SHORT_A")"
TOKC="$(q "select delivery_claim_token from public.begin_snapshot_report_delivery('$RQC','$ARC','$REV_A');")"
qf "select * from public.release_snapshot_report_delivery_claim('$RQC','$ARC','$TOKC');"; d12=$?
s12="$(q "select delivery_claim_token is null and delivery_claimed_at is null and delivered_at is null and full_report_markdown=\$\$$FULL_A\$\$ from public.snapshot_report_artifacts where id='$ARC';")"
[ "$d12" = "0" ] && [ "$s12" = "t" ] && ck "D12 release clears claim, content and delivery untouched" 0 || ck "D12 release" 1

# ---- D8 stale begin / ORDER B ----------------------------------------------
read -r RQ8 AR8 <<<"$(mk d8 report_ready "$FULL_A" "$SHORT_A")"
qf "select * from public.replace_undelivered_snapshot_report_artifact('$RQ8','$AR8','$REV_A',\$\$$FULL_B\$\$,\$\$$SHORT_B\$\$);"
qe "select * from public.begin_snapshot_report_delivery('$RQ8','$AR8','$REV_A');"; d8=$?
nc="$(q "select delivery_claim_token is null from public.snapshot_report_artifacts where id='$AR8';")"
[ "$d8" = "0" ] && [ "$nc" = "t" ] && ck "D8/ORDER-B replace-first blocks stale begin, no claim created" 0 || ck "D8 stale begin" 1

# ---- D15 atomic pair --------------------------------------------------------
read -r RQ15 AR15 <<<"$(mk d15 report_ready "$FULL_A" "$SHORT_A")"
mixed="$(q "select count(*) from public.snapshot_report_artifacts where id='$AR15' and ((full_report_markdown=\$\$$FULL_B\$\$) <> (short_report_markdown=\$\$$SHORT_B\$\$));")"
qf "select * from public.replace_undelivered_snapshot_report_artifact('$RQ15','$AR15','$REV_A',\$\$$FULL_B\$\$,\$\$$SHORT_B\$\$);"
mixed2="$(q "select count(*) from public.snapshot_report_artifacts where id='$AR15' and ((full_report_markdown=\$\$$FULL_B\$\$) <> (short_report_markdown=\$\$$SHORT_B\$\$));")"
both="$(q "select full_report_markdown=\$\$$FULL_B\$\$ and short_report_markdown=\$\$$SHORT_B\$\$ from public.snapshot_report_artifacts where id='$AR15';")"
[ "$mixed" = "0" ] && [ "$mixed2" = "0" ] && [ "$both" = "t" ] && ck "D15 no half-updated state observable; both fields moved" 0 || ck "D15 atomic pair" 1

# ---- D16 cross-request mismatch --------------------------------------------
read -r RQX ARX <<<"$(mk d16a report_ready "$FULL_A" "$SHORT_A")"
read -r RQY ARY <<<"$(mk d16b report_ready "$FULL_A" "$SHORT_A")"
d16=0
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQX','$ARY','$REV_A',\$\$X\$\$,\$\$Y\$\$);" || d16=1
qe "select * from public.begin_snapshot_report_delivery('$RQX','$ARY','$REV_A');" || d16=1
TOKX="$(q "select delivery_claim_token from public.begin_snapshot_report_delivery('$RQX','$ARX','$REV_A');")"
qe "select * from public.finalize_snapshot_report_delivery('$RQY','$ARX','$TOKX','m');" || d16=1
qe "select * from public.release_snapshot_report_delivery_claim('$RQY','$ARX','$TOKX');" || d16=1
ck "D16 cross request/artifact rejected on all four RPCs" $d16

# ---- N1..N6 NULL fencing -----------------------------------------------------
# A NULL parameter must fail closed. `x <> NULL` is NULL and PL/pgSQL skips an
# IF NULL branch, so a `<>` guard would authorize the operation outright — the
# bypass an adversarial review found in the first version of this migration.
read -r RQN ARN <<<"$(mk nul report_ready "$FULL_A" "$SHORT_A")"
[ -n "$RQN" ] && [ -n "$ARN" ] || { echo "  FATAL: N-fixture insert failed"; exit 1; }
REV_N="$(rev "$FULL_A" "$SHORT_A")"
snap(){ q "select md5(full_report_markdown||short_report_markdown)||'|'||coalesce(delivery_claim_token::text,'-')||'|'||coalesce(delivered_at::text,'-') from public.snapshot_report_artifacts where id='$ARN';"; }

S0="$(snap)"
qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQN','$ARN',NULL,\$\$PWNED\$\$,\$\$PWNED\$\$);"; n1=$?
[ "$n1" = "0" ] && [ "$(snap)" = "$S0" ] && ck "N1 replace with NULL revision rejected, content unchanged" 0 || ck "N1 NULL replace revision" 1

qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQN',NULL,'$REV_N',\$\$PWNED\$\$,\$\$PWNED\$\$);"; n5=$?
[ "$n5" = "0" ] && [ "$(snap)" = "$S0" ] && ck "N5 replace with NULL artifact id rejected, content unchanged" 0 || ck "N5 NULL replace artifact" 1

qe "select * from public.begin_snapshot_report_delivery('$RQN','$ARN',NULL);"; n2=$?
[ "$n2" = "0" ] && [ "$(snap)" = "$S0" ] && ck "N2 begin with NULL revision rejected, no claim created" 0 || ck "N2 NULL begin revision" 1

qe "select * from public.begin_snapshot_report_delivery('$RQN',NULL,'$REV_N');"; n6=$?
[ "$n6" = "0" ] && [ "$(snap)" = "$S0" ] && ck "N6 begin with NULL artifact id rejected, no claim created" 0 || ck "N6 NULL begin artifact" 1

# A genuine claim, so N3/N4 exercise the token comparison rather than the
# "stored token is null" branch.
TOKN="$(q "select delivery_claim_token from public.begin_snapshot_report_delivery('$RQN','$ARN','$REV_N');")"
[ -n "$TOKN" ] || { echo "  FATAL: N3/N4 precondition claim not created"; exit 1; }
qe "select * from public.finalize_snapshot_report_delivery('$RQN','$ARN',NULL,'pwned');"; n3=$?
s3="$(q "select delivery_claim_token='$TOKN' and delivered_at is null and delivery_message_id is null from public.snapshot_report_artifacts where id='$ARN';")"
[ "$n3" = "0" ] && [ "$s3" = "t" ] && ck "N3 finalize with NULL token rejected, claim intact, undelivered" 0 || ck "N3 NULL finalize token" 1

qe "select * from public.release_snapshot_report_delivery_claim('$RQN','$ARN',NULL);"; n4=$?
s4="$(q "select delivery_claim_token='$TOKN' from public.snapshot_report_artifacts where id='$ARN';")"
[ "$n4" = "0" ] && [ "$s4" = "t" ] && ck "N4 release with NULL token rejected, claim intact" 0 || ck "N4 NULL release token" 1

# Defence in depth: NULL row-lookup keys must also fail closed.
nid=0
qe "select * from public.replace_undelivered_snapshot_report_artifact(NULL,'$ARN','$REV_N',\$\$X\$\$,\$\$Y\$\$);" || nid=1
qe "select * from public.finalize_snapshot_report_delivery('$RQN',NULL,'$TOKN','m');" || nid=1
qe "select * from public.release_snapshot_report_delivery_claim('$RQN',NULL,'$TOKN');" || nid=1
ck "N7 NULL request id / artifact id lookups fail closed" $nid

# ---- malformed (non-NULL) revisions still fail closed -----------------------
mal=0
for bad in "" "$(printf 'a%.0s' $(seq 1 63))" "$(printf 'a%.0s' $(seq 1 65))" "$(printf 'A%.0s' $(seq 1 64))" "$(printf 'z%.0s' $(seq 1 64))"; do
  qe "select * from public.replace_undelivered_snapshot_report_artifact('$RQN','$ARN','$bad',\$\$X\$\$,\$\$Y\$\$);" || mal=1
done
ck "N8 malformed non-NULL revisions rejected (empty/63/65/upper/non-hex)" $mal

# ---- two-session lock contention -------------------------------------------
read -r RQL ARL <<<"$(mk lock report_ready "$FULL_A" "$SHORT_A")"
LOCKLOG=$(mktemp)
( "$PSQL_BIN" "$URL" -qtA <<SQL >"$LOCKLOG" 2>&1
begin;
select id from public.snapshot_requests where id='$RQL' for update;
select pg_sleep(3);
select * from public.begin_snapshot_report_delivery('$RQL','$ARL','$REV_A');
commit;
SQL
) &
S1=$!
sleep 1
T0=$(date +%s)
BLOCKED=$("$PSQL_BIN" "$URL" -qtA -c "set lock_timeout='1200ms'; select * from public.replace_undelivered_snapshot_report_artifact('$RQL','$ARL','$REV_A',\$\$X\$\$,\$\$Y\$\$);" 2>&1 | grep -ci "lock timeout" || true)
T1=$(date +%s)
wait $S1
FINAL="$(q "select delivery_claim_token is not null and full_report_markdown=\$\$$FULL_A\$\$ from public.snapshot_report_artifacts where id='$ARL';")"
POST=$("$PSQL_BIN" "$URL" -qtA -c "select * from public.replace_undelivered_snapshot_report_artifact('$RQL','$ARL','$REV_A',\$\$X\$\$,\$\$Y\$\$);" 2>&1 | grep -ci "delivery claim is active" || true)
echo "    session2 blocked on lock: ${BLOCKED} (waited $((T1-T0))s, bounded by lock_timeout)"
echo "    after session1 commit: claim held & content unmodified = ${FINAL}"
echo "    session2 retry after commit: rejected as active claim = ${POST}"
[ "$BLOCKED" = "1" ] && [ "$FINAL" = "t" ] && [ "$POST" = "1" ] \
  && ck "TWO_SESSION lock contention: replace blocked pre-commit, fenced post-commit" 0 \
  || ck "TWO_SESSION lock contention" 1
rm -f "$LOCKLOG"

# ---- runtime ACL ------------------------------------------------------------
acl=0
qe "set role anon; select * from public.begin_snapshot_report_delivery('$RQL','$ARL','$REV_A');" || acl=1
qe "set role authenticated; select * from public.replace_undelivered_snapshot_report_artifact('$RQL','$ARL','$REV_A',\$\$X\$\$,\$\$Y\$\$);" || acl=1
ck "runtime ACL: anon and authenticated cannot invoke privileged RPCs" $acl

reset_fixture
echo ""
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ] || exit 1
