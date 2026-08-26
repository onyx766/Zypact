#!/usr/bin/env tsx
/**
 * M5 — real, reproducible Postgres runtime contract test for D-027
 * (migration 0053: durable analysis parse-failure ledger —
 * protocol_external_calls.parse_failed_at/parse_failure_code, real
 * pairing/bounded/scope CHECK constraints; analysis_call_receipts.
 * raw_request_body, real pairing/hash-match/used_mock-policy CHECK
 * constraints; the new mark_analysis_parse_failed_for_job RPC, all
 * eleven statuses; retry_analysis_generation_for_job's extended
 * eligibility branch; the one additive monitoring column).
 *
 * This is NOT a static text check (see scripts/test-m5-0053-schema-
 * contract.ts for that). This test creates a genuinely disposable
 * local Supabase/Postgres stack under a fresh mktemp directory, applies
 * EXACTLY migrations 0001-0053 byte-identically (explicitly selected by
 * number — never "every migration file present"), and exercises D-027's
 * guarantees via real RPC calls over real psql connections — in
 * particular that a mismatched/missing/out-of-policy pairing is
 * rejected by a real Postgres CHECK constraint, not merely by
 * application-layer discipline, which static text review cannot prove.
 *
 * NOT YET RUN. Prepared per explicit instruction; execution requires a
 * separate, later authorization (ZYPACT_M5_0053_RUNTIME_TEST=1 and a
 * real disposable Docker/Supabase/psql stack). This first draft has
 * never been executed against a real Postgres instance — per this
 * repository's own established discipline (every prior M5 runtime
 * harness needed at least one real, opt-in correction round before its
 * first clean pass), at least one such round should be expected before
 * this harness's first real run, not treated as a sign of a defect in
 * the migration itself if it occurs.
 *
 * Safety (same discipline as scripts/test-m5-0052-runtime-contract.ts):
 *   - opt-in only: does nothing unless ZYPACT_M5_0053_RUNTIME_TEST=1.
 *   - no remote credential of any kind; the only connection is to a
 *     disposable local Postgres instance this same run creates.
 *   - never touches staging or Production; never touches any
 *     pre-existing container (in particular, never stops, restarts,
 *     inspects-for-mutation, or removes "zypact-postgres" or any
 *     container this run did not itself create); never runs
 *     `docker ... prune`.
 *   - the disposable project_id/workdir is unique per run (mktemp);
 *     cleanup is scoped exclusively to that exact workdir/project_id
 *     and only runs after full success. On any failure, the stack is
 *     left running and its exact workdir/project_id is printed, and
 *     every scenario's raw stdout/stderr is persisted to disk BEFORE
 *     any cleanup decision is made.
 *   - if Docker, the Supabase CLI, or psql is not available, or if the
 *     local Supabase ports are already occupied, the test prints an
 *     explicit SKIP and exits 0 — it never prints a passing result it
 *     did not actually verify.
 *   - no provider/LLM call of any kind, anywhere in this file.
 *   - selects and applies exactly migrations 0001-0053 by number,
 *     ignoring any 0054+ migration present in the repository — a fixed
 *     historical snapshot, never a guard against 0054 existing.
 *   - every pg_temp helper is created and called within the SAME psql
 *     session/connection, always schema-qualified (pg_temp.<name>),
 *     verified by a static self-inspection preflight before any Docker
 *     command runs.
 *   - every boolean marker captured via \\gset is produced by a real
 *     `case when <expr> then 't' else 'f' end` expression — never a
 *     direct `::text` cast of a native boolean column/expression (which
 *     yields 'true'/'false', not 't'/'f' — the exact defect found and
 *     fixed in a prior M5 0052 runtime round).
 *   - no direct DML mutation is ever attempted under service_role on
 *     protocol_execution_jobs/protocol_attempts/protocol_external_calls/
 *     analysis_call_receipts (all SELECT-only for service_role) — every
 *     mutation goes through a real, granted RPC; constraint-violation
 *     scenarios that need a direct INSERT/UPDATE use a pg_temp
 *     SECURITY DEFINER helper, exactly like every prior M5 runtime
 *     harness.
 *   - every fault-injection scenario runs inside its own BEGIN/ROLLBACK
 *     (or a helper's own internal BEGIN/EXCEPTION block, never
 *     committed) so a deliberately-triggered constraint violation can
 *     never leave the disposable database in a partially-mutated state.
 *
 * Optional environment variables:
 *   ZYPACT_M5_0053_RUNTIME_TEST=1   required opt-in to run anything at all
 *   ZYPACT_DOCKER_BIN_DIR=<path>    prepended to PATH, matching this
 *                                   repo's own local Docker Desktop setup
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "@/lib/evidence/hash";

// Single source of truth for the whole run's verdict. Every check()/
// checkRoster() call updates exactly these four values -- nothing else
// in this file may maintain its own separate pass/fail tally. The
// invariant passedAssertions + failedAssertions === totalAssertions
// holds by construction (every call increments totalAssertions and
// exactly one of the other two) and is asserted explicitly where the
// final verdict is computed.
let totalAssertions = 0;
let passedAssertions = 0;
let failedAssertions = 0;
const failedAssertionNames: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  totalAssertions += 1;
  if (cond) {
    passedAssertions += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failedAssertions += 1;
    failedAssertionNames.push(name);
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(reason: string): never {
  console.log(`\nSKIP: ${reason}`);
  console.log(
    "This is not a failure and not a pass — the runtime contract test\n" +
      "requires explicit opt-in and a local Docker/Supabase/psql stack.\n" +
      "No database was touched, no stack was created."
  );
  process.exit(0);
}

const REPO_ROOT = process.cwd();
const DOCKER_BIN_DIR = process.env.ZYPACT_DOCKER_BIN_DIR ?? "";
const RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: DOCKER_BIN_DIR ? `${DOCKER_BIN_DIR}:${process.env.PATH ?? ""}` : process.env.PATH,
};

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { env: RUN_ENV, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function tryRun(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: run(cmd, args) };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? String((err as { stdout?: string }).stdout ?? err.message) : String(err) };
  }
}

function spawnAsync(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: RUN_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * D-027: pg_temp is session-local -- a helper defined in one psql
 * connection's temp schema is invisible to every other connection, and
 * even within the SAME connection, an unqualified reference to a
 * pg_temp function can fail to resolve (the exact defect found and
 * fixed in the fourth real M5 0052 runtime round). This preflight runs
 * BEFORE any Docker/Supabase/psql command -- pure static self-inspection
 * of this script's own source text -- and fails closed if any callable
 * (non-comment) occurrence of one of the three pg_temp helper names
 * appears without an explicit `pg_temp.` prefix, or if any helper is
 * missing its own qualified definition or at least one qualified call.
 */
function runHelperQualificationPreflight(): void {
  const selfPath = path.join(REPO_ROOT, "scripts", "test-m5-0053-runtime-contract.ts");
  const source = readFileSync(selfPath, "utf8");
  const helperNames = [
    "_m5_0053_helper_capture_parse_failure_column_violation",
    "_m5_0053_helper_capture_analysis_receipt_request_violation",
    "_m5_0053_acl_probe_run",
  ] as const;

  console.log("\n=== Preflight: pg_temp helper qualification (static self-inspection, before any Docker command) ===");

  const lines = source.split("\n");
  let failed = false;
  const definitionFound = new Map<string, boolean>(helperNames.map((n) => [n, false]));
  const callFound = new Map<string, boolean>(helperNames.map((n) => [n, false]));

  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    const commentIdx = rawLine.indexOf("--");
    for (const name of helperNames) {
      let from = 0;
      for (;;) {
        const at = rawLine.indexOf(name, from);
        if (at === -1) break;
        from = at + name.length;

        const insideComment = commentIdx !== -1 && commentIdx < at;
        if (insideComment) continue;

        const charBeforeMatch = at > 0 ? rawLine[at - 1] : "";
        if (charBeforeMatch === '"' || charBeforeMatch === "'") continue;

        const precedingSlice = rawLine.slice(Math.max(0, at - 8), at);
        const isQualified = precedingSlice === "pg_temp.";
        if (!isQualified) {
          failed = true;
          console.log(`  ✗ UNQUALIFIED callable occurrence at line ${lineNumber}: ${rawLine.trim()}`);
          continue;
        }

        const beforeQualifier = rawLine.slice(0, at - 8);
        if (/create function\s*$/.test(beforeQualifier)) definitionFound.set(name, true);
        // Two legitimate call shapes appear in this file: a set-
        // returning helper used in a FROM clause, and a bare
        // "select <qualified-name>(...)" statement invoking a void-
        // returning helper directly (the ACL-probe wrapper's own shape).
        if (/\b(from|select)\s*$/.test(beforeQualifier)) callFound.set(name, true);
      }
    }
  });

  for (const name of helperNames) {
    if (!definitionFound.get(name)) {
      failed = true;
      console.log(`  ✗ MISSING: no qualified "create function pg_temp.${name}(" definition found`);
    }
    if (!callFound.get(name)) {
      failed = true;
      console.log(`  ✗ MISSING: no qualified call ("... from pg_temp.${name}(") found`);
    }
  }

  if (failed) {
    console.log("\n✗ FATAL: helper-qualification preflight failed -- see occurrences above. No Docker command will run.");
    process.exit(1);
  }
  console.log(
    `✓ All three pg_temp helpers: every callable occurrence across ${lines.length} lines is schema-qualified; each has a qualified definition and at least one qualified call.\n`
  );
}

/**
 * The exact defect proven by this harness's first real run: a `select ...
 * as X from rpc(...);` statement that ends in a bare `;` instead of
 * `\gset` never actually sets the psql variable X -- a later `\echo
 * '##R## X' :X` then prints the literal, unsubstituted text `:X`, which
 * can never equal the expected status string, so the check silently
 * fails for the wrong reason. This preflight statically re-derives, for
 * every psql script embedded in this file's own source text, which
 * variables are genuinely defined (via a `\gset`-terminated statement)
 * before each `\echo` marker that references them -- exactly mirroring
 * real psql session semantics (variables reset at the start of a new
 * script, since each is a separate `psql -f` invocation/connection; a
 * `\pset pager off` line, present verbatim at the top of every script in
 * this file, marks that boundary).
 */
function runGsetMarkerPreflight(): void {
  console.log("\n=== Preflight: every marker-referenced psql variable is genuinely set via \\gset in its own script (static self-inspection, before any Docker command) ===");

  function checkGsetUsage(text: string): string[] {
    const lines = text.split("\n");
    // Maps each defined name to the line number of its FIRST \gset
    // definition in the current script -- not just a boolean "is it
    // defined". This is what lets a genuine redefinition be reported
    // with its original definition site, and is what makes the
    // redefinition-ban below meaningful rather than a mere flag.
    let defined = new Map<string, number>();
    let statementBuffer: string[] = [];
    const violations: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed === "\\\\pset pager off") {
        // A new psql script/connection begins here -- prior variables do
        // not carry over (each script is its own separate connection).
        defined = new Map<string, number>();
        statementBuffer = [];
        continue;
      }
      statementBuffer.push(line);
      if (trimmed.endsWith("\\\\gset")) {
        const buf = statementBuffer.join("\n");
        const aliasRe = /\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
        let m: RegExpExecArray | null;
        while ((m = aliasRe.exec(buf)) !== null) {
          const name = m[1]!;
          // A variable name genuinely re-\gset within the SAME
          // connection is banned outright, not merely tolerated: psql
          // variables are not transaction-scoped (they survive
          // ROLLBACK), so a second \gset for the same name would leave
          // an earlier, still-defined value able to silently mask a
          // later capture whose own \gset was actually forgotten --
          // exactly the loophole a plain "is it defined anywhere in
          // this script" check cannot see. Requiring every name to be
          // \gset exactly once per connection closes it structurally,
          // for every future edit, not merely for the names audited
          // today.
          const firstDefinedAtLine = defined.get(name);
          if (firstDefinedAtLine !== undefined) {
            violations.push(
              `line ${i + 1}: "${name}" is \\gset a second time in this same script (first defined at line ${firstDefinedAtLine}) -- a redefinition could mask a later, genuinely missing \\gset for this name`
            );
            continue;
          }
          defined.set(name, i + 1);
        }
        statementBuffer = [];
        continue;
      }
      if (trimmed.includes("\\\\echo")) {
        const varRe = /:(?:'([a-zA-Z_][a-zA-Z0-9_]*)'|([a-zA-Z_][a-zA-Z0-9_]*))/g;
        let m: RegExpExecArray | null;
        while ((m = varRe.exec(line)) !== null) {
          const varName = m[1] ?? m[2]!;
          if (!defined.has(varName)) {
            violations.push(`line ${i + 1}: marker references :${varName}, which was never set via \\gset in this same script -- ${trimmed}`);
          }
        }
        statementBuffer = [];
        continue;
      }
      if (trimmed.endsWith(";")) statementBuffer = [];
    }
    return violations;
  }

  const source = readFileSync(path.join(REPO_ROOT, "scripts", "test-m5-0053-runtime-contract.ts"), "utf8");

  // Negative self-test: take a real, currently-correct \gset-terminated
  // capture verbatim out of this file's own text and strip only its
  // trailing "\gset" (replacing it with ";", the same terminator a
  // broken capture actually uses) in a throwaway in-memory copy -- never
  // written to disk -- then confirm the checker genuinely reports that
  // capture's own marker variable as a violation. This proves the
  // checker actually detects a broken capture before it is trusted on
  // the real file below; without this, a checker that always reports
  // "no violations" would pass on either file with no evidence of
  // functioning at all.
  const anchor = "as old_analysis_receipt_absent \\\\gset";
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    console.log("\n✗ FATAL: gset preflight self-test anchor text not found in this file -- cannot prove the checker actually detects a broken capture. No Docker command will run.");
    process.exit(1);
  }
  const brokenCopy = source.slice(0, anchorIdx) + "as old_analysis_receipt_absent;" + source.slice(anchorIdx + anchor.length);
  const selfTestViolations = checkGsetUsage(brokenCopy);
  const selfTestDetected = selfTestViolations.some((v) => v.includes(":old_analysis_receipt_absent"));
  if (!selfTestDetected) {
    console.log("\n✗ FATAL: gset preflight self-test did NOT detect a deliberately broken capture (one \\gset removed) -- refusing to trust this checker on the real file. No Docker command will run.");
    console.log(`Self-test violations found: ${JSON.stringify(selfTestViolations)}`);
    process.exit(1);
  }
  console.log("✓ gset preflight self-test: a deliberately broken in-memory copy (one \\gset stripped from a known-good capture) was correctly detected as failing.");

  const realViolations = checkGsetUsage(source);
  if (realViolations.length > 0) {
    console.log(`\n✗ FATAL: ${realViolations.length} marker-referenced psql variable(s) are never set via \\gset in their own script:`);
    for (const v of realViolations) console.log(`  - ${v}`);
    console.log("No Docker command will run.");
    process.exit(1);
  }
  console.log(
    "✓ Every marker-referenced psql variable across every script in this file is genuinely set via \\gset in that same script.\n"
  );
}

/**
 * Static, source-level proof that the five cleanup-sequence steps inside
 * main()'s try block appear in the required lexical order:
 *   SEQGATE:ASSERTIONS < SEQGATE:PRECLEANUP_CHECK < SEQGATE:SUPABASE_STOP
 *   < SEQGATE:POSTSTOP_CHECK < SEQGATE:RMSYNC
 * Each is a unique, one-off comment anchor immediately preceding its own
 * real step. This does not re-derive control flow (a general lexical
 * ordering proof for arbitrary JS would need real static analysis); it
 * proves the specific, narrow property this file's own five-step cleanup
 * sequence actually needs: that these five markers -- and so the code
 * immediately following each -- occur in file order in exactly this
 * sequence, so a future edit that reordered the steps (e.g. moving the
 * pre-cleanup identity gate to after `supabase stop`) would be caught
 * here, before any Docker command ever runs.
 */
