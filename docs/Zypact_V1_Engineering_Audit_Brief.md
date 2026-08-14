# Zypact V1 — Product Scope, MVP Stages, and Engineering Audit Brief

- **Document status:** Pre-audit scope for engineering review
- **Prepared:** 2026-08-14
- **Purpose:** Give an engineer enough product and technical context to inspect the existing GitHub repository, distinguish what already works from what is incomplete, and return a defensible implementation estimate.

> This document does not claim that every item below is already implemented. The engineer must verify the repository, database, deployment, tests, and production configuration before estimating or changing code.

## 1. Product definition

Zypact is an AI Buyer Journey Intelligence product for B2B SaaS companies.

Its core job is to reveal:

1. which AI-assisted buyer decisions a company is losing;
2. which competitors enter the shortlist instead;
3. the evidence contained in the exact AI answers;
4. what the company should test first; and
5. whether the result changes when Zypact retests the same buyer question.

### V1 promise

**Run a controlled scan, see where the brand loses an AI-assisted buyer decision, inspect the evidence, choose the first fix worth testing, and retest the same question.**

### V2 promise — not part of this estimate unless quoted separately

**Continuously monitor the complete AI buyer journey, detect movements, recommend opportunities, and measure the historical impact of fixes across platforms.**

### V3 direction — not part of V1

Predictive buyer intelligence: emerging decision risks, competitor momentum, and expected impact of possible fixes.

## 2. Why the repository must be audited before pricing

Zypact is not a greenfield idea. An existing codebase and database already contain substantial MVP work, including parts of the following pipeline:

`site crawl -> Mirror Profile -> buyer prompts -> live AI probes -> probe analysis -> competitor discovery -> Gap Map -> Evidence Bank -> Fix Brief -> report/export`

The repository also contains tests, Supabase persistence, report renderers, and a command-line MVP scan runner. Some features are complete, some are partial, and some outputs have shown integrity problems. The estimate must therefore be based on the actual repository rather than on this feature list alone.

The engineer should not rebuild the product from zero before documenting why reuse is unsafe or materially more expensive.

## 3. V1 end-to-end user journey

V1 must ultimately support this complete controlled workflow:

`Create account -> company/workspace -> project -> Mirror Profile -> buyer questions -> approval -> AI runs -> raw evidence -> competitors -> gaps -> controlled fix -> same-question retest -> before/after -> founder-reviewed report`

This is a complete V1 experience, but it is not yet the continuous, multi-platform intelligence system planned for V2.

## 4. V1 functional scope

### 4.1 Account, workspace, and onboarding

- Create account and log in.
- Maintain a basic user profile.
- Create or select one basic company/workspace.
- Complete onboarding with company name, domain, category, target audience, and primary competitors.
- Create and reopen basic projects.
- Support one owner role in V1; advanced team roles and permissions are deferred.

### 4.2 Core dashboard

- Show project status and current pipeline stage.
- Show the latest scan summary.
- Show buyer-question results, brand position, main competitors, priority gap, recommended first action, and retest status.
- Clearly distinguish live, simulated, incomplete, failed, and founder-reviewed data.
- Do not present advanced trends when insufficient historical data exists.

### 4.3 Mirror Profile

- Read the company website and produce a structured Mirror Profile.
- Store category, audience, use cases, features, claims, proof signals, pain points, and buyer-intent angles with provenance.
- Allow founder/user review and correction before the profile drives prompts or recommendations.
- V1 may require manual approval; automatic continuous updates are V2.

### 4.4 Buyer questions and basic journey structure

- Create or import commercially meaningful buyer questions.
- Store the question text, intent, commercial priority, approval status, version, and optional buyer-journey stage.
- Support a basic decision/journey view without claiming predictive intelligence.
- Recommended stages for the V1 data model: `discovery`, `research`, `evaluation`, `comparison`, and `decision`.
- Allow a founder/user to approve or reject questions before any paid AI call.
- Advanced automatic journey expansion is deferred to V2.

### 4.5 AI testing

- Perplexity Sonar is the required live platform for the core V1 path.
- Run the same approved question three times by default.
- Preserve the exact outbound prompt/request and exact raw response for every run.
- Preserve platform, model/mode, timestamps, citations/sources, status, failure reason, and estimated cost.
- Any limited ChatGPT, Gemini, or Claude support must be quoted separately or included only if it is already implemented and stable.
- More platforms and configurable continuous monitoring are V2.

### 4.6 Evidence and scoring

- Show the raw AI responses used in every result.
- Derive brand mention, product recommendation, position, verdict, cited-as-source status, competitors, and sources from stored runs.
- Aggregate three runs at question level without hiding disagreement between runs.
- Keep observation separate from interpretation:
  - **Observed:** what appeared in the exact stored runs.
  - **Inferred:** a controlled explanation that must not be presented as proven causality.
