# Adapter-validity note: ChatGPT engine (OpenAI Responses API with web search)

- **Status:** The methodology, the dedicated OpenAI project and the cost-tracking rules were **approved by the founder on 2026-11-10** (D-050). **No model is approved yet.** The model is chosen after the benchmark below reports its results and estimated cost and the founder approves one. Until then the adapter refuses every run that doesn't come from the benchmark. It is not wired into any worker, and the paid-measurement switch stays off.
- **Required by:** METHODOLOGY §4, "Adding another surface".
- **Adapter:** `lib/probes/chatgpt.ts`. Pricing is in `lib/probes/chatgpt-pricing.ts`.
- **Setting family:** `openai-responses-websearch-v2`
- **Protocol provider value:** `openai_chatgpt`
- **Benchmark:** `scripts/benchmark-chatgpt-models.ts`, which does a dry run unless explicitly told to spend.
- **Tests:** `npm run test:chatgpt-adapter`
- **Date:** 2026-11-10

## Claim boundary (founder-approved)

V1 measures **controlled OpenAI API responses, not observations of ChatGPT.com**.

Every result keeps:

- the original response;
- its citations and retrieved sources;
- the exact request configuration;
- timestamps;
- the limitations below.

Zypact does not buy or integrate any third-party ChatGPT scraping service. That would need separate legal, data-rights and reliability validation.

## What is measured

Each measured question is sent as one request to `POST https://api.openai.com/v1/responses`. A versioned **setting** fixes every choice. Its version is `openai-responses-websearch-v2:<search>:<model>`.

- **Model:** none approved yet. The benchmark candidates are below.
- **Tool:** `web_search`, with sources requested (`include: ["web_search_call.action.sources"]`).
- **Search mode:**
  - **`auto`**: the main monitoring protocol, founder decision. The model decides whether to search, and every run records whether it did and how many search calls it made.
  - **`required`**: a separate setting for a separate protocol only. A run in which the model doesn't search fails under it.

  The two are never pooled. A baseline and its retest must use the same setting version.
- **Reasoning effort:** `low` (omitted for a model that takes none). **Output cap:** 4000 tokens, including reasoning tokens.
- **`store: false`.** No instructions, conversation history or previous response are sent.

The buyer question is sent exactly as approved, with no brand, domain or project context, as with Perplexity Sonar.

### Benchmark candidates

OpenAI lists `gpt-5-mini` for shutdown on 2026-12-11, so it is not a candidate.

| Model | Role | Pinning (OpenAI model pages, read 2026-11-11) | Price per 1M tokens (input / cached / output) |
|---|---|---|---|
| `gpt-6-luna` | candidate: OpenAI's most cost-efficient current model with web search | undated ID | $0.10 / $0.01 / $0.50 |
| `gpt-6.1-terra` | candidate: higher quality | undated ID | $1.00 / $0.05 / $5.00 |
| `chat-latest` | **reference only** | moving alias | $5.00 / $0.50 / $30.00 |
| `gpt-5.5-2026-04-23` | candidate (added 2026-11-11) | dated snapshot | $5.00 / $0.50 / $30.00 |
| `gpt-5.4-2026-03-05` | candidate (added 2026-11-11) | dated snapshot | $2.50 / $0.25 / $15.00 |

Prices are from OpenAI's public pricing page. The first three were recorded on 2026-11-10, and the two dated snapshots were added on 2026-11-11. The table is price table `openai-prices-2026-11-11`. Each web search call costs $0.01, and search content tokens are billed at the model's input rate.

**Pinning.** OpenAI's model pages and `GET /v1/models` were checked on 2026-11-11:
- **Dated snapshot.** Only `gpt-5.5-2026-04-23` and `gpt-5.4-2026-03-05` carry a date-stamped snapshot ID among the candidates. This is the strongest pin OpenAI offers.
- **Undated ID.** `gpt-6-luna` and `gpt-6.1-terra` are each listed as their own default snapshot. OpenAI does not say they change, but it publishes no dated ID, and the API reports the undated name. A silent update therefore cannot be ruled out from the documentation; it could only be detected afterwards, from drift in recorded behaviour. An earlier version of this note called `gpt-6-luna` a fixed version, which overstated it.
- **Moving alias.** `chat-latest` is described as pointing to "the latest Instant model currently used in ChatGPT", and "the underlying model snapshot will be regularly updated." No dated snapshot of it exists.