function runCleanupSequencePreflight(): void {
  console.log("\n=== Preflight: cleanup sequence order (assertion gate < pre-cleanup check < supabase stop < post-stop check < rmSync) -- static self-inspection, before any Docker command ===");

  const ANCHORS = [
    "SEQGATE:ASSERTIONS",
    "SEQGATE:PRECLEANUP_CHECK",
    "SEQGATE:SUPABASE_STOP",
    "SEQGATE:POSTSTOP_CHECK",
    "SEQGATE:RMSYNC",
  ] as const;

  // Scoped to start searching only from main()'s own definition onward,
  // specifically so this function's OWN source text (which necessarily
  // contains these same five anchor strings, as the literal array above)
  // can never be mistaken for the real anchors it is looking for --
  // those live later in the file, inside main()'s try block.
  // Deliberately split across a concatenation: a contiguous copy of this
  // exact literal would itself appear inside THIS function's own source
  // (right here, if written as one string) -- which would make
  // `text.indexOf(MAIN_FN_MARKER)` find ITS OWN definition line instead
  // of the real main() declaration below, since this function is defined
  // earlier in the file. Splitting the literal means the full,
  // contiguous substring exists in exactly one place in this file: the
  // real main() declaration.
  const MAIN_FN_MARKER = "async function ma" + "in(): Promise<void> {";

  function checkOrder(text: string): string[] {
    const violations: string[] = [];
    const mainFnStart = text.indexOf(MAIN_FN_MARKER);
    if (mainFnStart === -1) {
      return [`anchor "${MAIN_FN_MARKER}" not found -- cannot scope the search to main()'s own body`];
    }
    const positions = ANCHORS.map((a) => ({ anchor: a, idx: text.indexOf(a, mainFnStart) }));
    for (const p of positions) {
      if (p.idx === -1) violations.push(`anchor "${p.anchor}" not found inside main()'s body`);
    }
    if (violations.length > 0) return violations;
    for (let i = 1; i < positions.length; i++) {
      if (positions[i]!.idx <= positions[i - 1]!.idx) {
        violations.push(
          `"${positions[i]!.anchor}" (at index ${positions[i]!.idx}) must appear strictly AFTER "${positions[i - 1]!.anchor}" (at index ${positions[i - 1]!.idx}), but does not`
        );
      }
    }
    return violations;
  }

  const source = readFileSync(path.join(REPO_ROOT, "scripts", "test-m5-0053-runtime-contract.ts"), "utf8");

  // Negative self-test: swap the PRECLEANUP_CHECK and SUPABASE_STOP
  // anchors in a throwaway in-memory copy (never written to disk) --
  // simulating exactly the regression this preflight exists to catch,
  // the pre-cleanup identity gate moved to after the stop command -- and
  // confirm the checker reports it before trusting it on the real file.
  const PRE = "SEQGATE:PRECLEANUP_CHECK";
  const STOP = "SEQGATE:SUPABASE_STOP";
  const PLACEHOLDER = "\u0000SEQGATE_SELFTEST_PLACEHOLDER\u0000";
  const brokenCopy = source.split(PRE).join(PLACEHOLDER).split(STOP).join(PRE).split(PLACEHOLDER).join(STOP);
  const selfTestViolations = checkOrder(brokenCopy);
  if (selfTestViolations.length === 0) {
    console.log(
      "\n✗ FATAL: cleanup-sequence preflight self-test did NOT detect a deliberately reordered copy (pre-cleanup check swapped to after supabase stop) -- refusing to trust this checker on the real file. No Docker command will run."
    );
    process.exit(1);
  }
  console.log(
    "✓ cleanup-sequence preflight self-test: a deliberately reordered in-memory copy (pre-cleanup check swapped to after supabase stop) was correctly detected as failing."
  );

  const realViolations = checkOrder(source);
  if (realViolations.length > 0) {
    console.log("\n✗ FATAL: cleanup sequence order violated in the real file:");
    for (const v of realViolations) console.log(`  - ${v}`);
    console.log("No Docker command will run.");
    process.exit(1);
  }
  console.log(
    "✓ Cleanup sequence order confirmed: assertion gate < pre-cleanup check < supabase stop < post-stop check < rmSync.\n"
  );
}

async function main(): Promise<void> {
  console.log("=== M5 0053 — real runtime contract test for D-027 (analysis parse-failure ledger, raw_request_body) ===\n");

  console.log(`Repo:   ${REPO_ROOT}`);
  try {
    console.log(`Branch: ${run("git", ["branch", "--show-current"]).trim()}`);
    console.log(`HEAD:   ${run("git", ["rev-parse", "HEAD"]).trim()}`);
  } catch {
    console.log("(git branch/HEAD unavailable — continuing; this does not affect stack safety)");
  }

  if (process.env.ZYPACT_M5_0053_RUNTIME_TEST !== "1") {
    skip(
      "ZYPACT_M5_0053_RUNTIME_TEST is not set to \"1\". Set it explicitly to run this test " +
        "(e.g. ZYPACT_M5_0053_RUNTIME_TEST=1 npx tsx scripts/test-m5-0053-runtime-contract.ts). " +
        "Optionally set ZYPACT_DOCKER_BIN_DIR if Docker's CLI is not already on PATH."
    );
  }

  // ------------------------------------------------------------------
  // 1. Fixed historical snapshot: this harness applies EXACTLY
  //    migrations 0001 through 0053, explicitly selected by number
  //    below, regardless of how many later migrations exist in the
  //    repository. This is D-027's own reproducible contract test,
  //    frozen at 0053 — it is not a guard against 0054 existing.
  // ------------------------------------------------------------------
  const migrationsDirCheck = path.join(REPO_ROOT, "supabase", "migrations");
  console.log(
    `Confirmed: this harness selects migrations 0001-0053 explicitly by number from ${migrationsDirCheck} (0054+ present or not, ignored either way).\n`
  );

  runHelperQualificationPreflight();
  runGsetMarkerPreflight();
  runCleanupSequencePreflight();

  const dockerVersion = tryRun("docker", ["version"]);
  if (!dockerVersion.ok) skip("Docker is not available (`docker version` failed). No stack created, no database touched.");
  const supabaseVersion = tryRun("supabase", ["--version"]);
  if (!supabaseVersion.ok) skip("The Supabase CLI is not available (`supabase --version` failed). No stack created.");
  const psqlVersion = tryRun("psql", ["--version"]);
  if (!psqlVersion.ok) skip("psql is not available (`psql --version` failed). No stack created.");
  console.log("Docker, Supabase CLI, and psql all detected — proceeding.\n");

  const requiredPorts = [54321, 54322, 54323, 54324];
  for (const port of requiredPorts) {
    const probe = tryRun("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"]);
    if (probe.ok && probe.output.trim().length > 0) {
      console.log(`\n✗ FATAL: local port ${port} is already occupied — refusing to start a disposable stack that could collide.`);
      console.log(probe.output);
      process.exit(1);
    }
  }
  console.log("Confirmed: local Supabase ports (54321-54324) are free.\n");

  const preexistingContainers = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Pre-existing containers recorded (${preexistingContainers.length}): will not be touched.`);

  function captureZypactPostgresIdentity(): string | null {
    if (!preexistingContainers.includes("zypact-postgres")) return null;
    const core = run("docker", [
      "inspect",
      "zypact-postgres",
      "--format",
      "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Health.Status}}",
    ]).trim();
    const ports = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .NetworkSettings.Ports}}"]).trim();
    const networks = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .NetworkSettings.Networks}}"]).trim();
    const mounts = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .Mounts}}"]).trim();
    const labels = run("docker", ["inspect", "zypact-postgres", "--format", "{{json .Config.Labels}}"]).trim();
    return `${core}|${ports}|${networks}|${mounts}|${labels}`;
  }

  const zypactPostgresBaseline = captureZypactPostgresIdentity();
  if (zypactPostgresBaseline !== null) {
    console.log("zypact-postgres baseline captured (ID/StartedAt/RestartCount/health/ports/network/mounts/labels).");
  } else {
    console.log("zypact-postgres is not present in this environment — that specific check will be skipped, not faked.");
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0053-runtime-"));
  const projectId = path.basename(workdir);
  console.log(`Disposable workdir: ${workdir}`);
  console.log(`Disposable project_id: ${projectId}`);

  let stackStarted = false;
  let succeededFully = false;

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);

    const configPath = path.join(workdir, "supabase", "config.toml");
    const config = readFileSync(configPath, "utf8").replace(
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = true",
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = false"
    );
    writeFileSync(configPath, config);
    check("seed is disabled in the disposable project's config.toml", config.includes("enabled = false"));

    const linkedProjectPath = path.join(workdir, "supabase", ".temp", "linked-project.json");
    check("no linked-project.json exists in the disposable project (never linked, never staging)", !existsSync(linkedProjectPath));

    const sourceMigrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
    const destMigrationsDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(destMigrationsDir, { recursive: true });
    const migrationFiles = readdirSync(sourceMigrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const m = /^(\d{4})_/.exec(f);
        return m !== null && Number(m[1]) <= 53;
      });
    check(
      "exactly migrations numbered 0001-0053 are selected -- 0054 and any later migration are excluded by explicit number",
      migrationFiles.every((f) => {
        const m = /^(\d{4})_/.exec(f);
        return m !== null && Number(m[1]) <= 53;
      })
    );
    for (const f of migrationFiles) {
      copyFileSync(path.join(sourceMigrationsDir, f), path.join(destMigrationsDir, f));
    }
    const byteIdentical = migrationFiles.every(
      (f) => readFileSync(path.join(sourceMigrationsDir, f)).equals(readFileSync(path.join(destMigrationsDir, f)))
    );
    check(
      `all ${migrationFiles.length} migrations (0001-0053) copied byte-identically`,
      byteIdentical &&
        migrationFiles.some((f) => f.includes("0052_m5")) &&
        migrationFiles.some((f) => f.includes("0053_m5"))
    );

    console.log("\nStarting the disposable Supabase stack (first run may pull Docker images)...");
    run("supabase", ["start", "--workdir", workdir]);
    stackStarted = true;
    console.log("Stack started.\n");

    const statusOutput = run("supabase", ["status", "--workdir", workdir, "-o", "env"]);
    const dbUrlMatch = statusOutput.match(/DB_URL="([^"]+)"/);
    if (!dbUrlMatch) throw new Error("Could not parse DB_URL from `supabase status` output.");
    const dbUrl = dbUrlMatch[1]!;

    await runScenarios(dbUrl, workdir);

    // SEQGATE:ASSERTIONS -- single global verdict gate, computed strictly
    // from the one source of truth (totalAssertions/passedAssertions/
    // failedAssertions/failedAssertionNames) -- no scenario-local cleanup
    // decision is permitted to run ahead of this point. The invariant
    // below is mechanically true by construction (check() increments
    // exactly one of passedAssertions/failedAssertions alongside
    // totalAssertions on every call) -- asserted explicitly here so a
    // future edit that broke it would fail loudly rather than silently
    // drift.
    if (passedAssertions + failedAssertions !== totalAssertions) {
      throw new Error(
        `counter invariant violated: passedAssertions (${passedAssertions}) + failedAssertions (${failedAssertions}) !== totalAssertions (${totalAssertions}) -- refusing to trust the verdict.`
      );
    }
    if (failedAssertions > 0) {
      throw new Error(
        `${failedAssertions}/${totalAssertions} assertions failed -- refusing to clean up the disposable stack or any scenario fixture. Failed assertions: ${JSON.stringify(failedAssertionNames)}`
      );
    }

    // SEQGATE:PRECLEANUP_CHECK -- re-capture zypact-postgres's full
    // identity a SECOND time (the first was the baseline, taken before
    // this run touched anything), strictly BEFORE any `supabase stop` or
    // `rmSync` is ever issued. This is a real gate, not a diagnostic:
    // any divergence throws here, before cleanup, leaving the disposable
    // stack and workdir fully intact -- unlike a check() call (which
    // only records a pass/fail data point), this comparison can and does
    // block the cleanup path that follows it.
    if (zypactPostgresBaseline !== null) {
      const preCleanupCapture = captureZypactPostgresIdentity();
      if (preCleanupCapture !== zypactPostgresBaseline) {
        throw new Error(
          "zypact-postgres identity changed BEFORE any cleanup was attempted (pre-cleanup gate) -- refusing to run `supabase stop` or remove the workdir. The disposable stack and workdir are preserved for inspection."
        );
      }
    }

    console.log("\nAll assertions passed and zypact-postgres identity confirmed unchanged pre-cleanup — stopping the disposable stack (workdir not yet removed).");
    // SEQGATE:SUPABASE_STOP -- only the disposable stack is stopped here;
    // the workdir itself is deliberately NOT removed yet, so that if the
    // post-stop identity check below finds a divergence, the workdir
    // still exists to preserve for inspection.
    run("supabase", ["stop", "--workdir", workdir, "--no-backup"]);

    // SEQGATE:POSTSTOP_CHECK -- re-capture zypact-postgres's identity a
    // THIRD time, now that the disposable stack has actually been
    // stopped, before the workdir is removed. `supabase stop` itself
    // touches only this run's own disposable containers (identified by
    // this run's own workdir/project_id), never zypact-postgres -- this
    // proves that held even after the stop command actually ran, not
    // merely before it. Any divergence throws here; the workdir is
    // preserved (never removed) and the error is never swallowed.
    if (zypactPostgresBaseline !== null) {
      const postStopCapture = captureZypactPostgresIdentity();
      if (postStopCapture !== zypactPostgresBaseline) {
        throw new Error(
          "zypact-postgres identity changed AFTER `supabase stop` (post-stop gate) -- the workdir is preserved; refusing to remove it."
        );
      }
    }

    // SEQGATE:RMSYNC -- only reached once every assertion passed, the
    // pre-cleanup identity gate passed, `supabase stop` itself completed
    // without throwing, and the post-stop identity gate also passed.
    rmSync(workdir, { recursive: true, force: true });
    console.log(`Removed disposable workdir: ${workdir}`);
    succeededFully = true;
  } finally {
    if (!succeededFully && stackStarted) {
      console.log("\n✗ FAILURE — the disposable stack is PRESERVED for inspection, not cleaned up.");
      console.log(`  workdir:     ${workdir}`);
      console.log(`  project_id:  ${projectId}`);
      console.log(`  To inspect:  docker ps -a --filter label=com.supabase.cli.project=${projectId}`);
      console.log(`  To stop it:  supabase stop --workdir ${workdir} --no-backup`);
    } else if (!succeededFully) {
      console.log(`\n✗ FAILURE before the stack was started. Workdir left in place for inspection: ${workdir}`);
    }

    const stillPresent = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    check(
      "every pre-existing container is still present, untouched, by name",
      preexistingContainers.every((name) => stillPresent.includes(name))
    );
    if (zypactPostgresBaseline !== null) {
      const after = captureZypactPostgresIdentity();
      check(
        "zypact-postgres identity (ID/StartedAt/RestartCount/health/ports/network/mounts/labels) unchanged -- final, unconditional diagnostic re-check regardless of exit path (the pre-cleanup and post-stop gates below are the ones that actually block cleanup on divergence)",
        after === zypactPostgresBaseline
      );
    }

    console.log(
      `\n${passedAssertions}/${totalAssertions} checks passed. ` +
        (failedAssertions === 0 ? "M5 0053 runtime contract PASSED." : "M5 0053 runtime contract FAILED.")
    );
    if (failedAssertions > 0) {
      console.log(`Failed assertions (${failedAssertions}): ${JSON.stringify(failedAssertionNames)}`);
    }
    process.exit(failedAssertions === 0 ? 0 : 1);
  }

  async function runScenarios(dbUrl: string, workdirForScript: string): Promise<void> {
    await runScenariosImpl(dbUrl, workdirForScript, check, RUN_ENV);
  }
}

// ----------------------------------------------------------------------
// Scenario execution.
// ----------------------------------------------------------------------

type CheckFn = (name: string, cond: boolean, detail?: string) => void;

function parseMarkers(output: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^##R##\s+(\S+)\s+(.*)$/);
    if (m) results.set(m[1]!, m[2]!.trim());
  }
  return results;
}

const HELPER_SQL = `
create or replace function public._m5_0053_runtime_helper_make_fixture(
  p_label text,
  p_retry_cap integer default 2,
  p_spend_cap_usd numeric default 100.00,
  p_existing_project_id uuid default null
) returns table (project_id uuid, protocol_id uuid) language plpgsql as $f$
declare
  v_project_id uuid;
  v_bq_id uuid;
  v_bqv_id uuid;
  v_protocol_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
begin
  if p_existing_project_id is null then
    insert into projects (domain, company_name) values ('m5-0053-runtime-' || p_label || '.test', 'M5 0053 Runtime ' || p_label)
      returning id into v_project_id;
  else
    v_project_id := p_existing_project_id;
  end if;
  insert into buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, 'fixture prompt for ' || p_label, 'hash-m5-0053-runtime-' || p_label,
    'shortlist', 4, 3, 10, 'm5 0053 runtime contract fixture', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from approve_buyer_question_version(v_bqv_id, v_project_id, v_actor);
  insert into protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    1, 0, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', 20, p_spend_cap_usd, 3600,
    1000, 50, p_retry_cap
  ) returning id into v_protocol_id;
  perform status from approve_protocol(v_protocol_id, v_project_id, v_actor);
  return query select v_project_id, v_protocol_id;
end;
$f$;
grant execute on function public._m5_0053_runtime_helper_make_fixture(text, integer, numeric, uuid) to service_role;

