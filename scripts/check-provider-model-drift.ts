#!/usr/bin/env tsx
/**
 * Read-only: did the provider model change between baseline and retest?
 *
 * Reads `probe_results.provider_model` — the model Perplexity REPORTED back,
 * not the one declared on the protocol — for both phases. Prints model
 * strings, counts and ids only. Never prints answers, citations, company
 * names, emails or raw evidence. No writes.
 */
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: ".env.local" });
loadEnvFile();

import { createClient } from "@supabase/supabase-js";

const BASELINE = "2870a72c-871c-4aa3-b1ea-e4ee0caecbcd";
const RETEST = "79e21c3d-a76c-4caa-8565-137405a6e021";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase URL / service role key not found in env.");
const db = createClient(url, key, { auth: { persistSession: false } });

async function phase(label: string, protocolId: string) {
  const { data: attempts, error: aErr } = await db
    .from("protocol_attempts")
    .select("id,attempt_kind,status,baseline_ordinal,probe_run_id,retry_of_attempt_id,termination_reason")
    .eq("protocol_id", protocolId)
    .order("baseline_ordinal", { ascending: true });
  if (aErr) throw aErr;

  if (!attempts || attempts.length === 0) {
    console.log(`\n${label} (${protocolId.slice(0, 8)}): NO ATTEMPT ROWS FOUND`);
    return [] as string[];
  }

  const runIds = attempts.map((a: any) => a.probe_run_id).filter(Boolean);
  const { data: results, error: rErr } = await db
    .from("probe_results")
    .select("probe_run_id,provider_model,provider_latency_ms,raw_response_sha256")
    .in("probe_run_id", runIds);
  if (rErr) throw rErr;

  const byRun = new Map((results ?? []).map((r: any) => [r.probe_run_id, r]));
  console.log(`\n${label}  protocol ${protocolId.slice(0, 8)}  —  ${attempts.length} attempt row(s)`);
  console.log("  ord  kind      status      provider_model          latency  hash");
  const models: string[] = [];
  for (const a of attempts as any[]) {
    const r: any = byRun.get(a.probe_run_id);
    const model = r?.provider_model ?? "(none)";
    if (a.status === "completed" && r?.provider_model) models.push(r.provider_model);
    console.log(
      `  ${String(a.baseline_ordinal ?? "-").padEnd(4)} ${String(a.attempt_kind).padEnd(9)} ` +
        `${String(a.status).padEnd(11)} ${String(model).padEnd(23)} ` +
        `${String(r?.provider_latency_ms ?? "-").padEnd(8)} ${r?.raw_response_sha256 ? "yes" : "NO"}` +
        `${a.retry_of_attempt_id ? "  (retry)" : ""}` +
        `${a.termination_reason ? `  [${a.termination_reason}]` : ""}`
    );
  }
  return models;
}

(async () => {
  const baseModels = await phase("BASELINE", BASELINE);
  const retestModels = await phase("RETEST  ", RETEST);

  const bSet = [...new Set(baseModels)].sort();
  const rSet = [...new Set(retestModels)].sort();
  console.log("\n" + "=".repeat(62));
  console.log(`baseline distinct provider_model: ${bSet.length ? bSet.join(", ") : "(none recorded)"}`);
  console.log(`retest   distinct provider_model: ${rSet.length ? rSet.join(", ") : "(none recorded)"}`);
  const within = bSet.length <= 1 && rSet.length <= 1;
  const across = bSet.length === 1 && rSet.length === 1 && bSet[0] === rSet[0];
  console.log(`\nstable within each phase: ${within ? "YES" : "NO — a phase used more than one model"}`);
  console.log(`identical across phases : ${across ? "YES — no model drift" : "NO / undetermined"}`);
  console.log("=".repeat(62));
})().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
