/**
 * M0 — worker execution gate.
 *
 * The worker is one `npm run worker:protocol` away from spending real money
 * on Perplexity and an analysis provider. Before this module the only thing
 * standing between a misconfigured host and a paid call was the absence of
 * an API key, and the failure mode was a crash halfway through startup —
 * after the db client had been built and, on a bad day, after a job had
 * been claimed.
 *
 * This module makes the default inert and the live path deliberate. It is
 * pure: it reads a plain record, touches no process state, opens no socket,
 * and never constructs a db client or a provider transport. Everything it
 * can refuse, it refuses before the caller is allowed to build any of them.
 *
 * Error messages name the VARIABLE at fault and never its value, length,
 * prefix or hash. A configuration error is read by whoever is holding the
 * terminal, and that terminal is not a place to leak a service-role key.
 */

export type WorkerExecutionMode = "disabled" | "live";

/** Providers the analysis leg may use. `mock` and `auto` are not live modes. */
export type LiveAnalysisProvider = "openai" | "anthropic";

/**
 * The only two addresses the health server may bind. `127.0.0.1` keeps the
 * surface on the host that runs the worker; `0.0.0.0` exposes it to the
 * orchestrator's health prober and is therefore never a default — a host
 * has to ask for it in writing.
 *
 * There is no third option on purpose. A hostname would need DNS, and a
 * DNS answer is a runtime input: `localhost` can resolve to `::1`, and an
 * arbitrary name can resolve anywhere at all. Binding a health surface is
 * not a place to accept an answer that may change between two restarts.
 */
export type HealthHost = "127.0.0.1" | "0.0.0.0";

export interface LiveWorkerConfig {
  readonly workerId: string;
  readonly supabaseUrl: string;
  readonly expectedProjectRef: string;
  readonly analysisProvider: LiveAnalysisProvider;
  readonly leaseSeconds: number;
  readonly idleBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxSlotsPerClaim: number;
  readonly jitterRatio: number;
  readonly maxThrottledRetries: number;
  readonly graceMs: number;
  /**
   * B1 — structural single-job mode. When true the loop exits after the
   * FIRST iteration that actually claimed a job, whatever its outcome, and
   * never issues a second claim. Required in live so the choice is always
   * deliberate; never read on the disabled path.
   */
  readonly exitAfterClaimedJob: boolean;
  /**
   * B2 — per-provider-call ceiling, in ms. Applied separately to each leg,
   * started immediately before the wire and covering the whole response
   * including the body read. Must leave room for the grace budget inside
   * the lease. Required in live; never read on the disabled path.
   */
  readonly providerTimeoutMs: number;
  /**
   * B3-intrinsic — total process lifetime ceiling, in SECONDS. The only
   * bound that is about the run rather than about one call, one claim or
   * one job. Required in live so no run is open-ended; never read on the
   * disabled path.
   */
  readonly maxRuntimeSeconds: number;
  /**
   * B3-intrinsic — the runtime a single canary claim can still need, in
   * ms. Computed ONCE here by `claimBudgetMs` and carried on the config,
   * so the validation that refuses an impossible ceiling and the loop that
   * declines a claim use the same number and cannot drift apart.
   */
  readonly claimBudgetMs: number;
  readonly perplexityReservedCostUsd: number;
  readonly analysisReservedCostUsd: number;
  readonly healthPort: number;
  readonly healthHost: HealthHost;
  readonly readyStaleMs: number;
}

export type ExecutionPlan =
  | { readonly mode: "disabled"; readonly healthPort: number; readonly healthHost: HealthHost }
  | { readonly mode: "live"; readonly config: LiveWorkerConfig };

/**
 * Raised for every configuration refusal. Carries the offending variable
 * names so a supervisor can log them, and nothing else.
 */
