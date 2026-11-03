#!/usr/bin/env tsx
/**
 * SV1 — Q2′-1 and Q2′-2 security verification on a disposable LOCAL Supabase stack.
 *
 * The Level 2 harness proves Q2′-1 and Q2′-2 on plain PostgreSQL with simulated roles.
 * This file proves the same objects on a real Supabase stack: Supabase's own
 * roles and default privileges, GoTrue Auth tokens, PostgREST behind the API
 * gateway, and the D-041 migration procedures against a migration ledger.
 *
 * Phases
 *   A  PRODUCTION-ORDER REHEARSAL (D-041). A stack started with no migrations;
 *      the ledger created with production's recorded six-column shape;
 *      0001-0080 applied, then 0081's content recorded under production's
 *      alias 20260924023646; then 0083 by the reserved-version procedure;
 *      then Q2′-1 by the named-file procedure; then Q2′-2 by the named-file
 *      procedure (expected_prev: the Q2′-1 version). Then every security check.
 *   B  COMPATIBILITY EXPERIMENT, NOT PRODUCTION-ORDER EVIDENCE. A stack where
 *      the Supabase CLI applies all migration files itself. Used only to
 *      compare the resulting schema and security results with Phase A.
 *
 * Scope and safety
 *   - Opt-in only: does nothing unless ZYPACT_SV1_STACK_TEST=1 (exit 2, SKIP;
 *     a SKIP is never a pass).
 *   - No remote Supabase project and no remote credential. The only endpoints
 *     are the disposable stack on 127.0.0.1; every other fetch throws.
 *   - Keys and tokens of the disposable stack are held in memory only and are
 *     never printed or written. `supabase start` output is discarded.
 *   - The F6 probe (scripts/sql/sv1-probe.sql) and the PostgREST exposure of
 *     its schema exist only inside the disposable stack. The stack starts with
 *     its normal API schema configuration; after the migrations and the probe
 *     exist, the disposable database's `authenticator` role is given
 *     pgrst.db_schemas = public, graphql_public, sv1_probe and PostgREST
 *     reloads its configuration (in-database configuration). If that override
 *     cannot be applied or does not take effect, the run stops. The probe
 *     proves F6's binding to real Auth tokens; it is NOT the customer account
 *     flow.
 *   - Refuses to start if any Supabase container already exists or the API
 *     port answers; never touches a container it did not create.
 *   - The workdir is created under ZYPACT_SV1_TMPDIR (default: the OS temp
 *     directory). With Colima, use a directory under $HOME: the VM shares
 *     only $HOME, and an unshared workdir breaks the database's key mount.
 *   - On success the stack is stopped (--no-backup) and its workdir removed.
 *     On failure it is left up and its workdir is printed.
 *
 * Manifest (SV1-90): every assertion this file records is listed in a fixed
 * manifest, per phase and per key model. A mandatory assertion that is not
 * recorded, an unlisted or duplicated one, or a mandatory assertion recorded
 * as INFO fails the run. SV1-90a proves the manifest check itself rejects
 * each of those mutations before any stack starts.
 *
 * Results: PASS, FAIL, NOT ESTABLISHED (never a pass) or INFO (recorded).
 * Exit: 0 all pass; 1 any FAIL; 3 NOT ESTABLISHED without FAIL; 4 STOP; 2 SKIP.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { orderedMigrations, parseMigrationName } from "./lib/migration-names";

const REPO = process.cwd();
const MIG_DIR = path.join(REPO, "supabase", "migrations");
const API = "http://127.0.0.1:54321";
const OP = "00000000-0000-4000-8000-0000000000f0";
const ALIAS = "20260924023646";
const ALIAS_FILE = "0081_snapshot_request_origin_and_founder_creation.sql";
const Q2P_RE = /^\d{14}_q2p1_[a-z0-9_]+\.sql$/;
const Q2P2_RE = /^\d{14}_q2p2_[a-z0-9_]+\.sql$/;
const PROD_LEDGER_COLUMNS = "version:text,statements:ARRAY,name:text,created_by:text,idempotency_key:text,rollback:ARRAY";
/** Short Auth token lifetime (disposable config only): real ES256 tokens expire within the run. */
const JWT_EXPIRY_SECONDS = 60;

type Outcome = "PASS" | "FAIL" | "NOT_ESTABLISHED" | "INFO";
interface Result { id: string; outcome: Outcome; detail: string }

class Stop extends Error {}
const stop = (why: string): never => { throw new Stop(why); };

// ── network guard: the disposable stack only ──────────────────────────────
const realFetch = globalThis.fetch;
let blockedFetches = 0;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(API + "/")) {
    blockedFetches += 1;
    throw new Error("SV1 network guard: only the disposable local stack may be contacted");
  }
  return realFetch(input, init);
}) as typeof fetch;

