/**
 * Supabase-SSR session refresh middleware.
 *
 * Runs on every request that matches `config.matcher` and refreshes the
 * Supabase session cookies via `@supabase/ssr`'s cookie adapter. It
 * does NOT protect routes — per Sprint 10.5, gating is enforced by
 * `requireCurrentUser` / `requireProjectOwner` inside individual
 * handlers, and by RLS + server-only DB access at the data layer.
 *
 * The matcher deliberately excludes Next.js static assets and any
 * public files so we don't spin up an auth client for every image byte.
 * It does cover `/api`, because a route handler reads the same session
 * cookies a page does and must see the same refresh.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Auth not configured yet in this environment; skip refresh.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      /**
       * All cookies from one refresh are written together, on purpose.
       *
       * A refresh emits several cookies at once — access token, refresh
       * token, and the numbered chunks (`...auth-token.0`, `.1`) the
       * library splits a large session into. The previous per-cookie
       * `set` rebuilt `response` on every call, so each cookie discarded
       * the ones written before it and only the last survived to the
       * browser. The session then arrived partial, the next request read
       * it as no session at all, and the caller saw an intermittent 401
       * that a retry cleared once the client refreshed again.
       *
       * `setAll` receives the whole batch, so the request is updated
       * first, the response is rebuilt exactly once, and every cookie is
       * written to that same response.
       */
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[]
      ) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set({ name, value, ...options });
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set({ name, value, ...options });
        }
      },
    },
  });

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
