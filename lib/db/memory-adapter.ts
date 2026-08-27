import { randomUUID, createHash } from "node:crypto";
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
  AttemptKind,

  // M5-2 Stage A
  ProtocolExecutionJob,
  ProtocolExternalCall,
  ProviderCallReceipt,
  AnalysisCallReceipt,
  ProtocolOperatorAction,
  EnqueueProtocolExecutionJobInput,
  EnqueueProtocolExecutionJobResult,
  ClaimProtocolExecutionJobInput,
  ClaimProtocolExecutionJobResult,
  RenewProtocolExecutionJobLeaseInput,
  RenewProtocolExecutionJobLeaseResult,
  AdmitAndReserveAttemptForJobInput,
  AdmitAndReserveAttemptForJobResult,
  AdmitAndReserveAttemptForJobOutcome,
  CreateProbeRunAndStartAttemptForJobInput,
  CreateProbeRunAndStartAttemptForJobResult,
  MarkExternalCallSentForJobInput,
  MarkExternalCallSentForJobResult,
  RecordProviderCallReceiptForJobInput,
  RecordProviderCallReceiptForJobResult,
  RecordAnalysisCallReceiptForJobInput,
  RecordAnalysisCallReceiptForJobResult,
  ReconcileAttemptForJobInput,
  ReconcileAttemptForJobResult,
  CompleteProtocolExecutionJobInput,
  CompleteProtocolExecutionJobResult,
  FailProtocolExecutionJobInput,
  FailProtocolExecutionJobResult,
  ExternalCallRequest,
  FailJobWithoutAttemptForJobInput,
  FailJobWithoutAttemptForJobResult,
  AbortAttemptAndFailJobForJobInput,
  AbortAttemptAndFailJobForJobResult,
  CloseAttemptForParseFailureForJobInput,
  CloseAttemptForParseFailureForJobResult,
  ReactivateAbandonedJobInput,
  ReactivateAbandonedJobResult,
  ReactivateAbandonedJobOutcome,
  RetryFullAttemptForJobInput,
  RetryFullAttemptForJobResult,
  RetryAnalysisGenerationForJobInput,
  RetryAnalysisGenerationForJobResult,
  RetryAnalysisGenerationForJobOutcome,
  MarkAnalysisParseFailedForJobInput,
  MarkAnalysisParseFailedForJobResult,
  AuthorizeOperatorRetryInput,
  AuthorizeOperatorRetryResult,
  GetProtocolExecutionJobContextInput,
  GetProtocolExecutionJobContextResult,
  MarkProtocolExecutionJobNeedsReviewForAmbiguityInput,
  MarkProtocolExecutionJobNeedsReviewForAmbiguityResult,
  PersistProbeResultForJobInput,
  PersistProbeResultForJobResult,
  PersistProbeResultForJobOutcome,
  PersistProbeResultForJobContent,
  AlertEventType,
  AlertReasonCode,
  AlertDeliveryStatus,
  AlertDeliveryAttemptOutcome,
  ClaimNextPendingAlertInput,
  ClaimNextPendingAlertResult,
  RenewAlertLeaseInput,
  RenewAlertLeaseResult,
  MarkAlertRequestSentInput,
  MarkAlertRequestSentResult,
  RecordAlertDeliveryReceiptInput,
  RecordAlertDeliveryReceiptResult,
} from "./types";
import { SnapshotRequestLimitError } from "./types";
import { evaluateSnapshotRequestLimits } from "@/lib/snapshot-requests/limits";
import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";
import { validateApprovedByUuid } from "@/lib/db/validate-approved-by-uuid";
import { mapProductPositionToRunPosition } from "@/lib/probe-analysis/product-recommendation";

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
  // M5-2 Stage A (D-020/D-021/D-022/D-023).
  protocolExecutionJobs: Map<string, ProtocolExecutionJob>;
  protocolExternalCalls: Map<string, ProtocolExternalCall>;
  providerCallReceipts: Map<string, ProviderCallReceipt>;
  analysisCallReceipts: Map<string, AnalysisCallReceipt>;
  /** 0056 — one immutable request-evidence row per external call. */
  externalCallRequests: Map<string, ExternalCallRequest>;
  protocolOperatorActions: Map<string, ProtocolOperatorAction>;
  // D-028 — durable alert outbox.
  protocolExecutionJobAlerts: Map<string, MemoryAlertEvent>;
  protocolExecutionJobAlertDeliveries: Map<string, MemoryAlertDelivery>;
  protocolExecutionJobAlertDeliveryAttempts: Map<string, MemoryAlertDeliveryAttempt>;
  alertTransitionSeqCounter: number;
}

/** D-028 — mirrors protocol_execution_job_alerts. Immutable once inserted. */
interface MemoryAlertEvent {
  alertEventId: string;
  projectId: string;
  jobId: string;
  eventType: AlertEventType;
  reasonCode: AlertReasonCode;
  sourceAttemptId: string | null;
  sourceExternalCallId: string | null;
  transitionAt: string;
  transitionSeq: number;
}

/** D-028 — mirrors protocol_execution_job_alert_deliveries. */
interface MemoryAlertDelivery {
  deliveryId: string;
  alertEventId: string;
  status: AlertDeliveryStatus;
  workerId: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  attemptCount: number;
  createdAt: string;
}

/** D-028 — mirrors protocol_execution_job_alert_delivery_attempts. */
interface MemoryAlertDeliveryAttempt {
  attemptId: string;
  deliveryId: string;
  attemptSeq: number;
  idempotencyKey: string;
  outcome: AlertDeliveryAttemptOutcome;
  requestSentAt: string;
  finishedAt: string | null;
  resendEmailId: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
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
      protocolExecutionJobs: new Map(),
      protocolExternalCalls: new Map(),
      providerCallReceipts: new Map(),
      analysisCallReceipts: new Map(),
      externalCallRequests: new Map(),
      protocolOperatorActions: new Map(),
      protocolExecutionJobAlerts: new Map(),
      protocolExecutionJobAlertDeliveries: new Map(),
      protocolExecutionJobAlertDeliveryAttempts: new Map(),
      alertTransitionSeqCounter: 0,
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

/* -------------------------------------------------------------------------- */
/*  M5-2 Stage A — private helpers (D-020/D-021/D-022/D-023).                */
/*                                                                            */
/*  These honestly reproduce the SAME sequential branch order as the real    */
/*  SQL cores/RPCs (migrations 0050/0051), one JS call at a time. They do    */
/*  NOT simulate `FOR UPDATE`, `FOR UPDATE SKIP LOCKED`, or any genuine       */
/*  cross-process race — a single JS call runs to completion before another  */
/*  can start, which is a real but much weaker guarantee than a database     */
/*  row lock. Anything claiming to prove concurrency safety belongs in the   */
/*  disposable-Postgres runtime tests (precedent: scripts/test-m5-0051-      */
/*  runtime-contract.ts), never in this adapter.                             */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

/** Real SHA-256, matching the pgcrypto-backed `_sha256_hex` helper's algorithm class (0051) — not a placeholder. Key order is sorted, not insertion order, since jsonb's own on-disk key order is not JS object insertion order either; this adapter's fingerprints are internally consistent (same input -> same output, different input -> different output) but are never compared byte-for-byte against a real Postgres-computed fingerprint. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function operatorRetryFingerprint(fields: {
  jobId: string;
  projectId: string;
  action: string;
  sourceAttemptId: string;
  sourceExternalCallId: string | null;
  reservedCostUsd: number;
  perplexityReservedCostUsd: number | null;
}): string {
  const canonical = {
    action: fields.action,
    jobId: fields.jobId,
    perplexityReservedCostUsd: fields.perplexityReservedCostUsd,
    projectId: fields.projectId,
    reservedCostUsd: fields.reservedCostUsd,
    sourceAttemptId: fields.sourceAttemptId,
    sourceExternalCallId: fields.sourceExternalCallId,
  };
  return sha256Hex(JSON.stringify(canonical));
}

/** D-024 — reactivate_abandoned_job's fingerprint: exactly job_id/project_id/action. actor/reason are provenance metadata, excluded, exactly as D-021 excludes them for authorize_operator_retry. */
function reactivateAbandonedJobFingerprint(fields: { jobId: string; projectId: string }): string {
  const canonical = {
    action: "reactivate_abandoned",
    jobId: fields.jobId,
    projectId: fields.projectId,
  };
  return sha256Hex(JSON.stringify(canonical));
}

interface AdmitCoreParams {
  protocolId: string;
  projectId: string;
  attemptKind: AttemptKind;
  idempotencyKey: string;
  totalReservedCostUsd: number;
  retryOfAttemptId: string | null;
  jobId: string | null;
  /** D-025 — mirrors _admit_and_reserve_attempt_core's own p_baseline_ordinal (0051): supplied to the same reservation as job_id, never stamped by a later, separate write. */
  baselineOrdinal: number | null;
}

/**
 * Exactly what `_admit_and_reserve_attempt_core` (0050) can itself return —
 * a strict subset of `AdmitAndReserveAttemptForJobOutcome`/
 * `RetryFullAttemptForJobOutcome` that deliberately excludes
 * RESUME_CURRENT_ATTEMPT/CURRENT_ATTEMPT_NOT_FOUND/JOB_NOT_FOUND/
 * JOB_NOT_OWNED/SOURCE_* — those are decided by each caller BEFORE the
 * core is ever invoked, never by the core itself.
 */
type AdmitCoreOutcome =
  | "RESERVED"
  | "NOT_FOUND"
  | "PROTOCOL_NOT_APPROVED"
  | "ALREADY_RESERVED"
  | "RUN_CAP_EXCEEDED"
  | "SPEND_CAP_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "RETRY_CAP_EXCEEDED"
  | "INVALID_RETRY_REFERENCE";

interface AdmitCoreResult {
  status: AdmitCoreOutcome;
  attempt: ProtocolAttempt | null;
}

/** Mirrors `_admit_and_reserve_attempt_core` (0050) — the shared cap-check/reservation logic underneath both `admitAndReserveAttemptForJob` and `retryFullAttemptForJob`. */
function admitAndReserveAttemptCore(
  store: MemoryStore,
  params: AdmitCoreParams
): AdmitCoreResult {
  const protocol = store.protocols.get(params.protocolId);
  if (!protocol || protocol.projectId !== params.projectId) {
    return { status: "NOT_FOUND", attempt: null };
  }
  if (protocol.status !== "approved" && protocol.status !== "active") {
    return { status: "PROTOCOL_NOT_APPROVED", attempt: null };
  }

  const attemptsForProtocol = [...store.protocolAttempts.values()].filter(
    (a) => a.protocolId === params.protocolId
  );

  const existing = attemptsForProtocol.find(
    (a) => a.idempotencyKey === params.idempotencyKey
  );
  if (existing) {
    return { status: "ALREADY_RESERVED", attempt: { ...existing } };
  }

  if (params.retryOfAttemptId) {
    const retryTarget = attemptsForProtocol.find((a) => a.id === params.retryOfAttemptId);
    if (!retryTarget) {
      return { status: "INVALID_RETRY_REFERENCE", attempt: null };
    }
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
      return { status: "RETRY_CAP_EXCEEDED", attempt: null };
    }
  }

  const consumed = attemptsForProtocol.filter((a) => a.status !== "cancelled").length;
  if (consumed >= protocol.runCap) {
    return { status: "RUN_CAP_EXCEEDED", attempt: null };
  }

  const spent = attemptsForProtocol
    .filter((a) => a.status !== "cancelled")
    .reduce((sum, a) => sum + (a.actualCostUsd ?? a.reservedCostUsd), 0);
  if (spent + params.totalReservedCostUsd > protocol.spendCapUsd) {
    return { status: "SPEND_CAP_EXCEEDED", attempt: null };
  }

  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  const recent = attemptsForProtocol.filter(
    (a) => new Date(a.reservedAt).getTime() >= oneHourAgoMs
  ).length;
  if (recent >= protocol.rateLimitPerHour) {
    return { status: "RATE_LIMIT_EXCEEDED", attempt: null };
  }

  const concurrent = attemptsForProtocol.filter(
    (a) => a.status === "reserved" || a.status === "in_progress"
  ).length;
  if (concurrent >= protocol.concurrencyLimit) {
    return { status: "CONCURRENCY_LIMIT_EXCEEDED", attempt: null };
  }

  const now = nowIso();
  const attempt: ProtocolAttempt = {
    id: randomUUID(),
    projectId: params.projectId,
    protocolId: params.protocolId,
    buyerQuestionVersionId: protocol.buyerQuestionVersionId,
    attemptKind: params.attemptKind,
    status: "reserved",
    idempotencyKey: params.idempotencyKey,
    reservedCostUsd: params.totalReservedCostUsd,
    actualCostUsd: null,
    probeRunId: null,
    retryOfAttemptId: params.retryOfAttemptId,
    terminationReason: null,
    reservedAt: now,
    lastActivityAt: now,
    terminalizedAt: null,
    createdAt: now,
    jobId: params.jobId,
    // D-025: supplied by the caller in the SAME reservation as job_id —
    // mirrors _admit_and_reserve_attempt_core's own p_baseline_ordinal
    // (0051), passed straight into its INSERT rather than attached by a
    // later, separate write (the real SQL CHECK constraint is evaluated
    // immediately at INSERT time, so a later UPDATE would be too late).
    baselineOrdinal: params.baselineOrdinal,
  };
  store.protocolAttempts.set(attempt.id, attempt);
  return { status: "RESERVED", attempt: { ...attempt } };
}

/** Mirrors `_create_attempt_external_calls_core` (0050) — the two generation-1 rows (perplexity + analysis) created atomically alongside a fresh admission. */
function createAttemptExternalCallsCore(
  store: MemoryStore,
  attemptId: string,
  projectId: string,
  perplexityReservedCostUsd: number,
  analysisReservedCostUsd: number
): { perplexityCall: ProtocolExternalCall; analysisCall: ProtocolExternalCall } {
  const now = nowIso();
  const perplexityCall: ProtocolExternalCall = {
    id: randomUUID(),
    projectId,
    protocolAttemptId: attemptId,
    callKind: "perplexity",
    generation: 1,
    status: "reserved",
    reservedCostUsd: perplexityReservedCostUsd,
    actualCostUsd: null,
    costBasis: null,
    probeRunId: null,
    requestSentAt: null,
    terminalizedAt: null,
    retryOfExternalCallId: null,
    createdAt: now,
    parseFailedAt: null,
    parseFailureCode: null,
  };
  const analysisCall: ProtocolExternalCall = {
    id: randomUUID(),
    projectId,
    protocolAttemptId: attemptId,
    callKind: "analysis",
    generation: 1,
    status: "reserved",
    reservedCostUsd: analysisReservedCostUsd,
    actualCostUsd: null,
    costBasis: null,
    probeRunId: null,
    requestSentAt: null,
    terminalizedAt: null,
    retryOfExternalCallId: null,
    createdAt: now,
    parseFailedAt: null,
    parseFailureCode: null,
  };
  store.protocolExternalCalls.set(perplexityCall.id, perplexityCall);
  store.protocolExternalCalls.set(analysisCall.id, analysisCall);
  return { perplexityCall: { ...perplexityCall }, analysisCall: { ...analysisCall } };
}

