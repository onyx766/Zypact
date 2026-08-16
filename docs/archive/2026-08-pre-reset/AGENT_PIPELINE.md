> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Zypact — Agent Pipeline

This document is the map of the full 7-agent pipeline defined in
`zypact-agent-prompts.md`.

Currently implemented:
- **Agent 1 — Site Reader** (Sprint 1)
- **Agent 2 — Prompt Mirror** (Sprint 2)
- **Agent 4 — Probe Analysis** (Sprint 3, manual paste-and-analyze)
- **Competitor Discovery Agent** (Sprint 4)
- **Gap Map Agent** (Sprint 5)
- **Evidence Bank** (Sprint 6, user-editable safety layer — not an LLM agent)
- **Agent 5 — Fix Agent, `fix_brief` mode** (Sprint 7)
- **Agent 5 — Fix Agent, `generate_asset` mode** (Sprint 8)
- **Agent 7 — QA Agent** (Sprint 9)

**Agent 3 — AI Probe** (automated ChatGPT / Perplexity / Gemini calls) is
NOT implemented. The MVP uses Agent 4 with user-pasted responses instead.
Agents 5–7 are documented here for context only — do NOT implement them
until their own sprint is opened.

Note on numbering: the canonical prompts file introduces a
"Competitor Discovery Agent" between Probe Analysis (Agent 4) and the
future Gap Analyzer. It is intentionally unnumbered in the source-of-truth
Markdown to avoid renumbering the still-placeholder Agents 5–7 during
Sprint 4. When the Gap Analyzer sprint opens, we will renumber all
downstream slots at once.

## Pipeline overview

```
Website URL
  │
  ▼
[Crawler]              ── Sprint 1 ────────────────────────────
  │  CrawledPage[]
  ▼
[Agent 1: Site Reader]   ← implemented in Sprint 1
  │  MirrorProfile JSON
  ▼
[Agent 2: Prompt Mirror] ← implemented in Sprint 2
  │  50 buyer prompts + recommendedForProbe
  ▼
─────────────────────────  Agent 3 deferred: automated calls not in MVP
[Agent 3: AI Probe]              (automated — deferred)
  ▼
[Agent 4: Probe Analysis]← implemented in Sprint 3 (manual paste)
  │  ProbeResult (won / partial / lost / not_relevant)
  ▼
[Competitor Discovery]   ← implemented in Sprint 4
  │  Competitor rows (name, threatLevel, phantom, blindSpot)
  ▼
[Gap Map Agent]          ← implemented in Sprint 5
  │  GapMap JSON (nodes, edges, competitorDistances, prioritizedGaps)
  │  + Gap rows (prioritized, deduped, deterministically-scored)
  ▼
[Evidence Bank]          ← implemented in Sprint 6 (not an LLM agent)
  │  User-editable safety layer:
  │  productDescription / audience / useCases / features / proofItems /
  │  competitors / allowedClaims / forbiddenClaims / tone / notes.
  │  Prefilled from Mirror Profile; edited & confirmed by the user.
  │  Every downstream generator (Fix Agent, Asset, QA) will consult this.
  ▼
[Fix Agent — fix_brief]  ← implemented in Sprint 7 (fix_brief mode only)
  │  Consumes: prioritized Gap + related ProbeResult + Mirror Profile +
  │  Evidence Bank. Refuses to run without a usable Evidence Bank.
  │  Produces a validated FixBrief:
  │  lostPrompt / competitorRecommended / rootCause / recommendedFix /
  │  fixType / assetsToGenerate / evidenceNeeded / evidenceAvailable /
  │  priority / expectedImpact.
  ▼
[Fix Agent — generate_asset] ← implemented in Sprint 8 (asset mode only)
  │  Consumes: an existing FixBrief + Evidence Bank + Mirror Profile +
  │  an asset_type ∈ {comparison_page_outline, faq_block, proof_block,
  │  comparison_table, json_ld_schema}.
  │  Produces a validated GeneratedAsset:
  │  { assetType, title, content (Markdown or JSON-LD string),
  │    placeholders, claimsUsed }.
  │  Every asset is persisted with qa_status="pending_qa".
  ▼
[QA Agent]                ← implemented in Sprint 9
  │  Consumes: a GeneratedAsset + Evidence Bank + Mirror Profile.
  │  Adversarial verifier — refuses to run without a usable Evidence Bank.
  │  Produces a validated QaReport:
  │  { verdict ∈ {safe_to_publish, needs_evidence, unsupported_claims},
  │    violations[], placeholdersRemaining[], overallNotes }.
  │  Also updates generated_assets.qa_status to match the verdict.
  ▼
─────────────────────────  everything below is out of scope for now
Export / Publish                (deferred — never in current scope)
```

