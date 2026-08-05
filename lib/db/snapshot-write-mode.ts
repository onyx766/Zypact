/**
 * Transitional write mode for the two protected snapshot tables.
 *
 * `direct` is a TEMPORARY DEPLOYMENT COMPATIBILITY DEFAULT, not a security
 * boundary. It exists only so application code can be merged and deployed
 * before a given database has migrations 0030 and 0031, whose RPCs the
 * `rpc` path calls. An environment still on `direct` is fully bypassable —
 * the boundary becomes real only when migration 0032 revokes direct table
 * DML from service_role.
 *
 * Deployment semantics that matter here:
 *
 *   - Changing this variable on Vercel affects only NEW deployments.
 *     Switching Preview or Production to `rpc` requires a redeploy before
 *     the new value takes effect.
 *   - Setting `rpc` against a database that lacks 0030/0031 makes every
 *     write fail with PostgREST "function not found".
 *   - Applying 0032 while an environment is still on `direct` breaks all
 *     writes in that environment.
 *
 * REMOVAL: once migration 0032 is applied to Production and Production is
 * running `rpc`, this module and every `direct` branch must be deleted.
 * The direct branches are deliberately isolated so that removal is a clean
 * subtraction rather than a rewrite.
 *
 * There is deliberately no fallback: an `rpc`-mode failure is never retried
 * as direct DML, because a business-rule refusal (delivered artifact, wrong
 * ownership) is indistinguishable in kind from an infrastructure error, and
 * guessing wrong would bypass exactly the protections 0031 added.
 */

export type SnapshotReportWriteMode = "direct" | "rpc";

export const SNAPSHOT_REPORT_WRITE_MODE_ENV_VAR =
  "SNAPSHOT_REPORT_WRITE_MODE";

export class SnapshotWriteModeConfigurationError extends Error {
  constructor() {
    super(
      `Invalid ${SNAPSHOT_REPORT_WRITE_MODE_ENV_VAR}. ` +
        'Allowed values are exactly "direct" or "rpc".'
    );
    this.name = "SnapshotWriteModeConfigurationError";
  }
}

/**
 * Resolve the write mode from an environment snapshot.
 *
 * Missing or blank resolves to `direct`. Any other value must match
 * exactly — `"RPC"`, `" rpc "`, and typos all throw rather than being
 * normalized, so a misconfigured environment fails loudly instead of
 * silently running the wrong write path.
 *
 * `VERCEL_ENV` is deliberately not consulted: the mode must be an explicit
 * operator decision, never inferred.
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
    return "direct";
  }

  if (raw === "direct") return "direct";
  if (raw === "rpc") return "rpc";

  throw new SnapshotWriteModeConfigurationError();
}

/**
 * Read the mode at call time, never at module import, so a deployment can
 * be reasoned about per operation and tests can isolate each mode without
 * module-cache tricks.
 */
export function snapshotReportWriteMode(): SnapshotReportWriteMode {
  return resolveSnapshotReportWriteMode(process.env);
}
