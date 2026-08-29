#!/usr/bin/env tsx
/**
 * M0 — worker execution gate contract.
 *
 * Two halves.
 *
 * The first drives `resolveExecutionPlan` directly: it is pure, so every
 * refusal can be provoked from a plain record with no process state, no
 * database and no network. The env records here are entirely synthetic —
 * this file never reads `.env.local`, and the fake values are chosen so a
 * leak into an error message would be unmistakable.
 *
 * The second spawns the real entrypoint in `disabled` mode with an
 * environment that contains NO Supabase, Perplexity, OpenAI or Anthropic
 * credential at all. If the inert path touched `getDb()`, built a provider
 * transport or reached for a key, it could not survive that environment —
 * so the process staying up is itself the proof.
 *
 * No network is possible: no test performs a request other than to
 * 127.0.0.1 on a port this file opened.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveExecutionPlan,
  WorkerConfigError,
} from "@/lib/protocol-worker/execution-mode";

let checks = 0;
const failures: string[] = [];

/**
 * Named proofs that MUST have run. `assert` only counts what it is asked
 * to check, and the total is printed dynamically, so a branch that skips
 * a scenario used to lower the count and still report a pass. These
 * checkpoints close that: the verdict fails when one is missing, even
 * with no recorded failure.
 */
const MANDATORY_CHECKPOINTS = [
  "signal:SIGTERM", "signal:SIGINT", "retry:collision-then-success",
  "retry:exhausted-fails", "mutation:handler-less",
  "health:default-loopback", "health:explicit-wildcard",
] as const;
const reached = new Set<string>();
function checkpoint(name: (typeof MANDATORY_CHECKPOINTS)[number]): void {
  reached.add(name);
}
/** Signals whose every assertion completed. Nothing else may add to it. */
const completedSignals = new Set<string>();

function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

/** Synthetic values. None of these is a real credential. */
const REF = "abcdefghijklmnopqrst";
const SECRETS = {
  SUPABASE_SERVICE_ROLE_KEY: "SENTINEL-SERVICE-ROLE-VALUE-0001",
  PERPLEXITY_API_KEY: "SENTINEL-PERPLEXITY-VALUE-0002",
  OPENAI_API_KEY: "SENTINEL-OPENAI-VALUE-0003",
  ANTHROPIC_API_KEY: "SENTINEL-ANTHROPIC-VALUE-0004",
};

function liveEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    WORKER_EXECUTION_MODE: "live",
    NODE_ENV: "production",
    ZYPACT_MOCK_MODE: "off",
    WORKER_ID: "worker-fixture-1",
    NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    WORKER_EXPECTED_SUPABASE_PROJECT_REF: REF,
    WORKER_LIVE_CONFIRM: `LIVE:${REF}`,
    LLM_PROVIDER: "openai",
    // TK-R-5 — live now demands a dated model snapshot. This is the exact
    // value the repository is configured with today.
    OPENAI_MODEL: "gpt-4o-mini-2024-07-18",
    ...SECRETS,
    ...over,
  };
}

/** Runs the resolver and returns the error, or null when it accepted. */
function refusal(env: Record<string, string | undefined>): WorkerConfigError | null {
  try {
    resolveExecutionPlan(env);
    return null;
  } catch (e) {
    if (e instanceof WorkerConfigError) return e;
    throw e;
  }
}

function rejects(label: string, env: Record<string, string | undefined>, variable?: string): void {
  const e = refusal(env);
  assert(label, e !== null, "accepted when it should have refused");
  if (e && variable) {
    assert(`${label} names ${variable}`, e.variables.includes(variable), e.variables.join(","));
  }
}

// ═══════════════════════════════════════════ 1. default and mode parsing
{
  for (const [label, env] of [
    ["absent", {}],
    ["empty", { WORKER_EXECUTION_MODE: "" }],
    ["whitespace", { WORKER_EXECUTION_MODE: "   " }],
  ] as const) {
    const plan = resolveExecutionPlan(env as Record<string, string | undefined>);
    assert(`mode ${label} resolves to disabled`, plan.mode === "disabled", plan.mode);
  }
  const explicit = resolveExecutionPlan({ WORKER_EXECUTION_MODE: "disabled" });
  assert("mode disabled resolves to disabled", explicit.mode === "disabled");

  for (const bad of ["Disabled", "LIVE", "enabled", "on", "true", "mock", "dry-run", "0"]) {
    rejects(`unknown mode \`${bad}\` refused`,
      { WORKER_EXECUTION_MODE: bad }, "WORKER_EXECUTION_MODE");
  }
}

