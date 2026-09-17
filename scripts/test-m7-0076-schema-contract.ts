#!/usr/bin/env tsx
/**
 * Static contract for 0076 — the Outcome Card artifact table and its
 * delivery pipeline.
 *
 * This migration is a deliberate close mirror of existing, runtime-proven
 * machinery (0027/0029/0031/0035/0065/0068) applied to a new identity
 * (intervention_id rather than snapshot_request_id). The checks below are
 * organized the same way: table shape and constraints, then the helper
 * functions, then save_outcome_card_artifact's two re-derived invariants
 * (intervention must be implemented; the retest must actually be the
 * intervention's own baseline's retest), then the fencing RPCs and the
 * one deliberate improvement over the 0035 precedent — begin_outcome_card_
 * delivery refuses `blocked` at the database layer, which 0035 never did
 * for the baseline path.
 *
 * Text-only. No database, no network. The runtime contract
 * (test-m7-0076-runtime-contract.ts) is what proves the fencing actually
 * excludes a race and the constraints actually reject a bad row.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const FILE = "0076_m7_outcome_card_artifacts.sql";
const RAW = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const FLAT = SQL.replace(/\s+/g, " ").trim();

function fn(name: string): string {
  const m = FLAT.match(
    new RegExp(`create or replace function\\s+public\\.${name}[\\s\\S]*?\\$\\$;`, "i")
  );
  return m ? m[0] : "";
}

const TABLE = FLAT.match(/create table if not exists public\.outcome_card_artifacts[\s\S]*?\);/i)?.[0] ?? "";
const SAVE = fn("save_outcome_card_artifact");
const BEGIN = fn("begin_outcome_card_delivery");
const FINALIZE = fn("finalize_outcome_card_delivery");
const RELEASE = fn("release_outcome_card_delivery_claim");
const TOKEN_FN = fn("_generate_outcome_card_public_token");
const ASSERT_FN = fn("_assert_outcome_card_artifact_input");

/* ═══════════════ 1. table shape ═══════════════ */
{
  console.log("\n[1] outcome_card_artifacts");

  assert("keyed by intervention_id, unique — one card per intervention",
    /intervention_id\s+uuid not null unique references public\.interventions \(id\) on delete cascade/i.test(TABLE));
  assert("tenant-scoped",
    /project_id\s+uuid not null references public\.projects \(id\) on delete cascade/i.test(TABLE));
  assert("both protocol legs are real foreign keys, not derived at read time",
    /baseline_protocol_id\s+uuid not null references public\.protocols \(id\) on delete restrict/i.test(TABLE) &&
    /retest_protocol_id\s+uuid not null references public\.protocols \(id\) on delete restrict/i.test(TABLE));

  assert("markdown must be non-empty", /outcome_card_artifacts_markdown_not_empty/.test(TABLE) &&
    /char_length\(markdown\) > 0/.test(TABLE));
  assert("payload must be a JSON object", /outcome_card_artifacts_payload_is_object/.test(TABLE) &&
    /jsonb_typeof\(payload\) = 'object'/.test(TABLE));
  assert("integrity_status is closed to the three canonical values",
    /integrity_status in \('integrity_passed', 'needs_review', 'blocked'\)/i.test(TABLE));
  assert("a pass carries no reasons; anything less carries at least one — mirrors 0068 exactly",
    /integrity_status = 'integrity_passed' and jsonb_array_length\(integrity_reasons\) = 0/.test(TABLE) &&
    /integrity_status <> 'integrity_passed' and jsonb_array_length\(integrity_reasons\) > 0/.test(TABLE));
  assert("public_token has the same minimum length 0029 established",
    /outcome_card_artifacts_public_token_length/.test(TABLE) && /char_length\(public_token\) >= 43/.test(TABLE));

  assert("row level security is on", /alter table public\.outcome_card_artifacts enable row level security/i.test(FLAT));
  assert("revoked from public/anon/authenticated",
    /revoke all on table public\.outcome_card_artifacts from public/i.test(FLAT) &&
    /revoke all on table public\.outcome_card_artifacts from anon/i.test(FLAT) &&
    /revoke all on table public\.outcome_card_artifacts from authenticated/i.test(FLAT));
  assert("service_role gets full artifact-table privileges, matching 0027's precedent for THIS class of table",
    /grant select, insert, update, delete on table public\.outcome_card_artifacts to service_role/i.test(FLAT));

  assert("a unique index backs the public token",
    /create unique index if not exists outcome_card_artifacts_public_token_idx on public\.outcome_card_artifacts \(public_token\)/i.test(FLAT));
}

