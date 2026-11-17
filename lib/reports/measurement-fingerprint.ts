/**
 * Whether a baseline and its retest were measured the same way, judged from
 * the execution evidence each attempt actually left behind.
 *
 * A measurement here is two calls: the provider answering the buyer
 * question (Perplexity) and the analysis model reading that answer. Either
 * changing — a parameter, the served model, the response shape, the search
 * behaviour, the analysis model or its instructions — changes what the
 * number means. compare-protocols.ts already compares the protocols'
 * requested `model_config`; that cannot see a change the provider makes
 * behind an identical request (intervention 055c3514: Sonar-style ids in
 * its baseline, `resp_` ids in its retest), nor a change in anything else
 * sent with the request.
 *
 * So every counted attempt is reduced to a fingerprint (version below)
 * built only from stored evidence:
 *
 *   protocol         provider, surface, analyzer / entity-resolution /
 *                    methodology versions               (protocols)
 *   endpoint         the adapter's endpoint, by provider — never recorded
 *                    per call, so taken from the adapter constant and
 *                    labelled as such                   (code)
 *   probeRequest     the exact request body as sent, with the question
 *                    text removed and every other parameter kept
 *                                                       (external_call_requests)
 *   probeServed      served model, response-id format and object type
 *                                                       (provider_call_receipts)
 *   analysisRequest  the exact analysis request, user content removed,
 *                    system instructions kept as a hash (external_call_requests)
 *   analysisServed   the analysis model the provider says it served
 *                                                       (analysis_call_receipts)
 *
 * Not part of the fingerprint, by design:
 *
 *   search results   whether a run's response carried search results is an
 *                    OBSERVATION of that run, not configuration: identical
 *                    requests to the same served model may or may not
 *                    search. It is counted per phase and returned as
 *                    evidence, never used to decide compatibility.
 *   endpoint         never recorded per call. The adapter constant is used
 *                    to know WHICH endpoint a provider implies, but it is
 *                    not historical evidence of what each call reached, so
 *                    a compatible verdict that rests on it says so in a
 *                    caveat instead of counting it as a verified match.
 *
 * Nothing is inferred to fill a gap. A field that was never recorded is
 * `unrecorded`, and any attempt with an unrecorded or unreadable field makes
 * its phase unverifiable. Read-only: this module never writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { sha256Hex } from "@/lib/evidence/hash";
import { OPENAI_RESPONSES_ENDPOINT, PERPLEXITY_AGENT_ENDPOINT, PERPLEXITY_SONAR_ENDPOINT } from "@/lib/probes/endpoints";
import { fingerprintRawResponseBody, UNREADABLE_FINGERPRINT } from "@/lib/reports/served-provider-comparability";

export const MEASUREMENT_FINGERPRINT_VERSION = "mf-1";

const UNRECORDED = "unrecorded";

/**
 * Endpoint by protocol provider. Per-call endpoints are not stored; this is
 * the adapter's own constant (every version of lib/probes/perplexity.ts has
 * used it). A provider not listed here has no known endpoint.
 */
const ADAPTER_ENDPOINTS: Record<string, string> = {
  perplexity_sonar: PERPLEXITY_SONAR_ENDPOINT,
  // PR #4. Still an adapter constant, not per-call evidence: the existing
  // schema has nowhere to record the endpoint each call reached.
  perplexity_agent: PERPLEXITY_AGENT_ENDPOINT,
  // D-056 — the ChatGPT engine's adapter constant, with the same caveat.
  openai_chatgpt: OPENAI_RESPONSES_ENDPOINT,
  // The legacy "perplexity" label is deliberately absent: its calls ran on
  // Sonar, but nothing recorded which endpoint, so it stays unverifiable.
};

