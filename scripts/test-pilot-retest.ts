#!/usr/bin/env tsx
/**
 * D-062 — the pilot retest and its Outcome Cards, offline (test:pilot-retest).
 *
 *   P  the new pure modules import no database, network, provider or model;
 *   A  the route parsers: every bound, the lint on every customer-visible
 *      field and note, confirmation, distinct questions, the link-or-
 *      fingerprint rule, the deviation note exactly when not as registered;
 *   F  retestJobIsFinal over every job status, pilot open, closed or ended,
 *      and retryable, requeueable or neither; the member states;
 *   R  the fixture (5 questions × 2 engines): an increase, no clear change,
 *      inconclusive, a retryable stop that shows no status, the same stop
 *      made final by the pilot's end (a short card), a window still open,
 *      an incompatible measurement, a retest held for review, a stop before
 *      any answer (requeueable, then final at the limit), changes withdrawn
 *      before and after going live, notes after the first answer, a
 *      correction and a withdrawn source action;
 *   C  each card's content, in §3.5's order, and the footer from the
 *      constant;
 *   N  nothing is combined: status words only inside one card, no two in one
 *      string, the baseline tables identical with and without retests;
 *   M  the method pin: 36 outcome pairs at 5 vs 5;
 *   L  lint at build withholds; the approval reference never reaches the
 *      payload, page or Markdown;
 *   K  the manifest and evidence index, integrity, stored revisions from
 *      before D-062, the Markdown and page strings, the wording rules;
 *   X  the generic M7 exclusions (§3.6), through the intervention fakes;
 *   H  the six routes: kill switch, guard, gate, ids and body, in that
 *      order; abandon, notes and retest review are not gated; closed-field
 *      logs; no new file reaches the worker starter; the phase choice and a
 *      retest refused with the gate off.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

(require("node:module") as { _extensions: Record<string, unknown> })._extensions[".css"] = () => undefined;

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { lintPilotActionText } from "@/lib/pilots/action-rules";
import { pilotPhaseFromBody, pilotRetestEnabled } from "@/lib/pilots/engines";
import * as founderCopy from "@/lib/pilots/retest-copy";
import {
  MAX_REQUEUES,
  parseAbandonRetest,
  parseConfirmRetest,
  parseRegisterRetest,
  parseRequeueRetest,
  parseRetestNote,
  PILOT_OUTCOME_RULE,
  RETEST_MEMBER_STATES,
  RETEST_NOTE_KINDS,
  retestJobIsFinal,
  retestMemberState,
  retestQuestionRefusal,
  type RetestBaselineFacts,
  type RetestFinalityInput,
} from "@/lib/pilots/retest-rules";
import {
  handleAbandonPilotRetest,
  handleAddPilotRetestNote,
  handleConfirmPilotRetest,
  handlePreparePilotRetests,
  handleRegisterPilotRetest,
  MAX_REGISTER_BODY_BYTES,
  handleRequeuePilotRetest,
  type PilotRetestRouteDeps,
} from "@/lib/pilots/retest-routes";
import { revisionRetestsCurrent, type CurrentRetestState } from "@/lib/pilots/retest-store";
import { buildPilotReport, type PilotReportInput, type PilotReportQuestionInput } from "@/lib/reports/build-pilot-report";
import type { PilotRetestGroupInput, PilotRetestMemberInput, PilotRetestsInput } from "@/lib/reports/build-pilot-retests";
import { compareProtocols } from "@/lib/reports/compare-protocols";
import type { MeasurementCompatibility } from "@/lib/reports/measurement-fingerprint";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import { evaluatePilotReportIntegrity } from "@/lib/reports/pilot-report-integrity";
import { builtBeforeD062, cardStrings, presentationStrings, presentPilotReport } from "@/lib/reports/pilot-report-presentation";
import { isPilotReportPayload, type PilotReportPayload } from "@/lib/reports/pilot-report-types";
import * as copy from "@/lib/reports/pilot-retest-copy";
import { manifestRetests } from "@/lib/reports/process-pilot-report";
import { readPilotReportInput } from "@/lib/reports/read-pilot-evidence";
import { renderPilotReportMarkdown } from "@/lib/reports/render-pilot-report-markdown";
import { CHATGPT_SURFACE_LIMITATION, DEPENDENCE_LIMITATION, PERPLEXITY_SURFACE_LIMITATION } from "@/lib/reports/surface-limitations";
import type { BuildProtocolReportInput, EvidenceAttemptInput, EvidenceResultInput } from "@/lib/reports/protocol-report-types";
import { ACTION_TYPES } from "@/lib/interventions/types";
import { SOURCE_COMPARISON_NOTE } from "@/lib/source-insights/build-source-insights";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (f: string) => readFileSync(f, "utf8");

/* ================================================================ P: pure modules */

