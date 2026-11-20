#!/usr/bin/env tsx
/**
 * The pilot retest (D-062), offline: the static contract of
 * supabase/migrations/20261109190000_pilot_retest.sql.
 *
 *   L  placement: inside D-058's window directly after 20261109180000; the
 *      header names D-062, expected_prev=20261109180000 and the worker
 *      stopped; nothing from the account stack;
 *   P  parity: save_pilot_report_artifact and share_pilot_report_artifact are
 *      20261109160000's bodies byte for byte outside one marked D-062 block
 *      each, sliced as test-pilot-actions.ts M9 and M14 slice them; each block
 *      sits where D-062 places it; its refusal codes, statuses and literals;
 *   H  the precondition pins: each md5 literal is the md5 of 20261109160000's
 *      body source (prosrc) as it stands in that file, hashed with carriage
 *      returns removed (PF-30) in the precondition and the postcondition;
 *   D  definitions: exactly the 13 new functions plus save and share; none of
 *      them is defined by any other migration; no 0071-0079, 20261109180000
 *      or other existing function is redefined;
 *   G  every M7 "no later migration" guard, with its exact pattern, run on
 *      this file alone (so "the existing failures do not get worse" is
 *      observable), and D-062's raw-text rules;
 *   W  the wrapped M7 calls: each in its own step, after that step's
 *      pilot_retest_steps insert, followed by its strict row check and a
 *      raise, never inside an exception handler; retest job rows locked only
 *      with NOWAIT;
 *   X  SECURITY DEFINER, search_path, the four privilege lines of each step,
 *      no grant on the helper or the trigger functions; the preconditions
 *      (the table locks before precondition 6) and the postconditions;
 *   T  the TypeScript constants equal the SQL: action types, note kinds,
 *      step kinds, group states, the bounds, the outcome rule, the footer and
 *      withheld literals, the four statuses;
 *   F  the preflight lists the version in both P2.4 lists, the four tables
 *      and the 13 functions as pending, with counts 24 and 54; the DB runner
 *      and the command are wired;
 *   M  the memory adapter mirrors the slot table: a retest slot is refused
 *      with the database trigger's message.
 *
 * The same rules against a real PostgreSQL are in test-pilot-retest-db.ts.
 * No database, no network, no provider.
 */
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ACTION_TYPES } from "@/lib/interventions/types";
import {
  MAX_OBSERVATION_DAYS,
  MAX_REQUEUES,
  MAX_RETEST_NOTES,
  MAX_RETEST_QUESTIONS,
  MAX_RETESTS_PER_PILOT,
  MIN_OBSERVATION_DAYS,
  PILOT_END_MARGIN_DAYS,
  PILOT_OUTCOME_RULE,
  RETEST_GROUP_STATES,
  RETEST_NOTE_KINDS,
  RETEST_PLANNED_RUNS,
  RETEST_STEP_KINDS,
  RETEST_TEXT_BOUNDS,
  implementByDay,
  retestGroupState,
} from "@/lib/pilots/retest-rules";
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import { PILOT_RETEST_WITHHELD_TEXT } from "@/lib/reports/pilot-retest-copy";
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
const FILE = "20261109190000_pilot_retest.sql";
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const RAW = read(path.join(DIR, FILE));
const CODE = RAW.replace(/--[^\n]*/g, "");
const FLAT = CODE.replace(/\s+/g, " ");
/** The M7 guards' own comment stripping: block comments and whole-line `--` comments only. */
const STRIPPED = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const PA = read(path.join(DIR, "20261109160000_pilot_actions.sql"));
const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");

/** A function's definition from `create or replace function public.<name>(` through its closing `$$;`. */
function fnDef(sql: string, name: string): string {
  const s = sql.indexOf(`create or replace function public.${name}(`);
  return s < 0 ? "" : sql.slice(s, sql.indexOf("\n$$;", s) + 4);
}
/** The body source Postgres stores (prosrc): between `as $$` and the closing `$$`. */
function prosrc(sql: string, name: string): string {
  const def = fnDef(sql, name);
  const a = def.indexOf("as $$") + "as $$".length;
  return def.slice(a, def.length - "$$;".length);
}

