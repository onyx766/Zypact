/**
 * Starting the protocol worker from the admin console.
 *
 * The worker runs as a single Fly Machine that is created stopped, claims one
 * job, and exits (D-034). Something has to start it, and until now that
 * something was an operator in a terminal — which meant a customer-visible
 * flow could not be completed by the customer, or by a founder, without a
 * developer present.
 *
 * This starts that machine over Fly's Machines API. The bound D-034 rests on
 * is unchanged: one start still runs exactly one job, because it is the
 * machine's own configuration, not the caller, that ends the process after a
 * claim and refuses to restart it.
 *
 * What DOES change is who can cause paid work: a founder with the admin
 * console rather than an operator with a shell. Every caller is behind the
 * founder guard, and the callers check that a claimable job exists before
 * asking for a start, so a stray click cannot spend on nothing.
 *
 * Fail-closed and quiet about its credentials. With no configuration the
 * helper reports `not_configured` and starts nothing; the token is read from
 * the environment, never logged, and never returned to the browser.
 */

import { getDb } from "@/lib/db";
import type {
  CancelProtocolJobRunRequestOutcome,
  RequestProtocolJobRunInput,
  RequestProtocolJobRunOutcome,
  RequestProtocolJobRunResult,
} from "@/lib/db/types";
import { getReportServiceClient } from "@/lib/reports/service-client";
import {
  evaluatePaidExecution,
  type PaidExecutionDecision,
} from "@/lib/worker-control/paid-execution-gate";

const FLY_API = "https://api.machines.dev/v1";

type PaidExecutionGate = () => Promise<PaidExecutionDecision>;

/**
 * The default gate reads the real ledger. A failure to even build the
 * service client is a refusal like any other, never a pass.
 */
const defaultGate: PaidExecutionGate = async () => {
  let client;
  try {
    client = getReportServiceClient();
  } catch {
    return { ok: false, code: "spend_ledger_unavailable", detail: "The spend ledger is not configured on this deployment." };
  }
  return evaluatePaidExecution({ client });
};

let gate: PaidExecutionGate = defaultGate;

/** Test-only. Pass null to restore the real gate. */
export function __setPaidExecutionGateForTests(next: PaidExecutionGate | null): void {
  gate = next ?? defaultGate;
}

/** Fly's machine states, as far as this module needs to distinguish them. */
export type FlyMachineState =
  | "created" | "starting" | "started" | "stopping" | "stopped"
  | "suspended" | "replacing" | "destroying" | "destroyed" | "unknown";

export type StartWorkerResult =
  | {
      ok: true;
      alreadyRunning: boolean;
      state: FlyMachineState;
      /** D-052 — the run request that names this start's job. */
      runRequestId: string;
      runRequestExpiresAt: string;
      /** True when this call recorded the request; false when it was already pending for this job. */
      runRequestCreated: boolean;
      /**
       * True only when the machine was already running and this call's cancel
       * of the request it had just recorded was confirmed: nothing new will
       * run from this press.
       */
      runRequestWithdrawn: boolean;
    }
  | {
      ok: false;
      code:
        | "not_configured"
        | "paid_execution_blocked"
        | "run_request_unavailable"
        | "run_request_refused"
        | "unauthorized"
        | "not_found"
        | "fly_error";
      detail: string;
      /** Set when `code` is `run_request_refused`: the closed refusal. */
      refusal?: RequestProtocolJobRunOutcome;
    };

/**
 * D-052 — how long a Run's request waits for the machine it starts. The
 * machine boots in seconds and claims on its first pass; two minutes is
 * room for a slow boot, and short enough that a request nobody served does
 * not hold the next Run back for long.
 */
export const RUN_REQUEST_TTL_SECONDS = 120;

/** D-052 — the one job a start is for, and who pressed Run. */
export interface WorkerRunTarget {
  jobId: string;
  projectId: string;
  via: "admin_run_pipeline" | "admin_run_retest" | "admin_founder_baseline" | "admin_pilot_run";
  /** The signed-in founder's user id. */
  requestedBy: string;
}

interface RunRequests {
  request(input: RequestProtocolJobRunInput): Promise<RequestProtocolJobRunResult>;
  cancel(requestId: string): Promise<CancelProtocolJobRunRequestOutcome>;
}

const defaultRunRequests: RunRequests = {
  request: (input) => getDb().requestProtocolJobRun(input),
  cancel: (requestId) => getDb().cancelProtocolJobRunRequest(requestId),
};

