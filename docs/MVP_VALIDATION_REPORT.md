# Zypact MVP — Validation Report

> **Internal technical record.** This document is an internal engineering
> validation and rollout log. It is **not** an external security audit,
> penetration test, or third-party certification.
>
> Supabase project references and database row identifiers have been replaced
> with `[REDACTED_PROJECT_REF]` and `[REDACTED_UUID]` placeholders. Public
> vendor documentation links are retained as-is.


## Run — 2026-07-09 22:15 UTC (Sprint 11.5 — client-facing export readability)

### Scope

Improve the Markdown export for client readability without changing the
engine. No new features, no schema changes, no LLM calls, no QA logic
changes, no auth/security/RLS changes. See original brief for the full
list of requested formatting improvements.

### Files changed

- `lib/export/build-mvp-report.ts` — full rewrite of section layout.
  New sections added: Executive Summary (§1), Publishability Status
  (§2), Evidence Needed to Unlock Publish-Ready Assets (§3), What this
  means (§8), Recommended Next Actions (§11). Technical metadata moved
  to Appendix (§19). New helpers exported for tests: `resolveCompanyName`,
  `resolveCategoryDisplay`, `deriveProbeMode`, `simulatedProbeLabel`,
  `gapToRecommendedAction`, `aggregateEvidenceNeeded`. Bumped
  `EXPORT_FORMAT_VERSION` to `2`.
- `scripts/test-export-report.ts` — updated section-headings list to
  19 sections; added new coverage for companyName fallback,
  simulated-probe honesty, category caveat, recommended-action mapping,
  evidence-needed aggregation, and grouped-asset publish-status
  subheadings.
- `scripts/test-export-route-security.ts` — updated heading list to
  match 19 client-facing sections; added assertions that the probe
  section carries the honesty label and the appendix records probe
  origin as simulated.
- `scripts/verify-export-readonly-live.ts` — same 19-section update.
- `zypact-demo-report-linear.md` — regenerated from the live authenticated
  project `[REDACTED_UUID]`.

Nothing else in the pipeline was touched: prompts, Zod schemas, QA
logic, auth/ownership guards, RLS, and DB grants are all unchanged.

### Client-facing improvements (mapped to the brief)

1. **Executive Summary at the top** (§1). Includes brand, domain,
   category, sampled probe result (won/partial/lost), top competitors
   recommended instead, biggest gap, next recommended fix,
   publishability, and evidence-needed count. Explicitly labeled
   "simulated, N sampled" to prevent misreading as a full benchmark.
2. **Technical metadata moved to appendix** (§19). `projectId`,
   `scanId`, provider, model, mock mode, timestamps, and
   `exportFormatVersion` are still present verbatim — just not the first
   thing a client sees.
3. **companyName fallback**: `resolveCompanyName` returns `project.
   companyName` first, then `mirrorProfile.json.companyName`, then
   `project.domain`. Verified in the live report — Linear's project row
   has `companyName = NULL` and the export correctly shows
   `Brand: Linear _(source: mirror_profile)_`.
4. **Category display**: `resolveCategoryDisplay` reads
   `mirrorProfile.detectedCategory` and emits a caveat when
   `categoryConfidence` is not `high` OR the label looks
   model-inferred/over-specific (contains "for" or > 60 chars). The live
   Linear export carries the caveat "This category is model-inferred
   and may over-specify the brand's positioning. Confirm with the brand
   before quoting." because the detected category is
   "AI product development platform for teams".
5. **What this means** (§8) — plain-English section after Probe
   Results with 4 sub-parts: which prompts the brand lost, which
   competitors appeared, why this matters commercially, and the
   sampling caveat.
6. **Recommended Next Actions** (§11) — every prioritized gap becomes
   a concrete website action (comparison page, FAQ block, proof block,
   third-party review citation, JSON-LD schema, pricing evidence).
   Vague suggestedFixDirection strings only appear as a fallback for
   unknown gap types.
7. **Generated Assets grouped by publish status** (§14):
   Publish-ready / Needs evidence / Unsupported claims / Pending QA.
   When zero assets are publish-ready, a soft-tone paragraph explains
   "This does not mean the scan failed. It means the Evidence Bank does
   not yet contain enough verified facts to safely publish these
   drafts."
8. **Evidence Needed to Unlock Publish-Ready Assets** (§3) —
   aggregates every distinct evidence gap across Fix Briefs
   (`evidenceNeeded`), asset placeholders, and QA reports
   (`placeholdersRemaining`). Deduplicated on canonical lowercase.
   On the live Linear export, this surfaces exactly the two gaps
   flagged by the brief: `pricing information` and
   `specific features or benefits of Linear that enhance coordination
   across teams`.
9. **NOT READY TO PUBLISH softened**: kept the label, added a
   status-specific tagline ("Held by QA to prevent unsupported claims —
   add the missing evidence to the Evidence Bank and re-run QA." for
   `needs_evidence`; "not backed by the Evidence Bank yet" for
   `unsupported_claims`; "QA has not run against this draft yet" for
   `pending_qa`).
10. **Dynamic fence + secret redaction unchanged**. `computeDynamicFence`,
    `wrapAssetContent`, and `redactSensitive` are byte-identical to
    Sprint 11.

### Simulated-probe honesty (Sprint 12 guardrail #3 applied to the export)

Every probe reference in the export is labeled as **simulated** because
no live-platform-API probe path exists in the codebase yet. Concretely:

- Probe headings use "Simulated <Platform>-style probe · verdict: …"
  instead of "Probe · chatgpt". Verified in `sectionProbeResults`.
- The Probe Results section header carries a blockquote:
  "Every result in this section came from a simulated, manually-entered
  probe. No live call was made to ChatGPT, Perplexity, Gemini, or any
  other AI platform API."
- Each individual probe body includes `probe origin: simulated (not a
  live platform response)`.
- Appendix (§19) records `probe origin: simulated (no live platform
  API integration)`.

`deriveProbeMode(row)` is the single choke-point where Sprint 12 will
later read the persisted `probeMode` column if/when one is added. The
current implementation returns `"simulated"` unconditionally — which is
the correct answer today because no code path calls a live AI-platform
API.

### Sprint 12 guardrails — what was and was not built

The improvement brief listed several "Sprint 12 guardrails" that apply
whenever new engine features land. Per the top-level rule
("Do not build new features / no schema changes / no QA logic changes"),
this sprint applied only the guardrails that could be honored via
display-layer changes:

| Guardrail | Applied here? | Notes |
|---|---|---|
| Existing data backfill: probeMode = simulated when no live evidence | Applied at display layer via `deriveProbeMode` | Column not yet added; will be a migration in Sprint 12 |
| QA merging rule: deterministic violations merge with LLM QA | **Deferred** | Requires new engine feature; not touched |
| Export honesty rule: never say "ChatGPT said …" unqualified | **Applied** | See simulated-probe honesty above |
| Regression test: simulated probes labeled in metadata + every probe section | **Applied** | `testFullReport` and route test both assert this |
| Regression test: companyName falls back from Mirror Profile | **Applied** | `testCompanyNameInReport` |
| Regression test: fabricated URL fails QA even if LLM QA missed it | **Deferred** | Requires deterministic QA layer |
| Regression test: sourcesCited reaches the Gap Map input | **Deferred** | Requires reading Gap Map input format; out of scope for readability sprint |
| Regression test: faq_block without Q&A fails deterministic QA | **Deferred** | Requires deterministic QA layer |
| Regression test: proof_block without evidence-bank proof fails deterministic QA | **Deferred** | Requires deterministic QA layer |
| Regression test: auto-filled Evidence Bank provenance appears in export | **Deferred** | Requires new engine feature |
| No cleanup by hiding | **Applied** | Every failed asset is still rendered, just softened with a tagline |

