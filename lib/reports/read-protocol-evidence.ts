/**
 * Reads stored protocol evidence for one snapshot request.
 *
 * Separated from the builder so the decision of *what the client is told*
 * stays pure and testable, while this file owns the only thing that needs a
 * database. Nothing here interprets: it resolves identity (request →
 * protocol → approved question version) and returns the attempt and result
 * rows exactly as stored.
 *
 * Reads only. A report must never mutate the evidence it describes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BuildProtocolReportInput,
  EvidenceAttemptInput,
  EvidenceResultInput,
} from "@/lib/reports/protocol-report-types";

export class ProtocolEvidenceError extends Error {}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ProtocolEvidenceError(message);
  }
  return value;
}

/**
 * `competitors_mentioned` and `sources_cited` are jsonb and have historically
 * held both arrays and null. Anything that is not an array is treated as
 * empty rather than crashing a report over a legacy row.
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `competitors_mentioned` holds two shapes in practice. The analyzer writes
 * objects — `{name, context, position}` — while older rows and some fixtures
 * hold bare strings. Reading only strings silently produced an empty
 * competitor list on real evidence that named six brands, so both are
 * accepted and anything else is dropped rather than rendered as "[object
 * Object]" in a client-facing document.
 */
function asStringArray(value: unknown): string[] {
  const names: string[] = [];

  for (const item of asArray(value)) {
    if (typeof item === "string") {
      names.push(item);
      continue;
    }

    if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) {
        names.push(name);
      }
    }
  }

  return names;
}

/**
 * The part of evidence-reading that is genuinely protocol-agnostic: given a
 * protocol id and the subject it belongs to, read the approved question
 * version and every attempt/result row. `readProtocolEvidence` and
 * `readRetestProtocolEvidence` are both thin wrappers around this — the
 * only thing that differs between a baseline and a retest protocol is
 * WHERE `subject`/`projectId` come from, never how evidence is read.
 */
async function readProtocolEvidenceCore(
  client: SupabaseClient,
  snapshotRequestId: string,
  projectId: string,
  protocolId: string,
  subject: BuildProtocolReportInput["subject"]
): Promise<BuildProtocolReportInput> {
  const { data: protocol, error: protocolError } = await client
    .from("protocols")
    .select("*")
    .eq("id", protocolId)
    .maybeSingle();

  if (protocolError) throw protocolError;

  const proto = required(
    protocol,
    `Protocol ${protocolId} was not found.`
  ) as Record<string, any>;

  // Every caller passes the project it resolved identity from. A protocol
  // from another project would put that project's runs under this subject.
  if (proto.project_id !== projectId) {
    throw new ProtocolEvidenceError(
      `Protocol ${protocolId} does not belong to project ${projectId}.`
    );
  }

  const { data: version, error: versionError } = await client
    .from("buyer_question_versions")
    .select("*")
    .eq("id", proto.buyer_question_version_id)
    .maybeSingle();

  if (versionError) throw versionError;

  const qv = required(
    version,
    `Buyer question version ${proto.buyer_question_version_id} was not found.`
  ) as Record<string, any>;

  const { data: attemptRows, error: attemptError } = await client
    .from("protocol_attempts")
    .select(
      "id,attempt_kind,status,baseline_ordinal,probe_run_id,retry_of_attempt_id,termination_reason"
    )
    .eq("protocol_id", protocolId);

  if (attemptError) throw attemptError;

  const attempts: EvidenceAttemptInput[] = (attemptRows ?? []).map(
    (row: Record<string, any>) => ({
      id: row.id,
      attemptKind: row.attempt_kind,
      status: row.status,
      baselineOrdinal: row.baseline_ordinal,
      probeRunId: row.probe_run_id,
      retryOfAttemptId: row.retry_of_attempt_id,
      terminationReason: row.termination_reason,
    })
  );

  const probeRunIds = attempts
    .map((a) => a.probeRunId)
    .filter((id): id is string => typeof id === "string");

  let results: EvidenceResultInput[] = [];

  if (probeRunIds.length > 0) {
    const { data: resultRows, error: resultError } = await client
      .from("probe_results")
      .select(
        "probe_run_id,client_mentioned,client_position,competitors_mentioned,sources_cited,answer_summary,raw_response,raw_response_sha256,provider_model,provider_latency_ms"
      )
      .in("probe_run_id", probeRunIds);

    if (resultError) throw resultError;

    results = (resultRows ?? []).map((row: Record<string, any>) => ({
      probeRunId: row.probe_run_id,
      clientMentioned: row.client_mentioned,
      clientPosition: row.client_position,
      competitorsMentioned: asStringArray(row.competitors_mentioned),
      sourcesCited: asArray(row.sources_cited),
      answerSummary: row.answer_summary,
      rawResponseSha256: row.raw_response_sha256,
      rawResponse: typeof row.raw_response === "string" ? row.raw_response : null,
      providerModel: row.provider_model,
      providerLatencyMs: row.provider_latency_ms,
    }));
  }

  return {
    snapshotRequestId,
    projectId,
    subject,
    question: {
      text: qv.prompt_text,
      hash: qv.prompt_hash,
      versionNumber: qv.version_number,
      intentType: qv.intent_type,
      provenance: qv.provenance,
      approvedAt: qv.approved_at,
    },
    protocol: {
      id: proto.id,
      provider: proto.provider,
      surface: proto.surface,
      model:
        (proto.model_config && proto.model_config.model) ??
        proto.provider,
      plannedBaselineRuns: proto.planned_baseline_runs,
      unitOfAnalysis: proto.unit_of_analysis,
      primaryMetric: proto.primary_metric,
      methodologyVersion: String(proto.methodology_version),
      analyzerVersion: proto.analyzer_version,
      entityResolutionVersion: proto.entity_resolution_version,
      approvedAt: proto.approved_at,
    },
    attempts,
    results,
  };
}

