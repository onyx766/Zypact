/**
 * Write mode for the two protected snapshot tables.
 *
 * Snapshot report writes are RPC-only. There is exactly one supported mode,
 * and this module exists now to *enforce* that rather than to select between
 * alternatives.
 *
 * The `direct` mode this module once offered was a temporary deployment
 * compatibility path, needed only while a database still lacked migrations
 * 0030 and 0031. That window is closed: migration 0032 revoked direct
 * INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER on
 * `snapshot_requests` and `snapshot_report_artifacts` from `service_role`,
 * so direct DML is permission-denied at the database. Application code that
 * attempted it would fail with SQLSTATE 42501 rather than fall back to
 * anything useful.
 *
 * Because direct writes are now impossible rather than merely discouraged,
 * `direct` is rejected as a configuration error instead of being honoured.
 * Silently accepting it and then writing through RPCs anyway would hide a
 * real operator mistake.
 *
 * Deployment semantics that still matter:
 *
 *   - Changing this variable on Vercel affects only NEW deployments.
 *   - The variable may be omitted entirely; absence resolves to `rpc`.
 *   - It must stay set to `rpc` in any environment running code that
 *     predates this change, because that older code defaults to `direct`.
 *
 * There is deliberately no fallback: an RPC failure is never retried as
 * direct DML, because a business-rule refusal (delivered artifact, wrong
 * ownership) is indistinguishable in kind from an infrastructure error, and
 * guessing wrong would bypass exactly the protections 0031 and 0032 added.
 */

/**
 * The only supported mode. Declared as a single-member union so application
 * code cannot represent a direct write as a valid operational state — a
 * reintroduced direct branch would not typecheck.
 */
export type SnapshotReportWriteMode = "rpc";

export const SNAPSHOT_REPORT_WRITE_MODE_ENV_VAR =
  "SNAPSHOT_REPORT_WRITE_MODE";

/**
 * Why a configured value was rejected. Reported as a category so the raw
 * environment value is never echoed back into logs or error surfaces.
 */
export type SnapshotWriteModeFailure =
  | "direct-no-longer-supported"
  | "unsupported-value";

export class SnapshotWriteModeConfigurationError extends Error {
  readonly failure: SnapshotWriteModeFailure;

  constructor(failure: SnapshotWriteModeFailure = "unsupported-value") {
    super(
      failure === "direct-no-longer-supported"
        ? `${SNAPSHOT_REPORT_WRITE_MODE_ENV_VAR} is set to "direct", which is ` +
            "no longer supported. Snapshot report writes go through the " +
            "SECURITY DEFINER RPCs only, and migration 0032 revoked the " +
            "direct table privileges that mode relied on. Set the variable " +
            'to "rpc" or remove it entirely.'
        : `Invalid ${SNAPSHOT_REPORT_WRITE_MODE_ENV_VAR}. The only supported ` +
            'value is exactly "rpc"; the variable may also be omitted. ' +
            "Snapshot report writes are RPC-only."
    );
    this.name = "SnapshotWriteModeConfigurationError";
    this.failure = failure;
  }
}

/**
 * Resolve the write mode from an environment snapshot.
 *
 * Missing or blank resolves to `rpc` — the safe direction, because RPC is
 * now the only mode that can succeed against the database. Any other value
 * must match `"rpc"` exactly: `"RPC"`, `" rpc "`, and typos all throw rather
 * than being normalized, so a misconfigured environment fails loudly instead
 * of running under an assumption its operator did not make.
 *
 * `VERCEL_ENV` is deliberately not consulted: configuration must be an
 * explicit operator decision, never inferred.
 */
export interface SnapshotWriteModeEnv {
  readonly SNAPSHOT_REPORT_WRITE_MODE?: string | undefined;
  readonly [key: string]: string | undefined;
}

export function resolveSnapshotReportWriteMode(
  env: SnapshotWriteModeEnv
): SnapshotReportWriteMode {
  const raw = env.SNAPSHOT_REPORT_WRITE_MODE;

  if (raw === undefined || raw.trim() === "") {
    return "rpc";
  }

  if (raw === "rpc") return "rpc";

  throw new SnapshotWriteModeConfigurationError(
    raw === "direct" ? "direct-no-longer-supported" : "unsupported-value"
  );
}

/**
 * Read and validate the mode at call time, never at module import, so a
 * deployment can be reasoned about per operation and tests can exercise
 * configuration without module-cache tricks.
 *
 * Callers do not branch on the result — there is nothing to branch on. This
 * is called for its validating side effect, so an environment configured
 * with an unsupported value fails at the moment a write is attempted rather
 * than writing under an unintended configuration.
 */
export function snapshotReportWriteMode(): SnapshotReportWriteMode {
  return resolveSnapshotReportWriteMode(process.env);
}