interface ReserveAdditionalAnalysisCoreResult {
  status: RetryAnalysisGenerationForJobOutcome;
  externalCall: ProtocolExternalCall | null;
}

/** Mirrors `_reserve_additional_analysis_generation_core` (0050/0051) — a new, bounded analysis generation under an attempt still `in_progress`. */
function reserveAdditionalAnalysisGenerationCore(
  store: MemoryStore,
  attemptId: string,
  projectId: string,
  reservedCostUsd: number,
  retryOfExternalCallId: string | null
): ReserveAdditionalAnalysisCoreResult {
  const attempt = store.protocolAttempts.get(attemptId);
  if (!attempt || attempt.projectId !== projectId) {
    return { status: "NOT_FOUND", externalCall: null };
  }
  if (attempt.status !== "in_progress") {
    return { status: "ATTEMPT_NOT_IN_PROGRESS", externalCall: null };
  }
  const protocol = store.protocols.get(attempt.protocolId);
  if (!protocol || protocol.projectId !== projectId) {
    return { status: "PROTOCOL_NOT_FOUND", externalCall: null };
  }

  const analysisCallsForAttempt = [...store.protocolExternalCalls.values()].filter(
    (ec) => ec.protocolAttemptId === attemptId && ec.callKind === "analysis"
  );
  const maxGeneration = analysisCallsForAttempt.reduce(
    (max, ec) => Math.max(max, ec.generation),
    0
  );
  const nextGeneration = maxGeneration + 1;
  if (nextGeneration > protocol.retryCap + 1) {
    return { status: "RETRY_CAP_EXCEEDED", externalCall: null };
  }

  const attemptsForProtocol = [...store.protocolAttempts.values()].filter(
    (a) => a.protocolId === protocol.id && a.status !== "cancelled"
  );
  const spent = attemptsForProtocol.reduce(
    (sum, a) => sum + (a.actualCostUsd ?? a.reservedCostUsd),
    0
  );
  if (spent + reservedCostUsd > protocol.spendCapUsd) {
    return { status: "SPEND_CAP_EXCEEDED", externalCall: null };
  }

  const now = nowIso();
  const newCall: ProtocolExternalCall = {
    id: randomUUID(),
    projectId,
    protocolAttemptId: attemptId,
    callKind: "analysis",
    generation: nextGeneration,
    status: "reserved",
    reservedCostUsd,
    actualCostUsd: null,
    costBasis: null,
    probeRunId: null,
    requestSentAt: null,
    terminalizedAt: null,
    retryOfExternalCallId: retryOfExternalCallId,
    createdAt: now,
    parseFailedAt: null,
    parseFailureCode: null,
  };
  store.protocolExternalCalls.set(newCall.id, newCall);
  store.protocolAttempts.set(attemptId, {
    ...attempt,
    reservedCostUsd: attempt.reservedCostUsd + reservedCostUsd,
    lastActivityAt: now,
  });
  return { status: "RESERVED", externalCall: { ...newCall } };
}

function jobFencingOk(
  job: ProtocolExecutionJob,
  claimToken: string
): boolean {
  return (
    job.claimToken === claimToken &&
    job.leaseExpiresAt !== null &&
    new Date(job.leaseExpiresAt).getTime() > Date.now() &&
    (job.status === "claimed" || job.status === "running")
  );
}

/**
 * D-028 — mirrors the outbox-emission CTE pattern added to
 * record_provider_call_receipt_for_job / record_analysis_call_receipt_
 * for_job / mark_protocol_execution_job_needs_review_for_ambiguity /
 * claim_protocol_execution_job's sweep: one immutable alert event per
 * real transition, plus its corresponding 'pending' delivery row,
 * created together -- never a delivery-less event.
 */
/**
 * 0056 — mirrors `public._close_unknown_outcome_core`.
 *
 * An unknown provider outcome used to move the job and stop there, which
 * left the attempt open and the unsent legs `reserved` — a state
 * `reconcileAttemptForJob` can only ever refuse. The SQL closes all of it
 * in the receipt RPC's own transaction, so the in-memory adapter must do
 * exactly the same or the two layers disagree about what "closed" means.
 */
function closeUnknownOutcomeCore(
  store: MemoryStore,
  job: ProtocolExecutionJob,
  attemptId: string,
  externalCallId: string,
  reasonCode: AlertReasonCode
): void {
  for (const c of store.protocolExternalCalls.values()) {
    if (c.protocolAttemptId === attemptId && c.projectId === job.projectId && c.status === "reserved") {
      store.protocolExternalCalls.set(c.id, { ...c, status: "cancelled", terminalizedAt: nowIso() });
    }
  }
  const attempt = store.protocolAttempts.get(attemptId);
  if (attempt && attempt.terminalizedAt === null) {
    // Inconclusive, not failed: we do not know whether the provider did
    // the work. 'timed_out' is the honest terminal label.
    store.protocolAttempts.set(attempt.id, {
      ...attempt,
      status: "timed_out",
      terminationReason: reasonCode,
      terminalizedAt: nowIso(),
      lastActivityAt: nowIso(),
    });
  }
  // A terminalised attempt must stop being the current one.
  const live = store.protocolExecutionJobs.get(job.id);
  if (live && live.currentAttemptId === attemptId) {
    store.protocolExecutionJobs.set(live.id, { ...live, currentAttemptId: null });
  }
  moveJobToNeedsReview(store, store.protocolExecutionJobs.get(job.id) ?? job, reasonCode, attemptId, externalCallId);
}

/**
 * 0056 — mirrors `public._move_job_to_needs_review`: the job transitions
 * and one alert lands, only for a job that was actually live.
 */
function moveJobToNeedsReview(
  store: MemoryStore,
  job: ProtocolExecutionJob,
  reasonCode: AlertReasonCode,
  sourceAttemptId: string | null,
  sourceExternalCallId: string | null
): void {
  if (job.status !== "claimed" && job.status !== "running") return;
  store.protocolExecutionJobs.set(job.id, {
    ...job,
    status: "needs_review",
    needsReviewReason: reasonCode,
    updatedAt: nowIso(),
  });
  recordAlertEvent(store, {
    projectId: job.projectId,
    jobId: job.id,
    eventType: "needs_review",
    reasonCode,
    sourceAttemptId,
    sourceExternalCallId,
  });
}

function recordAlertEvent(
  store: MemoryStore,
  fields: {
    projectId: string;
    jobId: string;
    eventType: AlertEventType;
    reasonCode: AlertReasonCode;
    sourceAttemptId: string | null;
    sourceExternalCallId: string | null;
  }
): void {
  store.alertTransitionSeqCounter += 1;
  const alertEventId = randomUUID();
  const event: MemoryAlertEvent = {
    alertEventId,
    projectId: fields.projectId,
    jobId: fields.jobId,
    eventType: fields.eventType,
    reasonCode: fields.reasonCode,
    sourceAttemptId: fields.sourceAttemptId,
    sourceExternalCallId: fields.sourceExternalCallId,
    transitionAt: nowIso(),
    transitionSeq: store.alertTransitionSeqCounter,
  };
  store.protocolExecutionJobAlerts.set(alertEventId, event);

  const delivery: MemoryAlertDelivery = {
    deliveryId: randomUUID(),
    alertEventId,
    status: "pending",
    workerId: null,
    claimToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    attemptCount: 0,
    createdAt: nowIso(),
  };
  store.protocolExecutionJobAlertDeliveries.set(delivery.deliveryId, delivery);
}

