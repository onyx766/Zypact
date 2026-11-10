# Adapter-validity note: ChatGPT engine (OpenAI Responses API with web search)

- **Status:** Draft for founder approval (D-050). The adapter is built and tested offline. It is **not wired into any worker**, no live call has been made, and the paid-measurement switch stays off.
- **Required by:** METHODOLOGY §4, "Adding another surface".
- **Adapter:** `lib/probes/chatgpt.ts`
- **Measurement setting:** `openai-responses-websearch-v1`
- **Protocol provider value:** `openai_chatgpt`
- **Tests:** `npm run test:chatgpt-adapter`
- **Date:** 2026-11-10

## What is measured

Each measured question is sent as one request to OpenAI's developer API:

- endpoint: `POST https://api.openai.com/v1/responses`;
- model: `gpt-5-mini`, still awaiting founder approval;
- tool: the `web_search` tool, with `tool_choice: "auto"`;
- reasoning effort: `low`;
- output cap: 4000 tokens, which includes reasoning tokens;
- `store: false`;
- no instructions, no conversation history and no previous response.

The buyer question is sent exactly as approved, with no brand, domain or project context. That is the same integrity rule as Perplexity Sonar.

The plan catalogue shows this engine to customers as "ChatGPT". Every client-facing artifact that uses it must show the limitation statement below.

## Interface type

This is OpenAI's **public developer API**, called with a Zypact-held API key. It is not:

- the ChatGPT consumer app;
- ChatGPT Search as a signed-in user sees it;
- a tenant-specific ChatGPT Enterprise or Team workspace;
- a custom GPT.

The app and the API differ in system instructions, model routing, memory, personalisation, location signals and the search pipeline. Zypact cannot observe any of those for the app.

## Injected context

The API request carries only the buyer question. OpenAI may still add context Zypact neither controls nor sees:

- OpenAI's own default behaviour and safety policies for the model;
- the search tool's choice of queries, of the index it searches, and of which results it returns;
- an approximate location inferred from the calling server. No `user_location` is sent, so results may follow the region of Zypact's infrastructure.

There is no account memory or personalisation, because no user account is involved.

## Request and response provenance

The same evidence contract as Sonar applies.

For every attempt:

- the exact serialized request body and its SHA-256;
- the trimmed question and its SHA-256;
- the exact response body text, captured before parsing, and its SHA-256;
- the HTTP status;
- latency;
- the `x-request-id` header;
- the served model, either the approved name or a dated snapshot of it, such as `gpt-5-mini-2025-08-07`.

Sources follow D-044 and keep cited and retrieved apart:

- **Cited sources** are the URLs of `url_citation` annotations in the answer.
- **Retrieved sources** are the `web_search_call` sources (requested via `include: ["web_search_call.action.sources"]`) plus every cited URL. OpenAI can cite a URL that its sources list omits; that URL was still retrieved.
- A retrieved-only URL is never reported as cited.

Failures carry the full evidence and are never partial successes. They include:

- a non-JSON body;
- a body that is not a Responses object;
- a present `error`;
- a status other than `completed`, including `incomplete` when the output cap is reached;
- a missing id;
- a missing or unexpected served model;
- empty output text, including a refusal with no text;
- an HTTP error, a network error or a timeout.

An answer given without any web search, or without citations, is recorded as an observation and is not a failure.

## Reproducibility limits

- Responses are sampled and vary between runs of the same question. A single run is not a stable result; the sampling rules in METHODOLOGY §7 apply unchanged.
- No temperature is set because the reasoning models reject one, so sampling variation can't be reduced through that setting.
- `tool_choice: "auto"` lets the model decide whether to search. How often it searches is itself variable and is recorded per run (the number of `web_search_call` items in the stored body).
- The web index and search results change over time. A later retest observes a different web, which is a confounder (METHODOLOGY §14).
- OpenAI can update a model behind its undated name. The served dated snapshot is recorded on every run, so a change of snapshot is visible.
- `store: false` means OpenAI does not keep the response for later retrieval. Zypact's stored copy is the only record.

## Terms and policy constraints

Before going live, the founder must confirm all of the following:

1. **OpenAI usage policies and terms.** The use is sending public buyer-style questions and recording the answers for measurement. The founder confirms this is permitted for Zypact's account type.
2. **Data controls.** `store: false` is set. The founder decides whether the OpenAI organisation should also be opted out of data sharing.
3. **Separate key.** The adapter reads only `OPENAI_PROBE_API_KEY`. It never reads the `OPENAI_API_KEY` used for analysis, so that key's presence can't switch measurement on. Keeping measurement spend separate from analysis spend also needs a separate OpenAI project with its own key and budget limit.
4. **Naming.** "ChatGPT" is an OpenAI trademark. Customer copy uses it only to identify the engine, alongside the limitation statement. It never implies an affiliation.

## Cost, rate limits and latency

Not yet measured; no live call has been made.

- **Cost.** OpenAI bills input and output tokens, with reasoning tokens counted as output, plus a separate per-call fee for the web search tool. The Responses API reports token usage but not a charged amount. Unlike Perplexity's `usage.cost`, there is no measured cost in the response, so a cost basis must be estimated from token counts and a price table. That table must be versioned and is a founder decision under the D-023 spend rules. Until one exists, the cost of a ChatGPT run is **unknown**, never zero.
- **Rate limits.** Rate limits depend on the OpenAI account's usage tier. They are set per organisation and project, and the founder must check them for the project that holds the key.
- **Latency.** Latency with web search and reasoning is expected to run from several seconds to tens of seconds. The worker's per-attempt deadline must be set from staging measurements before go-live.

Staging must record cost per run, latency percentiles and the search rate over a small approved sample before this engine is offered.

## Comparability with existing surfaces

- A ChatGPT result is **not comparable** to a Perplexity Sonar or Perplexity Agent result. They differ in provider, endpoint, model, search pipeline and request shape. Results are never pooled across engines, and a retest compares only against a baseline taken with the same provider and the same measurement setting version.
- Two ChatGPT results are directly comparable only under the same setting version (`openai-responses-websearch-v1`). Different dated snapshots must be disclosed as a measurement condition.
- Showing engines side by side is allowed only as separate, labelled results. Each one keeps its own denominator and uncertainty.

## Required limitation

Every client artifact that includes this engine must state:

> This is a directional measurement of OpenAI's API with web search (shown as "ChatGPT") under the recorded conditions. It is not what users of the ChatGPT app see, and it does not represent every AI system.

## Open items for the founder (D-050)

1. **Approve the model** (`gpt-5-mini` is the engineer default) and the reasoning effort.
2. **Approve `tool_choice: "auto"`**, which is closer to app behaviour, rather than `"required"`, which makes every answer search-based.
3. **Confirm the terms and data-control points** above.
4. **Approve a versioned token price table**, or accept that ChatGPT runs have an unknown cost until one exists.
5. **Approve this note.** Wiring the adapter into the worker, and any live call, remain separate steps.
