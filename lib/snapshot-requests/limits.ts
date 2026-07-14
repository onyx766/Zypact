import type {
  CreateSnapshotRequestInput,
  SnapshotRequest,
  SnapshotRequestLimitCode,
} from "@/lib/db/types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const RECENT_REQUEST_STATUSES = new Set<SnapshotRequest["status"]>([
  "pending_verification",
  "verified",
  "pending_approval",
  "approved",
  "queued",
  "running",
  "quality_review",
  "needs_founder_review",
  "report_ready",
]);

const ACTIVE_REQUEST_STATUSES = new Set<SnapshotRequest["status"]>([
  "pending_verification",
  "verified",
  "pending_approval",
  "approved",
  "queued",
  "running",
  "quality_review",
  "needs_founder_review",
]);

export type SnapshotRequestLimitDecision =
  | { ok: true }
  | {
      ok: false;
      code: SnapshotRequestLimitCode;
    };

export function evaluateSnapshotRequestLimits(
  existing: SnapshotRequest[],
  input: CreateSnapshotRequestInput,
  now = new Date()
): SnapshotRequestLimitDecision {
  const nowMs = now.getTime();
  const thirtyDayCutoff = nowMs - THIRTY_DAYS_MS;
  const oneDayCutoff = nowMs - ONE_DAY_MS;

  const createdAtMs = (request: SnapshotRequest) =>
    new Date(request.createdAt).getTime();

  const recentEmailRequest = existing.some(
    (request) =>
      request.normalizedEmail === input.normalizedEmail &&
      createdAtMs(request) >= thirtyDayCutoff &&
      RECENT_REQUEST_STATUSES.has(request.status)
  );

  if (recentEmailRequest) {
    return {
      ok: false,
      code: "email_30d",
    };
  }

  const recentDomainRequest = existing.some(
    (request) =>
      request.normalizedDomain === input.normalizedDomain &&
      createdAtMs(request) >= thirtyDayCutoff &&
      RECENT_REQUEST_STATUSES.has(request.status)
  );

  if (recentDomainRequest) {
    return {
      ok: false,
      code: "domain_30d",
    };
  }

  const activeDomainRequest = existing.some(
    (request) =>
      request.normalizedDomain === input.normalizedDomain &&
      ACTIVE_REQUEST_STATUSES.has(request.status)
  );

  if (activeDomainRequest) {
    return {
      ok: false,
      code: "active_domain",
    };
  }

  if (input.requestIpHash) {
    const dailyIpRequestCount = existing.filter(
      (request) =>
        request.requestIpHash === input.requestIpHash &&
        createdAtMs(request) >= oneDayCutoff
    ).length;

    if (dailyIpRequestCount >= 3) {
      return {
        ok: false,
        code: "ip_daily",
      };
    }
  }

  return { ok: true };
}
