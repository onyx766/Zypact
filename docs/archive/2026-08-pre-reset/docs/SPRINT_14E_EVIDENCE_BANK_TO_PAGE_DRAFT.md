> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14E — Evidence Bank to Page Draft

## Goal

Turn a reviewed Evidence Bank into a safe comparison page draft.

This step is deterministic. It does not call an LLM and it does not invent claims.

## Gating

The renderer blocks page generation unless:

- `publicGenerationStatus === "allowed"`
- `status === "user_reviewed"` or `evidenceBankStatus === "user_reviewed"`
- at least one source-backed `allowedClaims` item exists

If any condition fails, it writes a blocked diagnostic instead of publish-ready page copy.

## Commands

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
npx tsx scripts/test-page-draft-from-evidence-bank.ts
```

Render a page draft:

```bash
npx tsx scripts/render-page-draft-from-evidence-bank.ts \
  ./exports/demo-evidence-bank-reviewed-14d1.json \
  ./exports/demo-page-draft-14e.md
```

Test the blocked Vugio case:

```bash
npx tsx scripts/render-page-draft-from-evidence-bank.ts \
  ./exports/vugio-evidence-bank-reviewed-test.json \
  ./exports/vugio-page-draft-blocked-14e.md
```

## Safety rules

- Do not claim AI will recommend the brand.
- Do not claim guaranteed rankings or guaranteed revenue impact.
- Do not use unsupported superlatives.
- Keep all page claims tied to reviewed sources.
