# Sprint 14D — Intake JSON to Reviewed Evidence Bank

## Goal

Convert a filled Evidence Intake JSON into a deterministic Evidence Bank with `provenance: user_reviewed`.

This step is intentionally non-generative:

- no LLM calls
- no probes
- no database writes
- no publish-ready copy generation

## Why this exists

Zypact should not generate comparison pages or proof blocks from an auto-filled scan alone. The prospect must provide or approve evidence first. This converter turns that reviewed evidence into a structured bank that later generation and QA can use.

## Command

```bash
npx tsx scripts/convert-evidence-intake.ts \
  ./exports/vugio-evidence-intake-filled.json \
  ./exports/vugio-evidence-bank-reviewed.json
```

## Guardrails

- Empty template placeholders are filtered out.
- Public copy generation is blocked unless `permissionToUseInPublicCopy: true`.
- Explicit allowed claims need a source, source URL, or reviewer notes.
- Proof items must have real detail/source fields.
- Forbidden claims are preserved and expanded with default anti-overpromise claims.
- Competitor comparison facts are kept separate from proof items.

## Output states

`publicGenerationStatus: allowed` means the bank can be used by the next generation step.

`publicGenerationStatus: blocked_until_public_permission` means the bank can be stored, but public copy generation should not run yet.
