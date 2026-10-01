# Zypact-on-Zypact self-test — registered intervention record

- **Status:** Observation window OPEN. Retest not yet run.
- **Opened:** 2026-09-24 · **Window closes:** 2026-10-09
- **Audited company:** Zypact (www.zypact.com) — the audited brand and the
  operator are the same party, which is itself a limitation, recorded in §6.
- **Surface:** Perplexity Sonar, the only live V1 surface.

This file is the durable record of the first registered intervention Zypact has
run against itself. It exists because part of the experiment's state cannot be
stored in the database (§4), and because a retest held for a go-ahead across
several days needs its terms written down where they cannot drift.

It is a record, not an authority: the database rows are the evidence, and
`retest_eligibility` is the only authority on whether a retest may run.

## 1. The registered claim

| Field | Value |
|---|---|
| Hypothesis | Publishing `/perplexity-content-change-test` will cause Zypact to be named in Perplexity answers to the approved buyer question |
| Intervention | "Page created" — the publication of that one page |
| Implemented | 2026-09-24 |
| Baseline result | **0 of 5 readable runs** — the brand was absent in all five; Perplexity named generic AI-visibility tools and never named Zypact |
| Decision threshold | Zypact named in **≥ 3 of 5** retest runs (≥ 60% presence) |
| Δ_min (minimum useful change) | 0.60 |
| Planned runs | 5 baseline, 5 retest — `create_retest_protocol` copies `planned_baseline_runs` verbatim, so the phases are symmetric by construction |

The exact approved buyer-question text lives in `buyer_question_versions` for
this request and is deliberately not duplicated here, so this file cannot drift
from the row that actually governs the comparison.

## 2. What the comparison engine will return

Computed by running `compareProtocols` directly against the baseline above with
Δ_min 0.60. Not estimated — executed.

| Retest | Delta | Newcombe 95% | Status |
|---|---|---|---|
| 0/5 | 0.00 | [−0.434, 0.434] | `no_clear_change` |
| 1/5 | 0.20 | [−0.264, 0.624] | `no_clear_change` |
| 2/5 | 0.40 | [−0.118, 0.769] | `no_clear_change` |
| **3/5** | **0.60** | **[0.030, 0.882]** | **`increase_observed`** |
| 4/5 | 0.80 | [0.193, 0.964] | `increase_observed` |
| 5/5 | 1.00 | [0.386, 1.000] | `increase_observed` |

A 0/5 baseline is the most favourable starting point this design admits: it is
the only region where a 5-run plan can clear its own Δ_min.

`smallestDetectableChange(5, 5)` is **exactly 0.60**, and the underpowered test
is `sdc > minimumUsefulChange` — strictly greater. The experiment therefore sits
precisely on the signed-off boundary and falls on the usable side of it.

### 2.1 The denominator is load-bearing

That boundary survives only while all five retest runs are readable. One lost
run moves the denominator to 4, `smallestDetectableChange(5, 4)` becomes 0.75,
and the underpowered clause fires:

| Retest, 4 readable | Status |
|---|---|
| 0/4, 1/4, 2/4 | `inconclusive` — `PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE` |
| 3/4, 4/4 | `increase_observed` |

So a negative result degrades from the informative "no clear change" to the
uninformative "inconclusive" on a single failed or excluded attempt. Below three
readable runs the readable-run floor returns
`RETEST_BELOW_READABLE_RUN_FLOOR` and no comparison is produced at all.

## 3. Deviations and confounders

Two unregistered changes were published to www.zypact.com inside the open
observation window:

