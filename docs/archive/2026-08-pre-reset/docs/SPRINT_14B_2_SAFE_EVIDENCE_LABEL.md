> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14B.2 — Safe Evidence Label

## Goal

The 14B.1 short sales report used the heading:

> The AI answered:

But the line shown under that heading is not a raw Perplexity quote. It is Zypact's internal `answerSummary` derived from the live probe response.

## Fix

Use this label instead:

> The AI response was summarized as:

This preserves the commercial force of the evidence without misrepresenting a summary as a verbatim quote.

## Vugio expected output

The short report should show:

```md
### Direct evidence from the branded check

A buyer asked:

> Compare Vugio vs Adorama for purchasing studio products.

The AI response was summarized as:

> Vugio is likely non-existent or misnamed and does not have a credible reputation as a retailer for studio products.
```

## Validation

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
npx tsx scripts/test-sales-report.ts
```

Then re-render Vugio:

```bash
npx tsx scripts/render-sales-report.ts \
  ./exports/vugio-mvp-scan-14a2.md \
  ./exports/vugio-sales-report-14b2.md \
  --focus-competitors "B&H Photo,KEH Camera,MPB"
```
