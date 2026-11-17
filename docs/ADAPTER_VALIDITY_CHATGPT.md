# Adapter-validity note: ChatGPT engine (OpenAI Responses API with web search)

- **Status:**
  - The methodology, the dedicated OpenAI project and the cost-tracking rules were **approved by the founder on 2026-11-10** (D-050).
  - **The founder chose `gpt-5.4-2026-03-05` on 2026-11-13.** That is a choice of model, not yet an approval to measure.
  - **On 2026-11-17 the founder agreed to run the confirmation run on OpenAI's half-price flex tier**, under the same $12 cap, and added OpenAI credit. That authorises the run; it does not approve the model. See "The half-price tier and the revised confirmation run".
  - **The confirmation run was made on 2026-11-17 and passed all seven criteria** (60 of 60 usable, all on flex, estimated $5.64). See "Confirmation run results".
  - **Approved for measurement by the founder on 2026-11-17** (written reply, relayed: "I approve ChatGPT"): `CHATGPT_APPROVED_SETTING_VERSION` is `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05`, the exact version the confirmation run validated. Automatic search only; `required` is not approved.
  - **Approval is not wiring.** The adapter is still not wired into any worker. A pilot measures on ChatGPT only after the wiring, its worker time limits and its deploy are each authorised (D-053 item 3).
  - Until a model is approved the adapter refuses every run that passes no explicit setting, and only the benchmark passes one. It is not wired into any worker, and the paid-measurement switch stays off.
- **Required by:** METHODOLOGY §4, "Adding another surface".
- **Adapter:** `lib/probes/chatgpt.ts`. Pricing is in `lib/probes/chatgpt-pricing.ts`.
- **Setting families:**
  - `openai-responses-websearch-v2`: output cap 4,000 tokens. Every run recorded up to 2026-11-11 used it.
  - `openai-responses-websearch-v3`: output cap 8,000 tokens, otherwise identical. Added on 2026-11-13 for the confirmation run, which was never run under it.
  - `openai-responses-websearch-v4`: `v3` on OpenAI's flex tier (`service_tier: "flex"`), otherwise identical. Added on 2026-11-17; the confirmation run uses it.
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

Each measured question is sent as one request to `POST https://api.openai.com/v1/responses`. A versioned **setting** fixes every choice. Its version is `<family>:<search>:<model>`, for example `openai-responses-websearch-v2:auto:gpt-6-luna`. A setting is built from those three parts and nothing else, so one version always names one request. A family is never edited once a run has been recorded under it.

- **Model:** none approved yet. The founder's choice is `gpt-5.4-2026-03-05`. The benchmark candidates are below.
- **Tool:** `web_search`, with sources requested (`include: ["web_search_call.action.sources"]`).
- **Search mode:**
  - **`auto`**: the main monitoring protocol, founder decision. The model decides whether to search, and every run records whether it did and how many search calls it made.
  - **`required`**: a separate setting for a separate protocol only. A run in which the model doesn't search fails under it.

  The two are never pooled. A baseline and its retest must use the same setting version.
- **Reasoning effort:** `low`, sent explicitly. It is omitted only for the `chat-latest` reference, where OpenAI's default then applies: all 62 stored `chat-latest` responses echo `medium`.
- **Output cap:** set by the family: 4,000 tokens under `v2` and 8,000 under `v3` and `v4`. The cap includes reasoning tokens.
- **Service tier:** set by the family. `v4` sends `service_tier: "flex"`, last in the request, and the response must say flex served it. `v2` and `v3` send none, so the project's default tier applies and their request bytes are what was recorded.
- **A run cannot change the request.** Settings are frozen. Before any request, the adapter refuses a setting that is not exactly what its version names, a different cap, and a search mode that contradicts the setting.
- **`store: false`.** No instructions, conversation history or previous response are sent.
- **Approval** names one exact setting version, in `CHATGPT_APPROVED_SETTING_VERSION`. It is `null` today.
  - The version to approve if the confirmation run passes is `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05`.
  - A `v2` setting can never be approved, because its cap cut answers off. Nor can the `chat-latest` reference.
  - Approving the `auto` version does not approve `required`, which has never been run.
  - Because approval names a version and not a model, preparing a later confirmation run can neither change nor switch off what is approved.

