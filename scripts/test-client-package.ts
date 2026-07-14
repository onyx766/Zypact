import fs from 'node:fs';
import path from 'node:path';
import assert from "node:assert/strict";
import { buildClientPackage } from "../lib/client-package/build-client-package";

const salesReport = `# Zypact Short Report — DemoCo

Generated: 2026-07-10
Website: demo.example
Category read by AI: Example B2B software

## 1. Executive diagnosis

**Visibility:** 90% recommended as a product across 3 buyer prompts and 10 live AI runs.
**Branded reputation:** positive (0/4 branded runs negative).
**Other tools AI recommended in the same frame:** Competitor A.

## 4. First recommended fix

**Build a comparison/proof page around the queries where AI is currently recommending competitors.**

### Evidence needed before publish-ready copy

- Specific features or advantages of DemoCo compared to Competitor A that can be highlighted.
`;

const evidenceIntake = `# Evidence Intake — DemoCo

Generated: 2026-07-10
Website: demo.example

## Evidence required before publish-ready copy

- [ ] Specific features or advantages of DemoCo compared to Competitor A that can be highlighted.

**Do not claim:** AI will recommend DemoCo.
**Do claim only:** what the evidence supports.
`;

const readyPageDraft = `# Safe Comparison Page Draft — DemoCo

## Page copy

- DemoCo includes workflow templates on the Team plan. Source: https://demo.example/pricing

## Safety notes

- Do not claim that AI will recommend DemoCo.
`;

const blockedPageDraft = `# Page Draft Blocked — DemoCo

This Evidence Bank is not approved for public page generation.

## Required before generation

- publicGenerationStatus is blocked_until_public_permission.
`;

const ready = buildClientPackage({
  salesReportMarkdown: salesReport,
  evidenceIntakeMarkdown: evidenceIntake,
  pageDraftMarkdown: readyPageDraft,
});

assert.equal(ready.brand, "DemoCo");
assert.equal(ready.status, "page_draft_ready");
assert.ok(ready.files.some((file) => file.relativePath === "03-page-draft.md"));
assert.ok(ready.files.some((file) => file.relativePath === "04-next-email.md"));
assert.match(ready.files.find((file) => file.relativePath === "00-README.md")?.content || "", /Reviewed page draft included/);
assert.match(ready.files.find((file) => file.relativePath === "04-next-email.md")?.content || "", /reviewed evidence trail/);
assert.doesNotMatch(ready.files.find((file) => file.relativePath === "04-next-email.md")?.content || "", /Evidence Bank/);
assert.match(ready.files.find((file) => file.relativePath === "manifest.json")?.content || "", /page_draft_ready/);

const blocked = buildClientPackage({
  brand: "DemoCo",
  salesReportMarkdown: salesReport,
  evidenceIntakeMarkdown: evidenceIntake,
  pageDraftMarkdown: blockedPageDraft,
});

assert.equal(blocked.status, "page_draft_blocked");
assert.ok(blocked.files.some((file) => file.relativePath === "03-page-draft-blocked.md"));
assert.match(blocked.files.find((file) => file.relativePath === "00-README.md")?.content || "", /Page draft blocked until evidence is complete/);
assert.match(blocked.files.find((file) => file.relativePath === "04-next-email.md")?.content || "", /evidence needed before we generate publish-ready copy/);

const noPage = buildClientPackage({
  brand: "DemoCo",
  salesReportMarkdown: salesReport,
  evidenceIntakeMarkdown: evidenceIntake,
});

assert.equal(noPage.status, "evidence_needed");
assert.ok(!noPage.files.some((file) => file.relativePath.startsWith("03-")));
assert.match(noPage.files.find((file) => file.relativePath === "00-README.md")?.content || "", /No page draft is included yet/);

console.log("Client package tests passed.");


// 14F.1 client-facing wording regression
{
  const generatedRoot = path.join(process.cwd(), 'exports/client-packages/vugio-blocked');
  const readmePath = path.join(generatedRoot, '00-README.md');
  const emailPath = path.join(generatedRoot, '04-next-email.md');

  if (fs.existsSync(readmePath) && fs.existsSync(emailPath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const email = fs.readFileSync(emailPath, 'utf8');

    assert(!readme.includes('under-performing buying frame'), 'README should not expose internal buying-frame wording');
    assert(!email.includes('client-ready package'), 'Email should not mention client-ready package');
    assert(
      email.includes('short AI visibility snapshot') || readme.includes('AI visibility snapshot'),
      'Package wording should be prospect-friendly'
    );
  }
}
