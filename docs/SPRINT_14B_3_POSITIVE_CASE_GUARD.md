# Sprint 14B.3 — Positive-case sales report guard

Purpose: ensure the short sales renderer does not fabricate a negative pain story when the brand is already winning the sampled AI visibility scorecard.

## Fix

The renderer now derives a visibility tone from the corrected scorecard summary:

- `strong`: high recommendation rate, at least one won prompt, zero lost prompt groups.
- `mixed`: some recommendation presence, but not a strong clean win.
- `absent`: zero recommendation presence.

Client-facing copy changes by tone:

- Strong cases use consolidation language: already recommended, defend position, improve cited-source coverage, become primary more often.
- Mixed cases use under-performance language: partial visibility, not consistently primary.
- Absent cases use recovery language: missing from the AI shortlist.

## Regression checks

The Linear fixture must not contain:

- “Linear did not appear as a recommended product”
- “reputation-risk signal”
- “clearest buying-frame loss”

It must contain:

- “was recommended in most of the unbranded buying prompts tested”
- “clearest consolidation opportunity”
- “AI still surfaced”
- “Strengthen comparison / proof content”

Vugio still keeps the negative evidence path and safe evidence label.
