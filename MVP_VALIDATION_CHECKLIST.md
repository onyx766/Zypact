# Zypact MVP — Validation Checklist

Sprint-by-sprint done-criteria for the Zypact MVP, plus the Sprint 10
end-to-end validation gate. This document is the audit surface: a sprint
is only closed when every checkbox in its section can be ticked.

> **Anti-loss rule.** Read this before starting any work:
>
> - Engine first.
> - Raw outputs second.
> - Design after real outputs.
> - Export after QA works.
> - Stripe after product value is proven.
> - 3D map later.
>
> Do not skip forward.

---

## Sprint 1 — Site Reader Agent (Mirror Scan)

- [ ] Website URL input works.
- [ ] Crawler runs and returns at least one page.
- [ ] Pages are wrapped in `<pages>` tags for the Site Reader Agent.
- [ ] Site Reader Agent runs against `SITE_READER_SYSTEM_PROMPT`.
- [ ] JSON parses and validates with `SiteReaderOutputSchema` (Zod).
- [ ] Mirror Profile is stored (`mirror_profiles` row).
- [ ] Raw Mirror Profile UI (`/projects/[id]/mirror`) displays the result.
- [ ] `missingSignals.length >= 3` (schema-enforced; no site is perfect).
- [ ] `lib/agent-prompts/site-reader.prompt.ts` matches the canonical
      Agent 1 prompt in `zypact-agent-prompts.md` verbatim.

## Sprint 2 — Prompt Mirror Agent

- [ ] Given an existing Mirror Profile, exactly **50** buyer prompts are
      generated (`GeneratedPromptOutputSchema.min(50).max(50)`).
- [ ] Each prompt has `intentType`, `commercialValue`, `winnability`,
      `priority`, `rationale`, `selected` (`recommendedForProbe`).
- [ ] Prompts are stored in `generated_prompts`; replay is idempotent
      (`replaceGeneratedPrompts`).
- [ ] Raw UI (`/projects/[id]/prompts`) displays all 50 prompts.
- [ ] `lib/agent-prompts/prompt-mirror.prompt.ts` matches the canonical
      Agent 2 prompt verbatim.

## Sprint 3 — Manual Probe Analysis Agent

- [ ] User can paste one raw AI answer per prompt + platform.
- [ ] Probe Analysis Agent returns validated JSON with
      `verdict ∈ {won, partial, lost, not_relevant}`, `clientMentioned`,
      `clientPosition`, `competitorsMentioned[]`, `sourcesCited[]`,
      `answerSummary`, `whyClientLost`.
- [ ] Result is stored in `probe_results` under a `probe_run` row.
- [ ] Raw UI (`/projects/[id]/probe`) accepts platform + prompt + raw
      answer and displays the analysis inline.
- [ ] Lost / partial results are retrievable via
      `getLostProbeResultsByProject`.
- [ ] Automated AI probe calls are **not** implemented (Agent 3 deferred).
- [ ] `lib/agent-prompts/probe-analysis.prompt.ts` matches the canonical
      Agent 4 prompt verbatim.

## Sprint 4 — Competitor Discovery Agent

- [ ] Refuses to run when zero probe results exist. Exact guard string:
      `"Run at least one probe analysis before discovering competitors."`
- [ ] Given ≥ 1 ProbeResults + Mirror Profile, produces validated JSON
      with `competitors[]`, `phantomCompetitors[]`, `blindSpots[]`,
      `threatLevel`, `discoverySource`, `confidence`, `mentionCount`,
      `promptIds`.
- [ ] Rows are stored in `competitors` with idempotent replace.
- [ ] Raw UI (`/projects/[id]/competitors`) lists competitors, phantoms,
      and blind spots.
- [ ] `lib/agent-prompts/competitor-discovery.prompt.ts` matches the
      canonical prompt verbatim.

## Sprint 5 — Gap Map Agent

- [ ] Refuses to run with either guard message, verbatim:
      `"Run at least one probe analysis before generating a gap map."` /
      `"Run competitor discovery before generating a gap map."`