/**
 * Reads evidence for a request that went through the founder-operated
 * public flow. `subject` and `snapshotRequestId` come from
 * `snapshot_requests`, exactly as before this function was split — this
 * wrapper's behavior is unchanged from the pre-split version.
 */
export async function readProtocolEvidence(
  client: SupabaseClient,
  snapshotRequestId: string
): Promise<BuildProtocolReportInput> {
  const { data: request, error: requestError } = await client
    .from("snapshot_requests")
    .select(
      "id,company_name,website_url,normalized_domain,project_id,protocol_id,status"
    )
    .eq("id", snapshotRequestId)
    .maybeSingle();

  if (requestError) throw requestError;

  const req = required(
    request,
    `Snapshot request ${snapshotRequestId} was not found.`
  ) as Record<string, any>;

  const protocolId = required(
    req.protocol_id,
    "Snapshot request has no protocol. It was not approved through the M4/M5 path, so there is no protocol evidence to report."
  );

  const projectId = required(
    req.project_id,
    "Snapshot request has no project."
  );

  return readProtocolEvidenceCore(client, req.id, projectId, protocolId, {
    companyName: req.company_name,
    websiteUrl: req.website_url,
    normalizedDomain: req.normalized_domain,
  });
}

/** A bare lowercase hostname, as `projects.domain` stores it. */
const PROJECT_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const BASELINE_PROTOCOL_STATUSES = new Set(["approved", "active", "completed"]);

/**
 * Reads evidence for an intervention's BASELINE protocol, whichever
 * supported path created it.
 *
 *   - Public or founder-created audit: a `snapshot_requests` row carries
 *     the protocol id. Read through `readProtocolEvidence`, unchanged.
 *   - Standalone founder baseline (#66): no request exists. The subject
 *     comes from the `projects` row instead, which is not a substitute but
 *     the identity the worker measured against — it sends
 *     `project.companyName ?? project.domain` as the brand for every
 *     attempt (lib/protocol-worker/worker.ts). The same fallback is used
 *     here, so the report filters exactly the brand the analysis looked for.
 *
 * Either way the protocol must be an approved baseline of this project. A
 * retest, a draft, an abandoned protocol, another project's protocol, or a
 * project whose domain is not a plain hostname throws
 * `ProtocolEvidenceError` rather than producing a card on unverified
 * identity. No row is written.
 *
 * `websiteUrl` holds the bare domain on the standalone path: `projects` has
 * no URL column, and a scheme or `www.` added here would be a guess.
 */
