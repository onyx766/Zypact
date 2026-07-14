# Database Schema — Sprints 1, 2, 3, 4, 5, 6, 7 & 8

Sprints 1–8 use twelve tables. Everything else waits for later sprints.

If Supabase is configured we use Postgres via `@supabase/supabase-js`.
If not, `lib/db/adapter.ts` falls back to an in-memory store — the pipeline
still works end to end so we are never blocked on infra.

## Tables

### `projects`

| column       | type        | notes                              |
|--------------|-------------|------------------------------------|
| id           | uuid PK     | server-generated                   |
| user_id      | uuid NULL   | nullable for now (no auth yet)     |
| company_name | text NULL   | user-provided or filled by Agent 1 |
| domain       | text        | canonical hostname                 |
| category     | text NULL   | filled from Mirror Profile         |
| created_at   | timestamptz | default now()                      |

### `site_pages`

| column     | type        | notes                              |
|------------|-------------|------------------------------------|
| id         | uuid PK     |                                    |
| project_id | uuid FK     | → projects.id                      |
| url        | text        |                                    |
| title      | text        |                                    |
| content    | text        | cleaned text extract               |
| page_type  | text        | homepage / pricing / features / …  |
| created_at | timestamptz | default now()                      |

### `mirror_profiles`

| column     | type        | notes                                        |
|------------|-------------|----------------------------------------------|
| id         | uuid PK     |                                              |
| project_id | uuid FK     | → projects.id                                |
| json       | jsonb       | Site Reader output (schema in `/lib/schemas`)|
| created_at | timestamptz | default now()                                |

### `generated_prompts` (Sprint 2)

| column           | type        | notes                                        |
|------------------|-------------|----------------------------------------------|
| id               | uuid PK     |                                              |
| project_id       | uuid FK     | → projects.id                                |
| prompt           | text        |                                              |
| intent_type      | text        | see `IntentType` in prompt-mirror.schema.ts  |
| commercial_value | smallint    | 1..5, CHECK enforced                         |
| winnability      | smallint    | 1..5, CHECK enforced                         |
| priority         | smallint    | 1..25, CHECK enforced                        |
| rationale        | text        |                                              |
| selected         | boolean     | true if id was in `recommendedForProbe`      |
| created_at       | timestamptz | default now()                                |

Indexes: `(project_id)`, `(project_id, priority desc)`.

### `probe_runs` (Sprint 3)

| column     | type        | notes                                       |
|------------|-------------|---------------------------------------------|
| id         | uuid PK     |                                             |
| project_id | uuid FK     | → projects.id                               |
| platform   | text        | CHECK ∈ {perplexity, chatgpt, gemini}       |
| status     | text        | CHECK ∈ {pending, succeeded, failed}        |
| created_at | timestamptz | default now()                               |

Indexes: `(project_id)`.

### `probe_results` (Sprint 3)

| column                | type        | notes                                    |
|-----------------------|-------------|------------------------------------------|
| id                    | uuid PK     |                                          |
| probe_run_id          | uuid FK     | → probe_runs.id                          |
| project_id            | uuid FK     | → projects.id                            |
| generated_prompt_id   | uuid FK NULL| → generated_prompts.id (set null)        |
| prompt                | text        | buyer prompt that was asked              |
| platform              | text        | CHECK ∈ {perplexity, chatgpt, gemini}    |
| raw_response          | text        | the pasted AI answer                     |
| client_mentioned      | boolean     |                                          |
| client_position       | text        | CHECK ∈ {primary, listed, negative, absent} |
| competitors_mentioned | jsonb       | `[{name, position, context}]`            |
| sources_cited         | jsonb       | `[{source, type}]`                       |
| answer_summary        | text        | 2-sentence factual summary               |
| verdict               | text        | CHECK ∈ {won, partial, lost, not_relevant}|
| why_client_lost       | text        | required unless verdict ∈ {won, not_relevant} |
| created_at            | timestamptz | default now()                            |

Indexes: `(project_id)`, `(project_id, verdict)`, `(probe_run_id)`.

### `competitors` (Sprint 4)

| column           | type        | notes                                       |
|------------------|-------------|---------------------------------------------|
| id               | uuid PK     |                                             |
| project_id       | uuid FK     | → projects.id (ON DELETE CASCADE)          |
| name             | text        | display name (case-preserved)              |
| website          | text NULL   | model must not invent websites             |
| discovery_source | text        | CHECK ∈ {user, client_site, ai_answer, model_knowledge} |
| mention_count    | integer     | ≥ 0; ≥ 1 if `discovery_source='ai_answer'` |
| prompt_ids       | jsonb       | array of GeneratedPrompt ids               |
| threat_level     | text        | CHECK ∈ {high, medium, low}                |
| confidence       | text        | CHECK ∈ {verified, unverified}; must be `unverified` if `discovery_source='model_knowledge'` |
| is_phantom       | boolean     | user-declared but never seen in AI answers |
| is_blind_spot    | boolean     | AI-recommended but not in user list nor mirror |
| created_at       | timestamptz | default now()                               |
| updated_at       | timestamptz | default now()                               |

