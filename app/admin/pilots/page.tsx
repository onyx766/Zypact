import Link from "next/link";

import { requireFounderForPage } from "@/lib/auth/founder";
import { pilotEnginesSubtitle } from "@/lib/pilots/copy";
import { pilotChatGptEnabled } from "@/lib/pilots/engines";
import { listPilots, type PilotSummary } from "@/lib/pilots/reads";
import { todayUtc } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { AdminShell, type AdminHealth } from "../admin-shell";
import { NewPilotPanel } from "./pilot-forms";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * D-054 — managed pilots: one project per customer holding up to 20
 * customer-approved buyer questions, each measured on its own Run.
 */
function health(pilots: PilotSummary[], today: string): AdminHealth {
  const open = pilots.filter((p) => p.status === "active" && today <= p.endsOn).length;
  const overdue = pilots.filter((p) => p.status === "active" && today > p.endsOn).length;
  if (overdue > 0) {
    return { ok: false, title: "Attention needed", note: `${overdue} pilot${overdue === 1 ? " is" : "s are"} past the end date and still open.` };
  }
  return { ok: true, title: open === 0 ? "No open pilots" : `${open} open pilot${open === 1 ? "" : "s"}`, note: "Each question runs only when you press Run." };
}

export default async function PilotsAdminPage() {
  const user = await requireFounderForPage("/admin/pilots");
  let pilots: PilotSummary[] = [];
  let loadFailed = false;
  try {
    pilots = await listPilots(getReportServiceClient());
  } catch {
    loadFailed = true;
  }
  const today = todayUtc();

  return (
    <AdminShell email={user.email} active="pilots" health={health(pilots, today)}>
      <div className="zpa-page-head">
        <div>
          <p className="zpa-eyebrow">Managed pilots</p>
          <h1 className="zpa-title">Pilots</h1>
          {/* D-061 — the web host's ChatGPT gate, read at request time. */}
          <p className="zpa-subtitle">{pilotEnginesSubtitle(pilotChatGptEnabled())}</p>
        </div>
        <NewPilotPanel />
      </div>

      {loadFailed ? (
        <div className="zpa-empty">
          <p className="zpa-empty-title">Pilots could not be loaded.</p>
          <p className="zpa-muted">The pilot tables may not exist on this database yet.</p>
        </div>
      ) : pilots.length === 0 ? (
        <div className="zpa-empty">
          <p className="zpa-empty-title">No pilots yet.</p>
        </div>
      ) : (
        <div className="zpa-card zpa-table-scroll">
          <table className="zpa-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Questions</th>
                <th>Window</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pilots.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/admin/pilots/${p.id}`} className="zpa-company">
                      <span className="zpa-company-name">{p.companyName}</span>
                      <span className="zpa-company-domain">{p.normalizedDomain}</span>
                    </Link>
                  </td>
                  <td>
                    {p.questionCount} of {p.questionLimit}
                  </td>
                  <td className="zpa-nowrap">
                    {p.startsOn} to {p.endsOn}
                  </td>
                  <td>{p.status === "closed" ? "Closed" : today > p.endsOn ? "Past end date" : "Open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
