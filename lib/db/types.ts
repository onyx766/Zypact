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
  | "legacy_unresolved"
  /** D-028 — dataset provenance for M5-authored probe_results rows. */
  | "protocol_execution_job";

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
  /**
   * M1-A evidence contract — the exact UTF-8 JSON body sent to the probe
   * provider, byte-identical to what went on the wire and to what
   * fullRequestBodySha256 hashes. Distinct from rawProbeRequest (the
   * buyer prompt) and rawResponseBody (the reply). Null for pasted or
   * manual answers, and for rows written before M1-A: a body that was
   * never captured is never reconstructed from its hash.
   */
  fullRequestBody?: string | null;
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
  /**
   * D-028 — SHA-256 identity of the *parsed* result (a versioned
   * canonical JSON over every persisted field except `id`/`createdAt`),
   * computed exclusively server-side by `persistProbeResultForJob`.
   * Distinct from `analysisReceipt.responseSha256` (D-026), which proves
   * only the lineage of the raw model output. Null for every row saved
   * before this column existed.
   */
  canonicalResultSha256?: string | null;
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
  /**
   * M3 — source unique: links this row to the M2 canonical
   * entity-resolution layer (canonical_entities.id, same project,
   * entity_type='competitor'). Set only by an exact match between this
   * row's name and a rawText actually observed for that canonical entity
   * (lib/pipeline/discover-competitors.ts) — never by normalizeKey() or
   * any other fuzzy match. NULL is an explicit, expected state: rows from
   * discoverySource 'user'/'client_site'/'model_knowledge', and any
   * 'ai_answer' row whose returned name did not exactly match an observed
   * mention (e.g. an LLM paraphrase), have no canonical identity to link.
   * Mandatory field, not optional — every constructor must decide it.
   */
  canonicalEntityId: string | null;
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
  /**
   * M1-A evidence contract — the exact UTF-8 JSON body sent to the probe
   * provider, byte-identical to what went on the wire and to what
   * fullRequestBodySha256 hashes. Distinct from rawProbeRequest (the
   * buyer prompt) and rawResponseBody (the reply). Null for pasted or
   * manual answers, and for rows written before M1-A: a body that was
   * never captured is never reconstructed from its hash.
   */
  fullRequestBody?: string | null;
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
  /**
   * M1-A evidence contract — the exact UTF-8 JSON body sent to the probe
   * provider, byte-identical to what went on the wire and to what
   * fullRequestBodySha256 hashes. Distinct from rawProbeRequest (the
   * buyer prompt) and rawResponseBody (the reply). Null for pasted or
   * manual answers, and for rows written before M1-A: a body that was
   * never captured is never reconstructed from its hash.
   */
  fullRequestBody?: string | null;
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
  /**
   * M2 canonical observations contract, third tranche (D-017 §6) —
   * added by migration 0041. Together with `(projectId, normalizedText)`
   * this is the table's only uniqueness key; `entityType` is
   * deliberately not part of it, which is what makes client/competitor
   * exclusivity structural. The "active" mapping for a given
   * `(projectId, normalizedText)` is always the row with the highest
   * `aliasGeneration` — see `getEntityAliasesActiveByProject`.
   */
  aliasGeneration: number;
  createdAt: string;
}

/**
 * M2 canonical observations contract, third tranche (D-017, D-018,
 * D-019). Types for the two SECURITY DEFINER RPCs added by migration
 * 0042 and the active-head read views added by migration 0041.
 */
export type EntityType = "client" | "competitor" | "platform";

/** The entity_resolution_passes table's own status column — three values. */
export type EntityResolutionPassRowStatus = "in_progress" | "completed" | "abandoned";

/**
 * What either RPC's own `pass_status` return field can contain — two
 * values only. `'abandoned'` never appears here: a call against an
 * abandoned pass raises rather than returning a status, and
 * `start_or_resume_entity_resolution_pass`'s own lookup only ever
 * matches rows with `status in ('completed','in_progress')`.
 */
export type EntityResolutionPassStatus = "in_progress" | "completed";

export type EntityResolutionPassOutcome = "STARTED" | "RESUMED" | "ALREADY_COMPLETED";

export type EntityObservationStatus =
  | "resolved"
  | "ambiguous"
  | "unresolved"
  | "excluded_brand_self";

/**
 * `SUPERSEDED_PRIOR` never fires for observations (D-017 §2, revision
 * 6 correction) — a correction is always a new pass at a higher
 * `resolverVersion`, producing a fresh generation-1 `APPLIED` row, not
 * a same-pass supersession.
 */
export type EntityObservationOutcome = "APPLIED" | "ALREADY_APPLIED" | "CONFLICT";

export type EntityAliasOutcome =
  | "APPLIED"
  | "ALREADY_APPLIED"
  | "SUPERSEDED_PRIOR"
  | "CONFLICT"
  | "NOT_APPLICABLE";

/**
 * M2 canonical observations contract, third tranche (D-017) — freezes
 * the exact brand-term inputs used for one
 * `(projectId, datasetId, resolverVersion)`, created once by
 * `startOrResumeEntityResolutionPass` and never recomputed.
 */
export interface EntityBrandSnapshot {
  id: string;
  projectId: string;
  datasetId: string;
  resolverVersion: number;
  companyName: string;
  domain: string;
  mirrorAliases: string[];
  normalizedBrandTerms: string[];
  createdAt: string;
}

/**
 * M2 canonical observations contract, third tranche (D-017) — tracks
 * one resolution attempt per `(probeResultId, resolverVersion)`. Note:
 * this table has no `createdAt` column — `startedAt` is its creation
 * timestamp instead (verified mechanically against migration 0041).
 */
export interface EntityResolutionPass {
  id: string;
  projectId: string;
  probeResultId: string;
  resolverVersion: number;
  datasetId: string;
  datasetSourceType: DatasetSourceType;
  brandSnapshotId: string;
  expectedMentionCount: number;
  status: EntityResolutionPassRowStatus;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
}

type EntityObservationBase = {
  id: string;
  probeResultId: string;
  probeRunId: string;
  generatedPromptId: string | null;
  projectId: string;
  datasetId: string;
  datasetSourceType: DatasetSourceType;
  resolutionPassId: string;
  rawText: string;
  normalizedText: string;
  resolverVersion: number;
  mentionOrdinal: number;
  context: string | null;
  observationGeneration: number;
  createdAt: string;
};

/**
 * M2 canonical observations contract, third tranche (D-017 §4) — a
 * discriminated union, not loose nullable fields, because migration
 * 0041's `entity_observations_status_entity_check` correlates
 * `status`, `entityType`, and `canonicalEntityId`: they are never
 * independently nullable. This makes an illegal combination (e.g.
 * `status: "resolved"` with `entityType: "client"`, or with a null
 * `canonicalEntityId`) a compile error, matching the database's own
 * constraint exactly rather than merely documenting it.
 */
export type EntityObservation = EntityObservationBase &
  (
    | { status: "resolved"; entityType: "competitor" | "platform"; canonicalEntityId: string }
    | { status: "excluded_brand_self"; entityType: "client"; canonicalEntityId: string }
    | { status: "ambiguous" | "unresolved"; entityType: null; canonicalEntityId: null }
  );

export interface StartOrResumeEntityResolutionPassInput {
  projectId: string;
  probeResultId: string;
  resolverVersion: number;
  datasetId: string;
  expectedMentionCount: number;
  companyName: string;
  domain: string;
  normalizedBrandTerms: string[];
  mirrorAliases?: string[];
  /** Maps to the RPC's `p_stale_after` interval. Omit to use the function's own default (15 minutes). */
  staleAfterSeconds?: number;
}

export interface StartOrResumeEntityResolutionPassResult {
  resolutionPassId: string;
  passStatus: EntityResolutionPassStatus;
  passOutcome: EntityResolutionPassOutcome;
}

export interface ResolveAndRecordEntityObservationInput {
  resolutionPassId: string;
  mentionOrdinal: number;
  rawText: string;
  normalizedText: string;
  status: EntityObservationStatus;
  proposedEntityType?: EntityType | null;
  context?: string | null;
}

