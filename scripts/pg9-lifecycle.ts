/**
 * PG-9 — the disposable stack's lifecycle, fail closed at every step.
 *
 *   preflight   tools present; ports free; `supabase init` in a fresh
 *               temporary workdir; exactly one config rewrite (seed off);
 *               [db.seed].enabled=false and [api].enabled=true; a valid,
 *               non-empty project id that names no existing container;
 *               [api].max_rows as expected; no remote link; the exact
 *               migration allowlist, copied byte-identically. ANY failure
 *               ends here: `supabase start` is never invoked.
 *   start       `supabase start --workdir` for this workdir only. A failure
 *               — or a "success" without this run's database container —
 *               is a partial start: the workdir is kept, the containers
 *               named for this project are reported, nothing is stopped.
 *   body        the cases, which return whether they all succeeded.
 *   stop        only after a successful body: `supabase stop --no-backup
 *               --workdir` for this workdir. A failed stop is a failed run.
 *
 * Every failure is a non-`passed` status with its evidence: the reasons,
 * the workdir (kept), and the observed containers for this project id.
 * Nothing here ever stops, removes or touches a container by name; the only
 * Docker commands are `--version` and read-only `ps` listings.
 *
 * Commands go through an injected `exec` (default execFileSync), so the
 * offline suite drives this exact code with stub `docker` / `supabase`
 * executables on PATH.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PG9_LOCAL_PORTS, selectPg9Migrations } from "./pg9-harness";

export type Exec = (cmd: string, args: string[]) => string;

export const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

export const EXPECTED_MAX_ROWS = 1000;

/** Shapes that must never reach a log: JWTs, bearer headers, Supabase API keys. */
const SECRET_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/gi,
  /sb_(secret|publishable)_[A-Za-z0-9_-]+/g,
];

/**
 * A bounded, privacy-safe one-line description of a thrown value.
 *
 * PostgREST rejects with a plain object ({ code, message, details, hint }),
 * which `String()` renders as "[object Object]". Only two closed fields are
 * kept: a short alphanumeric `code` (e.g. 23505) and the `message` (it
 * carries the constraint name). `details` and `hint` are dropped: they can
 * carry row values. An Error gives its name and message.
 *
 * Order matters, and is fixed: the COMPLETE text is redacted first, then
 * flattened to one line, and only then clipped. Clipping first could cut a
 * secret at the boundary into a fragment no redaction pattern recognises.
 */
export function describeError(e: unknown): string {
  const redact = (t: string) => SECRET_SHAPES.reduce((acc, re) => acc.replace(re, "[redacted]"), t);
  // Control characters (including CR, LF, tab) and Unicode line/paragraph separators.
  const oneLine = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const safe = (t: string, n: number) => clip(oneLine(redact(t)), n);
  if (e instanceof Error) return safe(`${e.name}: ${e.message}`, 300);
  if (e !== null && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const code = typeof o.code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(o.code) ? o.code : null;
    const message = typeof o.message === "string" ? safe(o.message, 200) : null;
    const parts = [code === null ? null : `code=${code}`, message === null ? null : `message=${message}`].filter((x) => x !== null);
    return parts.length > 0 ? parts.join(" ") : "unrecognised error object";
  }
  return safe(String(e), 200);
}

export function readTomlScalar(text: string, section: string | null, key: string): string | null {
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { current = header[1]; continue; }
    if (current !== section) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1] === key) return kv[2].trim();
  }
  return null;
}

export function setTomlScalar(text: string, section: string, key: string, value: string): { text: string; replacements: number } {
  let current: string | null = null;
  let replacements = 0;
  const out = text.split("\n").map((raw) => {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { current = header[1]; return raw; }
    if (current !== section) return raw;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1] !== key) return raw;
    replacements += 1;
    return `${raw.slice(0, raw.length - raw.trimStart().length)}${key} = ${value}`;
  });
  return { text: out.join("\n"), replacements };
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export type LifecycleStatus = "preflight_failed" | "start_failed" | "cases_failed" | "stop_failed" | "passed";