// ── processes ─────────────────────────────────────────────────────────────
function run(cmd: string, args: string[], opts: { input?: string; quiet?: boolean } = {}): string {
  return execFileSync(cmd, args, { encoding: "utf8", input: opts.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}
function tryRun(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
/** Never print a key or token, even inside an error message. */
const redact = (s: string) => s.replace(/(eyJ[A-Za-z0-9._-]{10,}|sb_(publishable|secret)_[A-Za-z0-9_-]+)/g, "<redacted>")
  .replace(/super-secret-jwt-token[^\s"]*/g, "<redacted>");

// ── TOML: section-exact single-line edits (the m5-a rule: exactly one line) ──
function setTomlLine(text: string, section: string, key: string, value: string): { text: string; count: number } {
  let current: string | null = null;
  let count = 0;
  const lines = text.split("\n").map((raw) => {
    const t = raw.trim();
    const h = /^\[([^\]]+)\]$/.exec(t);
    if (h) { current = h[1]; return raw; }
    const kv = /^([A-Za-z0-9_.-]+)\s*=/.exec(t);
    if (current === section && kv && kv[1] === key) { count += 1; return `${key} = ${value}`; }
    return raw;
  });
  return { text: lines.join("\n"), count };
}

// ── the stack ─────────────────────────────────────────────────────────────
interface Keys { anon: string; service: string; publishable?: string; secret?: string; jwtSecret?: string }
interface Stack { workdir: string; db: string; keys: Keys; label: string }

function preflight(): void {
  const existing = run("docker", ["ps", "-a", "--format", "{{.Names}}"]).split("\n").filter((n) => n.startsWith("supabase_"));
  if (existing.length > 0) stop(`a Supabase container already exists (${existing.length}); refusing to touch it`);
}

async function apiAnswers(): Promise<boolean> {
  try { await realFetch(`${API}/rest/v1/`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

function startStack(label: string, migrations: string[]): Stack {
  const workdir = mkdtempSync(path.join(process.env.ZYPACT_SV1_TMPDIR || tmpdir(), `sv1-${label}-`));
  run("supabase", ["init", "--workdir", workdir, "--yes"]);
  const cfgPath = path.join(workdir, "supabase", "config.toml");
  let cfg = readFileSync(cfgPath, "utf8");
  const edits: Array<[string, string, string]> = [
    ["db.seed", "enabled", "false"],
    ["auth", "jwt_expiry", String(JWT_EXPIRY_SECONDS)],
  ];
  for (const [section, key, value] of edits) {
    const r = setTomlLine(cfg, section, key, value);
    if (r.count !== 1) stop(`config.toml: expected exactly 1 [${section}].${key} line, found ${r.count}`);
    cfg = r.text;
  }
  writeFileSync(cfgPath, cfg);
  console.log(`  [${label}] disposable config.toml: [db.seed].enabled = false; [auth].jwt_expiry = ${JWT_EXPIRY_SECONDS}; [api].schemas unchanged`);
  const dst = path.join(workdir, "supabase", "migrations");
  mkdirSync(dst, { recursive: true });
  for (const f of migrations) copyFileSync(path.join(MIG_DIR, f), path.join(dst, f));
  console.log(`  [${label}] migrations placed for the CLI: ${migrations.length}`);
  const started = tryRun("supabase", ["start", "--workdir", workdir]);
  if (!started.ok) stop(`[${label}] supabase start failed (workdir ${workdir}): ${redact(started.out).slice(-600)}`);
  const status = JSON.parse(run("supabase", ["status", "-o", "json", "--workdir", workdir]).replace(/^[^{]*/, ""));
  const keys: Keys = {
    anon: status.ANON_KEY, service: status.SERVICE_ROLE_KEY,
    publishable: status.PUBLISHABLE_KEY, secret: status.SECRET_KEY, jwtSecret: status.JWT_SECRET,
  };
  if (!keys.anon || !keys.service) stop(`[${label}] supabase status did not report the anon and service keys`);
  const db = run("docker", ["ps", "--format", "{{.Names}}"]).split("\n").find((n) => n.startsWith("supabase_db_"));
  if (!db) stop(`[${label}] no supabase_db_ container after start`);
  console.log(`  [${label}] stack up: ${db}; key models: legacy JWT keys${keys.publishable && keys.secret ? " + publishable/secret keys" : " only"}`);
  return { workdir, db: db!, keys, label };
}

function stopStack(s: Stack): void {
  run("supabase", ["stop", "--no-backup", "--workdir", s.workdir]);
  rmSync(s.workdir, { recursive: true, force: true });
}

// ── SQL through the disposable database container ─────────────────────────
function q(s: Stack, sql: string): string {
  return run("docker", ["exec", "-i", s.db, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1"],
    { input: sql }).trim();
}
function qTry(s: Stack, sql: string): { ok: boolean; out: string } {
  try { return { ok: true, out: q(s, sql) }; } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
function copyIn(s: Stack, src: string, dst: string): void {
  run("docker", ["exec", s.db, "mkdir", "-p", path.posix.dirname(dst)]);
  run("docker", ["cp", src, `${s.db}:${dst}`]);
}
/** psql -f with variables, single transaction: the D-041 procedures' required invocation. */
function procedure(s: Stack, file: string, vars: Record<string, string>): { ok: boolean; out: string } {
  const args = ["exec", s.db, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  args.push("-f", file);
  return tryRun("docker", args);
}

/**
 * Option A (Founder, 2026-11-03): expose sv1_probe through PostgREST's
 * in-database configuration of the disposable stack, then reload. Stops if
 * the override cannot be set or does not take effect.
 */
async function exposeProbe(c: Ctx): Promise<void> {
  const { s } = c;
  const before = q(s, "select coalesce(array_to_string(setconfig, ' | '), 'none') from pg_db_role_setting where setrole = 'authenticator'::regrole and setdatabase = 0;");
  const set = qTry(s, "alter role authenticator set pgrst.db_schemas = 'public, graphql_public, sv1_probe';");
  if (!set.ok) stop(`${s.label}: the PostgREST in-database schema override cannot be set as postgres: ${redact(set.out).slice(-200)}`);
  q(s, "notify pgrst, 'reload config'; notify pgrst, 'reload schema';");
  let ok = false;
  for (let i = 0; i < 20 && !ok; i += 1) {
    await sleep(1000);
    const r = await http("GET", "/rest/v1/", serviceWho(s, "legacy"), undefined, { "Accept-Profile": "sv1_probe" });
    ok = r.status === 200;
  }
  if (!ok) stop(`${s.label}: the PostgREST in-database schema override did not take effect (sv1_probe still not exposed)`);
  console.log(`  [${s.label}] PostgREST override applied in the disposable database (authenticator settings before: ${before === "none" ? "none" : "present"})`);
  // SV1-24: the override exposes the probe's schema only; the fixture schema stays unreachable.
  const fx = await http("POST", "/rest/v1/rpc/make_review", serviceWho(s, "legacy"), { p_ws: OP, p_project: OP, p_label: "x" }, { "Content-Profile": "sv1_fixture" });
  const fxGet = await http("GET", "/rest/v1/", serviceWho(s, "legacy"), undefined, { "Accept-Profile": "sv1_fixture" });
  rec(c, "SV1-24", refused(fx, ["PGRST106"]) && refused(fxGet, ["PGRST106"]) ? "PASS" : "FAIL", `sv1_fixture not exposed: rpc ${short(fx)}, schema ${short(fxGet)}`);
  // SV1-25 (what sv1_probe exposes to each role) runs in the security suite, once real users exist.
  const pubResp = await http("GET", "/rest/v1/", serviceWho(s, "legacy"));
  const pub = openApiPaths(pubResp);
  const q2pInOpenApi = pub.paths.filter((p2) => c.tables.some((t) => p2 === `/${t}`) || c.fns.some((f) => p2 === `/rpc/${f.name}` && !SERVICE_RPCS.includes(f.name)));
  rec(c, "SV1-26", pub.valid && pub.paths.length > 0 && q2pInOpenApi.length === 0 ? "PASS" : "FAIL",
    `public OpenAPI (service_role view): HTTP ${pubResp.status}, valid paths object ${pub.valid} (${pub.paths.length} paths); Q2′-1 tables or internal functions listed: ${q2pInOpenApi.join(",") || "none"}`);
}

/** OpenAPI paths, valid only for HTTP 200 with a real `paths` object; anything else is invalid. */
function openApiPaths(r: Resp): { valid: boolean; paths: string[] } {
  const raw = (r.body as { paths?: unknown } | null)?.paths;
  const valid = r.status === 200 && raw !== null && typeof raw === "object" && !Array.isArray(raw);
  return { valid, paths: valid ? Object.keys(raw as Record<string, unknown>) : [] };
}

// ── HTTP ──────────────────────────────────────────────────────────────────
type Model = "legacy" | "new";
interface Who { name: string; headers: Record<string, string> }
function anonWho(s: Stack, m: Model): Who {
  return { name: `anon/${m}`, headers: { apikey: m === "legacy" ? s.keys.anon : s.keys.publishable! } };
}
function serviceWho(s: Stack, m: Model): Who {
  return m === "legacy"
    ? { name: "service_role/legacy", headers: { apikey: s.keys.service, Authorization: `Bearer ${s.keys.service}` } }
    : { name: "service_role/new", headers: { apikey: s.keys.secret! } };
}
function userWho(s: Stack, m: Model, label: string, token: string): Who {
  return { name: `${label}/${m}`, headers: { ...anonWho(s, m).headers, Authorization: `Bearer ${token}` } };
}
interface Resp { status: number; code: string | null; body: unknown }
async function http(method: string, url: string, who: Who, body?: unknown, extra: Record<string, string> = {}): Promise<Resp> {
  const r = await fetch(API + url, {
    method,
    headers: { ...who.headers, ...extra, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  const code = parsed && typeof parsed === "object" && "code" in (parsed as object) ? String((parsed as { code: unknown }).code) : null;
  return { status: r.status, code, body: parsed };
}
const refused = (r: Resp, codes: string[]) => (r.status < 200 || r.status >= 300) && r.code !== null && codes.includes(r.code);
const short = (r: Resp) => `${r.status}${r.code ? `/${r.code}` : ""}`;

// ── Auth: real GoTrue users and tokens ────────────────────────────────────
interface User { label: string; email: string; password: string; id: string }
async function createUser(s: Stack, label: string): Promise<User> {
  const email = `sv1-${label.toLowerCase()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const r = await http("POST", "/auth/v1/admin/users", serviceWho(s, "legacy"), { email, password, email_confirm: true });
  const id = (r.body as { id?: string })?.id;
  if (r.status !== 200 || !id) stop(`GoTrue admin user creation failed: ${short(r)}`);
  return { label, email, password, id: id! };
}
async function signIn(s: Stack, u: User): Promise<string> {
  const r = await http("POST", "/auth/v1/token?grant_type=password", anonWho(s, "legacy"), { email: u.email, password: u.password });
  const t = (r.body as { access_token?: string })?.access_token;
  if (r.status !== 200 || !t) stop(`GoTrue password grant failed for ${u.label}: ${short(r)}`);
  return t!;
}
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtHeader = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()) as { alg?: string };
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()) as Record<string, unknown>;
function hs256(claims: Record<string, unknown>, secret: string): string {
  const head = b64u({ alg: "HS256", typ: "JWT" });
  const body = b64u(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the checks ────────────────────────────────────────────────────────────
interface Ctx {
  s: Stack; results: Result[]; models: Model[]; tables: string[]; fns: { name: string; sig: string; args: string[] }[];
  /** Q2′-2's tables and functions. */
  tables2: string[]; fns2: { name: string; sig: string; args: string[] }[];
}
function rec(c: Ctx, id: string, outcome: Outcome, detail: string): void {
  c.results.push({ id, outcome, detail });
  console.log(`  ${outcome.padEnd(15)} ${id} ${detail}`);
}
const SERVICE_RPCS = ["create_workspace_with_owner", "assign_project_to_workspace", "approve_buyer_question_set", "add_workspace_member", "remove_workspace_member"];

function q2pObjects(s: Stack, re: RegExp = Q2P_RE): { tables: string[]; fns: Ctx["fns"] } {
  const file = readdirSync(MIG_DIR).find((f) => re.test(f))!;
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  const tables = [...new Set([...sql.matchAll(/^create table public\.(\w+)/gm)].map((m) => m[1]))];
  const names = [...new Set([...sql.matchAll(/^create (?:or replace )?function public\.(\w+)\(/gm)].map((m) => m[1]))];
  const fns = names.map((name) => {
    const row = q(s, `select p.oid::regprocedure::text || '|' || coalesce(array_to_string(p.proargnames, ','), '')
                        from pg_proc p where p.proname = '${name}' and p.pronamespace = 'public'::regnamespace;`);
    const [sig, args] = row.split("|");
    return { name, sig, args: args ? args.split(",").filter(Boolean) : [] };
  });
  return { tables, fns };
}

function g1Catalog(c: Ctx): void {
  const { s, tables, fns } = c;
  const tl = tables.map((t) => `'public.${t}'`).join(",");
  const leaks = q(s, `select count(*) from unnest(array['anon','authenticated','service_role']) r,
      unnest(array[${tl}]) t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege(r, t, p);`);
  rec(c, "SV1-01", leaks === "0" && tables.length === 15 ? "PASS" : "FAIL", `table privileges held by API roles: ${leaks} (15 tables x 3 roles x 7 privileges); tables found: ${tables.length}`);
  const rls = q(s, `select count(*) filter (where not c.relrowsecurity) || '/' || (select count(*) from pg_policy p where p.polrelid = any(array[${tl}]::regclass[]))
      from pg_class c where c.oid = any(array[${tl}]::regclass[]);`);
  rec(c, "SV1-02", rls === "0/0" ? "PASS" : "FAIL", `tables without RLS / policies: ${rls}`);
  const svc = fns.filter((f) => SERVICE_RPCS.includes(f.name));
  const svcBad = svc.filter((f) => q(s, `select has_function_privilege('service_role','${f.sig}','execute')::text || has_function_privilege('anon','${f.sig}','execute')::text || has_function_privilege('authenticated','${f.sig}','execute')::text;`) !== "truefalsefalse");
  rec(c, "SV1-03", svc.length === 5 && svcBad.length === 0 ? "PASS" : "FAIL", `F1/F2/F4/F7/F8 executable by service_role only; deviations: ${svcBad.map((f) => f.name).join(",") || "none"}`);
  const rest = fns.filter((f) => !SERVICE_RPCS.includes(f.name));
  const restBad = rest.filter((f) => q(s, `select (has_function_privilege('service_role','${f.sig}','execute') or has_function_privilege('anon','${f.sig}','execute') or has_function_privilege('authenticated','${f.sig}','execute'))::text;`) !== "false");
  rec(c, "SV1-04", restBad.length === 0 ? "PASS" : "FAIL", `F6 and ${rest.length - 1} helper/trigger functions executable by no API role; deviations: ${restBad.map((f) => f.name).join(",") || "none"}`);
  const dacl = q(s, `select coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || array_to_string(d.defaclacl, ' '), ' ; ' order by 1), 'none')
      from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace;`);
  const apiDefaults = /(anon|authenticated)=/.test(dacl);
  rec(c, "SV1-05", "INFO", `default privileges in public grant to API roles: ${apiDefaults} (recorded; the explicit revokes keep Q2′-1 closed)`);
  const pub = q(s, `select count(*) from pg_publication_tables where schemaname = 'public' and tablename = any(array[${tables.map((t) => `'${t}'`).join(",")}]);`);
  rec(c, "SV1-06", pub === "0" ? "PASS" : "FAIL", `Q2′-1 tables in any publication: ${pub}`);
  const rpcs = fns.filter((f) => [...SERVICE_RPCS, "assert_current_account_member"].includes(f.name));
  const cfgBad = rpcs.filter((f) => q(s, `select (p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
      and 'search_path=public, pg_temp' = any(p.proconfig) and 'lock_timeout=5s' = any(p.proconfig))::text
      from pg_proc p where p.oid = '${f.sig}'::regprocedure;`) !== "true");
  rec(c, "SV1-07", rpcs.length === 6 && cfgBad.length === 0 ? "PASS" : "FAIL", `six RPCs SECURITY DEFINER, owner postgres, search_path and lock_timeout fixed; deviations: ${cfgBad.map((f) => f.name).join(",") || "none"}`);
}

function tableCounts(c: Ctx, tables: string[] = c.tables): string {
  return tables.map((t) => q(c.s, `select count(*) from public.${t};`)).join(",");
}

async function g2Tables(c: Ctx, userToken: (m: Model) => Promise<string>): Promise<void> {
  for (const m of c.models) {
    await restTableProbes(c, m, userToken, c.tables, ["SV1-10", "SV1-11"], "15 tables");
    await restTableProbes(c, m, userToken, c.tables2, ["SV1-76", "SV1-77"], "8 Q2′-2 tables");
    await graphqlChecks(c, m, userToken);
  }
}

async function restTableProbes(c: Ctx, m: Model, userToken: (m: Model) => Promise<string>, tables: string[], ids: [string, string], what: string): Promise<void> {
  const { s } = c;
  {
    let bad: string[] = [];
    for (const t of tables) for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)]) {
      const r = await http("GET", `/rest/v1/${t}?select=*&limit=1`, who);
      if (!refused(r, ["42501"])) bad.push(`${who.name}:${t}:${short(r)}`);
    }
    rec(c, ids[0], bad.length === 0 && tables.length > 0 ? "PASS" : "FAIL", `[${m}] GET on ${what} x 3 roles refused 42501; deviations: ${bad.slice(0, 5).join(" ") || "none"}`);
    bad = [];
    const before = tableCounts(c, tables);
    for (const t of tables) for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)]) {
      // The first column a client could write: an identity or generated column
      // refuses a non-default value (428C9) before any privilege check.
      const col = q(s, `select column_name from information_schema.columns where table_schema='public' and table_name='${t}'
                          and is_identity = 'NO' and is_generated = 'NEVER' order by ordinal_position limit 1;`);
      const probes = [
        await http("POST", `/rest/v1/${t}`, who, { [col]: null }),
        await http("PATCH", `/rest/v1/${t}?${col}=is.null`, who, { [col]: null }),
        await http("DELETE", `/rest/v1/${t}?${col}=is.null`, who),
      ];
      probes.forEach((r, i) => { if (!refused(r, ["42501"])) bad.push(`${who.name}:${t}:${["POST", "PATCH", "DELETE"][i]}:${short(r)}`); });
    }
    const after = tableCounts(c, tables);
    rec(c, ids[1], bad.length === 0 && tables.length > 0 && before === after ? "PASS" : "FAIL", `[${m}] POST/PATCH/DELETE on ${what} x 3 roles refused 42501; row counts unchanged: ${before === after}; deviations: ${bad.slice(0, 5).join(" ") || "none"}`);
  }
}

/**
 * SV1-12: GraphQL isolation by direct queries, never by introspection.
 *
 * A positive control first proves that pg_graphql reflects and executes for
 * each role, and that the field-naming rule is right: a disposable table
 * public.sv1_graphql_control (primary key, one row, SELECT/INSERT/DELETE
 * granted to the three API roles), created after the A/B schema dumps and
 * dropped afterwards. Only if the control works for a role does an unknown
 * or refused Q2′-1 field count as isolation for that role; otherwise the
 * case is NOT ESTABLISHED. Introspection is recorded (INFO), never relied on.
 */
const GQL_CONTROL = "sv1_graphql_control";
async function graphqlChecks(c: Ctx, m: Model, userToken: (m: Model) => Promise<string>): Promise<void> {
  const { s, tables } = c;
  q(s, `create table if not exists public.${GQL_CONTROL} (id integer primary key, note text);
        insert into public.${GQL_CONTROL} values (1, 'control') on conflict (id) do nothing;
        grant select, insert, delete on public.${GQL_CONTROL} to anon, authenticated, service_role;`);
  const gql = (who: Who, query: string) => http("POST", "/graphql/v1", who, { query });
  const errOf = (r: Resp) => String((r.body as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? "");
  const dataOf = (r: Resp) => (r.body as { data?: Record<string, unknown> | null })?.data ?? null;
  const roles = async (): Promise<Who[]> => [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)];
  try {
    // Introspection: recorded only.
    const intro = await gql(anonWho(s, m), "{ __schema { queryType { name } } }");
    rec(c, "SV1-12i", "INFO", `[${m}] GraphQL introspection: ${intro.status} ${redact(errOf(intro)).slice(0, 80) || "available"} (not relied on)`);

    // Positive control, per role: a direct query and a mutation pair must execute.
    const controlOk: Record<string, boolean> = {};
    const controlDetail: string[] = [];
    let id = 100;
    for (const who of await roles()) {
      id += 1;
      const read = await gql(who, `{ ${GQL_CONTROL}Collection { edges { node { id note } } } }`);
      const rows = ((dataOf(read)?.[`${GQL_CONTROL}Collection`] as { edges?: unknown[] } | undefined)?.edges ?? []).length;
      const ins = await gql(who, `mutation { insertInto${GQL_CONTROL}Collection(objects: [{ id: ${id}, note: "sv1" }]) { affectedCount } }`);
      const insN = (dataOf(ins)?.[`insertInto${GQL_CONTROL}Collection`] as { affectedCount?: number } | undefined)?.affectedCount;
      const del = await gql(who, `mutation { deleteFrom${GQL_CONTROL}Collection(filter: { id: { eq: ${id} } }) { affectedCount } }`);
      const delN = (dataOf(del)?.[`deleteFrom${GQL_CONTROL}Collection`] as { affectedCount?: number } | undefined)?.affectedCount;
      controlOk[who.name] = read.status === 200 && rows >= 1 && insN === 1 && delN === 1;
      controlDetail.push(`${who.name}: read ${rows} row(s), insert ${insN ?? redact(errOf(ins)).slice(0, 40)}, delete ${delN ?? redact(errOf(del)).slice(0, 40)}`);
    }
    const allControl = Object.values(controlOk).every(Boolean);
    rec(c, "SV1-12a", allControl ? "PASS" : "NOT_ESTABLISHED",
      `[${m}] positive control: direct GraphQL query and insert/delete execute for anon, authenticated and service_role: ${controlDetail.join("; ")}`);

    // Direct queries and mutations against every Q2′-1 (SV1-12) and Q2′-2 (SV1-78) table, per role.
    for (const [id, set, what] of [["SV1-12", tables, "15 Q2′-1 tables"], ["SV1-78", c.tables2, "8 Q2′-2 tables"]] as const) {
      const leaks: string[] = [];
      const notEstablished: string[] = [];
      let probes = 0;
      for (const t of set) for (const who of await roles()) {
        if (!controlOk[who.name]) { notEstablished.push(`${who.name}:${t}`); continue; }
        for (const [field, op] of [[`${t}Collection`, `{ ${t}Collection { edges { node { __typename } } } }`],
                                   [`insertInto${t}Collection`, `mutation { insertInto${t}Collection(objects: [{}]) { affectedCount } }`]] as const) {
          probes += 1;
          const r = await gql(who, op);
          const d = dataOf(r);
          const msg = errOf(r);
          const isolated = (d === null || d[field] === undefined || d[field] === null)
            && (msg.includes(`Unknown field "${field}"`) || /permission denied/i.test(msg));
          if (!isolated) leaks.push(`${who.name}:${field}:${r.status}:${redact(msg).slice(0, 60) || "data returned"}`);
        }
      }
      const outcome: Outcome = leaks.length > 0 || set.length === 0 ? "FAIL" : notEstablished.length > 0 ? "NOT_ESTABLISHED" : "PASS";
      rec(c, id, outcome, `[${m}] direct GraphQL query and insert on ${what} x 3 roles refused (${probes} probes, each role's control working): ` +
        `leaks: ${leaks.slice(0, 5).join(" ") || "none"}; not established: ${notEstablished.length ? notEstablished.slice(0, 3).join(" ") : "none"}`);
    }
  } finally {
    q(s, `drop table if exists public.${GQL_CONTROL};`);
  }
}

function rpcArgs(f: Ctx["fns"][number]): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const a of f.args) sample[a] = a.endsWith("_id") ? OP : a === "p_items" ? [] : "x";
  return sample;
}

async function g3Functions(c: Ctx, userToken: (m: Model) => Promise<string>): Promise<void> {
  const { s, fns } = c;
  for (const m of c.models) {
    const bad: string[] = [];
    for (const f of fns.filter((x) => SERVICE_RPCS.includes(x.name))) {
      for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m))]) {
        const r = await http("POST", `/rest/v1/rpc/${f.name}`, who, rpcArgs(f));
        if (!refused(r, ["42501", "PGRST202"])) bad.push(`${who.name}:${f.name}:${short(r)}`);
      }
    }
    rec(c, "SV1-20", bad.length === 0 ? "PASS" : "FAIL", `[${m}] F1/F2/F4/F7/F8 refused for anon and authenticated; deviations: ${bad.join(" ") || "none"}`);
    const f6 = fns.find((x) => x.name === "assert_current_account_member")!;
    const f6Bad: string[] = [];
    for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)]) {
      const r = await http("POST", `/rest/v1/rpc/${f6.name}`, who, rpcArgs(f6));
      if (!refused(r, ["42501", "PGRST202"])) f6Bad.push(`${who.name}:${short(r)}`);
    }
    rec(c, "SV1-22", f6Bad.length === 0 ? "PASS" : "FAIL", `[${m}] F6 not callable by anon, authenticated or service_role; deviations: ${f6Bad.join(" ") || "none"}`);
    const helpers = fns.filter((x) => !SERVICE_RPCS.includes(x.name) && x.name !== f6.name);
    const hBad: string[] = [];
    for (const h of helpers) for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)]) {
      const r = await http("POST", `/rest/v1/rpc/${h.name}`, who, rpcArgs(h));
      if (!refused(r, ["42501", "PGRST202"])) hBad.push(`${who.name}:${h.name}:${short(r)}`);
    }
    rec(c, "SV1-23", hBad.length === 0 ? "PASS" : "FAIL", `[${m}] ${helpers.length} internal helper/trigger functions never callable; deviations: ${hBad.slice(0, 5).join(" ") || "none"}`);
    const q2Bad: string[] = [];
    for (const f of c.fns2) for (const who of [anonWho(s, m), userWho(s, m, "user", await userToken(m)), serviceWho(s, m)]) {
      const r = await http("POST", `/rest/v1/rpc/${f.name}`, who, rpcArgs(f));
      if (!refused(r, ["42501", "PGRST202"])) q2Bad.push(`${who.name}:${f.name}:${short(r)}`);
    }
    rec(c, "SV1-79", q2Bad.length === 0 && c.fns2.length === 11 ? "PASS" : "FAIL", `[${m}] ${c.fns2.length} Q2′-2 functions (the purge included) callable by no API role over RPC; deviations: ${q2Bad.slice(0, 5).join(" ") || "none"}`);
  }
}

