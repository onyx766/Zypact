import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ZypactLogo } from "@/components/zypact-logo";
import { getDb } from "@/lib/db";
import {
  isValidPublicReportToken,
} from "@/lib/snapshot-requests/public-report-token";
import {
  parsePublicSnapshotReport,
} from "@/lib/snapshot-requests/parse-public-report";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Private AI visibility snapshot — Zypact",
  description:
    "A private AI visibility snapshot prepared by Zypact.",
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

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="report-metric-card">
      <p>{label}</p>
      <strong>{value || "Not measured"}</strong>
    </article>
  );
}

export default async function PublicReportPage({
  params,
}: {
  params: {
    secureToken: string;
  };
}) {
  const secureToken =
    params.secureToken;

  if (
    !isValidPublicReportToken(
      secureToken
    )
  ) {
    notFound();
  }

  const db = getDb();

  const artifact =
    await db.getSnapshotReportArtifactByPublicToken(
      secureToken
    );

  if (!artifact) {
    notFound();
  }

  const report =
    parsePublicSnapshotReport(
      artifact.shortReportMarkdown
    );

  const testedRuns =
    report.promptRows.reduce(
      (total, row) =>
        total + (Number(row.runs) || 0),
      0
    );

  const lostBuyerMoments =
    report.promptRows.filter(
      (row) =>
        /^lost$/i.test(row.outcome)
    ).length;

  const missedEveryRun =
    report.promptRows.length > 0 &&
    report.promptRows.every(
      (row) =>
        row.recommended === "0%"
    );

  return (
    <main className="report-page">
      <header className="report-header">
        <ZypactLogo priority />

        <span className="report-private-label">
          Private snapshot
        </span>
      </header>

      <section className="report-hero">
        <p className="report-eyebrow">
          AI visibility snapshot
        </p>

        <h1>
          How AI currently sees{" "}
          {report.brand}
        </h1>

        <p className="report-domain">
          {report.website}
        </p>

        <p className="report-hero-copy">
          {report.executiveNarrative}
        </p>

        {missedEveryRun &&
        testedRuns > 0 ? (
          <div className="report-note">
            <strong>
              {report.brand} was absent
              from all {testedRuns} live
              AI answers tested.
            </strong>

            <p>
              {lostBuyerMoments} of{" "}
              {report.promptRows.length}{" "}
              buyer discovery or shortlist
              moments were lost.
            </p>
          </div>
        ) : null}

        <div className="report-meta">
          <span>
            Generated {report.generated}
          </span>
          <span>
            Category read by AI:{" "}
            {report.category}
          </span>
          <span>
            Trend: {report.trend}
          </span>
        </div>
      </section>

      <section className="report-shell">
        <div className="report-metrics">
          <MetricCard
            label="Visibility"
            value={report.visibility}
          />

          <MetricCard
            label="Branded reputation"
            value={
              report.brandedReputation
            }
          />

          <MetricCard
            label={report.competitorLabel}
            value={report.competitors}
          />
        </div>

        {report.brandedEvidencePrompt &&
        report.brandedEvidenceSummary ? (
          <section className="report-alert">
            <p className="report-section-label">
              Direct branded evidence
            </p>

            <h2>
              What AI said when your
              brand was named
            </h2>

            <blockquote>
              {report.brandedEvidencePrompt}
            </blockquote>

            <p>
              {
                report.brandedEvidenceSummary
              }
            </p>
          </section>
        ) : null}

        <section className="report-section">
          <div className="report-section-heading">
            <div>
              <p className="report-section-label">
                Buyer prompt evidence
              </p>
              <h2>
                What happened in the
                tested AI answers
              </h2>
            </div>

            {report.promptIntro ? (
              <p>{report.promptIntro}</p>
            ) : null}
          </div>

          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Buyer prompt</th>
                  <th>Runs</th>
                  <th>Recommended?</th>
                  <th>Cited?</th>
                  <th>Outcome</th>
                  <th>Type of loss</th>
                  <th>
                    Brands / products observed
                  </th>
                </tr>
              </thead>

              <tbody>
                {report.promptRows.map(
                  (row) => (
                    <tr
                      key={`${row.prompt}-${row.runs}`}
                    >
                      <td>{row.prompt}</td>
                      <td>{row.runs}</td>
                      <td>
                        {row.recommended}
                      </td>
                      <td>{row.cited}</td>
                      <td>
                        <span
                          className={`report-outcome report-outcome-${row.outcome
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, "-")}`}
                        >
                          {row.outcome}
                        </span>
                      </td>
                      <td>
                        {row.lossType ||
                          "Visibility loss"}
                      </td>
                      <td>
                        {row.competitors}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          {report.brandedCheck ? (
            <div className="report-note">
              <strong>
                Branded reputation check
              </strong>
              <p>{report.brandedCheck}</p>
            </div>
          ) : null}
        </section>

        <section className="report-section report-commercial">
          <p className="report-section-label">
            Why this matters
          </p>

          <h2>
            AI answers act like buyer
            shortlists
          </h2>

          <p>
            {report.commercialExplanation}
          </p>

          {report.focusPrompt ? (
            <blockquote>
              {report.focusPrompt}
            </blockquote>
          ) : null}

          {report.frameExplanation ? (
            <p>{report.frameExplanation}</p>
          ) : null}
        </section>

        <section className="report-fix">
          <div>
            <p className="report-section-label">
              First priority action
            </p>

            <h2>
              {report.firstFixHeading}
            </h2>

            <p>{report.firstFixBody}</p>
          </div>

          {report.evidenceNeeded.length >
          0 ? (
            <aside>
              <strong>
                Evidence needed before
                publishing
              </strong>

              <ul>
                {report.evidenceNeeded.map(
                  (item) => (
                    <li key={item}>
                      {item}
                    </li>
                  )
                )}
              </ul>
            </aside>
          ) : null}
        </section>

        {/*
          Validation phase: this preview is a founder-led conversation, not a
          self-service checkout. No price, no plan card, no Stripe link. There
          is no booking route in this app yet, so the copy renders without a
          button rather than pointing somewhere invented.
        */}
        <section className="report-upgrade">
          <p className="report-section-label">
            Want to go deeper?
          </p>

          <p>
            I can walk you through the buyer
            question you&rsquo;re losing, the
            evidence behind it, and the first
            fix worth testing.
          </p>

          <p>
            If useful, we can also expand the
            snapshot across more buyer
            questions and re-test what changes
            after the fix.
          </p>
        </section>

        <details className="report-integrity">
          <summary>
            Methodology and integrity
            notes
          </summary>

          <ul>
            {report.integrityNotes.map(
              (item) => (
                <li key={item}>
                  {item}
                </li>
              )
            )}
          </ul>
        </details>
      </section>

      <footer className="report-footer">
        <p>
          Prepared privately for{" "}
          {report.brand} by Zypact.
        </p>
      </footer>
    </main>
  );
}