The buyer question is sent exactly as approved, with no brand, domain or project context, as with Perplexity Sonar.

### Benchmark candidates

OpenAI lists `gpt-5-mini` for shutdown on 2026-12-11, so it is not a candidate.

| Model | Role | Pinning (OpenAI model pages, read 2026-11-11) | Price per 1M tokens (input / cached / output) |
|---|---|---|---|
| `gpt-6-luna` | candidate: OpenAI's most cost-efficient current model with web search | undated ID | $0.10 / $0.01 / $0.50 |
| `gpt-6.1-terra` | candidate: higher quality | undated ID | $1.00 / $0.05 / $5.00 |
| `chat-latest` | **reference only** | moving alias | $5.00 / $0.50 / $30.00 |
| `gpt-5.5-2026-04-23` | candidate (added 2026-11-11) | dated snapshot | $5.00 / $0.50 / $30.00 |
| `gpt-5.4-2026-03-05` | candidate (added 2026-11-11); **the founder's choice (2026-11-13)** | dated snapshot | $2.50 / $0.25 / $15.00 |

Each model has one setting the benchmark runs. The first four run under `v2`, as recorded. `gpt-5.4-2026-03-05` now runs under `v4`; its 21 runs recorded under `v2` keep their own version and stay readable.

Prices are from OpenAI's public pricing page. The first three were recorded on 2026-11-10, and the two dated snapshots were added on 2026-11-11. The flex row for `gpt-5.4-2026-03-05` was added on 2026-11-17: $1.25 / $0.13 / $7.50, half the standard rates, from the page's `gpt-5.4` flex row. The table is price table `openai-prices-2026-11-17`; its standard rows are those of `openai-prices-2026-11-11`. Each web search call costs $0.01. OpenAI bills search content tokens "at model rates"; they arrive as input tokens, so the estimate prices them at the input rate, which the pricing page does not state in so many words.

**OpenAI's pages for `gpt-5.4-2026-03-05`, read again on 2026-11-13:**
- **Snapshot.** It is the only snapshot listed for GPT-5.4, and is named its default snapshot.
- **Retirement.** No deprecation or shutdown date was found for it on the pages read. The deprecations page was read partly through a summary, and the `shutdown_date` field of OpenAI's models endpoint was not checked; it is to be checked when the confirmation run is made. OpenAI's stated notice for generally available models is "at least 6 months". A smaller sibling, `gpt-5.4-nano`, is already listed for shutdown on 2027-04-01, and OpenAI now calls a GPT-6 model its flagship. A retirement notice within the next year is therefore plausible; that is the engineer's judgment, not a statement by OpenAI. If it comes, this engine needs a new snapshot and a new validation, and results before and after are not directly comparable.
- **Price.** Unchanged: $2.50 / $0.25 / $15.00. A prompt above 272,000 input tokens is priced at twice the input rate and 1.5 times the output rate. The price table keeps no such row. The largest input recorded so far is 41,002 tokens.
- **Reasoning effort.** The model accepts `none`, `low`, `medium`, `high` and `xhigh`, and its default is `none`. The setting sends `low` explicitly, so the default doesn't apply. OpenAI's search guide warns that `none` may give lower-quality search results.
- **Output cap.** The cap includes reasoning tokens, and a run that reaches it returns `status: incomplete` with reason `max_output_tokens`. OpenAI's general guidance for reasoning models is to reserve at least 25,000 tokens; the caps here are deliberately lower, to bound cost and time.
- **Search.** Web search is a listed tool for this model, and searches the live web by default. A pinned model therefore still sees a changing web.

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
- the served model. For an approved setting, the served model must be the approved name or a dated snapshot of it;
- the service tier the response names. Under `v4` it must be `flex`.

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
- under `v4`, a response that names a service tier other than `flex`, or none;
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
- **Provider defaults are recorded, not pinned.** The request leaves some choices to OpenAI, and each response echoes what was used. In all 211 billed runs so far these included: the default service tier, a `medium` search context size, an approximate location of `US`, `medium` text verbosity and, for the 62 `chat-latest` runs, a `medium` reasoning effort. A change in any of them would show in the stored responses, not in the setting version. Under `v4` the service tier is no longer a default: it is requested and checked.
- **`store: false`.** Zypact's stored copy is the only record.

## Terms and policy constraints

