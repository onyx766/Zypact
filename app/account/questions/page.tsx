import type { Metadata } from "next";

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

import { AddDraftForm, AddSuggestionButton, DraftEditor } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Questions", robots: { index: false, follow: false } };

export default async function WorkspaceQuestionsPage() {
  const { state, account, drafts } = await loadWorkspace();
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
                return (
                  <div className="zw-item" key={d.id}>
                    <div className="zw-item-head">
                      <span className="zw-item-text">{d.text}</span>
                      <DraftEditor draft={d} categories={categories} />
                    </div>
                    <div className="zw-tags">
                      <span className="zw-pill is-muted">Draft</span>
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
