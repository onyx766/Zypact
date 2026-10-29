/**
 * PR-2 — a digest of exactly the source files the worker image carries.
 *
 * The SHA passed to the image build is a claim; this digest is what lets
 * the claim be checked. It is computed twice, by the same function:
 *
 *   in the image build   over the files Docker actually copied
 *                        (writeImageProvenance, from Dockerfile.worker)
 *   from git             over the blobs of the claimed commit
 *                        (scripts/verify-worker-provenance.ts)
 *
 * Equal digests mean the image was built from that commit's tree, not from
 * a working copy with edits or untracked files. The file set is every
 * regular file under the .dockerignore allow-list (SOURCE_ROOTS). The
 * patterns .dockerignore re-denies after it (`*.sql`, `.env.*`,
 * `node_modules/`, ...) match only at the context root, so nothing under
 * `lib/` is filtered: what the image holds is exactly what is digested.
 * test-worker-image-provenance.ts holds SOURCE_ROOTS and the allow-list
 * together.
 *
 * Version wsd-1: for every included file, in byte order of its POSIX path,
 * the line `<path>\0<sha256 of its bytes>\n`; the digest is
 * `wsd-1:<sha256 of the concatenated lines>`.
 *
 * Not imported by the worker entrypoint: only the build and the
 * verification script use it.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  PROVENANCE_FILE,
  SOURCE_DIGEST_VERSION,
  isValidGitSha,
} from "@/lib/protocol-worker/build-provenance";

/** The .dockerignore allow-list: what the image build context admits. */
export const SOURCE_ROOTS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "lib/",
  "scripts/run-protocol-worker.ts",
] as const;

/** Whether a POSIX path relative to the repository root is part of the image source. */
export function includedInSource(rel: string): boolean {
  return SOURCE_ROOTS.some((r) => (r.endsWith("/") ? rel.startsWith(r) : rel === r));
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** The digest of a set of files, given each one's path and the SHA-256 of its bytes. */
export function sourceDigest(files: Array<{ path: string; sha256: string }>): string {
  const lines = files
    .filter((f) => includedInSource(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .join("");
  return `${SOURCE_DIGEST_VERSION}:${sha256(lines)}`;
}

/**
 * The digest of the image source as it sits on disk under `root`. Regular
 * files and directories only: a symlink, socket, FIFO or device under the
 * source roots throws, because the digest could not say what it points at
 * and the image would carry it anyway. A missing root is skipped (the git
 * side then disagrees, which the comparison reports).
 */
export function sourceDigestOfDirectory(root: string): string {
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (rel: string): void => {
    const abs = path.join(root, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) visit(rel === "" ? name : `${rel}/${name}`);
    } else if (st.isFile()) {
      if (includedInSource(rel)) files.push({ path: rel, sha256: sha256(readFileSync(abs)) });
    } else {
      throw new Error(`unsupported entry in the image source (not a regular file or directory): ${rel}`);
    }
  };
  for (const r of SOURCE_ROOTS) visit(r.replace(/\/$/, ""));
  return sourceDigest(files);
}

/**
 * Called by Dockerfile.worker during the image build. Refuses a missing or
 * malformed SHA by throwing, which fails the build: a production image
 * without provenance is never produced.
 */
export function writeImageProvenance(root: string, gitSha: string | undefined): { gitSha: string; sourceDigest: string } {
  if (!isValidGitSha(gitSha)) {
    throw new Error("GIT_SHA must be passed as a build argument: the full 40-character lowercase commit SHA.");
  }
  const record = { version: SOURCE_DIGEST_VERSION, gitSha, sourceDigest: sourceDigestOfDirectory(root) };
  writeFileSync(path.join(root, PROVENANCE_FILE), `${JSON.stringify(record)}\n`, { flag: "wx" });
  return { gitSha, sourceDigest: record.sourceDigest };
}
