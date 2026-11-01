# Buyer Question Intelligence

- **Status:** Planning baseline (D-039). Not implemented. No migration, code or paid call is authorised by this document.
- **Scope:** how Zypact proposes buyer questions from a website URL and buyer evidence, and how the customer approves them as frozen question versions before any baseline.
- **Owner:** Founder/CEO. Each step in section 10 needs its own authorisation.
- **Last updated:** 2026-10-31
- **Separate from:** the PG-9 spend gate (D-037). Nothing here touches a paid path, and the PG-9 spending HOLD stays in force.

## 1. The problem

Buyer feedback: the questions Zypact measures must reflect how buyers describe their own problems, not how sellers describe their products. Today:

- the public request form takes one website URL and one free-text question (`lib/snapshot-requests/public-form.ts`, field `buyerCategory`);
- founder approval calls `approve_and_launch_snapshot_baseline`, which turns that text into question version 1 with provenance `customer_supplied`, approves it, creates and approves a protocol, and enqueues one baseline job, all in one transaction (0062, last redefined in 0069);
- the only automated question generator, `lib/pipeline/generate-buyer-prompts.ts`, writes questions from the Site Reader's reading of the seller's own copy, keeps no sources, and is refused by `legacyPipelineRefusal`.

Nothing in the repository collects, stores or attributes buyer wording, or records who the customer's buyers are.

## 2. What is reused

| Existing piece | Reused as |
|---|---|
| `buyer_questions`, `buyer_question_versions` (0047, 0048): immutable versions, insert-only for `service_role`, approval by RPC, numeric fields `commercial_value` (1–5), `winnability` (1–5), `priority` (1–25) | The frozen approved question. Unchanged. |
| `approve_buyer_question_version` (0047) and the TypeScript prompt-hash authority | The approval primitive inside a new set-approval RPC. |
| `approve_protocol`, `enqueue_protocol_execution_job` and the protocol shape used by `approve_and_launch_snapshot_baseline` | Reused by a separate operator launch that starts from an existing approved version (section 8). |
| `approve_and_launch_snapshot_baseline` | Unchanged for single-question requests. Refuses requests enrolled in the new flow (section 8). |
| `lib/crawler/crawl-site.ts` (no paid call) | Site context: brand and product names, the seller's own wording for the marketing-language review signal, and a first draft of the ICP for the founder to confirm. |
| Email verification tokens stored as hashes (0019), `createPublicReportToken` (32 random bytes), email delivery in `lib/snapshot-requests/verification-email-delivery.ts` | The patterns for the review invitation, its session and its delivery, in their own tables and with their own purpose. |
| Site Reader (`lib/agents/site-reader.ts`, a paid LLM call) | Not used. A paid call before approval is not authorised (Q-D1), and it reads seller copy. |
| `generate-buyer-prompts.ts` | Not used. |

## 3. Decisions

### Founder rulings (D-039)

- **Q-D1:** founder-curated and customer-supplied buyer evidence first. No paid research call before a separately approved, ledgered research budget.
- **Q-D2:** only permitted, attributable sources. No new Perplexity or other paid research provider.
- **Q-D3:** six candidates at most and up to three approved questions, by default two unbranded and one branded accuracy where evidence and relevance support them. Fewer are returned when they are not supported.
- **Q-D4:** respect source terms, privacy and access restrictions. Keep short attributable excerpts without unnecessary personal data.
- **Q-D5:** "observed" needs an actual buyer-authored question. A review describing a problem is not an observed question. Seller copy cannot establish buyer wording. Adapted and hypothesis stay clearly distinguished.
- **OD-1, customer-provided observations:**
  - a documented, anonymised buyer question from customer-supplied material may be labelled "Observed — customer-provided";
  - it stays distinct from "Observed — verified source";
  - an unsupported assertion never receives an observed label;
  - provenance and verification status are kept throughout.
- **OD-2, launch:**
  - the customer may approve up to three frozen questions;
  - for the first V1 execution, only one question may launch;
  - that question is explicitly selected by an operator, and launches only after PG-9 and the relevant execution gates are approved;
  - the other approved questions stay inactive;
  - nothing creates paid jobs for all three.
- **OD-3, approver identity:** an approval-grant id may populate `approved_by` only if the grant is a durable authorisation record bound to a verified customer email, the correct request and the correct project. The grant id is not the customer's identity. Customer question approval is never operator approval of paid execution.
- **OD-4, customer access:**
  - a seven-day, revocable review invitation, exchanged once for a scoped session;
  - token values are never stored: tokens are stored as hashes and verified email addresses as keyed HMACs (section 9);
  - invitations can be revoked and reissued, and they are kept separate from report-access and email-verification tokens.
- **OD-5, excerpts:** 300 characters is an absolute maximum, not a target; shorter is preferred. Each excerpt respects source rights and terms, avoids unnecessary personal data, and keeps the source URL (or customer-material reference) and the retrieval date.

### Confirmed values

- **Session lifetime:** 30 minutes, absolute, and never later than the invitation's expiry.
- **Session idle timeout:** 15 minutes since the last authenticated request.
- **Revocation:** a session becomes invalid immediately when its invitation is revoked. Every session request rechecks the invitation; nothing is cached.

### Direction

Automated Buyer Language Research remains a core product objective. It follows the manually curated validation phase (Q1–Q4b), and needs a separately approved, ledgered research budget and its own authorisation (Q5).

## 4. Evidence grades, origins and wording classification

Three separate facts are recorded, and none stands in for another:

1. **The candidate's evidence grade:** fixed when the founder curates the candidate. It is never changed afterwards.
2. **The approved version's origin:** how the customer arrived at the approved text. One of `recommended_unchanged`, `recommended_edited`, `replaced_with_candidate` or `customer_written`. **Editing is an origin, never an evidence grade.**
3. **The wording classification:** the evidence grade of the exact approved text, assessed independently of the candidate it came from.

### Evidence grades

| Grade | Verification | Requires | Customer-facing label | May be preselected |
|---|---|---|---|---|
| `observed` | `public_verifiable` | An actual buyer-authored question, quoted as written from a public source anyone can check. Only whitespace and terminal punctuation may differ. | "Observed — verified source", with the link, excerpt and retrieval date | Yes |
| `observed` | `customer_provided` | An actual buyer-authored question, quoted as written from documented, anonymised material the customer supplies (a transcript, ticket, survey response or interview note), with the customer's attestation that the text is buyer-authored. Only whitespace and terminal punctuation may differ. | "Observed — customer-provided", with the material reference, excerpt and date received | Yes |
| `adapted` | either | A question reworded from cited buyer-authored language, such as a review or post that describes the problem. Names its sources and states what changed. Any change to an observed question beyond whitespace and terminal punctuation, including removing a name or brand, makes it adapted. | "Adapted from buyer language", with links or references, excerpts and the change made | Yes |
| `hypothesis` | none | No supporting buyer-authored source. This includes a customer's assertion about what buyers ask that is not backed by documented material. | "Our hypothesis: not found in buyer sources" | **No** |

Rules:

- Seller-authored text (the customer's site, a competitor's site, press releases, vendor documentation) can be attached only as **context**. It can never be the source of an observed or adapted question.
- A review or post that describes a problem without asking a question can support an `adapted` question, never an `observed` one.
- A grade and its verification status are set by the evidence links, not by a model or a score. The marketing-language review signal (section 6) never raises a grade, and passing it is not evidence of authenticity.
- "Observed — customer-provided" is never shown, stored or reported as independently verified.
- No customer-facing text says a question is one "buyers ask" or a "real buyer question". Even an observed question is shown as wording found in a named source or in named customer material.

### Classifying the exact approved wording

At approval, the exact approved text is classified by these deterministic rules, in order. The result is written to an append-only classification record (section 9).

1. **Unchanged candidate** (`recommended_unchanged` or `replaced_with_candidate` with no edit): the wording inherits the candidate's grade and verification, because the text is identical.
2. **Exact match to a buyer source:** the text matches, apart from whitespace and terminal punctuation, a buyer-authored question in a source linked to the candidate (or, for a customer-written question, any buyer-authored source in the research set). It is classified `observed`, with that source's verification.
3. **Anything else:**
   - an edited candidate that no longer matches a source;
   - a customer-written question that matches no source.

   The wording is classified **`pending_review`**: a classification status, not an evidence grade. The founder then records `adapted` (citing the buyer-authored basis and the change) or `hypothesis`, in a new classification record that never alters the first.

Consequences:

- An edited observed question is never shown or stored as observed unless rule 2 holds for its exact new text.
- A customer-written question is recorded with provenance `customer_supplied`; its wording is a hypothesis until a buyer-authored source supports it.
- **A question whose wording is `pending_review` cannot be selected for launch.** A question classified `hypothesis` can be launched only with an explicit operator acknowledgement, stored on the launch selection.
- Customer-facing labels for an approved question show its origin and its wording classification, for example "Edited by you · Adapted from buyer language" or "Written by you · Evidence review pending".

### Proposed replacement for METHODOLOGY.md, "### Provenance"

> ### Provenance
>
> Question provenance may be:
>
> - customer-supplied call or CRM evidence;
> - RFP, objection, win/loss interview, support, or product-marketing material;
> - founder/user-supplied question;
> - model-assisted suggestion reviewed and approved by a human;
> - public category benchmark question.
>
> Question provenance affects relevance. It does not prove that every buyer asks the question.
>
> Each candidate question also carries an evidence grade and a verification status.
>
> - **Observed** means an actual buyer-authored question, quoted as written. It is either from a public source anyone can check (*Observed — verified source*), or from documented, anonymised material the customer supplied and attested (*Observed — customer-provided*). The latter is not independently verified.
> - **Adapted** means a question reworded from cited buyer-authored language, with the change stated.
> - **Hypothesis** means no supporting buyer source, including an undocumented assertion about what buyers ask. A hypothesis is never preselected.
>
> Seller-authored material, including the customer's own website, cannot establish buyer wording, and a review that describes a problem is not an observed question.
>
> An approved question records how it was reached (unchanged, edited, replaced or written by the customer) separately from the evidence classification of its exact wording, which is assessed on its own. Editing never alters the original candidate, its sources or its grade. See `BUYER_QUESTION_INTELLIGENCE.md`.

## 5. Sources

- **Allowed source kinds (initially):**
  - `customer_material`: documented material the customer supplies, such as call transcripts, support tickets, survey responses or interview notes;
  - public community Q&A and forums, where their terms permit quoting;
  - public review sites, where their terms permit quoting;
  - publicly available analyst or industry text;
  - `site_copy`, as context only.
- **Collection:** done by the founder, or supplied by the customer. Nothing is crawled automatically. No source is fetched behind a login, paywall or access restriction, or against its terms or robots rules.
- **What is kept for each source:**
  - its kind;
  - for a public source, its URL, publisher and title;
  - for customer material, a customer-assigned reference (never the document itself) and the customer's attestation;
  - the retrieval date (or the date received) and who added it;
  - the excerpt and its SHA-256;
  - a confirmation that personal data has been removed.