async function rpcService(c: Ctx, m: Model, fn: string, args: Record<string, unknown>): Promise<Resp> {
  return http("POST", `/rest/v1/rpc/${fn}`, serviceWho(c.s, m), args);
}

async function g4Probe(c: Ctx, users: Record<string, User>, ws: { A: string; B: string }, model: Model): Promise<void> {
  const { s } = c;
  const probe = (who: Who, w: string) => http("POST", "/rest/v1/rpc/probe_member", who, { p_workspace_id: w }, { "Content-Profile": "sv1_probe" });
  const tok = async (u: User) => signIn(s, u);
  const membersBefore = q(s, "select count(*) from public.workspace_members;");
  let r = await probe(userWho(s, model, "A", await tok(users.A)), ws.A);
  rec(c, "SV1-30", r.status === 200 && r.body === true ? "PASS" : "FAIL", `[${model}] A's real token (alg ${jwtHeader(await tok(users.A)).alg}), WS-A: ${short(r)}`);
  r = await probe(userWho(s, model, "A", await tok(users.A)), ws.B);
  rec(c, "SV1-31", refused(r, ["42501"]) ? "PASS" : "FAIL", `[${model}] A's token, WS-B (cross-workspace): ${short(r)}`);
  r = await probe(userWho(s, model, "C", await tok(users.C)), ws.A);
  rec(c, "SV1-32", refused(r, ["42501"]) ? "PASS" : "FAIL", `[${model}] C (no membership), WS-A: ${short(r)}`);

  // SV1-34: a REAL Auth token past its real expiry (disposable jwt_expiry).
  const stale = await tok(users.B);
  const exp = Number(jwtPayload(stale).exp ?? 0);
  const wait = Math.max(0, exp * 1000 - Date.now()) + 3000;
  if (wait > 90_000) {
    rec(c, "SV1-34", "NOT_ESTABLISHED", `[${model}] the issued token does not expire within the run (exp in ${Math.round(wait / 1000)} s)`);
  } else {
    // Just after exp: recorded, because PostgREST allows a clock-skew margin.
    await sleep(wait);
    const early = await probe(userWho(s, model, "B", stale), ws.B);
    rec(c, "SV1-34i", "INFO", `[${model}] B's real token 3 s after its exp: ${short(early)} (PostgREST clock-skew margin)`);
    // Well past exp (+35 s): must be refused.
    await sleep(32_000);
    r = await probe(userWho(s, model, "B", stale), ws.B);
    rec(c, "SV1-34", r.status === 401 ? "PASS" : "FAIL", `[${model}] B's real token 35 s after its real exp: ${short(r)}`);
  }
  const fresh = await tok(users.B);
  const [h, p] = fresh.split(".");
  const forged = `${h}.${p}.${randomBytes(64).toString("base64url")}`;
  r = await probe(userWho(s, model, "B", forged), ws.B);
  rec(c, "SV1-35", r.status === 401 ? "PASS" : "FAIL", `[${model}] B's claims with a forged signature (unrelated key material): ${short(r)}`);
  const aTok = await tok(users.A);
  const [ah, , as] = aTok.split(".");
  const tampered = `${ah}.${b64u({ ...jwtPayload(aTok), sub: users.B.id })}.${as}`;
  r = await probe(userWho(s, model, "tampered", tampered), ws.B);
  rec(c, "SV1-36", r.status === 401 ? "PASS" : "FAIL", `[${model}] A's real token with sub changed to B, original signature: ${short(r)}`);
  const none = `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ ...jwtPayload(fresh) })}.`;
  r = await probe(userWho(s, model, "alg-none", none), ws.B);
  rec(c, "SV1-37", r.status === 401 ? "PASS" : "FAIL", `[${model}] alg none, B's claims: ${short(r)}`);

  // SV1-38 and SV1-34b need a validly signed non-Auth token: possible only on
  // the legacy HS256 verification path, with the disposable stack's own secret.
  if (!s.keys.jwtSecret) {
    rec(c, "SV1-38", "NOT_ESTABLISHED", `[${model}] no HS256 secret reported by the disposable stack`);
    rec(c, "SV1-34b", "NOT_ESTABLISHED", `[${model}] no HS256 secret reported by the disposable stack`);
  } else {
    const now = Math.floor(Date.now() / 1000);
    const base = { aud: "authenticated", sub: users.B.id, role: "authenticated", iat: now, exp: now + 300 };
    const control = await probe(userWho(s, model, "hs256-control", hs256(base, s.keys.jwtSecret)), ws.B);
    if (!(control.status === 200 && control.body === true)) {
      rec(c, "SV1-38", "NOT_ESTABLISHED", `[${model}] the legacy HS256 path does not accept a valid control token (${short(control)})`);
      rec(c, "SV1-34b", "NOT_ESTABLISHED", `[${model}] the legacy HS256 path does not accept a valid control token`);
    } else {
      const bad: string[] = [];
      for (const role of ["anon", "service_role"]) {
        const t = hs256({ ...base, role }, s.keys.jwtSecret);
        const rr = await probe(userWho(s, model, `role-${role}`, t), ws.B);
        if (!refused(rr, ["42501"])) bad.push(`${role}:${short(rr)}`);
      }
      rec(c, "SV1-38", bad.length === 0 ? "PASS" : "FAIL", `[${model}] legacy HS256 path (minted with the disposable stack's own secret; control token accepted): role anon / service_role with sub B refused 42501; deviations: ${bad.join(" ") || "none"}`);
      const expired = hs256({ ...base, iat: now - 600, exp: now - 300 }, s.keys.jwtSecret);
      const er = await probe(userWho(s, model, "hs256-expired", expired), ws.B);
      rec(c, "SV1-34b", er.status === 401 ? "PASS" : "FAIL", `[${model}] legacy HS256 path: validly signed token expired 300 s ago: ${short(er)}`);
    }
  }
  r = await probe(anonWho(s, model), ws.A);
  rec(c, "SV1-39", refused(r, ["42501"]) ? "PASS" : "FAIL", `[${model}] anon key only, WS-A: ${short(r)}`);
  r = await probe(userWho(s, model, "B", await tok(users.B)), ws.B);
  rec(c, "SV1-40", r.status === 200 && r.body === true ? "PASS" : "FAIL", `[${model}] control: B's real token, WS-B: ${short(r)}`);
  const membersAfter = q(s, "select count(*) from public.workspace_members;");
  rec(c, "SV1-41", membersBefore === membersAfter ? "PASS" : "FAIL", `[${model}] no workspace_members row written by any probe call (${membersBefore} -> ${membersAfter})`);
}

