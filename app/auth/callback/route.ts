import {
  NextResponse,
  type NextRequest,
} from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "@/lib/auth/access-allowlist";
import {
  FOUNDER_ADMIN_PATH,
  safeNextPath,
} from "@/lib/auth/safe-next-path";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(
    url.searchParams.get("next"),
    FOUNDER_ADMIN_PATH
  );
  const errorParam =
    url.searchParams.get("error_description");

  if (errorParam) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          "Sign-in link expired or invalid."
        )}`,
        url.origin
      )
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          "Missing sign-in code."
        )}`,
        url.origin
      )
    );
  }

  const supabase = await getSupabaseServerClient();

  const { error } =
    await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          "Sign-in failed."
        )}`,
        url.origin
      )
    );
  }

  // A valid link proves the address, not an invitation. An uninvited
  // account is signed straight back out, so it never holds a session.
  const { data: signedIn } = await supabase.auth.getUser();
  if (!isEmailAllowed(signedIn.user?.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(
          "This account has not been invited."
        )}`,
        url.origin
      )
    );
  }

  return NextResponse.redirect(
    new URL(next, url.origin)
  );
}
