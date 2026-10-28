/**
 * Generic model-call wrapper.
 *
 * Provider is resolved in this order (highest priority first):
 *   1. `ZYPACT_MOCK_MODE=on`            → force mock.
 *   2. Per-call `provider` hint         → used by unit tests only.
 *   3. `LLM_PROVIDER=<openai|anthropic>`→ pins routing. Fails fast if the
 *      corresponding key is missing — this prevents "I set LLM_PROVIDER
 *      but forgot the key" from silently falling back to mock/other.
 *   4. Auto-detect: `OPENAI_API_KEY` wins over `ANTHROPIC_API_KEY`, else
 *      mock (backward-compat with pre–Sprint 10 behavior).
 *
 * Env contract (see .env.example / .env.local):
 *   LLM_PROVIDER=openai
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL=gpt-4o-mini          # pin an exact model, no floating aliases
 *
 * # Later live-LLM validation 2 (Anthropic):
 *   LLM_PROVIDER=anthropic
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   ANTHROPIC_MODEL=claude-3-5-sonnet-latest
 *
 * JSON validation still lives with each agent (Zod is the product
 * contract). `jsonSchema` here is an OpenAI-side optimization only: when
 * supplied and the provider is OpenAI, we send OpenAI's native
 * `response_format: { type: "json_schema", ... }` instead of the more
 * permissive `type: "json_object"`. Agents may adopt this later without
 * changing the Zod schema they enforce afterwards. Anthropic ignores it.
 *
 * Keep this file provider-agnostic. Do not import agent code here.
 *
 * D-027 (B0.2A-1) — two-phase transport. `prepareCallModelRequest`
 * assembles the exact outbound request (and validates the API key)
 * WITHOUT making any HTTP call; `executePreparedCallModelRequest` makes
 * the single HTTP call for an already-prepared request. `callModel`
 * remains a compatible wrapper chaining both for every existing caller.
 * This split exists so a future M5 worker can: reserve → prepare →
 * mark_external_call_sent_for_job → execute → receipt — with any
 * configuration/preparation failure surfacing BEFORE the call is ever
 * marked "sent".
 */

import { sha256Hex } from "@/lib/evidence/hash";

export type LlmProvider = "openai" | "anthropic" | "mock";

export interface CallModelInput {
  system: string;
  user: string;
  /** JSON mode is on by default — every Zypact agent returns JSON. */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * Per-call provider hint. Rarely used in production; the resolver
   * normally picks based on env. When set, overrides env-based routing
   * (except `ZYPACT_MOCK_MODE=on`, which always wins).
   */
  provider?: LlmProvider;
  /** Used when no key is configured or mock mode is forced on. */
  mockResponse?: string;
  /**
   * Optional per-call model override. This lets one agent benchmark a
   * production model without changing the global model used by QA and the
   * rest of the pipeline.
   */
  model?: string;
  /**
   * Optional structured-output schema for OpenAI. When present AND
   * provider === "openai" AND jsonMode !== false, we send OpenAI's
   * native `response_format: { type: "json_schema", ... }`. When absent,
   * we fall back to the current `type: "json_object"` behavior. Agents
   * pass this in gradually — the wrapper never invents or mutates it.
   */
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  /**
   * D-027 (B0.2A-1) — optional abort signal, forwarded to `fetch`. A
   * future worker wires this to its own lease-loss detection; this file
   * never knows why a signal fired, only that it did (reason "aborted").
   */
  signal?: AbortSignal;
  /** D-027 (B0.2A-1) — optional fetch injection for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface CallModelResult {
  content: string;
  provider: LlmProvider;
  model: string;
  usedMock: boolean;
  /** M1 evidence contract — wall-clock milliseconds spent in the outbound call. 0 for mock. */
  latencyMs: number;
  /** D-027 (B0.2A-1) — SHA-256 of the exact request body sent on the wire. Null for mock. */
  requestSha256: string | null;
  /** D-027 (B0.2A-1) — SHA-256 of `content`'s exact UTF-8 bytes, untrimmed. Null for mock. */
  contentSha256: string | null;
  /** D-027 (B0.2A-1) — provider-assigned request id, when the provider returns one. Null for mock or if absent. */
  providerRequestId: string | null;
  /** D-027 (B0.2A-1) — HTTP status of the successful response. Null for mock. */
  httpStatus: number | null;
  /**
   * TK-R-1 — the model the PROVIDER says it served, read from the response
   * body. Distinct from `model` above, which is what we ASKED for and keeps
   * its original meaning untouched. Null when the provider returns no such
   * field, and for mock. The two are never merged: a divergence between
   * them is exactly the signal this field exists to preserve.
   */
  modelReturned: string | null;
}

