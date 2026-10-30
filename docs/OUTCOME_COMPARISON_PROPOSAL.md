# Outcome comparison and uncertainty — proposal

- **Status: SIGNED OFF by founder, 2026-09-16. §6 decisions resolved below;
  to be promoted to numbered decision records in `DECISIONS.md` before the
  comparison engine is built.**
- **Drafted:** 2026-09-15
- **Signed off:** 2026-09-16
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

**Founder position (2026-09-16): consequence accepted for V1 pilots**, on the
condition that §5 (power shown at approval) ships with the comparison engine
and is not deferred. The limitation is acceptable only if it is disclosed
before money is spent, never discovered afterwards.

## 4. Proposed status rules

Let `Δ` be the observed difference, `[lo, hi]` its Newcombe 95% interval, and
`Δ_min` the minimum useful change declared and approved **before** execution.

Evaluated in order:

1. **`inconclusive`** if any of:
   - readable runs in either phase fall below the declared floor
     (approved: fewer than 3, or fewer than 60% of that phase's plan);
   - question identity, protocol identity or provider configuration differs
     between phases without a recorded authorised deviation — comparability
     is broken and no status can be earned;
   - the protocol's smallest detectable change is **larger** than `Δ_min` and
     `[lo, hi]` includes zero.
2. **`increase_observed`** if `lo > 0` and `Δ ≥ Δ_min`.
3. **`decrease_observed`** if `hi < 0` and `|Δ| ≥ Δ_min`.
4. **`inconclusive`** if `[lo, hi]` reaches `Δ_min` in either direction
   (`lo ≤ −Δ_min` or `hi ≥ Δ_min`) — reason
   `INTERVAL_INCLUDES_MINIMUM_USEFUL_CHANGE`. *Added by D-038, 2026-10-29.*
5. **`no_clear_change`** otherwise, i.e. only when the interval lies strictly
   inside (−`Δ_min`, +`Δ_min`).

> **D-038 amendment.** As first signed off, rule 4 read "`no_clear_change`
> otherwise". At the V1 plan the smallest detectable change equals `Δ_min`,
> so rule 1's third clause never fires, and wide intervals such as
> 1/5 → 4/5 ([0.00, 0.83]) fell through to `no_clear_change`, contradicting
> the meaning stated below. See `DECISIONS.md` D-038.

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

Approved: `approve_protocol` computes and stores the smallest detectable
change for the approved plan, and the approval surface states plainly, e.g.
*"This plan can detect a change of 60 points or more. A smaller change will
return inconclusive."*

This is a small addition and it converts the sample-size limitation from a
disappointment into an informed, recorded choice. **Per the founder position
in §3, this section is a condition of the sign-off, not an optional
enhancement.**

## 6. Decisions — RESOLVED 2026-09-16

Founder sign-off. Each item below is to be promoted to a numbered decision
record in `DECISIONS.md`; until then this section is the authoritative
statement of the four choices.

1. **`Δ_min` = 0.60 for all V1 pilot protocols.** Remains a protocol
   parameter per D-002 with no code default; 0.60 is the approved value for
   V1, chosen because it is the only value self-consistent with the 5-run
   plan (decision 3). If decision 3 is revisited, this value must be
   revisited with it — the two are a pair and must never be changed
   independently.
2. **Readable-run floor: approved as proposed.** A phase is comparable only
   with at least 3 readable runs and at least 60% of that phase's planned
   runs. Below either bound, the result is `inconclusive` by rule 1.
3. **D-032's 5-run default stands for V1 pilots.** The 60-point detection
   threshold is accepted as the honest capability of a V1 pilot, on two
   conditions: (a) §5 ships with the comparison engine — the approval
   surface must state the smallest detectable change before any spend is
   authorised; (b) any pilot whose intervention is expected to produce a
   movement smaller than 60 points must be offered a 10-run plan (40-point
   threshold, roughly double provider cost) at approval time rather than
   being silently run at 5. The default is a starting point, not a cap.
4. **`Δ_min` is fixed across phases and across protocols for V1.** One value
   (0.60), no per-protocol variation, no per-phase variation. Per-protocol
   `Δ_min` may be introduced after V1 as its own decision record; introducing
   it now adds a negotiable surface with no V1 customer to negotiate it.

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
- Five-run baseline default — D-032 (provisional; confirmed for V1 by §6.3).
- Outcome statuses and the non-causality footer — D-005, D-006, D-007.
- Existing Wilson implementation — `lib/reports/build-protocol-report.ts`.
- Retest execution is a separate job reusing the existing claim primitives —
  founder decision, 2026-09-15, pending its own decision record.