`chat-latest` is a reference, never an approved instrument:

- It isn't assumed to reproduce ChatGPT.com.
- Its served model is recorded but not checked.
- OpenAI's documentation doesn't confirm that it supports web search in this API. The benchmark records what happens.

## Interface type

This is OpenAI's **public developer API**, called with a key from a dedicated Zypact measurement project. It is not:

- the ChatGPT consumer app;
- ChatGPT Search as a signed-in user sees it;
- a tenant-specific ChatGPT Enterprise or Team workspace;
- a custom GPT.

The app and the API differ in system instructions, model routing, memory, personalisation, location signals and the search pipeline. Zypact can't observe any of those for the app.

## Injected context

The request carries only the buyer question. OpenAI may still add context Zypact neither controls nor sees:

- OpenAI's default model behaviour and policies;
- the search tool's choice of queries, index and results;
- an approximate location inferred from the calling server. No `user_location` is sent, so results may follow the region of Zypact's infrastructure.

There is no account memory or personalisation, because no user account is involved.

## Request and response provenance

The same evidence contract as Sonar applies.

For every attempt:

- the exact serialized request body and its SHA-256;
- the trimmed question and its SHA-256;
- the exact response body, captured before parsing, and its SHA-256;
- the HTTP status;
- latency;
- `x-request-id`;
- the served model. For an approved setting, the served model must be the approved name or a dated snapshot of it.

**Usage**, founder decision. Every run keeps:

- input, cached-input, output, reasoning and total tokens;
- the number of web search calls and search actions;
- whether search occurred.

A usage field the provider didn't report is null, never 0. The raw body is stored, so every figure can be recomputed.

Sources follow D-044 and keep cited and retrieved apart:

- **Cited sources** are the URLs of `url_citation` annotations.
- **Retrieved sources** are the search sources plus every cited URL. OpenAI can cite a URL its sources list omits; that URL was still retrieved.
- A retrieved-only URL is never reported as cited.

Source insights use only what was observed. An answer without a search, or without citations, contributes no sources and is never filled in.

Failures carry the full evidence and are never partial successes. They include:

- a non-JSON body;
- a body that is not a Responses object;
- a present `error`;
- a status other than `completed`;
- a missing id;
- an unexpected served model;
- empty output text;
- a run under the `required` setting that didn't search;
- an HTTP error, a network error or a timeout.

A billed-but-unusable response keeps its usage, so its cost still counts.

## Reproducibility limits

- **Responses vary between runs.** One run is not a stable result, and METHODOLOGY §7 sampling applies. The benchmark reports cited-domain stability across repeats.
- **No temperature** is set, because the reasoning models reject one.
- **Under `auto`, search use is itself variable.** It is recorded on every run.
- **The web changes over time.** A later retest observes a different web, which is a confounder (METHODOLOGY §14).
- **The served model name is recorded.** A change of served name is visible. A model whose served name is undated (`gpt-6-luna`, `gpt-6.1-terra`) could still change without the name changing; only a dated snapshot rules that out.
- **`store: false`.** Zypact's stored copy is the only record.

## Terms and policy constraints

- **Dedicated OpenAI project and key** (approved): the adapter reads only `OPENAI_PROBE_API_KEY`, never the analysis key `OPENAI_API_KEY`. The project must have budget alerts and a hard limit.
- **Benchmark budget, proposed:**
  - a $50 hard limit on the project;
  - an alert at $25;
  - the benchmark script stops itself at $40 or less.

  The founder confirms the budget before any paid run.
- **Application-level spending limits:** the benchmark reserves each run's worst case against its cap before calling. In production, the E1 usage ledger reserves every run against the plan's allowance before any call.
- **Founder to confirm:** OpenAI's usage policies and terms permit sending public buyer-style questions and recording the answers for measurement under Zypact's account type.
- **Naming:** "ChatGPT" is an OpenAI trademark. Customer copy uses it only to identify the engine, alongside the limitation statement, and never implies an affiliation.

## Cost, rate limits and latency

