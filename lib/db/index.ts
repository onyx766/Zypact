import { memoryAdapter } from "./memory-adapter";
import type { DbAdapter } from "./types";

/**
 * Database adapter selection.
 *
 * Supabase is used whenever both required server variables are present.
 * When they are not, the in-memory adapter is only permitted in
 * environments where non-persistence is safe. Production always fails
 * closed: a missing variable throws instead of silently discarding data.
 *
 * The selection logic lives in `resolveDbAdapterKind`, a pure function
 * over an environment snapshot, so it can be tested without networking,
 * module-cache tricks, or a live Supabase project.
 */

/** Server variables required for persistent database access. */
export const REQUIRED_SUPABASE_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export type DbEnvironment =
  | "production"
  | "preview"
  | "test"
  | "development"
  | "unknown";

export type DbAdapterKind = "supabase" | "memory";

/** The only environment values adapter selection depends on. */
export interface DbSelectionEnv {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  readonly VERCEL_ENV?: string;
  readonly NODE_ENV?: string;
  readonly ZYPACT_ALLOW_MEMORY_DB?: string;
}

/**
 * Raised when persistent configuration is required but incomplete.
 *
 * The message names the missing variables and never reports their
 * values, lengths, prefixes, or any other fingerprint.
 */
export class DbNotConfiguredError extends Error {
  readonly missingEnvVars: readonly string[];
  readonly environment: DbEnvironment;

  constructor(missingEnvVars: readonly string[], environment: DbEnvironment) {
    super(
      "Database not configured. NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY are required for persistent database " +
        `access. Missing or empty: ${missingEnvVars.join(", ")}`
    );
    this.name = "DbNotConfiguredError";
    this.missingEnvVars = [...missingEnvVars];
    this.environment = environment;
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Which required variables are missing or blank. Whitespace-only values
 * count as missing so a stray space cannot produce a broken client.
 */
export function missingSupabaseEnvVars(env: DbSelectionEnv): string[] {
  const missing: string[] = [];
  if (!normalize(env.NEXT_PUBLIC_SUPABASE_URL)) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!normalize(env.SUPABASE_SERVICE_ROLE_KEY)) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  return missing;
}

/**
 * Resolve the deployment environment.
 *
 * `VERCEL_ENV` wins whenever it is present; `NODE_ENV` is consulted only
 * in its absence. Anything unrecognized resolves to `unknown`, which is
 * treated as unsafe rather than assumed to be local.
 */
export function resolveDbEnvironment(env: DbSelectionEnv): DbEnvironment {
  const vercelEnv = normalize(env.VERCEL_ENV).toLowerCase();
  if (vercelEnv) {
    if (vercelEnv === "production") return "production";
    if (vercelEnv === "preview") return "preview";
    if (vercelEnv === "development") return "development";
    return "unknown";
  }

  const nodeEnv = normalize(env.NODE_ENV).toLowerCase();
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  if (nodeEnv === "development") return "development";
  return "unknown";
}

function memoryExplicitlyAllowed(env: DbSelectionEnv): boolean {
  return normalize(env.ZYPACT_ALLOW_MEMORY_DB).toLowerCase() === "true";
}

/**
 * Decide which adapter an environment snapshot selects.
 *
 * Throws `DbNotConfiguredError` when configuration is incomplete and the
 * environment is not permitted to run without persistence.
 */
export function resolveDbAdapterKind(env: DbSelectionEnv): DbAdapterKind {
  const missing = missingSupabaseEnvVars(env);
  if (missing.length === 0) return "supabase";

  const environment = resolveDbEnvironment(env);

  // Production never runs without persistence, flag or not.
  if (environment === "production") {
    throw new DbNotConfiguredError(missing, environment);
  }

  // Local development and automated tests may run without persistence.
  if (environment === "test" || environment === "development") {
    return "memory";
  }

  // Preview and unknown environments require an explicit opt-in, because
  // either may be executing real snapshot or customer workflows.
  if (memoryExplicitlyAllowed(env)) return "memory";

  throw new DbNotConfiguredError(missing, environment);
}

/**
 * Resolve the database adapter.
 *
 * Supabase is loaded lazily and only after the configuration guard has
 * passed, so an unconfigured environment never requires or constructs a
 * Supabase client.
 */
export function getDb(): DbAdapter {
  if (resolveDbAdapterKind(process.env) === "supabase") {
    // Lazy-require avoids pulling supabase-js into contexts that don't need it
    // and lets the memory adapter work even if the package is missing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabaseAdapter } = require("./supabase-adapter") as {
      supabaseAdapter: DbAdapter;
    };
    return supabaseAdapter;
  }
  return memoryAdapter;
}

export type * from "./types";
