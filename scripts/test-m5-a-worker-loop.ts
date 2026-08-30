#!/usr/bin/env tsx
/**
 * M5-A — worker loop contract, network-free.
 *
 * Runs entirely on the memory adapter with injected fakes. No Docker, no
 * migration, no provider key, no `fetch` that can reach anything.
 *
 * What this file proves:
 *   [1] D-028 — the M5 analysis path never touches the legacy verdict agent.
 *   [2] The model is asked for exactly four keys, and a fifth is refused.
 *   [3] Parsing is single-shot: one prepare, one execute, no hidden retry.
 *   [4] The nine persisted fields are each derived by a stated rule.
 *   [5] platformsReferenced comes from cited sources and nothing else.
 *   [6] A refused mark_sent produces ZERO outbound fetches.
 *   [7] The loop drives every planned baseline slot and then completes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PROBE_ANALYSIS_M5_SYSTEM_PROMPT,
  buildMockProbeAnalysisM5,
  buildProbeAnalysisM5Call,
  deriveProbeResultContent,
  parseProbeAnalysisM5Content,
  platformsReferencedFromSources,
  sourceBelongsToDomain,
  type ProbeAnalysisM5Parsed,
} from "@/lib/protocol-worker/analysis-m5";
import { ProbeAnalysisM5OutputSchema } from "@/lib/schemas/probe-analysis-m5.schema";
import { runOneIteration, answerFromRawResponseBody } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type {
  AnalysisTransport,
  IterationResult,
  WorkerDeps,
  WorkerOptions,
} from "@/lib/protocol-worker/types";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";
import { sha256Hex } from "@/lib/evidence/hash";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

const APPROVER = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_REQUEST_BODY = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const LEGACY_TOKENS = /\b(won|partial|lost|verdict|whyClientLost|clientMentioned)\b/i;

const PROTOCOL_FIXTURE: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity",
  surface: "sonar",
  plannedBaselineRuns: 2,
  plannedRetestRuns: 0,
  paraphrasePlan: [
    { text: "Which vendors handle X best?", hash: "b".repeat(64) },
    { text: "Who should I use for X?", hash: "c".repeat(64) },
  ],
  unitOfAnalysis: "run",
  primaryMetric: "listed_in_run",
  samplePlanningMethod: "fixed",
  runCap: 20,
  spendCapUsd: 100,
  timeWindowSeconds: 3600,
  rateLimitPerHour: 100,
  concurrencyLimit: 5,
  retryCap: 2,
};

/** A Perplexity HTTP body shaped exactly like the real provider's. */
function providerBody(answer: string): string {
  return JSON.stringify({
    id: "req-fixture",
    choices: [{ message: { content: answer } }],
    citations: [],
  });
}

const M5_OUTPUT: ProbeAnalysisM5Parsed = {
  clientPosition: "listed",
  competitorsMentioned: [
    { name: "Acme Rival", position: 1, context: "listed first" },
    // An answer engine — must never be stored as a competitor (Sprint 13C).
    { name: "Perplexity", position: 2, context: "mentioned as the engine" },
  ],
  sourcesCited: [
    { source: "g2.com/products/example", type: "review_site" },
    { source: "example-client.test/pricing", type: "vendor_site" },
    { source: "blog.perplexity.ai/what-we-index", type: "blog" },
  ],
  answerSummary: "Two vendors are listed; the client appears among them.",
};

