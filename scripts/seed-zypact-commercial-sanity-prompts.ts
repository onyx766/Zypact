#!/usr/bin/env tsx
import "dotenv/config";
import { getDb } from "@/lib/db";
import type { GeneratedPromptInput } from "@/lib/db/types";
import { ZYPACT_COMMERCIAL_SANITY_PROMPTS } from "@/lib/prompts/commercial-selection";

function key(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  const projectId = process.argv[2]?.trim();
  if (!projectId) {
    console.error("Usage: scripts/run-with-env.py npm run seed:zypact-commercial-prompts <projectId>");
    process.exit(1);
  }
  const db = getDb();
  const project = await db.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const existing = await db.getGeneratedPrompts(projectId);
  const byKey = new Map<string, GeneratedPromptInput>();
  for (const p of existing) {
    byKey.set(key(p.prompt), {
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
    byKey.set(key(p.prompt), p);
  }

  const next = Array.from(byKey.values()).map((p) => ({ ...p }));
  // Keep the fixed sanity prompts selected and high-priority; leave other rows
  // as-is so the prompt mirror remains auditable.
  const stored = await db.replaceGeneratedPrompts(projectId, next);
  const sanity = stored.filter((p) => ZYPACT_COMMERCIAL_SANITY_PROMPTS.some((s) => key(s.prompt) === key(p.prompt)));

  console.log("Zypact commercial sanity prompts seeded.");
  console.log(`projectId: ${projectId}`);
  console.log(`total prompts stored: ${stored.length}`);
  console.log("sanity prompts:");
  for (const p of sanity) {
    console.log(`  · ${p.intentType} / priority=${p.priority} / selected=${p.selected ? "yes" : "no"} / ${p.prompt}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
