export interface Project {
  id: string;
  userId: string | null;
  companyName: string | null;
  domain: string;
  category: string | null;
  createdAt: string;
}

export interface SitePage {
  id: string;
  projectId: string;
  url: string;
  title: string;
  content: string;
  pageType: string;
  createdAt: string;
}

export interface MirrorProfileRow {
  id: string;
  projectId: string;
  json: unknown; // typed as SiteReaderOutput by the caller
  createdAt: string;
}

export interface GeneratedPrompt {
  id: string;
  projectId: string;
  prompt: string;
  intentType: string;
  commercialValue: number;
  winnability: number;
  priority: number;
  rationale: string;
  selected: boolean;
  createdAt: string;
}

export type GeneratedPromptInput = Omit<
  GeneratedPrompt,
  "id" | "projectId" | "createdAt"
>;

export type ProbeRunStatus = "pending" | "succeeded" | "failed";

/**
 * Sprint 12 — how the underlying probe answer was produced.
 *
 *   - `simulated`: the answer was manually pasted (or fixture-generated)
 *     and then analyzed by our own LLM. There was **no** live call to
 *     ChatGPT / Perplexity / Gemini platform APIs.
 *   - `live_perplexity`: the answer came from a real Perplexity Sonar
 *     API call, then was analyzed by Zypact's Probe Analysis Agent.
 *
 * Legacy rows are `simulated` (see migration `0012` for the backfill).
 * Sprint 13 adds `live_perplexity`; do not read this field from a
 * hardcoded helper; read it from the row.
 */
export type ProbeMode = "simulated" | "live_perplexity";

/**
 * M2 canonical observations contract, first tranche (D-014,
 * METHODOLOGY.md v1.1) — how a dataset_batches row (and anything
 * pointing to it) came to exist.
 *
 *   - "snapshot_request": the project has exactly one snapshot_requests
 *     row; dataset_batches.snapshotRequestId is populated.
 *   - "manual_scan": a dataset_batches row was created at the exact
 *     moment of a manual scan invocation (scripts/mvp-scan.ts). No
 *     historical row can be backfilled into this value — there is no
 *     contemporaneous proof for anything created before this field
 *     existed.
 *   - "legacy_unresolved": every other historical case — zero or
 *     multiple candidate snapshot_requests rows, or any origin that
 *     cannot be proven. Never guessed.
 */
export type DatasetSourceType =
  | "snapshot_request"
  | "manual_scan"
  | "legacy_unresolved";

/**
 * M2 canonical observations contract, first tranche (D-014,
 * METHODOLOGY.md §9) — replaces the legacy `won`/`partial`/`lost`/
 * `not_relevant` verdict at the run level. Sentiment
 * (`negativeClaimDetected`) and relevance (formerly `not_relevant`)
 * are tracked as separate fields, never folded into this position.
 */
export type RunPosition =
  | "not_observed_in_run"
  | "listed_in_run"
  | "primary_in_run"
  | "ambiguous_in_run"
  | "analysis_failed";

export interface ProbeRun {
  id: string;
  projectId: string;
  platform: string;
  status: ProbeRunStatus;
  probeMode: ProbeMode;
  /**
   * M2 canonical observations contract, first tranche — legacy,
   * nullable compatibility field: a direct link to snapshot_requests,
   * unrelated to dataset_id/dataset_batches. Not backfilled by this
   * tranche.
   */
  snapshotRequestId?: string | null;
  /**
   * M2 canonical observations contract, first tranche — nullable in
   * this tranche only because probe_runs is an existing, non-empty
   * table. A follow-up migration adds NOT NULL once a backfill
   * confirms zero remaining null rows (see D-014). Never populated by
   * this tranche.
   */
  datasetId?: string | null;
  datasetSourceType?: DatasetSourceType | null;
  createdAt: string;
}

