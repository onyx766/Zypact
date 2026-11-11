/**
 * X1 (D-050) — the ChatGPT model benchmark's pure logic: arguments, plan,
 * budget guard and summary. No provider call and no file access here, so
 * every rule is tested offline (scripts/test-chatgpt-adapter.ts). The runner
 * is scripts/benchmark-chatgpt-models.ts.
 */
import type { ChatGptSetting } from "@/lib/probes/chatgpt";
import type { ChatGptUsage, CostEstimate } from "@/lib/probes/chatgpt-pricing";

/** Founder, 2026-11-10: the benchmark stops itself at $40; the project hard limit is $50. */
export const BENCHMARK_HARD_CEILING_USD = 40;
export const BENCHMARK_MAX_RUNS = 150;
export const BENCHMARK_MAX_REPEATS = 5;

export interface BenchmarkQuestion {
  id: string;
  category: "discovery" | "comparison" | "evaluation" | "use_case";
  text: string;
}

export interface BenchmarkArgs {
  live: boolean;
  maxUsd: number | null;
  confirmed: boolean;
  repeats: number;
  questionLimit: number | null;
  models: string[] | null;
  out: string | null;
}

export function parseBenchmarkArgs(argv: string[]): { ok: true; args: BenchmarkArgs } | { ok: false; error: string } {
  const args: BenchmarkArgs = { live: false, maxUsd: null, confirmed: false, repeats: BENCHMARK_MAX_REPEATS, questionLimit: null, models: null, out: null };
  for (const a of argv) {
    const [k, v] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    if (k === "--live") args.live = true;
    else if (k === "--i-confirm-founder-approved-budget") args.confirmed = true;
    else if (k === "--max-usd") args.maxUsd = Number(v);
    else if (k === "--repeats") args.repeats = Number(v);
    else if (k === "--questions") args.questionLimit = Number(v);
    else if (k === "--models") args.models = v.split(",").map((m) => m.trim()).filter(Boolean);
    else if (k === "--out") args.out = v;
    else return { ok: false, error: `unknown argument ${k}` };
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > BENCHMARK_MAX_REPEATS) return { ok: false, error: `--repeats must be 1..${BENCHMARK_MAX_REPEATS}` };
  if (args.questionLimit !== null && (!Number.isInteger(args.questionLimit) || args.questionLimit < 1)) return { ok: false, error: "--questions must be a positive integer" };
  if (args.live) {
    if (args.maxUsd === null || !Number.isFinite(args.maxUsd) || args.maxUsd <= 0) return { ok: false, error: "--live needs --max-usd=<dollars>" };
    if (args.maxUsd > BENCHMARK_HARD_CEILING_USD) return { ok: false, error: `--max-usd may not exceed ${BENCHMARK_HARD_CEILING_USD}` };
    if (!args.confirmed) return { ok: false, error: "--live needs --i-confirm-founder-approved-budget" };
  }
  return { ok: true, args };
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
  repeats: number
): PlannedRun[] {
  const plan: PlannedRun[] = [];
  for (let r = 1; r <= repeats; r += 1) {
    for (const q of questions) {
      for (const c of candidates) plan.push({ index: plan.length, question: q, repeat: r, role: c.role, setting: c.setting });
    }
  }
  return plan;
}

/**
 * Reserve a worst case before each call; settle to the estimate after it.
 * An unknown cost settles at the worst case. A run whose estimate exceeds
 * its worst case stops the benchmark: the ceiling assumption failed.
 */
export class BenchmarkBudget {
  spentUsd = 0;
  constructor(readonly capUsd: number) {}
  canStart(worstCaseUsd: number): boolean {
    return this.spentUsd + worstCaseUsd <= this.capUsd + 1e-9;
  }
  settle(cost: CostEstimate | null, worstCaseUsd: number): { overrun: boolean } {
    const usd = cost && cost.usd !== null ? cost.usd : worstCaseUsd;
    this.spentUsd = Math.round((this.spentUsd + usd) * 1e6) / 1e6;
    return { overrun: cost !== null && cost.usd !== null && cost.usd > worstCaseUsd };
  }
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
}

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
  runs: number;
  completed: number;
  failed: number;
  failures: Record<string, number>;
  servedModels: string[];
  searchRate: number | null;
  meanWebSearchCalls: number | null;
  medianCited: number | null;
  answersWithoutCitation: number;
  medianRetrieved: number | null;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  medianAnswerChars: number | null;
  estimatedCostUsd: number;
  runsWithUnknownCost: number;
  meanCostPerCompletedRunUsd: number | null;
  medianCitedDomainStability: number | null;
}

export function summariseBenchmark(records: BenchmarkRecord[]): ModelSummary[] {
  const byModel = new Map<string, BenchmarkRecord[]>();
  for (const r of records) byModel.set(r.settingVersion, [...(byModel.get(r.settingVersion) ?? []), r]);
  return [...byModel.values()].map((rs) => {
    const done = rs.filter((r) => r.outcome === "completed");
    const failures: Record<string, number> = {};
    for (const r of rs) if (r.outcome === "failed") failures[r.failure ?? "unknown"] = (failures[r.failure ?? "unknown"] ?? 0) + 1;
    const known = rs.filter((r) => r.cost && r.cost.usd !== null);
    const cost = known.reduce((a, r) => a + (r.cost!.usd as number), 0);
    const byQuestion = new Map<string, BenchmarkRecord[]>();
    for (const r of done) byQuestion.set(r.questionId, [...(byQuestion.get(r.questionId) ?? []), r]);
    const stabilities = [...byQuestion.values()].map(citedDomainStability).filter((x): x is number => x !== null);
    const withUsage = done.filter((r) => r.usage);
    const latencies = done.map((r) => r.latencyMs).filter((x): x is number => x !== null);
    return {
      model: rs[0].model,
      role: rs[0].role,
      settingVersion: rs[0].settingVersion,
      runs: rs.length,
      completed: done.length,
      failed: rs.length - done.length,
      failures,
      servedModels: [...new Set(rs.map((r) => r.servedModel).filter((m): m is string => !!m))].sort(),
      searchRate: withUsage.length ? Math.round((withUsage.filter((r) => r.usage!.searchOccurred).length / withUsage.length) * 1000) / 1000 : null,
      meanWebSearchCalls: withUsage.length ? Math.round((withUsage.reduce((a, r) => a + r.usage!.webSearchCalls, 0) / withUsage.length) * 100) / 100 : null,
      medianCited: median(done.map((r) => r.citations.length)),
      answersWithoutCitation: done.filter((r) => r.citations.length === 0).length,
      medianRetrieved: median(done.map((r) => r.retrievedCount)),
      latencyP50Ms: percentile(latencies, 50),
      latencyP90Ms: percentile(latencies, 90),
      medianAnswerChars: median(done.map((r) => r.answerChars)),
      estimatedCostUsd: Math.round(cost * 1e6) / 1e6,
      runsWithUnknownCost: rs.length - known.length,
      meanCostPerCompletedRunUsd: done.length && known.length ? Math.round((cost / done.length) * 1e6) / 1e6 : null,
      medianCitedDomainStability: median(stabilities),
    };
  });
}