- **Cost** (approved rules):
  - The Responses API reports tokens and search calls, not a charged amount. Zypact **estimates** cost from recorded usage and the versioned price table.
  - When the cost can't be estimated (no usage, an unpriced model, or a network or HTTP failure), it is **unknown**, never $0.
  - The price table is reconciled against OpenAI's invoice once real usage exists.
- **Estimated cost per run** before measurement, assuming about 12,000 input tokens of search content, about 1,000 output tokens and one or two searches:

  | Model | Estimated cost per run |
  |---|---|
  | `gpt-6-luna` | about $0.02–0.03 |
  | `gpt-6.1-terra` | about $0.04–0.06 |
  | `chat-latest` | about $0.10–0.20 |

  The benchmark replaces these estimates with measured figures.
- **Rate limits:** set per OpenAI organisation and project, and checked on the dedicated project.
- **Latency:** with search and reasoning, expected to run from seconds to tens of seconds. The benchmark gives each call 120 seconds. Its p50 and p90 latency results set the worker's per-attempt deadline.

## Comparability with existing surfaces

- A ChatGPT result is **not comparable** with a Perplexity Sonar or Perplexity Agent result, and results are never pooled across engines.
- Two ChatGPT results are directly comparable only under the same setting version, which fixes the model and the search mode. A change of served snapshot is disclosed as a measurement condition.
- A baseline and its retest must share the setting version. The `auto` and `required` settings are different protocols.
- Engines may appear side by side only as separate, labelled results. Each keeps its own denominator and uncertainty.

## Required limitation

Every client artifact that includes this engine must state:

> This is a directional measurement of controlled OpenAI API responses with web search (shown as "ChatGPT") under the recorded conditions. It is not what users of the ChatGPT app see, and it does not represent every AI system.

## Benchmark protocol

The protocol is designed so the founder can choose a model.

1. **Questions:** 10 non-confidential, brand-free questions across the four categories (`scripts/fixtures/chatgpt-benchmark-questions.json`).
2. **Runs:** 3 models × 5 repeats = 150 runs, interleaved so a run stopped by the budget is still balanced.
3. **Search:** automatic search for every run.
4. **Reported per model:**
   - completed and failed runs, with causes;
   - served models;
   - search rate and mean search calls;
   - median cited and retrieved sources, and answers without a citation;
   - cited-domain stability across repeats;
   - p50 and p90 latency;
   - median answer length;
   - estimated cost, with runs of unknown cost counted separately.
5. **Output:** raw requests and responses go to the git-ignored `.benchmark-out/` folder. They are never committed.

## Benchmark results (2026-11-11)

**Setup:**
- Run with the founder-confirmed budget: script cap $39, plus a 3-run smoke test beforehand.
- 10 brand-free questions, 3 models, automatic search.
- Raw output is in the git-ignored `.benchmark-out/full-1/` and is not committed.

**Coverage:**
- 150 runs were attempted, and 124 reached the models. Repeats 1–4 are complete for every model, plus 4 runs of repeat 5.
- From run 124 the OpenAI account ran out of prepaid credit (HTTP 429 `insufficient_quota` / `credit_balance_exhausted`). Those 26 refusals are not model failures and are not billed.
- The script now stops at the first such refusal.

| | `gpt-6-luna` | `gpt-6.1-terra` | `chat-latest` (reference) |
|---|---|---|---|
| Runs that reached the model | 42 | 41 | 41 |
| Model-side failures | 0 | 0 | 1 (hit the 4000-token output cap) |
| Served model | `gpt-6-luna` every run | `gpt-6.1-terra` every run | `chat-latest` every run |
| Search occurred (auto) | 90.5% | 92.7% | 90.0% |
| Mean web search calls | 1.14 | 1.00 | 0.95 |
| Median cited sources | 2 | 3 | 4 |
| Answers with no citation | 4 | 3 | 4 |
| Median retrieved sources | 41.5 | 42 | 40.5 |
| Cited-domain stability across repeats (median Jaccard) | 0.42 | 0.23 | 0.46 |
| Latency p50 / p90 | 8.7 s / 14.0 s | 11.5 s / 14.7 s | 18.3 s / 21.9 s |
| Median answer length | 2,006 chars | 2,042 chars | 11,610 chars |
| Estimated cost per completed run | **$0.0126** | $0.0197 | $0.110 |

