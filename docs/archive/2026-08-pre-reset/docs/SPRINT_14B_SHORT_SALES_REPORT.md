> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14B.1 — Short sales report renderer

## Goal

Create a prospect-facing report that can be sent by email after a scan.

This is not a new engine. It is a second renderer over the already-generated long export:

- no paid probes
- no LLM calls
- no database writes
- no generated publishable assets
- no forked probe scoring

## Output shape

The short report is designed as a 2–3 page markdown document:

1. Executive diagnosis
2. What happened in the AI probes
3. Why this matters commercially
4. First recommended fix
5. Suggested next step
6. Integrity notes

## 14B.1 improvements

- Headline includes the scorecard basis: e.g. `0% across 2 buyer prompts and 4 live AI runs`.
- Page 1 reserves the trend slot: `Trend vs previous scan: — (first scan)`.
- Negative branded reputation includes direct evidence from the probe summary: `A buyer asked... / The AI answered...`.
- Focused tables explain when only part of the unbranded scorecard is shown because an off-frame prompt was excluded from the client-facing buying frame.
- The report ends with a scope CTA and a concierge next step to collect evidence.
- Integrity wording says `from a live scan performed on YYYY-MM-DD`, not internal export wording.

## Integrity rules

The renderer keeps the important labels:

- live Perplexity snapshot
- small sample caveat
- unbranded visibility separate from branded reputation
- evidence needed before publish-ready copy

The renderer removes internal/debug language:

- projectId
- gapMapId
- fixBriefId
- rawProbeRequest
- legacy probe fields
- sprint labels in rendered output

## Branded reputation metric

The report treats visibility and reputation as separate diagnostics:

- visibility = whether AI recommends the brand spontaneously in unbranded buyer prompts
- reputation = what AI says when the brand is named directly

For Vugio, the short report should say:

> Branded reputation: at risk (2/2 branded runs negative)

It should also show the direct evidence line from the branded probe summary because that is the commercially meaningful proof.

## Positive-brand regression

14B.1 includes a Linear-style positive fixture to ensure the short renderer can show a brand that wins without inventing pain.

Expected behavior:

- headline can be high, e.g. 88%
- branded reputation can be positive
- the fix becomes consolidation, not panic
- no negative quote is fabricated

## Frame consistency debt

14B uses the Fix Brief competitor list as the safest competitor frame for the short report.

For Vugio, this avoids foregrounding Shopify/Canva in the main client message because those came from a broader “online sales tools for creative professionals” prompt, not the focused “studio equipment / Adorama alternatives” buying frame.

Long-term backlog for 14C:

- templates by business type
- prompt-frame consistency checks
- warning when competitor set mixes two unrelated worlds
