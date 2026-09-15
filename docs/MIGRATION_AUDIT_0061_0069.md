# Migration audit — 0061 through 0069

- **Status:** Read-only audit of the nine migrations on `fix/v1-customer-flow`
- **Audit date:** 2026-09-15
- **Base:** `6a50b976293c9b49a610ad686bacb3dc8b85fae3` (`main`)
- **Head audited:** `91ff9545a4498db3f3dfe4a41ef33589ee71ad67`
- **Method:** Full read of all nine migration files plus the app-layer call
  sites for the behaviour they gate. No database was contacted.

The pull-request body for this branch recorded that migrations 0061–0068 "were
not audited in this pass". This file closes that gap. Migration 0069 was
reviewed in the same pass.

**None of the nine has been applied to any environment.** Repository files are
not evidence of deployed state; verify the remote migration ledger before
applying anything.

## 1. Summary

| Migration | Subject | Verdict |
|---|---|---|
| `0061_snapshot_request_contact_name` | Requester contact name + widened guarded RPC | Clean |
| `0062_snapshot_approval_launches_protocol_baseline` | Approval creates question/protocol/job | Clean, 2 residual risks |
| `0063_snapshot_baseline_paraphrase_plan` | Writes the approved question into `paraphrase_plan` | Clean (bug fix) |
| `0064_backfill_measured_perplexity_cost` | One-off cost repair | Clean, 1 deployment precondition |
| `0065_protocol_report_payload` | Structured report payload column | Clean |
| `0066_protocol_job_review_resolution` | An exit from `needs_review` | Clean, 1 latent defect |
| `0067_preserve_prior_needs_review_reason` | Preserves the pre-resolution reason | Clean, inherits 0066's defect |
| `0068_report_integrity_status` | Records the integrity decision | Clean, 2 findings |
| `0069_new_baseline_default_five_runs` | Raises the default plan to 5 runs | Clean |

Overall these are unusually careful migrations. Every one is additive, every
new function is `security definer` with `search_path` pinned and privileges
revoked from `public`/`anon`/`authenticated` and granted only to
`service_role`, and each carries a rollback note. Nothing found in this audit
blocks applying them to staging.

The findings below are ordered by consequence, not by migration number.

## 2. Findings

### F-1 — `blocked` was enforced only in the UI (fixed in this pass)

**Severity:** High. **Status:** Fixed.

0068 records the integrity decision so it can gate delivery. Three surfaces
read it, but the API route that actually sends a report to a client —
`app/api/internal/snapshot-requests/[requestId]/send-report/route.ts` — did
not. The `blocked` check existed only in admin React components
(`run-pipeline-button.tsx`, `review-panel.tsx`), which hide the control rather
than refuse the action. Any founder-authenticated caller reaching the route
directly would have delivered a blocked artifact.

The canonical rule is unconditional: `blocked` never delivers.

**Fix applied.** `loadRequestContext` now returns `integrityStatus`, and
`createSendReportHandler` refuses `blocked` with HTTP 409 `integrity_blocked`
*before* the delivery claim is taken, so a refused send never holds a claim to
release. Covered by new cases in `scripts/test-send-report-fencing.ts`
asserting the refusal, that BEGIN/provider/FINALIZE are never reached, and
that `integrity_passed` and legacy `null` are unaffected.

### F-2 — `needs_review` artifacts still render to a client who holds the token

**Severity:** High. **Status:** Open — needs a product decision.

`app/report/[secureToken]/page.tsx:79` refuses only `blocked`. An artifact
whose decision is `needs_review` renders in full to anyone holding the secure
token, and so does a legacy artifact whose `integrity_status` is `null`.

The canonical rule is that `needs_review` requires founder/admin review
*before* delivery. Today the only thing standing between a `needs_review`
artifact and a client is the founder choosing not to send the link — a
procedural control, not an enforced one.

This was not fixed in this pass because the correct behaviour is a policy
choice, not a bug fix, and the wrong choice breaks live flows:

- a strict allowlist (`integrity_passed` only) would stop legacy `null`
  artifacts — already delivered to real clients — from rendering;
- gating on a recorded review resolution requires deciding what "reviewed"
  means for a report, which does not yet exist as a stored fact (0066/0067
  record review resolution for *jobs*, not for report artifacts).

**Recommended:** render when `integrity_status = 'integrity_passed'`, or when
the artifact has a non-null `delivered_at` (which covers every legacy
artifact a client already holds), and refuse otherwise. That is an allowlist,
it preserves existing client links, and it makes the founder's send action —
already fenced and recorded — the thing that authorises client visibility.

### F-3 — Review resolution excludes attempts across the whole protocol, not the job

**Severity:** Medium now, High once retest exists. **Status:** Open.