function resolveMockMode(): "on" | "off" | "auto" {
  const raw = (process.env.ZYPACT_MOCK_MODE ?? "auto").toLowerCase();
  if (raw === "on" || raw === "off") return raw;
  return "auto";
}

/**
 * Public, side-effect-free resolver so tests and validation scripts can
 * introspect which provider will handle the next call. Throws on the
 * "pinned but no key" case for the same reason `callModel` would.
 */
export function resolveProvider(hint?: LlmProvider): LlmProvider {
  const mode = resolveMockMode();
  if (mode === "on") return "mock";
  if (hint && hint !== "mock") return hint;

  const pin = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (pin === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "LLM_PROVIDER=openai but OPENAI_API_KEY is not set."
      );
    }
    return "openai";
  }
  if (pin === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set."
      );
    }
    return "anthropic";
  }
  if (pin && pin !== "mock") {
    throw new Error(
      `LLM_PROVIDER="${process.env.LLM_PROVIDER}" is not a supported provider. ` +
        `Use "openai" or "anthropic" (or leave unset for auto-detect).`
    );
  }

  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}

/**
 * The exact model name the next call will use, for a given provider.
 *
 * This exists because report metadata used to re-derive the model from
 * `OPENAI_MODEL`/`ANTHROPIC_MODEL` on its own and fell back to the literal
 * string "mock" when neither was set. A live OpenAI run with no
 * `OPENAI_MODEL` therefore produced a genuine report labelled
 * `model: mock` — misleading to anyone reading it, including a customer.
 *
 * The defaults below are the single source of truth: `callOpenAi` and
 * `callAnthropic` call this rather than repeating the `??` chain, so the
 * reported model cannot drift from the executed one.
 *
 * Side-effect free, and never throws for the mock provider, so metadata
 * builders can call it unconditionally.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
export const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";

export function resolveModel(
  provider: LlmProvider,
  override?: string
): string {
  if (override) return override;

  if (provider === "openai") {
    return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  }
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  }

  // Only a genuinely mock execution reports "mock".
  return "mock";
}

// ---------------------------------------------------------------------
// D-027 (B0.2A-1) — structured failure. Only safe metadata and hashes;
// NEVER a raw provider/model body, in any field, in `.message`, or
// reachable via `JSON.stringify(error)`/`Object.keys(error)`/`.stack`.
// ---------------------------------------------------------------------

export type CallModelFailureReason =
  | "network_error"
  | "aborted"
  | "http_error"
  | "malformed_response"
  | "empty_content";

const FIXED_FAILURE_MESSAGES: Record<CallModelFailureReason, string> = {
  network_error: "Model provider call failed: network error.",
  aborted: "Model provider call failed: aborted.",
  http_error: "Model provider call failed: non-2xx HTTP response.",
  malformed_response: "Model provider call failed: response envelope was not decodable.",
  empty_content: "Model provider call failed: response contained no model content.",
};

export interface CallModelFailureFields {
  httpStatus: number | null;
  providerRequestId: string | null;
  latencyMs: number;
  requestSha256: string | null;
}

export class CallModelFailure extends Error {
  readonly reason: CallModelFailureReason;
  readonly httpStatus: number | null;
  readonly providerRequestId: string | null;
  readonly latencyMs: number;
  readonly requestSha256: string | null;

  constructor(reason: CallModelFailureReason, fields: CallModelFailureFields) {
    super(FIXED_FAILURE_MESSAGES[reason]);
    this.name = "CallModelFailure";
    this.reason = reason;
    this.httpStatus = fields.httpStatus;
    this.providerRequestId = fields.providerRequestId;
    this.latencyMs = fields.latencyMs;
    this.requestSha256 = fields.requestSha256;
  }
}

// ---------------------------------------------------------------------
// D-027 (B0.2A-1) — two-phase transport.
// ---------------------------------------------------------------------

export interface PreparedCallModelRequest {
  readonly provider: "openai" | "anthropic";
  readonly model: string;
  readonly url: string;
  /** Exact JSON.stringify'd body that WILL be sent, byte-identical. */
  readonly rawRequestBody: string;
  /** sha256Hex(rawRequestBody) — exact UTF-8 bytes of the string above. */
  readonly requestSha256: string;
}