- [ ] Given Mirror Profile + ProbeResults + Competitors, produces
      validated `GapMapOutput` with `competitorDistances[]`,
      `prioritizedGaps[]`, `nodes[]`, `edges[]`.
- [ ] `recommendationDistance` is deterministically normalized in code.
- [ ] Gap rows are stored in `gaps` (idempotent replace); the full JSON
      is stored in `gap_maps`.
- [ ] Raw UI (`/projects/[id]/gap-map`) displays the 2D matrix and the
      prioritized gaps table.
- [ ] `lib/agent-prompts/gap-map.prompt.ts` matches the canonical prompt
      verbatim.

## Sprint 6 — Evidence Bank

- [ ] Evidence Bank is user-editable (not an LLM agent).
- [ ] Prefill draft comes from the latest Mirror Profile (never invents
      proof).
- [ ] `EvidenceBankInputSchema` enforces:
      `forbiddenClaims.length >= 3`, non-empty feature names, valid
      `proofItems.sourceUrl` when present, `tone ∈ enum`.
- [ ] `hasUsableEvidenceBank` is used as the standard usability guard
      throughout downstream pipelines.
- [ ] Row stored in `evidence_banks` (upsert per project).
- [ ] Raw UI (`/projects/[id]/evidence-bank`) accepts edits and
      re-saves the whole payload.

## Sprint 7 — Fix Brief Agent (`fix_brief` mode)

- [ ] Refuses to run with either guard message, verbatim:
      `"Prepare the Evidence Bank before generating fix briefs."` /
      `"Run at least one lost or partial probe analysis before generating fix briefs."`
- [ ] Given a prioritized Gap + related ProbeResult + Mirror Profile +
      Evidence Bank, produces validated `FixBriefOutput` with
      `lostPrompt`, `competitorRecommended`, `rootCause`,
      `recommendedFix`, `fixType`, `assetsToGenerate[]`,
      `evidenceNeeded[]`, `evidenceAvailable[]`, `priority`,
      `expectedImpact`.
- [ ] `superRefine` rejects any Sprint-7 banned guarantee phrase in
      `rootCause` / `recommendedFix` / `expectedImpact`.
- [ ] `status` derives from `evidenceNeeded.length`:
      `needs_evidence` vs. `ready_for_assets`.
- [ ] Row stored in `fix_briefs`.
- [ ] Raw UI (`/projects/[id]/fix-briefs`) generates and displays briefs.
- [ ] Fix Agent prompt supports both modes but Sprint 7 calls with
      `<mode>fix_brief</mode>` ONLY.
- [ ] `lib/agent-prompts/fix-agent.prompt.ts` matches the canonical
      prompt verbatim.

## Sprint 8 — Fix Agent (`generate_asset` mode)

- [ ] Refuses to run with either guard message, verbatim:
      `"Prepare the Evidence Bank before generating assets."` /
      `"Generate a Fix Brief before generating assets."`
- [ ] Given a Fix Brief + Evidence Bank + Mirror Profile + an
      `assetType ∈ {comparison_page_outline, faq_block, proof_block,
      comparison_table, json_ld_schema}`, produces one validated
      `GeneratedAssetOutput`.
- [ ] `superRefine` rejects banned guarantee phrases in `title`,
      `content`, and each `claimsUsed[].claim`.
- [ ] For `assetType='json_ld_schema'`, `content` parses as valid JSON.
- [ ] Placeholder round-trip: every `[EVIDENCE NEEDED: …]` in `content`
      is declared in `placeholders`, and every declared placeholder
      appears in `content`.
- [ ] Row stored in `generated_assets` with `qa_status = "pending_qa"`.
- [ ] Raw UI (`/projects/[id]/assets`) generates per-type assets and
      displays a table of stored assets with expandable
      content / placeholders / claims.

## Sprint 9 — QA Agent

- [ ] Refuses to run with the guard, verbatim:
      `"Prepare the Evidence Bank before running QA."`