export interface ResolveAndRecordEntityObservationResult {
  observationId: string;
  observationGeneration: number;
  observationOutcome: EntityObservationOutcome;
  aliasId: string | null;
  aliasGeneration: number | null;
  aliasOutcome: EntityAliasOutcome;
  passStatus: EntityResolutionPassStatus;
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

export type SnapshotRequestOrigin = "public_form" | "founder";

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
  /**
   * The public form's "Your name" field (migration 0061). Nullable: rows
   * created before this field existed have no value and are never
   * backfilled. The public form and its zod schema require it for new
   * submissions; the database only guarantees the column accepts null.
   */
  contactName: string | null;
  websiteUrl: string;
  normalizedDomain: string;
  /**
   * Despite the name, this holds the full "one buyer question" text
   * entered on the public form, not a short category phrase — the column
   * predates that framing and was reused rather than duplicated (see
   * migration 0017 and lib/snapshot-requests/normalize-request.ts).
   */
  buyerCategory: string;
  status: SnapshotRequestStatus;
  /**
   * How the request was created (migration 0081). `public_form` is every row
   * that came through the guarded RPC, including all rows that predate the
   * column; `founder` is one the founder created for a prospect who never
   * filled in the form. Kept distinct so admin counts do not mix customer
   * demand with founder-initiated work.
   */
  origin: SnapshotRequestOrigin;
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
   * The approved M4 protocol launched for this request (migration 0062),
   * set only by `approveAndLaunchSnapshotBaseline`. Null for every request
   * approved through the legacy `approveAndQueueSnapshotRequest` path.
   * `buyer_question_version_id`/`buyer_question_id` are reachable from
   * here via `protocols.buyer_question_version_id` and are not duplicated
   * as separate columns on this row.
   */
  protocolId: string | null;
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
  /**
   * Canonical V1 protocol report, when this artifact was produced by the
   * M4/M5 path. Optional and null for legacy mvp-scan artifacts, which the
   * client page still serves by parsing `shortReportMarkdown`.
   */
  reportPayload?: unknown | null;
  /**
   * Canonical integrity decision recorded when the artifact was written
   * (0068). Null for legacy artifacts. `blocked` is never rendered to a
   * client and never delivered.
   */
  integrityStatus?: "integrity_passed" | "needs_review" | "blocked" | null;
  integrityReasons?: string[] | null;
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
  /** Optional so pre-existing callers that never collected a name are unaffected; see SnapshotRequest.contactName. */
  contactName?: string | null;
  websiteUrl: string;
  normalizedDomain: string;
  buyerCategory: string;
  requestIpHash?: string | null;
}

/**
 * A founder-created audit (migration 0081).
 *
 * Deliberately not `CreateSnapshotRequestInput`: there is no `requestIpHash`,
 * because the founder's own address is not the abuse signal that column
 * exists to carry, and passing one would put a misleading value in a row
 * every other reader interprets as a public submitter's network.
 */
