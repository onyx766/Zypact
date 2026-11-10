import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  ENGINE_LABELS,
  MEASUREMENT_TYPE_HINTS,
  MEASUREMENT_TYPE_LABELS,
  PAID_MEASUREMENT_OFF_NOTE,
  PLAN_CATALOG,
  USAGE_NOTES,
} from "@/lib/plans/catalog";
import { loadWorkspace } from "@/lib/workspace/load";

import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plan & usage", robots: { index: false, follow: false } };

const day = (iso: string) => iso.slice(0, 10);

export default async function WorkspacePlanPage() {
  const { state, account, deps, token } = await loadWorkspace();
  const usage = await deps.store.getUsage(token, account.accountId);
  if (!("plan" in usage)) redirect("/account/sign-in");
  const def = PLAN_CATALOG[usage.plan];
  const lines = usage.types.filter((t) => t.allowance > 0);
  const liveDrafts = (await deps.store.listDrafts(token, account.accountId));
  const draftCount = Array.isArray(liveDrafts) ? liveDrafts.filter((d) => d.status === "draft").length : 0;

  return (
    <WorkspaceShell active="plan" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Plan &amp; usage</h1>
      <p className="zw-lede">What your plan includes and how much of it has been used. Usage counts successful measurement runs only.</p>

      <section className="zw-card">
        <div className="zw-item-head">
          <h2 style={{ margin: 0 }}>{def.name} plan</h2>
          <span className="zw-pill is-muted">{def.priceMonthlyUsd === 0 ? "$0" : `$${def.priceMonthlyUsd} / month`}</span>
        </div>
        <dl className="zw-dl" style={{ marginTop: 12 }}>
          <dt>Active buyer questions</dt>
          <dd>Up to {usage.activeQuestionLimit}</dd>
          <dt>AI engines</dt>
          <dd>{usage.engines.map((e) => ENGINE_LABELS[e]).join(" and ")}</dd>
          {def.lifetime ? null : (
            <>
              <dt>Billing month</dt>
              <dd>
                {day(usage.periodStart)} to {day(usage.periodEnd)}
              </dd>
            </>
          )}
          <dt>Draft questions</dt>
          <dd>{draftCount} — drafts never use your allowance</dd>
        </dl>
      </section>

      {!usage.paidMeasurementOn ? <p className="zw-notice">{PAID_MEASUREMENT_OFF_NOTE}</p> : null}

      <section className="zw-card">
        <h2>Measurement allowance</h2>
        {lines.map((t) => {
          const used = t.consumed + t.held;
          return (
            <div className="zw-item" key={t.type}>
              <div className="zw-item-head">
                <span className="zw-item-text">{MEASUREMENT_TYPE_LABELS[t.type]}</span>
                <span className="zw-small">
                  {t.consumed} used{t.held > 0 ? `, ${t.held} in progress` : ""} of {t.allowance}
                  {t.lifetime ? " (one-time)" : " this month"}
                </span>
              </div>
              <div className="zw-meter" role="meter" aria-valuemin={0} aria-valuemax={t.allowance} aria-valuenow={used} aria-label={MEASUREMENT_TYPE_LABELS[t.type]}>
                <span style={{ width: `${Math.min(100, Math.round((used / t.allowance) * 100))}%` }} />
              </div>
              <p className="zw-small">{MEASUREMENT_TYPE_HINTS[t.type]}</p>
              {t.released > 0 ? <p className="zw-small">{t.released} failed or excluded run{t.released === 1 ? " was" : "s were"} released and not counted.</p> : null}
            </div>
          );
        })}
      </section>

      <section className="zw-card">
        <h2>How usage works</h2>
        <ul className="zw-small" style={{ paddingLeft: 18, margin: 0 }}>
          {USAGE_NOTES.map((n) => (
            <li key={n} style={{ margin: "4px 0" }}>
              {n}
            </li>
          ))}
        </ul>
      </section>

      {usage.plan === "free" ? (
        <section className="zw-card">
          <h2>Starter</h2>
          <p>
            Up to {PLAN_CATALOG.starter.activeQuestions} active questions on {PLAN_CATALOG.starter.engines.map((e) => ENGINE_LABELS[e]).join(" and ")}, monitoring,
            deep baselines and retests, for ${PLAN_CATALOG.starter.priceMonthlyUsd} a month. Online upgrade is not available yet.
          </p>
        </section>
      ) : null}
    </WorkspaceShell>
  );
}
