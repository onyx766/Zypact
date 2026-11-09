import { handleSignIn } from "@/lib/accounts/handlers";
import { accountPost } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = accountPost((deps, body, ctx) => handleSignIn(deps, body, ctx));
