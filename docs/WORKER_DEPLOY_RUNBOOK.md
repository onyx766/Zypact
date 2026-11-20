# Worker deploy runbook — production protocol worker

- **Application:** `zypact-protocol-worker` (D-033), region `iad`
- **Config:** [`fly.worker.production.toml`](../fly.worker.production.toml)
- **Written:** 2026-10-02
- **Status:** procedure recorded; the open question in §3 is not resolved

## 1. Why this file exists

D-034's stop procedure says to "set the line back to `disabled` and redeploy".
D-036 says its slot fix "takes effect only when the production config is
redeployed". [`CURRENT_STATUS.md`](CURRENT_STATUS.md) §18.5 item 8 records that
it has not been.

Until this file, the repository contained no executable `fly` command anywhere —
three decisions depended on a redeploy that nothing described. This file supplies
the command sequence and, more importantly, the verification step that tells you
whether the deployed machine actually carries the bounds the committed file
declares. Nothing in the repository compared those two before now.

## 2. What a deploy of this config does and does not authorise

It does **not** grant new authorisation. `WORKER_EXECUTION_MODE = "live"` was
authorised by D-034 and is already committed; the bounds were set by D-036 and
are already committed. A deploy only makes the deployed machine match what `main`
already says. (2026-11-18: D-061 adds the lease, readiness and ChatGPT-timeout
values and raises the runtime ceiling, as the founder approved under D-059. The
ChatGPT switch stays `"false"`; turning it on is §6a, under its own authorisation.)

It does not, by itself, spend. Spending requires a *started* machine that finds a
claimable job. `WORKER_EXIT_AFTER_CLAIMED_JOB = "true"` with `[[restart]] policy =
"never"` keeps one start to one job (D-034, D-036).

Deploying is **safe during the self-test freeze**:
[`SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md`](SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md)
§6 names "worker configuration" in its safe-to-change list, because the worker is
not retrievable by the provider and cannot confound the artifact under
observation.

## 3. Open question — deploy-time machine state

**Unresolved. Do not treat the answer as known.**

Every safety statement in the config header and in D-033/D-034 says a machine is
*created* stopped. That is a claim about creation. Whether `fly deploy` against an
application whose machine already exists leaves that machine stopped, or starts it
to roll out the new image, is **not** established anywhere in this repository or
by any decision record. `[[restart]] policy = "never"` governs restarts after the
process exits; it is not a statement about deploy-time state.

**Mitigation, which makes the question moot rather than answering it: deploy only
while the job queue is empty.** A worker that starts against an empty queue claims
nothing, runs zero iterations and exits — precisely what the Phase 3C staging
evidence in §14 and §16 of `CURRENT_STATUS.md` demonstrates. Under those
conditions an unexpected deploy-time start costs nothing and proves nothing was
at risk.

Two consequences:

- **Never deploy between "Queue retest run" and "Run retest now"** (self-test §7
  steps 4 and 5) until `20261109170000` is applied and the founder has
  confirmed D-060 item 5 (below). In that interval a job sits `queued` and a
  deploy-time start of a worker on the global claim could claim it, outside
  the founder's intent and outside the console.
- Until D-052 is deployed (migration `20261109130000`, numbered `20261114120000` until 2026-11-17 (D-058), and a worker image
  built from it), the claim is unscoped (`CURRENT_STATUS.md` §18.5 item 2).
  Deploy D-052's worker after its migration and before its web app: the
  new worker, started by the old console, finds no run request and stops.
  Roll back in the reverse order: the web app first, then the worker.
  After it, a worker claims only the job a Run named and stops at once when
  no Run is pending, so a deploy-time start claims nothing; keep the empty
  queue rule anyway until a deploy has been observed under D-052.
- Before D-052:
  `claim_protocol_execution_job` takes the oldest eligible job *globally*. An
  empty queue is therefore the check, not "no job for this intervention".
