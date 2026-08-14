# Zypact — Current Implementation Status

**Grounded in:** repository inspection on branch `main` at commit
`9aa914b` (35 migrations, 73 `scripts/test-*.ts` files, one GitHub Actions
workflow).

**Scope reference:** [`Zypact_V1_Engineering_Audit_Brief.md`](./Zypact_V1_Engineering_Audit_Brief.md)
· **Boundaries:** [`ROADMAP.md`](./ROADMAP.md)

## How to read this document

Every row carries one of the following grades. The grade describes what the
repository shows, not what the product intends.

| Grade | Meaning |
| --- | --- |
| **Verified** | Located in the repository and covered by a test, a migration, or direct inspection cited here |
| **Partial** | Present but incomplete, or complete only along one path |
| **Documented, unverified** | Described in repository documentation but not confirmed by inspection during this pass |
| **Missing** | No implementation located |
| **Unreliable** | Known to produce inconsistent or untrustworthy output |
| **Deferred** | Explicitly V2 or V3 |

This document is not an engineering audit. It is a founder-maintained
inventory written to make the audit cheaper. **A read-only engineering audit
must confirm or correct every row before pricing or production changes.**

## Implemented (verified by inspection)

| Capability | Evidence |
| --- | --- |
| Next.js app with auth, project pages, public snapshot request, and founder back-office | `app/` routes: `login`, `scan`, `projects/new`, `projects/[id]/*`, `admin/snapshot-requests/*`, `report/[secureToken]` |
| Supabase persistence with 35 tracked migrations | `supabase/migrations/0001…0035` |
| Live Perplexity probe path | `scripts/run-live-perplexity-probes.ts`, `npm run probe:perplexity` |
| Command-line MVP scan runner | `scripts/mvp-scan.ts`, `npm run mvp:scan` |
| Pipeline stages: Mirror Profile, Prompt Mirror, probe analysis, competitor discovery, Gap Map, Evidence Bank, Fix Brief, generated assets, QA | `lib/pipeline/*`, with per-stage suites registered as `test:mirror`, `test:prompts`, `test:probe`, `test:competitors`, `test:gap-map`, `test:evidence`, `test:fix-brief`, `test:assets`, `test:qa` |
| Report renderers (full MVP report and short client report) | `lib/export/build-mvp-report.ts`, `lib/export/build-sales-report.ts` |
| Snapshot report artifact storage with RPC-only writes | Migrations `0032`–`0035`; `test:snapshot-adapter-rpc-writes`, `test:snapshot-worker-dml-revocation-contract` |
| Atomic, fenced report replacement (expected artifact + revision) | Migration `0035`; `scripts/test-replace-report-route.ts` |
| Fenced report delivery with fail-closed provider handling | `lib/snapshot-requests/send-report-handler.ts`; `scripts/test-send-report-fencing.ts` |
| Founder review before delivery | `app/admin/snapshot-requests/[requestId]`; delivery requires founder action |
| Historical Fix Briefs excluded from client-facing recommendations | `scripts/test-historical-fix-brief-exclusion.ts` |
| Prompt-scoped competitor claims in the short report | `scripts/test-short-report-prompt-scoped.ts` |
| Dedicated snapshot worker service | `scripts/snapshot-worker.ts`, claim/lease tests |
| CI concurrency harness | `.github/workflows/snapshot-worker-postgres-level2.yml` |

## Partial

| Capability | What exists | What is missing |
| --- | --- | --- |
| Account and project model | Login, project creation, per-project pages | No company/workspace entity, no onboarding flow capturing category/audience/primary competitors |
| Core dashboard | Per-artifact pages under `projects/[id]/*` and a project layout | **No `projects/[id]/page.tsx`** — there is no project dashboard summarising status, latest scan, priority gap, or recommended action |
| Prompt approval | Prompts are stored and selected | Founder approval of questions *before* paid AI calls not confirmed as an enforced gate |
| Evidence Bank | Storage, intake, and review scripts | Review status is not confirmed to block publish-ready copy in every path |
| Report share/export | Public tokenised report route and client package builder | PDF and general share/export coverage unconfirmed |

## Missing

| Capability | Evidence |
| --- | --- |
| **Same-question retest and before/after** | Symbol search for `retest` across `lib/`, `app/`, `scripts/`, `supabase/` returns **zero** matches. Not implemented in any layer, including the data model. |
| **Buyer-journey stage metadata** | Search for `journey_stage` / `buyer_journey` returns zero matches in `supabase/` and `lib/` |
| Company/workspace entity and onboarding | No workspace model located |
| Project dashboard | See Partial, above |
| Notifications on completion/failure | Not located |
| Stripe/billing in the product surface | Only references are two stale backup files, `app/page.before-design-pass-*.tsx` and `app/page.tailwind-broken-*.tsx`. `lib/pricing/plans.ts` retains plan definitions as source of truth, but no checkout path is wired into the current landing page or app. |

## Requires manual terminal operation

The controlled workflow is **not** currently completable by an end user without
a terminal. These require an operator:

- Running a scan (`npm run mvp:scan`)
- Running live probes (`npm run probe:perplexity`)
- Regenerating Gap Maps and recommendations (`regenerate:live-gap-map`,
  `regenerate:live-recommendations`)
- Re-running QA on assets and fix briefs (`rerun:qa-asset`, `rerun:qa-fix-brief`)
- Backfilling and reviewing the Evidence Bank (`review:evidence-bank`)

