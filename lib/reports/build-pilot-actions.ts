/**
 * D-057 — the suggested actions of a combined pilot report.
 *
 * Every action reaches the report only as its latest reviewed version (the
 * caller selects it; the database refuses anything else at save). At each
 * build every link is checked again against the stored evidence the report
 * is built from:
 *   - the answer is one of this pilot's, to a question that is not retired;
 *   - it is a completed answer whose stored response re-hashes to its
 *     recorded SHA-256;
 *   - a named source is re-found among that answer's own extracted sources,
 *     under the rule the question's source section uses: the one its
 *     protocol's provider names (D-056; passed since D-061, before which a
 *     ChatGPT answer was read as a Perplexity Agent body and had no sources).
 *     The named URL is put in that rule's form before it is compared, so a
 *     ChatGPT link copied with OpenAI's `utm_source=openai` tag matches.
 * A link that fails, or wording a suggested action may not use, blocks the
 * report. Any action at all holds it for the founder's review.
 *
 * Pure: no database, network, provider or model.
 */
import { lintPilotActionText, PILOT_ACTION_TEXT_FIELDS, type PilotActionText } from "@/lib/pilots/action-rules";
import { runOrdinalsByAttemptId } from "@/lib/reports/build-protocol-report";
import type { PilotReportAction, PilotReportActionEvidence, PilotEngineKey } from "@/lib/reports/pilot-report-types";
import type { EvidenceAttemptInput, EvidenceResultInput, BuildProtocolReportInput } from "@/lib/reports/protocol-report-types";
import { extractProviderSources, normalizeProviderSourceUrl } from "@/lib/source-insights/extract-provider-sources";

export interface PilotReportActionInput extends PilotActionText {
  actionId: string;
  versionId: string;
  versionNumber: number;
  /** When this version was reviewed (ISO timestamp). */
  reviewedAt: string;
  evidence: { attemptId: string; sourceUrl: string | null }[];
}

/** The slots the report is built from, as `buildPilotReport` receives them. */
export interface PilotActionSlot {
  pilotQuestionId: string;
  ordinal: number;
  retired: boolean;
  engine: PilotEngineKey;
  evidence: BuildProtocolReportInput;
}

export interface PilotActionReason {
  status: "needs_review" | "blocked";
  reason: string;
}

const ENGINE_WORDS: Record<PilotEngineKey, string> = { perplexity_sonar: "Perplexity", openai_chatgpt: "ChatGPT" };

/** The answer statuses that make a link unverifiable. */
const UNVERIFIED = new Set(["no_raw_response", "hash_missing", "hash_mismatch"]);

export function buildPilotActions(
  inputs: PilotReportActionInput[],
  slots: PilotActionSlot[]
): { actions: PilotReportAction[]; versionIds: string[]; structural: PilotActionReason[] } {
  const byAttempt = new Map<
    string,
    { slot: PilotActionSlot; attempt: EvidenceAttemptInput; result: EvidenceResultInput | undefined; answerNumber: number }
  >();
  for (const slot of slots) {
    const ordinals = runOrdinalsByAttemptId(slot.evidence.attempts);
    const results = new Map(slot.evidence.results.map((r) => [r.probeRunId, r]));
    for (const attempt of slot.evidence.attempts) {
      byAttempt.set(attempt.id, {
        slot,
        attempt,
        result: attempt.probeRunId ? results.get(attempt.probeRunId) : undefined,
        answerNumber: ordinals.get(attempt.id) ?? 0,
      });
    }
  }

  const structural: PilotActionReason[] = [];
  const actions: PilotReportAction[] = [];

  inputs.forEach((input, index) => {
    const name = `Suggested action ${index + 1} ("${input.title}")`;
    const block = (reason: string) => structural.push({ status: "blocked", reason: `${name}: ${reason}` });

    for (const field of PILOT_ACTION_TEXT_FIELDS) {
      const value = input[field.key] ?? "";
      if (value.trim().length < field.min || value.length > field.max) {
        block(`its "${field.label}" is missing or too long.`);
      }
      const hits = lintPilotActionText(value);
      if (hits.length > 0) {
        block(`its "${field.label}" uses wording a suggested action may not use (${hits.join(", ")}).`);
      }
    }
    if (input.evidence.length === 0) block("it links to no stored answer.");

    const evidence: PilotReportActionEvidence[] = [];
    for (const link of input.evidence) {
      const found = byAttempt.get(link.attemptId);
      if (!found) {
        block("it rests on an answer that is not one of this pilot's answers.");
        continue;
      }
      const { slot, attempt, result, answerNumber } = found;
      const where = `question ${slot.ordinal}, ${ENGINE_WORDS[slot.engine]} answer ${answerNumber}`;
      if (slot.retired) {
        block(`it rests on ${where}, and that question is retired.`);
        continue;
      }
      if (attempt.status !== "completed" || !result) {
        block(`it rests on ${where}, which is no longer a completed answer.`);
        continue;
      }
      // D-061 — the protocol's provider decides the rule, as in the question's
      // own report (buildProtocolReport); a slot on another engine blocks the
      // report in buildPilotReport.
      const provider = slot.evidence.protocol.provider;
      const sources = extractProviderSources(result.rawResponse, result.rawResponseSha256, provider);
      if (UNVERIFIED.has(sources.status) || typeof result.rawResponseSha256 !== "string") {
        block(`the stored response of ${where} could not be checked against its recorded fingerprint.`);
        continue;
      }
      let sourceUrl: string | null = null;
      let sourceDomain: string | null = null;
      let sourceCited: boolean | null = null;
      if (link.sourceUrl !== null) {
        const wanted = normalizeProviderSourceUrl(link.sourceUrl, provider)?.url ?? link.sourceUrl;
        const cited = sources.cited.find((s) => s.url === wanted);
        const retrieved = cited ? undefined : sources.retrievedOnly.find((s) => s.url === wanted);
        const hit = cited ?? retrieved;
        if (sources.status !== "ok" || !hit) {
          block(`it names a source that is not among the sources of ${where}.`);
          continue;
        }
        sourceUrl = hit.url;
        sourceDomain = hit.domain;
        sourceCited = Boolean(cited);
      }
      evidence.push({
        attemptId: attempt.id,
        pilotQuestionId: slot.pilotQuestionId,
        ordinal: slot.ordinal,
        engine: slot.engine,
        answerNumber,
        rawResponseSha256: result.rawResponseSha256,
        sourceUrl,
        sourceDomain,
        sourceCited,
      });
    }

    actions.push({
      actionId: input.actionId,
      versionId: input.versionId,
      versionNumber: input.versionNumber,
      title: input.title,
      observation: input.observation,
      suggestedAction: input.suggestedAction,
      whyItMightMatter: input.whyItMightMatter,
      alternativeExplanations: input.alternativeExplanations,
      openQuestions: input.openQuestions,
      reviewedOn: input.reviewedAt.slice(0, 10),
      evidence,
    });
  });

  if (actions.length > 0) {
    structural.push({
      status: "needs_review",
      reason: `The report includes ${actions.length} suggested action${actions.length === 1 ? "" : "s"} written by the team. Read each one, and the answers it rests on, before sharing.`,
    });
  }

  return { actions, versionIds: actions.map((a) => a.versionId), structural };
}