let runRequests: RunRequests = defaultRunRequests;

export function __setRunRequestsForTests(next: RunRequests | null): void {
  runRequests = next ?? defaultRunRequests;
}

/** What the founder is told when the run request is refused. Fixed text only. */
const RUN_REQUEST_REFUSAL_TEXT: Record<Exclude<RequestProtocolJobRunOutcome, "REQUESTED" | "ALREADY_REQUESTED">, string> = {
  ANOTHER_RUN_PENDING:
    "Another run was started in the last two minutes and has not been picked up yet. Wait for it, or try again in two minutes.",
  WORKER_BUSY:
    "The worker is running another job. Press Run again when that job has finished.",
  JOB_LOCKED:
    "This job is being changed by another action right now. Try again in a moment.",
  JOB_NOT_FOUND:
    "This job no longer exists.",
  JOB_ATTEMPTS_EXHAUSTED:
    "This job's worker stopped too many times, so the job is now marked abandoned. Close the request from its page.",
  JOB_NOT_RUNNABLE:
    "This job is not waiting to run. It may have finished, failed or be held for review. Refresh the page.",
  PILOT_CLOSED:
    "This pilot is closed or past its end date, so its questions are no longer measured.",
  PILOT_NOT_STARTED:
    "This pilot has not started yet. Its questions can be run from its start date.",
  PILOT_QUESTION_RETIRED:
    "This pilot question was retired, so it is no longer measured.",
};

/**
 * The HTTP status a route answers with when a start fails: 503 for the
 * deployment's configuration or switches, 409 when the run itself was
 * refused, 502 for Fly.
 */
export function startFailureHttpStatus(code: Extract<StartWorkerResult, { ok: false }>["code"]): number {
  if (code === "not_configured" || code === "paid_execution_blocked" || code === "run_request_unavailable") return 503;
  if (code === "run_request_refused") return 409;
  return 502;
}

/**
 * Best effort: an unserved request also expires on its own. Only a request
 * this call created is ever withdrawn: one that was already pending belongs
 * to an earlier start whose machine may be about to claim it.
 */
async function withdraw(requestId: string): Promise<CancelProtocolJobRunRequestOutcome | null> {
  try {
    return await runRequests.cancel(requestId);
  } catch {
    /* The request expires after RUN_REQUEST_TTL_SECONDS regardless. */
    return null;
  }
}

interface FlyConfig { app: string; machineId: string; token: string }

/**
 * Configuration is all-or-nothing on purpose. A deployment holding two of
 * the three values is misconfigured, and reporting that plainly is better
 * than a start that silently targets the wrong app.
 */
function readConfig(): FlyConfig | null {
  const app = process.env.FLY_WORKER_APP?.trim();
  const machineId = process.env.FLY_WORKER_MACHINE_ID?.trim();
  const token = process.env.FLY_API_TOKEN?.trim();
  if (!app || !machineId || !token) return null;
  return { app, machineId, token };
}

export function isWorkerStartConfigured(): boolean {
  return readConfig() !== null;
}

