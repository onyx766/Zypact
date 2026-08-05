#!/usr/bin/env tsx
/**
 * Database adapter selection tests.
 *
 * Verifies that production fails closed when Supabase configuration is
 * incomplete, and that the in-memory adapter is reachable only through a
 * safe, explicit condition.
 *
 * Makes no network call, opens no database connection, and does not read
 * `.env.local`. Every case that mutates `process.env` restores it.
 */

import {
  DbNotConfiguredError,
  getDb,
  missingSupabaseEnvVars,
  resolveDbAdapterKind,
  resolveDbEnvironment,
  type DbSelectionEnv,
} from "@/lib/db";
import { memoryAdapter } from "@/lib/db/memory-adapter";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Non-secret placeholders. Never printed by this test. */
const URL_PLACEHOLDER = "https://example.invalid";
const KEY_PLACEHOLDER = "placeholder-not-a-real-key";
const SENTINEL = "SENTINEL_MUST_NOT_APPEAR_IN_ERROR";

/** Capture the thrown error, or null when the call returned normally. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function expectThrows(
  name: string,
  env: DbSelectionEnv,
  expectedMissing: string[]
): void {
  const error = captureThrow(() => resolveDbAdapterKind(env));
  if (!(error instanceof DbNotConfiguredError)) {
    check(name, false, error === null ? "did not throw" : "wrong error type");
    return;
  }
  const namesMatch =
    error.missingEnvVars.length === expectedMissing.length &&
    expectedMissing.every((v) => error.missingEnvVars.includes(v));
  check(name, namesMatch, `missing=[${error.missingEnvVars.join(", ")}]`);
}

function expectMemory(name: string, env: DbSelectionEnv): void {
  const error = captureThrow(() => {
    const kind = resolveDbAdapterKind(env);
    if (kind !== "memory") throw new Error(`selected ${kind}`);
  });
  check(name, error === null, error instanceof Error ? error.message : "");
}

// ── 1-5. Production fails closed ─────────────────────────────────────────────

console.log("\nProduction fails closed");

expectThrows(
  "1. production + both variables missing throws",
  { VERCEL_ENV: "production" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "2. production + URL only throws for the service-role key",
  { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: URL_PLACEHOLDER },
  ["SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "3. production + service-role key only throws for the URL",
  { VERCEL_ENV: "production", SUPABASE_SERVICE_ROLE_KEY: KEY_PLACEHOLDER },
  ["NEXT_PUBLIC_SUPABASE_URL"]
);

expectThrows(
  "4a. production + empty-string values throws",
  {
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "4b. production + whitespace-only values throws",
  {
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "   ",
    SUPABASE_SERVICE_ROLE_KEY: "\t\n ",
  },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "5. production + ZYPACT_ALLOW_MEMORY_DB=true still throws",
  { VERCEL_ENV: "production", ZYPACT_ALLOW_MEMORY_DB: "true" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "5b. NODE_ENV=production (no VERCEL_ENV) + flag still throws",
  { NODE_ENV: "production", ZYPACT_ALLOW_MEMORY_DB: "true" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

// ── 6-7. Preview requires an explicit opt-in ─────────────────────────────────

console.log("\nPreview requires an explicit opt-in");

expectThrows(
  "6. preview + missing variables and no flag throws",
  { VERCEL_ENV: "preview" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectMemory("7. preview + explicit flag selects memory", {
  VERCEL_ENV: "preview",
  ZYPACT_ALLOW_MEMORY_DB: "true",
});

expectThrows(
  "7b. preview + flag set to a non-true value throws",
  { VERCEL_ENV: "preview", ZYPACT_ALLOW_MEMORY_DB: "1" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

// ── 8-9. Test and development may use memory ────────────────────────────────

console.log("\nTest and development may use memory");

expectMemory("8. NODE_ENV=test + missing variables selects memory", {
  NODE_ENV: "test",
});

expectMemory("9. NODE_ENV=development + missing variables selects memory", {
  NODE_ENV: "development",
});

expectMemory("9b. VERCEL_ENV=development selects memory", {
  VERCEL_ENV: "development",
});

// ── 10-11. Unknown environments are treated as unsafe ───────────────────────

console.log("\nUnknown environments are treated as unsafe");

expectThrows(
  "10a. unset environment + missing variables and no flag throws",
  {},
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "10b. unrecognized VERCEL_ENV + no flag throws",
  { VERCEL_ENV: "staging" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectMemory("11. unknown environment + explicit flag selects memory", {
  ZYPACT_ALLOW_MEMORY_DB: "true",
});

expectMemory("11b. flag comparison is case-insensitive and trimmed", {
  ZYPACT_ALLOW_MEMORY_DB: "  TRUE  ",
});

// ── 12. Configured environments select Supabase without networking ──────────

console.log("\nConfigured environments select Supabase");

const configured: DbSelectionEnv = {
  NEXT_PUBLIC_SUPABASE_URL: URL_PLACEHOLDER,
  SUPABASE_SERVICE_ROLE_KEY: KEY_PLACEHOLDER,
};

for (const environment of [
  "production",
  "preview",
  "development",
  "staging",
] as const) {
  const kind = resolveDbAdapterKind({ ...configured, VERCEL_ENV: environment });
  check(
    `12. VERCEL_ENV=${environment} + both variables present selects supabase`,
    kind === "supabase",
    `selected ${kind}`
  );
}

check(
  "12b. configured environment reports no missing variables",
  missingSupabaseEnvVars(configured).length === 0
);

check(
  "12c. surrounding whitespace still counts as configured",
  resolveDbAdapterKind({
    NEXT_PUBLIC_SUPABASE_URL: `  ${URL_PLACEHOLDER}  `,
    SUPABASE_SERVICE_ROLE_KEY: `  ${KEY_PLACEHOLDER}  `,
  }) === "supabase"
);

// ── 13. VERCEL_ENV takes precedence over NODE_ENV ───────────────────────────

console.log("\nVERCEL_ENV takes precedence over NODE_ENV");

expectThrows(
  "13a. VERCEL_ENV=production overrides NODE_ENV=test",
  { VERCEL_ENV: "production", NODE_ENV: "test" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectThrows(
  "13b. VERCEL_ENV=preview overrides NODE_ENV=development",
  { VERCEL_ENV: "preview", NODE_ENV: "development" },
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
);

expectMemory("13c. NODE_ENV=test applies when VERCEL_ENV is absent", {
  NODE_ENV: "test",
});

expectMemory("13d. NODE_ENV=test applies when VERCEL_ENV is blank", {
  VERCEL_ENV: "   ",
  NODE_ENV: "test",
});

check(
  "13e. resolveDbEnvironment maps VERCEL_ENV first",
  resolveDbEnvironment({ VERCEL_ENV: "production", NODE_ENV: "test" }) ===
    "production"
);

check(
  "13f. resolveDbEnvironment falls back to NODE_ENV",
  resolveDbEnvironment({ NODE_ENV: "development" }) === "development"
);

check(
  "13g. resolveDbEnvironment reports unknown for an unset environment",
  resolveDbEnvironment({}) === "unknown"
);

// ── 14. The error names variables but never values ──────────────────────────

console.log("\nThe error names variables but never values");

const sentinelError = captureThrow(() =>
  resolveDbAdapterKind({
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: SENTINEL,
  })
);

if (!(sentinelError instanceof DbNotConfiguredError)) {
  check("14. supplying one variable still throws in production", false);
} else {
  const message = sentinelError.message;
  check(
    "14a. message states the database is not configured",
    message.includes("Database not configured")
  );
  check(
    "14b. message names the missing variable",
    message.includes("Missing or empty: SUPABASE_SERVICE_ROLE_KEY")
  );
  check(
    "14c. message does not contain the supplied value",
    !message.includes(SENTINEL)
  );
  check(
    "14d. message does not report a value length",
    !message.includes(String(SENTINEL.length))
  );
  check(
    "14e. message does not list the variable that was supplied as missing",
    !sentinelError.missingEnvVars.includes("NEXT_PUBLIC_SUPABASE_URL")
  );
  check(
    "14f. error records the resolved environment",
    sentinelError.environment === "production"
  );
}

// ── getDb() wiring, with process.env restored and networking observed ───────

console.log("\ngetDb() wiring");

const OWNED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VERCEL_ENV",
  "NODE_ENV",
  "ZYPACT_ALLOW_MEMORY_DB",
] as const;

const originalEnv = new Map<string, string | undefined>(
  OWNED_KEYS.map((k) => [k, process.env[k]])
);

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv(overrides: DbSelectionEnv, fn: () => void): void {
  for (const key of OWNED_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value as string;
  }
  try {
    fn();
  } finally {
    restoreEnv();
  }
}

// Observe networking for the whole wiring section.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  fetchCalls += 1;
  return realFetch(...args);
}) as typeof fetch;

try {
  withEnv({ VERCEL_ENV: "production" }, () => {
    const error = captureThrow(() => getDb());
    check(
      "15a. getDb() throws in production when unconfigured",
      error instanceof DbNotConfiguredError
    );
  });

  withEnv({ NODE_ENV: "test" }, () => {
    check("15b. getDb() returns the memory adapter under test", getDb() === memoryAdapter);
  });

  withEnv(
    {
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: URL_PLACEHOLDER,
      SUPABASE_SERVICE_ROLE_KEY: KEY_PLACEHOLDER,
    },
    () => {
      const db = getDb();
      check(
        "15c. getDb() returns the Supabase adapter when configured",
        db !== memoryAdapter && typeof db.getProject === "function"
      );
    }
  );
} finally {
  globalThis.fetch = realFetch;
  restoreEnv();
}

check("16. no network request was made during selection", fetchCalls === 0, `fetch calls: ${fetchCalls}`);

const envRestored = OWNED_KEYS.every((k) => process.env[k] === originalEnv.get(k));
check("17. process.env restored after every mutating case", envRestored);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