**Spend:**
- Usage-based estimate: $5.73 for the full run and $0.22 for the smoke test.
- The script's own budget counter showed $16.62, because it counts every refused call at its worst case.
- The credit ran out at about $6 of estimated use, which agrees with the price table. Reconcile against OpenAI's usage page.

**What this does and does not show:**
- These are structural measurements: reliability, search use, citation behaviour, consistency, latency and cost.
- No human has rated answer quality. A founder read of a few answers per model is recommended before approval.
- **Cited sources vary a lot between repeats for every model** (stability 0.23–0.46). One run per question is not a stable result, and the METHODOLOGY §7 sampling rules matter for this engine.

**Superseded on 2026-11-11.** A follow-up analysis of the same answers found two things, recorded in the next section:
- `gpt-6-luna` names far fewer smaller vendors than the reference;
- it has no dated snapshot.

The founder did not approve a model, and asked for a smaller validation first. The original recommendation is kept below as a record.

**Original engineer recommendation (superseded):**
- **Approve `gpt-6-luna`** for the automatic-search monitoring setting:
  - it is the cheapest, about 9× below `chat-latest` per run;
  - it is the fastest;
  - it had no model-side failures;
  - its search rate is in line with the others;
  - its citation consistency (0.42) is close to the reference's (0.46) and well above `gpt-6.1-terra`'s (0.23).
- **Trade-off:** fewer cited sources per answer (median 2, against 3 and 4), so Sources pages will have fewer cited sources per run.
- **Monthly cost:** a Starter plan's full 240 runs a month, all on this engine, costs about $3.

**Before production:**
- top up the OpenAI project's credit;
- check its usage tier's rate limits;
- set the worker's per-attempt deadline from these latencies (for example 30 seconds against a p90 of 14 s).

## Follow-up analysis and smaller-vendor validation (2026-11-11)

**Follow-up analysis of the first benchmark's answers.** This was offline and cost nothing.

| | `gpt-6-luna` | `gpt-6.1-terra` | `chat-latest` |
|---|---|---|---|
| Smaller vendors named per answer (mean) | 0.9 | 1.0 | 3.8 |
| Smaller vendors named at least once, of 68 named by any model | 18 | 22 | 58 |
| Blind review: citation support (1–5) | 3.8 | 3.2 | 2.4 |
| Blind review: accuracy (1–5) | 4.3 | 4.3 | 3.8 |

How these were measured:
- "Smaller vendors" means every named vendor except each question's three most-mentioned.
- Vendors were detected against a list of known names, and false matches were removed by hand.
- The blind review used 17 answers (6 questions, first repeat). An independent reviewer rated them without knowing which model wrote which answer.

`chat-latest` names the most vendors but supports them least with citations. `gpt-6-luna` is the most accurate and best cited, but rarely names smaller vendors.

**Smaller-vendor validation (founder, 2026-11-11).** This is a capped first phase, run before any decision on the full validation:
- **Questions:** `x1-smaller-vendor-questions-v1`, 10 brand-free B2B SaaS buyer questions where credible smaller vendors belong in a good answer.
- **Models:** `gpt-5.5-2026-04-23`, `gpt-5.4-2026-03-05` and `gpt-6-luna` at 3 repeats each, and `chat-latest` (reference) at 2 repeats. That is 110 runs.
- **Cap:** $10 for this phase.
- **Lifetime ceiling:** benchmarking has a single $40 ceiling that includes all earlier spend. The runner counts earlier spend from every recorded run under `.benchmark-out/` and refuses a cap above what is left.
- **Analysis after the run:** vendor coverage, especially smaller vendors; citation reliability, with a blind review and link checks; search behaviour; and consistency across repeats.
- **Approval:** results go to the founder before any further paid run. No model is approved, and nothing is activated in production.

**Smaller-vendor validation results (run 2026-11-11).**
- **Runs:** 84 of the 110 planned. The $10 cap stopped the run as designed, because these questions drew more searches and longer answers than the planning estimate assumed.
- **Coverage:** every question has at least 2 repeats for every model, and some have 3.
- **Spend:** estimated $9.41, so lifetime benchmark spend is $15.35 of $40.
- **Served models:** both dated snapshots were served under their exact dated ID on every run.

