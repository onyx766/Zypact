import { Fragment } from "react";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import { EvidenceBankOutputSchema } from "@/lib/schemas/evidence-bank.schema";
import { FixBriefPanel } from "./fix-brief-panel";

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

export default async function AssetsPage({ params }: PageProps) {
  const { id } = await params;
  const db = getDb();
  const [project, fixBriefs, bankRow, assets] = await Promise.all([
    db.getProject(id),
    db.getFixBriefsByProject(id),
    db.getEvidenceBankByProject(id),
    db.getGeneratedAssetsByProject(id),
  ]);

  if (!project) {
    return (
      <div>
        <h1>Generated assets</h1>
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
  const sortedBriefs = [...fixBriefs].sort(
    (a, b) => a.priority - b.priority || b.createdAt.localeCompare(a.createdAt)
  );

  const assetsByBrief = new Map<string, typeof assets>();
  for (const a of assets) {
    const list = assetsByBrief.get(a.fixBriefId) ?? [];
    list.push(a);
    assetsByBrief.set(a.fixBriefId, list);
  }
  const briefById = new Map(fixBriefs.map((f) => [f.id, f]));

  return (
    <div>
      <h1>Generated assets</h1>
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
        <Link href={`/projects/${id}/qa`}>QA</Link>
      </p>

      <div className="section">
        <strong>Project:</strong> {project.companyName ?? project.domain}
        <span className="badge">{project.domain}</span>
        <br />
        <strong>Project id:</strong> <code>{project.id}</code>
        <br />
        <strong>Fix Briefs:</strong> {fixBriefs.length}
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
        <br />
        <strong>Assets stored:</strong> {assets.length}
      </div>

      {!bank && (
        <p className="error">
          Prepare the Evidence Bank before generating assets.{" "}
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
      {fixBriefs.length === 0 && (
        <p className="error">
          Generate a Fix Brief before generating assets.{" "}
          <Link href={`/projects/${id}/fix-briefs`}>
            Open Fix Briefs →
          </Link>
        </p>
      )}

      <h2 style={{ marginTop: 24 }}>Fix Briefs</h2>
      {sortedBriefs.length === 0 ? (
        <p className="muted">No Fix Briefs yet.</p>
      ) : (
        sortedBriefs.map((brief) => (
          <FixBriefPanel
            key={brief.id}
            projectId={project.id}
            brief={{
              id: brief.id,
              lostPrompt: brief.lostPrompt,
              recommendedFix: brief.recommendedFix,
              status: brief.status,
              priority: brief.priority,
              fixType: brief.fixType,
              assetsToGenerate: brief.assetsToGenerate,
            }}
            canGenerate={bankUsable}
            existingAssetCount={(assetsByBrief.get(brief.id) ?? []).length}
          />
        ))
      )}

      <h2 style={{ marginTop: 24 }}>Saved Generated Assets</h2>
      {assets.length === 0 ? (
        <p className="muted">No generated assets yet.</p>
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
                <th style={cell}>Fix Brief</th>
                <th style={cell}>Placeholders</th>
                <th style={cell}>Claims used</th>
                <th style={cell}>QA status</th>
                <th style={cell}>Created</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const parent = briefById.get(a.fixBriefId);
                return (
                  <Fragment key={a.id}>
                    <tr
                      style={{
                        background:
                          a.qaStatus === "pending_qa" ? "#fbf9ef" : undefined,
                      }}
                    >
                      <td style={cell}>
                        <strong>{a.title}</strong>
                      </td>
                      <td style={cell}>
                        <code>{a.assetType}</code>
                      </td>
                      <td style={cell}>
                        {parent ? (
                          <span title={parent.lostPrompt}>
                            {parent.lostPrompt.slice(0, 60)}
                            {parent.lostPrompt.length > 60 ? "…" : ""}
                          </span>
                        ) : (
                          <span className="muted">unknown</span>
                        )}
                      </td>
                      <td style={cell}>{a.placeholders.length}</td>
                      <td style={cell}>{a.claimsUsed.length}</td>
                      <td style={cell}>
                        <strong
                          style={{
                            color:
                              a.qaStatus === "pending_qa"
                                ? "#664d03"
                                : a.qaStatus === "safe_to_publish"
                                  ? "#0f5132"
                                  : a.qaStatus === "unsupported_claims"
                                    ? "#721c24"
                                    : "#495057",
                          }}
                        >
                          {a.qaStatus}
                        </strong>
                      </td>
                      <td style={cell}>
                        <span className="muted">
                          {new Date(a.createdAt).toLocaleString()}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={7} style={{ ...cell, background: "#fafafa" }}>
                        <details>
                          <summary>
                            <strong>Content, placeholders & claims</strong>
                          </summary>
                          <div style={{ marginTop: 8 }}>
                            <p style={{ fontWeight: 600, margin: "0 0 4px" }}>
                              Content ({a.assetType})
                            </p>
                            <pre
                              style={{
                                background: "#f6f8fa",
                                padding: 8,
                                overflow: "auto",
                                maxHeight: 320,
                                fontSize: 11,
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {a.content}
                            </pre>
                            <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>
                              Placeholders ({a.placeholders.length})
                            </p>
                            {a.placeholders.length === 0 ? (
                              <p className="muted">
                                None — every fact is backed by evidence.
                              </p>
                            ) : (
                              <ul style={{ margin: "0 0 8px 20px" }}>
                                {a.placeholders.map((p, i) => (
                                  <li key={i}>
                                    <code>{p}</code>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>
                              Claims used ({a.claimsUsed.length})
                            </p>
                            {a.claimsUsed.length === 0 ? (
                              <p className="muted">
                                No claim traces recorded yet.
                              </p>
                            ) : (
                              <ul style={{ margin: "0 0 8px 20px" }}>
                                {a.claimsUsed.map((c, i) => (
                                  <li key={i}>
                                    {c.claim}{" "}
                                    <span className="muted">({c.source})</span>
                                  </li>
                                ))}
                              </ul>
                            )}
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
        Sprint 8 scope: assets are always saved with{" "}
        <code>qa_status = pending_qa</code>. QA, export, and publish come in
        later sprints — no buttons for those on purpose.
      </p>
    </div>
  );
}
