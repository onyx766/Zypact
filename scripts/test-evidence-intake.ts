import assert from "node:assert/strict";
import { buildEvidenceIntake, parseShortSalesReport } from "../lib/evidence-intake/build-evidence-intake";

const vugio = `# Zypact Short Report — Vugio
Generated: 2026-07-10
Website: vugio.com
Category read by AI: E-commerce platform for creative professionals

## 1. Executive diagnosis

**Visibility:** 0% recommended as a product across 2 buyer prompts and 4 live AI runs.
**Branded reputation:** at risk (2/2 branded runs negative).
**Competitors AI recommended instead:** B&H Photo, KEH Camera and MPB.

## 4. First recommended fix

**Build a comparison / alternative page around the lost buying frame.**

### Evidence needed before publish-ready copy

- specific product offerings and pricing details from Vugio that can be compared to competitors
`;

const linear = `# Zypact Short Report — Linear
Generated: 2026-07-10
Website: linear.app
Category read by AI: AI product development platform for teams

## 1. Executive diagnosis

**Visibility:** 90% recommended as a product across 3 buyer prompts and 10 live AI runs.
**Branded reputation:** positive (0/4 branded runs negative).
**Other tools AI recommended in the same frame:** Jira, Monday.com and Airfocus.

## 4. First recommended fix

**Strengthen comparison / proof content around the under-performing buying frame.**

### Evidence needed before publish-ready copy

- Specific features or advantages of Linear compared to Jira and Asana that can be highlighted.
`;

for (const [name, body] of [["Vugio", vugio], ["Linear", linear]] as const) {
  const parsed = parseShortSalesReport(body, `${name.toLowerCase()}-short.md`);
  const output = buildEvidenceIntake(parsed);

  assert.equal(parsed.brand, name);
  assert(output.markdown.includes(`# Evidence Intake — ${name}`));
  assert(output.markdown.includes("Do not claim:"));
  assert(output.markdown.includes("Evidence required before publish-ready copy"));
  assert(output.markdown.includes(parsed.evidenceNeeded[0]));
  assert.equal((output.jsonTemplate as any).evidenceBankStatus, "pending_user_review");
  assert(Array.isArray((output.jsonTemplate as any).competitorComparisons));
}

const vugioParsed = parseShortSalesReport(vugio, "vugio-short.md");
const vugioOutput = buildEvidenceIntake(vugioParsed);
assert.deepEqual(
  (vugioOutput.jsonTemplate as any).competitorComparisons.map((row: any) => row.competitor),
  ["B&H Photo", "KEH Camera", "MPB"],
  "Vugio fallback comparison competitors should come from the headline competitor frame",
);

const linearParsed = parseShortSalesReport(linear, "linear-short.md");
const linearOutput = buildEvidenceIntake(linearParsed);
assert.deepEqual(
  (linearOutput.jsonTemplate as any).competitorComparisons.map((row: any) => row.competitor),
  ["Jira", "Asana"],
  "Linear comparison competitors should come from evidence-needed text, not the generic headline list",
);
assert(linearOutput.markdown.includes("Compared with Jira"));
assert(linearOutput.markdown.includes("Compared with Asana"));
assert(!linearOutput.markdown.includes("Compared with Monday.com"));
assert(!linearOutput.markdown.includes("Compared with Airfocus"));

console.log("Evidence intake tests passed.");
