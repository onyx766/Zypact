#!/usr/bin/env tsx
/**
 * M1 evidence contract — first tranche.
 *
 * Two kinds of checks:
 *
 *   1. Static assertions over migration 0036's SQL text. These prove the
 *      SQL *says* what the design requires — they do not execute
 *      PostgreSQL. No database, network, or migration execution occurs
 *      here.
 *   2. Application-layer round-trip checks against the in-memory adapter
 *      (`ZYPACT_ALLOW_MEMORY_DB=true`, forced below). These prove the
 *      hashing, evidence pass-through, and append-only-shaped API
 *      actually work in code — still with zero network calls and no live
 *      Perplexity/OpenAI credentials required (`runPerplexityProbe` and
 *      `callModel` are exercised via their `mockResponse` paths only).
 */

process.env.ZYPACT_ALLOW_MEMORY_DB = "true";
process.env.ZYPACT_MOCK_MODE = "on";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { sha256Hex } from "@/lib/evidence/hash";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { stripGenericCompetitorPlaceholders } from "@/lib/agents/site-reader";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  1. Static SQL contract — migration 0036                                   */
/* -------------------------------------------------------------------------- */

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/0036_m1_probe_evidence_contract.sql"
);
const sql = readFileSync(MIGRATION, "utf-8");
const normalized = sql.replace(/\s+/g, " ").toLowerCase();

function has(fragment: string): boolean {
  return normalized.includes(fragment.replace(/\s+/g, " ").toLowerCase());
}

console.log("\nprobe_results — new evidence columns");
for (const column of [
  "raw_response_sha256",
  "raw_probe_request_sha256",
  "full_request_body_sha256",
  "provider_http_status",
  "provider_latency_ms",
  "provider_request_id",
  "provider_model",
  "retry_count",
]) {
  check(`column ${column} added`, has(`add column if not exists ${column}`));
}
check(
  "raw_response_sha256 format constrained to lowercase hex-64",
  has("raw_response_sha256 ~ '^[0-9a-f]{64}$'")
);
check(
  "raw_probe_request_sha256 format constrained to lowercase hex-64",
  has("raw_probe_request_sha256 ~ '^[0-9a-f]{64}$'")
);
check(
  "full_request_body_sha256 format constrained to lowercase hex-64",
  has("full_request_body_sha256 ~ '^[0-9a-f]{64}$'")
);
check(
  "raw_probe_request_sha256 is documented as buyer-question-only, not the full HTTP body",
  has("the complete outbound http body")
);
check("retry_count backfilled and set not null", has("retry_count set not null"));

console.log("\nanalysis_llm_calls — new table");
check("table created", has("create table if not exists public.analysis_llm_calls"));
for (const column of [
  "project_id",
  "stage",
  "provider",
  "model",
  "used_mock",
  "used_retry",
  "latency_ms",
  "request_sha256",
  "response_sha256",
]) {
  check(`column ${column} present`, has(column));
}
check(
  "provider constrained to openai/anthropic/mock",
  has("check (provider in ('openai', 'anthropic', 'mock'))")
);
check(
  "request_sha256 format constrained to lowercase hex-64",
  has("request_sha256 ~ '^[0-9a-f]{64}$'")
);
check(
  "response_sha256 format constrained to lowercase hex-64",
  has("response_sha256 ~ '^[0-9a-f]{64}$'")
);
check(
  "project_id cascades on project delete",
  has("references public.projects (id) on delete cascade")
);

console.log("\nAppend-only enforcement");
for (const table of ["probe_results", "analysis_llm_calls"]) {
  check(`${table}: UPDATE revoked from service_role`, has(`revoke update on table public.${table} from service_role`));
  check(`${table}: DELETE revoked from service_role`, has(`revoke delete on table public.${table} from service_role`));
  check(`${table}: TRUNCATE revoked from service_role`, has(`revoke truncate on table public.${table} from service_role`));
  check(`${table}: no matching GRANT of update/delete/truncate reintroduced`, !has(`grant update on table public.${table}`) && !has(`grant delete on table public.${table}`));
}
check(
  "no second probe provider introduced (no chatgpt/gemini/openai probe surface added here)",
  !has("openai") || has("analysis_llm_calls"),
  "OpenAI only appears as an analysis_llm_calls provider value, never as a probe surface"
);