async function flyFetch(
  config: FlyConfig, path: string, init: RequestInit,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${FLY_API}/apps/${config.app}/machines/${config.machineId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    // A start is a short control-plane call. Without a bound, a hung Fly
    // API would hold the admin request open until the platform killed it,
    // and the founder would be told nothing at all.
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

/** The machine's current state, or `unknown` if it cannot be read. */
export async function readWorkerState(): Promise<FlyMachineState> {
  const config = readConfig();
  if (!config) return "unknown";
  try {
    const { status, body } = await flyFetch(config, "", { method: "GET" });
    if (status !== 200) return "unknown";
    const parsed = JSON.parse(body) as { state?: string };
    return (parsed.state ?? "unknown") as FlyMachineState;
  } catch {
    return "unknown";
  }
}

/**
 * Starts the worker machine for one named job.
 *
 * D-052 — the target is required, so no caller can start the machine
 * without saying which job it is for. After the paid-execution gate, and
 * before Fly is contacted, the job is recorded as the one pending run
 * request; the worker's requested claim takes that job or nothing. If Fly
 * does not accept the start, the request is withdrawn.
 *
 * Starting an already-running machine is reported rather than repeated. Fly
 * would accept the call, but a second start is not a second job — the
 * running process claims one job and exits — so telling the founder it is
 * already running is the honest answer to "why did nothing new happen".
 */
export async function startWorkerMachine(target: WorkerRunTarget): Promise<StartWorkerResult> {
  const config = readConfig();
  if (!config) {
    return {
      ok: false, code: "not_configured",
      detail:
        "Starting the worker from here is not configured on this deployment. "
        + "Set FLY_WORKER_APP, FLY_WORKER_MACHINE_ID and FLY_API_TOKEN.",
    };
  }

  // Every start is paid work: the machine claims a job and calls providers.
  // The gate runs before Fly is contacted at all, and anything it cannot
  // affirm — including its own failure — is a refusal.
  let decision: PaidExecutionDecision;
  try {
    decision = await gate();
  } catch {
    decision = { ok: false, code: "spend_ledger_unavailable", detail: "The spend ledger could not be read." };
  }
  if (!decision.ok) {
    return { ok: false, code: "paid_execution_blocked", detail: decision.detail };
  }

  // D-052 — name the job before anything can start.
  let requested: RequestProtocolJobRunResult;
  try {
    requested = await runRequests.request({
      jobId: target.jobId,
      projectId: target.projectId,
      via: target.via,
      requestedBy: target.requestedBy,
      ttlSeconds: RUN_REQUEST_TTL_SECONDS,
    });
  } catch {
    return {
      ok: false, code: "run_request_unavailable",
      detail: "The run could not be recorded, so the worker was not started.",
    };
  }
  if (requested.outcome !== "REQUESTED" && requested.outcome !== "ALREADY_REQUESTED") {
    return {
      ok: false, code: "run_request_refused", refusal: requested.outcome,
      detail: RUN_REQUEST_REFUSAL_TEXT[requested.outcome],
    };
  }
  if (!requested.requestId || !requested.expiresAt) {
    return {
      ok: false, code: "run_request_unavailable",
      detail: "The run could not be recorded, so the worker was not started.",
    };
  }
  const runRequestId = requested.requestId;
  const runRequestExpiresAt = requested.expiresAt;
  const created = requested.outcome === "REQUESTED";

  let status: number;
  let body: string;
  try {
    ({ status, body } = await flyFetch(config, "/start", { method: "POST" }));
  } catch (error) {
    // Fly may or may not have started the machine. Withdrawing the request
    // makes either case safe: a machine that did start finds no request
    // and stops without claiming.
    if (created) await withdraw(runRequestId);
    return {
      ok: false, code: "fly_error",
      detail: error instanceof Error && error.name === "TimeoutError"
        ? "Fly did not answer within 15 seconds. Check the machine in the Fly dashboard before retrying."
        : "Could not reach Fly to start the worker.",
    };
  }

  if (created && (status < 200 || status >= 300)) await withdraw(runRequestId);

  if (status === 401 || status === 403) {
    return {
      ok: false, code: "unauthorized",
      detail: "Fly rejected the access token. It may be expired or scoped to another app.",
    };
  }
  if (status === 404) {
    return {
      ok: false, code: "not_found",
      detail: "Fly has no such machine. Check FLY_WORKER_APP and FLY_WORKER_MACHINE_ID.",
    };
  }
  if (status < 200 || status >= 300) {
    // Fly's error body names the app and the machine, which is what makes a
    // refusal diagnosable, so it is worth forwarding. It is also a remote
    // string heading for a browser, and this module is the one place holding
    // the credential — so the credential is removed from it rather than
    // assumed absent.
    const safe = body.split(config.token).join("[redacted]").slice(0, 200);
    return { ok: false, code: "fly_error", detail: `Fly refused the start (HTTP ${status}). ${safe}` };
  }

  let previous = "";
  try {
    previous = (JSON.parse(body) as { previous_state?: string }).previous_state ?? "";
  } catch { /* A 2xx with an unreadable body is still a start. */ }

  // A machine still booting ('starting') makes its first claim after this
  // request was recorded, so it may serve it: the request is kept. One that
  // is already running ('started') is a single-job worker that never claims
  // again once its loop has ended, so a request this press created would only
  // block the next Run: it is withdrawn, unless that worker took it first
  // (NOT_PENDING), and only a confirmed cancel is reported as a withdrawal.
  const alreadyRunning = previous === "started" || previous === "starting";
  let runRequestWithdrawn = false;
  if (previous === "started" && created) {
    runRequestWithdrawn = (await withdraw(runRequestId)) === "CANCELLED";
  }

  return {
    ok: true,
    alreadyRunning,
    state: "starting",
    runRequestId,
    runRequestExpiresAt,
    runRequestCreated: created,
    runRequestWithdrawn,
  };
}
