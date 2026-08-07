#!/usr/bin/env tsx
/**
 * Sprint 14A — one-command MVP scan runner.
 *
 * This script orchestrates the frozen Sprint 13C engine. It intentionally
 * does not change probe scoring, prompt analysis, competitor discovery,
 * Gap Map, Fix Brief, Evidence Bank, asset, or QA logic.
 */

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { getDb } from "@/lib/db";
import type {
  GeneratedPrompt,
  ProbeMode,
  ProbeResult,
  Project,
  QaReportRow,
  SnapshotProgressStage,
} from "@/lib/db/types";
import { runMirrorScan } from "@/lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "@/lib/pipeline/generate-buyer-prompts";
import { getOrCreateEvidenceBank } from "@/lib/pipeline/get-or-create-evidence-bank";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { discoverCompetitors } from "@/lib/pipeline/discover-competitors";
import {
  LeaseRenewer,
  readLeaseRenewalConfigFromEnv,
} from "@/lib/snapshot-worker/lease-renewal";
import { generateGapMap } from "@/lib/pipeline/generate-gap-map";
import { generateFixBrief } from "@/lib/pipeline/generate-fix-brief";
import { buildMvpReport } from "@/lib/export/build-mvp-report";
import {
  applyPromptShortfallPolicy,
  type PromptShortfallPolicy,
} from "@/lib/prompts/prompt-selection-policy";
import { selectPromptTargets } from "@/lib/prompts/select-prompt-targets";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import { SiteReaderOutputSchema } from "@/lib/schemas/site-reader.schema";
import { probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";
import { ZYPACT_COMMERCIAL_SANITY_PROMPTS } from "@/lib/prompts/commercial-selection";

type RunnerProbeMode = "live" | "simulated";

interface Args {
  brand: string;
  domain: string;
  category: string;
  userId: string;
  projectId?: string;
  prompts: number;
  runs: number;
  promptsFile?: string;
  competitors: string[];
  probeMode: RunnerProbeMode;
  dryRun: boolean;
  forceNewProject: boolean;
  allowFewerPrompts: boolean;
  budgetUsd: number;
  out?: string;
}

interface StagePlan {
  project: "create" | "reuse";
  mirror: "run" | "reuse";
  prompts: "generate" | "reuse" | "file";
  evidenceBank: "create" | "reuse";
  probes: "run" | "skip" | "pending" | "blocked";
  recommendations: "run" | "skip" | "pending" | "blocked";
  export: "write" | "skip";
}

/** What the plan may claim about the number of prompts that will be probed. */
type PlanPromptSelection =
  | { kind: "exact"; count: number; basis: string }
  | { kind: "unknown"; basis: string };

/**
 * Spend confidence is tracked SEPARATELY from prompt-count confidence. An
 * exact prompt count does not imply an exact probe count: missing probes also
 * depend on how many runs already exist for each prompt.
 */
interface PlanSpendEstimate {
  kind: "exact" | "not_final" | "not_applicable";
  missingProbeCalls: number;
  estimatedSpend: number;
}

const DEFAULT_USER_ID = "a76f133a-b3ef-4440-b418-dddb3e1ea524";
/**
 * Worker lease renewal, active only when a parent passed a claim token.
 *
 * `runApprovedSnapshot` blocks in `spawnSync`, so this process is the only
 * place the lease can be kept alive while probes run. Null for manual CLI
 * runs, which have no lease and behave exactly as before.
 */
let leaseRenewer: LeaseRenewer | null = null;

/**
 * Call immediately before any provider-capable operation. Throws once
 * ownership is lost, which unwinds the scan and exits non-zero so the
 * parent can record failure through its fenced worker RPC. A stale write
 * is never attempted.
 */
function assertLeaseOwnership(): void {
  leaseRenewer?.assertOwned();
}

const DEFAULT_PROMPTS = 5;
const DEFAULT_RUNS = 3;
const DEFAULT_BUDGET_USD = 2;
const ESTIMATED_COST_PER_LIVE_PROBE_USD = Number.parseFloat(
  process.env.ZYPACT_ESTIMATED_COST_PER_LIVE_PROBE_USD || "0.03",
);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) fail(`${label} must be a positive integer.`);
  return n;
}

function parsePositiveMoney(raw: string | undefined, fallback: number, label: string): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) fail(`${label} must be a non-negative number.`);
  return n;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const item of raw.split(",")) {
    const value = item.trim();
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    values.push(value);
  }

  return values;
}