// ═════════════════════════════════ 2. disabled needs no credential at all
{
  const plan = resolveExecutionPlan({ WORKER_EXECUTION_MODE: "disabled" });
  assert("disabled plan carries only the health surface settings",
    plan.mode === "disabled" && Object.keys(plan).sort().join(",") === "healthHost,healthPort,mode",
    Object.keys(plan).join(","));
  const withPort = resolveExecutionPlan({ WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: "8123" });
  assert("disabled honours WORKER_HEALTH_PORT",
    withPort.mode === "disabled" && withPort.healthPort === 8123);
  rejects("disabled refuses an invalid health port",
    { WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: "abc" }, "WORKER_HEALTH_PORT");

  // ---------------------------------------------------- WORKER_HEALTH_HOST
  // A closed allow-list of two literals. The default is the one that
  // cannot be reached from off-box, so a host that says nothing about the
  // bind address never accidentally publishes the health surface.
  assert("absent WORKER_HEALTH_HOST binds the loopback",
    plan.mode === "disabled" && plan.healthHost === "127.0.0.1",
    plan.mode === "disabled" ? plan.healthHost : plan.mode);
  for (const good of ["127.0.0.1", "0.0.0.0"] as const) {
    const p = resolveExecutionPlan({ WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_HOST: good });
    assert(`WORKER_HEALTH_HOST=${good} is carried through verbatim`,
      p.mode === "disabled" && p.healthHost === good, p.mode === "disabled" ? p.healthHost : p.mode);
  }
  // Empty, whitespace, either loopback spelling that needs DNS or IPv6,
  // any other IPv4, any hostname, and any value that would only pass after
  // trimming or case folding. There is no normalisation step to forgive
  // them: the comparison is exact.
  for (const bad of [
    "", " ", "  ", "\t", "\n",
    "localhost", "LOCALHOST", "Localhost",
    "::", "::1", "[::]", "[::1]", "0:0:0:0:0:0:0:0", "::ffff:127.0.0.1",
    "0.0.0.1", "127.0.0.2", "127.1", "192.168.1.10", "10.0.0.1", "169.254.169.254",
    "example.com", "worker.internal", "host.docker.internal",
    " 127.0.0.1", "127.0.0.1 ", "0.0.0.0 ", " 0.0.0.0", "127.0.0.1\n",
    "127.0.0.1:8080", "0.0.0.0:0", "*", "0", "all", "any",
  ]) {
    rejects(`WORKER_HEALTH_HOST=${JSON.stringify(bad)} refused`,
      { WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_HOST: bad }, "WORKER_HEALTH_HOST");
  }
  // The same allow-list governs live, and it is applied by the same call
  // that the entrypoint makes before it is allowed to import anything.
  rejects("live refuses an invalid WORKER_HEALTH_HOST too",
    liveEnv({ WORKER_HEALTH_HOST: "localhost" }), "WORKER_HEALTH_HOST");
  const liveHost = resolveExecutionPlan(liveEnv({ WORKER_HEALTH_HOST: "0.0.0.0" }));
  assert("live config carries the bind host",
    liveHost.mode === "live" && liveHost.config.healthHost === "0.0.0.0",
    liveHost.mode === "live" ? liveHost.config.healthHost : liveHost.mode);
  const liveDefault = resolveExecutionPlan(liveEnv());
  assert("live defaults to the loopback bind host",
    liveDefault.mode === "live" && liveDefault.config.healthHost === "127.0.0.1",
    liveDefault.mode === "live" ? liveDefault.config.healthHost : liveDefault.mode);
}

// ═══════════════════════════════════════════════ 3. live: required inputs
{
  const plan = resolveExecutionPlan(liveEnv());
  assert("a complete OpenAI configuration resolves to live", plan.mode === "live", plan.mode);
  if (plan.mode === "live") {
    assert("live config carries the worker id", plan.config.workerId === "worker-fixture-1");
    assert("live config carries the provider", plan.config.analysisProvider === "openai");
    assert("live config carries the expected ref", plan.config.expectedProjectRef === REF);
    assert("live defaults: lease 60", plan.config.leaseSeconds === 60);
    assert("live defaults: grace 10000", plan.config.graceMs === 10000);
    assert("live defaults: reserved costs 0.02",
      plan.config.perplexityReservedCostUsd === 0.02 && plan.config.analysisReservedCostUsd === 0.02);
  }
  // TK-R-5 — Anthropic is fail-closed in live. The repository's only
  // Anthropic default is `claude-3-5-sonnet-latest`, a floating alias, and
  // no dated Anthropic snapshot has been decided. Rather than invent one,
  // live refuses the provider outright; mock and disabled are unaffected.
  rejects("Anthropic is refused in live until a dated snapshot is decided",
    liveEnv({ LLM_PROVIDER: "anthropic" }), "LLM_PROVIDER");

  // TK-R-5 — the model rule itself, at the gate.
  rejects("OPENAI_MODEL absent refused", liveEnv({ OPENAI_MODEL: undefined }), "OPENAI_MODEL");
  rejects("OPENAI_MODEL empty refused", liveEnv({ OPENAI_MODEL: "" }), "OPENAI_MODEL");
  for (const floating of ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-4.1-mini"]) {
    rejects(`floating alias refused: ${floating}`, liveEnv({ OPENAI_MODEL: floating }), "OPENAI_MODEL");
  }
  rejects("a `latest` tag is refused", liveEnv({ OPENAI_MODEL: "gpt-4o-latest" }), "OPENAI_MODEL");
  rejects("an undated snapshot is refused",
    liveEnv({ OPENAI_MODEL: "claude-3-5-sonnet-20241022" }), "OPENAI_MODEL");
  for (const dated of ["gpt-4o-mini-2024-07-18", "gpt-4o-2024-08-06", "gpt-4.1-mini-2025-04-14"]) {
    assert(`a dated snapshot is accepted: ${dated}`,
      resolveExecutionPlan(liveEnv({ OPENAI_MODEL: dated })).mode === "live");
  }

  rejects("NODE_ENV must be production", liveEnv({ NODE_ENV: "development" }), "NODE_ENV");
  rejects("NODE_ENV absent refused", liveEnv({ NODE_ENV: undefined }), "NODE_ENV");
  rejects("ZYPACT_ALLOW_MEMORY_DB=true refused",
    liveEnv({ ZYPACT_ALLOW_MEMORY_DB: "true" }), "ZYPACT_ALLOW_MEMORY_DB");
  assert("ZYPACT_ALLOW_MEMORY_DB=false accepted",
    resolveExecutionPlan(liveEnv({ ZYPACT_ALLOW_MEMORY_DB: "false" })).mode === "live");

  for (const v of [undefined, "", "on", "auto", "OFF", "off "]) {
    rejects(`ZYPACT_MOCK_MODE=${JSON.stringify(v)} refused in live`,
      liveEnv({ ZYPACT_MOCK_MODE: v }), "ZYPACT_MOCK_MODE");
  }

  for (const v of [undefined, "", "ab", "worker id", "worker\nid", "w".repeat(65), "-lead"]) {
    rejects(`WORKER_ID=${JSON.stringify(v)} refused`, liveEnv({ WORKER_ID: v }), "WORKER_ID");
  }

  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "WORKER_EXPECTED_SUPABASE_PROJECT_REF", "WORKER_LIVE_CONFIRM", "PERPLEXITY_API_KEY",
  ]) {
    rejects(`${name} missing refused`, liveEnv({ [name]: undefined }), name);
    rejects(`${name} empty refused`, liveEnv({ [name]: "" }), name);
  }
}

