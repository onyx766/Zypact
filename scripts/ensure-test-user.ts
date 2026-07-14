#!/usr/bin/env tsx
/**
 * Sprint 10.5 — create or reuse a Supabase Auth test user.
 *
 * Uses the Supabase Admin API (service-role) to create a user with a
 * fixed email so the pipeline test always has a real `auth.users.id`
 * to attach `projects.user_id` to. Idempotent: if the user already
 * exists, we look them up and print their id.
 *
 * Only the user id is printed to stdout so upstream scripts can capture
 * it. No secrets are printed.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=...  \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   tsx scripts/ensure-test-user.ts [email]
 */

import { createClient } from "@supabase/supabase-js";

const DEFAULT_EMAIL = "zypact-mvp-test@example.com";

async function main(): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "ensure-test-user: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
    );
    return 2;
  }

  const email = process.argv[2] ?? DEFAULT_EMAIL;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Try to create the user. If they exist, this will fail with a
  //    409-equivalent error and we then look them up.
  const createRes = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { note: "Zypact Sprint 10.5 test user" },
  });

  if (createRes.data.user) {
    process.stdout.write(createRes.data.user.id);
    console.error(`created test user (email masked): id=${createRes.data.user.id}`);
    return 0;
  }

  // 2. Look up by email via admin.listUsers (paged).
  //    Supabase's `admin.listUsers` returns up to 1000 rows per page.
  const listRes = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listRes.error) {
    console.error(`ensure-test-user: listUsers error: ${listRes.error.message}`);
    return 2;
  }
  const existing = listRes.data.users.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );
  if (existing) {
    process.stdout.write(existing.id);
    console.error(`reused existing test user (email masked): id=${existing.id}`);
    return 0;
  }

  // 3. Original create errored AND user not found in first page. Report.
  console.error(
    `ensure-test-user: could not create or locate ${email}.` +
      (createRes.error ? ` create error: ${createRes.error.message}` : "")
  );
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