interface PreparedRequestSecrets {
  readonly headers: Record<string, string>;
  consumed: boolean;
}

/**
 * Headers (Authorization/x-api-key) live ONLY here, keyed by the
 * identity of the object returned to the caller — never as an
 * enumerable property of `PreparedCallModelRequest` itself, so
 * `JSON.stringify`/`Object.keys`/`Object.values` on the prepared object
 * can never surface a secret.
 */
const preparedRequestSecrets = new WeakMap<PreparedCallModelRequest, PreparedRequestSecrets>();

function requireOpenAiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return apiKey;
}

function requireAnthropicKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return apiKey;
}

function buildOpenAiBody(model: string, input: CallModelInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: input.temperature ?? 0.2,
  };
  if (input.maxTokens) body.max_tokens = input.maxTokens;

  if (input.jsonMode !== false) {
    if (input.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: input.jsonSchema.name,
          schema: input.jsonSchema.schema,
          strict: input.jsonSchema.strict ?? true,
        },
      };
    } else {
      body.response_format = { type: "json_object" };
    }
  }
  return body;
}

function buildAnthropicBody(model: string, input: CallModelInput): Record<string, unknown> {
  return {
    model,
    max_tokens: input.maxTokens ?? 4096,
    temperature: input.temperature ?? 0.2,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  };
}

/**
 * Assembles the exact outbound request and validates the API key —
 * performs NO HTTP call. Throws (a plain `Error`, before any HTTP is
 * even possible) if the provider is "mock" (mock has no HTTP request to
 * prepare — use `callModel` directly) or if the required key is
 * missing. Returned object exposes only safe, public fields; the real
 * headers live in a private WeakMap entry, never serializable from the
 * returned object.
 */
export function prepareCallModelRequest(input: CallModelInput): PreparedCallModelRequest {
  const provider = resolveProvider(input.provider);
  if (provider === "mock") {
    throw new Error(
      "prepareCallModelRequest: mock provider has no HTTP request to prepare — call callModel(input) directly."
    );
  }

  const model = resolveModel(provider, input.model);
  let headers: Record<string, string>;
  let url: string;
  let body: Record<string, unknown>;

  if (provider === "openai") {
    const apiKey = requireOpenAiKey();
    headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
    url = "https://api.openai.com/v1/chat/completions";
    body = buildOpenAiBody(model, input);
  } else {
    const apiKey = requireAnthropicKey();
    headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    url = "https://api.anthropic.com/v1/messages";
    body = buildAnthropicBody(model, input);
  }

  const rawRequestBody = JSON.stringify(body);
  const requestSha256 = sha256Hex(rawRequestBody);

  const prepared: PreparedCallModelRequest = Object.freeze({
    provider,
    model,
    url,
    rawRequestBody,
    requestSha256,
  });
  preparedRequestSecrets.set(prepared, { headers, consumed: false });
  return prepared;
}

function extractProviderRequestId(provider: "openai" | "anthropic", res: Response): string | null {
  if (provider === "openai") return res.headers.get("x-request-id");
  return res.headers.get("request-id");
}

/**
 * TK-R-1 — the model named by the response itself. Both OpenAI's Chat
 * Completions and Anthropic's Messages responses carry a top-level
 * `model`. Anything else, including a non-string, is treated as absent
 * rather than coerced: a fabricated value would be worse than a null.
 */
function extractReturnedModel(json: unknown): string | null {
  const typed = json as { model?: unknown };
  return typeof typed?.model === "string" && typed.model !== "" ? typed.model : null;
}

function extractOpenAiContent(json: unknown): string {
  const typed = json as { choices?: Array<{ message?: { content?: string } }> };
  return typed?.choices?.[0]?.message?.content ?? "";
}

