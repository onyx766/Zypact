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

| Model | Role | Price per 1M tokens (input / cached / output) |
|---|---|---|
| `gpt-6-luna` | candidate: OpenAI's most cost-efficient current model with web search | $0.10 / $0.01 / $0.50 |
| `gpt-6.1-terra` | candidate: higher quality | $1.00 / $0.05 / $5.00 |
| `chat-latest` | **reference only** | $5.00 / $0.50 / $30.00 |

Prices are from OpenAI's public pricing page, recorded on 2026-11-10 as price table `openai-prices-2026-11-10`. Each web search call costs $0.01, and search content tokens are billed at the model's input rate.

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
- **The served snapshot is recorded**, so a model update behind an undated name is visible.
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

## Open items for the founder

1. **Confirm the benchmark budget:** a $50 project limit, an alert at $25, and a script cap of $40 or less.
2. **Confirm that OpenAI's terms** permit this use.
3. **After the benchmark, approve one model.** That is a code change to `CHATGPT_APPROVED_MODEL`.
4. **Wire the adapter into the worker.** That is a separate step, and it still runs behind the paid-measurement switch.
