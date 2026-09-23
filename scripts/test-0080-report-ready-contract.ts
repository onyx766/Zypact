/**
 * 0080 — a saved protocol report makes its request deliverable.
 *
 * Static contract over the migration text. It proves three things:
 *
 *   1. The deadlock is closed: the build gate now accepts 'report_ready',
 *      and the function writes 'report_ready' for a deliverable artifact.
 *   2. Blocked stays undeliverable at the database: a blocked artifact
 *      leaves (or returns) its request at 'approved', which 0035's delivery
 *      RPC refuses.
 *   3. Nothing else moved. The new body equals 0068's once the two intended
 *      changes are removed, so a stray edit to any guard fails here rather
 *      than in production. The delivery fencing in 0035 is untouched.
 *
 * What this cannot prove is execution. It runs everywhere and reads only
 * files; the real-PostgreSQL proof is the post-apply verification against
 * the database the migration is applied to.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

let checks = 0;
const failures: string[] = [];
function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const read = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf8");
const FILE_0080 = "0080_protocol_report_marks_request_report_ready.sql";

const src0080 = read(FILE_0080);
const src0068 = read("0068_report_integrity_status.sql");
const src0035 = read("0035_snapshot_report_delivery_fencing.sql");

/** SQL with `--` comments and blank lines removed, whitespace collapsed. */
function codeOf(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter((l) => l !== "")
    .join(" ")
    .replace(/\s+/g, " ");
}

/** The plpgsql body of save_protocol_report_artifact in a file. */
function bodyOf(sql: string): string {
  const start = sql.indexOf("public.save_protocol_report_artifact(\n    p_request_id");
  const open = sql.indexOf("as $$", start);
  const close = sql.indexOf("$$;", open + 5);
  if (start === -1 || open === -1 || close === -1) return "";
  return sql.slice(open + 5, close);
}

const code = codeOf(src0080);
const body = codeOf(bodyOf(src0080));

// ── 1. It is the newest migration and replaces in place ──────────────────
{
  const numbers = readdirSync(MIGRATIONS)
    .map((f) => /^(\d{4})_/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  assert("0080 is the highest-numbered migration", Math.max(...numbers) === 80,
    String(Math.max(...numbers)));
  assert("exactly one 0080 migration exists",
    numbers.filter((n) => n === 80).length === 1);

  // A drop would open a window with no function; an argument change would
  // leave 0068's version resident as an overload that never writes status.
  assert("the function is replaced in place, not dropped", !/drop function/i.test(code));
  const SIGNATURE = "p_request_id uuid, p_project_id uuid, p_full_markdown text, "
    + "p_short_markdown text, p_full_filename text, p_short_filename text, "
    + "p_generated_at timestamptz, p_payload jsonb, p_integrity_status text, "
    + "p_integrity_reasons jsonb";
  assert("the ten-argument signature is 0068's, unchanged",
    code.includes(`create or replace function public.save_protocol_report_artifact( ${SIGNATURE} )`)
      && codeOf(src0068).includes(`public.save_protocol_report_artifact( ${SIGNATURE} )`));
  assert("it is security definer with a pinned search_path",
    code.includes("security definer") && code.includes("set search_path = public, pg_temp"));
}

// ── 2. The deadlock is closed ────────────────────────────────────────────
{
  assert("the build gate accepts 'approved' and 'report_ready'",
    body.includes("if v_request.status not in ('approved', 'report_ready') then return; end if;"));
  assert("the 0068 build gate ('approved' only) is gone",
    !body.includes("if v_request.status <> 'approved' then"));

  assert("a non-blocked artifact moves the request to 'report_ready'",
    body.includes("when p_integrity_status = 'blocked' then 'approved' else 'report_ready' end"));
  assert("the status write targets exactly this request",
    body.includes("update public.snapshot_requests set status = v_next_status, updated_at = now() where id = p_request_id;"));
  assert("the status write is skipped when nothing changes",
    body.includes("if v_request.status is distinct from v_next_status then"));
}

// ── 3. Blocked stays undeliverable at the database ───────────────────────
{
  // 0035's delivery RPC refuses anything short of 'report_ready'; this is
  // what makes 'approved' a database-level refusal for a blocked report.
  const beginAt = src0035.indexOf("begin_snapshot_report_delivery(");
  const beginBody = src0035.slice(beginAt, src0035.indexOf("$$;", src0035.indexOf("as $$", beginAt)));
  assert("0035's delivery begin still requires 'report_ready'",
    /if v_request\.status <> 'report_ready' then/.test(beginBody));

  const later = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_/.test(f) && Number(f.slice(0, 4)) > 35)
    .filter((f) => /create or replace function\s+public\.begin_snapshot_report_delivery/i.test(read(f)));
  assert("no later migration redefines the delivery begin", later.length === 0, later.join(", "));

  const blocked = "when p_integrity_status = 'blocked' then 'approved'";
  assert("blocked maps to 'approved', never to 'report_ready'", body.includes(blocked));
}

