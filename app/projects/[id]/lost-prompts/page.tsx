import Link from "next/link";
import { getDb } from "@/lib/db";
import type {
  CompetitorMention,
  SourceCitation,
} from "@/lib/schemas/probe-analysis.schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
}

function asCompetitors(x: unknown): CompetitorMention[] {
  return Array.isArray(x) ? (x as CompetitorMention[]) : [];
}
function asSources(x: unknown): SourceCitation[] {
  return Array.isArray(x) ? (x as SourceCitation[]) : [];
}

export default async function LostPromptsPage({ params }: PageProps) {
  const db = getDb();
  const [project, lost] = await Promise.all([
    db.getProject(params.id),
    db.getLostProbeResultsByProject(params.id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Lost / partial results</h1>
        <p className="error">Project not found.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Lost / partial results</h1>
      <p>
        <Link href={`/projects/${params.id}/probe`}>← Manual probe</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/prompts`}>Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/mirror`}>Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/competitors`}>Competitors →</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/gap-map`}>Gap Matrix →</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Lost or partial results:</strong> {lost.length}
      </div>

      {lost.length === 0 ? (
        <p className="muted">
          No lost or partial results stored yet. Run manual probes on the{" "}
          <Link href={`/projects/${params.id}/probe`}>Manual Probe page</Link>.
        </p>
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
                <th style={cell}>Prompt</th>
                <th style={cell}>Platform</th>
                <th style={cell}>Verdict</th>
                <th style={cell}>Client mentioned</th>
                <th style={cell}>Client position</th>
                <th style={cell}>Competitors</th>
                <th style={cell}>Sources</th>
                <th style={cell}>Why client lost</th>
              </tr>
            </thead>
            <tbody>
              {lost.map((r) => {
                const comps = asCompetitors(r.competitorsMentioned);
                const sources = asSources(r.sourcesCited);
                return (
                  <tr
                    key={r.id}
                    style={{
                      background: r.verdict === "lost" ? "#fbf3f3" : "#fbf9ef",
                    }}
                  >
                    <td style={cell}>{r.prompt}</td>
                    <td style={cell}>
                      <span className="badge">{r.platform}</span>
                    </td>
                    <td style={cell}>
                      <strong
                        style={{
                          color: r.verdict === "lost" ? "#721c24" : "#664d03",
                        }}
                      >
                        {r.verdict}
                      </strong>
                    </td>
                    <td style={cell}>{r.clientMentioned ? "yes" : "no"}</td>
                    <td style={cell}>{r.clientPosition}</td>
                    <td style={cell}>
                      {comps.length === 0
                        ? "—"
                        : comps.map((c) => c.name).join(", ")}
                    </td>
                    <td style={cell}>{sources.length}</td>
                    <td style={{ ...cell, color: "#555" }}>{r.whyClientLost}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cell: React.CSSProperties = {
  border: "1px solid #ddd",
  padding: "6px 8px",
  verticalAlign: "top",
};
