#!/usr/bin/env bash
#
# Local runner for the Level 2 PostgreSQL concurrency harness.
#
# CI runs `scripts/test-snapshot-worker-postgres-level2.sh` against a
# GitHub Actions service container and passes POSTGRES_CONTAINER_ID. That
# harness is the gate that caught 0057 attempting `revoke maintain` on
# PostgreSQL 16, where MAINTAIN does not exist. Nothing locally could run
# it, so the version gap was invisible until the PR opened.
#
# This wrapper closes that gap: it starts the same postgres:16-alpine
# image as a disposable container, hands its id to the untouched harness,
# and removes it afterwards. It publishes no port — the harness talks to
# the container through `docker exec`, exactly as in CI.
#
# Opt-in. Without ZYPACT_LEVEL2_LOCAL=1 it SKIPs and exits 0, so the
# default test battery stays free of a Docker dependency.

set -euo pipefail

if [[ "${ZYPACT_LEVEL2_LOCAL:-}" != "1" ]]; then
  echo "SKIP: set ZYPACT_LEVEL2_LOCAL=1 to run the Level 2 harness against a disposable postgres:16-alpine."
  exit 0
fi

readonly IMAGE="postgres:16-alpine"
readonly PG_USER="zypact_level2"
readonly PG_DB="zypact_level2"
readonly NAME="zypact-level2-local-$$"

CONTAINER_ID=""

cleanup() {
  # --volumes removes the anonymous volume PostgreSQL's image declares for
  # PGDATA. Without it every run leaves one dangling volume behind. The
  # target is only ${CONTAINER_ID}, the id this invocation captured from
  # its own `docker run`; no name pattern, no `docker volume prune`, so no
  # volume this script did not create can be reached.
  if [[ -n "${CONTAINER_ID}" ]]; then
    docker rm --force --volumes "${CONTAINER_ID}" >/dev/null 2>&1 || true
    echo "Disposable PostgreSQL 16 container and its anonymous volume removed."
  fi
}
trap cleanup EXIT INT TERM

echo "Starting a disposable ${IMAGE} (no published port)..."
CONTAINER_ID="$(docker run -d --name "${NAME}" \
  -e POSTGRES_USER="${PG_USER}" \
  -e POSTGRES_DB="${PG_DB}" \
  -e POSTGRES_PASSWORD="level2-disposable-not-a-secret" \
  "${IMAGE}")"

stable=0
for _ in $(seq 1 60); do
  if docker exec "${CONTAINER_ID}" pg_isready -U "${PG_USER}" -d "${PG_DB}" -q >/dev/null 2>&1; then
    stable=$((stable + 1))
    [[ "${stable}" -ge 3 ]] && break
  else
    stable=0
  fi
  perl -e 'select undef,undef,undef,1' 2>/dev/null || true
done
if [[ "${stable}" -lt 3 ]]; then
  echo "FATAL: PostgreSQL never became ready." >&2
  exit 1
fi

echo "server    : $(docker exec "${CONTAINER_ID}" psql -U "${PG_USER}" -d "${PG_DB}" -tAqc 'show server_version;')"

# The harness calls GNU `timeout`, which the CI runner has and macOS does
# not. Rather than edit the harness — it is the CI gate and must stay
# byte-identical — provide `timeout` on PATH for the duration of this run.
# Prefers coreutils' gtimeout; falls back to a Perl implementation with
# the same `timeout SECONDS command...` contract.
SHIM_DIR=""
NEEDS_TIMEOUT=0
NEEDS_DATE=0
command -v timeout >/dev/null 2>&1 || NEEDS_TIMEOUT=1
# The harness measures milliseconds with `date +%s%3N`. GNU date supports
# %3N; BSD date, as shipped with macOS, leaves a literal "N" and every
# arithmetic comparison in the concurrency tests then fails.
[[ "$(date +%s%3N)" =~ ^[0-9]+$ ]] || NEEDS_DATE=1

if [[ "${NEEDS_TIMEOUT}" -eq 1 || "${NEEDS_DATE}" -eq 1 ]]; then
  SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zypact-level2-shim-XXXXXX")"
fi

if [[ "${NEEDS_DATE}" -eq 1 ]]; then
  if command -v gdate >/dev/null 2>&1; then
    printf '#!/usr/bin/env bash\nexec gdate "$@"\n' > "${SHIM_DIR}/date"
  else
    cat > "${SHIM_DIR}/date" <<'DATESHIM'
#!/usr/bin/env bash
# Only `+%s%3N` needs emulating; every other invocation falls through to
# the system date, so the harness sees no other behaviour change.
if [[ "$1" == "+%s%3N" ]]; then
  perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'
  exit 0
fi
exec /bin/date "$@"
DATESHIM
  fi
  chmod +x "${SHIM_DIR}/date"
  echo "date      : shim local (BSD date ne gere pas %3N)"
fi

if [[ "${NEEDS_TIMEOUT}" -eq 1 ]]; then
  if command -v gtimeout >/dev/null 2>&1; then
    printf '#!/usr/bin/env bash\nexec gtimeout "$@"\n' > "${SHIM_DIR}/timeout"
  else
    cat > "${SHIM_DIR}/timeout" <<'SHIM'
#!/usr/bin/env perl
use strict; use warnings;
my $secs = shift @ARGV;
$secs =~ s/[smhd]$//;
my $pid = fork();
die "fork failed" unless defined $pid;
if ($pid == 0) { exec @ARGV or exit 127; }
local $SIG{ALRM} = sub { kill 'TERM', $pid; sleep 1; kill 'KILL', $pid; exit 124; };
alarm int($secs);
waitpid($pid, 0);
alarm 0;
exit($? >> 8);
SHIM
  fi
  chmod +x "${SHIM_DIR}/timeout"
  echo "timeout   : shim local (GNU timeout absent de ce systeme)"
fi

if [[ -n "${SHIM_DIR}" ]]; then
  PATH="${SHIM_DIR}:${PATH}"
  export PATH
fi

cleanup_shim() { [[ -n "${SHIM_DIR}" ]] && rm -rf "${SHIM_DIR}"; }
trap 'cleanup; cleanup_shim' EXIT INT TERM

# Capture the harness's status explicitly: the EXIT trap runs afterwards
# and would otherwise decide the exit code, turning a failed harness into
# a green run.
HARNESS_RC=0
POSTGRES_CONTAINER_ID="${CONTAINER_ID}" bash scripts/test-snapshot-worker-postgres-level2.sh || HARNESS_RC=$?
if [[ "${HARNESS_RC}" -ne 0 ]]; then
  echo "Level 2 harness FAILED with exit ${HARNESS_RC}." >&2
fi
exit "${HARNESS_RC}"
