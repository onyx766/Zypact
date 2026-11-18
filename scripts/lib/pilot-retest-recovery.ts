/**
 * The first recovery of 20261109190000_pilot_retest.sql (D-062), built from
 * the migration header's own statements and the sections it names, in the
 * header's order: what restores the state before 20261109190000 while no
 * pilot_retests row exists. Used by scripts/test-pilot-retest-db.ts (G: each
 * precondition made to refuse after it) and scripts/test-chatgpt-phase-b-db.ts
 * (G: 20261109180000 re-run after it and its own recovery).
 *
 * Throws when the header's statements are not the expected set, so a moved
 * or edited header fails loudly instead of rehearsing something else.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "supabase/migrations");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");

export const PILOT_RETEST_MIGRATION = "20261109190000_pilot_retest.sql";

/** From `start` through the first `end` after it, inclusive. */
function span(src: string, start: string, end: string): string {
  const s = src.indexOf(start);
  const e = s < 0 ? -1 : src.indexOf(end, s);
  if (s < 0 || e < 0) throw new Error(`span not found: ${start.slice(0, 60)}`);
  return src.slice(s, e + end.length);
}

/** The SQL statements the header's first recovery bullet lists, in order. */
export function pilotRetestHeaderStatements(): string[] {
  const src = file(PILOT_RETEST_MIGRATION);
  const start = src.indexOf("--   * Before any pilot_retests row exists");
  const end = src.indexOf("--   * Once a group exists");
  if (start < 0 || end < start) throw new Error("the recovery section of 20261109190000 was not found");
  return src
    .slice(start, end)
    .split("\n")
    .filter((l) => /^--       (drop |alter table )/.test(l))
    .map((l) => l.slice("--       ".length).trim());
}

export function pilotRetestRecovery(): string {
  const statements = pilotRetestHeaderStatements();
  const triggers = statements.filter((s) => s.startsWith("drop trigger "));
  const functions = statements.filter((s) => s.startsWith("drop function "));
  const alters = statements.filter((s) => s.startsWith("alter table "));
  const tables = statements.filter((s) => s.startsWith("drop table "));
  if (triggers.length !== 8 || functions.length !== 13 || alters.length !== 8 || tables.length !== 4
      || statements.length !== 33) {
    throw new Error(`unexpected recovery statements: ${triggers.length}/${functions.length}/${alters.length}/${tables.length}`);
  }
  // The header's order: triggers, then 20261109160000 sections 6 and 7,
  // then the functions, the slot table, 20261109180000's comment, the tables.
  const ordered = [...triggers, ...functions, ...alters, ...tables];
  if (ordered.join("\n") !== statements.join("\n")) throw new Error("the header lists the recovery out of its order");
  const pa = file("20261109160000_pilot_actions.sql");
  const b = file("20261109180000_chatgpt_measurement.sql");
  const save = "save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz)";
  const share = "share_pilot_report_artifact(uuid, uuid, uuid, boolean)";
  return [
    ...triggers,
    span(pa, "create or replace function public.save_pilot_report_artifact(", "\n$$;\n"),
    span(pa, `revoke all on function public.${save} from public;`, `grant execute on function public.${save} to service_role;`),
    span(pa, "create or replace function public.share_pilot_report_artifact(", "\n$$;\n"),
    span(pa, `revoke all on function public.${share} from public;`, `grant execute on function public.${share} to service_role;`),
    ...functions,
    ...alters,
    span(b, "comment on table public.pilot_question_protocols is", ";\n"),
    ...tables,
  ].join("\n");
}
