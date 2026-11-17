/**
 * X1 (D-050) — the ChatGPT model benchmark's pure logic: arguments, plan,
 * budget guard, lifetime spend ledger, stop rules and summary. No provider
 * call and no file access here, so every rule is tested offline
 * (scripts/test-chatgpt-adapter.ts). The runner is
 * scripts/benchmark-chatgpt-models.ts.
 */
import type { ChatGptSetting } from "@/lib/probes/chatgpt";
import type { ChatGptUsage, CostEstimate } from "@/lib/probes/chatgpt-pricing";

/**
 * Founder, 2026-11-10: benchmarking stops itself at $40; the project hard
 * limit is $50. Founder, 2026-11-11: the $40 is a LIFETIME ceiling across
 * every benchmark run, including the ~$6 already spent, not a per-run cap.
 */
export const BENCHMARK_HARD_CEILING_USD = 40;
export const BENCHMARK_LIFETIME_CEILING_USD = BENCHMARK_HARD_CEILING_USD;
export const BENCHMARK_MAX_RUNS = 150;
export const BENCHMARK_MAX_REPEATS = 5;

/**
 * The lifetime spend the repository itself records (validity note, D-050):
 * every run started up to `through`. The ledger under .benchmark-out/ is
 * git-ignored, so on a machine without the earlier output it would count
 * from $0 and the lifetime ceiling would silently reset. Before a live run
 * the local ledger must therefore hold, from that period, at least these
 * runs and this spend; later runs cannot stand in for missing earlier ones.
 * Moved forward in the commit that records each paid phase.
 */
export const BENCHMARK_SPEND_CHECKPOINT = { through: "2026-11-11T23:59:59.999Z", runs: 237, usd: 15.351313 } as const;

export interface BenchmarkQuestion {
  id: string;
  category: "discovery" | "comparison" | "evaluation" | "use_case";
  text: string;
}

export const BENCHMARK_QUESTION_SETS = {
  general: "scripts/fixtures/chatgpt-benchmark-questions.json",
  "smaller-vendor": "scripts/fixtures/chatgpt-benchmark-questions-smaller-vendor.json",
} as const;
export type BenchmarkQuestionSet = keyof typeof BENCHMARK_QUESTION_SETS;

export interface MergedQuestions {
  /** The fixture versions, joined with "+", in the order run. */
  version: string;
  questions: BenchmarkQuestion[];
  /** Which set each question id came from. */
  setOfQuestion: Map<string, string>;
}

/**
 * Several sets as one list, in the order given; `limitPerSet` keeps the first
 * n of EACH set. Null when two questions share an id: the id is a record's
 * only question identity.
 */
export function mergeQuestionSets(
  sets: ReadonlyArray<{ name: string; version: string; questions: BenchmarkQuestion[] }>,
  limitPerSet: number | null = null
): MergedQuestions | null {
  const questions: BenchmarkQuestion[] = [];
  const setOfQuestion = new Map<string, string>();
  for (const s of sets) {
    for (const q of s.questions.slice(0, limitPerSet ?? s.questions.length)) {
      if (setOfQuestion.has(q.id)) return null;
      setOfQuestion.set(q.id, s.name);
      questions.push(q);
    }
  }
  return { version: sets.map((s) => s.version).join("+"), questions, setOfQuestion };
}

/**
 * The per-call deadline: 30 ms per token of the output cap, so 120 s at 4000
 * (what every run to 2026-11-11 had) and 240 s at 8000. Recorded for
 * gpt-5.4-2026-03-05 at the 4000 cap: about 16.6 ms per output token, 24.7 ms
 * at most, which puts a full 8000-token answer near 135 s (a straight-line
 * extrapolation, untested above 4000). A call cut off by the deadline has an
 * unknown cost and is counted at its worst case, so the deadline must not be
 * what stops a long answer. Kept under the 300 s at which Node's fetch gives
 * up on its own.
 *
 * On the flex tier the deadline is that 290 s maximum whatever the cap:
 * OpenAI warns that flex responds more slowly and that "request timeouts are
 * more likely", and a call cut off is counted at its worst case. The
 * confirmation run's speed criterion stays at 240 s; a call between 240 and
 * 290 s is kept and recorded as missing it, not lost.
 */
export const DEADLINE_MS_PER_OUTPUT_TOKEN = 30;
export const FLEX_CALL_DEADLINE_MS = 290_000;
export function callDeadlineMs(maxOutputTokens: number, serviceTier: "flex" | null = null): number {
  if (serviceTier === "flex") return FLEX_CALL_DEADLINE_MS;
  return Math.min(290_000, Math.max(120_000, maxOutputTokens * DEADLINE_MS_PER_OUTPUT_TOKEN));
}

export interface BenchmarkArgs {
  live: boolean;
  /** One or more sets, run as one list in this order. */
  questionSets: BenchmarkQuestionSet[];
  /** Per-model repeat overrides (e.g. the reference at fewer repeats); others use `repeats`. */
  repeatsByModel: Record<string, number>;
  maxUsd: number | null;
  confirmed: boolean;
  repeats: number;
  /** The first n questions of each chosen set. */
  questionLimit: number | null;
  models: string[] | null;
  /**
   * The directory of a stopped run to continue. The start index and what the
   * phase has already spent are read from that run, never typed in, so one
   * cap covers every part and no recorded call is paid for twice.
   */
  resume: string | null;
  /**
   * Stop once more than this many runs of the phase have failed, whatever the
   * cause; a resumed run inherits the failures of the parts before it. Null:
   * no such limit.
   */
  maxFailed: number | null;
  /** A resumed run may raise the phase cap only with this switch: a higher cap is a new founder decision. */
  higherCapConfirmed: boolean;
  out: string | null;
}

