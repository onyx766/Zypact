#!/usr/bin/env tsx
/**
 * M5 — Phase 3D evidence filter and manifest serialiser. Network-free.
 *
 * D-030 makes the retained evidence a contract: a closed field set, and no
 * secret, raw environment dump, raw provider payload or prospect content
 * anywhere near the repository. `scripts/phase3d/lib-evidence.sh` is the
 * one place that decides what survives, so this file drives the real
 * script — not a re-implementation of it — against synthetic fixtures.
 *
 * What it proves:
 *   [1] the library is projection-only: output keys are built, never copied
 *   [2] a `detail`, an unknown key, a prompt, a payload or a credential
 *       cannot reach the output for any of the nine known events
 *   [3] a value that fails its guard becomes null, never its original self
 *   [4] structurally invalid input fails closed: empty stdout, status 3
 *   [5] the manifest key set is fixed and a raw provider id has no home
 *   [6] the output is byte-stable, so two runs can be compared
 *
 * Every fixture in this file is invented. No fixture is derived from a
 * customer, a prospect, a real prompt, a real answer or a real credential:
 * the credential-shaped strings below are deliberately fake and exist only
 * to prove that they are dropped.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Mechanical network guard. The library shells out to `jq` and nothing
 * else, but a test that asserts "network-free" must be able to prove it
 * for its own process too.
 */
let realFetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  realFetchCalls += 1;
  throw new Error("network access attempted in a network-free contract");
}) as unknown as typeof fetch;

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/phase3d/lib-evidence.sh");
const SOURCE = readFileSync(SCRIPT, "utf8");

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(command: string, input: string): Run {
  const r = spawnSync("bash", [SCRIPT, command], {
    input,
    encoding: "utf8",
    // A closed environment: the library must not depend on anything the
    // caller happens to export, and must never read a credential.
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", LC_ALL: "C" },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function lines(out: string): Array<Record<string, unknown>> {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function counts(err: string): { kept: number; unknown: number; invalid: number } {
  const last = err.split("\n").filter((l) => l.trim() !== "").pop() ?? "{}";
  return JSON.parse(last) as { kept: number; unknown: number; invalid: number };
}

function keysOf(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort();
}

const TS = "2026-08-31T10:00:00.000Z";
const UUID_A = "0bbc3c66-1fc9-4a94-8cdb-a5774ee3bece";

function line(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

// ═══════════════════════════════════════════════ 1. the file itself
{
  console.log("\n[1] The library is a self-contained, network-free shell file");

  assert("the library exists at its contracted path",
    SOURCE.length > 0);
  assert("it is executable",
    (statSync(SCRIPT).mode & 0o111) !== 0,
    (statSync(SCRIPT).mode & 0o777).toString(8));
  assert("it arms `set -Eeuo pipefail`",
    /^set -Eeuo pipefail$/m.test(SOURCE));
  assert("it arms `umask 077`",
    /^umask 077$/m.test(SOURCE));

  // The only external command it may reach for is jq.
  for (const forbidden of ["curl", "wget", "psql", "/dev/tcp", "openssl", "nc "]) {
    assert(`it never reaches for \`${forbidden.trim()}\``,
      !SOURCE.includes(forbidden), forbidden);
  }
  assert("the only dependency it checks for is jq",
    (SOURCE.match(/command -v \S+/g) ?? []).every((m) => m === "command -v jq"),
    (SOURCE.match(/command -v \S+/g) ?? []).join(" | "));
  assert("it reads no dotenv file",
    !/\.env\b/.test(SOURCE));
  assert("it reads no credential-shaped environment variable",
    !/\$\{?(SUPABASE|FLY|PERPLEXITY|OPENAI|ANTHROPIC)[A-Z_]*\}?/.test(SOURCE));

  // Projection, not redaction: `detail` must not be constructible at all.
  assert("no projection ever constructs a `detail` key",
    !/\bdetail\s*:/.test(SOURCE));
  assert("no projection ever constructs a raw provider request id",
    !/\bprovider_request_id\s*:\s*str/.test(SOURCE));
  assert("the provider id survives only as two booleans",
    /provider_request_id_present:\s*bool/.test(SOURCE)
      && /provider_request_id_unique:\s*bool/.test(SOURCE));

  const KNOWN = [
    "worker_execution_disabled", "worker_execution_disabled_stopped",
    "shutdown_requested", "worker_initialisation_abandoned",
    "worker_health_server_close_failed", "worker_started",
    "worker_idle_proof", "iteration", "worker_stopped",
  ];
  for (const e of KNOWN) {
    assert(`the known-event list carries \`${e}\``,
      new RegExp(`"${e}"`).test(SOURCE), e);
  }
  assert("the known-event list holds exactly nine names",
    KNOWN.length === 9);
}

// ═══════════════════════════════════════════════ 2. projection
{
  console.log("\n[2] Projection: the output key set is built, never copied");

  const r = run("filter-events", line({
    ts: TS, level: "info", event: "worker_started",
    workerId: "w-1", leaseSeconds: 60, probeMode: "live",
    maxRuntimeSeconds: 120, executionEnabled: true,
    // None of the following may survive.
    detail: "a customer question in full",
    PERPLEXITY_API_KEY: "pplx-fake-not-a-real-key",
    prompt: "who are the best vendors for X",
    rawResponseBody: "{\"choices\":[]}",
  }));

  assert("a well-formed known event exits 0", r.code === 0, String(r.code));
  const [ev] = lines(r.out);
  assert("exactly one event is emitted", lines(r.out).length === 1);
  assert("worker_started carries exactly its nine contracted keys",
    JSON.stringify(keysOf(ev)) === JSON.stringify([
      "event", "executionEnabled", "leaseSeconds", "level",
      "maxRuntimeSeconds", "probeMode", "schema", "ts", "workerId",
    ].sort()),
    keysOf(ev).join(","));
  assert("the schema constant is stamped", ev.schema === "zypact.phase3d.events.v1");
  assert("the unknown `detail` key is gone", !("detail" in ev));
  assert("the credential-shaped key is gone", !("PERPLEXITY_API_KEY" in ev));
  assert("the prompt key is gone", !("prompt" in ev));
  assert("the raw body key is gone", !("rawResponseBody" in ev));
  assert("no emitted value contains the fake key material",
    !JSON.stringify(ev).includes("pplx-fake"));
  assert("no emitted value contains the fixture prompt",
    !JSON.stringify(ev).includes("who are the best vendors"));

  const it = lines(run("filter-events", line({
    ts: TS, level: "info", event: "iteration",
    outcome: "completed", jobId: UUID_A,
    detail: "NO_PROMPT_IN_PLAN and a trailing sentence about a client",
  })).out)[0];
  assert("iteration carries exactly six keys",
    keysOf(it).length === 6, keysOf(it).join(","));
  assert("iteration keeps outcome and jobId", it.outcome === "completed" && it.jobId === UUID_A);
  assert("iteration drops detail entirely", !("detail" in it));

  const hs = lines(run("filter-events", line({
    ts: TS, level: "error", event: "worker_health_server_close_failed",
    executionEnabled: true, detail: "EADDRINUSE at 127.0.0.1:8080 while closing",
  })).out)[0];
  assert("worker_health_server_close_failed keeps only five keys",
    keysOf(hs).length === 5, keysOf(hs).join(","));
  assert("…and its free-text detail is not one of them", !("detail" in hs));

  const st = lines(run("filter-events", line({
    ts: TS, level: "info", event: "worker_stopped",
    alive: true, startedAtMs: 1, lastClaimAtMs: null, lastHeartbeatAtMs: 3,
    lastDbContactAtMs: 4, iterations: 1, noJobCycles: 0,
    consecutiveNoJobCycles: 0, maxConsecutiveNoJobCycles: 3,
    lastNoJobAtMs: null, shuttingDown: false,
  })).out)[0];
  assert("worker_stopped carries its full fifteen-key snapshot",
    keysOf(st).length === 15, String(keysOf(st).length));
  assert("a contracted null stays null rather than disappearing",
    "lastClaimAtMs" in st && st.lastClaimAtMs === null);
}

// ═══════════════════════════════════════════════ 3. value guards
{
  console.log("\n[3] A value that fails its guard becomes null, never itself");

  const r = lines(run("filter-events", line({
    ts: TS, level: "info", event: "worker_started",
    workerId: "w-1-token-abc",      // matches the shape, but looks like a credential
    leaseSeconds: "60",             // string where a number is contracted
    probeMode: "live mode",         // space is not in the label alphabet
    maxRuntimeSeconds: 120,
    executionEnabled: "true",       // string where a boolean is contracted
  })).out)[0];
  assert("a credential-shaped workerId is nulled", r.workerId === null);
  assert("a stringly-typed number is nulled", r.leaseSeconds === null);
  assert("an out-of-alphabet label is nulled", r.probeMode === null);
  assert("a stringly-typed boolean is nulled", r.executionEnabled === null);
  assert("a conforming number survives", r.maxRuntimeSeconds === 120);
  assert("the rejected values appear nowhere in the output",
    !JSON.stringify(r).includes("token-abc") && !JSON.stringify(r).includes("live mode"));

  const bad = lines(run("filter-events", line({
    ts: TS, level: "info", event: "iteration",
    outcome: "completed with a note", jobId: "not-a-uuid",
  })).out)[0];
  assert("a non-UUID jobId is nulled", bad.jobId === null);
  assert("an outcome with a space is nulled", bad.outcome === null);

  const stage = lines(run("filter-events", line({
    ts: TS, level: "info", event: "worker_initialisation_abandoned",
    stage: "dynamic imports failed while loading a client record",
    executionEnabled: true,
  })).out)[0];
  assert("a free-text stage is nulled", stage.stage === null);
  const stageOk = lines(run("filter-events", line({
    ts: TS, level: "info", event: "worker_initialisation_abandoned",
    stage: "db_import", executionEnabled: true,
  })).out)[0];
  assert("a closed-label stage survives", stageOk.stage === "db_import");
}

// ═══════════════════════════════════════════════ 4. fail-closed input
{
  console.log("\n[4] Structurally invalid input fails closed");

  const ok = run("filter-events", [
    line({ ts: TS, level: "info", event: "worker_started" }),
    line({ ts: TS, level: "info", event: "proxy_upstream", raw: "platform noise" }),
  ].join("\n"));
  assert("an unknown event name is dropped, not an error", ok.code === 0, String(ok.code));
  assert("…and is counted as unknown", counts(ok.err).unknown === 1);
  assert("…while the known event is kept", counts(ok.err).kept === 1);

  for (const [label, bad] of [
    ["a line that is not JSON", "not json at all"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", "\"hello\""],
    ["a JSON number", "123"],
    ["a JSON null", "null"],
    ["an object with no event", line({ ts: TS, level: "info" })],
    ["an object with an empty event", line({ ts: TS, level: "info", event: "" })],
    ["an object with no ts", line({ level: "info", event: "iteration" })],
    ["an object with a malformed ts", line({ ts: "31/08/2026", level: "info", event: "iteration" })],
  ] as const) {
    const r = run("filter-events", [
      line({ ts: TS, level: "info", event: "worker_started" }),
      bad,
    ].join("\n"));
    assert(`${label} poisons the batch (status 3)`, r.code === 3, String(r.code));
    assert(`…and nothing is written to stdout for ${label}`, r.out.trim() === "", r.out.slice(0, 60));
    assert(`…and it is counted as invalid for ${label}`, counts(r.err).invalid === 1);
  }

  const empty = run("filter-events", "");
  assert("empty input is not an error", empty.code === 0, String(empty.code));
  assert("…and produces no events", empty.out.trim() === "");
  assert("…with all three counters at zero",
    counts(empty.err).kept === 0 && counts(empty.err).unknown === 0 && counts(empty.err).invalid === 0);

  const usage = spawnSync("bash", [SCRIPT, "not-a-command"], { encoding: "utf8" });
  assert("an unknown subcommand exits 2", (usage.status ?? -1) === 2, String(usage.status));
  assert("…and writes nothing to stdout", (usage.stdout ?? "") === "");
}

// ═══════════════════════════════════════════════ 5. manifest
{
  console.log("\n[5] The manifest key set is fixed, and a raw provider id has no home");

  const MANIFEST_KEYS = [
    "actual_cost_usd", "config_fingerprint_after", "config_fingerprint_before",
    "exit_code", "final_state", "fly_app", "harness_commit", "harness_sha256",
    "http_statuses", "job_id", "machine_id", "machine_state_after",
    "machine_state_before", "models_requested", "models_returned",
    "prompt_sha256", "protocol_id", "provider_attempts",
    "provider_request_id_present", "provider_request_id_unique",
    "receipt_outcome", "restored", "retries", "schema", "starts", "stops",
    "success_latencies_ms", "supabase_project", "worker_image_digest",
    "worker_source_commit",
  ];

  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const full = run("build-manifest", JSON.stringify({
    harness_commit: sha1,
    harness_sha256: sha256,
    worker_image_digest: `sha256:${"c".repeat(64)}`,
    worker_source_commit: sha1,
    supabase_project: "abcdefghijklmnopqrst",
    fly_app: "zypact-protocol-worker-staging",
    machine_id: "e826322a695098",
    job_id: UUID_A,
    protocol_id: UUID_A,
    prompt_sha256: sha256,
    config_fingerprint_before: sha256,
    config_fingerprint_after: sha256,
    machine_state_before: "stopped",
    machine_state_after: "stopped",
    provider_attempts: 2,
    models_requested: ["sonar", "gpt-4o-mini-2024-07-18", "bad model name"],
    models_returned: ["sonar"],
    provider_request_id_present: true,
    provider_request_id_unique: true,
    http_statuses: [200, "x", 429],
    success_latencies_ms: [812, null, 1204],
    receipt_outcome: "RECEIPTED",
    actual_cost_usd: 0.0142,
    starts: 1, stops: 1, exit_code: 0, retries: 0,
    restored: true, final_state: "disabled/stopped",
    // None of the following may survive.
    provider_request_id: "req_FAKE_SHOULD_NOT_SURVIVE",
    raw_request_body: "{\"messages\":[{\"role\":\"user\"}]}",
    prompt: "a client question in full",
    SUPABASE_SERVICE_ROLE_KEY: "eyJfake.not.a.real.key",
  }));

  assert("a well-formed manifest exits 0", full.code === 0, String(full.code));
  const m = JSON.parse(full.out) as Record<string, unknown>;
  assert("the manifest carries exactly its thirty contracted keys",
    JSON.stringify(keysOf(m)) === JSON.stringify(MANIFEST_KEYS),
    keysOf(m).join(","));
  assert("the schema constant is stamped", m.schema === "zypact.phase3d.manifest.v1");
  assert("the raw provider request id has no key", !("provider_request_id" in m));
  assert("…and its value appears nowhere", !full.out.includes("req_FAKE"));
  assert("the raw request body has no key", !("raw_request_body" in m));
  assert("…and its value appears nowhere", !full.out.includes("messages"));
  assert("the prompt has no key and no value",
    !("prompt" in m) && !full.out.includes("a client question"));
  assert("the fake service-role value appears nowhere", !full.out.includes("eyJfake"));
  assert("the provider id is retained only as booleans",
    m.provider_request_id_present === true && m.provider_request_id_unique === true);
  assert("a non-conforming model name is dropped from the array",
    JSON.stringify(m.models_requested) === JSON.stringify(["sonar", "gpt-4o-mini-2024-07-18"]),
    JSON.stringify(m.models_requested));
  assert("a non-numeric http status is dropped from the array",
    JSON.stringify(m.http_statuses) === JSON.stringify([200, 429]),
    JSON.stringify(m.http_statuses));
  assert("a null latency is dropped from the array",
    JSON.stringify(m.success_latencies_ms) === JSON.stringify([812, 1204]),
    JSON.stringify(m.success_latencies_ms));
  assert("the restoration facts survive",
    m.restored === true && m.final_state === "disabled/stopped" && m.retries === 0);

  const sparse = run("build-manifest", "{}");
  assert("an empty object still yields the full key set", sparse.code === 0
    && JSON.stringify(keysOf(JSON.parse(sparse.out) as Record<string, unknown>)) === JSON.stringify(MANIFEST_KEYS));
  const sparseObj = JSON.parse(sparse.out) as Record<string, unknown>;
  assert("…with scalars null and arrays empty",
    sparseObj.harness_commit === null && JSON.stringify(sparseObj.http_statuses) === "[]");

  const badShape = run("build-manifest", "[1,2,3]");
  assert("a non-object manifest input exits 3", badShape.code === 3, String(badShape.code));
  assert("…and writes nothing to stdout", badShape.out.trim() === "");
  const badJson = run("build-manifest", "not json");
  assert("malformed manifest JSON exits 3", badJson.code === 3, String(badJson.code));
  assert("…and writes nothing to stdout", badJson.out.trim() === "");

  const guarded = JSON.parse(run("build-manifest", JSON.stringify({
    harness_commit: "not-a-sha", worker_image_digest: "latest",
    machine_state_after: "RUNNING!", actual_cost_usd: "0.01",
  })).out) as Record<string, unknown>;
  assert("a malformed commit is nulled", guarded.harness_commit === null);
  assert("a non-digest image reference is nulled", guarded.worker_image_digest === null);
  assert("an out-of-alphabet machine state is nulled", guarded.machine_state_after === null);
  assert("a stringly-typed cost is nulled", guarded.actual_cost_usd === null);
}

// ═══════════════════════════════════════════════ 6. determinism
{
  console.log("\n[6] The output is byte-stable, so two runs can be compared");

  const input = [
    line({ ts: TS, level: "info", event: "worker_started", workerId: "w-1", executionEnabled: true }),
    line({ ts: TS, level: "info", event: "iteration", outcome: "completed", jobId: UUID_A }),
  ].join("\n");
  const a = run("filter-events", input);
  const b = run("filter-events", input);
  assert("two identical runs produce identical bytes", a.out === b.out);
  assert("…and identical counts", a.err === b.err);
  assert("event keys are emitted in sorted order",
    lines(a.out).every((o) => JSON.stringify(Object.keys(o)) === JSON.stringify(keysOf(o))));

  const m1 = run("build-manifest", JSON.stringify({ starts: 1, stops: 1 }));
  const m2 = run("build-manifest", JSON.stringify({ stops: 1, starts: 1 }));
  assert("manifest key order does not depend on input order", m1.out === m2.out);
}

console.log(`\n✓ no real network access was attempted — calls=${realFetchCalls}`);
assert("the contract itself made no network call", realFetchCalls === 0, String(realFetchCalls));

console.log(`\n${passed}/${passed + failed} checks passed. M5 Phase 3D evidence filter ${failed === 0 ? "PASSED" : "FAILED"}.`);
process.exit(failed === 0 ? 0 : 1);