export interface CreateFounderSnapshotRequestInput {
  workEmail: string;
  normalizedEmail: string;
  companyName: string;
  contactName?: string | null;
  websiteUrl: string;
  normalizedDomain: string;
  buyerCategory: string;
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

/* -------------------------------------------------------------------------- */
/*  M4 — buyer question identity, protocol, and paid-attempt ledger          */
/*                                                                            */
/*  Legacy notice: nothing here recreates the pre-M4 five-prompt/three-run/  */
/*  $2 defaults (scripts/mvp-scan.ts, lib/snapshot-worker/execution-         */
/*  options.ts) or the legacy won/partial/lost verdict. Those remain frozen  */
/*  legacy paths, unmodified by M4 and never a silent fallback target for    */
/*  any type below.                                                         */
/* -------------------------------------------------------------------------- */

export type BuyerQuestionProvenance =
  | "customer_supplied"
  | "crm_evidence"
  | "founder_supplied"
  | "model_assisted_reviewed"
  | "public_benchmark";

export interface BuyerQuestion {
  id: string;
  projectId: string;
  createdAt: string;
}

export interface CreateBuyerQuestionInput {
  projectId: string;
}

/**
 * Rule 1 — a text change is always a new row (a new `versionNumber` for
 * the same `buyerQuestionId`), never a mutation of an existing one.
 * `promptHash` is the SHA-256 of the normalized prompt text, computed
 * exclusively by the TypeScript application layer (same authority
 * pattern as `lib/evidence/normalize-entity-text.ts`, D-019) — never
 * recomputed or verified in SQL.
 */
export interface BuyerQuestionVersion {
  id: string;
  buyerQuestionId: string;
  projectId: string;
  versionNumber: number;
  promptText: string;
  promptHash: string;
  intentType: string;
  commercialValue: number;
  winnability: number;
  priority: number;
  rationale: string;
  provenance: BuyerQuestionProvenance;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface CreateBuyerQuestionVersionInput {
  buyerQuestionId: string;
  projectId: string;
  versionNumber: number;
  promptText: string;
  promptHash: string;
  intentType: string;
  commercialValue: number;
  winnability: number;
  priority: number;
  rationale: string;
  provenance: BuyerQuestionProvenance;
}

export type ApproveBuyerQuestionVersionOutcome =
  | "APPROVED"
  | "ALREADY_APPROVED"
  | "NOT_FOUND";

export interface ApproveBuyerQuestionVersionInput {
  versionId: string;
  projectId: string;
  approvedBy: string;
}

export interface ApproveBuyerQuestionVersionResult {
  outcome: ApproveBuyerQuestionVersionOutcome;
  version: BuyerQuestionVersion | null;
}

export type ProtocolStatus =
  | "draft"
  | "approved"
  | "active"
  | "completed"
  | "abandoned";

/**
 * One protocol per approved `buyerQuestionVersionId` (product rule:
 * exactly 1:1, enforced by a partial unique index in migration 0047).
 * A retest protocol references its own baseline via
 * `baselineProtocolId`.
 *
 * Rule 3/4 — `plannedBaselineRuns + plannedRetestRuns` is the plan;
 * `runCap` is only ever an upper bound on top of it (`runCap >=` the
 * sum), never the plan itself. Rule 5/6 — no field here carries a
 * universal default; every value must be supplied by the caller.
 */
export interface Protocol {
  id: string;
  projectId: string;
  buyerQuestionVersionId: string;
  baselineProtocolId: string | null;
  provider: string;
  surface: string;
  modelConfig: Record<string, unknown>;
  plannedBaselineRuns: number;
  plannedRetestRuns: number;
  /** Rule 2 — each entry is an explicitly declared variant with its own exact text and hash, never a silent rewording. */
  paraphrasePlan: Array<{ text: string; hash: string }>;
  unitOfAnalysis: string;
  primaryMetric: string;
  minimumUsefulChange: unknown;
  samplePlanningMethod: string;
  samplePlanningAssumptions: Record<string, unknown>;
  runCap: number;
  spendCapUsd: number;
  timeWindowSeconds: number;
  rateLimitPerHour: number;
  concurrencyLimit: number;
  retryCap: number;
  observationWindowRule: Record<string, unknown>;
  analyzerVersion: number;
  entityResolutionVersion: number;
  methodologyVersion: string;
  status: ProtocolStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  /**
   * The smallest change this protocol's sampling plan could detect at all,
   * as a proportion in [0, 1], stamped by `approve_protocol` at the moment of
   * approval (migration 0075) and null for protocols approved before it.
   *
   * This is a disclosure, not a result: it says what the plan is capable of
   * seeing before any run happens. At the five-run default it is 0.60 — equal
   * to Δ_min — meaning only a change of 60 points or more is detectable.
   * §5 of the signed-off OUTCOME_COMPARISON_PROPOSAL requires it be visible
   * wherever a protocol is approved.
   */
  detectableChangeAtPlan: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProtocolInput {
  projectId: string;
  buyerQuestionVersionId: string;
  baselineProtocolId?: string | null;
  provider: string;
  surface: string;
  modelConfig?: Record<string, unknown>;
  plannedBaselineRuns: number;
  plannedRetestRuns: number;
  paraphrasePlan?: Array<{ text: string; hash: string }>;
  unitOfAnalysis: string;
  primaryMetric: string;
  minimumUsefulChange?: unknown;
  samplePlanningMethod: string;
  samplePlanningAssumptions?: Record<string, unknown>;
  runCap: number;
  spendCapUsd: number;
  timeWindowSeconds: number;
  rateLimitPerHour: number;
  concurrencyLimit: number;
  retryCap: number;
  observationWindowRule?: Record<string, unknown>;
  analyzerVersion?: number;
  entityResolutionVersion?: number;
  methodologyVersion?: string;
}

export type ApproveProtocolOutcome =
  | "APPROVED"
  | "ALREADY_APPROVED"
  | "NOT_FOUND"
  | "VERSION_NOT_APPROVED"
  | "CONFLICT";

export interface ApproveProtocolInput {
  protocolId: string;
  projectId: string;
  approvedBy: string;
}

export interface ApproveProtocolResult {
  outcome: ApproveProtocolOutcome;
  protocol: Protocol | null;
}

export type AttemptKind = "baseline" | "retest" | "control" | "paraphrase";

export type ProtocolAttemptStatus =
  | "reserved"
  | "in_progress"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "excluded";

/**
 * The admission/reservation/reconciliation ledger — one row per paid
 * provider-call attempt. Rule 10 — `probeRunId` starts `null` and is
 * only ever set by `startAttempt`, called strictly after
 * `admitAndReserveAttempt` already produced a `"reserved"` row: the
 * reservation always exists before any `probe_runs` row or provider
 * call. Rule 12 — `retryOfAttemptId` links a retry to the attempt it
 * retries; it is never the same row.
 */
export interface ProtocolAttempt {
  id: string;
  projectId: string;
  protocolId: string;
  buyerQuestionVersionId: string;
  attemptKind: AttemptKind;
  status: ProtocolAttemptStatus;
  idempotencyKey: string;
  reservedCostUsd: number;
  actualCostUsd: number | null;
  probeRunId: string | null;
  retryOfAttemptId: string | null;
  terminationReason: string | null;
  reservedAt: string;
  lastActivityAt: string;
  terminalizedAt: string | null;
  createdAt: string;
  /**
   * M5 (migration 0050) — nullable, no backfill: null for every
   * pre-M5 row (including the real M4 staging rows already written
   * before this column existed) and for any future attempt admitted
   * outside a job (the raw M4 RPC path, still callable until the
   * cutover migration). Set only by the *_for_job admission RPCs.
   */
  jobId: string | null;
  /**
   * D-025 — the baseline slot (1-based) this attempt belongs to. Null for
   * every attempt with a null jobId (pre-D-025 M4/M5 rows); mandatory
   * whenever jobId is set. A retry child always carries the same value
   * as its source — a retry never consumes a new slot.
   */
  baselineOrdinal: number | null;
}

export type AdmitAndReserveAttemptOutcome =
  | "RESERVED"
  | "ALREADY_RESERVED"
  | "NOT_FOUND"
  | "PROTOCOL_NOT_APPROVED"
  | "RUN_CAP_EXCEEDED"
  | "SPEND_CAP_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "RETRY_CAP_EXCEEDED"
  | "INVALID_RETRY_REFERENCE";

/**
 * Rule 9 — the adapter implementation (real RPC in Supabase; an
 * equivalent synchronous, lock-free-but-atomic check-then-write in the
 * memory adapter) must perform every cap check and the final
 * reservation inside one atomic operation, after establishing an
 * exclusive view of the protocol's current state — never two separate
 * round trips a concurrent caller could interleave with.
 */
export interface AdmitAndReserveAttemptInput {
  protocolId: string;
  projectId: string;
  attemptKind: AttemptKind;
  /** Rule 11 — a duplicate key returns the existing attempt, never a new reservation. */
  idempotencyKey: string;
  estimatedCostUsd: number;
  /** Rule 12 — set only when this call is a retry of a prior attempt. */
  retryOfAttemptId?: string | null;
}

export interface AdmitAndReserveAttemptResult {
  outcome: AdmitAndReserveAttemptOutcome;
  attempt: ProtocolAttempt | null;
}

export type StartAttemptOutcome =
  | "STARTED"
  | "ALREADY_STARTED"
  | "NOT_FOUND"
  | "CONFLICT";

export interface StartAttemptInput {
  attemptId: string;
  projectId: string;
  probeRunId: string;
}

export interface StartAttemptResult {
  outcome: StartAttemptOutcome;
  attempt: ProtocolAttempt | null;
}

export type ReconcileAttemptStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "excluded";

export type ReconcileAttemptOutcome =
  | "RECONCILED"
  | "ALREADY_RECONCILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATUS";

/** Rule 13 — the only path to a terminal status; always carries the real cost. */
export interface ReconcileAttemptInput {
  attemptId: string;
  projectId: string;
  status: ReconcileAttemptStatus;
  actualCostUsd: number;
  probeRunId?: string | null;
  terminationReason?: string | null;
}

export interface ReconcileAttemptResult {
  outcome: ReconcileAttemptOutcome;
  attempt: ProtocolAttempt | null;
}

/* -------------------------------------------------------------------------- */
/*  M5-2 Stage A — protocol execution jobs, external-call ledger, worker RPCs */
/*  (D-020, D-021, D-022, D-023). Types and adapter contracts only: no        */
/*  worker, no CLI wiring, no provider integration in this tranche.          */
/*                                                                            */
/*  start_attempt_for_job and reserve_additional_analysis_generation_for_job */
/*  are deliberately absent below — D-023 names                              */
/*  create_probe_run_and_start_attempt_for_job as the sole canonical start   */
/*  path, and reserve_additional_analysis_generation_for_job has been        */
/*  revoked from service_role since migration 0051 with no remaining         */
/*  legitimate caller (D-021/D-022).                                         */
/* -------------------------------------------------------------------------- */

export type ProtocolExecutionJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "abandoned_exhausted";

export interface ProtocolExecutionJob {
  id: string;
  projectId: string;
  protocolId: string;
  status: ProtocolExecutionJobStatus;
  workerId: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  /**
   * D-020 — the attempt this job currently owns; null before first
   * admission, and (D-025) null again between a completed baseline slot
   * and the admission of the next one.
   */
  currentAttemptId: string | null;
  /**
   * D-025 — the 1-based ordinal of the next baseline slot to admit.
   * Starts at 1; advances by exactly 1 each time complete_protocol_
   * execution_job returns NEXT_BASELINE_REQUIRED. Never exceeds
   * protocols.planned_baseline_runs.
   */
  nextBaselineOrdinal: number;
  needsReviewReason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * D-026 (correction) — a durable attribute of the job itself, chosen
   * exactly once, atomically with the job, by `enqueueProtocolExecutionJob`
   * (migration 0052). Never null: the column carries a real NOT NULL
   * constraint, project-scoped by a composite FK to
   * `dataset_batches (id, project_id)`, and UNIQUE — one batch never
   * serves two jobs. This is the sole source of dataset identity for
   * every baseline slot, retry, reclaim, and reactivation under this
   * job; `createProbeRunAndStartAttemptForJob` derives the dataset from
   * this field alone and no longer accepts one as an argument.
   */
  datasetBatchId: string;
}

export type ExternalCallKind = "perplexity" | "analysis";

export type ExternalCallStatus =
  | "reserved"
  | "in_progress"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

/**
 * D-023 §3 — application-level vocabulary only in Stage A. The
 * `protocol_external_calls.cost_basis` CHECK constraint (migration 0050)
 * presently allows only `measured`/`estimated`; reconciling `unknown`
 * into that schema-level CHECK is cutover-migration territory, not this
 * tranche. Adapters accept `"unknown"` on the input side (paired with a
 * null `actualCostUsd`) but this value is never sent to Postgres today —
 * see the Supabase adapter implementation notes.
 */
export type CostBasis = "measured" | "estimated" | "unknown";

export interface ProtocolExternalCall {
  id: string;
  projectId: string;
  protocolAttemptId: string;
  callKind: ExternalCallKind;
  generation: number;
  status: ExternalCallStatus;
  reservedCostUsd: number;
  actualCostUsd: number | null;
  costBasis: CostBasis | null;
  probeRunId: string | null;
  requestSentAt: string | null;
  terminalizedAt: string | null;
  /** 0051 — never changes once set; the structural replay key for retries. */
  retryOfExternalCallId: string | null;
  createdAt: string;
  /**
   * D-027 — set only via `mark_analysis_parse_failed_for_job`, only on a
   * `call_kind='analysis'` row whose own status is already 'completed'
   * (a real receipt succeeded) but whose content failed local
   * JSON/Zod/normalization parsing. Paired with `parseFailureCode`
   * (both null or both set); never set for a provider-side failure.
   */
  parseFailedAt: string | null;
  /** D-027 — bounded to the same three codes `parseAnalysisContentOnce` returns. Paired with `parseFailedAt`. */
  parseFailureCode: ParseAnalysisFailureCode | null;
}

/**
 * D-027 — the same three bounded codes `lib/pipeline/parse-analysis-content.ts`'s
 * `parseAnalysisContentOnce` returns (never a free-text Zod/JSON message).
 */
export type ParseAnalysisFailureCode =
  | "invalid_json"
  | "schema_validation_failed"
  | "normalization_failed";

export type ExternalCallReceiptOutcome =
  | "success"
  | "provider_error"
  | "provider_outcome_unknown";

/**
 * `provider_call_receipts` (migration 0050, extended by D-026/0052).
 * Note there is no raw-request-hash column here — only the response is
 * hashed at the receipt level for the Perplexity leg (D-023 §3 is
 * explicit that this decision does not add one).
 */
export interface ProviderCallReceipt {
  id: string;
  projectId: string;
  externalCallId: string;
  probeRunId: string;
  outcome: ExternalCallReceiptOutcome;
  httpStatus: number | null;
  providerRequestId: string | null;
  rawResponseSha256: string | null;
  latencyMs: number | null;
  receivedAt: string;
  createdAt: string;
  /**
   * D-026 — the exact response text, paired with rawResponseSha256 (both
   * null or both set; a real CHECK constraint verifies the hash actually
   * matches this content, and outcome='success' requires it). Lets a
   * crash before the analysis leg replay Perplexity's answer without a
   * second live call. Service-role only — never surfaced in the
   * monitoring view or a client-facing response.
   */
  rawResponseBody: string | null;
}

export type AnalysisCallReceiptProvider = "openai" | "anthropic" | "mock";

/**
 * `analysis_call_receipts` (migration 0050, extended by D-026/0052) —
 * unlike the Perplexity leg, both request and response hashes exist
 * here.
 */
export interface AnalysisCallReceipt {
  id: string;
  projectId: string;
  externalCallId: string;
  probeRunId: string;
  outcome: ExternalCallReceiptOutcome;
  provider: AnalysisCallReceiptProvider | null;
  model: string | null;
  usedMock: boolean;
  requestSha256: string | null;
  responseSha256: string | null;
  latencyMs: number | null;
  /** TK-R-2 — provider-assigned request id; null for historical rows and for mock. */
  providerRequestId: string | null;
  /** TK-R-3 — HTTP status of the provider response; null for historical rows and when none was received. */
  httpStatus: number | null;
  /** TK-R-1 — model the provider reported serving; null for historical rows, for mock, and when absent. */
  modelReturned: string | null;
  receivedAt: string;
  createdAt: string;
  /**
   * D-026 — the exact analysis output text, paired with responseSha256
   * (both null or both set; a real CHECK constraint verifies the hash
   * matches; outcome='success' requires it). Lets a crash before
   * `saveProbeResult` replay the agent's output without a second live
   * LLM call. Pairs only with responseSha256 — requestSha256 stays
   * hash-only in this tranche, since `callModel()` does not yet expose
   * the exact outbound bytes it sends (a call-model.ts change, out of
   * scope here). Service-role only.
   */
  rawContent: string | null;
  /**
   * D-027 — the exact outbound request body text, paired with
   * requestSha256 (both null or both set; a real CHECK constraint
   * verifies the hash matches). A strict used_mock policy applies:
   * usedMock=true requires both null (nothing real to durabilize for a
   * simulated call); usedMock=false requires both non-null (a real call
   * must always carry its exact request). Service-role only.
   */
  rawRequestBody: string | null;
}

export type OperatorActionType =
  | "retry_full_attempt"
  | "retry_analysis_only"
  | "reactivate_abandoned_job";

export type OperatorActionOutcome = "approved" | "denied";

/** `protocol_operator_actions` (migration 0047, extended by 0051 with idempotency_key/request_fingerprint). */
export interface ProtocolOperatorAction {
  id: string;
  projectId: string;
  jobId: string;
  actor: string;
  reason: string;
  action: OperatorActionType;
  outcome: OperatorActionOutcome;
  denialCode: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  newAttemptId: string | null;
  newExternalCallId: string | null;
  createdAt: string;
}

export type EnqueueProtocolExecutionJobOutcome =
  | "QUEUED"
  | "ALREADY_EXISTS"
  | "PROTOCOL_NOT_FOUND"
  | "PROTOCOL_NOT_APPROVED"
  /** D-025 — planned_baseline_runs = 0; refused before any job row is created. */
  | "NO_BASELINE_RUNS_PLANNED";

export interface EnqueueProtocolExecutionJobInput {
  protocolId: string;
  projectId: string;
  maxAttempts?: number;
}

export interface EnqueueProtocolExecutionJobResult {
  outcome: EnqueueProtocolExecutionJobOutcome;
  job: ProtocolExecutionJob | null;
}

export type ClaimProtocolExecutionJobOutcome = "CLAIMED" | "NO_JOB_AVAILABLE";

export interface ClaimProtocolExecutionJobInput {
  workerId: string;
  leaseSeconds: number;
}

export interface ClaimProtocolExecutionJobResult {
  outcome: ClaimProtocolExecutionJobOutcome;
  job: ProtocolExecutionJob | null;
  claimToken: string | null;
}

/**
 * D-031 — the targeted claim surface, beside the global one and never in
 * place of it. Four closed outcomes: a claim, an addressing failure, an
 * eligibility failure, and a lost race against a concurrent holder.
 */
export type ClaimProtocolExecutionJobByIdOutcome =
  | "CLAIMED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_ELIGIBLE"
  | "JOB_LOCKED";

export interface ClaimProtocolExecutionJobByIdInput {
  workerId: string;
  leaseSeconds: number;
  jobId: string;
  projectId: string;
}

export interface ClaimProtocolExecutionJobByIdResult {
  outcome: ClaimProtocolExecutionJobByIdOutcome;
  job: ProtocolExecutionJob | null;
  claimToken: string | null;
}

/**
 * D-031 — the post-claim verification barrier. Read-only, and answered with
 * one closed label: a verifier that returned rows or identifiers would become
 * a way to read tenant state through an outcome string.
 */
export type VerifyPhase3dCanaryPostClaimOutcome =
  | "VERIFIED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED"
  | "JOB_NOT_CLEAN"
  | "PROTOCOL_NOT_ELIGIBLE";

export interface VerifyPhase3dCanaryPostClaimInput {
  workerId: string;
  jobId: string;
  projectId: string;
  claimToken: string;
}

export interface VerifyPhase3dCanaryPostClaimResult {
  outcome: VerifyPhase3dCanaryPostClaimOutcome;
}

export type RenewProtocolExecutionJobLeaseOutcome =
  | "RENEWED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface RenewProtocolExecutionJobLeaseInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  leaseSeconds: number;
}

export interface RenewProtocolExecutionJobLeaseResult {
  outcome: RenewProtocolExecutionJobLeaseOutcome;
  job: ProtocolExecutionJob | null;
}

/**
 * Every outcome the shared `_admit_and_reserve_attempt_core` can
 * propagate (RUN_CAP_EXCEEDED and siblings), plus the job-fencing and
 * D-021/D-022 resumption outcomes specific to the `_for_job` wrapper.
 */
export type AdmitAndReserveAttemptForJobOutcome =
  | "RESERVED"
  | "RESUME_CURRENT_ATTEMPT"
  | "CURRENT_ATTEMPT_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED"
  | "NOT_FOUND"
  | "PROTOCOL_NOT_APPROVED"
  | "ALREADY_RESERVED"
  | "RUN_CAP_EXCEEDED"
  | "SPEND_CAP_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "RETRY_CAP_EXCEEDED"
  | "INVALID_RETRY_REFERENCE"
  /**
   * D-025 — no current attempt, but idempotencyKey does not equal the
   * deterministic `${jobId}:baseline:${nextBaselineOrdinal}` identity.
   * Zero mutation.
   */
  | "INVALID_IDEMPOTENCY_KEY"
  /**
   * D-025 — defensive guard: next_baseline_ordinal already exceeds
   * planned_baseline_runs. Should be unreachable in normal operation
   * (a succeeded job is already refused by JOB_NOT_OWNED above).
   */
  | "BASELINE_SLOTS_EXHAUSTED";

export interface AdmitAndReserveAttemptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  attemptKind: AttemptKind;
  /**
   * D-025 — ignored on a RESUME_CURRENT_ATTEMPT reply, but on a fresh
   * (no current attempt) admission this must equal exactly
   * `${jobId}:baseline:${nextBaselineOrdinal}` or the call is refused
   * with INVALID_IDEMPOTENCY_KEY and zero mutation. next_baseline_
   * ordinal, not the caller, is the single source of truth for which
   * slot is being admitted.
   */
  idempotencyKey: string;
  perplexityReservedCostUsd: number;
  analysisReservedCostUsd: number;
  retryOfAttemptId?: string | null;
}

export interface AdmitAndReserveAttemptForJobResult {
  outcome: AdmitAndReserveAttemptForJobOutcome;
  attempt: ProtocolAttempt | null;
  perplexityCall: ProtocolExternalCall | null;
  analysisCall: ProtocolExternalCall | null;
}

/** D-023 §1 — the sole canonical start RPC; `start_attempt_for_job` is not exposed on `DbAdapter`. */
export type CreateProbeRunAndStartAttemptForJobOutcome =
  | "STARTED"
  | "ALREADY_STARTED"
  | "CONFLICT"
  | "ATTEMPT_TERMINAL"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

/**
 * D-026 (correction) — `datasetId`/`datasetSourceType` are deliberately
 * absent here: migration 0052 removed both parameters from
 * `create_probe_run_and_start_attempt_for_job`'s signature. The dataset
 * is derived exclusively from `job.datasetBatchId`; no caller (worker)
 * may supply, or override, one. A caller must never call
 * `resolveDatasetBatchForInvocation`/`createManualScanDatasetBatch` to
 * produce a value for this input — there is no field left to put it in.
 */
export interface CreateProbeRunAndStartAttemptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  attemptId: string;
  platform: string;
  probeMode: ProbeMode;
}

