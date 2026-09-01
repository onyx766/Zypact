#!/usr/bin/env bash
#
# M5 Phase 3D — evidence filter and manifest serialiser.
#
# D-030 requires that the canary's retained evidence carry a fixed, closed
# set of facts and that no secret, raw environment dump, raw provider
# payload or prospect content ever reach the repository. This library is
# the single place that decides what survives.
#
# The design rule is projection, never redaction. Every output object is
# BUILT from an explicit key list; input keys are read, never copied. A
# field that is absent, mistyped or fails its value guard is emitted as
# `null` — its original value can never appear. An unknown input key has
# nowhere to go, so a prompt, an answer, a raw body, a bearer token or a
# provider-assigned identifier cannot survive by accident: there is no
# code path that writes them.
#
# Two commands, both reading stdin and writing only closed fields:
#
#   filter-events   NDJSON worker log lines -> NDJSON projected events.
#                   Counts go to stderr as one closed object. A single
#                   structurally invalid line poisons the batch: stdout
#                   stays empty and the exit status is 3. Unknown event
#                   names are platform noise, are dropped, and are not a
#                   failure.
#
#   build-manifest  one JSON object -> one closed manifest object, keys
#                   sorted for byte-stable comparison.
#
# Exit status: 0 success, 2 usage or missing dependency, 3 invalid input.
#
# This file makes no network call, reads no file, reads no environment
# variable and shells out to nothing but `jq`. It is driven in CI by
# `scripts/test-m5-phase3d-evidence.ts` against synthetic fixtures only.

set -Eeuo pipefail
umask 077

readonly EVIDENCE_EVENTS_SCHEMA="zypact.phase3d.events.v1"
readonly EVIDENCE_MANIFEST_SCHEMA="zypact.phase3d.manifest.v1"

# ---------------------------------------------------------------------------
# Shared jq preamble: value guards.
#
# CRED is belt and braces. Projection already makes a credential unreachable,
# but a value that LOOKS like one is dropped even from an allow-listed field,
# so a future key added to a projection cannot quietly become a leak.
# ---------------------------------------------------------------------------
read -r -d '' JQ_GUARDS <<'JQ_GUARDS_EOF' || true
def CRED: "(?i)(secret|token|password|credential|bearer|api[_-]?key|service[_-]?role|sk-[a-z]|eyJ)";
def LABEL: "^[A-Za-z0-9_]{1,64}$";
def UUID: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
def SHA256: "^[0-9a-f]{64}$";
def SHA1: "^[0-9a-f]{40}$";
def TS: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$";
def HOSTLIKE: "^[0-9A-Za-z._:-]{1,64}$";
def MODELLIKE: "^[A-Za-z0-9._:-]{1,64}$";
def STATELIKE: "^[a-z_/]{1,32}$";
def OUTCOMELIKE: "^[A-Za-z_]{1,64}$";

# A string that matches its shape and looks nothing like a credential.
def str($v; $re):
  if ($v | type) == "string"
     and ($v | test($re))
     and (($v | test(CRED)) | not)
  then $v else null end;
def num($v): if ($v | type) == "number" then $v else null end;
def bool($v): if ($v | type) == "boolean" then $v else null end;
# Arrays keep only conforming elements; a rejected element is dropped so the
# array stays homogeneous and countable.
def strs($v; $re): if ($v | type) == "array" then [$v[] | str(.; $re)] | map(select(. != null)) else [] end;
def nums($v): if ($v | type) == "array" then [$v[] | num(.)] | map(select(. != null)) else [] end;
JQ_GUARDS_EOF

# ---------------------------------------------------------------------------
# filter-events
# ---------------------------------------------------------------------------
read -r -d '' JQ_FILTER <<'JQ_FILTER_EOF' || true
def KNOWN: [
  "worker_execution_disabled",
  "worker_execution_disabled_stopped",
  "shutdown_requested",
  "worker_initialisation_abandoned",
  "worker_health_server_close_failed",
  "worker_started",
  "worker_idle_proof",
  "iteration",
  "worker_stopped"
];

