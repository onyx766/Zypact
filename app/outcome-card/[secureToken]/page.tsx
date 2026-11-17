import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { isValidPublicReportToken } from "@/lib/snapshot-requests/public-report-token";
import { isOutcomeCardPayload } from "@/lib/reports/outcome-card-types";
import { OutcomeCardView } from "@/components/report/outcome-card-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Private Outcome Card",
  description: "A private registered-retest Outcome Card prepared by Zypact.",
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

export default async function PublicOutcomeCardPage({
  params,
}: {
  params: Promise<{ secureToken: string }>;
}) {
  const { secureToken } = await params;

  if (!isValidPublicReportToken(secureToken)) {
    notFound();
  }

  const client = getReportServiceClient();
  const { data, error } = await client
    .from("outcome_card_artifacts")
    .select("payload,integrity_status,delivered_at")
    .eq("public_token", secureToken)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    notFound();
  }

  const artifact = data as {
    payload: unknown;
    integrity_status: string;
    delivered_at: string | null;
  };

  // Allowlist, matching the exact rule the baseline report page enforces
  // (app/report/[secureToken]/page.tsx) and for the same reason: holding a
  // link must never be enough to read a card the integrity gate has not
  // cleared. `blocked` vetoes unconditionally, whatever else is recorded.
  // 0076's begin_outcome_card_delivery already refuses to deliver a
  // blocked artifact at the database layer — this is the read-side half of
  // that same guarantee, independent of it.
  const readableByClient =
    artifact.integrity_status !== "blocked" &&
    (artifact.integrity_status === "integrity_passed" ||
      artifact.delivered_at !== null);

  if (!readableByClient) {
    notFound();
  }

  if (!isOutcomeCardPayload(artifact.payload)) {
    // A row that fails this narrowing is not a shape this page knows how to
    // render safely — fail closed rather than guess at a legacy format that,
    // unlike the baseline report, has no prior version to fall back to.
    notFound();
  }

  return <OutcomeCardView payload={artifact.payload} />;
}
