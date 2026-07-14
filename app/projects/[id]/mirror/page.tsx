import Link from "next/link";
import { getDb } from "@/lib/db";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import { GeneratePromptsButton } from "./generate-prompts-button";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  params: { id: string };
}

export default async function MirrorPage({ params }: PageProps) {
  const db = getDb();
  const [project, pages, mirrorRow, existingPrompts] = await Promise.all([
    db.getProject(params.id),
    db.getSitePages(params.id),
    db.getMirrorProfile(params.id),
    db.getGeneratedPrompts(params.id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Mirror Profile</h1>
        <p className="error">Project not found.</p>
        <p>
          <Link href="/projects/new">Start a new scan →</Link>
        </p>
      </div>
    );
  }

  const parsed = mirrorRow ? SiteReaderOutputSchema.safeParse(mirrorRow.json) : null;
  const mirror: SiteReaderOutput | null = parsed?.success ? parsed.data : null;

  const status: "pending" | "done" | "invalid" = !mirrorRow
    ? "pending"
    : mirror
      ? "done"
      : "invalid";

  return (
    <div>
      <h1>Mirror Profile</h1>
      <p>
        <Link href="/projects/new">← New scan</Link>{" "}
        <span style={{ margin: "0 8px" }}>·</span>{" "}
        <Link href={`/projects/${params.id}/evidence-bank`}>
          Evidence Bank →
        </Link>
      </p>

      <div className="section">
        <strong>Scan status:</strong>{" "}
        {status === "done" && <span>done</span>}
        {status === "pending" && <span>pending / not yet stored</span>}
        {status === "invalid" && (
          <span className="error">invalid — stored JSON did not match schema</span>
        )}
        <br />
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Category:</strong> {project.category ?? <em className="muted">unknown</em>}
        {status === "done" && (
          <GeneratePromptsButton
            projectId={project.id}
            hasExistingPrompts={existingPrompts.length > 0}
          />
        )}
      </div>

      <h2>Crawled pages ({pages.length})</h2>
      {pages.length === 0 ? (
        <p className="muted">No pages stored.</p>
      ) : (
        <ul>
          {pages.map((p) => (
            <li key={p.id}>
              <span className="badge">{p.pageType}</span>{" "}
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.title || p.url}
              </a>
            </li>
          ))}
        </ul>
      )}

      {mirror ? (
        <>
          <h2>Detected category</h2>
          <p>
            {mirror.detectedCategory || <em className="muted">—</em>}{" "}
            <span className="badge">confidence: {mirror.categoryConfidence}</span>
          </p>

          <Section title="Target audience" items={mirror.targetAudience} />
          <Section title="Use cases" items={mirror.useCases} />
          <Section title="Features" items={mirror.features} />
          <Section title="Pain points addressed" items={mirror.painPointsAddressed} />

          <h2>Claims</h2>
          {mirror.claims.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <ul>
              {mirror.claims.map((c, i) => (
                <li key={i}>
                  {c.claim}{" "}
                  <span className="badge">{c.hasProof ? "proof" : "no proof"}</span>{" "}
                  <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                    source
                  </a>
                </li>
              ))}
            </ul>
          )}

          <h2>Proof signals</h2>
          {mirror.proofSignals.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <ul>
              {mirror.proofSignals.map((s, i) => (
                <li key={i}>
                  <span className="badge">{s.type}</span> {s.detail}{" "}
                  <a href={s.sourceUrl} target="_blank" rel="noreferrer">
                    source
                  </a>
                </li>
              ))}
            </ul>
          )}

          <h2>Missing signals</h2>
          {mirror.missingSignals.length === 0 ? (
            <p className="muted">—</p>
          ) : (
            <ul>
              {mirror.missingSignals.map((s, i) => (
                <li key={i}>
                  <strong>{s.signal}</strong> — {s.whyItMatters}
                </li>
              ))}
            </ul>
          )}

          <Section title="Buyer intent angles" items={mirror.buyerIntentAngles} />

          <h2>AI readability notes</h2>
          <p>{mirror.aiReadabilityNotes || <em className="muted">—</em>}</p>

          <h2>Raw JSON</h2>
          <pre>{JSON.stringify(mirror, null, 2)}</pre>
        </>
      ) : mirrorRow ? (
        <>
          <h2>Raw stored JSON (schema validation failed)</h2>
          <pre>{JSON.stringify(mirrorRow.json, null, 2)}</pre>
        </>
      ) : (
        <p className="muted">No Mirror Profile stored yet.</p>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="muted">—</p>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </>
  );
}