- **Once migration `20261109170000` is applied (D-060)**, the two unscoped
  claims (`claim_protocol_execution_job` and
  `claim_protocol_execution_job_by_id`) are revoked from `service_role`. A
  D-052 worker claims only the job a pending run request names, and a worker
  image from before D-052 cannot claim at all (permission denied). A queued
  job without a pending run request is then inert.
  **D-060 item 5 *(engineer)*, proposed for founder confirmation:** the
  empty-queue rule then becomes
  **no job holds a live lease and no run request is pending**
  (§6 step 3, second query), because the database itself refuses every claim
  without a Run. Once the founder confirms it, this
  replaces "keep the empty queue rule anyway" above. **Until then, keep the
  empty-queue rule** for every worker redeploy and worker-secret change.
  Until the migration is applied, the empty-queue rule holds in any case: the
  deployed worker predates D-052 and uses the global claim, which is also why
  the preflight keeps its P6.3 check (no queued job).

If a future deploy is observed leaving the machine stopped or starting it, record
that observation here and promote it from an open question to a stated fact.

## 4. Timing

Deploy **days before** the retest, not on the day of it. If the machine is
destroyed and recreated, `FLY_WORKER_MACHINE_ID` must be updated on the Next.js
host and that deployment redeployed too (§7). Discovering that on the day the
observation window closes (2026-10-09) leaves no slack.

## 5. Prerequisites

```bash
git checkout main && git pull --ff-only
npm run test:m0-worker-hosting-contract
```

The contract must pass. Note what it proves: it is a **static check of the
committed files** against the inert template. It passed on `main` at `4440ddc`
with 141/141, static half only (170/170, static half only, on the ChatGPT phase B
branch on 2026-11-18). It says nothing about any deployed machine — that
is the gap §6 step 5 closes.

Secrets are expected to be set already. The Supabase URL and project ref, the
service-role key, the Perplexity key and the analysis-provider key live in `fly
secrets` and are absent from the config by design. Do not add them to the toml:
the fourteen `[env]` values are contract-locked, and the hosting contract fails on
a fifteenth.

One more worker secret exists and is **not** expected yet: `OPENAI_PROBE_API_KEY`,
the ChatGPT measurement project's key (D-050), never the analysis key. It is set
with `fly secrets` on the worker only, at the step that turns
`WORKER_CHATGPT_ENABLED` on, and not before. It never goes in the toml or on the
web host. With the switch off the worker neither needs it nor reads it.

> **2026-11-17:** D-056's phase A (PR #121, merged) added the eleventh `[env]`
> value, `WORKER_CHATGPT_ENABLED = "false"`, and the hosting contract locks it.
> Check (d) in §6 confirms it on the machine. The production sequence is in
> [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md), step 6.

> **2026-11-17, D-061 (ChatGPT phase B):** the values the founder approved under
> D-059 make it fourteen. `WORKER_MAX_RUNTIME_SECONDS` goes from `"900"` to
> `"2400"`, and three values are added: `WORKER_LEASE_SECONDS = "330"`,
> `WORKER_READY_STALE_MS = "240000"` and `WORKER_CHATGPT_TIMEOUT_MS = "290000"`.
> They size the worker for a 290 s ChatGPT call while the switch stays `"false"`:
> 7 slots × (290 s + 45 s) + 10 s = 2,355 s < 2,400 s; 290 s + 10 s < 330 s; and
> 240 s > the 110 s heartbeat (lease / 3). The lease and readiness values change
> Perplexity jobs as soon as they are deployed. A crashed job keeps its lease, and
> its Run stays blocked, for up to 330 s (the code default is 60 s). `/readyz`
> reports a wedged worker after 4 minutes (the code default is 1). No earlier Fly
> file set either value, so what the running machine uses today is not recorded.
> Check (c) in §6 confirms all of them on the machine.

## 6. The sequence

```bash
# 1. Confirm the account and the application you are pointed at
flyctl auth whoami
flyctl status -a zypact-protocol-worker

# 2. RECORD the current machine ID and state. You compare against this in step 5.
flyctl machine list -a zypact-protocol-worker
```

**3. Confirm the queue is empty** (§3). Either from the admin console, or:

```sql
select count(*) from protocol_execution_jobs
 where status in ('queued', 'claimed', 'running');   -- must be 0
```

Those three are the live statuses in migration `0050`. If the count is not zero,
stop: resolve the job first. Do not deploy past a non-empty queue.

**Once `20261109170000` is applied and the founder has confirmed D-060 item 5
*(engineer)* (§3),** a queued job without a run request cannot be claimed, so
the check may instead be this one: no job holds a live lease and no run
request is pending. Until the founder confirms it, keep using the empty-queue
query above.

