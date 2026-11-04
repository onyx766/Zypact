#!/usr/bin/env tsx
/**
 * QS2-15 — the change-scope check for the Q2′-2 pull request.
 *
 * Q2P2_SCOPE_BASE must name the commit the change is reviewed against (in CI,
 * the pull request's base SHA; locally, e.g. origin/main). The scope is every
 * path changed between the merge base of Q2P2_SCOPE_BASE and HEAD and the
 * working tree, plus untracked files. Every one of them must be on the
 * approved Q2′-2 allowlist. A missing or unresolvable base, or a base that
 * shares no history with HEAD, fails; nothing is ever skipped.
 *
 * This is specific to changes that touch Q2′-2 (its CI workflow runs only when
 * the Q2′-2 migration file is in the diff). The persistent schema contract is
 * scripts/test-q2p2-schema-contract.ts.
 *
 * `git` only. No database, no network.
 */
import { execFileSync } from "node:child_process";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const ROOT = process.cwd();
const SCOPE_BASE = (process.env.Q2P2_SCOPE_BASE ?? "").trim();
const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const tryGit = (args: string[]): string | null => {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
};

/** The approved Q2′-2 file allowlist (Revision 2 §4). */
const ALLOWED = new Set([
  "scripts/test-q2p2-schema-contract.ts",
  "scripts/test-q2p2-scope.ts",
  ".github/workflows/q2p2-scope.yml",
  ".github/workflows/q2p-schema-contract.yml",
  "scripts/sql/level2-q2p2-fixtures.sql",
  "scripts/test-snapshot-worker-postgres-level2.sh",
  "scripts/test-q2p-supabase-stack-sv1.ts",
  "package.json",
  "docs/CURRENT_STATUS.md",
  "docs/DECISIONS.md",
]);
const allowed = (p: string) => /^supabase\/migrations\/\d{14}_q2p2_[a-z0-9_]+\.sql$/.test(p) || ALLOWED.has(p);

console.log(`[QS2-15] changed paths since the merge base with ${SCOPE_BASE || "(no base supplied)"}`);
const baseSha = SCOPE_BASE ? tryGit(["rev-parse", "--verify", "--quiet", `${SCOPE_BASE}^{commit}`]) : null;
const mergeBase = baseSha ? tryGit(["merge-base", baseSha, "HEAD"]) : null;
assert("QS2-15 a scope base is supplied (Q2P2_SCOPE_BASE) and resolves to a commit", !!baseSha,
  SCOPE_BASE ? `cannot resolve ${SCOPE_BASE}` : "Q2P2_SCOPE_BASE is not set");
assert("QS2-15 the scope base shares history with HEAD (a merge base exists)", !!mergeBase);
const changed = new Set(mergeBase ? [
  ...git(["diff", "--name-only", mergeBase]).split("\n"),
  ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
].filter(Boolean) : []);
console.log(`  merge base ${mergeBase ? mergeBase.slice(0, 12) : "none"}; ${changed.size} changed path(s)`);
const outside = [...changed].filter((p) => !allowed(p));
assert("QS2-15 every changed path is on the Q2′-2 allowlist", !!mergeBase && outside.length === 0,
  mergeBase ? outside.join(",") : "no scope computed");
assert("QS2-15 exactly one Q2′-2 migration is added", [...changed].filter((p) => /^supabase\/migrations\/\d{14}_q2p2_/.test(p)).length === 1);
assert("QS2-15 no PG-9 file changed", ![...changed].some((p) => /pg9/i.test(p)));
assert("QS2-15 no existing migration changed",
  ![...changed].some((p) => p.startsWith("supabase/migrations/") && !/_q2p2_/.test(p)));
assert("QS2-15 no application code changed", ![...changed].some((p) => /^(app|lib|components)\//.test(p)));
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nQ2′-2 change scope (QS2-15) PASSED."
    : `\n${failures} check(s) failed. Q2′-2 change scope (QS2-15) FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