// ═══════════════════════════════════════════ 4. live: Supabase URL binding
{
  rejects("malformed Supabase URL refused",
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: "not a url" }), "NEXT_PUBLIC_SUPABASE_URL");
  rejects("http Supabase URL refused",
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: `http://${REF}.supabase.co` }), "NEXT_PUBLIC_SUPABASE_URL");
  rejects("Supabase URL for a different ref refused",
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tsrqponmlkjihgfedcba.supabase.co" }),
    "NEXT_PUBLIC_SUPABASE_URL");
  rejects("look-alike Supabase host refused",
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co.evil.test` }),
    "NEXT_PUBLIC_SUPABASE_URL");
  // These all carry the RIGHT hostname. A gate that only checks protocol
  // and host accepts every one of them and sends the worker somewhere
  // other than the project this configuration names.
  for (const [label, url] of [
    ["credentials in the authority", `https://user:pw@${REF}.supabase.co`],
    ["password-only authority", `https://:pw@${REF}.supabase.co`],
    ["username-only authority", `https://user@${REF}.supabase.co`],
    ["non-standard port", `https://${REF}.supabase.co:8443`],
    ["a path", `https://${REF}.supabase.co/rest/v1`],
    ["a trailing path segment", `https://${REF}.supabase.co/x`],
    ["a query string", `https://${REF}.supabase.co/?redirect=evil.test`],
    ["a fragment", `https://${REF}.supabase.co/#frag`],
  ] as const) {
    rejects(`right host but ${label} refused`,
      liveEnv({ NEXT_PUBLIC_SUPABASE_URL: url }), "NEXT_PUBLIC_SUPABASE_URL");
  }
  // The one canonical shape, with and without the trailing slash.
  for (const ok of [`https://${REF}.supabase.co`, `https://${REF}.supabase.co/`]) {
    assert(`canonical URL accepted: ${ok}`,
      resolveExecutionPlan(liveEnv({ NEXT_PUBLIC_SUPABASE_URL: ok })).mode === "live", ok);
  }
  rejects("credential against a foreign host refused",
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://user:pw@evil.test/${REF}.supabase.co` }),
    "NEXT_PUBLIC_SUPABASE_URL");
  for (const bad of ["ABCDEFGHIJKLMNOPQRST", "abcdefghijklmnopqrs", "abcdefghijklmnopqrstu", "abc-defghijklmnopqrs"]) {
    rejects(`project ref \`${bad}\` refused`,
      liveEnv({ WORKER_EXPECTED_SUPABASE_PROJECT_REF: bad }),
      "WORKER_EXPECTED_SUPABASE_PROJECT_REF");
  }
}

// ═══════════════════════════════════════════ 5. live: explicit confirmation
{
  for (const bad of ["LIVE", "live:" + REF, `LIVE:${REF} `, "LIVE:tsrqponmlkjihgfedcba", "yes"]) {
    rejects(`WORKER_LIVE_CONFIRM=${JSON.stringify(bad)} refused`,
      liveEnv({ WORKER_LIVE_CONFIRM: bad }), "WORKER_LIVE_CONFIRM");
  }
}

// ═══════════════════════════════════════════════ 6. live: analysis provider
{
  for (const bad of [undefined, "", "auto", "mock", "OpenAI", "gemini", "openai "]) {
    rejects(`LLM_PROVIDER=${JSON.stringify(bad)} refused`,
      liveEnv({ LLM_PROVIDER: bad }), "LLM_PROVIDER");
  }
  rejects("OpenAI selected but OPENAI_API_KEY missing",
    liveEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: undefined }), "OPENAI_API_KEY");
  rejects("Anthropic selected but ANTHROPIC_API_KEY missing",
    liveEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: undefined }), "ANTHROPIC_API_KEY");
}

// ═══════════════════════════════════════════════ 7. live: numeric contract
{
  for (const v of ["0", "-1", "0.0", "abc", "", " ", "1e-3"]) {
    rejects(`WORKER_PERPLEXITY_RESERVED_USD=${JSON.stringify(v)} refused`,
      liveEnv({ WORKER_PERPLEXITY_RESERVED_USD: v }), "WORKER_PERPLEXITY_RESERVED_USD");
    rejects(`WORKER_ANALYSIS_RESERVED_USD=${JSON.stringify(v)} refused`,
      liveEnv({ WORKER_ANALYSIS_RESERVED_USD: v }), "WORKER_ANALYSIS_RESERVED_USD");
  }
  assert("positive reserved costs accepted",
    resolveExecutionPlan(liveEnv({
      WORKER_PERPLEXITY_RESERVED_USD: "0.05", WORKER_ANALYSIS_RESERVED_USD: "0.1",
    })).mode === "live");

  rejects("grace equal to the lease refused",
    liveEnv({ WORKER_LEASE_SECONDS: "10", WORKER_GRACE_MS: "10000" }), "WORKER_GRACE_MS");
  rejects("grace greater than the lease refused",
    liveEnv({ WORKER_LEASE_SECONDS: "10", WORKER_GRACE_MS: "10001" }), "WORKER_GRACE_MS");
  assert("grace below the lease accepted",
    resolveExecutionPlan(liveEnv({ WORKER_LEASE_SECONDS: "10", WORKER_GRACE_MS: "9999" })).mode === "live");

  // An explicitly supplied invalid number is an error, never a silent
  // return to the documented default.
  for (const name of [
    "WORKER_LEASE_SECONDS", "WORKER_IDLE_BACKOFF_MS", "WORKER_MAX_BACKOFF_MS",
    "WORKER_MAX_SLOTS_PER_CLAIM", "WORKER_MAX_THROTTLED_RETRIES", "WORKER_GRACE_MS",
    "WORKER_HEALTH_PORT", "WORKER_READY_STALE_MS",
  ]) {
    rejects(`${name}=notanumber refused rather than defaulted`,
      liveEnv({ [name]: "notanumber" }), name);
  }
  rejects("negative jitter refused", liveEnv({ WORKER_JITTER_RATIO: "-0.1" }), "WORKER_JITTER_RATIO");
  rejects("jitter above 1 refused", liveEnv({ WORKER_JITTER_RATIO: "1.01" }), "WORKER_JITTER_RATIO");
  assert("jitter of exactly 1 accepted",
    resolveExecutionPlan(liveEnv({ WORKER_JITTER_RATIO: "1" })).mode === "live");

  // Past 2^53 parseInt returns an imprecise float. Without isSafeInteger
  // these sail through as "numbers" and produce a lease, a port or a
  // reservation that means nothing.
  const HUGE = "999999999999999999999";
  for (const name of [
    "WORKER_LEASE_SECONDS", "WORKER_GRACE_MS", "WORKER_IDLE_BACKOFF_MS",
    "WORKER_MAX_BACKOFF_MS", "WORKER_MAX_SLOTS_PER_CLAIM",
    "WORKER_MAX_THROTTLED_RETRIES", "WORKER_HEALTH_PORT", "WORKER_READY_STALE_MS",
    "WORKER_JITTER_RATIO", "WORKER_PERPLEXITY_RESERVED_USD", "WORKER_ANALYSIS_RESERVED_USD",
  ]) {
    rejects(`${name}=${HUGE} refused as out of range or unsafe`, liveEnv({ [name]: HUGE }), name);
  }
  rejects("an unsafe integer just past 2^53 refused",
    liveEnv({ WORKER_MAX_SLOTS_PER_CLAIM: "9007199254740993" }), "WORKER_MAX_SLOTS_PER_CLAIM");

  // Port is 16 bits.
  rejects("health port above 65535 refused",
    liveEnv({ WORKER_HEALTH_PORT: "65536" }), "WORKER_HEALTH_PORT");
  rejects("negative health port refused",
    liveEnv({ WORKER_HEALTH_PORT: "-1" }), "WORKER_HEALTH_PORT");
  assert("health port 65535 accepted",
    resolveExecutionPlan(liveEnv({ WORKER_HEALTH_PORT: "65535" })).mode === "live");

  // Reserved costs have a documented ceiling: admission control reserves
  // the figure for real, so a typo must not become a budget.
  rejects("reserved cost above the documented ceiling refused",
    liveEnv({ WORKER_PERPLEXITY_RESERVED_USD: "10.01" }), "WORKER_PERPLEXITY_RESERVED_USD");
  rejects("analysis reserved cost above the ceiling refused",
    liveEnv({ WORKER_ANALYSIS_RESERVED_USD: "10.01" }), "WORKER_ANALYSIS_RESERVED_USD");
  assert("reserved cost at the ceiling accepted",
    resolveExecutionPlan(liveEnv({
      WORKER_PERPLEXITY_RESERVED_USD: "10", WORKER_ANALYSIS_RESERVED_USD: "10",
    })).mode === "live");
  rejects("lease beyond one day refused",
    liveEnv({ WORKER_LEASE_SECONDS: "86401" }), "WORKER_LEASE_SECONDS");
}

