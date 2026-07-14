import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildReviewedEvidenceBank } from "../lib/evidence-intake/intake-to-evidence-bank";

function usage(): never {
  console.error("Usage: npx tsx scripts/convert-evidence-intake.ts <filled-intake.json> <out-evidence-bank.json>");
  process.exit(1);
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) usage();

const intake = JSON.parse(readFileSync(inputPath, "utf8"));
const evidenceBank = buildReviewedEvidenceBank(intake);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(evidenceBank, null, 2) + "\n", "utf8");

console.log(`Reviewed Evidence Bank written: ${outputPath}`);
console.log(`status: ${evidenceBank.evidenceBankStatus}`);
console.log(`public generation: ${evidenceBank.publicGenerationStatus}`);
console.log(`allowed claims: ${evidenceBank.allowedClaims.length}`);
if (evidenceBank.qaWarnings.length) {
  console.log("warnings:");
  for (const warning of evidenceBank.qaWarnings) console.log(`- ${warning}`);
}