export interface LifecycleResult {
  status: LifecycleStatus;
  /** The temporary workdir, if one was created. Kept on every failure. */
  workdir: string | null;
  /** Whether `supabase start` was invoked at all. */
  startAttempted: boolean;
  reasons: string[];
  /** `name<TAB>status` of every container named for this project id, when observed. */
  observedContainers: string[] | null;
  /** The migration files copied, with their SHA-256, for the record. */
  migrations: Array<{ file: string; sha256: string }>;
}

export interface StackContext {
  workdir: string;
  projectId: string;
  /** This run's database container: `supabase_db_<projectId>`. */
  container: string;
  exec: Exec;
}

export interface LifecycleOptions {
  exec?: Exec;
  migrationsDir: string;
  tmpRoot?: string;
  portFree?: (port: number) => Promise<boolean>;
  /** Fault injection for the offline suite: replaces the migration copy. */
  copyFile?: (src: string, dst: string) => void;
  sha256?: (bytes: Buffer) => string;
  log?: (line: string) => void;
  body: (ctx: StackContext) => Promise<boolean>;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export async function runPg9Lifecycle(o: LifecycleOptions): Promise<LifecycleResult> {
  const exec = o.exec ?? defaultExec;
  const log = o.log ?? ((l: string) => console.log(l));
  const result: LifecycleResult = {
    status: "preflight_failed", workdir: null, startAttempted: false, reasons: [], observedContainers: null, migrations: [],
  };
  const fail = (status: LifecycleStatus, reason: string): LifecycleResult => {
    result.status = status;
    result.reasons.push(reason);
    return result;
  };
  const observe = (projectId: string): string[] | null => {
    try {
      return exec("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"])
        .split("\n").map((l) => l.trim()).filter((l) => l.split("\t")[0].endsWith(`_${projectId}`));
    } catch {
      return null;
    }
  };

  // ── preflight: nothing below may start a stack until every check holds
  for (const cmd of ["docker", "supabase"]) {
    try { exec(cmd, ["--version"]); } catch { return fail("preflight_failed", `\`${cmd}\` is not available`); }
  }
  for (const p of PG9_LOCAL_PORTS) {
    if (!(await (o.portFree ?? portFree)(p))) return fail("preflight_failed", `port ${p} is in use (another stack may be running)`);
  }
  const workdir = mkdtempSync(path.join(o.tmpRoot ?? tmpdir(), "zypact-pg9-"));
  result.workdir = workdir;
  try {
    exec("supabase", ["init", "--workdir", workdir, "--yes"]);
  } catch {
    return fail("preflight_failed", "`supabase init` failed");
  }
  const configPath = path.join(workdir, "supabase", "config.toml");
  if (!existsSync(configPath)) return fail("preflight_failed", "`supabase init` wrote no config.toml");
  const edited = setTomlScalar(readFileSync(configPath, "utf8"), "db.seed", "enabled", "false");
  if (edited.replacements !== 1) {
    return fail("preflight_failed", `expected exactly 1 rewrite of [db.seed].enabled, made ${edited.replacements}`);
  }
  writeFileSync(configPath, edited.text);
  const toml = readFileSync(configPath, "utf8");
  if (readTomlScalar(toml, "db.seed", "enabled") !== "false") return fail("preflight_failed", "[db.seed].enabled is not false");
  if (readTomlScalar(toml, "api", "enabled") !== "true") return fail("preflight_failed", "[api].enabled is not true");
  const projectId = (readTomlScalar(toml, null, "project_id") ?? "").replace(/^"|"$/g, "");
  if (!PROJECT_ID.test(projectId)) return fail("preflight_failed", "the project id is missing or not a plain identifier");
  const existing = observe(projectId);
  if (existing === null) return fail("preflight_failed", "could not list containers to check the project id");
  if (existing.length > 0) {
    result.observedContainers = existing;
    return fail("preflight_failed", `containers already exist for project id ${projectId}; refusing to start beside them`);
  }
  const maxRows = Number(readTomlScalar(toml, "api", "max_rows"));
  if (maxRows !== EXPECTED_MAX_ROWS) return fail("preflight_failed", `[api].max_rows is ${maxRows}, expected ${EXPECTED_MAX_ROWS}`);
  if (existsSync(path.join(workdir, "supabase", ".temp", "linked-project.json"))) {
    return fail("preflight_failed", "the disposable project is linked to a remote");
  }
  const selection = selectPg9Migrations(readdirSync(o.migrationsDir));
  if (!selection.ok) return fail("preflight_failed", `migration allowlist: ${selection.reason}`);
  const dst = path.join(workdir, "supabase", "migrations");
  mkdirSync(dst, { recursive: true });
  const copy = o.copyFile ?? copyFileSync;
  for (const f of selection.files) copy(path.join(o.migrationsDir, f), path.join(dst, f));
  const copied = readdirSync(dst).filter((f) => f.endsWith(".sql")).sort();
  if (copied.join(",") !== [...selection.files].sort().join(",")) {
    return fail("preflight_failed", "the copied migration set differs from the allowlist");
  }
  for (const f of selection.files) {
    if (!readFileSync(path.join(o.migrationsDir, f)).equals(readFileSync(path.join(dst, f)))) {
      return fail("preflight_failed", `migration ${f} was not copied byte-identically`);
    }
  }
  const hash = o.sha256 ?? ((b: Buffer) => createHash("sha256").update(b).digest("hex"));
  result.migrations = selection.files.map((file) => ({ file, sha256: hash(readFileSync(path.join(dst, file))) }));
  log(`[PG-9] preflight passed: project ${projectId}, ${selection.files.length} migrations, workdir ${workdir}`);

