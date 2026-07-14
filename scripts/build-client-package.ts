import fs from "node:fs";
import path from "node:path";
import { buildClientPackage } from "../lib/client-package/build-client-package";

type CliArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;

    const key = current.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function readRequiredFile(filePath: unknown, label: string): string {
  if (typeof filePath !== "string" || !filePath.trim()) {
    console.error(`Missing required --${label}`);
    usage();
  }

  return fs.readFileSync(filePath, "utf8");
}

function readOptionalFile(filePath: unknown): string | undefined {
  if (typeof filePath !== "string" || !filePath.trim()) return undefined;
  return fs.readFileSync(filePath, "utf8");
}

function parseCsvArg(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/build-client-package.ts \\
    --brand <Brand> \\
    --sales-report <sales-report.md> \\
    --evidence-intake <evidence-intake.md> \\
    --page-draft <page-draft-or-blocked.md> \\
    --out <output-directory> \\
    [--expected-competitors "Competitor A,Competitor B"]

Notes:
  --brand and --page-draft are optional.
  If --page-draft is omitted, the package is marked as evidence_needed.`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const outDir = typeof args.out === "string" ? args.out : "";

if (!outDir) usage();

const salesReportMarkdown = readRequiredFile(args["sales-report"], "sales-report");
const evidenceIntakeMarkdown = readRequiredFile(args["evidence-intake"], "evidence-intake");
const pageDraftMarkdown = readOptionalFile(args["page-draft"]);
const brand = typeof args.brand === "string" ? args.brand : undefined;
const expectedCompetitors = parseCsvArg(args["expected-competitors"]);

const result = buildClientPackage({
  brand,
  salesReportMarkdown,
  evidenceIntakeMarkdown,
  pageDraftMarkdown,
  expectedCompetitors,
});

fs.mkdirSync(outDir, { recursive: true });

for (const file of result.files) {
  const outputPath = path.join(outDir, file.relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, file.content);
}

console.log(`Client package written: ${outDir}`);
console.log(`brand: ${result.brand}`);
console.log(`status: ${result.status}`);
if (expectedCompetitors?.length) {
  console.log(`expected competitors: ${expectedCompetitors.join(", ")}`);
}
console.log(`files: ${result.files.length}`);
for (const file of result.files) {
  console.log(`- ${file.relativePath}`);
}
