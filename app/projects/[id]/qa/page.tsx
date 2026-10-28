import { Fragment } from "react";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import { EvidenceBankOutputSchema } from "@/lib/schemas/evidence-bank.schema";
import type { QaReportRow } from "@/lib/db/types";
import { QaAssetPanel } from "./qa-asset-panel";
import { ExportDownloadButton } from "./export-download-button";
import { requireProjectOwnerForPage } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

const cell: React.CSSProperties = {
  border: "1px solid #ddd",
  padding: "6px 8px",
  verticalAlign: "top",
};

function verdictColor(v: string): string {
  switch (v) {
    case "safe_to_publish":
      return "#0f5132";
    case "needs_evidence":
      return "#664d03";
    case "unsupported_claims":
      return "#721c24";
    default:
      return "#495057";
  }
}

function qaStatusColor(s: string): string {
  switch (s) {
    case "safe_to_publish":
      return "#0f5132";
    case "needs_evidence":
      return "#664d03";
    case "unsupported_claims":
      return "#721c24";
    case "pending_qa":
      return "#664d03";
    default:
      return "#495057";
  }
}

export default async function QaPage({ params }: PageProps) {
  const { id } = await params;
  // The [id] layout's check does not bind this segment: Next.js can render
  // a page without re-running its layout, so each page enforces it itself.
  await requireProjectOwnerForPage(id, `/projects/${id}/[id]`);
  const db = getDb();
  const [project, assets, bankRow, allReports] = await Promise.all([
    db.getProject(id),
    db.getGeneratedAssetsByProject(id),
    db.getEvidenceBankByProject(id),
    db.getQaReportsByProject(id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>QA</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const parsedBank = bankRow ? EvidenceBankOutputSchema.safeParse(bankRow) : null;
  const bank = parsedBank && parsedBank.success ? parsedBank.data : null;
  const bankUsable = hasUsableEvidenceBank(bank);

  // Latest QA report per asset — reports come sorted newest-first from the
  // adapter, so we keep the first seen per assetId.
  const latestByAsset = new Map<string, QaReportRow>();
  for (const r of allReports) {
    if (!latestByAsset.has(r.generatedAssetId)) {
      latestByAsset.set(r.generatedAssetId, r);
    }
  }

  const notReadyCount = assets.filter((a) =>
    ["pending_qa", "needs_evidence", "unsupported_claims"].includes(a.qaStatus)
  ).length;

  return (
    <div>
      <h1>QA</h1>
      <p>
        <Link href={`/projects/${id}/mirror`}>Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/prompts`}>Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/probe`}>Manual Probe</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/competitors`}>Competitors</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/gap-map`}>Gap Matrix</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/evidence-bank`}>Evidence Bank</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/fix-briefs`}>Fix Briefs</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/assets`}>Generated assets</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Generated assets:</strong> {assets.length}
        <br />
        <strong>QA reports stored:</strong> {allReports.length}
        <br />
        <strong>Evidence Bank:</strong>{" "}
        {bank ? (
          bankUsable ? (
            <span>usable</span>
          ) : (
            <span className="error">present but not usable</span>
          )
        ) : (
          <span className="error">not yet prepared</span>
        )}
      </div>

      {!bank && (
        <p className="error">
          Prepare the Evidence Bank before running QA.{" "}
          <Link href={`/projects/${id}/evidence-bank`}>
            Open Evidence Bank →
          </Link>
        </p>
      )}
      {bank && !bankUsable && (
        <p className="error">
          The Evidence Bank exists but is missing a product description or
          features, or has fewer than three forbidden claims. Fix that first.{" "}
          <Link href={`/projects/${id}/evidence-bank`}>
            Open Evidence Bank →
          </Link>
        </p>
      )}
      {assets.length === 0 && (
        <p className="error">
          Generate at least one asset before running QA.{" "}
          <Link href={`/projects/${id}/assets`}>
            Open Generated assets →
          </Link>
        </p>
      )}

      <h2 style={{ marginTop: 24 }}>Assets awaiting or eligible for QA</h2>
      {assets.length === 0 ? (
        <p className="muted">No assets yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              background: "white",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", background: "#eee" }}>
                <th style={cell}>Title</th>
                <th style={cell}>Asset type</th>
                <th style={cell}>QA status</th>
                <th style={cell}>Placeholders</th>
                <th style={cell}>Claims used</th>
                <th style={cell}>Latest verdict</th>
                <th style={cell}>Run QA</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const latest = latestByAsset.get(a.id);
                return (
                  <Fragment key={a.id}>
                    <tr>
                      <td style={cell}>
                        <strong>{a.title}</strong>
                        <div className="muted" style={{ fontSize: 11 }}>
                          asset id: <code>{a.id.slice(0, 8)}…</code>
                        </div>
                      </td>
                      <td style={cell}>
                        <code>{a.assetType}</code>
                      </td>
                      <td style={cell}>
                        <strong style={{ color: qaStatusColor(a.qaStatus) }}>
                          {a.qaStatus}
                        </strong>
                      </td>
                      <td style={cell}>{a.placeholders.length}</td>
                      <td style={cell}>{a.claimsUsed.length}</td>
                      <td style={cell}>
                        {latest ? (
                          <div>
                            <strong style={{ color: verdictColor(latest.verdict) }}>
                              {latest.verdict}
                            </strong>
                            <div className="muted" style={{ fontSize: 11 }}>
                              {new Date(latest.createdAt).toLocaleString()} ·{" "}
                              {latest.violations.length} violation
                              {latest.violations.length === 1 ? "" : "s"} ·{" "}
                              {latest.placeholdersRemaining.length} placeholder
                              {latest.placeholdersRemaining.length === 1
                                ? ""
                                : "s"}
                            </div>
                          </div>
                        ) : (
                          <span className="muted">no QA report yet</span>
                        )}
                      </td>
                      <td style={cell}>
                        <QaAssetPanel
                          projectId={project.id}
                          asset={{
                            id: a.id,
                            title: a.title,
                            assetType: a.assetType,
                            qaStatus: a.qaStatus,
                          }}
                          canRun={bankUsable}
                          hasExistingReport={Boolean(latest)}
                        />
                      </td>
                    </tr>
                    {latest && (
                      <tr>
                        <td colSpan={7} style={{ ...cell, background: "#fafafa" }}>
                          <details>
                            <summary>
                              <strong>Latest QA report</strong>{" "}
                              <span className="muted">
                                (verdict:{" "}
                                <strong style={{ color: verdictColor(latest.verdict) }}>
                                  {latest.verdict}
                                </strong>
                                )
                              </span>
                            </summary>
                            <div style={{ marginTop: 8 }}>
                              <p style={{ margin: "0 0 6px" }}>
                                <strong>Overall notes.</strong>{" "}
                                {latest.overallNotes}
                              </p>
                              <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>
                                Placeholders remaining (
                                {latest.placeholdersRemaining.length})
                              </p>
                              {latest.placeholdersRemaining.length === 0 ? (
                                <p className="muted">None.</p>
                              ) : (
                                <ul style={{ margin: "0 0 8px 20px" }}>
                                  {latest.placeholdersRemaining.map((p, i) => (
                                    <li key={i}>
                                      <code>{p}</code>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>
                                Violations ({latest.violations.length})
                              </p>
                              {latest.violations.length === 0 ? (
                                <p className="muted">No violations.</p>
                              ) : (
                                <div style={{ overflowX: "auto" }}>
                                  <table
                                    style={{
                                      width: "100%",
                                      borderCollapse: "collapse",
                                      fontSize: 12,
                                    }}
                                  >
                                    <thead>
                                      <tr
                                        style={{
                                          textAlign: "left",
                                          background: "#f0f0f0",
                                        }}
                                      >
                                        <th style={cell}>Type</th>
                                        <th style={cell}>Quote</th>
                                        <th style={cell}>Reason</th>
                                        <th style={cell}>Suggested fix</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {latest.violations.map((v, i) => (
                                        <tr key={i}>
                                          <td style={cell}>
                                            <code>{v.type}</code>
                                          </td>
                                          <td
                                            style={{
                                              ...cell,
                                              maxWidth: 320,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {v.quote}
                                          </td>
                                          <td
                                            style={{
                                              ...cell,
                                              maxWidth: 320,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {v.reason}
                                          </td>
                                          <td
                                            style={{
                                              ...cell,
                                              maxWidth: 320,
                                              whiteSpace: "pre-wrap",
                                            }}
                                          >
                                            {v.suggestedFix}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </details>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          marginTop: 32,
          padding: 16,
          border: "1px solid #ddd",
          background: "#fafafa",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Export Markdown report</h2>
        <p style={{ marginTop: 0, fontSize: 13 }}>
          Server-side, read-only. No database writes, no LLM calls. Every
          asset&apos;s QA status is included verbatim; assets that have not
          passed QA are labeled <strong>NOT READY TO PUBLISH</strong> in the
          exported document.
        </p>
        {notReadyCount > 0 && (
          <p className="error" style={{ fontSize: 13 }}>
            Warning: {notReadyCount} asset{notReadyCount === 1 ? "" : "s"} in
            this project {notReadyCount === 1 ? "is" : "are"} not currently
            safe to publish. They will still appear in the export, clearly
            marked, so you can share the state with your team — do not ship
            those blocks as-is.
          </p>
        )}
        <div style={{ marginBottom: 0 }}>
          <ExportDownloadButton projectId={project.id} />
        </div>
      </div>

      <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Sprint 9 scope: QA reports are stored per asset per run, and{" "}
        <code>generated_assets.qa_status</code> is updated from the verdict.
        Sprint 11 adds a secure, read-only Markdown export above. Copy, publish,
        and PDF come in later sprints — no buttons for those on purpose.
      </p>
    </div>
  );
}
