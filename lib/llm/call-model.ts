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
 */

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
}

export interface CallModelResult {
  content: string;
  provider: LlmProvider;
  model: string;
  usedMock: boolean;
  /** M1 evidence contract — wall-clock milliseconds spent in the outbound call. 0 for mock. */
  latencyMs: number;
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

export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  const provider = resolveProvider(input.provider);

  if (provider === "mock") {
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
    };
  }

  if (provider === "openai") {
    return callOpenAi(input);
  }
  return callAnthropic(input);
}

async function callOpenAi(input: CallModelInput): Promise<CallModelResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = resolveModel("openai", input.model);

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

  const startedAt = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  return { content, provider: "openai", model, usedMock: false, latencyMs };
}

async function callAnthropic(input: CallModelInput): Promise<CallModelResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = resolveModel("anthropic", input.model);

  const startedAt = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0.2,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    }),
  });
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const content =
    json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  return { content, provider: "anthropic", model, usedMock: false, latencyMs };
}
