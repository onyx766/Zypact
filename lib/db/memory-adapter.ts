import { randomUUID } from "node:crypto";
import { createPublicReportToken } from "@/lib/snapshot-requests/public-report-token";
import type {
  AnalysisLlmCall,
  AnalysisLlmCallInput,
  Competitor,
  CompetitorInput,
  CreateProjectInput,
  CreateSnapshotRequestInput,
  DbAdapter,
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
  ProbeMode,
  ProbeResult,
  ProbeRun,
  ProbeRunStatus,
  Project,
  QaReportRow,
  QaReportRowInput,
  SaveProbeResultInput,
  SaveSnapshotReportArtifactInput,
  SnapshotReportArtifact,
  SnapshotRequest,
  SitePage,
} from "./types";
import { SnapshotRequestLimitError } from "./types";
import { evaluateSnapshotRequestLimits } from "@/lib/snapshot-requests/limits";

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
  competitorsByProject: Map<string, Competitor[]>;
  gapMapsByProject: Map<string, GapMapRow[]>;
  gapsByProject: Map<string, Gap[]>;
  evidenceBanksByProject: Map<string, EvidenceBankRow>;
  fixBriefsByProject: Map<string, FixBriefRow[]>;
  generatedAssetsByProject: Map<string, GeneratedAssetRow[]>;
  qaReportsByProject: Map<string, QaReportRow[]>;
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
      competitorsByProject: new Map(),
      gapMapsByProject: new Map(),
      gapsByProject: new Map(),
      evidenceBanksByProject: new Map(),
      fixBriefsByProject: new Map(),
      generatedAssetsByProject: new Map(),
      qaReportsByProject: new Map(),
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
    status: ProbeRunStatus = "pending"
  ): Promise<ProbeRun> {
    const run: ProbeRun = {
      id: randomUUID(),
      projectId,
      platform,
      status,
      probeMode,
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
      rawProbeRequestSha256: input.rawProbeRequestSha256 ?? null,
      fullRequestBodySha256: input.fullRequestBodySha256 ?? null,
      providerHttpStatus: input.providerHttpStatus ?? null,
      providerLatencyMs: input.providerLatencyMs ?? null,
      providerRequestId: input.providerRequestId ?? null,
      providerModel: input.providerModel ?? null,
      retryCount: input.retryCount ?? 0,
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
};
