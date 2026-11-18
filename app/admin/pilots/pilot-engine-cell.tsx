import type { PilotQuestionEngine } from "@/lib/db/types";
import {
  ENGINE_NOT_CONNECTED_CONTROLS_NOTE,
  ENGINE_NOT_MEASURED,
  pilotHeldReasonText,
  pilotJobStatusLabel,
  pilotRunsLine,
} from "@/lib/pilots/copy";
import type { PilotMeasurement } from "@/lib/pilots/reads";
import { AddChatGptButton, QuestionControls, ResolveReviewControls } from "./pilot-forms";

export interface PilotEngineCellProps {
  pilotId: string;
  pilotQuestionId: string;
  engine: PilotQuestionEngine;
  /** The question's baseline measurement on this engine, or null when it has none. */
  measurement: PilotMeasurement | null;
  /**
   * Run and Retry may be offered on this engine: always for Perplexity; for
   * ChatGPT only when the web host's gate is on (pilotEngines, read by the
   * page at request time).
   */
  connected: boolean;
  /** ChatGPT may be added to a question: the gate is on and the pilot is not over. */
  canAddChatGpt: boolean;
  retired: boolean;
  /** The pilot is open and started, and the question is live. */
  pilotOpen: boolean;
}

/**
 * D-061 — one engine's cell of a pilot question (app/admin/pilots/[pilotId]):
 * its status and runs, the review resolution when it is held, and Run or
 * Retry only when the engine is connected. A question without a measurement
 * on the engine reads "Not measured", never zero (D-053), with Add ChatGPT
 * when the gate allows it. Rendered by the page and, for its behaviour, by
 * test:pilot-questions (review of phase B).
 */
export function PilotEngineCell(p: PilotEngineCellProps) {
  const m = p.measurement;
  if (!m) {
    return (
      <>
        <p className="zpa-muted">{ENGINE_NOT_MEASURED}</p>
        {p.engine === "openai_chatgpt" && p.canAddChatGpt && !p.retired ? (
          <AddChatGptButton pilotId={p.pilotId} pilotQuestionId={p.pilotQuestionId} />
        ) : null}
      </>
    );
  }
  return (
    <>
      <p>{pilotJobStatusLabel(m.jobStatus, m.stale)}</p>
      <p className="zpa-muted">{pilotRunsLine(m)}</p>
      {m.jobStatus === "needs_review" ? (
        <>
          <p className="zpa-muted">{pilotHeldReasonText(m.needsReviewReason, p.engine)}</p>
          <ResolveReviewControls pilotId={p.pilotId} pilotQuestionId={p.pilotQuestionId} engine={p.engine} />
        </>
      ) : null}
      {p.connected ? (
        <QuestionControls
          pilotId={p.pilotId}
          pilotQuestionId={p.pilotQuestionId}
          engine={p.engine}
          jobStatus={m.jobStatus}
          stale={m.stale}
          plannedRuns={m.plannedRuns}
          runCap={m.runCap}
          spendCapUsd={m.spendCapUsd}
          pilotOpen={p.pilotOpen}
        />
      ) : (
        <p className="zpa-muted">{ENGINE_NOT_CONNECTED_CONTROLS_NOTE}</p>
      )}
    </>
  );
}
