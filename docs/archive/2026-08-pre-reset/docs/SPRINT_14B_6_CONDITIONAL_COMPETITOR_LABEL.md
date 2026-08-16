> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14B.6 — Conditional competitor label

This patch fixes the final short-report competitor label without breaking losing reports.

## Rule

- `wonGroups > 0 && lostGroups === 0` → `Other tools AI recommended in the same frame`
- `lostGroups > 0` → `Competitors AI recommended instead`

## Why

Linear is a winning/consolidation case, so “instead” is false. Vugio is a losing/recovery case, so “instead” is true and should remain.

## Validation

Render both sides:

```bash
npx tsx scripts/render-sales-report.ts ./exports/linear-mvp-scan-20260710-1516.md ./exports/linear-sales-report-14b6.md
npx tsx scripts/render-sales-report.ts ./exports/vugio-mvp-scan-14a2.md ./exports/vugio-sales-report-14b6.md --focus-competitors "B&H Photo,KEH Camera,MPB"
```

Expected:

```bash
grep -c "Other tools AI recommended in the same frame" ./exports/linear-sales-report-14b6.md   # >=1
grep -c "Competitors AI recommended instead" ./exports/linear-sales-report-14b6.md              # 0

grep -c "Competitors AI recommended instead" ./exports/vugio-sales-report-14b6.md               # >=1
grep -c "Other tools AI recommended in the same frame" ./exports/vugio-sales-report-14b6.md      # 0
```