## Agent 1 — Site Reader (Sprint 1)

**Purpose**: read a SaaS website and produce a factual Mirror Profile.
The Mirror Profile is the single source of truth every later agent depends on.

**Input**
- `pages: CrawledPage[]` wrapped inside `<pages>...</pages>` XML tags.
  Each page carries `<page url="..." pageType="...">...text...</page>`.

**Output** (validated by `lib/schemas/site-reader.schema.ts`):

```json
{
  "companyName": "",
  "website": "",
  "detectedCategory": "",
  "categoryConfidence": "high|medium|low",
  "targetAudience": [],
  "useCases": [],
  "features": [],
  "painPointsAddressed": [],
  "claims": [{"claim": "", "sourceUrl": "", "hasProof": false}],
  "proofSignals": [
    {"type": "customer|case_study|review|award|integration|press",
     "detail": "", "sourceUrl": ""}
  ],
  "competitorsMentioned": [],
  "missingSignals": [{"signal": "", "whyItMatters": ""}],
  "buyerIntentAngles": [],
  "aiReadabilityNotes": ""
}
```

**Rules**
- Only use what is present on the site — no fabrication.
- Every `claim` must cite `sourceUrl`.
- `hasProof` is `true` only when the same page carries a verifiable signal
  (customer name, case study, review, press mention, award, integration).
- Output is JSON only — no prose, no markdown fences.
  (The parser strips fences defensively.)

## Data flow

### Sprint 1 — Mirror Scan

```
POST /api/projects/run-mirror-scan
  { websiteUrl, companyName? }
    │
    ▼
  createProject()  ─▶ Project row
    │
    ▼
  crawlSite(websiteUrl, maxPages)
    │  CrawledPage[]
    ▼
  saveSitePages()  ─▶ SitePage rows
    │
    ▼
  runSiteReaderAgent({ pages })
    │  SiteReaderOutput (Zod-validated)
    ▼
  saveMirrorProfile()  ─▶ MirrorProfile row
    │
    ▼
  { projectId, mirrorProfile }
```

The UI at `/app/projects/[id]/mirror` renders the JSON straight from the row —
no styling, no dashboard.

### Sprint 2 — Buyer Prompts

```
POST /api/projects/generate-buyer-prompts
  { projectId, userInputs? }
    │
    ▼
  db.getMirrorProfile(projectId)
    │  MirrorProfile JSON (validated)
    ▼
  runPromptMirrorAgent({ mirrorProfile, userInputs? })
    │  user message wraps profile in <mirror_profile>...</mirror_profile>
    │  and overrides in <user_inputs>...</user_inputs>
    │  PromptMirrorOutput (Zod-validated: exactly 50, cross-checked ids)
    ▼
  db.replaceGeneratedPrompts()  ─▶ 50 GeneratedPrompt rows
                                   `selected = true` for recommendedForProbe
    │
    ▼
  { projectId, totalPrompts, recommendedForProbe, ... }
```

The UI at `/app/projects/[id]/prompts` renders the stored table — no design.

### Sprint 3 — Manual Probe Analysis

```
POST /api/projects/analyze-probe-response
  { projectId, generatedPromptId?, prompt, platform, rawResponse, knownCompetitors? }
    │
    ▼
  db.getProject(projectId) + db.getMirrorProfile(projectId)
    │  build clientName {name, domain, aliases}
    │  merge knownCompetitors with mirror.competitorsMentioned
    ▼
  db.createProbeRun()   ─▶ ProbeRun (status="pending")
    │
    ▼
  runProbeAnalysisAgent({ prompt, platform, aiResponse, clientName, knownCompetitors })
    │  user message wraps content in:
    │    <prompt>, <platform>, <ai_response>,
    │    <client_name>, <known_competitors>
    │  ProbeAnalysisOutput (Zod-validated: cross-field verdict rules)
    ▼
  db.saveProbeResult()  ─▶ ProbeResult (raw response persisted)
    │
    ▼
  db.updateProbeRunStatus("succeeded")
    │
    ▼
  { probeRunId, result }
```

UIs at `/app/projects/[id]/probe` (manual paste per selected prompt) and
`/app/projects/[id]/lost-prompts` (table of verdict ∈ {lost, partial}).

### Sprint 4 — Competitor Discovery