// ═══════════════════════════════════════════ 8. no secret in any message
{
  const sentinels = Object.values(SECRETS);
  const cases: Record<string, string | undefined>[] = [
    liveEnv({ NODE_ENV: "development" }),
    liveEnv({ ZYPACT_MOCK_MODE: "auto" }),
    liveEnv({ WORKER_LIVE_CONFIRM: "wrong" }),
    liveEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://x.test" }),
    liveEnv({ LLM_PROVIDER: "gemini" }),
    liveEnv({ WORKER_PERPLEXITY_RESERVED_USD: "0" }),
    liveEnv({ OPENAI_API_KEY: undefined }),
  ];
  let leaked = 0;
  for (const env of cases) {
    const e = refusal(env);
    if (!e) continue;
    const text = `${e.message} ${e.variables.join(" ")}`;
    for (const s of sentinels) if (text.includes(s)) leaked += 1;
    // Nor a fragment: a prefix long enough to be recognisable is still a leak.
    for (const s of sentinels) if (text.includes(s.slice(0, 12))) leaked += 1;
    if (/length|bytes|sha256|prefix|starts with/i.test(text)) leaked += 1;
  }
  assert("no refusal message carries a secret value, fragment or measurement",
    leaked === 0, `${leaked} leak(s)`);
}