- [ ] Given a Generated Asset + Evidence Bank + Mirror Profile, produces
      validated `QaAgentOutput` with `verdict`, `violations[]`,
      `placeholdersRemaining[]`, `overallNotes`.
- [ ] Verdict / violations consistency is schema-enforced:
      - `safe_to_publish` ⇒ `violations.length === 0`.
      - `unsupported_claims` ⇒ `violations.length >= 1`.
      - `needs_evidence` ⇒ `placeholdersRemaining.length >= 1` OR
        violations are quality-only.
- [ ] `[EVIDENCE NEEDED: …]` placeholders live in
      `placeholdersRemaining` and are NEVER treated as violations.
- [ ] Every QA run appends a `qa_reports` row (append-only history).
- [ ] After every QA run the pipeline calls
      `updateGeneratedAssetQaStatus(assetId, verdict)`.
- [ ] Raw UI (`/projects/[id]/qa`) lists every asset, its current
      `qa_status`, latest verdict, `overallNotes`, and violations table.
- [ ] `lib/agent-prompts/qa-agent.prompt.ts` matches the canonical
      prompt verbatim.

## Sprint 10 — End-to-end validation

Sprint 10 is a validation sprint. No new product features.

- [ ] `scripts/test-full-mvp-pipeline.ts` runs the full path from Mirror
      Scan to QA on a single project and prints the standard report.
- [ ] `npm run test:full-pipeline` invokes that script.
- [ ] The full-pipeline test asserts:
    - [ ] Mirror Profile exists.
    - [ ] Exactly 50 prompts exist.
    - [ ] ≥ 1 lost or partial ProbeResult.
    - [ ] ≥ 1 competitor.
    - [ ] ≥ 1 Gap.
    - [ ] Evidence Bank exists AND `hasUsableEvidenceBank`.
    - [ ] ≥ 1 Fix Brief.
    - [ ] Exactly 5 Generated Assets (one per asset type).
    - [ ] Every Generated Asset has a QA report after QA runs.
    - [ ] Every Generated Asset's `qa_status` matches its latest QA
          verdict.
    - [ ] No Generated Asset remains `pending_qa` after QA.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm run test:prompts` passes.
- [ ] `npm run test:probe` passes.
- [ ] `npm run test:competitors` passes.
- [ ] `npm run test:gap-map` passes.
- [ ] `npm run test:evidence` passes.
- [ ] `npm run test:fix-brief` passes.
- [ ] `npm run test:assets` passes.
- [ ] `npm run test:qa` passes.
- [ ] `npm run test:full-pipeline` passes.
- [ ] All 8 canonical guard messages are still present verbatim
      (asserted by `test:full-pipeline`).
- [ ] No new customer-facing features were added.
- [ ] No export was built.
- [ ] No Stripe was built.
- [ ] No landing / pricing / final UI was built.
- [ ] No automated AI probe calls were built.
- [ ] No 3D map / dashboard was built.
- [ ] `MVP_VALIDATION_REPORT.md` exists with the current run recorded.

### Canonical guard messages (verbatim)

The pipeline runners MUST export these exact strings. `test:full-pipeline`
verifies each one.

| # | Producer                        | Message                                                                                 |
|---|---------------------------------|-----------------------------------------------------------------------------------------|
| 1 | `discover-competitors.ts`       | `Run at least one probe analysis before discovering competitors.`                       |
| 2 | `generate-gap-map.ts`           | `Run at least one probe analysis before generating a gap map.`                          |
| 3 | `generate-gap-map.ts`           | `Run competitor discovery before generating a gap map.`                                 |
| 4 | `generate-fix-brief.ts`         | `Prepare the Evidence Bank before generating fix briefs.`                               |
| 5 | `generate-fix-brief.ts`         | `Run at least one lost or partial probe analysis before generating fix briefs.`         |
| 6 | `generate-asset.ts`             | `Prepare the Evidence Bank before generating assets.`                                   |
| 7 | `generate-asset.ts`             | `Generate a Fix Brief before generating assets.`                                        |
| 8 | `run-qa.ts`                     | `Prepare the Evidence Bank before running QA.`                                          |