async function g5ApproveSet(c: Ctx, model: Model, ws: { A: string; B: string }, proj: { A: string; B: string }): Promise<void> {
  const { s } = c;
  const review = (w: string, p: string, label: string) =>
    JSON.parse(q(s, `select sv1_fixture.make_review('${w}', '${p}', '${label}');`)) as { rs: string; req: string; ses_token: string; items: unknown[] };
  const approvals = (rs: string) => q(s, `select count(*) from public.approval_records where research_set_id = '${rs}';`);
  const paidBefore = q(s, "select (select count(*) from public.protocols) || '/' || (select count(*) from public.protocol_execution_jobs) || '/' || (select count(*) from public.protocol_external_calls);");
  const args = (tok: string, rs: string, items: unknown, key: string) => ({
    p_session_token: tok, p_research_set_id: rs, p_items: items, p_idempotency_key: key,
    p_consent_text_version: "consent-v1", p_consent_text_sha256: "c".repeat(64),
  });
  const a = review(ws.A, proj.A, `a-${model}`);
  const b = review(ws.B, proj.B, `b-${model}`);
  let r = await rpcService(c, model, "approve_buyer_question_set", args(a.ses_token, a.rs, a.items, `sv1-${model}-a`));
  const st = Array.isArray(r.body) ? (r.body[0] as { status?: string })?.status : undefined;
  rec(c, "SV1-50", r.status === 200 && st === "APPROVED" && approvals(a.rs) === "1" ? "PASS" : "FAIL", `[${model}] F4 over PostgREST, WS-A session and set: ${short(r)} ${st ?? ""}; approval records ${approvals(a.rs)}`);
  r = await rpcService(c, model, "approve_buyer_question_set", args(a.ses_token, b.rs, b.items, `sv1-${model}-x`));
  rec(c, "SV1-51", refused(r, ["42501"]) && approvals(b.rs) === "0" ? "PASS" : "FAIL", `[${model}] WS-A session, WS-B set: ${short(r)}; WS-B approval records ${approvals(b.rs)}`);
  const d = review(ws.A, proj.A, `d-${model}`);
  q(s, `update public.snapshot_requests set normalized_email = 'changed@example.com', work_email = 'changed@example.com' where id = '${d.req}';`);
  r = await rpcService(c, model, "approve_buyer_question_set", args(d.ses_token, d.rs, d.items, `sv1-${model}-d`));
  rec(c, "SV1-52", refused(r, ["42501"]) && approvals(d.rs) === "0" ? "PASS" : "FAIL", `[${model}] persisted request address changed after issue: ${short(r)}; approval records ${approvals(d.rs)}`);
  r = await rpcService(c, model, "approve_buyer_question_set", args(a.ses_token, a.rs, a.items, `sv1-${model}-a`));
  const st2 = Array.isArray(r.body) ? (r.body[0] as { status?: string })?.status : undefined;
  rec(c, "SV1-53", r.status === 200 && st2 === "ALREADY_APPROVED" && approvals(a.rs) === "1" ? "PASS" : "FAIL", `[${model}] replay, same key and set: ${short(r)} ${st2 ?? ""}; approval records ${approvals(a.rs)}`);
  r = await rpcService(c, model, "approve_buyer_question_set", { ...args(a.ses_token, a.rs, a.items, `sv1-${model}-old`), p_current_email_hmac: "a".repeat(64), p_current_email_hmac_key_id: "k1" });
  rec(c, "SV1-54", refused(r, ["PGRST202"]) ? "PASS" : "FAIL", `[${model}] the old 8-argument call: ${short(r)}`);
  const paidAfter = q(s, "select (select count(*) from public.protocols) || '/' || (select count(*) from public.protocol_execution_jobs) || '/' || (select count(*) from public.protocol_external_calls);");
  const statuses = q(s, `select string_agg(distinct status, ',') from public.snapshot_requests where id in ('${a.req}','${b.req}','${d.req}');`);
  rec(c, "SV1-55", paidBefore === paidAfter && statuses === "pending_approval" ? "PASS" : "FAIL", `[${model}] protocols/jobs/external calls ${paidBefore} -> ${paidAfter}; request status ${statuses}`);
}

