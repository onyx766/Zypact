#!/usr/bin/env node
/*
  Sprint 14B.2 — Safe evidence label patch
  Purpose: Do not present an internal AI-answer summary as a verbatim quote.
  Run from repo root:
    node scripts/apply-14b2-safe-evidence-label.cjs
*/

const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const candidates = [
  'lib/export/build-sales-report.ts',
  'scripts/test-sales-report.ts',
];

function readIfExists(rel) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return null;
  return { abs, text: fs.readFileSync(abs, 'utf8') };
}

function normalizeSummaryInRenderer(text) {
  // Change the section label so we do not imply a verbatim quote.
  text = text.replaceAll('The AI answered:', 'The AI response was summarized as:');
  text = text.replaceAll('The AI Answered:', 'The AI response was summarized as:');

  // If prior code/test fixtures expected this exact generated summary prefix,
  // make the displayed evidence sentence cleaner while keeping meaning intact.
  // This is intentionally narrow: it only removes wrapper phrasing that clearly
  // comes from our summarizer, not factual content.
  text = text.replaceAll('The AI response indicates that Vugio is likely', 'Vugio is likely');
  text = text.replaceAll('The AI response indicates Vugio is likely', 'Vugio is likely');

  return text;
}

let changed = [];
for (const rel of candidates) {
  const file = readIfExists(rel);
  if (!file) continue;
  const next = normalizeSummaryInRenderer(file.text);
  if (next !== file.text) {
    fs.writeFileSync(file.abs, next);
    changed.push(rel);
  }
}

if (!changed.length) {
  console.log('[14B.2] No direct string changes were needed.');
  console.log('[14B.2] Please confirm lib/export/build-sales-report.ts uses this label:');
  console.log('        The AI response was summarized as:');
  process.exit(0);
}

console.log('[14B.2] Updated files:');
for (const rel of changed) console.log(`  - ${rel}`);
console.log('[14B.2] Expected direct evidence label: The AI response was summarized as:');
