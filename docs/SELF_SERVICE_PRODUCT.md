# Self-service product (D-040)

- **Status:** Approved product direction (D-040, 2026-11-01). The architecture is frozen. **This document authorises no implementation.** Every step in section 10 needs its own authorisation. Existing approved controls stay in force under the transition rule (section 2).
- **Owner:** Founder/CEO.
- **Source:** consolidated from the Founder-approved proposal (v2), its v3 amendment, errata E1–E5, and the two corrections recorded at approval. Nothing here goes beyond that approved text.
- **Separate from:** the PG-9 spend gate (D-037, [`SPEND_LEDGER_GATE.md`](SPEND_LEDGER_GATE.md)). PG-9 and PR-B stay on HOLD. V3.4 is frozen.
- **Last updated:** 2026-11-01

## 1. Direction

Zypact's product target is a self-service SaaS. Customers can do all of the following without routine founder action:

- sign up;
- analyse their website with a bounded, deterministic diagnostic;
- build and approve evidence-graded buyer questions;
- verify domain ownership for their workspace;
- authorise bounded paid execution;
- follow their registered results.

The founder's role is:

- **exceptions:** one queue, and each item carries its reason;
- **support;**
- **governance:** global and per-tenant ceilings, kill switches, provider configuration, the source-domain allowlist, rule-version promotion, research budgets, audit sampling and holds.

**How routine work is done:**

- **System rules** are deterministic. Each records the actor `system`, the rule and the rule version.
- **Customer actions** are taken under an authenticated account. Approvals and spend authorisations require step-up authentication.

## 2. Transition rule

**An approved control stays in force until its replacement is implemented, tested and authorised.** Approving D-040 removes or replaces no control on its own. The control-by-control reconciliation is in section 9.

## 3. Invariants

These do not change under D-040.

