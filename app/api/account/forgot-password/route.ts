import { handleForgotPassword } from "@/lib/accounts/handlers";
import { accountPost } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = accountPost((deps, body, ctx) => handleForgotPassword(deps, body, ctx));
