#!/usr/bin/env tsx
/**
 * X1 (D-050) — benchmark candidate OpenAI models for the ChatGPT engine.
 *
 * DRY RUN BY DEFAULT: prints the plan, the per-run worst case and the
 * budget, and makes no call. A paid run needs ALL of:
 *   --live
 *   --max-usd=<dollars>                      the PHASE cap; what is left of it
 *                                             must fit in what is left of the
 *                                             $40 LIFETIME ceiling (founder,
 *                                             2026-11-10/11), counted from
 *                                             every earlier run recorded
 *                                             under .benchmark-out/
 *   --i-confirm-founder-approved-budget
 *   OPENAI_PROBE_API_KEY in the environment  (the dedicated measurement
 *                                             project's key; never the
 *                                             analysis OPENAI_API_KEY)
 *
 * Optional: --question-set=general|smaller-vendor, or both separated by a
 * comma (default general), --repeats=1..5 (default 5),
 * --repeats-by-model=chat-latest:2, --questions=<n> (first n of each set),
 * --models=gpt-6-luna,chat-latest (each model names exactly one setting),
 * --max-failed=<n> (stop once more than n runs of the phase have failed),
 * --resume=<directory of a stopped run> (continue it under the same cap;
 * a higher cap also needs --i-confirm-founder-approved-higher-cap),
 * --out=<new dir under .benchmark-out/>.
 *
 * The confirmation run (founder chose gpt-5.4-2026-03-05 on 2026-11-13; its
 * setting has the output cap raised to 8000, and since 2026-11-17 it asks for
 * OpenAI's half-price flex tier), as a dry run:
 *   --models=gpt-5.4-2026-03-05 --question-set=general,smaller-vendor --repeats=3 --max-failed=3 --max-usd=12
 *
 * Safety:
 *   - one live run at a time (a lock file), one call at a time, a deadline
 *     per call that follows the setting's output cap (120 s at 4000, 240 s at
 *     8000; 290 s on the flex tier);
 *   - no retries, with one exception: a flex call refused for lack of
 *     capacity (HTTP 429 "Resource Unavailable", which OpenAI does not
 *     charge) waits 30 s, doubling, and is made again, at most 5 times for
 *     one plan index and for at most an hour of waiting per invocation; then
 *     the run stops and --resume makes that index again. Each such call is
 *     reserved and recorded like any other and books nothing;
 *   - a flex request whose response says another tier served it stops the
 *     run at once;
 *   - before each call the run's worst case is reserved against the cap and
 *     written to reservations.jsonl, and the benchmark stops when the next
 *     run might exceed the cap; an unknown cost counts as the worst case; a
 *     run costing more than its worst case stops the benchmark at once;
 *   - the benchmark also stops on a credit refusal, on a rejected request
 *     (HTTP 400, 401, 403, 404), on two runs in a row of unknown cost or
 *     three in all, and past --max-failed failed runs;
 *   - a stopped run is continued with --resume, which reads the start index
 *     and what the phase already booked from that run's own files, so one
 *     cap covers every part and no recorded call is paid for twice;
 *   - a live run is refused when its cap does not fit in what is left of the
 *     lifetime ceiling, or when the local ledger holds less than the spend
 *     the repository records;
 *   - output (raw requests and responses) goes to .benchmark-out/, which is
 *     git-ignored and is also the lifetime spend ledger, so nothing may be
 *     written elsewhere or through a symbolic link; the key is never written
 *     or printed.
 *
 * Results are a benchmark of the OpenAI API with web search under recorded
 * conditions. They are not observations of ChatGPT.com.
 */
import fs from "node:fs";
import path from "node:path";

import { CHATGPT_BENCHMARK_CANDIDATES, ChatGptProbeFailure, maxOutputTokensOfSettingVersion, runChatGptProbe } from "@/lib/probes/chatgpt";
import { OPENAI_PRICE_TABLE, TYPICAL_RUN_ASSUMPTION, estimateChatGptCostUsd, flexAllTokensCostUsd, typicalRunUsd, worstCaseRunUsd, type ChatGptUsage } from "@/lib/probes/chatgpt-pricing";
import {
  BenchmarkBudget,
  BENCHMARK_LIFETIME_CEILING_USD,
  BENCHMARK_MAX_RUNS,
  BENCHMARK_QUESTION_SETS,
  BENCHMARK_SPEND_CHECKPOINT,
  DEADLINE_FAILURE,
  FLEX_BUSY_FAILURE,
  NO_RUNS,
  benchmarkSpendLedger,
  callDeadlineMs,
  capFitsLifetime,
  countRun,
  flexBusyWaitMs,
  incompleteReasonOfBody,
  isFlexBusyRefusal,
  isNotBilledRefusal,
  ledgerCoversCheckpoint,
  mergeQuestionSets,
  recordsThroughCheckpoint,
  parseBenchmarkArgs,
  parseLedgerLines,
  planBenchmark,
  projectedRunUsd,
  recordedRunCost,
  remainingLifetimeUsd,
  resumePoint,
  runsCapAllows,
  stopAfterRun,
  summariseBenchmark,
  unsettledReservations,
  type BenchmarkPlanFile,
  type BenchmarkQuestion,
  type BenchmarkRecord,
  type BenchmarkReservation,
  type BenchmarkStopReason,
  type PlanIdentity,
} from "./lib/chatgpt-benchmark";

