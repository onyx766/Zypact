"use client";

import { FormEvent, useState } from "react";

import { STATE_LABELS } from "@/lib/site-diagnostic/copy";
import type { DiagnosticReport, ReportFinding } from "@/lib/site-diagnostic/report";

type Response =
  | { ok: true; report: DiagnosticReport; markdown: string }
  | { ok: false; error: string; message?: string };

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function FindingRow({ finding }: { finding: ReportFinding }) {
  return (
    <li className={`w1-finding is-${finding.state}`}>
      <div className="w1-finding-head">
        <span className={`w1-state is-${finding.state}`}>{STATE_LABELS[finding.state]}</span>
        <span className="w1-finding-title">{finding.title}</span>
        {finding.pageUrl ? <code className="w1-url">{finding.pageUrl}</code> : null}
      </div>
      {finding.unknownReason ? (
        <p className="w1-note">
          <code>{finding.unknownReason}</code> — {finding.unknownReasonText}
        </p>
      ) : null}
      {finding.excerpt ? (
        <p className="w1-excerpt">
          “{finding.excerpt.text}” <span className="w1-dim">bytes {finding.excerpt.start}–{finding.excerpt.end}</span>
        </p>
      ) : null}
      {finding.fix ? <p className="w1-fix">{finding.fix}</p> : null}
      <p className="w1-dim">Establishes: {finding.establishes}</p>
      <p className="w1-dim">Does not establish: {finding.doesNotEstablish}</p>
    </li>
  );
}

export function PreviewClient({ enabled }: { enabled: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Response | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/internal/site-diagnostics/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      setResult((await response.json()) as Response);
    } catch {
      setResult({ ok: false, error: "network_error", message: "The preview request did not complete." });
    } finally {
      setBusy(false);
    }
  }

  const report = result && result.ok ? result.report : null;

  return (
    <div className="w1-body">
      <form className="w1-form" onSubmit={submit}>
        <label htmlFor="w1-url" className="w1-label">
          Public website
        </label>
        <div className="w1-form-row">
          <input
            id="w1-url"
            name="url"
            className="w1-input"
            inputMode="url"
            autoComplete="off"
            maxLength={2048}
            placeholder="example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={!enabled || busy}
            required
          />
          <button type="submit" className="zpa-btn" disabled={!enabled || busy || url.trim() === ""}>
            {busy ? "Running…" : "Run diagnostic"}
          </button>
        </div>
        <p className="w1-dim">
          At most 10 pages plus robots.txt, sitemap.xml and llms.txt, respecting robots.txt. No model or paid
          call. Nothing is stored.
        </p>
        {!enabled ? <p className="w1-note">The preview is disabled on this deployment.</p> : null}
      </form>

      {result && !result.ok ? (
        <p className="w1-error" role="alert">
          {result.message ?? result.error}
        </p>
      ) : null}

      {report ? (
        <section className="w1-report" aria-live="polite">
          <div className="w1-notices">
            <p>{report.notices.scope}</p>
            {report.notices.ownership ? <p className="w1-ownership">{report.notices.ownership}</p> : null}
            <p className="w1-dim">{report.notices.noScore}</p>
            <p className="w1-dim">{report.notices.sampleLimit}</p>
          </div>

          <div className="w1-meta">
            <span>
              Outcome <code>{report.run.outcome}</code>
            </span>
            <span>
              Stopped <code>{report.run.stopReason}</code>
            </span>
            <span>{report.pages.length} pages · {report.run.requestCount} requests</span>
            <span>
              Rule set <code>{report.ruleSetVersion}</code>
            </span>
            <span className="w1-dim">sha256 {report.reportSha256.slice(0, 16)}…</span>
          </div>

          <div className="w1-actions">
            <button
              type="button"
              className="zpa-btn zpa-btn-sm"
              onClick={() => download(`w1-${report.input.normalizedDomain}.json`, JSON.stringify(report, null, 2), "application/json")}
            >
              Download JSON
            </button>
            <button
              type="button"
              className="zpa-btn zpa-btn-sm"
              onClick={() => result && result.ok && download(`w1-${report.input.normalizedDomain}.md`, result.markdown, "text/markdown")}
            >
              Download Markdown
            </button>
          </div>

          <h2 className="w1-h2">Fix list</h2>
          {report.fixList.length === 0 ? <p className="w1-dim">No fixes suggested by these checks.</p> : null}
          <ol className="w1-fixlist">
            {report.fixList.map((item, i) => (
              <li key={`${item.checkId}:${item.pageIndex}:${i}`}>
                <span className={`w1-state is-${item.kind === "issue" ? "issue" : "info"}`}>
                  {item.kind === "issue" ? "Issue" : "Suggestion"} · {item.priority}
                </span>{" "}
                <strong>{item.title}</strong>
                {item.pageUrl ? <code className="w1-url">{item.pageUrl}</code> : null}
                <p>{item.text}</p>
              </li>
            ))}
          </ol>

          {report.areas.map(({ area, label }) => {
            const inArea = report.findings.filter((f) => f.area === area);
            if (inArea.length === 0) return null;
            return (
              <div key={area}>
                <h2 className="w1-h2">{label}</h2>
                <ul className="w1-findings">
                  {inArea.map((finding, i) => (
                    <FindingRow key={`${finding.checkId}:${finding.pageIndex}:${i}`} finding={finding} />
                  ))}
                </ul>
              </div>
            );
          })}

          <h2 className="w1-h2">Pages fetched</h2>
          <table className="w1-table">
            <thead>
              <tr>
                <th>#</th>
                <th>URL</th>
                <th>Status</th>
                <th>Bytes</th>
                <th>sha256</th>
                <th>Not fetched / error</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.map((page) => (
                <tr key={page.pageIndex ?? page.url}>
                  <td>{page.pageIndex}</td>
                  <td>
                    <code>{page.url}</code>
                  </td>
                  <td>{page.httpStatus ?? "—"}</td>
                  <td>{page.bytes}</td>
                  <td>{page.bodySha256 ? <code>{page.bodySha256.slice(0, 12)}…</code> : "—"}</td>
                  <td>{page.fetchError ? <code>{page.fetchError}</code> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
