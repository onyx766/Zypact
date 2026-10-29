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
 *       unchanged, and never loads the digest code or child_process.
 *
 * The Docker half (fail-closed builds, label, record, /healthz inside the
 * image) is in test-m0-worker-hosting-contract.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVENANCE_FILE,
  isValidGitSha,
  isValidSourceDigest,
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
}

console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
if (failures > 0) process.exit(1);
