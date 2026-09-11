import { getDb } from "@/lib/db";
import { requireFounderForPage } from "@/lib/auth/founder";
import { FOUNDER_ADMIN_PATH } from "@/lib/auth/safe-next-path";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { loadPipelineRowStates } from "@/lib/reports/pipeline-row-state";
import { AdminShell, type AdminHealth } from "../admin-shell";
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

export default async function SnapshotRequestsAdminPage() {
  const user = await requireFounderForPage(FOUNDER_ADMIN_PATH);

  const requests = await getDb().listSnapshotRequests(100);

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
      </div>

      <RequestsTable rows={rows} />
    </AdminShell>
  );
}