const REPO = path.resolve(__dirname, "..");
const LEDGER_ROOT = path.join(REPO, ".benchmark-out");
const LOCK_FILE = path.join(LEDGER_ROOT, "live.lock");
const RUN_FILES = ["runs.jsonl", "reservations.jsonl", "summary.json", "plan.json"];

function fail(message: string): never {
  console.error(`benchmark-chatgpt-models: ${message}`);
  process.exit(2);
}

/**
 * A directory named on the command line, which must lie inside the ledger
 * root: by its path, and by its real path too, because a symbolic link out
 * of the ledger would put a run where the lifetime count cannot see it.
 */
function insideLedger(requested: string, flag: string): string {
  const dir = path.resolve(requested);
  const rel = path.relative(LEDGER_ROOT, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${flag} must be under .benchmark-out/ (git-ignored, and the lifetime spend ledger).`);
  if (!fs.existsSync(LEDGER_ROOT)) throw new Error(`${flag}: .benchmark-out/ does not exist.`);
  let existing = dir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const relReal = path.relative(fs.realpathSync(LEDGER_ROOT), fs.realpathSync(existing));
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new Error(`${flag} leads out of .benchmark-out/ through a symbolic link.`);
  return dir;
}

function outputDir(requested: string | null): string {
  const dir = insideLedger(requested ?? path.join(LEDGER_ROOT, `chatgpt-${new Date().toISOString().replace(/[:.]/g, "-")}`), "--out");
  // A run directory is one run: appending to another run's files would mix two plans' indexes.
  if (RUN_FILES.some((f) => fs.existsSync(path.join(dir, f)))) throw new Error("--out already holds a benchmark run; name a new directory.");
  return dir;
}

/** Each non-empty line as a JSON object; anything else is an error, not a skipped line (see parseLedgerLines). */
function jsonLines(file: string): Array<Record<string, unknown>> {
  return fs.existsSync(file) ? parseLedgerLines(fs.readFileSync(file, "utf8"), path.relative(REPO, file)) : [];
}

function readRunDir(dir: string): { records: BenchmarkRecord[]; reservations: BenchmarkReservation[] } {
  return {
    records: jsonLines(path.join(dir, "runs.jsonl")) as unknown as BenchmarkRecord[],
    reservations: jsonLines(path.join(dir, "reservations.jsonl")) as unknown as BenchmarkReservation[],
  };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Every run directory under .benchmark-out/: the records of what earlier runs
 * spent, the reservations a killed process never settled, and which run each
 * resumed run continued. Symbolic links are refused, not followed or skipped.
 */
function readLedger(): { records: BenchmarkRecord[]; unsettled: BenchmarkReservation[]; continued: Array<{ dir: string; resumedFrom: string }> } {
  const records: BenchmarkRecord[] = [];
  const unsettled: BenchmarkReservation[] = [];
  const continued: Array<{ dir: string; resumedFrom: string }> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const run = readRunDir(dir);
    records.push(...run.records);
    unsettled.push(...unsettledReservations(run.reservations, run.records));
    const plan = readJsonFile(path.join(dir, "plan.json")) as { resumedFrom?: unknown } | null;
    if (plan && typeof plan.resumedFrom === "string") continued.push({ dir: path.relative(LEDGER_ROOT, dir), resumedFrom: plan.resumedFrom });
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw new Error(`${path.relative(REPO, path.join(dir, e.name))} is a symbolic link; the ledger does not follow links, so the lifetime spend cannot be counted.`);
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  };
  walk(LEDGER_ROOT);
  return { records, unsettled, continued };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One live run at a time. The lifetime check reads the ledger once, at the
 * start, so it is only sound if no other run is spending while this one
 * does: two overlapping runs would each pass it and could together pass the
 * ceiling. The lock is created exclusively and never taken over: after a
 * killed run a person deletes it.
 */
function acquireLiveLock(info: Record<string, unknown>): void {
  fs.mkdirSync(LEDGER_ROOT, { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(LOCK_FILE, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = (readJsonFile(LOCK_FILE) ?? {}) as { pid?: unknown; startedAt?: unknown };
    const dead = typeof owner.pid === "number" && !processAlive(owner.pid);
    fail(`another live run holds .benchmark-out/live.lock (pid ${String(owner.pid)}, started ${String(owner.startedAt)}). ${dead ? "That process is no longer running; any call it had reserved is already counted. Delete the lock file to continue." : "Wait for it to finish."}`);
  }
  fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...info })}\n`);
  fs.closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      // Already gone: nothing to release.
    }
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      release();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** One deadline for the whole call, body included; `timedOut` says whether it was what ended the call. */
function callDeadline(ms: number): { fetchImpl: typeof fetch; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, ms);
  return {
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal })) as typeof fetch,
    timedOut: () => fired,
    dispose: () => clearTimeout(timer),
  };
}