Every "Deferred" row above requires a real engine change (new columns,
new QA logic, new evidence-bank provenance auto-fill). Building them
now would violate the "no new features" rule at the top of the brief.
They are the natural entry point for Sprint 12.

### Validation

Commands run (in order):

- `npm run typecheck` — clean.
- `npm run build` — clean.
- `npm run test:export` — **104 / 104 checks passed.** Sprint 11.5
  builder scenario.
- `ZYPACT_MOCK_MODE=on npm run test:export-route` — **20 / 20 checks
  passed.** Sprint 11 route security scenario (updated for new
  headings). Includes unauthenticated → 401, non-owner → 404,
  legacy-null-owner → 404, owner → 200, no DB writes, secret redaction
  fires, byte-identical missing-vs-non-owner responses.
- `npm run test:auth` — 10 / 10 checks passed. Sprint 10.5 auth /
  ownership scenario still green.
- `ZYPACT_MOCK_MODE=on npm run test:qa` — Sprint 9 smoke test still
  green.
- `ZYPACT_MOCK_MODE=on npm run test:full-pipeline` — full mock
  regression, all 13 tables written, no asset stays in `pending_qa`,
  all 8 guard messages still verbatim.
- `scripts/run-with-env.py npx tsx scripts/verify-export-readonly-live.ts
  [REDACTED_UUID]` — read-only proof against the
  live authenticated Linear project. Row counts and `updated_at`
  timestamps unchanged before/after export. No secret env value
  appears in the body. All 19 client-facing sections present. Passed.
- `scripts/run-with-env.py npx tsx scripts/generate-demo-export.ts
  [REDACTED_UUID] zypact-demo-report-linear.md` —
  regenerated the demo Markdown for hand review.

### Regenerated demo export (Linear)

- **file**: `zypact-demo-report-linear.md`
- **size**: 37,811 bytes
- **owner**: `a76f133a…` (authenticated Supabase user)
- **redactions performed**: 0 (no secrets found in body)
- **QA distribution**: `pending_qa=0, needs_evidence=4, safe_to_publish=0, unsupported_claims=1`
- **not-ready asset count**: 5
- **companyName fallback fired**: yes (Linear pulled from
  `mirrorProfile.companyName`; `project.companyName` was `NULL`)
- **category caveat fired**: yes (label
  "AI product development platform for teams" is flagged as
  model-inferred)

### Deferred / stop line

Sprint 11.5 stops here per the brief. Sprint 12 (deterministic QA
merging, `probeMode` column + migration, evidence-bank provenance
auto-fill) is the natural next step. Nothing about the current
export changes is blocking — the export is safe to hand to a client
today as long as they read the sampling caveat in the Executive
Summary.

---

> **How to fill this in.** Run `npm run test:full-pipeline` (optionally
> with a real `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and
> `ZYPACT_MOCK_MODE=off` for a live-model run). Copy the report block
> printed at the end into the fields below. Do not paste synthetic
> numbers.
>
> Keep one report per validation run. Append new sections at the top; do
> not overwrite past results.

---

## Run — `<TBD: yyyy-mm-dd HH:MM tz>`

### Test date
`<TBD>`

### Test mode
- [ ] mock
- [ ] live model (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` configured)

Model / provider: `<TBD>`

### URL tested
`<TBD>`

### Pipeline result
- [ ] pass
- [ ] fail

### Broken stages
List each stage that failed or degraded (leave `n/a` on a clean pass).

| Stage | Symptom | Follow-up |
|---|---|---|
| `<TBD>` | `<TBD>` | `<TBD>` |

### Data counts

| Metric | Value |
|---|---|
| projectId | `<TBD>` |
| pages crawled | `<TBD>` |
| detectedCategory | `<TBD>` |
| prompts generated | `<TBD>` |
| selected prompts (`recommendedForProbe`) | `<TBD>` |
| probe results | `<TBD>` |
| lost / partial probe results | `<TBD>` |
| competitors | `<TBD>` |
| blind spots | `<TBD>` |
| phantom competitors | `<TBD>` |
| competitor distances (Gap Map) | `<TBD>` |
| prioritized gaps | `<TBD>` |
| evidence bank present | `<TBD>` |
| evidence bank usable | `<TBD>` |
| fix briefs | `<TBD>` |
| generated assets | `<TBD>` |
| QA reports | `<TBD>` |

### QA distribution

| `qa_status`              | Count |
|--------------------------|-------|
| `pending_qa`             | `<TBD>` |
| `needs_evidence`         | `<TBD>` |
| `safe_to_publish`        | `<TBD>` |
| `unsupported_claims`     | `<TBD>` |

### Guard-message contract

Confirmed that all 8 canonical guard strings are still exported and used
verbatim (asserted by `test:full-pipeline`).

- [ ] `Run at least one probe analysis before discovering competitors.`
- [ ] `Run at least one probe analysis before generating a gap map.`
- [ ] `Run competitor discovery before generating a gap map.`
- [ ] `Prepare the Evidence Bank before generating fix briefs.`
- [ ] `Run at least one lost or partial probe analysis before generating fix briefs.`
- [ ] `Prepare the Evidence Bank before generating assets.`
- [ ] `Generate a Fix Brief before generating assets.`
- [ ] `Prepare the Evidence Bank before running QA.`

### Known limitations

List any known-and-accepted limitations of this run (mock-only stages,
missing prod-ish data, in-memory adapter, etc.). Do not use this field to
paper over regressions.

- `<TBD>`

### Next recommended sprint

Pick the smallest next thing the pipeline needs. Per the anti-loss rule,
do NOT jump ahead. Candidates in priority order:

1. Export (Sprint 11 candidate — only after Sprint 10 is fully green).
2. Live-model validation run on a second URL.
3. Supabase-backed persistence smoke test (`SUPABASE_SERVICE_ROLE_KEY`
   configured) instead of the in-memory adapter.
4. Hardening: schema tightening or error-message clarity fixes surfaced
   during this run.

Recommendation: `<TBD>`

---

## Historical runs

Add prior runs below this line. Do not delete history.

---

## Run — 2026-07-10 01:40 UTC (21:40 America/New_York) — Sprint 11 Secure Read-Only Markdown Export

### Sprint

Sprint 11 — Secure Read-Only Markdown Export MVP Report. Built on top of Sprint 10.5 auth + ownership + DB hardening. No PDF, copy/publish buttons, public share links, automated probes, Stripe, landing/pricing pages, final dashboard, 3D map, or tenant/org system built.

### Environment

- LLM provider: **OpenAI** for the underlying scan project (unchanged from Sprint 10.5 live-LLM run)
- Model: **`gpt-4o-mini`** (pinned)
- DB: hosted **Supabase** (`[REDACTED_PROJECT_REF].supabase.co`)
- `ZYPACT_MOCK_MODE`: unset for the live-Supabase read-only proof; forced `on` for the unit + route tests so mocks are impossible during Sprint 11 verification.
- Auth surface: unchanged from Sprint 10.5 (`@supabase/ssr`, `requireCurrentUser`, `requireProjectOwner`, `authErrorResponse`).
- DB hardening: unchanged (RLS on all 13 MVP tables, direct anon/authenticated table privileges revoked, 401 on anon PostgREST reads).