export async function readBaselineProtocolEvidence(
  client: SupabaseClient,
  baselineProtocolId: string,
  projectId: string
): Promise<BuildProtocolReportInput> {
  const { data: protocol, error: protocolError } = await client
    .from("protocols")
    .select("id,project_id,baseline_protocol_id,status")
    .eq("id", baselineProtocolId)
    .maybeSingle();

  if (protocolError) throw protocolError;

  const proto = required(
    protocol,
    `Baseline protocol ${baselineProtocolId} was not found.`
  ) as Record<string, any>;

  if (proto.project_id !== projectId) {
    throw new ProtocolEvidenceError(
      `Baseline protocol ${baselineProtocolId} does not belong to project ${projectId}.`
    );
  }
  if (proto.baseline_protocol_id !== null) {
    throw new ProtocolEvidenceError(
      `Protocol ${baselineProtocolId} is a retest, not a baseline.`
    );
  }
  if (!BASELINE_PROTOCOL_STATUSES.has(proto.status)) {
    throw new ProtocolEvidenceError(
      `Baseline protocol ${baselineProtocolId} is '${proto.status}', not an approved baseline.`
    );
  }

  const { data: request, error: requestError } = await client
    .from("snapshot_requests")
    .select("id,project_id")
    .eq("protocol_id", baselineProtocolId)
    .maybeSingle();

  if (requestError) throw requestError;

  if (request) {
    const req = request as Record<string, any>;
    if (req.project_id !== projectId) {
      throw new ProtocolEvidenceError(
        `Snapshot request ${req.id} for baseline ${baselineProtocolId} belongs to another project.`
      );
    }
    return readProtocolEvidence(client, req.id);
  }

  const { data: project, error: projectError } = await client
    .from("projects")
    .select("id,company_name,domain")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) throw projectError;

  const proj = required(
    project,
    `Project ${projectId} was not found.`
  ) as Record<string, any>;

  const domain =
    typeof proj.domain === "string" ? proj.domain.trim().toLowerCase() : "";
  if (!PROJECT_DOMAIN_PATTERN.test(domain)) {
    throw new ProtocolEvidenceError(
      `Project ${projectId} has no plain hostname as its domain, so the baseline's subject cannot be verified.`
    );
  }

  const companyName =
    typeof proj.company_name === "string" && proj.company_name.trim()
      ? proj.company_name.trim()
      : domain;

  // No request id exists on this path. As for a retest, the protocol's own
  // id fills the field; buildOutcomeCard never reads it.
  return readProtocolEvidenceCore(
    client,
    baselineProtocolId,
    projectId,
    baselineProtocolId,
    { companyName, websiteUrl: domain, normalizedDomain: domain }
  );
}

/**
 * Reads evidence for a RETEST protocol — one with no `snapshot_request` of
 * its own, since it is identified by its intervention and baseline
 * protocol instead (0073). `subject` is supplied by the caller, who reads
 * it from the baseline's own evidence: the two phases describe the same
 * company, so there is nothing for this function to look up independently.
 *
 * `snapshotRequestId` in the returned `BuildProtocolReportInput` is set to
 * the retest protocol's own id — that field exists only so
 * `buildProtocolReport`'s output payload carries SOME stable identifier;
 * `buildOutcomeCard` never reads it (it takes identity from
 * `protocol.id`/`question.hash` instead), so this substitution is
 * inert rather than a lie a client could be shown.
 */
export async function readRetestProtocolEvidence(
  client: SupabaseClient,
  retestProtocolId: string,
  projectId: string,
  subject: BuildProtocolReportInput["subject"]
): Promise<BuildProtocolReportInput> {
  return readProtocolEvidenceCore(
    client,
    retestProtocolId,
    projectId,
    retestProtocolId,
    subject
  );
}

/**
 * D-055 — reads evidence for one pilot question's protocol. The caller (the
 * pilot report reader) has already resolved the protocol from the pilot's
 * own slot table and supplies the subject from the pilot's project, which is
 * the brand the worker measured against. The protocol must still belong to
 * that project, which the shared core checks.
 *
 * `snapshotRequestId` is set to the protocol's own id, as for a retest: a
 * pilot question has no request, and the pilot report takes identity from
 * the pilot question and the protocol, never from this field.
 */
export async function readPilotProtocolEvidence(
  client: SupabaseClient,
  protocolId: string,
  projectId: string,
  subject: BuildProtocolReportInput["subject"]
): Promise<BuildProtocolReportInput> {
  return readProtocolEvidenceCore(client, protocolId, projectId, protocolId, subject);
}