export interface ProbeResult {
  id: string;
  probeRunId: string;
  projectId: string;
  generatedPromptId: string | null;
  prompt: string;
  platform: string;
  probeMode: ProbeMode;
  rawResponse: string;
  /** Sprint 13C — exact Perplexity API user message/body used for the live call. */
  rawProbeRequest?: string;
  /** Sprint 13C — brand was recommended as a product/tool in the answer body. */
  productMentioned?: boolean;
  productPosition?: string;
  productVerdict?: string;
  /** Sprint 13C — brand appeared only/as source citation signal. */
  citedAsSource?: boolean;
  clientSourceCount?: number;
  platformsReferenced?: string[];
  clientMentioned: boolean;
  clientPosition: string;
  competitorsMentioned: unknown; // typed as CompetitorMention[] by callers
  sourcesCited: unknown; // typed as SourceCitation[] by callers
  answerSummary: string;
  verdict: string;
  whyClientLost: string;
  /** M1 evidence contract — SHA-256 of `rawResponse` (the reconstructed transcript). Null for pre-M1 rows. */
  rawResponseSha256?: string | null;
  /**
   * M1 evidence contract, second tranche — the exact response body text as
   * received from the probe provider (captured before JSON.parse). Null
   * for pasted/manual answers and for rows saved before this field
   * existed.
   */
  rawResponseBody?: string | null;
  /** M1 evidence contract, second tranche — SHA-256 of `rawResponseBody`. */
  rawResponseBodySha256?: string | null;
  /**
   * M1 evidence contract — SHA-256 of `rawProbeRequest` ONLY (the buyer
   * question text), NOT the complete outbound HTTP body. See
   * `fullRequestBodySha256` for that. Null for pre-M1 rows.
   */
  rawProbeRequestSha256?: string | null;
  /**
   * M1 evidence contract — SHA-256 of the exact JSON-serialized HTTP
   * request body sent to the probe provider. Null for pasted/manual
   * (non-live) answers and for rows saved before this field existed.
   */
  fullRequestBodySha256?: string | null;
  /** M1 evidence contract — HTTP status returned by the probe provider. */
  providerHttpStatus?: number | null;
  /** M1 evidence contract — wall-clock milliseconds spent in the outbound probe call. */
  providerLatencyMs?: number | null;
  /** M1 evidence contract — provider-assigned request id, when available. */
  providerRequestId?: string | null;
  /** M1 evidence contract — exact model string echoed by the provider. */
  providerModel?: string | null;
  /** M1 evidence contract — number of provider retries for this attempt. */
  retryCount?: number;
  /** M2 canonical observations contract, first tranche — see ProbeRun. */
  snapshotRequestId?: string | null;
  /** M2 canonical observations contract, first tranche — see ProbeRun. */
  datasetId?: string | null;
  datasetSourceType?: DatasetSourceType | null;
  /**
   * M2 canonical observations contract, first tranche — replaces
   * `verdict` at the run level (§9). Nullable in this tranche; not
   * backfilled or computed yet.
   */
  runPosition?: RunPosition | null;
  /**
   * M2 canonical observations contract, first tranche — sentiment,
   * tracked separately from `runPosition` (D-014).
   */
  negativeClaimDetected?: boolean | null;
  observationSchemaVersion?: number | null;
  createdAt: string;
}

