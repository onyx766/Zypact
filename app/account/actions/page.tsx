import type { Metadata } from "next";

import { ACTIONS_NOTE, ACTION_STATUS_LABELS, evidenceLine, findingTitle, suggestedInvestigations } from "@/lib/workspace/actions";
import { loadWorkspace } from "@/lib/workspace/load";
import { ACTION_STATUSES, type WorkspaceAction } from "@/lib/workspace/store";

import { ActionEditor, NewNoteActionForm, TrackFindingButton } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Actions", robots: { index: false, follow: false } };

function Evidence({ action }: { action: WorkspaceAction }) {
  const e = action.evidence;
  if (e.kind === "customer_note") return <dd>Your team&apos;s note: {e.note}</dd>;
  return (
    <dd>
      {evidenceLine(findingTitle(e.checkId), e.pageUrl, e.runCompletedAt)}
      {e.excerpt ? <div className="zw-excerpt">{e.excerpt}</div> : null}
    </dd>
  );
}

export default async function WorkspaceActionsPage() {
  const { state, account, view, actions } = await loadWorkspace();
  const suggestions = suggestedInvestigations(view, actions);
  const live = actions.filter((a) => a.status === "open" || a.status === "in_progress");
  const closed = actions.filter((a) => a.status === "done" || a.status === "dismissed");
  const statuses = ACTION_STATUSES.map((id) => ({ id, label: ACTION_STATUS_LABELS[id] }));

  const card = (a: WorkspaceAction) => (
    <div className="zw-item" key={a.id}>
      <div className="zw-item-head">
        <span className="zw-item-text">{a.title}</span>
        <span className={`zw-pill ${a.status === "done" ? "is-pass" : a.status === "dismissed" ? "is-muted" : "is-info"}`}>{ACTION_STATUS_LABELS[a.status]}</span>
      </div>
      <dl className="zw-dl">
        <dt>Observation</dt>
        <dd>{a.observation}</dd>
        {a.whyItMatters ? (
          <>
            <dt>Why it matters</dt>
            <dd>{a.whyItMatters}</dd>
          </>
        ) : null}
        <dt>Evidence</dt>
        <Evidence action={a} />
        <dt>Next step</dt>
        <dd>{a.nextStep}</dd>
        <dt>Owner</dt>
        <dd>{a.ownerName ?? "No owner yet"}</dd>
        {a.decisionNote ? (
          <>
            <dt>Decision</dt>
            <dd>{a.decisionNote}</dd>
          </>
        ) : null}
        <dt>Updated</dt>
        <dd>
          {a.updatedAt.slice(0, 16).replace("T", " ")} UTC · version {a.version}
        </dd>
      </dl>
      <div>
        <ActionEditor
          statuses={statuses}
          action={{
            id: a.id,
            version: a.version,
            status: a.status,
            title: a.title,
            observation: a.observation,
            whyItMatters: a.whyItMatters ?? "",
            nextStep: a.nextStep,
            ownerName: a.ownerName ?? "",
            decisionNote: a.decisionNote ?? "",
          }}
        />
      </div>
    </div>
  );

  return (
    <WorkspaceShell active="actions" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Actions</h1>
      <p className="zw-lede">Connect what was found with what your team decides: each action says what was observed, the evidence, the next step and who owns it.</p>
      <p className="zw-notice">{ACTIONS_NOTE}</p>

      <h2 className="zw-section-title">Open · {live.length}</h2>
      <section className="zw-card">{live.length === 0 ? <p>No open actions.</p> : live.map(card)}</section>

      <h2 className="zw-section-title">Suggested investigations · {suggestions.length}</h2>
      <section className="zw-card">
        {!view ? (
          <p>
            Suggestions come from your website diagnostic. <a href="/account/website">Run it</a> to see them.
          </p>
        ) : suggestions.length === 0 ? (
          <p>Every issue with a suggested fix in the latest diagnostic is already tracked, or there are none.</p>
        ) : (
          suggestions.map((s) => (
            <div className="zw-item" key={`${s.ref.checkId}${s.ref.pageUrl}`}>
              <div className="zw-item-head">
                <span className="zw-item-text">{s.fields.title}</span>
                <span className="zw-pill is-muted">{s.priority} priority</span>
              </div>
              <dl className="zw-dl">
                <dt>Observation</dt>
                <dd>{s.fields.observation}</dd>
                <dt>Why it matters</dt>
                <dd>{s.fields.whyItMatters}</dd>
                <dt>Evidence</dt>
                <dd>{s.evidenceLine}</dd>
                <dt>Next step</dt>
                <dd>{s.fields.nextStep}</dd>
              </dl>
              <div>
                <TrackFindingButton
                  evidence={s.ref}
                  fields={{ title: s.fields.title, observation: s.fields.observation, whyItMatters: s.fields.whyItMatters ?? "", nextStep: s.fields.nextStep, ownerName: "" }}
                />
              </div>
            </div>
          ))
        )}
      </section>

      <h2 className="zw-section-title">Record your own</h2>
      <section className="zw-card">
        <p>For something your team noticed outside Zypact — a sales call, a review, a page change. Say where the evidence comes from.</p>
        <NewNoteActionForm />
      </section>

      {closed.length > 0 ? (
        <section className="zw-card">
          <details className="zw-details">
            <summary>Closed · {closed.length}</summary>
            {closed.map(card)}
          </details>
        </section>
      ) : null}
    </WorkspaceShell>
  );
}