function parseArgs(argv: string[]): Args {
  const allowedFlags = new Set([
    "brand",
    "domain",
    "category",
    "userId",
    "user-id",
    "project-id",
    "prompts",
    "runs",
    "prompts-file",
    "competitors",
    "probe-mode",
    "dry-run",
    "force-new-project",
    "allow-unguarded-frame",
    "allow-fewer-prompts",
    "budget-usd",
    "out",
  ]);

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (!allowedFlags.has(name)) {
      fail(`Unknown argument --${name}. This runner fails closed so unsupported flags are not silently ignored.`);
    }
  }

  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) fail(`--${name} requires a value.`);
    return v;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const brand = get("brand")?.trim();
  const domain = get("domain")?.trim();
  const category = get("category")?.trim();
  if (!brand) fail("Missing --brand");
  if (!domain) fail("Missing --domain");
  if (!category) fail("Missing --category");

  const probeModeRaw = (get("probe-mode") || "live").trim().toLowerCase();
  if (probeModeRaw !== "live" && probeModeRaw !== "simulated") {
    fail('--probe-mode must be "live" or "simulated".');
  }

  const promptsFile = get("prompts-file")?.trim();
  const competitors = parseCsv(get("competitors"));
  const allowUnguardedFrame = has("allow-unguarded-frame");
  const projectId = get("project-id")?.trim();

  if (
    projectId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId
    )
  ) {
    fail("--project-id must be a valid UUID.");
  }

  if (projectId && has("force-new-project")) {
    fail(
      "--project-id cannot be combined with --force-new-project."
    );
  }

  if (promptsFile && competitors.length === 0 && !allowUnguardedFrame) {
    fail("Missing --competitors. Custom prompts require an explicit competitor frame. Use --allow-unguarded-frame only for internal tests.");
  }

  if (promptsFile && competitors.length > 0 && competitors.length < 2 && !allowUnguardedFrame) {
    fail(`Competitor frame has only ${competitors.length} competitor(s). Add at least 2 competitors, ideally 3–5, before running the scan.`);
  }

  return {
    brand,
    domain,
    category,
    userId: get("userId")?.trim() || get("user-id")?.trim() || DEFAULT_USER_ID,
    projectId,
    prompts: parsePositiveInt(get("prompts"), DEFAULT_PROMPTS, "--prompts"),
    runs: parsePositiveInt(get("runs"), DEFAULT_RUNS, "--runs"),
    promptsFile,
    competitors,
    probeMode: probeModeRaw,
    dryRun: has("dry-run"),
    forceNewProject: has("force-new-project"),
    allowFewerPrompts: has("allow-fewer-prompts"),
    budgetUsd: parsePositiveMoney(get("budget-usd"), DEFAULT_BUDGET_USD, "--budget-usd"),
    out: get("out")?.trim(),
  };
}