\\echo '##R## helper_installed ok'
`;

async function runScenariosImpl(dbUrl: string, workdir: string, check: CheckFn, runEnv: NodeJS.ProcessEnv): Promise<void> {
  const scratchDir = path.join(workdir, "runtime-scripts");
  mkdirSync(scratchDir, { recursive: true });

  // Uses spawnSync (never execFileSync) specifically because execFileSync
  // NEVER exposes stderr in its return value on a zero exit code -- by
  // default it inherits stderr straight to the parent's own stderr
  // (confirmed empirically: a bash child printing to both streams and
  // exiting 0 returns only stdout from execFileSync, with the stderr
  // text appearing directly in the console, never captured into any JS
  // string). spawnSync's result object always exposes both stdout and
  // stderr regardless of exit code, without throwing -- exactly what is
  // needed to guarantee both streams are persisted to disk for every
  // scenario, success or failure. Persistence happens here,
  // unconditionally, before "stop" mode is allowed to throw.
  function runPsql(scriptPath: string, onError: "stop" | "continue", outBaseName: string): { stdout: string; stderr: string } {
    const result = spawnSync(
      "psql",
      [dbUrl, "-X", "-q", "-v", `ON_ERROR_STOP=${onError === "stop" ? 1 : 0}`, "-f", scriptPath],
      { env: runEnv, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
    );
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? (result.error ? String(result.error) : "");
    writeFileSync(path.join(scratchDir, `${outBaseName}.out.log`), stdout);
    writeFileSync(path.join(scratchDir, `${outBaseName}.err.log`), stderr);
    if (onError === "stop" && (result.status !== 0 || result.error)) {
      throw new Error(
        `psql exited ${result.status ?? "<no status>"} running ${scriptPath} (this script is expected to always succeed) -- see ${outBaseName}.out.log / ${outBaseName}.err.log for the full, already-persisted output.`
      );
    }
    return { stdout, stderr };
  }

  // Guarantees stdout/stderr are ALWAYS persisted to disk, success or
  // failure, before any cleanup decision -- same technique the M5 0052
  // harness adopted after its own observability-gap round.
  async function runPsqlCapturedAsync(
    scriptPath: string,
    outBaseName: string
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const result = await spawnAsync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath]);
    writeFileSync(path.join(scratchDir, `${outBaseName}.out.log`), result.stdout);
    writeFileSync(path.join(scratchDir, `${outBaseName}.err.log`), result.stderr);
    if (result.code !== 0) {
      console.log(
        `  (note: ${outBaseName} exited with code ${result.code} -- full stdout/stderr saved to ${outBaseName}.out.log/.err.log; evaluation continues with whatever markers were captured)`
      );
    }
    return result;
  }

  writeFileSync(path.join(scratchDir, "00-helper.sql"), HELPER_SQL);
  runPsql(path.join(scratchDir, "00-helper.sql"), "stop", "00-helper");

  // ======================================================================
  // D-027 behavioral roster: the fixed, exhaustive list of named
  // assertions this harness owes for mark_analysis_parse_failed_for_job /
  // retry_analysis_generation_for_job / the raw_request_body policy /
  // monitoring / rollback-completeness -- covering all 11 statuses, every
  // NOT_ELIGIBLE sub-condition individually, mock/real, concurrency
  // (single repair child), both caps, and rollback. Comments are not
  // tests -- every one of these names is bound to a real, executed
  // assertion below; none is left as documentation only. Modeled directly
  // on S6_ASSERTION_NAMES / checkS6 in scripts/test-m5-0052-runtime-
  // contract.ts: roster-membership and no-reuse are enforced when the
  // name is used, and a completeness pass at the end of this function
  // confirms every declared name was used exactly once.
  // ======================================================================
  const ROSTER_NAMES = [
    "status_job_not_found",
    "status_job_not_owned",
    "status_not_current_attempt",
    "status_wrong_call_kind",
    "status_not_eligible_unsent",
    "status_not_eligible_sent",
    "status_source_not_eligible_before_mark",
    "status_marked",
    "marked_has_timestamp",
    "marked_code_exact",
    "status_already_marked",
    "status_parse_failure_code_conflict",
    "status_current_attempt_not_found_fi",
    "catalog_identical_after_fi_current_attempt",
    "status_probe_result_already_exists_mark",
    "status_probe_result_already_exists_retry",
    "status_source_not_authoritative_generation",
    "status_not_eligible_attempt_probe_run_null",
    "status_not_eligible_call_probe_run_null_fi",
    "status_not_eligible_mismatch_call_attempt",
    "status_not_eligible_receipt_absent_fi",
    "status_not_eligible_receipt_outcome_non_success_fi",
    "status_not_eligible_receipt_project_mismatch_fi",
    "catalog_identical_after_fi_receipt_project",
    "mock_true_body_hash_null_accepted",
    "mock_false_body_hash_null_rejected",
    "body_hash_exact_accepted_roundtrip",
    "status_repair_reserved",
    "repair_generation_is_2",
    "status_already_retried_same_cost",
    "status_source_already_retried_diff_cost",
    "repair_child_id_stable_across_replays",
    "retry_cap_exceeded_on_repair_branch",
    "spend_cap_exceeded_on_repair_branch",
    "monitoring_counts_parse_failure_scalar",
    "monitoring_exposes_no_raw_column",
    "rollback_leaves_no_trace",
    // D-027 corrective pass: real two-connection concurrency for
    // retry_analysis_generation_for_job's repair branch (see Part N).
    "race_distinct_backend_pids",
    "race_b_observed_waiting_on_lock",
    "race_a_exit_zero",
    "race_b_exit_zero",
    "race_a_status_reserved",
    "race_b_status_already_retried",
    "race_same_child_id",
    "race_exactly_one_child",
    "race_child_generation_is_n_plus_1",
    "race_no_raw_postgres_error",
  ] as const;
  type RosterName = (typeof ROSTER_NAMES)[number];

  {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const n of ROSTER_NAMES) {
      if (seen.has(n)) duplicates.push(n);
      seen.add(n);
    }
    check(
      "preflight: ROSTER_NAMES itself contains no duplicate names -- a real precondition, not a runtime guard alone",
      duplicates.length === 0,
      duplicates.length > 0 ? `duplicates=${JSON.stringify(duplicates)}` : ""
    );
  }

  const rosterUsed = new Set<RosterName>();
  function checkRoster(name: RosterName, cond: boolean, detail = ""): void {
    if (!ROSTER_NAMES.includes(name)) {
      throw new Error(`checkRoster: "${name}" is not a member of ROSTER_NAMES -- add it to the roster first`);
    }
    if (rosterUsed.has(name)) {
      throw new Error(`checkRoster: "${name}" was already used -- every roster assertion name must be used exactly once`);
    }
    rosterUsed.add(name);
    check(`roster.${name}`, cond, detail);
  }

  // ======================================================================
  // Part A — catalog/contract checks.
  // ======================================================================
  const CONTRACT_SQL = `
\\pset pager off
SET ROLE service_role;

select case when to_regprocedure('public.record_analysis_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,integer,numeric,text,text)') is null then 't' else 'f' end as old_analysis_receipt_absent \\gset
select case when to_regprocedure('public.record_analysis_call_receipt_for_job(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,integer,numeric,text,text,text)') is not null then 't' else 'f' end as new_analysis_receipt_present \\gset
select case when to_regprocedure('public.mark_analysis_parse_failed_for_job(uuid,uuid,uuid,uuid,text)') is not null then 't' else 'f' end as mark_parse_failed_present \\gset
select case when to_regprocedure('public.retry_analysis_generation_for_job(uuid,uuid,uuid,uuid,numeric)') is not null then 't' else 'f' end as retry_analysis_present \\gset
\\echo '##R## old_analysis_receipt_absent' :old_analysis_receipt_absent
\\echo '##R## new_analysis_receipt_present' :new_analysis_receipt_present
\\echo '##R## mark_parse_failed_present' :mark_parse_failed_present
\\echo '##R## retry_analysis_present' :retry_analysis_present

select case when count(*) = 1 then 't' else 'f' end as parse_pairing_check_present from pg_constraint where conname = 'protocol_external_calls_parse_failure_pairing_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as parse_code_check_present from pg_constraint where conname = 'protocol_external_calls_parse_failure_code_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as parse_scope_check_present from pg_constraint where conname = 'protocol_external_calls_parse_failure_scope_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as request_pairing_check_present from pg_constraint where conname = 'analysis_call_receipts_request_pairing_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as request_hash_match_check_present from pg_constraint where conname = 'analysis_call_receipts_request_hash_match_check' \\gset
select case when count(*) = 1 then 't' else 'f' end as request_mock_pairing_check_present from pg_constraint where conname = 'analysis_call_receipts_request_mock_pairing_check' \\gset
\\echo '##R## parse_pairing_check_present' :parse_pairing_check_present
\\echo '##R## parse_code_check_present' :parse_code_check_present
\\echo '##R## parse_scope_check_present' :parse_scope_check_present
\\echo '##R## request_pairing_check_present' :request_pairing_check_present
\\echo '##R## request_hash_match_check_present' :request_hash_match_check_present
\\echo '##R## request_mock_pairing_check_present' :request_mock_pairing_check_present

select case when count(*) = 1 then 't' else 'f' end as monitoring_column_present from information_schema.columns
  where table_name = 'protocol_execution_job_monitoring_v1' and column_name = 'analysis_parse_failures_total' \\gset
\\echo '##R## monitoring_column_present' :monitoring_column_present

-- D-027: the view must expose the scalar counter only -- never a raw
-- payload/content column, and never the ledger's own per-row
-- parse_failed_at/parse_failure_code columns directly (only their
-- aggregate). The single expected match is analysis_parse_failures_total
-- itself (which legitimately contains "parse" in its name).
select case when count(*) = 0 then 't' else 'f' end as monitoring_no_raw_column from information_schema.columns
  where table_name = 'protocol_execution_job_monitoring_v1'
    and (column_name ilike '%raw%' or column_name in ('parse_failed_at', 'parse_failure_code')) \\gset
\\echo '##R## monitoring_no_raw_column' :monitoring_no_raw_column
`;
  writeFileSync(path.join(scratchDir, "01-contract.sql"), CONTRACT_SQL);
  const { stdout: contractOutput } = runPsql(path.join(scratchDir, "01-contract.sql"), "stop", "01-contract");
  const contractResults = parseMarkers(contractOutput);
  const c = (label: string) => contractResults.get(label) ?? "<MISSING>";

  check("old 15-arg record_analysis_call_receipt_for_job is genuinely absent from the catalog", c("old_analysis_receipt_absent") === "t");
  check("new 16-arg record_analysis_call_receipt_for_job exists", c("new_analysis_receipt_present") === "t");
  check("mark_analysis_parse_failed_for_job (5-arg) exists", c("mark_parse_failed_present") === "t");
  check("retry_analysis_generation_for_job's signature (5-arg, unchanged) exists", c("retry_analysis_present") === "t");
  check("protocol_external_calls_parse_failure_pairing_check exists", c("parse_pairing_check_present") === "t");
  check("protocol_external_calls_parse_failure_code_check exists", c("parse_code_check_present") === "t");
  check("protocol_external_calls_parse_failure_scope_check exists", c("parse_scope_check_present") === "t");
  check("analysis_call_receipts_request_pairing_check exists", c("request_pairing_check_present") === "t");
  check("analysis_call_receipts_request_hash_match_check exists", c("request_hash_match_check_present") === "t");
  check("analysis_call_receipts_request_mock_pairing_check exists", c("request_mock_pairing_check_present") === "t");
  check("protocol_execution_job_monitoring_v1.analysis_parse_failures_total column exists", c("monitoring_column_present") === "t");
  checkRoster("monitoring_exposes_no_raw_column", c("monitoring_no_raw_column") === "t");

  // ======================================================================
  // Part B — pg_temp violation helpers + ACL proof.
  // ======================================================================
  const BUSINESS_SQL = `
\\pset pager off

-- Direct-UPDATE helper: bypasses service_role's own SELECT-only grant on
-- protocol_external_calls (a real RPC never has a caller-supplied path
-- to violate parse_failed_at/parse_failure_code directly -- this helper
-- exists purely to prove the CHECK constraints are real at the SQL
-- layer, not merely enforced by mark_analysis_parse_failed_for_job's own
-- application logic). Deliberately created BEFORE "SET ROLE service_role"
-- below: a SECURITY DEFINER function's elevated privilege at call time is
-- exactly its OWNER's privilege, fixed at CREATE time by current_user --
-- creating it under service_role would make it service_role-owned, and
-- SECURITY DEFINER would then elevate it to nothing more than
-- service_role's own SELECT-only grant, so its internal UPDATE would
-- fail on a permission error (42501) before ever reaching the CHECK
-- constraint (23514) it exists to prove. Created here, under this
-- connection's own owner/superuser role, its UPDATE genuinely reaches
-- the table and the constraint.
create function pg_temp._m5_0053_helper_capture_parse_failure_column_violation(
  p_external_call_id uuid,
  p_parse_failed_at timestamptz,
  p_parse_failure_code text
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_sqlstate text;
  v_constraint text;
begin
  begin
    update protocol_external_calls
       set parse_failed_at = p_parse_failed_at, parse_failure_code = p_parse_failure_code
     where id = p_external_call_id;
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;
  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_0053_helper_capture_parse_failure_column_violation(uuid, timestamptz, text) from public;
revoke all on function pg_temp._m5_0053_helper_capture_parse_failure_column_violation(uuid, timestamptz, text) from anon;
revoke all on function pg_temp._m5_0053_helper_capture_parse_failure_column_violation(uuid, timestamptz, text) from authenticated;
grant execute on function pg_temp._m5_0053_helper_capture_parse_failure_column_violation(uuid, timestamptz, text) to service_role;

SET ROLE service_role;

create function pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
  p_job_id uuid,
  p_claim_token uuid,
  p_project_id uuid,
  p_external_call_id uuid,
  p_probe_run_id uuid,
  p_outcome text,
  p_used_mock boolean,
  p_request_sha256 text,
  p_raw_request_body text
) returns table (sqlstate_captured text, constraint_captured text)
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_sqlstate text;
  v_constraint text;
begin
  begin
    perform status from record_analysis_call_receipt_for_job(
      p_job_id, p_claim_token, p_project_id, p_external_call_id, p_probe_run_id,
      p_outcome, 'openai', 'gpt-4o-mini', p_used_mock, p_request_sha256, null,
      200, null, null, null, p_raw_request_body
    );
    v_sqlstate := 'NONE';
    v_constraint := null;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name;
  end;
  return query select v_sqlstate, v_constraint;
end;
$f$;
revoke all on function pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(uuid, uuid, uuid, uuid, uuid, text, boolean, text, text) from public;
revoke all on function pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(uuid, uuid, uuid, uuid, uuid, text, boolean, text, text) from anon;
revoke all on function pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(uuid, uuid, uuid, uuid, uuid, text, boolean, text, text) from authenticated;
grant execute on function pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(uuid, uuid, uuid, uuid, uuid, text, boolean, text, text) to service_role;

select to_regprocedure('pg_temp._m5_0053_helper_capture_parse_failure_column_violation(uuid,timestamptz,text)') is not null as preflight_parse_failure_helper \\gset
select to_regprocedure('pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(uuid,uuid,uuid,uuid,uuid,text,boolean,text,text)') is not null as preflight_request_helper \\gset
\\echo '##R## preflight_parse_failure_helper' :preflight_parse_failure_helper
\\echo '##R## preflight_request_helper' :preflight_request_helper

create temp table _m5_0053_acl_probe (label text primary key, sqlstate_captured text);
grant all on _m5_0053_acl_probe to public;

create function pg_temp._m5_0053_acl_probe_run(p_label_prefix text) returns void
language plpgsql
as $f$
begin
  begin
    perform sqlstate_captured from pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', 'provider_error', false, null, null
    );
    insert into _m5_0053_acl_probe values (p_label_prefix || '_request', 'NONE');
  exception when others then
    insert into _m5_0053_acl_probe values (p_label_prefix || '_request', sqlstate);
  end;
  begin
    perform status from mark_analysis_parse_failed_for_job(
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', 'invalid_json'
    );
    insert into _m5_0053_acl_probe values (p_label_prefix || '_mark', 'NONE');
  exception when others then
    insert into _m5_0053_acl_probe values (p_label_prefix || '_mark', sqlstate);
  end;
end;
$f$;
grant execute on function pg_temp._m5_0053_acl_probe_run(text) to public;

SET ROLE anon;
select pg_temp._m5_0053_acl_probe_run('anon');
RESET ROLE;

SET ROLE authenticated;
select pg_temp._m5_0053_acl_probe_run('authenticated');
RESET ROLE;

SET ROLE service_role;
select pg_temp._m5_0053_acl_probe_run('service_role');