export interface CreateProbeRunAndStartAttemptForJobResult {
  outcome: CreateProbeRunAndStartAttemptForJobOutcome;
  attempt: ProtocolAttempt | null;
  probeRun: ProbeRun | null;
}

export type MarkExternalCallSentForJobOutcome =
  /** The only outcome that authorises a network call. */
  | "SENT"
  /**
   * 0056 — the call already left `reserved` and this exact request is on
   * record. It was sent once; the caller replays from its receipt and
   * never touches the wire.
   */
  | "ALREADY_SENT_SAME_EVIDENCE"
  /**
   * 0056 — no evidence where there should be some, or evidence that is
   * not this request. The job is moved to needs_review with an outbox row
   * inside the same transaction.
   */
  | "REQUEST_EVIDENCE_CONFLICT"
  | "WRONG_CALL_KIND"
  | "CONFLICT"
  | "NOT_FOUND"
  | "CALL_NOT_OWNED_BY_JOB"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

/**
 * 0056 — the exact outbound request, recorded before the wire.
 *
 * One immutable row per external call. `requestBody` is the body only:
 * no header, no key, no token ever reaches this table.
 */
export interface ExternalCallRequest {
  id: string;
  projectId: string;
  externalCallId: string;
  callKind: ExternalCallKind;
  requestBody: string;
  requestBodySha256: string;
  recordedAt: string;
}

