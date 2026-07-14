import fs from "node:fs";
import path from "node:path";
import { buildComparisonPageDraftFromEvidenceBank } from "../lib/evidence-intake/evidence-bank-to-page-draft";

function usage(): never {
  console.error("Usage: npx tsx scripts/render-page-draft-from-evidence-bank.ts <evidence-bank.json> <out.md>");
  process.exit(1);
}

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) usage();

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const result = buildComparisonPageDraftFromEvidenceBank(input);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, result.markdown);

console.log(`Page draft output written: ${outputPath}`);
console.log(`public generation: ${result.publicGenerationStatus}`);
console.log(`generation allowed: ${result.ok ? "yes" : "no"}`);

if (!result.ok) {
  console.log("warnings:");
  for (const warning of result.warnings) {
    console.log(`- ${warning}`);
  }
}