function normalizeWebsiteUrl(domainOrUrl: string): string {
  const raw = domainOrUrl.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function hostnameOf(domainOrUrl: string): string {
  return new URL(normalizeWebsiteUrl(domainOrUrl)).hostname.replace(/^www\./, "");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "scan";
}

function timestampForFile(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function defaultOutPath(args: Args): string {
  return `./exports/${slugify(args.brand || args.domain)}-mvp-scan-${timestampForFile()}.md`;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function readCustomPromptLines(args: Args): string[] {
  if (!args.promptsFile) return [];

  const abs = resolve(args.promptsFile);
  let raw: string;

  try {
    raw = readFileSync(abs, "utf-8");
  } catch (error) {
    fail(`Could not read --prompts-file ${args.promptsFile}: ${(error as Error).message}`);
  }

  const seen = new Set<string>();
  const prompts: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const prompt = line.trim();
    if (!prompt || prompt.startsWith("#")) continue;

    const key = normalizePrompt(prompt);
    if (seen.has(key)) continue;

    seen.add(key);
    prompts.push(prompt);
  }

  if (prompts.length === 0) {
    fail(`--prompts-file ${args.promptsFile} contains no usable prompts.`);
  }

  return prompts;
}

function customPromptRows(args: Args): Array<Omit<GeneratedPrompt, "id" | "projectId" | "createdAt">> {
  const prompts = readCustomPromptLines(args);

  return prompts.map((prompt, index) => ({
    prompt,
    intentType: "manual",
    commercialValue: 5,
    winnability: 3,
    priority: index + 1,
    rationale: `Manual prompt from ${args.promptsFile}.`,
    selected: true,
  } as Omit<GeneratedPrompt, "id" | "projectId" | "createdAt">));
}

/**
 * Prompt rows as they *would* be stored from --prompts-file, so planning can
 * run the real selection before any paid probe. Ids are synthetic and never
 * persisted; file priorities are distinct, so id never affects sort order.
 */
function plannedFilePromptRows(args: Args): GeneratedPrompt[] {
  return customPromptRows(args).map((row, index) => ({
    ...row,
    id: `planned-${index}`,
    projectId: "planned",
    createdAt: new Date(0).toISOString(),
  }));
}

async function replacePromptsFromFileIfNeeded(args: Args, projectId: string): Promise<boolean> {
  if (!args.promptsFile) return false;

  const rows = customPromptRows(args);
  await getDb().replaceGeneratedPrompts(projectId, rows);
  return true;
}

function estimatedCost(liveProbeCalls: number): number {
  return Math.max(0, liveProbeCalls) * ESTIMATED_COST_PER_LIVE_PROBE_USD;
}

async function findExistingProject(args: Args): Promise<Project | null> {
  if (args.projectId) {
    const project =
      await getDb().getProject(args.projectId);

    if (!project) {
      throw new Error(
        `Reserved project ${args.projectId} was not found.`
      );
    }

    const requestedDomain =
      hostnameOf(args.domain).toLowerCase();

    const projectDomain =
      hostnameOf(project.domain).toLowerCase();

    if (projectDomain !== requestedDomain) {
      throw new Error(
        `Reserved project domain ${projectDomain} does not match requested domain ${requestedDomain}.`
      );
    }

    return project;
  }

  if (args.forceNewProject) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const host = hostnameOf(args.domain);
  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("user_id", args.userId)
    .eq("domain", host)
    .order("created_at", {
      ascending: false,
    })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) return null;

  return getDb().getProject(data.id);
}

function brandTerms(
  project: { companyName: string | null; domain: string },
  mirrorJson: unknown
): string[] {
  const terms = new Set<string>();
  if (project.companyName?.trim()) terms.add(project.companyName.trim());
  if (project.domain.trim()) {
    terms.add(project.domain.trim());
    const stem = project.domain.split(".")[0]?.trim();
    if (stem && stem.length >= 3) terms.add(stem);
  }
  const parsed = SiteReaderOutputSchema.safeParse(mirrorJson);
  if (parsed.success) {
    if (parsed.data.companyName.trim()) terms.add(parsed.data.companyName.trim());
    if (parsed.data.website.trim()) terms.add(parsed.data.website.trim());
  }
  return [...terms];
}

/**
 * Policy wrapper. EVERY shortfall — brand filtering, similarity rejection, or
 * an insufficient pool — flows through this single diagnostic path, so
 * --allow-fewer-prompts can accept any of them.
 */
function pickPromptTargets(
  prompts: GeneratedPrompt[],
  count: number,
  clientBrandTerms: string[],
  onShortfall: PromptShortfallPolicy = "throw"
): GeneratedPrompt[] {
  const selection = selectPromptTargets(prompts, count, clientBrandTerms);
  const outcome = applyPromptShortfallPolicy(selection, onShortfall);
  if (outcome.warning) console.warn(outcome.warning);
  return outcome.rows;
}

function mergeZypactCommercialSanityPromptsIfNeeded(args: Args, prompts: GeneratedPrompt[]): boolean {
  const host = hostnameOf(args.domain).toLowerCase();
  return host === "zypact.com" && prompts.length > 0;
}

async function ensureZypactCommercialSanityPromptsIfNeeded(args: Args, projectId: string): Promise<void> {
  const host = hostnameOf(args.domain).toLowerCase();
  if (host !== "zypact.com") return;

  const db = getDb();
  const existing = await db.getGeneratedPrompts(projectId);
  const byKey = new Map<string, Omit<GeneratedPrompt, "id" | "projectId" | "createdAt">>();
  for (const p of existing) {
    byKey.set(normalizePrompt(p.prompt), {
      prompt: p.prompt,
      intentType: p.intentType,
      commercialValue: p.commercialValue,
      winnability: p.winnability,
      priority: p.priority,
      rationale: p.rationale,
      selected: p.selected,
    });
  }
  for (const p of ZYPACT_COMMERCIAL_SANITY_PROMPTS) {
    byKey.set(normalizePrompt(p.prompt), p);
  }
  await db.replaceGeneratedPrompts(projectId, Array.from(byKey.values()));
}

function existingRunCount(rows: ProbeResult[], prompt: string, probeMode: RunnerProbeMode): number {
  const wantedMode: ProbeMode = probeMode === "live" ? "live_perplexity" : "simulated";
  const key = normalizePrompt(prompt);
  return rows.filter((r) => r.probeMode === wantedMode && normalizePrompt(r.prompt) === key).length;
}

function simulatedCompetitorNames(competitors: string[]): string[] {
  const names = competitors.length > 0
    ? competitors.slice(0, 2)
    : ["Example Visibility Tool", "Example SEO Platform"];

  return names.length >= 2 ? names : [...names, "Example SEO Platform"];
}

function makeSimulatedResponse(prompt: string, brand: string, competitors: string[]): string {
  const names = simulatedCompetitorNames(competitors);

  return [
    `For "${prompt}", the simulated answer recommends ${names[0]} and ${names[1]} as common options.`,
    `${brand} is not recommended in this simulated row.`,
    "This row is for free orchestration testing only and must not be used as market evidence.",
  ].join(" ");
}

async function saveSimulatedProbe(projectId: string, prompt: GeneratedPrompt, brand: string, competitors: string[]): Promise<ProbeResult> {
  const db = getDb();
  const run = await db.createProbeRun(projectId, "perplexity", "simulated", "succeeded");
  const names = simulatedCompetitorNames(competitors);

  return db.saveProbeResult({
    probeRunId: run.id,
    projectId,
    generatedPromptId: prompt.id,
    prompt: prompt.prompt,
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: makeSimulatedResponse(prompt.prompt, brand, competitors),
    rawProbeRequest: prompt.prompt,
    productMentioned: false,
    productPosition: "absent",
    productVerdict: "lost",
    citedAsSource: false,
    clientSourceCount: 0,
    platformsReferenced: [],
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: names.map((name, index) => ({
      name,
      position: index + 1,
      context: "simulated competitor from explicit competitor frame",
    })),
    sourcesCited: [],
    answerSummary: "Simulated orchestration row. The audited brand was not recommended as a product.",
    verdict: "lost",
    whyClientLost: "Simulated mode intentionally creates a lost row so the report path can be tested without paid probes.",
  });
}

async function runMissingProbes(args: Args, project: Project, promptTargets: GeneratedPrompt[]): Promise<{ attempted: number; saved: number; usedMock: boolean; promptsWithSavedRuns: number }> {
  const db = getDb();
  const beforeRows = await db.getProbeResultsByProject(project.id);
  const mirror = await db.getMirrorProfile(project.id);
  const mirrorParsed = SiteReaderOutputSchema.safeParse(mirror?.json ?? null);
  const brandName = project.companyName?.trim() || (mirrorParsed.success ? mirrorParsed.data.companyName.trim() : "") || args.brand;
  const terms = brandTerms(project, mirror?.json ?? null);
  const dbCompetitors = await db.getCompetitorsByProject(project.id);
  const mirrorCompetitors = mirrorParsed.success ? mirrorParsed.data.competitorsMentioned : [];
  const knownCompetitors = Array.from(new Set([...args.competitors, ...dbCompetitors.map((c) => c.name), ...mirrorCompetitors].filter(Boolean)));

  let attempted = 0;
  let saved = 0;
  let usedMock = false;
  let promptsWithSavedRuns = 0;

  for (const prompt of promptTargets) {
    const already = existingRunCount(beforeRows, prompt.prompt, args.probeMode);
    const missing = Math.max(0, args.runs - already);
    if (missing === 0) continue;

    let savedForPrompt = 0;

    for (let i = 0; i < missing; i += 1) {
      attempted += 1;
      if (args.probeMode === "simulated") {
        await saveSimulatedProbe(project.id, prompt, brandName, args.competitors);
        saved += 1;
        savedForPrompt += 1;
        usedMock = true;
        continue;
      }

      // Per-probe, so ownership loss stops the scan at the next probe
      // rather than after the whole phase. The in-flight call is allowed
      // to return; that is the bounded waste the policy accepts.
      assertLeaseOwnership();

      const live = await runPerplexityProbe({ prompt: prompt.prompt, brandName, domain: project.domain });
      usedMock = usedMock || live.usedMock;
      if (probeRequestLeaksClientIdentity({
        rawRequest: live.rawProbeRequest ?? prompt.prompt,
        originalPrompt: prompt.prompt,
        brandTerms: terms,
        domain: project.domain,
      })) {
        throw new Error(`Probe request integrity failed for prompt: ${prompt.prompt}`);
      }

      const analyzed = await analyzeProbeResponse({
        projectId: project.id,
        generatedPromptId: prompt.id,
        prompt: prompt.prompt,
        platform: "perplexity",
        rawResponse: live.rawResponse,
        rawProbeRequest: live.rawProbeRequest,
        knownCompetitors,
        probeMode: "live_perplexity",
      });
      if (!analyzed.ok) throw new Error(analyzed.error);
      saved += 1;
      savedForPrompt += 1;
    }

    if (savedForPrompt > 0) promptsWithSavedRuns += 1;
  }

  return { attempted, saved, usedMock, promptsWithSavedRuns };
}

async function ensureProject(
  args: Args
): Promise<{
  project: Project;
  created: boolean;
}> {
  const existing =
    await findExistingProject(args);

  if (existing) {
    const mirror =
      await getDb().getMirrorProfile(
        existing.id
      );

    if (!mirror && args.projectId) {
      const scan = await runMirrorScan({
        websiteUrl:
          normalizeWebsiteUrl(args.domain),
        companyName: args.brand,
        userId: existing.userId,
        projectId: existing.id,
        onStage: async (stage) => {
          await updateSnapshotProgress(
            args,
            stage
          );
        },
      });

      if (!scan.ok) {
        throw new Error(
          `Mirror scan failed: ${scan.error}`
        );
      }

      if (
        args.category &&
        scan.project.category !==
          args.category
      ) {
        await getDb().updateProjectCategory(
          scan.project.id,
          args.category
        );
      }

      return {
        project: {
          ...scan.project,
          category:
            args.category ||
            scan.project.category,
        },
        created: false,
      };
    }

    if (
      args.category &&
      existing.category !== args.category
    ) {
      await getDb().updateProjectCategory(
        existing.id,
        args.category
      );

      return {
        project: {
          ...existing,
          category: args.category,
        },
        created: false,
      };
    }

    return {
      project: existing,
      created: false,
    };
  }

  const scan = await runMirrorScan({
    websiteUrl:
      normalizeWebsiteUrl(args.domain),
    companyName: args.brand,
    userId: args.userId,
  });

  if (!scan.ok) {
    throw new Error(
      `Mirror scan failed: ${scan.error}`
    );
  }

  if (args.category) {
    await getDb().updateProjectCategory(
      scan.project.id,
      args.category
    );
  }

  return {
    project: {
      ...scan.project,
      category:
        args.category ||
        scan.project.category,
    },
    created: true,
  };
}

async function ensureMirrorProfile(project: Project): Promise<"run" | "reuse"> {
  const mirror = await getDb().getMirrorProfile(project.id);
  if (mirror) return "reuse";
  throw new Error(
    `Project ${project.id} has no Mirror Profile after project preparation.`
  );
}

async function ensurePrompts(args: Args, project: Project): Promise<"generate" | "reuse" | "file"> {
  if (await replacePromptsFromFileIfNeeded(args, project.id)) {
    return "file";
  }

  const db = getDb();
  const existing = await db.getGeneratedPrompts(project.id);
  if (existing.length > 0) {
    if (mergeZypactCommercialSanityPromptsIfNeeded(args, existing)) {
      await ensureZypactCommercialSanityPromptsIfNeeded(args, project.id);
    }
    return "reuse";
  }

  const generated = await generateBuyerPrompts({
    projectId: project.id,
    userInputs: {
      category: args.category,
      audience: ["B2B SaaS marketing teams", "Heads of Marketing", "Growth teams"],
      competitors: args.competitors.length > 0
        ? args.competitors
        : ["Profound", "Otterly AI", "Peec AI", "AthenaHQ", "Scrunch AI", "Goodie AI", "Semrush", "Ahrefs Brand Radar"],
    },
  });
  if (!generated.ok) throw new Error(`Prompt generation failed: ${generated.error}`);
  await ensureZypactCommercialSanityPromptsIfNeeded(args, project.id);
  return "generate";
}

async function ensureEvidenceBank(projectId: string): Promise<"create" | "reuse"> {
  const before = await getDb().getEvidenceBankByProject(projectId);
  if (before) return "reuse";
  const bank = await getOrCreateEvidenceBank(projectId);
  if (!bank.ok) throw new Error(`Evidence Bank failed: ${bank.error}`);
  return "create";
}

async function regenerateRecommendations(projectId: string): Promise<void> {
  const competitors = await discoverCompetitors({ projectId });
  if (!competitors.ok) {
    console.warn(
      `[mvp-scan] Competitor discovery failed; continuing with existing probe evidence. ${competitors.error}`
    );
  }

  const gapMap = await generateGapMap({ projectId });
  if (!gapMap.ok) {
    console.warn(`[mvp-scan] Gap Map failed; continuing to export report. ${gapMap.error}`);
    return;
  }

  const gaps = await getDb().getGapsByProject(projectId);
  if (gaps.length > 0) {
    const fix = await generateFixBrief({ projectId, gapId: gaps[0]!.id });
    if (!fix.ok) {
      console.warn(`[mvp-scan] Fix Brief failed; continuing to export report. ${fix.error}`);
    }
  }
}

async function exportReport(args: Args, project: Project, outPath: string): Promise<string> {
  const db = getDb();
  const [mirrorProfile, prompts, probeResults, competitors, gapMap, gaps, evidenceBank, fixBriefs, assets, qaReports] = await Promise.all([
    db.getMirrorProfile(project.id),
    db.getGeneratedPrompts(project.id),
    db.getProbeResultsByProject(project.id),
    db.getCompetitorsByProject(project.id),
    db.getLatestGapMap(project.id),
    db.getGapsByProject(project.id),
    db.getEvidenceBankByProject(project.id),
    db.getFixBriefsByProject(project.id),
    db.getGeneratedAssetsByProject(project.id),
    db.getQaReportsByProject(project.id),
  ]);

  const latestQaByAsset = new Map<string, QaReportRow>();
  for (const qa of qaReports) {
    const prev = latestQaByAsset.get(qa.generatedAssetId);
    if (!prev || Date.parse(qa.createdAt) > Date.parse(prev.createdAt)) latestQaByAsset.set(qa.generatedAssetId, qa);
  }

  const sensitiveValues = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.PERPLEXITY_API_KEY,
  ].filter((v): v is string => Boolean(v));

  const report = buildMvpReport({
    project,
    mirrorProfile,
    prompts,
    probeResults,
    competitors,
    gapMap,
    gaps,
    evidenceBank,
    fixBriefs,
    assets,
    latestQaByAsset,
    llmProvider: process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "mock"),
    llmModel: process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || "mock",
    mockMode: process.env.ZYPACT_MOCK_MODE === "on" || (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY),
    sensitiveValues,
  });

  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, report.markdown, "utf-8");
  return abs;
}