```
POST /api/projects/discover-competitors
  { projectId, userCompetitors?: string[] }
    │
    ▼
  db.getProject(projectId) + db.getMirrorProfile(projectId)
    │  Mirror Profile revalidated with SiteReaderOutputSchema
    ▼
  db.getProbeResultsByProject(projectId)
    │  MUST be non-empty — else 409 with:
    │  "Run at least one probe analysis before discovering competitors."
    ▼
  db.getGeneratedPrompts(projectId)
    │  built into priorityByPromptId (used to flag top-rec in high-priority
    │  prompts as high threat)
    ▼
  runCompetitorDiscoveryAgent({
    mirrorProfile, userCompetitors, probeResults, priorityByPromptId,
  })
    │  user message wraps in <mirror_profile>, <user_competitors>,
    │  <probe_results>
    │  CompetitorDiscoveryOutput (Zod-validated: cross-field rules on
    │    discoverySource ↔ confidence and mentionCount)
    ▼
  db.replaceCompetitorsForProject()  ─▶ Competitor rows
    │  isPhantom / isBlindSpot flags set from the agent's arrays via
    │  case-insensitive name normalization
    ▼
  { competitors, phantomCompetitors, blindSpots, summary }
```

The UI at `/app/projects/[id]/competitors` renders the stored table plus a
transient summary block after each discovery run.

Product rule for Sprint 4: the canonical prompt allows `model_knowledge`
competitors when probe results are empty, but the app route refuses to run
without probe evidence. We want the MVP set grounded in real AI answers.

### Sprint 5 — Gap Map generation

```
POST /api/projects/generate-gap-map
  { projectId }
    │
    ▼
  db.getProject + db.getMirrorProfile (revalidated with SiteReaderOutputSchema)
    │
    ▼
  db.getProbeResultsByProject / db.getCompetitorsByProject
    │  MUST both be non-empty — else 409 with:
    │  "Run at least one probe analysis before generating a gap map."
    │  "Run competitor discovery before generating a gap map."
    ▼
  computeGapScores({ mirrorProfile, probeResults, competitors })
    │  Deterministic baseline (0-10 per dimension per competitor) using the
    │  MVP heuristics documented in lib/gap-map/compute-gap-scores.ts.
    ▼
  runGapMapAgent({ mirrorProfile, probeResults, competitors })
    │  user message wraps in <mirror_profile>, <probe_results>, <competitors>
    │  GapMapOutput (Zod-validated: score/distance ranges, sum-equals-distance,
    │    unique node ids, edges reference known nodes)
    │  Normalization pass:
    │    - Backfill any missing high/medium competitor from baseline.
    │    - Force recommendationDistance = sum of six sub-scores.
    ▼
  db.saveGapMap()               ─▶ GapMap row (full JSON stored)
  db.replaceGapsForProject()    ─▶ Gap rows (prioritized, max 5)
    ▼
  { gapMap, prioritizedGaps, competitorDistances, nodesCount, edgesCount }
```

The UI at `/app/projects/[id]/gap-map` renders a 2D matrix (competitor rows ×
six gap dimensions, heat-colored) plus the prioritized gaps table and a
collapsible raw-JSON block. No 3D map, no dashboards.

Product rule for Sprint 5: numeric truth is verified deterministically —
`recommendationDistance = sum(prompt_loss, citation, review,
comparison_content, proof, entity_clarity)` — with the baseline scorer as
fallback for anything the model misses.

### Sprint 6 — Evidence Bank

The Evidence Bank is NOT an LLM agent. It is the user-editable safety layer
every future generator (Fix Agent, Asset Generator, QA) will read from
before producing anything. Without it, generated assets could invent proof,
customer numbers, guarantees, or forbidden marketing claims.

```
GET  /api/projects/evidence-bank?projectId=…      (get-or-create)
POST /api/projects/evidence-bank                  (upsert edits)
  { projectId, evidenceBank }
    │
    ▼
  getOrCreateEvidenceBank(projectId)              (GET path)
    │  1. Load project.
    │  2. Load existing EvidenceBank; return as-is if present.
    │  3. Otherwise revalidate Mirror Profile, run
    │     buildEvidenceBankPrefill(profile), and save via
    │     upsertEvidenceBank inside withPipelineStep("evidence-bank").
    ▼
  db.upsertEvidenceBank(projectId, EvidenceBankInput)   (POST path)
    │  Zod-validated with EvidenceBankInputSchema:
    │   - productDescription ≤ 2000 chars.
    │   - forbiddenClaims.min(3) — no bank ever ships with fewer than
    │     the ten default forbidden claims.
    │   - proofItems.sourceUrl optional; if present, must be a valid URL.
    │   - tone ∈ {plain, confident, technical, friendly, executive}.
    │  Round-trip re-validated with EvidenceBankOutputSchema before return.
    ▼
  { evidenceBank }
```