export class WorkerConfigError extends Error {
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[] = []) {
    super(message);
    this.name = "WorkerConfigError";
    this.variables = variables;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const MODES: readonly string[] = ["disabled", "live"];

/**
 * Explicit ceilings. Every one of them exists because the value below it
 * has a real meaning and the value above it does not.
 *
 *   MAX_PORT              a TCP port is 16 bits.
 *   MAX_JITTER            a ratio; above 1 the backoff would exceed its
 *                         own ceiling by construction.
 *   MAX_RESERVED_USD      a per-call reservation. 10 USD is already two
 *                         orders of magnitude above the 0.02 default; a
 *                         larger figure is a typo, not a budget, and
 *                         admission control would reserve it for real.
 *   MAX_SMALL_INT         counts and retries.
 *   MAX_DURATION_MS       one day, in milliseconds.
 *   MAX_LEASE_SECONDS     one day, in seconds.
 */
const MAX_PORT = 65535;
const MAX_JITTER = 1;
const MAX_RESERVED_USD = 10;
const MAX_SMALL_INT = 10_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_LEASE_SECONDS = 86_400;
/**
 * B3-intrinsic — the ceiling on WORKER_MAX_RUNTIME_SECONDS is not a taste
 * decision, it is the timer that enforces it. Node's `setTimeout` stores
 * its delay in a signed 32-bit integer: past 2147483647 ms it does not
 * throw, it OVERFLOWS and fires almost immediately. A runtime bound that
 * silently degenerates into "stop now" would be worse than none, so the
 * largest accepted value is the largest one the mechanism can actually
 * represent — 2147483 s, a little under 24.9 days.
 */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_RUNTIME_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

/** Supabase project refs are twenty lowercase letters. */
const PROJECT_REF = /^[a-z]{20}$/;

/**
 * Closed worker-id format: it lands in logs and in the `claimed_by` column,
 * so it may not carry punctuation that would let it be confused with a
 * token or smuggle a newline into a log line.
 */
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/**
 * TK-R-5 — a live analysis model must be a DATED, immutable snapshot.
 *
 * The receipt records which model was asked for. When that string is a
 * floating alias the record is worthless: `gpt-4o-mini` resolved to one
 * snapshot last month and may resolve to another tomorrow, and nothing in
 * the evidence would show the difference. OpenAI publishes dated snapshots
 * exactly for this — `gpt-4o-mini-2024-07-18` — so live requires that
 * shape and refuses everything else BEFORE any transport is built.
 *
 * The rule is deliberately narrow: a trailing `-YYYY-MM-DD`. It admits the
 * configuration this repository already validated and rejects every alias,
 * dated or not, that does not carry its own snapshot date.
 */
const DATED_MODEL = /^[a-z0-9](?:[a-z0-9.]|-(?!-))*-\d{4}-\d{2}-\d{2}$/;

/**
 * Aliases known to float. `latest` is caught by its own rule; these are the
 * bare family names that silently track a moving target.
 */
const FLOATING_MODEL_ALIASES: readonly string[] = [
  "gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-turbo", "gpt-3.5-turbo",
  "gpt-4.1", "gpt-4.1-mini", "o1", "o1-mini", "o3", "o3-mini",
  "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus",
  "claude-sonnet-4", "claude-opus-4",
];

/** Closed allow-list. Order is display order in the error message. */
const HEALTH_HOSTS: readonly HealthHost[] = ["127.0.0.1", "0.0.0.0"];

function raw(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * The value exactly as the host set it, with no trimming. Used where the
 * contract says "exactly": a trailing space in ZYPACT_MOCK_MODE or
 * WORKER_LIVE_CONFIRM is a copy-paste accident, and a gate whose whole
 * purpose is to fail closed should surface it rather than absorb it.
 */
function exact(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === "string" ? v : undefined;
}

/** True when the host defined the variable at all, empty string included. */
function defined(env: Env, name: string): boolean {
  return typeof env[name] === "string";
}

function required(env: Env, name: string): string {
  const v = raw(env, name);
  if (v === undefined) {
    throw new WorkerConfigError(`${name} is required in live execution mode.`, [name]);
  }
  return v;
}

/**
 * Integer with a fallback — but an explicitly supplied invalid value is an
 * error, never a silent return to the default. A host that sets
 * WORKER_LEASE_SECONDS=0 by accident must be told, not quietly given 60.
 */
/**
 * B1 — a strictly literal boolean. Absent, empty or anything other than
 * `true`/`false` is refused, naming only the variable. There is no default:
 * a live worker must state whether it stops after one job.
 */
function strictBoolOrThrow(env: Env, name: string): boolean {
  const v = raw(env, name);
  if (v === undefined) {
    throw new WorkerConfigError(`${name} is required in live execution.`, [name]);
  }
  if (v !== "true" && v !== "false") {
    throw new WorkerConfigError(`${name} must be exactly "true" or "false".`, [name]);
  }
  return v === "true";
}

/** B2 — a required integer with no default, bounded by [min, max]. */
function requiredIntOrThrow(env: Env, name: string, min: number, max: number): number {
  const v = raw(env, name);
  if (v === undefined) {
    throw new WorkerConfigError(`${name} is required in live execution.`, [name]);
  }
  if (!/^-?\d+$/.test(v)) {
    throw new WorkerConfigError(`${name} must be an integer.`, [name]);
  }
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new WorkerConfigError(`${name} must be an integer between ${min} and ${max}.`, [name]);
  }
  return n;
}

function intOrThrow(
  env: Env, name: string, fallback: number, min: number, max: number,
): number {
  if (!defined(env, name)) return fallback;
  const v = raw(env, name);
  if (v === undefined) {
    // Defined but empty. Falling back here would hand a host that wrote
    // `WORKER_GRACE_MS=` the documented default without a word.
    throw new WorkerConfigError(`${name} is defined but empty.`, [name]);
  }
  if (!/^-?\d+$/.test(v)) {
    throw new WorkerConfigError(`${name} must be an integer.`, [name]);
  }
  const n = Number.parseInt(v, 10);
  // isSafeInteger, not isFinite: past 2^53 parseInt returns an imprecise
  // float, so `999999999999999999999` would sail through as a "number"
  // and produce a lease or a port that means nothing.
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new WorkerConfigError(`${name} must be an integer between ${min} and ${max}.`, [name]);
  }
  return n;
}