| Date | Change | Registered |
|---|---|---|
| 2026-09-24 | `/perplexity-content-change-test` published | **yes — this is the intervention** |
| 2026-09-29 | Homepage and `/scan` rebuilt on a new design system (#58) | no |
| 2026-09-30 | Homepage and `/scan` rebuilt again, switched to light, public sign-in removed (#60) | no |

The intervention page itself was held unchanged apart from being pinned to its
original light rendering (#59, 2026-09-29) — that pin exists precisely so the
site redesign would not alter the artifact under observation.

**The note to carry on the Outcome Card:**

> During the observation window (2026-09-24 to 2026-10-09), two unregistered
> changes were published to www.zypact.com outside this intervention. 2026-09-29:
> the homepage and /scan were rebuilt on a new design system (PR #58).
> 2026-09-30: both were rebuilt again, switched to a light theme, and the public
> sign-in link was removed (PR #60). The registered intervention page
> /perplexity-content-change-test was held unchanged apart from being pinned to
> its original light rendering (PR #59, 2026-09-29). These are confounders:
> movement observed in this retest cannot be attributed to the registered
> intervention alone.

## 4. Why that note may not reach the artifact

`protocol_deviations` is written only by `confirm_intervention_implementation`,
which returns without acting unless the intervention's status is `approved`
(migration `0071`). This intervention's window is open, so implementation is
already confirmed and the status is `implemented`. The deviations field is
therefore closed to every product surface.

Three options, none yet chosen:

1. **Carry the note outside the artifact**, in the covering text when the result
   is presented. Zero risk; the note is not in the Outcome Card.
2. **A single SQL update to `protocol_deviations`.** This is a manual edit to
   evidence during an open experiment and must not be done without an explicit,
   recorded authorisation.
3. **Add an append-deviation path** so a confounder found mid-window can be
   recorded through the product. This is the real fix and is independent of this
   experiment.

If the field is populated by any route, it does surface:
`build-outcome-card.ts` pushes `Recorded deviation: …` into the card's notes
unconditionally, with no dependence on a protocol identity mismatch.

## 5. Pre-flight before the retest

- [ ] **Redeploy `fly.worker.production.toml`.** D-036 raised
      `WORKER_MAX_SLOTS_PER_CLAIM` from 1 to 7 but states the change takes effect
      only on redeploy. Under the one-slot bound the retest runs once and parks
      `slot_budget_exhausted`, and no Outcome Card can be built from it.
- [ ] `INTERVENTION_ADMIN_ENABLED=true` — exact string, or every intervention
      route answers 503 before auth.
- [ ] `FLY_WORKER_APP`, `FLY_WORKER_MACHINE_ID`, `FLY_API_TOKEN` all set — they
      are all-or-nothing; with any unset the retest start answers 503.
- [ ] No other job in `queued` — `claim_protocol_execution_job` takes the oldest
      eligible job globally, not this one (see CURRENT_STATUS §18.5 item 2).
- [ ] Freeze holding (§6).

## 6. Freeze list, 2026-09-30 → 2026-10-09

Must not change:

1. `/perplexity-content-change-test` — any edit changes the artifact under
   observation.
2. The homepage and `/scan` — already confounded twice.
3. `robots.txt`, `sitemap.xml`, canonical URLs, titles, meta descriptions.
4. The buyer question, protocol, provider, surface or model config — a change
   trips `PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED` and returns `inconclusive`.
5. Any other publicly retrievable page.

Safe to change: `/admin/**`, API routes, worker configuration, migrations,
tests, and documentation. None is retrievable by the provider.

**Verified live on 2026-09-30:** the intervention page returns 200, carries no
`X-Robots-Tag`, is listed in `sitemap.xml`, and is not disallowed in
`robots.txt`.

**Standing limitation:** Zypact is both operator and audited brand here. That
does not invalidate the measurement, but it must be disclosed wherever this
result is shown.

## 7. Retest procedure

Every step is a control in the founder console. No terminal is required.

1. **Admin → Interventions** → open this intervention.
2. Read the eligibility panel. It calls `retest_eligibility`, the single
   authority. Do not judge readiness from the dates.
3. **Create retest protocol** → `create_retest_protocol`. One retest per
   intervention is enforced by `0079`; a second press replays rather than
   creating a second measurement.
4. **Queue retest run** → `enqueue_protocol_execution_job`. Idempotent, spends
   nothing.
5. **Run retest now** → starts the Fly machine. **This is the only step that
   spends.** It refuses unless this intervention's own job is `queued`.
6. Wait for the job to read `succeeded`. `readRetestProgress` counts actual
   `attempt_kind` values rather than assuming them.
7. **Build Outcome Card** → refuses unless the job succeeded.
8. Review. If `needs_review`, the acknowledgement checkbox is required.
9. **Send to customer** → fenced on `expectedRevision`, so what is sent is what
   was reviewed.

`WORKER_MAX_THROTTLED_RETRIES = "0"` in production: one rate-limit or
concurrency refusal closes the job into `needs_review_request_evidence` and
needs an operator. One start is one job by design; if it stops early, start it
again.

## 8. Reporting the result honestly

`no_clear_change` and `inconclusive` are results, not failures. The product's
claim is the process and the evidence contract, never a favourable model
response, and this is the first opportunity to demonstrate that on Zypact's own
data.

Whatever the status, the presentation must carry: the confounders in §3, the
single-surface limitation, the 5-run sample and what it could detect, and the
standing non-causality statement. An observed increase is not evidence that the
page caused it.
