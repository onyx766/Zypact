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

const FLY_API = "https://api.machines.dev/v1";

/** Fly's machine states, as far as this module needs to distinguish them. */
export type FlyMachineState =
  | "created" | "starting" | "started" | "stopping" | "stopped"
  | "suspended" | "replacing" | "destroying" | "destroyed" | "unknown";

export type StartWorkerResult =
  | { ok: true; alreadyRunning: boolean; state: FlyMachineState }
  | { ok: false; code: "not_configured" | "unauthorized" | "not_found" | "fly_error"; detail: string };

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
 * Starts the worker machine.
 *
 * Starting an already-running machine is reported rather than repeated. Fly
 * would accept the call, but a second start is not a second job — the
 * running process claims one job and exits — so telling the founder it is
 * already running is the honest answer to "why did nothing new happen".
 */
export async function startWorkerMachine(): Promise<StartWorkerResult> {
  const config = readConfig();
  if (!config) {
    return {
      ok: false, code: "not_configured",
      detail:
        "Starting the worker from here is not configured on this deployment. "
        + "Set FLY_WORKER_APP, FLY_WORKER_MACHINE_ID and FLY_API_TOKEN.",
    };
  }

  let status: number;
  let body: string;
  try {
    ({ status, body } = await flyFetch(config, "/start", { method: "POST" }));
  } catch (error) {
    return {
      ok: false, code: "fly_error",
      detail: error instanceof Error && error.name === "TimeoutError"
        ? "Fly did not answer within 15 seconds. Check the machine in the Fly dashboard before retrying."
        : "Could not reach Fly to start the worker.",
    };
  }

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

  return {
    ok: true,
    alreadyRunning: previous === "started" || previous === "starting",
    state: "starting",
  };
}