select sqlstate_captured as acl_anon_request from _m5_0053_acl_probe where label = 'anon_request' \\gset
select sqlstate_captured as acl_anon_mark from _m5_0053_acl_probe where label = 'anon_mark' \\gset
select sqlstate_captured as acl_authenticated_request from _m5_0053_acl_probe where label = 'authenticated_request' \\gset
select sqlstate_captured as acl_authenticated_mark from _m5_0053_acl_probe where label = 'authenticated_mark' \\gset
select sqlstate_captured as acl_service_role_request from _m5_0053_acl_probe where label = 'service_role_request' \\gset
select sqlstate_captured as acl_service_role_mark from _m5_0053_acl_probe where label = 'service_role_mark' \\gset
\\echo '##R## acl_anon_request' :acl_anon_request
\\echo '##R## acl_anon_mark' :acl_anon_mark
\\echo '##R## acl_authenticated_request' :acl_authenticated_request
\\echo '##R## acl_authenticated_mark' :acl_authenticated_mark
\\echo '##R## acl_service_role_request' :acl_service_role_request
\\echo '##R## acl_service_role_mark' :acl_service_role_mark

-- Negative control: service_role has no direct DML on protocol_external_calls
-- or analysis_call_receipts -- every mutation goes through a granted RPC.
SET ROLE service_role;

-- ======================================================================
-- Part C — direct CHECK constraint violations (parse_failed_at/
--          parse_failure_code pairing, bounded code, scope; raw_
--          request_body pairing, hash-match, used_mock policy).
--          Each fixture ends its own attempt inside BEGIN/ROLLBACK.
--
--          CRITICAL: these scenarios call the two pg_temp helpers defined
--          above, in THIS SAME script/connection. pg_temp is session-
--          local -- a helper created by one "psql -f script.sql"
--          invocation is invisible to a later, separate invocation (a
--          separate connection entirely), even against the same
--          database. All three scenarios below were originally written
--          as separate script files/connections, which would have made
--          every one of these calls fail with "function ... does not
--          exist" (42883) the first time this harness actually ran --
--          found and fixed during this review by keeping them in the
--          same script as the helpers they depend on.
-- ======================================================================
BEGIN;
select project_id as s1_proj, protocol_id as s1_proto from _m5_0053_runtime_helper_make_fixture('s1c') \\gset
select (job).id as s1_job from enqueue_protocol_execution_job(:'s1_proto', :'s1_proj', 3) \\gset
select claim_token as s1_token from claim_protocol_execution_job('worker-s1c', 300) \\gset
select (analysis_call).id as s1_acall from admit_and_reserve_attempt_for_job(:'s1_job', :'s1_token', :'s1_proj', 'baseline', (:'s1_job' || ':baseline:1'), 0.01, 0.01) \\gset

-- pairing violation: timestamp with no code.
select sqlstate_captured as s1_pairing_sqlstate, constraint_captured as s1_pairing_constraint
  from pg_temp._m5_0053_helper_capture_parse_failure_column_violation(:'s1_acall', now(), null) \\gset
-- bounded-code violation: a real timestamp with an out-of-set code.
select sqlstate_captured as s1_code_sqlstate, constraint_captured as s1_code_constraint
  from pg_temp._m5_0053_helper_capture_parse_failure_column_violation(:'s1_acall', now(), 'not_a_real_code') \\gset

\\echo '##R## s1_pairing_sqlstate' :s1_pairing_sqlstate
\\echo '##R## s1_pairing_constraint' :s1_pairing_constraint
\\echo '##R## s1_code_sqlstate' :s1_code_sqlstate
\\echo '##R## s1_code_constraint' :s1_code_constraint
ROLLBACK;

-- Scope violation: this call is still 'reserved' (never sent), yet the
-- helper attempts parse_failed_at directly -- the scope CHECK (call_kind
-- = 'analysis' and status = 'completed') must reject it regardless of
-- the pairing/code CHECKs both being individually satisfied.
SET ROLE service_role;
BEGIN;
select project_id as s2_proj, protocol_id as s2_proto from _m5_0053_runtime_helper_make_fixture('s2c') \\gset
select (job).id as s2_job from enqueue_protocol_execution_job(:'s2_proto', :'s2_proj', 3) \\gset
select claim_token as s2_token from claim_protocol_execution_job('worker-s2c', 300) \\gset
select (analysis_call).id as s2_acall from admit_and_reserve_attempt_for_job(:'s2_job', :'s2_token', :'s2_proj', 'baseline', (:'s2_job' || ':baseline:1'), 0.01, 0.01) \\gset

select sqlstate_captured as s2_scope_sqlstate, constraint_captured as s2_scope_constraint
  from pg_temp._m5_0053_helper_capture_parse_failure_column_violation(:'s2_acall', now(), 'invalid_json') \\gset
\\echo '##R## s2_scope_sqlstate' :s2_scope_sqlstate
\\echo '##R## s2_scope_constraint' :s2_scope_constraint
ROLLBACK;

-- raw_request_body/request_sha256 pairing violation with used_mock=false
-- (raw_request_body null, request_sha256 set) is proven, by direct
-- reading of all three CHECK definitions, to ALSO simultaneously violate
-- analysis_call_receipts_request_mock_pairing_check: that constraint's
-- own used_mock=false branch requires raw_request_body IS NOT NULL,
-- which is false here, and its used_mock=true branch requires used_mock
-- IS TRUE, also false -- so mock_pairing_check's OR is false too. Since
-- Postgres does not guarantee which of several simultaneously-violated
-- CHECK constraints on one table is reported first, a bare pairing-only
-- violation attempt would be non-deterministic as to which constraint
-- name comes back (this exact non-determinism is what made this
-- specific assertion fail unpredictably on this harness's first real
-- run). To prove pairing_check deterministically, this sub-scenario
-- temporarily drops ONLY mock_pairing_check (no CASCADE) inside its own
-- transaction, captures its definition before, performs the identical
-- pairing violation (now only pairing_check can possibly fire),
-- captures SQLSTATE/constraint, then ROLLBACKs -- restoring the dropped
-- constraint atomically -- and a separate query afterward proves the
-- catalog is byte-identical to before.
BEGIN;
select pg_get_constraintdef(oid) as s3_mockcheck_def_before from pg_constraint where conname = 'analysis_call_receipts_request_mock_pairing_check' \\gset

SET ROLE service_role;
select project_id as s3p_proj, protocol_id as s3p_proto from _m5_0053_runtime_helper_make_fixture('s3p') \\gset
select (job).id as s3p_job from enqueue_protocol_execution_job(:'s3p_proto', :'s3p_proj', 3) \\gset
select claim_token as s3p_token from claim_protocol_execution_job('worker-s3p', 300) \\gset
select (attempt).id as s3p_attempt, (analysis_call).id as s3p_acall
  from admit_and_reserve_attempt_for_job(:'s3p_job', :'s3p_token', :'s3p_proj', 'baseline', (:'s3p_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s3p_job', :'s3p_token', :'s3p_proj', :'s3p_attempt', 'perplexity', 'simulated');
select probe_run_id as s3p_probe_run from protocol_attempts where id = :'s3p_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s3p_job', :'s3p_token', :'s3p_proj', :'s3p_acall', :'s3p_probe_run');
RESET ROLE;

ALTER TABLE public.analysis_call_receipts DROP CONSTRAINT analysis_call_receipts_request_mock_pairing_check;

SET ROLE service_role;
select sqlstate_captured as s3_pairing_sqlstate, constraint_captured as s3_pairing_constraint
  from pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
    :'s3p_job', :'s3p_token', :'s3p_proj', :'s3p_acall', :'s3p_probe_run', 'provider_error', false, '${"a".repeat(64)}', null
  ) \\gset
RESET ROLE;

ROLLBACK;

select pg_get_constraintdef(oid) as s3_mockcheck_def_after from pg_constraint where conname = 'analysis_call_receipts_request_mock_pairing_check' \\gset

\\echo '##R## s3_pairing_sqlstate' :s3_pairing_sqlstate
\\echo '##R## s3_pairing_constraint' :s3_pairing_constraint
\\echo '##R## s3_mockcheck_def_before' :s3_mockcheck_def_before
\\echo '##R## s3_mockcheck_def_after' :s3_mockcheck_def_after

-- Separate, fresh transaction/fixture for the two remaining, already-
-- isolated sub-tests below (each independently proven, by the same
-- direct-reading method above, to violate exactly one constraint: a
-- hash mismatch with a real, non-null body leaves both pairing_check
-- and mock_pairing_check satisfied; used_mock=true with both fields
-- present leaves pairing_check and hash_match_check satisfied) -- these
-- do not need mock_pairing_check dropped at all.
SET ROLE service_role;
BEGIN;
select project_id as s3_proj, protocol_id as s3_proto from _m5_0053_runtime_helper_make_fixture('s3c') \\gset
select (job).id as s3_job from enqueue_protocol_execution_job(:'s3_proto', :'s3_proj', 3) \\gset
select claim_token as s3_token from claim_protocol_execution_job('worker-s3c', 300) \\gset
select (attempt).id as s3_attempt, (analysis_call).id as s3_acall
  from admit_and_reserve_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', 'baseline', (:'s3_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_attempt', 'perplexity', 'simulated');
select probe_run_id as s3_probe_run from protocol_attempts where id = :'s3_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run');

-- hash mismatch: real body, wrong hash.
select sqlstate_captured as s3_hashmismatch_sqlstate, constraint_captured as s3_hashmismatch_constraint
  from pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run', 'provider_error', false, '${"0".repeat(64)}', 'the real request body'
  ) \\gset
\\echo '##R## s3_hashmismatch_sqlstate' :s3_hashmismatch_sqlstate
\\echo '##R## s3_hashmismatch_constraint' :s3_hashmismatch_constraint

-- used_mock=true WITH request fields -- must be rejected by the policy
-- CHECK even though pairing/hash-match both individually hold.
select sqlstate_captured as s3_mockpolicy_sqlstate, constraint_captured as s3_mockpolicy_constraint
  from pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run', 'provider_error', true, '${sha256Hex("mocked body")}', 'mocked body'
  ) \\gset
\\echo '##R## s3_mockpolicy_sqlstate' :s3_mockpolicy_sqlstate
\\echo '##R## s3_mockpolicy_constraint' :s3_mockpolicy_constraint

-- used_mock=false with NEITHER field -- must also be rejected by the
-- policy CHECK (the "always durable when real" half of the policy).
select sqlstate_captured as s3_mockpolicy2_sqlstate, constraint_captured as s3_mockpolicy2_constraint
  from pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation(
    :'s3_job', :'s3_token', :'s3_proj', :'s3_acall', :'s3_probe_run', 'provider_error', false, null, null
  ) \\gset
\\echo '##R## s3_mockpolicy2_sqlstate' :s3_mockpolicy2_sqlstate
\\echo '##R## s3_mockpolicy2_constraint' :s3_mockpolicy2_constraint
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "02-business-and-column-checks.sql"), BUSINESS_SQL);
  const { stdout: businessOutput } = runPsql(path.join(scratchDir, "02-business-and-column-checks.sql"), "continue", "02-business-and-column-checks");
  const r = (label: string) => parseMarkers(businessOutput).get(label) ?? "<MISSING>";

  check("preflight: pg_temp._m5_0053_helper_capture_parse_failure_column_violation resolves via to_regprocedure", r("preflight_parse_failure_helper") === "t");
  check("preflight: pg_temp._m5_0053_helper_capture_analysis_receipt_request_violation resolves via to_regprocedure", r("preflight_request_helper") === "t");
  check("ACL: anon cannot execute the analysis-receipt-request violation helper -- SQLSTATE 42501", r("acl_anon_request") === "42501");
  check("ACL: anon cannot execute mark_analysis_parse_failed_for_job -- SQLSTATE 42501", r("acl_anon_mark") === "42501");
  check("ACL: authenticated cannot execute the analysis-receipt-request violation helper -- SQLSTATE 42501", r("acl_authenticated_request") === "42501");
  check("ACL: authenticated cannot execute mark_analysis_parse_failed_for_job -- SQLSTATE 42501", r("acl_authenticated_mark") === "42501");
  check("ACL: service_role CAN execute the analysis-receipt-request violation helper (reaches JOB_NOT_FOUND on dummy args, never a permission error)", r("acl_service_role_request") === "NONE");
  check("ACL: service_role CAN execute mark_analysis_parse_failed_for_job (reaches JOB_NOT_FOUND, never a permission error)", r("acl_service_role_mark") === "NONE");

  const s1 = r;
  check(
    "parse_failed_at/parse_failure_code pairing violation -> EXACTLY protocol_external_calls_parse_failure_pairing_check, SQLSTATE 23514",
    s1("s1_pairing_sqlstate") === "23514" && s1("s1_pairing_constraint") === "protocol_external_calls_parse_failure_pairing_check"
  );
  check(
    "out-of-bounds parse_failure_code -> EXACTLY protocol_external_calls_parse_failure_code_check, SQLSTATE 23514",
    s1("s1_code_sqlstate") === "23514" && s1("s1_code_constraint") === "protocol_external_calls_parse_failure_code_check"
  );

  const s2 = r;
  check(
    "parse_failed_at on a 'reserved' (never-sent) analysis call -> EXACTLY protocol_external_calls_parse_failure_scope_check, SQLSTATE 23514",
    s2("s2_scope_sqlstate") === "23514" && s2("s2_scope_constraint") === "protocol_external_calls_parse_failure_scope_check"
  );

  const s3 = r;
  check(
    "raw_request_body/request_sha256 pairing violation -> EXACTLY analysis_call_receipts_request_pairing_check, SQLSTATE 23514 (deterministic: mock_pairing_check temporarily dropped so it cannot also fire)",
    s3("s3_pairing_sqlstate") === "23514" && s3("s3_pairing_constraint") === "analysis_call_receipts_request_pairing_check"
  );
  check(
    "analysis_call_receipts_request_mock_pairing_check catalog definition identical before/after the transactional drop+rollback used to isolate the pairing-check proof above",
    s3("s3_mockcheck_def_before") !== "<MISSING>" && s3("s3_mockcheck_def_before") === s3("s3_mockcheck_def_after"),
    `before=${s3("s3_mockcheck_def_before")} after=${s3("s3_mockcheck_def_after")}`
  );
  check(
    "request_sha256 not matching sha256(raw_request_body) -> EXACTLY analysis_call_receipts_request_hash_match_check, SQLSTATE 23514",
    s3("s3_hashmismatch_sqlstate") === "23514" && s3("s3_hashmismatch_constraint") === "analysis_call_receipts_request_hash_match_check"
  );
  check(
    "used_mock=true WITH request fields -> EXACTLY analysis_call_receipts_request_mock_pairing_check, SQLSTATE 23514, even though pairing/hash-match individually hold",
    s3("s3_mockpolicy_sqlstate") === "23514" && s3("s3_mockpolicy_constraint") === "analysis_call_receipts_request_mock_pairing_check"
  );
  checkRoster(
    "mock_false_body_hash_null_rejected",
    s3("s3_mockpolicy2_sqlstate") === "23514" && s3("s3_mockpolicy2_constraint") === "analysis_call_receipts_request_mock_pairing_check"
  );

  // ======================================================================
  // Part D — mark_analysis_parse_failed_for_job: full lifecycle, all
  //          reachable statuses (JOB_NOT_FOUND, JOB_NOT_OWNED,
  //          NOT_CURRENT_ATTEMPT, WRONG_CALL_KIND, NOT_ELIGIBLE, MARKED,
  //          ALREADY_MARKED, PARSE_FAILURE_CODE_CONFLICT,
  //          PROBE_RESULT_ALREADY_EXISTS) and the retry_analysis_
  //          generation_for_job parse-repair branch (SOURCE_NOT_ELIGIBLE
  //          before marking, RESERVED after, ALREADY_RETRIED on replay).
  //          CURRENT_ATTEMPT_NOT_FOUND and SOURCE_NOT_AUTHORITATIVE_
  //          GENERATION are documented, defensive-only statuses,
  //          structurally unreachable through this RPC's own legitimate
  //          call surface given ALREADY_MARKED/PARSE_FAILURE_CODE_CONFLICT
  //          are checked first (see docs/DECISIONS.md D-027) -- not
  //          exercised here for that reason, exactly like the identical,
  //          pre-existing CURRENT_ATTEMPT_NOT_FOUND guard in
  //          retry_analysis_generation_for_job itself.
  // ======================================================================
  const s4Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s4_proj, protocol_id as s4_proto from _m5_0053_runtime_helper_make_fixture('s4') \\gset
select (job).id as s4_job from enqueue_protocol_execution_job(:'s4_proto', :'s4_proj', 3) \\gset
select claim_token as s4_token from claim_protocol_execution_job('worker-s4', 300) \\gset
select (attempt).id as s4_attempt, (perplexity_call).id as s4_pcall, (analysis_call).id as s4_acall
  from admit_and_reserve_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', 'baseline', (:'s4_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_attempt', 'perplexity', 'simulated');
select probe_run_id as s4_probe_run from protocol_attempts where id = :'s4_attempt' \\gset