const WRITERS = [
  "register_pilot_retest", "confirm_pilot_retest_implementation", "prepare_pilot_retests",
  "abandon_pilot_retest", "requeue_pilot_retest_job", "add_pilot_retest_note",
];
const HELPER = "pilot_retest_job_is_final";
const TRIGGER_FNS = [
  "pilot_retests_guard", "pilot_retest_rows_append_only", "pilot_retest_slot_check",
  "pilot_retest_intervention_guard", "pilot_retest_protocol_guard", "pilot_retest_card_guard",
];
const NEW_FUNCTIONS = [HELPER, ...WRITERS, ...TRIGGER_FNS];
const TABLES = ["pilot_retests", "pilot_retest_members", "pilot_retest_notes", "pilot_retest_steps"];
const TRIGGERS: [string, string, string, string][] = [
  ["pilot_retests_guard", "before update or delete", "pilot_retests", "pilot_retests_guard"],
  ["pilot_retest_members_append_only", "before update or delete", "pilot_retest_members", "pilot_retest_rows_append_only"],
  ["pilot_retest_notes_append_only", "before update or delete", "pilot_retest_notes", "pilot_retest_rows_append_only"],
  ["pilot_retest_steps_append_only", "before update or delete", "pilot_retest_steps", "pilot_retest_rows_append_only"],
  ["pilot_question_protocols_retest_slot", "before insert", "pilot_question_protocols", "pilot_retest_slot_check"],
  ["interventions_pilot_retest_guard", "before insert or update", "interventions", "pilot_retest_intervention_guard"],
  ["protocols_pilot_retest_guard", "before insert", "protocols", "pilot_retest_protocol_guard"],
  ["outcome_card_artifacts_pilot_retest_guard", "before insert or update", "outcome_card_artifacts", "pilot_retest_card_guard"],
];