- **Dedicated OpenAI project and key** (approved): the adapter reads only `OPENAI_PROBE_API_KEY`, never the analysis key `OPENAI_API_KEY`. The project must have budget alerts and a hard limit.
- **Benchmark budget** (confirmed by the founder on 2026-11-11):
  - a $50 hard limit on the project;
  - an alert at $25;
  - the benchmark script stops itself at $40 or less, which is a lifetime ceiling that includes earlier spend.

  Each further paid phase still needs the founder's authorisation.
- **Application-level spending limits:** the benchmark reserves each run's worst case against its cap before calling, and its other safeguards are listed under "Benchmark protocol". In production, the E1 usage ledger reserves every run against the plan's allowance before any call.
- **Founder to confirm:** OpenAI's usage policies and terms permit sending public buyer-style questions and recording the answers for measurement under Zypact's account type.
- **Naming:** "ChatGPT" is an OpenAI trademark. Customer copy uses it only to identify the engine, alongside the limitation statement, and never implies an affiliation.

## Cost, rate limits and latency

- **Cost** (approved rules):
  - The Responses API reports tokens and search calls, not a charged amount. Zypact **estimates** cost from recorded usage and the versioned price table.
  - When the cost can't be estimated (no usage, an unpriced model, or a network or HTTP failure), it is **unknown**, never $0.
  - The price table is reconciled against OpenAI's invoice once real usage exists.
  - **On the flex tier the estimate is an upper bound** (rule of 2026-11-17). Output tokens are priced at the flex rate, which OpenAI documents ("Tokens are priced at Batch API rates"). Input tokens, search content included, stay at the standard rate, because OpenAI bills search content "at model rates" without saying whether flex halves them, and usage does not separate them from the prompt. Each search item stays at $0.01. A second figure prices the input at the flex rate too. The budget, the cap and the lifetime ceiling count the upper bound; OpenAI's usage page or invoice settles which is right.
  - **A flex capacity refusal counts as nothing** (rule of 2026-11-17). OpenAI's flex guide: such requests get "a `429 Resource Unavailable` error code. You will not be charged when this occurs." OpenAI documents no type or code for it, so the error's own words ("resource unavailable") are matched. Any other 429 to the same request, a rate limit included, keeps the unknown-cost rule.
  - **The estimate is an upper bound on search calls.** It charges $0.01 for every search item in a response, including page opens. OpenAI's own counter in the same stored responses (`tool_usage.web_search.num_requests`) counts only searches: 311 against 340 items over all 211 billed runs, and 80 against 102 for `gpt-5.4-2026-03-05`. On that counter lifetime spend would be about $15.06, not $15.35. The higher count is kept until an invoice settles it.
- **Estimated cost per run** before measurement, assuming about 12,000 input tokens of search content, about 1,000 output tokens and one or two searches:

  | Model | Estimated cost per run |
  |---|---|
  | `gpt-6-luna` | about $0.02–0.03 |
  | `gpt-6.1-terra` | about $0.04–0.06 |
  | `chat-latest` | about $0.10–0.20 |

  The benchmark replaces these estimates with measured figures.
- **Rate limits:** set per OpenAI organisation and project, and checked on the dedicated project.
- **Latency:** with search and reasoning, expected to run from seconds to tens of seconds. The benchmark's deadline follows the output cap: 120 seconds at 4,000 tokens (every run so far) and 240 seconds at 8,000. On the flex tier it is 290 seconds, the most Node's `fetch` allows, because OpenAI warns that flex responds more slowly and that "request timeouts are more likely". Its latency results set the worker's per-attempt deadline. For the chosen model that deadline is well above the worker's present limits; see "Founder's model choice and the confirmation run".

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

Later phases reuse this protocol with other questions, models and repeats: the smaller-vendor validation and the confirmation run, both below.

