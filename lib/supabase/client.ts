"use client";

/**
 * Browser-side Supabase client for the auth surface only.
 *
 * Used by the minimal `/login` and `/logout` UI. Anything that touches
 * DB tables should go through server routes; direct client-side reads
 * from MVP tables are blocked by Sprint 10.5 hardening (RLS on + no
 * grants to `anon`/`authenticated`).
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "supabase/client: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required."
    );
  }
  cached = createBrowserClient(url, anonKey);
  return cached;
}
