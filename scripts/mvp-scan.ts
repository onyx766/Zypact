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
import type { GeneratedPrompt, ProbeMode, ProbeResult, Project, QaReportRow } from "@/lib/db/types";
import { runMirrorScan } from "@/lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "@/lib/pipeline/generate-buyer-prompts";
import { getOrCreateEvidenceBank } from "@/lib/pipeline/get-or-create-evidence-bank";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { discoverCompetitors } from "@/lib/pipeline/discover-competitors";
import { generateGapMap } from "@/lib/pipeline/generate-gap-map";
import { generateFixBrief } from "@/lib/pipeline/generate-fix-brief";
import { buildMvpReport } from "@/lib/export/build-mvp-report";
import { chooseCommercialPromptRows } from "@/lib/prompts/commercial-selection";
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
  budgetUsd: number;
  out?: string;
}

interface StagePlan {
  project: "create" | "reuse";
  mirror: "run" | "reuse";
  prompts: "generate" | "reuse" | "file";
  evidenceBank: "create" | "reuse";
  probes: "run" | "skip";
  recommendations: "run" | "skip";
  export: "write" | "skip";
}

const DEFAULT_USER_ID = "a76f133a-b3ef-4440-b418-dddb3e1ea524";
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

function brandTerms(project: Project, mirrorJson: unknown): string[] {
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

function pickPromptTargets(prompts: GeneratedPrompt[], count: number): GeneratedPrompt[] {
  const selected = prompts.filter((p) => p.selected);
  const candidates = selected.length > 0 ? selected : prompts;
  return chooseCommercialPromptRows(candidates, Math.max(1, Math.min(count, candidates.length)));
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

async function runMissingProbes(args: Args, project: Project, promptTargets: GeneratedPrompt[]): Promise<{ attempted: number; saved: number; usedMock: boolean }> {
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

  for (const prompt of promptTargets) {
    const already = existingRunCount(beforeRows, prompt.prompt, args.probeMode);
    const missing = Math.max(0, args.runs - already);
    if (missing === 0) continue;

    for (let i = 0; i < missing; i += 1) {
      attempted += 1;
      if (args.probeMode === "simulated") {
        await saveSimulatedProbe(project.id, prompt, brandName, args.competitors);
        saved += 1;
        usedMock = true;
        continue;
      }

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
    }
  }

  return { attempted, saved, usedMock };
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

async function buildPlan(args: Args): Promise<{ plan: StagePlan; project: Project | null; outputPath: string; missingProbeCalls: number; estimatedSpend: number }> {
  const existing = await findExistingProject(args);
  const outputPath = args.out || defaultOutPath(args);
  let project = existing;
  const db = getDb();
  const customPrompts = readCustomPromptLines(args);
  const plannedPromptCount = customPrompts.length > 0 ? Math.min(args.prompts, customPrompts.length) : args.prompts;

  let mirrorAction: StagePlan["mirror"] = "run";
  let promptAction: StagePlan["prompts"] = customPrompts.length > 0 ? "file" : "generate";
  let bankAction: StagePlan["evidenceBank"] = "create";
  let missingProbeCalls = plannedPromptCount * args.runs;

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
    if (customPrompts.length > 0) {
      missingProbeCalls = plannedPromptCount * args.runs;
    } else if (prompts.length > 0) {
      const targets = pickPromptTargets(prompts, args.prompts);
      missingProbeCalls = targets.reduce((acc, p) => acc + Math.max(0, args.runs - existingRunCount(probeRows, p.prompt, args.probeMode)), 0);
    }
  }

  const estimatedSpend = args.probeMode === "live" ? estimatedCost(missingProbeCalls) : 0;
  return {
    project,
    outputPath,
    missingProbeCalls,
    estimatedSpend,
    plan: {
      project: existing ? "reuse" : "create",
      mirror: mirrorAction,
      prompts: promptAction,
      evidenceBank: bankAction,
      probes: missingProbeCalls > 0 ? "run" : "skip",
      recommendations: missingProbeCalls > 0 ? "run" : "skip",
      export: args.dryRun ? "skip" : "write",
    },
  };
}

function printPlan(args: Args, plan: StagePlan, outputPath: string, missingProbeCalls: number, estimatedSpend: number): void {
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
  console.log(`prompts x runs : ${args.prompts} x ${args.runs}`);
  console.log(`missing probes : ${missingProbeCalls}`);
  console.log(`estimated cost : $${estimatedSpend.toFixed(2)}`);
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
  const originalMockMode = process.env.ZYPACT_MOCK_MODE;
  if (args.probeMode === "simulated") process.env.ZYPACT_MOCK_MODE = "on";

  const dry = await buildPlan(args);
  printPlan(args, dry.plan, dry.outputPath, dry.missingProbeCalls, dry.estimatedSpend);

  if (dry.estimatedSpend > args.budgetUsd) {
    fail(`Budget guard stopped scan before paid probes. Estimated $${dry.estimatedSpend.toFixed(2)} exceeds budget $${args.budgetUsd.toFixed(2)}.`);
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
  await ensurePrompts(args, project);
  await ensureEvidenceBank(project.id);

  const prompts = await getDb().getGeneratedPrompts(project.id);
  const targets = pickPromptTargets(prompts, args.prompts);
  const probeRun = await runMissingProbes(args, project, targets);

  const afterProbes = await getDb().getProbeResultsByProject(project.id);
  if (afterProbes.length > 0) await regenerateRecommendations(project.id);
  const outputAbs = await exportReport(args, project, dry.outputPath);

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
  console.log(`probes saved        : ${probeRun.saved}`);
  console.log(`scorecard           : ${scorecardLine(finalProbes, project, mirror?.json ?? null)}`);
  console.log(`top competitors     : ${topCompetitors}`);
  console.log(`prioritized gaps    : ${gaps.length}`);
  console.log(`current fix brief   : ${currentFix ? `${currentFix.fixType} / ${currentFix.status}` : "none"}`);
  console.log(`api cost estimate   : $${spend.toFixed(2)} used / $${args.budgetUsd.toFixed(2)} budget`);

  if (originalMockMode === undefined) delete process.env.ZYPACT_MOCK_MODE;
  else process.env.ZYPACT_MOCK_MODE = originalMockMode;
}

main().catch((err) => {
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
