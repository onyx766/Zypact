/**
 * PR-2 — what the running worker can say about the image it came from.
 *
 * The image build (Dockerfile.worker) takes one build argument, GIT_SHA,
 * refuses any value that is not a full 40-character lowercase commit SHA,
 * and records it twice: as ZYPACT_BUILD_GIT_SHA in the image environment,
 * and, with the digest of the source files actually copied into the image
 * (lib/protocol-worker/source-digest.ts), in `build-provenance.json`. This
 * module reads those two records back and states whether they agree.
 *
 * Pure, like execution-mode.ts and runtime-bound.ts: it imports nothing,
 * and the one file read is injected, so the disabled worker can evaluate it
 * and stay exactly as inert. A malformed or disagreeing record is reported
 * as `inconsistent` with both values withheld — never echoed into a log or
 * a health response.
 */

/** Written by the image build next to package.json, in the image WORKDIR. */
export const PROVENANCE_FILE = "build-provenance.json";

/** The version of the source-digest algorithm, carried in every digest. */
export const SOURCE_DIGEST_VERSION = "wsd-1";

const GIT_SHA = /^[0-9a-f]{40}$/;
const SOURCE_DIGEST = /^wsd-1:[0-9a-f]{64}$/;

export function isValidGitSha(value: unknown): value is string {
  return typeof value === "string" && GIT_SHA.test(value);
}

export function isValidSourceDigest(value: unknown): value is string {
  return typeof value === "string" && SOURCE_DIGEST.test(value);
}

/**
 * `recorded`: the image environment and the provenance file both carry a
 * valid SHA, the same one, with a valid source digest.
 * `absent`: neither exists — a worker run from a checkout, not an image.
 * `inconsistent`: anything else.
 */
export type ProvenanceStatus = "recorded" | "absent" | "inconsistent";

export interface BuildProvenance {
  provenance: ProvenanceStatus;
  gitSha: string | null;
  sourceDigest: string | null;
}

const INCONSISTENT: BuildProvenance = { provenance: "inconsistent", gitSha: null, sourceDigest: null };

/**
 * `readText` returns the file's text, or null when it does not exist or
 * cannot be read.
 */
export function readBuildProvenance(
  env: Readonly<Record<string, string | undefined>>,
  readText: (path: string) => string | null,
): BuildProvenance {
  const envSha = env.ZYPACT_BUILD_GIT_SHA;
  const text = readText(PROVENANCE_FILE);
  if ((envSha === undefined || envSha === "") && text === null) {
    return { provenance: "absent", gitSha: null, sourceDigest: null };
  }
  if (!isValidGitSha(envSha) || text === null) return INCONSISTENT;

  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return INCONSISTENT;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return INCONSISTENT;
  const r = record as Record<string, unknown>;
  if (r.version !== SOURCE_DIGEST_VERSION || r.gitSha !== envSha || !isValidSourceDigest(r.sourceDigest)) {
    return INCONSISTENT;
  }
  return { provenance: "recorded", gitSha: envSha, sourceDigest: r.sourceDigest };
}
