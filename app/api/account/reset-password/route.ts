import { handleResetPassword } from "@/lib/accounts/handlers";
import { RESET_COOKIE, accountPost, readCookie } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = accountPost(async (deps, body) => handleResetPassword(deps, body, await readCookie(RESET_COOKIE)));