/** Q2′-2 catalog: closed tables, sequence and functions; one SECURITY DEFINER function (the purge). */
function g6Catalog(c: Ctx): void {
  const { s, tables2: tables, fns2: fns } = c;
  const tl = tables.map((t) => `'public.${t}'`).join(",");
  const leaks = q(s, `select count(*) from unnest(array['anon','authenticated','service_role']) r,
      unnest(array[${tl}]) t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege(r, t, p);`);
  rec(c, "SV1-70", leaks === "0" && tables.length === 8 ? "PASS" : "FAIL", `Q2′-2 table privileges held by API roles: ${leaks} (8 tables x 3 roles x 7 privileges); tables found: ${tables.length}`);
  const rls = q(s, `select count(*) filter (where not c.relrowsecurity) || '/' || (select count(*) from pg_policy p where p.polrelid = any(array[${tl}]::regclass[]))
      from pg_class c where c.oid = any(array[${tl}]::regclass[]);`);
  rec(c, "SV1-71", rls === "0/0" ? "PASS" : "FAIL", `Q2′-2 tables without RLS / policies: ${rls}`);
  const fBad = fns.filter((f) => q(s, `select (has_function_privilege('service_role','${f.sig}','execute') or has_function_privilege('anon','${f.sig}','execute') or has_function_privilege('authenticated','${f.sig}','execute'))::text;`) !== "false");
  rec(c, "SV1-72", fns.length === 11 && fBad.length === 0 ? "PASS" : "FAIL", `${fns.length} Q2′-2 functions executable by no API role; deviations: ${fBad.map((f) => f.name).join(",") || "none"}`);
  const seq = q(s, `select count(*) from unnest(array['anon','authenticated','service_role']) r, unnest(array['USAGE','SELECT','UPDATE']) p
      where has_sequence_privilege(r, 'public.diagnostic_rate_limit_events_id_seq', p);`);
  rec(c, "SV1-73", seq === "0" ? "PASS" : "FAIL", `rate-limit identity sequence privileges held by API roles: ${seq}`);
  const pub = q(s, `select count(*) from pg_publication_tables where schemaname = 'public' and tablename = any(array[${tables.map((t) => `'${t}'`).join(",")}]);`);
  rec(c, "SV1-74", pub === "0" ? "PASS" : "FAIL", `Q2′-2 tables in any publication: ${pub}`);
  const cfg = fns.map((f) => q(s, `select p.proname || ':' || p.prosecdef::text || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(array_to_string(p.proconfig, ';'), '')
      from pg_proc p where p.oid = '${f.sig}'::regprocedure;`));
  const definers = cfg.filter((x) => x.split(":")[1] === "true");
  const cfgBad = cfg.filter((x) => {
    const [name, secdef, owner, conf] = x.split(":");
    return name === "_q2p2_purge_rate_limit_events"
      ? !(secdef === "true" && owner === "postgres" && conf === "search_path=public, pg_temp")
      : !(secdef === "false" && conf === "search_path=pg_catalog, pg_temp");
  });
  rec(c, "SV1-75", definers.length === 1 && cfgBad.length === 0 ? "PASS" : "FAIL",
    `only the purge is SECURITY DEFINER (owner postgres); every Q2′-2 function has a fixed search_path; definers ${definers.length}; deviations: ${cfgBad.map((x) => x.split(":")[0]).join(",") || "none"}`);
}

/** SV1-80: no Q2′-2 table or function appears in the public OpenAPI of any API role. */
async function q2p2OpenApi(c: Ctx, userTok: string): Promise<void> {
  const { s } = c;
  const views: string[] = [];
  const listed: string[] = [];
  let allValid = true;
  for (const who of [anonWho(s, "legacy"), userWho(s, "legacy", "C", userTok), serviceWho(s, "legacy")]) {
    const r = await http("GET", "/rest/v1/", who);
    const o = openApiPaths(r);
    allValid &&= o.valid && o.paths.length > 0;
    views.push(`${who.name} ${r.status}/${o.paths.length}`);
    listed.push(...o.paths.filter((p2) => c.tables2.some((t) => p2 === `/${t}`) || c.fns2.some((f) => p2 === `/rpc/${f.name}`)).map((p2) => `${who.name}:${p2}`));
  }
  rec(c, "SV1-80", allValid && listed.length === 0 ? "PASS" : "FAIL",
    `public OpenAPI (${views.join(", ")}; each HTTP 200 with a valid, non-empty paths object: ${allValid}): Q2′-2 tables or functions listed: ${listed.join(",") || "none"}`);
}

/**
 * SV1-81: the rate-limit cleanup on the real stack. Two rows, one expiring in
 * 1 s and one in 47 h; after 2 s the purge (as the database owner, the only
 * caller allowed) removes exactly the expired row, and the unexpired row
 * cannot be deleted directly.
 */
async function q2p2Purge(c: Ctx): Promise<void> {
  const { s } = c;
  const key = (n: number) => createHash("sha256").update(`sv1-${s.label}-${n}`).digest("hex");
  q(s, `insert into public.diagnostic_rate_limit_events (bucket_kind, bucket_key, key_purpose, key_id, expires_at) values
          ('account', '${key(1)}', 'zypact.diag.rate_limit.v1', 'k-sv1', clock_timestamp() + interval '1 second'),
          ('ip', '${key(2)}', 'zypact.diag.rate_limit.v1', 'k-sv1', clock_timestamp() + interval '47 hours');`);
  await sleep(2000);
  const purged = q(s, "select public._q2p2_purge_rate_limit_events();");
  const left = q(s, `select string_agg(bucket_kind, ',' order by bucket_kind) from public.diagnostic_rate_limit_events where bucket_key in ('${key(1)}', '${key(2)}');`);
  const del = qTry(s, `delete from public.diagnostic_rate_limit_events where bucket_key = '${key(2)}';`);
  rec(c, "SV1-81", purged === "1" && left === "ip" && !del.ok && /q2p2_rate_limit_event_not_expired/.test(del.out) ? "PASS" : "FAIL",
    `purge removed ${purged} expired row(s); remaining ${left || "none"}; direct delete of the unexpired row refused: ${!del.ok}`);
}