- Every metric shown in the UI or report must trace back to canonical stored probe rows.

### 4.7 Evidence Bank

- Store product facts, features, target audience, proof items, source URLs, allowed claims, forbidden claims, and review status.
- Preserve provenance and distinguish site-derived, user-supplied, model-inferred, and human-verified evidence.
- Do not generate publish-ready claims from an unreviewed Evidence Bank.
- Advanced automated evidence management is V2.

### 4.8 Competitor detection and entity resolution

- Detect competitors only from the relevant stored runs and approved context.
- Normalize obvious aliases without merging distinct products or companies.
- Preserve raw names alongside canonical names.
- Prevent the audited brand from being counted as its own competitor.
- Show mention counts, recommendation position, the exact questions where each competitor appeared, and supporting run IDs.
- Advanced continuous competitor intelligence is V2.

### 4.9 Basic Gap Map and recommendation

- Identify lost, partial, and won buyer questions using documented rules.
- Produce a basic Gap Map tied to exact questions and exact observed competitors.
- Recommend one controlled first action when the available evidence supports it.
- Label recommendations `needs_evidence` when product/competitor comparisons are not verified.
- Never claim that a missing page or content element caused an AI result unless the evidence actually establishes causality.
- Trend-based Gap Maps and fully automated recommendations are V2.

### 4.10 Retest and before/after

- Retest the exact same approved buyer question after a fix.
- Preserve prompt identity and version; do not silently rewrite the question.
- Compare the same platform, run policy, and scoring rules whenever possible.
- Display before/after results with dates, run counts, positions, competitors, citations, and sampling caveats.
- Continuous automated retesting and historical impact analytics are V2.

### 4.11 Report, export, and sharing

- Produce a concise client-facing report from canonical stored evidence.
- Include executive diagnosis, tested questions, three-run outcomes, observed competitors, evidence, limitations, first recommended test, and retest status.
- Separate client-facing content from technical metadata.
- Support a basic share/export path. PDF is optional unless already implemented or explicitly included in the estimate.
- Require founder review before a report is marked client-ready.
- Advanced/custom reporting is V2.

### 4.12 Core automation and reliability

- Provide one controlled end-to-end execution path with explicit stages and failures.
- Reserve/check usage before paid calls.
- Enforce configured run and budget limits.
- Fail closed when configuration, secrets, project identity, prompt approval, or database access is missing.
- Prevent duplicate paid runs caused by retries or double submission.
- Store progress and make failed stages recoverable without corrupting the project.

### 4.13 Basic commercial and operational features

- Complete, usable V1 UX/UI for the core journey.
- Basic notifications for completion/failure if already supported or inexpensive to finish.
- Basic Stripe/subscription support only if required for launch and quoted explicitly.
- Advanced billing, teams, comments/tasks, CRM, Slack, HubSpot, API, white-label, enterprise SSO, mobile app, continuous monitoring, advanced alerts, and advanced analytics are not part of the core V1 estimate unless listed as separate options.

## 5. Current technical evidence and validated test

### 5.1 Live manual Hadrius evidence probe

One exact buyer question was executed three times through live Perplexity Sonar:

> What is the best AI compliance platform for RIAs and broker-dealers managing SEC and FINRA supervision?

The three stored runs showed:

| Run | Hadrius position | Product verdict | Examples of observed competitors |
|---:|---|---|---|
| 1 | absent | lost | StratiFi (ComplianceIQ), Luthor, Glynac AI, Smarsh, RegFin |
| 2 | listed | partial | StratiFi, Luthor, Smartria |
| 3 | primary | won | Smarsh, StratiFi, RegReview |

The raw responses were stored and were approximately 7,718, 8,613, and 8,656 characters. This proves that the live probe path can execute and preserve evidence. It does not prove that every downstream analysis or report transformation is reliable.

### 5.2 Larger Hadrius scan

A separate live scan stored 5 buyer questions with 3 runs per question (15 runs). Its headline scorecard reported 3 lost question groups, 2 partial groups, 0 won groups, a 40% product-recommendation rate, and a 40% cited-as-source rate.

This larger scan is useful as an audit fixture because it exposed downstream inconsistencies and over-broad competitor/gap logic.

## 6. Known issues that the engineer must reproduce and classify

### P0 — evidence integrity and report trust