**Spend safeguards in the runner.** The first three date from the first benchmark, except the refusal of `--live=false`, which is new. The stop at a credit refusal and the lifetime ceiling were added later on 2026-11-11. The rest were added on 2026-11-13, before any run under the 8,000 cap, and those for the flex tier on 2026-11-17, before any flex call.
- **Dry run by default.** A paid run needs `--live`, a cap, a confirmation flag and the dedicated key. The switches take no value, so `--live=false` is refused, not read as `--live`.
- **One call at a time, no retries**, with one exception since 2026-11-17: a flex call refused for lack of capacity was not processed or charged, so its plan index is called again after 30 seconds, then 60, 120, 240 and 480. That is at most 5 times for one index and an hour of waiting per invocation; then the run stops, and a resume calls that index again. Each such call is reserved and recorded like any other, and books nothing.
- **Reservation before each call.** A run starts only if what is spent plus its worst case fits in the cap. A run of unknown cost counts at its worst case, and a run costing more than its worst case stops the benchmark. The unknown costs that count as nothing are a call refused for lack of credit, which OpenAI neither processes nor bills, and a flex call refused for lack of capacity, which OpenAI does not charge.
- **One paid run at a time.** A lock file is taken before the ledger is read. Without it, two runs started together would each pass the ceiling check and could together pass the ceiling. The lock is never taken over: after a killed run, a person deletes it.
- **Lifetime ceiling.** Every earlier recorded run counts toward the $40 ceiling, and a cap that doesn't fit in what is left is refused. The check fails closed: a damaged record, an amount that isn't a number, or a run of unknown cost whose worst case can't be worked out (no reserved amount, and an unknown setting or an unpriced model) refuses the run.
- **Recorded spend is a floor.** The repository records 237 runs and $15.35 through 2026-11-11. The ledger folder is git-ignored, so a machine without that output would otherwise count from $0. A paid run is refused unless the local ledger holds at least that much from that period.
- **Written reservation.** Each call's worst case is written to `reservations.jsonl` before the call. If the process dies mid-call, the reservation still counts toward the lifetime ceiling.
- **Stops on its own:**
  - at a credit refusal;
  - at a flex request whose response names another service tier, or none: the setting was not honoured, and that call may be billed at the standard rate;
  - when flex has no capacity for an index after every wait;
  - at a rejected request (HTTP 400, 401, 403 or 404);
  - after two runs in a row of unknown cost, or three in one invocation. Without this, a provider outage or a rate limit could use up the ceiling one worst case at a time with nothing billed. These two counts start again when a run is resumed, because a person has looked in between;
  - past `--max-failed` failed runs of the phase, when that flag is given. An answer cut off at the cap is billed at a known cost, so without the flag a run could spend its whole cap on answers that all fail. This count carries across a resume.
- **Resume under one cap.** A stopped run continues with `--resume=<its folder>`.
  - The start index, what the phase has already booked and how many of its runs have failed are read from that run's own files.
  - `--max-usd` then covers every part together. A higher cap than the stopped run had is refused unless a separate switch says the founder approved it.
  - No call that reached the model is made again: a failed run is never retried. The exceptions are a call refused for lack of credit and a flex call refused for lack of capacity: OpenAI neither processed nor billed them, so they are made again. A reservation left open after such a refusal is a call that may have been billed, and it is not made again.
  - Reservations are matched to records by count for each plan index, because a refused flex index can be called more than once.
  - A run can be continued only by the same plan, including the same failure limit, and only once. A phase already past its failure limit is not continued.
- **One run per folder, and no links.** An output folder that already holds a run is refused. So is a path that leaves the ledger folder through a symbolic link, where the lifetime count would not see it.
- **Deadline label.** A call cut off by the runner's own deadline is recorded as `network_error:deadline`, apart from other network errors. Its cost is unknown.

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
- The script's own budget counter showed $16.62, because at that time it counted every refused call at its worst case. Since 2026-11-13 a call refused for lack of credit books nothing.
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
| Cost per run (mean estimate, completed runs only) | $0.138 | $0.121 | $0.020 | $0.157 |

How these were measured:
- **Cost per run** here is the mean over completed runs. It leaves out what the runs that failed at the cap cost. The fuller figures for the chosen model are in "Founder's model choice and the confirmation run".
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

**Engineer recommendation of 2026-11-11: `gpt-5.4-2026-03-05`.** The founder chose this model on 2026-11-13; see the next section. It is the only option that is pinned, covers smaller vendors at about the reference's level, and ties those mentions to evidence. Open points before approval, as written on 2026-11-11:
1. **Output cap.** 2 of 21 runs stopped at the 4,000-token cap, so the cap needs raising (for example to 8,000). That is a new setting version and must be validated.
2. **Latency.** p90 is 66 s, so the worker's per-attempt deadline must be at least about 90 s. *Corrected on 2026-11-13: that figure was read at the 4,000 cap and understates the raised cap. See the next section.*
3. **Cost.** About $0.14 per run, so a 240-run Starter month costs about $33. `gpt-6-luna` would cost about $5. *Corrected on 2026-11-13: $33 leaves out the cost of the runs that failed. See the next section.*
4. **Sample size.** This is a small sample (2–3 repeats). A confirmation run at the raised cap is proposed before approval.

