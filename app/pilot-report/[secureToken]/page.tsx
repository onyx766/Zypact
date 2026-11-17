import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PilotReportView } from "@/components/report/pilot-report-view";
import { isPilotReportPayload } from "@/lib/reports/pilot-report-types";
import { readSharedPilotReport } from "@/lib/reports/process-pilot-report";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Private pilot report",
  description: "A private pilot report prepared by Zypact.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

/** The link token is 64 lowercase hex characters (save_pilot_report_artifact). */
const PILOT_REPORT_TOKEN = /^[0-9a-f]{64}$/;

/**
 * D-055 — the customer's view of one shared revision of a pilot report.
 * Holding the link is not enough on its own: the database answers only a
 * revision the founder has shared, and never a blocked one
 * (read_shared_pilot_report). Anything else is a 404.
 */
export default async function PilotReportPage({ params }: { params: Promise<{ secureToken: string }> }) {
  const { secureToken } = await params;
  if (!PILOT_REPORT_TOKEN.test(secureToken)) notFound();

  const shared = await readSharedPilotReport(getReportServiceClient(), secureToken);
  if (!shared) notFound();
  if (!isPilotReportPayload(shared.payload)) notFound();

  return (
    <PilotReportView
      payload={shared.payload}
      revision={shared.revision}
      sharedAt={shared.sharedAt}
      newerSharedRevision={shared.newerSharedRevision}
    />
  );
}