// ── 4. Ordering: every guard precedes the status write ──────────────────
{
  const at = (needle: string): number => body.indexOf(needle);
  const write = at("update public.snapshot_requests");
  const guards: Array<[string, string]> = [
    ["the protocol guard", "if v_request.protocol_id is null then return; end if;"],
    ["the build gate", "if v_request.status not in ('approved', 'report_ready')"],
    ["the succeeded-job guard", "if v_succeeded_jobs = 0 then return; end if;"],
    ["the delivered early return", "and v_artifact.delivered_at is not null then return; end if;"],
    ["the artifact write", "returning * into v_result; end if;"],
  ];
  assert("there is exactly one write to snapshot_requests",
    (body.match(/update public\.snapshot_requests/g) ?? []).length === 1);
  for (const [label, needle] of guards) {
    const pos = at(needle);
    assert(`${label} exists`, pos !== -1, needle);
    assert(`${label} precedes the status write`, pos !== -1 && pos < write,
      `${pos} vs ${write}`);
  }
  assert("the status write precedes the return of the artifact",
    write < at("return next v_result;"));
  assert("no progress_stage is written", !/progress_stage/.test(body));
}

// ── 5. Nothing else moved: the body is 0068's plus the two changes ──────
{
  const expected = codeOf(bodyOf(src0068))
    .replace("if v_request.status <> 'approved' then", "if v_request.status not in ('approved', 'report_ready') then")
    .replace("v_succeeded_jobs integer; begin", "v_succeeded_jobs integer; v_next_status text; begin")
    .replace(
      "returning * into v_result; end if; return next v_result;",
      "returning * into v_result; end if; "
        + "v_next_status := case when p_integrity_status = 'blocked' then 'approved' else 'report_ready' end; "
        + "if v_request.status is distinct from v_next_status then "
        + "update public.snapshot_requests set status = v_next_status, updated_at = now() where id = p_request_id; "
        + "end if; return next v_result;",
    );
  assert("the 0068 body was located", codeOf(bodyOf(src0068)).length > 1000,
    String(codeOf(bodyOf(src0068)).length));
  assert("the 0080 body equals 0068's plus exactly the intended changes", body === expected,
    `first difference at ${[...body].findIndex((c, i) => c !== expected[i])}`);
}

// ── 6. Grants are stated, not inherited ─────────────────────────────────
{
  const SIG = "public.save_protocol_report_artifact( uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb )";
  for (const role of ["public", "anon", "authenticated"]) {
    assert(`execute is revoked from ${role}`, code.includes(`revoke all on function ${SIG} from ${role};`));
  }
  assert("execute is granted to service_role only",
    code.includes(`grant execute on function ${SIG} to service_role;`)
      && (code.match(/grant execute/g) ?? []).length === 1);
}

// ── 7. Documentation obligations ────────────────────────────────────────
{
  assert("a rollback is written down", /^-- Rollback:/m.test(src0080));
  assert("the header names both functions that disagreed",
    src0080.includes("save_protocol_report_artifact  (0068)")
      && src0080.includes("begin_snapshot_report_delivery (0035)"));
}

// ── 8. The worker still finds a saved-but-undelivered report ────────────
{
  const worker = readFileSync(path.join(process.cwd(), "lib", "reports", "deliver-protocol-report.ts"), "utf8");
  assert("findDeliverableRequests reads both 'approved' and 'report_ready'",
    worker.includes('.in("status", ["approved", "report_ready"])'));
  assert("it no longer filters on 'approved' alone",
    !/\.eq\("status", "approved"\)/.test(worker));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n${checks}/${checks} checks passed. 0080 report_ready contract PASSED.`);
