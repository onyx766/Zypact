> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Zypact MVP — Scope

> **Superseded for scope purposes.** This document describes Sprint 0 and
> Sprint 1 from the beginning of the project, when the only goal was a Site
> Reader Agent producing a Mirror Profile. It is retained as accurate project
> history and as a record of the original build order and guiding rules.
>
> **The approved current scope is
> [`docs/Zypact_V1_Engineering_Audit_Brief.md`](docs/Zypact_V1_Engineering_Audit_Brief.md).**
> Version boundaries are in [`docs/ROADMAP.md`](docs/ROADMAP.md); implementation
> status is in [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md).
>
> Where this file and the V1 brief disagree, the brief wins. See
> [Reconciliation with V1](#reconciliation-with-v1) at the end of this document
> for the specific contradictions.

## What Zypact MVP is

Zypact is an AI visibility product for B2B SaaS marketing teams.

Given a SaaS website URL, Zypact:

1. Reads the site.
2. Creates a **Mirror Profile** (what the site actually says about itself).
3. Generates buyer prompts.
4. Tests AI answers.
5. Finds lost prompts.
6. Builds a Gap Matrix.
7. Generates safe website fixes.
8. Runs QA to prevent fabricated claims.

## What we are building right now

**Only Sprint 0 + Sprint 1.**

- Sprint 0 = technical foundation (docs, config, helpers, schema, folder structure).
- Sprint 1 = **Site Reader Agent** only. Website URL → crawl → Mirror Profile JSON → raw display.

## Guiding rules

1. **Engine first.** Get the pipeline producing real, structured output before anything else.
2. **Raw outputs second.** JSON on screen, not designed dashboards.
3. **Design after real outputs.** No UI polish until the data is proven useful.
4. **Stripe after the product works.** Pricing lives in a config file only.
5. **3D map later.** No visualizations in the MVP.

## Explicitly NOT in Sprint 0 or Sprint 1

- Final UI design
- Landing page
- Pricing page
- Stripe / billing
- 3D map / visualizations
- Gap Matrix UI
- Prompt Factory agent
- AI Probe agent
- Fix Agent
- QA Agent
- Exports
- Team features
- WordPress / Webflow integrations
- Dashboards
- Analytics
- Agency features

## Sprint 1 done criteria

Sprint 1 is done only when:

1. A user can enter a website URL.
2. The app crawls up to 5 pages on Free limits.
3. The Site Reader Agent receives pages inside XML tags.
4. The model returns JSON.
5. The JSON is validated with Zod.
6. The Mirror Profile is stored.
7. The raw Mirror Profile page displays the result.
8. Nothing outside of the Site Reader path is built.

## Anti-loss rule

Before writing any new code, ask:

> "Is this needed to produce a Mirror Profile from a website URL?"

If **no**, stop.

---

## Reconciliation with V1

Added during the V1 documentation pass. The sections above are unchanged; this
section records where they no longer describe the product.

### Still accurate

- The pipeline shape — site read → Mirror Profile → buyer prompts → AI answers →
  lost prompts → gap analysis → fixes → QA — is still the engine's structure.
- The guiding rules remain sound: engine before UI, raw outputs before design,
  and no publish-ready claim without QA.

### Superseded

| This document says | Current position |
| --- | --- |
| "Only Sprint 0 + Sprint 1" and "Sprint 1 = Site Reader Agent only" | The scan pipeline, report renderers, snapshot delivery, and founder back-office are all built. Scope is now defined by the V1 brief, not by sprint numbering. |
| The "Explicitly NOT in Sprint 0 or Sprint 1" list bars the AI Probe agent, Fix Agent, QA Agent, exports, landing page, and pricing page | All of these now exist in the repository. The list describes an early build order, not a current boundary. |
| "Stripe after the product works. Pricing lives in a config file only." | Still directionally true: `lib/pricing/plans.ts` holds plan definitions, and no checkout path is wired into the current product surface. Public SaaS pricing was deliberately removed from the client-facing surfaces for the founder-led phase. |
| "3D map later" / "no visualizations" | Unchanged as a V1 boundary. Trends and movement analytics are V2 — see the roadmap. |

### Not covered here at all

The V1 brief adds requirements this document predates: three runs per approved
question with exact request and response preserved, brand-self exclusion,
prompt-scoped competitor claims, `needs_evidence` gating, same-question retest
with preserved prompt identity, founder review before a client-ready report,
and the separation of observation from inference. Those are defined in the
brief and graded in `docs/CURRENT_STATUS.md`.
