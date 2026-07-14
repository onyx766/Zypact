import Link from "next/link";
import { getDb } from "@/lib/db";
import {
  GAP_DIMENSIONS,
  GapMapOutputSchema,
  type GapMapOutput,
} from "@/lib/schemas/gap-map.schema";
import { GeneratePanel } from "./generate-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
}

function heatColor(score: number): string {
  if (score >= 9) return "#f8d7da";
  if (score >= 6) return "#fde2c8";
  if (score >= 3) return "#fff3cd";
  if (score > 0) return "#e8f5e9";
  return "#ffffff";
}

export default async function GapMapPage({ params }: PageProps) {
  const db = getDb();
  const [project, probeResults, competitors, gapMapRow, gaps] = await Promise.all([
    db.getProject(params.id),
    db.getProbeResultsByProject(params.id),
    db.getCompetitorsByProject(params.id),
    db.getLatestGapMap(params.id),
    db.getGapsByProject(params.id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Gap Matrix</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  let parsedMap: GapMapOutput | null = null;
  let parseError: string | null = null;
  if (gapMapRow) {
    const parsed = GapMapOutputSchema.safeParse(gapMapRow.json);
    if (parsed.success) parsedMap = parsed.data;
    else parseError = parsed.error.message;
  }

  return (
    <div>
      <h1>Gap Matrix</h1>
      <p>
        <Link href={`/projects/${params.id}/mirror`}>Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/prompts`}>Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/probe`}>Manual Probe</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/lost-prompts`}>Lost / partial</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/competitors`}>Competitors</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/evidence-bank`}>Evidence Bank</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/fix-briefs`}>Fix Briefs →</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Probe results available:</strong> {probeResults.length}
        <br />
        <strong>Competitors available:</strong> {competitors.length} ·{" "}
        <span className="muted">
          {competitors.filter((c) => c.threatLevel === "high").length} high,{" "}
          {competitors.filter((c) => c.threatLevel === "medium").length} medium
        </span>
        <br />
        <strong>Latest Gap Map:</strong>{" "}
        {gapMapRow ? new Date(gapMapRow.createdAt).toLocaleString() : (
          <span className="muted">none yet</span>
        )}
      </div>

      <GeneratePanel
        projectId={project.id}
        hasProbeResults={probeResults.length > 0}
        hasCompetitors={competitors.length > 0}
      />

      {parseError && (
        <p className="error" style={{ marginTop: 12 }}>
          Stored Gap Map failed schema validation: {parseError}
        </p>
      )}

      {parsedMap && (
        <>
          <h2 style={{ marginTop: 24 }}>Competitor distances</h2>
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
                  <th style={cell}>Competitor</th>
                  <th style={cell}>Distance (0–60)</th>
                  {GAP_DIMENSIONS.map((d) => (
                    <th key={d} style={cell}>
                      {d}
                    </th>
                  ))}
                  <th style={cell}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {parsedMap.competitorDistances.map((d) => (
                  <tr key={d.competitor}>
                    <td style={cell}>
                      <strong>{d.competitor}</strong>
                    </td>
                    <td style={{ ...cell, fontWeight: 600 }}>
                      {d.recommendationDistance}
                    </td>
                    {GAP_DIMENSIONS.map((dim) => (
                      <td
                        key={dim}
                        style={{
                          ...cell,
                          background: heatColor(d.gapScores[dim]),
                          textAlign: "center",
                        }}
                      >
                        {d.gapScores[dim]}
                      </td>
                    ))}
                    <td style={cell}>{d.evidenceStrength}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary>
              <strong>Top reasons per competitor</strong>
            </summary>
            <div style={{ marginTop: 8 }}>
              {parsedMap.competitorDistances.map((d) => (
                <div
                  key={d.competitor}
                  style={{
                    marginBottom: 12,
                    padding: 8,
                    background: "#fafafa",
                    border: "1px solid #ddd",
                  }}
                >
                  <strong>{d.competitor}</strong>{" "}
                  <span className="muted">
                    (distance {d.recommendationDistance})
                  </span>
                  <ul style={{ margin: "6px 0 0 20px" }}>
                    {d.topReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>

          <h2 style={{ marginTop: 24 }}>Prioritized gaps</h2>
          {gaps.length === 0 ? (
            <p className="muted">No prioritized gaps stored.</p>
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
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr
                      key={g.id}
                      style={{
                        background:
                          g.severity === "high"
                            ? "#fbf3f3"
                            : g.severity === "medium"
                              ? "#fbf9ef"
                              : undefined,
                      }}
                    >
                      <td style={cell}>
                        <strong>{g.type}</strong>
                      </td>
                      <td style={cell}>
                        <strong
                          style={{
                            color:
                              g.severity === "high"
                                ? "#721c24"
                                : g.severity === "medium"
                                  ? "#664d03"
                                  : "#495057",
                          }}
                        >
                          {g.severity}
                        </strong>
                      </td>
                      <td style={cell}>{g.explanation}</td>
                      <td style={cell}>
                        {g.affectedPrompts.length === 0
                          ? "—"
                          : `${g.affectedPrompts.length} prompt${g.affectedPrompts.length === 1 ? "" : "s"}`}
                      </td>
                      <td style={cell}>{g.suggestedFixDirection}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 style={{ marginTop: 24 }}>Graph data (raw)</h2>
          <div className="section" style={{ fontSize: 12 }}>
            <div>
              <strong>Nodes:</strong> {parsedMap.nodes.length + 1}{" "}
              <span className="muted">(including client)</span>
              <br />
              <strong>Edges:</strong> {parsedMap.edges.length}
              <br />
              <strong>Client node:</strong>{" "}
              <code>
                {parsedMap.clientNode.id} — {parsedMap.clientNode.label}
              </code>
            </div>
            <details style={{ marginTop: 8 }}>
              <summary>Raw JSON</summary>
              <pre
                style={{
                  background: "#f6f8fa",
                  padding: 8,
                  overflow: "auto",
                  maxHeight: 400,
                  fontSize: 11,
                }}
              >
                {JSON.stringify(parsedMap, null, 2)}
              </pre>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

const cell: React.CSSProperties = {
  border: "1px solid #ddd",
  padding: "6px 8px",
  verticalAlign: "top",
};
