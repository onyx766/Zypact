import { handleRunDiagnostic } from "@/lib/workspace/handlers";
import { workspacePost } from "@/lib/workspace/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Above the W1 run deadline (45 s), as the founder preview route. */
export const maxDuration = 60;

export const POST = workspacePost((deps, account, token, _body, ctx) => handleRunDiagnostic(deps, account, token, ctx));
