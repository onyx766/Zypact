import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase magic-link redirect target.
 *
 * The email link contains `?code=<authCode>`. We exchange it for a
 * session, which sets HttpOnly cookies via the SSR client's cookie
 * adapter, then redirect to `?next=` (default `/`).
 *
 * Anything unexpected → send the user back to `/login?error=…` with a
 * short, non-leaky message. We never surface Supabase internal error
 * codes verbatim to the URL.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  const errorParam = url.searchParams.get("error_description");

  if (errorParam) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("Sign-in link expired or invalid.")}`, url.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("Missing sign-in code.")}`, url.origin)
    );
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("Sign-in failed.")}`, url.origin)
    );
  }

  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/", url.origin));
}
