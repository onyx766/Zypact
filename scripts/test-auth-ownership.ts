#!/usr/bin/env tsx
/**
 * Sprint 10.5 auth + ownership scenario test.
 *
 * Exercises `requireProjectOwner` (route guard) end-to-end against the
 * in-memory adapter, with a stub Supabase server client so we don't hit
 * the network. Verifies all four states the sprint brief mandates:
 *
 *   1. No session                    → UnauthorizedError (→ 401)
 *   2. Session + missing project     → NotFoundError("project_not_found") (→ 404)
 *   3. Session + non-owner           → NotFoundError("ownership_denied") (→ 404)
 *   4. Session + legacy null-owner   → NotFoundError("legacy_null_owner") (→ 404)
 *   5. Session + owner               → returns { user, project }
 *
 * Also asserts `authErrorResponse` maps those errors to 401 and 404
 * (never 403), so ownership_denied is indistinguishable over the wire
 * from project_not_found.
 */

// Force the in-memory DB adapter for this scenario. `getDb()` permits the
// memory adapter under NODE_ENV=test; clearing the Supabase variables keeps
// this process isolated even when the developer or CI environment is
// configured with real credentials.
delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
// Both fixture users are invited: these scenarios test ownership, and the
// access allowlist (scripts/test-paid-execution-guards.ts) is tested apart.
process.env.ZYPACT_ALLOWED_EMAILS = "alice@example.com,bob@example.com";

import { getDb } from "@/lib/db";
import { __setSupabaseServerClientForTests } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { SupabaseClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/*  Test scaffolding                                                          */
/* -------------------------------------------------------------------------- */

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Stub the auth surface                                                     */
/* -------------------------------------------------------------------------- */

let stubbedUser: CurrentUser | null = null;

const stubClient = {
  auth: {
    async getUser() {
      if (stubbedUser === null) {
        return { data: { user: null }, error: null };
      }
      return {
        data: {
          user: { id: stubbedUser.id, email: stubbedUser.email },
        },
        error: null,
      };
    },
  },
} as unknown as SupabaseClient;

__setSupabaseServerClientForTests(stubClient);

/* -------------------------------------------------------------------------- */
/*  Scenarios                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const db = getDb();

  const {
    requireCurrentUser,
    requireProjectOwner,
    UnauthorizedError,
    NotFoundError,
  } = await import("@/lib/auth/current-user");
  const { authErrorResponse } = await import("@/lib/auth/route-helpers");

  const alice: CurrentUser = { id: "user-alice", email: "alice@example.com" };
  const bob: CurrentUser = { id: "user-bob", email: "bob@example.com" };

  const aliceProject = await db.createProject({
    domain: "acme.example.com",
    companyName: "Acme (Alice)",
    userId: alice.id,
  });
  const legacyProject = await db.createProject({
    domain: "legacy.example.com",
    companyName: "Legacy row",
    userId: null,
  });

  /* -----------------------  Case 1 — no session  ------------------------ */
  stubbedUser = null;
  let caught: unknown = null;
  try {
    await requireCurrentUser();
  } catch (e) {
    caught = e;
  }
  check(
    "no session → UnauthorizedError from requireCurrentUser",
    caught instanceof UnauthorizedError
  );
  {
    const resp = authErrorResponse(caught, { route: "test" });
    check(
      "no session → authErrorResponse → HTTP 401",
      resp !== null && resp.status === 401
    );
  }

  /* -----------------------  Case 2 — missing project  ------------------- */
  stubbedUser = alice;
  caught = null;
  try {
    await requireProjectOwner("00000000-0000-0000-0000-000000000000");
  } catch (e) {
    caught = e;
  }
  check(
    "session + unknown projectId → NotFoundError(project_not_found)",
    caught instanceof NotFoundError && caught.reason === "project_not_found"
  );
  {
    const resp = authErrorResponse(caught, { route: "test" });
    check(
      "missing project → authErrorResponse → HTTP 404",
      resp !== null && resp.status === 404
    );
  }

  /* -----------------------  Case 3 — non-owner  ------------------------- */
  stubbedUser = bob;
  caught = null;
  try {
    await requireProjectOwner(aliceProject.id);
  } catch (e) {
    caught = e;
  }
  check(
    "non-owner → NotFoundError(ownership_denied)",
    caught instanceof NotFoundError && caught.reason === "ownership_denied"
  );
  {
    const resp = authErrorResponse(caught, {
      route: "test",
      projectId: aliceProject.id,
    });
    check(
      "non-owner → authErrorResponse → HTTP 404 (NOT 403 — enumeration guard)",
      resp !== null && resp.status === 404
    );
  }

  /* -----------------------  Case 4 — legacy null owner  ----------------- */
  stubbedUser = alice; // even the "creator user" cannot use a null-owner row
  caught = null;
  try {
    await requireProjectOwner(legacyProject.id);
  } catch (e) {
    caught = e;
  }
  check(
    "legacy null-owner project → NotFoundError(legacy_null_owner)",
    caught instanceof NotFoundError && caught.reason === "legacy_null_owner"
  );
  {
    const resp = authErrorResponse(caught, {
      route: "test",
      projectId: legacyProject.id,
    });
    check(
      "legacy null-owner → authErrorResponse → HTTP 404",
      resp !== null && resp.status === 404
    );
  }

  /* -----------------------  Case 5 — real owner  ------------------------ */
  stubbedUser = alice;
  const ok = await requireProjectOwner(aliceProject.id);
  check(
    "owner → returns { user, project }",
    ok.user.id === alice.id && ok.project.id === aliceProject.id
  );

  /* -----------------------  Wire-response equivalence  ------------------ */
  // The 404-not-403 rule requires that "unknown project" and
  // "authenticated non-owner" produce byte-identical responses. Compare
  // status codes AND response bodies.
  stubbedUser = bob;
  let ownershipDenied: unknown = null;
  try {
    await requireProjectOwner(aliceProject.id);
  } catch (e) {
    ownershipDenied = e;
  }
  const respDenied = authErrorResponse(ownershipDenied, { route: "test" });

  let notFound: unknown = null;
  try {
    await requireProjectOwner("11111111-1111-1111-1111-111111111111");
  } catch (e) {
    notFound = e;
  }
  const respNotFound = authErrorResponse(notFound, { route: "test" });

  const [denyStatus, missStatus] = [respDenied?.status, respNotFound?.status];
  const [denyBody, missBody] = await Promise.all([
    respDenied?.json(),
    respNotFound?.json(),
  ]);
  check(
    "non-owner and unknown-project responses are indistinguishable",
    denyStatus === missStatus &&
      JSON.stringify(denyBody) === JSON.stringify(missBody)
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "Sprint 10.5 auth/ownership scenario PASSED."
        : "Sprint 10.5 auth/ownership scenario FAILED.")
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
