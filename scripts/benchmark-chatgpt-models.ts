#!/usr/bin/env tsx
/**
 * X1 (D-050) — benchmark candidate OpenAI models for the ChatGPT engine.
 *
 * DRY RUN BY DEFAULT: prints the plan, the per-run worst case and the
 * budget, and makes no call. A paid run needs ALL of:
 *   --live
 *   --max-usd=<dollars>                      at most 40 (founder, 2026-11-10)
 *   --i-confirm-founder-approved-budget
 *   OPENAI_PROBE_API_KEY in the environment  (the dedicated measurement
 *                                             project's key; never the
 *                                             analysis OPENAI_API_KEY)
 *
 * Optional: --repeats=1..5 (default 5), --questions=<n> (first n of the
 * fixture), --models=gpt-6-luna,chat-latest, --out=<dir>.
 *
 * Safety:
 *   - one call at a time, no retries, a 120-second deadline per call;
 *   - before each call the run's worst case is reserved against the cap and
 *     the benchmark stops when the next run might exceed it; an unknown cost
 *     counts as the worst case; a run costing more than its worst case stops
 *     the benchmark at once;
 *   - output (raw requests and responses) goes to .benchmark-out/, which is
 *     git-ignored, or a directory outside the repository; the key is never
 *     written or printed.
 *
 * Results are a benchmark of the OpenAI API with web search under recorded
 * conditions. They are not observations of ChatGPT.com.
 */
import fs from "node:fs";
import path from "node:path";

import { CHATGPT_BENCHMARK_CANDIDATES, ChatGptProbeFailure, runChatGptProbe } from "@/lib/probes/chatgpt";
import { OPENAI_PRICE_TABLE, worstCaseRunUsd } from "@/lib/probes/chatgpt-pricing";
import {
  BenchmarkBudget,
  BENCHMARK_MAX_RUNS,
  parseBenchmarkArgs,
  planBenchmark,
  summariseBenchmark,
  type BenchmarkQuestion,
  type BenchmarkRecord,
} from "./lib/chatgpt-benchmark";

const CALL_DEADLINE_MS = 120_000;
const REPO = path.resolve(__dirname, "..");

function outputDir(requested: string | null): string {
  const dir = path.resolve(requested ?? path.join(REPO, ".benchmark-out", `chatgpt-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const rel = path.relative(REPO, dir);
  const insideRepo = !rel.startsWith("..") && !path.isAbsolute(rel);
  if (insideRepo && !rel.startsWith(".benchmark-out")) throw new Error("--out inside the repository must be under .benchmark-out/ (git-ignored).");
  return dir;
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

  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/fixtures/chatgpt-benchmark-questions.json"), "utf8")) as { version: string; questions: BenchmarkQuestion[] };
  const questions = fixture.questions.slice(0, args.questionLimit ?? fixture.questions.length);
  const candidates = CHATGPT_BENCHMARK_CANDIDATES.filter((c) => !args.models || args.models.includes(c.setting.model));
  if (args.models && candidates.length !== args.models.length) {
    console.error(`benchmark-chatgpt-models: unknown model in --models (known: ${CHATGPT_BENCHMARK_CANDIDATES.map((c) => c.setting.model).join(", ")})`);
    process.exit(2);
  }
  const plan = planBenchmark(questions, candidates, args.repeats);
  if (plan.length > BENCHMARK_MAX_RUNS) {
    console.error(`benchmark-chatgpt-models: ${plan.length} runs planned; the limit is ${BENCHMARK_MAX_RUNS}.`);
    process.exit(2);
  }

  console.log(`ChatGPT model benchmark — ${args.live ? "LIVE" : "DRY RUN (no calls)"}`);
  console.log(`questions ${fixture.version}: ${questions.length} × repeats ${args.repeats} × models ${candidates.length} = ${plan.length} runs`);
  console.log(`price table ${OPENAI_PRICE_TABLE.version} (${OPENAI_PRICE_TABLE.source})`);
  let worstTotal = 0;
  for (const c of candidates) {
    const worst = worstCaseRunUsd(c.setting.model, c.setting.maxOutputTokens);
    const n = plan.filter((p) => p.setting.version === c.setting.version).length;
    worstTotal += (worst ?? 0) * n;
    console.log(`  ${c.setting.version} (${c.role}): ${n} runs, worst case $${worst?.toFixed(4) ?? "unpriced"} per run`);
  }
  console.log(`worst case if every run hit its ceiling: $${worstTotal.toFixed(2)}`);

  if (!args.live) {
    console.log("\nNo call made. A paid run needs --live --max-usd=<n> --i-confirm-founder-approved-budget and OPENAI_PROBE_API_KEY.");
    return;
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
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    disclaimer: "Benchmark of the OpenAI API with web search under recorded conditions. Not an observation of ChatGPT.com.",
    questions: fixture.version,
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
