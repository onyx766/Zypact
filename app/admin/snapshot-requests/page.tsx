import { getDb } from "@/lib/db";
import { requireFounderForPage } from "@/lib/auth/founder";
import { FOUNDER_ADMIN_PATH } from "@/lib/auth/safe-next-path";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { pilotProtocolIds } from "@/lib/pilots/reads";
import { loadPipelineRowStates } from "@/lib/reports/pipeline-row-state";
import { AdminShell, type AdminHealth } from "../admin-shell";
import { NewAuditPanel } from "./new-audit-panel";
import {
  FounderBaselinePanel,
  type FounderBaselineRow,
} from "./founder-baseline-panel";
import { RequestsTable, type RequestRow } from "./requests-table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
});

function formatParts(value: string): {
  date: string;
  time: string;
} {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return { date: value, time: "" };
  }

  return {
    date: DATE_FORMAT.format(date),
    time: TIME_FORMAT.format(date),
  };
}

/**
 * Sidebar health, derived from the rows already on screen rather than asserted.
 *
 * A lapsed lease means a paid run stopped with nobody holding it, and a blocked
 * report never delivers — both need a human, so neither may render as "all
 * clear". Nothing here claims anything about provider or worker health that
 * this page has not actually observed.
 */
function summarizeHealth(rows: RequestRow[]): AdminHealth {
  const stalled = rows.filter((row) => row.pipeline.stale).length;
  const blocked = rows.filter(
    (row) => row.pipeline.integrityStatus === "blocked"
  ).length;

  if (stalled === 0 && blocked === 0) {
    return {
      ok: true,
      title: "No runs need attention",
      note: "No stalled leases or blocked reports in this list.",
    };
  }

  const parts: string[] = [];
  if (stalled > 0) parts.push(`${stalled} stalled run${stalled === 1 ? "" : "s"}`);
  if (blocked > 0)
    parts.push(`${blocked} blocked report${blocked === 1 ? "" : "s"}`);

  return {
    ok: false,
    title: "Attention needed",
    note: `${parts.join(" · ")} in this list.`,
  };
}

async function loadFounderBaselines(): Promise<FounderBaselineRow[]> {
  const client = getReportServiceClient();

  const [{ data: jobs, error: jobsError }, { data: attached, error: attachedError }] =
    await Promise.all([
      client
        .from("protocol_execution_jobs")
        .select(
          "id,project_id,protocol_id,status,attempt_count,max_attempts,next_baseline_ordinal,created_at"
        )
        .order("created_at", { ascending: false })
        .limit(20),
      client
        .from("snapshot_requests")
        .select("protocol_id")
        .not("protocol_id", "is", null),
    ]);

  if (jobsError || attachedError) {
    throw jobsError ?? attachedError ?? new Error("Could not load baseline jobs");
  }

  const attachedIds = new Set(
    (attached ?? [])
      .map((row: Record<string, any>) => row.protocol_id)
      .filter((value: unknown): value is string => typeof value === "string")
  );

  // D-054 — a pilot question's protocol has no request either, but it is
  // not a founder experiment: it is run from its pilot's page.
  for (const protocolId of await pilotProtocolIds(client)) attachedIds.add(protocolId);

  const candidateJobs = (jobs ?? []).filter(
    (row: Record<string, any>) =>
      typeof row.protocol_id === "string" && !attachedIds.has(row.protocol_id)
  );

  if (candidateJobs.length === 0) return [];

  const protocolIds = Array.from(
    new Set(candidateJobs.map((row: Record<string, any>) => row.protocol_id))
  );

  const { data: protocols, error: protocolsError } = await client
    .from("protocols")
    .select(
      "id,project_id,buyer_question_version_id,baseline_protocol_id,status,planned_baseline_runs,planned_retest_runs,run_cap,retry_cap,spend_cap_usd"
    )
    .in("id", protocolIds);

  if (protocolsError) throw protocolsError;

  const baselineProtocols = (protocols ?? []).filter(
    (row: Record<string, any>) => row.baseline_protocol_id === null
  );

  if (baselineProtocols.length === 0) return [];

  const versions = Array.from(
    new Set(
      baselineProtocols
        .map((row: Record<string, any>) => row.buyer_question_version_id)
        .filter((value: unknown): value is string => typeof value === "string")
    )
  );

  const { data: questionVersions, error: versionsError } = await client
    .from("buyer_question_versions")
    .select("id,version_number,prompt_text,prompt_hash")
    .in("id", versions);

  if (versionsError) throw versionsError;

  const protocolById = new Map(
    baselineProtocols.map((row: Record<string, any>) => [row.id, row])
  );
  const versionById = new Map(
    (questionVersions ?? []).map((row: Record<string, any>) => [row.id, row])
  );

  return candidateJobs.flatMap((job: Record<string, any>) => {
    const protocol = protocolById.get(job.protocol_id);
    if (!protocol) return [];

    const version = versionById.get(protocol.buyer_question_version_id);
    if (!version) return [];

    return [
      {
        jobId: String(job.id),
        protocolId: String(protocol.id),
        projectId: String(job.project_id),
        questionVersion: Number(version.version_number),
        buyerQuestion: String(version.prompt_text),
        promptHash: String(version.prompt_hash),
        plannedRuns: Number(protocol.planned_baseline_runs),
        runCap: Number(protocol.run_cap),
        retryCap: Number(protocol.retry_cap),
        spendCapUsd: Number(protocol.spend_cap_usd),
        jobStatus: String(job.status),
        attemptCount: Number(job.attempt_count),
        nextBaselineOrdinal:
          job.next_baseline_ordinal === null
            ? null
            : Number(job.next_baseline_ordinal),
        protocolStatus: String(protocol.status),
        createdAt: String(job.created_at),
      },
    ];
  });
}

