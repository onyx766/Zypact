#!/usr/bin/env bash
#
# Local runner for the P1, P2, E1, Q4, pilot step-1 (D-052), pilot-questions (D-054), pilot-report (D-055),
# pilot-actions (D-057), pilot links and claims (D-060) and ChatGPT phase B (D-061)
# database tests (scripts/test-p1-workspace-db.ts, scripts/test-p2-workspace-db.ts, ...).
#
# Starts a disposable Supabase Postgres container (no published port),
# applies every repository migration in filename order, runs the test
# against it through `docker exec`, and removes the container and its
# anonymous volume afterwards. It only ever removes the container it
# created itself.
#
# Opt-in. Without ZYPACT_P2_DB_LOCAL=1 it SKIPs and exits 0, so the default
# test battery stays free of a Docker dependency.

set -euo pipefail

if [[ "${ZYPACT_P2_DB_LOCAL:-}" != "1" ]]; then
  echo "SKIP: set ZYPACT_P2_DB_LOCAL=1 to run the P2 database test against a disposable Supabase Postgres."
  exit 0
fi

readonly IMAGE="${ZYPACT_P2_DB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.167}"
readonly NAME="zp-p2-db-$$"
readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER_ID=""

cleanup() {
  if [[ -n "${CONTAINER_ID}" ]]; then
    docker rm --force --volumes "${CONTAINER_ID}" >/dev/null 2>&1 || true
    echo "Disposable database container removed."
  fi
}
trap cleanup EXIT INT TERM

echo "Starting a disposable ${IMAGE} (no published port)..."
CONTAINER_ID="$(docker run -d --name "${NAME}" -e POSTGRES_PASSWORD=disposable-not-a-secret "${IMAGE}")"

ready=0
for _ in $(seq 1 120); do
  if docker exec "${NAME}" psql -U supabase_admin -d postgres -tAc "select 1" >/dev/null 2>&1; then
    ready=$((ready + 1))
    [[ "${ready}" -ge 3 ]] && break
  else
    ready=0
  fi
  sleep 1
done
if [[ "${ready}" -lt 3 ]]; then
  echo "FATAL: the database never became ready." >&2
  exit 1
fi

count=0
for file in $(ls "${ROOT}"/supabase/migrations/*.sql | sort); do
  if ! docker exec -i "${NAME}" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "${file}" >/dev/null 2>&1; then
    echo "FATAL: migration $(basename "${file}") did not apply." >&2
    docker exec -i "${NAME}" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q < "${file}" 2>&1 | tail -5 >&2 || true
    exit 1
  fi
  count=$((count + 1))
done
echo "Applied ${count} migrations."

cd "${ROOT}"
status=0
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-p1-workspace-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-p2-workspace-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-e1-plans-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-q4-activation-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-pilot-step1-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-pilot-questions-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-pilot-report-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-pilot-actions-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-pilot-links-and-claims-db.ts || status=1
ZYPACT_P2_DB_CONTAINER="${NAME}" npx tsx scripts/test-chatgpt-phase-b-db.ts || status=1
exit "${status}"
