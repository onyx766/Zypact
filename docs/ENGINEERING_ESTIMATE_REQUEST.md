# Engineering Estimate Request — Zypact V1

**For:** the engineer receiving repository access
**Read first:** [`Zypact_V1_Engineering_Audit_Brief.md`](./Zypact_V1_Engineering_Audit_Brief.md)
· [`CURRENT_STATUS.md`](./CURRENT_STATUS.md) · [`ROADMAP.md`](./ROADMAP.md)

Please begin with a **read-only audit**. Do not assume the product must be
rebuilt, and do not make production changes before returning your findings.

`CURRENT_STATUS.md` is a founder-maintained inventory, not an audit. Treat every
row in it as a claim to confirm or correct.

## Sequence

### Stage 0 — read-only audit (first, before any estimate)

Inspect repository structure, branches, recent commits, environment
documentation, migrations, deployment configuration, pipeline, adapters, tests,
and UI. Run existing tests without destructive database changes. Reproduce the
Hadrius fixtures, or equivalent safe fixtures.

**Deliverable:** a written audit classifying each item as `working`, `partial`,
`missing`, `broken`, `unsafe`, or `obsolete`, with code references.

Make no production mutation without written approval.

### Then, the estimate

## Required deliverables

1. **Architecture inventory** — frontend, backend, database, workers and
   functions, AI providers, third-party services, deployment, observability.
2. **Feature inventory** — every V1 item from Brief §4 graded `complete`,
   `partial`, `missing`, `broken`, `unsafe`, or `defer`, each with a code
   reference.
3. **Data-flow diagram** — user input through report and retest, showing every
   database write and every paid model call.
4. **Risk register** — security, privacy, data integrity, cost, reliability,
   deployment, maintainability.
5. **Known-issue reproduction** — findings for every P0 item in Brief §6,
   including the evidence-integrity and execution-safety lists.
6. **Recommended plan** — milestones, dependencies, sequencing, acceptance
   criteria, and which current code to retain versus replace.
7. **Estimate** — hours and price *by stage*, not one unexplained total.
8. **Timeline** — calendar estimate, assumptions, availability, review
   checkpoints.
9. **Operating-cost estimate** — expected monthly infrastructure and
   AI-provider cost at pilot volume.
10. **Post-launch terms** — warranty/bug-fix period, maintenance rate, support
    expectations, code ownership.

## Two options, priced separately

### Option A — Founder Institute demo-ready

The smallest honest, stable version that demonstrates:

`buyer question → three live answers → brand/competitor evidence → controlled gap/fix → founder-reviewed report`

State clearly what still requires founder or manual operation.

### Option B — External paid-pilot-ready V1

The complete V1 scope necessary for a real external customer to use the
controlled workflow safely, including same-question retest and basic
before/after.

### Required table, for each option

| Stage | Work included | Hours | Price | Dependencies | Acceptance test | Exclusions |
| --- | --- | ---: | ---: | --- | --- | --- |
| Audit | | | | | | |
| Evidence integrity | | | | | | |
| Core pipeline | | | | | | |
| Product UI | | | | | | |
| Retest/hardening | | | | | | |

Also state, per option: operating costs at pilot volume, and maintenance terms.

**On budget:** provide an independent estimate based on the repository audit
and the actual work required. Do not infer or optimize around an assumed
founder budget. State your proposed hours, price, assumptions, and exclusions
for each option, then identify the safest reduced-scope alternative
separately.

## Questions to answer after reviewing the repository

1. What percentage of the V1 scope already works end to end?
2. Which existing components are production-usable, reusable with fixes, or
   unsafe?
3. What is the root cause of the Hadrius report inconsistencies?
4. Is there currently one canonical data source for reports and dashboards?
5. What must be fixed before another live customer scan is trusted?
6. Can the current architecture support same-question retesting cleanly?
7. Can the full V1 be completed incrementally without a rewrite?
8. What is the smallest demo-ready milestone, and what remains manual?
9. What is the real price for demo-ready and pilot-ready versions?
10. What access is required at each stage, and why?

## Access and change control

**Initial access:** GitHub read access should be sufficient to audit. You will
receive a sanitized environment-variable inventory — **names only, never
values**. Use test or staging resources where available. Production API keys,
service-role keys, personal credentials, and unrestricted database access will
not be shared in chat, email, or documentation.

**Before code changes:** agree branch strategy and pull-request workflow;
milestone scope, acceptance tests, price, and payment schedule; identify
production versus staging; back up the database and document migration
rollback. Do not rewrite, delete, or reset unrelated existing work.

**Ownership:** all commissioned code and documentation is committed to the
Zypact-owned repository. The founder retains hosting, database, domain, email,
AI-provider, analytics, and billing accounts. No critical system remains under
an engineer's personal account. Every deployment and migration ships with
written instructions.

## Integrity rules that constrain any implementation

These are non-negotiable and apply to every change (Brief §7):

1. Raw probe request and raw response are immutable evidence.
2. No client-facing number without traceable stored rows.
3. No model-generated summary may override deterministic observed facts.
4. The brand is never a competitor to itself.
5. Competitors in a prompt statement come from runs for that exact prompt.
6. Cross-prompt totals must be visibly labelled as cross-prompt aggregates.
7. Alias normalization must be deterministic, auditable, and reversible.
8. A recommendation is not a proven cause.
9. `needs_evidence` blocks unsupported publish-ready copy.
10. Live, simulated, historical, and current rows are never silently mixed.
11. A retest preserves question identity and shows any version change.
12. Founder review is visible in the data and in report status.