Introduced by 0066 and inherited unchanged by 0067,
`resolve_protocol_job_review` excludes non-terminal attempts with:

```sql
where protocol_id = v_job.protocol_id
  and status in ('reserved', 'in_progress')
```

This is scoped to the **protocol**, not to the job being resolved.
`protocol_attempts.job_id` exists (0050) and is not used here.

Today this is latent: D-025 gives a protocol one job that advances through
every baseline slot, so "all non-terminal attempts for the protocol" and "all
non-terminal attempts for this job" coincide. It stops being latent the moment
a protocol carries a second job — which is exactly what M7 retest introduces.
Resolving a stale baseline review would then silently exclude a live retest's
in-flight attempts, corrupting the retest denominator with no error raised.

**Recommended:** add `and job_id = v_job.id` before any retest job can exist,
and add a fixture with two jobs on one protocol.

### F-4 — Re-rendering a report destroys the previous integrity decision

**Severity:** Medium. **Status:** Open.

0068's `save_protocol_report_artifact` updates an existing undelivered
artifact in place, overwriting `integrity_status` and `integrity_reasons`. So
an artifact that was `blocked` for a stated reason, then re-rendered after a
change, retains no record that it was ever refused or why.

This is inconsistent with the care taken elsewhere in the same tranche: 0067
exists *specifically* to stop a review reason being lost on resolution, and
0068's own header argues that "a founder needs to see what was refused and
why". The reason survives resolution but not re-rendering.

**Recommended:** carry the superseded decision forward the way 0067 does, or
append integrity decisions to their own small ledger keyed by artifact.

### F-5 — `prompt_hash` is never verified against `prompt_text` at the database layer

**Severity:** Medium. **Status:** Open by prior decision.

0062/0063/0069 insert `prompt_text` read from the locked request row while
taking `p_prompt_hash` from the caller, and never check that one is the digest
of the other. 0047 deliberately assigns hash authority to the application
layer, so this is consistent with existing decisions rather than a regression.

It is still the one place in the evidence chain where a caller bug produces a
question whose stored hash does not describe its stored text, and every
downstream provenance claim rests on that pairing. The repository already has
a server-side digest helper (`_sha256_hex`, used by 0035 and 0051), so the
check is available without new infrastructure.

**Recommended:** verify the pairing inside the function, or record explicitly
in `DECISIONS.md` that the risk is accepted and why.

### F-6 — `pg_input_is_valid` requires PostgreSQL 16 or newer

**Severity:** Medium. **Status:** Deployment precondition.

0064 guards its JSON cast with `pg_input_is_valid`, which does not exist
before PostgreSQL 16. If any target environment runs PostgreSQL 15, this
migration fails on apply. Confirm the server version of each target before
applying, and note that Supabase projects created at different times do not
all run the same major version.

### F-7 — Competitor self-exclusion is exact-match only

**Severity:** Low. **Status:** Open, mitigated downstream.

0062's guard rejects a competitor equal to the company name or normalized
domain, case-insensitively. "Acme" as the company does not reject "Acme Inc",
"Acme Corp" or "acme.com" as a competitor. The D-017/D-018 entity resolver
enforces brand-self exclusion unconditionally at ingestion, so this is defence
in depth rather than the only guard — but the approval UI will accept the
entry without complaint, and the founder is the last human check.

### F-8 — `buyer_category` holds the full buyer-question text

**Severity:** Low (documentation/naming). **Status:** Open.

Despite the name, `snapshot_requests.buyer_category` carries the complete
buyer question, and 0062/0063/0069 read it as such. This is documented inside
the migration headers and in `lib/db/types.ts`, but the column name actively
misleads anyone reading the schema first. A future contributor filtering or
truncating a "category" would silently damage question identity.

**Recommended:** a `comment on column` at minimum; a rename when a migration
touches the table for another reason.

### F-9 — Five identical runs measure provider nondeterminism, not paraphrase robustness

**Severity:** Low (methodology framing). **Status:** Note for M7.

0063 writes a single-entry `paraphrase_plan`, and `promptForSlot` takes it
modulo the slot index, so all planned runs send the identical approved
question. 0069 raises that to five. This is a legitimate design — repeated
identical draws estimate a presence rate under provider nondeterminism — but
it is not coverage across phrasings, and the report must not imply otherwise.
It matters for the Outcome Card because baseline and retest comparability
rests on this being held constant.

## 3. Verified — properties that hold

These were checked rather than assumed:

- **0064 is deterministic.** Its `UPDATE ... FROM provider_call_receipts`
  would pick an arbitrary row if a call could have several receipts.
  `provider_call_receipts_external_call_key unique (external_call_id)` (0050)
  makes that impossible. It is also idempotent: the `actual_cost_usd is null`
  predicate makes a re-run a no-op, and it never touches `raw_response_body`.
