import { handleStepUp } from "@/lib/accounts/handlers";
import { SESSION_COOKIE, accountPost, currentAccount, readCookie } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = accountPost(async (deps, body) =>
  handleStepUp(deps, await currentAccount(deps), await readCookie(SESSION_COOKIE), body)
);