async function buildPlan(args: Args): Promise<{ plan: StagePlan; project: Project | null; outputPath: string; promptSelection: PlanPromptSelection; spend: PlanSpendEstimate; shortfallBlocksExecution: boolean }> {
  const existing = await findExistingProject(args);
  const outputPath = args.out || defaultOutPath(args);
  let project = existing;
  const db = getDb();
  const customPrompts = readCustomPromptLines(args);
  const plannedPromptCount = customPrompts.length > 0 ? Math.min(args.prompts, customPrompts.length) : args.prompts;
  const mergesSanityPrompts = hostnameOf(args.domain).toLowerCase() === "zypact.com";

  let mirrorAction: StagePlan["mirror"] = "run";
  let promptAction: StagePlan["prompts"] = customPrompts.length > 0 ? "file" : "generate";
  let bankAction: StagePlan["evidenceBank"] = "create";

  let promptSelection: PlanPromptSelection = {
    kind: "unknown",
    basis: "prompts are generated during the scan",
  };

  // Default: a planning-only figure, never treated as final.
  let spend: PlanSpendEstimate = {
    kind: "not_final",
    missingProbeCalls: plannedPromptCount * args.runs,
    estimatedSpend: 0,
  };

  if (project) {
    const [mirror, prompts, bank, probeRows] = await Promise.all([
      db.getMirrorProfile(project.id),
      db.getGeneratedPrompts(project.id),
      db.getEvidenceBankByProject(project.id),
      db.getProbeResultsByProject(project.id),
    ]);
    mirrorAction = mirror ? "reuse" : "run";
    promptAction = customPrompts.length > 0 ? "file" : (prompts.length > 0 ? "reuse" : "generate");
    bankAction = bank ? "reuse" : "create";

    // companyName and domain are immutable after project creation — the only
    // project mutation in the DbAdapter is updateProjectCategory — so these
    // are provably the brand terms execution will use.
    const executionBrandTerms = brandTerms(project, null);

    // Same reuse arithmetic runMissingProbes performs.
    const missingFor = (rows: GeneratedPrompt[]): number =>
      rows.reduce(
        (acc, p) => acc + Math.max(0, args.runs - existingRunCount(probeRows, p.prompt, args.probeMode)),
        0
      );

    if (customPrompts.length > 0) {
      // --prompts-file short-circuits the sanity merge in ensurePrompts, so
      // the execution candidate pool is exactly the file contents.
      const selection = selectPromptTargets(
        plannedFilePromptRows(args),
        plannedPromptCount,
        executionBrandTerms
      );
      promptSelection = {
        kind: "exact",
        count: selection.selected,
        basis: "file prompts, brand-filtered with the project terms",
      };
      spend = { kind: "exact", missingProbeCalls: missingFor(selection.rows), estimatedSpend: 0 };
    } else if (prompts.length > 0) {
      const selection = selectPromptTargets(prompts, args.prompts, executionBrandTerms);
      if (mergesSanityPrompts) {
        // The merge ADDS candidates at execution; a pre-merge count bounds
        // nothing in either direction, and probes may run even at zero here.
        promptSelection = {
          kind: "unknown",
          basis: "extra sanity prompts are merged for this domain at execution",
        };
        spend = { kind: "not_final", missingProbeCalls: missingFor(selection.rows), estimatedSpend: 0 };
      } else {
        promptSelection = {
          kind: "exact",
          count: selection.selected,
          basis: "stored prompts, brand-filtered with the project terms",
        };
        spend = { kind: "exact", missingProbeCalls: missingFor(selection.rows), estimatedSpend: 0 };
      }
    }
  } else if (customPrompts.length > 0) {
    promptSelection = {
      kind: "unknown",
      basis: "project does not exist yet; execution brand terms are not yet known",
    };
  }

  // An exact shortfall without the override stops execution before any probe.
  const shortfallBlocksExecution =
    promptSelection.kind === "exact" &&
    promptSelection.count < args.prompts &&
    !args.allowFewerPrompts;

  // No probes can run under these arguments, so there is no executable cost
  // to present and no budget decision to make.
  spend = shortfallBlocksExecution
    ? { ...spend, kind: "not_applicable", estimatedSpend: 0 }
    : {
        ...spend,
        estimatedSpend: args.probeMode === "live" ? estimatedCost(spend.missingProbeCalls) : 0,
      };

  // "skip" promises nothing will run — only an exact estimate may promise it.
  const probeStage: StagePlan["probes"] = shortfallBlocksExecution
    ? "blocked"
    : spend.kind === "exact"
      ? spend.missingProbeCalls > 0 ? "run" : "skip"
      : "pending";

  return {
    project,
    outputPath,
    promptSelection,
    spend,
    shortfallBlocksExecution,
    plan: {
      project: existing ? "reuse" : "create",
      mirror: mirrorAction,
      prompts: promptAction,
      evidenceBank: bankAction,
      probes: probeStage,
      recommendations: probeStage,
      export: args.dryRun ? "skip" : "write",
    },
  };
}