Indexes: `(project_id)`, `(project_id, threat_level)`,
`(project_id, is_phantom)`, `(project_id, is_blind_spot)`.

Writes go through `replaceCompetitorsForProject(projectId, rows)` — delete
followed by insert of the fresh set. Reads via
`getCompetitorsByProject(projectId)`.

### `gap_maps` (Sprint 5)

| column     | type        | notes                                              |
|------------|-------------|----------------------------------------------------|
| id         | uuid PK     |                                                    |
| project_id | uuid FK     | → projects.id (ON DELETE CASCADE)                 |
| json       | jsonb       | full `GapMapOutput` — nodes, edges, distances, prioritizedGaps |
| created_at | timestamptz | default now()                                      |

Indexes: `(project_id)`, `(project_id, created_at desc)`.

Writes are append-only (`saveGapMap`). `getLatestGapMap` returns the most
recent row per project. Numeric truth (`recommendationDistance`) is
normalized before the row is written.

### `gaps` (Sprint 5)

| column                  | type        | notes                                        |
|-------------------------|-------------|----------------------------------------------|
| id                      | uuid PK     |                                              |
| project_id              | uuid FK     | → projects.id (ON DELETE CASCADE)           |
| competitor_name         | text NULL   | reserved for a later sprint that attributes gaps to a specific competitor; Sprint 5 stores null |
| type                    | text        | e.g. `prompt_loss`, `citation`, `review`, ... |
| severity                | text        | CHECK ∈ {high, medium, low}                 |
| explanation             | text        | 1–3 sentence rationale                      |
| affected_prompts        | jsonb       | array of GeneratedPrompt ids                |
| suggested_fix_direction | text        | one-sentence hint for the future Fix Agent  |
| created_at              | timestamptz | default now()                               |

Indexes: `(project_id)`, `(project_id, severity)`.

Writes go through `replaceGapsForProject(projectId, rows)` — delete followed
by insert of the fresh prioritized set (max 5 per Sprint 5 spec).

### `evidence_banks` (Sprint 6)

One row per project (UNIQUE on `project_id`). This is the user-editable
safety layer that future Fix Agent, Asset Generator, and QA Agent must
consult before producing anything.

| column              | type        | notes                                        |
|---------------------|-------------|----------------------------------------------|
| id                  | uuid PK     |                                              |
| project_id          | uuid UNIQUE | → projects.id (ON DELETE CASCADE)           |
| product_description | text        | ≤ 2000 chars (DB CHECK mirrors Zod)          |
| target_audience     | jsonb       | array of strings                             |
| main_use_cases      | jsonb       | array of strings                             |
| features            | jsonb       | `[{ name, description }]`                    |
| proof_items         | jsonb       | `[{ type, detail, sourceUrl? }]`             |
| competitors         | jsonb       | array of strings                             |
| allowed_claims      | jsonb       | array of strings                             |
| forbidden_claims    | jsonb       | array of strings, `jsonb_array_length >= 3`  |
| tone                | text        | CHECK ∈ {plain, confident, technical, friendly, executive} |
| notes               | text        |                                              |
| created_at          | timestamptz | default now()                                |
| updated_at          | timestamptz | default now()                                |

Indexes: `(project_id)` (UNIQUE via the `unique` clause on the column).

Writes: `upsertEvidenceBank(projectId, input)` — Supabase uses `.upsert(...,
{ onConflict: 'project_id' })`; the memory adapter mirrors this semantic
(re-uses `id` and `createdAt`, bumps `updatedAt`). Reads:
`getEvidenceBankByProject(projectId)` returns `EvidenceBankRow | null`.

### `fix_briefs` (Sprint 7)

Many rows per project. One row per generated Fix Brief (`fix_brief` mode).
Sprint 7 does NOT yet materialize generated assets — that comes with the
deferred `generate_asset` mode.

| column                 | type        | notes                                        |
|------------------------|-------------|----------------------------------------------|
| id                     | uuid PK     |                                              |
| project_id             | uuid FK     | → projects.id (ON DELETE CASCADE)           |
| gap_id                 | uuid FK NULL| → gaps.id (ON DELETE SET NULL)              |
| probe_result_id        | uuid FK NULL| → probe_results.id (ON DELETE SET NULL)     |
| lost_prompt            | text        | the buyer prompt the client lost             |
| competitor_recommended | text        | competitor the AI recommended instead        |
| root_cause             | text        | ≤ 1000 chars (DB CHECK mirrors Zod)          |
| recommended_fix        | text        | one concrete page/block to publish           |
| fix_type               | text        | CHECK ∈ {comparison_page, faq_block, proof_block, comparison_table, schema} |
| assets_to_generate     | jsonb       | array of asset types, `jsonb_array_length >= 1` |
| evidence_needed        | jsonb       | array of strings — facts still to gather     |
| evidence_available     | jsonb       | array of strings — facts already in bank     |
| priority               | int         | CHECK BETWEEN 1 AND 5 (high=1 … low=5)       |
| expected_impact        | text        | honest, non-guaranteed sentence              |
| status                 | text        | CHECK ∈ {draft, needs_evidence, ready_for_assets} |
| created_at             | timestamptz | default now()                                |
| updated_at             | timestamptz | default now()                                |