- **Excerpts:** 300 characters is an absolute maximum, not a target. Keep only the words needed to show the buyer's wording, usually the question itself. Respect each source's rights and terms. Anonymise customer material before it is stored.
- **Personal data:** names, usernames, profile links, email addresses, company names of individual buyers and other identifying details are removed before storage. A source cannot be saved until the personal-data check is confirmed.
- **No manufactured evidence:** a source, excerpt or candidate is never invented, completed or "improved" to reach six candidates.

## 6. Relevance and recommendation

Evidence answers "is this wording the buyer's?". Relevance answers "is this the right question to measure for this customer?". A recommendation needs both.

### The ideal customer profile (ICP)

Each research set records the ICP the recommendation is judged against:

- **Target buyers:** the roles that research, evaluate or buy.
- **Companies:** segment and size, industries and regions.
- **Exclusions:** buyers or segments the customer does not serve.
- **Problems:** the problems the product solves, in plain terms.
- **Provenance:** for each item, confirmed by the customer, or drafted by the founder from the site crawl and not yet confirmed.

The customer sees the ICP summary on the review page. If it is wrong, the founder corrects it in a new research set, and the recommendation runs again. Nothing is ranked against an ICP the customer has rejected.

### Relevance assessments (founder-assigned in the curated phase)

Each candidate gets four ratings from 0 to 3, each with a one-line reason:

| Dimension | 0 | 3 |
|---|---|---|
| **Buyer relevance:** would someone in a target buyer role plausibly ask this while working on the problem? | asked by someone outside the target roles, or no plausible asker | clearly the target buyer's question |
| **ICP fit:** does the situation in the question match the customer's segments, industries and regions? | an excluded or unserved segment | a core segment |
| **Commercial intent:** how close is the asker to choosing a solution? | general curiosity or education | evaluating or shortlisting vendors, or ready to buy |
| **Product relevance:** does the question concern a problem the product actually solves? | unrelated to the product | the product's central use case |

The ratings are review judgements recorded with their reasons, not measurements.

### Selection

- **Eligibility for preselection.** Every condition must hold:
  - evidence grade `observed` or `adapted`;
  - buyer relevance, ICP fit and product relevance each at least 2;
  - commercial intent at least 1;
  - no unresolved marketing-language flag;
  - brand rules satisfied: an unbranded candidate may not contain the brand or product names, and a branded-accuracy candidate must contain the brand.
- **Ranking among eligible candidates:**
  1. the sum of the four relevance ratings (0–12);
  2. evidence (observed before adapted, regardless of verification status);
  3. the curator's rank.
- **Composition:**
  - up to two unbranded questions, the second chosen to cover a different buying stage or intent where an eligible one exists;
  - up to one branded-accuracy question.

  Unfilled slots stay empty and are explained.
- **Hard rules:**
  - a `hypothesis` is never preselected;
  - an `observed` candidate without a verbatim buyer-authored source, or an `adapted` candidate without a cited buyer-authored basis, is invalid and cannot be shown;
  - fewer than six candidates are shown when fewer are supported.
- **Duplicates:** candidates are compared on normalised text (case, whitespace, punctuation, brand placeholder) and on token overlap. Exact duplicates are merged, keeping every source link. Near duplicates (token similarity of 0.8 or more) are flagged and only one may be preselected.
- **The marketing-language review signal** flags, without changing the grade:
  - superlatives and stock seller phrases ("best-in-class", "all-in-one", "seamless", "leading", "AI-powered platform");
  - feature-list phrasing;
  - high overlap with the crawled site copy.

  A flagged candidate is not preselected until the curator resolves the flag with a recorded reason, and resolving it still requires a buyer-authored source. Passing the signal is not evidence of authenticity.
- **Explanation:** each card states its grade, verification status, the four ratings with their reasons, and the rule that preselected or excluded it.
- **Mapping to the existing version fields** (a provisional heuristic):
  - `commercial_value` = 1 + commercial intent, plus 1 if ICP fit is 3 (range 1–5);
  - `winnability` = 1 + product relevance, plus 1 if the wording is observed (range 1–5);
  - `priority` = `commercial_value` × `winnability`, capped at 25;
  - `rationale` summarises the four reasons.

  These numbers only translate the curator's ratings into the fields the existing schema requires, so that versions can be sorted consistently. They are **not** validated measures of commercial value, of the chance of winning a deal, or of the probability that an AI assistant recommends the customer, and must never be presented to a customer or in a report as any of those. Replacing the heuristic needs evidence and its own decision.

## 7. Flow

1. **Request:** the customer enters a website URL and, optionally, their own question. A request is enrolled in this flow by the founder (section 8). Public-form requests keep email verification. Founder-created requests (0081) have no verified address until the invitation is exchanged (step 6).
2. **Site context:** a crawl of the customer's site (no paid call) gives the brand and product names, the seller's own wording, and a first draft of the ICP.
3. **Curation (founder):**
   - the founder confirms the ICP with the customer where possible;
   - records sources and up to six candidates, each with its grade, verification, evidence links and four relevance ratings;
   - the customer may also supply documented buyer material for the founder to grade;
   - the validator shows its findings: question shape, missing evidence, duplicates, brand rules, the marketing-language signal and eligibility.
4. **Recommendation:** the deterministic selector preselects up to three (section 6).
5. **Invitation:** the founder issues a seven-day review invitation to the request's email address.
6. **Session:** the customer opens the link. The invitation token is exchanged, once, for a session scoped to that request, project and research set.
   - For a founder-created request, this exchange is also the proof that the customer controls the address. It records the address's HMAC as verified on the invitation.
   - The invitation cannot be exchanged again.
   - The session ends after 30 minutes, after 15 minutes idle, or as soon as the invitation is revoked.