export default async function SnapshotRequestsAdminPage() {
  const user = await requireFounderForPage(FOUNDER_ADMIN_PATH);

  const requests = await getDb().listSnapshotRequests(100);

  let founderBaselines: FounderBaselineRow[] = [];
  try {
    founderBaselines = await loadFounderBaselines();
  } catch {
    founderBaselines = [];
  }

  // Best-effort: the list must still render if the pipeline read fails, so a
  // transient error costs the run buttons, not the whole admin page.
  let pipelineStates: Awaited<
    ReturnType<typeof loadPipelineRowStates>
  > = {};

  try {
    pipelineStates = await loadPipelineRowStates(
      getReportServiceClient(),
      requests.map((request) => ({
        id: request.id,
        protocolId: request.protocolId,
      }))
    );
  } catch {
    pipelineStates = {};
  }

  const rows: RequestRow[] = requests.map((request) => {
    const parts = formatParts(request.createdAt);

    return {
      id: request.id,
      companyName: request.companyName,
      normalizedDomain: request.normalizedDomain,
      websiteUrl: request.websiteUrl,
      contactName: request.contactName,
      workEmail: request.workEmail,
      // `buyerCategory` holds the full buyer-question text; the column name
      // predates that framing (see lib/db/types.ts).
      buyerQuestion: request.buyerCategory,
      status: request.status,
      origin: request.origin,
      progressStage: request.progressStage,
      createdAt: request.createdAt,
      createdDate: parts.date,
      createdTime: parts.time,
      pipeline: pipelineStates[request.id] ?? {
        jobStatus: null,
        stale: false,
        integrityStatus: null,
        publicToken: null,
        delivered: false,
      },
    };
  });

  return (
    <AdminShell
      email={user.email}
      active="requests"
      health={summarizeHealth(rows)}
    >
      <div className="zpa-page-head">
        <div>
          <p className="zpa-eyebrow">Free snapshots</p>
          <h1 className="zpa-title">Snapshot requests</h1>
          <p className="zpa-subtitle">
            Review and manage incoming snapshot requests from potential
            customers.
          </p>
        </div>

        <NewAuditPanel />
      </div>

      <FounderBaselinePanel rows={founderBaselines} />

      <RequestsTable rows={rows} />
    </AdminShell>
  );
}
