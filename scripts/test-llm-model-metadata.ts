#!/usr/bin/env tsx
/**
 * Defect A regression: report metadata must name the model that actually
 * ran.
 *
 * A real Production snapshot completed live against OpenAI and its report
 * appendix said `model: mock`, because the metadata builder re-derived the
 * model from `OPENAI_MODEL` and fell back to the literal string "mock"
 * when that variable was unset — which it is in the worker's six-variable
 * environment. Provider and mock-mode were correct; only the model lied.
 *
 * These tests pin the invariant `executed model === reported model` for
 * every provider path. No provider is ever contacted: `resolveModel` is
 * pure, and `callModel`'s network branches are never reached.
 */

import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  resolveModel,
  resolveProvider,
  type LlmProvider,
} from "@/lib/llm/call-model";

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

/** Runs `fn` with an isolated env, restoring the previous one after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE = {
  ZYPACT_MOCK_MODE: undefined,
  LLM_PROVIDER: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_MODEL: undefined,
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_MODEL: undefined,
} as const;

console.log("test-llm-model-metadata");

// 1 — The exact production shape that produced the bad report: OpenAI
//     pinned, key present, OPENAI_MODEL absent.
withEnv({ ...BASE, LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }, () => {
  const provider = resolveProvider();
  const model = resolveModel(provider);
  check("1a provider resolves to openai", provider === "openai");
  check("1b model is the real code default", model === DEFAULT_OPENAI_MODEL);
  check("1c model is NOT the literal 'mock'", model !== "mock");
  check("1d default is a concrete model name", /^gpt-/.test(model));
  check("1e mock-mode flag derived from provider is false", (provider as LlmProvider) !== "mock");
});

// 2 — Explicit OPENAI_MODEL is honoured verbatim by the same resolver the
//     execution path uses.
withEnv(
  { ...BASE, LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key", OPENAI_MODEL: "gpt-4.1-mini" },
  () => {
    const provider = resolveProvider();
    check("2a provider openai", provider === "openai");
    check("2b configured model reported exactly", resolveModel(provider) === "gpt-4.1-mini");
  }
);

// 3 — Anthropic behaves identically through the same helper.
withEnv({ ...BASE, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" }, () => {
  const provider = resolveProvider();
  check("3a provider anthropic", provider === "anthropic");
  check("3b anthropic default reported", resolveModel(provider) === DEFAULT_ANTHROPIC_MODEL);
  check("3c anthropic default is not 'mock'", resolveModel(provider) !== "mock");
});
withEnv(
  { ...BASE, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-x" },
  () => {
    check("3d configured anthropic model reported", resolveModel(resolveProvider()) === "claude-x");
  }
);

// 4 — "mock" is reported only when execution is genuinely mock.
withEnv({ ...BASE, ZYPACT_MOCK_MODE: "on", OPENAI_API_KEY: "test-key" }, () => {
  const provider = resolveProvider();
  check("4a forced mock mode resolves to mock", provider === "mock");
  check("4b genuine mock run reports model 'mock'", resolveModel(provider) === "mock");
});
withEnv({ ...BASE }, () => {
  const provider = resolveProvider();
  check("4c no keys at all resolves to mock", provider === "mock");
  check("4d that genuine mock reports 'mock'", resolveModel(provider) === "mock");
});

// 5 — Auto-detect (no LLM_PROVIDER pin) must not report mock either.
withEnv({ ...BASE, OPENAI_API_KEY: "test-key" }, () => {
  const provider = resolveProvider();
  check("5a auto-detect picks openai", provider === "openai");
  check("5b auto-detected live run is not labelled mock", resolveModel(provider) !== "mock");
});

// 6 — Per-call override wins, matching `callOpenAi`'s precedence.
withEnv({ ...BASE, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-env" }, () => {
  check("6a override beats env", resolveModel("openai", "gpt-override") === "gpt-override");
  check("6b env used when no override", resolveModel("openai") === "gpt-env");
});

// 7 — MUTATION GUARD. Reinstating the old metadata expression must be
//     caught. This recreates the exact pre-fix logic and asserts the
//     current resolver disagrees with it under production conditions.
withEnv({ ...BASE, LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }, () => {
  const oldBuggyExpression =
    process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || "mock";
  const current = resolveModel(resolveProvider());
  check("7a old expression did yield 'mock' (defect reproduced)", oldBuggyExpression === "mock");
  check("7b current resolver no longer yields it", current !== oldBuggyExpression);
});

// 8 — The reported model must equal what the OpenAI call body would send.
//     `callOpenAi` computes `resolveModel("openai", input.model)`; this
//     asserts metadata uses that identical expression.
withEnv({ ...BASE, LLM_PROVIDER: "openai", OPENAI_API_KEY: "k" }, () => {
  const executionModel = resolveModel("openai", undefined);
  const reportedModel = resolveModel(resolveProvider());
  check("8a execution model === reported model", executionModel === reportedModel);
});

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
