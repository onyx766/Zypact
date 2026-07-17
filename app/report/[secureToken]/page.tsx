import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ZypactLogo } from "@/components/zypact-logo";
import { getDb } from "@/lib/db";
import { PRICING_PLANS } from "@/lib/pricing/plans";
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

const growthUrl =
  process.env.STRIPE_GROWTH_URL ||
  "/#pricing";

const proUrl =
  process.env.STRIPE_PRO_URL ||
  "/#pricing";

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
                        <span className="report-outcome">
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

        <section className="report-upgrade">
          <p className="report-section-label">
            Continue with Zypact
          </p>

          <h2>
            Turn this snapshot into
            recurring fixes
          </h2>

          <p>
            {report.nextStep ||
              "Expand prompt coverage, track competitor movement, and turn the findings into evidence-verified fixes."}
          </p>

          <div className="report-plan-grid">
            <article>
              <span>
                {
                  PRICING_PLANS.growth
                    .name
                }
              </span>
              <strong>
                {
                  PRICING_PLANS.growth
                    .billingLabel
                }
              </strong>
              <p>
                {
                  PRICING_PLANS.growth
                    .positioning
                }
              </p>
              <a
                href={growthUrl}
                className="button button-primary"
              >
                Start Growth
              </a>
            </article>

            <article>
              <span>
                {PRICING_PLANS.pro.name}
              </span>
              <strong>
                {
                  PRICING_PLANS.pro
                    .billingLabel
                }
              </strong>
              <p>
                {
                  PRICING_PLANS.pro
                    .positioning
                }
              </p>
              <a
                href={proUrl}
                className="button button-secondary"
              >
                Start Pro
              </a>
            </article>
          </div>
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
