import { getDb } from "@/lib/db";
import type { EvidenceBankRow } from "@/lib/db/types";
import {
  EvidenceBankInputSchema,
  EvidenceBankOutputSchema,
  type EvidenceBankInput,
  type EvidenceBankOutput,
} from "@/lib/schemas/evidence-bank.schema";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import { buildEvidenceBankPrefill } from "@/lib/evidence-bank/build-evidence-bank-prefill";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 6 pipeline helper — get-or-create.
 *
 *  1. Load project.
 *  2. Load existing Evidence Bank; return as-is if present.
 *  3. Otherwise load latest Mirror Profile, revalidate, build prefill draft,
 *     save it, and return.
 *
 * Wrapped in `withPipelineStep("evidence-bank")` so the run shows up in the
 * pipeline log alongside every other agent step.
 */

export type GetOrCreateEvidenceBankResult =
  | { ok: true; bank: EvidenceBankOutput; created: boolean }
  | { ok: false; error: string; status?: number };

/**
 * Narrow the DB row (where `tone` and `proofItems[].type` are loose strings)
 * back to the strict Zod-inferred shape. If the DB somehow drifted, we surface
 * a clear error instead of silently returning garbage.
 */
function toEvidenceBankOutput(row: EvidenceBankRow): EvidenceBankOutput {
  const parsed = EvidenceBankOutputSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `Stored Evidence Bank failed schema validation: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

export async function getOrCreateEvidenceBank(
  projectId: string
): Promise<GetOrCreateEvidenceBankResult> {
  const db = getDb();
  const project = await db.getProject(projectId);
  if (!project) return { ok: false, error: "Project not found", status: 404 };

  const existing = await db.getEvidenceBankByProject(projectId);
  if (existing) {
    return { ok: true, bank: toEvidenceBankOutput(existing), created: false };
  }

  const mirrorRow = await db.getMirrorProfile(projectId);
  if (!mirrorRow) {
    return {
      ok: false,
      error:
        "No Mirror Profile found for this project. Run a Mirror Scan first.",
      status: 404,
    };
  }
  const parsed = SiteReaderOutputSchema.safeParse(mirrorRow.json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Stored Mirror Profile failed schema validation: ${parsed.error.message}`,
      status: 500,
    };
  }
  const mirrorProfile: SiteReaderOutput = parsed.data;

  const draft: EvidenceBankInput = buildEvidenceBankPrefill(mirrorProfile);
  // Defensive: revalidate the prefill through the same Zod schema the POST
  // route uses, so we never save a draft that would fail on read.
  const validated = EvidenceBankInputSchema.safeParse(draft);
  if (!validated.success) {
    return {
      ok: false,
      error: `Prefilled Evidence Bank failed validation: ${validated.error.message}`,
      status: 500,
    };
  }

  const saved = await withPipelineStep(
    { projectId, agent: "evidence-bank" },
    () => db.upsertEvidenceBank(projectId, validated.data)
  );

  return { ok: true, bank: toEvidenceBankOutput(saved), created: true };
}