export interface Competitor {
  id: string;
  projectId: string;
  name: string;
  website: string | null;
  discoverySource: string; // "user" | "client_site" | "ai_answer" | "model_knowledge"
  mentionCount: number;
  promptIds: string[];
  threatLevel: string; // "high" | "medium" | "low"
  confidence: string; // "verified" | "unverified"
  isPhantom: boolean;
  isBlindSpot: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CompetitorInput = Omit<
  Competitor,
  "id" | "projectId" | "createdAt" | "updatedAt"
>;

// Sprint 5 — Gap Map
export interface GapMapRow {
  id: string;
  projectId: string;
  json: unknown;
  createdAt: string;
}

export interface Gap {
  id: string;
  projectId: string;
  competitorName: string | null;
  type: string;
  severity: string; // "high" | "medium" | "low"
  explanation: string;
  affectedPrompts: string[];
  suggestedFixDirection: string;
  createdAt: string;
}

export type GapInput = Omit<Gap, "id" | "projectId" | "createdAt">;

// Sprint 6 — Evidence Bank
// The DB row mirrors `EvidenceBankOutput` shape from
// `lib/schemas/evidence-bank.schema.ts`. We re-declare the interface here
// to keep the DB layer independent of the Zod schema (adapters must not
// import from `lib/schemas` to avoid circular deps).
/**
 * Sprint 12 — provenance of the current Evidence Bank row.
 *
 *   - `auto_filled_from_mirror_profile`: the row was created by
 *     `getOrCreateEvidenceBank` from the Mirror Profile. No human has
 *     reviewed it. Anything published from this bank is at higher risk
 *     of an unverified claim.
 *   - `user_edited`: a user hit POST on `/api/projects/evidence-bank`
 *     at least once. Content has been modified — may still contain
 *     auto-filled fields, but the row is no longer purely machine-authored.
 *   - `user_reviewed`: a user explicitly confirmed the bank. Reserved
 *     for a future "review + approve" UI. Do not set this value until
 *     that UI exists.
 */
export type EvidenceBankProvenance =
  | "auto_filled_from_mirror_profile"
  | "user_edited"
  | "user_reviewed";

export interface EvidenceBankRow {
  id: string;
  projectId: string;
  productDescription: string;
  targetAudience: string[];
  mainUseCases: string[];
  features: Array<{ name: string; description: string }>;
  proofItems: Array<{ type: string; detail: string; sourceUrl?: string }>;
  competitors: string[];
  allowedClaims: string[];
  forbiddenClaims: string[];
  tone: string;
  notes: string;
  provenance: EvidenceBankProvenance;
  createdAt: string;
  updatedAt: string;
}

export type EvidenceBankRowInput = Omit<
  EvidenceBankRow,
  "id" | "projectId" | "createdAt" | "updatedAt"
>;

// Sprint 7 — Fix Brief
export interface FixBriefRow {
  id: string;
  projectId: string;
  gapId: string | null;
  probeResultId: string | null;
  lostPrompt: string;
  competitorRecommended: string;
  rootCause: string;
  recommendedFix: string;
  fixType: string;
  assetsToGenerate: string[];
  evidenceNeeded: string[];
  evidenceAvailable: string[];
  priority: number;
  expectedImpact: string;
  status: string; // "draft" | "needs_evidence" | "ready_for_assets" | "partially_complete" | "assets_ready" | "historical"
  createdAt: string;
  updatedAt: string;
}

export type FixBriefRowInput = Omit<
  FixBriefRow,
  "id" | "projectId" | "createdAt" | "updatedAt"
>;

// Sprint 8 — Generated Asset
export type GeneratedAssetLifecycleStatus = "active" | "superseded";

export interface GeneratedAssetRow {
  id: string;
  projectId: string;
  fixBriefId: string;
  assetType: string;
  title: string;
  content: string;
  placeholders: string[];
  claimsUsed: Array<{ claim: string; source: string }>;
  qaStatus: string;
  /** Sprint 13B.2 — current candidate vs auditable historical draft. */
  lifecycleStatus: GeneratedAssetLifecycleStatus;
  /** Sprint 13B.1 — which provider/model generated this asset. */
  generationProvider: string | null;
  generationModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GeneratedAssetRowInput = Omit<
  GeneratedAssetRow,
  | "id"
  | "projectId"
  | "createdAt"
  | "updatedAt"
  | "generationProvider"
  | "generationModel"
  | "lifecycleStatus"
> & {
  generationProvider?: string | null;
  generationModel?: string | null;
  lifecycleStatus?: GeneratedAssetLifecycleStatus;
};

// Sprint 9 — QA Report
// A QA Report is the output of the QA Agent for a single Generated Asset.
// We store one row per QA run (not upsert) so users can see how QA verdicts
// evolve across Evidence Bank edits and re-runs.
export interface QaReportRow {
  id: string;
  projectId: string;
  generatedAssetId: string;
  verdict: string; // "safe_to_publish" | "needs_evidence" | "unsupported_claims"
  violations: Array<{
    type: string;
    quote: string;
    reason: string;
    suggestedFix: string;
  }>;
  placeholdersRemaining: string[];
  overallNotes: string;
  createdAt: string;
}

export type QaReportRowInput = Omit<
  QaReportRow,
  "id" | "projectId" | "createdAt"
>;

export interface SaveProbeResultInput {
  probeRunId: string;
  projectId: string;
  generatedPromptId?: string | null;
  prompt: string;
  platform: string;
  /**
   * Sprint 12 — set to `"simulated"` for any answer the pipeline did not
   * fetch from a real platform API. Callers must set this explicitly;
   * adapters do not infer it.
   */
  probeMode: ProbeMode;
  rawResponse: string;
  /** Sprint 13C — exact Perplexity API user message/body used for the live call. */
  rawProbeRequest?: string;
  /** Sprint 13C — brand was recommended as a product/tool in the answer body. */
  productMentioned?: boolean;
  productPosition?: string;
  productVerdict?: string;
  /** Sprint 13C — brand appeared only/as source citation signal. */
  citedAsSource?: boolean;
  clientSourceCount?: number;
  platformsReferenced?: string[];
  clientMentioned: boolean;
  clientPosition: string;
  competitorsMentioned: unknown;
  sourcesCited: unknown;
  answerSummary: string;
  verdict: string;
  whyClientLost: string;
  /** M1 evidence contract — SHA-256 of `rawResponse` (the reconstructed transcript). Omitted for pasted/manual answers. */
  rawResponseSha256?: string | null;
  /**
   * M1 evidence contract, second tranche — the exact response body text as
   * received from the probe provider (captured before JSON.parse).
   * Omitted for pasted/manual answers.
   */
  rawResponseBody?: string | null;
  /** M1 evidence contract, second tranche — SHA-256 of `rawResponseBody`. */
  rawResponseBodySha256?: string | null;
  /**
   * M1 evidence contract — SHA-256 of `rawProbeRequest` ONLY (the buyer
   * question text), NOT the complete outbound HTTP body. See
   * `fullRequestBodySha256` for that.
   */
  rawProbeRequestSha256?: string | null;
  /**
   * M1 evidence contract — SHA-256 of the exact JSON-serialized HTTP
   * request body sent to the probe provider. Omitted for pasted/manual
   * (non-live) answers, which never had an outbound body.
   */
  fullRequestBodySha256?: string | null;
  /** M1 evidence contract — HTTP status returned by the probe provider. */
  providerHttpStatus?: number | null;
  /** M1 evidence contract — wall-clock milliseconds spent in the outbound probe call. */
  providerLatencyMs?: number | null;
  /** M1 evidence contract — provider-assigned request id, when available. */
  providerRequestId?: string | null;
  /** M1 evidence contract — exact model string echoed by the provider. */
  providerModel?: string | null;
  /** M1 evidence contract — number of provider retries for this attempt. */
  retryCount?: number;
  /** M2 canonical observations contract, first tranche — see ProbeRun. */
  snapshotRequestId?: string | null;
  /** M2 canonical observations contract, first tranche — see ProbeRun. */
  datasetId?: string | null;
  datasetSourceType?: DatasetSourceType | null;
  /** M2 canonical observations contract, first tranche — see ProbeResult. */
  runPosition?: RunPosition | null;
  negativeClaimDetected?: boolean | null;
  observationSchemaVersion?: number | null;
}

/**
 * M1 evidence contract — one row per internal-analysis model call (Mirror
 * Profile, Probe Analysis, Competitor Discovery, Gap Map, Fix Brief, QA).
 *
 * Deliberately separate from `SaveProbeResultInput`/`ProbeResult`: this
 * table traces OpenAI/Anthropic *analysis* calls, never a Perplexity probe
 * answer. Perplexity Sonar remains the only external probe surface for V1
 * (see docs/DECISIONS.md D-004); this contract does not add a second one.
 *
 * KNOWN M1 LIMITATION (first tranche, not yet closed): only the
 * `probe-analysis` stage (`lib/pipeline/analyze-probe-response.ts`)
 * actually calls `recordAnalysisLlmCall` today. Mirror Profile,
 * Competitor Discovery, Gap Map, Fix Brief, and QA still call the model
 * without writing a trace row here — their calls are invisible to this
 * table until each is wired individually. `latencyMs` is available on
 * every `callModel` result already (`lib/llm/call-model.ts`), so wiring a
 * given stage is additive, not a redesign.
 */
export interface AnalysisLlmCallInput {
  projectId: string;
  /** Pipeline stage name, e.g. "probe-analysis", "mirror-profile". */
  stage: string;
  provider: "openai" | "anthropic" | "mock";
  model: string;
  usedMock: boolean;
  usedRetry: boolean;
  latencyMs: number;
  requestSha256?: string | null;
  responseSha256?: string | null;
}

export interface AnalysisLlmCall extends AnalysisLlmCallInput {
  id: string;
  createdAt: string;
}

/**
 * M1 evidence contract, second tranche — one row per failed live provider
 * probe attempt (network error, non-2xx status, or empty answer). Kept
 * separate from `probe_results`, which represents only completed,
 * analyzable answers. Not linked to a `probe_runs` row: a `probe_runs`
 * row is only created once `analyzeProbeResponse` starts (after a
 * successful `runPerplexityProbe`), so a provider-level failure has no
 * run to attach to yet — `probeRunId` is left null for those.
 */
export interface RecordProbeFailureInput {
  probeRunId?: string | null;
  projectId: string;
  platform: string;
  prompt: string;
  failureReason: "network_error" | "http_error" | "empty_answer";
  providerHttpStatus?: number | null;
  providerErrorBody?: string | null;
  providerErrorBodySha256?: string | null;
  providerLatencyMs?: number | null;
  providerRequestId?: string | null;
  rawProbeRequestSha256?: string | null;
  fullRequestBodySha256?: string | null;
  retryCount?: number;
}

export interface ProbeFailure extends RecordProbeFailureInput {
  id: string;
  createdAt: string;
}

/**
 * M2 canonical observations contract, first tranche (D-014) — synthetic
 * dataset identity. Created before any dataset_id column can reference
 * it, so a dataset_id can never be an orphaned reference: the foreign
 * key is enforced by the database at write time, not by application
 * discipline.
 *
 * `snapshotRequestId` is populated only when
 * `datasetSourceType === "snapshot_request"`; the database CHECK
 * constraint on `dataset_batches` enforces this in both directions.
 *
 * `backfillKey` is populated only by the (not-yet-existing) backfill
 * script, to make rerunning it idempotent via a unique constraint. Live
 * writes — one row per manual scan invocation, or one row per approved
 * snapshot request — leave it null.
 *
 * No caller creates a row through this contract yet. Wiring is a later
 * tranche; this first tranche is schema and types only.
 */
export interface DatasetBatchInput {
  projectId: string;
  datasetSourceType: DatasetSourceType;
  snapshotRequestId?: string | null;
  backfillKey?: string | null;
  note?: string | null;
}

export interface DatasetBatch extends DatasetBatchInput {
  id: string;
  createdAt: string;
}

/**
 * M2 canonical observations contract, first tranche (D-014) —
 * deterministic, per-project entity identity. Never shared across
 * tenants (METHODOLOGY.md §11). No caller populates this yet; entity
 * resolution is a later tranche.
 */
export interface CanonicalEntityInput {
  projectId: string;
  entityType: "client" | "competitor" | "platform";
  resolverVersion: number;
}

export interface CanonicalEntity extends CanonicalEntityInput {
  id: string;
  createdAt: string;
}

/**
 * M2 canonical observations contract, first tranche (D-014) — a raw
 * observed string resolved to a canonical entity. `projectId` and
 * `entityType` are denormalized from the parent `CanonicalEntity` and
 * enforced identical to it by a composite foreign key at the database
 * layer, not by application discipline alone. No caller populates this
 * yet; entity resolution is a later tranche.
 */
export interface EntityAliasInput {
  canonicalEntityId: string;
  projectId: string;
  entityType: "client" | "competitor" | "platform";
  rawText: string;
  normalizedText: string;
  resolverVersion: number;
}

export interface EntityAlias extends EntityAliasInput {
  id: string;
  createdAt: string;
}

/**
 * M2 canonical observations contract, second tranche (D-015) — the
 * exact four-status return contract of the `backfill_probe_result_
 * dataset_identity` SECURITY DEFINER RPC. Always exactly one result,
 * never an empty/absent outcome, so NOT_FOUND and CONFLICT stay
 * distinguishable.
 */
export type BackfillProbeResultDatasetIdentityStatus =
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "NOT_FOUND"
  | "CONFLICT";

export interface BackfillProbeResultDatasetIdentityInput {
  probeResultId: string;
  projectId: string;
  datasetId: string;
  datasetSourceType: DatasetSourceType;
  runPosition?: RunPosition | null;
  negativeClaimDetected?: boolean | null;
  observationSchemaVersion?: number | null;
}

export interface BackfillProbeResultDatasetIdentityResult {
  status: BackfillProbeResultDatasetIdentityStatus;
  probeResult: ProbeResult | null;
}

export type SnapshotRequestStatus =
  | "pending_verification"
  | "verified"
  | "pending_approval"
  | "approved"
  | "queued"
  | "running"
  | "quality_review"
  | "needs_founder_review"
  | "report_ready"
  | "qa_failed"
  | "failed"
  | "rejected"
  | "expired";

export type SnapshotProgressStage =
  | "reserved"
  | "crawling"
  | "analyzing_site"
  | "generating_questions"
  | "checking_ai_visibility"
  | "building_diagnosis"
  | "quality_review";

export type SnapshotCompletionStatus =
  | "report_ready"
  | "failed";

export type SnapshotRequestLimitCode =
  | "email_30d"
  | "domain_30d"
  | "active_domain"
  | "ip_daily";

export class SnapshotRequestLimitError extends Error {
  readonly code: SnapshotRequestLimitCode;