-- JOB_NOT_FOUND / JOB_NOT_OWNED / NOT_CURRENT_ATTEMPT / WRONG_CALL_KIND,
-- before the analysis call is even sent.
select status as s4_job_not_found from mark_analysis_parse_failed_for_job('00000000-0000-4000-8000-000000000000', :'s4_token', :'s4_proj', :'s4_acall', 'invalid_json') \\gset
select status as s4_job_not_owned from mark_analysis_parse_failed_for_job(:'s4_job', '00000000-0000-4000-8000-000000000000', :'s4_proj', :'s4_acall', 'invalid_json') \\gset
select status as s4_not_current_attempt from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', '00000000-0000-4000-8000-000000000000', 'invalid_json') \\gset
select status as s4_wrong_call_kind from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_pcall', 'invalid_json') \\gset
select status as s4_not_eligible_unsent from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 'invalid_json') \\gset

select status from mark_external_call_sent_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_pcall', :'s4_probe_run');
select status from record_provider_call_receipt_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_pcall', :'s4_probe_run', 'success', 200, 'req-s4', '${sha256Hex("s4 perplexity answer")}', 400, null, null, 's4 perplexity answer');
select status from mark_external_call_sent_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', :'s4_probe_run');
select status as s4_not_eligible_sent from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 'invalid_json') \\gset

select status from record_analysis_call_receipt_for_job(
  :'s4_job', :'s4_token', :'s4_proj', :'s4_acall', :'s4_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s4 analysis request")}', '${sha256Hex("s4 analysis output")}', 200, null, null, 's4 analysis output', 's4 analysis request'
);

select status as s4_source_not_eligible_before_mark, external_call as s4_source_ec_before
  from retry_analysis_generation_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 0.02) \\gset

select status as s4_marked, (external_call).parse_failed_at is not null as s4_marked_has_timestamp, (external_call).parse_failure_code as s4_marked_code
  from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 'invalid_json') \\gset
select status as s4_already_marked from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 'invalid_json') \\gset
select status as s4_code_conflict from mark_analysis_parse_failed_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 'schema_validation_failed') \\gset

select status as s4_repair_reserved, (external_call).generation as s4_repair_generation, (external_call).id as s4_repair_child_id
  from retry_analysis_generation_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 0.02) \\gset
select status as s4_repair_replay, (external_call).id as s4_repair_replay_child_id
  from retry_analysis_generation_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 0.02) \\gset
-- A second replay with a DIFFERENT reserved cost must still refuse to
-- create a second child -- SOURCE_ALREADY_RETRIED, not a new RESERVED,
-- and the returned row must be the SAME child created above.
select status as s4_repair_replay_diffcost, (external_call).id as s4_repair_replay_diffcost_child_id
  from retry_analysis_generation_for_job(:'s4_job', :'s4_token', :'s4_proj', :'s4_acall', 0.05) \\gset

\\echo '##R## s4_job_not_found' :s4_job_not_found
\\echo '##R## s4_job_not_owned' :s4_job_not_owned
\\echo '##R## s4_not_current_attempt' :s4_not_current_attempt
\\echo '##R## s4_wrong_call_kind' :s4_wrong_call_kind
\\echo '##R## s4_not_eligible_unsent' :s4_not_eligible_unsent
\\echo '##R## s4_not_eligible_sent' :s4_not_eligible_sent
\\echo '##R## s4_source_not_eligible_before_mark' :s4_source_not_eligible_before_mark
\\echo '##R## s4_marked' :s4_marked
\\echo '##R## s4_marked_has_timestamp' :s4_marked_has_timestamp
\\echo '##R## s4_marked_code' :s4_marked_code
\\echo '##R## s4_already_marked' :s4_already_marked
\\echo '##R## s4_code_conflict' :s4_code_conflict
\\echo '##R## s4_repair_reserved' :s4_repair_reserved
\\echo '##R## s4_repair_generation' :s4_repair_generation
\\echo '##R## s4_repair_child_id' :s4_repair_child_id
\\echo '##R## s4_repair_replay' :s4_repair_replay
\\echo '##R## s4_repair_replay_child_id' :s4_repair_replay_child_id
\\echo '##R## s4_repair_replay_diffcost' :s4_repair_replay_diffcost
\\echo '##R## s4_repair_replay_diffcost_child_id' :s4_repair_replay_diffcost_child_id
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "06-s4-lifecycle.sql"), s4Sql);
  const s4Out = await runPsqlCapturedAsync(path.join(scratchDir, "06-s4-lifecycle.sql"), "s4");
  const s4 = (label: string) => parseMarkers(s4Out.stdout).get(label) ?? "<MISSING>";

  checkRoster("status_job_not_found", s4("s4_job_not_found") === "JOB_NOT_FOUND");
  checkRoster("status_job_not_owned", s4("s4_job_not_owned") === "JOB_NOT_OWNED");
  checkRoster("status_not_current_attempt", s4("s4_not_current_attempt") === "NOT_CURRENT_ATTEMPT");
  checkRoster("status_wrong_call_kind", s4("s4_wrong_call_kind") === "WRONG_CALL_KIND");
  checkRoster("status_not_eligible_unsent", s4("s4_not_eligible_unsent") === "NOT_ELIGIBLE");
  checkRoster("status_not_eligible_sent", s4("s4_not_eligible_sent") === "NOT_ELIGIBLE");
  checkRoster("status_source_not_eligible_before_mark", s4("s4_source_not_eligible_before_mark") === "SOURCE_NOT_ELIGIBLE");
  checkRoster("status_marked", s4("s4_marked") === "MARKED");
  checkRoster("marked_has_timestamp", s4("s4_marked_has_timestamp") === "t");
  checkRoster("marked_code_exact", s4("s4_marked_code") === "invalid_json");
  checkRoster("status_already_marked", s4("s4_already_marked") === "ALREADY_MARKED");
  checkRoster("status_parse_failure_code_conflict", s4("s4_code_conflict") === "PARSE_FAILURE_CODE_CONFLICT");
  checkRoster("status_repair_reserved", s4("s4_repair_reserved") === "RESERVED");
  checkRoster("repair_generation_is_2", s4("s4_repair_generation") === "2");
  checkRoster("status_already_retried_same_cost", s4("s4_repair_replay") === "ALREADY_RETRIED");
  checkRoster("status_source_already_retried_diff_cost", s4("s4_repair_replay_diffcost") === "SOURCE_ALREADY_RETRIED");
  checkRoster(
    "repair_child_id_stable_across_replays",
    s4("s4_repair_child_id") !== "<MISSING>" &&
      s4("s4_repair_child_id") === s4("s4_repair_replay_child_id") &&
      s4("s4_repair_child_id") === s4("s4_repair_replay_diffcost_child_id"),
    `child=${s4("s4_repair_child_id")} replay=${s4("s4_repair_replay_child_id")} diffcost=${s4("s4_repair_replay_diffcost_child_id")}`
  );

  // ======================================================================
  // Part E — PROBE_RESULT_ALREADY_EXISTS, both for mark_analysis_parse_
  //          failed_for_job itself and for the retry's own defensive guard.
  // ======================================================================
  const s5Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s5_proj, protocol_id as s5_proto from _m5_0053_runtime_helper_make_fixture('s5') \\gset
select (job).id as s5_job from enqueue_protocol_execution_job(:'s5_proto', :'s5_proj', 3) \\gset
select claim_token as s5_token from claim_protocol_execution_job('worker-s5', 300) \\gset
select (attempt).id as s5_attempt, (perplexity_call).id as s5_pcall, (analysis_call).id as s5_acall
  from admit_and_reserve_attempt_for_job(:'s5_job', :'s5_token', :'s5_proj', 'baseline', (:'s5_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_attempt', 'perplexity', 'simulated');
select probe_run_id as s5_probe_run from protocol_attempts where id = :'s5_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_pcall', :'s5_probe_run');
select status from record_provider_call_receipt_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_pcall', :'s5_probe_run', 'success', 200, 'req-s5', '${sha256Hex(
    "s5 perplexity answer"
  )}', 400, null, null, 's5 perplexity answer');
select status from mark_external_call_sent_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_acall', :'s5_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s5_job', :'s5_token', :'s5_proj', :'s5_acall', :'s5_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s5 analysis request")}', '${sha256Hex("s5 analysis output")}', 200, null, null, 's5 analysis output', 's5 analysis request'
);

-- A probe_result appears for this probe_run BEFORE any mark attempt.
insert into probe_results (
  probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
  competitors_mentioned, sources_cited, verdict, dataset_id, dataset_source_type
)
select pr.id, :'s5_proj', 'fixture prompt', 'perplexity', 's5 analysis output', false, 'absent',
  '[]'::jsonb, '[]'::jsonb, 'lost', pr.dataset_id, pr.dataset_source_type
  from probe_runs pr where pr.id = :'s5_probe_run';

select status as s5_mark_probe_result_exists from mark_analysis_parse_failed_for_job(:'s5_job', :'s5_token', :'s5_proj', :'s5_acall', 'invalid_json') \\gset

\\echo '##R## s5_mark_probe_result_exists' :s5_mark_probe_result_exists
ROLLBACK;

-- s5b: a SEPARATE fixture where mark succeeds FIRST (no probe_result yet
-- at that point), a probe_result then appears, and retry_analysis_
-- generation_for_job's OWN defensive PROBE_RESULT_ALREADY_EXISTS guard
-- (distinct code path from mark's own) is what must fire -- proving both
-- the mark-time and the retry-time checks are independently real.
BEGIN;
select project_id as s5b_proj, protocol_id as s5b_proto from _m5_0053_runtime_helper_make_fixture('s5b') \\gset
select (job).id as s5b_job from enqueue_protocol_execution_job(:'s5b_proto', :'s5b_proj', 3) \\gset
select claim_token as s5b_token from claim_protocol_execution_job('worker-s5b', 300) \\gset
select (attempt).id as s5b_attempt, (perplexity_call).id as s5b_pcall, (analysis_call).id as s5b_acall
  from admit_and_reserve_attempt_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', 'baseline', (:'s5b_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_attempt', 'perplexity', 'simulated');
select probe_run_id as s5b_probe_run from protocol_attempts where id = :'s5b_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_pcall', :'s5b_probe_run');
select status from record_provider_call_receipt_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_pcall', :'s5b_probe_run', 'success', 200, 'req-s5b', '${sha256Hex(
    "s5b perplexity answer"
  )}', 400, null, null, 's5b perplexity answer');
select status from mark_external_call_sent_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_acall', :'s5b_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_acall', :'s5b_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s5b analysis request")}', '${sha256Hex("s5b analysis output")}', 200, null, null, 's5b analysis output', 's5b analysis request'
);
select status as s5b_mark from mark_analysis_parse_failed_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_acall', 'invalid_json') \\gset

-- only now does a probe_result appear for this probe_run.
insert into probe_results (
  probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
  competitors_mentioned, sources_cited, verdict, dataset_id, dataset_source_type
)
select pr.id, :'s5b_proj', 'fixture prompt', 'perplexity', 's5b analysis output', false, 'absent',
  '[]'::jsonb, '[]'::jsonb, 'lost', pr.dataset_id, pr.dataset_source_type
  from probe_runs pr where pr.id = :'s5b_probe_run';

select status as s5b_retry_probe_result_exists from retry_analysis_generation_for_job(:'s5b_job', :'s5b_token', :'s5b_proj', :'s5b_acall', 0.02) \\gset

\\echo '##R## s5b_mark' :s5b_mark
\\echo '##R## s5b_retry_probe_result_exists' :s5b_retry_probe_result_exists
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "07-s5-probe-result-exists.sql"), s5Sql);
  const { stdout: s5Out } = runPsql(path.join(scratchDir, "07-s5-probe-result-exists.sql"), "continue", "07-s5");
  const s5 = (label: string) => parseMarkers(s5Out).get(label) ?? "<MISSING>";
  checkRoster(
    "status_probe_result_already_exists_mark",
    s5("s5_mark_probe_result_exists") === "PROBE_RESULT_ALREADY_EXISTS"
  );
  check("s5b precondition: mark succeeded before any probe_result existed", s5("s5b_mark") === "MARKED");
  checkRoster(
    "status_probe_result_already_exists_retry",
    s5("s5b_retry_probe_result_exists") === "PROBE_RESULT_ALREADY_EXISTS"
  );

  // ======================================================================
  // Part F — used_mock=true accepted with no request fields; retry_cap
  //          still enforced on the parse-repair branch (inherited,
  //          unmodified _reserve_additional_analysis_generation_core).
  // ======================================================================
  const s6Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s6_proj, protocol_id as s6_proto from _m5_0053_runtime_helper_make_fixture('s6', 0) \\gset
select (job).id as s6_job from enqueue_protocol_execution_job(:'s6_proto', :'s6_proj', 3) \\gset
select claim_token as s6_token from claim_protocol_execution_job('worker-s6', 300) \\gset
select (attempt).id as s6_attempt, (perplexity_call).id as s6_pcall, (analysis_call).id as s6_acall
  from admit_and_reserve_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', 'baseline', (:'s6_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_attempt', 'perplexity', 'simulated');
select probe_run_id as s6_probe_run from protocol_attempts where id = :'s6_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall', :'s6_probe_run');
select status from record_provider_call_receipt_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_pcall', :'s6_probe_run', 'success', 200, 'req-s6', '${sha256Hex(
    "s6 perplexity answer"
  )}', 400, null, null, 's6 perplexity answer');
select status from mark_external_call_sent_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall', :'s6_probe_run');

-- used_mock=true, real receipt, NO request fields -- accepted.
select status as s6_mock_receipt, (receipt).raw_request_body is null as s6_mock_body_null, (receipt).request_sha256 is null as s6_mock_hash_null
  from record_analysis_call_receipt_for_job(
    :'s6_job', :'s6_token', :'s6_proj', :'s6_acall', :'s6_probe_run', 'success', 'openai', 'gpt-4o-mini', true,
    null, '${sha256Hex("s6 analysis output (mock)")}', 200, null, null, 's6 analysis output (mock)', null
  ) \\gset

select status as s6_mark from mark_analysis_parse_failed_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall', 'invalid_json') \\gset
-- retry_cap = 0 on this fixture's protocol -- next_generation (2) > retry_cap + 1 (1) -> RETRY_CAP_EXCEEDED,
-- proving the cap is enforced identically on the parse-repair branch, inherited unmodified from _reserve_additional_analysis_generation_core.
select status as s6_retry_cap_exceeded from retry_analysis_generation_for_job(:'s6_job', :'s6_token', :'s6_proj', :'s6_acall', 0.02) \\gset

\\echo '##R## s6_mock_receipt' :s6_mock_receipt
\\echo '##R## s6_mock_body_null' :s6_mock_body_null
\\echo '##R## s6_mock_hash_null' :s6_mock_hash_null
\\echo '##R## s6_mark' :s6_mark
\\echo '##R## s6_retry_cap_exceeded' :s6_retry_cap_exceeded
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "08-s6-mock-and-caps.sql"), s6Sql);
  const { stdout: s6Out } = runPsql(path.join(scratchDir, "08-s6-mock-and-caps.sql"), "continue", "08-s6");
  const s6 = (label: string) => parseMarkers(s6Out).get(label) ?? "<MISSING>";
  checkRoster("mock_true_body_hash_null_accepted", s6("s6_mock_receipt") === "RECEIPTED" && s6("s6_mock_body_null") === "t" && s6("s6_mock_hash_null") === "t");
  check("a mocked, real-receipted, completed generation can still be marked parse-failed", s6("s6_mark") === "MARKED");
  checkRoster("retry_cap_exceeded_on_repair_branch", s6("s6_retry_cap_exceeded") === "RETRY_CAP_EXCEEDED");

  // ======================================================================
  // Part G — spend_cap_usd still enforced on the parse-repair branch
  //          (retry_cap generous here so it is never the blocking factor;
  //          spend_cap_usd is set to a value the repair's own reserved
  //          cost alone exceeds).
  // ======================================================================
  const s7Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s7_proj, protocol_id as s7_proto from _m5_0053_runtime_helper_make_fixture('s7', 5, 0.05) \\gset
select (job).id as s7_job from enqueue_protocol_execution_job(:'s7_proto', :'s7_proj', 3) \\gset
select claim_token as s7_token from claim_protocol_execution_job('worker-s7', 300) \\gset
select (attempt).id as s7_attempt, (perplexity_call).id as s7_pcall, (analysis_call).id as s7_acall
  from admit_and_reserve_attempt_for_job(:'s7_job', :'s7_token', :'s7_proj', 'baseline', (:'s7_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_attempt', 'perplexity', 'simulated');
select probe_run_id as s7_probe_run from protocol_attempts where id = :'s7_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_pcall', :'s7_probe_run');
select status from record_provider_call_receipt_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_pcall', :'s7_probe_run', 'success', 200, 'req-s7', '${sha256Hex(
    "s7 perplexity answer"
  )}', 400, null, null, 's7 perplexity answer');
