#!/usr/bin/env node
/*
  Sprint 14B.4 — positive-case wording polish

  Goal:
  - Do not describe positive / strong visibility cases as if competitors were recommended "instead".
  - Do not call partial/won frames "lost buying frames".
  - Do not understate a strong case (e.g. 90%) with "some prompts".

  This patch intentionally edits the sales-report renderer text only. It does not touch probes,
  scoring, database writes, or export integrity logic.
*/

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const candidates = [
  path.join(root, 'lib/export/build-sales-report.ts'),
  path.join(root, 'lib/export/buildSalesReport.ts'),
  path.join(root, 'src/lib/export/build-sales-report.ts'),
];

const target = candidates.find((p) => fs.existsSync(p));
if (!target) {
  console.error('[14B.4] Could not find sales report renderer. Checked:');
  for (const p of candidates) console.error(`  - ${p}`);
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');
const before = source;

// 1) Label competitors safely in non-loss reports. The old label is still acceptable for absent/lost
// cases, but the short renderer currently uses a static label. Make it neutral for all cases.
source = source.replaceAll(
  '**Competitors AI recommended instead:**',
  '**Other tools AI recommended in the same frame:**'
);

// 2) Avoid calling a partial / positive opportunity a "lost buying frame".
source = source.replaceAll(
  'Build a comparison / alternative page around the lost buying frame.',
  'Strengthen comparison / proof content around the under-performing buying frame.'
);
source = source.replaceAll(
  'the clearest buying-frame loss is:',
  'the clearest under-performance opportunity is:'
);
source = source.replaceAll(
  'around the lost buying frame',
  'around the under-performing buying frame'
);

// 3) Avoid saying a high-visibility brand appeared only in "some" prompts.
// This catches the current 14B.3 phrasing while keeping the statement generic.
source = source.replaceAll(
  'appeared in some unbranded buying prompts, but not consistently as the primary recommendation.',
  'was recommended in most of the unbranded buyer runs tested, but not consistently as the primary recommendation.'
);
source = source.replaceAll(
  'The opportunity is to turn partial visibility into a stronger shortlist position',
  'The opportunity is to consolidate that visibility into a stronger primary shortlist position'
);

// 4) For positive cases, the fix should not sound like basic recovery from absence.
source = source.replaceAll(
  'Create a dedicated comparison page that outlines how',
  'Create or strengthen a dedicated comparison page that outlines how'
);
source = source.replaceAll(
  'Create a comparison page that highlights',
  'Create or strengthen a comparison page that highlights'
);

if (source === before) {
  console.warn('[14B.4] No exact text replacements were applied. The renderer may already be patched or the phrasing changed.');
  console.warn(`[14B.4] Target inspected: ${target}`);
  process.exit(0);
}

fs.writeFileSync(target, source);
console.log(`[14B.4] Patched ${path.relative(root, target)}`);
console.log('[14B.4] Re-run: npm run typecheck && NEXT_TELEMETRY_DISABLED=1 npm run build && npx tsx scripts/test-sales-report.ts');