function formatPlanSelection(selection: PlanPromptSelection): string {
  if (selection.kind === "exact") {
    return `${selection.count} (exact — ${selection.basis})`;
  }
  return `not yet known — exact selection occurs before probes (${selection.basis})`;
}

function printPlan(args: Args, plan: StagePlan, outputPath: string, spend: PlanSpendEstimate, promptSelection: PlanPromptSelection): void {
  console.log("Zypact MVP scan plan");
  console.log(`brand          : ${args.brand}`);
  console.log(`domain         : ${hostnameOf(args.domain)}`);
  console.log(`category       : ${args.category}`);
  console.log(`userId         : ${args.userId}`);
  if (args.projectId) {
    console.log(
      `reserved project: ${args.projectId}`
    );
  }
  console.log(`probe mode     : ${args.probeMode}`);
  if (args.forceNewProject) console.log(`force new      : yes`);
  if (args.promptsFile) {
    console.log(`custom prompts : yes`);
    console.log(`prompt source  : file (${args.promptsFile})`);
  }
  if (args.competitors.length > 0) {
    console.log(`competitors    : ${args.competitors.join(", ")}`);
  }
  if (args.allowFewerPrompts) {
    console.log(`allow fewer    : yes (--allow-fewer-prompts)`);
  }
  console.log(`prompts req.   : ${args.prompts}`);
  console.log(`prompts sel.   : ${formatPlanSelection(promptSelection)}`);
  if (promptSelection.kind === "exact" && promptSelection.count < args.prompts) {
    console.log(
      args.allowFewerPrompts
        ? `prompt shortfall: execution will continue with ${promptSelection.count} because --allow-fewer-prompts is enabled`
        : `prompt shortfall: execution will stop unless --allow-fewer-prompts is enabled`
    );
  }
  console.log(`runs / prompt  : ${args.runs}`);
  if (spend.kind === "not_applicable") {
    const blocked = "not applicable — execution is blocked by prompt shortfall";
    console.log(`missing probes : ${blocked}`);
    console.log(`estimated cost : ${blocked}`);
  } else {
    const spendIsExact = spend.kind === "exact";
    console.log(
      `missing probes : ${spendIsExact ? String(spend.missingProbeCalls) : `not final (planning estimate ${spend.missingProbeCalls})`}`
    );
    console.log(
      `estimated cost : ${spendIsExact ? `$${spend.estimatedSpend.toFixed(2)}` : `not final (planning estimate $${spend.estimatedSpend.toFixed(2)})`}`
    );
  }
  console.log(`budget limit   : $${args.budgetUsd.toFixed(2)}`);
  console.log(`output path    : ${outputPath}`);
  console.log("stages:");
  console.log(`  · project        : ${plan.project}`);
  console.log(`  · mirror profile : ${plan.mirror}`);
  console.log(`  · prompt mirror  : ${plan.prompts}`);
  console.log(`  · evidence bank  : ${plan.evidenceBank}`);
  console.log(`  · probes         : ${plan.probes}`);
  console.log(`  · recommendations: ${plan.recommendations}`);
  console.log(`  · export         : ${plan.export}`);
}

