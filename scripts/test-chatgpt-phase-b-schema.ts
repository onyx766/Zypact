#!/usr/bin/env tsx
/**
 * ChatGPT measurement, phase B (D-061), offline:
 *
 *   S  the static contract of supabase/migrations/20261109180000_chatgpt_measurement.sql:
 *      its number inside D-058's window; persist_probe_result_for_job is
 *      0054's byte for byte outside its two marked lines; retire_pilot_question
 *      is 20261109140000's byte for byte outside its marked declarations and
 *      block; the ChatGPT setting literals are the TypeScript constants; the
 *      provider set is the worker's; privileges, SECURITY DEFINER and
 *      search_path; the trigger function granted to nobody; no other existing
 *      function redefined; preconditions before the first change and
 *      postconditions after the last; the preflight, the DB runner and the
 *      command are wired;
 *   M  the memory adapter mirrors the same rules: the probe-run CHECKs at
 *      run start, the platform taken from the run at persist, the per-engine
 *      live-baseline rule at approval, add_pilot_question_engine, the slot
 *      rules, retire_pilot_question over every slot, and the capability list.
 *
 * The same rules against a real PostgreSQL are in test-chatgpt-phase-b-db.ts.
 * No database, no network, no provider.
 */
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { DbAdapter, ProbeMode, Protocol, ProtocolExecutionJob } from "@/lib/db/types";
import {
  approvedChatGptSetting,
  CHATGPT_APPROVED_SETTING_VERSION,
  CHATGPT_PROVIDER,
  chatGptSettingOfVersion,
} from "@/lib/probes/chatgpt";
import { CHATGPT_PROTOCOL_PROVIDER } from "@/lib/protocol-worker/provider-profile";
import { probeRunnerForProtocol } from "@/lib/protocol-worker/worker";
import { parseMigrationName } from "./lib/migration-names";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

const DIR = "supabase/migrations";
const FILE = "20261109180000_chatgpt_measurement.sql";
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const RAW = read(path.join(DIR, FILE));
const CODE = RAW.replace(/--[^\n]*/g, "");
const FLAT = CODE.replace(/\s+/g, " ");
const S0054 = read(path.join(DIR, "0054_m5_worker_probe_result_and_alert_outbox.sql"));
const S140 = read(path.join(DIR, "20261109140000_pilot_questions.sql"));
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** From `start` through the first `end` after it, inclusive; "" when either is missing. */
function between(src: string, start: string, end: string): string {
  const s = src.indexOf(start);
  if (s < 0) return "";
  const e = src.indexOf(end, s);
  return e < 0 ? "" : src.slice(s, e + end.length);
}

/** Every `-- D-061 begin` ... `-- D-061 end` block of a text, with its code lines (comments dropped). */
function markedBlocks(src: string): Array<{ text: string; code: string }> {
  return [...src.matchAll(/^[ \t]*-- D-061 begin[^\n]*\n[\s\S]*?^[ \t]*-- D-061 end\n/gm)].map((m) => ({
    text: m[0],
    code: m[0].split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("--")).map((l) => `${l}\n`).join(""),
  }));
}

