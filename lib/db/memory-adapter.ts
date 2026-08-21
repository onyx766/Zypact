import { randomUUID } from "node:crypto";
import { createPublicReportToken } from "@/lib/snapshot-requests/public-report-token";
import type {
  AdmitAndReserveAttemptInput,
  AdmitAndReserveAttemptResult,
  AnalysisLlmCall,
  AnalysisLlmCallInput,
  ApproveBuyerQuestionVersionInput,
  ApproveBuyerQuestionVersionResult,
  ApproveProtocolInput,
  ApproveProtocolResult,
  BackfillProbeResultDatasetIdentityInput,
  BackfillProbeResultDatasetIdentityResult,
  BuyerQuestion,
  BuyerQuestionVersion,
  CanonicalEntity,
  CanonicalEntityInput,
  Competitor,
  CompetitorInput,
  CreateBuyerQuestionInput,
  CreateBuyerQuestionVersionInput,
  CreateProjectInput,
  CreateProtocolInput,
  CreateSnapshotRequestInput,
  DatasetBatch,
  DatasetBatchInput,
  DatasetSourceType,
  DbAdapter,
  EntityAlias,
  EntityAliasOutcome,
  EntityBrandSnapshot,
  EntityObservation,
  EntityObservationOutcome,
  EntityObservationStatus,
  EntityResolutionPass,
  EntityResolutionPassRowStatus,
  EntityResolutionPassOutcome,
  EntityResolutionPassStatus,
  EntityType,
  EvidenceBankRow,
  EvidenceBankRowInput,
  FixBriefRow,
  FixBriefRowInput,
  GeneratedAssetRow,
  GeneratedAssetRowInput,
  GeneratedAssetLifecycleStatus,
  Gap,
  GapInput,
  GapMapRow,
  IssueSnapshotRequestVerificationInput,
  GeneratedPrompt,
  GeneratedPromptInput,
  MirrorProfileRow,
  ProbeFailure,
  ProbeMode,
  ProbeResult,
  ProbeRun,
  ProbeRunStatus,
  Project,
  Protocol,
  ProtocolAttempt,
  QaReportRow,
  QaReportRowInput,
  ReconcileAttemptInput,
  ReconcileAttemptResult,
  RecordProbeFailureInput,
  ResolveAndRecordEntityObservationInput,
  ResolveAndRecordEntityObservationResult,
  SaveProbeResultInput,
  SaveSnapshotReportArtifactInput,
  SnapshotReportArtifact,
  SnapshotRequest,
  SitePage,
  StartAttemptInput,
  StartAttemptResult,
  StartOrResumeEntityResolutionPassInput,
  StartOrResumeEntityResolutionPassResult,
} from "./types";
import { SnapshotRequestLimitError } from "./types";
import { evaluateSnapshotRequestLimits } from "@/lib/snapshot-requests/limits";
import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";
import { validateApprovedByUuid } from "@/lib/db/validate-approved-by-uuid";

/**
 * In-memory adapter. Used when Supabase is not configured so Sprint 1 is
 * never blocked on infra. Data lives for the life of the Node process, which
 * is fine for local dev and CLI scripts.
 *
 * On Next.js dev with hot reload the module is re-imported per route worker,
 * so state can be lost between requests. That's acceptable for Sprint 1 —
 * plug in Supabase for persistence.
 */

interface MemorySnapshotVerification {
  requestId: string;
  tokenHash: string;
  expiresAt: string;
}

interface MemoryStore {
  snapshotRequests: Map<string, SnapshotRequest>;
  snapshotVerificationsByHash: Map<string, MemorySnapshotVerification>;
  snapshotVerificationHashByRequest: Map<string, string>;
  projects: Map<string, Project>;
  sitePagesByProject: Map<string, SitePage[]>;
  mirrorProfilesByProject: Map<string, MirrorProfileRow>;
  generatedPromptsByProject: Map<string, GeneratedPrompt[]>;
  probeRuns: Map<string, ProbeRun>;
  probeResultsByProject: Map<string, ProbeResult[]>;
  analysisLlmCallsByProject: Map<string, AnalysisLlmCall[]>;
  probeFailuresByProject: Map<string, ProbeFailure[]>;
  datasetBatches: Map<string, DatasetBatch>;
  canonicalEntities: Map<string, CanonicalEntity>;
  entityAliasesByProject: Map<string, EntityAlias[]>;
  entityBrandSnapshots: Map<string, EntityBrandSnapshot>;
  entityResolutionPasses: Map<string, EntityResolutionPass>;
  entityObservations: Map<string, EntityObservation>;
  competitorsByProject: Map<string, Competitor[]>;
  gapMapsByProject: Map<string, GapMapRow[]>;
  gapsByProject: Map<string, Gap[]>;
  evidenceBanksByProject: Map<string, EvidenceBankRow>;
  fixBriefsByProject: Map<string, FixBriefRow[]>;
  generatedAssetsByProject: Map<string, GeneratedAssetRow[]>;
  qaReportsByProject: Map<string, QaReportRow[]>;
  buyerQuestions: Map<string, BuyerQuestion>;
  buyerQuestionVersions: Map<string, BuyerQuestionVersion>;
  protocols: Map<string, Protocol>;
  protocolAttempts: Map<string, ProtocolAttempt>;
}

const globalKey = "__zypact_memory_store__";

function getStore(): MemoryStore {
  const g = globalThis as unknown as Record<string, MemoryStore | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = {
      snapshotRequests: new Map(),
      snapshotVerificationsByHash: new Map(),
      snapshotVerificationHashByRequest: new Map(),
      projects: new Map(),
      sitePagesByProject: new Map(),
      mirrorProfilesByProject: new Map(),
      generatedPromptsByProject: new Map(),
      probeRuns: new Map(),
      probeResultsByProject: new Map(),
      analysisLlmCallsByProject: new Map(),
      probeFailuresByProject: new Map(),
      datasetBatches: new Map(),
      canonicalEntities: new Map(),
      entityAliasesByProject: new Map(),
      entityBrandSnapshots: new Map(),
      entityResolutionPasses: new Map(),
      entityObservations: new Map(),
      competitorsByProject: new Map(),
      gapMapsByProject: new Map(),
      gapsByProject: new Map(),
      evidenceBanksByProject: new Map(),
      fixBriefsByProject: new Map(),
      generatedAssetsByProject: new Map(),
      qaReportsByProject: new Map(),
      buyerQuestions: new Map(),
      buyerQuestionVersions: new Map(),
      protocols: new Map(),
      protocolAttempts: new Map(),
    };
  }
  return g[globalKey]!;
}

function cloneEvidenceBankInput(
  input: EvidenceBankRowInput
): EvidenceBankRowInput {
  return {
    productDescription: input.productDescription,
    targetAudience: [...input.targetAudience],
    mainUseCases: [...input.mainUseCases],
    features: input.features.map((f) => ({ ...f })),
    proofItems: input.proofItems.map((p) => ({ ...p })),
    competitors: [...input.competitors],
    allowedClaims: [...input.allowedClaims],
    forbiddenClaims: [...input.forbiddenClaims],
    tone: input.tone,
    notes: input.notes,
    provenance: input.provenance,
  };
}

const memorySnapshotReportArtifacts =
  new Map<string, SnapshotReportArtifact>();