1. **File-extension/content mismatch:** an output path ending in `.json` can contain Markdown rather than JSON.
2. **Competitor contamination:** the audited brand can appear in a “top competitors” list.
3. **Inconsistent competitor counts:** prompt-level observations, competitor-discovery output, Gap Map competitors, and executive-summary competitors can disagree.
4. **Over-broad Gap Map:** unrelated or weakly related brands can be combined into a single large “competitor gap,” producing an unusable list.
5. **Alias duplication:** variants such as `StratiFi`, `StratiFi (ComplianceIQ)`, and other product/company aliases can be counted separately.
6. **Unsupported causality:** some report language can imply that missing comparison pages, FAQs, or proof directly caused the model outcome even though stored runs only prove correlation/observation.
7. **Fix-brief drift:** a recommended comparison page can use competitors that do not cleanly represent the exact buyer question or target category.
8. **Renderer inconsistency:** the short report, full report, raw probe export, and database aggregates must all use the same canonical definitions.

### P0 — execution safety

1. Confirm that paid-probe reservations, budgets, retry behavior, idempotency, rate limits, and failure recovery work in the actual execution path.
2. Confirm that secrets remain server-side and are never logged, exported, or sent to the browser.
3. Confirm that a dry run performs no paid calls and no persistent writes.
4. Confirm that unsupported command flags fail closed and supported flags are documented.
5. Confirm that environment files are loaded consistently by documented commands without requiring unsafe manual secret handling.

### P1 — product completeness

1. Determine which account, workspace, onboarding, project, dashboard, approval, report, export, billing, and notification screens already exist and which are only prototypes.
2. Determine whether UI states match database and pipeline states.
3. Determine whether founder review/approval exists before prompts, reports, recommendations, and publish-ready outputs.
4. Determine whether same-question retesting is implemented end to end or only represented in the data model.
5. Determine whether the app can support a real external pilot without terminal intervention.

## 7. Non-negotiable integrity rules

1. Raw probe request and raw response are immutable evidence.
2. No client-facing number may exist without traceable stored rows.
3. No model-generated summary may override deterministic observed facts.
4. The brand is never a competitor to itself.
5. Competitors in a prompt statement must come from runs for that exact prompt.
6. Cross-prompt totals must be visibly labeled as cross-prompt aggregates.
7. Alias normalization must be deterministic, auditable, and reversible.
8. A recommendation is not a proven cause.
9. `needs_evidence` must block unsupported publish-ready copy.
10. Live, simulated, historical, and current rows must never be silently mixed.
11. A retest must preserve question identity and show any version change.
12. Founder review must be visible in the data and report status.

## 8. Proposed MVP delivery stages inside V1

The engineer may recommend a different sequence after the audit, but the estimate should map work to these outcomes.

### Stage 0 — read-only technical audit

- Inspect repository structure, branches, recent commits, environment documentation, migrations, deployment configuration, pipeline, adapters, tests, and UI.
- Run existing tests without destructive database changes.
- Reproduce the Hadrius fixtures or equivalent safe fixtures.
- Produce an implementation inventory and risk register.
- Make no production mutation without approval.

**Deliverable:** written audit with `working`, `partial`, `missing`, `broken`, `unsafe`, and `obsolete` classifications.

### Stage 1 — canonical evidence layer

- Establish one canonical source of truth for runs and aggregates.
- Fix output-format contracts, entity normalization, prompt-level competitor scope, brand-self exclusion, scorecard rules, and renderer consistency.
- Add regression fixtures from the Hadrius evidence.

**Exit criterion:** raw rows, database aggregates, UI, short report, and full report agree for the same project.

### Stage 2 — controlled end-to-end V1 pipeline

- Stabilize project creation, Mirror Profile review, prompt approval, budget reservation, three live runs, evidence storage, competitor extraction, basic gaps, controlled fix, and failure recovery.
- Ensure the happy path can be executed without editing code or database rows manually.

**Exit criterion:** a new company can complete one safe controlled scan with no terminal-only intervention by the end user.

### Stage 3 — V1 product experience

- Complete the required account, company, project, dashboard, evidence, recommendation, retest, before/after, report, and basic sharing screens.
- Add honest loading, empty, error, insufficient-evidence, and blocked states.

**Exit criterion:** a pilot user can understand what happened and inspect the evidence without developer explanation.

### Stage 4 — retest, launch hardening, and handoff

- Complete same-question retest and before/after comparison.
- Add final limits, logging, security review, production smoke tests, deployment runbook, database migration notes, and rollback procedure.
- Document known limitations and operational costs.

**Exit criterion:** V1 is demo-ready and pilot-ready under the explicitly documented limits.

## 9. Required audit deliverables from the engineer

Before providing a final build commitment, return:

1. **Architecture inventory:** frontend, backend, database, workers/functions, AI providers, third-party services, deployment, and observability.
2. **Feature inventory:** every V1 item marked `complete`, `partial`, `missing`, `broken`, `unsafe`, or `defer` with code references.
3. **Data-flow diagram:** user input through report and retest, including every database write and paid model call.
4. **Risk register:** security, privacy, data integrity, cost, reliability, deployment, and maintainability risks.
5. **Known-issue reproduction:** findings for every P0 issue in Section 6.
6. **Recommended plan:** milestones, dependencies, sequencing, acceptance criteria, and which current code should be retained or replaced.
7. **Estimate:** hours and price by stage, not one unexplained total.
8. **Timeline:** calendar estimate, assumptions, availability, and review checkpoints.
9. **Operating-cost estimate:** expected monthly infrastructure and AI-provider cost at pilot volume.
10. **Post-launch terms:** warranty/bug-fix period, maintenance rate, support expectations, and ownership of code.

## 10. Estimate format requested

Provide two separate options after the audit:

### Option A — Founder Institute demo-ready

The smallest honest, stable version that demonstrates:

`buyer question -> three live answers -> brand/competitor evidence -> controlled gap/fix -> founder-reviewed report`

State clearly what still requires founder/manual operation.

### Option B — External paid-pilot-ready V1

The complete V1 scope necessary for a real external customer to use the controlled workflow safely, including retest and basic before/after.

For each option, provide:

| Stage | Work included | Hours | Price | Dependencies | Acceptance test | Exclusions |
|---|---|---:|---:|---|---|---|
| Audit |  |  |  |  |  |  |
| Evidence integrity |  |  |  |  |  |  |
| Core pipeline |  |  |  |  |  |  |
| Product UI |  |  |  |  |  |  |
| Retest/hardening |  |  |  |  |  |  |

Provide an independent estimate based on the repository audit and the actual work required. Do not infer or optimize around an assumed founder budget. State your proposed hours, price, assumptions, and exclusions for each option, then identify the safest reduced-scope alternative separately.

## 11. Access and change-control rules

### Initial access

- GitHub access should initially be sufficient to audit the repository.
- Provide a sanitized environment-variable inventory, not secret values.
- Use test/staging resources where available.
- Do not share production API keys, service-role keys, personal credentials, or unrestricted database access in chat, email, or documentation.

### Before code changes

- Agree on branch strategy and pull-request workflow.
- Agree on milestone scope, acceptance tests, price, and payment schedule.
- Identify production versus staging systems.
- Back up the database and document rollback for migrations.
- Do not rewrite, delete, or reset unrelated existing work.

### Ownership and handoff

- All commissioned code and documentation must be committed to the Zypact-owned repository.
- The founder retains access to hosting, database, domain, email, AI-provider, analytics, and billing accounts.
- No critical system should remain under an engineer's personal account.
- Every deployment and migration must have written instructions.

## 12. Definition of V1 done

V1 is done only when all of the following are true:

- A user can complete the controlled core journey without a developer editing the database or code.
- Paid AI calls are approved, budgeted, traceable, limited, and recoverable.
- Every result links to exact raw evidence.
- The brand, competitors, counts, verdicts, and reports agree across the system.
- Insufficient evidence produces a limitation or block rather than invented confidence.
- The same buyer question can be retested and compared honestly.
- The founder can review and approve the client-facing report.
- Critical tests pass in CI or through a documented repeatable command.
- A staging/production deployment and rollback procedure are documented.
- Known V2/V3 features are excluded from V1 claims and pricing.

## 13. Explicitly deferred beyond core V1

- Continuous weekly/monthly monitoring.
- Full multi-platform AI coverage.
- Advanced AI-generated journey expansion.
- Historical AI visibility trends and movement analytics.
- Continuous competitor intelligence.
- Predictive buyer intelligence.
- Advanced teams, roles, comments, and tasks.
- CRM, Slack, and HubSpot integrations.
- Public API.
- White-label.
- Enterprise SSO.
- Native mobile application.

## 14. Questions the engineer must answer after reviewing GitHub

1. What percentage of this V1 scope already works end to end?
2. Which existing components are production-usable, reusable with fixes, or unsafe?
3. What is the root cause of the Hadrius report inconsistencies?
4. Is there currently one canonical data source for reports and dashboards?
5. What must be fixed before another live customer scan is trusted?
6. Can the current architecture support same-question retesting cleanly?
7. Can the full V1 be completed incrementally without a rewrite?
8. What is the smallest demo-ready milestone, and what remains manual?
9. What is the real price for demo-ready and pilot-ready versions?
10. What access is required for each stage, and why?

---

## Short message to accompany GitHub access

Please begin with a read-only audit of the existing Zypact repository and this V1 brief. Do not assume the product must be rebuilt, and do not make production changes before returning your findings. I need two evidence-based estimates: the smallest honest Founder Institute demo-ready milestone and the complete external paid-pilot-ready V1. For each, show what already exists, what is broken or missing, the proposed milestones, hours, price, dependencies, acceptance tests, exclusions, and ongoing operating costs.