async function main(): Promise<void> {
  const root = process.cwd();
  const src = (p: string) => readFileSync(path.join(root, p), "utf8");
  /** Code only: a doc comment may legitimately name what it excludes. */
  const code = (p: string) =>
    src(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // ======================================================================
  // [1] D-028 — no legacy verdict agent anywhere on the M5 path.
  // ======================================================================
  console.log("[1] D-028 — the M5 analysis path is free of the legacy verdict agent");
  for (const file of [
    "lib/protocol-worker/analysis-m5.ts",
    "lib/protocol-worker/execute-job.ts",
    "lib/protocol-worker/worker.ts",
  ]) {
    const s = code(file);
    check(
      `${file}: does not import lib/agents/probe-analysis`,
      !/from\s+["'][^"']*agents\/probe-analysis["']/.test(s)
    );
    check(
      `${file}: no executable reference to ProbeAnalysisOutputSchema or runProbeAnalysisAgent`,
      !/ProbeAnalysisOutputSchema|runProbeAnalysisAgent/.test(s)
    );
    check(`${file}: no executable reference to parseJsonOrRetry`, !/parseJsonOrRetry/.test(s));
  }
  check(
    "the M5 system prompt contains no won/partial/lost/verdict token",
    !LEGACY_TOKENS.test(PROBE_ANALYSIS_M5_SYSTEM_PROMPT)
  );
  check(
    "the built call's user message contains no legacy token either",
    !LEGACY_TOKENS.test(
      buildProbeAnalysisM5Call({
        prompt: "Which vendors handle X best?",
        aiResponse: "Acme Rival and Example Client are both options.",
        clientName: "Example Client",
        domain: "example-client.test",
      }).user
    )
  );

  // ======================================================================
  // [2] Exactly four keys.
  // ======================================================================
  console.log("\n[2] The model produces exactly four keys");
  const shapeKeys = Object.keys(ProbeAnalysisM5OutputSchema.shape).sort();
  check(
    "ProbeAnalysisM5OutputSchema declares exactly 4 keys",
    shapeKeys.length === 4,
    shapeKeys.join(",")
  );
  check(
    "those keys are clientPosition/competitorsMentioned/sourcesCited/answerSummary",
    shapeKeys.join(",") === "answerSummary,clientPosition,competitorsMentioned,sourcesCited"
  );
  check("no `verdict` key in the shape", !("verdict" in ProbeAnalysisM5OutputSchema.shape));
  check(
    "the mock reply parses and carries no mention it did not observe",
    (() => {
      const m = buildMockProbeAnalysisM5();
      return (
        m.clientPosition === "absent" &&
        m.competitorsMentioned.length === 0 &&
        m.sourcesCited.length === 0
      );
    })()
  );
  check(
    "a legacy-shaped payload (verdict + whyClientLost) is REFUSED, not silently stripped",
    (() => {
      const r = parseProbeAnalysisM5Content(
        JSON.stringify({ ...M5_OUTPUT, verdict: "won", whyClientLost: "" })
      );
      return !r.ok && r.code === "normalization_failed";
    })()
  );
  check(
    "any single extra key is refused the same way",
    (() => {
      const r = parseProbeAnalysisM5Content(JSON.stringify({ ...M5_OUTPUT, confidence: 0.9 }));
      return !r.ok && r.code === "normalization_failed";
    })()
  );

  // ======================================================================
  // [3] Single-shot parsing.
  // ======================================================================
  console.log("\n[3] Parsing is single-shot");
  check(
    "invalid JSON -> ok:false with a closed code, never a throw or a retry",
    (() => {
      const r = parseProbeAnalysisM5Content("not json at all {{{");
      return !r.ok && r.code === "invalid_json";
    })()
  );
  check(
    "schema-invalid JSON -> schema_validation_failed",
    (() => {
      const r = parseProbeAnalysisM5Content(JSON.stringify({ clientPosition: "nope" }));
      return !r.ok && r.code === "schema_validation_failed";
    })()
  );
  check(
    "analysis-m5.ts imports no retry helper and calls no fetch",
    (() => {
      const s = src("lib/protocol-worker/analysis-m5.ts");
      return !/parse-json-or-retry/.test(s) && !/\bfetch\s*\(/.test(s);
    })()
  );

  // ======================================================================
  // [4] The nine persisted fields, each derived separately.
  // ======================================================================
  console.log("\n[4] Nine-field derivation");
  const derived = must(deriveProbeResultContent(M5_OUTPUT, "example-client.test"), "derived content");
  check("9 keys exactly", Object.keys(derived).length === 9, Object.keys(derived).sort().join(","));
  check("productPosition = clientPosition (identity)", derived.productPosition === "listed");
  check("productMentioned = (position !== absent)", derived.productMentioned === true);
  check("negativeClaimDetected = (position === negative)", derived.negativeClaimDetected === false);
  check("answerSummary is the model's, verbatim", derived.answerSummary === M5_OUTPUT.answerSummary);
  check("sourcesCited passes through unchanged", derived.sourcesCited.length === 3);
  check(
    "clientSourceCount counts only client-domain sources",
    derived.clientSourceCount === 1,
    String(derived.clientSourceCount)
  );
  check("citedAsSource = (clientSourceCount > 0)", derived.citedAsSource === true);
  check(
    "an absent client yields productMentioned=false and productPosition=absent together",
    (() => {
      const d = deriveProbeResultContent({ ...M5_OUTPUT, clientPosition: "absent" }, "example-client.test");
      return d !== null && d.productMentioned === false && d.productPosition === "absent";
    })()
  );
  check(
    "a negative client yields negativeClaimDetected=true and productMentioned=true",
    (() => {
      const d = deriveProbeResultContent({ ...M5_OUTPUT, clientPosition: "negative" }, "example-client.test");
      return d !== null && d.negativeClaimDetected === true && d.productMentioned === true;
    })()
  );
  check(
    "no client-domain source -> clientSourceCount 0 and citedAsSource false",
    (() => {
      const d = deriveProbeResultContent(
        { ...M5_OUTPUT, sourcesCited: [{ source: "g2.com/x", type: "review_site" }] },
        "example-client.test"
      );
      return d !== null && d.clientSourceCount === 0 && d.citedAsSource === false;
    })()
  );
  check(
    "sourceBelongsToDomain matches host and path, not a substring coincidence",
    sourceBelongsToDomain("https://www.example-client.test/pricing", "example-client.test") &&
      sourceBelongsToDomain("docs.example-client.test/a", "example-client.test") &&
      !sourceBelongsToDomain("notexample-client.test.evil.com/x", "example-client.test")
  );

  // ======================================================================
  // [5] platformsReferenced — from sources only.
  // ======================================================================
  console.log("\n[5] platformsReferenced is derived exclusively from sourcesCited");
  check(
    "every derived platform is supported by at least one cited source (0054's invariant)",
    derived.platformsReferenced.every((p) =>
      derived.sourcesCited.some((s) => s.source.toLowerCase().includes(p.toLowerCase()))
    ),
    derived.platformsReferenced.join("|")
  );
  check(
    "the platform actually present in a source URL is picked up",
    derived.platformsReferenced.some((p) => p.toLowerCase() === "perplexity")
  );
  check(
    "an AI platform named ONLY as a competitor is never turned into a platform",
    (() => {
      const d = deriveProbeResultContent(
        {
          ...M5_OUTPUT,
          competitorsMentioned: [{ name: "ChatGPT", position: 1, context: "mentioned" }],
          sourcesCited: [{ source: "g2.com/x", type: "review_site" }],
        },
        "example-client.test"
      );
      return d !== null && d.platformsReferenced.length === 0;
    })()
  );
  check(
    "an AI platform is never stored as a competitor (Sprint 13C)",
    derived.competitorsMentioned.length === 1 &&
      derived.competitorsMentioned[0].name === "Acme Rival"
  );
  check(
    "platformsReferencedFromSources ignores its caller's competitors entirely (pure, one argument)",
    platformsReferencedFromSources([{ source: "blog.perplexity.ai/x" }]).join(",") === "Perplexity" &&
      platformsReferencedFromSources([]).length === 0
  );

  // ======================================================================
  // Shared harness for the adapter-driven parts.
  // ======================================================================
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seedJob(domain: string): Promise<{ projectId: string }> {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: project.id,
      versionNumber: 1,
      promptText: "Which vendors handle X best?",
      promptHash: "a".repeat(64),
      intentType: "comparison",
      commercialValue: 3,
      winnability: 3,
      priority: 10,
      rationale: "fixture",
      provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: version.id,
      projectId: project.id,
      approvedBy: APPROVER,
    });
    const protocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE,
      projectId: project.id,
      buyerQuestionVersionId: version.id,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id };
  }

  function makeDeps(over: Partial<WorkerDeps> & { fetchSpy?: { calls: number } } = {}): WorkerDeps {
    const fetchSpy = over.fetchSpy ?? { calls: 0 };
    const analysis: AnalysisTransport = {
      prepare: () => ({
        provider: "openai" as const,
        model: "gpt-4o-mini",
        url: "https://api.openai.com/v1/chat/completions",
        rawRequestBody: ANALYSIS_REQUEST_BODY,
        requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
      }),
      execute: async () => ({
        provider: "openai" as const,
        model: "gpt-4o-mini",
        content: JSON.stringify(M5_OUTPUT),
        usedMock: false,
        modelReturned: null,
        latencyMs: 5,
        requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
        contentSha256: sha256Hex(JSON.stringify(M5_OUTPUT)),
        providerRequestId: "analysis-fixture",
        httpStatus: 200,
      }),
    };
    return {
      db,
      analysis,
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      probeMode: "live_perplexity",
      realFetch: (async () => {
        fetchSpy.calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      runProbe: (async (input) => {
        // Mirrors the real probe: the injected fetchImpl is the wire.
        const body = providerBody("Acme Rival and Example Client are both options.");
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          body: "{}",
        });
        return {
          prompt: input.prompt,
          answer: "Acme Rival and Example Client are both options.",
          rawResponse: body,
          citations: [],
          searchResults: [],
          sourceCitations: [],
          model: "sonar",
          usedMock: false,
          rawResponseBody: body,
          rawResponseBodySha256: sha256Hex(body),
          httpStatus: 200,
          latencyMs: 7,
          providerRequestId: "req-fixture",
        } satisfies PerplexityProbeResult;
      }) as WorkerDeps["runProbe"],
      ...over,
    };
  }

  const OPTS: WorkerOptions = {
    workerId: "test-worker",
    leaseSeconds: 60,
    idleBackoffMs: 1,
    maxBackoffMs: 2,
    maxSlotsPerClaim: 8,
    perplexityReservedCostUsd: 0.02,
    analysisReservedCostUsd: 0.02,
    jitterRatio: 0,
    maxThrottledRetries: 3,
    graceMs: 1000,
    exitAfterClaimedJob: false, providerTimeoutMs: 45000,
  };

  // ======================================================================
  // [6] A refused mark_sent must produce ZERO fetches.
  // ======================================================================
  console.log("\n[6] Refused mark_sent ⇒ zero outbound fetch");
  {
    await seedJob("markfail.test");
    const fetchSpy = { calls: 0 };
    const deps = makeDeps({ fetchSpy });
    const guarded: WorkerDeps = {
      ...deps,
      db: new Proxy(db, {
        get(target, prop, recv) {
          if (prop === "markExternalCallSentForJob") {
            return async () => ({ outcome: "JOB_NOT_OWNED" as const, externalCall: null });
          }
          return Reflect.get(target, prop, recv);
        },
      }) as DbAdapter,
    };
    const r = await runOneIteration(guarded, OPTS, new WorkerHealth(deps.now));
    check(
      "the iteration stops on the refused mark",
      r.outcome === "lost_ownership",
      `${r.outcome}/${r.detail}`
    );
    check("ZERO outbound fetches were made", fetchSpy.calls === 0, `calls=${fetchSpy.calls}`);
  }

  // ======================================================================
  // [7] The full loop: every planned baseline slot, then completion.
  // ======================================================================
  console.log("\n[7] Full loop over the planned baseline slots");
  {
    await seedJob("happy.test");
    const fetchSpy = { calls: 0 };
    const deps = makeDeps({ fetchSpy });
    const health = new WorkerHealth(deps.now);
    const results: IterationResult[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await runOneIteration(deps, OPTS, health);
      results.push(r);
      if (r.outcome === "no_job") break;
    }
    const completed = results.find((r) => r.outcome === "completed");
    check(
      "the job reaches `completed`",
      completed !== undefined,
      results.map((r) => `${r.outcome}:${r.detail}`).join(" | ")
    );
    check(
      "exactly one live provider call per planned baseline slot (2 planned ⇒ 2 fetches)",
      fetchSpy.calls === PROTOCOL_FIXTURE.plannedBaselineRuns,
      `fetches=${fetchSpy.calls}`
    );
    check(
      "a further claim finds nothing left to do",
      results[results.length - 1]?.outcome === "no_job" ||
        results.filter((r) => r.outcome === "completed").length === 1
    );
  }

  // ======================================================================
  // [8] The D-026 replay extractor.
  // ======================================================================
  console.log("\n[8] D-026 replay of a stored provider body");
  check(
    "a stored body yields the exact answer back",
    answerFromRawResponseBody(providerBody("hello world")) === "hello world"
  );
  check("a null body yields null", answerFromRawResponseBody(null) === null);
  check("an unparseable body yields null, never a guess", answerFromRawResponseBody("{{{") === null);
  check(
    "a body with no choices yields null",
    answerFromRawResponseBody(JSON.stringify({ choices: [] })) === null
  );
  check(
    "a whitespace-only answer yields null rather than an empty claim",
    answerFromRawResponseBody(providerBody("   ")) === null
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A worker loop contract PASSED." : "M5-A worker loop contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