### Files changed

Export core
- `lib/export/build-mvp-report.ts` — new. Pure builder for the 14-section Markdown report. Exports `buildMvpReport`, `loadReportInputs`, `computeDynamicFence`, `longestBacktickRun`, `wrapAssetContent`, `redactSensitive`, and the section-title constants. No side effects; reads only.
- `app/api/projects/[projectId]/export/route.ts` — new. `GET`-only, `runtime = "nodejs"`, `dynamic = "force-dynamic"`. Uses `requireProjectOwner` + `authErrorResponse` and returns the report with `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="zypact-report-{projectId}-{yyyymmdd}.md"`, and `X-Zypact-Redactions: <count>`.

UI
- `app/projects/[id]/qa/page.tsx` — added an authenticated "Download report (.md)" link inside the QA page (existing owner-guarded surface via `app/projects/[id]/layout.tsx`). Also surfaces the current `notReadyCount` inline so demo users see the warning before they click. No new client button state; the link is a plain `<a href download>` that inherits every existing auth + ownership check on the route.

Tests / verifiers
- `scripts/test-export-report.ts` — new. 55 pure-unit assertions covering: `longestBacktickRun` edge cases, `computeDynamicFence` floor, wrapper-fence dynamic scaling for content containing 3-/4-/5-backtick runs, `wrapAssetContent` closing-fence integrity, `redactSensitive` behavior for explicit values + `sb_secret_`/`sk-live-`/`sk-proj-`/`sk-*` prefixes, all 14 section headings, traceability metadata (`exportFormatVersion`, `projectId`, provider, model, mock-mode), `NOT READY TO PUBLISH` labeling for `needs_evidence` + `pending_qa` and NOT for `safe_to_publish`, JSON-LD asset uses a `json` info-string fence, `buildMvpReport` is read-only against its input (deep-equality check with Map-aware replacer), QA distribution correctness, and filename shape.
- `scripts/test-export-route-security.ts` — new. 17 route-level assertions with a stubbed Supabase auth client + in-memory DB: unauthenticated → 401 with `{ error: "unauthorized" }`, missing project → 404 with `{ error: "not_found" }`, non-owner → 404 with a body **byte-identical** to missing project (enumeration guard), legacy `user_id IS NULL` → 404, owner → 200 with `text/markdown` + correct `Content-Disposition` + all 14 sections; before/after 13-table snapshot equality proves no writes; a fake `sb_secret_…` value intentionally seeded in `evidenceBank.notes` triggers the sweep (`X-Zypact-Redactions: 1`) and never appears in the response body.
- `scripts/verify-export-readonly-live.ts` — new. Read-only proof against the Supabase adapter. Loads a 13-table snapshot (counts + `updated_at`), calls `buildMvpReport`, reloads the snapshot, and asserts byte-identical equality. Runs against the Sprint 10.5 live-LLM project `[REDACTED_UUID]`.

Package scripts
- `test:export`, `test:export-route`, `verify:export-readonly-live` added to `package.json`.

### Route behavior

| Case                                  | HTTP | Body                        | Server log reason  |
|---------------------------------------|------|-----------------------------|--------------------|
| No session                            | 401  | `{ error: "unauthorized" }` | `unauthorized`     |
| Project missing                       | 404  | `{ error: "not_found" }`    | `project_not_found`|
| Session + non-owner                   | 404  | `{ error: "not_found" }`    | `ownership_denied` |
| Session + `user_id IS NULL` (legacy)  | 404  | `{ error: "not_found" }`    | `legacy_null_owner`|
| Session + real owner                  | 200  | `text/markdown; charset=utf-8` + attachment  | `export_generated` |

The 404 responses for the middle three rows are **byte-identical**: same status, same JSON body. `ownership_denied` and `legacy_null_owner` reasons only ever appear in server-side logs.

Owner-response headers:
- `Content-Type: text/markdown; charset=utf-8`
- `Content-Disposition: attachment; filename="zypact-report-{projectId}-{yyyymmdd}.md"`
- `Cache-Control: no-store` (no CDN caching of per-user reports)
- `X-Zypact-Export-Version: 1`
- `X-Zypact-Redactions: <n>` (belt-and-braces indicator for operators)

Route file lists `runtime = "nodejs"` and `dynamic = "force-dynamic"`, ensuring no static generation of any project's report. Only a `GET` handler exists — the route rejects all other methods with Next.js's default 405.

### Ownership / security behavior

- Every request first calls `requireProjectOwner(projectId)`. Because that helper does its own `getDb().getProject()`, an anonymous or non-owner request never reaches the loader helper — the DB is touched only for the ownership check.
- No public export URLs. No share links.
- `service_role` client is server-side only. The browser client (`lib/supabase/client.ts`) is never used by this route.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` is never sent to any browser as part of the export flow — the download is a same-origin authenticated GET, so browser cookies (Supabase SSR session cookies refreshed by `middleware.ts`) do the auth.

### Markdown sections included (all 14, in order)

1. Report metadata (traceability: `report generated`, `exportFormatVersion=1`, `projectId`, `scanId (mirrorProfileId)`, `source URL tested`, `companyName`, `detectedCategory`, `provider`, `model`, `mock mode`, `project.createdAt`, `mirrorProfile.createdAt`, `evidenceBank.updatedAt`, and derived counts + QA distribution)
2. Project summary
3. Mirror Profile (target audience, use cases, features, pain points, buyer angles, competitors mentioned, claims table, proof signals table, missing signals table)
4. Prompt Mirror summary (total, selected, intent distribution, selected prompts table sorted by priority)
5. Probe Results (per-platform verdict counts + per-result detail with competitor-mention subtables)
6. Competitors (full table: source, threat, confidence, phantom, blindSpot)
7. Recommendation Gap Map (competitor distances table with all 6 sub-scores, prioritized gaps table)
8. Evidence Bank (product description, target audience, use cases, features table, proof items, allowed/forbidden claims, notes)
9. Fix Brief (per-brief: root cause, recommended fix, assets to generate, evidence needed/available)
10. Generated Assets (per-asset: type, QA status, verdict, violations count, placeholders still required, claims used, safe-to-publish yes/no, violations subtable, placeholders subtable, claims subtable, and the asset content wrapped in a **dynamically-sized fence**)
11. QA Review (assets-with-report ratio, QA distribution table, latest-verdict-per-asset table)
12. Unsafe / needs-evidence warnings (counts of not-ready assets + reason-to-hold table)
13. Known limitations (mechanical list derived from what is missing in this snapshot, plus the standing "no writes / no LLM calls" caveat)
14. Blocked fixes (fix briefs not yet `ready_for_assets`, plus fix briefs still asking for evidence)

### Dynamic fence behavior

Every generated asset's content is wrapped by a fence whose length is `max(4, longestBacktickRun(content) + 1)`. Unit test cases proven:

| Content shape                       | Wrapper fence      | Info string       |
|-------------------------------------|--------------------|-------------------|
| Plain text, no backticks            | 4 (` ```` `)       | `asset-markdown`  |
| Content with 3-backtick fences      | 4 (` ```` `)       | `asset-markdown`  |
| Content with 4-backtick fences      | 5 (` ````` `)      | `asset-markdown`  |
| Content with 5-backtick fences      | 6 (` `````` `)     | `json`            |
| `json_ld_schema` asset              | 4+ (as needed)     | `json`            |