/* ═══════════════ 2. helpers are locked down exactly like their precedents ═══════════════ */
{
  console.log("\n[2] Helper functions");

  assert("the token generator exists and is revoked from EVERY role, service_role included — mirrors 0031 exactly",
    TOKEN_FN !== "" &&
    /revoke all on function public\._generate_outcome_card_public_token\(\) from public/i.test(FLAT) &&
    /revoke all on function public\._generate_outcome_card_public_token\(\) from anon/i.test(FLAT) &&
    /revoke all on function public\._generate_outcome_card_public_token\(\) from authenticated/i.test(FLAT) &&
    /revoke all on function public\._generate_outcome_card_public_token\(\) from service_role/i.test(FLAT));
  assert("no grant statement exists for the token generator — it works only via an owning security-definer caller",
    !/grant execute on function public\._generate_outcome_card_public_token/i.test(FLAT));

  assert("the input assertion helper exists and is likewise revoked from every role including service_role",
    ASSERT_FN !== "" &&
    /revoke all on function public\._assert_outcome_card_artifact_input\(text, timestamptz\) from service_role/i.test(FLAT));
  assert("it validates a non-empty markdown and a non-null timestamp",
    /char_length\(btrim\(p_markdown\)\) = 0/.test(ASSERT_FN) && /p_generated_at is null/.test(ASSERT_FN));

  const revisionFn = FLAT.match(/create or replace function public\.outcome_card_artifact_revision[\s\S]*?\$body\$;/i)?.[0] ?? "";
  assert("the revision hash exists and hashes BOTH the markdown and the payload",
    revisionFn !== "" && /p_markdown/.test(revisionFn) && /p_payload::text/.test(revisionFn));
  assert("the revision function is granted to service_role (unlike the two _-prefixed helpers)",
    /grant execute on function public\.outcome_card_artifact_revision\(text, jsonb\) to service_role/i.test(FLAT));
}

/* ═══════════════ 3. save_outcome_card_artifact's re-derived invariants ═══════════════ */
{
  console.log("\n[3] save_outcome_card_artifact");

  assert("input is validated before anything is touched",
    /perform public\._assert_outcome_card_artifact_input\(p_markdown, p_generated_at\)/i.test(SAVE));
  assert("the payload must be a JSON object",
    /p_payload is null or jsonb_typeof\(p_payload\) <> 'object'/.test(SAVE));
  assert("integrity_status is validated against the closed set",
    /p_integrity_status not in \('integrity_passed', 'needs_review', 'blocked'\)/.test(SAVE));
  assert("the integrity pairing is enforced by the RPC too, not only by the table CHECK",
    /integrity_passed_must_carry_no_reasons/.test(SAVE) && /integrity_below_passed_requires_a_reason/.test(SAVE));

  assert("THE RE-DERIVED INVARIANT: refuses unless the intervention is actually implemented",
    /if v_intervention\.status <> 'implemented' then return; end if;/i.test(SAVE));
  assert("refuses if the caller's baseline id does not match the intervention's own protocol_id",
    /v_intervention\.protocol_id is distinct from p_baseline_protocol_id/i.test(SAVE));
  assert("refuses unless the retest protocol actually points back at that same baseline",
    /where p\.id = p_retest_protocol_id\s+and p\.project_id = p_project_id\s+and p\.baseline_protocol_id = p_baseline_protocol_id/i.test(SAVE));

  assert("a delivered artifact is immutable, mirroring 0065's precedent",
    /if found and v_artifact\.delivered_at is not null then return; end if;/i.test(SAVE));
  assert("the public token is generated only on INSERT, never regenerated on UPDATE",
    /public\._generate_outcome_card_public_token\(\)/.test(SAVE) &&
    !new RegExp("update public\\.outcome_card_artifacts[\\s\\S]{0,400}?_generate_outcome_card_public_token").test(SAVE));
  assert("a repeat save updates the existing row rather than inserting a second one",
    /update public\.outcome_card_artifacts/.test(SAVE));

  assert("revoked from untrusted roles, granted to service_role",
    /revoke all on function public\.save_outcome_card_artifact\([^)]*\) from public, anon, authenticated/i.test(FLAT) &&
    /grant execute on function public\.save_outcome_card_artifact\([^)]*\) to service_role/i.test(FLAT));
}