function floatOrThrow(
  env: Env, name: string, fallback: number, min: number, exclusive: boolean, max: number,
): number {
  if (!defined(env, name)) return fallback;
  const v = raw(env, name);
  if (v === undefined) {
    throw new WorkerConfigError(`${name} is defined but empty.`, [name]);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(v)) {
    throw new WorkerConfigError(`${name} must be a number.`, [name]);
  }
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || (exclusive ? n <= min : n < min) || n > max) {
    throw new WorkerConfigError(
      `${name} must be a number ${exclusive ? "greater than" : "of at least"} ${min} `
      + `and at most ${max}.`, [name],
    );
  }
  return n;
}

/**
 * The health bind address. Absent means loopback: a host that says nothing
 * gets the address that cannot be reached from off-box.
 *
 * Read with `exact`, NOT `raw`, so nothing is normalised away. A defined
 * but empty value, a single space, ` 0.0.0.0` with a stray leading space —
 * each of those is a host that meant something and got it wrong, and each
 * of them is refused rather than silently trimmed into acceptance or
 * silently dropped back to the default. No trimming, no case folding, no
 * DNS lookup, no hostname, no IPv6 form.
 */
function healthHostOrThrow(env: Env): HealthHost {
  const v = exact(env, "WORKER_HEALTH_HOST");
  if (v === undefined) return "127.0.0.1";
  for (const allowed of HEALTH_HOSTS) {
    if (v === allowed) return allowed;
  }
  throw new WorkerConfigError(
    `WORKER_HEALTH_HOST must be exactly one of: ${HEALTH_HOSTS.join(", ")}.`,
    ["WORKER_HEALTH_HOST"],
  );
}

/**
 * TK-R-5 — the versioned-model rule, in ONE place.
 *
 * Returns null when the model is an acceptable dated snapshot, or a closed
 * label saying why it was refused. The exported predicate and the live gate
 * both delegate here, so the rule the tests exercise and the rule
 * production enforces cannot drift apart.
 *
 * An absent or empty value never reaches this function in the live path —
 * `required()` refuses it first, naming the variable. Passed directly, an
 * empty string falls through to `not_dated`, which is the same refusal.
 */
type AnalysisModelRefusal = "floating_alias" | "latest_tag" | "not_dated";

function classifyAnalysisModel(model: string): AnalysisModelRefusal | null {
  if (FLOATING_MODEL_ALIASES.includes(model)) return "floating_alias";
  if (model.endsWith("latest")) return "latest_tag";
  if (!DATED_MODEL.test(model)) return "not_dated";
  return null;
}

/** Each refusal names the variable and never its value. */
const ANALYSIS_MODEL_REFUSAL_MESSAGE: Record<AnalysisModelRefusal, (name: string) => string> = {
  floating_alias: (name) =>
    `${name} is a floating alias; live execution requires a dated model snapshot.`,
  latest_tag: (name) =>
    `${name} ends in "latest"; live execution requires a dated model snapshot.`,
  not_dated: (name) =>
    `${name} must be a dated model snapshot ending in -YYYY-MM-DD.`,
};

