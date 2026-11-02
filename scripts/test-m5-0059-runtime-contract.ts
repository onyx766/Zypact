#!/usr/bin/env tsx
/**
 * M5 — real PostgreSQL contract for migration 0059 (D-031 targeted claim).
 *
 * D-031 says in as many words that a memory-adapter contract is not enough,
 * because it cannot demonstrate SQL locking. Neither can static text review:
 * `FOR UPDATE NOWAIT`, the four closed outcomes, and "exactly one winner in a
 * real race" are properties of a running PostgreSQL, or they are nothing.
 *
 * Discipline, inherited from the 0050 and 0054 harnesses:
 *   - opt-in only: does nothing unless ZYPACT_M5_0059_RUNTIME_TEST=1;
 *   - a disposable project in a fresh mktemp, outside the repository;
 *   - a unique project id and a free port block, chosen at run time;
 *   - it never targets, inspects for mutation, stops or removes any container
 *     it did not itself create, and never runs `docker ... prune`;
 *   - no .env, no remote database, no provider, no network beyond the local
 *     Docker socket;
 *   - the image list is photographed before and after, and the run FAILS if it
 *     moved. That is DETECTION, not prevention: nothing in this file is
 *     capable of stopping a download. The guarantee comes from the operator
 *     running it on a host whose cache is already complete;
 *   - cleanup happens only after a completely successful run; on any failure
 *     the disposable workdir is preserved for diagnosis;
 *   - a SKIP is never reported as a pass, and exits non-zero.
 *
 * Only the Supabase PostgreSQL container is started. The optional-service
 * list is not hard-coded: it is read back from `supabase start --help` and
 * checked against the set this CLI version is expected to offer, so a CLI
 * upgrade that adds a service cannot silently start it.
 *
 * The ordering is itself part of the proof. Migrations 0001..0058 are applied
 * first, the global claim function's catalogue identity is captured, local
 * advisors are run — all *before* 0059 exists and before this file creates a
 * single helper of its own. Only then is 0059 applied, and the identity and
 * the advisor findings are required to be unchanged. Anything 0059 breaks is
 * therefore attributable to 0059 and to nothing else.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowlistDrift, allowlistWith, INVALID_MIGRATION_NAMES, ledgerRefuses, migrationLedger, TIMESTAMP_FIXTURE,
} from "./lib/migration-names";

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

// QD-6: every migration file is parsed by the shared rules (exact four-digit
// allowlist, validated 14-digit timestamps), so each "no later migration"
// guard below also examines a timestamped migration.
const ledger = (extra: Record<string, string> = {}) => migrationLedger(MIGRATIONS_DIR, extra);
const OPT_IN = "ZYPACT_M5_0059_RUNTIME_TEST";
const DEFAULT_DOCKER_BIN_DIR = "/Applications/Docker.app/Contents/Resources/bin";
const DOCKER_BIN_DIR = process.env.ZYPACT_DOCKER_BIN_DIR ?? DEFAULT_DOCKER_BIN_DIR;

/** The optional services this CLI version must offer, in the order it lists them. */
const EXPECTED_OPTIONAL_SERVICES = [
  "gotrue", "realtime", "storage-api", "imgproxy", "kong", "mailpit", "postgrest",
  "postgres-meta", "studio", "edge-runtime", "logflare", "vector", "supavisor",
] as const;

const TARGETED_FN = "claim_protocol_execution_job_by_id";
const GLOBAL_FN = "claim_protocol_execution_job";

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

function skip(reason: string): never {
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
  const raw = sql(`select public._m5_0059_sqlstate(${args});`);
  if (raw === "NO_ERROR") return { sqlstate: "", message: "no error raised" };
  const i = raw.indexOf("|");
  return { sqlstate: raw.slice(0, i), message: raw.slice(i + 1) };
}

interface Session {
  readonly send: (statement: string) => void;
  readonly close: () => Promise<void>;
  readonly output: () => string;
}

