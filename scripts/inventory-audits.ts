/**
 * Audit inventory — read-only.
 *
 * Lists every snapshot request with the evidence attached to it, so a human
 * can decide which are real client work and which were tests. It answers the
 * question "what is in here?" and nothing else: it issues SELECTs only, and
 * the grants make that the only thing it could do even if it tried. 0032
 * revoked INSERT, UPDATE and DELETE on `snapshot_requests` and
 * `snapshot_report_artifacts` from service_role, and 0047/0050 leave
 * `protocols`, `protocol_attempts` and the receipt tables SELECT-only.
 *
 * It prints no work email and no report body. A company name and a domain
 * are what a human needs to recognise a row; an address is not, and terminal
 * history is not a place to put one. `--json` writes the same fields to a
 * file for annotation outside the database.
 *
 * The signal that actually separates test data from client work is
 * `probe_runs.probe_mode`: `simulated` means nothing was ever asked of a
 * provider. A row whose runs are all simulated cost nothing and measured
 * nothing. That is a strong hint, not a verdict — the founder's own live
 * rehearsals are indistinguishable from client work by machine, which is
 * exactly why this script asks a person rather than deciding.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
 *     scripts/inventory-audits.ts [--limit 200] [--json out.json]
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`, 2);
  return value;
}

const limit = Number.parseInt(flag("--limit") ?? "200", 10);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
  fail("--limit must be between 1 and 1000", 2);
}
const jsonPath = flag("--json");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  fail(
    "Refusing to run: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n"
    + "  DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/inventory-audits.ts",
    2,
  );
}

const db: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

/** Throws on error rather than returning a half-read inventory. */
async function selectIn<T>(
  table: string, columns: string, column: string, values: string[],
): Promise<T[]> {
  if (values.length === 0) return [];
  const rows: T[] = [];
  // PostgREST has a URL length ceiling, and an `in` list is a URL.
  for (let i = 0; i < values.length; i += 100) {
    const { data, error } = await db
      .from(table).select(columns).in(column, values.slice(i, i + 100));
    if (error) fail(`reading ${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

interface RequestRow {
  id: string; created_at: string; status: string;
  company_name: string | null; normalized_domain: string | null;
  project_id: string | null; protocol_id: string | null;
}
interface ArtifactRow {
  snapshot_request_id: string; delivered_at: string | null;
  integrity_status: string | null;
}
interface ProtocolRow { id: string; status: string; baseline_protocol_id: string | null }
interface AttemptRow {
  id: string; protocol_id: string; status: string; attempt_kind: string;
}
interface ProbeRunRow {
  snapshot_request_id: string | null; project_id: string | null; probe_mode: string | null;
}
interface ExternalCallRow {
  protocol_attempt_id: string | null; call_kind: string;
  status: string; actual_cost_usd: string | number | null;
}
interface InterventionRow { id: string; protocol_id: string; status: string }
interface OutcomeCardRow {
  intervention_id: string; delivered_at: string | null; integrity_status: string | null;
}

// One async body: the entrypoint compiles to CommonJS, where a top-level
// await is a syntax error rather than a slow start.
async function main(): Promise<void> {
const { data: requestData, error: requestError } = await db
  .from("snapshot_requests")
  .select("id, created_at, status, company_name, normalized_domain, project_id, protocol_id")
  .order("created_at", { ascending: false })
  .limit(limit);
if (requestError) fail(`reading snapshot_requests: ${requestError.message}`);

const requests = (requestData ?? []) as RequestRow[];
if (requests.length === 0) {
  console.log("No snapshot requests found.");
  process.exit(0);
}

const requestIds = requests.map((r) => r.id);
const baselineIds = requests.map((r) => r.protocol_id).filter((v): v is string => v !== null);
const projectIds = [...new Set(
  requests.map((r) => r.project_id).filter((v): v is string => v !== null),
)];

// `probe_runs.snapshot_request_id` is nullable and is in fact null for every
// run written before 0038 wired it up, so the request link alone reports a
// live audit as having called nothing. The project is the link that holds
// for all of them.
const [artifacts, baselines, probeRuns] = await Promise.all([
  selectIn<ArtifactRow>("snapshot_report_artifacts",
    "snapshot_request_id, delivered_at, integrity_status", "snapshot_request_id", requestIds),
  selectIn<ProtocolRow>("protocols",
    "id, status, baseline_protocol_id", "id", baselineIds),
  selectIn<ProbeRunRow>("probe_runs",
    "snapshot_request_id, project_id, probe_mode", "project_id", projectIds),
]);

// A retest is a protocol whose baseline_protocol_id points at the baseline.
const retests = await selectIn<ProtocolRow>("protocols",
  "id, status, baseline_protocol_id", "baseline_protocol_id", baselineIds);

const allProtocolIds = [...baselineIds, ...retests.map((p) => p.id)];
const [attempts, interventions] = await Promise.all([
  selectIn<AttemptRow>("protocol_attempts",
    "id, protocol_id, status, attempt_kind", "protocol_id", allProtocolIds),
  selectIn<InterventionRow>("interventions",
    "id, protocol_id, status", "protocol_id", baselineIds),
]);

// The ledger, not the attempt, is where a provider charge is recorded: an
// attempt's own actual_cost_usd is null for the analysis leg and for
// anything that failed before settlement.
const externalCalls = await selectIn<ExternalCallRow>("protocol_external_calls",
  "protocol_attempt_id, call_kind, status, actual_cost_usd",
  "protocol_attempt_id", attempts.map((a) => a.id));

const outcomeCards = await selectIn<OutcomeCardRow>("outcome_card_artifacts",
  "intervention_id, delivered_at, integrity_status", "intervention_id",
  interventions.map((i) => i.id));

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

function index<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(row); else map.set(k, [row]);
  }
  return map;
}

const artifactBy = index(artifacts, (a) => a.snapshot_request_id);
const probeRunBy = index(probeRuns, (p) => p.project_id);
const callsByAttempt = index(externalCalls, (c) => c.protocol_attempt_id);
const attemptBy = index(attempts, (a) => a.protocol_id);
const interventionBy = index(interventions, (i) => i.protocol_id);
const retestBy = index(retests, (p) => p.baseline_protocol_id);
const cardBy = index(outcomeCards, (c) => c.intervention_id);

const summary = requests.map((request) => {
  const baselineId = request.protocol_id;
  const baselineAttempts = baselineId ? attemptBy.get(baselineId) ?? [] : [];
  const theseRetests = baselineId ? retestBy.get(baselineId) ?? [] : [];
  const retestAttempts = theseRetests.flatMap((p) => attemptBy.get(p.id) ?? []);
  const theseInterventions = baselineId ? interventionBy.get(baselineId) ?? [] : [];
  const cards = theseInterventions.flatMap((i) => cardBy.get(i.id) ?? []);
  const artifact = (artifactBy.get(request.id) ?? [])[0];
  const modes = new Set(
    (request.project_id ? probeRunBy.get(request.project_id) ?? [] : [])
      .map((p) => p.probe_mode ?? "unknown"),
  );
  const calls = [...baselineAttempts, ...retestAttempts]
    .flatMap((a) => callsByAttempt.get(a.id) ?? []);
  const cost = calls.reduce((sum, c) => sum + Number(c.actual_cost_usd ?? 0), 0);
  const paidCalls = calls.filter((c) => c.status === "completed").length;

  return {
    id: request.id,
    createdAt: request.created_at,
    company: request.company_name,
    domain: request.normalized_domain,
    status: request.status,
    baselineProtocol: baselineId
      ? (baselines.find((p) => p.id === baselineId)?.status ?? "missing")
      : null,
    baselineAttempts: baselineAttempts.length,
    completedAttempts: baselineAttempts.filter((a) => a.status === "completed").length,
    probeModes: [...modes].sort(),
    providerCalls: paidCalls,
    // Everything a provider was actually paid for, baseline and retest.
    actualCostUsd: Number(cost.toFixed(4)),
    reportDelivered: artifact?.delivered_at ?? null,
    reportIntegrity: artifact?.integrity_status ?? null,
    interventions: theseInterventions.map((i) => i.status),
    retests: theseRetests.length,
    retestAttempts: retestAttempts.length,
    outcomeCardsDelivered: cards.filter((c) => c.delivered_at !== null).length,
    // A hint for the human, never a verdict: no paid call and nothing
    // delivered is what a rehearsal looks like from the outside.
    looksLikeTest: paidCalls === 0 && artifact?.delivered_at == null,
  };
});

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

const pad = (s: string, n: number): string =>
  (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

console.log(`\n${requests.length} snapshot request(s), newest first.\n`);
console.log(
  pad("DATE", 11) + pad("COMPANY", 22) + pad("STATUS", 18)
  + pad("RUNS", 6) + pad("PROBE", 16) + pad("CALLS", 7) + pad("COST", 9)
  + pad("DELIVERED", 11) + pad("RETEST", 8) + "HINT",
);
console.log("─".repeat(122));

for (const row of summary) {
  console.log(
    pad(row.createdAt.slice(0, 10), 11)
    + pad(row.company ?? "—", 22)
    + pad(row.status, 18)
    + pad(`${row.completedAttempts}/${row.baselineAttempts}`, 6)
    + pad(row.probeModes.join(",") || "none", 16)
    + pad(row.providerCalls > 0 ? String(row.providerCalls) : "—", 7)
    + pad(row.actualCostUsd > 0 ? `$${row.actualCostUsd.toFixed(2)}` : "—", 9)
    + pad(row.reportDelivered ? "yes" : "no", 11)
    + pad(row.retests > 0 ? `${row.retestAttempts} att` : "—", 8)
    + (row.looksLikeTest ? "probably a test" : "real work?"),
  );
}

const probableTests = summary.filter((r) => r.looksLikeTest).length;
const delivered = summary.filter((r) => r.reportDelivered !== null).length;
const spend = summary.reduce((sum, r) => sum + r.actualCostUsd, 0);

console.log(
  `\n${delivered} delivered report(s), ${probableTests} row(s) with no paid call and `
  + `nothing delivered, $${spend.toFixed(2)} of provider spend recorded in total.`,
);
console.log(
  "\nThe HINT column is a guess from two facts: whether a provider was ever\n"
  + "paid, and whether a report reached anyone. Confirm every row with a\n"
  + "human before acting on it — a live founder rehearsal looks exactly like\n"
  + "client work from here.",
);

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${summary.length} row(s) to ${jsonPath}`);
}
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
