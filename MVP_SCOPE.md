# Zypact MVP — Scope

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