/**
 * B3-intrinsic — what one claim can still need, in milliseconds.
 *
 * TWO provider legs, not one. A single baseline slot calls Perplexity and
 * then the analysis model, sequentially, and `providerTimeoutMs` bounds
 * EACH of them separately. Budgeting one leg plus the grace was wrong by a
 * whole provider call: a claim admitted with 55 s left could still be
 * mid-analysis when the absolute deadline cut the process off, having
 * already paid for the probe.
 *
 * Scoped to the first canary, which runs `WORKER_MAX_SLOTS_PER_CLAIM=1`.
 * A claim allowed to drive N slots would need `2 * N * providerTimeoutMs`,
 * and generalising that is deliberately NOT part of this changeset — the
 * canary constraint is documented in `.env.example` instead.
 *
 * Exported so the rule is exercised value-by-value, and used by both the
 * configuration gate and the runtime bound. There is one implementation.
 */
export function claimBudgetMs(providerTimeoutMs: number, graceMs: number): number {
  return 2 * providerTimeoutMs + graceMs;
}

/**
 * TK-R-5 — the versioned-model rule, as a pure predicate.
 *
 * Exported so the rule can be exercised value-by-value without
 * assembling a whole live environment: the reason a model is refused is
 * the thing under test, and it must not depend on which of the other
 * eleven live preconditions happens to fail first. It is a thin view over
 * `classifyAnalysisModel`, never a second implementation.
 */
export function isDatedAnalysisModel(model: string): boolean {
  return classifyAnalysisModel(model) === null;
}

/**
 * TK-R-5 — the live analysis model gate.
 *
 * Refuses, in this order: an absent or empty value, a known floating
 * alias, anything ending in `latest`, and anything that is not a dated
 * snapshot. Every refusal names the variable and never its value, in
 * keeping with the rest of this module.
 */
function requireDatedAnalysisModel(env: Env, name: string): string {
  const model = required(env, name);
  const refusal = classifyAnalysisModel(model);
  if (refusal !== null) {
    throw new WorkerConfigError(ANALYSIS_MODEL_REFUSAL_MESSAGE[refusal](name), [name]);
  }
  return model;
}

/**
 * Resolves the execution plan, or throws. Absent or empty mode is
 * `disabled`: a host that forgets the variable gets the inert worker, never
 * the spending one.
 */
