/**
 * PR-2 — check a worker image's provenance against git. Read-only.
 *
 *   npm run verify:worker-provenance -- <gitSha>
 *       prints the wsd-1 source digest the image built from <gitSha> must
 *       report in /healthz (`sourceDigest`) and its startup log.
 *
 *   npm run verify:worker-provenance -- <gitSha> --digest <wsd-1:...>
 *       exits 1 unless that digest is the one <gitSha> produces — for
 *       comparing against a running image's /healthz.
 *
 *   npm run verify:worker-provenance -- <gitSha> --worktree
 *       exits 1 unless the files on disk that the image build would copy
 *       are exactly <gitSha>'s — run before building, so an edit or an
 *       untracked file under lib/ cannot ship under that commit's name.
 *
 * Never builds, deploys or contacts anything.
 */

import { sourceDigestOfDirectory } from "@/lib/protocol-worker/source-digest";
import { sourceDigestAtCommit } from "./worker-provenance-git";

function main(argv: string[]): number {
  const [gitSha, flag, value] = argv;
  if (!gitSha) {
    console.error("usage: verify-worker-provenance <gitSha> [--digest <wsd-1:...> | --worktree]");
    return 2;
  }
  let expected: string;
  try {
    expected = sourceDigestAtCommit(gitSha);
  } catch (e) {
    console.error(`cannot compute the source digest: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (flag === undefined) {
    console.log(expected);
    return 0;
  }
  if (flag === "--digest" && value) {
    const ok = value === expected;
    console.log(ok ? `match ${expected}` : `MISMATCH: ${gitSha} produces ${expected}, not ${value}`);
    return ok ? 0 : 1;
  }
  if (flag === "--worktree") {
    const onDisk = sourceDigestOfDirectory(process.cwd());
    const ok = onDisk === expected;
    console.log(ok ? `clean ${expected}` : `MISMATCH: the build context (${onDisk}) is not ${gitSha} (${expected})`);
    return ok ? 0 : 1;
  }
  console.error("unknown option");
  return 2;
}

process.exit(main(process.argv.slice(2)));