/* ═══════════════ 4. delivery fencing mirrors 0035 ═══════════════ */
{
  console.log("\n[4] Delivery fencing");

  for (const [name, body] of [["begin_outcome_card_delivery", BEGIN], ["finalize_outcome_card_delivery", FINALIZE], ["release_outcome_card_delivery_claim", RELEASE]] as const) {
    assert(`${name} locks the artifact row before deciding anything`, /for update/i.test(body));
    assert(`${name} checks the expected artifact id`, /is distinct from p_expected_artifact_id|is distinct from p_artifact_id/i.test(body));
    assert(`${name} refuses once delivered_at is set`, /if v_artifact\.delivered_at is not null then/i.test(body));
  }

  assert("begin refuses when no claim exists to double-reserve",
    /if v_artifact\.delivery_claim_token is not null then/i.test(BEGIN));
  assert("begin checks the revision, so a stale preview cannot be delivered",
    /v_current_revision is distinct from p_expected_revision/i.test(BEGIN));
  assert("begin mints a fresh token and stamps the claim",
    /v_token := gen_random_uuid\(\)/.test(BEGIN) && /delivery_claim_token = v_token/.test(BEGIN));
  assert("begin returns the exact markdown and payload the claim covers",
    /select v_artifact\.id, v_current_revision, v_token, v_artifact\.markdown, v_artifact\.payload/i.test(BEGIN));

  assert("finalize requires the exact claim token, not merely a non-null one",
    /v_artifact\.delivery_claim_token is null\s+or v_artifact\.delivery_claim_token is distinct from p_delivery_claim_token/i.test(FINALIZE));
  assert("finalize clears the claim fields on success",
    /delivery_claim_token = null,\s*delivery_claimed_at = null/i.test(FINALIZE));
  assert("finalize stamps delivered_at and the message id",
    /set delivered_at = v_delivered_at,\s*delivery_message_id = p_delivery_message_id/i.test(FINALIZE));

  assert("release requires the exact claim token too",
    /v_artifact\.delivery_claim_token is null\s+or v_artifact\.delivery_claim_token is distinct from p_delivery_claim_token/i.test(RELEASE));
  assert("release clears the claim without touching delivered_at",
    /delivery_claim_token = null,\s*delivery_claimed_at = null/i.test(RELEASE) && !/delivered_at = /.test(RELEASE));

  // The deliberate improvement over 0035.
  assert(
    "THE DELIBERATE IMPROVEMENT: begin_outcome_card_delivery refuses a `blocked` artifact at the database layer",
    /if v_artifact\.integrity_status = 'blocked' then\s*raise exception 'outcome card is blocked and may never be delivered'/i.test(BEGIN)
  );
  assert("needs_review is NOT refused by begin — that gate is a human decision, matching the F-1 fix's own scope",
    !/integrity_status = 'needs_review'/i.test(BEGIN));

  for (const [name, args] of [
    ["begin_outcome_card_delivery", "uuid, uuid, text"],
    ["finalize_outcome_card_delivery", "uuid, uuid, uuid, text"],
    ["release_outcome_card_delivery_claim", "uuid, uuid, uuid"],
  ] as const) {
    assert(`${name} revoked from untrusted roles, granted to service_role`,
      new RegExp(`revoke all on function public\\.${name}\\(${args}\\) from public, anon, authenticated`, "i").test(FLAT) &&
      new RegExp(`grant execute on function public\\.${name}\\(${args}\\) to service_role`, "i").test(FLAT));
  }
}

/* ═══════════════ 5. scope discipline ═══════════════ */
{
  console.log("\n[5] Scope discipline");

  for (const [label, re] of [
    ["touches no existing table's schema", /alter table public\.(snapshot_report_artifacts|protocols|interventions|protocol_attempts)/i],
    ["creates no evidence-table write", /(update|delete from|insert into) public\.(protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_results)/i],
    ["mutates no existing row anywhere", /^update public\.(?!outcome_card_artifacts)/im],
  ] as const) {
    assert(label, !re.test(FLAT));
  }

  assert("no later migration redefines any function this migration owns",
    readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 76)
      .every((f) => {
        const stripped = readFileSync(path.join(MIGRATIONS, f), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
        return [
          "save_outcome_card_artifact", "begin_outcome_card_delivery",
          "finalize_outcome_card_delivery", "release_outcome_card_delivery_claim",
          "outcome_card_artifact_revision",
        ].every((name) => {
          const re = new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,120}?\\b${name}\\b`, "i");
          return !re.test(stripped);
        });
      }));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, string, string, (s: string) => boolean]> = [
    [
      "dropping the implemented-status re-check",
      "if v_intervention.status <> 'implemented' then return; end if;",
      "",
      (s) => !/if v_intervention\.status <> 'implemented' then return; end if;/i.test(s),
    ],
    [
      "trusting the caller's retest/baseline pairing without checking it",
      "and p.baseline_protocol_id = p_baseline_protocol_id",
      "",
      (s) => !/and p\.baseline_protocol_id = p_baseline_protocol_id/i.test(s),
    ],
    [
      "letting begin_outcome_card_delivery skip the blocked check",
      "if v_artifact.integrity_status = 'blocked' then",
      "if false then",
      (s) => !/if v_artifact\.integrity_status = 'blocked' then/i.test(s),
    ],
    [
      "granting the token generator to service_role after all",
      "revoke all on function public._generate_outcome_card_public_token() from service_role;",
      "",
      (s) => !/revoke all on function public\._generate_outcome_card_public_token\(\) from service_role/i.test(s),
    ],
    [
      "dropping the delivered-artifact immutability guard",
      "if found and v_artifact.delivered_at is not null then return; end if;",
      "",
      (s) => !/if found and v_artifact\.delivered_at is not null then return; end if;/i.test(s),
    ],
  ];

  for (const [label, needle, replacement, detects] of mutations) {
    const mutated = FLAT.replace(needle, replacement);
    assert(`the mutation "${label}" actually changes the SQL`, mutated !== FLAT);
    assert(`…and a detector refuses it`, detects(mutated));
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nM7 0076 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0076 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
