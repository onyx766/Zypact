import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  requireFounderForPage,
} from "@/lib/auth/founder";
import { ApproveButton } from "../approve-button";
import { RejectButton } from "../reject-button";
import { SendReportButton } from "../send-report-button";
import { ReplaceReportPanel } from "../replace-report-panel";
import { toSnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDate(
  value: string | null
): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      dateStyle: "medium",
      timeStyle: "short",
    }
  ).format(date);
}

function statusLabel(
  value: string
): string {
  return value
    .split("_")
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1)
    )
    .join(" ");
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns:
          "minmax(150px, 220px) 1fr",
        gap: 20,
        padding: "14px 0",
        borderBottom:
          "1px solid #eeeeee",
      }}
    >
      <strong
        style={{
          color: "#666",
          fontSize: 13,
        }}
      >
        {label}
      </strong>

      <div
        style={{
          minWidth: 0,
          overflowWrap:
            "anywhere",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Inline preview for one stored report artifact.
 *
 * Rendered as pre-formatted plain text, not as parsed Markdown. The
 * repository has no Markdown-rendering dependency installed, and adding one
 * is out of scope for this change, so the raw source is shown verbatim
 * inside a bounded scroll container. `dangerouslySetInnerHTML` is
 * deliberately not used: report content is model-generated and must never
 * reach the DOM as HTML.
 *
 * An empty artifact column renders an explicit neutral state rather than a
 * blank panel, so the founder can tell "no content" from "not loaded".
 */
function ReportPreview({
  heading,
  filename,
  markdown,
}: {
  heading: string;
  filename: string;
  markdown: string;
}) {
  const isEmpty =
    markdown.trim().length === 0;

  return (
    <section
      className="founder-report-preview"
      style={{ marginTop: 24 }}
    >
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 15,
        }}
      >
        {heading}
      </h3>

      <p
        style={{
          margin: "0 0 10px",
          color: "#777",
          fontSize: 12,
        }}
      >
        {filename} ·{" "}
        {markdown.length.toLocaleString(
          "en-US"
        )}{" "}
        characters
      </p>

      {isEmpty ? (
        <p
          style={{
            margin: 0,
            color: "#777",
            fontSize: 13,
          }}
        >
          This report is empty.
        </p>
      ) : (
        <pre
          style={{
            maxHeight: 520,
            overflow: "auto",
            margin: 0,
            padding: 20,
            borderRadius: 12,
            background: "#f7f7f7",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          {markdown}
        </pre>
      )}
    </section>
  );
}

export default async function SnapshotRequestDetailPage({
  params,
}: {
  params: Promise<{
    requestId: string;
  }>;
}) {
  const { requestId } = await params;

  if (!UUID_PATTERN.test(requestId)) {
    notFound();
  }

  await requireFounderForPage(
    `/admin/snapshot-requests/${requestId}`
  );

  const db = getDb();

  const [
    request,
    artifact,
  ] = await Promise.all([
    db.getSnapshotRequest(requestId),
    db.getSnapshotReportArtifact(
      requestId
    ),
  ]);

  if (!request) {
    notFound();
  }

  return (
    <main
      className="founder-page founder-request-detail"
      style={{
        minHeight: "100vh",
        background: "#fafafa",
      }}
    >
      <section
        className="founder-shell"
        style={{
          maxWidth: 1040,
          margin: "0 auto",
          padding:
            "40px 24px 80px",
        }}
      >
        <a
          href="/admin/snapshot-requests"
          style={{
            display: "inline-block",
            marginBottom: 24,
            color: "#555",
            textDecoration:
              "underline",
          }}
        >
          ← Back to snapshot requests
        </a>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent:
              "space-between",
            gap: 24,
            flexWrap: "wrap",
            marginBottom: 28,
          }}
        >
          <div>
            <p
              style={{
                margin: "0 0 8px",
                color: "#888",
                fontSize: 13,
                textTransform:
                  "uppercase",
                letterSpacing:
                  "0.04em",
              }}
            >
              Founder operations
            </p>

            <h1
              style={{
                margin: 0,
                fontSize: 38,
                lineHeight: 1.1,
              }}
            >
              {request.companyName}
            </h1>

            <p
              style={{
                margin: "10px 0 0",
                color: "#666",
              }}
            >
              {request.normalizedDomain}
            </p>
          </div>

          <span
            className={`founder-status founder-status-${request.status}`}
            style={{
              display:
                "inline-flex",
              borderRadius: 999,
              background: "#eeeeee",
              padding:
                "8px 12px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {statusLabel(
              request.status
            )}
          </span>
        </div>

        <section
          className="founder-info-card"
          style={{
            border:
              "1px solid #e5e5e5",
            borderRadius: 14,
            background: "#fff",
            padding:
              "10px 24px",
            marginBottom: 28,
          }}
        >
          <DetailRow label="Website">
            <a
              href={request.websiteUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                textDecoration:
                  "underline",
              }}
            >
              {request.websiteUrl}
            </a>
          </DetailRow>

          <DetailRow label="Contact name">
            {request.contactName || "—"}
          </DetailRow>

          <DetailRow label="Contact">
            <a
              href={`mailto:${request.workEmail}`}
              style={{
                textDecoration:
                  "underline",
              }}
            >
              {request.workEmail}
            </a>
          </DetailRow>

          <DetailRow label="Buyer question">
            {request.buyerCategory}
          </DetailRow>

          <DetailRow label="Progress">
            {request.progressStage
              ? statusLabel(
                  request.progressStage
                )
              : "—"}
          </DetailRow>

          <DetailRow label="Project ID">
            {request.projectId || "—"}
          </DetailRow>

          <DetailRow label="Requested">
            {formatDate(
              request.createdAt
            )}
          </DetailRow>

          <DetailRow label="Updated">
            {formatDate(
              request.updatedAt
            )}
          </DetailRow>

          <DetailRow label="Approval">
            {request.approvedAt
              ? "Approved"
              : "Not approved yet"}
          </DetailRow>

          <DetailRow label="Approved at">
            {formatDate(
              request.approvedAt
            )}
          </DetailRow>

          {/*
            Founder-only review metadata. `approvedBy` is an internal auth
            user id and is deliberately not surfaced on the public report
            page — this detail page is gated by requireFounderForPage.
          */}
          <DetailRow label="Approved by">
            {request.approvedBy || "—"}
          </DetailRow>
        </section>

        {request.status ===
        "pending_approval" ? (
          <section
            className="founder-decision-row"
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 28,
            }}
          >
            <ApproveButton
              requestId={request.id}
              competitors={
                request.competitors
              }
              scannedCompany={
                request.companyName
              }
              scannedDomain={
                request.normalizedDomain
              }
            />

            <RejectButton
              requestId={request.id}
            />
          </section>
        ) : null}

        <section
          className="founder-report-card"
          style={{
            border:
              "1px solid #e5e5e5",
            borderRadius: 14,
            background: "#fff",
            padding: 24,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems:
                "flex-start",
              justifyContent:
                "space-between",
              gap: 20,
              flexWrap: "wrap",
              marginBottom: 20,
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 24,
                }}
              >
                Snapshot report
              </h2>

              <p
                style={{
                  margin:
                    "8px 0 0",
                  color: "#666",
                }}
              >
                {artifact
                  ? `Generated ${formatDate(
                      artifact.generatedAt
                    )}`
                  : "No persisted report is available yet."}
              </p>
            </div>

            {artifact ? (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <SendReportButton
                  requestId={request.id}
                  recipientEmail={request.workEmail}
                  alreadyDelivered={Boolean(
                    artifact.deliveredAt
                  )}
                  expectedArtifactId={artifact.id}
                  expectedRevision={
                    toSnapshotReportPublicationState(
                      artifact
                    ).revision
                  }
                  deliveryClaimActive={
                    artifact.deliveryClaimActive
                  }
                />

                <a
                  href={`/report/${artifact.publicToken}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display:
                      "inline-flex",
                    alignItems:
                      "center",
                    minHeight: 38,
                    border:
                      "1px solid #111",
                    borderRadius: 999,
                    padding:
                      "0 14px",
                    background: "#fff",
                    color: "#111",
                    textDecoration:
                      "none",
                    fontWeight: 600,
                  }}
                >
                  Preview client report
                </a>

                <a
                  href={`/api/internal/snapshot-requests/${request.id}/reports/short`}
                  style={{
                    display:
                      "inline-flex",
                    alignItems:
                      "center",
                    minHeight: 38,
                    border:
                      "1px solid #d0d0d0",
                    borderRadius: 999,
                    padding:
                      "0 14px",
                    color: "#111",
                    textDecoration:
                      "none",
                    fontWeight: 600,
                  }}
                >
                  Download short report
                </a>

                <a
                  href={`/api/internal/snapshot-requests/${request.id}/reports/full`}
                  style={{
                    display:
                      "inline-flex",
                    alignItems:
                      "center",
                    minHeight: 38,
                    borderRadius: 999,
                    padding:
                      "0 14px",
                    background: "#111",
                    color: "#fff",
                    textDecoration:
                      "none",
                    fontWeight: 600,
                  }}
                >
                  Download full report
                </a>
              </div>
            ) : null}
          </div>

          {artifact ? (
            <>
              <p
                style={{
                  color: "#777",
                  fontSize: 13,
                }}
              >
                Short report:{" "}
                {artifact.shortReportMarkdown.length.toLocaleString(
                  "en-US"
                )}{" "}
                characters · Full report:{" "}
                {artifact.fullReportMarkdown.length.toLocaleString(
                  "en-US"
                )}{" "}
                characters · Delivered:{" "}
                {artifact.deliveredAt
                  ? formatDate(
                      artifact.deliveredAt
                    )
                  : "No"}
              </p>

              <ReportPreview
                heading="Short report"
                filename={
                  artifact.shortReportFilename
                }
                markdown={
                  artifact.shortReportMarkdown
                }
              />

              <ReportPreview
                heading="Full report"
                filename={
                  artifact.fullReportFilename
                }
                markdown={
                  artifact.fullReportMarkdown
                }
              />
            </>
          ) : (
            <p
              style={{
                margin: 0,
                color: "#777",
              }}
            >
              The report will appear here after
              the approved runner persists it.
            </p>
          )}
        </section>
      </section>
            {artifact ? (
              <ReplaceReportPanel
                requestId={request.id}
                state={toSnapshotReportPublicationState(
                  artifact
                )}
              />
            ) : null}
    </main>
  );
}
