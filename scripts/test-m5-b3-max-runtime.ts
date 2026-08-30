#!/usr/bin/env tsx
/**
 * M5 — B3-intrinsic: the total runtime bound. Network-free.
 *
 * Until this bound existed, every ceiling in the worker was about a PART
 * of a run — one provider call, one claim, one job — and the run itself
 * was open-ended. The only thing that ever stopped an idle live worker was
 * an operator watching a clock, which is a bound that is missing on
 * exactly the night it matters.
 *
 * Everything below drives the REAL functions — `resolveExecutionPlan`,
 * `startRuntimeBound`, `createCooperativeStop`, `runWorkerLoop` — against
 * a virtual clock and scripted databases. No socket is opened and no real
 * timer is ever awaited, so a bound of two minutes is tested in
 * microseconds and a mutation fails immediately instead of hanging.
 */

Object.assign(process.env, { NODE_ENV: "test" });

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkerLoop } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import { resolveExecutionPlan, WorkerConfigError } from "@/lib/protocol-worker/execution-mode";
import {
  createCooperativeStop,
  runLiveBootstrap,
  startRuntimeBound,
  unrefTimers,
  type RuntimeBoundEvent,
  type RuntimeTimers,
} from "@/lib/protocol-worker/runtime-bound";
import type { AnalysisTransport, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { DbAdapter } from "@/lib/db/types";

/**
 * Mechanical network guard: every leg here is injected, so one real call
 * would mean a socket was about to be opened.
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
function code(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

// ----------------------------------------------------------------------
// A virtual clock. Timers are values in a set, time is a number that only
// moves when a test moves it, and callbacks fire in deadline order. This
// is what lets a 120-second ceiling be exercised exactly, rather than
// approximated by a real `setTimeout` the suite would have to wait for.
// ----------------------------------------------------------------------
interface VTimer { at: number; fn: () => void; }

class VirtualClock {
  ms = 0;
  private live = new Set<VTimer>();

  now = (): number => this.ms;

  readonly timers: RuntimeTimers = {
    set: (fn: () => void, delay: number) => {
      const t: VTimer = { at: this.ms + Math.max(0, delay), fn };
      this.live.add(t);
      return t;
    },
    clear: (h: unknown) => {
      this.live.delete(h as VTimer);
    },
  };

  armed(): number {
    return this.live.size;
  }

  /** Advances time, firing every timer that comes due, in order. */
  advance(by: number): void {
    const target = this.ms + by;
    for (;;) {
      let next: VTimer | null = null;
      for (const t of this.live) {
        if (t.at <= target && (next === null || t.at < next.at)) next = t;
      }
      if (next === null) break;
      this.live.delete(next);
      this.ms = next.at;
      next.fn();
    }
    this.ms = target;
  }
}

// ----------------------------------------------------------------------
// Scripted database. Answers claims and nothing else; every unexpected
// call throws by name so a silent extra RPC cannot pass unnoticed.
// ----------------------------------------------------------------------
class UnboundedClaimLoop extends Error {
  constructor(n: number) {
    super(`UNBOUNDED_CLAIM_LOOP after ${n} claims`);
    this.name = "UNBOUNDED_CLAIM_LOOP";
  }
}

interface ClaimScript {
  /** "no_job" for ever, or a job on the listed passes. */
  claimedOn?: readonly number[];
  /** Throws once this many claims have been made. Falsification harness. */
  hardCap?: number;
  /** Runs inside the context RPC, e.g. to move the virtual clock. */
  onContext?: () => void;
  /** A claim that never resolves, for the blocked-operation case. */
  hang?: boolean;
}

function scriptedDeps(script: ClaimScript, calls: string[], clock: VirtualClock): WorkerDeps {
  let n = 0;
  const stub = {
    async claimProtocolExecutionJob() {
      n += 1;
      calls.push("claim");
      if (script.hardCap !== undefined && n > script.hardCap) throw new UnboundedClaimLoop(n);
      if (script.hang) return await new Promise(() => {});
      if (script.claimedOn?.includes(n)) {
        return {
          outcome: "CLAIMED" as const,
          job: { id: `job-${n}`, projectId: "proj-1", nextBaselineOrdinal: 1 },
          claimToken: "22222222-2222-4222-8222-222222222222",
        };
      }
      return { outcome: "NO_JOB_AVAILABLE" as const, job: null, claimToken: null };
    },
    async renewProtocolExecutionJobLease() {
      return { outcome: "RENEWED" as const, job: null };
    },
    async getProtocolExecutionJobContext() {
      calls.push("context");
      script.onContext?.();
      return { outcome: "JOB_NOT_OWNED" as const, job: null, protocol: null };
    },
  };
  const db = new Proxy(stub, {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      throw new Error(`unexpected db call: ${String(p)}`);
    },
  }) as unknown as DbAdapter;

  return {
    db,
    runProbe: (async () => { throw new Error("no probe here"); }) as unknown as WorkerDeps["runProbe"],
    analysis: {
      prepare: () => { throw new Error("no prepare here"); },
      execute: async () => { throw new Error("no execute here"); },
    } as unknown as AnalysisTransport,
    realFetch: (async () => { throw new Error("no network"); }) as unknown as WorkerDeps["realFetch"],
    now: clock.now,
    sleep: async (ms: number) => { clock.advance(ms); },
    probeMode: "live_perplexity",
  };
}

/**
 * The ONLY variables a probe subprocess is allowed to see.
 *
 * Not `{ ...process.env }`: this suite runs on developer machines and in
 * CI, where the ambient environment carries Fly tokens, Supabase keys and
 * provider credentials. None of them is needed to import two pure modules,
 * so none of them is passed. PATH and the two Windows roots are the only
 * inherited names, and only because a child process cannot find `node`
 * or its system libraries without them.
 */
const ENV_ALLOWLIST = ["NODE_ENV", "TZ", "TMPDIR", "TMP", "TEMP",
  "PATH", "SYSTEMROOT", "WINDIR",
  // Injected by macOS itself, not inherited: a child spawned with an env
  // of exactly {PATH} still receives it. It carries a user id and a text
  // encoding, no credential, and it cannot be suppressed from here — so it
  // is named explicitly rather than quietly tolerated by a loose check.
  "__CF_USER_TEXT_ENCODING"] as const;

function controlledEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test", TZ: "UTC", TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    const v = process.env[name];
    if (typeof v === "string" && v !== "") env[name] = v;
  }
  return env;
}

/** Names that must never reach a child of this suite. */
const FORBIDDEN_ENV = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^HOME$|^NODE_OPTIONS$|^DOCKER_CONFIG$|^FLY|^SUPABASE|^OPENAI|^PERPLEXITY|^ANTHROPIC/i;

/**
 * A signal host that records instead of touching the real process. Used
 * everywhere except the baseline cases, which deliberately use the real
 * `process` so `listenerCount` means what it says.
 */
function recordingHost() {
  const live = new Map<string, Set<() => void>>();
  const calls: string[] = [];
  return {
    calls,
    count: (e: string): number => live.get(e)?.size ?? 0,
    host: {
      on(event: string, listener: () => void): unknown {
        calls.push(`on:${event}`);
        (live.get(event) ?? live.set(event, new Set()).get(event)!).add(listener);
        return undefined;
      },
      off(event: string, listener: () => void): unknown {
        calls.push(`off:${event}`);
        live.get(event)?.delete(listener);
        return undefined;
      },
    },
    fire(event: string): number {
      const set = live.get(event);
      if (!set) return 0;
      for (const l of [...set]) l();
      return set.size;
    },
  };
}