  // ── start
  result.startAttempted = true;
  const container = `supabase_db_${projectId}`;
  try {
    exec("supabase", ["start", "--workdir", workdir]);
  } catch {
    result.observedContainers = observe(projectId);
    return fail("start_failed", "`supabase start` failed; the stack may be partially up");
  }
  const after = observe(projectId);
  result.observedContainers = after;
  if (after === null || !after.some((l) => l.split("\t")[0] === container)) {
    return fail("start_failed", `\`supabase start\` returned but ${container} is not present`);
  }

  // ── body
  let bodyOk = false;
  try {
    bodyOk = await o.body({ workdir, projectId, container, exec });
  } catch (e) {
    result.reasons.push(`the cases threw: ${describeError(e)}`);
  }
  if (!bodyOk) {
    result.observedContainers = observe(projectId);
    return fail("cases_failed", "the cases did not all succeed; the stack is left running for inspection");
  }

  // ── stop, only after success, only this workdir
  try {
    exec("supabase", ["stop", "--no-backup", "--workdir", workdir]);
  } catch {
    result.observedContainers = observe(projectId);
    return fail("stop_failed", "`supabase stop --no-backup` failed after a successful run");
  }
  const remaining = observe(projectId);
  result.observedContainers = remaining;
  if (remaining === null || remaining.length > 0) {
    return fail("stop_failed", "containers for this project remain after `supabase stop`");
  }
  result.status = "passed";
  return result;
}

/** Prints a result's evidence. Never prints a credential: there is none in it. */
export function reportLifecycle(r: LifecycleResult, log: (line: string) => void = (l) => console.log(l)): void {
  log(`[PG-9] lifecycle: ${r.status}${r.startAttempted ? "" : " (supabase start was NOT invoked)"}`);
  for (const reason of r.reasons) log(`[PG-9]   reason: ${reason}`);
  if (r.workdir) log(`[PG-9]   workdir ${r.status === "passed" ? "(stack stopped)" : "KEPT for inspection"}: ${r.workdir}`);
  if (r.observedContainers) {
    log(`[PG-9]   containers for this project: ${r.observedContainers.length === 0 ? "none" : ""}`);
    for (const c of r.observedContainers) log(`[PG-9]     ${c}`);
  }
  if (r.status !== "passed" && r.startAttempted && r.workdir) {
    log(`[PG-9]   to stop it: supabase stop --no-backup --workdir ${r.workdir}`);
  }
}
