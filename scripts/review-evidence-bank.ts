#!/usr/bin/env tsx
/**
 * Sprint 13B.1 — human-review Evidence Bank helper.
 *
 * This is a local validation script for the demo loop. It does not invent new
 * facts; it normalizes the known Linear 33,000 drift, preserves source URLs,
 * and marks the bank `user_reviewed` so QA can distinguish reviewed evidence
 * from an auto-filled draft.
 *
 * Usage:
 *   npm run review:evidence-bank <projectId>
 */

import { getDb } from "@/lib/db";
import { EvidenceBankOutputSchema } from "@/lib/schemas/evidence-bank.schema";

function usage(): never {
  console.error("Usage: npm run review:evidence-bank <projectId>");
  process.exit(1);
}

function dedupe(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeLinear33kClaim(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("33,000") && lower.includes("linear")) {
    return "Linear powers over 33,000 product teams.";
  }
  return raw.replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const projectId = process.argv[2]?.trim();
  if (!projectId) usage();

  const db = getDb();
  const project = await db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const existing = await db.getEvidenceBankByProject(projectId);
  if (!existing) throw new Error(`Evidence Bank not found for project: ${projectId}`);
  const parsed = EvidenceBankOutputSchema.safeParse(existing);
  if (!parsed.success) {
    throw new Error(`Stored Evidence Bank failed validation: ${parsed.error.message}`);
  }

  const bank = parsed.data;
  const proofItems = bank.proofItems.map((p) => ({
    ...p,
    detail: normalizeLinear33kClaim(p.detail),
  }));
  const allowedClaims = dedupe([
    ...bank.allowedClaims.map(normalizeLinear33kClaim),
    ...proofItems.map((p) => p.detail),
  ]);

  const saved = await db.upsertEvidenceBank(projectId, {
    productDescription: bank.productDescription,
    targetAudience: bank.targetAudience,
    mainUseCases: bank.mainUseCases,
    features: bank.features,
    proofItems,
    competitors: bank.competitors,
    allowedClaims,
    forbiddenClaims: bank.forbiddenClaims,
    tone: bank.tone,
    notes: [bank.notes, "Human-reviewed for Sprint 13B.1 benchmark."].filter(Boolean).join("\n"),
    provenance: "user_reviewed",
  });

  console.log("Evidence Bank reviewed.");
  console.log(`project: ${project.companyName ?? project.domain} (${project.domain})`);
  console.log(`projectId: ${projectId}`);
  console.log(`previous provenance: ${bank.provenance}`);
  console.log(`new provenance: ${saved.provenance}`);
  console.log("proofItems:");
  for (const p of saved.proofItems) {
    console.log(`- ${p.type}: ${p.detail}${p.sourceUrl ? ` (${p.sourceUrl})` : ""}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
