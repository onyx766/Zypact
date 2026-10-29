/**
 * PG-9 — the harness, offline. Nothing here starts Docker, the Supabase
 * CLI or PostgreSQL.
 *
 *   [1] migration selection: the real supabase/migrations directory yields
 *       exactly 0001-0081 + 0083 (0082 held); the file list and hashes are
 *       printed as the selection proof; every malformed listing is refused;
 *   [2] the network guard: providers, remote hosts and other local ports
 *       are refused and recorded; the stack's loopback ports are let through;
 *   [3] the roster: P1-P15 once each; P8, P9, P13 are limitations (G1, G3,
 *       G4); every case is recorded by the stack script;
 *   [4] the stack script is opt-in: without ZYPACT_PG9_STACK_TEST=1 it runs
 *       neither docker nor supabase, exits 0 and says PG-9 remains open;
 *   [5] its static safety: never links, pushes or targets a remote; clears
 *       inherited credentials and installs the guard before any client;
 *       psql only in its own container; stop --no-backup only on success;
 *   [6] the lifecycle (scripts/pg9-lifecycle.ts) against stub `docker` and
 *       `supabase` executables: every preflight failure ends before
 *       `supabase start`; a partial start keeps the workdir and reports the
 *       containers; a failed stop after a successful run is a failure; no
 *       command ever stops or touches a container, related or not; and the
 *       real script exits non-zero with that evidence;
 *   [7] the fixture claim contract (run 40878868914 failed on it): the
 *       targeted claim takes only one-attempt jobs (0059's max_attempts = 1)
 *       and the ordinary claim takes multi-attempt jobs, each checking
 *       CLAIMED, the job id and the token, and naming the RPC outcome on
 *       refusal; P3/P7/ledgerRow/P15 use the right one. Against the
 *       in-memory adapter, which mirrors both claim predicates.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runPg9Lifecycle, type LifecycleResult } from "./pg9-lifecycle";
import { fixtureClaims, fixtureJobFactory } from "./test-pg9-paid-gate-runtime";
import type { DbAdapter } from "@/lib/db/types";
import {
  PG9_API_ORIGIN,
  PG9_CASES,
  PG9_HELD_MIGRATIONS,
  PG9_MIGRATION_NUMBERS,
  installLocalOnlyNetworkGuard,
  isLocalStackDestination,
  selectPg9Migrations,
} from "./pg9-harness";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("\nPG-9 harness, offline (no stack is started)\n");

  /* ═══════ [1] migration selection ═══════ */
  console.log("[1] Migration allowlist");
  const dir = path.join("supabase", "migrations");
  const listing = readdirSync(dir);
  const sel = selectPg9Migrations(listing);
  check("the real directory selects", sel.ok, sel.ok ? "" : sel.reason);
  if (sel.ok) {
    const numbers = sel.files.map((f) => Number(f.slice(0, 4)));
    check("exactly 82 files: 0001-0081 and 0083", sel.files.length === 82
      && numbers.join(",") === PG9_MIGRATION_NUMBERS.join(","), `${sel.files.length}`);
    check("0082 is absent (HOLD), and 0083 is the last", !numbers.includes(82) && numbers[numbers.length - 1] === 83);
    check("nothing is renumbered: each selected file is the repository's own file name",
      sel.files.every((f) => listing.includes(f)));
    const proof = createHash("sha256");
    for (const f of sel.files) proof.update(`${f}\0${createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")}\n`);
    console.log(`  selection: ${sel.files[0]} … ${sel.files[80]}, ${sel.files[81]}`);
    console.log(`  selection proof (sha256 over "name\\0sha256\\n" lines): ${proof.digest("hex")}`);
  }
  check("the held list is exactly [82]", PG9_HELD_MIGRATIONS.join(",") === "82");
  const base = sel.ok ? sel.files : [];
  for (const [label, entries, reason] of [
    ["0082 present", [...base, "0082_m7_post_implementation_deviations.sql"], /HOLD/],
    ["an unlisted 0084", [...base, "0084_future.sql"], /not in the PG-9 allowlist/],
    ["0083 missing", base.filter((f) => !f.startsWith("0083_")), /missing migration number 83/],
    ["0001 missing", base.filter((f) => !f.startsWith("0001_")), /missing migration number 1$/],
    ["a duplicate number", [...base, "0010_duplicate.sql"], /duplicate migration number 10/],
    ["a malformed name", [...base, "10_bad.sql"], /malformed/],
  ] as const) {
    const r = selectPg9Migrations(entries);
    check(`${label} → refused`, !r.ok && reason.test(r.reason), r.ok ? "selected" : r.reason);
  }
  check("non-SQL entries are ignored", selectPg9Migrations([...base, "README.md", ".DS_Store"]).ok);

  /* ═══════ [2] the network guard ═══════ */
  console.log("\n[2] Local-only network guard");
  check("the stack's loopback API is a local destination", isLocalStackDestination("127.0.0.1", 54321));
  for (const [h, p] of [["127.0.0.1", 5432], ["127.0.0.1", 54399], ["10.0.0.1", 54321], ["db.example.supabase.co", 5432], [undefined, 54321]] as const) {
    check(`${h}:${p} is not`, !isLocalStackDestination(h, p));
  }
  {
    const realFetch = globalThis.fetch;
    const guard = installLocalOnlyNetworkGuard();
    try {
      for (const url of ["https://api.perplexity.ai/v1/sonar", "https://api.openai.com/v1/chat/completions",
        "https://abcdefghijklmnopqrst.supabase.co/rest/v1/protocols", "http://127.0.0.1:54399/rest/v1/"]) {
        let refused = false;
        try { await fetch(url); } catch (e) { refused = /network guard: refused/.test(String(e)); }
        check(`fetch ${new URL(url).origin} is refused before leaving`, refused);
      }
      check("each refusal is recorded", guard.blocked.length === 4, guard.blocked.join(","));
      const allowedBefore = guard.allowed();
      try { await fetch(`${PG9_API_ORIGIN}/rest/v1/`); } catch { /* nothing listens here; only the guard's verdict matters */ }
      check("fetch to the stack API is let through", guard.allowed() > allowedBefore && guard.blocked.length === 4);
      for (const [host, port] of [["1.1.1.1", 443], ["127.0.0.1", 5432]] as const) {
        let refused = false;
        try { net.connect({ host, port }).on("error", () => {}); } catch (e) { refused = /network guard: refused/.test(String(e)); }
        check(`a socket to ${host}:${port} is refused`, refused);
      }
      const s = net.connect({ host: "127.0.0.1", port: 54322 });
      s.on("error", () => {});
      check("a socket to a stack port (54322) is let through", !guard.blocked.includes("127.0.0.1:54322"));
      s.destroy();
    } finally {
      guard.restore();
    }
    check("restore puts the original fetch back", globalThis.fetch === realFetch);
  }

  /* ═══════ [3] the roster ═══════ */
  console.log("\n[3] Roster");
  const ids = PG9_CASES.map((c) => c.id);
  check("P1-P15, each exactly once", ids.join(",") === Array.from({ length: 15 }, (_, i) => `P${i + 1}`).join(","), ids.join(","));
  const lim = PG9_CASES.filter((c) => c.kind === "limitation").map((c) => `${c.id}:${c.gap}`);
  check("limitations are exactly P8 (G1), P9 (G3), P13 (G4)", lim.join(",") === "P8:G1,P9:G3,P13:G4", lim.join(","));
  check("every assertion has no gap label", PG9_CASES.filter((c) => c.kind === "assertion").every((c) => c.gap === undefined));
  const stack = readFileSync("scripts/test-pg9-paid-gate-runtime.ts", "utf8");
  for (const id of ids) {
    check(`${id} is recorded by the stack script`, new RegExp(`record\\("${id}",`).test(stack));
  }

  /* ═══════ [4] opt-in only ═══════ */
  console.log("\n[4] Opt-in only");
  {
    const bin = mkdtempSync(path.join(os.tmpdir(), "pg9-stub-bin-"));
    const marker = path.join(bin, "INVOKED");
    try {
      for (const name of ["docker", "supabase"]) {
        writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$0 $@" >> "${marker}"\nexit 0\n`);
        chmodSync(path.join(bin, name), 0o755);
      }
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-pg9-paid-gate-runtime.ts"], {
        encoding: "utf8", timeout: 120_000,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_ENV: "test", TZ: "UTC" },
      });
      check("without ZYPACT_PG9_STACK_TEST=1 it exits 0", r.status === 0, `status=${r.status} ${r.stderr.slice(0, 120)}`);
      check("…invokes neither docker nor supabase", !existsSync(marker));
      check("…and says nothing was validated and PG-9 remains open",
        /NOTHING was started, migrated or validated/.test(r.stdout) && /PG-9 remains OPEN/.test(r.stdout), r.stdout.slice(0, 200));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  /* ═══════ [5] static safety of the stack script ═══════ */
  console.log("\n[5] Stack script safety");
  for (const [label, re] of [
    ["links a remote project", /"link"|supabase link/],
    ["pushes or resets against a remote", /"db",\s*"push"|--linked|--db-url|db push/],
    ["names a hosted Supabase URL", /https:\/\/[a-z0-9-]+\.supabase\.(co|in)/],
    ["prunes Docker (a \"prune\" argument to any command)", /"prune"/],
    ["reads a pre-existing credential before clearing it", /process\.env\.(SUPABASE_SERVICE_ROLE_KEY|PERPLEXITY_API_KEY|OPENAI_API_KEY)\s*\?\?/],
  ] as const) {
    check(`it never ${label}`, !re.test(stack));
  }
  const clearAt = stack.indexOf("delete process.env[k]");
  const guardAt = stack.indexOf("const guard = installLocalOnlyNetworkGuard();");
  const dbAt = stack.indexOf('await import("@/lib/db")');
  check("inherited Supabase/provider/paid variables are cleared first", clearAt > 0 && clearAt < guardAt);
  check("the network guard is installed before any client or adapter is loaded", guardAt > 0 && guardAt < dbAt);
  check("the client URL is the stack's loopback API", /process\.env\.NEXT_PUBLIC_SUPABASE_URL = PG9_API_ORIGIN;/.test(stack));
  const lifecycle = readFileSync("scripts/pg9-lifecycle.ts", "utf8");
  check("psql runs only in this run's own database container",
    /const container = `supabase_db_\$\{projectId\}`;/.test(lifecycle) && /const \{ container \} = ctx;/.test(stack)
      && (stack.match(/"exec", "-i", container,/g) ?? []).length === 1 && !/startsWith\("supabase_db_"\)/.test(stack + lifecycle));
  check("the stack script starts and stops nothing itself; the lifecycle owns both",
    !/"start", "--workdir"|"stop", "--no-backup"/.test(stack) && /runPg9Lifecycle\(/.test(stack));
  check("the lifecycle's only Docker commands are --version and read-only ps",
    (lifecycle.match(/exec\("docker", \[[^\]]*\]/g) ?? []).every((c) => /\["ps", "-a"|\["--version"\]|cmd/.test(c))
      && !/"(stop|rm|kill|restart)"/.test(lifecycle.replace(/"stop", "--no-backup", "--workdir", workdir/, "")));
  check("migrations come from the allowlist and are copied, never edited",
    /selectPg9Migrations\(readdirSync\(o\.migrationsDir\)\)/.test(lifecycle) && /copy\(path\.join\(o\.migrationsDir, f\), path\.join\(dst, f\)\)/.test(lifecycle));
  check("the summary reports limitations separately and never as a pass",
    /LIMITATION DEMONSTRATED/.test(stack) && /limitations above are demonstrated gaps, not passes/.test(stack));
  check("success requires both the lifecycle and the cases",
    /const success = result\.status === "passed" && s\.success;/.test(stack) && /process\.exitCode = success \? 0 : 1;/.test(stack));


  /* ═══════ [6] the lifecycle, against stub commands ═══════ */
  console.log("\n[6] Lifecycle (stub docker / supabase)");
  {
    const root = mkdtempSync(path.join(os.tmpdir(), "pg9-lifecycle-"));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    // Every call is logged. docker answers only --version and ps; ANY other
    // docker command (stop, rm, kill, exec…) exits 97, so a test can prove
    // none was issued. supabase behaves per STUB_MODE.
    writeFileSync(path.join(bin, "docker"), [
      "#!/bin/sh",
      'echo "docker $*" >> "$STUB_STATE/calls"',
      'case "$1" in',
      '  --version) echo "Docker version stub"; exit 0;;',
      '  ps) [ -f "$STUB_STATE/containers" ] && cat "$STUB_STATE/containers"; exit 0;;',
      "esac",
      'echo "refused: docker $*" >&2; exit 97',
    ].join("\n"));
    writeFileSync(path.join(bin, "supabase"), [
      "#!/bin/sh",
      'echo "supabase $*" >> "$STUB_STATE/calls"',
      'case "$1" in',
      '  --version) echo "2.111.0"; exit 0;;',
      '  init) wd="$3"; id=$(basename "$wd"); mkdir -p "$wd/supabase"',
      '    api=true; rows=1000; pid="$id"; seed="[db.seed]"',
      '    case "$STUB_MODE" in api_off) api=false;; rows500) rows=500;; empty_id) pid="";; no_seed) seed="[db.other]";; esac',
      '    printf \'project_id = "%s"\\n\\n[api]\\nenabled = %s\\nport = 54321\\nmax_rows = %s\\n\\n%s\\nenabled = true\\n\' "$pid" "$api" "$rows" "$seed" > "$wd/supabase/config.toml"',
      '    [ "$STUB_MODE" = linked ] && mkdir -p "$wd/supabase/.temp" && echo "{}" > "$wd/supabase/.temp/linked-project.json"',
      '    [ "$STUB_MODE" = collide ] && printf "supabase_db_%s\\tUp 3 days\\n" "$id" >> "$STUB_STATE/containers"',
      "    exit 0;;",
      '  start) id=$(basename "$3")',
      '    if [ "$STUB_MODE" = ghost ]; then exit 0; fi',
      '    printf "supabase_db_%s\\tUp 1 second\\n" "$id" >> "$STUB_STATE/containers"',
      '    if [ "$STUB_MODE" = partial ]; then echo "start failed halfway" >&2; exit 1; fi',
      '    printf "supabase_kong_%s\\tUp 1 second\\n" "$id" >> "$STUB_STATE/containers"; exit 0;;',
      '  stop) id=$(basename "$4")',
      '    if [ "$STUB_MODE" = stopfail ]; then echo "stop failed" >&2; exit 1; fi',
      '    grep -v "_${id}" "$STUB_STATE/containers" > "$STUB_STATE/c2"; mv "$STUB_STATE/c2" "$STUB_STATE/containers"; exit 0;;',
      '  status) echo "SERVICE_ROLE_KEY=\\"stub-key\\""; exit 0;;',
      "esac",
      "exit 98",
    ].join("\n"));
    chmodSync(path.join(bin, "docker"), 0o755);
    chmodSync(path.join(bin, "supabase"), 0o755);

    const UNRELATED = "zypact_production_like\tUp 9 days";
    let n = 0;
    const scenario = (mode: string) => {
      n += 1;
      const state = path.join(root, `state-${n}-${mode}`);
      mkdirSync(state);
      writeFileSync(path.join(state, "containers"), `${UNRELATED}\n`);
      writeFileSync(path.join(state, "calls"), "");
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB_MODE: mode, STUB_STATE: state };
      const exec = (cmd: string, args: string[]) =>
        execFileSync(cmd, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
      const calls = () => readFileSync(path.join(state, "calls"), "utf8");
      const containers = () => readFileSync(path.join(state, "containers"), "utf8");
      return { exec, calls, containers, env, state };
    };
    const tmpRoot = path.join(root, "work");
    mkdirSync(tmpRoot);
    const quiet = () => {};
    const migrationsDir = path.join("supabase", "migrations");
    const touchedNothing = (calls: string) => !/^docker (stop|rm|kill|exec|restart|pause|container|network|volume|system)/m.test(calls);
    const common = (label: string, r: LifecycleResult, calls: string, containers: string) => {
      check(`${label}: the workdir is kept as evidence`, r.workdir !== null && existsSync(r.workdir));
      check(`${label}: no command touched any container`, touchedNothing(calls), calls.split("\n").filter((l) => l.startsWith("docker")).join(" | "));
      check(`${label}: the unrelated container is untouched`, containers.includes(UNRELATED));
    };

    // L1 — every preflight failure ends before `supabase start`
    for (const [mode, reason, extra] of [
      ["api_off", /\[api\]\.enabled is not true/, {}],
      ["no_seed", /exactly 1 rewrite of \[db\.seed\]\.enabled, made 0/, {}],
      ["rows500", /max_rows is 500, expected 1000/, {}],
      ["empty_id", /project id is missing/, {}],
      ["linked", /linked to a remote/, {}],
      ["collide", /containers already exist for project id/, {}],
      ["ok", /migration allowlist: migration 82 is on HOLD/, { migrationsDir: "HOLD" }],
      ["ok", /was not copied byte-identically/, { corruptCopy: true }],
    ] as const) {
      const st = scenario(mode);
      let dir = migrationsDir;
      if ("migrationsDir" in extra) {
        dir = path.join(root, `mig-${n}`);
        mkdirSync(dir);
        for (const f of readdirSync(migrationsDir)) copyFileSync(path.join(migrationsDir, f), path.join(dir, f));
        writeFileSync(path.join(dir, "0082_m7_post_implementation_deviations.sql"), "-- held");
      }
      const r = await runPg9Lifecycle({
        exec: st.exec, migrationsDir: dir, tmpRoot, portFree: async () => true, log: quiet, body: async () => true,
        ...("corruptCopy" in extra ? { copyFile: (src: string, dst: string) => { copyFileSync(src, dst); if (src.endsWith("0047_m4_buyer_question_protocol_attempts.sql")) writeFileSync(dst, "-- altered"); } } : {}),
      });
      const label = `preflight ${"migrationsDir" in extra ? "0082 present" : "corruptCopy" in extra ? "corrupt copy" : mode}`;
      check(`${label}: preflight_failed with the reason`, r.status === "preflight_failed" && r.reasons.some((x) => reason.test(x)), r.reasons.join(" / "));
      check(`${label}: supabase start was never invoked`, !r.startAttempted && !/^supabase start/m.test(st.calls()));
      common(label, r, st.calls(), st.containers());
      if (mode === "collide") {
        check(`${label}: the colliding container is reported, not stopped`,
          (r.observedContainers ?? []).some((c) => c.startsWith("supabase_db_")) && /supabase_db_/.test(st.containers()));
      }
    }
    {
      const st = scenario("ok");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async (p) => p !== 54322, log: quiet, body: async () => true });
      check("preflight busy port: refused before init or start", r.status === "preflight_failed" && r.workdir === null
        && !/^supabase (init|start)/m.test(st.calls()), r.reasons.join(" / "));
    }

    // L2 — partial start: the stack may be half up; evidence kept, nothing stopped
    {
      const st = scenario("partial");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet, body: async () => true });
      check("partial start: start_failed, start attempted", r.status === "start_failed" && r.startAttempted, r.reasons.join(" / "));
      check("partial start: the half-started database container is reported",
        (r.observedContainers ?? []).some((c) => /^supabase_db_\S+\tUp/.test(c)), JSON.stringify(r.observedContainers));
      check("partial start: it was not stopped (left for inspection)", !/^supabase stop/m.test(st.calls()) && /supabase_db_/.test(st.containers()));
      common("partial start", r, st.calls(), st.containers());
    }
    {
      const st = scenario("ghost");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet, body: async () => true });
      check("start returning 0 without this run's database container is start_failed",
        r.status === "start_failed" && /is not present/.test(r.reasons.join(" ")), r.reasons.join(" / "));
    }

    // L3 — cases fail: no stop, evidence kept
    {
      const st = scenario("ok");
      let ran = false;
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet,
        body: async () => { ran = true; return false; } });
      check("cases fail: cases_failed, the stack is not stopped", ran && r.status === "cases_failed" && !/^supabase stop/m.test(st.calls()));
      common("cases fail", r, st.calls(), st.containers());
    }
    {
      const st = scenario("ok");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet,
        body: async () => { throw new Error("boom"); } });
      check("cases throw: cases_failed with the error kept", r.status === "cases_failed" && r.reasons.some((x) => /boom/.test(x)));
    }

    // L4 — a failed stop after a successful run is a failure
    {
      const st = scenario("stopfail");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet, body: async () => true });
      check("failed stop: stop_failed, never passed", r.status === "stop_failed", r.status);
      check("failed stop: the still-running containers are reported", (r.observedContainers ?? []).length >= 2, JSON.stringify(r.observedContainers));
      common("failed stop", r, st.calls(), st.containers());
    }

    // L5 — the only path to `passed`
    {
      const st = scenario("ok");
      const r = await runPg9Lifecycle({ exec: st.exec, migrationsDir, tmpRoot, portFree: async () => true, log: quiet, body: async () => true });
      const stopLine = st.calls().split("\n").find((l) => l.startsWith("supabase stop")) ?? "";
      check("success: passed only after a confirmed stop", r.status === "passed" && (r.observedContainers ?? []).length === 0, r.status);
      check("success: the stop is --no-backup for this run's workdir only", stopLine === `supabase stop --no-backup --workdir ${r.workdir}`, stopLine);
      check("success: the unrelated container is still running", st.containers().includes(UNRELATED));
      check("success: 82 migration hashes recorded", r.migrations.length === 82 && r.migrations.every((m) => /^[0-9a-f]{64}$/.test(m.sha256)));
    }

    // L6 — the real script: non-zero exit, evidence printed
    const portsFree = (await Promise.all([54321, 54322, 54323, 54324].map((p) => new Promise<boolean>((res) => {
      const srv = net.createServer(); srv.once("error", () => res(false)); srv.listen(p, "127.0.0.1", () => srv.close(() => res(true)));
    })))).every(Boolean);
    for (const [mode, want] of [["api_off", "preflight_failed (supabase start was NOT invoked)"], ["partial", "start_failed"]] as const) {
      const st = scenario(mode);
      const scriptTmp = path.join(root, `script-${n}`);
      mkdirSync(scriptTmp);
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-pg9-paid-gate-runtime.ts"], {
        encoding: "utf8", timeout: 120_000,
        env: { PATH: st.env.PATH, STUB_MODE: mode, STUB_STATE: st.state, TMPDIR: scriptTmp, NODE_ENV: "test", TZ: "UTC", ZYPACT_PG9_STACK_TEST: "1" },
      });
      if (!portsFree) {
        check(`script ${mode}: ports 54321-54324 are free on this machine (environment precondition)`, false, "a port is in use");
        continue;
      }
      check(`script ${mode}: exits non-zero`, r.status === 1, `status=${r.status}`);
      check(`script ${mode}: reports ${want}`, r.stdout.includes(`lifecycle: ${want}`), r.stdout.split("\n").filter((l) => l.includes("[PG-9]")).join(" | ").slice(0, 240));
      check(`script ${mode}: prints the kept workdir`, /workdir KEPT for inspection: \S+/.test(r.stdout));
      check(`script ${mode}: never reports PASSED`, !/PG-9 stack run PASSED/.test(r.stdout) && /PG-9 stack run FAILED/.test(r.stdout));
      if (mode === "partial") {
        check("script partial: names the half-started container", /\[PG-9\]\s+supabase_db_\S+\s+Up/.test(r.stdout));
      }
      check(`script ${mode}: start ${mode === "api_off" ? "never invoked" : "invoked once, never stopped"}`,
        mode === "api_off" ? !/^supabase start/m.test(st.calls()) : (st.calls().match(/^supabase start/gm) ?? []).length === 1 && !/^supabase stop/m.test(st.calls()));
      check(`script ${mode}: no command touched any container`, touchedNothing(st.calls()));
    }
    rmSync(root, { recursive: true, force: true });
  }


  /* ═══════ [7] the fixture claim contract ═══════ */
  console.log("\n[7] Fixture claim contract (targeted one-attempt vs ordinary multi-attempt)");
  {
    const { memoryAdapter } = await import("@/lib/db/memory-adapter");
    const db: DbAdapter = memoryAdapter;
    const Q = "Which vendors handle X best?";
    const project = await db.createProject({ domain: "pg9-fixture-contract.test", companyName: "Fixture" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: project.id, versionNumber: 1, promptText: Q,
      promptHash: createHash("sha256").update(Q).digest("hex"), intentType: "comparison", commercialValue: 3, winnability: 3,
      priority: 10, rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: project.id, approvedBy: "11111111-1111-4111-8111-111111111111" });
    const makeJob = fixtureJobFactory(db, { projectId: project.id, versionId: version.id });
    const { claimById, claimNext } = fixtureClaims(db);
    const errorOf = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };
    const drain = async () => {
      for (;;) {
        const c = await db.claimProtocolExecutionJob({ workerId: "drain", leaseSeconds: 60 });
        if (!c.job || !c.claimToken) return;
        await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
      }
    };

    // The root cause, reproduced on the RPC itself.
    const dflt = await makeJob(1);
    check("makeJob without maxAttempts keeps the enqueue default (3)", dflt.maxAttempts === 3, String(dflt.maxAttempts));
    const raw = await db.claimProtocolExecutionJobById({ workerId: "w", leaseSeconds: 60, jobId: dflt.id, projectId: dflt.projectId });
    check("the targeted RPC on a 3-attempt job is JOB_NOT_ELIGIBLE with no job (run 40878868914)",
      raw.outcome === "JOB_NOT_ELIGIBLE" && raw.job === null && raw.claimToken === null, raw.outcome);
    await drain();

    // Targeted claim: one-attempt jobs only.
    const one = await makeJob(1, { maxAttempts: 1 });
    check("makeJob passes maxAttempts: 1 through", one.maxAttempts === 1);
    const t = await claimById(one, 60);
    check("claimById on a one-attempt job: CLAIMED, same id, a token, attempt 1 of 1 (exhausted once the lease lapses)",
      t.job.id === one.id && typeof t.claimToken === "string" && t.claimToken.length > 0 && t.job.attemptCount === 1 && t.job.maxAttempts === 1);
    const three = await makeJob(1);
    const refusedPre = await errorOf(() => claimById(three, 60));
    check("claimById refuses a multi-attempt job before calling the RPC", /targeted claim is for one-attempt jobs; .*maxAttempts=3/.test(refusedPre), refusedPre);
    const afterPre = await db.claimProtocolExecutionJobById({ workerId: "probe", leaseSeconds: 60, jobId: three.id, projectId: three.projectId });
    check("…so that job was left untouched (the RPC still sees it as merely ineligible)", afterPre.outcome === "JOB_NOT_ELIGIBLE");
    await drain();

    // Ordinary claim: multi-attempt jobs, the exact expected job.
    const multi = await makeJob(1);
    const n = await claimNext(multi, 60);
    check("claimNext on the only eligible multi-attempt job: CLAIMED, same id, a token, attempts left (1 of 3)",
      n.job.id === multi.id && n.claimToken.length > 0 && n.job.attemptCount === 1 && n.job.maxAttempts === 3);
    const single = await makeJob(1, { maxAttempts: 1 });
    const refusedOne = await errorOf(() => claimNext(single, 60));
    check("claimNext refuses a one-attempt job before calling the RPC", /ordinary claim is for multi-attempt jobs; .*maxAttempts=1/.test(refusedOne), refusedOne);
    await drain();
    const older = await makeJob(1);
    const newer = await makeJob(1);
    const wrong = await errorOf(() => claimNext(newer, 60));
    check("claimNext fails when oldest-first takes a different job than expected", /took a different job than the fixture expected/.test(wrong), wrong);
    void older;
    await drain();
    const none = await makeJob(1);
    await drain(); // closes `none` too: nothing is eligible now
    const empty = await errorOf(() => claimNext(none, 60));
    check("claimNext names the RPC outcome when nothing is claimable", empty === "ordinary claim refused: NO_JOB_AVAILABLE", empty);

    // A refusal names the closed outcome and nothing else.
    const locked: DbAdapter = { ...db, claimProtocolExecutionJobById: async () => ({ outcome: "JOB_LOCKED" as const, job: null, claimToken: null }) };
    const lockedMsg = await errorOf(() => fixtureClaims(locked).claimById(one, 60));
    check("a targeted refusal reports exactly its outcome (JOB_LOCKED)", lockedMsg === "targeted claim refused: JOB_LOCKED", lockedMsg);
    const tokenOnly: DbAdapter = { ...db, claimProtocolExecutionJob: async () => ({ outcome: "CLAIMED" as const, job: null, claimToken: "SECRET-TOKEN-SENTINEL" }) };
    const tokenMsg = await errorOf(() => fixtureClaims(tokenOnly).claimNext(multi, 60));
    check("a malformed CLAIMED reply is refused without echoing the token",
      /without a job and a token/.test(tokenMsg) && !tokenMsg.includes("SECRET-TOKEN-SENTINEL"), tokenMsg);

    // P3's fixture order, run as written: every claim takes exactly its job.
    await drain();
    {
      const live = await makeJob(2); await claimNext(live, 600);
      const expired = await makeJob(1.5); const e = await claimNext(expired, 600);
      const exhausted = await makeJob(9, { maxAttempts: 1 }); const x = await claimById(exhausted, 600);
      const queued = await makeJob(0.5);
      check("P3 order: live and expired are claimed 1 of 3 (attempts left); exhausted is 1 of 1; the last job stays queued",
        e.job.attemptCount === 1 && e.job.maxAttempts === 3 && x.job.attemptCount === 1 && x.job.maxAttempts === 1
          && queued.maxAttempts === 3 && queued.status === "queued" && queued.attemptCount === 0);
      await drain();
    }

    // The runtime script uses each helper where the scenario needs it.
    const stackSrc = readFileSync("scripts/test-pg9-paid-gate-runtime.ts", "utf8");
    check("ledgerRow creates one-attempt jobs and uses the targeted claim",
      /const job = await makeJob\(100, \{ maxAttempts: 1 \}\);\s*const c = await claimById\(job\);/.test(stackSrc));
    check("P15 creates a one-attempt job and uses the targeted claim",
      /const job = await makeJob\(0\.03, \{ maxAttempts: 1 \}\);\s*const c = await claimById\(job\);/.test(stackSrc));
    check("P3: live and expired via claimNext on default jobs; exhausted via claimById on a one-attempt job; queued created last",
      /const live = await makeJob\(2\); await claimNext\(live, 600\);\s*const expired = await makeJob\(1\.5\); await claimNext\(expired, 600\);\s*const exhausted = await makeJob\(9, \{ maxAttempts: 1 \}\); await claimById\(exhausted, 600\);/.test(stackSrc)
        && /const queued = await makeJob\(0\.5\);\s*psql\(`update public\.protocol_execution_jobs set lease_expires_at/.test(stackSrc));
    check("P7: expired via claimNext; exhausted via claimById on a one-attempt job; leases moved after both",
      /const expired = await makeJob\(1\.5\); await claimNext\(expired, 600\);\s*const exhausted = await makeJob\(9, \{ maxAttempts: 1 \}\); await claimById\(exhausted, 600\);\s*psql\(`update public\.protocol_execution_jobs set lease_expires_at/.test(stackSrc));
    check("no fixture forces exhaustion by editing attempt_count any more", !/set attempt_count = max_attempts/.test(stackSrc));
    check("every claimById call outside the helpers targets a job made with maxAttempts: 1",
      [...stackSrc.matchAll(/await claimById\((\w+)/g)].every((m) => new RegExp(`const ${m[1]} = await makeJob\\([^)]*\\{ maxAttempts: 1 \\}\\)`).test(stackSrc)));
    check("the old silent null check is gone", !/must\(c\.job, "claimed job"\)/.test(stackSrc));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}`);
  console.log("This suite validates the harness only. PG-9 itself is NOT validated until the stack run is approved and executed.\n");
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