select status from mark_external_call_sent_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_acall', :'s7_probe_run');
select status, (receipt).raw_request_body as s7_receipt_body, (receipt).request_sha256 as s7_receipt_hash
  from record_analysis_call_receipt_for_job(
    :'s7_job', :'s7_token', :'s7_proj', :'s7_acall', :'s7_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
    '${sha256Hex("s7 analysis request")}', '${sha256Hex("s7 analysis output")}', 200, null, null, 's7 analysis output', 's7 analysis request'
  ) \\gset
select status as s7_mark from mark_analysis_parse_failed_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_acall', 'invalid_json') \\gset
-- spend_cap_usd = 0.05 on this fixture; the baseline admission already
-- reserved 0.02, and this repair alone requests 1.00 -- 0.02+1.00 > 0.05.
select status as s7_spend_cap_exceeded from retry_analysis_generation_for_job(:'s7_job', :'s7_token', :'s7_proj', :'s7_acall', 1.00) \\gset

\\echo '##R## s7_mark' :s7_mark
\\echo '##R## s7_spend_cap_exceeded' :s7_spend_cap_exceeded
\\echo '##R## s7_receipt_body' :s7_receipt_body
\\echo '##R## s7_receipt_hash' :s7_receipt_hash
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "09-s7-spend-cap.sql"), s7Sql);
  const { stdout: s7Out } = runPsql(path.join(scratchDir, "09-s7-spend-cap.sql"), "continue", "09-s7");
  const s7 = (label: string) => parseMarkers(s7Out).get(label) ?? "<MISSING>";
  check("s7 precondition: mark succeeded", s7("s7_mark") === "MARKED");
  checkRoster("spend_cap_exceeded_on_repair_branch", s7("s7_spend_cap_exceeded") === "SPEND_CAP_EXCEEDED");
  checkRoster(
    "body_hash_exact_accepted_roundtrip",
    s7("s7_receipt_body") === "s7 analysis request" && s7("s7_receipt_hash") === sha256Hex("s7 analysis request")
  );

  // ======================================================================
  // Part H — SOURCE_NOT_AUTHORITATIVE_GENERATION: reachable via the
  //          LEGITIMATE RPC surface, no fault injection. A gen-1 analysis
  //          call fails (provider_error, historical branch), is retried
  //          (creating gen-2), and the STALE gen-1 call is then targeted
  //          directly -- ALREADY_MARKED/PARSE_FAILURE_CODE_CONFLICT never
  //          intercept it (gen-1's own parse_failed_at is null, it never
  //          reached the repair branch), so step 13's own generation
  //          check is what fires.
  // ======================================================================
  const s8Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s8_proj, protocol_id as s8_proto from _m5_0053_runtime_helper_make_fixture('s8') \\gset
select (job).id as s8_job from enqueue_protocol_execution_job(:'s8_proto', :'s8_proj', 3) \\gset
select claim_token as s8_token from claim_protocol_execution_job('worker-s8', 300) \\gset
select (attempt).id as s8_attempt, (perplexity_call).id as s8_pcall, (analysis_call).id as s8_acall1
  from admit_and_reserve_attempt_for_job(:'s8_job', :'s8_token', :'s8_proj', 'baseline', (:'s8_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_attempt', 'perplexity', 'simulated');
select probe_run_id as s8_probe_run from protocol_attempts where id = :'s8_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_pcall', :'s8_probe_run');
select status from record_provider_call_receipt_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_pcall', :'s8_probe_run', 'success', 200, 'req-s8', '${sha256Hex(
    "s8 perplexity answer"
  )}', 400, null, null, 's8 perplexity answer');
select status from mark_external_call_sent_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_acall1', :'s8_probe_run');
-- gen-1 fails at the PROVIDER level (never completed, never parse-failed).
select status from record_analysis_call_receipt_for_job(
  :'s8_job', :'s8_token', :'s8_proj', :'s8_acall1', :'s8_probe_run', 'provider_error', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s8 analysis request 1")}', null, 200, null, null, null, 's8 analysis request 1'
);
select status as s8_retry_reserved, (external_call).id as s8_acall2
  from retry_analysis_generation_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_acall1', 0.02) \\gset

-- direct mark attempt on the now-STALE gen-1 call.
select status as s8_stale_generation from mark_analysis_parse_failed_for_job(:'s8_job', :'s8_token', :'s8_proj', :'s8_acall1', 'invalid_json') \\gset

\\echo '##R## s8_retry_reserved' :s8_retry_reserved
\\echo '##R## s8_stale_generation' :s8_stale_generation
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "10-s8-stale-generation.sql"), s8Sql);
  const { stdout: s8Out } = runPsql(path.join(scratchDir, "10-s8-stale-generation.sql"), "continue", "10-s8");
  const s8 = (label: string) => parseMarkers(s8Out).get(label) ?? "<MISSING>";
  check("s8 precondition: the historical-branch retry reserved gen-2", s8("s8_retry_reserved") === "RESERVED");
  checkRoster("status_source_not_authoritative_generation", s8("s8_stale_generation") === "SOURCE_NOT_AUTHORITATIVE_GENERATION");

  // ======================================================================
  // Part I — probe_run_id incoherence, both reachable via the legitimate
  //          RPC surface (mark_external_call_sent_for_job's own p_probe_
  //          run_id parameter is never validated against the attempt's
  //          own value -- D-027's own documented finding). Two attempts
  //          share one project so a real, existing, but FOREIGN probe_run
  //          is available to borrow.
  // ======================================================================
  const s9Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select project_id as s9_proj, protocol_id as s9_proto_a from _m5_0053_runtime_helper_make_fixture('s9a') \\gset
select protocol_id as s9_proto_b from _m5_0053_runtime_helper_make_fixture('s9b', 2, 100.00, :'s9_proj') \\gset

-- Attempt A: never started (create_probe_run_and_start_attempt_for_job
-- is never called) -- its own attempt.probe_run_id stays null.
select (job).id as s9_job_a from enqueue_protocol_execution_job(:'s9_proto_a', :'s9_proj', 3) \\gset
select claim_token as s9_token_a from claim_protocol_execution_job('worker-s9a', 300) \\gset
select (attempt).id as s9_attempt_a, (analysis_call).id as s9_acall_a
  from admit_and_reserve_attempt_for_job(:'s9_job_a', :'s9_token_a', :'s9_proj', 'baseline', (:'s9_job_a' || ':baseline:1'), 0.01, 0.01) \\gset

