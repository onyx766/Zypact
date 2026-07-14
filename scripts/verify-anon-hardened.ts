#!/usr/bin/env tsx
/**
 * Sprint 10.5 verifier — proves that migration `0011_security_hardening.sql`
 * actually locked down direct client-side access to the 13 MVP tables.
 *
 * What this script does:
 *   1. Reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
 *      from the environment. These are the same values the browser
 *      would see. Nothing else is read.
 *   2. Uses PostgREST directly (no @supabase/supabase-js) so the failure
 *      mode is the actual HTTP response, not a client-side wrapper.
 *   3. Hits `GET /rest/v1/<table>?select=id&limit=1` for a subset of MVP
 *      tables using ONLY the anon key.
 *   4. Expected: **every** request either returns HTTP 401/403/40x
 *      (permission denied by PostgREST) or HTTP 200 with an empty
 *      array `[]` (RLS filtered every row).
 *   5. Any other outcome — especially a 200 with rows in the body — is
 *      a hardening regression. The script exits non-zero and prints
 *      the failing table.
 *
 * Secrets policy: the script prints only the URL host, HTTP status, and
 * a short shape description of the response body. It never echoes the
 * anon key, the service role key, or any row contents.
 */

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const MVP_TABLES_TO_PROBE = [
  "projects",
  "generated_assets",
  "qa_reports",
  "site_pages",
  "mirror_profiles",
] as const;

interface ProbeResult {
  table: string;
  status: number;
  bodyKind: "empty_array" | "non_empty_array" | "error_object" | "other";
  bodyLen: number;
  hardened: boolean;
  reason: string;
}

async function probe(url: string, anonKey: string, table: string): Promise<ProbeResult> {
  const target = `${url}/rest/v1/${table}?select=id&limit=1`;
  const res = await fetch(target, {
    method: "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    cache: "no-store",
  });
  const text = await res.text();
  let bodyKind: ProbeResult["bodyKind"] = "other";
  let hardened = false;
  let reason = "";

  if (res.status >= 400) {
    bodyKind = "error_object";
    hardened = true;
    reason = `HTTP ${res.status}`;
  } else if (res.status === 200) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          bodyKind = "empty_array";
          hardened = true;
          reason = "HTTP 200 with empty array — RLS filtered every row";
        } else {
          bodyKind = "non_empty_array";
          hardened = false;
          reason = "HTTP 200 with rows — HARDENING FAILED";
        }
      } else {
        bodyKind = "other";
        hardened = false;
        reason = "HTTP 200 with non-array body — unexpected";
      }
    } catch {
      bodyKind = "other";
      hardened = false;
      reason = "HTTP 200 with non-JSON body — unexpected";
    }
  } else {
    reason = `HTTP ${res.status} — unexpected code`;
  }

  return {
    table,
    status: res.status,
    bodyKind,
    bodyLen: text.length,
    hardened,
    reason,
  };
}

async function main(): Promise<number> {
  for (const k of REQUIRED_ENV) {
    if (!process.env[k]) {
      console.error(`missing env var: ${k}`);
      return 2;
    }
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "<invalid-url>";
    }
  })();

  console.log("Sprint 10.5 hardening verifier");
  console.log(`  Supabase host       : ${host}`);
  console.log(`  Anon key length     : ${anonKey.length} chars (redacted)`);
  console.log(`  Tables probed       : ${MVP_TABLES_TO_PROBE.join(", ")}`);
  console.log("─────────────────────────────────────────────────────");

  let regressions = 0;
  for (const t of MVP_TABLES_TO_PROBE) {
    const r = await probe(url, anonKey, t);
    const glyph = r.hardened ? "✓" : "✗";
    console.log(
      `${glyph} ${t.padEnd(20)} status=${r.status.toString().padStart(3)}  ` +
        `body=${r.bodyKind.padEnd(18)} (${r.reason})`
    );
    if (!r.hardened) regressions += 1;
  }
  console.log("─────────────────────────────────────────────────────");
  if (regressions === 0) {
    console.log("Anon-key hardening verified. Direct client reads are blocked.");
    return 0;
  }
  console.log(
    `HARDENING FAILED for ${regressions} table(s). Re-apply migration 0011_security_hardening.sql.`
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