Brief §8 Stage 2 exit criterion — *a new company can complete one safe
controlled scan with no terminal-only intervention by the end user* — is **not
met today**.

## Known evidence-integrity risks

Graded against Brief §6. These are the founder's understanding; the engineer
must reproduce and classify each one.

| # | Issue | Status here |
| --- | --- | --- |
| P0-1 | File-extension/content mismatch | **Reproduced.** `output/hadrius-manual-evidence.json` has a `.json` extension and contains Markdown beginning `# Zypact MVP — Client Report`. `output/hadrius-raw-probes.json` is genuine JSON. |
| P0-2 | Brand counted as its own competitor | **Unverified.** No brand-self exclusion guard was located by symbol search in `lib/pipeline/scorecard-competitors.ts`. Absence of a symbol is not proof of absent behaviour — the engineer must confirm by execution. |
| P0-3 | Inconsistent competitor counts across prompt-level, discovery, Gap Map, and executive summary | **Unverified in this pass.** A related defect was previously corrected for the short report only (`test-short-report-prompt-scoped.ts`). Cross-surface agreement is not proven. |
| P0-4 | Over-broad Gap Map combining weakly related brands | **Consistent with observed output.** A rendered full report has been observed presenting a single high-severity gap that enumerates more than twenty competitor names in one line. Fitness for client use is questionable; correctness of the underlying rule is unverified. |
| P0-5 | Alias duplication (`StratiFi` vs `StratiFi (ComplianceIQ)`) | **Unverified.** Alias-related code exists in `lib/pipeline/analyze-probe-response.ts` and `lib/client-package/build-client-package.ts`; determinism and reversibility unproven. |
| P0-6 | Unsupported causality in report language | **Partially mitigated.** Fix Brief grounding work added observation-only phrasing and free-text validation (`test-fix-brief-grounding.ts`, `test-fix-brief-free-text.ts`). Full-report language has not been audited end to end. |
| P0-7 | Fix-brief drift to competitors that do not represent the exact question | **Partially mitigated** for the short report; unverified for the full report. |
| P0-8 | Renderer inconsistency across short report, full report, raw export, and database aggregates | **Open.** No single canonical definition layer was located. This is the highest-value structural item in the brief (Stage 1). |

### Hadrius five-question scan — exact wording

The stored source report states **0 won, 2 partial, and 3 lost prompt groups
across 5 prompts and 15 live runs**.

This is verified as a statement contained in the stored report artifact. It has
**not** been independently reproduced from the current database state during
this documentation pass. Brief §5.2 additionally cites a 40% product
recommendation rate and a 40% cited-as-source rate for the same scan; those
figures are quoted from the brief and were likewise not recomputed here.

Reproducing this scan from canonical stored rows — and confirming that the
report, the database aggregates, and the raw runs agree — is audit work, not a
settled fact.

### Execution-safety items (Brief §6, P0)

Not verified during this pass and explicitly listed as audit work: paid-probe
reservation and budget enforcement, retry/idempotency behaviour on the paid
path, dry-run guarantees, unsupported-flag fail-closed behaviour, and
consistent environment loading. Secrets handling in the delivery path *is*
covered by tests asserting no claim token or credential reaches the browser.

## Additional repository risks found during this pass

1. **`output/` contains real prospect data and is not git-ignored.** It holds
   `hadrius-raw-probes.json` and `hadrius-manual-evidence.json`. A careless
   `git add -A` would commit client evidence. Recommend adding `output/` to
   `.gitignore` before any further commits.
2. **Stale backup page files are tracked in `app/`** —
   `page.before-design-pass-20260711-163323.tsx` and
   `page.tailwind-broken-20260711-161805.tsx`. They still contain Stripe
   references and should be removed or moved out of the app directory.
3. **`README.md` stated migration `0033`** while the repository contains
   through `0035`. Corrected in this documentation pass.

## What must be verified before another client scan

1. Reproduce every P0 item in Brief §6 against a safe fixture.
2. Establish one canonical definition layer so raw rows, database aggregates,
   UI, short report, and full report agree for the same project (Brief Stage 1
   exit criterion).
3. Confirm the brand can never be counted as its own competitor.
4. Confirm prompt-level competitor claims come only from runs for that exact
   prompt, and that cross-prompt totals are visibly labelled as aggregates.
5. Confirm paid-probe budgeting, idempotency, and dry-run safety on the real
   execution path.
6. Confirm live, simulated, historical, and current rows are never mixed.

## Demo-ready versus paid-pilot-ready

These are different bars and should be priced separately.

**Demo-ready (Brief Option A)** — plausible today with founder operation. The
path `buyer question → three live answers → brand/competitor evidence →
controlled gap/fix → founder-reviewed report` has been executed end to end and
its evidence is stored. What remains manual: scan execution, regeneration
steps, and report review, all from a terminal. The known P0 integrity issues
are still visible in generated output, so a demo must be driven from reviewed
material.

**Paid-pilot-ready (Brief Option B)** — **not met.** The blocking gaps are
structural, not cosmetic:

- same-question retest and before/after do not exist in any layer;
- no project dashboard for a pilot user to land on;
- no company/workspace or onboarding model;
- the controlled scan cannot be completed without a terminal;
- renderer/aggregate consistency is unproven, so client-facing numbers are not
  yet defensible across surfaces.

An external customer should not be onboarded onto the controlled workflow until
Stage 1 and Stage 2 exit criteria in the brief are met.