export interface MarkExternalCallSentForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  externalCallId: string;
  probeRunId: string;
  /** 0056 — must equal the call's own kind, or WRONG_CALL_KIND. */
  callKind: ExternalCallKind;
  /** 0056 — the exact bytes about to go on the wire. Body only. */
  requestBody: string;
  /** 0056 — SHA-256 of `requestBody`, verified server-side. */
  requestBodySha256: string;
}

export interface MarkExternalCallSentForJobResult {
  outcome: MarkExternalCallSentForJobOutcome;
  externalCall: ProtocolExternalCall | null;
}

/**
 * 0056 — CONFLICT alone could not say whether the same RPC was replayed
 * after losing its reply, or whether a second provider call happened. The
 * identity comparison now covers every evidentiary field, latency and
 * cost included: a second call cannot reproduce a latency, so it conflicts
 * rather than passing as a replay. Both new outcomes return the existing
 * durable receipt, so a replay reads the ledger and never the response in
 * hand.
 */
export type RecordProviderCallReceiptForJobOutcome =
  | "ALREADY_RECEIPTED_IDENTICAL"
  | "RECEIPT_EVIDENCE_CONFLICT"
  | "REQUEST_EVIDENCE_CONFLICT"
  | "RECEIPTED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "WRONG_CALL_KIND"
  | "CALL_NOT_OWNED_BY_JOB"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface RecordProviderCallReceiptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  externalCallId: string;
  probeRunId: string;
  outcome: ExternalCallReceiptOutcome;
  httpStatus?: number | null;
  providerRequestId?: string | null;
  rawResponseSha256?: string | null;
  latencyMs?: number | null;
  /** D-023 §3 — populate only when a real cost is known; leave both this and costBasis unset otherwise. */
  actualCostUsd?: number | null;
  costBasis?: CostBasis | null;
  /**
   * D-026 — the exact response text. Must be paired with
   * rawResponseSha256 (both set or both omitted) and is mandatory when
   * outcome is 'success'; the real SQL CHECK constraint rejects a
   * mismatched hash/content pair, not merely application discipline.
   */
  rawResponseBody?: string | null;
}

export interface RecordProviderCallReceiptForJobResult {
  outcome: RecordProviderCallReceiptForJobOutcome;
  externalCall: ProtocolExternalCall | null;
  receipt: ProviderCallReceipt | null;
}

export type RecordAnalysisCallReceiptForJobOutcome = RecordProviderCallReceiptForJobOutcome;

export interface RecordAnalysisCallReceiptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  externalCallId: string;
  probeRunId: string;
  outcome: ExternalCallReceiptOutcome;
  provider?: AnalysisCallReceiptProvider | null;
  model?: string | null;
  usedMock?: boolean;
  requestSha256?: string | null;
  responseSha256?: string | null;
  latencyMs?: number | null;
  /**
   * TK-R-2 — the provider-assigned request id, exactly as the response
   * header carried it. Null when the provider sent none, or when the call
   * never reached a provider. Never fabricated.
   */
  providerRequestId?: string | null;
  /**
   * TK-R-3 — the HTTP status of the provider response. Null when no HTTP
   * response was received at all (network error, abort). Never synthesised
   * from an outcome label.
   */
  httpStatus?: number | null;
  /**
   * TK-R-1 — the model the provider says it served, read from the response
   * body. Distinct from `model`, which stays what was requested. Null when
   * the response named none.
   */
  modelReturned?: string | null;
  /** D-023 §3 — populate only when a real cost is known; leave both this and costBasis unset otherwise. */
  actualCostUsd?: number | null;
  costBasis?: CostBasis | null;
  /**
   * D-026 — the exact analysis output text. Must be paired with
   * responseSha256 (both set or both omitted) and is mandatory when
   * outcome is 'success'; the real SQL CHECK constraint rejects a
   * mismatched hash/content pair. Pairs only with responseSha256 — there
   * is no equivalent field for requestSha256 in this tranche.
   */
  rawContent?: string | null;
  /**
   * D-027 — the exact outbound request body text. Must be paired with
   * requestSha256 (both set or both omitted). used_mock=false requires
   * both; used_mock=true requires both omitted/null — the real SQL
   * CHECK constraint enforces this, not merely application discipline.
   */
  rawRequestBody?: string | null;
}

export interface RecordAnalysisCallReceiptForJobResult {
  outcome: RecordAnalysisCallReceiptForJobOutcome;
  externalCall: ProtocolExternalCall | null;
  receipt: AnalysisCallReceipt | null;
}

export type ReconcileAttemptForJobOutcome =
  | "RECONCILED"
  | "ALREADY_RECONCILED"
  | "CONFLICT"
  | "EXTERNAL_CALLS_NOT_TERMINAL"
  | "ATTEMPT_NOT_OWNED_BY_JOB"
  | "INVALID_STATUS"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface ReconcileAttemptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  attemptId: string;
  status: ReconcileAttemptStatus;
  terminationReason?: string | null;
}

export interface ReconcileAttemptForJobResult {
  outcome: ReconcileAttemptForJobOutcome;
  attempt: ProtocolAttempt | null;
}

/** D-020 (extended by D-025) — the completion gate's exact ordered outcome set. */
export type CompleteProtocolExecutionJobOutcome =
  | "SUCCEEDED"
  | "ALREADY_SUCCEEDED"
  | "CONFLICT"
  | "NO_CURRENT_ATTEMPT"
  | "CURRENT_ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_RECONCILED"
  | "ATTEMPT_NOT_COMPLETED"
  | "EXTERNAL_CALLS_NOT_TERMINAL"
  | "PERPLEXITY_NOT_COMPLETED"
  | "ANALYSIS_NOT_COMPLETED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED"
  /**
   * D-025 — every D-020 gate passed for the current slot, but
   * baselineOrdinal < protocol.plannedBaselineRuns: current_attempt_id is
   * cleared, next_baseline_ordinal advances by 1, the job stays
   * 'running'. A replay before the next admission returns this same
   * outcome idempotently, with zero further mutation.
   */
  | "NEXT_BASELINE_REQUIRED";

export interface CompleteProtocolExecutionJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
}

export interface CompleteProtocolExecutionJobResult {
  outcome: CompleteProtocolExecutionJobOutcome;
  job: ProtocolExecutionJob | null;
}

export type FailProtocolExecutionJobOutcome = "FAILED" | "JOB_NOT_FOUND" | "JOB_NOT_OWNED";

export interface FailProtocolExecutionJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  reason: string;
}

export interface FailProtocolExecutionJobResult {
  outcome: FailProtocolExecutionJobOutcome;
  job: ProtocolExecutionJob | null;
}

/** D-024 — fingerprinted, replay-safe (mirrors authorize_operator_retry's D-021/D-022 contract). */
export type ReactivateAbandonedJobOutcome =
  | "REACTIVATED"
  | "JOB_NOT_ABANDONED"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "JOB_NOT_FOUND";

export interface ReactivateAbandonedJobInput {
  jobId: string;
  projectId: string;
  actor: string;
  reason: string;
  /** D-024 — mandatory, caller-supplied; never generated inside the RPC. */
  idempotencyKey: string;
}

export interface ReactivateAbandonedJobResult {
  outcome: ReactivateAbandonedJobOutcome;
  job: ProtocolExecutionJob | null;
}

/** D-022 — the existing-child lookup (retry_of_attempt_id) is checked before current_attempt_id; every outcome the shared admission core can propagate is included. */
export type RetryFullAttemptForJobOutcome =
  | "RESERVED"
  | "ALREADY_RETRIED"
  | "SOURCE_ALREADY_RETRIED"
  | "SOURCE_NOT_CURRENT_ATTEMPT"
  | "SOURCE_ATTEMPT_NOT_OWNED_BY_JOB"
  | "SOURCE_NOT_ELIGIBLE"
  | "AMBIGUOUS_CALL_PRESENT"
  | "PERPLEXITY_NOT_ELIGIBLE_FOR_FULL_RETRY"
  | "NOT_FOUND"
  | "PROTOCOL_NOT_APPROVED"
  | "ALREADY_RESERVED"
  | "RUN_CAP_EXCEEDED"
  | "SPEND_CAP_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "RETRY_CAP_EXCEEDED"
  | "INVALID_RETRY_REFERENCE"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface RetryFullAttemptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  sourceAttemptId: string;
  perplexityReservedCostUsd: number;
  analysisReservedCostUsd: number;
}

export interface RetryFullAttemptForJobResult {
  outcome: RetryFullAttemptForJobOutcome;
  attempt: ProtocolAttempt | null;
  perplexityCall: ProtocolExternalCall | null;
  analysisCall: ProtocolExternalCall | null;
}