export function resolveExecutionPlan(env: Env): ExecutionPlan {
  const modeRaw = raw(env, "WORKER_EXECUTION_MODE");
  const mode: string = modeRaw === undefined ? "disabled" : modeRaw;

  if (!MODES.includes(mode)) {
    throw new WorkerConfigError(
      `WORKER_EXECUTION_MODE must be one of: ${MODES.join(", ")}.`,
      ["WORKER_EXECUTION_MODE"],
    );
  }

  // The health port is the only thing the disabled path reads. It is
  // validated the same way, so a bad value fails rather than disabling the
  // health surface without saying so.
  const healthPort = intOrThrow(env, "WORKER_HEALTH_PORT", 0, 0, MAX_PORT);
  // Validated in BOTH modes, and here — before the disabled branch returns
  // and long before `runLive` is allowed to import anything. A host that
  // mistypes the bind address is told so by the inert worker too, rather
  // than discovering it the first time execution is switched on.
  const healthHost = healthHostOrThrow(env);

  if (mode === "disabled") return { mode: "disabled", healthPort, healthHost };

  // ---------------------------------------------------------------- live
  // Order matters: the cheapest, most categorical refusals first, so a
  // misconfigured host fails on the obvious thing rather than on a
  // downstream symptom.

  if (raw(env, "NODE_ENV") !== "production") {
    throw new WorkerConfigError(
      "NODE_ENV must be production in live execution mode.", ["NODE_ENV"],
    );
  }

  if (raw(env, "ZYPACT_ALLOW_MEMORY_DB") === "true") {
    throw new WorkerConfigError(
      "ZYPACT_ALLOW_MEMORY_DB must not be true in live execution mode.",
      ["ZYPACT_ALLOW_MEMORY_DB"],
    );
  }

  // `off` exactly. Absent, empty and `auto` are all refused: a live worker
  // must not depend on mock-mode inference, and ZYPACT_MOCK_MODE is not a
  // worker mock switch — the Perplexity leg ignores it entirely.
  if (exact(env, "ZYPACT_MOCK_MODE") !== "off") {
    throw new WorkerConfigError(
      "ZYPACT_MOCK_MODE must be exactly off in live execution mode.",
      ["ZYPACT_MOCK_MODE"],
    );
  }

  const workerId = required(env, "WORKER_ID");
  if (!WORKER_ID.test(workerId)) {
    throw new WorkerConfigError(
      "WORKER_ID must be 3-64 characters of letters, digits, dot, underscore or dash.",
      ["WORKER_ID"],
    );
  }

  const supabaseUrl = required(env, "NEXT_PUBLIC_SUPABASE_URL");
  required(env, "SUPABASE_SERVICE_ROLE_KEY");

  const expectedRef = required(env, "WORKER_EXPECTED_SUPABASE_PROJECT_REF");
  if (!PROJECT_REF.test(expectedRef)) {
    throw new WorkerConfigError(
      "WORKER_EXPECTED_SUPABASE_PROJECT_REF must be a Supabase project ref.",
      ["WORKER_EXPECTED_SUPABASE_PROJECT_REF"],
    );
  }

  // The URL is parsed and then required to be CANONICAL, component by
  // component. Checking only the protocol and the hostname is not enough:
  // `https://user:pw@<right-host>`, `https://<right-host>:8443`,
  // `https://<right-host>/path`, `?query` and `#fragment` all carry the
  // expected hostname and would otherwise be accepted while sending the
  // worker somewhere other than the project this configuration names.
  //
  // Exactly one shape is accepted: https://<ref>.supabase.co with an empty
  // username, password, port, path of "/", no query and no fragment.
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL is not a valid URL.", ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }
  if (parsed.protocol !== "https:") {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL must use https.", ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }
  if (parsed.hostname !== `${expectedRef}.supabase.co`) {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL host does not match WORKER_EXPECTED_SUPABASE_PROJECT_REF.",
      ["NEXT_PUBLIC_SUPABASE_URL", "WORKER_EXPECTED_SUPABASE_PROJECT_REF"],
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL must not carry credentials in its authority.",
      ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }
  if (parsed.port !== "") {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL must not specify a port.", ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }
  if (parsed.pathname !== "/") {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL must have no path.", ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new WorkerConfigError(
      "NEXT_PUBLIC_SUPABASE_URL must have no query string and no fragment.",
      ["NEXT_PUBLIC_SUPABASE_URL"],
    );
  }

  // A second, independent statement of intent. Pointing the worker at a
  // different project now takes two coordinated edits, not one.
  required(env, "WORKER_LIVE_CONFIRM");
  if (exact(env, "WORKER_LIVE_CONFIRM") !== `LIVE:${expectedRef}`) {
    throw new WorkerConfigError(
      "WORKER_LIVE_CONFIRM must be LIVE:<WORKER_EXPECTED_SUPABASE_PROJECT_REF>.",
      ["WORKER_LIVE_CONFIRM"],
    );
  }

  required(env, "PERPLEXITY_API_KEY");

  const provider = exact(env, "LLM_PROVIDER");
  if (provider !== "openai" && provider !== "anthropic") {
    throw new WorkerConfigError(
      "LLM_PROVIDER must be exactly openai or anthropic in live execution mode.",
      ["LLM_PROVIDER"],
    );
  }
  required(env, provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");

  // TK-R-5 — refuse a floating model before anything can be sent.
  //
  // Anthropic is fail-closed on purpose. No dated Anthropic snapshot has
  // been decided and verified against the provider's own documentation for
  // this repository, and inventing one would put an unverified string into
  // durable evidence. Until such a model is chosen in writing, live
  // execution accepts OpenAI only; the Anthropic transport itself is
  // untouched and stays available to mock and non-live paths.
  if (provider === "anthropic") {
    throw new WorkerConfigError(
      "LLM_PROVIDER=anthropic is not permitted in live execution until a dated "
        + "Anthropic model snapshot is decided; use openai.",
      ["LLM_PROVIDER", "ANTHROPIC_MODEL"],
    );
  }
  requireDatedAnalysisModel(env, "OPENAI_MODEL");

  const leaseSeconds = intOrThrow(env, "WORKER_LEASE_SECONDS", 60, 1, MAX_LEASE_SECONDS);
  const graceMs = intOrThrow(env, "WORKER_GRACE_MS", 10000, 0, MAX_DURATION_MS);
  if (graceMs >= leaseSeconds * 1000) {
    throw new WorkerConfigError(
      "WORKER_GRACE_MS must be strictly less than WORKER_LEASE_SECONDS in milliseconds.",
      ["WORKER_GRACE_MS", "WORKER_LEASE_SECONDS"],
    );
  }

  const exitAfterClaimedJob = strictBoolOrThrow(env, "WORKER_EXIT_AFTER_CLAIMED_JOB");
  const providerTimeoutMs = requiredIntOrThrow(env, "WORKER_PROVIDER_TIMEOUT_MS", 1000, MAX_DURATION_MS);
  // A provider call that may run to its ceiling, plus the shutdown grace it
  // would then consume, must still finish inside the lease. Otherwise the
  // worker can be mid-call on a lease it can no longer renew.
  if (providerTimeoutMs + graceMs >= leaseSeconds * 1000) {
    throw new WorkerConfigError(
      "WORKER_PROVIDER_TIMEOUT_MS + WORKER_GRACE_MS must be strictly less than "
        + "WORKER_LEASE_SECONDS in milliseconds.",
      ["WORKER_PROVIDER_TIMEOUT_MS"],
    );
  }

  // B3-intrinsic — the total runtime ceiling.
  //
  // `requiredIntOrThrow` refuses, naming only this variable: absent, empty
  // or blank; a fraction (`120.5`); exponential notation (`1.2e2`); a sign
  // or padding that is not a plain decimal integer; zero and every
  // negative, because a ceiling of nothing is not a ceiling; anything past
  // 2^53 that `parseInt` would round into a lie; and anything the timer
  // that enforces it could not represent.
  const maxRuntimeSeconds = requiredIntOrThrow(
    env, "WORKER_MAX_RUNTIME_SECONDS", 1, MAX_RUNTIME_SECONDS,
  );
  // A run whose whole budget cannot absorb ONE CLAIM — both provider legs
  // plus the wind-down after them — could never issue a single claim: the
  // worker would start, decline its first claim and stop. That is a
  // misconfiguration, not a very short run, and it is refused at startup
  // rather than discovered from an empty log.
  const claimBudget = claimBudgetMs(providerTimeoutMs, graceMs);
  if (claimBudget >= maxRuntimeSeconds * 1000) {
    throw new WorkerConfigError(
      "2 x WORKER_PROVIDER_TIMEOUT_MS + WORKER_GRACE_MS must be strictly less than "
        + "WORKER_MAX_RUNTIME_SECONDS in milliseconds: one baseline slot makes two "
        + "provider calls, each bounded separately.",
      ["WORKER_MAX_RUNTIME_SECONDS", "WORKER_PROVIDER_TIMEOUT_MS", "WORKER_GRACE_MS"],
    );
  }

  const idleBackoffMs = intOrThrow(env, "WORKER_IDLE_BACKOFF_MS", 2000, 1, MAX_DURATION_MS);
  const maxBackoffMs = intOrThrow(env, "WORKER_MAX_BACKOFF_MS", 30000, 1, MAX_DURATION_MS);

  return {
    mode: "live",
    config: {
      workerId,
      supabaseUrl,
      expectedProjectRef: expectedRef,
      analysisProvider: provider,
      leaseSeconds,
      idleBackoffMs,
      maxBackoffMs,
      maxSlotsPerClaim: intOrThrow(env, "WORKER_MAX_SLOTS_PER_CLAIM", 32, 1, MAX_SMALL_INT),
      jitterRatio: floatOrThrow(env, "WORKER_JITTER_RATIO", 0.5, 0, false, MAX_JITTER),
      maxThrottledRetries: intOrThrow(env, "WORKER_MAX_THROTTLED_RETRIES", 3, 0, MAX_SMALL_INT),
      graceMs,
      exitAfterClaimedJob,
      providerTimeoutMs,
      maxRuntimeSeconds,
      claimBudgetMs: claimBudget,
      // Strictly positive: a zero reservation would let admission control
      // admit an attempt it has not actually budgeted for.
      perplexityReservedCostUsd:
        floatOrThrow(env, "WORKER_PERPLEXITY_RESERVED_USD", 0.02, 0, true, MAX_RESERVED_USD),
      analysisReservedCostUsd:
        floatOrThrow(env, "WORKER_ANALYSIS_RESERVED_USD", 0.02, 0, true, MAX_RESERVED_USD),
      healthPort,
      healthHost,
      readyStaleMs: Math.max(
        maxBackoffMs * 2, intOrThrow(env, "WORKER_READY_STALE_MS", 60000, 1, MAX_DURATION_MS),
      ),
    },
  };
}
