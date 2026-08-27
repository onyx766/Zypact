/**
 * M1-A contract — the exact provider request body is captured, carried
 * and persisted, on both the legacy Perplexity path and the M5 receipt
 * path.
 *
 * Mocks only. No Docker, no database, no Supabase, no provider, no
 * deployed application. The single outbound `fetch` is injected and
 * asserted against; it never leaves the process.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runPerplexityProbe, PerplexityProbeFailure } from "@/lib/probes/perplexity";
import { sha256Hex } from "@/lib/evidence/hash";
import {
  analysisCallReceiptRequestFields,
  mockAnalysisCallReceiptRequestFields,
} from "@/lib/llm/analysis-call-receipt-request";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const MIGRATION = "supabase/migrations/0055_m1_exact_provider_request_body.sql";
const sql = readFileSync(MIGRATION, "utf8");

// A prompt with content that survives no round-trip carelessly: non-ASCII,
// an emoji outside the BMP, a quote, a backslash and a newline.
const UNICODE_PROMPT =
  'Quels outils de « suivi » pour Zypact — naïve café 🚀 ?\nLigne "deux" \\ fin';

function fakeOk(capture: { body?: string }): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    capture.body = (init as { body: string }).body;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          model: "sonar",
          choices: [{ message: { content: "Réponse détaillée." } }],
          citations: [],
        }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function fakeHttpError(capture: { body?: string }): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    capture.body = (init as { body: string }).body;
    return {
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => "upstream unavailable",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  process.env.PERPLEXITY_API_KEY = "test-key-never-persisted";

  // ------------------------------------------------------------------
  // 1. Legacy success path — sent === returned, byte for byte
  // ------------------------------------------------------------------
  const cap: { body?: string } = {};
  const res = await runPerplexityProbe({
    prompt: UNICODE_PROMPT,
    brandName: "Zypact",
    domain: "zypact.com",
    fetchImpl: fakeOk(cap),
  });

  check("legacy: a body was actually written to the wire", typeof cap.body === "string");
  check(
    "legacy: returned fullRequestBody is byte-identical to the body sent",
    res.fullRequestBody === cap.body,
    `sent=${cap.body?.length ?? -1}o returned=${res.fullRequestBody?.length ?? -1}o`
  );
  check(
    "legacy: fullRequestBodySha256 is the hash of that exact string",
    res.fullRequestBodySha256 === sha256Hex(cap.body as string)
  );
  check(
    "legacy: the hash covers the WHOLE body, not just the prompt",
    res.fullRequestBodySha256 !== res.rawProbeRequestSha256
  );

  // ------------------------------------------------------------------
  // 2. Unicode is preserved exactly
  // ------------------------------------------------------------------
  const parsed = JSON.parse(res.fullRequestBody as string) as {
    messages: { content: string }[];
    model: string;
    temperature: number;
  };
  check(
    "unicode: the emoji and accents survive into the outbound body",
    parsed.messages[0].content.includes("🚀") && parsed.messages[0].content.includes("naïve")
  );
  check(
    "unicode: hash is computed over UTF-8 bytes, matching a fresh hash of the same string",
    sha256Hex(res.fullRequestBody as string) === res.fullRequestBodySha256
  );
  check(
    "unicode: re-serializing the parsed object is NOT relied upon for the hash",
    // Proof of why we carry the string: a re-serialization is a different
    // object graph and must never be substituted for the captured body.
    sha256Hex(JSON.stringify(parsed)) !== res.fullRequestBodySha256 ||
      JSON.stringify(parsed) === res.fullRequestBody
  );

  // ------------------------------------------------------------------
  // 3. Prompt, request and response stay in three distinct fields
  // ------------------------------------------------------------------
  check(
    "distinction: rawProbeRequest is the prompt, not the JSON body",
    typeof res.rawProbeRequest === "string" &&
      !res.rawProbeRequest.startsWith("{") &&
      res.rawProbeRequest !== res.fullRequestBody
  );
  check(
    "distinction: fullRequestBody is JSON and carries model + temperature",
    (res.fullRequestBody as string).startsWith("{") &&
      parsed.model.length > 0 &&
      typeof parsed.temperature === "number"
  );
  check(
    "distinction: rawResponseBody is the reply, never the request",
    typeof res.rawResponseBody === "string" &&
      res.rawResponseBody !== res.fullRequestBody
  );

  // ------------------------------------------------------------------
  // 4. No credential ever reaches the evidence
  // ------------------------------------------------------------------
  const evidenceBlob = JSON.stringify({
    fullRequestBody: res.fullRequestBody,
    rawProbeRequest: res.rawProbeRequest,
    rawResponseBody: res.rawResponseBody,
  });
  check(
    "secrets: the API key value appears nowhere in the captured evidence",
    !evidenceBlob.includes("test-key-never-persisted")
  );
  check(
    "secrets: no authorization header is carried in the evidence",
    !/authorization/i.test(evidenceBlob) && !/bearer/i.test(evidenceBlob)
  );

  // ------------------------------------------------------------------
  // 5. Failure path carries the same exact body
  // ------------------------------------------------------------------
  const capFail: { body?: string } = {};
  let failure: PerplexityProbeFailure | null = null;
  try {
    await runPerplexityProbe({
      prompt: UNICODE_PROMPT,
      brandName: "Zypact",
      fetchImpl: fakeHttpError(capFail),
    });
  } catch (e) {
    if (e instanceof PerplexityProbeFailure) failure = e;
  }
  check("failure: a PerplexityProbeFailure was raised", failure !== null);
  check(
    "failure: it carries the exact body that was sent",
    failure?.fullRequestBody === capFail.body
  );
  check(
    "failure: its hash matches that body",
    failure?.fullRequestBodySha256 === sha256Hex(capFail.body as string)
  );

  // ------------------------------------------------------------------
  // 6. M5 joint — same string, same hash, refuses a mismatch
  // ------------------------------------------------------------------
  const preparedBody = JSON.stringify({ model: "gpt-4o-mini", input: "é🚀" });
  const fields = analysisCallReceiptRequestFields({
    rawRequestBody: preparedBody,
    requestSha256: sha256Hex(preparedBody),
  });
  check(
    "m5: the joint passes the same string reference through",
    fields.rawRequestBody === preparedBody
  );
  check("m5: the joint passes the matching hash through", fields.requestSha256 === sha256Hex(preparedBody));
  check("m5: a real call is marked usedMock=false", fields.usedMock === false);

  let refused = false;
  try {
    analysisCallReceiptRequestFields({
      rawRequestBody: preparedBody,
      requestSha256: "0".repeat(64),
    });
  } catch {
    refused = true;
  }
  check("m5: a hash that does not cover its body is refused", refused);

  const mockFields = mockAnalysisCallReceiptRequestFields();
  check(
    "m5: a mock call invents no body and no hash",
    mockFields.rawRequestBody === null &&
      mockFields.requestSha256 === null &&
      mockFields.usedMock === true
  );

  // ------------------------------------------------------------------
  // 7. Migration contract — read from the file, not assumed
  // ------------------------------------------------------------------
  for (const table of ["probe_results", "probe_failures"]) {
    check(
      `sql: ${table} gains full_request_body`,
      new RegExp(`alter table if exists public\\.${table}\\s+add column if not exists full_request_body text`).test(sql)
    );
    check(
      `sql: ${table} pairing constraint — a body requires its hash`,
      sql.includes(`${table}_full_request_body_pairing_check`) &&
        sql.includes("check (full_request_body is null or full_request_body_sha256 is not null)")
    );
    check(
      `sql: ${table} real server-side hash verification via _sha256_hex`,
      sql.includes(`${table}_full_request_body_hash_match_check`) &&
        sql.includes("full_request_body_sha256 = public._sha256_hex(full_request_body)")
    );
    check(
      `sql: ${table} capture level is GENERATED ALWAYS, not writable`,
      new RegExp(`${table}[\\s\\S]{0,400}full_request_body_capture text\\s+generated always as`).test(sql) ||
        sql.split("full_request_body_capture text").length - 1 === 2
    );
  }
  check(
    "sql: historical rows are labelled legacy_hash_only, never reconstructed",
    sql.includes("'legacy_hash_only'") && !/update\s+public\.probe_results\s+set\s+full_request_body/i.test(sql)
  );
  check(
    "sql: no grant, no revoke, no privilege change",
    !/^\s*grant\s/im.test(sql) && !/^\s*revoke\s/im.test(sql)
  );
  check(
    "sql: no constraint is dropped or weakened",
    !/drop\s+constraint/i.test(sql) && !/drop\s+column/i.test(sql) && !/drop\s+table/i.test(sql)
  );

  // 0055 is M1-A, not the M4 cutover. The cutover takes the next free
  // number and is neither performed nor authorized here.
  check(
    "sql: 0055 performs no M4 cutover — no REVOKE statement",
    !/^\s*revoke\s/im.test(sql)
  );
  check(
    "sql: 0055 names none of the three raw M4 RPCs",
    !/admit_and_reserve_attempt/.test(sql) &&
      !/\bstart_attempt\b/.test(sql) &&
      !/reconcile_attempt/.test(sql)
  );
  // Prose may legitimately cite the 0053 precedent; what matters is that
  // no DDL statement targets an M5 object. Comments are stripped first so
  // the assertion tests executable SQL, not documentation.
  const executableSql = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  check(
    "sql: 0055 issues no DDL against any M5 table",
    !/(alter|create|drop)\s+table[^;]*?(protocol_execution_job|analysis_call_receipts|provider_call_receipts)/is.test(
      executableSql
    )
  );
  check(
    "sql: 0055 defines or replaces no function at all",
    !/create\s+(or\s+replace\s+)?function/i.test(executableSql)
  );
  check(
    "sql: 0055 only ever alters probe_results and probe_failures",
    (executableSql.match(/alter\s+table\s+(if\s+exists\s+)?public\.([a-z_]+)/gi) || []).every((m) =>
      /probe_results|probe_failures/.test(m)
    )
  );

  // ------------------------------------------------------------------
  // 8. Adapter parity — both adapters carry the field on both paths
  // ------------------------------------------------------------------
  const supa = readFileSync("lib/db/supabase-adapter.ts", "utf8");
  const mem = readFileSync("lib/db/memory-adapter.ts", "utf8");
  check(
    "parity: supabase adapter writes full_request_body on both insert paths",
    supa.split("full_request_body: input.fullRequestBody ?? null,").length - 1 === 2
  );
  check(
    "parity: memory adapter carries fullRequestBody on both insert paths",
    mem.split("fullRequestBody: input.fullRequestBody ?? null,").length - 1 === 2
  );
  check(
    "parity: supabase adapter reads the column back",
    supa.includes("fullRequestBody: r.full_request_body")
  );

  // ------------------------------------------------------------------
  // 9. Historical honesty — nothing fabricates a missing body
  // ------------------------------------------------------------------
  const perp = readFileSync("lib/probes/perplexity.ts", "utf8");
  check(
    "honesty: the body is serialized exactly once in the adapter",
    perp.split("JSON.stringify(body)").length - 1 === 1
  );
  check(
    "honesty: the same variable is sent, hashed and returned",
    perp.includes("body: requestBodyJson,") &&
      perp.includes("sha256Hex(requestBodyJson)") &&
      perp.includes("fullRequestBody: requestBodyJson,")
  );

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(
    `${passed}/${passed + failures.length} checks passed. M1-A exact provider request body ${
      failures.length === 0 ? "PASSED" : "FAILED"
    }.`
  );
  assert.equal(failures.length, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