| | `gpt-5.4-2026-03-05` | `gpt-5.5-2026-04-23` | `gpt-6-luna` | `chat-latest` (ref.) |
|---|---|---|---|---|
| Pinning | dated snapshot | dated snapshot | undated ID | moving alias |
| Runs (completed) | 21 (19) | 21 (21) | 22 (22) | 20 (16) |
| Failures | 2 at the 4,000-token output cap | 0 | 0 | 4 at the output cap |
| Vendors per answer (median) | 8 | 13 | 4 | 8 |
| Smaller vendors per answer (mean) | 5.6 | 9.6 | 2.2 | 5.2 |
| Smaller vendors named at least once (of 138 pooled) | 74 | 119 | 39 | 61 |
| Smaller-vendor mentions with a citation on the same line or table cell | 91% | 35% | 35% | 15% |
| Unique cited URLs per answer (median) | 9 | 4 | 4 | 5 |
| Cited links that load (unique links; rest blocked the check) | 151 of 160 | 52 of 62 | 67 of 70 | 65 of 71 (1 broken) |
| Vendor-list similarity across repeats | 0.64 | 0.71 | 0.50 | 0.76 |
| Same vendor named first across repeats | 87% | 75% | 68% | 94% |
| Searched / search queries per run (mean) | 100% / 15 | 100% / 5 | 100% / 6 | 100% / 6 |
| Latency p50 / p90 | 46 s / 66 s | 25 s / 47 s | 12 s / 16 s | 21 s / 28 s |
| Cost per run (mean estimate) | $0.138 | $0.121 | $0.020 | $0.157 |

How these were measured:
- **Smaller vendors** are every vendor except each question's three most-mentioned, pooled across models.
- **Vendor detection** used a list of known names, with common-word names counted only in list or table context. Bold names it missed were checked by hand and added.
- **Every citation** from every model was found in that model's own retrieved sources.

**Blind review.** An independent reviewer rated 24 answers (6 questions × 4 models, first completed repeat) without knowing which model wrote which. The reviewer's style grouping matched the models exactly. Average scores out of 5:

| | Accuracy | Usefulness | Smaller-vendor coverage | Citation support |
|---|---|---|---|---|
| `gpt-5.4-2026-03-05` | 4.0 | 4.2 | 3.5 | 3.8 |
| `gpt-6-luna` | 4.0 | 3.3 | 3.3 | 3.8 |
| `chat-latest` | 3.5 | 3.7 | 3.5 | 3.2 |
| `gpt-5.5-2026-04-23` | 3.7 | 4.0 | 4.0 | 2.2 |

Notable findings:
- **`chat-latest`** recommended a product that had shut down (June, wound down in August 2025), citing a page that now returns 404.
- **`gpt-5.5-2026-04-23`** has the broadest vendor recall, but rests most vendor claims on roundups, Reddit or a single listicle.
- **`gpt-5.4-2026-03-05`** ties nearly every vendor claim to that vendor's own page. Its weaknesses:
  - its source lists repeat URLs;
  - two misattributions were found;
  - its sources are vendor marketing rather than independent evidence.
- **`gpt-6-luna`** is precise and cleanly cited, but names about 4 vendors per answer.

**Engineer recommendation (pending founder decision): `gpt-5.4-2026-03-05`.** It is the only option that is pinned, covers smaller vendors at about the reference's level, and ties those mentions to evidence. Open points before approval:
1. **Output cap.** 2 of 21 runs stopped at the 4,000-token cap, so the cap needs raising (for example to 8,000). That is a new setting version and must be validated.
2. **Latency.** p90 is 66 s, so the worker's per-attempt deadline must be at least about 90 s.
3. **Cost.** About $0.14 per run, so a 240-run Starter month costs about $33. `gpt-6-luna` would cost about $5.
4. **Sample size.** This is a small sample (2–3 repeats). A confirmation run at the raised cap is proposed before approval.

## Open items for the founder

1. ~~Confirm the benchmark budget~~: confirmed by the founder on 2026-11-11. On the same day the founder clarified that the $40 is a lifetime ceiling including earlier spend.
2. **Confirm that OpenAI's terms** permit this use.
3. **Approve one model.** No recommendation stands until the smaller-vendor validation reports. Approval is a code change to `CHATGPT_APPROVED_MODEL`.
4. **Wire the adapter into the worker.** That is a separate step, and it still runs behind the paid-measurement switch.