def valid($e):
  ($e | type) == "object"
  and (($e.event | type) == "string")
  and (($e.event | length) > 0)
  and (($e.ts | type) == "string")
  and ($e.ts | test(TS));

# Every branch constructs its own key set. `detail` is never constructed,
# for any event, which is why a free-text failure string cannot escape.
def project($e):
  { schema: $schema, ts: $e.ts, level: (str($e.level; "^[a-z]+$")), event: $e.event }
  + (
    if $e.event == "worker_execution_disabled" then
      { executionEnabled: bool($e.executionEnabled),
        healthPort: num($e.healthPort),
        healthHost: str($e.healthHost; HOSTLIKE) }
    elif $e.event == "worker_execution_disabled_stopped" then
      { signal: str($e.signal; LABEL),
        executionEnabled: bool($e.executionEnabled),
        healthServerClosed: bool($e.healthServerClosed) }
    elif $e.event == "shutdown_requested" then
      { reason: str($e.reason; LABEL),
        graceMs: num($e.graceMs) }
    elif $e.event == "worker_initialisation_abandoned" then
      { stage: str($e.stage; LABEL),
        executionEnabled: bool($e.executionEnabled) }
    elif $e.event == "worker_health_server_close_failed" then
      { executionEnabled: bool($e.executionEnabled) }
    elif $e.event == "worker_started" then
      { workerId: str($e.workerId; HOSTLIKE),
        leaseSeconds: num($e.leaseSeconds),
        probeMode: str($e.probeMode; LABEL),
        maxRuntimeSeconds: num($e.maxRuntimeSeconds),
        executionEnabled: bool($e.executionEnabled) }
    elif $e.event == "worker_idle_proof" then
      { consecutiveNoJobCycles: num($e.consecutiveNoJobCycles),
        noJobCycles: num($e.noJobCycles),
        maxConsecutiveNoJobCycles: num($e.maxConsecutiveNoJobCycles),
        executionEnabled: bool($e.executionEnabled) }
    elif $e.event == "iteration" then
      { outcome: str($e.outcome; OUTCOMELIKE),
        jobId: str($e.jobId; UUID) }
    else
      { alive: bool($e.alive),
        startedAtMs: num($e.startedAtMs),
        lastClaimAtMs: num($e.lastClaimAtMs),
        lastHeartbeatAtMs: num($e.lastHeartbeatAtMs),
        lastDbContactAtMs: num($e.lastDbContactAtMs),
        iterations: num($e.iterations),
        noJobCycles: num($e.noJobCycles),
        consecutiveNoJobCycles: num($e.consecutiveNoJobCycles),
        maxConsecutiveNoJobCycles: num($e.maxConsecutiveNoJobCycles),
        lastNoJobAtMs: num($e.lastNoJobAtMs),
        shuttingDown: bool($e.shuttingDown) }
    end
  );

split("\n")
| map(select(length > 0))
| reduce .[] as $line (
    { events: [], counts: { kept: 0, unknown: 0, invalid: 0 } };
    (try ($line | fromjson) catch null) as $e
    | if $e == null or (valid($e) | not) then
        .counts.invalid += 1
      elif (KNOWN | index($e.event)) == null then
        .counts.unknown += 1
      else
        .events += [project($e)] | .counts.kept += 1
      end
  )
JQ_FILTER_EOF

# ---------------------------------------------------------------------------
# build-manifest
#
# The key list IS the evidence contract. `provider_request_id_present` and
# `provider_request_id_unique` are booleans on purpose: D-030 needs to know
# that a provider correlation id existed and was not reused, and knowing
# that never requires storing the identifier itself.
# ---------------------------------------------------------------------------
read -r -d '' JQ_MANIFEST <<'JQ_MANIFEST_EOF' || true
if (type != "object") then
  { __invalid: true }
