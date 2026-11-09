import { handleSignOut } from "@/lib/accounts/handlers";
import { SESSION_COOKIE, accountPost, readCookie } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = accountPost(async (deps) => handleSignOut(deps, await readCookie(SESSION_COOKIE)));
