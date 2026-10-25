#!/usr/bin/env tsx
/**
 * M5 — Phase 3D hard bounds: B1, B2, B3. Network-free.
 *
 * Every check drives the REAL production functions — `runWorkerLoop`,
 * `runOneIteration`, `resolveExecutionPlan` — against scripted databases and
 * injected transports. No socket is ever opened.
 *
 *   B1  the loop cannot claim a second job when exitAfterClaimedJob is true.
 *   B2  each provider leg is bounded by its own deadline.
 *   B3  slots and throttled retries are two budgets, never one sum.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { runOneIteration, runWorkerLoop } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import { resolveExecutionPlan, WorkerConfigError } from "@/lib/protocol-worker/execution-mode";
import type { AnalysisTransport, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";
import { sha256Hex } from "@/lib/evidence/hash";
import { PerplexityProbeFailure } from "@/lib/probes/perplexity";

/**
 * The deadline timer is deliberately `unref()`ed in production: it must
 * never be the only thing holding the process open. A unit test has no
 * health server keeping the loop alive, so Node would exit before the
 * timer ever fires. This referenced handle stands in for that.
 */
function keepAlive(): { release(): void } {
  const h = setInterval(() => {}, 50);
  return { release: () => clearInterval(h) };
}

/**
 * Mechanical network guard. The real `fetch` is replaced before any test
 * runs; every leg in this file is driven by an injected transport, so a
 * single call here would mean a socket was about to be opened for real.
 */
let realFetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  realFetchCalls += 1;
  throw new Error("network access attempted in a network-free suite");
}) as unknown as typeof fetch;

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function must<T>(v: T | null | undefined, l: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${l}`);
  return v;
}
function code(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

const APPROVER = "11111111-1111-4111-8111-111111111111";
const PERPLEXITY_REQ = JSON.stringify({ model: "sonar", messages: [] });
const ANALYSIS_REQ = JSON.stringify({ model: "gpt-4o-mini-2024-07-18", messages: [] });
const M5_CONTENT = JSON.stringify({
  clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "",
});
const PROBE_BODY = JSON.stringify({ id: "p", choices: [{ message: { content: "answer" } }] });

/**
 * B3-intrinsic test double. `runtimeBound` is a REQUIRED worker option, so
 * a suite that is not about the total runtime ceiling has to state that it
 * wants no ceiling — deliberately, in its own file. `lib/` exports no such
 * helper on purpose: an unbounded worker must never be one import away.
 */
const ALWAYS_ALLOWS = { allowsNewClaim: (): boolean => true };

const BASE_OPTS: WorkerOptions = {
  workerId: "hard-bounds",
  leaseSeconds: 60,
  idleBackoffMs: 1,
  maxBackoffMs: 2,
  maxSlotsPerClaim: 1,
  perplexityReservedCostUsd: 0.02,
  analysisReservedCostUsd: 0.02,
  jitterRatio: 0,
  maxThrottledRetries: 0,
  graceMs: 1000,
  exitAfterClaimedJob: true,
  providerTimeoutMs: 45000,
  runtimeBound: ALWAYS_ALLOWS,
};

/** A db that answers a scripted claim sequence and nothing else. */
type Step = "no_job" | "claimed";
class UnexpectedSecondClaim extends Error {
  constructor() {
    super("UNEXPECTED_SECOND_CLAIM");
    this.name = "UNEXPECTED_SECOND_CLAIM";
  }
}

/**
 * `strict` turns the harness into a trap: once the script is exhausted, any
 * further claim throws at once instead of answering no_job for ever. A loop
 * that lost its single-job exit then fails in milliseconds with a closed
 * error, rather than spinning until a CI timeout.
 */
function scriptedDb(script: Step[], calls: string[], strict = false): DbAdapter {
  let i = 0;
  const stub = {
    async claimProtocolExecutionJob() {
      calls.push("claim");
      if (strict && i >= script.length) throw new UnexpectedSecondClaim();
      const s = script[i] ?? "no_job";
      i += 1;
      if (s === "no_job") return { outcome: "NO_JOB_AVAILABLE" as const, job: null, claimToken: null };
      return {
        outcome: "CLAIMED" as const,
        job: { id: `job-${i}`, projectId: "proj-1", nextBaselineOrdinal: 1 },
        claimToken: "22222222-2222-4222-8222-222222222222",
      };
    },
    async renewProtocolExecutionJobLease() {
      return { outcome: "RENEWED" as const, job: null };
    },
    async getProtocolExecutionJobContext() {
      calls.push("context");
      return { outcome: "JOB_NOT_OWNED" as const, job: null, protocol: null };
    },
  };
  return new Proxy(stub, {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      throw new Error(`unexpected db call: ${String(p)}`);
    },
  }) as unknown as DbAdapter;
}
function scriptedDeps(script: Step[], calls: string[], strict = false): WorkerDeps {
  return {
    db: scriptedDb(script, calls, strict),
    runProbe: (async () => { throw new Error("no probe here"); }) as unknown as WorkerDeps["runProbe"],
    analysis: {
      prepare: () => { throw new Error("no prepare here"); },
      execute: async () => { throw new Error("no execute here"); },
    } as unknown as AnalysisTransport,
    realFetch: (async () => { throw new Error("no network"); }) as unknown as WorkerDeps["realFetch"],
    now: () => 1000,
    sleep: async () => undefined,
    probeMode: "live_perplexity",
  };
}

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  // ====================================================================
  console.log("[A] un job disponible, second claim piégé + exitAfterClaimedJob=true");
  // ====================================================================
  {
    // Harnais strict: un seul job disponible, et TOUT second claim lève.
    const calls: string[] = [];
    const deps = scriptedDeps(["claimed"], calls, true);
    const health = new WorkerHealth(() => 1);
    const signal = { aborted: false };
    const seen: string[] = [];
    await runWorkerLoop(deps, BASE_OPTS, signal, async () => undefined,
      (r) => seen.push(r.outcome), health);
    check("[A] exactement un claim émis", calls.filter((c) => c === "claim").length === 1,
      `claims=${calls.filter((c) => c === "claim").length}`);
    check("[A] exactement une itération job", seen.length === 1, seen.join(","));
    check("[A] aucun second job réclamé", health.snapshot().iterations === 1,
      `iterations=${health.snapshot().iterations}`);
    check("[A] la boucle est sortie sans abort opérateur", signal.aborted === false);
    check("[A] shuttingDown posé, comme un arrêt normal", health.snapshot().shuttingDown === true);

    // Falsifiabilité du harnais lui-même: exitAfterClaimedJob=false reproduit
    // exactement la mutation « sortie mono-job supprimée ». Le second claim
    // doit lever tout de suite, jamais laisser la boucle tourner.
    const calls2: string[] = [];
    const deps2 = scriptedDeps(["claimed"], calls2, true);
    const t0 = Date.now();
    let thrown: unknown = null;
    try {
      await runWorkerLoop(deps2, { ...BASE_OPTS, exitAfterClaimedJob: false },
        { aborted: false }, async () => undefined, () => {}, new WorkerHealth(() => 1));
    } catch (e) {
      thrown = e;
    }
    const dt = Date.now() - t0;
    check("[A] la mutation mono-job échoue immédiatement, jamais en pendant",
      thrown instanceof Error && thrown.name === "UNEXPECTED_SECOND_CLAIM",
      thrown instanceof Error ? thrown.name : String(thrown));
    check("[A] …en quelques millisecondes, très loin d'un timeout CI",
      dt < 1000, `${dt}ms`);
    check("[A] …et exactement deux claims avant l'échec, aucune boucle résiduelle",
      calls2.filter((c) => c === "claim").length === 2,
      `claims=${calls2.filter((c) => c === "claim").length}`);
  }

  // ====================================================================
  console.log("\n[B] no_job avant le job");
  // ====================================================================
  {
    const calls: string[] = [];
    const deps = scriptedDeps(["no_job", "no_job", "claimed", "claimed"], calls);
    const health = new WorkerHealth(() => 1);
    const seen: string[] = [];
    let slept = 0;
    await runWorkerLoop(deps, BASE_OPTS, { aborted: false }, async () => { slept += 1; },
      (r) => seen.push(r.outcome), health);
    check("[B] la boucle a attendu sur les cycles idle", slept === 2, `sleeps=${slept}`);
    check("[B] elle sort après le premier job réclamé",
      seen.join(",") === "no_job,no_job,lost_ownership", seen.join(","));
    check("[B] exactement trois claims, jamais un quatrième",
      calls.filter((c) => c === "claim").length === 3,
      `claims=${calls.filter((c) => c === "claim").length}`);
  }

  // ====================================================================
  console.log("\n[C] exitAfterClaimedJob=false — comportement continu conservé");
  // ====================================================================
  {
    const calls: string[] = [];
    const deps = scriptedDeps(["claimed", "claimed", "claimed"], calls);
    const health = new WorkerHealth(() => 1);
    const signal = { aborted: false };
    let n = 0;
    await runWorkerLoop(deps, { ...BASE_OPTS, exitAfterClaimedJob: false }, signal,
      async () => undefined, () => { n += 1; if (n >= 3) signal.aborted = true; }, health);
    check("[C] trois jobs traités à la suite", n === 3, `itérations=${n}`);
    check("[C] trois claims émis", calls.filter((c) => c === "claim").length === 3);
    check("[C] seul l'abort opérateur a arrêté la boucle", signal.aborted === true);
  }

  // ====================================================================
  console.log("\n[D]/[E] budgets slots et retries indépendants");
  // ====================================================================
  const PROTOCOL = (runs: number): Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> => ({
    provider: "perplexity", surface: "sonar", plannedBaselineRuns: runs, plannedRetestRuns: 0,
    paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
    primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
    timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
  });
  let seq = 0;
  async function seedQueued(runs: number): Promise<string> {
    seq += 1;
    const project = await db.createProject({ domain: `hb-${seq}.test`, companyName: "C" });
    const q = await db.createBuyerQuestion({ projectId: project.id });
    const v = await db.createBuyerQuestionVersion({
      buyerQuestionId: q.id, projectId: project.id, versionNumber: 1, promptText: "Q?",
      promptHash: "a".repeat(64), intentType: "comparison", commercialValue: 3, winnability: 3,
      priority: 10, rationale: "f", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: v.id, projectId: project.id, approvedBy: APPROVER });
    const proto = await db.createProtocol({ ...PROTOCOL(runs), projectId: project.id, buyerQuestionVersionId: v.id });
    await db.approveProtocol({ protocolId: proto.id, projectId: project.id, approvedBy: APPROVER });
    const enq = await db.enqueueProtocolExecutionJob({ protocolId: proto.id, projectId: project.id });
    return must(enq.job, "job").id;
  }
  interface Spy { probes: number; analyses: number; admits: number }
  function liveDeps(spy: Spy, wrapped: DbAdapter, analysisExec?: AnalysisTransport["execute"]): WorkerDeps {
    return {
      db: wrapped,
      runProbe: (async (input) => {
        spy.probes += 1;
        try {
          await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/chat/completions",
            { method: "POST", body: PERPLEXITY_REQ });
        } catch (e) {
          // `runPerplexityProbe` wraps EVERY fetch throw this way; a fixture
          // that let the raw DOMException escape would not exercise the real
          // unknown-outcome path.
          if (e instanceof PerplexityProbeFailure) throw e;
          throw new PerplexityProbeFailure("aborted", {
            // The real runner has no "aborted" reason: an abort surfaces as a
            // network error, which is precisely what keeps the outcome UNKNOWN.
            reason: "network_error",
            httpStatus: null, errorBody: null, errorBodySha256: null,
            latencyMs: 1, providerRequestId: null,
            rawProbeRequestSha256: sha256Hex(PERPLEXITY_REQ),
            fullRequestBody: PERPLEXITY_REQ, fullRequestBodySha256: sha256Hex(PERPLEXITY_REQ),
          });
        }
        return {
          prompt: input.prompt, answer: "answer", rawResponse: PROBE_BODY, citations: [],
          searchResults: [], sourceCitations: [], model: "sonar", usedMock: false,
          rawResponseBody: PROBE_BODY, rawResponseBodySha256: sha256Hex(PROBE_BODY),
          httpStatus: 200, latencyMs: 5, providerRequestId: "p-1",
        } satisfies PerplexityProbeResult;
      }) as WorkerDeps["runProbe"],
      analysis: {
        prepare: () => ({
          provider: "openai" as const, model: "gpt-4o-mini-2024-07-18",
          url: "https://api.openai.com/v1/chat/completions",
          rawRequestBody: ANALYSIS_REQ, requestSha256: sha256Hex(ANALYSIS_REQ),
        }),
        execute: analysisExec ?? (async () => {
          spy.analyses += 1;
          return {
            provider: "openai" as const, model: "gpt-4o-mini-2024-07-18", content: M5_CONTENT,
            usedMock: false, modelReturned: "gpt-4o-mini-2024-07-18", latencyMs: 7,
            requestSha256: sha256Hex(ANALYSIS_REQ), contentSha256: sha256Hex(M5_CONTENT),
            providerRequestId: "a-1", httpStatus: 200,
          };
        }),
      } as unknown as AnalysisTransport,
      realFetch: (async () => new Response(PROBE_BODY, { status: 200 })) as unknown as WorkerDeps["realFetch"],
      now: () => Date.now(),
      sleep: async () => undefined,
      probeMode: "live_perplexity",
    };
  }
  function countingDb(spy: Spy, throttleFirst = false): DbAdapter {
    let throttled = false;
    return new Proxy(db, {
      get(t, p, r) {
        if (p === "admitAndReserveAttemptForJob") {
          return async (input: unknown) => {
            spy.admits += 1;
            if (throttleFirst && !throttled) {
              throttled = true;
              return { outcome: "RATE_LIMIT_EXCEEDED", attempt: null, perplexityCall: null, analysisCall: null };
            }
            return (t as DbAdapter).admitAndReserveAttemptForJob(input as never);
          };
        }
        return Reflect.get(t, p, r);
      },
    }) as DbAdapter;
  }

  {
    // plannedBaselineRuns=2 ⇒ le gate répond NEXT_BASELINE_REQUIRED après le
    // premier slot. Avec maxSlotsPerClaim=1 aucun second slot ne doit suivre.
    await seedQueued(2);
    const spy: Spy = { probes: 0, analyses: 0, admits: 0 };
    const deps = liveDeps(spy, countingDb(spy));
    const r = await runOneIteration(deps, { ...BASE_OPTS, maxSlotsPerClaim: 1, maxThrottledRetries: 0 },
      new WorkerHealth(() => Date.now()));
    check("[D] exactement un slot conduit", spy.admits === 1, `admits=${spy.admits}`);
    check("[D] au plus un appel Perplexity", spy.probes <= 1, `probes=${spy.probes}`);
    check("[D] au plus un appel d'analyse", spy.analyses <= 1, `analyses=${spy.analyses}`);
    check("[D] NEXT_BASELINE_REQUIRED ne déclenche aucun second slot", spy.admits === 1);
    // Enveloppe Phase 3D exacte, sous plannedBaselineRuns=1, max_attempts=1,
    // maxSlotsPerClaim=1, maxThrottledRetries=0, exitAfterClaimedJob=true.
    check(
      "[D] enveloppe Phase 3D: 1 Perplexity + 1 OpenAI = 2 appels réseau au maximum",
      spy.probes + spy.analyses <= 2 && spy.probes <= 1 && spy.analyses <= 1,
      `perplexity=${spy.probes} openai=${spy.analyses} total=${spy.probes + spy.analyses}`
    );
    check(
      "[D] …soit 0,02 + 0,02 = 0,04 USD réservés au maximum",
      spy.admits * (BASE_OPTS.perplexityReservedCostUsd + BASE_OPTS.analysisReservedCostUsd) <= 0.04,
      `réservé=${(spy.admits * 0.04).toFixed(2)} USD`
    );
    check("[D] slot_budget_exhausted produit",
      r.detail?.startsWith("SLOT_BUDGET_EXHAUSTED") === true, `${r.outcome}/${r.detail}`);
  }
  {
    await seedQueued(1);
    const spy: Spy = { probes: 0, analyses: 0, admits: 0 };
    const deps = liveDeps(spy, countingDb(spy, true));
    const r = await runOneIteration(deps, { ...BASE_OPTS, maxSlotsPerClaim: 1, maxThrottledRetries: 1 },
      new WorkerHealth(() => Date.now()));
    check("[E] le throttling a été retenté", spy.admits === 2, `admits=${spy.admits}`);
    check("[E] le retry n'a pas créé un second slot — un seul appel Perplexity",
      spy.probes <= 1, `probes=${spy.probes}`);
    check("[E] …ni un second appel d'analyse", spy.analyses <= 1, `analyses=${spy.analyses}`);
    check("[E] le job atteint un terminal", r.outcome === "completed", `${r.outcome}/${r.detail}`);
  }

  // ====================================================================
  console.log("\n[F]/[G]/[H] bornes B2 sur chaque leg");
  // ====================================================================
  {
    await seedQueued(1);
    const spy: Spy = { probes: 0, analyses: 0, admits: 0 };
    let sent = 0;
    const deps: WorkerDeps = {
      ...liveDeps(spy, countingDb(spy)),
      realFetch: (async (_u: unknown, init?: { signal?: AbortSignal | null }) => {
        sent += 1;
        // Ne répond jamais: seule la borne peut mettre fin à l'appel.
        return await new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
        });
      }) as unknown as WorkerDeps["realFetch"],
    };
    const ka = keepAlive();
    const t0 = Date.now();
    const r = await runOneIteration(deps, { ...BASE_OPTS, providerTimeoutMs: 1200 },
      new WorkerHealth(() => Date.now()));
    ka.release();
    const dt = Date.now() - t0;
    check("[F] une seule émission réseau", sent === 1, `émissions=${sent}`);
    check("[F] abandon à la borne, pas au lease", dt >= 1000 && dt < 15000, `${dt}ms`);
    check("[F] aucun retry réseau", sent === 1);
    check("[F] issue inconnue enregistrée, preuve durable",
      r.outcome === "needs_review_perplexity_unknown", `${r.outcome}/${r.detail}`);
  }
  {
    await seedQueued(1);
    const spy: Spy = { probes: 0, analyses: 0, admits: 0 };
    let execs = 0;
    const deps = liveDeps(spy, countingDb(spy), (async (_p, o) => {
      execs += 1;
      return await new Promise((_res, rej) => {
        o?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      });
    }) as AnalysisTransport["execute"]);
    const ka = keepAlive();
    const t0 = Date.now();
    const r = await runOneIteration(deps, { ...BASE_OPTS, providerTimeoutMs: 1200 },
      new WorkerHealth(() => Date.now()));
    ka.release();
    const dt = Date.now() - t0;
    check("[G] une seule exécution d'analyse", execs === 1, `exécutions=${execs}`);
    check("[G] abandon à la borne", dt >= 1000 && dt < 15000, `${dt}ms`);
    check("[G] issue inconnue enregistrée",
      r.outcome === "needs_review_analysis_unknown", `${r.outcome}/${r.detail}`);
  }
  {
    await seedQueued(1);
    const spy: Spy = { probes: 0, analyses: 0, admits: 0 };
    const ac = new AbortController();
    let execs = 0;
    const base = liveDeps(spy, countingDb(spy), (async (_p, o) => {
      execs += 1;
      setTimeout(() => ac.abort(), 60);
      return await new Promise((_res, rej) => {
        o?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
      });
    }) as AnalysisTransport["execute"]);
    const ka = keepAlive();
    const t0 = Date.now();
    // Borne très haute: seul le signal opérateur peut terminer l'appel.
    const r = await runOneIteration({ ...base, abortSignal: ac.signal },
      { ...BASE_OPTS, providerTimeoutMs: 30000 }, new WorkerHealth(() => Date.now()));
    ka.release();
    const dt = Date.now() - t0;
    check("[H] le signal opérateur gagne sur la borne", dt < 5000, `${dt}ms`);
    check("[H] une seule exécution", execs === 1);
    check("[H] issue inconnue enregistrée malgré l'arrêt",
      r.outcome === "needs_review_analysis_unknown", `${r.outcome}/${r.detail}`);
    const src = code("lib/protocol-worker/execute-job.ts");
    check("[H] aucun timer résiduel: dispose() est en finally sur les deux legs",
      (src.match(/finally \{\n\s*(?:\/\/[^\n]*\n\s*)*deadline\.dispose\(\);/g) ?? []).length === 2,
      `finally=${(src.match(/deadline\.dispose\(\);/g) ?? []).length}`);
    check("[H] le listener d'abandon est retiré dans dispose()",
      /removeEventListener\("abort", onOuter\)/.test(src));
    check("[H] le timer est unref", /unref\?\.\(\)/.test(src));

    // --- durée de vie de la deadline Perplexity ---
    const prov = src.slice(src.indexOf("async function runProviderCall"),
      src.indexOf("async function recordAnalysisFailure"));
    const iProbe = prov.indexOf("deps.runProbe(");
    const iDispose = prov.indexOf("deadline.dispose()");
    const iReceipt = prov.indexOf("recordProviderCallReceiptForJob(");
    check(
      "[H] la deadline Perplexity couvre tout runProbe, lecture du corps comprise",
      iProbe > 0 && iDispose > iProbe,
      `runProbe@${iProbe} dispose@${iDispose}`
    );
    check(
      "[H] …et elle est libérée AVANT la première écriture durable",
      iDispose > 0 && iReceipt > iDispose,
      `dispose@${iDispose} receipt@${iReceipt}`
    );
    check(
      "[H] la libération est dans un finally interne: succès, timeout, arrêt, erreur HTTP, réponse vide et throw",
      // Between the finally and the receipt, only lines with no `await`: the
      // measured-cost read (6f2346e) is synchronous and sits there, but no
      // I/O may run between releasing the clock and the receipt.
      /\} finally \{[\s\S]{0,600}?deadline\.dispose\(\);\n\s*\}\n(?:(?![^\n]*\bawait\b)[^\n]*\n){0,20}?\s*const rec = await deps\.db\.recordProviderCallReceiptForJob/.test(prov)
    );
    check(
      "[H] exactement un dispose() par leg, jamais deux",
      (src.match(/deadline\.dispose\(\);/g) ?? []).length === 2,
      `total=${(src.match(/deadline\.dispose\(\);/g) ?? []).length}`
    );
    check(
      "[H] le leg analyse conserve son finally resserré",
      /out = await deps\.analysis\.execute\(prepared, \{ signal: deadline\.signal \}\);[\s\S]{0,400}?\} finally \{\n\s*deadline\.dispose\(\);/.test(src)
    );
    check(
      "[H] aucun code mort résiduel: timedOut/expired supprimés",
      !/timedOut|expired/.test(src)
    );
  }

  // ====================================================================
  console.log("\n[I] configuration");
  // ====================================================================
  {
    const REF = "abcdefghijklmnopqrst";
    const live = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
      WORKER_EXECUTION_MODE: "live", NODE_ENV: "production", ZYPACT_MOCK_MODE: "off",
      WORKER_ID: "w-1", NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
      WORKER_EXPECTED_SUPABASE_PROJECT_REF: REF, WORKER_LIVE_CONFIRM: `LIVE:${REF}`,
      LLM_PROVIDER: "openai", OPENAI_MODEL: "gpt-4o-mini-2024-07-18",
      OPENAI_API_KEY: "k", PERPLEXITY_API_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_URL: `https://${REF}.supabase.co`,
      WORKER_EXIT_AFTER_CLAIMED_JOB: "true", WORKER_PROVIDER_TIMEOUT_MS: "45000",
      WORKER_LEASE_SECONDS: "60", WORKER_GRACE_MS: "10000",
      // B3-intrinsic — also required in live, and with no default.
      WORKER_MAX_RUNTIME_SECONDS: "120", ...over,
    });
    const refuses = (label: string, env: Record<string, string | undefined>, variable: string): void => {
      try {
        resolveExecutionPlan(env);
        check(label, false, "accepté à tort");
      } catch (e) {
        check(label, e instanceof WorkerConfigError && e.variables.includes(variable),
          e instanceof WorkerConfigError ? e.variables.join(",") : String(e));
      }
    };
    check("[I] disabled fonctionne sans les deux nouvelles variables",
      resolveExecutionPlan({ WORKER_EXECUTION_MODE: "disabled" }).mode === "disabled");
    refuses("[I] live refuse WORKER_EXIT_AFTER_CLAIMED_JOB absent",
      live({ WORKER_EXIT_AFTER_CLAIMED_JOB: undefined }), "WORKER_EXIT_AFTER_CLAIMED_JOB");
    refuses("[I] …et une valeur non littérale",
      live({ WORKER_EXIT_AFTER_CLAIMED_JOB: "TRUE" }), "WORKER_EXIT_AFTER_CLAIMED_JOB");
    refuses("[I] …et une valeur vide",
      live({ WORKER_EXIT_AFTER_CLAIMED_JOB: "" }), "WORKER_EXIT_AFTER_CLAIMED_JOB");
    refuses("[I] live refuse WORKER_PROVIDER_TIMEOUT_MS absent",
      live({ WORKER_PROVIDER_TIMEOUT_MS: undefined }), "WORKER_PROVIDER_TIMEOUT_MS");
    refuses("[I] …et une valeur sous 1000 ms",
      live({ WORKER_PROVIDER_TIMEOUT_MS: "999" }), "WORKER_PROVIDER_TIMEOUT_MS");
    refuses("[I] …et une valeur non entière",
      live({ WORKER_PROVIDER_TIMEOUT_MS: "45.5" }), "WORKER_PROVIDER_TIMEOUT_MS");
    refuses("[I] timeout + grace >= lease refusé",
      live({ WORKER_PROVIDER_TIMEOUT_MS: "55000", WORKER_GRACE_MS: "10000" }), "WORKER_PROVIDER_TIMEOUT_MS");
    const plan = resolveExecutionPlan(live());
    check("[I] 45000 accepté avec lease 60 s et grace 10 s", plan.mode === "live");
    if (plan.mode === "live") {
      check("[I] exitAfterClaimedJob=true propagé", plan.config.exitAfterClaimedJob === true);
      check("[I] providerTimeoutMs propagé", plan.config.providerTimeoutMs === 45000);
    }
    const f = resolveExecutionPlan(live({ WORKER_EXIT_AFTER_CLAIMED_JOB: "false" }));
    check("[I] false strict accepté et propagé",
      f.mode === "live" && f.config.exitAfterClaimedJob === false);
  }

  // ====================================================================
  console.log("\n[J] falsifiabilité");
  // ====================================================================
  {
    const w = code("lib/protocol-worker/worker.ts");
    const single = /if \(opts\.exitAfterClaimedJob\) break;/;
    const mutated1 = w.replace("if (opts.exitAfterClaimedJob) break;", "// second claim reintroduced");
    check("[J] la sortie mono-job est présente en production", single.test(w));
    check("[J] …et une mutation la retirant est détectée",
      mutated1 !== w && !single.test(mutated1));
    const sumBound = /pass <= opts\.maxSlotsPerClaim \+ opts\.maxThrottledRetries/;
    check("[J] la borne sommée a bien disparu", !sumBound.test(w));
    const mutated2 = w.replace("if (slotsUsed >= opts.maxSlotsPerClaim) break;",
      "if (slotsUsed >= opts.maxSlotsPerClaim + opts.maxThrottledRetries) break;");
    check("[J] …et une mutation transformant un retry en slot est détectable",
      mutated2 !== w && /maxSlotsPerClaim \+ opts\.maxThrottledRetries/.test(mutated2));
    check("[J] le retry n'incrémente jamais slotsUsed",
      /throttled \+= 1;[\s\S]{0,700}?continue;/.test(w)
        && !/throttled \+= 1;[\s\S]{0,700}?slotsUsed \+= 1;[\s\S]{0,120}?continue;/.test(w));
  }

  check("aucun accès réseau réel n'a été tenté", realFetchCalls === 0, `appels=${realFetchCalls}`);

  console.log(`\n${checks - failures}/${checks} checks passed. Phase 3D hard bounds ${failures === 0 ? "PASSED" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
