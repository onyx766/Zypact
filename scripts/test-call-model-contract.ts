#!/usr/bin/env tsx
/**
 * D-027 (B0.2A-1) — real, network-free contract test for the two-phase
 * `lib/llm/call-model.ts` transport.
 *
 * No real network call anywhere in this file: every HTTP interaction is
 * driven by a `fetchImpl` this file supplies itself, constructing real
 * `Request`/`Response` objects (Node's built-in `fetch` globals) but
 * never reaching an actual socket. No Docker, no staging, no
 * Production, no provider.
 */

import { z } from "zod";
import {
  callModel,
  prepareCallModelRequest,
  executePreparedCallModelRequest,
  CallModelFailure,
  type CallModelFailureReason,
  type PreparedCallModelRequest,
} from "../lib/llm/call-model";
import { parseJsonOrRetry } from "../lib/llm/parse-json-or-retry";
import { sha256Hex } from "../lib/evidence/hash";

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

const FAKE_OPENAI_KEY = "sk-test-fake-not-a-real-key-000111222";
const FAKE_ANTHROPIC_KEY = "sk-ant-test-fake-not-a-real-key-000111222";
const SECRET_MARKER = "__SECRET_PROVIDER_BODY_MARKER__";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function serializableStringsOf(value: unknown): string[] {
  const out: string[] = [];
  out.push(JSON.stringify(value) ?? "");
  if (value && typeof value === "object") {
    out.push(...Object.keys(value));
    out.push(...Object.values(value as Record<string, unknown>).map((v) => String(v)));
  }
  return out;
}