7. **Review:** the customer sees the ICP summary and up to six cards.
   - Each card shows its grade label, source links or references with excerpts, question kind, relevance ratings and reasons, and why it was or was not preselected.
   - Actions: keep, edit, swap in another candidate, write their own, or remove, up to three questions in total.
8. **Confirmation:** the customer sees the exact final texts and each one's origin (unchanged, edited, replaced, or their own), then approves.
9. **Frozen:** each approved question becomes an approved, immutable question version, with its origin and wording classification.
   - The page shows each version number and short hash, and states plainly that approval does not start any measurement.
   - Wordings classified `pending_review` show "Evidence review pending".
   - A later change creates a new version and never alters an approved one.
10. **Wording review (founder):** every `pending_review` wording is classified `adapted` or `hypothesis` in a new record.
11. **Launch (operator only):** an operator explicitly selects one approved question, whose wording is not `pending_review`, and launches it through the separate launch path (section 8). It runs only after PG-9 and the relevant execution gates are approved. The other approved questions stay inactive.

### Pilot recovery when a session has ended

The invitation is single-use, so once a session ends (30 minutes, 15 minutes idle, or revocation) the same link cannot open a new one. In the pilot:

1. **What the customer sees:** the session-ended page says:
   - "Your review session has ended. Anything you approved is saved. Changes you had not approved yet were not saved.";
   - "To continue, reply to the invitation email or contact us, and we will send you a new link.";
   - nothing about the account, address or request.
2. **Founder reissue:** the founder reissues the invitation from admin, for the same request and research set, to the same address. Reissuing:
   - revokes the previous invitation, which ends any session still open from it;
   - creates a new seven-day invitation and sends it.

   The founder can see whether the earlier invitation was exchanged, when, and whether a set was approved, but never a token value.
3. **What carries over:**
   - **an approved set:** stays approved. The new link opens it read-only, and replaying the same approval returns the same versions;
   - **unapproved edits:** were never stored on the server. The page may keep an unapproved draft in the customer's own browser, keyed to the research set, purely as a convenience. A new session can offer to restore it, but the customer must review and confirm again, and the server never relies on it.
4. **Warnings before expiry:** the page warns two minutes before the idle timeout and five minutes before the absolute limit, and offers to keep the session active. That extends only the idle timer, never the 30-minute limit.

A self-service "send me a new link" button is a later step. It would be rate-limited, send only to the address already on the request, and give the same response whether or not a request exists.

## 8. Coexistence with migration 0062

`approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)` (0062, redefined in 0063 and 0069) is the founder's one-step path for a single-question request. In one transaction it:

- locks the request (which must be `pending_approval`) and validates competitors;
- creates question version 1 from `buyer_category` (provenance `customer_supplied`) and approves it;
- creates the protocol and approves it;
- enqueues the job;
- marks the request `approved`.

That enqueues paid work, so it must never be reachable from a customer approval.

**How the two flows are kept apart:**

| Concern | Single-question requests (unchanged) | Requests enrolled in Buyer Question Intelligence |
|---|---|---|
| Enrolment | No row in `bqi_enrollments` | One row in `bqi_enrollments`, written by the founder before curation; append-only, one per request |
| Question approval | Inside `approve_and_launch_snapshot_baseline`, by the founder | `approve_buyer_question_set`, by the customer through a session. It writes questions, versions, origins, classifications and the grant only. It never writes `protocols`, `protocol_execution_jobs` or `snapshot_requests.status` |
| Protocol creation and enqueue | Inside `approve_and_launch_snapshot_baseline` | `launch_selected_buyer_question`, a new operator-only function (below) |
| `approve_and_launch_snapshot_baseline` called on the request | Works exactly as today | Refused (`request_uses_buyer_question_flow`), with no writes |

**`launch_selected_buyer_question(p_request_id, p_selection_id, p_operator_id, p_competitors)`** (planned for Q4b; not authorised):

- **Preconditions:**
  - the request is enrolled and `pending_approval`;
  - the selection belongs to this request and names an approved version from this request's approved set;
  - that version's latest wording classification is not `pending_review`, and a `hypothesis` wording carries the operator's acknowledgement;
  - `p_operator_id` is a valid uuid and is not the id of any approval grant.
- **What it does,** in one transaction:
  - validates competitors exactly as the existing function does;
  - creates the protocol from **the existing approved version**, never creating or approving a new question version;
  - approves the protocol with the operator's id;
  - enqueues the job;
  - marks the request `approved`.

  These are the same steps, protocol shape and run plan as `approve_and_launch_snapshot_baseline`, minus question creation.
- **Limits:**
  - one launch per request while three paid protocols are unauthorised; a second launch is refused;
  - the other approved versions stay without a protocol;
  - it makes no provider call. The worker spends only when started, under the PG-9 gate and the spend controls.

**Enrolment and the request lock.** Enrolment and the legacy launch both act on one `snapshot_requests` row, so they are serialised on that row:

- **`enroll_snapshot_request_in_bqi(p_request_id, p_founder_id)`** (planned for Q2; not authorised) runs in one transaction:
  1. It locks the request row with `update public.snapshot_requests set updated_at = now() where id = p_request_id and status = 'pending_approval' and protocol_id is null returning id`. This takes the same row lock that `approve_and_launch_snapshot_baseline` takes with `select … for update`, and it writes the row, so a REPEATABLE READ or SERIALIZABLE caller whose snapshot predates the enrolment fails with a serialisation error instead of reading past it.
  2. If no row is returned (missing, not `pending_approval`, or already launched), it raises `request_not_enrollable` and writes nothing.
  3. It inserts the `bqi_enrollments` row. If one already exists, it returns that row unchanged (idempotent).

  Updating `updated_at` is the only change enrolment makes to an existing table's row.
