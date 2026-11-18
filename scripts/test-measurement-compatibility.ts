/**
 * PR #3 — measurement compatibility between a baseline and its retest.
 *
 * What it pins:
 *   - the fingerprint keeps every request parameter and drops only the
 *     per-run content (the question, the answer analysed), hashing the
 *     analysis instructions; key order never matters;
 *   - identical execution configurations are compatible;
 *   - a change of requested model, served model, endpoint/provider,
 *     temperature, output limit, search mode, search behaviour, analysis
 *     model or analysis instructions is incompatible, and names the field;
 *   - missing, unrecorded or unreadable metadata is unverifiable — never
 *     filled in, never treated as a match;
 *   - a phase whose attempts were not all measured alike is unverifiable;
 *   - Sonar → reformulated Sonar (intervention 055c3514) and Sonar → Agent
 *     API shapes are incompatible; an Agent protocol has no known endpoint
 *     until PR #4 registers its adapter, so it is unverifiable;
 *   - anything but compatible makes the outcome inconclusive, even with a
 *     disclosed deviation and an apparent 0/5 → 5/5 change;
 *   - every read is scoped to the project, and the module never writes.
 *
 * Offline: Supabase is faked. Nothing reaches a provider or a database.
 */

import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ENDPOINT_NOT_RECORDED_CAVEAT,
  MEASUREMENT_FINGERPRINT_VERSION,
  canonicalJson,
  evaluateMeasurementCompatibility,
  readPhaseMeasurement,
  requestConfiguration,
  searchResultsPresence,
} from "@/lib/reports/measurement-fingerprint";
import { compareProtocols } from "@/lib/reports/compare-protocols";
import { fingerprintRawResponseBody, UNREADABLE_FINGERPRINT } from "@/lib/reports/served-provider-comparability";
import { PERPLEXITY_ENDPOINT } from "@/lib/probes/perplexity";

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

/* ── fixtures ──────────────────────────────────────────────────────────── */

interface PhaseShape {
  provider?: string;
  analyzerVersion?: number | null;
  requestedModel?: string;
  temperature?: number;
  maxTokens?: number;
  searchMode?: string;
  servedModel?: string;
  idPrefix?: string;
  object?: string;
  search?: boolean;
  analysisModel?: string;
  analysisServed?: string | null;
  analysisInstructions?: string;
  agentShape?: boolean;
  /** Per-run overrides, to make a phase internally inconsistent. */
  overrideRun?: { run: number; servedModel?: string };
  dropRequestOn?: number;
  dropReceiptOn?: number;
  duplicateReceiptOn?: number;
  brokenResponseOn?: number;
  requestInOtherProjectOn?: number;
  attempts?: number;
  /** Every run's stored provider response, verbatim (overrides the generated one). */
  rawResponse?: string;
}

