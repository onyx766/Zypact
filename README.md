# Sprint 14B.5 — Neutral competitor label

This micro-patch updates the short sales report label from:

`Competitors AI recommended instead`

to:

`Other tools AI recommended in the same frame`

Why: for strong/positive cases such as Linear, the brand is already being recommended, so "instead" is inaccurate.

Apply:

```bash
cd "/Users/alfredjeanemile1icloud.com/Desktop/ZMVP"
unzip -o ~/Downloads/zypact-sprint14b-5-neutral-competitor-label.zip -d .
node apply-14b5-neutral-competitor-label.cjs
```

Validate:

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
npx tsx scripts/test-sales-report.ts
```

Re-render Linear:

```bash
npx tsx scripts/render-sales-report.ts \
  ./exports/linear-mvp-scan-20260710-1516.md \
  ./exports/linear-sales-report-14b5.md
```
