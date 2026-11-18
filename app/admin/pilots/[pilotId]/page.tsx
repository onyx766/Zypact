import Link from "next/link";
import { notFound } from "next/navigation";

import { requireFounderForPage } from "@/lib/auth/founder";
import { revisionActionsCurrent, STALE_REVISION_WORDS } from "@/lib/pilots/action-rules";
import { currentReportableVersionIds, listPilotActionsForAdmin } from "@/lib/pilots/action-store";
import {
  ENGINE_NOT_MEASURED,
  PILOT_ENGINES,
  PILOT_QUESTION_RETIRED_LABEL,
  pilotJobStatusLabel,
  pilotProvenanceLabel,
} from "@/lib/pilots/copy";
import { loadPilot, pilotIsOver, pilotNotStarted } from "@/lib/pilots/reads";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";
import {
  INTEGRITY_WORDS,
  OLDER_SHARED_REVISION_WORDS,
  REPLACED_REVISION_WORDS,
  SHARING_ENDS_EARLIER_LINK_WORDS,
} from "@/lib/reports/pilot-report-copy";
import { listPilotReportRevisions } from "@/lib/reports/process-pilot-report";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { publicSiteUrl } from "@/lib/seo/site";
import { AdminShell } from "../../admin-shell";
import {
  AddQuestionPanel,
  BuildPilotReportButton,
  ClosePilotButton,
  QuestionControls,
  RetireQuestionButton,
} from "../pilot-forms";
import { PilotActionsPanel } from "../pilot-action-forms";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * D-054 — one pilot: its questions, who supplied each and the customer's
 * written approval, and each question's Perplexity measurement with its
 * own Run. ChatGPT is shown as not measured, never as zero (D-053).
 */