function phase(protocolId: string, shape: PhaseShape = {}) {
  const n = shape.attempts ?? 5;
  const t: Record<string, Row[]> = {
    protocols: [{
      id: protocolId, project_id: PROJECT, provider: shape.provider ?? "perplexity_sonar", surface: "answer",
      analyzer_version: shape.analyzerVersion === undefined ? 1 : shape.analyzerVersion,
      entity_resolution_version: 2, methodology_version: "1.1",
    }],
    protocol_attempts: [], protocol_external_calls: [], external_call_requests: [],
    provider_call_receipts: [], analysis_call_receipts: [],
  };
  for (let i = 1; i <= n; i += 1) {
    const a = `${protocolId}-a${i}`;
    const pc = `${protocolId}-p${i}`;
    const ac = `${protocolId}-x${i}`;
    t.protocol_attempts.push({ id: a, protocol_id: protocolId, project_id: PROJECT, status: "completed" });
    t.protocol_external_calls.push({ id: pc, protocol_attempt_id: a, project_id: PROJECT, call_kind: "perplexity" });
    t.protocol_external_calls.push({ id: ac, protocol_attempt_id: a, project_id: PROJECT, call_kind: "analysis" });
    const probeBody = shape.agentShape
      ? { model: shape.requestedModel ?? "perplexity/sonar", input: `Which SOC 2 tool? (${i})`,
          tools: [{ type: "web_search" }], max_output_tokens: shape.maxTokens ?? 1200 }
      : { model: shape.requestedModel ?? "sonar", messages: [{ role: "user", content: `Which SOC 2 tool? (${i})` }],
          temperature: shape.temperature ?? 0.2, max_tokens: shape.maxTokens ?? 1200, stream: false,
          web_search_options: { search_mode: shape.searchMode ?? "web" } };
    if (shape.dropRequestOn !== i) {
      t.external_call_requests.push({
        external_call_id: pc, project_id: shape.requestInOtherProjectOn === i ? OTHER : PROJECT,
        request_body: JSON.stringify(probeBody),
      });
    }
    t.external_call_requests.push({
      external_call_id: ac, project_id: PROJECT,
      request_body: JSON.stringify({
        model: shape.analysisModel ?? "gpt-4o-2024-08-06", temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: shape.analysisInstructions ?? "Analyse the answer." }, { role: "user", content: `answer ${i}` }],
      }),
    });
    const servedModel = shape.overrideRun?.run === i ? shape.overrideRun.servedModel : shape.servedModel ?? "sonar";
    const response = shape.agentShape
      ? { id: `resp_${i}`, object: shape.object ?? "response", model: servedModel === "sonar" ? "perplexity/sonar" : servedModel,
          output: [...(shape.search === false ? [] : [{ type: "search_results", results: [{ id: 1, url: "https://x.example" }] }]),
                   { type: "message", content: [{ type: "output_text", text: "answer" }] }] }
      : { id: `${shape.idPrefix ?? "resp_"}${i}`, object: shape.object ?? "chat.completion", model: servedModel,
          choices: [{ message: { content: "answer" } }],
          ...(shape.search === false ? {} : { search_results: [{ url: "https://x.example" }] }) };
    if (shape.dropReceiptOn !== i) {
      t.provider_call_receipts.push({
        external_call_id: pc, project_id: PROJECT, outcome: "success",
        raw_response_body: shape.brokenResponseOn === i ? "{not json" : shape.rawResponse ?? JSON.stringify(response),
      });
      if (shape.duplicateReceiptOn === i) {
        t.provider_call_receipts.push({ external_call_id: pc, project_id: PROJECT, outcome: "success", raw_response_body: JSON.stringify(response) });
      }
    }
    t.analysis_call_receipts.push({
      external_call_id: ac, project_id: PROJECT, outcome: "success",
      model_returned: shape.analysisServed === undefined ? "gpt-4o-2024-08-06" : shape.analysisServed,
    });
  }
  return t;
}

/** Fake PostgREST that records every filter and refuses any write. */
function fakeDb(...phases: Record<string, Row[]>[]) {
  const tables: Record<string, Row[]> = {};
  for (const p of phases) for (const [k, rows] of Object.entries(p)) (tables[k] ??= []).push(...rows);
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  let writes = 0;
  const client = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        eq(c: string, v: unknown) { filters.push({ table, column: c, value: v }); rows = rows.filter((r) => r[c] === v); return q; },
        in(c: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert() { writes += 1; return q; }, update() { writes += 1; return q; },
        upsert() { writes += 1; return q; }, delete() { writes += 1; return q; },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) { return resolve({ data: rows, error: null }); },
      };
      return q;
    },
    rpc: async () => { writes += 1; return { data: null, error: null }; },
  } as unknown as SupabaseClient;
  return { client, filters, writes: () => writes };
}

async function compat(base: PhaseShape, re: PhaseShape) {
  const { client } = fakeDb(phase("base", base), phase("re", re));
  const b = await readPhaseMeasurement(client, "base", PROJECT);
  const r = await readPhaseMeasurement(client, "re", PROJECT);
  return evaluateMeasurementCompatibility(b, r);
}

