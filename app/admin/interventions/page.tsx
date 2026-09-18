import { requireFounderForPage } from "@/lib/auth/founder";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { listInterventions } from "@/lib/interventions/intervention-actions";
import { listRegistrableBaselines } from "@/lib/interventions/admin-reads";
import { interventionAdminEnabled } from "@/lib/interventions/route-guard";
import { AdminShell, type AdminHealth } from "../admin-shell";
import { InterventionsTable, type InterventionRow } from "./interventions-table";
import "./interventions.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const TIME = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });

function parts(iso: string | null): { date: string; time: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { date: DATE.format(d), time: TIME.format(d) };
}

/**
 * Derived from the rows on screen, never asserted. A proposal waiting on the
 * founder, or a retest that is ready but not started, needs a human.
 */
function summarizeHealth(rows: InterventionRow[]): AdminHealth {
  const awaiting = rows.filter((r) => r.status === "proposed").length;
  const ready = rows.filter((r) => r.eligibility?.eligible).length;
  if (awaiting === 0 && ready === 0) {
    return { ok: true, title: "Nothing waiting on you", note: "No proposals to review or retests ready." };
  }
  const bits: string[] = [];
  if (awaiting) bits.push(`${awaiting} to review`);
  if (ready) bits.push(`${ready} retest${ready === 1 ? "" : "s"} ready`);
  return { ok: false, title: "Attention needed", note: `${bits.join(" · ")}.` };
}

export default async function InterventionsAdminPage() {
  const user = await requireFounderForPage("/admin/interventions");
  const client = getReportServiceClient();

  const [items, baselines] = await Promise.all([
    listInterventions(client, { limit: 200 }),
    listRegistrableBaselines(client),
  ]);

  const rows: InterventionRow[] = items.map(({ intervention: iv, companyName, domain, eligibility }) => ({
    id: iv.id,
    status: iv.status,
    hypothesis: iv.hypothesis,
    actionType: iv.actionType,
    actionTarget: iv.actionTarget,
    companyName,
    domain,
    evidenceCount: iv.supportingEvidence.length,
    createdAt: iv.createdAt,
    created: parts(iv.createdAt),
    implemented: parts(iv.implementedAt),
    eligibility: eligibility
      ? {
          label: eligibility.label,
          tone: eligibility.tone,
          eligible: eligibility.eligible,
          windowClosesAt: eligibility.windowClosesAt,
        }
      : null,
  }));

  return (
    <AdminShell email={user.email} active="interventions" health={summarizeHealth(rows)}>
      <InterventionsTable
        rows={rows}
        baselines={baselines}
        actionsEnabled={interventionAdminEnabled()}
      />
    </AdminShell>
  );
}