```sql
select (select count(*) from protocol_execution_jobs
         where status in ('claimed', 'running')
           and lease_expires_at > now()) as live_leases,        -- must be 0
       (select count(*) from protocol_job_run_requests
         where status = 'pending'
           and expires_at > now()) as pending_run_requests;     -- must be 0
```

A request past its expiry time is never claimed: the claim closes it as
expired and claims nothing (D-052). Under this check, once it applies, queued
jobs may stay queued. If either count is not zero, wait for the run to finish
or the request to expire, and check again.

```bash
# 4a. Provenance (PR-2). The build context must be exactly the commit you deploy:
#     this exits 1 on any edit or untracked file under the image source.
npm run verify:worker-provenance -- "$(git rev-parse HEAD)" --worktree

# 4b. Deploy, naming that commit. The image build refuses a missing or
#     malformed GIT_SHA, so a deploy without this argument fails to build.
flyctl deploy -c fly.worker.production.toml -a zypact-protocol-worker \
  --build-arg GIT_SHA="$(git rev-parse HEAD)"

# 5. Verify. This step is the point of the runbook.
flyctl machine list -a zypact-protocol-worker
flyctl machine status <MACHINE_ID> -a zypact-protocol-worker --json
```

Four things to check in step 5, in order:

| # | Check | If it fails |
|---|-------|-------------|
| a | Machine ID is unchanged from step 2 | Go to §7 |
| b | State is `stopped` | `flyctl machine stop <ID> -a zypact-protocol-worker`, then record the observation in §3 |
| c | In the machine's env: `WORKER_MAX_SLOTS_PER_CLAIM` is `7`, `WORKER_MAX_RUNTIME_SECONDS` is `2400`, `WORKER_LEASE_SECONDS` is `330`, `WORKER_READY_STALE_MS` is `240000` and `WORKER_CHATGPT_TIMEOUT_MS` is `290000` (D-036, D-061) | The deploy did not land. Do not start the machine. `1` slot cannot complete a 5-run plan (D-036), and a machine without the D-061 values must not have its ChatGPT switch turned on |
| d | `WORKER_CHATGPT_ENABLED` is exactly `false` in the machine's env (D-056), until the separate step that turns it on through its own pull request and deploy (D-061, §6a) | Stop. Do not start the machine; redeploy from the release commit. With anything but `"true"` the engine is off, but a value other than `false` means the config is not the committed one |

Check (c) is the only direct evidence that D-036 and D-061 took effect. Record the
values you observed, not the values you expected.

**2026-11-18 *(engineer)*:** `flyctl machine status --json` lists the `[env]`
values, not secrets. Confirm with `flyctl secrets list -a zypact-protocol-worker`,
which prints names only, that none of the names in checks (c) and (d) is also
set as a secret. A same-named secret could put a different value in force than
the one check (c) reads.

**Provenance (PR-2).** Record the commit passed in step 4b and the digest
`npm run verify:worker-provenance -- <sha>` prints for it. The image reports
both (`gitSha`, `sourceDigest`, `provenance: "recorded"`) in its start event
(`worker_execution_disabled` / `worker_started`) and on its private `/healthz`,
so the first separately authorised start can be checked with
`npm run verify:worker-provenance -- <gitSha> --digest <sourceDigest>`. Anything
other than `provenance: "recorded"` and a match means the running image is not
the commit on record: stop it.

`recorded` proves only that the image's own two records (the
`ZYPACT_BUILD_GIT_SHA` environment value and `build-provenance.json`) are well
formed and agree. It does not prove the digest belongs to the claimed commit:
the `--digest` comparison above, which recomputes the digest from git, is
independent and **mandatory before production activation**. A live worker
refuses to start (`worker_provenance_refused`, exit 78) unless provenance is
`recorded`, so live execution is only possible from an image built with
`GIT_SHA`; it cannot run from a plain checkout.

## 6a. Turning ChatGPT on (D-061)