## Founder's model choice and the confirmation run (2026-11-13)

**The decision.** On 2026-11-13 the engineer relayed the founder's written reply: "I recommend gpt-5.4-2026-03-05 model."
- It is recorded as the founder's **choice of model**.
- It does not mention the confirmation run, its budget or the monthly cost. So it **authorises no paid run**, and it is not yet an approval to measure.
- `CHATGPT_APPROVED_SETTING_VERSION` stays `null`.

**What changed in the code.** No call was made.
- **A new setting for the chosen model:** `openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05`. It differs from the recorded `v2` setting in one thing: the output cap is 8,000 tokens, not 4,000.
- **Approval names an exact version.** When the founder approves, the approved setting is this exact version, the one the confirmation run validates. Nothing can approve the 4,000-cap setting.
- **The adapter is stricter.** Settings are frozen and checked against their version, and a response body that fails to arrive is recorded as a network failure with its evidence, not lost.
- **The runner's spend safeguards** listed under "Benchmark protocol".

**Corrections to the figures of 2026-11-11.** All are for `gpt-5.4-2026-03-05`, from its 21 recorded runs, all on the smaller-vendor questions and all at the 4,000 cap.

| Cost figure | Per run | 240 runs |
|---|---|---|
| Mean over the 19 completed runs (the "$0.138" and "$33" above) | $0.138 | $33.16 |
| Mean over all 21 billed attempts | $0.145 | $34.83 |
| Total spend divided by the 19 usable answers | $0.160 | $38.49 |
| Projection at the 8,000 cap (the two capped runs counted as using all 8,000) | $0.151 | $36.20 |

- **Cost.** A plan that promises 240 *successful* runs pays for the failed ones too. The honest range for a Starter month spent entirely on this engine is **about $35–38, not $33**. The confirmation run measures it at the raised cap.
- **Latency.** Latency grows with answer length: about 16.6 ms per output token over these runs (R² 0.78).
  - A full 8,000-token answer extrapolates to about 135 seconds, with a 95% range of 108 to 162 seconds.
  - That is a straight line drawn past the largest answer observed (4,000 tokens), so it is untested.
  - The "about 90 seconds" above is therefore too low, and the worker deadline comes from the confirmation run.
- **The worker's present limits don't fit this model.**
  - The production and staging worker configurations allow 45 seconds per provider call. The startup rule requires the call time plus the 10-second grace to stay under the 60-second lease.
  - 12 of the 21 recorded runs took longer than 45 seconds, even at the 4,000 cap.
  - Wiring this engine therefore needs longer worker limits: the provider timeout, the lease, the runtime ceiling and the readiness window. Today these are one global setting for every provider.
  - A changed provider timeout is a named revisit trigger in D-029, D-030, D-034 and D-036, so this needs its own decision and a worker redeploy. It is part of the wiring step, not of X1.
- **The cap rate is uncertain.** 2 of 21 is 9.5%, with a 95% interval of about 1% to 30%. Both capped runs were long answers cut off inside the final message, not runaway reasoning. No run above 4,000 tokens exists, so the data can't say how often 8,000 would be reached.

**The confirmation run (prepared, not authorised, never run; replaced on 2026-11-17 by the flex run in the next section).**
- **Plan:** `gpt-5.4-2026-03-05` only, under the `v3` setting. The 20 questions of both fixtures, 3 repeats each: 60 runs.
- **Dry run:** `npm run benchmark:chatgpt-models -- --models=gpt-5.4-2026-03-05 --question-set=general,smaller-vendor --repeats=3 --max-failed=3 --max-usd=12`
- **Projected cost:** about $9 ($0.151 per run). This is a projection from the 21 recorded runs, which cover only 10 of the 20 questions and none under this setting. In the models that ran both sets, the general questions were cheaper, so $9 is more likely high than low.
- **Cap:** $12 for the whole phase, with a $0.54 worst case reserved per run. The run stops once spend passes $11.46, which leaves room for all 60 runs unless they average more than about $0.19, against a projected $0.151. If it stops early and is resumed, the same $12 covers both parts.
- **Failure limit:** the phase stops at its fourth failed run, counted across any resume. Four failures already put criterion 3 below out of reach, so further spending would not change the result.
- **Lifetime ceiling:** $15.35 of $40 is spent. After this run it would be at most $27.35.
- **Time:** roughly an hour, one call at a time.