/** A number from a flag value; an empty value is not a number (Number("") is 0). */
const numberArg = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));

export function parseBenchmarkArgs(argv: string[]): { ok: true; args: BenchmarkArgs } | { ok: false; error: string } {
  const args: BenchmarkArgs = { live: false, questionSets: ["general"], repeatsByModel: {}, maxUsd: null, confirmed: false, repeats: BENCHMARK_MAX_REPEATS, questionLimit: null, models: null, resume: null, maxFailed: null, higherCapConfirmed: false, out: null };
  for (const a of argv) {
    const [k, v] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    // The switches that allow spending take no value: "--live=false" must never read as "--live".
    if (k === "--live" || k === "--i-confirm-founder-approved-budget" || k === "--i-confirm-founder-approved-higher-cap") {
      if (a !== k) return { ok: false, error: `${k} takes no value` };
      if (k === "--live") args.live = true;
      else if (k === "--i-confirm-founder-approved-budget") args.confirmed = true;
      else args.higherCapConfirmed = true;
    }
    else if (k === "--max-usd") args.maxUsd = numberArg(v);
    else if (k === "--repeats") args.repeats = numberArg(v);
    else if (k === "--questions") args.questionLimit = numberArg(v);
    else if (k === "--max-failed") args.maxFailed = numberArg(v);
    else if (k === "--resume") {
      if (!v.trim()) return { ok: false, error: "--resume takes the directory of the stopped run" };
      args.resume = v;
    }
    else if (k === "--models") {
      const models = v.split(",").map((m) => m.trim());
      if (models.some((m) => !m) || new Set(models).size !== models.length) return { ok: false, error: "--models takes model names separated by commas, each once" };
      args.models = models;
    } else if (k === "--out") args.out = v;
    else if (k === "--question-set") {
      const sets = v.split(",").map((s) => s.trim());
      if (new Set(sets).size !== sets.length || sets.some((s) => !Object.hasOwn(BENCHMARK_QUESTION_SETS, s))) {
        return { ok: false, error: `--question-set takes ${Object.keys(BENCHMARK_QUESTION_SETS).join(", ")}: one, or several separated by commas, each once` };
      }
      args.questionSets = sets as BenchmarkQuestionSet[];
    } else if (k === "--repeats-by-model") {
      for (const pair of v.split(",").map((x) => x.trim()).filter(Boolean)) {
        const at = pair.lastIndexOf(":");
        const n = numberArg(pair.slice(at + 1));
        if (at < 1 || !Number.isInteger(n) || n < 1 || n > BENCHMARK_MAX_REPEATS) return { ok: false, error: `--repeats-by-model entries are model:1..${BENCHMARK_MAX_REPEATS}` };
        args.repeatsByModel[pair.slice(0, at)] = n;
      }
    }
    else return { ok: false, error: `unknown argument ${k}` };
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > BENCHMARK_MAX_REPEATS) return { ok: false, error: `--repeats must be 1..${BENCHMARK_MAX_REPEATS}` };
  if (args.questionLimit !== null && (!Number.isInteger(args.questionLimit) || args.questionLimit < 1)) return { ok: false, error: "--questions must be a positive integer" };
  if (args.maxFailed !== null && (!Number.isInteger(args.maxFailed) || args.maxFailed < 0)) return { ok: false, error: "--max-failed must be a whole number, 0 or more" };
  // Checked for a dry run too: a cap that is not a positive number must never print as "within the ceiling".
  if (args.maxUsd !== null && (!Number.isFinite(args.maxUsd) || args.maxUsd <= 0)) return { ok: false, error: "--max-usd must be a positive number of dollars" };
  if (args.maxUsd !== null && args.maxUsd > BENCHMARK_HARD_CEILING_USD) return { ok: false, error: `--max-usd may not exceed ${BENCHMARK_HARD_CEILING_USD}` };
  if (args.live) {
    if (args.maxUsd === null) return { ok: false, error: "--live needs --max-usd=<dollars>" };
    if (!args.confirmed) return { ok: false, error: "--live needs --i-confirm-founder-approved-budget" };
  }
  return { ok: true, args };
}

/**
 * OpenAI's "no credit left" refusal (HTTP 429, error type
 * insufficient_quota). Distinct from a rate limit: retrying cannot succeed,
 * so the benchmark stops instead of spending calls on refusals.
 */
export function isQuotaExhausted(httpStatus: number | null, body: string | null): boolean {
  if (httpStatus !== 429 || !body) return false;
  try {
    const e = (JSON.parse(body) as { error?: { type?: unknown; code?: unknown } }).error;
    return e?.type === "insufficient_quota" || e?.code === "insufficient_quota" || e?.code === "credit_balance_exhausted";
  } catch {
    return false;
  }
}

/**
 * Whether a record's request asked for the flex tier, read from the exact
 * request body recorded with it (the bytes sent), not from a label.
 */
export function wasFlexRequest(record: { requestBody?: string | null }): boolean {
  if (typeof record.requestBody !== "string") return false;
  try {
    const body = JSON.parse(record.requestBody) as { service_tier?: unknown } | null;
    return !!body && typeof body === "object" && body.service_tier === "flex";
  } catch {
    return false;
  }
}

/**
 * OpenAI's flex refusal for lack of capacity. Its flex guide: "Flex
 * processing may sometimes lack sufficient resources to handle your
 * requests, resulting in a `429 Resource Unavailable` error code. You will
 * not be charged when this occurs." No type, code or body is documented, so
 * the error's own words are matched: "resource unavailable", in any case
 * and with a space, underscore or hyphen. Anything else is not this refusal,
 * an ordinary rate limit included ("Rate limit reached ..."), and keeps the
 * unknown-cost rule.
 */
