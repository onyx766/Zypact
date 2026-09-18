# Option A — the retest application layer

**Goal:** a founder can drive a complete retest from the admin UI, without
issuing SQL.

**Where this starts.** Migrations `0070`–`0076` are applied to staging and
runtime-proven (see [`CURRENT_STATUS.md`](CURRENT_STATUS.md) §16). The database
can do a retest. Nothing in `app/` can reach it: no route or component calls
`register_intervention`, `approve_intervention`,
`confirm_intervention_implementation`, `authorize_early_retest`,
`create_retest_protocol` or `retest_eligibility`.

**What already exists and should be reused, not rebuilt:**

- `POST /api/projects/[projectId]/protocol-runs` — fully generic, enqueues any
  approved protocol's execution job. Works for a retest protocol unchanged.
- `scripts/run-outcome-card-worker.ts` — builds and delivers Outcome Cards.
- `lib/reports/deliver-outcome-card.ts` — `processOutcomeCard`,
  `findDeliverableInterventions`.
- `app/outcome-card/[secureToken]/page.tsx` — the client-facing card.
- `app/admin/snapshot-requests/` + `app/api/internal/snapshot-requests/` — the
  founder-operations pattern to mirror exactly.

---

## Phase 0 — Close the schema gap (blocks Phase 2)

`interventions.status` permits `rejected` and `abandoned`, and
`interventions_rejection_reason_check` requires a non-empty `rejected_reason`
whenever status is `rejected`. But no RPC sets either status, and `0071` grants
`service_role` only `select` on the table — no `UPDATE`. **Both states are
structurally unreachable.** Any UI that offers a Reject button will fail.

- [ ] **0077** — `reject_intervention(p_intervention_id, p_project_id, p_rejected_by, p_reason)`
  - only from `proposed`; idempotent replay returns the row untouched
  - requires non-empty reason (the constraint already demands it)
  - must not set `approved_by`/`approved_at` — `interventions_approval_pair_check`
    forbids it for `rejected`
- [x] **0077** — `abandon_intervention(p_intervention_id, p_project_id, p_abandoned_by, p_reason)`
  - legal from `proposed`, `approved`, `implemented`
  - releases `interventions_one_live_per_protocol` and, by taking the live
    retest protocol to `abandoned`, `protocols_one_live_retest_per_baseline`

**Decision taken — abandonment is refused once the retest has started.** The
line is drawn at "an attempt exists", not "a retest protocol exists": a
protocol created but never run has observed nothing, so taking it down is
administrative. Once a single attempt lands, stopping becomes a decision that
could be informed by what that attempt returned, and an abandonment available
at that point is the hole every unwelcome result leaves through.

This is deliberately stricter than `authorize_early_retest`, which permits its
deviation and records it. That asymmetry is the point: shortening a window
happens *before* any retest data exists and cannot be steered by the result;
abandoning mid-retest happens after, and can be. Refusing costs a handful of
provider calls and yields an honest `inconclusive`, which is already canonical.

A claimed or running job is refused on the same grounds — an attempt may be
landing at that instant. Only a never-claimed `queued` job is cancelled.

- [x] Job cancellation — `protocol_execution_jobs` gains `cancelled`, distinct
      from `abandoned_exhausted` (which means retries ran out). Inert to every
      existing path: 0050's claim predicate selects `queued` or an expired
      lease, and the 0051/0056 terminal guards are reachable only by a worker
      holding a lease.
- [x] Runtime contract — `scripts/test-m7-0077-runtime-contract.ts`
- [ ] **Run it**: `ZYPACT_M7_0077_RUNTIME_TEST=1 npm run test:m7-0077-runtime`
      (needs Docker; not runnable on the Windows workstation)
- [ ] Schema contract test (text-only, digest-pinned, per existing precedent)
- [ ] Apply to staging via [`M7_STAGING_APPLY_RUNBOOK.md`](M7_STAGING_APPLY_RUNBOOK.md)

---

## Phase 1 — Shared admin plumbing (blocks Phase 2)

- [ ] Admin authorization helper — reuse whatever `app/api/internal/snapshot-requests/*`
      already does; do not invent a second scheme
- [ ] RPC error → HTTP mapping, with founder-readable text for each:

| RPC error | Meaning | Surface as |
|---|---|---|
| `protocol_not_executable` | baseline not approved/active/completed | "This protocol has not run yet" |
| `intervention_needs_evidence` | `supporting_evidence` is `[]` | "Cite at least one run before approving" |
| `observation_window_not_declared` | `expected_observation_days` is null | "No observation window was set at registration" |
| `observation_window_is_immutable` | window edit attempted | "The window is frozen and cannot be moved" |
| `intervention_registration_is_immutable` | post-approval edit | "Approved interventions cannot be edited" |
| `INTERVENTION_NOT_IMPLEMENTED` | from `retest_eligibility` | "Confirm implementation first" |
| `OBSERVATION_WINDOW_OPEN` | window still running | "Observing — closes {date}" |

---

## Phase 2 — Intervention lifecycle routes

Mirror `app/api/internal/snapshot-requests/[requestId]/*`.