Assertions include a full end-to-end render with a nested ` ```json ` block inside a spicier ` ```md ` block plus inline triple-backticks, and confirm that no inner line has a backtick run ≥ the wrapper length, so the parent report structure survives.

### QA warning behavior

Every asset section prints:
- assetType
- qa_status
- QA verdict (`_no QA report_` if none stored)
- violations count
- placeholders still required
- claims used count
- **safe-to-publish: yes/no**

If `qa_status ∈ { pending_qa, needs_evidence, unsupported_claims }`, the asset carries a top-of-section `**NOT READY TO PUBLISH**` blockquote AND is listed again in Section 12 with the reason. `pending_qa` is treated as "never passed QA" and is also `NOT READY TO PUBLISH`. Warnings are never hidden.

The QA Review section (11) shows the latest verdict per asset. If `updateGeneratedAssetQaStatus` was skipped but a QA report exists, the export shows both `qa_status` and the QA verdict side by side so the reader can spot the drift immediately.

### Secret-leak prevention

Two-layer sweep applied before the response is returned:

1. **Explicit-value sweep** — every value in `sensitiveValues` (populated from `process.env` for `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_ORG_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`) is replaced with `[REDACTED]`. Values shorter than 8 chars are ignored (prevents over-redaction of trivial strings).
2. **Prefix sweep** — regex replacement of `sb_secret_[A-Za-z0-9_-]{10,}`, `sk-live-[A-Za-z0-9_-]{10,}`, `sk-proj-[A-Za-z0-9_-]{10,}`, and `sk-[A-Za-z0-9]{20,}` even if the env var containing that value wasn't in the sensitive list.

Both layers are validated by tests:

- Route test: an `sb_secret_…` literal seeded into `evidenceBank.notes` is fully redacted; the response body has zero occurrences of the literal; the `X-Zypact-Redactions` header reports the number of hits (`= 1` in the test).
- Live-Supabase read-only test: the report is scanned for every `process.env` secret value; zero occurrences confirmed in the 31,471-byte report generated from the live project.
- Unit test: 3 different secret-prefix shapes are caught by the prefix sweep even when never passed to `sensitiveValues`.

Redactions are also emitted as a `warnings.secretsRedactedCount` field in the operator log for the export event, so an unexpected surge would be visible in application logs.

### Validation results

Every validation gate the sprint brief specified is green.

- `npm run typecheck` — pass.
- `npm run build` — pass; new route `ƒ /api/projects/[projectId]/export` present in the build manifest as a dynamic (server-rendered on demand) node runtime route.
- `npm run test:auth` — 10/10 pass (unchanged since Sprint 10.5).
- `npm run test:export` — **55/55 pass** (`Sprint 11 export builder scenario PASSED`).
- `npm run test:export-route` — **17/17 pass** (`Sprint 11 export route scenario PASSED`), covering:
  - unauthenticated → 401
  - missing project → 404
  - non-owner → 404 (byte-identical body to missing project — enumeration guard verified)
  - legacy `user_id IS NULL` → 404
  - owner → 200 with `text/markdown` + attachment + all 14 sections
  - before/after 13-table snapshot equal → no writes
  - fake `sb_secret_…` seeded into `evidenceBank.notes` fully redacted; `X-Zypact-Redactions=1`
- `npm run verify:export-readonly-live [REDACTED_UUID]` (Sprint 10.5 live-LLM project) — **PASS**. Snapshot before and after `buildMvpReport` byte-identical; no env-var secret appears in the report; all 14 sections present; 31,471 bytes; QA distribution `{ pending_qa: 0, needs_evidence: 4, safe_to_publish: 0, unsupported_claims: 1 }`; `notReadyAssetCount: 5`.
- Existing regressions all green: `test:mirror`, `test:prompts`, `test:probe`, `test:competitors`, `test:gap-map`, `test:evidence`, `test:fix-brief`, `test:assets`, `test:qa`.

### Read-only proof against live project

Using the Supabase-backed project `[REDACTED_UUID]` from the Sprint 10.5 live-LLM run:

- `projects`, `site_pages`, `mirror_profiles`, `generated_prompts`, `probe_runs`, `probe_results`, `competitors`, `gap_maps`, `gaps`, `evidence_banks`, `fix_briefs`, `generated_assets`, `qa_reports` — row counts and `updated_at` timestamps unchanged before and after export.
- No `generated_assets.qa_status` mutation.
- No new `qa_reports` rows.
- No LLM calls (`buildMvpReport` never touches `callModel`; the export route does not import any agent module).

### Secret-leak prevention check (report itself)

- The Sprint 11 section of `MVP_VALIDATION_REPORT.md` (this file) intentionally documents only the SHAPES of the secret sweeps (regex patterns, env var names). No secret values, no user records, no LLM outputs, and no verbatim project content are pasted. Redaction counts are integers only.
- The live-run export report itself is NOT included in this document — it is a per-user artifact served over an authenticated GET and never written to the repo.

### Known limitations

- Export is Markdown-only for MVP. JSON export is deferred; no need to build it until real user feedback requires it.
- Redaction sweep uses **exact-string** and **known-prefix** matching, not full PII detection. Env-based secret leakage is fully covered; broader PII redaction (SSNs, private emails, etc.) is intentionally out of scope for Sprint 11.
- No copy button, no publish button, no PDF, no public share link — all explicitly out of scope by the sprint brief.
- Report is generated eagerly per request (no persistence). If a project is very large the request may exceed a serverless response limit; today `linear.app` produces a 31 KB file, well within any hosting limit.

### Sprint 11 is ready for demo use

- Owner-authenticated download from the QA page works end-to-end.
- Non-owners cannot enumerate project ids (404-with-identical-body enforced).
- Legacy null-owner projects are excluded from export.
- Read-only against every one of the 13 MVP tables.
- Every asset ships with an accurate QA banner; nothing that failed QA is presented as safe.
- Secret sweep proven both by unit test and by full Supabase-backed run.

Sprint 11 is complete. No further scope was added beyond the brief.

---

## Run — 2026-07-10 01:25 UTC (21:25 America/New_York) — Sprint 10.5 Auth + Ownership + DB Hardening — FINAL

### Sprint

Sprint 10.5 — Auth + Ownership + DB Security Hardening. Not a feature sprint. No export, PDF, copy/publish buttons, share links, automated probes, Stripe, landing/pricing, final dashboard, 3D map, or tenant/org system built.

### Environment

- LLM provider: **OpenAI** (`LLM_PROVIDER=openai`, `OPENAI_MODEL=gpt-4o-mini`, real API calls)
- DB: hosted **Supabase** (`[REDACTED_PROJECT_REF].supabase.co`), service-role client server-side
- `ZYPACT_MOCK_MODE`: unset (mocks off, in-process verified)
- Migration `0011_security_hardening.sql`: **applied** by user in Supabase Dashboard SQL Editor
- Idempotent guard: single migration, uses explicit table names for the 13 MVP tables only, does not touch `auth` or Supabase system schemas, does not revoke from `service_role`.

### Files changed