/** Canary shape: 120 s total, 45 s per call, 10 s grace. */
const CANARY = { maxRuntimeSeconds: 120, providerTimeoutMs: 45_000, graceMs: 10_000 };

/**
 * B3-intrinsic test double. `runtimeBound` is REQUIRED, so "no ceiling" is
 * now something a caller has to write down. Cases that are about the
 * ceiling override this with a real bound; the falsification case in [E]
 * keeps it on purpose, because "always allows" is exactly the mutation
 * being falsified.
 */
const ALWAYS_ALLOWS = { allowsNewClaim: (): boolean => true };

const BASE_OPTS: WorkerOptions = {
  workerId: "b3-runtime",
  leaseSeconds: 60,
  idleBackoffMs: 2000,
  maxBackoffMs: 30_000,
  maxSlotsPerClaim: 1,
  perplexityReservedCostUsd: 0.02,
  analysisReservedCostUsd: 0.02,
  jitterRatio: 0,
  maxThrottledRetries: 0,
  graceMs: CANARY.graceMs,
  exitAfterClaimedJob: false,
  providerTimeoutMs: CANARY.providerTimeoutMs,
  runtimeBound: ALWAYS_ALLOWS,
};

/** A bound on a virtual clock, with its events and callbacks recorded. */
function harness(clock: VirtualClock, over: Partial<typeof CANARY> & { startedAtMs?: number } = {}) {
  const cfg = { ...CANARY, ...over };
  const events: RuntimeBoundEvent[] = [];
  const reasons: string[] = [];
  const signal = { aborted: false };
  let aborts = 0;
  let forced = 0;
  let forcedAtMs = -1;
  const stopper = createCooperativeStop({
    graceMs: cfg.graceMs,
    leaseSeconds: BASE_OPTS.leaseSeconds,
    signal,
    abort: () => { aborts += 1; },
    timers: clock.timers,
    onRequested: (r) => reasons.push(r),
  });
  const bound = startRuntimeBound({
    startedAtMs: over.startedAtMs ?? clock.ms,
    maxRuntimeSeconds: cfg.maxRuntimeSeconds,
    providerTimeoutMs: cfg.providerTimeoutMs,
    graceMs: cfg.graceMs,
    now: clock.now,
    timers: clock.timers,
    onGrace: () => stopper.request("runtime_deadline"),
    onForced: () => { forced += 1; forcedAtMs = clock.ms; },
    onEvent: (e) => events.push(e),
  });
  return {
    bound, stopper, signal, events, reasons,
    aborts: () => aborts,
    forced: () => forced,
    forcedAtMs: () => forcedAtMs,
    names: () => events.map((e) => e.event),
  };
}

// ----------------------------------------------------------------------
const REF = "abcdefghijklmnopqrst";
const live = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  WORKER_EXECUTION_MODE: "live", NODE_ENV: "production", ZYPACT_MOCK_MODE: "off",
  WORKER_ID: "w-1", NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
  WORKER_EXPECTED_SUPABASE_PROJECT_REF: REF, WORKER_LIVE_CONFIRM: `LIVE:${REF}`,
  LLM_PROVIDER: "openai", OPENAI_MODEL: "gpt-4o-mini-2024-07-18",
  OPENAI_API_KEY: "k", PERPLEXITY_API_KEY: "k", SUPABASE_SERVICE_ROLE_KEY: "k",
  WORKER_EXIT_AFTER_CLAIMED_JOB: "true", WORKER_PROVIDER_TIMEOUT_MS: "45000",
  WORKER_LEASE_SECONDS: "60", WORKER_GRACE_MS: "10000",
  WORKER_MAX_RUNTIME_SECONDS: "120", ...over,
});

function refusal(env: Record<string, string | undefined>): WorkerConfigError | null {
  try {
    resolveExecutionPlan(env);
    return null;
  } catch (e) {
    if (e instanceof WorkerConfigError) return e;
    throw e;
  }
}

/** Refused, AND naming that variable and no other. */
function refusesOnly(label: string, env: Record<string, string | undefined>, name: string): void {
  const e = refusal(env);
  check(label,
    e !== null && e.variables.length === 1 && e.variables[0] === name,
    e === null ? "accepted" : e.variables.join(","));
}