async function securitySuite(c: Ctx): Promise<void> {
  const { s } = c;
  console.log(`\n  ── ${s.label}: G1 catalog`);
  g1Catalog(c);
  console.log(`\n  ── ${s.label}: G6 Q2′-2 catalog`);
  g6Catalog(c);
  const users = { A: await createUser(s, "A"), B: await createUser(s, "B"), C: await createUser(s, "C"), D: await createUser(s, "D") };
  const userToken = async () => signIn(s, users.C);
  // SV1-25: PostgREST's OpenAPI lists what the caller may use; sv1_probe must offer
  // exactly the wrapper to an authenticated user and nothing to anon or service_role.
  // Each listing counts only if it is HTTP 200 with a real paths object.
  const probePaths = async (who: Who) => {
    const r = await http("GET", "/rest/v1/", who, undefined, { "Accept-Profile": "sv1_probe" });
    const o = openApiPaths(r);
    return { status: r.status, valid: o.valid, paths: o.paths.filter((p2) => p2 !== "/") };
  };
  const authP = await probePaths(userWho(s, "legacy", "C", await signIn(s, users.C)));
  const anonP = await probePaths(anonWho(s, "legacy"));
  const svcP = await probePaths(serviceWho(s, "legacy"));
  const allValid = authP.valid && anonP.valid && svcP.valid;
  rec(c, "SV1-25", allValid && authP.paths.join(",") === "/rpc/probe_member" && anonP.paths.length === 0 && svcP.paths.length === 0 ? "PASS" : "FAIL",
    `sv1_probe OpenAPI (HTTP ${authP.status}/${anonP.status}/${svcP.status}, valid ${allValid}): authenticated sees ${authP.paths.join(",") || "nothing"}; anon ${anonP.paths.join(",") || "nothing"}; service_role ${svcP.paths.join(",") || "nothing"}`);
  await q2p2OpenApi(c, await signIn(s, users.C));
  console.log(`\n  ── ${s.label}: G2 tables over the API`);
  await g2Tables(c, userToken);
  console.log(`\n  ── ${s.label}: G3 functions over the API`);
  await g3Functions(c, userToken);

  console.log(`\n  ── ${s.label}: G4 F6 through the isolated probe`);
  const projA = q(s, "insert into public.projects (domain, company_name) values ('sv1-a.example.com', 'SV1 A') returning id;");
  const projB = q(s, "insert into public.projects (domain, company_name) values ('sv1-b.example.com', 'SV1 B') returning id;");
  const f1 = async (u: User, key: string) => {
    const r = await rpcService(c, "legacy", "create_workspace_with_owner", { p_account_id: u.id, p_name: `SV1 ${u.label}`, p_idempotency_key: key, p_actor_type: "founder", p_actor_operator_id: OP });
    return { r, row: Array.isArray(r.body) ? (r.body[0] as { status?: string; workspace_id?: string; membership_id?: string }) : undefined };
  };
  const wa = await f1(users.A, `sv1-${s.label}-wsa`);
  const wb = await f1(users.B, `sv1-${s.label}-wsb`);
  const m2 = await rpcService(c, "legacy", "assign_project_to_workspace", { p_project_id: projA, p_workspace_id: wa.row?.workspace_id, p_actor_type: "founder", p_actor_operator_id: OP });
  const m3 = await rpcService(c, "legacy", "assign_project_to_workspace", { p_project_id: projB, p_workspace_id: wb.row?.workspace_id, p_actor_type: "founder", p_actor_operator_id: OP });
  const f7 = await rpcService(c, "legacy", "add_workspace_member", { p_workspace_id: wa.row?.workspace_id, p_account_id: users.D.id, p_actor_type: "founder", p_actor_operator_id: OP });
  const okF = [wa.r, wb.r, m2, m3, f7].every((r) => r.status === 200) && !!wa.row?.workspace_id && !!wb.row?.workspace_id;
  rec(c, "SV1-21a", okF ? "PASS" : "FAIL", `service_role (legacy key): F1 x2, F2 x2, F7 succeed: ${[wa.r, wb.r, m2, m3, f7].map(short).join(" ")}`);
  if (!okF) stop(`${s.label}: setup through F1/F2/F7 failed; the remaining G4/G5 cases cannot run honestly`);
  const ws = { A: wa.row!.workspace_id!, B: wb.row!.workspace_id! };

  for (const m of c.models) await g4Probe(c, users, ws, m);
  if (c.models.includes("new")) {
    const n = await rpcService(c, "new", "create_workspace_with_owner", { p_account_id: users.C.id, p_name: "SV1 C", p_idempotency_key: `sv1-${s.label}-wsc`, p_actor_type: "founder", p_actor_operator_id: OP });
    rec(c, "SV1-21b", n.status === 200 ? "PASS" : "FAIL", `service_role (secret key): F1 succeeds: ${short(n)}`);
  }
  // Removed member: D keeps WS-A owned; F8 removes A.
  const f8 = await rpcService(c, "legacy", "remove_workspace_member", { p_workspace_id: ws.A, p_membership_id: wa.row!.membership_id, p_actor_type: "founder", p_actor_operator_id: OP });
  const removedAt = q(s, `select (removed_at is not null)::text from public.workspace_members where id = '${wa.row!.membership_id}';`);
  for (const m of c.models) {
    const r = await http("POST", "/rest/v1/rpc/probe_member", userWho(s, m, "A", await signIn(s, users.A)), { p_workspace_id: ws.A }, { "Content-Profile": "sv1_probe" });
    const dOk = await http("POST", "/rest/v1/rpc/probe_member", userWho(s, m, "D", await signIn(s, users.D)), { p_workspace_id: ws.A }, { "Content-Profile": "sv1_probe" });
    rec(c, "SV1-33", f8.status === 200 && removedAt === "true" && refused(r, ["42501"]) && dOk.status === 200 && dOk.body === true ? "PASS" : "FAIL",
      `[${m}] after F8 removed A (removed_at set: ${removedAt}): A ${short(r)}; remaining member D ${short(dOk)}`);
  }
  const f6Exec = q(s, "select (has_function_privilege('anon','public.assert_current_account_member(uuid)','execute') or has_function_privilege('authenticated','public.assert_current_account_member(uuid)','execute') or has_function_privilege('service_role','public.assert_current_account_member(uuid)','execute'))::text;");
  rec(c, "SV1-41b", f6Exec === "false" ? "PASS" : "FAIL", `F6 still executable by no API role after G4: ${f6Exec === "false"}`);

  console.log(`\n  ── ${s.label}: G5 F4 and tenant isolation over the API`);
  for (const m of c.models) await g5ApproveSet(c, m, ws, { A: projA, B: projB });
  console.log(`\n  ── ${s.label}: G7 Q2′-2 rate-limit cleanup`);
  await q2p2Purge(c);
}

// ── Phase A: the production-order rehearsal (D-041) ───────────────────────
function historicalOrder(): { files: string[]; q2p: string; q2p2: string; f0083: string } {
  const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
  const ordered = orderedMigrations(all).map((x) => x.f);
  const q2p = ordered.filter((f) => Q2P_RE.test(f));
  const q2p2 = ordered.filter((f) => Q2P2_RE.test(f));
  const f0083 = ordered.find((f) => f.startsWith("0083_"));
  const files = ordered.filter((f) => /^00([0-7]\d|80)_/.test(f));
  if (q2p.length !== 1 || q2p2.length !== 1 || !f0083 || files.length !== 80 || !ordered.includes(ALIAS_FILE) || ordered.length !== 84
      || ordered.indexOf(q2p2[0]) !== ordered.length - 1 || ordered.indexOf(q2p[0]) !== ordered.length - 2) {
    stop(`repository migrations are not the expected set (0001-0081, 0083, one Q2′-1 file, then one Q2′-2 file; found ${ordered.length})`);
  }
  for (const f of ordered) if (!parseMigrationName(f).ok) stop(`invalid migration name ${f}`);
  return { files, q2p: q2p[0], q2p2: q2p2[0], f0083: f0083! };
}

