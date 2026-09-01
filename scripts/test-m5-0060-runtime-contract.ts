#!/usr/bin/env tsx
/**
 * M5 — real PostgreSQL contract for migration 0060 (D-031 post-claim
 * verification).
 *
 * The property this migration exists for cannot be shown in a memory adapter
 * or in SQL text: that the verifier sees a job's history where
 * `get_protocol_execution_job_context` does not. Demonstrating that needs a
 * real attempt, real external calls, real receipts, a real probe_run and a
 * real probe_result — produced by the canonical RPCs, not hand-inserted — and
 * then the state a crash leaves behind: `current_attempt_id` back to null
 * while every one of those rows remains on record.
 *
 * Discipline, inherited from the 0050, 0054 and 0059 harnesses:
 *   - opt-in only: does nothing unless ZYPACT_M5_0060_RUNTIME_TEST=1;
 *   - once the opt-in IS set, nothing is skipped: a missing prerequisite
 *     fails the contract rather than degrading into a SKIP;
 *   - a disposable project in a fresh mktemp, outside the repository;
 *   - a unique project id and a free port block, chosen at run time;
 *   - it never targets, inspects for mutation, stops or removes any container
 *     it did not itself create, and never runs `docker ... prune`;
 *   - no .env, no remote database, no provider, no network beyond the local
 *     Docker socket;
 *   - the complete local image identity — repository, tag, digest and full ID
 *     for every image, including intermediate ones — is photographed before
 *     and after, and the run FAILS if it moved. Nothing here can prevent a
 *     download; what this establishes is narrower and stated as such: no new
 *     or replaced local image is evidenced by that inventory;
 *   - cleanup happens only after a completely successful run; on any failure
 *     the disposable workdir is preserved for diagnosis.
 *
 * The ordering is itself part of the proof. Migrations 0001..0059 are applied
 * first, the three functions 0060 must not touch are fingerprinted from the
 * live catalogue, local advisors are run — all before 0060 exists and before
 * this file creates a single helper of its own. Only then is 0060 applied,
 * and those identities and findings are required to be unchanged.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const OPT_IN = "ZYPACT_M5_0060_RUNTIME_TEST";
const DEFAULT_DOCKER_BIN_DIR = "/Applications/Docker.app/Contents/Resources/bin";
const DOCKER_BIN_DIR = process.env.ZYPACT_DOCKER_BIN_DIR ?? DEFAULT_DOCKER_BIN_DIR;

/** The optional services this CLI version must offer, in the order it lists them. */
const EXPECTED_OPTIONAL_SERVICES = [
  "gotrue", "realtime", "storage-api", "imgproxy", "kong", "mailpit", "postgrest",
  "postgres-meta", "studio", "edge-runtime", "logflare", "vector", "supavisor",
] as const;

const VERIFY_FN = "verify_phase3d_canary_post_claim";
const TARGETED_FN = "claim_protocol_execution_job_by_id";

/** The three functions 0060 must leave exactly as it found them. */
const PINNED_FNS = [
  "claim_protocol_execution_job",
  "claim_protocol_execution_job_by_id",
  "get_protocol_execution_job_context",
] as const;

const RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: DOCKER_BIN_DIR ? `${DOCKER_BIN_DIR}:${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
};

let passed = 0;
let failed = 0;
const ran = new Set<string>();

function check(id: string, label: string, ok: boolean, detail?: string): void {
  ran.add(id);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The single SKIP path: the opt-in was never given, so nothing was created,
 * started or verified. Once the opt-in IS set, every missing prerequisite
 * raises instead — a skipped validation must never be reachable behind an
 * explicit request to validate.
 */
function skipUnrequested(reason: string): never {
  console.log(`\nSKIPPED — ${reason}`);
  console.log("A SKIP is not a validation. Nothing was created, started or verified.");
  process.exit(2);
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { env: RUN_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
  }
}

/* ───────────────────────────── psql helpers ───────────────────────────── */

let DB_URL = "";

function sql(query: string, asServiceRole = true): string {
  const script = `${asServiceRole ? "set role service_role;\n" : ""}${query}`;
  return run("psql", [DB_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", script]).trim();
}

/**
 * SQLSTATE is captured inside the server, not scraped from psql's rendering:
 * an error contract must not depend on a client's verbosity setting.
 */
function sqlExpectError(args: string): { sqlstate: string; message: string } {
  const raw = sql(`select public._m5_0060_sqlstate(${args});`);
  if (raw === "NO_ERROR") return { sqlstate: "", message: "no error raised" };
  const i = raw.indexOf("|");
  return { sqlstate: raw.slice(0, i), message: raw.slice(i + 1) };
}

/* ───────────────────────────── port selection ─────────────────────────── */

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function chooseOffset(basePorts: number[]): Promise<number> {
  for (let offset = 0; offset <= 2000; offset += 100) {
    const results = await Promise.all(basePorts.map((p) => portFree(p + offset)));
    if (results.every(Boolean)) return offset;
  }
  throw new Error("no free port block found in 54321..56321");
}

/* ─────────────────────────── optional-service list ────────────────────── */

function extractOptionalServices(helpText: string): string[] {
  const m = /--exclude, -x string\s+Names of containers to not start\.\s*\[([^\]]*)\]/.exec(helpText);
  if (!m) throw new Error("could not locate the --exclude service list in `supabase start --help`");
  const raw = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (raw.length === 0) throw new Error("the --exclude service list parsed as empty");
  if (new Set(raw).size !== raw.length) {
    throw new Error(`the --exclude service list contains duplicates: ${raw.join(",")}`);
  }
  return raw;
}

/* ─────────────────────────────── advisors ─────────────────────────────── */

interface AdvEntry { level: string; name: string; schema: string; object: string }

function advKey(e: AdvEntry): string {
  return `${e.level}|${e.name}|${e.schema}|${e.object}`;
}

/**
 * Only four closed fields ever leave this function: level, code/name, schema
 * and object. Descriptions and remediation URLs are discarded rather than
 * printed.
 */
function runAdvisors(workdir: string, label: string): AdvEntry[] {
  const r = tryRun("supabase", [
    "db", "advisors", "--local", "--workdir", workdir, "--output-format", "json",
  ]);
  if (!r.ok) {
    throw new Error(`local advisors failed at "${label}". This opt-in runtime contract requires them; `
      + "it does not treat an unavailable advisor run as a pass.");
  }
  const start = r.out.search(/[[{]/);
  if (start === -1) {
    if (/no issues found/i.test(r.out)) return [];
    throw new Error(`local advisors produced no parsable JSON at "${label}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.out.slice(start));
  } catch {
    throw new Error(`local advisors produced unparsable JSON at "${label}"`);
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : ((parsed as { lints?: unknown[] })?.lints ?? []);
  return list.map((raw) => {
    const e = raw as {
      level?: string; name?: string; title?: string;
      metadata?: { schema?: string; name?: string; entity?: string };
    };
    return {
      level: String(e.level ?? "UNKNOWN").toUpperCase(),
      name: String(e.name ?? e.title ?? "unnamed"),
      schema: String(e.metadata?.schema ?? ""),
      object: String(e.metadata?.name ?? e.metadata?.entity ?? ""),
    };
  });
}