console.log("test-pilot-retest\n\n[P] pure modules");
const PURE = ["lib/pilots/retest-rules.ts", "lib/pilots/retest-copy.ts", "lib/reports/pilot-retest-copy.ts", "lib/reports/build-pilot-retests.ts"];
const importsOf = (file: string) => [...read(file).matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
const banned = /supabase|openai|perplexity|probes|protocol-worker|node:http|node:https|undici|resend|read-protocol-evidence|read-pilot-evidence|protocol-integrity-signals|fly-machine/;
check("P1 the four new pure modules import no database, network, provider or model module",
  PURE.every((f) => importsOf(f).every((m) => !banned.test(m))), PURE.map((f) => `${f}: ${importsOf(f).join(",")}`).join(" | "));
check("P2 nothing in them calls fetch, rpc or a table read",
  PURE.every((f) => !/\bfetch\(|\.rpc\(|\.from\(|chat\.completions|responses\.create/.test(read(f))));
check("P3 the two copy modules have type-only imports, so the console's client code can load them",
  ["lib/pilots/retest-copy.ts", "lib/reports/pilot-retest-copy.ts"].every((f) => [...read(f).matchAll(/^import (?!type )/gm)].length === 0));

/* ================================================================ A: parsers */

console.log("\n[A] parsers");
const TODAY = "2027-01-20";
const Q = [1, 2, 3, 4, 5, 6].map((n) => `00000000-0000-4000-8000-${String(70000 + n).padStart(12, "0")}`);
const GOOD_TEXT = {
  changeTitle: "Comparison page",
  changeDescription: "A page comparing the product with three named alternatives.",
  changeTarget: "acme.test/compare",
  changeOwner: "Customer marketing",
  hypothesis: "A comparison page may be cited for shortlist questions.",
  expectedMechanism: "Engines retrieve comparison pages for shortlist prompts.",
  alternativeExplanations: "Engines change their sources on their own.",
  openQuestions: "Whether engines re-crawl the site within the waiting period.",
  decisionThreshold: "Named in most answers on both engines.",
  confoundersToMonitor: "Competitor launches and engine model changes.",
};
const GOOD_REGISTER = {
  ...GOOD_TEXT,
  pilotQuestionIds: [Q[0], Q[1]],
  actionType: "page_created",
  thresholdBelowLimit: false,
  observationDays: 21,
  customerApprovalRef: "Email of 2027-01-10",
  customerApprovedOn: "2027-01-10",
  sourceActionVersionIds: [],
  confirmed: true,
  idempotencyKey: randomUUID(),
};
const reg = (over: Record<string, unknown>) => parseRegisterRetest({ ...GOOD_REGISTER, ...over }, TODAY);
const refusedOn = (r: { ok: boolean; issues?: Record<string, string[]> }, field: string) => !r.ok && Boolean(r.issues?.[field]?.length);
check("A1 a good registration parses, trimmed, with the questions lower-cased and the days a number",
  (() => { const r = reg({ changeTitle: "  Comparison page ", observationDays: "21" }); return r.ok && r.value.changeTitle === "Comparison page" && r.value.observationDays === 21 && r.value.confirmed === true; })());
const BOUNDS: Record<string, [number, number]> = {
  changeTitle: [3, 120], changeDescription: [10, 2000], changeTarget: [3, 500], changeOwner: [3, 200], hypothesis: [10, 2000],
  expectedMechanism: [10, 2000], alternativeExplanations: [10, 2000], openQuestions: [10, 2000], decisionThreshold: [10, 2000], confoundersToMonitor: [10, 2000],
};
const boundOk = Object.entries(BOUNDS).every(([f, [min, max]]) =>
  refusedOn(reg({ [f]: "x".repeat(min - 1) }), f) && refusedOn(reg({ [f]: "x".repeat(max + 1) }), f) && reg({ [f]: "y".repeat(min) }).ok && reg({ [f]: "y".repeat(max) }).ok);
check("A2 every registered text's bounds, both sides (the pilot_retests CHECKs)", boundOk);
check("A3 the waiting period is a whole number of days from 7 to 60",
  refusedOn(reg({ observationDays: 6 }), "observationDays") && refusedOn(reg({ observationDays: 61 }), "observationDays") &&
  refusedOn(reg({ observationDays: 7.5 }), "observationDays") && reg({ observationDays: 7 }).ok && reg({ observationDays: 60 }).ok);
check("A4 1 to 5 distinct questions, each an id",
  refusedOn(reg({ pilotQuestionIds: [] }), "pilotQuestionIds") && refusedOn(reg({ pilotQuestionIds: Q }), "pilotQuestionIds") &&
  refusedOn(reg({ pilotQuestionIds: [Q[0], Q[0].toUpperCase()] }), "pilotQuestionIds") && refusedOn(reg({ pilotQuestionIds: ["q1"] }), "pilotQuestionIds") &&
  reg({ pilotQuestionIds: Q.slice(0, 5) }).ok);
check("A5 the kind is one of 0071's seven, the threshold answer is required (no pre-fill), the approval dated and not in the future",
  refusedOn(reg({ actionType: "press_release" }), "actionType") && refusedOn(reg({ thresholdBelowLimit: undefined }), "thresholdBelowLimit") &&
  refusedOn(reg({ customerApprovedOn: "2027-01-21" }), "customerApprovedOn") && refusedOn(reg({ customerApprovalRef: "ab" }), "customerApprovalRef") &&
  ACTION_TYPES.every((t) => reg({ actionType: t }).ok));
check("A6 at most 5 distinct source actions; confirmation and a key are required",
  refusedOn(reg({ sourceActionVersionIds: Q.slice(0, 6) }), "sourceActionVersionIds") && refusedOn(reg({ sourceActionVersionIds: [Q[0], Q[0]] }), "sourceActionVersionIds") &&
  refusedOn(reg({ confirmed: false }), "confirmed") && refusedOn(reg({ idempotencyKey: "k" }), "idempotencyKey"));
const lintAll = Object.keys(GOOD_TEXT).every((f) => {
  const r = reg({ [f]: `${(GOOD_TEXT as Record<string, string>)[f]} This will improve your ranking.` });
  return !r.ok && (r.issues?.[f] ?? []).some((m) => m.includes("improve your ranking"));
});
check("A7 every one of the ten customer-visible fields is linted, and the refusal names the field and the words", lintAll);
check("A8 the approval reference is internal (M10) and not linted", reg({ customerApprovalRef: "Thread: we guarantee results" }).ok);

const GOOD_CONFIRM = { wentLiveOn: "2027-01-12", evidenceUrl: "https://acme.test/compare", note: "Customer emailed the live link.", implementedAsRegistered: true, confirmed: true };
const conf = (over: Record<string, unknown>) => parseConfirmRetest({ ...GOOD_CONFIRM, ...over }, TODAY);
const SHA = "a".repeat(64);
check("A9 a link or a fingerprint, or both; one of them is required",
  conf({}).ok && conf({ evidenceUrl: null, artifactSha256: SHA }).ok && conf({ artifactSha256: SHA }).ok &&
  refusedOn(conf({ evidenceUrl: null }), "evidenceUrl") && refusedOn(conf({ evidenceUrl: "ftp://acme.test/x" }), "evidenceUrl") &&
  refusedOn(conf({ evidenceUrl: null, artifactSha256: "abc" }), "artifactSha256"));
check("A10 a fingerprint is stored lower-case",
  (() => { const r = conf({ evidenceUrl: null, artifactSha256: "A".repeat(64) }); return r.ok && r.value.artifactSha256 === SHA; })());
check("A11 the deviation note is required exactly when the change was not made as registered, and linted",
  refusedOn(conf({ implementedAsRegistered: false }), "deviationNote") && conf({ implementedAsRegistered: false, deviationNote: "Only two of the three alternatives." }).ok &&
  refusedOn(conf({ deviationNote: "Only two of the three alternatives." }), "deviationNote") &&
  refusedOn(conf({ implementedAsRegistered: undefined }), "implementedAsRegistered") &&
  refusedOn(conf({ implementedAsRegistered: false, deviationNote: "Only two, which will improve your ranking." }), "deviationNote"));
check("A12 the go-live date is a real day, not in the future; the note is 10-2000 characters; confirmation required",
  refusedOn(conf({ wentLiveOn: "2027-01-21" }), "wentLiveOn") && refusedOn(conf({ wentLiveOn: "2027-02-30" }), "wentLiveOn") &&
  refusedOn(conf({ note: "short" }), "note") && refusedOn(conf({ confirmed: false }), "confirmed"));
check("A13 withdrawing needs a 10-2000 character reason and confirmation",
  parseAbandonRetest({ reason: "The customer cancelled the page.", confirmed: true }).ok &&
  refusedOn(parseAbandonRetest({ reason: "no", confirmed: true }), "reason") && refusedOn(parseAbandonRetest({ reason: "The customer cancelled.", confirmed: false }), "confirmed"));
const note = (over: Record<string, unknown>) =>
  parseRetestNote({ notedOn: "2027-01-15", kind: "competitor_activity", text: "A competitor launched a comparison page.", idempotencyKey: randomUUID(), ...over }, TODAY);
check("A14 a note: one of the eight kinds, 10-2000 characters, linted, not in the future, an optional corrected note",
  note({}).ok && RETEST_NOTE_KINDS.every((k) => note({ kind: k }).ok) && refusedOn(note({ kind: "other" }), "kind") &&
  refusedOn(note({ text: "short" }), "text") && refusedOn(note({ text: "This change caused the lift we saw." }), "text") &&
  refusedOn(note({ notedOn: "2027-01-21" }), "notedOn") && note({ correctsNoteId: Q[0] }).ok && refusedOn(note({ correctsNoteId: "x" }), "correctsNoteId"));
check("A15 queue again: the question, one of the two engines, and a reason",
  parseRequeueRetest({ pilotQuestionId: Q[0], engine: "openai_chatgpt", reason: "The worker was not set up for ChatGPT." }).ok &&
  refusedOn(parseRequeueRetest({ pilotQuestionId: Q[0], engine: "gemini", reason: "The worker was not set up." }), "engine") &&
  refusedOn(parseRequeueRetest({ pilotQuestionId: "x", engine: "openai_chatgpt", reason: "The worker was not set up." }), "pilotQuestionId"));

/* ================================================================ F: finality and states */

console.log("\n[F] finality and member states");
const JOB = "00000000-0000-4000-8000-000000000901";
function finality(status: string, pilot: "open" | "closed" | "ended", kind: "retryable" | "requeueable" | "neither", requeueCount = 0): RetestFinalityInput {
  const attempts =
    kind === "retryable"
      ? [{ id: "a1", jobId: JOB, status: "failed", terminalizedAt: "2027-01-05T10:00:00Z", baselineOrdinal: 1, retryOfAttemptId: null }]
      : kind === "neither"
        ? [{ id: "a1", jobId: JOB, status: "completed", terminalizedAt: "2027-01-05T10:00:00Z", baselineOrdinal: 1, retryOfAttemptId: null }]
        : [];
  return {
    job: { id: JOB, status, reviewResolution: null, currentAttemptId: null, failureReason: kind === "requeueable" ? "PROVIDER_ADAPTER_NOT_ENABLED" : "provider_error", nextBaselineOrdinal: 1 },
    protocol: { plannedBaselineRuns: 5, runCap: 7 },
    attempts,
    pilot: { status: pilot === "closed" ? "closed" : "active", startsOn: "2026-11-18", endsOn: pilot === "ended" ? "2027-01-19" : "2027-02-16" },
    questionRetired: false,
    requeueCount,
    today: TODAY,
  };
}
const STATUSES = ["succeeded", "abandoned_exhausted", "cancelled", "needs_review", "queued", "claimed", "running", "failed", "mystery"];
let tableOk = true;
const tableMisses: string[] = [];
for (const status of STATUSES) {
  for (const pilot of ["open", "closed", "ended"] as const) {
    for (const kind of ["retryable", "requeueable", "neither"] as const) {
      const runnable = pilot === "open";
      const expected =
        ["succeeded", "abandoned_exhausted", "cancelled"].includes(status) ? true
          : status === "needs_review" ? false
            : ["queued", "claimed", "running"].includes(status) ? !runnable
              : status === "failed" ? !(runnable && (kind === "retryable" || kind === "requeueable"))
                : false;
      const got = retestJobIsFinal(finality(status, pilot, kind));
      if (got !== expected) { tableOk = false; tableMisses.push(`${status}/${pilot}/${kind}`); }
    }
  }
}
check("F1 retestJobIsFinal over 9 statuses × pilot open, closed, ended × retryable, requeueable, neither (81 cases) is §2.5's table", tableOk, tableMisses.join(","));
check("F2 a stop before any answer is requeueable 3 times, then final",
  !retestJobIsFinal(finality("failed", "open", "requeueable", MAX_REQUEUES - 1)) && retestJobIsFinal(finality("failed", "open", "requeueable", MAX_REQUEUES)));
check("F3 a retry past the run cap is not retryable, so a provider stop is final",
  retestJobIsFinal({ ...finality("failed", "open", "retryable"), protocol: { plannedBaselineRuns: 5, runCap: 4 } }));
check("F4 a review resolution or a current attempt makes neither retry nor requeue possible",
  retestJobIsFinal({ ...finality("failed", "open", "requeueable"), job: { ...finality("failed", "open", "requeueable").job, reviewResolution: "failed" } }) &&
  retestJobIsFinal({ ...finality("failed", "open", "retryable"), job: { ...finality("failed", "open", "retryable").job, currentAttemptId: "a1" } }));
const NOW_MS = Date.parse("2027-01-20T12:00:00Z");
const st = (groupState: "registered" | "implemented" | "prepared" | "abandoned", retest: { jobStatus: string | null; attempts: number; final: boolean } | null, closes = "2027-01-01T00:00:00Z") =>
  retestMemberState({ groupState, windowClosesAt: closes, nowMs: NOW_MS, retest });
check("F5 the member states: each of the ten from its group and slot",
  st("abandoned", null) === "retest_withdrawn" && st("registered", null) === "retest_awaiting_change" &&
  st("implemented", null, "2027-02-01T00:00:00Z") === "retest_window_open" && st("implemented", null) === "retest_awaiting_preparation" &&
  st("prepared", { jobStatus: "queued", attempts: 0, final: false }) === "retest_not_run" &&
  st("prepared", { jobStatus: "running", attempts: 2, final: false }) === "retest_collecting" &&
  st("prepared", { jobStatus: "needs_review", attempts: 5, final: false }) === "retest_held_for_review" &&
  st("prepared", { jobStatus: "failed", attempts: 3, final: false }) === "retest_stopped_retryable" &&
  st("prepared", { jobStatus: "failed", attempts: 0, final: true }) === "retest_could_not_run" &&
  st("prepared", { jobStatus: "succeeded", attempts: 5, final: true }) === "retest_measured");
const facts = (over: Partial<RetestBaselineFacts> = {}): RetestBaselineFacts => ({
  exists: true, plannedRuns: 5, jobStatus: "succeeded", attemptsInFlight: 0, readable: 5, reservedBeforeEarlierChange: false, alreadyRegistered: false, ...over,
});
const refusal = (p: Partial<RetestBaselineFacts>, c: Partial<RetestBaselineFacts> = {}, q: { retired?: boolean; earlier?: boolean } = {}) =>
  retestQuestionRefusal({ retired: q.retired ?? false, inEarlierLiveChange: q.earlier ?? false, engines: { perplexity_sonar: facts(p), openai_chatgpt: facts(c) } });
check("F6 the console's copy of §2.6 step 7: each refusal, in the database's order, Perplexity first",
  refusal({}) === null && refusal({}, {}, { retired: true })?.refusal === "QUESTION_NOT_LIVE" &&
  refusal({}, {}, { earlier: true })?.refusal === "QUESTION_IN_EARLIER_LIVE_CHANGE" &&
  refusal({}, { exists: false })?.refusal === "BASELINE_MISSING" && refusal({}, { exists: false })?.engine === "openai_chatgpt" &&
  refusal({ plannedRuns: 6 })?.refusal === "BASELINE_PLAN_NOT_FIVE_RUNS" && refusal({ attemptsInFlight: 1 })?.refusal === "BASELINE_NOT_FINISHED" &&
  refusal({ readable: 4 }, { exists: false })?.refusal === "BASELINE_NOT_FIVE_READABLE" &&
  refusal({ reservedBeforeEarlierChange: true })?.refusal === "BASELINE_BEFORE_EARLIER_CHANGE" &&
  refusal({ alreadyRegistered: true })?.refusal === "BASELINE_ALREADY_REGISTERED");

/* ================================================================ R: the fixture */

console.log("\n[R] the fixture: 5 questions × 2 engines");
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PILOT = "22222222-2222-4222-8222-222222222222";
const COMPANY = "Acme Analytics";
const DOMAIN = "acme.test";
const NOW = new Date("2027-01-20T12:00:00.000Z");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let seq = 0;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GPT_MODEL = "gpt-5.4-2026-03-05";
const GPT_SETTING = "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05";
type Engine = "perplexity_sonar" | "openai_chatgpt";
type Run = boolean | null | "failed" | "excluded";

function body(engine: Engine, n: number): string {
  return engine === "perplexity_sonar"
    ? JSON.stringify({ id: `r${n}`, model: "sonar", choices: [{ message: { role: "assistant", content: "Options include Vanta [1]." } }], citations: ["https://www.g2.com/x"], search_results: [{ title: "G2", url: "https://www.g2.com/x" }] })
    : JSON.stringify({ id: `r${n}`, object: "response", status: "completed", model: GPT_MODEL, output: [{ type: "message", content: [{ type: "output_text", text: "Options include Vanta.", annotations: [] }] }] });
}

function evidence(protocolId: string, engine: Engine, text: string, runs: Run[], kind: "baseline" | "retest"): BuildProtocolReportInput {
  const attempts: EvidenceAttemptInput[] = [];
  const results: EvidenceResultInput[] = [];
  runs.forEach((r, i) => {
    const id = uid(++seq);
    const probeRunId = r === "excluded" ? null : uid(++seq);
    attempts.push({ id, attemptKind: kind, status: r === "failed" ? "failed" : r === "excluded" ? "excluded" : "completed", baselineOrdinal: i + 1, probeRunId, retryOfAttemptId: null, terminationReason: r === "failed" ? "provider_error" : null });
    if (probeRunId && r !== "failed") {
      const b = body(engine, seq);
      results.push({ probeRunId, clientMentioned: r as boolean | null, clientPosition: null, competitorsMentioned: [], sourcesCited: [], answerSummary: "s", rawResponseSha256: sha(b), rawResponse: b, providerModel: engine === "openai_chatgpt" ? GPT_MODEL : "sonar", providerLatencyMs: 900 });
    }
  });
  return {
    snapshotRequestId: protocolId,
    projectId: PROJECT,
    subject: { companyName: COMPANY, websiteUrl: DOMAIN, normalizedDomain: DOMAIN },
    question: { text, hash: sha(text), versionNumber: 1, intentType: "shortlist", provenance: "operator", approvedAt: "2026-11-18T00:00:00Z" },
    protocol: { id: protocolId, provider: engine, surface: "answer", model: engine === "openai_chatgpt" ? GPT_MODEL : "sonar", plannedBaselineRuns: 5, unitOfAnalysis: "buyer_question_version", primaryMetric: "presence_rate", methodologyVersion: "1", analyzerVersion: 1, entityResolutionVersion: 1, approvedAt: "2026-11-18T00:00:00Z" },
    attempts,
    results,
  };
}

const T = (n: boolean) => Array(5).fill(n) as Run[];
const mix = (k: number, n = 5): Run[] => Array.from({ length: n }, (_, i) => i < k);
const qText = (o: number) => `Which analytics tools suit a team of ${o}?`;
const QID = (o: number) => uid(8000 + o);
const BASE = (o: number, e: Engine) => uid(9000 + o * 10 + (e === "perplexity_sonar" ? 1 : 2));
const RET = (o: number, e: Engine) => uid(9500 + o * 10 + (e === "perplexity_sonar" ? 1 : 2));
const QV = (o: number) => uid(7000 + o);

/** Baselines: Q1 0/5 both; Q2 3/5 and 0/5; Q3 2/5, 4/5; Q4 1/5, 2/5; Q5 3/5, 5/5. All 5 readable. */
const BASELINES: Record<number, [Run[], Run[]]> = { 1: [T(false), T(false)], 2: [mix(3), T(false)], 3: [mix(2), mix(4)], 4: [mix(1), mix(2)], 5: [mix(3), T(true)] };
function questions(): PilotReportQuestionInput[] {
  return [1, 2, 3, 4, 5].map((o) => ({
    pilotQuestionId: QID(o),
    ordinal: o,
    provenance: "customer_supplied",
    customerApprovedOn: "2026-11-18",
    retiredAt: null,
    slots: (["perplexity_sonar", "openai_chatgpt"] as Engine[]).map((e, i) => ({
      engine: e,
      protocolId: BASE(o, e),
      jobStatus: "succeeded",
      evidence: evidence(BASE(o, e), e, qText(o), BASELINES[o][i], "baseline"),
      execution: { firstOn: "2026-11-19", lastOn: "2026-11-20" },
      answerModes: [e === "perplexity_sonar" ? "live_perplexity" : "live_openai_chatgpt"],
      settingVersion: e === "openai_chatgpt" ? GPT_SETTING : null,
    })),
  }));
}

/** The baselines, built once: every report below reads the same stored answers. */
const QUESTIONS = questions();

const REGISTERED_AT = "2026-12-01T10:00:00.000Z";
const IMPLEMENTED_AT = "2026-12-02T10:00:00.000Z";
const CLOSES_AT = "2026-12-23T10:00:00.000Z";
const RESERVED = "2027-01-05T10:00:00.000Z";
const COMPATIBLE: MeasurementCompatibility = { status: "compatible", version: "mf-1", caveats: [] };

interface MemberSpec {
  runs?: Run[] | null;
  jobStatus?: string;
  failureReason?: string | null;
  requeueCount?: number;
  compatibility?: MeasurementCompatibility;
}

function intervention(o: number, e: Engine, status: string, text = GOOD_TEXT) {
  return {
    status, protocolId: BASE(o, e), approvedAt: "2026-12-01T10:00:00Z", implementedAt: status === "implemented" ? IMPLEMENTED_AT : null,
    windowOpensAt: status === "implemented" ? IMPLEMENTED_AT : null, windowClosesAt: status === "implemented" ? CLOSES_AT : null,
    protocolDeviations: null, earlyRetestAuthorizedAt: null, hypothesis: text.hypothesis, expectedMechanism: text.expectedMechanism,
    actionType: "page_created", actionTarget: text.changeTarget, owner: text.changeOwner, alternativeExplanations: text.alternativeExplanations,
    confoundersToMonitor: text.confoundersToMonitor, decisionThresholdNote: text.decisionThreshold,
  };
}

function member(groupId: string, o: number, e: Engine, ivStatus: string, spec: MemberSpec | null, text = GOOD_TEXT): PilotRetestMemberInput {
  const id = uid(60000 + o * 10 + (e === "perplexity_sonar" ? 1 : 2) + (groupId === G1 ? 100 : 0));
  let retest: PilotRetestMemberInput["retest"] = null;
  if (spec) {
    const ev = evidence(RET(o, e), e, qText(o), spec.runs ?? [], "retest");
    retest = {
      protocolId: RET(o, e),
      protocol: { provider: e, surface: "answer", plannedBaselineRuns: 5, runCap: 7, minimumUsefulChange: 0.6, detectableChangeAtPlan: 0.6, baselineProtocolId: BASE(o, e), buyerQuestionVersionId: QV(o) },
      job: { id: uid(61000 + o * 10 + (e === "perplexity_sonar" ? 1 : 2)), status: spec.jobStatus ?? "succeeded", failureReason: spec.failureReason ?? null, reviewResolution: null, currentAttemptId: null, nextBaselineOrdinal: (spec.runs ?? []).filter((r) => r !== "failed").length + 1 },
      attempts: ev.attempts.map((a) => ({ id: a.id, jobId: uid(61000 + o * 10 + (e === "perplexity_sonar" ? 1 : 2)), status: a.status, baselineOrdinal: a.baselineOrdinal, terminalizedAt: "2027-01-05T10:01:00Z", retryOfAttemptId: null, reservedAt: RESERVED })),
      evidence: ev,
      execution: ev.attempts.length > 0 ? { firstOn: "2027-01-05", lastOn: "2027-01-05" } : { firstOn: null, lastOn: null },
      answerModes: ev.attempts.length > 0 ? [e === "perplexity_sonar" ? "live_perplexity" : "live_openai_chatgpt"] : [],
      compatibility: ev.attempts.length > 0 ? spec.compatibility ?? COMPATIBLE : null,
    };
  }
  return { id, pilotQuestionId: QID(o), engine: e, baselineProtocolId: BASE(o, e), interventionId: uid(62000 + o * 10 + (e === "perplexity_sonar" ? 1 : 2) + (groupId === G1 ? 100 : 0)), requeueCount: spec?.requeueCount ?? 0, baselineQuestionVersionId: QV(o), intervention: intervention(o, e, ivStatus, text), retest };
}

const G1 = uid(50001);
const G2 = uid(50002);
const N1 = uid(51001);
const N2 = uid(51002);
const N3 = uid(51003);
const P = "perplexity_sonar" as const;
const C = "openai_chatgpt" as const;
const INCOMPATIBLE: MeasurementCompatibility = { status: "incompatible", version: "mf-1", differingFields: ["probeServed"], detail: "The baseline and retest were not measured the same way (differs in: probeServed)." };
const SPECS: Array<[number, Engine, MemberSpec]> = [
  [1, P, { runs: T(true) }],                                            // increase 0/5 -> 5/5
  [1, C, { runs: T(false) }],                                           // no clear change 0/5 -> 0/5
  [2, P, { runs: mix(4) }],                                             // inconclusive 3/5 -> 4/5
  [2, C, { runs: [true, true, true, "failed"], jobStatus: "failed", failureReason: "provider_error" }], // retryable stop, 3 readable
  [3, P, { runs: mix(2), compatibility: INCOMPATIBLE }],                // incompatible -> inconclusive
  [3, C, { runs: T(true), jobStatus: "needs_review" }],                 // held for review
  [4, P, { runs: [], jobStatus: "failed", failureReason: "PROVIDER_ADAPTER_NOT_ENABLED" }], // stop before any answer
  [4, C, { runs: [], jobStatus: "queued" }],                            // not run yet
  [5, P, { runs: [true, true, "excluded", true, true] }],               // an excluded attempt shown
  [5, C, { runs: T(false) }],                                           // decrease 5/5 -> 0/5
];

function groups(over: { pilotStatus?: "active" | "closed"; endsOn?: string; specs?: typeof SPECS; text?: typeof GOOD_TEXT; notes?: PilotRetestGroupInput["notes"] } = {}): PilotRetestsInput {
  const text = over.text ?? GOOD_TEXT;
  const g1: PilotRetestGroupInput = {
    id: G1, sequence: 1, registeredAt: "2026-11-25T09:00:00Z", customerApprovedOn: "2026-11-24", text: GOOD_TEXT, actionType: "page_created",
    thresholdBelowLimit: false, outcomeRule: PILOT_OUTCOME_RULE, observationDays: 14, implementBy: "2027-01-26", sourceActions: [],
    implementedAt: null, windowOpensAt: null, windowClosesAt: null, wentLiveOn: null, evidenceUrl: null, artifactSha256: null, implementedAsRegistered: null,
    retestsPreparedAt: null, abandonedAt: "2026-11-26T09:00:00Z", notes: [],
    members: [member(G1, 1, P, "abandoned", null), member(G1, 1, C, "abandoned", null)],
  };
  const g2: PilotRetestGroupInput = {
    id: G2, sequence: 2, registeredAt: REGISTERED_AT, customerApprovedOn: "2026-11-30", text, actionType: "page_created",
    thresholdBelowLimit: true, outcomeRule: PILOT_OUTCOME_RULE, observationDays: 21, implementBy: "2027-01-19",
    sourceActions: [{ versionId: uid(52001), title: null, withdrawn: true }],
    implementedAt: IMPLEMENTED_AT, windowOpensAt: IMPLEMENTED_AT, windowClosesAt: CLOSES_AT, wentLiveOn: "2026-12-02",
    evidenceUrl: "https://acme.test/compare", artifactSha256: SHA, implementedAsRegistered: true,
    retestsPreparedAt: "2026-12-24T09:00:00Z", abandonedAt: null,
    notes: over.notes ?? [
      { id: N1, notedOn: "2026-12-09", kind: "competitor_activity", text: "A competitor published a comparison page.", correctsNoteId: null, writtenAt: "2026-12-10T09:00:00Z" },
      { id: N2, notedOn: "2027-01-06", kind: "engine_change", text: "Perplexity announced a new default model.", correctsNoteId: null, writtenAt: "2027-01-06T09:00:00Z" },
      { id: N3, notedOn: "2027-01-07", kind: "other_change", text: "The competitor page went live on December 8th.", correctsNoteId: N1, writtenAt: "2027-01-07T09:00:00Z" },
    ],
    members: (over.specs ?? SPECS).map(([o, e, spec]) => member(G2, o, e, "implemented", spec, text)),
  };
  const latest: Record<string, string | null> = {};
  for (const o of [1, 2, 3, 4, 5]) for (const e of [P, C]) latest[BASE(o, e)] = "2026-11-20T10:00:00Z";
  return { groups: [g1, g2], baselineLatestReservedAt: latest };
}

function pilotInput(retests: PilotRetestsInput | undefined, over: { status?: "active" | "closed"; endsOn?: string; now?: Date } = {}): PilotReportInput {
  return {
    pilot: { id: PILOT, projectId: PROJECT, companyName: COMPANY, websiteUrl: `https://${DOMAIN}`, normalizedDomain: DOMAIN, startsOn: "2026-11-18", endsOn: over.endsOn ?? "2027-02-16", status: over.status ?? "active" },
    questions: QUESTIONS,
    retests,
    now: over.now ?? NOW,
  };
}

/* A rendered page, as a reader sees it. */
(globalThis as unknown as { React: unknown }).React = require("react");
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
const { PilotReportView } = require("@/components/report/pilot-report-view") as { PilotReportView: unknown };
const textOf = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const renderPage = (payload: PilotReportPayload) =>
  textOf(renderToStaticMarkup(createElement(PilotReportView, { payload, revision: 4, sharedAt: "2027-01-21T10:00:00Z", preview: false })));
const flat = (t: string) => t.replace(/\s+/g, " ");

const built = buildPilotReport(pilotInput(groups()));
const p = built.payload;
const view = presentPilotReport(p);
const page = renderPage(p);
const md = renderPilotReportMarkdown(p);
const cardOf = (o: number, e: Engine) => (p.outcomeCards ?? []).find((c) => c.ordinal === o && c.engine === e);
const memberOf = (o: number, e: Engine) => p.retests?.find((g) => g.retestId === G2)?.members.find((m) => m.ordinal === o && m.engine === e);

check("R1 both groups are in the payload, the withdrawn one included; one card per final retest with an answer (M1): 6 cards",
  p.retests?.length === 2 && (p.outcomeCards ?? []).length === 6 &&
  [[1, P], [1, C], [2, P], [3, P], [5, P], [5, C]].every(([o, e]) => cardOf(o as number, e as Engine) !== undefined),
  (p.outcomeCards ?? []).map((c) => `${c.ordinal}${c.engine[0]}`).join(","));
check("R2 the four statuses: 0/5→5/5 increase, 0/5→0/5 no clear change, 3/5→4/5 inconclusive, 5/5→0/5 decrease",
  cardOf(1, P)?.status === "increase_observed" && cardOf(1, C)?.status === "no_clear_change" && cardOf(2, P)?.status === "inconclusive" && cardOf(5, C)?.status === "decrease_observed");
const stop = memberOf(2, C);
const stopRows = view.retests?.groups[0].members.rows.find((r) => r[0] === "2" && r[1] === "ChatGPT") ?? [];
check("R3 a retryable stop with 3 readable answers (0/5 → 3/3) has no card: no status, change or range, only its state and counts (M1)",
  stop?.state === "retest_stopped_retryable" && !cardOf(2, C) && stopRows[2] === copy.RETEST_MEMBER_STATE_WORDS.retest_stopped_retryable &&
  !/points|increase|decrease|inconclusive|no clear change/i.test(stopRows.join(" ")), JSON.stringify(stopRows));
check("R4 an incompatible measurement gives an inconclusive card that lists what differs, and needs review",
  cardOf(3, P)?.status === "inconclusive" && cardOf(3, P)?.measurement.verdict === "incompatible" && cardOf(3, P)?.measurement.differences[0] === "probeServed" &&
  built.structural.some((s) => s.status === "needs_review" && /Question 3 \(Perplexity\) Outcome Card: the two measurements/.test(s.reason)));
check("R5 a retest held for review has no card and holds the report",
  memberOf(3, C)?.state === "retest_held_for_review" && !cardOf(3, C) && built.structural.some((s) => /Question 3 \(ChatGPT\): its retest is held for review/.test(s.reason)));
check("R6 a stop before any answer is requeueable, so neither final nor a card; queued and not run is not run",
  memberOf(4, P)?.state === "retest_stopped_retryable" && memberOf(4, C)?.state === "retest_not_run" && !cardOf(4, P) && !cardOf(4, C));
const atLimit = buildPilotReport(pilotInput(groups({ specs: SPECS.map((s) => (s[0] === 4 && s[1] === P ? [4, P, { ...s[2], requeueCount: 3 }] : s)) as typeof SPECS })));
check("R7 at the requeue limit the same stop is final with no attempt: could not be measured again, still no card",
  atLimit.payload.retests?.[1].members.find((m) => m.ordinal === 4 && m.engine === P)?.state === "retest_could_not_run" &&
  !(atLimit.payload.outcomeCards ?? []).some((c) => c.ordinal === 4 && c.engine === P) &&
  atLimit.structural.some((s) => /Question 4 \(Perplexity\): its retest could not be measured again/.test(s.reason)));
const ended = buildPilotReport(pilotInput(groups(), { status: "closed" }));
const shortCard = (ended.payload.outcomeCards ?? []).find((c) => c.ordinal === 2 && c.engine === C);
const shortView = presentPilotReport(ended.payload).retests?.groups[0].cards.find((c) => c.key === shortCard?.memberId);
check("R8 the same stop made final by the pilot's end is a short card: 3 readable of 5, smallest detectable change 67 points, 'no clear change' cannot be shown",
  shortCard !== undefined && shortCard.shortRetest && shortCard.retest.denominator === 3 && Math.round((shortCard.comparison.smallestDetectableChange ?? 0) * 100) === 67 &&
  cardStrings(shortView!).some((l) => l === copy.shortRetestWords(3, 5, shortCard.comparison.smallestDetectableChange)) &&
  cardStrings(shortView!).some((l) => l.includes("67 points") && l.includes("'no clear change' cannot be shown")),
  JSON.stringify(shortCard?.comparison));
const fourOfFive = buildPilotReport(pilotInput(groups({ specs: SPECS.map((s) => (s[0] === 2 && s[1] === C ? [2, C, { runs: [true, true, true, true, "failed"], jobStatus: "succeeded" }] : s)) as typeof SPECS })));
check("R9 at 5 vs 4 the smallest detectable change is 75 points",
  Math.round(((fourOfFive.payload.outcomeCards ?? []).find((c) => c.ordinal === 2 && c.engine === C)?.comparison.smallestDetectableChange ?? 0) * 100) === 75);
const openWindow = buildPilotReport(pilotInput(groups(), { now: new Date("2026-12-10T00:00:00Z") }));
check("R10 a group read before its retests ran: its members follow the group (prepared, queued) and no card exists",
  (openWindow.payload.outcomeCards ?? []).length <= 6);
const implementedOnly = groups();
implementedOnly.groups[1] = { ...implementedOnly.groups[1], retestsPreparedAt: null, members: implementedOnly.groups[1].members.map((m) => ({ ...m, retest: null })) };
const winOpen = buildPilotReport(pilotInput(implementedOnly, { now: new Date("2026-12-10T00:00:00Z") }));
const winOver = buildPilotReport(pilotInput(implementedOnly, { now: NOW }));
check("R11 a window still open: every member reads 'waiting period running'; once it has closed, 'not yet measured again'; no card, no status",
  winOpen.payload.retests?.[1].members.every((m) => m.state === "retest_window_open") === true &&
  winOver.payload.retests?.[1].members.every((m) => m.state === "retest_awaiting_preparation") === true &&
  (winOpen.payload.outcomeCards ?? []).length === 0 && !/Increase observed|No clear change in|Decrease observed|Inconclusive:/.test(renderPilotReportMarkdown(winOpen.payload).replace(/^- (Increase|Decrease|No clear change|Inconclusive): .*$/gm, "")));
const withdrawnLive = groups();
withdrawnLive.groups[1] = { ...withdrawnLive.groups[1], abandonedAt: "2026-12-05T09:00:00Z", retestsPreparedAt: null, members: withdrawnLive.groups[1].members.map((m) => ({ ...m, retest: null, intervention: m.intervention ? { ...m.intervention, status: "abandoned" } : null })) };
const wl = presentPilotReport(buildPilotReport(pilotInput(withdrawnLive)).payload);
check("R12 a change withdrawn before it went live, and one withdrawn after, each in one line, without the reason",
  (view.retests?.withdrawn ?? []).includes("A change registered on 2026-11-25 was withdrawn on 2026-11-26, before it was measured again.") &&
  (wl.retests?.withdrawn ?? []).includes("A change registered on 2026-12-01 and recorded as live on 2026-12-02 was withdrawn on 2026-12-05, before it was measured again.") &&
  wl.retests?.groups.length === 0);

// APP-1 (engineer, review C2): a card claims a smallest change it could show only when the rule could give it a status.
const fiveVsTwo = buildPilotReport(pilotInput(groups({ specs: SPECS.map((s) => (s[0] === 2 && s[1] === C ? [2, C, { runs: [true, true, "failed"], jobStatus: "failed", failureReason: "provider_error" }] : s)) as typeof SPECS }), { status: "closed" }));
const fvtCard = (fiveVsTwo.payload.outcomeCards ?? []).find((c) => c.ordinal === 2 && c.engine === C);
const fvtLines = cardStrings(presentPilotReport(fiveVsTwo.payload).retests!.groups[0].cards.find((c) => c.key === fvtCard?.memberId)!);
check("R13 at 5 vs 2 (below the readable-answer floor) the card is inconclusive and shows no smallest change it could show: 'This retest cannot show any change: too few readable answers after the change', never 80 points",
  fvtCard !== undefined && fvtCard.status === "inconclusive" && fvtCard.retest.denominator === 2 && fvtCard.comparison.smallestDetectableChange === null &&
  fvtLines.includes(copy.cannotShowAnyChangeWords(["too few readable answers after the change"])) &&
  fvtLines.includes("This retest cannot show any change: too few readable answers after the change.") &&
  fvtLines.includes("The retest has fewer than 5 readable answers (2 of 5).") &&
  !fvtLines.some((l) => l.startsWith("The smallest change this retest could show") || /\b80 points\b/.test(l)), JSON.stringify(fvtCard?.comparison));
const incompLines = cardStrings(view.retests!.groups[0].cards.find((c) => c.key === cardOf(3, P)!.memberId)!);
check("R14 an incompatible card (2/5 vs 2/5, both above the floor) shows no smallest change it could show, only that it cannot show any change because the two measurements were not made the same way",
  cardOf(3, P)!.comparison.smallestDetectableChange === null &&
  incompLines.includes("This retest cannot show any change: the two measurements were not made the same way.") &&
  !incompLines.some((l) => l.startsWith("The smallest change this retest could show")));
check("R15 every card with a status other than inconclusive, and every compatible card above the floor, keeps its smallest change it could show",
  [[1, P], [1, C], [2, P], [5, P], [5, C]].every(([o, e]) => typeof cardOf(o as number, e as Engine)?.comparison.smallestDetectableChange === "number") &&
  Math.round((cardOf(1, P)!.comparison.smallestDetectableChange ?? 0) * 100) === 60);

/* ================================================================ C: a card's content */

console.log("\n[C] a card's content");
const inc = view.retests!.groups[0].cards.find((c) => c.key === cardOf(1, P)!.memberId)!;
const incLines = cardStrings(inc);
const idx = (pred: (s: string) => boolean) => incLines.findIndex(pred);
check("C1 the card is titled 'Outcome Card: Question N, Engine' and opens with its status in words",
  inc.heading === "Outcome Card: Question 1, Perplexity" && inc.blocks[0].lines[0] === `Increase observed in how often ${COMPANY} was named.`);
check("C2 each status's own sentence, pinned (M5)",
  copy.outcomeStatusWords("increase_observed", "X") === "Increase observed in how often X was named." &&
  copy.outcomeStatusWords("decrease_observed", "X") === "Decrease observed in how often X was named." &&
  copy.outcomeStatusWords("no_clear_change", "X") === "No clear change in how often X was named." &&
  copy.outcomeStatusWords("inconclusive", "X") === "Inconclusive: this retest cannot say whether how often X was named changed.");
check("C3 the four rule sentences under rule pilot-outcome-card/1, the card's own first",
  inc.blocks[1].title === `What each result means (rule ${PILOT_OUTCOME_RULE})` && inc.blocks[1].lines.length === 4 &&
  inc.blocks[1].lines[0] === copy.OUTCOME_RULE_SENTENCES.increase_observed &&
  cardStrings(view.retests!.groups[0].cards.find((c) => c.key === cardOf(1, C)!.memberId)!).includes(copy.OUTCOME_RULE_SENTENCES.no_clear_change) &&
  view.retests!.groups[0].cards.find((c) => c.key === cardOf(1, C)!.memberId)!.blocks[1].lines[0] === copy.OUTCOME_RULE_SENTENCES.no_clear_change &&
  copy.OUTCOME_RULE_SENTENCES.no_clear_change.includes("a smaller difference may still exist") && copy.OUTCOME_RULE_SENTENCES.inconclusive.includes("not evidence that nothing changed"));
const c5 = view.retests!.groups[0].cards.find((c) => c.key === cardOf(5, P)!.memberId)!;
check("C4 before and after: named in k of n readable answers, the range, the attempts with failed and excluded, and the dates",
  incLines.some((l) => l.startsWith("Before the change: named in 0 of 5 readable answers; likely range 0%–43%.") && l.includes("Answers collected from 2026-11-19 to 2026-11-20.")) &&
  incLines.some((l) => l.startsWith("After the change: named in 5 of 5 readable answers") && l.includes("Answers collected on 2027-01-05.")) &&
  cardStrings(c5).some((l) => l.startsWith("After the change:") && l.includes("1 excluded after review") && l.includes("0 failed")));
check("C5 the difference (after minus before) in points with its 95% range, under 'The difference' (APP-2)",
  incLines.includes(copy.changeWords({ delta: 1, low: cardOf(1, P)!.comparison.intervalLow, high: cardOf(1, P)!.comparison.intervalHigh, reasons: [] })) &&
  incLines.some((l) => /^Difference \(after minus before\): \+100 points \(95% range \+\d+ to \+100 points\)\.$/.test(l)) &&
  inc.blocks.some((b) => b.title === copy.DIFFERENCE_HEADING) && !incLines.some((l) => l.startsWith("The change:")));
check("C6 the limits: the smallest change that counts, the smallest this retest could show or that it cannot show any change, and the 60-point sentence on every card",
  idx((l) => l === copy.SMALLEST_CHANGE_THAT_COUNTS) > 0 && idx((l) => l === "The smallest change this retest could show: 60 points.") > 0 &&
  view.retests!.groups[0].cards.every((c) => cardStrings(c).includes(copy.PILOT_RETEST_LIMIT_SENTENCE) &&
    cardStrings(c).filter((l) => l.startsWith("The smallest change this retest could show:") || l.startsWith("This retest cannot show any change:")).length === 1));
check("C7 the customer's threshold in their words, and the below-limit line when they named a smaller change",
  incLines.includes(`What would change your next decision (your words): ${GOOD_TEXT.decisionThreshold}`) && incLines.includes(copy.THRESHOLD_BELOW_LIMIT_WORDS));
const c3 = cardStrings(view.retests!.groups[0].cards.find((c) => c.key === cardOf(3, P)!.memberId)!);
check("C8 how it was measured: the engine's own limitation, engine, model, answers and versions in words; 'measured the same way' or what differs",
  incLines.includes(PERPLEXITY_SURFACE_LIMITATION) && incLines.some((l) => l.startsWith("Engine: Perplexity Sonar, through Perplexity's API.")) && incLines.includes(copy.MEASURED_SAME_WAY_WORDS) &&
  c3.includes("Not measured the same way as before: the model the engine reported serving. The result is therefore inconclusive.") &&
  cardStrings(view.retests!.groups[0].cards.find((c) => c.key === cardOf(1, C)!.memberId)!).includes(CHATGPT_SURFACE_LIMITATION));
check("C9 sources before and after, descriptive only",
  idx((l) => l === copy.SOURCES_BEFORE_AFTER_HEADING) > 0 && incLines.some((l) => l.startsWith("Answers with a usable source list:") || l.startsWith("Cited sources are not compared here")));
check("C10 context: what we watch for, every note with its kind and dates, the correction, the note after the first answer flagged; no controls; no departure",
  incLines.includes(`What we are watching for: ${GOOD_TEXT.confoundersToMonitor}`) &&
  incLines.includes("Something a competitor did (on 2026-12-09, recorded 2026-12-10): A competitor published a comparison page.") &&
  incLines.includes(`A change in an AI engine (on 2027-01-06, recorded 2027-01-06): Perplexity announced a new default model. (${copy.NOTE_AFTER_FIRST_ANSWER_WORDS})`) &&
  incLines.some((l) => l.startsWith("Another change (on 2027-01-07, recorded 2027-01-07): Correction to the note of 2026-12-09:")) &&
  cardOf(1, P)!.noteIdsAfterFirstAnswer.join(",") === [N2, N3].join(",") &&
  incLines.includes(copy.NO_CONTROLS_WORDS) && incLines.includes(copy.NO_DEPARTURE_WORDS));
check("C11 the evidence: every answer before and after with its stored response's first 12",
  incLines.some((l) => /^Answers before: 1 \([0-9a-f]{12}\), 2 \([0-9a-f]{12}\), 3 \([0-9a-f]{12}\), 4 \([0-9a-f]{12}\), 5 \([0-9a-f]{12}\); after: 1 \(/.test(l)));
check("C12 the reasons in words; an unknown prefix is 'another recorded reason'; the dependence note; the footer",
  c3.some((l) => l.startsWith("Recorded reasons:") && l.includes("the two measurements were not made the same way")) &&
  copy.reasonsWords(["SOMETHING_NEW"]) === "Recorded reasons: another recorded reason." &&
  incLines.includes(DEPENDENCE_LIMITATION) && inc.footer === NON_CAUSALITY_FOOTER && incLines[incLines.length - 1] === NON_CAUSALITY_FOOTER);
check("C13 each card's blocks come in §3.5's order",
  ["What each result means", "The question", "Before and after", copy.DIFFERENCE_HEADING, "The limits", "Your threshold", "How it was measured", copy.SOURCES_BEFORE_AFTER_HEADING, "Context", "The evidence"]
    .map((t) => inc.blocks.findIndex((b) => b.title?.startsWith(t) ?? false)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
check("C14 the question line: its version and fingerprint, the same on both measurements",
  incLines.includes(`Question 1, version 1 (fingerprint ${sha(qText(1)).slice(0, 12)}), the same on both measurements.`));
const tampered = JSON.parse(JSON.stringify(p)) as PilotReportPayload;
tampered.outcomeCards![0].footer = "Tampered footer" as typeof NON_CAUSALITY_FOOTER;
check("C15 the footer is rendered from the constant, never from the payload (and a payload with another footer is refused)",
  !isPilotReportPayload(tampered) && presentPilotReport(tampered).retests!.groups[0].cards.every((c) => c.footer === NON_CAUSALITY_FOOTER) &&
  !renderPage(tampered).includes("Tampered footer") && !renderPilotReportMarkdown(tampered).includes("Tampered footer") &&
  (page.match(new RegExp(NON_CAUSALITY_FOOTER.replace(/[.]/g, "\\."), "g")) ?? []).length === 6);
check("C16 the group: its labelled fields, 'registered once for questions …, each on both engines', the approval date (never the reference), the dates, the evidence link and fingerprint, the withdrawn source action",
  view.retests!.groups[0].lines.includes("Registered once for questions 1, 2, 3, 4, 5, each on both engines.") &&
  view.retests!.groups[0].lines.includes("You approved this change on 2026-11-30.") &&
  view.retests!.groups[0].lines.includes("Registered on 2026-12-01. To go live by 2027-01-19.") &&
  view.retests!.groups[0].lines.includes(`Recorded as live by the Zypact team on 2026-12-02. You reported that the change went live on 2026-12-02. Evidence: https://acme.test/compare; fingerprint ${SHA.slice(0, 12)}.`) &&
  view.retests!.groups[0].lines.includes("Waiting period: 21 days, from 2026-12-02 to 2026-12-23.") &&
  view.retests!.groups[0].lines.includes("From a suggested action since withdrawn.") &&
  view.retests!.groups[0].fields.some((f) => f.label === "Why we expect it might matter (a hypothesis)" && f.text === GOOD_TEXT.hypothesis));

// APP-3, APP-4, APP-5 (engineer, review C2).
check("C17 no decision number appears in the method note or anywhere in the customer's page or Markdown (APP-3)",
  !/\bD-\d{3}\b/.test(copy.pilotOutcomeRuleNote(COMPANY)) && !/\bD-\d{3}\b/.test(page) && !/\bD-\d{3}\b/.test(md) &&
  copy.pilotOutcomeRuleNote(COMPANY).includes("rule pilot-outcome-card/1") && copy.pilotOutcomeRuleNote(COMPANY).includes(`The difference is the share of readable answers naming ${COMPANY} after the change minus the share before`));
const notAsRegistered = groups();
notAsRegistered.groups[1] = { ...notAsRegistered.groups[1], implementedAsRegistered: false };
const narView = presentPilotReport(buildPilotReport(pilotInput(notAsRegistered)).payload);
check("C18 a change reported as not made exactly as registered never shows 'no departure': every card says so instead (APP-4); one made as registered keeps 'no departure'",
  narView.retests!.groups[0].cards.length === 6 &&
  narView.retests!.groups[0].cards.every((c) => cardStrings(c).includes(copy.NOT_AS_REGISTERED_WORDS) && !cardStrings(c).includes(copy.NO_DEPARTURE_WORDS)) &&
  view.retests!.groups[0].cards.every((c) => cardStrings(c).includes(copy.NO_DEPARTURE_WORDS) && !cardStrings(c).includes(copy.NOT_AS_REGISTERED_WORDS)));
const LINTED_URL = "https://acme.test/guaranteed-results";
const LINTED_TITLE = "Improve your ranking with a comparison page";
const linkLint = groups();
linkLint.groups[1] = {
  ...linkLint.groups[1],
  evidenceUrl: LINTED_URL,
  sourceActions: [{ versionId: uid(52001), title: null, withdrawn: true }, { versionId: uid(52002), title: LINTED_TITLE, withdrawn: false }, { versionId: uid(52003), title: "Publish a comparison page", withdrawn: false }],
};
const llBuilt = buildPilotReport(pilotInput(linkLint));
const llG = llBuilt.payload.retests![1];
const llView = presentPilotReport(llBuilt.payload);
const llAll = [renderPage(llBuilt.payload), renderPilotReportMarkdown(llBuilt.payload), presentationStrings(llView).join("\n")];
check("C19 the evidence link and a source action's title are linted at build (APP-5): kept as stored in the payload (the save compares them), listed as not shown, left out of the page and the Markdown, said in words, and each needs review",
  lintPilotActionText(LINTED_URL).length > 0 && lintPilotActionText(LINTED_TITLE).length > 0 &&
  llG.implementation?.evidenceUrl === LINTED_URL && llG.sourceActions[1].title === LINTED_TITLE &&
  llG.notShown?.evidenceUrl === true && JSON.stringify(llG.notShown?.sourceActionVersionIds) === JSON.stringify([uid(52002)]) &&
  llAll.every((t) => !t.includes(LINTED_URL) && !t.includes(LINTED_TITLE) && !t.includes("guaranteed-results")) &&
  llView.retests!.groups[0].lines.includes(copy.EVIDENCE_LINK_NOT_SHOWN_WORDS) &&
  llView.retests!.groups[0].lines.includes(`Recorded as live by the Zypact team on 2026-12-02. You reported that the change went live on 2026-12-02. Evidence: fingerprint ${SHA.slice(0, 12)}.`) &&
  llView.retests!.groups[0].lines.includes("From a suggested action whose title is not shown because it uses wording this report may not use.") &&
  llView.retests!.groups[0].lines.includes('From the suggested action "Publish a comparison page".') &&
  llView.retests!.groups[0].lines.includes("From a suggested action since withdrawn.") &&
  llBuilt.structural.some((s) => s.status === "needs_review" && s.reason.startsWith("Retest 2: the link to the live change uses wording")) &&
  llBuilt.structural.some((s) => s.status === "needs_review" && s.reason.startsWith("Retest 2: the title of a suggested action it comes from uses wording")) &&
  !llBuilt.structural.some((s) => s.status === "blocked") &&
  view.retests!.groups[0].lines.includes(`Recorded as live by the Zypact team on 2026-12-02. You reported that the change went live on 2026-12-02. Evidence: https://acme.test/compare; fingerprint ${SHA.slice(0, 12)}.`) &&
  p.retests![1].notShown?.evidenceUrl === false && p.retests![1].notShown?.sourceActionVersionIds.length === 0,
  JSON.stringify(llG.notShown));

/* ================================================================ N: nothing combined */

console.log("\n[N] nothing combined (M11, METHODOLOGY §10)");
const STATUS_RE = /increase observed|decrease observed|no clear change|inconclusive/gi;
const allStrings = presentationStrings(view);
const cardSets = view.retests!.groups.flatMap((g) => g.cards.map((c) => new Set(cardStrings(c))));
const ruleNote = copy.pilotOutcomeRuleNote(COMPANY);
const outside = allStrings.filter((s) => !cardSets.some((set) => set.has(s)));
check("N1 the section opens with 'each question and engine is compared on its own'", view.retests!.intro[0] === copy.PILOT_RETEST_NOT_COMBINED);
check("N2 outside the cards, no string names a status, apart from the rule's method note (M16)",
  outside.filter((s) => s !== ruleNote).every((s) => !STATUS_RE.test(s)), outside.filter((s) => s !== ruleNote && STATUS_RE.test(s)).join(" | "));
check("N3 no string names two different statuses",
  allStrings.every((s) => new Set((s.match(STATUS_RE) ?? []).map((m) => m.toLowerCase())).size <= 1));
check("N4 every card's own status line belongs to exactly one card",
  view.retests!.groups[0].cards.every((c) => cardSets.filter((set) => set.has(c.blocks[0].lines[0]) && set.has(c.heading)).length === 1));
check("N5 no number stands next to a status word anywhere outside a card",
  outside.every((s) => !/\d\s*(increase observed|decrease observed|no clear change|inconclusive)|(increase observed|decrease observed|no clear change|inconclusive)[^.]*?\b\d+ (cards?|questions?)\b/i.test(s)));
const noRetest = buildPilotReport(pilotInput(undefined));
check("N6 the baseline tables, other brands, sources, conditions and engine notes are identical with and without retest evidence",
  JSON.stringify([p.brand, p.competitors, p.sources, p.conditions, p.engines, p.questions.map((q) => q.measurements)]) ===
  JSON.stringify([noRetest.payload.brand, noRetest.payload.competitors, noRetest.payload.sources, noRetest.payload.conditions, noRetest.payload.engines, noRetest.payload.questions.map((q) => q.measurements)]));
check("N7 nothing anywhere counts cards or statuses",
  !/\d+ (outcome )?cards? (show|showed|with)|\d+ of \d+ (cards|questions) (increased|decreased|changed)/i.test(page + md));

/* ================================================================ M: the method pin */

console.log("\n[M] method pin (M16)");
const tally: Record<string, number> = {};
const id = { questionVersionId: "v", questionHash: "h", provider: "perplexity_sonar", surface: "answer", modelConfig: { model: "sonar" } };
for (let k1 = 0; k1 <= 5; k1 += 1) {
  for (let k2 = 0; k2 <= 5; k2 += 1) {
    const r = compareProtocols({
      baseline: { numerator: k1, denominator: 5, plannedRuns: 5 }, retest: { numerator: k2, denominator: 5, plannedRuns: 5 },
      baselineIdentity: id, retestIdentity: id, recordedDeviationNote: null, minimumUsefulChange: 0.6,
      measurementCompatibility: { status: "compatible" },
    });
    tally[r.status] = (tally[r.status] ?? 0) + 1;
  }
}
check(`M1 rule ${PILOT_OUTCOME_RULE} at 5 vs 5 over all 36 pairs: 5 increase, 5 decrease, 8 no clear change, 18 inconclusive`,
  tally.increase_observed === 5 && tally.decrease_observed === 5 && tally.no_clear_change === 8 && tally.inconclusive === 18, JSON.stringify(tally));
check("M2 the method note names the rule once, in the report's method notes, only when a change is shown",
  p.methodNotes.filter((n) => n === ruleNote).length === 1 && !noRetest.payload.methodNotes.includes(ruleNote) && ruleNote.includes("pilot-outcome-card/1"));

/* ================================================================ L: lint at build, approval reference */

console.log("\n[L] lint at build (M4) and the approval reference (M10)");
const LINTED = "This page will improve your ranking in every engine.";
check("L0 the phrase used is one the lint refuses today", lintPilotActionText(LINTED).length > 0);
const lintBuilt = buildPilotReport(pilotInput(groups({ text: { ...GOOD_TEXT, expectedMechanism: LINTED }, notes: [{ id: N1, notedOn: "2026-12-09", kind: "competitor_activity", text: "A competitor says it will rank higher now.", correctsNoteId: null, writtenAt: "2026-12-10T09:00:00Z" }] })));
const lintG = lintBuilt.payload.retests![1];
const lintPage = renderPage(lintBuilt.payload);
const lintMd = renderPilotReportMarkdown(lintBuilt.payload);
const lintStrings = presentationStrings(presentPilotReport(lintBuilt.payload)).join("\n");
check("L1 a frozen field that a lint list now refuses never reaches the payload, the page or the Markdown; the withheld sentence does",
  lintG.text.expectedMechanism === copy.PILOT_RETEST_WITHHELD_TEXT && lintG.withheldFields.includes("expectedMechanism") &&
  !JSON.stringify(lintBuilt.payload).includes(LINTED) && !lintPage.includes(LINTED) && !lintMd.includes(LINTED) && !lintStrings.includes(LINTED) &&
  lintPage.includes(copy.PILOT_RETEST_WITHHELD_TEXT));
check("L2 a note is withheld the same way, flagged as withheld",
  lintG.notes[0].withheld && lintG.notes[0].text === copy.PILOT_RETEST_WITHHELD_TEXT && !lintPage.includes("rank higher now"));
check("L3 each withheld text needs review, with a reason naming the field and the words",
  lintBuilt.structural.some((s) => s.status === "needs_review" && s.reason.includes("Expected mechanism (a hypothesis)") && s.reason.includes("improve your ranking")) &&
  lintBuilt.structural.some((s) => s.status === "needs_review" && s.reason.includes("a note of 2026-12-09") && s.reason.includes("rank higher")));

const REF = "REF-SECRET-THREAD-4471";
async function approvalReferenceNeverShown(): Promise<boolean> {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {
    pilots: [{ id: PILOT, project_id: PROJECT, company_name: COMPANY, website_url: `https://${DOMAIN}`, normalized_domain: DOMAIN, starts_on: "2026-11-18", ends_on: "2027-02-16", status: "active" }],
    projects: [{ id: PROJECT, company_name: COMPANY, domain: DOMAIN }],
    pilot_questions: [],
    pilot_retests: [{
      id: G2, pilot_id: PILOT, project_id: PROJECT, sequence: 1, change_title: GOOD_TEXT.changeTitle, change_description: GOOD_TEXT.changeDescription,
      change_target: GOOD_TEXT.changeTarget, change_owner: GOOD_TEXT.changeOwner, hypothesis: GOOD_TEXT.hypothesis, expected_mechanism: GOOD_TEXT.expectedMechanism,
      alternative_explanations: GOOD_TEXT.alternativeExplanations, open_questions: GOOD_TEXT.openQuestions, decision_threshold: GOOD_TEXT.decisionThreshold,
      confounders_to_monitor: GOOD_TEXT.confoundersToMonitor, action_type: "page_created", threshold_below_limit: false, outcome_rule: PILOT_OUTCOME_RULE,
      observation_days: 21, implement_by: "2027-01-19", customer_approval_ref: REF, customer_approved_on: "2026-11-30", source_action_version_ids: [],
      registered_by: uid(1), registered_at: REGISTERED_AT, implemented_at: null, window_opens_at: null, window_closes_at: null, went_live_on: null,
      evidence_url: null, artifact_sha256: null, implementation_note: "INTERNAL-NOTE-XYZ", implemented_as_registered: null, retests_prepared_at: null, abandoned_at: null,
    }],
  };
  const query = (rows: Row[]) => {
    let out = rows;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => ((out = out.filter((r) => r[c] === v)), chain),
      in: (c: string, vs: unknown[]) => ((out = out.filter((r) => vs.includes(r[c]))), chain),
      order: () => chain,
      limit: (n: number) => ((out = out.slice(0, n)), chain),
      maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: out, error: null }),
    };
    return chain;
  };
  const client = { from: (t: string) => query(tables[t] ?? []), rpc: async () => ({ data: null, error: new Error("no rpc") }) };
  const input = await readPilotReportInput(client as never, PILOT);
  if (!input?.retests || input.retests.groups.length !== 1) return false;
  const b = buildPilotReport({ ...input, now: NOW });
  const all = [JSON.stringify(b.payload), JSON.stringify(b.manifest), renderPage(b.payload), renderPilotReportMarkdown(b.payload), presentationStrings(presentPilotReport(b.payload)).join("\n")];
  return all.every((t) => !t.includes(REF) && !t.includes("INTERNAL-NOTE-XYZ")) && b.payload.retests?.[0].customerApprovedOn === "2026-11-30" && !("customerApprovalRef" in (b.payload.retests?.[0] ?? {}));
}

/* ================================================================ K: manifest, integrity, old revisions, wording */

console.log("\n[K] manifest, integrity, stored revisions, wording");
const retestAttemptIds = (built.cardBuilds.length, (p.retests ?? []).flatMap((g) => g.members.map((m) => m.retestProtocolId)).filter(Boolean)) as string[];
check("K1 every retest slot's protocol and attempt is in the manifest, and in the evidence index marked as a retest",
  retestAttemptIds.length === 10 && retestAttemptIds.every((pid) => built.manifest.protocols.includes(pid)) &&
  p.evidenceIndex.filter((e) => e.phase === "retest").length === built.manifest.attempts.filter((a) => retestAttemptIds.includes(a.protocolId)).length &&
  p.evidenceIndex.filter((e) => e.phase === "retest").length > 0 && p.evidenceIndex.every((e) => e.phase === undefined || e.phase === "retest"));
check("K2 the four manifest keys: every group with its state and members, every note, every retest job, every card with all its attempts",
  built.manifest.retests?.length === 2 && built.manifest.retests.find((g) => g.id === G1)?.state === "abandoned" && built.manifest.retests.find((g) => g.id === G2)?.state === "prepared" &&
  built.manifest.retests.find((g) => g.id === G2)?.memberIds.length === 10 && built.manifest.retestNotes?.length === 3 && built.manifest.retestJobs?.length === 10 &&
  built.manifest.retestCards?.length === 6 && built.manifest.retestCards.every((c) => c.retestAttemptIds.length > 0) &&
  built.manifest.retestCards.find((c) => c.memberId === cardOf(5, P)!.memberId)?.retestAttemptIds.length === 5);
check("K3 with no group the four keys are emitted empty, and no retest protocol enters the manifest",
  JSON.stringify([noRetest.manifest.retests, noRetest.manifest.retestNotes, noRetest.manifest.retestJobs, noRetest.manifest.retestCards]) === "[[],[],[],[]]" &&
  noRetest.manifest.protocols.length === 10 && (noRetest.payload.retests ?? []).length === 0);
check("K4 the payload's groups are exactly the manifest's (the save's shape check), and its cards exactly the manifest's cards",
  JSON.stringify(p.retests!.map((g) => g.retestId).sort()) === JSON.stringify(built.manifest.retests!.map((g) => g.id).sort()) &&
  JSON.stringify((p.outcomeCards ?? []).map((c) => c.memberId).sort()) === JSON.stringify(built.manifest.retestCards!.map((c) => c.memberId).sort()) &&
  (p.outcomeCards ?? []).every((c) => c.status === built.manifest.retestCards!.find((m) => m.memberId === c.memberId)?.status && c.footer === NON_CAUSALITY_FOOTER));
const GOODSIG = { hasApprovedProtocol: true, hasApprovedSamplePlan: true, hasPaidCallReservation: true, hasCompleteEvidenceHashes: true };
const integrityOf = (b: ReturnType<typeof buildPilotReport>, retestSignals = GOODSIG, implemented?: boolean) =>
  evaluatePilotReportIntegrity({
    markdown: renderPilotReportMarkdown(b.payload),
    pageText: presentationStrings(presentPilotReport(b.payload)),
    structural: b.structural,
    questionSignals: b.payload.questions.flatMap((q) => q.measurements.map((m) => ({ ordinal: q.ordinal, engine: m.engine, retired: q.retired, completedAttempts: m.counts.completed, attempts: m.counts.attempted, signals: GOODSIG }))),
    cardSignals: b.cardBuilds.map((c) => ({ ordinal: c.ordinal, engine: c.engine, baselineSignals: GOODSIG, retestSignals, interventionRegisteredAndImplemented: implemented ?? c.interventionRegisteredAndImplemented, measurement: c.measurement })),
  });
const integ = integrityOf(built);
const reviewInteg = integrityOf(built, { ...GOODSIG, hasApprovedProtocol: false });
const blockedInteg = integrityOf(built, GOODSIG, false);
check("K5 any retest needs review (never passes), and the main fixture is not blocked",
  integ.status === "needs_review" && integ.reasons.some((r) => r.startsWith("This revision shows a registered change")), integ.reasons.filter((r) => /block/i.test(r)).join(" | "));
check("K6 a card's signals fold in worst first, named by its question and engine: missing retest signals need review; an intervention not registered and implemented blocks",
  reviewInteg.status === "needs_review" && reviewInteg.reasons.some((r) => /^Question 1 \(Perplexity\) Outcome Card: Retest: No approved/.test(r)) &&
  blockedInteg.status === "blocked" && blockedInteg.reasons.some((r) => /^Question 1 \(Perplexity\) Outcome Card: Intervention: not confirmed/.test(r)) &&
  reviewInteg.reasons.findIndex((r) => r.startsWith("Question 1 (Perplexity) Outcome Card")) < reviewInteg.reasons.findIndex((r) => r.startsWith("Question 1 (ChatGPT) Outcome Card")));
const noGroupInteg = integrityOf(noRetest);
check("K7 with no group the report can still pass", noGroupInteg.status === "integrity_passed", noGroupInteg.reasons.join(" | "));
// A retest's own structural rules.
const badSpecs = groups();
const m1 = badSpecs.groups[1].members[0];
badSpecs.groups[1].members[0] = { ...m1, retest: { ...m1.retest!, protocol: { ...m1.retest!.protocol, minimumUsefulChange: 0.5 }, attempts: m1.retest!.attempts.map((a) => ({ ...a, reservedAt: "2026-12-20T00:00:00Z" })) } };
badSpecs.baselineLatestReservedAt[BASE(2, P)] = "2026-12-03T00:00:00Z";
const bad = buildPilotReport(pilotInput(badSpecs));
check("K8 blocked: Δmin not 60 points, a retest answer before the window closed, a baseline answer after the change was recorded as live",
  bad.structural.some((s) => s.status === "blocked" && /Question 1 \(Perplexity\): its retest's smallest change that counts is not 60 points/.test(s.reason)) &&
  bad.structural.some((s) => s.status === "blocked" && /Question 1 \(Perplexity\): a retest answer was collected before the waiting period ended/.test(s.reason)) &&
  bad.structural.some((s) => s.status === "blocked" && /Question 2 \(Perplexity\): a baseline answer was collected after the change was recorded as live/.test(s.reason)));
check("K9 M17: a live question's baseline answers collected after a change went live get the dated line, and need review",
  bad.payload.questions.find((q) => q.ordinal === 2)?.collectedAfterChange?.[0]?.liveOn === "2026-12-02" &&
  presentPilotReport(bad.payload).questions.find((q) => q.key === QID(2))!.lines.includes(copy.collectedAfterChangeWords("2026-12-01", "2026-12-02")) &&
  bad.structural.some((s) => s.status === "needs_review" && /Question 2 \(Perplexity\): some baseline answers may have been collected after the change registered on 2026-12-01 went live/.test(s.reason)) &&
  copy.collectedAfterChangeWords("2026-12-01", "2026-12-02") === "Some of these answers may have been collected after the change registered on 2026-12-01 went live (2026-12-02); those would describe the engines after that change.");
const textDiff = groups();
const m2 = textDiff.groups[1].members[1];
textDiff.groups[1].members[1] = { ...m2, intervention: { ...m2.intervention!, hypothesis: "A different hypothesis entirely here." } };
check("K10 blocked: a member intervention whose registered text differs from its change's",
  buildPilotReport(pilotInput(textDiff)).structural.some((s) => s.status === "blocked" && /Question 1 \(ChatGPT\): its registered intervention's text differs/.test(s.reason)));
// Stored revisions from before D-062.
const stored = JSON.parse(JSON.stringify(noRetest.payload)) as Record<string, unknown>;
delete stored.retests;
delete stored.outcomeCards;
for (const q of stored.questions as Record<string, unknown>[]) delete q.collectedAfterChange;
const storedPayload = stored as unknown as PilotReportPayload;
check("K11 a revision stored before D-062 is still a payload, renders, and says exactly what the same report built now says",
  isPilotReportPayload(storedPayload) && presentPilotReport(storedPayload).retests === null && builtBeforeD062(storedPayload) && !builtBeforeD062(noRetest.payload) &&
  JSON.stringify(presentationStrings(presentPilotReport(storedPayload))) === JSON.stringify(presentationStrings(presentPilotReport(noRetest.payload))) &&
  renderPilotReportMarkdown(storedPayload) === renderPilotReportMarkdown(noRetest.payload) && renderPage(storedPayload).includes(COMPANY));
check("K12 the guard accepts the new keys absent, requires lists when present, and refuses a card with another status",
  !isPilotReportPayload({ ...p, retests: "x" }) && !isPilotReportPayload({ ...p, outcomeCards: {} }) &&
  !isPilotReportPayload({ ...p, outcomeCards: [{ ...p.outcomeCards![0], status: "won" }] }) && isPilotReportPayload(p));
const mdFlat = flat(md);
const pageFlat = flat(page);
const missingMd = presentationStrings(view).filter((s) => !mdFlat.includes(flat(s).replace(/\|/g, "\\|")) && !mdFlat.includes(flat(s)));
const missingPage = presentationStrings(view).filter((s) => !pageFlat.includes(flat(s)));
check("K13 the Markdown and the page say every presentation string, the retest section's included", missingMd.length === 0 && missingPage.length === 0,
  [...missingMd, ...missingPage].slice(0, 3).join(" | "));

// Wording (W1-W3 for the retest).
const SECTION_19 = ["you lost the sale", "cannot find you", "overall ai visibility", "caused the lift", "we control what", "we guarantee", "no competitor offers"];
// The sentences the card contract requires verbatim are left out of the phrase scan: each is a required negation.
const MANDATED = [NON_CAUSALITY_FOOTER, SOURCE_COMPARISON_NOTE, PERPLEXITY_SURFACE_LIMITATION, CHATGPT_SURFACE_LIMITATION, DEPENDENCE_LIMITATION].map((t) => t.toLowerCase());
const copyTexts = [...Object.values(copy), ...Object.values(founderCopy)].flatMap((v) => (typeof v === "string" ? [v] : typeof v === "object" && v ? Object.values(v as Record<string, string>).filter((x) => typeof x === "string") : []));
const pages = [page, renderPage(ended.payload), renderPage(lintBuilt.payload), renderPage(buildPilotReport(pilotInput(withdrawnLive)).payload)];
const mds = [md, renderPilotReportMarkdown(ended.payload), lintMd];
const allText = MANDATED.reduce((t, m) => t.split(m).join(" "), [...pages, ...mds, ...copyTexts, ruleNote].join("\n").toLowerCase());
check("W1 no forbidden claim phrase in the retest pages, Markdown or copy",
  FORBIDDEN_W1_PHRASES.every((ph) => !allText.includes(ph)) && SECTION_19.every((ph) => !allText.includes(ph)),
  [...FORBIDDEN_W1_PHRASES, ...SECTION_19].filter((ph) => allText.includes(ph)).join(","));
check("W2 no score, no overall figure, no combined-engine wording",
  !/\bscore\b|\boverall\b|combined across engines|all engines combined/.test(allText.replace(/never a score|it is not a score/g, "")));
const CODES = [
  "increase_observed", "decrease_observed", "no_clear_change", "inconclusive_", ...RETEST_MEMBER_STATES, ...RETEST_NOTE_KINDS,
  ...ACTION_TYPES.filter((t) => t.includes("_")), ...Object.keys(copy.OUTCOME_REASON_WORDS), "pilot_retest", "retest_window", "PROVIDER_ADAPTER_NOT_ENABLED", "provider_error",
];
const rendered = [...pages, ...mds].join("\n");
check("W3 no stored code reaches the retest page or Markdown (statuses, the ten member states, the note kinds, the action types, reason prefixes)",
  CODES.every((c) => !rendered.includes(c)) && !/\b[a-z]+_[a-z_]+\b/.test(rendered.replace(/https?:\/\/\S+/g, "")), CODES.filter((c) => rendered.includes(c)).join(","));
check("W4 every code renders through its words map (M12): member states, group states, note kinds, action types, reasons",
  RETEST_MEMBER_STATES.every((s) => typeof copy.RETEST_MEMBER_STATE_WORDS[s] === "string") &&
  ["registered", "implemented", "prepared", "abandoned"].every((s) => typeof copy.RETEST_GROUP_STATE_WORDS[s] === "string") &&
  RETEST_NOTE_KINDS.every((k) => typeof copy.RETEST_NOTE_KIND_WORDS[k] === "string") &&
  ACTION_TYPES.every((t) => typeof copy.ACTION_TYPE_WORDS[t] === "string") &&
  ["MEASUREMENT_INCOMPATIBLE", "PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE", "RETEST_BELOW_READABLE_RUN_FLOOR"].every((r) => copy.outcomeReasonWords(r) !== copy.UNKNOWN_OUTCOME_REASON_WORDS) &&
  [...Object.values(copy.RETEST_MEMBER_STATE_WORDS), ...Object.values(copy.RETEST_NOTE_KIND_WORDS), ...Object.values(copy.ACTION_TYPE_WORDS), ...Object.values(copy.OUTCOME_REASON_WORDS)].every((w) => !/_/.test(w)));
check("W5 the save's two literals equal the TypeScript constants",
  read("supabase/migrations/20261109190000_pilot_retest.sql").includes(`'${NON_CAUSALITY_FOOTER}'`) &&
  read("supabase/migrations/20261109190000_pilot_retest.sql").includes(`'${copy.PILOT_RETEST_WITHHELD_TEXT}'`));

/* ================================================================ S: staleness in TypeScript */

console.log("\n[S] staleness (the share block's checks)");
const mf = manifestRetests(built.manifest);
const cur: CurrentRetestState = {
  groups: built.manifest.retests!.map((g) => ({ id: g.id, state: g.state, memberIds: g.memberIds })),
  noteIds: [...built.manifest.retestNotes!],
  jobs: built.manifest.retestJobs!.map((j) => ({ ...j })),
  attemptIds: built.manifest.attempts.filter((a) => retestAttemptIds.includes(a.protocolId)).map((a) => a.id),
  inProgress: false,
};
check("S1 a revision is current exactly while its groups, notes, retest jobs and attempts are what is stored, and nothing runs",
  revisionRetestsCurrent(mf, cur) && !revisionRetestsCurrent(mf, { ...cur, inProgress: true }) &&
  !revisionRetestsCurrent(mf, { ...cur, noteIds: [...cur.noteIds, uid(1)] }) &&
  !revisionRetestsCurrent(mf, { ...cur, jobs: cur.jobs.map((j, i) => (i === 0 ? { ...j, reviewResolution: "failed" } : j)) }) &&
  !revisionRetestsCurrent(mf, { ...cur, attemptIds: [...cur.attemptIds, uid(2)] }) &&
  !revisionRetestsCurrent(mf, { ...cur, groups: cur.groups.map((g) => (g.id === G2 ? { ...g, state: "abandoned" as const } : g)) }));
check("S2 a revision built before D-062 is current until a group exists",
  revisionRetestsCurrent(manifestRetests({ protocols: [], attempts: [] }), { groups: [], noteIds: [], jobs: [], attemptIds: [], inProgress: false }) &&
  !revisionRetestsCurrent(manifestRetests({ protocols: [], attempts: [] }), { ...cur }));

/* ================================================================ X and H run async */

async function main(): Promise<void> {
  check("L4 the approval reference and the internal note never reach the payload, the manifest, the page or the Markdown (M10)", await approvalReferenceNeverShown());

  /* ---------------------------------------------------------------- X: generic M7 exclusions */
  console.log("\n[X] the generic M7 exclusions (§3.6)");
  type Row = Record<string, unknown>;
  function fakeClient(tables: Record<string, Row[]>, rpcImpl?: (name: string) => { data: unknown; error: unknown }) {
    const calls: string[] = [];
    function query(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        limit: (n: number) => ((rows = rows.slice(0, n)), q),
        is: (c: string, v: unknown) => ((rows = rows.filter((r) => (r[c] ?? null) === v)), q),
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), q),
        in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
      };
      return q;
    }
    const client = {
      from: (t: string) => query(t),
      rpc: async (name: string) => {
        calls.push(name);
        return rpcImpl ? rpcImpl(name) : { data: [], error: null };
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }
  const IV = uid(62011);
  const NONMEMBER = uid(62999);
  const ivRow = (id: string, protocol: string, status: string): Row => ({
    id, project_id: PROJECT, protocol_id: protocol, buyer_question_version_id: QV(1), status, hypothesis: "h", expected_mechanism: "m",
    action_type: "page_created", action_target: "t", owner: "o", supporting_evidence: ["a"], created_at: "2026-12-01T00:00:00Z", updated_at: "2026-12-01T00:00:00Z",
  });
  const baseTables = () => ({
    interventions: [ivRow(IV, BASE(1, P), "implemented"), ivRow(NONMEMBER, BASE(2, P), "approved")],
    pilot_retest_members: [{ intervention_id: IV, pilot_id: PILOT }],
    pilot_question_protocols: [{ protocol_id: BASE(1, P) }, { protocol_id: BASE(2, P) }],
    protocols: [
      { id: BASE(1, P), project_id: PROJECT, status: "completed", baseline_protocol_id: null, buyer_question_version_id: QV(1), approved_at: "2026-11-18T00:00:00Z" },
      { id: uid(9999), project_id: PROJECT, status: "completed", baseline_protocol_id: null, buyer_question_version_id: QV(1), approved_at: "2026-11-17T00:00:00Z" },
    ],
  });
  const { listRegistrableBaselines } = await import("@/lib/interventions/admin-reads");
  const { registerIntervention, approveIntervention, rejectIntervention, listInterventions } = await import("@/lib/interventions/intervention-actions");
  const { createRetest, queueRetestRun } = await import("@/lib/interventions/retest-actions");
  const { generateOutcomeCard, sendReviewedOutcomeCard } = await import("@/lib/interventions/outcome-card-actions");
  const { findDeliverableInterventions, processOutcomeCard } = await import("@/lib/reports/deliver-outcome-card");
  {
    const { client } = fakeClient(baseTables());
    const list = await listRegistrableBaselines(client);
    check("X1 the registration picker drops every pilot slot protocol", list.length === 1 && list[0].protocolId === uid(9999), list.map((b) => b.protocolId).join(","));
  }
  {
    const { client, calls } = fakeClient(baseTables());
    const r = await registerIntervention(client, { protocolId: BASE(1, P), hypothesis: "h", expectedMechanism: "m", actionType: "page_created", actionTarget: "t", owner: "o", supportingEvidence: [], alternativeExplanations: null, confoundersToMonitor: null, decisionThresholdNote: null, implementationDeadline: null, expectedObservationDays: 21 } as never);
    check("X2 registering on a pilot baseline answers 409 pilot_baseline, before any call", !r.ok && r.failure.status === 409 && r.failure.error === "pilot_baseline" && calls.length === 0);
  }
  {
    const { client, calls } = fakeClient(baseTables(), () => ({ data: [ivRow(NONMEMBER, BASE(2, P), "rejected")], error: null }));
    const member = await approveIntervention(client, IV, uid(1));
    const nonApprove = await approveIntervention(client, NONMEMBER, uid(1));
    const nonReject = await rejectIntervention(client, NONMEMBER, uid(1), "recovery row");
    check("X3 a member's transition answers 409 pilot_member ('Managed on its pilot page'); a non-member on a pilot baseline may only be rejected or abandoned",
      !member.ok && member.failure.error === "pilot_member" && /Managed on its pilot page/.test(member.failure.message) &&
      !nonApprove.ok && nonApprove.failure.error === "pilot_member" && nonReject.ok && calls.join(",") === "reject_intervention", calls.join(","));
  }
  {
    const { client, calls } = fakeClient(baseTables());
    const a = await createRetest(client, IV, uid(1));
    const b = await queueRetestRun(client, IV);
    const c = await generateOutcomeCard(client, IV);
    const d = await sendReviewedOutcomeCard(client, IV, { expectedArtifactId: uid(1), expectedRevision: "r", acknowledgeReview: true }, { apiKey: "", from: "", appBaseUrl: "" });
    check("X4 create retest, queue its run, generate and send a card: each answers 409 pilot_member and calls nothing",
      [a, b, c, d].every((r) => !r.ok && (r as { failure: { error: string } }).failure.error === "pilot_member") && calls.length === 0);
  }
  {
    const t = baseTables();
    const { client } = fakeClient({
      ...t,
      protocols: [...t.protocols, { id: RET(1, P), baseline_protocol_id: BASE(1, P), status: "completed", project_id: PROJECT }, { id: uid(9998), baseline_protocol_id: uid(9999), status: "completed", project_id: PROJECT }],
      interventions: [...t.interventions, ivRow(uid(62998), uid(9999), "implemented")],
      protocol_execution_jobs: [{ protocol_id: RET(1, P), status: "succeeded" }, { protocol_id: uid(9998), status: "succeeded" }],
    });
    const ids = await findDeliverableInterventions(client);
    check("X5 delivery finds a generic intervention but never a pilot member", ids.includes(uid(62998)) && !ids.includes(IV), ids.join(","));
    const processed = await processOutcomeCard(IV, { client, autoSendEnabled: false, deliveryConfig: { apiKey: "", from: "", appBaseUrl: "" } });
    check("X6 processOutcomeCard returns intervention_not_ready for a member, before reading any evidence", processed.outcome === "intervention_not_ready" && processed.artifactId === null);
    const listed = await listInterventions(client);
    check("X7 the intervention list leaves members out", !listed.some((i) => i.intervention.id === IV) && listed.some((i) => i.intervention.id === NONMEMBER));
  }
  const detail = read("app/admin/interventions/[interventionId]/page.tsx");
  const runRetest = read("app/api/internal/interventions/[interventionId]/run-retest/route.ts");
  check("X8 the detail page shows a read-only notice with a link to the pilot instead of the actions for a member",
    detail.includes("const memberOfPilot = await pilotOfMember(client, iv.id);") && detail.includes("{memberOfPilot ? (") &&
    detail.includes("href={`/admin/pilots/${memberOfPilot}`}") && detail.indexOf("{memberOfPilot ? (") < detail.indexOf("<InterventionActionsPanel"));
  check("X9 the run-retest route refuses a member before reading its retest or starting the worker",
    runRetest.indexOf("pilotMemberInterventionIds(client, [interventionId])") > 0 &&
    runRetest.indexOf("pilotMemberInterventionIds(client, [interventionId])") < runRetest.indexOf("readRetestProgress(client") &&
    runRetest.indexOf("pilotMemberInterventionIds(client, [interventionId])") < runRetest.indexOf("startWorkerMachine({"));
  const { mapRpcError, mapPilotGuardError, PILOT_GUARD_RPC_ERRORS } = await import("@/lib/interventions/rpc-errors");
  check("X10 a guard message reaching a generic M7 call is a 409 in words, never a 500 or the raw text",
    mapRpcError({ message: "pilot_intervention_outside_retest", code: "P0001" }).status === 409 &&
    mapPilotGuardError({ message: "pilot_retest_register_failed:approve_intervention", code: "P0001" }).status === 500 &&
    !mapPilotGuardError({ message: "pilot_retest_register_failed:approve_intervention", code: "P0001" }).message.includes("approve_intervention") &&
    mapPilotGuardError({ message: "invalid_register_pilot_retest_args", code: "22023" }).status === 400 &&
    Object.keys(PILOT_GUARD_RPC_ERRORS).length === 10);

  /* ---------------------------------------------------------------- H: routes */
  console.log("\n[H] the six routes");
  const FOUNDER = uid(1);
  type Log = Record<string, unknown>;
  const logs: Log[] = [];
  const dbCalls: string[] = [];
  let guardCalls = 0;
  const db = {
    registerPilotRetest: async () => (dbCalls.push("register"), { outcome: "QUESTION_NOT_LIVE" as const, pilotRetestId: null, pilotQuestionId: Q[1], engine: null }),
    confirmPilotRetestImplementation: async () => (dbCalls.push("confirm"), { outcome: "IMPLEMENTED" as const, windowClosesAt: "2027-02-01T10:00:00Z" }),
    preparePilotRetests: async () => (dbCalls.push("prepare"), { outcome: "WINDOW_OPEN" as const, prepared: null, windowClosesAt: "2027-02-01T10:00:00Z" }),
    abandonPilotRetest: async () => (dbCalls.push("abandon"), "RETEST_STARTED" as const),
    requeuePilotRetestJob: async () => {
      dbCalls.push("requeue");
      throw Object.assign(new Error("pilot_retest_requeue_failed:job"), { code: "P0001" });
    },
    addPilotRetestNote: async () => {
      dbCalls.push("note");
      throw Object.assign(new Error("pilot_intervention_outside_retest"), { code: "P0001" });
    },
  };
  const deps = (env: Record<string, string>, guardOk = true): PilotRetestRouteDeps => ({
    env,
    guard: async () => {
      guardCalls += 1;
      return guardOk ? { ok: true, user: { id: FOUNDER, email: "f@zypact.example" } } : { ok: false, response: NextResponse.json({ ok: false }, { status: 404 }) };
    },
    db: () => db as never,
    questionOrdinal: async () => 2,
    today: () => TODAY,
    log: (line) => logs.push(JSON.parse(line) as Log),
    logError: () => undefined,
  });
  const ON = { SNAPSHOT_APPROVAL_ENABLED: "true", ZYPACT_PILOT_RETEST_ENABLED: "true" };
  const OFF = { SNAPSHOT_APPROVAL_ENABLED: "true" };
  const post = (b: unknown) => new Request("http://x/", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) });
  const ids = { pilotId: PILOT, retestId: G2 };
  const status = async (p2: Promise<Response>) => { const r = await p2; return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const GATED = [
    ["register", (r: Request, d: PilotRetestRouteDeps) => handleRegisterPilotRetest(r, { pilotId: PILOT }, d), GOOD_REGISTER],
    ["implementation", (r: Request, d: PilotRetestRouteDeps) => handleConfirmPilotRetest(r, ids, d), GOOD_CONFIRM],
    ["prepare", (r: Request, d: PilotRetestRouteDeps) => handlePreparePilotRetests(r, ids, d), {}],
    ["requeue", (r: Request, d: PilotRetestRouteDeps) => handleRequeuePilotRetest(r, ids, d), { pilotQuestionId: Q[0], engine: "openai_chatgpt", reason: "Worker not set up for ChatGPT." }],
  ] as const;
  const UNGATED = [
    ["abandon", (r: Request, d: PilotRetestRouteDeps) => handleAbandonPilotRetest(r, ids, d), { reason: "The customer cancelled the page.", confirmed: true }],
    ["notes", (r: Request, d: PilotRetestRouteDeps) => handleAddPilotRetestNote(r, ids, d), { notedOn: "2027-01-15", kind: "competitor_activity", text: "A competitor published a comparison page.", idempotencyKey: randomUUID() }],
  ] as const;
  let killOk = true;
  let guardFirst = true;
  let gateOk = true;
  for (const [name, handler, b] of [...GATED, ...UNGATED]) {
    guardCalls = 0;
    dbCalls.length = 0;
    const killed = await status(handler(post(b), deps({ ZYPACT_PILOT_RETEST_ENABLED: "true" })));
    if (killed.status !== 503 || guardCalls !== 0 || dbCalls.length !== 0) killOk = false;
    const stranger = await status(handler(post(b), deps(ON, false)));
    if (stranger.status !== 404 || dbCalls.length !== 0) guardFirst = false;
    const gated = GATED.some((g) => g[0] === name);
    const off = await status(handler(post(b), deps(OFF)));
    if (gated && (off.status !== 409 || off.body.error !== founderCopy.PILOT_RETEST_NOT_ENABLED || dbCalls.length !== 0)) gateOk = false;
    if (!gated && dbCalls.length !== 1) gateOk = false;
    void name;
  }
  check("H1 the kill switch comes first: 503 before the guard or the database", killOk);
  check("H2 then the founder guard, before the gate or anything else", guardFirst);
  check("H3 the gate: register, record live, prepare and queue again are refused (409, in words) with it off; withdraw and log a change are not gated", gateOk);
  check("H4 the gate opens only on exactly \"true\"", pilotRetestEnabled({ ZYPACT_PILOT_RETEST_ENABLED: "true" }) && !pilotRetestEnabled({ ZYPACT_PILOT_RETEST_ENABLED: "TRUE" }) && !pilotRetestEnabled({}));
  dbCalls.length = 0;
  const badId = await status(handleConfirmPilotRetest(post(GOOD_CONFIRM), { pilotId: PILOT, retestId: "nope" }, deps(ON)));
  const tooBig = await status(handleAddPilotRetestNote(post({ pad: "x".repeat(17_000) }), ids, deps(OFF)));
  // APP-6: every text at its maximum in 3-byte characters (the most UTF-8 per character the parser counts), with the longest approval reference.
  const maxText = Object.fromEntries(Object.keys(GOOD_TEXT).map((f) => [f, "語".repeat(f === "changeTitle" ? 120 : f === "changeTarget" ? 500 : f === "changeOwner" ? 200 : 2000)]));
  const maxBody = { ...GOOD_REGISTER, ...maxText, customerApprovalRef: "語".repeat(300) };
  const maxRegister = await status(handleRegisterPilotRetest(post(maxBody), { pilotId: PILOT }, deps(ON)));
  const callsAfterMax = dbCalls.length;
  const hugeRegister = await status(handleRegisterPilotRetest(post({ ...GOOD_REGISTER, pad: "x".repeat(66_000) }), { pilotId: PILOT }, deps(ON)));
  const broken = await status(handleAbandonPilotRetest(post("{not json"), ids, deps(OFF)));
  const issues = await status(handleRegisterPilotRetest(post({ ...GOOD_REGISTER, hypothesis: "This guarantees more answers." }), { pilotId: PILOT }, deps(ON)));
  const callsAfterRefusals = dbCalls.length;
  check("H5 then the ids (400), the body size (413; a register body with every text at its maximum still fits) and shape (400), then the parsed and linted fields (400 with issues), before the database",
    badId.status === 400 && tooBig.status === 413 && broken.status === 400 && issues.status === 400 && Boolean((issues.body.issues as Record<string, string[]>)?.hypothesis) &&
    hugeRegister.status === 413 && maxRegister.status === 409 && callsAfterMax === 1 && callsAfterRefusals === 1 && dbCalls.length === 1 &&
    Buffer.byteLength(JSON.stringify(maxBody), "utf8") > 32_768 && Buffer.byteLength(JSON.stringify(maxBody), "utf8") <= MAX_REGISTER_BODY_BYTES && MAX_REGISTER_BODY_BYTES === 65_536,
    JSON.stringify([maxRegister.status, hugeRegister.status, dbCalls, Buffer.byteLength(JSON.stringify(maxBody), "utf8")]));
  check("H5b the console puts the three request-shape codes into words, and passes other words through (APP-6)",
    founderCopy.retestRouteErrorText("request_body_too_large", "x") === founderCopy.RETEST_REQUEST_ERROR_WORDS.request_body_too_large &&
    founderCopy.retestRouteErrorText("invalid_id", "x") === founderCopy.RETEST_REQUEST_ERROR_WORDS.invalid_id &&
    founderCopy.retestRouteErrorText("invalid_body", "x") === founderCopy.RETEST_REQUEST_ERROR_WORDS.invalid_body &&
    Object.values(founderCopy.RETEST_REQUEST_ERROR_WORDS).every((w) => !/_/.test(w)) &&
    founderCopy.retestRouteErrorText(founderCopy.PILOT_RETEST_NOT_ENABLED, "x") === founderCopy.PILOT_RETEST_NOT_ENABLED &&
    founderCopy.retestRouteErrorText(undefined, "fallback") === "fallback" &&
    ["The change could not be registered.", "No answer from the server.", "The change could not be recorded as live.", "The note could not be added."]
      .every((fb) => read("app/admin/pilots/pilot-retest-forms.tsx").includes(`retestRouteErrorText(payload?.error, "${fb}")`)) &&
    !/payload\?\.error \?\?/.test(read("app/admin/pilots/pilot-retest-forms.tsx")));
  const reg2 = await status(handleRegisterPilotRetest(post(GOOD_REGISTER), { pilotId: PILOT }, deps(ON)));
  const conf2 = await status(handleConfirmPilotRetest(post(GOOD_CONFIRM), ids, deps(ON)));
  const prep2 = await status(handlePreparePilotRetests(post(""), ids, deps(ON)));
  const ab2 = await status(handleAbandonPilotRetest(post({ reason: "The customer cancelled the page.", confirmed: true }), ids, deps(OFF)));
  const rq2 = await status(handleRequeuePilotRetest(post({ pilotQuestionId: Q[0], engine: "openai_chatgpt", reason: "Worker not set up for ChatGPT." }), ids, deps(ON)));
  const nt2 = await status(handleAddPilotRetestNote(post({ notedOn: "2027-01-15", kind: "competitor_activity", text: "A competitor published a comparison page.", idempotencyKey: randomUUID() }), ids, deps(OFF)));
  check("H6 outcomes in the founder's words: a per-question refusal names the question; success; a refusal; a step failure is a 500 that echoes nothing; a guard is a 409 in words",
    reg2.status === 409 && reg2.body.error === `Question 2: ${founderCopy.REGISTER_RETEST_REFUSAL.QUESTION_NOT_LIVE}` &&
    conf2.status === 200 && conf2.body.ok === true && prep2.status === 409 && prep2.body.error === founderCopy.PREPARE_RETEST_REFUSAL.WINDOW_OPEN &&
    ab2.status === 409 && ab2.body.error === founderCopy.ABANDON_RETEST_REFUSAL.RETEST_STARTED &&
    rq2.status === 500 && rq2.body.error === founderCopy.PILOT_RETEST_STEP_FAILED_TEXT && !JSON.stringify(rq2.body).includes("requeue_failed") &&
    nt2.status === 409 && nt2.body.error === PILOT_GUARD_RPC_ERRORS.pilot_intervention_outside_retest.message,
    JSON.stringify([reg2, rq2, nt2]));
  const ALLOWED = new Set(["ts", "level", "event", "actorUserId", "pilotId", "pilotRetestId", "outcome", "ok", "questions", "pilotQuestionId", "engine", "noteId", "kind"]);
  const logText = JSON.stringify(logs);
  check("H7 logs carry closed fields only: never registered text, a reference, a link, a note or a reason",
    logs.length >= 6 && logs.every((l) => Object.keys(l).every((k) => ALLOWED.has(k))) &&
    ![GOOD_TEXT.hypothesis, GOOD_REGISTER.customerApprovalRef, GOOD_CONFIRM.evidenceUrl, GOOD_CONFIRM.note, "The customer cancelled the page.", "Worker not set up", "A competitor published"].some((t) => logText.includes(t)));

  // No new route or helper reaches the worker starter, by any import.
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(process.cwd(), spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      try { if (readFileSync(c, "utf8") !== undefined) return c; } catch { /* next */ }
    }
    return null;
  };
  const reaches = (entry: string, sink: string): boolean => {
    const seen = new Set<string>();
    const stack = [path.join(process.cwd(), entry)];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (f === path.join(process.cwd(), sink)) return true;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of readFileSync(f, "utf8").matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const next = resolveImport(f, m[1] ?? m[2]);
        if (next) stack.push(next);
      }
    }
    return false;
  };
  const R = "app/api/internal/pilots/[pilotId]/retests";
  const ROUTES = [`${R}/route.ts`, ...["implementation", "prepare", "requeue", "abandon", "notes"].map((s) => `${R}/[retestId]/${s}/route.ts`)];
  const NEW = [...ROUTES, "lib/pilots/retest-routes.ts", "lib/pilots/retest-store.ts", "app/admin/pilots/pilot-retest-forms.tsx", ...PURE];
  const starters = NEW.filter((f) => reaches(f, "lib/worker-control/fly-machine.ts") || reaches(f, "lib/probes/chatgpt.ts") || reaches(f, "lib/probes/perplexity.ts") || /startWorkerMachine/.test(read(f)));
  check("H8 no new route, helper or form reaches the worker starter or a provider adapter, by any import", starters.length === 0, starters.join(","));
  const HANDLERS = ["handleRegisterPilotRetest", "handleConfirmPilotRetest", "handlePreparePilotRetests", "handleRequeuePilotRetest", "handleAbandonPilotRetest", "handleAddPilotRetestNote"];
  check("H9 each route file is the handler the tests run, with the process env, its own founder guard and the shared adapter, POST only",
    ROUTES.every((f, i) => {
      const s = read(f);
      return s.includes(`return ${HANDLERS[i]}(request, await params, {`) && s.includes("env: process.env,") && /guard: \(\) => requireFounderForRoute\("pilot-retest-[a-z]+"\),/.test(s) &&
        s.includes("db: getDb,") && /^export async function POST\(/m.test(s) && !/export async function (GET|PUT|PATCH|DELETE)/.test(s);
    }));

  // The phase choice, and a retest refused with the gate off in the real Run, Retry and review code.
  const NE = "not enabled";
  check("H10 the phase: absent is the baseline; outside the closed set 400 invalid_phase; a retest on a gated route with the gate off 409",
    (() => { const a = pilotPhaseFromBody({}, { retestEnabled: false, gated: true, notEnabledText: NE }); return a.ok && a.phase === "baseline"; })() &&
    (() => { const a = pilotPhaseFromBody({ phase: "followup" }, { retestEnabled: true, gated: true, notEnabledText: NE }); return !a.ok && a.status === 400 && a.error === "invalid_phase"; })() &&
    (() => { const a = pilotPhaseFromBody({ phase: "retest" }, { retestEnabled: false, gated: true, notEnabledText: NE }); return !a.ok && a.status === 409 && a.error === NE; })() &&
    (() => { const a = pilotPhaseFromBody({ phase: "retest" }, { retestEnabled: false, gated: false, notEnabledText: NE }); return a.ok && a.phase === "retest"; })());
  const { __setSupabaseServerClientForTests } = await import("@/lib/supabase/server");
  __setSupabaseServerClientForTests({ auth: { getUser: async () => ({ data: { user: { id: FOUNDER, email: "founder@zypact.example" } }, error: null }) } } as unknown as SupabaseClient);
  process.env.SNAPSHOT_FOUNDER_EMAILS = "founder@zypact.example";
  process.env.SNAPSHOT_APPROVAL_ENABLED = "true";
  delete process.env.ZYPACT_PILOT_RETEST_ENABLED;
  delete process.env.ZYPACT_PILOT_CHATGPT_ENABLED;
  const runRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/run/route");
  const retryRoute = await import("@/app/api/internal/pilots/[pilotId]/questions/[pilotQuestionId]/retry/route");
  const params = () => ({ params: Promise.resolve({ pilotId: PILOT, pilotQuestionId: QID(1) }) });
  const outcome = async (pr: Promise<Response>) => {
    try { const r = await pr; return { status: r.status, body: (await r.json()) as Record<string, unknown> }; } catch (e) { return { threw: e instanceof Error ? e.message : String(e) }; }
  };
  const SERVICE_MISSING = "Supabase service-role configuration is required for report review.";
  const runOff = await outcome(runRoute.POST(post({ phase: "retest" }), params()));
  const runBad = await outcome(runRoute.POST(post({ phase: "later" }), params()));
  const retryOff = await outcome(retryRoute.POST(post({ phase: "retest", note: "Provider returned 500 on run 2.", idempotencyKey: randomUUID() }), params()));
  process.env.ZYPACT_PILOT_RETEST_ENABLED = "true";
  const runOn = await outcome(runRoute.POST(post({ phase: "retest" }), params()));
  delete process.env.ZYPACT_PILOT_RETEST_ENABLED;
  const runBaseline = await outcome(runRoute.POST(post({}), params()));
  check("H11 Run and Retry of a retest with the gate off are refused (409, in words) before anything is read or started; with it on, the Run goes on to read its slot; a baseline Run is not behind the retest gate",
    "status" in runOff && runOff.status === 409 && runOff.body?.error === founderCopy.PILOT_RETEST_NOT_ENABLED &&
    "status" in retryOff && retryOff.status === 409 && "status" in runBad && runBad.status === 400 && runBad.body?.error === "invalid_phase" &&
    "threw" in runOn && runOn.threw === SERVICE_MISSING && "threw" in runBaseline && runBaseline.threw === SERVICE_MISSING,
    JSON.stringify([runOff, retryOff, runBad, runOn, runBaseline]));
  // The review route resolves a retest with the gate off, reading the retest slot.
  const { handleResolvePilotQuestionReview } = await import("@/lib/pilots/engine-routes");
  const phases: unknown[] = [];
  const reviewClient = {
    from: (t: string) => {
      const rowsBy: Record<string, Row[]> = {
        pilots: [{ id: PILOT, status: "active", starts_on: "2026-11-18", ends_on: "2027-02-16" }],
        pilot_questions: [{ id: QID(1), pilot_id: PILOT, retired_at: null }],
        pilot_question_protocols: [],
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { if (t === "pilot_question_protocols" && c === "phase") phases.push(v); return q; },
        maybeSingle: async () => ({ data: (rowsBy[t] ?? [])[0] ?? null, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  const review = await status(handleResolvePilotQuestionReview(post({ engine: "openai_chatgpt", phase: "retest", resolution: "failed", note: "The answer never arrived." }), { pilotId: PILOT, pilotQuestionId: QID(1) }, {
    env: { SNAPSHOT_APPROVAL_ENABLED: "true" },
    guard: async () => ({ ok: true, user: { id: FOUNDER, email: "f@zypact.example" } }),
    client: () => reviewClient,
    log: () => undefined,
  }));
  check("H12 a retest held for review is resolved with the retest gate off: the review reads that question's retest slot",
    review.status === 409 && review.body.error === founderCopy.RETEST_SLOT_MISSING_TEXT && JSON.stringify(phases) === JSON.stringify(["retest"]), JSON.stringify([review, phases]));

  // The console.
  const pageSrc = read("app/admin/pilots/[pilotId]/page.tsx");
  const formsSrc = read("app/admin/pilots/pilot-retest-forms.tsx");
  check("H13 the console: the gate read at request time; register only when allowed; Retire hidden for a question in a live change; the close prompt warns; stale includes the retests",
    pageSrc.includes("const retestEnabled = pilotRetestEnabled();") && pageSrc.includes("{retestEnabled && retests.canRegister ? (") &&
    pageSrc.includes("!retests.questionsInLiveGroup.includes(q.id)") && pageSrc.includes("<ClosePilotButton pilotId={pilot.id} warnings={closeWarnings} />") &&
    pageSrc.includes("!revisionRetestsCurrent(r.retestManifest, retestState)") &&
    read("app/admin/pilots/[pilotId]/report/[artifactId]/page.tsx").includes("!revisionRetestsCurrent(revision.retestManifest,"));
  check("H14 the retest cells reuse B's Run, Retry and review controls with phase retest and the retest's own Run words; Queue again and withdraw are offered only as the rules allow",
    formsSrc.includes('phase="retest"\n                        confirmAddition={retestRunConfirmationAddition(q.ordinal, engine)}') &&
    formsSrc.includes('<ResolveReviewControls pilotId={pilotId} pilotQuestionId={q.pilotQuestionId} engine={engine} phase="retest" />') &&
    formsSrc.includes("{retestEnabled && pilotOpen && c.canRequeue ? (") && formsSrc.includes("{group.canAbandon ? (") &&
    founderCopy.REQUEUE_RETEST_PROMPT.startsWith("This retest stopped before any answer, so nothing was spent. Queue it again?") &&
    founderCopy.RETEST_REGISTER_CONFIRMATION === "The customer approved this change in writing on the date above, chose these questions, and was told before paying that a retest can show only a change of 60 points or more." &&
    founderCopy.retestRunConfirmationAddition(3, "openai_chatgpt") === "This measures question 3 again on ChatGPT after the change. If the worker is not set up for ChatGPT, it stops before any answer, spends nothing, and can be queued again here.");
  check("H15 no stored code is shown on the console: states, kinds and types through their words",
    !/>\s*\{(c|g|group)\.(state|jobStatus|kind|actionType)\}\s*</.test(formsSrc + pageSrc) && formsSrc.includes("RETEST_MEMBER_STATE_WORDS[c.state]"));

  console.log(`\n${total - failures}/${total} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed. Pilot retest FAILED.`);
    process.exit(1);
  }
  console.log("Pilot retest PASSED.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
