const fs = require('fs');
const path = require('path');

const root = process.cwd();
const files = {
  'lib/evidence-intake/build-evidence-intake.ts': fs.readFileSync(path.join(__dirname, '..', 'lib/evidence-intake/build-evidence-intake.ts'), 'utf8'),
  'scripts/render-evidence-intake.ts': fs.readFileSync(path.join(__dirname, 'render-evidence-intake.ts'), 'utf8'),
  'scripts/test-evidence-intake.ts': fs.readFileSync(path.join(__dirname, 'test-evidence-intake.ts'), 'utf8'),
  'docs/SPRINT_14C_EVIDENCE_INTAKE.md': fs.readFileSync(path.join(__dirname, '..', 'docs/SPRINT_14C_EVIDENCE_INTAKE.md'), 'utf8'),
};

for (const [rel, content] of Object.entries(files)) {
  const out = path.join(root, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);
  console.log('wrote', rel);
}
