/**
 * Contract for starting the protocol worker from the admin console.
 *
 * This module is the only thing in the product that can cause paid provider
 * work to begin. What it must never do is claim that work started when it
 * did not, or leak the credential that let it start.
 *
 * Nothing here reaches Fly: `fetch` is replaced for the duration, so the
 * checks run offline and no machine is ever started by the test suite.
 */

import {
  __setPaidExecutionGateForTests, isWorkerStartConfigured, readWorkerState, startWorkerMachine,
} from "@/lib/worker-control/fly-machine";

let checks = 0;
const failures: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

const TOKEN = "fly-token-that-must-never-be-echoed";
const realFetch = globalThis.fetch;

interface Captured { url: string; method: string; authorization: string }
let captured: Captured[] = [];

/** Answers every call with one canned response, and records the request. */
function stubFetch(status: number, body: string): void {
  captured = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
    });
    return new Response(body, { status });
  }) as typeof fetch;
}

function configure(values: Record<string, string | undefined>): void {
  for (const key of ["FLY_WORKER_APP", "FLY_WORKER_MACHINE_ID", "FLY_API_TOKEN"]) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const CONFIGURED = {
  FLY_WORKER_APP: "zypact-protocol-worker",
  FLY_WORKER_MACHINE_ID: "d8d2e96c906358",
  FLY_API_TOKEN: TOKEN,
};

async function main(): Promise<void> {
  // ── 1. Configuration is all-or-nothing, and absence starts nothing ──────
  //
  // A deployment holding two of the three values is misconfigured. Treating
  // that as "configured" would send a start to whatever app the remaining
  // values happened to name.
  for (const missing of ["FLY_WORKER_APP", "FLY_WORKER_MACHINE_ID", "FLY_API_TOKEN"]) {
    configure({ ...CONFIGURED, [missing]: undefined });
    assert(`configuration is incomplete without ${missing}`, !isWorkerStartConfigured());

    stubFetch(200, "{}");
    const result = await startWorkerMachine();
    assert(`a start without ${missing} is refused`,
      !result.ok && result.code === "not_configured",
      JSON.stringify(result));
    assert(`a start without ${missing} contacts nothing`,
      captured.length === 0, `${captured.length} call(s)`);
  }

  configure({ ...CONFIGURED, FLY_WORKER_APP: "   " });
  assert("a whitespace-only value is not configuration", !isWorkerStartConfigured());

  configure(CONFIGURED);
  assert("all three values together are configuration", isWorkerStartConfigured());

  // ── 1b. The paid-execution gate is consulted before Fly, and refuses ────
  //
  // Everything below exercises Fly's answers, so it runs behind a gate that
  // allows. The gate's own decisions are tested in
  // scripts/test-paid-execution-guards.ts; here only its placement is.
  __setPaidExecutionGateForTests(async () => ({
    ok: false, code: "paid_execution_disabled", detail: "off",
  }));
  stubFetch(200, JSON.stringify({ previous_state: "stopped" }));
  const gated = await startWorkerMachine();
  assert("a refusing gate is a refusal", !gated.ok && gated.code === "paid_execution_blocked",
    JSON.stringify(gated));
  assert("and Fly is never contacted", captured.length === 0, `${captured.length} call(s)`);

  __setPaidExecutionGateForTests(async () => { throw new Error("ledger down"); });
  stubFetch(200, JSON.stringify({ previous_state: "stopped" }));
  const thrown = await startWorkerMachine();
  assert("a gate that throws is a refusal, never a pass",
    !thrown.ok && thrown.code === "paid_execution_blocked" && captured.length === 0,
    JSON.stringify(thrown));

  __setPaidExecutionGateForTests(async () => ({
    ok: true, ceilingUsd: 5, spentLast24hUsd: 0, nextJobCapUsd: 0.25,
  }));

  // ── 2. A successful start, and where it was sent ────────────────────────
  stubFetch(200, JSON.stringify({ previous_state: "stopped", migrated: false }));
  const started = await startWorkerMachine();
  assert("a 200 is a start", started.ok, JSON.stringify(started));
  assert("a machine that was stopped is not reported as already running",
    started.ok && !started.alreadyRunning);
  assert("exactly one call is made", captured.length === 1, `${captured.length}`);
  assert("it is a POST", captured[0]?.method === "POST", captured[0]?.method);
  assert("it targets this app's machine start endpoint",
    captured[0]?.url
      === `https://api.machines.dev/v1/apps/${CONFIGURED.FLY_WORKER_APP}`
      + `/machines/${CONFIGURED.FLY_WORKER_MACHINE_ID}/start`,
    captured[0]?.url ?? "none");
  assert("the token is sent as a bearer credential",
    captured[0]?.authorization === `Bearer ${TOKEN}`);

  // A machine already running is not a second job: the worker claims one job
  // and exits, so a caller told "started" would be waiting for work that the
  // running process will never pick up.
  stubFetch(200, JSON.stringify({ previous_state: "started" }));
  const again = await startWorkerMachine();
  assert("a machine already started reports alreadyRunning",
    again.ok && again.alreadyRunning, JSON.stringify(again));

  stubFetch(200, JSON.stringify({ previous_state: "starting" }));
  const starting = await startWorkerMachine();
  assert("a machine already starting reports alreadyRunning",
    starting.ok && starting.alreadyRunning, JSON.stringify(starting));

  // A 2xx whose body cannot be read is still a start. Refusing here would
  // leave a running machine that the console believes is stopped.
  stubFetch(200, "not json at all");
  const opaque = await startWorkerMachine();
  assert("a 2xx with an unreadable body is still a start", opaque.ok, JSON.stringify(opaque));

  // ── 3. Every refusal is distinguishable, and none of them leak ──────────
  const REFUSALS = [
    { status: 401, code: "unauthorized" },
    { status: 403, code: "unauthorized" },
    { status: 404, code: "not_found" },
    { status: 429, code: "fly_error" },
    { status: 500, code: "fly_error" },
  ] as const;

  for (const { status, code } of REFUSALS) {
    stubFetch(status, `{"error":"fly said ${status}"}`);
    const refused = await startWorkerMachine();
    assert(`HTTP ${status} is refused as ${code}`,
      !refused.ok && refused.code === code, JSON.stringify(refused));
    assert(`HTTP ${status} never reports a start`, !refused.ok);
  }

  // The detail string reaches a browser. Fly's own error bodies name the app
  // and the machine, which is useful; the credential must not travel with
  // them under any status.
  for (const status of [401, 404, 500]) {
    stubFetch(status, JSON.stringify({ error: "denied", token: TOKEN }));
    const refused = await startWorkerMachine();
    const detail = refused.ok ? "" : refused.detail;
    assert(`the token is absent from the HTTP ${status} detail`,
      !detail.includes(TOKEN), detail);
  }

  // A transport failure is a refusal, not a crash: the admin route turns
  // this into a message, and an exception would become a 500 with no cause.
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  const unreachable = await startWorkerMachine();
  assert("an unreachable Fly is a refusal, not a throw",
    !unreachable.ok && unreachable.code === "fly_error", JSON.stringify(unreachable));

  // ── 4. Reading state never throws and never invents one ─────────────────
  stubFetch(200, JSON.stringify({ state: "stopped" }));
  assert("a readable state is returned", (await readWorkerState()) === "stopped");
  assert("reading state is a GET", captured[0]?.method === "GET", captured[0]?.method);

  stubFetch(500, "boom");
  assert("an unreadable state is `unknown`", (await readWorkerState()) === "unknown");

  configure({ ...CONFIGURED, FLY_API_TOKEN: undefined });
  assert("an unconfigured state read is `unknown`", (await readWorkerState()) === "unknown");
}

main()
  .catch((error: unknown) => {
    failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    __setPaidExecutionGateForTests(null);
    if (failures.length > 0) {
      console.error(`\n${failures.length} of ${checks} checks FAILED:`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`\n${checks}/${checks} checks passed. Worker start control contract PASSED.`);
  });