**What the confirmation run must show.** These criteria are written before the run. The setting passes only if all hold:
1. **Pinned model.** Every answer is served by exactly `gpt-5.4-2026-03-05`.
2. **Output cap.** No run stops at the 8,000-token cap. Zero of 60 supports a rate below about 5%. One or more means the cap isn't settled, and the result goes back to the founder rather than to approval.
3. **Reliability.** At least 57 of the 60 runs complete with a usable answer, and every failure is listed with its cause.
4. **Deadline.** No call reaches the 240-second deadline.
5. **Request as configured.** Every stored response echoes an output cap of 8,000, reasoning effort `low` and the default service tier.
6. **Budget.** The run, in all its parts, stays within its $12 cap.

A call refused for lack of credit is not an attempt and counts toward none of these: it is made again when the run resumes.

**Reported for the founder's judgment**, each per question set and never pooled into one figure:
- cost per attempt and per usable answer, and what that implies for a Starter month;
- latency (p50, p90 and the slowest call), which sets the worker deadline to propose;
- search rate and searches per run;
- vendor coverage, the share of smaller-vendor mentions with a citation nearby, and how many cited links load;
- consistency across the three repeats;
- the provider defaults each response echoes, against those of the earlier runs;
- the estimate against OpenAI's usage page;
- whether OpenAI's models endpoint lists a shutdown date for the snapshot.

**What it will not show.** It is still a small sample of 20 questions. It measures the OpenAI API, not ChatGPT.com. And it can't say how the model behaves after OpenAI retires this snapshot.

**After the run.** If every criterion holds and the founder approves, approval is a one-line change: `CHATGPT_APPROVED_SETTING_VERSION` is set to `openai-responses-websearch-v3:auto:gpt-5.4-2026-03-05`. The recorded-spend floor in the runner moves forward in the same commit that records the results.

## The half-price tier and the revised confirmation run (2026-11-17)

**The decision.**
- On 2026-11-16 the engineer explained where the benchmark's OpenAI spend had gone and proposed OpenAI's half-price flex tier. The question put to the founder: "can we run the confirmation test on the half-price tier, with the same $12 cap?"
- On 2026-11-17 the engineer relayed the founder's reply: the founder agreed, and had added OpenAI credit.
- It is recorded as the **authorisation of the confirmation run on the flex tier**: 60 runs, a $12 cap, within the lifetime ceiling. It replaces the 2026-11-13 plan, which was never run.
- It is not an approval to measure. `CHATGPT_APPROVED_SETTING_VERSION` stays `null`.

**What flex is**, from OpenAI's flex guide and pricing page, read 2026-11-17:
- **Same model, lower priority.** Flex gives "lower costs ... in exchange for slower response times and occasional resource unavailability". It is requested with `service_tier: "flex"` and is "in beta with limited model availability".
- **Price.** The `gpt-5.4` flex row is $1.25 / $0.13 / $7.50 per 1M tokens (input / cached / output), half the standard rates.
- **Not documented:**
  - whether the dated snapshot is served on flex: the flex table names `gpt-5.4`, and the run's first answer shows it;
  - whether flex works with the web search tool;
  - whether the $0.01 search-call fee or the search content tokens get the discount;
  - the error body of a capacity refusal.
- **Served tier.** OpenAI: the response's `service_tier` names "the processing mode actually used to serve the request", which "may be different from the value set in the parameter".