function scorecardLine(rows: ProbeResult[], project: Project, mirrorJson: unknown): string {
  const summary = buildProbeSetSummary(rows, null, { brandTerms: brandTerms(project, mirrorJson) });
  const groups = summary.scorecardPromptGroups;
  const won = groups.filter((g) => g.verdict === "won").length;
  const partial = groups.filter((g) => g.verdict === "partial").length;
  const lost = groups.filter((g) => g.verdict === "lost").length;
  const runs = summary.scorecardProbeResults.length;
  const productRuns = summary.scorecardProbeResults.filter((r) => r.clientPosition === "primary" || r.clientPosition === "listed").length;
  const sourceRuns = summary.scorecardProbeResults.filter((r) => r.citedAsSource).length;
  const negativeRuns = summary.scorecardProbeResults.filter((r) => r.clientPosition === "negative").length;
  const productRate = runs > 0 ? Math.round((productRuns / runs) * 100) : 0;
  const sourceRate = runs > 0 ? Math.round((sourceRuns / runs) * 100) : 0;
  const negativeRate = runs > 0 ? Math.round((negativeRuns / runs) * 100) : 0;
  return `${won} won · ${partial} partial · ${lost} lost · recommendedAsProduct ${productRate}% · citedAsSource ${sourceRate}% · negativeMentions ${negativeRate}%`;
}


