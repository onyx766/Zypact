/**
 * Migration filename rules shared by every test that reads
 * `supabase/migrations` (QD-6, decided by the Founder on 2026-11-02).
 *
 * The four-digit sequence is closed. A four-digit file is recognised only
 * by its EXACT name: one of the historical files on main, or one of the
 * reserved names of the held/frozen 0082, 0084 and 0085. A number alone
 * (`0086_x.sql`, `2026_x.sql`, a renamed `0083_*.sql`) is not enough.
 *
 * Every new migration is `YYYYMMDDHHMMSS_name.sql`: a real UTC instant
 * above production's 0081 ledger row (20260924023646), lowercase name.
 * Its version, read as a number, is above every four-digit version, so
 * numeric order is apply order.
 *
 * Every `.sql` entry is parsed. Nothing is skipped: a name that fits no rule
 * is an error, never silently ignored.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Production's ledger row for 0081 (comments-only difference, verified 2026-11-01). */
export const LAST_PRE_TIMESTAMP_LEDGER_VERSION = 20260924023646;

/** Every four-digit migration on main at 13ccdc1, by exact filename. Never edited, renumbered or reused. */
export const HISTORICAL_MIGRATIONS: readonly string[] = [
  "0001_init.sql",
  "0002_generated_prompts.sql",
  "0003_probe_analysis.sql",
  "0004_competitors.sql",
  "0005_gap_map.sql",
  "0006_evidence_bank.sql",
  "0007_fix_briefs.sql",
  "0008_generated_assets.sql",
  "0009_qa_reports.sql",
  "0010_grants.sql",
  "0011_security_hardening.sql",
  "0012_probe_mode_and_evidence_provenance.sql",
  "0013_live_perplexity_probe_mode.sql",
  "0014_generated_asset_generation_metadata.sql",
  "0015_asset_lifecycle_and_fix_brief_status.sql",
  "0016_probe_request_and_product_scorecard.sql",
  "0017_snapshot_requests.sql",
  "0018_snapshot_request_limits.sql",
  "0019_snapshot_email_verification.sql",
  "0020_snapshot_verification_delivery_failure.sql",
  "0021_snapshot_founder_approval.sql",
  "0022_snapshot_fi_invite.sql",
  "0023_remove_snapshot_fi_invite.sql",
  "0024_snapshot_project_reservation.sql",
  "0025_snapshot_progress.sql",
  "0026_snapshot_completion.sql",
  "0027_snapshot_report_artifacts.sql",
  "0028_snapshot_request_rejection.sql",
  "0029_snapshot_report_public_token.sql",
  "0030_snapshot_request_worker_claim.sql",
  "0031_snapshot_worker_fenced_writes.sql",
  "0032_revoke_direct_snapshot_dml.sql",
  "0033_restrict_snapshot_artifact_project_delete.sql",
  "0034_snapshot_request_competitors.sql",
  "0035_snapshot_report_delivery_fencing.sql",
  "0036_m1_probe_evidence_contract.sql",
  "0037_m1_probe_failure_and_raw_body_contract.sql",
  "0038_m2_canonical_observations_schema.sql",
  "0039_m2_backfill_probe_result_dataset_identity_rpc.sql",
  "0040_m2_probe_dataset_not_null.sql",
  "0041_m2_entity_resolution_schema.sql",
  "0042_m2_entity_resolution_rpc.sql",
  "0043_m2_fix_entity_resolution_rpc_ambiguity.sql",
  "0044_m2_fix_entity_resolution_rpc_found.sql",
  "0045_m3_competitors_canonical_entity.sql",
  "0046_m3_replace_competitors_transactional_rpc.sql",
  "0047_m4_buyer_question_protocol_attempts.sql",
  "0048_m4_buyer_question_version_numeric_range_checks.sql",
  "0049_m4_fix_protocol_rpc_status_ambiguities.sql",
  "0050_m5_protocol_execution_jobs_and_external_call_ledger.sql",
  "0051_m5_protocol_worker_resumption_and_retry_safety.sql",
  "0052_m5_durable_call_payloads_and_probe_result_replay.sql",
  "0053_m5_analysis_parse_failure_and_raw_request_body.sql",
  "0054_m5_worker_probe_result_and_alert_outbox.sql",
  "0055_m1_exact_provider_request_body.sql",
  "0056_m5_external_call_request_evidence.sql",
  "0057_m0_harden_table_privileges.sql",
  "0058_m5_analysis_receipt_transport_evidence.sql",
  "0059_m5_phase3d_targeted_claim.sql",
  "0060_m5_phase3d_post_claim_verification.sql",
  "0061_snapshot_request_contact_name.sql",
  "0062_snapshot_approval_launches_protocol_baseline.sql",
  "0063_snapshot_baseline_paraphrase_plan.sql",
  "0064_backfill_measured_perplexity_cost.sql",
  "0065_protocol_report_payload.sql",
  "0066_protocol_job_review_resolution.sql",
  "0067_preserve_prior_needs_review_reason.sql",
  "0068_report_integrity_status.sql",
  "0069_new_baseline_default_five_runs.sql",
  "0070_scope_job_review_resolution_to_its_job.sql",
  "0071_m7_registered_interventions.sql",
  "0072_m7_observation_window_and_retest_eligibility.sql",
  "0073_m7_retest_protocol_creation.sql",
  "0074_m7_retest_phase_integrity.sql",
  "0075_m7_detectable_change_at_approval.sql",
  "0076_m7_outcome_card_artifacts.sql",
  "0077_m7_intervention_rejection_and_abandonment.sql",
  "0078_m7_interventions_register_against_baselines_only.sql",
  "0079_m7_one_retest_per_intervention.sql",
  "0080_protocol_report_marks_request_report_ready.sql",
  "0081_snapshot_request_origin_and_founder_creation.sql",
  "0083_m5_estimated_cost_keeps_attempt_cap_basis.sql",
];