Indexes: `(project_id)`, `(project_id, priority)`, `(project_id, status)`.

Writes: `saveFixBrief(projectId, input)` — append-only, one row per run.
The pipeline sets `status` deterministically:

- `evidence_needed` non-empty → `needs_evidence`
- otherwise → `ready_for_assets`

Reads: `getFixBriefsByProject(projectId)` (priority asc, created_at desc) and
`getFixBrief(id)`.

Product rule: nothing in `root_cause`, `recommended_fix`, or
`expected_impact` may contain a guarantee phrase (guaranteed rankings,
guaranteed AI mentions, "will rank in ChatGPT", "#1 platform", …). The
`FixBriefOutputSchema.superRefine` enforces this at write time; the DB
schema stores whatever the pipeline validated.

### `generated_assets` (Sprint 8)

Many rows per Fix Brief. One row per Fix Agent `generate_asset` call.
Sprint 8 always writes `qa_status='pending_qa'`; only the future QA Agent
may transition it.

| column         | type        | notes                                        |
|----------------|-------------|----------------------------------------------|
| id             | uuid PK     |                                              |
| project_id     | uuid FK     | → projects.id (ON DELETE CASCADE)           |
| fix_brief_id   | uuid FK     | → fix_briefs.id (ON DELETE CASCADE)         |
| asset_type     | text        | CHECK ∈ {comparison_page_outline, faq_block, proof_block, comparison_table, json_ld_schema} |
| title          | text        | non-empty (DB CHECK mirrors Zod)             |
| content        | text        | non-empty; Markdown or JSON-LD string        |
| placeholders   | jsonb       | array of every `[EVIDENCE NEEDED: …]` string appearing in content |
| claims_used    | jsonb       | `[{ claim, source: "evidence_bank" \| "mirror_profile" }]` |
| qa_status      | text        | CHECK ∈ {pending_qa, needs_evidence, safe_to_publish, unsupported_claims} — Sprint 8 always writes `pending_qa` |
| created_at     | timestamptz | default now()                                |
| updated_at     | timestamptz | default now()                                |

Indexes: `(project_id)`, `(fix_brief_id)`, `(project_id, qa_status)`.

Writes: `saveGeneratedAsset(projectId, input)` — append-only. Reads:
`getGeneratedAssetsByProject(projectId)`,
`getGeneratedAssetsByFixBrief(fixBriefId)`, `getGeneratedAsset(id)`.

Product rules:
- Sprint 8 stores every asset with `qa_status = "pending_qa"`.
- Sprint 9 mutates `qa_status` to the QA Agent's verdict via
  `updateGeneratedAssetQaStatus(assetId, qaStatus)`.
- Zod (`GeneratedAssetOutputSchema.superRefine`) enforces at write time
  that `title`, `content`, and each `claimsUsed[].claim` are free of
  Sprint-7 guarantee phrases, and that `placeholders` matches the
  `[EVIDENCE NEEDED: …]` set actually present in `content` (as sets).
- For `asset_type='json_ld_schema'`, `content` must parse as valid JSON.

### `qa_reports` (Sprint 9)

Many rows per Generated Asset. Append-only history of QA verdicts — one
row per QA run. Cross-referenced with `generated_assets.qa_status`, which
always reflects the latest verdict for a given asset.

| column                 | type        | notes                                    |
|------------------------|-------------|------------------------------------------|
| id                     | uuid PK     |                                          |
| project_id             | uuid FK     | → projects.id (ON DELETE CASCADE)       |
| generated_asset_id     | uuid FK     | → generated_assets.id (ON DELETE CASCADE) |
| verdict                | text        | CHECK ∈ {safe_to_publish, needs_evidence, unsupported_claims} |
| violations             | jsonb       | array of `{ type, quote, reason, suggestedFix }`; empty array allowed |
| placeholders_remaining | jsonb       | array of `[EVIDENCE NEEDED: …]` strings still present in the asset |
| overall_notes          | text        | non-empty (DB CHECK mirrors Zod)         |
| created_at             | timestamptz | default now()                            |

Indexes: `(project_id)`, `(generated_asset_id)`,
`(generated_asset_id, created_at desc)`.