function printAdvisors(label: string, entries: AdvEntry[]): void {
  const errors = entries.filter((e) => e.level === "ERROR").length;
  const warnings = entries.filter((e) => e.level === "WARN" || e.level === "WARNING").length;
  console.log(`  ${label}: ${errors} error(s), ${warnings} warning(s), ${entries.length} entr(y|ies) total`);
  for (const e of entries) {
    console.log(`    ${e.level} ${e.name} ${e.schema}.${e.object}`);
  }
}

/**
 * The complete identity of every local image: repository, tag, digest and the
 * full (untruncated) ID, for all images including intermediate layers. A
 * repository:tag list alone would call a retagged or re-pulled image
 * unchanged; the digest and the full ID are what make "the same image" mean
 * the same bytes.
 */
function imageInventory(): string[] {
  return run("docker", [
    "images", "--all", "--no-trunc", "--digests",
    "--format", "{{.Repository}}|{{.Tag}}|{{.Digest}}|{{.ID}}",
  ]).split("\n").map((l) => l.trim()).filter(Boolean).sort();
}

/** The catalogue identity of one function: overload count, arguments, body. */
function fnIdentity(name: string): string {
  return sql(
    `select coalesce(string_agg(`
    + `pg_get_function_identity_arguments(p.oid) || '#' || md5(pg_get_functiondef(p.oid)), '~' order by p.oid`
    + `), 'ABSENT') from pg_proc p join pg_namespace n on n.oid = p.pronamespace `
    + `where n.nspname='public' and p.proname='${name}';`,
    false
  );
}

/* ═══════════════════════════════ main ═══════════════════════════════════ */