/** Keys sorted at every depth, so two equal configurations print identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A request body reduced to its configuration: every parameter kept, the
 * per-attempt content removed. Chat-style `messages` keep each role; a
 * system message keeps a hash of its text (the analysis instructions are
 * configuration), user and assistant text is dropped (the question, and the
 * answer being analysed, are evidence, not configuration). Agent-style
 * `input` is dropped and `instructions` kept as a hash. Null when the body
 * is not a JSON object.
 */
export function requestConfiguration(rawBody: unknown): string | null {
  if (typeof rawBody !== "string") return null;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const config: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (Array.isArray(config.messages)) {
    config.messages = config.messages.map((m) => {
      const msg = (m ?? {}) as Record<string, unknown>;
      return msg.role === "system" && typeof msg.content === "string"
        ? { role: "system", contentSha256: sha256Hex(msg.content) }
        : { role: msg.role ?? null };
    });
  }
  if ("input" in config) config.input = "(removed: per-attempt content)";
  if (typeof config.instructions === "string") {
    config.instructions = { sha256: sha256Hex(config.instructions) };
  }
  return canonicalJson(config);
}

/** Whether a raw provider response carries search results, in either the Sonar or the Agent shape. */
export function searchResultsPresence(rawBody: unknown): "present" | "absent" | null {
  if (typeof rawBody !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const body = json as Record<string, unknown>;
  if (Array.isArray(body.search_results) && body.search_results.length > 0) return "present";
  if (Array.isArray(body.output)) {
    const found = body.output.some((item) => {
      const it = (item ?? {}) as Record<string, unknown>;
      return it.type === "search_results" && Array.isArray(it.results) && it.results.length > 0;
    });
    if (found) return "present";
  }
  return "absent";
}

export interface MeasurementFingerprint {
  version: string;
  protocol: Record<string, string>;
  /** "recorded" is reserved for per-call endpoint evidence (PR #4); nothing writes it yet. */
  endpoint: { value: string; provenance: "recorded" | "adapter_constant" | "unrecorded" };
  probeRequest: string;
  probeServed: string;
  analysisRequest: string;
  analysisServed: string;
}

/** Per-phase observations kept as evidence; they never decide compatibility. */
export interface PhaseObservations {
  searchResultsPresent: number;
  searchResultsAbsent: number;
}

export type PhaseMeasurement =
  | { status: "consistent"; fingerprint: MeasurementFingerprint; attempts: number; observations: PhaseObservations }
  | { status: "unverifiable"; reason: string };

export interface CompatibilityObservations {
  baseline: PhaseObservations | null;
  retest: PhaseObservations | null;
}

export type MeasurementCompatibility =
  | { status: "compatible"; version: string; caveats: string[]; observations?: CompatibilityObservations }
  | { status: "incompatible"; version: string; differingFields: string[]; detail: string; observations?: CompatibilityObservations }
  | { status: "unverifiable"; version: string; detail: string; observations?: CompatibilityObservations };

/** Stated whenever a compatible verdict rests on the adapter constant for the endpoint. */
export const ENDPOINT_NOT_RECORDED_CAVEAT =
  "endpoint not recorded per call; both phases are assumed to have used the adapter's endpoint, which the stored evidence cannot confirm";

/**
 * Every compared leaf of the fingerprint, as "path=value" pairs. The
 * endpoint is not among them: it is handled on its own, because what is
 * known about it is an assumption, not evidence (see the header).
 */
function leaves(fp: MeasurementFingerprint): Record<string, string> {
  const out: Record<string, string> = {
    version: fp.version,
    probeRequest: fp.probeRequest,
    probeServed: fp.probeServed,
    analysisRequest: fp.analysisRequest,
    analysisServed: fp.analysisServed,
  };
  for (const [k, v] of Object.entries(fp.protocol)) out[`protocol.${k}`] = v;
  return out;
}

function anyUnrecorded(fp: MeasurementFingerprint): string | null {
  for (const [k, v] of Object.entries(leaves(fp))) {
    if (v === UNRECORDED || v.startsWith(`${UNRECORDED} `) || v.includes(UNREADABLE_FINGERPRINT)) return k;
  }
  return null;
}

/**
 * Reads one protocol's counted (completed) attempts and returns the single
 * fingerprint they share, or why it cannot be established. Every read is
 * scoped to the protocol's own project.
 */
export async function readPhaseMeasurement(
  client: SupabaseClient,
  protocolId: string,
  projectId: string
): Promise<PhaseMeasurement> {
  const fail = (reason: string): PhaseMeasurement => ({ status: "unverifiable", reason });

  const { data: proto, error: protoError } = await client
    .from("protocols")
    .select("id,project_id,provider,surface,analyzer_version,entity_resolution_version,methodology_version")
    .eq("id", protocolId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (protoError) throw protoError;
  if (!proto) return fail("the protocol could not be read");
  const p = proto as Record<string, unknown>;
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? UNRECORDED : String(v));
  const protocol = {
    provider: str(p.provider),
    surface: str(p.surface),
    analyzerVersion: str(p.analyzer_version),
    entityResolutionVersion: str(p.entity_resolution_version),
    methodologyVersion: str(p.methodology_version),
  };
  const endpointValue = ADAPTER_ENDPOINTS[protocol.provider];
  const endpoint = endpointValue
    ? { value: endpointValue, provenance: "adapter_constant" as const }
    : { value: UNRECORDED, provenance: "unrecorded" as const };

  const { data: attempts, error: attemptError } = await client
    .from("protocol_attempts")
    .select("id,status")
    .eq("protocol_id", protocolId)
    .eq("project_id", projectId);
  if (attemptError) throw attemptError;
  const counted = (attempts ?? [])
    .filter((a: Record<string, unknown>) => a.status === "completed")
    .map((a: Record<string, unknown>) => String(a.id));
  if (counted.length === 0) return fail("the phase has no counted attempt");

  const { data: calls, error: callError } = await client
    .from("protocol_external_calls")
    .select("id,protocol_attempt_id,call_kind")
    .eq("project_id", projectId)
    .in("protocol_attempt_id", counted);
  if (callError) throw callError;
  const callRows = (calls ?? []) as Record<string, unknown>[];
  const callIds = callRows.map((c) => String(c.id));

  const [requests, providerReceipts, analysisReceipts] = callIds.length === 0
    ? [[], [], []]
    : await Promise.all([
        client.from("external_call_requests").select("external_call_id,request_body")
          .eq("project_id", projectId).in("external_call_id", callIds),
        client.from("provider_call_receipts").select("external_call_id,outcome,raw_response_body")
          .eq("project_id", projectId).in("external_call_id", callIds),
        client.from("analysis_call_receipts").select("external_call_id,outcome,model_returned")
          .eq("project_id", projectId).in("external_call_id", callIds),
      ]).then((results) => {
        for (const r of results) if (r.error) throw r.error;
        return results.map((r) => (r.data ?? []) as Record<string, unknown>[]);
      });

  if (endpoint.provenance === "unrecorded") {
    return fail(`no endpoint is known for provider ${protocol.provider}`);
  }

  const bodyOf = new Map(requests.map((r) => [String(r.external_call_id), r.request_body]));
  const keys = new Set<string>();
  let first: MeasurementFingerprint | null = null;
  const observations: PhaseObservations = { searchResultsPresent: 0, searchResultsAbsent: 0 };

  for (const attemptId of counted) {
    const own = callRows.filter((c) => String(c.protocol_attempt_id) === attemptId);
    const probeCalls = own.filter((c) => c.call_kind === "perplexity").map((c) => String(c.id));
    const analysisCalls = own.filter((c) => c.call_kind === "analysis").map((c) => String(c.id));

    // The call that produced the evidence: the successful receipt. Exactly
    // one per kind; zero or several is not a single measurement.
    const probeOk = providerReceipts.filter((r) => probeCalls.includes(String(r.external_call_id)) && r.outcome === "success");
    const analysisOk = analysisReceipts.filter((r) => analysisCalls.includes(String(r.external_call_id)) && r.outcome === "success");
    if (probeOk.length !== 1) return fail(`a counted attempt has ${probeOk.length} successful provider receipts`);
    if (analysisOk.length !== 1) return fail(`a counted attempt has ${analysisOk.length} successful analysis receipts`);

    const probeCallId = String(probeOk[0].external_call_id);
    const analysisCallId = String(analysisOk[0].external_call_id);
    const probeRequest = requestConfiguration(bodyOf.get(probeCallId));
    const analysisRequest = requestConfiguration(bodyOf.get(analysisCallId));
    if (probeRequest === null) return fail("a counted attempt has no readable provider request body");
    if (analysisRequest === null) return fail("a counted attempt has no readable analysis request body");

    const served = fingerprintRawResponseBody(probeOk[0].raw_response_body);
    const search = searchResultsPresence(probeOk[0].raw_response_body);
    if (served === UNREADABLE_FINGERPRINT || search === null) {
      return fail("a counted attempt has no readable provider response");
    }

    const fp: MeasurementFingerprint = {
      version: MEASUREMENT_FINGERPRINT_VERSION,
      protocol,
      endpoint,
      probeRequest,
      probeServed: served,
      analysisRequest,
      analysisServed: str(analysisOk[0].model_returned),
    };
    const unrecorded = anyUnrecorded(fp);
    if (unrecorded) return fail(`a counted attempt has no recorded ${unrecorded}`);
    keys.add(canonicalJson(leaves(fp)));
    first ??= fp;
    if (search === "present") observations.searchResultsPresent += 1;
    else observations.searchResultsAbsent += 1;
  }

  if (keys.size !== 1 || !first) {
    return fail(`its ${counted.length} counted attempts were not all measured the same way`);
  }
  return { status: "consistent", fingerprint: first, attempts: counted.length, observations };
}

/**
 * Compares two phases. Only two consistent phases with identical compared
 * fingerprints and the same endpoint are compatible; an endpoint known only
 * from the adapter constant is stated as a caveat. Search observations are
 * returned alongside, whatever the verdict.
 */
export function evaluateMeasurementCompatibility(
  baseline: PhaseMeasurement,
  retest: PhaseMeasurement
): MeasurementCompatibility {
  const version = MEASUREMENT_FINGERPRINT_VERSION;
  const observations: CompatibilityObservations = {
    baseline: baseline.status === "consistent" ? baseline.observations : null,
    retest: retest.status === "consistent" ? retest.observations : null,
  };
  if (baseline.status !== "consistent" || retest.status !== "consistent") {
    const parts: string[] = [];
    if (baseline.status !== "consistent") parts.push(`baseline: ${baseline.reason}`);
    if (retest.status !== "consistent") parts.push(`retest: ${retest.reason}`);
    return { status: "unverifiable", version, detail: `Measurement configuration could not be verified (${parts.join("; ")}).`, observations };
  }
  const a = leaves(baseline.fingerprint);
  const b = leaves(retest.fingerprint);
  const differing = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .filter((k) => a[k] !== b[k]);
  if (baseline.fingerprint.endpoint.value !== retest.fingerprint.endpoint.value) differing.push("endpoint");
  differing.sort();
  if (differing.length > 0) {
    return {
      status: "incompatible",
      version,
      differingFields: differing,
      detail: `The baseline and retest were not measured the same way (differs in: ${differing.join(", ")}).`,
      observations,
    };
  }
  const caveats =
    baseline.fingerprint.endpoint.provenance === "recorded" && retest.fingerprint.endpoint.provenance === "recorded"
      ? []
      : [ENDPOINT_NOT_RECORDED_CAVEAT];
  return { status: "compatible", version, caveats, observations };
}
