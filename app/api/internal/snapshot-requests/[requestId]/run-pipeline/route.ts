import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { requireCurrentUser } from "@/lib/auth/current-user";
import { isFounderEmail } from "@/lib/auth/founder";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Starts the scan-and-report pipeline for one approved request.
 *
 * Detached child process, not inline work. The pipeline executes every
 * planned run of the request's own protocol (two paid provider calls per
 * run) and takes minutes; holding an HTTP request open for that
 * would hit request timeouts and, worse, tie a leased paid execution to the
 * lifetime of a web request that a browser can abandon at any moment.
 *
 * Returns as soon as the child is spawned. Progress is observed by polling
 * the job row, which the worker updates as it goes — the same source of truth
 * the CLI path uses.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const { requestId } = await params;

  let user: { email: string | null } | null;
  try {
    user = await requireCurrentUser();
  } catch {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!user || !isFounderEmail(user.email)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ ok: false, error: "invalid_request_id" }, { status: 400 });
  }

  const client = getReportServiceClient();

  const { data: snapshot } = await client
    .from("snapshot_requests")
    .select("status,protocol_id")
    .eq("id", requestId)
    .maybeSingle();

  const row = (snapshot ?? null) as Record<string, any> | null;

  if (!row) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (row.status !== "approved" || !row.protocol_id) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Only an approved request with a protocol can be run. Approve it first.",
      },
      { status: 409 }
    );
  }

  // Refuse to start a second run over a job already in flight. The claim RPC
  // would refuse the duplicate anyway, but failing here keeps the founder from
  // watching two spawns race and assuming both are doing work.
  const { data: job } = await client
    .from("protocol_execution_jobs")
    .select("status,lease_expires_at")
    .eq("protocol_id", row.protocol_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const jobRow = (job as Record<string, any> | null) ?? null;
  const jobStatus = jobRow?.status ?? null;

  // A leased job blocks a second run only while its lease is still good. Once
  // the lease has lapsed the worker is gone, and refusing here would strand
  // the job forever with its paid evidence unreachable — the worker's own
  // stale-lease reclaim is designed to pick exactly this case back up.
  if (jobStatus === "claimed" || jobStatus === "running") {
    const expiry = jobRow?.lease_expires_at
      ? Date.parse(jobRow.lease_expires_at)
      : NaN;

    const leaseAlive = !Number.isNaN(expiry) && expiry > Date.now();

    if (leaseAlive) {
      return NextResponse.json(
        {
          ok: false,
          error: `A run is already in progress (job is '${jobStatus}').`,
        },
        { status: 409 }
      );
    }
  }

  if (jobStatus === "needs_review") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This job is held for review. Resolve it on the request page before running again.",
      },
      { status: 409 }
    );
  }

  // The run count shown to the founder comes from this protocol's own frozen
  // plan, never a constant: baselines approved under an older default keep
  // the plan they were approved with.
  const { data: protocol } = await client
    .from("protocols")
    .select("planned_baseline_runs")
    .eq("id", row.protocol_id)
    .maybeSingle();

  const plannedRuns = (protocol as Record<string, any> | null)
    ?.planned_baseline_runs;

  const startedDetail =
    typeof plannedRuns === "number" && plannedRuns > 0
      ? `Scan started. It executes ${plannedRuns} planned run${
          plannedRuns === 1 ? "" : "s"
        } (two paid provider calls each) and usually takes about 2 minutes per run.`
      : "Scan started. It executes the protocol's planned runs and usually takes a few minutes.";

  let logFd: number;
  const logDir = join(process.cwd(), ".pipeline-logs");

  try {
    mkdirSync(logDir, { recursive: true });
    // Appended, never truncated: a re-run must not erase the record of the
    // run that preceded it.
    logFd = openSync(join(logDir, `${requestId}.log`), "a");
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not open a pipeline log file." },
      { status: 500 }
    );
  }

  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-pipeline-once.ts",
        "--request-id",
        requestId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // The child loads .env.local itself; the dev server's own
          // environment is not a substitute for it.
          DOTENV_CONFIG_PATH: ".env.local",
          NODE_OPTIONS: "-r dotenv/config",
        },
        // Best-effort independence from this request's lifetime.
        //
        // NOT a guarantee on Windows: `taskkill /T` on the dev server walks
        // the parent-pid tree and reaches a detached child anyway, and
        // `start /b` keeps it in the same console Ctrl+C group. Both were
        // measured to die. Survival is therefore treated as an optimization,
        // not a property to rely on — the lease makes an interrupted run
        // reclaimable, and the UI offers Resume when one is found stale.
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
      }
    );

    child.unref();

    return NextResponse.json(
      {
        ok: true,
        started: true,
        pid: child.pid ?? null,
        detail: startedDetail,
      },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not start the pipeline.",
      },
      { status: 500 }
    );
  }
}