// ═══════════════════════════════ 9. the entrypoint branches before anything
{
  const src = readFileSync(path.join(process.cwd(), "scripts/run-protocol-worker.ts"), "utf8");
  const staticValueImports = [...src.matchAll(/^import (?!type )([^;]+?) from "([^"]+)";/gm)]
    .map((m) => m[2]);
  assert("the entrypoint statically imports only node:http and the pure config module",
    staticValueImports.sort().join(",") === "@/lib/protocol-worker/execution-mode,node:http",
    staticValueImports.join(","));
  for (const mod of ["@/lib/db", "@/lib/probes/perplexity", "@/lib/llm/call-model",
    "@/lib/protocol-worker/worker"]) {
    assert(`\`${mod}\` is imported dynamically, inside the live branch only`,
      new RegExp(`import\\("${mod.replace(/[/@]/g, "\\$&")}"\\)`).test(src)
        && !new RegExp(`^import [^;]*"${mod.replace(/[/@]/g, "\\$&")}";`, "m").test(src),
      mod);
  }
  const live = src.slice(src.indexOf("async function runLive"));
  const disabled = src.slice(src.indexOf("async function runDisabled"), src.indexOf("async function runLive"));
  const TOKENS = ["getDb", "runPerplexityProbe", "prepareCallModelRequest", "runWorkerLoop", "fetch("];
  for (const token of TOKENS) {
    assert(`\`${token}\` never appears in the disabled path`, !disabled.includes(token), token);
    // Checked on its own merit. An earlier version carried an `|| token
    // === "prepareCallModelRequest"` escape hatch that made one case
    // unconditionally true; there is none now.
    assert(`\`${token}\` is present in the live path`, live.includes(token), token);
  }
  // Negative proof, in memory: removing any single token from the live
  // half must break its own check, so none of the five is vacuous.
  for (const token of TOKENS) {
    const mutated = live.split(token).join("__REMOVED__");
    assert(`removing \`${token}\` from the live path would fail its check`,
      !mutated.includes(token), token);
  }

  // The bind address is the validated plan value, never a literal in the
  // entrypoint. Both call sites — inert and live — must hand it through.
  assert("the health server binds the validated configured host",
    /listen\(healthPort, healthHost\)/.test(src));
  assert("no call site pins a bind address literal",
    !/listen\(healthPort, "/.test(src));
  assert("both call sites pass the host through",
    (src.match(/startHealthServer\((?:healthPort, healthHost|cfg\.healthPort, cfg\.healthHost)/g) ?? []).length === 2,
    (src.match(/startHealthServer\([^,]+, [^,]+,/g) ?? []).join(" | "));
  // Negative proof, in memory: an entrypoint that pinned the loopback
  // again would fail the check above, so it is not vacuous.
  const pinned = src.split("listen(healthPort, healthHost)").join('listen(healthPort, "127.0.0.1")');
  assert("an entrypoint that pinned the bind address would fail that check",
    !/listen\(healthPort, healthHost\)/.test(pinned));
  // Port 0 still means no server, whatever the host says.
  assert("a non-positive health port still returns no server at all",
    /if \(healthPort <= 0\) return null;/.test(src));
}

// ═══════════════════ 10. the real process, disabled, with zero credentials
/**
 * The environment below carries no Supabase, Perplexity, OpenAI or
 * Anthropic variable. `getDb()` throws without NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY, and the Perplexity probe throws without its
 * key — so a disabled path that reached either could not stay up here.
 */
function bareEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    ...over,
  };
}

/**
 * Single-process TypeScript execution, through the package's own declared
 * root export: no CLI wrapper between us and the entrypoint, and no path
 * into the package's build output either. This is the same loader the
 * production `worker:protocol` script uses, so what is proved here is the
 * command a host will actually run.
 */
const TSX_LOADER = ["--import", "tsx"];

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function spawnWorker(
  env: NodeJS.ProcessEnv,
  onReady?: (kill: (sig?: NodeJS.Signals) => void) => Promise<void>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Node with the tsx loader, NOT the `tsx` CLI. The CLI forks a child
    // and, on SIGTERM, dies at 143 while the child is torn down before it
    // can flush — which is precisely how the previous contract came to
    // treat 143 as proof of a clean stop. Loaded this way the entrypoint
    // is the process that receives the signal, so its own exit code and
    // its own final log line both mean what they say.
    const child = spawn(process.execPath, [...TSX_LOADER, "scripts/run-protocol-worker.ts"], {
      cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const guard = setTimeout(() => {
      if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error("worker did not settle in time")); }
    }, 60_000);
    guard.unref();

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (onReady && /worker_execution_disabled/.test(stdout)) {
        const once = onReady; onReady = undefined;
        // Give the health server a moment to bind before probing it.
        setTimeout(() => {
          void once((sig) => child.kill(sig ?? "SIGTERM")).catch((e) => { stderr += String(e); child.kill("SIGKILL"); });
        }, 400);
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(guard);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  // 127.0.0.1 only. No other host is contacted anywhere in this file.
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.text() };
}

/**
 * An ephemeral port from the kernel rather than a hard-coded one: a busy
 * 41787 used to fail the contract for a reason that has nothing to do with
 * the worker. The socket is closed before the worker is told to bind it, so
 * a race is still possible in principle — hence `bindFailed`, which turns a
 * genuine EADDRINUSE into a skip rather than a business failure.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr === null || typeof addr === "string") { reject(new Error("no port")); return; }
      const p = addr.port;
      probe.close(() => resolve(p));
    });
  });
}

function bindFailed(stderr: string): boolean {
  return /EADDRINUSE/.test(stderr);
}

/**
 * True when something is listening on 127.0.0.1:port. Used to prove the
 * worker released its port; the retry self-tests hold their own blocker on
 * the same port, so callers there compare against the blocker's own 503.
 */
async function portIsOpen(port: number): Promise<boolean> {
  try { await get(port, "/healthz"); return true; } catch { return false; }
}

/** True when the LISTENER is the worker, not a test blocker. */
async function workerHoldsPort(port: number): Promise<boolean> {
  try {
    const r = await get(port, "/healthz");
    return r.status === 200 && /executionEnabled/.test(r.body);
  } catch { return false; }
}

const MAX_PORT_ATTEMPTS = 3;

type SignalOutcome =
  | { status: "proved"; attempts: number }
  | { status: "infrastructure"; attempts: number };

/** Records a failure. The live run funnels into the global list. */
function record(message: string): void {
  failures.push(message);
}

/**
 * Runs the whole shutdown scenario for one signal, retrying only when the
 * health port was taken between allocation and bind. Every other error
 * fails immediately. After MAX_PORT_ATTEMPTS collisions it records an
 * explicitly infrastructural failure — never a silent skip.
 *
 * `recorder` is injected so the retry self-tests can observe failures
 * without polluting the suite's own tally.
 */
async function proveSignal(
  sig: NodeJS.Signals,
  allocate: () => Promise<number>,
  recorder: (message: string) => void,
  afterFirstCollision?: () => void,
  // Absent means the variable is not set at all, which is how the default
  // is proved: nothing in the environment mentions the bind address.
  healthHost?: "127.0.0.1" | "0.0.0.0",
): Promise<SignalOutcome> {
  const expectedHost = healthHost ?? "127.0.0.1";
  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await allocate();
    interface Probe { status: number; body: string }
    const probes: { healthz?: Probe; readyz?: Probe; notFound?: number } = {};
    const run = await spawnWorker(
      bareEnv({
        WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: String(port),
        ...(healthHost === undefined ? {} : { WORKER_HEALTH_HOST: healthHost }),
      }),
      async (kill) => {
        probes.healthz = await get(port, "/healthz");
        probes.readyz = await get(port, "/readyz");
        probes.notFound = (await get(port, "/metrics")).status;
        kill(sig);
      },
    );

    if (bindFailed(run.stderr)) {
      // The child is already gone — `spawnWorker` resolves on close — so
      // nothing is left to kill. Confirm the worker holds no listener
      // before trying again on a different port.
      if (await workerHoldsPort(port)) {
        recorder(`${sig}: a collided attempt left a listener on port ${port}`);
        return { status: "infrastructure", attempts: attempt };
      }
      afterFirstCollision?.();
      continue;
    }

    // Counts on every call, pass or fail, so the printed total reflects
    // the work actually done rather than only the failures.
    const fail = (label: string, ok: boolean, detail = ""): boolean => {
      checks += 1;
      if (!ok) recorder(detail ? `${sig}: ${label} — ${detail}` : `${sig}: ${label}`);
      return ok;
    };
    let ok = true;
    ok = fail("the process stayed up until it was signalled",
      probes.healthz !== undefined, "gone before it could be probed") && ok;
    ok = fail("healthz answers 200", probes.healthz?.status === 200, String(probes.healthz?.status)) && ok;
    ok = fail("readyz answers 200", probes.readyz?.status === 200, String(probes.readyz?.status)) && ok;
    ok = fail("an unknown health route answers 404", probes.notFound === 404, String(probes.notFound)) && ok;
    ok = fail("the cooperative stop event is emitted",
      /"event":"worker_execution_disabled_stopped"/.test(run.stdout),
      run.stdout.replace(/\s+/g, " ").slice(0, 160)) && ok;
    ok = fail("the stop event names the signal it received",
      new RegExp(`"signal":"${sig}"`).test(run.stdout)) && ok;
    ok = fail("the stop event reports the health server closed",
      /"healthServerClosed":true/.test(run.stdout)) && ok;
    // The RESOLVED value, reported by the process itself. With no variable
    // set this is the proof that the default is the loopback; with the
    // variable set it is the proof that the explicit value took effect.
    ok = fail("the start event reports the resolved bind host",
      new RegExp(`"healthHost":"${expectedHost.replace(/\./g, "\\.")}"`).test(run.stdout),
      run.stdout.replace(/\s+/g, " ").slice(0, 160)) && ok;
    ok = fail("the start event reports no other bind host",
      (run.stdout.match(/"healthHost":"[^"]*"/g) ?? []).length === 1,
      (run.stdout.match(/"healthHost":"[^"]*"/g) ?? []).join(",")) && ok;
    ok = fail("the start event precedes the stop event",
      run.stdout.indexOf('worker_execution_disabled"')
        < run.stdout.indexOf("worker_execution_disabled_stopped")) && ok;
    ok = fail("exactly two closed events, and no others",
      (run.stdout.match(/"event":/g) ?? []).length === 2
        && (run.stdout.match(/"event":"worker_execution_disabled(_stopped)?"/g) ?? []).length === 2,
      (run.stdout.match(/"event":"[a-z_]+"/g) ?? []).join(",")) && ok;
    ok = fail("the process terminated by its own exit rather than a kill",
      run.code === 0 && run.signal === null, `code=${run.code} signal=${run.signal}`) && ok;
    ok = fail("nothing is written to stderr", run.stderr.trim() === "", run.stderr.slice(0, 160)) && ok;
    ok = fail("no Supabase or provider credential was needed",
      !/SUPABASE|PERPLEXITY|OPENAI|ANTHROPIC|not configured|DbNotConfigured/i.test(run.stderr)) && ok;
    ok = fail("the health port is closed after shutdown", !(await portIsOpen(port)), `port ${port}`) && ok;

    const readyz = probes.readyz;
    if (readyz) {
      const body = JSON.parse(readyz.body) as Record<string, unknown>;
      ok = fail("readyz reports ready=true", body.ready === true) && ok;
      ok = fail("readyz reports executionEnabled=false", body.executionEnabled === false) && ok;
      ok = fail("readyz carries closed scalars only",
        Object.keys(body).sort().join(",") === "executionEnabled,ready", Object.keys(body).join(",")) && ok;
      ok = fail("readyz leaks no identifier",
        !/token|job|project|prompt|key|secret|ref/i.test(readyz.body), readyz.body) && ok;
    }
    if (probes.healthz) {
      ok = fail("healthz leaks no identifier",
        !/token|job|project|prompt|key|secret|ref/i.test(probes.healthz.body), probes.healthz.body) && ok;
    }

    // A business failure is terminal: it is not retried and not hidden.
    return { status: ok ? "proved" : "infrastructure", attempts: attempt };
  }
  recorder(`${sig}: the health port collided ${MAX_PORT_ATTEMPTS} times — infrastructure failure, not a skip`);
  return { status: "infrastructure", attempts: MAX_PORT_ATTEMPTS };
}

// ═══════════════ 9b. the production entry command is one public process
/**
 * BL-2. `npm run worker:protocol` used to be `tsx <entrypoint>`, and the
 * `tsx` CLI forks: the parent takes SIGTERM and dies at 143 while the
 * child is torn down before its handler runs. The cooperative stop the
 * whole M0 contract rests on was therefore unobservable on any host that
 * signals the process it started.
 *
 * The fix is one process, reached through the package's own public root
 * export. This section pins that: the exact command, the public specifier,
 * the runtime dependency that makes it survive `npm ci --omit=dev`, and
 * the absence of any path into the package's build output.
 */
{
  const pkgRaw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const WORKER_COMMAND = "node --import tsx scripts/run-protocol-worker.ts";
  assert("`worker:protocol` is exactly the single-process public command",
    pkg.scripts?.["worker:protocol"] === WORKER_COMMAND,
    pkg.scripts?.["worker:protocol"] ?? "absent");

  // Without this, `npm ci --omit=dev` on a host omits the loader and the
  // command above cannot start at all.
  assert("tsx is a runtime dependency, so a production install keeps it",
    typeof pkg.dependencies?.tsx === "string" && pkg.devDependencies?.tsx === undefined,
    `dependencies=${pkg.dependencies?.tsx ?? "absent"} `
      + `devDependencies=${pkg.devDependencies?.tsx ?? "absent"}`);

  // Needles assembled at runtime: written literally they would appear in
  // this file and make the "no occurrence" assertions match themselves.
  const internalLoader = ["tsx", "dist", "loader.mjs"].join("/");
  const esmSubpath = ["tsx", "esm"].join("/");
  const entrySrc = readFileSync(path.join(process.cwd(), "scripts/run-protocol-worker.ts"), "utf8");
  const selfSrc = readFileSync(path.join(process.cwd(), "scripts/test-m0-worker-execution-gate.ts"), "utf8");
  for (const [where, text] of [
    ["package.json", pkgRaw], ["the entrypoint", entrySrc], ["this contract", selfSrc],
  ] as const) {
    assert(`${where} carries no path into the tsx build output`,
      !text.includes(internalLoader), where);
    assert(`${where} uses no tsx subpath export`, !text.includes(esmSubpath), where);
  }

  // `--import tsx` is a public entry only if the package declares a root
  // export. Read from the installed package, not assumed.
  const tsxPkg = JSON.parse(
    readFileSync(path.join(process.cwd(), "node_modules/tsx/package.json"), "utf8"),
  ) as { version?: string; exports?: Record<string, unknown> };
  assert("`tsx` declares a root export, so `--import tsx` is a public entry",
    typeof tsxPkg.exports === "object" && tsxPkg.exports !== null && "." in tsxPkg.exports,
    Object.keys(tsxPkg.exports ?? {}).join(","));

  // Checked on the runtime value, not on the source text: a textual check
  // for this declaration would match the assertion that states it.
  assert("this contract spawns the worker through that same public loader",
    TSX_LOADER.length === 2 && TSX_LOADER[0] === "--import" && TSX_LOADER[1] === "tsx",
    TSX_LOADER.join(" "));
  assert("the entrypoint documents the command a container must exec",
    entrySrc.includes(WORKER_COMMAND));
}

async function processChecks(): Promise<void> {
  // -------------------------------------------------- unknown mode fails
  const bad = await spawnWorker(bareEnv({ WORKER_EXECUTION_MODE: "enabled" }));
  assert("unknown mode exits non-zero", bad.code === 78, `code=${bad.code}`);
  assert("unknown mode reports a configuration rejection",
    /worker_configuration_rejected/.test(bad.stderr), bad.stderr.slice(0, 120));
  assert("unknown mode names the variable and no value",
    /WORKER_EXECUTION_MODE/.test(bad.stderr) && !/enabled"/.test(bad.stderr.replace(/"WORKER[^"]*"/g, "")),
    "");

  // ------- disabled: starts, serves health, stops cooperatively on BOTH
  // signals. The proof is the final event, emitted only after the
  // keep-alive handle is cleared and the health server has closed. A
  // process killed by the default signal disposition cannot print it, so
  // the exit code is not load-bearing.
  //
  // A port taken between allocation and bind is infrastructure, not the
  // worker — but it may NEVER turn into a skipped proof. It is retried on
  // a fresh port, at most three times, and exhaustion is a recorded
  // failure with a non-zero exit.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const outcome = await proveSignal(sig, freePort, record);
    assert(`${sig}: the scenario ran to completion within ${MAX_PORT_ATTEMPTS} attempts`,
      outcome.status === "proved", `${outcome.status} after ${outcome.attempts} attempt(s)`);
    if (outcome.status === "proved") {
      completedSignals.add(sig);
      checkpoint(sig === "SIGTERM" ? "signal:SIGTERM" : "signal:SIGINT");
    }
  }
  assert("both signals were exercised, not merely attempted",
    completedSignals.size === 2 && completedSignals.has("SIGTERM") && completedSignals.has("SIGINT"),
    [...completedSignals].join(",") || "none");

  // ------------------------------ the bind host, on the real process
  //
  // The two scenarios above set no WORKER_HEALTH_HOST at all, and each of
  // them asserted that the process reported `healthHost` 127.0.0.1 and
  // that the loopback endpoints answered. That is the default proof, and
  // it is only claimed here once those scenarios actually completed.
  if (completedSignals.has("SIGTERM") && completedSignals.has("SIGINT")) {
    checkpoint("health:default-loopback");
  }
  {
    // The wildcard, and only after an explicit value. Same ephemeral-port
    // lifecycle, same endpoints, same payload, same cooperative stop —
    // widening the bind must change the address and nothing else.
    const outcome = await proveSignal("SIGTERM", freePort, record, undefined, "0.0.0.0");
    assert(`WORKER_HEALTH_HOST=0.0.0.0: the scenario ran to completion within ${MAX_PORT_ATTEMPTS} attempts`,
      outcome.status === "proved", `${outcome.status} after ${outcome.attempts} attempt(s)`);
    if (outcome.status === "proved") checkpoint("health:explicit-wildcard");
  }
  {
    // Port 0 still means no server at all, whatever the host is set to.
    const run = await spawnWorker(
      bareEnv({
        WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: "0", WORKER_HEALTH_HOST: "0.0.0.0",
      }),
      async (kill) => { kill("SIGTERM"); },
    );
    assert("port 0 with an explicit host still starts no server",
      /"healthPort":0/.test(run.stdout) && /"healthServerClosed":false/.test(run.stdout),
      run.stdout.replace(/\s+/g, " ").slice(0, 160));
    assert("port 0 still reports the resolved host",
      /"healthHost":"0\.0\.0\.0"/.test(run.stdout));
    assert("port 0 still stops cooperatively and exits 0",
      /worker_execution_disabled_stopped/.test(run.stdout) && run.code === 0 && run.signal === null,
      `code=${run.code} signal=${run.signal}`);
    assert("port 0 writes nothing to stderr", run.stderr.trim() === "", run.stderr.slice(0, 160));
  }
  {
    // An invalid bind address is refused by the same call that guards the
    // live branch, so the inert worker refuses it too — before anything
    // could have been imported, opened or read.
    const run = await spawnWorker(
      bareEnv({ WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_HOST: "localhost" }),
    );
    assert("an invalid bind host exits EX_CONFIG", run.code === 78, `code=${run.code}`);
    assert("an invalid bind host names the variable",
      /worker_configuration_rejected/.test(run.stderr) && /WORKER_HEALTH_HOST/.test(run.stderr),
      run.stderr.slice(0, 160));
    assert("an invalid bind host never echoes the value it refused",
      !/localhost/.test(run.stderr), run.stderr.slice(0, 160));
    assert("an invalid bind host starts nothing",
      !/worker_execution_disabled/.test(run.stdout), run.stdout.slice(0, 160));
  }

  // ------------------------------------------- the retry path, for real
  //
  // Attempt 1 is made to collide deterministically by holding the port the
  // allocator hands out. The scenario must clean up that attempt, take a
  // fresh port, and complete on attempt 2.
  {
    const held = await freePort();
    // The blocker ANSWERS. A server that accepts and never replies would
    // leave the scenario's probes hanging until the guard fires, turning a
    // fast retry test into a multi-minute stall.
    const blocker = createServer((_req, res) => { res.writeHead(503).end(); });
    await new Promise<void>((resolve) => blocker.listen(held, "127.0.0.1", () => resolve()));
    let handedOut = 0;
    const allocator = async (): Promise<number> => {
      handedOut += 1;
      if (handedOut === 1) return held;          // guaranteed EADDRINUSE
      return freePort();
    };
    const local: string[] = [];
    const outcome = await proveSignal("SIGTERM", allocator, (m) => local.push(m), () => {
      // Between attempt 1 and attempt 2: release the port so the retry can
      // succeed, and confirm attempt 1 left nothing behind.
      blocker.close();
    });
    assert("the retry path: attempt 1 collided and attempt 2 completed",
      outcome.status === "proved" && outcome.attempts === 2,
      `${outcome.status} after ${outcome.attempts} attempt(s)`);
    assert("the retry path recorded no business failure",
      local.length === 0, local.join(" | "));
    assert("the collided attempt left no worker listening on its port",
      !(await workerHoldsPort(held)), `port ${held}`);
    blocker.close();
    checkpoint("retry:collision-then-success");
  }

  // --------------------------------- three collisions must FAIL, not skip
  {
    const held = await freePort();
    const blocker = createServer((_req, res) => { res.writeHead(503).end(); });
    await new Promise<void>((resolve) => blocker.listen(held, "127.0.0.1", () => resolve()));
    const local: string[] = [];
    // An allocator that always returns the occupied port.
    const outcome = await proveSignal("SIGTERM", async () => held, (m) => local.push(m));
    blocker.close();
    assert("three collisions exhaust the retries",
      outcome.status === "infrastructure" && outcome.attempts === MAX_PORT_ATTEMPTS,
      `${outcome.status} after ${outcome.attempts} attempt(s)`);
    assert("exhaustion is recorded as a failure, never a skip",
      local.length === 1 && /infrastructure/i.test(local[0]), local.join(" | "));
    checkpoint("retry:exhausted-fails");
  }

  // ----------------------------------- disabled without a health port
  const unusedPort = await freePort();
  const noPort = await spawnWorker(
    bareEnv({ WORKER_EXECUTION_MODE: "disabled" }),
    async (kill) => {
      let refused = false;
      try { await get(unusedPort, "/healthz"); } catch { refused = true; }
      assert("no health server is bound when the port is 0", refused);
      kill();
    },
  );
  assert("disabled without a health port stops cooperatively",
    /"event":"worker_execution_disabled_stopped"/.test(noPort.stdout),
    noPort.stdout.replace(/\s+/g, " ").slice(0, 160));
  assert("disabled without a health port reports no health server",
    /"healthServerClosed":false/.test(noPort.stdout), "");
  assert("disabled without a health port writes nothing to stderr",
    noPort.stderr.trim() === "", noPort.stderr.slice(0, 160));

  // ═══════ negative mutation: an entrypoint WITHOUT signal handlers must fail
  //
  // The audit that produced this section showed the previous contract
  // passing on exactly such a build: it served health, was killed by the
  // default disposition, exited 143 with an empty stderr, and every
  // assertion held. The mutated copy lives in the OS temp directory, never
  // in the repository, and is removed in a finally.
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zypact-gate-mutation-"));
    try {
      const original = readFileSync(path.join(process.cwd(), "scripts/run-protocol-worker.ts"), "utf8");
      const mutated = original.replace(
        /const signalName = await new Promise<string>\(\(resolve\) => \{[\s\S]*?\}\);/,
        'const signalName = await new Promise<string>(() => { /* no handler installed */ });',
      );
      assert("the mutation actually removed the signal handlers",
        mutated !== original && !mutated.includes('process.once("SIGTERM"'), "");

      const mutantPath = path.join(dir, "mutant-worker.ts");
      writeFileSync(mutantPath, mutated, "utf8");

      const port = await freePort();
      const result = await new Promise<RunResult>((resolve) => {
        const child = spawn(process.execPath, [...TSX_LOADER, mutantPath], {
          cwd: process.cwd(),
          env: bareEnv({ WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: String(port) }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = ""; let err = ""; let armed = false;
        const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
        guard.unref();
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
          if (!armed && /worker_execution_disabled/.test(out)) {
            armed = true;
            setTimeout(() => child.kill("SIGTERM"), 400);
          }
        });
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("close", (code, signal) => {
          clearTimeout(guard);
          resolve({ code, signal, stdout: out, stderr: err });
        });
      });

      assert("the handler-less mutant still starts and logs its first event",
        /"event":"worker_execution_disabled"/.test(result.stdout), "");
      // The whole point: the old exit-code assertion would still have held.
      assert("the handler-less mutant is terminated by the default disposition",
        result.signal === "SIGTERM" || result.code === 143,
        `code=${result.code} signal=${result.signal}`);
      // And the new one does not.
      assert("the handler-less mutant emits NO cooperative stop event",
        !/worker_execution_disabled_stopped/.test(result.stdout),
        result.stdout.replace(/\s+/g, " ").slice(0, 160));
      checkpoint("mutation:handler-less");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------- this file reads no .env
  const self = readFileSync(path.join(process.cwd(), "scripts/test-m0-worker-execution-gate.ts"), "utf8");
  // Both needles are assembled at runtime: written literally they would
  // appear in this file and make the assertion match itself.
  const envFile = [".", "env"].join("");
  const loader = ["dot", "env"].join("");
  assert("the contract never reads an env file",
    !new RegExp(`readFileSync\\([^)]*\\${envFile}`).test(self) && !self.includes(`"${loader}"`),
    "");
  assert("the contract adds a keep-alive check for the inert process",
    self.includes("disabled stays up"), "");
  assert("the contract contacts no host other than loopback",
    (self.match(/fetch\(`?https?:\/\/(?!127\.0\.0\.1)/g) ?? []).length === 0);
}

// ═════════════════════════════════════════════════════════════ report
// tsx transforms this file to CJS, where top-level await is unavailable,
// so the process half runs inside a function and reports from its promise.
processChecks().then(() => {
  // A missing mandatory proof is a failure even when nothing was recorded:
  // otherwise a branch that quietly skipped a scenario would simply lower
  // the total and still report a pass.
  for (const name of MANDATORY_CHECKPOINTS) {
    checks += 1;
    if (!reached.has(name)) failures.push(`mandatory proof never ran: ${name}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${checks} checks FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`${checks}/${checks} checks passed, ${MANDATORY_CHECKPOINTS.length}/`
    + `${MANDATORY_CHECKPOINTS.length} mandatory proofs executed. `
    + "M0 worker execution gate contract PASSED.");
}).catch((err: unknown) => {
  console.error(`\nharness error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