async function main(): Promise<void> {
  const parsed = parseBenchmarkArgs(process.argv.slice(2));
  if (!parsed.ok) fail(parsed.error);
  const args = parsed.args;

  const merged = mergeQuestionSets(
    args.questionSets.map((name) => ({ name, ...(JSON.parse(fs.readFileSync(path.join(REPO, BENCHMARK_QUESTION_SETS[name]), "utf8")) as { version: string; questions: BenchmarkQuestion[] }) })),
    args.questionLimit
  );
  if (!merged) fail("two questions in the chosen sets share an id.");
  const questions = merged.questions;
  const candidates = CHATGPT_BENCHMARK_CANDIDATES.filter((c) => !args.models || args.models.includes(c.setting.model));
  if (args.models && candidates.length !== args.models.length) {
    fail(`unknown model in --models (known: ${CHATGPT_BENCHMARK_CANDIDATES.map((c) => c.setting.model).join(", ")})`);
  }
  const unknownOverride = Object.keys(args.repeatsByModel).find((m) => !candidates.some((c) => c.setting.model === m));
  if (unknownOverride) fail(`--repeats-by-model names ${unknownOverride}, which is not in this run.`);
  const fullPlan = planBenchmark(questions, candidates, args.repeats, args.repeatsByModel);
  const identity: PlanIdentity = {
    questions: merged.version, questionIds: questions.map((q) => q.id), settingVersions: candidates.map((c) => c.setting.version),
    repeats: args.repeats, repeatsByModel: args.repeatsByModel, planned: fullPlan.length, maxFailed: args.maxFailed,
  };

  // Taken before the ledger is read: the checks below are only sound while no other run is spending.
  if (args.live) acquireLiveLock({ capUsd: args.maxUsd, out: args.out, resume: args.resume });
  const earlier = readLedger();

  // A resumed run takes its start index and the phase's spend from the stopped run's own files.
  let startIndex = 0;
  let phaseSpentBeforeUsd = 0;
  let resumedFrom: string | null = null;
  let phaseFailedBefore = 0;
  let earlierCapUsd: number | null = null;
  if (args.resume !== null) {
    const dir = insideLedger(args.resume, "--resume");
    resumedFrom = path.relative(LEDGER_ROOT, dir);
    const continuedBy = earlier.continued.find((c) => c.resumedFrom === resumedFrom);
    if (continuedBy) fail(`--resume: that run was already continued by .benchmark-out/${continuedBy.dir}; resume the latest part instead.`);
    const run = readRunDir(dir);
    const booked = benchmarkSpendLedger(run.records, worstCaseRunUsd, maxOutputTokensOfSettingVersion, unsettledReservations(run.reservations, run.records));
    const point = resumePoint({ plan: readJsonFile(path.join(dir, "plan.json")), records: run.records, reservations: run.reservations, bookedUsd: booked?.totalUsd ?? null }, identity);
    if (!point.ok) fail(`--resume: ${point.error}.`);
    startIndex = point.startIndex;
    phaseSpentBeforeUsd = point.phaseSpentBeforeUsd;
    phaseFailedBefore = point.phaseFailedBefore;
    earlierCapUsd = point.earlierCapUsd;
  }
  const plan = fullPlan.slice(startIndex);
  // A dry run still prints an over-limit plan; only a live run is refused.
  const overRunLimit = plan.length > BENCHMARK_MAX_RUNS;
  if (overRunLimit && args.live) fail(`${plan.length} runs planned; the limit is ${BENCHMARK_MAX_RUNS}.`);

  console.log(`ChatGPT model benchmark — ${args.live ? "LIVE" : "DRY RUN (no calls)"}`);
  console.log(`questions ${merged.version} (${questions.length}), ${plan.length} runs${resumedFrom !== null ? ` left of ${fullPlan.length}` : " in total"}${overRunLimit ? ` — OVER the ${BENCHMARK_MAX_RUNS}-run limit: a live run would be refused (narrow it with --models, --repeats or --questions)` : ""}`);
  if (resumedFrom !== null) console.log(`resuming .benchmark-out/${resumedFrom}: plan indexes ${startIndex} to ${fullPlan.length - 1}; the phase has booked $${phaseSpentBeforeUsd.toFixed(4)} and has ${phaseFailedBefore} failed run${phaseFailedBefore === 1 ? "" : "s"} so far`);
  // A phase that has already failed past its limit cannot pass: it is not continued.
  const overFailureLimit = args.maxFailed !== null && phaseFailedBefore > args.maxFailed;
  if (overFailureLimit) console.log(`  the phase already has more failed runs than --max-failed=${args.maxFailed} allows: a live run would be refused`);
  // A resumed run keeps the phase cap. Raising it is a new founder decision, said with its own switch.
  const raisesCap = earlierCapUsd !== null && args.maxUsd !== null && args.maxUsd > earlierCapUsd + 1e-9;
  console.log(`price table ${OPENAI_PRICE_TABLE.version} (${OPENAI_PRICE_TABLE.source})`);
  const t = TYPICAL_RUN_ASSUMPTION;
  console.log(`typical-run assumption (a floor, and the only basis where no run of a model is recorded): ${t.inputTokens} input (${t.cachedInputTokens} cached), ${t.outputTokens} output, ${t.webSearchCalls} search call`);

  let worstTotal = 0;
  let projectedTotal = 0;
  let highestRecorded: number | null = null;
  for (const c of candidates) {
    const s = c.setting;
    const worst = worstCaseRunUsd(s.model, s.maxOutputTokens);
    // A flex setting's projection prices the recorded runs as if flex had served them (output at the flex rate, input at the standard one).
    const estimateUnder = (model: string, usage: ChatGptUsage) => estimateChatGptCostUsd(model, s.serviceTier === null ? usage : { ...usage, serviceTier: s.serviceTier });
    const recorded = recordedRunCost(earlier.records, s, estimateUnder, maxOutputTokensOfSettingVersion);
    const projected = projectedRunUsd(recorded, typicalRunUsd(s.model));
    const n = plan.filter((p) => p.setting.version === s.version).length;
    worstTotal += (worst ?? 0) * n;
    projectedTotal += (projected.usd ?? 0) * n;
    if (recorded) highestRecorded = Math.max(highestRecorded ?? 0, recorded.maxUsd);
    console.log(`  ${s.version} (${c.role}, ${c.pinning})`);
    console.log(`    search ${s.search}, reasoning ${s.reasoningEffort ?? "not sent"}, max_output_tokens ${s.maxOutputTokens}, service tier ${s.serviceTier ?? "default (not sent)"}, served model ${s.servedModelRule}, deadline ${callDeadlineMs(s.maxOutputTokens, s.serviceTier) / 1000} s per call`);
    console.log(`    ${n} runs; worst case $${worst?.toFixed(4) ?? "unpriced"} per run`);
    if (!recorded) {
      console.log(`    projection: $${projected.usd?.toFixed(4) ?? "unpriced"} per run, $${((projected.usd ?? 0) * n).toFixed(2)} for these runs — the typical-run assumption only: no run of this model is recorded`);
    } else {
      const underThis = recorded.settingVersions.includes(s.version);
      const coveredQuestions = questions.filter((q) => recorded.questionIds.includes(q.id)).length;
      console.log(`    projection: $${projected.usd?.toFixed(4) ?? "unpriced"} per run, $${((projected.usd ?? 0) * n).toFixed(2)} for these runs — ${projected.basis === "recorded_mean" ? "the mean" : `the typical-run assumption, which is above the $${recorded.meanUsd.toFixed(4)} mean`} of ${recorded.runs} recorded runs of this model (highest $${recorded.maxUsd.toFixed(4)})`);
      console.log(`      basis: recorded under ${recorded.settingVersions.join(", ")}${underThis ? "" : " — NONE under this setting version"}; they cover ${coveredQuestions} of the ${questions.length} planned questions${recorded.raisedToCap ? `; the ${recorded.raisedToCap} that stopped at a lower output cap are counted at ${s.maxOutputTokens}` : ""}${s.serviceTier === "flex" ? "; priced as if flex served them: output at the flex rate, input and search calls at the standard rate (an upper bound)" : ""}`);
    }
  }
  console.log(`projected total: $${projectedTotal.toFixed(2)} (a projection from the basis above, not a measurement of these runs)`);
  console.log(`worst case if every run hit its ceiling: $${worstTotal.toFixed(2)} (the cap stops the run long before this)`);
  if (args.maxFailed !== null) console.log(`the run stops once more than ${args.maxFailed} runs have failed`);

  const ledger = benchmarkSpendLedger(earlier.records, worstCaseRunUsd, maxOutputTokensOfSettingVersion, earlier.unsettled);
  if (!ledger) fail("an earlier run of unknown cost has no price row or an unknown setting family, or a recorded amount is not a number; the lifetime spend cannot be counted.");
  const remaining = remainingLifetimeUsd(ledger);
  // The repository's own record of earlier spend is a floor for the same period, whatever came later.
  const throughCheckpoint = benchmarkSpendLedger(recordsThroughCheckpoint(earlier.records), worstCaseRunUsd, maxOutputTokensOfSettingVersion);
  const covered = ledgerCoversCheckpoint(throughCheckpoint);
  console.log(`\nlifetime ceiling $${BENCHMARK_LIFETIME_CEILING_USD}: ${ledger.runs} earlier runs — estimated $${ledger.estimatedUsd.toFixed(4)}; ${ledger.refusedNotBilled} refused unprocessed (no credit, or flex capacity: not billed, counted $0); ${ledger.unknownCountedAtWorstCase} unknown (counted at worst case); ${ledger.unsettledReservations} reserved but never recorded (counted at the reservation)`);
  console.log(`  spent so far $${ledger.totalUsd.toFixed(4)}, remaining $${remaining.toFixed(4)}`);
  console.log(`  the repository records ${BENCHMARK_SPEND_CHECKPOINT.runs} runs and $${BENCHMARK_SPEND_CHECKPOINT.usd.toFixed(4)} through ${BENCHMARK_SPEND_CHECKPOINT.through.slice(0, 10)}; this ledger holds ${throughCheckpoint?.runs ?? 0} runs and $${(throughCheckpoint?.totalUsd ?? 0).toFixed(4)} from that period: ${covered ? "covered" : "IT HOLDS LESS — earlier output is missing from .benchmark-out/, and a live run would be refused"}`);
  // What this part may still book: the phase cap less what earlier parts of the phase booked.
  const room = args.maxUsd === null ? null : Math.round((args.maxUsd - phaseSpentBeforeUsd) * 1e6) / 1e6;
  if (args.maxUsd !== null && room !== null) {
    const maxWorst = Math.max(...candidates.map((c) => worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens) ?? 0));
    const stopPoint = Math.max(0, args.maxUsd - maxWorst);
    console.log(`this ${resumedFrom !== null ? "phase's" : "run's"} cap: $${args.maxUsd.toFixed(2)}${resumedFrom !== null ? `, of which $${Math.max(0, room).toFixed(4)} is left for this part` : ""}${capFitsLifetime(room, remaining) ? " (within the lifetime ceiling)" : room <= 0 ? " — NOTHING is left of it; a live run would be refused" : " — EXCEEDS what is left of the lifetime ceiling; a live run would be refused"}`);
    if (raisesCap) console.log(`  NOTE: the run being resumed had a $${(earlierCapUsd as number).toFixed(2)} cap. $${args.maxUsd.toFixed(2)} is a HIGHER phase cap: it needs its own founder approval, and a live run needs --i-confirm-founder-approved-higher-cap${args.higherCapConfirmed ? " (given)" : " (NOT given: a live run would be refused)"}.`);
    console.log(`  a run starts only if spent + its worst case ≤ cap, so the benchmark can stop once ${resumedFrom !== null ? "the phase's spend" : "spent"} passes $${stopPoint.toFixed(2)} (cap minus the largest per-run worst case, $${maxWorst.toFixed(4)})`);
    if (candidates.length === 1 && plan.length > 0) {
      const atMean = runsCapAllows(Math.max(0, room), maxWorst, projectedTotal / plan.length);
      const atHighest = highestRecorded === null ? null : runsCapAllows(Math.max(0, room), maxWorst, highestRecorded);
      console.log(`  that allows ${atMean ?? "?"} runs at the projected cost${atHighest === null ? "" : ` and ${atHighest} if every run cost as much as the highest recorded`}; ${plan.length} are planned`);
    }
    if (projectedTotal > stopPoint - phaseSpentBeforeUsd) console.log("  the projected total is above that point: expect the run to stop before the end of the plan.");
  }

  if (!args.live) {
    console.log("\nNo call made. A paid run needs --live --max-usd=<n> --i-confirm-founder-approved-budget and OPENAI_PROBE_API_KEY.");
    return;
  }
  if (overFailureLimit) fail(`--resume: the phase already has ${phaseFailedBefore} failed runs, more than --max-failed=${args.maxFailed} allows. It cannot pass, so it is not continued.`);
  if (raisesCap && !args.higherCapConfirmed) fail(`--resume: the run being resumed had a $${(earlierCapUsd as number).toFixed(2)} cap; --max-usd=${args.maxUsd} would raise the phase cap. A higher cap needs the founder's approval and --i-confirm-founder-approved-higher-cap.`);
  if (!covered) fail(`the local ledger holds less than the ${BENCHMARK_SPEND_CHECKPOINT.runs} runs and $${BENCHMARK_SPEND_CHECKPOINT.usd.toFixed(2)} the repository records through ${BENCHMARK_SPEND_CHECKPOINT.through.slice(0, 10)}; restore the earlier output under .benchmark-out/ before spending.`);
  if (!capFitsLifetime(room, remaining)) fail(`--max-usd=${args.maxUsd} leaves $${(room ?? 0).toFixed(2)} for this run, which does not fit in the $${remaining.toFixed(2)} left of the $${BENCHMARK_LIFETIME_CEILING_USD} lifetime ceiling (or nothing is left of the phase cap).`);
  if (!process.env.OPENAI_PROBE_API_KEY) fail("OPENAI_PROBE_API_KEY is not set.");
  if (candidates.some((c) => worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens) === null)) fail("a model has no price row; it cannot be budgeted.");
  // No run directory is created for a run that could not make a single call.
  const firstWorst = plan.length ? (worstCaseRunUsd(plan[0].setting.model, plan[0].setting.maxOutputTokens) as number) : 0;
  if (plan.length === 0 || (room as number) < firstWorst) fail(plan.length === 0 ? "the plan has no runs." : `$${(room as number).toFixed(4)} is left of the $${(args.maxUsd as number).toFixed(2)} cap, less than the $${firstWorst.toFixed(4)} a run reserves. A higher --max-usd needs the founder's approval first.`);

  const out = outputDir(args.out);
  fs.mkdirSync(out, { recursive: true });
  const runsFile = path.join(out, "runs.jsonl");
  const reservationsFile = path.join(out, "reservations.jsonl");
  const planFile: BenchmarkPlanFile = { writtenAt: new Date().toISOString(), ...identity, capUsd: args.maxUsd as number, startIndex, resumedFrom, phaseSpentBeforeUsd, phaseFailedBefore };
  // Written before any call: what this run is, for whoever has to continue it.
  fs.writeFileSync(path.join(out, "plan.json"), `${JSON.stringify(planFile, null, 2)}\n`);
  const budget = new BenchmarkBudget(args.maxUsd as number, phaseSpentBeforeUsd);
  const records: BenchmarkRecord[] = [];
  let stopReason: BenchmarkStopReason = "plan_complete";
  // The failure count is the phase's; the unknown-cost counts start again with each invocation.
  let counts = { ...NO_RUNS, failed: phaseFailedBefore };
  // Flex capacity refusals: calls made again for the current index, and the waiting done in this invocation.
  let busyRetries = 0;
  let busyWaitedMs = 0;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  for (let i = 0; i < plan.length; i += 1) {
    const run = plan[i];
    const worst = worstCaseRunUsd(run.setting.model, run.setting.maxOutputTokens) as number;
    if (!budget.canStart(worst)) {
      stopReason = "budget_cap";
      break;
    }
    const startedAt = new Date().toISOString();
    const deadlineMs = callDeadlineMs(run.setting.maxOutputTokens, run.setting.serviceTier);
    const identityOfRun = {
      index: run.index, model: run.setting.model, role: run.role, settingVersion: run.setting.version,
      questionId: run.question.id, questionSet: merged.setOfQuestion.get(run.question.id) ?? "", repeat: run.repeat, startedAt,
    };
    // Written before the call: a process killed mid-call still leaves this for the lifetime ledger.
    const reservation: BenchmarkReservation = {
      index: run.index, model: run.setting.model, settingVersion: run.setting.version,
      questionId: run.question.id, repeat: run.repeat, startedAt, reservedWorstCaseUsd: worst,
    };
    fs.appendFileSync(reservationsFile, `${JSON.stringify(reservation)}\n`);
    const deadline = callDeadline(deadlineMs);
    let record: BenchmarkRecord;
    try {
      const r = await runChatGptProbe({ prompt: run.question.text, brandName: "", setting: run.setting, fetchImpl: deadline.fetchImpl });
      record = {
        ...identityOfRun, outcome: "completed", failure: null,
        httpStatus: r.httpStatus ?? null, latencyMs: r.latencyMs ?? null, servedModel: r.model,
        providerRequestId: r.providerRequestId ?? null, usage: r.usage, cost: r.cost,
        citations: r.citations, retrievedCount: r.searchResults.length, answerChars: r.answer.length,
        requestBody: r.fullRequestBody ?? null, requestBodySha256: r.fullRequestBodySha256 ?? null,
        responseBody: r.rawResponseBody ?? null, responseBodySha256: r.rawResponseBodySha256 ?? null,
        incompleteReason: null, reservedWorstCaseUsd: worst, callDeadlineMs: deadlineMs,
      };
    } catch (e) {
      const f = e instanceof ChatGptProbeFailure ? e : null;
      let served: string | null = null;
      try {
        const m = f?.errorBody ? (JSON.parse(f.errorBody) as { model?: unknown }).model : null;
        served = typeof m === "string" ? m : null;
      } catch {
        served = null;
      }
      const cause = f ? /\(([^)]+)\)\.$/.exec(f.message)?.[1] : undefined;
      record = {
        ...identityOfRun, outcome: "failed",
        // The cause only (no provider text): e.g. "http_error:429", "empty_answer:status:incomplete", "network_error:deadline".
        failure: !f ? "not_a_provider_failure"
          : f.reason === "network_error" && deadline.timedOut() ? DEADLINE_FAILURE
          : `${f.reason}${f.httpStatus && f.reason === "http_error" ? `:${f.httpStatus}` : ""}${cause ? `:${cause}` : ""}`,
        httpStatus: f?.httpStatus ?? null, latencyMs: f?.latencyMs ?? null, servedModel: served,
        providerRequestId: f?.providerRequestId ?? null, usage: f?.usage ?? null, cost: f?.cost ?? null,
        citations: [], retrievedCount: 0, answerChars: 0,
        requestBody: f?.fullRequestBody ?? null, requestBodySha256: f?.fullRequestBodySha256 ?? null,
        responseBody: f?.errorBody ?? null, responseBodySha256: f?.errorBodySha256 ?? null,
        incompleteReason: incompleteReasonOfBody(f?.errorBody ?? null), reservedWorstCaseUsd: worst, callDeadlineMs: deadlineMs,
      };
    } finally {
      deadline.dispose();
    }
    const busy = isFlexBusyRefusal(record);
    if (busy) record = { ...record, failure: FLEX_BUSY_FAILURE };
    records.push(record);
    fs.appendFileSync(runsFile, `${JSON.stringify(record)}\n`);
    if (busy) {
      // Not processed and, OpenAI says, not charged: nothing is booked or counted, and the same index is made again after a wait.
      budget.settleNotBilled();
      const wait = flexBusyWaitMs(busyRetries, busyWaitedMs);
      console.log(`  #${run.index} ${run.setting.model} ${run.question.id} r${run.repeat}: flex capacity refusal (HTTP 429, not charged) — ${wait === null ? "no wait left, stopping" : `waiting ${wait / 1000} s, then calling again`}`);
      if (wait === null) {
        stopReason = "provider_busy";
        break;
      }
      busyRetries += 1;
      busyWaitedMs += wait;
      await sleep(wait);
      i -= 1; // the same plan index again
      continue;
    }
    busyRetries = 0;
    // A refusal OpenAI does not bill (credit) is booked at nothing, as the ledger counts it; every other unknown cost at the worst case.
    const notBilled = isNotBilledRefusal(record);
    const { overrun } = notBilled ? budget.settleNotBilled() : budget.settle(record.cost, worst);
    counts = countRun(counts, record);
    console.log(`  #${run.index} ${run.setting.model} ${run.question.id} r${run.repeat}: ${record.outcome}${record.failure ? ` (${record.failure}${record.incompleteReason ? `, ${record.incompleteReason}` : ""})` : ""}${record.latencyMs !== null ? ` in ${Math.round(record.latencyMs / 1000)} s` : ""} — spent so far $${budget.partUsd.toFixed(4)}${resumedFrom !== null ? ` (phase $${budget.spentUsd.toFixed(4)})` : ""}`);
    const stop = stopAfterRun(record, overrun, counts, args.maxFailed);
    if (stop) {
      stopReason = stop;
      break;
    }
  }

  // Where a resumed run would start: after the last recorded index, or at it when that call was refused unprocessed (no credit, or no flex capacity).
  const lastIndex = records.length ? records[records.length - 1].index : null;
  const nextIndex = lastIndex === null ? startIndex : stopReason === "provider_quota_exhausted" || stopReason === "provider_busy" ? lastIndex : lastIndex + 1;
  // For the report only: what was booked, less what flex would save if it halved the input tokens too (not documented).
  // Everything else, unknown costs at their worst case included, is booked exactly as the budget booked it.
  const flexInputSavingUsd = records.reduce((a, r) => {
    const usd = r.cost ? r.cost.usd : null;
    const lower = usd !== null && r.usage ? flexAllTokensCostUsd(r.model, r.usage) : null;
    return usd === null || lower === null ? a : a + (usd - lower);
  }, 0);
  const spendIfFlexHalvesInputUsd = Math.round((budget.partUsd - flexInputSavingUsd) * 1e6) / 1e6;
  const summary = {
    generatedAt: new Date().toISOString(),
    disclaimer: "Benchmark of the OpenAI API with web search under recorded conditions. Not an observation of ChatGPT.com.",
    questions: merged.version,
    questionSet: args.questionSets.join("+"),
    questionIds: questions.map((q) => q.id),
    settings: candidates.map((c) => ({ ...c.setting, role: c.role, pinning: c.pinning, callDeadlineMs: callDeadlineMs(c.setting.maxOutputTokens, c.setting.serviceTier) })),
    repeats: args.repeats,
    repeatsByModel: args.repeatsByModel,
    maxFailed: args.maxFailed,
    startIndex,
    resumedFrom,
    lifetimeSpendBeforeUsd: ledger.totalUsd,
    priceTable: OPENAI_PRICE_TABLE.version,
    capUsd: args.maxUsd,
    /** What this part booked; the phase total, earlier parts included, is phaseSpentUsd. */
    estimatedSpendUsd: budget.partUsd,
    /**
     * Report only: this part's known-cost runs priced as if flex also halved
     * their input tokens (OpenAI does not say it does). OpenAI's usage page
     * settles which figure is right.
     */
    estimatedSpendIfFlexHalvesInputUsd: spendIfFlexHalvesInputUsd,
    /** Calls refused unprocessed (no credit, no flex capacity): not attempts, booked at nothing. */
    refusedNotBilled: records.filter((r) => isNotBilledRefusal(r)).length,
    flexBusyWaitedMs: busyWaitedMs,
    phaseSpentBeforeUsd,
    phaseSpentUsd: budget.spentUsd,
    /** Failed runs of the phase, earlier parts included; a call refused for lack of credit is not one. */
    phaseFailedBefore,
    phaseFailed: counts.failed,
    planned: fullPlan.length,
    executed: records.length,
    stopReason,
    /** The plan index a resumed run would start at; equal to `planned` when nothing is left. */
    nextIndex,
    models: summariseBenchmark(records),
    /** Per question set, because the sets differ in length and cost and must not be read as one pool. */
    bySet: Object.fromEntries(args.questionSets.map((set) => [set, summariseBenchmark(records.filter((r) => r.questionSet === set))])),
  };
  fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const refusedCount = records.filter((r) => isNotBilledRefusal(r)).length;
  console.log(`\n${records.length - refusedCount}/${plan.length} runs${refusedCount ? ` (and ${refusedCount} call${refusedCount === 1 ? "" : "s"} refused unprocessed, not billed; ${Math.round(busyWaitedMs / 1000)} s spent waiting for flex capacity)` : ""}, stop: ${stopReason}, estimated spend $${budget.partUsd.toFixed(4)}${resumedFrom !== null ? ` (phase $${budget.spentUsd.toFixed(4)} of the $${(args.maxUsd as number).toFixed(2)} cap)` : ""}`);
  if (spendIfFlexHalvesInputUsd < budget.partUsd - 1e-6) console.log(`  that is an upper bound; if flex also halved the input tokens it would be $${spendIfFlexHalvesInputUsd.toFixed(4)} (check OpenAI's usage page)`);
  if (stopReason !== "plan_complete") {
    console.log(`stopped before the end of the plan (a resumed run would start at plan index ${nextIndex} of ${fullPlan.length}). To continue, repeat the same flags plus --resume=${path.relative(REPO, out)} and a new --out: --max-usd is then the cap for both parts together, and no call that reached the model is made again.`);
    if (stopReason === "budget_cap") console.log("The cap is used up, so continuing needs a higher --max-usd, and a higher cap needs the founder's approval first.");
    if (stopReason === "provider_quota_exhausted") console.log("The last call was refused for lack of credit: it was not processed or billed, and a resumed run makes it again.");
    if (stopReason === "provider_busy") console.log("Flex had no capacity for the last index after every wait: those calls were not processed or charged, and a resumed run makes the index again.");
    if (stopReason === "service_tier_mismatch") console.log("A flex request was served on another tier, so the setting was not honoured (and that call may be billed at the standard rate). This goes back to the founder before anything else is run.");
  }
  console.log(`written: ${path.relative(REPO, out) || out}/plan.json, runs.jsonl, reservations.jsonl and summary.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
