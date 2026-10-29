/**
 * PR-2 — Fly worker image provenance, offline.
 *
 *   [1] SHA and digest validation;
 *   [2] readBuildProvenance: recorded, absent, and every inconsistent shape
 *       — never echoing a malformed or disagreeing value;
 *   [3] the wsd-1 digest: order-independent, path- and byte-sensitive,
 *       over exactly the .dockerignore allow-list;
 *   [4] correspondence: the digest of HEAD's tree extracted from git
 *       (`git archive`) equals sourceDigestAtCommit(HEAD), computed from
 *       git objects; one edited byte or one untracked file breaks it;
 *   [5] writeImageProvenance, the build step: refuses a missing, malformed,
 *       abbreviated or uppercase SHA and writes nothing; writes a record the
 *       runtime reads back as `recorded`; refuses to overwrite it;
 *   [6] the verification CLI agrees with [4];
 *   [7] the entrypoint reports provenance in both modes, leaves /readyz
 *       unchanged, and never loads the digest code or child_process;
 *   [8] live mode refuses to start unless provenance is `recorded`: a real
 *       worker process with absent or inconsistent provenance exits 78
 *       before any module that could claim, reserve or send is loaded,
 *       with no network attempt and no value echoed;
 *   [9] traversal fails closed on a symlink under lib/ (an untracked one,
 *       as a stray build context would carry), so the build step refuses.
 *
 * The Docker half (fail-closed builds, label, record, /healthz inside the
 * image) is in test-m0-worker-hosting-contract.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVENANCE_FILE,
  isValidGitSha,
  isValidSourceDigest,
  liveStartRefusal,
  readBuildProvenance,
} from "@/lib/protocol-worker/build-provenance";
import {
  SOURCE_ROOTS,
  includedInSource,
  sourceDigest,
  sourceDigestOfDirectory,
  writeImageProvenance,
} from "@/lib/protocol-worker/source-digest";
import { sourceDigestAtCommit } from "./worker-provenance-git";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const DIGEST = `wsd-1:${"a".repeat(64)}`;
const rec = (o: Record<string, unknown>) => JSON.stringify(o);

console.log("\nPR-2 — worker image provenance\n");

/* ═══════ [1] validation ═══════ */
console.log("[1] Validation");
check("a full lowercase SHA is valid", isValidGitSha(SHA));
for (const [label, v] of [["empty", ""], ["abbreviated", SHA.slice(0, 12)], ["uppercase", SHA.toUpperCase()],
  ["41 characters", `${SHA}0`], ["non-hex", `${SHA.slice(0, 39)}g`], ["undefined", undefined], ["a number", 42]] as const) {
  check(`a ${label} SHA is invalid`, !isValidGitSha(v));
}
check("a wsd-1 digest is valid", isValidSourceDigest(DIGEST));
check("a digest without its version, or another version, is invalid",
  !isValidSourceDigest("a".repeat(64)) && !isValidSourceDigest(`wsd-2:${"a".repeat(64)}`) && !isValidSourceDigest(`wsd-1:${"A".repeat(64)}`));

/* ═══════ [2] readBuildProvenance ═══════ */
console.log("\n[2] readBuildProvenance");
{
  const reads: string[] = [];
  const reader = (text: string | null) => (p: string) => { reads.push(p); return text; };
  const good = rec({ version: "wsd-1", gitSha: SHA, sourceDigest: DIGEST });
  const r = readBuildProvenance({ ZYPACT_BUILD_GIT_SHA: SHA }, reader(good));
  check("env + matching record → recorded, with both values",
    r.provenance === "recorded" && r.gitSha === SHA && r.sourceDigest === DIGEST, JSON.stringify(r));
  check("the only file read is the provenance record", reads.length === 1 && reads[0] === PROVENANCE_FILE, reads.join(","));
  const absent = readBuildProvenance({}, reader(null));
  check("neither env nor record → absent, nulls", absent.provenance === "absent" && absent.gitSha === null && absent.sourceDigest === null);
  const inconsistent: Array<[string, Record<string, string | undefined>, string | null]> = [
    ["record without env", {}, good],
    ["env without record", { ZYPACT_BUILD_GIT_SHA: SHA }, null],
    ["env and record disagree", { ZYPACT_BUILD_GIT_SHA: OTHER }, good],
    ["malformed env SHA", { ZYPACT_BUILD_GIT_SHA: "not-a-sha" }, good],
    ["record is not JSON", { ZYPACT_BUILD_GIT_SHA: SHA }, "{oops"],
    ["record is an array", { ZYPACT_BUILD_GIT_SHA: SHA }, "[]"],
    ["record has another version", { ZYPACT_BUILD_GIT_SHA: SHA }, rec({ version: "wsd-2", gitSha: SHA, sourceDigest: DIGEST })],
    ["record has a malformed digest", { ZYPACT_BUILD_GIT_SHA: SHA }, rec({ version: "wsd-1", gitSha: SHA, sourceDigest: "x" })],
  ];
  for (const [label, env, text] of inconsistent) {
    const x = readBuildProvenance(env, () => text);
    check(`${label} → inconsistent, values withheld`,
      x.provenance === "inconsistent" && x.gitSha === null && x.sourceDigest === null, JSON.stringify(x));
  }
}