The UI at `/app/projects/[id]/evidence-bank` renders the seven sections
(product facts, proof, competitors, allowed claims, forbidden claims, tone,
notes) with dynamic list editors and a single **Prepare Evidence Bank**
button. No Fix Agent, no generation, no export.

A helper `lib/evidence-bank/has-usable-evidence-bank.ts` is consumed by the
Sprint 7 Fix Brief Agent — it returns true iff `productDescription` is
non-empty OR at least one feature exists, AND `forbiddenClaims.length ≥ 3`.

**Prefill sourcing (from Mirror Profile — never fabricated)**
- `productDescription` — `${companyName} — ${detectedCategory}. ${aiReadabilityNotes}`, capped at 2000 chars.
- `targetAudience` — `mirrorProfile.targetAudience`, deduped case-insensitively.
- `mainUseCases` — `mirrorProfile.useCases`.
- `features` — `mirrorProfile.features` mapped to `[{ name, description: "" }]`.
- `proofItems` — `mirrorProfile.proofSignals` mapped 1:1 (customer, case_study, review, award, integration, press) with URL guard.
- `competitors` — `mirrorProfile.competitorsMentioned`.
- `allowedClaims` — claims where `hasProof===true`, plus safe restatements: `Supports: {useCase}` and `Feature: {name}`.
- `forbiddenClaims` — the ten defaults in `DEFAULT_FORBIDDEN_CLAIMS`.
- `tone` — `"plain"`. `notes` — empty string.

### Sprint 7 — Fix Brief Agent (`fix_brief` mode only)

The Website Fix Agent has two canonical modes (`fix_brief` and
`generate_asset`). Sprint 7 implements ONLY the `fix_brief` mode. The
`generate_asset` mode is intentionally deferred — no assets are emitted yet.

```
POST /api/projects/generate-fix-brief
  { projectId, gapId }
    │
    ▼
  db.getProject + db.getMirrorProfile (revalidated with SiteReaderOutputSchema)
    │
    ▼
  db.getEvidenceBankByProject
    │  MUST exist AND pass hasUsableEvidenceBank — else 409 with:
    │  "Prepare the Evidence Bank before generating fix briefs."
    ▼
  db.getGapsByProject → gap with id === gapId
    │  MUST exist — else 404 "Gap not found for this project."
    ▼
  db.getProbeResultsByProject → findProbeResultForGap(gap.affectedPrompts, …)
    │  1. Prefer probeResult.generatedPromptId ∈ gap.affectedPrompts, then lost/partial.
    │  2. Fallback: latest lost/partial ProbeResult on the project.
    │  If none exists → 409 with:
    │  "Run at least one lost or partial probe analysis before generating fix briefs."
    ▼
  runFixBriefAgent({ gap, probeResult, mirrorProfile, evidenceBank })
    │  user message wraps in:
    │    <mode>fix_brief</mode>
    │    <gap>, <probe_result>, <mirror_profile>, <evidence_bank>
    │  FixBriefOutput (Zod-validated:
    │    fixType ∈ {comparison_page, faq_block, proof_block, comparison_table, schema},
    │    assetsToGenerate ⊆ {comparison_page_outline, faq_block, proof_block,
    │      comparison_table, json_ld_schema} with .min(1),
    │    priority integer 1–5,
    │    rootCause ≤ 1000 chars,
    │    superRefine rejects banned guarantee phrases in
    │    rootCause / recommendedFix / expectedImpact)
    ▼
  status =
    evidenceNeeded.length > 0 ? "needs_evidence" : "ready_for_assets"
    ▼
  db.saveFixBrief()  ─▶ FixBrief row (gapId + probeResultId persisted)
    ▼
  { fixBrief, output }
```

The UI at `/app/projects/[id]/fix-briefs` lists prioritized gaps with a
per-row **Generate Fix Brief** button and, below, saved briefs with
expandable detail (rootCause, evidenceNeeded, evidenceAvailable,
assetsToGenerate). No **Export** or **Run QA** buttons on this page — those
are next-sprint work.

