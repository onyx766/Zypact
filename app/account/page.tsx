import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";
import { loadWorkspace } from "@/lib/workspace/load";
import { attentionItems, compareDiagnostics, reviewNext } from "@/lib/workspace/overview";
import { setupSteps } from "@/lib/workspace/view";

import { WorkspaceShell } from "./workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview", robots: { index: false, follow: false } };

export default async function WorkspaceOverviewPage() {
  if (!readAccountsConfig().enabled) notFound();
  const data = await loadWorkspace({ previous: true });
  const { state, account, view, drafts, actions } = data;
  const steps = setupSteps(state);
  const setupDone = steps.every((s) => s.done);
  const change = compareDiagnostics(data.diagnostic, data.previousDiagnostic);
  const attention = attentionItems(view);
  const next = reviewNext(state, drafts, actions);
  const live = actions.filter((a) => a.status === "open" || a.status === "in_progress");

  return (
    <WorkspaceShell active="overview" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Overview</h1>
      <p className="zw-lede">What changed, what deserves attention, and what to review next — from what your workspace has stored. Details are one click away in each section.</p>

      {!setupDone ? (
        <section className="zw-card">
          <h2>Set up your workspace</h2>
          <ol className="zw-steps">
            {steps.map((s) => (
              <li key={s.id}>
                <span className={`zw-dot${s.done ? " is-done" : ""}`} aria-hidden>
                  {s.done ? "✓" : ""}
                </span>
                {s.done ? <span>{s.label}</span> : <a href={s.href}>{s.label}</a>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="zw-grid3">
        <section className="zw-card">
          <h2>What changed?</h2>
          {change.kind === "none" ? <p>Nothing yet: run the website diagnostic to start.</p> : null}
          {change.kind === "first" ? <p>Your first website diagnostic ran on {change.completedAt.slice(0, 10)}. Changes show here after the next one.</p> : null}
          {change.kind === "not_comparable" ? <p>{change.reason}</p> : null}
          {change.kind === "compared" ? (
            <>
              <p className="zw-small">
                Website diagnostic of {change.completedAt.slice(0, 10)} compared with {change.previousAt.slice(0, 10)}.
              </p>
              {change.newIssues.length === 0 && change.resolved.length === 0 ? <p>No check changed between issue and pass.</p> : null}
              <ul>
                {change.newIssues.slice(0, 4).map((c) => (
                  <li key={`n${c.checkId}${c.pageUrl}`}>
                    <span className="zw-pill is-issue">New issue</span> {c.title}
                  </li>
                ))}
                {change.resolved.slice(0, 4).map((c) => (
                  <li key={`r${c.checkId}${c.pageUrl}`}>
                    <span className="zw-pill is-pass">Now passing</span> {c.title}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="zw-small">AI answers have not been measured for this workspace, so no change in them is reported.</p>
        </section>

        <section className="zw-card">
          <h2>What deserves attention?</h2>
          {attention.length === 0 ? <p>{view ? "The latest diagnostic recorded no issue with a suggested fix." : "Nothing yet."}</p> : null}
          <ul>
            {attention.map((f) => (
              <li key={`${f.checkId}${f.pageUrl}`}>
                <a href="/account/actions">{f.title}</a> <span className="zw-small">({f.priority} priority)</span>
              </li>
            ))}
          </ul>
          {live.length > 0 ? <p className="zw-small">{live.length} open action{live.length === 1 ? "" : "s"} in your log.</p> : null}
        </section>

        <section className="zw-card">
          <h2>What to review next?</h2>
          <ul>
            {next.slice(0, 5).map((n) => (
              <li key={n.label}>
                <a href={n.href}>{n.label}</a>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="zw-card">
        <h2>What this workspace measures today</h2>
        <p>
          Your website&apos;s public pages, through the website diagnostic. Buyer questions are kept as drafts for now. Measuring AI answers to approved
          questions, and the source and competitor views that come from them, will open in a later release.
        </p>
      </section>
    </WorkspaceShell>
  );
}