/** D-023 §1 arbitration — the existing-child lookup (retry_of_external_call_id) is checked before SOURCE_NOT_AUTHORITATIVE_GENERATION; never reordered. */
export type RetryAnalysisGenerationForJobOutcome =
  | "RESERVED"
  | "ALREADY_RETRIED"
  | "SOURCE_ALREADY_RETRIED"
  | "SOURCE_NOT_CURRENT_ATTEMPT"
  | "NO_CURRENT_ATTEMPT"
  | "CURRENT_ATTEMPT_NOT_FOUND"
  | "PERPLEXITY_NOT_COMPLETED"
  | "SOURCE_NOT_AUTHORITATIVE_GENERATION"
  | "SOURCE_NOT_ELIGIBLE"
  /**
   * D-027 — the parse-repair eligibility branch's own defensive guard:
   * a `probe_results` row already exists for the current attempt's
   * `probe_run_id`, so this source must never be retried.
   */
  | "PROBE_RESULT_ALREADY_EXISTS"
  | "AMBIGUOUS_CALL_PRESENT"
  | "RETRY_CAP_EXCEEDED"
  | "SPEND_CAP_EXCEEDED"
  | "NOT_FOUND"
  | "PROTOCOL_NOT_FOUND"
  | "ATTEMPT_NOT_IN_PROGRESS"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface RetryAnalysisGenerationForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  sourceExternalCallId: string;
  reservedCostUsd: number;
}

export interface RetryAnalysisGenerationForJobResult {
  outcome: RetryAnalysisGenerationForJobOutcome;
  externalCall: ProtocolExternalCall | null;
}

/**
 * D-027 — `mark_analysis_parse_failed_for_job`'s eleven-status outcome,
 * in the RPC's own transactional order: JOB_NOT_FOUND, JOB_NOT_OWNED,
 * NOT_CURRENT_ATTEMPT, WRONG_CALL_KIND, ALREADY_MARKED,
 * PARSE_FAILURE_CODE_CONFLICT, CURRENT_ATTEMPT_NOT_FOUND (defensive),
 * PROBE_RESULT_ALREADY_EXISTS, SOURCE_NOT_AUTHORITATIVE_GENERATION,
 * NOT_ELIGIBLE, MARKED. Never a job-status change, never a repair
 * policy — this RPC only records durable state.
 */
export type MarkAnalysisParseFailedForJobOutcome =
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED"
  | "NOT_CURRENT_ATTEMPT"
  | "WRONG_CALL_KIND"
  | "ALREADY_MARKED"
  | "PARSE_FAILURE_CODE_CONFLICT"
  | "CURRENT_ATTEMPT_NOT_FOUND"
  | "PROBE_RESULT_ALREADY_EXISTS"
  | "SOURCE_NOT_AUTHORITATIVE_GENERATION"
  | "NOT_ELIGIBLE"
  | "MARKED";

export interface MarkAnalysisParseFailedForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  externalCallId: string;
  parseFailureCode: ParseAnalysisFailureCode;
}

export interface MarkAnalysisParseFailedForJobResult {
  outcome: MarkAnalysisParseFailedForJobOutcome;
  externalCall: ProtocolExternalCall | null;
}

export type OperatorRetryAction = "retry_full_attempt" | "retry_analysis_only";

/**
 * D-021/D-022 — `status` and `outcome` are two distinct columns on the
 * real RPC (`status` is this full outcome enum; `outcome` is the stored
 * `'approved'/'denied'` business value, null only when `status` itself
 * is a hard refusal such as JOB_NOT_FOUND that never reaches a decision
 * at all). Named to mirror the RPC exactly rather than collapsing them.
 */
export type AuthorizeOperatorRetryOutcome =
  | "APPROVED"
  | "DENIED"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_IN_NEEDS_REVIEW"
  | "SOURCE_ATTEMPT_NOT_OWNED_BY_JOB"
  | "SOURCE_ATTEMPT_NOT_IN_PROGRESS"
  | "SOURCE_EXTERNAL_CALL_NOT_OWNED_BY_ATTEMPT";

export interface AuthorizeOperatorRetryInput {
  jobId: string;
  projectId: string;
  actor: string;
  reason: string;
  action: OperatorRetryAction;
  sourceAttemptId: string;
  reservedCostUsd: number;
  /** Mandatory since D-021 — replaces the old internal fresh-UUID-per-call key. */
  idempotencyKey: string;
  sourceExternalCallId?: string | null;
  perplexityReservedCostUsd?: number | null;
}

export interface AuthorizeOperatorRetryResult {
  status: AuthorizeOperatorRetryOutcome;
  outcome: OperatorActionOutcome | null;
  denialCode: string | null;
  newAttempt: ProtocolAttempt | null;
  newExternalCall: ProtocolExternalCall | null;
}

export type GetProtocolExecutionJobContextOutcome = "OK" | "JOB_NOT_FOUND" | "JOB_NOT_OWNED";

export interface GetProtocolExecutionJobContextInput {
  jobId: string;
  claimToken: string;
  projectId: string;
}

/** Single coherent snapshot under one lock read — never composed from several independent SELECTs (0051 §6). */
export interface GetProtocolExecutionJobContextResult {
  outcome: GetProtocolExecutionJobContextOutcome;
  job: ProtocolExecutionJob | null;
  protocol: Protocol | null;
  currentAttempt: ProtocolAttempt | null;
  externalCalls: ProtocolExternalCall[];
  providerReceipts: ProviderCallReceipt[];
  analysisReceipts: AnalysisCallReceipt[];
  probeRun: ProbeRun | null;
  /**
   * D-025 — distinct completed root baseline slots for this job (never
   * the raw count of protocol_attempts rows, which would double-count
   * retry children). `job.nextBaselineOrdinal` and
   * `protocol.plannedBaselineRuns` are the other two progression numbers
   * a caller needs; both are already carried by the rows above. Null
   * whenever `job`/`protocol` themselves are null (JOB_NOT_FOUND/
   * JOB_NOT_OWNED).
   */
  completedBaselineSlots: number | null;
  /**
   * D-026 — the current attempt's `probe_results` row, if one has
   * already been saved for its `probe_run_id` (looked up under this
   * same fenced snapshot, never a separate round trip). Null whenever
   * there is no current attempt, no probe_run yet, or no probe_result
   * saved yet — never an error. `probe_results_probe_run_id_key` (0052)
   * guarantees at most one row per probe_run_id, so this is unambiguous.
   */
  probeResult: ProbeResult | null;
}


/* -------------------------------------------------------------------------- */
/* 0056 — closed failure transitions.                                          */
/* -------------------------------------------------------------------------- */

/**
 * T2 — job-only closure, for refusals that land before any attempt exists.
 *
 * The target status is derived server-side from the reason. A caller
 * never supplies one, so no TypeScript path can invent a destination:
 *
 *   run_cap_exceeded / spend_cap_exceeded / retry_cap_exceeded  -> failed
 *   throttled_retries_exhausted / slot_budget_exhausted         -> needs_review
 */
export type FailJobWithoutAttemptReason =
  | "run_cap_exceeded"
  | "spend_cap_exceeded"
  | "retry_cap_exceeded"
  | "throttled_retries_exhausted"
  | "slot_budget_exhausted";

export type FailJobWithoutAttemptForJobOutcome =
  | "CLOSED"
  /** The whole transition is already on record, reason included. */
  | "ALREADY_CLOSED"
  /** Partially applied, or already terminal for another reason. Never completed silently. */
  | "STATE_CONFLICT"
  /** An attempt exists; the caller must use T3, which knows how to terminalise it. */
  | "ATTEMPT_STILL_OPEN"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface FailJobWithoutAttemptForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  reason: FailJobWithoutAttemptReason;
}

export interface FailJobWithoutAttemptForJobResult {
  outcome: FailJobWithoutAttemptForJobOutcome;
  job: ProtocolExecutionJob | null;
}

/**
 * T3 — attempt + job closure, for everything after an attempt exists.
 *
 * Refuses while any call is still `in_progress`: a sent call must receive
 * its receipt first, or cancelling it would erase the frontier that stops
 * a replay from paying twice.
 */
export type AbortAttemptAndFailJobForJobOutcome =
  | "ABORTED"
  /** Job status, reason, attempt terminal state and cancelled calls all match. */
  | "ALREADY_ABORTED"
  /** Any partial application. Surfaced, never completed. */
  | "STATE_CONFLICT"
  | "CALL_STILL_IN_PROGRESS"
  | "ATTEMPT_NOT_OWNED_BY_JOB"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface AbortAttemptAndFailJobForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  attemptId: string;
  attemptStatus: "failed" | "timed_out" | "cancelled" | "excluded";
  terminationReason: string | null;
  failureReason: string;
}

/**
 * 0056 — closes an attempt around a durable parse-failure mark.
 *
 * The mark itself is the precondition and is never touched: D-027's
 * operator retry keys off it. This only cancels the unsent legs,
 * terminalises the attempt and moves the job to needs_review, so the run
 * stops in a state someone can act on instead of sitting claimed until
 * its lease lapses.
 */
