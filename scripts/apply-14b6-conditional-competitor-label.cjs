#!/usr/bin/env node
/**
 * Sprint 14B.6 — conditional competitor label.
 *
 * Fixes the final 14B label leak without breaking losing cases:
 * - winner/no lost groups => "Other tools AI recommended in the same frame"
 * - any lost groups      => "Competitors AI recommended instead"
 *
 * This deliberately avoids a blind global replace because Vugio still needs
 * the "instead" wording while Linear needs the neutral wording.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = process.cwd();
const rendererPath = path.join(root, 'lib', 'export', 'build-sales-report.ts');
const testPath = path.join(root, 'scripts', 'test-sales-report.ts');

function die(message) {
  console.error(`\n[14B.6] ${message}`);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) die(`Missing expected file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.writeFileSync(file, text);
}

function grepSource(pattern) {
  try {
    return cp.execSync(
      `grep -RIn --include="*.ts" --include="*.tsx" ${JSON.stringify(pattern)} . | grep -v exports | grep -v node_modules || true`,
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

let source = read(rendererPath);

if (!source.includes('parseOutcomeCount')) {
  die('Cannot find parseOutcomeCount(). Apply 14B.3 first or patch the renderer manually.');
}

const conditionalHelper = `function competitorHeadlineLabel(aiProbeResult: string): string {\n  const wonGroups = parseOutcomeCount(aiProbeResult, "won");\n  const lostGroups = parseOutcomeCount(aiProbeResult, "lost");\n  if (wonGroups > 0 && lostGroups === 0) {\n    return "Other tools AI recommended in the same frame";\n  }\n  return "Competitors AI recommended instead";\n}`;

let changed = false;

// Replace the existing helper if present, regardless of its previous signature.
const helperRegex = /function\s+competitorHeadlineLabel\s*\([^)]*\)\s*:\s*string\s*{[\s\S]*?\n}\n(?=\nfunction\s+(opportunityLabel|frameRecommendationSentence|fixHeading|sanitizeSentence|parseBrandedProbeEvidence|sanitizeClientMarkdown|buildSalesReportFromMvpMarkdown)\b)/m;
if (helperRegex.test(source)) {
  source = source.replace(helperRegex, `${conditionalHelper}\n`);
  changed = true;
} else {
  // Insert after visibilityTone if the helper was never created.
  const insertAfter = /function\s+visibilityTone\s*\([^)]*\)\s*:\s*VisibilityTone\s*{[\s\S]*?\n}\n/m;
  if (!insertAfter.test(source)) {
    die('Cannot find competitorHeadlineLabel() or visibilityTone(). Paste the grep output so the renderer path can be identified.');
  }
  source = source.replace(insertAfter, (m) => `${m}\n${conditionalHelper}\n`);
  changed = true;
}

// Replace only the client-facing markdown label, not the long-report parser
// string used to read "Top competitors AI recommended instead".
const directMarkdownLabel = '**Competitors AI recommended instead:**';
if (source.includes(directMarkdownLabel)) {
  source = source.replaceAll(directMarkdownLabel, '**${competitorHeadlineLabel(aiProbeResult)}:**');
  changed = true;
}

// If an older patch already had a helper call, make sure it passes aiProbeResult,
// not tone. The new rule is based on won/lost groups, not only percent/tone.
if (source.includes('competitorHeadlineLabel(tone)')) {
  source = source.replaceAll('competitorHeadlineLabel(tone)', 'competitorHeadlineLabel(aiProbeResult)');
  changed = true;
}

if (!changed) {
  console.error('\n[14B.6] No renderer changes made. Source occurrences:');
  console.error(grepSource('Competitors AI recommended instead') || '(none)');
  die('Could not patch the renderer automatically.');
}

write(rendererPath, source);

// Harden tests: losing Vugio keeps "instead"; winning Linear gets neutral label.
let test = read(testPath);
let testChanged = false;
if (!test.includes('Vugio losing case keeps the “instead” competitor label')) {
  const vugioAnchor = 'assert(vugioBody.includes("small snapshot, not a market-wide benchmark"), "keeps sample-size caveat");';
  if (test.includes(vugioAnchor)) {
    test = test.replace(
      vugioAnchor,
      `${vugioAnchor}\nassert(vugioBody.includes("**Competitors AI recommended instead:**"), "Vugio losing case keeps the “instead” competitor label");\nassert(!vugioBody.includes("**Other tools AI recommended in the same frame:**"), "Vugio losing case does not use the neutral winning label");`,
    );
    testChanged = true;
  }
}
if (!test.includes('Linear winning case uses the neutral competitor label')) {
  const linearAnchor = 'assert(linearBody.includes("Add a comparison page that consolidates Linear\'s existing strengths"), "renders consolidation fix without fabricating pain");';
  if (test.includes(linearAnchor)) {
    test = test.replace(
      linearAnchor,
      `${linearAnchor}\nassert(linearBody.includes("**Other tools AI recommended in the same frame:**"), "Linear winning case uses the neutral competitor label");\nassert(!linearBody.includes("**Competitors AI recommended instead:**"), "Linear winning case does not use the losing competitor label");`,
    );
    testChanged = true;
  }
}
if (testChanged) write(testPath, test);

const remaining = grepSource('**Competitors AI recommended instead:**');
console.log('[14B.6] Patched renderer:', path.relative(root, rendererPath));
console.log(testChanged ? '[14B.6] Hardened tests.' : '[14B.6] Tests already hardened or anchors not found; verify manually.');
console.log('[14B.6] Source occurrences of client-facing exact label after patch:');
console.log(remaining || '(none outside exports/node_modules)');
console.log('\n[14B.6] Next: npm run typecheck && NEXT_TELEMETRY_DISABLED=1 npm run build && npx tsx scripts/test-sales-report.ts');
