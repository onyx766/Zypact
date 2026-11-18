# Pilot production plan

- **Status:** a plan, proposed 2026-11-17. **Nothing in it has been done.**
  - Every numbered step is a production action that needs its own founder authorisation when it comes (D-051 item 4).
  - The release order it uses is D-058, **approved by the founder on 2026-11-17**, together with step 1.
- **Scope:**
  - **Part A:** put the first paid pilot live on Perplexity, with ChatGPT switched off.
  - **Part C:** switch ChatGPT on later.
- **Sources:**
  - CURRENT_STATUS §25, §30–§34 and §36;
  - D-041, D-045, D-051 to D-060;
  - [`PROD_PREFLIGHT_SPEC.md`](PROD_PREFLIGHT_SPEC.md), [`WORKER_DEPLOY_RUNBOOK.md`](WORKER_DEPLOY_RUNBOOK.md), [`PILOT_RUNBOOK.md`](PILOT_RUNBOOK.md) and [`SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md`](SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md).
- **Configuration and secrets** are named here, never valued. Values stay in the hosts' secret stores.

## Recorded production state

From CURRENT_STATUS §25, not observed since:
- **Ledger:** 85 rows, tail `20261109120000` (S1). 0001–0080, the 0081 alias `20260924023646`, 0083, Q2′-1, Q2′-2 and S1 are applied.
- **Not applied:**
  - the four pilot migrations: step 1, questions, report and actions;
  - `20261109170000`, the pilot links and claim scope (D-060, step 5a);
  - P1, P2, E1 and Q4.
- **Held, with no files:** 0082, 0084 and 0085.
- **The account area is off:** `ZYPACT_ACCOUNTS_ENABLED` is unset.

## Check read-only first

These are unknown or contradicted in the records. Each is checked read-only before the step that depends on it:

1. **0083's apply has no record of its own.** It is only implied by the Q2′-1 pre-check, "0083 recorded, 82 ledger rows". The preflight's P2.6 and P3.1 confirm it.
2. **The worker has never been redeployed.** WORKER_DEPLOY_RUNBOOK §10 is empty, so its image, slots and paid gate are unknown, and whether a deploy starts the machine is still open (§3). Step 6 records both.
3. **The deployed values of every name in steps 8 and 9 are unknown.**
4. **The queue state is unknown.** The self-test retest job may already be queued. The preflight's P6.3 shows it.
5. **The self-test record still says "window OPEN".** The window closed on 2026-10-09, and public pages changed after 2026-09-30, including #65, a homepage link to the intervention page. When those changes reached production is unknown. Settle this before step 10.
6. **After step 11 the queue is never empty,** because pilot jobs are queued when questions are added. A later worker redeploy (Part C) then conflicts with the runbook's empty-queue rule. Record in step 6 how a D-052 worker behaves at deploy, so that the rule can be revised by decision rather than ignored.
   - **2026-11-17 (D-060 item 5, *(engineer)*, proposed for founder confirmation): a revision.** Once `20261109170000` is applied (step 5a), the unscoped claims are revoked and the live worker takes only the job a Run named, so a queued job without a pending run request is inert. The proposal: from then on the rule before a worker redeploy or a worker-secret change is **no job holds a live lease and no run request is pending** (WORKER_DEPLOY_RUNBOOK §3 and §6), and queued jobs may stay queued. **Until the founder confirms it, the empty-queue rule stays in force.** Step 6 meets it anyway: nothing is queued between step 1 and step 7. The question matters from step 11 onwards, for example at Part C's worker redeploy. The preflight's P6.3 (no queued job) is unchanged, because step 1 runs before the migration, while the deployed old worker still uses the global claim.

## Part A — the Perplexity pilot

Order rule (D-052): migrations, then the worker, then the web app. Rollback runs in the reverse order.

### Step 0 — repository, no production change

- **Does:**
  - merges the pull requests the release needs. #121 (ChatGPT phase A, switch off, Perplexity path unchanged) and #128 (suggested actions) were merged on 2026-11-17, and #129 (the D-058 release prep: renumbered migrations, re-baselined preflight, this plan) the same day, as `main` `d03363f`. A pull request merged after that, such as D-060's, moves R (the R rule below);
  - names the resulting `main` commit **R**. The worker and the web app are both built from R.
