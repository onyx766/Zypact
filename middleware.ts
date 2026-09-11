/**
 * Legacy-URL answers, indexing headers, and Supabase session refresh.
 *
 * Three jobs, in this order, and the order matters:
 *
 *   1. URLs from the previous Zypact site are answered here — a 301 to a
 *      genuine successor, or a 410 for a page nothing replaced. This runs
 *      before anything else so a dead URL never builds an auth client, and
 *      never reaches a route that would answer 404 instead. A 404 keeps a
 *      removed page in Google's index for months; a 410 states the removal
 *      was deliberate. See lib/seo/legacy-routes.ts for the map.
 *   2. Pages that must stay reachable but out of search results get
 *      `X-Robots-Tag: noindex, nofollow`. This is a header rather than a
 *      robots.txt rule on purpose: a disallowed URL is never crawled, and a
 *      noindex Google never reads is a noindex Google never obeys.
 *   3. The pre-existing Supabase-SSR session refresh, unchanged.
 *
 * It does NOT protect routes — per Sprint 10.5, gating is enforced by
 * `requireCurrentUser` / `requireProjectOwner` inside individual handlers,
 * and by RLS + server-only DB access at the data layer.
 *
 * The matcher deliberately excludes Next.js static assets and any public
 * files so we don't spin up an auth client for every image byte. It does
 * cover `/api`, because a route handler reads the same session cookies a
 * page does and must see the same refresh.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import {
  isLegacyGone,
  isNoindexPath,
  legacyRedirectTarget,
} from "@/lib/seo/legacy-routes";

const NOINDEX_HEADER = "noindex, nofollow";

/**
 * Body for a 410. Deliberately plain text: the page is gone, there is
 * nothing to render, and a crawler only needs the status code.
 */
const GONE_BODY =
  "410 Gone. This page was part of a previous version of the Zypact site and has no replacement.";

function applyIndexingHeaders(
  response: NextResponse,
  pathname: string
): NextResponse {
  if (isNoindexPath(pathname)) {
    response.headers.set("X-Robots-Tag", NOINDEX_HEADER);
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Legacy URLs, answered before any other work.
  const redirectTarget = legacyRedirectTarget(pathname);
  if (redirectTarget) {
    const url = request.nextUrl.clone();
    url.pathname = redirectTarget;
    // 308 would also be permanent but forbids the method from changing;
    // 301 is what search engines have always been given for a moved page.
    return NextResponse.redirect(url, 301);
  }

  if (isLegacyGone(pathname)) {
    return new NextResponse(GONE_BODY, {
      status: 410,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": NOINDEX_HEADER,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Auth not configured yet in this environment; skip refresh.
    return applyIndexingHeaders(response, pathname);
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

  // Applied last: `setAll` above rebuilds `response`, so a header set before
  // the refresh would be discarded with the response it was written to.
  return applyIndexingHeaders(response, pathname);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
