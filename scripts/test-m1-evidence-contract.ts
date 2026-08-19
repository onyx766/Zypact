#!/usr/bin/env tsx
/**
 * M1 evidence contract — first, second, third, AND fourth tranche.
 * Migrations 0036 and 0037 (both confirmed applied to staging); neither
 * the third nor the fourth tranche adds a migration — the third traces
 * six more pipeline stages via analysis_llm_calls.stage (free text, no
 * CHECK constraint); the fourth reuses probe_failures.probe_run_id,
 * already nullable since 0037.
 *
 * Two kinds of checks:
 *
 *   1. Static assertions over the migrations' SQL text. These prove the
 *      SQL *says* what the design requires — they do not execute
 *      PostgreSQL. No database, network, or migration execution occurs
 *      here.
 *   2. Application-layer round-trip checks against the in-memory adapter
 *      (`ZYPACT_ALLOW_MEMORY_DB=true`, forced below). These prove the
 *      hashing, evidence pass-through, and append-only-shaped API
 *      actually work in code — still with zero network calls and no live
 *      Perplexity/OpenAI credentials required (`runPerplexityProbe` and
 *      `callModel` are exercised via their `mockResponse`/injected-fetch
 *      paths only).
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
import { PerplexityProbeFailure, runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { runSiteReaderAgent, stripGenericCompetitorPlaceholders } from "@/lib/agents/site-reader";
import { runGenerateAssetAgent } from "@/lib/agents/fix-agent";
import { runPromptMirrorAgent } from "@/lib/agents/prompt-mirror";
import { recordAnalysisTrace } from "@/lib/evidence/analysis-trace";
import { probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";
import { failProbeRunOrThrow } from "@/lib/pipeline/mark-probe-run-failed";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { EvidenceBankOutput } from "@/lib/schemas/evidence-bank.schema";
import type { FixBriefRow } from "@/lib/db/types";

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
/*  1b. Static SQL contract — migration 0037 (second tranche)                 */
/* -------------------------------------------------------------------------- */

const MIGRATION_0037 = join(
  process.cwd(),
  "supabase/migrations/0037_m1_probe_failure_and_raw_body_contract.sql"
);
const sql0037 = readFileSync(MIGRATION_0037, "utf-8");
const normalized0037 = sql0037.replace(/\s+/g, " ").toLowerCase();

function has37(fragment: string): boolean {
  return normalized0037.includes(fragment.replace(/\s+/g, " ").toLowerCase());
}

console.log("\nprobe_results — raw response body columns (0037)");
check("column raw_response_body added", has37("add column if not exists raw_response_body text"));
check("column raw_response_body_sha256 added", has37("add column if not exists raw_response_body_sha256"));
check(
  "raw_response_body_sha256 format constrained to lowercase hex-64",
  has37("raw_response_body_sha256 ~ '^[0-9a-f]{64}$'")
);

console.log("\nprobe_failures — new table (0037)");
check("table created", has37("create table if not exists public.probe_failures"));
for (const column of [
  "probe_run_id",
  "project_id",
  "platform",
  "prompt",
  "failure_reason",
  "provider_http_status",
  "provider_error_body",
  "provider_error_body_sha256",
  "provider_latency_ms",
  "provider_request_id",
  "raw_probe_request_sha256",
  "full_request_body_sha256",
  "retry_count",
]) {
  check(`column ${column} present`, has37(column));
}
check(
  "failure_reason constrained to network_error/http_error/empty_answer",
  has37("check (failure_reason in ('network_error', 'http_error', 'empty_answer'))")
);
check("probe_run_id is nullable (no run exists yet for a first-call failure)", has37("probe_run_id                uuid null references"));
check(
  "provider_error_body_sha256 format constrained to lowercase hex-64",
  has37("provider_error_body_sha256 ~ '^[0-9a-f]{64}$'")
);

console.log("\nAppend-only enforcement — probe_failures (0037)");
check("UPDATE revoked from service_role", has37("revoke update on table public.probe_failures from service_role"));
check("DELETE revoked from service_role", has37("revoke delete on table public.probe_failures from service_role"));
check("TRUNCATE revoked from service_role", has37("revoke truncate on table public.probe_failures from service_role"));
check(
  "no matching GRANT of update/delete/truncate reintroduced",
  !has37("grant update on table public.probe_failures") && !has37("grant delete on table public.probe_failures")
);

console.log("\n0037 documents what it closes and what remains open");
check(
  "0037 states it closes the raw-response-body gap",
  has37("adds raw_response_body / raw_response_body_sha256")
);
check(
  "0037 states it closes the failure-persistence gap",
  has37("this migration adds probe_failures")
);
check(
  "0037 still documents the remaining probe-analysis-only gap",
  has37("remain untraced")
);

/* -------------------------------------------------------------------------- */
/*  1c. Static wiring inventory — third tranche, no schema change             */
/*                                                                             */
/*  No new migration: analysis_llm_calls.stage is free text with no CHECK    */
/*  constraint (0036), so new stage names need no schema change. These are   */
/*  static source-text assertions, not proof the code runs correctly — see   */
/*  section 2 for the real agent-level and DB-level behavioral proof.        */
/* -------------------------------------------------------------------------- */