This runbook does not authorise it. Each step below is its own production step
([`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md) Part C). They come after
a §6 deploy has shipped D-061's values with the switch `"false"`.

**Before the switch-on deploy:**

- migration `20261109180000` (ChatGPT measurement) is applied. Without it the
  worker refuses to start with the switch on (below);
- check (c) of the last §6 deploy recorded D-061's values;
- `OPENAI_PROBE_API_KEY` is set as a worker secret (§5), and is not on the web
  host;
- `WORKER_CHATGPT_ENABLED = "true"` is in the Fly file through its own merged
  pull request, and the deploy names that commit;
- the queue rule of §3 holds. Until the founder confirms D-060 item 5, that is
  an empty queue; once confirmed, no live lease and no pending run request (§6
  step 3). Pilot jobs are queued by then, and a queued job stays queued until
  it is run, so an empty queue means running or closing every queued job first.

**Deploy** as §6 steps 1 to 5. Check (d) then expects `true`, not `false`;
everything else in step 5 is unchanged.

**What the worker refuses at startup with the switch on.** Each refusal comes
before any claim, reservation or provider call. It logs one closed line and
exits 78 (`EX_CONFIG`), like every other startup refusal.

| Event | When |
|---|---|
| `worker_configuration_rejected` | `OPENAI_PROBE_API_KEY` or `WORKER_CHATGPT_TIMEOUT_MS` is missing; the ChatGPT timeout plus the grace is not below the lease; one slot, or the whole claim (slots × (max(provider timeout, ChatGPT timeout) + provider timeout) + grace), is not below the runtime; or the readiness window is not above lease / 3. The committed values pass: 2,355 s < 2,400 s, 300 s < 330 s, 240 s > 110 s. The line names variables, never values |
| `worker_chatgpt_schema_refused` | The connected database cannot record a ChatGPT attempt. `reason` is `capabilities_unreadable` when `protocol_worker_capabilities()` is missing or its read failed (a database without `20261109180000`), or `capability_missing` when its reply does not list `live_openai_chatgpt`. Nothing is claimed. Apply the migration, or set the switch back to `"false"` |
| `worker_provenance_refused` | As for every live start (§6, provenance) |

So a deploy-time start (§3) either refuses at once or, with no run request
pending, claims nothing (D-052).

**Then the web host's gate.** Set `ZYPACT_PILOT_CHATGPT_ENABLED` to `true` only
after check (d) shows `true` on the machine. It goes on the web host and never
on the worker, and the web app is then redeployed, as for the other web-host
values (PILOT_PRODUCTION_PLAN step 8).

Until it is on, the pilot console shows ChatGPT as "Not connected", and Add,
Run and Retry on ChatGPT refuse (409) before anything is read, reserved or
started. Resolving a held measurement and retiring a question stay available
either way, but Retire refuses a question whose ChatGPT measurement has a run that has not finished; and while no measurement of the question has stopped for good, it is refused anyway (one that could be retried says ChatGPT must be turned back on first) (see *Turning ChatGPT off*).

**Turning ChatGPT off, in this order** (the same steps as migration
`20261109180000`'s header):

1. Run the read-only query below; each count should be 0. A run in flight
   finishes on its own. Finish an unfinished ChatGPT run first, with Run: a
   Retry approved but not yet run, or a run whose worker stopped part-way. With
   ChatGPT off it can be neither run nor retired, and it holds the pilot's
   report build. A run held for review can be resolved at any time, ChatGPT on
   or off.
2. Unset `ZYPACT_PILOT_CHATGPT_ENABLED` on the web host and redeploy the web
   app. No ChatGPT Run, Retry or add can be pressed after that.
3. Run the query again until `chatgpt_runs_pending` and
   `chatgpt_runs_in_flight` are both 0. A Run pressed just before step 2 is
   claimed and finishes under the worker that is still on.
4. Only then set the switch back to `"false"` through a pull request and
   redeploy the worker under §6, with check (d) `false`. To stop at once, stop
   the machine (§8); a ChatGPT run it was making is then left unfinished until
   ChatGPT is on again.

```sql
select
  (select count(*)
     from public.protocol_job_run_requests r
     join public.protocol_execution_jobs j on j.id = r.job_id
     join public.protocols p on p.id = j.protocol_id
    where p.provider = 'openai_chatgpt'
      and r.status = 'pending' and r.expires_at > now()) as chatgpt_runs_pending,
  (select count(*)
     from public.protocol_execution_jobs j
     join public.protocols p on p.id = j.protocol_id
    where p.provider = 'openai_chatgpt'
      and j.status in ('claimed', 'running')
      and j.lease_expires_at > now()) as chatgpt_runs_in_flight,
  (select count(*)
     from public.protocol_execution_jobs j
     join public.protocols p on p.id = j.protocol_id
    where p.provider = 'openai_chatgpt'
      and j.status <> 'needs_review'
      and not coalesce(j.status in ('claimed', 'running') and j.lease_expires_at > now(), false)
      and (j.status in ('claimed', 'running')
           or exists (select 1 from public.protocol_attempts a
                       where a.protocol_id = p.id
                         and a.status in ('reserved', 'in_progress')))) as chatgpt_runs_unfinished;
```

The gate goes off first *(engineer)*. A Run that reaches a worker whose switch
is off closes a ChatGPT job that has no attempt yet as failed
(`PROVIDER_ADAPTER_NOT_ENABLED`, in `lib/protocol-worker/worker.ts`), and Retry
does not take that failure, so that measurement is lost for good. With the
switch off, the worker refuses a ChatGPT protocol before admission, so nothing
is reserved or sent.

With ChatGPT off, a ChatGPT measurement that stopped for good (abandoned, or
failed in a way Retry does not take) is retired with its question, and one held
for review can still be resolved. One that is only waiting for Run, or that
failed at the provider and could still be retried, can be neither run nor
retried until ChatGPT is on again, and does not by itself let its question be retired: Retire then refuses it (for one that could be retried or has an unfinished run, it says ChatGPT must be turned back on first). Once another measurement of the question has stopped for good, the question can be retired, and a ChatGPT measurement still queued then stays queued.

Migration `20261109180000` stays applied. Once a ChatGPT row exists, its
recovery is forward only (its header, D-061).

## 7. If the machine ID changed

`FLY_WORKER_MACHINE_ID` is deployment state, not configuration (D-035). It lives
on the **Next.js host**, not on the worker. If the ID changed:

1. Update `FLY_WORKER_MACHINE_ID` on the web deployment to the new ID.
2. Redeploy the web application so the route reads the new value.
3. Confirm the admin console's start control responds rather than reporting that
   Fly has no such machine.

`FLY_WORKER_APP`, `FLY_WORKER_MACHINE_ID` and `FLY_API_TOKEN` are all-or-nothing:
with any one unset the start routes answer 503 and contact nothing. The token must
stay scoped to this application alone.

## 8. Stop procedure (D-034)

Either is sufficient, and neither requires more than it says:

- `flyctl machine stop <ID> -a zypact-protocol-worker` — a stopped machine cannot
  claim.
- Set `WORKER_EXECUTION_MODE = "disabled"` in the config and redeploy — the
  durable stop, since it survives a later start.

## 9. What this runbook does not cover

- Creating the application or the first machine. Both are operator acts that no
  decision record authorises implicitly (D-033, D-034).
- Setting or rotating secrets.
- Starting the worker to run a job. That is the founder console (self-test §7),
  and it is the step that spends.
- Worker health monitoring, alerting and operator recovery, which remain open
  (`CURRENT_STATUS.md` §9 item 11).

## 10. Record of deploys

Append one row per production deploy. An unrecorded deploy leaves the next reader
unable to tell what the running machine carries.

| Date | Commit | Machine ID before → after | State after | Values observed, checks (c) and (d) | Notes |
|------|--------|---------------------------|-------------|--------------------------|-------|
| 2026-11-18 | `e2acca3` (Fly release v7) | same machine (ID kept off the repository) | `stopped` | (c) 7 slots, 2,400 s, 330 s, 240,000 ms, 290,000 ms; (d) `WORKER_CHATGPT_ENABLED` `false`, no same-named secret | PILOT_PRODUCTION_PLAN step 6 (CURRENT_STATUS §40). Release v8: paid-execution and 10 USD ceiling secrets (step 9) |
| 2026-11-18 | `2aa3e68` (Fly release v10) | same machine | `stopped` | (c) unchanged; (d) `WORKER_CHATGPT_ENABLED` `true`, no same-named secret | Part C step C2 (§40a). Release v9 before it: the measurement key secret (C1). First start's `--digest` comparison matched `2aa3e68`. Release v11 after it: the ceiling secret set to 20 (C4) |
