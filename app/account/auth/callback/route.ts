import { handleAuthCallback } from "@/lib/accounts/handlers";
import { accountDeps, notEnabled, toResponse } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The link in a verification or password-reset email. GET, as email links are. */
export async function GET(request: Request) {
  const deps = accountDeps();
  if (!deps.config.enabled) return notEnabled();
  const url = new URL(request.url);
  const result = await handleAuthCallback(deps, {
    code: url.searchParams.get("code"),
    next: url.searchParams.get("next"),
  });
  return toResponse(result, url.origin);
}