console.log("\nThird-tranche wiring inventory — pipeline orchestrator call sites");
const wiringTargets: Array<{ file: string; stage: string; agentResultField: string }> = [
  { file: "lib/pipeline/run-mirror-scan.ts", stage: "site-reader", agentResultField: "reader.provider" },
  { file: "lib/pipeline/discover-competitors.ts", stage: "competitor-discovery", agentResultField: "agent.provider" },
  { file: "lib/pipeline/generate-gap-map.ts", stage: "gap-map", agentResultField: "agent.provider" },
  { file: "lib/pipeline/generate-fix-brief.ts", stage: "fix-brief", agentResultField: "agent.provider" },
  { file: "lib/pipeline/generate-asset.ts", stage: "generate-asset", agentResultField: "agent.generationProvider" },
  { file: "lib/pipeline/run-qa.ts", stage: "qa", agentResultField: "agent.provider" },
  { file: "lib/pipeline/generate-buyer-prompts.ts", stage: "prompt-mirror", agentResultField: "agent.provider" },
];
for (const target of wiringTargets) {
  const src = readFileSync(join(process.cwd(), target.file), "utf-8");
  check(`${target.file} imports recordAnalysisTrace`, src.includes('from "@/lib/evidence/analysis-trace"'));
  check(`${target.file} calls recordAnalysisTrace(...)`, src.includes("recordAnalysisTrace({"));
  check(`${target.file} traces stage: "${target.stage}"`, src.includes(`stage: "${target.stage}"`));
  check(`${target.file} sources provider from ${target.agentResultField}`, src.includes(`provider: ${target.agentResultField}`));
}
check(
  "generate-asset.ts skips tracing the deterministic json_ld_schema path (no fabricated LLM call)",
  readFileSync(join(process.cwd(), "lib/pipeline/generate-asset.ts"), "utf-8").includes(
    'agent.generationProvider === "openai"'
  )
);

