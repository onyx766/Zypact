/**
 * M5-A — lease heartbeat.
 *
 * Renews at lease/3 so two consecutive failures still leave headroom. A
 * `JOB_NOT_OWNED` means the job was taken over: the caller must abandon
 * the iteration without writing anything, because it is no longer the
 * owner and every fenced RPC would reject it anyway.
 */

import type { DbAdapter } from "@/lib/db/types";
import type { WorkerHealth } from "@/lib/protocol-worker/health";

export interface HeartbeatHandle {
  /** True while ownership is still held. */
  owned(): boolean;
  stop(): void;
}

export function startHeartbeat(args: {
  db: DbAdapter;
  health: WorkerHealth;
  jobId: string;
  claimToken: string;
  projectId: string;
  leaseSeconds: number;
  onLost: () => void;
}): HeartbeatHandle {
  let stillOwned = true;
  // Single-flight: a tick arriving while a slow renewal is still in the air
  // is dropped, never queued behind it.
  let renewing = false;
  const intervalMs = Math.max(1000, Math.floor((args.leaseSeconds * 1000) / 3));

  const timer = setInterval(() => {
    void (async () => {
      if (!stillOwned || renewing) return;
      renewing = true;
      try {
        const r = await args.db.renewProtocolExecutionJobLease({
          jobId: args.jobId,
          claimToken: args.claimToken,
          projectId: args.projectId,
          leaseSeconds: args.leaseSeconds,
        });
        args.health.markDbContact();
        if (r.outcome === "RENEWED") {
          args.health.markHeartbeat();
        } else {
          stillOwned = false;
          args.onLost();
        }
      } catch {
        // A transient renewal error is not a loss of ownership; the next
        // tick retries. Only an explicit non-RENEWED outcome is decisive.
      } finally {
        renewing = false;
      }
    })();
  }, intervalMs);

  if (typeof timer.unref === "function") timer.unref();

  return {
    owned: () => stillOwned,
    stop: () => clearInterval(timer),
  };
}
