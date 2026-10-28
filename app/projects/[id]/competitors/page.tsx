import Link from "next/link";
import { getDb } from "@/lib/db";
import { DiscoverPanel } from "./discover-panel";
import { requireProjectOwnerForPage } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

function threatRank(t: string): number {
  return t === "high" ? 3 : t === "medium" ? 2 : t === "low" ? 1 : 0;
}

export default async function CompetitorsPage({ params }: PageProps) {
  const { id } = await params;
  // The [id] layout's check does not bind this segment: Next.js can render
  // a page without re-running its layout, so each page enforces it itself.
  await requireProjectOwnerForPage(id, `/projects/${id}/[id]`);
  const db = getDb();
  const [project, competitors, probeResults] = await Promise.all([
    db.getProject(id),
    db.getCompetitorsByProject(id),
    db.getProbeResultsByProject(id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Competitors</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const sorted = [...competitors].sort(
    (a, b) =>
      threatRank(b.threatLevel) - threatRank(a.threatLevel) ||
      b.mentionCount - a.mentionCount ||
      a.name.localeCompare(b.name)
  );

  return (
    <div>
      <h1>Competitors</h1>
      <p>
        <Link href={`/projects/${id}/mirror`}>Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/prompts`}>Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/probe`}>Manual Probe</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/lost-prompts`}>Lost / partial</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/gap-map`}>Gap Matrix →</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Probe results available:</strong> {probeResults.length}
        <br />
        <strong>Stored competitors:</strong> {competitors.length}
      </div>

      <DiscoverPanel projectId={project.id} hasProbeResults={probeResults.length > 0} />

      {competitors.length === 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          No competitors stored yet.
          {probeResults.length === 0 && (
            <>
              {" "}Analyze at least one probe response on the{" "}
              <Link href={`/projects/${id}/probe`}>Manual Probe</Link> page
              first.
            </>
          )}
        </p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
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
                <th style={cell}>Name</th>
                <th style={cell}>Website</th>
                <th style={cell}>Discovery source</th>
                <th style={cell}>Mentions</th>
                <th style={cell}>Threat</th>
                <th style={cell}>Confidence</th>
                <th style={cell}>Phantom</th>
                <th style={cell}>Blind spot</th>
                <th style={cell}>Prompt IDs</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr
                  key={c.id}
                  style={{
                    background:
                      c.threatLevel === "high"
                        ? "#fbf3f3"
                        : c.threatLevel === "medium"
                          ? "#fbf9ef"
                          : undefined,
                  }}
                >
                  <td style={cell}>
                    <strong>{c.name}</strong>
                  </td>
                  <td style={cell}>
                    {c.website ? (
                      <a href={c.website} target="_blank" rel="noreferrer">
                        {c.website}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={cell}>
                    <span className="badge">{c.discoverySource}</span>
                  </td>
                  <td style={cell}>{c.mentionCount}</td>
                  <td style={cell}>
                    <strong
                      style={{
                        color:
                          c.threatLevel === "high"
                            ? "#721c24"
                            : c.threatLevel === "medium"
                              ? "#664d03"
                              : "#495057",
                      }}
                    >
                      {c.threatLevel}
                    </strong>
                  </td>
                  <td style={cell}>{c.confidence}</td>
                  <td style={cell}>{c.isPhantom ? "yes" : "no"}</td>
                  <td style={cell}>{c.isBlindSpot ? "yes" : "no"}</td>
                  <td style={{ ...cell, color: "#555" }}>
                    {c.promptIds.length === 0 ? "—" : c.promptIds.join(", ")}
                  </td>
                </tr>
              ))}
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
