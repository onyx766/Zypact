import Link from "next/link";
import { notFound } from "next/navigation";

import { requireFounderForPage } from "@/lib/auth/founder";
import { revisionActionsCurrent, STALE_REVISION_WORDS } from "@/lib/pilots/action-rules";
import { currentReportableVersionIds, listPilotActionsForAdmin } from "@/lib/pilots/action-store";
import {
  ENGINE_NOT_CONNECTED,
  PILOT_QUESTION_RETIRED_LABEL,
  pilotEngines,
  pilotProvenanceLabel,
} from "@/lib/pilots/copy";
import { pilotChatGptEnabled, pilotRetestEnabled } from "@/lib/pilots/engines";
import { cardsNotSharedWarning, preparedNotRunWarning, RETEST_OUT_OF_DATE_WORDS } from "@/lib/pilots/retest-copy";
import { MAX_RETEST_QUESTIONS, RETEST_TEXT_LABELS } from "@/lib/pilots/retest-rules";
import { cardsNotYetShared, currentRetestState, loadPilotRetests, revisionRetestsCurrent } from "@/lib/pilots/retest-store";
import { loadPilot, pilotIsOver, pilotNotStarted, type PilotMeasurement, type PilotQuestionRow } from "@/lib/pilots/reads";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";
import {
  INTEGRITY_WORDS,
  OLDER_SHARED_REVISION_WORDS,
  REPLACED_REVISION_WORDS,
  SHARING_ENDS_EARLIER_LINK_WORDS,
} from "@/lib/reports/pilot-report-copy";
import { listPilotReportRevisions } from "@/lib/reports/process-pilot-report";
import { abandonedGroupWords, ACTION_TYPE_WORDS, noteWords } from "@/lib/reports/pilot-retest-copy";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { publicSiteUrl } from "@/lib/seo/site";
import { AdminShell } from "../../admin-shell";
import {
  AddChatGptToAllButton,
  AddQuestionPanel,
  BuildPilotReportButton,
  ClosePilotButton,
  RetireQuestionButton,
} from "../pilot-forms";
import { PilotActionsPanel } from "../pilot-action-forms";
import { PilotEngineCell } from "../pilot-engine-cell";
import { RetestGroupPanel, RetestRegisterPanel, type RetestGroupView } from "../pilot-retest-forms";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** D-061 — a measurement that stopped: failed, or abandoned after too many worker stops. */
function stopped(m: PilotMeasurement | null): boolean {
  return m !== null && (m.jobStatus === "failed" || m.jobStatus === "abandoned_exhausted");
}

/** D-061 — whether a question is measured on at least one engine. */
function measuredOnAnyEngine(q: PilotQuestionRow): boolean {
  return Object.values(q.engines).some((m) => m !== null);
}