export const memoryAdapter: DbAdapter = {
  async getSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const request =
      getStore().snapshotRequests.get(requestId);

    return request
      ? { ...request }
      : null;
  },

  async getSnapshotRequestsByProject(
    projectId: string
  ): Promise<SnapshotRequest[]> {
    return [...getStore().snapshotRequests.values()].filter(
      (r) => r.projectId === projectId
    );
  },

  async getSnapshotReportArtifact(
    requestId: string
  ): Promise<SnapshotReportArtifact | null> {
    const artifact =
      memorySnapshotReportArtifacts.get(requestId);

    return artifact
      ? { ...artifact }
      : null;
  },

  async getSnapshotReportArtifactByPublicToken(
    publicToken: string
  ): Promise<SnapshotReportArtifact | null> {
    for (const artifact of memorySnapshotReportArtifacts.values()) {
      if (artifact.publicToken === publicToken) {
        return { ...artifact };
      }
    }

    return null;
  },

  async saveSnapshotReportArtifact(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact> {
    const existing =
      memorySnapshotReportArtifacts.get(
        input.snapshotRequestId
      );

    const now = new Date().toISOString();

    const artifact: SnapshotReportArtifact = {
      id: existing?.id ?? randomUUID(),
      snapshotRequestId:
        input.snapshotRequestId,
      projectId: input.projectId,
      fullReportMarkdown:
        input.fullReportMarkdown,
      shortReportMarkdown:
        input.shortReportMarkdown,
      fullReportFilename:
        input.fullReportFilename,
      shortReportFilename:
        input.shortReportFilename,
      generatedAt: input.generatedAt,
      publicToken:
        existing?.publicToken ??
        createPublicReportToken(),
      deliveryClaimActive: false,
      deliveryClaimedAt: null,
      deliveredAt: null,
      deliveryMessageId: null,
      createdAt:
        existing?.createdAt ?? now,
      updatedAt: now,
    };

    memorySnapshotReportArtifacts.set(
      input.snapshotRequestId,
      artifact
    );

    return { ...artifact };
  },

  /**
   * Insert-only counterpart of the save path. Mirrors the SQL RPC by
   * refusing when an artifact already exists. Independent of any
   * environment variable — the write mode is a Supabase-adapter concern.
   */
  async insertSnapshotReportArtifactBackfill(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact | null> {
    if (
      memorySnapshotReportArtifacts.has(
        input.snapshotRequestId
      )
    ) {
      return null;
    }

    return this.saveSnapshotReportArtifact(input);
  },

  async markSnapshotReportDelivered(
    requestId: string,
    messageId: string,
    deliveredAt: string,
    resend: boolean
  ): Promise<SnapshotReportArtifact | null> {
    // `resend` is accepted to mirror the adapter interface. The memory
    // adapter deliberately keeps its prior unconditional behavior so the
    // existing delivery tests continue to describe the same contract; the
    // initial-versus-resend precondition is enforced in SQL.
    void resend;

    const existing =
      memorySnapshotReportArtifacts.get(requestId);

    if (!existing) {
      return null;
    }

    const updated: SnapshotReportArtifact = {
      ...existing,
      deliveredAt,
      deliveryMessageId: messageId,
      updatedAt: deliveredAt,
    };

    memorySnapshotReportArtifacts.set(
      requestId,
      updated
    );

    return { ...updated };
  },

  async rejectSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const store = getStore();

    const request =
      store.snapshotRequests.get(requestId);

    if (
      !request ||
      request.status !==
        "pending_approval"
    ) {
      return null;
    }

    const rejected: SnapshotRequest = {
      ...request,
      status: "rejected",
      progressStage: null,
      progressUpdatedAt: null,
      updatedAt:
        new Date().toISOString(),
    };

    store.snapshotRequests.set(
      requestId,
      rejected
    );

    return { ...rejected };
  },

  async listSnapshotRequests(
    limit = 100
  ): Promise<SnapshotRequest[]> {
    const safeLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      200
    );

    return [...getStore().snapshotRequests.values()]
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime()
      )
      .slice(0, safeLimit)
      .map((request) => ({ ...request }));
  },

  async createSnapshotRequest(
    input: CreateSnapshotRequestInput
  ): Promise<SnapshotRequest> {
    const store = getStore();
    const existing = [...store.snapshotRequests.values()];
    const limit = evaluateSnapshotRequestLimits(existing, input);

    if (!limit.ok) {
      throw new SnapshotRequestLimitError(limit.code);
    }

    const now = new Date().toISOString();
    const row: SnapshotRequest = {
      // Empty until founder approval supplies the frame, matching the
      // column default in migration 0034.
      competitors: [],
      id: randomUUID(),
      workEmail: input.workEmail,
      normalizedEmail: input.normalizedEmail,
      companyName: input.companyName,
      websiteUrl: input.websiteUrl,
      normalizedDomain: input.normalizedDomain,
      buyerCategory: input.buyerCategory,
      status: "pending_verification",
      requestIpHash: input.requestIpHash ?? null,
      projectId: null,
      progressStage: null,
      progressUpdatedAt: null,
      approvedAt: null,
      approvedBy: null,
      claimedBy: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    store.snapshotRequests.set(row.id, row);
    return { ...row };
  },

  async issueSnapshotRequestVerification(
    input: IssueSnapshotRequestVerificationInput
  ): Promise<boolean> {
    const store = getStore();
    const request = store.snapshotRequests.get(input.requestId);
    const expiresAtMs = new Date(input.expiresAt).getTime();

    if (
      !request ||
      request.status !== "pending_verification" ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now()
    ) {
      return false;
    }

    const existingHash =
      store.snapshotVerificationHashByRequest.get(
        input.requestId
      );

    if (existingHash) {
      store.snapshotVerificationsByHash.delete(
        existingHash
      );
    }

    const conflictingVerification =
      store.snapshotVerificationsByHash.get(
        input.tokenHash
      );

    if (
      conflictingVerification &&
      conflictingVerification.requestId !==
        input.requestId
    ) {
      throw new Error(
        "Snapshot verification token hash collision"
      );
    }

    store.snapshotVerificationsByHash.set(
      input.tokenHash,
      {
        requestId: input.requestId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      }
    );

    store.snapshotVerificationHashByRequest.set(
      input.requestId,
      input.tokenHash
    );

    return true;
  },

  async consumeSnapshotRequestVerification(
    tokenHash: string
  ): Promise<SnapshotRequest | null> {
    const store = getStore();
    const verification =
      store.snapshotVerificationsByHash.get(tokenHash);

    if (!verification) {
      return null;
    }

    const request = store.snapshotRequests.get(
      verification.requestId
    );

    const expired =
      new Date(verification.expiresAt).getTime() <=
      Date.now();

    if (
      !request ||
      request.status !== "pending_verification" ||
      expired
    ) {
      return null;
    }

    const now = new Date().toISOString();
    const verifiedRequest: SnapshotRequest = {
      ...request,
      status: "pending_approval",
      updatedAt: now,
    };

    store.snapshotRequests.set(
      verifiedRequest.id,
      verifiedRequest
    );

    store.snapshotVerificationsByHash.delete(tokenHash);
    store.snapshotVerificationHashByRequest.delete(
      verifiedRequest.id
    );

    return { ...verifiedRequest };
  },

  async failSnapshotVerificationDelivery(
    requestId: string
  ): Promise<boolean> {
    const store = getStore();
    const request = store.snapshotRequests.get(requestId);

    if (
      !request ||
      request.status !== "pending_verification"
    ) {
      return false;
    }

    const tokenHash =
      store.snapshotVerificationHashByRequest.get(
        requestId
      );

    if (tokenHash) {
      store.snapshotVerificationsByHash.delete(
        tokenHash
      );

      store.snapshotVerificationHashByRequest.delete(
        requestId
      );
    }

    const failedRequest: SnapshotRequest = {
      ...request,
      status: "failed",
      updatedAt: new Date().toISOString(),
    };

    store.snapshotRequests.set(
      requestId,
      failedRequest
    );

    return true;
  },

  async approveAndQueueSnapshotRequest(
    requestId: string,
    approvedBy: string,
    competitors: string[]
  ): Promise<SnapshotRequest | null> {
    const store = getStore();
    const request =
      store.snapshotRequests.get(requestId);

    if (!request || !approvedBy) {
      return null;
    }

    if (request.status === "queued") {
      return { ...request };
    }

    if (
      request.status !==
      "pending_approval"
    ) {
      return null;
    }

    // Mirrors `_normalize_snapshot_competitors`: trim, drop blanks,
    // deduplicate case-insensitively, keep first-seen casing and order.
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const entry of competitors ?? []) {
      if (typeof entry !== "string") return null;

      const value = entry.trim();
      if (value === "") continue;

      const key = value.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);
      normalized.push(value);
    }

    // The RPC refuses the approval outright rather than queueing a request
    // whose frame cannot drive a scan.
    if (normalized.length < 2 || normalized.length > 12) return null;

    for (const value of normalized) {
      if (value.length > 200) return null;

      if (
        value.toLowerCase() ===
          request.companyName.trim().toLowerCase() ||
        value.toLowerCase() ===
          request.normalizedDomain.trim().toLowerCase()
      ) {
        return null;
      }
    }

    const now = new Date().toISOString();

    // The database implementation records an intermediate
    // approved state inside one transaction. The in-memory
    // adapter exposes only the final queued result.
    //
    // Approval metadata is recorded here so the in-memory result matches
    // the RPC contract: `approve_and_queue_snapshot_request` sets
    // `approved_at = now()` and `updated_at = now()` in a single UPDATE,
    // so both share one timestamp. `approvedBy` is the caller's actor
    // argument, stored verbatim.
    const queuedRequest: SnapshotRequest = {
      ...request,
      competitors: normalized,
      status: "queued",
      approvedAt: now,
      approvedBy,
      updatedAt: now,
    };

    store.snapshotRequests.set(
      requestId,
      queuedRequest
    );

    return { ...queuedRequest };
  },

  async reserveSnapshotRequestProject(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const store = getStore();
    const request =
      store.snapshotRequests.get(requestId);

    if (!request) {
      return null;
    }

    // A worker owns this request. The manual runner must not attach.
    if (
      request.status === "running" &&
      request.claimToken !== null
    ) {
      return null;
    }

    if (
      request.status === "running" &&
      request.projectId
    ) {
      return { ...request };
    }

    if (request.status !== "queued") {
      return null;
    }

    let projectId = request.projectId;

    if (!projectId) {
      const project: Project = {
        id: randomUUID(),
        userId: null,
        companyName: request.companyName,
        domain: request.normalizedDomain,
        category: request.buyerCategory,
        createdAt: new Date().toISOString(),
      };

      store.projects.set(project.id, project);
      projectId = project.id;
    }

    const runningRequest: SnapshotRequest = {
      ...request,
      status: "running",
      projectId,
      progressStage: "reserved",
      progressUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.snapshotRequests.set(
      requestId,
      runningRequest
    );

    return { ...runningRequest };
  },

  /**
   * Mirrors `claim_next_snapshot_request`.
   *
   * Deterministic ordering only. Single-threaded JavaScript cannot
   * exhibit a row-lock race, so this proves the selection and lease
   * rules — never PostgreSQL `FOR UPDATE SKIP LOCKED` behavior.
   */
  async claimNextSnapshotRequest(input) {
    const workerId = input.workerId.trim();

    if (
      workerId.length < 1 ||
      workerId.length > 100
    ) {
      throw new Error("invalid_worker_id");
    }

    if (
      !Number.isInteger(input.leaseSeconds) ||
      input.leaseSeconds < 60 ||
      input.leaseSeconds > 3600
    ) {
      throw new Error("invalid_lease_seconds");
    }

    if (
      !Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 10
    ) {
      throw new Error("invalid_max_attempts");
    }

    const store = getStore();
    const now = Date.now();

    const isExpiredWorkerOwned = (
      r: SnapshotRequest
    ): boolean =>
      r.status === "running" &&
      r.claimToken !== null &&
      r.leaseExpiresAt !== null &&
      Date.parse(r.leaseExpiresAt) <= now;

    // Terminalize exhausted worker-owned requests first. Manual runs
    // (claimToken null) are never touched.
    for (const request of store.snapshotRequests.values()) {
      if (
        isExpiredWorkerOwned(request) &&
        request.attemptCount >= input.maxAttempts
      ) {
        store.snapshotRequests.set(request.id, {
          ...request,
          status: "failed",
          claimedBy: null,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const candidates = [
      ...store.snapshotRequests.values(),
    ].filter(
      (r) =>
        (isExpiredWorkerOwned(r) &&
          r.attemptCount < input.maxAttempts) ||
        r.status === "queued"
    );

    // Stale first: their paid probes are already bought.
    candidates.sort((a, b) => {
      const rank = (r: SnapshotRequest) =>
        r.status === "running" ? 0 : 1;

      if (rank(a) !== rank(b)) {
        return rank(a) - rank(b);
      }

      const created =
        Date.parse(a.createdAt) -
        Date.parse(b.createdAt);

      if (created !== 0) return created;

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const candidate = candidates[0];

    if (!candidate) {
      return null;
    }

    let projectId = candidate.projectId;

    if (!projectId) {
      const project: Project = {
        id: randomUUID(),
        userId: null,
        companyName: candidate.companyName,
        domain: candidate.normalizedDomain,
        category: candidate.buyerCategory,
        createdAt: new Date().toISOString(),
      };

      store.projects.set(project.id, project);
      projectId = project.id;
    }

    const wasQueued = candidate.status === "queued";
    const timestamp = new Date().toISOString();

    const claimed: SnapshotRequest = {
      ...candidate,
      status: "running",
      projectId,
      progressStage: wasQueued
        ? "reserved"
        : candidate.progressStage,
      progressUpdatedAt: wasQueued
        ? timestamp
        : candidate.progressUpdatedAt,
      attemptCount: candidate.attemptCount + 1,
      claimedBy: workerId,
      // Generated here, never supplied by the caller.
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(
        now + input.leaseSeconds * 1000
      ).toISOString(),
      updatedAt: timestamp,
    };

    store.snapshotRequests.set(
      claimed.id,
      claimed
    );

    return { ...claimed };
  },

  /** Mirrors `renew_snapshot_request_lease`. */
  async renewSnapshotRequestLease(input) {
    if (
      !Number.isInteger(input.leaseSeconds) ||
      input.leaseSeconds < 60 ||
      input.leaseSeconds > 3600
    ) {
      throw new Error("invalid_lease_seconds");
    }

    const store = getStore();
    const request = store.snapshotRequests.get(
      input.requestId
    );

    if (!request) {
      return null;
    }

    const now = Date.now();

    // An expired lease is lost permanently — never revived.
    if (
      request.status !== "running" ||
      request.claimedBy === null ||
      request.claimToken === null ||
      request.leaseExpiresAt === null ||
      request.claimToken !== input.claimToken ||
      Date.parse(request.leaseExpiresAt) <= now
    ) {
      return null;
    }

    const renewed: SnapshotRequest = {
      ...request,
      leaseExpiresAt: new Date(
        now + input.leaseSeconds * 1000
      ).toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.snapshotRequests.set(
      renewed.id,
      renewed
    );

    return { ...renewed };
  },

  async updateSnapshotRequestProgress(
    requestId,
    projectId,
    stage
  ) {
    const store = getStore();
    const request =
      store.snapshotRequests.get(requestId);

    if (
      !request ||
      request.status !== "running" ||
      request.projectId !== projectId
    ) {
      return null;
    }

    const ranks = {
      reserved: 1,
      crawling: 2,
      analyzing_site: 3,
      generating_questions: 4,
      checking_ai_visibility: 5,
      building_diagnosis: 6,
      quality_review: 7,
    } as const;

    const currentRank =
      request.progressStage
        ? ranks[request.progressStage]
        : 0;

    const nextRank = ranks[stage];

    if (nextRank < currentRank) {
      return null;
    }

    const now = new Date().toISOString();

    const updated: SnapshotRequest = {
      ...request,
      progressStage: stage,
      progressUpdatedAt:
        request.progressStage === stage
          ? request.progressUpdatedAt
          : now,
      updatedAt: now,
    };

    store.snapshotRequests.set(
      requestId,
      updated
    );

    return { ...updated };
  },

  async finalizeSnapshotRequest(
    requestId,
    projectId,
    status
  ) {
    const store = getStore();
    const request =
      store.snapshotRequests.get(requestId);

    if (
      !request ||
      request.projectId !== projectId
    ) {
      return null;
    }

    if (request.status === status) {
      return { ...request };
    }

    if (request.status !== "running") {
      return null;
    }

    if (
      status === "report_ready" &&
      request.progressStage !==
        "quality_review"
    ) {
      return null;
    }

    const finalized: SnapshotRequest = {
      ...request,
      status,
      updatedAt:
        new Date().toISOString(),
    };

    store.snapshotRequests.set(
      requestId,
      finalized
    );

    return { ...finalized };
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const project: Project = {
      id: randomUUID(),
      userId: input.userId ?? null,
      companyName: input.companyName ?? null,
      domain: input.domain,
      category: null,
      createdAt: new Date().toISOString(),
    };
    getStore().projects.set(project.id, project);
    return project;
  },

  async updateProjectCategory(projectId, category) {
    const store = getStore();
    const p = store.projects.get(projectId);
    if (p) store.projects.set(projectId, { ...p, category });
  },

  async saveSitePages(projectId, pages) {
    const now = new Date().toISOString();
    const rows: SitePage[] = pages.map((p) => ({
      id: randomUUID(),
      projectId,
      url: p.url,
      title: p.title,
      content: p.content,
      pageType: p.pageType,
      createdAt: now,
    }));
    getStore().sitePagesByProject.set(projectId, rows);
  },

  async saveMirrorProfile(projectId, json) {
    const row: MirrorProfileRow = {
      id: randomUUID(),
      projectId,
      json,
      createdAt: new Date().toISOString(),
    };
    getStore().mirrorProfilesByProject.set(projectId, row);
    return row;
  },

  async getProject(id) {
    return getStore().projects.get(id) ?? null;
  },

  async getSitePages(projectId) {
    return getStore().sitePagesByProject.get(projectId) ?? [];
  },

  async getMirrorProfile(projectId) {
    return getStore().mirrorProfilesByProject.get(projectId) ?? null;
  },

  async replaceGeneratedPrompts(
    projectId: string,
    prompts: GeneratedPromptInput[]
  ): Promise<GeneratedPrompt[]> {
    const now = new Date().toISOString();
    const rows: GeneratedPrompt[] = prompts.map((p) => ({
      id: randomUUID(),
      projectId,
      prompt: p.prompt,
      intentType: p.intentType,
      commercialValue: p.commercialValue,
      winnability: p.winnability,
      priority: p.priority,
      rationale: p.rationale,
      selected: p.selected,
      createdAt: now,
    }));
    getStore().generatedPromptsByProject.set(projectId, rows);
    return rows;
  },

  async getGeneratedPrompts(projectId: string): Promise<GeneratedPrompt[]> {
    return getStore().generatedPromptsByProject.get(projectId) ?? [];
  },

  async getGeneratedPrompt(id: string): Promise<GeneratedPrompt | null> {
    for (const list of getStore().generatedPromptsByProject.values()) {
      const found = list.find((p) => p.id === id);
      if (found) return found;
    }
    return null;
  },

  async createProbeRun(
    projectId: string,
    platform: string,
    probeMode: ProbeMode,
    status: ProbeRunStatus = "pending",
    datasetIdentity?: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<ProbeRun> {
    const run: ProbeRun = {
      id: randomUUID(),
      projectId,
      platform,
      status,
      probeMode,
      snapshotRequestId: null,
      datasetId: datasetIdentity?.datasetId ?? null,
      datasetSourceType: datasetIdentity?.datasetSourceType ?? null,
      createdAt: new Date().toISOString(),
    };
    getStore().probeRuns.set(run.id, run);
    return run;
  },

  async updateProbeRunStatus(id: string, status: ProbeRunStatus): Promise<void> {
    const store = getStore();
    const run = store.probeRuns.get(id);
    if (run) store.probeRuns.set(id, { ...run, status });
  },

  async getProbeRunsByProject(projectId: string): Promise<ProbeRun[]> {
    return [...getStore().probeRuns.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async saveProbeResult(input: SaveProbeResultInput): Promise<ProbeResult> {
    const row: ProbeResult = {
      id: randomUUID(),
      probeRunId: input.probeRunId,
      projectId: input.projectId,
      generatedPromptId: input.generatedPromptId ?? null,
      prompt: input.prompt,
      platform: input.platform,
      probeMode: input.probeMode,
      rawResponse: input.rawResponse,
      rawProbeRequest: input.rawProbeRequest ?? "",
      productMentioned: input.productMentioned ?? input.clientMentioned,
      productPosition: input.productPosition ?? input.clientPosition,
      productVerdict: input.productVerdict ?? input.verdict,
      citedAsSource: input.citedAsSource ?? false,
      clientSourceCount: input.clientSourceCount ?? 0,
      platformsReferenced: [...(input.platformsReferenced ?? [])],
      clientMentioned: input.clientMentioned,
      clientPosition: input.clientPosition,
      competitorsMentioned: input.competitorsMentioned,
      sourcesCited: input.sourcesCited,
      answerSummary: input.answerSummary,
      verdict: input.verdict,
      whyClientLost: input.whyClientLost,
      rawResponseSha256: input.rawResponseSha256 ?? null,
      rawResponseBody: input.rawResponseBody ?? null,
      rawResponseBodySha256: input.rawResponseBodySha256 ?? null,
      rawProbeRequestSha256: input.rawProbeRequestSha256 ?? null,
      fullRequestBodySha256: input.fullRequestBodySha256 ?? null,
      providerHttpStatus: input.providerHttpStatus ?? null,
      providerLatencyMs: input.providerLatencyMs ?? null,
      providerRequestId: input.providerRequestId ?? null,
      providerModel: input.providerModel ?? null,
      retryCount: input.retryCount ?? 0,
      snapshotRequestId: input.snapshotRequestId ?? null,
      datasetId: input.datasetId ?? null,
      datasetSourceType: input.datasetSourceType ?? null,
      runPosition: input.runPosition ?? null,
      negativeClaimDetected: input.negativeClaimDetected ?? null,
      observationSchemaVersion: input.observationSchemaVersion ?? null,
      createdAt: new Date().toISOString(),
    };
    const store = getStore();
    const list = store.probeResultsByProject.get(input.projectId) ?? [];
    list.push(row);
    store.probeResultsByProject.set(input.projectId, list);
    return row;
  },

  async getProbeResultsByProject(projectId: string): Promise<ProbeResult[]> {
    return [...(getStore().probeResultsByProject.get(projectId) ?? [])].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  },

  async getLostProbeResultsByProject(projectId: string): Promise<ProbeResult[]> {
    const all = getStore().probeResultsByProject.get(projectId) ?? [];
    return [...all]
      .filter((r) => r.verdict === "lost" || r.verdict === "partial")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async recordAnalysisLlmCall(
    input: AnalysisLlmCallInput
  ): Promise<AnalysisLlmCall> {
    const row: AnalysisLlmCall = {
      id: randomUUID(),
      projectId: input.projectId,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      usedMock: input.usedMock,
      usedRetry: input.usedRetry,
      latencyMs: input.latencyMs,
      requestSha256: input.requestSha256 ?? null,
      responseSha256: input.responseSha256 ?? null,
      createdAt: new Date().toISOString(),
    };
    const store = getStore();
    const list = store.analysisLlmCallsByProject.get(input.projectId) ?? [];
    list.push(row);
    store.analysisLlmCallsByProject.set(input.projectId, list);
    return row;
  },

  async getAnalysisLlmCallsByProject(
    projectId: string
  ): Promise<AnalysisLlmCall[]> {
    return [...(getStore().analysisLlmCallsByProject.get(projectId) ?? [])].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  },

  async recordProbeFailure(
    input: RecordProbeFailureInput
  ): Promise<ProbeFailure> {
    const row: ProbeFailure = {
      id: randomUUID(),
      probeRunId: input.probeRunId ?? null,
      projectId: input.projectId,
      platform: input.platform,
      prompt: input.prompt,
      failureReason: input.failureReason,
      providerHttpStatus: input.providerHttpStatus ?? null,
      providerErrorBody: input.providerErrorBody ?? null,
      providerErrorBodySha256: input.providerErrorBodySha256 ?? null,
      providerLatencyMs: input.providerLatencyMs ?? null,
      providerRequestId: input.providerRequestId ?? null,
      rawProbeRequestSha256: input.rawProbeRequestSha256 ?? null,
      fullRequestBodySha256: input.fullRequestBodySha256 ?? null,
      retryCount: input.retryCount ?? 0,
      createdAt: new Date().toISOString(),
    };
    const store = getStore();
    const list = store.probeFailuresByProject.get(input.projectId) ?? [];
    list.push(row);
    store.probeFailuresByProject.set(input.projectId, list);
    return row;
  },

  async getProbeFailuresByProject(
    projectId: string
  ): Promise<ProbeFailure[]> {
    return [...(getStore().probeFailuresByProject.get(projectId) ?? [])].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  },

  // M2 canonical observations contract, first tranche (D-014) — dataset
  // identity. Simulates the two database constraints so tests can rely
  // on the same behavior a real Postgres migration will enforce.
  async createDatasetBatch(input: DatasetBatchInput): Promise<DatasetBatch> {
    const isSnapshotRequest = input.datasetSourceType === "snapshot_request";
    const hasSnapshotRequestId = input.snapshotRequestId != null;
    if (isSnapshotRequest !== hasSnapshotRequestId) {
      throw new Error(
        `dataset_batches_snapshot_request_id_check violated: datasetSourceType="${input.datasetSourceType}" requires snapshotRequestId to be ${isSnapshotRequest ? "non-null" : "null"}.`
      );
    }
    const store = getStore();
    if (input.backfillKey) {
      const duplicate = [...store.datasetBatches.values()].find(
        (b) => b.backfillKey === input.backfillKey
      );
      if (duplicate) {
        throw new Error(
          `dataset_batches_backfill_key_key violated: backfillKey "${input.backfillKey}" already exists on dataset_batches ${duplicate.id}.`
        );
      }
    }
    const row: DatasetBatch = {
      id: randomUUID(),
      projectId: input.projectId,
      datasetSourceType: input.datasetSourceType,
      snapshotRequestId: input.snapshotRequestId ?? null,
      backfillKey: input.backfillKey ?? null,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    };
    store.datasetBatches.set(row.id, row);
    return row;
  },

  async getDatasetBatchesByProject(projectId: string): Promise<DatasetBatch[]> {
    return [...getStore().datasetBatches.values()]
      .filter((b) => b.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  // M2 canonical observations contract, first tranche (D-014) — entity
  // resolution. No uniqueness constraint on canonical_entities itself
  // beyond its primary key and the composite unique key that
  // entity_aliases' foreign key depends on; nothing to simulate here
  // beyond storing the row.
  async createCanonicalEntity(
    input: CanonicalEntityInput
  ): Promise<CanonicalEntity> {
    const row: CanonicalEntity = {
      id: randomUUID(),
      projectId: input.projectId,
      entityType: input.entityType,
      resolverVersion: input.resolverVersion,
      createdAt: new Date().toISOString(),
    };
    getStore().canonicalEntities.set(row.id, row);
    return row;
  },

  async getCanonicalEntitiesByProject(
    projectId: string
  ): Promise<CanonicalEntity[]> {
    return [...getStore().canonicalEntities.values()]
      .filter((e) => e.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getEntityAliasesByProject(projectId: string): Promise<EntityAlias[]> {
    return [...(getStore().entityAliasesByProject.get(projectId) ?? [])].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  },

  // M2 canonical observations contract, third tranche (D-017, D-018,
  // D-019) — full reimplementation of migration 0042's business logic
  // against the in-memory store, mirroring how
  // backfillProbeResultDatasetIdentity above reimplements D-015's RPC
  // rather than merely stubbing it. Genuine concurrency (the SQL
  // function's retry loop, real row locks) cannot be simulated here —
  // this is single-threaded JS with no concurrent callers; that
  // remains a real-Postgres-only concern, same documented limitation
  // already carried by scripts/test-m2-tranche3-writers.ts.
  async startOrResumeEntityResolutionPass(
    input: StartOrResumeEntityResolutionPassInput
  ): Promise<StartOrResumeEntityResolutionPassResult> {
    const store = getStore();

    if (input.resolverVersion < 1) throw new Error("invalid_resolver_version");
    if (input.expectedMentionCount < 0) {
      throw new Error("invalid_expected_mention_count");
    }
    const staleAfterMs = (input.staleAfterSeconds ?? 900) * 1000;
    if (!(staleAfterMs > 0)) throw new Error("invalid_stale_after");
    if (!input.companyName.trim()) throw new Error("empty_company_name");
    if (!input.domain.trim()) throw new Error("empty_domain");
    if (input.normalizedBrandTerms.length === 0) {
      throw new Error("empty_normalized_brand_terms");
    }
    if (input.normalizedBrandTerms.some((t) => !t || !t.trim())) {
      throw new Error("blank_normalized_brand_term");
    }
    const mirrorAliases = input.mirrorAliases ?? [];
    if (mirrorAliases.some((a) => !a || !a.trim())) {
      throw new Error("blank_mirror_alias");
    }

    const probeResult = (
      store.probeResultsByProject.get(input.projectId) ?? []
    ).find((r) => r.id === input.probeResultId);
    if (!probeResult) throw new Error("probe_result_project_mismatch");

    const datasetBatch = [...store.datasetBatches.values()].find(
      (b) => b.id === input.datasetId && b.projectId === input.projectId
    );
    if (!datasetBatch) throw new Error("dataset_project_mismatch");
    const datasetSourceType = datasetBatch.datasetSourceType;

    const now = new Date();

    const existing = [...store.entityResolutionPasses.values()].find(
      (p) =>
        p.probeResultId === input.probeResultId &&
        p.resolverVersion === input.resolverVersion &&
        (p.status === "completed" || p.status === "in_progress")
    );

    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.probeResultId !== input.probeResultId ||
        existing.datasetId !== input.datasetId ||
        existing.datasetSourceType !== datasetSourceType ||
        existing.resolverVersion !== input.resolverVersion ||
        existing.expectedMentionCount !== input.expectedMentionCount
      ) {
        throw new Error("pass_parameter_mismatch");
      }

      if (existing.status === "completed") {
        return {
          resolutionPassId: existing.id,
          passStatus: "completed",
          passOutcome: "ALREADY_COMPLETED",
        };
      }

      const lastActivityMs = new Date(existing.lastActivityAt).getTime();
      if (now.getTime() - lastActivityMs <= staleAfterMs) {
        const resumed: EntityResolutionPass = {
          ...existing,
          lastActivityAt: now.toISOString(),
        };
        store.entityResolutionPasses.set(resumed.id, resumed);
        return {
          resolutionPassId: resumed.id,
          passStatus: "in_progress",
          passOutcome: "RESUMED",
        };
      }

      const abandoned: EntityResolutionPass = {
        ...existing,
        status: "abandoned",
      };
      store.entityResolutionPasses.set(abandoned.id, abandoned);
    }

    // find-or-create the brand snapshot; reuse requires an exact match,
    // array order included, never a silent divergence
    let brandSnapshot = [...store.entityBrandSnapshots.values()].find(
      (s) =>
        s.projectId === input.projectId &&
        s.datasetId === input.datasetId &&
        s.resolverVersion === input.resolverVersion
    );

    if (brandSnapshot) {
      const sameAliases =
        brandSnapshot.mirrorAliases.length === mirrorAliases.length &&
        brandSnapshot.mirrorAliases.every((a, i) => a === mirrorAliases[i]);
      const sameTerms =
        brandSnapshot.normalizedBrandTerms.length ===
          input.normalizedBrandTerms.length &&
        brandSnapshot.normalizedBrandTerms.every(
          (t, i) => t === input.normalizedBrandTerms[i]
        );
      if (
        brandSnapshot.companyName !== input.companyName ||
        brandSnapshot.domain !== input.domain ||
        !sameAliases ||
        !sameTerms
      ) {
        throw new Error("brand_snapshot_parameter_mismatch");
      }
    } else {
      brandSnapshot = {
        id: randomUUID(),
        projectId: input.projectId,
        datasetId: input.datasetId,
        resolverVersion: input.resolverVersion,
        companyName: input.companyName,
        domain: input.domain,
        mirrorAliases,
        normalizedBrandTerms: input.normalizedBrandTerms,
        createdAt: now.toISOString(),
      };
      store.entityBrandSnapshots.set(brandSnapshot.id, brandSnapshot);
    }

    const status: EntityResolutionPassRowStatus =
      input.expectedMentionCount === 0 ? "completed" : "in_progress";

    const pass: EntityResolutionPass = {
      id: randomUUID(),
      projectId: input.projectId,
      probeResultId: input.probeResultId,
      resolverVersion: input.resolverVersion,
      datasetId: input.datasetId,
      datasetSourceType,
      brandSnapshotId: brandSnapshot.id,
      expectedMentionCount: input.expectedMentionCount,
      status,
      startedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      completedAt: status === "completed" ? now.toISOString() : null,
    };
    store.entityResolutionPasses.set(pass.id, pass);

    return {
      resolutionPassId: pass.id,
      passStatus: status,
      passOutcome: "STARTED",
    };
  },

  async resolveAndRecordEntityObservation(
    input: ResolveAndRecordEntityObservationInput
  ): Promise<ResolveAndRecordEntityObservationResult> {
    const store = getStore();

    const pass = store.entityResolutionPasses.get(input.resolutionPassId);
    if (!pass) throw new Error("pass_not_found");
    if (pass.status !== "in_progress") throw new Error("pass_not_in_progress");

    const probeResult = (
      store.probeResultsByProject.get(pass.projectId) ?? []
    ).find((r) => r.id === pass.probeResultId);
    const probeRunId = probeResult?.probeRunId ?? "";
    const generatedPromptId = probeResult?.generatedPromptId ?? null;

    const brandSnapshot = store.entityBrandSnapshots.get(pass.brandSnapshotId);
    // normalizedBrandTerms is already-normalized data produced once by
    // lib/evidence/normalize-entity-text.ts at snapshot-creation time
    // (D-019) — never recomputed here, only compared by exact string
    // membership.
    const normalizedBrandTerms = brandSnapshot?.normalizedBrandTerms ?? [];

    if (input.mentionOrdinal < 0) throw new Error("invalid_mention_ordinal");
    if (!input.rawText || !input.rawText.trim()) {
      throw new Error("empty_raw_text");
    }
    // input.normalizedText is trusted as-is (D-019 trust hypothesis) —
    // this adapter never calls normalizeEntityTextV1 to re-derive or
    // sanity-check it against input.rawText.
    if (!input.normalizedText || !input.normalizedText.trim()) {
      throw new Error("empty_normalized_text");
    }
    const validStatuses: EntityObservationStatus[] = [
      "resolved",
      "ambiguous",
      "unresolved",
      "excluded_brand_self",
    ];
    if (!validStatuses.includes(input.status)) throw new Error("invalid_status");

    if (
      (input.status === "resolved" || input.status === "excluded_brand_self") &&
      input.proposedEntityType == null
    ) {
      throw new Error("missing_proposed_entity_type");
    }
    if (
      (input.status === "ambiguous" || input.status === "unresolved") &&
      input.proposedEntityType != null
    ) {
      throw new Error("unexpected_proposed_entity_type");
    }
    if (input.status === "resolved" && input.proposedEntityType === "client") {
      throw new Error("resolved_forbids_client");
    }
    if (
      input.status === "excluded_brand_self" &&
      input.proposedEntityType !== "client"
    ) {
      throw new Error("excluded_brand_self_requires_client");
    }
    if (
      input.status === "excluded_brand_self" &&
      !normalizedBrandTerms.includes(input.normalizedText)
    ) {
      throw new Error("excluded_brand_self_no_match");
    }

    let effectiveStatus: EntityObservationStatus = input.status;
    let effectiveEntityType: EntityType | null = input.proposedEntityType ?? null;

    // D-018 unconditional override — any competitor/platform proposal
    // matching the brand snapshot is reclassified, regardless of
    // whether an alias head already exists for it.
    if (
      input.status === "resolved" &&
      (input.proposedEntityType === "competitor" ||
        input.proposedEntityType === "platform") &&
      normalizedBrandTerms.includes(input.normalizedText)
    ) {
      effectiveStatus = "excluded_brand_self";
      effectiveEntityType = "client";
    }

    let canonicalEntityId: string | null = null;
    let aliasId: string | null = null;
    let aliasGeneration: number | null = null;
    let aliasOutcome: EntityAliasOutcome;

    if (effectiveStatus === "resolved" || effectiveStatus === "excluded_brand_self") {
      if (effectiveEntityType === "client") {
        let clientEntity = [...store.canonicalEntities.values()].find(
          (e) => e.projectId === pass.projectId && e.entityType === "client"
        );
        if (!clientEntity) {
          clientEntity = {
            id: randomUUID(),
            projectId: pass.projectId,
            entityType: "client",
            resolverVersion: pass.resolverVersion,
            createdAt: new Date().toISOString(),
          };
          store.canonicalEntities.set(clientEntity.id, clientEntity);
        }
        canonicalEntityId = clientEntity.id;
      }

      const aliasesForProject =
        store.entityAliasesByProject.get(pass.projectId) ?? [];
      const matchingAliases = aliasesForProject.filter(
        (a) => a.normalizedText === input.normalizedText
      );
      const aliasHead =
        matchingAliases.length > 0
          ? matchingAliases.reduce((best, a) =>
              a.aliasGeneration > best.aliasGeneration ? a : best
            )
          : null;

      // unconditional demote-block: a client identity can never be
      // demoted through this ordinary path, at any resolverVersion
      if (
        aliasHead &&
        aliasHead.entityType === "client" &&
        effectiveEntityType !== "client"
      ) {
        throw new Error("client_alias_demote_blocked");
      }

      if (effectiveEntityType === "competitor" || effectiveEntityType === "platform") {
        if (aliasHead) {
          canonicalEntityId = aliasHead.canonicalEntityId;
        } else {
          const created: CanonicalEntity = {
            id: randomUUID(),
            projectId: pass.projectId,
            entityType: effectiveEntityType,
            resolverVersion: pass.resolverVersion,
            createdAt: new Date().toISOString(),
          };
          store.canonicalEntities.set(created.id, created);
          canonicalEntityId = created.id;
        }
      }

      if (!aliasHead) {
        const newAlias: EntityAlias = {
          id: randomUUID(),
          canonicalEntityId: canonicalEntityId as string,
          projectId: pass.projectId,
          entityType: effectiveEntityType as EntityType,
          rawText: input.rawText,
          normalizedText: input.normalizedText,
          resolverVersion: pass.resolverVersion,
          aliasGeneration: 1,
          createdAt: new Date().toISOString(),
        };
        store.entityAliasesByProject.set(pass.projectId, [
          ...aliasesForProject,
          newAlias,
        ]);
        aliasId = newAlias.id;
        aliasGeneration = 1;
        aliasOutcome = "APPLIED";
      } else if (
        aliasHead.canonicalEntityId === canonicalEntityId &&
        aliasHead.entityType === effectiveEntityType
      ) {
        aliasId = aliasHead.id;
        aliasGeneration = aliasHead.aliasGeneration;
        aliasOutcome = "ALREADY_APPLIED";
      } else if (pass.resolverVersion > aliasHead.resolverVersion) {
        const newAlias: EntityAlias = {
          id: randomUUID(),
          canonicalEntityId: canonicalEntityId as string,
          projectId: pass.projectId,
          entityType: effectiveEntityType as EntityType,
          rawText: input.rawText,
          normalizedText: input.normalizedText,
          resolverVersion: pass.resolverVersion,
          aliasGeneration: aliasHead.aliasGeneration + 1,
          createdAt: new Date().toISOString(),
        };
        store.entityAliasesByProject.set(pass.projectId, [
          ...aliasesForProject,
          newAlias,
        ]);
        aliasId = newAlias.id;
        aliasGeneration = newAlias.aliasGeneration;
        aliasOutcome = "SUPERSEDED_PRIOR";
      } else {
        aliasId = aliasHead.id;
        aliasGeneration = aliasHead.aliasGeneration;
        aliasOutcome = "CONFLICT";
      }
    } else {
      // ambiguous / unresolved: alias resolution is skipped entirely
      canonicalEntityId = null;
      effectiveEntityType = null;
      aliasOutcome = "NOT_APPLICABLE";
    }

    const effective:
      | { status: "resolved"; entityType: "competitor" | "platform"; canonicalEntityId: string }
      | { status: "excluded_brand_self"; entityType: "client"; canonicalEntityId: string }
      | { status: "ambiguous" | "unresolved"; entityType: null; canonicalEntityId: null } =
      effectiveStatus === "excluded_brand_self"
        ? {
            status: "excluded_brand_self",
            entityType: "client",
            canonicalEntityId: canonicalEntityId as string,
          }
        : effectiveStatus === "resolved"
        ? {
            status: "resolved",
            entityType: effectiveEntityType as "competitor" | "platform",
            canonicalEntityId: canonicalEntityId as string,
          }
        : {
            status: effectiveStatus as "ambiguous" | "unresolved",
            entityType: null,
            canonicalEntityId: null,
          };

    const existingObservations = [...store.entityObservations.values()].filter(
      (o) =>
        o.resolutionPassId === input.resolutionPassId &&
        o.mentionOrdinal === input.mentionOrdinal
    );
    const observationHead =
      existingObservations.length > 0
        ? existingObservations.reduce((best, o) =>
            o.observationGeneration > best.observationGeneration ? o : best
          )
        : null;

    let observationId: string;
    let observationGeneration: number;
    let observationOutcome: EntityObservationOutcome;

    if (!observationHead) {
      const newObservation: EntityObservation = {
        id: randomUUID(),
        probeResultId: pass.probeResultId,
        probeRunId,
        generatedPromptId,
        projectId: pass.projectId,
        datasetId: pass.datasetId,
        datasetSourceType: pass.datasetSourceType,
        resolutionPassId: pass.id,
        rawText: input.rawText,
        normalizedText: input.normalizedText,
        resolverVersion: pass.resolverVersion,
        mentionOrdinal: input.mentionOrdinal,
        context: input.context ?? null,
        observationGeneration: 1,
        createdAt: new Date().toISOString(),
        ...effective,
      };
      store.entityObservations.set(newObservation.id, newObservation);
      observationId = newObservation.id;
      observationGeneration = 1;
      observationOutcome = "APPLIED";
    } else if (
      observationHead.rawText === input.rawText &&
      observationHead.normalizedText === input.normalizedText &&
      observationHead.canonicalEntityId === canonicalEntityId &&
      observationHead.entityType === effectiveEntityType &&
      observationHead.status === effectiveStatus &&
      (observationHead.context ?? null) === (input.context ?? null)
    ) {
      observationId = observationHead.id;
      observationGeneration = observationHead.observationGeneration;
      observationOutcome = "ALREADY_APPLIED";
    } else {
      observationId = observationHead.id;
      observationGeneration = observationHead.observationGeneration;
      observationOutcome = "CONFLICT";
    }

    const now = new Date();
    const observationCount = [...store.entityObservations.values()].filter(
      (o) => o.resolutionPassId === input.resolutionPassId
    ).length;

    let passStatus: EntityResolutionPassStatus;
    if (observationCount === pass.expectedMentionCount) {
      store.entityResolutionPasses.set(pass.id, {
        ...pass,
        status: "completed",
        completedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      });
      passStatus = "completed";
    } else {
      store.entityResolutionPasses.set(pass.id, {
        ...pass,
        lastActivityAt: now.toISOString(),
      });
      passStatus = "in_progress";
    }

    return {
      observationId,
      observationGeneration,
      observationOutcome,
      aliasId,
      aliasGeneration,
      aliasOutcome,
      passStatus,
    };
  },

  async getEntityAliasesActiveByProject(projectId: string): Promise<EntityAlias[]> {
    const all = getStore().entityAliasesByProject.get(projectId) ?? [];
    const headsByNormalizedText = new Map<string, EntityAlias>();
    for (const alias of all) {
      const current = headsByNormalizedText.get(alias.normalizedText);
      if (!current || alias.aliasGeneration > current.aliasGeneration) {
        headsByNormalizedText.set(alias.normalizedText, alias);
      }
    }
    return [...headsByNormalizedText.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  },

  async getEntityObservationsActiveByProbeResult(
    probeResultId: string
  ): Promise<EntityObservation[]> {
    const store = getStore();
    const allForResult = [...store.entityObservations.values()].filter(
      (o) => o.probeResultId === probeResultId
    );

    const completedPasses = [...store.entityResolutionPasses.values()].filter(
      (p) => p.probeResultId === probeResultId && p.status === "completed"
    );
    if (completedPasses.length === 0) return [];

    const maxCompletedVersion = Math.max(
      ...completedPasses.map((p) => p.resolverVersion)
    );
    const completedPassIds = new Set(
      completedPasses
        .filter((p) => p.resolverVersion === maxCompletedVersion)
        .map((p) => p.id)
    );

    const eligible = allForResult.filter((o) =>
      completedPassIds.has(o.resolutionPassId)
    );

    const headsByOrdinal = new Map<number, EntityObservation>();
    for (const obs of eligible) {
      const current = headsByOrdinal.get(obs.mentionOrdinal);
      if (!current || obs.observationGeneration > current.observationGeneration) {
        headsByOrdinal.set(obs.mentionOrdinal, obs);
      }
    }

    return [...headsByOrdinal.values()].sort(
      (a, b) => a.mentionOrdinal - b.mentionOrdinal
    );
  },

  // M2 canonical observations contract, second tranche — probe_runs was
  // never append-only restricted; a plain in-place update is correct.
  async updateProbeRunDatasetIdentity(
    id: string,
    input: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<void> {
    const store = getStore();
    const run = store.probeRuns.get(id);
    if (run) {
      store.probeRuns.set(id, {
        ...run,
        datasetId: input.datasetId,
        datasetSourceType: input.datasetSourceType,
      });
    }
  },

  // M2 canonical observations contract, second tranche (D-015) —
  // simulates the backfill_probe_result_dataset_identity SECURITY
  // DEFINER RPC's exact four-status contract, so tests can rely on the
  // same behavior the real Postgres function will enforce.
  async backfillProbeResultDatasetIdentity(
    input: BackfillProbeResultDatasetIdentityInput
  ): Promise<BackfillProbeResultDatasetIdentityResult> {
    const store = getStore();
    const list = store.probeResultsByProject.get(input.projectId) ?? [];
    const index = list.findIndex(
      (r) => r.id === input.probeResultId && r.projectId === input.projectId
    );
    if (index === -1) {
      return { status: "NOT_FOUND", probeResult: null };
    }
    const row = list[index]!;

    const batch = [...store.datasetBatches.values()].find(
      (b) => b.id === input.datasetId
    );
    if (
      !batch ||
      batch.projectId !== input.projectId ||
      batch.datasetSourceType !== input.datasetSourceType
    ) {
      throw new Error(
        `invalid_backfill_dataset_batch: no dataset_batches row matches (id="${input.datasetId}", projectId="${input.projectId}", datasetSourceType="${input.datasetSourceType}").`
      );
    }

    const sameOrBothNull = <T,>(a: T | null | undefined, b: T | null | undefined): boolean =>
      (a ?? null) === (b ?? null);

    const matches =
      row.datasetId === input.datasetId &&
      row.datasetSourceType === input.datasetSourceType &&
      sameOrBothNull(row.runPosition, input.runPosition) &&
      sameOrBothNull(row.negativeClaimDetected, input.negativeClaimDetected) &&
      sameOrBothNull(row.observationSchemaVersion, input.observationSchemaVersion);

    if (matches) {
      return { status: "ALREADY_APPLIED", probeResult: row };
    }

    const allNull =
      row.datasetId == null &&
      row.datasetSourceType == null &&
      row.runPosition == null &&
      row.negativeClaimDetected == null &&
      row.observationSchemaVersion == null;

    if (!allNull) {
      return { status: "CONFLICT", probeResult: row };
    }

    const updated: ProbeResult = {
      ...row,
      datasetId: input.datasetId,
      datasetSourceType: input.datasetSourceType,
      runPosition: input.runPosition ?? null,
      negativeClaimDetected: input.negativeClaimDetected ?? null,
      observationSchemaVersion: input.observationSchemaVersion ?? null,
    };
    list[index] = updated;
    store.probeResultsByProject.set(input.projectId, list);
    return { status: "APPLIED", probeResult: updated };
  },

  async replaceCompetitorsForProject(
    projectId: string,
    competitors: CompetitorInput[]
  ): Promise<Competitor[]> {
    const now = new Date().toISOString();
    const rows: Competitor[] = competitors.map((c) => ({
      id: randomUUID(),
      projectId,
      name: c.name,
      website: c.website,
      discoverySource: c.discoverySource,
      mentionCount: c.mentionCount,
      promptIds: [...c.promptIds],
      threatLevel: c.threatLevel,
      confidence: c.confidence,
      isPhantom: c.isPhantom,
      isBlindSpot: c.isBlindSpot,
      canonicalEntityId: c.canonicalEntityId,
      createdAt: now,
      updatedAt: now,
    }));
    getStore().competitorsByProject.set(projectId, rows);
    return rows;
  },

  async getCompetitorsByProject(projectId: string): Promise<Competitor[]> {
    return [...(getStore().competitorsByProject.get(projectId) ?? [])];
  },

  async saveGapMap(projectId: string, gapMapJson: unknown): Promise<GapMapRow> {
    const row: GapMapRow = {
      id: randomUUID(),
      projectId,
      json: gapMapJson,
      createdAt: new Date().toISOString(),
    };
    const store = getStore();
    const existing = store.gapMapsByProject.get(projectId) ?? [];
    store.gapMapsByProject.set(projectId, [row, ...existing]);
    return row;
  },

  async getLatestGapMap(projectId: string): Promise<GapMapRow | null> {
    const rows = getStore().gapMapsByProject.get(projectId) ?? [];
    if (rows.length === 0) return null;
    return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  },

  async replaceGapsForProject(
    projectId: string,
    gaps: GapInput[]
  ): Promise<Gap[]> {
    const now = new Date().toISOString();
    const rows: Gap[] = gaps.map((g) => ({
      id: randomUUID(),
      projectId,
      competitorName: g.competitorName,
      type: g.type,
      severity: g.severity,
      explanation: g.explanation,
      affectedPrompts: [...g.affectedPrompts],
      suggestedFixDirection: g.suggestedFixDirection,
      createdAt: now,
    }));
    getStore().gapsByProject.set(projectId, rows);
    return rows;
  },

  async getGapsByProject(projectId: string): Promise<Gap[]> {
    return [...(getStore().gapsByProject.get(projectId) ?? [])];
  },

  async upsertEvidenceBank(
    projectId: string,
    input: EvidenceBankRowInput
  ): Promise<EvidenceBankRow> {
    const store = getStore();
    const existing = store.evidenceBanksByProject.get(projectId);
    const now = new Date().toISOString();
    const row: EvidenceBankRow = {
      id: existing?.id ?? randomUUID(),
      projectId,
      ...cloneEvidenceBankInput(input),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    store.evidenceBanksByProject.set(projectId, row);
    return row;
  },

  async getEvidenceBankByProject(
    projectId: string
  ): Promise<EvidenceBankRow | null> {
    const row = getStore().evidenceBanksByProject.get(projectId);
    if (!row) return null;
    // Return a defensive copy so callers cannot mutate the store.
    return {
      ...row,
      targetAudience: [...row.targetAudience],
      mainUseCases: [...row.mainUseCases],
      features: row.features.map((f) => ({ ...f })),
      proofItems: row.proofItems.map((p) => ({ ...p })),
      competitors: [...row.competitors],
      allowedClaims: [...row.allowedClaims],
      forbiddenClaims: [...row.forbiddenClaims],
    };
  },

  async saveFixBrief(
    projectId: string,
    input: FixBriefRowInput
  ): Promise<FixBriefRow> {
    const now = new Date().toISOString();
    const row: FixBriefRow = {
      id: randomUUID(),
      projectId,
      gapId: input.gapId,
      probeResultId: input.probeResultId,
      lostPrompt: input.lostPrompt,
      competitorRecommended: input.competitorRecommended,
      rootCause: input.rootCause,
      recommendedFix: input.recommendedFix,
      fixType: input.fixType,
      assetsToGenerate: [...input.assetsToGenerate],
      evidenceNeeded: [...input.evidenceNeeded],
      evidenceAvailable: [...input.evidenceAvailable],
      priority: input.priority,
      expectedImpact: input.expectedImpact,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };
    const store = getStore();
    const list = store.fixBriefsByProject.get(projectId) ?? [];
    store.fixBriefsByProject.set(projectId, [row, ...list]);
    return row;
  },

  async getFixBriefsByProject(projectId: string): Promise<FixBriefRow[]> {
    const rows = getStore().fixBriefsByProject.get(projectId) ?? [];
    return rows.map((r) => ({
      ...r,
      assetsToGenerate: [...r.assetsToGenerate],
      evidenceNeeded: [...r.evidenceNeeded],
      evidenceAvailable: [...r.evidenceAvailable],
    }));
  },

  async getFixBrief(id: string): Promise<FixBriefRow | null> {
    for (const list of getStore().fixBriefsByProject.values()) {
      const found = list.find((r) => r.id === id);
      if (found) {
        return {
          ...found,
          assetsToGenerate: [...found.assetsToGenerate],
          evidenceNeeded: [...found.evidenceNeeded],
          evidenceAvailable: [...found.evidenceAvailable],
        };
      }
    }
    return null;
  },

  async updateFixBriefStatus(
    fixBriefId: string,
    status: string
  ): Promise<FixBriefRow | null> {
    const store = getStore();
    for (const [projectId, list] of store.fixBriefsByProject.entries()) {
      const idx = list.findIndex((r) => r.id === fixBriefId);
      if (idx === -1) continue;
      const updated: FixBriefRow = { ...list[idx]!, status, updatedAt: new Date().toISOString() };
      const next = [...list];
      next[idx] = updated;
      store.fixBriefsByProject.set(projectId, next);
      return { ...updated, assetsToGenerate: [...updated.assetsToGenerate], evidenceNeeded: [...updated.evidenceNeeded], evidenceAvailable: [...updated.evidenceAvailable] };
    }
    return null;
  },

  async saveGeneratedAsset(
    projectId: string,
    input: GeneratedAssetRowInput
  ): Promise<GeneratedAssetRow> {
    const now = new Date().toISOString();
    const row: GeneratedAssetRow = {
      id: randomUUID(),
      projectId,
      fixBriefId: input.fixBriefId,
      assetType: input.assetType,
      title: input.title,
      content: input.content,
      placeholders: [...input.placeholders],
      claimsUsed: input.claimsUsed.map((c) => ({ ...c })),
      qaStatus: input.qaStatus,
      lifecycleStatus: input.lifecycleStatus ?? "active",
      generationProvider: input.generationProvider ?? null,
      generationModel: input.generationModel ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const store = getStore();
    const list = store.generatedAssetsByProject.get(projectId) ?? [];
    store.generatedAssetsByProject.set(projectId, [row, ...list]);
    return row;
  },

  async getGeneratedAssetsByProject(
    projectId: string
  ): Promise<GeneratedAssetRow[]> {
    const rows = getStore().generatedAssetsByProject.get(projectId) ?? [];
    return rows.map((r) => ({
      ...r,
      placeholders: [...r.placeholders],
      claimsUsed: r.claimsUsed.map((c) => ({ ...c })),
    }));
  },

  async getGeneratedAssetsByFixBrief(
    fixBriefId: string
  ): Promise<GeneratedAssetRow[]> {
    const out: GeneratedAssetRow[] = [];
    for (const list of getStore().generatedAssetsByProject.values()) {
      for (const r of list) {
        if (r.fixBriefId === fixBriefId) {
          out.push({
            ...r,
            placeholders: [...r.placeholders],
            claimsUsed: r.claimsUsed.map((c) => ({ ...c })),
          });
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async getGeneratedAsset(id: string): Promise<GeneratedAssetRow | null> {
    for (const list of getStore().generatedAssetsByProject.values()) {
      const found = list.find((r) => r.id === id);
      if (found) {
        return {
          ...found,
          placeholders: [...found.placeholders],
          claimsUsed: found.claimsUsed.map((c) => ({ ...c })),
        };
      }
    }
    return null;
  },

  async updateGeneratedAssetQaStatus(
    assetId: string,
    qaStatus: string
  ): Promise<GeneratedAssetRow | null> {
    const store = getStore();
    for (const [projectId, list] of store.generatedAssetsByProject.entries()) {
      const idx = list.findIndex((r) => r.id === assetId);
      if (idx === -1) continue;
      const now = new Date().toISOString();
      const updated: GeneratedAssetRow = {
        ...list[idx]!,
        qaStatus,
        updatedAt: now,
      };
      // Non-mutating replace so callers holding an earlier reference still
      // see the pre-update value.
      const next = [...list];
      next[idx] = updated;
      store.generatedAssetsByProject.set(projectId, next);
      return {
        ...updated,
        placeholders: [...updated.placeholders],
        claimsUsed: updated.claimsUsed.map((c) => ({ ...c })),
      };
    }
    return null;
  },

  async updateGeneratedAssetLifecycleStatus(
    assetId: string,
    lifecycleStatus: GeneratedAssetLifecycleStatus
  ): Promise<GeneratedAssetRow | null> {
    const store = getStore();
    for (const [projectId, list] of store.generatedAssetsByProject.entries()) {
      const idx = list.findIndex((r) => r.id === assetId);
      if (idx === -1) continue;
      const updated: GeneratedAssetRow = { ...list[idx]!, lifecycleStatus, updatedAt: new Date().toISOString() };
      const next = [...list];
      next[idx] = updated;
      store.generatedAssetsByProject.set(projectId, next);
      return { ...updated, placeholders: [...updated.placeholders], claimsUsed: updated.claimsUsed.map((c) => ({ ...c })) };
    }
    return null;
  },

  async saveQaReport(
    projectId: string,
    input: QaReportRowInput
  ): Promise<QaReportRow> {
    const now = new Date().toISOString();
    const row: QaReportRow = {
      id: randomUUID(),
      projectId,
      generatedAssetId: input.generatedAssetId,
      verdict: input.verdict,
      violations: input.violations.map((v) => ({ ...v })),
      placeholdersRemaining: [...input.placeholdersRemaining],
      overallNotes: input.overallNotes,
      createdAt: now,
    };
    const store = getStore();
    const list = store.qaReportsByProject.get(projectId) ?? [];
    store.qaReportsByProject.set(projectId, [row, ...list]);
    return row;
  },

  async getQaReportsByProject(projectId: string): Promise<QaReportRow[]> {
    const rows = getStore().qaReportsByProject.get(projectId) ?? [];
    return rows.map((r) => ({
      ...r,
      violations: r.violations.map((v) => ({ ...v })),
      placeholdersRemaining: [...r.placeholdersRemaining],
    }));
  },

  async getQaReportsByGeneratedAsset(
    generatedAssetId: string
  ): Promise<QaReportRow[]> {
    const out: QaReportRow[] = [];
    for (const list of getStore().qaReportsByProject.values()) {
      for (const r of list) {
        if (r.generatedAssetId !== generatedAssetId) continue;
        out.push({
          ...r,
          violations: r.violations.map((v) => ({ ...v })),
          placeholdersRemaining: [...r.placeholdersRemaining],
        });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  /* migration 0035 delivery fencing.

   *

   * Unimplemented on purpose. The fencing guarantees live in SQL —

   * row locks, revision comparison and claim exclusion — and an

   * in-memory imitation would certify safety it cannot provide.

   * Tests exercise these against the real RPCs or explicit fakes.

   */

  async replaceUndeliveredSnapshotReportArtifact(): Promise<never> {

    throw new Error("replaceUndeliveredSnapshotReportArtifact requires the SQL adapter");

  },


  async beginSnapshotReportDelivery(): Promise<never> {

    throw new Error("beginSnapshotReportDelivery requires the SQL adapter");

  },


  async finalizeSnapshotReportDelivery(): Promise<never> {

    throw new Error("finalizeSnapshotReportDelivery requires the SQL adapter");

  },


  async releaseSnapshotReportDeliveryClaim(): Promise<never> {

    throw new Error("releaseSnapshotReportDeliveryClaim requires the SQL adapter");

  },


  async getLatestQaReportForAsset(
    generatedAssetId: string
  ): Promise<QaReportRow | null> {
    const all = await memoryAdapter.getQaReportsByGeneratedAsset(
      generatedAssetId
    );
    return all[0] ?? null;
  },

  // M4 — buyer question identity, protocol, and paid-attempt ledger.
  // Every method below is synchronous business logic with no `await`
  // between reading current state and writing it — in this
  // single-threaded in-memory adapter that is what makes each method
  // atomic, mirroring what `FOR UPDATE` + one PL/pgSQL function call
  // gives the real RPC (migration 0047, draft).

  async createBuyerQuestion(
    input: CreateBuyerQuestionInput
  ): Promise<BuyerQuestion> {
    const question: BuyerQuestion = {
      id: randomUUID(),
      projectId: input.projectId,
      createdAt: new Date().toISOString(),
    };
    getStore().buyerQuestions.set(question.id, question);
    return { ...question };
  },

  async getBuyerQuestion(
    id: string,
    projectId: string
  ): Promise<BuyerQuestion | null> {
    const q = getStore().buyerQuestions.get(id);
    if (!q || q.projectId !== projectId) return null;
    return { ...q };
  },

  async createBuyerQuestionVersion(
    input: CreateBuyerQuestionVersionInput
  ): Promise<BuyerQuestionVersion> {
    // Shared contract, enforced identically by the Supabase adapter —
    // checked first, before any state mutation, so an invalid input
    // never leaves a partial row anywhere.
    validateBuyerQuestionVersionNumericFields(input);

    const store = getStore();
    const question = store.buyerQuestions.get(input.buyerQuestionId);
    if (!question || question.projectId !== input.projectId) {
      throw new Error("buyer_question_project_mismatch");
    }
    if (!input.promptText.trim()) throw new Error("empty_prompt_text");
    if (!input.promptHash.trim()) throw new Error("empty_prompt_hash");
    if (input.versionNumber < 1) throw new Error("invalid_version_number");

    // Rule 1: a text change is always a new row. This only guards
    // against a caller re-using a version number by mistake — it never
    // rewrites or reuses an existing version's text.
    const existingForQuestion = [...store.buyerQuestionVersions.values()].filter(
      (v) => v.buyerQuestionId === input.buyerQuestionId
    );
    if (existingForQuestion.some((v) => v.versionNumber === input.versionNumber)) {
      throw new Error("version_number_conflict");
    }

    const version: BuyerQuestionVersion = {
      id: randomUUID(),
      buyerQuestionId: input.buyerQuestionId,
      projectId: input.projectId,
      versionNumber: input.versionNumber,
      promptText: input.promptText,
      promptHash: input.promptHash,
      intentType: input.intentType,
      commercialValue: input.commercialValue,
      winnability: input.winnability,
      priority: input.priority,
      rationale: input.rationale,
      provenance: input.provenance,
      approvedBy: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
    };
    store.buyerQuestionVersions.set(version.id, version);
    return { ...version };
  },

  async getBuyerQuestionVersionsByQuestion(
    buyerQuestionId: string,
    projectId: string
  ): Promise<BuyerQuestionVersion[]> {
    return [...getStore().buyerQuestionVersions.values()]
      .filter(
        (v) => v.buyerQuestionId === buyerQuestionId && v.projectId === projectId
      )
      .map((v) => ({ ...v }))
      .sort((a, b) => a.versionNumber - b.versionNumber);
  },

  async getBuyerQuestionVersion(
    id: string,
    projectId: string
  ): Promise<BuyerQuestionVersion | null> {
    const v = getStore().buyerQuestionVersions.get(id);
    if (!v || v.projectId !== projectId) return null;
    return { ...v };
  },

  async approveBuyerQuestionVersion(
    input: ApproveBuyerQuestionVersionInput
  ): Promise<ApproveBuyerQuestionVersionResult> {
    // Shared contract, enforced identically by the Supabase adapter —
    // checked first, before any state mutation.
    validateApprovedByUuid(input.approvedBy);

    const store = getStore();
    const version = store.buyerQuestionVersions.get(input.versionId);
    if (!version || version.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", version: null };
    }
    if (version.approvedAt !== null) {
      return { outcome: "ALREADY_APPROVED", version: { ...version } };
    }
    const approved: BuyerQuestionVersion = {
      ...version,
      approvedBy: input.approvedBy,
      approvedAt: new Date().toISOString(),
    };
    store.buyerQuestionVersions.set(approved.id, approved);
    return { outcome: "APPROVED", version: { ...approved } };
  },

  async createProtocol(input: CreateProtocolInput): Promise<Protocol> {
    const store = getStore();
    const version = store.buyerQuestionVersions.get(
      input.buyerQuestionVersionId
    );
    if (!version || version.projectId !== input.projectId) {
      throw new Error("buyer_question_version_project_mismatch");
    }
    if (input.baselineProtocolId) {
      const baseline = store.protocols.get(input.baselineProtocolId);
      if (!baseline || baseline.projectId !== input.projectId) {
        throw new Error("baseline_protocol_project_mismatch");
      }
    }
    // Rule 4: run_cap can never be smaller than the plan it bounds.
    if (input.runCap < input.plannedBaselineRuns + input.plannedRetestRuns) {
      throw new Error("run_cap_below_planned_runs");
    }

    const now = new Date().toISOString();
    const protocol: Protocol = {
      id: randomUUID(),
      projectId: input.projectId,
      buyerQuestionVersionId: input.buyerQuestionVersionId,
      baselineProtocolId: input.baselineProtocolId ?? null,
      provider: input.provider,
      surface: input.surface,
      modelConfig: input.modelConfig ?? {},
      plannedBaselineRuns: input.plannedBaselineRuns,
      plannedRetestRuns: input.plannedRetestRuns,
      paraphrasePlan: input.paraphrasePlan ?? [],
      unitOfAnalysis: input.unitOfAnalysis,
      primaryMetric: input.primaryMetric,
      minimumUsefulChange: input.minimumUsefulChange ?? null,
      samplePlanningMethod: input.samplePlanningMethod,
      samplePlanningAssumptions: input.samplePlanningAssumptions ?? {},
      runCap: input.runCap,
      spendCapUsd: input.spendCapUsd,
      timeWindowSeconds: input.timeWindowSeconds,
      rateLimitPerHour: input.rateLimitPerHour,
      concurrencyLimit: input.concurrencyLimit,
      retryCap: input.retryCap,
      observationWindowRule: input.observationWindowRule ?? {},
      analyzerVersion: input.analyzerVersion ?? 1,
      entityResolutionVersion: input.entityResolutionVersion ?? 2,
      methodologyVersion: input.methodologyVersion ?? "1.1",
      status: "draft",
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.protocols.set(protocol.id, protocol);
    return { ...protocol };
  },

  async getProtocol(id: string, projectId: string): Promise<Protocol | null> {
    const p = getStore().protocols.get(id);
    if (!p || p.projectId !== projectId) return null;
    return { ...p };
  },

  async approveProtocol(
    input: ApproveProtocolInput
  ): Promise<ApproveProtocolResult> {
    // Shared contract, enforced identically by the Supabase adapter —
    // checked first, before any state mutation.
    validateApprovedByUuid(input.approvedBy);

    const store = getStore();
    const protocol = store.protocols.get(input.protocolId);
    if (!protocol || protocol.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", protocol: null };
    }
    if (
      protocol.status === "approved" ||
      protocol.status === "active" ||
      protocol.status === "completed"
    ) {
      return { outcome: "ALREADY_APPROVED", protocol: { ...protocol } };
    }
    if (protocol.status === "abandoned") {
      return { outcome: "CONFLICT", protocol: { ...protocol } };
    }
    const version = store.buyerQuestionVersions.get(
      protocol.buyerQuestionVersionId
    );
    if (!version || version.approvedAt === null) {
      return { outcome: "VERSION_NOT_APPROVED", protocol: { ...protocol } };
    }
    const now = new Date().toISOString();
    const approved: Protocol = {
      ...protocol,
      status: "approved",
      approvedBy: input.approvedBy,
      approvedAt: now,
      updatedAt: now,
    };
    store.protocols.set(approved.id, approved);
    return { outcome: "APPROVED", protocol: { ...approved } };
  },

  async admitAndReserveAttempt(
    input: AdmitAndReserveAttemptInput
  ): Promise<AdmitAndReserveAttemptResult> {
    const store = getStore();

    if (!input.idempotencyKey.trim()) throw new Error("empty_idempotency_key");
    if (input.estimatedCostUsd < 0) throw new Error("invalid_estimated_cost");

    const protocol = store.protocols.get(input.protocolId);
    if (!protocol || protocol.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", attempt: null };
    }

    // Rule 8: no attempt without an approved protocol.
    if (protocol.status !== "approved" && protocol.status !== "active") {
      return { outcome: "PROTOCOL_NOT_APPROVED", attempt: null };
    }

    const attemptsForProtocol = [...store.protocolAttempts.values()].filter(
      (a) => a.protocolId === input.protocolId
    );

    // Rule 11: a duplicate idempotency key — any status — returns the
    // existing attempt, never a new reservation.
    const existing = attemptsForProtocol.find(
      (a) => a.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      return { outcome: "ALREADY_RESERVED", attempt: { ...existing } };
    }

    if (input.retryOfAttemptId) {
      const retryTarget = attemptsForProtocol.find(
        (a) => a.id === input.retryOfAttemptId
      );
      if (!retryTarget) {
        return { outcome: "INVALID_RETRY_REFERENCE", attempt: null };
      }
      // Rule 12: retry_cap bounds the TOTAL length of the retry chain
      // from its original (non-retry) attempt, not merely how many
      // times the immediate target has been retried directly. Walk
      // from the target up to the chain's root via retryOfAttemptId,
      // counting hops: the root is retry number 0, each hop is one
      // more retry already consumed, and the attempt about to be
      // admitted would be retry number (depth + 1).
      const byId = new Map(attemptsForProtocol.map((a) => [a.id, a]));
      let depth = 0;
      let cursor = retryTarget;
      while (cursor.retryOfAttemptId) {
        const parent = byId.get(cursor.retryOfAttemptId);
        if (!parent) break;
        depth += 1;
        cursor = parent;
      }
      if (depth + 1 > protocol.retryCap) {
        return { outcome: "RETRY_CAP_EXCEEDED", attempt: null };
      }
    }

    const consumed = attemptsForProtocol.filter(
      (a) => a.status !== "cancelled"
    ).length;
    if (consumed >= protocol.runCap) {
      return { outcome: "RUN_CAP_EXCEEDED", attempt: null };
    }

    // Rule 13: an already-exceeded spend cap blocks the next admission.
    const spent = attemptsForProtocol
      .filter((a) => a.status !== "cancelled")
      .reduce((sum, a) => sum + (a.actualCostUsd ?? a.reservedCostUsd), 0);
    if (spent + input.estimatedCostUsd > protocol.spendCapUsd) {
      return { outcome: "SPEND_CAP_EXCEEDED", attempt: null };
    }

    const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
    const recent = attemptsForProtocol.filter(
      (a) => new Date(a.reservedAt).getTime() >= oneHourAgoMs
    ).length;
    if (recent >= protocol.rateLimitPerHour) {
      return { outcome: "RATE_LIMIT_EXCEEDED", attempt: null };
    }

    const concurrent = attemptsForProtocol.filter(
      (a) => a.status === "reserved" || a.status === "in_progress"
    ).length;
    if (concurrent >= protocol.concurrencyLimit) {
      return { outcome: "CONCURRENCY_LIMIT_EXCEEDED", attempt: null };
    }

    // Rule 10: this is a 'reserved' row with no probe_run_id yet — the
    // reservation exists before any probe_runs row or provider call.
    const now = new Date().toISOString();
    const attempt: ProtocolAttempt = {
      id: randomUUID(),
      projectId: input.projectId,
      protocolId: input.protocolId,
      buyerQuestionVersionId: protocol.buyerQuestionVersionId,
      attemptKind: input.attemptKind,
      status: "reserved",
      idempotencyKey: input.idempotencyKey,
      reservedCostUsd: input.estimatedCostUsd,
      actualCostUsd: null,
      probeRunId: null,
      retryOfAttemptId: input.retryOfAttemptId ?? null,
      terminationReason: null,
      reservedAt: now,
      lastActivityAt: now,
      terminalizedAt: null,
      createdAt: now,
    };
    store.protocolAttempts.set(attempt.id, attempt);
    return { outcome: "RESERVED", attempt: { ...attempt } };
  },

  async startAttempt(input: StartAttemptInput): Promise<StartAttemptResult> {
    const store = getStore();
    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", attempt: null };
    }
    if (
      attempt.status === "in_progress" &&
      attempt.probeRunId === input.probeRunId
    ) {
      return { outcome: "ALREADY_STARTED", attempt: { ...attempt } };
    }
    if (attempt.status !== "reserved") {
      return { outcome: "CONFLICT", attempt: { ...attempt } };
    }
    const started: ProtocolAttempt = {
      ...attempt,
      status: "in_progress",
      probeRunId: input.probeRunId,
      lastActivityAt: new Date().toISOString(),
    };
    store.protocolAttempts.set(started.id, started);
    return { outcome: "STARTED", attempt: { ...started } };
  },

  async reconcileAttempt(
    input: ReconcileAttemptInput
  ): Promise<ReconcileAttemptResult> {
    const store = getStore();
    if (input.actualCostUsd < 0) throw new Error("invalid_actual_cost");

    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", attempt: null };
    }
    if (attempt.terminalizedAt !== null) {
      if (attempt.status === input.status) {
        return { outcome: "ALREADY_RECONCILED", attempt: { ...attempt } };
      }
      return { outcome: "CONFLICT", attempt: { ...attempt } };
    }
    const now = new Date().toISOString();
    const reconciled: ProtocolAttempt = {
      ...attempt,
      status: input.status,
      actualCostUsd: input.actualCostUsd,
      probeRunId: input.probeRunId ?? attempt.probeRunId,
      terminationReason: input.terminationReason ?? null,
      terminalizedAt: now,
      lastActivityAt: now,
    };
    store.protocolAttempts.set(reconciled.id, reconciled);
    return { outcome: "RECONCILED", attempt: { ...reconciled } };
  },

  async getProtocolAttempts(
    protocolId: string,
    projectId: string
  ): Promise<ProtocolAttempt[]> {
    return [...getStore().protocolAttempts.values()]
      .filter((a) => a.protocolId === protocolId && a.projectId === projectId)
      .map((a) => ({ ...a }))
      .sort(
        (a, b) => new Date(a.reservedAt).getTime() - new Date(b.reservedAt).getTime()
      );
  },
};