  constructor(code: SnapshotRequestLimitCode) {
    super(`Snapshot request limit reached: ${code}`);
    this.name = "SnapshotRequestLimitError";
    this.code = code;
  }
}

export interface SnapshotRequest {
  id: string;
  workEmail: string;
  normalizedEmail: string;
  companyName: string;
  websiteUrl: string;
  normalizedDomain: string;
  buyerCategory: string;
  status: SnapshotRequestStatus;
  requestIpHash: string | null;
  projectId: string | null;
  progressStage: SnapshotProgressStage | null;
  progressUpdatedAt: string | null;
  /**
   * Founder approval metadata (migration 0021). A CHECK constraint keeps
   * the pair coherent: both null before approval, both non-null after.
   *
   * `approvedBy` is the founder's auth user id. It is internal review
   * metadata — render it only on founder-only surfaces, never on the
   * public report page.
   */
  approvedAt: string | null;
  approvedBy: string | null;
  /**
   * Founder-reviewed competitor frame, stored at approval (migration 0034).
   *
   * Empty before approval and for historical rows — never backfilled. A
   * claimed request carries this list, so a worker resolves its execution
   * options without a second database read.
   */
  competitors: string[];
  /**
   * Worker ownership. All three are null together for manual CLI runs,
   * and non-null together once a worker holds the request.
   *
   * `claimToken` — not `claimedBy` — is what fences a stalled worker: a
   * restarted process reuses its machine label, so the label is not a
   * process identity. Only the database generates a token.
   */
  claimedBy: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimNextSnapshotRequestInput {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
}

export interface RenewSnapshotRequestLeaseInput {
  requestId: string;
  claimToken: string;
  leaseSeconds: number;
}

/**
 * Shared shape of every token-fenced worker write. `projectId` is not
 * redundant with `requestId`: the SQL guard requires the pair to match, so
 * a worker holding a stale project cannot write against a reclaimed row.
 */
export interface SnapshotWorkerWriteInput {
  requestId: string;
  projectId: string;
  claimToken: string;
}

export interface SnapshotWorkerProgressInput
  extends SnapshotWorkerWriteInput {
  stage: SnapshotProgressStage;
}

export interface SnapshotWorkerCompletionInput
  extends SnapshotWorkerWriteInput {
  fullReportMarkdown: string;
  shortReportMarkdown: string;
  fullReportFilename: string;
  shortReportFilename: string;
  generatedAt: string;
}

export type SnapshotWorkerFailureInput = SnapshotWorkerWriteInput;


export interface SnapshotReportArtifact {
  id: string;
  snapshotRequestId: string;
  projectId: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
  fullReportFilename: string;
  shortReportFilename: string;
  generatedAt: string;
  publicToken: string;
  /** True while a delivery claim is held. The raw token is never exposed. */
  deliveryClaimActive: boolean;
  deliveryClaimedAt: string | null;
  deliveredAt: string | null;
  deliveryMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSnapshotReportArtifactInput {
  snapshotRequestId: string;
  projectId: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
  fullReportFilename: string;
  shortReportFilename: string;
  generatedAt: string;
}

export interface CreateSnapshotRequestInput {
  workEmail: string;
  normalizedEmail: string;
  companyName: string;
  websiteUrl: string;
  normalizedDomain: string;
  buyerCategory: string;
  requestIpHash?: string | null;
}

export interface IssueSnapshotRequestVerificationInput {
  requestId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface CreateProjectInput {
  domain: string;
  companyName?: string | null;
  userId?: string | null;
}

export interface DbAdapter {
  getSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null>;

