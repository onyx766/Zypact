import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// `createPublicReportToken` is deliberately not imported here. Public tokens
// for snapshot report artifacts are owned by the SQL layer: the RPCs issue
// them on first write and preserve them on every later write. The in-memory
// adapter still generates its own, because it has no SQL layer.
import { snapshotReportWriteMode } from "./snapshot-write-mode";
import type {
  AbortAttemptAndFailJobForJobInput,
  AbortAttemptAndFailJobForJobResult,
  CloseAttemptForParseFailureForJobInput,
  CloseAttemptForParseFailureForJobResult,
  AdmitAndReserveAttemptInput,
  AdmitAndReserveAttemptResult,
  AnalysisLlmCall,
  AnalysisLlmCallInput,
  ApproveBuyerQuestionVersionInput,
  ApproveBuyerQuestionVersionResult,
  ApproveProtocolInput,
  ApproveProtocolResult,
  AttemptKind,
  BackfillProbeResultDatasetIdentityInput,
  BackfillProbeResultDatasetIdentityResult,
  BackfillProbeResultDatasetIdentityStatus,
  BuyerQuestion,
  BuyerQuestionProvenance,
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
  EntityObservation,
  EntityObservationOutcome,
  EntityResolutionPassOutcome,
  EntityResolutionPassStatus,
  EntityType,
  EvidenceBankProvenance,
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
  ProtocolAttemptStatus,
  ProtocolStatus,
  RunPosition,
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
  SnapshotRequestLimitCode,
  SitePage,
  StartAttemptInput,
  StartAttemptResult,
  StartOrResumeEntityResolutionPassInput,
  StartOrResumeEntityResolutionPassResult,

  ReplaceUndeliveredSnapshotReportArtifactInput,
  SnapshotReportArtifactRevision,
  BeginSnapshotReportDeliveryInput,
  BegunSnapshotReportDelivery,
  FinalizeSnapshotReportDeliveryInput,
  FinalizedSnapshotReportDelivery,
  ReleaseSnapshotReportDeliveryClaimInput,

  // M5-2 Stage A
  ProtocolExecutionJob,
  ProtocolExecutionJobStatus,
  ProtocolExternalCall,
  ExternalCallKind,
  FailJobWithoutAttemptForJobInput,
  FailJobWithoutAttemptForJobResult,
  ExternalCallStatus,
  CostBasis,
  ProviderCallReceipt,
  AnalysisCallReceipt,
  AnalysisCallReceiptProvider,
  EnqueueProtocolExecutionJobInput,
  EnqueueProtocolExecutionJobResult,
  VerifyPhase3dCanaryPostClaimInput,
  VerifyPhase3dCanaryPostClaimResult,
  ClaimProtocolExecutionJobByIdInput,
  ClaimProtocolExecutionJobByIdResult,
  ClaimProtocolExecutionJobInput,
  ClaimProtocolExecutionJobResult,
  RenewProtocolExecutionJobLeaseInput,
  RenewProtocolExecutionJobLeaseResult,
  AdmitAndReserveAttemptForJobInput,
  AdmitAndReserveAttemptForJobResult,
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
  ReactivateAbandonedJobInput,
  ReactivateAbandonedJobResult,
  RetryFullAttemptForJobInput,
  RetryFullAttemptForJobResult,
  RetryAnalysisGenerationForJobInput,
  RetryAnalysisGenerationForJobResult,
  MarkAnalysisParseFailedForJobInput,
  MarkAnalysisParseFailedForJobResult,
  ParseAnalysisFailureCode,
  AuthorizeOperatorRetryInput,
  AuthorizeOperatorRetryResult,
  GetProtocolExecutionJobContextInput,
  GetProtocolExecutionJobContextResult,
  MarkProtocolExecutionJobNeedsReviewForAmbiguityInput,
  MarkProtocolExecutionJobNeedsReviewForAmbiguityResult,
  PersistProbeResultForJobInput,
  PersistProbeResultForJobResult,
  AlertEventType,
  AlertReasonCode,
  AlertDeliveryStatus,
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
import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";
import { validateApprovedByUuid } from "@/lib/db/validate-approved-by-uuid";

/**
 * Supabase adapter (service role). Only instantiated when
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are both set.
 * Otherwise `getDb()` returns the in-memory adapter.
 */

let cached: SupabaseClient | null = null;

/**
 * Test-only client override, mirroring
 * `__setSupabaseServerClientForTests` in `lib/supabase/server.ts`.
 * Production code never touches this; it exists so the write-mode tests can
 * observe which RPC or table operation the adapter performs without a
 * database. Pass null to restore normal behavior.
 */
let __testClientOverride: SupabaseClient | null = null;
export function __setSupabaseAdapterClientForTests(
  client: SupabaseClient | null
): void {
  __testClientOverride = client;
}

function getClient(): SupabaseClient {
  if (__testClientOverride) return __testClientOverride;
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "supabase-adapter: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

interface SnapshotRequestDbRow {
  id: string;
  competitors?: unknown;
  work_email: string;
  normalized_email: string;
  company_name: string;
  contact_name: string | null;
  website_url: string;
  normalized_domain: string;
  buyer_category: string;
  status: string;
  request_ip_hash: string | null;
  project_id: string | null;
  progress_stage: string | null;
  progress_updated_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  protocol_id: string | null;
  claimed_by: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotReportArtifactDbRow {
  delivery_claim_token?: string | null;
  delivery_claimed_at?: string | null;
  id: string;
  snapshot_request_id: string;
  project_id: string;
  full_report_markdown: string;
  short_report_markdown: string;
  full_report_filename: string;
  short_report_filename: string;
  generated_at: string;
  public_token: string;
  delivered_at: string | null;
  delivery_message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  user_id: string | null;
  company_name: string | null;
  domain: string;
  category: string | null;
  created_at: string;
}

interface SitePageRow {
  id: string;
  project_id: string;
  url: string;
  title: string;
  content: string;
  page_type: string;
  created_at: string;
}

interface MirrorProfileDbRow {
  id: string;
  project_id: string;
  json: unknown;
  created_at: string;
}

interface GeneratedPromptDbRow {
  id: string;
  project_id: string;
  prompt: string;
  intent_type: string;
  commercial_value: number;
  winnability: number;
  priority: number;
  rationale: string;
  selected: boolean;
  created_at: string;
}

interface ProbeRunDbRow {
  id: string;
  project_id: string;
  platform: string;
  status: string;
  /** Sprint 12 — added by migration 0012, defaults to 'simulated'. */
  probe_mode: string;
  /** M2 canonical observations contract, first tranche — nullable. */
  snapshot_request_id?: string | null;
  dataset_id?: string | null;
  dataset_source_type?: string | null;
  created_at: string;
}

interface EvidenceBankDbRow {
  id: string;
  project_id: string;
  product_description: string;
  target_audience: unknown;
  main_use_cases: unknown;
  features: unknown;
  proof_items: unknown;
  competitors: unknown;
  allowed_claims: unknown;
  forbidden_claims: unknown;
  tone: string;
  notes: string;
  /** Sprint 12 — added by migration 0012, defaults to 'auto_filled_from_mirror_profile'. */
  provenance: string;
  created_at: string;
  updated_at: string;
}

interface GapMapDbRow {
  id: string;
  project_id: string;
  json: unknown;
  created_at: string;
}

interface GapDbRow {
  id: string;
  project_id: string;
  competitor_name: string | null;
  type: string;
  severity: string;
  explanation: string;
  affected_prompts: unknown;
  suggested_fix_direction: string;
  created_at: string;
}

interface CompetitorDbRow {
  id: string;
  project_id: string;
  name: string;
  website: string | null;
  discovery_source: string;
  mention_count: number;
  prompt_ids: unknown;
  threat_level: string;
  confidence: string;
  is_phantom: boolean;
  is_blind_spot: boolean;
  canonical_entity_id: string | null;
  /**
   * M3 — incident fix. Constant discriminator required by the
   * project-scoped FK added in migration 0045 (`'competitor'` iff
   * `canonical_entity_id` is non-null, `NULL` otherwise). The RPC
   * (migration 0046) derives this server-side from
   * `canonical_entity_id` alone and does not trust a client-supplied
   * value — this field only needs to round-trip correctly on read.
   */
  canonical_entity_type: string | null;
  created_at: string;
  updated_at: string;
}

interface FixBriefDbRow {
  id: string;
  project_id: string;
  gap_id: string | null;
  probe_result_id: string | null;
  lost_prompt: string;
  competitor_recommended: string;
  root_cause: string;
  recommended_fix: string;
  fix_type: string;
  assets_to_generate: unknown;
  evidence_needed: unknown;
  evidence_available: unknown;
  priority: number;
  expected_impact: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface GeneratedAssetDbRow {
  id: string;
  project_id: string;
  fix_brief_id: string;
  asset_type: string;
  title: string;
  content: string;
  placeholders: unknown;
  claims_used: unknown;
  qa_status: string;
  lifecycle_status: string | null;
  generation_provider: string | null;
  generation_model: string | null;
  created_at: string;
  updated_at: string;
}

interface QaReportDbRow {
  id: string;
  project_id: string;
  generated_asset_id: string;
  verdict: string;
  violations: unknown;
  placeholders_remaining: unknown;
  overall_notes: string;
  created_at: string;
}

interface ProbeResultDbRow {
  id: string;
  probe_run_id: string;
  project_id: string;
  generated_prompt_id: string | null;
  prompt: string;
  platform: string;
  /** Sprint 12 — added by migration 0012, defaults to 'simulated'. */
  probe_mode: string;
  raw_response: string;
  raw_probe_request?: string | null;
  product_mentioned?: boolean | null;
  product_position?: string | null;
  product_verdict?: string | null;
  cited_as_source?: boolean | null;
  client_source_count?: number | null;
  platforms_referenced?: unknown;
  client_mentioned: boolean;
  client_position: string;
  competitors_mentioned: unknown;
  sources_cited: unknown;
  answer_summary: string;
  verdict: string;
  why_client_lost: string;
  raw_response_sha256?: string | null;
  raw_response_body?: string | null;
  raw_response_body_sha256?: string | null;
  raw_probe_request_sha256?: string | null;
  full_request_body?: string | null;
  full_request_body_sha256?: string | null;
  provider_http_status?: number | null;
  provider_latency_ms?: number | null;
  provider_request_id?: string | null;
  provider_model?: string | null;
  retry_count?: number | null;
  /** M2 canonical observations contract, first tranche — nullable. */
  snapshot_request_id?: string | null;
  dataset_id?: string | null;
  dataset_source_type?: string | null;
  run_position?: string | null;
  negative_claim_detected?: boolean | null;
  observation_schema_version?: number | null;
  /** D-028 — SHA-256 of the parsed result, computed server-side by persist_probe_result_for_job. */
  canonical_result_sha256?: string | null;
  created_at: string;
}

interface ProbeFailureDbRow {
  id: string;
  probe_run_id: string | null;
  project_id: string;
  platform: string;
  prompt: string;
  failure_reason: string;
  provider_http_status: number | null;
  provider_error_body: string | null;
  provider_error_body_sha256: string | null;
  provider_latency_ms: number | null;
  provider_request_id: string | null;
  raw_probe_request_sha256: string | null;
  full_request_body: string | null;
  full_request_body_sha256: string | null;
  retry_count: number;
  created_at: string;
}

function coerceProbeFailureReason(
  value: string
): ProbeFailure["failureReason"] {
  return value === "network_error" || value === "http_error" || value === "empty_answer"
    ? value
    : "http_error";
}

function mapProbeFailure(r: ProbeFailureDbRow): ProbeFailure {
  return {
    id: r.id,
    probeRunId: r.probe_run_id,
    projectId: r.project_id,
    platform: r.platform,
    prompt: r.prompt,
    failureReason: coerceProbeFailureReason(r.failure_reason),
    providerHttpStatus: r.provider_http_status,
    providerErrorBody: r.provider_error_body,
    providerErrorBodySha256: r.provider_error_body_sha256,
    providerLatencyMs: r.provider_latency_ms,
    providerRequestId: r.provider_request_id,
    rawProbeRequestSha256: r.raw_probe_request_sha256,
    fullRequestBody: r.full_request_body,
    fullRequestBodySha256: r.full_request_body_sha256,
    retryCount: r.retry_count,
    createdAt: r.created_at,
  };
}

interface DatasetBatchDbRow {
  id: string;
  project_id: string;
  dataset_source_type: string;
  snapshot_request_id: string | null;
  backfill_key: string | null;
  note: string | null;
  created_at: string;
}

function coerceDatasetSourceType(value: string): DatasetSourceType {
  // D-028: 'protocol_execution_job' is only ever real for probe_results
  // rows (dataset_batches' own CHECK constraint never allows it) --
  // recognizing it here is harmless for dataset_batches (that value
  // never actually occurs there) and required for probe_results
  // (coerceDatasetSourceTypeOrNull delegates to this same function),
  // rather than silently folding it into 'legacy_unresolved'.
  return value === "snapshot_request" ||
    value === "manual_scan" ||
    value === "legacy_unresolved" ||
    value === "protocol_execution_job"
    ? value
    : "legacy_unresolved";
}

function mapDatasetBatch(r: DatasetBatchDbRow): DatasetBatch {
  return {
    id: r.id,
    projectId: r.project_id,
    datasetSourceType: coerceDatasetSourceType(r.dataset_source_type),
    snapshotRequestId: r.snapshot_request_id,
    backfillKey: r.backfill_key,
    note: r.note,
    createdAt: r.created_at,
  };
}

interface CanonicalEntityDbRow {
  id: string;
  project_id: string;
  entity_type: string;
  resolver_version: number;
  created_at: string;
}

function coerceEntityType(value: string): CanonicalEntity["entityType"] {
  return value === "client" || value === "competitor" || value === "platform"
    ? value
    : "competitor";
}

function mapCanonicalEntity(r: CanonicalEntityDbRow): CanonicalEntity {
  return {
    id: r.id,
    projectId: r.project_id,
    entityType: coerceEntityType(r.entity_type),
    resolverVersion: r.resolver_version,
    createdAt: r.created_at,
  };
}

interface EntityAliasDbRow {
  id: string;
  canonical_entity_id: string;
  project_id: string;
  entity_type: string;
  raw_text: string;
  normalized_text: string;
  resolver_version: number;
  alias_generation: number;
  created_at: string;
}

function mapEntityAlias(r: EntityAliasDbRow): EntityAlias {
  return {
    id: r.id,
    canonicalEntityId: r.canonical_entity_id,
    projectId: r.project_id,
    entityType: coerceEntityType(r.entity_type),
    rawText: r.raw_text,
    normalizedText: r.normalized_text,
    resolverVersion: r.resolver_version,
    aliasGeneration: r.alias_generation,
    createdAt: r.created_at,
  };
}

interface EntityObservationDbRow {
  id: string;
  probe_result_id: string;
  probe_run_id: string;
  generated_prompt_id: string | null;
  project_id: string;
  dataset_id: string;
  dataset_source_type: string;
  resolution_pass_id: string;
  canonical_entity_id: string | null;
  entity_type: string | null;
  raw_text: string;
  normalized_text: string;
  resolver_version: number;
  mention_ordinal: number;
  context: string | null;
  status: string;
  observation_generation: number;
  created_at: string;
}

// The discriminated union in EntityObservation (D-017 §4) is not
// something a raw DB row can prove at the type level — the row itself
// only satisfies it because migration 0041's
// entity_observations_status_entity_check already guarantees the
// correlation at the database layer. This cast reflects that: the
// invariant is enforced by the CHECK constraint, not re-derived here.
function mapEntityObservation(r: EntityObservationDbRow): EntityObservation {
  return {
    id: r.id,
    probeResultId: r.probe_result_id,
    probeRunId: r.probe_run_id,
    generatedPromptId: r.generated_prompt_id,
    projectId: r.project_id,
    datasetId: r.dataset_id,
    datasetSourceType: r.dataset_source_type as DatasetSourceType,
    resolutionPassId: r.resolution_pass_id,
    canonicalEntityId: r.canonical_entity_id,
    entityType: r.entity_type,
    rawText: r.raw_text,
    normalizedText: r.normalized_text,
    resolverVersion: r.resolver_version,
    mentionOrdinal: r.mention_ordinal,
    context: r.context,
    status: r.status,
    observationGeneration: r.observation_generation,
    createdAt: r.created_at,
  } as EntityObservation;
}

interface AnalysisLlmCallDbRow {
  id: string;
  project_id: string;
  stage: string;
  provider: string;
  model: string;
  used_mock: boolean;
  used_retry: boolean;
  latency_ms: number;
  request_sha256: string | null;
  response_sha256: string | null;
  created_at: string;
}

function coerceLlmProvider(value: string): AnalysisLlmCall["provider"] {
  return value === "openai" || value === "anthropic" || value === "mock"
    ? value
    : "mock";
}

function mapAnalysisLlmCall(r: AnalysisLlmCallDbRow): AnalysisLlmCall {
  return {
    id: r.id,
    projectId: r.project_id,
    stage: r.stage,
    provider: coerceLlmProvider(r.provider),
    model: r.model,
    usedMock: r.used_mock,
    usedRetry: r.used_retry,
    latencyMs: r.latency_ms,
    requestSha256: r.request_sha256,
    responseSha256: r.response_sha256,
    createdAt: r.created_at,
  };
}

function snapshotLimitCodeFromError(
  error: { message?: string } | null
): SnapshotRequestLimitCode | null {
  const message = error?.message ?? "";

  if (message.includes("snapshot_limit_email_30d")) {
    return "email_30d";
  }

  if (message.includes("snapshot_limit_domain_30d")) {
    return "domain_30d";
  }

  if (message.includes("snapshot_limit_active_domain")) {
    return "active_domain";
  }

  if (message.includes("snapshot_limit_ip_daily")) {
    return "ip_daily";
  }

  return null;
}

/**
 * Competitor frame from the stored jsonb array.
 *
 * Historical rows predate the column and read as `[]`. Anything that is not
 * an array of strings is treated as absent rather than partially trusted —
 * the approval RPC is what guarantees a valid stored list, so a malformed
 * value here means the row was never approved through it.
 */
function mapCompetitors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : [];
}

function mapSnapshotRequest(r: SnapshotRequestDbRow): SnapshotRequest {
  return {
    competitors: mapCompetitors(r.competitors),
    id: r.id,
    workEmail: r.work_email,
    normalizedEmail: r.normalized_email,
    companyName: r.company_name,
    contactName: r.contact_name ?? null,
    websiteUrl: r.website_url,
    normalizedDomain: r.normalized_domain,
    buyerCategory: r.buyer_category,
    status: r.status as SnapshotRequest["status"],
    requestIpHash: r.request_ip_hash,
    projectId: r.project_id,
    progressStage:
      r.progress_stage as SnapshotRequest["progressStage"],
    progressUpdatedAt:
      r.progress_updated_at,
    // Preserved exactly as stored. Null before approval; never defaulted
    // to a timestamp or an actor.
    approvedAt: r.approved_at ?? null,
    approvedBy: r.approved_by ?? null,
    protocolId: r.protocol_id ?? null,
    claimedBy: r.claimed_by ?? null,
    claimToken: r.claim_token ?? null,
    leaseExpiresAt: r.lease_expires_at ?? null,
    attemptCount: r.attempt_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSnapshotReportArtifact(
  row: SnapshotReportArtifactDbRow
): SnapshotReportArtifact {
  return {
    id: row.id,
    snapshotRequestId:
      row.snapshot_request_id,
    projectId: row.project_id,
    fullReportMarkdown:
      row.full_report_markdown,
    shortReportMarkdown:
      row.short_report_markdown,
    fullReportFilename:
      row.full_report_filename,
    shortReportFilename:
      row.short_report_filename,
    generatedAt: row.generated_at,
    publicToken: row.public_token,
    // Derived, never carried: the raw claim token must not reach a browser,
    // so it is reduced to a boolean here rather than stripped downstream.
    deliveryClaimActive: row.delivery_claim_token != null,
    deliveryClaimedAt: row.delivery_claimed_at ?? null,
    deliveredAt: row.delivered_at,
    deliveryMessageId:
      row.delivery_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    userId: r.user_id,
    companyName: r.company_name,
    domain: r.domain,
    category: r.category,
    createdAt: r.created_at,
  };
}

function mapSitePage(r: SitePageRow): SitePage {
  return {
    id: r.id,
    projectId: r.project_id,
    url: r.url,
    title: r.title,
    content: r.content,
    pageType: r.page_type,
    createdAt: r.created_at,
  };
}

function mapMirror(r: MirrorProfileDbRow): MirrorProfileRow {
  return {
    id: r.id,
    projectId: r.project_id,
    json: r.json,
    createdAt: r.created_at,
  };
}

function mapPrompt(r: GeneratedPromptDbRow): GeneratedPrompt {
  return {
    id: r.id,
    projectId: r.project_id,
    prompt: r.prompt,
    intentType: r.intent_type,
    commercialValue: r.commercial_value,
    winnability: r.winnability,
    priority: r.priority,
    rationale: r.rationale,
    selected: r.selected,
    createdAt: r.created_at,
  };
}

function coerceDatasetSourceTypeOrNull(
  value: string | null | undefined
): DatasetSourceType | null {
  if (value == null) return null;
  return coerceDatasetSourceType(value);
}

function coerceRunPositionOrNull(
  value: string | null | undefined
): RunPosition | null {
  if (value == null) return null;
  return value === "not_observed_in_run" ||
    value === "listed_in_run" ||
    value === "primary_in_run" ||
    value === "ambiguous_in_run" ||
    value === "analysis_failed"
    ? value
    : null;
}

function mapProbeRun(r: ProbeRunDbRow): ProbeRun {
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform,
    status: r.status as ProbeRunStatus,
    probeMode: coerceProbeMode(r.probe_mode),
    snapshotRequestId: r.snapshot_request_id ?? null,
    datasetId: r.dataset_id ?? null,
    datasetSourceType: coerceDatasetSourceTypeOrNull(r.dataset_source_type),
    createdAt: r.created_at,
  };
}

function coerceProbeMode(v: unknown): ProbeMode {
  // The CHECK constraint guarantees `'simulated' | 'live_perplexity'`, but read
  // paths still guard against pre-migration rows in dev environments.
  return v === "live_perplexity" ? "live_perplexity" : "simulated";
}

function coerceEvidenceProvenance(v: unknown): EvidenceBankProvenance {
  if (v === "user_edited") return "user_edited";
  if (v === "user_reviewed") return "user_reviewed";
  return "auto_filled_from_mirror_profile";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function mapEvidenceBank(r: EvidenceBankDbRow): EvidenceBankRow {
  const features = Array.isArray(r.features)
    ? (r.features as Array<{ name: unknown; description: unknown }>)
        .filter(
          (f) => typeof f?.name === "string" && typeof f?.description === "string"
        )
        .map((f) => ({
          name: f.name as string,
          description: f.description as string,
        }))
    : [];
  const proofItems = Array.isArray(r.proof_items)
    ? (r.proof_items as Array<{ type: unknown; detail: unknown; sourceUrl?: unknown }>)
        .filter((p) => typeof p?.type === "string" && typeof p?.detail === "string")
        .map((p) => {
          const item: EvidenceBankRow["proofItems"][number] = {
            type: p.type as string,
            detail: p.detail as string,
          };
          if (typeof p.sourceUrl === "string" && p.sourceUrl.length > 0) {
            item.sourceUrl = p.sourceUrl;
          }
          return item;
        })
    : [];
  return {
    id: r.id,
    projectId: r.project_id,
    productDescription: r.product_description,
    targetAudience: asStringArray(r.target_audience),
    mainUseCases: asStringArray(r.main_use_cases),
    features,
    proofItems,
    competitors: asStringArray(r.competitors),
    allowedClaims: asStringArray(r.allowed_claims),
    forbiddenClaims: asStringArray(r.forbidden_claims),
    tone: r.tone,
    notes: r.notes,
    provenance: coerceEvidenceProvenance(r.provenance),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapGapMap(r: GapMapDbRow): GapMapRow {
  return {
    id: r.id,
    projectId: r.project_id,
    json: r.json,
    createdAt: r.created_at,
  };
}

function mapGap(r: GapDbRow): Gap {
  return {
    id: r.id,
    projectId: r.project_id,
    competitorName: r.competitor_name,
    type: r.type,
    severity: r.severity,
    explanation: r.explanation,
    affectedPrompts: Array.isArray(r.affected_prompts)
      ? (r.affected_prompts as string[])
      : [],
    suggestedFixDirection: r.suggested_fix_direction,
    createdAt: r.created_at,
  };
}

function mapCompetitor(r: CompetitorDbRow): Competitor {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    website: r.website,
    discoverySource: r.discovery_source,
    mentionCount: r.mention_count,
    promptIds: Array.isArray(r.prompt_ids) ? (r.prompt_ids as string[]) : [],
    threatLevel: r.threat_level,
    confidence: r.confidence,
    isPhantom: r.is_phantom,
    isBlindSpot: r.is_blind_spot,
    canonicalEntityId: r.canonical_entity_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * M3 — incident fix. Pure payload builder for
 * `replace_competitors_for_project` (migration 0046), extracted so it
 * is directly unit-testable without a live Supabase connection — this
 * is the exact class of bug (canonical_entity_type silently omitted)
 * that caused the 2026-08-20 staging incident, so the payload shape
 * itself now has dedicated test coverage.
 *
 * `canonicalEntityType` is included for symmetry/observability only —
 * the RPC derives its own `canonical_entity_type` from
 * `canonicalEntityId` server-side and does not trust this field.
 */
export function buildCompetitorsRpcPayload(
  competitors: readonly CompetitorInput[]
): unknown[] {
  return competitors.map((c) => ({
    name: c.name,
    website: c.website,
    discoverySource: c.discoverySource,
    mentionCount: c.mentionCount,
    promptIds: c.promptIds,
    threatLevel: c.threatLevel,
    confidence: c.confidence,
    isPhantom: c.isPhantom,
    isBlindSpot: c.isBlindSpot,
    canonicalEntityId: c.canonicalEntityId,
    canonicalEntityType: c.canonicalEntityId ? "competitor" : null,
  }));
}

function mapFixBrief(r: FixBriefDbRow): FixBriefRow {
  return {
    id: r.id,
    projectId: r.project_id,
    gapId: r.gap_id,
    probeResultId: r.probe_result_id,
    lostPrompt: r.lost_prompt,
    competitorRecommended: r.competitor_recommended,
    rootCause: r.root_cause,
    recommendedFix: r.recommended_fix,
    fixType: r.fix_type,
    assetsToGenerate: asStringArray(r.assets_to_generate),
    evidenceNeeded: asStringArray(r.evidence_needed),
    evidenceAvailable: asStringArray(r.evidence_available),
    priority: r.priority,
    expectedImpact: r.expected_impact,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapGeneratedAsset(r: GeneratedAssetDbRow): GeneratedAssetRow {
  const claims = Array.isArray(r.claims_used)
    ? (r.claims_used as Array<{ claim: unknown; source: unknown }>)
        .filter(
          (c) => typeof c?.claim === "string" && typeof c?.source === "string"
        )
        .map((c) => ({ claim: c.claim as string, source: c.source as string }))
    : [];
  return {
    id: r.id,
    projectId: r.project_id,
    fixBriefId: r.fix_brief_id,
    assetType: r.asset_type,
    title: r.title,
    content: r.content,
    placeholders: asStringArray(r.placeholders),
    claimsUsed: claims,
    qaStatus: r.qa_status,
    lifecycleStatus: r.lifecycle_status === "superseded" ? "superseded" : "active",
    generationProvider: r.generation_provider ?? null,
    generationModel: r.generation_model ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapQaReport(r: QaReportDbRow): QaReportRow {
  const violations = Array.isArray(r.violations)
    ? (r.violations as Array<{
        type: unknown;
        quote: unknown;
        reason: unknown;
        suggestedFix: unknown;
      }>)
        .filter(
          (v) =>
            typeof v?.type === "string" &&
            typeof v?.quote === "string" &&
            typeof v?.reason === "string" &&
            typeof v?.suggestedFix === "string"
        )
        .map((v) => ({
          type: v.type as string,
          quote: v.quote as string,
          reason: v.reason as string,
          suggestedFix: v.suggestedFix as string,
        }))
    : [];
  return {
    id: r.id,
    projectId: r.project_id,
    generatedAssetId: r.generated_asset_id,
    verdict: r.verdict,
    violations,
    placeholdersRemaining: asStringArray(r.placeholders_remaining),
    overallNotes: r.overall_notes,
    createdAt: r.created_at,
  };
}

/**
 * Maps a `probe_results` composite that may or may not be there.
 *
 * PostgREST does not serialize a SQL NULL composite as JSON `null`. It
 * emits an object whose every field is null — which is truthy in
 * JavaScript. A bare `row.probe_result ? … : null` therefore reports "a
 * probe result exists" for a job that has none, and a caller that keys a
 * decision off that (the M5-A worker skips its analysis leg when a result
 * is already saved) silently does the wrong thing against the real
 * database while passing every in-memory test.
 *
 * The four cases are deliberately explicit:
 *   - absent (null/undefined)              → null
 *   - present but every field null         → null   (the PostgREST shape)
 *   - present with a real `id`             → mapped
 *   - present, no `id`, but some field set → throw
 *
 * The last one is the important one. A partially populated composite is
 * not a missing row and not a valid row; treating it as either would be a
 * guess. It means the RPC's return contract changed under us, and the
 * caller must hear about that rather than receive a quiet null.
 */
function mapProbeResultNullable(r: ProbeResultDbRow | null | undefined): ProbeResult | null {
  if (r === null || r === undefined) return null;
  const values = Object.values(r as unknown as Record<string, unknown>);
  if (values.length === 0 || values.every((v) => v === null)) return null;
  if (typeof r.id === "string" && r.id.length > 0) return mapProbeResult(r);
  throw new Error(
    "mapProbeResultNullable: probe_result composite has no id but is not all-null; " +
      "refusing to guess whether the row exists."
  );
}

function mapProbeResult(r: ProbeResultDbRow): ProbeResult {
  return {
    id: r.id,
    probeRunId: r.probe_run_id,
    projectId: r.project_id,
    generatedPromptId: r.generated_prompt_id,
    prompt: r.prompt,
    platform: r.platform,
    probeMode: coerceProbeMode(r.probe_mode),
    rawResponse: r.raw_response,
    rawProbeRequest: r.raw_probe_request ?? "",
    productMentioned: r.product_mentioned ?? r.client_mentioned,
    productPosition: r.product_position ?? r.client_position,
    productVerdict: r.product_verdict ?? r.verdict,
    citedAsSource: r.cited_as_source ?? false,
    clientSourceCount: r.client_source_count ?? 0,
    platformsReferenced: asStringArray(r.platforms_referenced),
    clientMentioned: r.client_mentioned,
    clientPosition: r.client_position,
    competitorsMentioned: r.competitors_mentioned,
    sourcesCited: r.sources_cited,
    answerSummary: r.answer_summary,
    verdict: r.verdict,
    whyClientLost: r.why_client_lost,
    rawResponseSha256: r.raw_response_sha256 ?? null,
    rawResponseBody: r.raw_response_body ?? null,
    rawResponseBodySha256: r.raw_response_body_sha256 ?? null,
    rawProbeRequestSha256: r.raw_probe_request_sha256 ?? null,
    fullRequestBody: r.full_request_body ?? null,
    fullRequestBodySha256: r.full_request_body_sha256 ?? null,
    providerHttpStatus: r.provider_http_status ?? null,
    providerLatencyMs: r.provider_latency_ms ?? null,
    providerRequestId: r.provider_request_id ?? null,
    providerModel: r.provider_model ?? null,
    retryCount: r.retry_count ?? 0,
    snapshotRequestId: r.snapshot_request_id ?? null,
    datasetId: r.dataset_id ?? null,
    datasetSourceType: coerceDatasetSourceTypeOrNull(r.dataset_source_type),
    runPosition: coerceRunPositionOrNull(r.run_position),
    negativeClaimDetected: r.negative_claim_detected ?? null,
    observationSchemaVersion: r.observation_schema_version ?? null,
    canonicalResultSha256: r.canonical_result_sha256 ?? null,
    createdAt: r.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  M4 — buyer question identity, protocol, and paid-attempt ledger          */
/*  (migration 0047, draft — not yet applied to any database)                */
/* -------------------------------------------------------------------------- */

interface BuyerQuestionDbRow {
  id: string;
  project_id: string;
  created_at: string;
}

function mapBuyerQuestion(r: BuyerQuestionDbRow): BuyerQuestion {
  return { id: r.id, projectId: r.project_id, createdAt: r.created_at };
}

interface BuyerQuestionVersionDbRow {
  id: string;
  buyer_question_id: string;
  project_id: string;
  version_number: number;
  prompt_text: string;
  prompt_hash: string;
  intent_type: string;
  commercial_value: number;
  winnability: number;
  priority: number;
  rationale: string;
  provenance: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

function mapBuyerQuestionVersion(
  r: BuyerQuestionVersionDbRow
): BuyerQuestionVersion {
  return {
    id: r.id,
    buyerQuestionId: r.buyer_question_id,
    projectId: r.project_id,
    versionNumber: r.version_number,
    promptText: r.prompt_text,
    promptHash: r.prompt_hash,
    intentType: r.intent_type,
    commercialValue: r.commercial_value,
    winnability: r.winnability,
    priority: r.priority,
    rationale: r.rationale,
    provenance: r.provenance as BuyerQuestionProvenance,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}

interface ProtocolDbRow {
  id: string;
  project_id: string;
  buyer_question_version_id: string;
  baseline_protocol_id: string | null;
  provider: string;
  surface: string;
  model_config: Record<string, unknown>;
  planned_baseline_runs: number;
  planned_retest_runs: number;
  paraphrase_plan: Array<{ text: string; hash: string }>;
  unit_of_analysis: string;
  primary_metric: string;
  minimum_useful_change: unknown;
  sample_planning_method: string;
  sample_planning_assumptions: Record<string, unknown>;
  run_cap: number;
  spend_cap_usd: number;
  time_window_seconds: number;
  rate_limit_per_hour: number;
  concurrency_limit: number;
  retry_cap: number;
  observation_window_rule: Record<string, unknown>;
  analyzer_version: number;
  entity_resolution_version: number;
  methodology_version: string;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapProtocol(r: ProtocolDbRow): Protocol {
  return {
    id: r.id,
    projectId: r.project_id,
    buyerQuestionVersionId: r.buyer_question_version_id,
    baselineProtocolId: r.baseline_protocol_id,
    provider: r.provider,
    surface: r.surface,
    modelConfig: r.model_config ?? {},
    plannedBaselineRuns: r.planned_baseline_runs,
    plannedRetestRuns: r.planned_retest_runs,
    paraphrasePlan: r.paraphrase_plan ?? [],
    unitOfAnalysis: r.unit_of_analysis,
    primaryMetric: r.primary_metric,
    minimumUsefulChange: r.minimum_useful_change ?? null,
    samplePlanningMethod: r.sample_planning_method,
    samplePlanningAssumptions: r.sample_planning_assumptions ?? {},
    runCap: r.run_cap,
    spendCapUsd: r.spend_cap_usd,
    timeWindowSeconds: r.time_window_seconds,
    rateLimitPerHour: r.rate_limit_per_hour,
    concurrencyLimit: r.concurrency_limit,
    retryCap: r.retry_cap,
    observationWindowRule: r.observation_window_rule ?? {},
    analyzerVersion: r.analyzer_version,
    entityResolutionVersion: r.entity_resolution_version,
    methodologyVersion: r.methodology_version,
    status: r.status as ProtocolStatus,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ProtocolAttemptDbRow {
  id: string;
  project_id: string;
  protocol_id: string;
  buyer_question_version_id: string;
  attempt_kind: string;
  status: string;
  idempotency_key: string;
  reserved_cost_usd: number;
  actual_cost_usd: number | null;
  probe_run_id: string | null;
  retry_of_attempt_id: string | null;
  termination_reason: string | null;
  reserved_at: string;
  last_activity_at: string;
  terminalized_at: string | null;
  created_at: string;
  /** M5 (migration 0050) — absent (undefined) on rows returned by RPCs that predate this column; normalized to null. */
  job_id?: string | null;
  /** D-025 (migration 0051) — absent (undefined) on rows returned by RPCs that predate this column; normalized to null. */
  baseline_ordinal?: number | null;
}

function mapProtocolAttempt(r: ProtocolAttemptDbRow): ProtocolAttempt {
  return {
    id: r.id,
    projectId: r.project_id,
    protocolId: r.protocol_id,
    buyerQuestionVersionId: r.buyer_question_version_id,
    attemptKind: r.attempt_kind as AttemptKind,
    status: r.status as ProtocolAttemptStatus,
    idempotencyKey: r.idempotency_key,
    reservedCostUsd: r.reserved_cost_usd,
    actualCostUsd: r.actual_cost_usd,
    probeRunId: r.probe_run_id,
    retryOfAttemptId: r.retry_of_attempt_id,
    terminationReason: r.termination_reason,
    reservedAt: r.reserved_at,
    lastActivityAt: r.last_activity_at,
    terminalizedAt: r.terminalized_at,
    createdAt: r.created_at,
    jobId: r.job_id ?? null,
    baselineOrdinal: r.baseline_ordinal ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  M5-2 Stage A — row mappers. Every method below calls an RPC only; none   */
/*  performs direct DML against a table introduced by migrations 0050/0051. */
/* -------------------------------------------------------------------------- */

interface ProtocolExecutionJobDbRow {
  id: string;
  project_id: string;
  protocol_id: string;
  status: string;
  worker_id: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  current_attempt_id: string | null;
  /** D-025 (migration 0051) — absent (undefined) on rows returned by RPCs that predate this column; normalized to 1. */
  next_baseline_ordinal?: number;
  needs_review_reason: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  /** D-026 (correction, migration 0052) — real, NOT NULL on every row this column applies to; no fallback needed. */
  dataset_batch_id: string;
}

function mapProtocolExecutionJob(r: ProtocolExecutionJobDbRow): ProtocolExecutionJob {
  return {
    id: r.id,
    projectId: r.project_id,
    protocolId: r.protocol_id,
    status: r.status as ProtocolExecutionJobStatus,
    workerId: r.worker_id,
    claimToken: r.claim_token,
    leaseExpiresAt: r.lease_expires_at,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    currentAttemptId: r.current_attempt_id,
    nextBaselineOrdinal: r.next_baseline_ordinal ?? 1,
    needsReviewReason: r.needs_review_reason,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    datasetBatchId: r.dataset_batch_id,
  };
}

interface ProtocolExternalCallDbRow {
  id: string;
  project_id: string;
  protocol_attempt_id: string;
  call_kind: string;
  generation: number;
  status: string;
  reserved_cost_usd: number;
  actual_cost_usd: number | null;
  cost_basis: string | null;
  probe_run_id: string | null;
  request_sent_at: string | null;
  terminalized_at: string | null;
  retry_of_external_call_id: string | null;
  created_at: string;
  /** D-027 (migration 0053) — absent (undefined) on rows returned by RPCs that predate these columns; normalized to null. */
  parse_failed_at?: string | null;
  parse_failure_code?: string | null;
}

function mapProtocolExternalCall(r: ProtocolExternalCallDbRow): ProtocolExternalCall {
  return {
    id: r.id,
    projectId: r.project_id,
    protocolAttemptId: r.protocol_attempt_id,
    callKind: r.call_kind as ExternalCallKind,
    generation: r.generation,
    status: r.status as ExternalCallStatus,
    reservedCostUsd: r.reserved_cost_usd,
    actualCostUsd: r.actual_cost_usd,
    costBasis: r.cost_basis as CostBasis | null,
    probeRunId: r.probe_run_id,
    requestSentAt: r.request_sent_at,
    terminalizedAt: r.terminalized_at,
    retryOfExternalCallId: r.retry_of_external_call_id,
    createdAt: r.created_at,
    parseFailedAt: r.parse_failed_at ?? null,
    parseFailureCode: (r.parse_failure_code as ParseAnalysisFailureCode | null) ?? null,
  };
}

/** Nullable: RPC branches that return no composite row (e.g. a hard refusal before any call was located) send back `null`, not an all-null-fields row. */
function mapProtocolExternalCallNullable(
  r: ProtocolExternalCallDbRow | null
): ProtocolExternalCall | null {
  return r ? mapProtocolExternalCall(r) : null;
}

interface ProviderCallReceiptDbRow {
  id: string;
  project_id: string;
  external_call_id: string;
  probe_run_id: string;
  outcome: string;
  http_status: number | null;
  provider_request_id: string | null;
  raw_response_sha256: string | null;
  latency_ms: number | null;
  received_at: string;
  created_at: string;
  /** D-026 (migration 0052) — absent (undefined) on rows returned by RPCs that predate this column; normalized to null. */
  raw_response_body?: string | null;
}

function mapProviderCallReceiptNullable(
  r: ProviderCallReceiptDbRow | null
): ProviderCallReceipt | null {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    externalCallId: r.external_call_id,
    probeRunId: r.probe_run_id,
    outcome: r.outcome as ProviderCallReceipt["outcome"],
    httpStatus: r.http_status,
    providerRequestId: r.provider_request_id,
    rawResponseSha256: r.raw_response_sha256,
    latencyMs: r.latency_ms,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    rawResponseBody: r.raw_response_body ?? null,
  };
}

interface AnalysisCallReceiptDbRow {
  id: string;
  project_id: string;
  external_call_id: string;
  probe_run_id: string;
  outcome: string;
  provider: string | null;
  model: string | null;
  used_mock: boolean;
  request_sha256: string | null;
  response_sha256: string | null;
  latency_ms: number | null;
  received_at: string;
  created_at: string;
  /** TK-R-2 (migration 0058) — absent on rows returned by RPCs that predate this column; normalized to null. */
  provider_request_id?: string | null;
  /** TK-R-3 (migration 0058) — absent on rows returned by RPCs that predate this column; normalized to null. */
  http_status?: number | null;
  /** TK-R-1 (migration 0058) — absent on rows returned by RPCs that predate this column; normalized to null. */
  model_returned?: string | null;
  /** D-026 (migration 0052) — absent (undefined) on rows returned by RPCs that predate this column; normalized to null. */
  raw_content?: string | null;
  /** D-027 (migration 0053) — absent (undefined) on rows returned by RPCs that predate this column; normalized to null. */
  raw_request_body?: string | null;
}

function mapAnalysisCallReceiptNullable(
  r: AnalysisCallReceiptDbRow | null
): AnalysisCallReceipt | null {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    externalCallId: r.external_call_id,
    probeRunId: r.probe_run_id,
    outcome: r.outcome as AnalysisCallReceipt["outcome"],
    provider: r.provider as AnalysisCallReceiptProvider | null,
    model: r.model,
    usedMock: r.used_mock,
    requestSha256: r.request_sha256,
    responseSha256: r.response_sha256,
    latencyMs: r.latency_ms,
    // TK-R-1/2/3 — the four historical staging rows predate these columns
    // and legitimately carry null. `?? null` normalises "column absent
    // from the RPC result" to the same null, never to a fabricated value.
    providerRequestId: r.provider_request_id ?? null,
    httpStatus: r.http_status ?? null,
    modelReturned: r.model_returned ?? null,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    rawContent: r.raw_content ?? null,
    rawRequestBody: r.raw_request_body ?? null,
  };
}

interface ProbeRunDbRow {
  id: string;
  project_id: string;
  platform: string;
  status: string;
  probe_mode: string;
  snapshot_request_id?: string | null;
  dataset_id?: string | null;
  dataset_source_type?: string | null;
  created_at: string;
}

function mapProbeRunNullable(r: ProbeRunDbRow | null): ProbeRun | null {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform,
    status: r.status as ProbeRun["status"],
    probeMode: r.probe_mode as ProbeRun["probeMode"],
    snapshotRequestId: r.snapshot_request_id ?? null,
    datasetId: r.dataset_id ?? null,
    datasetSourceType: r.dataset_source_type as ProbeRun["datasetSourceType"],
    createdAt: r.created_at,
  };
}

function mapProtocolAttemptNullable(r: ProtocolAttemptDbRow | null): ProtocolAttempt | null {
  return r ? mapProtocolAttempt(r) : null;
}

function mapProtocolExecutionJobNullable(
  r: ProtocolExecutionJobDbRow | null
): ProtocolExecutionJob | null {
  return r ? mapProtocolExecutionJob(r) : null;
}

export const supabaseAdapter: DbAdapter = {
  async getSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .from("snapshot_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) {
      throw error;
    }

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async getSnapshotRequestsByProject(
    projectId: string
  ): Promise<SnapshotRequest[]> {
    const { data, error } = await getClient()
      .from("snapshot_requests")
      .select("*")
      .eq("project_id", projectId);

    if (error) throw error;
    return (data ?? []).map((r) => mapSnapshotRequest(r as SnapshotRequestDbRow));
  },

  async getSnapshotReportArtifact(
    requestId: string
  ): Promise<SnapshotReportArtifact | null> {
    const { data, error } = await getClient()
      .from("snapshot_report_artifacts")
      .select("*")
      .eq("snapshot_request_id", requestId)
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) {
      throw error;
    }

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  async getSnapshotReportArtifactByPublicToken(
    publicToken: string
  ): Promise<SnapshotReportArtifact | null> {
    const { data, error } = await getClient()
      .from("snapshot_report_artifacts")
      .select("*")
      .eq("public_token", publicToken)
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) {
      throw error;
    }

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  async saveSnapshotReportArtifact(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact | null> {
    // Validates configuration and throws on any unsupported value. RPC is
    // the only supported mode, so there is nothing to branch on — this is
    // called for its validating side effect.
    snapshotReportWriteMode();

    // The SQL function owns the public token, refuses a delivered artifact,
    // and enforces manual ownership. No fallback — an error here is never
    // retried as direct DML.
    const { data, error } = await getClient()
      .rpc("save_snapshot_report_artifact_manual", {
        p_request_id: input.snapshotRequestId,
        p_project_id: input.projectId,
        p_full_markdown: input.fullReportMarkdown,
        p_short_markdown: input.shortReportMarkdown,
        p_full_filename: input.fullReportFilename,
        p_short_filename: input.shortReportFilename,
        p_generated_at: input.generatedAt,
      })
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  /* ---- migration 0035 delivery fencing --------------------------------- */
  //
  // Send and Replace race across an external email call that no row lock can
  // span. These four RPCs carry the exclusion instead: a persistent claim
  // reserves the artifact, returns the exact markdown it covers, and only a
  // matching token can finalize or release it.
  //
  // Errors propagate. A conflict here is a real state conflict — the caller
  // maps it to 409 and the founder refreshes; it is never retried against a
  // newer revision, and never falls back to direct DML.

  async replaceUndeliveredSnapshotReportArtifact(
    input: ReplaceUndeliveredSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifactRevision | null> {
    snapshotReportWriteMode();

    const { data, error } = await getClient()
      .rpc("replace_undelivered_snapshot_report_artifact", {
        p_snapshot_request_id: input.snapshotRequestId,
        p_expected_artifact_id: input.expectedArtifactId,
        p_expected_revision: input.expectedRevision,
        p_full_report_markdown: input.fullReportMarkdown,
        p_short_report_markdown: input.shortReportMarkdown,
      })
      .maybeSingle<{ artifact_id: string; revision: string }>();

    if (error) throw error;

    return data ? { artifactId: data.artifact_id, revision: data.revision } : null;
  },

  /**
   * Reserves a delivery and returns the markdown the claim covers.
   *
   * The caller must email exactly `shortReportMarkdown` from this result.
   * Re-reading the artifact afterwards would reopen the race this closes,
   * because a replacement could land between the read and the send.
   *
   * `deliveryClaimToken` is server-only and must never reach a browser.
   */
  async beginSnapshotReportDelivery(
    input: BeginSnapshotReportDeliveryInput
  ): Promise<BegunSnapshotReportDelivery | null> {
    snapshotReportWriteMode();

    const { data, error } = await getClient()
      .rpc("begin_snapshot_report_delivery", {
        p_snapshot_request_id: input.snapshotRequestId,
        p_expected_artifact_id: input.expectedArtifactId,
        p_expected_revision: input.expectedRevision,
      })
      .maybeSingle<{
        artifact_id: string;
        revision: string;
        delivery_claim_token: string;
        full_report_markdown: string;
        short_report_markdown: string;
      }>();

    if (error) throw error;

    return data
      ? {
          artifactId: data.artifact_id,
          revision: data.revision,
          deliveryClaimToken: data.delivery_claim_token,
          fullReportMarkdown: data.full_report_markdown,
          shortReportMarkdown: data.short_report_markdown,
        }
      : null;
  },

  /** The only path that may set `delivered_at` / `delivery_message_id`. */
  async finalizeSnapshotReportDelivery(
    input: FinalizeSnapshotReportDeliveryInput
  ): Promise<FinalizedSnapshotReportDelivery | null> {
    snapshotReportWriteMode();

    const { data, error } = await getClient()
      .rpc("finalize_snapshot_report_delivery", {
        p_snapshot_request_id: input.snapshotRequestId,
        p_artifact_id: input.artifactId,
        p_delivery_claim_token: input.deliveryClaimToken,
        p_delivery_message_id: input.deliveryMessageId,
      })
      .maybeSingle<{ artifact_id: string; delivered_at: string }>();

    if (error) throw error;

    return data
      ? { artifactId: data.artifact_id, deliveredAt: data.delivered_at }
      : null;
  },

  /**
   * Releases a claim.
   *
   * Only safe after a failure that provably reached no provider. An ambiguous
   * outcome must leave the claim in place — the provider may have accepted the
   * email before the process died, and releasing would permit a duplicate send.
   */
  async releaseSnapshotReportDeliveryClaim(
    input: ReleaseSnapshotReportDeliveryClaimInput
  ): Promise<{ artifactId: string } | null> {
    snapshotReportWriteMode();

    const { data, error } = await getClient()
      .rpc("release_snapshot_report_delivery_claim", {
        p_snapshot_request_id: input.snapshotRequestId,
        p_artifact_id: input.artifactId,
        p_delivery_claim_token: input.deliveryClaimToken,
      })
      .maybeSingle<{ artifact_id: string }>();

    if (error) throw error;

    return data ? { artifactId: data.artifact_id } : null;
  },

  async insertSnapshotReportArtifactBackfill(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact | null> {
    // Validates configuration and throws on any unsupported value.
    snapshotReportWriteMode();

    // Insert-only, and its SQL counterpart requires `report_ready` — the
    // opposite precondition to the normal save path, which is why this is
    // a separate method rather than a flag.
    const { data, error } = await getClient()
      .rpc("insert_snapshot_report_artifact_backfill", {
        p_request_id: input.snapshotRequestId,
        p_project_id: input.projectId,
        p_full_markdown: input.fullReportMarkdown,
        p_short_markdown: input.shortReportMarkdown,
        p_full_filename: input.fullReportFilename,
        p_short_filename: input.shortReportFilename,
        p_generated_at: input.generatedAt,
      })
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  async markSnapshotReportDelivered(
    requestId: string,
    messageId: string,
    deliveredAt: string,
    resend: boolean
  ): Promise<SnapshotReportArtifact | null> {
    // Validates configuration and throws on any unsupported value.
    snapshotReportWriteMode();

    // The SQL function enforces report_ready plus the initial-versus-resend
    // precondition and touches only bookkeeping — it never rewrites report
    // content and never reissues the public token.
    const { data, error } = await getClient()
      .rpc("mark_snapshot_report_delivered", {
        p_request_id: requestId,
        p_message_id: messageId,
        p_delivered_at: deliveredAt,
        p_resend: resend,
      })
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  async rejectSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "reject_snapshot_request",
        {
          p_request_id: requestId,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) {
      throw error;
    }

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async listSnapshotRequests(
    limit = 100
  ): Promise<SnapshotRequest[]> {
    const safeLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      200
    );

    const { data, error } = await getClient()
      .from("snapshot_requests")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(safeLimit)
      .returns<SnapshotRequestDbRow[]>();

    if (error) {
      throw error;
    }

    return (data || []).map(mapSnapshotRequest);
  },

  async createSnapshotRequest(
    input: CreateSnapshotRequestInput
  ): Promise<SnapshotRequest> {
    const { data, error } = await getClient()
      .rpc("create_snapshot_request_guarded", {
        p_work_email: input.workEmail,
        p_normalized_email: input.normalizedEmail,
        p_company_name: input.companyName,
        p_website_url: input.websiteUrl,
        p_normalized_domain: input.normalizedDomain,
        p_buyer_category: input.buyerCategory,
        p_request_ip_hash: input.requestIpHash ?? null,
        p_contact_name: input.contactName ?? null,
      })
      .single<SnapshotRequestDbRow>();

    if (error || !data) {
      const limitCode = snapshotLimitCodeFromError(error);

      if (limitCode) {
        throw new SnapshotRequestLimitError(limitCode);
      }

      throw error ?? new Error("createSnapshotRequest failed");
    }

    return mapSnapshotRequest(data);
  },

  async issueSnapshotRequestVerification(
    input: IssueSnapshotRequestVerificationInput
  ): Promise<boolean> {
    const { data, error } = await getClient().rpc(
      "issue_snapshot_request_verification",
      {
        p_request_id: input.requestId,
        p_token_hash: input.tokenHash,
        p_expires_at: input.expiresAt,
      }
    );

    if (error) throw error;

    return data === true;
  },

  async consumeSnapshotRequestVerification(
    tokenHash: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "consume_snapshot_request_verification",
        {
          p_token_hash: tokenHash,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data ? mapSnapshotRequest(data) : null;
  },

  async failSnapshotVerificationDelivery(
    requestId: string
  ): Promise<boolean> {
    const { data, error } = await getClient().rpc(
      "fail_snapshot_verification_delivery",
      {
        p_request_id: requestId,
      }
    );

    if (error) throw error;

    return data === true;
  },

  async approveAndQueueSnapshotRequest(
    requestId: string,
    approvedBy: string,
    competitors: string[]
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "approve_and_queue_snapshot_request",
        {
          p_request_id: requestId,
          p_approved_by: approvedBy,
          p_competitors: competitors,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async approveAndLaunchSnapshotBaseline(
    requestId: string,
    approvedBy: string,
    competitors: string[],
    promptHash: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "approve_and_launch_snapshot_baseline",
        {
          p_request_id: requestId,
          p_approved_by: approvedBy,
          p_competitors: competitors,
          p_prompt_hash: promptHash,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async reserveSnapshotRequestProject(
    requestId: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "reserve_snapshot_request_project",
        {
          p_request_id: requestId,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  // Server-only. The claim token never reaches browser code and is
  // never logged.
  async claimNextSnapshotRequest(input) {
    const { data, error } = await getClient()
      .rpc(
        "claim_next_snapshot_request",
        {
          p_worker_id: input.workerId,
          p_lease_seconds: input.leaseSeconds,
          p_max_attempts: input.maxAttempts,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async renewSnapshotRequestLease(input) {
    const { data, error } = await getClient()
      .rpc(
        "renew_snapshot_request_lease",
        {
          p_request_id: input.requestId,
          p_claim_token: input.claimToken,
          p_lease_seconds: input.leaseSeconds,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async updateSnapshotRequestProgressWorker(input) {
    const { data, error } = await getClient()
      .rpc(
        "update_snapshot_request_progress_worker",
        {
          p_request_id: input.requestId,
          p_project_id: input.projectId,
          p_claim_token: input.claimToken,
          p_progress_stage: input.stage,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    // Null means the SQL fence refused: wrong project, wrong token,
    // expired lease, or the request is no longer running. Never retried
    // and never downgraded to the manual RPC.
    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async completeSnapshotReportWorker(input) {
    const { data, error } = await getClient()
      .rpc(
        "complete_snapshot_report_worker",
        {
          p_request_id: input.requestId,
          p_project_id: input.projectId,
          p_claim_token: input.claimToken,
          p_full_markdown: input.fullReportMarkdown,
          p_short_markdown: input.shortReportMarkdown,
          p_full_filename: input.fullReportFilename,
          p_short_filename: input.shortReportFilename,
          p_generated_at: input.generatedAt,
        }
      )
      .maybeSingle<SnapshotReportArtifactDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotReportArtifact(data)
      : null;
  },

  async markSnapshotRequestFailedWorker(input) {
    const { data, error } = await getClient()
      .rpc(
        "mark_snapshot_request_failed_worker",
        {
          p_request_id: input.requestId,
          p_project_id: input.projectId,
          p_claim_token: input.claimToken,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async updateSnapshotRequestProgress(
    requestId,
    projectId,
    stage
  ) {
    const { data, error } = await getClient()
      .rpc(
        "update_snapshot_request_progress",
        {
          p_request_id: requestId,
          p_project_id: projectId,
          p_progress_stage: stage,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async finalizeSnapshotRequest(
    requestId,
    projectId,
    status
  ) {
    const { data, error } = await getClient()
      .rpc(
        "finalize_snapshot_request",
        {
          p_request_id: requestId,
          p_project_id: projectId,
          p_final_status: status,
        }
      )
      .maybeSingle<SnapshotRequestDbRow>();

    if (error) throw error;

    return data
      ? mapSnapshotRequest(data)
      : null;
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { data, error } = await getClient()
      .from("projects")
      .insert({
        user_id: input.userId ?? null,
        company_name: input.companyName ?? null,
        domain: input.domain,
      })
      .select("*")
      .single<ProjectRow>();
    if (error || !data) throw error ?? new Error("createProject failed");
    return mapProject(data);
  },

  async updateProjectCategory(projectId, category) {
    const { error } = await getClient()
      .from("projects")
      .update({ category })
      .eq("id", projectId);
    if (error) throw error;
  },

  async saveSitePages(projectId, pages) {
    if (pages.length === 0) return;
    const rows = pages.map((p) => ({
      project_id: projectId,
      url: p.url,
      title: p.title,
      content: p.content,
      page_type: p.pageType,
    }));
    const { error } = await getClient().from("site_pages").insert(rows);
    if (error) throw error;
  },

  async saveMirrorProfile(projectId, json) {
    const { data, error } = await getClient()
      .from("mirror_profiles")
      .insert({ project_id: projectId, json })
      .select("*")
      .single<MirrorProfileDbRow>();
    if (error || !data) throw error ?? new Error("saveMirrorProfile failed");
    return mapMirror(data);
  },

  async getProject(id) {
    const { data, error } = await getClient()
      .from("projects")
      .select("*")
      .eq("id", id)
      .maybeSingle<ProjectRow>();
    if (error) throw error;
    return data ? mapProject(data) : null;
  },

  async getSitePages(projectId) {
    const { data, error } = await getClient()
      .from("site_pages")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => mapSitePage(r as SitePageRow));
  },

  async getMirrorProfile(projectId) {
    const { data, error } = await getClient()
      .from("mirror_profiles")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<MirrorProfileDbRow>();
    if (error) throw error;
    return data ? mapMirror(data) : null;
  },

  async replaceGeneratedPrompts(
    projectId: string,
    prompts: GeneratedPromptInput[]
  ): Promise<GeneratedPrompt[]> {
    const client = getClient();
    const del = await client.from("generated_prompts").delete().eq("project_id", projectId);
    if (del.error) throw del.error;
    if (prompts.length === 0) return [];
    const rows = prompts.map((p) => ({
      project_id: projectId,
      prompt: p.prompt,
      intent_type: p.intentType,
      commercial_value: p.commercialValue,
      winnability: p.winnability,
      priority: p.priority,
      rationale: p.rationale,
      selected: p.selected,
    }));
    const { data, error } = await client
      .from("generated_prompts")
      .insert(rows)
      .select("*");
    if (error || !data) throw error ?? new Error("replaceGeneratedPrompts failed");
    return (data as GeneratedPromptDbRow[]).map(mapPrompt);
  },

  async getGeneratedPrompts(projectId: string): Promise<GeneratedPrompt[]> {
    const { data, error } = await getClient()
      .from("generated_prompts")
      .select("*")
      .eq("project_id", projectId)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => mapPrompt(r as GeneratedPromptDbRow));
  },

  async getGeneratedPrompt(id: string): Promise<GeneratedPrompt | null> {
    const { data, error } = await getClient()
      .from("generated_prompts")
      .select("*")
      .eq("id", id)
      .maybeSingle<GeneratedPromptDbRow>();
    if (error) throw error;
    return data ? mapPrompt(data) : null;
  },

  // M2 canonical observations contract, third tranche (runtime writer
  // hardening) — this adapter is what actually reaches a real
  // database, so it is the enforcement point: a missing
  // datasetIdentity throws immediately, before any network call, so a
  // production writer can never insert a probe_runs row with a NULL
  // dataset_id/dataset_source_type. The in-memory adapter stays
  // permissive for tests that do not exercise this dimension.
  async createProbeRun(
    projectId: string,
    platform: string,
    probeMode: ProbeMode,
    status: ProbeRunStatus = "pending",
    datasetIdentity?: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<ProbeRun> {
    if (!datasetIdentity?.datasetId || !datasetIdentity?.datasetSourceType) {
      throw new Error(
        "createProbeRun (supabase adapter): datasetIdentity (datasetId and datasetSourceType) is required. This adapter never inserts a probe_runs row with a null dataset identity — resolve or create a dataset_batches row before calling createProbeRun."
      );
    }
    const { data, error } = await getClient()
      .from("probe_runs")
      .insert({
        project_id: projectId,
        platform,
        status,
        probe_mode: probeMode,
        dataset_id: datasetIdentity.datasetId,
        dataset_source_type: datasetIdentity.datasetSourceType,
      })
      .select("*")
      .single<ProbeRunDbRow>();
    if (error || !data) throw error ?? new Error("createProbeRun failed");
    return mapProbeRun(data);
  },

  async updateProbeRunStatus(id: string, status: ProbeRunStatus): Promise<void> {
    const { error } = await getClient()
      .from("probe_runs")
      .update({ status })
      .eq("id", id);
    if (error) throw error;
  },

  async getProbeRunsByProject(projectId: string): Promise<ProbeRun[]> {
    const { data, error } = await getClient()
      .from("probe_runs")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapProbeRun(r as ProbeRunDbRow));
  },

  async saveProbeResult(input: SaveProbeResultInput): Promise<ProbeResult> {
    const { data, error } = await getClient()
      .from("probe_results")
      .insert({
        probe_run_id: input.probeRunId,
        project_id: input.projectId,
        generated_prompt_id: input.generatedPromptId ?? null,
        prompt: input.prompt,
        platform: input.platform,
        probe_mode: input.probeMode,
        raw_response: input.rawResponse,
        raw_probe_request: input.rawProbeRequest ?? "",
        product_mentioned: input.productMentioned ?? input.clientMentioned,
        product_position: input.productPosition ?? input.clientPosition,
        product_verdict: input.productVerdict ?? input.verdict,
        cited_as_source: input.citedAsSource ?? false,
        client_source_count: input.clientSourceCount ?? 0,
        platforms_referenced: input.platformsReferenced ?? [],
        client_mentioned: input.clientMentioned,
        client_position: input.clientPosition,
        competitors_mentioned: input.competitorsMentioned,
        sources_cited: input.sourcesCited,
        answer_summary: input.answerSummary,
        verdict: input.verdict,
        why_client_lost: input.whyClientLost,
        raw_response_sha256: input.rawResponseSha256 ?? null,
        raw_response_body: input.rawResponseBody ?? null,
        raw_response_body_sha256: input.rawResponseBodySha256 ?? null,
        raw_probe_request_sha256: input.rawProbeRequestSha256 ?? null,
        full_request_body: input.fullRequestBody ?? null,
        full_request_body_sha256: input.fullRequestBodySha256 ?? null,
        provider_http_status: input.providerHttpStatus ?? null,
        provider_latency_ms: input.providerLatencyMs ?? null,
        provider_request_id: input.providerRequestId ?? null,
        provider_model: input.providerModel ?? null,
        retry_count: input.retryCount ?? 0,
        snapshot_request_id: input.snapshotRequestId ?? null,
        dataset_id: input.datasetId ?? null,
        dataset_source_type: input.datasetSourceType ?? null,
        run_position: input.runPosition ?? null,
        negative_claim_detected: input.negativeClaimDetected ?? null,
        observation_schema_version: input.observationSchemaVersion ?? null,
      })
      .select("*")
      .single<ProbeResultDbRow>();
    if (error || !data) throw error ?? new Error("saveProbeResult failed");
    return mapProbeResult(data);
  },

  async getProbeResultsByProject(projectId: string): Promise<ProbeResult[]> {
    const { data, error } = await getClient()
      .from("probe_results")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapProbeResult(r as ProbeResultDbRow));
  },

  async getLostProbeResultsByProject(projectId: string): Promise<ProbeResult[]> {
    const { data, error } = await getClient()
      .from("probe_results")
      .select("*")
      .eq("project_id", projectId)
      .in("verdict", ["lost", "partial"])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapProbeResult(r as ProbeResultDbRow));
  },

  async recordAnalysisLlmCall(
    input: AnalysisLlmCallInput
  ): Promise<AnalysisLlmCall> {
    const { data, error } = await getClient()
      .from("analysis_llm_calls")
      .insert({
        project_id: input.projectId,
        stage: input.stage,
        provider: input.provider,
        model: input.model,
        used_mock: input.usedMock,
        used_retry: input.usedRetry,
        latency_ms: input.latencyMs,
        request_sha256: input.requestSha256 ?? null,
        response_sha256: input.responseSha256 ?? null,
      })
      .select("*")
      .single<AnalysisLlmCallDbRow>();
    if (error || !data) throw error ?? new Error("recordAnalysisLlmCall failed");
    return mapAnalysisLlmCall(data);
  },

  async getAnalysisLlmCallsByProject(
    projectId: string
  ): Promise<AnalysisLlmCall[]> {
    const { data, error } = await getClient()
      .from("analysis_llm_calls")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapAnalysisLlmCall(r as AnalysisLlmCallDbRow));
  },

  async recordProbeFailure(
    input: RecordProbeFailureInput
  ): Promise<ProbeFailure> {
    const { data, error } = await getClient()
      .from("probe_failures")
      .insert({
        probe_run_id: input.probeRunId ?? null,
        project_id: input.projectId,
        platform: input.platform,
        prompt: input.prompt,
        failure_reason: input.failureReason,
        provider_http_status: input.providerHttpStatus ?? null,
        provider_error_body: input.providerErrorBody ?? null,
        provider_error_body_sha256: input.providerErrorBodySha256 ?? null,
        provider_latency_ms: input.providerLatencyMs ?? null,
        provider_request_id: input.providerRequestId ?? null,
        raw_probe_request_sha256: input.rawProbeRequestSha256 ?? null,
        full_request_body: input.fullRequestBody ?? null,
        full_request_body_sha256: input.fullRequestBodySha256 ?? null,
        retry_count: input.retryCount ?? 0,
      })
      .select("*")
      .single<ProbeFailureDbRow>();
    if (error || !data) throw error ?? new Error("recordProbeFailure failed");
    return mapProbeFailure(data);
  },

  async getProbeFailuresByProject(
    projectId: string
  ): Promise<ProbeFailure[]> {
    const { data, error } = await getClient()
      .from("probe_failures")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapProbeFailure(r as ProbeFailureDbRow));
  },

  // M2 canonical observations contract, first tranche (D-014) — dataset
  // identity. No caller creates a row yet; the composite CHECK and the
  // backfill_key uniqueness are enforced by the database, not here.
  async createDatasetBatch(input: DatasetBatchInput): Promise<DatasetBatch> {
    const { data, error } = await getClient()
      .from("dataset_batches")
      .insert({
        project_id: input.projectId,
        dataset_source_type: input.datasetSourceType,
        snapshot_request_id: input.snapshotRequestId ?? null,
        backfill_key: input.backfillKey ?? null,
        note: input.note ?? null,
      })
      .select("*")
      .single<DatasetBatchDbRow>();
    if (error || !data) throw error ?? new Error("createDatasetBatch failed");
    return mapDatasetBatch(data);
  },

  async getDatasetBatchesByProject(projectId: string): Promise<DatasetBatch[]> {
    const { data, error } = await getClient()
      .from("dataset_batches")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapDatasetBatch(r as DatasetBatchDbRow));
  },

  // M2 canonical observations contract, first tranche (D-014) — entity
  // resolution. No caller populates these yet.
  async createCanonicalEntity(
    input: CanonicalEntityInput
  ): Promise<CanonicalEntity> {
    const { data, error } = await getClient()
      .from("canonical_entities")
      .insert({
        project_id: input.projectId,
        entity_type: input.entityType,
        resolver_version: input.resolverVersion,
      })
      .select("*")
      .single<CanonicalEntityDbRow>();
    if (error || !data) throw error ?? new Error("createCanonicalEntity failed");
    return mapCanonicalEntity(data);
  },

  async getCanonicalEntitiesByProject(
    projectId: string
  ): Promise<CanonicalEntity[]> {
    const { data, error } = await getClient()
      .from("canonical_entities")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapCanonicalEntity(r as CanonicalEntityDbRow));
  },

  async getEntityAliasesByProject(projectId: string): Promise<EntityAlias[]> {
    const { data, error } = await getClient()
      .from("entity_aliases")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapEntityAlias(r as EntityAliasDbRow));
  },

  // M2 canonical observations contract, third tranche (D-017, D-018,
  // D-019). Thin wrappers only — all business logic (preconditions,
  // locking, generation comparison, brand-self exclusion) lives in the
  // SECURITY DEFINER RPCs themselves (migration 0042), never
  // reimplemented here.
  async startOrResumeEntityResolutionPass(
    input: StartOrResumeEntityResolutionPassInput
  ): Promise<StartOrResumeEntityResolutionPassResult> {
    const { data, error } = await getClient().rpc(
      "start_or_resume_entity_resolution_pass",
      {
        p_project_id: input.projectId,
        p_probe_result_id: input.probeResultId,
        p_resolver_version: input.resolverVersion,
        p_dataset_id: input.datasetId,
        p_expected_mention_count: input.expectedMentionCount,
        p_company_name: input.companyName,
        p_domain: input.domain,
        p_normalized_brand_terms: input.normalizedBrandTerms,
        p_mirror_aliases: input.mirrorAliases ?? [],
        // Omitted entirely when unset, so Postgres applies the
        // function's own default ('15 minutes') rather than this
        // adapter reimplementing that default.
        ...(input.staleAfterSeconds != null
          ? { p_stale_after: `${input.staleAfterSeconds} seconds` }
          : {}),
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "startOrResumeEntityResolutionPass: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      resolutionPassId: row.resolution_pass_id as string,
      passStatus: row.pass_status as EntityResolutionPassStatus,
      passOutcome: row.pass_outcome as EntityResolutionPassOutcome,
    };
  },

  async resolveAndRecordEntityObservation(
    input: ResolveAndRecordEntityObservationInput
  ): Promise<ResolveAndRecordEntityObservationResult> {
    const { data, error } = await getClient().rpc(
      "resolve_and_record_entity_observation",
      {
        p_resolution_pass_id: input.resolutionPassId,
        p_mention_ordinal: input.mentionOrdinal,
        p_raw_text: input.rawText,
        p_normalized_text: input.normalizedText,
        p_status: input.status,
        p_proposed_entity_type: input.proposedEntityType ?? null,
        p_context: input.context ?? null,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "resolveAndRecordEntityObservation: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      observationId: row.observation_id as string,
      observationGeneration: row.observation_generation as number,
      observationOutcome: row.observation_outcome as EntityObservationOutcome,
      aliasId: (row.alias_id as string | null) ?? null,
      aliasGeneration: (row.alias_generation as number | null) ?? null,
      aliasOutcome: row.alias_outcome as EntityAliasOutcome,
      passStatus: row.pass_status as EntityResolutionPassStatus,
    };
  },

  // Active-head readers — query the views, never the base tables, for
  // "what does this currently mean" (D-017).
  async getEntityAliasesActiveByProject(projectId: string): Promise<EntityAlias[]> {
    const { data, error } = await getClient()
      .from("entity_aliases_active")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapEntityAlias(r as EntityAliasDbRow));
  },

  async getEntityObservationsActiveByProbeResult(
    probeResultId: string
  ): Promise<EntityObservation[]> {
    const { data, error } = await getClient()
      .from("entity_observations_active")
      .select("*")
      .eq("probe_result_id", probeResultId)
      .order("mention_ordinal", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) =>
      mapEntityObservation(r as EntityObservationDbRow)
    );
  },

  // M2 canonical observations contract, second tranche — probe_runs was
  // never append-only restricted; a plain UPDATE is correct here.
  async updateProbeRunDatasetIdentity(
    id: string,
    input: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<void> {
    const { error } = await getClient()
      .from("probe_runs")
      .update({
        dataset_id: input.datasetId,
        dataset_source_type: input.datasetSourceType,
      })
      .eq("id", id);
    if (error) throw error;
  },

  // M2 canonical observations contract, second tranche (D-015) — calls
  // the SECURITY DEFINER RPC. Never a direct UPDATE on probe_results,
  // which has had UPDATE revoked from service_role since migration 0036.
  async backfillProbeResultDatasetIdentity(
    input: BackfillProbeResultDatasetIdentityInput
  ): Promise<BackfillProbeResultDatasetIdentityResult> {
    const { data, error } = await getClient().rpc(
      "backfill_probe_result_dataset_identity",
      {
        p_probe_result_id: input.probeResultId,
        p_project_id: input.projectId,
        p_dataset_id: input.datasetId,
        p_dataset_source_type: input.datasetSourceType,
        p_run_position: input.runPosition ?? null,
        p_negative_claim_detected: input.negativeClaimDetected ?? null,
        p_observation_schema_version: input.observationSchemaVersion ?? null,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "backfillProbeResultDatasetIdentity: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      status: row.status as BackfillProbeResultDatasetIdentityStatus,
      probeResult: row.probe_result
        ? mapProbeResult(row.probe_result as ProbeResultDbRow)
        : null,
    };
  },

  async replaceCompetitorsForProject(
    projectId: string,
    competitors: CompetitorInput[]
  ): Promise<Competitor[]> {
    // M3 — incident fix (2026-08-20): this used to be a DELETE call
    // followed by a separate INSERT call — two independent Supabase
    // requests, not one transaction. The DELETE committed, the INSERT
    // then failed a CHECK constraint (canonical_entity_type had not
    // been sent), and the project's existing competitors rows were
    // left deleted with nothing to replace them.
    //
    // replace_competitors_for_project (migration 0046) does the
    // delete, the insert, and the read-back inside one PL/pgSQL
    // function body — one implicit transaction. A single .rpc() call,
    // never two separate table operations.
    const payload = buildCompetitorsRpcPayload(competitors);
    const { data, error } = await getClient().rpc(
      "replace_competitors_for_project",
      {
        p_project_id: projectId,
        p_competitors: payload,
      }
    );
    if (error) throw error;
    return ((data ?? []) as CompetitorDbRow[]).map(mapCompetitor);
  },

  async getCompetitorsByProject(projectId: string): Promise<Competitor[]> {
    const { data, error } = await getClient()
      .from("competitors")
      .select("*")
      .eq("project_id", projectId)
      .order("threat_level", { ascending: true }) // 'high' < 'low' alphabetically; we resort in app
      .order("mention_count", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapCompetitor(r as CompetitorDbRow));
  },

  async saveGapMap(projectId: string, gapMapJson: unknown): Promise<GapMapRow> {
    const { data, error } = await getClient()
      .from("gap_maps")
      .insert({ project_id: projectId, json: gapMapJson })
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("saveGapMap failed");
    return mapGapMap(data as GapMapDbRow);
  },

  async getLatestGapMap(projectId: string): Promise<GapMapRow | null> {
    const { data, error } = await getClient()
      .from("gap_maps")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    return row ? mapGapMap(row as GapMapDbRow) : null;
  },

  async replaceGapsForProject(
    projectId: string,
    gaps: GapInput[]
  ): Promise<Gap[]> {
    const client = getClient();
    const del = await client.from("gaps").delete().eq("project_id", projectId);
    if (del.error) throw del.error;
    if (gaps.length === 0) return [];
    const rows = gaps.map((g) => ({
      project_id: projectId,
      competitor_name: g.competitorName,
      type: g.type,
      severity: g.severity,
      explanation: g.explanation,
      affected_prompts: g.affectedPrompts,
      suggested_fix_direction: g.suggestedFixDirection,
    }));
    const { data, error } = await client.from("gaps").insert(rows).select("*");
    if (error || !data)
      throw error ?? new Error("replaceGapsForProject failed");
    return (data as GapDbRow[]).map(mapGap);
  },

  async getGapsByProject(projectId: string): Promise<Gap[]> {
    const { data, error } = await getClient()
      .from("gaps")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapGap(r as GapDbRow));
  },

  async upsertEvidenceBank(
    projectId: string,
    input: EvidenceBankRowInput
  ): Promise<EvidenceBankRow> {
    const client = getClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await client
      .from("evidence_banks")
      .upsert(
        {
          project_id: projectId,
          product_description: input.productDescription,
          target_audience: input.targetAudience,
          main_use_cases: input.mainUseCases,
          features: input.features,
          proof_items: input.proofItems,
          competitors: input.competitors,
          allowed_claims: input.allowedClaims,
          forbidden_claims: input.forbiddenClaims,
          tone: input.tone,
          notes: input.notes,
          provenance: input.provenance,
          updated_at: nowIso,
        },
        { onConflict: "project_id" }
      )
      .select("*")
      .single();
    if (error || !data) throw error ?? new Error("upsertEvidenceBank failed");
    return mapEvidenceBank(data as EvidenceBankDbRow);
  },

  async getEvidenceBankByProject(
    projectId: string
  ): Promise<EvidenceBankRow | null> {
    const { data, error } = await getClient()
      .from("evidence_banks")
      .select("*")
      .eq("project_id", projectId)
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    return row ? mapEvidenceBank(row as EvidenceBankDbRow) : null;
  },

  async saveFixBrief(
    projectId: string,
    input: FixBriefRowInput
  ): Promise<FixBriefRow> {
    const { data, error } = await getClient()
      .from("fix_briefs")
      .insert({
        project_id: projectId,
        gap_id: input.gapId,
        probe_result_id: input.probeResultId,
        lost_prompt: input.lostPrompt,
        competitor_recommended: input.competitorRecommended,
        root_cause: input.rootCause,
        recommended_fix: input.recommendedFix,
        fix_type: input.fixType,
        assets_to_generate: input.assetsToGenerate,
        evidence_needed: input.evidenceNeeded,
        evidence_available: input.evidenceAvailable,
        priority: input.priority,
        expected_impact: input.expectedImpact,
        status: input.status,
      })
      .select("*")
      .single<FixBriefDbRow>();
    if (error || !data) throw error ?? new Error("saveFixBrief failed");
    return mapFixBrief(data);
  },

  async getFixBriefsByProject(projectId: string): Promise<FixBriefRow[]> {
    const { data, error } = await getClient()
      .from("fix_briefs")
      .select("*")
      .eq("project_id", projectId)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapFixBrief(r as FixBriefDbRow));
  },

  async getFixBrief(id: string): Promise<FixBriefRow | null> {
    const { data, error } = await getClient()
      .from("fix_briefs")
      .select("*")
      .eq("id", id)
      .maybeSingle<FixBriefDbRow>();
    if (error) throw error;
    return data ? mapFixBrief(data) : null;
  },

  async updateFixBriefStatus(
    fixBriefId: string,
    status: string
  ): Promise<FixBriefRow | null> {
    const { data, error } = await getClient()
      .from("fix_briefs")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", fixBriefId)
      .select("*")
      .maybeSingle<FixBriefDbRow>();
    if (error) throw error;
    return data ? mapFixBrief(data) : null;
  },

  async saveGeneratedAsset(
    projectId: string,
    input: GeneratedAssetRowInput
  ): Promise<GeneratedAssetRow> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .insert({
        project_id: projectId,
        fix_brief_id: input.fixBriefId,
        asset_type: input.assetType,
        title: input.title,
        content: input.content,
        placeholders: input.placeholders,
        claims_used: input.claimsUsed,
        qa_status: input.qaStatus,
        lifecycle_status: input.lifecycleStatus ?? "active",
        generation_provider: input.generationProvider,
        generation_model: input.generationModel,
      })
      .select("*")
      .single<GeneratedAssetDbRow>();
    if (error || !data) throw error ?? new Error("saveGeneratedAsset failed");
    return mapGeneratedAsset(data);
  },

  async getGeneratedAssetsByProject(
    projectId: string
  ): Promise<GeneratedAssetRow[]> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapGeneratedAsset(r as GeneratedAssetDbRow));
  },

  async getGeneratedAssetsByFixBrief(
    fixBriefId: string
  ): Promise<GeneratedAssetRow[]> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .select("*")
      .eq("fix_brief_id", fixBriefId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapGeneratedAsset(r as GeneratedAssetDbRow));
  },

  async getGeneratedAsset(id: string): Promise<GeneratedAssetRow | null> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .select("*")
      .eq("id", id)
      .maybeSingle<GeneratedAssetDbRow>();
    if (error) throw error;
    return data ? mapGeneratedAsset(data) : null;
  },

  async updateGeneratedAssetQaStatus(
    assetId: string,
    qaStatus: string
  ): Promise<GeneratedAssetRow | null> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .update({ qa_status: qaStatus, updated_at: new Date().toISOString() })
      .eq("id", assetId)
      .select("*")
      .maybeSingle<GeneratedAssetDbRow>();
    if (error) throw error;
    return data ? mapGeneratedAsset(data) : null;
  },

  async updateGeneratedAssetLifecycleStatus(
    assetId: string,
    lifecycleStatus: GeneratedAssetLifecycleStatus
  ): Promise<GeneratedAssetRow | null> {
    const { data, error } = await getClient()
      .from("generated_assets")
      .update({ lifecycle_status: lifecycleStatus, updated_at: new Date().toISOString() })
      .eq("id", assetId)
      .select("*")
      .maybeSingle<GeneratedAssetDbRow>();
    if (error) throw error;
    return data ? mapGeneratedAsset(data) : null;
  },

  async saveQaReport(
    projectId: string,
    input: QaReportRowInput
  ): Promise<QaReportRow> {
    const { data, error } = await getClient()
      .from("qa_reports")
      .insert({
        project_id: projectId,
        generated_asset_id: input.generatedAssetId,
        verdict: input.verdict,
        violations: input.violations,
        placeholders_remaining: input.placeholdersRemaining,
        overall_notes: input.overallNotes,
      })
      .select("*")
      .single<QaReportDbRow>();
    if (error || !data) throw error ?? new Error("saveQaReport failed");
    return mapQaReport(data);
  },

  async getQaReportsByProject(projectId: string): Promise<QaReportRow[]> {
    const { data, error } = await getClient()
      .from("qa_reports")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapQaReport(r as QaReportDbRow));
  },

  async getQaReportsByGeneratedAsset(
    generatedAssetId: string
  ): Promise<QaReportRow[]> {
    const { data, error } = await getClient()
      .from("qa_reports")
      .select("*")
      .eq("generated_asset_id", generatedAssetId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => mapQaReport(r as QaReportDbRow));
  },

  async getLatestQaReportForAsset(
    generatedAssetId: string
  ): Promise<QaReportRow | null> {
    const { data, error } = await getClient()
      .from("qa_reports")
      .select("*")
      .eq("generated_asset_id", generatedAssetId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    return row ? mapQaReport(row as QaReportDbRow) : null;
  },

  // M4 — buyer question identity, protocol, and paid-attempt ledger
  // (migration 0047, draft — not yet applied to any database; these
  // methods are written for interface completeness and are exercised
  // only against the in-memory adapter until the migration is applied
  // and staging-verified).

  async createBuyerQuestion(
    input: CreateBuyerQuestionInput
  ): Promise<BuyerQuestion> {
    const { data, error } = await getClient()
      .from("buyer_questions")
      .insert({ project_id: input.projectId })
      .select("*")
      .single<BuyerQuestionDbRow>();
    if (error || !data) throw error ?? new Error("createBuyerQuestion failed");
    return mapBuyerQuestion(data);
  },

  async getBuyerQuestion(
    id: string,
    projectId: string
  ): Promise<BuyerQuestion | null> {
    const { data, error } = await getClient()
      .from("buyer_questions")
      .select("*")
      .eq("id", id)
      .eq("project_id", projectId)
      .maybeSingle<BuyerQuestionDbRow>();
    if (error) throw error;
    return data ? mapBuyerQuestion(data) : null;
  },

  async createBuyerQuestionVersion(
    input: CreateBuyerQuestionVersionInput
  ): Promise<BuyerQuestionVersion> {
    // Shared contract, enforced identically by the memory adapter —
    // checked first, before any network call, so an invalid input
    // never reaches Postgres (and never leaves an earlier, unrelated
    // write — e.g. dataset_batches/buyer_questions — as an orphan).
    validateBuyerQuestionVersionNumericFields(input);

    const { data, error } = await getClient()
      .from("buyer_question_versions")
      .insert({
        buyer_question_id: input.buyerQuestionId,
        project_id: input.projectId,
        version_number: input.versionNumber,
        prompt_text: input.promptText,
        prompt_hash: input.promptHash,
        intent_type: input.intentType,
        commercial_value: input.commercialValue,
        winnability: input.winnability,
        priority: input.priority,
        rationale: input.rationale,
        provenance: input.provenance,
      })
      .select("*")
      .single<BuyerQuestionVersionDbRow>();
    if (error || !data)
      throw error ?? new Error("createBuyerQuestionVersion failed");
    return mapBuyerQuestionVersion(data);
  },

  async getBuyerQuestionVersionsByQuestion(
    buyerQuestionId: string,
    projectId: string
  ): Promise<BuyerQuestionVersion[]> {
    const { data, error } = await getClient()
      .from("buyer_question_versions")
      .select("*")
      .eq("buyer_question_id", buyerQuestionId)
      .eq("project_id", projectId)
      .order("version_number", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) =>
      mapBuyerQuestionVersion(r as BuyerQuestionVersionDbRow)
    );
  },

  async getBuyerQuestionVersion(
    id: string,
    projectId: string
  ): Promise<BuyerQuestionVersion | null> {
    const { data, error } = await getClient()
      .from("buyer_question_versions")
      .select("*")
      .eq("id", id)
      .eq("project_id", projectId)
      .maybeSingle<BuyerQuestionVersionDbRow>();
    if (error) throw error;
    return data ? mapBuyerQuestionVersion(data) : null;
  },

  async approveBuyerQuestionVersion(
    input: ApproveBuyerQuestionVersionInput
  ): Promise<ApproveBuyerQuestionVersionResult> {
    // Shared contract, enforced identically by the memory adapter —
    // checked first, before any network call.
    validateApprovedByUuid(input.approvedBy);

    const { data, error } = await getClient().rpc(
      "approve_buyer_question_version",
      {
        p_version_id: input.versionId,
        p_project_id: input.projectId,
        p_approved_by: input.approvedBy,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "approveBuyerQuestionVersion: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      version: row.version ? mapBuyerQuestionVersion(row.version) : null,
    };
  },

  async createProtocol(input: CreateProtocolInput): Promise<Protocol> {
    const { data, error } = await getClient()
      .from("protocols")
      .insert({
        project_id: input.projectId,
        buyer_question_version_id: input.buyerQuestionVersionId,
        baseline_protocol_id: input.baselineProtocolId ?? null,
        provider: input.provider,
        surface: input.surface,
        model_config: input.modelConfig ?? {},
        planned_baseline_runs: input.plannedBaselineRuns,
        planned_retest_runs: input.plannedRetestRuns,
        paraphrase_plan: input.paraphrasePlan ?? [],
        unit_of_analysis: input.unitOfAnalysis,
        primary_metric: input.primaryMetric,
        minimum_useful_change: input.minimumUsefulChange ?? null,
        sample_planning_method: input.samplePlanningMethod,
        sample_planning_assumptions: input.samplePlanningAssumptions ?? {},
        run_cap: input.runCap,
        spend_cap_usd: input.spendCapUsd,
        time_window_seconds: input.timeWindowSeconds,
        rate_limit_per_hour: input.rateLimitPerHour,
        concurrency_limit: input.concurrencyLimit,
        retry_cap: input.retryCap,
        observation_window_rule: input.observationWindowRule ?? {},
        analyzer_version: input.analyzerVersion ?? 1,
        entity_resolution_version: input.entityResolutionVersion ?? 2,
        methodology_version: input.methodologyVersion ?? "1.1",
      })
      .select("*")
      .single<ProtocolDbRow>();
    if (error || !data) throw error ?? new Error("createProtocol failed");
    return mapProtocol(data);
  },

  async getProtocol(id: string, projectId: string): Promise<Protocol | null> {
    const { data, error } = await getClient()
      .from("protocols")
      .select("*")
      .eq("id", id)
      .eq("project_id", projectId)
      .maybeSingle<ProtocolDbRow>();
    if (error) throw error;
    return data ? mapProtocol(data) : null;
  },

  async approveProtocol(
    input: ApproveProtocolInput
  ): Promise<ApproveProtocolResult> {
    // Shared contract, enforced identically by the memory adapter —
    // checked first, before any network call.
    validateApprovedByUuid(input.approvedBy);

    const { data, error } = await getClient().rpc("approve_protocol", {
      p_protocol_id: input.protocolId,
      p_project_id: input.projectId,
      p_approved_by: input.approvedBy,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "approveProtocol: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      protocol: row.protocol ? mapProtocol(row.protocol) : null,
    };
  },

  async admitAndReserveAttempt(
    input: AdmitAndReserveAttemptInput
  ): Promise<AdmitAndReserveAttemptResult> {
    const { data, error } = await getClient().rpc(
      "admit_and_reserve_attempt",
      {
        p_protocol_id: input.protocolId,
        p_project_id: input.projectId,
        p_attempt_kind: input.attemptKind,
        p_idempotency_key: input.idempotencyKey,
        p_estimated_cost_usd: input.estimatedCostUsd,
        p_retry_of_attempt_id: input.retryOfAttemptId ?? null,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "admitAndReserveAttempt: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: row.attempt ? mapProtocolAttempt(row.attempt) : null,
    };
  },

  async startAttempt(input: StartAttemptInput): Promise<StartAttemptResult> {
    const { data, error } = await getClient().rpc("start_attempt", {
      p_attempt_id: input.attemptId,
      p_project_id: input.projectId,
      p_probe_run_id: input.probeRunId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "startAttempt: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: row.attempt ? mapProtocolAttempt(row.attempt) : null,
    };
  },

  async reconcileAttempt(
    input: ReconcileAttemptInput
  ): Promise<ReconcileAttemptResult> {
    const { data, error } = await getClient().rpc("reconcile_attempt", {
      p_attempt_id: input.attemptId,
      p_project_id: input.projectId,
      p_status: input.status,
      p_actual_cost_usd: input.actualCostUsd,
      p_probe_run_id: input.probeRunId ?? null,
      p_termination_reason: input.terminationReason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "reconcileAttempt: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: row.attempt ? mapProtocolAttempt(row.attempt) : null,
    };
  },

  async getProtocolAttempts(
    protocolId: string,
    projectId: string
  ): Promise<ProtocolAttempt[]> {
    const { data, error } = await getClient()
      .from("protocol_attempts")
      .select("*")
      .eq("protocol_id", protocolId)
      .eq("project_id", projectId)
      .order("reserved_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => mapProtocolAttempt(r as ProtocolAttemptDbRow));
  },

  // ------------------------------------------------------------------------
  // M5-2 Stage A. Every method below calls exactly one RPC (0050/0051) —
  // never a direct .from(...) read or write against protocol_execution_jobs,
  // protocol_external_calls, provider_call_receipts, analysis_call_receipts,
  // or protocol_operator_actions. start_attempt_for_job and
  // reserve_additional_analysis_generation_for_job are deliberately not
  // wrapped here (D-023 §1).
  // ------------------------------------------------------------------------

  async enqueueProtocolExecutionJob(
    input: EnqueueProtocolExecutionJobInput
  ): Promise<EnqueueProtocolExecutionJobResult> {
    const { data, error } = await getClient().rpc("enqueue_protocol_execution_job", {
      p_protocol_id: input.protocolId,
      p_project_id: input.projectId,
      p_max_attempts: input.maxAttempts ?? 3,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "enqueueProtocolExecutionJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async claimProtocolExecutionJob(
    input: ClaimProtocolExecutionJobInput
  ): Promise<ClaimProtocolExecutionJobResult> {
    const { data, error } = await getClient().rpc("claim_protocol_execution_job", {
      p_worker_id: input.workerId,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "claimProtocolExecutionJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
      claimToken: row.claim_token ?? null,
    };
  },

  /**
   * D-031 — the targeted claim. Exactly one RPC, four parameters, and a
   * reply that is closed structurally before any of it is believed.
   *
   * The outcome is read from `row.outcome`, never from `row.status`: the
   * returned row also carries the job's own `status` column, and confusing
   * the two would let a job status be mistaken for a claim outcome. 0059
   * names the column `outcome` for exactly that reason.
   *
   * Every rejection raises the same closed, value-free error. A malformed
   * reply must not become a side channel for an identifier, a token or any
   * other value the server sent: what is rejected is never echoed. Absence
   * is likewise never silently promoted to `null` — a missing `job` or
   * `claim_token` property is a malformed reply, not a null payload.
   */
  async claimProtocolExecutionJobById(
    input: ClaimProtocolExecutionJobByIdInput
  ): Promise<ClaimProtocolExecutionJobByIdResult> {
    const { data, error } = await getClient().rpc("claim_protocol_execution_job_by_id", {
      p_worker_id: input.workerId,
      p_lease_seconds: input.leaseSeconds,
      p_job_id: input.jobId,
      p_project_id: input.projectId,
    });
    if (error) throw error;

    const REJECT =
      "claimProtocolExecutionJobById: the RPC reply did not satisfy the closed D-031 contract.";

    const rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
    if (rows.length !== 1) throw new Error(REJECT);

    const row: unknown = rows[0];
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error(REJECT);
    const reply = row as Record<string, unknown>;

    // Own properties, present. `undefined` is absence, and absence is not null.
    for (const key of ["outcome", "job", "claim_token"] as const) {
      if (!Object.prototype.hasOwnProperty.call(reply, key)) throw new Error(REJECT);
      if (reply[key] === undefined) throw new Error(REJECT);
    }

    const outcome = reply.outcome;
    if (
      outcome !== "CLAIMED"
      && outcome !== "JOB_NOT_FOUND"
      && outcome !== "JOB_NOT_ELIGIBLE"
      && outcome !== "JOB_LOCKED"
    ) {
      throw new Error(REJECT);
    }

    const rawJob = reply.job;
    if (rawJob !== null && (typeof rawJob !== "object" || Array.isArray(rawJob))) {
      throw new Error(REJECT);
    }
    const rawToken = reply.claim_token;
    if (rawToken !== null && (typeof rawToken !== "string" || rawToken.length === 0)) {
      throw new Error(REJECT);
    }

    if (outcome !== "CLAIMED") {
      if (rawJob !== null || rawToken !== null) throw new Error(REJECT);
      return { outcome, job: null, claimToken: null };
    }

    if (rawJob === null || rawToken === null) throw new Error(REJECT);
    const job = mapProtocolExecutionJobNullable(rawJob as ProtocolExecutionJobDbRow);
    if (job === null) throw new Error(REJECT);
    const claimToken: string = rawToken;

    const leaseIsValidDate =
      typeof job.leaseExpiresAt === "string"
      && job.leaseExpiresAt.length > 0
      && Number.isFinite(Date.parse(job.leaseExpiresAt));

    if (
      job.id !== input.jobId
      || job.projectId !== input.projectId
      || job.status !== "claimed"
      || job.workerId !== input.workerId
      || job.attemptCount !== 1
      || job.maxAttempts !== 1
      || !leaseIsValidDate
      || job.claimToken !== claimToken
    ) {
      throw new Error(REJECT);
    }

    return { outcome, job, claimToken };
  },

  /**
   * D-031 — the post-claim verification barrier (migration 0060).
   *
   * `get_protocol_execution_job_context` only loads an attempt when
   * `current_attempt_id` is non-null, and scopes external calls and receipts
   * to that current attempt. A job carrying an older, non-current attempt
   * therefore looks empty through that lens. 0060 walks the job's entire
   * history instead, and this adapter is its only client-side surface.
   *
   * One RPC, four parameters, one closed label. There is deliberately no
   * `.from(...)` read, no second RPC and no fallback here: a verifier that
   * could answer from anywhere but the server's own single verdict would no
   * longer be a barrier. The reply carries a label and nothing else, so a
   * malformed reply is rejected with one value-free error rather than
   * repaired, and never echoes what the server sent.
   */
  async verifyPhase3dCanaryPostClaim(
    input: VerifyPhase3dCanaryPostClaimInput
  ): Promise<VerifyPhase3dCanaryPostClaimResult> {
    const { data, error } = await getClient().rpc("verify_phase3d_canary_post_claim", {
      p_worker_id: input.workerId,
      p_job_id: input.jobId,
      p_project_id: input.projectId,
      p_claim_token: input.claimToken,
    });
    if (error) throw error;

    const REJECT =
      "verifyPhase3dCanaryPostClaim: the RPC reply did not satisfy the closed D-031 contract.";

    const rows = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
    if (rows.length !== 1) throw new Error(REJECT);

    const row: unknown = rows[0];
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error(REJECT);
    const reply = row as Record<string, unknown>;

    // The SQL surface returns exactly one column. Any other own property means
    // the reply is not the one 0060 defines, and could carry tenant state.
    const keys = Object.keys(reply);
    if (keys.length !== 1 || keys[0] !== "outcome") throw new Error(REJECT);
    if (!Object.prototype.hasOwnProperty.call(reply, "outcome")) throw new Error(REJECT);

    const outcome = reply.outcome;
    if (
      outcome !== "VERIFIED"
      && outcome !== "JOB_NOT_FOUND"
      && outcome !== "JOB_NOT_OWNED"
      && outcome !== "JOB_NOT_CLEAN"
      && outcome !== "PROTOCOL_NOT_ELIGIBLE"
    ) {
      throw new Error(REJECT);
    }

    return { outcome };
  },

  async renewProtocolExecutionJobLease(
    input: RenewProtocolExecutionJobLeaseInput
  ): Promise<RenewProtocolExecutionJobLeaseResult> {
    const { data, error } = await getClient().rpc("renew_protocol_execution_job_lease", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "renewProtocolExecutionJobLease: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async admitAndReserveAttemptForJob(
    input: AdmitAndReserveAttemptForJobInput
  ): Promise<AdmitAndReserveAttemptForJobResult> {
    const { data, error } = await getClient().rpc("admit_and_reserve_attempt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_attempt_kind: input.attemptKind,
      p_idempotency_key: input.idempotencyKey,
      p_perplexity_reserved_cost_usd: input.perplexityReservedCostUsd,
      p_analysis_reserved_cost_usd: input.analysisReservedCostUsd,
      p_retry_of_attempt_id: input.retryOfAttemptId ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "admitAndReserveAttemptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
      perplexityCall: mapProtocolExternalCallNullable(
        row.perplexity_call as ProtocolExternalCallDbRow | null
      ),
      analysisCall: mapProtocolExternalCallNullable(
        row.analysis_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  async createProbeRunAndStartAttemptForJob(
    input: CreateProbeRunAndStartAttemptForJobInput
  ): Promise<CreateProbeRunAndStartAttemptForJobResult> {
    // D-026 (correction) — migration 0052 removed p_dataset_id/
    // p_dataset_source_type from this RPC's signature entirely; the
    // dataset is derived server-side from the job's own
    // dataset_batch_id. No dataset argument is forwarded here.
    const { data, error } = await getClient().rpc(
      "create_probe_run_and_start_attempt_for_job",
      {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_project_id: input.projectId,
        p_attempt_id: input.attemptId,
        p_platform: input.platform,
        p_probe_mode: input.probeMode,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "createProbeRunAndStartAttemptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
      probeRun: mapProbeRunNullable(row.probe_run as ProbeRunDbRow | null),
    };
  },

  async markExternalCallSentForJob(
    input: MarkExternalCallSentForJobInput
  ): Promise<MarkExternalCallSentForJobResult> {
    const { data, error } = await getClient().rpc("mark_external_call_sent_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_external_call_id: input.externalCallId,
      p_probe_run_id: input.probeRunId,
      p_call_kind: input.callKind,
      p_request_body: input.requestBody,
      p_request_body_sha256: input.requestBodySha256,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "markExternalCallSentForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      externalCall: mapProtocolExternalCallNullable(
        row.external_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  async recordProviderCallReceiptForJob(
    input: RecordProviderCallReceiptForJobInput
  ): Promise<RecordProviderCallReceiptForJobResult> {
    // D-023 §3: `unknown` is an application-level cost-basis value only —
    // the real CHECK constraint on protocol_external_calls.cost_basis
    // accepts only measured/estimated (migration 0050). Never forward
    // "unknown" itself as a literal to Postgres; treat it exactly like an
    // absent cost.
    const rpcCostBasis =
      input.costBasis === "measured" || input.costBasis === "estimated"
        ? input.costBasis
        : null;
    const rpcActualCostUsd = rpcCostBasis === null ? null : input.actualCostUsd ?? null;

    const { data, error } = await getClient().rpc("record_provider_call_receipt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_external_call_id: input.externalCallId,
      p_probe_run_id: input.probeRunId,
      p_outcome: input.outcome,
      p_http_status: input.httpStatus ?? null,
      p_provider_request_id: input.providerRequestId ?? null,
      p_raw_response_sha256: input.rawResponseSha256 ?? null,
      p_latency_ms: input.latencyMs ?? null,
      p_actual_cost_usd: rpcActualCostUsd,
      p_cost_basis: rpcCostBasis,
      p_raw_response_body: input.rawResponseBody ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "recordProviderCallReceiptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      externalCall: mapProtocolExternalCallNullable(
        row.external_call as ProtocolExternalCallDbRow | null
      ),
      receipt: mapProviderCallReceiptNullable(row.receipt as ProviderCallReceiptDbRow | null),
    };
  },

  async recordAnalysisCallReceiptForJob(
    input: RecordAnalysisCallReceiptForJobInput
  ): Promise<RecordAnalysisCallReceiptForJobResult> {
    // Same D-023 §3 rule as the Perplexity leg above.
    const rpcCostBasis =
      input.costBasis === "measured" || input.costBasis === "estimated"
        ? input.costBasis
        : null;
    const rpcActualCostUsd = rpcCostBasis === null ? null : input.actualCostUsd ?? null;

    const { data, error } = await getClient().rpc("record_analysis_call_receipt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_external_call_id: input.externalCallId,
      p_probe_run_id: input.probeRunId,
      p_outcome: input.outcome,
      p_provider: input.provider ?? null,
      p_model: input.model ?? null,
      p_used_mock: input.usedMock ?? false,
      p_request_sha256: input.requestSha256 ?? null,
      p_response_sha256: input.responseSha256 ?? null,
      p_latency_ms: input.latencyMs ?? null,
      p_actual_cost_usd: rpcActualCostUsd,
      p_cost_basis: rpcCostBasis,
      p_raw_content: input.rawContent ?? null,
      p_raw_request_body: input.rawRequestBody ?? null,
      // TK-R-2 / TK-R-3 / TK-R-1 — migration 0058.
      p_provider_request_id: input.providerRequestId ?? null,
      p_http_status: input.httpStatus ?? null,
      p_model_returned: input.modelReturned ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "recordAnalysisCallReceiptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      externalCall: mapProtocolExternalCallNullable(
        row.external_call as ProtocolExternalCallDbRow | null
      ),
      receipt: mapAnalysisCallReceiptNullable(row.receipt as AnalysisCallReceiptDbRow | null),
    };
  },

  async reconcileAttemptForJob(
    input: ReconcileAttemptForJobInput
  ): Promise<ReconcileAttemptForJobResult> {
    const { data, error } = await getClient().rpc("reconcile_attempt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_attempt_id: input.attemptId,
      p_status: input.status,
      p_termination_reason: input.terminationReason ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "reconcileAttemptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
    };
  },

  async completeProtocolExecutionJob(
    input: CompleteProtocolExecutionJobInput
  ): Promise<CompleteProtocolExecutionJobResult> {
    const { data, error } = await getClient().rpc("complete_protocol_execution_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "completeProtocolExecutionJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async failJobWithoutAttemptForJob(
    input: FailJobWithoutAttemptForJobInput
  ): Promise<FailJobWithoutAttemptForJobResult> {
    const { data, error } = await getClient().rpc("fail_job_without_attempt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_reason: input.reason,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "failJobWithoutAttemptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async abortAttemptAndFailJobForJob(
    input: AbortAttemptAndFailJobForJobInput
  ): Promise<AbortAttemptAndFailJobForJobResult> {
    const { data, error } = await getClient().rpc("abort_attempt_and_fail_job_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_attempt_id: input.attemptId,
      p_attempt_status: input.attemptStatus,
      p_termination_reason: input.terminationReason,
      p_failure_reason: input.failureReason,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "abortAttemptAndFailJobForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async closeAttemptForParseFailureForJob(
    input: CloseAttemptForParseFailureForJobInput
  ): Promise<CloseAttemptForParseFailureForJobResult> {
    const { data, error } = await getClient().rpc("close_attempt_for_parse_failure_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_attempt_id: input.attemptId,
      p_external_call_id: input.externalCallId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "closeAttemptForParseFailureForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async failProtocolExecutionJob(
    input: FailProtocolExecutionJobInput
  ): Promise<FailProtocolExecutionJobResult> {
    const { data, error } = await getClient().rpc("fail_protocol_execution_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_reason: input.reason,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "failProtocolExecutionJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async reactivateAbandonedJob(
    input: ReactivateAbandonedJobInput
  ): Promise<ReactivateAbandonedJobResult> {
    const { data, error } = await getClient().rpc("reactivate_abandoned_job", {
      p_job_id: input.jobId,
      p_project_id: input.projectId,
      p_actor: input.actor,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "reactivateAbandonedJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async retryFullAttemptForJob(
    input: RetryFullAttemptForJobInput
  ): Promise<RetryFullAttemptForJobResult> {
    const { data, error } = await getClient().rpc("retry_full_attempt_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_source_attempt_id: input.sourceAttemptId,
      p_perplexity_reserved_cost_usd: input.perplexityReservedCostUsd,
      p_analysis_reserved_cost_usd: input.analysisReservedCostUsd,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "retryFullAttemptForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attempt: mapProtocolAttemptNullable(row.attempt as ProtocolAttemptDbRow | null),
      perplexityCall: mapProtocolExternalCallNullable(
        row.perplexity_call as ProtocolExternalCallDbRow | null
      ),
      analysisCall: mapProtocolExternalCallNullable(
        row.analysis_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  async retryAnalysisGenerationForJob(
    input: RetryAnalysisGenerationForJobInput
  ): Promise<RetryAnalysisGenerationForJobResult> {
    const { data, error } = await getClient().rpc("retry_analysis_generation_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_source_external_call_id: input.sourceExternalCallId,
      p_reserved_cost_usd: input.reservedCostUsd,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "retryAnalysisGenerationForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      externalCall: mapProtocolExternalCallNullable(
        row.external_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  // D-027: markAnalysisParseFailedForJob — no direct DML, RPC only.
  async markAnalysisParseFailedForJob(
    input: MarkAnalysisParseFailedForJobInput
  ): Promise<MarkAnalysisParseFailedForJobResult> {
    const { data, error } = await getClient().rpc("mark_analysis_parse_failed_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_external_call_id: input.externalCallId,
      p_parse_failure_code: input.parseFailureCode,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "markAnalysisParseFailedForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      externalCall: mapProtocolExternalCallNullable(
        row.external_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  async authorizeOperatorRetry(
    input: AuthorizeOperatorRetryInput
  ): Promise<AuthorizeOperatorRetryResult> {
    const { data, error } = await getClient().rpc("authorize_operator_retry", {
      p_job_id: input.jobId,
      p_project_id: input.projectId,
      p_actor: input.actor,
      p_reason: input.reason,
      p_action: input.action,
      p_source_attempt_id: input.sourceAttemptId,
      p_reserved_cost_usd: input.reservedCostUsd,
      p_idempotency_key: input.idempotencyKey,
      p_source_external_call_id: input.sourceExternalCallId ?? null,
      p_perplexity_reserved_cost_usd: input.perplexityReservedCostUsd ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "authorizeOperatorRetry: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      status: row.status,
      outcome: row.outcome ?? null,
      denialCode: row.denial_code ?? null,
      newAttempt: mapProtocolAttemptNullable(row.new_attempt as ProtocolAttemptDbRow | null),
      newExternalCall: mapProtocolExternalCallNullable(
        row.new_external_call as ProtocolExternalCallDbRow | null
      ),
    };
  },

  async getProtocolExecutionJobContext(
    input: GetProtocolExecutionJobContextInput
  ): Promise<GetProtocolExecutionJobContextResult> {
    const { data, error } = await getClient().rpc("get_protocol_execution_job_context", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "getProtocolExecutionJobContext: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    const externalCalls = (row.external_calls ?? []) as ProtocolExternalCallDbRow[];
    const providerReceipts = (row.provider_receipts ?? []) as ProviderCallReceiptDbRow[];
    const analysisReceipts = (row.analysis_receipts ?? []) as AnalysisCallReceiptDbRow[];
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
      protocol: row.protocol ? mapProtocol(row.protocol as ProtocolDbRow) : null,
      currentAttempt: mapProtocolAttemptNullable(
        row.current_attempt as ProtocolAttemptDbRow | null
      ),
      externalCalls: externalCalls.map(mapProtocolExternalCall),
      providerReceipts: providerReceipts
        .map(mapProviderCallReceiptNullable)
        .filter((r): r is ProviderCallReceipt => r !== null),
      analysisReceipts: analysisReceipts
        .map(mapAnalysisCallReceiptNullable)
        .filter((r): r is AnalysisCallReceipt => r !== null),
      probeRun: mapProbeRunNullable(row.probe_run as ProbeRunDbRow | null),
      completedBaselineSlots: (row.completed_baseline_slots as number | null) ?? null,
      probeResult: mapProbeResultNullable(row.probe_result as ProbeResultDbRow | null),
    };
  },

  async markProtocolExecutionJobNeedsReviewForAmbiguity(
    input: MarkProtocolExecutionJobNeedsReviewForAmbiguityInput
  ): Promise<MarkProtocolExecutionJobNeedsReviewForAmbiguityResult> {
    const { data, error } = await getClient().rpc(
      "mark_protocol_execution_job_needs_review_for_ambiguity",
      {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_project_id: input.projectId,
      }
    );
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "markProtocolExecutionJobNeedsReviewForAmbiguity: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      job: mapProtocolExecutionJobNullable(row.job as ProtocolExecutionJobDbRow | null),
    };
  },

  async persistProbeResultForJob(
    input: PersistProbeResultForJobInput
  ): Promise<PersistProbeResultForJobResult> {
    const { data, error } = await getClient().rpc("persist_probe_result_for_job", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_project_id: input.projectId,
      p_content: {
        product_mentioned: input.content.productMentioned,
        product_position: input.content.productPosition,
        competitors_mentioned: input.content.competitorsMentioned,
        sources_cited: input.content.sourcesCited,
        answer_summary: input.content.answerSummary,
        cited_as_source: input.content.citedAsSource,
        client_source_count: input.content.clientSourceCount,
        platforms_referenced: input.content.platformsReferenced,
        negative_claim_detected: input.content.negativeClaimDetected,
      },
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "persistProbeResultForJob: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      probeResultId: (row.probe_result_id as string | null) ?? null,
      canonicalResultSha256: (row.canonical_result_sha256 as string | null) ?? null,
    };
  },

  async claimNextPendingAlert(
    input: ClaimNextPendingAlertInput
  ): Promise<ClaimNextPendingAlertResult> {
    const { data, error } = await getClient().rpc("claim_next_pending_alert", {
      p_worker_id: input.workerId,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "claimNextPendingAlert: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      deliveryId: (row.delivery_id as string | null) ?? null,
      alertEventId: (row.alert_event_id as string | null) ?? null,
      claimToken: (row.claim_token as string | null) ?? null,
      attemptCount: (row.attempt_count as number | null) ?? null,
      projectId: (row.project_id as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      eventType: (row.event_type as AlertEventType | null) ?? null,
      reasonCode: (row.reason_code as AlertReasonCode | null) ?? null,
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      reconciledStaleClaimedCount: (row.reconciled_stale_claimed_count as number | null) ?? 0,
      reconciledUnder24hCount: (row.reconciled_under_24h_count as number | null) ?? 0,
      reconciledOver24hCount: (row.reconciled_over_24h_count as number | null) ?? 0,
    };
  },

  async renewAlertLease(input: RenewAlertLeaseInput): Promise<RenewAlertLeaseResult> {
    const { data, error } = await getClient().rpc("renew_alert_lease", {
      p_delivery_id: input.deliveryId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "renewAlertLease: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      deliveryId: (row.delivery_id as string | null) ?? null,
    };
  },

  async markAlertRequestSent(
    input: MarkAlertRequestSentInput
  ): Promise<MarkAlertRequestSentResult> {
    const { data, error } = await getClient().rpc("mark_alert_request_sent", {
      p_delivery_id: input.deliveryId,
      p_claim_token: input.claimToken,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "markAlertRequestSent: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      attemptId: (row.attempt_id as string | null) ?? null,
      attemptSeq: (row.attempt_seq as number | null) ?? null,
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
    };
  },

  async recordAlertDeliveryReceipt(
    input: RecordAlertDeliveryReceiptInput
  ): Promise<RecordAlertDeliveryReceiptResult> {
    const { data, error } = await getClient().rpc("record_alert_delivery_receipt", {
      p_delivery_id: input.deliveryId,
      p_claim_token: input.claimToken,
      p_attempt_id: input.attemptId,
      p_outcome: input.outcome,
      p_http_status: input.httpStatus ?? null,
      p_resend_email_id: input.resendEmailId ?? null,
      p_error_code: input.errorCode ?? null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw new Error(
        "recordAlertDeliveryReceipt: RPC returned no row; the return contract guarantees exactly one."
      );
    }
    return {
      outcome: row.status,
      deliveryId: (row.delivery_id as string | null) ?? null,
      finalDeliveryStatus: (row.final_delivery_status as AlertDeliveryStatus | null) ?? null,
    };
  },
};