/* ═══════ [3] the digest ═══════ */
console.log("\n[3] The wsd-1 digest");
{
  const a = { path: "lib/a.ts", sha256: "1".repeat(64) };
  const b = { path: "package.json", sha256: "2".repeat(64) };
  check("order-independent", sourceDigest([a, b]) === sourceDigest([b, a]));
  check("sensitive to a file's bytes", sourceDigest([a, b]) !== sourceDigest([{ ...a, sha256: "3".repeat(64) }, b]));
  check("sensitive to a file's path", sourceDigest([a, b]) !== sourceDigest([{ ...a, path: "lib/b.ts" }, b]));
  check("sensitive to an added file", sourceDigest([a, b]) !== sourceDigest([a, b, { path: "lib/c.ts", sha256: "4".repeat(64) }]));
  check("files outside the image source do not count",
    sourceDigest([a, b]) === sourceDigest([a, b, { path: "app/page.tsx", sha256: "5".repeat(64) }]));
  check("a digest is versioned", isValidSourceDigest(sourceDigest([a, b])));
  for (const p of ["package.json", "package-lock.json", "tsconfig.json", "lib/x/y.ts", "lib/x.sql", "scripts/run-protocol-worker.ts"]) {
    check(`\`${p}\` is image source`, includedInSource(p));
  }
  for (const p of ["scripts/other.ts", "app/page.tsx", "libx/a.ts", ".env", "docs/x.md", "supabase/migrations/0001.sql"]) {
    check(`\`${p}\` is not image source`, !includedInSource(p));
  }
  const ignore = readFileSync(".dockerignore", "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("!")).map((l) => l.slice(1));
  check("SOURCE_ROOTS is exactly the .dockerignore allow-list",
    ignore.length === SOURCE_ROOTS.length && SOURCE_ROOTS.every((r) => ignore.includes(r)), ignore.join(","));
}

/* ═══════ [4] correspondence with git ═══════ */
console.log("\n[4] The recorded digest corresponds to the commit's source");
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const tmp = mkdtempSync(path.join(os.tmpdir(), "zypact-provenance-"));
try {
  const roots = SOURCE_ROOTS.map((r) => r.replace(/\/$/, ""));
  const tar = spawnSync("git", ["archive", "--format=tar", head, "--", ...roots], { maxBuffer: 256 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", tmp], { input: tar.stdout });
  check("HEAD's image source extracted from git", tar.status === 0 && untar.status === 0 && existsSync(path.join(tmp, "lib")),
    `${tar.status}/${untar.status}`);
  const fromGit = sourceDigestAtCommit(head);
  const fromFiles = sourceDigestOfDirectory(tmp);
  check("digest from git objects == digest of the same tree on disk", fromGit === fromFiles, `${fromGit} vs ${fromFiles}`);

  const target = path.join(tmp, "lib", "protocol-worker", "worker.ts");
  const original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from(" ")]));
  check("one edited byte breaks it", sourceDigestOfDirectory(tmp) !== fromGit);
  writeFileSync(target, original);
  check("…and restoring the byte restores it", sourceDigestOfDirectory(tmp) === fromGit);
  const stray = path.join(tmp, "lib", ".DS_Store");
  writeFileSync(stray, "x");
  check("one untracked file under lib/ breaks it", sourceDigestOfDirectory(tmp) !== fromGit);
  rmSync(stray);
  writeFileSync(path.join(tmp, "README.md"), "outside the image");
  check("a file outside the image source does not", sourceDigestOfDirectory(tmp) === fromGit);
  let threw = false;
  try { sourceDigestAtCommit("abc"); } catch { threw = true; }
  check("a malformed SHA is refused by the git side", threw);
  threw = false;
  try { sourceDigestAtCommit("0".repeat(40)); } catch { threw = true; }
  check("an unknown commit is refused by the git side", threw);

  /* ═══════ [5] writeImageProvenance ═══════ */
  console.log("\n[5] writeImageProvenance (the image build step)");
  for (const [label, v] of [["missing", undefined], ["empty", ""], ["malformed", "not-a-commit"],
    ["abbreviated", head.slice(0, 12)], ["uppercase", head.toUpperCase()]] as const) {
    let refused = false;
    try { writeImageProvenance(tmp, v); } catch (e) { refused = /GIT_SHA must be passed/.test(String(e)); }
    check(`a ${label} SHA fails the build step and writes nothing`, refused && !existsSync(path.join(tmp, PROVENANCE_FILE)));
  }
  const written = writeImageProvenance(tmp, head);
  const onDisk = JSON.parse(readFileSync(path.join(tmp, PROVENANCE_FILE), "utf8")) as Record<string, unknown>;
  check("a valid SHA writes {version, gitSha, sourceDigest}",
    onDisk.version === "wsd-1" && onDisk.gitSha === head && onDisk.sourceDigest === fromGit && written.sourceDigest === fromGit,
    JSON.stringify(onDisk));
  check("the record itself is not part of the digest", sourceDigestOfDirectory(tmp) === fromGit);
  const back = readBuildProvenance({ ZYPACT_BUILD_GIT_SHA: head }, (p) => readFileSync(path.join(tmp, p), "utf8"));
  check("the runtime reads it back as recorded, with the same values",
    back.provenance === "recorded" && back.gitSha === head && back.sourceDigest === fromGit, JSON.stringify(back));
  let overwrite = false;
  try { writeImageProvenance(tmp, head); } catch { overwrite = true; }
  check("an existing record is never overwritten", overwrite);

  /* ═══════ [6] the verification CLI ═══════ */
  console.log("\n[6] verify-worker-provenance");
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-worker-provenance.ts", ...args], { encoding: "utf8" });
  const printed = cli(head);
  check("prints the digest git computes for the commit", printed.status === 0 && printed.stdout.trim() === fromGit, printed.stdout.trim());
  check("--digest with that digest matches", cli(head, "--digest", fromGit).status === 0);
  check("--digest with another digest is a mismatch (exit 1)", cli(head, "--digest", DIGEST).status === 1);
  check("a malformed SHA is a usage error (exit 2)", cli("abc").status === 2);
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...roots], { encoding: "utf8" }).stdout.trim() !== "";
  const wt = cli(head, "--worktree");
  check(`--worktree reports ${dirty ? "a dirty" : "a clean"} build context correctly`, wt.status === (dirty ? 1 : 0), wt.stdout.trim());
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ═══════ [7] the entrypoint ═══════ */
console.log("\n[7] The entrypoint");
{
  const entry = readFileSync("scripts/run-protocol-worker.ts", "utf8");
  const disabled = entry.slice(entry.indexOf("async function runDisabled"), entry.indexOf("async function runLive"));
  const live = entry.slice(entry.indexOf("async function runLive"), entry.indexOf("async function main"));
  const main = entry.slice(entry.indexOf("async function main"));
  check("provenance is read once, in main, before either branch",
    (entry.match(/readBuildProvenance\(/g) ?? []).length === 1
      && main.indexOf("readBuildProvenance(") >= 0 && main.indexOf("readBuildProvenance(") < main.indexOf("await runDisabled("));
  check("the disabled start event and /healthz carry it",
    /log\("worker_execution_disabled", \{[^}]*\.\.\.build \}\)/.test(disabled) && /healthz: \{ ready: true, executionEnabled: false, \.\.\.build \}/.test(disabled));
  check("the live start event and /healthz carry it",
    /maxRuntimeSeconds: cfg\.maxRuntimeSeconds,\s*executionEnabled: true,\s*\.\.\.build,/.test(live) && /healthz: \{ \.\.\.healthRef\.snapshot\(\), \.\.\.build \}/.test(live));
  check("/readyz is unchanged in both modes",
    /readyz: \{ ready: true, executionEnabled: false \}/.test(disabled) && /readyz: \{ ready \}/.test(live));
  check("the entrypoint never loads the digest code or child_process",
    !/source-digest|worker-provenance-git|child_process/.test(entry));
  const refusalAt = main.indexOf("const refusal = liveStartRefusal(build);");
  check("the live refusal sits in main, after the disabled return and before runLive (so before every dynamic import)",
    refusalAt > main.indexOf("await runDisabled(") && refusalAt < main.indexOf("await runLive(plan.config, build)")
      && /if \(refusal !== null\) \{[\s\S]{0,400}?process\.exit\(78\);/.test(main)
      && entry.indexOf("import(\"@/lib/db\")") > entry.indexOf("async function runLive"));
}

/* ═══════ [8] live mode refuses unrecorded provenance ═══════ */
console.log("\n[8] Live mode refuses absent or inconsistent provenance");
check("recorded → may start", liveStartRefusal({ provenance: "recorded", gitSha: SHA, sourceDigest: DIGEST }) === null);
check("absent → provenance_absent", liveStartRefusal({ provenance: "absent", gitSha: null, sourceDigest: null }) === "provenance_absent");
check("inconsistent → provenance_inconsistent",
  liveStartRefusal({ provenance: "inconsistent", gitSha: null, sourceDigest: null }) === "provenance_inconsistent");
{
  // A complete, valid live configuration with sentinel credentials, run as a
  // real process from this checkout (which has no provenance record). A
  // preloaded trap reports any socket or fetch attempt.
  const REF = "abcdefghijklmnopqrst";
  const SENTINEL = "SENTINEL-CREDENTIAL-VALUE-0001";
  const liveEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? "", TZ: "UTC",
    WORKER_EXECUTION_MODE: "live", NODE_ENV: "production", ZYPACT_MOCK_MODE: "off",
    WORKER_ID: "w-1", NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    WORKER_EXPECTED_SUPABASE_PROJECT_REF: REF, WORKER_LIVE_CONFIRM: `LIVE:${REF}`,
    LLM_PROVIDER: "openai", OPENAI_MODEL: "gpt-4o-mini-2024-07-18",
    OPENAI_API_KEY: SENTINEL, PERPLEXITY_API_KEY: SENTINEL, SUPABASE_SERVICE_ROLE_KEY: SENTINEL,
    WORKER_EXIT_AFTER_CLAIMED_JOB: "true", WORKER_PROVIDER_TIMEOUT_MS: "45000",
    WORKER_LEASE_SECONDS: "60", WORKER_GRACE_MS: "10000", WORKER_MAX_RUNTIME_SECONDS: "120",
    WORKER_HEALTH_PORT: "0", ...over,
  });
  const trapDir = mkdtempSync(path.join(os.tmpdir(), "zypact-provenance-trap-"));
  try {
    const trap = path.join(trapDir, "trap.mjs");
    writeFileSync(trap, [
      'import net from "node:net";',
      "const connect = net.Socket.prototype.connect;",
      'net.Socket.prototype.connect = function (...a) { process.stderr.write("NETWORK_ATTEMPT\\n"); return connect.apply(this, a); };',
      'globalThis.fetch = async () => { process.stderr.write("NETWORK_ATTEMPT\\n"); throw new Error("trapped"); };',
    ].join("\n"));
    const runLiveWorker = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath,
      ["--import", "tsx", "--import", `file://${trap}`, "scripts/run-protocol-worker.ts"],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
    for (const [label, over, status] of [
      ["absent provenance", {}, "absent"],
      ["an env SHA with no record (inconsistent)", { ZYPACT_BUILD_GIT_SHA: SHA }, "inconsistent"],
      ["a malformed env SHA (inconsistent)", { ZYPACT_BUILD_GIT_SHA: "NOT-A-SHA-SENTINEL-0002" }, "inconsistent"],
    ] as const) {
      const r = runLiveWorker(liveEnv(over));
      const reason = status === "absent" ? "provenance_absent" : "provenance_inconsistent";
      check(`${label}: live start exits 78 with worker_provenance_refused / ${reason}`,
        r.status === 78 && r.stderr.includes('"event":"worker_provenance_refused"') && r.stderr.includes(`"reason":"${reason}"`),
        `status=${r.status} ${r.stderr.trim().slice(0, 160)}`);
      check(`${label}: nothing started — no start event, no health server, no other output`,
        r.stdout.trim() === "" && r.stderr.trim().split("\n").length === 1, `${r.stdout.slice(0, 80)} | ${r.stderr.slice(0, 80)}`);
      check(`${label}: no network attempt, so no claim, reservation or provider call`,
        !r.stderr.includes("NETWORK_ATTEMPT"));
      check(`${label}: no credential or raw value is echoed`,
        !r.stderr.includes(SENTINEL) && !r.stderr.includes("NOT-A-SHA-SENTINEL") && !r.stderr.includes(SHA));
    }
    const misconfigured = runLiveWorker(liveEnv({ WORKER_ID: "" }));
    check("configuration is still judged first: a bad live config is worker_configuration_rejected, not a provenance refusal",
      misconfigured.status === 78 && misconfigured.stderr.includes("worker_configuration_rejected")
        && !misconfigured.stderr.includes("worker_provenance_refused"), misconfigured.stderr.slice(0, 160));
    const disabled = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-protocol-worker.ts"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", TZ: "UTC", NODE_ENV: "production", WORKER_EXECUTION_MODE: "disabled", WORKER_HEALTH_PORT: "0" },
      encoding: "utf8", timeout: 8_000, killSignal: "SIGTERM",
    });
    check("disabled mode is unchanged: it still starts with absent provenance and reports it",
      /"event":"worker_execution_disabled"/.test(disabled.stdout) && /"provenance":"absent"/.test(disabled.stdout)
        && !/worker_provenance_refused/.test(disabled.stdout + disabled.stderr), disabled.stdout.slice(0, 200));
  } finally {
    rmSync(trapDir, { recursive: true, force: true });
  }
}

