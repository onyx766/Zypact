/**
 * PR #2 — cost recording and reconciliation.
 *
 * What it pins:
 *   - provider token counts are captured from the response, and anything
 *     absent or malformed is unknown, never zero;
 *   - an analysis call is priced only for an exactly listed model, as
 *     `estimated`, deterministically; a mock, an unknown model or missing
 *     usage gives no cost at all;
 *   - the successful analysis receipt carries that cost, the failure receipt
 *     none, and the adapter forwards it;
 *   - the spend gate counts measured cost, the larger of estimate and
 *     reservation for estimates, and the reservation when cost is unknown —
 *     so for every ledger shape that exists today it counts exactly what it
 *     counted before, and an estimate never lowers the count;
 *   - reconciliation counts every row once, in one bucket, and flags
 *     overruns and malformed rows instead of totalling them;
 *   - the cost report is founder-only, read-only, aggregate-only and scoped
 *     to one project, and refuses rather than undercounts;
 *   - D-061: the provider leg (`call_kind = 'perplexity'` for every engine)
 *     is split by engine through the protocol's provider, analysis apart, a
 *     leg whose engine is unknown never filed under one, and the OpenAI
 *     price table version stated when ChatGPT rows exist.
 *
 * Offline: fetch is injected, Supabase is faked. Nothing reaches a provider.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
process.env.ZYPACT_MOCK_MODE = "off";
process.env.LLM_PROVIDER = "openai";
process.env.OPENAI_API_KEY = "test-only-not-a-key";
process.env.OPENAI_MODEL = "gpt-4o-2024-08-06";

import fs from "node:fs";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  LLM_PRICE_TABLE_VERSION,
  estimateLlmCostUsd,
  tokenUsageFromProviderJson,
} from "@/lib/costs/llm-pricing";
import { costLegOf, reconcileCosts } from "@/lib/costs/reconcile-costs";
import { handleProjectCostReport } from "@/lib/costs/project-cost-report";
import { OPENAI_PRICE_TABLE } from "@/lib/probes/chatgpt-pricing";
import { countedCostUsd } from "@/lib/worker-control/paid-execution-gate";
import { analysisReceiptCost } from "@/lib/protocol-worker/execute-job";
import { executePreparedCallModelRequest, prepareCallModelRequest } from "@/lib/llm/call-model";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Row = Record<string, unknown>;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function main(): Promise<void> {
  console.log("\nCost recording (PR #2)\n");

  /* ═══════ 1. token usage ═══════ */
  console.log("[1] Token usage is read from the provider response, or unknown");
  const oa = tokenUsageFromProviderJson("openai", { usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  check("OpenAI prompt/completion tokens", oa?.inputTokens === 1000 && oa?.outputTokens === 500, JSON.stringify(oa));
  const an = tokenUsageFromProviderJson("anthropic", {
    usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
  });
  check("Anthropic input includes cache tokens, charged at the full rate", an?.inputTokens === 115 && an?.outputTokens === 40,
    JSON.stringify(an));
  for (const [label, json] of [
    ["no usage", {}],
    ["usage not an object", { usage: "lots" }],
    ["a string count", { usage: { prompt_tokens: "1000", completion_tokens: 5 } }],
    ["a negative count", { usage: { prompt_tokens: -1, completion_tokens: 5 } }],
    ["a fractional count", { usage: { prompt_tokens: 1.5, completion_tokens: 5 } }],
    ["a missing count", { usage: { prompt_tokens: 10 } }],
    ["a null body", null],
  ] as const) {
    check(`${label} → unknown (null)`, tokenUsageFromProviderJson("openai", json) === null);
  }
  check("a malformed Anthropic cache count → unknown",
    tokenUsageFromProviderJson("anthropic", { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -3 } }) === null);

  /* ═══════ 2. pricing ═══════ */
  console.log("\n[2] Only an exactly listed model is priced");
  const usage = { inputTokens: 1000, outputTokens: 500 };
  const priced = estimateLlmCostUsd({ provider: "openai", model: "gpt-4o-2024-08-06", usage });
  check("gpt-4o-2024-08-06: 1000 in + 500 out = $0.0075", priced === 0.0075, String(priced));
  check("the same input always gives the same number",
    estimateLlmCostUsd({ provider: "openai", model: "gpt-4o-2024-08-06", usage: { inputTokens: 3333, outputTokens: 777 } })
      === estimateLlmCostUsd({ provider: "openai", model: "gpt-4o-2024-08-06", usage: { inputTokens: 3333, outputTokens: 777 } }));
  for (const [label, args] of [
    ["an unlisted model", { provider: "openai", model: "gpt-4o-2024-11-20", usage }],
    ["a family name, not a snapshot", { provider: "openai", model: "gpt-4o", usage }],
    ["a prefix match", { provider: "openai", model: "gpt-4o-2024-08-06-preview", usage }],
    ["the right model under the wrong provider", { provider: "anthropic", model: "gpt-4o-2024-08-06", usage }],
    ["a mock call", { provider: "mock", model: "gpt-4o-2024-08-06", usage }],
    ["no usage", { provider: "openai", model: "gpt-4o-2024-08-06", usage: null }],
    ["no model", { provider: "openai", model: null, usage }],
    ["malformed usage", { provider: "openai", model: "gpt-4o-2024-08-06", usage: { inputTokens: -1, outputTokens: 2 } }],
  ] as const) {
    check(`${label} → no cost`, estimateLlmCostUsd(args as Parameters<typeof estimateLlmCostUsd>[0]) === null);
  }
  check("the price table carries a version", /^\d{4}-\d{2}-\d{2}\.\d+$/.test(LLM_PRICE_TABLE_VERSION));

  /* ═══════ 3. callModel captures usage ═══════ */
  console.log("\n[3] callModel returns the provider's token counts");
  {
    const prepared = prepareCallModelRequest({ system: "s", user: "u", jsonMode: true, mockResponse: "{}" });
    const body = { model: "gpt-4o-2024-08-06", choices: [{ message: { content: "{\"x\":1}" } }], usage: { prompt_tokens: 1200, completion_tokens: 300 } };
    const out = await executePreparedCallModelRequest(prepared, {
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    });
    check("usage is returned", out.usage?.inputTokens === 1200 && out.usage?.outputTokens === 300, JSON.stringify(out.usage));
    const prepared2 = prepareCallModelRequest({ system: "s", user: "u", jsonMode: true, mockResponse: "{}" });
    const out2 = await executePreparedCallModelRequest(prepared2, {
      fetchImpl: (async () => new Response(JSON.stringify({ ...body, usage: undefined }), { status: 200 })) as typeof fetch,
    });
    check("a response without usage → usage null, not zero", out2.usage === null, JSON.stringify(out2.usage));
  }

  /* ═══════ 4. the analysis receipt's cost ═══════ */
  console.log("\n[4] The successful analysis receipt carries an estimated cost, or none");
  const served = { provider: "openai", model: "gpt-4o-2024-08-06", modelReturned: "gpt-4o-2024-08-06", usage };
  const c1 = analysisReceiptCost(served);
  check("priced → { actualCostUsd, costBasis: 'estimated' }", c1.actualCostUsd === 0.0075 && c1.costBasis === "estimated",
    JSON.stringify(c1));
  check("never 'measured' for an analysis call", (c1.costBasis as string) !== "measured");
  check("mock → no cost fields at all", JSON.stringify(analysisReceiptCost({ ...served, provider: "mock" })) === "{}");
  check("no usage → no cost fields", JSON.stringify(analysisReceiptCost({ ...served, usage: null })) === "{}");
  check("the SERVED model is priced: served unlisted → no cost, even if the requested one is listed",
    JSON.stringify(analysisReceiptCost({ ...served, modelReturned: "gpt-4o-2024-11-20" })) === "{}");
  check("no served model reported → the requested model is priced",
    analysisReceiptCost({ ...served, modelReturned: null }).actualCostUsd === 0.0075);
  {
    const src = fs.readFileSync("lib/protocol-worker/execute-job.ts", "utf8");
    const success = src.slice(src.indexOf('outcome: "success",\n    provider: out.provider'));
    const successCall = success.slice(0, success.indexOf("});"));
    check("the success receipt spreads analysisReceiptCost(out)", successCall.includes("...analysisReceiptCost(out)"));
    const failure = src.slice(src.indexOf("async function recordAnalysisFailure"), src.indexOf("async function", src.indexOf("async function recordAnalysisFailure") + 10));
    check("the failure receipt records no cost", !/actualCostUsd|analysisReceiptCost/.test(failure));
    const adapter = fs.readFileSync("lib/db/supabase-adapter.ts", "utf8");
    check("the adapter forwards an estimated basis and its cost to 0058",
      /input\.costBasis === "measured" \|\| input\.costBasis === "estimated"/.test(adapter) && adapter.includes("p_actual_cost_usd: rpcActualCostUsd"));
  }

  /* ═══════ 5. what the gate counts ═══════ */
  console.log("\n[5] The spend gate never counts less than before");
  const previous = (r: Row) => {
    const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : null);
    return n(r.actual_cost_usd) ?? n(r.reserved_cost_usd);
  };
  for (const [label, row] of [
    ["Perplexity measured receipt", { reserved_cost_usd: 0.02, actual_cost_usd: 0.0035, cost_basis: "measured" }],
    ["analysis receipt before PR #2 (no cost)", { reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null }],
    ["in-flight reservation", { reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null }],
  ] as const) {
    check(`${label}: counted exactly as before`, countedCostUsd(row) === previous(row), `${countedCostUsd(row)} vs ${previous(row)}`);
  }
  check("an estimate below its reservation counts the reservation",
    countedCostUsd({ reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" }) === 0.02);
  check("an estimate above its reservation counts the estimate",
    countedCostUsd({ reserved_cost_usd: 0.02, actual_cost_usd: 0.05, cost_basis: "estimated" }) === 0.05);
  check("a measured cost above its reservation counts the measured cost",
    countedCostUsd({ reserved_cost_usd: 0.02, actual_cost_usd: 0.03, cost_basis: "measured" }) === 0.03);

  /* ═══════ 6. reconciliation ═══════ */
  console.log("\n[6] Reconciliation counts each row once and flags what it cannot total");
  const ledger: Row[] = [
    { call_kind: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: 0.0035, cost_basis: "measured" },
    { call_kind: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: 0.025, cost_basis: "measured" },
    { call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" },
    { call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null },
    { call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: 0.01, cost_basis: null },
    { call_kind: "analysis", reserved_cost_usd: "abc", actual_cost_usd: null, cost_basis: null },
  ];
  const rec = reconcileCosts(ledger as never);
  const t = rec.total;
  check("every row counted once", t.calls === 6 && t.measuredCalls + t.estimatedCalls + t.unknownCalls + t.malformedCalls === 6,
    JSON.stringify(t));
  check("measured, estimated and unknown are separated",
    t.measuredCalls === 2 && t.estimatedCalls === 1 && t.unknownCalls === 1 && t.malformedCalls === 2);
  check("known actual = measured + estimated, no double counting",
    t.actualKnownUsd === 0.036 && t.measuredUsd === 0.0285 && t.estimatedUsd === 0.0075, JSON.stringify(t));
  check("reserved covers only the rows that could be read", t.reservedUsd === 0.08, String(t.reservedUsd));
  check("an overrun is flagged by count and amount", t.overrunCalls === 1 && t.overrunUsd === 0.005, JSON.stringify(t));
  check("totals split by call kind", rec.byCallKind.perplexity.calls === 2 && rec.byCallKind.analysis.calls === 4);
  check("rows without a joined provider never land under an engine: provider legs are provider_engine_unknown",
    rec.byLeg.provider_engine_unknown?.calls === 2 && rec.byLeg.analysis?.calls === 4
      && rec.byLeg.perplexity === undefined && rec.byLeg.chatgpt === undefined, JSON.stringify(Object.keys(rec.byLeg)));

  // D-061 — the provider leg of every engine is `perplexity` in the ledger;
  // the engine comes from the protocol's provider, joined by the caller.
  console.log("\n[6b] D-061: the provider leg split by engine through the protocol's provider");
  const twoEngines: Row[] = [
    { call_kind: "perplexity", provider: "perplexity_sonar", reserved_cost_usd: 0.02, actual_cost_usd: 0.005, cost_basis: "measured" },
    { call_kind: "perplexity", provider: "perplexity_agent", reserved_cost_usd: 0.02, actual_cost_usd: 0.004, cost_basis: "measured" },
    { call_kind: "perplexity", provider: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null },
    { call_kind: "perplexity", provider: "openai_chatgpt", reserved_cost_usd: 0.54, actual_cost_usd: 0.05, cost_basis: "estimated" },
    { call_kind: "perplexity", provider: "openai_chatgpt", reserved_cost_usd: 0.54, actual_cost_usd: null, cost_basis: null },
    { call_kind: "analysis", provider: "openai_chatgpt", reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" },
    { call_kind: "analysis", provider: "perplexity_sonar", reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" },
    { call_kind: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: 0.003, cost_basis: "measured" },
    { call_kind: "perplexity", provider: "gemini_later", reserved_cost_usd: 0.02, actual_cost_usd: 0.001, cost_basis: "measured" },
    { call_kind: "mystery", provider: "openai_chatgpt", reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null },
  ];
  const split = reconcileCosts(twoEngines as never);
  const leg = split.byLeg;
  check("the ledger's own label is kept: every engine's provider leg stays under perplexity in byCallKind",
    split.byCallKind.perplexity.calls === 7 && split.byCallKind.analysis.calls === 2 && split.byCallKind.mystery.calls === 1);
  check("byLeg files every Perplexity provider string under perplexity",
    leg.perplexity?.calls === 3 && leg.perplexity.measuredUsd === 0.009 && leg.perplexity.unknownCalls === 1, JSON.stringify(leg.perplexity));
  check("…ChatGPT's provider leg under chatgpt, as estimates, with its own reservations",
    leg.chatgpt?.calls === 2 && leg.chatgpt.estimatedUsd === 0.05 && leg.chatgpt.estimatedCalls === 1
      && leg.chatgpt.unknownCalls === 1 && leg.chatgpt.reservedUsd === 1.08 && leg.chatgpt.measuredCalls === 0, JSON.stringify(leg.chatgpt));
  check("…the analysis leg apart, whatever the engine", leg.analysis?.calls === 2 && leg.analysis.estimatedUsd === 0.015);
  check("…a provider leg with no or an unknown provider as provider_engine_unknown, never an engine; an unknown kind apart",
    leg.provider_engine_unknown?.calls === 2 && leg.unknown_kind?.calls === 1);
  const legCalls = Object.values(leg).reduce((n, t) => n + (t?.calls ?? 0), 0);
  const legReserved = Math.round(Object.values(leg).reduce((n, t) => n + (t?.reservedUsd ?? 0), 0) * 1e8) / 1e8;
  const legActual = Math.round(Object.values(leg).reduce((n, t) => n + (t?.actualKnownUsd ?? 0), 0) * 1e8) / 1e8;
  check("every row lands in exactly one leg: the legs add up to the total, with no double counting",
    legCalls === split.total.calls && legCalls === twoEngines.length
      && legReserved === split.total.reservedUsd && legActual === split.total.actualKnownUsd, `${legCalls} ${legReserved} ${legActual}`);
  check("costLegOf, row by row",
    costLegOf({ call_kind: "analysis", provider: undefined }) === "analysis"
      && costLegOf({ call_kind: "perplexity", provider: "perplexity_sonar" }) === "perplexity"
      && costLegOf({ call_kind: "perplexity", provider: "openai_chatgpt" }) === "chatgpt"
      && costLegOf({ call_kind: "perplexity", provider: "OPENAI_CHATGPT" }) === "provider_engine_unknown"
      && costLegOf({ call_kind: "perplexity", provider: 7 }) === "provider_engine_unknown"
      && costLegOf({ call_kind: "chatgpt", provider: "openai_chatgpt" }) === "unknown_kind");

  /* ═══════ 7. the founder-only report ═══════ */
  console.log("\n[7] The cost report: founder-only, scoped, aggregate, fail-closed");
  function fakeClient(tables: Record<string, Row[]>, o: { failOn?: string; countBonus?: number } = {}) {
    const filters: Array<{ table: string; column: string; value: unknown }> = [];
    const client = {
      from(table: string) {
        let rows = [...(tables[table] ?? [])];
        let wantCount = false;
        const q = {
          select(_c: string, opt?: { count?: string }) { wantCount = opt?.count === "exact"; return q; },
          eq(c: string, v: unknown) { filters.push({ table, column: c, value: v }); rows = rows.filter((r) => r[c] === v); return q; },
          in(c: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
          limit(n: number) { rows = rows.slice(0, n); return q; },
          then(resolve: (v: unknown) => unknown) {
            if (o.failOn === table) return resolve({ data: null, error: { message: "down" }, count: null });
            return resolve({ data: rows, error: null, count: wantCount ? rows.length + (o.countBonus ?? 0) : null });
          },
        };
        return q;
      },
    } as unknown as SupabaseClient;
    return { client, filters };
  }
  const founder = async () => ({ ok: true as const, user: { id: "f", email: "founder@zypact.example" } });
  const tables = {
    protocol_external_calls: [
      { project_id: PROJECT, protocol_attempt_id: "a1", call_kind: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: 0.0035, cost_basis: "measured", raw_response_body: "SECRET-BODY" },
      { project_id: PROJECT, protocol_attempt_id: "a1", call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" },
      { project_id: PROJECT, protocol_attempt_id: "a9", call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: null, cost_basis: null },
      { project_id: OTHER, protocol_attempt_id: "b1", call_kind: "perplexity", reserved_cost_usd: 9, actual_cost_usd: 9, cost_basis: "measured" },
    ],
    protocol_attempts: [
      { id: "a1", project_id: PROJECT, protocol_id: "proto-1" },
      { id: "a9", project_id: OTHER, protocol_id: "proto-other" },
      { id: "b1", project_id: OTHER, protocol_id: "proto-other" },
    ],
    // D-061 — each protocol names its engine.
    protocols: [
      { id: "proto-1", project_id: PROJECT, provider: "perplexity_sonar" },
      { id: "proto-other", project_id: OTHER, provider: "openai_chatgpt" },
    ],
  };
  for (const [label, status] of [["unauthenticated", 401], ["signed in, not a founder", 404]] as const) {
    const res = await handleProjectCostReport(PROJECT, {
      guard: async () => ({ ok: false as const, response: NextResponse.json({ ok: false }, { status }) }),
      client: () => { throw new Error("must not be built"); },
    });
    check(`${label} → the guard's ${status}, and no client is built`, res.status === status);
  }
  {
    const res = await handleProjectCostReport("not-a-uuid", { guard: founder, client: () => fakeClient(tables).client });
    check("an invalid project id → 400", res.status === 400);
  }
  {
    const { client, filters } = fakeClient(tables);
    const res = await handleProjectCostReport(PROJECT, { guard: founder, client: () => client });
    const body = await res.json();
    check("a founder gets 200", res.status === 200, String(res.status));
    check("only this project's ledger rows are totalled", body.total.calls === 3 && body.total.reservedUsd === 0.06,
      JSON.stringify(body.total));
    // D-061 — three reads now: the ledger, the attempts, and the protocols that name each engine.
    check("every read is filtered by this project: the ledger, the attempts and the protocols",
      filters.filter((f) => f.column === "project_id").every((f) => f.value === PROJECT) &&
      JSON.stringify([...new Set(filters.filter((f) => f.column === "project_id").map((f) => f.table))].sort())
        === JSON.stringify(["protocol_attempts", "protocol_external_calls", "protocols"]));
    check("an attempt from another project is never attributed to its protocol",
      body.byProtocol.some((p: { protocolId: string }) => p.protocolId === "unattributed") &&
      !body.byProtocol.some((p: { protocolId: string }) => p.protocolId === "proto-other"), JSON.stringify(body.byProtocol));
    check("the response carries totals only, no raw content", !JSON.stringify(body).includes("SECRET-BODY"));
    check("and states the price table version", body.priceTableVersion === LLM_PRICE_TABLE_VERSION);
    check("D-061 a Perplexity-only project: its provider leg under perplexity, analysis apart, no ChatGPT leg and no OpenAI table",
      body.byLeg.perplexity?.calls === 1 && body.byLeg.analysis?.calls === 2 && body.byLeg.chatgpt === undefined
        && body.openAiPriceTableVersion === null, JSON.stringify(body.byLeg));
  }
  {
    // D-061 — a project measured on both engines.
    const both = {
      protocol_external_calls: [
        ...tables.protocol_external_calls,
        { project_id: PROJECT, protocol_attempt_id: "g1", call_kind: "perplexity", reserved_cost_usd: 0.54, actual_cost_usd: 0.05, cost_basis: "estimated", raw_response_body: "SECRET-GPT-BODY" },
        { project_id: PROJECT, protocol_attempt_id: "g1", call_kind: "analysis", reserved_cost_usd: 0.02, actual_cost_usd: 0.0075, cost_basis: "estimated" },
        // An attempt of this project whose protocol is not this project's: its engine is never read from another project.
        { project_id: PROJECT, protocol_attempt_id: "x1", call_kind: "perplexity", reserved_cost_usd: 0.02, actual_cost_usd: 0.002, cost_basis: "measured" },
      ],
      protocol_attempts: [
        ...tables.protocol_attempts,
        { id: "g1", project_id: PROJECT, protocol_id: "proto-gpt" },
        { id: "x1", project_id: PROJECT, protocol_id: "proto-other" },
      ],
      protocols: [...tables.protocols, { id: "proto-gpt", project_id: PROJECT, provider: "openai_chatgpt" }],
    };
    const { client } = fakeClient(both);
    const res = await handleProjectCostReport(PROJECT, { guard: founder, client: () => client });
    const body = await res.json();
    check("D-061 two engines: the ledger label still holds every provider leg under perplexity",
      res.status === 200 && body.byCallKind.perplexity.calls === 3, JSON.stringify(body.byCallKind));
    check("D-061 two engines: byLeg separates Perplexity's provider leg from ChatGPT's, with analysis apart",
      body.byLeg.perplexity?.calls === 1 && body.byLeg.perplexity.measuredUsd === 0.0035
        && body.byLeg.chatgpt?.calls === 1 && body.byLeg.chatgpt.estimatedUsd === 0.05 && body.byLeg.chatgpt.reservedUsd === 0.54
        && body.byLeg.analysis?.calls === 3, JSON.stringify(body.byLeg));
    check("D-061 a protocol outside the project never names an engine: that leg is provider_engine_unknown",
      body.byLeg.provider_engine_unknown?.calls === 1 && body.byLeg.provider_engine_unknown.measuredUsd === 0.002);
    check("D-061 the OpenAI price table version is stated beside the analysis one when ChatGPT rows exist",
      body.openAiPriceTableVersion === OPENAI_PRICE_TABLE.version && body.openAiPriceTableVersion === "openai-prices-2026-11-17"
        && body.priceTableVersion === LLM_PRICE_TABLE_VERSION);
    check("D-061 the totals are unchanged by the split, and still carry no raw content",
      body.total.calls === 6 && !JSON.stringify(body).includes("SECRET-GPT-BODY"), JSON.stringify(body.total));
  }
  for (const [label, deps] of [
    ["the client cannot be built", { guard: founder, client: () => { throw new Error("no env"); } }],
    ["the ledger read fails", { guard: founder, client: () => fakeClient(tables, { failOn: "protocol_external_calls" }).client }],
    ["the ledger is larger than one page", { guard: founder, client: () => fakeClient(tables, { countBonus: 1 }).client }],
    ["the attempts read fails", { guard: founder, client: () => fakeClient(tables, { failOn: "protocol_attempts" }).client }],
    ["the protocols read fails (D-061)", { guard: founder, client: () => fakeClient(tables, { failOn: "protocols" }).client }],
  ] as const) {
    const res = await handleProjectCostReport(PROJECT, deps as never);
    check(`${label} → 503, never a partial total`, res.status === 503, String(res.status));
  }
  {
    const route = fs.readFileSync("app/api/internal/costs/projects/[projectId]/route.ts", "utf8");
    check("the route wires the founder guard", route.includes('requireFounderForRoute("costs/project")'));
    check("the route exports GET only (read-only)", /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