**Deterministic mock**
- Uses `gap.type`, `gap.severity`, `gap.explanation`, `gap.suggestedFixDirection`,
  `probeResult.prompt`, `probeResult.competitorsMentioned`,
  `mirrorProfile.missingSignals`, `evidenceBank.allowedClaims`,
  `evidenceBank.features`, `evidenceBank.proofItems`.
- Never invents proof. Missing evidence surfaces as an `evidenceNeeded`
  entry rather than a fabricated `evidenceAvailable` claim.
- `priority` maps `high → 1`, `medium → 3`, `low → 5`.
- `expectedImpact` uses a fix-type-specific honest template — never
  guarantees mentions, rankings, or citations.

**Fix-type mapping (`lib/fix-brief/infer-fix-type.ts`)**
| Gap type / hint       | FixType           | Default assets                                    |
| --------------------- | ----------------- | ------------------------------------------------- |
| comparison_content    | comparison_page   | comparison_page_outline, comparison_table, faq_block |
| citation              | proof_block       | proof_block                                       |
| review                | proof_block       | proof_block                                       |
| proof                 | proof_block       | proof_block                                       |
| entity_clarity        | faq_block         | faq_block                                         |
| prompt_loss           | comparison_page   | comparison_page_outline, comparison_table, faq_block |
| schema / structured_data | schema         | json_ld_schema                                    |
| (default)             | faq_block         | faq_block                                         |

### Sprint 8 — Fix Agent, `generate_asset` mode

The Website Fix Agent's second canonical mode. The system prompt is
unchanged; the pipeline flips `<mode>` from `fix_brief` to
`generate_asset`, and swaps the input tags. Sprint 8 does NOT touch
`runFixBriefAgent`.

```
POST /api/projects/generate-asset
  { projectId, fixBriefId, assetType }
    │
    ▼
  AssetTypeSchema.safeParse(assetType) — 400 on bad input
    │
    ▼
  db.getFixBrief(fixBriefId) — MUST exist AND belong to projectId
    │  else 409 with:
    │  "Generate a Fix Brief before generating assets."
    ▼
  db.getMirrorProfile (revalidated with SiteReaderOutputSchema)
    │
    ▼
  db.getEvidenceBankByProject
    │  MUST exist AND pass hasUsableEvidenceBank — else 409 with:
    │  "Prepare the Evidence Bank before generating assets."
    ▼
  runGenerateAssetAgent({ fixBrief, evidenceBank, mirrorProfile, assetType })
    │  user message wraps in:
    │    <mode>generate_asset</mode>
    │    <fix_brief>, <evidence_bank>, <mirror_profile>, <asset_type>
    │  GeneratedAssetOutput (Zod-validated:
    │    assetType ∈ enum,
    │    title / content non-empty,
    │    json_ld_schema content parses as JSON,
    │    superRefine rejects banned guarantee phrases in
    │      title / content / claim strings,
    │    placeholders round-trip: every [EVIDENCE NEEDED: …] in content
    │      is declared, and every declared entry appears in content)
    ▼
  db.saveGeneratedAsset()  ─▶ GeneratedAsset row (qa_status="pending_qa")
    ▼
  { asset, output }
```

The UI at `/app/projects/[id]/assets` lists Fix Briefs with five per-brief
buttons (`Generate comparison page outline`, `Generate FAQ block`,
`Generate proof block`, `Generate comparison table`,
`Generate JSON-LD schema`) plus a saved-assets table with expandable
content, placeholders, and `claimsUsed`. No **QA**, **Export**, or
**Publish** buttons exist.

**Absolute rules (mirrored from the canonical prompt)**
- Every factual statement about the client must come from Evidence Bank or
  Mirror Profile.
- Never emit forbidden claims (`Evidence Bank.forbiddenClaims`) or the
  Sprint-7 guarantee block-list.
- Never invent competitor pricing or disparage competitors.
- Where a fact is missing, insert `[EVIDENCE NEEDED: description]` and list
  it in `placeholders`.
- JSON-LD asset content must parse as valid JSON.
- Match the Evidence Bank tone (default: plain).

**Deterministic mock (per asset type)**
- **comparison_page_outline** — Markdown outline: H1, buyer-question intro,
  audience, use cases, comparison bullets, proof section, FAQ placeholder.
- **faq_block** — Markdown with five questions (what it does, who it is
  for, use case, differentiation vs the recommended competitor, proof).
- **proof_block** — Markdown proof block sourced only from Evidence Bank
  proofItems, plus a "proof still to gather" section.
- **comparison_table** — Markdown table with columns for client and the
  recommended competitor across use case / audience / proof / pricing
  (pricing is always a placeholder — we never invent competitor pricing).
