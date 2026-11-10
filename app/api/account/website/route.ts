import { handleSetWebsite } from "@/lib/workspace/handlers";
import { workspacePost } from "@/lib/workspace/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = workspacePost((deps, account, token, body) => handleSetWebsite(deps, account, token, body));