**What changed in the code.** No call was made.
- **A new family, `v4`:** `v3` plus `service_tier: "flex"`, sent last. Every `v2` and `v3` request is byte-for-byte unchanged.
- **The confirmation setting** is `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05`, the version to approve if this run passes.
- **The served tier is checked.** A response that names another tier, or none, is a failure, and the benchmark stops at once. That costs at most one answer at the standard rate. The check reads the stored bodies, so a capped answer from the wrong tier stops it too.
- **Cost:** the upper bound and the second figure described under "Cost, rate limits and latency". The worst case reserved per run stays at the standard rates, $0.54, because a flex request can be served and billed on another tier.
- **Capacity refusals:** not attempts. They book nothing, count as no failure, and are called again after a wait, as described under "Benchmark protocol".
- **Deadline:** 290 seconds per call on flex, against 240 seconds on the standard tier.

**The revised confirmation run (authorised 2026-11-17).**
- **Plan:** `gpt-5.4-2026-03-05` only, under `v4`. The 20 questions of both fixtures, 3 repeats each: 60 runs.
- **Dry run:** `npm run benchmark:chatgpt-models -- --models=gpt-5.4-2026-03-05 --question-set=general,smaller-vendor --repeats=3 --max-failed=3 --max-usd=12`
- **Projected cost.** These are projections from the model's 21 recorded runs (standard tier, 4,000 cap, 10 of the 20 questions), priced again as if flex had served them, with the two capped runs counted at 8,000:

  | Figure | Per run | 60 runs | A 240-run Starter month |
  |---|---|---|---|
  | Standard tier, for comparison | $0.151 | $9.05 | $36.20 |
  | Flex, upper bound (what the budget counts) | $0.128 | $7.68 | $30.72 |
  | Flex, if the input tokens are halved too | $0.100 | $5.98 | $23.93 |

- **Cap:** $12 for the whole phase, unchanged, with a $0.54 worst case reserved per run. The run stops once spend passes $11.46, which leaves room for all 60 runs unless they average more than about $0.19.
- **Failure limit:** unchanged. The phase stops at its fourth failed run. Capacity refusals are not failed runs.
- **Lifetime ceiling:** $15.35 of $40 is spent. After this run it would be at most $27.35.
- **Time:** about one to two hours, one call at a time, longer if flex is slow or busy.

**What the confirmation run must show.** These criteria are written before the run and replace those of 2026-11-13. The setting passes only if all hold:
1. **Pinned model.** Every answer is served by exactly `gpt-5.4-2026-03-05`.
2. **Tier.** Every processed response says flex served it. The run stops at the first that doesn't.
3. **Output cap.** No run stops at the 8,000-token cap. Zero of 60 supports a rate below about 5%. One or more means the cap isn't settled, and the result goes back to the founder rather than to approval.
4. **Reliability.** At least 57 of the 60 runs complete with a usable answer, and every failure is listed with its cause. Capacity refusals are not runs; they are counted and listed apart.
5. **Speed.** No call takes 240 seconds or more. A call between 240 and 290 seconds is kept and counts against this criterion; one cut off at 290 seconds does too.
6. **Request as configured.** Every stored response echoes an output cap of 8,000 and reasoning effort `low`.
7. **Budget.** The run, in all its parts, stays within its $12 cap, counted at the upper bound.

**Reported for the founder's judgment**, each per question set and never pooled into one figure:
- cost per attempt and per usable answer, as both figures, and what that implies for a Starter month;
- the estimate against OpenAI's usage page, which the founder or the engineer's contact reads, since the API reports no charged amount;
- latency (p50, p90 and the slowest call), against the standard-tier runs recorded at the 4,000 cap;
- capacity refusals: how many, and how long the run waited;
- search rate and searches per run;
- vendor coverage, the share of smaller-vendor mentions with a citation nearby, and how many cited links load;
- consistency across the three repeats;
- the provider defaults each response echoes, against those of the earlier runs;
- whether OpenAI's models endpoint lists a shutdown date for the snapshot.

**If flex fails.** If the tier is not honoured, or the speed or reliability criterion fails because of flex, the result goes back to the founder. The standard tier (`v3`) would need its own confirmation run and its own spending. None is made without a new decision.

**What it will not show.**
- It is still a small sample of 20 questions, and it measures the OpenAI API, not ChatGPT.com.
- One day's run cannot say how often flex is short of capacity at other times.
- It cannot say how the model behaves after OpenAI retires this snapshot.

## Confirmation run results (2026-11-17)