/** Held or frozen outside main; recognised by exact name so a release is not mistaken for a malformed file. */
export const RESERVED_MIGRATIONS: readonly string[] = [
  "0082_m7_post_implementation_deviations.sql",
  "0084_spend_ledger_gate.sql",
  "0085_spend_legacy_cutover.sql",
];

export const FOUR_DIGIT_ALLOWLIST: ReadonlySet<string> = new Set([...HISTORICAL_MIGRATIONS, ...RESERVED_MIGRATIONS]);

const FOUR_DIGIT_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TIMESTAMP_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;

export type MigrationNameResult =
  | { ok: true; file: string; version: number; kind: "four_digit" | "timestamp" }
  | { ok: false; file: string; code: "malformed" | "not_allowlisted" | "invalid_timestamp"; reason: string };

function isRealUtcInstant(v: string): boolean {
  const part = (from: number, to: number) => Number(v.slice(from, to));
  const [y, mo, d, h, mi, s] = [part(0, 4), part(4, 6), part(6, 8), part(8, 10), part(10, 12), part(12, 14)];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d &&
    at.getUTCHours() === h && at.getUTCMinutes() === mi && at.getUTCSeconds() === s;
}

/**
 * Classifies one `.sql` filename. `allowlist` defaults to the real one; a
 * self-test that builds synthetic four-digit names passes its own.
 */
export function parseMigrationName(
  file: string,
  allowlist: ReadonlySet<string> = FOUR_DIGIT_ALLOWLIST
): MigrationNameResult {
  const four = FOUR_DIGIT_RE.exec(file);
  if (four) {
    return allowlist.has(file)
      ? { ok: true, file, version: Number(four[1]), kind: "four_digit" }
      : { ok: false, file, code: "not_allowlisted", reason: `four-digit migration not on the exact allowlist: ${file}` };
  }
  const ts = TIMESTAMP_RE.exec(file);
  if (!ts) return { ok: false, file, code: "malformed", reason: `malformed migration filename: ${file}` };
  if (!isRealUtcInstant(ts[1]) || Number(ts[1]) <= LAST_PRE_TIMESTAMP_LEDGER_VERSION) {
    return { ok: false, file, code: "invalid_timestamp", reason: `invalid timestamp migration version: ${file}` };
  }
  return { ok: true, file, version: Number(ts[1]), kind: "timestamp" };
}

/** The version of one filename, or a thrown error naming why it is refused. */
export function migrationVersion(file: string, allowlist?: ReadonlySet<string>): number {
  const r = parseMigrationName(file, allowlist);
  if (!r.ok) throw new Error(r.reason);
  return r.version;
}

