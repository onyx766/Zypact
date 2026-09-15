# Outcome comparison and uncertainty — proposal

- **Status: DRAFT. Not canonical. Nothing may be built on this until it is
  signed off and promoted to a numbered decision in `DECISIONS.md`.**
- **Drafted:** 2026-09-15
- **Decides:** how baseline and retest are compared, what counts as a minimum
  useful change, and when a result is `inconclusive` rather than
  `no_clear_change`
- **Blocks:** M7 comparison engine and Outcome Card

This exists because those thresholds are methodology, not engineering. Picking
them inside the implementation would bury a judgement the founder is
accountable for in code nobody reads.

## 1. What is being compared

- **Unit of analysis:** `buyer_question_version` (as `protocols` already
  records).
- **Primary metric:** `presence_rate` — readable runs in which the audited
  brand was observed, over readable runs.
- **Denominator:** readable runs only. Failed and excluded attempts stay
  visible and reconciled, never silently dropped, and never counted as
  absence.

## 2. Proposed method

Two independent proportions, so two layers:

1. **Per phase:** the Wilson score interval already implemented as
   `wilsonInterval` in `lib/reports/build-protocol-report.ts`
   (`intervalMethod: "wilson_95"`). Unchanged.
2. **For the difference:** **Newcombe's hybrid-score interval** (his method
   10) for `p_retest − p_baseline`, built from the two Wilson intervals.

Newcombe is the right companion to Wilson: it inherits Wilson's good
behaviour at `p = 0` and `p = 1`, which is exactly where a five-run sample
lands most often. A normal-approximation interval on the difference would
produce impossible bounds outside `[-1, 1]` at those points.

This adds one function and one `comparisonMethod: "newcombe_95"` field. It
introduces no new dependency.

## 3. What five runs per phase can actually detect

Computed, not asserted. Wilson 95% intervals at `n = 5`:

| Observed | Rate | 95% interval | Width |
|---|---:|---|---:|
| 0/5 | 0% | 0% – 43% | 43 pts |
| 1/5 | 20% | 4% – 62% | 59 pts |
| 2/5 | 40% | 12% – 77% | 65 pts |
| 3/5 | 60% | 23% – 88% | 65 pts |
| 4/5 | 80% | 38% – 96% | 59 pts |
| 5/5 | 100% | 57% – 100% | 43 pts |

A single baseline of five runs cannot locate the true rate within less than
roughly 43 percentage points.

For the comparison, of the 30 possible baseline→retest movements at 5 vs 5,
**only 10 have a 95% interval on the difference that excludes zero** — and
every one of them starts or ends at an extreme:

```
0/5 → 3/5    0/5 → 4/5    0/5 → 5/5    1/5 → 5/5    2/5 → 5/5
3/5 → 0/5    4/5 → 0/5    5/5 → 0/5    5/5 → 1/5    5/5 → 2/5
```

Notably `1/5 → 4/5` — a 60-point swing — does **not** separate.

Smallest change separable from zero, by runs per phase:

| Runs per phase | Smallest detectable change |
|---:|---:|
| 5 | 60 points |
| 10 | 40 points |
| 15 | 27 points |
| 20 | 25 points |
| 30 | 17 points |

**The consequence to accept or reject:** at the current 5-run default
(D-032), a Registered Retest can only ever report a movement of 60 points or
more. Every smaller real improvement is indistinguishable from noise and must
be reported as `inconclusive`. That is a property of the sample size, not of
the analysis, and no choice of statistic removes it.

## 4. Proposed status rules

Let `Δ` be the observed difference, `[lo, hi]` its Newcombe 95% interval, and
`Δ_min` the minimum useful change declared and approved **before** execution.

Evaluated in order:

1. **`inconclusive`** if any of:
   - readable runs in either phase fall below the declared floor
     (proposed: fewer than 3, or fewer than 60% of that phase's plan);
   - question identity, protocol identity or provider configuration differs
     between phases without a recorded authorised deviation — comparability
     is broken and no status can be earned;
   - the protocol's smallest detectable change is **larger** than `Δ_min` and
     `[lo, hi]` includes zero.
2. **`increase_observed`** if `lo > 0` and `Δ ≥ Δ_min`.
3. **`decrease_observed`** if `hi < 0` and `|Δ| ≥ Δ_min`.
4. **`no_clear_change`** otherwise.

### Why rule 1's third clause is the important one

It is the whole distinction between the two negative statuses.

- `no_clear_change` means **"a change of the size you told us mattered would
  have been visible, and it was not there."**
- `inconclusive` means **"this test could not have seen that change either
  way."**

Without that clause every underpowered retest collapses into
`no_clear_change`, and a client reads "your intervention did nothing" when the
truthful statement is "this sample could never have told you". That is the
single most likely way this product misleads someone, and it is the failure
mode `inconclusive` exists to prevent.

## 5. Power must be shown at approval, not discovered at outcome

If a protocol's plan cannot detect the `Δ_min` being approved, that must be
visible on the approval screen, before any money is spent — not surfaced
months later as an `inconclusive` Outcome Card after the customer has waited
through an observation window.

Proposed: `approve_protocol` computes and stores the smallest detectable
change for the approved plan, and the approval surface states plainly, e.g.
*"This plan can detect a change of 60 points or more. A smaller change will
return inconclusive."*

This is a small addition and it converts the sample-size limitation from a
disappointment into an informed, recorded choice.

## 6. What needs your decision

1. **`Δ_min`** — a protocol parameter, per D-002, with no code default. At 5
   runs per phase the only self-consistent value is **0.60**; anything smaller
   makes every result `inconclusive` by construction.
2. **The readable-run floor** for rule 1. Proposed: 3 runs, and at least 60%
   of the plan.
3. **Whether D-032's 5-run default stands.** Five runs buys a 60-point
   detection threshold. Ten buys 40 points at twice the provider cost. This is
   a commercial decision about what a pilot is worth, and it should be made
   deliberately rather than inherited from the legacy `WORKER_RUNS=3`.
4. **Whether `Δ_min` may differ between phases or protocols**, or is fixed for
   V1 pilots.

## 7. What this proposal does not change

- No status other than the four approved ones is ever produced.
- No rule here can assert causality; the permanent non-causality footer
  (D-006/D-007) is unaffected and unconditional.
- Baseline and retest denominators still reconcile, and excluded attempts
  stay visible.
- Nothing here licenses re-running a retest until a preferred status appears.
  The protocol and its `Δ_min` are fixed before execution, which is what makes
  the retest *registered*.

## 8. Related

- Sample plans are protocol parameters, never magic numbers — D-002.
- Five-run baseline default — D-032 (provisional).
- Outcome statuses and the non-causality footer — D-005, D-006, D-007.
- Existing Wilson implementation — `lib/reports/build-protocol-report.ts`.
- Retest execution is a separate job reusing the existing claim primitives —
  founder decision, 2026-09-15, pending its own decision record.
