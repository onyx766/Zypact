import { memoryAdapter } from "./memory-adapter";
import type { DbAdapter } from "./types";

/**
 * Resolve the database adapter.
 *
 * Uses Supabase when both env vars are set, otherwise falls back to the
 * in-memory adapter. Sprint 1 must work either way.
 */
export function getDb(): DbAdapter {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
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