-- Attempt B: started normally, giving a real, existing, FOREIGN probe_run.
select (job).id as s9_job_b from enqueue_protocol_execution_job(:'s9_proto_b', :'s9_proj', 3) \\gset
select claim_token as s9_token_b from claim_protocol_execution_job('worker-s9b', 300) \\gset
select (attempt).id as s9_attempt_b, (perplexity_call).id as s9_pcall_b
  from admit_and_reserve_attempt_for_job(:'s9_job_b', :'s9_token_b', :'s9_proj', 'baseline', (:'s9_job_b' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s9_job_b', :'s9_token_b', :'s9_proj', :'s9_attempt_b', 'perplexity', 'simulated');
select probe_run_id as s9_foreign_probe_run from protocol_attempts where id = :'s9_attempt_b' \\gset

-- Attempt A's analysis call is sent using B's FOREIGN probe_run_id --
-- legitimate per mark_external_call_sent_for_job's own signature, which
-- never checks it against the caller's own attempt.
select status from mark_external_call_sent_for_job(:'s9_job_a', :'s9_token_a', :'s9_proj', :'s9_acall_a', :'s9_foreign_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s9_job_a', :'s9_token_a', :'s9_proj', :'s9_acall_a', :'s9_foreign_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s9 analysis request a")}', '${sha256Hex("s9 analysis output a")}', 200, null, null, 's9 analysis output a', 's9 analysis request a'
);
-- attempt A's OWN probe_run_id is still null (create_probe_run_and_start_
-- attempt_for_job was never called for attempt A).
select status as s9_attempt_probe_run_null from mark_analysis_parse_failed_for_job(:'s9_job_a', :'s9_token_a', :'s9_proj', :'s9_acall_a', 'invalid_json') \\gset

ROLLBACK;

-- s9c: mismatch call/attempt -- attempt IS started (has its own real
-- probe_run_id), but its analysis call is sent with a DIFFERENT, foreign
-- probe_run_id -- v_call.probe_run_id is distinct from v_attempt.probe_run_id.
BEGIN;
select project_id as s9c_proj, protocol_id as s9c_proto_a from _m5_0053_runtime_helper_make_fixture('s9c-a') \\gset
select protocol_id as s9c_proto_b from _m5_0053_runtime_helper_make_fixture('s9c-b', 2, 100.00, :'s9c_proj') \\gset

select (job).id as s9c_job_a from enqueue_protocol_execution_job(:'s9c_proto_a', :'s9c_proj', 3) \\gset
select claim_token as s9c_token_a from claim_protocol_execution_job('worker-s9c-a', 300) \\gset
select (attempt).id as s9c_attempt_a, (analysis_call).id as s9c_acall_a
  from admit_and_reserve_attempt_for_job(:'s9c_job_a', :'s9c_token_a', :'s9c_proj', 'baseline', (:'s9c_job_a' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s9c_job_a', :'s9c_token_a', :'s9c_proj', :'s9c_attempt_a', 'perplexity', 'simulated');
select probe_run_id as s9c_own_probe_run from protocol_attempts where id = :'s9c_attempt_a' \\gset

select (job).id as s9c_job_b from enqueue_protocol_execution_job(:'s9c_proto_b', :'s9c_proj', 3) \\gset
select claim_token as s9c_token_b from claim_protocol_execution_job('worker-s9c-b', 300) \\gset
select (attempt).id as s9c_attempt_b
  from admit_and_reserve_attempt_for_job(:'s9c_job_b', :'s9c_token_b', :'s9c_proj', 'baseline', (:'s9c_job_b' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s9c_job_b', :'s9c_token_b', :'s9c_proj', :'s9c_attempt_b', 'perplexity', 'simulated');
select probe_run_id as s9c_foreign_probe_run from protocol_attempts where id = :'s9c_attempt_b' \\gset

-- attempt A's analysis call is sent with B's FOREIGN probe_run_id --
-- mismatch against attempt A's OWN (real, non-null) probe_run_id.
select status from mark_external_call_sent_for_job(:'s9c_job_a', :'s9c_token_a', :'s9c_proj', :'s9c_acall_a', :'s9c_foreign_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s9c_job_a', :'s9c_token_a', :'s9c_proj', :'s9c_acall_a', :'s9c_foreign_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s9c analysis request a")}', '${sha256Hex("s9c analysis output a")}', 200, null, null, 's9c analysis output a', 's9c analysis request a'
);
select status as s9c_mismatch_call_attempt from mark_analysis_parse_failed_for_job(:'s9c_job_a', :'s9c_token_a', :'s9c_proj', :'s9c_acall_a', 'invalid_json') \\gset

\\echo '##R## s9_attempt_probe_run_null' :s9_attempt_probe_run_null
\\echo '##R## s9c_own_probe_run' :s9c_own_probe_run
\\echo '##R## s9c_foreign_probe_run' :s9c_foreign_probe_run
\\echo '##R## s9c_mismatch_call_attempt' :s9c_mismatch_call_attempt
ROLLBACK;
`;
  writeFileSync(path.join(scratchDir, "11-s9-probe-run-incoherence.sql"), s9Sql);
  const { stdout: s9Out } = runPsql(path.join(scratchDir, "11-s9-probe-run-incoherence.sql"), "continue", "11-s9");
  const s9 = (label: string) => parseMarkers(s9Out).get(label) ?? "<MISSING>";
  checkRoster("status_not_eligible_attempt_probe_run_null", s9("s9_attempt_probe_run_null") === "NOT_ELIGIBLE");
  check(
    "s9c precondition: attempt A's own probe_run_id and the borrowed foreign one really differ",
    s9("s9c_own_probe_run") !== "<MISSING>" && s9("s9c_foreign_probe_run") !== "<MISSING>" && s9("s9c_own_probe_run") !== s9("s9c_foreign_probe_run")
  );
  checkRoster("status_not_eligible_mismatch_call_attempt", s9("s9c_mismatch_call_attempt") === "NOT_ELIGIBLE");

  // ======================================================================
  // Part J — proprietary, strictly transactional fault injection for
  // CURRENT_ATTEMPT_NOT_FOUND: the ONLY state this status defends against
  // is the composite FK protocol_execution_jobs_current_attempt_fk
  // (foreign key (current_attempt_id, id, project_id) references
  // protocol_attempts (id, job_id, project_id), added in 0050) becoming
  // momentarily false. Everything here runs inside ONE transaction:
  // catalog captured before, the FK dropped (no CASCADE), the minimal
  // incoherent state built with a single UPDATE (never under service_role
  // -- service_role has no UPDATE grant on protocol_attempts at all; this
  // runs under the connection's own owner/superuser role, which is reset
  // to service_role only for the RPC call itself), the real RPC called
  // under service_role, the status asserted, then ROLLBACK -- which
  // undoes the DROP and the UPDATE together, atomically. A second,
  // separate statement after the ROLLBACK re-reads the catalog to prove
  // it is byte-identical to the "before" capture.
  // ======================================================================
  const s10Sql = `
\\pset pager off
BEGIN;
select pg_get_constraintdef(oid) as s10_fk_before from pg_constraint where conname = 'protocol_execution_jobs_current_attempt_fk' \\gset

SET ROLE service_role;
select project_id as s10_proj, protocol_id as s10_proto1 from _m5_0053_runtime_helper_make_fixture('s10a') \\gset
select protocol_id as s10_proto2 from _m5_0053_runtime_helper_make_fixture('s10b', 2, 100.00, :'s10_proj') \\gset
select (job).id as s10_job1 from enqueue_protocol_execution_job(:'s10_proto1', :'s10_proj', 3) \\gset
select claim_token as s10_token1 from claim_protocol_execution_job('worker-s10a', 300) \\gset
select (attempt).id as s10_attempt1, (analysis_call).id as s10_acall1
  from admit_and_reserve_attempt_for_job(:'s10_job1', :'s10_token1', :'s10_proj', 'baseline', (:'s10_job1' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s10_job1', :'s10_token1', :'s10_proj', :'s10_attempt1', 'perplexity', 'simulated');
select (job).id as s10_job2 from enqueue_protocol_execution_job(:'s10_proto2', :'s10_proj', 3) \\gset
RESET ROLE;

-- neutralize only the FK that makes CURRENT_ATTEMPT_NOT_FOUND
-- unreachable, transactionally (no CASCADE -- this is a plain FK with no
-- dependents).
ALTER TABLE public.protocol_execution_jobs DROP CONSTRAINT protocol_execution_jobs_current_attempt_fk;

-- minimal incoherent state: attempt1 still IS job1's current_attempt_id
-- (untouched), but its own job_id now points at job2 instead -- exactly
-- the coherence mark_analysis_parse_failed_for_job's own step 10 query
-- (pa.id = current_attempt_id and pa.job_id = p_job_id and pa.project_id
-- = p_project_id) requires and no longer finds.
UPDATE public.protocol_attempts SET job_id = :'s10_job2' WHERE id = :'s10_attempt1';

SET ROLE service_role;
select status as s10_current_attempt_not_found
  from mark_analysis_parse_failed_for_job(:'s10_job1', :'s10_token1', :'s10_proj', :'s10_acall1', 'invalid_json') \\gset
RESET ROLE;

ROLLBACK;

select pg_get_constraintdef(oid) as s10_fk_after from pg_constraint where conname = 'protocol_execution_jobs_current_attempt_fk' \\gset

\\echo '##R## s10_fk_before' :s10_fk_before
\\echo '##R## s10_fk_after' :s10_fk_after
\\echo '##R## s10_current_attempt_not_found' :s10_current_attempt_not_found
`;
  writeFileSync(path.join(scratchDir, "12-s10-fault-injection-current-attempt.sql"), s10Sql);
  const { stdout: s10Out } = runPsql(path.join(scratchDir, "12-s10-fault-injection-current-attempt.sql"), "continue", "12-s10");
  const s10 = (label: string) => parseMarkers(s10Out).get(label) ?? "<MISSING>";
  checkRoster("status_current_attempt_not_found_fi", s10("s10_current_attempt_not_found") === "CURRENT_ATTEMPT_NOT_FOUND");
  checkRoster(
    "catalog_identical_after_fi_current_attempt",
    s10("s10_fk_before") !== "<MISSING>" && s10("s10_fk_before") === s10("s10_fk_after"),
    `before=${s10("s10_fk_before")} after=${s10("s10_fk_after")}`
  );

  // ======================================================================
  // Part K — proprietary transactional fault injections for the three
  // remaining NOT_ELIGIBLE sub-conditions that are not reachable via any
  // legitimate RPC sequence: call.probe_run_id null (no CHECK forbids
  // this on a completed call -- no constraint needs neutralizing, only a
  // direct UPDATE, never under service_role); a completed call with no
  // receipt row at all (same -- no constraint ties status to receipt
  // existence at the SQL layer, only RPC discipline does); and a real
  // receipt whose own outcome is mutated away from 'success' post-hoc
  // (again no constraint blocks this UPDATE). Each is its own BEGIN/
  // ROLLBACK block in this one script.
  // ======================================================================
  const s11Sql = `
\\pset pager off
-- FI: call.probe_run_id null on an otherwise-completed, success-receipted call.
BEGIN;
SET ROLE service_role;
select project_id as fi2_proj, protocol_id as fi2_proto from _m5_0053_runtime_helper_make_fixture('fi2') \\gset
select (job).id as fi2_job from enqueue_protocol_execution_job(:'fi2_proto', :'fi2_proj', 3) \\gset
select claim_token as fi2_token from claim_protocol_execution_job('worker-fi2', 300) \\gset
select (attempt).id as fi2_attempt, (perplexity_call).id as fi2_pcall, (analysis_call).id as fi2_acall
  from admit_and_reserve_attempt_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', 'baseline', (:'fi2_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_attempt', 'perplexity', 'simulated');
select probe_run_id as fi2_probe_run from protocol_attempts where id = :'fi2_attempt' \\gset
select status from mark_external_call_sent_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_pcall', :'fi2_probe_run');
select status from record_provider_call_receipt_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_pcall', :'fi2_probe_run', 'success', 200, 'req-fi2', '${sha256Hex(
    "fi2 perplexity answer"
  )}', 400, null, null, 'fi2 perplexity answer');
select status from mark_external_call_sent_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_acall', :'fi2_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_acall', :'fi2_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("fi2 analysis request")}', '${sha256Hex("fi2 analysis output")}', 200, null, null, 'fi2 analysis output', 'fi2 analysis request'
);
RESET ROLE;
-- protocol_external_calls_probe_run_lifecycle_check (0050) requires
-- request_sent_at is null OR probe_run_id is not null -- this call's
-- request_sent_at is already set (mark_external_call_sent_for_job ran
-- above), so nulling probe_run_id alone would violate that constraint.
-- request_sent_at is also cleared in the same UPDATE, satisfying the
-- lifecycle check via its first clause, without touching any 0053
-- constraint or needing any DROP CONSTRAINT: mark_analysis_parse_failed_
-- for_job never reads request_sent_at, so this is the minimal state
-- change that reaches the intended call.probe_run_id is null condition.
UPDATE public.protocol_external_calls SET probe_run_id = null, request_sent_at = null WHERE id = :'fi2_acall';
-- Prove the targeted state was actually reached (not silently blocked by
-- some other constraint) before trusting the RPC call below at all.
select case when status = 'completed' and probe_run_id is null then 't' else 'f' end as fi2_state_reached
  from protocol_external_calls where id = :'fi2_acall' \\gset
SET ROLE service_role;
select status as fi2_not_eligible from mark_analysis_parse_failed_for_job(:'fi2_job', :'fi2_token', :'fi2_proj', :'fi2_acall', 'invalid_json') \\gset
RESET ROLE;
ROLLBACK;

-- FI: status='completed' with NO receipt row at all.
BEGIN;
SET ROLE service_role;
select project_id as fi3_proj, protocol_id as fi3_proto from _m5_0053_runtime_helper_make_fixture('fi3') \\gset
select (job).id as fi3_job from enqueue_protocol_execution_job(:'fi3_proto', :'fi3_proj', 3) \\gset
select claim_token as fi3_token from claim_protocol_execution_job('worker-fi3', 300) \\gset
select (attempt).id as fi3_attempt, (perplexity_call).id as fi3_pcall, (analysis_call).id as fi3_acall
  from admit_and_reserve_attempt_for_job(:'fi3_job', :'fi3_token', :'fi3_proj', 'baseline', (:'fi3_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'fi3_job', :'fi3_token', :'fi3_proj', :'fi3_attempt', 'perplexity', 'simulated');
select probe_run_id as fi3_probe_run from protocol_attempts where id = :'fi3_attempt' \\gset
select status from mark_external_call_sent_for_job(:'fi3_job', :'fi3_token', :'fi3_proj', :'fi3_acall', :'fi3_probe_run');
RESET ROLE;
-- no receipt is ever inserted -- status forced to 'completed' directly.
-- protocol_external_calls_terminal_pair_check (0050) requires
-- terminalized_at is not null whenever status is completed/failed/
-- timed_out/cancelled -- this call was only ever sent (terminalized_at
-- still null), so terminalized_at is set in the same UPDATE to satisfy
-- that constraint without touching any 0053 constraint or needing any
-- DROP CONSTRAINT. protocol_external_calls_cost_basis_pair_check is
-- unaffected: actual_cost_usd/cost_basis both stay null, which already
-- satisfies that constraint's own "both null" branch.
UPDATE public.protocol_external_calls SET status = 'completed', terminalized_at = now() WHERE id = :'fi3_acall';
-- Prove the targeted state was actually reached (not silently blocked by
-- some other constraint) before trusting the RPC call below at all.
select case when status = 'completed' and not exists (
  select 1 from analysis_call_receipts r where r.external_call_id = protocol_external_calls.id
) then 't' else 'f' end as fi3_state_reached
  from protocol_external_calls where id = :'fi3_acall' \\gset
SET ROLE service_role;
select status as fi3_not_eligible from mark_analysis_parse_failed_for_job(:'fi3_job', :'fi3_token', :'fi3_proj', :'fi3_acall', 'invalid_json') \\gset
RESET ROLE;
ROLLBACK;

-- FI: a real receipt exists, but its OWN outcome is mutated away from
-- 'success' post-hoc (status stays 'completed', set together with the
-- real success receipt at insert time -- only the receipt row itself is
-- touched afterward).
BEGIN;
SET ROLE service_role;
select project_id as fi4_proj, protocol_id as fi4_proto from _m5_0053_runtime_helper_make_fixture('fi4') \\gset
select (job).id as fi4_job from enqueue_protocol_execution_job(:'fi4_proto', :'fi4_proj', 3) \\gset
select claim_token as fi4_token from claim_protocol_execution_job('worker-fi4', 300) \\gset
select (attempt).id as fi4_attempt, (perplexity_call).id as fi4_pcall, (analysis_call).id as fi4_acall
  from admit_and_reserve_attempt_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', 'baseline', (:'fi4_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_attempt', 'perplexity', 'simulated');
select probe_run_id as fi4_probe_run from protocol_attempts where id = :'fi4_attempt' \\gset
select status from mark_external_call_sent_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_pcall', :'fi4_probe_run');
select status from record_provider_call_receipt_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_pcall', :'fi4_probe_run', 'success', 200, 'req-fi4', '${sha256Hex(
    "fi4 perplexity answer"
  )}', 400, null, null, 'fi4 perplexity answer');
select status from mark_external_call_sent_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_acall', :'fi4_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_acall', :'fi4_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("fi4 analysis request")}', '${sha256Hex("fi4 analysis output")}', 200, null, null, 'fi4 analysis output', 'fi4 analysis request'
);
RESET ROLE;
UPDATE public.analysis_call_receipts SET outcome = 'provider_error' WHERE external_call_id = :'fi4_acall';
SET ROLE service_role;
select status as fi4_not_eligible from mark_analysis_parse_failed_for_job(:'fi4_job', :'fi4_token', :'fi4_proj', :'fi4_acall', 'invalid_json') \\gset
RESET ROLE;
ROLLBACK;

\\echo '##R## fi2_state_reached' :fi2_state_reached
\\echo '##R## fi2_not_eligible' :fi2_not_eligible
\\echo '##R## fi3_state_reached' :fi3_state_reached
\\echo '##R## fi3_not_eligible' :fi3_not_eligible
\\echo '##R## fi4_not_eligible' :fi4_not_eligible
`;
  writeFileSync(path.join(scratchDir, "13-s11-fault-injections-receipt-states.sql"), s11Sql);
  const { stdout: s11Out } = runPsql(path.join(scratchDir, "13-s11-fault-injections-receipt-states.sql"), "continue", "13-s11");
  const s11a = (label: string) => parseMarkers(s11Out).get(label) ?? "<MISSING>";
  check(
    "fi2 precondition: the targeted state (completed, probe_run_id null) was actually reached -- a prior constraint error must fail this explicitly, never silently produce a misleading NOT_ELIGIBLE",
    s11a("fi2_state_reached") === "t"
  );
  checkRoster("status_not_eligible_call_probe_run_null_fi", s11a("fi2_not_eligible") === "NOT_ELIGIBLE");
  check(
    "fi3 precondition: the targeted state (completed, no receipt row) was actually reached -- a prior constraint error must fail this explicitly, never silently produce a misleading NOT_ELIGIBLE",
    s11a("fi3_state_reached") === "t"
  );
  checkRoster("status_not_eligible_receipt_absent_fi", s11a("fi3_not_eligible") === "NOT_ELIGIBLE");
  checkRoster("status_not_eligible_receipt_outcome_non_success_fi", s11a("fi4_not_eligible") === "NOT_ELIGIBLE");

  // ======================================================================
  // Part L — proprietary transactional fault injection for a receipt/
  // external-call PROJECT mismatch: two composite FKs
  // (analysis_call_receipts_external_call_project_fk and
  // analysis_call_receipts_probe_run_project_fk, both from 0050) are the
  // only reason a receipt's own project_id can never legitimately diverge
  // from its external call's project_id. Both are captured, dropped
  // together, the receipt's project_id repointed at a wholly separate,
  // real project, the RPC called (still addressed by the ORIGINAL
  // project_id), the NOT_ELIGIBLE status asserted, then ROLLBACK restores
  // both FKs and the original project_id together.
  // ======================================================================
  const s12Sql = `
\\pset pager off
BEGIN;
select pg_get_constraintdef(oid) as s12_fk1_before from pg_constraint where conname = 'analysis_call_receipts_external_call_project_fk' \\gset
select pg_get_constraintdef(oid) as s12_fk2_before from pg_constraint where conname = 'analysis_call_receipts_probe_run_project_fk' \\gset

SET ROLE service_role;
select project_id as s12_proj, protocol_id as s12_proto from _m5_0053_runtime_helper_make_fixture('s12a') \\gset
select project_id as s12_other_proj from _m5_0053_runtime_helper_make_fixture('s12b') \\gset
select (job).id as s12_job from enqueue_protocol_execution_job(:'s12_proto', :'s12_proj', 3) \\gset
select claim_token as s12_token from claim_protocol_execution_job('worker-s12', 300) \\gset
select (attempt).id as s12_attempt, (perplexity_call).id as s12_pcall, (analysis_call).id as s12_acall
  from admit_and_reserve_attempt_for_job(:'s12_job', :'s12_token', :'s12_proj', 'baseline', (:'s12_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_attempt', 'perplexity', 'simulated');
select probe_run_id as s12_probe_run from protocol_attempts where id = :'s12_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_pcall', :'s12_probe_run');
select status from record_provider_call_receipt_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_pcall', :'s12_probe_run', 'success', 200, 'req-s12', '${sha256Hex(
    "s12 perplexity answer"
  )}', 400, null, null, 's12 perplexity answer');
select status from mark_external_call_sent_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_acall', :'s12_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s12_job', :'s12_token', :'s12_proj', :'s12_acall', :'s12_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s12 analysis request")}', '${sha256Hex("s12 analysis output")}', 200, null, null, 's12 analysis output', 's12 analysis request'
);
RESET ROLE;

ALTER TABLE public.analysis_call_receipts DROP CONSTRAINT analysis_call_receipts_external_call_project_fk;
ALTER TABLE public.analysis_call_receipts DROP CONSTRAINT analysis_call_receipts_probe_run_project_fk;

UPDATE public.analysis_call_receipts SET project_id = :'s12_other_proj' WHERE external_call_id = :'s12_acall';

SET ROLE service_role;
select status as s12_not_eligible from mark_analysis_parse_failed_for_job(:'s12_job', :'s12_token', :'s12_proj', :'s12_acall', 'invalid_json') \\gset
RESET ROLE;

ROLLBACK;

select pg_get_constraintdef(oid) as s12_fk1_after from pg_constraint where conname = 'analysis_call_receipts_external_call_project_fk' \\gset
select pg_get_constraintdef(oid) as s12_fk2_after from pg_constraint where conname = 'analysis_call_receipts_probe_run_project_fk' \\gset

\\echo '##R## s12_not_eligible' :s12_not_eligible
\\echo '##R## s12_fk1_before' :s12_fk1_before
\\echo '##R## s12_fk1_after' :s12_fk1_after
\\echo '##R## s12_fk2_before' :s12_fk2_before
\\echo '##R## s12_fk2_after' :s12_fk2_after
`;
  writeFileSync(path.join(scratchDir, "14-s12-fault-injection-receipt-project.sql"), s12Sql);
  const { stdout: s12Out } = runPsql(path.join(scratchDir, "14-s12-fault-injection-receipt-project.sql"), "continue", "14-s12");
  const s12 = (label: string) => parseMarkers(s12Out).get(label) ?? "<MISSING>";
  checkRoster("status_not_eligible_receipt_project_mismatch_fi", s12("s12_not_eligible") === "NOT_ELIGIBLE");
  checkRoster(
    "catalog_identical_after_fi_receipt_project",
    s12("s12_fk1_before") !== "<MISSING>" &&
      s12("s12_fk1_before") === s12("s12_fk1_after") &&
      s12("s12_fk2_before") !== "<MISSING>" &&
      s12("s12_fk2_before") === s12("s12_fk2_after"),
    `fk1 before=${s12("s12_fk1_before")} after=${s12("s12_fk1_after")}; fk2 before=${s12("s12_fk2_before")} after=${s12("s12_fk2_after")}`
  );

  // ======================================================================
  // Part M — monitoring counts the new scalar correctly across a real
  // MARKED transition, and a rollback truly leaves zero trace (a direct,
  // row-count-based proof, not merely an assumption from "ROLLBACK was
  // issued").
  // ======================================================================
  const s13Sql = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select analysis_parse_failures_total::text as s13_count_before from protocol_execution_job_monitoring_v1 \\gset

select project_id as s13_proj, protocol_id as s13_proto from _m5_0053_runtime_helper_make_fixture('s13') \\gset
select (job).id as s13_job from enqueue_protocol_execution_job(:'s13_proto', :'s13_proj', 3) \\gset
select claim_token as s13_token from claim_protocol_execution_job('worker-s13', 300) \\gset
select (attempt).id as s13_attempt, (perplexity_call).id as s13_pcall, (analysis_call).id as s13_acall
  from admit_and_reserve_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', 'baseline', (:'s13_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_attempt', 'perplexity', 'simulated');
select probe_run_id as s13_probe_run from protocol_attempts where id = :'s13_attempt' \\gset
select status from mark_external_call_sent_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_pcall', :'s13_probe_run');
select status from record_provider_call_receipt_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_pcall', :'s13_probe_run', 'success', 200, 'req-s13', '${sha256Hex(
    "s13 perplexity answer"
  )}', 400, null, null, 's13 perplexity answer');
select status from mark_external_call_sent_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_acall', :'s13_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'s13_job', :'s13_token', :'s13_proj', :'s13_acall', :'s13_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("s13 analysis request")}', '${sha256Hex("s13 analysis output")}', 200, null, null, 's13 analysis output', 's13 analysis request'
);
select status as s13_mark from mark_analysis_parse_failed_for_job(:'s13_job', :'s13_token', :'s13_proj', :'s13_acall', 'invalid_json') \\gset

select analysis_parse_failures_total::text as s13_count_after from protocol_execution_job_monitoring_v1 \\gset
select count(*)::text as s13_project_rows_before_rollback from projects where id = :'s13_proj' \\gset

ROLLBACK;

select count(*)::text as s13_project_rows_after_rollback from projects where id = :'s13_proj' \\gset

\\echo '##R## s13_mark' :s13_mark
\\echo '##R## s13_count_before' :s13_count_before
\\echo '##R## s13_count_after' :s13_count_after
\\echo '##R## s13_project_rows_before_rollback' :s13_project_rows_before_rollback
\\echo '##R## s13_project_rows_after_rollback' :s13_project_rows_after_rollback
`;
  writeFileSync(path.join(scratchDir, "15-s13-monitoring-and-rollback.sql"), s13Sql);
  const { stdout: s13Out } = runPsql(path.join(scratchDir, "15-s13-monitoring-and-rollback.sql"), "continue", "15-s13");
  const s13 = (label: string) => parseMarkers(s13Out).get(label) ?? "<MISSING>";
  check("s13 precondition: mark succeeded", s13("s13_mark") === "MARKED");
  checkRoster(
    "monitoring_counts_parse_failure_scalar",
    s13("s13_count_before") !== "<MISSING>" &&
      s13("s13_count_after") !== "<MISSING>" &&
      Number(s13("s13_count_after")) === Number(s13("s13_count_before")) + 1,
    `before=${s13("s13_count_before")} after=${s13("s13_count_after")}`
  );
  checkRoster(
    "rollback_leaves_no_trace",
    s13("s13_project_rows_before_rollback") === "1" && s13("s13_project_rows_after_rollback") === "0",
    `before=${s13("s13_project_rows_before_rollback")} after=${s13("s13_project_rows_after_rollback")}`
  );

  // ======================================================================
  // Part N — real, two-connection concurrency for retry_analysis_
  // generation_for_job's repair branch. Two genuinely separate OS
  // processes (two independent psql connections, distinct
  // application_name each) call the SAME RPC with the SAME job/claim_
  // token/project/source/cost. Session A holds its transaction open
  // (pg_sleep after its RPC returns, before COMMIT) so the FOR UPDATE
  // lock retry_analysis_generation_for_job takes on protocol_execution_
  // jobs (the very first lock in its body, before any eligibility logic
  // runs) is still held when Session B -- launched only after A's own
  // "after-RPC" marker is observed on A's stdout, never after a fixed
  // delay -- issues the identical call. This is deliberately STRICTER
  // than the fixed-delay approach scripts/test-m5-0052-runtime-
  // contract.ts's own Part B.5 race used: here, B's blocked state is
  // independently confirmed via pg_stat_activity (wait_event_type =
  // 'Lock') from a third, separate "owner" connection while A's
  // transaction is still open -- a merely assumed overlap is refused as
  // a scenario failure, not accepted as proof.
  //
  // The fixture (job/attempt/completed Perplexity leg/completed,
  // parse-failed analysis generation 1) is built entirely through
  // granted RPCs, in its own connection, committed (autocommit, no
  // BEGIN/ROLLBACK wrapping it) so both A and B -- separate connections
  // -- can see it. Cleanup (a single DELETE FROM projects, cascading)
  // runs only after every race_* assertion below has passed, mirroring
  // 0052's own "s6"-style success-gated cleanup discipline exactly.
  // ======================================================================
  const raceSetupSql = `
\\pset pager off
SET ROLE service_role;
select project_id as race_proj, protocol_id as race_proto from _m5_0053_runtime_helper_make_fixture('race', 5, 100.00) \\gset
select (job).id as race_job from enqueue_protocol_execution_job(:'race_proto', :'race_proj', 3) \\gset
select claim_token as race_token from claim_protocol_execution_job('worker-race', 300) \\gset
select (attempt).id as race_attempt, (perplexity_call).id as race_pcall, (analysis_call).id as race_source
  from admit_and_reserve_attempt_for_job(:'race_job', :'race_token', :'race_proj', 'baseline', (:'race_job' || ':baseline:1'), 0.01, 0.01) \\gset
select status from create_probe_run_and_start_attempt_for_job(:'race_job', :'race_token', :'race_proj', :'race_attempt', 'perplexity', 'simulated');
select probe_run_id as race_probe_run from protocol_attempts where id = :'race_attempt' \\gset
select status from mark_external_call_sent_for_job(:'race_job', :'race_token', :'race_proj', :'race_pcall', :'race_probe_run');
select status from record_provider_call_receipt_for_job(:'race_job', :'race_token', :'race_proj', :'race_pcall', :'race_probe_run', 'success', 200, 'req-race', '${sha256Hex(
    "race perplexity answer"
  )}', 400, null, null, 'race perplexity answer');
select status from mark_external_call_sent_for_job(:'race_job', :'race_token', :'race_proj', :'race_source', :'race_probe_run');
select status from record_analysis_call_receipt_for_job(
  :'race_job', :'race_token', :'race_proj', :'race_source', :'race_probe_run', 'success', 'openai', 'gpt-4o-mini', false,
  '${sha256Hex("race analysis request")}', '${sha256Hex("race analysis output")}', 200, null, null, 'race analysis output', 'race analysis request'
);
select status as race_mark from mark_analysis_parse_failed_for_job(:'race_job', :'race_token', :'race_proj', :'race_source', 'invalid_json') \\gset
select generation::text as race_source_generation from protocol_external_calls where id = :'race_source' \\gset
select count(*)::text as race_children_before from protocol_external_calls where retry_of_external_call_id = :'race_source' \\gset
select count(*)::text as race_probe_results_before from probe_results pr join protocol_attempts pa on pa.probe_run_id = pr.probe_run_id where pa.id = :'race_attempt' \\gset

\\echo '##R## race_proj' :race_proj
\\echo '##R## race_job' :race_job
\\echo '##R## race_token' :race_token
\\echo '##R## race_source' :race_source
\\echo '##R## race_mark' :race_mark
\\echo '##R## race_source_generation' :race_source_generation
\\echo '##R## race_children_before' :race_children_before
\\echo '##R## race_probe_results_before' :race_probe_results_before
`;
  writeFileSync(path.join(scratchDir, "16-race-setup.sql"), raceSetupSql);
  const { stdout: raceSetupOutput } = runPsql(path.join(scratchDir, "16-race-setup.sql"), "stop", "16-race-setup");
  const raceSetup = parseMarkers(raceSetupOutput);
  check(
    "race precondition: fixture built via real RPCs -- source is generation 1, already parse-failed (MARKED), zero existing retry children, zero probe_results",
    raceSetup.get("race_mark") === "MARKED" &&
      raceSetup.get("race_source_generation") === "1" &&
      raceSetup.get("race_children_before") === "0" &&
      raceSetup.get("race_probe_results_before") === "0"
  );
  const raceJobId = raceSetup.get("race_job") ?? "";
  const raceTokenId = raceSetup.get("race_token") ?? "";
  const raceProjId = raceSetup.get("race_proj") ?? "";
  const raceSourceId = raceSetup.get("race_source") ?? "";
  const RACE_COST = "0.02";
  const RACE_APP_A = "zypact-m5-0053-race-a";
  const RACE_APP_B = "zypact-m5-0053-race-b";
  const RACE_A_SLEEP_SECONDS = 4;

  function raceSql(appName: string, markerTag: string, varPrefix: string): string {
    return `
\\pset pager off
SET application_name = '${appName}';
BEGIN;
SET LOCAL ROLE service_role;
select status as ${varPrefix}_status, (external_call).id as ${varPrefix}_child_id,
       (external_call).generation::text as ${varPrefix}_generation, pg_backend_pid()::text as ${varPrefix}_pid
  from retry_analysis_generation_for_job('${raceJobId}', '${raceTokenId}', '${raceProjId}', '${raceSourceId}', ${RACE_COST}) \\gset
\\echo '##RACEMARK_${markerTag}_AFTER_RPC##' :${varPrefix}_status :${varPrefix}_pid
${markerTag === "A" ? `select pg_sleep(${RACE_A_SLEEP_SECONDS});\n` : ""}COMMIT;
\\echo '##R## ${varPrefix}_status' :${varPrefix}_status
\\echo '##R## ${varPrefix}_child_id' :${varPrefix}_child_id
\\echo '##R## ${varPrefix}_generation' :${varPrefix}_generation
\\echo '##R## ${varPrefix}_pid' :${varPrefix}_pid
`;
  }

  type TrackedPsql = {
    proc: ReturnType<typeof spawn>;
    stdout: string;
    stderr: string;
    markerSeen: Promise<void>;
    done: Promise<{ code: number | null }>;
  };

  function spawnTrackedPsql(scriptPath: string, markerText: string): TrackedPsql {
    const proc = spawn("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], { env: RUN_ENV });
    const state = { stdout: "", stderr: "" };
    let resolveMarker!: () => void;
    let markerAlreadyResolved = false;
    const markerSeen = new Promise<void>((resolve) => {
      resolveMarker = () => {
        if (!markerAlreadyResolved) {
          markerAlreadyResolved = true;
          resolve();
        }
      };
    });
    proc.stdout.on("data", (d) => {
      state.stdout += d.toString();
      if (state.stdout.includes(markerText)) resolveMarker();
    });
    proc.stderr.on("data", (d) => {
      state.stderr += d.toString();
    });
    const done = new Promise<{ code: number | null }>((resolve) => {
      proc.on("close", (code) => resolve({ code }));
    });
    return { proc, get stdout() { return state.stdout; }, get stderr() { return state.stderr; }, markerSeen, done } as TrackedPsql;
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`race scenario: timed out after ${ms}ms waiting for: ${label}`)), ms)),
    ]);
  }

  function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const raceAPath = path.join(scratchDir, "17-race-a.sql");
  const raceBPath = path.join(scratchDir, "18-race-b.sql");
  writeFileSync(raceAPath, raceSql(RACE_APP_A, "A", "race_a"));
  writeFileSync(raceBPath, raceSql(RACE_APP_B, "B", "race_b"));

  const raceA = spawnTrackedPsql(raceAPath, "##RACEMARK_A_AFTER_RPC##");

  let raceBObservedWaitingOnLock = false;
  let raceB: TrackedPsql | null = null;
  let raceHardFailure: string | null = null;

  try {
    // A's "after-RPC" marker means A's own retry_analysis_generation_for_job
    // call has already RETURNED and A is now inside pg_sleep with its
    // transaction (and the job-row FOR UPDATE lock it took) still open --
    // never a fixed delay guessed from the outside.
    await withTimeout(raceA.markerSeen, 15000, "session A's after-RPC marker");

    raceB = spawnTrackedPsql(raceBPath, "##RACEMARK_B_AFTER_RPC##");

    // Poll pg_stat_activity from a separate, short-lived "owner" connection
    // (never A's, never B's own session) while A's sleep window is open,
    // looking for B genuinely blocked on the same lock A holds. A fixed
    // number of short polls, bounded well inside A's own sleep window --
    // if B is never observed waiting, this is a real scenario failure,
    // not silently accepted as "probably overlapped".
    const pollDeadline = Date.now() + (RACE_A_SLEEP_SECONDS * 1000 + 2000);
    while (Date.now() < pollDeadline && !raceBObservedWaitingOnLock) {
      const pollResult = await spawnAsync("psql", [
        dbUrl, "-X", "-q", "-t", "-A", "-c",
        `select count(*) from pg_stat_activity where application_name = '${RACE_APP_B}' and wait_event_type = 'Lock';`,
      ]);
      if (pollResult.stdout.trim() === "1") {
        raceBObservedWaitingOnLock = true;
        break;
      }
      await sleepMs(150);
    }

    if (!raceBObservedWaitingOnLock) {
      raceHardFailure =
        "session B was never observed in pg_stat_activity with wait_event_type='Lock' while session A's transaction was open -- refusing to accept an assumed overlap as proof of real lock contention.";
    }

    await withTimeout(
      Promise.all([raceA.done, raceB.done]),
      20000,
      "both session A and session B to fully exit after A's COMMIT"
    );
  } catch (err) {
    raceHardFailure = raceHardFailure ?? (err instanceof Error ? err.message : String(err));
  } finally {
    writeFileSync(path.join(scratchDir, "17-race-a.out.log"), raceA.stdout);
    writeFileSync(path.join(scratchDir, "17-race-a.err.log"), raceA.stderr);
    if (raceB) {
      writeFileSync(path.join(scratchDir, "18-race-b.out.log"), raceB.stdout);
      writeFileSync(path.join(scratchDir, "18-race-b.err.log"), raceB.stderr);
    }
  }

  if (raceHardFailure !== null) {
    throw new Error(`race scenario hard failure (fixtures and stack preserved for diagnosis): ${raceHardFailure}`);
  }

  // Every race_* condition is captured into its own boolean BEFORE being
  // handed to checkRoster -- checkRoster/rosterUsed only track that a
  // name was INVOKED exactly once (for the roster-completeness proof),
  // never whether it PASSED. Cleanup below is gated on these captured
  // booleans directly, never on rosterUsed membership, which would be
  // true regardless of pass/fail and would silently defeat "cleanup
  // only if every race_* assertion passed".
  const raceBObservedWaitingOnLockPass = raceBObservedWaitingOnLock;
  checkRoster("race_b_observed_waiting_on_lock", raceBObservedWaitingOnLockPass);

  const raceAMarkers = parseMarkers(raceA.stdout);
  const raceBMarkers = parseMarkers(raceB!.stdout);
  const ra = (label: string) => raceAMarkers.get(label) ?? "<MISSING>";
  const rb = (label: string) => raceBMarkers.get(label) ?? "<MISSING>";

  const raceAExitZeroPass = (await raceA.done).code === 0;
  checkRoster("race_a_exit_zero", raceAExitZeroPass);
  const raceBExitZeroPass = (await raceB!.done).code === 0;
  checkRoster("race_b_exit_zero", raceBExitZeroPass);
  const raceNoRawPostgresErrorPass = !/ERROR:/i.test(raceA.stderr) && !/ERROR:/i.test(raceB!.stderr);
  checkRoster(
    "race_no_raw_postgres_error",
    raceNoRawPostgresErrorPass,
    `a_stderr_has_error=${/ERROR:/i.test(raceA.stderr)} b_stderr_has_error=${/ERROR:/i.test(raceB!.stderr)}`
  );
  const raceDistinctBackendPidsPass =
    ra("race_a_pid") !== "<MISSING>" && rb("race_b_pid") !== "<MISSING>" && ra("race_a_pid") !== rb("race_b_pid");
  checkRoster(
    "race_distinct_backend_pids",
    raceDistinctBackendPidsPass,
    `a_pid=${ra("race_a_pid")} b_pid=${rb("race_b_pid")}`
  );

  // If the real SQL statuses ever used different spellings than the ones
  // read directly out of 0051/0053 earlier in this same review
  // ('RESERVED', 'ALREADY_RETRIED'), these two assertions would need the
  // harness corrected -- not the expected value silently adjusted.
  const raceAStatusReservedPass = ra("race_a_status") === "RESERVED";
  checkRoster("race_a_status_reserved", raceAStatusReservedPass, `actual=${ra("race_a_status")}`);
  const raceBStatusAlreadyRetriedPass = rb("race_b_status") === "ALREADY_RETRIED";
  checkRoster("race_b_status_already_retried", raceBStatusAlreadyRetriedPass, `actual=${rb("race_b_status")}`);
  const raceSameChildIdPass = ra("race_a_child_id") !== "<MISSING>" && ra("race_a_child_id") === rb("race_b_child_id");
  checkRoster(
    "race_same_child_id",
    raceSameChildIdPass,
    `a=${ra("race_a_child_id")} b=${rb("race_b_child_id")}`
  );
  const raceChildGenerationIsNPlus1Pass = ra("race_a_generation") === "2" && rb("race_b_generation") === "2";
  checkRoster(
    "race_child_generation_is_n_plus_1",
    raceChildGenerationIsNPlus1Pass,
    `a=${ra("race_a_generation")} b=${rb("race_b_generation")}`
  );

  const raceVerifySql = `
\\pset pager off
SET ROLE service_role;
select count(*)::text as race_child_count from protocol_external_calls where retry_of_external_call_id = '${raceSourceId}' \\gset
\\echo '##R## race_child_count' :race_child_count
`;
  writeFileSync(path.join(scratchDir, "19-race-verify.sql"), raceVerifySql);
  const { stdout: raceVerifyOutput } = runPsql(path.join(scratchDir, "19-race-verify.sql"), "stop", "19-race-verify");
  const raceVerify = parseMarkers(raceVerifyOutput);
  const raceExactlyOneChildPass = raceVerify.get("race_child_count") === "1";
  checkRoster("race_exactly_one_child", raceExactlyOneChildPass);

  // No scenario-local cleanup here, on any outcome: this scenario
  // necessarily COMMITs on both sides (real cross-process lock
  // contention requires a real commit, never a ROLLBACK), so its
  // fixture is genuinely persisted -- but cleanup decisions belong
  // solely to main()'s single global verdict gate now. On global
  // success, the entire disposable stack (including this fixture's
  // data) is torn down by `supabase stop`; on any failure anywhere in
  // the file, main() throws before any cleanup runs, so this fixture
  // remains available for diagnosis, exactly like every other
  // scenario's own data.

  // ======================================================================
  // Roster completeness: every declared ROSTER_NAMES entry must have been
  // used by exactly one checkRoster() call above -- catches a forgotten
  // assertion just as surely as checkRoster()'s own membership/no-reuse
  // guards catch an unplanned or duplicated one.
  // ======================================================================
  {
    const unused = ROSTER_NAMES.filter((n) => !rosterUsed.has(n));
    check(
      "preflight: every name in ROSTER_NAMES was used by exactly one checkRoster() call -- none left unregistered",
      unused.length === 0,
      unused.length > 0 ? `unused=${JSON.stringify(unused)}` : ""
    );
    console.log(`\nRoster: ${ROSTER_NAMES.length} declared assertion names, ${rosterUsed.size} used, 0 duplicates, 0 unused.`);
    console.log("Full roster:");
    for (const n of ROSTER_NAMES) console.log(`  - ${n}`);
  }

  console.log("\nAll scenarios evaluated -- see per-scenario .out/.err files in the workdir for full raw output.");
}

main();
