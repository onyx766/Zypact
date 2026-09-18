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

- `enqueue_protocol_execution_job` — the idempotent enqueue RPC. *Not* its
  HTTP route `POST /api/projects/[projectId]/protocol-runs`, which authorizes
  the project owner and so answers the founder 404 for snapshot-created
  projects (see Phase 4).
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

- [x] **0077** — `reject_intervention(p_intervention_id, p_project_id, p_rejected_by, p_reason)`
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
- [x] Run — 52/52 against real PostgreSQL 16
- [ ] Schema contract test (text-only, digest-pinned, per existing precedent)
- [x] Applied to staging — CURRENT_STATUS §16.1

---

## Phase 1 — Shared admin plumbing (blocks Phase 2)

- [x] Admin authorization helper — `requireFounderForRoute` in
      `lib/auth/founder.ts`, same 401/503/404 semantics the snapshot routes
      inline today (those routes are not migrated onto it in this change)
- [x] Kill switch — `INTERVENTION_ADMIN_ENABLED` must be exactly `"true"` or
      every intervention route answers 503. **Must be set on Vercel** before
      the routes do anything.
- [x] RPC error → HTTP mapping — `lib/interventions/rpc-errors.ts`.
      `test:intervention-rpc-errors` reads 0071-0077 and fails if any raised
      message is unmapped, or any mapped key is raised by nothing. The table
      below was the plan; the module is now the authority:

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

- [x] `POST /api/internal/interventions` — register (201)
- [x] `POST /api/internal/interventions/[id]/approve`
- [x] `POST /api/internal/interventions/[id]/reject`
- [x] `POST /api/internal/interventions/[id]/abandon`
- [x] `POST /api/internal/interventions/[id]/confirm-implementation`
- [x] `POST /api/internal/interventions/[id]/authorize-early-retest`
- [x] `GET /api/internal/interventions` — list, joined to project; eligibility
      asked of `retest_eligibility()` for `implemented` rows only
- [x] `GET /api/internal/interventions/[id]` — detail incl. `retest_eligibility()`
- [x] Tested (`test:intervention-routes`, 39): project id taken from the stored
      row, an empty RPC result reported as a refusal, the kill switch answering
      503 before the body is read
- [ ] **Not tested:** the 401 / 404 founder paths through a real session. The
      decision is unit-tested (`evaluateFounderAccess`); the session plumbing is
      shared with the snapshot routes. Verify on staging with a non-founder
      account.
- [x] **Chained retests — decided: forbidden in the database too.** `0078`
      makes `register_intervention` raise `protocol_is_not_a_baseline`, with a
      precondition block that refuses to apply over an already-chained row.
      Runtime contract 16/16. Applied to staging, pre-flight run first;
      post-apply verification screenshot outstanding (§16.2 pending).
- [x] Supporting evidence is checked at registration (D-009): every cited id
      must be a completed baseline attempt of the same protocol. The database
      stores evidence as opaque strings and cannot check this itself.

---

## Phase 3 — Intervention admin UI

**Built** — `app/admin/interventions/` (list, stats, tabs, search, register
drawer) and `app/admin/interventions/[interventionId]/` (claim, cited runs,
baseline, lifecycle timeline, status-gated actions). `test:intervention-admin-ui`
(36) renders both client components and checks every status offers exactly its
moves. **Not verified in a browser** — the pages read through the service-role
client and need staging to render. The plan below is kept for reference.

- [x] `app/admin/interventions/` — list
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

- [x] `POST /api/internal/interventions/[id]/create-retest` → `create_retest_protocol`.
      Eligibility is not re-derived; the RPC calls `retest_eligibility` itself.
- [x] `POST /api/internal/interventions/[id]/queue-retest` →
      `enqueue_protocol_execution_job`, with the RPC's default `max_attempts`
      exactly as the baseline path calls it.
  - **Corrected plan.** This originally said to reuse
    `POST /api/projects/[projectId]/protocol-runs` and write no new endpoint.
    That route authorizes the project *owner*; projects created from snapshot
    requests have none, so it answers the founder 404 by design. The RPC is
    the shared contract and is reused; the authorization model is not.
- [x] Retest progress on the detail page: job status, attempts by status and
      by kind. A non-`retest` attempt on a retest protocol is surfaced as a
      broken invariant, never hidden.
- [x] **0079 — one retest per intervention.** 0073's idempotency lookup
      skipped `completed`, so a finished retest could be followed by a fresh
      one for the same intervention: re-measurement until the result is
      welcome. 0079 returns a completed retest instead of replacing it.
      Runtime contract written, **not yet run**; not yet applied to staging.
- [x] **Latent delivery bug fixed.** `deliver-outcome-card.ts` resolved an
      intervention's retest by baseline with no status filter, so after one
      abandonment a baseline held two retest rows and `maybeSingle()` threw.
      Both lookups now exclude `abandoned`; exact by 0079's invariant.
- [x] Tested: `test:retest-actions` (30), `test:intervention-admin-ui` (50).
- [ ] **HELD for explicit go-ahead — crosses the irreversible line.** Confirm
      the worker writes `attempt_kind = 'retest'` end-to-end on staging
      (`lib/protocol-worker/worker.ts` derives it from `baselineProtocolId`;
      `0074`'s trigger enforces it, but this path has never run outside
      tests). The first real retest attempt cannot be rolled back without
      deleting evidence.

---

## Phase 5 — Outcome Card

- [x] Founder trigger — `POST .../[id]/outcome-card` runs `processOutcomeCard`
      with auto-send **forced off**, and only once the retest job has
      `succeeded` (the worker's own precondition, which `processOutcomeCard`
      did not itself enforce — a direct call could have built a card from a
      half-finished retest). The scheduled worker is unchanged.
- [x] Review screen — the stored card rendered with the customer's own
      `OutcomeCardView`, its integrity status, every flagged reason, its
      revision, and any held delivery claim.
- [x] Manual send — `POST .../[id]/outcome-card/send` carries the reviewed
      artifact id and revision and refuses if either changed; `needs_review`
      requires an explicit acknowledgement.
- [x] `blocked` has no send button at all, and is refused before any claim.
- [x] **One path emails a customer.** The claim → send → finalize-or-release
      sequence was extracted from `processOutcomeCard` into
      `deliverSavedOutcomeCard`, used by both the worker and the founder
      send. 0076's `begin_outcome_card_delivery` raises on refusal; those
      known refusals are now mapped (a stale revision, an active claim) rather
      than thrown — a small behaviour change for the worker, which previously
      crashed on them.
- [x] Tested — `test:outcome-card-delivery` (43). The customer-email path had
      no tests before; see Phase 7.
- [ ] **Recorded inconsistency, not fixed.** The worker builds the card link
      from `SNAPSHOT_PUBLIC_BASE_URL`; the web send routes (snapshot report and
      now Outcome Card) use `NEXT_PUBLIC_SITE_URL || https://zypact.com`. If the
      two are set differently, a card sent by the worker and one sent by the
      founder link to different hosts. Needs one decision and one variable.
- [ ] Show the comparison result with its interval and the non-causality footer
      — rendered by the existing `OutcomeCardView`; not re-verified here
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

- [ ] `lib/reports/deliver-outcome-card.ts` — **partly covered.**
      `deliverSavedOutcomeCard` (the email path) is tested by
      `test:outcome-card-delivery`. `processOutcomeCard`'s build half — reading
      both phases, building, integrity, persisting — still has no test.
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
