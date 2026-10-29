/**
 * PR-2 — the worker image's source digest, computed from git objects.
 *
 * The same wsd-1 digest the image build writes (lib/protocol-worker/
 * source-digest.ts), but over the blobs of a commit instead of the files on
 * disk, so it cannot see an edit or an untracked file. Read-only: `git
 * ls-tree` and `git cat-file`, nothing else. Not part of the image.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isValidGitSha } from "@/lib/protocol-worker/build-provenance";
import { SOURCE_ROOTS, sourceDigest } from "@/lib/protocol-worker/source-digest";

const git = (args: string[], cwd: string): Buffer =>
  execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * The wsd-1 digest of the image source at `gitSha`. Throws on a malformed
 * SHA, an unknown commit, or an entry the image could not reproduce
 * byte-for-byte from git (a symlink or a submodule).
 */
export function sourceDigestAtCommit(gitSha: string, cwd = process.cwd()): string {
  if (!isValidGitSha(gitSha)) throw new Error("not a full 40-character lowercase commit SHA");
  const roots = SOURCE_ROOTS.map((r) => r.replace(/\/$/, ""));
  const listing = git(["ls-tree", "-r", "-z", "--full-tree", gitSha, "--", ...roots], cwd).toString("utf8");
  const files: Array<{ path: string; sha256: string }> = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    const filePath = entry.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`unsupported entry in the image source: ${mode} ${type} ${filePath}`);
    }
    files.push({ path: filePath, sha256: createHash("sha256").update(git(["cat-file", "blob", object], cwd)).digest("hex") });
  }
  if (files.length === 0) throw new Error("the commit holds none of the image source");
  return sourceDigest(files);
}