async function main(): Promise<void> {
  // ====================================================================
  console.log("[A] disabled — la variable n'est ni requise ni lue");
  // ====================================================================
  {
    const base = resolveExecutionPlan({ WORKER_HEALTH_PORT: "8080" });
    check("[A] absente: le plan disabled résout", base.mode === "disabled");

    // Every shape that is a hard refusal in live, offered to disabled.
    const junk = ["", "   ", "0", "-1", "120.5", "1e3", "abc", "0x78",
      "9007199254740993", "2147484"];
    let identical = 0;
    for (const v of junk) {
      const p = resolveExecutionPlan({ WORKER_HEALTH_PORT: "8080", WORKER_MAX_RUNTIME_SECONDS: v });
      if (JSON.stringify(p) === JSON.stringify(base)) identical += 1;
    }
    check("[A] toute valeur invalide est ignorée: plan strictement identique",
      identical === junk.length, `${identical}/${junk.length}`);
    check("[A] …et le mode reste disabled, jamais une erreur de configuration",
      resolveExecutionPlan({ WORKER_MAX_RUNTIME_SECONDS: "abc" }).mode === "disabled");
    check("[A] aucun timer de durée maximale n'existe côté disabled: le plan " +
      "disabled ne transporte pas la valeur",
      !Object.prototype.hasOwnProperty.call(base, "config")
      && !JSON.stringify(base).includes("maxRuntime"), JSON.stringify(base));
  }

  // ====================================================================
  console.log("\n[B] live — obligatoire, sans défaut, et chaque forme invalide refusée");
  // ====================================================================
  {
    refusesOnly("[B] absente refusée", live({ WORKER_MAX_RUNTIME_SECONDS: undefined }),
      "WORKER_MAX_RUNTIME_SECONDS");
    const invalid: Array<[string, string]> = [
      ["vide", ""],
      ["blancs seuls", "   "],
      ["zéro", "0"],
      ["négatif", "-1"],
      ["négatif long", "-120"],
      ["fraction", "120.5"],
      ["fraction sous 1", "0.5"],
      ["exponentielle", "1e3"],
      ["exponentielle décimale", "1.2e2"],
      ["signe explicite", "+120"],
      ["hexadécimal", "0x78"],
      ["texte", "abc"],
      ["chiffres et espace interne", "12 0"],
      ["suffixe d'unité", "120s"],
      ["entier non sûr", "9007199254740993"],
      ["au-delà du timer 32 bits", "2147484"],
      ["très au-delà du timer", "86400000"],
      ["Infinity", "Infinity"],
      ["NaN", "NaN"],
    ];
    let ok = 0;
    for (const [label, v] of invalid) {
      const e = refusal(live({ WORKER_MAX_RUNTIME_SECONDS: v }));
      const good = e !== null && e.variables.length === 1
        && e.variables[0] === "WORKER_MAX_RUNTIME_SECONDS";
      if (good) ok += 1;
      else check(`[B] ${label} refusée en nommant uniquement la variable`, false,
        e === null ? "ACCEPTÉE" : e.variables.join(","));
    }
    check(`[B] ${invalid.length} formes invalides refusées, chacune en ne nommant ` +
      "que WORKER_MAX_RUNTIME_SECONDS", ok === invalid.length, `${ok}/${invalid.length}`);

    // The largest value the enforcing timer can represent is accepted; one
    // more is not. The boundary is the mechanism's, not an opinion.
    const edge = resolveExecutionPlan(live({ WORKER_MAX_RUNTIME_SECONDS: "2147483" }));
    check("[B] 2147483 s accepté — exactement le plafond du timer",
      edge.mode === "live" && edge.config.maxRuntimeSeconds === 2_147_483);
    check("[B] 2147483000 ms tient dans le délai maximal de setTimeout",
      2_147_483 * 1000 <= 2_147_483_647);
    // The smallest ACCEPTED ceiling is not 1: the smallest provider timeout
    // this repository allows is already 1000 ms, and the relation is
    // strict, so one second of total budget cannot contain one call.
    // 1 passes the form check and is then refused by the relation — which
    // is the honest outcome, not a hole.
    const oneSecond = live({
      WORKER_MAX_RUNTIME_SECONDS: "1", WORKER_PROVIDER_TIMEOUT_MS: "1000",
      WORKER_GRACE_MS: "0", WORKER_LEASE_SECONDS: "2",
    });
    check("[B] 1 s: forme valide, mais refusé par la relation — un appel " +
      "minimal ne tient pas dans une seconde",
      refusal(oneSecond)?.variables.includes("WORKER_MAX_RUNTIME_SECONDS") === true);
    check("[B] 2 s accepté: le plus petit plafond qui contienne un appel minimal",
      resolveExecutionPlan({ ...oneSecond, WORKER_MAX_RUNTIME_SECONDS: "2" }).mode === "live");

    // House style, stated rather than assumed: surrounding whitespace is
    // trimmed for EVERY integer variable in this module, so it is trimmed
    // here too. A test that pretended otherwise would be describing a
    // different program.
    const padded = resolveExecutionPlan(live({ WORKER_MAX_RUNTIME_SECONDS: " 120 " }));
    check("[B] espaces autour de la valeur: rognés, comme pour toute autre " +
      "variable entière de ce module",
      padded.mode === "live" && padded.config.maxRuntimeSeconds === 120);

    // No client can be built by the refusal path, because the module that
    // refuses imports nothing at all.
    const mod = code("lib/protocol-worker/execution-mode.ts");
    check("[B] execution-mode.ts n'importe rien: aucun client ne peut exister " +
      "au moment du refus",
      !/^\s*import\s/m.test(mod) && !/\bimport\s*\(/.test(mod));
    check("[B] …ni fetch, ni createClient, ni await de niveau module",
      !/\bfetch\s*\(/.test(mod) && !/createClient/.test(mod) && !/^await\b/m.test(mod));

    // And the entrypoint exits 78 before anything can be imported. Source
    // OFFSETS would prove nothing here — `runLive` is written above
    // `main`, so the text order is the reverse of the execution order.
    // The ordering that matters is inside `main`, and the dynamic imports
    // must not be reachable from it at all.
    const entry = code("scripts/run-protocol-worker.ts");
    const mainAt = entry.indexOf("async function main()");
    const mainBody = entry.slice(mainAt);
    const exit78 = mainBody.indexOf("process.exit(78)");
    const callLive = mainBody.indexOf("await runLive(plan.config)");
    check("[B] dans main(), la sortie 78 précède l'appel à runLive",
      mainAt > 0 && exit78 > 0 && callLive > 0 && exit78 < callLive,
      `${exit78} < ${callLive}`);
    check("[B] main() ne contient AUCUN import dynamique: rien ne peut être " +
      "chargé avant que le plan soit accepté",
      !/import\s*\(/.test(mainBody));
    check("[B] les imports dynamiques sont tous à l'intérieur de runLive",
      entry.indexOf('import("@/lib/db")') > entry.indexOf("async function runLive")
      && entry.indexOf('import("@/lib/db")') < mainAt);
    check("[B] et resolveExecutionPlan est la toute première chose que main() fait",
      /async function main\(\)[\s\S]{0,200}?resolveExecutionPlan\(process\.env\)/.test(entry));
  }

  // ====================================================================
  console.log("\n[C] la configuration canary est acceptée telle quelle");
  // ====================================================================
  {
    const p = resolveExecutionPlan(live());
    check("[C] 120 s / 45000 ms / grâce 10000 ms accepté", p.mode === "live");
    if (p.mode === "live") {
      check("[C] maxRuntimeSeconds = 120, en SECONDES", p.config.maxRuntimeSeconds === 120,
        String(p.config.maxRuntimeSeconds));
      check("[C] providerTimeoutMs = 45000 inchangé", p.config.providerTimeoutMs === 45_000);
      check("[C] graceMs = 10000 inchangé", p.config.graceMs === 10_000);
      check("[C] exitAfterClaimedJob = true inchangé", p.config.exitAfterClaimedJob === true);
      check("[C] 45000 + 10000 strictement sous 120 x 1000",
        p.config.providerTimeoutMs + p.config.graceMs < p.config.maxRuntimeSeconds * 1000);
    }
  }

  // ====================================================================
  console.log("\n[D] la relation temporelle invalide est refusée");
  // ====================================================================
  {
    const eq = refusal(live({ WORKER_MAX_RUNTIME_SECONDS: "55" }));
    check("[D] 45000 + 10000 = 55 x 1000 refusé — la relation est stricte",
      eq !== null && eq.variables.includes("WORKER_MAX_RUNTIME_SECONDS"),
      eq === null ? "accepted" : eq.variables.join(","));
    const under = refusal(live({ WORKER_MAX_RUNTIME_SECONDS: "10" }));
    check("[D] un plafond total sous une seule fenêtre d'appel refusé",
      under !== null && under.variables.includes("WORKER_MAX_RUNTIME_SECONDS"));
    check("[D] …et le refus nomme les trois variables en cause, pas une seule",
      eq !== null && eq.variables.length === 3
      && eq.variables.includes("WORKER_PROVIDER_TIMEOUT_MS")
      && eq.variables.includes("WORKER_GRACE_MS"),
      eq === null ? "accepted" : eq.variables.join(","));
    check("[D] 56 s accepté: un millier de millisecondes de marge suffit",
      resolveExecutionPlan(live({ WORKER_MAX_RUNTIME_SECONDS: "56" })).mode === "live");
    check("[D] la relation du bail reste prioritaire et inchangée",
      refusal(live({ WORKER_PROVIDER_TIMEOUT_MS: "55000" }))?.variables[0]
      === "WORKER_PROVIDER_TIMEOUT_MS");
  }

  // ====================================================================
  console.log("\n[E] file vide — terminaison bornée, aucun job réclamé");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    const calls: string[] = [];
    const deps = scriptedDeps({}, calls, clock);
    const health = new WorkerHealth(clock.now);
    await runWorkerLoop(deps, { ...BASE_OPTS, runtimeBound: h.bound }, h.signal,
      deps.sleep, () => {}, health);

    const claims = calls.filter((c) => c === "claim").length;
    check("[E] la boucle s'est terminée d'elle-même sur une file vide", true);
    check("[E] elle n'a jamais dépassé l'échéance absolue",
      clock.ms <= h.bound.deadlineMs, `${clock.ms} <= ${h.bound.deadlineMs}`);
    check("[E] elle s'est arrêtée dès que le budget ne couvrait plus un appel " +
      "complet plus la grâce",
      h.bound.remainingMs() < h.bound.requiredMsForNewClaim,
      `reste ${h.bound.remainingMs()} < ${h.bound.requiredMsForNewClaim}`);
    check("[E] nombre de claims fini et déterministe", claims === 6, `claims=${claims}`);
    check("[E] ZÉRO job réclamé: la file était vide de bout en bout",
      health.snapshot().iterations === 0, `iterations=${health.snapshot().iterations}`);
    check("[E] …et chacun de ces claims a bien été compté comme cycle à vide",
      health.snapshot().noJobCycles === claims, `noJob=${health.snapshot().noJobCycles}`);
    check("[E] un seul événement d'épuisement de budget, jamais un par tour",
      h.names().filter((n) => n === "worker_runtime_budget_exhausted").length === 1,
      h.names().join(","));
    check("[E] aucun arrêt coopératif n'a été demandé: le budget a suffi",
      h.reasons.length === 0 && h.signal.aborted === false);
    check("[E] shuttingDown posé, comme pour toute sortie normale",
      health.snapshot().shuttingDown === true);

    // Falsification: the same loop with an ALWAYS-ALLOWING bound never
    // stops on its own — that double is precisely the mutation "the guard
    // is permissive". The harness throws after 40 claims rather than
    // hanging, so the mutation fails in milliseconds.
    check("[E] le double de falsification autorise bien toujours le claim",
      BASE_OPTS.runtimeBound.allowsNewClaim() === true);
    const calls2: string[] = [];
    const clock2 = new VirtualClock();
    const deps2 = scriptedDeps({ hardCap: 40 }, calls2, clock2);
    let thrown: unknown = null;
    try {
      await runWorkerLoop(deps2, BASE_OPTS, { aborted: false }, deps2.sleep, () => {},
        new WorkerHealth(clock2.now));
    } catch (e) { thrown = e; }
    check("[E] sans la borne, la même boucle ne s'arrête jamais — la borne " +
      "EST ce qui l'arrête",
      thrown instanceof Error && thrown.name === "UNBOUNDED_CLAIM_LOOP",
      thrown instanceof Error ? thrown.name : String(thrown));
    check("[E] …et le temps virtuel avait alors très largement dépassé 120 s",
      clock2.ms > 120_000, `${clock2.ms}ms`);
  }

  // ====================================================================
  console.log("\n[F] budget insuffisant — aucun nouveau claim, pas même un");
  // ====================================================================
  {
    const clock = new VirtualClock();
    clock.ms = 70_000; // 70 s already spent; 50 s left, 55 s needed.
    const h = harness(clock, { startedAtMs: 0 });
    check("[F] le budget restant est bien inférieur au minimum requis",
      h.bound.remainingMs() === 50_000 && h.bound.requiredMsForNewClaim === 55_000,
      `${h.bound.remainingMs()} < ${h.bound.requiredMsForNewClaim}`);
    const calls: string[] = [];
    const deps = scriptedDeps({ hardCap: 0 }, calls, clock);
    const health = new WorkerHealth(clock.now);
    await runWorkerLoop(deps, { ...BASE_OPTS, runtimeBound: h.bound }, h.signal,
      deps.sleep, () => {}, health);
    check("[F] AUCUN claim n'a été émis", calls.length === 0, `calls=${calls.length}`);
    check("[F] …donc aucune dépense possible", health.snapshot().iterations === 0);
    check("[F] l'épuisement a été rapporté une fois, avec le reste et le requis",
      h.events.length === 1 && h.events[0].event === "worker_runtime_budget_exhausted"
      && h.events[0].remainingMs === 50_000 && h.events[0].requiredMs === 55_000,
      JSON.stringify(h.events));
    check("[F] la sortie est propre: pas d'abort, pas de terminaison forcée",
      h.aborts() === 0 && h.forced() === 0 && h.signal.aborted === false);
  }

  // ====================================================================
  console.log("\n[G] job déjà réclamé — le signal d'arrêt est propagé");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    const calls: string[] = [];
    // The context RPC crosses the grace deadline while the job is held.
    const deps = scriptedDeps({
      claimedOn: [1],
      hardCap: 3,
      onContext: () => clock.advance(111_000),
    }, calls, clock);
    const health = new WorkerHealth(clock.now);
    await runWorkerLoop(deps, { ...BASE_OPTS, runtimeBound: h.bound }, h.signal,
      deps.sleep, () => {}, health);

    check("[G] l'échéance de grâce a été franchie pendant l'itération",
      h.names().includes("worker_runtime_deadline_grace"), h.names().join(","));
    check("[G] l'arrêt est passé par le mécanisme coopératif existant",
      h.reasons.length === 1 && h.reasons[0] === "runtime_deadline", h.reasons.join(","));
    check("[G] le drapeau que la boucle lit a bien été posé", h.signal.aborted === true);
    check("[G] le job en cours a été mené à son terme, pas interrompu",
      health.snapshot().iterations === 1, `iterations=${health.snapshot().iterations}`);
    check("[G] et AUCUN second claim n'a suivi", calls.filter((c) => c === "claim").length === 1,
      `claims=${calls.filter((c) => c === "claim").length}`);
    // The abort itself lands one grace budget later, never immediately:
    // an in-flight fenced sequence gets its window.
    check("[G] l'abort des appels en vol n'est pas immédiat", h.aborts() === 0);
    clock.advance(10_000);
    check("[G] …il arrive après la grâce, exactement", h.aborts() === 1, String(h.aborts()));
  }

  // ====================================================================
  console.log("\n[H] opération bloquée — l'échéance absolue est tenue");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    const calls: string[] = [];
    const deps = scriptedDeps({ hang: true }, calls, clock);
    let settled = false;
    void runWorkerLoop(deps, { ...BASE_OPTS, runtimeBound: h.bound }, h.signal,
      deps.sleep, () => {}, new WorkerHealth(clock.now)).then(() => { settled = true; });
    await Promise.resolve();
    check("[H] un claim a été émis et ne revient jamais",
      calls.length === 1 && settled === false);

    clock.advance(109_999);
    check("[H] avant la fenêtre de grâce: rien ne s'est déclenché",
      h.names().length === 0 && h.forced() === 0);
    clock.advance(1);
    check("[H] à T0+110 s exactement: fenêtre de grâce, arrêt coopératif",
      h.names().join(",") === "worker_runtime_deadline_grace" && h.signal.aborted === true);
    clock.advance(9_999);
    check("[H] à T0+119,999 s: toujours pas de terminaison forcée", h.forced() === 0);
    clock.advance(1);
    check("[H] à T0+120 s exactement: terminaison forcée, malgré l'opération bloquée",
      h.forced() === 1 && h.forcedAtMs() === 120_000, `forcedAt=${h.forcedAtMs()}`);
    check("[H] …annoncée par son propre événement, distinct des deux autres",
      h.names().join(",") === "worker_runtime_deadline_grace,worker_runtime_deadline_forced",
      h.names().join(","));
    check("[H] la boucle, elle, n'a jamais rendu la main — d'où la terminaison",
      settled === false);
    check("[H] les trois événements portent des noms distincts",
      new Set(["worker_runtime_budget_exhausted", "worker_runtime_deadline_grace",
        "worker_runtime_deadline_forced"]).size === 3);
  }

  // ====================================================================
  console.log("\n[I] exitAfterClaimedJob garde exactement son comportement");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    const calls: string[] = [];
    const deps = scriptedDeps({ claimedOn: [1], hardCap: 1 }, calls, clock);
    const health = new WorkerHealth(clock.now);
    await runWorkerLoop(deps, { ...BASE_OPTS, exitAfterClaimedJob: true, runtimeBound: h.bound },
      h.signal, deps.sleep, () => {}, health);
    check("[I] un seul claim, la sortie mono-job est intacte",
      calls.filter((c) => c === "claim").length === 1);
    check("[I] un seul job", health.snapshot().iterations === 1);
    check("[I] la borne n'a rien eu à refuser: il restait tout le budget",
      h.events.length === 0 && h.signal.aborted === false, h.names().join(","));
    check("[I] et le temps n'a pas bougé: ce n'est pas le temps qui a arrêté la boucle",
      clock.ms === 0, `${clock.ms}ms`);
  }

  // ====================================================================
  console.log("\n[J] courses SIGINT / SIGTERM / timer — idempotentes");
  // ====================================================================
  {
    // Signal first, deadline after.
    const c1 = new VirtualClock();
    const h1 = harness(c1);
    h1.stopper.request("SIGINT");
    h1.stopper.request("SIGTERM");
    h1.stopper.request("SIGINT");
    c1.advance(110_000); // grace deadline also requests a stop
    check("[J] trois demandes puis l'échéance: un seul arrêt annoncé",
      h1.reasons.length === 1 && h1.reasons[0] === "SIGINT", h1.reasons.join(","));
    check("[J] …un seul timer d'abort armé, jamais quatre",
      h1.stopper.armedTimerCount() <= 1);
    c1.advance(10_000);
    check("[J] …et un seul abort effectif", h1.aborts() === 1, String(h1.aborts()));

    // Deadline first, signals after.
    const c2 = new VirtualClock();
    const h2 = harness(c2);
    c2.advance(110_000);
    h2.stopper.request("SIGTERM");
    h2.stopper.request("SIGINT");
    check("[J] échéance d'abord: c'est elle qui est annoncée, une seule fois",
      h2.reasons.length === 1 && h2.reasons[0] === "runtime_deadline", h2.reasons.join(","));
    c2.advance(10_000);
    check("[J] …un seul abort là aussi", h2.aborts() === 1, String(h2.aborts()));

    // A flag already set by the loop must not arm a second timer either.
    const c3 = new VirtualClock();
    const h3 = harness(c3);
    h3.signal.aborted = true;
    h3.stopper.request("SIGTERM");
    check("[J] un drapeau déjà posé n'arme aucun timer d'abort",
      h3.reasons.length === 0 && h3.stopper.armedTimerCount() === 0);

    // The forced deadline fires once even if time is advanced far past it.
    const c4 = new VirtualClock();
    const h4 = harness(c4);
    c4.advance(500_000);
    check("[J] la terminaison forcée ne se déclenche qu'une fois",
      h4.forced() === 1 && h4.names().filter((n) => n === "worker_runtime_deadline_forced")
        .length === 1);
  }

  // ====================================================================
  console.log("\n[K] aucune fuite de timer ni de handle");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    check("[K] deux timers armés au départ: grâce et échéance absolue",
      h.bound.armedTimerCount() === 2 && clock.armed() === 2);
    h.stopper.request("SIGTERM");
    check("[K] plus un timer d'abort après une demande d'arrêt",
      h.stopper.armedTimerCount() === 1 && clock.armed() === 3);
    h.bound.dispose();
    h.stopper.dispose();
    check("[K] après dispose: plus aucun timer, du côté de la borne comme du " +
      "côté de l'horloge",
      h.bound.armedTimerCount() === 0 && h.stopper.armedTimerCount() === 0
      && clock.armed() === 0, `armed=${clock.armed()}`);
    h.bound.dispose();
    h.stopper.dispose();
    check("[K] dispose est idempotent: le rappeler ne casse rien",
      h.bound.armedTimerCount() === 0 && clock.armed() === 0);

    // Terminaison anticipée: la boucle sort par le budget, et tout est rendu.
    const c2 = new VirtualClock();
    const h2 = harness(c2);
    const deps = scriptedDeps({}, [], c2);
    await runWorkerLoop(deps, { ...BASE_OPTS, runtimeBound: h2.bound }, h2.signal,
      deps.sleep, () => {}, new WorkerHealth(c2.now));
    check("[K] à la sortie de la boucle, deux timers restent armés…",
      c2.armed() === 2, `armed=${c2.armed()}`);
    h2.bound.dispose();
    h2.stopper.dispose();
    check("[K] …et le dispose du point d'entrée les libère tous",
      c2.armed() === 0, `armed=${c2.armed()}`);

    // Les deux échéances écoulées se désarment d'elles-mêmes.
    const c3 = new VirtualClock();
    const h3 = harness(c3);
    c3.advance(130_000);
    check("[K] une fois les deux échéances passées, plus rien n'est armé " +
      "par la borne", h3.bound.armedTimerCount() === 0);

    // Les vrais timers Node sont unref'd: la borne ne peut pas, à elle
    // seule, maintenir le processus en vie.
    let unrefs = 0;
    const realSet = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) => {
      const t = realSet(fn, ms);
      const u = (t as { unref?: () => void }).unref?.bind(t);
      (t as { unref?: () => void }).unref = () => { unrefs += 1; u?.(); return t as never; };
      return t;
    }) as typeof globalThis.setTimeout;
    const handle = unrefTimers.set(() => {}, 60_000);
    (globalThis as { setTimeout: unknown }).setTimeout = realSet;
    unrefTimers.clear(handle);
    check("[K] le timer réel de production est unref'd à l'armement", unrefs === 1,
      String(unrefs));
  }

  // ====================================================================
  console.log("\n[L] câblage du point d'entrée");
  // ====================================================================
  {
    const entry = code("scripts/run-protocol-worker.ts");
    const t0 = entry.indexOf("const startedAtMs = Date.now();");
    const firstDynamic = entry.indexOf('import("@/lib/db")');
    const runLiveAt = entry.indexOf("async function runLive");
    check("[L] T0 est pris dans runLive, avant tout import dynamique",
      t0 > runLiveAt && t0 < firstDynamic, `${runLiveAt} < ${t0} < ${firstDynamic}`);
    check("[L] la borne est construite à partir de ce T0 et de la configuration",
      /startRuntimeBound\(\{[\s\S]{0,400}?startedAtMs,[\s\S]{0,400}?maxRuntimeSeconds: cfg\.maxRuntimeSeconds/
        .test(entry));
    check("[L] et elle est passée à la boucle par les options",
      /runtimeBound: bound,/.test(entry));
    check("[L] la fenêtre de grâce passe par l'arrêt coopératif existant",
      /onGrace: \(\) => stopper\.request\("runtime_deadline"\)/.test(entry));
    check("[L] SIGINT et SIGTERM passent par ce MÊME arrêt",
      /const onSigint = \(\): void => stopper\.request\("SIGINT"\);/.test(entry)
      && /const onSigterm = \(\): void => stopper\.request\("SIGTERM"\);/.test(entry)
      && /host: process,/.test(entry));
    check("[L] …et le point d'entrée n'installe plus aucun handler hors du bootstrap",
      !/process\.on\(/.test(entry.slice(entry.indexOf("async function runLive"))));
    check("[L] l'échéance absolue termine réellement le processus",
      /onForced: \(\) => \{[\s\S]{0,600}?process\.exit\(75\)/.test(entry));
    // The finally moved into `runLiveBootstrap`, which is production code
    // this suite exercises directly in [P], [Q] and [R]. Here only the
    // delegation is pinned, and the finally is read where it now lives.
    check("[L] le point d'entrée délègue au bootstrap et garde ses deux dispose",
      /await runLiveBootstrap\(\{/.test(entry)
      && /\} finally \{\s*stopper\.dispose\(\);\s*bound\.dispose\(\);\s*\}/.test(entry));
    check("[L] la borne est disposée EN DERNIER, après l'arrêt coopératif",
      entry.indexOf("    stopper.dispose();") < entry.indexOf("    bound.dispose();"));
    check("[L] le bootstrap retire les handlers dans son propre finally",
      /\} finally \{\s*for \(const handler of installed\) input\.host\.off\(/
        .test(code("lib/protocol-worker/runtime-bound.ts")));
    check("[L] la borne est importée STATIQUEMENT: la primitive qui arme " +
      "ne peut pas arriver par un await",
      /^import \{[\s\S]{0,200}?\} from "@\/lib\/protocol-worker\/runtime-bound";/m.test(entry)
      && !/import\("@\/lib\/protocol-worker\/runtime-bound"\)/.test(entry));
    check("[L] …et seules les trois primitives nécessaires sont importées",
      /import \{\s*createCooperativeStop, runLiveBootstrap, startRuntimeBound,\s*\} from/.test(entry));
    check("[L] les quatre modules qui dépensent ou touchent la base restent " +
      "dynamiques",
      ["@/lib/db", "@/lib/probes/perplexity", "@/lib/llm/call-model",
        "@/lib/protocol-worker/worker"].every((m) =>
        entry.includes(`import("${m}")`)
        && !new RegExp(`^import [^;]*"${m.replace(/[/@]/g, "\\$&")}";`, "m").test(entry)));
    const disabledReturn = entry.indexOf('await runDisabled(');
    const runLiveCall = entry.indexOf("await runLive(plan.config)");
    check("[L] le retour disabled précède toujours runLive",
      disabledReturn > 0 && runLiveCall > disabledReturn);
    check("[L] la variable n'est lue nulle part dans le point d'entrée: " +
      "la configuration seule la lit",
      !entry.includes("WORKER_MAX_RUNTIME_SECONDS"));

    const envExample = code(".env.example");
    check("[L] .env.example documente la variable",
      envExample.includes("WORKER_MAX_RUNTIME_SECONDS"));
    check("[L] …en la marquant requise en live uniquement",
      /WORKER_MAX_RUNTIME_SECONDS[\s\S]{0,400}?required in live/.test(envExample));
    check("[L] …sans jamais l'assigner: le fichier d'exemple reste inerte",
      !/^\s*WORKER_MAX_RUNTIME_SECONDS\s*=/m.test(envExample));
    check("[L] …et le seul mode assigné dans ce fichier reste disabled",
      /^WORKER_EXECUTION_MODE=disabled$/m.test(envExample));
  }

  // ====================================================================
  console.log("\n[M] TypeScript refuse l'omission de runtimeBound");
  // ====================================================================
  {
    // The real compiler, the real tsconfig, the real type. Not a regex
    // over `types.ts`: the claim is "this does not compile", and only a
    // compiler can answer it.
    const ts = await import("typescript");
    const cfgPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(cfgPath!, ts.sys.readFile).config, ts.sys, process.cwd(),
    );
    // Inside the repository, not in os.tmpdir(): the probe imports through
    // the `@/*` mapping, and that mapping only resolves for a file the
    // project's own module resolution can see. Removed in the finally, and
    // its absence is asserted afterwards.
    const dir = mkdtempSync(path.join(process.cwd(), ".b3-type-probe-"));
    const FIELDS = `workerId: "p", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2,
      maxSlotsPerClaim: 1, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
      jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
      exitAfterClaimedJob: true, providerTimeoutMs: 45000,`;
    const probe = (extra: string): readonly string[] => {
      const f = path.join(dir, `probe-${extra.length}.ts`);
      writeFileSync(f, `import type { WorkerOptions } from "@/lib/protocol-worker/types";\n`
        + `const o: WorkerOptions = { ${FIELDS} ${extra} };\nvoid o;\n`);
      const program = ts.createProgram([f], parsed.options);
      return ts.getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === f.split(path.sep).join("/"))
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    };
    try {
      const without = probe("");
      const withIt = probe("runtimeBound: { allowsNewClaim: () => true },");
      check("[M] omettre runtimeBound ne compile pas",
        without.length > 0 && without.some((m) => m.includes("runtimeBound")),
        without.join(" | ").slice(0, 120));
      // Positive control: the very same literal WITH the field is clean, so
      // the check above cannot be passing on an unrelated error.
      check("[M] …et le même littéral AVEC le champ compile sans erreur",
        withIt.length === 0, withIt.join(" | ").slice(0, 120));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    check("[M] le répertoire de sonde a été supprimé", !existsSync(dir), dir);
  }

  // ====================================================================
  console.log("\n[N] aucun appel de production sans borne");
  // ====================================================================
  {
    const entry = code("scripts/run-protocol-worker.ts");
    const worker = code("lib/protocol-worker/worker.ts");
    check("[N] la boucle interroge la borne sans optional chaining ni repli",
      /if \(!opts\.runtimeBound\.allowsNewClaim\(\)\) break;/.test(worker));
    check("[N] …et aucune forme permissive ne subsiste",
      !/runtimeBound\?\./.test(worker) && !/opts\.runtimeBound &&/.test(worker)
      && !/\?\? true/.test(worker));
    check("[N] le type déclare le champ comme obligatoire",
      /\n {2}runtimeBound: \{ allowsNewClaim\(\): boolean \};/
        .test(code("lib/protocol-worker/types.ts")));
    check("[N] lib/ n'exporte aucun helper non borné",
      !/export .*(ALWAYS_ALLOWS|UNBOUNDED|noopRuntimeBound|unboundedRuntime)/
        .test(code("lib/protocol-worker/runtime-bound.ts") + worker
          + code("lib/protocol-worker/types.ts")));
    check("[N] l'unique appel de production passe la borne armée",
      /runtimeBound: bound,/.test(entry));
  }

  // ====================================================================
  console.log("\n[O] la borne est armée avant le premier await");
  // ====================================================================
  {
    const entry = code("scripts/run-protocol-worker.ts");
    const t0 = entry.indexOf("const startedAtMs = Date.now();");
    const arm = entry.indexOf("startRuntimeBound({");
    const window = entry.slice(t0, arm);
    check("[O] T0 précède l'armement", t0 > 0 && arm > t0);
    for (const [label, needle] of [
      ["await", "await "], ["import dynamique", "import("],
      ["construction de client", "getDb"], ["serveur", "createServer"],
      ["écoute de socket", "listen("], ["worker", "runWorkerLoop"],
      ["état de santé", "new WorkerHealth"],
    ] as const) {
      check(`[O] rien entre T0 et l'armement: aucun ${label}`,
        !window.includes(needle), needle);
    }
    // Structural, and backed by a type: `runLiveBootstrap` RECEIVES an
    // already-armed bound. It is therefore impossible, not merely unusual,
    // for the ceiling to be created after the load has started.
    check("[O] le bootstrap est appelé APRÈS l'armement, jamais l'inverse",
      entry.indexOf("const bound = startRuntimeBound({")
        < entry.indexOf("await runLiveBootstrap({")
      && !/runLiveBootstrap\([\s\S]{0,600}?startRuntimeBound/.test(entry));
    check("[O] les références de handlers sont nommées, donc retirables",
      /const onSigint = \(\): void => stopper\.request\("SIGINT"\);/.test(entry)
      && /handlers: \[\["SIGINT", onSigint\], \["SIGTERM", onSigterm\]\]/.test(entry));
    check("[O] les imports dynamiques sont du côté couvert, dans `load`",
      /load: \(\) =>\s*Promise\.all\(\[\s*import\("@\/lib\/db"\)/.test(entry));
    check("[O] getDb, le serveur de santé et la boucle sont dans `run`",
      /run: async \(\[[\s\S]*?db: getDb\(\)[\s\S]*?startHealthServer\([\s\S]*?runWorkerLoop\(/
        .test(entry));
  }

  // ====================================================================
  console.log("\n[P] une initialisation qui ne résout jamais reste couverte");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    let ran = 0;
    let abandoned = 0;
    const rh = recordingHost();
    void runLiveBootstrap<number, never>({
      signal: h.signal, host: rh.host,
      handlers: [["SIGINT", () => {}], ["SIGTERM", () => {}]],
      load: () => new Promise<number>(() => {}),   // ne résout jamais
      run: async () => { ran += 1; },
      closeServer: () => {},
      onAbandoned: () => { abandoned += 1; },
      onCloseFailed: () => {},
    });
    await Promise.resolve();
    check("[P] l'initialisation est en cours et n'a rien construit",
      ran === 0 && h.names().length === 0);
    clock.advance(110_000);
    check("[P] grâce à T0+110 s, pendant le chargement des modules",
      h.names().join(",") === "worker_runtime_deadline_grace"
      && h.signal.aborted === true, h.names().join(","));
    clock.advance(9_999);
    check("[P] à T0+119,999 s: toujours rien de forcé", h.forced() === 0);
    clock.advance(1);
    check("[P] échéance forcée à T0+120 s exactement, malgré l'import bloqué",
      h.forced() === 1 && h.forcedAtMs() === 120_000, `forcedAt=${h.forcedAtMs()}`);
    check("[P] et rien n'a jamais été construit ni réclamé",
      ran === 0 && abandoned === 0);
  }

  // ====================================================================
  console.log("\n[Q] une exception juste après l'armement passe par finally");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    h.stopper.request("SIGTERM");
    check("[Q] trois timers armés avant l'exception", clock.armed() === 3);
    let ran = 0;
    let thrown: unknown = null;
    const rh = recordingHost();
    const hs: readonly (readonly [string, () => void])[] =
      [["SIGINT", () => {}], ["SIGTERM", () => {}]];
    try {
      await runLiveBootstrap<number, never>({
        signal: { aborted: false }, host: rh.host, handlers: hs,
        load: async () => { throw new Error("INIT_BOOM"); },
        run: async () => { ran += 1; },
        closeServer: () => {},
        onAbandoned: () => {},
        onCloseFailed: () => {},
      });
    } catch (e) { thrown = e; }
    check("[Q] l'exception se propage, elle n'est pas avalée",
      thrown instanceof Error && thrown.message === "INIT_BOOM");
    check("[Q] `run` n'a jamais été atteint", ran === 0);
    check("[Q] les deux handlers ont été retirés malgré l'exception",
      rh.count("SIGINT") === 0 && rh.count("SIGTERM") === 0
      && rh.calls.join(",") === "on:SIGINT,on:SIGTERM,off:SIGINT,off:SIGTERM",
      rh.calls.join(","));
    // Le bootstrap ne dispose PAS la borne: elle appartient au finally de
    // runLive, pour que l'échéance absolue couvre ce nettoyage-ci.
    check("[Q] la borne est encore armée pendant le nettoyage",
      h.bound.armedTimerCount() === 2);
    h.stopper.dispose();
    h.bound.dispose();
    check("[Q] puis le finally de l'appelant libère TOUT",
      clock.armed() === 0 && h.bound.armedTimerCount() === 0
      && h.stopper.armedTimerCount() === 0, `armed=${clock.armed()}`);
  }

  // ====================================================================
  console.log("\n[R] grâce pendant le chargement: rien ne démarre après coup");
  // ====================================================================
  {
    const clock = new VirtualClock();
    const h = harness(clock);
    let settle: (v: number) => void = () => {};
    const late = new Promise<number>((r) => { settle = r; });
    let ran = 0;
    const stages: string[] = [];
    const rh = recordingHost();
    let closed = 0;
    const done = runLiveBootstrap<number, never>({
      signal: h.signal, host: rh.host,
      handlers: [["SIGINT", () => {}], ["SIGTERM", () => {}]],
      load: () => late,
      run: async () => { ran += 1; },
      closeServer: () => { closed += 1; },
      onAbandoned: (stage) => stages.push(stage),
      onCloseFailed: () => {},
    });
    await Promise.resolve();
    clock.advance(110_000);
    check("[R] la grâce a commencé pendant le chargement", h.signal.aborted === true);
    settle(1);                       // l'import atterrit, mais trop tard
    await done;
    check("[R] AUCUN getDb, serveur de santé, worker ou claim après coup",
      ran === 0, `run=${ran}`);
    check("[R] l'abandon est journalisé une fois, avec son étape",
      stages.join(",") === "modules", stages.join(","));
    check("[R] le serveur n'a jamais été créé, donc jamais fermé", closed === 0);
    check("[R] les handlers ont tout de même été retirés",
      rh.count("SIGINT") === 0 && rh.count("SIGTERM") === 0);
    h.stopper.dispose();
    h.bound.dispose();
    check("[R] et tous les timers sont rendus", clock.armed() === 0);
  }

  // ====================================================================
  console.log("\n[S] disabled n'arme aucun timer et ne charge aucun fournisseur");
  // ====================================================================
  {
    const entry = code("scripts/run-protocol-worker.ts");
    const disabled = entry.slice(entry.indexOf("async function runDisabled"),
      entry.indexOf("async function runLive"));
    for (const t of ["startRuntimeBound", "createCooperativeStop", "runLiveBootstrap",
      "getDb", "runPerplexityProbe", "prepareCallModelRequest", "runWorkerLoop"]) {
      check(`[S] \`${t}\` absent du chemin disabled`, !disabled.includes(t), t);
    }
    // Behavioural: importing the statically-imported module in a fresh
    // process arms nothing. A pure module is the price of the static
    // import, so it is measured rather than asserted.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "b3-subproc-"));
    let probe: { k: number; t: number; env: string[] };
    try {
      const out = execFileSync(process.execPath, ["--import", "tsx", "-e",
        "import('./lib/protocol-worker/runtime-bound.ts').then((m) => "
        + "console.log(JSON.stringify({ k: Object.keys(m).length, "
        + "t: process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, "
        + "env: Object.keys(process.env).sort() })));"],
        { cwd: process.cwd(), env: controlledEnv(tmp), encoding: "utf8", timeout: 120_000 });
      probe = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    check("[S] importer runtime-bound n'arme AUCUN timer, dans un processus neuf",
      probe.t === 0, JSON.stringify({ t: probe.t }));
    check("[S] …et le module exporte bien ses primitives", probe.k >= 4, String(probe.k));
    // NAMES only, never values.
    check("[S] l'environnement reçu est strictement inclus dans l'allowlist",
      probe.env.every((n) => (ENV_ALLOWLIST as readonly string[]).includes(n)),
      probe.env.filter((n) => !(ENV_ALLOWLIST as readonly string[]).includes(n)).join(","));
    check("[S] …et ne contient aucun nom potentiellement sensible",
      probe.env.every((n) => !FORBIDDEN_ENV.test(n)),
      probe.env.filter((n) => FORBIDDEN_ENV.test(n)).join(","));
    check("[S] le répertoire temporaire du sous-processus est supprimé", !existsSync(tmp));
    const mod = code("lib/protocol-worker/runtime-bound.ts");
    check("[S] runtime-bound n'importe rien et n'a aucun await de niveau module",
      !/^\s*import\s/m.test(mod) && !/^await\b/m.test(mod));
    check("[S] …et n'arme aucun timer au niveau module",
      !/^(?!\s)(?:.*setTimeout)/m.test(mod));
  }

  // ====================================================================
  console.log("\n[T] fin de vie: handlers, serveur, timers");
  // ====================================================================
  {
    // The REAL process, so `listenerCount` means what it says. No signal is
    // ever sent to this process: the handlers are driven with `emit`.
    const baseInt = process.listenerCount("SIGINT");
    const baseTerm = process.listenerCount("SIGTERM");

    const runWith = async (
      opts: { throwInRun?: boolean; abandon?: boolean; server?: object | null;
              throwInClose?: boolean },
    ): Promise<{ fired: number; closed: number; thrown: unknown; closeFails: string[] }> => {
      let fired = 0;
      let closed = 0;
      const closeFails: string[] = [];
      const aborted = { aborted: false };
      let thrown: unknown = null;
      try {
        await runLiveBootstrap<number, object>({
          signal: aborted,
          host: process,
          handlers: [["SIGINT", () => { fired += 1; }], ["SIGTERM", () => { fired += 1; }]],
          load: async () => {
            // Both handlers must be installed by the time the load runs.
            check("[T] les deux handlers sont installés pendant le chargement",
              process.listenerCount("SIGINT") === baseInt + 1
              && process.listenerCount("SIGTERM") === baseTerm + 1);
            if (opts.abandon) aborted.aborted = true;
            return 1;
          },
          run: async (_m, adopt) => {
            if (opts.server) adopt(opts.server);
            if (opts.throwInRun) throw new Error("LOOP_BOOM");
          },
          closeServer: () => {
            closed += 1;
            if (opts.throwInClose) throw new Error("CLOSE_BOOM");
          },
          onAbandoned: () => {},
          onCloseFailed: (d) => closeFails.push(d),
        });
      } catch (e) { thrown = e; }
      return { fired, closed, thrown, closeFails };
    };

    const back = (): boolean =>
      process.listenerCount("SIGINT") === baseInt
      && process.listenerCount("SIGTERM") === baseTerm;

    const ok = await runWith({ server: {} });
    check("[T] sortie normale: listenerCount revient exactement au baseline",
      back(), `${process.listenerCount("SIGINT")}/${baseInt}`);
    check("[T] sortie normale: le serveur est fermé exactement une fois",
      ok.closed === 1 && ok.thrown === null, `closed=${ok.closed}`);

    const boom = await runWith({ server: {}, throwInRun: true });
    check("[T] exception de la boucle: listenerCount revient au baseline", back());
    check("[T] exception de la boucle: le serveur est tout de même fermé, une fois",
      boom.closed === 1, `closed=${boom.closed}`);
    check("[T] …et l'erreur primaire de la boucle se propage",
      boom.thrown instanceof Error && boom.thrown.message === "LOOP_BOOM");

    const gone = await runWith({ abandon: true, server: {} });
    check("[T] abandon pendant l'initialisation: listenerCount revient au baseline", back());
    check("[T] abandon: le serveur n'est jamais créé, donc jamais fermé",
      gone.closed === 0 && gone.thrown === null);

    const both = await runWith({ server: {}, throwInRun: true, throwInClose: true });
    check("[T] close qui échoue: l'erreur PRIMAIRE de la boucle est préservée",
      both.thrown instanceof Error && both.thrown.message === "LOOP_BOOM",
      both.thrown instanceof Error ? both.thrown.message : String(both.thrown));
    check("[T] …et l'échec de fermeture est journalisé sous un label fermé",
      both.closeFails.length === 1 && both.closeFails[0] === "Error",
      both.closeFails.join(","));
    check("[T] listenerCount revient au baseline même dans ce cas", back());

    // A simulated signal after the cleanup must reach nothing at all.
    const beforeTimers = process.getActiveResourcesInfo()
      .filter((r) => r === "Timeout").length;
    process.emit("SIGINT");
    process.emit("SIGTERM");
    check("[T] un signal simulé APRÈS le nettoyage n'atteint aucun handler retiré",
      ok.fired === 0 && boom.fired === 0 && gone.fired === 0 && both.fired === 0);
    check("[T] …et n'arme aucun timer",
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
        === beforeTimers);
    check("[T] …le baseline est intact après les signaux simulés", back());

    // Installation partielle: le second `on` lève. Seul ce qui a été
    // réellement installé est retiré, et le retrait ne lève pas.
    {
      const partial = { on: (e: string, l: () => void) => {
        calls.push(`on:${e}`);
        if (e === "SIGTERM") throw new Error("ON_BOOM");
        live.add(l); return undefined;
      }, off: (e: string, l: () => void) => { calls.push(`off:${e}`); live.delete(l); return undefined; } };
      const calls: string[] = [];
      const live = new Set<() => void>();
      let thrown: unknown = null;
      try {
        await runLiveBootstrap<number, object>({
          signal: { aborted: false }, host: partial,
          handlers: [["SIGINT", () => {}], ["SIGTERM", () => {}]],
          load: async () => 1, run: async () => {}, closeServer: () => {},
          onAbandoned: () => {}, onCloseFailed: () => {},
        });
      } catch (e) { thrown = e; }
      check("[T] installation partielle: l'erreur d'installation se propage",
        thrown instanceof Error && thrown.message === "ON_BOOM");
      check("[T] …seul le handler réellement installé est retiré, sans lever",
        calls.join(",") === "on:SIGINT,on:SIGTERM,off:SIGINT" && live.size === 0,
        calls.join(","));
    }

    // Le comptage de timers, explicité.
    {
      const clock = new VirtualClock();
      const h = harness(clock);
      check("[T] régime nominal: DEUX timers, grâce et échéance absolue",
        h.bound.armedTimerCount() === 2 && h.stopper.armedTimerCount() === 0
        && clock.armed() === 2);
      h.stopper.request("SIGTERM");
      check("[T] le troisième n'apparaît QU'APRÈS une demande d'arrêt",
        h.stopper.armedTimerCount() === 1 && clock.armed() === 3);
      h.stopper.dispose();
      h.bound.dispose();
      check("[T] après les deux dispose: zéro", clock.armed() === 0);

      const c2 = new VirtualClock();
      const h2 = harness(c2);
      h2.stopper.dispose();
      h2.bound.dispose();
      check("[T] sans demande d'arrêt, dispose du stop ne trouve rien et ne lève pas",
        c2.armed() === 0);
    }
  }

  console.log(`\n${realFetchCalls === 0 ? "✓" : "✗"} aucun accès réseau réel n'a été ` +
    `tenté — appels=${realFetchCalls}`);
  if (realFetchCalls !== 0) failures += 1;
  checks += 1;

  console.log(`\n${checks - failures}/${checks} checks passed. ` +
    (failures === 0 ? "M5 B3 max runtime PASSED." : "M5 B3 max runtime FAILED."));
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