  listSnapshotRequests(
    limit?: number
  ): Promise<SnapshotRequest[]>;

  /**
   * M2 canonical observations contract, second tranche — used by the
   * historical backfill's classification rule (D-014): a project
   * backfills as "snapshot_request" only when this returns exactly one
   * row; zero or several means "legacy_unresolved", never guessed.
   */
  getSnapshotRequestsByProject(projectId: string): Promise<SnapshotRequest[]>;

  getSnapshotReportArtifact(
    requestId: string
  ): Promise<SnapshotReportArtifact | null>;

  getSnapshotReportArtifactByPublicToken(
    publicToken: string
  ): Promise<SnapshotReportArtifact | null>;

  /**
   * Store a report for a request that is still `running` and manually
   * owned. Returns null when the RPC refuses on a business rule — most
   * importantly when the artifact has already been delivered.
   */
  saveSnapshotReportArtifact(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact | null>;

  /**
   * Insert a missing artifact for a request that is already
   * `report_ready`. Separate from `saveSnapshotReportArtifact` because the
   * two paths have incompatible source-status preconditions in SQL, and
   * this one is insert-only. Returns null when an artifact already exists.
   */
  /* migration 0035 delivery fencing — RPC-only, service path */
  replaceUndeliveredSnapshotReportArtifact(
    input: ReplaceUndeliveredSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifactRevision | null>;
  beginSnapshotReportDelivery(
    input: BeginSnapshotReportDeliveryInput
  ): Promise<BegunSnapshotReportDelivery | null>;
  finalizeSnapshotReportDelivery(
    input: FinalizeSnapshotReportDeliveryInput
  ): Promise<FinalizedSnapshotReportDelivery | null>;
  releaseSnapshotReportDeliveryClaim(
    input: ReleaseSnapshotReportDeliveryClaimInput
  ): Promise<{ artifactId: string } | null>;

  insertSnapshotReportArtifactBackfill(
    input: SaveSnapshotReportArtifactInput
  ): Promise<SnapshotReportArtifact | null>;

  /**
   * Record delivery bookkeeping. `resend` is computed by the founder route
   * and passed through: initial delivery requires an undelivered artifact,
   * a resend requires a previously delivered one.
   */
  markSnapshotReportDelivered(
    requestId: string,
    messageId: string,
    deliveredAt: string,
    resend: boolean
  ): Promise<SnapshotReportArtifact | null>;

  rejectSnapshotRequest(
    requestId: string
  ): Promise<SnapshotRequest | null>;
  createSnapshotRequest(
    input: CreateSnapshotRequestInput
  ): Promise<SnapshotRequest>;
  issueSnapshotRequestVerification(
    input: IssueSnapshotRequestVerificationInput
  ): Promise<boolean>;
  consumeSnapshotRequestVerification(
    tokenHash: string
  ): Promise<SnapshotRequest | null>;
  failSnapshotVerificationDelivery(
    requestId: string
  ): Promise<boolean>;
  /**
   * Approves a request and queues it in one authoritative operation.
   *
   * `competitors` is the founder-reviewed frame. The RPC normalizes and
   * validates it (minimum 2, maximum 12) and refuses the approval outright
   * when it is unusable — a queued request is immediately claimable, so it
   * must already carry its final list.
   */
  approveAndQueueSnapshotRequest(
    requestId: string,
    approvedBy: string,
    competitors: string[]
  ): Promise<SnapshotRequest | null>;
  reserveSnapshotRequestProject(
    requestId: string
  ): Promise<SnapshotRequest | null>;
  /**
   * Claim the next eligible request: stale worker-owned requests first
   * (their paid probes are already bought), then queued. Returns null
   * when nothing is eligible. The claim token is generated by the
   * database and cannot be supplied by the caller.
   */
  claimNextSnapshotRequest(
    input: ClaimNextSnapshotRequestInput
  ): Promise<SnapshotRequest | null>;
  /**
   * Extend an unexpired lease. An expired lease is lost permanently and
   * cannot be revived, even before another worker reclaims it.
   */
  renewSnapshotRequestLease(
    input: RenewSnapshotRequestLeaseInput
  ): Promise<SnapshotRequest | null>;
  /**
   * Token-fenced worker writes (migration 0031).
   *
   * A claimed request carries a `claim_token`, and every *manual* RPC
   * refuses such a row outright. These three are the only write surface a
   * worker may use, and each one re-validates ownership in SQL: matching
   * project, `status = 'running'`, exact token, and an unexpired lease. A
   * refusal returns null — it never throws and never falls back.
   *
   * Optional on the adapter because the in-memory adapter has no worker
   * surface. The execution engine requires them structurally in worker
   * mode, so a caller cannot reach a fenced path without them.
   */
  updateSnapshotRequestProgressWorker?(
    input: SnapshotWorkerProgressInput
  ): Promise<SnapshotRequest | null>;
  /**
   * Persist the report and finalize the request in ONE fenced statement.
   * The worker equivalent of manual save-then-finalize, which cannot be
   * split without leaving a window where ownership has moved on.
   */
  completeSnapshotReportWorker?(
    input: SnapshotWorkerCompletionInput
  ): Promise<SnapshotReportArtifact | null>;
  /** Record failure for a claimed request. Clears the claim. */
  markSnapshotRequestFailedWorker?(
    input: SnapshotWorkerFailureInput
  ): Promise<SnapshotRequest | null>;
  updateSnapshotRequestProgress(
    requestId: string,
    projectId: string,
    stage: SnapshotProgressStage
  ): Promise<SnapshotRequest | null>;
  finalizeSnapshotRequest(
    requestId: string,
    projectId: string,
    status: SnapshotCompletionStatus
  ): Promise<SnapshotRequest | null>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProjectCategory(projectId: string, category: string): Promise<void>;
  saveSitePages(
    projectId: string,
    pages: Array<Omit<SitePage, "id" | "projectId" | "createdAt">>
  ): Promise<void>;
  saveMirrorProfile(projectId: string, json: unknown): Promise<MirrorProfileRow>;
  getProject(id: string): Promise<Project | null>;
  getSitePages(projectId: string): Promise<SitePage[]>;
  getMirrorProfile(projectId: string): Promise<MirrorProfileRow | null>;

  /**
   * Replace all generated prompts for a project with the given set.
   * Idempotent: any prior prompts for the project are deleted first.
   */
  replaceGeneratedPrompts(
    projectId: string,
    prompts: GeneratedPromptInput[]
  ): Promise<GeneratedPrompt[]>;
  getGeneratedPrompts(projectId: string): Promise<GeneratedPrompt[]>;
  getGeneratedPrompt(id: string): Promise<GeneratedPrompt | null>;

  // Sprint 3 — Probe Analysis
  /**
   * M2 canonical observations contract, third tranche (runtime writer
   * hardening) — `datasetIdentity` is the resolved `dataset_batches`
   * row to write at INSERT time, never via a later UPDATE.
   *
   * Optional here only for backward compatibility with existing test
   * call sites that do not exercise the dataset-identity dimension.
   * The Supabase adapter's implementation enforces the real
   * production invariant at runtime: it throws immediately if
   * `datasetIdentity` is missing, rather than silently inserting a
   * NULL `dataset_id`/`dataset_source_type`. The in-memory adapter
   * stays permissive (NULL when omitted) so unrelated tests are not
   * forced to supply it. `updateProbeRunDatasetIdentity` remains the
   * only path for the historical backfill, which necessarily UPDATEs
   * rows that already exist.
   */
  createProbeRun(
    projectId: string,
    platform: string,
    /**
     * Sprint 12 — callers must declare whether the answer being analyzed
     * came from a live platform-API call or from a
     * pasted/mock/model-simulated source. Legacy rows have been
     * backfilled to `"simulated"` by migration `0012`; Sprint 13
     * writes `"live_perplexity"` for Perplexity Sonar answers.
     */
    probeMode: ProbeMode,
    status?: ProbeRunStatus,
    datasetIdentity?: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<ProbeRun>;
  updateProbeRunStatus(id: string, status: ProbeRunStatus): Promise<void>;
  /** M1 evidence contract, fourth tranche — used to verify no duplicate run is created per attempt. */
  getProbeRunsByProject(projectId: string): Promise<ProbeRun[]>;
  saveProbeResult(input: SaveProbeResultInput): Promise<ProbeResult>;
  getProbeResultsByProject(projectId: string): Promise<ProbeResult[]>;
  getLostProbeResultsByProject(projectId: string): Promise<ProbeResult[]>;

  // M1 — internal-analysis LLM traceability (separate from probe evidence)
  recordAnalysisLlmCall(input: AnalysisLlmCallInput): Promise<AnalysisLlmCall>;
  getAnalysisLlmCallsByProject(projectId: string): Promise<AnalysisLlmCall[]>;

  // M1 second tranche — persisted provider failures (separate from probe_results)
  recordProbeFailure(input: RecordProbeFailureInput): Promise<ProbeFailure>;
  getProbeFailuresByProject(projectId: string): Promise<ProbeFailure[]>;

  // M2 canonical observations contract, first tranche (D-014) — dataset
  // identity.
  createDatasetBatch(input: DatasetBatchInput): Promise<DatasetBatch>;
  getDatasetBatchesByProject(projectId: string): Promise<DatasetBatch[]>;
  // M2 canonical observations contract, second tranche — probe_runs was
  // never append-only restricted, so this is a plain UPDATE, not an RPC.
  updateProbeRunDatasetIdentity(
    id: string,
    input: { datasetId: string; datasetSourceType: DatasetSourceType }
  ): Promise<void>;
  // M2 canonical observations contract, second tranche (D-015) — the
  // only path capable of writing dataset_id/dataset_source_type/
  // run_position/negative_claim_detected/observation_schema_version
  // onto an EXISTING probe_results row. probe_results has had UPDATE
  // revoked from service_role since migration 0036 (append-only); this
  // calls the SECURITY DEFINER RPC added by D-015, never a direct
  // UPDATE. New rows still set these columns at INSERT time via
  // saveProbeResult, which is unaffected by the 0036 revoke.
  backfillProbeResultDatasetIdentity(
    input: BackfillProbeResultDatasetIdentityInput
  ): Promise<BackfillProbeResultDatasetIdentityResult>;

  // M2 canonical observations contract, first tranche (D-014) — entity
  // resolution. No caller populates these yet; wiring is a later tranche.
  createCanonicalEntity(
    input: CanonicalEntityInput
  ): Promise<CanonicalEntity>;
  getCanonicalEntitiesByProject(
    projectId: string
  ): Promise<CanonicalEntity[]>;
  createEntityAlias(input: EntityAliasInput): Promise<EntityAlias>;
  getEntityAliasesByProject(projectId: string): Promise<EntityAlias[]>;

  // Sprint 4 — Competitor Discovery
  replaceCompetitorsForProject(
    projectId: string,
    competitors: CompetitorInput[]
  ): Promise<Competitor[]>;
  getCompetitorsByProject(projectId: string): Promise<Competitor[]>;

  // Sprint 5 — Gap Map
  saveGapMap(projectId: string, gapMapJson: unknown): Promise<GapMapRow>;
  getLatestGapMap(projectId: string): Promise<GapMapRow | null>;
  replaceGapsForProject(projectId: string, gaps: GapInput[]): Promise<Gap[]>;
  getGapsByProject(projectId: string): Promise<Gap[]>;

  // Sprint 6 — Evidence Bank
  upsertEvidenceBank(
    projectId: string,
    input: EvidenceBankRowInput
  ): Promise<EvidenceBankRow>;
  getEvidenceBankByProject(
    projectId: string
  ): Promise<EvidenceBankRow | null>;

  // Sprint 7 — Fix Brief
  saveFixBrief(
    projectId: string,
    input: FixBriefRowInput
  ): Promise<FixBriefRow>;
  getFixBriefsByProject(projectId: string): Promise<FixBriefRow[]>;
  getFixBrief(id: string): Promise<FixBriefRow | null>;
  updateFixBriefStatus(
    fixBriefId: string,
    status: string
  ): Promise<FixBriefRow | null>;

  // Sprint 8 — Generated Asset
  saveGeneratedAsset(
    projectId: string,
    input: GeneratedAssetRowInput
  ): Promise<GeneratedAssetRow>;
  getGeneratedAssetsByProject(projectId: string): Promise<GeneratedAssetRow[]>;
  getGeneratedAssetsByFixBrief(fixBriefId: string): Promise<GeneratedAssetRow[]>;
  getGeneratedAsset(id: string): Promise<GeneratedAssetRow | null>;
  /**
   * Sprint 9 addition. Update just the QA status field on a Generated
   * Asset after the QA Agent has produced a verdict. `updatedAt` is
   * refreshed by adapters.
   */
  updateGeneratedAssetQaStatus(
    assetId: string,
    qaStatus: string
  ): Promise<GeneratedAssetRow | null>;
  updateGeneratedAssetLifecycleStatus(
    assetId: string,
    lifecycleStatus: GeneratedAssetLifecycleStatus
  ): Promise<GeneratedAssetRow | null>;

  // Sprint 9 — QA Report
  saveQaReport(
    projectId: string,
    input: QaReportRowInput
  ): Promise<QaReportRow>;
  getQaReportsByProject(projectId: string): Promise<QaReportRow[]>;
  getQaReportsByGeneratedAsset(
    generatedAssetId: string
  ): Promise<QaReportRow[]>;
  getLatestQaReportForAsset(
    generatedAssetId: string
  ): Promise<QaReportRow | null>;
}

/* -------------------------------------------------------------------------- */
/*  Migration 0035 — snapshot report delivery fencing                          */
/* -------------------------------------------------------------------------- */

export interface ReplaceUndeliveredSnapshotReportArtifactInput {
  snapshotRequestId: string;
  expectedArtifactId: string;
  /** Canonical content revision from `snapshotReportArtifactRevision`. */
  expectedRevision: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
}

export interface SnapshotReportArtifactRevision {
  artifactId: string;
  revision: string;
}

export interface BeginSnapshotReportDeliveryInput {
  snapshotRequestId: string;
  expectedArtifactId: string;
  expectedRevision: string;
}

/**
 * The delivery payload a claim covers.
 *
 * `deliveryClaimToken` is server-only and must never be serialised to a
 * browser. `shortReportMarkdown` is what the provider must receive verbatim.
 */
export interface BegunSnapshotReportDelivery {
  artifactId: string;
  revision: string;
  deliveryClaimToken: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
}

export interface FinalizeSnapshotReportDeliveryInput {
  snapshotRequestId: string;
  artifactId: string;
  deliveryClaimToken: string;
  deliveryMessageId: string;
}

export interface FinalizedSnapshotReportDelivery {
  artifactId: string;
  deliveredAt: string;
}

export interface ReleaseSnapshotReportDeliveryClaimInput {
  snapshotRequestId: string;
  artifactId: string;
  deliveryClaimToken: string;
}