async function main(): Promise<void> {
  /* S: static contract ----------------------------------------------------- */
  console.log("[S] the migration");
  const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f));
  const parsed = parseMigrationName(FILE);
  check("S1 the name is valid and numbered inside D-058's window (after 20261109160000, before 20261110120000)",
    parsed.ok && parsed.kind === "timestamp" && parsed.version > 20261109160000 && parsed.version < 20261110120000
      && versions.every((r) => r.ok));
  check("S2 the header names D-061, the release order (expected_prev 20261109170000), the worker stopped, and both recoveries",
    /D-061/.test(RAW.slice(0, 2000)) && RAW.includes("expected_prev is the ledger tail at that\n-- time: 20261109170000")
      && RAW.includes("Apply with the protocol\n-- worker stopped")
      && RAW.includes("-- Recovery:") && RAW.includes("recovery is forward only"));
  check("S3 nothing from the account stack is referenced",
    !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_s1_[a-z_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(CODE));

  const defined = [...CODE.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)/gi)].map((m) => m[1]).sort();
  check("S4 it defines exactly the trigger function, persist, add_pilot_question_engine, retire and the capability probe",
    defined.join(",") === [
      "add_pilot_question_engine", "persist_probe_result_for_job", "pilot_question_protocols_consistency",
      "protocol_worker_capabilities", "retire_pilot_question",
    ].join(","), defined.join(","));
  check("S5 it drops, alters or creates no other function, and creates no table",
    !/\b(drop|alter)\s+function\b/i.test(CODE) && !/\bcreate\s+function\b/i.test(CODE) && !/\bcreate\s+table\b/i.test(CODE));
  const GUARDED = [
    "approve_protocol", "approve_buyer_question_version", "enqueue_protocol_execution_job", "add_pilot_question",
    "close_pilot", "request_protocol_job_run", "claim_requested_protocol_execution_job", "retry_failed_protocol_job",
    "claim_protocol_execution_job", "claim_protocol_execution_job_by_id", "create_probe_run_and_start_attempt_for_job",
    "admit_and_reserve_attempt_for_job", "mark_external_call_sent_for_job", "record_provider_call_receipt_for_job",
    "record_analysis_call_receipt_for_job", "reconcile_attempt_for_job", "complete_protocol_execution_job",
    "resolve_protocol_job_review", "create_retest_protocol", "save_pilot_report_artifact", "read_shared_pilot_report",
  ];
  check("S6 none of the approval, queue, claim, spend, receipt, retry, review, retest or report functions is redefined",
    GUARDED.every((fn) => !new RegExp(`function\\s+public\\.${fn}\\s*\\(`, "i").test(CODE)));
  check("S7 the call kinds are untouched: no call_kind CHECK, no monitoring view (D-061 item 1)",
    !/call_kind_check|protocol_external_calls\s+(add|drop)|create\s+(or\s+replace\s+)?view/i.test(CODE)
      && !/alter\s+table\s+public\.(protocol_external_calls|external_call_requests)/i.test(CODE));
  const fnBodies = [...CODE.matchAll(/as \$\$[\s\S]*?\$\$;/g)].map((m) => m[0]).join("\n");
  const outside = CODE.replace(/as \$\$[\s\S]*?\$\$;/g, "").replace(/do \$\$[\s\S]*?end \$\$;/g, "");
  check("S8 no row is written outside a function body", !/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(outside));
  check("S9 the only evidence row a body writes is persist's probe result, as 0054's",
    [...fnBodies.matchAll(/(insert\s+into|update|delete\s+from)\s+public\.(protocol_attempts|protocol_external_calls|provider_call_receipts|analysis_call_receipts|external_call_requests|probe_runs|probe_results)\b/gi)]
      .map((m) => `${m[1].toLowerCase()} ${m[2]}`).join(",") === "insert into probe_results");

  // Preconditions and postconditions.
  const pre = between(CODE, "do $$", "end $$;");
  const firstChange = CODE.indexOf("alter table public.probe_runs");
  check("S10 the preconditions run before the first change",
    pre.length > 0 && CODE.indexOf(pre) < firstChange && firstChange > 0);
  check("S11 the preconditions check both probe-mode CHECKs exactly as 0013 left them",
    pre.includes("c.conname = 'probe_runs_probe_mode_check'") && pre.includes("c.conname = 'probe_results_probe_mode_check'")
      && (pre.match(/\$d\$CHECK \(\(probe_mode = ANY \(ARRAY\['simulated'::text, 'live_perplexity'::text\]\)\)\)\$d\$/g) ?? []).length === 2);
  check("S12 the preconditions check 0073's index and the two slot CHECKs exactly",
    pre.includes("$d$CREATE UNIQUE INDEX protocols_one_live_baseline_per_version ON public.protocols USING btree (buyer_question_version_id) WHERE ((status = ANY (ARRAY['approved'::text, 'active'::text])) AND (baseline_protocol_id IS NULL))$d$")
      && pre.includes("$d$CHECK ((engine = 'perplexity_sonar'::text))$d$") && pre.includes("$d$CHECK ((phase = 'baseline'::text))$d$"));
  check("S13 the preconditions refuse an unknown provider, a non-Perplexity attempt run, an open attempt, an inconsistent slot, and existing new objects",
    pre.includes("p.provider not in ('perplexity', 'perplexity_sonar', 'perplexity_agent', 'openai_chatgpt')")
      && pre.includes("join public.probe_runs pr on pr.id = pa.probe_run_id\n     where pr.platform <> 'perplexity'")
      && pre.includes("where pa.status in ('reserved', 'in_progress')")
      && pre.includes("where p.provider <> pqp.engine")
      && pre.includes("to_regclass('public.protocols_one_live_baseline_per_engine') is not null")
      && (pre.match(/raise exception/g) ?? []).length === 10);
  const post = CODE.slice(CODE.lastIndexOf("do $$"));
  check("S14 the postconditions run last and assert the CHECKs, the index swap, the trigger and every privilege",
    CODE.lastIndexOf("do $$") > CODE.indexOf("function public.protocol_worker_capabilities()")
      && post.includes("live_openai_chatgpt'::text])))$d$") && post.includes("protocols_one_live_baseline_per_engine ON public.protocols")
      && post.includes("to_regclass('public.protocols_one_live_baseline_per_version') is not null")
      && post.includes("t.tgtype = 7") && post.includes("has_function_privilege('service_role', 'public.pilot_question_protocols_consistency()', 'execute')")
      && ["persist_probe_result_for_job", "add_pilot_question_engine", "retire_pilot_question", "protocol_worker_capabilities"]
        .every((fn) => post.includes(`'public.${fn}(`)));

  // 1. Probe modes.
  check("S15 both probe-mode CHECKs are dropped by name, unconditionally, and re-added with exactly the new value",
    ["probe_runs", "probe_results"].every((t) =>
      CODE.includes(`alter table public.${t}\n  drop constraint ${t}_probe_mode_check;\nalter table public.${t}\n  add constraint ${t}_probe_mode_check\n  check (probe_mode in ('simulated', 'live_perplexity', 'live_openai_chatgpt'));`))
      && !/drop constraint if exists/i.test(CODE));

  // 2. The index.
  const create = CODE.indexOf("create unique index protocols_one_live_baseline_per_engine");
  const drop = CODE.indexOf("drop index public.protocols_one_live_baseline_per_version;");
  check("S16 the per-engine index is created before 0073's is dropped, with 0073's predicate",
    create > 0 && drop > create
      && FLAT.includes("create unique index protocols_one_live_baseline_per_engine on public.protocols ( buyer_question_version_id, (case when provider in ('perplexity', 'perplexity_sonar', 'perplexity_agent') then 'perplexity' else provider end) ) where status in ('approved', 'active') and baseline_protocol_id is null;"));
  const ENGINE_OF = (provider: string) =>
    ["perplexity", "perplexity_sonar", "perplexity_agent"].includes(provider) ? "perplexity" : provider;
  const sonar = (async () => { throw new Error("not called"); }) as never;
  const routed = (provider: string) => probeRunnerForProtocol({ runProbe: sonar }, { provider, modelConfig: {} });
  const known = ["perplexity", "perplexity_sonar", "perplexity_agent", CHATGPT_PROTOCOL_PROVIDER];
  check("S17 the provider set of the precondition and the index is exactly the set the worker routes; anything else is UNKNOWN_PROVIDER",
    known.every((p) => { const r = routed(p); return r.ok || r.detail !== "UNKNOWN_PROVIDER"; })
      && ["perplexity_sonar_alt", "openai", "chatgpt", "gemini", ""].every((p) => { const r = routed(p); return !r.ok && r.detail === "UNKNOWN_PROVIDER"; })
      && ENGINE_OF("perplexity_agent") === ENGINE_OF("perplexity") && ENGINE_OF(CHATGPT_PROTOCOL_PROVIDER) !== "perplexity");

  // 3. Slots.
  check("S18 the slot engine CHECK accepts exactly perplexity_sonar and openai_chatgpt; the phase CHECK is not touched",
    CODE.includes("alter table public.pilot_question_protocols\n  drop constraint pilot_question_protocols_engine_check;\nalter table public.pilot_question_protocols\n  add constraint pilot_question_protocols_engine_check\n  check (engine in ('perplexity_sonar', 'openai_chatgpt'));")
      && !/phase_check/.test(CODE.replace(pre, "").replace(post, "")));
  const trig = between(CODE, "create or replace function public.pilot_question_protocols_consistency()", "\n$$;\n");
  check("S19 the trigger refuses an engine that is not the provider, another project, another version, and a retest as a baseline",
    ["v_protocol.provider is distinct from new.engine", "v_protocol.project_id is distinct from v_pilot_project_id",
      "new.project_id is distinct from v_pilot_project_id",
      "v_protocol.buyer_question_version_id is distinct from v_question.buyer_question_version_id",
      "new.phase = 'baseline' and v_protocol.baseline_protocol_id is not null"].every((c) => trig.includes(c))
      && /returns trigger\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp/.test(trig));
  check("S20 the trigger fires BEFORE INSERT for each row, and its function is granted to nobody",
    CODE.includes("create trigger pilot_question_protocols_consistency\n  before insert on public.pilot_question_protocols\n  for each row execute function public.pilot_question_protocols_consistency();")
      && CODE.includes("revoke all on function public.pilot_question_protocols_consistency() from public, anon, authenticated, service_role;")
      && !/grant\s+[a-z ,]*on function public\.pilot_question_protocols_consistency/i.test(CODE));

  // 4. persist: 0054 byte for byte outside the two marked lines.
  const PERSIST_START = "create or replace function\n  public.persist_probe_result_for_job(";
  const PERSIST_END = "grant execute on function\n  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) to service_role;\n";
  const old0054 = between(S0054, PERSIST_START, PERSIST_END);
  const mine = between(RAW, PERSIST_START, PERSIST_END);
  const pBlocks = markedBlocks(mine);
  const SWAPS: Array<[string, string]> = [
    ["    'platform', v_probe_run.platform,\n", "    'platform', 'perplexity',\n"],
    ["    v_attempt.probe_run_id, p_project_id, v_buyer_question_version.prompt_text, v_probe_run.platform, v_provider_receipt.raw_response_body,\n",
      "    v_attempt.probe_run_id, p_project_id, v_buyer_question_version.prompt_text, 'perplexity', v_provider_receipt.raw_response_body,\n"],
  ];
  let restored = mine;
  pBlocks.forEach((b, i) => { restored = restored.replace(b.text, SWAPS[i]?.[0] === b.code ? SWAPS[i][1] : "<<unexpected block>>"); });
  check("S21 persist has exactly two marked blocks, and each holds only the platform from the probe run",
    pBlocks.length === 2 && pBlocks.every((b, i) => b.code === SWAPS[i][0]), pBlocks.map((b) => b.code).join("|"));
  check("S22 persist_probe_result_for_job is 0054's definition and privileges byte for byte outside the marked lines",
    old0054.length > 15000 && restored === old0054);
  check("S23 persist keeps 0054's search_path (pg_catalog, pg_temp), SECURITY DEFINER, a NULL provider_model and every status",
    /security definer\s+volatile\s+set search_path = pg_catalog, pg_temp/.test(mine)
      && mine.includes("'provider_model', null,") && (mine.match(/'[A-Z][A-Z_]+'::text/g) ?? []).length === (old0054.match(/'[A-Z][A-Z_]+'::text/g) ?? []).length);
  check("S24 the probe run is read before the canonical JSON that uses its platform",
    mine.indexOf("select pr.* into v_probe_run") > 0 && mine.indexOf("select pr.* into v_probe_run") < mine.indexOf("'platform', v_probe_run.platform"));

  // 5. add_pilot_question_engine.
  const add = between(RAW, "create or replace function public.add_pilot_question_engine(", "\n$$;\n");
  const addCode = add.replace(/--[^\n]*/g, "");
  const literal = (key: string) => addCode.match(new RegExp(`'${key}', '([^']+)'`))?.[1] ?? null;
  const approved = approvedChatGptSetting("auto");
  check("S25 the setting literals are CHATGPT_APPROVED_SETTING_VERSION and its model (lib/probes/chatgpt.ts)",
    CHATGPT_APPROVED_SETTING_VERSION !== null && literal("setting_version") === CHATGPT_APPROVED_SETTING_VERSION
      && literal("model") === chatGptSettingOfVersion(CHATGPT_APPROVED_SETTING_VERSION)?.model
      && approved !== null && approved.version === literal("setting_version") && approved.model === literal("model"),
    `${literal("model")} / ${literal("setting_version")}`);
  check("S26 the provider is the engine's: CHATGPT_PROVIDER and CHATGPT_PROTOCOL_PROVIDER, which equal the slot engine accepted",
    CHATGPT_PROVIDER === "openai_chatgpt" && CHATGPT_PROTOCOL_PROVIDER === CHATGPT_PROVIDER
      && addCode.includes("v_pilot.project_id, v_version.id, 'openai_chatgpt', 'answer',")
      && addCode.includes("if p_engine <> 'openai_chatgpt' then"));
  check("S27 the caps are D-059's: plan 5, run cap 7, spend cap 4, retry cap 2; window, rate and concurrency as Perplexity's",
    /5, 0,\s+'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',\s+7, 4, 86400,\s+10, 1, 2,/.test(addCode));
  const pqAdd = between(S140, "create or replace function public.add_pilot_question(", "\n$$;\n");
  check("S28 Perplexity's pilot plan has the same columns and limits apart from the cap (parity with add_pilot_question)",
    /5, 0,\s+'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',\s+(?:--[^\n]*\s+)*7, 2, 86400,\s+10, 1, 2,/.test(pqAdd)
      && squash(between(addCode, "insert into public.protocols (", ") values (")) === squash(between(pqAdd, "insert into public.protocols (", ") values (")));
  check("S29 the plan is built from the question's own approved version, never a new one",
    !/insert\s+into\s+public\.(buyer_questions|buyer_question_versions|pilot_questions)\b/i.test(addCode)
      && addCode.includes("where v.id = v_question.buyer_question_version_id")
      && addCode.includes("jsonb_build_object('text', v_version.prompt_text, 'hash', v_version.prompt_hash)"));
  check("S30 it locks the pilot FOR UPDATE before the replay and every state check",
    addCode.indexOf("for update;") > 0 && addCode.indexOf("for update;") < addCode.indexOf("'ALREADY_ADDED'::text")
      && addCode.indexOf("'ALREADY_ADDED'::text") < addCode.indexOf("'PILOT_CLOSED'::text")
      && addCode.indexOf("'PILOT_CLOSED'::text") < addCode.indexOf("'PILOT_ENDED'::text")
      && addCode.indexOf("'PILOT_ENDED'::text") < addCode.indexOf("'QUESTION_RETIRED'::text")
      && addCode.indexOf("'QUESTION_RETIRED'::text") < addCode.indexOf("'VERSION_NOT_APPROVED'::text")
      && addCode.indexOf("'VERSION_NOT_APPROVED'::text") < addCode.indexOf("'HASH_MISMATCH'::text")
      && addCode.indexOf("'HASH_MISMATCH'::text") < addCode.indexOf("insert into public.protocols"));
  check("S31 the hash is checked against the version's hash and its exact text before anything is written",
    addCode.includes("v_version.prompt_hash <> v_question.prompt_hash")
      && addCode.includes("encode(sha256(convert_to(v_version.prompt_text, 'UTF8')), 'hex') <> v_question.prompt_hash"));
  check("S32 the approval sequence is add_pilot_question's: approve_protocol must say APPROVED and the queue QUEUED, else P0001",
    squash(between(addCode, "select approval.status", "end if;")).replace("v_pilot.project_id", "v_project_id")
      === squash(between(pqAdd, "select approval.status\n    into v_protocol_status", "end if;"))
      && squash(between(addCode, "select enqueue.status", "end if;")).replace("v_pilot.project_id", "v_project_id")
        === squash(between(pqAdd, "select enqueue.status", "end if;")));
  check("S33 the slot is inserted last, as an openai_chatgpt baseline of this question",
    addCode.indexOf("insert into public.pilot_question_protocols") > addCode.indexOf("from public.enqueue_protocol_execution_job(")
      && addCode.includes("v_question.id, v_pilot.project_id, p_engine, 'baseline', v_protocol_id"));
  const OUTCOMES = [...new Set([...addCode.matchAll(/'([A-Z][A-Z_]+)'::text/g)].map((m) => m[1]))].sort();
  check("S34 its outcomes are exactly the console's closed set",
    OUTCOMES.join(",") === ["ADDED", "ALREADY_ADDED", "HASH_MISMATCH", "PILOT_CLOSED", "PILOT_ENDED", "PILOT_NOT_FOUND",
      "QUESTION_NOT_FOUND", "QUESTION_RETIRED", "VERSION_NOT_APPROVED"].join(","), OUTCOMES.join(","));
  const typesSrc = read("lib/db/types.ts");
  const tsOutcomes = [...(typesSrc.match(/export type AddPilotQuestionEngineOutcome =([\s\S]*?);/)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
  check("S35 the TypeScript outcome union and the Supabase adapter's closed list are the same set",
    tsOutcomes.join(",") === OUTCOMES.join(",")
      && OUTCOMES.every((o) => between(read("lib/db/supabase-adapter.ts"), "async addPilotQuestionEngine(", "\n  },\n").includes(`"${o}"`)));

  // 6. retire_pilot_question: 20261109140000's byte for byte outside the marked declarations and block.
  const oldRetire = between(S140, "create or replace function public.retire_pilot_question(", "\n$$;\n");
  const newRetire = between(RAW, "create or replace function public.retire_pilot_question(", "\n$$;\n");
  const rBlocks = markedBlocks(newRetire);
  const oldBlock = between(oldRetire, "  select pqp.protocol_id into v_slot_protocol_id\n",
    "      return query select 'QUESTION_RETRYABLE'::text;\n      return;\n    end if;\n  end if;\n");
  const restoredRetire = rBlocks.length === 2
    ? newRetire.replace(rBlocks[0].text, "").replace(rBlocks[1].text, oldBlock)
    : "";
  check("S36 retire has two marked blocks: three declarations, then the slot checks",
    rBlocks.length === 2 && rBlocks[0].code === "  v_stopped boolean := false;\n  v_retryable boolean := false;\n  v_slot_retryable boolean;\n"
      && newRetire.indexOf(rBlocks[0].text) < newRetire.indexOf("\nbegin\n"));
  check("S37 retire_pilot_question is 20261109140000's definition byte for byte outside the marked declarations and block",
    oldBlock.length > 2000 && restoredRetire === oldRetire);
  const block = rBlocks[1]?.text ?? "";
  check("S38 the activity check covers every slot of the question and every retest of each",
    block.includes("from public.pilot_question_protocols pqp\n      join public.protocols pr\n        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id")
      && block.includes("where pqp.pilot_question_id = v_question.id\n       and (")
      && !block.includes("perplexity_sonar") && block.indexOf("'QUESTION_JOB_ACTIVE'::text") < block.indexOf("for v_slot_protocol_id in"));
  const oldGates = between(oldBlock, "  if v_job.status = 'failed'\n", "<= v_protocol.run_cap then\n");
  check("S39 each baseline slot is judged by the same stopped and retry gates as before, whitespace aside",
    oldGates.length > 500 && squash(block).includes(squash(oldGates))
      && block.includes("and pqp.phase = 'baseline'") && block.includes("v_job.status not in ('failed', 'abandoned_exhausted')"));
  check("S40 one stopped slot retires the question; otherwise RETRYABLE when a slot can be retried, else NOT_STOPPED; the 5-retirement limit stays",
    block.includes("if not v_stopped then\n    if v_retryable then\n      return query select 'QUESTION_RETRYABLE'::text;\n    else\n      return query select 'QUESTION_NOT_STOPPED'::text;")
      && newRetire.includes("if v_retired >= 5 then") && newRetire.indexOf(block) < newRetire.indexOf("if v_retired >= 5 then"));

  // 7. The capability probe, and every privilege.
  check("S41 protocol_worker_capabilities() returns exactly live_openai_chatgpt, immutable SQL",
    CODE.includes("create or replace function public.protocol_worker_capabilities()\nreturns text[]\nlanguage sql\nimmutable\nsecurity definer\nset search_path = public, pg_temp\nas $$\n  select array['live_openai_chatgpt']::text[];\n$$;"));
  const SIGNATURES = [
    ["add_pilot_question_engine(uuid, uuid, text, uuid)", "add_pilot_question_engine"],
    ["retire_pilot_question(uuid, uuid, uuid, text)", "retire_pilot_question"],
    ["protocol_worker_capabilities()", "protocol_worker_capabilities"],
  ] as const;
  check("S42 each new or redefined pilot function is revoked from public, anon and authenticated and granted to service_role only",
    SIGNATURES.every(([sig]) => ["public", "anon", "authenticated"].every((r) => CODE.includes(`revoke all on function public.${sig} from ${r};`))
      && CODE.includes(`grant execute on function public.${sig} to service_role;`))
      && (CODE.match(/grant execute on function/g) ?? []).length === 4);
  const blocks = CODE.split(/create\s+or\s+replace\s+function/i).slice(1);
  check("S43 every function is SECURITY DEFINER with a pinned search_path (persist keeps 0054's pg_catalog)",
    blocks.length === 5 && blocks.every((b) => /security definer/i.test(b.slice(0, 600))
      && (/set search_path = public, pg_temp/.test(b.slice(0, 600)) || /set search_path = pg_catalog, pg_temp/.test(b.slice(0, 600)))));
  check("S44 no m7 guard's trap word is written (a later migration must not mention them)",
    !/function public\.retest_eligibility|protocol_execution_phase|_assert_attempt_kind_matches_phase/i.test(RAW)
      && !/create\s+(or\s+replace\s+)?function[\s\S]{0,120}?approve_protocol\s*\(/i.test(CODE));

  // Wiring.
  const preflight = read("scripts/sql/prod-preflight.sql");
  check("S45 the preflight lists the version in both P2.4 lists and the three new functions as absent",
    (preflight.match(/'20261109180000'/g) ?? []).length === 2
      && ["add_pilot_question_engine", "protocol_worker_capabilities", "pilot_question_protocols_consistency"].every((f) => preflight.includes(`('${f}')`)));
  check("S46 the preflight pins persist_probe_result_for_job's production state by md5 (it is redefined here)",
    /to_regprocedure\('public\.persist_probe_result_for_job\(uuid,uuid,uuid,jsonb\)'\)/.test(preflight)
      && /'persist_probe_result_for_job is exactly as 0054 left it \(md5 of its definition\)',\s*\(select coalesce\(md5\(pg_get_functiondef\(oid\)\), 'missing'\) from persist\) = '[0-9a-f]{32}'/.test(preflight));
  check("S47 the DB runner runs the phase B database test, and the command is registered",
    read("scripts/run-p2-workspace-db-local.sh").includes("npx tsx scripts/test-chatgpt-phase-b-db.ts")
      && (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["test:chatgpt-phase-b-schema"] === "tsx scripts/test-chatgpt-phase-b-schema.ts");

  /* M: memory mirrors ------------------------------------------------------ */
  console.log("\n[M] memory mirrors");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;
  interface Store {
    protocols: Map<string, Protocol>;
    protocolExecutionJobs: Map<string, ProtocolExecutionJob>;
    pilotQuestionProtocols: Map<string, { pilotQuestionId: string; protocolId: string; engine: string; phase: string }>;
    pilotQuestions: Map<string, { id: string; pilotId: string; buyerQuestionVersionId: string; promptHash: string }>;
    buyerQuestionVersions: Map<string, { id: string; promptHash: string }>;
    protocolAttempts: Map<string, unknown>;
    probeRuns: Map<string, { platform: string; probeMode: string }>;
  }
  const store = () => (globalThis as unknown as Record<string, Store>)["__zypact_memory_store__"];
  const FOUNDER = "11111111-1111-4111-8111-111111111111";
  const today = new Date().toISOString().slice(0, 10);
  const question = (n: number) => `Which phase B tools suit a shop of ${n} people?`;
  const throwsWith = async (fn: () => Promise<unknown>, re: RegExp): Promise<boolean> => {
    try { await fn(); return false; } catch (e) { return e instanceof Error && re.test(e.message); }
  };
  const newPilot = async (domain: string) => (await db.createPilot({
    createdBy: FOUNDER, companyName: `Phase B ${domain}`, websiteUrl: `https://${domain}`, normalizedDomain: domain,
    siteControlNote: "The customer added the DNS record we sent.", questionLimit: 15, startsOn: today, idempotencyKey: randomUUID(),
  })).pilotId!;
  const newQuestion = async (pilotId: string, n: number) => db.addPilotQuestion({
    pilotId, addedBy: FOUNDER, questionText: question(n), promptHash: sha(question(n)), questionProvenance: "customer_supplied",
    customerApprovalRef: "Email of 12 Nov", customerApprovedOn: today, idempotencyKey: randomUUID(),
  });
  const addEngine = (pilotId: string, pilotQuestionId: string, engine = "openai_chatgpt") =>
    db.addPilotQuestionEngine({ pilotId, pilotQuestionId, engine: engine as "openai_chatgpt", addedBy: FOUNDER });

  const p1 = await newPilot("phase-b-m1.example");
  const q1 = await newQuestion(p1, 1);
  const a1 = await addEngine(p1, q1.pilotQuestionId!);
  const cg = store().protocols.get(a1.protocolId ?? "");
  const px = store().protocols.get(q1.protocolId!);
  check("M1 ChatGPT is added: an approved openai_chatgpt protocol on the question's own version, with D-059's caps, queued",
    a1.outcome === "ADDED" && !!cg && !!px && cg.provider === "openai_chatgpt" && cg.surface === "answer"
      && cg.buyerQuestionVersionId === px.buyerQuestionVersionId && cg.status === "approved"
      && cg.plannedBaselineRuns === 5 && cg.runCap === 7 && cg.retryCap === 2 && cg.spendCapUsd === 4
      && JSON.stringify(cg.paraphrasePlan) === JSON.stringify(px.paraphrasePlan)
      && cg.modelConfig.setting_version === CHATGPT_APPROVED_SETTING_VERSION && cg.modelConfig.model === approved?.model
      && store().protocolExecutionJobs.get(a1.jobId ?? "")?.status === "queued");
  const slots1 = [...store().pilotQuestionProtocols.values()].filter((s) => s.pilotQuestionId === q1.pilotQuestionId);
  check("M2 the question has two baseline slots, one per engine, each on its own protocol",
    slots1.length === 2 && slots1.some((s) => s.engine === "openai_chatgpt" && s.protocolId === a1.protocolId)
      && slots1.some((s) => s.engine === "perplexity_sonar" && s.protocolId === q1.protocolId));
  const replay = await addEngine(p1, q1.pilotQuestionId!);
  check("M3 a repeated press answers the same slot, protocol and job", replay.outcome === "ALREADY_ADDED"
    && replay.protocolId === a1.protocolId && replay.jobId === a1.jobId
    && [...store().pilotQuestionProtocols.values()].filter((s) => s.pilotQuestionId === q1.pilotQuestionId).length === 2);
  check("M4 only openai_chatgpt is accepted, and arguments are required",
    await throwsWith(() => addEngine(p1, q1.pilotQuestionId!, "perplexity_sonar"), /^pilot_question_engine_not_supported$/)
      && await throwsWith(() => addEngine(p1, q1.pilotQuestionId!, "gemini"), /^pilot_question_engine_not_supported$/)
      && await throwsWith(() => db.addPilotQuestionEngine({ pilotId: p1, pilotQuestionId: "", engine: "openai_chatgpt", addedBy: FOUNDER }), /^invalid_add_pilot_question_engine_args$/));
  check("M5 an unknown pilot or question, or another pilot's question, answers not found",
    (await addEngine(randomUUID(), q1.pilotQuestionId!)).outcome === "PILOT_NOT_FOUND"
      && (await addEngine(p1, randomUUID())).outcome === "QUESTION_NOT_FOUND"
      && (await addEngine(await newPilot("phase-b-m5.example"), q1.pilotQuestionId!)).outcome === "QUESTION_NOT_FOUND");
  const pq = (id: string) => store().pilotQuestions.get(id)!;
  const q2 = await newQuestion(p1, 2);
  const version2 = store().buyerQuestionVersions.get(pq(q2.pilotQuestionId!).buyerQuestionVersionId)!;
  store().buyerQuestionVersions.set(version2.id, { ...version2, promptHash: sha("another text") }); // test setup: a version whose hash differs
  check("M6 a question whose version's hash differs is refused and nothing is written",
    (await addEngine(p1, q2.pilotQuestionId!)).outcome === "HASH_MISMATCH"
      && [...store().protocols.values()].filter((p) => p.provider === "openai_chatgpt").length === 1);
  store().buyerQuestionVersions.set(version2.id, version2);
  const pilots = (globalThis as unknown as Record<string, { pilots: Map<string, Record<string, unknown>> }>)["__zypact_memory_store__"].pilots;
  const p1row = pilots.get(p1)!;
  pilots.set(p1, { ...p1row, endsOn: "2000-01-01" }); // test setup: past its end date
  check("M7 a pilot past its end date refuses, but the existing slot still replays",
    (await addEngine(p1, q2.pilotQuestionId!)).outcome === "PILOT_ENDED" && (await addEngine(p1, q1.pilotQuestionId!)).outcome === "ALREADY_ADDED");
  pilots.set(p1, { ...p1row, status: "closed" }); // test setup: closed
  check("M8 a closed pilot refuses", (await addEngine(p1, q2.pilotQuestionId!)).outcome === "PILOT_CLOSED");
  pilots.set(p1, p1row);

  // The per-engine liveness rule at approval.
  const draftOn = async (provider: string, versionId: string, projectId: string) => db.createProtocol({
    projectId, buyerQuestionVersionId: versionId, provider, surface: "answer", plannedBaselineRuns: 5, plannedRetestRuns: 0,
    unitOfAnalysis: "buyer_question_version", primaryMetric: "presence_rate", samplePlanningMethod: "fixed",
    runCap: 7, spendCapUsd: 2, timeWindowSeconds: 86400, rateLimitPerHour: 10, concurrencyLimit: 1, retryCap: 2,
  });
  const v1 = px!.buyerQuestionVersionId;
  const proj = px!.projectId;
  const dupSonar = await draftOn("perplexity", v1, proj);
  const dupGpt = await draftOn("openai_chatgpt", v1, proj);
  const viaApproval = async (id: string) => {
    try { await db.approveProtocol({ protocolId: id, projectId: proj, approvedBy: FOUNDER }); return "approved"; }
    catch (e) { return (e as { code?: string }).code === "23505" && /protocols_one_live_baseline_per_engine/.test((e as Error).message) ? "23505" : String(e); }
  };
  check("M9 a second live baseline on a version is refused per engine: another Perplexity string, and a second ChatGPT",
    (await viaApproval(dupSonar.id)) === "23505" && (await viaApproval(dupGpt.id)) === "23505"
      && store().protocols.get(dupSonar.id)?.status === "draft" && store().protocols.get(dupGpt.id)?.status === "draft");
  const q3 = await newQuestion(p1, 3);
  const v3 = pq(q3.pilotQuestionId!).buyerQuestionVersionId;
  const agentOn3 = await draftOn("perplexity_agent", v3, proj);
  check("M10 Perplexity's Agent provider is the Perplexity engine; ChatGPT beside Perplexity is allowed",
    (await viaApproval(agentOn3.id)) === "23505" && (await addEngine(p1, q3.pilotQuestionId!)).outcome === "ADDED");

  // The slot rules (the CHECK and the trigger), through a ChatGPT add whose protocol would clash.
  const q4 = await newQuestion(p1, 4);
  const v4 = pq(q4.pilotQuestionId!).buyerQuestionVersionId;
  const squatter = await draftOn("openai_chatgpt", v4, proj);
  await db.approveProtocol({ protocolId: squatter.id, projectId: proj, approvedBy: FOUNDER }); // test setup: a live ChatGPT baseline outside any slot
  const beforeCount = store().protocols.size;
  check("M11 when approval refuses (a live ChatGPT baseline already on the version), nothing is left behind",
    await throwsWith(() => addEngine(p1, q4.pilotQuestionId!), /protocols_one_live_baseline_per_engine/)
      && store().protocols.size === beforeCount
      && ![...store().pilotQuestionProtocols.values()].some((s) => s.pilotQuestionId === q4.pilotQuestionId && s.engine === "openai_chatgpt"));

  // retire_pilot_question over two slots.
  const p2 = await newPilot("phase-b-m2.example");
  const r1 = await newQuestion(p2, 10);
  const r1c = await addEngine(p2, r1.pilotQuestionId!);
  const retire = (pilotId: string, pilotQuestionId: string) =>
    db.retirePilotQuestion({ pilotId, pilotQuestionId, retiredBy: FOUNDER, reason: "The ChatGPT measurement cannot go on." });
  const setJob = (id: string, over: Partial<ProtocolExecutionJob>) => store().protocolExecutionJobs.set(id, { ...store().protocolExecutionJobs.get(id)!, ...over });
  check("M12 with both slots queued the question is not stopped", (await retire(p2, r1.pilotQuestionId!)) === "QUESTION_NOT_STOPPED");
  const run = await db.requestProtocolJobRun({ jobId: r1c.jobId!, projectId: store().protocolExecutionJobs.get(r1c.jobId!)!.projectId, via: "admin_pilot_run", requestedBy: FOUNDER, ttlSeconds: 120 });
  setJob(r1c.jobId!, { status: "failed", failureReason: "PROVIDER_ADAPTER_NOT_ENABLED", currentAttemptId: null }); // test setup: the worker refused it before admission
  check("M13 a pending Run on the ChatGPT slot blocks retirement", run.outcome === "REQUESTED" && (await retire(p2, r1.pilotQuestionId!)) === "QUESTION_JOB_ACTIVE");
  await db.cancelProtocolJobRunRequest(run.requestId!);
  setJob(r1.jobId!, { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }); // test setup: Perplexity running
  check("M14 a live Perplexity lease blocks retirement too", (await retire(p2, r1.pilotQuestionId!)) === "QUESTION_JOB_ACTIVE");
  setJob(r1.jobId!, { status: "succeeded", leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }); // test setup: Perplexity finished
  const retiredAt = (id: string) => (store().pilotQuestions.get(id) as unknown as { retiredAt: string | null }).retiredAt;
  check("M15 Perplexity finished and ChatGPT failed for good: the question is retired with both slots",
    (await retire(p2, r1.pilotQuestionId!)) === "RETIRED" && retiredAt(r1.pilotQuestionId!) !== null
      && [...store().pilotQuestionProtocols.values()].filter((s) => s.pilotQuestionId === r1.pilotQuestionId).length === 2);
  const r2 = await newQuestion(p2, 11);
  const r2c = await addEngine(p2, r2.pilotQuestionId!);
  setJob(r2c.jobId!, { status: "failed", failureReason: "provider_error", currentAttemptId: null, nextBaselineOrdinal: 1 });
  (store().protocolAttempts as Map<string, unknown>).set(randomUUID(), {
    id: randomUUID(), projectId: store().protocolExecutionJobs.get(r2c.jobId!)!.projectId, jobId: r2c.jobId!, protocolId: r2c.protocolId!,
    status: "failed", terminalizedAt: new Date().toISOString(), baselineOrdinal: 1, retryOfAttemptId: null,
  }); // test setup: one failed provider attempt in slot 1, retryable
  check("M16 a ChatGPT slot that can still be retried, beside a queued Perplexity slot, is RETRYABLE",
    (await retire(p2, r2.pilotQuestionId!)) === "QUESTION_RETRYABLE");
  setJob(r2.jobId!, { status: "abandoned_exhausted" }); // test setup: Perplexity abandoned
  check("M17 once the other slot stopped for good, the question is retired", (await retire(p2, r2.pilotQuestionId!)) === "RETIRED");

  // The probe-run CHECKs at start, and the platform at persist.
  const p3 = await newPilot("phase-b-m3.example");
  const s1 = await newQuestion(p3, 20);
  const s1c = await addEngine(p3, s1.pilotQuestionId!);
  const job = store().protocolExecutionJobs.get(s1c.jobId!)!;
  const requested = await db.requestProtocolJobRun({ jobId: job.id, projectId: job.projectId, via: "admin_pilot_run", requestedBy: FOUNDER, ttlSeconds: 120 });
  const claimed = await db.claimRequestedProtocolExecutionJob({ workerId: "phase-b", leaseSeconds: 60 });
  const admitted = await db.admitAndReserveAttemptForJob({
    jobId: job.id, claimToken: claimed.claimToken!, projectId: job.projectId, attemptKind: "baseline",
    idempotencyKey: `${job.id}:baseline:1`, perplexityReservedCostUsd: 0.54, analysisReservedCostUsd: 0.02, retryOfAttemptId: null,
  });
  const start = (platform: string, probeMode: string) => db.createProbeRunAndStartAttemptForJob({
    jobId: job.id, claimToken: claimed.claimToken!, projectId: job.projectId, attemptId: admitted.attempt!.id, platform, probeMode: probeMode as ProbeMode,
  });
  check("M18 a probe mode or platform the database refuses is refused at run start, before anything is written",
    requested.outcome === "REQUESTED" && claimed.outcome === "CLAIMED" && admitted.outcome === "RESERVED"
      && await throwsWith(() => start("chatgpt", "live_openai_chatgpt_v2"), /^probe_runs_probe_mode_check violated/)
      && await throwsWith(() => start("openai", "live_openai_chatgpt"), /^probe_runs_platform_check violated/)
      && (store().protocolAttempts.get(admitted.attempt!.id) as { status?: string } | undefined)?.status === "reserved"
      && [...store().probeRuns.values()].every((r) => r.platform !== "openai" && r.probeMode !== "live_openai_chatgpt_v2"));
  const started = await start("chatgpt", "live_openai_chatgpt");
  check("M19 the ChatGPT mode and platform are accepted", started.outcome === "STARTED"
    && started.probeRun?.platform === "chatgpt" && started.probeRun?.probeMode === "live_openai_chatgpt");
  const memorySrc = read("lib/db/memory-adapter.ts");
  const persistSrc = between(memorySrc, "async persistProbeResultForJob(", "\n  },\n");
  check("M20 the memory persist takes the platform from the probe run, in its canonical fields and its row",
    (persistSrc.match(/platform: probeRun\.platform,/g) ?? []).length === 2 && !persistSrc.includes('platform: "perplexity"'));
  check("M21 the capability list is the migration's", JSON.stringify(await db.protocolWorkerCapabilities()) === JSON.stringify(["live_openai_chatgpt"]));

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "ChatGPT phase B schema PASSED." : `${failures} check(s) failed. ChatGPT phase B schema FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
