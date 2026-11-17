import Link from "next/link";
import { notFound } from "next/navigation";

import { requireFounderForPage } from "@/lib/auth/founder";
import {
  ENGINE_NOT_MEASURED,
  PILOT_ENGINES,
  PILOT_QUESTION_RETIRED_LABEL,
  pilotJobStatusLabel,
  pilotProvenanceLabel,
} from "@/lib/pilots/copy";
import { loadPilot, pilotIsOver, pilotNotStarted } from "@/lib/pilots/reads";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { AdminShell } from "../../admin-shell";
import { AddQuestionPanel, ClosePilotButton, QuestionControls, RetireQuestionButton } from "../pilot-forms";

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

  const loaded = await loadPilot(getReportServiceClient(), pilotId);
  if (!loaded) notFound();
  const { pilot, questions } = loaded;
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
    </AdminShell>
  );
}
