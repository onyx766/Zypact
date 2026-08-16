> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14F — AI Visibility Snapshot Export

## Goal

Create a prospect-ready package from the artifacts already produced in Sprint 14:

- short sales report
- evidence request
- safe page draft, or blocked page-draft note
- client-facing README
- follow-up email
- manifest

This keeps the internal workflow out of the client handoff.

## Output

The package writer creates a directory like:

```text
exports/client-packages/vugio/
├── 00-README.md
├── 01-ai-visibility-summary.md
├── 02-evidence-request.md
├── 03-page-draft.md
├── 04-next-email.md
└── manifest.json
```

If public generation is blocked, the page file is named:

```text
03-page-draft-blocked.md
```

If no page draft is passed, no `03-` file is included and the package status becomes `evidence_needed`.

## Commands

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
npx tsx scripts/test-client-package.ts
```

Build a package with a page draft:

```bash
npx tsx scripts/build-client-package.ts \
  --brand DemoCo \
  --sales-report ./exports/demo-sales-report.md \
  --evidence-intake ./exports/demo-evidence-intake.md \
  --page-draft ./exports/demo-page-draft-14e1.md \
  --out ./exports/client-packages/democo
```

Build a package while generation is blocked:

```bash
npx tsx scripts/build-client-package.ts \
  --brand Vugio \
  --sales-report ./exports/vugio-sales-report-14b6-final2.md \
  --evidence-intake ./exports/vugio-evidence-intake-14c2.md \
  --page-draft ./exports/vugio-page-draft-blocked-14e1.md \
  --out ./exports/client-packages/vugio-blocked
```

## Safety

The client package does not claim that AI will recommend the brand. It keeps the same rule as earlier Sprint 14 steps:

- publish only reviewed, source-backed claims
- do not promise AI recommendations
- do not promise rankings
- do not invent unsupported proof