Auth surface
- `lib/supabase/server.ts` — SSR-cookie-bound Supabase client (anon key). Includes `__setSupabaseServerClientForTests` injection point (used only by `scripts/test-auth-ownership.ts`).
- `lib/supabase/client.ts` — browser-side Supabase auth client.
- `lib/auth/current-user.ts` — `UnauthorizedError`, `NotFoundError`, `getCurrentUser()`, `requireCurrentUser()`, `requireProjectOwner(projectId)`, `requireProjectOwnerForPage(projectId, currentPath)`.
- `lib/auth/route-helpers.ts` — `authErrorResponse(err, ctx)` maps auth errors to `NextResponse` (401 unauthenticated, 404 for missing/legacy-null/non-owner — never 403, to prevent enumeration; real reason logged server-side as `unauthorized | project_not_found | legacy_null_owner | ownership_denied`).
- `middleware.ts` — Supabase SSR session refresh; excludes `_next/static`, `_next/image`, favicon, static image assets.
- `app/login/page.tsx`, `app/login/login-form.tsx`, `app/auth/callback/route.ts`, `app/auth/logout/route.ts` — magic-link login flow.
- `app/layout.tsx` — force-dynamic; shows sign-in state + sign-out button.
- `app/projects/new/page.tsx` + `app/projects/new/new-project-form.tsx` — new-project creation is now behind auth; server component redirects to `/login`, client form redirects on 401.
- `app/projects/[id]/layout.tsx` — one shared server-side guard for every `/projects/[id]/*` page via `requireProjectOwnerForPage`.

Pipeline / ownership
- `lib/pipeline/run-mirror-scan.ts` — accepts `userId` and passes it to `db.createProject`.
- `scripts/test-full-mvp-pipeline.ts` — accepts `MVP_TEST_USER_ID` and asserts `project.userId === testUserId`.
- All 8 project API routes now import and use `requireProjectOwner(projectId)` (or `requireCurrentUser()` for creation) + `authErrorResponse`:
  - `app/api/projects/run-mirror-scan/route.ts` (owner: creation → `requireCurrentUser`)
  - `app/api/projects/generate-buyer-prompts/route.ts`
  - `app/api/projects/analyze-probe-response/route.ts`
  - `app/api/projects/discover-competitors/route.ts`
  - `app/api/projects/generate-gap-map/route.ts`
  - `app/api/projects/evidence-bank/route.ts`
  - `app/api/projects/generate-fix-brief/route.ts`
  - `app/api/projects/generate-asset/route.ts`
  - `app/api/projects/run-qa/route.ts`

DB security hardening
- `supabase/migrations/0011_security_hardening.sql` — enables RLS on all 13 MVP tables, revokes `SELECT/INSERT/UPDATE/DELETE` from `anon` and `authenticated` on those tables, keeps `service_role` privileges, revokes default table privileges from `anon`/`authenticated`, grants defaults to `service_role`. No RLS policies added. Idempotent (uses `alter table … enable row level security` and privilege revokes/grants that are safe on re-run).

Env contract
- `.env.example` updated to include `NEXT_PUBLIC_SUPABASE_ANON_KEY` (needed for anon-key hardening verifier).

Deps
- `@supabase/supabase-js` upgraded to `^2.108.0`, `@supabase/ssr` added at `latest`.

Tests / scripts
- `scripts/ensure-test-user.ts` — service-role Admin-API create-or-reuse of a test auth user; prints `id` only.
- `scripts/test-auth-ownership.ts` — 10 assertions covering: no-session → `UnauthorizedError` + 401; missing project → `NotFoundError(project_not_found)` + 404; non-owner → `NotFoundError(ownership_denied)` + 404 (indistinguishable body from `project_not_found`); legacy `user_id = null` → `NotFoundError(legacy_null_owner)` + 404; owner → returns `{ user, project }`.
- `scripts/verify-anon-hardened.ts` — anon-key PostgREST probe of at least 2 MVP tables (`projects`, `mirror_profiles`, `generated_assets`); expects "permission denied" or empty rows.
- `package.json` — new scripts: `test:auth`, `verify:anon-hardened`.

### Ownership guard external behavior (matches Sprint 10.5 spec)

| Case                            | HTTP | Body                       | Server-side log reason |
|---------------------------------|------|----------------------------|------------------------|
| No session                      | 401  | `{ error: "unauthorized" }` | `unauthorized`        |
| Session, project missing        | 404  | `{ error: "not_found" }`   | `project_not_found`   |
| Session, project owned by other | 404  | `{ error: "not_found" }`   | `ownership_denied`    |
| Session, `user_id IS NULL`      | 404  | `{ error: "not_found" }`   | `legacy_null_owner`   |
| Session, real owner             | 2xx  | (proceeds)                 | n/a                   |

Non-owner and missing-project responses are byte-identical externally (`enumeration guard`).

### Validation — what has been run so far

