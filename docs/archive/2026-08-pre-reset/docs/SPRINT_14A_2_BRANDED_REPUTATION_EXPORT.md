> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Sprint 14A.2 — Branded reputation export hardening

Purpose: fix the remaining client-facing export inconsistency found in the Vugio report after Sprint 14A.1.

## What changed

1. Probe detail headers now use the derived product verdict, not the persisted legacy verdict.
   - The renderer no longer reads legacy probe verdict fields for client-facing probe headers.
   - If `clientPosition` is `negative`, the displayed product verdict is `lost`, even if an older stored row has `verdict: won` or `productVerdict: won`.

2. Legacy probe fields are removed from the rendered report.
   - No `legacy clientMentioned` line.
   - No `legacy clientPosition` line.
   - No `legacy mentionRate` table column.
   - Legacy data can remain in the database for audit, but the exporter does not use it for client-facing interpretation.

3. Executive Summary now includes a branded reputation metric when branded probes are tracked separately.
   - States: `positive`, `mixed`, `at risk`, or `not measured`.
   - Uses run counts, not standalone percentages: e.g. `at risk (2/2 branded runs negative)`.
   - This keeps visibility and reputation separate:
     - unbranded product recommendation scorecard = spontaneous buyer visibility.
     - branded reputation = what the AI says when the brand is named directly.

4. Section 8 adds a Branded reputation check block when branded probes exist.

## Regression locked

The Vugio fixture verifies that a branded answer saying the brand is likely non-existent or obscure renders as:

- `recommendedAsProduct: no`
- `productPosition: negative`
- `negativeMention: yes`
- `product verdict: lost`
- `Branded reputation: at risk (2/2 branded runs negative)`

and never renders legacy `won` / `partial` probe headers.

## 14B backlog note

Frame consistency still belongs in 14B/14C:

- Use templates by business type/category.
- Warn if selected prompts mix unrelated buyer universes.
- For Vugio-style retail scans, keep the client-facing competitor sentence focused on the relevant retail/studio equipment frame, not broad SaaS/e-commerce tools such as Shopify or Canva unless the prompt explicitly targets that frame.