Writes: `saveQaReport(projectId, input)` — append-only. Reads:
`getQaReportsByProject(projectId)`,
`getQaReportsByGeneratedAsset(generatedAssetId)`,
`getLatestQaReportForAsset(generatedAssetId)`.

Product rules:
- Verdict `safe_to_publish` is stored ONLY if `violations` is empty.
- Verdict `unsupported_claims` is stored ONLY if `violations` has ≥ 1 item.
- Verdict `needs_evidence` allows a mixed rule: either at least one
  `[EVIDENCE NEEDED: …]` placeholder remains, or every violation is a
  `quality`-only concern (no fabrication / forbidden claim / unsupported
  number / competitor risk / implied result).
- `[EVIDENCE NEEDED: …]` placeholders are LEGITIMATE and MUST live in
  `placeholders_remaining`; they are NEVER inserted as violations.
- After every QA run the pipeline also updates
  `generated_assets.qa_status` to the same verdict via
  `updateGeneratedAssetQaStatus`.

## SQL (Supabase migrations)

- `supabase/migrations/0001_init.sql` — Sprint 1 tables.
- `supabase/migrations/0002_generated_prompts.sql` — Sprint 2 table.
- `supabase/migrations/0003_probe_analysis.sql` — Sprint 3 tables.
- `supabase/migrations/0004_competitors.sql` — Sprint 4 table.
- `supabase/migrations/0005_gap_map.sql` — Sprint 5 tables.
- `supabase/migrations/0006_evidence_bank.sql` — Sprint 6 table.
- `supabase/migrations/0007_fix_briefs.sql` — Sprint 7 table.
- `supabase/migrations/0008_generated_assets.sql` — Sprint 8 table.
- `supabase/migrations/0009_qa_reports.sql` — Sprint 9 table.

Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

## Adapter contract

`lib/db/index.ts` exports `getDb()` returning:

```ts
createProject(input): Promise<Project>
updateProjectCategory(projectId, category): Promise<void>
saveSitePages(projectId, pages): Promise<void>
saveMirrorProfile(projectId, json): Promise<MirrorProfileRow>
getProject(id): Promise<Project | null>
getSitePages(projectId): Promise<SitePage[]>
getMirrorProfile(projectId): Promise<MirrorProfileRow | null>

// Sprint 2
replaceGeneratedPrompts(projectId, prompts): Promise<GeneratedPrompt[]>
getGeneratedPrompts(projectId): Promise<GeneratedPrompt[]>
getGeneratedPrompt(id): Promise<GeneratedPrompt | null>

// Sprint 3
createProbeRun(projectId, platform, status?): Promise<ProbeRun>
updateProbeRunStatus(id, status): Promise<void>
saveProbeResult(input): Promise<ProbeResult>
getProbeResultsByProject(projectId): Promise<ProbeResult[]>
getLostProbeResultsByProject(projectId): Promise<ProbeResult[]>

// Sprint 4
replaceCompetitorsForProject(projectId, competitors): Promise<Competitor[]>
getCompetitorsByProject(projectId): Promise<Competitor[]>

// Sprint 5
saveGapMap(projectId, gapMapJson): Promise<GapMapRow>
getLatestGapMap(projectId): Promise<GapMapRow | null>
replaceGapsForProject(projectId, gaps): Promise<Gap[]>
getGapsByProject(projectId): Promise<Gap[]>

// Sprint 6
upsertEvidenceBank(projectId, input): Promise<EvidenceBankRow>
getEvidenceBankByProject(projectId): Promise<EvidenceBankRow | null>

// Sprint 7
saveFixBrief(projectId, input): Promise<FixBriefRow>
getFixBriefsByProject(projectId): Promise<FixBriefRow[]>
getFixBrief(id): Promise<FixBriefRow | null>

// Sprint 8
saveGeneratedAsset(projectId, input): Promise<GeneratedAssetRow>
getGeneratedAssetsByProject(projectId): Promise<GeneratedAssetRow[]>
getGeneratedAssetsByFixBrief(fixBriefId): Promise<GeneratedAssetRow[]>
getGeneratedAsset(id): Promise<GeneratedAssetRow | null>

// Sprint 9
updateGeneratedAssetQaStatus(assetId, qaStatus): Promise<GeneratedAssetRow | null>
saveQaReport(projectId, input): Promise<QaReportRow>
getQaReportsByProject(projectId): Promise<QaReportRow[]>
getQaReportsByGeneratedAsset(generatedAssetId): Promise<QaReportRow[]>
getLatestQaReportForAsset(generatedAssetId): Promise<QaReportRow | null>
```

The Supabase implementation is behind a flag (`SUPABASE_SERVICE_ROLE_KEY`
present). Otherwise the in-memory implementation is used — good enough for
local dev and the Sprint 1 done criteria.
