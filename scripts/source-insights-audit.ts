#!/usr/bin/env tsx
/**
 * Read-only: how does the source extraction behave on stored protocol-worker
 * evidence? Note that the Supabase project named "zypact-staging" is
 * the production database (D-041). Run before any report with a source section is
 * delivered.
 *
 *   npm run source-insights:audit            # up to 200 most recent rows
 *   npm run source-insights:audit -- 500
 *
 * Prints counts only: statuses, response formats, how many answers carried
 * numbered references, unmatched references, and cited/retrieved totals.
 * Never prints URLs, domains, answers, company names or ids. No writes.
 */
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: ".env.local" });
loadEnvFile();

import { createClient } from "@supabase/supabase-js";

import { extractProviderSources } from "@/lib/source-insights/extract-provider-sources";

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(process.argv[2]) || 200, 1), 2000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase URL / service role key not found in env.");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("probe_results")
    .select("raw_response,raw_response_sha256")
    .eq("dataset_source_type", "protocol_execution_job")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`read failed: ${error.code ?? "unknown"}`);

  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const statuses = new Map<string, number>();
  const formats = new Map<string, number>();
  let withMarkers = 0;
  let withoutMarkersButSources = 0;
  let unmatched = 0;
  let cited = 0;
  let retrievedOnly = 0;

  for (const row of (data ?? []) as Array<{ raw_response: unknown; raw_response_sha256: unknown }>) {
    const r = extractProviderSources(
      typeof row.raw_response === "string" ? row.raw_response : null,
      typeof row.raw_response_sha256 === "string" ? row.raw_response_sha256 : null
    );
    count(statuses, r.status);
    if (r.status !== "ok") continue;
    count(formats, r.responseFormat ?? "none");
    if (r.markersFound) withMarkers += 1;
    else if (r.retrievedOnly.length > 0) withoutMarkersButSources += 1;
    unmatched += r.unmatchedMarkers.length;
    cited += r.cited.length;
    retrievedOnly += r.retrievedOnly.length;
  }

  console.log(`rows read: ${(data ?? []).length}`);
  console.log(`statuses: ${JSON.stringify(Object.fromEntries(statuses))}`);
  console.log(`formats (ok rows): ${JSON.stringify(Object.fromEntries(formats))}`);
  console.log(`answers with numbered references: ${withMarkers}`);
  console.log(`answers with sources but no references: ${withoutMarkersButSources}`);
  console.log(`unmatched references: ${unmatched}`);
  console.log(`cited sources: ${cited}; retrieved-only sources: ${retrievedOnly}`);
}

main().catch((error) => {
  console.error(`source-insights:audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