export type CloseAttemptForParseFailureForJobOutcome =
  | "CLOSED"
  | "ALREADY_CLOSED"
  | "STATE_CONFLICT"
  /** The parse failure was never marked; there is nothing to close around. */
  | "PARSE_NOT_MARKED"
  | "CALL_STILL_IN_PROGRESS"
  | "CALL_NOT_OWNED_BY_JOB"
  | "ATTEMPT_NOT_OWNED_BY_JOB"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface CloseAttemptForParseFailureForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  attemptId: string;
  externalCallId: string;
}

export interface CloseAttemptForParseFailureForJobResult {
  outcome: CloseAttemptForParseFailureForJobOutcome;
  attempt: ProtocolAttempt | null;
  job: ProtocolExecutionJob | null;
}

export interface AbortAttemptAndFailJobForJobResult {
  outcome: AbortAttemptAndFailJobForJobOutcome;
  attempt: ProtocolAttempt | null;
  job: ProtocolExecutionJob | null;
}

export type MarkProtocolExecutionJobNeedsReviewForAmbiguityOutcome =
  | "NEEDS_REVIEW"
  | "ALREADY_NEEDS_REVIEW"
  | "NO_AMBIGUOUS_CALL"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED";

export interface MarkProtocolExecutionJobNeedsReviewForAmbiguityInput {
  jobId: string;
  claimToken: string;
  projectId: string;
}

export interface MarkProtocolExecutionJobNeedsReviewForAmbiguityResult {
  outcome: MarkProtocolExecutionJobNeedsReviewForAmbiguityOutcome;
  job: ProtocolExecutionJob | null;
}

/* -------------------------------------------------------------------------- */
/*  D-028 — persist_probe_result_for_job                                       */
/* -------------------------------------------------------------------------- */

/**
 * The nine required keys `persist_probe_result_for_job` validates
 * strictly: no missing key, no extra key, no JSON `null` value. Never
 * includes `verdict`/`productVerdict`/`runPosition` — those are fixed
 * placeholders or server-derived, never caller-supplied.
 */
export interface PersistProbeResultForJobContent {
  productMentioned: boolean;
  productPosition: ClientPositionValue;
  competitorsMentioned: Array<{ name: string; position: number; context: string }>;
  sourcesCited: Array<{ source: string; type: SourceTypeValue }>;
  answerSummary: string;
  citedAsSource: boolean;
  clientSourceCount: number;
  platformsReferenced: string[];
  negativeClaimDetected: boolean;
}

export type ClientPositionValue = "primary" | "listed" | "negative" | "absent";
export type SourceTypeValue = "review_site" | "blog" | "forum" | "vendor_site" | "news" | "other";

export type PersistProbeResultForJobOutcome =
  | "PERSISTED"
  | "ALREADY_PERSISTED"
  | "CONFLICT"
  | "INVALID_CONTENT_KEYS"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_CONTENT_VALUE"
  | "INVALID_CONTENT_INVARIANT"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED"
  | "NO_CURRENT_ATTEMPT"
  | "ATTEMPT_NOT_OWNED_BY_JOB"
  | "PROTOCOL_NOT_FOUND"
  | "BUYER_QUESTION_VERSION_NOT_FOUND"
  | "PROBE_RUN_NOT_FOUND"
  | "WRONG_CALL_KIND"
  | "ANALYSIS_NOT_COMPLETED"
  | "PARSE_ALREADY_MARKED_FAILED"
  | "RECEIPT_NOT_FOUND";

export interface PersistProbeResultForJobInput {
  jobId: string;
  claimToken: string;
  projectId: string;
  content: PersistProbeResultForJobContent;
}

export interface PersistProbeResultForJobResult {
  outcome: PersistProbeResultForJobOutcome;
  probeResultId: string | null;
  canonicalResultSha256: string | null;
}

/* -------------------------------------------------------------------------- */
/*  D-028 — durable alert outbox                                               */
/* -------------------------------------------------------------------------- */

export type AlertEventType = "needs_review" | "abandoned_exhausted";

export type AlertReasonCode =
  | "perplexity_outcome_unknown"
  | "analysis_outcome_unknown"
  | "ambiguous_external_call_sent_without_receipt"
  /** 0056 — the request on record is not the request in hand. */
  | "request_evidence_conflict"
  /** 0056 — a receipt exists whose evidence differs from the one offered. */
  | "receipt_evidence_conflict"
  /** 0056 — a transient cap held for every retry allowed under one claim. */
  | "throttled_retries_exhausted"
  /** 0056 — the slot budget was exhausted; the ledger is inconsistent. */
  | "slot_budget_exhausted"
  /** 0056 — a receipted analysis output failed local parsing (D-027). */
  | "analysis_parse_failed"
  | "attempts_exhausted";

export type AlertDeliveryStatus =
  | "pending"
  | "claimed"
  | "request_sent"
  | "accepted"
  | "failed"
  | "needs_review_delivery";

export type AlertDeliveryAttemptOutcome =
  | "request_sent"
  | "accepted"
  | "http_error"
  | "ambiguous_under_24h"
  | "ambiguous_over_24h";

export type AlertDeliveryErrorCode =
  | "network_error"
  | "http_429"
  | "http_5xx"
  | "http_4xx_permanent"
  | "timeout";

export type ClaimNextPendingAlertOutcome = "CLAIMED" | "NO_ALERT_AVAILABLE";

export interface ClaimNextPendingAlertInput {
  workerId: string;
  leaseSeconds: number;
}

/** Closed payload — never a raw body, prompt, or free-text reason. */
export interface ClaimNextPendingAlertResult {
  outcome: ClaimNextPendingAlertOutcome;
  deliveryId: string | null;
  alertEventId: string | null;
  claimToken: string | null;
  attemptCount: number | null;
  projectId: string | null;
  jobId: string | null;
  eventType: AlertEventType | null;
  reasonCode: AlertReasonCode | null;
  idempotencyKey: string | null;
  reconciledStaleClaimedCount: number;
  reconciledUnder24hCount: number;
  reconciledOver24hCount: number;
}

export type RenewAlertLeaseOutcome = "RENEWED" | "DELIVERY_NOT_FOUND" | "DELIVERY_NOT_OWNED";

export interface RenewAlertLeaseInput {
  deliveryId: string;
  claimToken: string;
  leaseSeconds: number;
}

export interface RenewAlertLeaseResult {
  outcome: RenewAlertLeaseOutcome;
  deliveryId: string | null;
}

export type MarkAlertRequestSentOutcome =
  | "REQUEST_MARKED_SENT"
  | "DELIVERY_NOT_FOUND"
  | "DELIVERY_NOT_OWNED"
  | "ALERT_ATTEMPT_CAP_EXCEEDED";

export interface MarkAlertRequestSentInput {
  deliveryId: string;
  claimToken: string;
}

export interface MarkAlertRequestSentResult {
  outcome: MarkAlertRequestSentOutcome;
  attemptId: string | null;
  attemptSeq: number | null;
  idempotencyKey: string | null;
}

export type RecordAlertDeliveryReceiptOutcome =
  | "RECEIPT_RECORDED"
  | "DELIVERY_NOT_FOUND"
  | "DELIVERY_NOT_OWNED"
  | "ATTEMPT_ALREADY_TERMINAL"
  | "INVALID_OUTCOME";

export interface RecordAlertDeliveryReceiptInput {
  deliveryId: string;
  claimToken: string;
  attemptId: string;
  outcome: "accepted" | "http_error" | "ambiguous_under_24h" | "ambiguous_over_24h";
  httpStatus?: number | null;
  resendEmailId?: string | null;
  errorCode?: AlertDeliveryErrorCode | null;
}