- [ ] `POST /api/internal/interventions/register`
- [ ] `POST /api/internal/interventions/[id]/approve`
- [ ] `POST /api/internal/interventions/[id]/reject` *(needs 0077)*
- [ ] `POST /api/internal/interventions/[id]/abandon` *(needs 0077)*
- [ ] `POST /api/internal/interventions/[id]/confirm-implementation`
- [ ] `POST /api/internal/interventions/[id]/authorize-early-retest`
- [ ] `GET /api/internal/interventions` — list, joined to project + protocol
- [ ] `GET /api/internal/interventions/[id]` — detail incl. `retest_eligibility()`
- [ ] Auth test per route: unauthenticated → 401, wrong project → 404/403

---

## Phase 3 — Intervention admin UI

- [ ] `app/admin/interventions/` — list
  - filters on the five real statuses: `proposed`, `approved`, `implemented`,
    `rejected`, `abandoned`
  - derived eligibility column from `retest_eligibility()`, never a stored field:
    Observing — closes {date} · Retest ready · Retest ready (early) ·
    Not started · Not applicable
  - `AUTHORIZED_DEVIATION` must look visibly different from `WINDOW_ELAPSED`
- [ ] Register form — **all eight required fields**, or the RPC rejects the call:
      baseline protocol (not just company) · hypothesis · expected mechanism ·
      action type (dropdown of the 7 enum values) · action target · owner ·
      supporting evidence · expected observation days
  - `expected_observation_days` has no setter RPC after registration. Omit it
    and the intervention can never be implemented. Make it required in the form.
  - `decision_threshold_note` is frozen at approval and PILOT_RUNBOOK §12
    requires it recorded before the result exists. Capture it here.
- [ ] Protocol selector lists only `approved`/`active`/`completed` protocols
- [ ] Supporting-evidence picker — select real run ids from the baseline
- [ ] `app/admin/interventions/[id]/` — detail
  - registered claim shown as frozen once `approved_at` is set
  - implementation panel (evidence, deviations, artifact hash)
  - window countdown from `observation_window_closes_at`
  - early-retest authorization requires a reason; show it permanently afterwards

---

## Phase 4 — Retest execution

- [ ] `POST /api/internal/interventions/[id]/create-retest` → `create_retest_protocol`
  - refuse unless `retest_eligibility().eligible` is true; do not re-derive the
    rule in TypeScript — that function is the single authority
- [ ] Wire the existing `POST /api/projects/[projectId]/protocol-runs` to enqueue
      the retest protocol's job. **Do not write a new enqueue endpoint.**
- [ ] Show retest job/attempt progress on the intervention detail page
- [ ] Confirm the worker writes `attempt_kind = 'retest'` end-to-end on staging
      (`lib/protocol-worker/worker.ts` derives it from `baselineProtocolId`;
      `0074`'s trigger enforces it, but this path has never run outside tests)

---

## Phase 5 — Outcome Card

- [ ] Trigger for build + deliver — a route wrapping `processOutcomeCard`, or a
      schedule. Today it only runs by hand.
- [ ] Admin review screen for `needs_review` cards **(flagged missing earlier;
      still missing)**
- [ ] Manual send route for `needs_review` after review
- [ ] `blocked` must be visibly un-sendable in the UI. `0076` already refuses it
      at the database layer — the UI must not present a button that always fails.
- [ ] Show the comparison result with its interval and the non-causality footer
- [ ] Verify the four canonical statuses are the only ones rendered:
      `increase_observed`, `decrease_observed`, `no_clear_change`, `inconclusive`

---

## Phase 6 — Founder sign-off condition

- [ ] Surface `protocols.detectable_change_at_plan` on the protocol approval
      screen. This is §5 of the signed-off
      [`OUTCOME_COMPARISON_PROPOSAL.md`](OUTCOME_COMPARISON_PROPOSAL.md) and is
      **still open**. `0075` stores the value; nothing in `app/` reads it.
  - at the five-run default it reads 0.60 — the same as Δ_min. Say plainly what
    that means: at this sample size, only a change of 60 points or more can be
    detected at all.

---

## Phase 7 — Tests

- [ ] `lib/reports/deliver-outcome-card.ts` — **no tests exist**
- [ ] `lib/reports/deliver-protocol-report.ts` — **no tests exist**
- [ ] Route-level auth coverage for every new internal route
- [ ] End-to-end on staging: register → approve → confirm → window → retest →
      compare → card → deliver, driven entirely through the UI

---

## Phase 8 — Close out

- [ ] Apply `0077` to staging, record it per the runbook
- [ ] Update `CURRENT_STATUS.md` — §16 currently ends by stating the application
      layer is absent; that claim must be revised, not left stale
- [ ] Open the PR for `feat/m7-retest` (still unmerged; `main` at `589483c`)
- [ ] Zypact-on-Zypact: run the full flow against Zypact's own project

---

## Ordering

```
Phase 0 ─┬─> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5
         │                                                      │
         └──────────────> Phase 6 (independent, small) <────────┘
                                   Phase 7 throughout
                                   Phase 8 last
```

Phase 6 depends on nothing else and closes an open sign-off condition. It is the
cheapest item on this list and can ship first.

## The line not to cross yet

Rollback of `0073` stops being possible once a real intervention exists and a
retest protocol is created — after that, unwinding means deleting evidence.
Staging currently holds zero interventions. Phases 0–3 can be built and tested
without crossing it; Phase 4 crosses it the first time it runs for real.
