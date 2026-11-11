#!/usr/bin/env tsx
/**
 * X1 (D-050) — benchmark candidate OpenAI models for the ChatGPT engine.
 *
 * DRY RUN BY DEFAULT: prints the plan, the per-run worst case and the
 * budget, and makes no call. A paid run needs ALL of:
 *   --live
 *   --max-usd=<dollars>                      this run's cap; at most what is
 *                                             left of the $40 LIFETIME ceiling
 *                                             (founder, 2026-11-10/11), counted
 *                                             from every earlier run recorded
 *                                             under .benchmark-out/
 *   --i-confirm-founder-approved-budget
 *   OPENAI_PROBE_API_KEY in the environment  (the dedicated measurement
 *                                             project's key; never the
 *                                             analysis OPENAI_API_KEY)
 *
 * Optional: --question-set=general|smaller-vendor (default general),
 * --repeats=1..5 (default 5), --repeats-by-model=chat-latest:2,
 * --questions=<n> (first n of the set), --models=gpt-6-luna,chat-latest,
 * --out=<dir under .benchmark-out/>.
 *
 * Safety:
 *   - one call at a time, no retries, a 120-second deadline per call;
 *   - before each call the run's worst case is reserved against the cap and
 *     the benchmark stops when the next run might exceed it; an unknown cost
 *     counts as the worst case; a run costing more than its worst case stops
 *     the benchmark at once;
 *   - output (raw requests and responses) goes to .benchmark-out/, which is
 *     git-ignored and is also the lifetime spend ledger, so nothing may be
 *     written elsewhere; the key is never written or printed.
 *
 * Results are a benchmark of the OpenAI API with web search under recorded
 * conditions. They are not observations of ChatGPT.com.
 */
import fs from "node:fs";
import path from "node:path";

import { CHATGPT_BENCHMARK_CANDIDATES, CHATGPT_MAX_OUTPUT_TOKENS, ChatGptProbeFailure, runChatGptProbe } from "@/lib/probes/chatgpt";
import { OPENAI_PRICE_TABLE, TYPICAL_RUN_ASSUMPTION, typicalRunUsd, worstCaseRunUsd } from "@/lib/probes/chatgpt-pricing";
import {
  BenchmarkBudget,
  BENCHMARK_LIFETIME_CEILING_USD,
  BENCHMARK_MAX_RUNS,
  BENCHMARK_QUESTION_SETS,
  benchmarkSpendLedger,
  remainingLifetimeUsd,
  isQuotaExhausted,
  parseBenchmarkArgs,
  planBenchmark,
  summariseBenchmark,
  type BenchmarkQuestion,
  type BenchmarkRecord,
} from "./lib/chatgpt-benchmark";

const CALL_DEADLINE_MS = 120_000;
const REPO = path.resolve(__dirname, "..");
const LEDGER_ROOT = path.join(REPO, ".benchmark-out");

