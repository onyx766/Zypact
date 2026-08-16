> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14C — Evidence Intake

Goal: turn a short sales report into a concise evidence request that a prospect can answer. This keeps Zypact from generating publish-ready fixes from unreviewed assumptions.

## Commands

Generate a Markdown evidence request:

```bash
npx tsx scripts/render-evidence-intake.ts \
  ./exports/vugio-sales-report-14b6-final2.md \
  ./exports/vugio-evidence-intake.md
```

Generate Markdown and a JSON template for later Evidence Bank review:

```bash
npx tsx scripts/render-evidence-intake.ts \
  ./exports/vugio-sales-report-14b6-final2.md \
  ./exports/vugio-evidence-intake.md \
  --json-out ./exports/vugio-evidence-intake.json
```

Run tests:

```bash
npx tsx scripts/test-evidence-intake.ts
```

## Integrity rules

- No LLM calls.
- No database writes.
- No claim expansion.
- The output asks for proof; it does not create proof.
- Evidence remains `pending_user_review` until a human supplies and approves it.