export function isFlexResourceUnavailable(httpStatus: number | null, body: string | null): boolean {
  if (httpStatus !== 429 || !body) return false;
  try {
    const e = (JSON.parse(body) as { error?: { type?: unknown; code?: unknown; message?: unknown } } | null)?.error;
    const words = [e?.type, e?.code, e?.message].filter((x): x is string => typeof x === "string").join(" ");
    return /resource[\s_-]*unavailable/i.test(words);
  } catch {
    return false;
  }
}

/** The fields that say whether a call was refused unprocessed. A record from before 2026-11-17 may lack requestBody's flex field; it is then no flex request. */
type RefusalFields = Pick<BenchmarkRecord, "usage" | "httpStatus" | "responseBody"> & { requestBody?: string | null };

/**
 * A flex request refused for lack of capacity: the request asked for flex,
 * the provider answered 429 "Resource Unavailable", and no usage came back.
 * OpenAI does not charge it. Like a credit refusal it is not an attempt: it
 * books nothing, is not a failed run, and its plan index is made again (after
 * a wait within the run; on --resume otherwise).
 */
export function isFlexBusyRefusal(record: RefusalFields): boolean {
  return !record.usage && wasFlexRequest(record) && !isQuotaExhausted(record.httpStatus, record.responseBody) &&
    isFlexResourceUnavailable(record.httpStatus, record.responseBody);
}

/** The failure label of a flex capacity refusal. */
export const FLEX_BUSY_FAILURE = "http_error:429:flex_resource_unavailable";

/**
 * Waits before a flex index is made again after a capacity refusal: 30 s,
 * then doubling, at most five times for one index (15.5 minutes) and at most
 * an hour in one invocation. Null when neither allows another wait: the run
 * then stops ("provider_busy") and a --resume makes the index again.
 */
export const FLEX_BUSY_BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 240_000, 480_000]);
export const FLEX_BUSY_MAX_WAIT_PER_INVOCATION_MS = 3_600_000;
export function flexBusyWaitMs(retriesOfThisIndex: number, waitedThisInvocationMs: number): number | null {
  if (!Number.isInteger(retriesOfThisIndex) || retriesOfThisIndex < 0 || retriesOfThisIndex >= FLEX_BUSY_BACKOFF_MS.length) return null;
  if (!Number.isFinite(waitedThisInvocationMs) || waitedThisInvocationMs < 0) return null;
  const wait = FLEX_BUSY_BACKOFF_MS[retriesOfThisIndex];
  return waitedThisInvocationMs + wait <= FLEX_BUSY_MAX_WAIT_PER_INVOCATION_MS ? wait : null;
}

/**
 * A request asked for flex, a Responses object came back, and that object
 * does not say flex served it (OpenAI: the response names the tier actually
 * used). The setting was not honoured and the call may have been billed at
 * the standard rate, so the run stops at once. Read from the stored bodies,
 * whatever the adapter's verdict, so a capped or failed answer from the
 * wrong tier stops it too.
 */
export function servedOffRequestedTier(record: { requestBody?: string | null; responseBody: string | null }): boolean {
  if (!wasFlexRequest(record) || typeof record.responseBody !== "string") return false;
  try {
    const body = JSON.parse(record.responseBody) as { object?: unknown; service_tier?: unknown } | null;
    return !!body && typeof body === "object" && body.object === "response" && body.service_tier !== "flex";
  } catch {
    return false;
  }
}

/**
 * A refusal that repeating cannot fix: the request, the key or the model is
 * wrong (HTTP 400, 401, 403, 404). The benchmark stops at the first one,
 * because every further refusal would be counted at its worst case against
 * the cap and the lifetime ceiling without a cent being spent.
 */
export function isRequestRejected(httpStatus: number | null): boolean {
  return httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404;
}

/** The `incomplete_details.reason` of a stored Responses body ("max_output_tokens" when the cap stopped it), or null. */
export function incompleteReasonOfBody(body: string | null): string | null {
  if (!body) return null;
  try {
    const d = (JSON.parse(body) as { incomplete_details?: { reason?: unknown } | null } | null)?.incomplete_details;
    return typeof d?.reason === "string" ? d.reason : null;
  } catch {
    return null;
  }
}

export interface PlannedRun {
  index: number;
  question: BenchmarkQuestion;
  repeat: number;
  role: "candidate" | "reference";
  setting: ChatGptSetting;
}

/**
 * Interleaved: repeat → question → model. A run stopped by the budget leaves
 * every model with nearly the same questions and repeats, so a partial
 * benchmark is still a fair comparison.
 */
export function planBenchmark(
  questions: BenchmarkQuestion[],
  candidates: ReadonlyArray<{ role: "candidate" | "reference"; setting: ChatGptSetting }>,
  repeats: number,
  repeatsByModel: Record<string, number> = {}
): PlannedRun[] {
  const repeatsOf = (model: string): number => (Object.hasOwn(repeatsByModel, model) ? repeatsByModel[model] : repeats);
  const plan: PlannedRun[] = [];
  const rounds = Math.max(repeats, ...candidates.map((c) => repeatsOf(c.setting.model)));
  for (let r = 1; r <= rounds; r += 1) {
    for (const q of questions) {
      for (const c of candidates) {
        if (r > repeatsOf(c.setting.model)) continue;
        plan.push({ index: plan.length, question: q, repeat: r, role: c.role, setting: c.setting });
      }
    }
  }
  return plan;
}

/** An amount of money a ledger may add up: a finite number, zero or more. */
const isMoney = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/**
 * The lines of a ledger file (runs.jsonl, reservations.jsonl), each a JSON
 * object. A line that is cut short, or that parses to anything else (null, a
 * number, a list), means the file cannot be trusted: that is an error naming
 * the file and line, never a skipped line, because a skipped line is spend
 * that silently drops out of the lifetime count.
 */
