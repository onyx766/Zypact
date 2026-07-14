import Link from "next/link";
import { getDb } from "@/lib/db";
import { getOrCreateEvidenceBank } from "@/lib/pipeline/get-or-create-evidence-bank";
import { EvidenceBankForm } from "./evidence-bank-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
}

export default async function EvidenceBankPage({ params }: PageProps) {
  const db = getDb();
  const project = await db.getProject(params.id);
  if (!project) {
    return (
      <div>
        <h1>Evidence Bank</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const [result, fixBriefs] = await Promise.all([
    getOrCreateEvidenceBank(params.id),
    db.getFixBriefsByProject(params.id),
  ]);
  if (!result.ok) {
    return (
      <div>
        <h1>Evidence Bank</h1>
        <p>
          <Link href={`/projects/${params.id}/mirror`}>← Mirror Profile</Link>
        </p>
        <p className="error">Could not load Evidence Bank: {result.error}</p>
      </div>
    );
  }

  const hasFixBriefs = fixBriefs.length > 0;

  return (
    <div>
      <h1>Evidence Bank</h1>
      <p>
        <Link href={`/projects/${params.id}/mirror`}>Mirror Profile</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/prompts`}>Buyer prompts</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/probe`}>Manual Probe</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/competitors`}>Competitors</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/gap-map`}>Gap Matrix</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/fix-briefs`}>Fix Briefs</Link>
        {hasFixBriefs && (
          <>
            {" "}
            <span style={{ margin: "0 8px" }}>·</span>{" "}
            <Link href={`/projects/${params.id}/assets`}>
              Generated assets →
            </Link>
          </>
        )}
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <span className="muted">
          Tell Zypact what it is allowed to use before generating fixes.
          Anything not listed here — proof, claims, guarantees — is off-limits
          for future generated assets.
        </span>
      </div>

      <EvidenceBankForm
        projectId={project.id}
        initial={result.bank}
        wasCreated={result.created}
      />
    </div>
  );
}
