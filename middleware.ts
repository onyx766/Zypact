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
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: "", ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value: "", ...options });
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