export default async function PilotAdminPage({ params }: { params: Promise<{ pilotId: string }> }) {
  const { pilotId } = await params;
  const user = await requireFounderForPage(`/admin/pilots/${pilotId}`);
  if (!UUID_PATTERN.test(pilotId)) notFound();

  const client = getReportServiceClient();
  const loaded = await loadPilot(client, pilotId);
  if (!loaded) notFound();
  const { pilot, questions } = loaded;
  // D-055 — the combined report's revisions, newest first.
  const revisions = await listPilotReportRevisions(client, pilot.id);
  // D-057 — the team's suggested actions, and the questions whose answers they may link to.
  const actions = await listPilotActionsForAdmin(client, pilot.id);
  // D-057 — a revision whose listed actions are no longer the reviewed, current ones cannot be shared.
  const currentActionVersions = await currentReportableVersionIds(client, pilot.id);
  const isStale = (r: { actionVersionIds: string[]; sharedAt: string | null }) =>
    r.sharedAt === null && !revisionActionsCurrent(r.actionVersionIds, currentActionVersions);
  const actionQuestions = questions
    .filter((q) => q.retiredAt === null && q.perplexity !== null)
    .map((q) => ({ pilotQuestionId: q.id, ordinal: q.ordinal, text: q.questionText }));
  const siteUrl = publicSiteUrl();
  const today = todayUtc();
  const over = pilotIsOver(pilot.status, pilot.endsOn, today);
  const notStarted = pilotNotStarted(pilot.startsOn, today);
  // D-054 — a retired question no longer counts toward the limit.
  const liveCount = questions.filter((q) => q.retiredAt === null).length;
  const retiredCount = questions.length - liveCount;
  const full = liveCount >= pilot.questionLimit;
  const chatgpt = PILOT_ENGINES.find((e) => e.key === "openai_chatgpt")!;

  return (
    <AdminShell
      email={user.email}
      active="pilots"
      health={
        over
          ? { ok: false, title: pilot.status === "closed" ? "Pilot closed" : "Past end date", note: "Its questions are no longer measured." }
          : notStarted
            ? { ok: true, title: "Not started", note: `Questions can be run from ${pilot.startsOn}.` }
            : { ok: true, title: "Pilot open", note: `Ends ${pilot.endsOn}.` }
      }
    >
      <div className="zpa-page-head">
        <div>
          <p className="zpa-eyebrow">
            <Link href="/admin/pilots">Pilots</Link>
          </p>
          <h1 className="zpa-title">{pilot.companyName}</h1>
          <p className="zpa-subtitle">
            {pilot.websiteUrl} · {pilot.startsOn} to {pilot.endsOn} · {liveCount} of {pilot.questionLimit} questions
            {retiredCount > 0 ? ` · ${retiredCount} retired` : ""}
            {pilot.status === "closed" ? " · Closed" : ""}
          </p>
        </div>
        {pilot.status === "active" ? <ClosePilotButton pilotId={pilot.id} /> : null}
      </div>

      <div className="zpa-card">
        <p className="zpa-muted">
          <strong>Website control:</strong> {pilot.siteControlNote}
        </p>
        {pilot.closeReason ? (
          <p className="zpa-muted">
            <strong>Closed:</strong> {pilot.closeReason}
          </p>
        ) : null}
      </div>

      <div className="zpa-toolbar">
        <AddQuestionPanel pilotId={pilot.id} disabled={over || full} />
        {full && !over ? <p className="zpa-muted">This pilot has reached its question limit.</p> : null}
      </div>

      {questions.length === 0 ? (
        <div className="zpa-empty">
          <p className="zpa-empty-title">No questions yet.</p>
          <p className="zpa-muted">Add each question the customer approved in writing.</p>
        </div>
      ) : (
        <div className="zpa-card zpa-table-scroll">
          <table className="zpa-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Buyer question</th>
                <th>Customer approval</th>
                <th>Perplexity</th>
                <th>{chatgpt.label}</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => {
                const m = q.perplexity;
                return (
                  <tr key={q.id}>
                    <td>{q.ordinal}</td>
                    <td>
                      <p className="zpa-question">{q.questionText}</p>
                      <p className="zpa-muted">{pilotProvenanceLabel(q.questionProvenance)}.</p>
                      {q.retiredAt ? (
                        <p className="zpa-muted">
                          <strong>{PILOT_QUESTION_RETIRED_LABEL}:</strong> {q.retireReason}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <p>{q.customerApprovalRef}</p>
                      <p className="zpa-muted">{q.customerApprovedOn}</p>
                    </td>
                    <td>
                      {m ? (
                        <>
                          <p>{pilotJobStatusLabel(m.jobStatus, m.stale)}</p>
                          <p className="zpa-muted">
                            {m.completedRuns} of {m.plannedRuns ?? "?"} runs completed
                            {m.failedRuns > 0 ? `, ${m.failedRuns} failed` : ""}
                          </p>
                          <QuestionControls
                            pilotId={pilot.id}
                            pilotQuestionId={q.id}
                            jobStatus={m.jobStatus}
                            stale={m.stale}
                            plannedRuns={m.plannedRuns}
                            runCap={m.runCap}
                            spendCapUsd={m.spendCapUsd}
                            pilotOpen={!over && !notStarted && q.retiredAt === null}
                          />
                          {!over && q.retiredAt === null
                            && (m.jobStatus === "failed" || m.jobStatus === "abandoned_exhausted") ? (
                            <RetireQuestionButton pilotId={pilot.id} pilotQuestionId={q.id} />
                          ) : null}
                        </>
                      ) : (
                        <p>No measurement</p>
                      )}
                    </td>
                    <td>
                      <p className="zpa-muted">{ENGINE_NOT_MEASURED}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="zpa-card">
        <h2 className="zpa-title">Suggested actions</h2>
        <p className="zpa-muted">
          Written by the team from the stored answers, each linked to the answers and sources it rests on. A saved action is
          a draft; only actions you have reviewed appear in the next report built, and any edit needs a new review. Any
          action in a report holds it for your review before sharing.
        </p>
        <PilotActionsPanel
          pilotId={pilot.id}
          questions={actionQuestions}
          actions={actions.map((a) => ({
            actionId: a.actionId,
            status: a.status,
            versionNumber: a.versionNumber,
            title: a.title,
            observation: a.observation,
            suggestedAction: a.suggestedAction,
            whyItMightMatter: a.whyItMightMatter,
            alternativeExplanations: a.alternativeExplanations,
            openQuestions: a.openQuestions,
            withdrawReason: a.withdrawReason,
            evidence: a.evidence.map((e) => ({
              attemptId: e.attemptId,
              sourceUrl: e.sourceUrl,
              words: e.words,
              answerText: e.answerText,
              answerNote: e.answerNote,
            })),
          }))}
        />
      </div>

      <div className="zpa-card">
        <div className="zpa-page-head">
          <div>
            <h2 className="zpa-title">Pilot report</h2>
            <p className="zpa-muted">
              One report for all of this pilot&apos;s questions, built from the stored answers. Building spends nothing and
              shares nothing, and is refused while a measurement is still running. Open a revision to read it exactly as the
              customer will; the newest one can be shared from there. The customer receives only the private link you send
              them. {SHARING_ENDS_EARLIER_LINK_WORDS}
            </p>
          </div>
          {questions.length > 0 ? <BuildPilotReportButton pilotId={pilot.id} /> : null}
        </div>
        {revisions.length === 0 ? (
          <p className="zpa-muted">No report built yet.</p>
        ) : (
          <table className="zpa-table">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Built</th>
                <th>Checks</th>
                <th>Read and share</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id}>
                  <td>{r.revision}</td>
                  <td>{r.generatedAt.slice(0, 16).replace("T", " ")} UTC</td>
                  <td>
                    <p>{INTEGRITY_WORDS[r.integrityStatus]}</p>
                    {r.integrityReasons.length > 0 ? (
                      <ul className="zpa-muted">
                        {r.integrityReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td>
                    <p>
                      <Link href={`/admin/pilots/${pilot.id}/report/${r.id}`}>Read revision {r.revision}</Link>
                    </p>
                    {r.publicToken ? (
                      <p>
                        <a href={`/pilot-report/${r.publicToken}`} target="_blank" rel="noopener noreferrer">
                          {`${siteUrl}/pilot-report/${r.publicToken}`}
                        </a>
                        <br />
                        <span className="zpa-muted">Shared {r.sharedAt?.slice(0, 10)}</span>
                        {r.olderThanListed ? (
                          // D-060 — the only link that opens, read beside the newest revisions because none of them is shared.
                          <>
                            <br />
                            <span className="zpa-muted">{OLDER_SHARED_REVISION_WORDS}</span>
                          </>
                        ) : null}
                      </p>
                    ) : r.replaced ? (
                      // D-060 — a later revision was shared, so this link no longer opens; no link is shown.
                      <span className="zpa-muted">
                        Shared {r.sharedAt?.slice(0, 10)}. {REPLACED_REVISION_WORDS}.
                      </span>
                    ) : (
                      <span className="zpa-muted">
                        {r.integrityStatus === "blocked"
                          ? "Cannot be shared"
                          : r.id === revisions[0]?.id
                            ? isStale(r)
                              ? STALE_REVISION_WORDS
                              : "Not shared: read it to share it"
                            : "Not shared (a newer revision exists)"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminShell>
  );
}