async function main(): Promise<void> {
  /* L: placement ----------------------------------------------------------- */
  console.log("[L] placement");
  const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok).map((r) => (r.ok ? r.version : 0));
  const parsed = parseMigrationName(FILE);
  const version = parsed.ok ? parsed.version : 0;
  check("L1 the version is inside D-058's window (after 20261109160000, before 20261110120000) and directly follows 20261109180000",
    parsed.ok && parsed.kind === "timestamp" && version > 20261109180000 && version < 20261110120000
      && versions.includes(20261109180000) && versions.includes(20261110120000)
      && !versions.some((v) => v > 20261109180000 && v < version));
  check("L2 the header names D-062, expected_prev=20261109180000, the worker stopped, and both recoveries (before a group, forward only after)",
    /\(D-062\)/.test(RAW.slice(0, 600)) && RAW.includes("expected_prev=20261109180000") && RAW.includes("Apply with the protocol worker stopped")
      && RAW.includes("--   * Before any pilot_retests row exists") && RAW.includes("--   * Once a group exists, recovery is forward only"));
  check("L3 nothing from the account stack is referenced, in code or comments",
    !/\b(workspace[a-z_]*|account_[a-z_]+|_q2p[a-z0-9_]*|_s1_[a-z_]*|_p1_[a-z_]*|_e1_[a-z_]*|_q4_[a-z_]*)\b/i.test(RAW));

  /* P: save and share parity ---------------------------------------------- */
  console.log("\n[P] save and share");
  const NEW_SAVE = fnDef(RAW, "save_pilot_report_artifact");
  const OLD_SAVE = fnDef(PA, "save_pilot_report_artifact");
  const sStart = NEW_SAVE.indexOf("  -- D-062 begin");
  const sEnd = NEW_SAVE.indexOf("  -- D-062 end\n");
  const saveWithout = sStart > 0 && sEnd > sStart ? NEW_SAVE.slice(0, sStart) + NEW_SAVE.slice(sEnd + "  -- D-062 end\n".length + 1) : "";
  check("P1 save_pilot_report_artifact is 20261109160000's body byte for byte apart from the marked D-062 block",
    OLD_SAVE !== "" && saveWithout === OLD_SAVE, `${saveWithout.length} vs ${OLD_SAVE.length}`);
  const saveBlock = sStart > 0 ? NEW_SAVE.slice(sStart, sEnd) : "";
  check("P2 the save block runs after the D-057 block and before the revision is numbered, and declares its own variables",
    NEW_SAVE.indexOf("  -- D-057 end\n") < sStart && sEnd < NEW_SAVE.indexOf("select coalesce(max(pra.revision), 0) + 1 into v_revision")
      && /^ {2}-- D-062 begin[^\n]*\n(?: {2}--[^\n]*\n)* {2}declare\n/.test(saveBlock) && (NEW_SAVE.match(/  -- D-062 begin/g) ?? []).length === 1);
  const SAVE_CODES = ["RETESTS_CHANGED", "RETEST_CARD_MISMATCH", "RETEST_CARDS_INCOMPLETE", "RETEST_CARD_CHANGED_SINCE_SHARED", "RETEST_CONTENT_MISMATCH"];
  check("P3 the save block's five refusals appear in D-062's order, after its 22023 shape check",
    SAVE_CODES.every((c) => saveBlock.includes(`'${c}'::text`))
      && SAVE_CODES.every((c, i) => i === 0 || saveBlock.indexOf(`'${SAVE_CODES[i - 1]}'::text`) < saveBlock.indexOf(`'${c}'::text`))
      && saveBlock.indexOf("'invalid_save_pilot_report_args'") < saveBlock.indexOf("'RETESTS_CHANGED'::text"));
  const STATUSES: OutcomeStatus[] = ["increase_observed", "decrease_observed", "no_clear_change", "inconclusive"];
  check("P4 the save block holds the four statuses, the footer literal, the withheld literal and the integrity_passed refusal",
    saveBlock.includes(`array['${STATUSES.join("', '")}']`) && saveBlock.includes(`'${NON_CAUSALITY_FOOTER}'`)
      && saveBlock.includes(`'${PILOT_RETEST_WITHHELD_TEXT}'`)
      && /jsonb_array_length\(v_m_retests\) > 0 and p_integrity_status = 'integrity_passed'/.test(saveBlock));
  check("P5 the cards are exactly the members of groups not abandoned with a final retest that has an attempt (M1), the shared cards are frozen, and content is not checked in a blocked revision",
    /public\.pilot_retest_job_is_final\(j\.id\) is true/.test(saveBlock) && /r\.abandoned_at is null/.test(saveBlock)
      && /pra\.shared_at is not null\s+order by pra\.revision desc\s+limit 1/.test(saveBlock) && /if p_integrity_status <> 'blocked' then/.test(saveBlock));
  const NEW_SHARE = fnDef(RAW, "share_pilot_report_artifact");
  const OLD_SHARE = fnDef(PA, "share_pilot_report_artifact");
  const hStart = NEW_SHARE.indexOf("  -- D-062 begin");
  const hEnd = NEW_SHARE.indexOf("  -- D-062 end\n");
  const shareWithout = hStart > 0 && hEnd > hStart ? NEW_SHARE.slice(0, hStart) + NEW_SHARE.slice(hEnd + "  -- D-062 end\n".length + 1) : "";
  check("P6 share_pilot_report_artifact is 20261109160000's body byte for byte apart from the marked D-062 block",
    OLD_SHARE !== "" && shareWithout === OLD_SHARE, `${shareWithout.length} vs ${OLD_SHARE.length}`);
  const shareBlock = hStart > 0 ? NEW_SHARE.slice(hStart, hEnd) : "";
  check("P7 the share block runs after the D-057 block and before the acknowledgement check: RETEST_IN_PROGRESS, then RETESTS_STALE",
    NEW_SHARE.indexOf("  -- D-057 end\n") < hStart && hEnd < NEW_SHARE.indexOf("'ACKNOWLEDGEMENT_REQUIRED'")
      && shareBlock.indexOf("'RETEST_IN_PROGRESS'::text") > 0 && shareBlock.indexOf("'RETEST_IN_PROGRESS'::text") < shareBlock.indexOf("'RETESTS_STALE'::text")
      && /s\.phase = 'retest'/.test(shareBlock) && /v_art\.manifest -> 'retestJobs'/.test(shareBlock));
  check("P7b the share re-checks M1 (engineer, DB-1): the manifest's cards are exactly the members of groups not abandoned whose retest has an attempt and is final now, else RETESTS_STALE",
    /v_art\.manifest -> 'retestCards'/.test(shareBlock) && /public\.pilot_retest_job_is_final\(j\.id\) is true/.test(shareBlock)
      && /r\.abandoned_at is null/.test(shareBlock)
      && shareBlock.indexOf("public.pilot_retest_job_is_final(j.id)") < shareBlock.lastIndexOf("'RETESTS_STALE'::text"));

  /* H: the precondition pins ---------------------------------------------- */
  console.log("\n[H] precondition pins");
  const saveMd5 = md5(prosrc(PA, "save_pilot_report_artifact"));
  const shareMd5 = md5(prosrc(PA, "share_pilot_report_artifact"));
  const pre4 = RAW.slice(RAW.indexOf("-- 4. What this migration overwrites"), RAW.indexOf("-- 5. None of the objects"));
  check("H1 precondition 4 pins md5(prosrc) with carriage returns removed (PF-30) of 20261109160000's save and share, each literal the md5 of that body as it stands in its file",
    pre4.includes(`is distinct from '${saveMd5}'`) && pre4.includes(`is distinct from '${shareMd5}'`)
      && (pre4.match(/select md5\(replace\(p\.prosrc, chr\(13\), ''\)\) from pg_proc p/g) ?? []).length === 2 && !/md5\(p\.prosrc\)/.test(pre4)
      && pre4.indexOf("save_pilot_report_artifact(uuid,uuid,text,jsonb,jsonb,text,jsonb,timestamptz)") > 0
      && pre4.indexOf("share_pilot_report_artifact(uuid,uuid,uuid,boolean)") > 0, `${saveMd5} ${shareMd5}`);
  check("H2 the postconditions assert both are no longer those bodies, hashed the same way", RAW.slice(RAW.indexOf("6. Postconditions")).includes(`= '${saveMd5}'`)
    && RAW.slice(RAW.indexOf("6. Postconditions")).includes(`= '${shareMd5}'`)
    && (RAW.slice(RAW.indexOf("6. Postconditions")).match(/select md5\(replace\(p\.prosrc, chr\(13\), ''\)\) from pg_proc p/g) ?? []).length === 2
    && !/md5\(p\.prosrc\)/.test(RAW));

  /* D: definitions --------------------------------------------------------- */
  console.log("\n[D] definitions");
  const FUNCTION_DEF = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/gi;
  const defined = [...RAW.matchAll(FUNCTION_DEF)].map((m) => m[1]).sort();
  check("D1 it defines exactly the 13 new functions plus the save and share redefinitions (raw text, comments included)",
    defined.join(",") === [...NEW_FUNCTIONS, "save_pilot_report_artifact", "share_pilot_report_artifact"].sort().join(","), defined.join(","));
  const others = readdirSync(DIR).filter((f) => f.endsWith(".sql") && f !== FILE);
  const elsewhere = new Set<string>();
  for (const f of others) for (const m of read(path.join(DIR, f)).matchAll(FUNCTION_DEF)) elsewhere.add(m[1]);
  check("D2 none of the 13 is defined by any other migration, and the only existing functions redefined are 20261109160000's save and share (no 0071-0079, M5 or 20261109180000 function)",
    NEW_FUNCTIONS.every((f) => !elsewhere.has(f)) && defined.filter((f) => elsewhere.has(f)).join(",") === "save_pilot_report_artifact,share_pilot_report_artifact"
      && others.filter((f) => /create\s+(or\s+replace\s+)?function\s+public\.(save|share)_pilot_report_artifact\(/i.test(read(path.join(DIR, f)))).sort().join(",")
        === "20261109150000_pilot_report_artifacts.sql,20261109160000_pilot_actions.sql");
  check("D3 the only tables created are the four, each on its own `create table` line, and they are created without IF NOT EXISTS (precondition 5 proves absence)",
    (RAW.match(/^create table /gm) ?? []).length === 4 && TABLES.every((t) => RAW.includes(`\ncreate table public.${t} (`)));
  check("D4 no helper prefix: no function name starts with `_`", defined.every((f) => !f.startsWith("_")));
  check("D5 the eight triggers, each on its table and function, with the WHEN clauses on the retest slot and the retest protocol",
    TRIGGERS.every(([name, when, table, fn]) => new RegExp(`create trigger ${name}\\s+${when} on public\\.${table}\\s+for each row\\s+(when \\([^)]*\\)\\s+)?execute function public\\.${fn}\\(\\);`).test(CODE))
      && /create trigger pilot_question_protocols_retest_slot\s+before insert on public\.pilot_question_protocols\s+for each row\s+when \(new\.phase = 'retest'\)/.test(CODE)
      && /create trigger protocols_pilot_retest_guard\s+before insert on public\.protocols\s+for each row\s+when \(new\.baseline_protocol_id is not null\)/.test(CODE)
      && (CODE.match(/create trigger /g) ?? []).length === 8);
  check("D6 the slot table: the phase CHECK widened by name without IF EXISTS, the slot key kept, the member column, its foreign key, CHECK and unique key, and the members' baseline-slot key",
    /alter table public\.pilot_question_protocols\s+drop constraint pilot_question_protocols_phase_check;/.test(CODE)
      && /add constraint pilot_question_protocols_phase_check\s+check \(phase in \('baseline', 'retest'\)\);/.test(CODE)
      && !/drop constraint (if exists )?pilot_question_protocols_slot_key/.test(CODE)
      && /add constraint pilot_question_protocols_slot_protocol_key\s+unique \(pilot_question_id, engine, phase, protocol_id\);/.test(CODE)
      && /add column pilot_retest_member_id uuid null;/.test(CODE)
      && /add constraint pilot_question_protocols_retest_member_fk\s+foreign key \(pilot_retest_member_id, pilot_question_id, engine, project_id\)\s+references public\.pilot_retest_members \(id, pilot_question_id, engine, project_id\)/.test(CODE)
      && /add constraint pilot_question_protocols_retest_member_check\s+check \(\(phase = 'retest'\) = \(pilot_retest_member_id is not null\)\);/.test(CODE)
      && /add constraint pilot_question_protocols_member_key\s+unique \(pilot_retest_member_id\);/.test(CODE)
      && /foreign key \(pilot_question_id, engine, baseline_phase, baseline_protocol_id\)\s+references public\.pilot_question_protocols \(pilot_question_id, engine, phase, protocol_id\)/.test(CODE));
  check("D7 no existing row is updated or deleted outside a function body, and nothing writes an evidence table",
    !/^(update|delete from) public\./im.test(CODE)
      && !/(insert\s+into|update|delete\s+from)\s+public\.(protocol_attempts|protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_runs|probe_results)\b/i.test(CODE));

  /* G: the M7 guards on this file alone, and D-062's raw-text rules -------- */
  console.log("\n[G] the M7 guards, on this file alone");
  const redefines71 = (name: string) =>
    new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,80}?public\\.${name}\\s*\\(`, "i").test(RAW);
  check("G1 0071: neither register_intervention nor approve_intervention is redefined (the 80-character pattern, raw text)",
    !redefines71("register_intervention") && !redefines71("approve_intervention"));
  check("G2 0071: the lifecycle functions are not extended here (raw text)",
    !/create or replace function public\.(confirm_intervention_implementation|_reject_registered_intervention_edit)/i.test(RAW));
  check("G3 0072: the eligibility authority is not redefined (raw text; it is called only as `from public.retest_eligibility(`)",
    !/function public\.retest_eligibility/i.test(RAW) && RAW.includes("from public.retest_eligibility("));
  const definitionRe73 = (name: string) => new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?(function|index)[\\s\\S]{0,120}?\\b${name}\\b`, "i");
  check("G4 0073: create_retest_protocol and both indexes are untouched (the 120-character pattern, comments stripped as 0073 strips them, and raw)",
    ["create_retest_protocol", "protocols_one_live_retest_per_baseline", "protocols_one_live_baseline_per_version"]
      .every((n) => !definitionRe73(n).test(STRIPPED) && !definitionRe73(n).test(RAW)));
  check("G5 0074: neither phase-rule name is written anywhere (raw text)", !/_assert_attempt_kind_matches_phase|protocol_execution_phase/i.test(RAW));
  check("G6 0075: approve_protocol is neither defined nor written with its parenthesis",
    !/create\s+(or\s+replace\s+)?function[\s\S]{0,120}?approve_protocol\s*\(/i.test(STRIPPED) && !RAW.includes("approve_protocol("));
  const OWNED76 = ["save_outcome_card_artifact", "begin_outcome_card_delivery", "finalize_outcome_card_delivery", "release_outcome_card_delivery_claim", "outcome_card_artifact_revision"];
  check("G7 0076: none of its five functions is redefined, nor even named",
    OWNED76.every((n) => !new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,120}?\\b${n}\\b`, "i").test(STRIPPED) && !RAW.includes(n)));
  check("G8 no `create ... function public.` in a comment (a quoted name would demand a preflight pin or a pending entry)",
    [...RAW.matchAll(/^[ \t]*--.*$/gm)].every((m) => !/create\s+(or\s+replace\s+)?function\s+public\./i.test(m[0])));

  /* W: the wrapped calls --------------------------------------------------- */
  console.log("\n[W] the wrapped M7 calls");
  const body = (name: string) => fnDef(RAW, name);
  const WRAPPED: [string, string, string, string][] = [
    ["register_pilot_retest", "'register'", "public.register_intervention(", "pilot_retest_register_failed:register_intervention"],
    ["register_pilot_retest", "'register'", "public.approve_intervention(", "pilot_retest_register_failed:approve_intervention"],
    ["confirm_pilot_retest_implementation", "'confirm'", "public.confirm_intervention_implementation(", "pilot_retest_confirm_failed:confirm_intervention_implementation"],
    ["prepare_pilot_retests", "'prepare'", "public.create_retest_protocol(", "pilot_retest_prepare_failed:"],
    ["prepare_pilot_retests", "'prepare'", "public.enqueue_protocol_execution_job(", "pilot_retest_prepare_failed:"],
    ["abandon_pilot_retest", "'abandon'", "public.abandon_intervention(", "pilot_retest_abandon_failed:abandon_intervention"],
  ];
  const wrappedOk = WRAPPED.map(([fn, step, call, failure]) => {
    const b = body(fn);
    const stepAt = b.search(new RegExp(`insert into public\\.pilot_retest_steps[\\s\\S]{0,300}?${step}`));
    const callAt = b.indexOf(call);
    const raiseAt = b.indexOf(failure, callAt);
    const elsewhere = NEW_FUNCTIONS.filter((f) => f !== fn).every((f) => !body(f).includes(call))
      && !body("save_pilot_report_artifact").includes(call) && !body("share_pilot_report_artifact").includes(call);
    return { label: `${fn}/${call}`, ok: stepAt > 0 && callAt > stepAt && raiseAt > callAt && b.split(call).length === 2 && elsewhere };
  });
  check("W1 each wrapped call appears once, only in its own step, after that step's pilot_retest_steps insert, and is followed by its strict check and raise",
    wrappedOk.every((w) => w.ok), wrappedOk.filter((w) => !w.ok).map((w) => w.label).join(", "));
  check("W2 the strict row checks: exactly one row, and the stamps of this transaction (approved_at = now(), implemented_at = now(), abandoned_at = now()), deviations null",
    /coalesce\(cardinality\(v_rows\), 0\) <> 1/.test(body("register_pilot_retest")) && /v_row\.approved_at is distinct from now\(\)/.test(body("register_pilot_retest"))
      && /v_row\.approved_by is distinct from p_registered_by/.test(body("register_pilot_retest"))
      && /v_row\.implemented_at is distinct from now\(\)/.test(body("confirm_pilot_retest_implementation"))
      && /v_row\.protocol_deviations is not null/.test(body("confirm_pilot_retest_implementation"))
      && /v_row\.abandoned_at is distinct from now\(\)/.test(body("abandon_pilot_retest"))
      && /v_codes\[1\] is distinct from 'CREATED'/.test(body("prepare_pilot_retests")) && /v_queued\[1\] is distinct from 'QUEUED'/.test(body("prepare_pilot_retests")));
  const handlers = WRITERS.map((f) => {
    const b = body(f);
    const blocks = [...b.matchAll(/\n {4}begin\n([\s\S]*?)\n {4}exception\n/g)].map((m) => m[1]);
    return { f, ok: blocks.every((blk) => WRAPPED.every(([, , call]) => !blk.includes(call))) && blocks.every((blk) => /for update nowait/.test(blk)) };
  });
  check("W3 no exception handler surrounds a wrapped call: the only handlers are the NOWAIT job locks (abandon, requeue), which catch lock_not_available only",
    handlers.every((h) => h.ok) && (CODE.match(/exception\s+when lock_not_available then/g) ?? []).length === 2
      && (CODE.match(/\bexception\s+when\b/g) ?? []).length === 2, handlers.filter((h) => !h.ok).map((h) => h.f).join(","));
  check("W4 a group step locks job rows only with NOWAIT (never waits for a protocol_execution_jobs row)",
    WRITERS.every((f) => {
      const b = body(f);
      return [...b.matchAll(/from public\.protocol_execution_jobs j[\s\S]{0,400}?for update( nowait)?/g)].every((m) => m[1] === " nowait");
    }) && /for update nowait/.test(body("abandon_pilot_retest")) && /for update nowait/.test(body("requeue_pilot_retest_job")));
  check("W5 every step locks the pilot row FOR UPDATE first, then (where it has one) its group row",
    WRITERS.every((f) => {
      const b = body(f);
      const pilotLock = b.search(/from public\.pilots p\s+where p\.id = p_pilot_id\s+for update;/);
      const firstStep = b.indexOf("insert into public.pilot_retest_");
      return pilotLock > 0 && (firstStep < 0 || pilotLock < firstStep);
    }) && ["confirm_pilot_retest_implementation", "prepare_pilot_retests", "abandon_pilot_retest", "requeue_pilot_retest_job"].every((f) => {
      const b = body(f);
      return b.search(/from public\.pilots p\s+where p\.id = p_pilot_id\s+for update;/) < b.search(/from public\.pilot_retests r\s+where r\.id = p_pilot_retest_id\s+and r\.pilot_id = p_pilot_id\s+for update;/);
    }));

  /* X: definitions, privileges, pre- and postconditions -------------------- */
  console.log("\n[X] privileges");
  check("X1 the 13 functions are SECURITY DEFINER with search_path = public, pg_temp",
    NEW_FUNCTIONS.every((f) => { const b = body(f).slice(0, 2400); return /security definer/.test(b) && /set search_path = public, pg_temp/.test(b); }));
  const sigOf = (name: string) => RAW.match(new RegExp(`grant execute on function public\\.${name}\\(([^)]*)\\) to service_role;`))?.[1] ?? null;
  check("X2 each step has the four privilege lines exactly (revoke from public, anon, authenticated; grant execute to service_role)",
    WRITERS.every((f) => {
      const sig = sigOf(f);
      return sig !== null && ["public", "anon", "authenticated"].every((r) => RAW.includes(`revoke all on function public.${f}(${sig}) from ${r};`));
    }) && ["save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz)", "share_pilot_report_artifact(uuid, uuid, uuid, boolean)"]
      .every((sig) => ["public", "anon", "authenticated"].every((r) => RAW.includes(`revoke all on function public.${sig} from ${r};`)) && RAW.includes(`grant execute on function public.${sig} to service_role;`))
      && (CODE.match(/grant execute on function/g) ?? []).length === 8);
  check("X3 the helper and the six trigger functions are revoked from every client role, service_role included, and granted to none",
    [HELPER, ...TRIGGER_FNS].every((f) => new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated, service_role;`).test(RAW)
      && !new RegExp(`grant [a-z ]*on function public\\.${f}\\(`).test(RAW)));
  check("X4 the four tables: RLS on, not forced, no policy, service_role may only read them",
    TABLES.every((t) => RAW.includes(`alter table public.${t} enable row level security;`) && RAW.includes(`alter table public.${t} no force row level security;`)
      && RAW.includes(`revoke all on table public.${t} from public, anon, authenticated, service_role;`) && RAW.includes(`grant select on table public.${t} to service_role;`))
      && !/create\s+policy/i.test(CODE) && !/grant\s+(insert|update|delete|all)\b/i.test(CODE));
  const firstChange = CODE.search(/\ncreate table public\.pilot_retests \(/);
  const pre = CODE.slice(0, firstChange);
  check("X5 six precondition blocks come before the first change, each raising P0001; the table locks open precondition 6, before its reference checks",
    (pre.match(/\ndo \$\$/g) ?? []).length === 6 && (pre.match(/errcode = 'P0001'/g) ?? []).length >= 6
      && /lock table public\.interventions, public\.protocols, public\.outcome_card_artifacts in share row exclusive mode;/.test(pre)
      && pre.indexOf("lock table public.interventions") < pre.indexOf("from public.interventions i\n         join public.pilot_question_protocols s"));
  const post = CODE.slice(CODE.lastIndexOf("\ndo $$"));
  check("X6 one postcondition block after every change asserts the phase CHECK, the constraints, RLS and table privileges, the function privileges, the eight triggers by tgtype, and the redefinitions",
    CODE.lastIndexOf("\ndo $$") > CODE.lastIndexOf("grant execute on function")
      && post.includes("$d$CHECK ((phase = ANY (ARRAY['baseline'::text, 'retest'::text])))$d$")
      && /relrowsecurity/.test(post) && /has_table_privilege\('service_role', v_name, 'insert'\)/.test(post)
      && /tg\.tgtype = v_t\.kind/.test(post) && (post.match(/, 27\)/g) ?? []).length === 4 && (post.match(/, 23\)/g) ?? []).length === 2 && (post.match(/, 7\)/g) ?? []).length === 2);

  /* T: TypeScript and SQL agree -------------------------------------------- */
  console.log("\n[T] the TypeScript constants");
  const listIn = (src: string) => [...src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const actionCheck = RAW.match(/action_type\s+text not null\s+check \(action_type in \(([\s\S]*?)\)\)/)?.[1] ?? "";
  check("T1 the action types are lib/interventions/types.ts ACTION_TYPES (0071's), in the table and in register's argument check",
    listIn(actionCheck).join(",") === ACTION_TYPES.join(",")
      && listIn(body("register_pilot_retest").match(/p_action_type not in \(([\s\S]*?)\)/)?.[1] ?? "").join(",") === ACTION_TYPES.join(","));
  const kinds = listIn(RAW.match(/check \(kind in \(([\s\S]*?)\)\)/)?.[1] ?? "");
  check("T2 the note kinds are RETEST_NOTE_KINDS, in the table and in the note's argument check",
    kinds.join(",") === RETEST_NOTE_KINDS.join(",")
      && listIn(body("add_pilot_retest_note").match(/p_kind not in \(([\s\S]*?)\)/)?.[1] ?? "").join(",") === RETEST_NOTE_KINDS.join(","));
  check("T3 the step kinds are RETEST_STEP_KINDS; the group states are RETEST_GROUP_STATES, derived in the same order as retestGroupState",
    listIn(RAW.match(/step\s+text not null check \(step in \(([^)]*)\)\)/)?.[1] ?? "").join(",") === RETEST_STEP_KINDS.join(",")
      && RAW.includes(`array['${RETEST_GROUP_STATES.join("', '")}']`)
      && /when r\.abandoned_at is not null then 'abandoned'\s+when r\.retests_prepared_at is not null then 'prepared'\s+when r\.implemented_at is not null then 'implemented'\s+else 'registered'/.test(RAW)
      && retestGroupState({ implementedAt: "x", retestsPreparedAt: "x", abandonedAt: "x" }) === "abandoned"
      && retestGroupState({ implementedAt: "x", retestsPreparedAt: "x", abandonedAt: null }) === "prepared"
      && retestGroupState({ implementedAt: "x", retestsPreparedAt: null, abandonedAt: null }) === "implemented"
      && retestGroupState({ implementedAt: null, retestsPreparedAt: null, abandonedAt: null }) === "registered");
  const reg = body("register_pilot_retest");
  check("T4 the bounds: 5 questions, 2 registrations, 7-60 days, a 7-day margin, 20 notes, 3 requeues, 5 planned runs",
    MAX_RETEST_QUESTIONS === 5 && /cardinality\(p_pilot_question_ids\) not between 1 and 5/.test(reg)
      && MAX_RETESTS_PER_PILOT === 2 && /check \(sequence between 1 and 2\)/.test(RAW) && /if v_groups >= 2 then/.test(reg)
      && MIN_OBSERVATION_DAYS === 7 && MAX_OBSERVATION_DAYS === 60 && /check \(observation_days between 7 and 60\)/.test(RAW) && /p_observation_days not between 7 and 60/.test(reg)
      && PILOT_END_MARGIN_DAYS === 7 && /v_pilot\.ends_on - 7 - p_observation_days/.test(reg) && /> v_pilot\.ends_on - 7 then/.test(body("confirm_pilot_retest_implementation"))
      && MAX_RETEST_NOTES === 20 && /\) >= 20 then/.test(body("add_pilot_retest_note")) && /\) >= 20 then/.test(body("confirm_pilot_retest_implementation"))
      && MAX_REQUEUES === 3 && /\) >= 3 then/.test(body("requeue_pilot_retest_job")) && /\) < 3;/.test(body(HELPER))
      && RETEST_PLANNED_RUNS === 5 && /planned_baseline_runs is distinct from 5/.test(reg) && /v_retest\.planned_baseline_runs is distinct from 5/.test(body("prepare_pilot_retests")));
  const boundsOk = Object.entries(RETEST_TEXT_BOUNDS).every(([key, [lo, hi]]) => {
    const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return new RegExp(`check \\(char_length\\(${col}\\) between ${lo} and ${hi} and ${col} = btrim\\(${col}\\)\\)`).test(RAW)
      && new RegExp(`char_length\\(p_${col}\\) not between ${lo} and ${hi}`).test(reg);
  });
  check("T5 every registered text's bounds are RETEST_TEXT_BOUNDS, in the table and in register's argument check", boundsOk);
  check("T6 the outcome rule is PILOT_OUTCOME_RULE, in the table and in the inserted row; implementByDay is the pilot's end less the margin and the period",
    RAW.includes(`check (outcome_rule = '${PILOT_OUTCOME_RULE}')`) && reg.includes(`'${PILOT_OUTCOME_RULE}', p_observation_days, v_implement_by`)
      && implementByDay("2026-12-31", 14) === "2026-12-10");
  check("T7 the save's footer and withheld literals are NON_CAUSALITY_FOOTER and PILOT_RETEST_WITHHELD_TEXT, and its statuses are OutcomeStatus's four",
    saveBlock.includes(`v_footer     constant text := '${NON_CAUSALITY_FOOTER}';`)
      && saveBlock.includes(`v_withheld   constant text := '${PILOT_RETEST_WITHHELD_TEXT}';`)
      && saveBlock.includes(`v_statuses   constant text[] := array['${STATUSES.join("', '")}'];`));

  /* F: the preflight, the runner and the command -------------------------- */
  console.log("\n[F] wiring");
  const preflight = read("scripts/sql/prod-preflight.sql");
  const pendingTables = preflight.match(/pending_tables\(name\) as \(values([\s\S]*?)\),\npending_functions/)?.[1] ?? "";
  const pendingFunctions = preflight.match(/pending_functions\(name\) as \(values([\s\S]*?)\),\n-- The only/)?.[1] ?? "";
  check("F1 the preflight lists the version in both P2.4 lists, the four tables and the 13 functions as pending, with counts 24 and 55 (54 at D-062; 20261109200000 adds set_pilot_purpose)",
    (preflight.match(/'20261109190000'/g) ?? []).length === 2
      && TABLES.every((t) => pendingTables.includes(`('${t}')`)) && NEW_FUNCTIONS.every((f) => pendingFunctions.includes(`('${f}')`))
      && (pendingTables.match(/\('/g) ?? []).length === 24 && (pendingFunctions.match(/\('/g) ?? []).length === 55
      && preflight.includes("none of the 24 pending tables exists") && preflight.includes("none of the 55 pending public functions exists"));
  const runner = read("scripts/run-p2-workspace-db-local.sh");
  check("F2 the DB runner runs the retest suite after phase B's",
    runner.indexOf("scripts/test-chatgpt-phase-b-db.ts") > 0 && runner.indexOf("scripts/test-pilot-retest-db.ts") > runner.indexOf("scripts/test-chatgpt-phase-b-db.ts"));
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  check("F3 test:pilot-retest-schema is registered", pkg.scripts["test:pilot-retest-schema"] === "tsx scripts/test-pilot-retest-schema.ts");

  /* M: the memory adapter mirrors the slot table -------------------------- */
  console.log("\n[M] memory adapter");
  const mem = read("lib/db/memory-adapter.ts");
  check("M1 the memory slot mirror accepts the retest phase in its type and refuses a retest slot with the trigger's message, after 20261109180000's checks and before the CHECKs",
    /phase: "baseline" \| "retest";/.test(mem)
      && mem.indexOf('throw new Error("pilot_slot_baseline_protocol_is_a_retest")') < mem.indexOf('if (slot.phase === "retest") throw new Error("pilot_retest_slot_inconsistent");')
      && mem.indexOf('if (slot.phase === "retest") throw new Error("pilot_retest_slot_inconsistent");') < mem.indexOf('throw new Error("pilot_question_protocols_engine_check violated")'));
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  let notModelled = "";
  try {
    await memoryAdapter.registerPilotRetest({} as never);
  } catch (error) {
    notModelled = error instanceof Error ? error.message : String(error);
  }
  check("M2 the memory adapter models no group: a group step fails closed", notModelled === "pilot_retest_not_modelled_in_memory", notModelled);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "Pilot retest schema contract PASSED." : `${failures} check(s) failed. Pilot retest schema contract FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
