import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// `createPublicReportToken` is deliberately not imported here. Public tokens
// for snapshot report artifacts are owned by the SQL layer: the RPCs issue
// them on first write and preserve them on every later write. The in-memory
// adapter still generates its own, because it has no SQL layer.
import { snapshotReportWriteMode } from "./snapshot-write-mode";
import type {
  Competitor,
  CompetitorInput,
  CreateProjectInput,
  CreateSnapshotRequestInput,
  DbAdapter,
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
  SnapshotRequestLimitCode,
  SitePage,
} from "./types";
import { SnapshotRequestLimitError } from "./types";

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
  work_email: string;
  normalized_email: string;
  company_name: string;
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
  claimed_by: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotReportArtifactDbRow {
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
  created_at: string;
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

function mapSnapshotRequest(r: SnapshotRequestDbRow): SnapshotRequest {
  return {
    id: r.id,
    workEmail: r.work_email,
    normalizedEmail: r.normalized_email,
    companyName: r.company_name,
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

function mapProbeRun(r: ProbeRunDbRow): ProbeRun {
  return {
    id: r.id,
    projectId: r.project_id,
    platform: r.platform,
    status: r.status as ProbeRunStatus,
    probeMode: coerceProbeMode(r.probe_mode),
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
    createdAt: r.created_at,
  };
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
    approvedBy: string
  ): Promise<SnapshotRequest | null> {
    const { data, error } = await getClient()
      .rpc(
        "approve_and_queue_snapshot_request",
        {
          p_request_id: requestId,
          p_approved_by: approvedBy,
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

  async createProbeRun(
    projectId: string,
    platform: string,
    probeMode: ProbeMode,
    status: ProbeRunStatus = "pending"
  ): Promise<ProbeRun> {
    const { data, error } = await getClient()
      .from("probe_runs")
      .insert({
        project_id: projectId,
        platform,
        status,
        probe_mode: probeMode,
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

  async replaceCompetitorsForProject(
    projectId: string,
    competitors: CompetitorInput[]
  ): Promise<Competitor[]> {
    const client = getClient();
    const del = await client
      .from("competitors")
      .delete()
      .eq("project_id", projectId);
    if (del.error) throw del.error;
    if (competitors.length === 0) return [];
    const rows = competitors.map((c) => ({
      project_id: projectId,
      name: c.name,
      website: c.website,
      discovery_source: c.discoverySource,
      mention_count: c.mentionCount,
      prompt_ids: c.promptIds,
      threat_level: c.threatLevel,
      confidence: c.confidence,
      is_phantom: c.isPhantom,
      is_blind_spot: c.isBlindSpot,
    }));
    const { data, error } = await client
      .from("competitors")
      .insert(rows)
      .select("*");
    if (error || !data)
      throw error ?? new Error("replaceCompetitorsForProject failed");
    return (data as CompetitorDbRow[]).map(mapCompetitor);
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
};
