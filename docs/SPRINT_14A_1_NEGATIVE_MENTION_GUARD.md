# Sprint 14A.1 — Negative mention guard

## Goal

Prevent a probe answer from being marked as a product recommendation when the AI mentions the brand negatively.

This fixes the Vugio regression where Perplexity said the brand was likely non-existent or misnamed, while the stored product score still treated the mention as `recommendedAsProduct: yes`.

## Rule

The LLM may classify the brand position once via `clientPosition`:

- `primary`
- `listed`
- `negative`
- `absent`

All product scorecard fields are derived deterministically from that position:

- `primary` → `recommendedAsProduct: true`, `productVerdict: won`
- `listed` → `recommendedAsProduct: true`, `productVerdict: partial`
- `negative` → `recommendedAsProduct: false`, `productVerdict: lost`
- `absent` → `recommendedAsProduct: false`, then lost/not_relevant depends on answer context

A negative mention is also surfaced separately as `negativeMention`, because it is a reputation-risk signal, not a normal absence.

## Report changes

- Adds `negativeMentions` to Executive Summary and Probe Set metrics.
- Prompt aggregation now uses one `scorecard status` field:
  - `included`
  - `tracked_separately (branded)`
  - `excluded`
- Per-probe rows display `scorecard status` instead of the ambiguous `included in main summary` boolean.
- Existing stored rows are interpreted from authoritative `clientPosition`, so old bad rows can be corrected by re-exporting without re-running paid probes.

## Regression fixture

The Vugio-style case is locked in `scripts/test-pipeline-integrity.ts`:

> answerSummary/response says Vugio is likely non-existent or misnamed, `clientPosition: negative` → `recommendedAsProduct: false`, `productVerdict: lost`.
