import { Fragment } from "react";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import { EvidenceBankOutputSchema } from "@/lib/schemas/evidence-bank.schema";
import { GapRow } from "./gap-row";

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

export default async function FixBriefsPage({ params }: PageProps) {
  const { id } = await params;
  const db = getDb();
  const [project, gaps, bankRow, probeResults, fixBriefs, assets] =
    await Promise.all([
      db.getProject(id),
      db.getGapsByProject(id),
      db.getEvidenceBankByProject(id),
      db.getProbeResultsByProject(id),
      db.getFixBriefsByProject(id),
      db.getGeneratedAssetsByProject(id),
    ]);

  if (!project) {
    return (
      <div>
        <h1>Fix Briefs</h1>
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

  const lostOrPartialCount = probeResults.filter(
    (r) => r.verdict === "lost" || r.verdict === "partial"
  ).length;

  const sortedGaps = [...gaps].sort((a, b) => {
    const rank = (s: string) =>
      s === "high" ? 0 : s === "medium" ? 1 : 2;
    return rank(a.severity) - rank(b.severity);
  });

  const gapById = new Map(gaps.map((g) => [g.id, g]));

  return (
    <div>
      <h1>Fix Briefs</h1>
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
        <Link href={`/projects/${id}/assets`}>Generated assets →</Link>
        {assets.length > 0 && (
          <>
            {" "}
            <span style={{ margin: "0 8px" }}>·</span>{" "}
            <Link href={`/projects/${id}/qa`}>QA</Link>
          </>
        )}
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Gaps available:</strong> {gaps.length}
        <br />
        <strong>Lost / partial probe results:</strong> {lostOrPartialCount}
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
          Prepare the Evidence Bank before generating fix briefs.{" "}
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
      {gaps.length === 0 && (
        <p className="error">
          No prioritized gaps stored. Generate a Gap Matrix first.{" "}
          <Link href={`/projects/${id}/gap-map`}>Open Gap Matrix →</Link>
        </p>
      )}
      {lostOrPartialCount === 0 && (
        <p className="error">
          Run at least one lost or partial probe analysis before generating fix
          briefs.{" "}
          <Link href={`/projects/${id}/probe`}>Open Manual Probe →</Link>
        </p>
      )}

      <h2 style={{ marginTop: 24 }}>Prioritized gaps</h2>
      {sortedGaps.length === 0 ? (
        <p className="muted">No gaps to generate briefs for yet.</p>
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
                <th style={cell}>Type</th>
                <th style={cell}>Severity</th>
                <th style={cell}>Explanation</th>
                <th style={cell}>Affected prompts</th>
                <th style={cell}>Suggested fix direction</th>
                <th style={cell}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedGaps.map((g) => (
                <GapRow
                  key={g.id}
                  projectId={project.id}
                  gap={g}
                  canGenerate={
                    bankUsable && lostOrPartialCount > 0
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Saved Fix Briefs</h2>
      {fixBriefs.length === 0 ? (
        <p className="muted">No Fix Briefs generated yet.</p>
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
                <th style={cell}>Priority</th>
                <th style={cell}>Status</th>
                <th style={cell}>Fix type</th>
                <th style={cell}>Lost prompt</th>
                <th style={cell}>Competitor recommended</th>
                <th style={cell}>Recommended fix</th>
                <th style={cell}>Evidence</th>
                <th style={cell}>Expected impact</th>
              </tr>
            </thead>
            <tbody>
              {fixBriefs.map((f) => {
                const gap = f.gapId ? gapById.get(f.gapId) : undefined;
                return (
                  <Fragment key={f.id}>
                    <tr
                      style={{
                        background:
                          f.status === "needs_evidence"
                            ? "#fbf9ef"
                            : f.status === "ready_for_assets"
                              ? "#eefaf1"
                              : undefined,
                      }}
                    >
                      <td style={{ ...cell, fontWeight: 600 }}>{f.priority}</td>
                      <td style={cell}>
                        <strong
                          style={{
                            color:
                              f.status === "needs_evidence"
                                ? "#664d03"
                                : f.status === "ready_for_assets"
                                  ? "#0f5132"
                                  : "#495057",
                          }}
                        >
                          {f.status}
                        </strong>
                      </td>
                      <td style={cell}>{f.fixType}</td>
                      <td style={cell}>{f.lostPrompt}</td>
                      <td style={cell}>{f.competitorRecommended}</td>
                      <td style={cell}>{f.recommendedFix}</td>
                      <td style={cell}>
                        {f.evidenceAvailable.length} available ·{" "}
                        {f.evidenceNeeded.length} needed
                      </td>
                      <td style={cell}>{f.expectedImpact}</td>
                    </tr>
                    <tr>
                      <td colSpan={8} style={{ ...cell, background: "#fafafa" }}>
                        <details>
                          <summary>
                            <strong>Details</strong> ·{" "}
                            <span className="muted">
                              created{" "}
                              {new Date(f.createdAt).toLocaleString()}
                              {gap ? ` · gap: ${gap.type}/${gap.severity}` : ""}
                            </span>
                          </summary>
                          <div style={{ marginTop: 8 }}>
                            <p>
                              <strong>Root cause:</strong> {f.rootCause}
                            </p>
                            <p>
                              <strong>Evidence needed</strong> (
                              {f.evidenceNeeded.length}):
                            </p>
                            {f.evidenceNeeded.length === 0 ? (
                              <p className="muted">
                                None — the Evidence Bank already covers this
                                fix.
                              </p>
                            ) : (
                              <ul style={{ margin: "0 0 8px 20px" }}>
                                {f.evidenceNeeded.map((e, i) => (
                                  <li key={i}>{e}</li>
                                ))}
                              </ul>
                            )}
                            <p>
                              <strong>Evidence available</strong> (
                              {f.evidenceAvailable.length}):
                            </p>
                            {f.evidenceAvailable.length === 0 ? (
                              <p className="muted">
                                None yet — populate the Evidence Bank.
                              </p>
                            ) : (
                              <ul style={{ margin: "0 0 8px 20px" }}>
                                {f.evidenceAvailable.map((e, i) => (
                                  <li key={i}>{e}</li>
                                ))}
                              </ul>
                            )}
                            <p>
                              <strong>Assets to generate later:</strong>{" "}
                              {f.assetsToGenerate.join(", ")}
                            </p>
                          </div>
                        </details>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Sprint 7 scope: Fix Brief only. Assets, QA, and exports come in later
        sprints — no buttons for those on purpose.
      </p>
    </div>
  );
}