/**
 * D-054 — one pilot: its questions, who supplied each and the customer's
 * written approval, and each question's measurement with its own Run.
 *
 * D-061 — one cell per engine, Perplexity and ChatGPT, each with its own
 * status, runs, Run and Retry, and the review resolution when it is held.
 * Whether ChatGPT is connected is the web host's gate, read here at request
 * time (never a constant): off, ChatGPT reads "Not connected" and offers no
 * Run, Retry or add. A question without a measurement on an engine reads
 * "Not measured" there, never zero (D-053). Retire stays per question: it
 * looks at every engine's measurement and stops the question on both.
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
  // D-062 — nor one whose retests changed since it was built, or while a retest is running.
  const retestState = await currentRetestState(client, pilot.id, questions.map((q) => q.id));
  const isStale = (r: (typeof revisions)[number]) =>
    r.sharedAt === null &&
    (!revisionActionsCurrent(r.actionVersionIds, currentActionVersions) || !revisionRetestsCurrent(r.retestManifest, retestState));
  // D-061 — a live question measured on any engine can carry an action's evidence.
  const actionQuestions = questions
    .filter((q) => q.retiredAt === null && measuredOnAnyEngine(q))
    .map((q) => ({ pilotQuestionId: q.id, ordinal: q.ordinal, text: q.questionText }));
  const siteUrl = publicSiteUrl();
  const today = todayUtc();
  const over = pilotIsOver(pilot.status, pilot.endsOn, today);
  const notStarted = pilotNotStarted(pilot.startsOn, today);
  // D-054 — a retired question no longer counts toward the limit.
  const liveCount = questions.filter((q) => q.retiredAt === null).length;
  const retiredCount = questions.length - liveCount;
  const full = liveCount >= pilot.questionLimit;
  // D-061 — the web host's ChatGPT gate, read at request time.
  const chatgptConnected = pilotChatGptEnabled();
  const engines = pilotEngines(chatgptConnected);
  const canAddChatGpt = chatgptConnected && !over;
  const withoutChatGpt = questions
    .filter((q) => q.retiredAt === null && q.engines.openai_chatgpt === null)
    .map((q) => q.id);
  // D-062 — the registered changes, and the retest gate read at request time.
  const retestEnabled = pilotRetestEnabled();
  const retests = await loadPilotRetests(client, pilot, questions, today);
  const unsharedCards = await cardsNotYetShared(client, pilot, questions, today);
  const closeWarnings = [
    ...(unsharedCards.length > 0 ? [cardsNotSharedWarning(unsharedCards.length)] : []),
    ...(retests.preparedNotRun > 0 ? [preparedNotRunWarning(retests.preparedNotRun)] : []),
  ];
  const groupView = (g: (typeof retests.groups)[number]): RetestGroupView => ({
    id: g.id,
    sequence: g.sequence,
    state: g.state,
    fields: [
      { label: RETEST_TEXT_LABELS.changeTitle, text: g.text.changeTitle },
      { label: RETEST_TEXT_LABELS.changeDescription, text: g.text.changeDescription },
      { label: RETEST_TEXT_LABELS.changeTarget, text: g.text.changeTarget },
      { label: RETEST_TEXT_LABELS.changeOwner, text: g.text.changeOwner },
      { label: "Kind of change", text: ACTION_TYPE_WORDS[g.actionType] ?? ACTION_TYPE_WORDS.other },
      { label: RETEST_TEXT_LABELS.hypothesis, text: g.text.hypothesis },
      { label: RETEST_TEXT_LABELS.expectedMechanism, text: g.text.expectedMechanism },
      { label: RETEST_TEXT_LABELS.alternativeExplanations, text: g.text.alternativeExplanations },
      { label: RETEST_TEXT_LABELS.openQuestions, text: g.text.openQuestions },
      { label: RETEST_TEXT_LABELS.decisionThreshold, text: g.text.decisionThreshold },
      {
        label: "Smaller than 60 points?",
        text: g.thresholdBelowLimit ? "Yes: this retest cannot settle the change the customer named." : "No.",
      },
      { label: RETEST_TEXT_LABELS.confoundersToMonitor, text: g.text.confoundersToMonitor },
      { label: "Customer approval", text: `${g.customerApprovalRef} (${g.customerApprovedOn})` },
    ],
    observationDays: g.observationDays,
    implementBy: g.implementBy,
    wentLiveOn: g.wentLiveOn,
    windowClosesAt: g.windowClosesAt,
    canAbandon: g.canAbandon,
    canPrepare: g.canPrepare,
    questions: g.questions,
    notes: g.notes.map((n) => ({
      id: n.id,
      line: noteWords({
        kind: n.kind,
        notedOn: n.notedOn,
        writtenOn: n.writtenAt.slice(0, 10),
        text: n.text,
        correctsNotedOn: n.correctsNoteId ? g.notes.find((x) => x.id === n.correctsNoteId)?.notedOn ?? null : null,
      }),
    })),
  });

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
        {pilot.status === "active" ? <ClosePilotButton pilotId={pilot.id} warnings={closeWarnings} /> : null}
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
        <AddQuestionPanel pilotId={pilot.id} disabled={over || full} chatgptConnected={chatgptConnected} />
        {canAddChatGpt && withoutChatGpt.length > 0 ? (
          <AddChatGptToAllButton pilotId={pilot.id} pilotQuestionIds={withoutChatGpt} />
        ) : null}
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
                {engines.map((e) => (
                  <th key={e.key}>
                    {e.label}
                    {e.connected ? null : <span className="zpa-muted"> ({ENGINE_NOT_CONNECTED})</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
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
                    {/* D-061 — per question: offered once any engine's measurement stopped; the database decides. */}
                    {/* D-062 — never for a question in a registered change that is not withdrawn (the database refuses it too). */}
                    {!over && q.retiredAt === null && Object.values(q.engines).some(stopped) && !retests.questionsInLiveGroup.includes(q.id) ? (
                      <RetireQuestionButton pilotId={pilot.id} pilotQuestionId={q.id} />
                    ) : null}
                  </td>
                  <td>
                    <p>{q.customerApprovalRef}</p>
                    <p className="zpa-muted">{q.customerApprovedOn}</p>
                  </td>
                  {engines.map((e) => (
                    <td key={e.key}>
                      <PilotEngineCell
                        pilotId={pilot.id}
                        pilotQuestionId={q.id}
                        engine={e.key}
                        measurement={q.engines[e.key]}
                        connected={e.connected}
                        canAddChatGpt={canAddChatGpt}
                        retired={q.retiredAt !== null}
                        pilotOpen={!over && !notStarted && q.retiredAt === null}
                      />
                    </td>
                  ))}
                </tr>
              ))}
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
        <h2 className="zpa-title">Retest</h2>
        <p className="zpa-muted">
          One registered customer change, measured again on every chosen question on both engines after its waiting period.
          Each question and engine gets its own Outcome Card inside the pilot report; nothing is added up across them.
          {retestEnabled ? "" : " Retests are switched off on this server: withdrawing a change, logging another change and resolving a held retest stay available."}
        </p>
        {unsharedCards.length > 0 ? <p className="zpa-new-audit-error">{cardsNotSharedWarning(unsharedCards.length)}</p> : null}
        {retestEnabled && retests.canRegister ? (
          <RetestRegisterPanel
            pilotId={pilot.id}
            questions={retests.questions}
            sourceActions={retests.sourceActions}
            labels={RETEST_TEXT_LABELS}
            maxQuestions={MAX_RETEST_QUESTIONS}
          />
        ) : null}
        {retests.groups
          .filter((g) => g.state !== "abandoned")
          .map((g) => (
            <RetestGroupPanel
              key={g.id}
              pilotId={pilot.id}
              group={groupView(g)}
              pilotOpen={!over && !notStarted}
              retestEnabled={retestEnabled}
              chatgptConnected={chatgptConnected}
            />
          ))}
        {retests.groups
          .filter((g) => g.state === "abandoned")
          .map((g) => (
            <p key={g.id} className="zpa-muted">
              {abandonedGroupWords({
                registeredOn: g.registeredAt.slice(0, 10),
                abandonedOn: (g.abandonedAt ?? "").slice(0, 10),
                liveOn: g.implementedAt ? g.implementedAt.slice(0, 10) : null,
              })}
            </p>
          ))}
        {retests.groups.length === 0 && !retests.canRegister ? <p className="zpa-muted">No change can be registered now.</p> : null}
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
                              ? revisionActionsCurrent(r.actionVersionIds, currentActionVersions)
                                ? RETEST_OUT_OF_DATE_WORDS
                                : STALE_REVISION_WORDS
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
