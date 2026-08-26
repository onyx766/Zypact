#!/usr/bin/env tsx
/**
 * D-027 (B0.2A-1) — static + unit test for the M5, network-free parser
 * (lib/pipeline/parse-analysis-content.ts) and its shared pure helper
 * (lib/llm/parse-model-json.ts).
 *
 * No network, no Docker, no migration, no adapter, no worker.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseAnalysisContentOnce } from "../lib/pipeline/parse-analysis-content";
import { tryParseModelJson } from "../lib/llm/parse-model-json";

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

const schema = z.object({ verdict: z.enum(["won", "lost"]), note: z.string() });

async function main(): Promise<void> {
  // ======================================================================
  // [1] Static: parse-analysis-content.ts imports nothing network-capable.
  // ======================================================================
  const parseAnalysisContentSrc = readFileSync(
    path.join(process.cwd(), "lib/pipeline/parse-analysis-content.ts"),
    "utf8"
  );
  check(
    "parse-analysis-content.ts does not import ./call-model or @/lib/llm/call-model",
    !/from\s+["'][^"']*call-model["']/.test(parseAnalysisContentSrc)
  );
  check(
    "parse-analysis-content.ts does not import parse-json-or-retry",
    !/from\s+["'][^"']*parse-json-or-retry["']/.test(parseAnalysisContentSrc)
  );
  check(
    "parse-analysis-content.ts contains no literal 'fetch(' call",
    !/\bfetch\s*\(/.test(parseAnalysisContentSrc)
  );

  const parseModelJsonSrc = readFileSync(path.join(process.cwd(), "lib/llm/parse-model-json.ts"), "utf8");
  check(
    "parse-model-json.ts (the shared pure helper) also imports nothing network-capable",
    !/from\s+["'][^"']*call-model["']/.test(parseModelJsonSrc) && !/\bfetch\s*\(/.test(parseModelJsonSrc)
  );

  // ======================================================================
  // [2] Success.
  // ======================================================================
  {
    const raw = JSON.stringify({ verdict: "won", note: "clean" });
    const result = parseAnalysisContentOnce(raw, schema);
    check("valid content parses to ok:true", result.ok === true);
    check("parsed data matches exactly", result.ok && result.data.verdict === "won" && result.data.note === "clean");
  }

  // ======================================================================
  // [3] The three bounded codes, exactly.
  // ======================================================================
  {
    const result = parseAnalysisContentOnce("not json at all {{{", schema);
    check("non-JSON content -> code invalid_json", !result.ok && result.code === "invalid_json");
  }
  {
    const raw = JSON.stringify({ verdict: "maybe", note: 123 });
    const result = parseAnalysisContentOnce(raw, schema);
    check("well-formed JSON, wrong shape -> code schema_validation_failed", !result.ok && result.code === "schema_validation_failed");
  }
  {
    const raw = JSON.stringify({ verdict: "won", note: "x" });
    const result = parseAnalysisContentOnce(raw, schema, () => {
      throw new Error("preNormalize deliberately threw for this test");
    });
    check("preNormalize throwing -> code normalization_failed, never an uncaught exception", !result.ok && result.code === "normalization_failed");
  }

  // ======================================================================
  // [4] No raw/free-text data anywhere in the M5 result shape.
  // ======================================================================
  {
    const raw = "not json at all {{{ SECRET_MODEL_CONTENT_MARKER";
    const result = parseAnalysisContentOnce(raw, schema);
    check("failure result has no 'error'/'detail'/'rawOutput' field at all", !result.ok && !("error" in result) && !("detail" in result) && !("rawOutput" in result));
    check(
      "the raw content marker never appears anywhere in JSON.stringify(result)",
      !JSON.stringify(result).includes("SECRET_MODEL_CONTENT_MARKER")
    );
    check(
      "the result object has exactly {ok, code} on failure -- no extra surface",
      !result.ok && Object.keys(result).sort().join(",") === "code,ok"
    );
  }

  // ======================================================================
  // [4b] Dynamic (runtime) proof, not just static text analysis: monkey-
  //      patch globalThis.fetch to throw if ever invoked, then run every
  //      code path (success, and all three failure codes) and confirm
  //      the patched fetch was never called.
  // ======================================================================
  {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch must never be called by the M5 parser");
    }) as typeof fetch;
    try {
      parseAnalysisContentOnce(JSON.stringify({ verdict: "won", note: "x" }), schema);
      parseAnalysisContentOnce("not json {{{", schema);
      parseAnalysisContentOnce(JSON.stringify({ verdict: "bad", note: 1 }), schema);
      parseAnalysisContentOnce(JSON.stringify({ verdict: "won", note: "x" }), schema, () => {
        throw new Error("boom");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    check("globalThis.fetch was never invoked across every parseAnalysisContentOnce code path", !fetchCalled);
  }

  // ======================================================================
  // [5] Shared helper (parse-model-json.ts) still exposes the free-text
  //     detail for the LEGACY caller (parse-json-or-retry.ts) to build
  //     its repair prompt -- confirms the M5 wrapper is the one doing
  //     the discarding, not the shared helper itself.
  // ======================================================================
  {
    const result = tryParseModelJson("not json {{{", schema);
    check(
      "the shared pure helper still exposes a free-text detail (consumed only by the legacy path)",
      !result.ok && typeof result.detail === "string" && result.detail.length > 0
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 parse-analysis-content contract PASSED." : "parse-analysis-content contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