async function main(): Promise<void> {
  console.log("\nMeasurement compatibility (PR #3)\n");

  /* ═══════ 1. building blocks ═══════ */
  console.log("[1] The fingerprint keeps configuration and drops per-run content");
  const a = requestConfiguration(JSON.stringify({ model: "sonar", temperature: 0.2, messages: [{ role: "user", content: "Q one" }] }));
  const b = requestConfiguration(JSON.stringify({ messages: [{ content: "Q two", role: "user" }], temperature: 0.2, model: "sonar" }));
  check("the question text and key order do not change the configuration", a !== null && a === b, `${a} vs ${b}`);
  check("a parameter change does",
    requestConfiguration(JSON.stringify({ model: "sonar", temperature: 0.3, messages: [{ role: "user", content: "Q" }] })) !== a);
  const sys1 = requestConfiguration(JSON.stringify({ model: "m", messages: [{ role: "system", content: "Rules A" }, { role: "user", content: "x" }] }));
  const sys2 = requestConfiguration(JSON.stringify({ model: "m", messages: [{ role: "system", content: "Rules B" }, { role: "user", content: "x" }] }));
  check("the analysis instructions are configuration (kept as a hash)", sys1 !== sys2 && !(sys1 ?? "").includes("Rules A"));
  const ag1 = requestConfiguration(JSON.stringify({ model: "perplexity/sonar", input: "Q one", tools: [{ type: "web_search" }] }));
  const ag2 = requestConfiguration(JSON.stringify({ model: "perplexity/sonar", input: "Q two", tools: [{ type: "web_search" }] }));
  check("an Agent-style input is per-run content too", ag1 === ag2 && !(ag1 ?? "").includes("Q one"));
  check("an unparseable or non-object body is unreadable (null)",
    requestConfiguration("{nope") === null && requestConfiguration("[1]") === null && requestConfiguration(null) === null);
  check("search results: Sonar shape", searchResultsPresence(JSON.stringify({ search_results: [{ url: "u" }] })) === "present");
  check("search results: Agent shape",
    searchResultsPresence(JSON.stringify({ output: [{ type: "search_results", results: [{ id: 1 }] }] })) === "present");
  check("search results: none returned", searchResultsPresence(JSON.stringify({ search_results: [] })) === "absent");
  check("search results: unreadable", searchResultsPresence("{x") === null);
  // D-061 — the OpenAI Responses shape, read for a ChatGPT protocol only.
  const sources = [{ type: "url", url: "https://vendor.example/pricing?utm_source=openai" }];
  const wsc = (action: unknown) => ({ type: "web_search_call", id: "ws_1", status: "completed", action });
  const responses = (output: unknown) => JSON.stringify({ id: "resp_1", object: "response", model: "gpt-5.4-2026-03-05", output });
  const withSources = responses([{ type: "reasoning" }, wsc({ type: "search", query: "q", sources }), { type: "message", content: [] }]);
  check("search results: ChatGPT, a web_search_call with sources → present", searchResultsPresence(withSources, "openai_chatgpt") === "present");
  check("search results: ChatGPT, one search with sources is enough beside one without",
    searchResultsPresence(responses([wsc({ type: "search", sources: [] }), wsc({ type: "search", sources })]), "openai_chatgpt") === "present");
  for (const [label, output] of [
    ["empty sources", [wsc({ type: "search", query: "q", sources: [] })]],
    ["no sources key", [wsc({ type: "search", query: "q" })]],
    ["sources not a list", [wsc({ type: "search", sources: "https://vendor.example" })]],
    ["only an open_page action", [wsc({ type: "open_page", url: "https://vendor.example" })]],
    ["no action", [{ type: "web_search_call", id: "ws_1", status: "completed" }]],
    ["sources on another item type", [{ type: "message", action: { sources } }]],
    ["no search call at all", [{ type: "message", content: [] }]],
    ["output not a list", { web_search_call: { action: { sources } } }],
  ] as const) {
    check(`search results: ChatGPT, ${label} → absent`, searchResultsPresence(responses(output), "openai_chatgpt") === "absent");
  }
  check("search results: ChatGPT, unreadable → null", searchResultsPresence("{x", "openai_chatgpt") === null
    && searchResultsPresence(null, "openai_chatgpt") === null && searchResultsPresence("[1]", "openai_chatgpt") === "absent");
  const sonarBody = JSON.stringify({ search_results: [{ url: "u" }] });
  const agentBody = JSON.stringify({ output: [{ type: "search_results", results: [{ id: 1 }] }] });
  check("search results: Sonar and Agent bodies read exactly as before, with or without their provider",
    searchResultsPresence(sonarBody, "perplexity_sonar") === "present" && searchResultsPresence(agentBody, "perplexity_agent") === "present"
      && searchResultsPresence(JSON.stringify({ search_results: [] }), "perplexity_sonar") === "absent"
      && searchResultsPresence(sonarBody, null) === searchResultsPresence(sonarBody));
  check("search results: the provider decides the shape: a Responses body under a Perplexity provider reads as before (absent), a Sonar body under ChatGPT is not read as Sonar",
    searchResultsPresence(withSources, "perplexity_agent") === "absent" && searchResultsPresence(withSources) === "absent"
      && searchResultsPresence(sonarBody, "openai_chatgpt") === "absent" && searchResultsPresence(agentBody, "openai_chatgpt") === "absent");
  check("canonical JSON ignores key order", canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));

  /* ═══════ 2. compatible ═══════ */
  console.log("\n[2] Identical execution configurations are compatible");
  {
    const r = await compat({}, {});
    check("same requests, same served model and shape, same analysis → compatible", r.status === "compatible", JSON.stringify(r));
    check("and versioned", r.version === MEASUREMENT_FINGERPRINT_VERSION && r.version === "mf-1");
    const { client } = fakeDb(phase("base"));
    const p = await readPhaseMeasurement(client, "base", PROJECT);
    check("the endpoint is the Sonar adapter's, labelled as a constant, not as recorded evidence",
      p.status === "consistent" && p.fingerprint.endpoint.value === PERPLEXITY_ENDPOINT && p.fingerprint.endpoint.provenance === "adapter_constant");
  }

  /* ═══════ 2b. search results are an observation, not configuration ═══════ */
  console.log("\n[2b] Search-result presence is evidence, never a reason to call phases incomparable");
  {
    const r = await compat({}, { search: false });
    check("identical configuration, retest returned no search results → still compatible", r.status === "compatible", JSON.stringify(r));
    check("and the observation is kept for each phase",
      r.observations?.baseline?.searchResultsPresent === 5 && r.observations?.retest?.searchResultsAbsent === 5,
      JSON.stringify(r.observations));
    // A phase whose runs differ ONLY in search presence is internally consistent.
    const tables = phase("mix", {});
    (tables.provider_call_receipts[1] as Row).raw_response_body = JSON.stringify({
      id: "resp_2", object: "chat.completion", model: "sonar", choices: [{ message: { content: "answer" } }],
    });
    const db = fakeDb(tables);
    const p = await readPhaseMeasurement(db.client, "mix", PROJECT);
    check("a phase whose runs differ only in search presence is consistent", p.status === "consistent", JSON.stringify(p));
    check("with the split recorded: 4 with results, 1 without",
      p.status === "consistent" && p.observations.searchResultsPresent === 4 && p.observations.searchResultsAbsent === 1);
    // D-061 — a ChatGPT phase is read in the Responses shape, through its protocol's provider.
    const gptBody = (withSearch: boolean) => JSON.stringify({
      id: "resp_7", object: "response", model: "gpt-5.4-2026-03-05", status: "completed",
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed",
          action: { type: "search", query: "q", sources: withSearch ? [{ type: "url", url: "https://x.example" }] : [] } },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const gpt = await readPhaseMeasurement(fakeDb(phase("gpt", { provider: "openai_chatgpt", rawResponse: gptBody(true) })).client, "gpt", PROJECT);
    check("a ChatGPT phase counts its searches in the Responses shape: 5 with results",
      gpt.status === "consistent" && gpt.observations.searchResultsPresent === 5 && gpt.observations.searchResultsAbsent === 0, JSON.stringify(gpt));
    const gptNone = await readPhaseMeasurement(fakeDb(phase("gpt0", { provider: "openai_chatgpt", rawResponse: gptBody(false) })).client, "gpt0", PROJECT);
    check("…and 5 without when its searches returned no sources, still consistent",
      gptNone.status === "consistent" && gptNone.observations.searchResultsAbsent === 5, JSON.stringify(gptNone));
    check("…under the ChatGPT endpoint and the unchanged fingerprint version mf-1",
      gpt.status === "consistent" && gpt.fingerprint.endpoint.value === "https://api.openai.com/v1/responses"
        && gpt.fingerprint.version === "mf-1" && MEASUREMENT_FINGERPRINT_VERSION === "mf-1");
    const sameShapeAsAgent = await readPhaseMeasurement(
      fakeDb(phase("agent-like", { provider: "perplexity_agent", rawResponse: gptBody(true) })).client, "agent-like", PROJECT);
    check("the same body under a Perplexity provider is read as before: no search_results item, so absent",
      sameShapeAsAgent.status === "consistent" && sameShapeAsAgent.observations.searchResultsAbsent === 5, JSON.stringify(sameShapeAsAgent));
  }

  /* ═══════ 2c. the endpoint is an assumption, stated as one ═══════ */
  console.log("\n[2c] A compatible verdict that rests on the adapter endpoint says so");
  {
    const r = await compat({}, {});
    check("compatible, with the endpoint caveat",
      r.status === "compatible" && r.caveats.includes(ENDPOINT_NOT_RECORDED_CAVEAT), JSON.stringify(r));
    const inc = await compat({}, { temperature: 0 });
    check("an unrelated difference does not report the endpoint as differing",
      inc.status === "incompatible" && !inc.differingFields.includes("endpoint"), JSON.stringify(inc));
  }

  /* ═══════ 3. incompatible ═══════ */
  console.log("\n[3] Any change in how a phase was measured is incompatible, and named");
  for (const [label, re, field] of [
    ["requested model", { requestedModel: "sonar-pro" }, "probeRequest"],
    ["served model", { servedModel: "sonar-2" }, "probeServed"],
    ["temperature", { temperature: 0 }, "probeRequest"],
    ["output limit", { maxTokens: 2000 }, "probeRequest"],
    ["search mode", { searchMode: "academic" }, "probeRequest"],
    ["analysis model requested", { analysisModel: "gpt-4o-mini-2024-07-18" }, "analysisRequest"],
    ["analysis model served", { analysisServed: "gpt-4o-2024-11-20" }, "analysisServed"],
    ["analysis instructions", { analysisInstructions: "Analyse it differently." }, "analysisRequest"],
    ["analyzer version", { analyzerVersion: 2 }, "protocol.analyzerVersion"],
  ] as const) {
    const r = await compat({}, re as PhaseShape);
    check(`${label} → incompatible, naming ${field}`,
      r.status === "incompatible" && r.differingFields.includes(field), JSON.stringify(r));
  }
  {
    // Endpoint changes only with the provider/adapter; a different known
    // provider is both a protocol and an endpoint difference.
    const r = await compat({}, { provider: "perplexity_sonar_alt" });
    check("an unknown provider has no known endpoint → unverifiable, not a match",
      r.status === "unverifiable" && /endpoint/.test(r.detail), JSON.stringify(r));
  }

  /* ═══════ 4. the provider boundaries ═══════ */
  console.log("\n[4] Sonar → reformulated Sonar → Agent API");
  {
    const r = await compat({ idPrefix: "pplx-" }, { idPrefix: "resp_" });
    check("Sonar-style ids then resp_ ids (intervention 055c3514) → incompatible on what was served",
      r.status === "incompatible" && r.differingFields.includes("probeServed") && !r.differingFields.includes("probeRequest"),
      JSON.stringify(r));
  }
  {
    const r = await compat({}, { agentShape: true });
    check("Sonar baseline vs Agent-shaped retest under the same provider label → incompatible on request and response",
      r.status === "incompatible" && r.differingFields.includes("probeRequest") && r.differingFields.includes("probeServed"),
      JSON.stringify(r));
  }
  {
    // PR #4 registered the Agent adapter's endpoint (still a constant, not
    // per-call evidence).
    const r = await compat({}, { agentShape: true, provider: "perplexity_agent" });
    check("a Sonar baseline vs an Agent retest → incompatible on provider, endpoint, request and response",
      r.status === "incompatible" &&
        ["protocol.provider", "endpoint", "probeRequest", "probeServed"].every((f) => r.differingFields.includes(f)),
      JSON.stringify(r));
  }
  {
    const r = await compat({ agentShape: true, provider: "perplexity_agent" }, { agentShape: true, provider: "perplexity_agent" });
    check("two Agent phases measured alike are compatible, with the endpoint caveat",
      r.status === "compatible" && r.caveats.includes(ENDPOINT_NOT_RECORDED_CAVEAT), JSON.stringify(r));
  }
  {
    const r = await compat({ provider: "perplexity" }, { provider: "perplexity" });
    check("the legacy \"perplexity\" label has no recorded endpoint → unverifiable, never compared",
      r.status === "unverifiable", JSON.stringify(r));
  }

  /* ═══════ 5. missing or unreadable metadata ═══════ */
  console.log("\n[5] Missing metadata is unverifiable — never filled in");
  for (const [label, re] of [
    ["a counted attempt with no stored request body", { dropRequestOn: 3 }],
    ["a counted attempt with no provider receipt", { dropReceiptOn: 2 }],
    ["two successful receipts for one attempt", { duplicateReceiptOn: 4 }],
    ["an unreadable provider response", { brokenResponseOn: 1 }],
    ["no served analysis model recorded (before 0058)", { analysisServed: null }],
    ["no analyzer version recorded", { analyzerVersion: null }],
    ["a phase with no counted attempt", { attempts: 0 }],
    ["a phase whose attempts were not all served alike", { overrideRun: { run: 5, servedModel: "sonar-2" } }],
    ["a request body that belongs to another project", { requestInOtherProjectOn: 2 }],
  ] as const) {
    const r = await compat({}, re as PhaseShape);
    check(`${label} → unverifiable`, r.status === "unverifiable", JSON.stringify(r));
  }

  /* ═══════ 5b. incomplete served responses never match ═══════ */
  console.log("\n[5b] A served response missing its model, id or object type is unverifiable");
  const sonar = { id: "pplx-1", object: "chat.completion", model: "sonar", choices: [{ message: { content: "a" } }] };
  const without = (key: string) => { const o: Record<string, unknown> = { ...sonar }; delete o[key]; return JSON.stringify(o); };
  for (const [label, raw] of [
    ["valid JSON missing the served model", without("model")],
    ["missing the response id", without("id")],
    ["missing the object type", without("object")],
    ["an empty served model", JSON.stringify({ ...sonar, model: "" })],
    ["a non-string served model", JSON.stringify({ ...sonar, model: 42 })],
    ["an empty JSON object", "{}"],
    ["an empty JSON array", "[]"],
  ] as const) {
    check(`fingerprint: ${label} → unreadable`, fingerprintRawResponseBody(raw) === UNREADABLE_FINGERPRINT,
      fingerprintRawResponseBody(raw));
    const { client } = fakeDb(phase("inc", { rawResponse: raw }));
    const p = await readPhaseMeasurement(client, "inc", PROJECT);
    check(`phase: ${label} → unverifiable`, p.status === "unverifiable", JSON.stringify(p));
  }
  for (const [label, raw] of [
    ["both missing the served model", without("model")],
    ["both missing the response id", without("id")],
    ["both missing the object type", without("object")],
    ["both an empty object", "{}"],
  ] as const) {
    const r = await compat({ rawResponse: raw }, { rawResponse: raw });
    check(`two phases with identically incomplete responses (${label}) → unverifiable, never compatible`,
      r.status === "unverifiable", JSON.stringify(r));
  }
  {
    // Historical Sonar (before the 2026-09-27 reformulation): complete, with
    // Sonar-style ids, in both phases.
    const complete = JSON.stringify({ ...sonar, citations: ["https://x.example"], search_results: [{ url: "https://x.example" }] });
    check("a complete historical Sonar response fingerprints normally",
      fingerprintRawResponseBody(complete) === "model=sonar id=other object=chat.completion", fingerprintRawResponseBody(complete));
    const r = await compat({ rawResponse: complete }, { rawResponse: complete });
    check("two phases of complete historical Sonar responses remain compatible", r.status === "compatible", JSON.stringify(r));
  }

  /* ═══════ 6. the outcome rule ═══════ */
  console.log("\n[6] Only a compatible measurement can yield increase or decrease");
  const id = { questionVersionId: "q", provider: "perplexity_sonar", surface: "answer", modelConfig: { model: "sonar" } };
  const big = { baseline: { numerator: 0, denominator: 5, plannedRuns: 5 }, retest: { numerator: 5, denominator: 5, plannedRuns: 5 },
    baselineIdentity: id, retestIdentity: id, minimumUsefulChange: 0.6 };
  {
    const r = compareProtocols({ ...big, recordedDeviationNote: null, measurementCompatibility: { status: "compatible" } });
    check("compatible: 0/5 → 5/5 is an increase", r.status === "increase_observed", r.status);
  }
  for (const status of ["incompatible", "unverifiable"] as const) {
    const r = compareProtocols({ ...big, recordedDeviationNote: null, measurementCompatibility: { status, detail: "x" } });
    check(`${status}: 0/5 → 5/5 is inconclusive`, r.status === "inconclusive" && r.delta === null, r.status);
    check(`${status}: the reason is recorded`, r.reasons.some((x) => x.startsWith(`MEASUREMENT_${status.toUpperCase()}`)), r.reasons.join("|"));
    const d = compareProtocols({ ...big, recordedDeviationNote: "Perplexity changed backends.", measurementCompatibility: { status, detail: "x" } });
    check(`${status}: a disclosed deviation does not override it`, d.status === "inconclusive", d.status);
    const dec = compareProtocols({ ...big, baseline: big.retest, retest: big.baseline, recordedDeviationNote: null, measurementCompatibility: { status } });
    check(`${status}: 5/5 → 0/5 is not a decrease either`, dec.status === "inconclusive", dec.status);
  }
  {
    const r = compareProtocols({ ...big, recordedDeviationNote: null });
    check("the pure engine without a verdict behaves exactly as before (the card always supplies one)", r.status === "increase_observed");
  }
  {
    const r = compareProtocols({ ...big, recordedDeviationNote: null,
      measurementCompatibility: { status: "compatible", caveats: [ENDPOINT_NOT_RECORDED_CAVEAT] } });
    check("a compatible verdict with the endpoint caveat still compares directionally", r.status === "increase_observed", r.status);
    check("and records the caveat as a reason the card shows",
      r.reasons.some((x) => x.startsWith("MEASUREMENT_CAVEAT: endpoint not recorded per call")), r.reasons.join("|"));
  }

  /* ═══════ 6b. the buyer question must be the same ═══════ */
  console.log("\n[6b] A different buyer question never yields a direction, deviation or not");
  const ok = { status: "compatible" as const, caveats: [] };
  for (const [label, re] of [
    ["a different question version", { ...id, questionVersionId: "q-2" }],
    ["the same version id but a different question text hash", { ...id, questionHash: "h-other" }],
    ["a missing question version", { ...id, questionVersionId: "" }],
  ] as const) {
    const base = { ...id, questionHash: "h-1" };
    const retestId = { questionHash: "h-1", ...re };
    for (const note of [null, "The question was reworded after the baseline."]) {
      const r = compareProtocols({ ...big, baselineIdentity: base, retestIdentity: retestId, recordedDeviationNote: note, measurementCompatibility: ok });
      check(`${label}${note ? ", deviation disclosed" : ""} → inconclusive, BUYER_QUESTION_MISMATCH`,
        r.status === "inconclusive" && r.reasons.includes("BUYER_QUESTION_MISMATCH") && r.delta === null, `${r.status} ${r.reasons}`);
    }
  }
  {
    const same = { ...id, questionHash: "h-1" };
    const r = compareProtocols({ ...big, baselineIdentity: same, retestIdentity: same, recordedDeviationNote: null, measurementCompatibility: ok });
    check("the same version and hash still compare", r.status === "increase_observed", r.status);
    const card = fs.readFileSync("lib/reports/deliver-outcome-card.ts", "utf8");
    check("the Outcome Card reads each phase's real buyer_question_version_id and passes both",
      /select\("id,buyer_question_version_id"\)/.test(card) && /questionVersionIds: \{/.test(card));
  }

  /* ═══════ 7. scoping and read-only ═══════ */
  console.log("\n[7] Every read is scoped to the project; nothing is written");
  {
    const db = fakeDb(phase("base"), phase("re"));
    await readPhaseMeasurement(db.client, "base", PROJECT);
    const scoped = new Set(db.filters.filter((f) => f.column === "project_id").map((f) => f.table));
    check("all six tables are read with a project filter",
      ["protocols", "protocol_attempts", "protocol_external_calls", "external_call_requests", "provider_call_receipts", "analysis_call_receipts"]
        .every((t) => scoped.has(t)), Array.from(scoped).join(","));
    check("and only with this project", db.filters.filter((f) => f.column === "project_id").every((f) => f.value === PROJECT));
    check("no insert, update, upsert, delete or rpc was issued", db.writes() === 0);
    const src = fs.readFileSync("lib/reports/measurement-fingerprint.ts", "utf8");
    check("the module contains no write call at all", !/\.(insert|update|upsert|delete|rpc)\(/.test(src));
  }
  {
    const card = fs.readFileSync("lib/reports/deliver-outcome-card.ts", "utf8");
    const at = card.indexOf("evaluateMeasurementCompatibility(");
    check("the Outcome Card evaluates compatibility before it builds the card",
      at > 0 && at < card.indexOf("const card = buildOutcomeCard("));
    check("and passes it into the card and into integrity",
      /measurementCompatibility,\n/.test(card) && /measurement: measurementCompatibility\.status === "compatible"/.test(card));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
