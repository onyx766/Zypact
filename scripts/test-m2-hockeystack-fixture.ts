#!/usr/bin/env tsx
/**
 * M2 canonical observations contract — HockeyStack golden fixture
 * validation (D-014, D-016).
 *
 * Reads scripts/fixtures/hockeystack-m2-fixture.json read-only and
 * asserts the pre-M1 diagnostic already consigned and approved in
 * D-016: legacy columns present on all 15 rows, M1 evidence/hash/
 * provider-metadata columns absent (never fabricated), no duplication,
 * every probe_result correctly linked to a probe_run.
 *
 * Canonical fixture shape (decided after inspecting the real file —
 * the `[{"fixture": {...}}]` wrapper mentioned earlier came from the
 * SQL export envelope and is not part of the fixture's contract):
 *
 *   {
 *     project: { id, domain, company_name },
 *     probe_runs: [...],
 *     probe_results: [...],
 *     fixture_version: string,
 *     snapshot_request_count: number
 *   }
 *
 * This file never writes to the fixture. It is read once via
 * readFileSync and only ever inspected in memory.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

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

const EXPECTED_PROJECT_ID = "f6289780-b502-4e04-b67b-bd2e88733c38";

const M1_PROBE_RESULT_FIELDS = [
  "raw_response_body",
  "raw_response_sha256",
  "raw_response_body_sha256",
  "raw_probe_request_sha256",
  "full_request_body_sha256",
  "provider_http_status",
  "provider_latency_ms",
  "provider_request_id",
  "provider_model",
  "retry_count",
] as const;

const M2_PROBE_RUN_FIELDS = ["dataset_id", "dataset_source_type"] as const;

interface FixtureProbeRun {
  id: string;
  project_id: string;
  [key: string]: unknown;
}

interface FixtureProbeResult {
  id: string;
  probe_run_id: string;
  project_id: string;
  verdict: unknown;
  product_verdict: unknown;
  client_position: unknown;
  raw_response: unknown;
  [key: string]: unknown;
}

interface Fixture {
  project: { id: string; domain: string; company_name: string };
  probe_runs: FixtureProbeRun[];
  probe_results: FixtureProbeResult[];
  fixture_version: string;
  snapshot_request_count: number;
}

const fixturePath = path.join(
  process.cwd(),
  "scripts",
  "fixtures",
  "hockeystack-m2-fixture.json"
);
const raw = readFileSync(fixturePath, "utf8");

let parsed: unknown;
let parseError: Error | null = null;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  parseError = err instanceof Error ? err : new Error(String(err));
}

check("fixture JSON is parseable", parseError === null, parseError?.message ?? "");

if (parseError) {
  console.log(`\n${checks - failures}/${checks} checks passed. Cannot continue — JSON did not parse.`);
  process.exit(1);
}

check(
  "the fixture root is a plain object, not an array",
  !Array.isArray(parsed) && typeof parsed === "object" && parsed !== null
);

const data = parsed as Fixture;

check(
  "project.id matches the HockeyStack project id exactly",
  data.project?.id === EXPECTED_PROJECT_ID,
  `got "${data.project?.id}"`
);

check(
  "snapshot_request_count is exactly 1",
  data.snapshot_request_count === 1,
  `got ${data.snapshot_request_count}`
);

check(
  "probe_runs is an array of exactly 15 entries",
  Array.isArray(data.probe_runs) && data.probe_runs.length === 15,
  `got ${data.probe_runs?.length}`
);

check(
  "probe_results is an array of exactly 15 entries",
  Array.isArray(data.probe_results) && data.probe_results.length === 15,
  `got ${data.probe_results?.length}`
);

const runIds = data.probe_runs.map((r) => r.id);
const uniqueRunIds = new Set(runIds);
check(
  "all 15 probe_run ids are distinct",
  uniqueRunIds.size === 15,
  `${uniqueRunIds.size} distinct out of ${runIds.length}`
);

const resultIds = data.probe_results.map((r) => r.id);
const uniqueResultIds = new Set(resultIds);
check(
  "all 15 probe_result ids are distinct",
  uniqueResultIds.size === 15,
  `${uniqueResultIds.size} distinct out of ${resultIds.length}`
);

const runIdSet = new Set(runIds);
const unlinkedResults = data.probe_results.filter(
  (r) => !runIdSet.has(r.probe_run_id)
);
check(
  "every probe_result links to a probe_run present in this fixture",
  unlinkedResults.length === 0,
  `${unlinkedResults.length} unlinked`
);

const legacyMissing = data.probe_results.filter(
  (r) =>
    r.verdict == null ||
    r.product_verdict == null ||
    r.client_position == null ||
    r.raw_response == null
);
check(
  "verdict, product_verdict, client_position, and raw_response are present on all 15 probe_results",
  legacyMissing.length === 0,
  `${legacyMissing.length} row(s) missing a legacy field`
);

const m1FieldsPresentNonNull: string[] = [];
for (const r of data.probe_results) {
  for (const field of M1_PROBE_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, field) && r[field] !== null) {
      m1FieldsPresentNonNull.push(`${r.id}.${field}`);
    }
  }
}
for (const r of data.probe_runs) {
  for (const field of M2_PROBE_RUN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(r, field) && r[field] !== null) {
      m1FieldsPresentNonNull.push(`${r.id}.${field}`);
    }
  }
}
check(
  "no M1 evidence/hash/provider-metadata column is present-and-non-null anywhere in the fixture (D-016)",
  m1FieldsPresentNonNull.length === 0,
  m1FieldsPresentNonNull.length > 0 ? m1FieldsPresentNonNull.join(", ") : ""
);

check(
  "no M1 hash was computed retroactively — the hash fields do not exist as keys on any probe_result",
  data.probe_results.every((r) =>
    M1_PROBE_RESULT_FIELDS.filter((f) => f.endsWith("_sha256")).every(
      (f) => !Object.prototype.hasOwnProperty.call(r, f) || r[f] === null
    )
  )
);

const rawResponseSeen = new Map<unknown, string>();
const duplicateRawResponses: string[] = [];
for (const r of data.probe_results) {
  const seenId = rawResponseSeen.get(r.raw_response);
  if (seenId) {
    duplicateRawResponses.push(`${seenId} == ${r.id}`);
  } else {
    rawResponseSeen.set(r.raw_response, r.id);
  }
}
check(
  "no two probe_results share identical raw_response text (no duplication)",
  duplicateRawResponses.length === 0,
  duplicateRawResponses.join(", ")
);

const wrongProjectRuns = data.probe_runs.filter(
  (r) => r.project_id !== data.project.id
);
const wrongProjectResults = data.probe_results.filter(
  (r) => r.project_id !== data.project.id
);
check(
  "every probe_run and probe_result carries the same project_id as the fixture's project",
  wrongProjectRuns.length === 0 && wrongProjectResults.length === 0,
  `${wrongProjectRuns.length} run(s), ${wrongProjectResults.length} result(s) mismatched`
);

console.log(
  `\n${checks - failures}/${checks} checks passed. ` +
    (failures === 0
      ? "HockeyStack golden fixture validation PASSED."
      : "HockeyStack golden fixture validation FAILED.")
);
process.exit(failures === 0 ? 0 : 1);