| Invariant | Where enforced |
|---|---|
| **D-039 grade definitions.** "Observed" needs an actual buyer-authored question. Seller copy never establishes buyer wording. Customer-provided material is never presented as independently verified. | Q1 rules; database checks (Q2′) |
| **"Observed" needs a validated verbatim designation.** A model, heuristic, paraphrase basis, customer assertion or founder review never produces it. | Q1 rules (merged in #96) |
| **Immutability.** Candidates, sources, grades and approved versions are never altered; a change is a new record. | Database (the 0047 and 0048 pattern); Q2′ |
| **Question approval is not execution authorisation** (D-039 OD-3). | Separate records and RPCs |
| **The paid-call invariants.** No paid call without: approved question and protocol identity; bounded sampling; admission control; reservation before each attempt; a database-enforced ceiling; and immutable request and response evidence. | D-037 ledger gate (PG-9) |
| **Tenant isolation** is enforced in the database, not only in the UI. | RLS and owned rows (Q2′ and S1) |
| **PG-9 and PR-B stay on HOLD** until the founder lifts them. B1's mixed multi-row UPDATE limitation must be resolved or demonstrably excluded before production approval. | Founder decision |
| **No paid research without a separately approved, ledgered research budget** (D-039 Q-D1). | Research budget ledger |
| **Delivery.** `integrity_passed` may deliver automatically; `needs_review` goes to the exception queue; `blocked` never delivers. | Existing delivery gates |
| **Product boundary.** No causal, revenue or "buyers ask" claims; no single surface presented as all AI buyers; continuous monitoring is deferred. | Copy rules; product boundary |

### New invariants (D-040)

1. Automation never assigns "observed" unless every deterministic check passes on retained, re-verifiable evidence. A model's output is never evidence.
2. Neither a customer nor founder review can assign "observed".
3. Every system action records its actor, rule and rule version.
4. Every approval is an immutable, action-specific record; identity alone is never a grant. Revocation is append-only and stops only future reliance. Revocation is checked at every transition that permits new spend: claim, reservation and send marker.
5. Paid execution requires all of:
   - a domain verified by the workspace;
   - an unrevoked execution-authorisation record showing the ceiling;
   - step-up authentication.
6. Spending ceilings are enforced in the database and are never weakened by a later change.
7. No live worker starts without an independent provenance comparison.

## 4. Customer journey

1. **Sign up:** verified email, a workspace, and tenant isolation.
2. **Submit a URL:** an unverified domain gets the limited analysis (section 7).
3. **Website Buyer-Readiness Diagnostic:** deterministic, bounded, with no paid call (section 6).
4. **Buyer questions:**
   - customer material (Lane A) and the customer's own questions (Lane C), graded by the Q1 rules;
   - suggested wording, labelled as a suggestion;
   - automated research (Lane B) comes later, gated by section 8.
5. **Review and approve** up to three frozen versions (D-039, unchanged).
6. **Verify the domain** (section 7).
7. **Billing, then explicit execution authorisation** with a visible ceiling. This comes only after PG-9, PT-1 and AD-1.
8. **Results:** the baseline, the registered intervention, the registered retest and the Outcome Card. There is no continuous monitoring.

## 5. Approvals and sessions

### 5.1 Approval records

Every customer approval is its own record. This covers:

- question-set approval;
- hypothesis-launch acknowledgement;
- execution authorisation;
- spend-ceiling acceptance.

**Each approval record is:**

- **Insert-only.** It is never updated or deleted by ordinary application behaviour, and this is enforced in the database.
- **Action-specific.** It names one action type and the objects that action covers. One approval never implies another.
- **Bound to its context:**
  - the authenticated customer account id;
  - the workspace, project, request and research set;
  - the exact approved version ids with their prompt hashes, or for execution, the protocol id and ceiling;
  - the database timestamp;
  - the session id and session type;
  - for account sessions, the step-up event id;
  - an idempotency key.
- **Consented.** It stores the version and hash of the exact consent text shown, and the customer's explicit confirmation.
- **Referenced by id.** `buyer_question_versions.approved_by` and every execution record point to the approval record, never to the account.

**Account identity is not an approval grant.**

**Revoking an execution authorisation.** An execution authorisation may be revoked by an **append-only revocation record**. The record references the authorisation and names the actor, the database time and the reason. A customer revocation requires step-up authentication.

- **No new spend on a revoked authorisation.** No new claim, reservation or provider send may rely on it, including runs still remaining under a partly used authorisation.
- **Every spend transition checks it.** PT-1, AD-1 and X1 must each define a **transactionally safe revocation check at every transition that permits new spend**: claiming a job or slot, creating a reservation, and writing a send marker before a provider call.
  - Each check reads the authorisation's revocation state in the same transaction that grants the new spend, under the same lock or ordering.
  - A revocation that commits first is therefore always seen. One that commits later affects only later transitions.
- **Committed and in-flight sends are not undone.** A send committed before revocation, or already in flight, keeps its documented boundary. Its cost can still arise and is reconciled under the PG-9 design, and B1's limits on what a pass proves still apply.
- **No history is rewritten.** Revocation never deletes or rewrites ledger, evidence or approval records. Frozen V3.4 is not changed: the checks are designed inside PT-1, AD-1 and X1.
- **Question approvals are history.** They are not revoked by this mechanism, and a later change creates a new version.

### 5.2 Two session types

| | Account session | Review-invitation session (D-039 OD-4, unchanged) |
|---|---|---|
| **Who** | A signed-in workspace member | The holder of a founder-issued invitation, for a founder-created request |
| **Created by** | Sign-in with a verified email | One-time exchange of a 7-day invitation token |
| **Scope** | The member's own workspace | One request, project and research set; no account features |
| **Lifetime** | An absolute limit and an idle limit, set in S1 as a governance setting | 30 minutes absolute and 15 minutes idle, never past the invitation's expiry |
| **Revocation** | Immediate on sign-out, a password or email change, an admin revoke, or workspace removal; checked on every request | Immediate when the invitation is revoked; checked on every request, with no caching |
| **Step-up** | Required before any approval, revocation, execution authorisation or ceiling change | The approval happens inside the short, single-purpose session (OD-4) |
| **Storage** | Separate table and token purpose | Separate table and token purpose, hashed tokens and HMAC'd email (OD-4) |

**The two types never mix:**

- An invitation session can never be upgraded into an account session.
- An account session never satisfies an invitation check.
- A token of one type is refused by the other, because the purpose labels differ.
- Invitations remain the path for founder-created requests.

## 6. First release: Website Buyer-Readiness Diagnostic (no paid AI call)

### 6.1 Purpose and claim boundary

The diagnostic examines **observable properties of the public website**. It reports whether the signals that let AI and search systems find, read and quote a site are present, and what buyer-relevant content is missing.

**It is not:**

- a measurement of AI answers;
- a prediction of visibility, rankings or recommendations;
- a statement about buyers.

**There is no composite score.** Each check gives its own result with evidence.

The report says, in plain words: "This checks your website's public pages. It does not show how any AI system answers buyers." On an unverified domain it also says: "Domain ownership not verified."

### 6.2 Bounds

**Fetch scope and safety:**

- **Pages:**
  - at most **10** same-site pages;
  - plus `robots.txt`, `sitemap.xml` and `llms.txt` when present.
- **Limits:**
  - a per-page timeout, a total time cap and a response-size cap;
  - the existing SSRF-safe fetch (`lib/crawler/safe-fetch.ts`, `outbound-url-safety.ts`), which blocks private, loopback and link-local destinations and re-checks DNS;
  - no login, form submission, JavaScript execution or paywalled content;
  - an identifiable user agent with a contact URL.

**Robots handling, per RFC 9309:**

- The file is fetched from `/robots.txt`, following at most 5 redirects.
- A 2xx response is parsed.
- A 4xx response means no restrictions.
- A 5xx response, or an unreachable host, means complete disallow. Pages are not fetched, and the dependent checks report `unknown` with the reason `robots_unavailable`.
- Parsing stops at 500 KiB.
- The file is cached for at most 24 hours.
- User-agent groups match by product token. The longest path match wins, and `Allow` wins a tie.

**Run limits and reproducibility:**

- There are no paid calls, no model calls and no third-party APIs.
- Rate limits apply per account, per IP address and per target domain. Each account gets one cached analysis per domain per period, and a re-run creates a new versioned result.
- Each result records:
  - the fetch time;
  - the URL list;
  - the HTTP status;
  - a content hash per page;
  - the rule-set version.

  The same fetched content always produces the same findings.

### 6.3 Results and checks

Each check returns one of four states:

- `pass`, `issue` or `info`;
- **`unknown`**, when the check could not be evaluated. An `unknown` result always carries a reason, and is never shown as `pass` or `issue`. The possible reasons are:
  - `fetch_failed`, `timeout`, `size_cap`, `parse_error`;
  - `blocked_by_robots`, `robots_unavailable`;
  - `not_html`, `page_cap_reached`, `not_applicable`.

| Check | Establishes | Does **not** establish |
|---|---|---|
| `robots.txt` rules for named crawler user agents | What the file tells that user-agent token | That the crawler visits, honours the file, or uses the content |
| `noindex` / `X-Robots-Tag` | That the directive is present on the fetched page | Indexing or exclusion by any system |
| Text in the server response | That the HTML Zypact received contained text | What a script-executing crawler or an AI system reads |
| `<title>`, meta description, H1, canonical | That these elements are present and consistent in the fetched HTML | Readability, ranking or AI visibility |
| JSON-LD | Presence, parseability, and the types and fields found | That any system uses it |
| Entity consistency | Whether the brand name agrees across title, `og:site_name`, JSON-LD and footer | How any system resolves the entity |
| Buyer-relevant pages: pricing, product, integrations, security, comparison, documentation, FAQ, customer stories | Whether such pages were found within the 10-page cap | Absence elsewhere on the site; once the cap is reached, a miss is `unknown` |
| Seller wording | The site's own marketing phrases, used as context for the Q1 marketing signal | Buyer wording (never evidence) |

### 6.4 What the first release delivers

1. **The diagnostic report.** It lists findings, evidence and a fix list by area. It is private to the workspace and exportable.
2. **The buyer-question workspace.** It holds:
   - evidence-graded questions from the customer's own documented material, at most "Observed — customer-provided";
   - the customer's own questions;
   - suggested wording, labelled as such.
3. **Review and approval** of up to three frozen question versions.

## 7. Domain ownership, per workspace

| Capability | Unverified domain | Verified domain |
|---|---|---|
| Diagnostic of public pages | ✓ base run and refresh quotas; each diagnostic capped at 10 pages; safety and abuse limits enforced; private, labelled "Domain ownership not verified" | ✓ higher run and refresh quotas; each diagnostic still capped at 10 pages; safety and abuse limits enforced |
| Own questions, suggestions, customer material | ✓ customer material labelled as supplied by an unverified workspace | ✓ |
| Question review and approval | ✓ | ✓ |
| **Paid execution** | ✗ | ✓, together with billing, an execution-authorisation record and the PG-9, PT-1 and AD-1 gates |
| **Reports presented as brand-owned** | ✗ | ✓ |
| Automated research on the domain (once approved) | ✗ | ✓ |

**How verification works:**

- **Methods.** Verification uses a DNS TXT record, or a well-known file or meta tag on the domain. An email address at the domain is not enough on its own.
- **One record per workspace.** Each verification is a record of (workspace, domain, method, challenge, verified time, status), with a challenge value unique to the workspace. Re-checks, loss of verification and revocation act on that one workspace's record.
- **No cross-workspace access.** Verification grants the tier capabilities above for **that workspace's records only**. It never grants access to, or reveals, another workspace's projects, requests, sources, approvals, reports or diagnostics, even when they concern the same domain. This is enforced by database row-level security and tested in Q2′ and S1.
- **When verification is lost:**
  - paid execution and brand-owned reports are suspended for that workspace, and an exception item is created;
  - existing records and approval records stay unchanged.
- **Disputes** go to the exception queue. They are resolved without moving data between workspaces.

## 8. Buyer evidence and automated research

### 8.1 Lanes

- **Lane A, customer-supplied material:**
  - **Before storage:** the customer confirms that personal data was removed (an automated redaction aid helps) and attests that the material is buyer-authored.
  - **Grading:** the customer designates quoted questions as verbatim, and the Q1 rules check that the span is present and word-aligned.
  - **Limit:** at most "Observed — customer-provided", never presented as verified.
- **Lane B, automated public research** (Q5): sections 8.2 to 8.4. It needs a research budget and its own authorisation.
- **Lane C, the customer's own questions:** classified by the Q1 rules.

**Relevance:** the customer confirms the ICP and the four ratings. Ratings proposed by the system are labelled as system proposals. This needs a METHODOLOGY decision (D8, section 11).

**Wording review** is resolved in one of these ways:

- by rule;
- by the customer downgrading to `hypothesis`;
- by the customer marking it `adapted` with a validated basis and a change note.

Disputes go to the exception queue. A customer can never assign "observed", and since Q1 R3, founder review cannot either.

### 8.2 Three automated output classes

| Class | Meaning | Grade it can carry | Customer label |
|---|---|---|---|
| **Suggested wording** | Wording proposed by a machine, with no evidence claim | `hypothesis` only, never preselected | "Suggested wording: not found in buyer sources" |
| **Source-supported** | Wording reworded from buyer language that the system found and stored | `adapted` at most | "Adapted from buyer language", with link, excerpt and date |
| **Observed — verified source** | A complete buyer question, quoted verbatim, that passes every deterministic check | `observed` | "Observed — verified source", with link, excerpt and date |

**Placement rule.** An output is placed in the **highest class whose own requirements all independently pass**:

- **Source-supported** requires:
  - a basis span verified present in stored evidence from an allowlisted, buyer-authored source;
  - a recorded change note;
  - a passed privacy check.
- **`pending_review`** is used when the system cannot decide, or a check returned an undecidable result such as an extractor error. Such an output is never shown as evidence until resolved.

**What never happens:**

- A failed "observed" check never by itself makes an output source-supported.
- Nothing is upgraded. A rule version may raise only **new** outputs, never existing records.

### 8.3 Deterministic checks for automated "observed"

1. **Fetch and record.** The source domain is on the founder-governed allowlist. Its terms and robots rules permit collection. The page is not behind a login, paywall or access restriction.
2. **Authored region.** A per-platform deterministic extractor, versioned and approved, isolates the user-authored content. Without an approved extractor for the platform, "observed" is not possible.
3. **Verbatim.** The span occurs verbatim inside the user-authored region, aligned to word boundaries.
4. **Not seller-authored.** The domain and author are not the customer, a listed competitor or a known vendor account.
5. **Complete question.** The span is a whole interrogative sentence, ending in a question mark, by the extractor's rule. This hard rule applies **to automation only**. Human curation keeps its signal-only treatment.
6. **Privacy.** See section 8.5.

### 8.4 Retained verification record for automated "observed"

A body hash and an excerpt cannot reproduce the original page. For automated "observed" only, the system therefore keeps a **verification record** from which a reviewer can re-run every check in section 8.3 offline, without re-fetching.

**At minimum, the record holds:**

- the user-authored region exactly as fetched, and the surrounding markup the extractor used to set its boundaries;
- the URL and the final URL, the retrieval time and the HTTP status;
- the SHA-256 of the full response body;
- the extractor and rule versions;
- the span offsets.

**How it is held:**

- The record is encrypted and access-restricted, and held under a recorded lawful basis (D5).
- It is kept at least as long as the observed classification is shown or relied on, including by any approved version that cites it.

**If an adequate record cannot be kept or verified, "observed" is not assigned.** This covers source terms, a legal refusal, and capture failure. The output is then placed by the rule in section 8.2.

**When the record must be deleted** (retention end, a valid data-subject or source-owner request, or workspace deletion), the claim does not continue unverified. An append-only evidence-review record (D9) marks it "evidence no longer retained". The original candidate, its grade and any approved version are never altered.

### 8.5 Privacy, storage, retention and deletion

**Quarantine.** A personal-data detection, or a privacy-sensitive source, sends the item to **quarantine**, or it is excluded at collection.

- A quarantined item is never shown and never used as evidence.
- It sits in a restricted store, has short retention and is then deleted.
- Releasing an item needs a recorded review.
- Redaction never turns a quarantined item into evidence automatically.

**Minimal storage by default.** Everything outside section 8.4 is stored minimally:

- **Kept:** the URL, retrieval time and HTTP status; the body SHA-256; the extractor version; and the excerpt (at most 300 characters) with its offsets.
- **Full page copies:** not retained outside the purpose in section 8.4 unless legal review allows it.
- **Diagnostic fetches:** findings and per-page hashes are kept; page bodies are discarded after analysis.

**Lawful basis and retention.**

- A lawful basis is recorded for each processing purpose.
- Data-processing terms cover customer material.
- Source terms and robots rules are checked per domain.
- Every record type has a retention period.
- Records are deleted on expiry, on a valid request, and on workspace deletion. A deletion is logged without its content.

The values are set after legal review (D5).

### 8.6 Evaluation and audit gate

**Reference set.** The founder curates pilot research sets, labelled independently. A second reviewer labels a stratified subset, so that human agreement (Cohen's κ) is known.

**Metrics,** per rule version and per extractor:

| Metric | Gate |
|---|---|
| **Observed error rate:** the share of automated "observed" outputs that reviewers reject | One-sided 95% upper confidence bound ≤ *ε* (set by the founder; proposed start 2%) |
| **Seller leakage** | Upper bound within a founder-set threshold |
| **Grade agreement** (κ against the reference) | At or above a founder-set level, read against human–human κ |
| **Relevance agreement** | Reported; threshold set by the founder |
| **Personal-data incidents** | Any incident stops exposure pending review |
| **Deterministic-check integrity:** an audited "observed" whose retained record does not contain the span | Any occurrence is a defect, and stops exposure |

**Sample size.** With zero errors in *n* audited items, the 95% upper bound is about 3/*n*: about 150 audited items support 2%. When errors occur, the Clopper–Pearson bound applies. No claim of zero error is made.

**Stages:**

1. **Shadow.** Outputs are produced but not shown.
2. **Limited exposure.** Outputs are shown, labelled, on a capped number of verified workspaces. Every automated "observed" is audited before display.
3. **Steady state.**
   - A stratified sample is audited each period, together with every dispute.
   - The bounds are recomputed on a rolling window.
   - **Rollback:** if a bound crosses *ε*, or a stop rule fires, the rule version or extractor is disabled.
   - Existing affected records receive an append-only evidence-review record (D9).

## 9. Reconciliation of approved controls

The transition rule (section 2) applies to every row.

| Source | Approved control | D-040 treatment | Replacement, and when it takes effect |
|---|---|---|---|
| D-039 Q-D1 | Founder-curated and customer-supplied evidence first; no paid research without a ledgered budget | **Kept and narrowed.** Founder curation becomes the validation and reference phase (section 8.6). | Lane B exposure only after the section 8.6 gates and a research budget |
| D-039 Q-D2 | Only permitted, attributable sources; no new paid research provider | **Kept** | A source-domain allowlist under governance; any new provider is a revisit trigger |
| D-039 Q-D3, OD-2 | Up to 6 candidates and 3 approved questions; the first V1 execution launches one question, selected by an operator, after PG-9 | **Launch amended.** The limits are unchanged. | Customer selection within a per-plan limit through an execution-authorisation record (X1). **Until X1 ships, operator selection of one question remains the only launch path.** Never all three automatically. |
| D-039 Q-D4, OD-5 | Terms and privacy respected; 300-character excerpt maximum; URL or reference and date kept | **Kept** | Automated collection adds sections 8.4 and 8.5 |
| D-039 Q-D5, OD-1 | Grade definitions; customer-provided material never presented as verified | **Kept** | The automated classes map onto these definitions (section 8.2) |
| D-039 OD-3 | A grant id fills `approved_by` only when bound to a verified email, request and project; question approval is not execution approval | **Kept and generalised** | Immutable, action-specific approval records (section 5.1); identity alone is never a grant |
| D-039 OD-4 | 7-day invitation exchanged once for a session (30 minutes absolute, 15 idle, revocation); hashed tokens; HMAC'd email; founder reissue | **Kept for invitation sessions** | Account sessions are added as a separate type (section 5.2, S1). Invitations remain for founder-created requests. Once S1 ships, founder reissue becomes a self-service resend, rate-limited and giving the same response whether or not a request exists. |
| D-039 enrolment and 0062 coexistence | Enrolment locks the request; `approve_and_launch_snapshot_baseline` refuses enrolled requests | **Kept** | Self-service requests are enrolled by the system under the same lock and check |
| D-039 curation, ratings, ICP | The founder curates, rates and drafts the ICP | **Amended** | The customer confirms the ICP and ratings; system proposals are labelled (D8). The founder remains curator for pilots and the reference set. |
| D-039 wording review | The founder classifies `pending_review` as `adapted` or `hypothesis` | **Amended** | Resolution by rule, customer downgrade, or customer `adapted` with a validated basis and note. Disputes go to the exception queue. Nobody can self-assign "observed". |
| D-039 hypothesis-launch acknowledgement | An operator acknowledges | **Amended at X1** | Customer acknowledgement, stored as an approval record |
| D-039 revisit triggers | Automated or paid research, a new provider, more than one paid protocol per request, customer-provided material labelled verified, "buyers ask" copy, approval creating paid execution, changes to 0062 | **Kept.** D-040 is the review they required. | Each implementing step still needs its own authorisation |
| D-034 | Production worker live; one job per operator start | **Amended only by AD-1** | Queue-driven dispatch with an automated, independent pre-start provenance comparison (AD-1, separately gated). **Until AD-1 ships, one job per operator start remains.** |
| D-035 | The founder may start the worker from the admin console | **Kept as a governance override** | Routine starts move to dispatch only under AD-1 |
| Operating rule: independent provenance check before any live worker start | A recorded status alone is insufficient | **Kept and later automated** | AD-1's pre-start gate performs the comparison itself. Until then, the manual independent check remains. |
| D-037 | Database ceiling on the external-call ledger | **Kept.** V3.4 is frozen. | Per-tenant ceilings come only through PT-1, a separately gated design additive to every V3.4 guarantee, after PG-9 approval |
| V1_SCOPE §2 | First pilots founder-operated; no mature self-serve onboarding required | **Amended** | Self-service is the product target. Founder-operated pilots continue as the validation and reference phase until the first release passes its exit gate. |
| V1_SCOPE §3 | The 14-step workflow | **Kept in substance** | Step 1 becomes self-service sign-up plus the diagnostic. Step 4's explicit approval before paid calls becomes the execution-authorisation record. |
| V1_SCOPE §4.1 | "Request Demo" as primary CTA; hybrid disclosure; no self-serve checkout required | **Amended** | Self-service sign-up becomes the primary CTA (demo kept). The disclosure is updated. Checkout comes with billing (B1′). |
| V1_SCOPE §4.2 | Basic auth, one owner role, workspace, tenant-safe access | **Kept** | Implemented by S1; the access allowlist becomes a governance switch |
| V1_SCOPE §4.3 | Manual or assisted question creation; human correction and explicit approval | **Kept** | Performed by the customer, not the founder |
| ROADMAP Phase 3 exit | One external staging pilot completes the workflow without a developer editing code or database rows | **Kept and strengthened** | The first release adds: pilot customers complete the no-spend journey without founder action |
| ROADMAP Phases 5 and 7 | Founder-operated pilots; self-service only after repeatable-workflow evidence | **Re-sequenced, not removed** | The no-spend release can proceed. Paid self-service and Lane B exposure keep their evidence gates. **The kill and reframe gates are unchanged.** |
| Product boundary (`CLAUDE.md`) | Continuous monitoring deferred; Perplexity Sonar as a directional proxy | **Kept** | "Monitor results" means registered baselines, retests and Outcome Cards only |

## 10. Dependency-ordered roadmap

Each step needs its own authorisation. Steps listed together within a stage can run in parallel.

| Stage | Step | Scope | Paid | Migration | Entry | Exit |
|---|---|---|---|---|---|---|
| 0 | **Q1** | Offline Buyer Question Intelligence rules | none | none | — | **Done: merged in #96 (`19a644c`)** |
| 1 | **Q0b** | D-040 and this document | none | none | D-040 approved | Docs PR merged |
| 2 | **Q2′** | Account-first data model. Covers: workspace ownership; the actor model; research sets, sources, candidates and classification records; approval and revocation records; the exception queue; domain-verification records; diagnostic results; RLS; enrolment and set-approval RPCs; the 0062 coexistence check | none | yes (CI applies it to a disposable database; advance notice required) | Q0b | Schema, race, RLS and immutability tests pass |
| 2 | **S1** | Accounts: sign-up, email verification, workspace, account sessions (section 5.2), step-up, rate limits, the allowlist as a governance switch, self-service resend | none | yes | Q2′, security review | Isolation and session tests pass |
| 2 | **G1** | Governance console: exception queue, kill switches, ceiling view, source-domain allowlist, rule-version registry, audit view | none | maybe | Q2′ | The founder can handle every exception type without database edits |
| 3 | **W1** | Website Buyer-Readiness Diagnostic (section 6), including RFC 9309 robots handling in the crawler | none | maybe | S1, G1 | Deterministic re-run tests pass; claim-language review done |
| 3 | **V1d** | Workspace-scoped domain verification and re-checks (section 7) | none | maybe | S1 | Tier rules and cross-workspace isolation enforced in the database |
| 3 | **Q3′** | Self-service intake: ICP, customer material, own questions, suggestions, customer-confirmed ratings | none | maybe | S1, legal review (D5) | Q1 rules enforced on save |
| 3 | **Q4′** | Review and approval in the account; rule-based wording classification; disputes | none | maybe | Q3′ | Approval atomic and idempotent, with no execution side effect |
| 3 | **N1 gate** | — | — | — | W1, V1d, Q3′, Q4′ | External pilot customers complete the no-spend journey without founder action; exception rate measured |
| 4 | **B1′** | Billing and entitlements | none | yes | S1, billing provider chosen | Entitlement checks enforced |
| 4 | **PG-9** | Lift the HOLD only by founder decision: V3.4, B1 harness, PR-B, and the B1 mixed multi-row UPDATE resolved or excluded | — | yes (0084+) | Founder authorisation | B1 and PG-9 acceptance |
| 4 | **PT-1** | Per-tenant ceilings, additive to V3.4, with revocation checks at claim, reservation and send marker (section 5.1) | — | yes | PG-9 approved | Its own manifest and review pass |
| 4 | **AD-1** | Queue-driven dispatch with an automated, independent provenance comparison; revocation checks (section 5.1) | — | maybe | PG-9 approved | Its own review passes |
| 4 | **X1** | Customer execution authorisation and revocation records: ceiling, disclosure, step-up, hypothesis acknowledgement, revocation checks at every new-spend transition | **yes** | yes | PG-9, PT-1, AD-1, B1′, G1, V1d, execution-gate approvals | A pilot runs a baseline end to end with no founder action and within its ceiling |
| 4 | **R1** | Results: Outcome Cards, evidence views, customer-registered interventions, scheduled registered retests; no continuous monitoring | yes (retests) | maybe | X1 | V1_SCOPE workflow steps 8–14 pass in self-service |
| ∥ | **RB** | Research budget and ledger; source-domain allowlist; per-platform terms review | per budget | maybe | Founder authorisation | Budget approved |
| ∥ | **Q5a** | Collector, extractors, retained verification records, deterministic checks; **shadow** evaluation (section 8.6) | per budget | maybe | RB, Q2′, reference set | Gates met with the required *n* |
| ∥ | **Q5b** | Limited exposure with full audit, then steady state with sampled audit and rollback; evidence-review records | per budget | maybe | Q5a exit approved, V1d | Gates hold on fresh data; rollback tested |

## 11. Dependencies

| # | Dependency | Needed for | Status |
|---|---|---|---|
| D1 | Q1 offline rules | Q2′ onwards | **Done: merged in #96 (`19a644c`)** |
| D1a | Single-source primary inference | Q3′ (practical use) | Ruled, **deferred**; a separate future decision |
| D2 | PG-9 (V3.4 frozen, 0084), B1 harness, PR-B; B1 mixed multi-row UPDATE resolved or excluded | PT-1, AD-1, X1 | **HOLD** |
| D2a | **PT-1:** per-tenant ceilings with revocation checks at every new-spend transition; separate decision, design, manifest and review; additive to V3.4 | X1 | Not started; only after PG-9 approval |
| D2b | **AD-1:** automated dispatch with an independent pre-start provenance comparison and revocation checks; separate decision and review | X1 | Not started. Operator start and the manual check remain until it is approved. |
| D3 | RFC 9309 robots handling in `lib/crawler/crawl-site.ts`, which has none today; fetch-limit and rate-limit specification | W1, Q5a | Not started |
| D4 | Authentication beyond the allowlist; account sessions kept separate from invitation sessions; step-up; security review | S1 | Not started |
| D5 | Privacy and legal: lawful basis per purpose; data-processing terms for customer material; retention and deletion periods; the quarantine store; the verification-record retention of section 8.4; per-platform source terms | W1, Q3′, Q5a | Not started |
| D6 | Billing provider choice | B1′ | Not chosen |
| D7 | *Retired.* It previously named the automated pre-start provenance gate, which is now part of D2b. | — | — |
| D8 | METHODOLOGY decision: customer-confirmed ratings; suggested and source-supported labels; the automation-only complete-question rule | Q3′, Q5 | Not started |
| D9 | Append-only evidence-review record, for rollback and deletion without altering immutable records | Q5a, Q5b | Not started |
| D10 | Reference set and second-reviewer labelling from founder-curated pilots | Q5a | Depends on pilots |
| D11 | Claim-language review of the diagnostic copy, including the "does not establish" statements | W1 | Not started |
| D12 | Workspace-scoped domain verification, with RLS tests showing no cross-workspace access | V1d | Not started (part of Q2′ and S1) |
| D13 | Approval-record and revocation-record schema: insert-only, action-specific, consent-text hash, step-up event | Q2′, Q4′, X1 | Not started (part of Q2′) |

**Separate future decisions:**

- adding the Q1 `test:bqi-*` suites to CI;
- single-source primary inference (D1a).