- **Approval (the user, per CLAUDE.md):** "Merge the release pull requests."
- **Check:** CI passes on R, including Level 2; `npm run test:prod-preflight` passes.
- **The R rule (2026-11-17, D-060):**
  - every migration on R numbered below `20261110120000` that is not yet applied is applied to production in numeric order, each at its own step (steps 2–5, step 5a, and any later migration in the pilot window), before the worker and the web app built from R are deployed. Code must never run ahead of its schema (D-052's order). P1 to Q4 (`20261110120000`–`20261113120000`) are on R too and stay unapplied behind D-045's gates (Part B);
  - if R moves after step 1 (a pull request merged after the preflight ran, such as D-060's), the preflight file at the new R differs (its P2.4 lists `20261109170000`), so run the read-only preflight again from the new R before step 2. Step 1's authorisation of 2026-11-17 was given for the preflight at R; whether it covers this re-run is not recorded, so confirm with the founder before running it.

### Step 1 — read-only preflight

- **Approval:** "Run the read-only production check. It changes nothing." **Authorised by the founder on 2026-11-17** ("I agree.", relayed), together with the release order (D-058). It runs at R, after this plan's pull request is merged.
- **Does:** runs `scripts/sql/prod-preflight.sql` at R ([`PROD_PREFLIGHT_SPEC.md`](PROD_PREFLIGHT_SPEC.md)). The exact command, from a checkout of R:

  ```
  psql -X -q -v ON_ERROR_STOP=1 -v expected_sysid=<from your private record> \
       "<production connection string>" -f scripts/sql/prod-preflight.sql
  echo "exit $?"
  ```

  `expected_sysid` is the cluster system identifier recorded privately on 2026-11-09. Read it from your own record. It is never written into the repository, a pull request or a chat.
- **Pass:** the last line is `PREFLIGHT: PASS` and the exit code is 0. **Anything else means stop:** `PREFLIGHT: FAIL (n)`, a non-zero exit, or an error.
- **If P3.3 fails:** its pin `710dfb5c…` was computed on disposable databases and has never been observed on production. Stop. Compare the observed hash against a disposable copy built to the recorded state before anything else. A mismatch means production's `approve_and_launch_snapshot_baseline` is not what step 2 expects to replace.
- **Output:** check ids, PASS/FAIL, versions, hashes and counts, and the system identifier itself. Keep the full output private; the record notes only the result and the date.
- **Rollback:** none.

### Steps 2–5 — the four pilot migrations, one approval each

| Step | Version | `expected_prev` |
|---|---|---|
| 2. Pilot step 1 | `20261109130000_pilot_step1_operator_controls` | `20261109120000` |
| 3. Pilot questions | `20261109140000_pilot_questions` | `20261109130000` |
| 4. Pilot report | `20261109150000_pilot_report_artifacts` | `20261109140000` |
| 5. Pilot actions | `20261109160000_pilot_actions` | `20261109150000` |

- **Approval:** "Apply pilot migration N (version V) to production."
- **Does:** applies the migration with the D-041 named-file procedure under `--single-transaction`, never `db push`. Each is rehearsed first on a disposable copy of the live state, as §25 records for Q2′-1, Q2′-2 and S1.
  - **The procedure** is the body of `scripts/sql/sv1-apply-named-migration.sql` below its header, sha256 `db6feffff039c324bef2a8894deb3e2c3236f5c0e8bbca7cd4ecc204b8972cca` since 2026-11-17. Q2′-1, Q2′-2 and S1 used the earlier body, `8a430331…`, which had no order guard.
  - **Every apply passes** `-v target_sysid=<from your private record>` as well as `file`, `new_version`, `new_name` and `expected_prev`. The guard refuses a different database, a version not later than `expected_prev`, and a tail other than `expected_prev`.
- **Before:**
  - the ledger tail equals `expected_prev`;
  - V is absent;
  - no job is claimed or running;
  - the worker is stopped.
- **After:**
  - V is the tail, and the row count is one higher (86, 87, 88, 89);
  - the new tables have RLS on, no policy and no API-role grant;
  - the new functions are executable by `service_role` only;
  - after step 2, the five-argument approval exists and the four-argument one is gone;
  - after steps 3 and 5, the redefined functions' md5 values match pins taken from the disposable rehearsal.
- **From step 2 until step 7,** make no founder-created approval and press no Run (D-052). The old console sends the four-argument approval.
- **Rollback:** a separately authorised forward migration using each file's header recovery notes, in reverse order (step 5a's links and claim scope first, if it has been applied; then actions, report, questions, step 1), with the web app rolled back first.

### Step 5a — older report links stop working; unscoped claims revoked (D-059 item 9, D-060)

| Step | Version | `expected_prev` |
|---|---|---|
| 5a. Pilot links and claim scope | `20261109170000_pilot_links_and_claim_scope` | `20261109160000` |

- **Approval:** "Apply migration 20261109170000 (older pilot report links stop working; the unscoped protocol claims revoked) to production."
- **Does:** applies the migration exactly as steps 2–5 do (named file, `--single-transaction`, `-v target_sysid`), rehearsed first on a disposable copy at the state after step 5.
  - It redefines `read_shared_pilot_report`, which step 4 created, so no preflight pin applies to it.
  - It revokes `claim_protocol_execution_job` and `claim_protocol_execution_job_by_id` from `service_role`.
  - It writes no row. Its own pre- and postconditions refuse the whole apply if anything is not as expected, leaving nothing behind.
- **Before:** as steps 2–5: the tail is `20261109160000`, V is absent, no job is claimed or running, and the worker is stopped.
- **After:**
  - V is the tail, and the row count is 90;
  - `has_function_privilege('service_role', …, 'execute')` is false for `public.claim_protocol_execution_job(text, integer)` and `public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)`, and true for `public.claim_requested_protocol_execution_job(text, integer)` and `public.read_shared_pilot_report(text)`;
  - `md5(pg_get_functiondef('public.read_shared_pilot_report(text)'::regprocedure))` matches the pin taken from the disposable rehearsal. The rehearsal of 2026-11-17 (`supabase/postgres:17.6.1.167`, applied as `postgres` through the named-file procedure) gave `7b90ce86e2604076a86ad116356d4e19`, and `36dd5bc142ff156d15976687f141a2c7` just before the step. Neither has been observed on production;
  - **in the disposable rehearsal only** (production has no shared revision yet): with two revisions of a test pilot shared, the older token returns no payload and the "newer revision shared" flag, and the newer token returns its payload. `scripts/test-pilot-links-and-claims-db.ts` checks exactly this.
- **What changes for the worker:** from here, a worker image from before D-052 can no longer claim at all. D-060 item 5 *(engineer)* proposes that the rule before a worker redeploy or a worker-secret change becomes **no job holds a live lease and no run request is pending**; until the founder confirms it, the empty-queue rule stays in force ("Check read-only first", item 6).
- **Rollback** (each a separately authorised forward step):
  - older links: re-running `20261109150000` §5 restores the old read function only. Nothing was deleted, but that alone reopens no older link. With the web app from R (step 7) deployed, an older link still shows the replaced notice, by design. Promoting the web deployment from before step 7 (step 7's rollback) gives every pilot link a 404, the newest included, because that deployment has no pilot report page. Older links open again only with both the restored function and a separately authorised deploy of a web build from before D-060 that has the pilot page (for example one built from `main` at `d03363f`, which was never deployed);
  - the claims: `grant execute on function public.claim_protocol_execution_job(text, integer) to service_role;` and `grant execute on function public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) to service_role;`. A re-grant reopens the path by which a worker image from before D-052 could take any queued job, a pilot's included, without a Run.

### Step 6 — worker redeploy from R

- **Approval:** "Redeploy the production worker from R with an empty queue."
- **Does:** WORKER_DEPLOY_RUNBOOK §6. The D-036 bounds (7 slots, 900 s) take effect.
- **Before:**
  - the count of queued, claimed and running jobs is 0 (WORKER_DEPLOY_RUNBOOK §6 step 3, the first query). That is the expected state: P6.3 found no queued job at step 1, and nothing is queued or run from step 2 to step 7. The relaxed condition of D-060 item 5 *(engineer)*, no live lease and no pending run request with queued jobs left queued, applies only once the founder confirms it ("Check read-only first", item 6), and is not needed here;
  - `verify:worker-provenance R --worktree` passes;
  - the machine ID and its state are recorded.
- **After:**
  - same machine ID, state `stopped`;
  - the environment shows 7 slots and 900 s, and `WORKER_CHATGPT_ENABLED` is exactly `"false"` (runbook §6 check d);
  - the start event reports gitSha R, and the `--digest` comparison matches;
  - a row is appended to runbook §10.

  If the deploy did not start the machine, a separately approved start with no run request claims nothing (D-052) and shows the gitSha.
- **Rollback:**
  - stop the machine;
  - the image deployed before this step predates D-052. It uses the global claim, which step 5a revoked, so after step 5a it claims nothing at all: redeploying it is a safe stop, not a working worker. A working rollback is another image built at or after D-052, redeployed under the rule then in force (an empty queue; or, once the founder confirms D-060 item 5, no live lease and no pending run request), or step 5a's re-grant, separately authorised.

### Step 7 — web deploy from R

- **Approval:** "Deploy R to the web host."
- **After:**
  - `/admin/pilots` loads for the founder;
  - a wrong `/pilot-report/` token returns 404;
  - `/account` returns 404 (accounts are off).
- **Rollback:** promote the previous web deployment. This comes before any worker or migration rollback.

### Step 8 — web-host configuration (names only)

- **Set:**
  - `ZYPACT_PAID_EXECUTION_ENABLED`;
  - `ZYPACT_DAILY_SPEND_CEILING_USD`, at the founder's $10 (D-053 item 6);
  - `SNAPSHOT_APPROVAL_ENABLED`, which gates every pilot route;
  - `INTERVENTION_ADMIN_ENABLED`, for the self-test;
  - `FLY_WORKER_APP`, `FLY_WORKER_MACHINE_ID` and `FLY_API_TOKEN`: all three or none, with the token scoped to the worker app.
- **Confirm these are not `true`:**
  - `ZYPACT_LEGACY_PIPELINE_ENABLED`: with paid execution on, it would reopen the legacy pipeline;
  - `SNAPSHOT_AUTO_DELIVERY_ENABLED`: keep it off. Pilot reports never use it, but request reports would send without review.
- **Confirm unset:** `ZYPACT_ACCOUNTS_ENABLED`.
- **Approval:** "Turn on paid execution on the web host with a $10 daily ceiling."
- **Rollback:** unset the switch and redeploy.

### Step 9 — worker secrets (names only)

- **Set** as Fly secrets: `ZYPACT_PAID_EXECUTION_ENABLED` and `ZYPACT_DAILY_SPEND_CEILING_USD`. The toml `[env]` lines are contract-locked.
- **Confirm present, by name:**
  - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
  - `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `LLM_PROVIDER`;
  - `ZYPACT_MOCK_MODE`;
  - `WORKER_ID`, `WORKER_EXPECTED_SUPABASE_PROJECT_REF`, `WORKER_LIVE_CONFIRM`.
- **Confirm absent:** `OPENAI_PROBE_API_KEY`.
- **Do it with an empty queue** (WORKER_DEPLOY_RUNBOOK §6 step 3, the first query; nothing is queued before step 10). Once the founder confirms D-060 item 5 *(engineer)*, a later worker-secret change needs instead no live lease and no pending run request (the second query). Setting secrets is believed to update the machine (inferred). Re-check runbook §6 (c) afterwards.
- **Approval:** "Turn on paid execution on the worker with a $10 ceiling."
- **Rollback:** unset the secrets.

### Step 10 — self-test retest (first paid run, Zypact's own data)

- **Approval:** "Run the self-test retest (database cap $2)."
- **Does:** SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md §5 and §7. It tests the new worker on Zypact's own data. The confounder note is carried outside the card (§4, option 1).
- **Before:**
  - the eligibility panel allows it;
  - it is the only queued job;
  - "check read-only first" item 5 is settled.
- **After:**
  - the job `succeeded`;
  - the attempts reconcile;
  - spend is within the cap;
  - the Outcome Card is built and reviewed.
- **Rollback:** none. A retest that stops has no console retry.

### Step 11 — pilot setup (spends nothing)

- **Prerequisites** (PILOT_RUNBOOK §2.1, §6, §8.1):
  - signed terms stating the 60-point retest limit (D-053 item 5);
  - offer wording per D-053 item 8;
  - website control confirmed and recorded;
  - the customer's dated written approval of each question.
- **Does:** creates the pilot, then adds each question with its text, who supplied it, and the approval reference and date. Adding a question queues its job, capped at $2.
- **Approval:** "Create pilot P with its N approved questions."
- **Rollback:** close the pilot.

### Step 12 — first paid Run

- **Approval:** "Start paid Perplexity measurement for pilot P."
- **Does:** one question first, then the others one at a time.
- **After each:**
  - the job succeeded;
  - the attempts reconcile;
  - 24-hour spend is under the ceiling.

  A provider failure gets Retry; anything else gets Retire.
- **Rollback:** close the pilot. Close is refused while a run is active; wait for it.

### Step 13 — report and suggested actions

- **Does:**
  - writes and reviews the suggested actions (PILOT_RUNBOOK §8.3);
  - builds the report and reads it in the preview;
  - shares it, with an acknowledgement for a needs-review revision;
  - the founder sends the link.
- **Approval:** "Share revision N with the customer."
- **Note:**
  - The first report may be shared before any suggested action exists; actions are added in a later revision (D-059 item 8).
  - **When a newer revision is shared, the older link stops working** (D-059 item 9, D-060, from step 5a). The customer's older link then shows only a short notice with nothing of the report. Send the newest link each time.
  - Otherwise a shared revision cannot be withdrawn. Rolling back step 7 (promoting the web deployment before it) hides every pilot link, the newest included, because that deployment has no pilot report page.
  - The customer's change waits until the ChatGPT baselines are taken (D-053 item 3).

## Part B — release order (D-058, approved by the founder on 2026-11-17)

The four pilot migrations are renumbered to sit directly after S1 and before P1. They can then be applied in numeric order, as D-041 requires, while P1 to Q4 stay unapplied behind their own gates.

- **The numbering rule until P1 to Q4 are applied:** every production migration, including ChatGPT's phase B and any forward-recovery migration, is numbered strictly between `20261109160000` and `20261110120000`, or waits until P1 to Q4 are applied. A migration numbered after Q4 would leave P1 to Q4 below the tail, where they could never be applied in order.
  - **2026-11-17 (D-060):** `20261109170000` is the first migration in that window (step 5a). Later ones chain after it in numeric order, and P1's `expected_prev` is then the tail at the time P1 is applied, not `20261109160000` (D-058 item 2, dated note).
- **2026-11-17 correction (review of PR #129):** this part first said the named-file guard required numeric order. It did not: it checked only the tail, a new version and 14 digits, and a disposable database accepted an earlier version after a later one. The guard now refuses any version not strictly later than `expected_prev` (D-058 item 5).

- **Why not apply P1 to Q4 first:**
  - it adds four more production applies;
  - it locks E1's and Q4's still-unconfirmed engineer rules into production;
  - D-045's gates (a named security reviewer, the real-login test, SMTP and Auth settings) come before those applies, and none is met.
- **Why it is safe:**
  - The pilot migrations reference no account-stack object, and the account stack defines no function the pilot migrations define.
  - Both reference earlier tables only through foreign keys from their own new tables.
  - On 2026-11-17 the full schema dump was identical in the old and new orders.
- **Not allowed:** applying out of order, or renaming the account stack upward. D-041 makes numeric order the apply order.

## Part C — ChatGPT later

1. **Founder rulings** (D-056; **approved by D-059 items 1 to 6** on 2026-11-17; to be implemented by phase B, planned as D-061, not built):
   - call timeout 290 s;
   - lease 330 s, readiness window 240 s, runtime 2,400 s. These reopen D-029, D-030, D-034 and D-036, and need a new decision and a hosting-contract update.
   - caps 7 / 2 / $4;
   - daily ceiling $10, then $20;
   - a manual Retry after a flex refusal;
   - the `openai-responses-sources/1` rule.

   Also open: the conflict between a two-engine retest and 0079's one retest per intervention.
2. **Phase B pull request.**
   - **Numbering:** strictly between `20261109160000` and `20261110120000` while P1 to Q4 are unapplied (Part B).
   - **Migration:** the probe mode, a provider-aware persist, the baseline index by provider, the pilot engine CHECK, `add_pilot_question_engine`, the provider leg's call kind, and `searchResultsPresence`.
   - **Flips** `CHATGPT_WORKER_SCHEMA_READY`.
   - **Canon:** updates V1_SCOPE, METHODOLOGY §4 and PILOT_RUNBOOK, plus `CLAUDE.md`'s "Initial live surface" line, **which needs the user's OK**.
3. **Production steps, each approved separately:**
   - the migration, with the preflight re-baselined;
   - a worker redeploy with the new bounds and the switch still `"false"`. Pilot jobs are queued by then, so it needs the founder's confirmation of D-060 item 5 first, or an empty queue ("Check read-only first", item 6);
   - `OPENAI_PROBE_API_KEY` as a worker secret only;
   - the web deploy;
   - the switch set to `"true"` through a PR and a redeploy;
   - one supervised ChatGPT baseline. Check the pinned model, the flex tier, cost within the $0.56 reservation, the sources, and that it is recorded as ChatGPT.
   - the daily ceiling (D-059 item 4): `ZYPACT_DAILY_SPEND_CEILING_USD` stays at 10 USD on both the web host and the worker (steps 8 and 9) for the first supervised ChatGPT day; then it is raised to 20 USD on both hosts, as its own approved step ("Raise the daily ceiling to $20 on the web host and the worker"). Rollback: set it back to 10 USD on both.
   - **Rollback:** set the switch back to `"false"` and redeploy, or stop the machine.