- **The legacy function's check** is placed immediately after its existing `select … for update` on the request row and its not-found return, before the idempotent-replay branch, competitor validation, and every question, protocol and job write. It is a separate statement after the lock. Under READ COMMITTED it therefore sees an enrolment committed while it waited.
- **`launch_selected_buyer_question`** takes the same row lock first, then requires the enrolment.

**Why both can never succeed, whichever starts first:**

| Order | What happens |
|---|---|
| Enrolment takes the row lock first | The legacy call waits on the lock. When enrolment commits, the legacy call gets the lock, its check sees the enrolment, and it raises `request_uses_buyer_question_flow` before writing anything. If enrolment rolls back instead, the legacy call proceeds exactly as today. |
| The legacy call takes the row lock first | Enrolment waits. When the legacy call commits, the request is `approved` with a protocol, so enrolment's `update … where status = 'pending_approval' and protocol_id is null` matches nothing and raises `request_not_enrollable`. If the legacy call fails or rolls back, enrolment proceeds. |
| Either one under REPEATABLE READ or SERIALIZABLE | Both write the request row, so whichever commits second fails with `40001` if the other committed after its snapshot, instead of acting on a stale view. |

**The one change to an existing function.** Q2 redefines `approve_and_launch_snapshot_baseline` with the single enrolment refusal placed as described above. Every other line is copied verbatim from its latest definition (0069), following the 0083 precedent. A schema-contract test asserts the copy is verbatim apart from that check, and that the check comes after the `for update` statement and before the first `insert`. The existing tests for single-question requests must pass unchanged.

**Compatibility rules:**

- `snapshot_requests.buyer_category` stays required, because the public form and 0081 enforce it. For an enrolled request it is offered to the customer as "Your question", a customer-written option. If chosen, it is approved like any customer-written question, and its wording is classified under section 4.
- Requests created before this change are never enrolled automatically.
- Reports, delivery and retests keep reading the protocol and its approved version exactly as today. A protocol launched through the new path references a version created through the new path, and nothing downstream distinguishes them.

## 9. Data model and approval (planned for steps Q2 and Q4b; not authorised)

New tables, three new functions (enrolment, set approval, launch), and the one-check redefinition in section 8. No existing table's columns change. The only write to an existing table's rows is enrolment's update of `snapshot_requests.updated_at`, used as the row lock.

**Enrolment, ICP and evidence**

- **`bqi_enrollments`** (append-only): `snapshot_request_id` (primary key), `project_id`, `enrolled_by`, `enrolled_at`. Written only by `enroll_snapshot_request_in_bqi`, under the request row lock.
- **`question_research_sets`** (append-only; a correction creates a new set that supersedes the old one):
  - `id`, `project_id`, `snapshot_request_id`, `supersedes`;
  - `site_context` (a hash and summary of the crawl);
  - `icp` (target buyers, companies, exclusions, problems, each with its provenance);
  - `created_by`, `created_at`.
- **`question_sources`** (append-only):
  - `id`, `project_id`, `source_kind`;
  - `url`, `publisher`, `title` (public sources);
  - `customer_reference` and `customer_attested_at` (customer material);
  - `retrieved_at`;
  - `excerpt` (at most 300 characters) and `excerpt_sha256`;
  - `buyer_authored`, `verification` (`public_verifiable` or `customer_provided`);
  - `personal_data_removed` (must be true), `added_by`, `created_at`.

  Constraints:
  - a public source needs a URL;
  - customer material needs a reference and an attestation;
  - `site_copy` is never `buyer_authored`.
- **`question_candidates`** (append-only):
  - `id`, `research_set_id`, `project_id`;
  - `candidate_text`, `normalized_hash`;
  - `evidence_grade`, `verification`, `question_kind`;
  - `buyer_relevance`, `icp_fit`, `commercial_intent`, `product_relevance` (each 0–3) with their reasons;
  - `intent`, `buyer_stage`, `persona`, `adaptation_note` (required for `adapted`);
  - `review_flags`, `flag_resolution`, `curator_rank`;
  - `preselected`, `selection_reason`;
  - `created_by`, `created_at`.
- **`question_candidate_sources`** (append-only): `candidate_id`, `source_id`, `relation` (`verbatim`, `paraphrase_basis` or `context`), and the quoted span. Database rules:
  - an `observed` candidate needs a `verbatim` link to a buyer-authored source, and its `verification` equals that source's;
  - an `adapted` candidate needs a `paraphrase_basis` link to a buyer-authored source;
  - `site_copy` may only be linked as `context`.

**Customer access**

Token values are never stored.

