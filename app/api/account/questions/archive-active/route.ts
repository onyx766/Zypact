import { handleArchiveActive } from "@/lib/workspace/activation";
import { workspacePost } from "@/lib/workspace/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = workspacePost((deps, account, token, body) => handleArchiveActive(deps, account, token, body));