else
  {
    schema: $schema,
    harness_commit: str(.harness_commit; SHA1),
    harness_sha256: str(.harness_sha256; SHA256),
    worker_image_digest: str(.worker_image_digest; "^sha256:[0-9a-f]{64}$"),
    worker_source_commit: str(.worker_source_commit; SHA1),
    supabase_project: str(.supabase_project; "^[a-z]{20}$"),
    fly_app: str(.fly_app; "^[a-z0-9-]{1,63}$"),
    machine_id: str(.machine_id; "^[0-9a-f]{14}$"),
    job_id: str(.job_id; UUID),
    protocol_id: str(.protocol_id; UUID),
    prompt_sha256: str(.prompt_sha256; SHA256),
    config_fingerprint_before: str(.config_fingerprint_before; SHA256),
    config_fingerprint_after: str(.config_fingerprint_after; SHA256),
    machine_state_before: str(.machine_state_before; STATELIKE),
    machine_state_after: str(.machine_state_after; STATELIKE),
    provider_attempts: num(.provider_attempts),
    models_requested: strs(.models_requested; MODELLIKE),
    models_returned: strs(.models_returned; MODELLIKE),
    provider_request_id_present: bool(.provider_request_id_present),
    provider_request_id_unique: bool(.provider_request_id_unique),
    http_statuses: nums(.http_statuses),
    success_latencies_ms: nums(.success_latencies_ms),
    receipt_outcome: str(.receipt_outcome; "^[A-Z_]{1,64}$"),
    actual_cost_usd: num(.actual_cost_usd),
    starts: num(.starts),
    stops: num(.stops),
    exit_code: num(.exit_code),
    retries: num(.retries),
    restored: bool(.restored),
    final_state: str(.final_state; STATELIKE)
  }
end
JQ_MANIFEST_EOF

evidence_require_jq() {
  if ! command -v jq > /dev/null 2>&1; then
    printf '%s\n' '{"error":"jq_missing"}' >&2
    return 2
  fi
}

evidence_filter_events() {
  evidence_require_jq || return 2
  local result counts invalid
  result="$(jq -R -s -c --arg schema "$EVIDENCE_EVENTS_SCHEMA" "${JQ_GUARDS}${JQ_FILTER}")"
  counts="$(printf '%s' "$result" | jq -S -c '.counts')"
  invalid="$(printf '%s' "$result" | jq -r '.counts.invalid')"
  if [ "$invalid" -ne 0 ]; then
    # Fail closed: one malformed line invalidates the batch. Nothing is
    # written to stdout, so a partial filter can never be mistaken for a
    # complete one.
    printf '%s\n' "$counts" >&2
    return 3
  fi
  printf '%s' "$result" | jq -S -c '.events[]'
  printf '%s\n' "$counts" >&2
  return 0
}

evidence_build_manifest() {
  evidence_require_jq || return 2
  local result
  result="$(jq -S -c --arg schema "$EVIDENCE_MANIFEST_SCHEMA" "${JQ_GUARDS}${JQ_MANIFEST}" 2> /dev/null || printf '%s' '{"__invalid":true}')"
  if [ "$(printf '%s' "$result" | jq -r 'has("__invalid")')" = "true" ]; then
    printf '%s\n' '{"error":"invalid_manifest_input"}' >&2
    return 3
  fi
  printf '%s\n' "$result"
  return 0
}

evidence_usage() {
  printf '%s\n' 'usage: lib-evidence.sh {filter-events|build-manifest}' >&2
}

evidence_main() {
  case "${1-}" in
    filter-events) evidence_filter_events ;;
    build-manifest) evidence_build_manifest ;;
    *) evidence_usage; return 2 ;;
  esac
}

# Sourceable as a library, runnable as a command. `return` fails outside a
# sourced context, which is exactly how the two are told apart.
(return 0 2> /dev/null) || evidence_main "$@"