- **0061 does not break a deploy window.** Its new 8-argument function has
  defaults on the last two parameters, so a still-running older application
  calling the 7-argument form resolves to the new function. The old overload
  is dropped rather than left resident.
- **0062 is atomic and replay-safe.** Every insert and every nested RPC call
  runs in one function body, so a crash leaves no partial question/protocol/job
  to duplicate. A repeated approval returns the existing row and never mints a
  second protocol.
- **0062 cannot be double-executed by the legacy worker.** It terminates on
  status `approved`; `claim_next_snapshot_request` (0030) only ever selects
  `queued`.
- **0063 preserves grants.** It replaces the function with an unchanged
  signature, so `create or replace` keeps existing privileges.
- **0067 satisfies the terminal-state constraint.** It sets `terminalized_at`
  via `coalesce`, which `protocol_attempts_terminal_pair_check` requires for
  `excluded`. Leaving `actual_cost_usd` null is legal and is the honest
  unknown 0066 documents.
- **0068 preserves delivery fencing.** A delivered artifact is never
  rewritten (`delivered_at is not null` returns early), and it refuses to
  write at all unless the request is `approved`, carries a `protocol_id`, and
  has at least one succeeded job.
- **0069 mutates nothing.** It contains no `UPDATE`, `DELETE` or `ALTER`
  against `protocols`; existing baselines keep their plan.
- **Later migrations leave the Phase 3D contract alone.** The `PINNED` scan in
  `test-m5-0060-schema-contract.ts` was run against all nine new migrations
  and none of them touches a pinned function.

## 4. Reading order caveat

`approve_and_launch_snapshot_baseline` is defined three times on this branch —
0062, then replaced wholesale by 0063, then by 0069. **0069 is the only
authoritative body.** Reading 0062 alone gives the wrong sample plan and a
`paraphrase_plan` bug that 0063 fixed.

## 5. Test-harness defects found while auditing

These are not migration defects, but they were blocking verification.

- **CRLF checkout breaks digest-pinned contracts on Windows.** `core.autocrlf`
  is `true` and the repository had no `.gitattributes`, so a Windows checkout
  materialises CRLF while the SQL schema contracts pin SHA-256 digests
  computed over LF. `test:m5-0059-schema` scored 111/127 for this reason alone.
  A `.gitattributes` forcing `eol=lf` is added in this pass. **Existing working
  copies still need `git add --renormalize .` once, as its own commit.**
- **POSIX path separators in two assertions.** `test-m5-0059-schema-contract.ts`
  and `test-m5-0060-schema-contract.ts` compared paths with
  `endsWith("/supabase/migrations/…")`, which cannot match a Windows path.
  Fixed by normalising separators before the comparison.
- **An obsolete head assertion.** `test-m5-0060-schema-contract.ts` asserted
  that no migration above 0060 exists, which this branch necessarily violates
  nine times over. It was a proxy for "nothing later undoes this slice"; the
  `PINNED` scan in the same file enforces that property directly and passes
  against all nine. The proxy assertion is removed.

  With those three fixed, `test:m5-0056-schema` (71/71), `test:m5-0059-schema`
  (127/127) and `test:m5-0060-schema` (183/183) all pass on a renormalised
  tree.

- **A registered test command tests a route contract that no longer exists.**
  `test:snapshot-send-idempotency` fails 18 of 24 checks, every one with
  `400 invalid_expected_artifact_id`. The script sends no
  `expectedArtifactId`/`expectedRevision` and was last touched before the
  delivery-fencing contract required them. It is a pre-existing failure,
  unrelated to this branch, and it is one of the 24 commands
  `CURRENT_STATUS.md` lists as the registered inventory — a concrete instance
  of the "a file count is not a passing test count" hazard that document warns
  about. It should be rewritten against the fenced contract or retired.

## 6. Not established by this audit

- whether any of these migrations applies cleanly to a real database;
- any deployed migration ledger, in any environment;
- the runtime behaviour of the RPCs (no runtime contract was executed);
- migrations 0001–0060, which were outside this audit's scope;
- the production `/login` HTTP 500 reported during SEO probing: `/login`
  returns 200 against a local dev server, and live probing was not possible
  from the audit environment. The most probable cause is
  `getSupabaseServerClient()` throwing when `NEXT_PUBLIC_SUPABASE_URL` or
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` is absent from the deployment environment:
  `/login` is `force-dynamic` and calls `getCurrentUser()` on every request,
  so a missing variable becomes an unhandled throw. Check those two variables
  in the Vercel environment for the failing deployment before changing code.