function openSession(): Session {
  const child = spawn("psql", [DB_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
    env: RUN_ENV, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
  return {
    send: (statement: string) => { child.stdin.write(`${statement}\n`); },
    output: () => out,
    close: () => new Promise<void>((resolve) => {
      // A child that has already exited or been signalled will never emit
      // another `close`, so waiting for one would hang the harness for good.
      // An early death of the lock holder must not cost us the whole run.
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      try { child.stdin.end(); } catch { /* the pipe is already gone */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}

/**
 * A holder connection that reports, itself, the moment it owns the row lock.
 * Waiting on a fixed delay would only prove that time passed; the sentinel is
 * emitted by the same session, after `FOR UPDATE` returned, so seeing it is
 * evidence the lock is actually held.
 */
async function holdRowLock(jobId: string, tag: string, timeoutMs = 15_000): Promise<Session> {
  const sentinel = `LOCK_ACQUIRED_${tag}`;
  const s = openSession();
  s.send("begin;");
  s.send(`select id from public.protocol_execution_jobs where id='${jobId}' for update;`);
  s.send(`select '${sentinel}';`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (s.output().includes(sentinel)) return s;
    await sleep(20);
  }
  await s.close();
  throw new Error(`the holder session never confirmed acquiring the lock on ${jobId} within ${timeoutMs} ms`);
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
  if (new Set(raw).size !== raw.length) throw new Error(`the --exclude service list contains duplicates: ${raw.join(",")}`);
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

/* ═══════════════════════════════ main ═══════════════════════════════════ */

/**
 * Static, before the opt-in gate: the step-5 selection reads every migration
 * through `ledger()`, so prove here that a timestamped migration is validated
 * and ordered after 0059 (never selected into 1..59), and that every invalid
 * name fails instead of being skipped. Never counted among the runtime checks.
 */
function migrationSelectionPreflight(): void {
  const real = ledger().filter((x) => x.n >= 1 && x.n <= 59);
  const withFixture = ledger({ [TIMESTAMP_FIXTURE]: "select 1;" });
  const cases: Array<[string, boolean]> = [
    ["the real directory selects exactly 0001..0059", real.length === 59 && real.every((x, i) => x.n === i + 1)],
    ["a valid 14-digit migration is accepted, ordered last and not selected",
      withFixture[withFixture.length - 1]?.f === TIMESTAMP_FIXTURE &&
        withFixture.filter((x) => x.n >= 1 && x.n <= 59).length === 59],
    ...INVALID_MIGRATION_NAMES.map(({ label, extra, allow }): [string, boolean] =>
      [`${label} is refused`, ledgerRefuses(MIGRATIONS_DIR, extra, allowlistWith(allow))]),
    ["the migrations directory matches the exact four-digit allowlist", allowlistDrift(readdirSync(MIGRATIONS_DIR)).length === 0],
  ];
  console.log("Preflight: migration selection (static, no Docker)");
  for (const [name, ok] of cases) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (cases.some(([, ok]) => !ok)) {
    console.log("✗ FATAL: migration-selection preflight failed. Nothing else will run.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  migrationSelectionPreflight();
  if (process.env[OPT_IN] !== "1") {
    skip(`${OPT_IN} is not set to "1". Set it explicitly to run this contract `
      + `(e.g. ${OPT_IN}=1 npm run test:m5-0059-runtime).`);
  }

  console.log("=== M5 0059 runtime contract — real PostgreSQL, no provider, no remote ===\n");

  if (!tryRun("docker", ["version"]).ok) {
    skip(`Docker is not reachable. Set ZYPACT_DOCKER_BIN_DIR (currently "${DOCKER_BIN_DIR}").`);
  }
  if (!tryRun("supabase", ["--version"]).ok) skip("The Supabase CLI is not available.");
  if (!tryRun("psql", ["--version"]).ok) skip("psql is not available.");
  const cliVersion = run("supabase", ["--version"]).trim();
  console.log(`Docker, Supabase CLI (${cliVersion}) and psql detected — proceeding.\n`);

  const imagesBefore = run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"])
    .split("\n").map((l) => l.trim()).filter(Boolean).sort();

  console.log("[1] The optional-service list is read from the CLI, not assumed");
  const help = run("supabase", ["start", "--help"]);
  const services = extractOptionalServices(help);
  check("services-parsed", "the --exclude list parses into a non-empty, duplicate-free set",
    services.length > 0 && new Set(services).size === services.length);
  check("services-exact", "it is exactly the set this CLI version is expected to offer",
    JSON.stringify([...services].sort()) === JSON.stringify([...EXPECTED_OPTIONAL_SERVICES].sort()),
    services.join(","));
  if (failed > 0) throw new Error(`the optional-service list differs from the expected set: ${services.join(",")}`);

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0059-runtime-"));
  let stackStarted = false;
  let success = false;

  try {
    console.log(`\n[2] Disposable project: ${workdir}`);
    check("workdir-outside-repo", "the workdir is outside the repository", !workdir.startsWith(REPO_ROOT));
    run("supabase", ["init", "--workdir", workdir, "--yes"]);

    const configPath = path.join(workdir, "supabase", "config.toml");
    let config = readFileSync(configPath, "utf8");
    let section = "";
    config = config.split("\n").map((line) => {
      if (line.startsWith("[")) section = line.trim();
      if (section === "[db.seed]" && /^enabled\s*=/.test(line)) return "enabled = false";
      return line;
    }).join("\n");
    check("seed-disabled", "the seed is disabled in the generated config",
      /\[db\.seed\][\s\S]{0,200}?enabled = false/.test(config));

    const declaredPorts = [...config.matchAll(/^port = (\d+)$/gm)].map((m) => Number(m[1]));
    const offset = await chooseOffset(declaredPorts);
    if (offset !== 0) {
      config = config.replace(/^port = (\d+)$/gm, (_m, p: string) => `port = ${Number(p) + offset}`);
    }
    writeFileSync(configPath, config);
    const dbPort = 54322 + offset;
    console.log(`  port offset: +${offset} (db on ${dbPort})`);
    check("ports-free", "every declared port was free before starting",
      (await Promise.all(declaredPorts.map((p) => portFree(p + offset)))).every(Boolean));

    console.log("\n[3] A single `supabase start`, with every optional service excluded");
    run("supabase", ["start", "--workdir", workdir, "--exclude", services.join(",")]);
    stackStarted = true;
    DB_URL = `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`;

    const imagesAfter = run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"])
      .split("\n").map((l) => l.trim()).filter(Boolean).sort();
    check("no-pull", "the image list is unchanged — a download would be detected here, not prevented",
      JSON.stringify(imagesAfter) === JSON.stringify(imagesBefore),
      `before ${imagesBefore.length}, after ${imagesAfter.length}`);
    check("no-latest", "no `latest` tag is involved", !imagesAfter.some((i) => i.endsWith(":latest")));

    const projectId = path.basename(workdir);
    const mine = run("docker", ["ps", "--format", "{{.Names}}"]).split("\n")
      .map((s) => s.trim()).filter((s) => s.includes(projectId));
    check("only-postgres", "the disposable project created exactly one container, a database",
      mine.length === 1 && /db/.test(mine[0]), mine.join(",") || "none");

    console.log("\n[4] The base carries the roles and extensions the migrations assume");
    check("pg-reachable", "PostgreSQL answers", /^PostgreSQL /.test(sql("select version();", false)));
    const roles = sql("select rolname from pg_roles where rolname in "
      + "('anon','authenticated','service_role') order by 1;", false).split("\n").filter(Boolean);
    check("roles", "anon, authenticated and service_role all exist",
      JSON.stringify(roles) === JSON.stringify(["anon", "authenticated", "service_role"]), roles.join(","));
    check("pgcrypto", "pgcrypto is installed",
      sql("select count(*) from pg_extension where extname='pgcrypto';", false) === "1");
    check("gen-random-uuid", "gen_random_uuid() is callable",
      sql("select gen_random_uuid() is not null;", false) === "t");
    check("auth-schema", "the auth schema exists",
      sql("select count(*) from pg_namespace where nspname='auth';", false) === "1");

    // ── 5. 0001..0058 first ────────────────────────────────────────────────
    console.log("\n[5] Migrations 0001..0058, selected by number and applied in order");
    const numbered = ledger()
      .filter((x) => x.n >= 1 && x.n <= 59);
    check("migration-count", "exactly 59 numbered migrations are selected", numbered.length === 59, String(numbered.length));
    check("migration-contiguous", "their numbers run 1..59 with no gap and no duplicate",
      numbered.every((x, i) => x.n === i + 1));
    check("migration-0059-last", "0059 is the last one",
      numbered[numbered.length - 1]?.f === "0059_m5_phase3d_targeted_claim.sql");
    const upTo58 = numbered.filter((x) => x.n <= 58);
    for (const { f } of upTo58) {
      run("psql", [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", path.join(MIGRATIONS_DIR, f)]);
    }
    console.log(`  applied ${upTo58.length} migrations (0001..0058)`);

    // ── 6. the global function, as 0058 leaves it ─────────────────────────
    console.log("\n[6] s15 — the global claim function is fingerprinted before 0059 exists");
    const globalIdentity = (): { count: string; sig: string; def: string } => ({
      count: sql(`select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace `
        + `where n.nspname='public' and p.proname='${GLOBAL_FN}';`, false),
      sig: sql(`select pg_get_function_identity_arguments(p.oid) from pg_proc p `
        + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' `
        + `and p.proname='${GLOBAL_FN}';`, false),
      def: sql(`select md5(pg_get_functiondef(p.oid)) from pg_proc p `
        + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' `
        + `and p.proname='${GLOBAL_FN}';`, false),
    });
    const before59 = globalIdentity();
    check("s15-global-identity", "exactly one global claim function exists after 0058",
      before59.count === "1", before59.count);
    check("s15-global-identity", "its identity arguments are the canonical two",
      before59.sig === "p_worker_id text, p_lease_seconds integer", before59.sig);
    check("s15-global-identity", "its body has a stable digest", /^[0-9a-f]{32}$/.test(before59.def));

    // ── 7. advisors BEFORE 0059, and before this file creates anything ────
    console.log("\n[7] s16 — local advisors, after 0058 and before any helper of ours exists");
    const advHelp = tryRun("supabase", ["db", "advisors", "--help"]);
    if (!advHelp.ok || !/--local/.test(advHelp.out)) {
      throw new Error("`supabase db advisors --local` is unavailable on this CLI version. "
        + "This opt-in runtime contract requires it and will not pass without it.");
    }
    const advBefore = runAdvisors(workdir, "after 0058");
    printAdvisors("after 0058", advBefore);
    check("s16-advisors", "advisors ran against the disposable stack after 0058", true);

    // ── 8. 0059 ───────────────────────────────────────────────────────────
    console.log("\n[8] Migration 0059 applied on top");
    run("psql", [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1",
      "-f", path.join(MIGRATIONS_DIR, "0059_m5_phase3d_targeted_claim.sql")]);
    console.log("  applied 0059");

    // ── 9. strict identity of the global function ─────────────────────────
    console.log("\n[9] s15 — 0059 left the global claim function strictly identical");
    const after59 = globalIdentity();
    check("s15-global-identity", "the overload count is unchanged",
      after59.count === before59.count, `${before59.count} -> ${after59.count}`);
    check("s15-global-identity", "the identity arguments are unchanged",
      after59.sig === before59.sig, `${before59.sig} -> ${after59.sig}`);
    check("s15-global-identity", "pg_get_functiondef is byte-identical",
      after59.def === before59.def, `${before59.def} -> ${after59.def}`);

    // ── 10. advisors AFTER 0059 ───────────────────────────────────────────
    console.log("\n[10] s16 — advisors after 0059: nothing new may appear");
    const advAfter = runAdvisors(workdir, "after 0059");
    printAdvisors("after 0059", advAfter);
    const beforeKeys = new Set(advBefore.map(advKey));
    const introduced = advAfter.filter((e) => !beforeKeys.has(advKey(e))
      && (e.level === "ERROR" || e.level === "WARN" || e.level === "WARNING"));
    if (introduced.some((e) => e.object.includes(TARGETED_FN))) {
      throw new Error(`advisors attribute a finding to ${TARGETED_FN} itself: `
        + `${introduced.filter((e) => e.object.includes(TARGETED_FN)).map(advKey).join(" ; ")}. `
        + "Fixing that would mean editing the migration, which is outside this scope. Stopping.");
    }
    check("s16-advisors", "0059 introduced no new WARN or ERROR",
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
    if (success && workdir.startsWith(path.join(tmpdir(), "zypact-m5-0059-runtime-"))) {
      rmSync(workdir, { recursive: true, force: true });
      console.log(`Removed disposable workdir: ${workdir}`);
    } else if (existsSync(workdir)) {
      console.log(`Workdir PRESERVED for diagnosis: ${workdir}`);
    }
  }
}

/* ═══════════════════════════ the closed roster ══════════════════════════ */

const ROSTER = [
  "s01-catalogue", "s02-invalid-args", "s03-absent", "s04-wrong-project",
  "s05-max-attempts-3", "s06-already-claimed", "s07-locked", "s08-older-sibling",
  "s09-successful-mutation", "s10-no-sweep", "s11-after-winner", "s12-real-race",
  "s13-failure-purity", "s14-global-unchanged", "s15-global-identity", "s16-advisors",
] as const;

/**
 * The two helpers this contract needs. Both are hardened the way the
 * repository hardens its own SECURITY DEFINER surfaces — a pinned
 * search_path, no privilege for PUBLIC/anon/authenticated, execute for
 * service_role alone — so that creating them cannot itself become a finding.
 */
const FIXTURE_SQL = `
create or replace function public._m5_0059_fixture(p_label text, p_max_attempts integer)
returns table (project_id uuid, protocol_id uuid, job_id uuid)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_project_id uuid; v_bq_id uuid; v_bqv_id uuid; v_protocol_id uuid; v_job_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
begin
  insert into public.projects (domain, company_name)
    values ('m5-0059-' || p_label || '-' || gen_random_uuid()::text || '.test', 'M5 0059 ' || p_label)
    returning id into v_project_id;
  insert into public.buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into public.buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label,
    'hash-m5-0059-' || p_label || '-' || gen_random_uuid()::text,
    'shortlist', 4, 3, 10, 'm5 0059 runtime contract fixture', 'founder_supplied'
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
revoke all on function public._m5_0059_fixture(text, integer) from public;
revoke all on function public._m5_0059_fixture(text, integer) from anon;
revoke all on function public._m5_0059_fixture(text, integer) from authenticated;
grant execute on function public._m5_0059_fixture(text, integer) to service_role;

create or replace function public._m5_0059_sqlstate(
  p_worker text, p_lease integer, p_job uuid, p_project uuid
) returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $g$
begin
  perform * from public.claim_protocol_execution_job_by_id(p_worker, p_lease, p_job, p_project);
  return 'NO_ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end;
$g$;
revoke all on function public._m5_0059_sqlstate(text, integer, uuid, uuid) from public;
revoke all on function public._m5_0059_sqlstate(text, integer, uuid, uuid) from anon;
revoke all on function public._m5_0059_sqlstate(text, integer, uuid, uuid) from authenticated;
grant execute on function public._m5_0059_sqlstate(text, integer, uuid, uuid) to service_role;
`;

interface Fixture { projectId: string; protocolId: string; jobId: string }

function makeFixture(label: string, maxAttempts: number): Fixture {
  const row = sql(`select project_id, protocol_id, job_id from public._m5_0059_fixture('${label}', ${maxAttempts});`);
  const [projectId, protocolId, jobId] = row.split("|");
  return { projectId, protocolId, jobId };
}

function claim(jobId: string | null, projectId: string | null, worker = "w-0059", lease = 60): string {
  const j = jobId === null ? "null::uuid" : `'${jobId}'::uuid`;
  const p = projectId === null ? "null::uuid" : `'${projectId}'::uuid`;
  return sql(`select outcome, (job is null), (claim_token is null) `
    + `from public.${TARGETED_FN}('${worker}', ${lease}, ${j}, ${p});`);
}

function jobRow(jobId: string): Record<string, string> {
  const r = sql(`select status, attempt_count, max_attempts, coalesce(worker_id,''), `
    + `coalesce(claim_token::text,''), coalesce(lease_expires_at::text,''), updated_at::text `
    + `from public.protocol_execution_jobs where id='${jobId}';`).split("|");
  return {
    status: r[0], attempt_count: r[1], max_attempts: r[2], worker_id: r[3],
    claim_token: r[4], lease: r[5], updated_at: r[6],
  };
}

/**
 * Every column of every row, as JSON, ordered by id. `to_jsonb(j)` leaves
 * nothing out — updated_at, project_id, protocol_id, max_attempts and the
 * provenance columns are all inside the digest, so "nothing changed" means
 * nothing, not "nothing among the columns I remembered to list".
 */
function tableDigest(): string {
  return sql("select coalesce(md5(string_agg(to_jsonb(j)::text, '|' order by j.id)), 'EMPTY') "
    + "from public.protocol_execution_jobs j;", false);
}

/**
 * The same idea as `tableDigest`, narrowed to one row: every column, as JSON,
 * so an "unchanged, column for column" claim is exactly that and not a
 * comparison of the handful of columns `jobRow` happens to select.
 */
function rowDigest(jobId: string): string {
  return sql("select coalesce(md5(to_jsonb(j)::text), 'ABSENT') "
    + `from public.protocol_execution_jobs j where j.id='${jobId}';`, false);
}

async function runScenarios(): Promise<void> {
  sql(FIXTURE_SQL, false);

  console.log("\n[11] s01 — catalogue identity and real privileges");
  const sig = sql(`select pg_get_function_identity_arguments(p.oid) from pg_proc p `
    + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${TARGETED_FN}';`, false);
  check("s01-catalogue", "the function exists with the exact four-argument identity",
    sig === "p_worker_id text, p_lease_seconds integer, p_job_id uuid, p_project_id uuid", sig);
  const props = sql(`select p.prosecdef::text || '|' || p.provolatile::text || '|' || `
    + `coalesce(array_to_string(p.proconfig,','),'') from pg_proc p join pg_namespace n `
    + `on n.oid=p.pronamespace where n.nspname='public' and p.proname='${TARGETED_FN}';`, false);
  check("s01-catalogue", "it is SECURITY DEFINER, VOLATILE, with the pinned search_path",
    props === "true|v|search_path=public, pg_temp", props);
  const acl = ["public", "anon", "authenticated", "service_role"].map((r) =>
    `${r}=${sql(`select has_function_privilege('${r}', p.oid, 'EXECUTE')::text from pg_proc p `
      + `join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${TARGETED_FN}';`, false)}`).join(" ");
  check("s01-catalogue", "only service_role may execute it",
    acl === "public=false anon=false authenticated=false service_role=true", acl);

  console.log("\n[12] s02 — invalid arguments raise 22023 and mutate nothing");
  const fx2 = makeFixture("s02", 1);
  const d2 = tableDigest();
  for (const [label, args] of [
    ["a null worker id", `null::text, 60, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
    ["an empty worker id", `'', 60, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
    ["a blank worker id", `'   ', 60, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
    ["a null lease", `'w', null::integer, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
    ["a zero lease", `'w', 0, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
    ["a negative lease", `'w', -1, '${fx2.jobId}'::uuid, '${fx2.projectId}'::uuid`],
  ] as const) {
    const e = sqlExpectError(args);
    check("s02-invalid-args", `${label} raises SQLSTATE 22023`, e.sqlstate === "22023", `${e.sqlstate} ${e.message}`);
    check("s02-invalid-args", `…with the canonical message`,
      e.message.includes("invalid_claim_protocol_execution_job_args"), e.message);
  }
  check("s02-invalid-args", "every rejected call left the whole table byte-identical", tableDigest() === d2);

  console.log("\n[13] s03/s04 — an absent row and a foreign project are both JOB_NOT_FOUND");
  const fx3 = makeFixture("s03", 1);
  const fx4 = makeFixture("s04", 1);
  // Both fixtures exist before the digest is taken: creating one inserts a
  // row, and a digest captured earlier would move for a lawful reason and
  // say nothing about the three calls under test.
  const fx3Before = rowDigest(fx3.jobId);
  const d3 = tableDigest();
  check("s03-absent", "an unknown job id returns JOB_NOT_FOUND with a null payload",
    claim("00000000-0000-4000-8000-000000000000", fx3.projectId) === "JOB_NOT_FOUND|t|t");
  check("s03-absent", "a null identifier is the same fact, reported the same way",
    claim(null, null) === "JOB_NOT_FOUND|t|t");
  check("s04-wrong-project", "the right job under the wrong project is JOB_NOT_FOUND",
    claim(fx3.jobId, fx4.projectId) === "JOB_NOT_FOUND|t|t");
  check("s04-wrong-project", "fx3 is exactly as it was before those three calls, column for column",
    rowDigest(fx3.jobId) === fx3Before);
  check("s04-wrong-project", "and the whole table is byte-identical", tableDigest() === d3);

  console.log("\n[14] s05 — a multi-attempt candidate is never eligible");
  const fx5 = makeFixture("s05", 3);
  const d5 = tableDigest();
  check("s05-max-attempts-3", "max_attempts = 3 returns JOB_NOT_ELIGIBLE with a null payload",
    claim(fx5.jobId, fx5.projectId) === "JOB_NOT_ELIGIBLE|t|t");
  check("s05-max-attempts-3", "and the whole table is byte-identical", tableDigest() === d5);

  console.log("\n[15] s06 — an already-claimed or already-attempted job is not eligible");
  const fx6 = makeFixture("s06", 1);
  check("s06-already-claimed", "the first claim succeeds", claim(fx6.jobId, fx6.projectId) === "CLAIMED|f|f");
  const d6 = tableDigest();
  check("s06-already-claimed", "a second call is JOB_NOT_ELIGIBLE",
    claim(fx6.jobId, fx6.projectId) === "JOB_NOT_ELIGIBLE|t|t");
  check("s06-already-claimed", "and the second call changed nothing at all", tableDigest() === d6);

  console.log("\n[16] s07 — a row locked by another connection is JOB_LOCKED, without waiting");
  const fx7 = makeFixture("s07", 1);
  const holder = await holdRowLock(fx7.jobId, "s07");
  const d7 = tableDigest();
  const t0 = Date.now();
  const locked = claim(fx7.jobId, fx7.projectId);
  const elapsed = Date.now() - t0;
  check("s07-locked", "the outcome is JOB_LOCKED with a null payload", locked === "JOB_LOCKED|t|t", locked);
  check("s07-locked", "it returned promptly rather than waiting on the lock", elapsed < 5_000, `${elapsed} ms`);
  check("s07-locked", "nothing in the table moved while the lock was held", tableDigest() === d7);
  holder.send("rollback;");
  await holder.close();
  check("s07-locked", "the job is still queued and never attempted",
    jobRow(fx7.jobId).status === "queued" && jobRow(fx7.jobId).attempt_count === "0");

  console.log("\n[17] s08 — an older eligible sibling is never claimed in its place");
  const older = makeFixture("s08-older", 1);
  const target = makeFixture("s08-target", 1);
  const olderBefore = rowDigest(older.jobId);
  check("s08-older-sibling", "the targeted job is the one claimed",
    claim(target.jobId, target.projectId) === "CLAIMED|f|f");
  check("s08-older-sibling", "the older sibling is untouched, column for column",
    rowDigest(older.jobId) === olderBefore);

  console.log("\n[18] s09 — the successful mutation is the canonical one, and identities line up");
  const fx9 = makeFixture("s09", 1);
  const before9 = jobRow(fx9.jobId);
  const claimed = sql(`select outcome, `
    + `((job).id = '${fx9.jobId}'::uuid)::text, `
    + `((job).project_id = '${fx9.projectId}'::uuid)::text, `
    + `((job).protocol_id = '${fx9.protocolId}'::uuid)::text, `
    + `(job).status, (job).worker_id, (job).attempt_count::text, `
    + `((job).claim_token = claim_token)::text, `
    + `((job).lease_expires_at > now())::text, `
    + `((job).lease_expires_at <= now() + interval '61 seconds')::text, `
    + `((job).updated_at > '${before9.updated_at}'::timestamptz)::text, `
    + `claim_token::text, `
    + `(job).lease_expires_at::text, `
    + `(job).updated_at::text `
    + `from public.${TARGETED_FN}('w-0059', 60, '${fx9.jobId}'::uuid, '${fx9.projectId}'::uuid);`);
  const f9 = claimed.split("|");
  check("s09-successful-mutation", "the outcome is CLAIMED", f9[0] === "CLAIMED", claimed);
  check("s09-successful-mutation", "the returned job id is the one asked for", f9[1] === "true", f9[1]);
  check("s09-successful-mutation", "the returned project id is the one asked for", f9[2] === "true", f9[2]);
  check("s09-successful-mutation", "the returned protocol id belongs to that fixture", f9[3] === "true", f9[3]);
  check("s09-successful-mutation", "status, worker and increment are canonical",
    f9[4] === "claimed" && f9[5] === "w-0059" && f9[6] === "1", `${f9[4]}/${f9[5]}/${f9[6]}`);
  check("s09-successful-mutation", "the token inside the returned row is the returned token",
    f9[7] === "true", f9[7]);
  check("s09-successful-mutation", "the lease is in the future and within p_lease_seconds",
    f9[8] === "true" && f9[9] === "true", `${f9[8]}/${f9[9]}`);
  check("s09-successful-mutation", "updated_at really moved forward", f9[10] === "true", f9[10]);
  const persisted = jobRow(fx9.jobId);
  check("s09-successful-mutation", "the persisted token is identical to the returned one",
    persisted.claim_token === f9[11] && f9[11].length === 36, `${persisted.claim_token} vs ${f9[11]}`);
  check("s09-successful-mutation", "the persisted lease is identical to the returned one",
    persisted.lease === f9[12] && f9[12].length > 0, `${persisted.lease} vs ${f9[12]}`);
  check("s09-successful-mutation", "the persisted updated_at is identical to the returned one",
    persisted.updated_at === f9[13] && f9[13].length > 0, `${persisted.updated_at} vs ${f9[13]}`);
  check("s09-successful-mutation", "the persisted status, worker and attempt count are canonical",
    persisted.status === "claimed" && persisted.worker_id === "w-0059" && persisted.attempt_count === "1",
    `${persisted.status}/${persisted.worker_id}/${persisted.attempt_count}`);
  check("s09-successful-mutation", "the persisted updated_at is later than before the call",
    persisted.updated_at > before9.updated_at, `${before9.updated_at} -> ${persisted.updated_at}`);

  console.log("\n[19] s10 — an expired, exhausted foreign job is left alone");
  const stale = makeFixture("s10-stale", 1);
  sql(`update public.protocol_execution_jobs set status='claimed', worker_id='old', `
    + `claim_token=gen_random_uuid(), lease_expires_at=now() - interval '1 hour', attempt_count=1 `
    + `where id='${stale.jobId}';`, false);
  const staleBefore = rowDigest(stale.jobId);
  const alertsBefore = sql("select count(*) from public.protocol_execution_job_alerts;", false);
  const deliveriesBefore = sql("select count(*) from public.protocol_execution_job_alert_deliveries;", false);
  const fx10 = makeFixture("s10", 1);
  check("s10-no-sweep", "the targeted claim still succeeds", claim(fx10.jobId, fx10.projectId) === "CLAIMED|f|f");
  check("s10-no-sweep", "the stale foreign job was not swept, column for column",
    rowDigest(stale.jobId) === staleBefore);
  check("s10-no-sweep", "no alert row was written",
    sql("select count(*) from public.protocol_execution_job_alerts;", false) === alertsBefore);
  check("s10-no-sweep", "no delivery row was written",
    sql("select count(*) from public.protocol_execution_job_alert_deliveries;", false) === deliveriesBefore);

  console.log("\n[20] s11 — after a winner commits, a later caller is JOB_NOT_ELIGIBLE");
  const fx11 = makeFixture("s11", 1);
  check("s11-after-winner", "the winner claims it", claim(fx11.jobId, fx11.projectId) === "CLAIMED|f|f");
  const d11 = tableDigest();
  check("s11-after-winner", "the later caller is refused", claim(fx11.jobId, fx11.projectId) === "JOB_NOT_ELIGIBLE|t|t");
  check("s11-after-winner", "attempt_count is still exactly one", jobRow(fx11.jobId).attempt_count === "1");
  check("s11-after-winner", "and the refusal changed nothing", tableDigest() === d11);

  console.log("\n[21] s12 — two genuinely concurrent callers, exactly one winner");
  const fx12 = makeFixture("s12", 1);
  const bystander = makeFixture("s12-bystander", 1);
  const bystanderBefore = rowDigest(bystander.jobId);
  const raceSql = `set role service_role; select outcome from `
    + `public.${TARGETED_FN}('w-race', 60, '${fx12.jobId}'::uuid, '${fx12.projectId}'::uuid);`;
  const [a, b] = await Promise.all([0, 1].map((i) => new Promise<string>((resolve) => {
    const c = spawn("psql", [DB_URL, "-X", "-q", "-A", "-t", "-c", raceSql], { env: RUN_ENV });
    let o = "";
    c.stdout.on("data", (d: Buffer) => { o += d.toString(); });
    c.stderr.on("data", (d: Buffer) => { o += d.toString(); });
    c.on("close", () => resolve(`${i}:${o.trim()}`));
  })));
  const outcomes = [a, b].map((s) => s.split(":")[1]);
  check("s12-real-race", "exactly one caller won",
    outcomes.filter((o) => o === "CLAIMED").length === 1, outcomes.join(","));
  check("s12-real-race", "the loser was refused, never handed another job",
    outcomes.some((o) => o === "JOB_LOCKED" || o === "JOB_NOT_ELIGIBLE"), outcomes.join(","));
  check("s12-real-race", "attempt_count moved by exactly one", jobRow(fx12.jobId).attempt_count === "1");
  check("s12-real-race", "the bystander job was never touched, column for column",
    rowDigest(bystander.jobId) === bystanderBefore);

  console.log("\n[22] s13 — every failure outcome leaves the whole table byte-identical");
  for (const [label, call] of [
    ["JOB_NOT_FOUND", () => claim("00000000-0000-4000-8000-000000000001", fx12.projectId)],
    ["JOB_NOT_ELIGIBLE", () => claim(fx5.jobId, fx5.projectId)],
  ] as const) {
    const d0 = tableDigest();
    const out = call();
    check("s13-failure-purity", `${label} leaves every column of every row untouched`,
      tableDigest() === d0 && out.endsWith("|t|t"), out);
  }
  const fx13 = makeFixture("s13", 1);
  const holder13 = await holdRowLock(fx13.jobId, "s13");
  const d13 = tableDigest();
  const outLocked = claim(fx13.jobId, fx13.projectId);
  check("s13-failure-purity", "JOB_LOCKED leaves every column of every row untouched",
    tableDigest() === d13 && outLocked === "JOB_LOCKED|t|t", outLocked);
  holder13.send("rollback;");
  await holder13.close();

  console.log("\n[23] s14 — the global claim function still behaves ordinarily");
  const g1 = makeFixture("s14-a", 3);
  const g2 = makeFixture("s14-b", 3);
  const globalOut = sql(`select status, (job).id::text from public.${GLOBAL_FN}('w-global', 60);`);
  check("s14-global-unchanged", "it still claims a job of its own choosing",
    globalOut.startsWith("CLAIMED|"), globalOut);
  const claimedId = globalOut.split("|")[1];
  const claimedRow = jobRow(claimedId);
  check("s14-global-unchanged", "the job it named really moved to claimed, once",
    claimedRow.status === "claimed" && claimedRow.attempt_count === "1" && claimedRow.worker_id === "w-global",
    JSON.stringify(claimedRow));
  check("s14-global-unchanged", "the two fresh multi-attempt fixtures remain in a lawful state",
    [g1, g2].every((g) => ["queued", "claimed"].includes(jobRow(g.jobId).status)));
}

/* ═══════════════════════════════ entry ══════════════════════════════════ */

main().then(() => {
  const missing = ROSTER.filter((s) => !ran.has(s));
  const executed = ROSTER.length - missing.length;
  if (missing.length > 0) {
    console.log(`\n✗ scenarios that never ran: ${missing.join(", ")}`);
    console.log(`\n${passed}/${passed + failed} checks passed, ${executed}/${ROSTER.length} scenarios executed. M5 0059 runtime contract FAILED.`);
    process.exit(1);
  }
  console.log(`\n${passed}/${passed + failed} checks passed, ${executed}/${ROSTER.length} scenarios executed. `
    + `M5 0059 runtime contract ${failed === 0 ? "PASSED" : "FAILED"}.`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.log(`\n✗ ${(e as Error).message}`);
  const executedOnError = ROSTER.filter((s) => ran.has(s)).length;
  console.log(`\n${passed}/${passed + failed} checks passed, ${executedOnError}/${ROSTER.length} scenarios executed. M5 0059 runtime contract FAILED.`);
  process.exit(1);
});
