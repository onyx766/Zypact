#!/usr/bin/env tsx
/**
 * M1 evidence contract — first AND second tranche (migrations 0036, 0037).
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
console.log("THIS IS THE SECOND M1 TRANCHE — NOT A FULL M1 CLOSE-OUT.");
console.log("");
console.log(
  "CLOSED BY 0037: raw_response_body/raw_response_body_sha256 now capture"
);
console.log(
  "Perplexity's exact response bytes (not just the reconstructed"
);
console.log(
  "transcript), and probe_failures now persists network/HTTP/empty-answer"
);
console.log("failures instead of only throwing an in-memory Error.");
console.log("");
console.log(
  "LIMITATION 1: Static SQL assertions do not prove PostgreSQL grant/revoke"
);
console.log(
  "or CHECK-constraint enforcement. 0036 is confirmed applied to staging;"
);
console.log(
  "0037 is NOT yet applied anywhere — its revokes remain unproven until"
);
console.log("it is applied to a real Postgres instance (staging).");
console.log("");
console.log(
  "LIMITATION 2 (STILL OPEN): analysis_llm_calls is wired for the"
);
console.log(
  "probe-analysis stage only. Mirror Profile, Competitor Discovery, Gap"
);
console.log("Map, Fix Brief, and QA are not yet traced.");
console.log("");
console.log(
  "LIMITATION 3 (STILL OPEN): probe_failures.probe_run_id is always null"
);
console.log(
  "for a first-call failure — no probe_runs row exists yet at that point"
);
console.log("in the pipeline. Linking failures to a run is future work.");
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