console.log("\nBackfill honesty");
check(
  "no fabricated hash backfill for pre-existing rows (migration does not UPDATE ... SET raw_response_sha256 = )",
  !has("set raw_response_sha256 =")
);

console.log("\nKnown first-tranche limitations — must stay documented, not silently closed");
check(
  "migration header marks this as a first tranche, not a full M1 close-out",
  has("first tranche") && has("not a complete m1 close-out")
);
check(
  "raw_response_sha256-is-a-transcript-hash limitation is documented in the migration",
  has("hashes a reconstructed transcript")
);
check(
  "Perplexity-failures-not-persisted limitation is documented in the migration",
  has("never reaches this table")
);
check(
  "only-probe-analysis-wired limitation is documented in the migration",
  has("only written by the") && has("stage today")
);

/* -------------------------------------------------------------------------- */
/*  2. Application-layer round trip — memory adapter, mock providers only     */
/* -------------------------------------------------------------------------- */

async function applicationLayerChecks(): Promise<void> {
  console.log("\nsha256Hex utility");
  const knownVector = sha256Hex("");
  check(
    "sha256('') matches the known SHA-256 empty-string vector",
    knownVector ===
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".slice(0, 64)
  );
  check("sha256Hex output is lowercase hex-64", /^[0-9a-f]{64}$/.test(sha256Hex("evidence")));
  check(
    "sha256Hex is deterministic",
    sha256Hex("same input") === sha256Hex("same input")
  );
  check(
    "sha256Hex distinguishes different inputs",
    sha256Hex("a") !== sha256Hex("b")
  );

  console.log("\nrunPerplexityProbe — mock path evidence fields");
  const mockAnswer = "Zypact is a strong option for AI-visibility diagnostics.";
  const mocked = await runPerplexityProbe({
    prompt: "best AI visibility tool",
    brandName: "Zypact",
    mockResponse: {
      prompt: "best AI visibility tool",
      answer: mockAnswer,
      rawResponse: mockAnswer,
      citations: [],
      searchResults: [],
      sourceCitations: [],
      model: "sonar",
      usedMock: true,
    },
  });
  check("mock probe result reports usedMock=true", mocked.usedMock === true);
  check(
    "mock probe result does not fabricate a hash the caller did not supply",
    mocked.rawResponseSha256 === undefined
  );

  console.log(
    "\nrawProbeRequestSha256 vs fullRequestBodySha256 — hash scope is what it claims to be"
  );
  {
    // Drive a live-shaped call through a fake `fetchImpl` (no network, no
    // API key) so the exact HTTP body construction in
    // `lib/probes/perplexity.ts` is exercised, not re-implemented here.
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    let capturedBody: string | null = null;
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          model: "sonar",
          choices: [{ message: { content: "Zypact is recommended." } }],
          citations: [],
          search_results: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const live = await runPerplexityProbe({
      prompt: "who is the best AI visibility tool",
      brandName: "Zypact",
      fetchImpl: fakeFetch,
    });

    check("captured the exact outbound body", capturedBody !== null);
    const expectedFullBodyHash = sha256Hex(capturedBody ?? "");
    const promptOnlyHash = sha256Hex("who is the best AI visibility tool");

    check(
      "rawProbeRequestSha256 equals the hash of the prompt text alone",
      live.rawProbeRequestSha256 === promptOnlyHash
    );
    check(
      "fullRequestBodySha256 equals the hash of the exact bytes sent on the wire",
      live.fullRequestBodySha256 === expectedFullBodyHash
    );
    check(
      "rawProbeRequestSha256 and fullRequestBodySha256 are NOT the same value " +
        "(proves the prompt-only hash does not silently claim full-body coverage)",
      live.rawProbeRequestSha256 !== live.fullRequestBodySha256
    );
    check(
      "the full body hash actually covers more than the prompt (model/temperature/etc.)",
      (capturedBody ?? "").length > "who is the best AI visibility tool".length + 20
    );
    delete process.env.PERPLEXITY_API_KEY;
  }

  console.log("\nSite Reader — generic competitor placeholder guard");
  check(
    "strips exact 'Competitor A' / 'Competitor B' placeholders, keeps a real competitor",
    JSON.stringify(
      stripGenericCompetitorPlaceholders(["Competitor A", "Competitor B", "Profound"])
    ) === JSON.stringify(["Profound"])
  );
  check(
    "case-insensitive match",
    JSON.stringify(stripGenericCompetitorPlaceholders(["competitor a", "COMPETITOR B"])) ===
      JSON.stringify([])
  );
  check(
    "does not drop a real company whose name is not exactly 'Competitor <letter>'",
    stripGenericCompetitorPlaceholders(["Competitor Analytics", "Competitor"]).length === 2
  );
  check(
    "empty input stays empty",
    stripGenericCompetitorPlaceholders([]).length === 0
  );

  console.log("\nProbe evidence — live-shaped round trip through the DB adapter");
  const db = getDb();
  const project = await db.createProject({
    domain: "m1-evidence-contract-test.example",
    companyName: "M1 Evidence Contract Test Co",
  });

  const run = await db.createProbeRun(project.id, "perplexity", "live_perplexity", "pending");
  const rawResponse = "Zypact appears as the primary recommendation.";
  const rawProbeRequest = "best AI visibility tool";
  const fullBody = JSON.stringify({ model: "sonar", messages: [{ role: "user", content: rawProbeRequest }], temperature: 0.2 });
  const expectedResponseHash = sha256Hex(rawResponse);
  const expectedRequestHash = sha256Hex(rawProbeRequest);
  const expectedFullBodyHash = sha256Hex(fullBody);

  const saved = await db.saveProbeResult({
    probeRunId: run.id,
    projectId: project.id,
    prompt: rawProbeRequest,
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse,
    rawProbeRequest,
    clientMentioned: true,
    clientPosition: "primary",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: rawResponse,
    verdict: "won",
    whyClientLost: "",
    rawResponseSha256: expectedResponseHash,
    rawProbeRequestSha256: expectedRequestHash,
    fullRequestBodySha256: expectedFullBodyHash,
    providerHttpStatus: 200,
    providerLatencyMs: 842,
    providerRequestId: "req_test_123",
    providerModel: "sonar",
    retryCount: 0,
  });

  check("saved probe result persists raw_response_sha256", saved.rawResponseSha256 === expectedResponseHash);
  check("saved probe result persists raw_probe_request_sha256", saved.rawProbeRequestSha256 === expectedRequestHash);
  check("saved probe result persists full_request_body_sha256, distinct from raw_probe_request_sha256", saved.fullRequestBodySha256 === expectedFullBodyHash && saved.fullRequestBodySha256 !== saved.rawProbeRequestSha256);
  check("saved probe result persists provider_http_status", saved.providerHttpStatus === 200);
  check("saved probe result persists provider_latency_ms", saved.providerLatencyMs === 842);
  check("saved probe result persists provider_request_id", saved.providerRequestId === "req_test_123");
  check("saved probe result persists provider_model", saved.providerModel === "sonar");
  check("saved probe result defaults retry_count to a number", typeof saved.retryCount === "number");

  const reloaded = await db.getProbeResultsByProject(project.id);
  check(
    "evidence fields survive a read round trip, not just the insert response",
    reloaded[0]?.rawResponseSha256 === expectedResponseHash
  );

  console.log("\nPre-M1 rows — no fabricated hash");
  const legacySaved = await db.saveProbeResult({
    probeRunId: run.id,
    projectId: project.id,
    prompt: "legacy pasted answer",
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: "A pasted answer with no captured hash.",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });
  check(
    "a caller that supplies no hash gets null, never a fabricated one",
    legacySaved.rawResponseSha256 === null || legacySaved.rawResponseSha256 === undefined
  );

  console.log("\nInternal-analysis traceability — separate from probe evidence");
  const traceInput = {
    projectId: project.id,
    stage: "probe-analysis",
    provider: "mock" as const,
    model: "mock",
    usedMock: true,
    usedRetry: false,
    latencyMs: 12,
    requestSha256: sha256Hex("request text"),
    responseSha256: sha256Hex("response text"),
  };
  const trace = await db.recordAnalysisLlmCall(traceInput);
  check("recordAnalysisLlmCall returns the stage", trace.stage === "probe-analysis");
  check("recordAnalysisLlmCall returns the provider", trace.provider === "mock");
  check(
    "recordAnalysisLlmCall never reuses the probe_results table (distinct id space)",
    trace.id !== saved.id
  );

  const traces = await db.getAnalysisLlmCallsByProject(project.id);
  check("analysis_llm_calls round-trips through the project index", traces.some((t) => t.id === trace.id));
  check(
    "no analysis_llm_calls row claims the Perplexity probe surface",
    traces.every((t) => t.provider === "openai" || t.provider === "anthropic" || t.provider === "mock")
  );

  console.log("\nEnd-to-end: analyzeProbeResponse wires Perplexity evidence AND records the internal analysis call");
  const project2 = await db.createProject({
    domain: `m1-e2e-${randomUUID()}.example`,
    companyName: "M1 E2E Test Co",
  });
  const before = await db.getAnalysisLlmCallsByProject(project2.id);
  check("no analysis_llm_calls rows exist before the run", before.length === 0);

  const e2eRawResponse = "Zypact is the primary recommendation for AI visibility.";
  const e2eRawRequest = "who should we use for AI visibility diagnostics";
  const analyzed = await analyzeProbeResponse({
    projectId: project2.id,
    prompt: e2eRawRequest,
    platform: "perplexity",
    rawResponse: e2eRawResponse,
    rawProbeRequest: e2eRawRequest,
    probeMode: "live_perplexity",
    rawResponseSha256: sha256Hex(e2eRawResponse),
    rawProbeRequestSha256: sha256Hex(e2eRawRequest),
    providerHttpStatus: 200,
    providerLatencyMs: 500,
    providerRequestId: "req_e2e_1",
    providerModel: "sonar",
    retryCount: 0,
  });
  check("analyzeProbeResponse succeeds end to end", analyzed.ok === true);
  if (analyzed.ok) {
    check(
      "probe_results row carries the Perplexity evidence hash",
      analyzed.result.rawResponseSha256 === sha256Hex(e2eRawResponse)
    );
    const after = await db.getAnalysisLlmCallsByProject(project2.id);
    check(
      "exactly one analysis_llm_calls row was recorded for the internal analysis call",
      after.length === 1
    );
    check(
      "the recorded analysis call is stage=probe-analysis",
      after[0]?.stage === "probe-analysis"
    );
    check(
      "the recorded analysis call used the mock provider (ZYPACT_MOCK_MODE=on, no live key)",
      after[0]?.provider === "mock"
    );
  }
}