async function main(): Promise<void> {
  if (process.env[OPT_IN] !== "1") {
    skipUnrequested(`${OPT_IN} is not set to "1". Set it explicitly to run this contract `
      + `(e.g. ${OPT_IN}=1 npm run test:m5-0060-runtime).`);
  }

  console.log("=== M5 0060 runtime contract — real PostgreSQL, no provider, no remote ===\n");

  // The opt-in was given. From here a missing prerequisite is a failure, not
  // a skip: an explicit request to validate must never quietly validate less.
  if (!tryRun("docker", ["version"]).ok) {
    throw new Error(`Docker is not reachable. Set ZYPACT_DOCKER_BIN_DIR (currently "${DOCKER_BIN_DIR}"). `
      + `${OPT_IN} was set, so this is a failure and not a SKIP.`);
  }
  if (!tryRun("supabase", ["--version"]).ok) throw new Error("The Supabase CLI is not available.");
  if (!tryRun("psql", ["--version"]).ok) throw new Error("psql is not available.");
  const cliVersion = run("supabase", ["--version"]).trim();
  console.log(`Docker, Supabase CLI (${cliVersion}) and psql detected — proceeding.\n`);

  const imagesBefore = imageInventory();

  console.log("[1] The optional-service list is read from the CLI, not assumed");
  const help = run("supabase", ["start", "--help"]);
  const services = extractOptionalServices(help);
  check("services", "the --exclude list parses into a non-empty, duplicate-free set",
    services.length > 0 && new Set(services).size === services.length);
  check("services", "it is exactly the set this CLI version is expected to offer",
    JSON.stringify([...services].sort()) === JSON.stringify([...EXPECTED_OPTIONAL_SERVICES].sort()),
    services.join(","));
  if (failed > 0) {
    throw new Error(`the optional-service list differs from the expected set: ${services.join(",")}`);
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0060-runtime-"));
  let stackStarted = false;
  let success = false;

  try {
    console.log(`\n[2] Disposable project: ${workdir}`);
    check("workdir", "the workdir is outside the repository", !workdir.startsWith(REPO_ROOT));
    run("supabase", ["init", "--workdir", workdir, "--yes"]);

    const configPath = path.join(workdir, "supabase", "config.toml");
    let config = readFileSync(configPath, "utf8");
    let section = "";
    config = config.split("\n").map((line) => {
      if (line.startsWith("[")) section = line.trim();
      if (section === "[db.seed]" && /^enabled\s*=/.test(line)) return "enabled = false";
      return line;
    }).join("\n");
    check("workdir", "the seed is disabled in the generated config",
      /\[db\.seed\][\s\S]{0,200}?enabled = false/.test(config));

    const declaredPorts = [...config.matchAll(/^port = (\d+)$/gm)].map((m) => Number(m[1]));
    const offset = await chooseOffset(declaredPorts);
    if (offset !== 0) {
      config = config.replace(/^port = (\d+)$/gm, (_m, p: string) => `port = ${Number(p) + offset}`);
    }
    writeFileSync(configPath, config);
    const dbPort = 54322 + offset;
    console.log(`  port offset: +${offset} (db on ${dbPort})`);
    check("workdir", "every declared port was free before starting",
      (await Promise.all(declaredPorts.map((p) => portFree(p + offset)))).every(Boolean));

    console.log("\n[3] A single `supabase start`, with every optional service excluded");
    run("supabase", ["start", "--workdir", workdir, "--exclude", services.join(",")]);
    stackStarted = true;
    DB_URL = `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`;

    const imagesAfter = imageInventory();
    check("images",
      "no new or replaced local image is evidenced by the complete image identity inventory",
      JSON.stringify(imagesAfter) === JSON.stringify(imagesBefore),
      `before ${imagesBefore.length}, after ${imagesAfter.length}`);
    // Read from the Tag field itself, not from the tail of a joined string:
    // a repository whose NAME ends in "latest" is not a `latest` tag.
    const tags = imagesAfter.map((line) => line.split("|")[1] ?? "");
    check("images", "no image carries the `latest` tag",
      tags.length > 0 && !tags.includes("latest"),
      tags.filter((t) => t === "latest").length ? "latest present" : `${tags.length} tags read`);

    const projectId = path.basename(workdir);
    const mine = run("docker", ["ps", "--format", "{{.Names}}"]).split("\n")
      .map((s) => s.trim()).filter((s) => s.includes(projectId));
    check("images", "the disposable project created exactly one container, a database",
      mine.length === 1 && /db/.test(mine[0]), mine.join(",") || "none");

    console.log("\n[4] The base carries the roles and extensions the migrations assume");
    check("base", "PostgreSQL answers", /^PostgreSQL /.test(sql("select version();", false)));
    const roles = sql("select rolname from pg_roles where rolname in "
      + "('anon','authenticated','service_role') order by 1;", false).split("\n").filter(Boolean);
    check("base", "anon, authenticated and service_role all exist",
      JSON.stringify(roles) === JSON.stringify(["anon", "authenticated", "service_role"]), roles.join(","));
    check("base", "pgcrypto is installed",
      sql("select count(*) from pg_extension where extname='pgcrypto';", false) === "1");
    check("base", "the auth schema exists",
      sql("select count(*) from pg_namespace where nspname='auth';", false) === "1");

    // ── 5. 0001..0059 first ────────────────────────────────────────────────
    console.log("\n[5] Migrations 0001..0059, selected by number and applied in order");
    const numbered = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => ({ f, n: Number(f.slice(0, 4)) }))
      .filter((x) => x.n >= 1 && x.n <= 60)
      .sort((a, b) => a.n - b.n);
    check("ledger", "exactly 60 numbered migrations are selected", numbered.length === 60, String(numbered.length));
    check("ledger", "their numbers run 1..60 with no gap and no duplicate",
      numbered.every((x, i) => x.n === i + 1));
    check("ledger", "0060 is the last one",
      numbered[numbered.length - 1]?.f === "0060_m5_phase3d_post_claim_verification.sql");
    const upTo59 = numbered.filter((x) => x.n <= 59);
    for (const { f } of upTo59) {
      run("psql", [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", path.join(MIGRATIONS_DIR, f)]);
    }
    console.log(`  applied ${upTo59.length} migrations (0001..0059)`);

    // ── 6. the three functions, as 0059 leaves them ───────────────────────
    console.log("\n[6] s10 — the three functions 0060 must not touch are fingerprinted first");
    const before: Record<string, string> = {};
    for (const fn of PINNED_FNS) {
      before[fn] = fnIdentity(fn);
      check("s10-identity", `${fn} exists with a single stable identity after 0059`,
        /^[^~]+#[0-9a-f]{32}$/.test(before[fn]), before[fn]);
    }
    check("s10-identity", `${VERIFY_FN} does not exist yet`,
      fnIdentity(VERIFY_FN) === "ABSENT");

    // ── 7. advisors BEFORE 0060, and before this file creates anything ────
    console.log("\n[7] s11 — local advisors, after 0059 and before any helper of ours exists");
    const advHelp = tryRun("supabase", ["db", "advisors", "--help"]);
    if (!advHelp.ok || !/--local/.test(advHelp.out)) {
      throw new Error("`supabase db advisors --local` is unavailable on this CLI version. "
        + "This opt-in runtime contract requires it and will not pass without it.");
    }
    const advBefore = runAdvisors(workdir, "after 0059");
    printAdvisors("after 0059", advBefore);
    check("s11-advisors", "advisors ran against the disposable stack after 0059", true);

    // ── 8. 0060 ───────────────────────────────────────────────────────────
    console.log("\n[8] Migration 0060 applied on top");
    run("psql", [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1",
      "-f", path.join(MIGRATIONS_DIR, "0060_m5_phase3d_post_claim_verification.sql")]);
    console.log("  applied 0060");

    console.log("\n[9] s10 — 0060 left all three strictly identical");
    for (const fn of PINNED_FNS) {
      const after = fnIdentity(fn);
      check("s10-identity", `${fn}: overloads, identity arguments and body are unchanged`,
        after === before[fn], `${before[fn]} -> ${after}`);
    }

    console.log("\n[10] s11 — advisors after 0060: nothing new may appear");
    const advAfter = runAdvisors(workdir, "after 0060");
    printAdvisors("after 0060", advAfter);
    const beforeKeys = new Set(advBefore.map(advKey));
    const introduced = advAfter.filter((e) => !beforeKeys.has(advKey(e))
      && (e.level === "ERROR" || e.level === "WARN" || e.level === "WARNING"));
    if (introduced.some((e) => e.object.includes(VERIFY_FN))) {
      throw new Error(`advisors attribute a finding to ${VERIFY_FN} itself: `
        + `${introduced.filter((e) => e.object.includes(VERIFY_FN)).map(advKey).join(" ; ")}. `
        + "Fixing that would mean editing the migration, which is outside this scope. Stopping.");
    }
    check("s11-advisors", "0060 introduced no new WARN or ERROR",
      introduced.length === 0, introduced.map(advKey).join(" ; "));

    await runScenarios();

    success = failed === 0;
  } finally {
    if (stackStarted) {
      const stop = tryRun("supabase", ["stop", "--workdir", workdir, "--no-backup"]);
      if (stop.ok) {
        console.log("\nDisposable stack stopped.");
      } else {
        // A stack we could not stop is a container we left running. That is a
        // failure of this contract, not a footnote: it fails the run, keeps
        // the workdir for diagnosis, and can never be reported as PASSED.
        failed += 1;
        success = false;
        console.log("\n  ✗ `supabase stop --no-backup` failed for the disposable project — "
          + "the stack may still be running and the workdir is kept.");
      }
    }
    if (success && workdir.startsWith(path.join(tmpdir(), "zypact-m5-0060-runtime-"))) {
      rmSync(workdir, { recursive: true, force: true });
      console.log(`Removed disposable workdir: ${workdir}`);
    } else if (existsSync(workdir)) {
      console.log(`Workdir PRESERVED for diagnosis: ${workdir}`);
    }
  }
}

/* ═══════════════════════════ the closed roster ══════════════════════════ */

const ROSTER = [
  "s01-catalogue", "s02-invalid-args", "s03-not-found", "s04-not-owned",
  "s05-verified", "s06-not-clean-state", "s07-not-clean-history",
  "s08-protocol-not-eligible", "s09-read-only", "s10-identity", "s11-advisors",
] as const;

/** Valid nine-key persist_probe_result_for_job content. */
const CONTENT = JSON.stringify({
  product_mentioned: true,
  product_position: "primary",
  competitors_mentioned: [{ name: "Acme", position: 1, context: "listed first" }],
  sources_cited: [{ source: "acme-reviews.com", type: "review_site" }],
  answer_summary: "Acme is recommended as the top choice.",
  cited_as_source: false,
  client_source_count: 0,
  platforms_referenced: [],
  negative_claim_detected: false,
}).replace(/'/g, "''");

/**
 * The helpers this contract installs. They construct fixtures through the
 * real RPC chain, or engineer states a single short-lived run cannot reach by
 * waiting — a lapsed lease, and the crash residue this whole migration exists
 * for: a job whose `current_attempt_id` is null while its attempt, calls,
 * receipts, probe_run and probe_result all remain on record.
 *
 * Each is hardened the way the repository hardens its own SECURITY DEFINER
 * surfaces — a pinned search_path and execute for service_role alone — so
 * that creating them cannot itself become an advisor finding. They are
 * created only AFTER the advisor baseline is taken.
 */
const HELPER_SQL = `
create or replace function public._m5_0060_fixture(p_label text, p_max_attempts integer)
returns table (project_id uuid, protocol_id uuid, job_id uuid)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_project_id uuid; v_bq_id uuid; v_bqv_id uuid; v_protocol_id uuid; v_job_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
begin
  insert into public.projects (domain, company_name)
    values ('m5-0060-' || p_label || '-' || gen_random_uuid()::text || '.test', 'M5 0060 ' || p_label)
    returning id into v_project_id;
  insert into public.buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into public.buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label,
    'hash-m5-0060-' || p_label || '-' || gen_random_uuid()::text,
    'shortlist', 4, 3, 10, 'm5 0060 runtime contract fixture', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from public.approve_buyer_question_version(v_bqv_id, v_project_id, v_actor);
  insert into public.protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    1, 0, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', 20, 100.00, 3600, 1000, 50, 2
  ) returning id into v_protocol_id;
  perform status from public.approve_protocol(v_protocol_id, v_project_id, v_actor);
  select (e.job).id into v_job_id
    from public.enqueue_protocol_execution_job(v_protocol_id, v_project_id, p_max_attempts) e;
  return query select v_project_id, v_protocol_id, v_job_id;
end;
$f$;
revoke all on function public._m5_0060_fixture(text, integer) from public;
revoke all on function public._m5_0060_fixture(text, integer) from anon;
revoke all on function public._m5_0060_fixture(text, integer) from authenticated;
grant execute on function public._m5_0060_fixture(text, integer) to service_role;

-- A claimed, still-untouched job: exactly the state the canary reaches
-- between CLAIMED and admit_and_reserve_attempt_for_job.
create or replace function public._m5_0060_claimed(p_label text, p_worker text)
returns table (project_id uuid, protocol_id uuid, job_id uuid, claim_token uuid)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_fx record; v_claim record;
begin
  select * into v_fx from public._m5_0060_fixture(p_label, 1);
  select * into v_claim from public.${TARGETED_FN}(p_worker, 300, v_fx.job_id, v_fx.project_id);
  if v_claim.outcome <> 'CLAIMED' then
    raise exception 'fixture % could not be claimed: %', p_label, v_claim.outcome;
  end if;
  return query select v_fx.project_id, v_fx.protocol_id, v_fx.job_id, v_claim.claim_token;
end;
$f$;
revoke all on function public._m5_0060_claimed(text, text) from public;
revoke all on function public._m5_0060_claimed(text, text) from anon;
revoke all on function public._m5_0060_claimed(text, text) from authenticated;
grant execute on function public._m5_0060_claimed(text, text) to service_role;

-- A job carrying a COMPLETE real history, built only through the canonical
-- RPCs: a reserved attempt, two external calls, a probe_run, both receipts,
-- and a persisted probe_result. Nothing here is hand-inserted.
create or replace function public._m5_0060_history(p_label text, p_worker text)
returns table (
  project_id uuid, protocol_id uuid, job_id uuid, claim_token uuid,
  attempt_id uuid, probe_run_id uuid, perplexity_call_id uuid, analysis_call_id uuid
)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_c record; v_admit record; v_probe record;
  v_attempt public.protocol_attempts%rowtype;
  v_pcall public.protocol_external_calls%rowtype;
  v_acall public.protocol_external_calls%rowtype;
  v_run public.probe_runs%rowtype;
  v_preq text := 'perplexity request body for ' || p_label;
  v_areq text := 'analysis request body for ' || p_label;
  v_answer text := 'raw perplexity answer for ' || p_label;
  v_content text := 'raw analysis content for ' || p_label;
begin
  select * into v_c from public._m5_0060_claimed(p_label, p_worker);
  select * into v_admit from public.admit_and_reserve_attempt_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, 'baseline',
    v_c.job_id::text || ':baseline:1', 0.01, 0.01
  );
  v_attempt := v_admit.attempt; v_pcall := v_admit.perplexity_call; v_acall := v_admit.analysis_call;
  select * into v_probe from public.create_probe_run_and_start_attempt_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, v_attempt.id, 'perplexity', 'simulated'
  );
  v_attempt := v_probe.attempt; v_run := v_probe.probe_run;
  perform status from public.mark_external_call_sent_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, v_pcall.id, v_run.id,
    'perplexity', v_preq, public._sha256_hex(v_preq));
  perform status from public.record_provider_call_receipt_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, v_pcall.id, v_run.id, 'success',
    200, 'req-' || v_pcall.id::text, public._sha256_hex(v_answer), 500, null, null, v_answer);
  perform status from public.mark_external_call_sent_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, v_acall.id, v_run.id,
    'analysis', v_areq, public._sha256_hex(v_areq));
  perform status from public.record_analysis_call_receipt_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, v_acall.id, v_run.id, 'success',
    'anthropic', 'claude-fixture', false, public._sha256_hex(v_areq),
    public._sha256_hex(v_content), 400, null, null, v_content, v_areq);
  perform status from public.persist_probe_result_for_job(
    v_c.job_id, v_c.claim_token, v_c.project_id, '${CONTENT}'::jsonb);
  return query select v_c.project_id, v_c.protocol_id, v_c.job_id, v_c.claim_token,
    v_attempt.id, v_run.id, v_pcall.id, v_acall.id;
end;
$f$;
revoke all on function public._m5_0060_history(text, text) from public;
revoke all on function public._m5_0060_history(text, text) from anon;
revoke all on function public._m5_0060_history(text, text) from authenticated;
grant execute on function public._m5_0060_history(text, text) to service_role;

-- Overwrites exactly the six state columns the verifier reads, plus status.
-- This is how the crash residue is reproduced: a real worker death after an
-- attempt was closed leaves current_attempt_id null with the whole history
-- still on record, and a disposable single-run database cannot be made to
-- exhibit that by waiting.
create or replace function public._m5_0060_force_job(
  p_job_id uuid, p_status text, p_attempt_count integer, p_max_attempts integer,
  p_current_attempt_id uuid, p_next_baseline_ordinal integer,
  p_needs_review_reason text, p_failure_reason text
) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_jobs
     set status = p_status,
         attempt_count = p_attempt_count,
         max_attempts = p_max_attempts,
         current_attempt_id = p_current_attempt_id,
         next_baseline_ordinal = p_next_baseline_ordinal,
         needs_review_reason = p_needs_review_reason,
         failure_reason = p_failure_reason
   where id = p_job_id;
end;
$f$;
revoke all on function public._m5_0060_force_job(uuid, text, integer, integer, uuid, integer, text, text) from public;
revoke all on function public._m5_0060_force_job(uuid, text, integer, integer, uuid, integer, text, text) from anon;
revoke all on function public._m5_0060_force_job(uuid, text, integer, integer, uuid, integer, text, text) from authenticated;
grant execute on function public._m5_0060_force_job(uuid, text, integer, integer, uuid, integer, text, text) to service_role;

create or replace function public._m5_0060_backdate_lease(p_job_id uuid, p_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_jobs set lease_expires_at = p_at where id = p_job_id;
end;
$f$;
revoke all on function public._m5_0060_backdate_lease(uuid, timestamptz) from public;
revoke all on function public._m5_0060_backdate_lease(uuid, timestamptz) from anon;
revoke all on function public._m5_0060_backdate_lease(uuid, timestamptz) from authenticated;
grant execute on function public._m5_0060_backdate_lease(uuid, timestamptz) to service_role;

create or replace function public._m5_0060_set_protocol_status(p_protocol_id uuid, p_status text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocols set status = p_status where id = p_protocol_id;
end;
$f$;
revoke all on function public._m5_0060_set_protocol_status(uuid, text) from public;
revoke all on function public._m5_0060_set_protocol_status(uuid, text) from anon;
revoke all on function public._m5_0060_set_protocol_status(uuid, text) from authenticated;
grant execute on function public._m5_0060_set_protocol_status(uuid, text) to service_role;

create or replace function public._m5_0060_sqlstate(
  p_worker text, p_job uuid, p_project uuid, p_token uuid
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $g$
begin
  perform * from public.${VERIFY_FN}(p_worker, p_job, p_project, p_token);
  return 'NO_ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end;
$g$;
revoke all on function public._m5_0060_sqlstate(text, uuid, uuid, uuid) from public;
revoke all on function public._m5_0060_sqlstate(text, uuid, uuid, uuid) from anon;
revoke all on function public._m5_0060_sqlstate(text, uuid, uuid, uuid) from authenticated;
grant execute on function public._m5_0060_sqlstate(text, uuid, uuid, uuid) to service_role;

-- Two probes that must report a REFUSAL, not raise one. NOTICE output goes
-- to psql's stderr, so an error code proved through a notice would be a code
-- this harness never actually read; each of these returns its SQLSTATE as a
-- value instead.
create or replace function public._m5_0060_try_needs_review(p_job_id uuid) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_jobs
     set status = 'claimed', needs_review_reason = 'engineered_reason'
   where id = p_job_id;
  return 'NO_ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end;
$f$;
revoke all on function public._m5_0060_try_needs_review(uuid) from public;
revoke all on function public._m5_0060_try_needs_review(uuid) from anon;
revoke all on function public._m5_0060_try_needs_review(uuid) from authenticated;
grant execute on function public._m5_0060_try_needs_review(uuid) to service_role;

-- A STABLE function that attempts a write, and a volatile caller that reports
-- how PostgreSQL answered. This is what makes 0060's STABLE marker a property
-- the engine enforces rather than one this file merely sampled.
create or replace function public._m5_0060_stable_write() returns void
language plpgsql security definer stable set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_jobs set updated_at = now() where false;
end;
$f$;
revoke all on function public._m5_0060_stable_write() from public;
revoke all on function public._m5_0060_stable_write() from anon;
revoke all on function public._m5_0060_stable_write() from authenticated;
grant execute on function public._m5_0060_stable_write() to service_role;

create or replace function public._m5_0060_try_stable_write() returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  perform public._m5_0060_stable_write();
  return 'NO_ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end;
$f$;
revoke all on function public._m5_0060_try_stable_write() from public;
revoke all on function public._m5_0060_try_stable_write() from anon;
revoke all on function public._m5_0060_try_stable_write() from authenticated;
grant execute on function public._m5_0060_try_stable_write() to service_role;

-- Every column of every row of every table this verifier reads, as JSON.
-- "Nothing changed" therefore means nothing — not "nothing among the columns
-- someone remembered to list".
create or replace function public._m5_0060_digest() returns text
language sql security definer stable set search_path = pg_catalog, pg_temp as $f$
  select md5(string_agg(t, '|' order by t)) from (
    select 'jobs:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY') as t
      from public.protocol_execution_jobs x
    union all select 'protocols:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.protocols x
    union all select 'attempts:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.protocol_attempts x
    union all select 'calls:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.protocol_external_calls x
    union all select 'provider_receipts:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.provider_call_receipts x
    union all select 'analysis_receipts:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.analysis_call_receipts x
    union all select 'probe_runs:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.probe_runs x
    union all select 'probe_results:' || coalesce(md5(string_agg(to_jsonb(x)::text, '|' order by x.id)), 'EMPTY')
      from public.probe_results x
  ) s;
$f$;
revoke all on function public._m5_0060_digest() from public;
revoke all on function public._m5_0060_digest() from anon;
revoke all on function public._m5_0060_digest() from authenticated;
grant execute on function public._m5_0060_digest() to service_role;
`;

interface Claimed { projectId: string; protocolId: string; jobId: string; token: string }

function makeClaimed(label: string, worker: string): Claimed {
  const r = sql(`select project_id, protocol_id, job_id, claim_token `
    + `from public._m5_0060_claimed('${label}', '${worker}');`).split("|");
  return { projectId: r[0], protocolId: r[1], jobId: r[2], token: r[3] };
}

interface History extends Claimed { attemptId: string; probeRunId: string }

function makeHistory(label: string, worker: string): History {
  const r = sql(`select project_id, protocol_id, job_id, claim_token, attempt_id, probe_run_id `
    + `from public._m5_0060_history('${label}', '${worker}');`).split("|");
  return {
    projectId: r[0], protocolId: r[1], jobId: r[2], token: r[3],
    attemptId: r[4], probeRunId: r[5],
  };
}

function verify(worker: string, jobId: string | null, projectId: string | null, token: string | null): string {
  const j = jobId === null ? "null::uuid" : `'${jobId}'::uuid`;
  const p = projectId === null ? "null::uuid" : `'${projectId}'::uuid`;
  const t = token === null ? "null::uuid" : `'${token}'::uuid`;
  return sql(`select outcome from public.${VERIFY_FN}('${worker}', ${j}, ${p}, ${t});`);
}

function digest(): string {
  return sql("select public._m5_0060_digest();");
}

/** Restores the pristine, freshly-claimed shape the verifier accepts. */
function forcePristine(jobId: string): void {
  sql(`select public._m5_0060_force_job('${jobId}'::uuid, 'claimed', 1, 1, null, 1, null, null);`);
}

async function runScenarios(): Promise<void> {
  sql(HELPER_SQL, false);

  /* ── s01 ─────────────────────────────────────────────────────────────── */
  console.log("\n[11] s01 — catalogue identity and real privileges");
  const sig = sql(`select pg_get_function_identity_arguments(p.oid) from pg_proc p `
    + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${VERIFY_FN}';`, false);
  check("s01-catalogue", "the function exists with the exact four-argument identity",
    sig === "p_worker_id text, p_job_id uuid, p_project_id uuid, p_claim_token uuid", sig);
  const props = sql(`select p.prosecdef::text || '|' || p.provolatile::text || '|' || `
    + `coalesce(array_to_string(p.proconfig,','),'') from pg_proc p join pg_namespace n `
    + `on n.oid=p.pronamespace where n.nspname='public' and p.proname='${VERIFY_FN}';`, false);
  check("s01-catalogue", "it is SECURITY DEFINER, STABLE, with the pinned search_path",
    props === "true|s|search_path=public, pg_temp", props);
  const acl = ["public", "anon", "authenticated", "service_role"].map((r) =>
    `${r}=${sql(`select has_function_privilege('${r}', p.oid, 'EXECUTE')::text from pg_proc p `
      + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${VERIFY_FN}';`, false)}`).join(" ");
  check("s01-catalogue", "only service_role may execute it",
    acl === "public=false anon=false authenticated=false service_role=true", acl);
  const cols = sql(`select coalesce(array_to_string(p.proargnames, ','), '') from pg_proc p `
    + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${VERIFY_FN}';`, false);
  check("s01-catalogue", "it returns exactly one column, named `outcome`",
    cols === "p_worker_id,p_job_id,p_project_id,p_claim_token,outcome", cols);

  /* ── s02 ─────────────────────────────────────────────────────────────── */
  console.log("\n[12] s02 — invalid arguments raise 22023 and mutate nothing");
  const fx2 = makeClaimed("s02", "w-s02");
  const d2 = digest();
  for (const [label, args] of [
    ["a null worker id", `null::text, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid, '${fx2.token}'::uuid`],
    ["an empty worker id", `'', '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid, '${fx2.token}'::uuid`],
    ["a blank worker id", `'   ', '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid, '${fx2.token}'::uuid`],
    ["a null job id", `'w', null::uuid, '${fx2.projectId}'::uuid, '${fx2.token}'::uuid`],
    ["a null project id", `'w', '${fx2.jobId}'::uuid, null::uuid, '${fx2.token}'::uuid`],
    ["a null claim token", `'w', '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid, null::uuid`],
  ] as const) {
    const e = sqlExpectError(args);
    check("s02-invalid-args", `${label} raises SQLSTATE 22023`, e.sqlstate === "22023", `${e.sqlstate} ${e.message}`);
    check("s02-invalid-args", "…with the canonical message, echoing no argument value",
      e.message === `invalid_${VERIFY_FN}_args`, e.message);
  }
  check("s02-invalid-args", "every rejected call left all eight tables byte-identical", digest() === d2);

  /* ── s03 ─────────────────────────────────────────────────────────────── */
  console.log("\n[13] s03 — an absent row and a foreign project are both JOB_NOT_FOUND");
  const other = makeClaimed("s03-other", "w-s03b");
  const d3 = digest();
  check("s03-not-found", "an id that exists nowhere is JOB_NOT_FOUND",
    verify("w-s02", "00000000-0000-4000-8000-000000000060", fx2.projectId, fx2.token) === "JOB_NOT_FOUND");
  check("s03-not-found", "a real job addressed under another project is JOB_NOT_FOUND, not a near miss",
    verify("w-s02", fx2.jobId, other.projectId, fx2.token) === "JOB_NOT_FOUND");
  check("s03-not-found", "neither lookup changed anything", digest() === d3);

  /* ── s04 ─────────────────────────────────────────────────────────────── */
  console.log("\n[14] s04 — ownership: the fencing triple and a live lease");
  const fx4 = makeClaimed("s04", "w-s04");
  const queued = sql(`select job_id from public._m5_0060_fixture('s04-queued', 1);`);
  const queuedProject = sql(`select project_id from public.protocol_execution_jobs where id='${queued}';`);
  check("s04-not-owned", "a job that was never claimed is JOB_NOT_OWNED",
    verify("w-s04", queued, queuedProject, fx4.token) === "JOB_NOT_OWNED");
  check("s04-not-owned", "another worker holding the right token is JOB_NOT_OWNED",
    verify("w-someone-else", fx4.jobId, fx4.projectId, fx4.token) === "JOB_NOT_OWNED");
  check("s04-not-owned", "the right worker with the wrong token is JOB_NOT_OWNED",
    verify("w-s04", fx4.jobId, fx4.projectId, "00000000-0000-4000-8000-000000000061") === "JOB_NOT_OWNED");
  check("s04-not-owned", "the right worker and token on a running job is JOB_NOT_OWNED",
    (() => {
      sql(`select public._m5_0060_force_job('${fx4.jobId}'::uuid, 'running', 1, 1, null, 1, null, null);`);
      const out = verify("w-s04", fx4.jobId, fx4.projectId, fx4.token);
      forcePristine(fx4.jobId);
      return out;
    })() === "JOB_NOT_OWNED");
  sql(`select public._m5_0060_backdate_lease('${fx4.jobId}'::uuid, now() - interval '1 second');`);
  check("s04-not-owned", "a lapsed lease is JOB_NOT_OWNED even with the right worker and token",
    verify("w-s04", fx4.jobId, fx4.projectId, fx4.token) === "JOB_NOT_OWNED");
  sql(`select public._m5_0060_backdate_lease('${fx4.jobId}'::uuid, now() + interval '300 seconds');`);
  check("s04-not-owned", "and it is accepted again once the lease is live",
    verify("w-s04", fx4.jobId, fx4.projectId, fx4.token) === "VERIFIED");

  /* ── s05 ─────────────────────────────────────────────────────────────── */
  console.log("\n[15] s05 — a job freshly claimed through 0059 verifies");
  const fx5 = makeClaimed("s05", "w-s05");
  const d5 = digest();
  check("s05-verified", "the canary state between CLAIMED and reservation is VERIFIED",
    verify("w-s05", fx5.jobId, fx5.projectId, fx5.token) === "VERIFIED");
  check("s05-verified", "verifying changed nothing at all", digest() === d5);
  check("s05-verified", "it is repeatable — the verifier is not a one-shot token",
    verify("w-s05", fx5.jobId, fx5.projectId, fx5.token) === "VERIFIED" && digest() === d5);

  /* ── s06 ─────────────────────────────────────────────────────────────── */
  console.log("\n[16] s06 — each pristine-state condition, isolated where the schema allows");
  const fx6 = makeClaimed("s06", "w-s06");
  for (const [label, forceArgs] of [
    ["attempt_count is not one", `'claimed', 2, 1, null, 1, null, null`],
    ["max_attempts is not one", `'claimed', 1, 3, null, 1, null, null`],
    ["next_baseline_ordinal is not one", `'claimed', 1, 1, null, 2, null, null`],
    ["a failure_reason is already recorded", `'claimed', 1, 1, null, 1, null, 'earlier_failure'`],
  ] as const) {
    sql(`select public._m5_0060_force_job('${fx6.jobId}'::uuid, ${forceArgs});`);
    check("s06-not-clean-state", `${label} — JOB_NOT_CLEAN, with every other field pristine`,
      verify("w-s06", fx6.jobId, fx6.projectId, fx6.token) === "JOB_NOT_CLEAN");
    forcePristine(fx6.jobId);
    check("s06-not-clean-state", `…and restoring that one field alone returns it to VERIFIED`,
      verify("w-s06", fx6.jobId, fx6.projectId, fx6.token) === "VERIFIED");
  }
  // needs_review_reason cannot be isolated: a check constraint added in 0051
  // ties it to status = 'needs_review', which the ownership gate refuses
  // first. The condition in 0060 is therefore defence in depth, and this is
  // the proof that the state it guards is unreachable, not the proof that the
  // condition fired.
  const pairErr = sql(`select public._m5_0060_try_needs_review('${fx6.jobId}'::uuid);`);
  check("s06-not-clean-state",
    "a claimed job carrying a needs_review_reason is rejected by the database itself (23514), "
    + "so 0060's condition on it is defence in depth and is not exercised at runtime here",
    pairErr.startsWith("23514|"), pairErr);
  check("s06-not-clean-state", "the job is still pristine after that refused write",
    verify("w-s06", fx6.jobId, fx6.projectId, fx6.token) === "VERIFIED");

  /* ── s07 ─────────────────────────────────────────────────────────────── */
  console.log("\n[17] s07 — the blind spot: a real history behind a null current_attempt_id");
  const h = makeHistory("s07", "w-s07");
  const counts = sql(
    `select (select count(*) from public.protocol_attempts a where a.job_id='${h.jobId}')::text || '|' `
    + `|| (select count(*) from public.protocol_external_calls c where c.protocol_attempt_id='${h.attemptId}')::text || '|' `
    + `|| (select count(*) from public.provider_call_receipts r where r.external_call_id in `
    + `(select id from public.protocol_external_calls where protocol_attempt_id='${h.attemptId}'))::text || '|' `
    + `|| (select count(*) from public.analysis_call_receipts r where r.external_call_id in `
    + `(select id from public.protocol_external_calls where protocol_attempt_id='${h.attemptId}'))::text || '|' `
    + `|| (select count(*) from public.probe_runs pr where pr.id='${h.probeRunId}')::text || '|' `
    + `|| (select count(*) from public.probe_results pres where pres.probe_run_id='${h.probeRunId}')::text;`
  );
  check("s07-not-clean-history",
    "the fixture really produced one attempt, two external calls, both receipts, a probe_run and a probe_result",
    counts === "1|2|1|1|1|1", counts);

  // The state a crash leaves: the row looks exactly like a fresh claim, while
  // every history row above is still on record.
  forcePristine(h.jobId);
  const rowLooksFresh = sql(
    `select (attempt_count = 1 and max_attempts = 1 and current_attempt_id is null `
    + `and next_baseline_ordinal = 1 and needs_review_reason is null and failure_reason is null `
    + `and status = 'claimed')::text from public.protocol_execution_jobs where id='${h.jobId}';`
  );
  check("s07-not-clean-history", "the job row is now indistinguishable from a fresh claim",
    rowLooksFresh === "true", rowLooksFresh);

  const ctxSelect = (expr: string): string => sql(
    `select ${expr} from public.get_protocol_execution_job_context(`
    + `'${h.jobId}'::uuid, '${h.token}'::uuid, '${h.projectId}'::uuid);`
  );
  const ctx = ctxSelect(
    "status || '|' || (current_attempt is null)::text || '|' "
    + "|| coalesce(array_length(external_calls, 1), 0)::text || '|' "
    + "|| coalesce(array_length(provider_receipts, 1), 0)::text || '|' "
    + "|| coalesce(array_length(analysis_receipts, 1), 0)::text || '|' "
    + "|| (probe_run is null)::text || '|' || (probe_result is null)::text"
  );
  check("s07-not-clean-history",
    "get_protocol_execution_job_context answers OK and reports no attempt, no external call, "
    + "no receipt, no probe_run and no probe_result for this job",
    ctx === "OK|true|0|0|0|true|true", ctx);
  // Said precisely: that context is not blind to the job, it is scoped to the
  // CURRENT attempt. Its one job-scoped field is a slot counter, which is not
  // the paid history a canary must refuse to spend over.
  const slots = ctxSelect("completed_baseline_slots::text");
  check("s07-not-clean-history",
    "the one job-scoped field it does expose is completed_baseline_slots — a slot count, "
    + "not the attempt, calls, receipts or result the canary must not spend over",
    /^\d+$/.test(slots), slots);

  const d7 = digest();
  check("s07-not-clean-history",
    "the verifier refuses the same job as JOB_NOT_CLEAN — this is the blind spot closed",
    verify("w-s07", h.jobId, h.projectId, h.token) === "JOB_NOT_CLEAN");
  check("s07-not-clean-history", "and it refused without touching a single row", digest() === d7);

  // The control: the same forced-pristine row, with no history at all, is
  // accepted — so it is the history walk that refused above, not the state.
  const control = makeClaimed("s07-control", "w-s07c");
  forcePristine(control.jobId);
  check("s07-not-clean-history",
    "an identically-shaped row with no history at all is VERIFIED — the history walk is what refused",
    verify("w-s07c", control.jobId, control.projectId, control.token) === "VERIFIED");

  // A current_attempt_id that is set is refused too. It cannot be isolated
  // from the history walk: the FK requires the attempt to exist in the same
  // project, and a project here owns exactly one job — so an attempt row is
  // part of that job's history by construction. Both checks bite together.
  sql(`select public._m5_0060_force_job('${h.jobId}'::uuid, 'claimed', 1, 1, `
    + `'${h.attemptId}'::uuid, 1, null, null);`);
  check("s07-not-clean-history",
    "a job whose current_attempt_id is set is JOB_NOT_CLEAN (state and history both refuse it)",
    verify("w-s07", h.jobId, h.projectId, h.token) === "JOB_NOT_CLEAN");

  /* ── s08 ─────────────────────────────────────────────────────────────── */
  console.log("\n[18] s08 — the protocol must still be admissible");
  const fx8 = makeClaimed("s08", "w-s08");
  const setStatus = (status: string): void => {
    sql(`select public._m5_0060_set_protocol_status('${fx8.protocolId}'::uuid, '${status}');`);
  };
  const protocolStatus = (): string =>
    sql(`select status from public.protocols where id='${fx8.protocolId}';`);
  check("s08-protocol-not-eligible", "an approved protocol verifies",
    verify("w-s08", fx8.jobId, fx8.projectId, fx8.token) === "VERIFIED");
  // `draft` is not reachable for an approved protocol: 0047 pairs the status
  // with approved_by/approved_at. The statuses a real protocol can actually
  // reach after approval — and which must stop a new paid canary — are these.
  for (const status of ["completed", "abandoned"] as const) {
    setStatus(status);
    check("s08-protocol-not-eligible", `a protocol in \`${status}\` is PROTOCOL_NOT_ELIGIBLE`,
      verify("w-s08", fx8.jobId, fx8.projectId, fx8.token) === "PROTOCOL_NOT_ELIGIBLE");
  }
  setStatus("active");
  check("s08-protocol-not-eligible", "`active` is admissible as well as `approved`",
    verify("w-s08", fx8.jobId, fx8.projectId, fx8.token) === "VERIFIED");
  setStatus("approved");
  check("s08-protocol-not-eligible", "the protocol is approved again and the job verifies",
    protocolStatus() === "approved"
    && verify("w-s08", fx8.jobId, fx8.projectId, fx8.token) === "VERIFIED");

  /* ── s09 ─────────────────────────────────────────────────────────────── */
  console.log("\n[19] s09 — every outcome, back to back, changes nothing anywhere");
  // Each precondition is arranged BEFORE the digest is taken, so the measured
  // window contains the verification and nothing else.
  const seen = new Set<string>();
  for (const [label, prepare, call] of [
    ["JOB_NOT_FOUND", () => {},
      () => verify("w-s05", "00000000-0000-4000-8000-000000000062", fx5.projectId, fx5.token)],
    ["JOB_NOT_OWNED", () => {},
      () => verify("w-nobody", fx5.jobId, fx5.projectId, fx5.token)],
    ["JOB_NOT_CLEAN", () => {},
      () => verify("w-s07", h.jobId, h.projectId, h.token)],
    ["PROTOCOL_NOT_ELIGIBLE", () => { setStatus("completed"); },
      () => verify("w-s08", fx8.jobId, fx8.projectId, fx8.token)],
    ["VERIFIED", () => { setStatus("approved"); },
      () => verify("w-s05", fx5.jobId, fx5.projectId, fx5.token)],
  ] as [string, () => void, () => string][]) {
    prepare();
    const before = digest();
    const out = call();
    seen.add(out);
    check("s09-read-only", `${label} was produced, and all eight tables are byte-identical`,
      out === label && digest() === before, out);
  }
  check("s09-read-only", "all five closed outcomes were exercised in this run",
    seen.size === 5 && [...seen].sort().join(",")
      === "JOB_NOT_CLEAN,JOB_NOT_FOUND,JOB_NOT_OWNED,PROTOCOL_NOT_ELIGIBLE,VERIFIED",
    [...seen].sort().join(","));

  // A data-modifying statement inside a STABLE function is refused by the
  // engine. That is what makes read-only a property of the definition rather
  // than of this file's sampling.
  const beforeDml = digest();
  const dml = sql("select public._m5_0060_try_stable_write();");
  check("s09-read-only",
    "a STABLE function that attempts a write is refused by PostgreSQL itself "
    + "(0A000, \"UPDATE is not allowed in a non-volatile function\")",
    dml.startsWith("0A000|") && dml.includes("not allowed in a non-volatile function"), dml);
  check("s09-read-only", "that refusal left all eight tables byte-identical", digest() === beforeDml);
}

/* ═══════════════════════════════ entry ══════════════════════════════════ */

main().then(() => {
  const missing = ROSTER.filter((s) => !ran.has(s));
  const executed = ROSTER.length - missing.length;
  if (missing.length > 0) {
    console.log(`\n✗ scenarios that never ran: ${missing.join(", ")}`);
    console.log(`\n${passed}/${passed + failed} checks passed, ${executed}/${ROSTER.length} scenarios executed. M5 0060 runtime contract FAILED.`);
    process.exit(1);
  }
  console.log(`\n${passed}/${passed + failed} checks passed, ${executed}/${ROSTER.length} scenarios executed. `
    + `M5 0060 runtime contract ${failed === 0 ? "PASSED" : "FAILED"}.`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.log(`\n✗ ${(e as Error).message}`);
  const executedOnError = ROSTER.filter((s) => ran.has(s)).length;
  console.log(`\n${passed}/${passed + failed} checks passed, ${executedOnError}/${ROSTER.length} scenarios executed. M5 0060 runtime contract FAILED.`);
  process.exit(1);
});
