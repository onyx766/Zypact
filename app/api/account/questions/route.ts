import { workspacePost } from "@/lib/workspace/http";
import { handleAddDraft } from "@/lib/workspace/p2-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = workspacePost((deps, account, token, body) => handleAddDraft(deps, account, token, body));