async function main(): Promise<void> {
  // ======================================================================
  // [1] prepareCallModelRequest — exact body, exact hash, no secret ever
  //     enumerable/serializable from the returned object.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const prepared = prepareCallModelRequest({
      provider: "openai",
      system: "sys prompt",
      user: "user prompt",
      temperature: 0,
      maxTokens: 123,
    });

    check("prepared.provider is openai", prepared.provider === "openai");
    check("prepared.model resolves to the default", prepared.model === "gpt-4o-mini");
    check("prepared.url is the OpenAI endpoint", prepared.url === "https://api.openai.com/v1/chat/completions");

    const expectedBody = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "user prompt" },
      ],
      temperature: 0,
      max_tokens: 123,
      response_format: { type: "json_object" },
    });
    check(
      "rawRequestBody is byte-identical to the expected serialized body",
      prepared.rawRequestBody === expectedBody,
      `got=${prepared.rawRequestBody}`
    );
    check(
      "requestSha256 matches sha256Hex(rawRequestBody) exactly",
      prepared.requestSha256 === sha256Hex(prepared.rawRequestBody)
    );

    const surfaces = serializableStringsOf(prepared);
    check(
      "no fake API key is present anywhere in JSON.stringify/Object.keys/Object.values of the prepared object",
      surfaces.every((s) => !s.includes(FAKE_OPENAI_KEY))
    );
    check(
      "no 'authorization' or 'x-api-key' key name is enumerable on the prepared object",
      !("authorization" in prepared) && !("x-api-key" in prepared) && !Object.keys(prepared).some((k) => /authoriz|api.?key/i.test(k))
    );
  });

  // ======================================================================
  // [2] executePreparedCallModelRequest — exact body sent to fetch,
  //     request ID / HTTP status captured, content exact/untrimmed.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "  exact content, leading/trailing space  " } }] }),
        { status: 200, headers: { "x-request-id": "req-abc-123" } }
      );
    }) as typeof fetch;

    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    const result = await executePreparedCallModelRequest(prepared, { fetchImpl });

    check("fetch was called with the prepared url", capturedUrl === prepared.url);
    check(
      "the exact body sent to fetch === prepared.rawRequestBody",
      capturedInit?.body === prepared.rawRequestBody
    );
    check(
      "content is returned exactly, untrimmed (no reconstruction)",
      result.content === "  exact content, leading/trailing space  "
    );
    check("providerRequestId captured from x-request-id header", result.providerRequestId === "req-abc-123");
    check("httpStatus captured", result.httpStatus === 200);
    check("requestSha256 on the result matches the prepared hash", result.requestSha256 === prepared.requestSha256);
    check("usedMock is false for a real (fake-fetched) call", result.usedMock === false);
  });

  // Anthropic — different URL/header, different content extraction shape.
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, OPENAI_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic content" }] }), {
        status: 200,
        headers: { "request-id": "anthropic-req-1" },
      })) as typeof fetch;

    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "anthropic" });
    check("prepared.url is the Anthropic endpoint", prepared.url === "https://api.anthropic.com/v1/messages");
    const result = await executePreparedCallModelRequest(prepared, { fetchImpl });
    check("Anthropic content extracted correctly", result.content === "anthropic content");
    check("Anthropic providerRequestId from 'request-id' header", result.providerRequestId === "anthropic-req-1");
  });

  // ======================================================================
  // [3] Single-use handle — a second execute fails BEFORE any HTTP; two
  //     concurrent executes on the same handle: fetch called exactly once.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    let fetchCallCount = 0;
    const fetchImpl = (async () => {
      fetchCallCount += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    const [r1, r2] = await Promise.allSettled([
      executePreparedCallModelRequest(prepared, { fetchImpl }),
      executePreparedCallModelRequest(prepared, { fetchImpl }),
    ]);
    check("fetch was called exactly once across two concurrent executes", fetchCallCount === 1);
    const fulfilledCount = [r1, r2].filter((r) => r.status === "fulfilled").length;
    const rejectedCount = [r1, r2].filter((r) => r.status === "rejected").length;
    check("exactly one of the two concurrent executes fulfilled", fulfilledCount === 1);
    check("exactly one of the two concurrent executes rejected (single-use)", rejectedCount === 1);
    const rejected = [r1, r2].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    check(
      "the rejected execute failed with a fixed local error, not a network error",
      !!rejected && rejected.reason instanceof Error && /already been executed/.test(rejected.reason.message)
    );

    // A genuinely SECOND, sequential execute after the first has settled
    // must also fail before any further HTTP call.
    const before = fetchCallCount;
    let threwOnReplay = false;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch {
      threwOnReplay = true;
    }
    check("a sequential replay execute on the same handle also throws", threwOnReplay);
    check("the replay never called fetch again", fetchCallCount === before);
  });

  // ======================================================================
  // [4] Abort / signal.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const fetchImpl = (async () => {
      throw abortError;
    }) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl, signal: new AbortController().signal });
    } catch (e) {
      caught = e;
    }
    check("abort produces a CallModelFailure", caught instanceof CallModelFailure);
    check(
      "abort's reason is exactly 'aborted', never 'network_error'",
      caught instanceof CallModelFailure && caught.reason === "aborted"
    );
  });

  // ======================================================================
  // [5] network_error (fetch rejects, not an AbortError).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e;
    }
    check(
      "a plain fetch rejection produces reason 'network_error'",
      caught instanceof CallModelFailure && caught.reason === "network_error"
    );
  });

  // ======================================================================
  // [6] HTTP non-2xx.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () =>
      new Response(`{"error":"${SECRET_MARKER}"}`, { status: 500 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e;
    }
    check("non-2xx produces reason 'http_error'", caught instanceof CallModelFailure && caught.reason === "http_error");
    check("http_error carries the real httpStatus", caught instanceof CallModelFailure && caught.httpStatus === 500);
  });

  // ======================================================================
  // [7] Malformed provider envelope (non-JSON body).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () => new Response(`not json at all ${SECRET_MARKER}`, { status: 200 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e;
    }
    check(
      "a non-JSON response body produces reason 'malformed_response'",
      caught instanceof CallModelFailure && caught.reason === "malformed_response"
    );
  });

  // ======================================================================
  // [8] Empty content (well-formed JSON, no usable text).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e;
    }
    check(
      "whitespace-only content produces reason 'empty_content'",
      caught instanceof CallModelFailure && caught.reason === "empty_content"
    );
  });

  // ======================================================================
  // [9] No secret/body leakage in CallModelFailure — message, stack,
  //     JSON.stringify, enumerable properties.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () => new Response(`{"error":"${SECRET_MARKER}"}`, { status: 503 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: CallModelFailure | undefined;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e as CallModelFailure;
    }
    check("a CallModelFailure was thrown", caught instanceof CallModelFailure);
    if (caught) {
      check("SECRET marker absent from .message", !caught.message.includes(SECRET_MARKER));
      check("SECRET marker absent from .stack", !(caught.stack ?? "").includes(SECRET_MARKER));
      check("SECRET marker absent from JSON.stringify(error)", !JSON.stringify(caught).includes(SECRET_MARKER));
      check(
        "only safe fields (plus the standard Error 'name') are enumerable on the failure -- never a body/content field",
        Object.keys(caught).every((k) =>
          ["reason", "httpStatus", "providerRequestId", "latencyMs", "requestSha256", "name"].includes(k)
        )
      );
      check("the API key never appears in .message/.stack/JSON.stringify",
        !caught.message.includes(FAKE_OPENAI_KEY) &&
        !(caught.stack ?? "").includes(FAKE_OPENAI_KEY) &&
        !JSON.stringify(caught).includes(FAKE_OPENAI_KEY)
      );
      check(
        "reason is one of the five bounded values",
        (["network_error", "aborted", "http_error", "malformed_response", "empty_content"] as CallModelFailureReason[]).includes(caught.reason)
      );
    }
  });

  // ======================================================================
  // [10] callModel(input) wrapper — mock strictly unchanged.
  // ======================================================================
  {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await callModel({
      system: "s",
      user: "u",
      provider: "mock",
      mockResponse: "the exact mock content",
      fetchImpl,
    });
    check("mock content returned verbatim", result.content === "the exact mock content");
    check("mock usedMock is true", result.usedMock === true);
    check("mock latencyMs is exactly 0", result.latencyMs === 0);
    check("mock provider/model reported as 'mock'", result.provider === "mock" && result.model === "mock");
    check("mock never calls fetchImpl", fetchCalled === false);
    check("mock's new additive fields are null, never fabricated", result.requestSha256 === null && result.providerRequestId === null && result.httpStatus === null);
  }

  // ======================================================================
  // [11] callModel(input) wrapper — real path chains prepare+execute
  //      transparently for every existing (legacy) caller.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    let capturedBody: BodyInit | null | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ choices: [{ message: { content: "chained content" } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await callModel({ system: "s", user: "u", provider: "openai", fetchImpl });
    const expectedPrepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    check("callModel's real path returns the exact provider content", result.content === "chained content");
    check(
      "callModel's real path sends the same exact body prepareCallModelRequest would produce for the same input",
      capturedBody === expectedPrepared.rawRequestBody
    );
  });

  // ======================================================================
  // [12] Legacy repair (parse-json-or-retry.ts) — exactly two real calls
  //      when a repair is needed; the second (repaired) content is
  //      accepted. Uses the new fetchImpl injection so both calls are
  //      real `callModel` executions, never mock, distinguished only by
  //      a call counter on the injected fetchImpl.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "not valid json for the schema" } }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const schema = z.object({ ok: z.literal(true) });
    const originalCall = { system: "s", user: "u", provider: "openai" as const, fetchImpl };
    const initial = await callModel(originalCall);
    const parsed = await parseJsonOrRetry({ schema, rawOutput: initial.content, originalCall });

    check("exactly two real callModel executions occurred (initial + repair)", callCount === 2);
    check("the repair-round-trip's corrected content is accepted", parsed.ok === true);
    check("usedRetry is true when a repair was needed", parsed.ok && parsed.usedRetry === true);
  });

  // ======================================================================
  // [13] Hardening — Object.freeze, mutation-after-prepare, forged/cloned
  //      handle rejection (spread, structuredClone, JSON round-trip).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });

    check("prepared is frozen (Object.isFrozen)", Object.isFrozen(prepared));

    const originalBody = prepared.rawRequestBody;
    const originalHash = prepared.requestSha256;
    const originalUrl = prepared.url;
    const originalModel = prepared.model;
    const originalProvider = prepared.provider;

    // In strict mode (ESM), assigning to a frozen object's property throws.
    // Whether it throws or is silently ignored, the value must never
    // actually change -- assert the value, not just the throw.
    let mutationThrew = false;
    try {
      (prepared as { rawRequestBody: string }).rawRequestBody = "TAMPERED";
    } catch {
      mutationThrew = true;
    }
    check("mutating rawRequestBody throws (strict mode, frozen object)", mutationThrew);
    check("rawRequestBody is unchanged after the mutation attempt", prepared.rawRequestBody === originalBody);

    try {
      (prepared as { requestSha256: string }).requestSha256 = "0".repeat(64);
    } catch {
      /* expected */
    }
    try {
      (prepared as { url: string }).url = "https://evil.example/";
    } catch {
      /* expected */
    }
    try {
      (prepared as { model: string }).model = "tampered-model";
    } catch {
      /* expected */
    }
    try {
      (prepared as { provider: string }).provider = "anthropic";
    } catch {
      /* expected */
    }
    check("requestSha256 is unchanged after the mutation attempt", prepared.requestSha256 === originalHash);
    check("url is unchanged after the mutation attempt", prepared.url === originalUrl);
    check("model is unchanged after the mutation attempt", prepared.model === originalModel);
    check("provider is unchanged after the mutation attempt", prepared.provider === originalProvider);

    // Execute AFTER the mutation attempts above -- must still send the
    // ORIGINAL body/hash, proving execute reads the untampered snapshot.
    let capturedBody: BodyInit | null | undefined;
    let fetchCallCount = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      fetchCallCount += 1;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await executePreparedCallModelRequest(prepared, { fetchImpl });
    check("post-tampering-attempt execute still sends the ORIGINAL rawRequestBody", capturedBody === originalBody);
    check("post-tampering-attempt execute's result carries the ORIGINAL requestSha256", result.requestSha256 === originalHash);

    // Forged object: same shape/values, but never returned by
    // prepareCallModelRequest -- must be rejected before any fetch.
    const forged = { ...prepared };
    let forgedThrew = false;
    const forgedFetchImpl = (async () => {
      throw new Error("fetch should never be called for a forged handle");
    }) as typeof fetch;
    try {
      await executePreparedCallModelRequest(forged as PreparedCallModelRequest, { fetchImpl: forgedFetchImpl });
    } catch (e) {
      forgedThrew = e instanceof Error && /unknown prepared request/.test(e.message);
    }
    check("a forged object ({...prepared}) is rejected before any fetch", forgedThrew);

    // structuredClone: a genuinely new, unfrozen object with the same
    // own-property values -- also rejected, since the WeakMap keys by
    // identity, never by value.
    const cloned = structuredClone(prepared);
    let clonedThrew = false;
    try {
      await executePreparedCallModelRequest(cloned as PreparedCallModelRequest, { fetchImpl: forgedFetchImpl });
    } catch (e) {
      clonedThrew = e instanceof Error && /unknown prepared request/.test(e.message);
    }
    check("structuredClone(prepared) is rejected before any fetch", clonedThrew);

    // JSON.parse(JSON.stringify(prepared)) -- same reasoning.
    const jsonRoundTripped = JSON.parse(JSON.stringify(prepared));
    let jsonThrew = false;
    try {
      await executePreparedCallModelRequest(jsonRoundTripped as PreparedCallModelRequest, { fetchImpl: forgedFetchImpl });
    } catch (e) {
      jsonThrew = e instanceof Error && /unknown prepared request/.test(e.message);
    }
    check("JSON.parse(JSON.stringify(prepared)) is rejected before any fetch", jsonThrew);
  });

  // ======================================================================
  // [14] Handle stays consumed after EVERY failure type -- a second
  //      execute after any failure fails locally, never repeats fetch.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const scenarios: Array<{ name: string; fetchImpl: typeof fetch }> = [
      {
        name: "http_error",
        fetchImpl: (async () => new Response("err", { status: 500 })) as typeof fetch,
      },
      {
        name: "malformed_response",
        fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
      },
      {
        name: "empty_content",
        fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as typeof fetch,
      },
      {
        name: "network_error",
        fetchImpl: (async () => {
          throw new Error("ECONNRESET");
        }) as typeof fetch,
      },
      {
        name: "aborted",
        fetchImpl: (async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }) as typeof fetch,
      },
    ];

    for (const scenario of scenarios) {
      let callCount = 0;
      const countingFetch = (async (...args: Parameters<typeof fetch>) => {
        callCount += 1;
        return scenario.fetchImpl(...args);
      }) as typeof fetch;
      const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
      let firstCaught: unknown;
      try {
        await executePreparedCallModelRequest(prepared, { fetchImpl: countingFetch });
      } catch (e) {
        firstCaught = e;
      }
      check(`[${scenario.name}] the first execute fails as expected`, firstCaught instanceof CallModelFailure || firstCaught instanceof Error);
      const callCountAfterFirst = callCount;

      let secondCaught: unknown;
      try {
        await executePreparedCallModelRequest(prepared, { fetchImpl: countingFetch });
      } catch (e) {
        secondCaught = e;
      }
      check(
        `[${scenario.name}] a second execute on the same handle fails locally with the fixed 'already executed' error`,
        secondCaught instanceof Error && /already been executed/.test(secondCaught.message)
      );
      check(`[${scenario.name}] the second execute never called fetch again`, callCount === callCountAfterFirst);
    }
  });

  // ======================================================================
  // [15] contentSha256 -- both providers.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "  exact openai content  " } }] }), { status: 200 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    const result = await executePreparedCallModelRequest(prepared, { fetchImpl });
    check(
      "OpenAI: contentSha256 matches sha256Hex(content) on the exact, untrimmed content",
      result.contentSha256 === sha256Hex(result.content) && result.content === "  exact openai content  "
    );
  });
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, OPENAI_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "  exact anthropic content  " }] }), { status: 200 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "anthropic" });
    const result = await executePreparedCallModelRequest(prepared, { fetchImpl });
    check(
      "Anthropic: contentSha256 matches sha256Hex(content) on the exact, untrimmed content",
      result.contentSha256 === sha256Hex(result.content) && result.content === "  exact anthropic content  "
    );
  });

  // ======================================================================
  // [16] Anthropic — full failure-mode coverage (mirrors OpenAI's).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, OPENAI_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    async function anthropicFailure(fetchImpl: typeof fetch): Promise<unknown> {
      const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "anthropic" });
      try {
        await executePreparedCallModelRequest(prepared, { fetchImpl });
      } catch (e) {
        return e;
      }
      return undefined;
    }

    const httpErr = await anthropicFailure((async () => new Response(`{"e":"${SECRET_MARKER}"}`, { status: 503 })) as typeof fetch);
    check("Anthropic non-2xx -> reason http_error", httpErr instanceof CallModelFailure && httpErr.reason === "http_error" && httpErr.httpStatus === 503);

    const malformedErr = await anthropicFailure((async () => new Response(`not json ${SECRET_MARKER}`, { status: 200 })) as typeof fetch);
    check("Anthropic malformed envelope -> reason malformed_response", malformedErr instanceof CallModelFailure && malformedErr.reason === "malformed_response");

    const emptyErr = await anthropicFailure(
      (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "   " }] }), { status: 200 })) as typeof fetch
    );
    check("Anthropic whitespace-only content -> reason empty_content", emptyErr instanceof CallModelFailure && emptyErr.reason === "empty_content");

    const absentErr = await anthropicFailure((async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch);
    check("Anthropic absent content field -> reason empty_content", absentErr instanceof CallModelFailure && absentErr.reason === "empty_content");

    const abortErr = await anthropicFailure((async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as typeof fetch);
    check("Anthropic AbortError -> reason aborted", abortErr instanceof CallModelFailure && abortErr.reason === "aborted");

    const networkErr = await anthropicFailure((async () => {
      throw new Error(`connect ECONNREFUSED (leaked key ${FAKE_ANTHROPIC_KEY})`);
    }) as typeof fetch);
    check("Anthropic network error -> reason network_error", networkErr instanceof CallModelFailure && networkErr.reason === "network_error");
    check(
      "Anthropic network error: the fake secret embedded in the ORIGINAL error never reaches .message/.stack/JSON.stringify",
      networkErr instanceof CallModelFailure &&
        !networkErr.message.includes(FAKE_ANTHROPIC_KEY) &&
        !(networkErr.stack ?? "").includes(FAKE_ANTHROPIC_KEY) &&
        !JSON.stringify(networkErr).includes(FAKE_ANTHROPIC_KEY)
    );
  });

  // ======================================================================
  // [17] OpenAI — absent content field (distinct from whitespace-only).
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: unknown;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e;
    }
    check("OpenAI absent content field (empty choices[]) -> reason empty_content", caught instanceof CallModelFailure && caught.reason === "empty_content");
  });

  // ======================================================================
  // [18] Error.cause is never set on CallModelFailure -- a network error
  //      whose original message carries a fake secret must not leak it
  //      via .cause either, since .cause bypasses JSON.stringify's
  //      enumerable-property protection on direct property access.
  // ======================================================================
  await withEnvAsync({ ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined }, async () => {
    const fetchImpl = (async () => {
      throw new Error(`DNS lookup failed for host with embedded secret ${FAKE_OPENAI_KEY} and marker ${SECRET_MARKER}`);
    }) as typeof fetch;
    const prepared = prepareCallModelRequest({ system: "s", user: "u", provider: "openai" });
    let caught: CallModelFailure | undefined;
    try {
      await executePreparedCallModelRequest(prepared, { fetchImpl });
    } catch (e) {
      caught = e as CallModelFailure;
    }
    check("a CallModelFailure was thrown for the network error", caught instanceof CallModelFailure);
    check("CallModelFailure.cause is undefined -- the original error is never retained", !!caught && caught.cause === undefined);
    check(
      "neither the fake secret nor the marker from the ORIGINAL error reach .message/.stack/JSON.stringify",
      !!caught &&
        !caught.message.includes(FAKE_OPENAI_KEY) &&
        !caught.message.includes(SECRET_MARKER) &&
        !(caught.stack ?? "").includes(FAKE_OPENAI_KEY) &&
        !(caught.stack ?? "").includes(SECRET_MARKER) &&
        !JSON.stringify(caught).includes(FAKE_OPENAI_KEY) &&
        !JSON.stringify(caught).includes(SECRET_MARKER)
    );
  });

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-adjacent call-model contract PASSED." : "call-model contract FAILED.")
  );
  console.log("\nNo real network call was made anywhere in this test.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
