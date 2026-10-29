import Link from "next/link";
import { getDb } from "@/lib/db";
import { ProbeRow } from "./probe-row";
import { requireProjectOwnerForPage } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProbePage({ params }: PageProps) {
  const { id } = await params;
  // The [id] layout's check does not bind this segment: Next.js can render
  // a page without re-running its layout, so each page enforces it itself.
  await requireProjectOwnerForPage(id, `/projects/${id}/[id]`);
  const db = getDb();
  const [project, prompts] = await Promise.all([
    db.getProject(id),
    db.getGeneratedPrompts(id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Manual Probe</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const selected = prompts.filter((p) => p.selected);
  const probeResults = await db.getProbeResultsByProject(id);
  const hasResults = probeResults.length > 0;

  return (
    <div>
      <h1>Manual Probe</h1>
      <p>
        <Link href={`/projects/${id}/prompts`}>← Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${id}/lost-prompts`}>
          Lost / partial results →
        </Link>
        {hasResults && (
          <>
            {" "}
            <span style={{ margin: "0 8px" }}>·</span>{" "}
            <Link href={`/projects/${id}/competitors`}>Competitors →</Link>
          </>
        )}
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Selected prompts:</strong> {selected.length}
      </div>

      <p className="muted">
        For each selected prompt: paste the raw answer you got from Perplexity,
        ChatGPT, or Gemini and click <em>Analyze Response</em>. Sprint 3 is
        manual only — no automated AI calls yet.
      </p>

      {selected.length === 0 ? (
        <div className="section">
          <p>No selected prompts for this project yet.</p>
          <p>
            Generate them from the{" "}
            <Link href={`/projects/${id}/mirror`}>Mirror Profile</Link>{" "}
            page first.
          </p>
        </div>
      ) : (
        selected
          .sort((a, b) => b.priority - a.priority)
          .map((p) => (
            <ProbeRow
              key={p.id}
              projectId={project.id}
              generatedPromptId={p.id}
              prompt={p.prompt}
              intentType={p.intentType}
              priority={p.priority}
            />
          ))
      )}
    </div>
  );
}
