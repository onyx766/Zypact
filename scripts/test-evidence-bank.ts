/**
 * Sprint 6 smoke test — Evidence Bank.
 *
 * Usage:
 *   npm run test:evidence
 *     → full path: fresh Mirror Scan on linear.app → get-or-create
 *       Evidence Bank → mutate → save → reload → confirm persisted.
 *   npm run test:evidence -- <projectId>
 *     → uses an existing project that already has a Mirror Profile.
 *
 * No LLM required.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { getOrCreateEvidenceBank } from "../lib/pipeline/get-or-create-evidence-bank";
import { getDb } from "../lib/db";
import {
  DEFAULT_FORBIDDEN_CLAIMS,
  EvidenceBankInputSchema,
  EvidenceBankOutputSchema,
} from "../lib/schemas/evidence-bank.schema";
import { hasUsableEvidenceBank } from "../lib/evidence-bank/has-usable-evidence-bank";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  } else {
    console.log("✓", msg);
  }
}

async function ensureProject(): Promise<string> {
  const args = process.argv.slice(2);
  const db = getDb();
  if (args[0]) {
    const projectId = args[0];
    const p = await db.getProject(projectId);
    if (!p) throw new Error(`Project ${projectId} not found`);
    return projectId;
  }
  console.log("▸ Running Mirror Scan on https://linear.app…");
  const scan = await runMirrorScan({ websiteUrl: "https://linear.app" });
  if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);
  return scan.project.id;
}

async function main() {
  const projectId = await ensureProject();
  const db = getDb();

  // 1. First call — should create prefill draft.
  const first = await getOrCreateEvidenceBank(projectId);
  if (!first.ok) throw new Error(`get-or-create failed: ${first.error}`);
  assert(first.created, "first call creates a prefill draft");

  const bank = first.bank;
  console.log("");
  console.log("Prefilled Evidence Bank");
  console.log("─────────────────────────────────────────────");
  console.log(
    `productDescription : ${bank.productDescription.slice(0, 120)}${bank.productDescription.length > 120 ? "…" : ""}`
  );
  console.log(`targetAudience     : ${bank.targetAudience.length} item(s)`);
  console.log(`mainUseCases       : ${bank.mainUseCases.length} item(s)`);
  console.log(`features           : ${bank.features.length} item(s)`);
  console.log(`proofItems         : ${bank.proofItems.length} item(s)`);
  console.log(`competitors        : ${bank.competitors.length} item(s)`);
  console.log(`allowedClaims      : ${bank.allowedClaims.length} item(s)`);
  console.log(`forbiddenClaims    : ${bank.forbiddenClaims.length} item(s)`);
  console.log(`tone               : ${bank.tone}`);
  console.log(`notes              : ${bank.notes.length} chars`);
  console.log("─────────────────────────────────────────────");

  // 2. Structural invariants of the prefill.
  assert(
    EvidenceBankOutputSchema.safeParse(bank).success,
    "prefill validates against EvidenceBankOutputSchema"
  );
  assert(bank.forbiddenClaims.length >= 3, "forbiddenClaims has at least 3 items");
  assert(
    DEFAULT_FORBIDDEN_CLAIMS.every((c) => bank.forbiddenClaims.includes(c)),
    "forbiddenClaims seeded with all default entries"
  );
  assert(bank.tone === "plain", "tone defaults to 'plain'");
  assert(
    bank.proofItems.every(
      (p) => !p.sourceUrl || /^https?:\/\//.test(p.sourceUrl)
    ),
    "no proofItem carries a fake / non-URL sourceUrl"
  );

  // 3. Second call — should return the existing bank (no re-prefill).
  const second = await getOrCreateEvidenceBank(projectId);
  if (!second.ok) throw new Error(`second get-or-create failed: ${second.error}`);
  assert(!second.created, "second call returns existing bank (no re-creation)");
  assert(
    second.bank.id === first.bank.id,
    "second call returns the same row id"
  );

  // 4. Mutate and save via upsertEvidenceBank (mirrors what the POST route does).
  const NEW_NOTE = "Sprint 6 smoke test — this note should persist.";
  const NEW_FORBIDDEN = "vaporware buzzwords";
  const updatedInput = EvidenceBankInputSchema.parse({
    ...bank,
    notes: NEW_NOTE,
    tone: "confident",
    forbiddenClaims: [...bank.forbiddenClaims, NEW_FORBIDDEN],
  });
  const saved = await db.upsertEvidenceBank(projectId, updatedInput);
  assert(saved.id === bank.id, "upsert keeps the same row id");
  assert(saved.notes === NEW_NOTE, "notes update persisted at write time");
  assert(saved.tone === "confident", "tone update persisted at write time");
  assert(
    saved.forbiddenClaims.includes(NEW_FORBIDDEN),
    "new forbidden claim included at write time"
  );
  assert(
    new Date(saved.updatedAt).getTime() >= new Date(bank.updatedAt).getTime(),
    "updatedAt monotonic-non-decreasing after upsert"
  );

  // 5. Reload from scratch — confirm read-back matches the write.
  const reloaded = await db.getEvidenceBankByProject(projectId);
  if (!reloaded) throw new Error("reloaded bank is null");
  assert(reloaded.notes === NEW_NOTE, "notes persisted after reload");
  assert(reloaded.tone === "confident", "tone persisted after reload");
  assert(
    reloaded.forbiddenClaims.includes(NEW_FORBIDDEN),
    "new forbidden claim persisted after reload"
  );

  // 6. has-usable helper.
  assert(
    hasUsableEvidenceBank({
      ...reloaded,
      tone: reloaded.tone as never,
    } as never),
    "hasUsableEvidenceBank returns true for the saved bank"
  );
  assert(
    !hasUsableEvidenceBank(null),
    "hasUsableEvidenceBank returns false for null"
  );
  assert(
    !hasUsableEvidenceBank({
      ...reloaded,
      productDescription: "",
      features: [],
      tone: reloaded.tone as never,
    } as never),
    "hasUsableEvidenceBank returns false when no description AND no features"
  );

  console.log("");
  console.log(`Project ID:        ${projectId}`);
  console.log(`Evidence Bank ID:  ${reloaded.id}`);
  console.log("Sprint 6 smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