function extractAnthropicContent(json: unknown): string {
  const typed = json as { content?: Array<{ type: string; text?: string }> };
  return typed?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
}

/**
 * Executes a single, already-prepared request. Single-use: the prepared
 * handle is consumed atomically (synchronously, before any `await`) — a
 * second call on the same handle, even issued concurrently, fails
 * before any HTTP with a fixed local error. No internal retry of any
 * kind. The exact content returned is never trimmed; `trim()` is used
 * only to detect `empty_content`.
 */
export async function executePreparedCallModelRequest(
  prepared: PreparedCallModelRequest,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<CallModelResult> {
  const secrets = preparedRequestSecrets.get(prepared);
  if (!secrets) {
    throw new Error("executePreparedCallModelRequest: unknown prepared request.");
  }
  if (secrets.consumed) {
    throw new Error("executePreparedCallModelRequest: this prepared request has already been executed.");
  }
  // Synchronous, before any `await` below — guarantees single-use even
  // under two concurrent calls on the same handle (see test).
  secrets.consumed = true;

  const fetcher = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetcher(prepared.url, {
      method: "POST",
      headers: secrets.headers,
      body: prepared.rawRequestBody,
      signal: opts.signal,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new CallModelFailure(aborted ? "aborted" : "network_error", {
      httpStatus: null,
      providerRequestId: null,
      latencyMs,
      requestSha256: prepared.requestSha256,
    });
  }
  const latencyMs = Date.now() - startedAt;
  const providerRequestId = extractProviderRequestId(prepared.provider, res);

  if (!res.ok) {
    await res.text().catch(() => undefined); // drain, never surface
    throw new CallModelFailure("http_error", {
      httpStatus: res.status,
      providerRequestId,
      latencyMs,
      requestSha256: prepared.requestSha256,
    });
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch {
    throw new CallModelFailure("malformed_response", {
      httpStatus: res.status,
      providerRequestId,
      latencyMs,
      requestSha256: prepared.requestSha256,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new CallModelFailure("malformed_response", {
      httpStatus: res.status,
      providerRequestId,
      latencyMs,
      requestSha256: prepared.requestSha256,
    });
  }

  const content =
    prepared.provider === "openai" ? extractOpenAiContent(json) : extractAnthropicContent(json);

  if (content.trim().length === 0) {
    throw new CallModelFailure("empty_content", {
      httpStatus: res.status,
      providerRequestId,
      latencyMs,
      requestSha256: prepared.requestSha256,
    });
  }

  return {
    content, // exact, untrimmed
    provider: prepared.provider,
    model: prepared.model,
    usedMock: false,
    latencyMs,
    requestSha256: prepared.requestSha256,
    contentSha256: sha256Hex(content), // exact UTF-8 bytes of the untrimmed content above
    providerRequestId,
    httpStatus: res.status,
    modelReturned: extractReturnedModel(json),
  };
}

export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  const provider = resolveProvider(input.provider);

  if (provider === "mock") {
    // A mock is a stand-in for development and tests. On the production web
    // deployment it would put invented content in front of a user as if a
    // model had produced it, so it is refused there whatever ZYPACT_MOCK_MODE
    // says. The Fly worker has no VERCEL_ENV and keeps its own live-mode
    // guards.
    if (process.env.VERCEL_ENV === "production") {
      throw new Error(
        "callModel: mock output is refused on the production deployment. " +
          "Configure a provider key, or leave this path disabled."
      );
    }
    if (!input.mockResponse) {
      throw new Error(
        "callModel: no LLM key configured and no mockResponse provided. " +
          "Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or pass mockResponse."
      );
    }
    return {
      content: input.mockResponse,
      provider: "mock",
      model: "mock",
      usedMock: true,
      latencyMs: 0,
      requestSha256: null,
      contentSha256: null,
      providerRequestId: null,
      httpStatus: null,
      // TK-R-1 — a mock never spoke to a provider, so no provider named a
      // model. Null, never the requested string echoed back.
      modelReturned: null,
    };
  }

  const prepared = prepareCallModelRequest(input);
  return executePreparedCallModelRequest(prepared, { signal: input.signal, fetchImpl: input.fetchImpl });
}
