import { ACTION_BODY_MAX_BYTES, workspacePost } from "@/lib/workspace/http";
import { handleCreateAction } from "@/lib/workspace/p2-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = workspacePost((deps, account, token, body) => handleCreateAction(deps, account, token, body), { maxBodyBytes: ACTION_BODY_MAX_BYTES });