**The run.**
- **Setting:** `openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05`.
- **Plan:** the 20 questions of both fixtures, 3 repeats each: 60 runs.
- **Time:** started 2026-11-17 at 13:28 UTC and finished at 14:06 UTC.
- **Output:** `.benchmark-out/confirm-flex-1/` (git-ignored); every response body re-hashes to its recorded SHA-256.
- **Lifetime spend** is now $20.9955 of $40 over 297 runs; `BENCHMARK_SPEND_CHECKPOINT` is moved forward.
- **A failed first attempt:** it gave `--out` as a bare name and was refused before any call. The log is `confirm-flex-0-refused-out-path.log`.

**The seven criteria, all met:**

| Criterion | Result |
|---|---|
| 1. Pinned model | 60 of 60 served by exactly `gpt-5.4-2026-03-05` |
| 2. Tier | 60 of 60 responses say flex served them |
| 3. Output cap | 0 of 60 stopped at the 8,000 cap; the longest answer used 4,268 output tokens |
| 4. Reliability | 60 of 60 completed with a usable answer; 0 failed |
| 5. Speed | no call took 240 s or more; the slowest took 145 s |
| 6. Request as configured | 60 of 60 echo `max_output_tokens` 8,000 and reasoning effort `low` |
| 7. Budget | estimated $5.64 at the upper bound ($4.39 if flex also halved the input tokens), against the $12 cap |

**Reported for the founder's judgment, per question set.** Costs are estimates at the upper bound; OpenAI's usage page is the check.

| Figure | General (30 runs) | Smaller-vendor (30 runs) |
|---|---|---|
| Cost per run (all completed) | $0.061 | $0.127 |
| Latency p50 / p90 / slowest | 25 s / 42 s / 52 s | 41 s / 69 s / 145 s |
| Runs that searched | 67% | 100% |
| Search calls per run (mean) | 2.3 | 5.1 |
| Cited sources per answer (median) | 6.5 | 8 |
| Answers without a citation | 10 of 30 | 0 of 30 |
| Cited-domain stability across the 3 repeats (median) | 0.36 | 0.57 |

**Other findings.**
- **Capacity:** flex refused no request for lack of capacity, and the run waited 0 s. One afternoon says nothing about other times.
- **Retirement:** OpenAI's models endpoint returned `shutdown_date: null` for `gpt-5.4-2026-03-05` on 2026-11-17, so no retirement is scheduled.
- **Starter month:** at the mean of $0.094 per run, a 240-run Starter month on this engine is about $23 at the upper bound. The mix of questions changes this, from $0.061 to $0.127 per run.

**Not done in this run:**
- vendor coverage;
- the share of smaller-vendor mentions with a nearby citation;
- whether cited links load;
- a blind review of answer quality.

These need reading the answers or fetching third-party pages, and they are left for the founder to request.

**What it does not show:** 20 questions is a small sample. It measures the OpenAI API, not ChatGPT.com. It says nothing about flex capacity at busier times, or about this model after OpenAI retires the snapshot.

## Open items for the founder

1. ~~Confirm the benchmark budget~~: confirmed by the founder on 2026-11-11. On the same day the founder clarified that the $40 is a lifetime ceiling including earlier spend.
2. **Confirm that OpenAI's terms** permit this use.
3. ~~Choose a model~~: the founder chose `gpt-5.4-2026-03-05` on 2026-11-13.
4. ~~Authorise the confirmation run~~: authorised on 2026-11-17, on the half-price flex tier, under a $12 cap. The founder added OpenAI credit the same day.
5. **Say whether the Starter-month cost fits the plan's price**, if all 240 runs go to this engine. On the standard tier it is about $35–38; on flex it is projected at about $24–31, and the confirmation run measures it.
6. ~~Approve the model for measurement~~: approved on 2026-11-17 after the confirmation run passed; `CHATGPT_APPROVED_SETTING_VERSION` names the `v4` version.
7. **Judge whether flex's speed and capacity refusals suit the worker.** D-056 proposes the time limits (a 290 s ChatGPT call deadline; lease 330 s, readiness 240 s, runtime 2,400 s) and treats a flex refusal as a failed attempt the founder retries. These are founder decisions, not yet taken.
8. **Wire the adapter into the worker.** Phase A is built (D-056, branch `feat/chatgpt-worker`): the worker can run this setting behind `WORKER_CHATGPT_ENABLED`, which is off everywhere and refused at startup until phase B's migration. Phase B (the schema) and phase C (each production step) remain.
