import Link from "next/link";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
}

export default async function PromptsPage({ params }: PageProps) {
  const db = getDb();
  const [project, prompts] = await Promise.all([
    db.getProject(params.id),
    db.getGeneratedPrompts(params.id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Buyer Prompts</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const sorted = [...prompts].sort(
    (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)
  );
  const recommendedCount = prompts.filter((p) => p.selected).length;

  return (
    <div>
      <h1>Buyer Prompts</h1>
      <p>
        <Link href={`/projects/${params.id}/mirror`}>← Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/probe`}>Manual Probe →</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/lost-prompts`}>Lost / partial →</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/competitors`}>Competitors →</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Total prompts:</strong> {prompts.length}
        <br />
        <strong>Recommended for AI Probe:</strong> {recommendedCount}
      </div>

      {prompts.length === 0 ? (
        <div className="section">
          <p>No buyer prompts have been generated yet.</p>
          <p>
            Go to the{" "}
            <Link href={`/projects/${params.id}/mirror`}>Mirror Profile page</Link>{" "}
            and click <em>Generate Buyer Prompts</em>.
          </p>
        </div>
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
                <th style={cell}>#</th>
                <th style={cell}>Prompt</th>
                <th style={cell}>Intent</th>
                <th style={cell}>Commercial (1-5)</th>
                <th style={cell}>Winnability (1-5)</th>
                <th style={cell}>Priority</th>
                <th style={cell}>Selected</th>
                <th style={cell}>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={p.id} style={{ background: p.selected ? "#f4fbf5" : undefined }}>
                  <td style={cell}>{i + 1}</td>
                  <td style={cell}>{p.prompt}</td>
                  <td style={cell}>
                    <span className="badge">{p.intentType}</span>
                  </td>
                  <td style={cell}>{p.commercialValue}</td>
                  <td style={cell}>{p.winnability}</td>
                  <td style={cell}>
                    <strong>{p.priority}</strong>
                  </td>
                  <td style={cell}>{p.selected ? "yes" : "no"}</td>
                  <td style={{ ...cell, color: "#555" }}>{p.rationale}</td>
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
