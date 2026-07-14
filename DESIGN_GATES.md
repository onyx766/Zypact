# Design Gates

Design work is gated behind proof that the engine produces useful output.
No pixel work happens before a gate is passed.

## Gate order

### Gate 0 — Foundation (Sprint 0)

Done when:
- Docs (`MVP_SCOPE`, `AGENT_PIPELINE`, `DATABASE_SCHEMA`, `DESIGN_GATES`) exist.
- Pricing config exists as code only (no page).
- LLM + parser + pipeline logging helpers exist.
- DB schema + adapter exist (real or in-memory).

### Gate 1 — Mirror Profile works (Sprint 1)

Done when the Sprint 1 done criteria in `MVP_SCOPE.md` are all true.
Raw JSON on screen counts. Nothing else.

### Gate 2 — Real Mirror Profiles look useful

Only opens when:
- 5 different SaaS websites have been scanned end to end.
- The Mirror Profile JSON for each is factually correct
  (spot-checked against the site).
- No fabricated claims sneak through.

Passing Gate 2 unlocks: readable formatting of Mirror Profile sections
(not a dashboard — just typography and grouping).

### Gate 3 — Prompt Factory returns useful buyer prompts

Blocked until Gate 2 passes. Not for now.

### Gate 4 — AI Probe returns comparable answers

Blocked until Gate 3 passes.

### Gate 5 — Gap Matrix makes sense to a marketer

Blocked until Gate 4 passes. Only after this gate does a Gap Matrix UI get
designed — not before.

### Gate 6 — Fix Agent produces safe suggestions

Blocked until Gate 5 passes.

### Gate 7 — QA Agent blocks fabrications reliably

Blocked until Gate 6 passes.

### Gate 8 — Billing

Only after every gate above passes do we build Stripe, landing, and pricing
pages. Until then, pricing lives in `/lib/pricing/pricing-config.ts` only.

### Gate 9 — 3D map / final design

Last. Never before Gate 8.

## Anti-loss

If you're about to design something, check which gate you're at.
If the gate hasn't opened, you're building too early. Stop.
