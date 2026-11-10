import type { Metadata } from "next";

import { briefAsText, buildTeamBrief } from "@/lib/workspace/brief";
import { loadWorkspace } from "@/lib/workspace/load";

import { CopyTextButton } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reports", robots: { index: false, follow: false } };

export default async function WorkspaceReportsPage() {
  const { state, account, view, drafts, actions } = await loadWorkspace();
  const brief = buildTeamBrief({ state, view, drafts, actions, now: new Date() });
  const text = briefAsText(brief);

  return (
    <WorkspaceShell active="reports" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Reports</h1>
      <p className="zw-lede">
        A team brief you can paste into an email, a document or a deck, built from what this workspace has stored. Every line names where it came from.
      </p>

      <section className="zw-card">
        <div className="zw-item-head" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{brief.title}</h2>
          <CopyTextButton text={text} label="Copy brief as text" />
        </div>
        <p className="zw-small">Prepared {brief.preparedAt.slice(0, 16).replace("T", " ")} UTC. It is rebuilt each time you open this page; nothing is sent anywhere.</p>
        <div className="zw-brief">
          {brief.sections.map((s) => (
            <div key={s.id}>
              <h3>{s.heading}</h3>
              <ul>
                {s.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="zw-card">
        <details className="zw-details">
          <summary>Plain text</summary>
          <pre className="zw-plain">{text}</pre>
        </details>
      </section>

      <section className="zw-card zw-later">
        <h2>Not available yet</h2>
        <p>PDF export, image export and read-only sharing links are not offered until their access controls are reviewed.</p>
      </section>
    </WorkspaceShell>
  );
}