function outputDir(requested: string | null): string {
  const dir = path.resolve(requested ?? path.join(LEDGER_ROOT, `chatgpt-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const rel = path.relative(LEDGER_ROOT, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("--out must be under .benchmark-out/ (git-ignored, and the lifetime spend ledger).");
  return dir;
}

/** Every runs.jsonl under .benchmark-out/: the record of what earlier runs spent. */
function readLedgerRecords(): BenchmarkRecord[] {
  const out: BenchmarkRecord[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "runs.jsonl") {
        for (const line of fs.readFileSync(p, "utf8").split("\n")) if (line.trim()) out.push(JSON.parse(line) as BenchmarkRecord);
      }
    }
  };
  walk(LEDGER_ROOT);
  return out;
}

function deadlineFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_DEADLINE_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const parsed = parseBenchmarkArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`benchmark-chatgpt-models: ${parsed.error}`);
    process.exit(2);
  }
  const args = parsed.args;

  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, BENCHMARK_QUESTION_SETS[args.questionSet]), "utf8")) as { version: string; questions: BenchmarkQuestion[] };
  const questions = fixture.questions.slice(0, args.questionLimit ?? fixture.questions.length);
  const candidates = CHATGPT_BENCHMARK_CANDIDATES.filter((c) => !args.models || args.models.includes(c.setting.model));
  if (args.models && candidates.length !== args.models.length) {
    console.error(`benchmark-chatgpt-models: unknown model in --models (known: ${CHATGPT_BENCHMARK_CANDIDATES.map((c) => c.setting.model).join(", ")})`);
    process.exit(2);
  }
  const unknownOverride = Object.keys(args.repeatsByModel).find((m) => !candidates.some((c) => c.setting.model === m));
  if (unknownOverride) {
    console.error(`benchmark-chatgpt-models: --repeats-by-model names ${unknownOverride}, which is not in this run.`);
    process.exit(2);
  }
  const plan = planBenchmark(questions, candidates, args.repeats, args.repeatsByModel);
  if (plan.length > BENCHMARK_MAX_RUNS) {
    console.error(`benchmark-chatgpt-models: ${plan.length} runs planned; the limit is ${BENCHMARK_MAX_RUNS}.`);
    process.exit(2);
  }

  console.log(`ChatGPT model benchmark — ${args.live ? "LIVE" : "DRY RUN (no calls)"}`);
  console.log(`questions ${fixture.version} (${questions.length}), ${plan.length} runs in total`);
  console.log(`price table ${OPENAI_PRICE_TABLE.version} (${OPENAI_PRICE_TABLE.source})`);
  const t = TYPICAL_RUN_ASSUMPTION;
  console.log(`typical-run assumption: ${t.inputTokens} input (${t.cachedInputTokens} cached), ${t.outputTokens} output, ${t.webSearchCalls} search call`);
  let worstTotal = 0;
  let typicalTotal = 0;
  for (const c of candidates) {
    const worst = worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens);
    const typical = typicalRunUsd(c.setting.model);
    const n = plan.filter((p) => p.setting.version === c.setting.version).length;
    const reps = args.repeatsByModel[c.setting.model] ?? args.repeats;
    worstTotal += (worst ?? 0) * n;
    typicalTotal += (typical ?? 0) * n;
    console.log(`  ${c.setting.model} (${c.role}, ${c.pinning}): ${questions.length} q × ${reps} = ${n} runs; per run typical $${typical?.toFixed(4) ?? "unpriced"}, worst case $${worst?.toFixed(4) ?? "unpriced"}; typical total $${((typical ?? 0) * n).toFixed(2)}`);
  }
  console.log(`expected total at the typical assumption: $${typicalTotal.toFixed(2)}`);
  console.log(`worst case if every run hit its ceiling: $${worstTotal.toFixed(2)} (the cap stops the run long before this)`);

  const ledger = benchmarkSpendLedger(readLedgerRecords(), (m) => worstCaseRunUsd(m, CHATGPT_MAX_OUTPUT_TOKENS));
  if (!ledger) {
    console.error("benchmark-chatgpt-models: an earlier run's model has no price row; the lifetime spend cannot be counted.");
    process.exit(2);
  }
  const remaining = remainingLifetimeUsd(ledger);
  console.log(`\nlifetime ceiling $${BENCHMARK_LIFETIME_CEILING_USD}: ${ledger.runs} earlier runs — estimated $${ledger.estimatedUsd.toFixed(4)}; ${ledger.refusedNotBilled} refused for no credit (not billed, counted $0); ${ledger.unknownCountedAtWorstCase} unknown (counted at worst case)`);
  console.log(`  spent so far $${ledger.totalUsd.toFixed(4)}, remaining $${remaining.toFixed(4)}`);
  if (args.maxUsd !== null) {
    const maxWorst = Math.max(...candidates.map((c) => worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens) ?? 0));
    console.log(`this run's cap: $${args.maxUsd.toFixed(2)}${args.maxUsd > remaining ? " — EXCEEDS what is left of the lifetime ceiling; a live run would be refused" : " (within the lifetime ceiling)"}`);
    console.log(`  a run starts only if spent + its worst case ≤ cap, so the benchmark can stop once spent passes $${Math.max(0, args.maxUsd - maxWorst).toFixed(2)} (cap minus the largest per-run worst case, $${maxWorst.toFixed(4)})`);
    if (typicalTotal > args.maxUsd - maxWorst) console.log("  the typical total is above that point: expect the run to stop before the end of the plan.");
  }

  if (!args.live) {
    console.log("\nNo call made. A paid run needs --live --max-usd=<n> --i-confirm-founder-approved-budget and OPENAI_PROBE_API_KEY.");
    return;
  }
  if ((args.maxUsd as number) > remaining) {
    console.error(`benchmark-chatgpt-models: --max-usd=${args.maxUsd} exceeds the $${remaining.toFixed(2)} left of the $${BENCHMARK_LIFETIME_CEILING_USD} lifetime ceiling.`);
    process.exit(2);
  }
  if (!process.env.OPENAI_PROBE_API_KEY) {
    console.error("benchmark-chatgpt-models: OPENAI_PROBE_API_KEY is not set.");
    process.exit(2);
  }
  if (candidates.some((c) => worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens) === null)) {
    console.error("benchmark-chatgpt-models: a model has no price row; it cannot be budgeted.");
    process.exit(2);
  }

  const out = outputDir(args.out);
  fs.mkdirSync(out, { recursive: true });
  const runsFile = path.join(out, "runs.jsonl");
  const budget = new BenchmarkBudget(args.maxUsd as number);
  const records: BenchmarkRecord[] = [];
  let stopReason = "plan_complete";

  for (const run of plan) {
    const worst = worstCaseRunUsd(run.setting.model, run.setting.maxOutputTokens) as number;
    if (!budget.canStart(worst)) {
      stopReason = "budget_cap";
      break;
    }
    const startedAt = new Date().toISOString();
    let record: BenchmarkRecord;
    try {
      const r = await runChatGptProbe({ prompt: run.question.text, brandName: "", setting: run.setting, fetchImpl: deadlineFetch() });
      record = {
        index: run.index, model: run.setting.model, role: run.role, settingVersion: run.setting.version,
        questionId: run.question.id, repeat: run.repeat, startedAt, outcome: "completed", failure: null,
        httpStatus: r.httpStatus ?? null, latencyMs: r.latencyMs ?? null, servedModel: r.model,
        providerRequestId: r.providerRequestId ?? null, usage: r.usage, cost: r.cost,
        citations: r.citations, retrievedCount: r.searchResults.length, answerChars: r.answer.length,
        requestBody: r.fullRequestBody ?? null, requestBodySha256: r.fullRequestBodySha256 ?? null,
        responseBody: r.rawResponseBody ?? null, responseBodySha256: r.rawResponseBodySha256 ?? null,
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
      record = {
        index: run.index, model: run.setting.model, role: run.role, settingVersion: run.setting.version,
        questionId: run.question.id, repeat: run.repeat, startedAt, outcome: "failed",
        // The cause only (no provider text): e.g. "http_error:429", "empty_answer:status:incomplete".
        failure: f ? `${f.reason}${f.httpStatus && f.reason === "http_error" ? `:${f.httpStatus}` : ""}${/\(([^)]+)\)\.$/.exec(f.message)?.[1] ? `:${/\(([^)]+)\)\.$/.exec(f.message)![1]}` : ""}` : "not_a_provider_failure",
        httpStatus: f?.httpStatus ?? null, latencyMs: f?.latencyMs ?? null, servedModel: served,
        providerRequestId: f?.providerRequestId ?? null, usage: f?.usage ?? null, cost: f?.cost ?? null,
        citations: [], retrievedCount: 0, answerChars: 0,
        requestBody: f?.fullRequestBody ?? null, requestBodySha256: f?.fullRequestBodySha256 ?? null,
        responseBody: f?.errorBody ?? null, responseBodySha256: f?.errorBodySha256 ?? null,
      };
    }
    records.push(record);
    fs.appendFileSync(runsFile, `${JSON.stringify(record)}\n`);
    const { overrun } = budget.settle(record.cost, worst);
    console.log(`  #${run.index} ${run.setting.model} ${run.question.id} r${run.repeat}: ${record.outcome}${record.failure ? ` (${record.failure})` : ""} — spent so far $${budget.spentUsd.toFixed(4)}`);
    if (overrun) {
      stopReason = "worst_case_exceeded";
      break;
    }
    if (isQuotaExhausted(record.httpStatus, record.responseBody)) {
      stopReason = "provider_quota_exhausted";
      break;
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    disclaimer: "Benchmark of the OpenAI API with web search under recorded conditions. Not an observation of ChatGPT.com.",
    questions: fixture.version,
    questionSet: args.questionSet,
    lifetimeSpendBeforeUsd: ledger.totalUsd,
    priceTable: OPENAI_PRICE_TABLE.version,
    capUsd: args.maxUsd,
    estimatedSpendUsd: budget.spentUsd,
    planned: plan.length,
    executed: records.length,
    stopReason,
    models: summariseBenchmark(records),
  };
  fs.writeFileSync(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${records.length}/${plan.length} runs, stop: ${stopReason}, estimated spend $${budget.spentUsd.toFixed(4)}`);
  console.log(`written: ${path.relative(REPO, out) || out}/runs.jsonl and summary.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
