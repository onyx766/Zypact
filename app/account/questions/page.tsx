import type { Metadata } from "next";

import { ACTIVE_NOTE, APPROVAL_CONSENT_TEXT, APPROVAL_CONSENT_VERSION, ARCHIVE_NOTE, draftActivation } from "@/lib/workspace/activation";
import { loadWorkspace } from "@/lib/workspace/load";
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  DRAFT_STATUS_NOTE,
  LIVE_DRAFT_LIMIT,
  ORIGIN_LABELS,
  SUGGESTION_DISCLAIMER,
  SUGGESTION_LABEL,
  draftOverlaps,
  overlapWithDrafts,
  suggestQuestions,
} from "@/lib/workspace/questions";
import { DRAFT_CATEGORIES } from "@/lib/workspace/store";

import { AddDraftForm, AddSuggestionButton, ApproveDraftButton, ArchiveActiveButton, DraftEditor } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Questions", robots: { index: false, follow: false } };

export default async function WorkspaceQuestionsPage() {
  const { state, account, drafts, deps, token } = await loadWorkspace();
  const activeResult = await deps.store.listActive(token, account.accountId);
  const active = "questions" in activeResult ? activeResult : null;
  const activeQuestions = active?.questions.filter((q) => q.active) ?? [];
  const archivedQuestions = active?.questions.filter((q) => !q.active) ?? [];
  const profile = state.profile;
  const live = drafts.filter((d) => d.status === "draft");
  const archived = drafts.filter((d) => d.status === "archived");
  const overlaps = draftOverlaps(drafts, profile);
  const suggestions = suggestQuestions(profile, drafts);
  const categories = DRAFT_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] }));

  return (
    <WorkspaceShell active="questions" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Questions</h1>
      <p className="zw-lede">The buyer questions you want to understand, kept as drafts while you review them. A few relevant questions are worth more than many generic ones.</p>
      <p className="zw-notice">{DRAFT_STATUS_NOTE}</p>

      <h2 className="zw-section-title">
        Active questions · {active ? `${active.activeCount} of ${active.limit}` : "—"}
      </h2>
      <section className="zw-card">
        <p className="zw-small">{ACTIVE_NOTE}</p>
        {activeQuestions.length === 0 ? <p>No active questions yet. Approve a draft below to make it active.</p> : null}
        {activeQuestions.map((q) => {
          const latest = q.versions[q.versions.length - 1];
          return (
            <div className="zw-item" key={q.buyerQuestionId}>
              <div className="zw-item-head">
                <span className="zw-item-text">{latest?.text}</span>
                <ArchiveActiveButton buyerQuestionId={q.buyerQuestionId} />
              </div>
              <div className="zw-tags">
                <span className="zw-pill is-pass">Active</span>
                <span className="zw-small">
                  version {latest?.number}
                  {latest?.approvedAt ? `, approved ${latest.approvedAt.slice(0, 10)}` : ""} · not measured yet
                </span>
              </div>
              {q.versions.length > 1 ? (
                <details className="zw-details">
                  <summary className="zw-small">Previous versions · {q.versions.length - 1}</summary>
                  {q.versions.slice(0, -1).map((v) => (
                    <p className="zw-small" key={v.id}>
                      Version {v.number}
                      {v.approvedAt ? ` (approved ${v.approvedAt.slice(0, 10)})` : ""}: {v.text}
                    </p>
                  ))}
                </details>
              ) : null}
            </div>
          );
        })}
        {active && active.activeCount >= active.limit ? (
          <p className="zw-notice">
            Your plan&apos;s limit of {active.limit} active question{active.limit === 1 ? "" : "s"} is reached. <a href="/account/plan">See your plan</a>.
          </p>
        ) : null}
      </section>

      <section className="zw-card">
        <h2>Add your own question</h2>
        <AddDraftForm categories={categories} />
        <p className="zw-small" style={{ marginTop: 10 }}>
          {live.length} of {LIVE_DRAFT_LIMIT} drafts in use. Archived drafts do not count.
        </p>
      </section>

      <h2 className="zw-section-title">Your drafts</h2>
      {live.length === 0 ? (
        <section className="zw-card">
          <p>No drafts yet. Write your own above, or start from a suggestion below.</p>
        </section>
      ) : (
        DRAFT_CATEGORIES.filter((c) => live.some((d) => d.category === c)).map((c) => (
          <section className="zw-card" key={c}>
            <h2>{CATEGORY_LABELS[c]}</h2>
            <p className="zw-small">{CATEGORY_HINTS[c]}</p>
            {live
              .filter((d) => d.category === c)
              .map((d) => {
                const warnings = overlaps.get(d.id) ?? [];
                const act = draftActivation(d, active);
                return (
                  <div className="zw-item" key={d.id}>
                    <div className="zw-item-head">
                      <span className="zw-item-text">{d.text}</span>
                      <span className="zw-inline">
                        <DraftEditor draft={d} categories={categories} />
                        {act.kind === "not_approved" || act.kind === "active_changed" || act.kind === "archived" ? (
                          <ApproveDraftButton
                            draftId={d.id}
                            expectedVersion={d.version}
                            label={act.kind === "not_approved" ? "Approve" : act.kind === "archived" ? "Approve and reactivate" : `Approve as version ${act.version + 1}`}
                            consentText={APPROVAL_CONSENT_TEXT}
                            consentVersion={APPROVAL_CONSENT_VERSION}
                          />
                        ) : null}
                      </span>
                    </div>
                    <div className="zw-tags">
                      {act.kind === "active_current" ? (
                        <span className="zw-pill is-pass">Active · version {act.version}</span>
                      ) : act.kind === "active_changed" ? (
                        <span className="zw-pill is-issue">Changed since version {act.version} was approved</span>
                      ) : act.kind === "archived" ? (
                        <span className="zw-pill is-muted">Question archived</span>
                      ) : (
                        <span className="zw-pill is-muted">Draft</span>
                      )}
                      <span className="zw-pill is-muted">{ORIGIN_LABELS[d.origin]}</span>
                      {d.version > 1 ? <span className="zw-small">version {d.version}</span> : null}
                    </div>
                    {warnings.map((w) => (
                      <div className="zw-warn" key={w.otherId}>
                        {w.kind === "same" ? "Asks the same thing as" : "Very similar to"}: “{w.otherText}”. Consider keeping only one.
                      </div>
                    ))}
                  </div>
                );
              })}
          </section>
        ))
      )}

      <h2 className="zw-section-title">Suggestions</h2>
      <section className="zw-card">
        <p className="zw-notice">{SUGGESTION_DISCLAIMER}</p>
        {!profile ? (
          <p>
            Suggestions are built from your Brand Profile. <a href="/account/profile">Review your Brand Profile</a> to see them.
          </p>
        ) : suggestions.length === 0 ? (
          <p>No further suggestions: add a category, audience or competitors to your Brand Profile, or write your own questions.</p>
        ) : (
          suggestions.map((s) => {
            const warnings = overlapWithDrafts(s.text, drafts, profile);
            return (
              <div className="zw-item" key={s.text}>
                <div className="zw-item-head">
                  <span className="zw-item-text">{s.text}</span>
                  <AddSuggestionButton text={s.text} category={s.category} rule={s.rule} />
                </div>
                <div className="zw-tags">
                  <span className="zw-pill is-info">{SUGGESTION_LABEL}</span>
                  <span className="zw-pill is-muted">{CATEGORY_LABELS[s.category]}</span>
                </div>
                {warnings.map((w) => (
                  <div className="zw-warn" key={w.otherId}>
                    Similar to your draft “{w.otherText}”.
                  </div>
                ))}
              </div>
            );
          })
        )}
      </section>

      {archivedQuestions.length > 0 ? (
        <section className="zw-card">
          <details className="zw-details">
            <summary>Archived questions · {archivedQuestions.length}</summary>
            <p className="zw-small">{ARCHIVE_NOTE}</p>
            {archivedQuestions.map((q) => (
              <div className="zw-item" key={q.buyerQuestionId}>
                {q.versions.map((v) => (
                  <p className="zw-small" key={v.id}>
                    Version {v.number}
                    {v.approvedAt ? ` (approved ${v.approvedAt.slice(0, 10)})` : ""}: {v.text}
                  </p>
                ))}
              </div>
            ))}
          </details>
        </section>
      ) : null}

      {archived.length > 0 ? (
        <section className="zw-card">
          <details className="zw-details">
            <summary>Archived drafts · {archived.length}</summary>
            {archived.map((d) => (
              <div className="zw-item" key={d.id}>
                <div className="zw-item-head">
                  <span className="zw-small">{d.text}</span>
                  <DraftEditor draft={d} categories={categories} />
                </div>
              </div>
            ))}
          </details>
        </section>
      ) : null}
    </WorkspaceShell>
  );
}
