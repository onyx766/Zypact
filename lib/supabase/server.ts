/**
 * Server-side Supabase client bound to the current request's cookies.
 *
 * This client uses the **anon key** and represents the authenticated end
 * user (or an anonymous visitor). It is the ONLY Supabase client that
 * should ever hold a real user session. Use this for auth checks
 * (`supabase.auth.getUser()`), never for privileged DB reads/writes.
 *
 * Privileged DB reads/writes still go through the existing service-role
 * `DbAdapter` in `lib/db/supabase-adapter.ts`. This split keeps two
 * invariants:
 *
 *  - The service-role key never touches a browser or cookie.
 *  - The auth surface never bypasses RLS with a service-role bearer.
 *
 * See Sprint 10.5 for the ownership model and RLS hardening.
 */

import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test-only injection point. When set, `getSupabaseServerClient()`
 * returns this instead of a real SSR client. Production code never
 * touches this; only `scripts/test-auth-ownership.ts` uses it.
 */
let __testOverride: SupabaseClient | null = null;
export function __setSupabaseServerClientForTests(
  client: SupabaseClient | null
): void {
  __testOverride = client;
}

export function getSupabaseServerClient(): SupabaseClient {
  if (__testOverride) return __testOverride;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "supabase/server: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required."
    );
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Called from a Server Component; cookies are read-only there.
          // Middleware performs the actual refresh write.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // Same as above.
        }
      },
    },
  });
}
