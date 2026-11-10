import type { Metadata } from "next";

import { STATE_LABELS } from "@/lib/site-diagnostic/copy";
import { loadWorkspace } from "@/lib/workspace/load";

import { RunDiagnosticButton, WebsiteForm } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Website", robots: { index: false, follow: false } };

export default async function WorkspaceWebsitePage() {
  const { state, account, view, deps } = await loadWorkspace();

  return (
    <WorkspaceShell active="website" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Website</h1>
      <p className="zw-lede">
        The website diagnostic reads up to 10 public pages of your site and reports each check on its own, with its evidence. It does not show how any AI
        system answers buyers.
      </p>

      {!state.website ? (
        <section className="zw-card">
          <h2>Add your website</h2>
          <p>Your workspace has one website. Changing it later is a support request, so check the address first.</p>
          <WebsiteForm defaultCompany={state.workspace.name} />
        </section>
      ) : (
        <section className="zw-card">
          <h2>{state.website.domain}</h2>
          <p className="zw-small">Domain ownership: {state.website.verification === "verified" ? "verified" : "not verified"}.</p>
          {deps.config.diagnosticEnabled ? (
            <RunDiagnosticButton label={view ? "Run the diagnostic again" : "Run the website diagnostic"} />
          ) : (
            <p>The website diagnostic isn&apos;t available yet.</p>
          )}
        </section>
      )}

      {view ? (
        <>
          <section className="zw-card">
            <h2>Latest result — {view.completedAt.slice(0, 16).replace("T", " ")} UTC</h2>
            <p>{view.outcomeText}</p>
            <div className="zw-counts">
              <span className="zw-pill is-issue">{view.counts.issue} issue</span>
              <span className="zw-pill is-pass">{view.counts.pass} pass</span>
              <span className="zw-pill is-info">{view.counts.info} info</span>
              <span className="zw-pill is-unknown">{view.counts.unknown} unknown</span>
            </div>
            <p className="zw-small">
              {view.pagesFetched} of at most {view.pageCap} pages read · rules {view.ruleSetVersion}
            </p>
            {view.notices.map((n) => (
              <p key={n} className="zw-notice">
                {n}
              </p>
            ))}
            {view.unknownChecks > 0 ? <p className="zw-notice">{view.unknownChecks} result(s) come from checks this version cannot describe; they are kept, not dropped.</p> : null}
          </section>

          {view.fixList.length > 0 ? (
            <section className="zw-card">
              <h2>Suggested fixes</h2>
              <p>Ordered by priority. Track any of them as an action on the Actions page.</p>
              {view.fixList.map((f) => (
                <div className="zw-finding" key={`${f.checkId}${f.pageUrl}`}>
                  <div className="zw-finding-head">
                    <span className="zw-finding-title">{f.title}</span>
                    <span className="zw-pill is-muted">{f.priority}</span>
                  </div>
                  <p>{f.fix}</p>
                  {f.pageUrl ? <div className="zw-url">{f.pageUrl}</div> : null}
                </div>
              ))}
            </section>
          ) : null}

          {view.areas.map((area) => (
            <section className="zw-card" key={area.area}>
              <details className="zw-details">
                <summary>
                  {area.label} · {area.findings.length} result{area.findings.length === 1 ? "" : "s"}
                </summary>
                {area.findings.map((f, i) => (
                  <div className="zw-finding" key={`${f.checkId}${f.pageUrl}${i}`}>
                    <div className="zw-finding-head">
                      <span className="zw-finding-title">{f.title}</span>
                      <span className={`zw-pill is-${f.state}`}>{STATE_LABELS[f.state]}</span>
                    </div>
                    {f.excerpt ? <div className="zw-excerpt">{f.excerpt}</div> : null}
                    {f.unknownReasonText ? <p className="zw-small">{f.unknownReasonText}</p> : null}
                    <p className="zw-small">Shows: {f.establishes}</p>
                    <p className="zw-small">Does not show: {f.doesNotEstablish}</p>
                    {f.pageUrl ? <div className="zw-url">{f.pageUrl}</div> : null}
                  </div>
                ))}
              </details>
            </section>
          ))}

          {view.history.length > 1 ? (
            <section className="zw-card">
              <h2>Earlier runs</h2>
              <ul className="zw-small">
                {view.history.map((h) => (
                  <li key={h.id}>
                    {h.completedAt.slice(0, 16).replace("T", " ")} UTC — {h.outcome}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </WorkspaceShell>
  );
}
