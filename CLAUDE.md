# CLAUDE.md — Zypact Repository Instructions

This file governs Claude Code and other coding agents working in this repository. It is navigation and engineering-safety guidance, not a substitute for the canonical product documents.

## Required reading order

Before estimating or changing V1 behavior, read:

1. [`docs/ENGINEER_START_HERE.md`](docs/ENGINEER_START_HERE.md)
2. [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md)
3. [`docs/V1_SCOPE.md`](docs/V1_SCOPE.md)
4. [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
5. [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md)
6. [`docs/DECISIONS.md`](docs/DECISIONS.md)

Operational and sequencing context:

- [`docs/PILOT_RUNBOOK.md`](docs/PILOT_RUNBOOK.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/WORKER_DEPLOY_RUNBOOK.md`](docs/WORKER_DEPLOY_RUNBOOK.md)

If an archived file, code comment, UI label, prompt, test fixture, or old estimate conflicts with the active canonical package, the canonical package controls the intended V1. Existing code still containing a legacy behavior is evidence of work to assess; it is not permission to repeat that behavior.

## Product boundary to preserve

The V1 offer is **Evidence-Backed Shortlist Diagnostic + Registered Retest**.

- Live surfaces: Perplexity Sonar, and ChatGPT (the OpenAI Responses API with web search) once its worker switch is turned on under its own authorisation (D-053, D-061). Each is presented as its own directional proxy; nothing is combined across them.
- No fixed three-run external client score.
- No `won`, `partial`, or `lost` client verdicts.
- No claim that an AI answer caused a lost sale, an intervention caused a change, or that one surface, or the surfaces measured together, represent all AI buyers.
- Paid execution requires approved question/protocol identity, bounded sampling, admission control, and reservation before each attempt.
- Exact provider request/response evidence must be immutable and auditable.
- One canonical snapshot must drive all client views and artifacts.
- Retest preserves question/protocol identity, an intervention record, an observation window, and visible uncertainty.
- Outcome statuses are limited to `increase_observed`, `decrease_observed`, `no_clear_change`, and `inconclusive`.
- `integrity_passed` may deliver automatically; `needs_review` requires founder/admin review; `blocked` never delivers.

Coverage beyond the two pilot engines, continuous monitoring, full Buyer Journey Intelligence, predictive scoring, CRM integrations, enterprise scope, and causal/revenue attribution are deferred.

## Audited repository baseline

The documentation reset was reconciled against official main commit `b339d42a28014d8436c180a7da0cb0ad876178b8` on 2026-08-16. Re-fetch and identify the actual base before work begins.

At that audited commit:

- 35 SQL migrations are tracked through `0035_snapshot_report_delivery_fencing.sql`;
- 73 files match `scripts/test-*.ts`;
- `package.json` registers 24 `test:*` and 2 `verify:*` commands;
- the worker claim/lease/fencing path already exists and should be evaluated for reuse;
- the public customer workflow, evidence contract, report semantics, and retest do not yet satisfy the canonical V1.

**That snapshot is 2026-08-16 and is now far behind `main`.** It is kept because
it is what the documentation reset was reconciled against, not because it
describes the repository. Measured on branch `feat/chatgpt-phase-b` at `f580273`
on 2026-11-18, and recounted unchanged after the review fixes on top: **95** migrations (82 four-digit, `0001`–`0081` and `0083`, and 13
timestamped, the last `20261113120000`), **229** files matching
`scripts/test-*.ts`, and **135** `test:*` plus **4** `verify:*` commands. The M7
retest and Outcome Card application layer is merged. See
[`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md) section 37, which supersedes
every inventory figure above and in sections 3, 7, 12, 13, 15 and 18 of that
file.

Do not infer deployed migration state, worker health, or production parity from repository files. M0 verifies those separately.

## Standard local checks

Run from the repository root:

```bash
npm run typecheck
npm run build:verify
```

`build:verify` runs the same production build into `.next-verify/`. Use it instead of `npm run build` whenever a dev server may be running: `next build` wipes its output directory first, so building into `.next` deletes the manifests a running `next dev` is serving from and every request 500s until that server is restarted. Deployments keep running `npm run build`, which still writes `.next`.

`npm run dev:forever` supervises `next dev`, restarting it if it exits or stops accepting connections, and printing the reason each time.

Use the exact test-command inventory in [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md). Record commands and results; do not summarize test confidence using only a file count.

Live credential-dependent tests require approved staging resources. A simulated test cannot be presented as a live-provider validation.

## Worktree and Git safety

1. Inspect `git status`, the current branch, remotes, and relevant history before edits.
2. Existing modified or untracked files belong to the user unless the task explicitly says otherwise.
3. Preserve unrelated work; never stage with `git add -A` or `git add .` when a precise path list is possible.
4. Work on a feature branch and submit a pull request. Do not commit directly to `main`.
5. Do not force-push, rewrite published history, reset destructively, or delete unrelated files.
6. Before commit, verify the exact staged path set and run `git diff --cached --check`.
7. Before push, confirm no secret, environment, prospect evidence, generated report, raw output, image, or unrelated path is staged.
8. Do not merge unless the user explicitly authorizes the merge after review.

## Data and secret safety

- Never request secret values in chat, email, issues, pull requests, or documentation.
- Never print or commit `.env*`, provider keys, service-role keys, tokens, claim tokens, customer emails, raw client responses, or generated prospect reports.
- Store only the evidence fields authorized by the canonical evidence contract; do not store authorization headers or secrets.
- Use non-confidential fixtures in tests and demos.
- Keep raw client evidence tenant-protected.
- Logs must use closed, privacy-safe fields and must not echo prompts, company data, responses, credentials, or claim tokens unless an approved secure diagnostic explicitly requires it.

## Database and production safety

- No production mutation without explicit milestone authorization.
- Use migrations for schema changes; do not make undocumented manual schema edits.
- Verify the remote migration ledger before applying anything.
- Every schema change requires tests and rollback or forward-recovery notes.
- Evidence immutability and tenant isolation must be enforced at the database layer, not only in UI code.
- Use least-privilege access and Zypact-controlled infrastructure.
- Stop when an operation risks evidence loss, tenant exposure, duplicate paid calls, or an unrecoverable deployment.

## Evidence and paid-call invariants

- Raw evidence is insert-only through ordinary application behavior.
- Derived observations are versioned and reproducible from raw evidence.
- Question, protocol, attempt, retry, project, and tenant identity remain traceable.
- Every client-facing number links to canonical supporting evidence.
- Prompt-scoped claims use only supporting runs from that prompt/version.
- Failed and excluded attempts remain visible in denominator reconciliation.
- No paid provider call occurs before approval, admission, and reservation.
- Retries are bounded and idempotent; a crash or duplicate submit cannot silently spend twice.
- Incomplete or inconsistent evidence fails closed into an honest state.

## Pull-request acceptance

Every implementation pull request should include, as applicable:

- exact base and head commits;
- changed-path list;
- tests added or updated;
- commands run and result summary;
- migration and recovery notes;
- staging demonstration evidence;
- known limitations and deferred work;
- documentation changes for behavior or methodology changes;
- confirmation that no secrets or prospect evidence are included.

## Stop and ask

Stop before implementation when:

- repository reality materially contradicts a canonical requirement;
- scope or acceptance criteria are ambiguous;
- the provider interface cannot preserve required provenance;
- sampling or uncertainty behavior is not defensible;
- reservation, retry, or spend semantics are unclear;
- a migration could destroy evidence or weaken tenant isolation;
- a requested UI statement violates the methodology;
- staging cannot demonstrate the milestone safely;
- the request adds a provider, integration, enterprise feature, or causal claim outside the approved scope.

Do not silently choose the fastest interpretation. Document the conflict and request a decision.