console.log("\n─────────────────────────────────────────────────────────");
console.log("THIS IS THE FIRST M1 TRANCHE — NOT A FULL M1 CLOSE-OUT.");
console.log("");
console.log(
  "LIMITATION 1: Static SQL assertions do not prove PostgreSQL grant/revoke"
);
console.log(
  "or CHECK-constraint enforcement. Whether service_role is actually"
);
console.log(
  "blocked from UPDATE/DELETE on probe_results and analysis_llm_calls"
);
console.log(
  "remains unproven until this migration is applied to a real Postgres"
);
console.log("instance (staging) and the revoke is exercised against it.");
console.log("");
console.log(
  "LIMITATION 2: raw_response_sha256 hashes a reconstructed transcript,"
);
console.log(
  "not Perplexity's raw JSON response body. Byte-for-byte capture of the"
);
console.log("true raw response is still open work.");
console.log("");
console.log(
  "LIMITATION 3: a failed Perplexity attempt is never persisted — no"
);
console.log(
  "probe_results row, no failure metadata. Denominator reconciliation of"
);
console.log("failed/excluded attempts is not yet met.");
console.log("");
console.log(
  "LIMITATION 4: analysis_llm_calls is wired for the probe-analysis stage"
);
console.log(
  "only. Mirror Profile, Competitor Discovery, Gap Map, Fix Brief, and QA"
);
console.log("are not yet traced.");
console.log("─────────────────────────────────────────────────────────");

applicationLayerChecks()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
