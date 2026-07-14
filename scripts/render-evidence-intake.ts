import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildEvidenceIntake, parseShortSalesReport } from "../lib/evidence-intake/build-evidence-intake";

function usage(): never {
  console.error("Usage: npx tsx scripts/render-evidence-intake.ts <short-sales-report.md> <out.md> [--json-out <out.json>]");
  process.exit(1);
}

const args = process.argv.slice(2);
const inputPath = args[0];
const outputPath = args[1];
if (!inputPath || !outputPath) usage();

const jsonOutIndex = args.indexOf("--json-out");
const jsonOutPath = jsonOutIndex >= 0 ? args[jsonOutIndex + 1] : "";

const source = readFileSync(inputPath, "utf8");
const parsed = parseShortSalesReport(source, inputPath);
const output = buildEvidenceIntake(parsed);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output.markdown, "utf8");

if (jsonOutPath) {
  mkdirSync(dirname(jsonOutPath), { recursive: true });
  writeFileSync(jsonOutPath, JSON.stringify(output.jsonTemplate, null, 2) + "\n", "utf8");
}

console.log(`Evidence intake written: ${outputPath}`);
if (jsonOutPath) console.log(`Evidence JSON template written: ${jsonOutPath}`);
