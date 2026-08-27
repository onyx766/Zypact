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
import { memoryAdapter } from "@/lib/db/memory-adapter";
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
  // L1 — restore the ambient value exactly, including its absence.
  const priorApiKey = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "test-key-never-persisted";
  try {
    await run();
  } finally {
    if (priorApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = priorApiKey;
  }
}

async function run(): Promise<void> {

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
  // L2 — a direct three-way byte equality: what the fetcher received,
  // what the adapter returned, and what the persistence layer is handed.
  // The former assertion here was a disjunction that held either way.
  const persistedFromSuccess = { fullRequestBody: res.fullRequestBody };
  check(
    "unicode: captured === returned === handed to the adapter, byte for byte",
    cap.body === res.fullRequestBody &&
      res.fullRequestBody === persistedFromSuccess.fullRequestBody &&
      sha256Hex(persistedFromSuccess.fullRequestBody as string) === res.fullRequestBodySha256
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
  // The only privilege statements 0055 may contain concern the hash
  // helper: EXECUTE to service_role, and re-asserted revocations for
  // PUBLIC/anon/authenticated. Comments are stripped first, so a word
  // like "grant" in prose can never satisfy or defeat these assertions.
  const sqlCode = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const grants = sqlCode.match(/^\s*grant\b[^;]*;/gim) || [];
  const revokes = sqlCode.match(/^\s*revoke\b[^;]*;/gim) || [];
  check(
    "sql: every GRANT targets _sha256_hex and only service_role",
    grants.length === 1 &&
      /grant execute on function public\._sha256_hex\(text\) to service_role;/.test(grants[0])
  );
  check(
    "sql: every REVOKE targets _sha256_hex and only public/anon/authenticated",
    revokes.length === 3 &&
      revokes.every((r) => /_sha256_hex\(text\) from (public|anon|authenticated);/.test(r))
  );
  check(
    "sql: no privilege is widened on any table or M4/M5 object",
    !grants.some((g) => !/_sha256_hex/.test(g)) && !revokes.some((r) => !/_sha256_hex/.test(r))
  );
  check(
    "sql: no constraint is dropped or weakened",
    !/drop\s+constraint/i.test(sql) && !/drop\s+column/i.test(sql) && !/drop\s+table/i.test(sql)
  );

  // 0055 is M1-A, not the M4 cutover. The cutover takes the next free
  // number and is neither performed nor authorized here.
  check(
    "sql: 0055 performs no M4 cutover — no REVOKE touches an M4 object",
    !revokes.some((r) => /admit_and_reserve_attempt|\bstart_attempt\b|reconcile_attempt|protocol_/.test(r))
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


  // ------------------------------------------------------------------
  // 10. H1 — a non-JSON 2xx body fails with evidence, not a SyntaxError
  // ------------------------------------------------------------------
  const capBad: { body?: string } = {};
  const notJson = "<html>upstream proxy error</html>";
  let badJson: PerplexityProbeFailure | null = null;
  let rawThrow: unknown = null;
  try {
    await runPerplexityProbe({
      prompt: UNICODE_PROMPT,
      brandName: "Zypact",
      fetchImpl: (async (_u: unknown, init: unknown) => {
        capBad.body = (init as { body: string }).body;
        return {
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === "x-request-id" ? "req-42" : null) },
          text: async () => notJson,
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
  } catch (e) {
    if (e instanceof PerplexityProbeFailure) badJson = e;
    else rawThrow = e;
  }
  check("h1: a non-JSON 2xx body raises PerplexityProbeFailure, not a bare SyntaxError", badJson !== null && rawThrow === null);
  check("h1: it names invalid_json", (badJson?.message ?? "").includes("invalid_json"));
  check("h1: the exact request body survives", badJson?.fullRequestBody === capBad.body);
  check("h1: its hash matches", badJson?.fullRequestBodySha256 === sha256Hex(capBad.body as string));
  check("h1: the raw response bytes survive", badJson?.errorBody === notJson);
  check("h1: the response hash matches", badJson?.errorBodySha256 === sha256Hex(notJson));
  check("h1: status, latency and request id survive", badJson?.httpStatus === 200 && typeof badJson?.latencyMs === "number" && badJson?.providerRequestId === "req-42");

  // H1 — and it reaches the real persistence path, through the memory adapter.
  {
    const project = await memoryAdapter.createProject({
      domain: "m1a.test",
      companyName: "Zypact",
      userId: null,
    });
    const run = await memoryAdapter.createProbeRun(project.id, "perplexity", "live_perplexity");
    const row = await memoryAdapter.recordProbeFailure({
      probeRunId: run.id,
      projectId: project.id,
      platform: "perplexity",
      prompt: UNICODE_PROMPT,
      failureReason: badJson?.reason ?? "empty_answer",
      providerHttpStatus: badJson?.httpStatus ?? null,
      providerErrorBody: badJson?.errorBody ?? null,
      providerErrorBodySha256: badJson?.errorBodySha256 ?? null,
      providerLatencyMs: badJson?.latencyMs ?? null,
      providerRequestId: badJson?.providerRequestId ?? null,
      rawProbeRequestSha256: badJson?.rawProbeRequestSha256 ?? null,
      fullRequestBody: badJson?.fullRequestBody ?? null,
      fullRequestBodySha256: badJson?.fullRequestBodySha256 ?? null,
      retryCount: 0,
    });
    check(
      "h1: the persisted failure row carries the exact request body",
      row.fullRequestBody === capBad.body
    );
    check(
      "h1: the persisted hash matches the persisted body",
      row.fullRequestBodySha256 === sha256Hex(row.fullRequestBody as string)
    );
    check(
      "h1: request evidence and response evidence stay in separate columns",
      row.fullRequestBody !== row.providerErrorBody
    );
  }

  // ------------------------------------------------------------------
  // 11. M2 — a mock can never fabricate provider evidence
  // ------------------------------------------------------------------
  const forged = await runPerplexityProbe({
    prompt: "peu importe",
    brandName: "Zypact",
    mockResponse: {
      prompt: "peu importe",
      answer: "réponse simulée",
      rawResponse: "réponse simulée",
      citations: [],
      searchResults: [],
      sourceCitations: [],
      model: "mock",
      usedMock: true,
      fullRequestBody: '{"forged":true}',
      fullRequestBodySha256: sha256Hex('{"forged":true}'),
    },
  });
  check("m2: a mock fixture cannot smuggle in a forged request body", forged.fullRequestBody === undefined);
  check("m2: nor a forged hash", forged.fullRequestBodySha256 === undefined);
  check("m2: the mock is still marked as one", forged.usedMock === true);

  // ------------------------------------------------------------------
  // 12. B1 — the migration grants EXECUTE narrowly
  // ------------------------------------------------------------------
  check(
    "b1: _sha256_hex EXECUTE is granted to service_role",
    /grant execute on function public\._sha256_hex\(text\) to service_role;/.test(sql)
  );
  for (const role of ["public", "anon", "authenticated"]) {
    check(
      `b1: _sha256_hex stays revoked from ${role}`,
      new RegExp(`revoke all on function public\\._sha256_hex\\(text\\) from ${role};`).test(sql)
    );
    check(
      `b1: no EXECUTE is granted to ${role}`,
      // The single GRANT names service_role as its grantee. Matching on
      // the grantee clause only, so that "public." in the qualified
      // function name cannot be mistaken for the PUBLIC role.
      !grants.some((g) => new RegExp("to\\s+" + role + "\\s*;").test(g))
    );
  }
  check(
    "b1: the SQL hash validation is still present, not traded away for the grant",
    sql.includes("full_request_body_sha256 = public._sha256_hex(full_request_body)")
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