/** Every `.sql` entry, validated, de-duplicated by version and sorted into apply order. */
export function orderedMigrations(
  entries: readonly string[],
  allowlist?: ReadonlySet<string>
): { f: string; n: number }[] {
  const seen = new Map<number, string>();
  for (const f of entries.filter((e) => e.endsWith(".sql"))) {
    const n = migrationVersion(f, allowlist);
    if (seen.has(n)) throw new Error(`duplicate migration version ${n}: ${seen.get(n)} and ${f}`);
    seen.set(n, f);
  }
  return [...seen].sort(([a], [b]) => a - b).map(([n, f]) => ({ f, n }));
}

/**
 * Every migration in `dir` in apply order with its SQL, plus in-memory
 * `extra` files: the way a guard proves it would catch a later migration.
 */
export function migrationLedger(
  dir: string,
  extra: Readonly<Record<string, string>> = {},
  allowlist?: ReadonlySet<string>
): { f: string; n: number; sql: string }[] {
  return orderedMigrations([...readdirSync(dir), ...Object.keys(extra)], allowlist)
    .map(({ f, n }) => ({ f, n, sql: extra[f] ?? readFileSync(path.join(dir, f), "utf8") }));
}

/** True when adding `extra` names to `dir` makes the ledger refuse. */
export function ledgerRefuses(dir: string, extra: readonly string[], allowlist?: ReadonlySet<string>): boolean {
  try {
    migrationLedger(dir, Object.fromEntries(extra.map((f) => [f, ""])), allowlist);
    return false;
  } catch {
    return true;
  }
}

/**
 * The directory and the allowlist agree: every historical file is present
 * under its exact name, and nothing four-digit is present that is neither
 * historical nor reserved. Returns the problems; empty means consistent.
 */
export function allowlistDrift(entries: readonly string[]): string[] {
  const sql = new Set(entries.filter((e) => e.endsWith(".sql")));
  const missing = HISTORICAL_MIGRATIONS.filter((f) => !sql.has(f)).map((f) => `historical migration missing: ${f}`);
  const unknown = [...sql].filter((f) => FOUR_DIGIT_RE.test(f) && !FOUR_DIGIT_ALLOWLIST.has(f))
    .map((f) => `four-digit migration not on the exact allowlist: ${f}`);
  return [...missing, ...unknown];
}

/** Later than any real migration can be, so it never collides with one on disk. */
export const TIMESTAMP_FIXTURE = "99991231235959_q2p_fixture.sql";

/** Names every consumer must refuse. `allow` widens the allowlist for that case only. */
export const INVALID_MIGRATION_NAMES: ReadonlyArray<{ label: string; extra: readonly string[]; allow?: readonly string[] }> = [
  { label: "a date-only (8-digit) version", extra: ["20261102_x.sql"] },
  { label: "a non-digit inside the version", extra: ["2026110200000a_x.sql"] },
  { label: "a 13-digit version", extra: ["2026110200000_x.sql"] },
  { label: "a version equal to production's 0081 row", extra: ["20260924023646_x.sql"] },
  { label: "a version below production's 0081 row", extra: ["20260101000000_x.sql"] },
  { label: "a non-calendar version (month 13)", extra: ["20261302000000_x.sql"] },
  { label: "a non-calendar version (31 November)", extra: ["20261131000000_x.sql"] },
  { label: "an uppercase timestamped name", extra: ["20261102000000_Q2P.sql"] },
  { label: "a duplicate timestamp version", extra: ["99991231235958_a.sql", "99991231235958_b.sql"] },
  { label: "a new four-digit migration (0086)", extra: ["0086_new_thing.sql"] },
  { label: "a four-digit name that is only a year (2026)", extra: ["2026_x.sql"] },
  { label: "a historical number under a different name", extra: ["0083_renamed.sql"] },
  { label: "a duplicate numbered version", extra: ["0010_duplicate_fixture.sql"], allow: ["0010_duplicate_fixture.sql"] },
];

/** The allowlist widened by one case's `allow` names. */
export function allowlistWith(allow: readonly string[] = []): ReadonlySet<string> {
  return allow.length === 0 ? FOUR_DIGIT_ALLOWLIST : new Set([...FOUR_DIGIT_ALLOWLIST, ...allow]);
}