- **json_ld_schema** — JSON-LD string. `FAQPage` when the parent
  `fixType === "faq_block"`, else `SoftwareApplication`. Only fields we can
  prove from Evidence Bank / Mirror Profile are emitted; missing fields are
  omitted (never invented). String values may carry
  `[EVIDENCE NEEDED: …]` and are also declared in `placeholders`.

**QA status (Sprint 8)**
Every asset is saved with `qa_status = "pending_qa"`. The full enum is
`pending_qa | needs_evidence | safe_to_publish | unsupported_claims`; the
QA Agent implemented in Sprint 9 owns transitions to the last three.

### Sprint 9 — QA Agent

Adversarial verifier that gates whether a Generated Asset is safe to
publish. Same LLM backend contract as the Fix Agent (system + user
message, JSON output), but its own canonical system prompt.

```
POST /api/projects/run-qa
  { projectId, assetId }
    │
    ▼
  db.getGeneratedAsset(assetId) — MUST exist AND belong to projectId
    │  else 404 with "Generated asset not found."
    │  or 400  with "The requested asset does not belong to this project."
    ▼
  db.getMirrorProfile (revalidated with SiteReaderOutputSchema)
    │
    ▼
  db.getEvidenceBankByProject
    │  MUST exist AND pass hasUsableEvidenceBank — else 409 with:
    │  "Prepare the Evidence Bank before running QA."
    ▼
  runQaAgent({ asset, evidenceBank, mirrorProfile })
    │  user message wraps in:
    │    <asset>, <evidence_bank>, <mirror_profile>
    │  QaAgentOutput (Zod-validated:
    │    verdict ∈ {safe_to_publish, needs_evidence, unsupported_claims},
    │    violations[] with typed reason/suggestedFix,
    │    placeholdersRemaining[],
    │    overallNotes non-empty,
    │    verdict/violations consistency enforced)
    ▼
  db.saveQaReport()                        ─▶ QaReport row (append-only)
  db.updateGeneratedAssetQaStatus(         ─▶ generated_assets.qa_status
      assetId, verdict)                       updated to verdict
    ▼
  { qaReport, updatedAsset, output }
```

The UI at `/app/projects/[id]/qa` lists every Generated Asset with a
`Run QA` (or `Re-run QA`) button, its current `qa_status`, and the latest
QA report expanded with `overallNotes`, `placeholdersRemaining`, and a
violations table. No **Export**, **Copy**, or **Publish** buttons exist.

**Absolute rules (mirrored from the canonical prompt)**
- Adversarial by design — assume the Fix Agent tried to sneak something
  through. False positives are cheap; a fabricated claim on a client's
  site is not.
- Every violation carries a verbatim `quote`, a `reason`, and a
  `suggestedFix` (never a full rewrite).
- `[EVIDENCE NEEDED: …]` placeholders are LEGITIMATE. They must appear in
  `placeholdersRemaining` and MUST NEVER be flagged as violations.
- Verdict mapping to `generated_assets.qa_status` is 1-to-1.

**Deterministic mock (Sprint 9)**
- **Forbidden claims** — detects both the shared `SPRINT_7_BANNED_PHRASES`
  and the project-specific `evidenceBank.forbiddenClaims` (case-insensitive
  normalized match). Fires `forbidden_claim`.
- **Unsupported numbers** — extracts multipliers (`10x`), percentages
  (`42%`), prices (`$99`), and 2-plus-digit integers from the placeholder-
  stripped content; each token missing from the Evidence Bank / Mirror
  Profile corpus becomes an `unsupported_number` violation.
- **Fabrication (`claimsUsed`)** — every entry must actually appear in the
  source it claims (`evidence_bank` or `mirror_profile`). Missing entries
  become a `fabrication` violation.
- **Competitor risk** — scans an ±80-char window around every competitor
  name (from Evidence Bank + Mirror Profile) for disparaging tokens
  (`outdated`, `legacy`, `slow`, `inferior`, `broken`, `dying`, `worst`,
  `nobody uses`). Any hit becomes a `competitor_risk` violation.
- **Implied results** — pattern-matches `AI will recommend you`,
  `will rank in ChatGPT`, `will rank higher`, `10x your visibility`,
  `guaranteed results/outcomes`, etc. — each becomes an `implied_result`
  violation.
- **Verdict**: any non-quality violation ⇒ `unsupported_claims`; else
  placeholders present ⇒ `needs_evidence`; else `safe_to_publish`.