export interface RecordAlertDeliveryReceiptResult {
  outcome: RecordAlertDeliveryReceiptOutcome;
  deliveryId: string | null;
  finalDeliveryStatus: AlertDeliveryStatus | null;
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
  /**
   * Founder-created audit (migration 0081). Skips the public form's abuse
   * throttles and lands on `pending_approval`; still throws
   * `SnapshotRequestLimitError("active_domain")` when that domain already has
   * an audit in flight, and still requires founder approval before any paid
   * provider call.
   */
  createFounderSnapshotRequest(
    input: CreateFounderSnapshotRequestInput
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
  /**
   * Approves a request and, in one atomic operation (migration 0062),
   * creates and approves its buyer_question_version and protocol, then
   * enqueues exactly one protocol_execution_jobs baseline job — the
   * canonical M4/M5 path. Terminal status is `approved`, not `queued`:
   * the legacy `claim_next_snapshot_request` worker only ever selects
   * `status = 'queued'`, so a request approved through this method is
   * structurally never claimed by the legacy worker.
   *
   * `promptHash` must be the SHA-256 (lowercase hex) of the exact
   * `buyerCategory` text on the request being approved — this is prompt
   * identity, computed by the application layer, never recomputed or
   * verified against the text by the database (matching migration 0047's
   * rule for `buyer_question_versions.prompt_hash`).
   *
   * Idempotent: a second call for an already-launched request returns the
   * existing row unchanged and creates no second question/protocol/job.
   */
  approveAndLaunchSnapshotBaseline(
    requestId: string,
    approvedBy: string,
    competitors: string[],
    promptHash: string
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
  // resolution. createCanonicalEntity's direct-write path is
  // deliberately kept (D-017 §3: a bare identity row cannot attach a
  // mention, resolve an alias, or bypass brand-self exclusion or the
  // one-client-per-project constraint). createEntityAlias was retired
  // in the third tranche — entity_aliases is now written exclusively
  // through resolveAndRecordEntityObservation below.
  createCanonicalEntity(
    input: CanonicalEntityInput
  ): Promise<CanonicalEntity>;
  getCanonicalEntitiesByProject(
    projectId: string
  ): Promise<CanonicalEntity[]>;
  getEntityAliasesByProject(projectId: string): Promise<EntityAlias[]>;

  // M2 canonical observations contract, third tranche (D-017, D-018,
  // D-019) — entity resolution RPC wrappers; the only sanctioned way
  // to write entity_aliases/entity_observations.
  startOrResumeEntityResolutionPass(
    input: StartOrResumeEntityResolutionPassInput
  ): Promise<StartOrResumeEntityResolutionPassResult>;
  resolveAndRecordEntityObservation(
    input: ResolveAndRecordEntityObservationInput
  ): Promise<ResolveAndRecordEntityObservationResult>;
  // Active-head readers — the only sanctioned read path for "what does
  // this currently mean" (D-017). No other method reads the base
  // entity_aliases/entity_observations tables for that purpose.
  getEntityAliasesActiveByProject(projectId: string): Promise<EntityAlias[]>;
  getEntityObservationsActiveByProbeResult(
    probeResultId: string
  ): Promise<EntityObservation[]>;

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

  // M4 — buyer question identity, protocol, and paid-attempt ledger.
  // createBuyerQuestion/createBuyerQuestionVersion/createProtocol are
  // simple, non-concurrency-sensitive inserts (direct grant in the
  // draft migration). Every status/approval transition and every
  // protocol_attempts write goes through the RPC-wrapper methods below
  // — never a direct update.
  createBuyerQuestion(input: CreateBuyerQuestionInput): Promise<BuyerQuestion>;
  getBuyerQuestion(id: string, projectId: string): Promise<BuyerQuestion | null>;
  createBuyerQuestionVersion(
    input: CreateBuyerQuestionVersionInput
  ): Promise<BuyerQuestionVersion>;
  getBuyerQuestionVersionsByQuestion(
    buyerQuestionId: string,
    projectId: string
  ): Promise<BuyerQuestionVersion[]>;
  /** M4 Stage B — resolves a protocol's single canonical prompt text by its own version id, project-scoped. */
  getBuyerQuestionVersion(
    id: string,
    projectId: string
  ): Promise<BuyerQuestionVersion | null>;
  approveBuyerQuestionVersion(
    input: ApproveBuyerQuestionVersionInput
  ): Promise<ApproveBuyerQuestionVersionResult>;

  createProtocol(input: CreateProtocolInput): Promise<Protocol>;
  getProtocol(id: string, projectId: string): Promise<Protocol | null>;
  approveProtocol(input: ApproveProtocolInput): Promise<ApproveProtocolResult>;

  admitAndReserveAttempt(
    input: AdmitAndReserveAttemptInput
  ): Promise<AdmitAndReserveAttemptResult>;
  startAttempt(input: StartAttemptInput): Promise<StartAttemptResult>;
  reconcileAttempt(
    input: ReconcileAttemptInput
  ): Promise<ReconcileAttemptResult>;
  getProtocolAttempts(
    protocolId: string,
    projectId: string
  ): Promise<ProtocolAttempt[]>;

  // M5-2 Stage A — protocol execution jobs, external-call ledger
  // (D-020/D-021/D-022/D-023). start_attempt_for_job and
  // reserve_additional_analysis_generation_for_job are deliberately not
  // exposed here — see the type-block comment above this interface.
  enqueueProtocolExecutionJob(
    input: EnqueueProtocolExecutionJobInput
  ): Promise<EnqueueProtocolExecutionJobResult>;
  claimProtocolExecutionJob(
    input: ClaimProtocolExecutionJobInput
  ): Promise<ClaimProtocolExecutionJobResult>;
  /**
   * D-031 — claims one named job, or nothing. Never a different one.
   */
  claimProtocolExecutionJobById(
    input: ClaimProtocolExecutionJobByIdInput
  ): Promise<ClaimProtocolExecutionJobByIdResult>;
  /**
   * D-031 — reads the WHOLE history of one claimed job and answers with a
   * single closed label. Never mutates, and never reports what it saw.
   */
  verifyPhase3dCanaryPostClaim(
    input: VerifyPhase3dCanaryPostClaimInput
  ): Promise<VerifyPhase3dCanaryPostClaimResult>;
  renewProtocolExecutionJobLease(
    input: RenewProtocolExecutionJobLeaseInput
  ): Promise<RenewProtocolExecutionJobLeaseResult>;
  admitAndReserveAttemptForJob(
    input: AdmitAndReserveAttemptForJobInput
  ): Promise<AdmitAndReserveAttemptForJobResult>;
  createProbeRunAndStartAttemptForJob(
    input: CreateProbeRunAndStartAttemptForJobInput
  ): Promise<CreateProbeRunAndStartAttemptForJobResult>;
  markExternalCallSentForJob(
    input: MarkExternalCallSentForJobInput
  ): Promise<MarkExternalCallSentForJobResult>;
  recordProviderCallReceiptForJob(
    input: RecordProviderCallReceiptForJobInput
  ): Promise<RecordProviderCallReceiptForJobResult>;
  recordAnalysisCallReceiptForJob(
    input: RecordAnalysisCallReceiptForJobInput
  ): Promise<RecordAnalysisCallReceiptForJobResult>;
  reconcileAttemptForJob(
    input: ReconcileAttemptForJobInput
  ): Promise<ReconcileAttemptForJobResult>;
  completeProtocolExecutionJob(
    input: CompleteProtocolExecutionJobInput
  ): Promise<CompleteProtocolExecutionJobResult>;
  failProtocolExecutionJob(
    input: FailProtocolExecutionJobInput
  ): Promise<FailProtocolExecutionJobResult>;
  /** 0056 T2 — closes a job that has no attempt; the server picks the status. */
  failJobWithoutAttemptForJob(
    input: FailJobWithoutAttemptForJobInput
  ): Promise<FailJobWithoutAttemptForJobResult>;
  /** 0056 T3 — cancels unsent legs, terminalises the attempt, closes the job. */
  abortAttemptAndFailJobForJob(
    input: AbortAttemptAndFailJobForJobInput
  ): Promise<AbortAttemptAndFailJobForJobResult>;
  /** 0056 — closes an attempt around a durable parse-failure mark. */
  closeAttemptForParseFailureForJob(
    input: CloseAttemptForParseFailureForJobInput
  ): Promise<CloseAttemptForParseFailureForJobResult>;
  reactivateAbandonedJob(
    input: ReactivateAbandonedJobInput
  ): Promise<ReactivateAbandonedJobResult>;
  retryFullAttemptForJob(
    input: RetryFullAttemptForJobInput
  ): Promise<RetryFullAttemptForJobResult>;
  retryAnalysisGenerationForJob(
    input: RetryAnalysisGenerationForJobInput
  ): Promise<RetryAnalysisGenerationForJobResult>;
  /** D-027 — marks a durable parse-failure on the current attempt's authoritative analysis generation. */
  markAnalysisParseFailedForJob(
    input: MarkAnalysisParseFailedForJobInput
  ): Promise<MarkAnalysisParseFailedForJobResult>;
  authorizeOperatorRetry(
    input: AuthorizeOperatorRetryInput
  ): Promise<AuthorizeOperatorRetryResult>;
  getProtocolExecutionJobContext(
    input: GetProtocolExecutionJobContextInput
  ): Promise<GetProtocolExecutionJobContextResult>;
  markProtocolExecutionJobNeedsReviewForAmbiguity(
    input: MarkProtocolExecutionJobNeedsReviewForAmbiguityInput
  ): Promise<MarkProtocolExecutionJobNeedsReviewForAmbiguityResult>;
  /** D-028 — the only fenced write path for M5-authored probe_results rows. */
  persistProbeResultForJob(
    input: PersistProbeResultForJobInput
  ): Promise<PersistProbeResultForJobResult>;
  /** D-028 — durable alert outbox: worker-facing claim, with atomic stale-delivery reconciliation. */
  claimNextPendingAlert(
    input: ClaimNextPendingAlertInput
  ): Promise<ClaimNextPendingAlertResult>;
  renewAlertLease(
    input: RenewAlertLeaseInput
  ): Promise<RenewAlertLeaseResult>;
  markAlertRequestSent(
    input: MarkAlertRequestSentInput
  ): Promise<MarkAlertRequestSentResult>;
  recordAlertDeliveryReceipt(
    input: RecordAlertDeliveryReceiptInput
  ): Promise<RecordAlertDeliveryReceiptResult>;
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
