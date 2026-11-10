/**
 * Server-only: adapts the P1 workspace handlers to Next.js.
 */
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";
import type { AccountContext } from "@/lib/accounts/handlers";
import { SESSION_COOKIE, accountDeps, currentAccount, readCookie, readJsonBody } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/rate-limit";
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import type { WorkspaceDeps, WorkspaceResult } from "@/lib/workspace/handlers";
import { supabaseWorkspaceStore, type WorkspaceState } from "@/lib/workspace/store";

export const DIAGNOSTIC_ENABLED_ENV = "ZYPACT_WORKSPACE_DIAGNOSTIC_ENABLED";

export function workspaceDeps(): WorkspaceDeps {
  const accounts = readAccountsConfig();
  return {
    config: {
      enabled: accounts.enabled,
      diagnosticEnabled: process.env[DIAGNOSTIC_ENABLED_ENV] === "true",
      hmacSecret: accounts.hmacSecret,
      hmacKeyId: accounts.hmacKeyId,
    },
    store: supabaseWorkspaceStore(),
    runDiagnostic: (startUrl) => runSiteDiagnostic(startUrl),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** A POST route: accounts kill switch, then the body, then the signed-in account. */
export function workspacePost(
  run: (deps: WorkspaceDeps, account: AccountContext | null, token: string | null, body: Record<string, unknown>, ctx: { ip: string }) => Promise<WorkspaceResult>
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const deps = workspaceDeps();
    if (!deps.config.enabled) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const account = await currentAccount(accountDeps());
    const token = await readCookie(SESSION_COOKIE);
    const result = await run(deps, account, token, parsed.body, { ip: clientIp(request.headers) });
    return NextResponse.json(result.body, { status: result.status });
  };
}

export interface WorkspacePageContext {
  account: AccountContext;
  token: string;
  state: WorkspaceState;
  deps: WorkspaceDeps;
}

/** For workspace pages: the signed-in account and its workspace, or a redirect to sign-in. */
export async function loadWorkspacePage(): Promise<WorkspacePageContext> {
  const deps = workspaceDeps();
  const account = await currentAccount(accountDeps());
  const token = await readCookie(SESSION_COOKIE);
  if (!account || !token) redirect("/account/sign-in");
  const state = await deps.store.getState(token, account.accountId);
  if (state.status !== "OK") redirect("/account/sign-in");
  return { account, token, state, deps };
}