function receiptOutcomeToCallStatus(
  outcome: "success" | "provider_error" | "provider_outcome_unknown"
): "completed" | "failed" | "timed_out" {
  if (outcome === "success") return "completed";
  if (outcome === "provider_error") return "failed";
  return "timed_out";
}

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
      fullRequestBody: input.fullRequestBody ?? null,
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
    // D-026: mirrors probe_results_probe_run_id_key (0052) — a real
    // UNIQUE(probe_run_id) constraint, not merely a convention. Without
    // this check MemoryAdapter would silently allow a second
    // probe_results row for the same probe_run_id, something the real
    // database now rejects outright.
    if (list.some((existing) => existing.probeRunId === row.probeRunId)) {
      throw new Error(
        `saveProbeResult: a probe_results row already exists for probeRunId ${row.probeRunId} (probe_results_probe_run_id_key)`
      );
    }
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
      fullRequestBody: input.fullRequestBody ?? null,
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
      // M4 raw admission (not job-scoped) — jobId is exclusively set by
      // the *_for_job admission path below.
      jobId: null,
      baselineOrdinal: null,
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

  // ------------------------------------------------------------------------
  // M5-2 Stage A (D-020/D-021/D-022/D-023). Sequential, honest reproduction
  // of the same branch order as the real RPCs — no FOR UPDATE, no real
  // concurrency guarantee. start_attempt_for_job and
  // reserve_additional_analysis_generation_for_job are deliberately not
  // implemented as adapter methods (D-023 §1).
  // ------------------------------------------------------------------------

  async enqueueProtocolExecutionJob(
    input: EnqueueProtocolExecutionJobInput
  ): Promise<EnqueueProtocolExecutionJobResult> {
    const store = getStore();
    const maxAttempts = input.maxAttempts ?? 3;
    if (maxAttempts < 1) throw new Error("invalid_enqueue_protocol_execution_job_args");

    const protocol = store.protocols.get(input.protocolId);
    if (!protocol || protocol.projectId !== input.projectId) {
      return { outcome: "PROTOCOL_NOT_FOUND", job: null };
    }
    if (protocol.status !== "approved" && protocol.status !== "active") {
      return { outcome: "PROTOCOL_NOT_APPROVED", job: null };
    }

    // D-025: a job with no planned baseline slot to run would either
    // never admit anything or be vacuously completable — refuse before
    // any row is created.
    if (protocol.plannedBaselineRuns === 0) {
      return { outcome: "NO_BASELINE_RUNS_PLANNED", job: null };
    }

    const existing = [...store.protocolExecutionJobs.values()].find(
      (j) => j.protocolId === input.protocolId && j.projectId === input.projectId
    );
    if (existing) {
      return { outcome: "ALREADY_EXISTS", job: { ...existing } };
    }

    const now = nowIso();

    // D-026 (correction) — the dataset batch is created directly here,
    // atomically with the job, mirroring migration 0052's own INSERT
    // into dataset_batches (never through createDatasetBatch/
    // createManualScanDatasetBatch/resolveDatasetBatchForInvocation,
    // which remain reserved for the snapshot-request and legacy-backfill
    // writers this path has nothing to do with). manual_scan is the only
    // source type M5 can reach here, matching the SQL exactly.
    const datasetBatch: DatasetBatch = {
      id: randomUUID(),
      projectId: input.projectId,
      datasetSourceType: "manual_scan",
      snapshotRequestId: null,
      backfillKey: null,
      note: null,
      createdAt: now,
    };
    store.datasetBatches.set(datasetBatch.id, datasetBatch);

    const job: ProtocolExecutionJob = {
      id: randomUUID(),
      projectId: input.projectId,
      protocolId: input.protocolId,
      status: "queued",
      workerId: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      maxAttempts,
      currentAttemptId: null,
      nextBaselineOrdinal: 1,
      needsReviewReason: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      datasetBatchId: datasetBatch.id,
    };
    store.protocolExecutionJobs.set(job.id, job);
    return { outcome: "QUEUED", job: { ...job } };
  },

  async claimProtocolExecutionJob(
    input: ClaimProtocolExecutionJobInput
  ): Promise<ClaimProtocolExecutionJobResult> {
    const store = getStore();
    if (!input.workerId.trim() || input.leaseSeconds <= 0) {
      throw new Error("invalid_claim_protocol_execution_job_args");
    }

    const nowMs = Date.now();

    // Sweep expired, exhausted claimed/running jobs to abandoned_exhausted
    // first — mirrors claim_protocol_execution_job's own leading UPDATE.
    for (const [id, j] of store.protocolExecutionJobs) {
      if (
        (j.status === "claimed" || j.status === "running") &&
        j.leaseExpiresAt !== null &&
        new Date(j.leaseExpiresAt).getTime() < nowMs &&
        j.attemptCount >= j.maxAttempts
      ) {
        store.protocolExecutionJobs.set(id, { ...j, status: "abandoned_exhausted", updatedAt: nowIso() });
        recordAlertEvent(store, {
          projectId: j.projectId,
          jobId: id,
          eventType: "abandoned_exhausted",
          reasonCode: "attempts_exhausted",
          sourceAttemptId: null,
          sourceExternalCallId: null,
        });
      }
    }

    const candidates = [...store.protocolExecutionJobs.values()]
      .filter(
        (j) =>
          j.status === "queued" ||
          ((j.status === "claimed" || j.status === "running") &&
            j.leaseExpiresAt !== null &&
            new Date(j.leaseExpiresAt).getTime() < nowMs &&
            j.attemptCount < j.maxAttempts)
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const candidate = candidates[0];
    if (!candidate) {
      return { outcome: "NO_JOB_AVAILABLE", job: null, claimToken: null };
    }

    const claimToken = randomUUID();
    const now = nowIso();
    const claimed: ProtocolExecutionJob = {
      ...candidate,
      status: "claimed",
      workerId: input.workerId,
      claimToken,
      leaseExpiresAt: new Date(nowMs + input.leaseSeconds * 1000).toISOString(),
      attemptCount: candidate.attemptCount + 1,
      updatedAt: now,
    };
    store.protocolExecutionJobs.set(claimed.id, claimed);
    return { outcome: "CLAIMED", job: { ...claimed }, claimToken };
  },

  async renewProtocolExecutionJobLease(
    input: RenewProtocolExecutionJobLeaseInput
  ): Promise<RenewProtocolExecutionJobLeaseResult> {
    const store = getStore();
    if (input.leaseSeconds <= 0) throw new Error("invalid_renew_protocol_execution_job_lease_args");

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", job: { ...job } };
    }

    const now = nowIso();
    const renewed: ProtocolExecutionJob = {
      ...job,
      leaseExpiresAt: new Date(Date.now() + input.leaseSeconds * 1000).toISOString(),
      updatedAt: now,
    };
    store.protocolExecutionJobs.set(renewed.id, renewed);
    return { outcome: "RENEWED", job: { ...renewed } };
  },

  async admitAndReserveAttemptForJob(
    input: AdmitAndReserveAttemptForJobInput
  ): Promise<AdmitAndReserveAttemptForJobResult> {
    const store = getStore();
    if (input.perplexityReservedCostUsd < 0 || input.analysisReservedCostUsd < 0) {
      throw new Error("invalid_admit_and_reserve_attempt_for_job_args");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return {
        outcome: "JOB_NOT_FOUND",
        attempt: null,
        perplexityCall: null,
        analysisCall: null,
      };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return {
        outcome: "JOB_NOT_OWNED",
        attempt: null,
        perplexityCall: null,
        analysisCall: null,
      };
    }

    // D-021: current_attempt_id already set -> resume, never a second admission.
    if (job.currentAttemptId !== null) {
      const resumeAttempt = store.protocolAttempts.get(job.currentAttemptId);
      if (!resumeAttempt || resumeAttempt.jobId !== job.id || resumeAttempt.projectId !== job.projectId) {
        return {
          outcome: "CURRENT_ATTEMPT_NOT_FOUND",
          attempt: null,
          perplexityCall: null,
          analysisCall: null,
        };
      }
      const callsForAttempt = [...store.protocolExternalCalls.values()].filter(
        (ec) => ec.protocolAttemptId === resumeAttempt.id
      );
      const perplexityCall =
        callsForAttempt.find((ec) => ec.callKind === "perplexity" && ec.generation === 1) ?? null;
      const analysisCall =
        callsForAttempt
          .filter((ec) => ec.callKind === "analysis")
          .sort((a, b) => b.generation - a.generation)[0] ?? null;
      return {
        outcome: "RESUME_CURRENT_ATTEMPT",
        attempt: { ...resumeAttempt },
        perplexityCall: perplexityCall ? { ...perplexityCall } : null,
        analysisCall: analysisCall ? { ...analysisCall } : null,
      };
    }

    // D-025: no current attempt — this must be the admission of the slot
    // named by next_baseline_ordinal, never a free-form caller-chosen key.
    const expectedKey = `${job.id}:baseline:${job.nextBaselineOrdinal}`;
    if (input.idempotencyKey !== expectedKey) {
      return {
        outcome: "INVALID_IDEMPOTENCY_KEY",
        attempt: null,
        perplexityCall: null,
        analysisCall: null,
      };
    }

    const protocol = store.protocols.get(job.protocolId);
    // Defensive guard: the completion gate only ever advances
    // next_baseline_ordinal up to planned_baseline_runs, and a succeeded
    // job is already refused above by jobFencingOk — unreachable in
    // normal operation.
    if (!protocol || job.nextBaselineOrdinal > protocol.plannedBaselineRuns) {
      return {
        outcome: "BASELINE_SLOTS_EXHAUSTED",
        attempt: null,
        perplexityCall: null,
        analysisCall: null,
      };
    }

    // D-025: baselineOrdinal supplied in the SAME reservation as job_id
    // (never a later, separate stamp) so the memory adapter's own write
    // ordering matches the real SQL, where the equivalent CHECK
    // constraint is evaluated immediately at INSERT time.
    const core = admitAndReserveAttemptCore(store, {
      protocolId: job.protocolId,
      projectId: input.projectId,
      attemptKind: input.attemptKind,
      idempotencyKey: input.idempotencyKey,
      totalReservedCostUsd: input.perplexityReservedCostUsd + input.analysisReservedCostUsd,
      retryOfAttemptId: input.retryOfAttemptId ?? null,
      jobId: job.id,
      baselineOrdinal: job.nextBaselineOrdinal,
    });
    if (core.status !== "RESERVED" || !core.attempt) {
      return { outcome: core.status, attempt: core.attempt, perplexityCall: null, analysisCall: null };
    }

    const { perplexityCall, analysisCall } = createAttemptExternalCallsCore(
      store,
      core.attempt.id,
      input.projectId,
      input.perplexityReservedCostUsd,
      input.analysisReservedCostUsd
    );

    const now = nowIso();
    store.protocolExecutionJobs.set(job.id, {
      ...job,
      status: "running",
      currentAttemptId: core.attempt.id,
      updatedAt: now,
    });

    return { outcome: "RESERVED", attempt: core.attempt, perplexityCall, analysisCall };
  },

  async createProbeRunAndStartAttemptForJob(
    input: CreateProbeRunAndStartAttemptForJobInput
  ): Promise<CreateProbeRunAndStartAttemptForJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", attempt: null, probeRun: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", attempt: null, probeRun: null };
    }

    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== input.projectId) {
      return { outcome: "CONFLICT", attempt: null, probeRun: null };
    }

    if (attempt.status === "in_progress") {
      if (attempt.probeRunId === null) {
        return { outcome: "CONFLICT", attempt: { ...attempt }, probeRun: null };
      }
      const run = store.probeRuns.get(attempt.probeRunId);
      if (!run || run.projectId !== input.projectId) {
        return { outcome: "CONFLICT", attempt: { ...attempt }, probeRun: null };
      }
      return { outcome: "ALREADY_STARTED", attempt: { ...attempt }, probeRun: { ...run } };
    }

    if (attempt.status !== "reserved") {
      return { outcome: "ATTEMPT_TERMINAL", attempt: { ...attempt }, probeRun: null };
    }

    // D-026 (correction) — the dataset is derived exclusively from
    // job.datasetBatchId (set once, atomically, by
    // enqueueProtocolExecutionJob); no caller-supplied dataset argument
    // exists on this input anymore. job.datasetBatchId is never null
    // (mirrors the SQL NOT NULL + composite FK), so this lookup is
    // defensive, not a real branch.
    const datasetBatch = store.datasetBatches.get(job.datasetBatchId);
    if (!datasetBatch || datasetBatch.projectId !== input.projectId) {
      throw new Error(
        `dataset_batch_not_found_for_job: job ${job.id} references dataset_batch_id ${job.datasetBatchId}, which does not exist or is not project-scoped`
      );
    }

    const now = nowIso();
    const run: ProbeRun = {
      id: randomUUID(),
      projectId: input.projectId,
      platform: input.platform,
      status: "pending",
      probeMode: input.probeMode,
      snapshotRequestId: null,
      datasetId: datasetBatch.id,
      datasetSourceType: datasetBatch.datasetSourceType,
      createdAt: now,
    };
    store.probeRuns.set(run.id, run);

    const started: ProtocolAttempt = {
      ...attempt,
      status: "in_progress",
      probeRunId: run.id,
      lastActivityAt: now,
    };
    store.protocolAttempts.set(started.id, started);

    return { outcome: "STARTED", attempt: { ...started }, probeRun: { ...run } };
  },

  async markExternalCallSentForJob(
    input: MarkExternalCallSentForJobInput
  ): Promise<MarkExternalCallSentForJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", externalCall: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", externalCall: null };
    }

    const call = store.protocolExternalCalls.get(input.externalCallId);
    if (!call || call.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", externalCall: null };
    }
    const owningAttempt = store.protocolAttempts.get(call.protocolAttemptId);
    if (!owningAttempt || owningAttempt.jobId !== job.id || owningAttempt.projectId !== input.projectId) {
      return { outcome: "CALL_NOT_OWNED_BY_JOB", externalCall: null };
    }
    if (call.callKind !== input.callKind) {
      return { outcome: "WRONG_CALL_KIND", externalCall: { ...call } };
    }
    if (input.requestBodySha256 !== sha256Hex(input.requestBody)) {
      throw new Error("invalid_mark_external_call_sent_for_job_args");
    }

    // 0056 — evidence is read BEFORE any status decision. That is what
    // makes a genuine replay distinguishable from a second send.
    const evidence = store.externalCallRequests.get(input.externalCallId);

    if (call.status === "reserved" && !evidence) {
      store.externalCallRequests.set(input.externalCallId, {
        id: randomUUID(),
        projectId: input.projectId,
        externalCallId: input.externalCallId,
        callKind: input.callKind,
        requestBody: input.requestBody,
        requestBodySha256: input.requestBodySha256,
        recordedAt: nowIso(),
      });
      const sent: ProtocolExternalCall = {
        ...call,
        status: "in_progress",
        probeRunId: input.probeRunId,
        requestSentAt: nowIso(),
      };
      store.protocolExternalCalls.set(sent.id, sent);
      return { outcome: "SENT", externalCall: { ...sent } };
    }

    if (
      evidence &&
      call.status !== "reserved" &&
      evidence.callKind === input.callKind &&
      evidence.requestBodySha256 === input.requestBodySha256 &&
      evidence.requestBody === input.requestBody
    ) {
      return { outcome: "ALREADY_SENT_SAME_EVIDENCE", externalCall: { ...call } };
    }

    moveJobToNeedsReview(store, job, "request_evidence_conflict", call.protocolAttemptId, call.id);
    return { outcome: "REQUEST_EVIDENCE_CONFLICT", externalCall: { ...call } };
  },

  async recordProviderCallReceiptForJob(
    input: RecordProviderCallReceiptForJobInput
  ): Promise<RecordProviderCallReceiptForJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", externalCall: null, receipt: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", externalCall: null, receipt: null };
    }

    const call = store.protocolExternalCalls.get(input.externalCallId);
    if (!call || call.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", externalCall: null, receipt: null };
    }
    if (call.callKind !== "perplexity") {
      return { outcome: "WRONG_CALL_KIND", externalCall: { ...call }, receipt: null };
    }
    const owningAttempt = store.protocolAttempts.get(call.protocolAttemptId);
    if (!owningAttempt || owningAttempt.jobId !== job.id || owningAttempt.projectId !== input.projectId) {
      return { outcome: "CALL_NOT_OWNED_BY_JOB", externalCall: null, receipt: null };
    }
    // 0056 — a receipt already on record decides everything. Idempotence
    // here means "this same RPC was replayed after its reply was lost", so
    // every evidentiary field is compared, latency and cost included: a
    // second provider call cannot reproduce a latency and must conflict.
    const existingProvider = [...store.providerCallReceipts.values()].find(
      (r) => r.externalCallId === input.externalCallId
    );
    if (existingProvider) {
      const identical =
        existingProvider.probeRunId === input.probeRunId &&
        existingProvider.outcome === input.outcome &&
        (existingProvider.httpStatus ?? null) === (input.httpStatus ?? null) &&
        (existingProvider.providerRequestId ?? null) === (input.providerRequestId ?? null) &&
        (existingProvider.rawResponseSha256 ?? null) === (input.rawResponseSha256 ?? null) &&
        (existingProvider.rawResponseBody ?? null) === (input.rawResponseBody ?? null) &&
        (existingProvider.latencyMs ?? null) === (input.latencyMs ?? null) &&
        (call.actualCostUsd ?? null) === (input.actualCostUsd ?? null) &&
        (call.costBasis ?? null) === (input.costBasis ?? null);
      if (identical) {
        return {
          outcome: "ALREADY_RECEIPTED_IDENTICAL",
          externalCall: { ...call },
          receipt: { ...existingProvider },
        };
      }
      moveJobToNeedsReview(store, job, "receipt_evidence_conflict", call.protocolAttemptId, call.id);
      return {
        outcome: "RECEIPT_EVIDENCE_CONFLICT",
        externalCall: { ...call },
        receipt: { ...existingProvider },
      };
    }

    if (call.status !== "in_progress" || call.probeRunId !== input.probeRunId) {
      return { outcome: "CONFLICT", externalCall: { ...call }, receipt: null };
    }

    // D-026: mirrors provider_call_receipts_content_hash_pairing_check /
    // _success_requires_content_check / _content_hash_match_check (0052)
    // — real validation, not merely documented discipline, so a caller
    // bug (mismatched hash, or success with no body) fails the same way
    // here as it would against the real database.
    const rawResponseBody = input.rawResponseBody ?? null;
    const rawResponseSha256 = input.rawResponseSha256 ?? null;
    if ((rawResponseBody === null) !== (rawResponseSha256 === null)) {
      throw new Error(
        "invalid_record_provider_call_receipt_for_job_args: rawResponseBody and rawResponseSha256 must be paired"
      );
    }
    if (input.outcome === "success" && rawResponseBody === null) {
      throw new Error(
        "invalid_record_provider_call_receipt_for_job_args: outcome 'success' requires rawResponseBody"
      );
    }
    if (rawResponseBody !== null && rawResponseSha256 !== null && sha256Hex(rawResponseBody) !== rawResponseSha256) {
      throw new Error(
        "invalid_record_provider_call_receipt_for_job_args: rawResponseSha256 does not match sha256(rawResponseBody)"
      );
    }

    // D-023 §3: "unknown" is application-level only in Stage A — never
    // written where the real schema's CHECK would reject it (see the
    // Supabase adapter's identical rule).
    const costBasis =
      input.costBasis === "measured" || input.costBasis === "estimated" ? input.costBasis : null;
    const actualCostUsd = costBasis === null ? null : input.actualCostUsd ?? null;

    const now = nowIso();
    const receipt: ProviderCallReceipt = {
      id: randomUUID(),
      projectId: input.projectId,
      externalCallId: input.externalCallId,
      probeRunId: input.probeRunId,
      outcome: input.outcome,
      httpStatus: input.httpStatus ?? null,
      providerRequestId: input.providerRequestId ?? null,
      rawResponseSha256,
      latencyMs: input.latencyMs ?? null,
      receivedAt: now,
      createdAt: now,
      rawResponseBody,
    };
    store.providerCallReceipts.set(receipt.id, receipt);

    const updatedCall: ProtocolExternalCall = {
      ...call,
      status: receiptOutcomeToCallStatus(input.outcome),
      actualCostUsd,
      costBasis,
      terminalizedAt: now,
    };
    store.protocolExternalCalls.set(updatedCall.id, updatedCall);

    if (input.outcome === "provider_outcome_unknown") {
      closeUnknownOutcomeCore(
        store, job, call.protocolAttemptId, input.externalCallId, "perplexity_outcome_unknown"
      );
    }

    return { outcome: "RECEIPTED", externalCall: { ...updatedCall }, receipt: { ...receipt } };
  },

  async recordAnalysisCallReceiptForJob(
    input: RecordAnalysisCallReceiptForJobInput
  ): Promise<RecordAnalysisCallReceiptForJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", externalCall: null, receipt: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", externalCall: null, receipt: null };
    }

    const call = store.protocolExternalCalls.get(input.externalCallId);
    if (!call || call.projectId !== input.projectId) {
      return { outcome: "NOT_FOUND", externalCall: null, receipt: null };
    }
    if (call.callKind !== "analysis") {
      return { outcome: "WRONG_CALL_KIND", externalCall: { ...call }, receipt: null };
    }
    const owningAttempt = store.protocolAttempts.get(call.protocolAttemptId);
    if (!owningAttempt || owningAttempt.jobId !== job.id || owningAttempt.projectId !== input.projectId) {
      return { outcome: "CALL_NOT_OWNED_BY_JOB", externalCall: null, receipt: null };
    }
    // 0056 — same full-field identity as the provider leg.
    const existingAnalysis = [...store.analysisCallReceipts.values()].find(
      (r) => r.externalCallId === input.externalCallId
    );
    if (existingAnalysis) {
      const identical =
        existingAnalysis.probeRunId === input.probeRunId &&
        existingAnalysis.outcome === input.outcome &&
        (existingAnalysis.provider ?? null) === (input.provider ?? null) &&
        (existingAnalysis.model ?? null) === (input.model ?? null) &&
        existingAnalysis.usedMock === (input.usedMock ?? false) &&
        (existingAnalysis.requestSha256 ?? null) === (input.requestSha256 ?? null) &&
        (existingAnalysis.rawRequestBody ?? null) === (input.rawRequestBody ?? null) &&
        (existingAnalysis.responseSha256 ?? null) === (input.responseSha256 ?? null) &&
        (existingAnalysis.rawContent ?? null) === (input.rawContent ?? null) &&
        (existingAnalysis.latencyMs ?? null) === (input.latencyMs ?? null) &&
        (call.actualCostUsd ?? null) === (input.actualCostUsd ?? null) &&
        (call.costBasis ?? null) === (input.costBasis ?? null);
      if (identical) {
        return {
          outcome: "ALREADY_RECEIPTED_IDENTICAL",
          externalCall: { ...call },
          receipt: { ...existingAnalysis },
        };
      }
      moveJobToNeedsReview(store, job, "receipt_evidence_conflict", call.protocolAttemptId, call.id);
      return {
        outcome: "RECEIPT_EVIDENCE_CONFLICT",
        externalCall: { ...call },
        receipt: { ...existingAnalysis },
      };
    }

    if (call.status !== "in_progress" || call.probeRunId !== input.probeRunId) {
      return { outcome: "CONFLICT", externalCall: { ...call }, receipt: null };
    }

    // D-026: mirrors analysis_call_receipts_content_hash_pairing_check /
    // _success_requires_content_check / _content_hash_match_check (0052).
    // rawContent pairs only with responseSha256 — requestSha256 has no
    // equivalent content field in this tranche.
    const rawContent = input.rawContent ?? null;
    const responseSha256 = input.responseSha256 ?? null;
    if ((rawContent === null) !== (responseSha256 === null)) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: rawContent and responseSha256 must be paired"
      );
    }
    if (input.outcome === "success" && rawContent === null) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: outcome 'success' requires rawContent"
      );
    }
    if (rawContent !== null && responseSha256 !== null && sha256Hex(rawContent) !== responseSha256) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: responseSha256 does not match sha256(rawContent)"
      );
    }

    // D-027: mirrors analysis_call_receipts_request_pairing_check /
    // _request_hash_match_check / _request_mock_pairing_check (0053).
    // used_mock=true requires both null; used_mock=false requires both
    // non-null -- real validation, not merely documented discipline.
    const usedMock = input.usedMock ?? false;
    const rawRequestBody = input.rawRequestBody ?? null;
    const requestSha256 = input.requestSha256 ?? null;
    if ((rawRequestBody === null) !== (requestSha256 === null)) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: rawRequestBody and requestSha256 must be paired"
      );
    }
    if (rawRequestBody !== null && requestSha256 !== null && sha256Hex(rawRequestBody) !== requestSha256) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: requestSha256 does not match sha256(rawRequestBody)"
      );
    }
    if (usedMock && (rawRequestBody !== null || requestSha256 !== null)) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: usedMock=true requires rawRequestBody/requestSha256 both null"
      );
    }
    if (!usedMock && (rawRequestBody === null || requestSha256 === null)) {
      throw new Error(
        "invalid_record_analysis_call_receipt_for_job_args: usedMock=false requires rawRequestBody/requestSha256 both non-null"
      );
    }

    const costBasis =
      input.costBasis === "measured" || input.costBasis === "estimated" ? input.costBasis : null;
    const actualCostUsd = costBasis === null ? null : input.actualCostUsd ?? null;

    const now = nowIso();
    // 0056 — two durable proofs of the same request may never contradict.
    const requestEvidence = store.externalCallRequests.get(input.externalCallId);
    // D-027's mock policy mandates BOTH request fields null when
    // usedMock is true, so there is nothing to compare there: a simulated
    // call has no real outbound bytes to durabilize in its receipt, even
    // though the worker still recorded what it prepared.
    if (
      requestEvidence &&
      input.usedMock !== true &&
      (requestEvidence.requestBody !== (input.rawRequestBody ?? null) ||
        requestEvidence.requestBodySha256 !== (input.requestSha256 ?? null))
    ) {
      moveJobToNeedsReview(store, job, "request_evidence_conflict", call.protocolAttemptId, call.id);
      return { outcome: "REQUEST_EVIDENCE_CONFLICT", externalCall: { ...call }, receipt: null };
    }

    const receipt: AnalysisCallReceipt = {
      id: randomUUID(),
      projectId: input.projectId,
      externalCallId: input.externalCallId,
      probeRunId: input.probeRunId,
      outcome: input.outcome,
      provider: input.provider ?? null,
      model: input.model ?? null,
      usedMock: input.usedMock ?? false,
      requestSha256,
      responseSha256,
      latencyMs: input.latencyMs ?? null,
      receivedAt: now,
      createdAt: now,
      rawContent,
      rawRequestBody,
    };
    store.analysisCallReceipts.set(receipt.id, receipt);

    const updatedCall: ProtocolExternalCall = {
      ...call,
      status: receiptOutcomeToCallStatus(input.outcome),
      actualCostUsd,
      costBasis,
      terminalizedAt: now,
    };
    store.protocolExternalCalls.set(updatedCall.id, updatedCall);

    if (input.outcome === "provider_outcome_unknown") {
      closeUnknownOutcomeCore(
        store, job, call.protocolAttemptId, input.externalCallId, "analysis_outcome_unknown"
      );
    }

    return { outcome: "RECEIPTED", externalCall: { ...updatedCall }, receipt: { ...receipt } };
  },

  async reconcileAttemptForJob(
    input: ReconcileAttemptForJobInput
  ): Promise<ReconcileAttemptForJobResult> {
    const store = getStore();
    const validStatuses = new Set(["completed", "failed", "timed_out", "cancelled", "excluded"]);
    if (!validStatuses.has(input.status)) {
      return { outcome: "INVALID_STATUS", attempt: null };
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", attempt: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", attempt: null };
    }

    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.projectId !== input.projectId || attempt.jobId !== job.id) {
      return { outcome: "ATTEMPT_NOT_OWNED_BY_JOB", attempt: null };
    }

    if (attempt.terminalizedAt !== null) {
      if (attempt.status === input.status) {
        return { outcome: "ALREADY_RECONCILED", attempt: { ...attempt } };
      }
      return { outcome: "CONFLICT", attempt: { ...attempt } };
    }

    const callsForAttempt = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === input.attemptId
    );
    const openCalls = callsForAttempt.filter(
      (ec) => ec.status === "reserved" || ec.status === "in_progress"
    );
    if (openCalls.length > 0) {
      return { outcome: "EXTERNAL_CALLS_NOT_TERMINAL", attempt: { ...attempt } };
    }

    const terminalCalls = callsForAttempt.filter((ec) =>
      ["completed", "failed", "timed_out", "cancelled"].includes(ec.status)
    );
    const hasUnknown = terminalCalls.some((ec) => ec.actualCostUsd === null);
    const knownSum = terminalCalls.reduce((sum, ec) => sum + (ec.actualCostUsd ?? 0), 0);
    const actualCostUsd = hasUnknown ? null : knownSum;

    const now = nowIso();
    const reconciled: ProtocolAttempt = {
      ...attempt,
      status: input.status,
      actualCostUsd,
      terminationReason: input.terminationReason ?? null,
      terminalizedAt: now,
      lastActivityAt: now,
    };
    store.protocolAttempts.set(reconciled.id, reconciled);
    return { outcome: "RECONCILED", attempt: { ...reconciled } };
  },

  async completeProtocolExecutionJob(
    input: CompleteProtocolExecutionJobInput
  ): Promise<CompleteProtocolExecutionJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }
    // D-020: ALREADY_SUCCEEDED / CONFLICT precede fencing — a terminal job
    // has no live owner left to validate.
    if (job.status === "succeeded") {
      return { outcome: "ALREADY_SUCCEEDED", job: { ...job } };
    }
    if (job.status === "failed" || job.status === "needs_review" || job.status === "abandoned_exhausted") {
      return { outcome: "CONFLICT", job: { ...job } };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", job: { ...job } };
    }
    // D-025: current_attempt_id is null in two distinct cases now — the
    // job has never been admitted at all (nextBaselineOrdinal still at
    // its default of 1, genuine NO_CURRENT_ATTEMPT), or it already
    // advanced past a completed slot and is waiting for the next
    // admission (nextBaselineOrdinal > 1, set only by this same
    // function's own advancement below). A replay after that advancement
    // but before the next admission returns NEXT_BASELINE_REQUIRED
    // idempotently, with zero further mutation.
    if (job.currentAttemptId === null) {
      if (job.nextBaselineOrdinal > 1) {
        return { outcome: "NEXT_BASELINE_REQUIRED", job: { ...job } };
      }
      return { outcome: "NO_CURRENT_ATTEMPT", job: { ...job } };
    }

    const attempt = store.protocolAttempts.get(job.currentAttemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== job.projectId) {
      return { outcome: "CURRENT_ATTEMPT_NOT_FOUND", job: { ...job } };
    }
    if (attempt.terminalizedAt === null) {
      return { outcome: "ATTEMPT_NOT_RECONCILED", job: { ...job } };
    }
    if (attempt.status !== "completed") {
      return { outcome: "ATTEMPT_NOT_COMPLETED", job: { ...job } };
    }

    const callsForAttempt = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === attempt.id
    );
    const openCalls = callsForAttempt.filter(
      (ec) => ec.status === "reserved" || ec.status === "in_progress"
    );
    if (openCalls.length > 0) {
      return { outcome: "EXTERNAL_CALLS_NOT_TERMINAL", job: { ...job } };
    }

    const perplexityCall = callsForAttempt.find(
      (ec) => ec.callKind === "perplexity" && ec.generation === 1
    );
    const perplexityHasReceipt =
      !!perplexityCall &&
      [...store.providerCallReceipts.values()].some((r) => r.externalCallId === perplexityCall.id);
    if (!perplexityCall || perplexityCall.status !== "completed" || !perplexityHasReceipt) {
      return { outcome: "PERPLEXITY_NOT_COMPLETED", job: { ...job } };
    }

    const analysisCalls = callsForAttempt.filter((ec) => ec.callKind === "analysis");
    const maxGeneration = analysisCalls.reduce((max, ec) => Math.max(max, ec.generation), 0);
    const authoritativeAnalysis = analysisCalls.find((ec) => ec.generation === maxGeneration);
    const analysisHasReceipt =
      !!authoritativeAnalysis &&
      [...store.analysisCallReceipts.values()].some(
        (r) => r.externalCallId === authoritativeAnalysis.id
      );
    if (!authoritativeAnalysis || authoritativeAnalysis.status !== "completed" || !analysisHasReceipt) {
      return { outcome: "ANALYSIS_NOT_COMPLETED", job: { ...job } };
    }

    // D-025: every D-020 gate above is satisfied for the current slot.
    // Whether that is enough to succeed the job now depends on whether
    // every planned baseline slot has been consumed by a completed root
    // attempt — never on the raw count of protocol_attempts rows, which
    // would double-count retry children. attempt.baselineOrdinal is
    // guaranteed non-null here since attempt.jobId === job.id.
    const protocol = store.protocols.get(job.protocolId);
    if (protocol && attempt.baselineOrdinal !== null && attempt.baselineOrdinal < protocol.plannedBaselineRuns) {
      const advanced: ProtocolExecutionJob = {
        ...job,
        currentAttemptId: null,
        nextBaselineOrdinal: job.nextBaselineOrdinal + 1,
        updatedAt: nowIso(),
      };
      store.protocolExecutionJobs.set(advanced.id, advanced);
      return { outcome: "NEXT_BASELINE_REQUIRED", job: { ...advanced } };
    }

    const succeeded: ProtocolExecutionJob = {
      ...job,
      status: "succeeded",
      updatedAt: nowIso(),
    };
    store.protocolExecutionJobs.set(succeeded.id, succeeded);
    return { outcome: "SUCCEEDED", job: { ...succeeded } };
  },

  async failJobWithoutAttemptForJob(
    input: FailJobWithoutAttemptForJobInput
  ): Promise<FailJobWithoutAttemptForJobResult> {
    const store = getStore();
    // The reason decides the destination, and the destination is the only
    // thing that decides which write happens. Narrowed here so the review
    // branch can only ever carry a reason the alert ledger accepts.
    const reviewReason =
      input.reason === "throttled_retries_exhausted" || input.reason === "slot_budget_exhausted"
        ? input.reason
        : null;
    const target = reviewReason === null ? ("failed" as const) : ("needs_review" as const);

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }

    // Idempotence outranks fencing for a transition already on record.
    if (
      job.status === target &&
      (job.failureReason ?? job.needsReviewReason) === input.reason
    ) {
      return {
        outcome: job.currentAttemptId === null ? "ALREADY_CLOSED" : "STATE_CONFLICT",
        job: { ...job },
      };
    }
    if (
      job.status === "failed" || job.status === "needs_review" ||
      job.status === "succeeded" || job.status === "abandoned_exhausted"
    ) {
      return { outcome: "STATE_CONFLICT", job: { ...job } };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", job: { ...job } };
    }

    const openAttempts = [...store.protocolAttempts.values()].filter(
      (a) => a.jobId === job.id && a.projectId === input.projectId && a.terminalizedAt === null
    ).length;
    if (openAttempts > 0 || job.currentAttemptId !== null) {
      return { outcome: "ATTEMPT_STILL_OPEN", job: { ...job } };
    }

    if (target === "failed" || reviewReason === null) {
      const closed = { ...job, status: "failed" as const, failureReason: input.reason, updatedAt: nowIso() };
      store.protocolExecutionJobs.set(closed.id, closed);
      return { outcome: "CLOSED", job: { ...closed } };
    }
    moveJobToNeedsReview(store, job, reviewReason, null, null);
    return { outcome: "CLOSED", job: { ...store.protocolExecutionJobs.get(job.id)! } };
  },

  async abortAttemptAndFailJobForJob(
    input: AbortAttemptAndFailJobForJobInput
  ): Promise<AbortAttemptAndFailJobForJobResult> {
    const store = getStore();
    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", attempt: null, job: null };
    }
    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== input.projectId) {
      return { outcome: "ATTEMPT_NOT_OWNED_BY_JOB", attempt: null, job: { ...job } };
    }

    const callsOf = (statuses: readonly string[]) =>
      [...store.protocolExternalCalls.values()].filter(
        (c) =>
          c.protocolAttemptId === input.attemptId &&
          c.projectId === input.projectId &&
          statuses.includes(c.status)
      );

    // Full idempotence, before fencing: the WHOLE transition must be on
    // record. Anything partial is surfaced, never silently completed.
    if (job.status === "failed" || attempt.terminalizedAt !== null) {
      const whole =
        job.status === "failed" &&
        job.failureReason === input.failureReason &&
        attempt.terminalizedAt !== null &&
        attempt.status === input.attemptStatus &&
        (attempt.terminationReason ?? null) === (input.terminationReason ?? null) &&
        callsOf(["reserved", "in_progress"]).length === 0;
      return {
        outcome: whole ? "ALREADY_ABORTED" : "STATE_CONFLICT",
        attempt: { ...attempt },
        job: { ...job },
      };
    }

    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", attempt: { ...attempt }, job: { ...job } };
    }

    // A sent call must receive its receipt first: cancelling it would
    // erase the frontier that stops a replay from paying twice.
    if (callsOf(["in_progress"]).length > 0) {
      return { outcome: "CALL_STILL_IN_PROGRESS", attempt: { ...attempt }, job: { ...job } };
    }

    for (const call of callsOf(["reserved"])) {
      store.protocolExternalCalls.set(call.id, {
        ...call,
        status: "cancelled",
        terminalizedAt: nowIso(),
      });
    }
    const terminal = {
      ...attempt,
      status: input.attemptStatus,
      terminationReason: input.terminationReason,
      terminalizedAt: nowIso(),
      lastActivityAt: nowIso(),
    };
    store.protocolAttempts.set(terminal.id, terminal);
    const closed = {
      ...job,
      status: "failed" as const,
      failureReason: input.failureReason,
      currentAttemptId: null,
      updatedAt: nowIso(),
    };
    store.protocolExecutionJobs.set(closed.id, closed);
    return { outcome: "ABORTED", attempt: { ...terminal }, job: { ...closed } };
  },

  async closeAttemptForParseFailureForJob(
    input: CloseAttemptForParseFailureForJobInput
  ): Promise<CloseAttemptForParseFailureForJobResult> {
    const store = getStore();
    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", attempt: null, job: null };
    }
    const attempt = store.protocolAttempts.get(input.attemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== input.projectId) {
      return { outcome: "ATTEMPT_NOT_OWNED_BY_JOB", attempt: null, job: { ...job } };
    }
    const call = store.protocolExternalCalls.get(input.externalCallId);
    if (!call || call.projectId !== input.projectId || call.protocolAttemptId !== input.attemptId) {
      return { outcome: "CALL_NOT_OWNED_BY_JOB", attempt: { ...attempt }, job: { ...job } };
    }
    // The durable mark is the precondition, never a side effect.
    if (call.parseFailedAt === null || call.parseFailureCode === null) {
      return { outcome: "PARSE_NOT_MARKED", attempt: { ...attempt }, job: { ...job } };
    }

    const callsOf = (statuses: readonly string[]) =>
      [...store.protocolExternalCalls.values()].filter(
        (c) =>
          c.protocolAttemptId === input.attemptId &&
          c.projectId === input.projectId &&
          statuses.includes(c.status)
      );

    if (job.status === "needs_review" || attempt.terminalizedAt !== null) {
      const whole =
        job.status === "needs_review" &&
        job.needsReviewReason === "analysis_parse_failed" &&
        attempt.terminalizedAt !== null &&
        attempt.status === "failed" &&
        attempt.terminationReason === call.parseFailureCode &&
        job.currentAttemptId === null &&
        callsOf(["reserved", "in_progress"]).length === 0;
      return {
        outcome: whole ? "ALREADY_CLOSED" : "STATE_CONFLICT",
        attempt: { ...attempt },
        job: { ...job },
      };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", attempt: { ...attempt }, job: { ...job } };
    }
    if (callsOf(["in_progress"]).length > 0) {
      return { outcome: "CALL_STILL_IN_PROGRESS", attempt: { ...attempt }, job: { ...job } };
    }

    for (const c of callsOf(["reserved"])) {
      store.protocolExternalCalls.set(c.id, { ...c, status: "cancelled", terminalizedAt: nowIso() });
    }
    const terminal = {
      ...attempt,
      status: "failed" as const,
      terminationReason: call.parseFailureCode,
      terminalizedAt: nowIso(),
      lastActivityAt: nowIso(),
    };
    store.protocolAttempts.set(terminal.id, terminal);
    const cleared = { ...job, currentAttemptId: null };
    store.protocolExecutionJobs.set(cleared.id, cleared);
    moveJobToNeedsReview(store, cleared, "analysis_parse_failed", input.attemptId, input.externalCallId);
    return {
      outcome: "CLOSED",
      attempt: { ...terminal },
      job: { ...store.protocolExecutionJobs.get(job.id)! },
    };
  },

  async failProtocolExecutionJob(
    input: FailProtocolExecutionJobInput
  ): Promise<FailProtocolExecutionJobResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", job: { ...job } };
    }

    const failed: ProtocolExecutionJob = {
      ...job,
      status: "failed",
      failureReason: input.reason,
      updatedAt: nowIso(),
    };
    store.protocolExecutionJobs.set(failed.id, failed);
    return { outcome: "FAILED", job: { ...failed } };
  },

  async reactivateAbandonedJob(
    input: ReactivateAbandonedJobInput
  ): Promise<ReactivateAbandonedJobResult> {
    const store = getStore();
    if (
      !input.actor.trim() ||
      !input.reason.trim() ||
      !input.idempotencyKey.trim()
    ) {
      throw new Error("invalid_reactivate_abandoned_job_args");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }

    // D-024: fingerprint computed under the job's own lock (mirrored here
    // simply by having already fetched `job` above, single-threaded), then
    // the existing-action lookup runs BEFORE the abandoned_exhausted status
    // gate -- exactly the D-022 ordering discipline, so a replay of an
    // already-decided key is honored regardless of the job's status now.
    const fingerprint = reactivateAbandonedJobFingerprint({
      jobId: input.jobId,
      projectId: input.projectId,
    });
    const existingAction = [...store.protocolOperatorActions.values()].find(
      (a) =>
        a.projectId === input.projectId &&
        a.jobId === input.jobId &&
        a.idempotencyKey === input.idempotencyKey
    );
    if (existingAction) {
      if (existingAction.requestFingerprint === fingerprint) {
        return {
          outcome:
            existingAction.outcome === "approved"
              ? "REACTIVATED"
              : (existingAction.denialCode as ReactivateAbandonedJobOutcome),
          job: { ...job },
        };
      }
      return { outcome: "IDEMPOTENCY_KEY_CONFLICT", job: null };
    }

    if (job.status !== "abandoned_exhausted") {
      const now = nowIso();
      const deniedAction: ProtocolOperatorAction = {
        id: randomUUID(),
        projectId: input.projectId,
        jobId: input.jobId,
        actor: input.actor,
        reason: input.reason,
        action: "reactivate_abandoned_job",
        outcome: "denied",
        denialCode: "JOB_NOT_ABANDONED",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        newAttemptId: null,
        newExternalCallId: null,
        createdAt: now,
      };
      store.protocolOperatorActions.set(deniedAction.id, deniedAction);
      return { outcome: "JOB_NOT_ABANDONED", job: { ...job } };
    }

    const now = nowIso();
    const reactivated: ProtocolExecutionJob = {
      ...job,
      status: "queued",
      attemptCount: 0,
      workerId: null,
      claimToken: null,
      leaseExpiresAt: null,
      failureReason: null,
      updatedAt: now,
    };
    store.protocolExecutionJobs.set(reactivated.id, reactivated);

    const approvedAction: ProtocolOperatorAction = {
      id: randomUUID(),
      projectId: input.projectId,
      jobId: input.jobId,
      actor: input.actor,
      reason: input.reason,
      action: "reactivate_abandoned_job",
      outcome: "approved",
      denialCode: null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      newAttemptId: null,
      newExternalCallId: null,
      createdAt: now,
    };
    store.protocolOperatorActions.set(approvedAction.id, approvedAction);

    return { outcome: "REACTIVATED", job: { ...reactivated } };
  },

  async retryFullAttemptForJob(
    input: RetryFullAttemptForJobInput
  ): Promise<RetryFullAttemptForJobResult> {
    const store = getStore();
    if (input.perplexityReservedCostUsd < 0 || input.analysisReservedCostUsd < 0) {
      throw new Error("invalid_retry_full_attempt_for_job_args");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", attempt: null, perplexityCall: null, analysisCall: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", attempt: null, perplexityCall: null, analysisCall: null };
    }

    // D-022: existing-child lookup (retry_of_attempt_id, never changes)
    // BEFORE the current_attempt_id equality gate.
    const existingChild = [...store.protocolAttempts.values()].find(
      (a) => a.retryOfAttemptId === input.sourceAttemptId && a.jobId === job.id && a.projectId === job.projectId
    );
    if (existingChild) {
      const calls = [...store.protocolExternalCalls.values()].filter(
        (ec) => ec.protocolAttemptId === existingChild.id
      );
      const perplexityCall = calls.find((ec) => ec.callKind === "perplexity") ?? null;
      const analysisCall = calls.find((ec) => ec.callKind === "analysis") ?? null;
      if (existingChild.reservedCostUsd === input.perplexityReservedCostUsd + input.analysisReservedCostUsd) {
        return {
          outcome: "ALREADY_RETRIED",
          attempt: { ...existingChild },
          perplexityCall: perplexityCall ? { ...perplexityCall } : null,
          analysisCall: analysisCall ? { ...analysisCall } : null,
        };
      }
      return {
        outcome: "SOURCE_ALREADY_RETRIED",
        attempt: { ...existingChild },
        perplexityCall: null,
        analysisCall: null,
      };
    }

    if (job.currentAttemptId !== input.sourceAttemptId) {
      return { outcome: "SOURCE_NOT_CURRENT_ATTEMPT", attempt: null, perplexityCall: null, analysisCall: null };
    }

    const source = store.protocolAttempts.get(input.sourceAttemptId);
    if (!source || source.jobId !== job.id || source.projectId !== job.projectId) {
      return { outcome: "SOURCE_ATTEMPT_NOT_OWNED_BY_JOB", attempt: null, perplexityCall: null, analysisCall: null };
    }
    if (source.terminalizedAt === null || !["failed", "timed_out", "cancelled"].includes(source.status)) {
      return { outcome: "SOURCE_NOT_ELIGIBLE", attempt: { ...source }, perplexityCall: null, analysisCall: null };
    }

    const sourceCalls = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === source.id
    );
    const ambiguous = sourceCalls.some(
      (ec) =>
        ec.status === "in_progress" &&
        ec.requestSentAt !== null &&
        ![...store.providerCallReceipts.values()].some((r) => r.externalCallId === ec.id) &&
        ![...store.analysisCallReceipts.values()].some((r) => r.externalCallId === ec.id)
    );
    if (ambiguous) {
      return { outcome: "AMBIGUOUS_CALL_PRESENT", attempt: { ...source }, perplexityCall: null, analysisCall: null };
    }

    const perplexity = sourceCalls.find((ec) => ec.callKind === "perplexity" && ec.generation === 1);
    const perplexityHasReceipt =
      !!perplexity &&
      [...store.providerCallReceipts.values()].some((r) => r.externalCallId === perplexity.id);
    if (
      !perplexity ||
      !["failed", "timed_out", "cancelled"].includes(perplexity.status) ||
      !perplexityHasReceipt
    ) {
      return {
        outcome: "PERPLEXITY_NOT_ELIGIBLE_FOR_FULL_RETRY",
        attempt: { ...source },
        perplexityCall: null,
        analysisCall: null,
      };
    }

    // D-025: a full retry always keeps its source's baseline slot,
    // supplied in the SAME reservation as job_id -- never a new ordinal,
    // and next_baseline_ordinal is never touched by a retry.
    const core = admitAndReserveAttemptCore(store, {
      protocolId: job.protocolId,
      projectId: input.projectId,
      attemptKind: source.attemptKind,
      idempotencyKey: `retry-of-attempt:${input.sourceAttemptId}`,
      totalReservedCostUsd: input.perplexityReservedCostUsd + input.analysisReservedCostUsd,
      retryOfAttemptId: input.sourceAttemptId,
      jobId: job.id,
      baselineOrdinal: source.baselineOrdinal,
    });
    if (core.status !== "RESERVED" || !core.attempt) {
      return { outcome: core.status, attempt: core.attempt, perplexityCall: null, analysisCall: null };
    }

    const { perplexityCall, analysisCall } = createAttemptExternalCallsCore(
      store,
      core.attempt.id,
      input.projectId,
      input.perplexityReservedCostUsd,
      input.analysisReservedCostUsd
    );

    store.protocolExecutionJobs.set(job.id, {
      ...job,
      currentAttemptId: core.attempt.id,
      updatedAt: nowIso(),
    });

    return { outcome: "RESERVED", attempt: core.attempt, perplexityCall, analysisCall };
  },

  async retryAnalysisGenerationForJob(
    input: RetryAnalysisGenerationForJobInput
  ): Promise<RetryAnalysisGenerationForJobResult> {
    const store = getStore();
    if (input.reservedCostUsd < 0) throw new Error("invalid_retry_analysis_generation_for_job_args");

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", externalCall: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", externalCall: null };
    }
    if (job.currentAttemptId === null) {
      return { outcome: "NO_CURRENT_ATTEMPT", externalCall: null };
    }

    const source = store.protocolExternalCalls.get(input.sourceExternalCallId);
    if (
      !source ||
      source.projectId !== input.projectId ||
      source.protocolAttemptId !== job.currentAttemptId ||
      source.callKind !== "analysis"
    ) {
      return { outcome: "SOURCE_NOT_CURRENT_ATTEMPT", externalCall: null };
    }

    const attempt = store.protocolAttempts.get(job.currentAttemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== job.projectId) {
      return { outcome: "CURRENT_ATTEMPT_NOT_FOUND", externalCall: null };
    }

    // D-023 §1 arbitration: existing-child lookup BEFORE the authoritative-
    // generation check — never reordered.
    const existingChild = [...store.protocolExternalCalls.values()].find(
      (ec) =>
        ec.retryOfExternalCallId === input.sourceExternalCallId &&
        ec.protocolAttemptId === attempt.id &&
        ec.projectId === input.projectId
    );
    if (existingChild) {
      if (existingChild.reservedCostUsd === input.reservedCostUsd) {
        return { outcome: "ALREADY_RETRIED", externalCall: { ...existingChild } };
      }
      return { outcome: "SOURCE_ALREADY_RETRIED", externalCall: { ...existingChild } };
    }

    const perplexity = [...store.protocolExternalCalls.values()].find(
      (ec) => ec.protocolAttemptId === attempt.id && ec.callKind === "perplexity" && ec.generation === 1
    );
    const perplexityHasReceipt =
      !!perplexity &&
      [...store.providerCallReceipts.values()].some((r) => r.externalCallId === perplexity.id);
    if (!perplexity || perplexity.status !== "completed" || !perplexityHasReceipt) {
      return { outcome: "PERPLEXITY_NOT_COMPLETED", externalCall: null };
    }

    const analysisCallsForAttempt = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === attempt.id && ec.callKind === "analysis"
    );
    const maxGeneration = analysisCallsForAttempt.reduce((max, ec) => Math.max(max, ec.generation), 0);
    if (source.generation !== maxGeneration) {
      return { outcome: "SOURCE_NOT_AUTHORITATIVE_GENERATION", externalCall: null };
    }

    // D-027: eligibility now has two independent branches. The historical
    // branch (failed/timed_out/cancelled with a receipt) is unchanged.
    // The new branch accepts a completed, parse-failed source only when
    // its own probe_run_id is coherent with the attempt's, its receipt
    // is a real, same-project, same-probe_run success, and no
    // probe_result exists yet.
    if (["failed", "timed_out", "cancelled"].includes(source.status)) {
      const sourceHasReceipt = [...store.analysisCallReceipts.values()].some(
        (r) => r.externalCallId === source.id
      );
      if (!sourceHasReceipt) {
        return { outcome: "SOURCE_NOT_ELIGIBLE", externalCall: null };
      }
    } else if (
      source.status === "completed" &&
      source.parseFailedAt !== null &&
      source.parseFailureCode !== null
    ) {
      const successReceipt = [...store.analysisCallReceipts.values()].find(
        (r) =>
          r.externalCallId === source.id &&
          r.outcome === "success" &&
          r.projectId === input.projectId &&
          r.probeRunId === attempt.probeRunId
      );
      if (
        attempt.probeRunId === null ||
        source.probeRunId === null ||
        source.probeRunId !== attempt.probeRunId ||
        !successReceipt
      ) {
        return { outcome: "SOURCE_NOT_ELIGIBLE", externalCall: null };
      }
      const probeResultExists =
        attempt.probeRunId !== null &&
        (store.probeResultsByProject.get(input.projectId) ?? []).some(
          (pr) => pr.probeRunId === attempt.probeRunId
        );
      if (probeResultExists) {
        return { outcome: "PROBE_RESULT_ALREADY_EXISTS", externalCall: null };
      }
    } else {
      return { outcome: "SOURCE_NOT_ELIGIBLE", externalCall: null };
    }

    const ambiguous = [...store.protocolExternalCalls.values()].some(
      (ec) =>
        ec.protocolAttemptId === attempt.id &&
        ec.status === "in_progress" &&
        ec.requestSentAt !== null &&
        ![...store.providerCallReceipts.values()].some((r) => r.externalCallId === ec.id) &&
        ![...store.analysisCallReceipts.values()].some((r) => r.externalCallId === ec.id)
    );
    if (ambiguous) {
      return { outcome: "AMBIGUOUS_CALL_PRESENT", externalCall: null };
    }

    const core = reserveAdditionalAnalysisGenerationCore(
      store,
      attempt.id,
      input.projectId,
      input.reservedCostUsd,
      input.sourceExternalCallId
    );
    return { outcome: core.status, externalCall: core.externalCall };
  },

  // D-027: mirrors mark_analysis_parse_failed_for_job (0053) exactly,
  // same eleven branches in the same order. Never a job-status change,
  // never a repair policy -- only records durable state.
  async markAnalysisParseFailedForJob(
    input: MarkAnalysisParseFailedForJobInput
  ): Promise<MarkAnalysisParseFailedForJobResult> {
    const store = getStore();
    if (
      !input.parseFailureCode ||
      !["invalid_json", "schema_validation_failed", "normalization_failed"].includes(input.parseFailureCode)
    ) {
      throw new Error("invalid_mark_analysis_parse_failed_for_job_args");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", externalCall: null };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", externalCall: null };
    }

    const call = store.protocolExternalCalls.get(input.externalCallId);
    if (!call || call.projectId !== input.projectId || call.protocolAttemptId !== job.currentAttemptId) {
      return { outcome: "NOT_CURRENT_ATTEMPT", externalCall: null };
    }

    if (call.callKind !== "analysis") {
      return { outcome: "WRONG_CALL_KIND", externalCall: { ...call } };
    }

    if (call.parseFailedAt !== null) {
      if (call.parseFailureCode === input.parseFailureCode) {
        return { outcome: "ALREADY_MARKED", externalCall: { ...call } };
      }
      return { outcome: "PARSE_FAILURE_CODE_CONFLICT", externalCall: { ...call } };
    }

    const attempt = job.currentAttemptId ? store.protocolAttempts.get(job.currentAttemptId) : undefined;
    if (!attempt || attempt.jobId !== job.id || attempt.projectId !== input.projectId) {
      return { outcome: "CURRENT_ATTEMPT_NOT_FOUND", externalCall: { ...call } };
    }

    // Probe_result existence derived via protocol_attempts.probeRunId,
    // project-scoped -- the same convention getProtocolExecutionJobContext
    // already uses, never protocolExternalCalls.probeRunId directly.
    if (
      attempt.probeRunId !== null &&
      (store.probeResultsByProject.get(input.projectId) ?? []).some(
        (pr) => pr.probeRunId === attempt.probeRunId
      )
    ) {
      return { outcome: "PROBE_RESULT_ALREADY_EXISTS", externalCall: { ...call } };
    }

    const analysisCallsForAttempt = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === call.protocolAttemptId && ec.callKind === "analysis"
    );
    const maxGeneration = analysisCallsForAttempt.reduce((max, ec) => Math.max(max, ec.generation), 0);
    if (call.generation !== maxGeneration) {
      return { outcome: "SOURCE_NOT_AUTHORITATIVE_GENERATION", externalCall: { ...call } };
    }

    const successReceipt = [...store.analysisCallReceipts.values()].find(
      (r) =>
        r.externalCallId === call.id &&
        r.outcome === "success" &&
        r.projectId === input.projectId &&
        r.probeRunId === attempt.probeRunId
    );
    if (
      call.status !== "completed" ||
      attempt.probeRunId === null ||
      call.probeRunId === null ||
      call.probeRunId !== attempt.probeRunId ||
      !successReceipt
    ) {
      return { outcome: "NOT_ELIGIBLE", externalCall: { ...call } };
    }

    const updatedCall: ProtocolExternalCall = {
      ...call,
      parseFailedAt: nowIso(),
      parseFailureCode: input.parseFailureCode,
    };
    store.protocolExternalCalls.set(updatedCall.id, updatedCall);

    return { outcome: "MARKED", externalCall: { ...updatedCall } };
  },

  async authorizeOperatorRetry(
    input: AuthorizeOperatorRetryInput
  ): Promise<AuthorizeOperatorRetryResult> {
    const store = getStore();
    if (!input.actor.trim() || !input.reason.trim() || !input.idempotencyKey.trim()) {
      throw new Error("invalid_authorize_operator_retry_args");
    }
    if (input.action !== "retry_full_attempt" && input.action !== "retry_analysis_only") {
      throw new Error("invalid_operator_retry_action");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return {
        status: "JOB_NOT_FOUND",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }

    // D-022: idempotent-replay lookup BEFORE the needs_review gate, honored
    // regardless of the job's current status.
    const fingerprint = operatorRetryFingerprint({
      jobId: input.jobId,
      projectId: input.projectId,
      action: input.action,
      sourceAttemptId: input.sourceAttemptId,
      sourceExternalCallId: input.sourceExternalCallId ?? null,
      reservedCostUsd: input.reservedCostUsd,
      perplexityReservedCostUsd: input.perplexityReservedCostUsd ?? null,
    });
    const existingAction = [...store.protocolOperatorActions.values()].find(
      (a) => a.projectId === input.projectId && a.jobId === input.jobId && a.idempotencyKey === input.idempotencyKey
    );
    if (existingAction) {
      if (existingAction.requestFingerprint === fingerprint) {
        return {
          status: existingAction.outcome === "approved" ? "APPROVED" : "DENIED",
          outcome: existingAction.outcome,
          denialCode: existingAction.denialCode,
          newAttempt: existingAction.newAttemptId
            ? { ...(store.protocolAttempts.get(existingAction.newAttemptId) ?? null) } as ProtocolAttempt | null
            : null,
          newExternalCall: existingAction.newExternalCallId
            ? ({ ...(store.protocolExternalCalls.get(existingAction.newExternalCallId) ?? null) } as ProtocolExternalCall | null)
            : null,
        };
      }
      return {
        status: "IDEMPOTENCY_KEY_CONFLICT",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }

    if (job.status !== "needs_review") {
      return {
        status: "JOB_NOT_IN_NEEDS_REVIEW",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }

    const source = store.protocolAttempts.get(input.sourceAttemptId);
    if (!source || source.projectId !== input.projectId || source.jobId !== job.id) {
      return {
        status: "SOURCE_ATTEMPT_NOT_OWNED_BY_JOB",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }

    const recordAction = (
      outcome: "approved" | "denied",
      denialCode: string | null,
      newAttemptId: string | null,
      newExternalCallId: string | null
    ): void => {
      const action: ProtocolOperatorAction = {
        id: randomUUID(),
        projectId: input.projectId,
        jobId: input.jobId,
        actor: input.actor,
        reason: input.reason,
        action: input.action,
        outcome,
        denialCode,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        newAttemptId,
        newExternalCallId,
        createdAt: nowIso(),
      };
      store.protocolOperatorActions.set(action.id, action);
    };

    if (input.action === "retry_full_attempt") {
      // D-025: an operator-approved full retry also keeps its source's
      // baseline slot, supplied in the SAME reservation as job_id --
      // identical rationale to retryFullAttemptForJob.
      const core = admitAndReserveAttemptCore(store, {
        protocolId: job.protocolId,
        projectId: input.projectId,
        attemptKind: source.attemptKind,
        idempotencyKey: `operator-retry:${input.idempotencyKey}`,
        totalReservedCostUsd: (input.perplexityReservedCostUsd ?? 0) + input.reservedCostUsd,
        retryOfAttemptId: input.sourceAttemptId,
        jobId: job.id,
        baselineOrdinal: source.baselineOrdinal,
      });
      if (core.status !== "RESERVED" || !core.attempt) {
        recordAction("denied", core.status, null, null);
        return {
          status: "DENIED",
          outcome: "denied",
          denialCode: core.status,
          newAttempt: null,
          newExternalCall: null,
        };
      }
      const { perplexityCall } = createAttemptExternalCallsCore(
        store,
        core.attempt.id,
        input.projectId,
        input.perplexityReservedCostUsd ?? 0,
        input.reservedCostUsd
      );
      recordAction("approved", null, core.attempt.id, perplexityCall.id);
      store.protocolExecutionJobs.set(job.id, {
        ...job,
        status: "queued",
        needsReviewReason: null,
        currentAttemptId: core.attempt.id,
        updatedAt: nowIso(),
      });
      return {
        status: "APPROVED",
        outcome: "approved",
        denialCode: null,
        newAttempt: core.attempt,
        newExternalCall: perplexityCall,
      };
    }

    // retry_analysis_only
    if (source.status !== "in_progress") {
      return {
        status: "SOURCE_ATTEMPT_NOT_IN_PROGRESS",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }
    const sourceExternalCallId = input.sourceExternalCallId ?? null;
    const sourceCall = sourceExternalCallId
      ? store.protocolExternalCalls.get(sourceExternalCallId)
      : undefined;
    if (
      !sourceCall ||
      sourceCall.protocolAttemptId !== input.sourceAttemptId ||
      sourceCall.projectId !== input.projectId ||
      sourceCall.callKind !== "analysis"
    ) {
      return {
        status: "SOURCE_EXTERNAL_CALL_NOT_OWNED_BY_ATTEMPT",
        outcome: null,
        denialCode: null,
        newAttempt: null,
        newExternalCall: null,
      };
    }

    const reserve = reserveAdditionalAnalysisGenerationCore(
      store,
      input.sourceAttemptId,
      input.projectId,
      input.reservedCostUsd,
      sourceExternalCallId
    );
    if (reserve.status !== "RESERVED" || !reserve.externalCall) {
      recordAction("denied", reserve.status, null, null);
      return {
        status: "DENIED",
        outcome: "denied",
        denialCode: reserve.status,
        newAttempt: null,
        newExternalCall: null,
      };
    }
    recordAction("approved", null, input.sourceAttemptId, reserve.externalCall.id);
    store.protocolExecutionJobs.set(job.id, {
      ...job,
      status: "queued",
      needsReviewReason: null,
      updatedAt: nowIso(),
    });
    return {
      status: "APPROVED",
      outcome: "approved",
      denialCode: null,
      newAttempt: { ...source },
      newExternalCall: reserve.externalCall,
    };
  },

  async getProtocolExecutionJobContext(
    input: GetProtocolExecutionJobContextInput
  ): Promise<GetProtocolExecutionJobContextResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return {
        outcome: "JOB_NOT_FOUND",
        job: null,
        protocol: null,
        currentAttempt: null,
        externalCalls: [],
        providerReceipts: [],
        analysisReceipts: [],
        probeRun: null,
        completedBaselineSlots: null,
        probeResult: null,
      };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return {
        outcome: "JOB_NOT_OWNED",
        job: { ...job },
        protocol: null,
        currentAttempt: null,
        externalCalls: [],
        providerReceipts: [],
        analysisReceipts: [],
        probeRun: null,
        completedBaselineSlots: null,
        probeResult: null,
      };
    }

    const protocol = store.protocols.get(job.protocolId) ?? null;
    const currentAttempt = job.currentAttemptId
      ? store.protocolAttempts.get(job.currentAttemptId) ?? null
      : null;
    const externalCalls = currentAttempt
      ? [...store.protocolExternalCalls.values()].filter(
          (ec) => ec.protocolAttemptId === currentAttempt.id
        )
      : [];
    const externalCallIds = new Set(externalCalls.map((ec) => ec.id));
    const providerReceipts = [...store.providerCallReceipts.values()].filter((r) =>
      externalCallIds.has(r.externalCallId)
    );
    const analysisReceipts = [...store.analysisCallReceipts.values()].filter((r) =>
      externalCallIds.has(r.externalCallId)
    );
    const probeRun =
      currentAttempt && currentAttempt.probeRunId
        ? store.probeRuns.get(currentAttempt.probeRunId) ?? null
        : null;

    // D-026 — the current attempt's probe_results row, if one has
    // already been saved for its probe_run_id. Real database parity:
    // saveProbeResult (below) throws on a second row for the same
    // probeRunId, mirroring probe_results_probe_run_id_key (0052), so
    // at most one row can ever match here.
    const probeResult =
      currentAttempt && currentAttempt.probeRunId
        ? (store.probeResultsByProject.get(job.projectId) ?? []).find(
            (r) => r.probeRunId === currentAttempt.probeRunId
          ) ?? null
        : null;

    // D-025: distinct completed baseline slots for this job, counted by
    // DISTINCT baselineOrdinal among completed attempts — not by row
    // count, and not restricted to root attempts. A slot's completion may
    // be reached by its root attempt OR by a retry child that inherited
    // its ordinal (retryFullAttemptForJob/authorizeOperatorRetry always
    // copy the source's baselineOrdinal verbatim) — restricting to
    // root-only would silently undercount every slot recovered by a
    // retry. job.nextBaselineOrdinal and protocol.plannedBaselineRuns are
    // already carried by the rows above.
    const completedOrdinals = new Set(
      [...store.protocolAttempts.values()]
        .filter((a) => a.jobId === job.id && a.baselineOrdinal !== null && a.status === "completed")
        .map((a) => a.baselineOrdinal)
    );
    const completedBaselineSlots = completedOrdinals.size;

    return {
      outcome: "OK",
      job: { ...job },
      protocol: protocol ? { ...protocol } : null,
      currentAttempt: currentAttempt ? { ...currentAttempt } : null,
      externalCalls: externalCalls.map((ec) => ({ ...ec })),
      providerReceipts: providerReceipts.map((r) => ({ ...r })),
      analysisReceipts: analysisReceipts.map((r) => ({ ...r })),
      probeRun: probeRun ? { ...probeRun } : null,
      completedBaselineSlots,
      probeResult: probeResult ? { ...probeResult } : null,
    };
  },

  async markProtocolExecutionJobNeedsReviewForAmbiguity(
    input: MarkProtocolExecutionJobNeedsReviewForAmbiguityInput
  ): Promise<MarkProtocolExecutionJobNeedsReviewForAmbiguityResult> {
    const store = getStore();

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return { outcome: "JOB_NOT_FOUND", job: null };
    }
    // Checked before fencing, mirroring D-020's ALREADY_SUCCEEDED precedent
    // — a needs_review job has no live owner left to validate.
    if (job.status === "needs_review") {
      return { outcome: "ALREADY_NEEDS_REVIEW", job: { ...job } };
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return { outcome: "JOB_NOT_OWNED", job: { ...job } };
    }
    if (job.currentAttemptId === null) {
      return { outcome: "NO_AMBIGUOUS_CALL", job: { ...job } };
    }

    const ambiguousCount = [...store.protocolExternalCalls.values()].filter(
      (ec) =>
        ec.protocolAttemptId === job.currentAttemptId &&
        ec.status === "in_progress" &&
        ec.requestSentAt !== null &&
        ![...store.providerCallReceipts.values()].some((r) => r.externalCallId === ec.id) &&
        ![...store.analysisCallReceipts.values()].some((r) => r.externalCallId === ec.id)
    ).length;

    if (ambiguousCount === 0) {
      return { outcome: "NO_AMBIGUOUS_CALL", job: { ...job } };
    }

    const updated: ProtocolExecutionJob = {
      ...job,
      status: "needs_review",
      needsReviewReason: "ambiguous_external_call_sent_without_receipt",
      updatedAt: nowIso(),
    };
    store.protocolExecutionJobs.set(updated.id, updated);
    recordAlertEvent(store, {
      projectId: updated.projectId,
      jobId: updated.id,
      eventType: "needs_review",
      reasonCode: "ambiguous_external_call_sent_without_receipt",
      sourceAttemptId: updated.currentAttemptId,
      sourceExternalCallId: null,
    });
    return { outcome: "NEEDS_REVIEW", job: { ...updated } };
  },

  async persistProbeResultForJob(
    input: PersistProbeResultForJobInput
  ): Promise<PersistProbeResultForJobResult> {
    const store = getStore();

    // DEFECT_04: real runtime validation, mirroring persist_probe_
    // result_for_job's own SQL-side checks byte-for-byte in spirit --
    // never trusting TypeScript's compile-time shape alone. A caller can
    // bypass the compile-time type entirely (e.g. `content as unknown as
    // PersistProbeResultForJobContent`), exactly as a real jsonb payload
    // sent to the RPC could carry anything; MemoryAdapter must be able
    // to actually reach INVALID_CONTENT_KEYS/_TYPE/_VALUE, not just
    // INVALID_CONTENT_INVARIANT, for adapter-contract parity with SQL.
    const invalid = (
      outcome: PersistProbeResultForJobOutcome
    ): PersistProbeResultForJobResult => ({ outcome, probeResultId: null, canonicalResultSha256: null });

    const raw: unknown = input.content;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return invalid("INVALID_CONTENT_KEYS");
    }
    const allowedKeys = [
      "productMentioned", "productPosition", "competitorsMentioned", "sourcesCited",
      "answerSummary", "citedAsSource", "clientSourceCount", "platformsReferenced",
      "negativeClaimDetected",
    ] as const;
    const rec = raw as Record<string, unknown>;
    const rawKeys = Object.keys(rec);
    if (
      rawKeys.length !== allowedKeys.length ||
      !allowedKeys.every((k) => rawKeys.includes(k))
    ) {
      return invalid("INVALID_CONTENT_KEYS");
    }
    if (allowedKeys.some((k) => rec[k] === null || rec[k] === undefined)) {
      return invalid("INVALID_CONTENT_KEYS");
    }
    if (
      typeof rec.productMentioned !== "boolean" ||
      typeof rec.productPosition !== "string" ||
      !Array.isArray(rec.competitorsMentioned) ||
      !Array.isArray(rec.sourcesCited) ||
      typeof rec.answerSummary !== "string" ||
      typeof rec.citedAsSource !== "boolean" ||
      typeof rec.clientSourceCount !== "number" ||
      !Array.isArray(rec.platformsReferenced) ||
      typeof rec.negativeClaimDetected !== "boolean"
    ) {
      return invalid("INVALID_CONTENT_TYPE");
    }

    const content = rec as unknown as PersistProbeResultForJobContent;

    if (!["primary", "listed", "negative", "absent"].includes(content.productPosition)) {
      return invalid("INVALID_CONTENT_VALUE");
    }
    if (content.answerSummary.length > 4000) {
      return invalid("INVALID_CONTENT_VALUE");
    }
    // DEFECT_01: integer-ness + int4 range checked BEFORE the value is
    // ever trusted as a safe integer -- mirrors the SQL fix exactly
    // (numeric-then-integer-check, never a bare, unguarded cast).
    if (
      !Number.isFinite(content.clientSourceCount) ||
      !Number.isInteger(content.clientSourceCount) ||
      content.clientSourceCount < 0 ||
      content.clientSourceCount > 2147483647
    ) {
      return invalid("INVALID_CONTENT_VALUE");
    }
    if (content.clientSourceCount > 50) {
      return invalid("INVALID_CONTENT_VALUE");
    }
    if (
      content.competitorsMentioned.length > 50 ||
      content.sourcesCited.length > 50 ||
      content.platformsReferenced.length > 20
    ) {
      return invalid("INVALID_CONTENT_VALUE");
    }
    for (const el of content.competitorsMentioned as unknown[]) {
      if (el === null || typeof el !== "object" || Array.isArray(el)) {
        return invalid("INVALID_CONTENT_VALUE");
      }
      const elRec = el as Record<string, unknown>;
      const elKeys = Object.keys(elRec);
      if (elKeys.length !== 3 || !["name", "position", "context"].every((k) => elKeys.includes(k))) {
        return invalid("INVALID_CONTENT_VALUE");
      }
      if (
        typeof elRec.name !== "string" ||
        typeof elRec.position !== "number" ||
        typeof elRec.context !== "string"
      ) {
        return invalid("INVALID_CONTENT_VALUE");
      }
      // DEFECT_03: integer-ness + range (1-500) checked before ever
      // trusting `position` -- a fractional value (e.g. 1.5) or one
      // outside range is rejected here, never silently accepted.
      if (
        !Number.isFinite(elRec.position) ||
        !Number.isInteger(elRec.position) ||
        elRec.position < 1 ||
        elRec.position > 500 ||
        elRec.name.length < 1 ||
        elRec.name.length > 200 ||
        elRec.context.length > 500
      ) {
        return invalid("INVALID_CONTENT_VALUE");
      }
    }
    for (const el of content.sourcesCited as unknown[]) {
      if (el === null || typeof el !== "object" || Array.isArray(el)) {
        return invalid("INVALID_CONTENT_VALUE");
      }
      const elRec = el as Record<string, unknown>;
      const elKeys = Object.keys(elRec);
      if (elKeys.length !== 2 || !["source", "type"].every((k) => elKeys.includes(k))) {
        return invalid("INVALID_CONTENT_VALUE");
      }
      if (typeof elRec.source !== "string" || typeof elRec.type !== "string") {
        return invalid("INVALID_CONTENT_VALUE");
      }
      if (
        elRec.source.length < 1 ||
        elRec.source.length > 500 ||
        !["review_site", "blog", "forum", "vendor_site", "news", "other"].includes(elRec.type)
      ) {
        return invalid("INVALID_CONTENT_VALUE");
      }
    }
    for (const plat of content.platformsReferenced as unknown[]) {
      if (typeof plat !== "string" || plat.length < 1 || plat.length > 100) {
        return invalid("INVALID_CONTENT_VALUE");
      }
    }

    // Cross invariants -- mirrors persist_probe_result_for_job's own checks.
    const positionOk =
      (content.productPosition === "absent" && content.productMentioned === false) ||
      (["primary", "listed", "negative"].includes(content.productPosition) &&
        content.productMentioned === true);
    if (!positionOk) {
      return invalid("INVALID_CONTENT_INVARIANT");
    }
    if (content.negativeClaimDetected !== (content.productPosition === "negative")) {
      return invalid("INVALID_CONTENT_INVARIANT");
    }
    if (content.citedAsSource !== content.clientSourceCount > 0) {
      return invalid("INVALID_CONTENT_INVARIANT");
    }
    const platformsCovered = content.platformsReferenced.every((plat) =>
      content.sourcesCited.some((src) => src.source.toLowerCase().includes(plat.toLowerCase()))
    );
    if (!platformsCovered) {
      return invalid("INVALID_CONTENT_INVARIANT");
    }

    const job = store.protocolExecutionJobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId) {
      return invalid("JOB_NOT_FOUND");
    }
    if (!jobFencingOk(job, input.claimToken)) {
      return invalid("JOB_NOT_OWNED");
    }
    if (job.currentAttemptId === null) {
      return invalid("NO_CURRENT_ATTEMPT");
    }

    const attempt = store.protocolAttempts.get(job.currentAttemptId);
    if (!attempt || attempt.jobId !== input.jobId || attempt.projectId !== input.projectId) {
      return invalid("ATTEMPT_NOT_OWNED_BY_JOB");
    }

    // DEFECT_02: explicit existence checks -- never continue with a NULL
    // lookup, mirroring the SQL fix exactly.
    const protocol = store.protocols.get(job.protocolId);
    if (!protocol || protocol.projectId !== input.projectId) {
      return invalid("PROTOCOL_NOT_FOUND");
    }
    const buyerQuestionVersion = store.buyerQuestionVersions.get(protocol.buyerQuestionVersionId);
    if (!buyerQuestionVersion || buyerQuestionVersion.projectId !== input.projectId) {
      return invalid("BUYER_QUESTION_VERSION_NOT_FOUND");
    }
    const probeRun = attempt.probeRunId ? store.probeRuns.get(attempt.probeRunId) : undefined;
    if (!probeRun || probeRun.projectId !== input.projectId) {
      return invalid("PROBE_RUN_NOT_FOUND");
    }

    const analysisCalls = [...store.protocolExternalCalls.values()].filter(
      (ec) => ec.protocolAttemptId === attempt.id && ec.callKind === "analysis"
    );
    const maxGeneration = analysisCalls.reduce((max, ec) => Math.max(max, ec.generation), 0);
    const analysisCall = analysisCalls.find((ec) => ec.generation === maxGeneration);
    if (!analysisCall) {
      return { outcome: "WRONG_CALL_KIND", probeResultId: null, canonicalResultSha256: null };
    }
    if (analysisCall.status !== "completed") {
      return { outcome: "ANALYSIS_NOT_COMPLETED", probeResultId: null, canonicalResultSha256: null };
    }
    if (analysisCall.parseFailedAt !== null) {
      return { outcome: "PARSE_ALREADY_MARKED_FAILED", probeResultId: null, canonicalResultSha256: null };
    }
    const analysisReceipt = [...store.analysisCallReceipts.values()].find(
      (r) => r.externalCallId === analysisCall.id
    );
    if (!analysisReceipt) {
      return { outcome: "RECEIPT_NOT_FOUND", probeResultId: null, canonicalResultSha256: null };
    }

    const perplexityCall = [...store.protocolExternalCalls.values()].find(
      (ec) => ec.protocolAttemptId === attempt.id && ec.callKind === "perplexity" && ec.generation === 1
    );
    const providerReceipt = perplexityCall
      ? [...store.providerCallReceipts.values()].find((r) => r.externalCallId === perplexityCall.id)
      : undefined;
    if (!providerReceipt) {
      return { outcome: "RECEIPT_NOT_FOUND", probeResultId: null, canonicalResultSha256: null };
    }

    const runPosition = mapProductPositionToRunPosition(content.productPosition);
    const retryCount = analysisCall.generation - 1;
    // protocol/buyerQuestionVersion/probeRun already resolved and
    // existence-checked above (DEFECT_02) -- never re-fetched here.
    const buyerQuestion = buyerQuestionVersion.promptText;

    // Canonical JSON: same 35-field/2-exclusion shape as
    // persist_probe_result_for_job's own v_canonical, sorted keys (not
    // insertion order) so the fingerprint is internally reproducible.
    const canonical = {
      answerSummary: content.answerSummary,
      citedAsSource: content.citedAsSource,
      clientMentioned: content.productMentioned,
      clientPosition: content.productPosition,
      clientSourceCount: content.clientSourceCount,
      competitorsMentioned: content.competitorsMentioned,
      datasetId: job.datasetBatchId,
      datasetSourceType: "protocol_execution_job",
      fullRequestBody: null,
      fullRequestBodySha256: null,
      negativeClaimDetected: content.negativeClaimDetected,
      observationSchemaVersion: 1,
      platform: "perplexity",
      platformsReferenced: content.platformsReferenced,
      probeMode: probeRun?.probeMode ?? null,
      probeRunId: attempt.probeRunId,
      productMentioned: content.productMentioned,
      productPosition: content.productPosition,
      productVerdict: "not_evaluated",
      projectId: input.projectId,
      prompt: buyerQuestion,
      providerHttpStatus: providerReceipt.httpStatus,
      providerLatencyMs: providerReceipt.latencyMs,
      providerModel: null,
      providerRequestId: providerReceipt.providerRequestId,
      rawProbeRequest: buyerQuestion,
      rawProbeRequestSha256: sha256Hex(buyerQuestion),
      rawResponse: providerReceipt.rawResponseBody,
      rawResponseBody: null,
      rawResponseBodySha256: null,
      rawResponseSha256: providerReceipt.rawResponseSha256,
      retryCount,
      runPosition,
      schemaVersion: 1,
      sourcesCited: content.sourcesCited,
      verdict: "not_evaluated",
      whyClientLost: "",
    };
    const hash = sha256Hex(JSON.stringify(canonical, Object.keys(canonical).sort()));

    const list = store.probeResultsByProject.get(input.projectId) ?? [];
    const existing = list.find((r) => r.probeRunId === attempt.probeRunId);
    if (existing) {
      if (existing.canonicalResultSha256 === hash) {
        return { outcome: "ALREADY_PERSISTED", probeResultId: existing.id, canonicalResultSha256: hash };
      }
      return {
        outcome: "CONFLICT",
        probeResultId: existing.id,
        canonicalResultSha256: existing.canonicalResultSha256 ?? null,
      };
    }

    const row: ProbeResult = {
      id: randomUUID(),
      probeRunId: attempt.probeRunId ?? "",
      projectId: input.projectId,
      generatedPromptId: null,
      prompt: buyerQuestion,
      platform: "perplexity",
      probeMode: (probeRun?.probeMode ?? "simulated") as ProbeMode,
      rawResponse: providerReceipt.rawResponseBody ?? "",
      rawProbeRequest: buyerQuestion,
      productMentioned: content.productMentioned,
      productPosition: content.productPosition,
      productVerdict: "not_evaluated",
      citedAsSource: content.citedAsSource,
      clientSourceCount: content.clientSourceCount,
      platformsReferenced: [...content.platformsReferenced],
      clientMentioned: content.productMentioned,
      clientPosition: content.productPosition,
      competitorsMentioned: content.competitorsMentioned,
      sourcesCited: content.sourcesCited,
      answerSummary: content.answerSummary,
      verdict: "not_evaluated",
      whyClientLost: "",
      rawResponseSha256: providerReceipt.rawResponseSha256 ?? null,
      rawResponseBody: null,
      rawResponseBodySha256: null,
      rawProbeRequestSha256: sha256Hex(buyerQuestion),
      fullRequestBody: null,
      fullRequestBodySha256: null,
      providerHttpStatus: providerReceipt.httpStatus ?? null,
      providerLatencyMs: providerReceipt.latencyMs ?? null,
      providerRequestId: providerReceipt.providerRequestId ?? null,
      providerModel: null,
      retryCount,
      snapshotRequestId: null,
      datasetId: job.datasetBatchId,
      datasetSourceType: "protocol_execution_job",
      runPosition,
      negativeClaimDetected: content.negativeClaimDetected,
      observationSchemaVersion: 1,
      canonicalResultSha256: hash,
      createdAt: nowIso(),
    };
    list.push(row);
    store.probeResultsByProject.set(input.projectId, list);

    return { outcome: "PERSISTED", probeResultId: row.id, canonicalResultSha256: hash };
  },

  async claimNextPendingAlert(
    input: ClaimNextPendingAlertInput
  ): Promise<ClaimNextPendingAlertResult> {
    const store = getStore();
    const nowMs = Date.now();
    let reconciledClaimed = 0;
    let reconciledUnder24h = 0;
    let reconciledOver24h = 0;

    for (const delivery of store.protocolExecutionJobAlertDeliveries.values()) {
      if (delivery.status !== "claimed" && delivery.status !== "request_sent") continue;
      if (delivery.leaseExpiresAt === null || new Date(delivery.leaseExpiresAt).getTime() >= nowMs) continue;

      if (delivery.status === "claimed") {
        const inFlight = [...store.protocolExecutionJobAlertDeliveryAttempts.values()].some(
          (a) => a.deliveryId === delivery.deliveryId && a.outcome === "request_sent"
        );
        if (!inFlight) {
          delivery.status = "pending";
          delivery.workerId = null;
          delivery.claimToken = null;
          delivery.leaseExpiresAt = null;
          reconciledClaimed += 1;
        }
        continue;
      }

      // status === "request_sent"
      const staleAttempt = [...store.protocolExecutionJobAlertDeliveryAttempts.values()].find(
        (a) => a.deliveryId === delivery.deliveryId && a.outcome === "request_sent"
      );
      if (!staleAttempt) continue;
      const ageMs = nowMs - new Date(staleAttempt.requestSentAt).getTime();
      const isUnder24h = ageMs < 24 * 60 * 60 * 1000;

      staleAttempt.outcome = isUnder24h ? "ambiguous_under_24h" : "ambiguous_over_24h";
      staleAttempt.finishedAt = nowIso();

      if (isUnder24h && delivery.attemptCount < 3) {
        delivery.status = "pending";
        delivery.nextAttemptAt = nowIso();
        reconciledUnder24h += 1;
      } else {
        delivery.status = "needs_review_delivery";
        delivery.nextAttemptAt = null;
        reconciledOver24h += 1;
      }
      delivery.workerId = null;
      delivery.claimToken = null;
      delivery.leaseExpiresAt = null;
    }

    const candidate = [...store.protocolExecutionJobAlertDeliveries.values()]
      .filter(
        (d) =>
          d.status === "pending" &&
          (d.nextAttemptAt === null || new Date(d.nextAttemptAt).getTime() <= nowMs) &&
          d.attemptCount < 3
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!candidate) {
      return {
        outcome: "NO_ALERT_AVAILABLE",
        deliveryId: null,
        alertEventId: null,
        claimToken: null,
        attemptCount: null,
        projectId: null,
        jobId: null,
        eventType: null,
        reasonCode: null,
        idempotencyKey: null,
        reconciledStaleClaimedCount: reconciledClaimed,
        reconciledUnder24hCount: reconciledUnder24h,
        reconciledOver24hCount: reconciledOver24h,
      };
    }

    const token = randomUUID();
    candidate.status = "claimed";
    candidate.workerId = input.workerId;
    candidate.claimToken = token;
    candidate.leaseExpiresAt = new Date(nowMs + input.leaseSeconds * 1000).toISOString();

    const event = store.protocolExecutionJobAlerts.get(candidate.alertEventId)!;

    return {
      outcome: "CLAIMED",
      deliveryId: candidate.deliveryId,
      alertEventId: event.alertEventId,
      claimToken: token,
      attemptCount: candidate.attemptCount,
      projectId: event.projectId,
      jobId: event.jobId,
      eventType: event.eventType,
      reasonCode: event.reasonCode,
      idempotencyKey: `m5-alert:${event.alertEventId}`,
      reconciledStaleClaimedCount: reconciledClaimed,
      reconciledUnder24hCount: reconciledUnder24h,
      reconciledOver24hCount: reconciledOver24h,
    };
  },

  async renewAlertLease(input: RenewAlertLeaseInput): Promise<RenewAlertLeaseResult> {
    const store = getStore();
    const delivery = store.protocolExecutionJobAlertDeliveries.get(input.deliveryId);
    if (!delivery) {
      return { outcome: "DELIVERY_NOT_FOUND", deliveryId: null };
    }
    const owned =
      delivery.claimToken === input.claimToken &&
      delivery.leaseExpiresAt !== null &&
      new Date(delivery.leaseExpiresAt).getTime() > Date.now() &&
      (delivery.status === "claimed" || delivery.status === "request_sent");
    if (!owned) {
      return { outcome: "DELIVERY_NOT_OWNED", deliveryId: null };
    }
    delivery.leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
    return { outcome: "RENEWED", deliveryId: delivery.deliveryId };
  },

  async markAlertRequestSent(
    input: MarkAlertRequestSentInput
  ): Promise<MarkAlertRequestSentResult> {
    const store = getStore();
    const delivery = store.protocolExecutionJobAlertDeliveries.get(input.deliveryId);
    if (!delivery) {
      return { outcome: "DELIVERY_NOT_FOUND", attemptId: null, attemptSeq: null, idempotencyKey: null };
    }
    const owned =
      delivery.claimToken === input.claimToken &&
      delivery.leaseExpiresAt !== null &&
      new Date(delivery.leaseExpiresAt).getTime() > Date.now() &&
      delivery.status === "claimed";
    if (!owned) {
      return { outcome: "DELIVERY_NOT_OWNED", attemptId: null, attemptSeq: null, idempotencyKey: null };
    }
    if (delivery.attemptCount >= 3) {
      return {
        outcome: "ALERT_ATTEMPT_CAP_EXCEEDED",
        attemptId: null,
        attemptSeq: null,
        idempotencyKey: null,
      };
    }

    const nextSeq = delivery.attemptCount + 1;
    const key = `m5-alert:${delivery.alertEventId}`;
    const attempt: MemoryAlertDeliveryAttempt = {
      attemptId: randomUUID(),
      deliveryId: delivery.deliveryId,
      attemptSeq: nextSeq,
      idempotencyKey: key,
      outcome: "request_sent",
      requestSentAt: nowIso(),
      finishedAt: null,
      resendEmailId: null,
      httpStatus: null,
      errorCode: null,
      createdAt: nowIso(),
    };
    store.protocolExecutionJobAlertDeliveryAttempts.set(attempt.attemptId, attempt);
    delivery.status = "request_sent";
    delivery.attemptCount = nextSeq;

    return { outcome: "REQUEST_MARKED_SENT", attemptId: attempt.attemptId, attemptSeq: nextSeq, idempotencyKey: key };
  },

  async recordAlertDeliveryReceipt(
    input: RecordAlertDeliveryReceiptInput
  ): Promise<RecordAlertDeliveryReceiptResult> {
    const store = getStore();

    // DEFECT_04: real runtime validation, matching record_alert_
    // delivery_receipt's own ordering exactly (outcome validated before
    // any lookup) -- never relying on TypeScript's compile-time literal
    // union alone, since a caller can bypass it via an `unknown` cast,
    // exactly as a real text parameter sent to the RPC could carry
    // anything.
    const allowedOutcomes = ["accepted", "http_error", "ambiguous_under_24h", "ambiguous_over_24h"];
    if (!allowedOutcomes.includes(input.outcome as unknown as string)) {
      return { outcome: "INVALID_OUTCOME", deliveryId: null, finalDeliveryStatus: null };
    }

    const delivery = store.protocolExecutionJobAlertDeliveries.get(input.deliveryId);
    if (!delivery) {
      return { outcome: "DELIVERY_NOT_FOUND", deliveryId: null, finalDeliveryStatus: null };
    }
    const owned =
      delivery.claimToken === input.claimToken &&
      delivery.leaseExpiresAt !== null &&
      new Date(delivery.leaseExpiresAt).getTime() > Date.now() &&
      delivery.status === "request_sent";
    if (!owned) {
      return { outcome: "DELIVERY_NOT_OWNED", deliveryId: null, finalDeliveryStatus: null };
    }

    const attempt = store.protocolExecutionJobAlertDeliveryAttempts.get(input.attemptId);
    if (!attempt || attempt.deliveryId !== input.deliveryId || attempt.outcome !== "request_sent") {
      return { outcome: "ATTEMPT_ALREADY_TERMINAL", deliveryId: null, finalDeliveryStatus: null };
    }

    attempt.outcome = input.outcome;
    attempt.finishedAt = nowIso();
    attempt.resendEmailId = input.outcome === "accepted" ? input.resendEmailId ?? null : null;
    attempt.httpStatus = input.httpStatus ?? null;
    attempt.errorCode = input.outcome === "http_error" ? input.errorCode ?? null : null;

    const jitter = 0.8 + Math.random() * 0.4;
    let nextStatus: AlertDeliveryStatus;
    let nextAttemptAt: string | null;

    if (input.outcome === "accepted") {
      nextStatus = "accepted";
      nextAttemptAt = null;
    } else if (input.outcome === "http_error") {
      if (input.errorCode === "http_4xx_permanent" || delivery.attemptCount >= 3) {
        nextStatus = "failed";
        nextAttemptAt = null;
      } else {
        nextStatus = "pending";
        const baseSeconds = delivery.attemptCount === 1 ? 30 : 300;
        nextAttemptAt = new Date(Date.now() + baseSeconds * 1000 * jitter).toISOString();
      }
    } else if (input.outcome === "ambiguous_under_24h") {
      if (delivery.attemptCount >= 3) {
        nextStatus = "needs_review_delivery";
        nextAttemptAt = null;
      } else {
        nextStatus = "pending";
        nextAttemptAt = nowIso();
      }
    } else {
      nextStatus = "needs_review_delivery";
      nextAttemptAt = null;
    }

    delivery.status = nextStatus;
    delivery.nextAttemptAt = nextAttemptAt;
    delivery.workerId = null;
    delivery.claimToken = null;
    delivery.leaseExpiresAt = null;

    return { outcome: "RECEIPT_RECORDED", deliveryId: delivery.deliveryId, finalDeliveryStatus: nextStatus };
  },
};
