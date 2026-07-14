import { randomUUID } from "node:crypto";
import type {
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

export const memoryAdapter: DbAdapter = {
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
    approvedBy: string
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

    const now = new Date().toISOString();

    // The database implementation records an intermediate
    // approved state inside one transaction. The in-memory
    // adapter exposes only the final queued result.
    const queuedRequest: SnapshotRequest = {
      ...request,
      status: "queued",
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
      updatedAt: new Date().toISOString(),
    };

    store.snapshotRequests.set(
      requestId,
      runningRequest
    );

    return { ...runningRequest };
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

  async getLatestQaReportForAsset(
    generatedAssetId: string
  ): Promise<QaReportRow | null> {
    const all = await memoryAdapter.getQaReportsByGeneratedAsset(
      generatedAssetId
    );
    return all[0] ?? null;
  },
};