- **Tokens:** each is 32 random bytes. Only a SHA-256 is stored, computed over a purpose label and the token, so a hash of one token type can never match another. That is sufficient because the tokens are random and long, not guessable.
- **Email addresses:** stored only as an HMAC-SHA-256, keyed with a server-held secret and taken over the normalised address. This prevents an address being confirmed by hashing a guess. The key lives only in the application's server environment, never in the database, logs or repository, and is referred to by a key id stored beside each HMAC so keys can be rotated. Retired keys are kept for comparison until every invitation using them has expired. The database stores and compares HMACs; the application computes them.
- **Separation:** these tables are separate from report-access tokens and email-verification tokens.
- **`question_review_invitations`**:
  - `id`, `project_id`, `snapshot_request_id`, `research_set_id`;
  - `email_hmac`, `email_hmac_key_id` (the request's address);
  - `email_verified_at`, set at exchange for a founder-created request, or copied from the request's existing verification;
  - `token_hash`, `expires_at` (issued + 7 days);
  - `exchanged_at` (single use), `revoked_at`;
  - `superseded_by` (a reissue revokes the previous invitation);
  - `issued_by`, `created_at`.
- **`question_review_sessions`**:
  - `id`, `invitation_id`;
  - `project_id`, `snapshot_request_id`, `research_set_id` (copied from the invitation, never from the request);
  - `token_hash`;
  - `absolute_expires_at` (exchange + 30 minutes, never later than the invitation's expiry);
  - `last_seen_at` (idle limit 15 minutes);
  - `revoked_at`.

  Every request checks, in the same query, that the session is unexpired and unrevoked, that it was seen within 15 minutes, and that its invitation is unrevoked. A revocation therefore takes effect on the next request.

**Approval authorisation**

- **`question_approval_grants`**: the durable authorisation record. One row is written inside the approval transaction:
  - `id`, `session_id`, `invitation_id`;
  - `project_id`, `snapshot_request_id`, `research_set_id`;
  - `verified_email_hmac`, `email_hmac_key_id`. These equal the invitation's; the approval is refused if the request's address has changed since the invitation was issued;
  - `scope` = `approve_buyer_questions` (only);
  - `idempotency_key`, `set_fingerprint`, `approved_at`.

  This grant id populates `buyer_question_versions.approved_by`. It identifies the authorisation event, not the person; the customer's identity is the email HMAC on the grant, a separate field. The grant authorises question approval and nothing else.
- **`buyer_question_version_origins`** (insert-only, one row per approved version):
  - `version_id`, `candidate_id` (nullable for a customer-written question), `grant_id`;
  - `origin`: `recommended_unchanged`, `recommended_edited`, `replaced_with_candidate` or `customer_written`;
  - `candidate_grade`, `candidate_verification` (copied from the candidate, for the record);
  - `candidate_text_hash`, `approved_text_hash`.
- **`approved_wording_classifications`** (append-only; the latest row per version is current):
  - `id`, `version_id`;
  - `classification`: `observed`, `adapted`, `hypothesis` or `pending_review`;
  - `verification`, and the basis source links;
  - `rule`: `inherited_unchanged`, `exact_source_match` or `founder_review`;
  - `adaptation_note` (required for a founder-reviewed `adapted`);
  - `classified_by`, `classified_at`.

  The approval transaction writes the first row by the rules in section 4. Later rows come only from the founder's review.

**Launch**

- **`buyer_question_launch_selections`** (append-only):
  - `id`, `project_id`, `snapshot_request_id`, `version_id`;
  - `selected_by` (an operator, never a grant);
  - `hypothesis_acknowledged`;
  - `selected_at`, `reason`.

  It is unique per request while three paid protocols are unauthorised.

**The set-approval RPC (`approve_buyer_question_set`)**

- **Secure:**
  - the route accepts only a session token;
  - the RPC checks the session hash, absolute and idle expiry, and that the session and its invitation are unrevoked;
  - it refuses any other token type, because the purpose label differs;
  - it gives one uniform refusal with no detail;
  - requests are rate-limited at the route.
- **Project-scoped:**
  - every candidate, source and question in the request must belong to the session's project and research set;
  - the request must be enrolled;
  - the request's current address HMAC must equal the invitation's.

  Anything else is refused.
- **All or nothing:** one transaction writes the grant, the 1–3 questions and versions, their origin rows, their first wording classifications and their approvals. Every failure rolls back everything.
- **Idempotent:**
  - the caller sends an idempotency key, and the set is fingerprinted, as in D-021;
  - replaying the same key and fingerprint returns the original result;
  - the same key with a different set is refused;
  - once a research set has an approved set, only that exact set replays, from any session.
- **Exact text:** the application computes each `prompt_hash` from the exact text shown on the confirmation screen. The RPC refuses a duplicate hash within the set, and refuses a text that does not match its stated origin: an unchanged candidate must match the candidate's hash.
- **Provenance and version fields:**
  - recommended and replaced candidates are stored as `founder_supplied`, and customer-written questions as `customer_supplied`;
  - no candidate is ever stored as `customer_supplied`, and nothing is stored as `model_assisted_reviewed` until a model is involved;
  - `commercial_value`, `winnability`, `priority` and `rationale` follow the mapping in section 6. A customer-written question takes its ratings from the founder's later review; until then it uses the lowest valid values (1, 1, 1) and the rationale "awaiting review".
- **No paid effect:** approval writes nothing to `protocols`, `protocol_execution_jobs`, `buyer_question_launch_selections` or `snapshot_requests`, and calls no provider.

## 10. Smallest implementation sequence

| Step | Scope | Paid calls | Migration | Gate |
|---|---|---|---|---|
| **Q0** | D-039, this document, and the METHODOLOGY Provenance replacement (docs only) | none | none | Founder sign-off |
| **Q1** | Offline pure modules and unit tests: candidate validation (shape, grade, verification, evidence, brand rules, duplicates, review signal), relevance eligibility and ranking, wording classification, and the version-field mapping | none | none | separate authorisation |
| **Q2** | The tables, the enrolment function, the set-approval RPC and the one-check redefinition of `approve_and_launch_snapshot_baseline` (section 8), with schema, verbatim-copy, check-placement, race and runtime tests. **CI's Level 2 job will apply the migration to a disposable database**, so advance notice is required | none | yes | separate authorisation |
| **Q3** | Founder curation screen in admin: enrolment, ICP, sources (including customer material with attestation), candidates and ratings, wording review. The site-context crawl reused without the Site Reader | none | none | separate authorisation |
| **Q4** | Invitation issue, revoke and reissue; token-to-session exchange with absolute, idle and revocation limits; the customer review and approval page; the session-ended page and expiry warnings | none | none | separate authorisation |
| **Q4b** | Launch selection and `launch_selected_buyer_question` (operator only) | none until launch | yes | separate authorisation; the launch itself needs PG-9 and execution-gate approval |
| **Q5** | Automated Buyer Language Research, a core objective after the curated validation phase | per its budget | maybe | a separately approved, ledgered research budget and its own authorisation |

## 11. Acceptance criteria

Each criterion is an exact, testable result. None has been run.

**Grades, verification and evidence**

1. An `observed` candidate whose only link is a review describing a problem (not a question) is refused.
2. An `observed` candidate linked only to `site_copy`, or to any seller-authored source, is refused.
3. An `observed` candidate whose text differs from its verbatim source beyond whitespace and terminal punctuation is refused. The same text graded `adapted`, with an adaptation note and a basis link, is accepted.
4. An `adapted` candidate with no `paraphrase_basis` link to a buyer-authored source is refused.
5. Customer material with a reference, an attestation and a buyer-authored question yields "Observed — customer-provided". The same question from a public source yields "Observed — verified source". The two labels and `verification` values never coincide.
6. A customer statement such as "our buyers often ask X", with no documented material, can only be a `hypothesis`. Attempting `observed` is refused.
7. Customer material without an attestation, or without personal data removed, cannot be saved.
8. With zero buyer sources, no unbranded question is preselected. The customer sees an explanation and the option to write their own.
9. With fewer than six valid candidates, exactly that number is shown. No candidate, source or excerpt is created to fill the gap. This is asserted by comparing the stored rows before and after recommendation.

**Relevance and selection**

10. A candidate with buyer relevance, ICP fit or product relevance below 2, or commercial intent of 0, is never preselected, whatever its evidence grade.
11. Between two eligible candidates, the one with the higher relevance sum is preselected first. Evidence breaks a tie in favour of observed. An observed candidate with a lower relevance sum never outranks an adapted one with a higher sum.
12. A candidate in an excluded ICP segment (ICP fit 0) is never preselected.
13. When the second-ranked unbranded candidate repeats the first's buying stage and an eligible candidate at a different stage exists, the different-stage candidate is preselected.
14. A `hypothesis` is never preselected, in any input combination (property test).
15. Two eligible unbranded candidates and one eligible branded candidate give exactly that preselection. An ineligible branded candidate is not preselected.
16. An unbranded candidate containing the brand or a product name is refused as unbranded. A branded-accuracy candidate without the brand is refused.
17. Exact duplicates merge and keep every source link. Near duplicates (token similarity of 0.8 or more) are flagged, and at most one is preselected. An approval set with two equal `prompt_hash` values is refused.
18. If the customer rejects the ICP, a new research set is created, and no ranking produced against the rejected ICP is shown again.
19. The version fields follow the provisional heuristic mapping. For example, commercial intent 3, ICP fit 3, product relevance 2 and observed wording give 5, 4 and 20; every result stays within the 0048 ranges. A static check finds no customer-facing or report string that presents these values as a probability, win rate, commercial value estimate or likelihood of an AI recommendation.

**Marketing-language signal**

20. Seller-voice fixtures ("What is the best AI-powered all-in-one platform to streamline workflows?") are flagged, and buyer-voice fixtures are not.
21. A flagged candidate keeps its grade, and is not preselected until the flag is resolved with a recorded reason and a buyer-authored source.
22. An unflagged hypothesis stays a hypothesis: passing the signal never changes a grade.

**Sources and excerpts**

23. An excerpt of 301 characters is refused, and one of 300 is accepted.
24. A public source without a URL or retrieval date is refused. Customer material without a reference or date received is refused. A stored excerpt matches its SHA-256.
25. Every `observed` or `adapted` card shows its source link or customer-material reference, the excerpt, the date and the verification label.
26. A static check finds no customer-facing string saying "buyers ask", "real buyer question", "verified" applied to customer-provided material, or similar.

**Origins and wording classification**

27. Editing a candidate leaves the candidate row, its source links, grade and verification byte-identical. The origin is `recommended_edited`. No row anywhere has the evidence grade `customer_edited`, which is not a value in any grade or classification set.
28. An unchanged candidate's wording is classified with the candidate's grade and verification, by `inherited_unchanged`, and the candidate and approved text hashes are equal.
29. An edited observed question whose new text still matches its verbatim source (apart from whitespace and terminal punctuation) is classified `observed` by `exact_source_match`. One that no longer matches is classified `pending_review`, never `observed`.
30. A customer-written question that matches no buyer source is classified `pending_review`, and its provenance is `customer_supplied`.
31. A founder classification of `adapted` without a basis link and an adaptation note is refused. Each founder classification adds a row and leaves earlier rows unchanged.
32. The approved text is byte-identical to the text on the confirmation screen; the hash comparison is part of the test.
33. Changing an approved question creates version n+1. Version n, its origin and its classifications are unchanged.

**Customer access**

34. An invitation can be exchanged exactly once, and not after seven days.
35. A session is refused 30 minutes after exchange, even if active, and is never valid after its invitation expires.
36. A session idle for 15 minutes is refused. A request at 14 minutes succeeds and resets only the idle timer.
37. Revoking an invitation makes every session from it fail on its next request, with no writes. Reissuing revokes the previous invitation, and its link and sessions stop working.
38. A report-access token, an email-verification token, or an invitation token presented as a session is refused.
39. No token value appears in any table, log line or error message. No email address is stored in any table introduced by this design; only HMACs with their key ids.
40. The same address under the same key gives the same HMAC; under a different key it gives a different HMAC. An HMAC cannot be reproduced without the key: the unkeyed SHA-256 of the address never equals it.
41. A session for project A cannot read or approve any candidate, source or question from project B; it is refused with no writes.
42. For a founder-created request, exchanging the invitation sets `email_verified_at`; before that, no approval is possible.

**Pilot recovery**

43. After a session ends, the same invitation link cannot start a new session. The session-ended page reveals no address, account or request detail.
44. A founder reissue revokes the old invitation, issues a new one for the same request, research set and address, and sends it. The admin view shows the earlier invitation's exchange and approval state, never a token value.
45. After reissue, an approved set opens read-only, and replaying its approval returns the same versions. Unapproved work is not on the server, and a restored browser draft cannot be approved without a new confirmation.
46. Keeping a session active extends only the idle timer; a request after 30 minutes from exchange is refused.

**Approval authorisation**

47. Each approved version's `approved_by` equals the grant id written in the same transaction. That grant records the session, invitation, request, project and email HMAC.
48. If the request's address has changed since the invitation was issued, approval is refused with no writes.
49. A grant id is refused as `p_operator_id` for a launch, as `approved_by` for a protocol, and as `selected_by` for a launch selection.

**Atomicity and idempotency**

50. A failure on the third question of a set leaves no grant, question, version, origin, classification or approval rows.
51. Replaying the same idempotency key and set returns the same versions. The same key with a different set is refused. After a research set is approved, a different set is refused from any session.
52. Two simultaneous approvals for one research set produce exactly one approved set.

**Coexistence with 0062 and paid execution**

53. Approval writes nothing to `protocols`, `protocol_execution_jobs`, `buyer_question_launch_selections` or `snapshot_requests`, and calls no provider.
54. `approve_and_launch_snapshot_baseline` on an enrolled request raises `request_uses_buyer_question_flow` with no writes. On a request that is not enrolled, it behaves exactly as before, and every existing test for it passes unchanged.
55. The schema-contract test confirms the redefined `approve_and_launch_snapshot_baseline` equals its 0069 definition apart from the single enrolment check.
56. `launch_selected_buyer_question` creates a protocol that references the selected existing version and creates no question version. It is refused for an unenrolled request, a version outside the approved set, a `pending_review` wording, an unacknowledged `hypothesis` wording, or a second launch for the same request.
57. The other approved versions of a launched request have no protocol and no job.
58. While the PG-9 HOLD or any execution gate is in force, a launched job makes no provider call. It is refused at the existing gates, which the existing PG-9 and execution tests already cover.
59. The PG-9 spend-gate tests are unaffected; no file under the spend gate's scope changes.

**Enrolment races (two sessions, forced with open transactions and barriers on `pg_locks` and `pg_stat_activity`; no sleeps)**

60. **Enrolment first.** Session E runs `begin;` and enrolment, and stays open. Session L calls `approve_and_launch_snapshot_baseline` and is shown waiting on the request row lock. E commits. L raises `request_uses_buyer_question_flow`. After both: one `bqi_enrollments` row, the request still `pending_approval` with no protocol, and no new `buyer_questions`, `buyer_question_versions`, `protocols` or `protocol_execution_jobs` rows.
61. **Legacy first.** Session L runs `begin;` and the legacy call, which completes, and stays open. Session E's enrolment is shown waiting on the row lock. L commits. E raises `request_not_enrollable`. After both: no `bqi_enrollments` row, and exactly the question, protocol and job the legacy call created.
62. **Enrolment rolled back.** As 60, but E rolls back. L then succeeds exactly as today.
63. **Legacy rolled back.** As 61, but L rolls back. E then succeeds, and no question, protocol or job exists.
64. **Sequential, both orders.** Enrolment committed first, then the legacy call: refused with no writes. Legacy committed first, then enrolment: refused with no writes.
65. **Stale snapshot.** Session L runs `begin isolation level repeatable read;` with a first query, before E's enrolment commits. L's legacy call then fails with `40001` and writes nothing. The same holds with SERIALIZABLE, and with the roles swapped.
66. **Duplicate enrolment.** Two sessions enrol the same request at once. Exactly one `bqi_enrollments` row exists; the second call returns it unchanged.
67. **Launch path.** `launch_selected_buyer_question` on a request whose legacy launch committed first raises with no writes. A legacy call on a request launched through the new path raises `request_uses_buyer_question_flow` with no writes.
68. **Check placement (static).** In the redefined `approve_and_launch_snapshot_baseline`, the enrolment check is the first statement after the `select … for update` on the request row and its not-found return, and precedes the idempotent-replay branch and every `insert`.
69. **Invariant across 60–67.** For every request, never both a `bqi_enrollments` row and a protocol created by `approve_and_launch_snapshot_baseline`.

## 12. Out of scope

- Any paid or automated research, crawling of third-party sites, or new provider, until Q5 is separately authorised (Q-D1, Q-D2).
- Launching more than one paid protocol per request (OD-2).
- Customer accounts or logins. The invitation and session are the only customer access in this design.
- A self-service link-resend button (a later step, section 7).
- Measuring the relevance ratings; in the curated phase they are recorded review judgements.