async function updateSnapshotProgress(
  args: Args,
  stage: SnapshotProgressStage
): Promise<void> {
  const requestId =
    process.env.SNAPSHOT_REQUEST_ID?.trim();

  if (!requestId) return;

  if (!args.projectId) {
    throw new Error(
      "Snapshot progress requires an explicit reserved project."
    );
  }

  // Under a worker, the request carries a claim token and every manual RPC
  // refuses it. The token arrives through the environment from the reusable
  // execution function and is never logged or written to disk.
  const claimToken =
    process.env.SNAPSHOT_CLAIM_TOKEN?.trim();

  const db = getDb();

  const updated = claimToken
    ? await db.updateSnapshotRequestProgressWorker?.({
        requestId,
        projectId: args.projectId,
        claimToken,
        stage,
      })
    : await db.updateSnapshotRequestProgress(
        requestId,
        args.projectId,
        stage
      );

  if (!updated) {
    throw new Error(
      `Snapshot progress update failed for stage ${stage}.`
    );
  }

  console.log(
    `snapshot progress : ${stage}`
  );
}

function validatePromptFilePlaceholdersBeforeScan(
  promptsFile: string | undefined,
  dryRun: boolean,
  allowUnguardedFrame: boolean,
): void {
  if (!promptsFile || dryRun || allowUnguardedFrame) {
    return;
  }

  const promptLines = readFileSync(promptsFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const hardPlaceholderPattern = /\[[^\]]+\]|\{[^}]+\}|<[^>]+>/;
  const softPlaceholderPattern = /\bcategory\b|\bbuyer persona\b|\bjob-to-be-done\b|\burgent pain\b/i;

  const blockedPromptLines = promptLines.filter((line) => hardPlaceholderPattern.test(line));
  const suspiciousPromptLines = promptLines.filter((line) =>
    !hardPlaceholderPattern.test(line) && softPlaceholderPattern.test(line)
  );

  if (blockedPromptLines.length > 0) {
    fail(
      `Prompts file contains hard placeholder prompts: ${promptsFile}\n` +
      blockedPromptLines.slice(0, 5).map((line) => `- ${line}`).join("\n") +
      "\nReplace placeholders with real buyer prompts, or use --dry-run for examples."
    );
  }

  if (suspiciousPromptLines.length > 0) {
    console.warn(`⚠ ${suspiciousPromptLines.length} prompt(s) look generic — review before sending:`);
    for (const line of suspiciousPromptLines.slice(0, 5)) {
      console.warn(`- ${line}`);
    }
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  validatePromptFilePlaceholdersBeforeScan(
    args.promptsFile,
    rawArgs.includes("--dry-run"),
    rawArgs.includes("--allow-unguarded-frame"),
  );
  // Start renewing before any provider-capable work. A throw here is a
  // configuration error: a claimed run must never proceed without a plan
  // to keep its lease alive.
  const leaseConfig = readLeaseRenewalConfigFromEnv(process.env);
  if (leaseConfig) {
    leaseRenewer = new LeaseRenewer(leaseConfig, { db: getDb() });

    // Awaited: startup performs a real renewal, so ownership is proven
    // before a single provider-capable operation begins. A refused or
    // throwing initial renewal leaves no timer running and stops the scan
    // here, before any money is spent.
    const started = await leaseRenewer.start();

    if (!started.owned) {
      throw new Error(
        `Worker lease could not be established (${started.reason}): ${started.detail}`
      );
    }
  }

  const originalMockMode = process.env.ZYPACT_MOCK_MODE;
  if (args.probeMode === "simulated") process.env.ZYPACT_MOCK_MODE = "on";

  const dry = await buildPlan(args);
  printPlan(args, dry.plan, dry.outputPath, dry.spend, dry.promptSelection);

  // A blocked plan runs no probes, so there is no budget decision to make.
  // Only an EXACT missing-probe calculation may hard-stop here; anything else
  // defers to the exact pre-probe guard, which runs before any spend.
  if (
    !dry.shortfallBlocksExecution &&
    dry.spend.kind === "exact" &&
    dry.spend.estimatedSpend > args.budgetUsd
  ) {
    fail(`Budget guard stopped scan before paid probes. Estimated $${dry.spend.estimatedSpend.toFixed(2)} exceeds budget $${args.budgetUsd.toFixed(2)}.`);
  }
  if (args.dryRun) {
    console.log("dry-run complete: no paid probes, no writes.");
    return;
  }
  if (args.probeMode === "live" && !process.env.PERPLEXITY_API_KEY) {
    fail("PERPLEXITY_API_KEY is required for --probe-mode live. Use --probe-mode simulated for a free test.");
  }

  const ensuredProject = await ensureProject(args);
  const project = ensuredProject.project;
  await ensureMirrorProfile(project);

  const existingPrompts =
    await getDb().getGeneratedPrompts(
      project.id
    );

  if (existingPrompts.length === 0) {
    assertLeaseOwnership();

    await updateSnapshotProgress(
      args,
      "generating_questions"
    );
  } else {
    console.log(
      "snapshot progress : generating_questions skipped (prompts reused)"
    );
  }

  await ensurePrompts(args, project);
  await ensureEvidenceBank(project.id);

  const prompts =
    await getDb().getGeneratedPrompts(
      project.id
    );

  const targets =
    pickPromptTargets(
      prompts,
      args.prompts,
      brandTerms(project, null),
      args.allowFewerPrompts ? "warn" : "throw"
    );

  // Final, exact accounting before any external probe call.
  const probeRowsBeforeRun =
    await getDb().getProbeResultsByProject(project.id);
  const probesToRun = targets.reduce(
    (acc, p) => acc + Math.max(0, args.runs - existingRunCount(probeRowsBeforeRun, p.prompt, args.probeMode)),
    0
  );
  const exactSpend =
    args.probeMode === "live" ? estimatedCost(probesToRun) : 0;

  console.log(`prompt targets    : ${targets.length} of ${args.prompts} requested (exact)`);
  console.log(`probes to run     : ${probesToRun}`);
  console.log(`estimated cost    : $${exactSpend.toFixed(2)} (exact)`);

  if (exactSpend > args.budgetUsd) {
    fail(
      `Budget guard stopped scan before paid probes. Exact $${exactSpend.toFixed(2)} exceeds budget $${args.budgetUsd.toFixed(2)}.`
    );
  }

  assertLeaseOwnership();

  await updateSnapshotProgress(
    args,
    "checking_ai_visibility"
  );

  const probeRun = await runMissingProbes(
    args,
    project,
    targets
  );

  assertLeaseOwnership();

  await updateSnapshotProgress(
    args,
    "building_diagnosis"
  );

  const afterProbes =
    await getDb().getProbeResultsByProject(
      project.id
    );

  if (afterProbes.length > 0) {
    await regenerateRecommendations(
      project.id
    );
  }

  const outputAbs =
    await exportReport(
      args,
      project,
      dry.outputPath
    );

  assertLeaseOwnership();

  await updateSnapshotProgress(
    args,
    "quality_review"
  );

  const [mirror, competitors, gaps, fixBriefs, finalProbes] = await Promise.all([
    getDb().getMirrorProfile(project.id),
    getDb().getCompetitorsByProject(project.id),
    getDb().getGapsByProject(project.id),
    getDb().getFixBriefsByProject(project.id),
    getDb().getProbeResultsByProject(project.id),
  ]);

  const topCompetitors = competitors
    .sort((a, b) => b.mentionCount - a.mentionCount)
    .slice(0, 5)
    .map((c) => c.name)
    .join(", ") || "none";
  const currentFix = fixBriefs[0];
  const spend = args.probeMode === "live" ? estimatedCost(probeRun.saved) : 0;

  console.log("MVP scan completed.");
  console.log(`projectId           : ${project.id}`);
  console.log(`report path         : ${outputAbs}`);
  console.log(`probe mode          : ${args.probeMode}`);
  console.log(`prompt targets      : ${targets.length} of ${args.prompts} requested`);
  console.log(`prompts with new runs: ${probeRun.promptsWithSavedRuns}`);
  console.log(`probes saved        : ${probeRun.saved}`);
  console.log(`scorecard           : ${scorecardLine(finalProbes, project, mirror?.json ?? null)}`);
  console.log(`top competitors     : ${topCompetitors}`);
  console.log(`prioritized gaps    : ${gaps.length}`);
  console.log(`current fix brief   : ${currentFix ? `${currentFix.fixType} / ${currentFix.status}` : "none"}`);
  console.log(`api cost estimate   : $${spend.toFixed(2)} used / $${args.budgetUsd.toFixed(2)} budget`);

  if (originalMockMode === undefined) delete process.env.ZYPACT_MOCK_MODE;
  else process.env.ZYPACT_MOCK_MODE = originalMockMode;

  // Leave the parent a full lease. Once this process exits, nothing renews
  // again: the parent still has to render the short report and perform the
  // fenced completion write, and both are refused if the lease has lapsed.
  if (leaseRenewer) {
    const finalOwnership = await leaseRenewer.renewOnce();
    leaseRenewer.stop();

    if (!finalOwnership.owned) {
      throw new Error(
        `Worker lease could not be renewed before report handoff (${finalOwnership.reason}): ${finalOwnership.detail}`
      );
    }
  }
}

main().catch((err) => {
  // Stop renewing on any failure. A crashed scan must not keep the request
  // pinned in `running`; letting the lease lapse makes it reclaimable.
  leaseRenewer?.stop();

  if (err instanceof Error) {
    console.error(err.stack || err.message);
  } else {
    console.error("Non-Error thrown:");
    try {
      console.error(JSON.stringify(err, null, 2));
    } catch {
      console.error(String(err));
    }
  }
  process.exit(1);
});