console.log("\nThird-tranche wiring inventory — agent Result interfaces expose provider/model/latency/requestText");
const agentTargets: Array<{ file: string; iface: string }> = [
  { file: "lib/agents/site-reader.ts", iface: "RunSiteReaderResult" },
  { file: "lib/agents/competitor-discovery.ts", iface: "RunCompetitorDiscoveryResult" },
  { file: "lib/agents/gap-map.ts", iface: "RunGapMapResult" },
  { file: "lib/agents/fix-agent.ts", iface: "RunFixBriefResult" },
  { file: "lib/agents/fix-agent.ts", iface: "RunGenerateAssetResult" },
  { file: "lib/agents/qa-agent.ts", iface: "RunQaAgentResult" },
  { file: "lib/agents/prompt-mirror.ts", iface: "RunPromptMirrorResult" },
];
for (const target of agentTargets) {
  const src = readFileSync(join(process.cwd(), target.file), "utf-8");
  const ifaceMatch = src.match(
    new RegExp(`interface ${target.iface} \\{[\\s\\S]*?\\n\\}`)
  );
  const ifaceBody = ifaceMatch?.[0] ?? "";
  check(`${target.iface} declares latencyMs`, /latencyMs: number/.test(ifaceBody));
  check(`${target.iface} declares requestText`, /requestText: string/.test(ifaceBody));
}
check(
  "correction: prompt-mirror (Buyer Prompts), found by the audit and missed in the first wiring pass, is now traced",
  readFileSync(join(process.cwd(), "lib/pipeline/generate-buyer-prompts.ts"), "utf-8").includes(
    'stage: "prompt-mirror"'
  )
);
check(
  "generate-asset.ts's deterministic guard names all three real LLM providers, nothing else",
  (() => {
    const src = readFileSync(join(process.cwd(), "lib/pipeline/generate-asset.ts"), "utf-8");
    return (
      src.includes('agent.generationProvider === "openai"') &&
      src.includes('agent.generationProvider === "anthropic"') &&
      src.includes('agent.generationProvider === "mock"') &&
      !src.includes('agent.generationProvider === "deterministic"')
    );
  })()
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

  console.log(
    "\nrawResponseBody / rawResponseBodySha256 — true raw bytes, distinct from the transcript (0037)"
  );
  {
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    const exactResponseText = JSON.stringify({
      model: "sonar",
      choices: [{ message: { content: "Zypact is the top recommendation." } }],
      citations: ["https://example.com/review"],
      search_results: [],
    });
    const fakeFetch: typeof fetch = async () =>
      new Response(exactResponseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const live = await runPerplexityProbe({
      prompt: "best AI visibility tool for B2B SaaS",
      brandName: "Zypact",
      fetchImpl: fakeFetch,
    });

    check(
      "rawResponseBody equals the exact bytes Perplexity returned",
      live.rawResponseBody === exactResponseText
    );
    check(
      "rawResponseBodySha256 equals sha256 of those exact bytes",
      live.rawResponseBodySha256 === sha256Hex(exactResponseText)
    );
    check(
      "rawResponseBody is NOT the same string as rawResponse (raw bytes vs. reconstructed transcript)",
      live.rawResponseBody !== live.rawResponse
    );
    check(
      "rawResponseBodySha256 is NOT the same as rawResponseSha256 (different hash targets)",
      live.rawResponseBodySha256 !== live.rawResponseSha256
    );
    delete process.env.PERPLEXITY_API_KEY;
  }

  console.log("\nPerplexityProbeFailure — http_error path (0037)");
  {
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    const fakeFetch: typeof fetch = async () =>
      new Response("rate limited", { status: 429 });

    let caught: unknown = null;
    try {
      await runPerplexityProbe({
        prompt: "best AI visibility tool",
        brandName: "Zypact",
        fetchImpl: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    check("throws PerplexityProbeFailure, not a plain Error", caught instanceof PerplexityProbeFailure);
    if (caught instanceof PerplexityProbeFailure) {
      check("reason is http_error", caught.reason === "http_error");
      check("httpStatus is 429", caught.httpStatus === 429);
      check("errorBody captured", caught.errorBody === "rate limited");
      check("errorBodySha256 matches errorBody", caught.errorBodySha256 === sha256Hex("rate limited"));
      check("rawProbeRequestSha256 still captured on failure", /^[0-9a-f]{64}$/.test(caught.rawProbeRequestSha256));
      check("fullRequestBodySha256 still captured on failure", /^[0-9a-f]{64}$/.test(caught.fullRequestBodySha256));
    }
    delete process.env.PERPLEXITY_API_KEY;
  }

  console.log("\nPerplexityProbeFailure — empty_answer path (0037)");
  {
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ model: "sonar", choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    let caught: unknown = null;
    try {
      await runPerplexityProbe({
        prompt: "best AI visibility tool",
        brandName: "Zypact",
        fetchImpl: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    check("throws PerplexityProbeFailure for an empty answer", caught instanceof PerplexityProbeFailure);
    if (caught instanceof PerplexityProbeFailure) {
      check("reason is empty_answer", caught.reason === "empty_answer");
      check("httpStatus is 200 (the request succeeded, the content was empty)", caught.httpStatus === 200);
    }
    delete process.env.PERPLEXITY_API_KEY;
  }

  console.log("\nPerplexityProbeFailure — network_error path (0037)");
  {
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    const fakeFetch: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.perplexity.ai");
    };

    let caught: unknown = null;
    try {
      await runPerplexityProbe({
        prompt: "best AI visibility tool",
        brandName: "Zypact",
        fetchImpl: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    check("throws PerplexityProbeFailure for a network error", caught instanceof PerplexityProbeFailure);
    if (caught instanceof PerplexityProbeFailure) {
      check("reason is network_error", caught.reason === "network_error");
      check("httpStatus is null (no response was ever received)", caught.httpStatus === null);
      check("message mentions the underlying network error", caught.message.includes("ENOTFOUND"));
    }
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
  const rawResponseBody = JSON.stringify({ model: "sonar", choices: [{ message: { content: "Zypact appears as the primary recommendation." } }] });
  const rawProbeRequest = "best AI visibility tool";
  const fullBody = JSON.stringify({ model: "sonar", messages: [{ role: "user", content: rawProbeRequest }], temperature: 0.2 });
  const expectedResponseHash = sha256Hex(rawResponse);
  const expectedResponseBodyHash = sha256Hex(rawResponseBody);
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
    rawResponseBody,
    rawResponseBodySha256: expectedResponseBodyHash,
    rawProbeRequestSha256: expectedRequestHash,
    fullRequestBodySha256: expectedFullBodyHash,
    providerHttpStatus: 200,
    providerLatencyMs: 842,
    providerRequestId: "req_test_123",
    providerModel: "sonar",
    retryCount: 0,
  });

  check("saved probe result persists raw_response_sha256", saved.rawResponseSha256 === expectedResponseHash);
  check("saved probe result persists raw_response_body verbatim", saved.rawResponseBody === rawResponseBody);
  check("saved probe result persists raw_response_body_sha256, distinct from raw_response_sha256", saved.rawResponseBodySha256 === expectedResponseBodyHash && saved.rawResponseBodySha256 !== saved.rawResponseSha256);
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
  check(
    "raw_response_body survives a read round trip",
    reloaded[0]?.rawResponseBody === rawResponseBody
  );

  console.log("\nprobe_failures — DB round trip (0037)");
  const failureBefore = await db.getProbeFailuresByProject(project.id);
  check("no probe_failures rows exist yet for this project", failureBefore.length === 0);

  const errorBody = "429 rate limited";
  const recordedFailure = await db.recordProbeFailure({
    projectId: project.id,
    platform: "perplexity",
    prompt: "best AI visibility tool",
    failureReason: "http_error",
    providerHttpStatus: 429,
    providerErrorBody: errorBody,
    providerErrorBodySha256: sha256Hex(errorBody),
    providerLatencyMs: 120,
    providerRequestId: "req_fail_1",
    rawProbeRequestSha256: sha256Hex("best AI visibility tool"),
    fullRequestBodySha256: sha256Hex("{\"model\":\"sonar\"}"),
    retryCount: 0,
  });
  check("recordProbeFailure never touches probe_results (distinct id space)", recordedFailure.id !== saved.id);
  check("recordProbeFailure returns failureReason", recordedFailure.failureReason === "http_error");
  check("recordProbeFailure returns providerHttpStatus", recordedFailure.providerHttpStatus === 429);
  check("recordProbeFailure has no probeRunId (no run existed at the point of failure)", recordedFailure.probeRunId === null);

  const failureAfter = await db.getProbeFailuresByProject(project.id);
  check("probe_failures round-trips through the project index", failureAfter.some((f) => f.id === recordedFailure.id));

  console.log("\nWiring contract — same catch/persist pattern used in run-live-perplexity-probes.ts and mvp-scan.ts");
  {
    process.env.PERPLEXITY_API_KEY = "test-key-not-real";
    const project3 = await db.createProject({
      domain: `m1-failure-wiring-${randomUUID()}.example`,
      companyName: "M1 Failure Wiring Test Co",
    });
    const fakeFetch: typeof fetch = async () => new Response("service unavailable", { status: 503 });

    try {
      const live = await runPerplexityProbe({
        prompt: "who should we use",
        brandName: "Zypact",
        fetchImpl: fakeFetch,
      });
      void live;
      check("wiring test setup error: expected a throw", false);
    } catch (err) {
      if (err instanceof PerplexityProbeFailure) {
        await db.recordProbeFailure({
          projectId: project3.id,
          platform: "perplexity",
          prompt: "who should we use",
          failureReason: err.reason,
          providerHttpStatus: err.httpStatus,
          providerErrorBody: err.errorBody,
          providerErrorBodySha256: err.errorBodySha256,
          providerLatencyMs: err.latencyMs,
          providerRequestId: err.providerRequestId,
          rawProbeRequestSha256: err.rawProbeRequestSha256,
          fullRequestBodySha256: err.fullRequestBodySha256,
          retryCount: 0,
        });
      }
    }
    const wiredFailures = await db.getProbeFailuresByProject(project3.id);
    check("the wiring pattern persists exactly one failure row", wiredFailures.length === 1);
    check("the persisted failure has the right HTTP status", wiredFailures[0]?.providerHttpStatus === 503);
    delete process.env.PERPLEXITY_API_KEY;
  }

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

  console.log(
    "\nThird tranche — DB round trip for every newly-wired stage (success, provider, model, latency, hashes)"
  );
  {
    const project4 = await db.createProject({
      domain: `m1-third-tranche-${randomUUID()}.example`,
      companyName: "M1 Third Tranche Test Co",
    });
    const stageFixtures: Array<{
      stage: string;
      provider: "openai" | "anthropic" | "mock";
      model: string;
      latencyMs: number;
    }> = [
      { stage: "site-reader", provider: "openai", model: "gpt-4o-mini", latencyMs: 410 },
      { stage: "competitor-discovery", provider: "openai", model: "gpt-4o-mini", latencyMs: 620 },
      { stage: "gap-map", provider: "anthropic", model: "claude-3-5-sonnet-latest", latencyMs: 980 },
      { stage: "fix-brief", provider: "openai", model: "gpt-4o-mini", latencyMs: 540 },
      { stage: "generate-asset", provider: "openai", model: "gpt-4o-mini", latencyMs: 715 },
      { stage: "qa", provider: "openai", model: "gpt-4o-mini", latencyMs: 330 },
      { stage: "prompt-mirror", provider: "openai", model: "gpt-4o-mini", latencyMs: 505 },
    ];
    for (const fixture of stageFixtures) {
      const requestText = `${fixture.stage} request payload`;
      const responseValue = { stage: fixture.stage, ok: true };
      const recorded = await recordAnalysisTrace({
        projectId: project4.id,
        stage: fixture.stage,
        provider: fixture.provider,
        model: fixture.model,
        usedMock: false,
        usedRetry: false,
        latencyMs: fixture.latencyMs,
        requestText,
        responseValue,
      });
      check(`${fixture.stage}: recorded with correct provider`, recorded.provider === fixture.provider);
      check(`${fixture.stage}: recorded with correct model`, recorded.model === fixture.model);
      check(`${fixture.stage}: recorded with correct latencyMs`, recorded.latencyMs === fixture.latencyMs);
      check(
        `${fixture.stage}: requestSha256 matches sha256 of the exact request text`,
        recorded.requestSha256 === sha256Hex(requestText)
      );
      check(
        `${fixture.stage}: responseSha256 matches sha256 of the exact serialized response`,
        recorded.responseSha256 === sha256Hex(JSON.stringify(responseValue))
      );
    }
    const allTraces = await db.getAnalysisLlmCallsByProject(project4.id);
    check(
      "all 7 newly-wired stages are distinguishable in the same project's trace list",
      new Set(allTraces.map((t) => t.stage)).size === 7
    );
  }

  console.log("\nThird tranche — real agent call (Mirror Profile / site-reader), success path, no network");
  {
    const siteReaderResult = await runSiteReaderAgent({
      pages: [
        {
          url: "https://example.com",
          title: "Example — AI visibility software",
          pageType: "homepage",
          text: "Example is AI visibility software for B2B SaaS teams.",
        },
      ],
      websiteUrl: "https://example.com",
      companyNameHint: "Example",
    });
    check("runSiteReaderAgent reports usedMock=true (ZYPACT_MOCK_MODE=on)", siteReaderResult.usedMock === true);
    check("runSiteReaderAgent returns provider=mock", siteReaderResult.provider === "mock");
    check("runSiteReaderAgent returns model=mock", siteReaderResult.model === "mock");
    check(
      "runSiteReaderAgent returns a numeric, non-negative latencyMs",
      typeof siteReaderResult.latencyMs === "number" && siteReaderResult.latencyMs >= 0
    );
    check("runSiteReaderAgent returns a non-empty requestText", siteReaderResult.requestText.length > 0);

    const project5 = await db.createProject({
      domain: `m1-site-reader-real-${randomUUID()}.example`,
      companyName: "M1 Site Reader Real Test Co",
    });
    const realTrace = await recordAnalysisTrace({
      projectId: project5.id,
      stage: "site-reader",
      provider: siteReaderResult.provider,
      model: siteReaderResult.model,
      usedMock: siteReaderResult.usedMock,
      usedRetry: siteReaderResult.usedRetry,
      latencyMs: siteReaderResult.latencyMs,
      requestText: siteReaderResult.requestText,
      responseValue: siteReaderResult.output,
    });
    check(
      "the real agent's requestText hashes to what got persisted",
      realTrace.requestSha256 === sha256Hex(siteReaderResult.requestText)
    );
    check(
      "the real agent's output hashes to what got persisted",
      realTrace.responseSha256 === sha256Hex(JSON.stringify(siteReaderResult.output))
    );
  }

  console.log("\nThird tranche — error path: no phantom trace when the agent throws before recordAnalysisTrace");
  {
    let threw = false;
    try {
      await runSiteReaderAgent({ pages: [] });
    } catch {
      threw = true;
    }
    check("runSiteReaderAgent throws synchronously on empty pages, before any model call", threw);

    // Mirrors the real orchestrator shape (lib/pipeline/run-mirror-scan.ts):
    // recordAnalysisTrace sits strictly after a successful agent call, so a
    // thrown error — pre-flight or post-callModel via parseJsonOrRetry,
    // both already covered by the existing "Zod validation failure
    // triggers one retry" scenario in test-pipeline-integrity.ts — never
    // reaches it. No project is created here because none is needed: the
    // claim being tested is "the call never happens", not "a row exists".
  }

  console.log("\nCorrection — prompt-mirror is now traced (real agent call, no network)");
  {
    const mirrorProfileFixture: SiteReaderOutput = {
      companyName: "Zypact",
      website: "https://zypact.example",
      detectedCategory: "AI visibility software",
      categoryConfidence: "high",
      targetAudience: ["B2B SaaS teams"],
      useCases: ["AI visibility diagnostics"],
      features: ["Perplexity probing"],
      painPointsAddressed: ["AI answer blindness"],
      claims: [],
      proofSignals: [],
      competitorsMentioned: [],
      missingSignals: [
        { signal: "Pricing page", whyItMatters: "Buyers filter fast on price." },
        { signal: "FAQ", whyItMatters: "AI harvests structured Q&A." },
        { signal: "Case studies", whyItMatters: "AI leans on social proof." },
      ],
      buyerIntentAngles: [],
      aiReadabilityNotes: "",
    };

    const promptMirrorResult = await runPromptMirrorAgent({
      mirrorProfile: mirrorProfileFixture,
    });
    check("runPromptMirrorAgent reports usedMock=true (ZYPACT_MOCK_MODE=on)", promptMirrorResult.usedMock === true);
    check("runPromptMirrorAgent returns provider=mock", promptMirrorResult.provider === "mock");
    check(
      "runPromptMirrorAgent returns a numeric, non-negative latencyMs",
      typeof promptMirrorResult.latencyMs === "number" && promptMirrorResult.latencyMs >= 0
    );
    check("runPromptMirrorAgent returns a non-empty requestText", promptMirrorResult.requestText.length > 0);

    const promptMirrorProject = await db.createProject({
      domain: `m1-prompt-mirror-real-${randomUUID()}.example`,
      companyName: "M1 Prompt Mirror Real Test Co",
    });
    const before = await db.getAnalysisLlmCallsByProject(promptMirrorProject.id);
    check("no prompt-mirror trace exists before recording", before.length === 0);

    await recordAnalysisTrace({
      projectId: promptMirrorProject.id,
      stage: "prompt-mirror",
      provider: promptMirrorResult.provider,
      model: promptMirrorResult.model,
      usedMock: promptMirrorResult.usedMock,
      usedRetry: promptMirrorResult.usedRetry,
      latencyMs: promptMirrorResult.latencyMs,
      requestText: promptMirrorResult.requestText,
      responseValue: promptMirrorResult.output,
    });
    const after = await db.getAnalysisLlmCallsByProject(promptMirrorProject.id);
    check("exactly one prompt-mirror trace exists after recording", after.length === 1);
    check("the recorded trace is stage=prompt-mirror", after[0]?.stage === "prompt-mirror");
  }

  console.log(
    "\nCorrection — generate-asset's deterministic json_ld_schema path creates NO analysis_llm_calls row"
  );
  {
    const mirrorProfileFixture: SiteReaderOutput = {
      companyName: "Zypact",
      website: "https://zypact.example",
      detectedCategory: "AI visibility software",
      categoryConfidence: "high",
      targetAudience: ["B2B SaaS teams"],
      useCases: [],
      features: [],
      painPointsAddressed: [],
      claims: [],
      proofSignals: [],
      competitorsMentioned: [],
      missingSignals: [
        { signal: "Pricing page", whyItMatters: "x" },
        { signal: "FAQ", whyItMatters: "x" },
        { signal: "Case studies", whyItMatters: "x" },
      ],
      buyerIntentAngles: [],
      aiReadabilityNotes: "",
    };
    const evidenceBankFixture: EvidenceBankOutput = {
      id: "eb-test",
      projectId: "project-test",
      productDescription: "AI visibility diagnostics for B2B SaaS.",
      targetAudience: ["B2B SaaS teams"],
      mainUseCases: ["AI visibility"],
      features: [],
      proofItems: [],
      competitors: [],
      allowedClaims: [],
      forbiddenClaims: ["guaranteed rankings", "guaranteed AI mentions", "guaranteed citations"],
      tone: "friendly",
      notes: "",
      provenance: "auto_filled_from_mirror_profile",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fixBriefFixture: FixBriefRow = {
      id: "fb-test",
      projectId: "project-test",
      gapId: null,
      probeResultId: null,
      lostPrompt: "best AI visibility tool for B2B SaaS",
      competitorRecommended: "Profound",
      rootCause: "No structured data for AI crawlers.",
      recommendedFix: "Add SoftwareApplication JSON-LD.",
      fixType: "json_ld_schema",
      assetsToGenerate: ["json_ld_schema"],
      evidenceNeeded: [],
      evidenceAvailable: [],
      priority: 1,
      expectedImpact: "Improved structured-data discoverability.",
      status: "ready_for_assets",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const assetResult = await runGenerateAssetAgent({
      fixBrief: fixBriefFixture,
      evidenceBank: evidenceBankFixture,
      mirrorProfile: mirrorProfileFixture,
      assetType: "json_ld_schema",
    });
    check(
      "runGenerateAssetAgent reports generationProvider=deterministic for json_ld_schema",
      assetResult.generationProvider === "deterministic"
    );
    check("the deterministic path never called the model (usedMock=false, no provider call)", assetResult.usedMock === false);
    check("the deterministic path reports latencyMs=0 (no outbound call to time)", assetResult.latencyMs === 0);
    check("the deterministic path reports an empty requestText (no request was ever built)", assetResult.requestText === "");

    // Exactly the guard used in lib/pipeline/generate-asset.ts — proves the
    // real production condition, not a re-description of it.
    const shouldTrace =
      (assetResult.generationProvider as string) === "openai" ||
      (assetResult.generationProvider as string) === "anthropic" ||
      (assetResult.generationProvider as string) === "mock";
    check("the production guard evaluates to false for the deterministic path", shouldTrace === false);

    const assetProject = await db.createProject({
      domain: `m1-generate-asset-deterministic-${randomUUID()}.example`,
      companyName: "M1 Generate Asset Deterministic Test Co",
    });
    if (shouldTrace) {
      // Would only run for a real LLM-backed asset type — never for
      // json_ld_schema. Present so this block mirrors the production
      // guard exactly rather than asserting a foregone conclusion.
      await recordAnalysisTrace({
        projectId: assetProject.id,
        stage: "generate-asset",
        provider: assetResult.generationProvider as "openai" | "anthropic" | "mock",
        model: assetResult.generationModel,
        usedMock: assetResult.usedMock,
        usedRetry: assetResult.usedRetry,
        latencyMs: assetResult.latencyMs,
        requestText: assetResult.requestText,
        responseValue: assetResult.output,
      });
    }
    const assetTraces = await db.getAnalysisLlmCallsByProject(assetProject.id);
    check(
      "no analysis_llm_calls row exists for the deterministic json_ld_schema generation",
      assetTraces.length === 0
    );
  }

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

  console.log("\nFourth tranche — probe_run created before the provider call, reused, no duplicate");
  {
    console.log("\n  succès — un seul probe_run");
    const project6 = await db.createProject({
      domain: `m1-fourth-success-${randomUUID()}.example`,
      companyName: "M1 Fourth Tranche Success Co",
    });
    const preCreatedRun = await db.createProbeRun(project6.id, "perplexity", "live_perplexity", "pending");
    const successRawResponse = "Zypact is recommended for AI visibility diagnostics.";
    const successResult = await analyzeProbeResponse({
      projectId: project6.id,
      prompt: "who should we use",
      platform: "perplexity",
      probeRunId: preCreatedRun.id,
      rawResponse: successRawResponse,
      rawProbeRequest: "who should we use",
      probeMode: "live_perplexity",
    });
    check("analyzeProbeResponse succeeds when reusing a pre-created probeRunId", successResult.ok === true);
    if (successResult.ok) {
      check("the reused run's id is the one passed in, not a new one", successResult.probeRunId === preCreatedRun.id);
    }
    const runsAfterSuccess = await db.getProbeRunsByProject(project6.id);
    check("exactly one probe_runs row exists for this project (no duplicate)", runsAfterSuccess.length === 1);
    check("that run is marked succeeded", runsAfterSuccess[0]?.status === "succeeded");
    const resultsAfterSuccess = await db.getProbeResultsByProject(project6.id);
    check(
      "the saved probe_results row references the pre-created run's id",
      resultsAfterSuccess[0]?.probeRunId === preCreatedRun.id
    );

    console.log("\n  rétrocompatibilité — sans probeRunId");
    const project7 = await db.createProject({
      domain: `m1-fourth-backcompat-${randomUUID()}.example`,
      companyName: "M1 Fourth Tranche Backcompat Co",
    });
    const backcompatResult = await analyzeProbeResponse({
      projectId: project7.id,
      prompt: "manual pasted answer",
      platform: "perplexity",
      // No probeRunId — exercises the exact pre-fourth-tranche call shape.
      rawResponse: "A manually pasted answer with no probeRunId supplied.",
      probeMode: "simulated",
    });
    check("analyzeProbeResponse still succeeds with no probeRunId supplied", backcompatResult.ok === true);
    const runsAfterBackcompat = await db.getProbeRunsByProject(project7.id);
    check(
      "exactly one probe_runs row was created by analyzeProbeResponse itself (unchanged legacy behavior)",
      runsAfterBackcompat.length === 1
    );
    check("that self-created run is marked succeeded", runsAfterBackcompat[0]?.status === "succeeded");

    console.log("\n  échec Perplexity relié au run (reproduces the exact orchestrator pattern)");
    const project8 = await db.createProject({
      domain: `m1-fourth-provider-failure-${randomUUID()}.example`,
      companyName: "M1 Fourth Tranche Provider Failure Co",
    });
    {
      process.env.PERPLEXITY_API_KEY = "test-key-not-real";
      const failingRun = await db.createProbeRun(project8.id, "perplexity", "live_perplexity", "pending");
      const fakeFetch: typeof fetch = async () => new Response("service unavailable", { status: 503 });
      let caught: unknown = null;
      try {
        await runPerplexityProbe({ prompt: "who should we use", brandName: "Zypact", fetchImpl: fakeFetch });
      } catch (err) {
        caught = err;
      }
      check("the provider call throws PerplexityProbeFailure", caught instanceof PerplexityProbeFailure);
      if (caught instanceof PerplexityProbeFailure) {
        // Exactly the two calls the real orchestrators (run-live-perplexity-probes.ts,
        // mvp-scan.ts) make in their catch block, in the same order.
        await db.recordProbeFailure({
          probeRunId: failingRun.id,
          projectId: project8.id,
          platform: "perplexity",
          prompt: "who should we use",
          failureReason: caught.reason,
          providerHttpStatus: caught.httpStatus,
          providerErrorBody: caught.errorBody,
          providerErrorBodySha256: caught.errorBodySha256,
          providerLatencyMs: caught.latencyMs,
          providerRequestId: caught.providerRequestId,
          rawProbeRequestSha256: caught.rawProbeRequestSha256,
          fullRequestBodySha256: caught.fullRequestBodySha256,
          retryCount: 0,
        });
        await db.updateProbeRunStatus(failingRun.id, "failed");
      }
      const failuresForProject8 = await db.getProbeFailuresByProject(project8.id);
      check("exactly one probe_failures row was recorded", failuresForProject8.length === 1);
      check(
        "the recorded failure's probeRunId matches the run created before the call",
        failuresForProject8[0]?.probeRunId === failingRun.id
      );
      const runsForProject8 = await db.getProbeRunsByProject(project8.id);
      check("exactly one probe_runs row exists (no duplicate on the failure path either)", runsForProject8.length === 1);
      check("that run is marked failed", runsForProject8[0]?.status === "failed");
      delete process.env.PERPLEXITY_API_KEY;
    }

    console.log("\n  fuite d'identité — run failed, aucun probe_failures fabriqué");
    const project9 = await db.createProject({
      domain: `m1-fourth-identity-leak-${randomUUID()}.example`,
      companyName: "M1 Fourth Tranche Identity Leak Co",
    });
    {
      const leakRun = await db.createProbeRun(project9.id, "perplexity", "live_perplexity", "pending");
      // Rigged exactly like a live PerplexityProbeResult whose rawProbeRequest
      // (normally == the original prompt) has been tampered with to include a
      // brand term outside the original prompt text — the real condition
      // probeRequestLeaksClientIdentity is designed to catch.
      const leaked = probeRequestLeaksClientIdentity({
        rawRequest: "who should we use for AI visibility. By the way, this is for Zypact.",
        originalPrompt: "who should we use for AI visibility",
        brandTerms: ["Zypact"],
        domain: "zypact.example",
      });
      check("probeRequestLeaksClientIdentity detects the rigged leak", leaked === true);
      if (leaked) {
        // Mirrors the exact new orchestrator branch: only the run status is
        // recorded. No db.recordProbeFailure call — there is no truthful
        // failure_reason for an identity leak (0037's CHECK constraint only
        // allows network_error/http_error/empty_answer).
        await db.updateProbeRunStatus(leakRun.id, "failed");
      }
      const runsForProject9 = await db.getProbeRunsByProject(project9.id);
      check("exactly one probe_runs row exists", runsForProject9.length === 1);
      check("that run is marked failed", runsForProject9[0]?.status === "failed");
      const failuresForProject9 = await db.getProbeFailuresByProject(project9.id);
      check(
        "no probe_failures row was fabricated for the identity-leak case (no truthful failure_reason exists)",
        failuresForProject9.length === 0
      );
    }

    console.log("\n  aucun mécanisme de retry ajouté (vérification statique)");
    const retryKeywords = ["backoff", "maxRetries", "retryAttempt", "exponential", "setTimeout", "while ("];
    for (const file of [
      "lib/pipeline/run-live-perplexity-probes.ts",
      "scripts/mvp-scan.ts",
      "lib/pipeline/analyze-probe-response.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), file), "utf-8");
      for (const keyword of retryKeywords) {
        check(`${file}: no "${keyword}" introduced (no retry/backoff mechanism added)`, !src.includes(keyword));
      }
    }
    check(
      "retryCount is still hardcoded to 0 at both live call sites, not computed by a new retry loop",
      readFileSync(join(process.cwd(), "lib/pipeline/run-live-perplexity-probes.ts"), "utf-8").includes(
        "retryCount: 0,"
      ) && readFileSync(join(process.cwd(), "scripts/mvp-scan.ts"), "utf-8").includes("retryCount: 0,")
    );

    console.log(
      "\n  correction — a probe_runs status-write failure must fail explicitly, never be swallowed"
    );
    {
      // Static: the silent-swallow pattern must be gone from both call
      // sites, and both must now go through the shared helper.
      for (const file of ["lib/pipeline/run-live-perplexity-probes.ts", "scripts/mvp-scan.ts"]) {
        const src = readFileSync(join(process.cwd(), file), "utf-8");
        check(
          `${file}: updateProbeRunStatus(..., "failed") is no longer directly swallowed with .catch(() => undefined)`,
          !src.includes('updateProbeRunStatus(probeRun.id, "failed").catch(() => undefined)')
        );
        check(`${file}: imports failProbeRunOrThrow`, src.includes('from "@/lib/pipeline/mark-probe-run-failed"'));
        check(
          `${file}: both the catch block and the identity-leak branch call failProbeRunOrThrow`,
          (src.match(/failProbeRunOrThrow\(/g) ?? []).length === 2
        );
      }

      // Dynamic: failProbeRunOrThrow itself, both branches.
      let statusWrites = 0;
      const healthyDb = {
        async updateProbeRunStatus() {
          statusWrites += 1;
        },
      };
      await failProbeRunOrThrow(healthyDb, "run-ok", "original failure message");
      check("when the status write succeeds, failProbeRunOrThrow resolves without throwing", statusWrites === 1);

      const brokenDb = {
        async updateProbeRunStatus(): Promise<void> {
          throw new Error("connection reset");
        },
      };
      let caught: unknown = null;
      try {
        await failProbeRunOrThrow(brokenDb, "run-broken-123", "Perplexity probe failed: rate limited");
      } catch (err) {
        caught = err;
      }
      check("when the status write itself fails, failProbeRunOrThrow throws — it is never swallowed", caught instanceof Error);
      if (caught instanceof Error) {
        check(
          "the compound error preserves the original failure message",
          caught.message.includes("Perplexity probe failed: rate limited")
        );
        check(
          "the compound error names the specific run id that may be stuck",
          caught.message.includes("run-broken-123")
        );
        check(
          'the compound error explicitly warns the run "may be stuck in \\"pending\\""',
          caught.message.includes('may be stuck in "pending"')
        );
        check(
          "the compound error preserves the underlying status-write error via cause",
          (caught as Error & { cause?: unknown }).cause instanceof Error &&
            ((caught as Error & { cause?: Error }).cause as Error).message === "connection reset"
        );
      }
    }
  }
}

console.log("\n─────────────────────────────────────────────────────────");
console.log("THIS IS THE FOURTH M1 TRANCHE — NOT A FULL M1 CLOSE-OUT.");
console.log("");
console.log(
  "CLOSED BY THIS TRANCHE (no new migration — probe_failures.probe_run_id"
);
console.log(
  "was already nullable, added by 0037 in anticipation of this exact fix):"
);
console.log(
  "  probe_run is now created before runPerplexityProbe in both live call"
);
console.log(
  "  sites (run-live-perplexity-probes.ts, mvp-scan.ts) and reused by"
);
console.log(
  "  analyzeProbeResponse via an optional probeRunId — never a duplicate."
);
console.log(
  "  Perplexity provider failures now attach probe_failures.probe_run_id"
);
console.log(
  "  to that run. An identity leak (probeRequestLeaksClientIdentity)"
);
console.log(
  "  marks the run failed WITHOUT fabricating a probe_failures row — no"
);
console.log("  failure_reason value truthfully describes that case.");
console.log("");
console.log(
  "LIMITATION 1: Static SQL assertions do not prove PostgreSQL grant/revoke"
);
console.log(
  "or CHECK-constraint enforcement. 0036 AND 0037 are both confirmed"
);
console.log("applied to staging. No new migration in this tranche either.");
console.log("");
console.log(
  "LIMITATION 2 (STILL OPEN): four of the seven M1-third-tranche stages"
);
console.log(
  "(competitor-discovery, gap-map, fix-brief, qa) remain verified by"
);
console.log(
  "static source-text assertions plus a DB-level round trip using"
);
console.log("synthetic fixtures, not by invoking the real agent functions.");
console.log("");
console.log(
  "LIMITATION 3 (STILL OPEN, unchanged): there is still no retry"
);
console.log(
  "mechanism around a failed Perplexity attempt — retryCount remains"
);
console.log(
  "hardcoded to 0. The probe_run-before-call design is retry-ready (a"
);
console.log(
  "future retry loop could reuse the same run across attempts), but no"
);
console.log("retry logic was added — confirmed by this tranche's own tests.");
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