export function parseLedgerLines(text: string, fileLabel: string): Array<Record<string, unknown>> {
  return text.split("\n").flatMap((line, i) => {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${fileLabel} line ${i + 1} is not a JSON object; the lifetime spend cannot be counted.`);
    }
    return [value as Record<string, unknown>];
  });
}

/**
 * Written to reservations.jsonl BEFORE a call is made, so a process killed
 * mid-call still leaves a trace of a call that may have been billed.
 */
export interface BenchmarkReservation {
  index: number;
  model: string;
  settingVersion: string;
  questionId: string;
  repeat: number;
  startedAt: string;
  reservedWorstCaseUsd: number;
}

/**
 * Reservations with no record in the same run: the process stopped between
 * reserving a call and recording it. Matched by count, in order, per plan
 * index: a flex index refused for lack of capacity is called again, so one
 * index can hold several reservations, each settled by one record. A
 * reservation beyond the records of its index is a call that may have been
 * billed and was never recorded.
 */
export function unsettledReservations<T extends { index: number }>(reservations: ReadonlyArray<T>, records: ReadonlyArray<{ index: number }>): T[] {
  const recorded = new Map<number, number>();
  for (const r of records) recorded.set(r.index, (recorded.get(r.index) ?? 0) + 1);
  const seen = new Map<number, number>();
  return reservations.filter((x) => {
    const nth = (seen.get(x.index) ?? 0) + 1;
    seen.set(x.index, nth);
    return nth > (recorded.get(x.index) ?? 0);
  });
}

/**
 * Spend already recorded by earlier benchmark runs, for the lifetime ceiling.
 *   - A run with an estimated cost counts at that estimate.
 *   - A credit-exhausted refusal (HTTP 429 insufficient_quota, no usage)
 *     counts as 0: OpenAI does not process or bill it. So does a flex
 *     request refused for lack of capacity (isFlexBusyRefusal), which
 *     OpenAI says it does not charge.
 *   - Any other run without a known cost counts at its worst case: the amount
 *     reserved when it started, where the record carries one, otherwise the
 *     worst case under the output cap of the setting it ran under (`capOf`
 *     its recorded setting version).
 *   - A reservation that was never settled (the process died mid-call) counts
 *     at the amount reserved.
 * Fail closed: a run whose cap cannot be told, whose model has no price, or
 * any amount that is not a finite number of dollars makes the ledger
 * unusable (null), so the caller must refuse to spend.
 */
export interface SpendLedger {
  runs: number;
  estimatedUsd: number;
  refusedNotBilled: number;
  unknownCountedAtWorstCase: number;
  unsettledReservations: number;
  totalUsd: number;
}

export type LedgerRecord = Pick<BenchmarkRecord, "model" | "settingVersion" | "cost" | "httpStatus" | "responseBody" | "usage" | "reservedWorstCaseUsd"> & { requestBody?: string | null };

export function benchmarkSpendLedger(
  records: ReadonlyArray<LedgerRecord>,
  worstCase: (model: string, maxOutputTokens: number) => number | null,
  capOf: (settingVersion: unknown) => number | null,
  unsettled: ReadonlyArray<{ reservedWorstCaseUsd: unknown }> = []
): SpendLedger | null {
  let estimated = 0;
  let worst = 0;
  let refused = 0;
  let unknown = 0;
  for (const r of records) {
    const usd: unknown = r.cost ? r.cost.usd : null;
    if (usd !== null) {
      if (!isMoney(usd)) return null;
      estimated += usd;
    } else if (isNotBilledRefusal(r)) refused += 1;
    else {
      let w: unknown = r.reservedWorstCaseUsd;
      if (w === undefined || w === null) {
        const cap = capOf(r.settingVersion);
        w = cap === null ? null : worstCase(r.model, cap);
      }
      if (!isMoney(w)) return null;
      worst += w;
      unknown += 1;
    }
  }
  let pending = 0;
  for (const u of unsettled) {
    if (!isMoney(u.reservedWorstCaseUsd)) return null;
    pending += u.reservedWorstCaseUsd;
  }
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    runs: records.length, estimatedUsd: round(estimated), refusedNotBilled: refused, unknownCountedAtWorstCase: unknown,
    unsettledReservations: unsettled.length, totalUsd: round(estimated + worst + pending),
  };
}

/** The most a new run may be capped at: what is left of the lifetime ceiling. */
export function remainingLifetimeUsd(ledger: Pick<SpendLedger, "totalUsd">): number {
  return Math.max(0, Math.round((BENCHMARK_LIFETIME_CEILING_USD - ledger.totalUsd) * 1e6) / 1e6);
}

/**
 * The records the checkpoint speaks about: those started up to its `through`
 * instant. Compared as instants, not as text, so another timestamp format or
 * a time-zone offset is read correctly; a start time that cannot be read is
 * left out, which can only make the ledger look short and refuse a run.
 */
export function recordsThroughCheckpoint<T extends { startedAt?: unknown }>(records: ReadonlyArray<T>): T[] {
  const through = Date.parse(BENCHMARK_SPEND_CHECKPOINT.through);
  return records.filter((r) => typeof r.startedAt === "string" && Date.parse(r.startedAt) <= through);
}

/**
 * Whether the local ledger holds at least the spend the repository records.
 * Takes the ledger of `recordsThroughCheckpoint` only; an unusable ledger
 * (null) does not cover it.
 */
export function ledgerCoversCheckpoint(throughCheckpoint: Pick<SpendLedger, "runs" | "totalUsd"> | null): boolean {
  return !!throughCheckpoint && throughCheckpoint.runs >= BENCHMARK_SPEND_CHECKPOINT.runs && throughCheckpoint.totalUsd >= BENCHMARK_SPEND_CHECKPOINT.usd - 1e-6;
}

/**
 * Whether a live run may be given this cap: a finite, positive number that
 * fits in what is left. Written as a positive test so that NaN, a missing
 * amount or an unusable ledger is a refusal, never a pass.
 */
export function capFitsLifetime(maxUsd: number | null, remainingUsd: number | null): boolean {
  return typeof maxUsd === "number" && Number.isFinite(maxUsd) && maxUsd > 0 &&
    typeof remainingUsd === "number" && Number.isFinite(remainingUsd) && maxUsd <= remainingUsd;
}

/**
 * What earlier runs of a model cost, as a PROJECTION for planning a run of
 * `setting` (never for reservation). Every recorded run of that model with
 * usage is priced again from its usage; a run that stopped at its own, lower
 * output cap is counted as if it had used the whole of the planned cap,
 * because a raised cap lets it run on. Null when the model has no such run.
 * The projection is only as good as its basis, which the caller must print:
 * the setting versions and the questions the recorded runs covered.
 */
export interface RecordedRunCost {
  runs: number;
  meanUsd: number;
  maxUsd: number;
  /** Runs that stopped at a lower cap than the planned one, counted at the planned cap. */
  raisedToCap: number;
  settingVersions: string[];
  questionIds: string[];
}

export function recordedRunCost(
  records: ReadonlyArray<Pick<BenchmarkRecord, "model" | "settingVersion" | "questionId" | "usage">>,
  setting: Pick<ChatGptSetting, "model" | "maxOutputTokens">,
  estimate: (model: string, usage: ChatGptUsage) => CostEstimate,
  capOf: (settingVersion: unknown) => number | null
): RecordedRunCost | null {
  const costs: number[] = [];
  const versions = new Set<string>();
  const questionIds = new Set<string>();
  let raised = 0;
  for (const r of records) {
    if (r.model !== setting.model || !r.usage || r.usage.outputTokens === null) continue;
    const cap = capOf(r.settingVersion);
    const atLowerCap = cap !== null && cap < setting.maxOutputTokens && r.usage.outputTokens >= cap;
    const usd = estimate(r.model, atLowerCap ? { ...r.usage, outputTokens: setting.maxOutputTokens } : r.usage).usd;
    if (!isMoney(usd)) continue;
    costs.push(usd);
    versions.add(String(r.settingVersion));
    questionIds.add(String(r.questionId));
    if (atLowerCap) raised += 1;
  }
  if (costs.length === 0) return null;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    runs: costs.length, meanUsd: round(costs.reduce((a, b) => a + b, 0) / costs.length), maxUsd: round(Math.max(...costs)),
    raisedToCap: raised, settingVersions: [...versions].sort(), questionIds: [...questionIds].sort(),
  };
}

/**
 * The per-run figure a dry run projects with: the mean of the model's
 * recorded runs where there are any, and never below the fixed typical-run
 * assumption (which understated the smaller-vendor phase).
 */
export function projectedRunUsd(recorded: Pick<RecordedRunCost, "meanUsd"> | null, typicalUsd: number | null): { usd: number | null; basis: "recorded_mean" | "typical_assumption_floor" | "typical_assumption_only" } {
  if (!recorded) return { usd: typicalUsd, basis: "typical_assumption_only" };
  if (typicalUsd !== null && typicalUsd > recorded.meanUsd) return { usd: typicalUsd, basis: "typical_assumption_floor" };
  return { usd: recorded.meanUsd, basis: "recorded_mean" };
}

/**
 * How many runs of one cost a cap lets start: a run starts only while
 * spent + its worst case fits in the cap.
 */
export function runsCapAllows(capUsd: number, worstCaseUsd: number, perRunUsd: number): number | null {
  if (!isMoney(capUsd) || !isMoney(worstCaseUsd) || !isMoney(perRunUsd) || perRunUsd === 0) return null;
  if (worstCaseUsd > capUsd) return 0;
  return Math.floor((capUsd - worstCaseUsd) / perRunUsd + 1e-9) + 1;
}

/**
 * Reserve a worst case before each call; settle to the estimate after it.
 * An unknown cost settles at the worst case. A run whose estimate exceeds
 * its worst case stops the benchmark: the ceiling assumption failed.
 */
export class BenchmarkBudget {
  spentUsd: number;
  /**
   * `spentBeforeUsd` is what earlier parts of the same phase booked (a
   * resumed run), so that one cap covers every part of the phase.
   */
  constructor(readonly capUsd: number, readonly spentBeforeUsd = 0) {
    this.spentUsd = spentBeforeUsd;
  }
  canStart(worstCaseUsd: number): boolean {
    return this.spentUsd + worstCaseUsd <= this.capUsd + 1e-9;
  }
  settle(cost: CostEstimate | null, worstCaseUsd: number): { overrun: boolean } {
    const usd = cost && cost.usd !== null ? cost.usd : worstCaseUsd;
    this.spentUsd = Math.round((this.spentUsd + usd) * 1e6) / 1e6;
    return { overrun: cost !== null && cost.usd !== null && cost.usd > worstCaseUsd };
  }
  /**
   * A call OpenAI refused for lack of credit: neither processed nor billed,
   * so nothing is booked, exactly as the lifetime ledger counts it.
   */
  settleNotBilled(): { overrun: boolean } {
    return { overrun: false };
  }
  /** What this part alone has booked. */
  get partUsd(): number {
    return Math.round((this.spentUsd - this.spentBeforeUsd) * 1e6) / 1e6;
  }
}

export type BenchmarkStopReason =
  | "plan_complete"
  | "budget_cap"
  | "worst_case_exceeded"
  | "provider_quota_exhausted"
  | "provider_busy"
  | "service_tier_mismatch"
  | "request_rejected"
  | "repeated_unknown_cost"
  | "unknown_cost_limit"
  | "failure_limit";

/**
 * Runs without a known cost stop the benchmark: two in a row, or three in one
 * invocation whether in a row or not. Each is counted at its worst case
 * against the cap and, for good, against the lifetime ceiling, whether or not
 * anything was billed. So a provider outage, a rate limit (whose refusals
 * typically alternate with successes and never make two in a row) or answers
 * that keep outrunning the deadline must not be allowed to drain the budget
 * one worst case at a time. A stopped run is continued with --resume, and
 * these two counts then start again: a person has looked in between.
 */
export const MAX_CONSECUTIVE_UNKNOWN_COST = 2;
export const MAX_UNKNOWN_COST_RUNS = 3;

export function hasUnknownCost(record: Pick<BenchmarkRecord, "cost">): boolean {
  return !record.cost || record.cost.usd === null;
}

/**
 * A call OpenAI refused for lack of credit: neither processed nor billed. It
 * is not an attempt: it books nothing, it is not a failed run of the phase,
 * and a resumed run makes it again.
 */
export function isCreditRefusal(record: Pick<BenchmarkRecord, "usage" | "httpStatus" | "responseBody">): boolean {
  return !record.usage && isQuotaExhausted(record.httpStatus, record.responseBody);
}

/**
 * A call refused without being processed, which OpenAI does not bill: a
 * credit refusal, or a flex capacity refusal. Neither is an attempt.
 */
export function isNotBilledRefusal(record: RefusalFields): boolean {
  return isCreditRefusal(record) || isFlexBusyRefusal(record);
}

/**
 * What the stop rules count. The two unknown-cost counts are per invocation.
 * `failed` is per phase: a resumed run starts it at the failures of the parts
 * before it, so --max-failed means the same thing however often a run is
 * resumed.
 */
export interface RunCounts {
  consecutiveUnknownCost: number;
  unknownCost: number;
  failed: number;
}

export const NO_RUNS: RunCounts = Object.freeze({ consecutiveUnknownCost: 0, unknownCost: 0, failed: 0 });

export function countRun(counts: RunCounts, record: Pick<BenchmarkRecord, "cost" | "outcome"> & RefusalFields): RunCounts {
  if (isNotBilledRefusal(record)) return counts;
  const unknown = hasUnknownCost(record);
  return {
    consecutiveUnknownCost: unknown ? counts.consecutiveUnknownCost + 1 : 0,
    unknownCost: counts.unknownCost + (unknown ? 1 : 0),
    failed: counts.failed + (record.outcome === "failed" ? 1 : 0),
  };
}

/** The failed runs among a part's records, as the phase counts them: a refusal OpenAI does not bill (credit, flex capacity) is not one. */
export function failedRuns(records: ReadonlyArray<Pick<BenchmarkRecord, "outcome"> & RefusalFields>): number {
  return records.filter((r) => r.outcome === "failed" && !isNotBilledRefusal(r)).length;
}

/**
 * Why the run just recorded must stop the benchmark, or null to go on.
 * `counts` includes it. `maxFailed` is the optional --max-failed: a run that
 * is billed but unusable (cut off at the output cap, say) has a known cost
 * and trips none of the other rules, so without it a run could spend its
 * whole cap on answers that all fail.
 */
export function stopAfterRun(
  record: Pick<BenchmarkRecord, "httpStatus" | "responseBody"> & { requestBody?: string | null },
  overrun: boolean,
  counts: RunCounts,
  maxFailed: number | null = null
): Exclude<BenchmarkStopReason, "plan_complete" | "budget_cap" | "provider_busy"> | null {
  if (overrun) return "worst_case_exceeded";
  if (servedOffRequestedTier(record)) return "service_tier_mismatch";
  if (isQuotaExhausted(record.httpStatus, record.responseBody)) return "provider_quota_exhausted";
  if (isRequestRejected(record.httpStatus)) return "request_rejected";
  if (counts.consecutiveUnknownCost >= MAX_CONSECUTIVE_UNKNOWN_COST) return "repeated_unknown_cost";
  if (counts.unknownCost >= MAX_UNKNOWN_COST_RUNS) return "unknown_cost_limit";
  if (maxFailed !== null && counts.failed > maxFailed) return "failure_limit";
  return null;
}

/**
 * Written to plan.json before a live run's first call: what the run is and
 * what cap it ran under, so that a stopped run can be continued, and only by
 * the same plan under one cap for the whole phase.
 */
export interface BenchmarkPlanFile {
  writtenAt: string;
  /** The fixture versions, joined. */
  questions: string;
  questionIds: string[];
  settingVersions: string[];
  repeats: number;
  repeatsByModel: Record<string, number>;
  /** The length of the whole plan, not of this part. */
  planned: number;
  /** The phase cap this part ran under. */
  capUsd: number;
  startIndex: number;
  /** The directory of the part this one continued, relative to the ledger root; null for a first part. */
  resumedFrom: string | null;
  /** What earlier parts of the phase had booked when this part started. */
  phaseSpentBeforeUsd: number;
  /** The --max-failed limit the phase runs under, or null. */
  maxFailed: number | null;
  /** How many runs of the phase had failed when this part started. */
  phaseFailedBefore: number;
}

export type PlanIdentity = Pick<BenchmarkPlanFile, "questions" | "questionIds" | "settingVersions" | "repeats" | "repeatsByModel" | "planned" | "maxFailed">;

/** The part of a plan file that must be identical for one run to continue another. */
export function planIdentityKey(p: PlanIdentity): string {
  const repeatsByModel = Object.fromEntries(Object.keys(p.repeatsByModel).sort().map((k) => [k, p.repeatsByModel[k]]));
  return JSON.stringify([p.questions, p.questionIds, p.settingVersions, p.repeats, repeatsByModel, p.planned, p.maxFailed]);
}

function readPlanFile(value: unknown): BenchmarkPlanFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
  const whole = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  const byModel = p.repeatsByModel;
  if (typeof p.questions !== "string" || !strings(p.questionIds) || !strings(p.settingVersions) || !whole(p.repeats) || !whole(p.planned) || !whole(p.startIndex)) return null;
  if (!byModel || typeof byModel !== "object" || Array.isArray(byModel) || !Object.values(byModel).every(whole)) return null;
  if (!isMoney(p.capUsd) || !isMoney(p.phaseSpentBeforeUsd)) return null;
  if (!(p.maxFailed === null || whole(p.maxFailed)) || !whole(p.phaseFailedBefore)) return null;
  return value as BenchmarkPlanFile;
}

/**
 * Where a run that continues a stopped one starts, and what the phase has
 * already booked and failed. Everything is read from the stopped run's own
 * files:
 *   - the plan must be the same plan (questions, settings, repeats, length,
 *     and the same --max-failed limit);
 *   - it starts after the last index the stopped run reserved, so no call
 *     that was made, or may have been made, is repeated. The one exception is
 *     a trailing refusal OpenAI did not bill (credit, or flex capacity),
 *     recorded as that index's last call with no reservation left open
 *     after it: that call was not processed, so it is not an attempt, and it
 *     is run again;
 *   - the phase has booked what the stopped run's plan file says came before
 *     it, plus what that run itself booked (`bookedUsd`, its ledger total);
 *   - the phase has failed what came before, plus that run's failed runs.
 * Failed runs are otherwise never retried: they stay failed in the count.
 */
export function resumePoint(
  earlier: {
    plan: unknown;
    records: ReadonlyArray<Pick<BenchmarkRecord, "index" | "outcome"> & RefusalFields>;
    reservations: ReadonlyArray<{ index: number }>;
    bookedUsd: number | null;
  },
  current: PlanIdentity
): { ok: true; startIndex: number; phaseSpentBeforeUsd: number; phaseFailedBefore: number; earlierCapUsd: number } | { ok: false; error: string } {
  const plan = readPlanFile(earlier.plan);
  if (!plan) return { ok: false, error: "the run to resume has no readable plan.json, so what it ran cannot be established" };
  if (planIdentityKey(plan) !== planIdentityKey(current)) return { ok: false, error: "the run to resume ran a different plan (its questions, settings, repeats, length or --max-failed differ from these flags)" };
  if (!isMoney(earlier.bookedUsd)) return { ok: false, error: "what the run to resume spent cannot be counted" };
  const indexes = [...earlier.records, ...earlier.reservations].map((r) => r.index);
  if (indexes.some((i) => !Number.isInteger(i) || i < plan.startIndex || i >= plan.planned)) return { ok: false, error: "the run to resume holds a plan index outside its own plan" };
  const last = indexes.length ? Math.max(...indexes) : plan.startIndex - 1;
  const lastRecord = earlier.records.filter((r) => r.index === last).pop();
  // A reservation for that index beyond its records is a call that may have been billed after the refusal: it is not made again.
  const openAtLast = unsettledReservations(earlier.reservations.filter((x) => x.index === last), earlier.records.filter((r) => r.index === last)).length > 0;
  const startIndex = lastRecord && isNotBilledRefusal(lastRecord) && !openAtLast ? last : last + 1;
  if (startIndex >= plan.planned) return { ok: false, error: "the run to resume has nothing left to run" };
  return {
    ok: true, startIndex,
    phaseSpentBeforeUsd: Math.round((plan.phaseSpentBeforeUsd + earlier.bookedUsd) * 1e6) / 1e6,
    phaseFailedBefore: plan.phaseFailedBefore + failedRuns(earlier.records),
    earlierCapUsd: plan.capUsd,
  };
}

export interface BenchmarkRecord {
  index: number;
  model: string;
  role: "candidate" | "reference";
  settingVersion: string;
  questionId: string;
  repeat: number;
  startedAt: string;
  outcome: "completed" | "failed";
  failure: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  servedModel: string | null;
  providerRequestId: string | null;
  usage: ChatGptUsage | null;
  cost: CostEstimate | null;
  citations: string[];
  retrievedCount: number;
  answerChars: number;
  requestBody: string | null;
  requestBodySha256: string | null;
  responseBody: string | null;
  responseBodySha256: string | null;
  /** Recorded from 2026-11-13; absent on earlier lines. */
  questionSet?: string;
  /** `incomplete_details.reason` of a run the provider stopped (the output cap is "max_output_tokens"). */
  incompleteReason?: string | null;
  /** The worst case reserved before the call: what the ledger counts if the cost stays unknown. */
  reservedWorstCaseUsd?: number;
  callDeadlineMs?: number;
}

/** The failure label of a call the runner's own deadline cut off, as opposed to another network error. */
export const DEADLINE_FAILURE = "network_error:deadline";

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Mean pairwise Jaccard similarity of cited domains across repeats of the same question. Null below two runs. */
export function citedDomainStability(runs: Array<{ citations: string[] }>): number | null {
  if (runs.length < 2) return null;
  const sets = runs.map((r) => new Set(r.citations.map(hostOf).filter((h): h is string => !!h)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const union = new Set([...sets[i], ...sets[j]]);
      const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
      total += union.size === 0 ? 1 : inter / union.size;
      pairs += 1;
    }
  }
  return Math.round((total / pairs) * 1000) / 1000;
}

export interface ModelSummary {
  model: string;
  role: "candidate" | "reference";
  settingVersion: string;
  /** Calls refused unprocessed and not billed (credit, flex capacity): not attempts, so in no figure below. */
  refusedNotBilled: number;
  /** The tier each processed response says served it ("default", "flex", …; "none" when the body names none), with counts. */
  servedServiceTiers: Record<string, number>;
  runs: number;
  completed: number;
  failed: number;
  failures: Record<string, number>;
  /** Runs the provider stopped, by its stated reason; "max_output_tokens" is the output cap. */
  incompleteReasons: Record<string, number>;
  stoppedAtOutputCap: number;
  /** Calls cut off by the runner's own deadline (cost unknown, counted at worst case). */
  deadlineAborts: number;
  servedModels: string[];
  searchRate: number | null;
  meanWebSearchCalls: number | null;
  medianCited: number | null;
  answersWithoutCitation: number;
  medianRetrieved: number | null;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  /** Over every run that returned (completed or not), unlike p50 and p90, which are over completed runs. */
  latencyMaxMs: number | null;
  /** The largest output-token count any run reported (reasoning included): how close the cap came. */
  maxOutputTokens: number | null;
  medianAnswerChars: number | null;
  estimatedCostUsd: number;
  runsWithUnknownCost: number;
  /** Mean over the runs with a known cost, completed or not: what one attempt costs. */
  meanCostPerBilledRunUsd: number | null;
  /** Known cost of ALL runs divided by COMPLETED runs: what one usable answer costs, failed attempts included. */
  meanCostPerCompletedRunUsd: number | null;
  medianCitedDomainStability: number | null;
}

/** The `service_tier` a stored Responses body names; "none" when it names none; null when the body is not a Responses object. */
export function servedTierOfBody(body: string | null): string | null {
  if (!body) return null;
  try {
    const b = JSON.parse(body) as { object?: unknown; service_tier?: unknown } | null;
    if (!b || typeof b !== "object" || b.object !== "response") return null;
    return typeof b.service_tier === "string" ? b.service_tier : "none";
  } catch {
    return null;
  }
}

export function summariseBenchmark(records: BenchmarkRecord[]): ModelSummary[] {
  const byModel = new Map<string, BenchmarkRecord[]>();
  for (const r of records) byModel.set(r.settingVersion, [...(byModel.get(r.settingVersion) ?? []), r]);
  return [...byModel.values()].map((all) => {
    // A refusal OpenAI did not bill is not an attempt: it is counted apart and left out of every figure.
    const rs = all.filter((r) => !isNotBilledRefusal(r));
    const servedServiceTiers: Record<string, number> = {};
    for (const r of rs) {
      const tier = servedTierOfBody(r.responseBody);
      if (tier !== null) servedServiceTiers[tier] = (servedServiceTiers[tier] ?? 0) + 1;
    }
    const done = rs.filter((r) => r.outcome === "completed");
    const failures: Record<string, number> = {};
    for (const r of rs) if (r.outcome === "failed") failures[r.failure ?? "unknown"] = (failures[r.failure ?? "unknown"] ?? 0) + 1;
    const incompleteReasons: Record<string, number> = {};
    for (const r of rs) if (r.incompleteReason) incompleteReasons[r.incompleteReason] = (incompleteReasons[r.incompleteReason] ?? 0) + 1;
    const known = rs.filter((r) => r.cost && r.cost.usd !== null);
    const cost = known.reduce((a, r) => a + (r.cost!.usd as number), 0);
    const byQuestion = new Map<string, BenchmarkRecord[]>();
    for (const r of done) byQuestion.set(r.questionId, [...(byQuestion.get(r.questionId) ?? []), r]);
    const stabilities = [...byQuestion.values()].map(citedDomainStability).filter((x): x is number => x !== null);
    const withUsage = done.filter((r) => r.usage);
    const latencies = done.map((r) => r.latencyMs).filter((x): x is number => x !== null);
    const allLatencies = rs.map((r) => r.latencyMs).filter((x): x is number => x !== null);
    const outputTokens = rs.map((r) => r.usage?.outputTokens).filter((x): x is number => typeof x === "number");
    return {
      model: all[0].model,
      role: all[0].role,
      settingVersion: all[0].settingVersion,
      refusedNotBilled: all.length - rs.length,
      servedServiceTiers,
      runs: rs.length,
      completed: done.length,
      failed: rs.length - done.length,
      failures,
      incompleteReasons,
      stoppedAtOutputCap: incompleteReasons.max_output_tokens ?? 0,
      deadlineAborts: rs.filter((r) => r.failure === DEADLINE_FAILURE).length,
      servedModels: [...new Set(rs.map((r) => r.servedModel).filter((m): m is string => !!m))].sort(),
      searchRate: withUsage.length ? Math.round((withUsage.filter((r) => r.usage!.searchOccurred).length / withUsage.length) * 1000) / 1000 : null,
      meanWebSearchCalls: withUsage.length ? Math.round((withUsage.reduce((a, r) => a + r.usage!.webSearchCalls, 0) / withUsage.length) * 100) / 100 : null,
      medianCited: median(done.map((r) => r.citations.length)),
      answersWithoutCitation: done.filter((r) => r.citations.length === 0).length,
      medianRetrieved: median(done.map((r) => r.retrievedCount)),
      latencyP50Ms: percentile(latencies, 50),
      latencyP90Ms: percentile(latencies, 90),
      latencyMaxMs: allLatencies.length ? Math.max(...allLatencies) : null,
      maxOutputTokens: outputTokens.length ? Math.max(...outputTokens) : null,
      medianAnswerChars: median(done.map((r) => r.answerChars)),
      estimatedCostUsd: Math.round(cost * 1e6) / 1e6,
      runsWithUnknownCost: rs.length - known.length,
      meanCostPerBilledRunUsd: known.length ? Math.round((cost / known.length) * 1e6) / 1e6 : null,
      meanCostPerCompletedRunUsd: done.length && known.length ? Math.round((cost / done.length) * 1e6) / 1e6 : null,
      medianCitedDomainStability: median(stabilities),
    };
  });
}