async function phaseA(results: Result[]): Promise<{ dump: string; assertions: string[] }> {
  console.log("\n══ Phase A — PRODUCTION-ORDER REHEARSAL (D-041): 0001-0080, 0081 as 20260924023646, 0083 (reserved), Q2′-1 (named file), Q2′-2 (named file)");
  const { files, q2p, q2p2, f0083 } = historicalOrder();
  const s = startStack("A", []);
  const c: Ctx = { s, results: [], models: s.keys.publishable && s.keys.secret ? ["legacy", "new"] : ["legacy"], tables: [], fns: [], tables2: [], fns2: [] };
  try {
    run("docker", ["exec", s.db, "mkdir", "-p", "/tmp/sv1sql"]);
    run("docker", ["cp", MIG_DIR, `${s.db}:/tmp/sv1mig`]);
    copyIn(s, path.join(REPO, "scripts/sql/sv1-apply-named-migration.sql"), "/tmp/sv1sql/named.sql");
    copyIn(s, path.join(REPO, "scripts/sql/sv1-apply-reserved-migration.sql"), "/tmp/sv1sql/reserved.sql");
    copyIn(s, path.join(REPO, "scripts/sql/sv1-probe.sql"), "/tmp/sv1sql/probe.sql");

    const ledger = q(s, "select coalesce(to_regclass('supabase_migrations.schema_migrations')::text, 'absent');");
    if (ledger !== "absent") stop("Phase A: the stack already has a migration ledger; the production ledger cannot be reproduced exactly");
    q(s, `create schema if not exists supabase_migrations;
          create table supabase_migrations.schema_migrations (
            version text not null primary key, statements text[], name text,
            created_by text, idempotency_key text, rollback text[]);`);
    const cols = q(s, `select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns
                        where table_schema = 'supabase_migrations' and table_name = 'schema_migrations';`);
    rec(c, "SV1-60a", cols === PROD_LEDGER_COLUMNS ? "PASS" : "FAIL", `ledger created with production's recorded six-column shape: ${cols}`);

    for (const f of [...files, ALIAS_FILE]) {
      const r = tryRun("docker", ["exec", s.db, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", `/tmp/sv1mig/${f}`]);
      if (!r.ok) stop(`Phase A: historical migration ${f} failed: ${redact(r.out).slice(-400)}`);
      const version = f === ALIAS_FILE ? ALIAS : f.slice(0, 4);
      const text = readFileSync(path.join(MIG_DIR, f), "utf8");
      if (text.includes("$sv1ledger$")) stop(`Phase A: ${f} contains the ledger quoting tag`);
      q(s, `insert into supabase_migrations.schema_migrations (version, name, statements)
            values ('${version}', '${f.slice(5, -4)}', array[$sv1ledger$${text}$sv1ledger$]);`);
    }
    const expected = [...files.map((f) => f.slice(0, 4)), ALIAS].sort().join(",");
    const got = q(s, "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;");
    rec(c, "SV1-60", got === expected ? "PASS" : "FAIL", `ledger after 0001-0080 and the 0081 alias equals production's recorded 81 versions (tail ${ALIAS}): ${got === expected}`);

    const sysid = qTry(s, "select system_identifier::text from pg_control_system();");
    rec(c, "SV1-64", sysid.ok ? "INFO" : "INFO", `pg_control_system() callable as postgres (not a superuser here): ${sysid.ok}`);
    if (!sysid.ok) stop("Phase A: pg_control_system() is not callable as postgres; the reserved procedure cannot run as written");

    const r83 = procedure(s, "/tmp/sv1sql/reserved.sql", {
      target_sysid: sysid.out, file: `/tmp/sv1mig/${f0083}`, version: "0083",
      name: f0083.slice(5, -4), expected_tail: ALIAS,
    });
    const has83 = q(s, "select count(*) from supabase_migrations.schema_migrations where version = '0083';");
    const tail83 = q(s, "select max(version) from supabase_migrations.schema_migrations;");
    rec(c, "SV1-63", r83.ok && has83 === "1" && tail83 === ALIAS ? "PASS" : "FAIL", `0083 by the reserved-version procedure (expected_tail ${ALIAS}): exit ${r83.ok ? 0 : 1}; recorded ${has83}; tail still ${tail83}${r83.ok ? "" : `; ${redact(r83.out).slice(-300)}`}`);
    const r83b = procedure(s, "/tmp/sv1sql/reserved.sql", {
      target_sysid: sysid.out, file: `/tmp/sv1mig/${f0083}`, version: "0083", name: f0083.slice(5, -4), expected_tail: ALIAS,
    });
    rec(c, "SV1-63b", !r83b.ok && /version already recorded/.test(r83b.out) ? "PASS" : "FAIL", `a second 0083 apply is refused by the procedure: ${!r83b.ok}`);

    const qVersion = q2p.slice(0, 14);
    const qName = q2p.slice(15, -4);
    const rq = procedure(s, "/tmp/sv1sql/named.sql", { file: `/tmp/sv1mig/${q2p}`, new_version: qVersion, new_name: qName, expected_prev: ALIAS });
    const tail = q(s, "select max(version) from supabase_migrations.schema_migrations;");
    const bytes = q(s, `select encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') from supabase_migrations.schema_migrations where version = '${qVersion}';`);
    const fileSha = createHash("sha256").update(readFileSync(path.join(MIG_DIR, q2p), "utf8").replace(/\n$/, "") + "\n").digest("hex");
    const total = q(s, "select count(*) from supabase_migrations.schema_migrations;");
    rec(c, "SV1-61", rq.ok && tail === qVersion && bytes === fileSha && total === "83" ? "PASS" : "FAIL",
      `Q2′-1 by the named-file procedure after 0083 (expected_prev ${ALIAS}): exit ${rq.ok ? 0 : 1}; tail ${tail}; ledger statements equal the file bytes: ${bytes === fileSha}; ledger rows ${total}${rq.ok ? "" : `; ${redact(rq.out).slice(-300)}`}`);
    const rq2 = procedure(s, "/tmp/sv1sql/named.sql", { file: `/tmp/sv1mig/${q2p}`, new_version: qVersion, new_name: qName, expected_prev: ALIAS });
    rec(c, "SV1-62", !rq2.ok && /not the expected predecessor/.test(rq2.out) ? "PASS" : "FAIL", `a second Q2′-1 apply is refused by the procedure (not the expected predecessor): ${!rq2.ok}`);

    // Q2′-2 by the named-file procedure, after Q2′-1 (D-041 order).
    const q2Version = q2p2.slice(0, 14);
    const q2Name = q2p2.slice(15, -4);
    const rp = procedure(s, "/tmp/sv1sql/named.sql", { file: `/tmp/sv1mig/${q2p2}`, new_version: q2Version, new_name: q2Name, expected_prev: qVersion });
    const tail2 = q(s, "select max(version) from supabase_migrations.schema_migrations;");
    const bytes2 = q(s, `select encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') from supabase_migrations.schema_migrations where version = '${q2Version}';`);
    const fileSha2 = createHash("sha256").update(readFileSync(path.join(MIG_DIR, q2p2), "utf8").replace(/\n$/, "") + "\n").digest("hex");
    const total2 = q(s, "select count(*) from supabase_migrations.schema_migrations;");
    rec(c, "SV1-68", rp.ok && tail2 === q2Version && bytes2 === fileSha2 && total2 === "84" ? "PASS" : "FAIL",
      `Q2′-2 by the named-file procedure after Q2′-1 (expected_prev ${qVersion}): exit ${rp.ok ? 0 : 1}; tail ${tail2}; ledger statements equal the file bytes: ${bytes2 === fileSha2}; ledger rows ${total2}${rp.ok ? "" : `; ${redact(rp.out).slice(-300)}`}`);
    const rp2 = procedure(s, "/tmp/sv1sql/named.sql", { file: `/tmp/sv1mig/${q2p2}`, new_version: q2Version, new_name: q2Name, expected_prev: qVersion });
    rec(c, "SV1-69", !rp2.ok && /not the expected predecessor/.test(rp2.out) ? "PASS" : "FAIL", `a second Q2′-2 apply is refused by the procedure (not the expected predecessor): ${!rp2.ok}`);

    const dump = run("docker", ["exec", s.db, "pg_dump", "-U", "postgres", "-d", "postgres", "--schema-only", "-n", "public"]);
    const objs = q2pObjects(s);
    c.tables = objs.tables;
    c.fns = objs.fns;
    const objs2 = q2pObjects(s, Q2P2_RE);
    c.tables2 = objs2.tables;
    c.fns2 = objs2.fns;
    q(s, "create extension if not exists pg_graphql;");
    const probe = tryRun("docker", ["exec", s.db, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/sv1sql/probe.sql"]);
    if (!probe.ok) stop(`Phase A: sv1-probe.sql failed: ${redact(probe.out).slice(-300)}`);
    await exposeProbe(c);
    await securitySuite(c);
    results.push(...c.results.map((r) => ({ ...r, id: `A:${r.id}` })));
    stopStack(s);
    return { dump, assertions: assertionList(c.results) };
  } catch (e) {
    results.push(...c.results.map((r) => ({ ...r, id: `A:${r.id}` })));
    console.error(`  Phase A stack left up for inspection; workdir ${s.workdir}`);
    throw e;
  }
}

// ── Phase B: compatibility experiment (NOT production-order evidence) ─────
async function phaseB(results: Result[]): Promise<{ dump: string; assertions: string[] }> {
  console.log("\n══ Phase B — COMPATIBILITY EXPERIMENT (not production-order evidence): the Supabase CLI applies all migration files itself");
  const all = orderedMigrations(readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"))).map((x) => x.f);
  const s = startStack("B", all);
  const c: Ctx = { s, results: [], models: s.keys.publishable && s.keys.secret ? ["legacy", "new"] : ["legacy"], tables: [], fns: [], tables2: [], fns2: [] };
  try {
    const versions = q(s, "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;");
    const expectedB = all.map((f) => (Q2P_RE.test(f) || Q2P2_RE.test(f) ? f.slice(0, 14) : f.slice(0, 4))).sort().join(",");
    rec(c, "SV1-65", versions === expectedB ? "INFO" : "FAIL", `CLI ledger holds 0001-0081 (not the 20260924023646 alias), 0083 and the Q2′-1 and Q2′-2 versions: ${versions === expectedB}`);
    const dump = run("docker", ["exec", s.db, "pg_dump", "-U", "postgres", "-d", "postgres", "--schema-only", "-n", "public"]);
    const objs = q2pObjects(s);
    c.tables = objs.tables;
    c.fns = objs.fns;
    const objs2 = q2pObjects(s, Q2P2_RE);
    c.tables2 = objs2.tables;
    c.fns2 = objs2.fns;
    q(s, "create extension if not exists pg_graphql;");
    run("docker", ["exec", s.db, "mkdir", "-p", "/tmp/sv1sql"]);
    copyIn(s, path.join(REPO, "scripts/sql/sv1-probe.sql"), "/tmp/sv1sql/probe.sql");
    const probe = tryRun("docker", ["exec", s.db, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/sv1sql/probe.sql"]);
    if (!probe.ok) stop(`Phase B: sv1-probe.sql failed: ${redact(probe.out).slice(-300)}`);
    await exposeProbe(c);
    await securitySuite(c);
    results.push(...c.results.map((r) => ({ ...r, id: `B:${r.id}` })));
    stopStack(s);
    return { dump, assertions: assertionList(c.results) };
  } catch (e) {
    results.push(...c.results.map((r) => ({ ...r, id: `B:${r.id}` })));
    console.error(`  Phase B stack left up for inspection; workdir ${s.workdir}`);
    throw e;
  }
}

/** Checks that exist in only one phase by design (the ledger rehearsal, and the CLI ledger). */
const PHASE_SPECIFIC = new Set(["SV1-60", "SV1-60a", "SV1-61", "SV1-62", "SV1-63", "SV1-63b", "SV1-64", "SV1-65", "SV1-68", "SV1-69"]);
/** Every security assertion of a phase as "id[model]|outcome", in recorded order. */
function assertionList(rs: Result[]): string[] {
  return rs.filter((r) => !PHASE_SPECIFIC.has(r.id)).map((r) =>
    `${r.id}${r.detail.startsWith("[new]") ? "[new]" : r.detail.startsWith("[legacy]") ? "[legacy]" : ""}|${r.outcome}`);
}
/** SV1-67: the complete A and B assertion sets must match exactly, both ways; no duplicate key in either. */
function compareAssertions(a: string[], b: string[]): { ok: boolean; detail: string } {
  const keyOf = (x: string) => x.split("|")[0];
  const counts = (xs: string[]) => xs.reduce((m, x) => m.set(keyOf(x), (m.get(keyOf(x)) ?? 0) + 1), new Map<string, number>());
  const ca = counts(a), cb = counts(b);
  const dupA = [...ca].filter(([, n]) => n > 1).map(([k]) => k);
  const dupB = [...cb].filter(([, n]) => n > 1).map(([k]) => k);
  const outA = new Map(a.map((x) => [keyOf(x), x.split("|")[1]]));
  const outB = new Map(b.map((x) => [keyOf(x), x.split("|")[1]]));
  const missing = [...outA.keys()].filter((k) => !outB.has(k));
  const extra = [...outB.keys()].filter((k) => !outA.has(k));
  const differ = [...outA.keys()].filter((k) => outB.has(k) && outB.get(k) !== outA.get(k)).map((k) => `${k}:${outA.get(k)}->${outB.get(k)}`);
  const ok = a.length > 0 && a.length === b.length && !dupA.length && !dupB.length && !missing.length && !extra.length && !differ.length;
  return { ok, detail: `A ${a.length} / B ${b.length} assertions; missing in B: ${missing.join(",") || "none"}; extra in B: ${extra.join(",") || "none"}; duplicates A: ${dupA.join(",") || "none"}, B: ${dupB.join(",") || "none"}; outcome differences: ${differ.join(" ") || "none"}` };
}

// ── SV1-90: the fail-closed assertion manifest ────────────────────────────
/** Recorded once per phase. */
const MANIFEST_ONCE = [
  "SV1-24", "SV1-26", "SV1-01", "SV1-02", "SV1-03", "SV1-04", "SV1-05", "SV1-06", "SV1-07",
  "SV1-70", "SV1-71", "SV1-72", "SV1-73", "SV1-74", "SV1-75", "SV1-25", "SV1-80",
  "SV1-21a", "SV1-21b", "SV1-41b", "SV1-81",
];
/** Recorded once per phase and key model (legacy and new). */
const MANIFEST_PER_MODEL = [
  "SV1-10", "SV1-11", "SV1-76", "SV1-77", "SV1-12i", "SV1-12a", "SV1-12", "SV1-78",
  "SV1-20", "SV1-22", "SV1-23", "SV1-79",
  "SV1-30", "SV1-31", "SV1-32", "SV1-34i", "SV1-34", "SV1-35", "SV1-36", "SV1-37", "SV1-38", "SV1-34b", "SV1-39", "SV1-40", "SV1-41",
  "SV1-33", "SV1-50", "SV1-51", "SV1-52", "SV1-53", "SV1-54", "SV1-55",
];
const MANIFEST_A_ONLY = ["SV1-60a", "SV1-60", "SV1-64", "SV1-63", "SV1-63b", "SV1-61", "SV1-62", "SV1-68", "SV1-69"];
const MANIFEST_B_ONLY = ["SV1-65"];
const MANIFEST_GLOBAL = ["SV1-90a", "SV1-66", "SV1-67"];
/** Recorded, never a pass condition by themselves; every other entry must not be INFO. */
const MANIFEST_INFO = new Set(["SV1-05", "SV1-12i", "SV1-34i", "SV1-64", "SV1-65"]);
/** SV1-34i is recorded only when SV1-34 (same phase and model) runs; when SV1-34 is NOT ESTABLISHED it is absent. */
const MANIFEST_CONDITIONAL: Record<string, string> = { "SV1-34i": "SV1-34" };

function resultKey(r: Result): string {
  return `${r.id}${r.detail.startsWith("[new]") ? "[new]" : r.detail.startsWith("[legacy]") ? "[legacy]" : ""}`;
}
function expectedManifest(): string[] {
  const keys: string[] = [...MANIFEST_GLOBAL];
  for (const phase of ["A", "B"]) {
    for (const id of [...MANIFEST_ONCE, ...(phase === "A" ? MANIFEST_A_ONLY : MANIFEST_B_ONLY)]) keys.push(`${phase}:${id}`);
    for (const id of MANIFEST_PER_MODEL) for (const m of ["legacy", "new"]) keys.push(`${phase}:${id}[${m}]`);
  }
  return keys;
}
/** Every mandatory assertion recorded exactly once, nothing unlisted, and no mandatory assertion downgraded to INFO. */
function checkManifest(rs: Result[]): { ok: boolean; detail: string } {
  const recorded = rs.filter((r) => r.id !== "SV1-90" && r.id !== "SV1-NET");
  const seen = new Map<string, Result[]>();
  for (const r of recorded) seen.set(resultKey(r), [...(seen.get(resultKey(r)) ?? []), r]);
  const expected = expectedManifest();
  const bare = (k: string) => k.replace(/^[AB]:/, "").replace(/\[(legacy|new)\]$/, "");
  const missing = expected.filter((k) => {
    if (seen.has(k)) return false;
    const dep = MANIFEST_CONDITIONAL[bare(k)];
    if (!dep) return true;
    return seen.get(k.replace(bare(k), dep))?.[0]?.outcome !== "NOT_ESTABLISHED";
  });
  const expectedSet = new Set(expected);
  const unlisted = [...seen.keys()].filter((k) => !expectedSet.has(k));
  const duplicated = [...seen].filter(([, v]) => v.length > 1).map(([k]) => k);
  const downgraded = recorded.filter((r) => !MANIFEST_INFO.has(bare(resultKey(r))) && r.outcome === "INFO").map(resultKey);
  const upgraded = recorded.filter((r) => MANIFEST_INFO.has(bare(resultKey(r))) && r.outcome === "PASS").map(resultKey);
  const ok = missing.length === 0 && unlisted.length === 0 && duplicated.length === 0 && downgraded.length === 0 && upgraded.length === 0;
  return { ok, detail: `${expected.length} manifest entries, ${seen.size} recorded keys; missing: ${missing.slice(0, 8).join(",") || "none"}; unlisted: ${unlisted.slice(0, 8).join(",") || "none"}; duplicated: ${duplicated.join(",") || "none"}; mandatory recorded as INFO: ${downgraded.join(",") || "none"}; INFO-only recorded as PASS: ${upgraded.join(",") || "none"}` };
}
/** SV1-90a: the manifest check rejects each mutation of a complete synthetic result set. */
function manifestSelfTest(): { ok: boolean; detail: string } {
  const complete: Result[] = expectedManifest().filter((k) => k !== "SV1-90a").map((k) => {
    const m = /\[(legacy|new)\]$/.exec(k);
    const id = k.replace(/\[(legacy|new)\]$/, "");
    return { id, outcome: MANIFEST_INFO.has(id.replace(/^[AB]:/, "")) ? "INFO" : "PASS", detail: m ? `[${m[1]}] synthetic` : "synthetic" };
  });
  complete.push({ id: "SV1-90a", outcome: "PASS", detail: "synthetic" });
  const drop = (id: string) => complete.filter((r) => resultKey(r) !== id);
  const cases: Array<[string, Result[], boolean]> = [
    ["complete set accepted", complete, true],
    ["a per-model assertion removed from both phases", drop("A:SV1-79[new]").filter((r) => resultKey(r) !== "B:SV1-79[new]"), false],
    ["a once-per-phase assertion removed", drop("B:SV1-72"), false],
    ["an A-only assertion removed", drop("A:SV1-68"), false],
    ["a global assertion removed", drop("SV1-67"), false],
    ["an unlisted assertion added", [...complete, { id: "A:SV1-99", outcome: "PASS", detail: "synthetic" }], false],
    ["an assertion recorded twice", [...complete, { id: "A:SV1-70", outcome: "PASS", detail: "synthetic" }], false],
    ["a mandatory assertion downgraded to INFO", complete.map((r) => (resultKey(r) === "A:SV1-81" ? { ...r, outcome: "INFO" as Outcome } : r)), false],
    ["SV1-34i absent while SV1-34 ran", drop("A:SV1-34i[legacy]"), false],
    ["SV1-34i absent while SV1-34 is NOT ESTABLISHED", drop("A:SV1-34i[legacy]").map((r) => (resultKey(r) === "A:SV1-34[legacy]" ? { ...r, outcome: "NOT_ESTABLISHED" as Outcome } : r)), true],
  ];
  const wrong = cases.filter(([, rs, want]) => checkManifest(rs).ok !== want).map(([name]) => name);
  return { ok: wrong.length === 0, detail: `${cases.length} cases (1 complete set, ${cases.length - 2} mutations rejected, 1 conditional absence accepted); wrong: ${wrong.join("; ") || "none"}` };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  if (process.env.ZYPACT_SV1_STACK_TEST !== "1") {
    console.log("SKIP: set ZYPACT_SV1_STACK_TEST=1 to run SV1 against a disposable local Supabase stack. A SKIP is not a validation.");
    return 2;
  }
  const outDir = process.env.ZYPACT_SV1_OUT;
  console.log(`SV1 — Q2′-1 and Q2′-2 on a disposable local Supabase stack. ${tryRun("supabase", ["--version"]).out.trim() || "supabase CLI not found"}`);
  const results: Result[] = [];
  const self = manifestSelfTest();
  results.push({ id: "SV1-90a", outcome: self.ok ? "PASS" : "FAIL", detail: `manifest check self-test: ${self.detail}` });
  console.log(`  ${self.ok ? "PASS" : "FAIL"}            SV1-90a manifest check self-test: ${self.detail}`);
  try {
    if (!tryRun("supabase", ["--version"]).ok) stop("the Supabase CLI is not available");
    if (!tryRun("docker", ["info"]).ok) stop("Docker is not available");
    preflight();
    if (await apiAnswers()) stop("something already answers on 127.0.0.1:54321; refusing to start");
    const a = await phaseA(results);
    const b = await phaseB(results);
    // pg_dump (17.6) brackets every dump with \restrict / \unrestrict and a random
    // per-dump token; those two lines differ on every run and are not schema.
    const norm = (d: string) => d.split("\n").filter((l) => !/^\\(restrict|unrestrict) /.test(l)).join("\n");
    const same = norm(a.dump) === norm(b.dump);
    results.push({ id: "SV1-66", outcome: same ? "PASS" : "FAIL", detail: `public schema dump (with ACLs), production order vs CLI order: identical ${same} (${a.dump.split("\n").length} lines)` });
    console.log(`  ${same ? "PASS" : "FAIL"}            SV1-66 public schema identical in A and B: ${same}`);
    if (!same && outDir) { writeFileSync(path.join(outDir, "schema_A.sql"), a.dump); writeFileSync(path.join(outDir, "schema_B.sql"), b.dump); }
    const cmp = compareAssertions(a.assertions, b.assertions);
    results.push({ id: "SV1-67", outcome: cmp.ok ? "PASS" : "FAIL", detail: `complete security assertion sets identical in A and B: ${cmp.detail}` });
    console.log(`  ${cmp.ok ? "PASS" : "FAIL"}            SV1-67 complete security assertion sets identical in A and B: ${cmp.detail}`);
    const man = checkManifest(results);
    results.push({ id: "SV1-90", outcome: man.ok ? "PASS" : "FAIL", detail: `fail-closed assertion manifest: ${man.detail}` });
    console.log(`  ${man.ok ? "PASS" : "FAIL"}            SV1-90 fail-closed assertion manifest: ${man.detail}`);
  } catch (e) {
    if (e instanceof Stop) {
      console.error(`\nSTOP: ${e.message}`);
      if (outDir) writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ stop: e.message, results }, null, 2));
      return 4;
    }
    console.error(`\nERROR: ${redact(String((e as Error)?.stack ?? e))}`);
    if (outDir) writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ error: redact(String(e)), results }, null, 2));
    return 1;
  } finally {
    globalThis.fetch = realFetch;
  }
  if (blockedFetches > 0) results.push({ id: "SV1-NET", outcome: "FAIL", detail: `${blockedFetches} non-local fetch attempt(s) blocked` });
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(`\nSV1 summary: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("NOT_ESTABLISHED")} NOT ESTABLISHED, ${count("INFO")} INFO; non-local fetches blocked: ${blockedFetches}`);
  if (outDir) writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ results }, null, 2));
  if (count("FAIL") > 0) return 1;
  if (count("NOT_ESTABLISHED") > 0) return 3;
  return 0;
}

main().then((code) => process.exit(code));