/* ═══════ [9] symlinks fail closed ═══════ */
console.log("\n[9] Unsupported entries fail closed");
{
  const tree = mkdtempSync(path.join(os.tmpdir(), "zypact-provenance-link-"));
  try {
    mkdirSync(path.join(tree, "lib", "protocol-worker"), { recursive: true });
    writeFileSync(path.join(tree, "package.json"), "{}");
    writeFileSync(path.join(tree, "lib", "protocol-worker", "a.ts"), "export {};");
    const clean = sourceDigestOfDirectory(tree);
    check("a tree of regular files digests", isValidSourceDigest(clean));
    writeFileSync(path.join(tree, "outside.txt"), "not image source");
    symlinkSync("../../outside.txt", path.join(tree, "lib", "protocol-worker", "link.ts"));
    let message = "";
    try { sourceDigestOfDirectory(tree); } catch (e) { message = e instanceof Error ? e.message : String(e); }
    check("an untracked symlink under lib/ makes the digest throw, naming the entry",
      /unsupported entry in the image source/.test(message) && message.includes("lib/protocol-worker/link.ts"), message);
    let built = true;
    try { writeImageProvenance(tree, SHA); } catch { built = false; }
    check("…so the image build step refuses, and writes no record", !built && !existsSync(path.join(tree, PROVENANCE_FILE)));
    symlinkSync(path.join(tree, "lib"), path.join(tree, "lib", "loop"));
    rmSync(path.join(tree, "lib", "protocol-worker", "link.ts"));
    let dirLink = "";
    try { sourceDigestOfDirectory(tree); } catch (e) { dirLink = e instanceof Error ? e.message : String(e); }
    check("a symlinked directory under lib/ is refused too (no traversal through it)", dirLink.includes("lib/loop"), dirLink);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
if (failures > 0) process.exit(1);