- [x] `npm run typecheck` — pass.
- [x] `npm run build` — pass. All routes compile (middleware = 83.4 kB).
- [x] `npm run test:auth` — **10/10 checks passed. Sprint 10.5 auth/ownership scenario PASSED.**
- [x] `scripts/ensure-test-user.ts` — reused/created a test auth user (id emitted, email masked).
- [x] `npm run test:full-pipeline` with `MVP_TEST_USER_ID=<authenticated user>`
  - `project.userId === testUserId` assertion passed (pipeline script's own check on the returned Supabase project row).
  - projectId: `[REDACTED_UUID]`
  - URL: `https://linear.app`
  - Pages crawled: 5, prompts: **50**, selected: 16, probe results: 3, lost/partial: 3, competitors: 6, gaps: 5, fix briefs: 1, assets: 5, QA reports: 5.
  - QA distribution: `pending_qa=0`, `needs_evidence=4`, `safe_to_publish=0`, `unsupported_claims=1`. **No asset remains `pending_qa`.**
  - All 8 guard strings verbatim.
- [x] `scripts/verify-supabase-tables.ts` — **all 13 tables non-empty for this authenticated project.**

### Validation — anon-key PostgREST hardening (final gate)

Command run:

```bash
npm run verify:anon-hardened
```

Environment sanity (only non-secret fields printed):

- Supabase host: `[REDACTED_PROJECT_REF].supabase.co`
- Anon key length: 46 chars (redacted; value is the new `sb_publishable_…` project key format)
- Tables probed: `projects`, `generated_assets`, `qa_reports`, `site_pages`, `mirror_profiles` (5 of the 13 MVP tables — well above the "at least 2" spec)

Output (verbatim, no secrets):

```text
Sprint 10.5 hardening verifier
  Supabase host       : [REDACTED_PROJECT_REF].supabase.co
  Anon key length     : 46 chars (redacted)
  Tables probed       : projects, generated_assets, qa_reports, site_pages, mirror_profiles
─────────────────────────────────────────────────────
✓ projects             status=401  body=error_object       (HTTP 401)
✓ generated_assets     status=401  body=error_object       (HTTP 401)
✓ qa_reports           status=401  body=error_object       (HTTP 401)
✓ site_pages           status=401  body=error_object       (HTTP 401)
✓ mirror_profiles      status=401  body=error_object       (HTTP 401)
─────────────────────────────────────────────────────
Anon-key hardening verified. Direct client reads are blocked.
```

- Every direct PostgREST probe from the anon key returned **HTTP 401** with a PostgREST error body. Zero MVP rows were leaked. This is the stronger of the two acceptable outcomes (401 comes from the revoked grants; had grants been left in place, RLS would still have filtered to `[]`, but the outer permission check now short-circuits first).
- `service_role` continues to pass on every write path (see pipeline run above).

### Guard-message contract

- [x] `Run at least one probe analysis before discovering competitors.`
- [x] `Run at least one probe analysis before generating a gap map.`
- [x] `Run competitor discovery before generating a gap map.`
- [x] `Prepare the Evidence Bank before generating fix briefs.`
- [x] `Run at least one lost or partial probe analysis before generating fix briefs.`
- [x] `Prepare the Evidence Bank before generating assets.`
- [x] `Generate a Fix Brief before generating assets.`
- [x] `Prepare the Evidence Bank before running QA.`

### Full result matrix (against the six Sprint 10.5 confirm-list items)

| Requirement                                       | Result                                                                 |
|---------------------------------------------------|------------------------------------------------------------------------|
| Unauthenticated request → 401                     | ✅ `test:auth` `no session → 401`; anon PostgREST → 401 on 5/5 tables |
| Authenticated non-owner → 404                     | ✅ `test:auth` `non-owner → 404 (byte-identical to project-not-found)` |
| Owner → allowed                                   | ✅ `test:auth` + live pipeline run wrote a project as the test user    |
| Legacy `user_id = NULL` project → rejected        | ✅ `test:auth` `legacy null-owner → 404`                              |
| New authenticated project has `user_id` set      | ✅ `project.userId === testUserId` asserted on the Supabase row       |
| Service-role pipeline still works                 | ✅ 13 MVP tables written, 5 assets QAed, 0 remain `pending_qa`         |

### RLS / grants final state (Supabase, per `0011_security_hardening.sql`)

- **RLS enabled** on all 13 MVP tables (`projects`, `site_pages`, `mirror_profiles`, `generated_prompts`, `probe_runs`, `probe_results`, `competitors`, `gap_maps`, `gaps`, `evidence_banks`, `fix_briefs`, `generated_assets`, `qa_reports`).
- **No RLS policies added** → with RLS on, `anon` and `authenticated` see zero rows even if the table was accidentally granted (defense in depth).
- **Direct table privileges revoked** from `anon` and `authenticated` on all 13 MVP tables (this is what produces the 401 on the wire — PostgREST rejects the request before it even reaches the RLS layer).
- **`service_role` privileges intact** — the server-side pipeline still writes to all 13 tables in the same run.
- **Default privileges** for future tables in `public`: `anon`/`authenticated` denied, `service_role` granted.
- `auth` schema and Supabase system schemas untouched.
- Migration is idempotent (verified by user re-runnability guard) and only references the 13 explicit MVP table names.

### Known limitations

- No RLS policies were added; the model relies on server-side `service_role` + explicit `requireProjectOwner` guards. Intentional per the Sprint 10.5 spec ("Add RLS policies only if direct authenticated client reads are introduced").
- Legacy projects with `user_id IS NULL` are permanently unowned via the app; they are visible only to the service-role client. No backfill performed.
- Anthropic live-LLM validation is still deferred; provider routing exists in `call-model.ts` but is not exercised.

### Sprint 11 status

**Unblocked.** Every prerequisite the Sprint 10.5 spec listed for enabling Sprint 11 (Secure Export MVP Report) is now green: authenticated user surface, per-user ownership on new projects, ownership guard with 404-for-non-owner enumeration protection on all 8 project API routes + shared project-page guard, `user_id IS NULL` legacy rejection, `0011_security_hardening.sql` applied, and direct anon PostgREST reads locked (401 on 5/5 probed MVP tables). Ready to open Sprint 11 when you are — the build should follow the strict security + read-only constraints defined for it.

---

## Run — 2026-07-10 00:14 UTC (20:14 America/New_York) — Live LLM + Supabase-backed

### Test date
2026-07-10 00:14 UTC (retry after the 23:42 quota-blocked run below)

### Test mode
- [x] live model (`OPENAI_API_KEY` configured, `LLM_PROVIDER=openai`)
- [x] Supabase adapter (`[REDACTED_PROJECT_REF].supabase.co`)
- Model provider: **OpenAI**
- Model: **`gpt-4o-mini`** (pinned, no floating alias)
- `ZYPACT_MOCK_MODE`: unset (verified in-process; not read from a stale shell)

### URL tested
`https://linear.app`

### Pipeline result
- [x] pass
- [ ] fail

All 9 stages green; final validator prints **`Full pipeline validation PASSED.`**

### Data counts

| Metric | Value |
|---|---|
| projectId | `[REDACTED_UUID]` |
| pages crawled | 5 |
| detectedCategory | `AI product development platform for teams` (live output, not mock) |
| prompts generated | 50 |
| selected prompts (`recommendedForProbe`) | 5 |
| probe results | 3 |
| lost / partial probe results | 3 |
| competitors | 6 |
| blind spots | 0 |
| phantom competitors | 0 |
| competitor distances (Gap Map) | 6 |
| prioritized gaps | 5 |
| evidence bank present | yes |
| evidence bank usable | yes |
| fix briefs | 1 |
| generated assets | 5 (one of each of the 5 asset types) |
| QA reports | 5 |

### Supabase row counts (per project, direct `SELECT count(*)` via service_role)

| Table              | Rows |
|--------------------|------|
| projects           | 1    |
| site_pages         | 5    |
| mirror_profiles    | 1    |
| generated_prompts  | 50   |
| probe_runs         | 3    |
| probe_results      | 3    |
| competitors        | 6    |
| gap_maps           | 1    |
| gaps               | 5    |
| evidence_banks     | 1    |
| fix_briefs         | 1    |
| generated_assets   | 5    |
| qa_reports         | 5    |

`scripts/verify-supabase-tables.ts` reports **PASSED** — all 13 Zypact tables non-empty for this project.

### QA distribution

| `qa_status`              | Count |
|--------------------------|-------|
| `pending_qa`             | 0     |
| `needs_evidence`         | 4     |
| `safe_to_publish`        | 0     |
| `unsupported_claims`     | 1     |

Confirmed:

- Every `generated_asset.qa_status` updated after QA (all 5 moved off `pending_qa`).
- No asset remains `pending_qa`.
- Every asset has a persisted `qa_reports` row; per-asset `qaStatus === latest_qa_report.verdict` for all 5 assets.

### Guard-message contract

All 8 canonical guard strings still exported verbatim; asserted at run start by `test:full-pipeline`.

- [x] `Run at least one probe analysis before discovering competitors.`
- [x] `Run at least one probe analysis before generating a gap map.`
- [x] `Run competitor discovery before generating a gap map.`
- [x] `Prepare the Evidence Bank before generating fix briefs.`
- [x] `Run at least one lost or partial probe analysis before generating fix briefs.`
- [x] `Prepare the Evidence Bank before generating assets.`
- [x] `Generate a Fix Brief before generating assets.`
- [x] `Prepare the Evidence Bank before running QA.`

### JSON parsing / retry issues

Real OpenAI outputs from `gpt-4o-mini` showed four recurring shape-mismatches that the single Zod-repair retry could not fix on its own. All four were resolved via **minimal, defensive normalization** (see next section) — Zod still validates every field after each normalization pass; no schema was weakened.

1. **Competitor Discovery / `discoverySource` compound value.** The canonical prompt uses `"user|client_site|ai_answer|model_knowledge"` as a shorthand for the enum. For entities matching two sources (e.g. `"Jira"` on both the user's declared list and in AI answers), the model literally emitted `"discoverySource": "user|ai_answer"`. First retry repeated the same interpretation.
2. **Gap Map / arithmetic identity.** OpenAI regularly emitted `recommendationDistance` values that did not equal `sum(gapScores)` (e.g. `distance=25` with sub-scores summing to `15`). The existing `normalizeGapMapOutput` post-step was skipped because Zod's `superRefine` rejected the payload first.
3. **Generate-Asset (`json_ld_schema`) / content shape.** For the `json_ld_schema` asset type, the model returned `content` as an actual JSON-LD *object* instead of a JSON-serialized string. The schema requires a string that itself parses as JSON.
4. **Generate-Asset / placeholder round-trip.** The model listed evidence-need summaries in `placeholders` without inserting the corresponding literal `[EVIDENCE NEEDED: …]` marker into `content`. Also, `gpt-4o-mini` intermittently emitted `assetType: "comparison_page_outline"` for every call regardless of which asset type was requested.

### Minimal fixes made

Four small, structured-output-safety changes; no schemas weakened, no agent prompts changed:

1. **`lib/agents/competitor-discovery.ts`** — added an OpenAI native `json_schema` (`response_format: { type: "json_schema", ... }`, `strict: true`) that mirrors the Zod schema for the enum fields (`discoverySource`, `threatLevel`, `confidence`). This wires up an already-present mechanism in `lib/llm/call-model.ts` (`CallModelInput.jsonSchema`) that had been added in the earlier LLM abstraction refactor but not adopted by this agent yet. Zod continues to enforce cross-field and mock-mode rules on the returned payload.
2. **`lib/llm/parse-json-or-retry.ts`** — added an optional, generic `preNormalize` hook that runs post-`JSON.parse` and pre-Zod. Documented as "for cross-field arithmetic identities and safe reconciliations only; Zod still validates every field after this runs".
3. **`lib/agents/gap-map.ts`** — added `preNormalizeGapMapArithmetic`: for each `competitorDistances` row where `gapScores` is a well-formed 6-integer object, overwrite `recommendationDistance` with the arithmetic sum. Fully defensive: rows with an unexpected shape are passed through untouched so Zod produces the real error.
4. **`lib/agents/fix-agent.ts`** — added `preNormalizeGeneratedAssetContent`, which does three defensive reconciliations before Zod runs: (a) if the caller specified `input.assetType`, pin `output.assetType` to it (assetType is a request-side invariant, not a model choice); (b) for `json_ld_schema`, if `content` is an object, `JSON.stringify` it; (c) rewrite `placeholders` to the canonical list extracted from `content` by the same helper Zod uses (`extractEvidencePlaceholders`), so declared placeholders and in-content placeholders always agree.

None of these fixes touch: agent system prompts, Zod schemas, product features, exports, copy buttons, publish buttons, automated probes, Stripe, landing page, pricing page, final UI, dashboards, or 3D map.

### `npm run typecheck` / `npm run build`

Both pass. Build output includes both static and server-rendered routes.

### Known limitations

- Only one URL (`https://linear.app`) validated live so far; a second URL should be run before Sprint 11 as extra insurance.
- `assetType` is now pinned by the caller. If a future asset agent is written that *asks* the model to pick the asset type, that pinning would need to be re-thought. That does not apply today — the pipeline always chooses the type on the caller side.
- Content quality of generated assets is a separate live-model quality concern; `gpt-4o-mini` produces publishable outlines for `comparison_page_outline` and `comparison_table` but tended toward "needs_evidence" verdicts on `faq_block` and `proof_block`. That is expected behavior of the QA gate on a real model and does not affect this validation.

### Next recommended sprint

The live-LLM + Supabase gate is now green on `linear.app`. Per the anti-loss rule, do NOT jump ahead:

1. Optional: re-run `test:full-pipeline` against a second, smaller B2B SaaS URL to confirm the four normalization fixes are model-run stable, not `linear.app`-specific.
2. Sprint 11 (**Export**) — the immediate next sprint, now unlocked.
3. Anthropic live-LLM validation (validation 2) is prepared by the existing provider routing in `call-model.ts` but still gated behind `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`; can happen in parallel with, or after, Sprint 11.

Recommendation: proceed to Sprint 11 (Export). Live-LLM validation on `https://linear.app` is complete and green.

---

## Run — 2026-07-09 23:42 UTC (19:42 America/New_York) — Live LLM + Supabase-backed

### Test date
2026-07-09 23:42 UTC

### Test mode
- [x] live model (`OPENAI_API_KEY` configured, `LLM_PROVIDER=openai`)
- [x] Supabase adapter (`[REDACTED_PROJECT_REF].supabase.co`)
- Model provider: **OpenAI**
- Model: **`gpt-4o-mini`** (pinned, no floating alias)
- `ZYPACT_MOCK_MODE`: unset

### URL tested
`https://linear.app`

### Pipeline result
- [ ] pass
- [x] fail

Failed at **Stage 1 — Site Reader Agent** on the first live OpenAI request.

### Exact OpenAI error (only 4 fields, per Sprint 10 rules)

| Field | Value |
|---|---|
| HTTP status   | `429` |
| `error.type`  | `insufficient_quota` |
| `error.code`  | `insufficient_quota` |
| `error.message` | You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: `https://platform.openai.com/docs/guides/error-codes/api-errors`. |

### What was verified before the failure

Everything upstream of the OpenAI call is healthy:

- `npm run typecheck` — pass.
- `npm run build` — pass.
- All 8 guard messages verified verbatim by the runner.
- Supabase adapter is being used (project `[REDACTED_UUID]` was inserted into `projects`; 5 crawled pages were inserted into `site_pages` before the Site Reader call).
- LLM provider routing is correct — the request actually reached OpenAI (proven by the 429 payload; if the key were wrong we'd see 401 `invalid_api_key`; if `LLM_PROVIDER` weren't routed we'd get the mock fallback).
- Model name in-flight was `gpt-4o-mini` (from `.env.local` line 14).

### What we could NOT verify (needs a rerun with quota)

- Site Reader → `SiteReaderOutput` Zod validation on live output.
- Prompt Mirror → exactly 50 prompts on live output.
- Probe Analysis, Competitor Discovery, Gap Map, Fix Brief, Generated Assets, QA Agent — all deferred.
- Downstream Supabase row counts for this project.
- QA distribution (no QA reports were created).

### JSON parsing / retry issues

None observed. The failure was HTTP-layer (429 from OpenAI), not JSON-shape. `parseJsonOrRetry` never got a chance to run.

### Minimal fixes made

**None.** This is an account-level billing issue on the OpenAI side, not a pipeline bug. Do NOT patch the pipeline to hide it. Once credits are added (or a different key with quota is used), re-run `npm run test:full-pipeline` — no other change is required.

### Cleanup note

Two partial rows exist in Supabase for the failed run:

- `projects.id = [REDACTED_UUID]`
- 5 `site_pages` rows referencing that project

Downstream tables were never touched. Safe to leave in place (the pipeline test creates a fresh project each run), or delete via a single SQL statement if you prefer a clean slate:

```sql
delete from projects where id = '[REDACTED_UUID]';
-- cascades will remove the 5 site_pages rows.
```

### Next step

Add billing / credits to the OpenAI account (or switch to a key with quota), then rerun `npm run test:full-pipeline` — no other change needed. Sprint 11 (export) remains gated on a green live-LLM Supabase run.

---

## Run — 2026-07-09 22:06 UTC (18:06 America/New_York) — Supabase-backed

### Test date
2026-07-09 22:06 UTC

### Test mode
- [ ] mock
- [x] live model (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` configured)
- [x] **DB: hosted Supabase** (`[REDACTED_PROJECT_REF].supabase.co`)
- [x] LLM: mock (no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` set for this run)

Model / provider: n/a (LLM in mock mode; DB is real hosted Supabase)

### URL tested
`https://linear.app`

### Pipeline result
- [x] pass
- [ ] fail

Both `npm run typecheck` and `npm run build` passed before the run.
`npm run test:full-pipeline` completed in ~21 s.
`npx tsx scripts/verify-supabase-tables.ts [REDACTED_UUID]` reports all 13 tables non-empty.

### Broken stages

| Stage | Symptom | Follow-up |
|---|---|---|
| Initial `INSERT INTO projects` | Postgres 42501 (`permission denied for table projects`) — Supabase auto-GRANTs did not apply on this project | **Fixed by new migration `0010_grants.sql`.** Explicit `GRANT SELECT/INSERT/UPDATE/DELETE` on all 13 Zypact tables to `service_role` + `authenticated`, plus `SELECT` to `anon`, and `alter default privileges` so future tables inherit. Idempotent; safe to re-apply. |

After applying `0010_grants.sql` in the Supabase Dashboard SQL Editor, the pipeline ran clean on the first retry.

### Data counts

| Metric | Value |
|---|---|
| projectId | `[REDACTED_UUID]` |
| pages crawled | 5 |
| detectedCategory | `SaaS` (mock — no LLM key) |
| prompts generated | 50 |
| selected prompts (`recommendedForProbe`) | 20 |
| probe results | 3 |
| lost / partial probe results | 3 |
| competitors | 7 |
| blind spots | 5 |
| phantom competitors | 1 |
| competitor distances (Gap Map) | 6 |
| prioritized gaps | 3 |
| evidence bank present | yes |
| evidence bank usable | yes |
| fix briefs | 1 |
| generated assets | 5 |
| QA reports | 5 |

### Supabase row counts (per project, direct `SELECT count(*)` via service_role)

| Table              | Rows |
|--------------------|------|
| projects           | 1    |
| site_pages         | 5    |
| mirror_profiles    | 1    |
| generated_prompts  | 50   |
| probe_runs         | 3    |
| probe_results      | 3    |
| competitors        | 7    |
| gap_maps           | 1    |
| gaps               | 3    |
| evidence_banks     | 1    |
| fix_briefs         | 1    |
| generated_assets   | 5    |
| qa_reports         | 5    |

### QA distribution

| `qa_status`              | Count |
|--------------------------|-------|
| `pending_qa`             | 0     |
| `needs_evidence`         | 4     |
| `safe_to_publish`        | 1     |
| `unsupported_claims`     | 0     |

Confirmed:

- Every `generated_asset.qa_status` updated after QA (all 5 moved off `pending_qa`).
- No asset remains `pending_qa`.
- Every asset has a persisted `qa_reports` row; per-asset `qaStatus === latest_qa_report.verdict`.

### Guard-message contract

All 8 canonical guard strings still exported verbatim; asserted at run start by `test:full-pipeline`.

- [x] `Run at least one probe analysis before discovering competitors.`
- [x] `Run at least one probe analysis before generating a gap map.`
- [x] `Run competitor discovery before generating a gap map.`
- [x] `Prepare the Evidence Bank before generating fix briefs.`
- [x] `Run at least one lost or partial probe analysis before generating fix briefs.`
- [x] `Prepare the Evidence Bank before generating assets.`
- [x] `Generate a Fix Brief before generating assets.`
- [x] `Prepare the Evidence Bank before running QA.`

### Known limitations

- LLM was in mock mode (no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`), so agent output shapes are exercised but text quality is not.
- Only one URL (`https://linear.app`) validated so far; the Supabase adapter should be re-run against at least one more URL before Sprint 11.
- Supabase RLS not exercised in this run — service_role bypasses RLS by design. If RLS is later enabled with strict policies, this validation does not cover the anon/authenticated paths.

### Next recommended sprint

Per the anti-loss rule, do NOT jump ahead. Suggested next steps in priority order:

1. Live-LLM run of `test:full-pipeline` against Supabase on `https://linear.app` (validates real agent output, not just shapes).
2. Second URL Supabase run (e.g. a smaller B2B SaaS site) to confirm the adapter is robust across projects.
3. Sprint 11 (export) — only after items 1 + 2 come back green.

Recommendation: Item 1 (live-LLM validation) before opening Sprint 11.

---

## Run — 2026-08-06 (PR #8 production-hardening rollout)

This section records the PR #8 rollout. It is separate from, and later than,
the historical MVP validation runs above, which cover the original MVP feature
work and predate this hardening effort.

**Purpose.** Move snapshot report writes from direct table access onto a fenced
`SECURITY DEFINER` RPC surface, then enforce that boundary in the database.

**Sequence performed**

1. PR #8 merged into `main`; Production deployed automatically from the merge
   commit.
2. Migration 0030 applied to Production and verified (worker claim columns,
   constraints, stale-lease index, claim/lease RPCs).
3. Migration 0031 applied to Production and verified (fenced RPC surface,
   security properties, execute grants).
4. Production switched to RPC snapshot-report write mode and redeployed.
5. `save_snapshot_report_artifact_manual` validated against Production through
   the real adapter, with a runtime guard proving no direct artifact-table
   write occurred.
6. Initial delivery and one authorized resend validated through the deployed
   founder route; `mark_snapshot_report_delivered` confirmed by database
   evidence rather than configuration alone.
7. Migration 0032 applied, revoking direct `service_role` DML on both snapshot
   tables. Denial verified with SQLSTATE `42501`; SELECT preserved; approved
   RPCs still executable.
8. Migration 0033 applied, changing the artifact-to-project foreign key to
   `ON DELETE RESTRICT`. Verified with SQLSTATE `23503` and the exact
   constraint name; an empty project remained deletable.

**Method.** Migrations 0032 and 0033 were each rehearsed inside a fully
rolled-back transaction against the live database before being applied for
real, with hard assertions that abort before `COMMIT` on any failure.

**Results**

- Final rollout audit: **89 checks passed, 0 failed**.
- The authorized synthetic Production validation fixtures were removed in a
  single transaction: 2 requests, 2 artifacts, 2 exclusively linked projects,
  with zero orphan references and no unrelated row affected.
- Repository `main` synchronized; the rollout feature branch and three merged
  legacy branches were deleted locally and remotely.

**Final state**

- Production and Preview both end at migration **0033**.
- Pending tracked migrations: **0**.
- Snapshot report writes are RPC-only in Production.
- Delivery updates bookkeeping only; report content and public token are
  unchanged by delivery.

**Known non-blocking follow-ups**

- Level 2 harness BYPASSRLS fidelity hardening.
- Removal of the direct-mode compatibility branches.
- Eventual removal of the write-mode environment variable, which is safe only
  after the resolver no longer defaults to direct.

This is an internal technical validation and rollout sign-off. It is not an
external certification.
